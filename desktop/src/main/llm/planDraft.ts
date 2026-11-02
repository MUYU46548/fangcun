/**
 * 计划生成器（0.6.0 P6）—— 方寸按证据起草一份**草案**，只落「待裁决」
 *
 * 边界（REV-005 ②③）：
 *   · 产出**永不自动冻结**：草稿顶部与每张阶段卡都写 `状态: 待裁决`，生成器没有"通过"能力；
 *   · 每条建议必须引用一条**已存在的依据**（任务卡 / 投入产出账的某一格 / git 事实），
 *     引不出来的建议**不进草案**（不是悄悄留一条没有来源的）；
 *   · 一次生成在 `ai-trace.jsonl` 写一条带 `total_tokens` 的记录（花销可见）；
 *   · 走既有 BYOK 通道（`chatDetailed`），不连默认端点、不预置钥匙。
 *
 * 为什么落 `task-data/plans/_drafts/`：真实计划卡是用户手写的，生成器不能覆盖它。
 * 草案放 `_` 开头的目录，`listPlanFiles` 天然不把它当正式计划；你看完点头再用「改一句/通过」
 * 把它并进去（或手动复制）。
 */
import * as fs from 'fs'
import * as path from 'path'
import { atomicWrite, getTaskDir } from '../data'
import { appendTrace } from './trace'
import { chatWithFallback } from './fallback'
import { getConfig } from './config'
import type { WasteLedger } from '../../shared/waste'
import { parseCheckLine } from '../../shared/checkSpec'

export interface DraftTaskRef {
  id: string
  title?: string
  status?: string
}

export interface PlanDraftInput {
  /** 项目 id（用于文件名与提示词；只允许安全字符） */
  project: string
  projectName?: string
  /** 产品定义 / 立项契约原文（可截断） */
  definition?: string
  /** 投入产出账（P5）—— ledger:spend / ledger:output / ledger:rejected */
  ledger?: WasteLedger | null
  /** 现有卡（作为"需求/现状"证据） */
  tasks?: DraftTaskRef[]
  /** git 事实（只给数，不给原文） */
  git?: { commits?: number | null; since?: string } | null
}

export interface RawDraftStage {
  id?: string
  title?: string
  what?: string
  approach?: string[]
  copy?: string[][]
  criteria?: string[]
  cites?: string[]
}

export interface ValidDraftStage {
  id: string
  title: string
  what: string
  approach: string[]
  copy: string[][]
  criteria: string[]
  cites: string[]
}

export interface DraftDrop {
  title: string
  reason: string
}

export interface DraftValidation {
  stages: ValidDraftStage[]
  dropped: DraftDrop[]
  /** 因"没有依据/依据不存在"被丢掉的条数（草案内应为 0） */
  missingCitations: number
}

export interface DraftUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface PlanDraftDeps {
  callLlm?: (prompt: string, system: string) => Promise<{ text: string; usage?: DraftUsage; model?: string }>
  writeFile?: (file: string, content: string) => void
  appendTrace?: (rec: any) => void
  now?: string
}

export interface PlanDraftResult {
  ok: boolean
  error?: string
  file?: string
  markdown?: string
  stages?: ValidDraftStage[]
  dropped?: DraftDrop[]
  missingCitations?: number
  usage?: DraftUsage
  model?: string
  /** 允许引用的依据 id（提示词与校验共用） */
  allowed?: string[]
}

const ID_RE = /^P\d+$/
const KNOWN_PREFIX = /^\s*(cmd|str|num|file)\s*[:：]/i
const FORBIDDEN = '已冻结'

