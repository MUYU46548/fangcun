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
import { addDecision, loadDecisions, setDecisionStatus } from './decisions'
import { parseQuestionnaire, costGaps, type QDeck } from '../../shared/questionnaire'
import { askbacksOf, buildRewritePrompt, buildWorkOrderPrompt, costGapsOf } from '../../shared/qnPrompts'

export interface QAnswer {
  /**
   * `void` = **这一项作废**（2026-11-07 补）。
   * 与「否决」不是一回事：否决 = 这题不该问（答案压根不存在）；
   * 作废 = 当时答得对、后来需求变了（答案曾经成立）。两者都不进导出，但语义差在"曾经成立过"。
   */
  kind: 'pick' | 'skip' | 'reject' | 'askback' | 'amend' | 'void'
  /** pick 时的选项键 */
  k?: string
  /** amend / askback / void 时的原话（void 时是作废原因） */
  text?: string
  at?: string
}

/**
 * 事后校验结论（2026-11-07 补，暮雨 11-05 认可的第三条：「答案要能被反驳」）。
 *
 * 为什么必须有：decision-log 的真价值不是"记下来"，是**事后能拿它验**
 * （“你选了本地文件 + 版本化，但现在代码里没有版本化”）。
 * 答完就再也没人回头看，那份决策库就只是一堆听起来很有道理的句子。
 */
export interface QAudit {
  verdict: 'ok' | 'refuted'
  /** 一句证据（可空 —— 「成立」可以不说，但「被推翻」必须说清凭什么是推翻） */
  evidence: string
  at: string
}

export interface QAnswersFile {
  /** 卷名（= 文件名去后缀） */
  deck: string
  answers: Record<string, QAnswer>
  /** 批准时间；没批准就是空串 */
  approvedAt: string
  updatedAt: string
  /** 整卷作废时间（空 = 没作废） */
  voidedAt?: string
  /** 整卷作废原因（必须写 —— 三个月后要能看懂当时为什么推翻） */
  voidReason?: string
  /** 逐题的事后校验结论 */
  audits?: Record<string, QAudit>
}

export interface QDeckBrief {
  deck: string
  title: string
  layer: string
  total: number
  answered: number
  approved: boolean
  /** 这卷已作废（答案不再作数） */
  voided?: boolean
  /** 卷面里「没写代价」的选项数（>0 时界面要黄条点名） */
  costGaps?: number
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
      voidedAt: String(o?.voidedAt || ''),
      voidReason: String(o?.voidReason || ''),
      audits: o && typeof o.audits === 'object' && o.audits ? o.audits : {},
    }
  } catch {
    // 答案文件坏了不该让整页打不开 —— 当成“还没答”，并把坏文件另存一份
    try { fs.copyFileSync(p, p + '.broken-' + Date.now()) } catch { /* ignore */ }
    return empty
  }
}

/**
 * 存答案。
 *
 * ⚠ **没传 ≠ 清空**（记忆纪律）：`voidedAt` / `voidReason` / `audits` 只在显式给了值时才改，
 *   `undefined` 一律沿用旧值。否则每点一下选项（界面只传 answers）就会把"作废"和"校验结论"洗掉 ——
 *   这正是本项目在 `savePolicy` 上踩过的同一个坑。
 */
