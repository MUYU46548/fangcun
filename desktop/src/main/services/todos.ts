/**
 * Fangcun Desktop — Todo Service
 * Personal quick todos (lighter than tasks, no project required)
 *
 * 优先级与任务、Python CLI 保持一致：高 / 中 / 低。
 * 存量数据里若存在 high/normal/low，读取时由 normalizePriority 自动归一。
 */

import * as fs from 'fs'
import * as path from 'path'
import { getDataDir, normalizePriority, atomicWrite } from '../data'
import * as appLog from './appLog'

export interface Todo {
  id: string
  title: string
  done: boolean
  /** 高 / 中 / 低 */
  priority: string
  /** 到期日（`YYYY-MM-DD` 或历史遗留的 `MM-DD`）—— 只到"天" */
  due?: string
  /**
   * 到期时间（2026-10-12 暮雨：「待办只有到期日，建议再加一个可选的时间字段。
   * 如 WorkBuddy 额度 21:33:59 重置，让用户选个 21:39」）。
   *
   * 格式 `HH:MM`（24 小时制），**可选**：
   *   · 空/未设 = 老行为（只有日期，按天判定逾期）；
   *   · 有值 = 与 `due` 组合成**分钟级**截止点（如 `due=2026-10-12` + `dueTime=21:39`）。
   *
   * ⚠ 为什么**不把时间并进 `due`**：`due` 是只到天的字符串，被日历、筛选、排序、
   *   逾期天数、Python 侧「截止」字段等**多处**按日期解析。并进去要同时改这些解析点，
   *   且存量数据里 `MM-DD`（无年份无时间）与 `YYYY-MM-DD` 两种写法都会混进来。
   *   独立字段是**纯增量**：老数据零变化、老解析点零改动。
   */
  dueTime?: string
  /** 归属项目（registry id），空 = 不归属。用于看板联动筛选 */
  project?: string
  /** 置顶（2026-09-26 卡 037）：钉在列表最上面，跟完成状态/优先级正交 */
  pinned?: boolean
  /**
   * 来源日志 ID（2026-10-08 卡 task-20261008-004 日志⇄待办互转，拍板=双向）。
   * 与接力链/日志链同一套「目标记录 `由 X 转来`」范式：源保留不删，目标记来源。
   * 两个用途：① 待办上看得见「这条是哪条日志转来的」；② **防重** —— 同一条日志转过一次
   * 就不再转（用户手滑点两下不该产出两条）。只在有值时出现（normalizeTodo 给 undefined）。
   */
  fromLog?: string
  /**
   * 已转出到日志（2026-10-09 用户第 1 条：转换可「顺手归档源」）。
   * 值 = 目标日志 id：折叠只是把重复源藏起来（不是删除），有 id 才能指回去找回/防重。
   * 只在有值时出现（normalizeTodo 给 undefined）—— 没转过的待办零变化。
   */
  converted?: string
  createdAt: string
  updatedAt: string
}

/** 排序权重：高 > 中 > 低，未知值排最后 */
const PRIO_WEIGHT: Record<string, number> = { '高': 0, '中': 1, '低': 2 }

function getTodosPath(): string {
  const dataDir = getDataDir()
  const todosDir = path.join(dataDir, 'todos')
  fs.mkdirSync(todosDir, { recursive: true })
  return path.join(todosDir, 'index.json')
}

/** 归一 `HH:MM`（24 小时制）。无法识别一律 undefined —— **不许落半截值**
 *  （`"21:39:00"` / `"9:5"` / `"2139"` 这类都归一成标准 `HH:MM`，其余丢弃）。
 *  ⚠ 空串必须归 undefined 而不是保留 `''`：**没设 ≠ 设成了空**（与 converted 同口径），
 *    留着空串会让 `hasDueTime` 之类的判据变成"有值"从而说假话。 */
