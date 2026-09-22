/**
 * Fangcun Desktop — IPC 统一包装（失败可见 + 重复注册可见）
 *
 * 背景（2026-09-22，用户第 8 条「任何失败或崩溃根本查不到日志」）：
 *   IPC handler 抛错时，渲染层只拿到一个 rejected promise，
 *   界面上往往什么都没有、终端里也什么都没有 —— 故障完全隐身。
 *   此前只能靠静态对账脚本（check-ipc-parity）抓僵尸通道，抓不到运行期失败。
 *
 * 这里把 `ipcMain.handle` 统一换成 `guardedHandle`：
 *   ① 每个通道的异常都落盘（通道名 + 耗时 + 堆栈），便于事后定位；
 *   ② 返回 { ok:false } 的通道记一条 WARN（"假成功"的反面：真失败要有痕迹）；
 *   ③ 重复注册同一通道记 WARN（zombie 通道的第二类：后注册覆盖前者）。
 *
 * ⚠ 异常仍然 **rethrow** —— 保持原有调用语义不变。
 *   若改成返回 {ok:false}，`const list = await x()` 这类调用点会拿到对象而不是数组，
 *   反而制造新的静默失败。可观测性升级不改变控制流。
 */

import { ipcMain } from 'electron'
import * as appLog from './services/appLog'

type Listener = (event: any, ...args: any[]) => any

const registered = new Set<string>()

export function guardedHandle(channel: string, listener: Listener): void {
  if (registered.has(channel)) {
    appLog.warn('ipc', `重复注册通道 ${channel} —— 后注册的会覆盖前者`)
  }
  registered.add(channel)

  ipcMain.handle(channel, async (event, ...args) => {
    const t0 = Date.now()
    try {
      const r = await listener(event, ...args)
      if (r && typeof r === 'object' && (r as any).ok === false) {
        appLog.warn(`ipc:${channel}`, '通道返回失败', (r as any).error ?? r)
      }
      return r
    } catch (e) {
      appLog.error(`ipc:${channel}`, `通道异常（耗时 ${Date.now() - t0}ms）`,
        e instanceof Error ? e.stack : e)
      throw e
    }
  })
}

/** 已注册通道名（供自检/对账使用） */
export function registeredChannels(): string[] {
  return [...registered].sort()
}
