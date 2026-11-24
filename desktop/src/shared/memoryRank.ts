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
  /** 归一化后的三项（加权和的三块），便于界面/测试看清分是怎么来的 */
  nRelevance?: number
  nImportance?: number
  nRecency?: number
  /** 绝对匹配质量 = relevance × confidence，**门槛打在这个上面**（不归一化） */
  gate?: number
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
 * min-max 归一到 [0,1]。**整组相同时全部给 1**，不人为压低。
 *
 * 为什么整组相同给 1 而不是 0：候选里只有一条时，它就是「最相关的那条」，
 * 让它因为「没有可比的对象」而得 0 分并被门槛挡掉，是纯粹的算法自伤。
 * 全部并列时也一样 —— 并列就该并列地都留下。
 */
export function minMax(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return 0
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return 1
  return clamp((x - lo) / (hi - lo), 0, 1)
}

/**
 * 三项核心分量的权重（Generative Agents 论文实现里三个都是 1.0）。
 *
 * ⚠ 这三项走**归一化加权和**，与 `confidence / usage / weight` 的乘法分工不同：
 *   · 三项（相关度 / 重要度 / 新鲜度）是**同类候选之间的相对比较** → 加权和；
 *   · 另三个（可信度 / 使用强度 / 手动权重）是**绝对质量修正** → 仍是乘数。
 *
 * 为什么不把新鲜度也做成乘数（2026-11-24 改，C1=A 抄现成的）：
 * 乘法是**合取**语义 —— 任何一项接近 0，整条归零。于是一条重要度 5 的真实事故，
 * 因为「已经过去 365 天」被时间项一票否决，跌破 0.15 门槛**静默消失**。
 * 实测算术：重要度5 / 可信度0.9 / 半衰期365 / 仅在证据里命中(rel .3)
 *   → 180 天 0.192（过门槛）；**365 天 0.135（跌破 0.15，消失）**。
 * 那不是我们想要的语义：一条 2026-09 的工具坑，今天搜 `BOM` 时相关度最高，
 * 它就该出现，不该因为「老」被淘汰。时间只该影响**排位**，不该影响**存亡**。
 */
export const RANK_WEIGHTS = { relevance: 1, importance: 1, recency: 1 } as const

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

  // ── 第一趟：算原始分量（还没归一化，因为 min-max 要看整组）────────────
  const raw: Array<{
    item: T
    relevance: number
    confidence: number
    importance: number
    freshness: number
    usage: number
    weight: number
  }> = []
  for (const m of items) {
    const relevance = q
      ? relevanceFor(m, q, tokens, df, n)
      : (opts.project && m.project === opts.project ? 1 : 0.8)
    // 一个词都没命中 → 不相关，直接不进候选（这条与模型无关，归一化之前就该砍）
    if (q && relevance <= 0) continue
    raw.push({
      item: m,
      relevance,
      confidence: confidenceOf(m.confidence),
      importance: importanceFactor(m.importance),
      freshness: freshnessOf(String(m.time || ''), m.halfLife, now),
      usage: usageFactor(m.hits30d),
      weight: weightOf(m.weight),
    })
  }

  // ── 第二趟：三项 min-max 归一化，然后加权和 ────────────────────────
  // 见 RANK_WEIGHTS 上的说明：这三项是"同类候选之间的相对比较"，必须归一化，
  // 否则它们各自的量纲（相关度 0–1、重要度 0.4–1、新鲜度 0–1）会把对方压死。
  const rels = raw.map((r) => r.relevance)
  const imps = raw.map((r) => r.importance)
  const fres = raw.map((r) => r.freshness)
  const [relLo, relHi] = [Math.min(...rels), Math.max(...rels)]
  const [impLo, impHi] = [Math.min(...imps), Math.max(...imps)]
  const [freLo, freHi] = [Math.min(...fres), Math.max(...fres)]
  const wSum = RANK_WEIGHTS.relevance + RANK_WEIGHTS.importance + RANK_WEIGHTS.recency

  const ranked: RankedRow<T>[] = []
  for (const r of raw) {
    const nRelevance = minMax(r.relevance, relLo, relHi)
    const nImportance = minMax(r.importance, impLo, impHi)
    const nRecency = minMax(r.freshness, freLo, freHi)
    const mixed = wSum > 0
      ? (RANK_WEIGHTS.relevance * nRelevance
        + RANK_WEIGHTS.importance * nImportance
        + RANK_WEIGHTS.recency * nRecency) / wSum
      : 0
    // ⚠ 门槛必须打在**绝对匹配质量**上，不能打在上面那个 mixed 上（2026-11-24 当场抓到）：
    //   min-max 归一化让分数**永远落在 [0,1] 的高位**（最好的那条 nRelevance 恒为 1），
    //   于是一条八竿子打不着的条目也能拿到 0.3+，`minScore=0.15` 就形同虚设 ——
    //   实测搜「要被驳回的提案原文」会返回 2 条毫不相关的东西。
    //   所以：**能不能进候选**看 `relevance × confidence`（绝对值，不归一化）；
    //   **排第几**看 mixed（归一化加权和）。两件事分开，各管各的。
    const gate = r.relevance * r.confidence
    if (q && gate < minScore) continue
    const score = mixed * r.confidence * r.usage * r.weight
    ranked.push({
      item: r.item,
      score: round3(score),
      relevance: round3(r.relevance),
      confidence: r.confidence,
      importance: r.importance,
      freshness: round3(r.freshness),
      usage: round3(r.usage),
      nRelevance: round3(nRelevance),
      nImportance: round3(nImportance),
      nRecency: round3(nRecency),
      gate: round3(gate),
    })
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
