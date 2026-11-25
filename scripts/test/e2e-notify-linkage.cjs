#!/usr/bin/env node
/**
 * 通知联动补齐（2026-11-11 · 0.7.0 规划根基）—— 计划草案 / 结构地图久未核实
 *
 * 为什么补这两类：它们是“**你不点，整条链就停住**”的那种提醒。
 *   · 草案：agent 在那边落盘，用户根本不知道多了一份；不提成阶段卡它就永远只是一份文件。
 *   · 结构地图：写着的「最后核实」太久远，读者会**以为它还是对的** —— 这比没有地图更危险。
 *
 * 判据（逐条钉，含反例）：
 *   ① 有可提格的草案 → 一条 plan-draft；**缺块的那种不提示**（提示了只会让人白点）；
 *   ② 结构地图 > 90 天 → 一条 structmap-stale，**文案必须说“没核实”，不能说“结构已经变了”**
 *     （后者要 git 比对，扫描器里不做，替用户下结论就是假账）；
 *   ③ 幂等：同一状态反复扫不重复弹；草案被删 / 地图更新 → **自动消解**；
 *   ④ 不误伤：问卷待答这类老类型照常工作。
 *
 * 运行：node scripts/test/e2e-notify-linkage.cjs
 */
const path = require('path')
const fs = require('fs')
const Module = require('module')
const { mkTmpPath } = require('./_tmp.cjs')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = mkTmpPath('fc-notify-link-')
process.env.FC_TEST_USERDATA = TEST_ROOT
const DATA = path.join(TEST_ROOT, 'data')
const TASK = path.join(DATA, 'task-data')
const PLANS = path.join(TASK, 'plans')
const DRAFTS = path.join(PLANS, '_drafts')
const QDIR = path.join(TASK, 'questionnaires')
for (const d of [DATA, TASK, PLANS, DRAFTS, QDIR, path.join(DATA, 'policies')]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(DATA, 'registry.yaml'),
  'projects:\n  - id: demo\n    name: 演示项目\n    repo: .\n  - id: fresh\n    name: 新项目\n    repo: .\n', 'utf-8')

