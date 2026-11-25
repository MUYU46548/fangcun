#!/usr/bin/env node
/**
 * 「黑窗口」守门（2026-11-25）
 *
 * ## 起因
 *
 * 日志 `log_20261123092841_s4ag5j` 第 10 条：
 * 「黑窗口在启动DSH后再次复发，需排查是否为方寸插件原因。」
 *
 * ## 本机机制（已核实，别猜）
 *
 * `HKCU\Console\%%Startup` 键**存在但零值** → Windows 11 把控制台委托给 Windows Terminal。
 * 于是**任何进程只要创建一个控制台，就会弹一个可见的 WindowsTerminal 窗口**
 * （`CASCADIA_HOSTING_WINDOW_CLASS`）。所以"黑窗口"的第 0 问永远是：
 * **谁创建了控制台**。
 *
 * ## 这条守卫钉什么
 *
 * 不能断言"不是方寸" —— 那要靠现场抓。能钉的是**可复核的那一半**：
 *
 *   ① **方寸主进程的每一个 `spawn` / `execFile` / `exec` 都必须带 `windowsHide: true`**
 *      （Windows 上它等于 `CREATE_NO_WINDOW`，控制台根本不创建，也就没有窗口）。
 *      ⚠ 漏一个 = 那条路径就是潜在的黑窗口来源。
 *   ② **方寸插件（dsh-fangcun）不许用 `child_process`** —— 它在 DSH 进程里，
 *      一旦起子进程，黑窗口就会在"启动 DSH 之后"出现，正好对上用户的描述。
 *
 * 两条都**静态扫源码**：不依赖复现，随时可跑。
 *
 * ## 它挡不住什么（如实说）
 *
 * 挡不住**别人**创建的控制台（DSH 自己、Hermes、别的插件、启动台拉起的应用）。
 * 所以本脚本末尾打印一条**现场取证命令**：黑窗口再出现时跑它，
 * 按 `CASCADIA_*` / `ConsoleWindowClass` 枚举 + 父进程链，能直接看出是谁。
 * ⚠ 不要用 `MainWindowHandle` 判断控制台窗口 —— 实测它对控制台恒为 0（本仓已踩过）。
 *
 * 用法：node scripts/test/check-no-console-spawn.cjs
 */
'use strict'
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const MAIN_DIR = path.join(REPO, 'desktop', 'src', 'main')
const INDEX_TS = path.join(REPO, 'desktop', 'src', 'index.ts')
const PLUGIN_LIB = path.join(REPO, '..', 'dsh-fangcun', 'lib')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? '   → ' + detail : ''}`) }
}

/** 递归收集 .ts 文件 */
function walk(dir, out = []) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts') || e.name.endsWith('.js')) out.push(p)
  }
  return out
}

/**
 * 剥注释（行注释 + 块注释）。
 *
 * ⚠ 必须剥：本仓栽过 —— 源码守卫把**注释里**的写法当成真调用，
 * 于是反例假红/假绿都出现过（2026-11-24 那次 `㉚` 就是匹配到注释）。
 * 但这里要注意：`//` 也可能出现在字符串里（如 URL）。本文件的用途是"找 spawn 调用"，
 * 用保守规则：只剥**整行**以 // 开头的、以及 /* ... *\/ 块。行尾注释保留（宁可多留，不漏）。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')
}

/**
 * 明确登记的例外：**故意**不藏窗口的地方（写了理由才算数，空理由直接红）。
 *
 * 语义：这里"创建控制台"**就是产品行为** —— 用户点「启动」就是要那个窗口出现。
 * 判据不是"藏起来更好"，而是"这是不是用户要可见的窗口"。
 */
const ALLOW_VISIBLE = {
  'desktop/src/main/launchpad/executor.ts':
    '2026-11-25 · 启动台拉起的是**用户自己登记的程序**；.cmd/.bat 必须弹它自己的控制台窗口，'
    + 'stdout 也靠那个窗口给用户看。藏掉窗口反而让"点了启动没反应"。所以 windowsHide:false 是产品语义，不是泄漏。',
}

console.log('== 黑窗口 · 谁在创建控制台 ==')
console.log('')
// 登记不等于藏起来：每次运行都把豁免打印出来
for (const [f, why] of Object.entries(ALLOW_VISIBLE)) {
  console.log(`（登记豁免）${f}  → ${why}`)
}
if (Object.keys(ALLOW_VISIBLE).length) console.log('')

