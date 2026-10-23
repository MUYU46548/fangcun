/**
 * 日历视图的状态与算法（2026-10-22 · 从 App.vue 抽出来，拆分计划第 1 批第 3 块）
 *
 * **为什么先抽 composable 而不是直接搬组件**（这是方案原话，不是临时改主意）：
 * 日历不像 help / blockers 那样"零交互、单数据源"。它有三个副作用出口
 * （打开任务详情、打开日志编辑、改期后刷新数据），还挂着一个"指派时间"弹窗。
 * 直接搬组件会把这些副作用一起卷进去，等于"边拆边改行为"。
 * 先抽状态与算法 → 这一层可独立验证（行为一模一样）；下一步再搬模板，副作用用 emit 上抛。
 *
 * **留下来的东西（仍在 App.vue）**：
 *   · `calAssign_` + `openCalAssignTask` / `openCalAssignTodo` / `saveCalAssign` ——
 *     它们开的是 App.vue 里那个「指派时间」弹窗，弹窗没搬，状态就不能搬。
 *   · `onCalEventClick` / `onCalDrop` —— 会调 `openCard` / `openLog` / `loadTodos` /
 *     `loadLogs` / `showToast`，全是父组件的能力。
 *
 * 依赖用**取值函数**注入（不是直接传 ref）：`filteredTasks` 是 computed、`todos`/`logs`
 * 是 ref，混着传容易在解构时丢掉响应性 —— 每次算的时候现取最稳。
 */
import { computed, ref } from 'vue'
import { buildMonth, parseCalDate, calISO, type CalEvent as CalEventT } from '../calendar'

export interface UseCalendarDeps {
  /** 日历只显示「顶栏筛选后 + 非终态」的任务 —— 筛选会连带影响日历，这是既有行为 */
  activeTasks: () => any[]
  todos: () => any[]
  logs: () => any[]
  /** 优先级归一（与看板同一份口径，别在日历里另写一套） */
  priority: (p: unknown) => string
}

/** 日历格子里的一个事件（任务 / 待办 / 日志共用）。App.vue 的 onCalEventClick 也用它 */
export type CalEvent = CalEventT<any, any, any>

/** 格子内最多显示几条（2026-09-29 用户选「改法 A」） */
export const CAL_CELL_LIMIT = 2

