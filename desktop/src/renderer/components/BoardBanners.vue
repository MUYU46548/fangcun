<!--
  看板横幅（2026-10-30）—— App.vue 拆分的第二刀（卡 task-20261018-002）

  搬出来的是**只在看板活跃区出现**的横幅：
    · 已完成任务超期归档（2026-10-03 卡 012）
    · 驳回返工台（2026-10-30 暮雨第 3 条）
    · 待验收欠条（2026-10-31 暮雨第 5 条）

  为什么先搬它们：三块都是「纯展示 + 两三个动作」，不持有视图状态；
  状态（archiveDays / archiveOverdue / rework / reworkOpen / reworkHidden /
  reviewPending / reviewOpen）仍在 App，组件只接 props、发事件 —— 与第一刀
  （DataHygienePanel）同一套拆法。

  ⚠ 判据（renderer-web 在盯）：条数来自真身、理由取最后一次驳回、出口真走通道、
  「没有驳回卡时整条消失」—— 搬组件**不许**把这些行为搬丢。
  ⚠ 新增的「待验收」条**必须用新类名**（`.review-bar` / `.review-row`）：
     `.rework-row` 被断言按条数数过，复用会让旧断言凭空变红（AGENTS 踩坑 #2）。
-->
<script setup lang="ts">
import type { ReworkList, PendingReviewList } from '../../shared/rework'
import { formatAge } from '../../shared/rework'

const props = defineProps<{
  archiveDays: number
  archiveOverdue: { count: number; items: Array<{ id: string; title: string; updated: string }> }
  rework: ReworkList
  reworkOpen: boolean
  reworkHidden: boolean
  reviewPending: PendingReviewList
  reviewOpen: boolean
  reviewHidden: boolean
}>()

const emit = defineEmits<{
  (e: 'archive-now'): void
  (e: 'archive-skip'): void
  (e: 'toggle-rework'): void
  (e: 'hide-rework'): void
  (e: 'rework-back', id: string): void
  (e: 'rework-archive', id: string): void
  (e: 'toggle-review'): void
  (e: 'hide-review'): void
  (e: 'accept-card', id: string): void
  (e: 'reject-card', id: string): void
}>()

const showArchive = () => Number(props.archiveDays) > 0 && Number(props.archiveOverdue?.count || 0) > 0
const showRework = () => Number(props.rework?.count || 0) > 0 && !props.reworkHidden
const showReview = () => Number(props.reviewPending?.count || 0) > 0 && !props.reviewHidden
const firstArchive = () => {
  const it: any = (props.archiveOverdue?.items || [])[0] || {}
  return it.title || it.id || '—'
}
const finite = (n: unknown) => Number.isFinite(Number(n))
const age = (d: unknown) => formatAge(Number(d))
</script>

