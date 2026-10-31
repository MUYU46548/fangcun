/**
 * 日志编辑器保存（2026-10-31 · 渲染层拆分第二批「日志动作收口」第四刀）
 *
 * 搬出来的是「保存 / 保存修改」两条写路径：
 *   · 字段集单源 `logFormUpdates`（普通保存、完成/归档前回写、保存修改共用）；
 *   · 完成/归档先全量回写字段，再走状态 —— 「确认完成」不等于丢改动；
 *   · 新建分支 flush 待挂附件：没挂上就**不关弹窗**，并把 id 写回表单避免重复创建；
 *   · 成功后统一 `closeLogNow()` 出清（表单 / 状态 / 快照 / 待挂附件）。
 *
 * 仍在 App 的：openLog / openNewLog / complete / archive / destroy —— 它们要碰
 * 列表选择与任务数据；本 composable 只负责「表单提交这一下」。
 */
import type { Ref } from 'vue'

interface Deps {
  logEdit_: Ref<any>
  logCompleting: Ref<boolean>
  logArchiveMode: Ref<boolean>
  logRetainDays: Ref<string>
  logRetainDefault: Ref<number>
  logNote: Ref<string>
  logPendingCount: Ref<number>
  normalizeLogTaskIds: (log: any) => string[]
  flushPendingAttach: (logId: string) => Promise<boolean>
  resetPendingAttach: () => void
  closeLogNow: () => void
  offerLogReopenUndo: (label: string, ids: string[], sources?: any[]) => void
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
  reload: () => Promise<void>
}

export function useLogEditorSave(deps: Deps) {
  const {
    logEdit_, logCompleting, logArchiveMode, logRetainDays, logRetainDefault, logNote,
    logPendingCount, normalizeLogTaskIds, flushPendingAttach, resetPendingAttach,
    closeLogNow, offerLogReopenUndo, toast, reload,
  } = deps

  /** 日志编辑弹窗 → logsUpdate 的全字段 updates（三处共用同一份字段集） */
  function logFormUpdates(e: any) {
    return {
      title: e.title,
      content: e.content,
      nextSteps: e.nextSteps,
      project: e.project,
      taskIds: normalizeLogTaskIds(e),
      sessionId: e.sessionId || '',
      agentName: e.agentName || '',
      prevAgentName: e.prevAgentName || '',
      logDate: e.logDate || '',
      priority: e.priority || '',
    }
  }

  async function saveLogEdit() {
    const e = logEdit_.value
    if (!e.title?.trim()) {
      toast('标题不能为空', 'error')
      return
    }
    try {
      // 完成/归档弹窗的表单照常可编辑 —— 必须先全量回写字段再走状态，
      // 否则「确认完成」会把弹窗里改的每一个字静默蒸发。
      // 此时日志状态还是 active（完成/归档入口只对未完成的日志出现），logsUpdate 不会被拒。
      if ((logCompleting.value || logArchiveMode.value) && e.id) {
        const up: any = await window.tegula.logsUpdate(e.id, logFormUpdates(e))
        if (up && !up.ok) {
          toast(`内容更新失败：${up.error || '未知原因'} —— ${logCompleting.value ? '完成' : '归档'}动作已中止，改动还在弹窗里`, 'error')
          return
        }
      }
      if (logCompleting.value) {
        // 用户填 0（永不清理）不能被 `|| 7` 吃掉。
        const parsed = parseInt(logRetainDays.value, 10)
        const rd = Number.isNaN(parsed) || parsed < 0 ? logRetainDefault.value : parsed
        const result = await window.tegula.logsComplete(e.id, rd, logNote.value || undefined)
        if (result.ok) {
          // 撤销条的文案已把"做了什么"说全；完成/归档只留撤销条，不再叠 toast。
          offerLogReopenUndo(rd > 0 ? `已标记完成（保留 ${rd} 天）：${e.title || e.id}` : `已标记完成（永不清理）：${e.title || e.id}`, [e.id], [e])
        } else {
          toast(`完成失败：${result.error || '未知原因'}`, 'error')
          return
        }
      } else if (logArchiveMode.value) {
        const result = await window.tegula.logsArchive(e.id, logNote.value || undefined)
        if (result.ok) {
          offerLogReopenUndo(`已归档：${e.title || e.id}`, [e.id], [e])
        } else {
          toast(`归档失败：${result.error || '未知原因'}`, 'error')
          return
        }
      } else if (e.id) {
        // 改了「项目」/「关联任务」/优先级等字段必须真回写，不能提示"已更新"却丢字段。
        const r: any = await window.tegula.logsUpdate(e.id, logFormUpdates(e))
        if (r && !r.ok) {
          toast(`更新失败：${r.error || '未知原因'}`, 'error')
          return
        }
        // 更新分支也要挂一次：新建时附件没挂上（留在弹窗里重试）走的就是这条路。
        if (logPendingCount.value) {
          const attached = await flushPendingAttach(e.id)
          if (!attached) { await reload(); return }
        } else {
          toast('已更新', 'success')
        }
      } else {
        // 新建：nextSteps / 关联任务 / 优先级 / Agent 等字段必须一起传。
        const r: any = await window.tegula.logsCreate(
          e.title, e.project, e.content, (e.taskIds || [])[0] || undefined,
          { sessionId: e.sessionId || '', agentName: e.agentName || '', prevAgentName: e.prevAgentName || '', logDate: e.logDate || '', taskIds: normalizeLogTaskIds(e), nextSteps: e.nextSteps || '', priority: e.priority || '' },
        )
        if (r && !r.ok) {
          toast(`创建失败：${r.error || '未知原因'}`, 'error')
          return
        }
        // 新建态暂存的附件在这里才真正落盘；有附件时以附件结果为主提示。
        const newLogId = String((r as any)?.data?.id || '')
        if (logPendingCount.value) {
          if (!newLogId) {
            toast('日志已创建，但没拿到它的 id —— 刚选的附件没挂上，请打开这条日志重新添加', 'error')
            resetPendingAttach()
          } else {
            // 先把 id 写回表单：附件没挂上时弹窗不关，再点保存必须走更新分支。
            e.id = newLogId
            const attached = await flushPendingAttach(newLogId)
            if (!attached) {
              await reload()   // 日志确实建成了，列表要跟上；弹窗留着，待挂清单也在
              return
            }
          }
        } else {
          toast('已创建', 'success')
        }
      }
      // 保存成功统一出清（表单 / 完成归档态 / 快照 / 待挂附件）。
      closeLogNow()
      await reload()
    } catch (err: any) {
      toast(`保存失败: ${err.message || err}`, 'error')
    }
  }

  /** 完成/归档弹窗里的「保存修改」：只回写表单字段，不碰状态。 */
  async function saveLogFieldsOnly() {
    const e = logEdit_.value
    if (!e || !e.id) return
    if (!e.title?.trim()) {
      toast('标题不能为空', 'error')
      return
    }
    try {
      const r: any = await window.tegula.logsUpdate(e.id, logFormUpdates(e))
      if (r && !r.ok) {
        toast(`保存失败：${r.error || '未知原因'}`, 'error')
        return
      }
      toast('已保存修改（状态未变）', 'success')
      closeLogNow()
      await reload()
    } catch (err: any) {
      toast(`保存失败: ${err.message || err}`, 'error')
    }
  }

  return { saveLogEdit, saveLogFieldsOnly }
}
