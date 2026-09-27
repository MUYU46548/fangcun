/**
 * Fangcun Desktop — Log Service
 * High-frequency work execution logs (active → completed → archived → destroy)
 */

import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { getDataDir } from '../data'

export interface LogEntry {
  id: string
  title: string
  project: string
  status: 'active' | 'completed' | 'archived'
  created: string
  completed: string | null
  retainDays: number | null
  retainUntil: string | null
  content: string
  nextSteps: string
  taskId?: string
  /** 关联任务 ID 列表（2026-09-25 用户第 2 条：日志要能关联多个任务）。
   *  文件里一直是 `tasks: [id]` 数组，此前只读第一个 —— 现在全读全写；taskId 保留为 ids[0]。 */
  taskIds?: string[]
  note?: string
  /** Hermes 会话 ID 或 Agent 会话 ID，便于反向查证 */
  sessionId?: string
  /** 执行 Agent 名称（如 hermes / opencode / codex 等） */
  agentName?: string
  /** 日志归属日期（YYYY-MM-DD），默认取 created 日期，可手动配置 */
  logDate?: string
}

/**
 * 日志目录 = 数据目录下的 docs/执行日志。
 *
 * 这里原本自己推导了一套 cwd → exeDir → userData 的优先级，与 data/index.ts 的
 * initPaths 重复。后果是用户通过首次启动向导改了数据目录（setDataDir）之后，
 * 日志目录不跟随 —— 写在新位置、读旧位置（或反之）。统一以 getDataDir() 为准。
 */
function getLogsDir(): string {
  const logsDir = path.join(getDataDir(), 'docs', '执行日志')
  fs.mkdirSync(logsDir, { recursive: true })
  return logsDir
}

/** 反向索引：某个任务关联的全部日志（含已完成/已归档） */
export function logsForTask(taskId: string): LogEntry[] {
  if (!taskId) return []
  return listLogs().filter(l => logTaskIds(l).includes(taskId))
}

/** 把日志的关联任务归一成数组（taskIds 优先，兼容历史上的单个 taskId） */
function logTaskIds(log: LogEntry): string[] {
  if (Array.isArray(log.taskIds) && log.taskIds.length) return log.taskIds.filter(Boolean)
  return log.taskId ? [log.taskId] : []
}

/** 从日志 frontmatter 提取**全部**关联任务 ID
 *  （兼容 tasks 数组 / 关联任务 / taskIds / taskId / task_id；字符串里允许逗号或空格分隔） */
function extractTaskIds(raw: any): string[] {
  const candidates = [raw?.tasks, raw?.['关联任务'], raw?.taskIds, raw?.taskId, raw?.task_id]
  for (const c of candidates) {
    if (Array.isArray(c)) {
      const ids = c.map((x: any) => String(x).trim()).filter(Boolean)
      if (ids.length) return Array.from(new Set(ids))
    } else if (c !== undefined && c !== null) {
      const ids = String(c).split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
      if (ids.length) return Array.from(new Set(ids))
    }
  }
  return []
}

