/**
 * 派单闸门（2026-11-21 · 卡 `所有能主动开-dsh-会话的入口闸要下在-e4264e6c`）
 *
 * ## 这一层解决什么
 *
 * 2026-11-20 的「派单防滥用」只做到了"按钮冷却 + 签名"，默认值还是
 * **同时 10 个 / 不冷却 / 每日不限**。暮雨 2026-11-21 的定案改了口径：
 *
 * > 「不做上限，做**出厂不发车**。」
 *
 * 也就是：
 *   · `enabled` 默认 **false** —— 没被用户显式打开之前，**任何路径都开不出会话**；
 *   · 打开之后才谈冷却 / 日上限 / 在途；那三项只是第二道闸，不承担"别烧钱"的全部责任。
 *
 * ## 为什么是"共享文件"而不是两套配置
 *
 * 同一根管子的两端在不同进程里：
 *   · 方寸主进程（TS）**写**派单、决定"这次能不能写"；
 *   · `dsh-fangcun` 插件（JS，在 DSH 里）**消费**派单、决定"这次能不能开会话"。
 *
 * 两边各读一份自己的配置 = 迟早出现"方寸以为关了、插件以为开着"。
 * 所以真源是**数据根下的一个 JSON 文件**：
 *
 *     <数据根>/.dispatch-dsh/dispatch-settings.json
 *
 * 方寸设置页写它、插件消费端读它；两个进程都不缓存"上次读到什么"。
 * 文件不存在 / 读坏了 / 字段非法 → **按默认值（关）**，绝不因为读不到而放行。
 *
 * ## 判据顺序（先硬后软）
 *
 * ① `enabled === false` → `disabled`（结构上开不出来，最好懂）
 * ② 今天成功开过的会话数 ≥ `dailyCap`（0 = 不限）→ `daily-cap`
 * ③ 在途会话数 ≥ `concurrency` → `concurrency`
 * ④ 同一项目距上次成功派单 < `cooldownSec` → `cooldown`（带 `leftMs`）
 *
 * 只数 `ok:true` 的审计行：被拒的文件不占额度 —— 否则 agent 乱写文件就能把用户的额度耗光。
 *
 * ⚠ 这个模块**不碰 fs / electron**：主进程、渲染层、测试都能直接用它。
 *   读文件的部分在 `main/services/dispatchConfig.ts`，插件侧有一份逐字对齐的 JS 实现
 *   （`dsh-fangcun/lib/dispatch.js`），两边由跨语言契约测试钉住。
 */

/** 派单设置四项（卡里的「设置页四项」就是它） */
export interface DispatchSettings {
  /** 总开关。**默认 false**：没打开之前，任何路径都开不出会话 */
  enabled: boolean
  /** 同一项目两单之间至少隔多少秒（0 = 不冷却） */
  cooldownSec: number
  /** 每天最多成功开几个会话（0 = 不限；只数成功开过的） */
  dailyCap: number
  /** 同时在途的派单会话上限（1–100） */
  concurrency: number
}

/**
 * 出厂默认值（2026-11-21 定案）。
 *
 * ⚠ `enabled:false` 是这一版的**全部意义**：不是把 10 调成 1，而是出厂不发车。
 *   插件侧 `DISPATCH_DEFAULTS` 与本对象必须逐项一致（跨语言契约测试钉着）。
 */
export const DISPATCH_SETTINGS_DEFAULTS: DispatchSettings = {
  enabled: false,
  cooldownSec: 30,
  dailyCap: 3,
  concurrency: 1,
}

/** 各项的量程（校验与设置页共用；0 在 cooldownSec / dailyCap 里表示"不限"） */
export const DISPATCH_SETTINGS_LIMITS = {
  cooldownSec: { min: 0, max: 86400 },
  dailyCap: { min: 0, max: 1000 },
  concurrency: { min: 1, max: 100 },
} as const

/** 共享配置文件名（方寸写、插件读；两端逐字一致） */
export const DISPATCH_SETTINGS_FILENAME = 'dispatch-settings.json'

