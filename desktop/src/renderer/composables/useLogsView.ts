/**
 * 日志页状态与纯派生（2026-10-31 · 渲染层拆分第二批「日志页逻辑收口」第一刀）
 *
 * 搬出来的是**状态 + 纯派生 + 取数**，不是动作全家桶：
 *   · 状态：筛选 / 排序 / 批量选择 / 视图模式 / 分区折叠；
 *   · 派生：filteredLogs / visibleLogs / groupedLogs / renderSections / 主附属关系表；
 *   · 取数：loadLogs（唯一取数路径，搜索词也是 filter 的一个维度）。
 *
 * 留在 App 的：打开/保存/完成/归档/删除/接力/附件/互转/导入导出 —— 它们要碰弹窗、toast、
 * 任务与项目数据，搬进来只会把 App 的依赖原样搬成 composable 的依赖，不算拆干净。
 *
 * ⚠ 仍然只有一份状态：App 通过 `useLogsView()` 解构出这些 ref，`logsViewCtl` 再递给
 *   `LogsView.vue`，组件里没有第二份。
 */
import { computed, ref, watch } from 'vue'
import { readUiPref, saveUiPref } from '../prefs'
import { localPriority } from '../../shared/priority'
import { formatDate } from '../../shared/time'

const LOG_GROUP_DEFS = [
  // 2026-10-30 暮雨第 2 轮：「分区头别写解释」—— 状态名本身已经够清楚。
  { key: 'running', label: '进行中', hint: '' },
  { key: 'active', label: '待处理', hint: '' },
  { key: 'completed', label: '已完成', hint: '' },
  { key: 'archived', label: '已归档', hint: '' },
] as const

