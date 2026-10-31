/**
 * Fangcun Desktop — Log Service
 * High-frequency work execution logs (active → completed → archived → destroy)
 */

import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { getDataDir, atomicWrite } from '../data'

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
  /**
   * AI 申请收口（2026-10-30 用户拍板「完成是签字，不是干活」）。
   *
   * 为什么不是 status 的第四个值：状态机是 待处理 / 已完成 / 已归档 三态，
   * 「等你确认」不是生命周期的一站，而是**一句话**——"我这边做完了，你点一下"。
   * 所以它是与 status 正交的布尔，只在 active 上有意义：
   *   - agent 只能 `request_close` 打开它，**不能**自己 complete/archive；
   *   - 用户在卡上点「✅ 确认完成」才真的进 completed；
   *   - 完成 / 归档 / 重新标进行中 / 撤销时自动清掉，历史文件不多字段。
   */
  agentDone?: boolean
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
  /**
   * 上次的执行 Agent（2026-10-03 用户反馈1，卡 task-20261003-001，用户拍板拆两字段）：
   * 接力来源那段是谁跑的 —— 找上一段的会话就认它。
   * 此前与 agentName 是同一个字段却有两种标签（编辑框标「上次执行 Agent」、
   * 接力框标「执行 Agent」），用户原话「不标清楚想找会话都找不到」。
   * 文件键 `prev_agent_name`；只在有值时落盘（历史文件不凭空多字段）。
   */
  prevAgentName?: string
  /** 日志归属日期（YYYY-MM-DD），默认取 created 日期，可手动配置 */
  logDate?: string
  /**
   * 最后一次「改正文」的时间（ISO）。2026-10-18 暮雨第 2 条问「已完成的日志改不了，是防篡改吗」。
   *
   * 结论：旧守卫（`status !== 'active' → 拒改`）是 2026-09-28「状态单行道」时代的遗留，
   * 而界面从那时起**一直保留着「✏️ 编辑」按钮** —— 用户点进去改完点保存才被拒，等于
   * "给你门不给路"。它不是防篡改（日志没有哈希/签名，手动改文件一样能改），只是一条
   * 与 UI 不一致的守卫。现在改为：**已完成 / 已归档也能改正文**，但改过就落 `edited`
   * 戳、卡面显示「✎ 改过」—— 留痕而不是禁止。真正的防手滑靠 `.backup` 里的上一版
   * （`restorePreviousLogVersion`，界面上叫「↩ 撤回上次保存」）。
   *
   * 只在 `title`/`content`/`nextSteps` 真被改时写（改项目、批量标优先级这类元数据不动它，
   * 否则「改过」会变成天天亮着的噪音）。文件键 `edited`；无值不落盘。
   */
  edited?: string
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
  /**
   * 日志优先级（2026-10-08 卡 task-20261008-001，用户拍板 **新增字段**（否决"按关联任务优先级排"：
   * 那要用户先给任务排好序才能排日志，与方寸"减少心智成本"的初衷相悖））。
   *
   * - 值域与任务卡同款中文：高 / 中 / 低；空 = 没标（历史日志全是这个状态）。
   * - **只在有值时落盘**（与 pinned/running 同一条纪律）：历史文件不会凭空多出 priority 字段。
   * - 文件键 `priority`：Python 侧 `_parse_log`/`_render_log` 是逐行 kv + 任意键透传，
   *   中文标量两个方向都能原样往返（e2e-fm-contract 有断言钉住这条）。
   */
  priority?: string
  /**
   * 来源待办 ID（2026-10-08 卡 task-20261008-004 日志⇄待办互转，拍板=双向）。
   * 目标记录「由 X 转来」——与接力链 continues_from 同一套 prev 范式，但**不共用字段**：
   * continues_from 指向日志（logChain 沿它走），这个指向待办，混用会把链走到待办上断掉。
   *
   * - 用途：① 卡面标「⤴ 待办」来源；② **防重** —— 同一条待办只转一次（手滑点两下不产两条）。
   * - 文件键 `from_todo`（与 prev_agent_name 同款 snake 映射）；只在有值时落盘，
   *   普通日志零变化。parse/render 白名单两处都必须在 —— 漏一处 = 下次写回即丢。
   */
  fromTodo?: string
  /**
   * 附属日志（2026-10-30 暮雨第 4 条）。
   *
   * 用户原话：「我要的就是一篇主日志带若干附属日志，一起绑定，一键全进行中，一键全完成」。
   * 以前只有一个「多选 → 开工单」的复制按钮：多选本身还是临时状态，复制完就散，
   * 下次还得重新勾。现在把关系**落盘**在主日志上：
   *   · 只有主日志有这个字段（`attached: [副日志 id...]`），副日志不存反向指针 ——
   *     单一事实来源，不会出现两边不一致；
   *   · 一个副日志只能属于一个主日志（写之前校验），最多 20 条；
   *   · 只在有值时落盘，历史日志不会凭空多字段；
   *   · 与接力链（continues_from）是两件事：接力 = 先后续写，附属 = 同一轮并行通道。
   */
  attached?: string[]
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
      // AI 申请收口（2026-10-30）：只在 true 时落盘，历史文件不多字段
      agentDone: raw.agent_done === true || raw.agent_done === 'true',
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
      prevAgentName: raw.prev_agent_name ? String(raw.prev_agent_name) : undefined,
      logDate: raw.log_date ? String(raw.log_date) : undefined,
      // 改正文的时间戳（2026-10-18）：白名单字段必须显式读，否则下一次写回即丢
      edited: raw.edited ? String(raw.edited) : undefined,
      pinned: raw.pinned === true || raw.pinned === 'true',
      // 接力链（方案二）：文件键 continues_from
      continueFrom: raw.continues_from ? String(raw.continues_from) : undefined,
      // 确认尾巴：此前不读 → 下一次写回就静默删节（见 archiveNote 字段注释）
      note: noteText || undefined,
      archiveNote: archiveNoteText || undefined,
      attachments: parseAttachments(raw.attachments),
      // 优先级：白名单字段**必须在这里显式列出**，否则写回即丢（parse → render 是全量重建）
      priority: raw.priority ? String(raw.priority) : undefined,
      // 卡 004 来源链：同上，白名单漏列 = 下一次写回把来源静默删掉
      fromTodo: raw.from_todo ? String(raw.from_todo) : undefined,
      // 附属日志（2026-10-30 第 4 条）：与 tasks/attachments 同款，块式与内联两种写法都认
      attached: parseAttachments(raw.attached).slice(0, 20),
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
  if (log.agentDone) fm.agent_done = true
  // 接力链：只在有值时落盘
  if (log.continueFrom) fm.continues_from = log.continueFrom
  // 上次的执行 Agent：与 continues_from 同款「只在有值时落盘」
  if (log.prevAgentName) fm.prev_agent_name = log.prevAgentName
  // 优先级：只在有值时落盘（没标的历史日志不会凭空多出 priority: '' 这类垃圾字段）
  if (log.priority) fm.priority = log.priority
  // 卡 004 来源链（由待办转来）：同样只在有值时落盘
  if (log.fromTodo) fm.from_todo = log.fromTodo
  // 改正文的时间戳（2026-10-18）：只在有值时落盘，历史日志零变化
  if (log.edited) fm.edited = log.edited
  let fmText = yaml.dump(fm, { lineWidth: -1, noRefs: true, flowLevel: -1 })
  // 附属日志（2026-10-30 第 4 条）：手工内联，理由同 attachments ——
  // Python 侧逐行 kv 解析只认 `[a, b]`，yaml.dump 的块式列表会被读成空值。
  if (log.attached?.length) {
    fmText += 'attached: [' + log.attached.map(id => `'${String(id)}'`).join(', ') + ']\n'
  }
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

