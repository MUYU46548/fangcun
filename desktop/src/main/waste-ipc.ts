/**
 * 投入产出账 IPC（0.6.0 P5）
 *
 * 只一个**读**口：`waste:get`。不写盘、不触发任何动作；
 * 三格取不到就不产出那一格（口径在 shared/waste.ts）。
 */
import { guardedHandle } from './guarded-ipc'
import { collectWasteLedger } from './usage/ledger'
import { collectChannels } from './usage/channels'

export function registerWasteIpcHandlers(): void {
  /** 跨渠道 token 对比（2026-11-02）：只读；只比 token，金额只转述记录里已有的标注 */
  guardedHandle('channels:get', (_e, opts?: { days?: number; channels?: string[] }) => {
    try {
      const r = collectChannels({
        days: opts?.days,
        channels: Array.isArray(opts?.channels) ? opts.channels.map((x: any) => String(x)) : [],
      })
      return { ok: true, report: r.report, readError: r.readError }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('waste:get', (_e, opts?: { days?: number; repo?: string }) => {
    try {
      const ledger = collectWasteLedger({
        days: opts?.days,
        repo: opts?.repo ? String(opts.repo) : '',
      })
      return { ok: true, ledger }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })
}
