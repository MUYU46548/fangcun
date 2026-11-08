#!/usr/bin/env node
/**
 * MCP 只读口：决策 / 项目方针（含结构地图）/ 作战计划三块（2026-11-08 暮雨拍板）
 *
 * 原话：“开只读口（后续 AI 可写）”。
 *
 * 为什么这三样值得单开一个套件：它们是**决定 AI 该不该动手**的依据 —— 已经定过什么、
 * 这个项目的边界在哪、这一格的技术方案与判据是什么。此前 MCP 一个字都读不到，
 * 于是“决策 / 方针 / 结构地图形同虚设”不是 AI 懒，是它没有入口。
 *
 * 本套件钉三件事：
 *   ① 读得到，且**读得对**（项目 / 状态 / 关键词过滤都真生效，不串行）；
 *   ② 缺什么**明说**（没方针 = 报错；有方针但缺结构地图 = 进 missingSections），
 *      绝不返回空对象让 agent 以为“这个项目很干净”；
 *   ③ **只读**（源码守卫：这三个 case 里不许出现任何写入函数）——
 *      “后续 AI 可写”还没来，先别让读口悄悄长出写能力。
 *
 * ⚠ 真跑编译产物 dist/main，临时数据根，不碰真实 task-data。
 */

const fs = require('fs')
const path = require('path')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const TMP = mkTmp('mcp-context-')
const DATA = path.join(TMP, 'data')
fs.mkdirSync(path.join(DATA, 'task-data', 'plans'), { recursive: true })
fs.mkdirSync(path.join(DATA, 'policies'), { recursive: true })

fs.writeFileSync(path.join(DATA, 'registry.yaml'), [
  'members: []',
  'projects:',
  '  - id: demo',
  '    name: 演示项目',
  '  - id: demo-nocharter',
  '    name: 没方针的项目',
  '  - id: demo-nomap',
  '    name: 方针缺结构地图的项目',
  '  - id: demo-skeleton',
  '    name: 结构地图只有骨架的项目',
  'released: []',
  '',
].join('\n'), 'utf-8')

// ── 决策夹具：三条（有效 / 已撤销 / 别的项目），过滤才有得验 ──────────────
fs.writeFileSync(path.join(DATA, 'task-data', 'decisions.md'), [
  '# 决策记录（决策卡）',
  '',
  '## D-001 一期只做索引，不写他人仓库',
  '- 日期: 2026-10-10',
  '- 状态: 有效',
  '- 项目: demo',
  '- 出处: 立项契约 REV-001',
  '',
  '## D-002 备份默认走导出网盘',
  '- 日期: 2026-10-20',
  '- 状态: 有效',
  '- 项目: demo',
  '- 出处: 暮雨 10-20 拍板',
  '- 备注: 密码不落明文',
  '',
  '## D-003 这条已经撤销了',
  '- 日期: 2026-09-01',
  '- 状态: 已撤销',
  '- 项目: demo',
  '- 出处: 旧决定',
  '',
  '## D-004 别的项目的事',
  '- 日期: 2026-11-01',
  '- 状态: 有效',
  '- 项目: other',
  '- 出处: 对照组',
  '',
].join('\n'), 'utf-8')

// ── 方针夹具：demo 齐全；demo-nomap 有正文但没结构地图 ──────────────────
fs.writeFileSync(path.join(DATA, 'policies', 'demo.md'), [
  '## 项目方针（demo）',
  '## 使命',
  '让所有项目有一个统一的活口',
  '## 当前目标',
  '把任务收口做完',
  '## 应用场景',
  '一个人管十几摊',
  '## 方针边界',
  '对项目 repo 只读',
  '## 结构地图',
  '> 最后核实：2026-11-01',
  '',
  '- 模块清单：tegula/ 是 Python CLI；desktop/src/main 是主进程',
  '- 主数据流：task-data/*.md → 主进程解析 → 渲染层 / MCP',
  '',
].join('\n'), 'utf-8')

fs.writeFileSync(path.join(DATA, 'policies', 'demo-nomap.md'), [
  '## 项目方针（demo-nomap）',
  '## 使命',
  '只有正文，没有结构地图',
  '## 当前目标',
  '',
  '## 应用场景',
  '',
  '## 方针边界',
  '',
].join('\n'), 'utf-8')

