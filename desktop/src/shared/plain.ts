/**
 * Fangcun Desktop — IPC 载荷「去代理」（渲染层共用）
 *
 * 背景（2026-09-25，「启动台无法启动任何应用」第 6 次报修的真因）：
 *   渲染层把 **Vue 响应式代理**（v-for 的元素、ref 的 .value、reactive 表单）
 *   直接当参数传给 `window.tegula.*`。contextBridge 搬运参数走结构化克隆，
 *   Proxy 在**「页面 → 隔离世界」这一跳**就抛
 *   `Error: An object could not be cloned.`：
 *     · 报文根本没进 preload，更没进主进程；
 *     · 主进程一条日志都不会有（它在渲染层就被拦下了）；
 *     · 界面表现为「点了完全没反应 / 启动失败」。
 *   历次排查都在盯主进程执行器与 preload，所以修了 6 次都没修好。
 *
 * 用法：**凡是把「响应式对象」当 IPC 载荷传**，都要过一遍 toPlain()。
 *   `await window.tegula.launchpadLaunchApp(toPlain(app))`
 *   新建的对象字面量（`{ a: 1, b: s }`）本身就是裸对象，不必处理。
 */
export function toPlain<T>(value: T): any {
  if (value === null || typeof value !== 'object') return value
  const raw = value as any
  // 代理无法用 JS 稳定探测（没有标准 API）。最省事的判据：
  // 能克隆就原样返回（零开销，正常路径行为不变），克隆不了才 JSON 往返降级。
  try {
    structuredClone(value)
    return value
  } catch {
    try {
      return JSON.parse(JSON.stringify(raw))
    } catch {
      return raw
    }
  }
}
