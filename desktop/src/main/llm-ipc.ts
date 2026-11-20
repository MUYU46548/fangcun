/**
 * LLM 用量 / 单价 IPC（2026-11-20 BYOK 退场后仅保留只读账本）。
 *
 * 已删：模型通道配置、测试连接、余额、chat、审计/拆解/复盘/路线图。
 * GUI 里能点到的东西全部走 DSH 派单（`context:dispatchDsh` / `context:dispatchMessage`）；
 * MCP / CLI 的入口另在 `mcp/tools.ts` 与 `tegula/cli.py` 保留为提示版。
 */
import { guardedHandle } from './guarded-ipc'
import { getPrices, setPrices } from './llm/prices'
import { usageStats, usageByMonth } from './llm/trace'

export function registerLlmIpcHandlers(): void {
  // 2026-10-17 暮雨第 10 条“花销可见”：把 ai-trace.jsonl 里的 token 汇总算出个准数。
  // ⚠ 只统计**供应商真报了 usage** 的调用；没报的单独计次数，绝不拿字符数折算成 token。
  guardedHandle('llm:usageStats', (_event: any, days?: number) => {
    return usageStats(Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 30)
  })

  // 月度报表（2026-10-22 · 03 任务三）：按**自然月**切，不用滚动 30 天 ——
  // 1 号那天滚动窗口会把上个月的账算进"本月"，用户一核对就发现数字不对。
  guardedHandle('llm:usageMonthly', (_event: any, months?: number) => {
    const n = Number(months)
    return { months: usageByMonth(Number.isFinite(n) && n > 0 ? Math.min(n, 24) : 3) }
  })

  // 单价表（2026-10-25 卡 005 B 档）：用户自己填，方寸不预置任何默认价。
  guardedHandle('llm:getPrices', () => getPrices())
  guardedHandle('llm:setPrices', (_e: any, rows: unknown) => setPrices(rows))
}
