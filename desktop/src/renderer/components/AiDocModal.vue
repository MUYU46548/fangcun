<!--
  文档拆卡弹窗（2026-11-02 · App.vue 后三刀第一刀「浮层」续）

  **边界**：只搬模板。doc / 两个动作仍在 App.vue，父组件用 `aiDocCtl` 转接。
  ⚠ 遮罩 `@mousedown.self`：textarea 拖选滑出遮罩不许误关。
-->
<template>
  <div v-if="ctl.aiDocForm" class="overlay" @mousedown.self="ctl.closeAiDoc()">
    <div id="ai-doc-modal">
      <h3>文档拆卡 · {{ ctl.aiDocForm.name }}</h3>
      <label>粘贴文档全文（需求说明/会议记录/笔记，最长 6 万字）</label>
      <textarea v-model="ctl.aiDocForm.doc" rows="9"
                placeholder="把文档内容整段粘进来，AI 从里头提取可执行的任务（背景/感想/已完成事项会自动跳过）"
                :disabled="ctl.aiDocBusy"></textarea>
      <div class="hint hint-warn" v-if="!ctl.llmCfg.baseUrl">
        ⚠ 还没配模型通道 —— 这个动作要用你自己的一份模型 API（BYOK，方寸不预置任何端点、不代收费用）。
        <button class="ghost llm-goto" :disabled="ctl.aiDocBusy" @click="ctl.gotoLlmSettings()">去设置 → Agent → ✨ 模型通道</button>
      </div>
      <div class="hint">
        每篇最多拆 <b>20 张</b>“待审批”卡（琥珀色状态）——你过目改卡、点头后才进待办；
        卡带 <code>ai-doc</code> 来源标记，和目标拆解的卡分开可查。拆完原文不留存。
      </div>
      <div class="acts">
        <button class="ghost" :disabled="ctl.aiDocBusy" @click="ctl.closeAiDoc()">取消</button>
        <button class="pri" :disabled="ctl.aiDocBusy || !ctl.aiDocForm.doc.trim()" @click="ctl.runDocToDrafts()">
          {{ ctl.aiDocBusy ? 'AI 拆卡中…' : '📄 拆成任务卡' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点 */
const aiDocCtl = ctl
</script>
