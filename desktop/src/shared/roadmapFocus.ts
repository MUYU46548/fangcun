/**
 * 路线图的决策视角（纯逻辑，2026-10-31）
 *
 * 暮雨第 7 条：“阻塞、路线图、日历如何才能发力？……它们从来都是有用且有必要存在的功能，只是没做好。”
 * 所以先回答"这一页服务哪个决策"——
 *
 *   路线图 = **这个项目现在该推哪一批？**
 *
 * 现状是"把批次和任务全铺出来"，看完仍然不知道该干什么。这里把它收成三样：
 *   ① 每个项目只突出**当前批次**（第一个没做完的），其余批次折叠；
 *   ② 项目按"该先看谁"排序（进行中 > 被卡 > 未开始 > 全收口）；
 *   ③ 一行跨项目结论：先收口哪个项目的哪一批。
 *
 * ⚠ 判据：算不出来就说算不出来 —— 没有批次的卡（batch 为空）不算一批，不许造一个“未分类”来凑数
 *   （主进程那边会把空批次写成“未分类”，这里把它当"还没排批"而不是一个阶段）。
 */

export interface RoadmapBatchLike {
  name: string
  status: string
  total: number
  done: number
  tasks: { id: string; title: string; status: string }[]
}

export interface RoadmapProjectLike {
  id: string
  name: string
  health: string
  batches: RoadmapBatchLike[]
  nextActions: { taskId: string; title: string; priority?: string; batch?: string }[]
  taskCount?: number
}

export interface ProjectFocus {
  id: string
  name: string
  health: string
  /** 当前该推的批次；没有可推的批次 = null（全收口 / 一张未排批的卡都没有） */
  current: RoadmapBatchLike | null
  /** 当前批次还剩几张 */
  remaining: number
  /** 当前批次进度 0–100（无批次 = 0） */
  percent: number
  /** 已收口的批次数 / 总批次数 */
  doneBatches: number
  totalBatches: number
  /** 没排批次的任务数（“未分类”不算一个批次，它是欠账） */
  unbatched: number
  /** 能立刻动的 2-3 张（原样带过来，界面不再回查原始数组） */
  nextActions: { taskId: string; title: string; priority?: string; batch?: string }[]
  /** 这一行的结论：一句话说清"现在推到哪、还欠几张" */
  text: string
  /** 排前面的原因（给排序用，也给界面一句话） */
  rank: number
}

const UNNAMED_BATCH = '未分类'

/**
 * 算不算"一个阶段"。
 *
 * 2026-10-31 第二轮（暮雨：“路线图有大量未分类批次，这是否是混乱的原因之一？
 * 批次功能从未被有效利用，每次都自己瞎编批次最后只会越来越乱”）：
 * **“未分类”永远不是阶段** —— 它是"还没排批"的欠账。以前只有 done===0 时才忽略，
 * 于是一个装了 41 张卡的“未分类”被当成一个批次顶到最前面（截图里 19/41、24/57 就是它），
 * 把真正的阶段挤没了。现在无论里面完成了多少，它都不进批次列表，只报数。
 */
function realBatches(list: RoadmapBatchLike[]): RoadmapBatchLike[] {
  return (Array.isArray(list) ? list : [])
    .filter((b) => b && b.name && b.name !== UNNAMED_BATCH)
}

/** “未分类”里那堆任务：不是阶段，是待排批的数量（只数未完成的） */
function unbatchedCount(list: RoadmapBatchLike[]): number {
  const raw = (Array.isArray(list) ? list : []).filter((b) => b && b.name === UNNAMED_BATCH)
  return raw.reduce((n, b) => n + Math.max(0, Number(b.total || 0) - Number(b.done || 0)), 0)
}

/** 批次的展示顺序：正在推 → 被卡 → 没开始 → 已完成 */
const BATCH_ORDER: Record<string, number> = { active: 0, blocked: 1, pending: 2, completed: 3 }
export function orderBatches(list: RoadmapBatchLike[]): RoadmapBatchLike[] {
  return realBatches(list)
    .slice()
    .sort((a, b) => (BATCH_ORDER[a.status] ?? 9) - (BATCH_ORDER[b.status] ?? 9))
}

/** 项目整体排序：进行中 0 / 被卡 1 / 空闲 2 / 全收口 3 */
const PROJECT_RANK: Record<string, number> = { active: 0, stuck: 1, idle: 2 }
function projectRank(p: RoadmapProjectLike, focus: { current: RoadmapBatchLike | null }): number {
  if (!focus.current) return 3
  const r = PROJECT_RANK[p.health]
  return r === undefined ? 2 : r
}

export function focusOfProject(p: RoadmapProjectLike): ProjectFocus {
  const batches = realBatches(p.batches)
  const current = batches.find((b) => b.status === 'active')
    || batches.find((b) => b.status === 'blocked')
    || batches.find((b) => b.status === 'pending')
    || null
  const remaining = current ? Math.max(0, Number(current.total || 0) - Number(current.done || 0)) : 0
  const percent = current && Number(current.total) > 0
    ? Math.round((Number(current.done) / Number(current.total)) * 100)
    : 0
  const doneBatches = batches.filter((b) => b.status === 'completed').length
  const unbatched = unbatchedCount(p.batches)
  const tail = unbatched ? ` · 另有 ${unbatched} 张还没排批` : ''
  const text = current
    ? `${current.name} · 还剩 ${remaining} 张（${current.done}/${current.total} 已完成）${tail}`
    : batches.length
      ? `${batches.length} 个批次全部收口 —— 该规划下一批了${tail}`
      : unbatched
        ? `${unbatched} 张还没排批次 —— 这不是"一个阶段"，是欠账`
        : '还没有任务（一张卡都没有）'
  const rank = projectRank(p, { current })
  return {
    id: String(p.id),
    name: String(p.name || p.id),
    health: String(p.health || 'idle'),
    current,
    remaining,
    percent,
    doneBatches,
    totalBatches: batches.length,
    unbatched,
    nextActions: Array.isArray(p.nextActions) ? p.nextActions : [],
    text,
    rank,
  }
}

export interface RoadmapFocus {
  rows: ProjectFocus[]
  /** 先收口哪个（有当前批次、且剩下的最少 —— 快收口的最值得先推） */
  top: ProjectFocus | null
  activeCount: number
  stuckCount: number
  text: string
}

/**
 * 跨项目结论。排序：该看的在前（rank 小优先），同档里**剩下的少的先**——
 * 因为"再推两张就能收口"比"还剩二十张"更值得先动，这是收口的节奏，不是按体量排。
 */
export function focusRoadmap(projects: RoadmapProjectLike[] | null | undefined): RoadmapFocus {
  const list = Array.isArray(projects) ? projects : []
  const rows = list.map(focusOfProject).sort((a, b) =>
    a.rank - b.rank || a.remaining - b.remaining || a.id.localeCompare(b.id))
  const activeCount = rows.filter((r) => r.health === 'active').length
  const stuckCount = rows.filter((r) => r.health === 'stuck').length
  const open = rows.filter((r) => r.current)
  const top = open.slice().sort((a, b) => a.remaining - b.remaining)[0] || null
  const text = rows.length === 0
    ? '还没有任何项目排过批次'
    : top
      ? `${activeCount} 个项目在推、${stuckCount} 个卡着；最接近收口的是“${top.name}”的 ${top.current!.name}（还剩 ${top.remaining} 张）`
      : '所有批次都收口了 —— 该给下一批任务卡排期了'
  return { rows, top, activeCount, stuckCount, text }
}
