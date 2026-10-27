/**
 * 「哪些待办其实没人碰过」—— 纯逻辑（2026-10-27 卡 20261025-006 第三件）
 *
 * 为什么抽成纯函数、不埋在 App.vue 里：
 *   筛选判定是**口径**，不是布局。口径一旦写进组件，就只有"起得来界面"的机器能验它；
 *   本仓的教训是这类断言会变成"写了但从没执行过"。放在 shared/ 就能直接用 Node 跑。
 *
 * 三条口径（每条都对应一个曾经的误解）：
 *  ① **完成/驳回不算「没人碰」**。做完了没人读是正常的，把它们列进来等于制造噪音。
 *     ⚠ 但**状态为空算未完成** —— 没填 ≠ 做完（同 `boardCards.openOnly` 的判据）。
 *  ② **窗口内一条读卡记录都没有**时，不许报「N 张没人碰过」。
 *     那不是"没人碰"，那是"计量还没开始"——两者混在一起，用户会以为工具坏了。
 *     所以单独给 `windowEvents`，界面按它换文案。
 *  ③ **只认 mcp-usage.jsonl 里的记录**。你自己在界面里点开一张卡**不算**被读过
 *     （recordRead 只在 MCP 三件里调用）。这条必须写在界面上，否则数字会被误读成
 *     "这张卡从来没人看过"——它只说明"没有 agent 经 MCP 读过"。
 */

import { parseTime } from './time'

/** 送进判定的卡（只需要这几个字段，避免把整个 Task 拖进来） */
export interface NeverReadInput {
  id: string
  title?: string
  project?: string
  status?: string
  priority?: string
  /** ISO 或秒级 Unix 数字（两种写法本仓都有） */
  updated?: string | number
}

/** 某张卡在窗口内的读卡统计（来自 `readStats()`） */
export interface NeverReadStat {
  reads: number
  lastRead?: string
  lastVia?: string
}

export interface NeverReadRow extends NeverReadInput {
  /** 窗口内被读次数；进清单的一定是 0 */
  reads: number
}

export interface NeverReadResult {
  /** 0 引用的卡（已排序） */
  rows: NeverReadRow[]
  /** = rows.length，给界面直接用 */
  count: number
  /** 参与统计的「未完成」卡总数（分母） */
  openTotal: number
  /** 窗口内读卡事件条数；0 = 计量还没开始，界面不许报"没人碰过" */
  windowEvents: number
  /** 实际生效的窗口天数（0 = 不限时间） */
  days: number
}

/** 终态：做完的、被驳回的。它们不进「没人碰」清单。 */
const CLOSED_STATUSES = ['完成', '驳回']

/** 空状态算未完成 —— 没填 ≠ 做完 */
export function isOpenForRead(status?: string): boolean {
  const s = String(status ?? '').trim()
  if (!s) return true
  return !CLOSED_STATUSES.includes(s)
}

const PRIORITY_RANK: Record<string, number> = { 高: 0, 中: 1, 低: 2 }
function priorityRank(p?: string): number {
  const k = String(p ?? '').trim()
  return k in PRIORITY_RANK ? PRIORITY_RANK[k] : 1
}

function updatedMs(u?: string | number): number {
  // 走 shared/time.parseTime：数据里同时有 ISO 与**秒级 Unix 数字**两种写法，
  // `Date.parse('1793092764')` 会直接 NaN —— 那会让一半的卡都掉到"最久没动"的错误位置。
  const t = parseTime(u)
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY
}

/**
 * 挑出「窗口内 0 引用」的未完成卡。
 *
 * 排序：优先级 高→中→低；同优先级里**最久没更新的排前面**
 * （整理清单的价值就在这——先看那些躺得最久又标着高优先级的）。
 * 更新时间读不出来的排最后（不猜它很老，也不假装它很新）。
 */
export function pickNeverRead(
  tasks: NeverReadInput[],
  stats: Record<string, NeverReadStat>,
  opts: { days?: number; windowEvents?: number } = {},
): NeverReadResult {
  const days = Number.isFinite(opts.days as number) ? Number(opts.days) : 30
  const windowEvents = Number.isFinite(opts.windowEvents as number) ? Math.max(0, Number(opts.windowEvents)) : 0
  const seen = new Set<string>()
  const open: NeverReadInput[] = []
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const id = String(t?.id ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (!isOpenForRead(t.status)) continue
    open.push({ ...t, id })
  }
  const rows: NeverReadRow[] = []
  for (const t of open) {
    const st = stats ? stats[t.id] : undefined
    const reads = st && Number.isFinite(st.reads) ? Number(st.reads) : 0
    if (reads > 0) continue
    rows.push({ ...t, reads: 0 })
  }
  rows.sort((a, b) => {
    const pa = priorityRank(a.priority)
    const pb = priorityRank(b.priority)
    if (pa !== pb) return pa - pb
    const ua = updatedMs(a.updated)
    const ub = updatedMs(b.updated)
    if (ua !== ub) return ua < ub ? -1 : 1
    return String(a.id).localeCompare(String(b.id))
  })
  return { rows, count: rows.length, openTotal: open.length, windowEvents, days: days > 0 ? days : 0 }
}

/**
 * 界面上那一行文案 —— 口径必须跟数字在一起。
 * `windowEvents === 0` 时**不许**出现「没人碰过」字样：那是计量没开始，不是卡没人读。
 * 有记录时也必须带上「只算 agent 经 MCP 读卡」这句 —— 否则「13 张没人碰过」会被读成
 * "13 张从来没人看过"，而事实上你自己在界面里点开过它。
 */
export function neverReadSummary(r: NeverReadResult): string {
  if (!r.openTotal) return '当前没有未完成的卡'
  if (!r.windowEvents) {
    return `最近 ${r.days} 天还没有任何 agent 读卡记录 —— 现在说「没人碰过」会冤枉所有卡`
  }
  return `最近 ${r.days} 天 0 引用的未完成卡 ${r.count} 张 / 共 ${r.openTotal} 张`
    + `（只算 agent 经 MCP 读卡，你在界面里点开不算）`
}
