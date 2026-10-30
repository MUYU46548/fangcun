/**
 * 看板分组的纯逻辑（不依赖 Vue / DOM，所以能被脚本直接编译断言 —— 跨项目计数错一眼看不出来）。
 *
 * 背景（2026-09-25 用户反馈「看板像没有尽头的单子」）：
 *   板子本来就有「按项目」分组，但分组标题直接显示**内部 id**（`fangcun-base`、`project-3`），
 *   人看了等于没看；而且分组不可折叠，21 张待办全摊在眼前。
 *   这里把「分组 + 计数 + 显示名」的规则抽出来，UI 只负责渲染。
 */

export interface GroupingTask {
  id: string
  title?: string
  project?: unknown
  status?: string
  priority?: string
}

export interface TaskGroup<T> {
  /** 稳定的分组键（折叠状态用它，所以不能是显示名） */
  key: string
  /** 显示用标题（已解析成项目名等人类可读值） */
  label: string
  tasks: T[]
}

/** 任务的项目字段可能是数组（多归属）——统一取第一个 */
export function firstProject(p: unknown): string {
  if (Array.isArray(p)) return String(p[0] ?? '')
  if (p === null || p === undefined) return ''
  return String(p)
}

/**
 * 按项目分组。
 * @param nameOf 项目 id → 显示名（如 `fangcun-base` → `方寸`）；缺省或返回空则回退 id
 * @param unknownLabel 未归属任务的分组名
 * 排序：任务多的组在前（把「重灾区」顶上来），同数量按标题排序。
 */
export function buildProjectGroups<T extends GroupingTask>(
  tasks: T[],
  nameOf?: (id: string) => string,
  unknownLabel = '未归属'
): TaskGroup<T>[] {
  const buckets = new Map<string, T[]>()
  for (const t of tasks) {
    const id = firstProject(t.project)
    const key = id || '__none__'
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(t)
  }
  const groups: TaskGroup<T>[] = []
  for (const [key, list] of buckets) {
    let label: string
    if (key === '__none__') label = unknownLabel
    else {
      let n = ''
      try { n = nameOf ? String(nameOf(key) || '') : '' } catch { n = '' }
      label = n || key
    }
    groups.push({ key, label, tasks: list })
  }
  groups.sort((a, b) => (b.tasks.length - a.tasks.length) || a.label.localeCompare(b.label, 'zh'))
  return groups
}

/** 折叠键集合的增删（纯函数，返回新数组；UI 直接赋回 ref 即可触发渲染） */
export function toggleCollapsed(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]
}

export function isCollapsed(keys: string[], key: string): boolean {
  return keys.includes(key)
}

/** 只保留仍然存在的分组键（分组方式/筛选变了以后，别让陈旧键把新分组也折叠掉） */
export function pruneCollapsed(keys: string[], validKeys: string[]): string[] {
  return keys.filter(k => validKeys.includes(k))
}

// ── 看板列（2026-10-30 · 渲染层拆分第二批第一刀）──────────────────────────
// 列视图的「分组 → 列 → 计数」此前全写在 App.vue 的 computed 里，模板搬不走，
// 因为一搬就走样。先把这段纯逻辑收进来：输入任务 + 分组方式 + 优先级/状态清单，
// 输出稳定的列数组。UI 只负责渲染，ruling 由脚本直接断言。
import { localPriority } from './priority'

export type BoardGroupMode = 'status' | 'priority' | 'project'

export interface BoardColumnOptions {
  /** 状态清单（顺序即列顺序） */
  statuses: readonly string[]
  /** 已识别的优先级三档（顺序即列顺序） */
  priorities: readonly string[]
  /** 项目 id → 显示名；不传则回退 id */
  nameOf?: (id: string) => string
}

/**
 * 看板列派生。三种分组方式的分支语义**必须与旧实现逐字一致**：
 *  - status：先按状态清单建空列（空列也保留，用户看得见"这列现在是 0"），未知状态追加在后；
 *  - priority：固定三档 + 「其他」一列；早期用 high/normal/low 当 key 导致中文数据集体消失；
 *  - project：直接复用 buildProjectGroups（项目名解析、未归属桶都在那里）。
 */
export function buildBoardColumns<T extends GroupingTask>(
  tasks: T[],
  mode: BoardGroupMode | string,
  opts: BoardColumnOptions,
): TaskGroup<T>[] {
  if (mode === 'status') {
    const cols: Record<string, T[]> = {}
    for (const s of opts.statuses) cols[s] = []
    for (const t of tasks) {
      const k = t.status || '草稿'
      if (!cols[k]) cols[k] = []
      cols[k].push(t)
    }
    const known = opts.statuses.map(s => ({ key: s, label: s, tasks: cols[s] || [] }))
    // 未知状态不丢：追加在末尾（数据里可能有历史拼写 / 手工改出来的值）
    for (const k of Object.keys(cols)) {
      if (!opts.statuses.includes(k)) known.push({ key: k, label: k, tasks: cols[k] })
    }
    return known
  }

  if (mode === 'priority') {
    const groups: Record<string, T[]> = {}
    for (const t of tasks) {
      const k = localPriority((t as any).priority)
      if (!groups[k]) groups[k] = []
      groups[k].push(t)
    }
    const out: TaskGroup<T>[] = opts.priorities.map(p => ({ key: p, label: p + '优先级', tasks: groups[p] || [] }))
    const others = Object.keys(groups).filter(k => !opts.priorities.includes(k))
    if (others.length) out.push({ key: '其他', label: '其他优先级', tasks: others.flatMap(k => groups[k]) })
    return out
  }

  return buildProjectGroups(tasks, opts.nameOf)
}

