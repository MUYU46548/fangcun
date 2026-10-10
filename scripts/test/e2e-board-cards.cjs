#!/usr/bin/env node
/**
 * 看板「信息卡墙」派生逻辑断言（卡 20261010-003，2026-10-10）
 *
 * 真跑**编译产物** `dist/shared/boardCards.js`（纯逻辑，不要 electron、不起子进程 → 本机可跑）。
 * 判据一句话：**卡面上宁缺勿滥** —— 取不到的值宁可整格不渲染，也不能编个 0 或「—」糊上去。
 *
 * 运行：node scripts/test/e2e-board-cards.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'boardCards.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const { shortTaskId, priorityTone, buildBlockerIndex, boardCardMeta } = require(ART)

console.log('== 看板信息卡墙 · 派生逻辑 ==')

// ── ① 短 ID：只剥已知前缀，别的一律不动样 ──────────────────────────────
check("shortTaskId: task-20261010-003 → 20261010-003",
  shortTaskId('task-20261010-003') === '20261010-003')
check("★ shortTaskId: 别的形状的 id 原样返回（不擅自改样）",
  shortTaskId('T-1') === 'T-1' && shortTaskId('abc') === 'abc', shortTaskId('T-1'))
check("★ shortTaskId: 只有前缀没有正文 → 空串（不产出 'task-' 这种残渣）",
  shortTaskId('task-') === '')
check('shortTaskId: 空 / null / undefined → 空串（不产出 "null" 字面量）',
  shortTaskId('') === '' && shortTaskId(null) === '' && shortTaskId(undefined) === ''
  && shortTaskId('   ') === '', JSON.stringify(shortTaskId(null)))

// ── ② 优先级色档：只认三档中文，认不出来**不给色** ──────────────────────
check("priorityTone: 高/中/低 → high/mid/low",
  priorityTone('高') === 'high' && priorityTone('中') === 'mid' && priorityTone('低') === 'low')
check('★ priorityTone: 认不出来的值 → 空色档（不是拿某一档糊上去）',
  priorityTone('urgent') === '' && priorityTone('P0') === '' && priorityTone('normal') === '',
  priorityTone('urgent'))
check('priorityTone: 空 / null / undefined / 纯空白 → 空色档',
  priorityTone('') === '' && priorityTone(null) === '' && priorityTone(undefined) === ''
  && priorityTone('   ') === '')
check("priorityTone: 前后空白不影响识别（' 高 ' → high）", priorityTone(' 高 ') === 'high')

// ── ③ 阻塞索引 ────────────────────────────────────────────────────────
check('buildBlockerIndex: 空 / null / undefined → 空索引（不抛）',
  Object.keys(buildBlockerIndex([]).blockedBy).length === 0
  && Object.keys(buildBlockerIndex(null).blocks).length === 0
  && Object.keys(buildBlockerIndex(undefined).blockedBy).length === 0)

const chains = [
  { id: 'S1', title: '挡人的', isDone: false, blockedTasks: [
    { id: 'B', title: '被挡的', status: '待办' },
    { id: 'C', title: '也被挡', status: '进行中' }] },
  { id: 'S2', title: '另一个源', isDone: false, blockedTasks: [
    { id: 'C', title: '也被挡', status: '进行中' }] },
]
const idx = buildBlockerIndex(chains)
check('★ 一个任务被两个源挡 → blockedBy 记 2 条（不能只记最后一个）',
  (idx.blockedBy.C || []).length === 2 && (idx.blockedBy.C || []).join(',') === 'S1,S2',
  JSON.stringify(idx.blockedBy.C))
check('★ 同一个源重复列出同一个被挡任务 → 只记一次（不重复计数）',
  buildBlockerIndex([{ id: 'S', blockedTasks: [{ id: 'X' }, { id: 'X' }] }]).blockedBy.X.length === 1)
check('★ 已终态的被挡任务不算「还被卡着」（完成 / 驳回都不进 blockedBy）',
  Object.keys(buildBlockerIndex([{ id: 'S', isDone: false, blockedTasks: [
    { id: 'X', status: '完成' }, { id: 'Y', status: '驳回' }] }]).blockedBy).length === 0)
check('★ 自身已终态的源不进 blocks 计数（解一个做完的源没有意义）',
  !('S' in buildBlockerIndex([{ id: 'S', isDone: true, blockedTasks: [{ id: 'X', status: '待办' }] }]).blocks))
check('blocks 计数只算未完成的被挡任务',
  buildBlockerIndex([{ id: 'S', isDone: false, blockedTasks: [
    { id: 'X', status: '待办' }, { id: 'Y', status: '完成' }] }]).blocks.S === 1)
check('坏条目（null / 无 id）跳过而不是抛',
  buildBlockerIndex([null, { title: '没 id' }, { id: 'S', blockedTasks: [null, { title: 'x' }] }])
    .blocks.S !== undefined || true)

// ── ④ 卡片元数据 ──────────────────────────────────────────────────────
const t1 = { id: 'task-20261010-003', priority: '高', title: '看板新增任务视图' }
const m1 = boardCardMeta(t1, idx)
check('boardCardMeta: ID / 色档 / 原文三件都对',
  m1.id === '20261010-003' && m1.tone === 'high' && m1.priority === '高', JSON.stringify(m1))
check('boardCardMeta: 没有阻塞关系时两个数都是 0（界面据此整格不渲染）',
  boardCardMeta(t1, idx).blockedBy === 0 && boardCardMeta(t1, idx).blocks === 0
  && boardCardMeta(t1, idx).blocked === false)

const mC = boardCardMeta({ id: 'C', priority: '中' }, idx)
check('★ 被两个源挡的卡：blockedBy = 2 且 blocked = true',
  mC.blockedBy === 2 && mC.blocked === true, JSON.stringify(mC))
const mS1 = boardCardMeta({ id: 'S1', priority: '低' }, idx)
check('★ 挡人的卡：blocks = 2（它挡住 S1 那两个未完成任务）',
  mS1.blocks === 2 && mS1.blockedBy === 0, JSON.stringify(mS1))

check('★ 没有传索引（null / undefined）→ 阻塞两格是 0，而不是抛错或 NaN',
  boardCardMeta(t1, null).blockedBy === 0 && boardCardMeta(t1).blocks === 0
  && Number.isFinite(boardCardMeta(t1, null).blocks))

const noPrio = boardCardMeta({ id: 'task-X', priority: 'urgent' }, null)
check('★ 认不出的优先级：tone 为空 **且** 原文也不外泄（界面不会拿它当文案显示）',
  noPrio.tone === '' && noPrio.priority === '', JSON.stringify(noPrio))

check('★ 任务本身为空 / 没 id → 不抛，ID 为空串',
  boardCardMeta(null, idx).id === '' && boardCardMeta({}, idx).id === ''
  && boardCardMeta({ priority: '高' }, idx).id === '')

// ── ⑤ 纯函数：不改传入对象 ────────────────────────────────────────────
const before = JSON.stringify(chains)
buildBlockerIndex(chains)
boardCardMeta(t1, idx)
check('★ 纯函数：算完不修改传入的 chains / task（可被 Vue computed 反复求值）',
  JSON.stringify(chains) === before)

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
