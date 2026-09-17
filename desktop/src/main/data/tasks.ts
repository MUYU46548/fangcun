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
  let deadline = ''

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
    } else if (low.startsWith('due:') && tk.length > 4) {
      const dv = tk.slice(4).trim()
      // Validate MM-DD format
      if (/^\d{1,2}-\d{1,2}$/.test(dv)) {
        deadline = dv
      } else {
        return { ok: false, error: `截止日期格式错误「${dv}」，应为 MM-DD（如 due:12-31）` }
      }
    } else {
      titleTokens.push(tk)
    }
  }

  const title = titleTokens.join(' ').trim()
  if (!title) return { ok: false, error: '标题为空' }

  const task = createTask({ title, status, priority: priority || undefined, assignee: assignee || undefined, tags, deadline })
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
  deadline?: string
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
    deadline: fields.deadline || undefined,
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

export interface DecisionPoint {
  id: string
  question: string
  options: string[]
  status: 'pending' | 'decided' | 'skipped'
  chosen: string
  decidedAt: string
}

export interface PlanData {
  objective: string
  status: 'draft' | 'active' | 'achieved' | 'abandoned'
  milestones: { name: string; deadline: string }[]
  decisions: DecisionPoint[]
  risks: string[]
}

export function createPlan(fields: {
  title: string
  project?: string
  objective?: string
  milestones?: PlanData['milestones']
  decisions?: DecisionPoint[]
  risks?: string[]
}): { id: string; task: Task } {
  const id = genId(fields.title)
  const now = new Date().toISOString()
  const plan: PlanData = {
    objective: fields.objective || '',
    status: 'draft',
    milestones: fields.milestones || [],
    decisions: fields.decisions || [],
    risks: fields.risks || [],
  }
  // ensure DP ids
  plan.decisions.forEach((dp, i) => { if (!dp.id) dp.id = `dp_${String(i + 1).padStart(3, '0')}` })
  const fm: TaskFrontmatter = {
    id,
    title: fields.title,
    project: fields.project || '',
    status: '草稿',
    priority: '',
    assignee: '',
    tags: [],
    created: now,
    updated: now,
    blockers: [],
    type: 'plan',
    plan_status: 'draft',
  }
  const task: Task = { id, fm, body: renderPlanBody(plan), path: path.join(getTaskDir(), `${id}.md`) }
  atomicWrite(task.path, renderTask(task))
  logActivity(id, 'created_plan', fields.title)
  return { id, task }
}

export function renderPlanBody(plan: PlanData): string {
  const lines: string[] = []
  if (plan.objective) lines.push(`## 目标\n${plan.objective}`)
  if (plan.milestones.length) {
    lines.push('## 里程碑')
    plan.milestones.forEach(m => lines.push(`- [ ] ${m.name} (截止: ${m.deadline || '未设定'})`))
  }
  if (plan.decisions.length) {
    lines.push('## 决策点')
    plan.decisions.forEach(dp => {
      lines.push(`### ${dp.id}`)
      lines.push(`- 问题: ${dp.question}`)
      lines.push(`- 选项: ${dp.options.join(' / ')}`)
      lines.push(`- 状态: ${dp.status === 'pending' ? '待定' : dp.status === 'decided' ? '已决策' : '跳过'}`)
      lines.push(`- 已选: ${dp.chosen}`)
      lines.push(`- 决策时间: ${dp.decidedAt}`)
    })
  }
  if (plan.risks.length) {
    lines.push('## 风险')
    plan.risks.forEach(r => lines.push(`- ${r}`))
  }
  return lines.join('\n')
}

