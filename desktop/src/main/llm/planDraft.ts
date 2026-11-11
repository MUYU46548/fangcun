/**
 * 计划生成器（0.6.0 P6）—— 方寸按证据起草一份**草案**，只落“待裁决”
 *
 * 边界（REV-005 ②③）：
 *   · 产出**永不自动冻结**：草稿顶部与每张阶段卡都写 `状态: 待裁决`，生成器没有"通过"能力；
 *   · 每条建议必须引用一条**已存在的依据**（任务卡 / 投入产出账的某一格 / git 事实），
 *     引不出来的建议**不进草案**（不是悄悄留一条没有来源的）；
 *   · 一次生成在 `ai-trace.jsonl` 写一条带 `total_tokens` 的记录（花销可见）；
 *   · 走既有 BYOK 通道（`chatDetailed`），不连默认端点、不预置钥匙。
 *
 * 为什么落 `task-data/plans/_drafts/`：真实计划卡是用户手写的，生成器不能覆盖它。
 * 草案放 `_` 开头的目录，`listPlanFiles` 天然不把它当正式计划；你看完点头再用“改一句/通过”
 * 把它并进去（或手动复制）。
 *
 * 2026-11-10（首战没过之后补的三条硬闸）：
 *   ① **宪法页**：H2（D-065）选的是「宪法 + 产线 + 判据三件套」，只出阶段卡 = 不合格；
 *   ② **本轮要先问的问题**：没有新问题也必须写清理由，不许沉默着起草；
 *   ③ **判据现状体检**：判据今天就已经全绿（一个早就存在的文件）→ 该阶段判不合格。
 *
 * ⚠ 预算口径（2026-11-10 用户明确纠正）：**不要靠关思考省 token**。
 *   deepseek 这代模型的智力在 reasoning 里，关掉之后的输出只能扔回收站。
 *   之前的“正文空串”是 **max_tokens 上限（8192）低于思考长度**，正解是给到 32768。
 */
import * as fs from 'fs'
import * as path from 'path'
import { atomicWrite, getTaskDir } from '../data'
import { appendTrace } from './trace'
import { chatWithFallback } from './fallback'
import { inspectJson, jsonRetryNudge, type JsonFailKind } from '../../shared/jsonRepair'
import { getConfig } from './config'
import type { WasteLedger } from '../../shared/waste'
import { parseCheckLine } from '../../shared/checkSpec'

export interface DraftTaskRef {
  id: string
  title?: string
  status?: string
  /**
   * 这张卡当初的「## 方案」原文（截断）。
   *
   * 2026-11-02 补：此前**只给标题**，正文一个字不进上下文 —— 这是卡 task-20261027-003
   * 列出的四条根因里的第 2 条，正是它让规划输出像"待办清单"而不是"规划"：
   * 模型不知道哪张卡已经写好了施工方案、哪张做到一半、哪张是空壳。
   */
  plan?: string
  /** 这张卡的「## 结果记录」原文（截断）—— 已经踩过的坑、已经自报没做的部分都在这里 */
  actual?: string
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
  /**
   * 有效决策卡（2026-11-09 补）。
   *
   * 此前规划输入**一条决策都不读** —— 方寸起草计划时看不见那 47 条已经拍板的事，
   * 于是"规划"退化成从卡标题猜方向。现在把它们作为 `decision:D-xxx` 证据喂进去，
   * 并要求阶段卡在 what/approach 里回应（照做或说明为什么不照做）。
   */
  decisions?: DraftDecisionRef[]
  /** 已落档的验收线（2026-11-09 · S3 直连）：答过勾的题的【验收线】原文 */
  rulings?: DraftRulingRef[]
  /** git 事实（只给数，不给原文） */
  git?: { commits?: number | null; since?: string } | null
  /**
   * 项目仓库根（2026-11-10 补）：判据“现状体检”用。
   * 为什么要它：草案里出现过 `file: docs/0.6.0-交付清单-20261031.md` 这种**今天就已经满足**的判据，
   * 执行器照着跑会全绿而阶段什么都没做。有仓库根才能判“这条判据现在是不是已经过了”。
   * 缺省 = 不做体检（别的项目没登记 repo 时不硬猜路径）。
   */
  repoRoot?: string
}

