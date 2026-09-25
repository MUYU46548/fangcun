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
