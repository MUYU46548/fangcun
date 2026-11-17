#!/usr/bin/env node
/**
 * 跨项目前端体检 · 守卫（2026-11-17）
 *
 * ## 为什么这个脚本需要守卫
 *
 * `fe-audit.cjs` 是**只读统计器**。这类脚本最典型的坏法不是崩溃，而是**静默给出错数字**：
 * 它在写出来的第一个小时里就犯了三次（都由人工复核抓到，不是它自己报的）：
 *
 *   ① 按"目录集合大小"数基座 → 方寸扁平摆法被数成 1 个、司天分目录摆法被数成 3 个
 *   ② Quartz 有 63 个 .tsx + package.json，却因为 `deps.react` 不在而被判成
 *      「Python 为主（1 个 .py，无前端构建）」—— **认不出就当没有，是最糟的那种错**
 *   ③ 引用基座的路径只认绝对写法，把司天的 `./ui/button` 漏掉 → "0 引用"
 *
 * 三次都不是"崩了"，而是"报告看起来完全正常，数字是错的"。所以本守卫钉的不是
 * "能不能跑"，而是**几条能被独立复算的事实**。
 *
 * ## 判据
 *
 *   ① 只读：跑之前/之后，所有被扫仓库的文件数与 mtime 快照必须一致
 *   ② 不编：--json 里每个项目的 `shape` 字段不许是"认不出"以外的空值；
 *      真认不出的必须带原因，不许静默给 '-'
 *   ③ 数字可复算：独立再数一遍"方寸裸 button"与"方寸基座组件数"，必须与报告一致
 *   ④ 阈值不藏：报告必须把 RULES 打印出来（掉队项不许变成"系统黑箱说你差"）
 *   ⑤ 无匹配要显式失败（不许零产出假装通过）
 *
 * 跑法：node scripts/test/check-fe-audit.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'fe-audit.cjs')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

const SKIP = /(^|[\\/])(node_modules|\.git|dist|build|vendor|Temp)([\\/]|$)/
function walk(d, out = []) {
  let items
  try { items = fs.readdirSync(d, { withFileTypes: true }) } catch { return out }
  for (const it of items) {
    const f = path.join(d, it.name)
    if (SKIP.test(f)) continue
    if (it.isDirectory()) walk(f, out)
    else out.push(f)
  }
  return out
}

/** 快照：文件数 + 每个文件 mtime（只读性判据用） */
function snapshot(dirs) {
  const map = {}
  for (const d of dirs) {
    if (!fs.existsSync(d)) { map[d] = 'MISSING'; continue }
    const files = walk(d)
    let sum = 0
    for (const f of files) { try { sum += fs.statSync(f).mtimeMs } catch { } }
    map[d] = files.length + ':' + Math.round(sum)
  }
  return map
}

function run(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
}

