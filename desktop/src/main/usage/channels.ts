/**
 * 跨渠道 token 对比 · 主进程取数（0.6.0 第 2 批 · 2026-11-02）
 *
 * 只做一件事：把 ai-trace 读出来交给 `shared/channelTokens.buildChannelReport`。
 * 聚合口径全在纯逻辑里（可 Node 直跑、可反例），这里只管"真去读"，并允许注入假数据。
 *
 * 读不到 trace（文件不存在 / 读失败）→ 传空数组，界面显示"还没有记录"，
 * **不要把读失败说成"没花钱"** —— 两者在一次性读口里没法区分，所以在 reason 里如实带上。
 */
import { readTrace } from '../llm/trace'
import { buildChannelReport, type ChannelReport, type ChannelTraceLike } from '../../shared/channelTokens'

export interface ChannelOptions {
  days?: number
  channels?: string[]
  now?: string
}

export interface ChannelResult {
  report: ChannelReport
  /** 读 trace 失败时的原因（成功为空串）；界面据此改口，不把读失败说成没花钱 */
  readError: string
}

function defaultTrace(): { records: ChannelTraceLike[]; error: string } {
  try {
    const r = readTrace({ limit: -1 })
    return { records: Array.isArray(r.records) ? (r.records as any) : [], error: '' }
  } catch (e: any) {
    return { records: [], error: e?.message || String(e) }
  }
}

export function collectChannels(
  opts: ChannelOptions & { trace?: () => { records: ChannelTraceLike[]; error: string } } = {},
): ChannelResult {
  const got = (opts.trace || defaultTrace)()
  const report = buildChannelReport(got.records || [], {
    days: opts.days,
    channels: opts.channels,
    now: opts.now,
  })
  return { report, readError: String(got.error || '') }
}
