#!/usr/bin/env node
/**
 * 阻塞链关键路径断言（卡 20260925-023，2026-10-06）
 *
 * 真跑**编译产物** `dist/shared/blockers.js`（纯逻辑，不需要 electron、不起子进程 → 本机可跑）。
 * 判据一句话：**解哪个阻塞最划算，要算传递效应** ——
 * A 挡住 B、B 又挡住 C，则解 A 的价值是 2，不是它直接挡住的 1。
 *
 * 运行：node scripts/test/e2e-blockers.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'blockers.js')

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
const { computeBlockerImpact, buildBlockerQueue } = require(ART)

console.log('== 阻塞链关键路径 ==')

// ── ① 空输入 / 坏输入 ────────────────────────────────────────────────
check('空数组 → 空结果', JSON.stringify(computeBlockerImpact([])) === '[]')
check('null / undefined → 空结果（不抛）',
  computeBlockerImpact(null).length === 0 && computeBlockerImpact(undefined).length === 0)

// ── ② 传递效应（本卡的核心判据）──────────────────────────────────────
const chain = [
  { id: 'A', title: 'A 卡', status: '进行中', isDone: false, blockedTasks: [
    { id: 'B', title: 'B 卡', status: '待办' },
    { id: 'C', title: 'C 卡', status: '待办' }] },
  { id: 'B', title: 'B 卡', status: '待办', isDone: false, blockedTasks: [
    { id: 'D', title: 'D 卡', status: '待办' },
    { id: 'E', title: 'E 卡', status: '待办' }] },
]
const r1 = computeBlockerImpact(chain)
const A = r1.find(x => x.id === 'A')
const B = r1.find(x => x.id === 'B')
check('★ 传递效应被算进去：A 直接挡 2 个，但解它一共解锁 4 个（B、C、D、E）',
  !!A && A.direct === 2 && A.unlock === 4, JSON.stringify(A))
check('★ B 只解锁它直接挡的 2 个（D、E）—— 它自己还被 A 挡着',
  !!B && B.unlock === 2, JSON.stringify(B))
check('★ 排序把"最划算的"放第一（解 A 值 4 > 解 B 值 2）',
  r1[0] && r1[0].id === 'A', JSON.stringify(r1.map(x => `${x.id}:${x.unlock}`)))

// ── ③ 一个任务被多个源挡着：解一个不够 ────────────────────────────────
const multi = [
  { id: 'P', title: 'P', status: '待办', isDone: false, blockedTasks: [{ id: 'Z', title: 'Z', status: '待办' }] },
  { id: 'Q', title: 'Q', status: '待办', isDone: false, blockedTasks: [{ id: 'Z', title: 'Z', status: '待办' }] },
]
const r2 = computeBlockerImpact(multi)
check('★ Z 被 P、Q 同时挡着 → 只解 P 时 Z 不算解锁（unlock=0/1 取决于谁先解，但不许两个都算成 1）',
  r2.every(x => x.unlock <= 1), JSON.stringify(r2))

// ── ④ 已终态的源不推荐 ──────────────────────────────────────────────
const donesrc = [
  { id: 'OLD', title: '早就完成的源', status: '完成', isDone: true, blockedTasks: [{ id: 'T1', title: 'T1', status: '待办' }] },
  { id: 'NEW', title: '还在挡人的源', status: '进行中', isDone: false, blockedTasks: [{ id: 'T2', title: 'T2', status: '待办' }] },
]
const r3 = computeBlockerImpact(donesrc)
check('★ 已完成的阻塞源不进推荐（否则会推荐"早就该完成"的东西）',
  r3.length === 1 && r3[0].id === 'NEW', JSON.stringify(r3.map(x => x.id)))

// ── ⑤ 已经终态的被阻塞任务不该算进"解锁收益" ──────────────────────────
const doneTask = [
  { id: 'S', title: 'S', status: '进行中', isDone: false, blockedTasks: [
    { id: 'DONE1', title: '已经完成的', status: '完成' },
    { id: 'LIVE1', title: '还在等', status: '待办' }] },
]
const r4 = computeBlockerImpact(doneTask)
check('★ 已完成的被阻塞任务不算解锁收益（解 S 只值 1，不是 2）',
  r4[0] && r4[0].unlock === 1, JSON.stringify(r4[0]))

// ── ⑥ 无副作用：不许改动传进来的数组 ─────────────────────────────────
const before = JSON.stringify(chain)
computeBlockerImpact(chain)
check('★ 纯函数：算完不修改传入的 chains（可重复调用 / 可被 Vue computed 反复求值）',
  JSON.stringify(chain) === before)

// ── ⑦ 决策队列（2026-10-31 暮雨第 7 条：这一页服务“先解哪一张”）────────
// 判据不是"能排出序"，而是三件不许含糊的事：
//   ① top 只能是**真有人受益**的那张（unlock > 0）；
//   ② 每行要能说出"解了谁"（列名字，不是只给个数字）；
//   ③ 解了没人受益的源仍要列出来，但必须明说没收益（不许悄悄藏掉）。
const q = buildBlockerQueue(chain)
check('★ 队列 total / blocked 与输入真身对得上',
  q.total === computeBlockerImpact(chain).length && q.blocked > 0,
  `total=${q.total} blocked=${q.blocked}`)
check('★★ top 必须是“真有人受益”的那张（unlock > 0，不推荐白干）',
  !!q.top && q.top.unlock > 0, JSON.stringify(q.top && { id: q.top.id, unlock: q.top.unlock }))
check('★ 每行给出解锁名单（最多 5 个，不是只给数字）',
  q.rows.every((r) => Array.isArray(r.unlockTitles) && r.unlockTitles.length <= 5) &&
  q.rows.some((r) => r.unlockTitles.length > 0),
  JSON.stringify(q.rows.map((r) => r.unlockTitles.length)))
check('★ 一行结论把数字与"先解谁"一起说（界面直印，不重算）',
  q.text.indexOf(String(q.total)) >= 0 && (!q.top || q.text.indexOf(q.top.title) >= 0), q.text)

const qInert = buildBlockerQueue([
  { id: 'IDLE', title: '解了也没用', status: '进行中', isDone: false, blockedTasks: [{ id: 'X', title: '早就做完', status: '完成' }] },
])
check('★★ 解了没人受益的源：仍列出来、但 top 为 null 且文案明说没有值得先解的',
  qInert.total === 1 && qInert.top === null && qInert.inert === 1 && /没有值得先解/.test(qInert.text),
  qInert.text)
check('★ 一条阻塞都没有 → 明说"没有阻塞"，不报 0 张挡着',
  buildBlockerQueue([]).text.indexOf('没有阻塞') >= 0, buildBlockerQueue([]).text)
check('★ 脏输入不抛（null / 非数组）', buildBlockerQueue(null).total === 0 && buildBlockerQueue('x').total === 0)

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
