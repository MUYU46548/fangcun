/**
 * Fangcun Desktop — Task Operations
 * Business logic for task CRUD, status transitions, project scanning
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  Task, TaskFrontmatter, Status, STATUSES,
  parseTask, renderTask, atomicWrite, genId, logActivity,
  getTaskDir, getDataDir, parseRegistry, loadTasks, loadAllTasksRaw,
  invalidateTaskCache, normalizePriority, PRIORITIES
} from './index'

// Re-export for convenience
export { STATUSES, PRIORITIES, normalizePriority }
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

/**
 * 批量归档 = 逐个**真正归档**（把文件移进 task-data/archive/），与单任务「归档」按钮同一语义。
 *
 * 旧实现是 `batchEdit(ids, { status: '完成' })` —— 只改状态、不移动文件。
 * 而归档视图是按**路径**判定的（loadTasks('archive') → ARCHIVE_SEG_RE），
 * 于是批量归档过的任务：状态看着像终态、文件却还在活跃区，归档视图里也找不到 →
 * 「批量归档有时会失效」，产出一批「假归档」（用户 2026-09-25 报告）。
 */
export function batchArchive(ids: string[]): { ok: number; fails: { id: string; error: string }[] } {
  let ok = 0
  const fails: { id: string; error: string }[] = []
  for (const id of ids) {
    try {
      const t = archiveTask(id)
      if (t) ok++
      else fails.push({ id, error: '任务不存在' })
    } catch (e: any) {
      fails.push({ id, error: e.message })
    }
  }
  return { ok, fails }
}

