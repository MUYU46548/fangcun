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
  /**
   * 生命周期状态。**语义在 2026-09-28 被重新定义**（用户第 2 条）：
   *
   *   active    = **待处理**（未开始 / 没有人在跑）—— 新建日志的默认值
   *   completed = 已完成
   *   archived  = 已归档
   *
   * 值没变（不迁移任何历史文件），变的只是「active 的中文显示」：
   * 以前叫「进行中」，而它是**创建时自动打上的**，于是所有日志一出生就是「进行中」，
   * 用户分不清「没跑 / 正在跑 / 跑完了」。现在「进行中」是独立的 running 标记，
   * 只能手动打、可撤销。
   */
  status: 'active' | 'completed' | 'archived'
  /**
   * 「进行中」标记（2026-09-28 用户第 2 条）。
   *
   * 用户原话：「我需要"进行中"只能由手动开关打上，且可以撤销（防止误操作），
   * 且不成为完成或归档的必要条件。」
   *
   * 所以它是**独立布尔**而不是 status 的一个取值：
   *   - 与 status 正交 —— 只有未完成的日志才谈得上"正在跑"，但完成/归档**不要求**先打开它；
   *   - 只能手动开（创建时恒为假，任何自动路径都不写它）；
   *   - 可撤销（关掉即回到「待处理」）；
   *   - 只在 true 时落盘（`running: true`），关掉即从文件里消失，历史文件不会凭空多出字段。
   */
  running?: boolean
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
  /**
   * 置顶（2026-09-26 卡 037，用户点选：**用新字段 pinned**）。
   *
   * 为什么是独立字段而不是复用 status：置顶是**视图属性**，跟 active/completed/archived
   * 这条生命周期正交 —— 已归档的东西也可能是"正在查的东西"，钉在最上面看得见。
   * 所以写入时只在 true 时落 `pinned: true`（false 直接不写，文件保持干净），
   * 且切换置顶**不受「非 active 不可编辑」那条守卫限制**（见 setLogPinned 的注释）。
   */
  pinned?: boolean
  /**
   * 接力链（2026-09-29 第 3 条方案二）：本条接续自哪条日志。
   * 链 = 沿这个字段往回走的连通分量 —— 只多这一个字段，不引入新实体、不建数据库。
   * 文件键 `continues_from`；只在有值时落盘（无值不写，历史文件不会凭空多出字段）。
   */
  continueFrom?: string
  /**
   * 归档备注（`## 归档备注` 节）。
   * 2026-09-29 修：此前 parse 不读这一节、render 只认 note —— 归档后任意一次
   * 写回（改运行标记/置顶/编辑…）都会把这节**静默删掉**（同族问题：Python 侧
   * api_log_archive 写的归档备注，桌面版一碰就丢）。
   */
  archiveNote?: string
  /**
   * 附件（2026-10-01 用户第 1 条，落地卡 036 的口径；用户原话「报修时截图/分析报告有地方放，
   * 不用靠脑子记」，且已提过至少两次）：
   *
   * - 文件**复制进数据目录** `docs/执行日志/_attachments/<logId>/`，列表里存**相对数据目录**的路径 ——
   *   绝不存外部绝对路径（换个盘/挪个目录就全部失效，验收里明写「绝不外链失效」）。
   * - 不做素材库、不做标签/预览管理 —— 只做「日志 ↔ 文件」这一条关联入口。
   * - 附件目录以 `_` 开头且不是 .md，listLogs 的 `isFile` 过滤天然跳过，不会被当成日志。
   */
  attachments?: string[]
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

    // Extract content, next_steps and confirmation tails from body sections
    let logContent = ''
    let nextSteps = ''
    let noteText = ''
    let archiveNoteText = ''
    let currentSection = ''
    const lines = body.split('\n')
    for (const line of lines) {
      if (line.startsWith('## 执行内容')) {
        currentSection = 'content'
        continue
      } else if (line.startsWith('## 下一步')) {
        currentSection = 'nextSteps'
        continue
      } else if (line.startsWith('## 完成确认')) {
        currentSection = 'note'
        continue
      } else if (line.startsWith('## 归档备注')) {
        currentSection = 'archiveNote'
        continue
      } else if (line.startsWith('## ')) {
        currentSection = ''
        continue
      }
      if (currentSection === 'content') {
        logContent += (logContent ? '\n' : '') + line
      } else if (currentSection === 'nextSteps') {
        nextSteps += (nextSteps ? '\n' : '') + line
      } else if (currentSection === 'note') {
        noteText += (noteText ? '\n' : '') + line
      } else if (currentSection === 'archiveNote') {
        archiveNoteText += (archiveNoteText ? '\n' : '') + line
      }
    }

    // 2026-09-25（用户第 2 条）：一次读出**全部**关联任务 ID（原来只取第一个）
    const taskIds = extractTaskIds(raw)

    return {
      id: String(raw.id || path.basename(filePath, '.md')),
      title: String(raw.title || ''),
      project: String(raw.project || ''),
      status: (raw.status || 'active') as LogEntry['status'],
      // 「进行中」是手动标记（2026-09-28），只在文件里显式写了 true 才算数
      running: raw.running === true || raw.running === 'true',
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
      pinned: raw.pinned === true || raw.pinned === 'true',
      // 接力链（方案二）：文件键 continues_from
      continueFrom: raw.continues_from ? String(raw.continues_from) : undefined,
      // 确认尾巴：此前不读 → 下一次写回就静默删节（见 archiveNote 字段注释）
      note: noteText || undefined,
      archiveNote: archiveNoteText || undefined,
      attachments: parseAttachments(raw.attachments),
    }
  } catch {
    return null
  }
}

