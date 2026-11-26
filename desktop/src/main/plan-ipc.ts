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
import { loadTasks } from './data'
import { readTask, updateTask } from './data/tasks'
import {
  isPlanMemo, planMemoFocusOf, planMemoModeOf, planMemoStatusOf,
  PLAN_MEMO_STATUSES, PLAN_MEMO_TYPE, PLAN_MEMO_TAG,
} from '../shared/planMemo'

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

  // 2026-11-12（0.7.0 第二轮）：提成时可以带 `patch` —— 界面上就地改过的三块。
  // 仍然只走 `proposeFromDraft` → `proposeStage` 这一条写路径，草案文件一个字节不写。
  guardedHandle('plans:proposeFromDraft', (_e, input?: {
    draft?: string; stageId?: string; deck?: string; patch?: { approach?: string[]; copyRows?: string[][]; criteria?: string[] }
  }) => {
    try {
      return proposeFromDraft({
        draft: String(input?.draft || ''),
        stageId: String(input?.stageId || ''),
        deck: String(input?.deck || ''),
        patch: input?.patch,
      })
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })


  // ── 规划备忘（2026-11-26 · 定向规划的家）────────────────────────────────
  // 为什么单开一条读口：任务列表（ipc.ts 的 loadTasks）默认过滤掉备忘，
  // 这一页却必须看到它们 —— 两边用同一个 `isPlanMemo` 口径，只在展示层分家。
  guardedHandle('plans:memos', () => {
    try {
      const rows = loadTasks('all')
        .filter((t) => isPlanMemo(t))
        .map((t) => {
          const project = (t.fm as any).project
          return {
            id: t.id,
            title: String((t.fm as any).title || ''),
            project: Array.isArray(project) ? project.join(' / ') : String(project || ''),
            taskStatus: String((t.fm as any).status || ''),
            memoStatus: planMemoStatusOf(t.fm),
            mode: planMemoModeOf(t.fm),
            focus: planMemoFocusOf(t.fm),
            created: String((t.fm as any).created || ''),
            updated: String((t.fm as any).updated || ''),
            body: String(t.body || ''),
          }
        })
      // 待读排最前（那才是要人动的），同档按更新时间倒序
      rows.sort((a, b) => {
        const rank = (s: string) => (s === '待读' ? 0 : s === '已采纳' ? 1 : 2)
        if (rank(a.memoStatus) !== rank(b.memoStatus)) return rank(a.memoStatus) - rank(b.memoStatus)
        return String(b.updated).localeCompare(String(a.updated))
      })
      return { ok: true, memos: rows, dir: 'task-data/' }
    } catch (e) {
      return { ok: false, error: (e as Error).message, memos: [] }
    }
  })

  /**
   * 改「规划备忘」的阅读状态。
   *
   * ⚠ 只改 `plan_memo_status`，**不动任务状态**：借用任务状态会让备忘混进
   *   「待办 / 进行中」的队列语义，又变回一种任务（这正是它要解决的问题）。
   */
  guardedHandle('plans:memoStatus', (_e, input?: { id?: string; status?: string }) => {
    try {
      const id = String(input?.id || '').trim()
      const status = String(input?.status || '').trim()
      if (!id) return { ok: false, error: '没给备忘 id' }
      if (!(PLAN_MEMO_STATUSES as readonly string[]).includes(status)) {
        return { ok: false, error: `备忘状态只能是：${PLAN_MEMO_STATUSES.join(' / ')}` }
      }
      const task = readTask(id)
      if (!task) return { ok: false, error: '这张卡不存在（可能已归档或删除）' }
      if (!isPlanMemo(task)) {
        return { ok: false, error: `这不是规划备忘卡（要 ${PLAN_MEMO_TYPE} 或标签「${PLAN_MEMO_TAG}」）` }
      }
      const next = updateTask(id, { plan_memo_status: status } as any)
      if (!next) return { ok: false, error: '写回失败：卡不存在' }
      return { ok: true, id, memoStatus: status, taskStatus: String((next.fm as any).status || '') }
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
