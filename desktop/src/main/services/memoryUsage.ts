/**
 * 记忆召回计量（2026-11-24 · 问卷 B10=D「三条判据全要」的第一条）
 *
 * ## 为什么必须有它
 *
 * 暮雨原话：「我刚开始还会定期整理，后来发现整理消耗的几千万 token 更贵，干脆完全不整理摆烂了」。
 *
 * 那几千万 token 花在「**把全库读一遍来判断哪条该留**」。而要判断"哪条该留"，
 * 真正需要的信号只有一个：**这条有没有被用到过**。这个信号可以免费记下来 ——
 * 每次检索返回了哪几条，追加一行就行。有了它，"整理"从"读全库"变成"看一份报告"。
 *
 * 规划 §4.6 早就写着 `usage.jsonl`（「每次 memory_core / memory_briefing / memory_search /
 * memory_read 返回某条时，追加一行」），但**从来没有实现** —— 于是：
 *   · `hits30d` 恒 undefined → `usageFactor` 恒 1.0（打分里的"使用强度"因子是空跑）
 *   · `memory-audit.py` 的「30 天零召回」永远只能报"计量没开始"
 *
 * ## 三条纪律（照抄卡 006「读卡计量」那套，别再踩第二遍）
 *
 * ① **不改源文件**。计量落**独立追加日志** `memory/usage.jsonl`，
 *    claim 文件的字节数/mtime 一个都不动 —— 否则"读"会污染"写"。
 * ② **写失败静默**。计量是锦上添花，绝不能因为磁盘满/权限问题让 agent 读不到记忆。
 * ③ **记 id + 工具 + 查询摘要，不记正文**。正文抄一份进日志 = 密钥/私事在日志里多活一遍。
 *
 * ⚠ 不记"谁调的"（client 来自上游，这里拿不到），也不记毫秒时间以外的现场 ——
 *    多记一列就多一个会漂移的口径。
 */

import * as fs from 'fs'
import * as path from 'path'
import { getDataDir } from '../data'

/** 计量文件：与 index.jsonl 同级，但**不是派生数据**（它记的是"用过"，不可重建） */
export function memoryUsagePath(): string {
  return path.join(getDataDir(), 'memory', 'usage.jsonl')
}

/** 单个日志文件的上限行数：超了从最老的开始丢掉（防止无限膨胀）+ 记一条标记 */
const MAX_LINES = 20000

export interface MemoryUsageEvent {
  /** ISO 时刻（本地带时区） */
  at: string
  /** 工具名：core / briefing / search / read */
  tool: string
  /** 这次返回的条目 id */
  ids: string[]
  /** 查询摘要：**截断到 40 字**，不存正文（search 才有） */
  q?: string
  /** 返回条数（与 ids.length 冗余，但便于不解析数组就能统计） */
  n: number
}

function localIso(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const tz = -d.getTimezoneOffset()
  const sign = tz >= 0 ? '+' : '-'
  const abs = Math.abs(tz)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/**
 * 记一次召回。**永远不抛** —— 计量失败不能挡住 agent 读记忆。
 *
 * 空 ids 不记（"这次没搜到"对"某条有没有被用过"没有信息量，只会把日志灌满）。
 */
export function recordMemoryUsage(tool: string, ids: unknown, q = ''): void {
  try {
    const list = (Array.isArray(ids) ? ids : [])
      .map((x) => String(x || '').trim())
      .filter(Boolean)
    if (!list.length) return
    const ev: MemoryUsageEvent = {
      at: localIso(),
      tool: String(tool || '').trim() || 'unknown',
      ids: list,
      n: list.length,
    }
    const query = String(q || '').trim()
    if (query) ev.q = query.slice(0, 40)

    const p = memoryUsagePath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // 追加写：一行一条。**不要**读全文再重写（那会在大文件上变慢并放大冲突）。
    fs.appendFileSync(p, JSON.stringify(ev) + '\n', 'utf-8')
    trimIfHuge(p)
  } catch {
    /* 纪律 ②：写失败静默 */
  }
}

/** 超上限时保留最新的 MAX_LINES 行。只在超限那一刻做一次，不是每写必做。 */
function trimIfHuge(p: string): void {
  try {
    const stat = fs.statSync(p)
    // 一行约 120 字节；先按字节粗筛，避免每次都读全文
    if (stat.size < MAX_LINES * 120) return
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean)
    if (lines.length <= MAX_LINES) return
    const kept = lines.slice(lines.length - MAX_LINES)
    fs.writeFileSync(p, kept.join('\n') + '\n', 'utf-8')
  } catch {
    /* 同样静默 */
  }
}

/** 只有这三类算「召回」。core 是每轮**推送**，把它算进来会把钉住条目刷成常数（2026-11-25 · P16.1）。 */
const RECALL_TOOLS = new Set(['search', 'read', 'briefing'])

/**
 * 读回计量：近 N 天每条记忆被召回的次数。
 *
 * 「没记录」与「记了 0 次」必须分开 —— 文件不存在时返回 `started: false`，
 * 调用方据此说"计量还没开始"，而不是"N 条从没被用过"（本仓的四态混淆，栽过四次）。
 *
 * `recallOnly`：只算 search/read/briefing 的命中（core 注入是推送，不是召回）。
 * 日志里仍保留 core 行（用户 2026-11-25 D3=B：core 也记），但排序不能拿它当强度。
 */
export function readMemoryUsage(days = 30, now = Date.now(), opts: { recallOnly?: boolean } = {}): {
  started: boolean
  events: number
  counts: Map<string, number>
  lastAt: Map<string, string>
} {
  const out = { started: false, events: 0, counts: new Map<string, number>(), lastAt: new Map<string, string>() }
  const p = memoryUsagePath()
  if (!fs.existsSync(p)) return out
  out.started = true

  const cut = now - Math.max(1, days) * 86400000
  let text = ''
  try {
    text = fs.readFileSync(p, 'utf-8')
  } catch {
    return { started: false, events: 0, counts: new Map(), lastAt: new Map() }
  }
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let ev: any
    try {
      ev = JSON.parse(t)
    } catch {
      continue // 坏行跳过，不影响其余（坏行数量由 memory-audit 报）
    }
    if (opts.recallOnly && !RECALL_TOOLS.has(String(ev.tool || ''))) continue
    const at = String(ev.at || '')
    const ms = Date.parse(at)
    if (!Number.isFinite(ms) || ms < cut) continue
    out.events++
    const ids: string[] = Array.isArray(ev.ids) ? ev.ids.map(String) : []
    for (const id of ids) {
      out.counts.set(id, (out.counts.get(id) || 0) + 1)
      // lastAt 取**最大的时刻**，不是"最后一行"：日志通常追加有序，但手改/时钟跳变会把它打乱，
      // 取最后一行会把"上次召回"算旧（R2=A 的锚点就歪了）。
      const prev = out.lastAt.get(id)
      if (at && (!prev || Date.parse(at) > Date.parse(prev))) out.lastAt.set(id, at)
    }
  }
  return out
}

/**
 * 给排序用的 `hits30d` 表。
 *
 * 为什么单独一个函数：`memory.ts` 的 `scanEntries()` 是纯读盘，不该为了拿计量再读一遍日志；
 * 调用方（searchMemory）自己读一次、传给 rankMemories 即可。
 */
export function hitsMap(days = 30): Map<string, number> {
  try {
    // 排序只认「召回」，不认 core 推送（2026-11-25 · P16.1：否则钉住 11 条永远最高分）
    return readMemoryUsage(days, Date.now(), { recallOnly: true }).counts
  } catch {
    return new Map()
  }
}
