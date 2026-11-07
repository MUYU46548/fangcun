/**
 * AI 调用链留痕（2026-10-17 四件补立项之一，与 tegula_llm.py Python 侧同规格）
 *
 * 铁律（与 Python 侧一致，写代码时不可回退）：
 *   1. 只落元数据（时间/触发点/模型/字符数/耗时/成败），**绝不落 prompt 与响应正文**。
 *   2. 写失败静默——追踪是锦上添花，绝不能打断 AI 主链路。
 *   3. 失败的调用也留痕（ok=false + error 摘要）。
 *
 * 落盘位置：与 tegula/core.py 的 DATA_DIR 同一个目录（%APPDATA%/Fangcun/ai-trace.jsonl），
 * 两端（CLI/MCP 走 Python，桌面按钮走 TS）写同一个文件，`tegula ai-trace` 一条命令看全量。
 * 便携模式下 Python 侧用 exe 目录，此处退化用 userData——桌面查看口读写同一路径，口径自洽。
 */
import * as fs from 'fs'
import * as path from 'path'
import { parseAmount, formatAmount } from '../../shared/balance'

export interface TraceRecord {
  ts: string
  trigger: string
  model: string
  prompt_chars: number
  completion_chars: number
  duration_ms: number
  ok: boolean
  stream: boolean
  error?: string
  // 2026-10-17“花销可见”：供应商响应里的真实 token（早期记录没有这三个字段，读侧按"无数据"处理）
  prompt_tokens?: number | null
  completion_tokens?: number | null
  total_tokens?: number | null
  // 2026-10-25 卡 005：金额。**没有这三个字段 = 未折算**（不是 0 元）。
  /** 1e-8 定点字符串（"0.00320000"），不存浮点 —— 对账不差一分 */
  cost?: string
  /** provider = 供应商自报（唯一可信）；user-price = 按你填的单价折算 */
  cost_source?: 'provider' | 'user-price'
  /** B 档写入时的单价**快照**（元/1M tokens）；改价不影响历史记录 */
  unit_price?: { in: string; out: string; at: string }
  /**
   * 哪条通道（2026-11-02 多通道降级）：`main` / 备用通道 id。
   * 早期记录没有这个字段 = 当时只有一条通道。**降级失败的那次也会记**，
   * 所以"某条通道老是失败"能直接从留痕里看出来。
   */
  channel?: string
  /**
   * 这条记录是谁观测到的（2026-10-25 卡 005 第三件）。
   * 缺省 = `local`（方寸自己发起的调用）；`external` = 别的客户端自己报上来的。
   * ⚠ **两者不许混算**：外部上报既没法复验、也不含方寸的调用上下文。
   */
  origin?: 'local' | 'external'
  /** 外部上报方（client 名）；仅 origin=external 时有 */
  reported_by?: string
  /** 上报方自己写的备注（已截断、已去换行） */
  note?: string
  /**
   * 失败分型（2026-11-07）：`no_content` / `not_json` / `truncated` / `invalid` / `audit_rejected`。
   * 为什么单列一个字段：过去只有一句 `error`，于是"重试该说什么"全靠人读文案猜。
   * 分型之后，"三类失败各占多少"能直接统计 —— 否则永远不知道是模型不行还是提示词不行。
   */
  fail_kind?: string
  /** 这一次是**严格重试后**拿到的（救回来的也要记，否则算不出重试的收益率） */
  retried?: boolean
  /** 归因到哪张卡（外部上报才有；本地调用靠 trigger 里的项目名） */
  card?: string
  /** 缓存重读 token（外部上报显式给；老记录写在 note 的 `cache_read=` 里，见 cacheReadOf） */
  cache_read_tokens?: number
}

/**
 * 缓存重读 token（2026-11-07 · W1 口径）。
 *
 * 实测账上 `total_tokens` 有 99.3% 是 cache_read —— 拿它当"花销"排，
 * 量的是上下文长度，不是新读入。所以任何"花在哪"的主指标都必须先减掉这一块。
 * 认法：显式字段优先；其次 note 里的 `cache_read=N`（老上报方的写法）。
 */
