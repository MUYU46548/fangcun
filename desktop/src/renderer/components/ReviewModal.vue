<!--
  审批 / 验收 / 直接驳回 的裁决弹窗（2026-11-02 · App.vue 后三刀第一刀「浮层」续）

  **边界**：只搬模板。reviewModal / 理由 / “驳回之后”选项 / 两个动作仍在 App.vue，
  父组件用 `reviewCtl` 转接 —— 状态只有一份。
-->
<template>
  <div id="review-overlay" class="overlay" v-if="ctl.reviewModal" @mousedown.self="ctl.reviewModal = null">
    <div id="review-modal">
      <h3>{{ ctl.reviewModal.kind === 'approval'
        ? '⚖ 审批裁决（批准 → 待办 / 驳回）'
        : ctl.reviewModal.kind === 'direct' ? '↩ 驳回任务' : '✅ 验收裁决' }}</h3>
      <div class="review-info">
        <div class="review-task-title">{{ ctl.reviewModal.title }}</div>
        <div class="review-task-id">{{ ctl.reviewModal.id }}</div>
      </div>
      <label>{{ ctl.reviewModal.kind === 'direct'
        ? '驳回理由（可选 —— 写不清就点下面一个常用理由，或直接留空）'
        : '裁决意见（可选；驳回后仍会常驻在卡上，随时能改）' }}</label>
      <div class="review-presets">
        <button v-for="p in ctl.reviewPresets" :key="p" type="button" class="ghost rp"
          :class="{ on: ctl.reviewReason === p }" @click="ctl.reviewReason = ctl.reviewReason === p ? '' : p">{{ p }}</button>
      </div>
      <textarea v-model="ctl.reviewReason" class="review-reason"
        :placeholder="ctl.reviewModal.kind === 'approval'
          ? '批准：为什么可以转正；驳回：缺什么、要改成什么样'
          : '驳回：哪里不行、要改什么；通过：验收依据 / 遗留事项'"></textarea>
      <label class="review-where-label">驳回之后 <span class="rw-scope">（只在点“驳回”时生效 —— 点“通过”不受这一项影响）</span></label>
      <div class="review-where" :class="{ 'is-secondary': ctl.reviewModal.intent === 'accept' }">
        <label class="rw-opt" :class="{ on: ctl.reviewRework }">
          <input type="radio" :checked="ctl.reviewRework" @change="ctl.reviewRework = true" />
          <span><b>退回待办，让 AI 返工</b>（默认）—— 理由留在卡上，agent 取活会先读它</span>
        </label>
        <label class="rw-opt" :class="{ on: !ctl.reviewRework }">
          <input type="radio" :checked="!ctl.reviewRework" @change="ctl.reviewRework = false" />
          <span><b>先停在“驳回”</b> —— 不派活，晚点在看板的返工台里再决定</span>
        </label>
      </div>
      <div class="acts">
        <button class="ghost" @click="ctl.reviewModal = null">取消</button>
        <button class="danger" @click="ctl.rejectTask">{{ ctl.reviewRework ? '↩ 驳回并退回待办' : '↩ 驳回' }}</button>
        <button v-if="ctl.reviewModal.kind !== 'direct'" class="ok" @click="ctl.acceptTask">{{ ctl.reviewModal.kind === 'approval' ? '✅ 批准转正（→待办）' : '✅ 通过' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点 */
const reviewCtl = ctl
</script>
