/**
 * 待办：数据 / 筛选 / 排序 / 逾期 / 多选 / 编辑弹窗（2026-10-23 从 App.vue 抽出来）。
 *
 * 为什么先抽组合式函数、而不是直接把模板搬成组件：
 * `todos` 这一个 ref 被 App.vue 里 **60 处**共用（日历、在途一屏、日志转待办、快速记、
 * 项目统计都读它）。先把它和它的全部动作收进一处，界面仍留在 App.vue —— 这一步零行为变化、
 * 可整层回归；等这块稳了，再搬模板时才只需要「传一个 todos 进去」。
 *
 * 依赖只有两样**能力**（不是数据）：
 *   `toast`     —— 提示条是全站状态；
 *   `offerUndo` —— 撤销条也是全站的（勾选待办是最容易误点的一处，改完当场给撤销）。
 *
 * ⚠ 逾期判据不在这里算：走 `shared/time.isOverdue`（与看板任务卡同一个函数）。
 *   在别处再写一套「done/status/dueTime 三分支」迟早两处判据对不上。
 */
import { computed, ref, watch } from 'vue'
import { readUiPref, saveUiPref } from '../prefs'
import { makeDirtyGuard } from '../dirtyGuard'
import { localPriority } from '../../shared/priority'
import { formatDueTime, parseTime, daysSinceDue, isOverdue } from '../../shared/time'

/** 待办（主进程 todos/index.json 的形状） */
interface Todo {
  id: string
  title: string
  done: boolean
  /** ⚠ 实际存的是中文「高/中/低」（主进程 normalizePriority 归一） */
  priority: string
  due?: string
  dueTime?: string
  project?: string
  converted?: boolean
  createdAt: string
  updatedAt: string
}

export function useTodos(opts: {
  toast: (msg: string, type?: 'success' | 'error' | 'info') => void
  offerUndo: (label: string, run: () => Promise<void>) => void
}) {
  /** 关闭防丢（编辑弹窗）：打开存快照、关闭逐字节比对、改过才问 */
  const todoGuard = makeDirtyGuard()

// ── Todos ─────────────────────────────────────────────────────────
interface Todo {
  id: string
  title: string
  done: boolean
  // ⚠ 实际存的是中文「高/中/低」（主进程 normalizePriority 归一）。
  // 这里此前写成 'high' | 'normal' | 'low' —— 类型与数据不符，是历史残留。
  priority: string
  due?: string
  project?: string
  createdAt: string
  updatedAt: string
}
const todos = ref<Todo[]>([])
const todoFilter = ref('all')

// 多选（2026-09-30 用户补充：「待办和回收站也加入多选，这些也是常用场景」）
// —— 复用看板/日志同一套交互：工具条开关 + 卡片点选 + 悬浮批量栏。
const todoBatchMode = ref(false)
const selectedTodoBatch = ref<string[]>([])

// ── 待办列表：筛选 / 排序 / 逾期 / 统计（2026-09-26 卡 033 专项整修）──────
// 本次修的四件事（都是"用起来别扭"的真因，不是零敲碎打）：
//   ① 项目筛选原来是**漏筛**（`!t.project || t.project === X`）：选了项目 X 还会显示不归属的，
//      看着就像"筛选坏了"。现在精确匹配，并单列「（不归属任何项目）」这一项。
//   ② 同一个下拉既当筛选又当"新建默认归属"，两件事挤在一个控件里 → 现在只当筛选；
//      新建归属走「＋ 新建待办」（弹窗里本来就有项目字段，且默认跟随当前筛选）。
//   ③ 排序规则不可见、也不可选 → 加排序下拉（默认 / 到期日 / 最新创建），选择持久化。
//   ④ 有到期日却不标逾期、优先级只有"高"有徽章 → 现在三档都显示，逾期单独标红并算天数。
const todoProjectFilter = ref('__all__')
const todoSort = ref<string>(readUiPref<string>('fc_todo_sort', 'default'))
watch(todoSort, v => saveUiPref('fc_todo_sort', v))

function overdueDays(t: any): number {
  // 有时分时按合成的分钟级时间算（否则「21:39 已过 10 分钟」会算成"逾期 0 天"）。
  // 算术本体在 shared/time.daysSinceDue —— App.vue 里不许内联"一天多少毫秒"的除法（守卫盯着）。
  const d = daysSinceDue(t?.due, t?.dueTime)
  return Number.isFinite(d) ? Math.floor(d) : 0
}
function prioClass(p: string): string {
  const v = localPriority(p)
  return v === '高' ? 'high' : v === '低' ? 'low' : 'mid'
}

/** 已转出源的折叠（2026-10-09 用户第 1 条）：折叠不是删除 —— 展开可见、可撤销 */
const showConvertedTodos = ref(false)
const convertedTodosCount = computed(() => todos.value.filter(t => t.converted).length)

const filteredTodos = computed(() => {
  let list = todos.value
  if (todoFilter.value === 'active') list = list.filter(t => !t.done)
  if (todoFilter.value === 'done') list = list.filter(t => t.done)
  if (todoProjectFilter.value === '__none__') list = list.filter(t => !t.project)
  else if (todoProjectFilter.value !== '__all__') list = list.filter(t => t.project === todoProjectFilter.value)
  // 已转出（转换时勾了「顺手标已转出」）默认折叠 —— 这是**折叠不是删除**，展开按钮在列表末尾
  if (!showConvertedTodos.value) list = list.filter(t => !t.converted)

  const arr = list.slice()
  if (todoSort.value === 'due') {
    arr.sort((a: any, b: any) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      // 没有到期日的排最后 —— 不假装它们是"最近的"
      const ta = a.due ? Number(parseTime(a.due)) : Number.POSITIVE_INFINITY
      const tb = b.due ? Number(parseTime(b.due)) : Number.POSITIVE_INFINITY
      const va = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY
      const vb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY
      if (va !== vb) return va - vb
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    })
  } else if (todoSort.value === 'created') {
    arr.sort((a: any, b: any) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    })
  } else if (todoSort.value === 'priority') {
    // 2026-10-01 用户第 2 条：优先级单独成一种排法。localPriority 归一（high/critical → 高）
    const rank = (t: any) => {
      const p = localPriority(t?.priority)
      return p === '高' ? 0 : p === '低' ? 2 : 1
    }
    arr.sort((a: any, b: any) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      const d = rank(a) - rank(b)
      if (d) return d
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    })
  } else if (todoSort.value === 'updated') {
    arr.sort((a: any, b: any) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      const ta = new Date(a.updatedAt || a.createdAt || 0).getTime()
      const tb = new Date(b.updatedAt || b.createdAt || 0).getTime()
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0)
    })
  }
  return arr
})