// 结构地图只有“骨架”（savePolicy 一键补骨架时的占位）—— 这**不算有**地图：
// 模板里的“待填”当内容喂给 agent，它会把占位符当事实。
fs.writeFileSync(path.join(DATA, 'policies', 'demo-skeleton.md'), [
  '## 项目方针（demo-skeleton）',
  '## 使命',
  '这节是真的有内容',
  '## 当前目标',
  '把接线做完',
  '## 应用场景',
  '一个人维护',
  '## 方针边界',
  '只读别人的仓库',
  '## 结构地图',
  '> 最后核实：（待填 —— 填完写日期；烂地图比没地图危险，因为读者不知道它烂）',
  '',
  '- 模块清单：待填（每模块一句话职责）',
  '- 主数据流：待填（数据从哪来 → 经过谁 → 落到哪 → 谁读它）',
  '',
].join('\n'), 'utf-8')

// ── 作战计划夹具：两格（一格待裁决、一格完成），三块齐全 ────────────────
fs.writeFileSync(path.join(DATA, 'task-data', 'plans', 'demo.md'), [
  '# 演示项目 · 作战计划',
  '',
  '### P0 · 格式与机检',
  '- 状态: 完成',
  '- 做什么: 把结构定成文件格式',
  '- 技术方案:',
  '  - 用 Markdown + frontmatter',
  '- 照抄点:',
  '  | 抄谁 | 抄什么 |',
  '  |---|---|',
  '  | 旧方寸 | 字段名 |',
  '  | spec-kit | 判据四类 |',
  '  | adr | 决策留痕 |',
  '- 判据:',
  '  - format: 含 `## 要做什么`',
  '  - count: 标题 == 1',
  '',
  '### P1 · 接线',
  '- 状态: 待裁决',
  '- 做什么: 把 MCP 接上',
  '- 技术方案:',
  '  - 只读口先开',
  '- 照抄点:',
  '  | 抄谁 | 抄什么 |',
  '  |---|---|',
  '  | mcp 规范 | 工具命名 |',
  '  | 旧方寸 | bridge |',
  '  | spec-kit | 判据 |',
  '- 判据:',
  '  - cmd: node scripts/test/e2e-mcp-context.cjs',
  '',
  '## 修订记录',
  '- 2026-11-08 开局',
  '',
].join('\n'), 'utf-8')

const NL = '\n'