<template>
  <div v-if="showArchive() || showRework() || showReview()" class="board-banners">    <!-- 已完成任务自动归档：只在真有超期任务时出现，且不自动动手 —— 点按钮才移文件 -->
    <div v-if="showArchive()" class="archive-overdue-bar">
      <span>📦 有 <b>{{ archiveOverdue.count }}</b> 个已完成任务超过 {{ archiveDays }} 天没更新（如：{{ firstArchive() }}）</span>
      <button class="ghost font-[inherit]" @click="emit('archive-now')">移进归档区</button>
      <button class="ghost font-[inherit]" title="这次先不动，下次启动/刷新还会提示" @click="emit('archive-skip')">先不管</button>
    </div>

    <!-- 待验收欠条：卡在「待验收」不会自己消失，它欠你一个签字 -->
    <div v-if="showReview()" class="review-bar">
      <span class="review-ico">✅</span>
      <span class="review-txt">
        <b>{{ reviewPending.count }}</b> 张卡干完了，在等你验收（等得最久的{{ age(reviewPending.oldestDays) }}）
      </span>
      <button class="ghost font-[inherit]" @click="emit('toggle-review')">{{ reviewOpen ? '收起' : '逐张过一遍' }}</button>
      <button class="ghost font-[inherit]" title="本次不提醒；下次启动或刷新还会出现" @click="emit('hide-review')">先不管</button>
      <span class="review-why">「通过」=收口；「驳回」=写清哪里不行、退回让 AI 返工。停着不动它就一直挂在这儿。</span>
    </div>
    <div v-if="reviewOpen && showReview()" class="review-panel">
      <div class="review-row" v-for="r in reviewPending.rows" :key="'rv-' + r.id">
        <div class="review-main">
          <div class="review-title">{{ r.title }}<span class="review-id">{{ r.id }}</span></div>
          <div class="review-sub">等验收 · {{ age(r.ageDays) }}</div>
        </div>
        <button class="ok font-[inherit]" title="通过验收（可写一句话验收结论）"
          @click="emit('accept-card', r.id)">✅ 通过</button>
        <button class="danger font-[inherit]" title="驳回：写清哪里不行，退回待办让 agent 返工"
          @click="emit('reject-card', r.id)">↩ 驳回</button>
      </div>
      <div class="review-foot">
        驳回后卡会回到「驳回」，你可以在下面那条里一键<b>退回返工</b>（回待办，agent 下次取活会先读到理由）。
        不想返工就归档 —— 归档 = 这件事不要了。
      </div>
    </div>

    <!-- 驳回返工台：驳回不是终态 —— 它欠一个返工或一个"算了" -->
    <div v-if="showRework()" class="rework-bar">
      <span class="rework-ico">↩</span>
      <span class="rework-txt">
        <b>{{ rework.count }}</b> 张卡停在「驳回」，还欠一个决定：返工还是不要了<template v-if="finite(rework.oldestDays)">，最早的是{{ age(rework.oldestDays) }}</template>
      </span>
      <button class="ghost font-[inherit]" @click="emit('toggle-rework')">{{ reworkOpen ? '收起' : '逐张过一遍' }}</button>
      <button class="ghost font-[inherit]" title="本次不提醒；下次启动或刷新还会出现" @click="emit('hide-rework')">先不管</button>
      <span class="rework-why">「完成 / 驳回」两列默认是折叠的 —— 不推这一条，被驳回的卡就是石沉大海</span>
    </div>
    <div v-if="reworkOpen && showRework()" class="rework-panel">
      <div class="rework-row" v-for="r in rework.rows" :key="'rw-' + r.id">
        <div class="rework-main">
          <div class="rework-title">{{ r.title }}<span class="rework-id">{{ r.id }}</span></div>
          <div class="rework-reason" :class="{ missing: !r.hasReason }">
            {{ r.hasReason ? '驳回理由：' + r.reason : '⚠ 驳回时没写理由 —— 那就说不清为什么退回来' }}
          </div>
        </div>
        <span class="rework-age" :title="finite(r.ageDays) ? '按任务更新时间算' : '更新时间认不出来，不替你编天数'">
          {{ age(r.ageDays) }}</span>
        <button class="ok font-[inherit]" title="回到待办；agent 下次取活会先读到驳回理由并优先返工"
          @click="emit('rework-back', r.id)">↩ 退回返工</button>
        <button class="ghost font-[inherit]" title="移进归档区（文件移到 task-data/archive/，可还原）"
          @click="emit('rework-archive', r.id)">📦 归档</button>
      </div>
      <div class="rework-foot">
        退回返工 = 回到待办，<b>agent 取活时会先读到这条驳回理由并优先返工</b>；归档 = 这件事不要了（归档就是处置过了，会从这条里消失）；「先不管」只藏这一次。
      </div>
    </div>
  </div>
</template>

