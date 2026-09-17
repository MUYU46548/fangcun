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

export function batchEdit(ids: string[], fields: Partial<TaskFrontmatter>): { ok: number; fails: { id: string; error: string }[] } {
  let ok = 0
  const fails: { id: string; error: string }[] = []
  for (const id of ids) {
    try {
      const t = updateTask(id, fields)
      if (t) ok++
      else fails.push({ id, error: '任务不存在' })
    } catch (e: any) {
      fails.push({ id, error: e.message })
    }
  }
  return { ok, fails }
}

export function batchArchive(ids: string[]): { ok: number; fails: { id: string; error: string }[] } {
  return batchEdit(ids, { status: '完成' })
}

// ── Quick Add ─────────────────────────────────────────────────────────

const QUICK_PRIO: Record<string, string> = { p0: '高', p1: '中', p2: '低', p3: '低' }

export function quickAdd(text: string): { ok: boolean; id?: string; error?: string } {
  const raw = (text || '').trim()
  if (!raw) return { ok: false, error: '内容为空' }

  const titleTokens: string[] = []
  const tags: string[] = []
  let priority = ''
  let assignee = ''
  let status: Status = '待办'

  for (const tk of raw.split(/\s+/)) {
    const low = tk.toLowerCase()
    if (low in QUICK_PRIO && !priority) {
      priority = QUICK_PRIO[low]
    } else if (tk.startsWith('#') && tk.length > 1) {
      const t = tk.slice(1).trim()
      if (t && !tags.includes(t)) tags.push(t)
    } else if (tk.startsWith('@') && tk.length > 1) {
      assignee = tk.slice(1).trim()
    } else if (low.startsWith('to:') && tk.length > 3) {
      const sv = tk.slice(3).trim()
      if ((STATUSES as readonly string[]).includes(sv)) {
        status = sv as Status
      } else {
        return { ok: false, error: `未知状态「${sv}」` }
      }
    } else {
      titleTokens.push(tk)
    }
  }

  const title = titleTokens.join(' ').trim()
  if (!title) return { ok: false, error: '标题为空' }

  const task = createTask({ title, status, priority: priority || undefined, assignee: assignee || undefined, tags })
  return { ok: true, id: task.id }
}

// ── Natural Query ─────────────────────────────────────────────────────

export function parseNaturalQuery(q: string): { tasks: Task[]; error?: string } {
  const raw = (q || '').trim()
  if (!raw) return { tasks: [], error: '查询为空' }

  const tags = [...raw.matchAll(/#(\S+)/g)].map(m => m[1])
  const projects = [...raw.matchAll(/@(\S+)/g)].map(m => m[1])
  let remaining = raw.replace(/[#@]\S+/g, '').trim()

  const statusMap: Record<string, string> = {
    '待办': '待办', '进行中': '进行中', '待验收': '待验收',
    '完成': '完成', '驳回': '驳回', '草稿': '草稿', '待审批': '待审批',
  }
  const prioMap: Record<string, string> = { '高': '高', '中': '中', '低': '低', '高优先级': '高', '中优先级': '中', '低优先级': '低' }

  let targetStatus: string | null = null
  let targetPrio: string | null = null
  for (const [kw, val] of Object.entries(statusMap)) {
    if (remaining.includes(kw)) {
      targetStatus = val
      remaining = remaining.replace(kw, '').trim()
      break
    }
  }
  for (const [kw, val] of Object.entries(prioMap)) {
    if (remaining.includes(kw)) {
      targetPrio = val
      remaining = remaining.replace(kw, '').trim()
      break
    }
  }

  let special: string | null = null
  if (remaining.includes('超时') || remaining.includes('超期')) {
    special = 'timeout'
    remaining = remaining.replace(/超时|超期/g, '').trim()
  } else if (remaining.includes('卡住') || remaining.includes('阻塞')) {
    special = 'blocked'
    remaining = remaining.replace(/卡住|阻塞/g, '').trim()
  }

  const titleQ = remaining.trim()
  let tasks = loadAllTasks()

  if (tags.length) {
    tasks = tasks.filter(t => tags.every(tag => (t.fm.tags || []).includes(tag)))
  }
  if (projects.length) {
    tasks = tasks.filter(t => {
      const p = t.fm.project
      if (!p) return false
      if (Array.isArray(p)) return projects.every(pid => p.includes(pid))
      return projects.includes(p)
    })
  }
  if (targetStatus) {
    tasks = tasks.filter(t => t.fm.status === targetStatus)
  }
  if (targetPrio) {
    tasks = tasks.filter(t => t.fm.priority === targetPrio)
  }
  if (special === 'timeout') {
    tasks = tasks.filter(t => {
      if (!t.fm.updated) return false
      const days = (Date.now() - new Date(t.fm.updated).getTime()) / (1000 * 60 * 60 * 24)
      return days > 14 && ['进行中', '待验收', '待审批', '待办'].includes(t.fm.status || '')
    })
  } else if (special === 'blocked') {
    tasks = tasks.filter(t => (t.fm.blockers || []).length > 0)
  }
  if (titleQ) {
    const lower = titleQ.toLowerCase()
    tasks = tasks.filter(t =>
      (t.fm.title || '').toLowerCase().includes(lower) ||
      t.id.toLowerCase().includes(lower)
    )
  }

  return { tasks }
}

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
  function scanDir(dir: string) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'archive' || entry.name === '.backup' || entry.name === '.trash') continue
        scanDir(fullPath)
      } else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
        const task = parseTask(fullPath)
        if (task) tasks.push(task)
      }
    }
  }
  scanDir(taskDir)
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
