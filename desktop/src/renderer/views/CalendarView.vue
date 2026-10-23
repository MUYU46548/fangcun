<!--
  日历视图（2026-10-23 · 拆分第 1 批第 4 块：模板搬成组件）

  **为什么这时候才搬**：第 3 块先把状态与算法抽进了 `composables/useCalendar.ts`，
  这一步只搬模板 —— 两步分开，红了能一眼分清是"状态搬坏了"还是"模板搬坏了"。

  **组件边界**：组件只负责「显示 + 收集意图」，**所有副作用上抛**给 App.vue：
    · assign-task  —— 要开「指派时间」弹窗（弹窗状态在父组件）
    · assign-todo  —— 同上，但入口是待办（父组件用 id 去找 due）
    · reschedule   —— 拖拽改期：组件算出"改到哪天"，落盘（IPC + toast + 重新加载）留给父组件
    · open-card    —— 点任务条目 → 打开任务详情
    · open-log     —— 点日志条目 → 打开日志编辑

  ⚠ `<main id="board" class="calendar-view">` 这层壳必须留着：视图互斥与几何断言
    （`#board.calendar-view`）都按它选，换成 div 就得同步改一堆断言。
-->
<template>
  <main id="board" class="calendar-view">
    <div class="calhead">
      <button class="ghost" @click="calMove(-1)">&#9664; 上月</button>
      <span class="m">{{ calYear }} 年 {{ calMonth + 1 }} 月</span>
      <button class="ghost" @click="calMove(1)">下月 &#9654;</button>
      <button class="ghost" @click="calToday">回到本月</button>
      <label class="chk cal-chk"><input type="checkbox" :checked="calShowTodos" @change="calToggleTodos" /> 显示待办</label>
      <!-- 2026-09-23（用户第 3 条）：日志上日历 -->
      <label class="chk cal-chk"><input type="checkbox" :checked="calShowLogs" @change="calToggleLogs" /> 显示日志</label>
      <span class="cal-hint">拖动条目可改期；点条目可指派时间；时间段任务会横跨多天</span>
    </div>
    <div class="calgrid">
      <div v-for="d in CAL_DOW" :key="d" class="caldow">{{ d }}</div>
      <div v-for="(cell, i) in calCells" :key="i" class="calcell"
        :class="{ blank: !cell, today: cell && cell.isToday, past: cell && cell.isPast, dragover: cell && cell.day === calDragOverDay }"
        @dragover.prevent="cell && (calDragOverDay = cell.day)"
        @dragleave="calDragOverDay = null"
        @drop="onCalDrop($event, cell)"
      >
        <template v-if="cell">
          <div class="dnum">{{ cell.day }}</div>
          <!-- 2026-09-29 用户选「改法 A」（035 卡）：格子里最多 2 条 + 「+N 条」。
               时间段任务不折（见 calCellShown），所以连续色带不会断头。 -->
          <div v-for="ev in calCellShown(cell)" :key="ev.kind + ev.id + '-' + cell.day"
            class="cev" :class="['span-' + ev.span, ev.kind === 'todo' ? 'cev-todo' : ev.kind === 'log' ? 'cev-log' : 'cev-task']"
            draggable="true"
            :title="(ev.kind === 'todo' ? '待办：' : ev.kind === 'log' ? '日志：' : '任务：') + ev.title + (ev.rangeDays > 1 ? `（共 ${ev.rangeDays} 天）` : '')"
            @dragstart="onCalDragStart($event, ev.id, ev.kind)"
            @click="onCalEventClick(ev)"
          >
            <span class="pd" :style="{ background: ev.kind === 'todo' ? '#5b8dd6' : ev.kind === 'log' ? '#8b7fb8' : prioColor(ev.priority) }"></span>
            <span class="t">{{ ev.title }}</span>
          </div>
          <button v-if="calCellMore(cell)" class="cal-cell-more" :title="`还有 ${calCellMore(cell)} 条，点开就地铺满这一天`"
            @click.stop="toggleCalCell(cell)">+{{ calCellMore(cell) }} 条</button>
          <button v-else-if="calCellExpanded(cell)" class="cal-cell-more less" title="收回前面几条，只留 2 条"
            @click.stop="toggleCalCell(cell)">收起</button>
        </template>
      </div>
    </div>
    <div class="calunsched">
      <!-- 2026-09-25（用户第 10 条）：底部这两排 chip 一旦多起来就是一片「横条墙」，
           视觉压迫感极强。改成默认收起的一行摘要，点开才铺开。 -->
      <button class="cal-more" :aria-expanded="calBottomOpen" @click="calBottomOpen = !calBottomOpen">
        <span class="caret" :class="{ open: calBottomOpen }">▸</span>
        未排期 <b>{{ calUnscheduled.length }}</b> 项
        <template v-if="calOtherMonths.length">· 其它月份 <b>{{ calOtherMonths.length }}</b> 个</template>
        <span class="cal-more-hint">{{ calBottomOpen ? '收起' : '展开' }}</span>
      </button>
      <div v-show="calBottomOpen" class="cal-more-body">
        <h4>
          未安排 · 无时间（{{ calUnscheduled.length }} 个）
          <span class="cal-hint-inline" v-if="calUnscheduled.length">拖动到日期格即改期，点击可直接指派时间</span>
        </h4>
        <div class="items">
        <span v-for="t in calUnscheduled" :key="t.id" class="cev chip" draggable="true"
          :title="'拖动或点击指派时间：' + (t.title || t.id)"
          @dragstart="onCalDragStart($event, t.id, 'task')"
          @click="emit('assign-task', t)">
          <span class="pd" :style="{ background: prioColor(t.priority) }"></span>
          <span class="t">{{ t.title || t.id }}</span>
        </span>
        <span v-if="!calUnscheduled.length" class="cal-empty">本月任务都已安排时间</span>
      </div>
      <template v-if="calOtherMonths.length">
        <h4 class="cal-other-head">其它月份（{{ calOtherTotal }} 个）—— 点一下跳过去</h4>
        <div class="items">
          <span v-for="g in calOtherMonths" :key="g.key" class="cev chip other" @click="calGoto(g.year, g.month)">
            {{ g.label }} · {{ g.count }} 个 →
          </span>
        </div>
      </template>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { useCalendar } from '../composables/useCalendar'