function parseAttachments(v: any): string[] {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') {
    const s = v.trim()
    if (s.startsWith('[') && s.endsWith(']')) {
      return s.slice(1, -1).split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    }
    return s ? [s] : []
  }
  return []
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
  // 只在 true 时落字段（false = 不写，历史文件不会凭空多出 pinned: false）
  if (log.pinned) fm.pinned = true
  if (log.running) fm.running = true
  // 接力链：只在有值时落盘
  if (log.continueFrom) fm.continues_from = log.continueFrom
  let fmText = yaml.dump(fm, { lineWidth: -1, noRefs: true, flowLevel: -1 })
  // 附件清单走**手工内联行**，不交给 yaml.dump（2026-10-01）：
  // Python 侧 `tegula/core.py::_parse_log` 是逐行 kv 解析、只认 `[a, b]` 这种内联列表，
  // yaml.dump 出的块式列表（`attachments:` + `  - x`）会被它读成空值，下一次 Python 写盘
  // （api_log_complete / api_log_archive …）就把附件清单**静默清空** —— 归档备注同族问题不能再犯。
  // 路径里会破坏两个解析器的字符（逗号/引号/方括号）在复制落盘时就被文件名清洗掉了。
  if (log.attachments?.length) {
    fmText += 'attachments: [' + log.attachments.map(p => `'${String(p)}'`).join(', ') + ']\n'
  }
  let body = `# ${log.title}\n\n## 执行内容\n\n${log.content || '（待填写）'}\n\n## 下一步\n\n${log.nextSteps || '（待填写）'}`
  if (log.note) {
    body += `\n\n## 完成确认\n\n${log.note}`
  }
  if (log.archiveNote) {
    body += `\n\n## 归档备注\n\n${log.archiveNote}`
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
  /** true = 只要手动标了「进行中」的（2026-09-28） */
  running?: boolean
  dateFrom?: string
  dateTo?: string
  agent?: string
  /** 关键词（2026-10-01 用户第 3 条「日常卡点」）：搜索与筛选**必须可叠加**。
   *  此前界面有两条互不相干的路 —— 搜索走 `searchLogs(query)`（无视项目/Agent/日期），
   *  筛选走 `listLogs(filter)`（无视搜索词），任何一次刷新（完成/归档/改筛选）都会
   *  把搜索结果冲掉、而搜索框里的词还留着，用户看到的是「搜了又没了」。
   *  现在搜索词就是筛选的一个维度，只有一条取数路径。 */
  query?: string
}): LogEntry[] {
  const dir = getLogsDir()
  if (!fs.existsSync(dir)) return []
  const q = String(filter?.query || '').trim().toLowerCase()
  const hit = (s: string) => String(s || '').toLowerCase().includes(q)
  const logs: LogEntry[] = []
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse()
  for (const fn of files) {
    const entry = parseLogFile(path.join(dir, fn))
    if (!entry) continue
    if (filter?.project && entry.project !== filter.project) continue
    if (filter?.status && entry.status !== filter.status) continue
    if (filter?.running !== undefined && !!entry.running !== filter.running) continue
    if (filter?.agent && entry.agentName !== filter.agent) continue
    // 日期范围筛选：按 logDate（默认 created 日期）过滤
    const entryDate = (entry.logDate || entry.created || '').slice(0, 10)
    if (filter?.dateFrom && entryDate < filter.dateFrom) continue
    if (filter?.dateTo && entryDate > filter.dateTo) continue
    // 关键词：标题 / 执行内容 / 下一步 / 项目（比 searchLogs 多查一步「下一步」，
    // 日志里最该被搜到的往往正是它）
    if (q && !(hit(entry.title) || hit(entry.content) || hit(entry.nextSteps) || hit(entry.project))) continue
    logs.push(entry)
  }
  // 置顶优先（2026-09-26 卡 037）：Array.sort 在 V8 里是稳定的，组内保持原有顺序（文件名倒序 = 新的在前）
  logs.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
  return logs
}

