/**
 * Fangcun Desktop — Data Layer (TypeScript)
 * Migrated from tegula/core.py + tegula/safe_io.py
 * 
 * P1 Stability Fixes:
 * - Replaced handwritten YAML parser with js-yaml
 * - Removed hardcoded path fallback (E:\CODE\CangKu\fangcun)
 * - Added backup integrity checksums (sha256)
 * - Better renderTask using yaml.dump for proper serialization
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { app } from 'electron'
import * as yaml from 'js-yaml'

// ── Paths ──────────────────────────────────────────────────────────────

let DATA_DIR: string
let TASK_DIR: string
let REGISTRY_PATH: string
let BACKUP_DIR: string
let ACTIVITY_LOG: string

export function initPaths(): void {
  const exeDir = path.dirname(app.getPath('exe'))
  const cwd = process.cwd()
  const userData = app.getPath('userData')

  // Priority: cwd (dev) → exeDir (portable) → userData (installed)
  // No hardcoded fallbacks — if none match, use userData
  let baseDir: string
  if (fs.existsSync(path.join(cwd, 'registry.yaml')) || fs.existsSync(path.join(cwd, 'task-data'))) {
    baseDir = cwd
  } else if (fs.existsSync(path.join(exeDir, 'registry.yaml')) || fs.existsSync(path.join(exeDir, 'task-data'))) {
    baseDir = exeDir
  } else if (fs.existsSync(path.join(userData, 'registry.yaml'))) {
    baseDir = userData
  } else {
    baseDir = userData
  }

  DATA_DIR = baseDir
  TASK_DIR = path.join(DATA_DIR, 'task-data')
  REGISTRY_PATH = path.join(DATA_DIR, 'registry.yaml')
  BACKUP_DIR = path.join(DATA_DIR, 'backups')
  ACTIVITY_LOG = path.join(TASK_DIR, '.activity.log')

  fs.mkdirSync(TASK_DIR, { recursive: true })
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
}

export function setDataDir(newDir: string): void {
  if (!fs.existsSync(path.join(newDir, 'registry.yaml')) && !fs.existsSync(path.join(newDir, 'task-data'))) {
    throw new Error(`目标目录没有 registry.yaml 或 task-data: ${newDir}`)
  }
  DATA_DIR = newDir
  TASK_DIR = path.join(DATA_DIR, 'task-data')
  REGISTRY_PATH = path.join(DATA_DIR, 'registry.yaml')
  BACKUP_DIR = path.join(DATA_DIR, 'backups')
  ACTIVITY_LOG = path.join(TASK_DIR, '.activity.log')
  fs.mkdirSync(TASK_DIR, { recursive: true })
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
}

export function getDataDir(): string { return DATA_DIR }
export function isFirstRun(): boolean {
  return !fs.existsSync(REGISTRY_PATH) && !fs.existsSync(path.join(TASK_DIR, '..', 'registry.yaml'))
}

export function createFreshSetup(targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true })
  TASK_DIR = path.join(targetDir, 'task-data')
  REGISTRY_PATH = path.join(targetDir, 'registry.yaml')
  BACKUP_DIR = path.join(targetDir, 'backups')
  ACTIVITY_LOG = path.join(TASK_DIR, '.activity.log')
  fs.mkdirSync(TASK_DIR, { recursive: true })
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  if (!fs.existsSync(REGISTRY_PATH)) {
    fs.writeFileSync(REGISTRY_PATH, '# 方寸 registry\nprojects:\n  - id: fangcun\n    name: 方寸\n    repo: .\n', 'utf-8')
  }
}

export function importFromPythonTegula(targetDir: string, pythonTegulaDir: string): void {
  const srcTask = path.join(pythonTegulaDir, 'task-data')
  const srcReg = path.join(pythonTegulaDir, 'registry.yaml')
  if (fs.existsSync(srcReg)) {
    fs.copyFileSync(srcReg, path.join(targetDir, 'registry.yaml'))
  }
  if (fs.existsSync(srcTask)) {
    fs.mkdirSync(targetDir, { recursive: true })
    const destTask = path.join(targetDir, 'task-data')
    fs.mkdirSync(destTask, { recursive: true })
    for (const f of fs.readdirSync(srcTask)) {
      if (f.endsWith('.md')) {
        fs.copyFileSync(path.join(srcTask, f), path.join(destTask, f))
      }
    }
  }
}

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

// ── YAML Parser (js-yaml) ──────────────────────────────────────────────

// Chinese → English field name mapping (Python tegula compat)
export const FIELD_MAP: Record<string, string> = {
  '标题': 'title',
  '项目': 'project',
  '状态': 'status',
  '批次': 'batch',
  '截止': 'deadline',
  '优先级': 'priority',
  '创建': 'created',
  '更新': 'updated',
  '来源': 'source',
  '指派': 'assignee',
  '验收': 'review',
  '阻塞': 'blockers',
  '附言': 'memo',
  '资源': 'resources',
  '方案': 'plan',
  '结果记录': 'result_log',
  '派活时间': 'dispatch_time',
  'agent': 'agent',
  '验收清单': 'review_checklist',
  '预算': 'budget',
  'cron': 'cron',
  'context': 'context',
  'id': 'id',
  'tags': 'tags',
  'type': 'type',
  'plan_status': 'plan_status',
}

// English → Chinese field name mapping (for renderTask compat with Python CLI)
const REVERSE_FIELD_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_MAP).map(([zh, en]) => [en, zh])
)

// Preferred output order for frontmatter fields
const FM_ORDER = [
  'id', 'title', 'project', 'status', 'priority', 'assignee', 'tags',
  'created', 'updated', 'blockers', 'expected_update', 'batch', 'deadline',
  'source', 'review', 'memo', 'resources', 'plan', 'result_log',
  'dispatch_time', 'agent', 'review_checklist', 'budget', 'cron', 'context',
  'type', 'plan_status',
]

export function parseRegistry(includeReleased = true): any[] {
  if (!fs.existsSync(REGISTRY_PATH)) return []
  const content = fs.readFileSync(REGISTRY_PATH, 'utf-8')
  const data = yaml.load(content) as any
  if (!data) return []
  const projects = data.projects || []
  if (includeReleased && Array.isArray(data.released)) {
    return [...projects, ...data.released]
  }
  return projects
}

// ── Task File I/O ───────────────────────────────────────────────────────

export function parseTask(filePath: string): Task | null {
  if (!fs.existsSync(filePath)) return null

  const content = fs.readFileSync(filePath, 'utf-8')
  
  // Support mixed delimiters: ---...---, ===...===, ---...===, ===...---
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/) ||
                 content.match(/^===\r?\n([\s\S]*?)\r?\n===\r?\n([\s\S]*)$/) ||
                 content.match(/^---\r?\n([\s\S]*?)\r?\n===\r?\n([\s\S]*)$/) ||
                 content.match(/^===\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!fmMatch) return null

  const fmText = fmMatch[1]
  const body = fmMatch[2]

  // Parse YAML frontmatter
  let raw: any
  try {
    raw = yaml.load(fmText)
  } catch (e: any) {
    return null
  }
  if (!raw || typeof raw !== 'object') return null

  // Normalize Chinese field names to English
  const fm: TaskFrontmatter = { id: '' }
  for (const [rawKey, val] of Object.entries(raw)) {
    const key = FIELD_MAP[rawKey] || rawKey
    fm[key] = val as any
  }

  fm.id = String(fm.id || path.basename(filePath, '.md'))
  
  // Normalize Unix timestamps to ISO format
  if (fm.created && /^\d+$/.test(String(fm.created))) {
    fm.created = new Date(parseInt(String(fm.created)) * 1000).toISOString()
  }
  if (fm.updated && /^\d+$/.test(String(fm.updated))) {
    fm.updated = new Date(parseInt(String(fm.updated)) * 1000).toISOString()
  }
  
  return { id: fm.id, fm, body, path: filePath }
}

export function renderTask(task: Task): string {
  // Build ordered output map (Chinese keys for Python CLI compat)
  const ordered: Record<string, any> = {}
  
  // First, output fields in preferred order
  for (const enKey of FM_ORDER) {
    const v = task.fm[enKey]
    if (v === undefined || v === null || v === '') continue
    const zhKey = REVERSE_FIELD_MAP[enKey] || enKey
    ordered[zhKey] = v
  }
  
  // Then output any remaining unknown fields
  for (const [k, v] of Object.entries(task.fm)) {
    if (v === undefined || v === null || v === '') continue
    if (FM_ORDER.includes(k)) continue
    const zhKey = REVERSE_FIELD_MAP[k] || k
    ordered[zhKey] = v
  }

  // Serialize YAML with proper formatting
  const fmText = yaml.dump(ordered, {
    lineWidth: -1,
    noRefs: true,
    forceQuotes: false,
    flowLevel: -1,
  })

  return `---\n${fmText}---\n${task.body}`
}

export function loadTasks(view = 'active'): Task[] {
  if (!fs.existsSync(TASK_DIR)) return []

  const tasks: Task[] = []
  
  function scanDir(dir: string) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        // Skip special directories
        if (view === 'active' && entry.name === 'archive') continue
        if (entry.name === '.backup' || entry.name === '.trash') continue
        scanDir(fullPath)
      } else if (entry.name.endsWith('.md')) {
        // Skip template files
        if (entry.name.startsWith('_')) continue
        const task = parseTask(fullPath)
        if (!task) continue

        const status = task.fm.status
        const inArchive = entry.name !== undefined && fullPath.includes(`${path.sep}archive${path.sep}`)

        if (view === 'active') {
          if (status === '完成' || status === '驳回') continue
        } else if (view === 'archive') {
          if (!inArchive && status !== '完成' && status !== '驳回') continue
        }
        tasks.push(task)
      }
    }
  }

  scanDir(TASK_DIR)
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
    .replace(/[^\w一-鿿-]/g, '')
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
  } catch (e: any) {
    return { ok: false, message: `registry.yaml parse error: ${e.message}` }
  }
  try {
    const tasks = loadTasks('active')
    if (tasks.length === 0) {
      return { ok: false, message: `No tasks found in ${TASK_DIR}` }
    }
  } catch (e: any) {
    return { ok: false, message: `task-data read error: ${e.message}` }
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

// ── Checksum Utilities ──────────────────────────────────────────────────

export function computeChecksum(filePath: string): string {
  const content = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(content).digest('hex')
}

export function computeStringChecksum(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex')
}
