/**
 * 作战计划卡（0.6.0 P1 的数据层）
 *
 * 真源：`task-data/plans/<项目id>.md`（P0 已冻结的格式，机检是 `scripts/check-plan-card.py`）。
 * 这一层只做两件事：
 *   ① **读**：把节式 Markdown 拆成阶段卡（技术方案 / 照抄点表 / 判据），缺块要**如实报缺**；
 *   ② **写裁决**：通过 / 打回 / 改一句 —— 全部**行级就地改**，绝不 yaml dump 重写整篇。
 *
 * 为什么坚持行级：计划卡是用户手写的正文（含表格、缩进列表、修订记录）。
 * 用“解析成对象再序列化”会把空行、对齐、表格宽度全洗一遍 —— 那就是"改一个字，diff 三百行"。
 *
 * 三条与 P1 判据对齐的硬约定：
 *   · 缺一块就 `missing` 里点名，界面据此报红，且**不显示"合格"**；
 *   · 打回必须真的写进文件（`打回理由:` 一行），不写就是假动作；
 *   · “改一句”要留痕：修订记录多一行，且状态退回“未冻结”（ADR supersede 的最小版）。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getTaskDir, atomicWrite } from './index'
import { gateForDeck } from './qnGate'
import { queueGateForStage } from './qnQueueGate'
import type { StageGateResult } from '../../shared/stageGate'

export interface PlanStage {
  /** 阶段 id（`P0`/`P1`…，取自标题前缀；没有就退化成标题） */
  id: string
  title: string
  status: string
  what: string
  /** 技术方案：`  - ` 缩进列表的原文行 */
  approach: string[]
  /** 照抄点：表格的行（含表头与分隔线，界面直接渲染） */
  copyRows: string[][]
  /** 判据：`  - ` 缩进列表的原文行（cmd:/str:/num:/file: 前缀） */
  criteria: string[]
  verdict: string
  rejectReason: string
  /** 完成证据引用（P4 判据全过后写：自检时间 / 报告路径 / 命令） */
  evidence: string
  /**
   * 澄清卷名（2026-11-11 · 进队列锁的第二个时点）。
   *
   * `proposeStage` 出厂时必写这一行（它在 `deck` 缺失/未批准时零写入），
   * `writePlanVerdict(pass)` 通过（= 冻结 = 可派）时再查一次 —— 防的是
   * “提案时卷是好的，之后被作废 / 又出现反问”这种时间差。
   * 老阶段块没有这一行 → 不拦（与任务卡同一条过渡口径）。
   */
  clarify: string
  /** 缺了哪几块（技术方案 / 照抄点 / 判据）—— 界面据此报红 */
  missing: string[]
}

export interface PlanDoc {
  file: string
  title: string
  stages: PlanStage[]
  /** 修订记录原文行 */
  revision: string[]
  raw: string
}

const STAGE_HEAD = /^###\s+(P\d+)\s*[·・:：]?\s*(.*)$/
const SECTION_HEAD = /^##\s+/

function plansDir(): string {
  return path.join(getTaskDir(), 'plans')
}

/** 列可读的计划卡（相对 task-data/plans 的文件名） */
export function listPlanFiles(): string[] {
  const dir = plansDir()
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'))
    .sort()
}

/**
 * 停放中的计划卡（`task-data/plans/_parked/`）。
 *
 * 为什么要单独列：`listPlanFiles` 按设计跳过 `_` 前缀，于是 `_parked` 里 11 份、
 * 每份 2 格「待裁决」在 `stage_plan_get {}` 的概览里**完全不存在** ——
 * agent 照实报“0 张等你裁决”，而用户看着那 22 格以为它在偷懒。
 * 停放算不算待裁决是产品判定，但**不许看不见**。
 */
export function listParkedPlanFiles(): string[] {
  const dir = path.join(plansDir(), '_parked')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .sort()
}

