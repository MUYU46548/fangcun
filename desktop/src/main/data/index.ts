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

  // ── 用户显式指定的数据目录优先（2026-09-22 数据分裂事故）─────────
  // 背景：安装版探测链（cwd → 父目录 → exeDir → userData）在安装目录与仓库
  // 无父子关系时必然回退 userData，与 dev 会话 / Python CLI / Hermes agent
  // 使用的仓库根分叉 —— 用户在两边各写各的数据，表现为「数据丢了」。
  // 修复：设置里切换过数据目录后，把选择持久化到 userData/data-dir.json，
  // 启动时优先读取。探测链只作为首次启动的默认值。
  const dataDirConfigPath = path.join(userData, 'data-dir.json')
  try {
    if (fs.existsSync(dataDirConfigPath)) {
      const cfg = JSON.parse(fs.readFileSync(dataDirConfigPath, 'utf-8'))
      const saved = String(cfg?.dir || '').trim()
      if (saved && fs.existsSync(path.join(saved, 'registry.yaml'))) {
        DATA_DIR = saved
        TASK_DIR = path.join(DATA_DIR, 'task-data')
        REGISTRY_PATH = path.join(DATA_DIR, 'registry.yaml')
        BACKUP_DIR = path.join(DATA_DIR, 'backups')
        ACTIVITY_LOG = path.join(TASK_DIR, '.activity.log')
        fs.mkdirSync(TASK_DIR, { recursive: true })
        fs.mkdirSync(BACKUP_DIR, { recursive: true })
        invalidateTaskCache()
        return
      }
    }
  } catch { /* 配置损坏则回退探测链，不炸启动 */ }

  // Priority: cwd (dev) → parent dirs (monorepo) → exeDir (portable) → userData (installed)
  // Walk up from cwd to find registry.yaml or task-data (monorepo: desktop/ → project root)
  //
  // ⚠ task-data 必须用 lstat 判定为「真实目录」，不能跟随链接。
  // 原因（2026-09-22 定位）：dev 态 desktop/task-data 是指向项目根真身的 junction，
  // 若把"存在 task-data"当作数据根标志，探测会在 desktop/ 这一层就命中 →
  // DATA_DIR 锁死在 desktop/：registry.yaml 找不到，notifications/todos/policies/
  // backups 全落到 desktop/ 下，Electron 与 CLI 的数据根分叉。
  const looksLikeDataRoot = (dir: string): boolean => {
    if (!dir) return false
    if (fs.existsSync(path.join(dir, 'registry.yaml'))) return true
    try {
      return fs.lstatSync(path.join(dir, 'task-data')).isDirectory() // lstat 不跟随链接
    } catch {
      return false
    }
  }

  let baseDir: string
  let searchDir = cwd
  let found = false
  for (let i = 0; i < 5; i++) {
    if (looksLikeDataRoot(searchDir)) {
      baseDir = searchDir
      found = true
      break
    }
    const parent = path.dirname(searchDir)
    if (parent === searchDir) break
    searchDir = parent
  }
  if (!found) {
    // 打包/便携态：exe 同级有数据根标记就用 exe 目录，否则落到 userData
    baseDir = looksLikeDataRoot(exeDir) ? exeDir : userData
  }

  DATA_DIR = baseDir
  TASK_DIR = path.join(DATA_DIR, 'task-data')
  REGISTRY_PATH = path.join(DATA_DIR, 'registry.yaml')
  BACKUP_DIR = path.join(DATA_DIR, 'backups')
  ACTIVITY_LOG = path.join(TASK_DIR, '.activity.log')

  fs.mkdirSync(TASK_DIR, { recursive: true })
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  invalidateTaskCache()
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
  invalidateTaskCache()
  // 持久化用户选择（2026-09-22）：否则重启后又回到探测默认值，
  // 用户表现为「切了目录但数据又丢了」。写失败不炸（下次启动回退探测链）。
  try {
    const cfgPath = path.join(app.getPath('userData'), 'data-dir.json')
    const tmp = cfgPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ dir: newDir, savedAt: new Date().toISOString() }, null, 2), 'utf-8')
    fs.renameSync(tmp, cfgPath)
  } catch { /* 持久化失败不影响本次会话 */ }
}