function parseLogFile(filePath: string): LogEntry | null {
  if (!fs.existsSync(filePath)) return null
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
    if (!fmMatch) return null
    const fmText = fmMatch[1]
    const body = fmMatch[2]
    const raw = yaml.load(fmText) as any
    if (!raw || typeof raw !== 'object') return null

    // Extract content and next_steps from body sections
    let logContent = ''
    let nextSteps = ''
    let currentSection = ''
    const lines = body.split('\n')
    for (const line of lines) {
      if (line.startsWith('## 执行内容')) {
        currentSection = 'content'
        continue
      } else if (line.startsWith('## 下一步')) {
        currentSection = 'nextSteps'
        continue
      } else if (line.startsWith('## ')) {
        currentSection = ''
        continue
      }
      if (currentSection === 'content') {
        logContent += (logContent ? '\n' : '') + line
      } else if (currentSection === 'nextSteps') {
        nextSteps += (nextSteps ? '\n' : '') + line
      }
    }

    // 2026-09-25（用户第 2 条）：一次读出**全部**关联任务 ID（原来只取第一个）
    const taskIds = extractTaskIds(raw)

    return {
      id: String(raw.id || path.basename(filePath, '.md')),
      title: String(raw.title || ''),
      project: String(raw.project || ''),
      status: (raw.status || 'active') as LogEntry['status'],
      created: String(raw.created || ''),
      completed: raw.completed ? String(raw.completed) : null,
      retainDays: raw.retain_days != null ? Number(raw.retain_days) : null,
      retainUntil: raw.retain_until ? String(raw.retain_until) : null,
      // M1: 优先从 frontmatter 提取 _content/_next_steps
      content: String(raw._content || logContent || ''),
      nextSteps: String(raw._next_steps || nextSteps || ''),
      // renderLog 把关联任务写在 frontmatter 的 tasks 数组里，此前只写不读，
      // 导致 logsForTask 永远返回空 —— 任务详情的「关联日志」看不到任何东西。
      taskIds,
      // taskId 保留为首个 ID，兼容仍在读单值的旧消费方（卡片、logsForTask 之外的调用）
      taskId: taskIds[0],
      sessionId: raw.session_id ? String(raw.session_id) : undefined,
      agentName: raw.agent_name ? String(raw.agent_name) : undefined,
      logDate: raw.log_date ? String(raw.log_date) : undefined,
    }
  } catch {
    return null
  }
}

function renderLog(log: LogEntry): string {
  const fm: Record<string, any> = {
    type: 'execution-log',
    id: log.id,
    project: log.project,
    title: log.title,
    status: log.status,
    created: log.created,
    completed: log.completed ? log.completed : null,
    retain_days: log.retainDays != null ? log.retainDays : null,
    retain_until: log.retainUntil ? log.retainUntil : null,
    tags: [],
    tasks: logTaskIds(log),
    _content: log.content || null,
    _next_steps: log.nextSteps || null,
    session_id: log.sessionId || null,
    agent_name: log.agentName || null,
    log_date: log.logDate || null,
  }
  const fmText = yaml.dump(fm, { lineWidth: -1, noRefs: true, flowLevel: -1 })
  let body = `# ${log.title}\n\n## 执行内容\n\n${log.content || '（待填写）'}\n\n## 下一步\n\n${log.nextSteps || '（待填写）'}`
  if (log.note) {
    body += `\n\n## 完成确认\n\n${log.note}`
  }
  return `---\n${fmText}---\n${body}`
}

function atomicallyWrite(filePath: string, content: string): void {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, content, 'utf-8')
  const read = fs.readFileSync(tmp, 'utf-8')
  if (!read) throw new Error('readback empty')
  fs.renameSync(tmp, filePath)
}

function genId(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 8)
  return `log_${ts}_${rand}`
}

export function listLogs(filter?: {
  project?: string
  status?: string
  dateFrom?: string
  dateTo?: string
  agent?: string
}): LogEntry[] {
  const dir = getLogsDir()
  if (!fs.existsSync(dir)) return []
  const logs: LogEntry[] = []
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse()
  for (const fn of files) {
    const entry = parseLogFile(path.join(dir, fn))
    if (!entry) continue
    if (filter?.project && entry.project !== filter.project) continue
    if (filter?.status && entry.status !== filter.status) continue
    if (filter?.agent && entry.agentName !== filter.agent) continue
    // 日期范围筛选：按 logDate（默认 created 日期）过滤
    const entryDate = (entry.logDate || entry.created || '').slice(0, 10)
    if (filter?.dateFrom && entryDate < filter.dateFrom) continue
    if (filter?.dateTo && entryDate > filter.dateTo) continue
    logs.push(entry)
  }
  return logs
}

export function getLog(id: string): LogEntry | null {
  const dir = getLogsDir()
  return parseLogFile(path.join(dir, `${id}.md`))
}

