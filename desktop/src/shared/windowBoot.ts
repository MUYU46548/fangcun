/**
 * 启动时窗口怎么显示（2026-11-22）
 *
 * 事故：开机自启（HKCU Run 里写的是 `"方寸.exe" --autostart`）本该“只在托盘里，
 * 不弹主窗口”，真机却一解锁就出现一个最大化看板盖住桌面。
 *
 * 根因不是 `hidden` 没判，而是紧接着的 `mainWindow.maximize()`：
 * Electron 文档明写 —— **maximize() 会把尚未显示的窗口显示出来**（show but not focus）。
 * 于是 `show: false` 被这一行抹掉了，而且日志里看不出任何“我显示了自己”的痕迹。
 *
 * 所以规则是：**隐藏启动时，启动阶段一次显示动作都不许做**；
 * 用户第一次真正叫出窗口（托盘/任务栏）时再补最大化。
 *
 * 抽成纯函数是为了让本机 node 直接断言（e2e 不必起 Electron）。
 */

export interface WindowBootPlan {
  /** 启动时窗口是否保持隐藏（开机自启 / 渲染层 e2e 用隐藏窗口跑） */
  hidden: boolean
  /** 是否在创建窗口后立刻最大化（正常启动的既有行为） */
  maximizeNow: boolean
  /** 隐藏启动时，是否在“用户第一次真正要看它”时补最大化 */
  maximizeOnFirstShow: boolean
}

/** 开机自启写进启动项的参数；必须与 `main/services/autoStart.ts` 的 AUTOSTART_ARG 一致 */
export const AUTOSTART_ARG = '--autostart'

export function planWindowBoot(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): WindowBootPlan {
  const hidden = env.FC_E2E_RENDERER === '1' || argv.includes(AUTOSTART_ARG)
  return {
    hidden,
    maximizeNow: !hidden,
    maximizeOnFirstShow: hidden,
  }
}
