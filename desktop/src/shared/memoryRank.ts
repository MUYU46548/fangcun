/**
 * 记忆召回 · 纯函数（2026-11-20 v2）
 *
 * 这里只做**算术**：分词、相关度、可信度/重要度/新鲜度/使用强度、预算、去重。
 * 不碰 fs、不碰 electron —— 所以能直接在 Node 下跑断言（`scripts/test/e2e-memory-rank.cjs`）。
 *
 * 为什么要独立成模块：v1 把"排序"埋在服务里，结果 `searchMemory` 只是过滤后按时间切片，
 * 搜 `kill` 命中的是第一段摘要（D1），要读 2.9KB 才看到 D5。v2 的判据是
 * **"搜 kill，第一条就是 D5"** —— 那必须有一个能被单测钉住的打分函数。
 */

export const MEMORY_BUDGETS = {
  /** 固定核心注入上限（字符） */
  core: 800,
  /** 开工简报上限（字符） */
  briefing: 800,
  /** 单次检索返回上限（字符） */
  search: 1500,
  /** memory_read 默认上限（字符） */
  read: 8000,
  /** claim 建议长度；超过它提示，超过 hard 直接拒 */
  claim: 120,
  claimHard: 200,
  /** 低于这个分数不进检索结果 */
  minScore: 0.15,
  /** 去重阈值：归一化 token 的 Jaccard */
  dedupe: 0.8,
} as const

export interface RankableMemory {
  id: string
  claim: string
  type?: string
  project?: string
  scope?: string
  time?: string
  status?: string
  confidence?: number
  /** 1–5 */
  importance?: number
  /** 天；0 = 不衰减 */
  halfLife?: number
  /** 0.5–2.0 */
  weight?: number
  pinned?: boolean
  /** 近 30 天被召回次数（没有计量时缺省 0） */
  hits30d?: number
  tags?: string[]
  /** 证据正文，只用于"只在证据里命中"的低权匹配 */
  evidence?: string
  legacy?: boolean
}

export interface RankOptions {
  q?: string
  project?: string
  /** 简报口径：本项目条目先排，再按分数（跨项目严重事故仍会排在后面，但不会被挤掉） */
  projectFirst?: boolean
  /** 毫秒时间戳；测试可注入固定值 */
  now?: number
  minScore?: number
  limit?: number
  maxChars?: number
}

export interface RankedRow<T> {
  item: T
  score: number
  relevance: number
  confidence: number
  importance: number
  freshness: number
  usage: number
}