export function getDataDir(): string { return DATA_DIR }
export function isFirstRun(): boolean {
  return !fs.existsSync(REGISTRY_PATH) && !fs.existsSync(path.join(TASK_DIR, '..', 'registry.yaml'))
}

// ── 数据目录搬迁 ─────────────────────────────────────────────────────────

/** 搬迁纳入的顶层内容。.trash / .backup / backups 属本地缓存与回收站，不随迁。 */
export const MIGRATABLE_ENTRIES = ['task-data', 'registry.yaml', 'docs'] as const

export interface DataDirInspection {
  dir: string
  exists: boolean
  hasRegistry: boolean
  hasTaskData: boolean
  hasDocs: boolean
  taskCount: number
  archivedCount: number
  /** 既无 registry.yaml 也无 task-data —— 可以安全迁入 */
  empty: boolean
  isCurrent: boolean
  /** 目标位于当前目录内部（会把数据复制进自己里面） */
  insideCurrent: boolean
  /** 当前目录位于目标内部（迁移后新旧数据混在一起） */
  containsCurrent: boolean
}

function countTaskFiles(dir: string): { total: number; archived: number } {
  let total = 0
  let archived = 0
  if (!fs.existsSync(dir)) return { total, archived }
  const walk = (d: string, inArchive: boolean) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === '.trash' || e.name === '.backup') continue
        walk(p, inArchive || e.name === 'archive')
      } else if (e.name.endsWith('.md') && !e.name.startsWith('_')) {
        total++
        if (inArchive) archived++
      }
    }
  }
  walk(dir, false)
  return { total, archived }
}

/** 只读体检：判断一个目录能不能作为数据目录迁入，不做任何写入 */
export function inspectDataDir(dir: string): DataDirInspection {
  const target = path.resolve(dir)
  const current = DATA_DIR ? path.resolve(DATA_DIR) : ''
  const hasRegistry = fs.existsSync(path.join(target, 'registry.yaml'))
  const hasTaskData = fs.existsSync(path.join(target, 'task-data'))
  const counts = countTaskFiles(path.join(target, 'task-data'))

  const isInside = (parent: string, child: string): boolean => {
    if (!parent || !child || parent === child) return false
    const rel = path.relative(parent, child)
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  return {
    dir: target,
    exists: fs.existsSync(target),
    hasRegistry,
    hasTaskData,
    hasDocs: fs.existsSync(path.join(target, 'docs')),
    taskCount: counts.total,
    archivedCount: counts.archived,
    empty: !hasRegistry && !hasTaskData,
    isCurrent: !!current && target === current,
    insideCurrent: isInside(current, target),
    containsCurrent: isInside(target, current),
  }
}

export interface MigrateResult {
  ok: boolean
  from: string
  to: string
  copiedFiles: number
  copiedBytes: number
  copiedEntries: string[]
  skipped: string[]
  errors: string[]
}

function copyTree(src: string, dest: string, stats: { files: number; bytes: number }): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.trash' || e.name === '.backup') continue
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    if (e.isDirectory()) {
      copyTree(s, d, stats)
    } else if (e.isFile()) {
      fs.copyFileSync(s, d)
      stats.files++
      try {
        stats.bytes += fs.statSync(d).size
      } catch { /* 统计失败不影响复制 */ }
    }
  }
}

/**
 * 把当前数据目录内容**复制**到 targetDir。
 *
 * 只复制：不删源、不切指针 —— 备份与切换由调用方编排。
 * 用复制而非移动：源目录原样保留，出错时用户的数据还在，符合"破坏性操作先快照"的纪律。
 */
