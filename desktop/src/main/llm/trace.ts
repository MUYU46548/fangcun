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
    const t = Date.parse(String(x.ts || ''))
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
