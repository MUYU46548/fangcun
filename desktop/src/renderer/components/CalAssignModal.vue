<template>
  <div v-if="ctl.calAssign_" class="overlay" @mousedown.self="ctl.calAssign_ = null">
  <div id="cal-assign-modal">
    <h3>📅 指派时间</h3>
    <div class="ca-title">{{ ctl.calAssign_.title }}</div>
    <div class="hint" v-if="ctl.calAssign_.isTodo">待办只有“到期日”一个时间点。</div>
    <template v-if="!ctl.calAssign_.isTodo">
      <label>开始（可选；与截止组成时间段，日历上会横跨多天）</label>
      <input v-model="ctl.calAssign_.start" type="date" />
    </template>
    <label>{{ ctl.calAssign_.isTodo ? '到期日' : '截止' }}</label>
    <input v-model="ctl.calAssign_.end" type="date" />
    <div class="ca-quick">
      <button class="ghost" @click="ctl.calQuickSet(0)">今天</button>
      <button class="ghost" @click="ctl.calQuickSet(1)">明天</button>
      <button class="ghost" @click="ctl.calQuickSet(7)">一周后</button>
      <button class="ghost" @click="ctl.calClearDates">清除时间</button>
    </div>
    <div class="acts">
      <button class="ghost" @click="ctl.calAssign_ = null">取消</button>
      <button class="pri" @click="ctl.saveCalAssign">保存</button>
    </div>
  </div>
</div>
</template>

<script setup lang="ts">
/** 指派时间（2026-11-02 · 后三刀第一刀「浮层」）：calAssign_ 是 ref，控制器 getter 返回 .value */
defineProps<{ ctl: any }>()
</script>