export function migrateDataDir(targetDir: string, opts: { allowExisting?: boolean } = {}): MigrateResult {
  const from = DATA_DIR
  const to = path.resolve(targetDir)
  const result: MigrateResult = {
    ok: false, from, to,
    copiedFiles: 0, copiedBytes: 0,
    copiedEntries: [], skipped: [], errors: [],
  }

  if (!from) {
    result.errors.push('当前数据目录未初始化')
    return result
  }
  if (to === path.resolve(from)) {
    result.errors.push('目标目录与当前数据目录相同')
    return result
  }
  const rel = path.relative(path.resolve(from), to)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    result.errors.push('目标目录位于当前数据目录内部，不能迁入')
    return result
  }

  const existing = fs.existsSync(path.join(to, 'registry.yaml')) || fs.existsSync(path.join(to, 'task-data'))
  if (existing && !opts.allowExisting) {
    result.errors.push('目标目录已存在方寸数据（registry.yaml 或 task-data），需显式确认才能覆盖式迁入')
    return result
  }

  try {
    fs.mkdirSync(to, { recursive: true })
    const stats = { files: 0, bytes: 0 }
    for (const entry of MIGRATABLE_ENTRIES) {
      const src = path.join(from, entry)
      if (!fs.existsSync(src)) {
        result.skipped.push(entry)
        continue
      }
      const dest = path.join(to, entry)
      if (fs.statSync(src).isDirectory()) {
        copyTree(src, dest, stats)
      } else {
        fs.copyFileSync(src, dest)
        stats.files++
        try {
          stats.bytes += fs.statSync(dest).size
        } catch { /* ignore */ }
      }
      result.copiedEntries.push(entry)
    }
    result.copiedFiles = stats.files
    result.copiedBytes = stats.bytes
    result.ok = result.errors.length === 0
  } catch (e) {
    result.errors.push(`复制失败：${(e as Error).message}`)
  }
  return result
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

// ── Priority Enum ───────────────────────────────────────────────────────

/**
 * 优先级取值。与 Python CLI（tegula/core.py parse_quick_add）及全部历史任务文件一致，用中文。
 * 不要在这里引入英文枚举 —— 曾经桌面版新建写 'normal'，导致看板按优先级分组时
 * 中文任务与英文任务分到两组，是明确的数据不一致。
 */
export const PRIORITIES = ['高', '中', '低'] as const
export type Priority = typeof PRIORITIES[number]

/** 历史别名 → 中文。MCP 工具文档、旧版桌面代码都写过英文值。 */
const PRIORITY_ALIASES: Record<string, Priority> = {
  '高': '高', '中': '中', '低': '低',
  high: '高', medium: '中', normal: '中', low: '低',
  urgent: '高', critical: '高', highest: '高',
  p0: '高', p1: '中', p2: '低', p3: '低',
  h: '高', m: '中', l: '低',
}

/**
 * 归一优先级：能识别的别名一律转成 高/中/低；
 * 无法识别时**原样返回**（不丢用户手写的值），空值返回 ''。
 */
export function normalizePriority(v: unknown): string {
  if (v === undefined || v === null) return ''
  const s = String(v).trim()
  if (!s) return ''
  return PRIORITY_ALIASES[s.toLowerCase()] || s
}

export function isKnownPriority(v: unknown): boolean {
  return (PRIORITIES as readonly string[]).includes(normalizePriority(v))
}

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
  /**
   * 是否位于归档区（task-data/archive/）—— **由路径推导、由主进程统一盖章**。
   *
   * 归档的唯一权威定义是路径（见 AGENTS.md「归档视图语义铁律」）。此前渲染层拿
   * `t.archived` 画「📦 已归档」角标，而主进程从不赋这个字段 → 角标永远是假的；
   * 而 batchArchive 只改 status 不移动文件 → 造出「假归档」（用户 2026-09-25）。
   * 现在在 loadAllTasksRaw 里按路径盖一次章，角标 / 详情 / 归档视图三个消费方同源。
   */
  archived?: boolean
}

// ── Editable Field Specs ────────────────────────────────────────────────
//
// 新建 / 编辑表单的唯一事实来源。此前 openEdit 只读 6 个字段，导致
// assignee / deadline / batch / blockers / memo 没有任何编辑入口 ——
// 想改截止日期只能手改文件。新增字段时只改这里，表单自动跟随。