const DIST = path.resolve(__dirname, '../../desktop/dist/main')
const data = require(path.join(DIST, 'data', 'index.js'))
data.setDataDir(DATA)
const notifier = require(path.join(DIST, 'services', 'notifier.js'))
const notifications = require(path.join(DIST, 'services', 'notifications.js'))
const policies = require(path.join(DIST, 'services', 'policies.js'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}
const ofType = (t) => notifications.listNotifications().filter((n) => n.type === t)

// ── 夹具：一份「可提」的草案 + 一份「缺块」的草案 ─────────────────────────
const DRAFT_OK = [
  '# demo · 作战计划（方寸起草草案）',
  '',
  '- 状态: 待裁决',
  '',
  '## 阶段卡',
  '',
  '### P20 · 可提的那一格',
  '',
  '- 技术方案:',
  '  - 写点东西',
  '',
  '- 照抄点:',
  '',
  '| 项 | 来源 | 原文 |',
  '|---|---|---|',
  '| A | B | C |',
  '',
  '- 判据:',
  '  - cmd: echo ok',
  '',
].join('\n')
const DRAFT_MISSING = [
  '# demo · 作战计划（方寸起草草案·缺块版）',
  '',
  '## 阶段卡',
  '',
  '### P21 · 只有技术方案',
  '',
  '- 技术方案:',
  '  - 别的什么都没写',
  '',
].join('\n')
fs.writeFileSync(path.join(DRAFTS, 'demo-2026-11-11.md'), DRAFT_OK, 'utf-8')
fs.writeFileSync(path.join(DRAFTS, 'demo-缺块.md'), DRAFT_MISSING, 'utf-8')

// ── 夹具：结构地图（旧日期 / 新日期 / 没填日期）──────────────────────────
function writePolicy(id, mapLine) {
  policies.savePolicy({
    projectId: id, mission: '', goal: '', scenario: '', boundary: '',
    structureMap: `> 最后核实：${mapLine}\n\n- 模块清单：x\n- 主数据流：y`,
    updatedAt: new Date().toISOString(),
  })
}
writePolicy('demo', '2026-01-01')          // 太久远 → 该提示
writePolicy('fresh', new Date().toISOString().slice(0, 10))  // 今天 → 不该提示

// ── 夹具：一条「已完成且过了保留期」的日志（「清理超期」按钮一直要人主动去点）──
const LOGDIR = path.join(DATA, 'docs', '执行日志')
fs.mkdirSync(LOGDIR, { recursive: true })
fs.writeFileSync(path.join(LOGDIR, 'log-demo-retain.md'), [
  '---',
  'id: log-demo-retain',
  'title: 过保留期的演示日志',
  'status: completed',
  'completed: 2026-01-01T00:00:00.000Z',
  'retain_until: 2026-01-31T00:00:00.000Z',
  '---',
  '',
  '正文：用来验「日志过保留期」这条通知。',
  '',
].join('\n'), 'utf-8')

console.log('== ① 计划草案待提成 ==')
const r1 = notifier.scanOnce(new Date())
const drafts1 = ofType('plan-draft')
check('★★ 有可提格的草案 → 一条 plan-draft（草案才不会“落盘即失踪”）',
  drafts1.length === 1 && drafts1[0].sourceId === 'demo-2026-11-11.md',
  JSON.stringify(drafts1.map((n) => n.sourceId)))
check('★★ 缺块的那份**不提示**（提不了的东西提示了只会让人白点）',
  !drafts1.some((n) => /缺块/.test(n.sourceId || '')), JSON.stringify(drafts1.map((n) => n.sourceId)))
check('★ 文案说清“几格齐全、去哪点”（不是一句“有草案”）',
  /格/.test(drafts1[0].body || '') && /作战计划/.test(drafts1[0].body || ''), drafts1[0] && drafts1[0].body)
check('★ 级别是 info（不抢注意力）+ 只进面板不弹系统通知（osNotify:false 写死在推送处）',
  drafts1[0] && drafts1[0].level === 'info'
  && /type: 'plan-draft',\s*level: 'info',\s*osNotify: false/.test(
    fs.readFileSync(path.resolve(__dirname, '../../desktop/src/main/services/notifier.ts'), 'utf-8')),
  JSON.stringify({ level: drafts1[0] && drafts1[0].level }))

console.log('\n== ② 结构地图久未核实 ==')
const maps1 = ofType('structmap-stale')
check('★★ 90 天没核实的项目 → 一条 structmap-stale', maps1.length === 1 && maps1[0].sourceId === 'demo',
  JSON.stringify(maps1.map((n) => n.sourceId)))
check('★★ 刚核实过的项目不提示（不是按“有没有地图”判断）',
  !maps1.some((n) => n.sourceId === 'fresh'), JSON.stringify(maps1.map((n) => n.sourceId)))
check('★★ 文案只说“没核实”，**不许**说“结构已经变了”（扫描器没做 git 比对，不许替用户下结论）',
  /没核实/.test(maps1[0].title || '') && !/结构.*已经?变了/.test((maps1[0].title || '') + (maps1[0].body || '')),
  (maps1[0] && maps1[0].title) + ' | ' + (maps1[0] && maps1[0].body))
check('★ key 里带最后核实日期（日期一改就是“新一轮”，会再提醒一次）',
  /2026-01-01/.test(maps1[0].key || ''), String(maps1[0] && maps1[0].key))

console.log('\n== ③ 幂等 / 消解 ==')
const again = notifier.scanOnce(new Date())
check('★ 同一状态再扫一次：两条都不重复弹（created 里不计它们）',
  again.newNotifications === 0, JSON.stringify(again))
fs.unlinkSync(path.join(DRAFTS, 'demo-2026-11-11.md'))
writePolicy('demo', new Date().toISOString().slice(0, 10))
const r3 = notifier.scanOnce(new Date())
check('★★ 草案被删 / 地图更新 → **自动消解**（不留僵尸条目）',
  ofType('plan-draft').length === 0 && ofType('structmap-stale').length === 0,
  'plan-draft=' + ofType('plan-draft').length + ' structmap=' + ofType('structmap-stale').length)
check('★ 消解计入返回值的 resolved（不是静默消失）', r3.resolved >= 2, JSON.stringify(r3))

console.log('\n== ④ 日志过保留期 ==')
{
  const logs1 = ofType('log-retention')
  check('★★ 已完成且过了 retain_until → 一条 log-retention（“清理超期”一直要人主动点）',
    logs1.length === 1 && logs1[0].sourceId === 'logs', JSON.stringify(logs1.map((n) => n.sourceId)))
  check('★ 文案说清几条 + 最早那条 + 去点哪个按钮',
    /1 条/.test(logs1[0].title || '') && /清理超期/.test(logs1[0].body || ''),
    (logs1[0] && logs1[0].title) + ' | ' + (logs1[0] && logs1[0].body))
  // 清干净（把它标成 archived）→ 下一次扫描自动消解
  fs.writeFileSync(path.join(LOGDIR, 'log-demo-retain.md'),
    fs.readFileSync(path.join(LOGDIR, 'log-demo-retain.md'), 'utf-8').replace('status: completed', 'status: archived'), 'utf-8')
  notifier.scanOnce(new Date())
  check('★ 清完（archived）→ 自动消解，不挂僵尸条目', ofType('log-retention').length === 0,
    String(ofType('log-retention').length))
}

console.log('\n== ⑤ 反问 / 已批准未落卡 ==')
{
  // 反问：这题问错了，要重出题 —— 不处理它就永远搁在那儿
  fs.writeFileSync(path.join(QDIR, 'demo-反问.answers.json'), JSON.stringify({
    deck: 'demo-反问',
    answers: { A1: { kind: 'askback', text: '这题问错了，真问题在别处' } },
    approvedAt: '', updatedAt: new Date().toISOString(), voidedAt: '', audits: {},
  }), 'utf-8')
  // 已批准 4 天、但一条交付都没有
  const old = new Date(Date.now() - 4 * 86400000).toISOString()
  fs.writeFileSync(path.join(QDIR, 'demo-批准未落卡.answers.json'), JSON.stringify({
    deck: 'demo-批准未落卡',
    answers: { A1: { kind: 'pick', k: 'A' } },
    approvedAt: old, updatedAt: old, voidedAt: '', audits: {}, deliveries: {},
  }), 'utf-8')
  notifier.scanOnce(new Date())
  const back = ofType('deck-askback')
  check('★★ 卷里有反问 → 一条 deck-askback（不处理它，依赖它的规划/派工单一动不动）',
    back.length === 1 && back[0].sourceId === 'demo-反问', JSON.stringify(back.map((n) => n.sourceId)))
  check('★ 反问通知说清几题 + 去哪处理（复制「打包成补代价」给 agent 重出题）',
    /1 题/.test(back[0].body || '') && /重出/.test(back[0].body || ''), back[0] && back[0].body)
  const und = ofType('deck-undelivered')
  check('★★ 批准 3 天以上、一条交付都没有 → 一条 deck-undelivered（决策躺着没人用）',
    und.length === 1 && und[0].sourceId === 'demo-批准未落卡', JSON.stringify(und.map((n) => n.sourceId)))
  check('★ 刚批准的不催（3 天内不提示）', (() => {
    fs.writeFileSync(path.join(QDIR, 'demo-刚批准.answers.json'), JSON.stringify({
      deck: 'demo-刚批准', answers: { A1: { kind: 'pick', k: 'B' } },
      approvedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), voidedAt: '', audits: {}, deliveries: {},
    }), 'utf-8')
    notifier.scanOnce(new Date())
    return !ofType('deck-undelivered').some((n) => n.sourceId === 'demo-刚批准')
  })())
  // 清干净（作废）→ 自动消解
  for (const d of ['demo-反问', 'demo-批准未落卡']) {
    const p = path.join(QDIR, d + '.answers.json')
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'))
    j.voidedAt = new Date().toISOString()
    fs.writeFileSync(p, JSON.stringify(j), 'utf-8')
  }
  notifier.scanOnce(new Date())
  check('★ 作废后两条都自动消解', ofType('deck-askback').length === 0 && ofType('deck-undelivered').length === 0,
    `askback=${ofType('deck-askback').length} undelivered=${ofType('deck-undelivered').length}`)
}

