<!--
  执行日志视图（2026-10-23 · 拆分第 1 批第 11 块：模板搬成组件）

  **边界**：与待办（第 10 块）同一套做法 —— 组件只「显示 + 收集意图」，一个副作用都不留。
  父组件把日志那一整坨状态与动作（约 45 个绑定）用 `reactive()` 包成一个对象，
  作为唯一 prop `ctl` 传进来，组件再用 `toRef` 逐个接成顶层绑定 —— **模板因此一字未改**。

  **为什么日志的弹窗没跟着搬**：日志编辑框 / 接力框 / 清理归档框都必须在**任何视图**下能打开 ——
  从日历点一条日志（`open-log`）就会调 `openLog`，而那时 `curView !== 'logs'`。
  搬进本组件的话，组件被 `v-if` 挡着，弹窗整个不渲染 —— 用户点日历上的日志什么也不会发生。
  所以弹窗仍留在 App.vue，本组件只搬 `<main class="logs-view">` 这一层。

  ⚠ `<main id="board" class="logs-view">` 这层壳必须留着：视图互斥、几何断言、
    「.logs-view .batch-bar」这类后代选择器都按它选。

  ⚠ 这里**不许**用 Tailwind 工具类：`tailwind.config.js` 的 content 只覆盖
    `src/renderer/components/`（`check-ui-base` 守着），views/ 下写的 utility 不会生成 CSS。
