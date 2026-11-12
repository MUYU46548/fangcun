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

// ══ C. 提成时就地改三块（2026-11-12 第二轮）══════════════════════════════
// 判据：① 草案里**缺块**的那格，在提成时把缺的块补上 → 必须能提（旧的“先判缺再改”顺序必红）；
//       ② 改过的内容**真的落进计划卡**（不是只改了个界面）；③ 没改的块**一个字都不许变**；
//       ④ 改了哪几块要留痕（提议人里看得见）；⑤ 越权字段（id / 标题）一律以草案为准；
//       ⑥ 体检不过（判据没前缀 / 表格列数不对）→ 拒，且**草案与计划卡都不动**。
const ED = require(path.join(DIST, 'shared', 'draftEdit.js'))

console.log('\n== C. 提成时就地改三块（改完仍走同一条闸）==')
const planBeforePatch = fs.readFileSync(path.join(PLANS, 'demo.md'), 'utf-8')

// ⑥-a 体检先拦：判据没前缀 → 拒（这一步在“缺块”之前，报的是内容问题而不是“缺判据”）
const rBadPrefix = draftsMod.proposeFromDraft({
  draft: 'demo-2026-11-11.md', stageId: 'P14', deck: 'demo-宪法层',
  patch: { criteria: ['这条忘了写前缀'] },
})
check('★★ 改过的判据没前缀：拒，且点名是前缀问题（不是笼统的“缺判据”）',
  rBadPrefix.ok === false && /前缀/.test(rBadPrefix.error || ''), JSON.stringify(rBadPrefix))

// ① P13 草案里缺照抄点与判据 → 提成时补上 → 必须能提
const rFill = draftsMod.proposeFromDraft({
  draft: 'demo-2026-11-11.md', stageId: 'P13', deck: 'demo-宪法层',
  patch: {
    copyRows: [['项', '来源', '原文'], ['---', '---', '---'], ['闭环机检', 'docs/x.md', 'num: 9/0']],
    criteria: ['cmd: node scripts/test/e2e-plan-drafts.cjs', 'str: desktop/src/shared/draftEdit.ts 含 applyPatch'],
  },
})
const planAfterFill = fs.readFileSync(path.join(PLANS, 'demo.md'), 'utf-8')
check('★★ 草案里缺块的那格：提成时把缺的块补上 → 能提成（“先判缺再改”的旧顺序会在这里必红）',
  rFill.ok === true && /### P13/.test(planAfterFill),
  JSON.stringify({ ok: rFill.ok, error: rFill.error }))
check('★★ 改过的内容真的落进了计划卡（不是只改了界面）',
  /闭环机检/.test(planAfterFill) && /num: 9\/0/.test(planAfterFill)
  && /applyPatch/.test(planAfterFill), planAfterFill.split('\n').filter((l) => /闭环机检|applyPatch/.test(l)).join(' | '))
check('★ 没改的块一个字都不许变（P13 的技术方案还是草案里那条）',
  /只有技术方案，照抄点与判据都没写/.test(planAfterFill))
check('★★ 改了哪几块要留痕（提议人里写明，计划卡里看得见）',
  /- 提议人: .*提成时改过：照抄点 \/ 判据/.test(planAfterFill),
  planAfterFill.split('\n').filter((l) => /提议人/.test(l)).join(' | '))
check('★ 回执带回改动摘要（界面据此说“改过哪几块”，不自己猜）',
  !!rFill.edit && rFill.edit.count === 2 && rFill.edit.note === '照抄点 / 判据',
  JSON.stringify(rFill.edit))

// 材料：纯函数口径（界面与主进程共用，这里直接钉住，不走 IPC）
check('★★ 「缺什么」只由 shared/draftEdit 算（主进程与界面同一口径）',
  ED.missingOf({ approach: ['a'], copyRows: [['项', '来源'], ['---', '---'], ['x', 'y']], criteria: ['cmd: echo'] }).length === 0
  && ED.missingOf({ approach: [], copyRows: [], criteria: [] }).join(',') === '技术方案,照抄点,判据',
  JSON.stringify([
    ED.missingOf({ approach: ['a'], copyRows: [['项', '来源'], ['---', '---'], ['x', 'y']], criteria: ['cmd: echo'] }),
    ED.missingOf({ approach: [], copyRows: [], criteria: [] }),
  ]))
check('★★ 只有表头没有数据行 = 缺照抄点（表头不算内容）',
  ED.missingOf({ approach: ['a'], copyRows: [['项', '来源', '原文']], criteria: ['cmd: x'] }).includes('照抄点'))
check('★ 表格缺分隔线 → 自动补（用户手写很少记得写 |---|）',
  (() => { const r = ED.normalizeCopyRows([['表头甲', '表头乙'], ['数据甲', '数据乙']]); return r.length === 3 && r[1].join('') === '------' })(),
  JSON.stringify(ED.normalizeCopyRows([['表头甲', '表头乙'], ['数据甲', '数据乙']])))
