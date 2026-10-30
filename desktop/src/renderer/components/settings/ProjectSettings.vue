<!--
  设置 · 项目（2026-10-30 App.vue 拆分第八刀）：项目列表 + 项目方针入口。
-->
<script setup lang="ts">
import { inject } from 'vue'

defineProps<{ active: boolean }>()
const ctx: any = inject('fc-settings')
const {
  copyPolicyText, openPolicyEdit, openProjectInSettings, policyMap, projects,
} = ctx
</script>

<template>
    <div class="sect" v-show="active">
      <h4>项目列表</h4>
      <div class="projlist">
        <div class="proj-row" v-for="p in projects" :key="p.id" :title="p.repo || ''" @click="openProjectInSettings(p)">
          <span class="proj-row-name">{{ p.name || p.id }}</span>
          <small class="proj-row-id">{{ p.id }}</small>
          <span class="proj-row-desc">{{ p['状态'] || '' }}<template v-if="p['路线图']"> · {{ p['路线图'] }}</template></span>
        </div>
      </div>
    </div>
    <!-- 项目方针从「备份与恢复」里挪出来：它本来就属于「项目」这一类
         （原来塞在备份区块内层，做分类时父容器一隐藏它就跟不出来） -->
    <div class="sect" v-show="active">
      <h4>项目方针</h4>
      <div class="hint" style="margin-bottom:8px">每项目一张方针卡（使命/目标/场景/边界）。派活或开新会话时复制给 agent，替代口头交代。</div>
      <div class="policy-list">
        <div v-for="p in projects" :key="'pol-' + p.id" class="policy-row" @click="openPolicyEdit(p.id)">
          <span class="policy-name">{{ p.name || p.id }}</span>
          <span class="policy-state" :class="{ has: policyMap[p.id] }">{{ policyMap[p.id] ? '已立' : '未立' }}</span>
          <button v-if="policyMap[p.id]" class="ghost font-[inherit]" title="复制方针文本（粘给 agent）" @click.stop="copyPolicyText(p.id)">复制</button>
        </div>
      </div>
    </div>
</template>