// 本地只留一层薄壳：写前备份 + 原子写统一走共享 helper（2026-10-03 族2 写盘收敛），
// 12 处调用点不动，避免第二条手写 tmp+rename 写路径回潮。
function atomicallyWrite(filePath: string, content: string): void {
  atomicWrite(filePath, content)
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
  extra?: { sessionId?: string; agentName?: string; prevAgentName?: string; logDate?: string; taskIds?: string[]; nextSteps?: string; continueFrom?: string; priority?: string; fromTodo?: string },
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
    prevAgentName: extra?.prevAgentName || undefined,
    logDate: extra?.logDate || now.slice(0, 10),
    continueFrom: extra?.continueFrom || undefined,
    // 优先级：建日志时就可标（与 updateLog 同口径：空 = 不落字段）
    priority: extra?.priority ? String(extra.priority).trim() : undefined,
    // 卡 004：由待办转来时记来源（防重 + 卡面徽章）；普通新建不写
    fromTodo: extra?.fromTodo ? String(extra.fromTodo).trim() : undefined,
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
  prevAgentName?: string
  logDate?: string
  /** 优先级（高/中/低）。给了空串 = 取消标注（字段从文件里消失，与 taskIds 解除关联同口径）。 */
  priority?: string
  /**
   * 来源待办 ID（2026-10-08 卡 task-20261008-004 日志⇄待办互转，拍板=双向）。
   * 目标记录「由 X 转来」——与接力链 continues_from 同一套 prev 范式，但**不共用字段**：
   * continues_from 指向日志（logChain 沿它走），这个指向待办，混用会把链走到待办上断掉。
   * 用途：① 卡面标「⤴ 待办」来源；② 防重（同一条待办只转一次）。只在有值时落盘。
   */
  fromTodo?: string
}): { ok: boolean; data?: LogEntry; error?: string } {
  const dir = getLogsDir()
  const filePath = path.join(dir, `${id}.md`)
  const entry = parseLogFile(filePath)
  if (!entry) return { ok: false, error: '日志不存在' }
  // 2026-10-18 暮雨第 2 条：这里原本是 `if (entry.status !== 'active') return 拒改`。
  // 那条守卫与界面自相矛盾 —— 日志卡与非 active 日志的编辑弹窗**一直都有「✏️ 编辑」**，
  // 用户改完点保存才吃到「日志状态为 completed，无法编辑」，只能复制出来新建一条。
  // 它不是防篡改（没有哈希/签名），只是「状态单行道」时代的遗留；现在改为**可改 + 留痕**：
  //   · 正文类字段（title/content/nextSteps）改动 → 落 `edited` 时间戳，卡面显示「✎ 改过」；
  //   · 生命周期字段（status/completed/retain_until）**不在这张 updates 表里**，改不到；
  //   · 真正的"手滑撤回"由 `.backup` 上一版兜底（见 restorePreviousLogVersion）。
  if (updates.title !== undefined || updates.content !== undefined || updates.nextSteps !== undefined) {
    entry.edited = new Date().toISOString()
  }
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
  if (updates.prevAgentName !== undefined) entry.prevAgentName = updates.prevAgentName ? String(updates.prevAgentName).trim() : undefined
  if (updates.logDate !== undefined) entry.logDate = updates.logDate ? String(updates.logDate).trim() : undefined
  if (updates.priority !== undefined) entry.priority = updates.priority ? String(updates.priority).trim() : undefined
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry }
}