export function cacheReadOf(rec: TraceRecord): number {
  const v = rec.cache_read_tokens
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  const m = /(?:^|\s)cache_read=(\d+)/.exec(String(rec.note || ''))
  return m ? Number(m[1]) : 0
}

/**
 * 归因到哪张卡。缺省一律 `(未归因)` —— **不是空串**：
 * 空串在报表里会被当成"没这个字段"而静默消失，`(未归因)` 才能被统计、才能被看见。
 */
export function cardOf(rec: TraceRecord): string {
  const c = String(rec.card || '').trim()
  if (c && c !== '(未归因)') return c
  const m = /(?:^|\s)card=([^\s]+)/.exec(String(rec.note || ''))
  const fromNote = m ? m[1] : ''
  return fromNote && fromNote !== '(未归因)' ? fromNote : '(未归因)'
}

/**
 * 每个指标"证明什么 / 证明不了什么"（W1 的 P5 口径要求）。
 * 不许复读同一句 —— 界面/报告直接取用，避免每个作者自己编一句好听的。
 */
export const METRIC_NOTES: Record<string, { proves: string; cannot: string }> = {
  new_input_tokens: {
    proves: '这段时间真正新读进模型的 token（prompt − cache_read），它才随"新活"增长',
    cannot: '它证明不了产出质量，也证明不了外部上报方有没有少报',
  },
  completion_tokens: {
    proves: '模型实际写出来的 token 量',
    cannot: '它证明不了写出来的东西有没有被用上（可能是废稿或重试）',
  },
  total_tokens: {
    proves: '一次调用把多少上下文带进了模型（含缓存重读），用于估上下文压力',
    cannot: '它证明不了"干了多少活" —— 账上 99.3% 是 cache_read，长上下文会把这个数顶到天上',
  },
  cache_read_tokens: {
    proves: '上下文被反复重读的规模；它高说明会话很长或归因很粗',
    cannot: '它不是新增劳动量，不能当花销主指标',
  },
  unattributed_pct: {
    proves: '外部上报里归不到任何需求卡的比例 —— "需求管理是锚点"这句话的可测值',
    cannot: '它证明不了那些 token 白花了，只证明我们说不出它们花在哪',
  },
}

let cachedPath: string | null = null

/** 留痕文件路径（与 Python DATA_DIR 同一数据根）
 *
 * ⚠ 2026-10-17 复核修正：首版写死 `appData/Fangcun`，而 Python 侧按数据根推导——
 *   桌面点按钮（TS 写入）与 `tegula ai-trace`（Python 读取）会各看各的文件，
 *   用户看到“明明是刚调的 AI，命令说暂无留痕”。现两端都取**解析后的数据根**
 *   （与 task-data 同级），一份留痕两端口径一致。
 */
export function traceFilePath(): string {
  if (cachedPath) return cachedPath
  let dir: string
  try {
    // 延迟 require，保持本模块可脱离 electron 单测
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getDataDir } = require('../data')
    dir = getDataDir() || ''
  } catch {
    dir = ''
  }
  if (!dir) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { app } = require('electron')
      dir = path.join(app.getPath('appData'), 'Fangcun')
    } catch {
      dir = path.join(process.cwd(), '.Fangcun-dev')
    }
  }
  cachedPath = path.join(dir, 'ai-trace.jsonl')
  return cachedPath
}

/** 测试注入用 */
export function setTraceFilePathForTest(p: string): void {
  cachedPath = p
}

export function appendTrace(rec: TraceRecord): void {
  try {
    const p = traceFilePath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify(rec) + '\n', 'utf-8')
  } catch {
    // 铁律 2：追踪永不打断主链路
  }
}

export interface TraceQuery {
  limit?: number
  date?: string
  trigger?: string
}

