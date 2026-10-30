#!/usr/bin/env node
/**
 * 驳回返工台 —— 纯逻辑断言（2026-10-30）
 *
 * 用户原话：「驳回的东西好像也永远不看，是方寸的缺陷吗？」
 * 是。看板把「完成 / 驳回」默认折叠，而「驳回」不是终态 —— 它欠一个返工或一个"算了"。
 *
 * 真跑**编译产物** `dist/shared/rework.js`（纯逻辑，不碰 electron / 不起子进程 → 本机可跑）。
 * 这里钉的是**口径**，不是布局：
 *   ① 只认 status=驳回，已归档的算处置过；
 *   ② 理由取 `result_log` 里**最后一条**驳回记录（前几条是历史）；
 *   ③ 时间认三种写法（ISO / 秒 / 毫秒），认不出来给 NaN —— **绝不当 0**；
 *   ④ 没写理由也要列出来，但如实说"没写"。
 *
 * 运行：node scripts/test/e2e-rework.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'rework.js')

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
const { parseWhen, lastRejectReason, pickRework } = require(ART)

console.log('== ① 时间解析（三种写法，认不出 = NaN 不是 0）==')

const ISO_MS = Date.parse('2026-10-20T00:00:00.000Z')
check('ISO 字符串 → 毫秒', parseWhen('2026-10-20T00:00:00.000Z') === ISO_MS, String(parseWhen('2026-10-20T00:00:00.000Z')))
check('秒级 Unix（真实数据写 `更新: 1791024659`）→ 乘 1000', parseWhen(1791024659) === 1791024659000)
check('数字字符串同样按秒级', parseWhen('1791024659') === 1791024659000)
check('毫秒数字原样返回（>1e12 不乘 1000）', parseWhen(1791024659000) === 1791024659000)
check('★★ 空 / 0 / 坏串 / 负数一律 NaN（不许当成 1970 年 → 「晾了 20000 天」）',
  [parseWhen(''), parseWhen(null), parseWhen(undefined), parseWhen(0), parseWhen('0'),
    parseWhen('不是时间'), parseWhen(-5)].every((v) => Number.isNaN(v)),
  JSON.stringify([parseWhen(''), parseWhen(0), parseWhen('不是时间'), parseWhen(-5)]))

console.log('\n== ② 最近一次驳回理由 ==')

const LOG = [
  '[2026-10-01 10:00] 验收驳回：第一次：按钮点不动',
  '[2026-10-02 11:00] 验收通过',
  '[2026-10-20 09:30] 验收驳回：第二次：驳回后没人管了',
].join('\n')
check('★★ 取**最后一条**驳回理由（前几条是历史，不能拿旧的当这次为什么）',
  lastRejectReason(LOG) === '第二次：驳回后没人管了', lastRejectReason(LOG))
check('审批驳回同样认', lastRejectReason('[2026-10-20 09:30] 审批驳回：不需要这个方向') === '不需要这个方向')
check('★ 只写了「验收驳回」没写理由 → 空串（不编一句话替用户补）',
  lastRejectReason('[2026-10-20 09:30] 验收驳回') === '' &&
  lastRejectReason('[2026-10-20 09:30] 验收驳回：') === '')
check('没有任何驳回记录 → 空串', lastRejectReason('[2026-10-20 09:30] 验收通过：可以') === '')
check('结果记录为空 / null → 空串且不抛', lastRejectReason('') === '' && lastRejectReason(null) === '')
check('「驳回」只出现在正文里不算（只认裁决写的那种行）',
  lastRejectReason('这一段在讨论驳回的语义，不是一条裁决') === '')

console.log('\n== ③ 挑卡口径 ==')

const NOW = Date.parse('2026-10-30T00:00:00.000Z')
const T = (id, extra = {}) => Object.assign({
  id, title: '卡 ' + id, status: '驳回', updated: '2026-10-20T00:00:00.000Z',
  result_log: '[2026-10-20 09:30] 验收驳回：哪里不行',
}, extra)

const tasks = [
  T('old', { updated: '2026-10-10T00:00:00.000Z', result_log: '[2026-10-10 09:30] 验收驳回：十天前退的' }),
  T('mid'),
  T('done', { status: '完成' }),
  T('todo', { status: '待办' }),
  T('archived', { archived: true }),
  T('noreason', { updated: '2026-10-25T00:00:00.000Z', result_log: '[2026-10-25 09:30] 验收驳回' }),
  T('badtime', { updated: '认不出来', result_log: '[2026-10-25 09:30] 验收驳回：时间坏了' }),
  { id: 'fm-only', fm: { title: '只在 fm 里', status: '驳回', updated: '2026-10-28T00:00:00.000Z', result_log: '[2026-10-28 09:30] 审批驳回：fm 里的理由' } },
]
const r = pickRework(tasks, NOW)

check('★★ 只收「驳回」：完成 / 待办一张都不进',
  !r.rows.some((x) => x.id === 'done') && !r.rows.some((x) => x.id === 'todo'),
  r.rows.map((x) => x.id).join(','))
check('★★ 已归档的驳回卡不进（归档本身就是处置过了）', !r.rows.some((x) => x.id === 'archived'))
check('count === rows.length', r.count === r.rows.length, `${r.count} / ${r.rows.length}`)
check('★ 晾得最久的排最前（old 在前）', r.rows[0] && r.rows[0].id === 'old', r.rows.map((x) => x.id).join(','))
check('★ 时间认不出的排最后（不混进"最久"里）',
  r.rows[r.rows.length - 1] && r.rows[r.rows.length - 1].id === 'badtime', r.rows.map((x) => x.id).join(','))
check('★ 天数按"现在"算：10-10 → 20 天', r.rows.find((x) => x.id === 'old').ageDays === 20,
  String(r.rows.find((x) => x.id === 'old').ageDays))
check('★ 时间认不出 → ageDays = NaN（界面显示「时间不详」，不是 0 天）',
  Number.isNaN(r.rows.find((x) => x.id === 'badtime').ageDays))
check('oldestDays 只从算得出的里取（20 天）', r.oldestDays === 20, String(r.oldestDays))
check('★ 没写理由的 hasReason=false（要能点名）',
  r.rows.find((x) => x.id === 'noreason').hasReason === false)
check('★ 从 fm.result_log 读得到理由（跨语言字段摊平前也要对）',
  r.rows.find((x) => x.id === 'fm-only').reason === 'fm 里的理由',
  r.rows.find((x) => x.id === 'fm-only').reason)
check('标题从 fm.title 回退（顶层没摊平时）',
  r.rows.find((x) => x.id === 'fm-only').title === '只在 fm 里')
check('★ 文案把数字和事实一起说（不是只给一个数）',
  r.text.indexOf(String(r.count)) >= 0 && r.text.indexOf('20 天前') >= 0, r.text)

const empty = pickRework([T('a', { status: '完成' })], NOW)
check('★★ 一条都没有时明说「没有被驳回后没人管的卡」，不报 0 天', empty.count === 0 &&
  empty.text.indexOf('没有被驳回') >= 0, empty.text)
check('空清单 oldestDays = NaN', Number.isNaN(empty.oldestDays))
const noTime = pickRework([T('x', { updated: '' })], NOW)
check('★ 全都没时间时文案不许编天数（说"时间认不出来"）',
  noTime.text.indexOf('时间认不出来') >= 0, noTime.text)

// ── 防御：脏输入不抛 ──
check('传 null / 非数组不抛，返回空清单',
  pickRework(null, NOW).count === 0 && pickRework(undefined, NOW).count === 0 &&
  pickRework('x', NOW).count === 0)
check('缺 id 的条目直接跳过（不让它变成一行空卡）',
  pickRework([{ title: '没 id', status: '驳回' }], NOW).count === 0)

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) {
  console.log('\n失败项：')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}