export function useLogsView() {
  const logs = ref<any[]>([])

  // ── 筛选 / 排序 ────────────────────────────────────────────────────
  const logSearchInput = ref('')
  // 2026-09-28 用户第 5 条：状态下拉已删 —— 状态由分区表达，筛选只负责缩小数据集。
  const logProjectFilter = ref('')
  const logAgentFilter = ref('')
  const logDateFrom = ref('')
  const logDateTo = ref('')

  /**
   * 日志排序（2026-10-01 用户第 2 条）：此前只有后端给的「文件名倒序」= 创建倒序。
   * 在渲染层排 —— 数据一次取回，不往数据层加第二个排序入口。
   */
  const logSort = ref<string>(readUiPref<string>('fc_log_sort', 'created_desc'))
  watch(logSort, v => saveUiPref('fc_log_sort', v))

  const filteredLogs = computed(() => {
    const arr = [...logs.value]
    const byStr = (f: (l: any) => string, locale?: string) =>
      (a: any, b: any) => String(f(a)).localeCompare(String(f(b)), locale)
    switch (logSort.value) {
      case 'created_asc': return arr.sort(byStr(l => l.created))
      case 'date_desc': return arr.sort((a, b) => String(b.logDate || b.created).localeCompare(String(a.logDate || a.created)))
      case 'title_asc': return arr.sort(byStr(l => l.title || '', 'zh-Hans-CN'))
      // 高→中→低→未标（未标沉底）；同级按创建倒序，保证稳定。
      // ⚠ 不能直接拿 localPriority 判「未标」：它对空值兜底返回 '中'（任务卡口径）。
      case 'prio_desc': {
        const rank = (l: any): number => {
          const raw = String(l?.priority || '').trim()
          if (!raw) return 3
          const p = localPriority(raw)
          return p === '高' ? 0 : p === '中' ? 1 : p === '低' ? 2 : 3
        }
        return arr.sort((a, b) => (rank(a) - rank(b)) || String(b.created).localeCompare(String(a.created)))
      }
      default: return arr.sort((a, b) => String(b.created).localeCompare(String(a.created)))
    }
  })

  // ── 主日志 + 附属日志：关系表 ──────────────────────────────────────
  // 真源是主日志的 `attached` 数组；界面只算两张表 + 顶层去重。
  const logGroupChildren = computed(() => {
    const byId = new Map<string, any>((logs.value || []).map((l: any) => [l.id, l]))
    const m = new Map<string, any[]>()
    for (const l of logs.value || []) {
      const ids = Array.isArray(l.attached) ? l.attached : []
      if (!ids.length) continue
      m.set(l.id, ids.map((id: string) => byId.get(id)).filter(Boolean))
    }
    return m
  })
  const logGroupParent = computed(() => {
    const m = new Map<string, any>()
    const byId = new Map<string, any>((logs.value || []).map((l: any) => [l.id, l]))
    for (const l of logs.value || []) {
      for (const id of Array.isArray(l.attached) ? l.attached : []) {
        const child = byId.get(id)
        if (child) m.set(id, l)
      }
    }
    return m
  })
  /** 当前列表里已经被主日志框收走的附属 id（顶层不再单独出卡） */
  const logNestedChildIds = computed(() => {
    const s = new Set<string>()
    for (const kids of logGroupChildren.value.values()) {
      for (const k of kids) s.add(k.id)
    }
    return s
  })
  /**
   * 顶层日志（分区 / 按链 / 批量全选都用这一份）。
   * 与 filteredLogs 只差一件事：附属日志已收进主日志框，不再重复。
   */
  const visibleLogs = computed(() => filteredLogs.value.filter((l: any) => !logNestedChildIds.value.has(l.id)))

  // ── 按状态分区 ────────────────────────────────────────────────────
  const groupedLogs = computed(() => {
    const all = visibleLogs.value
    const groups: Array<{ key: string; label: string; hint: string; logs: any[] }> = []
    const pinned = all.filter(l => l.pinned)
    if (pinned.length) groups.push({ key: 'pinned', label: '置顶', hint: '', logs: pinned })
    const rest = all.filter(l => !l.pinned)
    for (const d of LOG_GROUP_DEFS) {
      const list = rest.filter(l => logGroupKey(l) === d.key)
      if (list.length) groups.push({ key: d.key, label: d.label, hint: d.hint, logs: list })
    }
    return groups
  })

  /** 一条日志属于哪个分区：running 优先于 status（进行中必然是未完成的） */
  function logGroupKey(l: any): string {
    if (l.status === 'active') return l.running ? 'running' : 'active'
    return String(l.status || 'active')
  }

  /** 分区折叠状态（写回真身）。默认收起「已归档」——归档的语义就是「先别看了」。 */
  const collapsedLogGroups = ref<string[]>(readUiPref<string[]>('fc_log_group_collapsed', ['archived']))
  function isLogGroupCollapsed(key: string): boolean {
    return collapsedLogGroups.value.includes(key)
  }
  function toggleLogGroup(key: string): void {
    const idx = collapsedLogGroups.value.indexOf(key)
    if (idx >= 0) collapsedLogGroups.value.splice(idx, 1)
    else collapsedLogGroups.value.push(key)
    saveUiPref('fc_log_group_collapsed', collapsedLogGroups.value)
  }

  // ── 按链视图 ──────────────────────────────────────────────────────
  const logsViewMode = ref<'groups' | 'chain'>(readUiPref<'groups' | 'chain'>('fc_logs_view_mode', 'groups'))
  function setLogsViewMode(m: 'groups' | 'chain'): void {
    logsViewMode.value = m
    saveUiPref('fc_logs_view_mode', m)
  }

  const renderSections = computed(() => {
    if (logsViewMode.value !== 'chain') return groupedLogs.value as any[]
    return buildChainSections(visibleLogs.value)
  })

  function buildChainSections(all: any[]): any[] {
    const byId = new Map(all.map(l => [l.id, l] as const))
    // 链头：沿 continueFrom 走到走不动为止（环 / 断链 / 被筛掉的父级都算尽头，guard 防自指环）
    const rootOf = (l: any): string => {
      let cur = l
      const seen = new Set<string>()
      let guard = 0
      while (cur?.continueFrom && byId.has(cur.continueFrom) && !seen.has(cur.id) && guard++ < 50) {
        seen.add(cur.id)
        cur = byId.get(cur.continueFrom)
      }
      return cur.id
    }
    const comps = new Map<string, any[]>()
    for (const l of all) {
      const r = rootOf(l)
      const arr = comps.get(r) || []
      arr.push(l)
      comps.set(r, arr)
    }
    const sections: any[] = []
    for (const [root, members] of comps) {
      members.sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')))
      if (members.length >= 2) {
        const head = members[0]
        const tail = members[members.length - 1]
        sections.push({
          key: 'chain:' + root,
          label: '', hint: '', logs: members,
          chain: {
            name: members.length === 2 ? `${head.title} → ${tail.title}` : `${head.title} → … → ${tail.title}`,
            count: members.length,
            since: formatDate(head.created),
            recent: formatDate(tail.created),
            tail,
          },
        })
      } else {
        sections.push({ key: 'single:' + root, label: '', hint: '', logs: members, chain: null })
      }
    }
    // 谁最近活跃谁在前（链头字符串 = 最后一个成员的 created）
    sections.sort((a, b) => String(a.logs[a.logs.length - 1]?.created || '').localeCompare(String(b.logs[b.logs.length - 1]?.created || '')))
    return sections.reverse()
  }

  // ── 「更多筛选」抽屉 ──────────────────────────────────────────────
  const logMoreFilterOpen = ref(false)
  const logMoreFilterCount = computed(() =>
    (logAgentFilter.value ? 1 : 0) + (logDateFrom.value ? 1 : 0) + (logDateTo.value ? 1 : 0))
  function toggleLogMoreFilter(): void { logMoreFilterOpen.value = !logMoreFilterOpen.value }
  async function clearLogMoreFilters(): Promise<void> {
    logAgentFilter.value = ''
    logDateFrom.value = ''
    logDateTo.value = ''
    await loadLogs()
  }

  // ── 取数（唯一路径）────────────────────────────────────────────────
  async function loadLogs() {
    try {
      const filter: any = {}
      if (logProjectFilter.value) filter.project = logProjectFilter.value
      if (logAgentFilter.value) filter.agent = logAgentFilter.value
      if (logDateFrom.value) filter.dateFrom = logDateFrom.value
      if (logDateTo.value) filter.dateTo = logDateTo.value
      // 搜索词 = 筛选的一个维度（2026-10-01 用户第 3 条）：只有一条取数路径，
      // 完成/归档/改筛选都会刷新结果，但搜索词不会丢。
      const q = logSearchInput.value.trim()
      if (q) filter.query = q
      logs.value = await (window as any).tegula.logsList(filter)
    } catch {
      logs.value = []
    }
  }

  // 边打边搜（300ms 防抖）；回车仍可强制立即执行。
  let logSearchTimer: ReturnType<typeof setTimeout> | null = null
  async function executeLogSearch() {
    if (logSearchTimer) { clearTimeout(logSearchTimer); logSearchTimer = null }
    await loadLogs()
  }
  watch(logSearchInput, () => {
    if (logSearchTimer) clearTimeout(logSearchTimer)
    logSearchTimer = setTimeout(() => {
      logSearchTimer = null
      loadLogs()
    }, 300)
  })

  // ── 卡面派生 ──────────────────────────────────────────────────────
  function logStatusLabel(log: any): string {
    if (!log) return ''
    // active 的中文是「待处理」；「进行中」是 running 这个手动标记的专属名字。
    if (log.status === 'active' && log.running) return '进行中'
    return { active: '待处理', completed: '已完成', archived: '已归档' }[log.status] || String(log.status || '')
  }

  /** 徽章 class：running 优先（进行中的视觉最醒目） */
  function logStatusClass(log: any): string {
    if (!log) return ''
    return log.status === 'active' && log.running ? 'running' : String(log.status || '')
  }

  /** 这条日志是不是「主日志」（挂了附属；即使当前筛选把附属藏起来也算） */
  function logHasGroup(log: any): boolean {
    return Array.isArray(log?.attached) && log.attached.length > 0
  }

  /** 主日志上挂着、但当前筛选没显示的附属条数 */
  function logGroupHiddenCount(log: any): number {
    const total = Array.isArray(log?.attached) ? log.attached.length : 0
    return Math.max(0, total - (logGroupChildren.value.get(log?.id) || []).length)
  }

  /** 组内状态概览：`2 进行中 · 1 待处理`（空组返回空串） */
  function logGroupStat(log: any): string {
    const kids = logGroupChildren.value.get(log?.id) || []
    const members = [log, ...kids].filter(Boolean)
    const count: Record<string, number> = { running: 0, active: 0, completed: 0, archived: 0 }
    for (const m of members) {
      const k = logGroupKey(m)
      if (k in count) count[k]++
    }
    const parts: string[] = []
    if (count.running) parts.push(`${count.running} 进行中`)
    if (count.active) parts.push(`${count.active} 待处理`)
    if (count.completed) parts.push(`${count.completed} 已完成`)
    if (count.archived) parts.push(`${count.archived} 已归档`)
    return parts.join(' · ')
  }

  /** 全组是否都已经在「进行中」——混合态 / 有隐藏附属时保守返回 false */
  function logGroupAllRunning(main: any): boolean {
    if (logGroupHiddenCount(main) > 0) return false
    const kids = logGroupChildren.value.get(main?.id) || []
    const members = [main, ...kids].filter((x: any) => x && x.status === 'active')
    return members.length > 0 && members.every((x: any) => !!x.running)
  }

  /** 主日志卡上那个运行开关的文案：有组就是「全组」，没组才是单条 */
  function logRunningLabel(log: any): string {
    if (logHasGroup(log)) return logGroupAllRunning(log) ? '⏸ 全组撤销' : '▶ 全组进行中'
    return log?.running ? '⏸ 撤销进行中' : '▶ 标为进行中'
  }

  // ── 批量选择 ──────────────────────────────────────────────────────
  const logBatchMode = ref(false)
  const selectedLogBatch = ref<string[]>([])
  function toggleLogBatchMode() {
    logBatchMode.value = !logBatchMode.value
    if (!logBatchMode.value) selectedLogBatch.value = []
  }

  return {
    logs,
    logSearchInput, logProjectFilter, logAgentFilter, logDateFrom, logDateTo,
    logSort, logBatchMode, selectedLogBatch, logsViewMode, collapsedLogGroups,
    logMoreFilterOpen, logMoreFilterCount,
    filteredLogs, visibleLogs, groupedLogs, renderSections,
    logGroupChildren, logGroupParent, logNestedChildIds,
    loadLogs, executeLogSearch, toggleLogMoreFilter, clearLogMoreFilters,
    setLogsViewMode, toggleLogGroup, isLogGroupCollapsed, logGroupKey,
    logStatusLabel, logStatusClass,
    logHasGroup, logGroupHiddenCount, logGroupStat, logGroupAllRunning, logRunningLabel,
    toggleLogBatchMode,
  }
}