export interface DraftRulingRef {
  deck: string
  qid: string
  ask?: string
  picked?: string
  line: string
}

export interface DraftDecisionRef {
  id: string
  内容: string
  日期?: string
  出处?: string
  备注?: string
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

/**
 * 宪法页的一行（2026-11-10）。
 *
 * 为什么必须有：H2（D-065）选的是「宪法 + 产线 + 判据三件套」，验收线写明
 * “只产出任务清单 = 没过”。首战那次产出只有产线 + 判据 —— 形状缺一块，
 * 所以现在**没有宪法页就整份不合格**，不是警告。
 */
export interface RawConstRow {
  kind?: string
  text?: string
  cites?: string[]
}

export type ConstKind = '已定' | '待定' | '冲突' | '作废'

export interface ValidConstRow {
  kind: ConstKind
  text: string
  cites: string[]
}

/** 「本轮要先问的问题」—— 没有新问题也必须明说，不许沉默着起草（V1 的机器版） */
export interface RawAsk {
  ask?: string
  why?: string
}

export interface ValidAsk {
  ask: string
  why: string
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
  /** 因"判据现状就已经全部满足"被丢掉的条数（2026-11-10） */
  alreadyGreen?: number
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
  /** 宪法页（一页结论）—— 没有它就是不合格（H2 / D-065） */
  constitution?: ValidConstRow[]
  /** 本轮要先问的问题（空数组 = 明说了没有新问题，理由在 asksNote） */
  asks?: ValidAsk[]
  asksNote?: string
  /** 判据“现状就已经满足”被丢掉的阶段数（2026-11-10） */
  alreadyGreen?: number
  stages?: ValidDraftStage[]
  dropped?: DraftDrop[]
  missingCitations?: number
  usage?: DraftUsage
  model?: string
  /** 允许引用的依据 id（提示词与校验共用） */
  allowed?: string[]
  /** 失败类型（2026-11-07）：三类重试策略不同，界面/日志据此给话 */
  failKind?: JsonFailKind | ''
  /** 这一版是"严格重试后拿到的" */
  retried?: boolean
}

const ID_RE = /^P\d+$/
const KNOWN_PREFIX = /^\s*(cmd|str|num|file)\s*[:：]/i
const FORBIDDEN = '已冻结'

function safeProjectId(p: string): string {
  return String(p || '').trim().replace(/[^\w\u4e00-\u9fa5.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'project'
}

/** 允许引用的依据：`task:<id>` / `ledger:<key>` / `git:commits` / `decision:<id>` / `ruling:<卷>:<题号>` */
export function allowedCitations(input: PlanDraftInput): string[] {
  const out: string[] = []
  for (const t of Array.isArray(input.tasks) ? input.tasks : []) {
    if (t && t.id) out.push(`task:${t.id}`)
  }
  for (const c of input.ledger?.cells || []) {
    if (c && c.key) out.push(`ledger:${c.key}`)
  }
  for (const d of Array.isArray(input.decisions) ? input.decisions : []) {
    if (d && d.id) out.push(`decision:${d.id}`)
  }
  for (const r of Array.isArray(input.rulings) ? input.rulings : []) {
    if (r && r.deck && r.qid) out.push(`ruling:${r.deck}:${r.qid}`)
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
    // 2026-11-02：正文进上下文。没有它，模型只看得到"有这么些卡"，
    // 看不到"这张卡里已经写好了方案 / 这张卡自报了没做的部分"——规划就退化成罗列。
    const plan = String(t.plan || '').replace(/\s+/g, ' ').trim()
    const actual = String(t.actual || '').replace(/\s+/g, ' ').trim()
    if (plan) lines.push(`    当初的方案：${plan.slice(0, 220)}`)
    if (actual) lines.push(`    实际结果：${actual.slice(0, 260)}`)
  }
  for (const c of input.ledger?.cells || []) {
    if (!c) continue
    lines.push(`- [ledger:${c.key}] ${c.label}：${c.value}${c.detail ? `（${c.detail}）` : ''}`)
  }
  for (const d of Array.isArray(input.decisions) ? input.decisions : []) {
    if (!d || !d.id) continue
    const head = [d.日期, String(d.内容 || '').trim()].filter(Boolean).join(' · ')
    lines.push(`- [decision:${d.id}] ${head}${d.出处 ? `（出处：${d.出处}）` : ''}`)
  }
  for (const r of Array.isArray(input.rulings) ? input.rulings : []) {
    if (!r || !r.deck || !r.qid || !String(r.line || '').trim()) continue
    lines.push(`- [ruling:${r.deck}:${r.qid}] 验收线：${String(r.line).trim()}${r.picked ? `（选择：${r.picked}）` : ''}`)
  }
  if (input.git && typeof input.git.commits === 'number' && input.git.commits > 0) {
    lines.push(`- [git:commits] 近 ${input.git.since || '30 天'} ${input.git.commits} 次提交`)
  }
  return lines
}

export function buildPlanDraftPrompt(input: PlanDraftInput): { system: string; user: string } {
  const allowed = allowedCitations(input)
  const system = [
    '你是“方寸”的作战计划起草器。只输出一个 JSON 对象，不要 Markdown 代码围栏、不要解释。',
    '形状：{"constitution":[{"kind":"已定|待定|冲突|作废","text":"...","cites":["decision:D-xxx"]}],'
      + '"asks":[{"ask":"...","why":"..."}],"asksNote":"（没有新问题时写理由）",'
      + '"stages":[{"id":"P0","title":"...","what":"...","approach":["..."],"copy":[["抄哪块","落到哪","不抄什么","怎么算抄到位"]],"criteria":["cmd: ..."],"cites":["task:xxx"]}]}',
    '硬规则：',
    '1) 每条 stage 的 cites 至少 1 个，且只能从“可用依据”里原样选；引不出依据的条目不要输出。依据有 task: / ledger: / git: / decision: / ruling: 五类。',
    '2) criteria 每条必须以 cmd: / str: / num: / file: 开头，且写成可执行的机器形式（cmd 给命令，str 给相对路径+含\'原文\'，num 给路径+指标+比较+数字，file 给路径）。',
    '3) copy 至少 1 行、恰好 4 列；不要写"多方案对比"这种空话。',
    '4) 绝对不许写“已冻结”；你只能起草“待裁决”。',
    '5) 不要输出你没有证据支撑的数字。',
    '6) 输入里有 decision:D-xxx（已经拍板的事）时，你触及的那些必须在 what/approach 里回应'
      + '（照做，或写清为什么不照做）；不要装看不见 —— 唱反调又不说明，等于没读。',
    '7) 输入里有 ruling:<卷>:<题号>（用户答过的验收线）时，相关阶段的 criteria 必须把那条线'
      + '原样搬进来并 cite 它；不许改写成语义相近的空话。',
    '8) **constitution 必须给**：至少 1 行，且至少 1 行 kind="已定"；每行 text 是一句结论、cites 至少 1 个依据。'
      + '这一页是“旗帜”的正面，缺了整份草案不合格（不是少一段）。',
    '9) **asks 必须给**：这一轮还缺哪些只有用户能答的问题；每条写清 why（为什么现在问）。'
      + '没有就写空数组 []，同时用 asksNote 说明为什么没有（例如“现有决策已覆盖本阶段全部取舍”）。'
      + '不许既不问、也不说理由。',
    '10) criteria 不许写“现在就已经满足”的东西：一个早就存在的文件只是存在，不构成验收。'
      + '判据要指向本次要产出/改动的东西，或者一个现在会失败的检查。',
  ].join('\n')
  const user = [
    `项目：${input.projectName || input.project}（${input.project}）`,
    input.definition ? `\n产品定义 / 契约原文：\n${String(input.definition).slice(0, 4000)}` : '\n（没有产品定义原文）',
    `\n当前证据（只能引用这些 id）：\n${evidenceLines(input).join('\n') || '（没有可用依据）'}`,
    `\n可用依据 id：${allowed.join(' , ') || '（空）'}`,
    '\n请按顺序产出三件：① constitution（宪法：已经定下来的结论，一行一条，带依据）；'
      + '② asks（这一轮还缺哪些只有用户能答的问题；没有就写 [] 并用 asksNote 说明理由）；'
      + '③ stages（2–5 张阶段卡，按 P0/P1/... 编号，每张都要有依据）。',
    // 2026-11-02：这几句是针对"输出像待办清单"的直接处置 ——
    // 要它回答"先做哪件、砍什么"，而不是"该做的事有哪几件"。
    '\n注意：每条卡下面若带了“当初的方案 / 实际结果”，说明这张卡已经有历史。',
    '已经做过的事不要再列成新阶段；自报了没做的部分才值得列。',
    '如果某件旧事不值得做，就在对应阶段的 what 里直说“本轮不做 X，因为 Y”——不要默默省略。',
    '每条 stage 的 what 必须回答“为什么是现在做这件”，而不只是“这件是什么”。',
    // 2026-11-09：决策卡进上下文后，必须要求“回应”而不是“当背景”。
    '已经拍板的事在证据里标成 [decision:D-xxx]：你触及的那些，必须在 what / approach 里回应'
      + '（照做，或写清为什么不照做）。装看不见等于没读。',
    '用户答过的验收线在证据里标成 [ruling:<卷>:<题号>]：相关阶段的 criteria 必须把那条线'
      + '原样搬进来并 cite 它，不许改写成语义相近的空话。',
  ].join('\n')
  return { system, user }
}

/** 从模型输出里抠出 JSON（容忍 ```json 围栏 / 前后废话） */
export function parsePlanDraftPayload(text: string): {
  stages: RawDraftStage[]
  constitution?: RawConstRow[]
  asks?: RawAsk[]
  asksNote?: string
  /** `asks` 这个键到底有没有出现过 —— 缺失 ≠ 空数组，前者要判不合格 */
  hasAsks?: boolean
  hasConstitution?: boolean
  error?: string
  kind?: JsonFailKind | ''
} {
  // 2026-11-07：形状判定统一走 `shared/jsonRepair`，失败要能分出
  // no_content / not_json / truncated / invalid —— 三类重试指令不同（见 jsonRetryNudge）。
  const shape = inspectJson(text)
  if (shape.kind) return { stages: [], error: shape.message, kind: shape.kind }
  let obj: any
  try {
    obj = JSON.parse(shape.body)
  } catch (e: any) {
    return { stages: [], error: `模型输出的 JSON 解析失败：${e?.message || e}`, kind: 'invalid' }
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
  const constitution: RawConstRow[] = Array.isArray(obj?.constitution)
    ? obj.constitution.filter((r: any) => r && typeof r === 'object').map((r: any) => ({
      kind: r.kind ? String(r.kind) : '',
      text: r.text ? String(r.text) : '',
      cites: Array.isArray(r.cites) ? r.cites.map((x: any) => String(x)) : [],
    }))
    : []
  const asks: RawAsk[] = Array.isArray(obj?.asks)
    ? obj.asks.filter((a: any) => a && typeof a === 'object').map((a: any) => ({
      ask: a.ask ? String(a.ask) : '',
      why: a.why ? String(a.why) : '',
    }))
    : []
  return {
    stages, constitution, asks,
    asksNote: obj?.asksNote ? String(obj.asksNote) : '',
    hasAsks: Object.prototype.hasOwnProperty.call(obj || {}, 'asks'),
    hasConstitution: Array.isArray(obj?.constitution),
  }
}

const CONST_KINDS: Record<string, ConstKind> = {
  '已定': '已定', '已决定': '已定', '定了': '已定',
  '待定': '待定', '未定': '待定',
  '冲突': '冲突', '矛盾': '冲突',
  '作废': '作废', '已作废': '作废',
}

/**
 * 宪法页校验（2026-11-10）：每一行必须有结论文字 + 至少一个**真实存在**的依据。
 * 引不出依据的那一行丢掉（与阶段卡同一条口径：不编）。
 */
export function validateConstitution(raw: RawConstRow[], allowed: string[]): { rows: ValidConstRow[]; dropped: string[] } {
  const allow = new Set(allowed)
  const rows: ValidConstRow[] = []
  const dropped: string[] = []
  for (const r of Array.isArray(raw) ? raw : []) {
    const text = String(r?.text || '').trim()
    const kind = CONST_KINDS[String(r?.kind || '').trim()] || ''
    const cites = Array.from(new Set((Array.isArray(r?.cites) ? r.cites : []).map((x) => String(x || '').trim()).filter(Boolean)))
    const bad = cites.filter((c) => !allow.has(c))
    if (!text) { dropped.push('（空结论）'); continue }
    if (!kind) { dropped.push(`${text}（类型认不出，只认 已定/待定/冲突/作废）`); continue }
    if (!cites.length || bad.length) { dropped.push(`${text}（依据缺失或不存在：${bad.join(' / ') || '没写'}）`); continue }
    rows.push({ kind, text, cites })
  }
  return { rows, dropped }
}

export interface CriterionNow {
  raw: string
  state: 'pass' | 'fail' | 'unknown'
}

/**
 * 判据“现状体检”（2026-11-10）—— 这条判据**今天是不是已经过了**。
 *
 * 为什么必须做：首战草案里出现过 `file: docs/0.6.0-交付清单-20261031.md`，
 * 那个文件 10-31 就存在 —— 执行器照着跑会全绿，而阶段什么都没做。
 * 只体检**只读**判据（file / str）：`cmd:` 不跑（不许起草器执行任意命令），一律 unknown。
 */
export function evaluateCriteriaNow(criteria: string[], repoRoot?: string): CriterionNow[] {
  const root = String(repoRoot || '').trim()
  return (Array.isArray(criteria) ? criteria : []).map((raw) => {
    if (!root) return { raw, state: 'unknown' as const }
    const p = parseCheckLine(raw)
    try {
      if (p.kind === 'file') {
        if (/[*?]/.test(p.pattern)) return { raw, state: 'unknown' as const }   // glob 不猜
        const abs = path.join(root, p.pattern.replace(/^[\\/]+/, ''))
        if (!fs.existsSync(abs)) return { raw, state: 'fail' as const }
        if (p.contains !== undefined || p.everyLineContains !== undefined) {
          const text = fs.readFileSync(abs, 'utf-8')
          if (p.contains !== undefined && !text.includes(p.contains)) return { raw, state: 'fail' as const }
          if (p.everyLineContains !== undefined) {
            const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
            const ok = lines.length > 0 && lines.every((l) => l.includes(String(p.everyLineContains)))
            return { raw, state: ok ? 'pass' : 'fail' }
          }
        }
        return { raw, state: 'pass' as const }
      }
      if (p.kind === 'str') {
        const abs = path.join(root, p.path)
        if (!fs.existsSync(abs)) return { raw, state: 'fail' as const }
        return { raw, state: fs.readFileSync(abs, 'utf-8').includes(p.text) ? 'pass' : 'fail' }
      }
    } catch {
      return { raw, state: 'unknown' as const }
    }
    return { raw, state: 'unknown' as const }
  })
}

/**
 * 校验：每条建议必须引一条**真实存在**的依据；没引/引错的一律丢（不是留个空壳）。
 * 另外：没有可执行判据 / 照抄点为空 / **判据现状就已全部满足** 的也丢 ——
 * 那样的卡不是验收，是装饰（2026-11-10 首战现场）。
 */
export function validateDraftStages(raw: RawDraftStage[], allowed: string[], opts: { repoRoot?: string } = {}): DraftValidation {
  const allow = new Set(allowed)
  const stages: ValidDraftStage[] = []
  const dropped: DraftDrop[] = []
  let missingCitations = 0
  let alreadyGreen = 0
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
      dropped.push({ title: title || '(无标题)', reason: `出现“${FORBIDDEN}”——生成器只能起草待裁决` })
      continue
    }
    const criteria = (Array.isArray(s?.criteria) ? s.criteria : []).map((x) => String(x || '').trim()).filter(Boolean)
    if (!criteria.some((c) => KNOWN_PREFIX.test(c) && parseCheckLine(c).kind !== 'unknown')) {
      dropped.push({ title: title || '(无标题)', reason: '没有一条可机检判据（cmd/str/num/file）' })
      continue
    }
    // 判据现状体检（2026-11-10）：全部“现在就已经过” = 装饰，不是验收。
    const now = evaluateCriteriaNow(criteria, opts.repoRoot)
    if (now.length && now.every((x) => x.state === 'pass')) {
      alreadyGreen++
      dropped.push({
        title: title || '(无标题)',
        reason: `判据现状就已全部满足（${now[0].raw} 现在就已经过）—— 不构成验收`,
      })
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
  return { stages, dropped, missingCitations, alreadyGreen }
}

function mdCell(s: string): string {
  return String(s || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—'
}

/** 渲染成一份能被 `readPlan` / 格式机检读的草案（宪法 + 待问 + 五段 + 阶段卡 + 修订记录） */
export function renderPlanDraft(
  input: PlanDraftInput,
  stages: ValidDraftStage[],
  opts: { date: string; model: string; constitution?: ValidConstRow[]; asks?: ValidAsk[]; asksNote?: string },
): string {
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
  // 这行以前是硬编码的“按产品定义 + 投入产出账 + 现有卡与 git 事实起草”——
  // 从磁盘组装时那几样其实一个都没带，草案却在自我介绍里说带了（假话）。
  // 现在只写真正进过上下文的来源。
  const srcs: string[] = []
  if (String(input.definition || '').trim()) srcs.push('产品定义')
  if ((input.ledger?.cells || []).length) srcs.push('投入产出账')
  if ((input.tasks || []).length) srcs.push('现有卡')
  if ((input.decisions || []).length) srcs.push('旧拍板')
  if ((input.rulings || []).length) srcs.push('已落档验收线')
  if (input.git && input.git.commits) srcs.push('git 事实')
  lines.push(`> 草案：方寸按 ${srcs.join(' + ') || '（没有输入）'} 起草，**未冻结**。`)
  lines.push('> 通过 / 打回由人在项目页裁决；生成器没有"通过"能力。', '')

  // ── 宪法（一页结论）───────────────────────────────────────────────
  // H2（D-065）选的形状是「宪法 + 产线 + 判据」；只给阶段卡等于没产出旗帜。
  const cons = opts.constitution || []
  lines.push('## 宪法（一页结论）', '')
  lines.push('| 类型 | 结论 | 依据 |', '|---|---|---|')
  for (const r of cons) lines.push(`| ${r.kind} | ${mdCell(r.text)} | ${r.cites.map(mdCell).join('、')} |`)
  lines.push('')

  // ── 本轮要先问的问题 ──────────────────────────────────────────────
  const asks = opts.asks || []
  lines.push('## 本轮要先问的问题', '')
  if (asks.length) {
    for (const a of asks) lines.push(`- ${a.ask}${a.why ? `（为什么现在问：${a.why}）` : ''}`)
    lines.push('')
    lines.push('> 这些题要先用 `qn_propose` 出卷、等你答完并批准，才许出单（D-060 零问题硬锁）。')
  } else {
    lines.push(`本轮没有新问题：${opts.asksNote || '（没写理由）'}`)
  }
  lines.push('')

  lines.push('## 范围', '')
  lines.push(`本项目下一版计划草案：${stages.length} 张阶段卡，覆盖 ${stages.map((s) => s.title).join(' / ')}。`)
  lines.push('')
  lines.push('## 交付物', '', '| 阶段 | 交付物 | 状态 |', '|---|---|---|')
  for (const s of stages) lines.push(`| ${s.id} | ${mdCell(s.title)} | 待裁决 |`)
  lines.push('')
  lines.push('## 验收标准', '')
  lines.push('以每张阶段卡“判据”区为准；判据前缀 cmd / str / num / file，未知前缀由执行器判 unknown，不算通过。')
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
 * 正式路径的一次模型调用（BYOK 降级链）。
 *
 * 2026-11-10 两条实测结论：
 *   ① 推理模型会把 max_tokens 花在 reasoning_content 上。之前正文空串，我一度靠
 *      `reasoning:{enabled:false}` 绕过去 —— **那是错的**：这一代模型的智力在思考里，
 *      关掉思考换来的是“能跑但要扔进回收站”的输出。正解是**给够预算**（32768），
 *      让思考与正文都放得下；chatDetailed 遇到 length 截断也会自动翻倍。
 *   ② 一次带思考的生成实测 30–90s，而 llm-config 的超时是 60s → 生成口单独给 240s。
 */
async function callLlmOnce(prompt: string, sys: string, project: string): Promise<{ text: string; usage?: DraftUsage; model?: string }> {
  const r = await chatWithFallback(prompt, {
    system: sys, trigger: `${DEFAULT_SYSTEM_TRIGGER}:${project}`,
    // noTrace：花销由 generatePlanDraft 统一写一条（带 total_tokens）—— 否则一次生成记两条，账对不上。
    noTrace: true,
    maxTokens: 32768,
    timeout: 240,
  })
  if (!r?.ok) throw new Error(r?.error || r?.note || '模型调用失败（所有通道都试过了）')
  return {
    text: String(r.text || ''),
    usage: {
      promptTokens: r.usage?.promptTokens ?? undefined,
      completionTokens: r.usage?.completionTokens ?? undefined,
      totalTokens: r.usage?.totalTokens ?? undefined,
    },
    model: String(r.model || getConfig().model || ''),
  }
}

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
  const writeTrace = (rec: any) => {
    try { (deps.appendTrace || appendTrace)(rec) } catch { /* 留痕失败不挡生成 */ }
  }
  try {
    // 2026-11-02 BYOK 多通道：走降级链（主通道挂了自动换备用，失败与降级都留痕）。
    // 降级只改"用哪条通道发"，不改"产出只落待裁决"这条语义。
    const call = deps.callLlm || ((p: string, s: string) => callLlmOnce(p, s, input.project))
    const r = await call(user, system)
    text = String(r?.text || '')
    usage = r?.usage || undefined
    model = String(r?.model || '')
  } catch (e: any) {
    // 失败也留痕（没有 token 就不写 token 字段；花销可见优先于"好看"）
    writeTrace({
      ts: nowIso, trigger: `${DEFAULT_SYSTEM_TRIGGER}:${input.project}`, model,
      prompt_chars: user.length, completion_chars: 0, duration_ms: Date.now() - t0,
      ok: false, stream: false, error: String(e?.message || e).slice(0, 300), origin: 'local' as const,
    })
    return { ok: false, error: `调用模型失败：${e?.message || e}`, allowed }
  }

  let parsed = parsePlanDraftPayload(text)
  let retried = false
  // ── 一次严格重试（2026-11-07）──────────────────────────────────────
  // 逐字复刻过的事故：11-02 那次 18,031 字符的往返，换回来一句"模型输出里没有 JSON 对象"，
  // 然后整轮就结束了 —— 一次都没再要。重试的指令必须**按类型**给（见 jsonRetryNudge）：
  // 截断要"少画点"，没 JSON 要"只输出 JSON"，不是同一句"注意格式"。
  if (parsed.error) {
    const kind = parsed.kind || 'not_json'
    const nudge = jsonRetryNudge(kind)
    try {
      const r2 = await (deps.callLlm
        ? deps.callLlm(user + '\n\n' + nudge, system)
        : callLlmOnce(user + '\n\n' + nudge, system, input.project))
      retried = true
      const t2 = String(r2?.text || '')
      if (r2?.model) model = String(r2.model)
      if (r2?.usage) {
        usage = {
          promptTokens: (usage?.promptTokens || 0) + (r2.usage.promptTokens || 0),
          completionTokens: (usage?.completionTokens || 0) + (r2.usage.completionTokens || 0),
          totalTokens: (usage?.totalTokens || 0) + (r2.usage.totalTokens || 0),
        }
      }
      const again = parsePlanDraftPayload(t2)
      if (!again.error) { parsed = again; text = t2 }
      else parsed = { ...again, error: `${parsed.error}（重试一次仍是 ${again.kind || '坏结构'}）` }
    } catch (e: any) {
      parsed = { ...parsed, error: `${parsed.error}（重试调用失败：${e?.message || e}）` }
    }
  }
  if (parsed.error) {
    writeTrace({
      ts: nowIso, trigger: `${DEFAULT_SYSTEM_TRIGGER}:${input.project}`, model,
      prompt_chars: user.length, completion_chars: text.length, duration_ms: Date.now() - t0,
      ok: false, stream: false, origin: 'local',
      error: parsed.error.slice(0, 300), fail_kind: parsed.kind || '', retried,
    })
    return { ok: false, error: parsed.error, allowed, failKind: parsed.kind || '', retried }
  }

  // ── 宪法页（2026-11-10）：没有它整份不合格 ──────────────────────────
  // H2（D-065）选的是「宪法 + 产线 + 判据三件套」；首战那次只出了产线 + 判据，
  // 按 H2 自己的验收线「只产出任务清单 = 没过」——所以现在把这条做成机器判据。
  const cons = validateConstitution(parsed.constitution || [], allowed)
  if (!cons.rows.length) {
    writeTrace({
      ts: nowIso, trigger: `${DEFAULT_SYSTEM_TRIGGER}:${input.project}`, model,
      prompt_chars: user.length, completion_chars: text.length, duration_ms: Date.now() - t0,
      ok: false, stream: false, origin: 'local',
      error: '没有宪法页 / 引不出依据', fail_kind: 'no_constitution', retried,
    })
    const why = cons.dropped.length ? `被丢掉的 ${cons.dropped.length} 行：${cons.dropped.join('；')}` : '模型没给 constitution 字段'
    return {
      ok: false, allowed, retried,
      error: `没有「宪法」一页 —— H2 要的是三件套（宪法 + 产线 + 判据），只出阶段卡 = 没过。${why}`,
    }
  }
  if (!cons.rows.some((r) => r.kind === '已定')) {
    return { ok: false, allowed, retried, error: '宪法页里没有一条「已定」结论 —— 那不是旗帜，是待办清单' }
  }

  // ── 本轮要先问的问题（2026-11-10）：没有新问题也必须说理由 ──────────
  const asks: ValidAsk[] = (parsed.asks || [])
    .map((a) => ({ ask: String(a?.ask || '').trim(), why: String(a?.why || '').trim() }))
    .filter((a) => a.ask.length > 0)
  const asksNote = String(parsed.asksNote || '').trim()
  if (!parsed.hasAsks) {
    return {
      ok: false, allowed, retried,
      error: '没有「本轮要先问的问题」这一段 —— 起草前必须先说清还缺哪些只有用户能答的问题（没有也要写 asks: [] 并给 asksNote）',
    }
  }
  if (!asks.length && !asksNote) {
    return { ok: false, allowed, retried, error: 'asks 是空的，而且没写理由 —— “没有新问题”也要说清为什么（asksNote）' }
  }

  const v = validateDraftStages(parsed.stages, allowed, { repoRoot: input.repoRoot })
  if (!v.stages.length) {
    writeTrace({
      ts: nowIso, trigger: `${DEFAULT_SYSTEM_TRIGGER}:${input.project}`, model,
      prompt_chars: user.length, completion_chars: text.length, duration_ms: Date.now() - t0,
      ok: false, stream: false, origin: 'local',
      error: `所有建议都引不出依据，已全部丢弃（${v.dropped.length} 条）`,
    })
    const greenNote = v.alreadyGreen ? `（其中 ${v.alreadyGreen} 条是因为“判据现状就已满足”被丢）` : ''
    return {
      ok: false, allowed, retried, dropped: v.dropped, missingCitations: v.missingCitations,
      error: `模型给了 ${parsed.stages.length} 条建议，但没有一条过关${greenNote} —— 已全部丢弃`,
    }
  }

  const markdown = renderPlanDraft(input, v.stages, {
    date, model, constitution: cons.rows, asks, asksNote,
  })
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
    // 重试救回来的要说出来 —— 否则"救回来多少"以后永远算不出来
    ...(retried ? { retried: true } : {}),
  }
  if (usage) {
    if (typeof usage.promptTokens === 'number') rec.prompt_tokens = usage.promptTokens
    if (typeof usage.completionTokens === 'number') rec.completion_tokens = usage.completionTokens
    if (typeof usage.totalTokens === 'number') rec.total_tokens = usage.totalTokens
  }
  writeTrace(rec)

  return {
    ok: true, file, markdown, stages: v.stages, dropped: v.dropped,
    missingCitations: v.missingCitations, alreadyGreen: v.alreadyGreen,
    constitution: cons.rows, asks, asksNote,
    usage, model, allowed, retried,
  }
}
