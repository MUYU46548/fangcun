/**
 * 作战计划卡（0.6.0 P1 的数据层）
 *
 * 真源：`task-data/plans/<项目id>.md`（P0 已冻结的格式，机检是 `scripts/check-plan-card.py`）。
 * 这一层只做两件事：
 *   ① **读**：把节式 Markdown 拆成阶段卡（技术方案 / 照抄点表 / 判据），缺块要**如实报缺**；
 *   ② **写裁决**：通过 / 打回 / 改一句 —— 全部**行级就地改**，绝不 yaml dump 重写整篇。
 *
 * 为什么坚持行级：计划卡是用户手写的正文（含表格、缩进列表、修订记录）。
 * 用「解析成对象再序列化」会把空行、对齐、表格宽度全洗一遍 —— 那就是"改一个字，diff 三百行"。
 *
 * 三条与 P1 判据对齐的硬约定：
 *   · 缺一块就 `missing` 里点名，界面据此报红，且**不显示"合格"**；
 *   · 打回必须真的写进文件（`打回理由:` 一行），不写就是假动作；
 *   · 「改一句」要留痕：修订记录多一行，且状态退回「未冻结」（ADR supersede 的最小版）。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getTaskDir } from './index'

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
    verdict: '', rejectReason: '', missing: [],
  }
  let mode: '' | 'approach' | 'copy' | 'criteria' = ''
  for (const raw of lines) {
    const line = raw
    const t = line.trim()
    if (/^-\s*状态\s*[:：]/.test(t)) { stage.status = t.split(/[:：]/).slice(1).join(':').trim(); mode = ''; continue }
    if (/^-\s*做什么\s*[:：]/.test(t)) { stage.what = t.split(/[:：]/).slice(1).join(':').trim(); mode = ''; continue }
    if (/^-\s*裁决\s*[:：]/.test(t)) { stage.verdict = t.split(/[:：]/).slice(1).join(':').trim(); mode = ''; continue }
    if (/^-\s*打回理由\s*[:：]/.test(t)) { stage.rejectReason = t.split(/[:：]/).slice(1).join(':').trim(); mode = ''; continue }
    if (/^-\s*技术方案\s*[:：]\s*$/.test(t)) { mode = 'approach'; continue }
    if (/^-\s*照抄点\s*[:：]?\s*$/.test(t)) { mode = 'copy'; continue }
    if (/^-\s*判据\s*[:：]?\s*$/.test(t)) { mode = 'criteria'; continue }
    if (mode === 'approach' && /^\s+-\s+/.test(line)) { stage.approach.push(t.replace(/^-\s+/, '')); continue }
    if (mode === 'criteria' && /^\s+-\s+/.test(line)) { stage.criteria.push(t.replace(/^-\s+/, '')); continue }
    if (mode === 'copy' && t.startsWith('|')) { stage.copyRows.push(splitRow(line)); continue }
    // 其它行（正文、空行、小节）打断当前收集，但不动已收内容
    if (t === '' || SECTION_HEAD.test(t) || STAGE_HEAD.test(t)) mode = mode === 'copy' ? 'copy' : ''
    else if (!/^\s/.test(line)) mode = mode === 'copy' ? 'copy' : ''
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
  if (input.action === 'amend' && !text) return { ok: false, error: '「改一句」要写清楚改什么' }

  const lines = doc.raw.replace(/\r\n/g, '\n').split('\n')
  const headIdx = lines.findIndex((l) => {
    const m = STAGE_HEAD.exec(l)
    return !!m && m[1] === input.stageId
  })
  if (headIdx < 0) return { ok: false, error: '找不到这个阶段' }

  const today = new Date()
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const rel = doc.stages.filter((s) => !s.missing.length).length

  // 在阶段块内找/插 `- 状态:` 与 `- 裁决:` / `- 打回理由:`
  let end = headIdx + 1
  while (end < lines.length && !STAGE_HEAD.test(lines[end]) && !SECTION_HEAD.test(lines[end])) end++

  const setField = (key: string, value: string): void => {
    const re = new RegExp(`^-\\s*${key}\\s*[:：]`)
    for (let k = headIdx + 1; k < end; k++) {
      if (re.test(lines[k].trim())) { lines[k] = `- ${key}: ${value}`; return }
    }
    // 没有就插在 `- 状态:` 后面（没有状态就插在标题下第一行）
    const stat = lines.findIndex((l, k) => k > headIdx && k < end && /^-\s*状态\s*[:：]/.test(l.trim()))
    const at = stat >= 0 ? stat + 1 : headIdx + 1
    lines.splice(at, 0, `- ${key}: ${value}`)
    end++
  }

  if (input.action === 'pass') {
    // 缺块不许通过 —— 判据说的"缺一即报红"，这里再兜一层，防止绕过界面
    if (stage.missing.length) return { ok: false, error: `缺 ${stage.missing.join(' / ')}，不能通过` }
    setField('状态', '已冻结')
    setField('裁决', `通过 · ${day}`)
  } else if (input.action === 'reject') {
    setField('状态', '待裁决')
    setField('打回理由', text.replace(/\n+/g, ' '))
  } else {
    setField('状态', '待裁决（未冻结）')
  }

  // 修订记录：多一行，（改一句时）带改动内容
  const rIdx = lines.findIndex((l) => /^##\s*修订记录/.test(l))
  if (rIdx >= 0) {
    let insertAt = rIdx + 1
    while (insertAt < lines.length && !/^-\s+/.test(lines[insertAt].trim()) && !/^##\s/.test(lines[insertAt])) insertAt++
    while (insertAt < lines.length && /^-\s+/.test(lines[insertAt].trim())) insertAt++
    const note = input.action === 'pass'
      ? `P${input.stageId.replace(/^P/, '')} 通过 · 阶段卡冻结（${rel} 张已无缺块）`
      : input.action === 'reject'
        ? `P${input.stageId.replace(/^P/, '')} 打回：${text.replace(/\n+/g, ' ')}`
        : `P${input.stageId.replace(/^P/, '')} 改一句：${text.replace(/\n+/g, ' ')}`
    lines.splice(insertAt, 0, `- ${day} · ${note}`)
  }

  fs.writeFileSync(p, lines.join('\n'), 'utf-8')
  return { ok: true, doc: readPlan(file) || undefined }
}
