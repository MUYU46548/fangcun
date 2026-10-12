/**
 * Fangcun Desktop — 决策卡 IPC 通道（2026-10-12，AI 规划包第 3 件）
 * 语义独立于 LLM：纯本地 CRUD。桌面与 Python CLI 双腿同文件（decisions.md）。
 */
import { guardedHandle } from './guarded-ipc'
import { loadDecisions, addDecision, setDecisionStatus, DecisionInput, DecisionStatus } from './data/decisions'

export function registerDecisionIpcHandlers(): void {
  guardedHandle('decision:list', () => {
    return { ok: true as const, items: loadDecisions() }
  })

  guardedHandle('decision:add', (_event, input: DecisionInput) => {
    return addDecision(input)
  })

  guardedHandle('decision:setStatus', (_event, id: string, status: DecisionStatus, note?: string) => {
    return setDecisionStatus(id, status, note)
  })
}
