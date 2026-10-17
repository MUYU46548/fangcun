import { ipcMain } from 'electron'
import { guardedHandle } from './guarded-ipc'
import { getConfig, getConfigForRenderer, setConfig, resetConfig, LLMConfig, LLMError } from './llm/config'
import { chat, streamChat, pingConnection, ChatOptions } from './llm/chat'
import { auditProject, decomposeGoal, decideDP, quarterlyReview, generateRoadmap } from './llm/planning'
import { planToDraft, draftProjectBrief, docToDrafts } from './llm/writeback'
import { usageStats } from './llm/trace'

/** 把 LLMError 的完整证据（状态码/响应体/URL）带到渲染层，便于用户自查 */
function toFailure(e: unknown, fallbackUrl = '') {
  const err = e as LLMError
  return {
    ok: false as const,
    error: err?.message || String(e),
    status: err?.code ?? null,
    body: err?.body ?? '',
    url: err?.url || fallbackUrl,
  }
}

export function registerLlmIpcHandlers(): void {
  // ── LLM Config ────────────────────────────────────────────────────
  // 2026-10-17 暮雨第 10 条「花销可见」：把 ai-trace.jsonl 里的 token 汇总算出个准数。
  // ⚠ 只统计**供应商真报了 usage** 的调用；没报的单独计次数，绝不拿字符数折算成 token。
  guardedHandle('llm:usageStats', (_event: any, days?: number) => {
    return usageStats(Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 30)
  })

  guardedHandle('llm:getConfig', () => {
    // 密钥只出掩码 + 提示串，原值永不过 IPC
    return getConfigForRenderer()
  })

  guardedHandle('llm:setConfig', (_event, cfg: Partial<LLMConfig>) => {
    try {
      // setConfig 内部已忽略掩码/空 apiKey，不会把 '***' 写盘
      const updated = setConfig(cfg)
      return {
        ok: true,
        config: { ...updated, apiKey: updated.apiKey ? '***' : '' },
        hasApiKey: !!updated.apiKey,
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  guardedHandle('llm:resetConfig', () => {
    try {
      resetConfig()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ── 连接诊断（不改配置，失败原因全量回显） ─────────────────────────
  guardedHandle('llm:testConnection', async (_event, cfg?: Partial<LLMConfig>) => {
    try {
      const base = getConfig()
      const options: ChatOptions = {
        baseUrl: cfg?.baseUrl || base.baseUrl,
        // 掩码/空 → 用磁盘上的真实密钥
        apiKey: cfg?.apiKey,
        model: cfg?.model || base.model,
        timeout: Math.min(cfg?.timeout || base.timeout, 30),
      }
      const result = await pingConnection(options)
      return { ok: result.ok, ...result }
    } catch (e) {
      return toFailure(e)
    }
  })

  // ── Chat ──────────────────────────────────────────────────────────
  guardedHandle('llm:chat', async (_event, content: string, options: ChatOptions) => {
    try {
      const result = await chat(content, { ...options, trigger: options.trigger || 'desktop.chat' })
      return { ok: true, content: result }
    } catch (e) {
      return toFailure(e)
    }
  })

  // ── Planning ──────────────────────────────────────────────────────
  guardedHandle('llm:auditProject', async (_event, projectId: string, model?: string) => {
    try {
      const result = await auditProject(projectId, model)
      return { ok: true, content: result }
    } catch (e) {
      return toFailure(e)
    }
  })

  guardedHandle('llm:decomposeGoal', async (_event: any, goal: string, projectId?: string, model?: string) => {
    try {
      const result = await decomposeGoal(goal, projectId, model)
      return { ok: true, content: result }
    } catch (e) {
      return toFailure(e)
    }
  })

  guardedHandle('llm:decideDP', async (_event: any, dp: any, model?: string) => {
    try {
      const result = await decideDP(dp, model)
      return { ok: true, content: result }
    } catch (e) {
      return toFailure(e)
    }
  })

  guardedHandle('llm:quarterlyReview', async (_event: any, projectId?: string, model?: string) => {
    try {
      const result = await quarterlyReview(projectId, model)
      return { ok: true, content: result }
    } catch (e) {
      return toFailure(e)
    }
  })

  guardedHandle('llm:generateRoadmap', async (_event: any, goal?: string, projectId?: string, model?: string) => {
    try {
      const result = await generateRoadmap(goal, projectId, model)
      return { ok: true, content: result }
    } catch (e) {
      return toFailure(e)
    }
  })

  // ── AI 规划写回层（2026-10-12，方案卡：AI 规划功能；详见 llm/writeback.ts）──
  // 红线：AI 卡只落「待审批」，转正唯一路径是用户点头；source=ai-planning 审计可查。
  guardedHandle('llm:planToDraft', async (_event: any, goal: string, projectId?: string, model?: string) => {
    return planToDraft(goal, projectId || '', model)
  })

  guardedHandle('llm:draftProjectBrief', async (_event: any, projectId: string, model?: string) => {
    return draftProjectBrief(projectId, model)
  })

  guardedHandle('llm:docToDrafts', async (_event: any, docText: string, projectId?: string, model?: string, maxCards?: number) => {
    return docToDrafts(docText, projectId || '', model, maxCards || 20)
  })
}
