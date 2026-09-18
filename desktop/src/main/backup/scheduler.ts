/**
 * 备份调度器 — 静默执行，但绝不静默失败
 *
 * 行为：
 *  - 应用启动后 firstDelayMinutes 做首次备份，之后每 intervalHours 一次
 *  - 同一时刻只允许一个备份在跑（重入直接跳过并记账）
 *  - 每次结束都把状态广播给所有窗口，失败时状态栏显红；连续失败叠加系统通知
 *  - 用 setTimeout 递归而非 setInterval，确保长任务不会堆叠
 */
import { BrowserWindow, Notification } from 'electron'
import { getBackupConfig, getBackupState, appendBackupLog, BackupState } from './config'
import { runBackup, RunResult } from './index'

let timer: NodeJS.Timeout | null = null
let running = false
let nextRunAt: string | null = null
let lastSummary: string | null = null
let lastFailNotifiedStreak = 0

const FAIL_NOTIFY_THRESHOLD = 2

export interface BackupStatus {
  enabled: boolean
  intervalHours: number
  firstDelayMinutes: number
  running: boolean
  nextRunAt: string | null
  lastSummary: string | null
  remoteConfigured: boolean
  state: BackupState
}

export function getBackupStatus(): BackupStatus {
  const cfg = getBackupConfig()
  return {
    enabled: cfg.enabled && cfg.intervalHours > 0,
    intervalHours: cfg.intervalHours,
    firstDelayMinutes: cfg.firstDelayMinutes,
    running,
    nextRunAt,
    lastSummary,
    remoteConfigured: !!cfg.remote.url,
    state: getBackupState(),
  }
}

function broadcast(): void {
  const payload = getBackupStatus()
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('backup:status', payload) } catch { /* 窗口可能正在关闭 */ }
  }
}

function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body, silent: false }).show()
  } catch { /* 通知失败不影响主流程 */ }
}

function scheduleNext(explicitDelayMs?: number): void {
  if (timer) { clearTimeout(timer); timer = null }
  const cfg = getBackupConfig()
  if (!cfg.enabled || cfg.intervalHours <= 0) {
    nextRunAt = null
    return
  }
  const delay = explicitDelayMs ?? cfg.intervalHours * 3600 * 1000
  nextRunAt = new Date(Date.now() + delay).toISOString()
  timer = setTimeout(() => { void tick('scheduled') }, Math.max(0, delay))
  if (typeof timer.unref === 'function') timer.unref()
}

async function tick(trigger: 'manual' | 'scheduled' | 'startup'): Promise<RunResult | null> {
  if (running) {
    appendBackupLog(`SKIP trigger=${trigger} 上一次备份尚未结束`)
    return null
  }
  running = true
  broadcast()
  let result: RunResult | null = null
  try {
    result = await runBackup({ trigger })
    if (result.ok) {
      lastSummary = `成功 · ${result.files} 个文件 · ${(result.rawBytes / 1024).toFixed(0)} KB` +
        (result.remotePath ? ' · 已上云' : result.warnings.length ? ' · 仅本地' : '')
      lastFailNotifiedStreak = 0
    } else {
      const first = result.errors[0] || '未知错误'
      lastSummary = `失败 · ${first}`
      const st = getBackupState()
      // 远端失败但本地成功：属于部分成功，同样要显性告警
      if (result.partial) lastSummary = `部分成功 · 本地已备份，云端失败：${first}`
      if (st.failStreak >= FAIL_NOTIFY_THRESHOLD && st.failStreak > lastFailNotifiedStreak) {
        lastFailNotifiedStreak = st.failStreak
        notify('方寸备份失败', `${st.failStreak} 次连续失败：${first}`)
      }
    }
  } catch (e) {
    lastSummary = `异常 · ${(e as Error).message}`
    appendBackupLog(`THROW trigger=${trigger} ${(e as Error).message}`)
  } finally {
    running = false
    scheduleNext()
    broadcast()
  }
  return result
}

/** 手动触发（IPC 用），会重置下一次定时 */
export async function runBackupNow(): Promise<RunResult | null> {
  return tick('manual')
}

export function startScheduler(): void {
  stopScheduler()
  const cfg = getBackupConfig()
  if (!cfg.enabled || cfg.intervalHours <= 0) {
    appendBackupLog('自动备份未启用（enabled=false 或 intervalHours=0）')
    broadcast()
    return
  }
  const delayMs = Math.max(0, cfg.firstDelayMinutes) * 60 * 1000
  scheduleNext(delayMs)
  appendBackupLog(`调度已启动：${cfg.firstDelayMinutes} 分钟后首次，之后每 ${cfg.intervalHours} 小时`)
  broadcast()
}

export function stopScheduler(): void {
  if (timer) { clearTimeout(timer); timer = null }
  nextRunAt = null
}

/** 配置变更后调用：按新配置重排 */
export function rescheduleScheduler(): void {
  startScheduler()
}
