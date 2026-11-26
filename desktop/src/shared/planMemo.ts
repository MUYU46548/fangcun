/**
 * 规划备忘（2026-11-26）
 *
 * 定向规划的产物天然不是"三块齐全的阶段卡"（没有照抄点、也常常写不出判据），
 * 硬塞进去只会逼出假块。但它也不能只落一张普通任务卡 —— 任务卡流转快、一天关十几张，
 * 310 张里再也找不到。所以给它一个**独立的家的标记**：
 *
 *   · 存储仍然用任务卡（不新开解析器 / 不新开存储格式）；
 *   · 用 `type: plan-memo`（主标记）或标签 `规划备忘`（旧写法的兜底）认它；
 *   · 任务列表默认把它过滤掉；作战计划页单独渲染成「规划备忘」段；
 *   · 阅读状态存在 `plan_memo_status`（待读 / 已采纳 / 已过期），**不借用任务状态** ——
 *     借用会把备忘混进"待办/进行中"的队列语义里，又变成一种任务。
 *
 * ⚠ 这个文件是**口径的唯一实现**：主进程过滤、界面渲染、测试都 import 它，
 *   不许在各自的地方再写一遍 `tags.includes('规划备忘')`。
 */

export const PLAN_MEMO_TYPE = 'plan-memo'
export const PLAN_MEMO_TAG = '规划备忘'
export const PLAN_MEMO_STATUSES = ['待读', '已采纳', '已过期'] as const
export type PlanMemoStatus = typeof PLAN_MEMO_STATUSES[number]

export type PlanMemoMode = '定向' | '全项目' | ''

function tagsOf(fm: any): string[] {
  const raw = fm?.tags ?? fm?.['标签']
  if (Array.isArray(raw)) return raw.map((x) => String(x ?? '').trim()).filter(Boolean)
  if (typeof raw === 'string') return raw.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
  return []
}

/** 这张卡是不是规划备忘。主标记 `type`，标签只作旧写法兜底。 */
export function isPlanMemo(task: { fm?: any } | null | undefined): boolean {
  const fm = task?.fm
  if (!fm) return false
  const type = String(fm.type ?? fm['type'] ?? '').trim().toLowerCase()
  if (type === PLAN_MEMO_TYPE) return true
  return tagsOf(fm).includes(PLAN_MEMO_TAG)
}

/** 阅读状态：认不出的值一律回「待读」，不造第四态、也不把它当已采纳。 */
export function planMemoStatusOf(fm: any): PlanMemoStatus {
  const raw = String(fm?.plan_memo_status ?? fm?.['备忘状态'] ?? '').trim()
  return (PLAN_MEMO_STATUSES as readonly string[]).includes(raw) ? (raw as PlanMemoStatus) : '待读'
}

/** 模式：先看显式字段，再看标签，最后从标题前缀认。 */
export function planMemoModeOf(fm: any): PlanMemoMode {
  const raw = String(fm?.plan_memo_mode ?? fm?.['备忘模式'] ?? '').trim()
  if (raw === '定向' || raw === '全项目') return raw
  const tags = tagsOf(fm)
  if (tags.includes('定向')) return '定向'
  if (tags.includes('全项目')) return '全项目'
  const title = String(fm?.title ?? fm?.['标题'] ?? '')
  if (/^\[规划[·-]定向\]/.test(title)) return '定向'
  if (/^\[规划[·-]全项目\]/.test(title)) return '全项目'
  return ''
}

/**
 * 从标题里取 focus。
 *
 * 标题形如 `[规划·定向] 方寸 · 只规划记忆系统 · 2026-11-26`。
 * ⚠ 不能用 `split('·')`：`[规划·定向]` 里也有一个 `·`，切出来会错位；
 *   这里用整条正则把模式、项目、focus、日期四段分开。
 */
export function planMemoFocusOf(fm: any): string {
  const explicit = String(fm?.plan_memo_focus ?? fm?.['备忘焦点'] ?? '').trim()
  if (explicit) return explicit
  const title = String(fm?.title ?? fm?.['标题'] ?? '').trim()
  const m = /^\[规划[·-](?:定向|全项目)\]\s*(.+?)\s*·\s*(.+?)\s*·\s*\d{4}-\d{2}-\d{2}\s*$/.exec(title)
  return m ? String(m[2] || '').trim() : ''
}

/** 给界面显示的一句话模式标签（空 = 不标，不猜）。 */
export function planMemoModeLabel(mode: PlanMemoMode): string {
  return mode === '定向' || mode === '全项目' ? mode : ''
}