export function parsePlanFromTask(task: Task): PlanData | null {
  if ((task.fm as any).type !== 'plan') return null
  const body = task.body || ''
  const plan: PlanData = { objective: '', status: 'draft', milestones: [], decisions: [], risks: [] }
  // parse sections by ## headers
  const sections = body.split(/^##\s+/m)
  for (const sec of sections) {
    const lines = sec.trim().split('\n')
    const heading = lines[0]?.trim() || ''
    const content = lines.slice(1).join('\n')
    if (heading === '目标') plan.objective = content.trim()
    else if (heading === '里程碑') {
      plan.milestones = content.split('\n').filter(l => l.trim().startsWith('- [')).map(l => {
        const m = l.match(/^- \[[ x]\]\s*(.+?)\s*\(截止:\s*(.+?)\)\s*$/)
        return m ? { name: m[1], deadline: m[2] } : { name: l.replace(/^- \[[ x]\]\s*/, ''), deadline: '' }
      })
    } else if (heading === '决策点') {
      const dpSections = content.split(/^###\s+/m).filter(Boolean)
      plan.decisions = dpSections.map(dpSec => {
        const dLines = dpSec.trim().split('\n')
        const dpId = dLines[0]?.trim() || `dp_${String(plan.decisions.length + 1).padStart(3, '0')}`
        const dp: DecisionPoint = { id: dpId, question: '', options: [], status: 'pending', chosen: '', decidedAt: '' }
        for (const dl of dLines.slice(1)) {
          const m = dl.match(/^-\s*(.+?):\s*(.*)$/)
          if (!m) continue
          const k = m[1].trim()
          const v = m[2].trim()
          if (k === '问题') dp.question = v
          else if (k === '选项') dp.options = v.split('/').map(s => s.trim())
          else if (k === '状态') dp.status = v === '已决策' ? 'decided' : v === '跳过' ? 'skipped' : 'pending'
          else if (k === '已选') dp.chosen = v
          else if (k === '决策时间') dp.decidedAt = v
        }
        return dp
      })
    } else if (heading === '风险') {
      plan.risks = content.split('\n').filter(l => l.trim().startsWith('-')).map(l => l.replace(/^-\s*/, ''))
    }
  }
  plan.status = ((task.fm as any).plan_status as PlanData['status']) || 'draft'
  return plan
}

export function decidePlanPoint(id: string, dpId: string, choice: string): { ok: boolean; error?: string } {
  const task = readTask(id)
  if (!task) return { ok: false, error: '任务不存在' }
  const plan = parsePlanFromTask(task)
  if (!plan) return { ok: false, error: '不是规划任务' }
  const dp = plan.decisions.find(d => d.id === dpId)
  if (!dp) return { ok: false, error: `决策点 ${dpId} 不存在` }
  dp.status = 'decided'
  dp.chosen = choice
  dp.decidedAt = new Date().toISOString()
  // update task body
  task.body = renderPlanBody(plan)
  // check if all decided
  if (plan.decisions.every(d => d.status !== 'pending') && plan.status === 'draft') {
    plan.status = 'active'
    ;(task.fm as any).plan_status = 'active'
    task.fm.status = '进行中'
  }
  ;(task.fm as any).plan_status = plan.status
  task.fm.updated = new Date().toISOString()
  atomicWrite(task.path, renderTask(task))
  return { ok: true }
}

export function listPlans(view = 'active'): Task[] {
  return loadAllTasks().filter(t => (t.fm as any).type === 'plan')
}

export function getPlan(id: string): { task: Task; plan: PlanData } | null {
  const task = readTask(id)
  if (!task) return null
  const plan = parsePlanFromTask(task)
  if (!plan) return null
  return { task, plan }
}

export function findTimeoutTasks(thresholdHours = 24): { id: string; title: string; hours: number }[] {
  const nowTs = Date.now() / 1000
  return loadAllTasks()
    .filter(t => t.fm.status === '进行中' && (t.fm as any).dispatch_time)
    .map(t => {
      const ts = parseFloat((t.fm as any).dispatch_time)
      const hours = Math.floor((nowTs - ts) / 3600)
      return hours >= thresholdHours ? { id: t.id, title: t.fm.title || t.id, hours } : null
    })
    .filter(Boolean) as any
}

export function getProjectProgress(projectId: string): { total: number; completed: number; percent: number } {
  const projTasks = loadAllTasks().filter(t => {
    const p = t.fm.project
    if (!p) return false
    if (Array.isArray(p)) return p.includes(projectId)
    return p === projectId
  })
  const total = projTasks.length
  const completed = projTasks.filter(t => t.fm.status === '完成').length
  return { total, completed: total ? completed : 0, percent: total ? Math.round((completed / total) * 100) : 0 }
}

// ── Blocker Chain Visualization ──────────────────────────────────────

export interface BlockerChain {
  id: string
  title: string
  status: string
  blockers: {
    id: string
    title: string
    status: string
    isDone: boolean
  }[]
}

export function getBlockerChains(): BlockerChain[] {
  const allTasks = loadAllTasks()
  const taskMap = new Map(allTasks.map(t => [t.id, t]))
  const chains: BlockerChain[] = []

  for (const task of allTasks) {
    if (!task.fm.blockers || task.fm.blockers.length === 0) continue
    const blockers = task.fm.blockers
      .map(bid => {
        const dep = taskMap.get(bid)
        if (!dep) return null
        const status = dep.fm.status || '草稿'
        const isDone = status === '完成' || status === '驳回'
        return { id: dep.id, title: dep.fm.title || dep.id, status, isDone }
      })
      .filter(Boolean) as BlockerChain['blockers']

    if (blockers.length > 0) {
      chains.push({
        id: task.id,
        title: task.fm.title || task.id,
        status: task.fm.status || '草稿',
        blockers,
      })
    }
  }
  return chains
}

// ── Roadmap Aggregation ──────────────────────────────────────────────

export interface RoadmapBatch {
  name: string
  status: 'active' | 'completed' | 'pending' | 'blocked'
  total: number
  done: number
  tasks: { id: string; title: string; status: string }[]
}

export interface RoadmapProject {
  id: string
  name: string
  health: 'active' | 'stuck' | 'idle'
  batches: RoadmapBatch[]
  blockers: { taskId: string; title: string; blockerId: string; blockerTitle: string }[]
  nextActions: { taskId: string; title: string; priority: string; batch: string }[]
  taskCount: number
}

export function aggregateRoadmap(projectId?: string): { projects: RoadmapProject[]; generatedAt: number } {
  const allTasks = loadAllTasks()
  const projects = parseRegistry()
  const projMeta = new Map(projects.map(p => [p.id, p]))
  const projTasks: Record<string, Task[]> = {}

  for (const t of allTasks) {
    const p = t.fm.project
    if (!p) continue
    const pid = Array.isArray(p) ? p[0] : p
    if (!pid) continue
    if (!projTasks[pid]) projTasks[pid] = []
    projTasks[pid].push(t)
  }

  const result: RoadmapProject[] = []
  for (const [pid, tasks] of Object.entries(projTasks)) {
    if (projectId && pid !== projectId) continue
    const meta = projMeta.get(pid)
    const name = meta?.name || pid
    const batches: Record<string, Task[]> = {}
    for (const t of tasks) {
      const b = (t.fm as any).batch || '未分类'
      if (!batches[b]) batches[b] = []
      batches[b].push(t)
    }
    const batchList: RoadmapBatch[] = Object.entries(batches).map(([bname, btasks]) => {
      const done = btasks.filter(t => t.fm.status === '完成').length
      const hasBlocked = btasks.some(t => t.fm.blockers && t.fm.blockers.length > 0)
      const hasActive = btasks.some(t => t.fm.status === '进行中')
      const status: RoadmapBatch['status'] = done === btasks.length ? 'completed' : hasActive ? 'active' : hasBlocked ? 'blocked' : 'pending'
      return {
        name: bname,
        status,
        total: btasks.length,
        done,
        tasks: btasks.map(t => ({ id: t.id, title: t.fm.title || t.id, status: t.fm.status || '草稿' })),
      }
    })
    const health: RoadmapProject['health'] = batchList.some(b => b.status === 'active') ? 'active' : batchList.some(b => b.status === 'blocked') ? 'stuck' : 'idle'
    const blockers: RoadmapProject['blockers'] = []
    for (const t of tasks) {
      if (t.fm.blockers) {
        for (const bid of t.fm.blockers) {
          const dep = allTasks.find(x => x.id === bid)
          if (dep && dep.fm.status !== '完成' && dep.fm.status !== '驳回') {
            blockers.push({ taskId: t.id, title: t.fm.title || t.id, blockerId: dep.id, blockerTitle: dep.fm.title || dep.id })
          }
        }
      }
    }
    const nextActions = tasks
      .filter(t => t.fm.status === '进行中' || t.fm.status === '待办')
      .sort((a, b) => (a.fm.status === '进行中' ? 0 : 1) - (b.fm.status === '进行中' ? 0 : 1))
      .slice(0, 3)
      .map(t => ({ taskId: t.id, title: t.fm.title || t.id, priority: t.fm.priority || '中', batch: (t.fm as any).batch || '' }))
    result.push({ id: pid, name, health, batches: batchList, blockers, nextActions, taskCount: tasks.length })
  }
  return { projects: result, generatedAt: Date.now() }
}

// ── Suggestions ───────────────────────────────────────────────────────

export function suggestActions(projectId: string): string[] {
  const tasks = loadAllTasks().filter(t => {
    const p = t.fm.project
    if (!p) return false
    return Array.isArray(p) ? p.includes(projectId) : p === projectId
  })
  if (tasks.length === 0) return ['无任务 — 建议创建第一个任务']
  const sugs: string[] = []
  const blocked = tasks.filter(t => t.fm.blockers && t.fm.blockers.length > 0)
  if (blocked.length) sugs.push(`${blocked.length} 个任务存在阻塞依赖，优先解除`)
  const pending = tasks.filter(t => t.fm.status === '待办')
  const active = tasks.filter(t => t.fm.status === '进行中')
  if (pending.length && !active.length) sugs.push(`有 ${pending.length} 个待办但无进行中任务，可激活一项`)
  const stale = tasks.filter(t => {
    if (!t.fm.updated || t.fm.status === '完成') return false
    return (Date.now() - new Date(t.fm.updated).getTime()) / 86400000 > 14
  })
  if (stale.length) sugs.push(`${stale.length} 个任务超过 14 天未更新`)
  return sugs.length ? sugs : ['项目运行正常']
}

export function suggestCrossProject(): string[] {
  const statuses = scanProjectStatus()
  const sugs: string[] = []
  const stuck = statuses.filter(s => s.health === 'stuck')
  const idle = statuses.filter(s => s.health === 'idle')
  if (stuck.length) sugs.push(`优先处理卡住项目：${stuck.map(s => s.name).join('、')}`)
  if (idle.length) sugs.push(`空闲项目可激活：${idle.map(s => s.name).join('、')}`)
  return sugs
}

// ── Task Import/Export ───────────────────────────────────────────────

export function exportTasks(): { ok: boolean; data?: any[]; count?: number; error?: string } {
  try {
    const tasks = loadAllTasks().map(t => ({
      id: t.id,
      title: t.fm.title,
      project: t.fm.project,
      status: t.fm.status,
      priority: t.fm.priority,
      assignee: t.fm.assignee,
      tags: t.fm.tags,
      created: t.fm.created,
      updated: t.fm.updated,
      blockers: t.fm.blockers,
      body: t.body,
    }))
    return { ok: true, data: tasks, count: tasks.length }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

export function importTasks(data: any[]): { ok: boolean; imported?: number; error?: string } {
  try {
    if (!Array.isArray(data)) return { ok: false, error: 'data must be array' }
    let imported = 0
    for (const item of data) {
      if (!item || typeof item !== 'object') continue
      const id = item.id || genId(item.title || '(无标题)')
      const task: Task = {
        id,
        fm: {
          id,
          title: item.title || '(无标题)',
          project: item.project || '',
          status: item.status || '待办',
          priority: item.priority || '',
          assignee: item.assignee || '',
          tags: item.tags || [],
          created: item.created || new Date().toISOString(),
          updated: new Date().toISOString(),
          blockers: item.blockers || [],
        },
        body: item.body || '',
        path: path.join(getTaskDir(), `${id}.md`),
      }
      atomicWrite(task.path, renderTask(task))
      imported++
    }
    return { ok: true, imported }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

// ── Notes Import/Export ──────────────────────────────────────────────

export function exportNotes(): { ok: boolean; data?: any[]; count?: number; error?: string } {
  try {
    const notesDir = path.join(getDataDir(), 'notes')
    if (!fs.existsSync(notesDir)) return { ok: true, data: [], count: 0 }
    const notes: any[] = []
    for (const fn of fs.readdirSync(notesDir)) {
      if (!fn.endsWith('.md')) continue
      const content = fs.readFileSync(path.join(notesDir, fn), 'utf-8')
      let title = ''
      let body = content
      if (content.startsWith('# ')) {
        const lines = content.split('\n', 2)
        title = lines[0].slice(2).trim()
        body = lines.slice(1).join('\n').trim()
      }
      notes.push({ id: fn.slice(0, -3), title, content: body })
    }
    return { ok: true, data: notes, count: notes.length }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

export function importNotes(data: any[]): { ok: boolean; imported?: number; error?: string } {
  try {
    if (!Array.isArray(data)) return { ok: false, error: 'data must be array' }
    const notesDir = path.join(getDataDir(), 'notes')
    fs.mkdirSync(notesDir, { recursive: true })
    let imported = 0
    for (const item of data) {
      if (!item || typeof item !== 'object') continue
      const id = item.id || `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const title = item.title || ''
      const content = item.content || ''
      const notePath = path.join(notesDir, `${id}.md`)
      fs.writeFileSync(notePath, `# ${title}\n\n${content}`, 'utf-8')
      imported++
    }
    return { ok: true, imported }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

// ── Task Copy ────────────────────────────────────────────────────────

export function copyTask(id: string): { ok: boolean; id?: string; error?: string } {
  try {
    const task = readTask(id)
    if (!task) return { ok: false, error: '任务不存在' }
    const newId = genId(task.fm.title || 'copy')
    const now = new Date().toISOString()
    const newTask: Task = {
      id: newId,
      fm: { ...task.fm, id: newId, title: `${task.fm.title || task.id} (副本)`, created: now, updated: now },
      body: task.body,
      path: path.join(getTaskDir(), `${newId}.md`),
    }
    atomicWrite(newTask.path, renderTask(newTask))
    return { ok: true, id: newId }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

// ── Roadmap Trend + Parallel + Milestones ───────────────────────────

export function getRoadmapTrend(days = 7): Record<string, any[]> {
  const roadmap = aggregateRoadmap()
  const trend: Record<string, any[]> = {}
  for (const p of roadmap.projects) {
    trend[p.id] = [{
      ts: Date.now(),
      name: p.name,
      active: p.batches.filter(b => b.status === 'active').length,
      completed: p.batches.filter(b => b.status === 'completed').length,
      blocked: p.blockers.length,
    }]
  }
  return trend
}

export function detectParallelOpportunities(): any[] {
  const roadmap = aggregateRoadmap()
  const sugs: any[] = []
  const activeProjs = roadmap.projects.filter(p => p.health === 'active')
  if (activeProjs.length >= 2) {
    sugs.push({
      type: 'parallel',
      projects: activeProjs.map(p => p.id),
      reason: `${activeProjs.map(p => p.name).join('、')} 均在活跃推进中，可考虑交替进行防止单项目阻塞`,
    })
  }
  for (const p of roadmap.projects) {
    const pending = p.batches.filter(b => b.status === 'pending')
    if (pending.length >= 2) {
      sugs.push({
        type: 'parallel_batches',
        project: p.id,
        batches: pending.map(b => b.name),
        reason: `${p.name} 的 ${pending.length} 个待办批次无阻塞，可并行推进`,
      })
    }
  }
  return sugs
}

export function suggestMilestones(): any[] {
  const roadmap = aggregateRoadmap()
  const milestones: any[] = []
  const batchPhaseMap: Record<string, string> = { P0: '核心', P1: '功能', P2: '打磨', P3: '扩展' }
  for (const p of roadmap.projects) {
    const phaseStats: Record<string, { total: number; done: number }> = {}
    for (const b of p.batches) {
      const prefix = b.name.startsWith('P') ? b.name.slice(0, 2) : '其他'
      if (!phaseStats[prefix]) phaseStats[prefix] = { total: 0, done: 0 }
      phaseStats[prefix].total += b.total
      phaseStats[prefix].done += b.done
    }
    for (const [phase, stats] of Object.entries(phaseStats)) {
      const phaseName = batchPhaseMap[phase] || phase
      if (stats.total > 0 && stats.done === stats.total) {
        milestones.push({ project: p.id, project_name: p.name, phase, milestone: `${phaseName}阶段完成`, status: 'completed', tasks_done: stats.done, tasks_total: stats.total })
      } else if (stats.done > 0) {
        milestones.push({ project: p.id, project_name: p.name, phase, milestone: `${phaseName}阶段进行中`, status: 'in_progress', progress: Math.round((stats.done / stats.total) * 100) })
      }
    }
  }
  return milestones
}

// ── Event Detection + Cron ───────────────────────────────────────────

export function detectEvents(eventType: string): string | null {
  if (eventType === 'timeout' || eventType === 'all') {
    const timeouts = findTimeoutTasks()
    if (timeouts.length) return `⚠️ ${timeouts.length} 个任务超时未回写：${timeouts.slice(0, 5).map(t => `「${t.title}」${t.hours}h`).join('、')}`
  }
  if (eventType === 'stuck' || eventType === 'all') {
    const statuses = scanProjectStatus()
    const stuck = statuses.filter(s => s.health === 'stuck')
    if (stuck.length) return `⛔ ${stuck.length} 个项目卡住：${stuck.map(s => s.name).join('、')}`
  }
  return null
}

export function cronCheck(): { ok: boolean; messages: string[] } {
  const messages: string[] = []
  const timeoutEvent = detectEvents('timeout')
  if (timeoutEvent) messages.push(timeoutEvent)
  const stuckEvent = detectEvents('stuck')
  if (stuckEvent) messages.push(stuckEvent)
  return { ok: true, messages }
}
