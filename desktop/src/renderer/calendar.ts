/**
 * Fangcun Desktop — 日历纯逻辑（2026-09-22）
 *
 * 为什么单独成文件：日历最容易出错的地方不是 UI，而是**跨月边界的日期算术**
 * （时间段横跨月末/月初、MM-DD 没年份、把"另一月"误判成"未安排"）。
 * 这类错误在界面上只表现为"少了一个/多了一天"，肉眼很难发现；
 * 放在纯函数里就能被脚本直接断言（scripts/test/e2e-calendar.cjs）。
 *
 * 本文件不得依赖 Vue / DOM / Electron —— 保持可被 Node 直接编译执行。
 */

export interface CalTaskLike {
  id: string
  title?: string
  status?: string
  /** 已归一的优先级（高/中/低） */
  priority?: string
  start?: unknown
  deadline?: unknown
}

export interface CalTodoLike {
  id: string
  title: string
  done?: boolean
  due?: unknown
  priority?: string
}

export type Span = 'only' | 'start' | 'mid' | 'end'

export interface CalEvent<T = CalTaskLike, D = CalTodoLike> {
  kind: 'task' | 'todo'
  id: string
  title: string
  status: string
  priority: string
  span: Span
  /** 该任务时间段覆盖的总天数（跨月也按完整区间算） */
  rangeDays: number
  /** 原始对象引用，便于前端直接 openCard / 打开指派 */
  ref: T | D
}

export interface CalCell<T = CalTaskLike, D = CalTodoLike> {
  day: number
  isToday: boolean
  isPast: boolean
  events: CalEvent<T, D>[]
}

export interface CalMonthGroup {
  key: string
  label: string
  year: number
  /** 0-based */
  month: number
  count: number
}

export interface CalMonthResult<T = CalTaskLike, D = CalTodoLike> {
  /** 前置空格为 null */
  cells: (CalCell<T, D> | null)[]
  /** 完全没有时间（无开始也无截止）的任务 */
  unscheduled: T[]
  /** 有时间但不在本月的任务，按月份分组 */
  otherMonths: CalMonthGroup[]
  otherTotal: number
}

const MS_DAY = 86400000
const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 终态任务不占日历（完成/驳回） */
export function isTerminal(status?: string): boolean {
  return status === '完成' || status === '驳回'
}

export function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

