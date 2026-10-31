/**
 * 作战计划 IPC（0.6.0 P1）
 *
 * 只有两个口（P1 判据写死的）：`plans:get` 读、`plans:verdict` 写。
 * 不加 `plans:create` / `plans:delete` —— 建卡与删卡是人在编辑器里做的事，
 * 这一版只让"裁决"第一次有地方发生。
 */
import { guardedHandle } from './guarded-ipc'
import { listPlanFiles, readPlan, writePlanVerdict, type PlanAction } from './data/plans'

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