export interface TraceResult {
  records: TraceRecord[]
  summary: {
    count: number
    ok: number
    fail: number
    prompt_chars: number
    completion_chars: number
    duration_ms: number
    /** 有 token 记录的调用次数（早期记录没有 usage，不能拿 0 糊进去） */
    token_calls: number
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
  path: string
  error?: string
}

/**
 * 解析 ai-trace 的时间戳（2026-10-27 修时区 bug 时补）。
 *
 * 历史记录的 `ts` 有两种缺陷：
 *   · TS 旧代码 `toISOString().slice(0,19)` 把 `Z` 切掉了 —— 值本身是 UTC，但没有标记；
 *   · Python 旧代码 `datetime.now().isoformat()` 写的是**本地时间**，也没有标记。
 * 于是同一个文件里混着两种时间基准，直接 `Date.parse` 会按本地解释，差 8 小时。
 *
 * 无标记的一律按 **UTC** 解释：实测库里 4 条旧记录全是 TS 写的（`trigger=desktop.*`）。
 * 补标记之后两端都带时区，本函数不再需要猜。
 */
function parseTs(v: unknown): number {
  const s = String(v == null ? '' : v).trim()
  if (!s) return NaN
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s)
  return Date.parse(hasTz ? s : s + 'Z')
}

/** 读取留痕（桌面查看口 / 未来 UI 页共用）。按 ts 倒序。 */
export function readTrace(q: TraceQuery = {}): TraceResult {
  const p = traceFilePath()
  const empty: TraceResult = {
    records: [],
    summary: {
      count: 0, ok: 0, fail: 0, prompt_chars: 0, completion_chars: 0, duration_ms: 0,
      token_calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    },
    path: p,
  }
  let raw = ''
  try {
    raw = fs.readFileSync(p, 'utf-8')
  } catch (e) {
    return { ...empty, error: `读取失败: ${(e as Error).message}` }
  }
  const recs: TraceRecord[] = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let r: TraceRecord
    try {
      r = JSON.parse(s)
    } catch {
      continue
    }
    if (q.date && !String(r.ts || '').startsWith(q.date)) continue
    if (q.trigger && r.trigger !== q.trigger) continue
    recs.push(r)
  }
  recs.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
  // token 只累加**真的报了 token** 的记录：早期记录没有 usage，拿 0 糊进去等于谎报"这次花了 0"
  const withTok = recs.filter((r) => typeof r.total_tokens === 'number' || typeof r.prompt_tokens === 'number')
  const sumTok = (k: 'prompt_tokens' | 'completion_tokens' | 'total_tokens') =>
    withTok.reduce((s, r) => s + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0)
  const summary = {
    count: recs.length,
    ok: recs.filter((r) => r.ok).length,
    fail: recs.filter((r) => !r.ok).length,
    prompt_chars: recs.reduce((s, r) => s + (r.prompt_chars || 0), 0),
    completion_chars: recs.reduce((s, r) => s + (r.completion_chars || 0), 0),
    duration_ms: recs.reduce((s, r) => s + (r.duration_ms || 0), 0),
    token_calls: withTok.length,
    prompt_tokens: sumTok('prompt_tokens'),
    completion_tokens: sumTok('completion_tokens'),
    total_tokens: sumTok('total_tokens'),
  }
  // limit = -1 表示"全要"（统计用）；其余情况沿用"给最近 N 条"
  const limit = q.limit === -1 ? Number.MAX_SAFE_INTEGER : q.limit && q.limit > 0 ? q.limit : 50
  return { records: recs.slice(0, limit), summary, path: p }
}

