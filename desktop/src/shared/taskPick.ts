/**
 * 「挑一张卡」的检索 —— 唯一真源（2026-11-13 · 卡 `日志关联任务候选搜索是单串-includ-2b1e3d59`）
 *
 * 为什么会有这个文件：同一件"在一堆卡里按关键词找一张"的事，本仓此前**各写各的**：
 *   · `App.vue` 阻塞任务选择器     —— 多词 AND + slice(0,20)   （对的）
 *   · `CalendarView.vue` 未排期列表 —— 多词 AND                  （对的）
 *   · `useLogEditorOpen.ts` 日志关联任务 —— **整串子串比** `hay.includes(q)`（错的）
 * 于是暮雨跨 5 天说了 5 次「日志关联任务筛选约等于无 / 抄本项目的东西都抄不好」，
 * 前四次修的都是**包装**（按项目过滤 / 多选 / 按需展开 / 分组），一次都没碰**匹配**。
 *
 * 结论：不是谁水平不够，是**这件事没有单一真源**，于是每个新入口都从零犯错一遍。
 * 这里把它抽成纯函数，三处都调它；`scripts/test/e2e-task-pick.cjs` 直接跑编译产物断言，
 * 不依赖起界面（本仓渲染层真点击 e2e 常年 SKIP）。
 *
 * 四条纪律：
 *  ① **多词 = AND，不是整串子串**。「日志 筛选」要能命中标题里分开写着"日志"和"筛选"的卡；
 *     反过来，只有整串连着的才算命中 —— 那是用户没表达清楚，不是他要的。
 *  ② **匹配面必须说清楚**：id / 标题 / 项目 id / 项目名 / 标签 / 状态。
 *     人记得的往往是"绒花墨坊那张"或"待验收的那几张"，不是标题里的字。
 *  ③ **有词就按相关度排**，没词才按调用方给的顺序（通常是最近更新）。
 *     相关度顺序固定为 标题 > 标签 > 项目 > id > 状态 —— 页面上要能解释"为什么它在第一行"。
 *  ④ **计数与命中必须同一个函数**（`taskPickCount` 就是 `taskPick` 的 length）。
 *     本卡实测过反例：搜 `fangcun` 时提示"另有 0 张没显示"，切到完成档实际 43 张 ——
 *     因为提示只比 id+标题，主匹配还比项目名。同一屏两个答案，比没有提示更糟。
 */

/** 送进检索的卡（只需要这几个字段，避免把整个 Task 拖进来） */
export interface TaskPickInput {
  id: string
  title?: string
  /** 单值或数组都认（本仓两种写法都有） */
  project?: string | string[]
  status?: string
  /** 数组 / 空格分隔串都认（老数据里有 `标签: a b` 这种写法） */
  tags?: string | string[]
  /** 已判终态（完成 / 驳回），由调用方传入口径，这里不自己定义状态机 */
  isDone?: boolean
}

/** 命中排序用的档位：数字越小越靠前 */
export const TASK_PICK_FIELD_RANK = {
  title: 0,
  tags: 1,
  project: 2,
  id: 3,
  status: 4,
} as const

export type TaskPickField = keyof typeof TASK_PICK_FIELD_RANK

/** 一张卡被拆出来的可搜文本（一次拆好，搜索时复用，避免每词重建字符串） */
interface Hay {
  id: string
  title: string
  project: string
  tags: string
  status: string
}

const TERMINAL_STATUSES = ['完成', '驳回']

/** 数组 or 分隔串 → 小写字符串（统一空格分隔） */
function joinLoose(v: string | string[] | undefined): string {
  if (!v) return ''
  if (Array.isArray(v)) return v.map(x => String(x || '')).join(' ').toLowerCase()
  return String(v)
    .replace(/[,，;；、]/g, ' ')
    .toLowerCase()
}

/**
 * 项目字段可能是 `['a','b']`，也可能是写坏了的 `'- fangcun-base'`（YAML 块式列表被当成标量读进来）。
 * 两种都要认，否则那张卡在按项目搜时**永远搜不到**（实测：有 8 张是这样）。
 *
 * ⚠ 只剥**开头的列表标记**（`- ` / `* `），**不能**把 id 里的连字符也当标记删掉 ——
 * `fangcun-base` 变成 `fangcun base` 就再也搜不到了。这条是首跑断言当场抓到的。
 */