const todoStats = computed(() => {
  const total = todos.value.length
  return {
    active: todos.value.filter(t => !t.done).length,
    overdue: todos.value.filter(t => isOverdue(t)).length,
    // hidden 只统计**筛选**遮住的：折叠掉的「已转出」有自己的展开入口，不算进「清除筛选」
    hidden: total - filteredTodos.value.length
      - (showConvertedTodos.value ? 0 : convertedTodosCount.value),
  }
})

/**
 * 当前筛选选中的项目 id —— 哨兵值（__all__ / __none__）一律当"没有选中项目"。
 *
 * 2026-09-26 卡 033：项目下拉原来是"筛选 + 新建默认归属"两用，而 `__none__` 这类
 * 哨兵值只要漏一处判断，就会把 '__none__' 当成项目 id 写进 todo.project（脏数据）。
 * 统一从这一个函数取，杜绝漏判。
 */
function todoProjectFilterProject(): string | undefined {
  const v = todoProjectFilter.value
  return v === '__all__' || v === '__none__' ? undefined : v
}

function clearTodoFilters(): void {
  todoFilter.value = 'all'
  todoProjectFilter.value = '__all__'
}

const todoHealthIssue = ref<any>(null)

async function loadTodos() {
  try {
    todos.value = await window.tegula.todosList()
  } catch {
    todos.value = []
  }
  // 坏文件被隔离过就要显性化 —— 否则用户只看到"待办空了"，不知道发生过什么
  try {
    const h: any = await window.tegula.todosHealth()
    todoHealthIssue.value = h && h.lastError ? h.lastError : null
  } catch {
    todoHealthIssue.value = null
  }
}

