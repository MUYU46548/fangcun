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

/** 生成可粘贴的 decision-log 段落（也是导出文件的内容） */
export function buildDecisionLog(parsed: QDeck, answers: Record<string, QAnswer>, deckName: string, date?: string): string {
  const day = date || new Date().toISOString().slice(0, 10)
  const lines: string[] = [`# ${parsed.title || deckName} · 答卷（${day}）`, '']
  const asks: { id: string; text: string }[] = []
  parsed.questions.forEach((q) => {
    const a = answers[q.id]
    if (!a) { lines.push(`- **${q.id}** —— 未答`); return }
    if (a.kind === 'skip') { lines.push(`- **${q.id}** —— 跳过（下次再问）`); return }
    if (a.kind === 'reject') { lines.push(`- **${q.id}** —— 否决：这题不该问，不再出现`); return }
    if (a.kind === 'askback') { lines.push(`- **${q.id}** —— 反问（见下）`); asks.push({ id: q.id, text: a.text || '' }); return }
    if (a.kind === 'amend') { lines.push(`- **${q.id}** —— ${a.text}（自述）`); return }
    const o = q.options.find((x) => x.k === a.k)
    lines.push(`- **${q.id}** —— ${a.k}. ${o ? o.t : ''}`)
  })
  if (asks.length) {
    lines.push('', '## 反问（回给 agent 重写题目）', '')
    asks.forEach((x) => lines.push(`- **${x.id}**：${x.text}`))
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
    const r = addDecision({
      内容: line.replace(/^\[[^\]]+\]\s*/, ''),   // 内容里不重复日期前缀（日期是独立字段）
      日期: day,
      状态: '有效',
      出处: `问卷 ${name} · ${q.id}`,
      备注: q.ask ? q.ask.slice(0, 200) : '',
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

/** 已有决策卡条数（界面显示“落库后会有几条”用得上） */
export function decisionCount(): number {
  try { return loadDecisions().length } catch { return 0 }
}
