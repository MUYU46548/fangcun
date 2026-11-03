<!--
  启动台“添加 / 编辑应用”（2026-11-02 · App.vue 后三刀第一刀「浮层」续）

  **边界**：只搬模板。editApp_ / 脏检查 / 增删改仍在 App.vue，父组件用 `appEditCtl` 转接。
  ⚠ 这个弹窗曾经因为 editApp_ 未声明而“点了没反应”，拆分后别再让模板裸名字漏出去。
-->
<template>
  <div id="app-edit-overlay" class="overlay" v-if="ctl.editApp_" @mousedown.self="ctl.closeAppEditor()">
    <div id="app-edit-modal">
      <h3>{{ ctl.editApp_.isNew ? '添加应用' : '编辑应用' }}</h3>
      <label>名称</label>
      <input v-model="ctl.editApp_.name" placeholder="应用名称" />
      <label>路径（exe / bat / cmd / ps1 / lnk / 文件夹都行）</label>
      <div style="display:flex;gap:6px;align-items:center;">
        <input v-model="ctl.editApp_.path" placeholder="E:/path/to/app.exe" style="flex:1" />
        <button type="button" class="ghost" @click="ctl.browseAppPath">浏览…</button>
      </div>
      <label>启动参数（可选，空格分隔）</label>
      <input v-model="ctl.editApp_.argsText" placeholder="例：--port 8080" />
      <label>描述（可选）</label>
      <input v-model="ctl.editApp_.description" placeholder="应用描述" />
      <div class="hint app-path-hint">选中文件夹或 .lnk 时直接用系统“打开”；.bat/.cmd 经 cmd.exe 执行，.ps1 用 powershell 执行。</div>
      <div class="acts">
        <button class="ghost" @click="ctl.closeAppEditor()">取消</button>
        <button v-if="!ctl.editApp_.isNew" class="danger" @click="ctl.removeApp(ctl.editApp_.id)">删除</button>
        <button class="pri" @click="ctl.saveEditApp">{{ ctl.editApp_.isNew ? '添加' : '保存' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点 */
const appEditCtl = ctl
</script>
