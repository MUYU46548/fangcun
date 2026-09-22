import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

/**
 * 渲染层全局错误上报（2026-09-22）
 *
 * 用户第 8 条：「任何失败或崩溃根本查不到日志」。
 * 渲染层此前的异常只进 Chromium console —— 在 Electron 里等于进了黑洞
 * （终端的 [ELECTRON] 段什么都没打印）。
 *
 * 这里把 window.onerror / unhandledrejection 统一：
 *   ① 广播给 App.vue（顶部错误条，用户能看见 + 一键打开日志）
 *   ② 回报主进程落盘（userData/logs/fangcun-YYYYMMDD.log）
 *
 * ⚠ 防递归：上报本身失败时不能再产生 unhandledrejection，否则自己咬自己。
 */
let reporting = false

function report(scope: string, message: string, detail?: string): void {
  if (reporting) return
  reporting = true
  try {
    window.dispatchEvent(new CustomEvent('fc-app-error', { detail: { scope, message, detail } }))
  } catch { /* 广播失败不影响上报 */ }
  try {
    const api: any = (window as any).tegula
    const p = api?.applogWrite?.('ERROR', scope, message, detail || '')
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch { /* preload 缺失时静默 */ }
  reporting = false

  // 同时留在 devtools，便于开发态直接看栈
  console.error(`[方寸] ${scope}: ${message}`, detail || '')
}

window.addEventListener('error', (e: ErrorEvent) => {
  report('window.onerror', e.message || '未知错误', (e.error && (e.error as Error).stack) || '')
})

window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  const r: any = (e as any).reason
  const msg = r && r.message ? String(r.message) : String(r)
  if (/applogWrite|ipcRenderer|contextBridge/i.test(msg)) return // 上报链自身的失败不再上报
  report('unhandledrejection', msg, r && r.stack ? String(r.stack) : '')
})

createApp(App).mount('#app')