// ── ① 方寸主进程：每个 spawn 都要 windowsHide:true ──────────────────────
{
  const files = walk(MAIN_DIR).concat([INDEX_TS].filter((f) => fs.existsSync(f)))
  check('★ 扫得到方寸主进程源码', files.length > 0, files.length + ' 个文件')

  // 只认**真的调用**：`spawn(` / `execFile(` / `execSync(` / `exec(`，且不是 x.exec( 这种正则
  const CALL = /(?:^|[^.\w])(spawn|execFile|execSync|exec)\s*\(/g
  const offenders = []
  let total = 0
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf-8')
    const src = stripComments(raw)
    const lines = src.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      CALL.lastIndex = 0
      if (!CALL.test(lines[i])) continue
      // 排除正则对象的 .exec（形如 `.exec(` 已被上面的 [^.\w] 挡掉，这里再兜一层）
      if (/\.\s*(exec|execSync)\s*\(/.test(lines[i])) continue
      // 排除 taskkill 那条以外无关的字符串匹配（如 new RegExp）
      if (/RegExp/.test(lines[i])) continue
      total++
      // 选项里有没有 windowsHide —— 在同一次调用的**下面 12 行**内找（多行写法）
      const window = lines.slice(i, i + 12).join('\n')
      const rel = path.relative(REPO, f).replace(/\\/g, '/')
      const explicit = /windowsHide\s*:\s*(true|false)/.exec(window)
      if (!explicit) {
        // 完全没写 = 用 Node 默认值（Windows 上会创建控制台）→ 这才是真泄漏
        offenders.push(rel + ':' + (i + 1) + '  没写 windowsHide（默认会创建控制台）')
      } else if (explicit[1] === 'false' && !ALLOW_VISIBLE[rel]) {
        offenders.push(rel + ':' + (i + 1) + '  写了 windowsHide:false 但没登记理由')
      }
    }
  }
  check('★ 扫到了 spawn 调用（扫到 0 个 = 扫描器坏了，不是"没有"）', total > 0, 'calls=' + total)
  check('★★★ 每一个 spawn 都**显式**写了 windowsHide（默认值会创建控制台）',
    !offenders.some((x) => x.includes('没写 windowsHide')), offenders.filter((x) => x.includes('没写')).join(' | '))
  check('★★★ windowsHide:false 的地方都登记了理由（登记 ≠ 藏起来）',
    !offenders.some((x) => x.includes('没登记理由')), offenders.filter((x) => x.includes('没登记')).join(' | '))
}

// ── ② 插件：不许用 child_process ────────────────────────────────────────
{
  const havePlugin = fs.existsSync(PLUGIN_LIB)
  if (!havePlugin) {
    console.log('SKIP  插件侧（找不到 ' + PLUGIN_LIB + '）')
  } else {
    const files = walk(PLUGIN_LIB)
    check('★ 读得到插件源码', files.length > 0, files.length + ' 个文件')
    const hits = []
    for (const f of files) {
      const src = stripComments(fs.readFileSync(f, 'utf-8'))
      if (/require\(\s*['"]child_process['"]\s*\)/.test(src)
        || /from\s+['"]node:child_process['"]/.test(src)
        || /from\s+['"]child_process['"]/.test(src)) {
        hits.push(path.relative(path.join(REPO, '..'), f))
      }
    }
    check('★★★ 插件不许用 child_process（它在 DSH 进程里，一起子进程黑窗口就"在启动 DSH 后"出现）',
      hits.length === 0, hits.join(' | '))
  }
}

// ── ③ 源码守卫：不许用 MainWindowHandle 判控制台窗口 ────────────────────
{
  const files = walk(MAIN_DIR).concat(walk(path.join(REPO, 'scripts')))
  const bad = []
  for (const f of files) {
    if (!f.endsWith('.cjs') && !f.endsWith('.js') && !f.endsWith('.ps1')) continue
    const src = fs.readFileSync(f, 'utf-8')
    if (/MainWindowHandle/.test(src) && /console|Console|CASCADIA/.test(src)) {
      bad.push(path.relative(REPO, f))
    }
  }
  check('★★ 不许拿 MainWindowHandle 判断控制台窗口（实测对控制台恒为 0，本仓踩过）',
    bad.length === 0, bad.join(' | '))
}

console.log('')
console.log(`RESULT ${pass} / ${fail}`)
if (fail) {
  console.log('')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('')
console.log('⚠ 本守卫只证明「方寸和插件都没创建控制台」。')
console.log('  黑窗口再出现时，用这条抓现场（按 CASCADIA_* 枚举 + 父进程链，别用 MainWindowHandle）：')
console.log('')
console.log('  powershell -NoProfile -Command "Get-CimInstance Win32_Process |')
console.log('    Where-Object { $_.Name -match \'WindowsTerminal|conhost|cmd|powershell\' } |')
console.log('    Select-Object ProcessId,ParentProcessId,Name,CommandLine | Format-List"')
console.log('')