function safeProjectId(p: string): string {
  return String(p || '').trim().replace(/[^\w\u4e00-\u9fa5.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'project'
}

/** 允许引用的依据：`task:<id>` / `ledger:<key>` / `git:commits` */
export function allowedCitations(input: PlanDraftInput): string[] {
  const out: string[] = []
  for (const t of Array.isArray(input.tasks) ? input.tasks : []) {
    if (t && t.id) out.push(`task:${t.id}`)
  }
  for (const c of input.ledger?.cells || []) {
    if (c && c.key) out.push(`ledger:${c.key}`)
  }
  if (input.git && typeof input.git.commits === 'number' && input.git.commits > 0) out.push('git:commits')
  return Array.from(new Set(out))
}

/** 证据清单（提示词里逐条列出来，模型只能从这里挑） */
function evidenceLines(input: PlanDraftInput): string[] {
  const lines: string[] = []
  for (const t of Array.isArray(input.tasks) ? input.tasks : []) {
    if (!t || !t.id) continue
    lines.push(`- [task:${t.id}] ${String(t.title || t.id).trim()}${t.status ? `（状态：${t.status}）` : ''}`)
  }
  for (const c of input.ledger?.cells || []) {
    if (!c) continue
    lines.push(`- [ledger:${c.key}] ${c.label}：${c.value}${c.detail ? `（${c.detail}）` : ''}`)
  }
  if (input.git && typeof input.git.commits === 'number' && input.git.commits > 0) {
    lines.push(`- [git:commits] 近 ${input.git.since || '30 天'} ${input.git.commits} 次提交`)
  }
  return lines
}

export function buildPlanDraftPrompt(input: PlanDraftInput): { system: string; user: string } {
  const allowed = allowedCitations(input)
  const system = [
    '你是「方寸」的作战计划起草器。只输出一个 JSON 对象，不要 Markdown 代码围栏、不要解释。',
    '形状：{"stages":[{"id":"P0","title":"...","what":"...","approach":["..."],"copy":[["抄哪块","落到哪","不抄什么","怎么算抄到位"]],"criteria":["cmd: ..."],"cites":["task:xxx"]}]}',
    '硬规则：',
    '1) 每条 stage 的 cites 至少 1 个，且只能从「可用依据」里原样选；引不出依据的条目不要输出。',
    '2) criteria 每条必须以 cmd: / str: / num: / file: 开头，且写成可执行的机器形式（cmd 给命令，str 给相对路径+含\'原文\'，num 给路径+指标+比较+数字，file 给路径）。',
    '3) copy 至少 1 行、恰好 4 列；不要写"多方案对比"这种空话。',
    '4) 绝对不许写「已冻结」；你只能起草「待裁决」。',
    '5) 不要输出你没有证据支撑的数字。',
  ].join('\n')
  const user = [
    `项目：${input.projectName || input.project}（${input.project}）`,
    input.definition ? `\n产品定义 / 契约原文：\n${String(input.definition).slice(0, 4000)}` : '\n（没有产品定义原文）',
    `\n当前证据（只能引用这些 id）：\n${evidenceLines(input).join('\n') || '（没有可用依据）'}`,
    `\n可用依据 id：${allowed.join(' , ') || '（空）'}`,
    '\n请把下一版计划拆成 2–5 张阶段卡，按 P0/P1/... 编号；每张卡都要有依据。',
  ].join('\n')
  return { system, user }
}

/** 从模型输出里抠出 JSON（容忍 ```json 围栏 / 前后废话） */
export function parsePlanDraftPayload(text: string): { stages: RawDraftStage[]; error?: string } {
  const raw = String(text || '').trim()
  if (!raw) return { stages: [], error: '模型没有返回内容' }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1].trim() : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0) return { stages: [], error: '模型输出里没有 JSON 对象' }
  if (end <= start) return { stages: [], error: '模型输出的 JSON 不完整（缺少右花括号）' }
  let obj: any
  try {
    obj = JSON.parse(body.slice(start, end + 1))
  } catch (e: any) {
    return { stages: [], error: `模型输出的 JSON 解析失败：${e?.message || e}` }
  }
  const arr = Array.isArray(obj?.stages) ? obj.stages : null
  if (!arr) return { stages: [], error: '模型输出缺少 stages 数组' }
  const stages: RawDraftStage[] = arr
    .filter((s: any) => s && typeof s === 'object')
    .map((s: any) => ({
      id: s.id ? String(s.id) : undefined,
      title: s.title ? String(s.title) : '',
      what: s.what ? String(s.what) : '',
      approach: Array.isArray(s.approach) ? s.approach.map((x: any) => String(x)) : [],
      copy: Array.isArray(s.copy) ? s.copy.map((row: any) => (Array.isArray(row) ? row.map((c: any) => String(c)) : [])) : [],
      criteria: Array.isArray(s.criteria) ? s.criteria.map((x: any) => String(x)) : [],
      cites: Array.isArray(s.cites) ? s.cites.map((x: any) => String(x)) : [],
    }))
  return { stages }
}

