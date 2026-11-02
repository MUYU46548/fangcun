#!/usr/bin/env node
/**
 * 自检报告 e2e（0.6.0 P7，2026-11-01）
 *
 * 真跑**编译产物** `dist/main/checks/selfCheck.js` + 真跑 Python 入口
 * `python scripts/selfcheck-plan.py`（它调 `selfcheck-cli.js`，不另开执行器）。
 *
 * 判据一句话：**逐格必须有三态，未过必须带实际值；额外一格引用 P5 数字，算不出就说原因。**
 *   · 通过 / 未过 / 未开工 三态，每格恰好一个；
 *   · 未过项附实际值（不是只说"未过"）；
 *   · 额外一格从投入产出账算；算不出 → 只允许一条“算不出，因为 X”；
 *   · 报告至少一条结论引用 P5 数字；
 *   · 自检不改计划卡。
 *
 * 运行：node scripts/test/e2e-selfcheck.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { execFileSync } = require('child_process')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'main', 'checks', 'selfCheck.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-selfcheck-' + Date.now())
process.env.FC_TEST_USERDATA = path.join(TEST_ROOT, '.userdata')
fs.mkdirSync(process.env.FC_TEST_USERDATA, { recursive: true })
fs.mkdirSync(path.join(TEST_ROOT, 'task-data', 'plans'), { recursive: true })
fs.mkdirSync(path.join(TEST_ROOT, 'docs'), { recursive: true })
fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'), 'members: []\nprojects: []\n', 'utf-8')
fs.writeFileSync(path.join(TEST_ROOT, 'docs', 'x.txt'), 'a\nb\nc\n', 'utf-8')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return path.join(__dirname, 'electron-stub.cjs')
  return origResolve.call(this, request, ...args)
}
const data = require(path.join(REPO, 'desktop', 'dist', 'main', 'data', 'index.js'))
data.setDataDir(TEST_ROOT)
const { buildSelfCheckMarkdown, runSelfCheck, writeSelfCheckReport } = require(ART)
const { buildWasteLedger, deriveWasteInsight } = require(path.join(REPO, 'desktop', 'dist', 'shared', 'waste.js'))

const LEDGER = buildWasteLedger({
  days: 30,
  now: '2026-11-01T04:00:00.000Z',
  trace: [{ ts: '2026-11-01T03:00:00.000Z', cost: '0.01000000', total_tokens: 1000 }],
  commits: ['a', 'b', 'c'],
  tasks: [
    { id: 't1', title: '完成甲', status: '完成', updated: '2026-11-01T01:00:00.000Z' },
    { id: 't2', title: '完成乙', status: '完成', updated: '2026-11-01T02:00:00.000Z' },
  ],
})

function stage(id, conclusion, results = []) {
  return {
    file: 'demo.md', id, title: id + ' 标题', status: '已冻结', conclusion,
    results, total: results.length,
    passed: results.filter((r) => r.state === 'pass').length,
    failed: results.filter((r) => r.state === 'fail').length,
    unknown: results.filter((r) => r.state === 'unknown').length,
  }
}
function reportOf(stages, ledger = LEDGER) {
  const insight = deriveWasteInsight(ledger)
  const totals = {
    stages: stages.length,
    pass: stages.filter((s) => s.conclusion === '通过').length,
    fail: stages.filter((s) => s.conclusion === '未过').length,
    notStarted: stages.filter((s) => s.conclusion === '未开工').length,
    criteria: stages.reduce((n, s) => n + s.total, 0),
    passed: stages.reduce((n, s) => n + s.passed, 0),
    failed: stages.reduce((n, s) => n + s.failed, 0),
    unknown: stages.reduce((n, s) => n + s.unknown, 0),
  }
  return { date: '2026-11-01', iso: '2026-11-01T00:00:00.000Z', days: 30, files: ['demo.md'], stages, totals, ledger, insight }
}

console.log('== ① 报告结构：三态 + 实际值 + 引用 P5 ==')
{
  const good = stage('P0', '通过', [
    { raw: 'cmd: node x.js', state: 'pass', detail: '退出码 0', evidence: {} },
  ])
  const bad = stage('P1', '未过', [
    { raw: 'num: docs/x.txt 行数 >= 5', state: 'fail', detail: '行数 = 3，要求 >= 5', evidence: { actual: 3 } },
    { raw: 'str: docs/x.txt 含 \'zzz\'', state: 'unknown', detail: '文件不存在', evidence: {} },
  ])
  const notStarted = stage('P2', '未开工')
  const md = buildSelfCheckMarkdown(reportOf([good, bad, notStarted]))
  check('★★ 逐格三态都在（通过 / 未过 / 未开工）',
    /通过/.test(md) && /未过/.test(md) && /未开工/.test(md), md.slice(0, 200))
  check('★ 每格三态恰好一个（表格结论列）', (() => {
    const rows = md.split('\n').filter((l) => /^\| demo\.md \|/.test(l))
    return rows.length === 3 && rows.every((r) => {
      const cells = r.split('|').map((x) => x.trim())
      return ['通过', '未过', '未开工'].filter((w) => cells.includes(w)).length === 1
    })
  })(), md.split('\n').filter((l) => /^\| demo\.md \|/.test(l)).join('\n'))
  check('★★ 未过项带实际值（不是只说"未过"）',
    /“num: docs\/x\.txt 行数 >= 5”→ 实际值 3（未过）/.test(md), md.split('\n').filter((l) => l.includes('num:')).join(' | '))
  check('★★ 额外一格引用 P5 数字（¥ 与完成卡数）',
    /额外一格[\s\S]*按投入产出账[\s\S]*¥/.test(md) && /完成 2 张卡/.test(md), md.split('### 额外一格')[1]?.slice(0, 160))
  check('★ 结论里也有一条 P5 产出数字（门槛第 ④ 条）',
    /## 结论[\s\S]*- 近 30 天产出：3 次提交 · 2 张卡完成/.test(md))
}

console.log('\n== ② 算不出：只允许一条，且必须写原因 ==')
{
  const noSpend = buildWasteLedger({ days: 30, now: '2026-11-01T04:00:00.000Z', trace: null, commits: ['a'], tasks: [] })
  const md = buildSelfCheckMarkdown(reportOf([stage('P0', '未开工')], noSpend))
  const n = (md.match(/算不出/g) || []).length
  check('★ 算不出条数 ≤ 1', n <= 1, String(n))
  check('★★ 算不出必须带“因为 X”', /算不出，因为/.test(md), md.split('### 额外一格')[1]?.slice(0, 160))
  check('★ 缺“花了多少”时指明缺哪一格', /缺少“花了多少”/.test(md))
}

console.log('\n== ③ 真跑：临时计划卡 → 三态 + 实际值 + 不改卡 ==')
async function main() {
  const PLAN = path.join(TEST_ROOT, 'task-data', 'plans', 'demo.md')
  const PLAN_TEXT = `# 测试计划

## 阶段卡

### P0 · 会被自检

- 状态: 已冻结
- 做什么: 测试自检
- 判据:

  - cmd: node -e "process.exit(0)"
  - num: docs/x.txt 行数 >= 5
  - foo: 未知前缀

### P1 · 待裁决

- 状态: 待裁决
- 做什么: 不该跑
- 判据:

  - cmd: node -e "process.exit(1)"
`
  fs.writeFileSync(PLAN, PLAN_TEXT, 'utf-8')
  const before = fs.readFileSync(PLAN, 'utf-8')
  const r = await runSelfCheck({ repo: TEST_ROOT, days: 30, now: '2026-11-01T00:00:00.000Z' }, {
    ledger: () => LEDGER,
  })
  check('★ 只跑“已冻结”的格子；待裁决记未开工',
    r.stages.length === 2 && r.stages[0].conclusion === '未过' && r.stages[1].conclusion === '未开工',
    JSON.stringify(r.stages.map((s) => ({ id: s.id, c: s.conclusion }))))
  check('★ 判据计数如实：1 通过 / 1 未过 / 1 未判定',
    r.totals.criteria === 3 && r.totals.passed === 1 && r.totals.failed === 1 && r.totals.unknown === 1,
    JSON.stringify(r.totals))
  check('★★ 报告里有实际值（行数 = 3）', /实际值 3/.test(r.markdown), r.markdown.split('\n').filter((l) => l.includes('行数')).join(' | '))
  check('★ 自检不修改计划卡（字节不变）', fs.readFileSync(PLAN, 'utf-8') === before)
  const out = writeSelfCheckReport(TEST_ROOT, r)
  check('★ 报告落 docs/自检报告-<日期>.md', out.indexOf(path.join('docs', '自检报告-2026-11-01.md')) >= 0 && fs.existsSync(out), out)

  console.log('\n== ④ 真跑 Python 入口（唯一执行器；不是第二套）==')
  let pyOut = ''
  try {
    pyOut = execFileSync('python', ['scripts/selfcheck-plan.py'], {
      cwd: REPO, encoding: 'utf-8', timeout: 180000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
  } catch (e) {
    check('★★ python scripts/selfcheck-plan.py 退出码 0', false, (e && (e.message + ' ' + String(e.stdout || '') + ' ' + String(e.stderr || ''))).slice(0, 600))
  }
  if (pyOut) {
    check('★★ python scripts/selfcheck-plan.py 退出码 0', true)
    const today = (() => {
      const d = new Date()
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    })()
    const realReport = path.join(REPO, 'docs', `自检报告-${today}.md`)
    check('★★ 真报告落到 docs/自检报告-<今天>.md', fs.existsSync(realReport), realReport)
    if (fs.existsSync(realReport)) {
      const text = fs.readFileSync(realReport, 'utf-8')
      check('★★ 真报告逐格有三态之一', /通过|未过|未开工/.test(text))
      check('★★ 真报告有投入产出账 + P5 数字', /## 投入产出账/.test(text) && /(¥|tokens|次提交)/.test(text))
      check('★★ 真报告至少一条结论引用 P5 数字（门槛第 ④ 条）',
        /## 结论[\s\S]*(?:产出：|按投入产出账)/.test(text), text.split('## 结论')[1]?.slice(0, 200))
      check('★ 真报告里没有“算不出”超过 1 条', (text.match(/算不出/g) || []).length <= 1)
    }
  }

  console.log('\n== ⑤ 接线/边界守卫 ==')
  {
    const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf-8')
    const SRC = read('desktop/src/main/checks/selfCheck.ts')
    check('★ 复用 P3 执行器与 P4 准入（runCriterion / evaluateStageGate）',
      /runCriterion/.test(SRC) && /evaluateStageGate/.test(SRC))
    check('★ 自检自身命令不递归（源码里有 selfcheck-plan.py 的跳过）',
      /SELF_CMD/.test(SRC) && /selfcheck-plan/.test(SRC))
    check('★ 自检不写计划卡（不 import advanceStage / writePlanVerdict）',
      !/advanceStage|writePlanVerdict/.test(SRC))
    const PY = read('scripts/selfcheck-plan.py')
    check('★ Python 只是调度：调 selfcheck-cli.js，不自己解析/执行判据',
      /selfcheck-cli\.js/.test(PY) && !/parse_criterion|run_criterion|cmd:/.test(PY))
    check('★ 报告落点固定 docs/自检报告-', /自检报告-/.test(PY) && /docs/.test(PY))
  }

  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log(' - ' + f)) }
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('FAIL  测试驱动异常：' + ((e && e.stack) || e))
  process.exit(1)
})
