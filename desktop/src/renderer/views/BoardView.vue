<!--
  看板视图（2026-10-31 · 渲染层拆分第二批：看板三摆法整体搬出）

  **边界**：与 `LogsView.vue` 同一套做法 —— 组件只「显示 + 收集意图」，状态与动作全部留在 App。
  父组件把看板那一整坨状态与动作用 `reactive()` 包成一个对象（`boardViewCtl`），
  作为唯一 prop `ctl` 传进来；组件用 `toRef` 接状态、直接解构接函数，**模板一字未改**。

  ⚠ 三种摆法共用同一份 `columns` / `collapsedGroups` / 拖拽态，互斥渲染（v-if / v-else-if）。
    拆开后这个约束仍然成立 —— 只是从 App 的模板搬进了本组件，没有第二份状态。

  ⚠ `<main id="board">` 这层壳必须留着：视图互斥、几何断言、
    `#board .col > .card` 这类后代选择器都按它选。

  ⚠ 这里**不许**用 Tailwind 工具类：`tailwind.config.js` 的 content 只覆盖
    `src/renderer/components/`（`check-ui-base` 守着），views/ 下写的 utility 不会生成 CSS。
-->
<template>
  <main id="board" :class="boardClass">
    <!-- 列表视图（多视图第 1 项）。与列视图**共用** columns / collapsedGroups / 拖拽处理：
         拖一行到某个分区里 = 改成该状态，和拖到列里是同一件事。 -->
    <div v-if="boardView === 'list'" class="board-list">
      <div
        v-for="col in columns"
        :key="'bl-' + col.key"
        class="blgrp"
        :class="{ 'drop-here': dragoverCol === col.key, 'is-empty': !col.tasks.length }"
        @dragover.prevent="onDragOver($event, col.key)"
        @dragleave="dragoverCol = null"
        @drop="onDrop($event, col.key)"
        @contextmenu="openColumnMenu($event, col.key)"
      >
        <div class="blgrp-head">
          <button class="lpill" :title="groupCollapsed(col.key) ? '点击展开' : '点击折叠'"
            @click="toggleGroup(col.key)">
            <span class="chev" :class="{ open: !groupCollapsed(col.key) }"></span>
            <span class="gdot" :class="'gdot-' + statusClass(col.key)"></span>
            <span class="glabel">{{ col.label }}</span>
            <span class="gn">{{ col.tasks.length }}</span>
          </button>
          <span class="f1"></span>
          <!-- 分区头整组勾选（2026-10-25 第 11 条），与列视图同一套逻辑 -->
          <label v-if="batchMode && col.tasks.length" class="grp-chk"
            :title="groupAllSelected(col)
              ? `取消这一整组「${col.label}」（${col.tasks.length} 个）`
              : `把这一整组「${col.label}」（${col.tasks.length} 个）加进选择`"
            @click.stop>
            <input type="checkbox" :checked="groupAllSelected(col)"
              :indeterminate="groupSomeSelected(col)" @change="toggleGroupSelect(col)" />
          </label>
        </div>
        <TaskCardMenu v-for="t in col.tasks" :key="'blr-' + t.id" :task="t" @pick="onCardMenuPick">
          <div
            v-show="!groupCollapsed(col.key)"
            class="brow"
            :class="{
              stale: isStale(t),
              overdue: isOverdue(t),
              selected: selectedBatch.includes(t.id),
              dragging: draggingId === t.id
            }"
            :data-id="t.id"
            draggable="true"
            @dragstart="onDragStart($event, t.id)"
            @click="batchMode ? toggleBatchSelect(t.id) : openCard(t)"
            @mouseenter="onCardEnter($event, t)"
            @mouseleave="onCardLeave()"
          >
            <input
              v-show="batchMode"
              type="checkbox"
              class="batch-chk"
              :checked="selectedBatch.includes(t.id)"
              @click.stop="toggleBatchSelect(t.id)"
            />
            <span class="card-liv" :class="'liv-' + statusClass(t.status)"></span>
            <b class="ttl">
              <span v-if="t.batch" class="batch">批{{ t.batch }}</span>
              {{ t.title || t.id }}
            </b>
            <!-- 状态徽章同列视图的规矩：分区已经说明了状态就不重复占宽 -->
            <span v-if="groupMode !== 'status'" class="st" :class="'st-' + statusClass(t.status)">{{ t.status }}</span>
            <span v-if="t.archived" class="src-badge" title="归档任务">📦</span>
            <span class="card-meta">
              <span v-if="cardDate(t).text" class="card-date"
                :class="{ over: cardDate(t).over, dim: cardDate(t).kind === 'updated' }"
                :title="cardDate(t).kind === 'due' ? '截止日' : '最后更新'">{{ cardDate(t).text }}</span>
              <span class="card-proj" :title="normProject(t.project) || '未归属任何项目'">{{ projShort(t.project) }}</span>
            </span>
          </div>
        </TaskCardMenu>
        <div v-if="!col.tasks.length" v-show="!groupCollapsed(col.key)" class="emptyhint">拖拽卡片到此处</div>
      </div>
    </div>

    <!-- 信息卡墙（2026-10-10，卡 20261010-003）。用户从小样里点的候选 A。
         口径：现有两种摆法都是「窄化横条」，「少了点掌控感」；要能看见任务 ID；
         但「没必要也不应该显示一堆无关紧要的信息」。
         所以每张卡只多给三样可行动的东西：ID（点一下复制）、优先级（左缘色条 + 小徽章）、
         阻塞（被卡几个 / 挡人几个 —— 两个数都为 0 就整格不画，既不写 0 也不写「—」）。
         ⚠ 2026-10-10 当晚修正：首版直接铺 filteredTasks → **把分组整个丢了**，一百多张卡
           糊成一面没有结构的墙（用户截图反馈「压迫感十足」，且选了「按项目」也不生效）。
           现在与列视图 / 列表视图一样跑 `columns`：**先分区、区内再摆网格**，分区头可折叠。
           于是 groupMode（按状态 / 按项目）对三种摆法一视同仁，拖拽改状态也照旧。
         与另两种摆法互斥渲染（v-if / v-else-if），共用同一份 columns / 折叠状态 /
         选中 / 拖拽 / 右键状态。派生逻辑在 shared/boardCards.ts，这里只接线。 -->
    <div v-else-if="boardView === 'cards'" class="pvwall">
      <div
        v-for="col in cardWallGroups"
        :key="'pwg-' + col.key"
        class="pwg"
        :class="{ 'drop-here': dragoverCol === col.key, 'is-empty': !col.tasks.length }"
        @dragover.prevent="onDragOver($event, col.key)"
        @dragleave="dragoverCol = null"
        @drop="onDrop($event, col.key)"
        @contextmenu="openColumnMenu($event, col.key)"
      >
        <div class="pwg-head">
          <button class="lpill" :title="groupCollapsed(col.key) ? '点击展开' : '点击折叠'"
            @click="toggleGroup(col.key)">
            <span class="chev" :class="{ open: !groupCollapsed(col.key) }"></span>
            <span class="gdot" :class="'gdot-' + statusClass(col.key)"></span>
            <span class="glabel">{{ col.label }}</span>
            <span class="gn">{{ col.tasks.length }}</span>
          </button>
          <span class="pwg-line"></span>
          <!-- 分区头整组勾选（2026-10-25 第 11 条），与列/列表视图同一套逻辑 -->
          <label v-if="batchMode && col.tasks.length" class="grp-chk"
            :title="groupAllSelected(col)
              ? `取消这一整组「${col.label}」（${col.tasks.length} 个）`
              : `把这一整组「${col.label}」（${col.tasks.length} 个）加进选择`"
            @click.stop>
            <input type="checkbox" :checked="groupAllSelected(col)"
              :indeterminate="groupSomeSelected(col)" @change="toggleGroupSelect(col)" />
          </label>
        </div>
        <div class="pwc-grid" v-show="!groupCollapsed(col.key)">
          <TaskCardMenu v-for="t in col.tasks" :key="'pwc-' + t.id" :task="t" @pick="onCardMenuPick">
            <div
              class="pvcard"
              :class="['tone-' + (cw(t).tone || 'none'), {
                stale: isStale(t),
                overdue: isOverdue(t),
                selected: selectedBatch.includes(t.id),
                dragging: draggingId === t.id
              }]"
              :data-id="t.id"
              draggable="true"
              @dragstart="onDragStart($event, t.id)"
              @click="batchMode ? toggleBatchSelect(t.id) : openCard(t)"
              @mouseenter="onCardEnter($event, t)"
              @mouseleave="onCardLeave()"
            >
              <div class="pwc-head">
                <input v-show="batchMode" type="checkbox" class="batch-chk"
                  :checked="selectedBatch.includes(t.id)" @click.stop="toggleBatchSelect(t.id)" />
                <span class="pwc-id" :title="'任务 ID：' + t.id + '（点一下复制）'"
                  @click.stop="copyId(t.id)">{{ cw(t).id }}</span>
                <span class="st pwc-st" :class="'st-' + statusClass(t.status)">{{ t.status }}</span>
                <span v-if="t.archived" class="src-badge" title="归档任务">📦</span>
              </div>
              <div class="pwc-title">{{ t.title || t.id }}</div>
              <div class="pwc-foot">
                <span v-if="cw(t).tone" class="pwc-prio" :class="'pwc-prio-' + cw(t).tone">{{ cw(t).priority }}</span>
                <span v-if="cw(t).blocked" class="pwc-blk"
                  :title="'被 ' + cw(t).blockedBy + ' 个任务挡着'">被卡 {{ cw(t).blockedBy }}</span>
                <span v-else-if="cw(t).blocks" class="pwc-blks"
                  :title="'它挡着 ' + cw(t).blocks + ' 个任务'">挡 {{ cw(t).blocks }}</span>
                <span class="pwc-f1"></span>
                <span v-if="cardDate(t).text" class="pwc-date" :class="{ over: cardDate(t).over }"
                  :title="cardDate(t).kind === 'due' ? '截止日' : '最后更新'">{{ cardDate(t).text }}</span>
                <span class="pwc-proj" :title="normProject(t.project) || '未归属任何项目'">{{ projShort(t.project) }}</span>
              </div>
            </div>
          </TaskCardMenu>
          <div v-if="!col.tasks.length" class="pwg-empty">拖拽卡片到此处</div>
        </div>
      </div>
      <div v-if="cardWallOpenOnly && !cardWallGroups.length" class="pwg-empty pvw-allhidden">
        这里的任务都已完成 —— 关掉「只看未完成」就能看到它们。
      </div>
    </div>

    <!-- 列视图（默认摆法，保持不变）。用 template v-if 包住是为了让两种摆法**互斥**：
         同时挂在 DOM 里会造出"同一批卡片存在两份"（批量全选、键盘焦点、e2e 计数全会翻倍）。
         ⚠ 注释里不要写尖括号形式的 template 标签 —— 守卫 check-button-styles 靠正则数标签配对，
           注释里的开标签会被算进深度，直接导致"无法切分 template / style 块"。 -->
    <template v-if="boardView === 'cols'">
    <div
      v-for="col in columns"
      :key="col.key"
      class="col"
      :class="{ empty: !col.tasks.length, dragover: dragoverCol === col.key, 'collapsed-col': groupCollapsed(col.key) }"
      :data-status="col.key"
      @dragover.prevent="onDragOver($event, col.key)"
      @dragleave="dragoverCol = null"
      @drop="onDrop($event, col.key)"
      @contextmenu="openColumnMenu($event, col.key)"
    >
      <h3 @click="toggleGroup(col.key)" :title="groupCollapsed(col.key) ? '点击展开' : '点击折叠'">
        <span class="chev" :class="{ open: !groupCollapsed(col.key) }"></span>
        <span class="status-label">
          <span class="status-dot"></span>
          {{ col.label }}
        </span>
        <span class="n">{{ col.tasks.length }}</span>
        <!-- 2026-10-25（暮雨第 11 条）：多选模式下分区头整组勾选。
             「一堆空草稿想全部归档」以前要走 筛选草稿 → 多选 → 全选 → 归档 四步；
             现在点这一下就选中整组，其他组不受影响。-->
        <label v-if="batchMode && col.tasks.length" class="grp-chk"
          :title="groupAllSelected(col)
            ? `取消这一整组「${col.label}」（${col.tasks.length} 个）`
            : `把这一整组「${col.label}」（${col.tasks.length} 个）加进选择`"
          @click.stop>
          <input type="checkbox" :checked="groupAllSelected(col)"
            :indeterminate="groupSomeSelected(col)" @change="toggleGroupSelect(col)" />
        </label>
      </h3>
      <TaskCardMenu v-for="t in col.tasks" :key="'kan-' + t.id" :task="t" @pick="onCardMenuPick">
        <div
          v-show="!groupCollapsed(col.key)"
          class="card"
          :class="{
            stale: isStale(t),
            overdue: isOverdue(t),
            selected: selectedBatch.includes(t.id),
            dragging: draggingId === t.id
          }"
          :data-id="t.id"
          draggable="true"
          @dragstart="onDragStart($event, t.id)"
          @dragend=""
          @click="batchMode ? toggleBatchSelect(t.id) : openCard(t)"
          @mouseenter="onCardEnter($event, t)"
          @mouseleave="onCardLeave()"
        >
          <!-- 紧凑单行卡（2026-09-28 密度方案 B）。
               原来卡是两行（标题+状态徽章 / 正文两行截断 / 标签行），14 张的完成列能顶满一屏。
               现在压成一行：状态点 + 标题（超长省略） + 右侧 meta。
               正文摘要与标签没丢，移进上面的悬停轻提示 —— 那本来也是"点开才有用"的东西。
               ⚠ `active-t`（整卡淡紫底 + 3px 左条）已删：状态由**列位置**承担，
                 卡级再染一遍是冗余编码，而且卡片一多整列都在发光（用户第 4 条"越看越头痛"）。 -->
          <div class="card-head">
            <input
              v-show="batchMode"
              type="checkbox"
              class="batch-chk"
              :checked="selectedBatch.includes(t.id)"
              @click.stop="toggleBatchSelect(t.id)"
            />
            <span class="card-liv" :class="'liv-' + statusClass(t.status)" :title="t.status"></span>
            <b class="ttl">
              <span v-if="t.batch" class="batch">批{{ t.batch }}</span>
              {{ t.title || t.id }}
            </b>
            <!-- 状态徽章只在「不按状态分组」时才出现：按状态分组时列位置已经说明了状态，
                 多一个文字徽章只是重复占宽（紧凑卡上宽度很贵）。 -->
            <span v-if="groupMode !== 'status'" class="st" :class="'st-' + statusClass(t.status)">{{ t.status }}</span>
            <span v-if="t.archived" class="src-badge" title="归档任务">📦</span>
            <!-- 右侧 meta：**所属项目 + 日期常驻可见**（2026-09-28 用户反馈「希望看见所属项目和日期」）。
                 日期优先截止日（可行动），没有截止日就退到「更新」——保证卡上永远有一个日期。
                 cardDate() 是纯函数且很便宜，表里多调两次无所谓（每次重渲染才跑，不是每帧）。 -->
            <span class="card-meta">
              <span v-if="cardDate(t).text" class="card-date"
                :class="{ over: cardDate(t).over, dim: cardDate(t).kind === 'updated' }"
                :title="cardDate(t).kind === 'due' ? '截止日' : '最后更新'">{{ cardDate(t).text }}</span>
              <span class="card-proj" :title="normProject(t.project) || '未归属任何项目'">{{ projShort(t.project) }}</span>
            </span>
          </div>
          <!-- 2026-10-30 暮雨第 2 条：驳回理由必须**一直看得见**。
               以前理由只埋在 result_log 一段长文本里，退回返工后卡面没有任何痕迹，
               「驳回」等于白做。现在独立字段 + 卡面一行，退回返工也不消失。 -->
          <div v-if="rejectReasonOf(t) || t.reject_at" class="card-reject"
            :title="(rejectReasonOf(t) || '当时没写理由') + (t.reject_at ? '\n驳回于 ' + formatDateTime(t.reject_at) : '')">
            <span class="cr-lbl">{{ t.status === '驳回' ? '↩ 驳回理由' : '↩ 上次驳回' }}</span>
            <span class="cr-txt">{{ rejectReasonOf(t) || '没写理由' }}</span>
          </div>
          <!-- 2026-10-30（暮雨第 3 条）：「待验收」的卡在列表里**没有任何可点的出口**，
               只能先点开详情、再滚到底部才能裁决 —— 看起来就是个动不了的尴尬状态。
               把两个出口直接放到卡上：通过 / 驳回都进同一个裁决框（要留痕），
               区别只是打开后焦点落在哪 —— 不再需要先猜"点哪里"。 -->
          <div v-if="t.status === '待验收'" class="card-verdict" @click.stop @mousedown.stop>
            <button class="ok" title="通过验收（可填验收结论，会写进结果记录）"
              @click.stop="openReview(t, 'accept')">✅ 通过</button>
            <button class="danger" title="驳回（必须填理由，会写进结果记录）"
              @click.stop="openReview(t, 'reject')">↩ 驳回</button>
          </div>
        </div>
      </TaskCardMenu>
      <div v-if="!col.tasks.length" v-show="!groupCollapsed(col.key)" class="emptyhint">拖拽卡片到此处</div>
    </div>
    </template>
  </main>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import TaskCardMenu from '../components/TaskCardMenu.vue'
