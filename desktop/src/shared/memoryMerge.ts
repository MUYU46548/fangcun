/**
 * 记忆 v3 · 合并有根（2026-11-25 · P16.3）
 *
 * 抄 `harm-m422/dsh-memory` 的两条硬规矩（用户 2026-11-25 定：自建时把机制抄进来）：
 *   ① **只许合并、不许新增**：同 scope+kind 二元组内、token 重合 ≥45% 才聚类；
 *      合并结果必须**是原材料里的一句**（不许让模型"总结"出一句新话）；
 *   ② **有根校验**：合并句与原材料 token 重合 <34% 直接丢（防幻觉），
 *      被并掉的原文追加进 `merged.jsonl` 留档，不删除。
 *
 * 本模块是纯函数：只产出「合并计划」，落盘/改状态由主进程服务做。
 */

import { tokenize } from './memoryRank'

export interface MergeEntry {
  id: string
  /** `formatScope()` 的结果：world / topic:x / file:y / session:z */
  scope: string
  /** 类型：事故 / 教训 / 纪律 / 决定 / 偏好 / 事实 */
  kind: string
  claim: string
  evidence?: string
}

export interface MergeCluster {
  scope: string
  kind: string
  ids: string[]
  claims: string[]
}

export interface MergePlan {
  scope: string
  kind: string
  ids: string[]
  /** 合并后的 claim —— 必须是 cluster.claims 里的原句之一（不新增内容） */
  claim: string
  /** 原文逐字拼接（去重），作为合并条目的证据 */
  evidence: string
  /** 有根：合并句确实来自原材料 */
  grounded: boolean
  /** 有根校验的覆盖比例（1 = 原句；<0.34 视为无根） */
  share: number
}

export interface MergeResult {
  merges: MergePlan[]
  /** 没有参与合并的 id（原样保留） */
  kept: string[]
  /** 被合并吃掉的 id（调用方据此把它们标 已撤销 / 被合并，不删文件） */
  consumed: string[]
}

const SEP = '\u0000'

/** token 集合的 Jaccard 相似度：0–1。 */
export function jaccard(a: string, b: string): number {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (A.size === 0 || B.size === 0) return 0
  let hit = 0
  for (const t of A) if (B.has(t)) hit++
  const union = A.size + B.size - hit
  return union > 0 ? hit / union : 0
}

/**
 * 重合度（用于聚类）：`|交集| / min(|A|,|B|)`。
 *
 * 为什么不用 Jaccard：中文一条短、一条长时，Jaccard 会被长度惩罚到 0.3 左右，
 * 明明「短句是长句的子集」也聚不上。dsh-memory 说的「重合 ≥45%」是**一句有多少
 * 被另一句覆盖**，不是对称的并集比 —— 这里按覆盖比实现。
 */
export function overlapCoefficient(a: string, b: string): number {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (A.size === 0 || B.size === 0) return 0
  let hit = 0
  for (const t of A) if (B.has(t)) hit++
  return hit / Math.min(A.size, B.size)
}

/** 合并句的原句覆盖率：claim 的 token 有多少出现在原文集合里。 */
export function groundingShare(claim: string, originals: readonly string[]): number {
  const tokens = new Set(tokenize(claim))
  if (tokens.size === 0) return 0
  const base = new Set<string>()
  for (const o of originals) for (const t of tokenize(o)) base.add(t)
  if (base.size === 0) return 0
  let hit = 0
  for (const t of tokens) if (base.has(t)) hit++
  return hit / tokens.size
}

/**
 * 同 scope+kind 内按重合度聚类（≥ minOverlap 归到同一簇）。
 * 比较对象是**簇里已有的任一句**（取最大值）：三条两两不像、但都像中间那条时仍能并。
 */
export function clusterEntries(entries: readonly MergeEntry[], opts: { minOverlap?: number } = {}): MergeCluster[] {
  const min = Number.isFinite(Number(opts.minOverlap)) ? Number(opts.minOverlap) : 0.45
  const groups = new Map<string, MergeEntry[]>()
  for (const e of entries) {
    const key = `${String(e.scope || 'world')}${SEP}${String(e.kind || '')}`
    const list = groups.get(key)
    if (list) list.push(e)
    else groups.set(key, [e])
  }
  const clusters: MergeCluster[] = []
  for (const [key, list] of groups) {
    const [scope, kind] = key.split(SEP)
    const used = new Set<number>()
    for (let i = 0; i < list.length; i++) {
      if (used.has(i)) continue
      const ids = [list[i].id]
      const claims = [list[i].claim]
      used.add(i)
      for (let j = i + 1; j < list.length; j++) {
        if (used.has(j)) continue
        const best = Math.max(...claims.map((c) => overlapCoefficient(c, list[j].claim)))
        if (best >= min) {
          used.add(j)
          ids.push(list[j].id)
          claims.push(list[j].claim)
        }
      }
      if (ids.length > 1) clusters.push({ scope, kind, ids, claims })
    }
  }
  return clusters
}

/**
 * 把一簇并成一条：**选原有最完整的一句**（最长），证据逐字拼接。
 * 不生成任何新句子 —— 这就是「合并不新增内容」的落地方式。
 */
export function mergeCluster(cluster: MergeCluster, opts: { minGrounding?: number } = {}): MergePlan | null {
  const minGrounding = Number.isFinite(Number(opts.minGrounding)) ? Number(opts.minGrounding) : 0.34
  const claims = cluster.claims.map((c) => String(c || '').trim()).filter(Boolean)
  if (claims.length < 2) return null
  let claim = claims[0]
  for (const c of claims) if (c.length > claim.length) claim = c
  const share = groundingShare(claim, claims)
  // 原句覆盖率必然 1.0（它自己就在原文里）；这里保留通用校验，给将来"模型写合并句"兜底
  const grounded = claims.includes(claim) || share >= minGrounding
  if (!grounded) return null
  return {
    scope: cluster.scope,
    kind: cluster.kind,
    ids: [...cluster.ids],
    claim,
    evidence: claims.join('\n\n'),
    grounded,
    share,
  }
}

/** 一步到位：聚类 → 每簇出计划 → 汇总 kept/consumed。 */
export function planMerges(entries: readonly MergeEntry[], opts: { minOverlap?: number; minGrounding?: number } = {}): MergeResult {
  const clusters = clusterEntries(entries, { minOverlap: opts.minOverlap })
  const merges: MergePlan[] = []
  const consumed = new Set<string>()
  for (const c of clusters) {
    const plan = mergeCluster(c, { minGrounding: opts.minGrounding })
    if (!plan) continue
    merges.push(plan)
    for (const id of plan.ids) consumed.add(id)
  }
  const kept = entries.map((e) => e.id).filter((id) => !consumed.has(id))
  return { merges, kept, consumed: [...consumed] }
}
