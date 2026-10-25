/**
 * 余额观测记账 · 纯逻辑（2026-10-25 卡 005）
 *
 * 为什么要有这个文件：暮雨给了参考实现（DSH 小鲸鱼挂件），点破了"金额算得准"的真正原因 ——
 * **它不经过价格表**。主账是 `GET /user/balance` 的**余额差值**：
 *
 *   余额下降 = 这段时间真花了这么多钱；余额上升 = 充值/赠金，单独记，不冲抵消费。
 *
 * 这条路的好处，恰好是单价表给不了的：
 *  ① 准 —— 价格变动发生在供应商账单里，余额差值**自动**跟着变，不需要我方跟价；
 *  ② 免维护 —— 官方调价不用改一行代码（小鲸鱼那张硬编码价目表，官方一变就得改代码重启）；
 *  ③ 可核 —— 数字来自供应商，不是我的推算。
 *
 * 代价（必须写在界面上，不许藏）：
 *  · **粒度粗**：两次观测之间的消费合成一个数，归不到"哪一次调用"；
 *  · **受充值干扰**：充值时余额上升，只能单独记为"调整项"，不能当负消费；
 *  · **不是每家都有**：DeepSeek / OpenRouter 有余额接口，多数中转与 MiMo 没有。
 *
 * ⚠ 金额一律用 **BigInt 的 1e-8 单位**（定点），不走浮点：`0.1 + 0.2 !== 0.3` 在账本里
 *   会累积成"对不上两分钱"。小鲸鱼也是这么做的（8 位小数记账）。
 */

/** 一笔金额 = 1e-8 单位的整数（BigInt）。0.01 元 = 1000000n */
export type Amount = bigint

export const AMOUNT_SCALE = 100000000n // 1e8

/** "110.00" / 110 / "0.123456789" → Amount；认不出返回 null（调用方按"没数据"处理，不猜） */
export function parseAmount(v: unknown): Amount | null {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null
    return parseAmount(String(v))
  }
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) {
    // 只给科学计数法/带千分位这类"看得懂但不是标准写法"的输入一次机会，仍失败就 null
    if (/^-?[\d.eE+-]+$/.test(s)) {
      const n = Number(s)
      if (!Number.isFinite(n)) return null
      return parseAmount(n.toFixed(8))
    }
    return null
  }
  const sign = m[1] === '-' ? -1n : 1n
  const int = BigInt(m[2])
  const fracRaw = (m[3] || '').slice(0, 8).padEnd(8, '0')
  return sign * (int * AMOUNT_SCALE + BigInt(fracRaw))
}

/** Amount → "110.00" 这样的人话（保留 2 位；要更多位用 formatAmount(v, 8)） */
export function formatAmount(a: Amount, decimals = 2): string {
  const neg = a < 0n
  const abs = neg ? -a : a
  const int = abs / AMOUNT_SCALE
  const frac = abs % AMOUNT_SCALE
  const fracStr = String(frac).padStart(8, '0').slice(0, Math.max(0, Math.min(8, decimals)))
  const body = decimals > 0 ? `${int}.${fracStr}` : String(int)
  return (neg ? '-' : '') + body
}

export type DeltaKind = 'spend' | 'recharge' | 'flat'

export interface Delta {
  kind: DeltaKind
  /** 变化量的绝对值（flat 时为 0n） */
  amount: Amount
}

/**
 * 两次余额观测的差值。
 *
 * ⚠ 三条规矩（与小鲸鱼的账本口径一致，也是别处踩过的坑）：
 *  ① 下降 = 消费；上升 = 充值/赠金 → **单独记**，绝不能当负消费把已有消费冲小；
 *  ② 相等 = flat，不写账（免得账本被一堆 0 撑爆）；
 *  ③ 传进来的不是合法金额 → 返回 null，**调用方必须什么都不记**（宁缺不猜）。
 */
export function computeDelta(prev: Amount | null, cur: Amount | null): Delta | null {
  if (prev === null || cur === null) return null
  if (cur === prev) return { kind: 'flat', amount: 0n }
  if (cur < prev) return { kind: 'spend', amount: prev - cur }
  return { kind: 'recharge', amount: cur - prev }
}

/** 账本里一本账的累计（都按 1e-8 单位存，读的时候不要用浮点加） */
export interface BookTotals {
  spent: Amount
  recharged: Amount
  /** 最近一次观测到的余额（下次差值的基准）；从未观测为 null */
  lastBalance: Amount | null
  observations: number
}

export const EMPTY_TOTALS: BookTotals = { spent: 0n, recharged: 0n, lastBalance: null, observations: 0 }

