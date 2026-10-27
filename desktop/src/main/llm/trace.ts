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
  // 2026-10-17「花销可见」：供应商响应里的真实 token（早期记录没有这三个字段，读侧按"无数据"处理）
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
   * 这条记录是谁观测到的（2026-10-25 卡 005 第三件）。
   * 缺省 = `local`（方寸自己发起的调用）；`external` = 别的客户端自己报上来的。
   * ⚠ **两者不许混算**：外部上报既没法复验、也不含方寸的调用上下文。
   */
  origin?: 'local' | 'external'
  /** 外部上报方（client 名）；仅 origin=external 时有 */
  reported_by?: string
  /** 上报方自己写的备注（已截断、已去换行） */
  note?: string
}

let cachedPath: string | null = null

/** 留痕文件路径（与 Python DATA_DIR 同一数据根）
 *
 * ⚠ 2026-10-17 复核修正：首版写死 `appData/Fangcun`，而 Python 侧按数据根推导——
 *   桌面点按钮（TS 写入）与 `tegula ai-trace`（Python 读取）会各看各的文件，
 *   用户看到「明明是刚调的 AI，命令说暂无留痕」。现两端都取**解析后的数据根**
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
  total_tokens: number
  byModel: Array<{ model: string; calls: number; token_calls: number; total_tokens: number }>
  byTrigger: Array<{ trigger: string; calls: number; total_tokens: number }>
  firstTs: string
  lastTs: string
}

/**
 * 「花销可见」（2026-10-17 暮雨第 10 条）。
 *
 * 只做**能算准**的部分：供应商响应里报了 usage 的调用，把 token 加起来。
 * 没报 usage 的（老记录 / 某些兼容端点不回 usage）单独计数，**不折算、不估**——
 * 用户原话是「拉不到计费只算 token 也行」，那就不许再拿字符数假装 token。
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
  const tsList = recs.map((x) => String(x.ts || '')).filter(Boolean).sort()
  return {
    days,
    calls: recs.length,
    ok: recs.filter((x) => x.ok).length,
    fail: recs.filter((x) => !x.ok).length,
    token_calls: tok.length,
    prompt_tokens: tok.reduce((s, x) => s + num(x.prompt_tokens), 0),
    completion_tokens: tok.reduce((s, x) => s + num(x.completion_tokens), 0),
    total_tokens: tok.reduce((s, x) => s + num(x.total_tokens), 0),
    byModel: [...modelMap.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.calls - a.calls),
    byTrigger: [...triggerMap.entries()]
      .map(([trigger, v]) => ({ trigger, ...v }))
      .sort((a, b) => b.calls - a.calls),
    firstTs: tsList[0] || '',
    lastTs: tsList[tsList.length - 1] || '',
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
  total_tokens: number
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
 * 按**自然月**聚合花销（2026-10-22 · 03 任务三「月度 token 报表」）。
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
  type MonthAcc = MonthUsage & { _costSum: bigint }
  const map = new Map<string, MonthAcc>()
  for (const x of r.records) {
    const m = monthKey(String(x.ts || ''))
    if (!m) continue // 时间戳解析不了 = 不知道属于哪个月，宁可不算也不猜
    const cur: MonthAcc = map.get(m) || {
      month: m, calls: 0, ok: 0, fail: 0, token_calls: 0,
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      cost: '0.00000000', cost_calls: 0, provider_cost_calls: 0, unpriced_calls: 0, external_calls: 0,
      byTrigger: [], _costSum: zero,
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
      const { _costSum, ...rest } = m as MonthUsage & { _costSum: bigint }
      return { ...rest, cost: formatAmount(_costSum, 8), byTrigger: m.byTrigger.sort((a, b) => b.calls - a.calls) }
    })
}
