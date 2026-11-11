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

console.log('\n== ④ 不误伤老类型 ==')
fs.writeFileSync(path.join(QDIR, 'demo-宪法层.md'), [
  '**项目**：demo', '', '## A1 甲', '关于甲要怎么定？',
  '- **A. 要**——代价甲', '- **B. 不要**——代价乙', '【验收线】出现反例即违约', '',
].join('\n'), 'utf-8')
notifier.scanOnce(new Date())
check('★★ 问卷待答照常提示（新类型没把老扫描挤掉）',
  ofType('questionnaire-pending').length === 1, String(ofType('questionnaire-pending').length))

console.log('\n== ⑤ 源码守卫 ==')
{
  const src = fs.readFileSync(path.resolve(__dirname, '../../desktop/src/main/services/notifier.ts'), 'utf-8')
  check('★★ 结构地图扫描**不调 git**（60 秒一次，不许把主进程拖住）',
    !/scanStructMap[\s\S]{0,3000}?structureDrift\(/.test(src), '')
  check('★ 两个新扫描都接进 scanOnce（不是写了没调用）',
    /scanPlanDrafts\(\)/.test(src) && /scanStructMap\(\)/.test(src) && /created \+= a\.created/.test(src))
  check('★ 草案扫描失败不静默（appLog.warn）', /计划草案扫描失败/.test(src))
}

console.log('\n== ⑥ 界面侧：新类型必须有标签、有落点（否则面板显示裸 type 名 / 点了没反应）==')
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
}

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`通过 ${pass} / 失败 ${fail}`)
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