/**
 * 校验：每条建议必须引一条**真实存在**的依据；没引/引错的一律丢（不是留个空壳）。
 * 另外：没有可执行判据 / 照抄点为空的也丢 —— 那样的卡连 P0 格式机检都过不去。
 */
export function validateDraftStages(raw: RawDraftStage[], allowed: string[]): DraftValidation {
  const allow = new Set(allowed)
  const stages: ValidDraftStage[] = []
  const dropped: DraftDrop[] = []
  let missingCitations = 0
  let n = 0
  for (const s of Array.isArray(raw) ? raw : []) {
    const title = String(s?.title || '').trim()
    const cites = Array.from(new Set((Array.isArray(s?.cites) ? s.cites : []).map((x) => String(x || '').trim()).filter(Boolean)))
    const badCites = cites.filter((c) => !allow.has(c))
    if (!cites.length) {
      missingCitations++
      dropped.push({ title: title || '(无标题)', reason: '没有依据引用（引不出的建议不进草案）' })
      continue
    }
    if (badCites.length) {
      missingCitations++
      dropped.push({ title: title || '(无标题)', reason: `引用了不存在的依据：${badCites.join(' / ')}` })
      continue
    }
    const text = [title, s?.what, ...(s?.approach || []), ...(s?.criteria || []), ...(s?.copy || []).flat()].join('\n')
    if (text.includes(FORBIDDEN)) {
      dropped.push({ title: title || '(无标题)', reason: `出现「${FORBIDDEN}」——生成器只能起草待裁决` })
      continue
    }
    const criteria = (Array.isArray(s?.criteria) ? s.criteria : []).map((x) => String(x || '').trim()).filter(Boolean)
    if (!criteria.some((c) => KNOWN_PREFIX.test(c) && parseCheckLine(c).kind !== 'unknown')) {
      dropped.push({ title: title || '(无标题)', reason: '没有一条可机检判据（cmd/str/num/file）' })
      continue
    }
    const copy = (Array.isArray(s?.copy) ? s.copy : [])
      .map((row) => (Array.isArray(row) ? row.map((c) => String(c).trim()) : []))
      .filter((row) => row.filter(Boolean).length >= 2)
    if (!copy.length) {
      dropped.push({ title: title || '(无标题)', reason: '照抄点为空（至少 1 行）' })
      continue
    }
    const approach = (Array.isArray(s?.approach) ? s.approach : []).map((x) => String(x || '').trim()).filter(Boolean)
    if (!title || !approach.length) {
      dropped.push({ title: title || '(无标题)', reason: '标题或技术方案为空' })
      continue
    }
    n++
    stages.push({
      id: ID_RE.test(String(s.id || '')) ? String(s.id) : `P${n - 1}`,
      title, what: String(s.what || '').trim(), approach,
      copy: copy.map((row) => {
        const cells = row.slice(0, 4)
        while (cells.length < 4) cells.push('—')
        return cells
      }),
      criteria,
      cites,
    })
  }
  // 编号去重（模型可能给重复的 P0）
  const seen = new Set<string>()
  for (let i = 0; i < stages.length; i++) {
    if (seen.has(stages[i].id)) stages[i].id = `P${i}`
    seen.add(stages[i].id)
  }
  return { stages, dropped, missingCitations }
}

