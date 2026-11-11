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
  projectForDeck, convergenceStatus,
  type QAnswer,
} from './data/questionnaires'
import { gateForDeck, gateForQuestion } from './data/qnGate'
import { splitClarify } from '../shared/clarify'

export function registerQuestionnaireIpcHandlers(): void {
  guardedHandle('questionnaire:list', () => listDecks())

  guardedHandle('questionnaire:get', (_e, deck: string) => getDeck(String(deck || '')))

  guardedHandle('questionnaire:saveAnswers', (_e, deck: string, answers: Record<string, QAnswer>, approvedAt?: string) => {
    return writeAnswers(String(deck || ''), { answers: answers || {}, approvedAt })
  })

  guardedHandle('questionnaire:approve', (_e, deck: string) => {
    return approveDeck(String(deck || ''))
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
    return voidDeck(String(deck || ''), String(reason || ''))
  })

  guardedHandle('questionnaire:reopenDeck', (_e, deck: string) => {
    return reopenDeck(String(deck || ''))
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