export interface TaskFieldSpec {
  key: string
  label: string
  type: 'text' | 'textarea' | 'select' | 'tags' | 'list' | 'date'
  options?: readonly string[]
  /** 选项来自运行时数据（目前仅 projects），渲染层负责填充 */
  optionsFrom?: 'projects'
  placeholder?: string
  hint?: string
  span: 'half' | 'full'
}

export const TASK_FIELD_SPECS: readonly TaskFieldSpec[] = [
  { key: 'title', label: '标题', type: 'text', span: 'full', placeholder: '一句话说清要做什么' },
  { key: 'project', label: '项目', type: 'select', span: 'half', optionsFrom: 'projects' },
  { key: 'status', label: '状态', type: 'select', span: 'half', options: STATUSES },
  { key: 'priority', label: '优先级', type: 'select', span: 'half', options: PRIORITIES },
  { key: 'assignee', label: '指派', type: 'text', span: 'half', placeholder: 'hermes / human / 暮雨' },
  // 2026-09-22（用户第 6 条）：日历要能"指派时间或时间段"。
  // 单日截止用 deadline；开始+截止构成时间段，日历上画成跨天横条。
  { key: 'start', label: '开始', type: 'text', span: 'half', placeholder: 'YYYY-MM-DD（可选）' },
  { key: 'deadline', label: '截止', type: 'text', span: 'half', placeholder: 'MM-DD 或 YYYY-MM-DD' },
  { key: 'batch', label: '批次', type: 'text', span: 'half', placeholder: '如 2026-Q3' },
  { key: 'tags', label: '标签', type: 'tags', span: 'full', placeholder: '逗号分隔，如 ui, bug' },
  { key: 'blockers', label: '阻塞', type: 'list', span: 'full', placeholder: '逗号分隔的任务 ID' },
  { key: 'memo', label: '附言', type: 'textarea', span: 'full', placeholder: '给执行者的一句提醒' },
  { key: 'body', label: '正文', type: 'textarea', span: 'full', placeholder: '支持 Markdown，- [ ] 为可勾选项' },
]

/** 除 body 外可由表单直接写入 frontmatter 的字段 */
export const EDITABLE_FM_KEYS = TASK_FIELD_SPECS
  .map(f => f.key)
  .filter(k => k !== 'body')

/** Task → 表单值。数组字段转成逗号串，便于在单行输入框里编辑。 */
export function taskToFormValues(task: Task | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const spec of TASK_FIELD_SPECS) {
    if (spec.key === 'body') {
      out.body = task?.body ?? ''
      continue
    }
    const v = task ? (task.fm as Record<string, unknown>)[spec.key] : undefined
    if (spec.type === 'tags' || spec.type === 'list') {
      out[spec.key] = Array.isArray(v) ? v.join(', ') : (v === undefined || v === null ? '' : String(v))
    } else {
      out[spec.key] = v === undefined || v === null ? '' : String(v)
    }
  }
  return out
}

/**
 * 表单值 → frontmatter 补丁。
 * 只处理 EDITABLE_FM_KEYS 内的键；未出现在 values 里的字段不动（不会误清空）。
 */
export function formValuesToPatch(values: Record<string, string>): Partial<TaskFrontmatter> {
  const patch: Record<string, unknown> = {}
  for (const spec of TASK_FIELD_SPECS) {
    if (spec.key === 'body') continue
    const raw = values[spec.key]
    if (raw === undefined) continue
    const s = String(raw).trim()

    if (spec.type === 'tags' || spec.type === 'list') {
      patch[spec.key] = s ? s.split(',').map(x => x.trim()).filter(Boolean) : []
    } else if (spec.key === 'priority') {
      patch.priority = normalizePriority(s) || '中'
    } else {
      patch[spec.key] = s
    }
  }
  return patch as Partial<TaskFrontmatter>
}

// ── YAML Parser (js-yaml) ──────────────────────────────────────────────

