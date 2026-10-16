/**
 * 规划管理（Plan）四通道端到端测试（2026-10-16 批次第 1 项）
 *
 * 覆盖 main/data/tasks.ts 的规划链路（此前渲染层零调用=死通道，本批接「🗂 规划」弹窗）：
 *  - createPlan：建规划（草稿态、决策点 id 自动补齐 dp_001…）
 *  - listPlans：type=plan 过滤
 *  - getPlan：读回 plan 数据（目标/里程碑/决策点往返一致）
 *  - decidePlanPoint：选定留痕（chosen+decidedAt 落任务文件）、改选覆盖留痕、
 *    决策点全定完自动 draft→active（任务状态 草稿→进行中）
 *  - renderPlanBody / parsePlanFromTask 往返：决策点状态序列化不丢
 *
 * 运行：node scripts/test/e2e-plans.cjs（electron 桩注入，纯 node 直调 dist/main 数据层）
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

// ── electron 桩注入（必须在业务模块之前，同 e2e-task-fields.cjs） ──
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-plans-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT

const DIST = path.resolve(__dirname, '../../desktop/dist/main')

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
}

function main() {
  console.log('== 规划管理（Plan）四通道测试 ==')
  console.log('root:', TEST_ROOT)

  fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
  writeFile(path.join(TEST_ROOT, 'registry.yaml'), 'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示\n')

  const data = require(path.join(DIST, 'data', 'index.js'))
  const tasks = require(path.join(DIST, 'data', 'tasks.js'))
  data.setDataDir(TEST_ROOT)

  // ── createPlan：建一条带 2 决策点的规划 ──────────────────────────────
  const r = tasks.createPlan({
    title: '0.3.7 发版计划',
    project: 'demo',
    objective: '把启动台三件事收口',
    milestones: [{ name: '设计稿定稿', deadline: '2026-10-20' }, { name: '发版', deadline: '' }],
    decisions: [
      { question: '端口模型走哪版？', options: ['端口=配置项', '端口=观测结果'] },
      { question: '发版窗口？', options: ['周五', '下周一'] },
    ],
    risks: ['打包器先走通'],
  })
  check('createPlan 返回 id 与 plan 型任务卡', !!r && !!r.id && !!r.task && r.task.fm.type === 'plan', JSON.stringify(r && r.id))
  check('新建规划落在活跃任务区（草稿态，状态=草稿）',
    r.task.fm.plan_status === 'draft' && r.task.fm.status === '草稿',
    `plan_status=${r.task.fm.plan_status} status=${r.task.fm.status}`)
  check('决策点 id 自动补齐（dp_001 / dp_002）',
    (() => { const p = tasks.parsePlanFromTask(r.task); return !!p && p.decisions.length === 2 && p.decisions[0].id === 'dp_001' && p.decisions[1].id === 'dp_002' })())

  // ── listPlans：类型过滤 ──────────────────────────────────────────────
  const plans = tasks.listPlans('all')
  check('listPlans 能看到刚建的规划（type=plan 过滤）', plans.some(t => t.fm.id === r.id),
    `count=${plans.length}`)

  // ── getPlan：读回与写入往返一致 ──────────────────────────────────────
  const g = tasks.getPlan(r.id)
  check('getPlan 读回 task + plan 双件', !!g && !!g.task && !!g.plan, JSON.stringify(g && !!g.plan))
  check('目标往返一致', g.plan.objective === '把启动台三件事收口', g.plan.objective)
  check('里程碑往返一致（含空截止）',
    g.plan.milestones.length === 2 && g.plan.milestones[0].name === '设计稿定稿' && g.plan.milestones[0].deadline === '2026-10-20' && g.plan.milestones[1].deadline === '',
    JSON.stringify(g.plan.milestones))
  check('决策点往返一致（问题+选项全量）',
    g.plan.decisions.length === 2 && g.plan.decisions[0].question === '端口模型走哪版？' && g.plan.decisions[0].options.length === 2,
    JSON.stringify(g.plan.decisions.map(d => d.question)))
  check('风险往返一致', g.plan.risks.length === 1 && g.plan.risks[0] === '打包器先走通', JSON.stringify(g.plan.risks))
  check('getPlan 不存在的 id → null', tasks.getPlan('no-such-plan') === null)

  // ── decidePlanPoint：选定留痕 + 全定完自动转「进行中」 ────────────────
  let d1 = tasks.decidePlanPoint(r.id, 'dp_001', '端口=观测结果')
  check('决策点 1 选定成功', d1.ok === true, JSON.stringify(d1))
  let g2 = tasks.getPlan(r.id)
  const dp1 = g2.plan.decisions.find(x => x.id === 'dp_001')
  check('留痕落盘：chosen + decidedAt 都写进任务文件',
    dp1.status === 'decided' && dp1.chosen === '端口=观测结果' && !!dp1.decidedAt && !isNaN(Date.parse(dp1.decidedAt)),
    JSON.stringify(dp1))
  check('还有待定决策点 → 规划仍是草稿',
    g2.plan.status === 'draft' && g2.task.fm.status === '草稿',
    `plan=${g2.plan.status} task=${g2.task.fm.status}`)

  // 改选：再点另一选项 = 覆盖留痕（decidedAt 刷新，不锁死）
  const beforeAt = dp1.decidedAt
  d1 = tasks.decidePlanPoint(r.id, 'dp_001', '端口=配置项')
  g2 = tasks.getPlan(r.id)
  const dp1b = g2.plan.decisions.find(x => x.id === 'dp_001')
  check('改选覆盖留痕（chosen 更新、decidedAt 不早于上次）',
    d1.ok === true && dp1b.chosen === '端口=配置项' && Date.parse(dp1b.decidedAt) >= Date.parse(beforeAt),
    `chosen=${dp1b.chosen}`)

  d1 = tasks.decidePlanPoint(r.id, 'dp_002', '周五')
  check('决策点 2 选定成功', d1.ok === true, JSON.stringify(d1))
  g2 = tasks.getPlan(r.id)
  check('★ 决策点全定完 → 规划自动 draft→active，任务状态 草稿→进行中',
    g2.plan.status === 'active' && g2.task.fm.plan_status === 'active' && g2.task.fm.status === '进行中',
    `plan=${g2.plan.status} task=${g2.task.fm.status}`)

  // 边界：坏 id / 坏 dpId / 非 plan 任务
  check('坏任务 id → ok:false + 人话报错', (() => { const x = tasks.decidePlanPoint('no-such-plan', 'dp_001', 'a'); return x.ok === false && /任务不存在/.test(x.error) })())
  check('坏决策点 id → ok:false + 指名报错', (() => { const x = tasks.decidePlanPoint(r.id, 'dp_999', 'a'); return x.ok === false && /决策点 dp_999 不存在/.test(x.error) })())
  const t = tasks.createPlan({ title: '无决策点规划', project: 'demo' })
  check('无决策点的规划也能建（目标+里程碑空壳）', !!t.id && tasks.getPlan(t.id).plan.decisions.length === 0)
  const t2 = tasks.createTask({ title: '普通任务卡' })
  check('对非 plan 任务调 decidePlanPoint → ok:false + 「不是规划任务」',
    (() => { const x = tasks.decidePlanPoint(t2.id, 'dp_001', 'a'); return x.ok === false && /不是规划任务/.test(x.error) })())

  // ── 往返：决策点状态序列化后仍可解析（renderPlanBody→parsePlanFromTask）──
  const again = tasks.getPlan(r.id)
  check('选完再读：两个决策点都 decided、chosen 不串位',
    again.plan.decisions.every(x => x.status === 'decided')
    && again.plan.decisions.find(x => x.id === 'dp_001').chosen === '端口=配置项'
    && again.plan.decisions.find(x => x.id === 'dp_002').chosen === '周五',
    JSON.stringify(again.plan.decisions.map(x => `${x.id}:${x.chosen}`)))

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (failures.length) {
    console.log('失败项：' + failures.join('、'))
    process.exit(1)
  }
}

try {
  main()
} catch (e) {
  console.error('测试脚本异常：', e)
  process.exit(1)
}