-->
<template>
  <main id="board" class="logs-view"
    @dragenter.prevent="dragEnter('log')"
    @dragover.prevent="dragPulse()"
    @dragleave="dragLeave('log')"
    @drop="onLogDrop"
    :class="{ 'drop-target': logDragOver }"
  >
    <!-- 工具栏吸顶容器（2026-10-10 用户第 3 条：「新建日志等工具按钮不能始终冻结在
         最顶列，稍微往下拉一点就看不到了」）。原实现里 header 与批量栏都是流内元素，
         跟着 .logs-view 一起滚 —— 列表一长就找不到入口。
         做法：header + 批量栏包进这个 sticky 容器，top padding 由容器自带（.logs-view 的
         padding-top 已让给它），滚动时列表从它下面穿过。
         ⚠ 断言用的是 `.logs-view .batch-bar` 这类**后代**选择器，加这层包裹不影响。 -->
    <div class="logs-sticky">
    <div class="logs-header">
      <h3>执行日志</h3>
      <div class="logs-ctrls">
        <input
          v-model="logSearchInput"
          placeholder="搜索日志..."
          class="log-search"
          @keydown.enter="executeLogSearch"
        />
        <!-- 状态筛选下拉已被**分区**取代（2026-09-28 用户第 5 条）：
             状态是一个"要同时看三样"的东西，用单选下拉只会把画面切碎。
             现在只在下面按 进行中/待处理/已完成/已归档 分区。 -->
        <select v-model="logProjectFilter" class="log-filter" @change="loadLogs">
          <option value="">全部项目</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
        </select>
        <!-- 排序（2026-10-01 用户第 2 条：日志/待办/看板的排序筛选要灵活）。
             日志此前**只能**按创建倒序，连正序都翻不过来 —— 与待办/看板对齐成一个下拉。 -->
        <select v-model="logSort" class="log-filter" title="排序方式">
          <option value="created_desc">最新创建在前</option>
          <option value="created_asc">最早创建在前</option>
          <option value="date_desc">按归属日期（新→旧）</option>
          <option value="title_asc">按标题排序</option>
          <!-- 卡 001（2026-10-08 拍板=新增日志优先级字段）：高→中→低→未标，同级按创建倒序 -->
          <option value="prio_desc">按优先级（高→低）</option>
        </select>
        <!-- 低频筛选收进抽屉（2026-09-28 用户第 5 条）：Agent / 日期范围此前与搜索框
             并排摊开，6 个控件挤一条线。抽屉里有值时按钮上带角标，避免"筛了却忘了"。 -->
        <button class="ghost log-more-btn" :class="{ on: logMoreFilterOpen }"
          title="更多筛选：按 Agent、按日期范围" @click="toggleLogMoreFilter">
          ⚙ 更多筛选<span v-if="logMoreFilterCount" class="more-badge">{{ logMoreFilterCount }}</span>
        </button>
        <template v-if="logMoreFilterOpen">
          <select v-model="logAgentFilter" class="log-filter" @change="loadLogs">
            <option value="">全部 Agent</option>
            <option v-for="a in agentPresets" :key="a" :value="a">{{ a }}</option>
          </select>
          <input v-model="logDateFrom" type="date" class="log-filter" title="起始日期（含）" @change="loadLogs" />
          <span class="log-filter-sep">→</span>
          <input v-model="logDateTo" type="date" class="log-filter" title="截止日期（含）" @change="loadLogs" />
          <button class="ghost" title="清空 Agent 与日期筛选" @click="clearLogMoreFilters">清空</button>
        </template>
        <!-- 2026-09-23：日志批量操作入口（用户第1条） -->
        <button class="ghost batch-mode-btn" :class="{ active: logBatchMode }" @click="toggleLogBatchMode" title="开启批量选择，点击卡片即勾选/取消">
          <span v-if="!logBatchMode">☑ 多选</span>
          <span v-else>☑ <i style="color:#fff">{{ selectedLogBatch.length || 0 }}</i></span>
        </button>
        <button @click="openNewLog">+ 新建日志</button>
        <!-- 分区｜按链 分段开关（2026-09-29 第 3 条方案二）：
             默认仍是「分区」—— 加视图不改旧的；「按链」把接力链串成一条竖轨。 -->
        <div class="log-view-seg" title="分区：按状态分块（默认）；按链：把接力链（续自）串成一条竖轨">
          <button class="lvs" :class="{ on: logsViewMode === 'groups' }" @click="setLogsViewMode('groups')">分区</button>
          <button class="lvs" :class="{ on: logsViewMode === 'chain' }" @click="setLogsViewMode('chain')">按链</button>
        </div>
        <button class="ghost" title="把外部 txt / md / log 导入成日志（也可直接把文件拖进来）" @click="importLogFile">↑ 导入文件</button>
        <!-- 「清理超期」到底做什么：把 status=completed 且 retain_until 已过的日志
             批量改成 archived（**只改状态，不删文件**，logs.ts:cleanupLogs）。
             此前只有这四个字，用户不知道它有什么用（第 3 条）。 -->
        <button class="ghost"
          title="把「已完成」且保留期已过的日志批量标为「已归档」（只改状态，不删除文件）。保留期在点「完成」时填写"
          @click="executeLogCleanup">清理超期</button>
        <!-- 按日期批量清理「已归档」日志（2026-10-13 暮雨第 2 条）：
             与「清理超期」的区别要一眼看清 —— 那个只改状态，这个真删（软删到回收站）。 -->
        <button class="ghost"
          title="按日期批量清理「已归档」日志：移进回收站（可恢复），可先预览命中条数"
          @click="openLogPurge">清理归档…</button>
      </div>
    </div>
    <div v-if="logBatchMode" class="batch-bar">
      <span class="batch-count">已选 {{ selectedLogBatch.length }}</span>
      <button class="ghost" @click="toggleSelectAllLogs">{{ selectedLogBatch.length === filteredLogs.length ? '取消全选' : '全选' }}</button>
      <!-- 批量优先级（2026-10-09 用户第 4 条「日志多选更智能，比如批量修改日志优先级」）：
           改元数据可逆 → 不弹确认、做完**不退出多选**，连着调几档是正常用法；
           非「待处理」的日志后端拒改 → 跳过几条如实 toast，不静默。 -->
      <select class="batch-prio" value="" @change="executeBatchLogPriority($event)"
              title="给选中的日志批量设置优先级（非「待处理」的日志会如实跳过）">
        <option value="" disabled>批量优先级…</option>
        <option value="高">高</option>
        <option value="中">中</option>
        <option value="低">低</option>
        <option value="__clear__">清除</option>
      </select>
      <button class="ghost" title="批量标为已完成（不需要先标「进行中」）" @click="executeBatchLogComplete">批量完成</button>
      <button class="ghost" title="批量收进「已归档」分区（只改状态，不删文件）" @click="executeBatchLogArchive">批量归档</button>
      <button class="danger" title="批量彻底删除（会二次确认，不可撤销）" @click="executeBatchLogDestroy">批量彻底删除</button>
      <button class="ghost" title="退出多选模式并清空选择" @click="selectedLogBatch = []; logBatchMode = false">取消</button>
    </div>
    </div>
    <div v-if="logDragOver" class="log-drop-hint">松手导入：每个文件生成一条日志（支持 txt / md / log）</div>
    <div class="logs-list">
      <div v-if="!filteredLogs.length" class="empty-state">
        <div class="empty-icon">📋</div>
        <div class="empty-text">暂无执行日志</div>
      </div>
      <!-- 按状态分区（2026-09-28 用户第 2/5 条）：
           用户原话「分不清哪些没跑、哪些 Agent 正在跑、哪些跑完了」——
           那就让这三种东西在屏幕上**各占一块**，而不是靠一个状态下拉去筛。
           分区顺序 = 关心的顺序：置顶 → 进行中 → 待处理 → 已完成 → 已归档。
           空分区直接不渲染（不留一个"0 条"的空壳）。 -->
      <template v-for="g in renderSections" :key="g.key">
        <!-- 链头（按链视图，2026-09-29 方案二）：链名 + 段数 + 起于/最近 + 两个动作 -->
        <div v-if="g.chain" class="chain-header">
          <span class="chain-ic">⛓</span>
          <span class="chain-name">{{ g.chain.name }}</span>
          <span class="chain-meta">{{ g.chain.count }} 段 · 起于 {{ g.chain.since }} · 最近活跃 {{ g.chain.recent }}</span>
          <span class="chain-grow"></span>
          <button class="ghost" title="从这条链的最新一格接力：出清旧的 + 建新日志（一个对话框做完四件事）" @click="openRelay(g.chain.tail)">＋ 从链尾继续</button>
          <button class="ghost" title="复制链尾日志 ID —— 贴给 AI，get_log 会带回整条链的上下游" @click="copyId(g.chain.tail.id)">⧉ 复制链 ID</button>
        </div>
        <!-- 分区头（分区视图，原样） -->
        <div v-else-if="g.label" class="log-group-sep" :class="'g-' + g.key">
          <button class="log-group-toggle" @click="toggleLogGroup(g.key)">
            <span class="chev" :class="{ open: !isLogGroupCollapsed(g.key) }"></span>
            <span class="gdot"></span>
            <span class="glabel">{{ g.label }}</span>
            <span class="gn">{{ g.logs.length }}</span>
          </button>
          <span v-if="g.hint" class="log-group-hint">{{ g.hint }}</span>
        </div>
        <!-- 分区/单条 = display:contents（对布局完全透明，卡片仍是 .logs-list 的弹性子项）；
             链 = 竖轨包裹（轨道线 + 节点圆点画在 .chain-rail 上）。 -->
        <div class="log-section" :class="{ 'chain-rail': !!g.chain }" v-show="g.chain || !isLogGroupCollapsed(g.key)">
        <div
          v-for="log in g.logs"
          :key="log.id"
          class="log-card"
          :class="{ active: log.status === 'active', running: log.running, completed: log.status === 'completed', archived: log.status === 'archived', pinned: log.pinned, selected: logBatchMode && selectedLogBatch.includes(log.id) }"
          @click="onLogCardClick(log)"
          @contextmenu.prevent="openLogMenu($event, log)"
        >
        <div class="log-card-head">
          <span v-if="log.pinned" class="log-pin" title="已置顶：钉在列表最上面">📌</span>
          <span class="log-status-badge" :class="logStatusClass(log)">{{ logStatusLabel(log) }}</span>
          <!-- 卡 001：标了优先级的日志在卡面上直接看得见（不标就不占位，历史日志零变化） -->
          <span v-if="log.priority" class="log-prio-badge" :class="'lp-' + logPrioKey(log.priority)"
            :title="'日志优先级：' + localPriority(log.priority)">{{ localPriority(log.priority) }}</span>
          <span class="log-card-title">{{ log.title || '(无标题)' }}</span>
          <span v-if="log.attachments && log.attachments.length" class="log-attach-badge"
            :title="log.attachments.length + ' 个附件（截图 / 报告）'">📎{{ log.attachments.length }}</span>
          <span class="log-card-date" :title="log.created">{{ formatDateTime(log.created) }}</span>
        </div>
        <div class="log-card-body">{{ truncate(log.content, 120) }}</div>
        <div class="log-card-meta">
          <span v-if="log.project" class="log-project">{{ (projects.find(p => p.id === log.project)?.name) || log.project }}</span>
          <span v-if="log.taskId" class="log-task">📍 {{ log.taskId }}</span>
          <span v-if="log.agentName" class="log-agent" title="本次执行 Agent">🤖 {{ log.agentName }}</span>
          <!-- 2026-10-03 用户反馈1（卡 task-20261003-001）：上次的执行 Agent 单独标出 ——
               找上一段的会话就去这个 Agent 里找，不再和「本次」混在一个字段里 -->
          <span v-if="log.prevAgentName" class="log-prev-agent"
            title="上次的执行 Agent（接力来源那段是谁跑的）—— 找上次的会话就去这个 Agent 里找">⤴ 上次 {{ log.prevAgentName }}</span>
          <span v-if="log.sessionId" class="log-session" :title="log.sessionId">🔗 {{ log.sessionId.slice(0, 16) }}{{ log.sessionId.length > 16 ? '…' : '' }}</span>
          <span v-if="log.completed" class="log-completed">✓ {{ formatDate(log.completed) }}</span>
          <!-- 改过留痕（2026-10-18 暮雨第 2 条）：已完成的日志现在能改，但改过就亮这个戳 ——
               不是拦着不让改，而是让"这条被事后动过"看得见。 -->
          <span v-if="log.edited" class="log-edited" :title="'最后一次改正文：' + formatDateTime(log.edited)">✎ 改过</span>
          <!-- 卡 004 日志⇄待办互转：目标记录「由 X 转来」（与接力链同款 prev 范式） -->
          <span v-if="log.fromTodo" class="log-from"
            :title="'由待办 ' + log.fromTodo + ' 转来（源待办保留）'">⤴ 待办</span>
          <!-- 接力链（2026-09-29 方案二）：继承来的日志挂一个可复制的链标签 -->
          <span v-if="log.continueFrom" class="chain-tag"
            :title="'接力自 ' + log.continueFrom + ' —— 点一下复制它的 ID'"
            @click.stop="copyId(log.continueFrom)">⛓ 续自 {{ shortLogId(log.continueFrom) }}</span>
          <!-- 2026-09-29 用户第 2 条：日志没有可复制给 AI 的 ID，只能整篇注入 —— 卡面上直接给 ID，点一下只复制 ID -->
          <span class="log-id" title="日志 ID —— 点一下复制，贴给 AI 就能精确定位这一条（不必整篇注入）"
            @click.stop="copyId(log.id)">⧉ {{ log.id }}</span>
        </div>
        <!-- 操作行（2026-09-28 用户第 2 条重排）：
             「进行中」是一个**手动开关**，可开可关；完成/归档**不要求**先打开它，
             所以「完成」按钮在任何未完成/未归档的日志上都直接可用。 -->
        <div class="log-card-actions" @click.stop>
          <button class="ghost" title="编辑这条日志（点击卡片是只读预览）" @click="openLog(log)">✏️ 编辑</button>
          <button class="ghost" title="复制成可直接粘给 agent 的提示词块" @click="copyLogAsPrompt(log.id)">📋 复制</button>
          <!-- 卡 004（2026-10-08 拍板=双向）：日志 → 待办。
               2026-10-09 用户第 1 条：先开确认框（可顺手勾「归档源」）；同一条只转一次（待办记 fromLog 防重）。 -->
          <button class="ghost" title="把这条日志的「下一步」变成一条待办（先确认，可顺手把源日志归档）—— 同一条只转一次"
            @click="askConvertLog(log)">⤴ 转待办</button>
          <!-- 接力（2026-09-29 方案二）：完成态才有「下一段」——出清 + 新建 + 可开跑在一个对话框里做完 -->
          <button v-if="log.status === 'completed'" class="ghost relay-btn"
            title="接力：出清这条 + 建新日志继承「下一步」/项目/任务/Agent —— 一个对话框做完四件事"
            @click="openRelay(log)">⏭ 从这里继续</button>
          <button class="ghost log-run-btn" :class="{ on: log.running }"
            :title="log.running
              ? '撤销「进行中」标记，回到「待处理」'
              : '手动标为「进行中」——只有点了它，这条才算正在跑（不会自动打上）'"
            @click="toggleLogRunning(log)">{{ log.running ? '⏸ 撤销进行中' : '▶ 标为进行中' }}</button>
          <button v-if="log.status !== 'completed' && log.status !== 'archived'" class="ghost"
            title="标记完成（不需要先标「进行中」）" @click="completeLogItem(log.id)">完成</button>
          <button v-if="log.status === 'completed' || log.status === 'archived'" class="ghost"
            title="撤销完成 / 撤销归档，退回「待处理」（只改状态，不删文件）"
            @click="reopenLogItem(log.id)">↩ 撤销</button>
          <button v-if="log.status !== 'archived'" class="ghost" title="收进「已归档」分区" @click="archiveLogItem(log.id)">归档</button>
          <button class="danger" title="彻底删除这条日志（会二次确认，不可撤销）" @click="destroyLogItem(log.id)">彻底删除</button>
        </div>
      </div>
        </div>
      </template>
    </div>
  </main>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { formatDate, formatDateTime } from '../../shared/time'
