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
import { getTaskDir, loadTasks, parseRegistry, atomicWrite } from './index'
import { addDecision, loadDecisions, setDecisionStatus } from './decisions'
import { createTask } from './tasks'
import { parseQuestionnaire, costGaps, deckIssues, type QDeck, type QDeckIssue } from '../../shared/questionnaire'
import { askbacksOf, buildRewritePrompt, buildWorkOrderPrompt, costGapsOf } from '../../shared/qnPrompts'
import { collisionsFor, upsertEntries, bankStats, type BankStatus } from './questionBank'
// 本地日历日：见 shared/time.ts#localDay —— `toISOString().slice(0,10)` 是 UTC 日，
// 东八区凌晨落库会写成“昨天”。
import { localDay } from '../../shared/time'
// 「卡引用了哪一卷」的认法必须与进队列闸 / 派工单**同一个函数**（shared/clarify）——
// 三处各认一遍必然对不上（2026-11-11 问卷归档闸要用它判“有没有卡还在引用”）。
import { clarifyOf, splitClarify } from '../../shared/clarify'
// 出卷通道（2026-11-08）：agent 侧此前**没有任何出卷入口**，只能靠人抄格式给它。
// 这一层把“规格 → md”的转换收在一处，格式机检与生成共用同一份实现。
import {
  validateDeckSpec, buildDeckMarkdown, deckNameOf,
  type QnDeckSpec, type QnSpecIssue,
} from '../../shared/qnDeckSpec'

export interface QAnswer {
  /**
   * `void` = **这一项作废**（2026-11-07 补）。
   * 与「否决」不是一回事：否决 = 这题不该问（答案压根不存在）；
   * 作废 = 当时答得对、后来需求变了（答案曾经成立）。两者都不进导出，但语义差在"曾经成立过"。
   */
  kind: 'pick' | 'skip' | 'reject' | 'askback' | 'amend' | 'void' | 'self'
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

/**
 * 一条答案的**交付状态**（2026-11-11 卡 task-20261107-004：问卷→卡 的回程）。
 *
 * 由来：`deckToCards` 只通了去程（答案 → 卡）。卡做完 / 被驳回，问卷侧看不见结果，
 * 于是“这条拍板到底落实了没有”要靠人去翻卡。这里补回程：
 *   · `delivered` = 那张卡已完成（验收签字过了）；
 *   · `rejected`  = 那张卡被驳回（带理由）。
 * ⚠ **只加交付状态，绝不改答案本身**（答案是你当时的选择；改它 = 事后篡改拍板）。
 *   同一个 qid 留**数组**：每次状态变化追加，能回溯“先完成、后来又被打回”。
 */
export interface QDelivery {
  cardId: string
  status: 'delivered' | 'rejected'
  at: string
  /** 驳回理由（可为空 —— 用户可以不写理由就驳回） */
  reason?: string
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
  /**
   * 归档时间（2026-11-11 问卷管理）：已批准很久、又没有任何卡引用的卷移出列表。
   *
   * 与「作废」的区别：**归档只是不占列表，答案照旧参与裁决**（`gateForDeck` /
   * `effectiveAcceptances` 都不看这个字段）；作废是“答案不再作数”。两者不许混用。
   */
  archivedAt?: string
  archiveReason?: string
  /** 逐题的事后校验结论 */
  audits?: Record<string, QAudit>
  /** 逐题的交付状态（卡完成/驳回的回程；见 QDelivery 注释） */
  deliveries?: Record<string, QDelivery[]>
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
  /**
   * 归属项目（2026-11-10 补）。
   *
   * 为什么必须带出去：卷一多就分不清是哪条线的（用户原话“问卷越堆越多，后续管理问卷本身
   * 将成为一大难题”）。列表现在按「待答 / 已批准」分组，再加一层项目标记才好认。
   */
  project?: string
  /** 卷面里「没写代价」的选项数（>0 时界面要黄条点名） */
  costGaps?: number
  /** 本卷取代了哪一卷（卷面 `**取代**：<旧卷>`） */
  supersedes?: string
  /** 本卷被哪一卷取代（由别的卷的 supersedes 反推）—— 有值时列表里折叠并标「已被取代」 */
  replacedBy?: string
  /** 已归档（不占列表，仍参与裁决） */
  archived?: boolean
  /** 批准至今多少天（没批准为 0）—— 归档闸的判据 */
  ageDays?: number
  /** 批准时间（空 = 没批准）—— 搜索的日期区间按它筛 */
  approvedAt?: string
  /** 有多少张任务卡引用它（`[问卷:<卷>:<题>]` 标记或 `澄清: <卷>`）—— 有引用就不许归档 */
  refCount?: number
  /** 有多少题已经交付（对应卡已完成）—— 让“答过但没有一张卡落地”的卷能一眼看出来 */
  delivered?: number
  error?: string
}


export function questionnaireDir(): string {
  return path.join(getTaskDir(), 'questionnaires')
}

/**
 * 卷归属项目：先认卷面 `**项目**：`，再按卷名匹配 registry。
 *
 * 为什么必须有（2026-11-09 真事）：`approveDeck` 建决策卡时没传 `项目`，
 * 问卷答案落成的决策卡全是“全局”——`contextPack` 会把司天的规矩发给方寸。
 * 同一套认法原先埋在 `deckToCards` 里，现在抽出来两处共用。
 */
export function projectForDeck(deckName: string, parsed?: QDeck): string {
  const explicit = String(parsed?.project || '').trim()
  if (explicit) return explicit
  const name = String(deckName || '')
  const registry = parseRegistry().map((p: any) => ({
    id: String(p?.id || ''),
    name: String(p?.name || p?.id || ''),
  })).filter((p: { id: string }) => !!p.id)
  const scored = registry.map((p: { id: string; name: string }) => {
    const byName = p.name && p.name.length >= 2 && name.includes(p.name) ? p.name.length : 0
    const byId = name.includes(p.id) ? p.id.length : 0
    return { id: p.id, score: Math.max(byName, byId) }
  }).filter((x: { score: number }) => x.score > 0).sort((a: { score: number }, b: { score: number }) => b.score - a.score)
  return scored.length ? scored[0].id : ''
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
      archivedAt: String(o?.archivedAt || ''),
      archiveReason: String(o?.archiveReason || ''),
      audits: o && typeof o.audits === 'object' && o.audits ? o.audits : {},
      deliveries: o && typeof o.deliveries === 'object' && o.deliveries ? o.deliveries : {},
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
  archivedAt?: string
  archiveReason?: string
  audits?: Record<string, QAudit>
  /** 交付状态：undefined = 不动（与 audits 同一条“没传 ≠ 清空”的纪律） */
  deliveries?: Record<string, QDelivery[]>
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
    archivedAt: input.archivedAt !== undefined ? String(input.archivedAt) : (cur.archivedAt || ''),
    archiveReason: input.archiveReason !== undefined ? String(input.archiveReason) : (cur.archiveReason || ''),
    audits: input.audits !== undefined ? input.audits : (cur.audits || {}),
    deliveries: input.deliveries !== undefined ? input.deliveries : (cur.deliveries || {}),
  }
  const p = path.join(dir, name + '.answers.json')
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
  fs.renameSync(tmp, p)
  return { ok: true }
}

