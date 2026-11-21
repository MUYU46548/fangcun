/**
 * 执行日志自动收口（2026-11-21 · 暮雨：“验收通过后日志没自动已读，还在挂着干扰我”）
 *
 * 问题现场：
 *   · 任务卡被用户点「完成」（验收签字）之后，挂着它的执行日志仍是「待处理」；
 *   · 下一轮开工时 `fangcun_context` 会把最新一条日志当成“上次做到哪”，
 *     于是**已经交完的活**还在指挥下一轮 —— 用户看到的感受就是“日志没已读，一直挂着”。
 *
 * 判据（刻意收得很窄，避免替用户做主）：
 *   ① 只在任务**真的进入终态**时触发（updateTask / moveStatus 的钩子）；
 *   ② 只看与该任务关联的日志；
 *   ③ 日志必须是 `active`（待处理）且**没有** running 标记（有人在跑就别动）；
 *   ④ 日志关联的**全部**任务都已是 完成/驳回 —— 只要还有一张没签，就不动；
 *   ⑤ 收口 = `completeLog`（状态改 completed + 写完成确认），**不删文件、不删正文**；
 *      用户可以随时「撤销完成」退回待处理。
 *
 * 不做的事：
 *   · 不自动归档（归档是用户的手）；
 *   · 不因为“驳回”就收口（驳回意味着要返工，日志还得留着）；
 *   · 不改日志的下一步/正文（那是上一棒的交接记录，不能替人擦掉）。
 */

import { readTask, setTaskTerminalHook, type Task } from '../data/tasks'
import * as logs from './logs'
import * as appLog from './appLog'

export interface AutoCloseResult {
  /** 本次被自动收口的日志 id */
  closed: string[]
  /** 关联任务里还没到终态的数量（>0 时不会收口，仅用于解释原因） */
  stillOpen: number
}

function isTerminal(status: string): boolean {
  return status === '完成' || status === '驳回'
}

/** 日志关联的任务 id（与 logs.ts 内部同口径：taskIds 优先，兼容单个 taskId）。 */
function linkedTaskIds(log: logs.LogEntry): string[] {
  if (Array.isArray(log.taskIds) && log.taskIds.length) return log.taskIds.filter(Boolean)
  return log.taskId ? [log.taskId] : []
}

/**
 * 检查一张卡关联的所有日志：如果某条日志的关联任务**全部**到终态，就把它收口。
 * 纯查询 + 收口，不依赖 GUI；主进程启动时由 `installLogAutoClose()` 挂到写盘路径上。
 */
export function autoCloseLogsForTask(taskId: string): AutoCloseResult {
  const closed: string[] = []
  let stillOpen = 0
  if (!taskId) return { closed, stillOpen }

  let candidates: logs.LogEntry[] = []
  try {
    candidates = logs.logsForTask(taskId)
  } catch (e: any) {
    appLog.warn('logs', '自动收口：读关联日志失败（本次跳过）', e?.message || String(e))
    return { closed, stillOpen }
  }

  for (const log of candidates) {
    // 已完成/已归档的不碰；“进行中”的不碰（有人正在跑，收口会把人撵走）。
    if (log.status !== 'active' || log.running) continue
    const ids = linkedTaskIds(log)
    if (!ids.length) continue

    let allDone = true
    for (const id of ids) {
      let status = ''
      try {
        const t: Task | null = readTask(id)
        status = String(t?.fm?.status || '')
      } catch {
        status = ''
      }
      if (!isTerminal(status)) { allDone = false; stillOpen++; break }
    }
    if (!allDone) continue

    const day = new Date().toISOString().slice(0, 10)
    const r = logs.completeLog(log.id, null, `关联任务已全部签收，${day} 自动收口（可撤销）`)
    if (r.ok) {
      closed.push(log.id)
      appLog.info('logs', `日志 ${log.id} 自动收口：关联任务已全部签收`)
    } else {
      appLog.warn('logs', `日志 ${log.id} 自动收口失败：${r.error || '未知原因'}`)
    }
  }
  return { closed, stillOpen }
}

/**
 * 安装到任务终态回调上。**只对「完成」生效**：
 * 驳回 = 要返工，日志还得接着用，不能当成“交接结束”。
 */
export function installLogAutoClose(): void {
  setTaskTerminalHook((task, nextStatus) => {
    if (nextStatus !== '完成') return
    autoCloseLogsForTask(task.id)
  })
}

/** 测试/退出用：卸载回调（避免测试之间互相污染）。 */
export function uninstallLogAutoClose(): void {
  setTaskTerminalHook(null)
}
