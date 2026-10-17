/**
 * 挂机提醒（2026-10-17 用户拍板四件补立项④）
 *
 * 治的病（9-07 借鉴清单 Super Productivity「idle 检测提醒」条）：用户让 agent 跑活，
 * 人长时间不回来看板——挂机回来该有一声轻提示，别让干完的活在琥珀色里晾着。
 *
 * 红线（写代码时不可回退）：
 *   1. **不进 notifier 的 7 类扫描定稿**（2026-10-01 用户原话「加一堆噪音很吵」）——
 *      独立机制：一次挂机最多弹一次（回来即重置），文案不带没查证的任务数（不撒谎）。
 *   2. 判定逻辑纯函数化（computeIdleAction）——主进程的 powerMonitor 不可云测，
 *      可测的都抽出去，测试只喂秒数。
 *   3. 开关关掉 = 完全不轮询（不只是不弹窗）；阈值下限 5 分钟（防误填 1 分钟变成骚扰）。
 *   4. 不写任务数据、不进通知中心数据库——只系统通知一条，弹完即止。
 */
import { powerMonitor, Notification } from 'electron'
import { getPref } from './prefs'

/** prefs 单键（嵌套对象 {enabled, thresholdMin}），与设置页 idleSave 写入侧同键 */
export const IDLE_PREF_KEY = 'idleReminder'
export const DEFAULT_THRESHOLD_MIN = 30
export const MIN_THRESHOLD_MIN = 5

export type IdleAction =
  | { kind: 'notify'; idleMinutes: number }
  | { kind: 'reset' }
  | null

/** 读设置：缺省=开+30min（每次轮询读一次 prefs.json，60s 一拍，量级同 notifier 扫描） */
export function readIdlePrefs(): { enabled: boolean; thresholdMin: number } {
  const p = getPref(IDLE_PREF_KEY) as { enabled?: boolean; thresholdMin?: number } | undefined
  return {
    enabled: p?.enabled !== false,
    thresholdMin: Math.max(MIN_THRESHOLD_MIN, Number(p?.thresholdMin) || DEFAULT_THRESHOLD_MIN),
  }
}

/** 纯函数：一轮轮询里给定状态算下一步动作。null=什么都不做。
 *  「回来了」判定=idleSeconds<5（轮询间隔 60s，人活跃时几乎必然踩中）。 */
export function computeIdleAction(opts: {
  enabled: boolean
  thresholdMin: number
  idleSeconds: number
  alreadyNotified: boolean
}): IdleAction {
  if (!opts.enabled) return null
  if (opts.idleSeconds < 5) {
    return opts.alreadyNotified ? { kind: 'reset' } : null
  }
  if (opts.alreadyNotified) return null
  const threshold = Math.max(MIN_THRESHOLD_MIN, opts.thresholdMin || DEFAULT_THRESHOLD_MIN)
  if (opts.idleSeconds >= threshold * 60) {
    return { kind: 'notify', idleMinutes: Math.floor(opts.idleSeconds / 60) }
  }
  return null
}

let timer: ReturnType<typeof setInterval> | null = null
let notified = false

/** 启动轮询（默认 60s 一拍；测试注入短间隔）。重复调用安全（先停旧的）。 */
export function startIdleReminder(intervalMs = 60_000): void {
  stopIdleReminder()
  notified = false
  timer = setInterval(() => {
    const { enabled, thresholdMin } = readIdlePrefs()
    let idle = 0
    try {
      idle = powerMonitor.getSystemIdleTime()
    } catch {
      return // powerMonitor 不可用（无桌面会话）就安静退场
    }
    const action = computeIdleAction({ enabled, thresholdMin, idleSeconds: idle, alreadyNotified: notified })
    if (action?.kind === 'notify') {
      notified = true
      const body = `离开 ${action.idleMinutes} 分钟了。回来时看一眼方寸——干完的活在等你验收，草稿在等你点头。`
      try {
        if (Notification.isSupported()) {
          new Notification({ title: '方寸 · 挂机提醒', body }).show()
        }
      } catch {
        // 通知失败不影响任何主流程
      }
    } else if (action?.kind === 'reset') {
      notified = false
    }
  }, intervalMs)
}

export function stopIdleReminder(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