// ── 撤回上一版（2026-10-18 暮雨第 1 条：「没有撤回选项，Ctrl+Z 也没用」）────────
//
// 事实基础：`atomicWrite` 在**每次落盘前**都会把旧文件复制进同目录 `.backup/`
// （`rotateBackup`，每条日志最多留 10 版）。也就是说「上一版」一直在磁盘上，
// 只是从来没有入口 —— 用户只能看着改坏的内容干瞪眼。
// 这里把那份既有备份接出来：**不新增第二套备份机制**，只是给它一个可点的按钮。
// 语义刻意做成「撤回上一次保存」，不做完整撤销栈（那要动全站写路径，见中期规划）。

export interface LogVersion {
  /** `.backup` 里的文件名 */
  file: string
  /** 落盘时间（ISO，UTC） */
  at: string
  size: number
  /** 这一版的标题 —— 列表里必须能认出"是哪一版"，只给时间等于让人盲选 */
  title: string
  /** 这一版的生命周期状态（预览时一起看，避免恢复完才发现状态也回去了） */
  status?: string
}

/** 单版预览：列表只给元数据，正文按需读（避免一次把 10 版全文塞给渲染层） */
export interface LogVersionDetail {
  file: string
  at: string
  size: number
  title: string
  status?: string
  content: string
  nextSteps: string
}

function logBackupDir(): string {
  return path.join(getLogsDir(), '.backup')
}

