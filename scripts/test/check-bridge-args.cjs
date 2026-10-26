/**
 * 过桥参数守卫：**传进 window.tegula.* 的对象绝不能是 Vue 响应式代理**（2026-10-26）
 *
 * 背景：`An object could not be cloned` 这个坑本项目踩了 **4 次**
 * （偏好落盘 / 梯度榜 tiers / IPC 载荷 / 模型单价 priceRows），
 * 每次症状都一样 —— 界面只显示一句"保存失败"，看不出真因，排查要重跑一轮。
 *
 * 已有的防护为什么没挡住第 4 次：
 *  · `e2e-bridge-clone.cjs` 是真 Electron 跑的，**本机起不来 Electron 时行为部分直接 SKIP**
 *    （只剩静态断言），也就不可能发现"新通道传了 ref.value"；
 *  · 假 preload 的 `cloneGuard` 确实会抓 —— 但它只在**跑渲染层断言**时才响，
 *    而且要求新通道**已经在假 preload 里登记过**。写代码的人不看那一步就过去了。
 *
 * 所以这里补一条**静态**守卫，判据只认最可靠的那一类：
 *   凡在渲染层声明成"装对象/数组的 ref"（`ref<...{}...>`、`ref<...[]...>`、`ref([])`、`ref({})`），
 *   若它出现在 `tegula.xxx(...)` 的实参里，而这段实参**没有**包 `toPlain(`，就报错。
 * 原始类型（string / number / boolean）的 ref 传 `.value` 是安全的，不算。
 *
 * ⚠ 误报边界：如果某个对象 ref 的 `.value` 只是被拆成标量再传（`{ id: x.value.id }`），
 *   这里仍会报 —— 那种写法本来就该显式取字段，报出来让人确认一次是划算的。
 */
const path = require('path')
const { perFile } = require('./_sources.cjs')

/** ref 里装的是对象/数组（从声明处看） */
function isObjectRefDecl(line) {
  // const foo = ref<{ ... }>(...) / ref<Array<...>>(...) / ref<Foo[]>(...) / ref([]) / ref({}) / ref<Record<...>>
  const m = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*ref\s*(?:<([^>]*(?:<[^>]*>)?[^>]*)>)?\s*\(\s*(.*)$/.exec(line)
  if (!m) return null
  const name = m[1]
  const generic = m[2] || ''
  const init = m[3] || ''
  if (/[{[][\s\S]|Array<|Record<|Map<|Set<|\[\]|\{\}/.test(generic)) return name
  if (/^\s*(\[|\{)/.test(init)) return name
  return null
}

/**
 * 取出每个 `tegula.xxx(...)` 的**精确实参文本**（跨行、按括号配平）。
 * ⚠ 第一版只截"到行尾"，于是把 `x.value = await tegula.f()` 的**左值**也当成了实参，
 *   一跑就冒出 5 条误报（`reviewModal.value.id` 这种取标量的写法也报）。
 *   误报比漏报更糟：它教人忽略这个守卫。
 */
function callsIn(src) {
  const out = []
  const re = /tegula\.[A-Za-z_$][\w$]*\s*\(/g
  let m
  while ((m = re.exec(src)) !== null) {
    // 从 '(' 开始配平
    let i = m.index + m[0].length - 1
    let depth = 0
    let j = i
    for (; j < src.length; j++) {
      const ch = src[j]
      if (ch === '(') depth++
      else if (ch === ')') { depth--; if (depth === 0) { j++; break } }
    }
    out.push({ at: m.index, args: src.slice(i + 1, j - 1) })
  }
  return out
}

/** 行号（给报错定位用） */
function lineOf(src, at) {
  return src.slice(0, at).split('\n').length
}

/** 按顶层逗号切实参（认括号/方括号/花括号/字符串） */
function topLevelArgs(args) {
  const out = []
  let depth = 0
  let cur = ''
  let quote = ''
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]
    if (quote) {
      cur += ch
      if (ch === quote && args[i - 1] !== '\\') quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue }
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean)
}

/**
 * 判据刻意**收得很紧**，只抓最典型也最容易犯的那种：
 *   **整个实参就是 `某个对象 ref.value`**（`tegula.foo(priceRows.value)`）。
 * 不抓 `x.value.id`（取标量，安全）、不抓 `{ ...x.value }`（展开成新对象，安全）、
 * 不抓箭头函数体里的赋值（`cb((s) => { x.value = s })`）。
 * 为什么紧：第一版宽松规则一跑就 5 条误报 —— **误报会教人忽略这个守卫**，比漏报更糟。
 */
function run() {
  const problems = []
  const scanned = []
  for (const { file, text: src } of perFile()) {
    const objectRefs = new Set()
    for (const line of src.split('\n')) {
      const n = isObjectRefDecl(line)
      if (n) objectRefs.add(n)
    }
    if (!objectRefs.size) continue
    for (const c of callsIn(src)) {
      for (const a of topLevelArgs(c.args)) {
        const m = /^([A-Za-z_$][\w$]*)\s*\.\s*value$/.exec(a)
        if (!m) continue
        if (!objectRefs.has(m[1])) continue
        const where = `${file}:${lineOf(src, c.at)}`
        scanned.push(`${where} ${m[1]}.value`)
        problems.push({ where, ref: m[1], code: src.slice(c.at, c.at + 120).replace(/\s+/g, ' ') })
      }
    }
  }
  return { problems, scanned }
}

if (require.main === module) {
  const { problems, scanned } = run()
  console.log('== 过桥参数守卫（对象 ref 必须过 toPlain）==')
  console.log(`扫到 ${scanned.length} 处"对象 ref 进 IPC"的调用：`)
  scanned.forEach((s) => console.log('  · ' + s))
  if (problems.length) {
    console.log(`\n失败 ${problems.length} 处 —— 这些会把 Vue 代理直接交给 contextBridge，真机上表现为「保存失败」：`)
    problems.forEach((p) => console.log(`  ✗ ${p.where}  ${p.ref}.value 未过 toPlain\n      ${p.code}`))
    console.log('\n改法：把实参换成 toPlain(xxx.value)；`toPlain` 见 desktop/src/shared/plain.ts。')
    process.exit(1)
  }
  console.log('\n通过 —— 没有对象 ref 裸过桥。')
}

module.exports = { run, isObjectRefDecl }
