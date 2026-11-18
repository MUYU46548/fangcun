/**
 * 许可协议闸的 IPC 面（2026-11-18）。
 *
 * 只做两件事，判据全在 `main/license.ts`：
 *   license:status  读状态（渲染层启动时问；view 模式显示确认时间）
 *   license:ack     写同意（**只由主窗口渲染层调用**；MCP/CLI 没有这条通道）
 *
 * 为什么 ack 不校验调用方：Electron IPC 本来就只从本应用渲染层可达；
 * 外部 agent 拿不到 ipcRenderer。真正的“不能代签”落在 MCP/CLI 没有写口 + 服务端记录。
 */
import { guardedHandle } from './guarded-ipc'
import { getDataDir } from './data'
import { record, selfCheck, state } from './license'

export function registerLicenseIpcHandlers(): void {
  guardedHandle('license:status', () => ({ ...state(getDataDir()) }))

  guardedHandle('license:ack', () => {
    const r = record(getDataDir(), 'gui')
    if (!r.ok) return { ...r.state, ok: false, error: r.error }
    return { ok: true, ...r.state }
  })

  // 诊断/CLI 自检共用一句话（设置页或 nfctl 类工具以后可直接读）
  guardedHandle('license:selfCheck', () => selfCheck(getDataDir()))
}
