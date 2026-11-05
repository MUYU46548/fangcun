/**
 * 问卷数据层（2026-11-05）—— 与 `plans/` 同构，落 `task-data/questionnaires/`。
 *
 * 为什么放方寸自己的 task-data、**不写回项目仓库**：
 * 契约写明「不写别人的仓库，对项目 repo 只读」。问卷的答案属于**你的决定**，
 * 方寸只负责收；要落到 `shared/<项目>/decision-log.md` 里去，走“导出 md + 你自己贴”
 * （或者让 agent 拿导出的 md 去写）—— 这条边界不能松。
 *
 * 三份文件，各管一件事：
 *   `<卷名>.md`            问卷本身（agent 写的；方寸**只读**）
 *   `<卷名>.answers.json`  作答草稿 / 已批准（方寸写）
 *   `<卷名>.decision-log.md` 批准后导出的 decision-log 段落（方寸写，供你贴走）
 */
import * as fs from 'fs'
import * as path from 'path'
import { getTaskDir } from './index'
import { addDecision, loadDecisions } from './decisions'
import { parseQuestionnaire, type QDeck } from '../../shared/questionnaire'
import { askbacksOf, buildRewritePrompt, buildWorkOrderPrompt } from '../../shared/qnPrompts'

export interface QAnswer {
  kind: 'pick' | 'skip' | 'reject' | 'askback' | 'amend'
  /** pick 时的选项键 */
  k?: string
  /** amend / askback 时的原话 */
  text?: string
  at?: string
}

export interface QAnswersFile {
  /** 卷名（= 文件名去后缀） */
  deck: string
  answers: Record<string, QAnswer>
  /** 批准时间；没批准就是空串 */
  approvedAt: string
  updatedAt: string
}

export interface QDeckBrief {
  deck: string
  title: string
  layer: string
  total: number
  answered: number
  approved: boolean
  error?: string
}

export function questionnaireDir(): string {
  return path.join(getTaskDir(), 'questionnaires')
}

function safeName(name: string): string {
  // 只允许文件名，不许带路径（防 ../ 逃逸）
  return String(name || '').replace(/[\\/]/g, '').replace(/\.\./g, '').trim()
}

export function listDeckNames(): string[] {
  const dir = questionnaireDir()
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.endsWith('.decision-log.md') && !f.startsWith('_') && !f.startsWith('.'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort()
}

export function readDeckText(deck: string): string {
  const p = path.join(questionnaireDir(), safeName(deck) + '.md')
  if (!fs.existsSync(p)) return ''
  return fs.readFileSync(p, 'utf-8')
}

export function readAnswers(deck: string): QAnswersFile {
  const p = path.join(questionnaireDir(), safeName(deck) + '.answers.json')
  const empty: QAnswersFile = { deck, answers: {}, approvedAt: '', updatedAt: '' }
  if (!fs.existsSync(p)) return empty
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return {
      deck,
      answers: o && typeof o.answers === 'object' && o.answers ? o.answers : {},
      approvedAt: String(o?.approvedAt || ''),
      updatedAt: String(o?.updatedAt || ''),
    }
  } catch {
    // 答案文件坏了不该让整页打不开 —— 当成“还没答”，并把坏文件另存一份
    try { fs.copyFileSync(p, p + '.broken-' + Date.now()) } catch { /* ignore */ }
    return empty
  }
}

export function writeAnswers(deck: string, input: {
  answers: Record<string, QAnswer>
  approvedAt?: string
}): { ok: true } | { ok: false; error: string } {
  const name = safeName(deck)
  if (!name) return { ok: false, error: '卷名为空' }
  const dir = questionnaireDir()
  fs.mkdirSync(dir, { recursive: true })
  const cur = readAnswers(name)
  const payload: QAnswersFile = {
    deck: name,
    answers: input.answers || {},
    approvedAt: input.approvedAt !== undefined ? String(input.approvedAt) : cur.approvedAt,
    updatedAt: new Date().toISOString(),
  }
  const p = path.join(dir, name + '.answers.json')
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
  fs.renameSync(tmp, p)
  return { ok: true }
}

/** 汇总：有哪些卷、各几题、答了几道、批准没 */
export function listDecks(): { ok: true; decks: QDeckBrief[]; dir: string } {
  const decks = listDeckNames().map((name) => {
    const text = readDeckText(name)
    const d = parseQuestionnaire(text)
    const a = readAnswers(name)
    const answered = d.questions.filter((q) => {
      const x = a.answers[q.id]
      if (!x) return false
      if (x.kind === 'amend' || x.kind === 'askback') return !!(x.text || '').trim()
      return true
    }).length
    return {
      deck: name,
      title: d.title || name,
      layer: d.layer,
      total: d.questions.length,
      answered,
      approved: !!a.approvedAt,
      error: d.error,
    }
  })
  return { ok: true, decks, dir: questionnaireDir() }
}

