<!--
  通知中心（2026-10-31 · 渲染层拆分「领域刀」第二块）

  **边界**：与 `BoardView.vue` / `TripBoardView.vue` 同一套 —— 组件只「显示 + 收集意图」，
  状态与动作全部来自 `composables/useNotifications.ts`（拆分第五刀就已搬好）。
  父组件把那一坨用 `reactive()` 包成 `notificationsCtl` 传进来，组件 `toRef` 接状态、解构接动作。

  ⚠ `v-if="ncOpen"` 在父组件那侧：本组件只在打开时挂载，关闭即卸载（与搬出前一致）。
  ⚠ 根节点必须仍是 `.nc-wrap`（遮罩层）：`@mousedown.self` 的关闭手势按它判定。
-->
<template>
  <div class="nc-wrap" @mousedown.self="closePanel">
    <div class="nc-panel">
      <header class="nc-head">
        <div class="nc-head-title">
          <h1>通知中心 <span v-if="ncUnread > 0" class="nc-count">{{ ncUnread }}</span></h1>
          <p>{{ ncHeadSub }}</p>
        </div>
        <div class="nc-head-act">
          <button class="nc-icon-btn font-[inherit]" :class="{ spin: ncLoading }" title="刷新" @click="ncRefresh">
            <span class="nc-ico">⟳</span>
          </button>
          <button class="nc-btn-primary font-[inherit]" :disabled="ncUnread === 0" @click="ncMarkAllRead">✓ 全部标为已读</button>
          <button class="nc-icon-btn font-[inherit]" title="关闭" @click="closePanel">✕</button>
        </div>
      </header>

      <div class="nc-filters">
        <div class="nc-seg">
          <button class="font-[inherit]" :class="{ on: ncFilter === 'all' }" @click="ncSetFilter('all')">全部<span class="n">{{ ncCounts.all }}</span></button>
          <button class="font-[inherit]" :class="{ on: ncFilter === 'unread' }" @click="ncSetFilter('unread')">未读<span class="n">{{ ncCounts.unread }}</span></button>
          <button class="font-[inherit]" :class="{ on: ncFilter === 'read' }" @click="ncSetFilter('read')">已读<span class="n">{{ ncCounts.read }}</span></button>
        </div>
      </div>

      <div class="nc-list">
        <div v-for="n in ncVisible" :key="n.id" class="nc-item"
          :class="[n.read ? 'read' : 'unread', { go: !!ncTargetOf(n) }]"
          :title="ncTargetOf(n) || '标为已读'"
          @click="ncClickItem(n)">
          <div class="nc-av" :class="'nc-av-' + (NC_TYPE_META[n.type]?.icon || 'system')">
            {{ NC_TYPE_META[n.type]?.glyph || '•' }}
          </div>
          <div class="nc-body">
            <div class="nc-meta">
              <span class="nc-tag" :class="'nc-t-' + (NC_TYPE_META[n.type]?.icon || 'system')">{{ NC_TYPE_META[n.type]?.label || n.type }}</span>
              <span v-if="n.level === 'error'" class="nc-prio">紧急</span>
            </div>
            <div class="nc-row1">
              <div class="nc-title">{{ n.title }}</div>
              <div class="nc-time">{{ ncRelTime(n.updatedAt) }}</div>
            </div>
            <div v-if="n.body" class="nc-content">{{ n.body }}</div>
          </div>
          <!-- 2026-10-01 用户第 1 条：能跳的行给个明确信号，别让人点了以为是死按钮 -->
          <span v-if="ncTargetOf(n)" class="nc-go" aria-hidden="true">→</span>
          <div class="nc-acts">
            <button class="nc-act keep font-[inherit]" :title="n.read ? '标为已读' : '标为已读'" @click.stop="ncToggleRead(n)">✓</button>
            <button class="nc-act danger font-[inherit]" title="删除通知" @click.stop="ncDelete(n)">🗑</button>
          </div>
        </div>
        <div v-if="ncVisible.length === 0" class="nc-empty">
          <div class="nc-empty-ic">🔔</div>
          <h3>{{ ncFilter === 'unread' ? '没有未读通知' : '暂无通知' }}</h3>
          <p>这里会显示任务没动静、阻塞链断裂、待办到期、任务逾期、解析失败与备份失败等事件</p>
        </div>
      </div>

      <!-- P0-5：删过通知 = 静音 7 天，必须看得见、能恢复（此前 listMuted 全无入口） -->
      <div v-if="ncMuted.length" class="nc-muted">
        <span>被忽略 {{ ncMuted.length }} 条（7 天后自动恢复）</span>
        <button class="nc-link font-[inherit]" @click="ncUnmuteAll">全部恢复 →</button>
      </div>
      <footer class="nc-foot">
        <div class="stat">共 <b>{{ ncCounts.all }}</b> 条 · 未读 <b>{{ ncCounts.unread }}</b> 条</div>
        <!-- P0-4：扫描器状态 —— "停摆"与"扫不到"此前在界面上长得一模一样 -->
        <div class="nc-scan" :title="String(ncStatus?.lastScanAt || '')">{{ ncStatusText }}</div>
        <button class="nc-link font-[inherit]" @click="ncClearAll">清空历史 →</button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toRef } from 'vue'

const props = defineProps<{ ctl: any }>()
const ctl = props.ctl

// ── 状态 / 派生 ─────────────────────────────────────────────────────────
const NC_TYPE_META = toRef(ctl, 'NC_TYPE_META')
const ncUnread = toRef(ctl, 'ncUnread')
const ncHeadSub = toRef(ctl, 'ncHeadSub')
const ncLoading = toRef(ctl, 'ncLoading')
const ncFilter = toRef(ctl, 'ncFilter')
const ncCounts = toRef(ctl, 'ncCounts')
const ncVisible = toRef(ctl, 'ncVisible')
const ncMuted = toRef(ctl, 'ncMuted')
const ncStatus = toRef(ctl, 'ncStatus')
const ncStatusText = toRef(ctl, 'ncStatusText')

// ── 动作 ────────────────────────────────────────────────────────────────
const {
  ncRefresh, ncMarkAllRead, closePanel, ncSetFilter, ncTargetOf, ncClickItem,
  ncRelTime, ncToggleRead, ncDelete, ncUnmuteAll, ncClearAll,
} = ctl
</script>