function mdCell(s: string): string {
  return String(s || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—'
}

/** 渲染成一份能被 `readPlan` / 格式机检读的草案（五段 + 阶段卡 + 修订记录） */
export function renderPlanDraft(input: PlanDraftInput, stages: ValidDraftStage[], opts: { date: string; model: string }): string {
  const name = input.projectName || input.project
  const title = `${name} · 作战计划（方寸起草草案）`
  const lines: string[] = []
  lines.push(`# ${title}`, '')
  lines.push('- 状态: 待裁决')
  lines.push(`- 版本: draft-${opts.date}`)
  lines.push(`- 日期: ${opts.date}`)
  lines.push(`- 生成: 方寸 BYOK · ${opts.model || '未记录模型'} · ${stages.length} 张阶段卡 · 每条建议带依据`)
  lines.push(`- 裁决: （空）`)
  lines.push('')
  lines.push('> 草案：方寸按「产品定义 + 投入产出账 + 现有卡与 git 事实」起草，**未冻结**。')
  lines.push('> 通过 / 打回由人在项目页裁决；生成器没有"通过"能力。', '')
  lines.push('## 范围', '')
  lines.push(`本项目下一版计划草案：${stages.length} 张阶段卡，覆盖 ${stages.map((s) => s.title).join(' / ')}。`)
  lines.push('')
  lines.push('## 交付物', '', '| 阶段 | 交付物 | 状态 |', '|---|---|---|')
  for (const s of stages) lines.push(`| ${s.id} | ${mdCell(s.title)} | 待裁决 |`)
  lines.push('')
  lines.push('## 验收标准', '')
  lines.push('以每张阶段卡「判据」区为准；判据前缀 cmd / str / num / file，未知前缀由执行器判 unknown，不算通过。')
  lines.push('')
  lines.push('## 里程碑', '', '| 阶段 | 判据 | 依赖 | 状态 |', '|---|---|---|---|')
  for (const s of stages) lines.push(`| ${s.id} | ${s.criteria.length} 条 | — | 待裁决 |`)
  lines.push('')
  lines.push('## 除外责任', '')
  lines.push('- 不做其他项目的计划；不做多人协作 / 审批流；草案不自动冻结。')
  lines.push('')
  lines.push('## 阶段卡', '')
  for (const s of stages) {
    lines.push(`### ${s.id} · ${s.title}`, '')
    lines.push('- 状态: 待裁决')
    if (s.what) lines.push(`- 做什么: ${s.what}`)
    lines.push('- 技术方案:')
    for (const a of s.approach) lines.push(`  - ${a}`)
    lines.push('')
    lines.push('- 照抄点:', '', '| 抄哪块 | 落到哪 | 不抄什么 | 怎么算抄到位 |', '|---|---|---|---|')
    for (const row of s.copy) lines.push(`| ${row.map(mdCell).join(' | ')} |`)
    lines.push('')
    lines.push('- 判据:', '')
    for (const c of s.criteria) lines.push(`  - ${c}`)
    lines.push('')
    lines.push(`- 依据: ${s.cites.join(' · ')}`)
    lines.push('')
  }
  lines.push('## 修订记录', '', `- ${opts.date} · 方寸起草（草案，待裁决；未冻结）`)
  return lines.join('\n') + '\n'
}

function draftsDir(): string {
  return path.join(getTaskDir(), 'plans', '_drafts')
}

function safeWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  atomicWrite(file, content)
}

const DEFAULT_SYSTEM_TRIGGER = 'plan-draft'

/**
 * 起草一份计划草案。
 * 测试用 `deps.callLlm` 注入一段假模型输出；正式路径走 `chatDetailed`（BYOK）。
 */
