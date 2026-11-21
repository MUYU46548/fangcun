#!/usr/bin/env node
/**
 * 结构地图“提议 → 用户签字 → 落地”（2026-11-08 暮雨拍板：“AI 写进去落一张待审批卡”）
 *
 * 这条拍板的意义只有一句话：**AI 不能直接把东西写进你的方针卡**。
 * 所以本套件的核心不是“能不能写”，而是**没签字的时候一个字节都不能动**：
 *
 *   ① `smap_propose` 只落卡，`policies/*.md` 的字节必须**完全不变**（反例：变了就是越权）；
 *   ② `smap_apply` 只认状态 =「完成」的卡（= 用户签字），待审批 / 草稿 / 驳回 一律拒；
 *   ③ 签字后的写入必须：写前备份、只换「结构地图」一节、其余四节逐字不动、写后读回自证；
 *   ④ 抽不出/没日期/还是“待填”骨架 → 拒写（宁可没改，也不能把半截或占位符写进方针）。
 *
 * ⚠ 真跑编译产物 dist/main，临时数据根（含 policies 目录），不碰真实 policies/。
 */

const fs = require('fs')
const path = require('path')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const TMP = mkTmp('smap-proposal-')
const DATA = path.join(TMP, 'data')
fs.mkdirSync(path.join(DATA, 'task-data'), { recursive: true })
fs.mkdirSync(path.join(DATA, 'policies'), { recursive: true })

fs.writeFileSync(path.join(DATA, 'registry.yaml'),
  'members: []\nprojects:\n  - id: demo\n    name: 演示项目\nreleased: []\n', 'utf-8')

const POLICY_ORIGINAL = [
  '## 使命',
  '让所有项目有一个统一的活口',
  '## 当前目标',
  '把任务收口做完',
  '## 应用场景',
  '一个人管十几摊',
  '## 方针边界',
  '对项目 repo 只读',
  '## 结构地图',
  '> 最后核实：2026-01-01',
  '',
  '- 模块清单：旧的模块',
  '- 主数据流：旧的数据流',
  '',
].join('\n')
fs.writeFileSync(path.join(DATA, 'policies', 'demo.md'), POLICY_ORIGINAL, 'utf-8')

const NEW_MAP = [
  '> 最后核实：2026-11-08',
  '',
  '- 模块清单：tegula/ 是 Python CLI；desktop/src/main 是主进程',
  '- 主数据流：task-data/*.md → 主进程解析 → 渲染层 / MCP',
].join('\n')

