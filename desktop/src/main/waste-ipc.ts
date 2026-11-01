/**
 * 投入产出账 IPC（0.6.0 P5）
 *
 * 只一个**读**口：`waste:get`。不写盘、不触发任何动作；
 * 三格取不到就不产出那一格（口径在 shared/waste.ts）。
 */
import { guardedHandle } from './guarded-ipc'
import { collectWasteLedger } from './usage/ledger'

export function registerWasteIpcHandlers(): void {
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