import { localPriority } from '../../shared/priority'

const props = defineProps<{
  /** 顶栏筛选后的任务（日历跟着筛选走，这是既有行为） */
  tasks: any[]
  todos: any[]
  logs: any[]
}>()

const emit = defineEmits<{
  (e: 'assign-task', task: any): void
  (e: 'assign-todo', id: string): void
  (e: 'reschedule', payload: { id: string; kind: 'task' | 'todo' | 'log'; date: string }): void
  (e: 'open-card', task: any): void
  (e: 'open-log', id: string): void
}>()

/** 星期表头（只有这一处用，不必往 shared 挪） */
const CAL_DOW = ['一', '二', '三', '四', '五', '六', '日']

const {
  calYear, calMonth, calDragOverDay, calShowTodos, calShowLogs,
  calCellExpanded, calCellShown, calCellMore, toggleCalCell,
  calMove, calToday, calGoto, calToggleTodos, calToggleLogs,
  calActiveTasks, calCells, calUnscheduled, calOtherMonths, calOtherTotal, calBottomOpen,
  prioColor, onCalDragStart, takeDrag, calISO,
} = useCalendar({
  activeTasks: () => props.tasks,
  todos: () => props.todos,
  logs: () => props.logs,
  priority: localPriority,
})

/**
 * 点条目：按 kind 分三种去向。
 * 任务要传整个对象（父组件的 openCalAssignTask 要读 start/deadline），
 * 待办只传 id（父组件自己去 todos 里找 due）—— 这是两边函数签名的差异，不是我随手定的。
 */
function onCalEventClick(ev: any): void {
  if (ev.kind === 'todo') { emit('assign-todo', ev.id); return }
  if (ev.kind === 'log') { emit('open-log', ev.id); return }
  const t = calActiveTasks.value.find((x: any) => x.id === ev.id)
  if (t) emit('open-card', t)
}

/**
 * 拖拽落点：组件只算"改到哪天"，**不落盘** —— 落盘要 IPC + toast + 重新加载，
 * 全是父组件的能力。算日期必须在这里（要 calYear/calMonth）。
 */
function onCalDrop(e: DragEvent, cell: { day: number } | null): void {
  e.preventDefault()
  calDragOverDay.value = null
  if (!cell) return
  const drag = takeDrag()
  const id = drag?.id || e.dataTransfer?.getData('text/plain') || ''
  const kind = drag?.kind || 'task'
  if (!id) return
  emit('reschedule', { id, kind, date: calISO(new Date(calYear.value, calMonth.value, cell.day)) })
}
</script>
