#!/usr/bin/env node
/**
 * 随纠（一句话改项目方向）测试（2026-10-22 · 施工单包 03 任务二）
 *
 * 真跑编译产物 `dist/main/services/correct.js` + **临时数据目录**（不碰真实 registry / 决策卡）。
 *
 * 这套钉的是「纠得动」的三个前提：
 *   ★ 只认**三种固定句式** —— 认不出就明说认不出（零写入），绝不猜一个方向出来改掉
 *   ★ 改完**必须留痕** —— 决策卡里有「谁 / 何时 / 从什么改成什么」，出处标「方寸随纠」
 *   ★ **一步退得回** —— 撤销把字段写回旧值，并且把那张决策卡一并标「已撤销」
 *     （只改回字段却留着"已定案"的卡，等于在台账上写假话）
 *
 * 另有两条反例自证：
 *   · 认不出的句子 → registry 一个字节没变、决策卡一条没多
 *   · 改成和现在一样 → 拒绝，且**不产生**一张"改成原值"的垃圾决策卡
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const Module = require('module')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'correct-e2e-'))
const DATA = path.join(TMP, 'data')
const USERDATA = path.join(TMP, 'userdata')
process.env.FC_TEST_USERDATA = USERDATA
for (const d of [DATA, USERDATA]) fs.mkdirSync(d, { recursive: true })
fs.mkdirSync(path.join(DATA, 'task-data'), { recursive: true })

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const REG = path.join(DATA, 'registry.yaml')
const REG_YAML = [
  'members: []',
  'projects:',
  '  - id: fc-demo',
  '    name: 方寸演示',
  '    tasks: ""',
  '    repo: E:/x/a',
  '    tools: []',
  '    sources: []',
  '    状态: 活跃开发中',
  '    路线图: 旧路线',
  '    说明: 欠着：①旧欠账',
  '  - id: second',
  '    name: 第二个项目',
  '    tasks: ""',
  '    repo: E:/x/b',
  '    tools: []',
  '    sources: []',
  '    状态: 内容创作期',
  '',
].join('\n')
fs.writeFileSync(REG, REG_YAML, 'utf-8')

const data = require(path.join(DIST, 'data', 'index.js'))
data.setDataDir(DATA)
const decisions = require(path.join(DIST, 'data', 'decisions.js'))
const correct = require(path.join(DIST, 'services', 'correct.js'))

let PASS = 0
const FAILS = []
function check(name, cond, detail) {
  if (cond) { PASS++; console.log('PASS  ' + name) }
  else { FAILS.push(name); console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')) }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const raw = () => fs.readFileSync(REG, 'utf-8')
const proj = (id) => data.parseRegistry(true).find((p) => String(p.id) === id)
const cardCount = () => decisions.loadDecisions().length

console.log('---- 1. 三种句式都要认 ----')
const p1 = correct.parseCorrection('改 路线图 为 跑通第一单', 'fc-demo')
check('「改 <字段> 为 <值>」+ 项目由查询结果带进来 → 认得出', p1.ok, p1.error)
check('  解析出的是真字段名与目标值（别名已归一）',
  p1.field === '路线图' && p1.to === '跑通第一单', JSON.stringify({ f: p1.field, to: p1.to }))
const p2 = correct.parseCorrection('把 第二个项目 的 状态 改成 已挂起（10-22）')
check('「把 <项目> 的 <字段> 改成 <值>」→ 认得出且指明项目',
  p2.ok && p2.projectId === 'second' && p2.field === '状态' && p2.to === '已挂起（10-22）',
  JSON.stringify(p2))
const p3 = correct.parseCorrection('改 欠着 为 欠着：①新欠账 ②第二件', 'fc-demo')
check('别名「欠着」→ 落到 registry 的「说明」字段',
  p3.ok && p3.field === '说明' && p3.to === '欠着：①新欠账 ②第二件', JSON.stringify(p3))
const p4 = correct.parseCorrection('改 目标 = 第一本真书试产', 'fc-demo')
check('别名「目标」→ 路线图；`=` 也当连接词', p4.ok && p4.field === '路线图', JSON.stringify(p4))
check('回执是人话（说清哪个项目哪个字段：从什么到什么）',
  p1.ok && p1.echo.indexOf('方寸演示') >= 0 && p1.echo.indexOf('旧路线') >= 0 && p1.echo.indexOf('跑通第一单') >= 0,
  p1.ok ? p1.echo : '')

console.log('\n---- 2. 认不出就明说认不出（零写入） ----')
const snapReg = sha(fs.readFileSync(REG))
const snapCards = cardCount()
const bad1 = correct.applyCorrection('把方寸演示改成更积极一点的样子', 'fc-demo')
check('没有字段名 → 显式报错（不猜是改哪个字段）', bad1.ok === false, bad1.error)
check('报错把能改的三个字段摆出来（教一句比骂一句有用）',
  /状态|路线图|说明/.test(bad1.error || ''), bad1.error)
const bad2 = correct.applyCorrection('改 心情 为 很好', 'fc-demo')
check('不认识的字段名 → 显式报错', bad2.ok === false, bad2.error)
const bad3 = correct.applyCorrection('改 状态 为', 'fc-demo')
check('目标值为空 → 显式报错（清空字段不算纠偏）', bad3.ok === false, bad3.error)
const bad4 = correct.applyCorrection('改 状态 为 随便什么', 'not-exist')
check('项目不存在 → 显式报错', bad4.ok === false, bad4.error)
const bad5 = correct.applyCorrection('改 状态 为 随便什么')
check('句子没点名项目且调用方也没给 → 报错（不许默认成第一个项目）', bad5.ok === false, bad5.error)
check('★★ 以上五次失败：registry 一个字节没变', sha(fs.readFileSync(REG)) === snapReg)
check('★★ 以上五次失败：决策卡一条没多（失败的操作不留痕，因为没发生过）',
  cardCount() === snapCards, `${snapCards} → ${cardCount()}`)

console.log('\n---- 3. 改成功：字段 + 决策卡都动 ----')
const r1 = correct.applyCorrection('改 路线图 为 跑通第一单', 'fc-demo')
check('改成功', r1.ok, r1.error)
check('★ registry 里真的变了（读回）', proj('fc-demo')['路线图'] === '跑通第一单', String(proj('fc-demo')['路线图']))
check('★ 回传 before = 改之前的旧值（撤销要用它）', r1.before === '旧路线', String(r1.before))
check('★ 回传了决策卡 id（撤销时要连它一起标已撤销）', !!r1.decisionId, String(r1.decisionId))
const cards = decisions.loadDecisions()
const c1 = cards.find((c) => c.id === r1.decisionId)
check('★★ 决策卡真写了：内容含项目名 + 字段 + 从什么到什么',
  !!c1 && c1.内容.indexOf('方寸演示') >= 0 && c1.内容.indexOf('旧路线') >= 0 && c1.内容.indexOf('跑通第一单') >= 0,
  c1 && c1.内容)
check('★ 决策卡标明出处「方寸随纠」（看得出是随口改的，不是群里拍板的）',
  !!c1 && c1.出处 === '方寸随纠', c1 && c1.出处)
check('★ 决策卡归属那个项目（决策页能按项目筛）', !!c1 && c1.项目 === 'fc-demo', c1 && c1.项目)
check('★ 决策卡初始状态是「有效」', !!c1 && c1.状态 === '有效', c1 && c1.状态)
check('  决策卡有日期（谁/何时/改了什么，三件齐全）', !!c1 && /^\d{4}-\d{2}-\d{2}$/.test(String(c1.日期)), c1 && c1.日期)

console.log('\n---- 4. 一步退得回：字段回去 + 决策卡标已撤销 ----')
const undo = correct.undoCorrection({ projectId: 'fc-demo', field: '路线图', before: r1.before, decisionId: r1.decisionId })
check('撤销成功', undo.ok, undo.error)
check('★ 字段回到旧值（读回）', proj('fc-demo')['路线图'] === '旧路线', String(proj('fc-demo')['路线图']))
const c1b = decisions.loadDecisions().find((c) => c.id === r1.decisionId)
check('★★ 决策卡同步标成「已撤销」（不留一张"已定案"的假卡在台账上）',
  !!c1b && c1b.状态 === '已撤销', c1b && c1b.状态)
check('★ 撤销原因记在备注里（看得出是撤销条撤回的）',
  !!c1b && String(c1b.备注 || '').indexOf('撤回') >= 0, c1b && c1b.备注)
const undoBad = correct.undoCorrection({ projectId: 'fc-demo', field: '不存在的字段', before: 'x' })
check('撤销传非法字段 → 显式报错', undoBad.ok === false, undoBad.error)

console.log('\n---- 5. 反例：改成和现在一样 → 拒绝且不留垃圾决策卡 ----')
const sameBefore = cardCount()
const same = correct.applyCorrection('改 路线图 为 旧路线', 'fc-demo')
check('同值 → 显式拒绝（不是"成功但什么都没做"）', same.ok === false, same.error)
check('★ 决策卡一条没多（不许给"改成原值"留痕，那是噪音）', cardCount() === sameBefore, `${sameBefore} → ${cardCount()}`)

console.log('\n---- 6. 特殊字符的值（含冒号 / 分号 / 引号）能原样落盘并读回 ----')
const tricky = '第一本真书试产；前置三件："模型通道"→模板确认'
const r2 = correct.applyCorrection('改 路线图 为 ' + tricky, 'fc-demo')
check('含特殊字符的改动成功', r2.ok, r2.error)
check('★ 读回逐字相等（YAML 转义由 updateProjectFields 负责）',
  proj('fc-demo')['路线图'] === tricky, JSON.stringify(proj('fc-demo')['路线图']))
check('★ 决策卡里也是原文（留痕不能是截断版）',
  (decisions.loadDecisions().find((c) => c.id === r2.decisionId) || {}).内容.indexOf(tricky) >= 0,
  (decisions.loadDecisions().find((c) => c.id === r2.decisionId) || {}).内容)
correct.undoCorrection({ projectId: 'fc-demo', field: '路线图', before: r2.before, decisionId: r2.decisionId })

console.log('\n---- 7. 带项目名的句子不会改错项目 ----')
const before2 = proj('second')['状态']
const r3 = correct.applyCorrection('把方寸演示的状态改成 已挂起', 'second')
check('★ 句子点名了「方寸演示」，即使调用方给的是 second，也按句子走',
  r3.ok && r3.projectId === 'fc-demo', JSON.stringify({ ok: r3.ok, pid: r3.projectId, err: r3.error }))
check('★ second 没被误改', proj('second')['状态'] === before2, String(proj('second')['状态']))
correct.undoCorrection({ projectId: 'fc-demo', field: '状态', before: '活跃开发中', decisionId: r3.decisionId })

console.log('\n---- 8. 只在「改」时才写盘：preview 零副作用 ----')
const snap2 = sha(fs.readFileSync(REG))
const n2 = cardCount()
correct.parseCorrection('改 路线图 为 随便什么', 'fc-demo')
correct.parseCorrection('把方寸演示的状态改成 X')
check('★ parseCorrection（预览）不写 registry', sha(fs.readFileSync(REG)) === snap2)
check('★ parseCorrection（预览）不写决策卡', cardCount() === n2)

console.log(`\n==== ${PASS} 通过 / ${FAILS.length} 失败 ====`)
if (FAILS.length) { FAILS.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1) }