check('★ 连表头都没写 → 补一个标准表头（不是把数据行当表头）',
  (() => { const r = ED.normalizeCopyRows([['a', 'b', 'c']]); return r[0][0] === '项' && r.length === 3 })(),
  JSON.stringify(ED.normalizeCopyRows([['a', 'b', 'c']])))
check('★★ 多行文本粘进判据：行首的 `- ` / `1. ` 要剥掉（否则落进卡里变成 `- - cmd: …`）',
  ED.linesToList('- cmd: a\n1. str: b\n\n  num: c  ').join('|') === 'cmd: a|str: b|num: c',
  JSON.stringify(ED.linesToList('- cmd: a\n1. str: b\n\n  num: c  ')))
check('★★ 预检拦得住表格列数对不上（写进计划卡就是错位的表）',
  ED.validateStage({ approach: ['a'], criteria: ['cmd: x'], copyRows: [['项', '来源', '原文'], ['---', '---', '---'], ['只有两列', '少了']] })
    .some((e) => /列/.test(e)))
check('★ 超限也拦（不是静默截断）',
  ED.validateStage({ approach: ['a'], criteria: ['cmd: x'], copyRows: Array.from({ length: 61 }, () => ['a', 'b', 'c']) })
    .some((e) => /超过上限/.test(e)))
check('★★ 只有三块可改：id / 标题 / 做什么一律以草案为准（过桥塞进来也不认）',
  (() => {
    const base = { id: 'P99', title: '草案标题', what: '草案说的', approach: [], copyRows: [], criteria: [] }
    const out = ED.applyPatch(base, { id: 'P1', title: '偷换的标题', approach: ['改这里'] })
    return out.id === 'P99' && out.title === '草案标题' && out.what === '草案说的' && out.approach[0] === '改这里'
  })(), JSON.stringify(ED.applyPatch({ id: 'P99', title: '草案标题', what: '草案说的', approach: [], copyRows: [], criteria: [] }, { id: 'P1', title: '偷换的标题', approach: ['改这里'] })))
check('★ 没改任何一块 → 摘要为空、提议人里不加“改过”那句（不许凭空写一句改过）',
  (() => {
    const s = { approach: ['a'], copyRows: [], criteria: ['cmd: x'] }
    const d = ED.diffStage(s, ED.applyPatch(s, undefined))
    return d.count === 0 && ED.editNote(d) === ''
  })())
check('★★ 一条改动都不许丢进草案文件：跑完草案仍逐字节不变（含 patch 的几次）',
  Buffer.compare(fs.readFileSync(draftPath), draftBytesBefore) === 0, `${fs.statSync(draftPath).size}B`)
check('★ 体检不过时计划卡也不动（拒 = 零写入，不是“写一半”）',
  fs.readFileSync(path.join(PLANS, 'demo.md'), 'utf-8').startsWith(planBeforePatch.split('\n')[0])
  && (planBeforePatch.match(/### P14/g) || []).length === 0
  && (fs.readFileSync(path.join(PLANS, 'demo.md'), 'utf-8').match(/### P14/g) || []).length === 0)

// ══ D. 源码守卫：草案入口**结构上**就没有写 `_drafts` 的能力（2026-11-12）════
// 逐字节比对只能证明“这次跑没写”。真正的铁律是**没有写路径** —— 所以静态钉住：
// `planDrafts.ts` 里不许出现任何写盘调用（草案只读），写只许发生在 plans.ts 的 proposeStage。
console.log('\n== D. 源码守卫（草案入口只读，写口只有一处）==')
{
  const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf-8')
  const SRC = read('desktop/src/main/data/planDrafts.ts')
  const writes = SRC.match(/\b(writeFileSync|appendFileSync|unlinkSync|renameSync|atomicWrite|createWriteStream)\s*\(/g) || []
  check('★★ 草案入口一个写盘调用都没有（草案只读是结构保证，不是靠自觉）',
    writes.length === 0, writes.join(','))
  check('★★ 提成仍只调 proposeStage 一条写路径（不开第二套）',
    (SRC.match(/proposeStage\(/g) || []).length === 1)
  // 「缺什么」的口径只许有一份：主进程与界面都 import 同一个纯函数，不许各自再写一遍
  const VIEW = read('desktop/src/renderer/views/PlanView.vue')
  check('★★ 界面与主进程共用同一套「缺什么」口径（都 import shared/draftEdit）',
    /from '\.\.\/\.\.\/shared\/draftEdit'/.test(VIEW) && /from '\.\.\/\.\.\/shared\/draftEdit'/.test(SRC)
    && !/missing\.push\('技术方案'\)/.test(VIEW) && !/missing\.push\('技术方案'\)/.test(SRC))
  check('★ 界面提成时过桥的是普通对象（toPlain），不是裸 Vue 代理',
    /toPlain\(pdPatch\(/.test(VIEW))
  check('★ 过桥载荷的 patch 类型在 preload 里声明了（三块，不多不少）',
    /patch\?:\s*\{\s*approach\?: string\[\]; copyRows\?: string\[\]\[\]; criteria\?: string\[\]/.test(
      read('desktop/src/preload/index.ts')))
}

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