import { statusClass } from '../../shared/status'
import { formatDateTime } from '../../shared/time'

/**
 * 唯一 prop：看板控制器（父组件用 `reactive()` 包过的那一坨）。
 *
 * 两类绑定分两种接法：
 *   · **状态**（含 computed）→ `toRef(ctl, 'x')`：读写都落在父组件的 reactive 代理上；
 *   · **动作**（函数）→ 直接解构：函数不是 ref，不需要响应式。
 */
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl

// ── 状态 ──────────────────────────────────────────────────────────────
const boardClass = toRef(ctl, 'boardClass')
const boardView = toRef(ctl, 'boardView')
const columns = toRef(ctl, 'columns')
const cardWallGroups = toRef(ctl, 'cardWallGroups')
const cardWallOpenOnly = toRef(ctl, 'cardWallOpenOnly')
const groupMode = toRef(ctl, 'groupMode')
const batchMode = toRef(ctl, 'batchMode')
const selectedBatch = toRef(ctl, 'selectedBatch')
const collapsedGroups = toRef(ctl, 'collapsedGroups')
const dragoverCol = toRef(ctl, 'dragoverCol')
const draggingId = toRef(ctl, 'draggingId')

// ── 动作 / 派生（留在 App，组件只调）──────────────────────────────────
const {
  onDragStart, onDragOver, onDrop, onCardEnter, onCardLeave, onCardMenuPick,
  openCard, openColumnMenu, openReview, copyId, cw,
  toggleGroup, groupCollapsed, groupAllSelected, groupSomeSelected, toggleGroupSelect,
  toggleBatchSelect, isStale, isOverdue, cardDate, projShort, normProject, rejectReasonOf,
} = ctl
</script>
