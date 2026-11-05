/**
 * 打开日志编辑器 / 关联任务选择（2026-10-31 · 渲染层拆分第二批“日志动作收口”第七刀）
 *
 * 搬出来的是“打开表单”这一组：
 *   · openLog（编辑已有）/ openNewLog（新建，项目跟随顶栏筛选）/ openLogForTask（从任务详情预填）；
 *   · 关联任务候选：同项目 + 关键词过滤 + 最近更新排序，首屏 12 条；
 *   · chips 回显、摘除、手填列表外 ID。
 *
 * 仍在 App 的：normalizeLogTaskIds（被守卫/保存/状态三处共用，先不动）、日志互转。
 */
import { computed, ref, type Ref } from 'vue'
import { parseTime } from '../../shared/time'

const LOG_TASK_CAP = 12

interface Deps {
  tasks: Ref<any[]>
  archivedTasks: Ref<any[]>
  projects: Ref<any[]>
  /** 只读：多选项目筛选后它是派生值（取第一个选中的当默认项目），这里**不写**它 */
  curProj: Readonly<Ref<string>>
  logEdit_: Ref<any>
  logCompleting: Ref<boolean>
  logArchiveMode: Ref<boolean>
  logRetainDays: Ref<string>
  logRetainDefault: Ref<number>
  logNote: Ref<string>
  previewTask: Ref<any>
  resetLogHistory: () => void
  resetPendingAttach: () => void
  markLogSnap: () => void
  normalizeLogTaskIds: (log: any) => string[]
  normProject: (p: any) => string
}