function versionAtFromName(name: string, prefix: string): string {
  const stamp = name.slice(prefix.length, -4)          // YYYYMMDDHHmmss[SSS]（rotateBackup 按 UTC 生成）
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})?$/.exec(stamp)
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? '.' + m[7] : ''}Z` : ''
}

/** 这条日志本地留着的历史版本，**最新在前**。 */
export function listLogVersions(id: string): LogVersion[] {
  const safe = String(id || '')
  if (!safe || /[\\/]/.test(safe)) return []
  const dir = logBackupDir()
  if (!fs.existsSync(dir)) return []
  const prefix = `${safe}.md.`
  const out: LogVersion[] = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith('.bak')) continue
    const filePath = path.join(dir, name)
    let size = 0
    try { size = fs.statSync(filePath).size } catch { continue }
    const parsed = parseLogFile(filePath)
    out.push({
      file: name,
      at: versionAtFromName(name, prefix),
      size,
      title: parsed?.title || '',
      status: parsed?.status,
    })
  }
  return out.sort((a, b) => (a.file < b.file ? 1 : a.file > b.file ? -1 : 0))
}

/**
 * 把一个版本文件名解析成**已校验的绝对路径**。
 *
 * 安全边界写死：只认 `listLogVersions` 刚列出来的文件名，绝不把调用方传来的
 * 字符串直接拼进路径 —— `../` 与绝对路径在第一步就出局（版本列表里不会有它们）。
 */
function safeLogVersionPath(id: string, file: string): string | null {
  const safe = String(id || '')
  const name = String(file || '')
  if (!safe || !name || path.basename(name) !== name) return null
  if (!listLogVersions(safe).some(v => v.file === name)) return null
  return path.join(logBackupDir(), name)
}

/** 读某一版的历史内容（预览用；零写入）。 */
export function getLogVersion(id: string, file: string): { ok: boolean; data?: LogVersionDetail; error?: string } {
  const versionPath = safeLogVersionPath(id, file)
  if (!versionPath) return { ok: false, error: '版本不存在，或文件名不合法' }
  const parsed = parseLogFile(versionPath)
  if (!parsed) return { ok: false, error: '这一版结构异常（不是合法日志），无法预览' }
  const meta = listLogVersions(id).find(v => v.file === file)!
  return {
    ok: true,
    data: {
      file: meta.file,
      at: meta.at,
      size: meta.size,
      title: parsed.title,
      status: parsed.status,
      content: parsed.content,
      nextSteps: parsed.nextSteps,
    },
  }
}

/**
 * 恢复到**指定**历史版本（2026-10-18 卡 001：从"只能退一步"扩到"能挑版本"）。
 *
 * - 恢复前 `atomicallyWrite` 会先把**当前版**备份一次 —— 撤错了还能再撤回来（互为反悔）；
 * - 结构校验：不是合法日志、或 frontmatter 里的 id 对不上，一律中止，绝不写半截文件；
 * - 生命周期字段（status/completed/retain_until）随所选版本一起回去，符合"恢复版本"的直觉。
 */
export function restoreLogVersion(id: string, file: string): { ok: boolean; data?: { at: string; title: string }; error?: string } {
  const safe = String(id || '')
  const filePath = path.join(getLogsDir(), `${safe}.md`)
  if (!safe || !fs.existsSync(filePath)) return { ok: false, error: '日志不存在' }
  const versionPath = safeLogVersionPath(safe, file)
  if (!versionPath) return { ok: false, error: '版本不存在，或文件名不合法' }
  let text = ''
  try {
    text = fs.readFileSync(versionPath, 'utf-8')
  } catch (e: any) {
    return { ok: false, error: `读取版本失败：${e?.message || e}` }
  }
  if (!/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(text)) {
    return { ok: false, error: '这一版结构异常（不是合法日志），已中止，未改动当前文件' }
  }
  const parsed = parseLogFile(versionPath)
  if (!parsed || parsed.id !== safe) {
    return { ok: false, error: '这一版的 id 与当前日志对不上，已中止，未改动当前文件' }
  }
  try {
    atomicallyWrite(filePath, text)
  } catch (e: any) {
    return { ok: false, error: `写回失败：${e?.message || e}` }
  }
  const back = parseLogFile(filePath)
  if (!back) return { ok: false, error: '写回后解析失败 —— 请立即用整包备份恢复，别再保存' }
  return { ok: true, data: { at: versionAtFromName(file, `${safe}.md.`), title: back.title } }
}

/**
 * 撤回上一次保存：用 `.backup` 里最新的一版覆盖当前文件。
 * 语义不变（2026-10-18 第 1 条），实现收口到 `restoreLogVersion`，避免两套恢复逻辑。
 */
export function restorePreviousLogVersion(id: string): { ok: boolean; data?: { at: string; title: string }; error?: string } {
  const versions = listLogVersions(String(id || ''))
  if (!versions.length) {
    return { ok: false, error: '没有可撤回的版本：本机只留最近 10 版，更早的要靠整包备份' }
  }
  return restoreLogVersion(id, versions[0].file)
}

/**
 * 置顶 / 取消置顶（2026-09-26 卡 037）。
 *
 * 置顶是视图属性，与 active/completed/archived 生命周期正交 —— 已归档的日志也该能被钉住
 * （用户原话：「正在修的东西钉在上面」）。写入走同一条 atomicallyWrite（先备份再原子改名），
 * 不新增第二条写路径。
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
 * 改项目归属（卡 037 右键菜单：「不进编辑页，顺手改」）—— 归类属性，不是内容编辑，
 * 所以不落 `edited` 戳（否则「✎ 改过」天天亮着，等于没信息）。
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
  entry.agentDone = false // 已签字，AI 的「等你确认」标记自然消失
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
  entry.agentDone = false
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
  entry.agentDone = false
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
  // 重新开跑 = 撤回上一次收口请求（不然卡上会同时写「进行中」和「等你确认」）
  if (on) entry.agentDone = false
  entry.running = on
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry }
}

/**
 * 主日志 + 附属日志（2026-10-30 暮雨第 4 条）。
 *
 * 关系的唯一事实来源是**主日志的 `attached` 数组**：副日志文件里不写反向指针，
 * 所以不存在"两边不一致"。下面三个动作都只走这一份数据。
 */

/** 组内全部**真实存在**的日志 id（主日志在第一位；断掉的引用自动忽略）。 */
export function logGroupIds(mainId: string): string[] {
  const main = getLog(String(mainId || '').trim())
  if (!main) return []
  const all = new Map(listLogs().map((l) => [l.id, l]))
  const out = [main.id]
  for (const id of main.attached || []) {
    if (id && id !== main.id && all.has(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * 绑定 / 解绑附属日志（只写主日志）。返回**更新后**的主日志。
 *
 * 校验（错就整批拒绝，不写半条）：
 *   · 主日志必须存在；不能把自己绑成自己的附属；
 *   · 目标日志必须存在；
 *   · 目标自己不能是另一个组的主日志（不支持嵌套）；
 *   · 目标不能已经属于别的组（一个副日志只归一个主日志）；
 *   · 最多 20 条（再多就不像"同一轮并行通道"了）。
 */
export function setLogAttached(mainId: string, ids: string[]): { ok: boolean; data?: LogEntry; error?: string } {
  const id = String(mainId || '').trim()
  const main = getLog(id)
  if (!main) return { ok: false, error: '主日志不存在' }
  const want: string[] = []
  for (const raw of Array.isArray(ids) ? ids : []) {
    const x = String(raw || '').trim()
    if (!x || x === id || want.includes(x)) continue
    want.push(x)
  }
  if (want.length > 20) return { ok: false, error: '一个主日志最多带 20 条附属日志' }
  const all = listLogs()
  const byId = new Map(all.map((l) => [l.id, l]))
  const ownerOfMain = all.find((l) => l.id !== id && (l.attached || []).includes(id))
  if (ownerOfMain) return { ok: false, error: `这条本身是「${ownerOfMain.title || ownerOfMain.id}」的附属，不能反过来当主日志` }
  for (const x of want) {
    const t = byId.get(x)
    if (!t) return { ok: false, error: `附属日志不存在：${x}` }
    if ((t.attached || []).length) return { ok: false, error: `「${t.title || x}」自己也是主日志，不能再当附属` }
    const owner = all.find((l) => l.id !== id && (l.attached || []).includes(x))
    if (owner) return { ok: false, error: `「${t.title || x}」已经属于「${owner.title || owner.id}」` }
  }
  main.attached = want
  atomicallyWrite(path.join(getLogsDir(), `${id}.md`), renderLog(main))
  return { ok: true, data: main }
}

/** 一键全进行中 / 全部撤销（只动 **待处理/进行中** 的成员；已完成/已归档不悄悄拉回来）。 */
export function setLogGroupRunning(mainId: string, running: boolean): {
  ok: boolean
  changed: string[]
  skipped: string[]
  error?: string
} {
  const ids = logGroupIds(mainId)
  if (!ids.length) return { ok: false, changed: [], skipped: [], error: '主日志不存在' }
  const on = !!running
  const changed: string[] = []
  const skipped: string[] = []
  for (const id of ids) {
    const entry = getLog(id)
    if (!entry) { skipped.push(id); continue }
    if (entry.status !== 'active') { skipped.push(id); continue }
    if (!!entry.running === on) { skipped.push(id); continue }
    entry.running = on
    if (on) entry.agentDone = false
    atomicallyWrite(path.join(getLogsDir(), `${id}.md`), renderLog(entry))
    changed.push(id)
  }
  return { ok: true, changed, skipped }
}

/** 一键全完成（跳过已完成/已归档；保留天数与备注按主日志这一次的填写套到全组）。 */
export function completeLogGroup(mainId: string, retainDays: number | null, note?: string): {
  ok: boolean
  changed: string[]
  skipped: string[]
  error?: string
} {
  const ids = logGroupIds(mainId)
  if (!ids.length) return { ok: false, changed: [], skipped: [], error: '主日志不存在' }
  const changed: string[] = []
  const skipped: string[] = []
  for (const id of ids) {
    const entry = getLog(id)
    if (!entry) { skipped.push(id); continue }
    if (entry.status === 'completed' || entry.status === 'archived') { skipped.push(id); continue }
    const r = completeLog(id, retainDays, note)
    if (r.ok) changed.push(id)
    else skipped.push(id)
  }
  return { ok: true, changed, skipped }
}

/**
 * AI 申请收口（2026-10-30 用户拍板）—— **只标记，不签字**。
 *
 * agent 唯一能做的「结束」动作：在 active 日志上打 `agent_done`，界面卡上显示
 * 「⏳ 等你确认」+「✅ 确认完成」。真正变 completed/archived 只能由用户点。
 * 对已完成的日志再请求收口 = ok（幂等），但不会把状态改回去。
 *
 * ⚠ 2026-10-30 暮雨第 1/6 条（真事故）：本函数以前顺手写了 `entry.running = false`。
 * 后果是用户手动标好的「进行中」在 agent 申请收口的那一刻**无声消失**，卡面变回
 * 「待处理 / 等你确认」—— 用户再回来根本分不清这条到底派出去没有。
 * 现在收紧成一条硬规矩：**「进行中」只有 `setLogRunning` 能改，任何 agent 侧路径
 * 都不许碰它**（申请收口、撤回收口都不行）。`agent_done` 是「我说完了」，
 * `running` 是「人已经派出去了」，两件事互相独立。
 */
export function requestLogClose(id: string): { ok: boolean; data?: LogEntry; error?: string } {
  const filePath = path.join(getLogsDir(), `${id}.md`)
  const entry = parseLogFile(filePath)
  if (!entry) return { ok: false, error: '日志不存在' }
  if (entry.agentDone) return { ok: true, data: entry }
  if (entry.status !== 'active') return { ok: true, data: entry }
  // 2026-10-30 暮雨第二次追问（截图：卡片同时写「待处理」和「等你确认」）：
  // 「我根本不知道这玩意到底派没派。」
  // 根因是 agent 可以在**没标进行中**的日志上申请收口 —— 卡片就成了
  // 「待处理（=没派出去）」+「等你确认（=AI 说做完了）」自相矛盾。
  // 现在收紧：**只有你手动标了「进行中」（= 派给 AI）的日志，AI 才能申请收口。**
  // 没派出去的日志，AI 只能把内容写好，完成与否由你决定。
  if (!entry.running) {
    return {
      ok: false,
      error: '这条日志还没标「进行中」（= 还没派出去），不能申请收口。先由你在卡上点「▶ 标为进行中」，或直接点「完成」。',
    }
  }
  entry.agentDone = true
  // 不碰 entry.running —— 见上面的 2026-10-30 事故说明
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry }
}

/** 撤回「申请收口」（agent 继续干活时用；界面不提供这个动作，用户直接完成即可）。 */
export function cancelLogClose(id: string): { ok: boolean; data?: LogEntry; error?: string } {
  const filePath = path.join(getLogsDir(), `${id}.md`)
  const entry = parseLogFile(filePath)
  if (!entry) return { ok: false, error: '日志不存在' }
  if (!entry.agentDone) return { ok: true, data: entry }
  entry.agentDone = false
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry }
}

export function destroyLog(id: string): { ok: boolean; error?: string } {
  const filePath = path.join(getLogsDir(), `${id}.md`)
  if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在' }
  fs.unlinkSync(filePath)
  // 2026-10-30：销毁一条副日志后，主日志的 attached 里不能留断链 ——
  // 界面上会显示一个点不开的「附属」，用户以为是 bug。顺手清掉引用（只改主日志）。
  try {
    for (const main of listLogs()) {
      if (!(main.attached || []).includes(id)) continue
      main.attached = (main.attached || []).filter((x) => x !== id)
      atomicallyWrite(path.join(getLogsDir(), `${main.id}.md`), renderLog(main))
    }
  } catch { /* 清理引用失败不影响日志已删这个事实 */ }
  return { ok: true }
}

/**
 * 日志状态快照 / 还原（2026-10-30 暮雨第 5 条：撤销要**真的回到点之前那一格**）。
 *
 * 为什么不用「撤销完成 = reopen」那套：reopen 只会退回「待处理」，把用户手动标的
 * 「进行中」、保留天数、完成时间全抹掉 —— 那不是撤销，是另一种改动。
 * 这里只做一件事：把一组白名单字段原样写回（历史文件不多字段，空值不落盘）。
 */
export interface LogStateSnapshot {
  status: 'active' | 'completed' | 'archived'
  running?: boolean
  agentDone?: boolean
  completed?: string | null
  retainDays?: number | null
  retainUntil?: string | null
  note?: string
  archiveNote?: string
}

/** 读一条日志的当前状态（撤销栈在动作前拍快照用；不写盘）。 */
export function logStateSnapshot(id: string): LogStateSnapshot | null {
  const entry = parseLogFile(path.join(getLogsDir(), `${id}.md`))
  if (!entry) return null
  return {
    status: entry.status,
    running: !!entry.running,
    agentDone: !!entry.agentDone,
    completed: entry.completed ?? null,
    retainDays: entry.retainDays ?? null,
    retainUntil: entry.retainUntil ?? null,
    note: entry.note ?? '',
    archiveNote: entry.archiveNote ?? '',
  }
}

/** 把快照写回（撤销用）。只认白名单里的键，状态非法直接拒绝。 */
export function restoreLogState(id: string, snap: LogStateSnapshot): { ok: boolean; data?: LogEntry; error?: string } {
  const filePath = path.join(getLogsDir(), `${id}.md`)
  const entry = parseLogFile(filePath)
  if (!entry) return { ok: false, error: '日志不存在' }
  const s = snap || ({} as LogStateSnapshot)
  const status = String(s.status || '')
  if (status !== 'active' && status !== 'completed' && status !== 'archived') {
    return { ok: false, error: `快照里的状态不合法：${status || '(空)'}` }
  }
  entry.status = status
  entry.running = !!s.running
  entry.agentDone = !!s.agentDone
  entry.completed = s.completed ? String(s.completed) : null
  const rdRaw = s.retainDays
  entry.retainDays = (rdRaw === null || rdRaw === undefined || rdRaw === ('' as any))
    ? null
    : (Number.isFinite(Number(rdRaw)) ? Number(rdRaw) : null)
  entry.retainUntil = s.retainUntil ? String(s.retainUntil) : null
  entry.note = s.note ? String(s.note) : undefined
  entry.archiveNote = s.archiveNote ? String(s.archiveNote) : undefined
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry }
}

/** 「清理归档」的返回形状（2026-10-13 暮雨第 2 条）。 */
export interface PurgeArchivedResult {
  ok: boolean
  dryRun: boolean
  /** 命中 / 已移走的条数 */
  count: number
  ids: string[]
  titles: string[]
  /** 非 dryRun 时的落点（可恢复），dryRun 时为空 */
  trashDir?: string
  error?: string
}

/**
 * 按日期批量清理「已归档」日志（2026-10-13 暮雨第 2 条）。
 *
 * 为什么不是 `destroyLog` 循环：那是 `fs.unlinkSync` **硬删**，一次几十条不可逆。
 * 这里**移动到 `<logsDir>/.trash/`**（与任务侧 `task-data/.trash` 同款心智）——
 * 符合项目红线「破坏性操作先快照」。用户原话要的是「一键删除 XX 日前归档日志」，
 * 但附了「怎么批量删除」，所以给的是**可恢复**的那种删。
 *
 * 判据（三条缺一不可）：① `status === 'archived'` ② 有日期 ③ 日期 **严格早于** beforeDate。
 * 「早于 XX 日」= XX 日当天的**不删**（边界取开区间，宁可少删不可多删）。
 *
 * `dryRun: true` 只报命中、**不落盘**（界面必须先预览再确认）。
 *
 * ⚠ `.trash` 是**目录**：`listLogs` / `cleanupLogs` 都按 `fn.endsWith('.md')` 过滤，
 * 目录名不含 `.md` → 天然扫不到，回收站里的日志不会又冒回列表。
 */
export function purgeArchivedBefore(beforeDate: string, opts: { dryRun?: boolean } = {}): PurgeArchivedResult {
  const dryRun = !!opts.dryRun
  const date = String(beforeDate || '').trim().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, dryRun, count: 0, ids: [], titles: [], error: '日期格式应为 YYYY-MM-DD' }
  }
  const dir = getLogsDir()
  const hits: { id: string; title: string; file: string }[] = []
  for (const fn of fs.readdirSync(dir)) {
    if (!fn.endsWith('.md')) continue
    const entry = parseLogFile(path.join(dir, fn))
    if (!entry) continue
    if (entry.status !== 'archived') continue
    const d = (entry.logDate || entry.created || '').slice(0, 10)
    if (!d || d >= date) continue
    hits.push({ id: entry.id, title: entry.title, file: fn })
  }
  hits.sort((a, b) => a.id.localeCompare(b.id))
  if (dryRun) {
    return { ok: true, dryRun: true, count: hits.length, ids: hits.map(h => h.id), titles: hits.map(h => h.title) }
  }
  if (!hits.length) return { ok: true, dryRun: false, count: 0, ids: [], titles: [] }
  const trashDir = path.join(dir, '.trash')
  fs.mkdirSync(trashDir, { recursive: true })
  const moved: string[] = []
  const movedTitles: string[] = []
  const errors: string[] = []
  for (const h of hits) {
    const src = path.join(dir, h.file)
    let dest = path.join(trashDir, h.file)
    // 同名兜底：日志 id 唯一，正常不会撞；撞了也绝不覆盖回收站里旧的那份
    if (fs.existsSync(dest)) dest = path.join(trashDir, `${h.id}.${Date.now()}.md`)
    try {
      fs.renameSync(src, dest)
      moved.push(h.id)
      movedTitles.push(h.title)
    } catch (e: any) {
      errors.push(`${h.id}: ${e?.message || String(e)}`)
    }
  }
  return {
    ok: errors.length === 0,
    dryRun: false,
    count: moved.length,
    ids: moved,
    titles: movedTitles,
    trashDir,
    error: errors.length ? errors.join('; ') : undefined,
  }
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

/**
 * 多条日志 → 一份开工单（2026-10-29 暮雨第 6 条：「某条主日志带多条副日志一起灌入开工单」）。
 *
 * ids 的**顺序就是语义**：第一条是主日志，其余标成「并行日志」。
 * 为什么要标：真实用法里它们是同一轮的另一条通道（比如并行会话的进度通知），
 * 不标清楚，agent 会当成同一条日志的续写（`continuesFrom` 才表示续写）。
 *
 * 为什么放在这里而不是 MCP：界面侧「多选 → 开工单」和 MCP `inject_logs` 必须是**同一份文本**，
 * 两处各拼一次就会分叉（一处改了文案，另一处没跟上）。
 */
export function injectLogs(ids: string[]): { text: string; found: string[]; missing: string[] } {
  const parts: string[] = []
  const found: string[] = []
  const missing: string[] = []
  let n = 0
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw || '').trim()
    if (!id) continue
    const text = injectLog(id)
    if (!text) { missing.push(id); continue }
    n++
    found.push(id)
    const entry = getLog(id)
    // 换行一律用 fromCharCode(10)：这个文件被脚本改过多次，反斜杠转义在写回时会被吃掉
    const nl = String.fromCharCode(10)
    const head = n === 1
      ? ''
      : nl + nl + '---' + nl + nl
        + '> 以下是并行日志（同一轮的另一条通道，' + (entry?.created || '') + '）' + nl
    parts.push(head + text)
  }
  const tail = missing.length
    ? String.fromCharCode(10) + String.fromCharCode(10) + '（未找到：' + missing.join(', ') + '）'
    : ''
  return { text: parts.join(String.fromCharCode(10)) + tail, found, missing }
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
 *//**
 * 「从内存字节挂附件」允许的类型（粘贴图片 / 拖文件进弹窗，2026-10-25 暮雨第 4 / 7 条）。
 *
 * ⚠ 这是**反向表**（mime → 扩展名），和上面的 `ATTACH_MIME`（扩展名 → mime）是两回事：
 *   那条路收的是本机文件、扩展名已知；这条路收的是浏览器给的 mime，只能反过来推扩展名。
 *
 * 覆盖范围 = 常见「截图 / 报告 / 日志 / 表格 / 压缩包」。
 * **不收**可执行文件（exe/msi/bat/dll）—— 不是限制用户，是这类东西挂进日志没意义且迟早出事；
 * 真要挂，走「＋ 添加文件…」（本机路径复制，不经这条内存通道）。
 */
const ATTACH_EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/bmp': '.bmp', 'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv', 'text/html': '.html',
  'application/json': '.json',
  'application/zip': '.zip',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
}

/** 单条「从内存挂」的上限（解码后字节）。20MB 够放整屏截图与普通报告；
 *  再大就不该走这条路 —— base64 还要再涨三分之一，白占内存。 */
const MAX_PASTE_BYTES = 20 * 1024 * 1024

/**
 * 从**内存里的 data URL** 落盘并挂到日志上
 * （2026-10-25 暮雨第 4 / 7 条：粘贴图片 + 拖文件进弹窗）。
 *
 * 为什么必须新增这条路：现有 `addAttachments` 的输入是**本机文件路径**，
 * 而剪贴板里的图片、拖进弹窗的 File 都只有 blob（Chromium 不给路径；
 * Electron 44 起 `File.path` 也已移除，preload 的 `webUtils.getPathForFile`
 * 又拿不到跨 world 的 File 对象）→ 只能把字节送进主进程再写盘。
 *
 * 安全边界（这条通道收的是渲染层来的任意字节，必须自己把关）：
 *   ① mime 白名单（`ATTACH_EXT_BY_MIME`）—— 扩展名按 **mime 推导**，不信客户端给的文件名；
 *   ② 解码后大小上限 `MAX_PASTE_BYTES`；
 *   ③ 文件名过 `safeAttachName`（去路径穿越 / 去逗号引号 —— 两个解析器都要吃这个名字）；
 *   ④ logId 必须真的存在（不存在就不落盘，不造孤立目录）；
 *   ⑤ 只写 `_attachments/<logId>/` 下。
 *
 * 部分失败**逐条记账**返回 `skipped`，不静默丢弃。
 */
export function addAttachmentsFromData(
  logId: string,
  items: Array<{ name?: string; dataUrl: string }>,
): { ok: boolean; data?: LogEntry; error?: string; added?: number; skipped?: string[] } {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return { ok: false, error: '没有要添加的内容' }

  const dir = getLogsDir()
  const filePath = path.join(dir, `${logId}.md`)
  const entry = parseLogFile(filePath)
  if (!entry) return { ok: false, error: '日志不存在' }

  const destDir = attachmentsDir(logId)
  const added: string[] = []
  const skipped: string[] = []

  for (const it of list) {
    const label = String(it?.name || '粘贴的图片')
    const m = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i.exec(String(it?.dataUrl || '').trim())
    if (!m) { skipped.push(`${label}：不是合法的 data URL`); continue }
    const mime = m[1].toLowerCase()
    const ext = ATTACH_EXT_BY_MIME[mime]
    if (!ext) {
      // 说清"为什么不收"和"那该怎么办"—— 用户拖了个不认识的文件时，不该只看到一句「不支持」。
      skipped.push(`${label}：类型 ${mime} 不收（只收图片/PDF/文本/Markdown/CSV/JSON/ZIP/Office 文档）；` +
        `这类文件请用「＋ 添加文件…」按本机路径挂（那条路不限类型、也不受 20MB 限制）`)
      continue
    }
    let buf: Buffer
    try {
      buf = Buffer.from(m[2], 'base64')
    } catch {
      skipped.push(`${label}：base64 解码失败`); continue
    }
    if (!buf.length) { skipped.push(`${label}：内容是空的`); continue }
    if (buf.length > MAX_PASTE_BYTES) {
      skipped.push(`${label}：${(buf.length / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_PASTE_BYTES / 1024 / 1024}MB —— ` +
        `大文件请用「＋ 添加文件…」（按本机路径复制，不受这个上限限制）`)
      continue
    }
    try {
      fs.mkdirSync(destDir, { recursive: true })
      // 名字：清洗后**把扩展名换成 mime 推导的那个** —— 客户端可能叫 `image.png` 而内容是 jpeg，
      // 按内容落盘才不会出现「后缀骗人、预览打不开」。
      const stem = safeAttachName(path.basename(label, path.extname(label)))
      let name = `${stem}${ext}`
      let dest = path.join(destDir, name)
      let n = 1
      while (fs.existsSync(dest)) {
        name = `${stem} (${n})${ext}`
        dest = path.join(destDir, name)
        n++
      }
      fs.writeFileSync(dest, buf)
      added.push(toRelPosix(dest))
    } catch (e: any) {
      skipped.push(`${label}：写入失败（${e?.message || e}）`)
    }
  }

  if (!added.length) {
    return { ok: false, error: `一张都没加上：${skipped.join('；') || '未知原因'}`, skipped }
  }
  entry.attachments = Array.from(new Set([...(entry.attachments || []), ...added]))
  atomicallyWrite(filePath, renderLog(entry))
  return { ok: true, data: entry, added: added.length, skipped }
}

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