/**
 * 有多少张任务卡引用某卷（2026-11-11 问卷管理）。
 *
 * 两个结构化标记都算引用：`澄清: <卷>`（进队列锁的字段）与问卷落卡正文里的
 * `[问卷:<卷>:<题>]`（`clarifyOf` 两种都认）。**不用“正文里出现卷名”**那种模糊匹配 ——
 * 卷名常常是项目名 + 层，模糊匹配会把隔壁项目的一堆卡都算成引用，归档闸就永远不动。
 */
function deckRefCounts(): Map<string, number> {
  const out = new Map<string, number>()
  let list: any[] = []
  try { list = loadTasks('all') } catch { return out }
  for (const t of list) {
    const decks = new Set<string>()
    const raw = clarifyOf({ fm: t?.fm, body: t?.body })
    if (raw) {
      // `卷#题号` 也只是“这一卷被引用了” —— 引用计数按卷归账，不按题
      const deck = splitClarify(raw).deck
      if (deck) decks.add(deck)
    }
    // ⚠ 还有第三种引用：问卷落卡正文里的 `[问卷:<卷>:<题号>]` 标记。
    //   `clarifyOf` 只认「澄清」的三种写法（那是**闸**的语义），老卡/手写卡可能只有标记 ——
    //   2026-11-11 评审实测：只认 clarifyOf 时这种卡的 refCount=0，卷会被误判成“没引用”而收起来。
    const body = String(t?.body || '')
    const re = /\[问卷:([^\]\n]+?):[^\]\n]+\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      const deck = String(m[1] || '').trim()
      if (deck) decks.add(deck)
    }
    for (const deck of decks) out.set(deck, (out.get(deck) || 0) + 1)
  }
  return out
}

