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
import { getTaskDir } from './index'
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

/** 表格行 → 单元格（去掉首尾竖线与空白） */
function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return t.split('|').map((c) => c.trim())
}

function parseStage(id: string, title: string, lines: string[]): PlanStage {
  const stage: PlanStage = {
    id, title, status: '', what: '', approach: [], copyRows: [], criteria: [],
    verdict: '', rejectReason: '', evidence: '', missing: [],
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
  return { file: safe, title, stages, revision, raw }
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
