/**
 * 规划草案（`task-data/plans/_drafts/*.md`）的读取与「提成阶段卡」（0.7.0 规划根基）
 *
 * 为什么要这一层：`generatePlanDraft` / `plan_submit` 早就把草案写进 `_drafts/` 了，
 * 但**界面上看不见** —— 用户要看草案只能去文件里翻，于是“agent 起草 → 人裁决”这条链
 * 只通了半截（起草有、裁决入口没有）。这里补的是那半截：
 *   读草案 → 逐格显示（宪法 / 要先问的题 / 三块齐不齐）→ 点「提成阶段卡」→
 *   **走同一条闸**（`proposeStage`：三块校验 + 澄清卷硬闸 + 重号检查），不另开写口。
 *
 * 三条硬纪律：
 *   ① 草案是**只读**的：这里不写 `_drafts/` 一个字节（断言逐字节比对）；
 *   ② 提成时不信任界面传来的正文 —— 一律**服务器侧重读草案**，按 (draft, stageId) 取块；
 *   ③ 缺块就在界面上说缺什么、并**不给**提议按钮（`missing` 非空即拒）。
 *
 * 2026-11-12 补第二半（0.7.0 规划根基第二轮）：**提成时就地改三块**。
 *   在此之前只能整格原样提成 —— 判据写歪一个字，唯一的路是回去让 agent 重写整份草案，
 *   而“我看一眼、改一下再收”恰恰是裁决这个动作本身该包含的。现在：
 *     · 界面把改过的三块（`patch`）随提成一起交上来；
 *     · 主进程**先用草案原文当底**、只把这三块覆盖上去（`applyPatch`，id/标题/做什么不可改）；
 *     · 仍然只调 `proposeStage` —— 不新开写路径，草案文件依旧一个字节不写。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getTaskDir } from './index'
import { proposeStage, readPlan, type PlanDoc, type PlanStage, type ProposeStageResult } from './plans'
import {
  applyPatch, diffStage, editNote, isSepRow, missingOf, validateStage,
  type EditSummary, type StagePatch,
} from '../../shared/draftEdit'

export interface DraftStage {
  id: string
  title: string
  what: string
  approach: string[]
  /** 照抄点的**原始表格行**（含表头与分隔线，提成时原样落地） */
  copyRows: string[][]
  criteria: string[]
  /** 缺哪几块（空 = 三块齐全，可以提成阶段卡） */
  missing: string[]
}

export interface DraftDoc {
  file: string
  project: string
  version: string
  date: string
  /** 宪法页：类型（已定 / 待定 / 冲突 / 作废）+ 结论 + 依据 */
  constitution: { type: string; text: string; cite: string }[]
  asks: string[]
  stages: DraftStage[]
  path: string
}

const DRAFTS_SUBDIR = '_drafts'
const STAGE_HEAD = /^###\s+(P\d+)\s*[·:：]?\s*(.*)$/

function draftsDir(): string {
  return path.join(getTaskDir(), 'plans', DRAFTS_SUBDIR)
}

/** 草案文件名（相对 `task-data/plans`：`_drafts/<名>.md`） */
export function listDraftFiles(): string[] {
  const dir = draftsDir()
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .sort()
    .map((f) => `${DRAFTS_SUBDIR}/${f}`)
}

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return t.split('|').map((c) => c.trim())
}

