/**
 * 问卷 IPC（2026-11-05）
 *
 * 六个口，一一对应弹窗要做的几件事：
 *   list         项目/顶栏显示“N 卷待答”
 *   get          打开某一卷（题 + 已有草稿）
 *   saveAnswers  存草稿（每点一下就存，关掉不丢）
 *   approve      批准落库（建决策卡 + 导出 decision-log 段落）
 *   prompt       两份出口提示词（反问→重出题 / 答卷→出施工单）
 *   openDir      打开问卷目录（把 md 放进去就能被认出来）
 *
 * ⚠ 没有 `questionnaire:create` —— 问卷是 agent 写的，方寸不做出题器
 *   （暮雨原话：“我现在的问卷全都是 agent 写的”）。方寸只做呈现 + 收答案 + 落库。
 */
import { shell } from 'electron'
import { guardedHandle } from './guarded-ipc'
import {
  listDecks, getDeck, writeAnswers, approveDeck, questionnaireDir, buildPromptForDeck,
  voidDeck, reopenDeck, voidAnswer, auditAnswer, auditQueue, deckToCards,
  effectiveAcceptances, searchDecks, archivableDecks, archiveDeck, unarchiveDeck,
  projectForDeck, convergenceStatus, listDeckNames, batchDeckAction,
  type QAnswer,
} from './data/questionnaires'
import { gateForDeck, gateForQuestion } from './data/qnGate'
import { splitClarify } from '../shared/clarify'
import { clarifyOf } from '../shared/clarify'
import { loadBank, bankOf, bankRelations, type DeckProbe } from './data/questionBank'
import { loadTasks } from './data'
import * as notifier from './services/notifier'

/**
 * 把「每一卷里的每一题」压成探针（P11 题库↔卷关系视图的数据源）。
 *
 * 为什么不把这段放进 questionBank.ts：那会让 题库 ⇄ 卷 两个模块互相 import 成环。
 * 关系计算是纯函数（`bankRelations`），读盘拼装留在这个 IPC 层 —— 界面上只拿结果。
 */
function collectDeckProbes(): DeckProbe[] {
  const out: DeckProbe[] = []
  for (const name of listDeckNames()) {
    const g = getDeck(name)
    if (!g.ok || !g.parsed) continue
    const answers = g.answers || {}
    const deliv = g.deliveries || {}
    out.push({
      deck: name,
      project: projectForDeck(name, g.parsed),
      status: g.voidedAt ? '已作废' : g.archivedAt ? '已归档' : g.approvedAt ? '已批准' : '草稿',
      questions: (g.parsed.questions || []).map((q: any) => ({
        qid: String(q.id || ''),
        ask: String(q.ask || ''),
        answered: !!answers[String(q.id || '')],
        deliveries: (deliv[String(q.id || '')] || []).map((d: any) => ({
          cardId: String(d.cardId || ''),
          date: String(d.at || ''),
          passed: d.status === 'delivered',
        })),
      })),
    })
  }
  return out
}


