/**
 * 通知中心 —— 从 App.vue 切出来的第五刀（2026-10-30）。
 *
 * 为什么切它：通知的「取数 / 未读 / 过滤 / 跳转 / 全局点击与 Esc」是一整块闭环，
 * 只依赖 4 个外部动作（切视图、开卡、报解析错误、开设置）+ 一个 toast。
 *
 * 纪律：
 *  · 未读数轮询、document 上的点击/键盘监听、`ncTimer` 的收尾**全在这里**，App 不再管；
 *  · 跳转动作由调用方注入（它要切的是 App 的视图、开的是 App 的预览）—— 不在这里偷偷改视图；
 *  · 「通知 IPC 缺失 → 铃铛隐藏」的判据保持原样（防僵尸按钮）。
 */
import { computed, onUnmounted, ref } from 'vue'
import { relTimeShort } from '../../shared/time'

export interface UseNotificationsOptions {
  toast: (msg: string, type?: 'success' | 'error' | 'info') => void
  navigateTo: (view: string) => void
  openCard: (task: any) => void
  showParseErrors: () => void
  openSettings: () => void
}

export function useNotifications(ctx: UseNotificationsOptions) {
  // ── 通知中心（Notification Center）─────────────────────────────────
  // UI 按用户原型 notification-center.html 移植；数据走 notifications:* IPC
  const NC_TYPE_META: Record<string, { icon: string; label: string; glyph: string }> = {
    'todo-due':      { icon: 'calendar', label: '待办到期', glyph: '📅' },
    'task-deadline': { icon: 'task',     label: '任务逾期', glyph: '📋' },
    'task-timeout':  { icon: 'approve',  label: '超时未回写', glyph: '⏱' },
    'parse-error':   { icon: 'security', label: '解析失败', glyph: '⚠' },
    'backup-failed': { icon: 'storage', label: '备份失败', glyph: '💾' },
    'update-downloaded': { icon: 'storage', label: '更新已就绪', glyph: '⬆' },
    // 2026-10-01 用户定稿新增的两类（只在面板里看，不弹系统通知）。
    // icon 复用现有 security/approve —— 新 icon 得配 nc-t-*/nc-av-* 两套主题色，没必要为两个标签开新面。
    'blocker-broken': { icon: 'security', label: '阻塞链断裂', glyph: '⛓' },
    'task-stalled':   { icon: 'approve',  label: '任务没动静', glyph: '💤' },
  }
  const ncOpen = ref(false)
  const ncReady = ref(false)
  const ncLoading = ref(false)
  const ncUnread = ref(0)
  const ncItems = ref<any[]>([])
  const ncFilter = ref<'all' | 'unread' | 'read'>('unread')
  let ncTimer: number | null = null

  const ncCounts = computed(() => {
    const unread = ncItems.value.filter(n => !n.read).length
    return { all: ncItems.value.length, unread, read: ncItems.value.length - unread }
  })
  const ncVisible = computed(() => {
    return ncItems.value.filter(n => {
      if (ncFilter.value === 'unread' && n.read) return false
      if (ncFilter.value === 'read' && !n.read) return false
      return true
    })
  })
  const ncHeadSub = computed(() => ncUnread.value
    ? `你有 ${ncUnread.value} 条未读通知`
    : '全部通知均已读')

  function ncRelTime(iso: string): string {
    return relTimeShort(iso)
  }

  /** P0-4：扫描器状态（running/lastScanAt）。拿不到 = 老版本 preload，显示"未知"即可。 */
  const ncStatus = ref<{ running: boolean; lastScanAt: string | null } | null>(null)
  /** P0-5：被静音（删过）的提醒 key —— 必须看得见、能恢复，否则点过 🗑 就是 7 天哑巴。 */
  const ncMuted = ref<string[]>([])

  const ncStatusText = computed(() => {
    const s = ncStatus.value
    if (!s) return '扫描器状态：未知'
    const when = s.lastScanAt ? `上次扫描 ${ncRelTime(s.lastScanAt)}` : '尚未扫描'
    return `${s.running ? '扫描器运行中' : '扫描器已停止'} · ${when}`
  })

  async function ncLoad(): Promise<void> {
    try {
      const [list, unread] = await Promise.all([
        (window as any).tegula.notificationsList(),
        (window as any).tegula.notificationsUnreadCount(),
      ])
      ncItems.value = list || []
      ncUnread.value = unread || 0
    } catch { /* IPC 失败静默，ncReady 已做入口探测 */ }
    // 状态与静音是**增强项**：通道缺失时保持"未知"，不能让整块面板挂掉
    try {
      const t = (window as any).tegula
      if (typeof t.notificationsScannerStatus === 'function') {
        ncStatus.value = await t.notificationsScannerStatus()
      }
      if (typeof t.notificationsListMuted === 'function') {
        ncMuted.value = (await t.notificationsListMuted()) || []
      }
    } catch { /* 老 preload 没有这两条通道 */ }
  }

  /** P0-5：一次性把被忽略的提醒全部放出来（静音是 7 天 TTL，这里给手动恢复口） */
  async function ncUnmuteAll(): Promise<void> {
    try {
      const t = (window as any).tegula
      const n = typeof t.notificationsUnmuteAll === 'function' ? await t.notificationsUnmuteAll() : 0
      ctx.toast(`已恢复 ${n || 0} 条被忽略的提醒`, 'success')
      await ncLoad()
    } catch {
      ctx.toast('恢复被忽略提醒失败', 'error')
    }
  }

  async function ncRefresh(): Promise<void> {
    if (ncLoading.value) return
    ncLoading.value = true
    try {
      await (window as any).tegula.notificationsScan()
      await ncLoad()
    } catch { /* ignore */ }
    setTimeout(() => { ncLoading.value = false }, 400)
  }

  function ncToggle(): void {
    if (ncOpen.value) { closePanel(); return }
    ncOpen.value = true
    ncLoad()
  }

  function closePanel(): void {
    ncOpen.value = false
  }

  function ncSetFilter(f: 'all' | 'unread' | 'read'): void {
    ncFilter.value = f
  }

  /**
   * 通知 → 可跳目标的标签。**返回 null = 这条没有可跳对象（只标已读）**。
   * 同一个函数同时驱动三件事：行尾箭头显不显示、title 提示、点击后跳哪 —— 三处必须一致，
   * 否则会出现「箭头亮着点了没反应」这种新的"无效按钮"（2026-10-01 用户第 1 条原话）。
   */
  function ncTargetOf(n: any): string | null {
    const t = String(n.type || '')
    if (['task-deadline', 'task-timeout', 'task-stalled', 'blocker-broken'].includes(t)) {
      return n.sourceId ? '跳到这个任务' : null
    }
    if (t === 'todo-due') return '跳到待办'
    if (t === 'parse-error') return '查看解析错误'
    if (t === 'backup-failed' || t === 'update-downloaded') return '打开设置'
    return null
  }

  /**
   * 通知点击跳转（2026-10-01 用户第 1 条：「目前点下去是无效按钮」）。
   *
   * 口径：先按原行为标已读，再跳。跳不成（任务已被删除/已归档）只 toast 说明，不影响已读 ——
   * 不能因为目标没了就让面板卡在原地。
   */
  async function ncJump(n: any): Promise<void> {
    if (!ncTargetOf(n)) return
    const t = String(n.type || '')
    closePanel()
    if (['task-deadline', 'task-timeout', 'task-stalled', 'blocker-broken'].includes(t)) {
      let task: any = null
      try { task = await (window as any).tegula.getTask(n.sourceId) } catch { /* 旧版本没有该通道时静默 */ }
      if (task) {
        ctx.navigateTo('active')   // 任务只在看板列里，先切过去再开预览
        ctx.openCard(task)         // 复用看板卡片的打开路径（含关联日志加载）
      } else {
        ctx.toast(`任务 ${n.sourceId} 已不在活跃区（可能被删除或已归档）`, 'error')
      }
      return
    }
    if (t === 'todo-due') { ctx.navigateTo('todos'); return }
    if (t === 'parse-error') { ctx.showParseErrors(); return }
    if (t === 'backup-failed' || t === 'update-downloaded') { ctx.openSettings(); return }
  }

  async function ncClickItem(n: any): Promise<void> {
    if (!n.read) {
      try {
        await (window as any).tegula.notificationsMarkRead(n.id)
        n.read = true
        ncUnread.value = Math.max(0, ncUnread.value - 1)
      } catch { /* ignore */ }
    }
    await ncJump(n)
  }

  async function ncToggleRead(n: any): Promise<void> {
    try {
      await (window as any).tegula.notificationsMarkRead(n.id)
      if (!n.read) { n.read = true; ncUnread.value = Math.max(0, ncUnread.value - 1) }
    } catch { /* ignore */ }
  }

  async function ncMarkAllRead(): Promise<void> {
    try {
      await (window as any).tegula.notificationsMarkAllRead()
      await ncLoad()
    } catch { /* ignore */ }
  }

  async function ncDelete(n: any): Promise<void> {
    try {
      await (window as any).tegula.notificationsDelete(n.id)
      await ncLoad()
    } catch { /* ignore */ }
  }

  async function ncClearAll(): Promise<void> {
    try {
      await (window as any).tegula.notificationsClear()
      await ncLoad()
    } catch { /* ignore */ }
  }

  function onDocumentClick(e: MouseEvent): void {
    if (!ncOpen.value) return
    const wrap = (e.target as HTMLElement).closest('.nc-wrap, .nc-panel, .nc-bell')
    if (!wrap) closePanel()
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return
    if (ncOpen.value) { closePanel(); return }
    // 2026-09-26 卡 033：Esc 关掉**最上层弹窗**。同样不逐个维护弹窗清单：
    // 取 DOM 里最后一个 .overlay，点它的「取消」（.acts .ghost）。找不到就什么都不做。
    // ⚠ 必须**先滤掉 display:none 的**（同下面 Ctrl+S 那条口径）：
    //   方寸有几块 `.overlay` 是**常驻 DOM 但靠 display 藏起来**的（roverlay / soverlay 等），
    //   它们的模板位置排在待办编辑弹窗**后面**。不滤可见性时，`overlays[length-1]` 拿到的是
    //   那块**看不见**的，于是「待办编辑弹窗开着时按 Esc 关不掉」—— 2026-10-14 真点击 e2e
    //   解锁后实测到的（此前这一层恒 SKIP，从没验过）。
    const overlays = (Array.from(document.querySelectorAll('.overlay')) as HTMLElement[])
      .filter(el => window.getComputedStyle(el).display !== 'none')
    const top = overlays[overlays.length - 1]
    if (!top) return
    // ① 有「取消」按钮就点它（多数弹窗的约定：`.acts .ghost`）。
    const cancel = top.querySelector('.acts .ghost') as HTMLElement | null
    if (cancel) { cancel.click(); return }
    // ② 兜底：这块弹窗**没有**「取消」按钮（设置面板就是这样）—— 派发一次 mousedown 到遮罩本体，
    //    走它自己的 `@mousedown.self` 关闭路径（全站遮罩统一绑的那条）。
    //    ⚠ 2026-10-15：此前只有 ①，于是「设置弹窗开着时按 Esc 什么都不发生」——
    //    真点击 e2e 实测到的（那时 Esc 会先被更靠后的设置遮罩截住，表现为"待办弹窗关不掉"）。
    //    兜底只发事件、不猜状态，所以对没有绑定关闭手势的遮罩也**不会误关**任何东西。
    top.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  }

  /** 全局快捷键（2026-09-25 用户第 6 条：「希望有一些简单的快捷键，比如保存和撤销」）
   *
   *  Ctrl/Cmd+S = 保存当前打开的弹窗。
   *  · 不逐个维护「哪个弹窗开着」：`v-if` 的弹窗关着时根本不在 DOM 里，所以直接取
   *    当前 DOM 里可见的最后一个 `.overlay`，点它的**主操作按钮 `.acts .pri`**。
   *    以后新增弹窗自动被覆盖，不会漏接线（上一轮「通道早通、UI 无入口」就是漏接线）。
   *  · **只认 `.pri`**：验收弹窗的「通过」是 `.ok`、驳回是 `.danger` —— 裁决类按钮
   *    **刻意不接管**，Ctrl+S 误触一下就把任务验收了，代价太大，必须用手点。
   *  · Ctrl+Z 只在**焦点不在输入控件里**时接管（2026-10-21 暮雨第 1 条：「狂按 Ctrl+Z
   *    也没用」）：它撤的是撤销条上那**一笔状态动作**（完成 / 归档），不是文字。
   *    焦点在 input/textarea/contenteditable 时一律放行原生撤销 —— 那里覆盖的是
   *    "这次输入"，抢过来只会让人更没法改错字。
   */
  function ncInit(): void {
    const t = (window as any).tegula
    ncReady.value = !!(t && typeof t.notificationsList === 'function')
    if (!ncReady.value) return  // preload 未暴露通知 IPC → 隐藏铃铛（防僵尸按钮）
    document.addEventListener('mousedown', onDocumentClick)
    document.addEventListener('keydown', onKeydown)
    ncLoad()
    // 30s 轮询未读数（轻量，只拉计数）
    ncTimer = window.setInterval(() => {
      (window as any).tegula.notificationsUnreadCount().then((c: number) => { ncUnread.value = c || 0 }).catch(() => {})
    }, 30_000)
  }

  onUnmounted(() => {
    if (ncTimer) { clearInterval(ncTimer); ncTimer = null }
    document.removeEventListener('mousedown', onDocumentClick)
    document.removeEventListener('keydown', onKeydown)
  })

  return {
    NC_TYPE_META, ncOpen, ncReady, ncLoading, ncUnread, ncItems, ncFilter, ncCounts, ncVisible, ncHeadSub, ncRelTime, ncStatus, ncMuted, ncStatusText, ncLoad, ncUnmuteAll, ncRefresh, ncToggle, closePanel, ncSetFilter, ncTargetOf, ncJump, ncClickItem, ncToggleRead, ncMarkAllRead, ncDelete, ncClearAll, ncInit
  }
}