export interface UsageStats {
  days: number
  calls: number
  ok: number
  fail: number
  /** 有 token 数据的调用次数（早期记录只有字符数） */
  token_calls: number
  prompt_tokens: number
  completion_tokens: number
  /** 副列（2026-11-07 降格）：含缓存重读，不能当"花销"主指标 */
  total_tokens: number
  /** 缓存重读 token（从 note 的 cache_read= 或显式字段来） */
  cache_read_tokens: number
  /** 主指标①：新输入 = prompt − cache_read。只统计**报了 prompt_tokens** 的记录 */
  new_input_tokens: number
  /** 主指标②：模型写出来的（已有 completion_tokens，这里显式列成主指标） */
  output_tokens: number
  /** 外部上报里归不到卡的比例（按条数）与按 token 的比例 */
  unattributed_calls: number
  unattributed_pct: number
  unattributed_tokens: number
  unattributed_token_pct: number
  /** 按卡汇总（top N）。⚠ `(未归因)` **不进**这张表 —— 它不是一张卡 */
  byCard: Array<{ card: string; calls: number; total_tokens: number }>
  /** 每个指标证明什么 / 证明不了什么（界面与报告直接取，不许自己编） */
  metrics: Record<string, { proves: string; cannot: string }>
  byModel: Array<{ model: string; calls: number; token_calls: number; total_tokens: number }>
  byTrigger: Array<{ trigger: string; calls: number; total_tokens: number }>
  firstTs: string
  lastTs: string
  /**
   * 最近一次调用的摘要（2026-10-27，设置页“模型通道”状态条用）。
   * 一次都没有时为 `null` —— 状态条据此显示"还没跑过"，而不是拿 0 糊一个数字。
   */
  last: {
    ts: string
    model: string
    trigger: string
    total_tokens: number | null
    duration_ms: number
    ok: boolean
  } | null
}

/**
 * “花销可见”（2026-10-17 暮雨第 10 条）。
 *
 * 只做**能算准**的部分：供应商响应里报了 usage 的调用，把 token 加起来。
 * 没报 usage 的（老记录 / 某些兼容端点不回 usage）单独计数，**不折算、不估**——
 * 用户原话是“拉不到计费只算 token 也行”，那就不许再拿字符数假装 token。
 */
export function usageStats(days = 30): UsageStats {
  const r = readTrace({ limit: -1 })
  const since = days > 0 ? Date.now() - days * 86400000 : 0
  const recs = r.records.filter((x) => {
    if (!since) return true
    const t = parseTs(x.ts)
    return !Number.isFinite(t) || t >= since
  })
  const hasTok = (x: TraceRecord) => typeof x.total_tokens === 'number' || typeof x.prompt_tokens === 'number'
  const tok = recs.filter(hasTok)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const modelMap = new Map<string, { calls: number; token_calls: number; total_tokens: number }>()
  const triggerMap = new Map<string, { calls: number; total_tokens: number }>()
  for (const x of recs) {
    const m = String(x.model || '(未记录)')
    const mm = modelMap.get(m) || { calls: 0, token_calls: 0, total_tokens: 0 }
    mm.calls++
    if (hasTok(x)) { mm.token_calls++; mm.total_tokens += num(x.total_tokens) }
    modelMap.set(m, mm)
    const g = String(x.trigger || '(未记录)')
    const gm = triggerMap.get(g) || { calls: 0, total_tokens: 0 }
    gm.calls++
    gm.total_tokens += num(x.total_tokens)
    triggerMap.set(g, gm)
  }
  // ── W1 口径 + W2 归因（2026-11-07）─────────────────────────────────
  // 新输入只统计**报了 prompt_tokens** 的记录：只报 total 的拿 total 顶替等于
  // 把"上下文长度"当"新读入"，正是这份账原来最错的地方。宁缺勿假。
  const withPrompt = tok.filter((x) => typeof x.prompt_tokens === 'number' && Number.isFinite(x.prompt_tokens))
  let cacheRead = 0
  let newInput = 0
  for (const x of withPrompt) {
    const p = num(x.prompt_tokens)
    const c = Math.min(p, cacheReadOf(x))   // 脏数据 cache > prompt 时封顶，不许出现负的新输入
    cacheRead += c
    newInput += p - c
  }
  const outputTokens = tok.reduce((s, x) => s + num(x.completion_tokens), 0)
  // 归因只统计**外部上报**：本地调用靠 trigger 里的项目名归因，不混进这一格，
  // 否则"未归因占比"会被一堆压根没有 card 概念的本地调用虚高顶满。
  const extTok = tok.filter((x) => x.origin === 'external')
  const cardMap = new Map<string, { card: string; calls: number; total_tokens: number }>()
  let unattr = 0
  let unattrTok = 0
  for (const x of extTok) {
    const c = cardOf(x)
    if (c === '(未归因)') { unattr++; unattrTok += num(x.total_tokens); continue }
    const e = cardMap.get(c) || { card: c, calls: 0, total_tokens: 0 }
    e.calls++
    e.total_tokens += num(x.total_tokens)
    cardMap.set(c, e)
  }
  const extTokTotal = extTok.reduce((s, x) => s + num(x.total_tokens), 0)
  const tsList = recs.map((x) => String(x.ts || '')).filter(Boolean).sort()
  // 最近一次：**不要**直接用 recs[0]。ts 字符串存在两种格式（带 Z / 不带 Z，见 parseTs 注释），
  // 按字典序排会把无标记的排错位置 → 用 parseTs 比真实时间取最大。
  let lastRec: TraceRecord | null = null
  for (const x of recs) {
    if (!lastRec) { lastRec = x; continue }
    const a = parseTs(x.ts)
    const b = parseTs(lastRec.ts)
    if (Number.isFinite(a) && (!Number.isFinite(b) || a > b)) lastRec = x
  }
  return {
    days,
    calls: recs.length,
    ok: recs.filter((x) => x.ok).length,
    fail: recs.filter((x) => !x.ok).length,
    token_calls: tok.length,
    prompt_tokens: tok.reduce((s, x) => s + num(x.prompt_tokens), 0),
    completion_tokens: outputTokens,
    total_tokens: tok.reduce((s, x) => s + num(x.total_tokens), 0),
    cache_read_tokens: cacheRead,
    new_input_tokens: newInput,
    output_tokens: outputTokens,
    unattributed_calls: unattr,
    unattributed_pct: extTok.length ? Math.round((unattr / extTok.length) * 1000) / 10 : 0,
    unattributed_tokens: unattrTok,
    unattributed_token_pct: extTokTotal ? Math.round((unattrTok / extTokTotal) * 1000) / 10 : 0,
    byCard: [...cardMap.values()].sort((a, b) => b.total_tokens - a.total_tokens).slice(0, 10),
    metrics: METRIC_NOTES,
    byModel: [...modelMap.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.calls - a.calls),
    byTrigger: [...triggerMap.entries()]
      .map(([trigger, v]) => ({ trigger, ...v }))
      .sort((a, b) => b.calls - a.calls),
    firstTs: tsList[0] || '',
    lastTs: tsList[tsList.length - 1] || '',
    last: lastRec
      ? {
          ts: String(lastRec.ts || ''),
          model: String(lastRec.model || ''),
          trigger: String(lastRec.trigger || ''),
          total_tokens: typeof lastRec.total_tokens === 'number' ? lastRec.total_tokens : null,
          duration_ms: num(lastRec.duration_ms),
          ok: !!lastRec.ok,
        }
      : null,
  }
}

