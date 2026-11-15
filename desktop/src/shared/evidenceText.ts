/**
 * 证据行里的人话（2026-11-15 暮雨第三次提"界面依然很不美观"）
 *
 * 屏幕上真实长这样：
 *   `✔ 自检 2026-11-03T04:00:54.502Z · 6/6 判据通过`
 * 一条 40 多字符的行里，有 24 个字符是**没人读得懂的机器时间戳**（还带毫秒和 Z）。
 * 而这一栏每天被扫几十次 —— 它挤走的是真正该被看见的信息（几张卡、过没过）。
 *
 * 所以这一层只做一件事：**把机器时间翻成人读的本地时间**，其余原文一个字不动。
 * 三条口径：
 *  ① 认不出就原样返回 —— 绝不糊一个"刚刚/某天"（那是编）。
 *  ② 只替换 ISO 串本身，证据里的路径 / 命令 / 分数一个字符都不碰。
 *  ③ 用本地时区（`toLocale*` 那一路不在这里，走 `shared/time`），
 *     否则"自检 04:00Z"在东八区显示成 04:00，人以为凌晨跑过一次。
 */

/** ISO 8601（含毫秒 / Z / ±hh:mm 偏移）：`2026-11-03T04:00:54.502Z` */
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g

/** 两位补零 */
const p2 = (n: number): string => String(n).padStart(2, '0')

/**
 * 把一个 ISO 时刻转成 `11-03 12:00`（本地时区、无毫秒、同年不写年）。
 * 认不出 / 非法 → 返回空串（调用方据此保留原文）。
 */
export function shortLocalStamp(iso: string, now: Date = new Date()): string {
  const t = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const mm = p2(d.getMonth() + 1)
  const dd = p2(d.getDate())
  const hh = p2(d.getHours())
  const mi = p2(d.getMinutes())
  // 跨年才写年份 —— 同年加个 2026- 只是多占四个字符
  return d.getFullYear() === now.getFullYear()
    ? `${mm}-${dd} ${hh}:${mi}`
    : `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`
}

/**
 * 证据行 → 可读行。**只替换 ISO 时刻，其余原样**。
 *
 * @param text 卡上的 `证据:` 原文（如 `自检 2026-11-03T04:00:54.502Z · 6/6 判据通过`）
 * @param now  当前时间（只为判断"是不是同一年"，可注入以便断言）
 */
export function formatEvidence(text: string, now: Date = new Date()): string {
  const s = String(text ?? '')
  if (!s) return ''
  return s.replace(ISO_RE, (m) => shortLocalStamp(m, now) || m)
}

/**
 * 一屏上"还缺什么"的读数。
 *
 * 为什么要把这三个数单独算出来：真数据 12 张阶段卡里 10 张是「完成 + 三块齐全」，
 * 而界面上每天逐行重复「三块齐全」十遍 —— **重复的"正常"会把"不正常"淹掉**。
 * 现在正常行不再写这三个字，只在页头说一次"还有几张缺块"。
 */
export function planSummary(stages: Array<{ status?: string; missing?: string[] }>): {
  total: number
  done: number
  open: number
  missing: number
} {
  const list = Array.isArray(stages) ? stages : []
  let done = 0
  let missing = 0
  for (const s of list) {
    if (!s) continue
    if (String(s.status ?? '').trim() === '完成') done++
    if (Array.isArray(s.missing) && s.missing.length) missing++
  }
  return { total: list.length, done, open: list.length - done, missing }
}
