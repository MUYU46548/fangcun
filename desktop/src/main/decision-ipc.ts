/**
 * Fangcun Desktop — 决策卡 IPC 通道（2026-10-12，AI 规划包第 3 件）
 * 语义独立于 LLM：纯本地 CRUD。桌面与 Python CLI 双腿同文件（decisions.md）。
 */
import { guardedHandle } from './guarded-ipc'
import {
  loadDecisions,
  addDecision,
  setDecisionStatus,
  updateDecision,
  deleteDecision,
  DecisionInput,
  DecisionPatch,
  DecisionStatus,
} from './data/decisions'

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

  // 2026-10-17 暮雨第 5 条：决策原来只能新增和改状态，改错一个字就只能撤销重记、写错一条就永久留着。
  guardedHandle('decision:update', (_event, id: string, patch: DecisionPatch) => {
    return updateDecision(id, patch)
  })

  guardedHandle('decision:delete', (_event, id: string) => {
    return deleteDecision(id)
  })
}
