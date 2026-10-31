/**
 * 日志复制 / 置顶 / 改归属（2026-10-31 · 渲染层拆分第二批「日志辅助动作收口」第二刀）
 *
 * 搬出来的是右键菜单背后的那组动作：
 *   · 复制全文 / 带元信息 / 复制为提示词 / 多条拼开工单 / 复制并标记已派；
 *   · 置顶（pinned 字段）；
 *   · 改项目归属（应用内轻浮层，不用 window.prompt）。
 *
 * 右键菜单状态本身（ctxOther / openLogMenu）留在 App —— 它同时服务任务卡与列菜单。
 */
import { ref, type Ref } from 'vue'
import { toPlain } from '../../shared/plain'

interface Deps {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void
  loadLogs: () => Promise<void>
  copyWithToast: (text: unknown, okMsg: string) => Promise<boolean>
}

export function useLogAux(deps: Deps) {
  const { showToast, loadLogs, copyWithToast } = deps

  const logProjectPicker = ref<any>(null)

  /** 日志正文（标题 + 执行内容 + 下一步）——「复制全文」用 */
  function logFullText(log: any): string {
    const parts = [String(log.title || '')]
    if (log.content) parts.push(String(log.content))
    if (log.nextSteps) parts.push('## 下一步\n' + String(log.nextSteps))
    return parts.filter(Boolean).join('\n\n')
  }

  /** 带元信息：`[日期] [项目] 标题` + 正文 —— 粘进开发日志/派工卡不用手动补头 */
  function logMetaText(log: any): string {
    const date = (log.logDate || log.created || '').slice(0, 10) || '—'
    const proj = log.project ? `[${log.project}]` : '[无项目]'
    return `[${date}] ${proj} ${String(log.title || '')}\n\n${logFullText(log)}`
  }

  async function copyLogFull(log: any): Promise<void> {
    await copyWithToast(logFullText(log), '已复制全文')
  }

  async function copyLogMeta(log: any): Promise<void> {
    await copyWithToast(logMetaText(log), '已复制（带日期 + 项目标签）')
  }

  /**
   * 复制并标记已派：「已派」= 这条正在跑，走手动开「进行中」那条路（logsSetRunning）。
   * 不能走 logsReopen —— 那会把 active 变成「待处理」，等于"复制一下反而标记成没在跑"。
   */
  async function copyAndDispatchLog(log: any): Promise<void> {
    const ok = await copyWithToast(logMetaText(log), '已复制并标记已派（这条已置为「进行中」）')
    if (!ok) return
    if (log.running) return
    const r: any = await window.tegula.logsSetRunning(log.id, true)
    if (r && r.ok) await loadLogs()
    else showToast(`已复制，但标记「进行中」失败：${(r && r.error) || '未知原因'}`, 'error')
  }

  async function toggleLogPin(log: any): Promise<void> {
    const t: any = window.tegula
    if (typeof t.logsSetPinned !== 'function') { showToast('当前主进程是旧版本，没有置顶通道 —— 托盘右键「退出」后重开', 'error'); return }
    const r: any = await t.logsSetPinned(log.id, !log.pinned)
    if (r && r.ok) {
      showToast(log.pinned ? '已取消置顶' : '已置顶', 'success')
      await loadLogs()
    } else {
      showToast(`置顶失败：${(r && r.error) || '未知原因'}`, 'error')
    }
  }

  /** 改项目归属：刻意不用 window.prompt —— Electron 不实现它 */
  function changeLogProject(log: any): void {
    const t: any = window.tegula
    if (typeof t.logsSetProject !== 'function') { showToast('当前主进程是旧版本，没有改归属通道', 'error'); return }
    logProjectPicker.value = log
  }

  async function applyLogProject(projectId: string): Promise<void> {
    const log = logProjectPicker.value
    if (!log) return
    logProjectPicker.value = null
    const r: any = await window.tegula.logsSetProject(log.id, String(projectId || '').trim())
    if (r && r.ok) {
      showToast(projectId ? `已改归属：${projectId}` : '已清空归属', 'success')
      await loadLogs()
    } else {
      showToast(`改归属失败：${(r && r.error) || '未知原因'}`, 'error')
    }
  }

  async function copyLogAsPrompt(id: string): Promise<void> {
    try {
      const text: any = await window.tegula.logsInject(id)
      if (!text) { showToast('这条日志注入不了（可能已被销毁或归档）', 'error'); return }
      console.warn('[renderer:copy] logs:inject id=' + id + ' len=' + String(text).length)
      await copyWithToast(String(text), '已复制为提示词，可直接粘给 agent')
    } catch (e: any) {
      showToast('复制失败：' + (e?.message || e), 'error')
    }
  }

  /** 多条日志 → 一份开工单（顺序即语义：先勾选的那条是主日志） */
  async function copyLogsAsPrompt(idsIn: string[]): Promise<void> {
    const ids = (Array.isArray(idsIn) ? idsIn : []).map((x) => String(x || '')).filter(Boolean)
    if (!ids.length) { showToast('先勾选要灌的日志（第一条当主日志）', 'info'); return }
    try {
      const r: any = await window.tegula.logsInjectMany(toPlain(ids))
      if (!r || !r.text) { showToast('这些日志都读不出来（可能已被销毁）', 'error'); return }
      console.warn('[renderer:copy] logs:injectMany n=' + ids.length + ' len=' + String(r.text).length)
      const n = Array.isArray(r.found) ? r.found.length : ids.length
      const miss = Array.isArray(r.missing) ? r.missing.length : 0
      const copied = await copyWithToast(
        String(r.text),
        n > 1 ? `已复制 ${n} 条日志为一份开工单（第一条主日志，其余标「并行日志」）` : '已复制为提示词，可直接粘给 agent',
      )
      if (!copied) return
      if (miss) showToast(`另有 ${miss} 条没找到，已跳过`, 'info')
    } catch (e: any) {
      showToast('复制失败：' + (e?.message || e), 'error')
    }
  }

  return {
    logProjectPicker,
    logFullText, logMetaText, copyLogFull, copyLogMeta, copyAndDispatchLog,
    toggleLogPin, changeLogProject, applyLogProject, copyLogAsPrompt, copyLogsAsPrompt,
  }
}