export interface RankResult<T> {
  rows: RankedRow<T>[]
  /** 过滤后、限条数/预算前的命中数 */
  total: number
  returned: number
  truncated: boolean
  /** 因条数或预算被丢掉的条数（total - returned） */
  dropped: number
  /** 实际返回的 claim 字符数（不含元数据开销） */
  chars: number
  minScore: number
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

export function numOr(v: any, def: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

export function confidenceOf(v: any): number {
  return clamp(numOr(v, 0.7), 0, 1)
}

export function importanceOf(v: any): number {
  return clamp(Math.round(numOr(v, 3)), 1, 5)
}

/** 1→0.40, 2→0.55, 3→0.70, 4→0.85, 5→1.00；避免 5 分把 3 分压成 0 */
export function importanceFactor(v: any): number {
  return 0.4 + 0.15 * (importanceOf(v) - 1)
}

export function weightOf(v: any): number {
  return clamp(numOr(v, 1), 0.5, 2)
}

/**
 * 新鲜度：`0.5 ** (ageDays / halfLife)`；halfLife=0（纪律/决定）恒为 1。
 *
 * ⚠ 时间认不出时给 0.7，**不当 0**（当 0 等于 1970 年，会把旧条目判成"刚发生"或直接归零；
 * 本仓在卡的时间戳上栽过这个坑）。未来时间按 0 天算。
 */
export function freshnessOf(time: string, halfLife: any, now = Date.now()): number {
  const hl = numOr(halfLife, 365)
  if (hl <= 0) return 1
  const t = Date.parse(String(time || ''))
  if (!Number.isFinite(t)) return 0.7
  const ageDays = Math.max(0, (now - t) / 86400000)
  return Math.pow(0.5, ageDays / hl)
}

export function usageFactor(hits30d: any): number {
  const n = Math.max(0, numOr(hits30d, 0))
  return 1 + Math.min(0.25, 0.05 * Math.log2(1 + n))
}

/**
 * 分词：ASCII 词 + 中文二字组（+ 长度 ≤4 的整段中文）。
 *
 * 为什么不做向量：REV-015 已定；几十条记忆用关键词 + 元数据足够。
 * 为什么保留整段：`停进程` 如果只切二字组会变成「停进」「进程」，
 * 整段也留一份，能命中完整短语。
 */
export function tokenize(s: string): string[] {
  const text = String(s || '').toLowerCase()
  const out = new Set<string>()
  for (const w of text.match(/[a-z0-9_]+/g) || []) {
    if (w.length > 1 || /^[0-9]$/.test(w)) out.add(w)
  }
  for (const run of text.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
    if (run.length <= 4) out.add(run)
  }
  return [...out]
}

/** 归一化 claim：去空白/标点、全角转半角、小写；用于去重指纹 */
export function normalizeClaim(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[^\u4e00-\u9fffa-z0-9]+/g, '')
}

/** 归一化 token 集合；空 claim 返回空数组，不做"空对空 = 相同"的假重复 */
export function claimTokens(s: string): string[] {
  const norm = normalizeClaim(s)
  if (!norm) return []
  const out = new Set<string>()
  for (const w of norm.match(/[a-z0-9_]+/g) || []) {
    // 单个数字也不能丢：`规模测试 0` 与 `规模测试 1` 只差这个数字，
    // 丢了就变成 100% 相似（2026-11-20 写入规模测试时当场抓到）
    if (w.length > 1 || /^[0-9]$/.test(w)) out.add(w)
  }
  for (const run of norm.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
    if (run.length <= 4) out.add(run)
  }
  return [...out]
}

/** Jaccard；任一为空 → 0（不能把两条空记忆判成重复） */
export function similarity(a: string, b: string): number {
  const A = new Set(claimTokens(a))
  const B = new Set(claimTokens(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

/** 在候选里找最相似的 claim；≥ threshold 才返回 */
export function findDuplicate<T extends { claim: string; id?: string; file?: string }>(
  claim: string, items: T[], threshold = MEMORY_BUDGETS.dedupe,
): { item: T; similarity: number } | null {
  let best: { item: T; similarity: number } | null = null
  for (const it of items) {
    const s = similarity(claim, it.claim)
    if (!best || s > best.similarity) best = { item: it, similarity: s }
  }
  return best && best.similarity >= threshold ? best : null
}

/** 一条的检索文本；id 也进 haystack（搜编号 D5 也要命中） */
function haystack(m: RankableMemory): string {
  return `${m.claim || ''} ${(m.tags || []).join(' ')} ${m.evidence || ''} ${m.id || ''}`.toLowerCase()
}

/** 相关度：按 idf 加权的命中比例；整句命中 claim → 0.95 保底 */
function relevanceFor(
  m: RankableMemory, q: string, tokens: string[], df: Map<string, number>, n: number,
): number {
  if (!tokens.length) return 1
  const claim = String(m.claim || '').toLowerCase()
  const tags = (m.tags || []).join(' ').toLowerCase()
  const ev = String(m.evidence || '').toLowerCase()
  let sum = 0
  let weightSum = 0
  for (const tok of tokens) {
    const d = df.get(tok) || 0
    const idf = Math.log(1 + n / (1 + d))
    weightSum += idf
    if (claim.includes(tok)) sum += idf
    else if (tags.includes(tok)) sum += 0.8 * idf
    else if (ev.includes(tok)) sum += 0.3 * idf
  }
  let rel = weightSum > 0 ? sum / weightSum : 0
  const phrase = String(q || '').trim().toLowerCase()
  if (phrase.length >= 2 && claim.includes(phrase)) rel = Math.max(rel, 0.95)
  return clamp(rel, 0, 1)
}

function buildDf(items: RankableMemory[], tokens: string[]): Map<string, number> {
  const df = new Map<string, number>()
  if (!tokens.length) return df
  const hays = items.map(haystack)
  for (const tok of tokens) {
    let c = 0
    for (const h of hays) if (h.includes(tok)) c++
    df.set(tok, c)
  }
  return df
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * 排序并裁剪。
 *
 * - 有 q：按分数降序，低于 minScore 丢掉；`total` 是过滤后的命中数。
 * - 无 q（简报）：relevance 只看项目归属（本项目 1.0 / 跨项目 0.8），
 *   再按重要度、新鲜度排；不设门槛。
 * - 预算：`claim 长度 + 80` 作为一条的上下文开销估算；超预算就丢，**至少留 1 条**，
 *   并如实报 `truncated` / `dropped`。
 */
export function rankMemories<T extends RankableMemory>(
  items: T[], opts: RankOptions = {},
): RankResult<T> {
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now()
  const q = String(opts.q || '').trim()
  const tokens = tokenize(q)
  const df = buildDf(items, tokens)
  const n = items.length
  const minScore = Number.isFinite(Number(opts.minScore)) ? Number(opts.minScore) : (q ? MEMORY_BUDGETS.minScore : 0)
  const limit = clamp(Math.round(numOr(opts.limit, 10)), 1, 50)
  const maxChars = clamp(Math.round(numOr(opts.maxChars, MEMORY_BUDGETS.search)), 100, 20000)

  const ranked: RankedRow<T>[] = []
  for (const m of items) {
    const relevance = q
      ? relevanceFor(m, q, tokens, df, n)
      : (opts.project && m.project === opts.project ? 1 : 0.8)
    if (q && relevance <= 0) continue
    const confidence = confidenceOf(m.confidence)
    const importance = importanceFactor(m.importance)
    const freshness = freshnessOf(String(m.time || ''), m.halfLife, now)
    const usage = usageFactor(m.hits30d)
    const score = relevance * confidence * importance * freshness * usage * weightOf(m.weight)
    if (q && score < minScore) continue
    ranked.push({ item: m, score: round3(score), relevance: round3(relevance), confidence, importance, freshness: round3(freshness), usage: round3(usage) })
  }

  const total = ranked.length
  const projectFirst = opts.projectFirst === true && !!opts.project
  const isProject = (m: RankableMemory) => (projectFirst && m.project === opts.project ? 1 : 0)
  ranked.sort((a, b) => {
    // 简报口径：本项目优先。跨项目的严重事故仍会出现在后面，不会被"全局红黑榜"挤掉，
    // 但也别让一条跨项目旧事故永远霸占简报第一条（v1 的 briefing 就是这个口径）。
    if (projectFirst) {
      const d = isProject(b.item) - isProject(a.item)
      if (d !== 0) return d
    }
    return b.score - a.score
      || b.importance - a.importance
      || b.confidence - a.confidence
      || String(b.item.time || '').localeCompare(String(a.item.time || ''))
      || String(a.item.id || '').localeCompare(String(b.item.id || ''))
  })

  const rows: RankedRow<T>[] = []
  let chars = 0
  for (const r of ranked) {
    if (rows.length >= limit) break
    const cost = String(r.item.claim || '').length + 80
    if (rows.length > 0 && chars + cost > maxChars) break
    rows.push(r)
    chars += String(r.item.claim || '').length
  }
  const dropped = total - rows.length
  return { rows, total, returned: rows.length, truncated: dropped > 0, dropped, chars, minScore }
}

/**
 * 固定核心的正文行：`- [D1] claim → mem-...`。
 *
 * `prefix` 是人工补充块（`core.manual.md`）——它也算进预算，
 * 不能"人工块 + 8 条"一起把上下文撑爆。超预算丢最低分的，并报 dropped。
 */
export function renderCore(
  items: RankableMemory[],
  opts: { budget?: number; prefix?: string } = {},
): { text: string; chars: number; dropped: number; truncated: boolean } {
  const budget = clamp(Math.round(numOr(opts.budget, MEMORY_BUDGETS.core)), 100, 10000)
  const prefix = String(opts.prefix || '').trim()
  let used = prefix.length
  const lines: string[] = []
  const sorted = [...items].sort((a, b) => importanceOf(b.importance) - importanceOf(a.importance)
    || String(b.time || '').localeCompare(String(a.time || ''))
    || String(a.id || '').localeCompare(String(b.id || '')))
  let dropped = 0
  for (const m of sorted) {
    const code = m.pinned && (m as any).code ? `[${(m as any).code}] ` : ''
    const line = `- ${code}${String(m.claim || '').trim()} → ${m.id}`
    const cost = line.length + (lines.length || prefix ? 1 : 0)
    if (used + cost > budget) { dropped++; continue }
    lines.push(line)
    used += cost
  }
  const text = [prefix, lines.join('\n')].filter(Boolean).join('\n\n')
  return { text, chars: text.length, dropped, truncated: dropped > 0 }
}
