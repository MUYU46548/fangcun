<!--
  看板横幅（2026-10-30）—— App.vue 拆分的第二刀（卡 task-20261018-002）

  搬出来的是两条**只在看板活跃区出现**的横幅：
    · 已完成任务超期归档（2026-10-03 卡 012）
    · 驳回返工台（2026-10-30 暮雨第 3 条）

  为什么先搬它们：两块都是「纯展示 + 两三个动作」，不持有视图状态；
  状态（archiveDays / archiveOverdue / rework / reworkOpen / reworkHidden）仍在 App，
  组件只接 props、发事件 —— 与第一刀（DataHygienePanel）同一套拆法。

  ⚠ 判据（renderer-web 在盯）：条数来自真身、理由取最后一次驳回、两个出口真走通道、
  「没有驳回卡时整条消失」—— 搬组件**不许**把这些行为搬丢。
-->
<script setup lang="ts">
import type { ReworkList } from '../../shared/rework'

const props = defineProps<{
  archiveDays: number
  archiveOverdue: { count: number; items: Array<{ id: string; title: string; updated: string }> }
  rework: ReworkList
  reworkOpen: boolean
  reworkHidden: boolean
}>()

const emit = defineEmits<{
  (e: 'archive-now'): void
  (e: 'archive-skip'): void
  (e: 'toggle-rework'): void
  (e: 'hide-rework'): void
  (e: 'rework-back', id: string): void
  (e: 'rework-archive', id: string): void
}>()

const showArchive = () => Number(props.archiveDays) > 0 && Number(props.archiveOverdue?.count || 0) > 0
const showRework = () => Number(props.rework?.count || 0) > 0 && !props.reworkHidden
const firstArchive = () => {
  const it: any = (props.archiveOverdue?.items || [])[0] || {}
  return it.title || it.id || '—'
}
const finite = (n: unknown) => Number.isFinite(Number(n))
</script>

<template>
  <div v-if="showArchive() || showRework()" class="board-banners">
    <!-- 已完成任务自动归档：只在真有超期任务时出现，且不自动动手 —— 点按钮才移文件 -->
    <div v-if="showArchive()" class="archive-overdue-bar">
      <span>📦 有 <b>{{ archiveOverdue.count }}</b> 个已完成任务超过 {{ archiveDays }} 天没更新（如：{{ firstArchive() }}）</span>
      <button class="ghost font-[inherit]" @click="emit('archive-now')">移进归档区</button>
      <button class="ghost font-[inherit]" title="这次先不动，下次启动/刷新还会提示" @click="emit('archive-skip')">先不管</button>
    </div>

    <!-- 驳回返工台：驳回不是终态 —— 它欠一个返工或一个"算了" -->
    <div v-if="showRework()" class="rework-bar">
      <span class="rework-ico">↩</span>
      <span class="rework-txt">
        <b>{{ rework.count }}</b> 张卡被驳回后没人再管<template v-if="finite(rework.oldestDays)">，最早的是 <b>{{ rework.oldestDays }}</b> 天前</template>
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
          {{ finite(r.ageDays) ? r.ageDays + ' 天' : '时间不详' }}</span>
        <button class="ok font-[inherit]" title="退回「待办」重新开工（只改状态，驳回理由留在卡上）"
          @click="emit('rework-back', r.id)">↩ 退回返工</button>
        <button class="ghost font-[inherit]" title="移进归档区（文件移到 task-data/archive/，可还原）"
          @click="emit('rework-archive', r.id)">📦 归档</button>
      </div>
      <div class="rework-foot">
        退回返工 = 接着做；归档 = 这件事不要了（归档就是处置过了，会从这条里消失）；「先不管」只藏这一次。
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