/** 汇总：有哪些卷、各几题、答了几道、批准没（外加题库总进度，见 2026-11-10 规模支撑） */
export function listDecks(): { ok: true; decks: QDeckBrief[]; dir: string; bank: ReturnType<typeof bankStats> } {
  const names = listDeckNames()
  const raw = names.map((name) => {
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
      name,
      approvedAt: a.approvedAt || '',
      archivedAt: a.archivedAt || '',
      supersedes: String(d.supersedes || '').trim(),
      brief: {
        deck: name,
        title: d.title || name,
        layer: d.layer,
        total: d.questions.length,
        answered,
        approved: !!a.approvedAt,
        voided: !!a.voidedAt,
        project: projectForDeck(name, d),
        costGaps: costGaps(d).length,
        // 已交付题数（卡完成的回程）：让“答过但一张卡都没落地”的卷一眼看出来
        delivered: Object.keys(a.deliveries || {}).filter((qid) => {
          const list = (a.deliveries || {})[qid]
          return Array.isArray(list) && list.length > 0 && list[list.length - 1].status === 'delivered'
        }).length,
        error: d.error,
      } as QDeckBrief,
    }
  })
  // 「被取代」是反推出来的：别的卷写了 `**取代**：<本卷>` → 本卷标已被取代
  const replacedBy = new Map<string, string>()
  for (const x of raw) {
    if (!x.supersedes) continue
    if (x.supersedes === x.name) continue          // 自己取代自己：坏数据，不当真
    if (!names.includes(x.supersedes)) continue    // 指向不存在的卷：不凭空造一条关系
    replacedBy.set(x.supersedes, x.name)
  }
  const refs = deckRefCounts()
  const now = Date.now()
  const decks = raw.map((x) => {
    const ap = Date.parse(x.approvedAt)
    return {
      ...x.brief,
      supersedes: x.supersedes,
      replacedBy: replacedBy.get(x.name) || '',
      archived: !!x.archivedAt,
      approvedAt: x.approvedAt,
      ageDays: Number.isFinite(ap) ? Math.max(0, Math.floor((now - ap) / 86400_000)) : 0,
      refCount: refs.get(x.name) || 0,
    }
  })
  return { ok: true, decks, dir: questionnaireDir(), bank: bankStats('') }
}

/**
 * 问卷搜索（2026-11-11）：按卷名 / 标题 / 项目 / 题面 / 选项文字搜，可带项目与日期区间。
 *
 * 为什么必须走结构化字段而不是“正文 includes”：题面与卷名常常含同一个词
 * （“备份”既是卷名也是题面），只按卷名搜会漏掉真正相关的卷。
 * 返回 `hits` 让界面说清“这卷哪一段命中了”，而不是丢一个不可解释的结果列表。
 */
export function searchDecks(query: string, opts?: { project?: string; from?: string; to?: string }): {
  ok: true
  decks: QDeckBrief[]
  hits: Record<string, string[]>
  scanned: number
} {
  const q = String(query || '').trim().toLowerCase()
  const wantProject = String((opts && opts.project) || '').trim()
  const from = Date.parse(String((opts && opts.from) || ''))
  const to = Date.parse(String((opts && opts.to) || ''))
  const all = listDecks().decks
  const hits: Record<string, string[]> = {}
  const out: QDeckBrief[] = []
  for (const d of all) {
    if (wantProject && String(d.project || '') !== wantProject) continue
    const ap = Date.parse(String(d.approvedAt || ''))
    if (Number.isFinite(from) && (!Number.isFinite(ap) || ap < from)) continue
    // 日期区间包含“那一天”：to 按当天 23:59:59.999 算，否则用户选 11-10 当天会被排除
    if (Number.isFinite(to) && (!Number.isFinite(ap) || ap > to + 86400_000 - 1)) continue
    const where: string[] = []
    const parsed = parseQuestionnaire(readDeckText(d.deck))
    if (!q) { out.push(d); continue }
    if (String(d.deck).toLowerCase().includes(q)) where.push('卷名')
    if (String(d.title || '').toLowerCase().includes(q)) where.push('标题')
    if (String(d.project || '').toLowerCase().includes(q)) where.push('项目')
    const qhits: string[] = []
    for (const item of parsed.questions) {
      const hay = [
        item.id, item.nav, item.ask, item.line,
        ...(item.options || []).map((o) => `${o.k} ${o.t}`),
      ].join(' ').toLowerCase()
      if (hay.includes(q)) qhits.push(item.id)
    }
    if (qhits.length) where.push('题面 ' + qhits.slice(0, 6).join('、'))
    if (!where.length) continue
    hits[d.deck] = where
    out.push(d)
  }
  return { ok: true, decks: out, hits, scanned: all.length }
}

/**
 * 归档闸（2026-11-11）：已批准 ≥ N 天 **且没有任何卡引用** 的卷才算“历史卷”。
 *
 * 为什么两个条件都要：只按时间，一个还在被施工卡引用的卷会从列表里消失，
 * 而它正是“这活当初为什么这么定”的唯一依据；只按引用，几十卷里没引用的永远堆着。
 * 归档 = **只是不占列表**，答案照旧参与裁决（见 QAnswersFile.archivedAt 注释）。
 */
export function archivableDecks(days = 30): {
  ok: true
  days: number
  decks: QDeckBrief[]
  blocked: { deck: string; why: string }[]
} {
  const n = Number(days) > 0 ? Math.floor(Number(days)) : 30
  const all = listDecks().decks
  const decks: QDeckBrief[] = []
  const blocked: { deck: string; why: string }[] = []
  for (const d of all) {
    if (!d.approved || d.voided || d.archived) continue
    if ((d.ageDays || 0) < n) continue
    if ((d.refCount || 0) > 0) { blocked.push({ deck: d.deck, why: `还有 ${d.refCount} 张卡引用它，不许藏起来` }); continue }
    if (d.replacedBy) { blocked.push({ deck: d.deck, why: `已被《${d.replacedBy}》取代（应折叠，不是归档）` }); continue }
    decks.push(d)
  }
  return { ok: true, days: n, decks, blocked }
}

