/**
 * 看板「信息卡墙」的派生逻辑（纯逻辑）—— 卡 20261010-003，2026-10-10
 *
 * 用户原话：现有两个视图都走了窄化横条路线，「很紧凑但总感觉少了点掌控感」；
 * 要「能显示看板任务 ID」；但也「没必要也不应该显示一堆无关紧要的信息」。
 *
 * 所以这一版只回答三个问题，全部做成纯函数：
 *   ① 卡片头上的 ID 怎么显示（长 id 缩到可读）；
 *   ② 优先级怎么变成色档（认不出来就**不给色**，不猜）；
 *   ③ 这张卡要不要打「被卡住 / 挡住别人」的标（两个数都为 0 → **不显示**）。
 *
 * 为什么放 shared/：它是纯逻辑，`tsc` 编出 `dist/shared/boardCards.js` 后可直接断言
 * （见 `scripts/test/e2e-board-cards.cjs`）—— 埋在 App.vue 里就只能靠真点界面才验得到，
 * 而本项目的渲染层真点击 e2e（e2e-renderer.cjs）常年 SKIP。
 *
 * 纪律：**空值一律不显示** —— 不是显示 0、也不是显示「—」，是这一格根本不渲染。
 * 卡面宁缺勿滥，这正是用户说的「没必要显示一堆无关紧要的信息」。
 */

export type BoardCardTone = '' | 'high' | 'mid' | 'low'

export interface BlockerRefLike {
  id: string
  title?: string
  status?: string
}

export interface BlockerChainLike {
  id: string
  title?: string
  /** 主进程已判定的「这个源自身已终态」 */
  isDone?: boolean
  blockedTasks?: BlockerRefLike[]
}

export interface BlockerIndex {
  /** 任务 id → 挡住它的阻塞源 id 列表（直接，不展开传递） */
  blockedBy: Record<string, string[]>
  /** 任务 id → 它挡住的**未完成**任务数 */
  blocks: Record<string, number>
}

export interface BoardCardMeta {
  /** 卡头显示的短 ID（`task-` 前缀已剥掉）；取不到就是空串 */
  id: string
  /** 优先级色档；认不出来是 `''`（界面据此决定整格不渲染） */
  tone: BoardCardTone
  /** 优先级原文（高 / 中 / 低）；只有当 tone 非空时界面才用它 */
  priority: string
  /** 被几个源挡着（0 = 不显示这一格） */
  blockedBy: number
  /** 它挡住了几个未完成任务（0 = 不显示这一格） */
  blocks: number
  /** blockedBy > 0 的便捷布尔（模板里少写一次比较） */
  blocked: boolean
}

/** 终态：完成与驳回。与 core.STATUSES 的语义一致，只用于「还算不算被卡着」这一处判断。 */
const DONE = new Set(['完成', '驳回'])

/**
 * 卡头 ID：`task-20261010-003` → `20261010-003`。
 * 只剥一层**已知前缀** —— 别的形状的 id 原样返回，不擅自改样（用户可能手写过别的 id）。
 */
export function shortTaskId(id?: unknown): string {
  const s = String(id ?? '').trim()
  if (!s) return ''
  return s.startsWith('task-') ? s.slice(5) : s
}

/**
 * 优先级 → 色档。**只认三档中文**（那是主进程 `normalizePriority()` 归一后的唯一形态），
 * 认不出来返回 `''` 而不是拿个近似档糊上去 —— 卡面宁可少一格，也不能说假话。
 */
export function priorityTone(priority?: unknown): BoardCardTone {
  const s = String(priority ?? '').trim()
  if (s === '高') return 'high'
  if (s === '中') return 'mid'
  if (s === '低') return 'low'
  return ''
}

/**
 * 从阻塞链建「查询索引」。输入形状同 `getBlockerChains()`（`blockers` ref 用的就是它）。
 *
 * 两条判据：
 *   · **已终态的被挡任务不算「还被卡着」**（完成/驳回的留在 chains 里是历史痕迹）；
 *   · **自身已终态的源不进 blocks 计数**（解一个已经做完的源没有意义）。
 */
export function buildBlockerIndex(chains?: BlockerChainLike[] | null): BlockerIndex {
  const blockedBy: Record<string, string[]> = {}
  const blocks: Record<string, number> = {}
  const list = Array.isArray(chains) ? chains : []
  for (const c of list) {
    if (!c || !c.id) continue
    const tasks = Array.isArray(c.blockedTasks) ? c.blockedTasks : []
    let n = 0
    for (const t of tasks) {
      if (!t || !t.id) continue
      if (DONE.has(String(t.status ?? ''))) continue
      const arr = blockedBy[t.id] || (blockedBy[t.id] = [])
      if (!arr.includes(c.id)) arr.push(c.id)
      n++
    }
    if (!c.isDone) blocks[c.id] = (blocks[c.id] || 0) + n
  }
  return { blockedBy, blocks }
}

/**
 * 一张卡要显示什么。`task` 是渲染层那层扁平的 Task（含 id / priority / …）。
 * 传进来的 index 为空时，阻塞两格直接是 0（界面就不渲染），不会编出假数字。
 */
export function boardCardMeta(task: any, index?: BlockerIndex | null): BoardCardMeta {
  const rawId = String(task?.id ?? '').trim()
  const tone = priorityTone(task?.priority)
  const by = (rawId && index?.blockedBy?.[rawId]) || []
  const bl = (rawId && index?.blocks?.[rawId]) || 0
  return {
    id: shortTaskId(rawId),
    tone,
    priority: tone ? String(task?.priority ?? '').trim() : '',
    blockedBy: by.length,
    blocks: bl,
    blocked: by.length > 0,
  }
}
