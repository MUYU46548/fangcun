/**
 * Fangcun Desktop — Task Operations
 * Business logic for task CRUD, status transitions, project scanning
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  Task, TaskFrontmatter, Status, STATUSES,
  parseTask, renderTask, atomicWrite, genId, logActivity,
  getTaskDir, getDataDir, parseRegistry, loadTasks
} from './index'

// Re-export for convenience
export { STATUSES }
export type { Task, TaskFrontmatter, Status }

// ── Task CRUD ───────────────────────────────────────────────────────────

export interface NewTaskFields {
  title: string
  project?: string
  status?: Status
  priority?: string
  assignee?: string
  tags?: string[]
  body?: string
  blockers?: string[]
}

export function createTask(fields: NewTaskFields): Task {
  const id = genId(fields.title)
  const now = new Date().toISOString()
  
  const fm: TaskFrontmatter = {
    id,
    title: fields.title,
    project: fields.project || '',
    status: fields.status || '待办',
    priority: fields.priority || 'normal',
    assignee: fields.assignee || '',
    tags: fields.tags || [],
    created: now,
    updated: now,
    blockers: fields.blockers || [],
  }

  const task: Task = {
    id,
    fm,
    body: fields.body || '',
    path: path.join(getTaskDir(), `${id}.md`),
  }

  atomicWrite(task.path, renderTask(task))
  logActivity(id, 'created', fields.title)
  return task
}

export function readTask(id: string): Task | null {
  const taskDir = getTaskDir()
  // Search in main directory and subdirectories
  function searchInDir(dir: string): Task | null {
    if (!fs.existsSync(dir)) return null
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = searchInDir(fullPath)
        if (found) return found
      } else if (entry.name.endsWith('.md') && entry.name.startsWith(id)) {
        return parseTask(fullPath)
      }
    }
    return null
  }
  return searchInDir(taskDir)
}

export function updateTask(id: string, fields: Partial<TaskFrontmatter>): Task | null {
  const task = readTask(id)
  if (!task) return null

  if (fields.expected_update && task.fm.expected_update !== fields.expected_update) {
    throw new Error('optimistic lock conflict')
  }

  const now = new Date().toISOString()
  task.fm = { ...task.fm, ...fields, updated: now }
  task.fm.expected_update = genId('lock')

  atomicWrite(task.path, renderTask(task))
  logActivity(id, 'updated', JSON.stringify(Object.keys(fields)))
  return task
}

export function moveStatus(id: string, newStatus: Status): Task | null {
  const task = readTask(id)
  if (!task) return null
  
  task.fm.status = newStatus
  task.fm.updated = new Date().toISOString()
  task.fm.expected_update = genId('lock')
  
  atomicWrite(task.path, renderTask(task))
  logActivity(id, 'move_status', newStatus)
  return task
}

export function deleteTask(id: string): boolean {
  const task = readTask(id)
  if (!task) return false

  const trashDir = path.join(getDataDir(), 'trash')
  fs.mkdirSync(trashDir, { recursive: true })
  const trashPath = path.join(trashDir, path.basename(task.path))
  fs.renameSync(task.path, trashPath)
  logActivity(id, 'deleted')
  return true
}

export function archiveTask(id: string): Task | null {
  return updateTask(id, { status: '完成' })
}

// ── Project Status ──────────────────────────────────────────────────────

export interface ProjectStatus {
  id: string
  name: string
  taskCount: number
  activeTasks: number
  completedTasks: number
  lastActivity: string | null
  health: 'active' | 'stuck' | 'dormant' | 'idle'
}

export function scanProjectStatus(): ProjectStatus[] {
  const projects = parseRegistry()
  const tasks = loadAllTasks()

  return projects.map(proj => {
    const projId = proj.id
    const projTasks = tasks.filter(t => {
      const p = t.fm.project
      if (!p) return false
      if (Array.isArray(p)) return p.includes(projId)
      return p === projId
    })
    const active = projTasks.filter(t => t.fm.status !== '完成' && t.fm.status !== '驳回')
    const completed = projTasks.filter(t => t.fm.status === '完成')

    let lastActivity: string | null = null
    for (const t of projTasks) {
      if (t.fm.updated && (!lastActivity || t.fm.updated > lastActivity)) {
        lastActivity = t.fm.updated
      }
    }

    const health = computeHealth(projTasks, lastActivity)

    return {
      id: proj.id,
      name: proj.name || proj.id,
      taskCount: projTasks.length,
      activeTasks: active.length,
      completedTasks: completed.length,
      lastActivity,
      health,
    }
  })
}

function computeHealth(tasks: Task[], lastActivity: string | null): ProjectStatus['health'] {
  if (tasks.length === 0) return 'idle'
  if (!lastActivity) return 'dormant'

  const daysSinceActivity = (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24)
  if (daysSinceActivity > 30) return 'dormant'
  if (daysSinceActivity > 7) return 'stuck'
  return 'active'
}

// ── Helpers ─────────────────────────────────────────────────────────────

function loadAllTasks(): Task[] {
  const taskDir = getTaskDir()
  if (!fs.existsSync(taskDir)) return []

  const tasks: Task[] = []
  for (const entry of fs.readdirSync(taskDir)) {
    if (!entry.endsWith('.md')) continue
    const task = parseTask(path.join(taskDir, entry))
    if (task) tasks.push(task)
  }
  return tasks
}

export function findBlockers(): { id: string; title: string; blockers: string[] }[] {
  const tasks = loadAllTasks()
  const result: { id: string; title: string; blockers: string[] }[] = []

  for (const task of tasks) {
    if (task.fm.blockers && task.fm.blockers.length > 0) {
      result.push({
        id: task.id,
        title: task.fm.title || task.id,
        blockers: task.fm.blockers,
      })
    }
  }
  return result
}
