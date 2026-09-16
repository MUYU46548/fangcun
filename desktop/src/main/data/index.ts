/**
 * Fangcun Desktop — Data Layer (TypeScript)
 * Migrated from tegula/core.py + tegula/safe_io.py
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { app } from 'electron'

// ── Paths ──────────────────────────────────────────────────────────────

let DATA_DIR: string
let TASK_DIR: string
let REGISTRY_PATH: string
let BACKUP_DIR: string
let ACTIVITY_LOG: string

export function initPaths(): void {
  // Portable: if registry.yaml exists next to exe, use it
  const exeDir = path.dirname(app.getPath('exe'))
  const portableReg = path.join(exeDir, 'registry.yaml')
  const portableTask = path.join(exeDir, 'task-data')

  let baseDir: string
  if (fs.existsSync(portableReg) || fs.existsSync(portableTask)) {
    baseDir = exeDir
  } else {
    baseDir = path.join(app.getPath('userData'))
  }

  DATA_DIR = baseDir
  TASK_DIR = path.join(DATA_DIR, 'task-data')
  REGISTRY_PATH = path.join(DATA_DIR, 'registry.yaml')
  BACKUP_DIR = path.join(DATA_DIR, 'backups')
  ACTIVITY_LOG = path.join(TASK_DIR, '.activity.log')

  fs.mkdirSync(TASK_DIR, { recursive: true })
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
}

export function getDataDir(): string { return DATA_DIR }
export function getTaskDir(): string { return TASK_DIR }
export function getRegistryPath(): string { return REGISTRY_PATH }

// ── Status Enum ─────────────────────────────────────────────────────────

export const STATUSES = ['草稿', '待审批', '待办', '进行中', '待验收', '完成', '驳回'] as const
export type Status = typeof STATUSES[number]

// ── Task Types ──────────────────────────────────────────────────────────

export interface TaskFrontmatter {
  id: string
  title?: string
  project?: string
  status?: Status
  priority?: string
  assignee?: string
  tags?: string[]
  created?: string
  updated?: string
  expected_update?: string  // optimistic lock
  blockers?: string[]
  [key: string]: unknown
}

export interface Task {
  id: string
  fm: TaskFrontmatter
  body: string
  path: string
}

// ── YAML Parser (simplified) ───────────────────────────────────────────

export function parseRegistry(includeReleased = true): any[] {
  if (!fs.existsSync(REGISTRY_PATH)) return []

  const content = fs.readFileSync(REGISTRY_PATH, 'utf-8')
  const lines = content.split('\n')
  const projects: any[] = []
  let current: any = null
  let inSection: string | null = null

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    // Section header
    if (!raw.startsWith(' ')) {
      const m = line.match(/^([A-Za-z_]+):\s*$/)
      if (m && (m[1] === 'projects' || (includeReleased && m[1] === 'released'))) {
        inSection = m[1]
      } else {
        inSection = null
      }
      current = null
      continue
    }

    if (inSection === null) continue

    // New project entry
    if (line.startsWith('- ')) {
      const rest = line.slice(2).trim()
      current = {}
      projects.push(current)
      const kv = rest.match(/^([^:]+):\s*(.*)$/)
      if (kv) {
        current[kv[1].trim()] = coerce(kv[2].trim())
      }
      continue
    }

    // Property line
    if (current) {
      const kv = line.match(/^([^:]+):\s*(.*)$/)
      if (kv) {
        current[kv[1].trim()] = coerce(kv[2].trim())
      }
    }
  }

  return projects
}

function coerce(v: string): any {
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''))
  }
  if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) {
    return v.slice(1, -1)
  }
  return v
}

// ── Task File I/O ───────────────────────────────────────────────────────

export function parseTask(filePath: string): Task | null {
  if (!fs.existsSync(filePath)) return null

  const content = fs.readFileSync(filePath, 'utf-8')
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!fmMatch) return null

  const fmText = fmMatch[1]
  const body = fmMatch[2]
  const fm: TaskFrontmatter = { id: '' }

  for (const line of fmText.split('\n')) {
    const m = line.match(/^([^:]+):\s*(.*)$/)
    if (m) {
      const key = m[1].trim()
      const val = m[2].trim()
      if (val.startsWith('[')) {
        fm[key] = coerce(val)
      } else {
        fm[key] = val
      }
    }
  }

  fm.id = fm.id || path.basename(filePath, '.md')
  return { id: fm.id, fm, body, path: filePath }
}

export function renderTask(task: Task): string {
  const lines = ['---']
  for (const [k, v] of Object.entries(task.fm)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.join(', ')}]`)
    } else {
      lines.push(`${k}: ${v}`)
    }
  }
  lines.push('---')
  lines.push(task.body)
  return lines.join('\n')
}

export function loadTasks(view = 'active'): Task[] {
  if (!fs.existsSync(TASK_DIR)) return []

  const tasks: Task[] = []
  for (const entry of fs.readdirSync(TASK_DIR)) {
    if (!entry.endsWith('.md')) continue
    const filePath = path.join(TASK_DIR, entry)
    const task = parseTask(filePath)
    if (!task) continue

    // Filter by view
    if (view === 'active') {
      const status = task.fm.status
      if (status === '完成' || status === '驳回') continue
    }
    tasks.push(task)
  }

  return tasks
}

// ── Atomic Write + Backup ───────────────────────────────────────────────

export function atomicWrite(filePath: string, content: string): void {
  const tmp = filePath + '.tmp'

  // Write to temp
  fs.writeFileSync(tmp, content, 'utf-8')

  // Verify read-back
  try {
    const read = fs.readFileSync(tmp, 'utf-8')
    if (!read) throw new Error('readback empty')
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    throw new Error(`Atomic write verification failed for ${filePath}: ${e}`)
  }

  // Rotate backup
  rotateBackup(filePath)

  // Atomic rename
  fs.renameSync(tmp, filePath)
}

export function rotateBackup(filePath: string): void {
  if (!fs.existsSync(filePath)) return

  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backupPath = path.join(dir, '.backup', `${base}.${stamp}.bak`)

  fs.mkdirSync(path.dirname(backupPath), { recursive: true })
  fs.copyFileSync(filePath, backupPath)

  // Cleanup old backups (keep last 10)
  const backupDir = path.dirname(backupPath)
  const backups = fs.readdirSync(backupDir)
    .filter(f => f.startsWith(base) && f.endsWith('.bak'))
    .sort()

  while (backups.length > 10) {
    const old = backups.shift()!
    try { fs.unlinkSync(path.join(backupDir, old)) } catch {}
  }
}

// ── ID Generation ───────────────────────────────────────────────────────

export function genId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fff-]/g, '')
    .slice(0, 20)
  const hash = crypto.randomBytes(4).toString('hex')
  return `${slug || 'task'}-${hash}`
}

// ── Startup Self-Check ──────────────────────────────────────────────────

export interface SelfCheckResult {
  ok: boolean
  message: string
}

export function startupSelfCheck(): SelfCheckResult {
  if (!fs.existsSync(TASK_DIR)) {
    return { ok: false, message: `task-data directory missing: ${TASK_DIR}` }
  }
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { ok: false, message: `registry.yaml missing: ${REGISTRY_PATH}` }
  }
  try {
    parseRegistry()
  } catch (e) {
    return { ok: false, message: `registry.yaml parse error: ${e}` }
  }
  try {
    const tasks = loadTasks('active')
    if (tasks.length === 0) {
      return { ok: false, message: `No tasks found in ${TASK_DIR}` }
    }
  } catch (e) {
    return { ok: false, message: `task-data read error: ${e}` }
  }
  return { ok: true, message: 'OK' }
}

// ── Activity Log ────────────────────────────────────────────────────────

export function logActivity(taskId: string, action: string, detail?: string): void {
  const entry = {
    ts: new Date().toISOString(),
    tid: taskId,
    action,
    detail,
  }
  const line = JSON.stringify(entry) + '\n'
  fs.appendFileSync(ACTIVITY_LOG, line, 'utf-8')
}

export function readActivity(limit = 50): any[] {
  if (!fs.existsSync(ACTIVITY_LOG)) return []
  const lines = fs.readFileSync(ACTIVITY_LOG, 'utf-8').trim().split('\n').filter(Boolean)
  return lines.slice(-limit).map(l => JSON.parse(l))
}
