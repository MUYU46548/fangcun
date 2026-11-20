<!--
  文档拆卡弹窗（2026-11-02 · App.vue 后三刀第一刀「浮层」续）

  **2026-11-20 D-150**：改成 DSH 派单 —— 方寸只把文档 + 任务书写成派单文件，
  DSH 里开会话去拆；方寸不再调自己的模型（llm:docToDrafts 已删）。

  **边界**：只搬模板。doc / 动作仍在 App.vue，父组件用 `aiDocCtl` 转接。
  ⚠ 遮罩 `@mousedown.self`：textarea 拖选滑出遮罩不许误关。
-->
<template>
  <div v-if="ctl.aiDocForm" class="overlay" @mousedown.self="ctl.closeAiDoc()">
    <div id="ai-doc-modal">
      <h3>文档拆卡 · 派给 DSH · {{ ctl.aiDocForm.name }}</h3>
      <label>粘贴文档全文（需求说明/会议记录/笔记，最长 6 万字）</label>
      <textarea v-model="ctl.aiDocForm.doc" rows="9"
                placeholder="把文档内容整段粘进来；DSH 会从里头提取可执行的任务（背景/感想/已完成事项自动跳过）"
                :disabled="ctl.aiDocBusy"></textarea>
      <div class="hint">
        方寸只写一份派单，在 DSH 里开一个会话；由 DSH 用你自己配的模型拆卡。
        DSH 最多拆 <b>20 张</b>“待审批”卡（琥珀色状态）——你过目改卡、点头后才进待办。
        ⚠ 会开 DSH 会话，可能产生真实费用。
      </div>
      <div class="acts">
        <Button variant="ghost" size="tool" :disabled="ctl.aiDocBusy" @click="ctl.closeAiDoc()">取消</Button>
        <button class="pri" data-cost :disabled="ctl.aiDocBusy || !ctl.aiDocForm.doc.trim()" @click="ctl.runDocToDsh()">
          {{ ctl.aiDocBusy ? '发送中…' : '📄 发给 DSH 拆卡' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import Button from './ui/Button.vue'
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点 */
const aiDocCtl = ctl
</script>
