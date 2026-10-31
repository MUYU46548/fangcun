/**
 * 日志编辑器的防丢守卫（2026-10-31 · 渲染层拆分第二批「日志动作收口」第三刀）
 *
 * 搬出来的是「打开时拍快照 → 关闭时逐字段比对 → 条子点名改了什么」这一整条：
 *   · 字符串快照判脏（含完成/归档弹窗里的保留天数、备注、批量标记、待挂附件）；
 *   · 结构化快照负责在警告条里点名；
 *   · 第一次点取消/遮罩只出条不关，唯一丢弃入口是条上的「丢弃并关闭」。
 *
 * 仍在 App 的：openLog / saveLogEdit / complete / archive / destroy —— 它们要碰 IPC、
 * 任务数据和列表刷新。本 composable 只管「还没保存的改动不许静默丢」。
 */
import { nextTick, ref, type Ref } from 'vue'
import { snapOf } from '../dirtyGuard'

interface Deps {
  logEdit_: Ref<any>
  logCompleting: Ref<boolean>
  logArchiveMode: Ref<boolean>
  logRetainDays: Ref<string>
  logNote: Ref<string>
  logBatchMode: Ref<boolean>
  logPendingCount: Ref<number>
  resetPendingAttach: () => void
  normalizeLogTaskIds: (log: any) => string[]
}

const LOG_FIELD_LABELS: Record<string, string> = {
  title: '标题', content: '执行内容', nextSteps: '下一步', project: '项目', taskIds: '关联任务',
  sessionId: '会话 ID', agentName: '执行 Agent', prevAgentName: '上次执行 Agent',
  logDate: '日志日期', note: '备注', retain: '保留天数',
}

export function useLogEditGuard(deps: Deps) {
  const {
    logEdit_, logCompleting, logArchiveMode, logRetainDays, logNote,
    logBatchMode, logPendingCount, resetPendingAttach, normalizeLogTaskIds,
  } = deps

  const logDiscard_ = ref(false)
  let logEditSnap: string | null = null
  let logSnapFields: Record<string, string> | null = null

  /** 日志编辑器快照：表单本体 + 完成/归档对话框里的「保留天数/备注/批量」 */
  const logSnapNow = (): string => JSON.stringify({
    form: snapOf(logEdit_.value),
    note: String(logNote.value ?? ''),
    retain: String(logRetainDays.value ?? ''),
    batch: !!logBatchMode.value,
  })

  function logEditDirty(): boolean {
    // 待挂附件还没落盘 —— 关掉就没了，所以它本身就是"脏"。
    if (logPendingCount.value > 0) return true
    if (logEditSnap !== null) return logSnapNow() !== logEditSnap
    return !!logEdit_.value && ['title', 'content', 'nextSteps'].some(k => String(logEdit_.value[k] ?? '').trim())
  }

  function closeLogEditor(): void {
    if (logEditDirty()) {
      if (!logDiscard_.value) {
        logDiscard_.value = true
        nextTick(() => {
          // 模板已搬进 LogEditModal：按弹窗内唯一钩子查，而不是 ref。
          const bar = document.querySelector('#log-edit-modal .relay-discard') as HTMLElement | null
          if (!bar) return
          try { bar.scrollIntoView({ block: 'nearest' }) } catch { /* 老 Chromium：不支持 options */ }
          const keep = bar.querySelector('button') as HTMLButtonElement | null
          keep?.focus()
        })
        console.warn(`[logEdit] 关闭被拦下：未保存的改动（${logDirtyNames().join('、') || '表单改动'}），等用户选择丢弃或继续填写`)
      }
      return
    }
    closeLogNow()
  }

  /** 真正关窗：保存成功 / 销毁 / 丢弃确认共用这一条出清路径 */
  function closeLogNow(): void {
    logEdit_.value = null
    logCompleting.value = false
    logArchiveMode.value = false
    logEditSnap = null
    logSnapFields = null
    logDiscard_.value = false
    // 待挂附件跟着窗一起出清：没保存的日志不该在磁盘上留孤儿目录
    resetPendingAttach()
  }

  /** 条上的「丢弃并关闭」——唯一丢弃入口 */
  function discardLogEdit(): void {
    console.warn(`[logEdit] 用户确认丢弃未保存的日志改动（${logDirtyNames().join('、') || '无'}）`)
    closeLogNow()
  }

  /** 结构化快照：字符串快照负责判脏，结构化快照负责点名改了什么 */
  function markLogSnap(): void {
    logEditSnap = logSnapNow()
    const f = logEdit_.value
    logSnapFields = f ? {
      title: String(f.title ?? ''),
      content: String(f.content ?? ''),
      nextSteps: String(f.nextSteps ?? ''),
      project: String(f.project ?? ''),
      taskIds: normalizeLogTaskIds(f).join(','),
      sessionId: String(f.sessionId ?? ''),
      agentName: String(f.agentName ?? ''),
      prevAgentName: String(f.prevAgentName ?? ''),
      logDate: String(f.logDate ?? ''),
      note: String(logNote.value ?? ''),
      retain: String(logRetainDays.value ?? ''),
    } : null
  }

  /** 相对打开时的快照逐字段点名（与接力 relayChanges 同构） */
  function logDirtyNames(): string[] {
    const f = logEdit_.value
    const s = logSnapFields
    if (!f || !s) return []
    const now: Record<string, string> = {
      title: String(f.title ?? ''),
      content: String(f.content ?? ''),
      nextSteps: String(f.nextSteps ?? ''),
      project: String(f.project ?? ''),
      taskIds: normalizeLogTaskIds(f).join(','),
      sessionId: String(f.sessionId ?? ''),
      agentName: String(f.agentName ?? ''),
      prevAgentName: String(f.prevAgentName ?? ''),
      logDate: String(f.logDate ?? ''),
      note: String(logNote.value ?? ''),
      retain: String(logRetainDays.value ?? ''),
    }
    return Object.keys(s).filter(k => now[k] !== s[k]).map(k => LOG_FIELD_LABELS[k] || k)
      // 待挂附件不是"字段"，但它同样会丢 —— 提示条里必须点名
      .concat(logPendingCount.value ? [`待挂的 ${logPendingCount.value} 个附件`] : [])
  }

  return { logDiscard_, logEditDirty, closeLogEditor, closeLogNow, discardLogEdit, markLogSnap, logDirtyNames }
}