/** 归档闸的默认天数（已批准满这么多天且无引用才够格收起） */
export const DECK_ARCHIVE_DAYS = 30

/**
 * 归档一卷（只是不占列表；答案仍参与裁决）。
 *
 * 硬闸（2026-11-11 评审补的两条，缺一条这个闸就是装饰）：
 *   ① 必须已批准、没作废；
 *   ② **必须已批准满 `days` 天**（判定在数据层，不只靠列表把按钮藏起来 ——
 *      详情页那个按钮直连本函数，不查天数时“刚批准就能归档”实测成立过）；
 *   ③ 没有任何卡引用它。
 */
export function archiveDeck(deck: string, reason = '', days = DECK_ARCHIVE_DAYS): { ok: boolean; error?: string; deck?: string } {
  const name = safeName(deck)
  if (!name) return { ok: false, error: '卷名为空' }
  const g = getDeck(name)
  if (!g.ok) return { ok: false, error: g.error || `找不到问卷：${name}` }
  if (!g.approvedAt) return { ok: false, error: '这卷还没批准 —— 没发生的事不能归档（先答完并批准，或直接作废）' }
  if (g.voidedAt) return { ok: false, error: '这卷已作废 —— 作废本身就是处置，不需要再归档' }
  const need = Number(days) > 0 ? Math.floor(Number(days)) : DECK_ARCHIVE_DAYS
  const ageMs = Date.now() - Date.parse(String(g.approvedAt))
  const ageDays = Number.isFinite(ageMs) ? Math.floor(ageMs / 86400_000) : 0
  if (ageDays < need) {
    return {
      ok: false,
      error: `这卷才批准 ${ageDays} 天 —— 归档闸要求满 ${need} 天且没有卡引用（时间没到就藏起来 = 正在用的依据被藏了）`,
    }
  }
  const refs = deckRefCounts().get(name) || 0
  if (refs > 0) return { ok: false, error: `还有 ${refs} 张任务卡引用《${name}》—— 归档会让“当初为什么这么定”从列表里消失，先处理那些卡` }
  const r = writeAnswers(name, {
    answers: g.answers || {},
    archivedAt: new Date().toISOString(),
    archiveReason: String(reason || '').trim() || `已批准 ${ageDays} 天且无卡引用，移入历史卷`,
  })
  return r.ok ? { ok: true, deck: name } : { ok: false, error: (r as any).error as string }
}

/** 取消归档（把卷放回列表）。 */
export function unarchiveDeck(deck: string): { ok: boolean; error?: string; deck?: string } {
  const name = safeName(deck)
  if (!name) return { ok: false, error: '卷名为空' }
  const g = getDeck(name)
  if (!g.ok) return { ok: false, error: g.error || `找不到问卷：${name}` }
  const r = writeAnswers(name, { answers: g.answers || {}, archivedAt: '', archiveReason: '' })
  return r.ok ? { ok: true, deck: name } : { ok: false, error: (r as any).error as string }
}

export interface CreateDeckResult {
  ok: boolean
  error?: string
  issues?: QnSpecIssue[]
  deck?: string
  path?: string
  questions?: number
}

/**
 * 出卷（agent 经 MCP 调用；2026-11-08）。
 *
 * 硬边界（照契约 ② 的精神落）：
 *   · **机检不过就一个字节都不写** —— 这不是“产出”，是一份要人答的文件，
 *     半成品落盘只会让人对着缺代价的选项瞎选；
 *   · **不覆盖同名卷** —— 已经答过/正在答的家伙不能被一次 agent 调用抹掉；
 *     真要换版，让 agent 换个 deck 名（`xxx-v2`）。
 * 写盘后**读回解析**，题数对不上即报错（防止格式变换把题丢掉）。
 */
