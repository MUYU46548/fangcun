/**
 * 跨渠道 token 对比（0.6.0 第 2 批 · 2026-11-02）
 *
 * 这张卡的口径（暮雨批准时写死的）：
 *  · **只比 token，不做跨渠道金额对比** —— 不同渠道的钱根本不可比（订阅制 / 按量 / 自报口径全不同）；
 *  · 金额列只允许三种标注：**供应商自报 / 用户自填 / 未折算**；
 *  · **不内置单价表，不猜单价** —— 单价是用户的商业信息，不是方寸的默认值。
 *
 * 所以这个文件只做一件事：把 ai-trace 里的记录**按渠道聚合成 token 账**，
 * 金额只做"如实转述"（记录里写了 provider 就说供应商自报，写了 user-price 就说用户自填，没写就说未折算）。
 *
 * 渠道怎么分：
 *  · 方寸自己调的叫 `local:<模型名>`（origin 不是 external）；
 *  · 外部客户端报上来的叫 `ext:<客户端名>`（origin=external，带 reported_by）。
 * **两者绝不合并** —— 外部数据和方寸实测混在一起算，就是账本说假话。
 *
 * 纯逻辑：不读盘、不碰 electron（Node 可直跑）。
 */

/** 只用到这些字段（trace 记录结构见 `main/llm/trace.ts`） */
export interface ChannelTraceLike {
  ts?: string
  trigger?: string
  model?: string
  prompt_tokens?: number | null
  completion_tokens?: number | null
  total_tokens?: number | null
  /** 1e-8 定点字符串；**没有这个字段 = 未折算**（不是 0 元） */
  cost?: string
  cost_source?: string
  origin?: string
  reported_by?: string
}

export type MoneyKind = 'provider' | 'user-price' | 'none'

export interface ChannelRow {
  key: string
  label: string
  kind: 'local' | 'external'
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** 没有 token 字段的调用次数（早期记录）—— 要单列，别混进 0 */
  noTokenCalls: number
  money: {
    kind: MoneyKind
    /** 直接显示的文案：如 `¥1.2345 · 供应商自报` / `未折算` */
    text: string
    /** 供应商自报部分（元，字符串；没有就是空串） */
    providerCost: string
    /** 用户自填单价折算部分 */
    userPriceCost: string
  }
  firstAt: string
  lastAt: string
}

export interface ChannelTotals {
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  noTokenCalls: number
}

export interface ChannelReport {
  days: number
  from: string
  to: string
  rows: ChannelRow[]
  totals: ChannelTotals
  /** 可选筛选项（界面做下拉用）：本时间段里真实出现过的渠道 */
  channels: Array<{ key: string; label: string; kind: 'local' | 'external' }>
  /** 口径声明（每个数字旁要有"它证明不了什么"的同款纪律） */
  note: string
  /** 空态话术（不拿 0 冒充"没有开销"） */
  emptyText: string
}

export interface ChannelOptions {
  /** 时间段（天）；0 / 不传 = 全部 */
  days?: number
  /** 基准时间（ISO，测试用） */
  now?: string
  /** 只看这些渠道（空/不传 = 全部） */
  channels?: string[]
}

/** 1e-8 定点字符串 → 整数单位（不经过浮点，避免 0.1+0.2 那类误差） */
export function costUnits(s: unknown): number | null {
  const t = String(s ?? '').trim()
  if (!t) return null
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const [i, f = ''] = t.split('.')
  const frac = (f + '00000000').slice(0, 8)
  return Number(i) * 1e8 + Number(frac)
}

/** 整数单位 → 人类可读（去掉多余的 0，最少两位小数） */
export function formatUnits(u: number): string {
  const n = Math.max(0, Math.round(Number(u) || 0))
  const i = Math.floor(n / 1e8)
  let f = String(n % 1e8).padStart(8, '0')
  f = f.replace(/0+$/, '')
  while (f.length < 2) f += '0'
  return `${i}.${f}`
}

