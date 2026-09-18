/**
 * Fangcun Desktop — Todo Service
 * Personal quick todos (lighter than tasks, no project required)
 *
 * 优先级与任务、Python CLI 保持一致：高 / 中 / 低。
 * 存量数据里若存在 high/normal/low，读取时由 normalizePriority 自动归一。
 */

import * as fs from 'fs'
import * as path from 'path'
import { getDataDir, normalizePriority } from '../data'

export interface Todo {
  id: string
  title: string
  done: boolean
  /** 高 / 中 / 低 */
  priority: string
  due?: string
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
    createdAt: String(raw?.createdAt ?? ''),
    updatedAt: String(raw?.updatedAt ?? ''),
  }
}

function loadTodos(): Todo[] {
  const p = getTodosPath()
  if (!fs.existsSync(p)) return []
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (!Array.isArray(raw)) return []
    return raw.map(normalizeTodo)
  } catch {
    return []
  }
}

function saveTodos(todos: Todo[]): void {
  fs.writeFileSync(getTodosPath(), JSON.stringify(todos, null, 2), 'utf-8')
}

export function listTodos(filter?: { done?: boolean }): Todo[] {
  let todos = loadTodos()
  if (filter?.done !== undefined) {
    todos = todos.filter(t => t.done === filter.done)
  }
  return todos.sort((a, b) => {
    // 未完成优先 → 优先级 → 创建时间倒序
    if (a.done !== b.done) return a.done ? 1 : -1
    const wa = PRIO_WEIGHT[a.priority] ?? 9
    const wb = PRIO_WEIGHT[b.priority] ?? 9
    if (wa !== wb) return wa - wb
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })
}

export function createTodo(title: string, priority: string = '中', due?: string): Todo {
  const id = `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  const todo: Todo = {
    id,
    title,
    done: false,
    priority: normalizePriority(priority) || '中',
    due,
    createdAt: now,
    updatedAt: now,
  }
  const todos = loadTodos()
  todos.push(todo)
  saveTodos(todos)
  return todo
}

export function updateTodo(id: string, updates: Partial<Pick<Todo, 'title' | 'done' | 'priority' | 'due'>>): Todo | null {
  const todos = loadTodos()
  const idx = todos.findIndex(t => t.id === id)
  if (idx < 0) return null
  const todo = todos[idx]
  if (updates.title !== undefined) todo.title = updates.title
  if (updates.done !== undefined) todo.done = updates.done
  if (updates.priority !== undefined) todo.priority = normalizePriority(updates.priority) || '中'
  if (updates.due !== undefined) todo.due = updates.due
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