export function createDeck(input: {
  spec: QnDeckSpec
  agent?: string
  overwrite?: boolean
}): CreateDeckResult {
  const spec = input?.spec
  if (!spec) return { ok: false, error: '没有出卷规格（spec）' }
  const issues = validateDeckSpec(spec)
  if (issues.length) {
    return {
      ok: false,
      issues,
      error: '出卷规格不合格（一条都没落盘）：'
        + issues.map((i) => `${i.id ? i.id + ' ' : ''}${i.msg}`).join('；'),
    }
  }
  // 题库查重（D-060）：已答 / 否决 / 你自判 的题不许再问 —— 同一道题被问第二次 = bug。
  // 待答 / 作废 允许：待答是队列（这卷就是去问它的），作废是需求变过、可以重问。
  const collisions = collisionsFor(spec.questions)
  if (collisions.length) {
    return {
      ok: false,
      error: '题库里已经有这些题的答案，不许再问：'
        + collisions.map((c) => `${c.id} ${c.ask}（${c.entry.status}：${c.entry.answer || c.entry.source || '见题库'}）`).join('；'),
    }
  }
  const name = deckNameOf(spec)
  const dir = questionnaireDir()
  const p = path.join(dir, name + '.md')
  if (fs.existsSync(p) && !input.overwrite) {
    return { ok: false, error: `同名问卷已存在：${name}.md —— 换一个 deck 名（如 ${name}-v2），别覆盖已经答过的卷` }
  }
  fs.mkdirSync(dir, { recursive: true })
  atomicWrite(p, buildDeckMarkdown(spec))
  const back = parseQuestionnaire(fs.readFileSync(p, 'utf-8'))
  const want = (spec.questions || []).length
  if (back.error || back.questions.length !== want) {
    return {
      ok: false, deck: name, path: p,
      error: `写回了但读不回来（${back.error || `题数 ${back.questions.length} ≠ ${want}`}）—— 文件在 ${p}，别当它已经可用`,
    }
  }
  return { ok: true, deck: name, path: p, questions: back.questions.length }
}

/** 每题的交付历史最多留几条（够回溯“完成→打回→再完成”就够了，不无限涨） */
export const DELIVERY_HISTORY_MAX = 20

/**
 * 记一次交付（2026-11-11 · 卡 task-20261107-004 的回程）。
 *
 * 调用方只有**任务卡状态真的变了**的地方（`tasks.moveStatus` / `updateTask`），
 * 且卡上必须带 `[问卷:<卷>:<题号>]` 标记或 `<卷>#<题号>` 澄清 —— 没有标记的卡
 * 不产生任何记录（不许“看起来相关就关联”）。
 * 只写 `deliveries`，**答案一个字都不动**。
 */
export function recordCardDelivery(input: {
  deck: string
  qid: string
  cardId: string
  status: 'delivered' | 'rejected'
  reason?: string
  at?: string
  /** true = 同一张卡同状态时**更新最后一条**（驳回理由常常在状态改完之后才写进去） */
  merge?: boolean
}): { ok: boolean; added?: boolean; error?: string } {
  const name = safeName(input && input.deck)
  const qid = String((input && input.qid) || '').trim()
  const cardId = String((input && input.cardId) || '').trim()
  if (!name || !qid || !cardId) return { ok: false, error: '记录交付需要 卷 / 题号 / 卡 id 三样' }
  const g = getDeck(name)
  if (!g.ok || !g.parsed) return { ok: false, error: g.error || `读不到问卷：${name}` }
  if (!(g.answers || {})[qid]) {
    // 反例②：没有答案的题不许凭空产生交付记录（那等于伪造“这题定过”）
    return { ok: false, error: `卷《${name}》没有 ${qid} 的答案 —— 不建凭空的交付记录` }
  }
  const all: Record<string, QDelivery[]> = { ...(g.deliveries || {}) }
  const list = Array.isArray(all[qid]) ? [...all[qid]] : []
  const at = String((input && input.at) || new Date().toISOString())
  const reason = String((input && input.reason) || '').trim()
  const last = list[list.length - 1]
  if (input && input.merge && last && last.cardId === cardId && last.status === input.status) {
    if ((last.reason || '') === reason) return { ok: true, added: false }
    list[list.length - 1] = { ...last, reason, at }
  } else {
    // 幂等：同一卡 + 同状态 + 同理由重复写，不再追加（验收按钮连点不该把历史撑爆）
    if (last && last.cardId === cardId && last.status === input.status && (last.reason || '') === reason) {
      return { ok: true, added: false }
    }
    list.push({ cardId, status: input.status, at, ...(reason ? { reason } : {}) })
  }
  all[qid] = list.slice(-DELIVERY_HISTORY_MAX)
  const w = writeAnswers(name, { answers: g.answers || {}, deliveries: all })
  return w.ok ? { ok: true, added: true } : { ok: false, error: (w as any).error as string }
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
  /** 归档时间（空 = 在列表里；有值 = 历史卷，答案仍参与裁决） */
  archivedAt?: string
  audits?: Record<string, QAudit>
  /** 逐题交付状态（卡完成/驳回的回程） */
  deliveries?: Record<string, QDelivery[]>
  /** 卷面里没写代价的选项（界面黄条点名用） */
  costGaps?: { id: string; k: string; t: string }[]
  /** 卷面体检（缺代价 / 缺验收线 / 超批）—— 只报告不改卷 */
  issues?: QDeckIssue[]
  /** 可选项目（registry 里的 id + 名字）—— 落卡时界面先给候选，别让用户点一次失败才知道要选 */
  projects?: { id: string; name: string }[]
  /** 本题库进度（2026-11-10）：卷所属项目的已答 / 待答 / 黑名单计数 */
  bank?: ReturnType<typeof bankStats>
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
    archivedAt: a.archivedAt || '',
    audits: a.audits || {}, costGaps: costGaps(parsed), issues: deckIssues(parsed),
    deliveries: a.deliveries || {},
    // 项目候选一次性带出去：界面先渲染下拉（默认"自动按卷名认"），
    // 免得用户点一次「落成任务卡」先吃一个 needProject 错误才知道要选
    projects: parseRegistry().map((x: any) => ({ id: String(x?.id || ''), name: String(x?.name || x?.id || '') }))
      .filter((x: { id: string }) => !!x.id),
    // 本项目题库进度（2026-11-10）：几百条题时，界面必须看得见“答了多少、还剩多少”，
    // 不然每打开一卷都像从头开始。
    bank: bankStats(projectForDeck(name, parsed)),
    path: p,
  }
}

