/**
 * 逐笔金额 · 单价与折算（2026-10-25 卡 005 B 档）
 *
 * 定位：**没有余额接口时的退路**，不是主口径。
 *  - 主口径（A 档）是余额差值（`shared/balance.ts`）：准、免维护，但不是每家都有；
 *  - 这里（B 档）是"你自己填的单价"，只在你愿意填的时候才算；**没填就是未折算**。
 *
 * 三条红线（暮雨 10-25 那次异议直接定的，别翻）：
 *  ① **绝不内置默认价**：内置常量过半年就是谎话，而且不会报错，只会安静地算错。
 *  ② **单价要快照**：记录写入时把当时用的单价一起存下来。否则你半年后改价，
 *     上个月的金额会跟着变 —— 账本漂移比没有金额更糟。
 *  ③ **只按 token 算**：没有 token 就用不了这条（绝不拿字符数折算，10-17 口径）。
 *
 * 金额与单价都用 **1e-8 定点（BigInt）**，与余额账本同一套：对账不差一分。
 * 折算时**向下取整**（宁可显示得少，不虚报花销）。
 */
import { type Amount, parseAmount, formatAmount } from './balance'

/** 单价行：价格是 **元 / 百万 token**（供应商报价的通行单位） */
export interface PriceRow {
  /** 模型名（与原样请求里的一致；匹配时不区分大小写） */
  model: string
  /** 输入价，元/1M tokens，字符串定点（如 "2"、"0.5"） */
  in: string
  /** 输出价，元/1M tokens */
  out: string
}

export interface PriceSet {
  model: string
  in: Amount
  out: Amount
}

const ONE_MILLION = 1000000n

/**
 * 清洗单价表（来自界面或手改文件）：
 * - 模型名去空白；空名的行直接丢掉（没有模型名的价，等于没有）
 * - 价格必须是非负有限数；非法 → 整行丢掉，**不猜成 0**（0 会静默把花销算成 0 元）
 * - 同名模型保留第一次出现的（后出现的忽略 —— 界面保存时已去重，这里是手改文件的兜底）
 */
export function cleanPriceRows(raw: unknown): PriceRow[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: PriceRow[] = []
  for (const r of raw) {
    const model = String((r as any)?.model ?? '').trim()
    if (!model) continue
    const key = model.toLowerCase()
    if (seen.has(key)) continue
    const inA = parseAmount((r as any)?.in)
    const outA = parseAmount((r as any)?.out)
    if (inA === null || outA === null || inA < 0n || outA < 0n) continue
    seen.add(key)
    out.push({ model, in: formatAmount(inA, 8), out: formatAmount(outA, 8) })
  }
  return out
}

/** 找出某个模型的单价（不区分大小写；找不到返回 null = 未折算） */
export function findPrice(rows: PriceRow[], model: string): PriceSet | null {
  const want = String(model || '').trim().toLowerCase()
  if (!want) return null
  const hit = (rows || []).find((r) => String(r.model || '').trim().toLowerCase() === want)
  if (!hit) return null
  const inA = parseAmount(hit.in)
  const outA = parseAmount(hit.out)
  if (inA === null || outA === null) return null
  return { model: hit.model, in: inA, out: outA }
}

export interface Tokens {
  promptTokens: number | null
  completionTokens: number | null
}

/**
 * 按单价折算一次调用的金额。
 *
 * `cost = (输入 tokens × 输入价 + 输出 tokens × 输出价) / 1e6`
 * 定点实现：价格本身是 1e-8 单位，所以先乘 token 再除以 1e6（整除 = 向下取整）。
 *
 * ⚠ 任何一个 token 为 null 就按 0 计吗？—— **不**。这里要求**至少有一个**非空，
 *   两个都空说明供应商没给用量，返回 null（调用方写"未折算"，不写 0.00）。
 */
export function costOf(tokens: Tokens, price: PriceSet): Amount | null {
  const pIn = typeof tokens.promptTokens === 'number' && Number.isFinite(tokens.promptTokens) ? tokens.promptTokens : null
  const pOut = typeof tokens.completionTokens === 'number' && Number.isFinite(tokens.completionTokens) ? tokens.completionTokens : null
  if (pIn === null && pOut === null) return null
  const inTok = BigInt(Math.max(0, Math.trunc(pIn ?? 0)))
  const outTok = BigInt(Math.max(0, Math.trunc(pOut ?? 0)))
  return (inTok * price.in + outTok * price.out) / ONE_MILLION
}

/** 人话：金额 + 币种（方寸的单价一律按人民币填，避免汇率这道暗坑） */
export function moneyLabel(a: Amount): string {
  return `¥${formatAmount(a, 4)}`
}

/** 复用同一套解析（避免各处自己 Number() 强转） */
export { parseAmount, formatAmount }
