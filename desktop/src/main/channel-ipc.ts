/**
 * BYOK 多通道 · IPC（0.6.0 第 2 批 · 2026-11-02）
 *
 * 三个口：
 *  · `llm-channels:list`   —— 主通道 + 备用通道（密钥只给掩码）
 *  · `llm-channels:upsert` —— 增/改一条备用通道（掩码或空 = 不覆盖已存密钥）
 *  · `llm-channels:remove` —— 删一条备用通道（主通道删不掉）
 *
 * ⚠ 与 `channels:get`（跨渠道 token 对比）**不是一回事**：那个是花销统计，这个是模型通道配置。
 * 通道名前缀 `llm-` 就是为了不再撞车。
 *
 * 没有 `test` 口：测试连通性 = 一次真实调用 = 花钱。要验就用界面上的"问一问"或点一次生成。
 */
import { guardedHandle } from './guarded-ipc'
import { getChannelsForRenderer, upsertBackupChannel, removeBackupChannel } from './llm/channels'

export function registerLlmChannelIpcHandlers(): void {
  guardedHandle('llm-channels:list', () => {
    try {
      return { ok: true, ...getChannelsForRenderer() }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('llm-channels:upsert', (_e, input?: any) => {
    try {
      const r = upsertBackupChannel(input || {})
      if (!r.ok) return { ok: false, error: r.error }
      // 回读一次：界面拿到的是"落盘后的真相"，不是请求参数的复述
      return { ok: true, ...getChannelsForRenderer() }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('llm-channels:remove', (_e, id?: string) => {
    try {
      const r = removeBackupChannel(String(id || ''))
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, ...getChannelsForRenderer() }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })
}