// Chinese → English field name mapping (Python tegula compat)
export const FIELD_MAP: Record<string, string> = {
  '标题': 'title',
  '项目': 'project',
  '状态': 'status',
  '批次': 'batch',
  // 「开始」与「截止」组成时间段（2026-09-22，用户第 6 条）。
  // Python 侧 MANAGED_KEYS 同步加入「开始」并在 render_task 里显式输出 ——
  // 否则桌面版写的时间段会被 Python 的 render_task 丢掉（受管键漏输出=静默丢字段）。
  '开始': 'start',
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
  // Python CLI（tegula/core.py MANAGED_KEYS）用中文键「标签」写 tags。
  // 漏掉这条映射会导致 Python 写的标签在桌面版读到 undefined —— 放在 'tags' 之后，
  // 保证 REVERSE_FIELD_MAP 反向映射回来是中文「标签」，与 Python 对齐。
  '标签': 'tags',
  'type': 'type',
  'plan_status': 'plan_status',
  '实际成本': 'actual_cost',
}

// English → Chinese field name mapping (for renderTask compat with Python CLI)
const REVERSE_FIELD_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_MAP).map(([zh, en]) => [en, zh])
)

// Preferred output order for frontmatter fields
const FM_ORDER = [
  'id', 'title', 'project', 'status', 'priority', 'assignee', 'tags',
  'created', 'updated', 'blockers', 'expected_update', 'batch', 'start', 'deadline',
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

export interface NewProjectFields {
  id: string
  name?: string
  repo?: string
  tasks?: string
  description?: string
}

/** YAML 标量安全序列化：含特殊字符时加引号，避免写出会被 yaml 误解析的值 */
function yamlScalar(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!s) return '""'
  if (/[:#[\]{},"'&*!|>%@`]/.test(s) || /^\s|\s$/.test(s)) return JSON.stringify(s)
  return s
}

/**
 * 往 registry.yaml 追加一个项目。
 *
 * 用「文本块追加」而不是 yaml.load + yaml.dump 重写：
 * registry.yaml 是给人手改的，顶部有大段说明注释、每行还有自定义中文字段，
 * dump 重写会把注释全部丢掉、字段顺序打乱。这里只在 projects 段落末尾插一段，
 * 其余内容逐字节保留。
 *
 * 写前自校验：新内容必须能解析、且项目数恰好 +1、且新 id 可见 —— 任一不满足就放弃写入。
 */
export function addProjectToRegistry(fields: NewProjectFields): { ok: boolean; error?: string } {
  const id = String(fields.id || '').trim()
  if (!id) return { ok: false, error: '项目 ID 不能为空' }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return { ok: false, error: '项目 ID 只能包含字母、数字、点、下划线和连字符' }
  }
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { ok: false, error: '找不到 registry.yaml' }
  }

  const content = fs.readFileSync(REGISTRY_PATH, 'utf-8')
  let parsed: any
  try {
    parsed = yaml.load(content)
  } catch (e) {
    return { ok: false, error: `registry.yaml 解析失败：${(e as Error).message}` }
  }
  const existing = Array.isArray(parsed?.projects) ? parsed.projects : []
  if (existing.some((p: any) => String(p?.id) === id)) {
    return { ok: false, error: `项目 ID「${id}」已存在` }
  }

  const lines = [
    `  - id: ${yamlScalar(id)}`,
    `    name: ${yamlScalar(fields.name || id)}`,
    `    tasks: ${yamlScalar(fields.tasks || '')}`,
    `    repo: ${yamlScalar(fields.repo || '')}`,
    `    tools: []`,
    `    sources: []`,
  ]
  if (fields.description && String(fields.description).trim()) {
    lines.push(`    说明: ${yamlScalar(fields.description)}`)
  }
  const block = lines.join('\n') + '\n'

  // 插到 released: 之前（若存在），否则追加到末尾
  const releasedIdx = content.search(/^released:\s*$/m)
  const next = releasedIdx >= 0
    ? content.slice(0, releasedIdx) + block + '\n' + content.slice(releasedIdx)
    : content.replace(/\s*$/, '\n') + block

  // 写前自校验 —— 宁可不写，也不破坏 registry.yaml
  try {
    const check = yaml.load(next) as any
    const after = Array.isArray(check?.projects) ? check.projects : []
    if (after.length !== existing.length + 1) {
      return { ok: false, error: '写入校验失败：项目数不符合预期，已放弃写入' }
    }
    if (!after.some((p: any) => String(p?.id) === id)) {
      return { ok: false, error: '写入校验失败：新项目未出现在解析结果中，已放弃写入' }
    }
  } catch (e) {
    return { ok: false, error: `写入内容无法解析，已放弃：${(e as Error).message}` }
  }

  atomicWrite(REGISTRY_PATH, next)
  logActivity('-', 'registry_add_project', id)
  return { ok: true }
}

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

  // 优先级别名归一：normal/high/low → 高/中/低，避免分组时被当成未知值
  if (fm.priority !== undefined) {
    fm.priority = normalizePriority(fm.priority)
  }
  
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