console.log('\n== ⑥ 不误伤老类型 ==')
fs.writeFileSync(path.join(QDIR, 'demo-宪法层.md'), [
  '**项目**：demo', '', '## A1 甲', '关于甲要怎么定？',
  '- **A. 要**——代价甲', '- **B. 不要**——代价乙', '【验收线】出现反例即违约', '',
].join('\n'), 'utf-8')
notifier.scanOnce(new Date())
check('★★ 问卷待答照常提示（新类型没把老扫描挤掉）',
  ofType('questionnaire-pending').length === 1, String(ofType('questionnaire-pending').length))

console.log('\n== ⑥ 源码守卫 ==')
{
  const src = fs.readFileSync(path.resolve(__dirname, '../../desktop/src/main/services/notifier.ts'), 'utf-8')
  check('★★ 结构地图扫描**不调 git**（60 秒一次，不许把主进程拖住）',
    !/scanStructMap[\s\S]{0,3000}?structureDrift\(/.test(src), '')
  check('★ 三个新扫描都接进 scanOnce（不是写了没调用）',
    /scanPlanDrafts\(\)/.test(src) && /scanStructMap\(\)/.test(src) && /scanLogRetention\(\)/.test(src)
    && /created \+= c\.created/.test(src))
  check('★ 草案扫描失败不静默（appLog.warn）', /计划草案扫描失败/.test(src))
  // 技能漂移：**不许自己写一套 md5 比对** —— 与设置页共用 checkSkillsStatus
  check('★★ 技能漂移扫描复用 `checkSkillsStatus`（不另写一套 md5 比对，免得两处口径分叉）',
    /skillInstaller\.checkSkillsStatus\(/.test(src) && !/createHash\('md5'\)/.test(src))
  check('★ 反问 / 已批准未落卡 / 技能漂移都接进了 scanOnce',
    /scanDeckAskback\(\)/.test(src) && /scanDeckUndelivered\(\)/.test(src) && /scanSkillDrift\(\)/.test(src))
}

console.log('\n== ⑧ 「该谁做」：AI 自己的活不许再弹给人（2026-11-24）==')
// 暮雨原话：「这种弹出来让人什么都做不了的通知有什么意义？本来就是 AI 自己的问题，
//            要弹也是去弹给 AI 看」。
//
// 判据四条：
//   ① 那四类（卷批准没落卡 / 草案没提成 / 技能副本落后 / 反问待重出题）必须标 owner=agent；
//   ② 人真的能动手的那些（等你拍板 / 备份失败 / 解析失败 / 问卷待答 / 记忆待审批）**必须仍是 user**
//      —— 这条是反例方向：把“该人拍板”的也归给 agent = 把人该看的静音掉，比噪音更糟；
//   ③ agent 的活**不许从库里消失**（它要进派单任务书，删了就等于没人知道）；
//   ④ 派单任务书里必须真有那一节（否则“弹给 AI 看”就是空话）。
{
  const AGENT_OWNED = ['deck-undelivered', 'deck-askback', 'plan-draft', 'skill-drift']
  const USER_OWNED = ['task-review', 'backup-failed', 'parse-error', 'questionnaire-pending', 'memory-pending', 'task-deadline']

  // 重新造一批 agent 的活（上一节已把卷作废消解掉了）
  const Q2 = path.join(QDIR, 'demo-owner.answers.json')
  fs.writeFileSync(Q2, JSON.stringify({
    deck: 'demo-owner',
    answers: { A1: { kind: 'askback', text: '这题问错了' } },
    approvedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    updatedAt: new Date().toISOString(), voidedAt: '', audits: {}, deliveries: {},
  }), 'utf-8')
  notifier.scanOnce(new Date())

  const all = notifications.listNotifications()
  const agentRows = all.filter((n) => AGENT_OWNED.includes(n.type))
  check('★★ 四类「AI 的活」都标了 owner=agent（卷批准未落卡 / 反问 / 草案 / 技能副本）',
    agentRows.length > 0 && agentRows.every((n) => n.owner === 'agent'),
    agentRows.map((n) => n.type + '=' + n.owner).join(','))

  // 反例方向：这些人必须做的事，绝不能被归给 agent
  const userPushed = all.filter((n) => USER_OWNED.includes(n.type))
  check('★★ 反例：该「人」拍板/处理的类型没有被误标成 agent（误标 = 把人该看的静音掉）',
    userPushed.every((n) => n.owner !== 'agent'),
    userPushed.map((n) => n.type + '=' + n.owner).join(','))

  check('★★ 缺省 owner 是 user（老类型/新代码忘了标，也不会被悄悄折起）',
    all.filter((n) => n.owner === undefined || n.owner === 'user').length > 0
    && notifications.listNotifications().every((n) => n.owner === 'user' || n.owner === 'agent'),
    JSON.stringify([...new Set(all.map((n) => n.owner))]))

  check('★★ agent 的活仍在库里（折起 ≠ 删除：它要进派单任务书，也要能随时看全）',
    agentRows.length > 0, String(agentRows.length))

  // 派单任务书里必须有那一节 —— 否则“弹给 AI 看”是空话
  const cp = fs.readFileSync(path.resolve(__dirname, '../../desktop/src/main/services/contextPack.ts'), 'utf-8')
  check('★★ 派单任务书带上了「该 AI 做、还没人做」那一节（弹给 AI 看的真管子）',
    /## 6b\. 方寸手上挂着/.test(cp) && /owner === 'agent'/.test(cp))

  // 界面侧：默认折起 + 有开关（折起而没有开关 = 条目被藏死）
  const ui2 = fs.readFileSync(path.resolve(__dirname, '../../desktop/src/renderer/composables/useNotifications.ts'), 'utf-8')
  const nc2 = fs.readFileSync(path.resolve(__dirname, '../../desktop/src/renderer/components/NotificationCenter.vue'), 'utf-8')
  check('★★ 界面默认只列「你能动手」的（owner=agent 默认不进列表）',
    /ncShowAgent\.value\s*\|\|\s*!isAgentOwned\(n\)/.test(ui2)
    && /if \(!ncShowAgent\.value && isAgentOwned\(n\)\) return false/.test(ui2))
  check('★★ 折叠有唯一出口（面板上有开关，不是把它们藏死）',
    /ncShowAgent/.test(nc2) && /也看 AI 的活/.test(nc2))
  check('★★ 折起的条目**不计未读**（否则角标照样天天红）',
    /countsUnread/.test(ui2) && /ncShowAgent\.value \|\| !isAgentOwned\(n\)/.test(ui2))
}

console.log('\n== ⑨ 重复扫描不许把旧通知顶成“刚刚”（2026-11-24）==')
// 现场：一条 createdAt=11-12 的通知，updatedAt 是 11-24 —— 因为 pushNotification
// 对已存在的条目**无条件**刷 updatedAt，60 秒一轮扫描把它们一起顶到列表最前面。
// 用户看到的就是“没用的通知天天挂着”。
{
  const before = notifier.scanOnce(new Date())
  const snap = notifications.listNotifications().map((n) => ({ id: n.id, u: n.updatedAt, c: n.createdAt }))
  notifier.scanOnce(new Date())
  notifier.scanOnce(new Date())
  const after = notifications.listNotifications()
  const moved = after.filter((n) => {
    const b = snap.find((x) => x.id === n.id)
    return b && b.u !== n.updatedAt
  })
  check('★★ 连扫两轮，没有任何一条的 updatedAt 被刷（内容没变就不该变“刚刚”）',
    moved.length === 0, moved.map((n) => n.type + '=' + n.title).join(','))

  check('★★ 排序锚仍在（列表按 updatedAt 倒序，未读/已读分区不受影响）',
    after.length === 0 || after.every((n, i) => i === 0 || after[i - 1].updatedAt >= n.updatedAt),
    JSON.stringify(after.slice(0, 3).map((n) => n.updatedAt)))
}

console.log('\n== ⑦ 界面侧：新类型必须有标签、有落点（否则面板显示裸 type 名 / 点了没反应）==')
{
  const ui = fs.readFileSync(path.resolve(__dirname, '../../desktop/src/renderer/composables/useNotifications.ts'), 'utf-8')
  const app = fs.readFileSync(path.resolve(__dirname, '../../desktop/src/renderer/App.vue'), 'utf-8')
  check('★★ 两种新类型都有中文标签（不信“渲染层会兜底”：兜底就是裸 type 名）',
    /'plan-draft':\s*\{[^}]*label: '草案待提成'/.test(ui)
    && /'structmap-stale':\s*\{[^}]*label: '结构地图该核实'/.test(ui))
  check('★★ 两种新类型都有可跳目标（行尾箭头与点击落点同源，不会“箭头亮着点了没反应”）',
    /t === 'plan-draft'\) return/.test(ui) && /t === 'structmap-stale'\) return/.test(ui))
  check('★★ 点击真的会走到对应入口（草案 → 作战计划；地图 → 结构地图弹窗）',
    /ctx\.openPlanDrafts\(/.test(ui) && /ctx\.openStructMap\(/.test(ui))
  check('★ App.vue 把这两个入口接上了（不是只声明在类型里）',
    /openPlanDrafts:\s*async/.test(app) && /openStructMap:\s*\(\)\s*=>/.test(app))
  check('★★ 日志可清理也有标签 + 落点（切到日志页，那里才有「清理超期」）',
    /'log-retention':\s*\{[^}]*label: '日志可清理'/.test(ui)
    && /t === 'log-retention'\) return/.test(ui) && /navigateTo\('logs'\)/.test(ui))
  check('★★ 反问 / 已批准未落卡 / 技能漂移三类也都有标签 + 落点',
    /'deck-askback':\s*\{[^}]*label: '问卷有反问'/.test(ui)
    && /'deck-undelivered':\s*\{[^}]*label: '已批准未落卡'/.test(ui)
    && /'skill-drift':\s*\{[^}]*label: '技能副本落后'/.test(ui)
    && /ctx\.openQuestionnaire\(String\(n\.sourceId/.test(ui)
    && /t === 'skill-drift'\) \{ ctx\.openSettings\(\)/.test(ui))
}

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`通过 ${pass} / 失败 ${fail}`)
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
