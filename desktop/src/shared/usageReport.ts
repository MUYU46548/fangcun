/**
 * 外部用量上报（2026-10-25 卡 005 · 第三件）
 *
 * 为什么需要：方寸只能看见**自己发起**的调用。DSH 跑司天、绒花墨坊跑 MiMo 这些
 * 根本不经过方寸，所以"17.72 元那笔账"从来不在它的账本里。
 * 唯一能覆盖那条路的办法，是让**外部客户端主动报**。
 *
 * 三条纪律（对外部数据尤其重要）：
 *  ① **来源必须分开标**：外部上报写 `origin: 'external'` + `reported_by`，
 *     读侧单独计数。外部数据和方寸实测混在一起算，就是"账本说假话"。
 *  ② **只收人民币**：币种不是 CNY 一律拒绝 —— 方寸不做汇率换算（汇率是另一个账本问题，
 *     换算过的数字既不能核对也不能追溯）。
 *  ③ **空账不写**：token 和金额都没有 → 拒绝。写一条空记录只会让"调用次数"虚高。
 *
 * 校验放在这里（纯函数、不碰 IO），所以能喂各种脏数据直接断言。
 */
import { parseAmount, formatAmount } from './balance'

/** 币种只认这几个写法（其它一律拒绝，避免"悄悄按 1:1 当人民币"） */
const CNY_ALIASES = ['cny', 'rmb', '元', '人民币', '¥']

export interface ExternalUsageRecord {
  ts: string
  trigger: string
  model: string
  prompt_chars: number
  completion_chars: number
  duration_ms: number
  ok: boolean
  stream: boolean
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  cost?: string
  cost_source?: 'provider'
  origin: 'external'
  reported_by: string
  note?: string
}

export interface UsageReportOk { ok: true; record: ExternalUsageRecord }
export interface UsageReportErr { ok: false; error: string }

/**
 * 类型谓词（`tsconfig` 是 `strict:false`，没有 strictNullChecks —— `if (!r.ok)` 不会收窄
 * 可辨识联合，读 `r.error` 直接编译失败；这是本仓第四次踩，见 AGENTS.md「踩过的坑」5）。
 */
export function isUsageReportOk(r: UsageReportOk | UsageReportErr): r is UsageReportOk {
  return (r as UsageReportOk).ok === true
}

function toInt(v: unknown): number | null | undefined {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return undefined           // undefined = 非法
  if (n < 0) return undefined
  if (!Number.isInteger(n)) return undefined          // token 只能是整数
  return n
}

function cleanText(v: unknown, max: number): string {
  return String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)
}

/**
 * 把一条外部上报校验成 trace 记录。
 * `nowIso` 由调用方给（纯函数不读时钟，测试才能喂固定时间）。
 */
export function buildExternalUsageRecord(input: unknown, nowIso: string): UsageReportOk | UsageReportErr {
  const o = (input || {}) as any

  const pTok = toInt(o.prompt_tokens)
  const cTok = toInt(o.completion_tokens)
  const tTok = toInt(o.total_tokens)
  for (const [k, v] of [['prompt_tokens', pTok], ['completion_tokens', cTok], ['total_tokens', tTok]] as const) {
    if (v === undefined) return { ok: false, error: `${k} 必须是非负整数（收到 ${JSON.stringify(o[k])}）` }
  }

  // 金额：可选，但给了就得是合法且人民币
  let cost: string | undefined
  if (o.cost !== undefined && o.cost !== null && o.cost !== '') {
    const cur = cleanText(o.currency || 'CNY', 8).toLowerCase()
    if (!CNY_ALIASES.includes(cur)) {
      return { ok: false, error: `只接受人民币（CNY / 元）；收到「${o.currency}」。方寸不做汇率换算。` }
    }
    const a = parseAmount(o.cost)
    if (a === null) return { ok: false, error: `cost 不是合法金额（收到 ${JSON.stringify(o.cost)}）` }
    if (a < 0n) return { ok: false, error: 'cost 不能是负数' }
    cost = formatAmount(a, 8)
  }

  // 空账不写：只有"什么都没报"才拒绝；只报 token 或只报金额都算有效
  const hasTok = pTok !== null || cTok !== null || tTok !== null
  if (!hasTok && cost === undefined) {
    return { ok: false, error: '至少要报 token（prompt_tokens / completion_tokens / total_tokens）或 cost —— 空记录不写' }
  }

  // 时间：能解析就用上报的，解析不了退回 now（不因为一句坏时间戳丢掉整笔账）
  // ⚠ 退回值也要归一成同一形状（秒级、无 Z）—— 否则同一份留痕里两种时间格式并存，
  //   月度分桶会把毫秒写成"解析不了"。
  const nowParsed = Date.parse(nowIso)
  let ts = Number.isFinite(nowParsed) ? new Date(nowParsed).toISOString().slice(0, 19) : nowIso.slice(0, 19)
  const rawAt = cleanText(o.at, 40)
  if (rawAt) {
    const t = Date.parse(rawAt)
    if (Number.isFinite(t)) ts = new Date(t).toISOString().slice(0, 19)
  }

  const client = cleanText(o.client, 32).replace(/[^\w\u4e00-\u9fa5.-]/g, '') || 'external'
  const note = cleanText(o.note, 120)

  const rec: ExternalUsageRecord = {
    ts,
    // trigger 前缀写死 external: —— 月度报表按它切分来源，别让外部数据伪装成本地调用
    trigger: `external:${client}`,
    model: cleanText(o.model, 64) || '(未报)',
    prompt_chars: 0,
    completion_chars: 0,
    duration_ms: 0,
    ok: true,
    stream: false,
    prompt_tokens: pTok,
    completion_tokens: cTok,
    total_tokens: tTok ?? (pTok !== null || cTok !== null ? (pTok || 0) + (cTok || 0) : null),
    ...(cost !== undefined ? { cost, cost_source: 'provider' as const } : {}),
    origin: 'external',
    reported_by: client,
    ...(note ? { note } : {}),
  }
  return { ok: true, record: rec }
}