// ── 任务读取缓存（按目录签名失效） ──────────────────────────────────────
/**
 * 压测结论（2026-09-18，scripts/test/bench-load.cjs）：
 * 原先每次读取都全量 readdir + readFileSync + yaml.load，无任何缓存。
 * 一次页面刷新等价 15 次全量扫描（active + archive + blockers + getProjectProgress×项目数），
 * 500 任务 805ms、1000 任务 1.5s、5000 任务 18.4s。
 *
 * 这里按「目录签名」缓存解析结果：每次调用只做一次 readdir + stat
 * （5000 文件约 30ms，对照完整加载 914ms），签名未变就直接复用已解析的任务。
 *
 * 为什么用签名而不是时间 TTL：TTL 会把「别人刚写的改动」挡在缓存外，形成静默读到旧数据。
 * 签名覆盖 文件名 + size + mtime，外部工具（Python CLI）写入、手动编辑、增删文件
 * 都能被检测到；桌面版自己的写操作还会走 atomicWrite 主动失效，双重保险。
 */
export type ScanMode = 'active' | 'all'

interface TaskCache { sig: string; tasks: Task[]; errors: string[] }
const _taskCaches: Partial<Record<ScanMode, TaskCache>> = {}

/**
 * 文件头是否像任务文件（以 --- 或 === 开头）。
 * 用来把「文件本身就是坏的」和「本来就不是任务文件」（如 docs 性质的 md）
 * 区分开 —— 前者要报警，后者跳过是正确行为。
 */
function looksLikeTaskFile(p: string): boolean {
  try {
    const fd = fs.openSync(p, 'r')
    const buf = Buffer.alloc(8)
    const n = fs.readSync(fd, buf, 0, 8, 0)
    fs.closeSync(fd)
    const head = buf.subarray(0, n).toString('utf-8')
    return head.startsWith('---') || head.startsWith('===')
  } catch {
    return false
  }
}

/**
 * 解析失败的任务文件（相对 task-data 的路径）。
 *
 * 为什么要有这个：parseTask 遇严格 YAML 解析失败返回 null，loadTasks 直接跳过 ——
 * 2026-09-18 就真实发生过 6 个任务因为标题含 `: ` 而在桌面版隐身数月无人察觉。
 * 静默跳过是最大问题，这里把它显性化，交给界面提示。
 */
export function getParseErrors(): string[] {
  // 先确保缓存与磁盘一致：签名没变就是白捡（复用），变了会自动重扫。
  // 不能只读上次的缓存 —— 那会让「文件已修好」仍然显示报错。
  loadAllTasksRaw('all')
  return _taskCaches.all ? _taskCaches.all.errors : []
}

const ARCHIVE_SEG_RE = /[\\/]archive[\\/]/i

/** 清空任务读取缓存。写操作后调用；签名机制本身也能兜住外部改动。 */
export function invalidateTaskCache(): void {
  delete _taskCaches.active
  delete _taskCaches.all
}