export function normalizeDueTime(v: any): string | undefined {
  if (v === null || v === undefined) return undefined
  const s = String(v).trim()
  if (!s) return undefined
  // 容忍 `9:5` / `09:05` / `21:39` / `21:39:00` / `21：39`（全角冒号）
  const m = s.replace(/：/g, ':').match(/^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/)
  if (!m) return undefined
  const hh = Number(m[1]); const mm = Number(m[2])
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return undefined
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return undefined
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/** 归一单条记录（含历史英文优先级） */
function normalizeTodo(raw: any): Todo {
  return {
    id: String(raw?.id ?? ''),
    title: String(raw?.title ?? ''),
    done: !!raw?.done,
    priority: normalizePriority(raw?.priority) || '中',
    due: raw?.due,
    dueTime: normalizeDueTime(raw?.dueTime),
    project: raw?.project || undefined,
    pinned: raw?.pinned === true,
    fromLog: raw?.fromLog ? String(raw.fromLog) : undefined,
    converted: raw?.converted ? String(raw.converted) : undefined,
    createdAt: String(raw?.createdAt ?? ''),
    updatedAt: String(raw?.updatedAt ?? ''),
  }
}

/**
 * 最近一次读取是否遇到坏文件（供界面显性化，见 todosHealth）。
 *
 * 2026-09-26 卡 033 修的真问题：旧实现解析失败**静默 return []**，
 * 界面只表现为"待办突然空了"；而紧接着的任何一次写入（新增一条）都会
 * 把那份坏文件**覆盖成只剩新任务** —— 历史待办被静默销毁。
 * 用户对数据丢失极敏感，所以坏文件一律**改名隔离**而不是丢弃：
 *   todos/index.json            → todos/index.json.corrupt-<时间戳>
 * 之后正常从空列表开始写，坏文件原样留着，随时能人工救回。
 */
let lastLoadError: { at: string; file: string; quarantined: string; error: string } | null = null

function quarantineCorrupt(file: string, error: string): void {
  let dest = `${file}.corrupt-${Date.now()}`
  try {
    fs.renameSync(file, dest)
  } catch (e: any) {
    // 改名失败（被占用/权限）：至少别让它被下次写入覆盖
    dest = `${file}（改名失败：${e?.message || e}）`
  }
  lastLoadError = { at: new Date().toISOString(), file, quarantined: dest, error }
  appLog.error('todos', `待办文件解析失败，已隔离原文件：${dest}`, error)
}

function loadTodos(): Todo[] {
  const p = getTodosPath()
  if (!fs.existsSync(p)) return []
  let text = ''
  try {
    text = fs.readFileSync(p, 'utf-8')
  } catch (e: any) {
    lastLoadError = { at: new Date().toISOString(), file: p, quarantined: '', error: `读取失败：${e?.message || e}` }
    return []
  }
  try {
    const raw = JSON.parse(text)
    if (!Array.isArray(raw)) throw new Error('顶层不是数组')
    return raw.map(normalizeTodo)
  } catch (e: any) {
    quarantineCorrupt(p, e?.message || String(e))
    return []
  }
}

/** 原子写 + 回读校验（原来直接 writeFileSync：写一半崩溃 = 整个 index.json 损坏） */
function saveTodos(todos: Todo[]): void {
  atomicWrite(getTodosPath(), JSON.stringify(todos, null, 2))
}

/** 待办数据健康度（坏文件隔离留痕，界面用来显性化"数据出过事"） */
export function todosHealth(): { ok: boolean; path: string; lastError: typeof lastLoadError } {
  // 主动探一次：界面刷新时调用即可发现新出现的坏文件
  loadTodos()
  return { ok: lastLoadError === null, path: getTodosPath(), lastError: lastLoadError }
}

export function listTodos(filter?: { done?: boolean }): Todo[] {
  let todos = loadTodos()
  if (filter?.done !== undefined) {
    todos = todos.filter(t => t.done === filter.done)
  }
  return todos.sort((a, b) => {
    // 置顶最优先（2026-09-26 卡 037）→ 未完成优先 → 优先级 → 创建时间倒序
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    if (a.done !== b.done) return a.done ? 1 : -1
    const wa = PRIO_WEIGHT[a.priority] ?? 9
    const wb = PRIO_WEIGHT[b.priority] ?? 9
    if (wa !== wb) return wa - wb
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })
}

export function createTodo(title: string, priority: string = '中', due?: string, project?: string, fromLog?: string, dueTime?: string): Todo {
  const id = `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  const todo: Todo = {
    id,
    title,
    done: false,
    priority: normalizePriority(priority) || '中',
    due,
    // ⚠ 归一失败（乱敲的）**不进库** —— 宁可当没填，也不要在数据里留一个解析不了的值
    dueTime: normalizeDueTime(dueTime),
    project: project || undefined,
    // 卡 004：只有「日志转来」这条路会带值；普通新建不写这个键
    fromLog: fromLog ? String(fromLog) : undefined,
    createdAt: now,
    updatedAt: now,
  }
  const todos = loadTodos()
  todos.push(todo)
  saveTodos(todos)
  return todo
}

/**
 * 置顶 / 取消置顶（2026-09-26 卡 037）。
 * 待办是整份 JSON，读写都过 loadTodos/saveTodos（原子写 + 坏文件隔离），不新增写路径。
 */
export function setTodoPinned(id: string, pinned: boolean): Todo | null {
  return updateTodo(id, { pinned: !!pinned } as any)
}

export function updateTodo(id: string, updates: Partial<Pick<Todo, 'title' | 'done' | 'priority' | 'due' | 'dueTime' | 'project' | 'pinned' | 'converted'>>): Todo | null {
  const todos = loadTodos()
  const idx = todos.findIndex(t => t.id === id)
  if (idx < 0) return null
  const todo = todos[idx]
  if (updates.title !== undefined) todo.title = updates.title
  if (updates.done !== undefined) todo.done = updates.done
  if (updates.priority !== undefined) todo.priority = normalizePriority(updates.priority) || '中'
  if (updates.due !== undefined) todo.due = updates.due
  // dueTime：清空（传 '' / null）→ 字段从 JSON 消失，与 converted 同口径。
  // ⚠ 清空必须**真的能清空**：否则用户填错一次就再也去不掉那个时间。
  if (updates.dueTime !== undefined) todo.dueTime = normalizeDueTime(updates.dueTime)
  if (updates.project !== undefined) todo.project = updates.project || undefined
  if (updates.pinned !== undefined) todo.pinned = !!updates.pinned
  // converted：空串 = 撤销已转出（字段从 JSON 消失，与日志 priority 清除同口径）
  if (updates.converted !== undefined) todo.converted = updates.converted || undefined
  todo.updatedAt = new Date().toISOString()
  saveTodos(todos)
  return todo
}

export function deleteTodo(id: string): boolean {
  const todos = loadTodos()
  const idx = todos.findIndex(t => t.id === id)
  if (idx < 0) return false
  todos.splice(idx, 1)
  saveTodos(todos)
  return true
}

export function toggleTodo(id: string): Todo | null {
  const todos = loadTodos()
  const idx = todos.findIndex(t => t.id === id)
  if (idx < 0) return null
  todos[idx].done = !todos[idx].done
  todos[idx].updatedAt = new Date().toISOString()
  saveTodos(todos)
  return todos[idx]
}