/** 读一卷：题 + 已有答案 */
export function getDeck(deck: string): {
  ok: boolean
  error?: string
  deck?: string
  parsed?: QDeck
  answers?: Record<string, QAnswer>
  approvedAt?: string
  path?: string
} {
  const name = safeName(deck)
  if (!name) return { ok: false, error: '卷名为空' }
  const dir = questionnaireDir()
  const p = path.join(dir, name + '.md')
  if (!fs.existsSync(p)) {
    return { ok: false, error: `找不到问卷：${p}（把问卷 md 放进这个目录就行）` }
  }
  const parsed = parseQuestionnaire(fs.readFileSync(p, 'utf-8'))
  const a = readAnswers(name)
  return { ok: true, deck: name, parsed, answers: a.answers, approvedAt: a.approvedAt, path: p }
}

/** 一条答案 → decision-log 里的一行（空行 / 跳过 / 否决 / 反问都不落决策） */
export function answerToLogLine(q: { id: string; ask: string; options: { k: string; t: string }[] }, a: QAnswer | undefined, date: string): string {
  if (!a) return ''
  if (a.kind === 'skip' || a.kind === 'reject') return ''
  if (a.kind === 'askback') return ''
  if (a.kind === 'amend') return `[${date}] ${q.id}：${a.text} 生效范围：本卷`
  const o = q.options.find((x) => x.k === a.k)
  return `[${date}] ${q.id}：${a.k || ''}. ${o ? o.t : ''} 生效范围：本卷`
}

/**
 * 生成可粘贴的 decision-log 段落（也是导出文件的内容）。
 *
 * ⚠ 2026-11-05 补了【验收线】：原来导出只有“选了什么”，验收线留在问卷里没跟出来 ——
 *   而验收线正是事后校验的唯一依据（“跨形态派单的任务卡一律打回”这种话，
 *   只写在问卷里的结果就是**下次 agent 动工还是不知道这条线在哪儿**）。
 *   现在每道「打勾 / 改一句」的题下面跟一行 `- 验收线：…`；没有验收线的题显式写“未给”。
 */
export function buildDecisionLog(parsed: QDeck, answers: Record<string, QAnswer>, deckName: string, date?: string): string {
  const day = date || new Date().toISOString().slice(0, 10)
  const lines: string[] = [`# ${parsed.title || deckName} · 答卷（${day}）`, '']
  const asks: { id: string; text: string }[] = []
  /** 每题一条，供末尾“验收线清单”汇总 */
  const accepted: { id: string; line: string }[] = []
  parsed.questions.forEach((q) => {
    const a = answers[q.id]
    if (!a) { lines.push(`- **${q.id}** —— 未答`); return }
    if (a.kind === 'skip') { lines.push(`- **${q.id}** —— 跳过（下次再问）`); return }
    if (a.kind === 'reject') { lines.push(`- **${q.id}** —— 否决：这题不该问，不再出现`); return }
    if (a.kind === 'askback') { lines.push(`- **${q.id}** —— 反问（见下）`); asks.push({ id: q.id, text: a.text || '' }); return }
    let head = ''
    if (a.kind === 'amend') head = `- **${q.id}** —— ${a.text}（自述）`
    else {
      const o = q.options.find((x) => x.k === a.k)
      head = `- **${q.id}** —— ${a.k || ''}. ${o ? o.t : ''}`
    }
    lines.push(head)
    const nl = String(q.line || '').trim().replace(/\s*\n\s*/g, ' ')
    if (nl) {
      lines.push(`  - 验收线：${nl}`)
      accepted.push({ id: q.id, line: nl })
    } else {
      lines.push('  - 验收线：未给（这一条没法事后校验，建议补）')
    }
  })
  if (asks.length) {
    lines.push('', '## 反问（回给 agent 重写题目）', '')
    asks.forEach((x) => lines.push(`- **${x.id}**：${x.text}`))
  }
  if (accepted.length) {
    lines.push('', '## 验收线（搬进相关卡的验收段，别只留在问卷里）', '')
    accepted.forEach((x) => lines.push(`- **${x.id}**：${x.line}`))
  }
  return lines.join('\n') + '\n'
}

/**
 * 批准：**落两处** ——
 *  ① 每道「打勾 / 改一句」建一条决策卡（方寸 `task-data/decisions.md`，本仓自己的数据）；
 *  ② 导出一份 decision-log 段落落到 `questionnaires/<卷>.decision-log.md`，
 *     你（或 agent）再把它贴进项目仓库 —— 方寸不替你写别人家。
 *
 * 幂等：同一份卷重复批准，决策卡按「内容 + 出处」去重（addDecision 自带 exists），
 * 导出文件覆盖。
 */