function projectHay(v: string | string[] | undefined): string {
  if (!v) return ''
  const raw = Array.isArray(v) ? v.join(' ') : String(v)
  return raw
    .split(/\s+/)
    .map(x => x.replace(/^[-*+]+/, '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function toHay(t: TaskPickInput, projectName?: (id: string) => string): Hay {
  const projIds = Array.isArray(t.project) ? t.project : (t.project ? String(t.project).split(/\s+/) : [])
  // 写坏的 `'- fangcun-base'` 也要拆出真 id（只剥开头列表标记，不碰 id 里的连字符），才能查出项目名
  const ids = projIds
    .map(x => String(x || '').replace(/^[-*+]+/, '').trim())
    .filter(Boolean)
  const names = ids.map(id => (projectName ? String(projectName(id) || '') : '')).filter(Boolean)
  return {
    id: String(t.id || '').toLowerCase(),
    title: String(t.title || '').toLowerCase(),
    project: (projectHay(t.project) + ' ' + names.join(' ').toLowerCase()).trim(),
    tags: joinLoose(t.tags),
    status: String(t.status || '').toLowerCase(),
  }
}

/**
 * 一张卡是否命中查询词。
 *
 * 空词 = 命中一切（调用方自己决定要不要按项目/状态先筛）。
 * 多词 = **每个词都要命中**（AND），但每个词可以命中**不同字段** ——
 * 「绒花 待验收」= 项目是绒花 且 状态是待验收，这是人真实的说法。
 */
export function taskPickMatches(h: Hay, query: string): boolean {
  const words = normalizeQuery(query)
  if (!words.length) return true
  const fields = [h.title, h.tags, h.project, h.id, h.status]
  return words.every(w => fields.some(f => f.includes(w)))
}

/** 把查询串拆成小写词（中文不分词，靠空格；全角空格也认） */
export function normalizeQuery(query: string): string[] {
  return String(query || '')
    .replace(/[\u3000\u00a0]/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * 相关度：命中字段里**最靠前**的那一档（标题 0 … 状态 4）。
 * 返回 `null` = 没命中。多词取**最差**的那一档（两个词都命中的卡要比只命中一个词的更相关，
 * 但这条由匹配本身保证；这里只回答"最好的命中点在哪"）。
 */
export function taskPickRank(h: Hay, query: string): TaskPickField | null {
  const words = normalizeQuery(query)
  if (!words.length) return null
  const buckets: Array<[TaskPickField, string]> = [
    ['title', h.title],
    ['tags', h.tags],
    ['project', h.project],
    ['id', h.id],
    ['status', h.status],
  ]
  let worst: TaskPickField | null = null
  for (const w of words) {
    let best = -1
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i][1].includes(w)) { best = i; break }
    }
    if (best < 0) return null       // 有一个词没命中 → 整张不算命中（与 taskPickMatches 同口径）
    const field = buckets[best][0]
    if (worst === null || TASK_PICK_FIELD_RANK[field] > TASK_PICK_FIELD_RANK[worst]) worst = field
  }
  return worst
}

export interface TaskPickOptions {
  /** 查询词；空串 = 不排序、原序返回 */
  query?: string
  /**
   * 只留某个项目（空 = 不限）。
   *
   * ⚠ **精确匹配 project id，不是子串比**（2026-11-13 首跑被 e2e-renderer-web 当场抓到）：
   * `'demo2'.includes('demo')` 为真 → 选了「本项目 demo」却把 `demo2` 的卡也列进来了。
   * 项目是天然的隔离单元（暮雨原话），隔离靠的就是**相等**，不是"看起来像"。
   * 传数组 = 「属于其中任一」（本仓有卡同时挂多个项目）。
   */
  project?: string | string[]
  /** 'open' 只留未完成 / 'done' 只留终态 / 'all' 不限 */
  status?: 'open' | 'all' | 'done'
  /** 项目 id → 显示名（参与匹配：人记的是"绒花墨坊"不是 project-2） */
  projectName?: (id: string) => string
  /** 首屏上限；0 = 不限 */
  limit?: number
  /** 卡自己的终态判定（默认认 完成/驳回） */
  isDone?: (t: TaskPickInput) => boolean
}

export interface TaskPickRow<T extends TaskPickInput> {
  task: T
  /** 命中的最靠前字段；无查询词时为 null */
  rank: TaskPickField | null
}

/** 默认终态判定：完成 / 驳回 */
export function defaultIsDone(t: TaskPickInput): boolean {
  return TERMINAL_STATUSES.includes(String(t.status || ''))
}

/**
 * 项目字段 → **真正的 project id 列表**（精确相等用，不是子串）。
 *
 * 兼容两种写法：正常数组 `['a','b']`、以及写坏的 YAML 块式标量 `'- a'`。
 * 只剥开头的列表标记，**不动 id 里的连字符**（`fangcun-base` 不能变成 `fangcun base`）。
 * 逗号 / 分号分隔的也拆开（老数据里有 `项目: a, b`）。
 */
export function projectIdsOf(v: string | string[] | undefined | null): string[] {
  if (!v) return []
  const raw = Array.isArray(v) ? v.join(' ') : String(v)
  return raw
    .replace(/[,，;；、]/g, ' ')
    .split(/\s+/)
    .map(x => x.replace(/^[-*+]+/, '').trim())
    .filter(Boolean)
}

/**
 * 检索主函数 —— **所有"挑一张卡"的入口都该走这里**。
 *
 * 排序：有查询词时按 rank 升序（标题命中在前），同 rank 保持调用方给的顺序（V8 sort 稳定）；
 * 无查询词时**原样返回**（调用方通常已按最近更新排好，别在这里二次排序）。
 *
 * ⚠ 返回 `TaskPickRow`，**不是**只要命中的那些 —— 调用方需要 rank 才能解释"为什么它在第一行"，
 * 也需要它来画命中高亮。要纯结果就 `.map(r => r.task)`。
 */
export function taskPick<T extends TaskPickInput>(tasks: T[], opts: TaskPickOptions = {}): Array<TaskPickRow<T>> {
  const q = String(opts.query || '').trim()
  const wantProj = projectIdsOf(opts.project)
  const mode = opts.status || 'all'
  const isDone = opts.isDone || defaultIsDone
  const out: Array<TaskPickRow<T> & { _i: number }> = []

  for (let i = 0; i < (tasks || []).length; i++) {
    const t = tasks[i]
    if (!t) continue
    const done = isDone(t)
    if (mode === 'open' && done) continue
    if (mode === 'done' && !done) continue
    if (wantProj.length && !projectIdsOf(t.project).some(id => wantProj.includes(id))) continue
    const h = toHay(t, opts.projectName)
    if (!taskPickMatches(h, q)) continue
    out.push({ task: t, rank: taskPickRank(h, q), _i: i })
  }

  // 有词才按相关度；同 rank 保原序（_i 兜底，防止某些引擎上 sort 不稳定导致顺序乱跳）
  if (normalizeQuery(q).length) {
    out.sort((a, b) => {
      const ra = a.rank === null ? 99 : TASK_PICK_FIELD_RANK[a.rank]
      const rb = b.rank === null ? 99 : TASK_PICK_FIELD_RANK[b.rank]
      return ra - rb || a._i - b._i
    })
  }

  const lim = Number(opts.limit || 0)
  const sliced = lim > 0 ? out.slice(0, lim) : out
  return sliced.map(({ task, rank }) => ({ task, rank }))
}

/**
 * 「另有 N 张被这一档挡住了」—— 与 `taskPick` **共用同一个匹配函数**。
 *
 * 这个函数存在的唯一理由就是防那类自相矛盾：
 * 提示只算 id+标题、主匹配还算项目名 → 提示说 0 张、切过去 43 张。
 * 所以它内部就是把 status 切成 'all'，再减掉当前档已显示的那些。
 */
export function taskPickHiddenByStatus<T extends TaskPickInput>(tasks: T[], opts: TaskPickOptions = {}): number {
  const mode = opts.status || 'all'
  if (mode === 'all') return 0
  const all = taskPick(tasks, { ...opts, status: 'all', limit: 0 }).length
  const shown = taskPick(tasks, { ...opts, limit: 0 }).length
  return Math.max(0, all - shown)
}

/**
 * 界面上的**第一条**（回车 / 下方向键选中的那张）。
 *
 * 必须是"渲染顺序的第 1 行"，不是"数据里的第 1 条"—— 本卡实测过反例：
 * 旧实现取 `matched[0]`（按更新时间排），而画面按"含已选的组置顶"重排过，
 * 于是回车挂上的卡**根本不在眼前第一行**，用户以为它坏了。
 */
export function taskPickFirst<T extends TaskPickInput>(tasks: T[], opts: TaskPickOptions = {}): T | null {
  const rows = taskPick(tasks, { ...opts, limit: 1 })
  return rows.length ? rows[0].task : null
}