export function writeAnswers(deck: string, input: {
  answers: Record<string, QAnswer>
  approvedAt?: string
  voidedAt?: string
  voidReason?: string
  audits?: Record<string, QAudit>
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
    voidedAt: input.voidedAt !== undefined ? String(input.voidedAt) : (cur.voidedAt || ''),
    voidReason: input.voidReason !== undefined ? String(input.voidReason) : (cur.voidReason || ''),
    audits: input.audits !== undefined ? input.audits : (cur.audits || {}),
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
      voided: !!a.voidedAt,
      costGaps: costGaps(d).length,
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
  /** 最后一次改动（没批准时用它当校验计时基准） */
  updatedAt?: string
  voidedAt?: string
  voidReason?: string
  audits?: Record<string, QAudit>
  /** 卷面里没写代价的选项（界面黄条点名用） */
  costGaps?: { id: string; k: string; t: string }[]
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
  return {
    ok: true, deck: name, parsed, answers: a.answers, approvedAt: a.approvedAt,
    updatedAt: a.updatedAt || '', voidedAt: a.voidedAt || '', voidReason: a.voidReason || '',
    audits: a.audits || {}, costGaps: costGaps(parsed), path: p,
  }
}

/** 一条答案 → decision-log 里的一行（空行 / 跳过 / 否决 / 反问 / 作废都不落决策） */
export function answerToLogLine(q: { id: string; ask: string; options: { k: string; t: string }[] }, a: QAnswer | undefined, date: string): string {
  if (!a) return ''
  if (a.kind === 'skip' || a.kind === 'reject') return ''
  if (a.kind === 'askback') return ''
  if (a.kind === 'void') return ''
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
export function buildDecisionLog(
  parsed: QDeck,
  answers: Record<string, QAnswer>,
  deckName: string,
  date?: string,
  opts?: { audits?: Record<string, QAudit>; voidedAt?: string; voidReason?: string },
): string {
  const day = date || new Date().toISOString().slice(0, 10)
  const audits = (opts && opts.audits) || {}
  const head = `# ${parsed.title || deckName} · 答卷（${day}）`
  // 作废的卷照样导出，但**标题里就写明作废** —— 不导出会让"当时答过什么"永久消失，
  // 直接导出又会被人当成有效结论。带上日期 + 原因，读的人一眼知道它不作数。
  const voided = String((opts && opts.voidedAt) || '').trim()
  const lines: string[] = [
    voided
      ? `${head} —— ⚠ **已作废**（${voided.slice(0, 10)}：${(opts && opts.voidReason) || '未写原因'}）`
      : head,
    '',
  ]
  const asks: { id: string; text: string }[] = []
  /** 每题一条，供末尾“验收线清单”汇总 */
  const accepted: { id: string; line: string }[] = []
  const refuted: { id: string; evidence: string }[] = []
  parsed.questions.forEach((q) => {
    const a = answers[q.id]
    if (!a) { lines.push(`- **${q.id}** —— 未答`); return }
    if (a.kind === 'skip') { lines.push(`- **${q.id}** —— 跳过（下次再问）`); return }
    if (a.kind === 'reject') { lines.push(`- **${q.id}** —— 否决：这题不该问，不再出现`); return }
    if (a.kind === 'askback') { lines.push(`- **${q.id}** —— 反问（见下）`); asks.push({ id: q.id, text: a.text || '' }); return }
    if (a.kind === 'void') {
      lines.push(`- **${q.id}** —— ~~作废~~：${a.text || '未写原因'}（当时答过，现已失效）`)
      return
    }
    let head2 = ''
    if (a.kind === 'amend') head2 = `- **${q.id}** —— ${a.text}（自述）`
    else {
      const o = q.options.find((x) => x.k === a.k)
      head2 = `- **${q.id}** —— ${a.k || ''}. ${o ? o.t : ''}`
    }
    lines.push(head2)
    const nl = String(q.line || '').trim().replace(/\s*\n\s*/g, ' ')
    if (nl) {
      lines.push(`  - 验收线：${nl}`)
      accepted.push({ id: q.id, line: nl })
    } else {
      lines.push('  - 验收线：未给（这一条没法事后校验，建议补）')
    }
    // 事后校验结论跟着答案走：只记在界面里的话，导出出去的那份仍然"永远成立"
    const au = audits[q.id]
    if (au && au.verdict === 'refuted') {
      lines.push(`  - ⚠ 事后校验：**已被推翻**（${au.at.slice(0, 10)}）${au.evidence ? '：' + au.evidence : ''}`)
      refuted.push({ id: q.id, evidence: au.evidence || '' })
    } else if (au && au.verdict === 'ok') {
      lines.push(`  - 事后校验：仍成立（${au.at.slice(0, 10)}）${au.evidence ? '：' + au.evidence : ''}`)
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
  if (refuted.length) {
    lines.push('', '## 已被推翻的答案（别再拿它们当依据）', '')
    refuted.forEach((x) => lines.push(`- **${x.id}**：${x.evidence || '未写证据'}`))
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
  revived?: number
  revoked?: number
  exportPath?: string
  text?: string
} {
  const name = safeName(deck)
  const g = getDeck(name)
  if (!g.ok || !g.parsed) return { ok: false, error: g.error || '读不到问卷' }
  // 作废的卷不许再批准：作废的含义就是"这些答案不作数"。
  // 要恢复得显式点「恢复这卷」（`reopenDeck`），不能让"再点一次批准"悄悄把它复活。
  if (g.voidedAt) {
    return { ok: false, error: `这卷已作废（${String(g.voidedAt).slice(0, 10)}：${g.voidReason || '未写原因'}）—— 先「恢复这卷」再批准` }
  }
  const parsed = g.parsed
  const answers = g.answers || {}
  const audits = g.audits || {}
  const day = new Date().toISOString().slice(0, 10)

  let cards = 0
  let existed = 0
  let revived = 0
  let revoked = 0
  const errors: string[] = []
  parsed.questions.forEach((q) => {
    const a = answers[q.id]
    if (!a) return
    if (a.kind === 'void') return      // 单题作废：不进决策
    const line = answerToLogLine(q, a, day)
    if (!line) return
    // 备注 = 题干（为什么问）｜ 验收线（什么算违约）。
    // 验收线必须跟着决策走：它只留在问卷里的话，三个月后翻决策卡看不出“当时的线在哪儿”。
    const line0 = String(q.line || '').trim().replace(/\s*\n\s*/g, ' ')
    const note = [q.ask ? q.ask.slice(0, 160) : '', line0 ? `验收线：${line0}` : '']
      .filter(Boolean).join(' ｜ ')
    const 出处 = `问卷 ${name} · ${q.id}`
    const r = addDecision({
      内容: line.replace(/^\[[^\]]+\]\s*/, ''),   // 内容里不重复日期前缀（日期是独立字段）
      日期: day,
      状态: '有效',
      出处,
      备注: note,
    })
    // ⚠ 用 `'error' in r` 而不是 `r.ok === false`：本仓 TS（7.x）在 `!r.ok` 下
    //   没能收窄这个可辨识联合，直接写 r.error 会报 TS2339（已实测）。
    if ('error' in r) { errors.push(`${q.id}: ${r.error}`); return }
    if (r.exists) {
      existed++
      // 之前被作废/被推翻过的同类决策：按最新答卷重新批准时该复活。
      // 不复活的话，用户"恢复这卷 → 重新批准"之后决策卡还挂着「已撤销」，界面会说假话。
      const old = loadDecisions().find((d) => d.id === r.id)
      if (old && old.状态 === '已撤销') {
        const rr = setDecisionStatus(r.id, '有效', `按 ${day} 的重新批准恢复（原：${old.状态}）`)
        if ('error' in rr) errors.push(`${q.id}: ${rr.error}`)
        else revived++
      }
    } else cards++
    // 事后校验已判「被推翻」的，批准时必须把决策卡也压成已撤销 —— 否则导出写"已推翻"、
    // 决策卡写"有效"，同一个事实在两张表里互相打脸。
    const au = audits[q.id]
    if (au && au.verdict === 'refuted') {
      const rr = setDecisionStatus(r.id, '已撤销', `事后校验被推翻（${au.at.slice(0, 10)}）${au.evidence ? '：' + au.evidence : ''}`)
      if ('error' in rr) errors.push(`${q.id}: ${rr.error}`)
      else revoked++
    }
  })

  const text = buildDecisionLog(parsed, answers, name, day, {
    audits, voidedAt: g.voidedAt, voidReason: g.voidReason,
  })
  const dir = questionnaireDir()
  fs.mkdirSync(dir, { recursive: true })
  const exportPath = path.join(dir, name + '.decision-log.md')
  fs.writeFileSync(exportPath, text, 'utf-8')

  writeAnswers(name, { answers, approvedAt: new Date().toISOString() })

  // 答案里出现“反问”的，单独回给调用方 —— 它不是决策，是下一轮出题的输入
  return { ok: errors.length === 0, error: errors.join('；') || undefined, cards, existed, revived, revoked, exportPath, text }
}

/**
 * 整卷作废（2026-11-07 补，暮雨 11-05 认可的第四条：「作废机制」）。
 *
 * 为什么必须有：需求变了，旧答案就过期了。没有作废标记的话，**agent 会拿两年前的答案当依据干活** ——
 * 而且它看起来"有出处"，比没答案更危险。
 *
 * 与「否决」的分工：否决 = 这题压根不该问；作废 = 当时答得对，现在不作数了。
 * 作废**必须写原因**（空原因直接拒），因为三个月后唯一能救命的线索就是那句原因。
 * 已批准的卷作废时，把相关决策卡一并压成「已撤销」（quote 原决策卡 id）。
 */
export function voidDeck(deck: string, reason: string): {
  ok: boolean
  error?: string
  revoked?: number
  voidedAt?: string
} {
  const name = safeName(deck)
  const why = String(reason || '').trim()
  if (!why) return { ok: false, error: '作废要写原因 —— 三个月后没人记得为什么' }
  const g = getDeck(name)
  if (!g.ok || !g.parsed) return { ok: false, error: g.error || '读不到问卷' }
  const answers = g.answers || {}
  const at = new Date().toISOString()

  let revoked = 0
  const errors: string[] = []
  const all = loadDecisions()
  for (const q of g.parsed.questions) {
    const d = all.find((x) => x.出处 === `问卷 ${name} · ${q.id}`)
    if (!d || d.状态 !== '有效') continue
    const r = setDecisionStatus(d.id, '已撤销', `问卷作废（${at.slice(0, 10)}）：${why}`)
    if ('error' in r) errors.push(r.error)
    else revoked++
  }
  const w = writeAnswers(name, { answers, voidedAt: at, voidReason: why })
  if ('error' in w) errors.push(w.error)
  return { ok: errors.length === 0, error: errors.join('；') || undefined, revoked, voidedAt: at }
}

/** 恢复作废的卷（只清标记；决策卡要重新批准才会复活 —— 不悄悄复活） */
export function reopenDeck(deck: string): { ok: boolean; error?: string } {
  const name = safeName(deck)
  const g = getDeck(name)
  if (!g.ok) return { ok: false, error: g.error || '读不到问卷' }
  const w = writeAnswers(name, { answers: g.answers || {}, voidedAt: '', voidReason: '' })
  return ('error' in w) ? { ok: false, error: w.error } : { ok: true }
}

/** 单题作废（答案曾经成立，现在失效） */
export function voidAnswer(deck: string, qid: string, reason: string): { ok: boolean; error?: string; revoked?: number } {
  const name = safeName(deck)
  const why = String(reason || '').trim()
  if (!why) return { ok: false, error: '作废要写原因' }
  const g = getDeck(name)
  if (!g.ok || !g.parsed) return { ok: false, error: g.error || '读不到问卷' }
  if (!g.parsed.questions.some((q) => q.id === qid)) return { ok: false, error: `没有这道题：${qid}` }
  const answers = { ...(g.answers || {}) }
  answers[qid] = { kind: 'void', text: why, at: new Date().toISOString() }
  const w = writeAnswers(name, { answers })
  if ('error' in w) return { ok: false, error: w.error }
  let revoked = 0
  const d = loadDecisions().find((x) => x.出处 === `问卷 ${name} · ${qid}`)
  if (d && d.状态 === '有效') {
    const r = setDecisionStatus(d.id, '已撤销', `单题作废：${why}`)
    if (!('error' in r)) revoked++
  }
  return { ok: true, revoked }
}

/** 事后校验：给某道已答的题下一个结论（成立 / 被推翻 + 一句证据） */
export function auditAnswer(deck: string, qid: string, verdict: string, evidence: string): {
  ok: boolean
  error?: string
  /** 被推翻时连带压掉的决策卡数 */
  revoked?: number
} {
  const name = safeName(deck)
  const v = verdict === 'refuted' ? 'refuted' : verdict === 'ok' ? 'ok' : ''
  if (!v) return { ok: false, error: '结论只能是 ok / refuted' }
  const g = getDeck(name)
  if (!g.ok || !g.parsed) return { ok: false, error: g.error || '读不到问卷' }
  const q = g.parsed.questions.find((x) => x.id === qid)
  if (!q) return { ok: false, error: `没有这道题：${qid}` }
  const a = (g.answers || {})[qid]
  if (!a || a.kind === 'skip' || a.kind === 'reject' || a.kind === 'askback' || a.kind === 'void') {
    return { ok: false, error: `${qid} 没有可校验的答案（跳过/否决/反问/作废都不算答案）` }
  }
  if (!String(q.line || '').trim()) {
    return { ok: false, error: `${qid} 没写验收线 —— 没有判据就没法校验（先让 agent 补验收线）` }
  }
  // 「被推翻」必须给证据：只说"不成立了"跟没说一样，下次还是没人知道该改什么
  if (v === 'refuted' && !String(evidence || '').trim()) {
    return { ok: false, error: '判「被推翻」要说清凭什么 —— 一句证据就行' }
  }
  const audits = { ...(g.audits || {}) }
  const at = new Date().toISOString()
  audits[qid] = { verdict: v as 'ok' | 'refuted', evidence: String(evidence || '').trim(), at }
  const w = writeAnswers(name, { answers: g.answers || {}, audits })
  if ('error' in w) return { ok: false, error: w.error }

  let revoked = 0
  const d = loadDecisions().find((x) => x.出处 === `问卷 ${name} · ${qid}`)
  if (d) {
    if (v === 'refuted' && d.状态 === '有效') {
      const r = setDecisionStatus(d.id, '已撤销', `事后校验被推翻（${at.slice(0, 10)}）：${String(evidence).trim()}`)
      if (!('error' in r)) revoked++
    } else if (v === 'ok' && d.状态 === '已撤销') {
      // 复验通过：把之前因"被推翻"压掉的恢复。只对"出处相同"的那张动手，不碰别的撤销。
      setDecisionStatus(d.id, '有效', `事后复验仍成立（${at.slice(0, 10)}）`)
    }
  }
  return { ok: true, revoked }
}

/** 校验期限：批准后多少天内该看一眼；已校验的多久后该复验 */
export const AUDIT_DUE_DAYS = 30
export const AUDIT_RECHECK_DAYS = 180

export interface QAuditRow {
  deck: string
  title: string
  id: string
  ask: string
  /** 当时选了什么（人话） */
  picked: string
  /** 验收线（判据） */
  line: string
  audit?: QAudit
  /** 距今多少天（按批准时间算；没批准按更新） */
  days: number
  /** 该看一眼了（未校验且超期 / 已校验但超复验期） */
  due: boolean
  /** 已判「被推翻」 */
  refuted: boolean
}

/**
 * 待校验清单（跨卷）。
 *
 * 判据：**只收"有答案 + 有验收线 + 卷已批准"** 的题 ——
 * 没有验收线的题没有判据，硬列出来只会让人点「成立」自欺；
 * 没批准的卷还没落决策，谈不上校验。
 */
export function auditQueue(nowMs?: number): { ok: true; rows: QAuditRow[]; dir: string } {
  const now = typeof nowMs === 'number' ? nowMs : Date.now()
  const dayMs = 86400000
  const rows: QAuditRow[] = []
  for (const name of listDeckNames()) {
    const g = getDeck(name)
    if (!g.ok || !g.parsed) continue
    if (!g.approvedAt) continue
    if (g.voidedAt) continue
    const answers = g.answers || {}
    const audits = g.audits || {}
    const baseMs = Date.parse(g.approvedAt) || Date.parse(g.updatedAt) || now
    g.parsed.questions.forEach((q) => {
      const a = answers[q.id]
      if (!a || a.kind === 'skip' || a.kind === 'reject' || a.kind === 'askback' || a.kind === 'void') return
      const line = String(q.line || '').trim()
      if (!line) return
      const au = audits[q.id]
      const refMs = au ? (Date.parse(au.at) || 0) : baseMs
      const days = refMs > 0 ? Math.max(0, Math.floor((now - refMs) / dayMs)) : 0
      const refuted = !!(au && au.verdict === 'refuted')
      const due = au
        ? (au.verdict === 'ok' && days >= AUDIT_RECHECK_DAYS)
        : days >= AUDIT_DUE_DAYS
      const picked = a.kind === 'amend'
        ? `（自述）${a.text || ''}`
        : `${a.k || ''}. ${(q.options.find((x) => x.k === a.k) || { t: '' }).t}`
      rows.push({
        deck: name, title: g.parsed.title || name, id: q.id, ask: q.ask || q.nav,
        picked, line, audit: au, days, due, refuted,
      })
    })
  }
  // 得先看：已经被推翻的（要处理）→ 该看一眼的 → 其余按时间倒序
  rows.sort((x, y) => {
    const rank = (r: QAuditRow) => (r.refuted ? 0 : r.due ? 1 : 2)
    if (rank(x) !== rank(y)) return rank(x) - rank(y)
    return y.days - x.days
  })
  return { ok: true, rows, dir: questionnaireDir() }
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
  /** 没写代价的选项数（>0 也能开「重出题」这一轮） */
  costGaps?: number
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
  const gaps = costGapsOf(g.parsed.questions)
  const openCount = g.parsed.questions.filter((q) => {
    const a = answers[q.id]
    return !a || a.kind === 'skip'
  }).length
  const base = { askbacks: asks.length, open: openCount, costGaps: gaps.length }

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

  // 重出题：反问和「没写代价的选项」都能开这一轮 ——
  // 两条都是"卷子本身不合格"，而不是"答的人没答完"。
  if (!asks.length && !gaps.length) {
    return { ...base, ok: false, error: '这卷既没有反问、也没有缺代价的选项 —— 没什么可重出的' }
  }
  const text = buildRewritePrompt(opts)
  if (!text) return { ...base, ok: false, error: '要重出的内容都是空的，没法打包' }
  return { ...base, ok: true, kind, text }
}

/** 已有决策卡条数（界面显示“落库后会有几条”用得上） */
export function decisionCount(): number {
  try { return loadDecisions().length } catch { return 0 }
}