export function createLog(
  title: string,
  project: string,
  content: string,
  taskId?: string,
  extra?: { sessionId?: string; agentName?: string; logDate?: string; taskIds?: string[] },
): { ok: boolean; data?: LogEntry; error?: string } {
  const dir = getLogsDir()
  const id = genId()
  const now = new Date().toISOString()
  // 2026-09-25（用户第 2 条）：支持一次关联多个任务（taskIds 优先，兼容旧的单值 taskId）
  const ids = Array.from(new Set([...(extra?.taskIds || []), ...(taskId ? [taskId] : [])]
    .map(x => String(x).trim()).filter(Boolean)))
  const log: LogEntry = {
    id,
    title,
    project,
    status: 'active',
    created: now,
    completed: null,
    retainDays: null,
    retainUntil: null,
    content,
    nextSteps: '',
    taskIds: ids.length ? ids : undefined,
    taskId: ids[0],
    sessionId: extra?.sessionId,
    agentName: extra?.agentName,
    logDate: extra?.logDate || now.slice(0, 10),
  }
  atomicallyWrite(path.join(dir, `${id}.md`), renderLog(log))
  return { ok: true, data: log }
}

/**
 * 更新日志。
 *
 * 2026-09-22 补（用户报障「日志根本无法改所选项目，都是方寸」）：
 * 原来只接受 title/content/nextSteps，**project 与 taskId 被静默丢弃** ——
 * 界面上改了项目、点保存、提示「已更新」，重新打开还是老项目。
 * 典型的"看起来成功了"的假成功，现把两个字段一并落盘。
 */
export function updateLog(id: string, updates: {
  title?: string
  content?: string
  nextSteps?: string
  project?: string
  taskId?: string
  /** 2026-09-25（用户第 2 条）：多个关联任务。给了它就以它为准，taskId 退化为 ids[0]。 */
  taskIds?: string[]
  sessionId?: string
  agentName?: string
  logDate?: string
}): { ok: boolean; data?: LogEntry; error?: string } {
  const dir = getLogsDir()
  const filePath = path.join(dir, `${id}.md`)
  const entry = parseLogFile(filePath)
  if (!entry) return { ok: false, error: '日志不存在' }
  if (entry.status !== 'active') return { ok: false, error: `日志状态为 ${entry.status}，无法编辑` }
  if (updates.title !== undefined) entry.title = updates.title
  if (updates.content !== undefined) entry.content = updates.content
  if (updates.nextSteps !== undefined) entry.nextSteps = updates.nextSteps
  if (updates.project !== undefined) entry.project = updates.project
  // 空串 = 解除关联（renderLog 会把 tasks 写成空数组，字段随之从文件里消失）
  if (updates.taskIds !== undefined) {
    const ids = Array.from(new Set((updates.taskIds || []).map((x: any) => String(x).trim()).filter(Boolean)))
    entry.taskIds = ids.length ? ids : undefined
    entry.taskId = ids[0]
  } else if (updates.taskId !== undefined) {
    // 兼容只传单值的旧调用：单值同样落成列表
    const v = updates.taskId ? String(updates.taskId).trim() : ''
    entry.taskIds = v ? [v] : undefined
    entry.taskId = v || undefined
  }
  if (updates.sessionId !== undefined) entry.sessionId = updates.sessionId ? String(updates.sessionId).trim() : undefined
  if (updates.agentName !== undefined) entry.agentName = updates.agentName ? String(updates.agentName).trim() : undefined
  if (updates.logDate !== undefined) entry.logDate = updates.logDate ? String(updates.logDate).trim() : undefined
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry }
}

export function completeLog(id: string, retainDays: number | null, note?: string): { ok: boolean; data?: LogEntry; error?: string } {
  const dir = getLogsDir()
  const filePath = path.join(dir, `${id}.md`)
  const entry = parseLogFile(filePath)
  if (!entry) return { ok: false, error: '日志不存在' }
  if (entry.status !== 'active') return { ok: false, error: `日志状态为 ${entry.status}，无法完成` }
  entry.status = 'completed'
  entry.completed = new Date().toISOString()
  entry.retainDays = retainDays
  if (retainDays != null && retainDays > 0) {
    const until = new Date()
    until.setDate(until.getDate() + retainDays)
    entry.retainUntil = until.toISOString()
  }
  if (note) entry.note = note
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry }
}

