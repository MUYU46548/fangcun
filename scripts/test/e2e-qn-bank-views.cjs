#!/usr/bin/env node
/**
 * 题库 ↔ 卷 ↔ 卡 关系视图 + 多卷批量处置（0.7.0 P11）
 *
 * 卡上原话（P11 阶段卡）：
 *   ① 数据层加 `bankRelations(project)`：题 → 卷/答案/交付状态/引用卡，纯派生不落表；
 *   ② 问卷页右栏加「题库」视图，逐题显示来源卷与交付状态；
 *   ③ 列表行加多选：批量作废/归档逐卷走同一条通道，成功几卷说几卷、失败逐条点名；
 *   ④ 反例：批量里有一卷卷面坏 → 它不被处理且报出来，其余照做。
 *
 * 这个脚本只钉 ①③④ 的**可复跑**部分（②是界面，由 renderer-web 钉）：
 *   · A 段：`bankRelations` 是纯函数，直接喂夹具断言“哪条结论来自哪卷 / 哪条缺什么”；
 *   · B 段：`batchDeckAction` **真落盘**（临时数据根 + 真卷 md），断言“坏卷什么都不改且被点名”。
 *
 * 运行：node scripts/test/e2e-qn-bank-views.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')
const TMP = mkTmp('qn-bank-views-')
const DATA = path.join(TMP, 'data')
const TASK_DIR = path.join(DATA, 'task-data')
const QDIR = path.join(TASK_DIR, 'questionnaires')
process.env.FC_TEST_USERDATA = path.join(TMP, 'userdata')
for (const d of [DATA, TASK_DIR, QDIR, process.env.FC_TEST_USERDATA]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(DATA, 'registry.yaml'),
  'projects:\n  - id: fangcun-base\n    name: 方寸\n    repo: .\n  - id: sitian\n    name: 司天\n    repo: .\n', 'utf-8')

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const data = require(path.join(DIST, 'main', 'data', 'index.js'))
data.setDataDir(DATA)
const store = require(path.join(DIST, 'main', 'data', 'questionnaires.js'))
const qbank = require(path.join(DIST, 'main', 'data', 'questionBank.js'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

console.log('== A. 题库 ↔ 卷 ↔ 卡 关系视图（纯函数）==')

const fp = (s) => qbank.fingerprintOf(s)
const BANK = [
  { id: 'Q001', ask: '验收线要不要写进卡里？', project: 'sitian', firstAsked: '2026-10-01', status: '已答',
    answer: '要', source: '司天-宪法层', line: '每张卡的验收清单非空', fingerprint: fp('验收线要不要写进卡里？') },
  { id: 'Q002', ask: '备份要不要做恢复演练？', project: 'sitian', firstAsked: '2026-10-02', status: '已答',
    answer: '要', source: '司天-宪法层', line: '每季度一次演练并留证据', fingerprint: fp('备份要不要做恢复演练？') },
  { id: 'Q003', ask: '多项目优先级谁说了算？', project: 'sitian', firstAsked: '2026-10-03', status: '待答',
    answer: '', source: '', line: '', fingerprint: fp('多项目优先级谁说了算？') },
  { id: 'Q005', ask: '卷已经删了的那道题', project: 'sitian', firstAsked: '2026-09-01', status: '待答',
    answer: '', source: '', line: '', fingerprint: fp('卷已经删了的那道题') },
  { id: 'Q900', ask: '别的项目的题', project: 'mofang', firstAsked: '2026-10-04', status: '待答',
    answer: '', source: '', line: '', fingerprint: fp('别的项目的题') },
]
const DECKS = [
  {
    deck: '司天-宪法层', project: 'sitian', status: '已批准',
    questions: [
      { qid: 'S1', ask: '验收线要不要写进卡里？', answered: true,
        deliveries: [{ cardId: 'task-1', date: '2026-11-01', passed: true }] },
      { qid: 'S2', ask: '备份要不要做恢复演练？', answered: true, deliveries: [] },
      { qid: 'S3', ask: '多项目优先级谁说了算？', answered: false, deliveries: [] },
    ],
  },
  {
    deck: '司天-宪法层-v2', project: 'sitian', status: '草稿',
    questions: [{ qid: 'S1', ask: '验收线要不要写进卡里？', answered: false, deliveries: [] }],
  },
]
const CARDS = [
  { id: 'task-1', clarify: '司天-宪法层#S1' },
  { id: 'task-2', clarify: '' },
]

const rel = qbank.bankRelations({ project: 'sitian', bank: BANK, decks: DECKS, cards: CARDS })
const row = (id) => (rel.rows || []).find((r) => r.id === id) || null

check('★ 只出本项目的题（跨项目的同库条目不许混进来）',
  rel.rows.length === 4 && !row('Q900'), `rows=${rel.rows.length} ids=${rel.rows.map((r) => r.id).join(',')}`)
check('★★ 同一题被两卷问过 → 两条来源都列出来（含各自是否已答）',
  !!row('Q001') && row('Q001').sources.length === 2
  && row('Q001').sources.some((s) => s.deck === '司天-宪法层' && s.answered)
  && row('Q001').sources.some((s) => s.deck === '司天-宪法层-v2' && !s.answered),
  JSON.stringify(row('Q001') && row('Q001').sources))
check('★★ 交付状态来自卷的 deliveries（1 张已交付），不是拿“有没有卡”猜的',
  !!row('Q001') && row('Q001').sources.some((s) => s.delivered.length === 1 && s.delivered[0].cardId === 'task-1'),
  JSON.stringify(row('Q001') && row('Q001').sources.map((s) => s.delivered)))
check('★★ 引用它的卡按 `<卷>#<题号>` 认出来（问卷落卡就是这个形状）',
  !!row('Q001') && row('Q001').cards.length === 1 && row('Q001').cards[0] === 'task-1',
  JSON.stringify(row('Q001') && row('Q001').cards))
check('★ 答了但还没有卡带着这条验收线 → 必须点名（Q002 的 notes）',
  !!row('Q002') && (row('Q002').notes || []).some((n) => n.indexOf('还没有卡带着这条验收线') >= 0),
  JSON.stringify(row('Q002') && row('Q002').notes))
check('★ 有卷问过但还没答 → 来源在、answered=false、不许假装已答',
  !!row('Q003') && row('Q003').sources.length === 1 && row('Q003').sources[0].answered === false,
  JSON.stringify(row('Q003') && row('Q003').sources))
check('★ 没有卷问过它 → “缺什么”要说明白（不写“—”）',
  !!row('Q005') && (row('Q005').notes || []).some((n) => n.indexOf('没有卷问过它') >= 0),
  JSON.stringify(row('Q005') && row('Q005').notes))
check('★ 反例（不许模糊匹配）：题干不同就是两题，各自只有一个来源',
  !!row('Q002') && row('Q002').sources.length === 1 && row('Q002').sources[0].qid === 'S2',
  JSON.stringify(row('Q002') && row('Q002').sources))
check('★ 待答排在最前（列表先看“还欠什么”）', !!(rel.rows[0] && rel.rows[0].status === '待答'),
  rel.rows.map((r) => r.id + ':' + r.status).join(','))
check('★★ 统计口径与逐行结果对得上（数得出来的，不是另算一份）',
  rel.stats.questions === rel.rows.length
  && rel.stats.orphan === rel.rows.filter((r) => !r.sources.length).length
  && rel.stats.withCard === rel.rows.filter((r) => r.cards.length).length
  && rel.stats.withDeck === rel.rows.filter((r) => r.sources.length).length,
  JSON.stringify(rel.stats))
check('★ 不传 project = 全项目都出（4 条 + 别的项目 1 条 = 5 条）',
  qbank.bankRelations({ bank: BANK, decks: DECKS, cards: CARDS }).rows.length === 5,
  String(qbank.bankRelations({ bank: BANK, decks: DECKS, cards: CARDS }).rows.length))
check('★ 空输入不炸（题库空 = 0 行，不是 undefined）',
  qbank.bankRelations({}).rows.length === 0 && qbank.bankRelations({}).stats.questions === 0)

// ── B. 多卷批量处置（真落盘）────────────────────────────────────────────
console.log('\n== B. 多卷批量处置（真卷 md + 真 answers 文件）==')

const QLINES = (nav) => [
  `## A1 ${nav}`,
  `关于${nav}要怎么定？`,
  '- **A. 要**——代价甲',
  '- **B. 不要**——代价乙',
  '【验收线】出现反例即违约',
]
function writeDeck(name, lines) {
  fs.writeFileSync(path.join(QDIR, name + '.md'), lines.join('\n'), 'utf-8')
}
function approve(deckName, daysAgo = 40) {
  const at = new Date(Date.now() - daysAgo * 86400_000).toISOString()
  store.writeAnswers(deckName, { answers: { A1: { kind: 'pick', k: 'A' } }, approvedAt: at })
}

writeDeck('批量-甲', QLINES('甲'))
writeDeck('批量-乙', QLINES('乙'))
approve('批量-甲'); approve('批量-乙')
// 坏卷：文件在，但解析不出任何题（真实世界里 half-written / 手改坏的卷）
fs.writeFileSync(path.join(QDIR, '批量-坏卷.md'), '这不是问卷：只有一行说明，没有题目小节\n', 'utf-8')
const badPath = path.join(QDIR, '批量-坏卷.md')
const badBytes = fs.readFileSync(badPath).length
const badAnswersPath = path.join(QDIR, '批量-坏卷.answers.json')
const badAnswersBefore = fs.existsSync(badAnswersPath) ? fs.readFileSync(badAnswersPath, 'utf-8') : null

const r1 = store.batchDeckAction({ decks: ['批量-甲', '批量-乙', '批量-坏卷', ''], action: 'archive' })
check('★★ 批量归档：好的两卷真归档（archivedAt 落盘）',
  r1.done.length === 2 && r1.done.includes('批量-甲') && r1.done.includes('批量-乙')
  && !!store.getDeck('批量-甲').archivedAt && !!store.getDeck('批量-乙').archivedAt,
  JSON.stringify({ done: r1.done, failed: r1.failed }))
check('★★ 坏卷**不被处理**但被点名（批量不许静默跳过）',
  r1.failed.length === 1 && r1.failed[0].deck === '批量-坏卷' && !!r1.failed[0].error,
  JSON.stringify(r1.failed))
check('★ 合计对账：done + failed = 去重后的卷数（空字符串不算一卷）',
  r1.done.length + r1.failed.length === 3 && r1.ok === false,
  JSON.stringify({ done: r1.done.length, failed: r1.failed.length, ok: r1.ok }))
check('★ 那句话把“成功几卷、失败几卷”说清（不是一句“完成”）',
  /成功\s*2\s*卷/.test(r1.note) && /失败\s*1\s*卷/.test(r1.note), r1.note)
check('★★ 坏卷的文件与答案**一个字节都没动**（失败 = 什么都没改）',
  fs.readFileSync(badPath).length === badBytes
  && (badAnswersBefore === null
    ? !fs.existsSync(badAnswersPath) || fs.readFileSync(badAnswersPath, 'utf-8').length === 0
    : fs.readFileSync(badAnswersPath, 'utf-8') === badAnswersBefore),
  `bytes=${fs.readFileSync(badPath).length}/${badBytes}`)

// 作废：空理由必须被拒（作废理由三个月后是唯一能救命的线索）
const v1 = store.batchDeckAction({ decks: ['批量-甲'], action: 'void', reason: '' })
check('★★ 批量作废：空理由被拒，且那一卷**没被作废**（不许“先改后校验”）',
  v1.ok === false && v1.failed.length === 1 && !store.getDeck('批量-甲').voidedAt,
  JSON.stringify({ failed: v1.failed, voidedAt: store.getDeck('批量-甲').voidedAt }))
const v2 = store.batchDeckAction({ decks: ['批量-甲'], action: 'void', reason: '需求改过了，这卷答案不再作数' })
check('★ 批量作废：写了理由就真作废（voidedAt + 原因落盘）',
  v2.ok === true && !!store.getDeck('批量-甲').voidedAt
  && /需求改过了/.test(store.getDeck('批量-甲').voidReason || ''),
  JSON.stringify({ ok: v2.ok, voidedAt: store.getDeck('批量-甲').voidedAt, why: store.getDeck('批量-甲').voidReason }))
check('★ 没选任何卷 / 选了不存在的卷 → 正常报错，不抛异常',
  store.batchDeckAction({ decks: [], action: 'archive' }).ok === false
  && store.batchDeckAction({ decks: ['不存在的卷'], action: 'archive' }).failed.length === 1)

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`通过 ${pass} / 失败 ${fail}`)
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