function intInRange(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/**
 * 把任意来源（手改的 JSON / 旧版本文件 / 请求体）归一成合法设置。
 *
 * **失败即关**：`enabled` 只认严格 `true` —— `"true"`、`1`、`"yes"` 都不算，
 * 因为"读不懂"时放行就等于把闸拆了。
 */
export function normalizeDispatchSettings(raw: unknown): DispatchSettings {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {}
  return {
    enabled: o.enabled === true,
    cooldownSec: intInRange(o.cooldownSec, DISPATCH_SETTINGS_LIMITS.cooldownSec.min, DISPATCH_SETTINGS_LIMITS.cooldownSec.max, DISPATCH_SETTINGS_DEFAULTS.cooldownSec),
    dailyCap: intInRange(o.dailyCap, DISPATCH_SETTINGS_LIMITS.dailyCap.min, DISPATCH_SETTINGS_LIMITS.dailyCap.max, DISPATCH_SETTINGS_DEFAULTS.dailyCap),
    concurrency: intInRange(o.concurrency, DISPATCH_SETTINGS_LIMITS.concurrency.min, DISPATCH_SETTINGS_LIMITS.concurrency.max, DISPATCH_SETTINGS_DEFAULTS.concurrency),
  }
}

/** 设置页保存时只传"这次改的项"；返回可直接落盘的局部值 */
export function validateDispatchSettingsPatch(input: unknown):
  { ok: true; patch: Partial<DispatchSettings> } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '设置必须是一个 JSON 对象' }
  }
  const keys = Object.keys(input as Record<string, unknown>)
  if (!keys.length) return { ok: false, error: '没有要保存的设置' }
  const patch: Partial<DispatchSettings> = {}
  for (const key of keys) {
    const raw = (input as Record<string, unknown>)[key]
    if (key === 'enabled') {
      if (typeof raw !== 'boolean') return { ok: false, error: '启用派单必须是 true / false' }
      patch.enabled = raw
      continue
    }
    if (key === 'cooldownSec' || key === 'dailyCap' || key === 'concurrency') {
      const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN)
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: `${key} 必须是整数` }
      const lim = DISPATCH_SETTINGS_LIMITS[key]
      if (n < lim.min || n > lim.max) {
        return { ok: false, error: `${key} 必须在 ${lim.min}–${lim.max} 之间` }
      }
      patch[key] = n
      continue
    }
    return { ok: false, error: '不认识的设置项：' + key }
  }
  return { ok: true, patch }
}

/** 审计行（`audit.jsonl` 一行一条；方寸与插件都往这个文件追加） */
export interface DispatchAuditRow {
  at?: string
  ok?: boolean
  reason?: string
  source?: string
  /** `gui-gate` = 方寸写侧闸门拒的；空/其它 = 插件消费端判的 */
  stage?: string
  project?: string
  kind?: string
  sessionId?: string
  file?: string
  error?: string
}

export type DispatchGateReason = 'ok' | 'disabled' | 'cooldown' | 'daily-cap' | 'concurrency'

export interface DispatchGate {
  ok: boolean
  enabled: boolean
  reason: DispatchGateReason
  /** 冷却剩余毫秒（只有 reason=cooldown 时 > 0） */
  leftMs: number
  /** 今天还能成功开几个（-1 = 不限；0 = 已用完） */
  leftToday: number
  /** 今天已成功开的会话数（只数 ok:true） */
  today: number
  dailyCap: number
  cooldownSec: number
  concurrency: number
  /** 这个项目上一次成功派单的 ISO 时刻（没有就是空串） */
  lastAt: string
}

/** 本地日期键（YYYY-MM-DD）。**不用 UTC**：用户眼里的"今天"是本地时间，不是伦敦时间。 */
export function localDayKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 审计行里的 `at` → 毫秒；认不出返回 NaN（**绝不当 0**，那会变成 1970 年） */
export function auditTime(row: DispatchAuditRow | null | undefined): number {
  if (!row || !row.at) return NaN
  const t = Date.parse(String(row.at))
  return Number.isFinite(t) ? t : NaN
}

/** 只数 `ok:true` 的行（被拒的派单不占额度） */
export function okRows(rows: DispatchAuditRow[] | null | undefined): DispatchAuditRow[] {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.ok === true)
}

/** 今天成功开过的会话数（本地日） */
export function countToday(rows: DispatchAuditRow[] | null | undefined, now: number): number {
  const day = localDayKey(now)
  return okRows(rows).filter((r) => {
    const t = auditTime(r)
    return Number.isFinite(t) && localDayKey(t) === day
  }).length
}

