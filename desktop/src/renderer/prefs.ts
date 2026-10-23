/**
 * UI 偏好读写（渲染层唯一一份，2026-10-23 从 App.vue 抽出来）。
 *
 * 真身在主进程 `userData/prefs.json`，**localStorage 只当读缓存** —— 因为 localStorage
 * 绑定 origin：dev 换 host（localhost → 127.0.0.1）或打包版 file:// 都会把偏好清空。
 *
 * ⚠ `saveUiPref` 必须过 `toPlain()`：值常是 Vue 响应式代理，contextBridge 走结构化克隆，
 *   Proxy 在跨世界那一跳直接抛 `An object could not be cloned`，而**主进程日志里一个字都没有**，
 *   界面只表现为"点了没反应 / 存不住"。同一个坑踩过两次（启动台、在途一屏）。
 */
import { toPlain } from '../shared/plain'

export function readUiPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const v = JSON.parse(raw)
    return (v ?? fallback) as T
  } catch { return fallback }
}
/**
 * 写一个 UI 偏好键（真身在主进程 prefs.json，localStorage 只当读缓存）。
 *
 * ⚠ **必须过 `toPlain()`**（2026-10-05 实锤）：`value` 常常是 Vue 响应式代理
 *   （`someRef.value`、v-for 元素），而 contextBridge 搬参数走**结构化克隆**，
 *   Proxy 在「页面世界 → 隔离世界」这一跳直接抛 `An object could not be cloned` ——
 *   报文进不到 preload、更进不到主进程，**主进程日志里一个字都没有**，界面表现为
 *   "点了没反应 / 存不住"（在途一屏「勾一下闪退一下」就是这么来的：数组类偏好从来没写进去过，
 *   于是每次 loadTripBoard 都判定"从没做过手动选择"→ 勾选被清掉）。
 *   同一个坑 2026-09-25 踩过一次（启动台无法启动应用，修了 6 次）。
 *   裸的字符串/数字/布尔是原始值，过 toPlain 无副作用。
 */
export function saveUiPref(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* 缓存失败无所谓 */ }
  try { (window as any).tegula?.prefsSet?.(key, toPlain(value))?.catch?.(() => {}) } catch { /* 真身失败已在主进程记日志 */ }
}
