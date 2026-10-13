/**
 * 时间解析/格式化 —— 统一入口（纯逻辑，可脚本直接断言）。
 *
 * 为什么单独抽出来：数据里同时存在三种时间写法
 *   ① ISO（桌面版自己写的：`2026-09-25T08:52:56.605Z`）
 *   ② **秒级 Unix 数字**（Python 版 tegula 写的：`1787930114` → `new Date("1787930114")` = Invalid Date）
 *   ③ `MM-DD`（截止日期这种没有年份的写法）
 * 以前每个调用点自己 `new Date(x)`，写法一变就静默变成 `Invalid Date` / `NaN天前`，
 * 而且**页面上看不出来是错的**（只显示个空或乱码）。统一走这里，坏输入一律给 '—'。
 */

/** 秒级时间戳与毫秒级的分界：1e11 秒 ≈ 公元 5138 年，1e11 毫秒 ≈ 1973 年，不会误判 */
const MS_THRESHOLD = 1e11

/** 解析成毫秒时间戳；无法解析返回 NaN（绝不返回 Invalid Date 对象） */
export function parseTime(v: unknown): number {
  if (v === null || v === undefined) return NaN
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return Number.isFinite(v) ? (v < MS_THRESHOLD ? v * 1000 : v) : NaN
  const s = String(v).trim()
  if (!s) return NaN
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return Number.isFinite(n) ? (n < MS_THRESHOLD ? n * 1000 : n) : NaN
  }
  const direct = Date.parse(s)
  if (!Number.isNaN(direct)) return direct
  // `MM-DD`：数据里确实这么写（截止日期），按今年补年份
  const md = s.match(/^(\d{1,2})-(\d{1,2})$/)
  if (md) {
    return new Date(new Date().getFullYear(), Number(md[1]) - 1, Number(md[2])).getTime()
  }
  return NaN
}

/** 日期（本地化），无法解析给 '—' */
export function formatDate(v: unknown): string {
  const t = parseTime(v)
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('zh-CN') : '—'
}

/** 日期 + 时分（备份列表用），无法解析回退原字符串（那可能是「未同步」之类的人类文本） */
export function formatDateTime(v: unknown): string {
  const t = parseTime(v)
  if (!Number.isFinite(t)) return v ? String(v) : '—'
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 相对时间（今天 / N天前 …），无法解析返回空串（不要显示「NaN月前」） */
export function relativeTime(v: unknown): string {
  const t = parseTime(v)
  if (!Number.isFinite(t)) return ''
  const diff = (Date.now() - t) / 86400000
  if (diff < 1) return '今天'
  if (diff < 7) return `${Math.floor(diff)}天前`
  if (diff < 30) return `${Math.floor(diff / 7)}周前`
  return `${Math.floor(diff / 30)}月前`
}

/** 距今多少天（过期/停滞判断用）；无法解析返回 NaN，调用方自行决定默认值 */
export function daysSince(v: unknown): number {
  const t = parseTime(v)
  return Number.isFinite(t) ? (Date.now() - t) / 86400000 : NaN
}

/**
 * 把「日期 + 可选时间」拼成一个**分钟级**时间戳（2026-10-12 待办时间字段）。
 *
 * 待办的 `due` 只到天，另有一个可选的 `dueTime`（`HH:MM`）。这里负责合体：
 *   · 只有日期        → 解析到**当天 00:00**（与老行为一致：老代码就是按天算逾期）
 *   · 日期 + 时间     → 解析到**当天那分钟**（`21:39` 即 `21:39:00`）
 *   · 只有时间没日期  → 用今天 + 那个时间（不然那个时间没法落地）
 *   · 都解析不了      → NaN（调用方当"没有截止"处理）
 *
 * ⚠ 为什么单独一个函数而不是让调用方各拼各的：`daysSince` / `isOverdue` / 界面显示
 *   三处都要这个合成值，各拼各的必然漂移（memory：单一来源）。
 */
export function parseDueAt(due: unknown, dueTime?: unknown): number {
  const d = String(due ?? '').trim()
  const t = String(dueTime ?? '').trim()
  const tm = t.replace(/：/g, ':').match(/^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/)

  if (!d && !tm) return NaN
  // 只有时间：挂到今天
  if (!d && tm) {
    const base = new Date()
    base.setHours(Number(tm[1]), Number(tm[2]), 0, 0)
    return base.getTime()
  }
  const day = parseTime(d)
  if (!Number.isFinite(day)) return NaN
  if (!tm) return day
  const at = new Date(day)
  at.setHours(Number(tm[1]), Number(tm[2]), 0, 0)
  return at.getTime()
}

/** 格式化 `HH:MM` 给界面用；认不出来返回空串（**不要**把乱码原样印出去） */
export function formatDueTime(v: unknown): string {
  const s = String(v ?? '').trim().replace(/：/g, ':')
  const m = s.match(/^(\d{1,2}):(\d{1,2})/)
  if (!m) return ''
  const hh = Number(m[1]); const mm = Number(m[2])
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return ''
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/**
 * 「日期 + 可选时间」距今多少天（可带小数），给逾期天数用。
 *
 * ⚠ 为什么不能只写 `daysSince(due)`：待办加了 `dueTime` 之后，`due = 今天` 且
 *   `dueTime = 21:39` 的待办在 22:00 就已经过期 21 分钟了，但 `daysSince` 按天算
 *   会给出 0（"今天到期的还没过期"）→ 界面上显示"逾期 0 天"这种自相矛盾的话。
 *
 * ⚠ 更不该在 App.vue 里内联 `/ 86400000`：e2e-calendar 有一条守卫专门盯
 *   「App.vue 不再自己写日期算术」（日期算术必须收在 shared/time.ts 这一处）。
 *   2026-10-12 我第一版就是内联写的，当场被这条守卫抓住 —— 挪到这里是对的。
 */
export function daysSinceDue(due: unknown, dueTime?: unknown): number {
  if (dueTime !== undefined && dueTime !== null && String(dueTime).trim() !== '') {
    const at = parseDueAt(due, dueTime)
    return Number.isFinite(at) ? (Date.now() - at) / 86400000 : NaN
  }
  return daysSince(due)
}

/** 通知面板用的「刚刚 / N 分钟前」，无法解析返回空串 */
export function relTimeShort(v: unknown): string {
  const t = parseTime(v)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return formatDate(v)
}