/** Date → 'YYYY-MM-DD'（本地时区，不用 toISOString，避免时区把日期挪一天） */
export function calISO(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * 解析时间值：MM-DD / YYYY-MM-DD / ISO / Date；无效返回 null。
 *
 * MM-DD 没有年份 —— 按"距今天最近"取年：若解析结果比今天早 180 天以上，就顺延一年。
 * 选这个规则是因为它在跨月/跨年导航下最稳定（01-15 在 9 月看会落在明年 1 月）。
 */
export function parseCalDate(v: unknown, today: Date = new Date()): Date | null {
  if (v === undefined || v === null || v === '') return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v
  const s = String(v).trim()
  if (!s) return null
  let d: Date
  if (/^\d{1,2}-\d{1,2}$/.test(s)) {
    const [mm, dd] = s.split('-').map(Number)
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
    d = new Date(today.getFullYear(), mm - 1, dd)
    if (d.getTime() < today.getTime() - 180 * MS_DAY) d.setFullYear(d.getFullYear() + 1)
  } else {
    d = new Date(s)
  }
  return isNaN(d.getTime()) ? null : d
}

const PRIO_RANK: Record<string, number> = { '高': 0, '中': 1, '低': 2 }

function prioRank(p?: string): number {
  return PRIO_RANK[p || ''] ?? 9
}

/** 任务的时间区间：开始/截止任一存在即可；非法或反序都容错 */
export function taskRange(
  t: CalTaskLike,
  today: Date = new Date(),
): { lo: Date; hi: Date } | null {
  const s = parseCalDate(t.start, today)
  const e = parseCalDate(t.deadline, today)
  if (!s && !e) return null
  const a = dayStart((s || e)!)
  const b = dayStart((e || s)!)
  return a <= b ? { lo: a, hi: b } : { lo: b, hi: a }
}

/**
 * 时间段平移：把「开始」落到目标日，保持长度不变（拖动整个区间的手感）。
 * 返回的日期字符串可直接写回 frontmatter。
 */
export function shiftRange(
  start: string,
  end: string,
  toDay: string,
): { start: string; end: string } {
  const s = parseCalDate(start)
  const e = parseCalDate(end)
  const t = parseCalDate(toDay)
  if (!t) return { start, end }
  if (!s || !e) return { start, end: toDay }
  const len = Math.round((dayStart(e).getTime() - dayStart(s).getTime()) / MS_DAY)
  return { start: calISO(t), end: calISO(addDays(t, len)) }
}

/** 详情面板用：'开始 → 截止' / 单值 / 未指派 */
export function rangeLabel(start?: unknown, deadline?: unknown): string {
  const s = start ? String(start).trim() : ''
  const d = deadline ? String(deadline).trim() : ''
  if (s && d) return `${s} → ${d}`
  if (d) return `${d}（截止）`
  if (s) return `${s}（开始）`
  return '未指派'
}

/**
 * 把一个月的格子、未安排、其它月份一次性算出来。
 * month 为 0-based；前置空格（周一开头）用 null 占位。
 */
export function buildMonth<T extends CalTaskLike, D extends CalTodoLike>(
  input: {
    year: number
    month: number
    today?: Date
    tasks: T[]
    todos?: D[]
    showTodos?: boolean
  },
): CalMonthResult<T, D> {
  const today = input.today ? dayStart(input.today) : dayStart(new Date())
  const y = input.year
  const m = input.month
  const days = new Date(y, m + 1, 0).getDate()
  const monthStart = new Date(y, m, 1)
  const monthEnd = new Date(y, m, days)
  const inMonth = (d: Date) => d.getFullYear() === y && d.getMonth() === m

  const byDay: Record<number, CalEvent<T, D>[]> = {}
  const push = (day: number, ev: CalEvent<T, D>) => {
    ;(byDay[day] = byDay[day] || []).push(ev)
  }

  const active = input.tasks.filter(t => !isTerminal(t.status))
  const unscheduled: T[] = []
  const groups: Record<string, CalMonthGroup> = {}

  for (const t of active) {
    const r = taskRange(t, today)
    if (!r) {
      unscheduled.push(t)
      continue
    }
    const { lo, hi } = r
    // 与本月完全无交集 → 归到"其它月份"
    if (hi < monthStart || lo > monthEnd) {
      const key = `${lo.getFullYear()}-${pad2(lo.getMonth() + 1)}`
      groups[key] = groups[key] || {
        key, label: `${lo.getFullYear()} 年 ${lo.getMonth() + 1} 月`,
        year: lo.getFullYear(), month: lo.getMonth(), count: 0,
      }
      groups[key].count++
      continue
    }
    const visStart = lo < monthStart ? 1 : lo.getDate()
    const visEnd = hi > monthEnd ? days : hi.getDate()
    const rangeDays = Math.round((hi.getTime() - lo.getTime()) / MS_DAY) + 1
    for (let d = visStart; d <= visEnd; d++) {
      let span: Span
      if (visStart === visEnd) span = 'only'
      else if (d === visStart) span = lo >= monthStart ? 'start' : 'mid'
      else if (d === visEnd) span = hi <= monthEnd ? 'end' : 'mid'
      else span = 'mid'
      push(d, {
        kind: 'task', id: t.id, title: t.title || t.id, status: t.status || '',
        priority: t.priority || '', span, rangeDays, ref: t,
      })
    }
  }

  if (input.showTodos) {
    for (const td of input.todos || []) {
      if (td.done) continue
      const d = parseCalDate(td.due, today)
      if (!d) continue
      if (!inMonth(d)) {
        // 下月到期的待办也要出现在「其它月份」里 —— 否则开关一开，
        // 它会从本月视图凭空消失且没有任何去处（静默丢数据的老毛病）。
        const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
        groups[key] = groups[key] || {
          key, label: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`,
          year: d.getFullYear(), month: d.getMonth(), count: 0,
        }
        groups[key].count++
        continue
      }
      push(dayStart(d).getDate(), {
        kind: 'todo', id: td.id, title: td.title, status: '待办',
        priority: td.priority || '', span: 'only', rangeDays: 1, ref: td,
      })
    }
  }

  const cells: (CalCell<T, D> | null)[] = []
  const lead = (new Date(y, m, 1).getDay() + 6) % 7 // 周一为第一格
  for (let i = 0; i < lead; i++) cells.push(null)
  for (let d = 1; d <= days; d++) {
    const evs = (byDay[d] || []).slice().sort((a, b) => {
      // 任务在前；时间段长的在前；再按优先级
      if (a.kind !== b.kind) return a.kind === 'task' ? -1 : 1
      if (b.rangeDays !== a.rangeDays) return b.rangeDays - a.rangeDays
      return prioRank(a.priority) - prioRank(b.priority)
    })
    cells.push({
      day: d,
      isToday: today.getFullYear() === y && today.getMonth() === m && today.getDate() === d,
      isPast: new Date(y, m, d) < today,
      events: evs,
    })
  }

  const otherMonths = Object.values(groups).sort((a, b) => a.key.localeCompare(b.key))
  return {
    cells,
    unscheduled,
    otherMonths,
    otherTotal: otherMonths.reduce((n, g) => n + g.count, 0),
  }
}