/**
 * 把一次观测并入累计。纯函数 —— 便于用假余额序列把"消费/充值/首次基线"全试一遍。
 *
 * 首次观测只立基线（不知道之前花了多少，记 0 消费 —— 这是诚实的，不是漏记）。
 */
export function applyObservation(totals: BookTotals, balance: Amount | null): BookTotals {
  if (balance === null) return totals
  const d = computeDelta(totals.lastBalance, balance)
  if (d === null) {
    // 首次：立基线
    return { ...totals, lastBalance: balance, observations: totals.observations + 1 }
  }
  if (d.kind === 'spend') {
    return { ...totals, spent: totals.spent + d.amount, lastBalance: balance, observations: totals.observations + 1 }
  }
  if (d.kind === 'recharge') {
    return { ...totals, recharged: totals.recharged + d.amount, lastBalance: balance, observations: totals.observations + 1 }
  }
  return { ...totals, observations: totals.observations + 1 }
}

// ── 各家的余额接口解析（只认**有官方余额接口**的几家；认不出就说认不出）─────────

export interface BalanceSnapshot {
  ok: true
  /** 余额（1e-8 单位） */
  balance: Amount
  currency: string
  /** 哪个口径解析出来的（写进账本，避免以后换了接口对不上账） */
  source: 'deepseek' | 'openrouter'
}

export interface BalanceFailure {
  ok: false
  reason: string
}

/**
 * DeepSeek 官方：`GET /user/balance`
 * 响应形状（官方文档）：
 *   { is_available: true, balance_infos: [ { currency: "CNY", total_balance: "110.00",
 *     granted_balance: "10.00", topped_up_balance: "100.00" } ] }
 * ⚠ `total_balance` 是**字符串**；多币种时取 CNY（没有 CNY 就取第一个）并把币种带回去。
 */
export function parseDeepseekBalance(json: unknown): BalanceSnapshot | BalanceFailure {
  const o = json as any
  const infos = Array.isArray(o?.balance_infos) ? o.balance_infos : null
  if (!infos || !infos.length) return { ok: false, reason: '响应里没有 balance_infos（不是 DeepSeek 余额接口的形状）' }
  const pick = infos.find((x: any) => String(x?.currency || '').toUpperCase() === 'CNY') || infos[0]
  const amount = parseAmount(pick?.total_balance)
  if (amount === null) return { ok: false, reason: `total_balance 不是合法金额：${JSON.stringify(pick?.total_balance)}` }
  return { ok: true, balance: amount, currency: String(pick?.currency || 'CNY'), source: 'deepseek' }
}

/**
 * OpenRouter：`GET /api/v1/credits`
 * 响应：{ data: { total_credits: 10, total_usage: 2.5 } } → 余额 = credits - usage
 * ⚠ 这两个是**数字**（浮点），所以必须过 parseAmount 转定点，不能直接减。
 */
export function parseOpenRouterCredits(json: unknown): BalanceSnapshot | BalanceFailure {
  const d = (json as any)?.data
  const credits = parseAmount(d?.total_credits)
  const usage = parseAmount(d?.total_usage)
  if (credits === null || usage === null) {
    return { ok: false, reason: '响应里没有 total_credits / total_usage（不是 OpenRouter /credits 的形状）' }
  }
  return { ok: true, balance: credits - usage, currency: 'USD', source: 'openrouter' }
}

/**
 * ⚠ 为什么需要这个显式守卫：本仓 `tsconfig` 是 `strict: false`（没有 strictNullChecks），
 * 那种状态下 `if (!r.ok)` **不会**把可辨识联合收窄 —— 直接读 `r.reason` 会报
 * "Property 'reason' does not exist on type ..."。用类型谓词才稳。
 */
export function isBalanceOk(r: BalanceSnapshot | BalanceFailure): r is BalanceSnapshot {
  return (r as BalanceSnapshot).ok === true
}

/** 端点是哪家（只用于"能不能查余额"，不参与计费） */
export function providerOf(baseUrl: string): 'deepseek' | 'openrouter' | 'unknown' {
  const u = String(baseUrl || '').toLowerCase()
  if (u.includes('api.deepseek.com')) return 'deepseek'
  if (u.includes('openrouter.ai')) return 'openrouter'
  return 'unknown'
}

/** 余额查询的 URL（provider 认不出就没有 —— 不瞎拼一个去请求） */
export function balanceUrlOf(baseUrl: string): string | null {
  const p = providerOf(baseUrl)
  if (p === 'deepseek') return 'https://api.deepseek.com/user/balance'
  if (p === 'openrouter') return 'https://openrouter.ai/api/v1/credits'
  return null
}