/** 某项目上一次成功派单的时刻（没有就是 NaN） */
export function lastOkFor(rows: DispatchAuditRow[] | null | undefined, project: string): number {
  const pid = String(project || '').trim()
  if (!pid) return NaN
  let last = NaN
  for (const r of okRows(rows)) {
    if (String(r.project || '') !== pid) continue
    const t = auditTime(r)
    if (!Number.isFinite(t)) continue
    if (!Number.isFinite(last) || t > last) last = t
  }
  return last
}

/**
 * **唯一判据**：方寸写侧、插件消费端、设置页 / health 都调它。
 *
 * @param projectId 目标项目（冷却按项目算；空串 = 只看全局项）
 * @param settings 当前生效的四项设置
 * @param rows     `audit.jsonl` 的已解析行
 * @param now      当前时刻（测试可注入）
 * @param inFlight 在途会话数（插件侧传真实 active；方寸写侧传同项目未消费派单数）
 * @param lastAttemptMs 这个项目上一次**写派单文件**的时刻（方寸写侧传；
 *        插件还没消费时审计里没有 `ok:true`，冷却不能因此失效 ——
 *        否则 DSH 关着时连点 5 次会写 5 份文件）
 */
export function checkDispatch(
  projectId: string,
  settings: DispatchSettings,
  rows: DispatchAuditRow[] | null | undefined,
  now: number = Date.now(),
  inFlight = 0,
  lastAttemptMs = NaN,
): DispatchGate {
  const s = normalizeDispatchSettings(settings)
  const today = countToday(rows, now)
  const lastMs = lastOkFor(rows, projectId)
  const attemptMs = Number.isFinite(lastAttemptMs) ? lastAttemptMs : NaN
  // 冷却起点 = max(上次成功开会话, 上次写文件)。两个都是"这一单发生过"的证据，
  // 取更近的那个：插件没跑时靠文件，插件跑过之后靠审计（文件已被删）。
  const lastAny = Number.isFinite(lastMs) && Number.isFinite(attemptMs)
    ? Math.max(lastMs, attemptMs)
    : (Number.isFinite(lastMs) ? lastMs : attemptMs)
  const cooldownMs = s.cooldownSec * 1000
  const base = {
    enabled: s.enabled,
    today,
    dailyCap: s.dailyCap,
    cooldownSec: s.cooldownSec,
    concurrency: s.concurrency,
    leftToday: s.dailyCap > 0 ? Math.max(0, s.dailyCap - today) : -1,
    lastAt: Number.isFinite(lastAny) ? new Date(lastAny).toISOString() : '',
  }

  if (!s.enabled) {
    return { ok: false, reason: 'disabled', leftMs: 0, ...base }
  }
  if (s.dailyCap > 0 && today >= s.dailyCap) {
    return { ok: false, reason: 'daily-cap', leftMs: 0, ...base }
  }
  if (inFlight >= s.concurrency) {
    return { ok: false, reason: 'concurrency', leftMs: 0, ...base }
  }
  if (cooldownMs > 0 && Number.isFinite(lastAny) && now - lastAny < cooldownMs) {
    return { ok: false, reason: 'cooldown', leftMs: cooldownMs - (now - lastAny), ...base }
  }
  return { ok: true, reason: 'ok', leftMs: 0, ...base }
}

/** 给界面 / 错误信息用的人话（“拒绝”也必须说清等多久、还剩多少） */
export function dispatchGateText(gate: DispatchGate): string {
  switch (gate.reason) {
    case 'disabled':
      return 'DSH 派单未启用 —— 到 设置 → Agent → DSH 派单 打开，否则任何入口都开不出会话'
    case 'cooldown':
      return `冷却中：还要 ${Math.max(1, Math.ceil(gate.leftMs / 1000))} 秒才能再派（同一项目防连点）`
    case 'daily-cap':
      return `今天已派出 ${gate.today}/${gate.dailyCap} 单 —— 到 设置 → Agent → DSH 派单 调高日上限，或明天再派`
    case 'concurrency':
      return `在途派单会话已满（上限 ${gate.concurrency}）—— 等手上的会话结束再派`
    default:
      return '可以派单'
  }
}
