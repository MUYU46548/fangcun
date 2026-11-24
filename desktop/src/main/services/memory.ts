/**
 * 记忆层（memory）· v2（2026-11-20）
 *
 * 暮雨：「记忆加个开关（默认开启）」+「人家是一条记忆就一两句话，加可信度召回比例等参数。
 * 方寸的记忆是一大坨，上下文压力太大而且不便于检索」。
 *
 * ## 两条层（v2）
 * - **claim**：`## 记忆` 下 1–2 句，≤120 字（硬上限 200）——检索 / 注入 / 列表只碰它；
 * - **evidence**：`## 证据` 下原文逐字（长文可放到 `memory/lessons|incidents/`，用 `证据` 指针）——
 *   只在 `memory_read` 时取。
 *
 * 这不是"不要原文"：原文一个字都不删，只是**不再默认塞进上下文**。
 *
 * ## 三条硬规矩
 * 1. 一个文件只讲一件事；claim 超 200 字直接拒。
 * 2. `## 证据` 不许为空；说不清来源的不收。
 * 3. 原文逐字，不摘要；claim 是索引句，不是对原文的改写。
 *
 * ## 索引与真相
 * `memory/index.jsonl` 是**派生数据**，源 md 才是真相；`core.md` 也是生成的，别手改。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getDataDir, atomicWrite, loadTasks } from '../data'
import { getPref, getPrefs } from './prefs'
import { hitsMap, recordMemoryUsage } from './memoryUsage'
import { listLogs } from './logs'
import {
  MEMORY_BUDGETS, RankableMemory, rankMemories, renderCore, findDuplicate, similarity,
  clamp, numOr, confidenceOf, importanceOf, weightOf,
} from '../../shared/memoryRank'

/** 记忆根目录（数据根下的 `memory/`，与 task-data/ 平级但**永不混用**） */
export function memoryDir(): string {
  return path.join(getDataDir(), 'memory')
}

export function indexPath(): string {
  return path.join(memoryDir(), 'index.jsonl')
}

/**
 * 台账索引（2026-11-23）。
 *
 * 由来：实测四份台账共 921 条（决策 155 / 日志 365 / 任务卡 384 / 方针 17），
 * 而记忆索引里指向台账的条数是 **0** —— 方寸的全部历史都在记忆外面。
 * 这不是格式问题，是**没接线**：`scripts/memory.py` 只扫 `memory/` 自己。
 *
 * 为什么单独一个文件、不并进 `index.jsonl`：
 *   前者是"人/agent 写的一两句 claim"，后者是"机器抽的台账指针"。
 *   混在一起会让「记忆有 N 条」这个数字同时代表两种东西 —— 本仓吃过这个亏。
 *
 * 内容由 `scripts/memory_ledgers.py --rebuild` 生成，**只存指针 + 摘要，不存正文**。
 */
export function ledgersIndexPath(): string {
  return path.join(memoryDir(), 'index-ledgers.jsonl')
}

export interface LedgerRow {
  src_kind: 'decision' | 'log' | 'card' | 'charter'
  id: string
  title: string
  summary: string
  project: string
  status: string
  time: string
  /** 相对数据根的源文件路径 —— 指针，不是副本 */
  srcPath: string
  anchor: string
  /** 摘要里命中的关键词（给调用方做"为什么这条被搜到"用） */
  matched?: string
}

/** v2 原子记忆目录（一条一个文件） */
export function claimsDir(): string {
  return path.join(memoryDir(), 'claims')
}

/** 类型取值域 —— 单一真源。界面筛选、MCP 工具、索引都按它走，不许各自再写一份 */
/**
 * 记忆类型（2026-11-24 加「事实」—— 问卷 B4=B / A2=A+B+C）。
 *
 * 为什么必须新开一类，而不是并进「教训」：
 * A2 要的第三类是「**机器会咬人的事实**」—— 环境/工具/路径层面的硬约束
 * （BOM 会写进数据文件、`.asar` 被索引器锁住、`strict:false` 下联合类型不收窄）。
 * 它与「教训」的区别是**没有责任人、没有过程、不会过去**：一条 2026-09 的
 * 「PowerShell 的 `-Encoding utf8` 会写 BOM」今天仍然成立，不该按事故半衰期衰减。
 *
 * 所以它还带两个专属语义：
 *   ① 半衰期 0（不衰减）—— 工具事实不会「过时」，只会被新的**取代**；
 *   ② `钉住` 优先级高 —— 它们是「开工就该知道」的那一档。
 */
export const MEMORY_TYPES = ['事故', '教训', '纪律', '决定', '偏好', '事实'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

/** 状态取值域（`待审批` 是 agent 提案的中间态，默认检索不返回） */
export const MEMORY_STATUSES = ['有效', '已撤销', '待审批'] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

export interface MemoryEntry extends RankableMemory {
  id: string
  claim: string
  type: string
  scope: string
  project: string
  time: string
  status: string
  impact: string
  /** 兼容 v1 的标题；v2 里等于 claim */
  title: string
  /** 兼容 v1 的摘要；v2 里等于 claim */
  summary: string
  /** 相对数据根的路径，如 `memory/claims/xxx.md` */
  file: string
  source: string
  /** `## 证据` 正文（可能为空；v1 legacy 为整篇） */
  evidence: string
  /** 长原文的指针（frontmatter `证据`） */
  evidencePath: string
  /** 证据文件里的锚点（frontmatter `证据锚点`） */
  evidenceAnchor: string
  review: string
  halfLife: number
  pinned: boolean
  weight: number
  supersedes: string
  supersededBy: string
  code: string
  tags: string[]
  /** 2 = v2；1 = legacy */
  format: number
  legacy: boolean
  score?: number
  relevance?: number
  hits30d?: number
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

/** 不参与检索/索引的文件：README 是规范，core 是生成的核心块，manual 是人工补充 */
const NON_ENTRY_FILES = new Set(['README.md', 'core.md', 'core.manual.md'])
/**
 * 扫描时跳过的目录：备份/回收站/证据层/**v1 原始素材**。
 *
 * ⚠ 2026-11-23 补：`YYYY-MM` 形式的目录是 **v1 原始素材库**（完整事故报告 / 决策原文），
 * 而 `claims/` 是从中提炼的 v2 原子记忆。两者**同编号但内容不同层级** ——
 * 原文长（2000+ 字），claim 短（一两句）。把它们都当"归档条目"扫会产生两个后果：
 *   ① id 撞车，`memoryCheck()` 报"id 重复"（实际是"原文 + 摘要"，不是重复）；
 *   ② 计数翻倍，「记忆有 N 条」这个数字同时代表两层，本仓吃过这个亏。
 * v1 素材的职责是**当证据被引用**（`证据: memory/2026-11/mem-xxx.md`），
 * 不是当独立条目参与检索。所以：扫描跳过，但证据路径照常可解析。
 */
const SKIP_DIRS = new Set(['.backup', '.git', 'node_modules', 'evidence'])
/** v1 原始素材目录名（`2026-11` 这类） */
const V1_RAW_DIR = /^\d{4}-\d{2}$/

/**
 * 递归收集 `memory/` 下的 md。
 *
 * ⚠ `skipV1Raw` 是给"扫条目"用的，不是全局规则：
 *   `memory/2026-11/` 里既有 v1 原始素材（不该当条目），**也可能有 v2 证据文件**
 *   （`格式: 证据`，`countEvidence()` 要数它）。
 *   所以证据计数必须用 `skipV1Raw=false` 再走一遍 —— 否则会凭空少算几条，
 *   而 `e2e-memory` 里那条"证据 14 篇"会红，且红得毫无线索（2026-11-23 实际踩到）。
 */
function walkMd(dir: string, out: string[], skipV1Raw = true): void {
  let names: fs.Dirent[] = []
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return // 目录不存在 = 还没录过，这是常态不是错误
  }
  for (const d of names) {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) {
      if (SKIP_DIRS.has(d.name) || d.name.startsWith('.')) continue
      if (skipV1Raw && V1_RAW_DIR.test(d.name)) continue
      walkMd(p, out, skipV1Raw)
    } else if (d.name.endsWith('.md') && !NON_ENTRY_FILES.has(d.name)) {
      out.push(p)
    }
  }
}

/** 取 body 里 `## <name>` 那一节（到下一个 `##` 为止）；没有就空串 */
function section(body: string, name: string): string {
  const re = new RegExp(`^##\\s*${name}\\s*$`, 'm')
  const m = re.exec(String(body || ''))
  if (!m) return ''
  const rest = String(body).slice(m.index + m[0].length)
  const next = /^##\s+/m.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).trim()
}

/**
 * 取 `## <name>` 到**正文结尾**。
 *
 * 证据是正文最后一节，里面可能自带 `## 定级` 这类标题（用户原文就是这样）；
 * 用 `section()` 会在第一个 `##` 处截断，读出来是空证据 —— 2026-11-20 迁移时
 * 当场抓到过一次（18 条 D 规则全中），所以证据单独走这个"取到尾"的口径。
 */