export interface MonthUsage {
  /** `YYYY-MM`（**本地时区**的自然月 —— 用户说的"这个月"是本地日历，不是 UTC） */
  month: string
  calls: number
  ok: number
  fail: number
  /** 有 token 数据的调用次数（早期记录只有字符数） */
  token_calls: number
  prompt_tokens: number
  completion_tokens: number
  /** 副列（含缓存重读，不当花销主指标） */
  total_tokens: number
  /** 主指标：新输入 = prompt − cache_read（只统计报了 prompt 的记录） */
  cache_read_tokens: number
  new_input_tokens: number
  /** 外部上报里归不到卡的比例（按条数） */
  unattributed_pct: number
  /** 该月**已折算**的金额（1e-8 定点字符串；一次都没折算就是 "0.00000000"） */
  cost: string
  /** 有金额的调用笔数 */
  cost_calls: number
  /** 其中供应商自报的笔数（比"按单价折算"更可信） */
  provider_cost_calls: number
  /** 有 token 但**没有金额**的笔数 —— 界面必须显示这个数，否则金额像全量账 */
  unpriced_calls: number
  /** 其中**外部上报**的笔数（DSH / Hermes 等别的客户端自己报的，不是方寸实测） */
  external_calls: number
  byTrigger: Array<{ trigger: string; calls: number; total_tokens: number }>
}

