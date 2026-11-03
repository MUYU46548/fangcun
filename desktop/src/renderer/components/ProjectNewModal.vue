<!--
  新建项目（2026-11-02 · App.vue 后三刀第一刀「浮层」续）

  **边界**：只搬模板。projForm / 写入自校验 / 脏检查仍在 App.vue，父组件用 `projCtl` 转接。
-->
<template>
  <div v-if="ctl.projForm" class="overlay" @mousedown.self="ctl.closeProjForm()">
    <div id="proj-new-modal">
      <h3>新建项目</h3>
      <label>项目 ID <span class="req">*</span></label>
      <input v-model="ctl.projForm.id" placeholder="英文标识，如 novel-forge" />
      <label>显示名称</label>
      <input v-model="ctl.projForm.name" placeholder="留空则与 ID 相同" />
      <label>仓库路径</label>
      <input v-model="ctl.projForm.repo" placeholder="E:/CODE/CangKu/xxx（供 Hermes 派活定位）" />
      <label>说明</label>
      <input v-model="ctl.projForm.description" placeholder="一句话说明（可选）" />
      <div class="hint">
        项目登记进 <code>registry.yaml</code>。写入前会自校验（内容可解析 · 项目数 +1 · 新 ID 可见），
        任一不满足即放弃写入；文件原有注释与字段原样保留。
      </div>
      <div class="acts">
        <button class="ghost" @click="ctl.closeProjForm()">取消</button>
        <button class="pri" :disabled="ctl.projCreating" @click="ctl.confirmNewProject">{{ ctl.projCreating ? '写入中…' : '登记项目' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点 */
const projCtl = ctl
</script>
