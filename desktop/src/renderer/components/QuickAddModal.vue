<template>
  <div v-if="ctl.quickAddOpen" class="overlay" @mousedown.self="ctl.closeQuickAdd()">
    <div id="quickadd-modal">
      <h3>快速记一条</h3>
      <input v-model="text" class="quickadd-in" spellcheck="false"
        placeholder="一句话，可带简写：p0 修登录 · #bug @hermes to:待办 due:12-31"
        @keydown.enter="ctl.submitQuickAdd()" />
      <div class="quickadd-hint">
        简写：<code>p0/p1/p2</code> 优先级 · <code>#标签</code> · <code>@指派给谁</code> ·
        <code>to:状态</code> · <code>due:MM-DD</code> 截止。其余词就是标题。
      </div>
      <div v-if="ctl.quickAddErr" class="quickadd-err">{{ ctl.quickAddErr }}</div>
      <div class="acts">
        <button class="ghost" @click="ctl.closeQuickAdd()">取消</button>
        <button class="pri" :disabled="ctl.quickAddBusy || !text.trim()" @click="ctl.submitQuickAdd()">
          {{ ctl.quickAddBusy ? '创建中…' : '创建' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 快速记（2026-11-02 · App.vue 后三刀第一刀「浮层」）
 *
 * 只搬模板：状态与动作仍住 App.vue，经 `ctl` 传入。
 * `text` 单独做一个 computed 双向代理 —— 直接把 `v-model` 绑到 `ctl.quickAddText` 上
 * 也成立，但那样每次输入都要经过 reactive 的 getter/setter，
 * 用本地 computed 更直白，也让"这里只做转发"一眼看得见。
 */
import { computed } from 'vue'

const props = defineProps<{ ctl: any }>()

const text = computed({
  get: () => props.ctl.quickAddText,
  set: (v: string) => { props.ctl.quickAddText = v },
})
</script>
