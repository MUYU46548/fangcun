#!/usr/bin/env node
/**
 * composable 导出契约守卫（2026-11-12 · “备份功能坏了”的真因）
 *
 * 真事：`useBackup.ts` 里 `backupInfo` 定义了、自己也用了，但**没放进 `return {}`**。
 * `App.vue` 解构 `const { backupInfo, … } = useBackup(...)` 拿到 `undefined`，
 * 于是 `backupInfo.value = …` 抛 `Cannot set properties of undefined (setting 'value')`。
 *
 * **为什么编译器抓不到**：`tsconfig` 是 `strict: false`，解构不存在的属性能过；
 * 而且 `backupInfo` 在模板里没人用（只在 setup 内部赋值），`check-template-bindings` 也看不见。
 * 用户看到的只是“备份失败”——**而备份其实成功了**（zip 已落盘 21.7MB），只有回执那一步崩。
 *
 * 判据（两侧对账，缺一不可）：
 *   ① `App.vue` / `views/` / `components/` 里 `const { a, b, c } = useXxx(...)` 的每个名字，
 *      都必须在对应 composable 的 `return { … }` 里出现 —— 否则解构出来就是 undefined；
 *   ② 反过来：composable `return` 里的名字必须在某处被解构使用吗？**不**（他可能是故意给未来用），
 *      所以不做这条反向断言 —— 那会误伤。
 *
 * 运行：node scripts/test/check-composable-exports.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const R = path.join(REPO, 'desktop', 'src', 'renderer')
const COMPOSABLES = path.join(R, 'composables')

let pass = 0
let fail = 0
const failures = []
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

/** 读某个 composable 文件 `return {…}` 里的键名 */
function returnedKeys(file) {
  const src = fs.readFileSync(file, 'utf-8')
  const keys = new Set()
  // ⚠ 2026-11-12 两轮实测修正（这两次都是**假红**，比漏报更容易教人忽略守卫）：
  //   ① `return` 里常**一行写多个键**（`a, b, c,`）→ 按顶层逗号切；
  //   ② `return` 也常写成**一行**：`return { a, b, c }` —— 旧正则要求 `}` 在行首，
  //      于是单行 return 的整个块都没被读到（useDailyBand / useWasteLedger / useLogImport 全中）。
  //   现在按**括号配平**取块，不假设换行。
  const re = /return\s*\{/g
  let m
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length
    let depth = 1
    let end = -1
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end < 0) continue
    const body = src.slice(m.index + m[0].length, end)
    for (const raw of body.split('\n')) {
      const line = raw.replace(/\/\/.*$/, '').trim()
      if (!line) continue
      for (const part of line.split(',')) {
        const t = part.trim().replace(/,$/, '')
        if (!t) continue
        if (/^[A-Za-z_$][\w$]*$/.test(t)) { keys.add(t); continue }      // `foo`
        const kv = /^([A-Za-z_$][\w$]*)\s*:/.exec(t)
        if (kv) keys.add(kv[1])                                          // `foo: bar`
        // `...rest` 跳过（展开进来的名字静态看不到）
      }
    }
  }
  return keys
}

/** 找某个文件里 `= useXxx(...)` 的解构名单 */
function destructured(src) {
  const out = []
  const re = /const\s*\{([^}]+)\}\s*=\s*(use[A-Za-z0-9_]+)\s*\(/g
  let m
  while ((m = re.exec(src))) {
    const names = m[1].split(',').map((s) => s.trim().split(':').pop().trim()).filter(Boolean)
    out.push({ composable: m[2], names })
  }
  return out
}

function walk(dir, out = []) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(vue|ts)$/.test(e.name)) out.push(p)
  }
  return out
}

console.log('== composable 导出契约 ==')

// 每个 composable 的可用键
const exportsOf = new Map()
for (const f of fs.readdirSync(COMPOSABLES).filter((x) => x.endsWith('.ts'))) {
  const id = path.basename(f, '.ts')
  exportsOf.set(id, returnedKeys(path.join(COMPOSABLES, f)))
}
check('★ 扫到了 composable 与它们的 return 块（空集上 every 恒真 = 守卫形同虚设）',
  exportsOf.size > 10 && [...exportsOf.values()].filter((s) => s.size > 0).length > 10,
  `${exportsOf.size} 个 composable，其中有 return 块的 ${[...exportsOf.values()].filter((s) => s.size > 0).length} 个`
  + `（没有 return 的是纯函数模块，如 useBoardColumns —— 允许，它不被解构）`)

// 扫所有使用点
const users = [...walk(R, [])]
const missing = []
let pairs = 0
for (const f of users) {
  const src = fs.readFileSync(f, 'utf-8')
  for (const { composable, names } of destructured(src)) {
    const keys = exportsOf.get(composable)
    if (!keys) continue          // 不是本仓 composables 目录里的（算了）
    pairs++
    for (const n of names) {
      if (!keys.has(n)) {
        missing.push(`${path.relative(R, f).replace(/\\/g, '/')} 从 ${composable}() 解构了 ${n}，但它没被导出`)
      }
    }
  }
}
check('★ 扫到了真实的使用点（0 处 = 守卫没接线）', pairs > 5, `${pairs} 处解构`)
check('★★ 每个被解构的名字都真的被 composable 导出了（否则拿到 undefined，赋值即崩）',
  missing.length === 0, missing.slice(0, 6).join(' | '))

// 反例自证：故意造一个不存在的名字，必须被抓到
{
  const demo = 'const { definitelyNotExported } = useBackup({})'
  const found = destructured(demo)
  check('★ 反例自证：构造一个不存在的解构名，解析器能读出它（否则守卫是瞎的）',
    found.length === 1 && found[0].names[0] === 'definitelyNotExported',
    JSON.stringify(found))
  check('★ 反例自证：useBackup 的导出里确实没有这个名字',
    !exportsOf.get('useBackup').has('definitelyNotExported'))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log(' - ' + f)) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
