#!/usr/bin/env node
/**
 * 规划草案入口（2026-11-11 · 0.7.0 规划根基）
 *
 * 为什么要有这一套：`generatePlanDraft` / `plan_submit` 早就把草案写进 `_drafts/` 了，
 * 但界面上看不见 —— 「agent 起草 → 人裁决」只通了半截。这个入口补的是那半截，
 * 判据不是“能点”，而是**四件必须成立的事**：
 *   ① 草案能解析出「宪法 / 要先问的题 / 每格三块」；
 *   ② 缺块的那格**不给提**（点了也说清缺什么，不写半个字节）；
 *   ③ 提成**走同一条闸**：没带澄清卷 / 卷没批准 / 重号 → 一律拒；带对卷 → 真落成「待裁决」阶段卡；
 *   ④ 草案本身**只读**：跑完逐字节不变。
 *
 * 运行：node scripts/test/e2e-plan-drafts.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')
const TMP = mkTmp('plan-drafts-')
const DATA = path.join(TMP, 'data')
const TASK_DIR = path.join(DATA, 'task-data')
const PLANS = path.join(TASK_DIR, 'plans')
const DRAFTS = path.join(PLANS, '_drafts')
const QDIR = path.join(TASK_DIR, 'questionnaires')
process.env.FC_TEST_USERDATA = path.join(TMP, 'userdata')
for (const d of [DATA, TASK_DIR, PLANS, DRAFTS, QDIR, process.env.FC_TEST_USERDATA]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(DATA, 'registry.yaml'), 'projects:\n  - id: demo\n    name: 演示\n    repo: .\n', 'utf-8')

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const data = require(path.join(DIST, 'main', 'data', 'index.js'))
data.setDataDir(DATA)
const plans = require(path.join(DIST, 'main', 'data', 'plans.js'))
const draftsMod = require(path.join(DIST, 'main', 'data', 'planDrafts.js'))
const store = require(path.join(DIST, 'main', 'data', 'questionnaires.js'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

// ── 夹具 ──────────────────────────────────────────────────────────────────
const PLAN_MD = [
  '# demo · 作战计划',
  '',
  '- 版本: v1',
  '',
  '## 范围',
  '演示用计划卡。',
  '',
  '## 阶段卡',
  '',
  '### P1 · 已有的一格',
  '',
  '- 状态: 完成',
  '- 技术方案:',
  '  - 已经做完的那格',
  '',
  '- 照抄点:',
  '',
  '| 抄哪块 | 落到哪 | 不抄什么 | 怎么算抄到位 |',
  '|---|---|---|---|',
  '| CI 报告 | 逐格结论 | 趋势图 | num: 每格三态 |',
  '',
  '- 判据:',
  '  - cmd: echo hi',
  '',
  '## 修订记录',
  '',
  '- 2026-11-01 · v1 初建',
  '',
].join('\n')
fs.writeFileSync(path.join(PLANS, 'demo.md'), PLAN_MD, 'utf-8')

const DRAFT_MD = [
  '# demo · 作战计划（方寸起草草案）',
  '',
  '- 状态: 待裁决',
  '- 版本: draft-2026-11-11',
  '- 日期: 2026-11-11',
  '',
  '## 宪法（一页结论）',
  '',
  '| 类型 | 结论 | 依据 |',
  '|---|---|---|',
  '| 已定 | 判断半是硬锁：没卷不许出单 | decision:D-061 |',
  '| 待定 | 0.7.0 要不要接 UI 美化 | task:ui美化 |',
  '',
  '## 本轮要先问的问题',
  '',
  '- 0.7.0 里要不要接 UI 美化？（为什么现在问：选型没拍板）',
  '',
  '## 阶段卡',
  '',
  '### P12 · 规划草案的界面入口',
  '',
  '- 状态: 待裁决',
  '- 做什么: 草案能被看见并提成阶段卡',
  '- 技术方案:',
  '  - 读 _drafts/*.md 并解析三块',
  '  - 提成走 proposeStage 同一条闸',
  '',
  '- 照抄点:',
  '',
  '| 抄哪块 | 落到哪 | 不抄什么 | 怎么算抄到位 |',
  '|---|---|---|---|',
  '| 草稿式丰富的评审页 | 草案卡片 | 多角色互审 | num: 每格三块齐全 |',
  '',
  '- 判据:',
  '  - cmd: node scripts/test/e2e-plan-drafts.cjs',
  '  - file: desktop/src/main/data/planDrafts.ts',
  '',
  '### P13 · 缺块的那一格',
  '',
  '- 状态: 待裁决',
  '- 技术方案:',
  '  - 只有技术方案，照抄点与判据都没写',
  '',
  '### P14 · 判据没前缀的那一格',
  '',
  '- 状态: 待裁决',
  '- 技术方案:',
  '  - 有方案',
  '',
  '- 照抄点:',
  '',
  '| 抄哪块 | 落到哪 | 不抄什么 | 怎么算抄到位 |',
  '|---|---|---|---|',
  '| A | B | C | D |',
  '',
  '- 判据:',
  '  - 这条判据忘了写前缀',
  '',
].join('\n')
const draftPath = path.join(DRAFTS, 'demo-2026-11-11.md')
fs.writeFileSync(draftPath, DRAFT_MD, 'utf-8')
const draftBytesBefore = fs.readFileSync(draftPath)
const planBefore = fs.readFileSync(path.join(PLANS, 'demo.md'), 'utf-8')

const Q = (nav) => [
  `## A1 ${nav}`, `关于${nav}要怎么定？`,
  '- **A. 要**——代价甲', '- **B. 不要**——代价乙',
  '【验收线】出现反例即违约', '',
]
fs.writeFileSync(path.join(QDIR, 'demo-宪法层.md'), [
  '**项目**：demo',
  '',
  '# demo 的问卷',
  '',
  ...Q('甲'),
].join('\n'), 'utf-8')

console.log('== A. 草案解析（只读）==')
const list = draftsMod.listDrafts()
check('★ 列出草案（1 份解析成功、0 份坏）',
  list.drafts.length === 1 && list.broken.length === 0,
  JSON.stringify({ drafts: list.drafts.map((d) => d.file), broken: list.broken }))
const d0 = list.drafts[0] || { stages: [], constitution: [], asks: [] }
check('★ 项目 / 版本 / 日期都解析出来（不是从文件名猜）',
  d0.project === 'demo' && d0.version === 'draft-2026-11-11' && d0.date === '2026-11-11',
  JSON.stringify({ project: d0.project, version: d0.version, date: d0.date }))
check('★★ 宪法页解析成「类型 / 结论 / 依据」三列（已定 + 待定都留着）',
  d0.constitution.length === 2 && d0.constitution[0].type === '已定' && /D-061/.test(d0.constitution[0].cite)
  && d0.constitution[1].type === '待定',
  JSON.stringify(d0.constitution))
check('★ 「本轮要先问的问题」解析成列表（不是一坨文本）',
  d0.asks.length === 1 && /UI 美化/.test(d0.asks[0]), JSON.stringify(d0.asks))
check('★ 三格都解析出来（P12 / P13 / P14）',
  d0.stages.length === 3 && d0.stages.map((s) => s.id).join(',') === 'P12,P13,P14',
  JSON.stringify(d0.stages.map((s) => s.id)))
const st = (id) => d0.stages.find((s) => s.id === id) || { missing: [], copyRows: [], criteria: [] }
check('★★ 齐全那格：三块都有、missing 为空（界面据此才给提议按钮）',
  st('P12').missing.length === 0 && st('P12').approach.length === 2
  && st('P12').copyRows.length >= 3 && st('P12').criteria.length === 2,
  JSON.stringify({ missing: st('P12').missing, a: st('P12').approach.length, c: st('P12').copyRows.length, cr: st('P12').criteria.length }))
check('★★ 缺块那格：缺什么要点名（照抄点 / 判据）',
  st('P13').missing.includes('照抄点') && st('P13').missing.includes('判据'),
  JSON.stringify(st('P13').missing))
check('★★ 判据没前缀要被点名（否则提进去永远闸不过 = 死卡）',
  st('P14').missing.some((m) => m.indexOf('判据没前缀') >= 0), JSON.stringify(st('P14').missing))

console.log('\n== B. 提成阶段卡（走同一条闸）==')
const rMissing = draftsMod.proposeFromDraft({ draft: 'demo-2026-11-11.md', stageId: 'P13', deck: 'demo-宪法层' })
check('★★ 缺块那格：拒，且说清缺什么（不写半个字节）',
  rMissing.ok === false && /缺/.test(rMissing.error || ''), JSON.stringify(rMissing))

const rNoDeck = draftsMod.proposeFromDraft({ draft: 'demo-2026-11-11.md', stageId: 'P12', deck: '' })
check('★★ 没带澄清卷：拒（D-060 硬锁，与 agent 走 stage_plan_propose 同一口径）',
  rNoDeck.ok === false && /澄清|卷/.test(rNoDeck.error || ''), JSON.stringify(rNoDeck))

// 卷存在但没批准 → 闸必须拒
store.writeAnswers('demo-宪法层', { answers: { A1: { kind: 'pick', k: 'A' } } })
const rUnapproved = draftsMod.proposeFromDraft({ draft: 'demo-2026-11-11.md', stageId: 'P12', deck: 'demo-宪法层' })
check('★★ 卷没批准：拒（草稿不算数）',
  rUnapproved.ok === false && fs.readFileSync(path.join(PLANS, 'demo.md'), 'utf-8') === planBefore,
  JSON.stringify(rUnapproved))

// 批准后再提 → 成功
store.writeAnswers('demo-宪法层', {
  answers: { A1: { kind: 'pick', k: 'A' } }, approvedAt: new Date().toISOString(),
})
const rOk = draftsMod.proposeFromDraft({ draft: 'demo-2026-11-11.md', stageId: 'P12', deck: 'demo-宪法层' })
const planAfter = fs.readFileSync(path.join(PLANS, 'demo.md'), 'utf-8')
check('★★ 卷已批准：提成成功，落成「待裁决」阶段卡',
  rOk.ok === true && /### P12/.test(planAfter) && /- 状态: 待裁决/.test(planAfter),
  JSON.stringify({ ok: rOk.ok, error: rOk.error, planFile: rOk.planFile }))
check('★★ 落地的卡带着澄清卷（进队列锁靠它；没带 = 以后能派出去）',
  /- 澄清: demo-宪法层/.test(planAfter), planAfter.split('\n').filter((l) => l.indexOf('澄清') >= 0).join(' | '))
check('★ 照抄点表头**原样落地**（不是被换成「项/来源/原文」再对不上列）',
  /抄哪块 \| 落到哪 \| 不抄什么 \| 怎么算抄到位/.test(planAfter),
  planAfter.split('\n').filter((l) => l.indexOf('抄哪块') >= 0).join(' | '))
check('★ 判据原样落地（cmd: / file: 两条都在）',
  /cmd: node scripts\/test\/e2e-plan-drafts\.cjs/.test(planAfter) && /file: desktop\/src\/main\/data\/planDrafts\.ts/.test(planAfter))
const reread = plans.readPlan('demo.md')
const newStage = reread && reread.stages.find((s) => s.id === 'P12')
check('★ 读回来说得通（三块不缺、状态是待裁决）',
  !!newStage && newStage.missing.length === 0 && newStage.status === '待裁决',
  JSON.stringify(newStage && { missing: newStage.missing, status: newStage.status }))

const rAgain = draftsMod.proposeFromDraft({ draft: 'demo-2026-11-11.md', stageId: 'P12', deck: 'demo-宪法层' })
check('★ 重复提成同一格：拒（重号检查），文件不再多一张',
  rAgain.ok === false && (planAfter.match(/### P12/g) || []).length === 1, JSON.stringify(rAgain))

check('★★ 草案本身只读：跑完逐字节不变', Buffer.compare(fs.readFileSync(draftPath), draftBytesBefore) === 0,
  `${fs.statSync(draftPath).size}B`)
check('★ 坏的草案在 broken 里点名（不静默丢）', (() => {
  fs.writeFileSync(path.join(DRAFTS, '坏草案.md'), '这不是草案：没有阶段卡小节\n', 'utf-8')
  const l2 = draftsMod.listDrafts()
  const ok = l2.broken.some((b) => /坏草案/.test(b.file)) && l2.drafts.length === 1
  fs.unlinkSync(path.join(DRAFTS, '坏草案.md'))
  return ok
})(), JSON.stringify(draftsMod.listDrafts().broken))

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`通过 ${pass} / 失败 ${fail}`)
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