export function getLog(id: string): LogEntry | null {
  const dir = getLogsDir()
  return parseLogFile(path.join(dir, `${id}.md`))
}

/**
 * 接力链上下游（2026-09-29 方案二）：沿 continues_from 上溯 / 下溯，不含自身。
 *
 *   upstream   = 从最老的「链头」到直接父级（旧 → 新）
 *   downstream = 从直接子代到最新的「链尾」（近 → 远，BFS）
 *
 * 只多一个字段的代价就是这里：链 = 连通分量，不建实体、不建索引。
 * 防御三件：环（visited 去重）、指向不存在/已销毁日志（断链即止）、自指。
 */
export function logChain(id: string): { upstream: LogEntry[]; downstream: LogEntry[] } {
  const all = listLogs()
  const byId = new Map(all.map(l => [l.id, l] as const))

  const upstream: LogEntry[] = []
  const seen = new Set<string>([id])
  let cur = byId.get(id)
  while (cur?.continueFrom && !seen.has(cur.continueFrom)) {
    const parent = byId.get(cur.continueFrom)
    if (!parent) break
    seen.add(parent.id)
    upstream.push(parent)
    cur = parent
  }
  upstream.reverse()

  const children = new Map<string, LogEntry[]>()
  for (const l of all) {
    if (!l.continueFrom) continue
    const arr = children.get(l.continueFrom) || []
    arr.push(l)
    children.set(l.continueFrom, arr)
  }
  const downstream: LogEntry[] = []
  const seen2 = new Set<string>([id])
  const queue = [id]
  while (queue.length) {
    const curId = queue.shift() as string
    for (const child of children.get(curId) || []) {
      if (seen2.has(child.id)) continue
      seen2.add(child.id)
      downstream.push(child)
      queue.push(child.id)
    }
  }
  return { upstream, downstream }
}

export function createLog(
  title: string,
  project: string,
  content: string,
  taskId?: string,
  extra?: { sessionId?: string; agentName?: string; logDate?: string; taskIds?: string[]; nextSteps?: string; continueFrom?: string },
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
    // 2026-09-28：新建 = 「待处理」。**不再自动打成「进行中」** ——
    // 那条自动标记正是「日志一创建就是进行中」混乱的根因（用户第 2 条）。
    status: 'active',
    running: false,
    created: now,
    completed: null,
    retainDays: null,
    retainUntil: null,
    content,
    // 接力（方案二）：新日志直接继承源日志的「下一步」——这是对话框预填的落点
    nextSteps: extra?.nextSteps || '',
    taskIds: ids.length ? ids : undefined,
    taskId: ids[0],
    sessionId: extra?.sessionId,
    agentName: extra?.agentName,
    logDate: extra?.logDate || now.slice(0, 10),
    continueFrom: extra?.continueFrom || undefined,
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

/**
 * 置顶 / 取消置顶（2026-09-26 卡 037）。
 *
 * **刻意绕开 updateLog 的「非 active 不可编辑」守卫**：那条守卫防的是"改内容"，
 * 而置顶是视图属性 —— 已归档的日志也该能被钉住（用户原话：「正在修的东西钉在上面」）。
 * 写入走同一条 atomicallyWrite（先写 .tmp 再 rename），不新增第二条写路径。
 */
export function setLogPinned(id: string, pinned: boolean): { ok: boolean; data?: LogEntry; error?: string } {
  const dir = getLogsDir()
  const filePath = path.join(dir, `${id}.md`)
  const entry = parseLogFile(filePath)
  if (!entry) return { ok: false, error: '日志不存在' }
  entry.pinned = !!pinned
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry }
}

