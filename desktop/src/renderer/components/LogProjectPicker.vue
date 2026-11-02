<template>
  <div v-if="ctl.logProjectPicker" class="overlay" @mousedown.self="ctl.logProjectPicker = null">
    <div id="log-project-modal">
      <h3>改项目归属</h3>
      <div class="hint">{{ ctl.logProjectPicker.title || ctl.logProjectPicker.id }}（当前：{{ ctl.logProjectPicker.project || '未归属' }}）</div>
      <div class="proj-pick-list">
        <button class="skills-btn" @click="ctl.applyLogProject('')">（不归属）</button>
        <button v-for="p in ctl.projects" :key="p.id" class="skills-btn" @click="ctl.applyLogProject(p.id)">
          {{ p.name }} · {{ p.id }}
        </button>
      </div>
      <div class="trash-preview-actions">
        <button class="trash-btn" @click="ctl.logProjectPicker = null">取消</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/** 日志改项目归属（2026-11-02 · 后三刀第一刀「浮层」）：只搬模板，状态与动作仍住 App.vue */
defineProps<{ ctl: any }>()
</script>
