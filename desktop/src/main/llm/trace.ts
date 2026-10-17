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
}

let cachedPath: string | null = null

/** 留痕文件路径（与 Python DATA_DIR 同目录） */
export function traceFilePath(): string {
  if (cachedPath) return cachedPath
  let dir: string
  try {
    // 延迟 require，保持本模块可脱离 electron 单测
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron')
    dir = path.join(app.getPath('appData'), 'Fangcun')
  } catch {
    dir = path.join(process.cwd(), '.Fangcun-dev')
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
  }
  path: string
  error?: string
}

/** 读取留痕（桌面查看口 / 未来 UI 页共用）。按 ts 倒序。 */
export function readTrace(q: TraceQuery = {}): TraceResult {
  const p = traceFilePath()
  const empty: TraceResult = {
    records: [],
    summary: { count: 0, ok: 0, fail: 0, prompt_chars: 0, completion_chars: 0, duration_ms: 0 },
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
  const summary = {
    count: recs.length,
    ok: recs.filter((r) => r.ok).length,
    fail: recs.filter((r) => !r.ok).length,
    prompt_chars: recs.reduce((s, r) => s + (r.prompt_chars || 0), 0),
    completion_chars: recs.reduce((s, r) => s + (r.completion_chars || 0), 0),
    duration_ms: recs.reduce((s, r) => s + (r.duration_ms || 0), 0),
  }
  const limit = q.limit && q.limit > 0 ? q.limit : 50
  return { records: recs.slice(0, limit), summary, path: p }
}
