/**
 * Fangcun Desktop — Todo Service
 * Personal quick todos (lighter than tasks, no project required)
 */

import * as fs from 'fs'
import * as path from 'path'
import { getDataDir } from '../data'

export interface Todo {
  id: string
  title: string
  done: boolean
  priority: 'high' | 'normal' | 'low'
  due?: string
  createdAt: string
  updatedAt: string
}

function getTodosPath(): string {
  const dataDir = getDataDir()
  const todosDir = path.join(dataDir, 'todos')
  fs.mkdirSync(todosDir, { recursive: true })
  return path.join(todosDir, 'index.json')
}

function loadTodos(): Todo[] {
  const p = getTodosPath()
  if (!fs.existsSync(p)) return []
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
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
    // Undone first, then by priority (high > normal > low), then by creation time
    if (a.done !== b.done) return a.done ? 1 : -1
    const prio = { high: 0, normal: 1, low: 2 }
    if (prio[a.priority] !== prio[b.priority]) return prio[a.priority] - prio[b.priority]
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })
}

export function createTodo(title: string, priority: 'high' | 'normal' | 'low' = 'normal', due?: string): Todo {
  const id = `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  const todo: Todo = { id, title, done: false, priority, due, createdAt: now, updatedAt: now }
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
  if (updates.priority !== undefined) todo.priority = updates.priority
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