/**
 * 改项目归属（卡 037 右键菜单：「不进编辑页，顺手改」）。
 * 同样绕开 active 守卫 —— 归类属性，不是内容编辑。
 */
export function setLogProject(id: string, project: string): { ok: boolean; data?: LogEntry; error?: string } {
  const dir = getLogsDir()
  const filePath = path.join(dir, `${id}.md`)
  const entry = parseLogFile(filePath)
  if (!entry) return { ok: false, error: '日志不存在' }
  entry.project = String(project || '').trim()
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry }
}

export function completeLog(id: string, retainDays: number | null, note?: string): { ok: boolean; data?: LogEntry; error?: string } {
  const dir = getLogsDir()
  const filePath = path.join(dir, `${id}.md`)
  const entry = parseLogFile(filePath)
  if (!entry) return { ok: false, error: '日志不存在' }
  // 2026-09-28（用户第 2 条后半句）：「进行中」**不是完成的前置条件**。
  // 原来这里写着 `if (entry.status !== 'active') return 无法完成` —— 那是把「进行中」
  // 当成必经状态了。现在从「待处理」直接完成、或从「已归档」补完成，都放行。
  entry.status = 'completed'
  entry.running = false   // 已完成的东西不该还挂着「进行中」
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
  // 2026-09-28（用户第 2 条）：「进行中」同样**不是归档的前置条件**；
  // 对已经归档的再点一次给 ok（幂等），不再报「日志已归档」——
  // 用户看到的是一个"点了报错"的按钮，而他要的只是"这条收起来"。
  if (entry.status === 'archived' && !entry.running) return { ok: true, data: entry }
  entry.status = 'archived'
  entry.running = false
  // 归档备注落 archiveNote（## 归档备注），不再借道 note —— 两者是不同节，
  // 借道会让「完成确认」被归档动作覆盖掉。
  if (note) entry.archiveNote = note
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry }
}

/**
 * 把日志**撤销完成 / 撤销归档**，退回「待处理」（2026-09-26 卡 022；2026-09-28 重新定位）。
 *
 * 语义变化（用户第 2 条）：以前它的按钮叫「▶ 进行中」，也就是**撤销 = 自动变成进行中**。
 * 那正是混乱的来源 —— 用户只是想撤销一次误点的「完成」，却被迫得到「进行中」。
 * 现在撤销只把人放回**待处理**，要不要「进行中」由用户自己另外开。
 *
 * 顺手清掉 `completed` / `retainDays` / `retainUntil` —— 留着会让卡片继续显示
 * 「已完成 + 保留到 X」，与「待处理」自相矛盾。只改状态、不动文件。
 * 本来就是 active 的给 ok（幂等），不写盘。
 */
export function reopenLog(id: string): { ok: boolean; data?: LogEntry; error?: string } {
  const filePath = path.join(getLogsDir(), `${id}.md`)
  const entry = parseLogFile(filePath)
  if (!entry) return { ok: false, error: '日志不存在' }
  if (entry.status === 'active') return { ok: true, data: entry }
  entry.status = 'active'
  entry.running = false
  entry.completed = null
  entry.retainDays = null
  entry.retainUntil = null
  // 确认尾巴随撤销一起清（此前 parse 不读它们，行为上就是"重建即消失"，现显式清）
  entry.note = undefined
  entry.archiveNote = undefined
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry }
}

