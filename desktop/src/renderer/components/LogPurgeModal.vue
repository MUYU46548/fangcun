<!--
  清理已归档日志弹窗（2026-10-31 · 渲染层拆分「浮层刀」第四块）

  **边界**：与 RelayModal / LogEditModal 同一套 —— 只显示 + 收集意图，状态与动作留在 App。
  ⚠ 由父组件 `v-if="logPurgeOpen"` 决定挂不挂；组件内部保留同一守卫。
  ⚠ 这里不许用 Tailwind 工具类（样式仍全在 app.css）。
-->
<template>
  <div id="log-purge-overlay" class="overlay" v-if="logPurgeOpen" @mousedown.self="closeLogPurge()">
    <div id="log-purge-modal">
      <h3>清理已归档日志</h3>
      <div class="hint">
        删除<b>归档日期早于</b>下面所选日期的日志。文件不会永久消失 ——
        会移进 <code>docs/执行日志/.trash/</code> 回收站，需要时可手动找回。
      </div>
      <div class="lpurge-row">
        <label>早于</label>
        <input v-model="logPurgeDate" type="date" class="log-filter font-[inherit]" @change="resetLogPurgePreview" />
      </div>
      <div class="lpurge-actions">
        <button class="ghost" :disabled="logPurgeBusy" @click="runLogPurgePreview">预览命中</button>
        <button class="danger" :disabled="logPurgeBusy || !logPurgePreview" @click="executeLogPurge">确认清理</button>
        <button class="ghost" @click="closeLogPurge">取消</button>
      </div>
      <div v-if="logPurgePreview" class="lpurge-preview">
        <div><b>将清理 {{ logPurgePreview.count }} 条</b></div>
        <ul v-if="logPurgePreview.count" class="lpurge-list">
          <li v-for="(t, i) in logPurgePreview.titles.slice(0, 8)" :key="i">{{ t || '(无标题)' }}</li>
          <li v-if="logPurgePreview.count > 8" class="lpurge-more">…等共 {{ logPurgePreview.count }} 条</li>
        </ul>
        <div v-else>没有早于该日期的归档日志，无需清理。</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toRef } from 'vue'

const props = defineProps<{ ctl: any }>()
const ctl = props.ctl

const logPurgeOpen = toRef(ctl, 'logPurgeOpen')
const logPurgeDate = toRef(ctl, 'logPurgeDate')
const logPurgeBusy = toRef(ctl, 'logPurgeBusy')
const logPurgePreview = toRef(ctl, 'logPurgePreview')

const { resetLogPurgePreview, runLogPurgePreview, executeLogPurge, closeLogPurge } = ctl
</script>
