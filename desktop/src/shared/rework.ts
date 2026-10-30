/**
 * 驳回返工台 —— 纯逻辑（2026-10-30）
 *
 * 为什么有这块：暮雨原话「驳回的东西好像也永远不看，是方寸的缺陷吗？」
 * 是。看板上「完成 / 驳回」两列默认折叠（`DEFAULT_COLLAPSED_GROUPS`），
 * 而「驳回」在语义上**不是终态**：它是"这活没通过，还欠着返工或一个"算了"的决定"。
 * 折叠 + 没有出口 = 既没有返工、也没有被正式放弃，只是消失了。
 *
 * 所以这里只做一件事：把「被驳回、且至今没人再管」的卡挑出来，
 * 带上**最近一次驳回理由**和**已经晾了几天**，交给界面逐张处置（退回返工 / 归档）。
 *
 * 口径（别在界面里重算）：
 *  ① 只认 `status === '驳回'`；已归档的不算（归档本身就是处置过了）。
 *  ② 理由取 `result_log` 里**最后一条**驳回记录 —— 前几条是历史，最新那条才是这次为什么被驳回。
 *  ③ 时间认三种写法（ISO / 秒级 Unix / 毫秒），认不出来给 NaN，**绝不当成 0**
 *     （0 = 1970 年 → 「晾了 20000 天」这种假数字会把人吓跑）。
 *  ④ 没有理由也要列出来，但如实说「没写理由」—— 那是没拍板，不是"没问题"。
 */

export interface ReworkTaskLike {
  id: string
  title?: string
  status?: string
  archived?: boolean
  /** 结果记录（fm.result_log 摊平后就在顶层；也允许从 fm 里读） */
  result_log?: string
  /** 独立驳回理由（2026-10-30 起是权威来源；老卡没有这个字段时回落到 result_log） */
  reject_reason?: string
  fm?: Record<string, any>
  updated?: string | number
  created?: string | number
}

export interface ReworkRow {
  id: string
  title: string
  /** 最近一次驳回理由；空串 = 当时没写 */
  reason: string
  hasReason: boolean
  /** 晾了几天；时间认不出来 = NaN（界面显示 —，不许显示 0） */
  ageDays: number
  /** 归一时间（毫秒）；认不出来 = NaN */
  updatedMs: number
}

export interface ReworkList {
  rows: ReworkRow[]
  count: number
  /** 最久那张晾了几天；没有 = NaN */
  oldestDays: number
  /** 条数与最久天数合成的一句话（页面必须把数字和话一起说） */
  text: string
}

const DAY = 86400000

/** 时间文本 → 毫秒。三种写法与 `data/tasks.ts` 的 `taskUpdatedMs` 同口径；认不出 = NaN。 */
export function parseWhen(v: unknown): number {
  if (v === undefined || v === null || v === '') return NaN
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return NaN
    return v > 1e12 ? v : v * 1000
  }
  const s = String(v).trim()
  if (!s) return NaN
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (!Number.isFinite(n) || n <= 0) return NaN
    return n > 1e12 ? n : n * 1000
  }
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : NaN
}

/**
 * 最近一次驳回理由。
 * 结果记录是**写给人看的本地时间行**：`[2026-10-30 12:34] 验收驳回：哪里不行`。
 * 取最后一条；理由可能为空（直接驳回不写结论）→ 返回空串，由调用方如实显示。
 */
export function lastRejectReason(resultLog: unknown): string {
  const text = String(resultLog ?? '')
  if (!text) return ''
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    // 「验收驳回」「审批驳回」「驳回（直接驳回）」都算；必须是一行**裁决记录**：
    // 要么以 `[时间]` 开头，要么整行以驳回词开头 —— 正文里"这一段在讨论驳回"不算。
    const m = /^(?:\[[^\]]+\]\s*)?(?:验收驳回|审批驳回|驳回)\s*[:：]?\s*(.*)$/.exec(line)
    if (!m) continue
    const reason = m[1].trim()
    // 「（没写理由）」是留痕占位，不是理由 —— 当成没写，界面才会如实点名
    if (!reason || /^（?没写理由）?$/.test(reason)) return ''
    return reason
  }
  return ''
}

function titleOf(t: ReworkTaskLike): string {
  const fromTop = String(t.title ?? '').trim()
  if (fromTop) return fromTop
  return String(t.fm?.title ?? '').trim()
}

/** 状态优先读摊平后的顶层；没摊平的卡（只从 fm 拿得到）也要认 */
function statusOf(t: ReworkTaskLike): string {
  const top = String(t.status ?? '').trim()
  if (top) return top
  return String(t.fm?.status ?? '').trim()
}

function logOf(t: ReworkTaskLike): string {
  const top = (t as any).result_log
  if (top !== undefined && top !== null) return String(top)
  return String(t.fm?.result_log ?? '')
}

function updatedOf(t: ReworkTaskLike): unknown {
  if (t.updated !== undefined && t.updated !== null && t.updated !== '') return t.updated
  return t.fm?.updated
}

/**
 * 挑出「被驳回、没人再管」的卡。**只看状态与是否已归档**，不猜"算不算处理过"。
 * 排序：晾得最久的排最前（先处理最久的），时间未知的排最后。
 */
export function pickRework(tasks: ReworkTaskLike[], nowMs?: number): ReworkList {
  const now = Number.isFinite(nowMs as number) ? Number(nowMs) : Date.now()
  const rows: ReworkRow[] = []
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || !t.id) continue
    if (statusOf(t) !== '驳回') continue
    if (t.archived) continue
    const direct = String(t.reject_reason ?? t.fm?.reject_reason ?? '').trim()
    const reason = direct || lastRejectReason(logOf(t))
    const updatedMs = parseWhen(updatedOf(t))
    const ageDays = Number.isFinite(updatedMs)
      ? Math.max(0, Math.floor((now - updatedMs) / DAY))
      : NaN
    rows.push({
      id: String(t.id),
      title: titleOf(t) || String(t.id),
      reason,
      hasReason: !!reason,
      ageDays,
      updatedMs,
    })
  }
  rows.sort((a, b) => {
    const av = Number.isFinite(a.updatedMs) ? a.updatedMs : Infinity
    const bv = Number.isFinite(b.updatedMs) ? b.updatedMs : Infinity
    if (av !== bv) return av - bv
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const known = rows.filter((r) => Number.isFinite(r.ageDays)).map((r) => r.ageDays)
  const oldestDays = known.length ? Math.max(...known) : NaN
  const count = rows.length
  const text = count === 0
    ? '没有被驳回后没人管的卡'
    : Number.isFinite(oldestDays)
      ? `${count} 张卡被驳回后没人再管（最早 ${oldestDays} 天前）`
      : `${count} 张卡被驳回后没人再管（时间认不出来，不敢替你算天数）`
  return { rows, count, oldestDays, text }
}