/**
 * 手动开 / 关「进行中」（2026-09-28 用户第 2 条）。
 *
 * 这是「进行中」**唯一的写入路径** —— 创建、完成、归档都只会把它关掉，绝不会打开它，
 * 所以「谁在跑」这件事 100% 来自用户的手动开关。
 *
 * 打开时若日志已「完成 / 已归档」，连带把它退回「待处理」（同 reopenLog 的清理），
 * 否则卡片会同时显示「已完成」和「进行中」，自相矛盾 —— 用户点「进行中」的意思
 * 本来就是「这条我又在弄了」。
 */
export function setLogRunning(id: string, running: boolean): { ok: boolean; data?: LogEntry; error?: string } {
  const filePath = path.join(getLogsDir(), `${id}.md`)
  const entry = parseLogFile(filePath)
  if (!entry) return { ok: false, error: '日志不存在' }
  const on = !!running
  if (on && entry.status !== 'active') {
    entry.status = 'active'
    entry.completed = null
    entry.retainDays = null
    entry.retainUntil = null
  }
  // 关掉时同样顺手清「已完成」残留：从进行中撤销回来的人要的是干净的一条待处理
  if (!on && entry.status === 'active' && !entry.completed) {
    entry.retainDays = null
    entry.retainUntil = null
  }
  entry.running = on
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry }
}

export function destroyLog(id: string): { ok: boolean; error?: string } {
  const filePath = path.join(getLogsDir(), `${id}.md`)
  if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在' }
  fs.unlinkSync(filePath)
  return { ok: true }
}

/**
 * 状态的中文口径（2026-09-28）。**唯一真身在主进程**，渲染层通过 IPC 拿同一份。
 * `active` 的中文从「进行中」改成「待处理」——「进行中」现在是 running 标记的专属名字。
 */
export const LOG_STATUS_LABELS: Record<string, string> = {
  active: '待处理',
  completed: '已完成',
  archived: '已归档',
}

/** 组合出「进行中 / 待处理 / 已完成 / 已归档」四态中的一个 */
export function logStatusText(log: Pick<LogEntry, 'status' | 'running'>): string {
  if (log.status === 'active' && log.running) return '进行中'
  return LOG_STATUS_LABELS[log.status] || String(log.status)
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
  // 2026-09-28：给 agent 看的是中文状态，不是 `active` 这种内部值
  parts.push(`**状态**：${logStatusText(entry)}`)
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

// ═══════════════════════════════════════════════════════════════════
// 附件（2026-10-01 用户第 1 条 → 落地卡 036）
// 口径（卡 036 验收里定的三问，逐条对上）：
//   ① 图片存哪      → **数据目录内** `<logsDir>/_attachments/<logId>/`，frontmatter 存**相对路径**
//   ② UI 入口在哪    → 日志只读预览 + 编辑对话框的「附件」区（添加/打开/移除）
//   ③ 跟备份包关系  → 与日志同目录，日志进了包它就在包里；绝不存外部绝对路径（外链必失效）
// 不做素材库：没有标签、没有相册视图，只有一条「日志 ↔ 文件」的关联。
// ═══════════════════════════════════════════════════════════════════

/** 附件根目录（与 .md 同级，下带 `<logId>/` 子目录；`_` 开头避免与日志文件混淆） */
function attachmentsDir(logId: string): string {
  return path.join(getLogsDir(), '_attachments', logId)
}

/**
 * 落盘文件名清洗。两台解析器都吃这个名：
 *  - Python `core.py::_parse_log` 按**逗号**切内联列表 → 文件名带逗号会被劈成两半
 *  - 引号/方括号会打断 YAML 的 `['x']` 写法
 *  - Windows 非法字符照常剔除
 */
function safeAttachName(name: string): string {
  return path.basename(name).replace(/[,;[\]'"]/g, '_').replace(/[\\/:*?"<>|]/g, '_').trim() || 'file'
}

/** 相对数据目录的**正斜杠**路径（Windows 反斜杠会在另一个解析器里变成转义符） */
function toRelPosix(absPath: string): string {
  return path.relative(getDataDir(), absPath).split(path.sep).join('/')
}

/**
 * 把外部文件**复制**进数据目录并挂到日志上。
 * 是复制不是移动：源文件留在原处（用户可能还放在别的地方），数据目录里这份是自足的。
 * 允许给**非 active** 的日志挂附件 —— 报告/截图常常是跑完之后才补的，
 * 所以和置顶一样绕开「非 active 不可编辑」那条守卫（那条守卫防的是改内容）。
 */
export function addAttachments(logId: string, sources: string[]): { ok: boolean; data?: LogEntry; error?: string } {
  const dir = getLogsDir()
  const filePath = path.join(dir, `${logId}.md`)
  const entry = parseLogFile(filePath)
  if (!entry) return { ok: false, error: '日志不存在' }

  const destDir = attachmentsDir(logId)
  const added: string[] = []
  for (const src of sources || []) {
    try {
      if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) continue
      fs.mkdirSync(destDir, { recursive: true })
      const name = safeAttachName(src)
      let dest = path.join(destDir, name)
      let n = 1
      while (fs.existsSync(dest)) {
        const ext = path.extname(name)
        const stem = path.basename(name, ext)
        dest = path.join(destDir, `${stem} (${n})${ext}`)
        n++
      }
      fs.copyFileSync(src, dest)
      added.push(toRelPosix(dest))
    } catch {
      // 单个文件失败不拖垮整批（锁着的、权限不足的直接跳过），最后统一报数
    }
  }
  if (!added.length) return { ok: false, error: '没有成功添加任何文件' }

  entry.attachments = Array.from(new Set([...(entry.attachments || []), ...added]))
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry }
}

/**
 * 解除关联（**不删文件**）。「移除」在界面上的语义是"这条日志不再引用它"，
 * 不是销毁数据 —— 真要删文件是另一件事，且属于破坏性操作，不做隐藏在按钮后面的事。
 */
export function detachAttachment(logId: string, relPath: string): { ok: boolean; data?: LogEntry; error?: string } {
  const dir = getLogsDir()
  const filePath = path.join(dir, `${logId}.md`)
  const entry = parseLogFile(filePath)
  if (!entry) return { ok: false, error: '日志不存在' }
  const rel = String(relPath || '')
  entry.attachments = (entry.attachments || []).filter(x => x !== rel)
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry }
}

