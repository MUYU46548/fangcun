<template>
  <div id="todo-edit-overlay" class="overlay" v-if="ctl.todoEdit_" @mousedown.self="ctl.closeTodoEditor()">
  <div id="todo-edit-modal">
    <h3>{{ ctl.todoEdit_.id ? '编辑待办' : '新建待办' }}</h3>
    <label>内容</label>
    <textarea v-model="ctl.todoEdit_.title" class="tall" placeholder="待办内容（可以写长一点）"></textarea>
    <div class="te-row">
      <div>
        <label>项目</label>
        <select v-model="ctl.todoEdit_.project" class="logsel">
          <option value="">（不归属）</option>
          <option v-for="p in ctl.projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
        </select>
      </div>
      <div>
        <label>优先级</label>
        <select v-model="ctl.todoEdit_.priority" class="logsel">
          <option v-for="s in ['高', '中', '低']" :key="s" :value="s">{{ s }}</option>
        </select>
      </div>
      <div>
        <label>到期日</label>
        <input type="date" v-model="ctl.todoEdit_.due" />
      </div>
      <!-- 到期时间（2026-10-12 暮雨：“待办只有到期日，建议再加一个可选的时间字段。
           如 WorkBuddy 额度 21:33:59 重置，让用户选个 21:39”）。
           ⚠ 是**可选**：留空 = 老行为（只按天）。所以标签写“时间（可选）”，
             并给一个“清空”小按钮 —— 填错了要能去掉（清空 = 字段整个消失，不是存个空串）。
           ⚠ `type="time"` 在 Electron/Chromium 里是原生时间选择器，比自己搓输入框稳。 -->
      <div>
        <label>时间（可选）</label>
        <span class="te-time-wrap">
          <input type="time" v-model="ctl.todoEdit_.dueTime" step="60" />
          <button v-if="ctl.todoEdit_.dueTime" type="button" class="te-time-clear"
            title="清空时间（回到只按天判定）" @click="ctl.todoEdit_.dueTime = ''">✕</button>
        </span>
      </div>
    </div>
    <div class="hint todo-edit-donehint" v-if="ctl.todoEdit_.done">这条已勾选完成 —— 仍然可以修改内容和到期日。</div>
    <div class="acts">
      <button class="ghost" @click="ctl.closeTodoEditor()">取消</button>
      <button class="pri" :disabled="ctl.todoEditSaving" @click="ctl.saveTodoEdit">{{ ctl.todoEditSaving ? '保存中…' : '保存' }}</button>
    </div>
  </div>
</div>
</template>

<script setup lang="ts">
/**
 * 待办编辑（2026-11-02 · App.vue 后三刀第一刀「浮层」）
 *
 * 只搬模板：todoEdit_ 是 ref，控制器 getter 返回 .value（对象本身），v-model 才写得进它的属性。
 * 到期时间是可选字段 —— 清空按钮把字段整个清成空串（不是存个空值），老行为保持不变。
 */
defineProps<{ ctl: any }>()
</script>