function s(v: unknown): string {
  return String(v ?? '').trim()
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** ts 解析：毫秒 / 秒 / ISO 都认；认不出返回 null（不猜当年当月） */
export function tsOf(v: unknown): number | null {
  const t = s(v)
  if (!t) return null
  if (/^\d+$/.test(t)) {
    const n = Number(t)
    if (n > 1e12) return n              // 毫秒
    if (n > 1e9) return n * 1000        // 秒
    return null
  }
  const p = Date.parse(t)
  return Number.isFinite(p) ? p : null
}

const NOTE = '口径：只比 token（跨渠道金额不可比，不做换算）。'
  + '金额列只转述记录里已有的标注：供应商自报 / 用户自填 / 未折算；方寸不内置单价表、不猜单价。'
  + '方寸自己调的（local）与外部客户端报上来的（external）分开算，不合并。'
  + '它证明不了什么：外部客户端没上报的调用根本不在表里，token 少不等于那边用得少。'

/**
 * 聚合。**任何输入都不抛**；取不到就是空表 + 空态话术。
 */
export function buildChannelReport(records: ChannelTraceLike[], opts: ChannelOptions = {}): ChannelReport {
  const list = Array.isArray(records) ? records : []
  const days = Math.max(0, Number(opts.days) || 0)
  const nowMs = tsOf(opts.now) ?? Date.now()
  const fromMs = days > 0 ? nowMs - days * 86400000 : 0
  const want = (Array.isArray(opts.channels) ? opts.channels : []).map((x) => s(x)).filter(Boolean)
  const wantSet = new Set(want)

  const acc = new Map<string, {
    label: string; kind: 'local' | 'external'
    calls: number; prompt: number; completion: number; total: number; noTok: number
    provUnits: number; userUnits: number; hasCost: boolean
    first: number | null; last: number | null
  }>()

  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const t = tsOf(r.ts)
    // 时间认不出的记录：不塞进任何时间段（塞进去等于替它编一个日期）
    if (t === null) continue
    if (days > 0 && (t < fromMs || t > nowMs)) continue

    const external = s(r.origin) === 'external'
    const name = external
      ? (s(r.reported_by) || 'external')
      : (s(r.model) || '(未记录模型)')
    const key = (external ? 'ext:' : 'local:') + name
    if (wantSet.size && !wantSet.has(key)) continue

    let a = acc.get(key)
    if (!a) {
      a = {
        label: external ? `${name}（外部上报）` : name,
        kind: external ? 'external' : 'local',
        calls: 0, prompt: 0, completion: 0, total: 0, noTok: 0,
        provUnits: 0, userUnits: 0, hasCost: false,
        first: null, last: null,
      }
      acc.set(key, a)
    }
    a.calls++
    const pt = num(r.prompt_tokens)
    const ct = num(r.completion_tokens)
    const tt = num(r.total_tokens) || (pt + ct)
    if (!pt && !ct && !tt) a.noTok++
    a.prompt += pt
    a.completion += ct
    a.total += tt
    a.first = a.first === null ? t : Math.min(a.first, t)
    a.last = a.last === null ? t : Math.max(a.last, t)

    const units = costUnits(r.cost)
    if (units !== null) {
      a.hasCost = true
      // 来源不明（既不是 provider 也不是 user-price）→ 归到"用户自填"更保守：
      // 宁可说"这是你自己填的价折算的"，也不冒充"供应商自报"
      if (s(r.cost_source) === 'provider') a.provUnits += units
      else a.userUnits += units
    }
  }

  const rows: ChannelRow[] = []
  const totals: ChannelTotals = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, noTokenCalls: 0 }
  for (const [key, a] of acc) {
    let kind: MoneyKind = 'none'
    let text = '未折算'
    const prov = formatUnits(a.provUnits)
    const user = formatUnits(a.userUnits)
    if (a.hasCost) {
      if (a.provUnits > 0 && a.userUnits > 0) {
        kind = 'provider'
        text = `¥${prov} · 供应商自报 + ¥${user} · 用户自填`
      } else if (a.provUnits > 0) {
        kind = 'provider'
        text = `¥${prov} · 供应商自报`
      } else {
        kind = 'user-price'
        text = `¥${user} · 用户自填`
      }
    }
    rows.push({
      key, label: a.label, kind: a.kind,
      calls: a.calls,
      promptTokens: a.prompt, completionTokens: a.completion, totalTokens: a.total,
      noTokenCalls: a.noTok,
      money: {
        kind, text,
        providerCost: a.provUnits > 0 ? prov : '',
        userPriceCost: a.userUnits > 0 ? user : '',
      },
      firstAt: a.first === null ? '' : new Date(a.first).toISOString(),
      lastAt: a.last === null ? '' : new Date(a.last).toISOString(),
    })
    totals.calls += a.calls
    totals.promptTokens += a.prompt
    totals.completionTokens += a.completion
    totals.totalTokens += a.total
    totals.noTokenCalls += a.noTok
  }

  // 排序：token 多的在前（这是"谁在吃配额"的问题），同量按名字稳定
  rows.sort((x, y) => (y.totalTokens - x.totalTokens) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))

  const channels = rows.map((r) => ({ key: r.key, label: r.label, kind: r.kind }))

  return {
    days,
    from: fromMs ? new Date(fromMs).toISOString() : '',
    to: new Date(nowMs).toISOString(),
    rows,
    totals,
    channels,
    note: NOTE,
    emptyText: days > 0
      ? `近 ${days} 天没有 AI 调用记录 —— 不是"没花钱"，是这段时间里方寸没调用过、外部客户端也没上报`
      : '还没有任何 AI 调用记录 —— 方寸没调用过，外部客户端也没上报',
  }
}