/**
 * 相对路径 → 绝对路径，**带逃逸检查**。
 * 附件路径最终会交给 shell.openPath / fs.readFile，所以必须钉死在数据目录内，
 * 否则 frontmatter 里被写进 `../../xxx` 就能读任意文件。
 */
export function resolveAttachment(relPath: string): string | null {
  const rel = String(relPath || '').replace(/\\/g, '/').trim()
  if (!rel) return null
  const root = path.resolve(getDataDir())
  const abs = path.resolve(root, rel.split('/').join(path.sep))
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null
}

const ATTACH_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.log': 'text/plain',
  '.json': 'application/json', '.csv': 'text/csv', '.html': 'text/html', '.zip': 'application/zip',
}

/**
 * 附件 → data URL（渲染层**唯一**的预览通道）。
 * 为什么不用 `file://`：dev 态页面跑在 http://localhost，跨源直接读不了本地图片；
 * 打包态虽是 file://，但两条路都得绕权限白名单 —— 走 IPC 最省事也最可控。
 * 超过 8MB 不内联（base64 还要再涨三分之一，塞进 <img> 会把渲染层卡住），
 * 这种情况返回 tooLarge，UI 上给「用系统程序打开」的按钮。
 */
export function readAttachmentData(relPath: string, maxBytes = 8 * 1024 * 1024):
  { ok: boolean; data?: { mime: string; dataUrl: string; name: string }; error?: string } {
  const abs = resolveAttachment(relPath)
  if (!abs) return { ok: false, error: '附件不存在（可能已被移出数据目录）' }
  const stat = fs.statSync(abs)
  const ext = path.extname(abs).toLowerCase()
  const mime = ATTACH_MIME[ext] || 'application/octet-stream'
  const name = path.basename(abs)
  if (stat.size > maxBytes) return { ok: false, error: 'tooLarge', data: { mime, dataUrl: '', name } }
  try {
    const buf = fs.readFileSync(abs)
    return { ok: true, data: { mime, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, name } }
  } catch (e: any) {
    return { ok: false, error: `读取失败：${e?.message || e}` }
  }
}