/** 停放区汇总（只报数，不展开正文 —— 几十格会把 token 烧光） */
export function parkedPlanSummary(): { files: number; stages: number; pending: number; names: string[] } {
  const names = listParkedPlanFiles()
  let stages = 0
  let pending = 0
  for (const f of names) {
    const d = readPlanFile(path.join('_parked', f))
    if (!d) continue
    stages += d.stages.length
    pending += d.stages.filter((s) => {
      const st = String(s.status || '').trim()
      return st === '待裁决' || st === '待裁决（未冻结）' || st === '未冻结' || !st
    }).length
  }
  return { files: names.length, stages, pending, names }
}

/** 读任意相对 plans 目录的文件（停放区用；`readPlan` 只认顶层） */
export function readPlanFile(rel: string): PlanDoc | null {
  const safe = String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean)
  if (!safe.length || !safe[safe.length - 1].endsWith('.md')) return null
  if (safe.some((s) => s === '..' || s === '.')) return null
  const p = path.join(plansDir(), ...safe)
  if (!fs.existsSync(p)) return null
  return readPlanFromRaw(p, safe[safe.length - 1])
}

/** 表格行 → 单元格（去掉首尾竖线与空白） */
function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return t.split('|').map((c) => c.trim())
}

function parseStage(id: string, title: string, lines: string[]): PlanStage {
  const stage: PlanStage = {
    id, title, status: '', what: '', approach: [], copyRows: [], criteria: [],
    verdict: '', rejectReason: '', evidence: '', clarify: '', missing: [],
  }
  let mode: '' | 'approach' | 'copy' | 'criteria' = ''
  for (const raw of lines) {
    const line = raw
    const t = line.trim()
    if (/^-\s*状态\s*[:：]/.test(t)) { stage.status = t.split(/[:：]/).slice(1).join(':').trim(); mode = ''; continue }
    if (/^-\s*做什么\s*[:：]/.test(t)) { stage.what = t.split(/[:：]/).slice(1).join(':').trim(); mode = ''; continue }
    if (/^-\s*裁决\s*[:：]/.test(t)) { stage.verdict = t.split(/[:：]/).slice(1).join(':').trim(); mode = ''; continue }
    if (/^-\s*打回理由\s*[:：]/.test(t)) { stage.rejectReason = t.split(/[:：]/).slice(1).join(':').trim(); mode = ''; continue }
    if (/^-\s*证据\s*[:：]/.test(t)) { stage.evidence = t.split(/[:：]/).slice(1).join(':').trim(); mode = ''; continue }
    if (/^-\s*澄清\s*[:：]/.test(t)) { stage.clarify = t.split(/[:：]/).slice(1).join(':').trim(); mode = ''; continue }
    if (/^-\s*技术方案\s*[:：]\s*$/.test(t)) { mode = 'approach'; continue }
    if (/^-\s*照抄点\s*[:：]?\s*$/.test(t)) { mode = 'copy'; continue }
    if (/^-\s*判据\s*[:：]?\s*$/.test(t)) { mode = 'criteria'; continue }
    if (mode === 'approach' && /^\s+-\s+/.test(line)) { stage.approach.push(t.replace(/^-\s+/, '')); continue }
    if (mode === 'criteria' && /^\s+-\s+/.test(line)) { stage.criteria.push(t.replace(/^-\s+/, '')); continue }
    if (mode === 'copy' && t.startsWith('|')) { stage.copyRows.push(splitRow(line)); continue }
    // ⚠ 空行**不**打断收集：真实计划卡里 `- 判据:` 与第一条之间常常隔一个空行
    //   （2026-10-31 实测：按"空行即结束"解析，8 张卡全被判成"缺判据"）。
    if (t === '') continue
    // 小节标题 / 下一张卡 / 顶格的其它键 —— 这些才是真正的结束信号
    if (SECTION_HEAD.test(t) || STAGE_HEAD.test(t)) { mode = ''; continue }
    if (!/^\s/.test(line)) mode = ''
  }
  if (!stage.approach.length) stage.missing.push('技术方案')
  // 表格至少要有表头 + 分隔线 + 一行数据（否则等于没有）
  if (stage.copyRows.length < 3) stage.missing.push('照抄点')
  if (!stage.criteria.length) stage.missing.push('判据')
  return stage
}

