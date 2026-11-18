/**
 * 退出闸（2026-11-17 · 卡 p0-1「『不同意并退出』永远退不掉」）
 *
 * ## 为什么单独一个模块
 *
 * 方寸是**常驻托盘**的窗口应用：`mainWindow.on('close')` 里 `preventDefault()` + `hide()`
 * —— 关窗 ≠ 退出（这是设计，别改）。于是"想真退出"必须满足两个条件：
 *   ① `isQuitting = true`（否则 close 钩子继续把窗口藏起来）
 *   ② 再 `app.quit()`
 * 顺序反了等于什么都没做。
 *
 * 问题在于这两个条件原本都在 `src/index.ts` 里（模块级 `let`），
 * 而**渲染层拿不到它** —— preload 里一条退出通道都没有。
 * 用户点「不同意并退出」走 `window.close()` → 被防抖成 hide → 进程留在托盘 → "退不掉"。
 *
 * ## 为什么放在 `main/` 下
 *
 * `check-ipc-parity.cjs` 的主进程注册扫描**只扫 `src/main/`**。
 * 第一版我把 `guardedHandle('app:quitForReal')` 写在 `src/index.ts` 里 ——
 * 守卫当场报「② 僵尸通道 app:quitForReal —— 主进程未注册 handler」。
 * **那不是守卫误报**：它抓的正是"preload 暴露了但某条路径没注册"。
 * 所以状态与通道都落在这里，`index.ts` 只 import 状态。
 *
 * ⚠ 谁也别把 `isQuitting` 改回 `index.ts` 的模块级变量 —— 那样渲染层又够不着了。
 */

let _quitting = false

/** 是否已进入"真退出"流程（close 钩子据此决定 hide 还是放行） */
export function isQuitting(): boolean {
  return _quitting
}

/** 置位（退出前必须调，且必须在 `app.quit()` 之前） */
export function markQuitting(): void {
  _quitting = true
}

/** 给测试复位用 */
export function resetQuitting(): void {
  _quitting = false
}
