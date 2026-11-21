<!--
  通知中心（2026-10-31 · 渲染层拆分“领域刀”第二块）

  **边界**：与 `BoardView.vue` / `TripBoardView.vue` 同一套 —— 组件只“显示 + 收集意图”，
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
          <!-- 2026-11-11（U1=A / 拍板 A：“通知中心改成主界面那套”）：
               原来这里是 30×30 的 nc-icon-btn + 深墨实心 nc-btn-primary —— 那是一套“临时原型”的视觉，
               与方寸的 ghost/primary 不是同一个模子。现在全部换成 ui/Button：
               图标钮 = ghost + sm(24)、主按钮 = primary + sm；原来 `.nc-icon-btn` 的转动动画改挂 `.nc-ico-spin`。 -->
          <Button variant="ghost" size="sm" title="刷新" @click="ncRefresh">
            <span class="nc-ico" :class="{ 'nc-ico-spin': ncLoading }">⟳</span>
          </Button>
          <Button variant="primary" size="sm" :disabled="ncUnread === 0" @click="ncMarkAllRead">✓ 全部标为已读</Button>
          <Button variant="ghost" size="sm" title="关闭" @click="closePanel">✕</Button>
        </div>
      </header>

      <div class="nc-filters">
        <div class="nc-seg">
          <button class="font-[inherit]" :class="{ on: ncFilter === 'all' }" @click="ncSetFilter('all')">全部<span class="n">{{ ncCounts.all }}</span></button>
          <button class="font-[inherit]" :class="{ on: ncFilter === 'unread' }" @click="ncSetFilter('unread')">未读<span class="n">{{ ncCounts.unread }}</span></button>
          <button class="font-[inherit]" :class="{ on: ncFilter === 'read' }" @click="ncSetFilter('read')">已读<span class="n">{{ ncCounts.read }}</span></button>
        </div>
        <!-- 2026-11-21：按类型筛 —— “没用的通知一堆”时至少能只看一类；不持久化，重开面板回全部。 -->
        <select class="nc-type-sel" :value="ncType" title="只看某一类通知" @change="ncSetType(($event.target as HTMLSelectElement).value)">
          <option value="">全部类型</option>
          <option v-for="t in ncTypes" :key="t.id" :value="t.id">{{ t.label }}（{{ t.n }}）</option>
        </select>
      </div>

      <div class="nc-list">
        <div v-for="n in ncVisible" :key="n.id" class="nc-item"
          :class="[n.read ? 'read' : 'unread', 'nc-lv-' + (n.level || 'info'), { go: !!ncTargetOf(n) }]"
          :title="ncTargetOf(n) || '标为已读'"
          @click="ncClickItem(n)">
          <div class="nc-av" :class="'nc-av-' + (NC_TYPE_META[n.type]?.icon || 'system')">
            {{ NC_TYPE_META[n.type]?.glyph || '•' }}
          </div>
          <div class="nc-body">
            <div class="nc-meta">
              <span class="nc-tag" :class="'nc-t-' + (NC_TYPE_META[n.type]?.icon || 'system')">{{ NC_TYPE_META[n.type]?.label || n.type }}</span>
              <span v-if="n.level === 'error'" class="nc-prio">紧急</span>
              <span v-else-if="n.level === 'warning'" class="nc-prio warn">注意</span>
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
            <!-- 同上（拍板 A）：行尾两枚也换成基座 ghost + sm。
                 `keep` / `danger` 两个**语义修饰类**保留 —— `.nc-act.keep` / `.nc-act.danger:hover`
                 是 (0,2,0)，比基座的 utility 高，所以“✓ 成功色 / 🗑 悬停才红”这两条语义不会丢。
                 `.nc-act` 自己那条规则已裁成只剩颜色（尺寸/底/框交给基座）。 -->
            <Button class="nc-act keep" variant="ghost" size="sm" :title="'标为已读'" @click.stop="ncToggleRead(n)">✓</Button>
            <Button class="nc-act danger" variant="ghost" size="sm" title="删除通知" @click.stop="ncDelete(n)">🗑</Button>
          </div>
        </div>
        <div v-if="ncVisible.length === 0" class="nc-empty">
          <div class="nc-empty-ic">🔔</div>
          <h3>{{ ncFilter === 'unread' ? '没有未读通知' : '暂无通知' }}</h3>
          <p>只提醒“你能动手”的事：等你拍板（待验收）、待办到期、任务逾期、没人接手、阻塞链断裂、解析失败、备份失败</p>
        </div>
      </div>

      <!-- P0-5：删过通知 = 静音 7 天，必须看得见、能恢复（此前 listMuted 全无入口） -->
      <div v-if="ncMuted.length" class="nc-muted">
        <span>被忽略 {{ ncMuted.length }} 条（7 天后自动恢复）</span>
        <Button variant="ghost" size="sm" @click="ncUnmuteAll">全部恢复 →</Button>
      </div>
      <footer class="nc-foot">
        <div class="stat">共 <b>{{ ncCounts.all }}</b> 条 · 未读 <b>{{ ncCounts.unread }}</b> 条</div>
        <!-- P0-4：扫描器状态 —— "停摆"与"扫不到"此前在界面上长得一模一样 -->
        <div class="nc-scan" :title="String(ncStatus?.lastScanAt || '')">{{ ncStatusText }}</div>
        <Button variant="ghost" size="sm" @click="ncClearAll">清空历史 →</Button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
// 2026-11-11（拍板 A）：通知中心整体改用 ui 基座 —— 它原来是从一个临时原型移植进来的，
// 30×30 图标 / 深墨主按钮 / accent 文字链接都是那套原型的尺寸，与方寸的 ghost/primary 不是同一个模子。
import Button from './ui/Button.vue'

const props = defineProps<{ ctl: any }>()
const ctl = props.ctl

// ── 状态 / 派生 ─────────────────────────────────────────────────────────
const NC_TYPE_META = toRef(ctl, 'NC_TYPE_META')
const ncUnread = toRef(ctl, 'ncUnread')
const ncHeadSub = toRef(ctl, 'ncHeadSub')
const ncLoading = toRef(ctl, 'ncLoading')
const ncFilter = toRef(ctl, 'ncFilter')
const ncType = toRef(ctl, 'ncType')
const ncTypes = toRef(ctl, 'ncTypes')
const ncCounts = toRef(ctl, 'ncCounts')
const ncVisible = toRef(ctl, 'ncVisible')
const ncMuted = toRef(ctl, 'ncMuted')
const ncStatus = toRef(ctl, 'ncStatus')
const ncStatusText = toRef(ctl, 'ncStatusText')

// ── 动作 ────────────────────────────────────────────────────────────────
const {
  ncRefresh, ncMarkAllRead, closePanel, ncSetFilter, ncSetType, ncTargetOf, ncClickItem,
  ncRelTime, ncToggleRead, ncDelete, ncUnmuteAll, ncClearAll,
} = ctl
</script>
