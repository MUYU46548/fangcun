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
  due?: string
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

/** 归一单条记录（含历史英文优先级） */
function normalizeTodo(raw: any): Todo {
  return {
    id: String(raw?.id ?? ''),
    title: String(raw?.title ?? ''),
    done: !!raw?.done,
    priority: normalizePriority(raw?.priority) || '中',
    due: raw?.due,
    project: raw?.project || undefined,
    pinned: raw?.pinned === true,
    fromLog: raw?.fromLog ? String(raw.fromLog) : undefined,
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

export function createTodo(title: string, priority: string = '中', due?: string, project?: string, fromLog?: string): Todo {
  const id = `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  const todo: Todo = {
    id,
    title,
    done: false,
    priority: normalizePriority(priority) || '中',
    due,
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

export function updateTodo(id: string, updates: Partial<Pick<Todo, 'title' | 'done' | 'priority' | 'due' | 'project' | 'pinned'>>): Todo | null {
  const todos = loadTodos()
  const idx = todos.findIndex(t => t.id === id)
  if (idx < 0) return null
  const todo = todos[idx]
  if (updates.title !== undefined) todo.title = updates.title
  if (updates.done !== undefined) todo.done = updates.done
  if (updates.priority !== undefined) todo.priority = normalizePriority(updates.priority) || '中'
  if (updates.due !== undefined) todo.due = updates.due
  if (updates.project !== undefined) todo.project = updates.project || undefined
  if (updates.pinned !== undefined) todo.pinned = !!updates.pinned
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