/**
 * 扫描任务目录（带签名缓存）。
 * mode='active' 时不进入 archive 目录（连签名都不覆盖它）——归档区的变动
 * 不会白白让活跃视图缓存失效。
 */
export function loadAllTasksRaw(mode: ScanMode = 'all'): Task[] {
  if (!fs.existsSync(TASK_DIR)) return []

  const skipArchive = mode === 'active'
  const files: string[] = []
  let h = 0x811c9dc5
  let count = 0
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
  }

  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.backup' || entry.name === '.trash') continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skipArchive && entry.name === 'archive') continue
        mix('/' + entry.name + '/')
        walk(fullPath)
      } else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
        let st: fs.Stats
        try {
          st = fs.statSync(fullPath)
        } catch {
          continue
        }
        // 保留 mtimeMs 原始精度（NTFS 为 100ns）—— 同一毫秒内的重复写也能区分
        mix(entry.name + '|' + st.size + '|' + st.mtimeMs)
        files.push(fullPath)
        count++
      }
    }
  }

  walk(TASK_DIR)

  const sig = (h >>> 0).toString(36) + ':' + count
  const cached = _taskCaches[mode]
  if (cached && cached.sig === sig) return cached.tasks

  const tasks: Task[] = []
  const errors: string[] = []
  // 同一 id 在**同一区域**里出现多份文件（`x.md` 与 `x.2.md` 并存 —— 旧版归档/删除改名留下的），
  // 会让板子上出现两张一模一样的卡，而且删除代码按 `${id}.md` 精确找文件、找不到那份 →
  // 看得见但删不掉（用户 2026-09-24「驳回和完成依旧是删不掉的」的真因之一）。
  // 这里按「id + 区域」去重，规范名 `${id}.md` 优先；跨区域（活跃 vs 归档）不去重：
  // 归档视图按路径判定，合并显示时由渲染层负责去重（活跃区为准）。
  const byKey = new Map<string, Task>()
  const dup: string[] = []
  for (const f of files) {
    const task = parseTask(f)
    if (task) {
      // 归档与否 = 路径说了算（唯一权威定义，见 AGENTS.md 归档视图语义铁律）。
      // 在这里统一盖章，避免"状态标签 / 路径标签 / archived 字段"三套并存互相打架。
      if (ARCHIVE_SEG_RE.test(f)) task.archived = true
      const key = task.id + (task.archived ? '|arch' : '|act')
      const prev = byKey.get(key)
      if (!prev) {
        byKey.set(key, task)
      } else {
        dup.push(path.relative(TASK_DIR, f))
        const canonical = (t: Task) => path.basename(t.path) === `${t.id}.md`
        if (canonical(task) && !canonical(prev)) byKey.set(key, task)
      }
    } else if (looksLikeTaskFile(f)) {
      // 有 frontmatter 却解析不出来 = 文件真的坏了，不能静默跳过
      errors.push(path.relative(TASK_DIR, f))
    }
  }
  if (dup.length) {
    // 同一 id 的多余副本不是「解析失败」，但必须留痕（落应用日志）：
    // 用户遇到「删不掉/显示两遍」时要能追到原因。不塞进 errors —— 那会让顶栏弹
    // 一个写着「解析失败」的红条，语义不符。
    try {
      console.warn(`[tasks] 同一任务存在多份副本，已按规范名取一份：${dup.join(', ')}`)
    } catch { /* 日志永不抛 */ }
  }
  const deduped = [...byKey.values()]
  _taskCaches[mode] = { sig, tasks: deduped, errors }
  return deduped
}

export function loadTasks(view = 'active'): Task[] {
  if (view === 'archive') {
    return loadAllTasksRaw('all').filter(t => ARCHIVE_SEG_RE.test(t.path))
  }
  if (view === 'active') {
    return loadAllTasksRaw('active')
  }
  return loadAllTasksRaw('all')
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

  // 写后失效读取缓存 —— 否则同一毫秒内的「写→读」可能命中旧签名
  invalidateTaskCache()
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
