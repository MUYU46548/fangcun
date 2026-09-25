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