/**
 * 按**自然月**聚合花销（2026-10-22 · 03 任务三“月度 token 报表”）。
 *
 * 为什么不用 `usageStats(30)`：那是"滚动 30 天"，跨月时跟用户嘴里的"本月"对不上
 * （1 号那天会把上个月的账算进"本月"）。月度报表必须按自然月切，否则用户一核对就发现数字不对。
 *
 * 口径与本仓其它地方一致：**只有供应商真报了 usage 的调用才计入 token**，
 * 没报的只计次数（`calls - token_calls`）—— 不拿字符数折算。
 *
 * @param months 取最近几个月（含当月），默认 3
 */
export function usageByMonth(months = 3): MonthUsage[] {
  const r = readTrace({ limit: -1 })
  const pad = (n: number) => String(n).padStart(2, '0')
  const monthKey = (ts: string): string => {
    const t = parseTs(ts)
    if (!Number.isFinite(t)) return ''
    const d = new Date(t)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const hasTok = (x: TraceRecord) => typeof x.total_tokens === 'number' || typeof x.prompt_tokens === 'number'
  // 金额全程 BigInt 定点累加：一遍加完再格式化，绝不在中途转浮点
  const zero = parseAmount('0') ?? 0n

  // 累加期用一个内部类型带 BigInt 和；出参时摘掉（MonthUsage 里不该有 bigint，过不了 IPC 克隆）
  type MonthAcc = MonthUsage & { _costSum: bigint; _extCalls: number; _unattrCalls: number }
  const map = new Map<string, MonthAcc>()
  for (const x of r.records) {
    const m = monthKey(String(x.ts || ''))
    if (!m) continue // 时间戳解析不了 = 不知道属于哪个月，宁可不算也不猜
    const cur: MonthAcc = map.get(m) || {
      month: m, calls: 0, ok: 0, fail: 0, token_calls: 0,
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      cache_read_tokens: 0, new_input_tokens: 0, unattributed_pct: 0,
      cost: '0.00000000', cost_calls: 0, provider_cost_calls: 0, unpriced_calls: 0, external_calls: 0,
      byTrigger: [], _costSum: zero, _extCalls: 0, _unattrCalls: 0,
    }
    cur.calls++
    if (x.origin === 'external') cur.external_calls++
    if (x.ok) cur.ok++
    else cur.fail++
    if (hasTok(x)) {
      cur.token_calls++
      cur.prompt_tokens += num(x.prompt_tokens)
      cur.completion_tokens += num(x.completion_tokens)
      cur.total_tokens += num(x.total_tokens)
      // W1：新输入只对报了 prompt 的记录算（只报 total 的不许顶替）
      if (typeof x.prompt_tokens === 'number' && Number.isFinite(x.prompt_tokens)) {
        const p = num(x.prompt_tokens)
        const c = Math.min(p, cacheReadOf(x))
        cur.cache_read_tokens += c
        cur.new_input_tokens += p - c
      }
      // W2：只统计外部上报（本地靠 trigger 归因，不算"未归因"）
      if (x.origin === 'external') {
        cur._extCalls++
        if (cardOf(x) === '(未归因)') cur._unattrCalls++
      }
      // 金额三态：有金额 / 有金额且供应商自报 / 有 token 但没金额（未折算）
      const c = parseAmount(x.cost)
      if (c !== null) {
        cur._costSum += c
        cur.cost_calls++
        if (x.cost_source === 'provider') cur.provider_cost_calls++
      } else {
        cur.unpriced_calls++
      }
    }
    const g = String(x.trigger || '(未记录)')
    const t = cur.byTrigger.find((y) => y.trigger === g)
    if (t) { t.calls++; t.total_tokens += num(x.total_tokens) }
    else cur.byTrigger.push({ trigger: g, calls: 1, total_tokens: num(x.total_tokens) })
    map.set(m, cur)
  }
  const limit = months > 0 ? months : 3
  return [...map.values()]
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, limit)
    .map((m) => {
      const { _costSum, _extCalls, _unattrCalls, ...rest } = m as MonthAcc
      return {
        ...rest,
        unattributed_pct: _extCalls ? Math.round((_unattrCalls / _extCalls) * 1000) / 10 : 0,
        cost: formatAmount(_costSum, 8),
        byTrigger: m.byTrigger.sort((a, b) => b.calls - a.calls),
      }
    })
}
