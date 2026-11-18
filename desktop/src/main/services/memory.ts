/**
 * 记忆层（memory）· 2026-11-17
 *
 * 暮雨：「方寸要管记忆，**当 DSH 的记忆层**，甚至和其他记忆插件联动」
 * 定稿：① 索引形态 = jsonl；② **不自动抽取**；③ 主体 = 长期教训与纪律。
 *
 * ## 它回答什么
 * 发生过什么事故 / 哪条纪律是拿损失换来的 / 哪条能跨项目用。
 * **不回答**「这次该干什么」—— 那是任务卡。
 *
 * ## 为什么不用 ideas / 执行日志 / 任务卡
 * | 已有 | 为什么不能当记忆 |
 * |---|---|
 * | `ideas/` | 代码里写死「刻意做得很轻：不给优先级/截止/验收/项目」—— 刻意不带来源 |
 * | `docs/执行日志/` | 回答「我干了什么」，不是「发生过什么、影响多大」 |
 * | `task-data/*.md` | 带任务语义；**塞进去会被 parseTask 当任务卡扫，污染台账**（红线） |
 *
 * ## 三条硬规矩（写进代码防以后被"顺手改"）
 * 1. **原文逐字保存，不摘要** —— 细节就是价值本体；
 * 2. **不知道的不猜** —— 缺什么就说缺；
 * 3. **不进 task-data/** —— 本文件所有路径都从 `memory/` 出发，不碰 TASK_DIR。
 *
 * ## 索引与真相的关系
 * `memory/index.jsonl` 是**派生数据**，源 md 才是真相。
 * 索引丢了 `rebuildIndex()` 重算即可；任何时候不拿索引当唯一来源。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getDataDir, atomicWrite } from '../data'

/** 记忆根目录（数据根下的 `memory/`，与 task-data/ 平级但**永不混用**） */
export function memoryDir(): string {
  return path.join(getDataDir(), 'memory')
}

export function indexPath(): string {
  return path.join(memoryDir(), 'index.jsonl')
}

/** 类型取值域 —— 单一真源。界面筛选、MCP 工具、索引都按它走，不许各自再写一份 */
export const MEMORY_TYPES = ['事故', '教训', '纪律', '决定', '偏好'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

/** 状态取值域（REV-015 点出的缺口：得能标记"这条后来被推翻了"） */
export const MEMORY_STATUSES = ['有效', '已撤销'] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

export interface MemoryEntry {
  id: string
  type: string
  /** 适用范围，如「跨项目」 */
  scope: string
  project: string
  time: string
  status: string
  impact: string
  title: string
  summary: string
  /** 相对数据根的路径，如 `memory/incidents/xxx.md` */
  file: string
  source: string
  tags: string[]
}

/**
 * 手写极简 frontmatter 解析（**不引 yaml**：零依赖是本仓红线）。
 *
 * ⚠ 解析不了的**原样留着**，绝不静默变空串 ——
 *   本仓栽过：英文键读中文 frontmatter，整列变空、退出码 0、没人发现。
 */
export function parseFrontmatter(text: string): { fm: Record<string, any>; body: string } {
  const m = [...String(text || '').matchAll(/^---\s*$/gm)]
  if (m.length < 2) return { fm: {}, body: String(text || '') }
  const fmText = String(text).slice(m[0].index! + m[0][0].length, m[1].index)
  const body = String(text).slice(m[1].index! + m[1][0].length)
  const fm: Record<string, any> = {}
  for (const raw of fmText.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line || line.startsWith('#') || !line.includes(':')) continue
    const i = line.indexOf(':')
    const k = line.slice(0, i).trim()
    let v: any = line.slice(i + 1).trim()
    if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === "'" || v[0] === '"')) {
      v = v.slice(1, -1)
    }
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((x: string) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    }
    fm[k] = v
  }
  return { fm, body }
}

function walkMd(dir: string, out: string[]): void {
  let names: fs.Dirent[] = []
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return // 目录不存在 = 还没录过，这是常态不是错误
  }
  for (const d of names) {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) walkMd(p, out)
    else if (d.name.endsWith('.md') && d.name !== 'README.md') out.push(p)
  }
}