import { localPriority } from '../../shared/priority'

/**
 * 唯一 prop：日志控制器（父组件用 `reactive()` 包过的那一坨）。
 *
 * 两类绑定分两种接法，别统一成一种：
 *   · **状态**（含 computed）→ `toRef(ctl, 'x')`：读写都落在父组件的 reactive 代理上，
 *     `v-model` 能写回、派生值跟着源头变。**直接解构不行** —— 解构拿到的是当时的快照。
 *   · **动作**（函数）→ 直接解构：函数不是 ref，不需要响应式，deconstruct 拿到的就是函数本体。
 */
const props = defineProps<{ ctl: any }>()

const ctl = props.ctl

// ── 状态 ──────────────────────────────────────────────────────────────
const logSearchInput = toRef(ctl, 'logSearchInput')
const logProjectFilter = toRef(ctl, 'logProjectFilter')
const logSort = toRef(ctl, 'logSort')
const logMoreFilterOpen = toRef(ctl, 'logMoreFilterOpen')
const logMoreFilterCount = toRef(ctl, 'logMoreFilterCount')
const logAgentFilter = toRef(ctl, 'logAgentFilter')
const logDateFrom = toRef(ctl, 'logDateFrom')
const logDateTo = toRef(ctl, 'logDateTo')
const logBatchMode = toRef(ctl, 'logBatchMode')
const selectedLogBatch = toRef(ctl, 'selectedLogBatch')
const logsViewMode = toRef(ctl, 'logsViewMode')
const filteredLogs = toRef(ctl, 'filteredLogs')
const renderSections = toRef(ctl, 'renderSections')
const logDragOver = toRef(ctl, 'logDragOver')
const projects = toRef(ctl, 'projects')
const agentPresets = toRef(ctl, 'agentPresets')

// ── 动作（不需要响应式）────────────────────────────────────────────────
const {
  // 读 / 筛 / 排序
  loadLogs, executeLogSearch, toggleLogMoreFilter, clearLogMoreFilters,
  setLogsViewMode, toggleLogGroup, isLogGroupCollapsed,
  // 单条
  openNewLog, openLog, openLogMenu, onLogCardClick, openRelay, openLogPurge,
  copyId, copyLogAsPrompt, askConvertLog,
  toggleLogRunning, completeLogItem, reopenLogItem, archiveLogItem, destroyLogItem,
  executeLogCleanup, importLogFile,
  // 批量
  toggleLogBatchMode, toggleSelectAllLogs,
  executeBatchLogPriority, executeBatchLogComplete, executeBatchLogArchive, executeBatchLogDestroy,
  // 卡面派生（读 log 对象，纯显示）
  logStatusClass, logStatusLabel, logPrioKey, truncate, shortLogId,
  // 拖入导入 + 拖拽高亮（全站拖拽态）
  onLogDrop, dragEnter, dragPulse, dragLeave,
} = ctl
</script>