async function importTextLinesAsTodos(files: File[]): Promise<void> {
  const usable = files.filter(f => /\.(txt|md)$/i.test(f.name))
  if (!usable.length) {
    opts.toast('仅支持 .txt / .md 文件', 'error')
    return
  }
  const project = todoProjectFilterProject()
  const existing = new Set(todos.value.map(t => t.title.trim()))
  const unique: string[] = []
  const dupInBatch: string[] = []
  for (const f of usable) {
    const text = await f.text()
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      if (existing.has(t) || unique.includes(t)) { dupInBatch.push(t); continue }
      unique.push(t)
    }
  }
  const dupTotal = dupInBatch.length
  if (!unique.length) {
    opts.toast(dupTotal ? `全部 ${dupTotal} 条都是已存在的同名待办，未新增` : '没有可导入的行', 'info')
    return
  }
  if (dupTotal) {
    const sample = dupInBatch.slice(0, 3).join('、')
    if (!confirm(`有 ${dupTotal} 条与现有待办重复，将被跳过：\n${sample}${dupTotal > 3 ? ' …' : ''}\n\n继续导入剩余 ${unique.length} 条？`)) {
      opts.toast('已取消导入', 'info')
      return
    }
  }
  let added = 0
  for (const title of unique) {
    const r = await window.tegula.todosCreate(title, '中', undefined, project)
    if (r.ok) added++
  }
  opts.toast(`已导入 ${added} 条待办${dupTotal ? `，跳过 ${dupTotal} 条重复` : ''}`, added ? 'success' : 'error')
  loadTodos()
}

async function toggleTodo(id: string) {
  // 旧值先记下来（2026-10-21 · 1B 修正版）：撤销必须"改回原样"，不能靠再翻一次 ——
  // `todosToggle` 是翻转，中间要是有别处也动过这条，再翻一次就翻错了。
  const before = todos.value.find((t: any) => t.id === id)
  const prevDone = !!before?.done
  const title = before?.title || id
  const result = await window.tegula.todosToggle(id)
  if (result.ok) {
    loadTodos()
    // 勾选框是最容易误点的一处（一行一个、紧挨着标题）——改完当场给撤销，不用回头找。
    opts.offerUndo(prevDone ? `已取消完成：${title}` : `已完成：${title}`, async () => {
      const back: any = await window.tegula.todosUpdate(id, { done: prevDone } as any)
      await loadTodos()
      if (!back || back.ok === false) throw new Error(back?.error || '这条待办已被改动，改不回去了')
    })
  }
}

async function deleteTodo(id: string) {
  if (!confirm('确定删除此待办？')) return
  await window.tegula.todosDelete(id)
  opts.toast('已删除', 'success')
  loadTodos()
}

// ── 待办多选（2026-09-30 用户补充：「待办和回收站也加入多选，这些也是常用场景」）──
// 交互与看板/日志同一套：工具条开关 → 点卡片勾选 → 悬浮批量栏执行。
// 批量完成走 todosUpdate({done}) 显式置值（todosToggle 是翻转，混合状态下批量翻会错乱）。
function toggleTodoBatchMode() {
  todoBatchMode.value = !todoBatchMode.value
  if (!todoBatchMode.value) selectedTodoBatch.value = []
  else opts.toast('批量模式：点击卡片勾选，再从下方批量栏执行', 'success')
}
function toggleTodoBatchSelect(id: string) {
  const idx = selectedTodoBatch.value.indexOf(id)
  if (idx >= 0) selectedTodoBatch.value.splice(idx, 1)
  else selectedTodoBatch.value.push(id)
}
function onTodoItemClick(todo: any) {
  // 多选模式下整卡点选；平时卡片空白处点击不做事（勾选/编辑/动作各有入口）
  if (todoBatchMode.value) toggleTodoBatchSelect(todo.id)
}
function toggleSelectAllTodos() {
  if (selectedTodoBatch.value.length === filteredTodos.value.length) selectedTodoBatch.value = []
  else selectedTodoBatch.value = filteredTodos.value.map((t: any) => t.id)
}
function exitTodoBatch() {
  selectedTodoBatch.value = []
  todoBatchMode.value = false
}
async function executeBatchTodoDone(done: boolean) {
  const ids = [...selectedTodoBatch.value]
  if (!ids.length) return
  let ok = 0
  for (const id of ids) {
    try {
      const r: any = await window.tegula.todosUpdate(id, { done } as any)
      // 真后端返回 Todo|null（null = 没这条）；假后端返回 {ok:...} —— 两边都按「真成功」计数
      if (r && r.ok !== false) ok++
    } catch { /* skip */ }
  }
  opts.toast(`已${done ? '标为完成' : '取消完成'} ${ok}/${ids.length} 条待办`, ok ? 'success' : 'error')
  exitTodoBatch()
  loadTodos()
}
async function executeBatchTodoDelete() {
  const ids = [...selectedTodoBatch.value]
  if (!ids.length) return
  if (!confirm(`批量删除 ${ids.length} 条待办？\n\n不可恢复（待办不进回收站）。`)) return
  let ok = 0
  for (const id of ids) {
    try {
      await window.tegula.todosDelete(id)
      ok++
    } catch { /* skip */ }
  }
  opts.toast(`已删除 ${ok}/${ids.length} 条待办`, ok ? 'success' : 'error')
  exitTodoBatch()
  loadTodos()
}

