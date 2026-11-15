/**
 * 判据路径 · 带空格目录（2026-11-15 真 bug 的守卫）
 *
 * 修的什么：`parseCheckLine` 三个解析器（str / num / file）一律用 `^(\S+)\s+` 取路径，
 * 于是 Obsidian vault 的 `09 绒花计划/x.md` 被切成 `09` → 永远 unknown。
 * 而 unknown 在闸里**不等于通过** → 这类项目的判据永远拿不到绿。
 *
 * 为什么必须真跑编译产物：解析逻辑在 `src/shared/checkSpec.ts`，
 * 断言只认 `dist/shared/checkSpec.js` —— 改源码不重新 build 的时候，
 * 这条守卫会让"改了没生效"当场暴露。
 *
 * 运行：node scripts/test/e2e-check-paths.cjs
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..', '..')
const MOD = path.join(ROOT, 'desktop', 'dist', 'shared', 'checkSpec.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

if (!fs.existsSync(MOD)) {
  console.log('SKIP  编译产物不存在（先 cd desktop && npm run build）')
  console.log('RESULT 0 / 0')
  process.exit(0)
}
const cs = require(MOD)
const P = (l) => cs.parseCheckLine(l)

console.log('== 判据路径 · 带空格目录守卫 ==')

// ── ① 核心：带空格目录（不带引号）必须能解析 ────────────────────────────
{
  const cases = [
    ['file: 09 绒花计划/OB37-章纲.md', 'file', '09 绒花计划/OB37-章纲.md'],
    ['file: 03 设定/08 种族/希尔人.md', 'file', '03 设定/08 种族/希尔人.md'],
    ['file: 00 主面板/x.md 存在', 'file', '00 主面板/x.md'],
    ['str: 03 设定/08 种族/希尔人.md 含 \'希尔人\'', 'str', '03 设定/08 种族/希尔人.md'],
    ['num: 09 绒花计划/x.md 行数 >= 10', 'num', '09 绒花计划/x.md'],
  ]
  let bad = []
  for (const [line, kind, wantPath] of cases) {
    const r = P(line)
    const gotPath = r.kind === 'file' ? r.pattern : r.kind ? r.path : ''
    if (r.kind !== kind || gotPath !== wantPath) {
      bad.push(`${line} → kind=${r.kind} path=${JSON.stringify(gotPath)}`)
    }
  }
  check('★★ 带空格目录的 file/str/num 都能解析且路径完整（这是本次修的 bug）',
    bad.length === 0, bad.join(' | '))
}

// ── ② 引号写法也认（显式意图）────────────────────────────────────────────
{
  const r1 = P('file: "09 绒花计划/x.md"')
  const r2 = P('str: "03 设定/a.md" 含 \'x\'')
  check('★ 引号包起来的带空格路径也认',
    r1.kind === 'file' && r1.pattern === '09 绒花计划/x.md' &&
    r2.kind === 'str' && r2.path === '03 设定/a.md',
    `r1=${r1.kind}:${r1.pattern} r2=${r2.kind}:${r2.path}`)
}

// ── ③ 老写法零破坏 ──────────────────────────────────────────────────────
{
  const cases = [
    ['file: src/a.md', 'file', 'src/a.md'],
    ['file: a/b/c.md', 'file', 'a/b/c.md'],
    ['str: a.md 含 \'代价\'', 'str', 'a.md'],
    ['num: a.md 行数 >= 3', 'num', 'a.md'],
  ]
  const bad = []
  for (const [line, kind, wantPath] of cases) {
    const r = P(line)
    const gotPath = r.kind === 'file' ? r.pattern : r.kind === 'str' || r.kind === 'num' ? r.path : ''
    if (r.kind !== kind || gotPath !== wantPath) bad.push(`${line} → ${r.kind}:${gotPath}`)
  }
  check('★★ 老写法（无空格路径）零破坏', bad.length === 0, bad.join(' | '))
}

// ── ④ 该拒的仍要拒（防"放宽到什么都收"）────────────────────────────────
{
  const mustUnknown = [
    ['file: C:\\abs\\x.md', '绝对路径'],
    ['file: /abs/x.md', '前导斜杠'],
    ['file: 本文件', '指代'],
    ['human: 人眼看一眼', 'human'],
    ['foo: bar', '未知前缀'],
  ]
  const bad = []
  for (const [line, why] of mustUnknown) {
    const r = P(line)
    if (r.kind !== 'unknown') bad.push(`${line}（${why}）被判成 ${r.kind}`)
  }
  check('★★ 绝对路径 / 指代 / human / 未知前缀仍然是 unknown（不许放宽到什么都收）',
    bad.length === 0, bad.join(' | '))
}

// ── ⑤ str 的「含」不许被吃进路径里（这是宽松化最大的风险）──────────────
{
  // 这条防的是"从长到短试路径"时把 `含` 也吞掉
  const r = P('str: a.md 含 \'x y\'')
  check('★ str 的原文没被吃进路径（`含` 必须在路径之外）',
    r.kind === 'str' && r.path === 'a.md' && r.text === 'x y',
    `kind=${r.kind} path=${r.path} text=${r.text}`)
}

// ── ⑥ num 的指标不许被吃进路径 ─────────────────────────────────────────
{
  const r = P('num: 09 绒花计划/x.md 行数 >= 10')
  check('★ num 的指标没被吃进路径（`行数` 必须在路径之外）',
    r.kind === 'num' && r.path === '09 绒花计划/x.md' && r.metric === 'lines' && r.expected === 10,
    `kind=${r.kind} path=${r.path} metric=${r.metric} expected=${r.expected}`)
}

// ── ⑦ 真项目实测：ROSA 那种编号目录在真身里确实存在 ──────────────────────
{
  const rosa = 'E:/图书馆/ROSA'
  if (fs.existsSync(rosa)) {
    const dirs = fs.readdirSync(rosa).filter((d) => /^\d+\s/.test(d))
    check('★ 真身里确实存在「数字+空格」目录（这条断言不是为假想 scenari​o 写的）',
      dirs.length > 0, `ROSA 顶层这类目录 ${dirs.length} 个`)
  } else {
    console.log('SKIP  ROSA 仓库不在本机，跳过真身对账')
  }
}

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