export function registerQuestionnaireIpcHandlers(): void {
  /**
   * 答完最后一题 / 批准 / 作废后，立刻让通知收敛（2026-11-21 暮雨：
   * “问卷答完了通知里还写着待答，又多点一次”）。
   *
   * 此前只能等 60s 扫描；而扫描里 `questionnaire-pending` 的口径是“未批准就算待答”，
   * 所以答完但没批准时标题也一直写“待你答”。现在：
   *   · 扫描口径已改成“答完 = 答完了，等你批准”；
   *   · 这里在答完/批准/作废当下主动扫一次，不用用户等下一轮。
   * 只扫“答完或终态”的场景 —— 每勾一题都全量扫一次太浪费。
   */
  function refreshDeckNotice(deck: string, always = false): void {
    try {
      // 2026-11-26：这里原来调 `listDecks()` —— 那是**全库**扫描（每卷解析 + 每张卡引用计数 +
      // 题库统计）。而它挂在 `saveAnswers` 上，输入框每停 350ms 就存一次草稿 →
      // 等于用户每打几个字，主进程就把所有问卷和 300 多张卡重读一遍。
      // 暮雨两次报「方寸填问卷打字很卡」；这是最像的原因。
      // 现在只读**这一卷**（getDeck），且只在"答完"时才触发通知收敛。
      const g = getDeck(deck)
      if (!g.ok || !g.parsed) return
      const total = (g.parsed.questions || []).length
      if (!total) return
      const answers = g.answers || {}
      let answered = 0
      for (const q of g.parsed.questions) {
        const a = answers[String(q.id || '')]
        if (!a) continue
        if (a.kind === 'amend' || a.kind === 'askback') {
          if (String(a.text || '').trim()) answered++
        } else {
          answered++
        }
      }
      if (always || answered >= total) notifier.scanOnce()
    } catch { /* 通知收敛失败不该让答卷/批准失败 */ }
  }

  guardedHandle('questionnaire:list', () => listDecks())

  guardedHandle('questionnaire:get', (_e, deck: string) => getDeck(String(deck || '')))

  guardedHandle('questionnaire:saveAnswers', (_e, deck: string, answers: Record<string, QAnswer>, approvedAt?: string) => {
    const name = String(deck || '')
    const r = writeAnswers(name, { answers: answers || {}, approvedAt })
    if (r.ok) refreshDeckNotice(name)
    return r
  })

  guardedHandle('questionnaire:approve', (_e, deck: string) => {
    const name = String(deck || '')
    const r = approveDeck(name)
    if (r.ok) refreshDeckNotice(name, true)
    return r
  })

  // 出口提示词（2026-11-05）：反问 → 重出题；答卷 → 出施工单。
  // 判断“有反问就不许出施工单”放在数据层（纯函数好测），这里只转发。
  guardedHandle('questionnaire:prompt', (_e, deck: string, kind: string) => {
    return buildPromptForDeck(String(deck || ''), kind === 'build' ? 'build' : 'rewrite')
  })

  // ── 作废与事后校验（2026-11-07）────────────────────────────────────
  // 两件事都是"决策库活不活"的关键：不作废 = agent 拿过期答案干活；
  // 不校验 = 决策卡永远"有效"，等于一张写着结论的废纸。
  guardedHandle('questionnaire:voidDeck', (_e, deck: string, reason: string) => {
    const name = String(deck || '')
    const r = voidDeck(name, String(reason || ''))
    if (r.ok) refreshDeckNotice(name, true)
    return r
  })

  guardedHandle('questionnaire:reopenDeck', (_e, deck: string) => {
    const name = String(deck || '')
    const r = reopenDeck(name)
    if (r.ok) refreshDeckNotice(name, true)
    return r
  })

  guardedHandle('questionnaire:voidAnswer', (_e, deck: string, qid: string, reason: string) => {
    return voidAnswer(String(deck || ''), String(qid || ''), String(reason || ''))
  })

  guardedHandle('questionnaire:audit', (_e, deck: string, qid: string, verdict: string, evidence: string) => {
    return auditAnswer(String(deck || ''), String(qid || ''), String(verdict || ''), String(evidence || ''))
  })

  guardedHandle('questionnaire:auditQueue', () => auditQueue())

  // ── 问卷管理（2026-11-11 卡《问卷管理跟不上出卷速度》）──────────────────
  // 三条口：搜索（卷名/标题/项目/题面 + 日期）/ 归档候选 / 归档与取消归档。
  // 卷越多越不能靠“一屏平铺 + 眼睛找”；界面只负责展示，判定全在数据层（纯函数好测）。
  guardedHandle('questionnaire:search', (_e, query: string, opts?: { project?: string; from?: string; to?: string }) => {
    return searchDecks(String(query || ''), opts && typeof opts === 'object' ? opts : undefined)
  })

  guardedHandle('questionnaire:archivable', (_e, days?: number) => {
    const n = Number(days)
    return archivableDecks(Number.isFinite(n) && n > 0 ? n : 30)
  })

  guardedHandle('questionnaire:archive', (_e, deck: string, reason?: string) => {
    return archiveDeck(String(deck || ''), String(reason || ''))
  })

  guardedHandle('questionnaire:unarchive', (_e, deck: string) => {
    return unarchiveDeck(String(deck || ''))
  })

  // ── 题库 ↔ 卷 ↔ 卡 的关系视图（0.7.0 P11）────────────────────────────────
  // 回答的是“哪条结论来自哪一卷、哪卷还在等、哪条已经落成卡”：
  //   题库 = 题的真身；卷 = 它被问过几次（同一题可能出现在多卷）；卡 = 引用它的施工方。
  // 纯计算在 `questionBank.bankRelations`（node 可直跑断言），这里只负责把三份数据凑齐。
  guardedHandle('questionnaire:bankRelations', (_e, project?: string) => {
    const p = String(project || '').trim()
    const bank = p ? bankOf(p) : loadBank()
    const cards = loadTasks('all').map((t: any) => ({
      id: String(t?.fm?.id || t.id || ''),
      clarify: clarifyOf(t as any),
    }))
    return bankRelations({ project: p, bank, decks: collectDeckProbes(), cards })
  })

  // 多卷批量处置：逐卷走同一条通道（archiveDeck / voidDeck），
  // 单卷失败不影响其余，失败的那几卷**什么都没改**并逐条报出来。
  guardedHandle('questionnaire:batchAction', (_e, input?: { decks?: string[]; action?: string; reason?: string; days?: number }) => {
    return batchDeckAction(input && typeof input === 'object' ? input : {})
  })

  // 答卷 → 真任务卡（2026-11-07）。这一步才是"反馈给施工方"的实处：
  // 在此之前"出单"只产出一段提示词，谁去把它变成卡没人管 —— 链断在最后一步。
  guardedHandle('questionnaire:makeCards', (_e, deck: string, opts?: { project?: string; priority?: string }) => {
    return deckToCards(String(deck || ''), opts && typeof opts === 'object' ? opts : undefined)
  })

  // 派工单出厂上下文（2026-11-09 · S3=B）：一次把“闸的结果 + 已落档验收线”给渲染层，
  // 免得界面自己拼数据、拼错口径。没带卷 = gate.ok false，界面不许复制派工单。
  // 2026-11-11：`<卷>#<题号>` 是题目级澄清（问卷落卡）—— 整卷判会把它锁死，这里按题判。
  guardedHandle('questionnaire:dispatchContext', (_e, deck: string, project: string) => {
    const raw = String(deck || '')
    const { deck: name, qid } = splitClarify(raw)
    const gate = qid ? gateForQuestion(name, qid, String(project || '')) : gateForDeck(name, String(project || ''))
    return {
      gate,
      rulings: effectiveAcceptances(String(project || '')).map((r) => ({ deck: r.deck, qid: r.qid, line: r.line })),
    }
  })

  // 结论集 / 收敛进度（P8 · D-064）：按卷反查它所属项目，给界面一句话进度。
  // 为什么不直接要 project 参数：界面上开着一卷时它只知道卷名；项目归属的认法必须与主进程同一套。
  guardedHandle('questionnaire:convergence', (_e, deck: string) => {
    const name = String(deck || '')
    const g = getDeck(name)
    const project = g.ok && g.parsed ? projectForDeck(name, g.parsed) : ''
    return { ...convergenceStatus(project), project }
  })

  guardedHandle('questionnaire:openDir', () => {
    const dir = questionnaireDir()
    try {
      void shell.openPath(dir)
      return { ok: true, dir }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e), dir }
    }
  })
}