/** 一条答案 → decision-log 里的一行（空行 / 跳过 / 否决 / 反问 / 作废都不落决策） */
export function answerToLogLine(q: { id: string; ask: string; options: { k: string; t: string }[] }, a: QAnswer | undefined, date: string): string {
  if (!a) return ''
  if (a.kind === 'skip' || a.kind === 'reject') return ''
  if (a.kind === 'askback') return ''
  if (a.kind === 'void') return ''
  if (a.kind === 'self') return ''   // 你自判：不是决定，进题库黑名单、永不再问
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
  const day = date || localDay()
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
    if (a.kind === 'self') {
      // 你自判 = 这题以后不用再问方寸；它不是决定，也不带验收线。
      lines.push(`- **${q.id}** —— 你自判：${a.text ? a.text : '（以后不再问这题）'}`)
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
  const day = localDay()

  // 2026-11-09 真事：五道题“全答完了”，落盘却是空卷 —— 批准照样写 approvedAt，
  // 界面显示“已落库”，决策卡一张没有。**一道都没答**的空卷不许批准；
  // 全是否决/你自判是可以批的（那本身就是一种处置，题库会记下来）。
  const answeredAny = parsed.questions.some((q) => !!answers[q.id])
  if (!answeredAny) {
    return {
      ok: false,
      error: '一道都没答 —— 空卷不许批准，否则只会写出一条“已落库”的假记录',
    }
  }

  let cards = 0
  let existed = 0
  let revived = 0
  let revoked = 0
  const errors: string[] = []
  // 2026-11-09：决策卡必须带归属。此前漏传 → 问卷答案全落成“全局决策”，
  // contextPack 会把 A 项目的规矩发给 B 项目（已实测：D-059..D-063 就是全局）。
  const project = projectForDeck(name, parsed)
  parsed.questions.forEach((q) => {
    const a = answers[q.id]
    if (!a) return
    if (a.kind === 'void') return      // 单题作废：不进决策
    if (a.kind === 'self') return      // 你自判：不是决定，进题库黑名单
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
      项目: project,
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

  // 题库回写（D-060）：批准这一刻把每题状态记进 question-bank.md。
  // 为什么在这里而不是 writeAnswers：草稿每动一下都写，会把“已答”提前写死；
  // 只有批准（用户点头）才算定案。
  const bankRows = parsed.questions.map((q) => {
    const a = answers[q.id]
    const status: BankStatus = !a ? '待答'
      : (a.kind === 'pick' || a.kind === 'amend') ? '已答'
        : a.kind === 'reject' ? '否决'
          : a.kind === 'void' ? '作废'
            : a.kind === 'self' ? '你自判'
              : a.kind === 'askback' ? '否决'   // 反问 = 这题问错了，旧题干不再出现
                : '待答'
    let ans = ''
    if (a?.kind === 'pick') {
      const o = q.options.find((x) => x.k === a.k)
      ans = `${a.k} ${o ? o.t : ''}`.trim()
    } else if (a?.kind === 'amend') ans = String(a.text || '')
    else if (a?.kind === 'askback') ans = `反问：${String(a.text || '')}`
    else if (a?.kind === 'void') ans = `作废：${String(a.text || '')}`
    else if (a?.kind === 'self') ans = `你自判：${String(a.text || '（不再问）')}`
    return {
      ask: String(q.ask || q.nav || q.id),
      project,
      status,
      answer: ans,
      source: `问卷 ${name} · ${q.id}`,
      firstAsked: day,
      // 验收线跟着进题库：卷删了/归档了，这条线也不会跟着消失。
      line: String(q.line || '').trim().replace(/\s*\n\s*/g, ' '),
      // 从题库提请的题会写 `【出处】题库 Q-0010`；问法变了、指纹对不上，
      // 但这条 id 指回同一条 —— 批准时归并，否则题库永远清零不了（闸会一直挡）。
      ref: ((/题库\s*[:：]?\s*(Q-\d+)/.exec(String(q.src || '')) || [])[1]) || '',
    }
  })
  upsertEntries(bankRows)

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
  /** 这条答案对应的卡（回程）：卡片完成/驳回后才有；没有卡就是 null（不是空串） */
  card?: { id: string; status: 'delivered' | 'rejected'; at: string } | null
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
      const dl = (g.deliveries || {})[q.id]
      const lastDl = Array.isArray(dl) && dl.length ? dl[dl.length - 1] : null
      rows.push({
        deck: name, title: g.parsed.title || name, id: q.id, ask: q.ask || q.nav,
        picked, line, audit: au, days, due, refuted,
        card: lastDl ? { id: lastDl.cardId, status: lastDl.status, at: lastDl.at } : null,
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

/** 落卡时写在正文里的幂等标记 —— 同一卷同一题只会建一张（改一次卷不会长出十张重复卡） */
export function cardMarker(deck: string, qid: string): string {
  return `[问卷:${deck}:${qid}]`
}

/**
 * 已落档的验收线（2026-11-09 · S3 直连）。
 *
 * 口径：**已批准 + 未作废 + 无反问**的卷里，凡打过勾/改一句、且写了【验收线】的题。
 * 这是派生视图，不落表 —— 卷作废/答案被推翻后自动消失，不会留下过期规矩。
 * 拿去喂规划 / 阶段卡 / 派工单，保证“你答过的线”真的出现在后面的施工里。
 */
export interface RulingRef {
  deck: string
  qid: string
  ask: string
  picked: string
  line: string
  project: string
}

export function effectiveAcceptances(project?: string): RulingRef[] {
  const want = String(project || '').trim()
  const out: RulingRef[] = []
  for (const name of listDeckNames()) {
    const g = getDeck(name)
    if (!g.ok || !g.parsed || !g.approvedAt || g.voidedAt) continue
    const p = projectForDeck(name, g.parsed)
    if (want && p && p !== want) continue
    if (askbacksOf(g.parsed.questions, g.answers || {}).length) continue
    for (const q of g.parsed.questions) {
      const a = (g.answers || {})[q.id]
      if (!a || (a.kind !== 'pick' && a.kind !== 'amend')) continue
      const line = String(q.line || '').trim().replace(/\s*\n\s*/g, ' ')
      if (!line) continue
      const picked = a.kind === 'amend'
        ? String(a.text || '').trim()
        : `${a.k || ''}. ${(q.options.find((x) => x.k === a.k) || { t: '' }).t}`.trim()
      out.push({ deck: name, qid: q.id, ask: String(q.ask || q.nav || ''), picked, line, project: p })
    }
  }
  return out
}

/**
 * 答卷 → **真任务卡**（2026-11-07）。
 *
 * 为什么必须做这一步（两份同类调研的共同结论，也是暮雨说"问卷还是半成品"的实处）：
 *   在此之前，"出单"只产出**一段提示词**（`buildWorkOrderPrompt`）—— 谁去把它变成卡？
 *   没人。于是一条链断在最后一步：答案躺在 decision-log 里，施工方要看还得有人手工搬。
 *   Spec Kit 的做法是 spec.md → plan.md → tasks.md **纯文件链**；方寸本来就是 md 卡，
 *   所以这里直接落 `task-data/*.md`，零新格式、零新依赖。
 *
 * 三条护栏（顺序不能反 —— 先判能不能建，再建）：
 *   ① **没批准不许落卡**（草稿进施工 = 把没定的事当定了做）；
 *   ② 卷已作废 / 还有反问 → 拒（问题还没定，落下去的卡必然是错的）；
 *   ③ 项目归不了 → 不瞎猜，把项目清单回给界面让它选。
 *
 * 幂等：正文末尾带 `[问卷:<卷>:<题号>]`，已有同样标记的卡跳过（返回 skipped）。
 * 搬运纪律：题干 / 选择 / 验收线 / 出处 **原文全带**，不做"摘要式搬运"。
 */
export function deckToCards(deck: string, opts?: { project?: string; priority?: string }): {
  ok: boolean
  error?: string
  /** 需要用户先选项目（界面据此渲染下拉，而不是让卡落到"未归属"） */
  needProject?: boolean
  projects?: { id: string; name: string }[]
  project?: string
  created?: number
  skipped?: number
  cards?: { qid: string; id: string }[]
  /** 没落卡的题及原因（跳过 / 否决 / 反问 / 作废 / 未答 —— 不许静默漏） */
  omitted?: { qid: string; why: string }[]
} {
  const name = safeName(deck)
  const g = getDeck(name)
  if (!g.ok || !g.parsed || !g.answers) return { ok: false, error: g.error || '读不到问卷' }
  const parsed = g.parsed
  const answers = g.answers

  if (!g.approvedAt) {
    return { ok: false, error: '这卷还没批准 —— 草稿不能进施工。先点「批准并落库」' }
  }
  if (g.voidedAt) {
    return { ok: false, error: `这卷已作废（${String(g.voidedAt).slice(0, 10)}）—— 作废的答案不落卡` }
  }
  const asks = askbacksOf(parsed.questions, answers)
  if (asks.length) {
    return { ok: false, error: `还有 ${asks.length} 道题被反问 —— 问题没定，这时候落的卡必然是错的。先「重出题」` }
  }

  // 项目：显式传入优先（必须真在 registry 里）；否则按卷名前缀匹配 id 或名字
  const registry = parseRegistry().map((p: any) => ({
    id: String(p?.id || ''),
    name: String(p?.name || p?.id || ''),
  })).filter((p: { id: string }) => !!p.id)
  let project = String((opts && opts.project) || '').trim()
  if (project) {
    if (!registry.some((p) => p.id === project)) {
      return { ok: false, error: `registry 里没有项目「${project}」—— 卡必须有归属，不许落在不存在的项目上` }
    }
  } else {
    // 认法与 approveDeck 共用（先认卷面 `**项目**：`，再按卷名最长命中）。
    // 不用 `name.split('-')[0]` —— 样本文件名是 `问卷-司天-宪法层-20261104`，前缀是"问卷"。
    project = projectForDeck(name, parsed)
  }
  if (!project) {
    return {
      ok: false, needProject: true, projects: registry,
      error: '认不出这卷属于哪个项目（卷名和 registry 里的项目名对不上）—— 选一个再落卡',
    }
  }

  const existing = loadTasks('all')
  const seen = new Set<string>()
  for (const t of existing) {
    const m = /\[问卷:([^\]]+?):([^\]]+?)\]/.exec(String(t.body || ''))
    if (!m) continue
    seen.add(cardMarker(m[1], m[2]))
  }

  const day = String(g.approvedAt).slice(0, 10)
  const cards: { qid: string; id: string }[] = []
  const omitted: { qid: string; why: string }[] = []
  let skipped = 0

  for (const q of parsed.questions) {
    const a = answers[q.id]
    if (!a) { omitted.push({ qid: q.id, why: '未答' }); continue }
    if (a.kind === 'skip') { omitted.push({ qid: q.id, why: '跳过（下次再问）' }); continue }
    if (a.kind === 'reject') { omitted.push({ qid: q.id, why: '否决（这题不该问）' }); continue }
    if (a.kind === 'askback') { omitted.push({ qid: q.id, why: '反问（回给 agent 重出题）' }); continue }
    if (a.kind === 'void') { omitted.push({ qid: q.id, why: '作废（不作数）' }); continue }
    if (a.kind === 'self') { omitted.push({ qid: q.id, why: '你自判（不再问）' }); continue }

    const marker = cardMarker(name, q.id)
    if (seen.has(marker)) { skipped++; continue }

    const picked = a.kind === 'amend'
      ? `自述：${String(a.text || '').trim()}`
      : `${a.k || ''}. ${(q.options.find((x) => x.k === a.k) || { t: '' }).t}`
    const line = String(q.line || '').trim().replace(/\s*\n\s*/g, ' ')
    const ask = String(q.ask || '').trim()
    const body = [
      '## 来源',
      `问卷《${parsed.title || name}》第 ${q.id} 题（${day} 批准）`,
      `问卷文件：\`task-data/questionnaires/${name}.md\``,
      '',
      '## 定下来的',
      picked,
      '',
      '## 为什么问',
      ask || `（题干只写了导航名：${q.nav || q.id}）`,
      '',
      '## 验收线（问卷原文）',
      line || '未给 —— **开工前先补一句“做完什么样”**（问卷里没写，等于这张卡没有终点）',
      '',
      '## 澄清问卷',
      // 题目级澄清（2026-11-11）：`<卷>#<题号>`。这张卡押的是**这一题的答案**，不是整卷 ——
      // 按整卷判会把“已答的这题”锁死（其余题还挂着），按不判又是没闸。
      `${name}#${q.id}（已批准）`,
      '',
      '## 期望产物',
      '（问卷没写 —— 补一句“交付什么算做完”。同族抄点：CrewAI 的 `expected_output`、Kiro 的 EARS 句式',
      '“当 X 时，系统应 Y”，两者都是为了让“做完”可判定）',
      '',
      marker,
    ].join('\n')

    // 标题：卡的 id 由标题生成，所以只取一句、限长；全文在正文里一位不丢
    const head = (q.nav || ask || q.id).replace(/\s+/g, ' ').trim().slice(0, 48)
    const title = `[问卷] ${q.id} ${head}`
    try {
      const t = createTask({
        title,
        project,
        priority: String((opts && opts.priority) || '中'),
        status: '待办' as any,
        tags: ['问卷', name],
        body,
      })
      cards.push({ qid: q.id, id: t.id })
      seen.add(marker)
    } catch (e: any) {
      return { ok: false, error: `${q.id} 建卡失败：${e?.message || e}（已建 ${cards.length} 张，别重复点）` }
    }
  }

  if (!cards.length && !skipped) {
    return { ok: false, error: '这卷没有可落卡的答案（打勾 / 改一句才算）' }
  }
  return { ok: true, project, created: cards.length, skipped, cards, omitted }
}