export function useLogEditorOpen(deps: Deps) {
  const {
    tasks, archivedTasks, projects, curProj, logEdit_, logCompleting, logArchiveMode,
    logRetainDays, logRetainDefault, logNote, previewTask, resetLogHistory,
    resetPendingAttach, markLogSnap, normalizeLogTaskIds, normProject,
  } = deps

  const logTaskOpen = ref(false)
  const logTaskQuery = ref('')
  const logTaskExtra = ref('')
  /**
   * 关联任务候选的**范围**与**状态**（2026-11-05 暮雨第 11 条）。
   *
   * 原话：“日志关联任务的筛选也是狗屎，约等于无。现在只能根据关键词（肉眼）快速筛选，随便乱点。”
   * 根因很实在：候选此前**硬性只列同项目**的任务 —— 而日志恰恰是跨项目工作时写的，
   * 想挂的那张卡常在别的项目里，于是"搜不到 = 约等于没有"。
   *   · scope：proj（本项目，默认）/ all（全部项目）。
   *     **输入了搜索词时自动当 all 用** —— 有词就说明人心里已经知道要哪张，
   *     这时还按项目挡着，等于逼他把项目切过去再搜一次；
   *   · openOnly：默认只看未完成（完成/驳回的卡极少需要挂到新日志上），可一键放开。
   */
  const logTaskScope = ref<'proj' | 'all'>('proj')
  const logTaskOpenOnly = ref(true)
  /** 首屏上限：超过就显示"共 N 条"，可一次性展开（老版只有一句提示，没有出口） */
  const logTaskShowAll = ref(false)

  const TERMINAL_STATUSES = ['完成', '驳回']

  const logTaskMatched = computed(() => {
    const proj = logEdit_.value?.project
    const q = (logTaskQuery.value || '').trim().toLowerCase()
    // 有搜索词就不再按项目挡（见 logTaskScope 注释）
    const scopeAll = logTaskScope.value === 'all' || !!q
    const all = [...tasks.value, ...archivedTasks.value]
    const byId = new Map(all.map(t => [t.id, t]))
    const projName = (id: string) => {
      const p = projects.value.find(x => x.id === id)
      return String(p?.name || id || '').toLowerCase()
    }
    const seen = new Set<string>()
    const out: Array<{ id: string; title: string; status: string; project: string }> = []
    for (const t of all) {
      if (seen.has(t.id)) continue
      const tp = normProject(t.project)
      if (!scopeAll && proj && tp !== proj) continue
      if (logTaskOpenOnly.value && TERMINAL_STATUSES.includes(String(t.status || ''))) continue
      if (q) {
        // 匹配面从「id + 标题」扩到「id + 标题 + 项目名 + 项目 id」——
        // 人记得的往往是"绒花墨坊那张"，不是 id
        const hay = `${t.id} ${t.title || ''} ${tp} ${projName(tp)}`.toLowerCase()
        if (!hay.includes(q)) continue
      }
      seen.add(t.id)
      out.push({ id: t.id, title: t.title || '', status: t.status, project: tp })
      if (out.length >= 500) break
    }
    // 最近更新优先：首屏要的是“最可能要挂的那几张”，不是文件序
    out.sort((a, b) =>
      Number(parseTime(byId.get(b.id)?.updated || 0)) - Number(parseTime(byId.get(a.id)?.updated || 0)))
    return out
  })
  const logTaskOptions = computed(() =>
    logTaskShowAll.value ? logTaskMatched.value : logTaskMatched.value.slice(0, LOG_TASK_CAP))
  const logTaskMoreHidden = computed(() => logTaskMatched.value.length > logTaskOptions.value.length)
  /** 候选总数（界面上要写“共几条”，不能只有一个"12"让人以为总共就 12 条） */
  const logTaskTotal = computed(() => logTaskMatched.value.length)

  /** chips 回显：id → 标题（列表外给空，界面回退显示 id 本身） */
  function taskTitleOf(id: string): string {
    const all = [...tasks.value, ...archivedTasks.value]
    return all.find(x => x.id === id)?.title || ''
  }

  /** chip 上的 × ：摘掉一条关联（与取消勾选同一条数据路径） */
  function unlinkLogTask(id: string): void {
    const e = logEdit_.value
    if (!e) return
    e.taskIds = normalizeLogTaskIds(e).filter(x => x !== id)
  }

  /** 手填的“列表外 ID”：逗号/空格分隔，回车或失焦时并入已选 */
  function addLogTaskExtra(): void {
    const raw = logTaskExtra.value || ''
    const ids = raw.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
    if (!ids.length) return
    const e = logEdit_.value
    if (!e) return
    const cur = normalizeLogTaskIds(e)
    for (const id of ids) if (!cur.includes(id)) cur.push(id)
    e.taskIds = cur
    logTaskExtra.value = ''
  }

  function openLog(log: any) {
    // 关联任务归一成数组，供多选 UI 绑定
    logEdit_.value = { ...log, taskIds: normalizeLogTaskIds(log) }
    resetLogHistory()
    logCompleting.value = false
    logArchiveMode.value = false
    logTaskOpen.value = false    // 关联任务候选默认折叠
    logTaskQuery.value = ''
    logTaskExtra.value = ''
    // 候选的范围/状态是"这一次挑卡"的临时口径，不许从上一个日志粘过来
    logTaskScope.value = 'proj'
    logTaskOpenOnly.value = true
    logTaskShowAll.value = false
    resetPendingAttach()   // 编辑现有日志：不带上一轮新建态的待挂附件
    markLogSnap()          // 打开即存快照（改没改才算数）
    setTimeout(() => {
      const titleInput = document.querySelector('#log-edit-modal input[placeholder="日志标题"]') as HTMLInputElement
      if (titleInput) titleInput.focus()
    }, 50)
  }

  function openNewLog() {
    // 项目默认跟随顶栏的项目筛选（没筛选就用第一个登记项目），不硬编码 id
    const project = curProj.value !== '__all__'
      ? curProj.value
      : (projects.value[0]?.id || '')
    logEdit_.value = { id: '', title: '', project, content: '', nextSteps: '', taskIds: [], sessionId: '', agentName: '', prevAgentName: '', logDate: '', priority: '' }
    resetLogHistory()
    logCompleting.value = false
    logArchiveMode.value = false
    logTaskOpen.value = false
    logTaskQuery.value = ''
    logTaskExtra.value = ''
    logTaskScope.value = 'proj'
    logTaskOpenOnly.value = true
    logTaskShowAll.value = false
    logRetainDays.value = String(logRetainDefault.value)
    logNote.value = ''
    resetPendingAttach()
    markLogSnap()   // 新建只改下拉也不许静默丢
  }

  /** 从任务详情写一条执行日志：预填 taskId 与项目，省得再手填一遍 */
  function openLogForTask(taskId: string) {
    openNewLog()
    logEdit_.value.taskId = taskId
    const t = previewTask.value
    if (t?.project) logEdit_.value.project = normProject(t.project)
    if (t?.title) logEdit_.value.title = `${t.title} — 执行记录`
  }

  return {
    openLog, openNewLog, openLogForTask,
    logTaskOpen, logTaskQuery, logTaskExtra, logTaskOptions, logTaskMoreHidden,
    logTaskScope, logTaskOpenOnly, logTaskShowAll, logTaskTotal,
    taskTitleOf, unlinkLogTask, addLogTaskExtra,
  }
}
