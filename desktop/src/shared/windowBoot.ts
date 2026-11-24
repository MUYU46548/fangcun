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

/** 「用户又点了一次图标」时要做的三个动作（纯函数，便于 node 直接断言） */
export interface SecondInstancePlan {
  /** 窗口存在但**不可见**时要先 show —— 隐藏窗口上 focus() 什么都不会发生 */
  show: boolean
  /** 被最小化了才需要 restore */
  restore: boolean
  /** 提到前台 */
  focus: boolean
}

/**
 * 用户再点一次图标（second-instance）该做什么（2026-11-24 修用户第 6 条）。
 *
 * 事故：暮雨「电脑开机后双击桌面快捷方式，五次都无法打开，一闪而过，之前的版本无此症状」。
 *
 * 真因不是"打不开"，是**打开了但你看不见**：
 *   ① 开机自启写的是 `方寸.exe --autostart`，按 2026-11-22 的口径它**只在托盘里，窗口 show:false**；
 *   ② 用户双击桌面快捷方式 → 第二个进程拿不到单实例锁 → 把 `second-instance` 事件发给第一个进程、自己退出
 *      （用户看到的就是"一闪而过"）；
 *   ③ 第一个进程的处理器只写了 `restore()` + `focus()` ——
 *      **对一个从未显示过的窗口，这两句什么都不会发生**（Electron 里 focus() 不会把窗口 show 出来）。
 *
 * 于是"叫出窗口"这条路只剩托盘图标；双击快捷方式等于白点。
 * 所以规则是：**不可见就先 show**（show 会触发 `maximizeOnFirstShow` 的回调，补上最大化）。
 *
 * ⚠ 为什么抽成纯函数：真窗口行为本机起不来 Electron 就验不了（e2e-renderer 常年 SKIP），
 *   而这条恰好是"逻辑写错一个布尔"的典型 —— 必须能在 node 里直接跑。
 */
export function planSecondInstance(isVisible: boolean, isMinimized: boolean): SecondInstancePlan {
  return {
    show: !isVisible,
    restore: !!isMinimized,
    focus: true,
  }
}
