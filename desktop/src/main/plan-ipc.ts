/**
 * 作战计划 IPC（0.6.0 P1）
 *
 * 只有两个口（P1 判据写死的）：`plans:get` 读、`plans:verdict` 写。
 * 不加 `plans:create` / `plans:delete` —— 建卡与删卡是人在编辑器里做的事，
 * 这一版只让"裁决"第一次有地方发生。
 */
import { guardedHandle } from './guarded-ipc'
import { listPlanFiles, readPlan, writePlanVerdict, type PlanAction } from './data/plans'
import { listDrafts, proposeFromDraft } from './data/planDrafts'
import { listDecks } from './data/questionnaires'

export function registerPlanIpcHandlers(): void {
  guardedHandle('plans:get', (_e, file?: string) => {
    try {
      if (!file) {
        const files = listPlanFiles()
        return { ok: true, files, docs: files.map((f) => readPlan(f)).filter(Boolean) }
      }
      const doc = readPlan(String(file))
      if (!doc) return { ok: false, error: '计划卡不存在' }
      return { ok: true, files: listPlanFiles(), docs: [doc] }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ── 规划草案入口（2026-11-11 · 0.7.0 规划根基）──────────────────────────
  // 在此之前草案只在 `task-data/plans/_drafts/*.md`，界面看不见 —— 「agent 起草 → 人裁决」
  // 这条链只通了半截。两条口：读草案（含每格缺什么 + 可选的澄清卷）与「提成阶段卡」。
  // 提成走的仍是 `proposeStage` 那条闸（三块校验 + 判据前缀 + 重号 + 澄清卷硬闸），不另开写口。
  guardedHandle('plans:drafts', () => {
    try {
      const r = listDrafts()
      // 澄清卷候选：界面上要选一卷才能提（与 agent 走 stage_plan_propose 同一个要求）
      let decks: { deck: string; project: string; approved: boolean; voided?: boolean; replacedBy?: string }[] = []
      try {
        const l = listDecks()
        decks = (l.decks || []).map((d: any) => ({
          deck: d.deck, project: d.project || '', approved: !!d.approved,
          voided: !!d.voided, replacedBy: d.replacedBy || '',
        }))
      } catch { /* 卷读不出来不该挡住草案列表：界面会显示“没有可选的澄清卷” */ }
      return { ...r, decks: decks.filter((d) => d.approved && !d.voided && !d.replacedBy) }
    } catch (e) {
      return { ok: false, error: (e as Error).message, drafts: [], broken: [], decks: [], dir: '' }
    }
  })

  guardedHandle('plans:proposeFromDraft', (_e, input?: { draft?: string; stageId?: string; deck?: string }) => {
    try {
      return proposeFromDraft({
        draft: String(input?.draft || ''),
        stageId: String(input?.stageId || ''),
        deck: String(input?.deck || ''),
      })
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })


  guardedHandle('plans:verdict', (_e, input: {
    file: string
    stageId: string
    action: PlanAction
    text?: string
  }) => {
    try {
      const r = writePlanVerdict({
        file: String(input?.file || ''),
        stageId: String(input?.stageId || ''),
        action: input?.action as PlanAction,
        text: input?.text,
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, doc: r.doc }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