function lastSection(body: string, name: string): string {
  const re = new RegExp(`^##\\s*${name}\\s*$`, 'm')
  const m = re.exec(String(body || ''))
  if (!m) return ''
  return String(body).slice(m.index + m[0].length).trim()
}

function firstHeading(body: string): string {
  const m = /^#{1,6}\s+(.+)$/m.exec(String(body || ''))
  return m ? m[1].trim() : ''
}

/**
 * 标题 + 摘要（v1 兼容用）：**别把 Markdown 标题/引用当摘要**。
 *
 * 2026-11-19 实测：旧逻辑取「标题后第一行非空」，而多数事故正文第一行是
 * `## 定级` / `## 一句话` —— 于是检索结果里 80% 的摘要是「## 定级」。
 */
function titleAndSummary(body: string): { title: string; summary: string } {
  const lines = String(body || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  let title = ''
  let i = 0
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^#{1,6}\s+(.+)$/)
    if (m) { title = m[1].trim(); i++; break }
  }
  const noise = (s: string) => /^#{1,6}\s/.test(s) || /^>/.test(s) || /^\|/.test(s)
    || /^```/.test(s) || /^---+$/.test(s)
  const clean = (s: string) => s.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').trim()
  for (; i < lines.length; i++) {
    if (noise(lines[i])) continue
    const c = clean(lines[i])
    if (!c) continue
    return { title, summary: c.length > 120 ? c.slice(0, 120) : c }
  }
  return { title, summary: '' }
}

function oneLine(s: any): string {
  return String(s || '').replace(/\s*\r?\n\s*/g, ' ').trim()
}

function boolOf(v: any, def: boolean): boolean {
  if (v === true || v === 'true' || v === '是' || v === 1 || v === '1') return true
  if (v === false || v === 'false' || v === '否' || v === 0 || v === '0') return false
  return def
}

function inferImportance(impact: any): number {
  const s = String(impact || '').trim()
  if (s.startsWith('严重')) return 5
  if (s.startsWith('高')) return 4
  if (s.startsWith('中')) return 3
  if (s.startsWith('低')) return 2
  return 3
}

function importanceLabel(n: number): string {
  if (n >= 5) return '严重'
  if (n >= 4) return '高'
  if (n >= 3) return '中'
  return '低'
}

/** 默认半衰期：纪律/决定不衰减；事故/教训一年；偏好半年 */
function defaultHalfLife(type: string): number {
  // 「事实」不衰减（2026-11-24）：工具/环境约束不会因为时间过去而失效。
  // 要让它退场只有一条路 —— 被新的 claim 用 `取代` 顶掉。
  if (type === '纪律' || type === '决定' || type === '事实') return 0
  if (type === '偏好') return 180
  return 365
}

function isEvidenceFm(fm: Record<string, any>): boolean {
  return String(fm['格式'] || '') === '证据'
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
      rows.push(blankEntry(path.relative(dataRoot, p).replace(/\\/g, '/'),
        `（读不到：${String(e?.message || e)}）`))
      continue
    }
    const { fm, body } = parseFrontmatter(text)
    if (isEvidenceFm(fm)) continue // 证据层不参与检索/计数

    const claimSec = section(body, '记忆')
    const legacy = String(fm['格式'] || '') !== '2' && !claimSec
    const ts = titleAndSummary(body)
    const claim = oneLine(claimSec || ts.title || ts.summary)
    const evidence = lastSection(body, '证据') || (legacy ? body.trim() : '')
    const type = String(fm['类型'] || '')
    const importance = fm['重要度'] !== undefined ? importanceOf(fm['重要度']) : inferImportance(fm['影响'])
    const format = numOr(fm['格式'], legacy ? 1 : 2)
    const hit = {
      ...blankEntry(path.relative(dataRoot, p).replace(/\\/g, '/'), claim || ts.title),
      id: String(fm['id'] || path.basename(p, '.md')),
      type,
      claim: claim || path.basename(p, '.md'),
      title: claim || ts.title,
      summary: claim || ts.summary,
      scope: String(fm['适用范围'] || ''),
      project: String(fm['项目'] || ''),
      time: String(fm['时间'] || ''),
      status: String(fm['状态'] || '有效'),
      impact: String(fm['影响'] || importanceLabel(importance)),
      source: String(fm['来源'] || ''),
      evidence,
      evidencePath: String(fm['证据'] || ''),
      evidenceAnchor: String(fm['证据锚点'] || ''),
      review: String(fm['复核'] || ''),
      confidence: confidenceOf(fm['可信度']),
      importance,
      halfLife: fm['半衰期'] !== undefined ? numOr(fm['半衰期'], defaultHalfLife(type)) : defaultHalfLife(type),
      pinned: boolOf(fm['钉住'], false),
      weight: weightOf(fm['召回权重']),
      supersedes: String(fm['取代'] || ''),
      supersededBy: String(fm['被取代'] || ''),
      code: String(fm['编号'] || ''),
      tags: Array.isArray(fm['tags']) ? fm['tags'].map((x: any) => String(x)) : [],
      format,
      legacy,
    }
    rows.push(hit)
  }
  // 时间倒序；认不出的排后面（**不当 0** —— 当 0 会显示成 1970）
  rows.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')))
  return rows
}

function blankEntry(file: string, claim: string): MemoryEntry {
  return {
    id: '', type: '', claim, title: claim, summary: claim, scope: '', project: '',
    time: '', status: '', impact: '', file, source: '', evidence: '',
    evidencePath: '', evidenceAnchor: '', review: '', confidence: 0.7, importance: 3,
    halfLife: 365, pinned: false, weight: 1, supersedes: '', supersededBy: '',
    code: '', tags: [], format: 1, legacy: true,
  }
}

/** 证据篇数（`格式: 证据` 的 md） */
function countEvidence(): number {
  const files: string[] = []
  // ⚠ skipV1Raw=false：证据文件可能住在 `2026-11/` 里（v1 素材恰好吃 `格式: 证据` 格式）。
  // 跳掉它会让证据数凭空少几条 —— 见 walkMd 的注释。
  walkMd(memoryDir(), files, false)
  let n = 0
  for (const p of files) {
    try {
      const { fm } = parseFrontmatter(fs.readFileSync(p, 'utf-8'))
      if (isEvidenceFm(fm)) n++
    } catch { /* 读不到的不算，不假装 */ }
  }
  return n
}

/** 重建索引：jsonl，一行一条，**只存指针与摘要，不存原文**（防两份真相） */
export function rebuildIndex(rowsIn?: MemoryEntry[]): { count: number; path: string; core: { ok: boolean; chars: number; dropped: number } } {
  const rows = rowsIn || scanEntries()
  const lines = rows.map((r) => JSON.stringify({
    id: r.id,
    类型: r.type,
    记忆: r.claim,
    可信度: r.confidence,
    重要度: r.importance,
    项目: r.project,
    适用范围: r.scope,
    时间: r.time,
    状态: r.status,
    影响: r.impact,
    来源: r.source,
    证据: r.evidencePath,
    证据锚点: r.evidenceAnchor,
    半衰期: r.halfLife,
    钉住: r.pinned,
    召回权重: r.weight,
    标题: r.title,
    摘要: r.claim,
    源文件: r.file,
    tags: r.tags,
    格式: r.format,
    legacy: r.legacy,
  }))
  fs.mkdirSync(memoryDir(), { recursive: true })
  atomicWrite(indexPath(), lines.join('\n') + (lines.length ? '\n' : ''))
  const core = generateCore(rows)
  return { count: rows.length, path: indexPath(), core: { ok: core.ok, chars: core.chars, dropped: core.dropped } }
}

export interface MemoryQuery {
  type?: string
  scope?: string
  project?: string
  q?: string
  /** 直接按状态筛（优先于下面两个 include 开关）：有效 / 待审批 / 已撤销 */
  status?: string
  /** true = 只要没有项目归属的（通用 / 全局） */
  global?: boolean
  /** 含已撤销；默认只看有效 */
  includeRevoked?: boolean
  /** 含待审批（agent 提案）；默认不返回 */
  includePending?: boolean
  limit?: number
}

/**
 * 检索：过滤 → 打分 → 排序 → 预算裁剪。
 *
 * ⚠ 与 v1 的差别：v1 是"过滤后按时间切片"，v2 是"按相关度 × 可信度 × 重要度 ×
 * 新鲜度 × 使用强度 × 权重排序"。搜 `kill` 第一条必须是 D5，而不是 D1。
 */
export function searchMemory(q: MemoryQuery = {}): {
  rows: MemoryEntry[]
  total: number
  truncated: boolean
  dropped: number
  chars: number
  legacy: number
} {
  const all = scanEntries()
  const hit = all.filter((r) => {
    // 2026-11-20：显式 status 优先 —— 否则「看已撤销」会被 includeRevoked=false 先筛掉
    if (q.status) {
      if (r.status !== q.status) return false
    } else {
      if (!q.includeRevoked && r.status === '已撤销') return false
      if (!q.includePending && r.status === '待审批') return false
    }
    if (q.type && !String(r.type).includes(q.type)) return false
    if (q.scope && !String(r.scope).includes(q.scope) && q.scope !== r.project) return false
    if (q.project && q.project !== r.project) return false
    if (q.global === true && String(r.project || '').trim()) return false
    return true
  })
  // 使用强度（2026-11-24）：规划 §4.3 的 usage 因子一直空跑 —— 因为 hits30d 从来没人填。
  // 现在从 memory/usage.jsonl 读近 30 天召回次数；读不到就是空 Map（不假装 0 次）。
  let hits: Map<string, number> = new Map()
  try { hits = hitsMap(30) } catch { hits = new Map() }
  const withHits = hit.map((r) => (hits.has(r.id) ? { ...r, hits30d: hits.get(r.id) } : r))
  const ranked = rankMemories(withHits, {
    q: q.q,
    project: q.project,
    limit: q.limit || 10,
    maxChars: MEMORY_BUDGETS.search,
    minScore: q.q ? MEMORY_BUDGETS.minScore : 0,
  })
  const rows = ranked.rows.map((x) => ({ ...x.item, score: x.score, relevance: x.relevance }))
  // 记一次召回（2026-11-24）：不改源文件、写失败静默、只记 id。
  // 它让「哪条从没被用过」变成可算的，而不是要人读全库去判 —— 那是几千万 token 的根源。
  try { recordMemoryUsage('search', rows.map((x) => x.id), q.q) } catch { /* 静默 */ }
  return {
    rows,
    total: ranked.total,
    truncated: ranked.truncated,
    dropped: ranked.dropped,
    chars: ranked.chars,
    legacy: hit.filter((r) => r.legacy).length,
  }
}

/** 固定核心块的**默认**上限（不是硬上限 —— 见 coreBudget() 的说明） */
export const MEMORY_CORE_BUDGET = MEMORY_BUDGETS.core

/**
 * 核心预算的**上下限**（用户可调，但别调成 0 或 100000）。
 *
 * ⚠ 2026-11-24 改（暮雨原话：「预算应该用户可调，不要写死代码」）：
 * 原来 `MEMORY_CORE_BUDGET = 800` 是个**硬上限**，generateCore() 超了就丢钉住条目。
 * 实测后果很难看：钉住 11 条时，**I5（沙盒只读）与 I10（「规矩写在报告里 ≠ 写在闸门里」）被挤出去**
 * —— I10 被挤掉，等于重演它自己描述的那个病。而系统给出的话术是「请减少钉住条目」，
 * 把设计的约束说成了用户的规定。那是错的：预算是**用户的旋钮**，不是系统的判决。
 */
export const CORE_BUDGET_MIN = 200
export const CORE_BUDGET_MAX = 4000

/**
 * 读当前 core 预算：prefs 的 `memoryCoreBudget`；键不存在用 800。
 * 认不出 / 越界一律**钳到区间**，不抛错（预算是锦上添花，不能因为它让记忆读不出来）。
 */
export function coreBudget(): number {
  const r = coreBudgetSource()
  return r.value
}

/**
 * 预算 + **它可不可信**。
 *
 * ⚠ 2026-11-24 当场抓到的抖动手故：纯 Node / CLI 下 `getPref` 抛错（没有 electron），
 * 于是 `coreBudget()` 回落到 800 —— 而 `generateCore()` 会把这个 800 **写进 core.md**，
 * 把用户在设置页设的 4000 覆盖掉；下次真机读到 4000 又重排回来……
 * **来回抖**。所以"读不到偏好"与"用户真的设了 800"必须分开：
 * `trusted=false` 时**不许写盘**，只按默认算显示值。
 */
export function coreBudgetSource(): { value: number; trusted: boolean } {
  // ⚠ 判据不能是"getPref 抛没抛错" —— 2026-11-24 当场验过：纯 Node 下 getPrefs()
  //   **不抛**，它 catch 住读文件失败并静默返回 {}，于是 getPref 给 undefined，
  //   看起来跟"用户没设过这个键"一模一样。两者混在一起就会把用户设的 4000 写成 800。
  //   所以真正要问的是：**prefs 文件读到没有**。
  let trusted = true
  try {
    const all = getPrefs()
    // 读不到文件 → getPrefs 返回 {}；此时无法区分"没设过"与"读不到"，一律不信
    trusted = Object.keys(all).length > 0
  } catch {
    trusted = false
  }
  let v: any
  try {
    v = getPref('memoryCoreBudget')
  } catch {
    return { value: MEMORY_CORE_BUDGET, trusted: false }
  }
  if (v === undefined || v === null || v === '') {
    return { value: MEMORY_CORE_BUDGET, trusted }
  }
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return { value: MEMORY_CORE_BUDGET, trusted: false }
  return { value: Math.round(Math.min(CORE_BUDGET_MAX, Math.max(CORE_BUDGET_MIN, n))), trusted }
}

/**
 * 读台账索引（2026-11-23）。
 *
 * 只读一个派生文件，不扫四份台账 —— 否则每次 memory_search 都要读 900+ 个 md，
 * 那是秒级延迟，agent 会以为记忆坏了。
 *
 * ⚠ 文件不存在时返回 `{ ok: false, reason }` 而不是空数组：
 *   空数组会让调用方说"台账里没有这条"，而真相是"还没抽过"。
 *   本仓的老病之一就是这两种情况混着说。
 */
export function loadLedgerIndex(): { ok: boolean; rows: LedgerRow[]; reason?: string } {
  const p = ledgersIndexPath()
  if (!fs.existsSync(p)) {
    return { ok: false, rows: [], reason: '台账索引还没生成：跑 `python scripts/memory_ledgers.py --rebuild`' }
  }
  let text = ''
  try {
    text = fs.readFileSync(p, 'utf-8')
  } catch (e: any) {
    return { ok: false, rows: [], reason: '台账索引读不出来：' + String(e?.message || e) }
  }
  const rows: LedgerRow[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const r = JSON.parse(t)
      rows.push({
        src_kind: r['src_kind'],
        id: String(r['id'] || ''),
        title: String(r['标题'] || ''),
        summary: String(r['摘要'] || ''),
        project: String(r['项目'] || ''),
        status: String(r['状态'] || ''),
        time: String(r['时间'] || ''),
        srcPath: String(r['src_path'] || ''),
        anchor: String(r['src_anchor'] || ''),
      })
    } catch { /* 坏行跳过：一行坏了不该让整次检索失败 */ }
  }
  return { ok: true, rows }
}

/**
 * 在台账索引里搜（关键词 / 类型 / 项目），返回**指针**。
 *
 * 为什么单独一个函数、不并进 searchMemory：
 *   两者排序规则不同 —— claim 按"相关度×可信度×重要度×新鲜度"，台账只有"命不命中"。
 *   硬塞进同一套评分会让台账条目凭"可信度 1.0"把真 claim 挤下去。
 */
export function searchLedgers(q: {
  q?: string
  kind?: string
  project?: string
  limit?: number
} = {}): { ok: boolean; rows: LedgerRow[]; total: number; reason?: string } {
  const idx = loadLedgerIndex()
  if (!idx.ok) return { ok: false, rows: [], total: 0, reason: idx.reason }
  const kw = String(q.q || '').trim().toLowerCase()
  const kind = String(q.kind || '').trim()
  const proj = String(q.project || '').trim()
  let hit = idx.rows
  if (kind) hit = hit.filter((r) => r.src_kind === kind)
  if (proj) hit = hit.filter((r) => r.project === proj)
  if (kw) {
    hit = hit.filter((r) =>
      `${r.title} ${r.summary} ${r.id} ${r.project}`.toLowerCase().includes(kw))
    // 把命中的片段标出来，调用方才知道"为什么这条被搜到"
    hit = hit.map((r) => {
      const hay = `${r.title} ${r.summary}`.toLowerCase()
      const at = hay.indexOf(kw)
      return { ...r, matched: at >= 0 ? hay.slice(Math.max(0, at - 10), at + kw.length + 20).trim() : '' }
    })
  }
  const total = hit.length
  const limit = Math.max(1, Math.min(50, Number(q.limit) || 10))
  return { ok: true, rows: hit.slice(0, limit), total }
}

/**
 * 固定核心块 `memory/core.md`：**每个会话只注入这一小块**，不是动态 top-5。
 *
 * v2 起 core.md 由 `generateCore()` 从 `钉住: true` 的 claim 生成，不再手抄 ——
 * 手抄的那份（v1）会成为第二份真相，改一处另一处不会变。
 *
 * 返回的 `text` 是 body（不含 frontmatter）；`chars` 是 body 字符数。
 */
export function memoryCore(): {
  ok: boolean
  text: string
  chars: number
  budget: number
  truncated: boolean
  missing: boolean
  updatedAt: string
  pinnedCount: number
  generated: boolean
} {
  const full = path.join(memoryDir(), 'core.md')
  const manual = path.join(memoryDir(), 'core.manual.md')
  // 预算被用户调过时**按新预算重新生成**（2026-11-24）。
  // 不这样做的话：调大预算 → core.md 还是旧的少几条，用户以为调了生效了，
  // 实际条数没变（守卫当场抓到：预算 4000 时仍只有 9 条）。预算不只管"截不截"，
  // 更管"装得下几条"，所以它变了就必须重排。
  if (fs.existsSync(full)) {
    try {
      const cur = parseFrontmatter(fs.readFileSync(full, 'utf-8'))
      const src = coreBudgetSource()
      const got = Number(cur.fm['预算'])
      // 只在**预算可信**时才重排：读不到偏好（CLI）时不动文件，否则会把用户设的值写回默认
      if (src.trusted && Number.isFinite(got) && got !== src.value) generateCore()
    } catch { /* core.md 坏了就按原样读，别在这里抛 */ }
  }
  const target = fs.existsSync(full) ? full : (fs.existsSync(manual) ? manual : full)
  if (!fs.existsSync(target)) {
    return {
      ok: true, text: '', chars: 0, budget: MEMORY_CORE_BUDGET, truncated: false,
      missing: true, updatedAt: '', pinnedCount: 0, generated: false,
    }
  }
  try {
    const raw = fs.readFileSync(target, 'utf-8')
    const { fm, body } = parseFrontmatter(raw)
    const text = String(body || '').trim()
    const budget = coreBudget()
    const truncated = text.length > budget
    // 记一次 core 注入（2026-11-24）：core 是**每轮都带**的，所以它覆盖到的条目
    // 使用强度天然最高 —— 这个信号对"哪条该留"很关键。
    try {
      const ids = (String(text).match(/→\s*(mem-[\w-]+)/g) || [])
        .map((x) => x.replace(/^→\s*/, '').trim())
      recordMemoryUsage('core', ids, '')
    } catch { /* 静默 */ }
    const pinnedCount = scanEntries().filter((r) => r.status === '有效' && r.pinned).length
    return {
      ok: true,
      text: truncated ? text.slice(0, budget) : text,
      chars: text.length,
      budget,
      truncated,
      missing: false,
      updatedAt: String(fm['生成'] || fm['更新'] || ''),
      pinnedCount,
      generated: target === full,
    }
  } catch {
    return {
      ok: false, text: '', chars: 0, budget: MEMORY_CORE_BUDGET, truncated: false,
      missing: true, updatedAt: '', pinnedCount: 0, generated: false,
    }
  }
}

/**
 * 生成 `core.md`：钉住的 claim 按重要度排序，≤800 字；`core.manual.md` 可选（算进预算）。
 *
 * 没有钉住条目、也没有人工补充块时**不写** —— 避免把用户手写的旧 core 覆盖成空。
 * 返回 `ok:false, missing:true` 让调用方知道"这次没生成"，不是"生成失败"。
 */
export function generateCore(rowsIn?: MemoryEntry[]): {
  ok: boolean
  missing: boolean
  chars: number
  dropped: number
} {
  const rows = (rowsIn || scanEntries()).filter((r) => r.status === '有效' && r.pinned)
  const manualPath = path.join(memoryDir(), 'core.manual.md')
  let manual = ''
  try {
    if (fs.existsSync(manualPath)) {
      const { body } = parseFrontmatter(fs.readFileSync(manualPath, 'utf-8'))
      manual = String(body || '').trim().slice(0, 300)
    }
  } catch { /* 人工块读不到就不带，不影响生成 */ }
  if (!rows.length && !manual) {
    return { ok: false, missing: true, chars: 0, dropped: 0 }
  }
  // 预留标题/说明约 80 字，正文按 720 排
  const src = coreBudgetSource()
  const budget = src.value
  const rendered = renderCore(rows, { budget: budget - 80, prefix: manual })
  const header = [
    '---',
    'id: core',
    '类型: 核心',
    `预算: ${budget}`,
    `生成: '${localIso(new Date())}'`,
    '---',
    '# 方寸记忆核心（固定注入，≤' + budget + ' 字）',
    '',
    '> 自动生成，勿手改。改 `memory/claims/` 里的 `钉住` / `重要度`；完整原文用 memory_read。',
    '',
  ].join('\n')
  const text = header + rendered.text + '\n'
  // ⚠ 预算不可信（纯 Node / 无 electron 读不到 prefs）时**不写盘**：
  //   否则会把用户在设置页设的 4000 覆盖成默认 800，下次真机又改回来 —— 来回抖。
  //   这时返回 ok:true 但不动文件，调用方读到的还是原来那份（它按原预算排的）。
  if (src.trusted) atomicWrite(path.join(memoryDir(), 'core.md'), text)
  return { ok: true, missing: false, chars: rendered.chars + 80, dropped: rendered.dropped }
}

export interface MemoryBriefingItem {
  id: string
  type: string
  impact: string
  project: string
  time: string
  title: string
  summary: string
  claim: string
  confidence: number
  importance: number
  score: number
  file: string
  legacy: boolean
  /** 复核日期（frontmatter `复核`）；未填 = 空串 */
  review: string
  /** 距复核日已过多少天（未填 / 认不出 = null，绝不当 0） */
  reviewAgeDays: number | null
  /** 是否已超过复核周期（默认 180 天）—— 见 REVIEW_DAYS */
  reviewOverdue: boolean
}

/** 复核周期（天）。规划 §3.3 写的是「>180 天在简报里标待复核」。 */
export const REVIEW_DAYS = 180

/**
 * 复核日期距今多少天；**认不出就返回 null，绝不当 0**。
 *
 * 为什么单独一个函数：本仓栽过「认不出的时间被当成 0 → 1970 年 → 晾了 20000 天」，
 * 那会让每一条老记忆都被标成"待复核"，提示等于噪音，人会顺手忽略它。
 * null 的语义是"不知道"，界面上要说"没有复核日期"，不是"刚刚复核过"。
 */
export function reviewAgeDays(review: string, now: number): number | null {
  const s = String(review || '').trim()
  if (!s) return null
  // 只认 YYYY-MM-DD / ISO8601；`2026-11-20` 当本地日 00:00
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((now - t) / 86400000))
}

/**
 * 开工简报：**这个项目**有效记忆里最该先看的几条（项目专属 + 跨项目）。
 *
 * 默认 5 条、上限 20；只给 claim/指针，正文用 memory_read 取。
 * 排序：本项目优先 → 重要度 → 新鲜度 → 时间（由 rankMemories 统一算）。
 */
export function memoryBriefing(project: string, limit = 5): {
  project: string
  total: number
  returned: number
  truncated: boolean
  dropped: number
  chars: number
  items: MemoryBriefingItem[]
} {
  const p = String(project || '').trim()
  const all = scanEntries().filter((r) => {
    if (r.status !== '有效') return false
    const cross = r.project === '跨项目' || String(r.scope || '').includes('跨项目')
    return cross || (!!p && r.project === p)
  })
  const ranked = rankMemories(all, {
    project: p,
    projectFirst: true,
    limit: clamp(Math.round(numOr(limit, 5)), 1, 20),
    maxChars: MEMORY_BUDGETS.briefing,
    minScore: 0,
  })
  const briefingItems = ranked.rows
  try { recordMemoryUsage('briefing', briefingItems.map((x) => x.item.id), '') } catch { /* 静默 */ }
  const items = ranked.rows.map((x) => {
    const age = reviewAgeDays(x.item.review, Date.now())
    return {
      id: x.item.id,
      type: x.item.type,
      impact: x.item.impact,
      project: x.item.project,
      time: x.item.time,
      title: x.item.claim,
      summary: x.item.claim,
      claim: x.item.claim,
      confidence: x.item.confidence,
      importance: x.item.importance,
      score: x.score,
      file: x.item.file,
      legacy: x.item.legacy,
      review: String(x.item.review || ''),
      reviewAgeDays: age,
      reviewOverdue: age !== null && age > REVIEW_DAYS,
    }
  })
  return {
    project: p,
    total: ranked.total,
    returned: items.length,
    truncated: ranked.truncated,
    dropped: ranked.dropped,
    chars: ranked.chars,
    items,
  }
}

/**
 * 读一条的原文（检索只给指针，正文按需取）。
 *
 * `anchor`：只取证据文件里 `## <anchor>` 那一节；找不到就报错，**不静默返回全文**
 * （否则又变成"读 2.9KB 找一句话"）。
 *
 * 默认上限 8,000 字符；截断必须在返回值里明说，不许静默少给。
 */
export function readMemory(file: string, maxChars: number = MEMORY_BUDGETS.read, anchor = ''): {
  ok: boolean
  text?: string
  error?: string
  chars?: number
  truncated?: boolean
  claim?: string
  evidence?: string
  evidencePath?: string
  anchor?: string
} {
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
    const raw = fs.readFileSync(real, 'utf-8')
    const { body } = parseFrontmatter(raw)
    const claim = oneLine(section(body, '记忆') || titleAndSummary(body).title)
    const evidence = lastSection(body, '证据')
    let text = raw
    let usedAnchor = ''
    if (String(anchor || '').trim()) {
      const want = String(anchor).trim()
      const lines = raw.split(/\r?\n/)
      const at = lines.findIndex((l) => new RegExp(`^#{1,3}\\s*${escapeRegExp(want)}(\\s|$|[·:：])`).test(l.trim()))
      if (at < 0) {
        return { ok: false, error: `锚点不存在：${want}（不会静默返回全文）` }
      }
      let end = lines.length
      for (let i = at + 1; i < lines.length; i++) {
        if (/^#{1,3}\s+/.test(lines[i])) { end = i; break }
      }
      text = lines.slice(at, end).join('\n').trim()
      usedAnchor = want
    }
    const cap = Math.min(Math.max(1000, Number(maxChars) || MEMORY_BUDGETS.read), 200000)
    if (text.length > cap) {
      return {
        ok: true, text: text.slice(0, cap), chars: text.length, truncated: true,
        claim, evidence, evidencePath: extractedEvidencePath(raw), anchor: usedAnchor,
      }
    }
    return {
      ok: true, text, chars: text.length, truncated: false,
      claim, evidence, evidencePath: extractedEvidencePath(raw), anchor: usedAnchor,
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

function extractedEvidencePath(raw: string): string {
  const { fm } = parseFrontmatter(raw)
  return String(fm['证据'] || '')
}

function escapeRegExp(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 概览：给界面与 MCP 一句话现状（空库要说得清「还没录」而不是「0 条」） */
export function memoryOverview() {
  const rows = scanEntries()
  const byType: Record<string, number> = {}
  const byProject: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  for (const r of rows) {
    byType[r.type || '(未标类型)'] = (byType[r.type || '(未标类型)'] || 0) + 1
    const proj = String(r.project || '').trim() || '通用 / 全局'
    byProject[proj] = (byProject[proj] || 0) + 1
    const st = String(r.status || '(未标状态)')
    byStatus[st] = (byStatus[st] || 0) + 1
  }
  const pendingRows = rows
    .filter((r) => r.status === '待审批')
    .sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')))
  const pendingLatest = pendingRows[0]
    ? { file: pendingRows[0].file, claim: pendingRows[0].claim, project: pendingRows[0].project || '', time: pendingRows[0].time || '' }
    : null
  const core = memoryCore()
  return {
    total: rows.length,
    effective: rows.filter((r) => r.status === '有效').length,
    pending: rows.filter((r) => r.status === '待审批').length,
    revoked: rows.filter((r) => r.status === '已撤销').length,
    claims: rows.filter((r) => r.format === 2).length,
    legacy: rows.filter((r) => r.legacy).length,
    evidence: countEvidence(),
    pinned: rows.filter((r) => r.pinned && r.status === '有效').length,
    coreChars: core.chars,
    coreBudget: core.budget,
    byType,
    /** 项目 → 条数；空项目记在「通用 / 全局」 */
    byProject,
    byStatus,
    /** 可按项目筛选的清单（不含全局） */
    projects: Object.keys(byProject).filter((p) => p !== '通用 / 全局').sort((a, b) => a.localeCompare(b, 'zh')),
    /** 最新一条待审批（置顶条/系统通知用；不给就不编） */
    pendingLatest,
    dir: memoryDir(),
    hint: rows.length
      ? ''
      : '记忆库还没有任何条目 —— 这不是“筛出来没有”，是还没录过。一条一句 claim + 一段证据。',
  }
}

/** 体检：迁移/写坏时给出逐条问题，不静默。 */
export function memoryCheck(): {
  ok: boolean
  issues: string[]
  counts: { total: number; claims: number; legacy: number; evidence: number; pinned: number }
} {
  const rows = scanEntries()
  const issues: string[] = []
  const seenIds = new Map<string, string>()
  for (const r of rows) {
    const at = r.file
    if (!r.claim || !String(r.claim).trim()) issues.push(`${at}: claim 为空`)
    if (String(r.claim || '').length > MEMORY_BUDGETS.claimHard) {
      issues.push(`${at}: claim ${String(r.claim).length} 字，超过硬上限 ${MEMORY_BUDGETS.claimHard}`)
    }
    if (!String(r.evidence || '').trim()) issues.push(`${at}: 证据为空（原文/摘录至少要有一样）`)
    if (r.confidence < 0 || r.confidence > 1) issues.push(`${at}: 可信度 ${r.confidence} 不在 0–1`)
    if (r.importance < 1 || r.importance > 5) issues.push(`${at}: 重要度 ${r.importance} 不在 1–5`)
    if (r.legacy) issues.push(`${at}: 还是 v1 格式（缺 格式:2 / ## 记忆），需要迁移`)
    if (r.evidencePath) {
      const ep = path.resolve(path.join(getDataDir(), r.evidencePath))
      const root = path.resolve(memoryDir())
      if (!ep.startsWith(root + path.sep)) issues.push(`${at}: 证据路径逃出 memory/`)
      else if (!fs.existsSync(ep)) issues.push(`${at}: 证据文件不存在 ${r.evidencePath}`)
    }
    if (r.supersedes && !rows.some((x) => x.id === r.supersedes)) {
      issues.push(`${at}: 取代的 id 不存在 ${r.supersedes}`)
    }
    if (r.id) {
      if (seenIds.has(r.id)) issues.push(`${at}: id 重复（${seenIds.get(r.id)}）`)
      else seenIds.set(r.id, at)
    }
  }
  // 重复 claim：两两比，30 条量级足够
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const s = similarity(rows[i].claim, rows[j].claim)
      if (s >= MEMORY_BUDGETS.dedupe) {
        issues.push(`${rows[i].file} 与 ${rows[j].file} 疑似重复（${Math.round(s * 100)}%）`)
      }
    }
  }
  const core = memoryCore()
  if (!core.missing && core.chars > core.budget) {
    issues.push(`memory/core.md ${core.chars} 字，超过预算 ${core.budget}`)
  }
  return {
    ok: issues.length === 0,
    issues,
    counts: {
      total: rows.length,
      claims: rows.filter((r) => r.format === 2).length,
      legacy: rows.filter((r) => r.legacy).length,
      evidence: countEvidence(),
      pinned: rows.filter((r) => r.pinned && r.status === '有效').length,
    },
  }
}

// ── 写（2026-11-18 暮雨：“记忆页必须开放写，不然出问题用户想改都改不了”）─────
//
// 但**不是**把"摘要式随手记"放进来（那正是这条功能要治的病）。所以写入必填：
//   类型 / claim / 证据 / 来源 —— 缺一个就拒，并说清缺哪个（不许糊默认值）。

export interface MemoryInput {
  type: string
  /** v2：一句话索引（必填；旧字段 title 作别名） */
  claim?: string
  /** v1 兼容别名 */
  title?: string
  /** v2：证据/原文（必填；旧字段 body 作别名） */
  evidence?: string
  /** v1 兼容别名 */
  body?: string
  source: string
  confidence?: number
  importance?: number
  halfLife?: number
  pinned?: boolean
  weight?: number
  time?: string
  project?: string
  scope?: string
  review?: string
  status?: string
  impact?: string
  tags?: string[]
  approvalNote?: string
  supersedes?: string
  code?: string
  evidencePath?: string
  evidenceAnchor?: string
}

export interface MemoryWriteResult {
  ok: boolean
  error?: string
  file?: string
  id?: string
  claim?: string
  /** 疑似重复时返回已有条目，让调用方告诉用户（不自动合并） */
  duplicate?: { id: string; claim: string; file: string; similarity: number }
}

export interface MemoryWriteOptions {
  /** true = agent 提案，强制落「待审批」；用户从界面新建时不传 */
  pending?: boolean
  /** 用户确认"仍然要记"时跳过查重（agent 没有这个口） */
  force?: boolean
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

/** 本地时区 ISO8601（带 `+08:00` 这类偏移）；不要用 toISOString() 写 UTC */
function localIso(d: Date): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    + `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    + `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

/** 手写 frontmatter（**不引 yaml**；与 parseFrontmatter 对称） */
function renderEntry(input: {
  type: string
  claim: string
  evidence: string
  source: string
  confidence: number
  importance: number
  time: string
  project: string
  scope: string
  status: string
  review: string
  halfLife: number
  pinned: boolean
  weight: number
  supersedes: string
  code: string
  evidencePath: string
  evidenceAnchor: string
  approvalNote: string
  tags: string[]
}, id: string): string {
  const tags = input.tags.length ? `[${input.tags.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')}]` : '[]'
  const one = oneLine
  const lines = [
    '---',
    `id: ${id}`,
    `类型: ${input.type}`,
    `可信度: ${input.confidence}`,
    `重要度: ${input.importance}`,
    `项目: ${one(input.project)}`,
    `适用范围: ${one(input.scope)}`,
    `状态: ${input.status}`,
    `来源: ${one(input.source)}`,
    `时间: ${input.time}`,
  ]
  if (input.review) lines.push(`复核: ${one(input.review)}`)
  lines.push(`半衰期: ${input.halfLife}`)
  lines.push(`钉住: ${input.pinned ? 'true' : 'false'}`)
  lines.push(`召回权重: ${input.weight}`)
  if (input.code) lines.push(`编号: ${one(input.code)}`)
  if (input.supersedes) lines.push(`取代: ${one(input.supersedes)}`)
  if (input.evidencePath) lines.push(`证据: ${one(input.evidencePath)}`)
  if (input.evidenceAnchor) lines.push(`证据锚点: ${one(input.evidenceAnchor)}`)
  if (input.approvalNote) lines.push(`审批备注: ${one(input.approvalNote)}`)
  lines.push(`tags: ${tags}`)
  lines.push('格式: 2')
  lines.push('---')
  lines.push('')
  lines.push('## 记忆')
  lines.push('')
  lines.push(one(input.claim))
  lines.push('')
  lines.push('## 证据')
  lines.push('')
  lines.push(String(input.evidence).replace(/\r\n/g, '\n').replace(/\s+$/, ''))
  lines.push('')
  return lines.join('\n')
}

function validateEvidencePath(raw: string): string | null {
  const p = String(raw || '').trim().replace(/\\/g, '/')
  if (!p) return null
  if (!p.startsWith('memory/')) return '证据路径必须以 memory/ 开头'
  if (p.includes('..')) return '证据路径不许包含 ..'
  return null
}

/**
 * 新建一条记忆。
 *
 * ⚠ 四条硬闸：
 *   ① 类型必须在取值域内；② claim 非空且 ≤200 字；③ 证据非空；④ 来源非空。
 * 路径只从 `memory/claims/` 出发，与 readMemory 同一套 `realpath` 校验。
 */
export function createMemory(raw: MemoryInput, opts: MemoryWriteOptions = {}): MemoryWriteResult {
  const type = normType(raw?.type)
  if (!type) return { ok: false, error: `类型必须是这五种之一：${MEMORY_TYPES.join(' / ')}` }
  const claim = oneLine(raw?.claim !== undefined ? raw.claim : raw?.title)
  if (!claim) return { ok: false, error: 'claim/标题不能空 —— 这条记忆要能被单独读懂' }
  if (claim.length > MEMORY_BUDGETS.claimHard) {
    return { ok: false, error: `claim ${claim.length} 字，超过硬上限 ${MEMORY_BUDGETS.claimHard}；请拆成多条或把细节放证据` }
  }
  const evidence = String(raw?.evidence !== undefined ? raw.evidence : raw?.body || '').trim()
  if (!evidence) return { ok: false, error: '证据/原文不能空 —— 只存一句话等于没记（细节就是价值本体）' }
  const source = String(raw?.source || '').trim()
  if (!source) return { ok: false, error: '来源不能空 —— 说不清从哪来的记忆，下次没人敢信它' }

  const evidenceErr = validateEvidencePath(String(raw?.evidencePath || ''))
  if (evidenceErr) return { ok: false, error: evidenceErr }

  // 查重：agent 不能 force；用户界面在"仍然要记"时才传 force
  if (!opts.force) {
    const dup = findDuplicate(claim, scanEntries().filter((r) => r.status !== '已撤销'))
    if (dup) {
      return {
        ok: false,
        error: `疑似重复：已有「${dup.item.claim}」（${Math.round(dup.similarity * 100)}% 像）`,
        duplicate: { id: dup.item.id, claim: dup.item.claim, file: dup.item.file, similarity: dup.similarity },
      }
    }
  }

  // 取代的 id 必须存在；否则落一条悬空链
  const supersedes = String(raw?.supersedes || '').trim()
  if (supersedes && !scanEntries().some((r) => r.id === supersedes)) {
    return { ok: false, error: `取代的 id 不存在：${supersedes}` }
  }

  const status = opts.pending ? '待审批' : '有效'
  let confidence = numOr(raw?.confidence, 0.7)
  // agent 提案的可信度不许自己封顶到 1；用户可以在记忆页改
  if (opts.pending) confidence = Math.min(confidence, 0.8)
  const importance = importanceOf(raw?.importance)
  const halfLife = raw?.halfLife !== undefined ? numOr(raw.halfLife, defaultHalfLife(type)) : defaultHalfLife(type)
  const pinned = boolOf(raw?.pinned, false)
  const weight = weightOf(raw?.weight)

  const now = new Date()
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`
  const dir = claimsDir()
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e: any) {
    return { ok: false, error: `建目录失败：${e?.message || e}` }
  }
  const root = path.resolve(memoryDir())
  let seq = nextSeq(dir, stamp)
  for (let attempt = 0; attempt < 50; attempt++, seq++) {
    const id = `mem-${stamp}-${pad2(seq)}`
    const full = path.join(dir, `${id}.md`)
    const real = path.resolve(full)
    if (!real.startsWith(root + path.sep)) return { ok: false, error: '路径逃出了 memory/（拒绝）' }
    if (fs.existsSync(full)) continue
    const text = renderEntry({
      type, claim, evidence, source,
      confidence: clamp(Math.round(confidence * 100) / 100, 0, 1),
      importance,
      time: raw.time ? String(raw.time) : localIso(now),
      project: String(raw.project || ''), scope: String(raw.scope || ''),
      status,
      review: String(raw.review || ''),
      halfLife,
      pinned,
      weight,
      supersedes,
      code: String(raw.code || ''),
      evidencePath: String(raw.evidencePath || ''),
      evidenceAnchor: String(raw.evidenceAnchor || ''),
      approvalNote: String(raw.approvalNote || ''),
      tags: Array.isArray(raw.tags) ? raw.tags.map((x) => String(x)).filter(Boolean) : [],
    }, id)
    try {
      atomicWrite(full, text)
    } catch (e: any) {
      return { ok: false, error: `写入失败：${e?.message || e}` }
    }
    return { ok: true, file: path.relative(getDataDir(), full).replace(/\\/g, '/'), id, claim }
  }
  return {
    ok: false,
    error: `今天的序号 ${nextSeq(dir, stamp)} 起连续 50 个都被占用 —— 请稍后重试（绝不覆盖已有记忆）`,
  }
}

/**
 * 改一条记忆的整段（界面上的"编辑"）。
 *
 * v2：claim 与证据一起改；`title`/`body` 作为旧字段别名保留。
 * ⚠ 不做"部分字段合并"：记忆是**一份原文**，合并字段只会造出"半新半旧"的第四条记忆。
 */
export function updateMemory(file: string, raw: MemoryInput): MemoryWriteResult {
  const gate = readMemory(file, 200000)
  if (!gate.ok) return { ok: false, error: gate.error || '读不到这一条' }
  const rel = String(file || '').trim().replace(/\\/g, '/')
  const full = path.resolve(path.join(getDataDir(), rel))
  const root = path.resolve(memoryDir())
  if (!full.startsWith(root + path.sep)) return { ok: false, error: '路径逃出了 memory/（拒绝）' }

  const src = String(gate.text || '')
  const { fm } = parseFrontmatter(src)
  const oldTitle = titleAndSummary(parseFrontmatter(src).body)
  const oldClaim = oneLine(section(parseFrontmatter(src).body, '记忆') || oldTitle.title)
  const oldEvidence = section(parseFrontmatter(src).body, '证据') || parseFrontmatter(src).body.trim()

  const type = normType(String(raw?.type || fm['类型'] || ''))
  if (!type) return { ok: false, error: `类型必须是这五种之一：${MEMORY_TYPES.join(' / ')}` }
  const claim = oneLine(raw?.claim !== undefined ? raw.claim : (raw?.title !== undefined ? raw.title : oldClaim))
  if (!claim) return { ok: false, error: 'claim/标题不能空 —— 改着改着变成空条目，比不改更糟' }
  if (claim.length > MEMORY_BUDGETS.claimHard) {
    return { ok: false, error: `claim ${claim.length} 字，超过硬上限 ${MEMORY_BUDGETS.claimHard}` }
  }
  const evidence = String(raw?.evidence !== undefined ? raw.evidence : (raw?.body !== undefined ? raw.body : oldEvidence)).trim()
  if (!evidence) return { ok: false, error: '证据/原文不能空 —— 改着改着变成空条目，比不改更糟' }
  const source = String(raw?.source !== undefined ? raw.source : (fm['来源'] || '')).trim()
  if (!source) return { ok: false, error: '来源不能空' }

  const evidencePath = raw.evidencePath !== undefined ? String(raw.evidencePath) : String(fm['证据'] || '')
  const evidenceErr = validateEvidencePath(evidencePath)
  if (evidenceErr) return { ok: false, error: evidenceErr }

  const id = String(fm['id'] || path.basename(rel, '.md'))
  const text = renderEntry({
    type,
    claim,
    evidence,
    source,
    confidence: clamp(Math.round(numOr(raw.confidence !== undefined ? raw.confidence : fm['可信度'], 0.7) * 100) / 100, 0, 1),
    importance: raw.importance !== undefined ? importanceOf(raw.importance) : importanceOf(fm['重要度'] || inferImportance(fm['影响'])),
    time: String(raw.time !== undefined ? raw.time : (fm['时间'] || localIso(new Date()))),
    project: String(raw.project !== undefined ? raw.project : (fm['项目'] || '')),
    scope: String(raw.scope !== undefined ? raw.scope : (fm['适用范围'] || '')),
    status: String(raw.status !== undefined && (MEMORY_STATUSES as readonly string[]).includes(String(raw.status))
      ? raw.status : (fm['状态'] || '有效')),
    review: String(raw.review !== undefined ? raw.review : (fm['复核'] || '')),
    halfLife: numOr(raw.halfLife !== undefined ? raw.halfLife : fm['半衰期'], defaultHalfLife(type)),
    pinned: raw.pinned !== undefined ? boolOf(raw.pinned, false) : boolOf(fm['钉住'], false),
    weight: weightOf(raw.weight !== undefined ? raw.weight : fm['召回权重']),
    supersedes: String(raw.supersedes !== undefined ? raw.supersedes : (fm['取代'] || '')),
    code: String(raw.code !== undefined ? raw.code : (fm['编号'] || '')),
    evidencePath,
    evidenceAnchor: String(raw.evidenceAnchor !== undefined ? raw.evidenceAnchor : (fm['证据锚点'] || '')),
    approvalNote: String(raw.approvalNote !== undefined ? raw.approvalNote : (fm['审批备注'] || '')),
    tags: Array.isArray(raw.tags) ? raw.tags.map((x) => String(x)).filter(Boolean)
      : (Array.isArray(fm['tags']) ? fm['tags'].map((x: any) => String(x)) : []),
  }, id)
  try {
    atomicWrite(full, text)
  } catch (e: any) {
    return { ok: false, error: `写入失败：${e?.message || e}` }
  }
  return { ok: true, file: rel, id, claim }
}

/** 就地替换/插入 frontmatter 行；**不动正文一个字** */
function patchFrontmatter(src: string, updates: Record<string, string>): string {
  let next = String(src || '')
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${escapeRegExp(k)}:.*$`, 'm')
    if (re.test(next)) {
      next = next.replace(re, () => `${k}: ${v}`)
    } else {
      const m = [...next.matchAll(/^---\s*$/gm)]
      if (m.length < 2) throw new Error('这条没有 frontmatter —— 不敢乱插，请手工修')
      const at = m[0].index! + m[0][0].length
      next = next.slice(0, at) + `\n${k}: ${v}` + next.slice(at)
    }
  }
  return next
}

function writeStatus(file: string, status: string, note: string, extra: Record<string, string> = {}): MemoryWriteResult {
  const gate = readMemory(file, 200000)
  if (!gate.ok) return { ok: false, error: gate.error || '读不到这一条' }
  const rel = String(file || '').trim().replace(/\\/g, '/')
  const full = path.resolve(path.join(getDataDir(), rel))
  const root = path.resolve(memoryDir())
  if (!full.startsWith(root + path.sep)) return { ok: false, error: '路径逃出了 memory/（拒绝）' }
  const src = String(gate.text || '')
  const updates: Record<string, string> = { 状态: status, ...extra }
  if (note && status === '已撤销') updates['审批备注'] = note
  let next = ''
  try {
    next = patchFrontmatter(src, updates)
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
  if (next === src) return { ok: true, file: rel } // 幂等
  try {
    atomicWrite(full, next)
  } catch (e: any) {
    return { ok: false, error: `写入失败：${e?.message || e}` }
  }
  return { ok: true, file: rel }
}

/**
 * 撤销 / 恢复 / 通过一条记忆（REV-015：得能标记"这条后来被推翻了"）。
 *
 * ⚠ **撤销≠删除**：文件不动，只改 frontmatter 的 `状态`。
 * ⚠ 通过一条带 `取代` 的记忆时，被取代的那条一并标「已撤销 + 被取代」，不删除。
 */
export function setMemoryStatus(file: string, status: string, reason = ''): MemoryWriteResult {
  const st = String(status || '').trim()
  if (!(MEMORY_STATUSES as readonly string[]).includes(st)) {
    return { ok: false, error: `状态只能是：${MEMORY_STATUSES.join(' / ')}` }
  }
  const note = String(reason || '').replace(/\s*\r?\n\s*/g, ' ').trim()
  const res = writeStatus(file, st, note)
  if (!res.ok) return res

  if (st === '有效') {
    try {
      const gate = readMemory(file, 200000)
      if (gate.ok) {
        const { fm } = parseFrontmatter(String(gate.text || ''))
        const oldId = String(fm['取代'] || '')
        const newId = String(fm['id'] || '')
        if (oldId && newId) {
          const old = scanEntries().find((r) => r.id === oldId && r.file !== String(file).replace(/\\/g, '/'))
          if (old && old.status !== '已撤销') {
            writeStatus(old.file, '已撤销', '被新记忆取代', { 被取代: newId })
          }
        }
      }
    } catch { /* 取代链修不上不影响本条通过；memoryCheck 会报 */ }
  }
  return res
}

// ── 批量改字段（2026-11-20）────────────────────────────────────────────
// 暮雨：「强化记忆条目可筛选性和批量编辑性（如按项目分类、全局类）」。
// 只改 frontmatter 的**分类/标签/参数**，一个字都不碰 `## 记忆` / `## 证据` 正文；
// 也不改状态（通过/驳回走 memorySetStatus，语义分开）。
export interface MemoryBatchPatch {
  type?: string
  /** 空串 = 改成通用 / 全局 */
  project?: string
  scope?: string
  /** 空数组 = 清空标签 */
  tags?: string[]
  importance?: number
  confidence?: number
  pinned?: boolean
}

export interface MemoryBatchResult {
  ok: boolean
  updated: number
  failed: Array<{ file: string; error: string }>
  error?: string
}

export function batchUpdateMemory(files: string[], raw: MemoryBatchPatch = {}): MemoryBatchResult {
  const list = (Array.isArray(files) ? files : []).map((f) => String(f || '').trim()).filter(Boolean)
  if (!list.length) return { ok: false, updated: 0, failed: [], error: '没选条目' }
  if (list.length > 500) return { ok: false, updated: 0, failed: [], error: '一次最多改 500 条' }
  const keys: Array<keyof MemoryBatchPatch> = ['type', 'project', 'scope', 'tags', 'importance', 'confidence', 'pinned']
  if (!keys.some((k) => raw[k] !== undefined)) {
    return { ok: false, updated: 0, failed: [], error: '没有要改的字段' }
  }

  const root = path.resolve(memoryDir())
  const failed: Array<{ file: string; error: string }> = []
  let updated = 0
  for (const file of list) {
    const gate = readMemory(file, 200000)
    if (!gate.ok) { failed.push({ file, error: gate.error || '读不到' }); continue }
    const rel = String(file).replace(/\\/g, '/')
    const full = path.resolve(path.join(getDataDir(), rel))
    if (!full.startsWith(root + path.sep)) { failed.push({ file, error: '路径逃出了 memory/（拒绝）' }); continue }
    const updates: Record<string, string> = {}
    if (raw.type !== undefined) {
      const t = normType(raw.type)
      if (!t) { failed.push({ file, error: `类型必须是：${MEMORY_TYPES.join(' / ')}` }); continue }
      updates['类型'] = t
    }
    if (raw.project !== undefined) updates['项目'] = oneLine(raw.project)
    if (raw.scope !== undefined) updates['适用范围'] = oneLine(raw.scope)
    if (raw.tags !== undefined) {
      const tags = (Array.isArray(raw.tags) ? raw.tags : []).map((x) => String(x).trim()).filter(Boolean)
      updates.tags = tags.length ? `[${tags.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')}]` : '[]'
    }
    if (raw.importance !== undefined) updates['重要度'] = String(importanceOf(raw.importance))
    if (raw.confidence !== undefined) {
      const n = Number(raw.confidence)
      if (!Number.isFinite(n)) { failed.push({ file, error: '可信度不是数字' }); continue }
      updates['可信度'] = String(clamp(Math.round(n * 100) / 100, 0, 1))
    }
    if (raw.pinned !== undefined) updates['钉住'] = raw.pinned ? 'true' : 'false'
    try {
      const next = patchFrontmatter(String(gate.text || ''), updates)
      if (next !== gate.text) atomicWrite(full, next)
      updated++
    } catch (e: any) {
      failed.push({ file, error: String(e?.message || e) })
    }
  }
  return {
    ok: failed.length === 0,
    updated,
    failed,
    error: failed.length ? `${failed.length} 条没改成：${failed[0].error}` : undefined,
  }
}

// ── 导入 / 一键整理（2026-11-20 问卷 M5 A + M1 B）────────────────────────
//
// 两条硬规矩：
//   ① 导入与模型整理都只落 `待审批`，不直接生效；用户点通过才算数。
//   ② 每一条都必须带来源；重复默认跳过，不覆盖已有记忆。
//
// ⚠ 一键整理只在用户配置了模型时工作（BYOK，不内置默认端点）。没配就如实报错，
//   不拿规则拼一段假“AI 总结”糊弄。

export interface MemoryImportInput {
  text?: string
  format?: string
  source?: string
  project?: string
  type?: string
}

export interface MemoryImportResult {
  ok: boolean
  error?: string
  imported: number
  skipped: number
  errors: string[]
  files: string[]
}

function asTags(v: any): string[] {
  if (Array.isArray(v)) return v.map((x) => oneLine(x)).filter(Boolean)
  if (typeof v === 'string') return v.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
  return []
}

function jsonImportEntries(text: string): any[] {
  const raw = JSON.parse(text)
  if (Array.isArray(raw)) return raw
  if (raw && Array.isArray(raw.memories)) return raw.memories
  if (raw && Array.isArray(raw.items)) return raw.items
  if (raw && Array.isArray(raw.data)) return raw.data
  if (raw && typeof raw === 'object') return [raw]
  return []
}

function importItemToInput(item: any, fallback: { source: string; project: string; type: string }): MemoryInput {
  const claim = oneLine(item?.claim ?? item?.title ?? item?.['记忆'] ?? item?.['一句话'])
  const evidence = String(item?.evidence ?? item?.body ?? item?.['证据'] ?? item?.['原文'] ?? '').trim()
  const source = oneLine(item?.source ?? item?.['来源'] ?? fallback.source)
  const type = normType(String(item?.type ?? item?.['类型'] ?? fallback.type)) || '教训'
  return {
    type,
    claim,
    evidence,
    source,
    confidence: numOr(item?.confidence ?? item?.['可信度'], 0.7),
    importance: importanceOf(item?.importance ?? item?.['重要度']),
    project: oneLine(item?.project ?? item?.['项目'] ?? fallback.project),
    tags: asTags(item?.tags),
    evidencePath: String(item?.evidencePath ?? item?.['证据路径'] ?? '').trim() || undefined,
  }
}

function markdownImportEntry(text: string, fallback: { source: string; project: string; type: string }): { input?: MemoryInput; error?: string } {
  const { fm, body } = parseFrontmatter(text)
  const claim = oneLine(section(body, '记忆') || section(body, '一句话') || fm['claim'] || fm['标题'])
  const evidence = String(
    lastSection(body, '证据') || lastSection(body, '原文') || fm['证据'] || fm['原文'] || ''
  ).trim()
  const source = oneLine(fm['来源'] || fm['source'] || fallback.source)
  const type = normType(String(fm['类型'] || fm['type'] || fallback.type)) || '教训'
  if (!claim) return { error: 'Markdown 里没找到「## 记忆」或「## 一句话」' }
  if (!evidence) return { error: 'Markdown 里没找到「## 证据」或「## 原文」' }
  if (!source) return { error: 'Markdown 没有来源（frontmatter 的「来源」，或导入框里的来源）' }
  return {
    input: {
      type,
      claim,
      evidence,
      source,
      confidence: numOr(fm['可信度'] ?? fm['confidence'], 0.7),
      importance: importanceOf(fm['重要度'] ?? fm['importance']),
      project: oneLine(fm['项目'] ?? fm['project'] ?? fallback.project),
      tags: asTags(fm['tags']),
      evidencePath: String(fm['证据'] ?? fm['evidencePath'] ?? '').trim() || undefined,
    },
  }
}

/** 手动导入：JSON 数组 / 一条 v2 Markdown；全部落待审批，重复跳过 */
export function importMemories(raw: MemoryImportInput): MemoryImportResult {
  const text = String(raw?.text || '').trim()
  const empty: MemoryImportResult = { ok: false, imported: 0, skipped: 0, errors: [], files: [] }
  if (!text) return { ...empty, error: '导入内容为空' }
  const fallback = {
    source: String(raw?.source || '').trim(),
    project: String(raw?.project || '').trim(),
    type: String(raw?.type || '教训').trim(),
  }
  const format = String(raw?.format || 'auto')
  const entries: MemoryInput[] = []
  const errors: string[] = []
  const looksJson = text.startsWith('[') || text.startsWith('{')
  try {
    if (format === 'json' || (format === 'auto' && looksJson)) {
      const arr = jsonImportEntries(text)
      if (!arr.length) return { ...empty, error: 'JSON 里没有可导入的记忆条目' }
      for (const item of arr) entries.push(importItemToInput(item, fallback))
    } else {
      const one = markdownImportEntry(text, fallback)
      if (one.error) errors.push(one.error)
      if (one.input) entries.push(one.input)
    }
  } catch (e: any) {
    return { ...empty, error: 'JSON 解析失败：' + String(e?.message || e) }
  }
  if (!entries.length) {
    return { ...empty, errors, error: errors[0] || '没解析出可导入的记忆' }
  }
  let imported = 0
  let skipped = 0
  const files: string[] = []
  entries.forEach((input, i) => {
    const r = createMemory(input, { pending: true })
    if (r.ok) {
      imported++
      if (r.file) files.push(r.file)
    } else {
      skipped++
      errors.push(`第 ${i + 1} 条：${r.error || '写入失败'}`)
    }
  })
  if (imported) {
    try { rebuildIndex() } catch { /* 索引失败不影响已写入 */ }
  }
  return {
    ok: imported > 0,
    imported,
    skipped,
    errors,
    files,
    error: imported ? undefined : (errors[0] || '一条都没导入'),
  }
}

export interface MemorySource {
  id: string
  project: string
  title: string
  text: string
}

/** 从最近日志 + 已完成/驳回任务里取候选（每条截断，避免把整本日志塞进提示词） */
export function collectMemorySources(project = '', limit = 24): MemorySource[] {
  const out: MemorySource[] = []
  const logs = listLogs(project ? { project } : undefined)
  for (const l of logs) {
    if (out.length >= Math.ceil(limit * 0.7)) break
    const text = [l.title, l.content, l.nextSteps ? '下一步：' + l.nextSteps : '']
      .filter(Boolean).join('\n').slice(0, 1600)
    if (!text.trim()) continue
    out.push({ id: 'log:' + l.id, project: l.project || '', title: l.title || '未命名日志', text })
  }
  for (const t of loadTasks('all')) {
    if (out.length >= limit) break
    const fm: any = (t as any).fm || {}
    const st = String(fm.status || '')
    if (st !== '完成' && st !== '驳回') continue
    if (project && String(fm.project || '') !== project) continue
    const text = [fm.title, '状态：' + st, (t as any).body, fm.result_log]
      .filter(Boolean).join('\n').slice(0, 1600)
    if (!text.trim()) continue
    out.push({ id: 'task:' + (t as any).id, project: String(fm.project || ''), title: String(fm.title || '未命名任务'), text })
  }
  return out
}

export interface MemoryOrganizeInput {
  project?: string
  limit?: number
}

export interface MemoryOrganizeDeps {
  /** 测试注入来源；默认 collectMemorySources */
  sources?: MemorySource[]
}

export interface MemoryOrganizeResult {
  ok: boolean
  error?: string
  mode: 'handoff'
  prompt: string
  sources: MemorySource[]
  count: number
}

/**
 * 一键整理（2026-11-20 13:40 暮雨：全走 DSH，方寸逐步取消内置 key）。
 *
 * **不调模型、不写盘**：只把候选来源拼成一份给 DSH 的整理包，由 DSH agent
 * 用 `memory_write` 逐条起草（只能落「待审批」），用户再审批。
 * 这样方寸不需要任何 API Key，也不会出现“模型抽错还自信”的静默写入。
 */
export function organizeMemories(
  input: MemoryOrganizeInput = {},
  deps: MemoryOrganizeDeps = {}
): MemoryOrganizeResult {
  const sources = (deps.sources || collectMemorySources(input.project || '', input.limit || 24)).slice(0, 24)
  if (!sources.length) {
    return { ok: false, mode: 'handoff', prompt: '', sources: [], count: 0, error: '最近没有可整理的日志或已完成任务' }
  }
  const prompt = [
    '你是 DSH 里的方寸记忆整理助手。任务：从下面候选来源里提炼记忆，并逐条调用方寸 MCP 的 memory_write 写入。',
    '',
    '硬规矩（违反任何一条就不要写）：',
    '1. 每条只能落「待审批」；memory_write 会强制 pending，不许绕过。',
    '2. source 必须逐字等于下面某个 [source] 的 id；找不到来源的不要写。',
    '3. claim 是 1–2 句、能单独读懂的索引句（≤120 字）；evidence 从候选原文逐字摘录，不许编。',
    '4. 最多 8 条；重复的、证据不足的、不确定的不要写；不要修改已有记忆、不要写盘。',
    '5. 写完后报告：写了哪些（claim + source）、跳过了哪些、为什么。',
    '',
    'memory_write 的字段：claim / evidence / source / type（事故|教训|纪律|决定|偏好|事实）/ confidence（0.6–0.8）/ importance（1–5）/ project / tags。',
    '',
    '候选来源：',
    ...sources.map((s) => `\n[source: ${s.id}] 项目: ${s.project || '跨项目'} 标题: ${s.title}\n${s.text}`),
  ].join('\n')
  return { ok: true, mode: 'handoff', prompt, sources, count: sources.length }
}