export function approveDeck(deck: string): {
  ok: boolean
  error?: string
  cards?: number
  existed?: number
  exportPath?: string
  text?: string
} {
  const name = safeName(deck)
  const g = getDeck(name)
  if (!g.ok || !g.parsed) return { ok: false, error: g.error || '读不到问卷' }
  const parsed = g.parsed
  const answers = g.answers || {}
  const day = new Date().toISOString().slice(0, 10)

  let cards = 0
  let existed = 0
  const errors: string[] = []
  parsed.questions.forEach((q) => {
    const a = answers[q.id]
    if (!a) return
    const line = answerToLogLine(q, a, day)
    if (!line) return
    // 备注 = 题干（为什么问）｜ 验收线（什么算违约）。
    // 验收线必须跟着决策走：它只留在问卷里的话，三个月后翻决策卡看不出“当时的线在哪儿”。
    const line0 = String(q.line || '').trim().replace(/\s*\n\s*/g, ' ')
    const note = [q.ask ? q.ask.slice(0, 160) : '', line0 ? `验收线：${line0}` : '']
      .filter(Boolean).join(' ｜ ')
    const r = addDecision({
      内容: line.replace(/^\[[^\]]+\]\s*/, ''),   // 内容里不重复日期前缀（日期是独立字段）
      日期: day,
      状态: '有效',
      出处: `问卷 ${name} · ${q.id}`,
      备注: note,
    })
    // ⚠ 用 `'error' in r` 而不是 `r.ok === false`：本仓 TS（7.x）在 `!r.ok` 下
    //   没能收窄这个可辨识联合，直接写 r.error 会报 TS2339（已实测）。
    if ('error' in r) { errors.push(`${q.id}: ${r.error}`); return }
    if (r.exists) existed++
    else cards++
  })

  const text = buildDecisionLog(parsed, answers, name, day)
  const dir = questionnaireDir()
  fs.mkdirSync(dir, { recursive: true })
  const exportPath = path.join(dir, name + '.decision-log.md')
  fs.writeFileSync(exportPath, text, 'utf-8')

  writeAnswers(name, { answers, approvedAt: new Date().toISOString() })

  // 答案里出现“反问”的，单独回给调用方 —— 它不是决策，是下一轮出题的输入
  return { ok: errors.length === 0, error: errors.join('；') || undefined, cards, existed, exportPath, text }
}

/**
 * 两份出口提示词（2026-11-05）。
 *
 * 为什么要有：反问只记一句话的话，「问题清单」就只是另一个记录文件 ——
 * 谁拿它重写题？这里把它打包成能直接粘给 agent 的提示词，闭环才闭上。
 *
 * `kind`：
 *   · `rewrite` —— 拿反问去重出题（有反问才有意义）；
 *   · `build`   —— 拿答卷去出施工单。**有反问时一律拒绝**：
 *     问题还没定就出单，出的必然是错的（这正是“问卷不是施工单”的意思）。
 */
export function buildPromptForDeck(deck: string, kind: 'rewrite' | 'build'): {
  ok: boolean
  error?: string
  kind?: string
  text?: string
  /** 有几句反问（界面据此决定给哪个按钮） */
  askbacks?: number
  /** 还没定的题（出施工单时 agent 不许自己拍） */
  open?: number
} {
  const name = safeName(deck)
  const g = getDeck(name)
  if (!g.ok || !g.parsed) return { ok: false, error: g.error || '读不到问卷' }
  const answers = g.answers || {}
  // 项目名从卷名前缀取（`司天-宪法层` → `司天`）—— 问卷 md 里没有项目字段，
  // 硬编一个空的会让提示词变成“你在给这个项目出问卷”，agent 还得反问一次。
  const project = name.split('-')[0] || ''
  const opts = {
    deck: name,
    title: g.parsed.title || name,
    path: g.path,
    project,
    questions: g.parsed.questions,
    answers,
  }
  const asks = askbacksOf(g.parsed.questions, answers)
  const openCount = g.parsed.questions.filter((q) => {
    const a = answers[q.id]
    return !a || a.kind === 'skip'
  }).length
  const base = { askbacks: asks.length, open: openCount }

  if (kind === 'build') {
    if (asks.length) {
      return {
        ...base, ok: false,
        error: `还有 ${asks.length} 道题被反问 —— 问题还没定，这时候出的施工单必然是错的。先「重出题」。`,
      }
    }
    const text = buildWorkOrderPrompt(opts)
    if (!text) return { ...base, ok: false, error: '这卷还没有任何“打勾 / 改一句”的答案 —— 没有可出单的东西' }
    return { ...base, ok: true, kind, text }
  }

  if (!asks.length) return { ...base, ok: false, error: '这卷没有反问 —— 没什么可重出的' }
  const text = buildRewritePrompt(opts)
  if (!text) return { ...base, ok: false, error: '反问内容都是空的，没法打包' }
  return { ...base, ok: true, kind, text }
}

/** 已有决策卡条数（界面显示“落库后会有几条”用得上） */
export function decisionCount(): number {
  try { return loadDecisions().length } catch { return 0 }
}
