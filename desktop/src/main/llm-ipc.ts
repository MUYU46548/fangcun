import { ipcMain } from 'electron'
import { getConfig, setConfig, resetConfig, LLMConfig } from './llm/config'
import { chat, streamChat } from './llm/chat'
import { auditProject, decomposeGoal, decideDP, quarterlyReview, generateRoadmap } from './llm/planning'

export function registerLlmIpcHandlers(): void {
  // ── LLM Config ────────────────────────────────────────────────────
  ipcMain.handle('llm:getConfig', () => {
    const cfg = getConfig()
    // 不返回完整 apiKey，只返回是否存在
    return { ...cfg, apiKey: cfg.apiKey ? '***' : '' }
  })

  ipcMain.handle('llm:setConfig', (_event, cfg: Partial<LLMConfig>) => {
    const updated = setConfig(cfg)
    return { ok: true, config: { ...updated, apiKey: updated.apiKey ? '***' : '' } }
  })

  ipcMain.handle('llm:resetConfig', () => {
    resetConfig()
    return { ok: true }
  })

  // ── Chat ──────────────────────────────────────────────────────────
  ipcMain.handle('llm:chat', async (_event, content: string, options: any) => {
    try {
      const result = await chat(content, options)
      return { ok: true, content: result }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ── Planning ──────────────────────────────────────────────────────
  ipcMain.handle('llm:auditProject', async (_event, projectId: string, model?: string) => {
    try {
      const result = await auditProject(projectId, model)
      return { ok: true, content: result }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('llm:decomposeGoal', async (_event: any, goal: string, projectId?: string, model?: string) => {
    try {
      const result = await decomposeGoal(goal, projectId, model)
      return { ok: true, content: result }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('llm:decideDP', async (_event: any, dp: any, model?: string) => {
    try {
      const result = await decideDP(dp, model)
      return { ok: true, content: result }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('llm:quarterlyReview', async (_event: any, projectId?: string, model?: string) => {
    try {
      const result = await quarterlyReview(projectId, model)
      return { ok: true, content: result }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('llm:generateRoadmap', async (_event: any, goal?: string, projectId?: string, model?: string) => {
    try {
      const result = await generateRoadmap(goal, projectId, model)
      return { ok: true, content: result }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