export function readPlan(file: string): PlanDoc | null {
  const safe = path.basename(String(file || ''))
  if (!safe || !safe.endsWith('.md')) return null
  const p = path.join(plansDir(), safe)
  if (!fs.existsSync(p)) return null
  return readPlanFromRaw(p, safe)
}

/** 解析主体（`readPlan` 与停放区共用；`name` 是回报给界面的文件名） */
function readPlanFromRaw(p: string, name: string): PlanDoc | null {
  const raw = fs.readFileSync(p, 'utf-8')
  const lines = raw.replace(/\r\n/g, '\n').split('\n')

  let title = ''
  const stages: PlanStage[] = []
  const revision: string[] = []
  let i = 0
  // 标题：第一个 `# `
  for (const l of lines) { if (/^#\s+/.test(l)) { title = l.replace(/^#\s+/, '').trim(); break } }
  while (i < lines.length) {
    const m = STAGE_HEAD.exec(lines[i])
    if (!m) { i++; continue }
    let j = i + 1
    while (j < lines.length && !STAGE_HEAD.test(lines[j]) && !SECTION_HEAD.test(lines[j])) j++
    stages.push(parseStage(m[1], (m[2] || '').trim(), lines.slice(i + 1, j)))
    i = j
  }
  const rStart = lines.findIndex((l) => /^##\s*修订记录/.test(l))
  if (rStart >= 0) {
    for (let k = rStart + 1; k < lines.length; k++) {
      const t = lines[k]
      if (/^##\s/.test(t) || /^---\s*$/.test(t)) break
      if (/^-\s+/.test(t.trim())) revision.push(t.trim())
    }
  }
  return { file: name, title, stages, revision, raw }
}

export type PlanAction = 'pass' | 'reject' | 'amend'

export interface VerdictInput {
  file: string
  stageId: string
  action: PlanAction
  /** 打回理由 / 改一句的内容 */
  text?: string
}

interface StageRange { head: number; end: number }

/** 找阶段块的行号区间（`end` 不含：下一个阶段标题 / 二级标题之前） */
function findStageRange(lines: string[], stageId: string): StageRange | null {
  const head = lines.findIndex((l) => {
    const m = STAGE_HEAD.exec(l)
    return !!m && m[1] === stageId
  })
  if (head < 0) return null
  let end = head + 1
  while (end < lines.length && !STAGE_HEAD.test(lines[end]) && !SECTION_HEAD.test(lines[end])) end++
  return { head, end }
}

/** 在阶段块内就地改一行 `- 键:`；没有就插在 `- 状态:` 后面（行级，不重写整篇） */
function setStageField(lines: string[], range: StageRange, key: string, value: string): void {
  const re = new RegExp(`^-\\s*${key}\\s*[:：]`)
  for (let k = range.head + 1; k < range.end; k++) {
    if (re.test(lines[k].trim())) { lines[k] = `- ${key}: ${value}`; return }
  }
  const stat = lines.findIndex((l, k) => k > range.head && k < range.end && /^-\s*状态\s*[:：]/.test(l.trim()))
  const at = stat >= 0 ? stat + 1 : range.head + 1
  lines.splice(at, 0, `- ${key}: ${value}`)
  range.end++
}

/** 在“修订记录”节末尾追加一行（不排序、不改旧条目） */
function appendRevision(lines: string[], day: string, note: string): void {
  const rIdx = lines.findIndex((l) => /^##\s*修订记录/.test(l))
  if (rIdx < 0) return
  let insertAt = rIdx + 1
  while (insertAt < lines.length && !/^-\s+/.test(lines[insertAt].trim()) && !/^##\s/.test(lines[insertAt])) insertAt++
  while (insertAt < lines.length && /^-\s+/.test(lines[insertAt].trim())) insertAt++
  lines.splice(insertAt, 0, `- ${day} · ${note}`)
}

/**
 * 写出一次裁决。**行级就地改**，保留原文的空行、表格、缩进。
 * 返回 changed 让界面能如实说"改了哪几行"。
 */
export function writePlanVerdict(input: VerdictInput): { ok: boolean; error?: string; doc?: PlanDoc } {
  const file = path.basename(String(input.file || ''))
  const p = path.join(plansDir(), file)
  if (!fs.existsSync(p) || !file.endsWith('.md')) return { ok: false, error: '计划卡不存在' }
  const doc = readPlan(file)
  const stage = doc?.stages.find((s) => s.id === input.stageId)
  if (!doc || !stage) return { ok: false, error: '找不到这个阶段' }

  const text = String(input.text || '').trim()
  if (input.action === 'reject' && !text) return { ok: false, error: '打回必须写理由（空着等于没打回）' }
  if (input.action === 'amend' && !text) return { ok: false, error: '“改一句”要写清楚改什么' }

  const lines = doc.raw.replace(/\r\n/g, '\n').split('\n')
  const range = findStageRange(lines, input.stageId)
  if (!range) return { ok: false, error: '找不到这个阶段' }

  const today = new Date()
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const rel = doc.stages.filter((s) => !s.missing.length).length

  if (input.action === 'pass') {
    // 缺块不许通过 —— 判据说的"缺一即报红"，这里再兜一层，防止绕过界面
    if (stage.missing.length) return { ok: false, error: `缺 ${stage.missing.join(' / ')}，不能通过` }
    // 进队列锁（2026-11-11 · 规格单 §3.1 的第二个时点）：**通过 = 冻结 = 可派**。
    // 出厂时 proposeStage 已强制带卷，这里查的是“提案之后卷被作废 / 又冒出反问”的时间差。
    const qg = queueGateForStage(path.basename(file, '.md'), stage.clarify)
    if (!qg.ok) return { ok: false, error: qg.error }
    setStageField(lines, range, '状态', '已冻结')
    setStageField(lines, range, '裁决', `通过 · ${day}`)
  } else if (input.action === 'reject') {
    setStageField(lines, range, '状态', '待裁决')
    setStageField(lines, range, '打回理由', text.replace(/\n+/g, ' '))
  } else {
    setStageField(lines, range, '状态', '待裁决（未冻结）')
  }

  const note = input.action === 'pass'
    ? `P${input.stageId.replace(/^P/, '')} 通过 · 阶段卡冻结（${rel} 张已无缺块）`
    : input.action === 'reject'
      ? `P${input.stageId.replace(/^P/, '')} 打回：${text.replace(/\n+/g, ' ')}`
      : `P${input.stageId.replace(/^P/, '')} 改一句：${text.replace(/\n+/g, ' ')}`
  appendRevision(lines, day, note)

  fs.writeFileSync(p, lines.join('\n'), 'utf-8')
  return { ok: true, doc: readPlan(file) || undefined }
}

// ── P4 阶段推进（判据不过不许跨格）──────────────────────────────────────

export interface AdvanceStageInput {
  file: string
  stageId: string
  /** 由 `shared/stageGate.evaluateStageGate` 算出的闸门结果 */
  gate: StageGateResult
  /** 证据引用（自检报告路径 / 命令 / 日期）；缺省写自检时间 */
  evidenceRef?: string
  /** 固定时间（测试用，正式调用不传） */
  now?: string
}

export interface AdvanceStageResult {
  ok: boolean
  /** true = 真的写成了“完成”；false = 被闸门挡下（或本身不合法） */
  advanced: boolean
  error?: string
  doc?: PlanDoc
  stage?: PlanStage
  gate: StageGateResult
}

/**
 * 推进一格：**判据全过才写得进“完成”**，否则只停在“未完成”并把 diff 写进打回理由。
 *
 * 为什么写回也在这里卡一道，而不是只信界面：裁决/推进是写盘动作，
 * 界面可以绕过（MCP、脚本、手改），但“判据没过却出现 完成”是假账 —— 必须在数据层拒绝。
 */
export function advanceStage(input: AdvanceStageInput): AdvanceStageResult {
  const gate = input?.gate
  const file = path.basename(String(input?.file || ''))
  const p = path.join(plansDir(), file)
  if (!file.endsWith('.md') || !fs.existsSync(p)) {
    return { ok: false, advanced: false, error: '计划卡不存在', gate }
  }
  const doc = readPlan(file)
  const stage = doc?.stages.find((s) => s.id === input.stageId)
  if (!doc || !stage) return { ok: false, advanced: false, error: '找不到这个阶段', gate }
  if (!gate || typeof gate.canAdvance !== 'boolean') {
    return { ok: false, advanced: false, error: '闸门结果缺失（先跑判据）', gate }
  }
  const status = String(stage.status || '').trim()
  if (status === '待裁决' || status === '待裁决（未冻结）' || status === '待起草' || status === '未冻结') {
    return { ok: false, advanced: false, error: '这张卡还没裁决（待裁决/未冻结），先通过再推', gate }
  }
  // 防"嘴上放行、账上没全过"的坏输入
  if (gate.canAdvance && (gate.total <= 0 || gate.passed !== gate.total)) {
    return { ok: false, advanced: false, error: '闸门结果自相矛盾：说放行但判据没全过', gate }
  }

  const iso = String(input.now || new Date().toISOString())
  const day = iso.slice(0, 10)
  const lines = doc.raw.replace(/\r\n/g, '\n').split('\n')
  const range = findStageRange(lines, input.stageId)
  if (!range) return { ok: false, advanced: false, error: '找不到这个阶段', gate }

  if (gate.canAdvance) {
    const ref = String(input.evidenceRef || '').trim()
    const evidence = `${ref ? ref + ' · ' : `自检 ${iso} · `}${gate.passed}/${gate.total} 判据通过`
    setStageField(lines, range, '状态', '完成')
    setStageField(lines, range, '证据', evidence)
    appendRevision(lines, day, `${input.stageId} 判据全过 → 完成（${gate.passed}/${gate.total}）`)
    fs.writeFileSync(p, lines.join('\n'), 'utf-8')
    const back = readPlan(file) || undefined
    return { ok: true, advanced: true, gate, doc: back, stage: back?.stages.find((s) => s.id === input.stageId) }
  }

  // 被挡：状态只能停在“未完成”，diff（判据原文 + 实际值）写进打回理由
  const diffOneLine = String(gate.diff || gate.reason || '判据未过').replace(/\s*\n\s*/g, '；')
  setStageField(lines, range, '状态', '未完成')
  setStageField(lines, range, '打回理由', diffOneLine)
  appendRevision(lines, day, `${input.stageId} P4 打回：${gate.failed} 未过 / ${gate.unknown} 未判定`)
  fs.writeFileSync(p, lines.join('\n'), 'utf-8')
  const back = readPlan(file) || undefined
  return {
    ok: false, advanced: false, error: '判据未过，不能跨格', gate,
    doc: back, stage: back?.stages.find((s) => s.id === input.stageId),
  }
}

// ── 新增阶段：agent 提议 → 落「待裁决」（2026-11-08）──────────────────────────
//
// 为什么必须有这一条：`stage_plan_get` 是只读的，界面上的三个动作（通过/打回/改一句）
// 全是**用户**点的。于是“作战计划能折叠了，然后呢？怎么让 AI 写进去新的？”
// 的答案此前是“没法写”—— agent 手里根本没有写入口，它只能口头建议。
//
// 口径（与「结构地图提议」同构，但落点不同）：
//   · 结构地图走**待审批任务卡**，因为正文在 policies/（别的目录）；
//   · 阶段卡**本来就在这份计划文件里**，落成 `- 状态: 待裁决` 就是它的“待你裁决”形态，
//     用户在同一页点「通过（冻结）」即算签字 —— 不另造一张卡，免得两处状态打架。
//   · **机检不过就一个字都不写**：缺技术方案 / 缺照抄点 / 缺判据的阶段写进去也永远冻结不了，
//     那是给人添堵，不是“先落下来再说”。

export interface ProposeStageInput {
  file: string
  /** 缺省自动取下一个 P 号 */
  stageId?: string
  title: string
  what?: string
  approach: string[]
  /** 照抄点：第一行是表头也行，没有表头就补一行「项 / 来源 / 原文」 */
  copyRows?: string[][]
  /**
   * 照抄点第一行**就是表头**（2026-11-11 · 草案入口）。
   *
   * 为什么需要这个开关：草案里的照抄点表是 agent 写的中文四栏表头
   * （“抄哪块 / 落到哪 / 不抄什么 / 怎么算抄到位”），`looksHeader` 那套正则认不出来，
   * 于是会被当成数据行、再补一个英文表头 —— 落地后表头和数据列数对不上。
   * 草案入口显式声明“这就是表头”，原样落地（表格仍由 `proposeStage` 检查有没有分隔线）。
   */
  copyHasHeader?: boolean
  criteria: string[]
  agent?: string
  now?: string
  /**
   * 澄清问卷卷名（2026-11-09 硬锁）。
   *
   * 没有它 = 没问过就出单，把猜测当结论。闸在写路径里判：内容校验之后、
   * 落盘之前 —— 这样“缺技术方案”这类错误仍然先报，不被闸吞掉。
   */
  deck?: string
}

export interface ProposeStageResult {
  ok: boolean
  error?: string
  doc?: PlanDoc
  stage?: PlanStage
}

/** 判据前缀白名单 —— 没有前缀的判据在闸门里恒为 unknown（等于永远不给过） */
const CRITERIA_PREFIX = /^(cmd|str|num|file)\s*[:：]/

function nextStageId(stages: PlanStage[]): string {
  let max = -1
  for (const s of stages) {
    const m = /^P(\d+)$/.exec(String(s.id || '').toUpperCase())
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `P${max + 1}`
}

export function proposeStage(input: ProposeStageInput): ProposeStageResult {
  const file = path.basename(String(input?.file || ''))
  const p = path.join(plansDir(), file)
  if (!file.endsWith('.md') || !fs.existsSync(p)) return { ok: false, error: `计划卡不存在：${file}` }
  const doc = readPlan(file)
  if (!doc) return { ok: false, error: `读不出来：${file}` }

  const title = String(input.title || '').trim()
  const approach = (input.approach || []).map((s) => String(s || '').trim()).filter(Boolean)
  const criteria = (input.criteria || []).map((s) => String(s || '').trim()).filter(Boolean)
  const copyRows = (input.copyRows || [])
    .filter((r) => Array.isArray(r) && r.some((c) => String(c || '').trim()))
    .map((r) => r.map((c) => String(c ?? '').trim()))

  if (!title) return { ok: false, error: 'title 必填（这张阶段卡要做什么，一句话）' }
  if (!approach.length) return { ok: false, error: '缺 技术方案 —— 写上打算怎么做（至少一条）' }
  if (!criteria.length) return { ok: false, error: '缺 判据 —— 没有判据的阶段永远冻结不了' }
  const bad = criteria.find((c) => !CRITERIA_PREFIX.test(c))
  if (bad) {
    return {
      ok: false,
      error: `判据「${bad}」没有前缀 —— 每条判据必须以 cmd: / str: / num: / file: 开头（否则闸门一律 unknown，等于永远不给过）`,
    }
  }
  if (!copyRows.length) {
    // 至少一行数据；表头与分隔线由这里补
    return {
      ok: false,
      error: '缺 照抄点 —— 至少给一行「从哪抄的 / 原文是什么」（表格：项 | 来源 | 原文）。'
        + '三块齐全才给通过，缺一块写进去也冻结不了。',
    }
  }

  const id = String(input.stageId || '').trim().toUpperCase() || nextStageId(doc.stages)
  if (!/^P\d+$/.test(id)) return { ok: false, error: `stageId 形如 P8，收到「${id}」` }
  if (doc.stages.some((s) => String(s.id || '').toUpperCase() === id)) {
    return { ok: false, error: `阶段 ${id} 已存在 —— 改已有的请在界面上用「改一句」，别新增重复阶段` }
  }

  // 硬闸（2026-11-09）：没有澄清问卷 / 卷没答完 / 全是否决作废 → 一个字节都不写。
  // 放在格式与重号校验之后：内容错误先报，别让闸把真正的错因吞掉。
  const gate = gateForDeck(String(input.deck || ''), path.basename(file, '.md'))
  if (!gate.ok) return { ok: false, error: gate.error }

  const iso = String(input.now || new Date().toISOString())
  const day = iso.slice(0, 10)
  const agent = String(input.agent || '').trim()

  const block: string[] = []
  block.push(`### ${id} ${title}`)
  block.push('- 状态: 待裁决')
  // 澄清卷：出厂闸放的卷名必须**落进块里** —— 否则“进队列”那一刻没有人能复算它是不是还成立
  block.push(`- 澄清: ${String(input.deck || '').trim()}`)
  const what = String(input.what || '').trim()
  if (what) block.push(`- 做什么: ${what}`)
  block.push('- 技术方案:')
  for (const a of approach) block.push(`  - ${a}`)
  block.push('- 照抄点:')
  // 第一行若不是表头（含「项/来源/原文」），补一行标准表头
  const looksHeader = input.copyHasHeader === true || copyRows[0].some((c) => /^(项|来源|原文|位置|参照)/.test(c))
  const rows = looksHeader ? copyRows : [['项', '来源', '原文'], ...copyRows]
  if (rows.length >= 2 && !rows[1].every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))) {
    // 没有分隔线就补一条：解析器要“表头 + 分隔线 + 数据”三行才算有照抄点
    rows.splice(1, 0, rows[0].map(() => '---'))
  }
  for (const r of rows) block.push(`| ${r.join(' | ')} |`)
  block.push('- 判据:')
  for (const c of criteria) block.push(`  - ${c}`)
  if (agent) block.push(`- 提议人: ${agent}`)
  block.push('')

  const lines = doc.raw.replace(/\r\n/g, '\n').split('\n')
  // 插到「## 阶段卡」这一节的末尾（下一个二级标题之前）；没有这一节就接到文末
  const secIdx = lines.findIndex((l) => /^##\s*阶段卡/.test(l))
  let at = lines.length
  if (secIdx >= 0) {
    for (let k = secIdx + 1; k < lines.length; k++) {
      if (/^##\s/.test(lines[k])) { at = k; break }
    }
  }
  while (at > 0 && !String(lines[at - 1] || '').trim()) at--   // 不要连出两个空行
  const insert = ['', ...block]
  lines.splice(at, 0, ...insert)
  appendRevision(lines, day, `${id} 新增待裁决（${agent ? agent + ' 提议' : 'agent 提议'}）`)
  atomicWrite(p, lines.join('\n'))

  const back = readPlan(file) || undefined
  const stage = back?.stages.find((s) => String(s.id || '').toUpperCase() === id)
  if (!stage) return { ok: false, error: '写进去了但读不回来这个阶段 —— 去看一眼文件', doc: back }
  return { ok: true, doc: back, stage }
}
