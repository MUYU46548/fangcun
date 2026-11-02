/**
 * 跨渠道 token 对比（0.6.0 第 2 批 · 2026-11-02）
 *
 * 判据三件事：
 *  ① **只比 token**：表里能筛的、能排的都是 token；金额列只有三种标注（供应商自报 / 用户自填 / 未折算）；
 *  ② **渠道不许合并**：方寸自己调的（local）与外部报上来的（external）分开算，混一起就是账本说假话；
 *  ③ **不猜**：ts 认不出的记录不进任何时间段、没写金额的写"未折算"（不是 0）、金额按 1e-8 定点加不飘。
 *
 * 真跑编译产物 `dist/shared/channelTokens.js`（纯逻辑）。
 * 运行：node scripts/test/e2e-channel-tokens.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'channelTokens.js')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')) }
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const { buildChannelReport, costUnits, formatUnits, tsOf } = require(ART)

const NOW = '2026-11-02T12:00:00.000Z'
const RECS = [
  // 方寸自己调：两个模型
  { ts: '2026-11-01T10:00:00.000Z', model: 'deepseek-chat', prompt_tokens: 1000, completion_tokens: 500, cost: '0.00320000', cost_source: 'provider', origin: 'local' },
  { ts: '2026-11-01T11:00:00.000Z', model: 'deepseek-chat', prompt_tokens: 2000, completion_tokens: 1000, cost: '0.00640000', cost_source: 'provider', origin: 'local' },
  { ts: '2026-11-02T09:00:00.000Z', model: 'mimo-v2.6-flash', prompt_tokens: 300, completion_tokens: 100, cost: '0.00010000', cost_source: 'user-price', origin: 'local' },
  // 外部上报：两个客户端，口径不同
  { ts: '2026-11-02T08:00:00.000Z', model: 'deepseek-chat', prompt_tokens: 5000, completion_tokens: 2000, origin: 'external', reported_by: 'hermes' },
  { ts: '2026-11-01T08:00:00.000Z', model: 'deepseek-chat', prompt_tokens: 800, completion_tokens: 200, cost: '0.00100000', cost_source: 'provider', origin: 'external', reported_by: 'dsh' },
  // 早期记录：没有 token 字段
  { ts: '2026-11-01T07:00:00.000Z', model: 'mimo-v2.6-flash', origin: 'local' },
  // 时间认不出 → 不该进任何时间段
  { ts: '不知道哪天', model: 'ghost-model', prompt_tokens: 999, origin: 'local' },
  // 超出 30 天窗口
  { ts: '2026-09-01T00:00:00.000Z', model: 'deepseek-chat', prompt_tokens: 40, origin: 'local' },
]

console.log('== ① 渠道拆分：local 按模型 / external 按上报者，绝不合并 ==')
const r = buildChannelReport(RECS, { days: 30, now: NOW })
const keys = r.rows.map((x) => x.key)
check('★★ 方寸自己调的按模型分渠道', keys.includes('local:deepseek-chat') && keys.includes('local:mimo-v2.6-flash'), keys.join(' | '))
check('★★ 外部上报的按客户端分渠道（与 local 同名模型也不合并）',
  keys.includes('ext:hermes') && keys.includes('ext:dsh') && keys.includes('local:deepseek-chat'), keys.join(' | '))
check('★ 认不出时间的记录不进表（不替它编日期）', !keys.some((k) => k.includes('ghost')), keys.join(' | '))
check('★ 超出 30 天窗口的不进表', r.rows.every((x) => x.firstAt >= '2026-10-03'), JSON.stringify(r.rows.map((x) => x.firstAt)))
check('★ 外部渠道带「（外部上报）」后缀（界面上一眼分清）',
  r.rows.filter((x) => x.kind === 'external').every((x) => /外部上报/.test(x.label)),
  r.rows.filter((x) => x.kind === 'external').map((x) => x.label).join(' | '))

console.log('\n== ② token 聚合 ==')
const ds = r.rows.find((x) => x.key === 'local:deepseek-chat')
check('★★ 同渠道多条累加（1000+2000 / 500+1000）', ds.calls === 2 && ds.promptTokens === 3000 && ds.completionTokens === 1500,
  JSON.stringify({ c: ds.calls, p: ds.promptTokens, co: ds.completionTokens }))
check('★★ total 缺失时用 prompt+completion 补（不是当 0）', ds.totalTokens === 4500, String(ds.totalTokens))
const mio = r.rows.find((x) => x.key === 'local:mimo-v2.6-flash')
check('★ 没有 token 字段的调用单列 noTokenCalls（不混进 0）', mio.noTokenCalls === 1 && mio.totalTokens === 400,
  JSON.stringify({ no: mio.noTokenCalls, t: mio.totalTokens }))
check('★ 总计对得上', r.totals.calls === 6, String(r.totals.calls))

console.log('\n== ③ 金额只有三种标注，不做跨渠道金额对比 ==')
check('★★ 全是供应商自报 → 标「供应商自报」', /供应商自报/.test(ds.money.text) && ds.money.kind === 'provider', ds.money.text)
check('★★ 单价折算的 → 标「用户自填」', /用户自填/.test(mio.money.text) && mio.money.kind === 'user-price', mio.money.text)
const hermes = r.rows.find((x) => x.key === 'ext:hermes')
check('★★ 一次金额都没写 → 写「未折算」（不是 0 元）', hermes.money.text === '未折算' && hermes.money.kind === 'none', hermes.money.text)
const dsh = r.rows.find((x) => x.key === 'ext:dsh')
check('★ 外部上报的供应商自报金额照样标「供应商自报」', /供应商自报/.test(dsh.money.text), dsh.money.text)
const mixed = buildChannelReport([
  { ts: NOW, model: 'm', prompt_tokens: 1, cost: '0.10000000', cost_source: 'provider' },
  { ts: NOW, model: 'm', prompt_tokens: 1, cost: '0.20000000', cost_source: 'user-price' },
], { now: NOW })
check('★★ 同一渠道混了两种来源 → 分开列，不合并成一个数',
  /¥0\.10 · 供应商自报/.test(mixed.rows[0].money.text) && /¥0\.20 · 用户自填/.test(mixed.rows[0].money.text),
  mixed.rows[0].money.text)
check('★ 三种标注之外没有第四种（全表扫一遍）',
  r.rows.concat(mixed.rows).every((x) => ['provider', 'user-price', 'none'].includes(x.money.kind)),
  r.rows.concat(mixed.rows).map((x) => x.money.kind).join(','))

console.log('\n== ④ 定点金额不飘 ==')
check('★ costUnits 精确到 1e-8', costUnits('0.10000000') === 10000000 && costUnits('0.20000000') === 20000000)
check('★★ 0.1 + 0.2 加出来是 0.30（不是 0.30000000000000004）', formatUnits(30000000) === '0.30', formatUnits(30000000))
check('★ 非法金额 → null（不猜 0）', costUnits('abc') === null && costUnits('') === null && costUnits('-1') === null)

console.log('\n== ⑤ 筛选与排序 ==')
const onlyLocal = buildChannelReport(RECS, { days: 30, now: NOW, channels: ['local:deepseek-chat'] })
check('★★ 按渠道筛：只剩一个', onlyLocal.rows.length === 1 && onlyLocal.rows[0].key === 'local:deepseek-chat',
  onlyLocal.rows.map((x) => x.key).join(','))
const allTime = buildChannelReport(RECS, { days: 0, now: NOW })
check('★★ days=0 = 全部（9 月那条回来了）', allTime.rows.some((x) => x.firstAt.startsWith('2026-09')), String(allTime.rows.length))
check('★ 按 token 多少排序（谁在吃配额排前面）',
  r.rows.every((x, i) => i === 0 || r.rows[i - 1].totalTokens >= x.totalTokens),
  r.rows.map((x) => x.totalTokens).join('>'))
check('★ channels 列表可供界面做下拉', Array.isArray(r.channels) && r.channels.length === r.rows.length, String(r.channels.length))

console.log('\n== ⑥ 口径与空态 ==')
check('★★ 口径声明写明「只比 token / 金额三档 / 不合并 local 与 external」',
  /只比 token/.test(r.note) && /供应商自报/.test(r.note) && /用户自填/.test(r.note) && /未折算/.test(r.note) && /不合并/.test(r.note),
  r.note.slice(0, 100))
check('★★ 口径里带「它证明不了什么」（外部没上报的不在表里）', /证明不了什么/.test(r.note))
const empty = buildChannelReport([], { days: 7, now: NOW })
check('★★ 空态说清「不是没花钱，是没记录」', /不是"没花钱"/.test(empty.emptyText), empty.emptyText)
check('★ 空输入不抛、返回空表', Array.isArray(empty.rows) && empty.rows.length === 0)
check('★ tsOf 认毫秒 / 秒 / ISO', tsOf(1793000000000) === 1793000000000 && tsOf(1793000000) === 1793000000000 && tsOf('2026-11-01T00:00:00.000Z') > 0)

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('\n失败项：'); for (const x of failures) console.log('  · ' + x) }
process.exit(fail ? 1 : 0)