function main() {
  console.log('=== 一、脚本存在且能跑 ===')
  check('★★ scripts/fe-audit.cjs 存在', fs.existsSync(SCRIPT))
  if (!fs.existsSync(SCRIPT)) { report(); return }

  let out = ''
  let json = null
  try {
    out = run(['--json'])
    json = JSON.parse(out)
  } catch (e) {
    check('★★ --json 能跑出可解析的 JSON', false, String(e.message || e).slice(0, 200))
    report(); return
  }
  check('★★ --json 能跑出可解析的 JSON', !!json && Array.isArray(json.results),
    'results=' + (json.results || []).length)

  // ── 二、不编：每个项目必须说清它是什么 ──
  console.log('\n=== 二、不许"认不出就当没有"（历史 bug ②）===')
  const bad = json.results.filter((r) => !r.ok ? !r.reason : !r.facts.shape || r.facts.shape === '-')
  check('★★ 每个项目都有 shape 或明确的跳过原因（不许静默给 -/空）',
    bad.length === 0, bad.map((r) => r.id + '=' + (r.facts?.shape || r.reason)).join(' | '))

  // Quartz 这类必须被认成前端项目，不许被判成"Python 为主"
  const quartz = json.results.find((r) => r.id === 'quartz')
  if (quartz && quartz.ok) {
    check('★ Quartz 不许被认成「Python 为主」（它有 63 个 .tsx + package.json）',
      !/Python 为主/.test(quartz.facts.shape), quartz.facts.shape)
  } else {
    check('★ Quartz 在结果里（缺了就是漏项目）', false, 'not found')
  }

  // ── 三、数字可复算（独立再数一遍，不与脚本共用代码）──────────────
  console.log('\n=== 三、数字可复算：独立数一遍，必须与报告一致 ===')
  const fc = json.results.find((r) => r.id === 'fangcun-base')
  if (fc && fc.ok) {
    const R = path.join(ROOT, 'desktop', 'src', 'renderer')
    const vue = walk(R).filter((f) => f.endsWith('.vue') && !/[\\/]components[\\/]ui[\\/]/.test(f))
    let bare = 0
    for (const f of vue) {
      // ⚠ 必须剥注释再数（2026-11-17 实测）：`TaskCardMenu.vue` 的注释里有两处
      //   `<button>`（解释"为什么用 as=\"button\""），不剥就会多数 2 个 → 独立=473 对上
      //   报告=471 不符，**守卫会误判脚本错了**。事实是脚本对、守卫自己的口径错。
      //   这条差异是被这条断言当场抓出来的，所以它现在是必要的。
      const t = fs.readFileSync(f, 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      bare += (t.match(/<button\b/g) || []).length
    }
    check('★★ 方寸裸 <button> 数可复算（独立数一遍 == 报告，两边都剥注释）',
      bare === fc.facts.bareButtons, `独立=${bare} 报告=${fc.facts.bareButtons}`)

    const baseCount = walk(R).filter((f) =>
      /[\\/]components[\\/]ui[\\/]/.test(f) && /\.(vue|jsx|tsx)$/.test(f)).length
    check('★★ 方寸基座组件数可复算（扁平摆法不许数成 1 —— 历史 bug ①）',
      baseCount === fc.facts.baseComponents, `独立=${baseCount} 报告=${fc.facts.baseComponents}`)
  } else {
    check('★★ 方寸在结果里', false, 'not found')
  }

  // ── 四、阈值不藏 ──
  console.log('\n=== 四、阈值不许藏（掉队项不能变成系统黑箱）===')
  const human = (() => { try { return run([]) } catch (e) { return String(e.stdout || '') } })()
  // ⚠ 2026-11-17 反例自证抓到本条**原本是假绿**：原先只断言报告里出现
  //   「判据 / 基座使用率 / lint」这三个词 —— 而这三个词在**表格头**里也有，
  //   于是把 `RULES.forEach(...)` 整句删掉，本条照样 PASS。
  //   现在改成钉「逐条编号 + 阈值原文」：删掉打印就必然红。
  const numbered = (human.match(/^\s*\d+\.\s+.+$/gm) || [])
  check('★★ 人类可读报告里**逐条编号**打印了判据（不是只出现几个关键词）',
    numbered.length >= 5 && /基座使用率\s*<\s*50%/.test(human),
    `编号行=${numbered.length} 首条=${(numbered[0] || '').trim()}`)
  // --json 也必须带同一份 RULES（机读方不该拿到不完整的判据）
  check('★ --json 里也带 RULES（机读方与人类看到同一份判据）',
    Array.isArray(json.rules) && json.rules.length >= 5, 'rules=' + (json.rules || []).length)
  check('★ 明说了只读（不写仓库 / 不跑构建 / 不装依赖）',
    /只读/.test(human), '')

  // ── 五、无匹配显式失败 ──
  console.log('\n=== 五、无匹配必须显式失败（不许零产出假装通过）===')
  let code = 0
  try {
    run(['这个项目不存在xyz'])
  } catch (e) {
    code = e.status || 1
  }
  check('★★ 过滤不到任何项目时退出码非 0', code !== 0, 'exit=' + code)

  // ── 六、只读 ──
  console.log('\n=== 六、只读（跑完之后被扫仓库不许被改）===')
  const watch = json.results.filter((r) => r.ok).map((r) => r.repo).filter((p) => fs.existsSync(p))
  const before = snapshot(watch)
  try { run(['--json']) } catch { }
  const after = snapshot(watch)
  const changed = watch.filter((d) => before[d] !== after[d])
  check('★★ 跑一遍前后：被扫仓库的文件数与 mtime 一个不变',
    changed.length === 0, changed.map((d) => d + ': ' + before[d] + '→' + after[d]).join(' | '))

  // 本脚本自己也不许留临时文件
  const stray = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^\.?fe-audit\.tmp/.test(f))
  check('★ 不留临时文件', stray.length === 0, stray.join(','))

  report()
}

function report() {
  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
}

main()