/** 解析一份草案。坏输入返回 null（界面据此显示“读不出来”，不糊一个空壳）。 */
export function readDraft(rel: string): DraftDoc | null {
  const name = path.basename(String(rel || ''))
  if (!name || !name.endsWith('.md')) return null
  const p = path.join(draftsDir(), name)
  if (!fs.existsSync(p)) return null
  const text = fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n')
  const lines = text.split('\n')

  const titleLine = (lines.find((l) => /^#\s+/.test(l)) || '').replace(/^#\s+/, '')
  // 项目 id 决定「提成后落到哪个计划卡」——**必须对得上 plans/<项目id>.md 的文件名**。
  //
  // ⚠ 2026-11-12 实测（起草隔壁同类产品草案时踩到）：原来只从标题里取 `# xxx · 作战计划` 的第一段。
  //   方寸自己的草案标题写 `# fangcun-base · …`（英文 id）→ 恰好对；
  //   隔壁同类产品草案标题写 `# 隔壁同类产品 · …`（中文名）→ 解析出 project="隔壁同类产品" → 去找 `隔壁同类产品.md`
  //   → 那个文件不存在 → **面板上根本提不成**（用户实测「我找不到」）。
  //   这不是显示问题，是“换个项目就失效”。
  //
  // 新的取法（按可靠性排序，全都要能对上真实文件名）：
  //   ① 草案 frontmatter 显式 `项目: sitian` / `- 项目: sitian`（起草时就该写）；
  //   ② 文件名前缀（`sitian-2026-11-12.md` → `sitian`）—— 草案由生成器命名，前缀就是 id；
  //   ③ 标题第一段（老草案只有这个）。
  const kvProject = (/^\s*-?\s*项目\s*[:：]\s*(.+)$/m.exec(text) || [])[1]
  // ⚠ 文件名前缀要用**日期段**切，不能用 `split('-')[0]` ——
  //   ① 项目 id 自己就带连字符（`fangcun-base` / `dsh-fangcun` / `python-workspace`）；
  //   ② 生成器还会加后缀（`fangcun-base-2026-11-10-v2-关思考.md`）。
  //   按 `-` 切第一段会把两者都切错（实测：`fangcun-base-2026-11-10-v1` 被当成项目 id）。
  //   所以从**第一个 `-YYYY-MM-DD` 处**截断，后面全是版本/后缀。
  const namePrefix = name
    .replace(/\.md$/i, '')
    .replace(/-\d{4}-\d{2}-\d{2}(?:[-\s].*)?$/, '')
  const fromTitle = titleLine.split(/[·:：]/)[0].trim()
  const project = String(kvProject || '').trim() || namePrefix || fromTitle
  const kv = (k: string) => {
    const m = new RegExp(`^\\s*-\\s*${k}\\s*[:：]\\s*(.*)$`, 'm').exec(text)
    return m ? m[1].trim() : ''
  }

  const constitution: DraftDoc['constitution'] = []
  const asks: string[] = []
  const stages: DraftStage[] = []
  let section: '' | 'const' | 'asks' = ''
  let cur: DraftStage | null = null
  let mode: '' | 'approach' | 'copy' | 'criteria' = ''

  const flush = () => {
    if (!cur) return
    // 「缺什么」只由 shared/draftEdit 算（界面与主进程同一口径；见该文件顶部硬纪律②）
    cur.missing = missingOf(cur)
    stages.push(cur)
    cur = null
    mode = ''
  }

  for (const line of lines) {
    const stageHead = STAGE_HEAD.exec(line)
    if (stageHead) {
      flush()
      cur = { id: stageHead[1].toUpperCase(), title: stageHead[2].trim(), what: '', approach: [], copyRows: [], criteria: [], missing: [] }
      section = ''
      continue
    }
    if (/^##\s+/.test(line)) {
      flush()
      const head = line.replace(/^##\s+/, '').trim()
      section = /宪法/.test(head) ? 'const' : /先问/.test(head) ? 'asks' : ''
      mode = ''
      continue
    }
    if (cur) {
      const key = /^\s*-\s*(技术方案|照抄点|判据|做什么)\s*[:：]\s*(.*)$/.exec(line)
      if (key) {
        const k = key[1]
        if (k === '做什么') cur.what = key[2].trim()
        mode = k === '技术方案' ? 'approach' : k === '照抄点' ? 'copy' : k === '判据' ? 'criteria' : ''
        continue
      }
      if (mode === 'copy') {
        if (line.trim().startsWith('|')) { cur.copyRows.push(splitRow(line)); continue }
        if (line.trim() === '') continue
      }
      if (mode === 'approach' || mode === 'criteria') {
        const item = /^\s*-\s+(.*)$/.exec(line)
        // ⚠ 2026-11-12 实测（起草隔壁同类产品草案时踩到）：`- 依据:` 是阶段卡的**普通字段**，
        //   但上面那条 item 正则也认它（顶格 `- xxx`）—— 于是「依据」被当成一条判据，
        //   而它没有 cmd/str/num/file 前缀 → 整格被判「判据没前缀」，草案永远提不成。
        //   真实草案（`fangcun-base-2026-11-11.md`）每格都有这一行，所以这不是个例。
        //   判据段里只收**缩进的** `  - xxx`；顶格的 `- 状态/依据/做什么/裁决/证据` 是字段，不是判据。
        const isField = /^\s{0,1}-\s*(依据|状态|裁决|打回理由|证据|澄清|做什么|提议人)\s*[:：]/.test(line)
        if (item && item[1].trim() && !isField) {
          if (mode === 'approach') cur.approach.push(item[1].trim())
          else cur.criteria.push(item[1].trim())
          continue
        }
        if (line.trim() === '') continue
        if (isField) { mode = ''; continue }   // 撞到下一个字段 = 本块结束
      }
      continue
    }
    if (section === 'const') {
      if (!line.trim().startsWith('|')) continue
      const cells = splitRow(line)
      if (isSepRow(cells)) continue
      if (/^类型$/.test(cells[0] || '') || cells[0] === '') continue
      constitution.push({ type: cells[0] || '', text: cells[1] || '', cite: cells[2] || '' })
      continue
    }
    if (section === 'asks') {
      const item = /^-\s+(.+)$/.exec(line.trim())
      if (item) asks.push(item[1].trim())
    }
  }
  flush()

  return {
    file: name,
    project,
    version: kv('版本'),
    date: kv('日期'),
    constitution,
    asks,
    stages,
    path: p,
  }
}

/** 全部草案（解析失败的略过，但**不静默**：读不出的在 `broken` 里点名） */
export function listDrafts(): { ok: true; drafts: DraftDoc[]; broken: { file: string; why: string }[]; dir: string } {
  const out: DraftDoc[] = []
  const broken: { file: string; why: string }[] = []
  for (const rel of listDraftFiles()) {
    const d = readDraft(rel)
    if (!d || !d.stages.length) { broken.push({ file: rel, why: d ? '草案里一个阶段卡都没有' : '读不出来（文件损坏或已删）' }); continue }
    out.push(d)
  }
  return { ok: true, drafts: out, broken, dir: draftsDir() }
}

export interface ProposeFromDraftInput {
  /** 草案文件名（`xxx.md` 或 `_drafts/xxx.md` 都收） */
  draft?: string
  stageId?: string
  /** 澄清卷（硬闸要）：已批准、全部已答 —— 与 agent 走 `stage_plan_propose` 时同一个要求 */
  deck?: string
  agent?: string
  now?: string
  /**
   * 提成时**就地改过**的三块（2026-11-12）。没给的块 = 原样用草案里的。
   * ⚠ 只能改这三块：阶段号 / 标题 / 做什么一律以草案为准（改了“提的是哪一格”就说不清了）。
   */
  patch?: StagePatch
}

/**
 * 草案的某一格 → 真阶段卡。**走同一条闸**：`proposeStage` 负责三块校验、判据前缀、
 * 重号检查与澄清卷硬闸；这里只做「按 (草案, 格) 取出正文 + 目标计划文件」。
 *
 * 2026-11-12：提成时可以带 `patch`（界面上改过的三块）。处理顺序是刻意的 ——
 *   **先把改动合上去再判缺块**：否则“草案里缺判据、我在编辑框里补了”这条最常见的用法
 *   会被草案原文的 `missing` 挡住（旧逻辑就是这个顺序，于是“改了也提不了”）。
 */
export function proposeFromDraft(input: ProposeFromDraftInput): ProposeStageResult & {
  planFile?: string; draft?: string; edit?: EditSummary
} {
  const name = path.basename(String(input?.draft || ''))
  const draft = name ? readDraft(name) : null
  if (!draft) return { ok: false, error: `读不出草案：${name || '（没给文件名）'}` }
  const stageId = String(input?.stageId || '').trim().toUpperCase()
  const found = draft.stages.find((s) => s.id === stageId)
  if (!found) return { ok: false, error: `草案《${draft.file}》里没有阶段 ${stageId || '（没给 id）'}` }

  // ① 合改动（只三块），再按**合并后的内容**判缺块与体检
  const stage = applyPatch(found, input?.patch)
  const edit = diffStage(found, stage)
  const problems = validateStage(stage)
  if (problems.length) {
    return { ok: false, error: `这一格的内容过不了体检：${problems.join('；')}（草案文件没动，改完再提一次）` }
  }
  const missing = missingOf(stage)
  if (missing.length) {
    return {
      ok: false,
      error: `这一格还缺 ${missing.join(' / ')} —— 三块齐全才给提成阶段卡（缺块提进去也冻结不了）`,
      draft: draft.file,
      edit,
    }
  }

  const planFile = `${draft.project}.md`
  // 提议人里带上“改过哪几块”：计划卡落地后仍看得见这格是提成时改的（留痕不是发版说明的事）
  const baseAgent = String(input?.agent || '方寸·草案入口')
  const agent = edit.count ? `${baseAgent}（${editNote(edit)}）` : baseAgent

  /**
   * 阶段号怎么定（2026-11-18，两稿）。
   *
   * 病根：草案的格号**永远**是 P0/P1/…（生成器不看目标计划卡），而提成时若沿用草案号，
   * `proposeStage` 的自动续号（max+1）就永远用不上 → 5 份草案点十次都是同一句
   * "阶段 P0 已存在"（`4-份-…-草案与…` 那张卡说的就是这个）。
   *
   * ⚠ 但**不能因此就一律不传**（第一稿就是这么写的，被 4 条断言当场按住）：
   *   一律自动续号会让「同一格连点两次」变成两条一模一样的阶段卡 —— 那是把
   *   "防重复提成"这道唯一的闸拆掉了，比原来更糟。
   *
   * 所以分辨两件事：
   *   ① **同一格被再提一次** → 拒（按内容判：标题 + 判据全同 = 同一格）
   *   ② **撞号但内容不同**（典型的"草案从 P0 起、计划卡也已有 P0"）→ 自动接到最大号后面
   */
  const planDoc = readPlan(planFile)
  /** 撞号了吗？撞号 = 计划卡里已有同号但**内容不同**的一格 */
  let collided = false
  if (planDoc) {
    const sameContent = (s: PlanStage): boolean => {
      if (String(s.title || '').trim() !== String(stage.title || '').trim()) return false
      const a = (s.criteria || []).map((x) => String(x).trim()).join('\u0001')
      const b = (stage.criteria || []).map((x) => String(x).trim()).join('\u0001')
      return a === b
    }
    // ① 这一格已经在计划卡里了（不管占的是哪个号）→ 拒，别造重复
    const dup = planDoc.stages.find(sameContent)
    if (dup) {
      return {
        ok: false,
        error: `这一格已经在计划卡里了（${dup.id}「${String(dup.title || '').trim()}」）—— 同一格不用再提一次；要改它请在界面上用「改一句」`,
        planFile, draft: draft.file, edit,
      }
    }
    // ② 撞号（同号但内容不同）→ 后面不传 stageId，让 proposeStage 自动接最大号
    collided = planDoc.stages.some((s) => String(s.id || '').toUpperCase() === stageId)
  }

  return {
    ...proposeStage({
      file: planFile,
      title: stage.title,
      what: stage.what,
      approach: stage.approach,
      criteria: stage.criteria,
      copyRows: stage.copyRows,
      copyHasHeader: true,
      // 没撞号 → 沿用草案的号（老行为，一格一格按草案编号落地）；
      // 撞号 → 省略 stageId，由 proposeStage 的 nextStageId 接在最大号后面。
      ...(collided ? {} : { stageId: stage.id }),
      deck: String(input?.deck || ''),
      agent,
      now: input?.now,
    }),
    planFile,
    draft: draft.file,
    edit,
  }
}

/** 给界面用的「已批准、可以当澄清卷」的候选（按项目筛；空项目 = 全部） */
export function approvedDecksFor(project: string, decks: { deck: string; project: string; approved: boolean; voided?: boolean; replacedBy?: string }[]): { deck: string; project: string }[] {
  const want = String(project || '').trim()
  return decks
    .filter((d) => d.approved && !d.voided && !d.replacedBy)
    .filter((d) => !want || !d.project || d.project === want)
    .map((d) => ({ deck: d.deck, project: d.project }))
}

/** 类型出口：界面/测试直接引用 */
export type { PlanDoc, PlanStage }