export async function generatePlanDraft(input: PlanDraftInput, deps: PlanDraftDeps = {}): Promise<PlanDraftResult> {
  const allowed = allowedCitations(input)
  if (!allowed.length) {
    return { ok: false, error: '没有可引用的依据（现有卡 / 投入产出账 / git 事实都为空）—— 起草器不编依据', allowed }
  }
  const { system, user } = buildPlanDraftPrompt(input)
  const nowIso = String(deps.now || new Date().toISOString())
  const date = nowIso.slice(0, 10)
  const t0 = Date.now()
  let text = ''
  let usage: DraftUsage | undefined
  let model = ''
  try {
    // 2026-11-02 BYOK 多通道：走降级链（主通道挂了自动换备用，失败与降级都留痕）。
    // 降级只改"用哪条通道发"，不改"产出只落待裁决"这条语义。
    const call = deps.callLlm || (async (prompt: string, sys: string) => {
      const r = await chatWithFallback(prompt, {
        system: sys, trigger: `${DEFAULT_SYSTEM_TRIGGER}:${input.project}`, noTrace: true, maxTokens: 4096,
      })
      if (!r.ok) throw new Error(r.error || r.note || '模型调用失败（所有通道都试过了）')
      return {
        text: r.text,
        usage: {
          promptTokens: r.usage?.promptTokens ?? undefined,
          completionTokens: r.usage?.completionTokens ?? undefined,
          totalTokens: r.usage?.totalTokens ?? undefined,
        },
        model: String(r.model || getConfig().model || ''),
      }
    })
    const r = await call(user, system)
    text = String(r?.text || '')
    usage = r?.usage || undefined
    model = String(r?.model || '')
  } catch (e: any) {
    // 失败也留痕（没有 token 就不写 token 字段；花销可见优先于"好看"）
    const rec = {
      ts: nowIso, trigger: `${DEFAULT_SYSTEM_TRIGGER}:${input.project}`, model,
      prompt_chars: user.length, completion_chars: 0, duration_ms: Date.now() - t0,
      ok: false, stream: false, error: String(e?.message || e).slice(0, 300), origin: 'local' as const,
    }
    try { (deps.appendTrace || appendTrace)(rec) } catch { /* 留痕失败不挡生成 */ }
    return { ok: false, error: `调用模型失败：${e?.message || e}`, allowed }
  }

  const parsed = parsePlanDraftPayload(text)
  if (parsed.error) {
    try {
      (deps.appendTrace || appendTrace)({
        ts: nowIso, trigger: `${DEFAULT_SYSTEM_TRIGGER}:${input.project}`, model,
        prompt_chars: user.length, completion_chars: text.length, duration_ms: Date.now() - t0,
        ok: false, stream: false, error: parsed.error.slice(0, 300), origin: 'local',
      })
    } catch { /* ignore */ }
    return { ok: false, error: parsed.error, allowed }
  }

  const v = validateDraftStages(parsed.stages, allowed)
  if (!v.stages.length) {
    try {
      (deps.appendTrace || appendTrace)({
        ts: nowIso, trigger: `${DEFAULT_SYSTEM_TRIGGER}:${input.project}`, model,
        prompt_chars: user.length, completion_chars: text.length, duration_ms: Date.now() - t0,
        ok: false, stream: false, error: '所有建议都引不出依据，已全部丢弃', origin: 'local',
      })
    } catch { /* ignore */ }
    return { ok: false, error: `模型给了 ${parsed.stages.length} 条建议，但没有一条能引出依据 —— 已全部丢弃`, dropped: v.dropped, missingCitations: v.missingCitations, allowed }
  }

  const markdown = renderPlanDraft(input, v.stages, { date, model })
  const file = path.join(draftsDir(), `${safeProjectId(input.project)}-${date}.md`)
  try {
    (deps.writeFile || safeWrite)(file, markdown)
  } catch (e: any) {
    return { ok: false, error: `草案写盘失败：${e?.message || e}`, allowed }
  }

  // 花销留痕：**一次生成一条**，带 total_tokens（P6 判据）
  const rec: any = {
    ts: nowIso, trigger: `${DEFAULT_SYSTEM_TRIGGER}:${input.project}`, model,
    prompt_chars: user.length, completion_chars: text.length, duration_ms: Date.now() - t0,
    ok: true, stream: false, origin: 'local',
  }
  if (usage) {
    if (typeof usage.promptTokens === 'number') rec.prompt_tokens = usage.promptTokens
    if (typeof usage.completionTokens === 'number') rec.completion_tokens = usage.completionTokens
    if (typeof usage.totalTokens === 'number') rec.total_tokens = usage.totalTokens
  }
  try { (deps.appendTrace || appendTrace)(rec) } catch { /* 留痕失败不挡交付 */ }

  return {
    ok: true, file, markdown, stages: v.stages, dropped: v.dropped,
    missingCitations: v.missingCitations, usage, model, allowed,
  }
}
