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
  guardsRun()
  console.log('\n──────────────────────────────')
  if (fails.length) {
    console.log(`通过 ${pass} / 失败 ${fails.length}`)
    fails.forEach((f) => console.log('  · ' + f))
    process.exit(1)
  }
  console.log(`RESULT ${pass} / 0  —— 卡 005 账户口径（余额差值）全绿`)
})()