export function archiveLog(id: string, note?: string): { ok: boolean; data?: LogEntry; error?: string } {
  const dir = getLogsDir()
  const filePath = path.join(dir, `${id}.md`)
  const entry = parseLogFile(filePath)
  if (!entry) return { ok: false, error: '日志不存在' }
  if (entry.status === 'archived') return { ok: false, error: '日志已归档' }
  entry.status = 'archived'
  if (note) entry.note = note
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry }
}

/**
 * 把日志**打回「进行中」**（2026-09-26 用户补充第 3 条：「希望日志加一个功能，
 * 可以临时打上进行中标签，并且卡片有特殊视觉效果」）。
 *
 * 为什么需要单独一条通道：状态此前是单行道 active → completed → archived
 * （`updateLog` 还明确拒绝改非 active 的日志），点过一次「完成」或「归档」就再也回不去，
 * 而用户的真实用法常常是「这条我现在又在弄了」。
 *
 * 语义：只改状态、不动文件；顺手清掉 `completed` / `retainDays` / `retainUntil` ——
 * 留着会让卡片继续显示「已完成 + 保留到 X」，与「进行中」自相矛盾。
 * 已经是 active 的给 ok（幂等），不写盘。
 */
export function reopenLog(id: string): { ok: boolean; data?: LogEntry; error?: string } {
  const filePath = path.join(getLogsDir(), `${id}.md`)
  const entry = parseLogFile(filePath)
  if (!entry) return { ok: false, error: '日志不存在' }
  if (entry.status === 'active') return { ok: true, data: entry }
  entry.status = 'active'
  entry.completed = null
  entry.retainDays = null
  entry.retainUntil = null
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry }
}

export function destroyLog(id: string): { ok: boolean; error?: string } {
  const filePath = path.join(getLogsDir(), `${id}.md`)
  if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在' }
  fs.unlinkSync(filePath)
  return { ok: true }
}

export function searchLogs(query: string, limit = 50): LogEntry[] {
  const q = query.toLowerCase()
  return listLogs().filter(l =>
    l.title.toLowerCase().includes(q) ||
    l.content.toLowerCase().includes(q) ||
    l.project.toLowerCase().includes(q)
  ).slice(0, limit)
}

export function injectLog(id: string): string | null {
  const entry = getLog(id)
  if (!entry) return null
  const parts: string[] = []
  parts.push(`## 上次执行日志（来源：方寸执行日志 ${entry.id}）`)
  parts.push(`**项目**：${entry.project}`)
  parts.push(`**时间**：${entry.created}`)
  if (entry.completed) parts.push(`**完成时间**：${entry.completed}`)
  parts.push(`**状态**：${entry.status}`)
  if (entry.content) parts.push(`\n### 做了什么\n${entry.content}`)
  if (entry.nextSteps) parts.push(`\n### 下一步\n${entry.nextSteps}`)
  if (entry.taskId) parts.push(`\n### 关联任务\n${entry.taskId}`)
  return parts.join('\n')
}

export function cleanupLogs(): string[] {
  const dir = getLogsDir()
  if (!fs.existsSync(dir)) return []
  const archived: string[] = []
  const now = new Date().toISOString()
  for (const fn of fs.readdirSync(dir)) {
    if (!fn.endsWith('.md')) continue
    const entry = parseLogFile(path.join(dir, fn))
    if (!entry) continue
    if (entry.status === 'completed' && entry.retainUntil && now > entry.retainUntil) {
      entry.status = 'archived'
      atomicallyWrite(path.join(dir, fn), renderLog(entry))
      archived.push(entry.id)
    }
  }
  return archived
}
