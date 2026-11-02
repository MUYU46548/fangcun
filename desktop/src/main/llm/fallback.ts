/**
 * BYOK 多通道 · 降级执行（0.6.0 第 2 批 · 2026-11-02）
 *
 * 一句话：**主通道失败就自动换下一条，但每次失败都要留痕、每次降级都要说得出来。**
 *
 * 分工：
 *  · 通道从哪来、谁排第一 → `main/llm/channels.effectiveChannels()`（主通道在 llm-config.json，备用在 llm-channels.json）
 *  · 该不该换下一条 → `shared/llmChannel.classifyFailure()`（400 类请求错就停，别靠降级掩盖）
 *  · 单次调用怎么发 → `main/llm/chat.chatDetailed()`（这里只负责"换着发"）
 *
 * 三条边界：
 *  ① **不改变"产出只落待审批"**：降级只影响"用哪条通道发请求"，不改任何写回语义；
 *  ② **每次失败都留痕**：失败记录走 `appendTrace`（带 channelId / 错误摘要），界面与账本都看得见；
 *  ③ **全挂要说人话**：返回里带 `attempts`（谁失败了、为什么）+ `skipped`（哪条压根没配齐）。
 */
import { chatDetailed, type ChatOptions } from './chat'
import { appendTrace } from './trace'
import { effectiveChannels } from './channels'
import {
  buildChain,
  classifyFailure,
  describeChain,
  type AttemptRecord,
  type ChannelLike,
  type SkippedChannel,
} from '../../shared/llmChannel'

export interface FallbackOptions extends ChatOptions {
  /** 最多试几条通道（默认 = 整条链） */
  maxChannels?: number
  /** 测试注入：不真发请求 */
  callOne?: (channel: { id: string; label: string; baseUrl: string; apiKey: string; model: string }, content: any, opts: ChatOptions) =>
    Promise<{ text: string; usage?: any; model?: string }>
  /** 测试注入：通道来源 */
  channels?: () => { channels: ChannelLike[]; primaryId: string }
  /** 测试注入：留痕 */
  appendTrace?: (rec: any) => void
}

export interface FallbackResult {
  ok: boolean
  text: string
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  model?: string
  /** 最后真正用上的通道 */
  channelId?: string
  channelLabel?: string
  /** 每次尝试（成功与失败都在里面，顺序 = 实际尝试顺序） */
  attempts: AttemptRecord[]
  /** 降级话术；主通道一次成功 = 空串（不制造噪音） */
  note: string
  /** 失败原因（ok=true 时为空） */
  error?: string
  /** 哪条压根没配齐 / 被停用 */
  skipped: SkippedChannel[]
}

function s(v: unknown): string {
  return String(v ?? '').trim()
}

/**
 * 带降级的对话调用。
 * **永不抛**：全挂时返回 `ok:false` + 可读原因（调用方按"没拿到结果"处理，别崩整条链路）。
 */
export async function chatWithFallback(
  content: any,
  opts: FallbackOptions = {},
): Promise<FallbackResult> {
  const src = (opts.channels || effectiveChannels)()
  const plan = buildChain(src.channels, src.primaryId)
  const trace = opts.appendTrace || appendTrace
  const maxChannels = Math.max(1, Number(opts.maxChannels) || plan.chain.length || 1)
  const chains = plan.chain.slice(0, maxChannels)

  if (!chains.length) {
    const why = plan.skipped.map((k) => `${k.label}：${k.reason}`).join('；') || '一条都没配'
    return {
      ok: false, text: '', attempts: [], note: '', skipped: plan.skipped,
      error: `没有可用通道 —— ${why}`,
    }
  }

  const attempts: AttemptRecord[] = []
  const call = opts.callOne || (async (ch, body, o) => {
    const r = await chatDetailed(body, {
      ...o,
      baseUrl: ch.baseUrl,
      apiKey: ch.apiKey,
      model: ch.model,
    })
    return { text: r.text, usage: r.usage, model: ch.model }
  })

  for (const ch of chains) {
    const t0 = Date.now()
    try {
      const r = await call(ch, content, opts)
      attempts.push({ channelId: ch.id, channelLabel: ch.label, ok: true, durationMs: Date.now() - t0 })
      return {
        ok: true,
        text: String(r?.text || ''),
        usage: r?.usage,
        model: s(r?.model) || ch.model,
        channelId: ch.id,
        channelLabel: ch.label,
        attempts,
        note: describeChain(attempts, ch.id),
        skipped: plan.skipped,
      }
    } catch (e: any) {
      const cls = classifyFailure(e)
      attempts.push({
        channelId: ch.id, channelLabel: ch.label, ok: false,
        reason: cls.reason, durationMs: Date.now() - t0,
      })
      // 每次失败都留痕（花销/失败可见）：谁的通道、为什么、多久
      try {
        trace({
          ts: new Date().toISOString(),
          trigger: `${s(opts.trigger) || 'llm'}:fallback`,
          model: ch.model,
          prompt_chars: 0,
          completion_chars: 0,
          duration_ms: Date.now() - t0,
          ok: false,
          stream: false,
          error: `${cls.reason}｜${String(e?.message || e).slice(0, 240)}`,
          channel: ch.id,
          origin: 'local',
        })
      } catch { /* 留痕失败不挡降级 */ }
      if (cls.verdict === 'stop') {
        return {
          ok: false, text: '', attempts, skipped: plan.skipped,
          note: describeChain(attempts),
          error: `${cls.reason} —— ${cls.hint}`,
        }
      }
    }
  }

  return {
    ok: false, text: '', attempts, skipped: plan.skipped,
    note: describeChain(attempts),
    error: describeChain(attempts) || '所有通道都失败了',
  }
}