// ── 待办编辑弹窗（2026-09-25 用户第 12、14 条）───────────────────────
// 真因：`todosUpdate` 在 preload / IPC / service **三层早就通了**（service 也不拦已完成的任务），
// 但渲染层**从来没有入口** —— 用户感知就是「待办不能编辑」「签下（勾选）之后更不能改」。
// 所以第 12 条（要模态大框）和第 14 条（签下后不能编辑）是同一件事：补一个编辑弹窗。
const todoEdit_ = ref<any>(null)
const todoEditSaving = ref(false)

function openTodoEditor(todo: any) {
  todoEdit_.value = {
    id: todo.id,
    title: todo.title || '',
    priority: localPriority(todo.priority),
    due: todo.due || '',
    // 到期时间（2026-10-12）：过 formatDueTime 归一 —— 存量数据里若是 `21:39:00` 这类
    // 非标准写法，`<input type="time">` 认不了会显示空白，用户会以为"没设过"。
    dueTime: formatDueTime(todo.dueTime),
    project: todo.project || '',
    done: !!todo.done,
  }
  todoGuard.open(todoEdit_.value)
}

function closeTodoEditor() {
  // 族1（卡004）：此前裸置 null = 改了点取消/遮罩就静默丢
  if (todoGuard.dirty(todoEdit_.value) && !confirm('待办内容尚未保存，确定关闭并丢弃吗？')) return
  todoEdit_.value = null
  todoGuard.clear()
}

// 同一弹窗复用成「新建」（第 12 条要的是**创建**也用大框，不只是编辑）
function openTodoCreator() {
  todoEdit_.value = {
    id: '',
    title: '',
    priority: '中',
    due: '',
    dueTime: '',
    // 默认归属跟随当前筛选（哨兵值 '__all__'/'__none__' 一律当"不归属"）
    project: todoProjectFilterProject() || '',
    done: false,
  }
  todoGuard.open(todoEdit_.value)
}

async function saveTodoEdit() {
  const t = todoEdit_.value
  if (!t) return
  if (!String(t.title).trim()) { opts.toast('待办内容不能为空', 'info'); return }
  // 只填了时间没填日期 → 时间落不到哪一天上。问一句比默默拼今天更诚实。
  if (t.dueTime && !t.due) {
    opts.toast('填了时间但没填到期日 —— 先选个日期（时间挂在哪天）', 'info')
    return
  }
  todoEditSaving.value = true
  try {
    const title = String(t.title).trim()
    const r = t.id
      ? await window.tegula.todosUpdate(t.id, {
          title,
          priority: t.priority,
          due: t.due || '',
          // 空串 = 清空（服务端归 undefined，字段从 JSON 消失）—— 不是存个空值
          dueTime: t.dueTime || '',
          project: t.project || '',
        })
      : await window.tegula.todosCreate(title, t.priority, t.due || '', t.project || '', '', t.dueTime || '')
    if (r && (r.ok || r.id || r.todo)) {
      opts.toast(t.id ? '已保存' : '已添加', 'success')
      todoEdit_.value = null
      await loadTodos()
    } else {
      opts.toast('保存失败：' + ((r && r.error) || '未知错误'), 'error')
    }
  } catch (e: any) {
    opts.toast('保存失败：' + (e?.message || e), 'error')
  } finally {
    todoEditSaving.value = false
  }
}

  return {
    todos, todoFilter, todoProjectFilter, todoSort, showConvertedTodos,
    convertedTodosCount, filteredTodos, todoStats, todoHealthIssue,
    todoProjectFilterProject, clearTodoFilters, overdueDays, prioClass, loadTodos,
    importTextLinesAsTodos, toggleTodo, deleteTodo,
    todoBatchMode, selectedTodoBatch, toggleTodoBatchMode, toggleTodoBatchSelect,
    onTodoItemClick, toggleSelectAllTodos, exitTodoBatch,
    executeBatchTodoDone, executeBatchTodoDelete,
    todoEdit_, todoEditSaving, openTodoEditor, closeTodoEditor, openTodoCreator, saveTodoEdit,
  }
}