export function batchDelete(ids: string[]): { ok: number; fails: { id: string; error: string }[] } {
  let ok = 0
  const fails: { id: string; error: string }[] = []
  for (const id of ids) {
    try {
      const result = deleteTask(id)
      if (result) ok++
      else fails.push({ id, error: '任务不存在' })
    } catch (e: any) {
      fails.push({ id, error: e.message })
    }
  }
  return { ok, fails }
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

export function parseNaturalQuery(
  q: string,
  opts: { includeArchive?: boolean } = {}
): { tasks: Task[]; error?: string } {
  const raw = (q || '').trim()
  if (!raw) return { tasks: [], error: '查询为空' }

  const tags = [...raw.matchAll(/#(\S+)/g)].map(m => m[1])
  const projects = [...raw.matchAll(/@(\S+)/g)].map(m => m[1])
  let remaining = raw.replace(/[#@]\S+/g, ' ').trim()

  // ── 精确筛选语法 ──────────────────────────────────────────────────
  // status:完成 / prio:高 / 归档 —— 先于中文关键词扫描处理，避免被误吞。
  let exactStatus: string | null = null
  let exactPrio: string | null = null
  let onlyArchived = false

  remaining = remaining
    .replace(/(?:status|state|状态):(\S+)/gi, (_m, v: string) => {
      const s = v.trim()
      if ((STATUSES as readonly string[]).includes(s)) exactStatus = s
      return ' '
    })
    .replace(/(?:prio|priority|优先级):(\S+)/gi, (_m, v: string) => {
      const p = normalizePriority(v.trim())
      if (p) exactPrio = p
      return ' '
    })
    .trim()

  if (/(?:^|\s)(?:归档|archived)(?=\s|$)/i.test(remaining)) {
    onlyArchived = true
    remaining = remaining.replace(/(?:^|\s)(?:归档|archived)(?=\s|$)/gi, ' ').trim()
  }

  const wantsArchive = !!opts.includeArchive || onlyArchived

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
  let tasks = loadAllTasks(wantsArchive)

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
  const wantStatus = exactStatus || targetStatus
  if (wantStatus) {
    tasks = tasks.filter(t => t.fm.status === wantStatus)
  }
  const wantPrio = exactPrio || targetPrio
  if (wantPrio) {
    tasks = tasks.filter(t => normalizePriority(t.fm.priority) === wantPrio)
  }
  if (onlyArchived) {
    tasks = tasks.filter(t => isArchivedPath(t.path))
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
    priority: normalizePriority(fields.priority) || '中',
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
  const trashDir = path.join(taskDir, '.trash')

  /**
   * 顺序很重要：**活跃区 → 其它子目录（archive 等）→ 回收站兜底**。
   *
   * 同一 id 可能同时存在于 archive/ 与 .trash/（见 deleteTask 上方注释：库里有 8 个这样的任务）。
   * 旧实现是"撞上谁算谁"（readdir 顺序不定），一旦命中回收站那份，
   * 后续 updateTask / moveStatus / 详情面板读到的就是一个已"删除"的文件。
   * 先精确匹配 `${id}.md`，再退化为前缀匹配，保持原有的宽松行为。
   */
  const scan = (dir: string, exactOnly: boolean): Task | null => {
    if (!fs.existsSync(dir)) return null
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    // 先看本层的文件（活跃区永远是本层），再递归子目录
    for (const entry of entries) {
      if (entry.isDirectory()) continue
      if (!entry.name.endsWith('.md')) continue
      if (exactOnly ? entry.name === `${id}.md` : entry.name.startsWith(id)) {
        return parseTask(path.join(dir, entry.name))
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (path.resolve(full) === path.resolve(trashDir)) continue
      const found = scan(full, exactOnly)
      if (found) return found
    }
    return null
  }

  return scan(taskDir, true) ?? scan(taskDir, false) ?? scan(trashDir, true) ?? scan(trashDir, false)
}

export function updateTask(id: string, rawFields: Partial<TaskFrontmatter> & { body?: string }): Task | null {
  const task = readTask(id)
  if (!task) return null

  if (rawFields.expected_update && task.fm.expected_update !== rawFields.expected_update) {
    throw new Error('optimistic lock conflict')
  }

  // 写入前归一：防止 normal/high 这类历史别名被重新写回文件
  const fields: Partial<TaskFrontmatter> & { body?: string } = { ...rawFields }
  if (fields.priority !== undefined) {
    fields.priority = normalizePriority(fields.priority) as any
  }

  // body 不属于 frontmatter，单独落到 task.body —— 此前它被合并进 fm 后
  // 被 renderTask 静默丢弃（renderTask 只输出 task.body），勾选保存全部失效
  if (fields.body !== undefined) {
    task.body = String(fields.body)
    delete fields.body
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

/** 回收站目录（task-data/.trash）——与 Python CLI（core.py 的 _move_to(id, ".trash")）同位置同命名。 */
function getTrashDir(): string {
  return path.join(getTaskDir(), '.trash')
}

/**
 * 把 src 移进 destDir 的同名位置；同名冲突时**按 mtime 新的占规范名、旧的改名让位**
  * （一律保留在 destDir 里，**绝不删除任何一份**）。
  *
  * 为什么不能让新来的加后缀（2026-09-25 排查发现）：`readTask` 只认 `${id}.md`。
  * 若刚删/刚归档的那份被存成 `task-x.2.md`，而一周前的旧副本继续占着 `task-x.md`，
  * 那么读出来、还原回来、以及 deleteTask 的幂等判断拿到的**全是旧版本**，
  * 用户刚操作的当前内容等于"看不见了"。
  *
  * 更不能像旧实现那样 `rmSync` 源文件 —— 那是**静默销毁当前版本**（数据丢失）。
  *
  * 另外：`fs.renameSync` 在 Windows 上**目标已存在就直接抛**（EPERM/EEXIST），
  * 所以必须先让位再 rename；直接 rename 到已存在路径会抛异常，一路冒到渲染层表现为"点了没反应"。
  */
  function moveIntoDir(src: string, destDir: string): string {
   fs.mkdirSync(destDir, { recursive: true })
   const name = path.basename(src)
   const dest = path.join(destDir, name)
   if (path.resolve(src) === path.resolve(dest)) return dest

   if (fs.existsSync(dest)) {
     // 内容完全相同 = 没有任何信息可丢：直接去掉源文件，回收站/归档区不留重复副本
      try {
        if (fs.readFileSync(src).equals(fs.readFileSync(dest))) { fs.rmSync(src); return dest }
      } catch { /* 读失败就退化为下面的让位逻辑，绝不因读取问题丢文件 */ }
      const srcNewer = fs.statSync(src).mtimeMs >= fs.statSync(dest).mtimeMs
     if (srcNewer) {
       // 进来的更新：旧的让位保留，由新的占规范名
       let aside = `${dest}.old`
       let n = 2
       while (fs.existsSync(aside)) aside = `${dest}.old${n++}`
       fs.renameSync(dest, aside)
     } else {
       // 进来的更旧：把它改名留在同目录，规范名继续由更新的那份占着
       let aside = path.join(destDir, `${name}.old`)
       let n = 2
       while (fs.existsSync(aside)) aside = path.join(destDir, `${name}.old${n++}`)
       fs.renameSync(src, aside)
       return aside
     }
   }
   fs.renameSync(src, dest)
   return dest
 }

 /** 删除任务 → 移入 task-data/.trash（可人工找回）。
 *
 * 语义：把该 id 在**活跃区与归档区**的所有副本都移进回收站，回收站内不留重复。
 * 幂等：若活跃/归档区已无副本（只有回收站里那份），返回 true（视作已删除）。
 */
export function deleteTask(id: string): boolean {
  const taskDir = getTaskDir()
  const trashDir = getTrashDir()
  fs.mkdirSync(trashDir, { recursive: true })

  // 收集活跃区 + 归档区里所有该 id 的任务文件（跳过回收站自身）
  const sources: string[] = []
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (path.resolve(full) === path.resolve(trashDir)) continue
        walk(full)
      } else if (entry.name === `${id}.md`) {
        sources.push(full)
      }
    }
  }
  walk(taskDir)

  if (sources.length === 0) {
    // 活跃/归档区已无此任务：若回收站里已有那份，就是「早就删过了」，幂等成功
    if (fs.existsSync(path.join(trashDir, `${id}.md`))) return true
    return false
  }

  // 按 mtime 从旧到新移动：让**最新的那份最后落位**、占住规范名 `${id}.md`，
  // 否则 readTask / 幂等判断会读到旧副本（2026-09-25）。
  const ordered = sources
    .map((p) => ({ p, m: (() => { try { return fs.statSync(p).mtimeMs } catch { return 0 } })() }))
    .sort((a, b) => a.m - b.m)
  for (const { p: src } of ordered) {
    moveIntoDir(src, trashDir)
  }
  // 2026-09-23 修复批量假删除：文件已移走但缓存未失效 → loadAll() 重读命中旧缓存 →
  // 已删任务仍在列表里。对比 archiveTask()（L357）有调 invalidateTaskCache()。
  invalidateTaskCache()
  logActivity(id, 'deleted')
  return true
}

/** 归档 = 把任务文件移进 `task-data/archive/`（归档视图按**路径**判定，见 isArchivedPath）。
 *
 *  此前实现是 `updateTask(id, { status: '完成' })` —— 只改状态、不移动文件，
 *  于是 `task-data/archive/` 永远是空的：用户点了「归档」，任务仍留在活跃区，
 *  归档视图里什么也看不到；而且终态（完成/驳回）的任务连这个按钮都没有。
 */
export function archiveTask(id: string): Task | null {
  const t = readTask(id)
  if (!t) return null
  const archiveDir = path.join(getTaskDir(), 'archive')
  if (path.resolve(t.path) !== path.resolve(path.join(archiveDir, path.basename(t.path)))) {
    // ⚠ 旧实现目标存在时 `fs.rmSync(t.path)` —— 直接**销毁刚归档的那份（当前版本）**、
    //   留下归档区里的陈旧副本，是静默数据丢失。moveIntoDir 改为「新的占规范名、旧的改名让位」，
    //   两份都保留（2026-09-25）。
    moveIntoDir(t.path, archiveDir)
    invalidateTaskCache()
    logActivity(id, 'archived')
  }
  return readTask(id)
}

/** 从归档区还原回活跃区并把状态置回「待办」；不在归档区的任务只改状态。 */
export function unarchiveTask(id: string): Task | null {
  const t = readTask(id)
  if (!t) return null
  const activeDir = getTaskDir()
  if (path.resolve(t.path) !== path.resolve(path.join(activeDir, path.basename(t.path)))) {
    // 同 archiveTask：旧实现在活跃区已有同名副本时 rmSync 源文件（销毁归档区那份），
    // 改为 moveIntoDir —— 更新的占规范名、旧的改名保留（2026-09-25）。
    moveIntoDir(t.path, activeDir)
    invalidateTaskCache()
    logActivity(id, 'unarchived')
  }
  return updateTask(id, { status: '待办' })
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

/**
 * 扫描任务目录。
 * includeArchive=true 时才进 archive/ —— 自然查询此前是硬跳过归档，
 * 导致用户勾了「含归档」也搜不到归档任务，与界面开关语义不符。
 */
function loadAllTasks(includeArchive = false): Task[] {
  // 委托到带签名缓存的全量扫描（data/index.ts）——
  // 这里原本每次自建一次完整扫描，是「一次刷新扫 15 遍」的一大来源。
  return loadAllTasksRaw(includeArchive ? 'all' : 'active')
}

/** 任务是否位于归档目录（按路径判定，不按状态 —— 完成/驳回的任务可能仍在活跃区） */
export function isArchivedPath(p: string | undefined): boolean {
  return !!p && /[\\/]archive[\\/]/i.test(p)
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

export interface ProgressEntry { total: number; completed: number; percent: number }

/**
 * 全部项目的进度，**一次全量扫描出结果**。
 *
 * 原先是前端循环调 getProjectProgress(id)，每个项目各扫一遍全量任务 ——
 * 12 个项目 = 12 次全量扫描，压测里 5000 任务档这一项独占 76% 耗时（13.9s/18.4s）。
 * 这里改成扫一次、按项目累加，结果与逐个调用完全等价。
 */
export function getAllProjectProgress(): Record<string, ProgressEntry> {
  const all = loadAllTasks()
  const acc: Record<string, { total: number; completed: number }> = {}
  for (const t of all) {
    const p = t.fm.project
    if (!p) continue
    const ids = Array.isArray(p) ? p : [p]
    for (const id of ids) {
      if (!id) continue
      if (!acc[id]) acc[id] = { total: 0, completed: 0 }
      acc[id].total++
      if (t.fm.status === '完成') acc[id].completed++
    }
  }
  const out: Record<string, ProgressEntry> = {}
  for (const [id, v] of Object.entries(acc)) {
    out[id] = { total: v.total, completed: v.completed, percent: v.total ? Math.round((v.completed / v.total) * 100) : 0 }
  }
  return out
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
// 2026-09-23（用户第 4 条）：改为按阻塞源分组，显示「N 个阻塞源」而非「N 条活跃阻塞链」。
// 多个任务共享同一阻塞源时，合并为一个阻塞源条目，反向列出被它阻塞的任务。

export interface BlockerSource {
  id: string
  title: string
  status: string
  isDone: boolean
  /** 被此阻塞源阻塞的任务列表（反向索引） */
  blockedTasks: { id: string; title: string; status: string }[]
}

export function getBlockerSources(): BlockerSource[] {
  const allTasks = loadAllTasks()
  const taskMap = new Map(allTasks.map(t => [t.id, t]))

  // 阻塞源 ID → 被它阻塞的任务列表
  const sourceMap = new Map<string, BlockerSource>()

  for (const task of allTasks) {
    if (!task.fm.blockers || task.fm.blockers.length === 0) continue
    for (const bid of task.fm.blockers) {
      const dep = taskMap.get(bid)
      if (!dep) continue
      const status = dep.fm.status || '草稿'
      const isDone = status === '完成' || status === '驳回'

      if (!sourceMap.has(bid)) {
        sourceMap.set(bid, {
          id: dep.id,
          title: dep.fm.title || dep.id,
          status,
          isDone,
          blockedTasks: [],
        })
      }
      const src = sourceMap.get(bid)!
      src.blockedTasks.push({ id: task.id, title: task.fm.title || task.id, status: task.fm.status || '草稿' })
    }
  }

  // 只返回未完成的阻塞源（已完成的不再构成阻塞）
  return Array.from(sourceMap.values()).filter(s => !s.isDone)
}

/** 兼容旧接口名：实际返回 BlockerSource[]（含 blockedTasks 反向索引） */
export function getBlockerChains(): BlockerSource[] {
  return getBlockerSources()
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
