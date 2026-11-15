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
const { mkTmp, mkTmpPath } = require('./_tmp.cjs')
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

const TEST_ROOT = mkTmpPath('fc-selfcheck-')
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
    // 2026-11-15（D-141 / O1 选 A）：产出只认可核实产出 → 夹具必须带正文 + exists 判据。
    // 旧夹具的两张完成卡没有任何可核实的东西，按新口径会被判成"自报完成，不算产出"，
    // 那这条测试就验不到「额外一格引用 P5 数字」了 —— 这是夹具要跟着口径改，不是断言放宽。
    { id: 't1', title: '完成甲', status: '完成', updated: '2026-11-01T01:00:00.000Z', body: '落盘 `docs/a.md`' },
    { id: 't2', title: '完成乙', status: '完成', updated: '2026-11-01T02:00:00.000Z', body: '落盘 `docs/b.md`' },
  ],
  exists: (rel) => rel === 'docs/a.md' || rel === 'docs/b.md',
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
  // 2026-11-15（D-141 / O1 选 A）：口径从「完成 2 张卡」改成「可核实产出 2 件」。
  // 旧断言把"卡变完成"当成产出印在结论里 —— 那正是产品定义说"不算"的东西。
  check('★★ 额外一格引用 P5 数字（¥ 与可核实产出件数）',
    /额外一格[\s\S]*按投入产出账[\s\S]*¥/.test(md) && /可核实产出 2 件/.test(md), md.split('### 额外一格')[1]?.slice(0, 160))
  check('★ 结论里也有一条 P5 产出数字（门槛第 ④ 条），且是「可核实产出」不是「张卡完成」',
    /## 结论[\s\S]*- 近 30 天产出：3 次提交 · 2 件可核实产出/.test(md) && !/张卡完成/.test(md),
    md.split('## 结论')[1]?.slice(0, 200))
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

  // ══ ⑧ 每一格的判据必须跑在**它自己项目的仓库**里（2026-11-15 真 bug）═══════════
  // 真报告现场：司天那 4 格判据是 `cd E:/CODE/CangKu/SiTian && pytest …` 与
  // `file: utils/heightMath.js`，却全在**方寸仓库根**下执行 —— `utils/heightMath.js`
  // 当然不存在。7 条"未过"里大部分是**量错了地方**，而报告上它们和"那些项目真红"
  // 长得一模一样。判据：两个项目两份计划卡 → 报告里"量的仓库"列必须各写各的。
  {
    const A = path.join(TEST_ROOT, 'repo-a')
    const B = path.join(TEST_ROOT, 'repo-b')
    fs.mkdirSync(path.join(A, 'markers'), { recursive: true })
    fs.mkdirSync(path.join(B, 'markers'), { recursive: true })
    fs.writeFileSync(path.join(A, 'markers', 'only-a.txt'), 'A', 'utf-8')
    // registry：两个项目各指一个仓库
    fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'),
      'members: []\nprojects:\n  - id: demo-a\n    name: 甲\n    repo: "' + A.replace(/\\/g, '\\\\') + '"\n'
      + '  - id: demo-b\n    name: 乙\n    repo: "' + B.replace(/\\/g, '\\\\') + '"\n', 'utf-8')
    // 两份计划卡，各带一条**只在自己仓库里成立**的 file 判据
    const card = (pid, marker) => [
      '# ' + pid, '', '- 状态: 已冻结', '', '## 范围', '', '## 交付物', '', '## 验收标准', '', '## 里程碑', '', '## 除外责任', '',
      '### P0 · 各自仓库里的标记', '',
      '- 状态: 已冻结', '', '- 技术方案:', '  - x', '', '- 照抄点:', '  | 抄哪块 | 落到哪 | 不抄什么 | 怎么算抄到位 |', '  |---|---|---|---|', '  | a | b | c | d |', '',
      '- 判据:', '  - file: markers/' + marker + ' 存在', '',
    ].join('\n')
    fs.writeFileSync(path.join(TEST_ROOT, 'task-data', 'plans', 'demo-a.md'), card('demo-a', 'only-a.txt'), 'utf-8')
    fs.writeFileSync(path.join(TEST_ROOT, 'task-data', 'plans', 'demo-b.md'), card('demo-b', 'only-b.txt'), 'utf-8')

    const r = await runSelfCheck({ repo: A, days: 0, now: '2026-11-01T00:00:00.000Z' })
    const a = r.stages.find((s) => s.file === 'demo-a.md')
    const b = r.stages.find((s) => s.file === 'demo-b.md')
    check('★★ demo-a 的判据跑在 **A 仓库**（markers/only-a.txt 存在 → 通过）',
      !!a && a.passed === 1, a ? JSON.stringify({ repo: a.repo, passed: a.passed, failed: a.failed }) : '没有 demo-a')
    check('★★ demo-b 的判据跑在 **B 仓库**（only-b.txt 不在 A 里 —— 若仍用 A 根，这条会是 fail）',
      !!b && b.repo === B, b ? 'repo=' + b.repo : '没有 demo-b')
    check('★★ 报告里"量的仓库"列各写各的（不是所有卡都写同一个）',
      (() => {
        const md = buildSelfCheckMarkdown(r)
        const rows = md.split('\n').filter((l) => /^\| demo-[ab]\.md \|/.test(l))
        return rows.length === 2 && rows.some((x) => /repo-a/.test(x)) && rows.some((x) => /repo-b/.test(x))
      })(), resolveLater())
    function resolveLater() {
      try { return buildSelfCheckMarkdown(r).split('\n').filter((l) => /^\| demo-[ab]\.md \|/.test(l)).join(' ~~ ').slice(0, 200) } catch { return '' }
    }

    // 反例自证：把项目从 registry 摘掉 → 退回调用方根，且报告必须**显式标出来**
    fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'), 'members: []\nprojects: []\n', 'utf-8')
    const r2 = await runSelfCheck({ repo: A, days: 0, now: '2026-11-01T00:00:00.000Z' })
    const orphan = r2.stages.find((s) => s.file === 'demo-b.md')
    check('★★ 未登记的项目 → 退回调用方根，且**标出** repoFallback（不静默）',
      !!orphan && orphan.repoFallback === true, orphan ? String(orphan.repoFallback) : '没有 demo-b')
    check('★ 报告里写「未登记，退回」（读者能看出这条量错了地方）',
      /未登记，退回/.test(buildSelfCheckMarkdown(r2)))
    try { fs.rmSync(path.join(TEST_ROOT, 'task-data', 'plans', 'demo-a.md'), { force: true })
      fs.rmSync(path.join(TEST_ROOT, 'task-data', 'plans', 'demo-b.md'), { force: true }) } catch { /* ignore */ }
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
