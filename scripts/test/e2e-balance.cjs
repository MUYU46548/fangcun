/**
 * 卡 005「花销与归因」· 账户口径（余额差值）2026-10-25
 *
 * 暮雨给的参考实现（DSH 小鲸鱼挂件）点破了一件事：**金额准不是因为价格表准，
 * 而是因为根本不经过价格表** —— 官方余额接口的下降额就是真扣的钱。
 * 所以这里钉的是三件：
 *  ① 定点算账（1e-8 单位、BigInt）—— 浮点会让你对账时差两分钱；
 *  ② 三条记账规矩：下降=消费、上升=充值（不冲抵）、首次只立基线；
 *  ③ 坏数据/坏账本**不许糊过去**：解析失败不写账，账本坏了备份后拒绝覆盖。
 *
 * 反例怎么打：把 `applyObservation` 里 recharge 分支改成 `spent: spent - d.amount` → ③ 组红；
 *   把 `parseAmount` 换成 `Number(v)`（浮点）→ ① 组红。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

const REPO = path.resolve(__dirname, '../..')
const B = require(path.join(REPO, 'desktop/dist/shared/balance.js'))

let pass = 0
const fails = []
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fails.push(name + (extra ? '  → ' + extra : '')); console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')) }
}

// ── ① 定点金额 ──────────────────────────────────────────────────────────
console.log('\n── ① 定点金额（不走浮点）──')
check('"110.00" → 110 元（1e-8 单位）', B.parseAmount('110.00') === 11000000000n, String(B.parseAmount('110.00')))
check('数字 2.5 → 2.5 元', B.parseAmount(2.5) === 250000000n, String(B.parseAmount(2.5)))
check('★ 0.1 + 0.2 在定点里恰好是 0.3（浮点会变 0.30000000000000004）',
  B.formatAmount(B.parseAmount('0.1') + B.parseAmount('0.2'), 2) === '0.30')
check('超 8 位小数被截断（不做四舍五入 —— 账本不给自己加分）',
  B.parseAmount('0.123456789') === 12345678n, String(B.parseAmount('0.123456789')))
check('负数（OpenRouter 可能欠费）', B.parseAmount('-1.25') === -125000000n)
check('认不出的值一律 null，不猜',
  B.parseAmount('abc') === null && B.parseAmount('') === null && B.parseAmount(null) === null
  && B.parseAmount(undefined) === null && B.parseAmount(NaN) === null && B.parseAmount({}) === null)
check('formatAmount 保留 2 位（人话）', B.formatAmount(123456789n, 2) === '1.23')
check('formatAmount 8 位（账本落盘用）', B.formatAmount(123456789n, 8) === '1.23456789')

// ── ② 差值语义 ─────────────────────────────────────────────────────────
console.log('\n── ② 差值语义 ──')
{
  const d1 = B.computeDelta(B.parseAmount('100'), B.parseAmount('95.5'))
  check('余额下降 → spend，金额 = 差额', d1.kind === 'spend' && d1.amount === B.parseAmount('4.5'), JSON.stringify(d1, (k, v) => typeof v === 'bigint' ? String(v) : v))
  const d2 = B.computeDelta(B.parseAmount('100'), B.parseAmount('150'))
  check('余额上升 → recharge（充值/赠金）', d2.kind === 'recharge' && d2.amount === B.parseAmount('50'))
  const d3 = B.computeDelta(B.parseAmount('100'), B.parseAmount('100'))
  check('余额不变 → flat（不写账，免得账本被 0 撑爆）', d3.kind === 'flat' && d3.amount === 0n)
  check('任一侧没有数据 → null（宁缺不猜）',
    B.computeDelta(null, B.parseAmount('1')) === null && B.computeDelta(B.parseAmount('1'), null) === null)
}

// ── ③ 记账规矩（三条） ──────────────────────────────────────────────────
console.log('\n── ③ 记账规矩 ──')
{
  let t = B.applyObservation({ ...B.EMPTY_TOTALS }, B.parseAmount('100'))
  check('★ 首次观测只立基线：消费 0、余额记下（不假装知道之前花了多少）',
    t.spent === 0n && t.lastBalance === B.parseAmount('100') && t.observations === 1)
  t = B.applyObservation(t, B.parseAmount('97.5'))
  check('第二次下降 → 消费 2.5', t.spent === B.parseAmount('2.5'), B.formatAmount(t.spent, 8))
  t = B.applyObservation(t, B.parseAmount('197.5'))
  check('★ 充值 100 **不冲抵**已记的消费（这是最容易写错的一条）',
    t.spent === B.parseAmount('2.5') && t.recharged === B.parseAmount('100'),
    'spent=' + B.formatAmount(t.spent, 2) + ' recharged=' + B.formatAmount(t.recharged, 2))
  t = B.applyObservation(t, B.parseAmount('197.5'))
  check('同值重复观测：消费/充值都不变，只 +1 次观测', t.spent === B.parseAmount('2.5') && t.observations === 4)
  t = B.applyObservation(t, null)
  check('非法余额观测 → 整条丢弃，不动账', t.observations === 4 && t.lastBalance === B.parseAmount('197.5'))
}

// ── ④ 两家余额接口的解析（形状按官方文档）─────────────────────────────
console.log('\n── ④ 余额接口解析 ──')
{
  const ds = B.parseDeepseekBalance({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
  })
  check('★ DeepSeek：total_balance 是**字符串**，照样转成定点',
    B.isBalanceOk(ds) && ds.balance === B.parseAmount('110.00') && ds.currency === 'CNY')
  const dsMulti = B.parseDeepseekBalance({
    balance_infos: [{ currency: 'USD', total_balance: '5.00' }, { currency: 'CNY', total_balance: '36.00' }],
  })
  check('多币种优先取 CNY（否则会拿美元当人民币加进账本）',
    B.isBalanceOk(dsMulti) && dsMulti.currency === 'CNY' && dsMulti.balance === B.parseAmount('36.00'))
  const dsBad = B.parseDeepseekBalance({ foo: 1 })
  check('★ 形状不对 → 明确失败给原因（不返回 0 元冒充"没花钱"）',
    !B.isBalanceOk(dsBad) && /balance_infos/.test(dsBad.reason))

  const or = B.parseOpenRouterCredits({ data: { total_credits: 10, total_usage: 2.5 } })
  check('★ OpenRouter：余额 = credits - usage（定点减）',
    B.isBalanceOk(or) && or.balance === B.parseAmount('7.5') && or.currency === 'USD')
  const orBad = B.parseOpenRouterCredits({ data: { total_credits: 10 } })
  check('OpenRouter 缺字段 → 失败给原因', !B.isBalanceOk(orBad) && /total_credits/.test(orBad.reason))
}

// ── ④b 逐笔金额（B 档：用户自填单价）与月度聚合 ──────────────────────
console.log('\n── ④b 单价折算与月度聚合 ──')
function pricingChecks() {
  const P = require(path.join(REPO, 'desktop/dist/shared/pricing.js'))

  // 清洗：空名/非法价的行丢掉，不猜成 0（0 会把花销静默算成"免费"）
  const rows = P.cleanPriceRows([
    { model: 'deepseek-chat', in: '2', out: '8' },
    { model: '  ', in: '1', out: '1' },
    { model: 'bad-price', in: 'abc', out: '1' },
    { model: 'neg', in: '-1', out: '1' },
    { model: 'DEEPSEEK-CHAT', in: '9', out: '9' },   // 大小写重复 → 保留第一条
  ])
  check('★ 清洗单价表：空名/非法价/负价的行全丢，同名（不分大小写）只留第一条',
    rows.length === 1 && rows[0].model === 'deepseek-chat', JSON.stringify(rows))
  check('清洗后的价格是定点字符串（不存浮点）', rows[0].in === '2.00000000', rows[0].in)

  const hit = P.findPrice(rows, 'DeepSeek-Chat')
  check('★ 找单价不区分大小写', !!hit && hit.in === B.parseAmount('2') && hit.out === B.parseAmount('8'))
  check('没填过的模型 → null（= 未折算，不是 0 元）', P.findPrice(rows, 'mimo-v2.6-flash') === null)

  // 折算：2000 输入 + 1000 输出，价 2 / 8 元每百万
  const c = P.costOf({ promptTokens: 2000, completionTokens: 1000 }, hit)
  // 2000*2/1e6 = 0.004 ；1000*8/1e6 = 0.008 → 合计 0.012
  check('★★ 折算：(2000×2 + 1000×8)/1e6 = 0.012 元（定点，不差一分）',
    c === B.parseAmount('0.012'), B.formatAmount(c, 8))
  check('★ 向下取整（0.0000019 元不会被吹成 0.000002）', (() => {
    const tiny = P.costOf({ promptTokens: 1, completionTokens: 0 }, { model: 'x', in: B.parseAmount('1'), out: 0n })
    // 1 token × 1 元/1M = 1e-6 元 = 100 个 1e-8 单位
    return tiny === 100n
  })(), String(P.costOf({ promptTokens: 1, completionTokens: 0 }, { model: 'x', in: B.parseAmount('1'), out: 0n })))
  check('★ 两个 token 都缺 → null（没有用量就没法折算，不给 0）',
    P.costOf({ promptTokens: null, completionTokens: null }, hit) === null)
  check('只有一个 token 有值也能算（另一个按 0）',
    P.costOf({ promptTokens: 2000, completionTokens: null }, hit) === B.parseAmount('0.004'),
    B.formatAmount(P.costOf({ promptTokens: 2000, completionTokens: null }, hit), 8))

  // 月度聚合：真写一份 ai-trace.jsonl，再让 usageByMonth 读
  const tmp = path.join(os.tmpdir(), 'fc-trace-' + Date.now() + '.jsonl')
  const T = require(path.join(REPO, 'desktop/dist/main/llm/trace.js'))
  T.setTraceFilePathForTest(tmp)
  const day = new Date()
  const ym = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}`
  const recs = [
    // 供应商自报 0.5 元
    { ts: `${ym}-01T10:00:00`, trigger: 't', model: 'm', ok: true, stream: false, prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: '0.50000000', cost_source: 'provider' },
    // 按用户单价折算 0.012 元（带单价快照）
    { ts: `${ym}-02T10:00:00`, trigger: 't', model: 'm', ok: true, stream: false, prompt_tokens: 2000, completion_tokens: 1000, total_tokens: 3000, cost: '0.01200000', cost_source: 'user-price', unit_price: { in: '2.00000000', out: '8.00000000', at: '2026-10-25' } },
    // 有 token 但没金额 = 未折算
    { ts: `${ym}-03T10:00:00`, trigger: 't', model: 'm', ok: true, stream: false, prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    // 连 token 都没有（老记录）：既不算金额也不算未折算
    { ts: `${ym}-04T10:00:00`, trigger: 't', model: 'm', ok: false, stream: false },
  ]
  fs.writeFileSync(tmp, recs.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf-8')
  const m = T.usageByMonth(3)[0]
  check('★★ 月度金额 = 定点相加 0.5 + 0.012 = 0.512（浮点这里会出现 0.5120000000000001）',
    m.cost === '0.51200000', m.cost)
  check('★ 有金额 2 笔、其中供应商自报 1 笔、未折算 1 笔 —— 三个数分别可读',
    m.cost_calls === 2 && m.provider_cost_calls === 1 && m.unpriced_calls === 1,
    JSON.stringify({ cost_calls: m.cost_calls, provider: m.provider_cost_calls, unpriced: m.unpriced_calls }))
  check('  没有 token 的那笔既不算金额也不算"未折算"（它本来就没数据）', m.calls === 4)
  try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }
}

// ── ④c 外部用量上报（MCP usage_report，2026-10-25 卡 005 第三件）──────────
console.log('\n── ④c 外部上报（MCP usage_report）──')
function usageReportChecks() {
  const U = require(path.join(REPO, 'desktop/dist/shared/usageReport.js'))
  const NOW = '2026-10-25T12:00:00.000Z'

  const ok = U.buildExternalUsageRecord({ client: 'dsh', model: 'deepseek-chat', prompt_tokens: 1200, completion_tokens: 300, cost: '0.0173' }, NOW)
  check('★ 合法上报能过：origin=external、client 进 reported_by、trigger 带 external: 前缀',
    U.isUsageReportOk(ok) && ok.record.origin === 'external'
    && ok.record.reported_by === 'dsh' && ok.record.trigger === 'external:dsh',
    U.isUsageReportOk(ok) ? JSON.stringify({ o: ok.record.origin, r: ok.record.reported_by, t: ok.record.trigger }) : ok.error)
  check('★ 金额按定点落（0.0173 → "0.01730000"）且标 cost_source=provider（供应商自报口径）',
    U.isUsageReportOk(ok) && ok.record.cost === '0.01730000' && ok.record.cost_source === 'provider',
    U.isUsageReportOk(ok) ? String(ok.record.cost) : ok.error)
  check('  total_tokens 没报就按 in+out 求和（1500）',
    U.isUsageReportOk(ok) && ok.record.total_tokens === 1500, U.isUsageReportOk(ok) ? String(ok.record.total_tokens) : ok.error)

  const onlyTok = U.buildExternalUsageRecord({ model: 'm', prompt_tokens: 10 }, NOW)
  check('  只报 token 不报钱也收（金额留空 = 未折算，不是 0 元）',
    U.isUsageReportOk(onlyTok) && onlyTok.record.cost === undefined)

  const cases = [
    ['什么都没报 → 拒绝（空账不写）', {}, /至少要报 token|空记录/],
    ['token 是负数 → 拒绝', { prompt_tokens: -5 }, /非负整数/],
    ['token 是小数 → 拒绝', { prompt_tokens: 1.5 }, /非负整数/],
    ['token 是字符串乱码 → 拒绝', { prompt_tokens: 'abc' }, /非负整数/],
    ['美元 → 拒绝（不做汇率换算）', { prompt_tokens: 10, cost: '1', currency: 'USD' }, /只接受人民币/],
    ['金额非法 → 拒绝', { prompt_tokens: 10, cost: 'abc' }, /不是合法金额/],
    ['金额为负 → 拒绝', { prompt_tokens: 10, cost: '-1' }, /负数/],
  ]
  for (const [name, input, re] of cases) {
    const r = U.buildExternalUsageRecord(input, NOW)
    check(`★ 拒绝：${name}`, !U.isUsageReportOk(r) && re.test(r.error), U.isUsageReportOk(r) ? '(竟然通过了)' : r.error)
  }

  const cny = U.buildExternalUsageRecord({ prompt_tokens: 1, cost: '2', currency: '元' }, NOW)
  check('  币种写「元」也认（中文口径）', U.isUsageReportOk(cny) && cny.record.cost === '2.00000000')

  const badAt = U.buildExternalUsageRecord({ prompt_tokens: 1, at: '不是时间' }, NOW)
  check('  时间戳解析不了 → 退回当前时间（不因为一句坏时间丢掉整笔账）',
    U.isUsageReportOk(badAt) && badAt.record.ts === NOW.slice(0, 19), U.isUsageReportOk(badAt) ? badAt.record.ts : badAt.error)

  const longNote = U.buildExternalUsageRecord({ prompt_tokens: 1, note: 'x'.repeat(300) }, NOW)
  check('  备注截断到 120 字（别让外部数据把留痕撑爆）',
    U.isUsageReportOk(longNote) && longNote.record.note.length === 120)

  // 真写一条 → 月度聚合必须**单独计数**
  const tmp = path.join(os.tmpdir(), 'fc-trace-ext-' + Date.now() + '.jsonl')
  const T = require(path.join(REPO, 'desktop/dist/main/llm/trace.js'))
  T.setTraceFilePathForTest(tmp)
  fs.writeFileSync(tmp, '', 'utf-8')
  const day = new Date()
  const ym = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}`
  const local = { ts: `${ym}-01T09:00:00`, trigger: 'desktop.chat', model: 'm', ok: true, stream: false, prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  const ext = U.buildExternalUsageRecord({ client: 'dsh', model: 'm', prompt_tokens: 1000, completion_tokens: 200, cost: '0.02' }, `${ym}-02T09:00:00.000Z`)
  fs.writeFileSync(tmp, [local, ext.record].map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf-8')
  const m = T.usageByMonth(3)[0]
  check('★★ 月度里外部上报单独计数（1 笔 external / 共 2 笔）',
    m.external_calls === 1 && m.calls === 2, JSON.stringify({ ext: m.external_calls, calls: m.calls }))
  check('★★ 外部上报的钱不为 0（0.02 进月度金额）', m.cost === '0.02000000', m.cost)
  try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }

  // MCP 侧：工具必须登记 + handler 必须真的走这条校验
  const src = fs.readFileSync(path.join(REPO, 'desktop/src/main/mcp/tools.ts'), 'utf8').replace(/\r\n/g, '\n')
  check('★ MCP 工具表里有 usage_report（对外可见，不是只写了个函数）',
    /name: 'usage_report'/.test(src))
  check('★ handler 真的接上（调 buildExternalUsageRecord 并落 trace）',
    /case 'usage_report'/.test(src) && /buildExternalUsageRecord\(args/.test(src) && /appendTrace\(r\.record/.test(src))
  check('★ 参数不合法时返回 isError（不静默吞掉）', /isError: true/.test(src.slice(src.indexOf("case 'usage_report'"))))
}

// ── ⑤ 端到端：真跑记账（假 fetch，临时账本）────────────────────────────
console.log('\n── ⑤ 真跑记账（临时 userData + 假余额接口）──')
async function realLedger() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-balance-'))
  const STUB = path.join(REPO, 'scripts/test/electron-stub.cjs')
  const orig = Module._resolveFilename
  process.env.FC_TEST_USERDATA = base
  try {
    fs.mkdirSync(path.join(base, 'task-data'), { recursive: true })
    fs.writeFileSync(path.join(base, 'registry.yaml'), 'projects: []\n', 'utf-8')
    fs.writeFileSync(path.join(base, 'llm-config.json'), JSON.stringify({
      baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test-1234567890', model: 'deepseek-chat', timeout: 60,
    }), 'utf-8')
    Module._resolveFilename = function (r, ...a) { return r === 'electron' ? STUB : orig.call(this, r, ...a) }
    // eslint-disable-next-line
    const data = require(path.join(REPO, 'desktop/dist/main/data/index.js'))
    data.setDataDir(base)
    // eslint-disable-next-line
    const svc = require(path.join(REPO, 'desktop/dist/main/llm/balance.js'))

    let nextBalance = '100.00'
    let failMode = ''
    const realFetch = global.fetch
    global.fetch = async () => {
      if (failMode === '401') return { ok: false, status: 401, json: async () => ({}) }
      if (failMode === 'weird') return { ok: true, status: 200, json: async () => ({ nope: true }) }
      return { ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: nextBalance }] }) }
    }

    const st0 = svc.getBalanceStatus()
    check('配置了 DeepSeek → 支持账户口径（supported=true）', st0.supported === true, JSON.stringify(st0))
    check('还没观测过时，说明写的是"不可用原因/基线"而不是报个 0 元', st0.spent === '0.00' && st0.observations === 0)

    const r1 = await svc.observeBalance()
    check('★ 首次观测成功，且消息明说"只立基线、不猜历史消费"',
      r1.ok === true && /基线/.test(r1.message), r1.message)
    check('首次之后 spent 仍是 0.00（不编）', r1.status.spent === '0.00', r1.status.spent)

    nextBalance = '96.40'
    const r2 = await svc.observeBalance()
    check('★ 余额从 100 → 96.40：已观测消费 3.60（定点算，不差一分）',
      r2.status.spent === '3.60', r2.status.spent)
    check('这次的消息说清了"本次观测到消费 3.60"', /消费 3\.60/.test(r2.message), r2.message)

    nextBalance = '196.40'
    const r3 = await svc.observeBalance()
    check('★ 充值 100：消费仍是 3.60，充值记 100.00（不冲抵）',
      r3.status.spent === '3.60' && r3.status.recharged === '100.00',
      'spent=' + r3.status.spent + ' recharged=' + r3.status.recharged)
    check('消息里点明"记为充值/赠金，没有冲抵已有消费"', /充值|赠金/.test(r3.message), r3.message)

    // 账本落盘形状：金额是**字符串**，不是浮点
    const led = JSON.parse(fs.readFileSync(path.join(base, 'balance-ledger.json'), 'utf-8'))
    const book = Object.values(led.books)[0]
    check('账本落盘用字符串存金额（浮点会漂）',
      typeof book.spent === 'string' && book.spent === '3.60000000', JSON.stringify(book))
    check('账本里**没有密钥**（只有指纹做分本键）',
      !JSON.stringify(led).includes('sk-test-1234567890') && Object.keys(led.books)[0].length === 8,
      Object.keys(led.books).join(','))

    // 坏响应：不写账
    const before = fs.readFileSync(path.join(base, 'balance-ledger.json'), 'utf-8')
    failMode = 'weird'
    const r4 = await svc.observeBalance()
    check('★ 接口形状不对 → ok=false 且给原因（不写账）',
      r4.ok === false && /balance_infos/.test(r4.message) && fs.readFileSync(path.join(base, 'balance-ledger.json'), 'utf-8') === before)
    failMode = '401'
    const r5 = await svc.observeBalance()
    check('★ 401 → 明说"密钥无效或没有余额查询权限"，不甩原始响应体',
      r5.ok === false && /401/.test(r5.message) && !/sk-/.test(r5.message), r5.message)
    failMode = ''

    // 账本损坏：备份 + 拒绝覆盖
    fs.writeFileSync(path.join(base, 'balance-ledger.json'), '{ 这不是 JSON', 'utf-8')
    const r6 = await svc.observeBalance()
    const badFiles = fs.readdirSync(base).filter((f) => f.startsWith('balance-ledger.json.bad-'))
    check('★★ 账本损坏 → 备份成 .bad-* 并**拒绝写入**，不许静默重来',
      r6.ok === false && badFiles.length === 1 && /账本损坏/.test(r6.message),
      'bad=' + badFiles.length + ' msg=' + r6.message)
    check('  坏账本原样进了备份（没被覆盖）',
      badFiles.length === 1 && fs.readFileSync(path.join(base, badFiles[0]), 'utf-8').includes('这不是 JSON'))

    // 未配置端点
    global.fetch = realFetch
    fs.writeFileSync(path.join(base, 'llm-config.json'), JSON.stringify({ baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', apiKey: 'tp-x' }), 'utf-8')
    // 配置有缓存：换个进程语义没法测，这里只验 provider 判定本身
    check('MiMo 这类端点判为 unknown（没有官方余额接口 → 只报 token）',
      B.providerOf('https://token-plan-cn.xiaomimimo.com/v1') === 'unknown'
      && B.balanceUrlOf('https://token-plan-cn.xiaomimimo.com/v1') === null)
  } catch (e) {
    check('真跑记账没抛异常', false, (e && e.stack) || String(e))
  } finally {
    Module._resolveFilename = orig
    try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

// ── ⑥ 源码守卫：口径与红线（放在真跑之后执行，输出顺序才跟编号一致）──────
function guardsRun() {
  console.log('\n── ⑥ 源码守卫 ──')
  const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8').replace(/\r\n/g, '\n')
  const chatSrc = read('desktop/src/main/llm/chat.ts')
  const ipcSrc = read('desktop/src/main/llm-ipc.ts')
  const preloadSrc = read('desktop/src/preload/index.ts')
  const appSrc = read('desktop/src/renderer/App.vue')
  const balSrc = read('desktop/src/main/llm/balance.ts')
  const sharedSrc = read('desktop/src/shared/balance.ts')

  check('★ 请求带上客户端标识（User-Agent / X-Title / HTTP-Referer）',
    /'User-Agent':/.test(chatSrc) && /'X-Title':/.test(chatSrc) && /'HTTP-Referer':/.test(chatSrc))
  check('★ 没有任何内置价目表（"元/1M"、PRICING、pricePerMillion 一律不许出现）',
    !/PRICING|pricePerMillion|元\/1M|每百万\s*token\s*.*价/.test(sharedSrc + balSrc)
    && !/\bPRICING\b/.test(chatSrc))
  check('★ 注册了 llm:balanceStatus / llm:balanceObserve 两条通道',
    /guardedHandle\('llm:balanceStatus'/.test(ipcSrc) && /guardedHandle\('llm:balanceObserve'/.test(ipcSrc))
  check('★ 每次 chat 成功后就观测一次（fire-and-forget，不挡回答）',
    /void observeBalance\(\)\.catch\(/.test(ipcSrc))
  check('preload 暴露 llmBalanceStatus / llmBalanceObserve',
    /llmBalanceStatus: \(\) => ipcRenderer\.invoke\('llm:balanceStatus'\)/.test(preloadSrc)
    && /llmBalanceObserve: \(\) => ipcRenderer\.invoke\('llm:balanceObserve'\)/.test(preloadSrc))
  check('★ 界面上把口径写成"余额差值"，并点名"不是按 token 估算"',
    /余额差值/.test(appSrc) && /不是按 token 估算/.test(appSrc))
  check('★ 界面明说"归不到具体某一次调用"（粒度代价不许藏）',
    /归不到具体某一次调用/.test(appSrc))
  check('余额接口 URL 只认官方两家（不瞎拼一个去请求）',
    /api\.deepseek\.com\/user\/balance/.test(sharedSrc) && /openrouter\.ai\/api\/v1\/credits/.test(sharedSrc)
    && /return null/.test(sharedSrc))
  check('★ 金额一律 BigInt 定点（源码里不许出现 parseFloat / toFixed 参与记账）',
    !/parseFloat/.test(sharedSrc) && /1e8|100000000n/.test(sharedSrc))
}

;(async () => {
  await realLedger()
  pricingChecks()
  usageReportChecks()
  guardsRun()
  console.log('\n──────────────────────────────')
  if (fails.length) {
    console.log(`通过 ${pass} / 失败 ${fails.length}`)
    fails.forEach((f) => console.log('  · ' + f))
    process.exit(1)
  }
  console.log(`RESULT ${pass} / 0  —— 卡 005 账户口径（余额差值）全绿`)
})()
