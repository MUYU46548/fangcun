/**
 * 日志历史版本面板（2026-10-31 · 渲染层拆分第二批「日志动作收口」第九刀）
 *
 * 把 `atomicWrite` 本来就在写的 `.backup` 接出来：列表 / 逐版预览 / 恢复到任意一版。
 * 恢复前自动备份当前版（写路径在 logs.ts），恢复后重读表单并刷新列表。
 *
 * 依赖由调用方传入（logEdit_ / toast / 判脏 / 快照 / 刷新），不复制状态。
 */
import { ref, type Ref } from 'vue'
import { formatDateTime } from '../../shared/time'

interface Deps {
  logEdit_: Ref<any>
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void
  logEditDirty: () => boolean
  markLogSnap: () => void
  normalizeLogTaskIds: (log: any) => string[]
  loadLogs: () => Promise<void>
}

export function useLogHistory(deps: Deps) {
  const { logEdit_, showToast, logEditDirty, markLogSnap, normalizeLogTaskIds, loadLogs } = deps

  const logHistoryOpen = ref(false)
  const logVersions = ref<any[]>([])
  const logVersionPreview = ref<any>(null)
  const logVersionBusy = ref(false)

  function versionSizeText(n: any): string {
    const v = Number(n) || 0
    if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`
    if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`
    return `${v} B`
  }

  function resetLogHistory(): void {
    logHistoryOpen.value = false
    logVersions.value = []
    logVersionPreview.value = null
    logVersionBusy.value = false
  }

  async function toggleLogHistory(): Promise<void> {
    if (logHistoryOpen.value) { logHistoryOpen.value = false; return }
    const e = logEdit_.value
    if (!e?.id) return
    logHistoryOpen.value = true
    logVersionPreview.value = null
    logVersionBusy.value = true
    try {
      const vs: any = await window.tegula.logsVersions(e.id)
      logVersions.value = Array.isArray(vs) ? vs : []
    } catch (err: any) {
      logVersions.value = []
      showToast(`读取历史版本失败：${err?.message || err}`, 'error')
    } finally {
      logVersionBusy.value = false
    }
  }

  async function previewLogVersion(v: any): Promise<void> {
    const e = logEdit_.value
    if (!e?.id || !v?.file) return
    logVersionBusy.value = true
    try {
      const r: any = await window.tegula.logsVersionGet(e.id, v.file)
      if (!r?.ok) { showToast(`预览失败：${r?.error || '未知原因'}`, 'error'); return }
      logVersionPreview.value = r.data
    } catch (err: any) {
      showToast(`预览异常：${err?.message || err}`, 'error')
    } finally {
      logVersionBusy.value = false
    }
  }

  async function restoreLogVersionItem(v: any): Promise<void> {
    const e = logEdit_.value
    if (!e?.id || !v?.file) return
    const when = v.at ? formatDateTime(v.at) : '这个版本'
    const dirtyTip = logEditDirty() ? '\n\n⚠ 表单里还没保存的改动会被这一版覆盖。' : ''
    if (!confirm(`恢复到「${v.title || '(无标题)'}」（${when}）？\n\n标题 / 正文 / 下一步 / 状态都会回到那一版。\n当前版本会先自动备份，撤错了可以再恢复回来。${dirtyTip}`)) return
    try {
      const r: any = await window.tegula.logsRestoreVersion(e.id, v.file)
      if (!r?.ok) { showToast(`恢复失败：${r?.error || '未知原因'}`, 'error'); return }
      const fresh: any = await window.tegula.logsGet(e.id)
      if (fresh?.id) {
        logEdit_.value = { ...fresh, taskIds: normalizeLogTaskIds(fresh) }
        markLogSnap()
      }
      logHistoryOpen.value = false
      logVersionPreview.value = null
      showToast(`已恢复（回到 ${when} 那一版）`, 'success')
      await loadLogs()
    } catch (err: any) {
      showToast(`恢复异常：${err?.message || err}`, 'error')
    }
  }

  return {
    logHistoryOpen, logVersions, logVersionPreview, logVersionBusy,
    versionSizeText, resetLogHistory, toggleLogHistory, previewLogVersion, restoreLogVersionItem,
  }
}