/** 从磁盘扫真实文件（索引是派生数据，这是真相） */
export function scanEntries(): MemoryEntry[] {
  const root = memoryDir()
  const files: string[] = []
  walkMd(root, files)
  const dataRoot = getDataDir()
  const rows: MemoryEntry[] = []
  for (const p of files) {
    let text = ''
    try {
      text = fs.readFileSync(p, 'utf-8')
    } catch (e: any) {
      // 坏文件要出现，不能静默消失
      rows.push({
        id: '', type: '', scope: '', project: '', time: '', status: '',
        impact: '', title: `（读不到：${String(e?.message || e)}）`, summary: '',
        file: path.relative(dataRoot, p).replace(/\\/g, '/'), source: '', tags: [],
      })
      continue
    }
    const { fm, body } = parseFrontmatter(text)
    // 标题 = 第一个 # 行；摘要 = 其后第一段非空文字前 120 字
    let title = ''
    let summary = ''
    for (const line of body.split(/\r?\n/)) {
      const s = line.trim()
      if (!s) continue
      if (s.startsWith('#') && !title) { title = s.replace(/^#+\s*/, ''); continue }
      if (title) { summary = s.length > 120 ? s.slice(0, 120) : s; break }
    }
    rows.push({
      id: String(fm['id'] || ''),
      type: String(fm['类型'] || ''),
      scope: String(fm['适用范围'] || ''),
      project: String(fm['项目'] || ''),
      time: String(fm['时间'] || ''),
      status: String(fm['状态'] || '有效'),
      impact: String(fm['影响'] || ''),
      title, summary,
      file: path.relative(dataRoot, p).replace(/\\/g, '/'),
      source: String(fm['来源'] || ''),
      tags: Array.isArray(fm['tags']) ? fm['tags'] : [],
    })
  }
  // 时间倒序；认不出的排后面（**不当 0** —— 当 0 会显示成 1970）
  rows.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')))
  return rows
}

/** 重建索引：jsonl，一行一条，**只存指针与摘要，不存原文**（防两份真相） */
export function rebuildIndex(): { count: number; path: string } {
  const rows = scanEntries()
  const lines = rows.map((r) => JSON.stringify({
    id: r.id, 类型: r.type, 适用范围: r.scope, 项目: r.project, 时间: r.time,
    状态: r.status, 影响: r.impact, 标题: r.title, 摘要: r.summary,
    源文件: r.file, 来源: r.source, tags: r.tags,
  }))
  fs.mkdirSync(memoryDir(), { recursive: true })
  atomicWrite(indexPath(), lines.join('\n') + (lines.length ? '\n' : ''))
  return { count: rows.length, path: indexPath() }
}

export interface MemoryQuery {
  type?: string
  scope?: string
  project?: string
  q?: string
  /** 含已撤销；默认只看有效 */
  includeRevoked?: boolean
  limit?: number
}

/**
 * 检索。默认**排除已撤销**（撤销≠删除，`--all` 才看得到）。
 *
 * ⚠ scope 有两个来源：`适用范围` 字段，或直接把 `项目` 写成「跨项目」。
 *   两个都认 —— 否则检索悄悄查不到，用户以为没这条（本仓记过多次的同一类病）。
 */
export function searchMemory(q: MemoryQuery = {}): { rows: MemoryEntry[]; total: number } {
  const all = scanEntries()
  const hit = all.filter((r) => {
    if (!q.includeRevoked && r.status === '已撤销') return false
    if (q.type && !String(r.type).includes(q.type)) return false
    if (q.scope && !String(r.scope).includes(q.scope) && q.scope !== r.project) return false
    if (q.project && q.project !== r.project) return false
    if (q.q) {
      const hay = `${r.title} ${r.summary} ${r.id} ${r.tags.join(' ')}`.toLowerCase()
      // 关键词也搜原文（细节可能只在正文里）
      let raw = ''
      try { raw = fs.readFileSync(path.join(getDataDir(), r.file), 'utf-8') } catch { /* 读不到就只搜索引面 */ }
      if (!hay.includes(q.q.toLowerCase()) && !raw.toLowerCase().includes(q.q.toLowerCase())) return false
    }
    return true
  })
  const total = hit.length
  const limit = Number(q.limit) > 0 ? Number(q.limit) : 50
  return { rows: hit.slice(0, limit), total }
}

/** 读一条的原文（检索只给指针，正文按需取 —— 记忆可能很长） */
export function readMemory(file: string): { ok: boolean; text?: string; error?: string } {
  // 硬闸：只允许读 memory/ 下的文件（防 `../` 逃逸读到别处）
  const rel = String(file || '').trim().replace(/\\/g, '/')
  if (!rel.startsWith('memory/')) return { ok: false, error: '只能读 memory/ 下的文件' }
  if (rel.includes('..')) return { ok: false, error: '路径不许包含 ..' }
  const full = path.join(getDataDir(), rel)
  const real = path.resolve(full)
  const root = path.resolve(memoryDir())
  if (!real.startsWith(root + path.sep) && real !== root) {
    return { ok: false, error: '路径逃出了 memory/（拒绝）' }
  }
  try {
    return { ok: true, text: fs.readFileSync(real, 'utf-8') }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** 概览：给界面与 MCP 一句话现状（空库要说得清「还没录」而不是「0 条」） */
export function memoryOverview() {
  const rows = scanEntries()
  const byType: Record<string, number> = {}
  for (const r of rows) byType[r.type || '(未标类型)'] = (byType[r.type || '(未标类型)'] || 0) + 1
  return {
    total: rows.length,
    effective: rows.filter((r) => r.status !== '已撤销').length,
    revoked: rows.filter((r) => r.status === '已撤销').length,
    byType,
    dir: memoryDir(),
    hint: rows.length
      ? ''
      : '记忆库还没有任何条目 —— 这不是“筛出来没有”，是还没录过。原文逐字录入，不做摘要。',
  }
}

// ── 写（2026-11-18 暮雨：“记忆页必须开放写，不然出问题用户想改都改不了”）─────
//
// 为什么改成开放写：原来只有 agent 落盘，界面上一个写入入口都没有 ——
// 于是"这条记错了 / 这条被推翻了"这种事，用户自己**改不了**，只能等下一次 agent 会话。
// 记忆是用户的资产，改它不该需要 agent 在场。
//
// 但**不是**把"摘要式随手记"放进来（那正是这条功能要治的病）。所以写入必填：
//   类型 / 标题 / 原文 / 来源 / 影响 —— 缺一个就拒，并说清缺哪个（不许糊默认值）。

export interface MemoryInput {
  type: string
  title: string
  /** 逐字原文（正文）。不摘要、不截断。 */
  body: string
  /** 从哪来的（谁说的 / 哪次事故 / 哪个文件） */
  source: string
  time?: string
  project?: string
  scope?: string
  status?: string
  impact?: string
  tags?: string[]
}

export interface MemoryWriteResult {
  ok: boolean
  error?: string
  /** 写成功后的相对路径（memory/<yyyy-mm>/mem-<yyyymmdd>-<n>.md） */
  file?: string
}

/** 类型必须落在取值域内 —— 否则筛选/索引/界面徽章全对不上 */
function normType(t: string): string {
  const v = String(t || '').trim()
  return (MEMORY_TYPES as readonly string[]).includes(v) ? v : ''
}

/** 序号：同一天第几条（`mem-<yyyymmdd>-01.md` 起） */
function nextSeq(dir: string, stamp: string): number {
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { return 1 }
  const used = names
    .map((n) => new RegExp(`^mem-${stamp}-(\\d+)\\.md$`).exec(n))
    .filter(Boolean)
    .map((m) => Number(m![1]))
  return (used.length ? Math.max(...used) : 0) + 1
}

function pad2(n: number): string { return String(n).padStart(2, '0') }

/** 手写 frontmatter（**不引 yaml**：零依赖是本仓红线；与 parseFrontmatter 对称） */
function renderEntry(input: Required<Omit<MemoryInput, 'time'>> & { time: string }, id: string): string {
  const tags = input.tags.length ? `[${input.tags.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')}]` : '[]'
  // 值里出现换行/冒号会破坏手写 frontmatter —— 一律折叠成单行（原文在正文里，不受影响）
  const one = (s: string) => String(s || '').replace(/\s*\r?\n\s*/g, ' ').trim()
  return [
    '---',
    `id: ${id}`,
    `类型: ${input.type}`,
    `来源: ${one(input.source)}`,
    `时间: ${input.time}`,
    `项目: ${one(input.project)}`,
    `适用范围: ${one(input.scope)}`,
    `状态: ${input.status}`,
    `影响: ${input.impact}`,
    `tags: ${tags}`,
    '---',
    '',
    `# ${one(input.title)}`,
    '',
    // ⚠ 原文**逐字**写进去，一个字符都不改（这是这条功能存在的理由）
    String(input.body || '').replace(/\r\n/g, '\n').replace(/\s+$/, ''),
    '',
  ].join('\n')
}

/**
 * 新建一条记忆。
 *
 * ⚠ 三条硬闸：
 *   ① **类型必须在取值域内**（否则界面上那排筛选徽章永远命不中它）；
 *   ② **原文不许为空**（"记了个标题、正文是空的"＝下次看到的人等于没有）；
 *   ③ 路径**只从 memory/ 出发**，与 readMemory 同一套 `realpath` 校验（防 `../` 逃逸）。
 *      这里没有外部路径参数（文件名是自己拼的），但仍然重新校验一遍 —— 防以后有人加参数忘了闸。
 */
export function createMemory(raw: MemoryInput): MemoryWriteResult {
  const type = normType(raw?.type)
  if (!type) return { ok: false, error: `类型必须是这五种之一：${MEMORY_TYPES.join(' / ')}` }
  const title = String(raw?.title || '').trim()
  if (!title) return { ok: false, error: '标题不能空 —— 标题是列表里唯一能扫的东西' }
  const body = String(raw?.body || '').trim()
  if (!body) return { ok: false, error: '原文不能空 —— 只存标题等于没记（这条功能存在的理由就是正文）' }
  const source = String(raw?.source || '').trim()
  if (!source) return { ok: false, error: '来源不能空 —— 说不清从哪来的记忆，下次没人敢信它' }

  const now = new Date()
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`
  const monthDir = path.join(memoryDir(), `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`)
  try { fs.mkdirSync(monthDir, { recursive: true }) } catch (e: any) {
    return { ok: false, error: `建目录失败：${e?.message || e}` }
  }

  const seq = nextSeq(monthDir, stamp)
  const id = `mem-${stamp}-${pad2(seq)}`
  const full = path.join(monthDir, `${id}.md`)

  // 与 readMemory 同一道闸：写也得证明自己落在 memory/ 之内
  const real = path.resolve(full)
  const root = path.resolve(memoryDir())
  if (!real.startsWith(root + path.sep)) {
    return { ok: false, error: '路径逃出了 memory/（拒绝）' }
  }
  if (fs.existsSync(full)) {
    // 极端并发下序号撞了：再算一次，仍撞就如实报错，**绝不覆盖**
    const seq2 = seq + 1
    const id2 = `mem-${stamp}-${pad2(seq2)}`
    const full2 = path.join(monthDir, `${id2}.md`)
    if (fs.existsSync(full2)) return { ok: false, error: `今天的序号 ${seq} 已被占用，且下一个也被占用 —— 请稍后重试` }
    const text2 = renderEntry({
      type, title, body, source,
      time: raw.time ? String(raw.time) : now.toISOString(),
      project: String(raw.project || ''), scope: String(raw.scope || ''),
      status: (MEMORY_STATUSES as readonly string[]).includes(String(raw.status)) ? String(raw.status) : '有效',
      impact: String(raw.impact || ''),
      tags: Array.isArray(raw.tags) ? raw.tags.map((x) => String(x)).filter(Boolean) : [],
    }, id2)
    atomicWrite(full2, text2)
    return { ok: true, file: path.relative(getDataDir(), full2).replace(/\\/g, '/') }
  }

  const text = renderEntry({
    type, title, body, source,
    time: raw.time ? String(raw.time) : now.toISOString(),
    project: String(raw.project || ''), scope: String(raw.scope || ''),
    status: (MEMORY_STATUSES as readonly string[]).includes(String(raw.status)) ? String(raw.status) : '有效',
    impact: String(raw.impact || ''),
    tags: Array.isArray(raw.tags) ? raw.tags.map((x) => String(x)).filter(Boolean) : [],
  }, id)
  try {
    atomicWrite(full, text)
  } catch (e: any) {
    return { ok: false, error: `写入失败：${e?.message || e}` }
  }
  return { ok: true, file: path.relative(getDataDir(), full).replace(/\\/g, '/') }
}

/**
 * 改一条记忆的整段原文（界面上的"编辑"）。
 *
 * 判据与新建一致：**原文不许为空**、类型必须在取值域内、路径必须在 memory/ 内。
 * ⚠ 不做"部分字段合并"：记忆是**一份原文**，合并字段只会造出"半新半旧"的第四条记忆
 *   （而用户改它时看到的是一整段，他以为自己改的是那一整段）。
 */
export function updateMemory(file: string, raw: MemoryInput): MemoryWriteResult {
  const gate = readMemory(file)
  if (!gate.ok) return { ok: false, error: gate.error || '读不到这一条' }
  const type = normType(raw?.type)
  if (!type) return { ok: false, error: `类型必须是这五种之一：${MEMORY_TYPES.join(' / ')}` }
  const title = String(raw?.title || '').trim()
  if (!title) return { ok: false, error: '标题不能空' }
  const body = String(raw?.body || '').trim()
  if (!body) return { ok: false, error: '原文不能空 —— 改着改着变成空条目，比不改更糟' }
  const source = String(raw?.source || '').trim()
  if (!source) return { ok: false, error: '来源不能空' }

  const rel = String(file || '').trim().replace(/\\/g, '/')
  const full = path.resolve(path.join(getDataDir(), rel))
  const root = path.resolve(memoryDir())
  if (!full.startsWith(root + path.sep)) return { ok: false, error: '路径逃出了 memory/（拒绝）' }

  // id 沿用原文件里的（改内容不改身份；否则"这条是几号"会漂）
  const parsed = parseFrontmatter(gate.text || '')
  const id = String(parsed.fm['id'] || path.basename(rel, '.md'))
  const text = renderEntry({
    type, title, body, source,
    time: String(parsed.fm['时间'] || new Date().toISOString()),
    project: String(raw.project !== undefined ? raw.project : (parsed.fm['项目'] || '')),
    scope: String(raw.scope !== undefined ? raw.scope : (parsed.fm['适用范围'] || '')),
    status: String(raw.status !== undefined && (MEMORY_STATUSES as readonly string[]).includes(String(raw.status))
      ? raw.status : (parsed.fm['状态'] || '有效')),
    impact: String(raw.impact !== undefined ? raw.impact : (parsed.fm['影响'] || '')),
    tags: Array.isArray(raw.tags) ? raw.tags.map((x) => String(x)).filter(Boolean)
      : (Array.isArray(parsed.fm['tags']) ? parsed.fm['tags'].map((x: any) => String(x)) : []),
  }, id)
  try {
    atomicWrite(full, text)
  } catch (e: any) {
    return { ok: false, error: `写入失败：${e?.message || e}` }
  }
  return { ok: true, file: rel }
}

/**
 * 撤销 / 恢复一条记忆（REV-015：得能标记"这条后来被推翻了"）。
 *
 * ⚠ **撤销≠删除**：文件不动，只改 frontmatter 的 `状态`。
 *   记忆的价值在"它曾经发生过"，删掉就是篡改历史。
 */
export function setMemoryStatus(file: string, status: string): MemoryWriteResult {
  const st = String(status || '').trim()
  if (!(MEMORY_STATUSES as readonly string[]).includes(st)) {
    return { ok: false, error: `状态只能是：${MEMORY_STATUSES.join(' / ')}` }
  }
  const gate = readMemory(file)
  if (!gate.ok) return { ok: false, error: gate.error || '读不到这一条' }
  const rel = String(file || '').trim().replace(/\\/g, '/')
  const full = path.resolve(path.join(getDataDir(), rel))
  const root = path.resolve(memoryDir())
  if (!full.startsWith(root + path.sep)) return { ok: false, error: '路径逃出了 memory/（拒绝）' }

  const src = String(gate.text || '')
  // 就地替换 `状态:` 那一行；没有就补进 frontmatter（**不动正文一个字**）
  let next = ''
  if (/^状态:.*$/m.test(src)) {
    next = src.replace(/^状态:.*$/m, `状态: ${st}`)
  } else {
    const m = [...src.matchAll(/^---\s*$/gm)]
    if (m.length < 2) return { ok: false, error: '这条没有 frontmatter —— 不敢乱插，请手工修' }
    const at = m[0].index! + m[0][0].length
    next = src.slice(0, at) + `\n状态: ${st}` + src.slice(at)
  }
  if (next === src) return { ok: true, file: rel } // 已经是这个状态 = 幂等，不写盘
  try {
    atomicWrite(full, next)
  } catch (e: any) {
    return { ok: false, error: `写入失败：${e?.message || e}` }
  }
  return { ok: true, file: rel }
}
