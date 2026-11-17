#!/usr/bin/env node
/**
 * ESLint 配置守卫 · A1a（2026-11-17）
 *
 * ## 为什么这需要守卫
 *
 * 这份 eslint 配置**今天上午连续写出了三种假绿**，每一种都"跑成功了、退出码正常"：
 *
 *   ① 没注册 vue 插件   → EXIT=2，但看起来像"配置写错了"，容易被当成环境问题跳过
 *   ② 没给 TS parser    → 58/59 个 .vue 文件 parse error → **违规只剩 23 条**（真值 471）
 *   ③ 独立的 .ts 没给 parser → 31 个 .ts 全 parse error → 统计残缺
 *   ④ `VElement[name="button"]` 会**把小写化后的 `<Button>` 组件也算成裸 button**
 *      → `DecisionBoard.vue` 源码 0 个 `<button`、18 个 `<Button`，被报 20 条。
 *      642 里一大半是这种假阳性。修法是加 `[rawName="button"]`。
 *
 * 第 ②④ 两条最危险：它们让**数字看起来合理**（23 条"少得可疑"、642 条"多得可疑"），
 * 而只有拿独立代码再数一遍才发现。所以本守卫钉的是：
 *
 *   ① 配置能被 eslint 加载（不是崩在 require）
 *   ② **parse 错误必须为 0**（有 parse 错误 = 那些文件没被检查 = 统计不可信）
 *   ③ 裸 button 数 == `scripts/fe-audit.cjs` 独立数（两套代码同一事实）
 *   ④ `rawName` 必须写在选择器里（否则 `<Button>` 会被误报）
 *   ⑤ 规则必须是 `warn` 不是 `error`（A1a 阶段**不许**拦构建/拦提交）
 *   ⑥ 配置不挂进 build（A1a 只出账，不设门槛）
 *
 * 跑法：node scripts/test/check-fe-lint.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(ROOT, 'desktop')
const CFG = path.join(DESKTOP, 'eslint.config.cjs')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function runEslint() {
  const out = path.join(require('os').tmpdir(), 'fc-lint-guard.json')
  try { fs.rmSync(out, { force: true }) } catch { }
  try {
    execFileSync('npx', ['eslint', 'src/renderer', '--format', 'json', '-o', out],
      { cwd: DESKTOP, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: true })
  } catch { /* eslint 有 warn 时退出码非 0，正常 */ }
  try { return JSON.parse(fs.readFileSync(out, 'utf8')) } catch { return null }
}

function main() {
  console.log('=== 一、配置能被加载 ===')
  check('★★ desktop/eslint.config.cjs 存在', fs.existsSync(CFG))
  if (!fs.existsSync(CFG)) { report(); return }
  const src = fs.readFileSync(CFG, 'utf8')

  // 静态判据（不依赖 eslint 跑得动）
  console.log('\n=== 二、静态：不许写出已知的假绿形状 ===')
  check('★★ 选择器带 [rawName="button"]（否则 <Button> 组件会被误报成裸 button）',
    /\[rawName="button"\]/.test(src),
    /VElement\[name="button"\]/.test(src) && !/rawName/.test(src) ? '写成了 [name="button"] → 会误报' : '')
  // ⚠ 2026-11-17 反例自证推翻了这条的**原写法**：原先断言"必须显式写 plugins: { vue }"，
  //   但实测把那一行删掉后**一切照常**（471 条不变）—— 因为 `...vue.configs['flat/base']`
  //   已经带上了插件对象。所以"必须显式注册"是**我自己臆想的风险**，不是真风险；
  //   真正会崩的形状是"既没 spread flat/base、也没 plugins"。这里改成钉后者。
  check('★ vue 插件有来源（spread `flat/base` 或显式 `plugins: { vue }`，二者有其一）',
    /vue\.configs\['flat\/base'\]/.test(src) || /plugins:\s*\{\s*vue\s*\}/.test(src), '')
  check('★ .vue 与 .ts 各自给了 TS parser（.vue 走 parserOptions.parser）',
    /parserOptions:\s*\{[^}]*parser:\s*tseslint\.parser/s.test(src) && /files:\s*\['\*\*\/\*\.\{ts,tsx\}'\]/.test(src),
    '')
  check('★ 规则是 warn 不是 error（A1a 阶段不许设门槛）',
    !/no-restricted-syntax':\s*\[\s*'error'/.test(src) && /'warn'/.test(src), '')
  check('★ 配置没挂进 build / 没有 lint script 拦提交（A1a 只出账）',
    (() => {
      const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'))
      return !/lint/.test(pkg.scripts.build || '') && !Object.keys(pkg.scripts).some((k) => /^lint$/.test(k))
    })(), '')

  // ── 真跑：parse 错误必须为 0 ──
  console.log('\n=== 三、真跑：parse 错误必须为 0（有错误 = 那些文件没被检查）===')
  const data = runEslint()
  check('★★ eslint 能跑出 JSON', !!data, data ? 'files=' + data.length : '')
  if (!data) { report(); return }

  let fatal = 0
  for (const f of data) for (const m of f.messages) if (!m.ruleId) fatal++
  check('★★ parse 错误必须为 0（否则统计是假绿）', fatal === 0, 'parse 错误=' + fatal)

  // ── 与独立体检对账 ──
  console.log('\n=== 四、与独立体检对账（两套代码数同一个事实）===')
  let buttons = 0
  for (const f of data) for (const m of f.messages) {
    if (m.ruleId === 'vue/no-restricted-syntax' && String(m.message).includes('button')) buttons++
  }
  let audit = null
  try {
    audit = JSON.parse(execFileSync(process.execPath,
      [path.join(ROOT, 'scripts', 'fe-audit.cjs'), '--json', '方寸'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
  } catch (e) { /* 下面断言会红 */ }
  const fc = audit && (audit.results || [])[0]
  const independent = fc && fc.facts ? fc.facts.bareButtons : null
  check('★★ eslint 数 == fe-audit 独立数（差一条都要查，别挑好看的那个用）',
    independent !== null && buttons === independent,
    `eslint=${buttons} fe-audit=${independent}`)
  check('★ 数到了一个有意义的量级（不是 0 / 不是个位数 = 没配好）',
    buttons > 100, 'buttons=' + buttons)

  // ── 只读：跑 lint 不改源码 ──
  console.log('\n=== 五、只读：跑 lint 不许改源码 ===')
  const R = path.join(DESKTOP, 'src', 'renderer')
  const snapshot = (() => {
    let n = 0, sum = 0
    const walk = (d) => {
      let items
      try { items = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const it of items) {
        const p = path.join(d, it.name)
        if (it.isDirectory()) walk(p)
        else { n++; try { sum += fs.statSync(p).mtimeMs } catch { } }
      }
    }
    walk(R)
    return n + ':' + Math.round(sum)
  })()
  runEslint()
  const after = (() => {
    let n = 0, sum = 0
    const walk = (d) => {
      let items
      try { items = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const it of items) {
        const p = path.join(d, it.name)
        if (it.isDirectory()) walk(p)
        else { n++; try { sum += fs.statSync(p).mtimeMs } catch { } }
      }
    }
    walk(R)
    return n + ':' + Math.round(sum)
  })()
  check('★★ 跑两遍 lint，src/renderer 的文件数与 mtime 一个不变', snapshot === after,
    snapshot === after ? '' : `${snapshot} → ${after}`)

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