export function useCalendar(deps: UseCalendarDeps) {
  const calYear = ref(new Date().getFullYear())
  const calMonth = ref(new Date().getMonth())
  const calDragOverDay = ref<number | null>(null)
  const calShowTodos = ref(localStorage.getItem('fc_cal_show_todos') !== '0')
  const calShowLogs = ref(localStorage.getItem('fc_cal_show_logs') !== '0')
  let calDragId: string | null = null
  let calDragKind: 'task' | 'todo' | 'log' = 'task'

  // ── 格子内事件折叠（2026-09-29 用户选「改法 A」）──────────────────────────
  // 035 卡的原话是「看起来很密集很让人畏惧」。底部那排横条墙上一轮已收成一行摘要，
  // 剩下的密在**格子内部**：某天挂 5 条，格子里就是 5 根横条在抢同一份注意力。
  // 口径：最多 2 条 + 「+N 条」，点它**就地展开**（不跳页、不弹窗），再点收起。
  // ⚠ 跨天的时间段任务（span !== 'only'）不参与折叠 —— 折了会把连续色带切成断头。
  // 2026-10-12：把上限值播给 e2e —— 断言原先自己写死「2」，改上限时两边会静默分叉。
  try { (globalThis as any).__fcCalCellCap = CAL_CELL_LIMIT } catch { /* 沙箱里没有也无妨 */ }
  const calExpandedDays = ref<string[]>([])
  const calCellKey = (cell: any): string => `${calYear.value}-${calMonth.value}-${cell.day}`
  function calCellExpanded(cell: any): boolean {
    return !!cell && calExpandedDays.value.includes(calCellKey(cell))
  }
  function calCellShown(cell: any): any[] {
    if (!cell) return []
    if (calCellExpanded(cell)) return cell.events
    const out: any[] = []
    let n = 0
    for (const ev of cell.events) {
      if (ev.span !== 'only') { out.push(ev); continue }
      if (n < CAL_CELL_LIMIT) { out.push(ev); n++ }
    }
    return out
  }
  function calCellMore(cell: any): number {
    return cell ? cell.events.length - calCellShown(cell).length : 0
  }
  function toggleCalCell(cell: any): void {
    const k = calCellKey(cell)
    calExpandedDays.value = calCellExpanded(cell)
      ? calExpandedDays.value.filter((x) => x !== k)
      : calExpandedDays.value.concat(k)
  }
  /** 换月时清掉展开痕迹，否则下个月的同一天号会"莫名是展开的" */
  function clearCalExpanded(): void { calExpandedDays.value = [] }

  const pad2 = (n: number): string => String(n).padStart(2, '0')

  function calMove(delta: number): void {
    let m = calMonth.value + delta
    let y = calYear.value
    if (m < 0) { m = 11; y-- } else if (m > 11) { m = 0; y++ }
    calMonth.value = m; calYear.value = y
    clearCalExpanded()
  }
  function calToday(): void {
    calYear.value = new Date().getFullYear()
    calMonth.value = new Date().getMonth()
    clearCalExpanded()
  }
  function calGoto(y: number, m: number): void {
    calYear.value = y
    calMonth.value = m
    clearCalExpanded()
  }
  function calToggleTodos(): void {
    calShowTodos.value = !calShowTodos.value
    localStorage.setItem('fc_cal_show_todos', calShowTodos.value ? '1' : '0')
  }
  function calToggleLogs(): void {
    calShowLogs.value = !calShowLogs.value
    localStorage.setItem('fc_cal_show_logs', calShowLogs.value ? '1' : '0')
  }

  // 日期算术全部在 calendar.ts 里（纯函数，可被 scripts/test/e2e-calendar.cjs 直接断言）——
  // 跨月边界这类错误在界面上只表现为"少一天/多一天"，肉眼抓不住，必须靠脚本。
  const taskStart = (t: any): Date | null => parseCalDate(t?.start ?? t?.fm?.start)
  const taskDue = (t: any): Date | null => parseCalDate(t?.deadline ?? t?.fm?.deadline)

  /** 日历只关心非终态任务 */
  const calActiveTasks = computed(() =>
    deps.activeTasks().filter((t: any) => t.status !== '完成' && t.status !== '驳回'))

  /** 未完成的待办（done 的不占日历） */
  const calActiveTodos = computed(() => deps.todos().filter((t: any) => !t.done))

  /** 一次算清：格子 / 未安排 / 其它月份（纯函数，见 calendar.ts） */
  const calMonthData = computed(() => buildMonth<any, any, any>({
    year: calYear.value,
    month: calMonth.value,
    today: new Date(),
    tasks: calActiveTasks.value.map((t: any) => ({
      ...t,
      priority: deps.priority(t.priority),
      start: t.start ?? t.fm?.start,
      deadline: t.deadline ?? t.fm?.deadline,
    })),
    todos: calActiveTodos.value.map((td: any) => ({ ...td, priority: deps.priority(td.priority) })),
    showTodos: calShowTodos.value,
    // 2026-09-23（用户第 3 条）：日志上日历
    logs: deps.logs(),
    showLogs: calShowLogs.value,
  }))

  const calCells = computed(() => calMonthData.value.cells)
  const calUnscheduled = computed(() => calMonthData.value.unscheduled)
  const calOtherMonths = computed(() => calMonthData.value.otherMonths)
  const calOtherTotal = computed(() => calMonthData.value.otherTotal)
  // 2026-09-25（用户第 10 条）：「日历下方的横条很密集很让人畏惧」——底部两排 chip 一多
  // 就是一片横条墙。默认收起，只留一行摘要，点开才铺开。
  const calBottomOpen = ref(false)

  function prioColor(p: any): string {
    const s = deps.priority(p)
    return s === '高' ? '#c96a6a' : s === '中' ? '#d9a44a' : s === '低' ? '#7a9e6b' : '#d5d3e0'
  }

  // ── 拖拽 ────────────────────────────────────────────────────────────────
  // 只记住"拖的是谁"，落盘的副作用留在 App.vue（那要 window.tegula + toast + 重新加载）
  function onCalDragStart(e: DragEvent, id: string, kind: 'task' | 'todo' | 'log' = 'task'): void {
    calDragId = id
    calDragKind = kind
    e.dataTransfer?.setData('text/plain', id)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }
  /**
   * 取走这次拖拽的目标并清空。
   * 为什么不直接把 calDragId 暴露出去：那是 let 变量，暴露了也拿不到响应式；
   * 而且"取一次就清空"是这里的正确语义（一次 drop 只该改一张卡）。
   */
  function takeDrag(): { id: string; kind: 'task' | 'todo' | 'log' } | null {
    const id = calDragId
    const kind = calDragKind
    calDragId = null
    return id ? { id, kind } : null
  }

  return {
    calYear, calMonth, calDragOverDay, calShowTodos, calShowLogs,
    calCellExpanded, calCellShown, calCellMore, toggleCalCell,
    calMove, calToday, calGoto, calToggleTodos, calToggleLogs,
    taskStart, taskDue,
    calActiveTasks, calActiveTodos,
    calMonthData, calCells, calUnscheduled, calOtherMonths, calOtherTotal, calBottomOpen,
    prioColor,
    onCalDragStart, takeDrag,
    // 这两个给 App.vue 的「指派时间」弹窗用（弹窗没搬，它需要同一套日期解析）
    calISO, pad2,
  }
}
