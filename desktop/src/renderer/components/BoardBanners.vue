<!--
  看板横幅（2026-10-30）—— App.vue 拆分的第二刀（卡 task-20261018-002）

  搬出来的是**只在看板活跃区出现**的横幅：
    · 已完成任务超期归档（2026-10-03 卡 012）
    · 待验收欠条（2026-10-31 暮雨第 5 条）

  2026-11-08 删除「驳回返工台」横幅 —— 暮雨原话：
  “返工台横幅没有一丁点作用，纯烦人，直接整个删掉。”
  删的是**横幅**，不是驳回这个状态：驳回卡仍按状态出现在看板里，整理体检里也仍统计
  “被驳回后没人管”，只是不再有一条常驻条子天天提醒他“你欠一个决定”。
  `shared/rework.ts` 的 `pickRework` 仍在（体检在用），只是界面不再渲染它。

  ⚠ 判据（renderer-web 在盯）：条数来自真身、两个出口真走通道、
    “没有待验收卡时整条消失”—— 搬组件**不许**把这些行为搬丢。
-->
<script setup lang="ts">
import type { PendingReviewList } from '../../shared/rework'
import { formatAge } from '../../shared/rework'

const props = defineProps<{
  archiveDays: number
  archiveOverdue: { count: number; items: Array<{ id: string; title: string; updated: string }> }
  reviewPending: PendingReviewList
  reviewOpen: boolean
  reviewHidden: boolean
}>()

const emit = defineEmits<{
  (e: 'archive-now'): void
  (e: 'archive-skip'): void
  (e: 'toggle-review'): void
  (e: 'hide-review'): void
  (e: 'accept-card', id: string): void
  (e: 'reject-card', id: string): void
}>()

const showArchive = () => Number(props.archiveDays) > 0 && Number(props.archiveOverdue?.count || 0) > 0
const showReview = () => Number(props.reviewPending?.count || 0) > 0 && !props.reviewHidden
const firstArchive = () => {
  const it: any = (props.archiveOverdue?.items || [])[0] || {}
  return it.title || it.id || '—'
}
const age = (d: unknown) => formatAge(Number(d))
</script>

<template>
  <div v-if="showArchive() || showReview()" class="board-banners">    <!-- 已完成任务自动归档：只在真有超期任务时出现，且不自动动手 —— 点按钮才移文件 -->
    <div v-if="showArchive()" class="archive-overdue-bar">
      <span>📦 有 <b>{{ archiveOverdue.count }}</b> 个已完成任务超过 {{ archiveDays }} 天没更新（如：{{ firstArchive() }}）</span>
      <button class="ghost font-[inherit]" @click="emit('archive-now')">移进归档区</button>
      <button class="ghost font-[inherit]" title="这次先不动，下次启动/刷新还会提示" @click="emit('archive-skip')">先不管</button>
    </div>

    <!-- 待验收欠条：卡在“待验收”不会自己消失，它欠你一个签字 -->
    <div v-if="showReview()" class="review-bar">
      <span class="review-ico">✅</span>
      <span class="review-txt">
        <b>{{ reviewPending.count }}</b> 张卡干完了，在等你验收（等得最久的{{ age(reviewPending.oldestDays) }}）
      </span>
      <button class="ghost font-[inherit]" @click="emit('toggle-review')">{{ reviewOpen ? '收起' : '展开这 ' + reviewPending.count + ' 张' }}</button>
      <button class="ghost font-[inherit]" title="本次不提醒；下次启动或刷新还会出现" @click="emit('hide-review')">先不管</button>
      <span class="review-why">“通过”=收口；“驳回”=写清哪里不行、退回让 AI 返工。停着不动它就一直挂在这儿。</span>
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
        驳回后这张卡会回到“驳回”状态（看板里按状态能看到）；想让它返工，在卡片上点“退回返工”。
        不想返工就归档 —— 归档 = 这件事不要了。
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

/* 待验收欠条：青绿 —— 它是待办事项，不是事故 */
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
</style>
