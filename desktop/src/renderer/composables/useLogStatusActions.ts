/**
 * 日志状态动作（2026-10-31 · 渲染层拆分第二批「日志动作收口」第五刀）
 *
 * 搬出来的是「改一条日志状态」这一组：
 *   · 进行中开关（主日志卡 = 全组开关；单条走唯一写入路径 logsSetRunning）；
 *   · 完成 / 归档入口（只打开对应弹窗，真正保存仍走 useLogEditorSave）；
 *   · 撤销完成/归档（带状态快照，撤销本身也能再撤）；
 *   · 彻底销毁（二次确认、不可撤销）。
 *
 * 仍在 App 的：openLog / openNewLog（打开表单）、互转、导入导出。
 */
import type { Ref } from 'vue'

interface Deps {
  logs: Ref<any[]>
  logEdit_: Ref<any>
  logBatchMode: Ref<boolean>
  logCompleting: Ref<boolean>
  logArchiveMode: Ref<boolean>
  logRetainDays: Ref<string>
  logRetainDefault: Ref<number>
  logNote: Ref<string>
  previewTask: Ref<any>
  resetLogHistory: () => void
  markLogSnap: () => void
  normalizeLogTaskIds: (log: any) => string[]
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void
  loadLogs: () => Promise<void>
  loadLogsForTask: (taskId: string) => Promise<void>
  offerUndo: (label: string, fn: () => Promise<void>) => void
  offerLogReopenUndo: (label: string, ids: string[], sources?: any[]) => void
  toggleLogGroupRunning: (main: any, running: boolean) => Promise<void>
  logHasGroup: (log: any) => boolean
  logGroupAllRunning: (log: any) => boolean
}

export function useLogStatusActions(deps: Deps) {
  const {
    logs, logEdit_, logBatchMode, logCompleting, logArchiveMode, logRetainDays,
    logRetainDefault, logNote, previewTask, resetLogHistory, markLogSnap,
    normalizeLogTaskIds, showToast, loadLogs, loadLogsForTask, offerUndo,
    offerLogReopenUndo, toggleLogGroupRunning, logHasGroup, logGroupAllRunning,
  } = deps

  /**
   * 手动开 / 关「进行中」——「进行中」的唯一入口。
   * ⚠ 必须 offerUndo：任何改状态的动作要么顶掉旧撤销条，要么清掉，不许留着旧条装没事。
   */
  async function toggleLogRunning(log: any): Promise<void> {
    // 主日志卡上的运行开关**就是全组开关**；单条控制在主日志框里。
    if (logHasGroup(log)) {
      await toggleLogGroupRunning(log, !logGroupAllRunning(log))
      return
    }
    const next = !log.running
    const r: any = await window.tegula.logsSetRunning(log.id, next)
    if (r && r.ok) {
      showToast(next ? '已标为「进行中」' : '已撤销「进行中」，回到待处理', 'success')
      await loadLogs()
      // 撤销 = 再点一次同一个开关（唯一写入路径），并把列表刷回真值。
      offerUndo(
        `${next ? '已标为「进行中」' : '已撤销「进行中」'}：${log.title || log.id}`,
        async () => {
          const back: any = await window.tegula.logsSetRunning(log.id, !next)
          if (!back?.ok) throw new Error(back?.error || '未知原因')
          await loadLogs()
          showToast(next ? '已撤销「进行中」，回到待处理' : '已标为「进行中」', 'success')
        },
      )
    } else {
      showToast(`操作失败：${(r && r.error) || '未知原因'}`, 'error')
    }
  }

  function completeLogItem(id: string) {
    const log = logs.value.find(l => l.id === id)
    if (!log) return
    logEdit_.value = { ...log, taskIds: normalizeLogTaskIds(log) }
    resetLogHistory()
    logCompleting.value = true
    logArchiveMode.value = false
    logRetainDays.value = String(logRetainDefault.value)
    logNote.value = ''
    logBatchMode.value = false
    markLogSnap()   // 只填「备注」也要算改动，别静默丢
  }

  function archiveLogItem(id: string) {
    const log = logs.value.find(l => l.id === id)
    if (!log) return
    logEdit_.value = { ...log, taskIds: normalizeLogTaskIds(log) }
    resetLogHistory()
    logCompleting.value = false
    logArchiveMode.value = true
    logRetainDays.value = String(logRetainDefault.value)
    logNote.value = ''
    logBatchMode.value = false
    markLogSnap()
  }

  /**
   * 撤销「完成 / 归档」，退回**待处理**。
   * 撤销只回到待处理；要不要「进行中」由 toggleLogRunning 单独决定。
   */
  async function reopenLogItem(id: string) {
    // 撤销本身也要能撤 —— 点错「↩ 撤销」不该比误点更惨。
    const before = logs.value.find((l: any) => l.id === id)
    const snap = before ? {
      status: before.status, running: !!before.running, agentDone: !!before.agentDone,
      completed: before.completed || null, retainDays: before.retainDays ?? null,
      retainUntil: before.retainUntil || null, note: before.note || '', archiveNote: before.archiveNote || '',
    } : null
    const title = String(before?.title || id)
    const r: any = await window.tegula.logsReopen(id)
    if (r && r.ok) {
      showToast('已撤销，回到「待处理」', 'success')
      await loadLogs()
      // 任务详情的「关联日志」列表是另一份数据源，两边都要刷
      await loadLogsForTask(previewTask.value?.id || '')
      if (snap) {
        offerUndo(`已撤销「${title}」`, async () => {
          const back: any = await window.tegula.logsRestoreState(id, snap)
          if (!back?.ok) throw new Error(back?.error || '未知原因')
          await loadLogs()
          await loadLogsForTask(previewTask.value?.id || '')
          showToast('已恢复撤销前的状态', 'success')
        })
      }
    } else {
      showToast(`撤销失败：${(r && r.error) || '未知原因'}`, 'error')
    }
  }

  async function destroyLogItem(id: string) {
    if (!confirm('确定销毁此日志？文件将被永久删除。')) return
    const result = await window.tegula.logsDestroy(id)
    if (result.ok) {
      showToast('已销毁', 'success')
      await loadLogs()
    } else {
      showToast(`销毁失败：${result.error || '未知原因'}`, 'error')
    }
  }

  return { toggleLogRunning, completeLogItem, archiveLogItem, reopenLogItem, destroyLogItem }
}
