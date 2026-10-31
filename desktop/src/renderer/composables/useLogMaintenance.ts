/**
 * 日志维护动作（2026-10-31 · 渲染层拆分第二批「日志动作收口」第二刀）
 *
 * 搬出来的是**批量 + 按日期清理**这一组无 UI 的维护动作：
 *   · 全选当前可见日志；批量完成 / 归档 / 销毁（带撤销条）；批量改优先级；
 *   · 清理已归档日志：日期默认值、预览（dryRun）、执行（软删进 .trash）。
 *
 * 依赖由调用方传入：批量选择、可见列表、多选态、toast、刷新、撤销条。
 * 编辑表单（open/save）与互转/导入导出仍留在 App —— 它们要碰弹窗与任务数据。
 */
import { computed, ref, type Ref } from 'vue'

interface Deps {
  selectedLogBatch: Ref<string[]>
  visibleLogs: Ref<any[]>
  logBatchMode: Ref<boolean>
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
  reload: () => Promise<void>
  offerLogReopenUndo: (title: string, ids: string[]) => void
}

export function useLogMaintenance(deps: Deps) {
  const { selectedLogBatch, visibleLogs, logBatchMode, toast, reload, offerLogReopenUndo } = deps

  function toggleSelectAllLogs() {
    if (selectedLogBatch.value.length === visibleLogs.value.length) {
      selectedLogBatch.value = []
    } else {
      selectedLogBatch.value = visibleLogs.value.map((l: any) => l.id)
    }
  }

  async function executeBatchLogComplete() {
    const ids = [...selectedLogBatch.value]
    if (ids.length === 0) return
    if (!confirm(`批量完成 ${ids.length} 条日志？`)) return
    let ok = 0
    const done: string[] = []
    for (const id of ids) {
      try {
        const r = await window.tegula.logsComplete(id, 7, '')
        if (r?.ok) { ok++; done.push(id) }
      } catch { /* skip */ }
    }
    // 成功时不另发 toast（撤销条就是提示）；失败仍要说，否则人以为全成了。
    if (ok < ids.length) toast(`已批量完成 ${ok}/${ids.length} 条日志`, ok ? 'info' : 'error')
    // ⚠ 撤的是**真成功的那几条**（done），不是 ids.slice(0, ok) —— 中间失败时下标对不上。
    if (done.length) offerLogReopenUndo(`已批量完成 ${ok} 条日志`, done)
    selectedLogBatch.value = []
    logBatchMode.value = false
    void reload()
  }

  async function executeBatchLogArchive() {
    const ids = [...selectedLogBatch.value]
    if (ids.length === 0) return
    if (!confirm(`批量归档 ${ids.length} 条日志？`)) return
    let ok = 0
    const done: string[] = []
    for (const id of ids) {
      try {
        const r = await window.tegula.logsArchive(id)
        if (r?.ok) { ok++; done.push(id) }
      } catch { /* skip */ }
    }
    if (ok < ids.length) toast(`已批量归档 ${ok}/${ids.length} 条日志`, ok ? 'info' : 'error')
    if (done.length) offerLogReopenUndo(`已批量归档 ${ok} 条日志`, done)
    selectedLogBatch.value = []
    logBatchMode.value = false
    void reload()
  }

  async function executeBatchLogDestroy() {
    const ids = [...selectedLogBatch.value]
    if (ids.length === 0) return
    if (!confirm(`批量销毁 ${ids.length} 条日志？文件将被永久删除。`)) return
    let ok = 0
    for (const id of ids) {
      try {
        const r = await window.tegula.logsDestroy(id)
        if (r?.ok) ok++
      } catch { /* skip */ }
    }
    toast(`已批量销毁 ${ok}/${ids.length} 条日志`, ok ? 'success' : 'error')
    selectedLogBatch.value = []
    logBatchMode.value = false
    void reload()
  }

  /**
   * 批量改优先级（2026-10-09 用户第 4 条）。与完成/归档不同：
   * ① 不弹确认（改元数据可逆）；② 做完**不退出多选**（连着调几档是正常用法）。
   * updateLog 只放行「待处理」态 → 成功/跳过如实报数，不静默。
   */
  async function executeBatchLogPriority(ev: Event) {
    const sel = ev.target as HTMLSelectElement
    const val = sel.value
    sel.value = ''                       // 用完即复位（占位项重新可见）
    const ids = [...selectedLogBatch.value]
    if (!val || !ids.length) return
    const prio = val === '__clear__' ? '' : val
    let ok = 0
    for (const id of ids) {
      try {
        const r = await window.tegula.logsUpdate(id, { priority: prio })
        if (r?.ok) ok++
      } catch { /* 拒改/异常都算跳过，下面统一报数 */ }
    }
    const skip = ids.length - ok
    toast(skip
      ? `优先级已更新 ${ok}/${ids.length} 条（${skip} 条跳过：非「待处理」不可改）`
      : `已给 ${ok} 条日志设优先级「${prio || '不标'}」`, ok ? 'success' : 'error')
    void reload()                        // 选择与多选模式都保留（元数据批量不踢人）
  }

  // ── 按日期清理「已归档」日志 ────────────────────────────────────────
  // 与「批量彻底删除」分工：那个要逐条勾选且硬删；这个按日期一把筛且软删（进 .trash）。
  // 流程强制两步：先 dryRun 预览命中条数 → 再确认执行。
  const logPurgeOpen = ref(false)
  const logPurgeDate = ref('')
  const logPurgePreview = ref<{ count: number; ids: string[]; titles: string[] } | null>(null)
  const logPurgeBusy = ref(false)

  /** 默认「早于 30 天」；仍是用户显式点「确认清理」才动手。 */
  function defaultLogPurgeDate(daysAgo = 30): string {
    const d = new Date()
    d.setDate(d.getDate() - daysAgo)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  function openLogPurge() {
    logPurgeDate.value = defaultLogPurgeDate(30)
    logPurgePreview.value = null
    logPurgeOpen.value = true
  }
  function closeLogPurge() { logPurgeOpen.value = false }
  /** 改了日期就作废旧预览 —— 否则「预览 71 条」和「按新日期删」对不上，是假成功。 */
  function resetLogPurgePreview() { logPurgePreview.value = null }

  async function runLogPurgePreview() {
    const before = String(logPurgeDate.value || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) { toast('请选择有效日期', 'error'); return }
    logPurgeBusy.value = true
    try {
      const r: any = await (window as any).tegula?.logsPurgeArchived?.(before, { dryRun: true })
      if (!r?.ok) { toast(`预览失败：${r?.error || '未知原因'}`, 'error'); return }
      logPurgePreview.value = { count: r.count || 0, ids: r.ids || [], titles: r.titles || [] }
    } catch (e: any) {
      toast(`预览失败：${e?.message || e}`, 'error')
    } finally {
      logPurgeBusy.value = false
    }
  }

  async function executeLogPurge() {
    const before = String(logPurgeDate.value || '').slice(0, 10)
    const pv = logPurgePreview.value
    if (!pv) return
    if (!pv.count) { toast('没有早于该日期的归档日志', 'info'); closeLogPurge(); return }
    if (!confirm(`确认清理 ${pv.count} 条归档日志？\n文件会移进回收站（docs/执行日志/.trash/），可手动找回。`)) return
    logPurgeBusy.value = true
    try {
      const r: any = await (window as any).tegula?.logsPurgeArchived?.(before, { dryRun: false })
      if (r?.ok) {
        toast(`已清理 ${r.count} 条归档日志（可恢复）`, 'success')
        closeLogPurge()
        await reload()
      } else {
        toast(`清理失败：${r?.error || '未知原因'}`, 'error')
      }
    } catch (e: any) {
      toast(`清理失败：${e?.message || e}`, 'error')
    } finally {
      logPurgeBusy.value = false
    }
  }

  return {
    toggleSelectAllLogs,
    executeBatchLogComplete, executeBatchLogArchive, executeBatchLogDestroy, executeBatchLogPriority,
    logPurgeOpen, logPurgeDate, logPurgePreview, logPurgeBusy,
    openLogPurge, closeLogPurge, resetLogPurgePreview, runLogPurgePreview, executeLogPurge,
  }
}
