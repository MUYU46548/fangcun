#!/usr/bin/env node
/**
 * 题库 e2e（2026-11-09）
 *
 * 暮雨拍板（D-060）：题库落独立 `task-data/question-bank.md`；已答 / 否决 / 你自判
 * 永不复问；作废可重问。本套钉住这四句，外加“同一道题被问第二次 = bug”：
 *   ① 指纹对空白/标点/大小写稳定；题号前缀不参与；
 *   ② 批准 → 题库落状态（已答 / 你自判 / 否决 / 作废）；
 *   ③ 换卷名再问已答题 → **拒**，且目录里不长新文件；
 *   ④ 你自判进黑名单（也不许再问）；
 *   ⑤ 作废允许重问（需求变过）；
 *   ⑥ 题库里的「待答」会挡住闸（D-060 后半句：所有相关旧题都已答）。
 *
 * 运行：node scripts/test/e2e-qn-bank.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')
const TMP = mkTmp('qn-bank-')
const DATA = path.join(TMP, 'data')
const QDIR = path.join(DATA, 'task-data', 'questionnaires')
process.env.FC_TEST_USERDATA = path.join(TMP, 'userdata')
for (const d of [DATA, path.join(DATA, 'task-data'), QDIR, process.env.FC_TEST_USERDATA]) fs.mkdirSync(d, { recursive: true })

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const data = require(path.join(DIST, 'main', 'data', 'index.js'))
data.setDataDir(DATA)
const store = require(path.join(DIST, 'main', 'data', 'questionnaires.js'))
const bank = require(path.join(DIST, 'main', 'data', 'questionBank.js'))
const gate = require(path.join(DIST, 'main', 'data', 'qnGate.js'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

const spec = (title, ask, project = 'fangcun-base') => ({
  title, project, deck: title,
  questions: [{
    id: 'S1', nav: '形状', ask,
    options: [
      { k: 'A', t: '甲', d: '代价甲' },
      { k: 'B', t: '乙', d: '代价乙' },
    ],
    src: '测试夹具', line: '出现反例即违约',
  }],
})

console.log('== ① 指纹稳定 ==')
{
  const a = bank.fingerprintOf('S1 做一件还是两件？')
  const b = bank.fingerprintOf('做一件还是两件')
  check('★★ 题号前缀 / 标点 / 空白不影响指纹', a === b, `${a} vs ${b}`)
  check('★ 不同问题指纹不同', bank.fingerprintOf('做甲还是做乙') !== bank.fingerprintOf('先做甲还是先做乙'))
}

console.log('== ② 批准 → 落状态 ==')
{
  const r = store.createDeck({ spec: spec('题库卷A', '题库问：先做甲还是先做乙？') })
  check('★ 新题可以出卷', r.ok === true, r.error)
  store.writeAnswers('题库卷A', { answers: { S1: { kind: 'pick', k: 'A' } } })
  const ap = store.approveDeck('题库卷A')
  check('★ 批准成功', ap.ok === true, ap.error)
  const entries = bank.loadBank()
  const hit = entries.find((x) => x.fingerprint === bank.fingerprintOf('题库问：先做甲还是先做乙？'))
  check('★★ 批准后题库里有这题，状态=已答', !!hit && hit.status === '已答', JSON.stringify(hit))
  check('★★ 题库条目带项目与出处', !!hit && hit.project === 'fangcun-base' && /题库卷A/.test(hit.source), JSON.stringify(hit))
  check('★ 答案原文进了题库', !!hit && /A/.test(hit.answer), hit && hit.answer)
}

console.log('== ③ 同一道题不许问第二次 ==')
{
  const before = fs.readdirSync(QDIR).length
  const r = store.createDeck({ spec: spec('题库卷B', '题库问：先做甲还是先做乙') })
  check('★★ 换卷名再问已答题 → 拒', r.ok === false && /答案/.test(r.error || ''), r.error)
  check('★★ 拒后不长新文件', fs.readdirSync(QDIR).length === before)
}

console.log('== ④ 你自判进黑名单 / 作废可重问 ==')
{
  const r = store.createDeck({ spec: spec('自判卷', '这题你自判就行：甲还是乙？') })
  check('★ 自判题可以出卷', r.ok === true, r.error)
  store.writeAnswers('自判卷', { answers: { S1: { kind: 'self' } } })
  const ap = store.approveDeck('自判卷')
  check('★ 只答“你自判”也能批准（那也是一种处置）', ap.ok === true, ap.error)
  const hit = bank.loadBank().find((x) => x.fingerprint === bank.fingerprintOf('这题你自判就行：甲还是乙？'))
  check('★★ 你自判 → 题库状态=你自判', !!hit && hit.status === '你自判', JSON.stringify(hit))
  const again = store.createDeck({ spec: spec('自判卷2', '这题你自判就行：甲还是乙') })
  check('★★ 你自判的题不许再问', again.ok === false, again.error)

  bank.upsertEntries([{ ask: '作废过的问题：甲还是乙？', project: 'fangcun-base', status: '作废', answer: '旧答案', source: '测试' }])
  const reask = store.createDeck({ spec: spec('作废重问卷', '作废过的问题：甲还是乙') })
  check('★ 作废的题允许重问（需求变过）', reask.ok === true, reask.error)
}

console.log('== ⑤ 待答会挡住闸（D-060）==')
{
  bank.upsertEntries([{ ask: '还没答的题：做甲还是做乙？', project: 'fangcun-base', status: '待答', source: '种子' }])
  const seeded = bank.loadBank().find((x) => x.ask === '还没答的题：做甲还是做乙？')
  check('★ 种子待答拿到稳定 id', !!seeded && /^Q-\d+$/.test(seeded.id), seeded && seeded.id)
  const r = store.createDeck({ spec: spec('闸前卷', '闸前先问：甲还是乙？') })
  check('★ 新卷能出', r.ok === true, r.error)
  store.writeAnswers('闸前卷', { answers: { S1: { kind: 'pick', k: 'A' } } })
  store.approveDeck('闸前卷')
  const g = gate.gateForDeck('闸前卷', 'fangcun-base')
  check('★★ 题库还有待答题 → 闸不放行', g.ok === false && /题库里还有/.test(g.error || ''), g.error)
  check('★ 闸点名未答的题库条目', g.open && g.open.some((x) => /^Q-\d+$/.test(x.id)), JSON.stringify(g.open))
}

console.log('== ⑥ 从题库提请的题：问法变了也要按 ref 归并 ==')
{
  // 清掉 ⑤ 留下的待答，否则闸会因为“另一条没答”而拒 —— 那会把本节的断言带偏。
  bank.upsertEntries([{ ask: '还没答的题：做甲还是做乙？', project: 'fangcun-base', status: '已答', answer: '⑤ 测试清理' }])
  bank.upsertEntries([{ ask: '原题：这件事到底怎么定？', project: 'fangcun-base', status: '待答', source: '种子2' }])
  const before = bank.loadBank().find((x) => x.ask === '原题：这件事到底怎么定？')
  const r = store.createDeck({
    spec: {
      title: '归并卷', project: 'fangcun-base', deck: '归并卷',
      questions: [{
        id: 'S1', nav: '复问', ask: '换个问法：这件事怎么定下来？',
        options: [{ k: 'A', t: '甲', d: '代价甲' }, { k: 'B', t: '乙', d: '代价乙' }],
        src: `题库 ${before.id}；原题改问法`, line: '出现反例即违约',
      }],
    },
  })
  check('★ 换问法也能出卷（指纹不同但 ref 指回同一条）', r.ok === true, r.error)
  store.writeAnswers('归并卷', { answers: { S1: { kind: 'pick', k: 'A' } } })
  store.approveDeck('归并卷')
  const all = bank.loadBank()
  const hit = all.find((x) => x.id === before.id)
  check('★★ 按 ref 归并：原条目变已答，不是新长一条', !!hit && hit.status === '已答', JSON.stringify(hit))
  check('★★ 没有再长出一条“换个问法”的新条目', !all.some((x) => x.ask.includes('换个问法')), all.map((x) => x.ask).slice(-3))
  const g = gate.gateForDeck('归并卷', 'fangcun-base')
  check('★★ 归并后闸能过（题库不再有待答）', g.ok === true, g.error)
}

console.log('== ⑦ 时间口径：落库时间必须按本地时区（2026-11-10 用户当场指出 22:07 显成 14:07）==')
{
  const time = require(path.join(DIST, 'shared', 'time.js'))
  const iso = '2026-11-09T14:07:16.249Z'
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  const expectLocal = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  const got = time.formatLocalStamp(iso)
  check('★★ 「已落库」时间按本地时区显示', got === expectLocal, `${got} vs ${expectLocal}`)
  // 反例：UTC 截断（旧实现 approved.slice(0,16).replace('T',' ')）在东八区必然对不上
  const utcSlice = iso.slice(0, 16).replace('T', ' ')
  if (new Date().getTimezoneOffset() !== 0) {
    check('★★ 不再是 UTC 截断（旧写法会显示 14:07）', got !== utcSlice, `got=${got} utcSlice=${utcSlice}`)
  }
  check('★ 坏输入给空串，不印 Invalid Date', time.formatLocalStamp('') === '' && time.formatLocalStamp('不是时间') === '')
  check('★★ 日历日按本地算（不能用 toISOString）',
    time.localDay(new Date(2026, 10, 10, 1, 30)) === '2026-11-10',
    time.localDay(new Date(2026, 10, 10, 1, 30)))
}

console.log('== ⑧ 题库规模：批量入队 / 去重 / 冲突不覆盖 / 下一批 ≤6 ==')
{
  const before = bank.bankStats('fangcun-base')
  const asks = [
    '规模问 1：先做甲还是先做乙？', '规模问 2：谁拍板？', '规模问 3：多久收一次？',
    '规模问 4：做几层？', '规模问 5：失败怎么办？', '规模问 6：谁来验？',
    '规模问 7：要不要备份？', '规模问 8：先给谁用？', '规模问 9：什么时候停？',
  ]
  const r1 = bank.importQuestions(asks.map((ask) => ({ ask, project: 'fangcun-base', source: '规模测试' })))
  check('★ 批量入队一次进 9 题', r1.added === 9 && r1.conflicts.length === 0, JSON.stringify(r1.conflicts))
  check('★★ 入队即「待答」，进度看得见（+9）', bank.bankStats('fangcun-base').open === before.open + 9,
    `${before.open} → ${bank.bankStats('fangcun-base').open}`)
  check('★ 每题拿到 Q-xxxx id', r1.items.filter((x) => asks.includes(x.ask)).every((x) => /^Q-\d+$/.test(x.id)))

  const r2 = bank.importQuestions(asks.map((ask) => ({ ask, project: 'fangcun-base' })))
  check('★★ 再灌一遍不长新条（按指纹合并）', r2.added === 0 && r2.merged === 9, `added=${r2.added} merged=${r2.merged}`)
  check('★ 合并后待答数不变', bank.bankStats('fangcun-base').open === before.open + 9)

  // 已定案的题：**拒绝**且原答案一个字节不动
  const answeredAsk = '题库问：先做甲还是先做乙？'
  const answeredBefore = bank.loadBank().find((x) => x.ask === answeredAsk)
  const r3 = bank.importQuestions([{ ask: answeredAsk, project: 'fangcun-base', source: '想覆盖' }])
  const answeredAfter = bank.loadBank().find((x) => x.ask === answeredAsk)
  check('★★ 已答题不许被入队覆盖 → 报冲突', r3.conflicts.length === 1 && r3.conflicts[0].id === answeredBefore.id,
    JSON.stringify(r3.conflicts))
  check('★★ 冲突时原答案逐字不动',
    answeredAfter.status === answeredBefore.status && answeredAfter.answer === answeredBefore.answer,
    `${answeredAfter.status}/${answeredAfter.answer}`)

  // 作废 = 可重问：入队时重新排队
  bank.upsertEntries([{ ask: '规模问：作废后要不要重排队？', project: 'fangcun-base', status: '作废', answer: '旧答案' }])
  const rq = bank.importQuestions([{ ask: '规模问：作废后要不要重排队？', project: 'fangcun-base' }])
  const requeued = bank.loadBank().find((x) => x.ask === '规模问：作废后要不要重排队？')
  check('★ 作废的题入队即重新排队（状态回到待答）', rq.merged === 1 && requeued.status === '待答', requeued.status)

  const next = bank.nextOpen('fangcun-base', 6)
  check('★★ 下一批默认 6 题且全是待答', next.length === 6 && next.every((x) => x.status === '待答'), String(next.length))
  check('★ 下一批按题库顺序取（不跳题）', next[0].id === bank.openBank('fangcun-base')[0].id, next[0].id)
  check('★ 批大小有上限（传 999 也不一次全给你）', bank.nextOpen('fangcun-base', 999).length <= 20)
}

console.log('== ⑨ 验收线随答案落进题库（卷删了线还在）==')
{
  const ask = '规模问：验收线会不会跟着卷一起没？'
  const r = store.createDeck({
    spec: {
      title: '验收线落库卷', project: 'fangcun-base', deck: '验收线落库卷',
      questions: [{
        id: 'S1', nav: '线', ask,
        options: [{ k: 'A', t: '甲', d: '代价甲' }, { k: 'B', t: '乙', d: '代价乙' }],
        src: '测试夹具', line: '这条线必须留在题库里',
      }],
    },
  })
  check('★ 出卷成功', r.ok === true, r.error)
  store.writeAnswers('验收线落库卷', { answers: { S1: { kind: 'pick', k: 'A' } } })
  store.approveDeck('验收线落库卷')
  const hit = bank.loadBank().find((x) => x.ask === ask)
  check('★★ 批准后题库里有验收线', !!hit && hit.line === '这条线必须留在题库里', hit && hit.line)

  // 模拟“卷被删/归档”：把 md 移走（answers.json 也移走），题库必须自己撑住
  const mdPath = path.join(QDIR, '验收线落库卷.md')
  const ansPath = path.join(QDIR, '验收线落库卷.answers.json')
  fs.renameSync(mdPath, mdPath + '.bak')
  if (fs.existsSync(ansPath)) fs.renameSync(ansPath, ansPath + '.bak')
  const after = bank.loadBank().find((x) => x.ask === ask)
  check('★★ 卷删了，题库里的答案与验收线都还在', !!after && after.status === '已答' && after.line === '这条线必须留在题库里',
    after && `${after.status}/${after.line}`)
  fs.renameSync(mdPath + '.bak', mdPath)
  if (fs.existsSync(ansPath + '.bak')) fs.renameSync(ansPath + '.bak', ansPath)
}

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('失败明细：'); failures.forEach((f) => console.log('  · ' + f)) }
process.exit(fail === 0 ? 0 : 1)
