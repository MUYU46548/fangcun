/**
 * 任务状态 → CSS class 后缀（纯函数，2026-10-22 从 App.vue 抽出来）。
 *
 * 为什么单独一个文件：阻塞视图搬进 `views/BlockersView.vue` 之后，它也要用这个映射。
 * 如果各写一份，两边一漂移就会出现"同一个状态在阻塞页是红的、在看板是灰的"这种静默错版。
 * 未登记的字段（老写法 / 空值）一律落到 `draft` —— 与 App.vue 原来的兜底一致。
 */
export function statusClass(s: string): string {
  return {
    草稿: 'draft', 待审批: 'review', 待办: 'todo',
    进行中: 'doing', 待验收: 'verify', 完成: 'done', 驳回: 'reject',
  }[s] || 'draft'
}
