/**
 * 日志附属绑定 + 全组动作（2026-10-31 · 渲染层拆分第二批「日志辅助动作收口」第一刀）
 *
 * 搬出来的是「主日志 ↔ 附属日志」这一组：
 *   · 绑定弹窗：全量候选（不受主界面筛选影响）+ 六维筛选 + 已占用原因 + 最多 20 条；
 *   · 保存绑定（logsSetAttached）；
 *   · 全组进行中 / 全组完成（带快照撤销）；
 *   · 开工单（主日志 + 全部附属，顺序固定）。
 *
 * 依赖由调用方传入，不复制状态。
 */
import { computed, ref, type Ref } from 'vue'
import { toPlain } from '../../shared/plain'

interface Deps {
  logs: Ref<any[]>
  projects: Ref<any[]>
  agentPresets: Ref<string[]>
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void
  loadLogs: () => Promise<void>
  offerUndo: (label: string, fn: () => Promise<void>) => void
  logRetainDefault: Ref<number>
  copyLogsAsPrompt: (ids: string[]) => Promise<void>
}

export function useLogGroups(deps: Deps) {
  const { logs, projects, agentPresets, showToast, loadLogs, offerUndo, logRetainDefault, copyLogsAsPrompt } = deps

  const logAttachTarget = ref<any>(null)
  const logAttachPick = ref<string[]>([])
  const logAttachBusy = ref(false)
  const logAttachAll = ref<any[]>([])
  const logAttachLoading = ref(false)
  const logAttachQuery = ref('')
  const logAttachProject = ref('')
  const logAttachStatus = ref('')
  const logAttachAgent = ref('')
  const logAttachPrio = ref('')
  const logAttachDateFrom = ref('')
  const logAttachDateTo = ref('')
  const logAttachShowBlocked = ref(false)

  /** 打开绑定弹窗时**重新取全量日志** —— 候选不能受主界面筛选影响。 */
  async function openLogAttach(main: any): Promise<void> {
    if (!main || main.status === 'archived') return
    logAttachTarget.value = main
    logAttachPick.value = (Array.isArray(main.attached) ? main.attached : []).slice()
    logAttachQuery.value = ''
    logAttachProject.value = ''
    logAttachStatus.value = ''
    logAttachAgent.value = ''
    logAttachPrio.value = ''
    logAttachDateFrom.value = ''
    logAttachDateTo.value = ''
    logAttachShowBlocked.value = false
    logAttachLoading.value = true
    try {
      const all: any[] = await window.tegula.logsList({})
      logAttachAll.value = Array.isArray(all) && all.length ? all : (logs.value || []).slice()
    } catch {
      logAttachAll.value = (logs.value || []).slice()
      showToast('读取全部日志失败，只能从当前列表里选', 'error')
    } finally {
      logAttachLoading.value = false
    }
  }

  /** 一行日志的「人话状态」键：running 优先于 status（与分区同一口径） */
  function logAttachStatusOf(l: any): string {
    if (!l) return ''
    if (l.status === 'active') return l.running ? 'running' : 'active'
    return String(l.status || 'active')
  }

  /** 反向索引：附属 id → 主日志。一次算好，候选行 O(1) 查。 */
  const logAttachOwnerMap = computed(() => {
    const m = new Map<string, any>()
    for (const x of logAttachAll.value || []) {
      for (const id of Array.isArray(x.attached) ? x.attached : []) {
        if (!m.has(id)) m.set(id, x)
      }
    }
    return m
  })

  function logAttachOwnerOf(id: string): any {
    return logAttachOwnerMap.value.get(id) || null
  }

  /** 一条候选是否命中当前全部筛选（关键词多字段 OR，其余 AND） */
  function logAttachMatches(l: any, q: string): boolean {
    if (logAttachProject.value && l.project !== logAttachProject.value) return false
    if (logAttachStatus.value && logAttachStatusOf(l) !== logAttachStatus.value) return false
    if (logAttachAgent.value && l.agentName !== logAttachAgent.value) return false
    if (logAttachPrio.value) {
      if (logAttachPrio.value === '__none__') { if (l.priority) return false }
      else if (l.priority !== logAttachPrio.value) return false
    }
    const d = String(l.logDate || l.created || '').slice(0, 10)
    if (logAttachDateFrom.value && d < logAttachDateFrom.value) return false
    if (logAttachDateTo.value && d > logAttachDateTo.value) return false
    if (q) {
      const hit = (s: any) => String(s || '').toLowerCase().includes(q)
      const taskIds = Array.isArray(l.taskIds) ? l.taskIds.join(' ') : String(l.taskId || '')
      if (!(hit(l.id) || hit(l.title) || hit(l.content) || hit(l.nextSteps)
        || hit(l.project) || hit(l.agentName) || hit(taskIds) || hit(l.sessionId))) return false
    }
    return true
  }

  /** 项目下拉：登记项目 + 全量日志里出现过但未登记的项目（不把日志藏起来） */
  const logAttachProjects = computed(() => {
    const m = new Map<string, string>()
    for (const p of projects.value || []) if (p && p.id) m.set(p.id, p.name || p.id)
    for (const l of logAttachAll.value || []) if (l.project && !m.has(l.project)) m.set(l.project, l.project)
    return Array.from(m, ([id, name]) => ({ id, name }))
  })

  /** Agent 下拉：常用预设 + 全量日志里出现过的 Agent */
  const logAttachAgents = computed(() => {
    const s = new Set<string>()
    for (const a of agentPresets.value || []) if (a) s.add(String(a))
    for (const l of logAttachAll.value || []) if (l.agentName) s.add(String(l.agentName))
    return Array.from(s).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  })

  /**
   * 候选行。三条纪律：
   *  ① 已勾选的即使不命中筛选也留下；
   *  ② 已被别的组占走 / 自己是一组主日志的默认不列，打开「显示已占用」才列并写明原因；
   *  ③ 排序：已选 → 进行中 → 待处理 → 已完成/归档，同级按创建倒序。
   */
  const logAttachRows = computed(() => {
    const main = logAttachTarget.value
    if (!main) return []
    const q = logAttachQuery.value.trim().toLowerCase()
    const rank = (r: any) => {
      if (r.picked) return 0
      if (r.blocked) return 5
      const st = logAttachStatusOf(r.log)
      return st === 'running' ? 1 : st === 'active' ? 2 : st === 'completed' ? 3 : 4
    }
    const rows: any[] = []
    for (const l of logAttachAll.value || []) {
      if (l.id === main.id) continue
      const picked = logAttachPick.value.includes(l.id)
      const ownGroup = Array.isArray(l.attached) && l.attached.length > 0
      const owner = logAttachOwnerOf(l.id)
      const blocked = !picked && (ownGroup || (owner && owner.id !== main.id))
      if (blocked && !logAttachShowBlocked.value) continue
      if (!picked && !logAttachMatches(l, q)) continue
      rows.push({
        log: l,
        picked,
        blocked: !!blocked,
        reason: ownGroup ? '它自己是一组的主日志'
          : (owner && owner.id !== main.id ? `已被「${owner.title || owner.id}」绑定` : ''),
      })
    }
    return rows.sort((a, b) => (rank(a) - rank(b))
      || String(b.log.created || '').localeCompare(String(a.log.created || '')))
  })

  const logAttachBlockedCount = computed(() => {
    const main = logAttachTarget.value
    if (!main) return 0
    let n = 0
    for (const l of logAttachAll.value || []) {
      if (l.id === main.id || logAttachPick.value.includes(l.id)) continue
      const ownGroup = Array.isArray(l.attached) && l.attached.length > 0
      const owner = logAttachOwnerOf(l.id)
      if (ownGroup || (owner && owner.id !== main.id)) n++
    }
    return n
  })

  const logAttachPickedOutside = computed(() => {
    const visible = new Set(logAttachRows.value.map((r: any) => r.log.id))
    return logAttachPick.value.filter((id) => !visible.has(id)).length
  })

  function toggleLogAttachPick(id: string): void {
    const i = logAttachPick.value.indexOf(id)
    if (i >= 0) logAttachPick.value.splice(i, 1)
    else {
      if (logAttachPick.value.length >= 20) { showToast('一个主日志最多带 20 条附属日志', 'error'); return }
      logAttachPick.value.push(id)
    }
  }

  function selectAllLogAttachFiltered(): void {
    const ids = logAttachRows.value.filter((r: any) => !r.blocked).map((r: any) => r.log.id)
    const keep = logAttachPick.value.filter((id) => !ids.includes(id))
    const next = Array.from(new Set([...keep, ...ids]))
    if (next.length > 20) {
      logAttachPick.value = next.slice(0, 20)
      showToast('一个主日志最多带 20 条附属日志，已选前 20 条', 'info')
    } else {
      logAttachPick.value = next
    }
  }

  function clearLogAttachPick(): void { logAttachPick.value = [] }

  function clearLogAttachFilters(): void {
    logAttachQuery.value = ''
    logAttachProject.value = ''
    logAttachStatus.value = ''
    logAttachAgent.value = ''
    logAttachPrio.value = ''
    logAttachDateFrom.value = ''
    logAttachDateTo.value = ''
  }

  async function saveLogAttach(): Promise<void> {
    const main = logAttachTarget.value
    if (!main) return
    if (logAttachPick.value.length > 20) { showToast('一个主日志最多带 20 条附属日志', 'error'); return }
    logAttachBusy.value = true
    try {
      const r: any = await window.tegula.logsSetAttached(main.id, toPlain(logAttachPick.value))
      if (!r?.ok) { showToast(`绑定失败：${r?.error || '未知原因'}`, 'error'); return }
      showToast(logAttachPick.value.length ? `已绑定 ${logAttachPick.value.length} 条附属日志` : '已解除全部附属', 'success')
      logAttachTarget.value = null
      await loadLogs()
    } catch (e: any) {
      showToast(`绑定异常：${e?.message || e}`, 'error')
    } finally {
      logAttachBusy.value = false
    }
  }

  /** 组内全部成员 id（主日志第一位；含当前筛选没显示的附属） */
  function logGroupMemberIds(main: any): string[] {
    const ids = [main?.id, ...(Array.isArray(main?.attached) ? main.attached : [])].filter(Boolean)
    return Array.from(new Set(ids))
  }

  /** 快照一组日志的当前状态（撤销用）。筛选藏起来的也去全量里读回来。 */
  async function snapLogsById(ids: string[]): Promise<Array<{ id: string; snap: any }>> {
    const byId = new Map<string, any>((logs.value || []).map((x: any) => [x.id, x]))
    const missing = ids.filter((id) => !byId.has(id))
    if (missing.length) {
      try {
        const all: any[] = await window.tegula.logsList({})
        for (const l of all || []) byId.set(l.id, l)
      } catch { /* 读不到就少撤几条，toast 会如实报 */ }
    }
    return ids.map((id) => {
      const l: any = byId.get(id)
      if (!l) return null
      return {
        id,
        snap: {
          status: l.status, running: !!l.running, agentDone: !!l.agentDone,
          completed: l.completed || null, retainDays: l.retainDays ?? null,
          retainUntil: l.retainUntil || null, note: l.note || '', archiveNote: l.archiveNote || '',
        },
      }
    }).filter(Boolean) as Array<{ id: string; snap: any }>
  }

  async function restoreLogSnaps(snaps: Array<{ id: string; snap: any }>): Promise<number> {
    let ok = 0
    for (const s of snaps) {
      try {
        const r: any = await window.tegula.logsRestoreState(s.id, s.snap)
        if (r?.ok) ok++
      } catch { /* 单条失败不中断 */ }
    }
    await loadLogs()
    return ok
  }

  /** 一键全进行中 / 全部撤销（只动待处理/进行中的成员） */
  async function toggleLogGroupRunning(main: any, running: boolean): Promise<void> {
    const ids = logGroupMemberIds(main)
    const snaps = await snapLogsById(ids)
    const r: any = await window.tegula.logsGroupRunning(main.id, !!running)
    if (!r?.ok) { showToast(`操作失败：${r?.error || '未知原因'}`, 'error'); return }
    const n = (r.changed || []).length
    if (!n) showToast(running ? '全组都已在「进行中」或已完成' : '全组都没有挂「进行中」', 'info')
    else showToast(running ? `全组 ${n} 条已标为「进行中」` : `全组 ${n} 条已撤销「进行中」`, 'success')
    await loadLogs()
    if (snaps.length) {
      offerUndo(`${running ? '全组进行中' : '全组撤销进行中'}：${main.title || main.id}`, async () => {
        await restoreLogSnaps(snaps)
        showToast('已撤回全组状态', 'success')
      })
    }
  }

  /** 一键全完成（跳过已完成/已归档） */
  async function completeLogGroupItem(main: any): Promise<void> {
    const ids = logGroupMemberIds(main)
    const snaps = await snapLogsById(ids)
    const days = logRetainDefault.value
    const r: any = await window.tegula.logsGroupComplete(main.id, days, '')
    if (!r?.ok) { showToast(`完成失败：${r?.error || '未知原因'}`, 'error'); return }
    const n = (r.changed || []).length
    const skipped = (r.skipped || []).length
    showToast(n ? `全组已完成 ${n} 条${skipped ? `（${skipped} 条已是完成/归档，跳过）` : ''}` : '全组都已经完成或归档', n ? 'success' : 'info')
    await loadLogs()
    if (n && snaps.length) {
      offerUndo(`全组完成：${main.title || main.id}`, async () => {
        const ok = await restoreLogSnaps(snaps)
        if (ok !== snaps.length) showToast(`只撤回了 ${ok}/${snaps.length} 条`, 'error')
        else showToast('已撤回全组完成', 'success')
      })
    }
  }

  /** 开工单：主日志 + 全部附属，一次复制（顺序固定） */
  async function copyLogGroupAsPrompt(main: any): Promise<void> {
    await copyLogsAsPrompt(logGroupMemberIds(main))
  }

  return {
    logAttachTarget, logAttachPick, logAttachBusy, logAttachAll, logAttachLoading,
    logAttachQuery, logAttachProject, logAttachStatus, logAttachAgent, logAttachPrio,
    logAttachDateFrom, logAttachDateTo, logAttachShowBlocked,
    logAttachProjects, logAttachAgents, logAttachRows, logAttachBlockedCount, logAttachPickedOutside,
    logAttachStatusOf, logAttachOwnerOf, logAttachMatches,
    openLogAttach, toggleLogAttachPick, selectAllLogAttachFiltered, clearLogAttachPick,
    clearLogAttachFilters, saveLogAttach,
    logGroupMemberIds, toggleLogGroupRunning, completeLogGroupItem, copyLogGroupAsPrompt,
  }
}