const DRIVER = `
const D = ${JSON.stringify(path.join(REPO, 'desktop'))}
const out = []
const check = (name, cond, detail) => out.push({ name, pass: !!cond, detail: String(detail || '').slice(0, 300) })
const fs = require('fs')

const tools = require(D + '/dist/main/mcp/tools.js')
const data = require(D + '/dist/main/data/index.js')
data.setDataDir(${JSON.stringify(DATA)})

const callRaw = (name, args) => tools.handleMCPToolCall(name, args || {})
const call = (name, args) => {
  const r = callRaw(name, args || {})
  const txt = r && r.content && r.content[0] && r.content[0].text
  try { return JSON.parse(txt) } catch (e) { return { __raw: txt } }
}
const names = (tools.MCP_TOOLS || []).map(t => t.name)

// ── 工具表（对外契约）────────────────────────────────────────────────
check('★★ 只读口三件都在工具表里（decision_list / project_charter / stage_plan_get）',
  ['decision_list', 'project_charter', 'stage_plan_get'].every(n => names.indexOf(n) >= 0),
  names.join(','))

// ── 决策 ───────────────────────────────────────────────────────────
const decAll = call('decision_list', { limit: 50 })
check('★★ decision_list 读得到决策（此前 MCP 一个字都读不到）',
  decAll && Array.isArray(decAll.decisions) && decAll.decisions.length === 4,
  JSON.stringify({ total: decAll && decAll.total, n: decAll && decAll.decisions && decAll.decisions.length }))
check('★★ 最新的排在最前面（文件是按时间追加的，读者要的是“最近定了什么”）',
  decAll.decisions[0] && decAll.decisions[0].id === 'D-004',
  JSON.stringify((decAll.decisions || []).map(d => d.id)))
check('★ 正文与出处一起给（不是只给 id）',
  (decAll.decisions || []).some(d => d.内容.indexOf('索引') >= 0 && d.出处.indexOf('REV-001') >= 0),
  JSON.stringify((decAll.decisions || [])[0]))

const decProj = call('decision_list', { project: 'demo' })
check('★★ 按项目过滤真生效（别的项目的决策不许混进来）',
  decProj.decisions.length === 3 && decProj.decisions.every(d => d.项目 === 'demo'),
  JSON.stringify((decProj.decisions || []).map(d => d.id + '@' + d.项目)))

const decValid = call('decision_list', { project: 'demo', status: '有效' })
check('★★ 按状态过滤真生效（已撤销的不算“已经定过”）',
  decValid.decisions.length === 2 && decValid.decisions.every(d => d.状态 === '有效'),
  JSON.stringify((decValid.decisions || []).map(d => d.id + '/' + d.状态)))

const decLegacy = call('decision_list', { status: '已作废' })
check('★ 老状态词能归一（“作废”→“已撤销”，不是返回空集）',
  decLegacy.decisions.length === 1 && decLegacy.decisions[0].id === 'D-003',
  JSON.stringify((decLegacy.decisions || []).map(d => d.id + '/' + d.状态)))

const decQ = call('decision_list', { query: '网盘' })
check('★ 关键词能命中（内容/备注/出处都算）',
  decQ.decisions.length === 1 && decQ.decisions[0].id === 'D-002',
  JSON.stringify((decQ.decisions || []).map(d => d.id)))

const decLimit = call('decision_list', { limit: 2 })
check('  条数上限生效（不把几百条一次倒给 agent）',
  decLimit.decisions.length === 2 && decLimit.total === 4,
  JSON.stringify({ n: decLimit.decisions.length, total: decLimit.total }))

check('★★ 返回体里写明“只读、要新增让用户点”（别让 agent 以为它能写）',
  /只读/.test(String(decAll.readOnly || '')), String(decAll.readOnly || ''))

// ── 项目方针 / 结构地图 ────────────────────────────────────────────────
const ch = call('project_charter', { project: 'demo' })
check('★★ project_charter 读得到方针五节',
  ch.ok === true && ch.mission.indexOf('统一的活口') >= 0 && ch.boundary.indexOf('只读') >= 0,
  JSON.stringify({ ok: ch.ok, mission: ch.mission, boundary: ch.boundary }))
check('★★★ 结构地图读得到，且带“最后核实”日期（没有日期就不知道这图烂没烂）',
  String(ch.structureMap || '').indexOf('最后核实') >= 0 && String(ch.structureMap || '').indexOf('主数据流') >= 0,
  String(ch.structureMap || '').slice(0, 160))
check('★ 五节齐全时 missingSections 为空（不是一律报缺）',
  Array.isArray(ch.missingSections) && ch.missingSections.length === 0,
  JSON.stringify(ch.missingSections))

const noCharter = callRaw('project_charter', { project: 'demo-nocharter' })
check('★★★ 没方针的项目**明确报错**，不返回空对象冒充“这个项目很干净”',
  noCharter.isError === true, String(noCharter.content && noCharter.content[0] && noCharter.content[0].text).slice(0, 200))

const noMap = call('project_charter', { project: 'demo-nomap' })
check('★★★ 有方针但缺结构地图 → 进 missingSections（缺 ≠ 空字符串）',
  noMap.ok === true && (noMap.missingSections || []).indexOf('结构地图') >= 0,
  JSON.stringify(noMap.missingSections))
check('★ 缺的另外几节也点名（空正文算没写）',
  (noMap.missingSections || []).indexOf('目标') >= 0 && (noMap.missingSections || []).indexOf('边界') >= 0,
  JSON.stringify(noMap.missingSections))

const badId = callRaw('project_charter', { project: '' })
check('  不给项目 id 直接报错（不猜一个默认项目）', badId.isError === true)

// 结构地图的时效（2026-11-08）：暮雨不看这块，看的是 agent —— 所以 agent 要知道它准不准
check('★★ 结构地图的“最后核实”算成天数（不是让 agent 自己去比日期）',
  typeof ch.structureMapAgeDays === 'number' && ch.structureMapAgeDays >= 0,
  JSON.stringify({ at: ch.structureMapVerifiedAt, days: ch.structureMapAgeDays }))
check('★ 刚核过的不算 stale（日期是真的新，不是一律报警）',
  ch.structureMapStale === false, JSON.stringify({ stale: ch.structureMapStale, days: ch.structureMapAgeDays }))
check('★★★ 没有“最后核实”日期 → 一律 stale（“烂地图比没地图危险”）',
  noMap.structureMapStale === true, JSON.stringify({ stale: noMap.structureMapStale }))

// 只装了骨架（“待填”）也要算缺 —— 否则 agent 会把占位符当事实
const skel = call('project_charter', { project: 'demo-skeleton' })
check('★★★ 结构地图只有“待填”骨架 → 仍算缺（占位符不许当内容喂给 agent）',
  skel.ok === true && (skel.missingSections || []).indexOf('结构地图') >= 0,
  JSON.stringify(skel.missingSections))
check('★ 骨架反例的另一面：其余四节真有内容 → 不许跟着报缺',
  (skel.missingSections || []).length === 1,
  JSON.stringify(skel.missingSections))
check('★★ 骨架里的“（待填”不算核实日期 → 同样 stale',
  skel.structureMapStale === true, JSON.stringify({ stale: skel.structureMapStale, days: skel.structureMapAgeDays }))

// ── 作战计划三块 ────────────────────────────────────────────────────
const ov = call('stage_plan_get', {})
check('★★ 不给 file 只给概览（几格 / 几格待裁决 / 几格完成）',
  ov && ov.files === 1 && ov.plans[0].stages === 2 && ov.plans[0].pending === 1 && ov.plans[0].done === 1,
  JSON.stringify(ov && ov.plans && ov.plans[0]))
check('★ 概览里**不带**三块正文（几十格正文会把 token 烧光）',
  JSON.stringify(ov).indexOf('用 Markdown + frontmatter') < 0,
  JSON.stringify(ov).slice(0, 200))

const one = call('stage_plan_get', { file: 'demo.md', stageId: 'P1' })
check('★★ 带 file + stageId 拿到那一格',
  one.ok === true && one.stages.length === 1 && one.stages[0].id === 'P1',
  JSON.stringify(one.stages && one.stages.map(s => s.id)))
check('★★★ 技术方案 / 照抄点 / 判据 三块正文都在（这才是“能干活”的信息）',
  one.stages[0].approach.length >= 1
  && one.stages[0].copyRows.length >= 3
  && one.stages[0].criteria.length >= 1
  && one.stages[0].criteria[0].indexOf('cmd:') >= 0,
  JSON.stringify(one.stages[0]).slice(0, 300))
check('★ 状态一起给（agent 才知道这格能不能推）',
  one.stages[0].status === '待裁决', String(one.stages[0].status))
check('★ 修订记录也能读到（“以前改过什么”不用再问人）',
  (one.revision || []).length >= 1, JSON.stringify(one.revision))

const whole = call('stage_plan_get', { file: 'demo.md' })
check('  不给 stageId 时返回整份计划（两格）',
  whole.stages.length === 2, String(whole.stages && whole.stages.length))

const miss = callRaw('stage_plan_get', { file: 'demo.md', stageId: 'P9' })
check('★★ 不存在的阶段明确报错并列出真实 id（不许静默回空数组）',
  miss.isError === true && /P0/.test(String(miss.content[0].text)) && /P1/.test(String(miss.content[0].text)),
  String(miss.content[0].text).slice(0, 200))

const noFile = callRaw('stage_plan_get', { file: 'nope.md' })
check('  计划卡不存在时报错（不是返回空 stages 冒充“这项目没计划”）', noFile.isError === true)

check('★★ 三个返回体都声明只读（冻结/打回是用户的点击）',
  /只读/.test(String(one.readOnly || '')), String(one.readOnly || ''))

// ── 源码守卫：读口不许长出写能力 ─────────────────────────────────────
const src = fs.readFileSync(D + '/src/main/mcp/tools.ts', 'utf-8')
const sliceCase = (name) => {
  const i = src.indexOf("case '" + name + "':")
  if (i < 0) return ''
  const j = src.indexOf("case '", i + 6)
  return src.slice(i, j < 0 ? src.length : j)
}
const WRITE_FNS = ['writePlanVerdict', 'advanceStage', 'savePolicy', 'addDecision', 'setDecisionStatus', 'updateDecision', 'deleteDecision', 'atomicWrite', 'writeFileSync']
for (const c of ['decision_list', 'project_charter', 'stage_plan_get']) {
  const body = sliceCase(c)
  const hit = WRITE_FNS.filter((f) => body.indexOf(f) >= 0)
  check('★★ 源码守卫：' + c + ' 里没有任何写入函数（只读口现在真的是只读）',
    body.length > 0 && hit.length === 0, hit.join(',') || 'clean')
}

console.log(JSON.stringify(out))
`

const { spawnSync } = require('child_process')
const driverPath = path.join(TMP, 'driver.cjs')
fs.writeFileSync(driverPath, DRIVER, 'utf-8')
const r = spawnSync(process.execPath, [driverPath], { encoding: 'utf-8', timeout: 120000 })
const line = String(r.stdout || '').trim().split(NL).filter(Boolean).pop() || ''
let rows = []
try { rows = JSON.parse(line) } catch {
  console.log('FAIL  MCP 只读口套件自身跑不起来:', (r.stderr || '').slice(0, 600), (r.stdout || '').slice(0, 300))
  console.log('RESULT 0 / 1')
  process.exit(1)
}
let pass = 0
let fail = 0
for (const row of rows) {
  if (row.pass) { pass++; console.log('PASS  ' + row.name) }
  else { fail++; console.log('FAIL  ' + row.name + '  → ' + row.detail) }
}
console.log('')
console.log('RESULT ' + pass + ' / ' + fail)
process.exit(fail ? 1 : 0)