<style scoped>
.archive-overdue-bar {
  margin: 8px 16px 0; padding: 8px 12px; background: #f4f8ff; border: 1px solid #d6e4f7;
  border-radius: 10px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: 12px; color: var(--ink); position: relative; z-index: 2;
}
.archive-overdue-bar b { color: var(--accent); }
.archive-overdue-bar .ghost { font-size: 11.5px; padding: 4px 10px; }
.archive-overdue-bar span { flex: 1 1 320px; }

/* 待验收欠条：青绿 —— 与"驳回"的警示橙分开，它是待办事项不是事故 */
.review-bar {
  margin: 8px 16px 0; padding: 8px 12px; background: #f2f9f3; border: 1px solid #cfe6d3;
  border-radius: 10px; display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
  font-size: 12px; color: var(--ink); position: relative; z-index: 2;
}
.review-ico { color: var(--success); font-weight: 700; }
.review-txt { flex: 0 1 auto; }
.review-bar b { color: var(--success); }
.review-bar .ghost { font-size: 11.5px; padding: 4px 10px; }
.review-why { flex: 1 1 260px; text-align: right; font-size: 10.5px; color: var(--muted); }
.review-panel {
  margin: 6px 16px 0; padding: 6px 10px; background: var(--card); border: 1px solid var(--border);
  border-radius: 10px; position: relative; z-index: 2; max-height: 46vh; overflow: auto;
}
.review-row { display: flex; align-items: center; gap: 10px; padding: 7px 2px; border-bottom: 1px dashed var(--border); flex-wrap: wrap; }
.review-row:last-of-type { border-bottom: none; }
.review-main { flex: 1 1 320px; min-width: 0; }
.review-title { font-size: 12.5px; font-weight: 600; }
.review-id { margin-left: 7px; font-size: 10.5px; color: var(--muted); font-weight: 400; }
.review-sub { margin-top: 2px; font-size: 11.5px; color: var(--muted); }
.review-row .ok, .review-row .danger { font-size: 11.5px; padding: 3px 9px; flex: 0 0 auto; }
.review-foot { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--line-2); font-size: 10.5px; color: var(--muted); }

/* 驳回返工台：与「已超期归档」同一套房线，但用警示色 —— 它不是通知，是一个还欠着决定的欠条 */
.rework-bar {
  margin: 8px 16px 0; padding: 8px 12px; background: #fff8f4; border: 1px solid #f2d6c8;
  border-radius: 10px; display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
  font-size: 12px; color: var(--ink); position: relative; z-index: 2;
}
.rework-ico { color: var(--danger); font-weight: 700; }
.rework-txt { flex: 0 1 auto; }
.rework-bar b { color: var(--danger); }
.rework-bar .ghost { font-size: 11.5px; padding: 4px 10px; }
.rework-why { flex: 1 1 260px; text-align: right; font-size: 10.5px; color: var(--muted); }
.rework-panel {
  margin: 6px 16px 0; padding: 6px 10px; background: var(--card); border: 1px solid var(--border);
  border-radius: 10px; position: relative; z-index: 2; max-height: 46vh; overflow: auto;
}
.rework-row { display: flex; align-items: center; gap: 10px; padding: 7px 2px; border-bottom: 1px dashed var(--border); flex-wrap: wrap; }
.rework-row:last-of-type { border-bottom: none; }
.rework-main { flex: 1 1 320px; min-width: 0; }
.rework-title { font-size: 12.5px; font-weight: 600; }
.rework-id { margin-left: 7px; font-size: 10.5px; color: var(--muted); font-weight: 400; }
.rework-reason { margin-top: 2px; font-size: 11.5px; color: var(--muted); line-height: 1.55; }
.rework-reason.missing { color: var(--warning); }
.rework-age { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; flex: 0 0 auto; }
.rework-row .ok, .rework-row .ghost { font-size: 11.5px; padding: 3px 9px; flex: 0 0 auto; }
.rework-foot { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--line-2); font-size: 10.5px; color: var(--muted); }
</style>
