<!--
  AI 规划弹窗（2026-11-02 · App.vue 后三刀第一刀「浮层」续）

  **边界**：只搬模板。表单 / BYOK 指路 / 两个动作仍在 App.vue，父组件用 `aiPlanCtl` 转接。
  ⚠ 遮罩必须 `@mousedown.self`：这里有一个文本输入框，`@click.self` 会在拖选文字
    光标滑出弹窗时被当成点了遮罩，把还没提交的草稿一起关掉。
-->
<template>
  <div v-if="ctl.aiPlanForm" class="overlay" @mousedown.self="ctl.closeAiPlan()">
    <div id="ai-plan-modal">
      <h3>AI 规划 · {{ ctl.aiPlanForm.name }}</h3>
      <label>想干什么（一句话目标，给“拆成任务卡”用）</label>
      <input v-model="ctl.aiPlanForm.goal" placeholder="例：把 0.2.8 发版前的阻塞清空"
             @keyup.enter="ctl.runPlanToDraft()" :disabled="ctl.aiPlanBusy" />
      <div class="hint hint-warn" v-if="!ctl.llmCfg.baseUrl">
        ⚠ 还没配模型通道 —— 这个动作要用你自己的一份模型 API（BYOK，方寸不预置任何端点、不代收费用）。
        <button class="ghost llm-goto" :disabled="ctl.aiPlanBusy" @click="ctl.gotoLlmSettings()">去设置 → Agent → ✨ 模型通道</button>
      </div>
      <div class="hint">
        结果落成<b>“待审批”卡</b>（琥珀色状态）——你过目改卡、点头后才进待办，AI 不能背着你塞东西。
        卡带 <code>ai-planning</code> 来源标记可审计。
      </div>
      <div class="acts">
        <button class="ghost" :disabled="ctl.aiPlanBusy" @click="ctl.closeAiPlan()">取消</button>
        <button class="ghost" :disabled="ctl.aiPlanBusy || !ctl.aiPlanForm.goal.trim()" @click="ctl.runPlanToDraft()">
          {{ ctl.aiPlanBusy ? 'AI 拆解中…' : '✨ 拆成任务卡草稿' }}</button>
        <button class="pri" :disabled="ctl.aiPlanBusy" @click="ctl.runDraftBrief()">
          {{ ctl.aiPlanBusy ? 'AI 起草中…' : '📄 起草项目说明' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点 */
const aiPlanCtl = ctl
</script>
