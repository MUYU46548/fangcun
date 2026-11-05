/**
 * 问卷 IPC（2026-11-05）
 *
 * 五个口，一一对应弹窗要做的五件事：
 *   list         项目/顶栏显示“N 卷待答”
 *   get          打开某一卷（题 + 已有草稿）
 *   saveAnswers  存草稿（每点一下就存，关掉不丢）
 *   approve      批准落库（建决策卡 + 导出 decision-log 段落）
 *   openDir      打开问卷目录（把 md 放进去就能被认出来）
 *
 * ⚠ 没有 `questionnaire:create` —— 问卷是 agent 写的，方寸不做出题器
 *   （暮雨原话：“我现在的问卷全都是 agent 写的”）。方寸只做呈现 + 收答案 + 落库。
 */
import { shell } from 'electron'
import { guardedHandle } from './guarded-ipc'
import {
  listDecks, getDeck, writeAnswers, approveDeck, questionnaireDir,
  type QAnswer,
} from './data/questionnaires'

export function registerQuestionnaireIpcHandlers(): void {
  guardedHandle('questionnaire:list', () => listDecks())

  guardedHandle('questionnaire:get', (_e, deck: string) => getDeck(String(deck || '')))

  guardedHandle('questionnaire:saveAnswers', (_e, deck: string, answers: Record<string, QAnswer>, approvedAt?: string) => {
    return writeAnswers(String(deck || ''), { answers: answers || {}, approvedAt })
  })

  guardedHandle('questionnaire:approve', (_e, deck: string) => {
    return approveDeck(String(deck || ''))
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
