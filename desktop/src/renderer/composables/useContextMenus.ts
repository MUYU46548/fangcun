/**
 * 日志 / 待办 / 看板列 的右键菜单状态（2026-10-31 · 渲染层拆分第二批「日志辅助动作收口」第三刀）
 *
 * 搬出来的是「谁被右键、菜单开在哪、点完怎么关」这一层：
 *   · ctxOther 单一状态（kind = log / todo / column）；
 *   · openLogMenu / openTodoMenu / openColumnMenu；
 *   · 菜单项执行器 ctxOtherRun（先关菜单再执行）与列菜单「在此列新建任务」；
 *   · 日志菜单里的编辑 / 彻底删除。
 *
 * 菜单模板与各动作本体仍在 App —— 它们要碰对应领域的数据与弹窗。
 */
import { ref, type Ref } from 'vue'

interface Deps {
  curView: Ref<string>
  openNew: () => void
  editTask_: Ref<any>
  openLog: (log: any) => void
  destroyLogItem: (id: string) => void
}

export function useContextMenus(deps: Deps) {
  const { curView, openNew, editTask_, openLog, destroyLogItem } = deps

  const ctxOther = ref<{ x: number; y: number; kind: 'log' | 'todo' | 'column'; item: any } | null>(null)

  /**
   * 看板分区空白处右键 → 「在此列新建任务」。
   * 两条边界：① 指针落在任务卡上就放行给卡片自己的右键菜单；
   * ② 归档区不弹「新建」（新建出来的是活动任务，在归档页语义不通）。
   */
  function openColumnMenu(e: MouseEvent, status: string): void {
    if (curView.value !== 'active') return
    const t = e.target as HTMLElement | null
    // ⚠ 卡片区域内一律放行：否则卡片的 reka 右键菜单会被"列菜单"顶掉。
    if (t && (t.closest('[data-id]') || t.closest('.ctx-menu'))) return
    e.preventDefault()
    ctxOther.value = { x: e.clientX, y: e.clientY, kind: 'column', item: { status } }
  }

  /** 右键列 → 新建任务，状态预选成点的那一列 */
  function newTaskInColumn(item: { status: string }): void {
    openNew()
    if (editTask_.value) editTask_.value.status = item.status
  }

  function openLogMenu(e: MouseEvent, log: any): void {
    ctxOther.value = { x: e.clientX, y: e.clientY, kind: 'log', item: log }
  }

  /** 右键「编辑」→ 复用日志卡点击的 openLog（必须走它，否则会打开"完成日志"框） */
  function editLogFromMenu(log: any): void { openLog(log) }

  function openTodoMenu(e: MouseEvent, todo: any): void {
    ctxOther.value = { x: e.clientX, y: e.clientY, kind: 'todo', item: todo }
  }

  function closeOtherMenu(): void { ctxOther.value = null }

  function ctxOtherRun(fn: (item: any) => void): void {
    const c = ctxOther.value
    closeOtherMenu()
    if (c) fn(c.item)
  }

  /** 菜单里的彻底删除复用既有入口（二次确认在 destroyLogItem 里） */
  function runDestroyLog(log: any): void { destroyLogItem(log.id) }

  return {
    ctxOther, openColumnMenu, newTaskInColumn, openLogMenu, editLogFromMenu,
    openTodoMenu, closeOtherMenu, ctxOtherRun, runDestroyLog,
  }
}
