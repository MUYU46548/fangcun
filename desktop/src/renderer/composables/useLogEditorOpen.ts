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
import {
  taskPick, taskPickHiddenByStatus, taskPickFirst, TASK_PICK_FIELD_RANK,
} from '../../shared/taskPick'

const LOG_TASK_CAP = 12
/**
 * 有搜索词时的首屏上限（2026-11-13 卡 2b1e3d59）。
 *
 * 为什么不是 12：有词的时候人**已经知道要哪张**，此时还按项目分组铺开就是信息轰炸
 * （实测 17 个组 × 每组 8 条 = 首屏 76 行）。20 是"一屏多一点"，能扫完且不用滚。
 */
const LOG_TASK_QUERY_CAP = 20

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
   *   · 状态：2026-11-08 第 6 条从"一个只看未完成的 checkbox"改成三档。
   *     他要的是"盯着待验收的那几张写日志"这种具体视角，一个布尔表达不了。
   */
  const logTaskScope = ref<'proj' | 'all'>('proj')
  const logTaskStatus = ref<'open' | 'all' | 'done'>('open')
  /** 兼容旧调用点（openLog/openNewLog 复位、App 模板解构）：true = 只看未完成 */
  const logTaskOpenOnly = computed({
    get: () => logTaskStatus.value === 'open',
    set: (v: boolean) => { logTaskStatus.value = v ? 'open' : 'all' },
  })
  /** 首屏上限：组内先给 8 条（分组后按组给，不再全局一刀切 12 条） */
  const logTaskShowAll = ref(false)
  const logTaskExpanded = ref<Record<string, boolean>>({})

  const TERMINAL_STATUSES = ['完成', '驳回']
  const LOG_GROUP_CAP = 8

  const logTaskMatched = computed(() => {
    const proj = logEdit_.value?.project
    const q = (logTaskQuery.value || '').trim()
    // 有搜索词就不再按项目挡（见 logTaskScope 注释）
    const scopeAll = logTaskScope.value === 'all' || !!q
    const all = [...tasks.value, ...archivedTasks.value]
    const byId = new Map(all.map(t => [t.id, t]))
    const projName = (id: string) => {
      const p = projects.value.find(x => x.id === id)
      return String(p?.name || '')
    }
    // 去重：archive/ 里可能有与活跃区同 id 的副本（历史遗留 / 手工拷贝）
    const seen = new Set<string>()
    const pool = all.filter(t => {
      if (!t || seen.has(t.id)) return false
      seen.add(t.id)
      return true
    })
    // ⚠ 匹配/排序/状态档全部走 shared/taskPick —— 这里**不许**再自己写一套 includes。
    // 2026-11-13 之前这里是一条裸 `hay.includes(q)`：多词必死、匹配面缺标签与状态、
    // 命中后不复按相关度排。暮雨跨 5 天提了 5 次「约等于无 / 抄都抄不好」，前四次改的都是包装。
    const rows = taskPick(pool, {
      query: q,
      status: logTaskStatus.value,
      project: scopeAll ? '' : proj,
      projectName: projName,
    })
    const out = rows.map(r => ({
      id: r.task.id,
      title: r.task.title || '',
      status: r.task.status,
      project: normProject(r.task.project),
      // 命中最靠前的字段（无词为 null）—— 界面用它解释"为什么它在第一行"
      hitRank: r.rank === null ? -1 : TASK_PICK_FIELD_RANK[r.rank],
    }))
    // 无词时才按"最近更新"排（有词时 taskPick 已按相关度排好，别覆盖它）
    if (!q) {
      out.sort((a, b) =>
        Number(parseTime(byId.get(b.id)?.updated || 0)) - Number(parseTime(byId.get(a.id)?.updated || 0)))
    }
    return out
  })
  /**
   * 首屏给几条：
   *   · 有搜索词 → **20**，且**不再按项目分组**（见下方 logTaskGroups）。
   *     人已经知道要哪张，此时还按项目铺开就是"信息轰炸"（实测 17 组 × 8 条 = 76 行）。
   *   · 无搜索词 → 仍按项目分组、每组 ≤ 8（11-08 定过的，不推翻）。
   */
  const logTaskOptions = computed(() => {
    const q = (logTaskQuery.value || '').trim()
    if (q) return logTaskMatched.value.slice(0, LOG_TASK_QUERY_CAP)
    return logTaskShowAll.value ? logTaskMatched.value : logTaskMatched.value.slice(0, LOG_TASK_CAP)
  })
  const logTaskMoreHidden = computed(() => logTaskMatched.value.length > logTaskOptions.value.length)
  /** 候选总数（界面上要写“共几条”，不能只有一个"12"让人以为总共就 12 条） */
  const logTaskTotal = computed(() => logTaskMatched.value.length)
  /** 当前是否处于"搜索态"（搜索态不分组，按相关度平铺） */
  const logTaskSearching = computed(() => !!(logTaskQuery.value || '').trim())

  /**
   * 默认档是「未完成」时，被挡在门外的**已终态卡**有多少张（2026-11-08 第 4 条）。
   *
   * 实战里最常见的场景是「活干完了，回头补一条日志」—— 那时候要挂的卡恰好是
   * 完成/驳回，而默认档把它们全藏了，界面看起来就是"什么都搜不到"。
   * 不擅自改默认档（会一开面板就涌进几百张老卡），只把数字说出来并给一键切档。
   *
   * ⚠ 2026-11-13（卡 2b1e3d59）修：此前这里**自己又写了一遍匹配**（只比 id + 标题），
   * 而主匹配还比项目名 → 同一屏两个答案。实测搜 `fangcun` 时提示"另有 0 张"，
   * 切到完成档实际 43 张。现在走 `taskPickHiddenByStatus`，与主匹配**同一个函数**。
   */
  const logTaskDoneHidden = computed(() => {
    if (logTaskStatus.value !== 'open') return 0
    const proj = logEdit_.value?.project
    const q = (logTaskQuery.value || '').trim()
    const scopeAll = logTaskScope.value === 'all' || !!q
    const all = [...tasks.value, ...archivedTasks.value]
    const seen = new Set<string>()
    const pool = all.filter(t => {
      if (!t || seen.has(t.id)) return false
      seen.add(t.id)
      return true
    })
    return taskPickHiddenByStatus(pool, {
      query: q,
      status: 'open',
      project: scopeAll ? '' : proj,
      projectName: (id: string) => {
        const p = projects.value.find(x => x.id === id)
        return String(p?.name || '')
      },
    })
  })

  /**
   * 候选按**项目分组**（2026-11-08 第 6 条）。
   *
   * 原话：“日志关联任务依旧编辑体验稀烂，筛选能力稀烂……一点审美都没有”。
   * 上一版把 12 条候选摊成一根长条 checkbox 列表：id 占掉半行、标题被挤、项目只在
   * 右侧挂个小字，扫一眼分不出哪些是同一个项目的。分组之后：组头就是项目名 + 条数，
   * 组内只留「标题 + 状态」，id 退到右侧小字。**有已选中的组置顶** —— 继续挑同一批卡
   * 是最常见的下一步。
   */
  const logTaskGroups = computed(() => {
    const sel = new Set(normalizeLogTaskIds(logEdit_.value))
    // 搜索态**不分组**：按相关度平铺（见 logTaskFlat）。分组是"浏览"的形状，
    // 搜索是"定位"的形状，两者混在一起就是"搜了半天还在按项目翻"。
    if (logTaskSearching.value) return []
    const order: string[] = []
    const m = new Map<string, { key: string; project: string; label: string; items: any[] }>()
    for (const t of logTaskMatched.value) {
      const key = t.project || ''
      let g = m.get(key)
      if (!g) {
        const p = projects.value.find(x => x.id === key)
        g = { key, project: key, label: String(p?.name || key || '未归属项目'), items: [] }
        m.set(key, g)
        order.push(key)
      }
      g.items.push(t)
    }
    const groups = order.map(k => m.get(k)!).map(g => ({
      ...g,
      picked: g.items.some(i => sel.has(i.id)),
    }))
    groups.sort((a, b) =>
      Number(b.picked) - Number(a.picked) || b.items.length - a.items.length)
    return groups.map(g => {
      const expanded = logTaskShowAll.value || logTaskExpanded.value[g.key]
      const shown = expanded ? g.items : g.items.slice(0, LOG_GROUP_CAP)
      return { ...g, shown, hiddenCount: g.items.length - shown.length }
    })
  })
  /** 搜索态的平铺行（按相关度，最多 20 条） */
  const logTaskFlat = computed(() => logTaskOptions.value)
  function toggleLogTaskGroup(key: string): void {
    logTaskExpanded.value = { ...logTaskExpanded.value, [key]: !logTaskExpanded.value[key] }
  }

  /**
   * 界面上**第一行**是哪张卡（2026-11-08 第 4 条修；2026-11-13 扩到搜索态）。
   *
   * 原来的回车取的是 `logTaskMatched.value[0]` —— 那是**按更新时间**排的第一条，
   * 不是画面上第一条（画面按“含已选的组置顶”重排过）。于是“回车选第一条”
   * 选中的可能根本不在眼前第一行，用户以为它坏了。
   *
   * 现在取**渲染顺序**的第一行：
   *   · 搜索态 → 相关度第 1（`taskPick` 已经排好，这里不能再按更新时间挑）；
   *   · 浏览态 → 第一个组的第一个可见行。
   */
  const logTaskFirstVisible = computed(() => {
    if (logTaskSearching.value) return logTaskFlat.value[0] || null
    const g = logTaskGroups.value[0]
    return (g && g.shown && g.shown[0]) || logTaskMatched.value[0] || null
  })

  /** 搜索框回车 = 选中**屏幕上第一条**（心里已经有目标时，不该还逼他用鼠标去点） */
  function pickFirstLogTask(): void {
    const first = logTaskFirstVisible.value
    if (!first) return
    const e = logEdit_.value
    if (!e) return
    const cur = normalizeLogTaskIds(e)
    if (!cur.includes(first.id)) e.taskIds = [...cur, first.id]
    logTaskQuery.value = ''
  }

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
    logTaskExpanded.value = {}
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
    logTaskExpanded.value = {}
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
    logTaskScope, logTaskOpenOnly, logTaskStatus, logTaskShowAll, logTaskTotal, logTaskDoneHidden,
    logTaskGroups, logTaskExpanded, toggleLogTaskGroup, pickFirstLogTask,
    logTaskSearching, logTaskFlat,
    taskTitleOf, unlinkLogTask, addLogTaskExtra,
  }
}