const NL = '\n'
const DRIVER = `
const D = ${JSON.stringify(path.join(REPO, 'desktop'))}
const DATA = ${JSON.stringify(DATA)}
const NEW_MAP = ${JSON.stringify(NEW_MAP)}
const out = []
const check = (name, cond, detail) => out.push({ name, pass: !!cond, detail: String(detail || '').slice(0, 300) })
const fs = require('fs')
const path = require('path')

const tools = require(D + '/dist/main/mcp/tools.js')
const data = require(D + '/dist/main/data/index.js')
const tasks = require(D + '/dist/main/data/tasks.js')
const policies = require(D + '/dist/main/services/policies.js')
data.setDataDir(DATA)

const callRaw = (name, args) => tools.handleMCPToolCall(name, args || {})
const call = (name, args) => {
  const r = callRaw(name, args || {})
  const txt = r && r.content && r.content[0] && r.content[0].text
  try { return JSON.parse(txt) } catch (e) { return { __raw: txt } }
}
const policyPath = path.join(DATA, 'policies', 'demo.md')
const policyBytes = () => fs.readFileSync(policyPath)
const samePolicy = (before) => Buffer.compare(before, policyBytes()) === 0

// ── ① 提议：落卡，但一个字节都不许写进方针 ───────────────────────────────
const before = policyBytes()
const prop = call('smap_propose', {
  project: 'demo',
  mapText: NEW_MAP,
  reason: '扫了 tegula/ 与 desktop/src/main，目录结构与旧图不一致',
  agent: 'e2e',
})
check('★★ smap_propose 落了一张卡并回 id', prop.ok === true && !!String(prop.id || '').trim(),
  JSON.stringify(prop).slice(0, 200))
check('★★★ 落的是「待审批」而不是直接生效', prop.status === '待审批', String(prop.status))
check('★★★ 提议阶段 policies/demo.md 一个字节都没变（越权的判据就在这）',
  samePolicy(before), 'bytes=' + policyBytes().length)
check('★ 返回体明说没动 policies（不让人以为已经写进去了）',
  prop.wrotePolicy === false && String(prop.note || '').indexOf('没有动') >= 0,
  String(prop.note || ''))
check('★ 机检全过（有日期 + 两节标题都在）',
  prop.intake && prop.intake.ok === true && prop.intake.failed === 0,
  JSON.stringify(prop.intake))

const card = data.loadTasks('all').find((t) => t.id === prop.id)
check('★ 卡正文里带完整新版地图', !!card && String(card.body).indexOf('desktop/src/main 是主进程') >= 0,
  String(card && card.body).slice(0, 100))
check('★ 卡正文说清“签字后才落地”（用户要知道批准会做什么）',
  !!card && String(card.body).indexOf('批准后怎么落地') >= 0
  && String(card.body).indexOf('smap_apply') >= 0, '')

// ── ② 没签字：apply 必须硬拒 ─────────────────────────────────────────────
const gate = callRaw('smap_apply', { taskId: prop.id })
const gateTxt = String(gate.content && gate.content[0] && gate.content[0].text)
check('★★★ 状态还是「待审批」时 smap_apply 被硬拒（签字是唯一的门）',
  gate.isError === true && /不是“完成”/.test(gateTxt), gateTxt.slice(0, 200))
check('★★★ 被拒之后方针文件仍然一个字节都没变',
  samePolicy(before), 'bytes=' + policyBytes().length)

// ── ③ 用户签字（把卡移到「完成」）之后才允许写 ────────────────────────────
tasks.updateTask(prop.id, { status: '完成' })
const signed = data.loadTasks('all').find((t) => t.id === prop.id)
check('（环境）卡已变成「完成」= 用户签字', !!signed && signed.fm.status === '完成',
  String(signed && signed.fm.status))

const applied = call('smap_apply', { taskId: prop.id })
check('★★★ 签字后 smap_apply 真的写进去了', applied.ok === true, JSON.stringify(applied).slice(0, 240))
check('★★ 写的是新版地图（读回一致，不是“写成功”三个字）',
  String(policies.getPolicy('demo').structureMap || '').indexOf('desktop/src/main 是主进程') >= 0,
  String(policies.getPolicy('demo').structureMap || '').slice(0, 120))
check('★★★ 其余四节逐字未动（只换结构地图，不许顺手重写整篇）',
  policies.getPolicy('demo').mission === '让所有项目有一个统一的活口'
  && policies.getPolicy('demo').boundary === '对项目 repo 只读'
  && policies.getPolicy('demo').goal === '把任务收口做完',
  JSON.stringify({
    mission: policies.getPolicy('demo').mission,
    boundary: policies.getPolicy('demo').boundary,
  }))
check('★ 写前自动备份（policies/.backup/ 里有东西）',
  fs.existsSync(path.join(DATA, 'policies', '.backup'))
  && fs.readdirSync(path.join(DATA, 'policies', '.backup')).length >= 1,
  fs.existsSync(path.join(DATA, 'policies', '.backup'))
    ? fs.readdirSync(path.join(DATA, 'policies', '.backup')).join(',') : 'no .backup')
check('★ 返回体里带“核实日期”与“只写了一节”的说明',
  applied.verifiedAt === '2026-11-08' && Array.isArray(applied.kept) && applied.kept.length === 4,
  JSON.stringify({ at: applied.verifiedAt, kept: applied.kept }))
check('★★ 读口同步可见（project_charter 拿到的是新图）', (() => {
  const r = call('project_charter', { project: 'demo' })
  return r.ok === true && String(r.structureMap || '').indexOf('desktop/src/main') >= 0
    && r.structureMapStale === false
})(), '')

// ── ④ 抽不出来 / 占位符 / 没日期 → 拒写 ──────────────────────────────────
{
  // 没写“最后核实”的提议：机检不过 → 落「草稿」而不是「待审批」
  const noDate = call('smap_propose', {
    project: 'demo',
    mapText: '- 模块清单：随便写点\\n- 主数据流：随便',
    reason: '试一下没写日期',
  })
  check('★★★ 没写“最后核实”日期 → 落「草稿」+ 红标（落不成待审批）',
    noDate.status === '草稿' && noDate.intake && noDate.intake.ok === false,
    JSON.stringify({ status: noDate.status, intake: noDate.intake }))

  // 就算有人手把它改成完成，apply 也不许写（占位骨架）
  const skel = call('smap_propose', {
    project: 'demo',
    mapText: '> 最后核实：2026-11-08\\n\\n- 模块清单：待填（每模块一句话职责）\\n- 主数据流：待填',
    reason: '故意交骨架',
  })
  tasks.updateTask(skel.id, { status: '完成' })
  const skelApply = callRaw('smap_apply', { taskId: skel.id })
  const skelTxt = String(skelApply.content && skelApply.content[0] && skelApply.content[0].text)
  check('★★★ 骨架（“待填”）即使签了字也不许写进方针',
    skelApply.isError === true && /待填/.test(skelTxt), skelTxt.slice(0, 200))
}

const miss = callRaw('smap_apply', { taskId: 'task-nope-x' })
check('  卡不存在时明确报错', miss.isError === true)

// ── ⑤ 源码守卫：propose 里不许有写方针的调用 ─────────────────────────────
const src = fs.readFileSync(D + '/src/main/mcp/tools.ts', 'utf-8')
const sliceCase = (name) => {
  const i = src.indexOf("case '" + name + "':")
  if (i < 0) return ''
  const j = src.indexOf("case '", i + 6)
  return src.slice(i, j < 0 ? src.length : j)
}
const proposeBody = sliceCase('smap_propose')
check('★★★ 源码守卫：smap_propose 里没有 savePolicy / atomicWrite（提议不许落地）',
  proposeBody.length > 0 && proposeBody.indexOf('savePolicy') < 0 && proposeBody.indexOf('atomicWrite') < 0,
  ['savePolicy', 'atomicWrite'].filter((f) => proposeBody.indexOf(f) >= 0).join(','))
const applyBody = sliceCase('smap_apply')
const smapSvc = fs.readFileSync(D + '/src/main/services/smapApply.ts', 'utf-8')
check('★★★ 源码守卫：smap_apply 的“完成”闸写在保存之前（先验签字，再动手）',
  smapSvc.indexOf("st !== '完成'") >= 0
  && smapSvc.indexOf("st !== '完成'") < smapSvc.indexOf('savePolicy({'),
  'gate=' + smapSvc.indexOf("st !== '完成'") + ' save=' + smapSvc.indexOf('savePolicy({'))
check('★ MCP handler 只转调 service（界面与 MCP 共用一份，不许两套逻辑）',
  applyBody.indexOf('applySmapFromTask') >= 0 && applyBody.indexOf('savePolicy') < 0,
  applyBody.slice(0, 160))

console.log(JSON.stringify(out))
`

require('child_process')
const { spawnSync } = require('child_process')
const driverPath = path.join(TMP, 'driver.cjs')
fs.writeFileSync(driverPath, DRIVER, 'utf-8')
const r = spawnSync(process.execPath, [driverPath], { encoding: 'utf-8', timeout: 120000 })
const line = String(r.stdout || '').trim().split(NL).filter(Boolean).pop() || ''
let rows = []
try { rows = JSON.parse(line) } catch {
  console.log('FAIL  结构地图提议套件自身跑不起来:', (r.stderr || '').slice(0, 600), (r.stdout || '').slice(0, 300))
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
