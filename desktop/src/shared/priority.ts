/**
 * 展示层优先级归一（2026-10-23 从 App.vue 抽出来）。
 *
 * 主进程 `parseTask` 已做过归一，这里只防历史数据里的英文残留。
 * ⚠ 不要在别处再写一套映射 —— 优先级别名表在主进程 `data/index.ts`。
 *
 * 为什么抽出来：日历视图搬成组件之后它也要用这个（`prioColor` 依赖三档中文）。
 * 各写一份迟早漂移，出现"同一个优先级在看板是红、在日历是灰"这种静默错版。
 */

const MAP: Record<string, string> = {
  '高': '高', '中': '中', '低': '低',
  high: '高', urgent: '高', critical: '高',
  medium: '中', normal: '中',
  low: '低',
}

export function localPriority(p: unknown): string {
  const s = String(p ?? '').trim()
  if (!s) return '中'
  return MAP[s.toLowerCase()] || s
}

export function priorityLabel(p: string): string {
  return p ? localPriority(p) : '—'
}
