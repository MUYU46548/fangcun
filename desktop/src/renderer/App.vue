<template>
  <div id="app"
    @dragenter.prevent="dragEnter('global')"
    @dragover.prevent
    @dragleave="dragLeave('global')"
    @drop="onAppDrop"
  >
    <!-- Decorative blobs -->
    <div class="blob b1"></div>
    <div class="blob b2"></div>

    <!-- 全局拖放兜底提示：拖到不支持导入的页签时不再是"毫无反应"（用户第 4 条）
         固定定位 + pointer-events:none —— 绝不参与布局，否则会与拖拽事件自激闪烁 -->
    <div v-if="globalDropHint" class="drop-hint global">
      当前页签不支持导入文件 —— 请到「待办」或「日志」页签再拖入
    </div>

    <!-- Top bar -->
    <header id="bar">
      <span class="title">方寸 tegula<small id="count">{{ tasks.length }}</small></span>
      <button v-if="canGoBack" class="ghost nav-back" title="返回上一个视图" @click="goBack">← 返回</button>
      <span v-if="parseErrors.length" class="parse-warn" :title="parseErrors.join('\n')" @click="showParseErrors">
        ⚠ {{ parseErrors.length }} 个文件无法解析
      </span>
      <span class="ctrls">
        <select v-model="curProj" class="proj-select">
          <option value="__all__">全部项目</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
        </select>
        <select v-model="groupMode">
          <option value="status">按状态</option>
          <option value="project">按项目</option>
          <option value="priority">按优先级</option>
        </select>
        <input v-model="searchQuery" placeholder="搜索...（支持 #tag @proj due:MM-DD 关键词 Enter=自然查询）" class="search" @keydown.enter="executeNaturalQuery" />
        <select v-model="dueFilter" class="due-filter">
          <option value="">全部时间</option>
          <option value="overdue">已逾期</option>
          <option value="today">今天到期</option>
          <option value="week">本周到期</option>
        </select>
        <!-- 「含归档」只在活跃视图有意义（把归档任务也列进看板/搜索）。
             归档视图里它只会造成"同一批任务是否重复出现"的困惑，所以直接隐藏（2026-09-25）。 -->
        <label v-if="curView !== 'archive'" class="chk"><input type="checkbox" v-model="searchIncludeArchive" /> 含归档</label>
        <select v-model="sortMode">
          <option value="active">活跃优先</option>
          <option value="updated">最近更新</option>
          <option value="created">创建时间</option>
        </select>
        <button @click="openNew">+ 新建</button>
        <button class="ghost backup-btn" :class="bkDotClass" :title="bkTooltip" @click="showBackup">
          <span v-if="bkBusy" class="bk-spin">⟳</span>
          <span v-else>💾</span>
          <span v-if="bkAlert" class="bk-alert-dot"></span>
        </button>
        <button v-if="ncReady" class="ghost nc-bell" title="通知中心" @click.stop="ncToggle">
          <span>🔔</span>
          <span v-if="ncUnread > 0" class="nc-badge">{{ ncUnread > 99 ? '99+' : ncUnread }}</span>
        </button>
        <button class="ghost" title="诊断日志（应用日志文件尾部 + 打开目录）" @click="toggleAppLogPanel">📋</button>
        <button class="ghost batch-mode-btn" :class="{ active: batchMode }" @click="toggleBatchMode">
          <span v-if="!batchMode">☑ 任务多选</span>
          <span v-else>☑ <i style="color:#fff">{{ selectedBatch.length || 0 }}</i></span>
        </button>
        <button class="ghost" @click="showSettings">⚙</button>
      </span>
    </header>

    <!-- View tabs -->
    <nav id="views" :class="{ 'batch-on': batchMode }">
      <button
        v-for="v in views"
        :key="v.id"
        class="vbtn"
        :class="{ on: curView === v.id }"
        @click="switchView(v.id)"
      >
        {{ v.label }}
      </button>
    </nav>

    <!-- 错误条（2026-09-22，用户第 8 条）：任何失败都在这里有痕迹。
         main.ts 的 window.onerror / unhandledrejection 上报广播过来，
         由主进程落盘到 userData/logs，这里给一个用户可见的出口。 -->
    <div v-if="appErrors.length" class="errbar">
      <span class="errbar-ico">⚠</span>
      <span class="errbar-msg" :title="appErrors.map(e => '[' + e.scope + '] ' + e.message).join('\n')">
        {{ appErrors[appErrors.length - 1].message }}
        <b v-if="appErrors.length > 1">（共 {{ appErrors.length }} 条）</b>
      </span>
      <button class="ghost" @click="toggleAppLogPanel">{{ appErrOpen ? '收起' : '查看日志' }}</button>
      <button class="ghost" @click="openAppLogDir">打开日志目录</button>
      <button class="ghost" title="清空错误条（日志文件不受影响）" @click="appErrors = []">忽略</button>
    </div>
    <div v-if="appErrOpen" class="errpanel">
      <div class="errpanel-head">
        <span>日志文件：<code>{{ appLogFile || '（未取到）' }}</code></span>
        <button class="ghost" @click="copyAppLogPath">复制路径</button>
        <button class="ghost" @click="openAppLogDir">打开目录</button>
        <!-- 收起按钮必须长在这里：上一条「忽略」会清空 appErrors，而「收起」原先只存在于
             errbar 里（v-if="appErrors.length"）—— 一按忽略，errbar 整条消失，
             日志抽屉就再也关不掉了（用户 2026-09-25 第 4 条）。 -->
        <button class="ghost" title="关闭日志抽屉" @click="appErrOpen = false">收起</button>
      </div>
      <pre class="errpanel-body">{{ appLogTail.join('\n') || '（日志为空）' }}</pre>
    </div>

    <!-- Batch action bar：固定悬浮在内容区顶部居中，紧邻右上角批量按钮的视线范围 -->
    <div v-if="batchMode" class="batch-bar">
      <span class="batch-count">已选 {{ selectedBatch.length }}</span>
      <button class="ghost" title="全选 / 取消全选当前视图内的任务" @click="toggleSelectAll">{{ selectedBatch.length === filteredTasks.length ? '取消全选' : '全选' }}</button>
      <div class="batch-actions">
        <button class="ghost" title="批量置为「待办」" @click="batchSetStatus('待办')">待办</button>
        <button class="ghost" title="批量置为「进行中」" @click="batchSetStatus('进行中')">进行中</button>
        <button class="ghost" title="批量置为「待验收」" @click="batchSetStatus('待验收')">待验收</button>
        <button class="ghost" title="批量置为「完成」" @click="batchSetStatus('完成')">完成</button>
        <button class="ghost" title="批量置为「驳回」" @click="batchSetStatus('驳回')">驳回</button>
        <button class="ghost" title="批量归档（会二次确认）" @click="executeBatchArchive">归档</button>
        <button class="danger" title="批量删除（会二次确认，进入 trash 可人工找回）" @click="executeBatchDelete">删除</button>
      </div>
      <button class="ghost" title="退出多选模式并清空选择" @click="selectedBatch = []; batchMode = false">取消</button>
    </div>

    <!-- Archive hint -->
    <div v-if="curView === 'archive' && showArchiveHint" class="archive-hint">
      <span>📋 归档视图：此处只显示 <strong>文件已移入 task-data/archive/ 的任务</strong>（归档的唯一判定标准是文件路径，不是状态）。归档操作只能由你亲自判定，不会自动执行。</span>
      <button @click="closeArchiveHint">知道了</button>
    </div>


    <main id="board" :class="boardClass" v-if="curView === 'active' || curView === 'archive'">
      <div
        v-for="col in columns"
        :key="col.key"
        class="col"
        :class="{ empty: !col.tasks.length, dragover: dragoverCol === col.key }"
        :data-status="col.key"
        @dragover.prevent="onDragOver($event, col.key)"
        @dragleave="dragoverCol = null"
        @drop="onDrop($event, col.key)"
      >
        <h3>
          <span class="status-label">
            <span class="status-dot"></span>
            {{ col.label }}
          </span>
          <span class="n">{{ col.tasks.length }}</span>
        </h3>
        <div
          v-for="t in col.tasks"
          :key="t.id"
          class="card"
          :class="{
            'active-t': isActiveStatus(t.status),
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
          @contextmenu.prevent="openCardMenu($event, t)"
        >
          <div class="card-head">
            <input
              v-show="batchMode"
              type="checkbox"
              class="batch-chk"
              :checked="selectedBatch.includes(t.id)"
              @click.stop="toggleBatchSelect(t.id)"
            />
            <b class="ttl">
              <span v-if="t.batch" class="batch">批{{ t.batch }}</span>
              {{ t.title || t.id }}
            </b>
            <span class="st" :class="'st-' + statusClass(t.status)">{{ t.status }}</span>
          </div>
          <small v-if="t.archived" class="src-badge">📦 已归档</small>
          <small v-if="t.body" class="card-preview">{{ truncate(t.body, 120) }}</small>
          <div class="ptags" v-if="t.tags && t.tags.length">
            <span class="ptag" v-for="tag in t.tags.slice(0, 3)" :key="tag">{{ tag }}</span>
          </div>
        </div>
        <div v-if="!col.tasks.length" class="emptyhint">拖拽卡片到此处</div>
      </div>
    </main>

    <!-- Project view -->
    <main id="board" class="pv" v-else-if="curView === 'projects'">
      <div class="alertbar" v-if="blockers.length">
        <span class="ico">⚠</span>
        <b>{{ blockers.length }}</b> 个任务存在阻塞依赖
      </div>
      <div class="pvgrid">
        <div
          v-for="p in projectStats"
          :key="p.id"
          class="tile"
          :class="'t-' + p.health"
          @click="openProject(p)"
        >
          <div class="trow">
            <span class="tname">{{ p.name }}</span>
            <span class="thealth">{{ healthLabel(p.health) }}</span>
          </div>
          <div class="tstats">
            <div class="ts">
              <div class="n">{{ p.activeTasks }}</div>
              <div class="l">进行中</div>
            </div>
            <div class="ts">
              <div class="n">{{ p.taskCount }}</div>
              <div class="l">总任务</div>
            </div>
            <div class="ts">
              <div class="progress-bar"><div class="progress-fill" :style="{width: projectProgress[p.id] ? projectProgress[p.id].percent + '%' : '0%'}"></div></div>
              <div class="l">{{ projectProgress[p.id] ? projectProgress[p.id].percent + '%' : '—' }} 完成</div>
            </div>
            <div class="ts">
              <div class="n warn" v-if="p.health === 'stuck'">⚠</div>
              <div class="l">{{ p.lastActivity ? relativeTime(p.lastActivity) : '无记录' }}</div>
            </div>
          </div>
          <!-- 方针入口挪到项目页签（用户 2026-09-25 第 3 条）：原先只藏在「设置」最底部，
               找不着；这里放在项目卡上，一眼可见，且不必先关设置。 -->
          <button class="ghost pv-policy" @click.stop="openPolicyEdit(p.id)">
            {{ policyMap[p.id] ? '📋 方针已立 · 查看/编辑' : '＋ 立项目方针' }}
          </button>
        </div>
        <div class="tile tile-add" @click="openNewProject">
          <div class="add-icon">+</div>
          <div class="add-text">添加项目</div>
        </div>
      </div>
    </main>

    <!-- Blockers view: 2026-09-23 改为按阻塞源分组（用户第 4 条） -->
    <main id="board" class="blockers-view" v-else-if="curView === 'blockers'">
      <div class="blockers-header">
        <h3>阻塞源</h3>
        <span class="blockers-count">{{ blockerChains.length }} 个阻塞源，影响 {{ totalBlockedTasks }} 个任务</span>
      </div>
      <div class="blocker-chains">
        <div v-if="!blockerChains.length" class="empty-state">
          <div class="empty-icon">✓</div>
          <div class="empty-text">没有阻塞源 — 所有任务畅通</div>
        </div>
        <div v-for="src in blockerChains" :key="src.id" class="chain-card">
          <div class="chain-main">
            <span class="chain-id">{{ src.id }}</span>
            <span class="chain-title">{{ src.title }}</span>
            <span class="st" :class="'st-' + statusClass(src.status)">{{ src.status }}</span>
          </div>
          <div class="chain-arrow">↓ 阻塞了 {{ src.blockedTasks.length }} 个任务</div>
          <div class="chain-blockers">
            <div v-for="t in src.blockedTasks" :key="t.id" class="chain-blocker">
              <span class="cb-status">◌</span>
              <span class="cb-id">{{ t.id }}</span>
              <span class="cb-title">{{ t.title }}</span>
              <span class="st small" :class="'st-' + statusClass(t.status)">{{ t.status }}</span>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- Todos view -->
    <main id="board" class="todos-view" v-else-if="curView === 'todos'"
      @dragenter.prevent="dragEnter('todo')"
      @dragover.prevent
      @dragleave="dragLeave('todo')"
      @drop="onTodoDrop"
      :class="{ 'drop-target': todoDragOver }"
    >
      <div class="todos-header">
        <h3>待办</h3>
        <div class="todos-ctrls">
          <input
            v-model="todoInput"
            placeholder="添加待办（尾缀 p0/p1/p2 定优先级）；也可直接拖入 txt/md"
            class="todo-input"
            @keydown.enter="executeTodoAdd"
          />
          <button class="ghost" @click="executeTodoAdd">+ 添加</button>
          <select v-model="todoProjectFilter" class="todo-filter" title="项目联动：筛选后新增待办自动归属该项目">
            <option value="__all__">全部项目</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
          </select>
          <select v-model="todoFilter" class="todo-filter">
            <option value="all">全部</option>
            <option value="active">未完成</option>
            <option value="done">已完成</option>
          </select>
        </div>
      </div>
      <div class="todos-note">您可以在此添加临时便签，仅供个人备忘使用。需要暂存或传递提示词的，请走「日志」页签。</div>
      <div v-if="todoDragOver" class="todo-drop-hint">松手导入：txt/md 每行一条待办</div>
      <div class="todos-list">
        <div v-if="!filteredTodos.length" class="empty-state">
          <div class="empty-icon">✓</div>
          <div class="empty-text">暂无待办</div>
        </div>
        <div
          v-for="todo in filteredTodos"
          :key="todo.id"
          class="todo-item"
          :class="{ done: todo.done, prio: localPriority(todo.priority) === '高' }"
        >
          <input
            type="checkbox"
            class="todo-chk"
            :checked="todo.done"
            @change="toggleTodo(todo.id)"
          />
          <span class="todo-title">{{ todo.title }}</span>
          <span v-if="todo.due" class="todo-due" :title="'到期日：' + todo.due">📅 {{ todo.due }}</span>
          <span v-if="todo.project" class="todo-project">{{ (projects.find(p => p.id === todo.project)?.name) || todo.project }}</span>
          <span v-if="localPriority(todo.priority) === '高'" class="todo-prio">高</span>
          <button class="todo-assign" title="指派到期日（会显示在日历上）" @click.stop="openCalAssignTodo(todo.id)">📅</button>
          <button class="todo-del" @click.stop="deleteTodo(todo.id)">×</button>
        </div>
      </div>
    </main>

    <!-- Logs view -->
    <main id="board" class="logs-view" v-else-if="curView === 'logs'"
      @dragenter.prevent="dragEnter('log')"
      @dragover.prevent
      @dragleave="dragLeave('log')"
      @drop="onLogDrop"
      :class="{ 'drop-target': logDragOver }"
    >
      <div class="logs-header">
        <h3>执行日志</h3>
        <div class="logs-ctrls">
          <input
            v-model="logSearchInput"
            placeholder="搜索日志..."
            class="log-search"
            @keydown.enter="executeLogSearch"
          />
          <select v-model="logStatusFilter" class="log-filter" @change="loadLogs">
            <option value="">全部状态</option>
            <option value="active">进行中</option>
            <option value="completed">已完成</option>
            <option value="archived">已归档</option>
          </select>
          <!-- 2026-09-23（用户第 2 条）：项目/Agent/日期范围筛选 -->
          <select v-model="logProjectFilter" class="log-filter" @change="loadLogs">
            <option value="">全部项目</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
          </select>
          <select v-model="logAgentFilter" class="log-filter" @change="loadLogs">
            <option value="">全部 Agent</option>
            <option v-for="a in agentPresets" :key="a" :value="a">{{ a }}</option>
          </select>
          <input v-model="logDateFrom" type="date" class="log-filter" title="起始日期" @change="loadLogs" />
          <input v-model="logDateTo" type="date" class="log-filter" title="截止日期" @change="loadLogs" />
          <!-- 2026-09-23：日志批量操作入口（用户第1条） -->
          <button class="ghost batch-mode-btn" :class="{ active: logBatchMode }" @click="toggleLogBatchMode" title="开启批量选择，点击卡片即勾选/取消">
            <span v-if="!logBatchMode">☑ 多选</span>
            <span v-else>☑ <i style="color:#fff">{{ selectedLogBatch.length || 0 }}</i></span>
          </button>
          <button @click="openNewLog">+ 新建日志</button>
          <button class="ghost" title="把外部 txt / md / log 导入成日志（也可直接把文件拖进来）" @click="importLogFile">↑ 导入文件</button>
          <!-- 「清理超期」到底做什么：把 status=completed 且 retain_until 已过的日志
               批量改成 archived（**只改状态，不删文件**，logs.ts:cleanupLogs）。
               此前只有这四个字，用户不知道它有什么用（第 3 条）。 -->
          <button class="ghost"
            title="把「已完成」且保留期已过的日志批量标为「已归档」（只改状态，不删除文件）。保留期在点「完成」时填写"
            @click="executeLogCleanup">清理超期</button>
        </div>
      </div>
      <div v-if="logBatchMode" class="batch-bar">
        <span class="batch-count">已选 {{ selectedLogBatch.length }}</span>
        <button class="ghost" @click="toggleSelectAllLogs">{{ selectedLogBatch.length === filteredLogs.length ? '取消全选' : '全选' }}</button>
        <button class="ghost" title="批量完成" @click="executeBatchLogComplete">批量完成</button>
        <button class="ghost" title="批量归档" @click="executeBatchLogArchive">批量归档</button>
        <button class="danger" title="批量销毁" @click="executeBatchLogDestroy">批量销毁</button>
        <button class="ghost" title="退出多选模式并清空选择" @click="selectedLogBatch = []; logBatchMode = false">取消</button>
      </div>
      <div v-if="logDragOver" class="log-drop-hint">松手导入：每个文件生成一条日志（支持 txt / md / log）</div>
      <div class="logs-list">
        <div v-if="!filteredLogs.length" class="empty-state">
          <div class="empty-icon">📋</div>
          <div class="empty-text">暂无执行日志</div>
        </div>
        <div
          v-for="log in filteredLogs"
          :key="log.id"
          class="log-card"
          :class="{ active: log.status === 'active', completed: log.status === 'completed', archived: log.status === 'archived', selected: logBatchMode && selectedLogBatch.includes(log.id) }"
          @click="onLogCardClick(log)"
        >
          <div class="log-card-head">
            <span class="log-status-badge" :class="log.status">{{ logStatusLabel(log.status) }}</span>
            <span class="log-card-title">{{ log.title || '(无标题)' }}</span>
            <span class="log-card-date">{{ formatDate(log.created) }}</span>
          </div>
          <div class="log-card-body">{{ truncate(log.content, 120) }}</div>
          <div class="log-card-meta">
            <span v-if="log.project" class="log-project">{{ (projects.find(p => p.id === log.project)?.name) || log.project }}</span>
            <span v-if="log.taskId" class="log-task">📍 {{ log.taskId }}</span>
            <span v-if="log.agentName" class="log-agent">🤖 {{ log.agentName }}</span>
            <span v-if="log.sessionId" class="log-session" :title="log.sessionId">🔗 {{ log.sessionId.slice(0, 16) }}{{ log.sessionId.length > 16 ? '…' : '' }}</span>
            <span v-if="log.completed" class="log-completed">✓ {{ formatDate(log.completed) }}</span>
          </div>
          <div class="log-card-actions" @click.stop>
            <button class="ghost" title="复制成可直接粘给 agent 的提示词块" @click="copyLogAsPrompt(log.id)">📋 复制</button>
            <button v-if="log.status === 'active'" class="ghost" @click="completeLogItem(log.id)">完成</button>
            <button v-if="log.status !== 'archived'" class="ghost" @click="archiveLogItem(log.id)">归档</button>
            <button class="danger" @click="destroyLogItem(log.id)">销毁</button>
          </div>
        </div>
      </div>
    </main>

    <!-- Launchpad view -->
    <main id="board" class="launchpad" v-else-if="curView === 'launchpad'">
      <div class="lp-header">
        <h3>启动台</h3>
        <div class="lp-ctrls">
          <button @click="openAddApp">+ 添加应用</button>
          <button class="ghost" @click="openConfigPath">打开配置</button>
          <button class="ghost" @click="refreshApps">⟳ 刷新</button>
        </div>
      </div>
      <div class="lp-grid">
        <div
          v-for="app in launchpadApps"
          :key="app.id"
          class="lp-card"
          @click="openEditApp(app)"
        >
          <div class="lp-icon">{{ app.name.charAt(0) }}</div>
          <div class="lp-info">
            <div class="lp-name">{{ app.name }}</div>
            <div class="lp-desc">{{ app.description || app.path }}</div>
          </div>
          <button class="lp-launch" :title="'将启动：' + (app.cmd || app.path)" @click.stop="launchAppClick(app)">启动</button>
        </div>
      </div>
    </main>

    <!-- 任务卡右键菜单：卡上的高频操作不必再绕进详情面板 -->
    <div v-if="ctxMenu" class="ctx-backdrop" @click="closeCardMenu" @contextmenu.prevent="closeCardMenu"></div>
    <div v-if="ctxMenu" class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }">
      <div class="ctx-title">{{ ctxMenu.task.title || ctxMenu.task.id }}</div>
      <button @click="ctxRun(openCard)">🔍 查看详情</button>
      <button @click="ctxRun(openEdit)">✏️ 编辑</button>
      <button v-if="ctxMenu.task.status === '待验收'" @click="ctxRun(openReview)">✅ 验收裁决</button>
      <button @click="ctxRun(openCalAssignTask)">📅 指派时间</button>
      <button @click="ctxRun(copyTaskId)">📋 复制 ID</button>
      <button @click="ctxRun(copyTaskTitle)">🔤 复制标题</button>
      <div class="ctx-sep"></div>
      <button @click="ctxRun(archiveTask)">📦 归档</button>
      <button class="danger" @click="ctxRun(deleteTaskById)">🗑 删除</button>
    </div>

    <!-- Review modal -->
    <div id="review-overlay" class="overlay" v-if="reviewModal" @click.self="reviewModal = null">
      <div id="review-modal">
        <h3>✅ 验收裁决</h3>
        <div class="review-info">
          <div class="review-task-title">{{ reviewModal.title }}</div>
          <div class="review-task-id">{{ reviewModal.id }}</div>
        </div>
        <label>驳回理由（驳回时必填）</label>
        <textarea v-model="reviewReason" class="review-reason" placeholder="驳回时填写理由..."></textarea>
        <div class="acts">
          <button class="ghost" @click="reviewModal = null">取消</button>
          <button class="danger" @click="rejectTask">↩ 驳回</button>
          <button class="ok" @click="acceptTask">✅ 通过</button>
        </div>
      </div>
    </div>

    <!-- Task preview modal -->
    <div id="roverlay" class="overlay" v-if="previewTask" @click.self="previewTask = null">
      <div id="rmodal">
        <h3>
          {{ previewTask.title || previewTask.id }}
          <span class="st" :class="'st-' + statusClass(previewTask.status)">{{ previewTask.status }}</span>
        </h3>
        <div class="meta">
          <div><span class="k">ID</span><span class="v">{{ previewTask.id }}</span></div>
          <div><span class="k">项目</span><span class="v">{{ previewTask.project || '—' }}</span></div>
          <div><span class="k">优先级</span><span class="v">{{ priorityLabel(previewTask.priority) }}</span></div>
          <div v-if="previewTask.assignee"><span class="k">指派</span><span class="v">{{ previewTask.assignee }}</span></div>
          <div><span class="k">时间</span><span class="v">{{ previewTimeLabel(previewTask) }}</span></div>
          <div v-if="previewTask.batch"><span class="k">批次</span><span class="v">{{ previewTask.batch }}</span></div>
          <div v-if="previewTask.archived"><span class="k">来源</span><span class="v">📦 已归档</span></div>
          <div><span class="k">创建</span><span class="v">{{ formatDate(previewTask.created) }}</span></div>
          <div><span class="k">更新</span><span class="v">{{ formatDate(previewTask.updated) }}</span></div>
        </div>
        <div class="body" v-if="previewTask.body">
          <label>正文</label>
          <div class="body-text markdown" v-html="renderBody(previewTask.body)" @change="onBodyChange"></div>
        </div>
        <div class="logs-section" v-if="previewTask">
          <label>关联日志 ({{ taskLogs.length }})</label>
          <div class="task-logs-list">
            <div v-for="log in taskLogs" :key="log.id" class="task-log-item">
              <span class="log-status-badge" :class="log.status">{{ logStatusLabel(log.status) }}</span>
              <div class="task-log-main">
                <div class="task-log-title">{{ log.title || '(无标题)' }}</div>
                <div class="task-log-meta">{{ formatDate(log.created) }}</div>
              </div>
              <button
                v-if="log.status === 'active'"
                class="ghost task-log-done"
                title="一键标记完成（默认保留 7 天）"
                @click.stop="quickCompleteLog(log)"
              >✓ 完成</button>
            </div>
            <div v-if="!taskLogs.length" class="hint">该任务暂无关联日志</div>
          </div>
          <button class="add-note-btn" @click="openLogForTask(previewTask.id)">+ 写一条执行日志</button>
        </div>
        <div class="acts task-acts">
          <div class="acts-group">
            <span class="acts-label">流转</span>
            <button
              v-if="previewTask.status === '完成' || previewTask.status === '驳回'"
              class="ok"
              title="从归档/终态还原回「待办」"
              @click="restoreTask(previewTask)"
            >↩ 还原</button>
            <!-- 终态的「删除」不放这里：它与「操作」组里那个删除按钮重复（用户 2026-09-25 第 5 条）。
                 底部「操作」组的删除对任何状态都在，单一入口，不重复。 -->
            <template v-else>
              <!-- 验收裁决弹窗（accept / reject + 驳回理由）此前**没有任何入口** ——
                   后端 review:accept / review:reject 通道齐全，openReview 也写好了，
                   但没人调用它。这里补上正式入口：待验收任务可走完整裁决流程，
                   不想走流程的仍可用下面的「完成/驳回」直达。 -->
              <button
                v-if="previewTask.status === '待验收'"
                class="pri"
                title="正式验收裁决：通过 / 驳回（驳回必须填理由，会写进结果记录）"
                @click="openReview(previewTask)"
              >✅ 验收裁决</button>
              <button
                class="ok"
                title="直接标记完成（跳过验收，适用于挂死/废弃任务）"
                @click="forceCloseTask(previewTask, '完成')"
              >✓ 完成</button>
              <button
                class="danger"
                title="直接驳回（跳过验收，适用于挂死/废弃任务）"
                @click="forceCloseTask(previewTask, '驳回')"
              >✕ 驳回</button>
            </template>
            <button
              class="warning"
              title="移入归档视图（文件移到 task-data/archive/）。任何状态都可以归档"
              @click="archiveTask(previewTask)"
            >📦 归档</button>
          </div>
          <div class="acts-group">
            <span class="acts-label">操作</span>
            <button class="ok" title="编辑任务的全部字段" @click="openEdit(previewTask)">✏️ 编辑</button>
            <button class="ghost" title="指派开始/截止时间（时间段会显示在日历上）" @click="openCalAssignTask(previewTask)">📅 指派时间</button>
            <button class="ghost" title="复制任务 ID" @click="copyId(previewTask.id)">📋 ID</button>
            <button class="ghost" title="在文件管理器中定位这个任务的 markdown 文件" @click="openTaskFile(previewTask)">📄 文件</button>
            <button class="ghost" title="复制一份任务" @click="copyTaskClick(previewTask.id)">📑 副本</button>
            <button class="danger" title="删除任务（会进入 trash，可人工找回）" @click="deleteTask(previewTask.id)">🗑 删除</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Roadmap view -->
    <!-- Calendar view -->
    <main id="board" class="calendar-view" v-else-if="curView === 'calendar'">
      <div class="calhead">
        <button class="ghost" @click="calMove(-1)">&#9664; 上月</button>
        <span class="m">{{ calYear }} 年 {{ calMonth + 1 }} 月</span>
        <button class="ghost" @click="calMove(1)">下月 &#9654;</button>
        <button class="ghost" @click="calToday">回到本月</button>
        <label class="chk cal-chk"><input type="checkbox" :checked="calShowTodos" @change="calToggleTodos" /> 显示待办</label>
        <!-- 2026-09-23（用户第 3 条）：日志上日历 -->
        <label class="chk cal-chk"><input type="checkbox" :checked="calShowLogs" @change="calToggleLogs" /> 显示日志</label>
        <span class="cal-hint">拖动条目可改期；点条目可指派时间；时间段任务会横跨多天</span>
      </div>
      <div class="calgrid">
        <div v-for="d in CAL_DOW" :key="d" class="caldow">{{ d }}</div>
        <div v-for="(cell, i) in calCells" :key="i" class="calcell"
          :class="{ blank: !cell, today: cell && cell.isToday, past: cell && cell.isPast, dragover: cell && cell.day === calDragOverDay }"
          @dragover.prevent="cell && (calDragOverDay = cell.day)"
          @dragleave="calDragOverDay = null"
          @drop="onCalDrop($event, cell)"
        >
          <template v-if="cell">
            <div class="dnum">{{ cell.day }}</div>
            <div v-for="ev in cell.events" :key="ev.kind + ev.id + '-' + cell.day"
              class="cev" :class="['span-' + ev.span, ev.kind === 'todo' ? 'cev-todo' : ev.kind === 'log' ? 'cev-log' : 'cev-task']"
              draggable="true"
              :title="(ev.kind === 'todo' ? '待办：' : ev.kind === 'log' ? '日志：' : '任务：') + ev.title + (ev.rangeDays > 1 ? `（共 ${ev.rangeDays} 天）` : '')"
              @dragstart="onCalDragStart($event, ev.id, ev.kind)"
              @click="onCalEventClick(ev)"
            >
              <span class="pd" :style="{ background: ev.kind === 'todo' ? '#5b8dd6' : ev.kind === 'log' ? '#8b7fb8' : prioColor(ev.priority) }"></span>
              <span class="t">{{ ev.title }}</span>
            </div>
          </template>
        </div>
      </div>
      <div class="calunsched">
        <h4>
          未安排 · 无时间（{{ calUnscheduled.length }} 个）
          <span class="cal-hint-inline" v-if="calUnscheduled.length">拖动到日期格即改期，点击可直接指派时间</span>
        </h4>
        <div class="items">
          <span v-for="t in calUnscheduled" :key="t.id" class="cev chip" draggable="true"
            :title="'拖动或点击指派时间：' + (t.title || t.id)"
            @dragstart="onCalDragStart($event, t.id, 'task')"
            @click="openCalAssignTask(t)">
            <span class="pd" :style="{ background: prioColor(t.priority) }"></span>
            <span class="t">{{ t.title || t.id }}</span>
          </span>
          <span v-if="!calUnscheduled.length" class="cal-empty">本月任务都已安排时间</span>
        </div>
        <template v-if="calOtherMonths.length">
          <h4 class="cal-other-head">其它月份（{{ calOtherTotal }} 个）—— 点一下跳过去</h4>
          <div class="items">
            <span v-for="g in calOtherMonths" :key="g.key" class="cev chip other" @click="calGoto(g.year, g.month)">
              {{ g.label }} · {{ g.count }} 个 →
            </span>
          </div>
        </template>
      </div>
    </main>

    <main id="board" class="roadmap-view" v-else-if="curView === 'roadmap'">
      <div class="roadmap-header">
        <h3>路线图</h3>
        <div class="roadmap-ctrls">
          <button class="ghost" @click="loadRoadmap">⟳ 刷新</button>
        </div>
      </div>
      <div class="roadmap-content">
        <div v-if="!roadmapData.projects || !roadmapData.projects.length" class="empty-state">
          <div class="empty-icon">🗺️</div>
          <div class="empty-text">暂无路线图数据</div>
        </div>
        <div v-for="proj in (roadmapData.projects || [])" :key="proj.id" class="roadmap-project">
          <div class="rp-header">
            <span class="rp-name">{{ proj.name }}</span>
            <span class="rp-health st" :class="'st-' + proj.health">{{ roadmapHealthLabel(proj.health) }}</span>
          </div>
          <div class="rp-batches">
            <div v-for="batch in proj.batches" :key="batch.name" class="rp-batch" :class="'rb-' + batch.status">
              <div class="rb-header">
                <span class="rb-name">{{ batch.name }}</span>
                <span class="rb-count">{{ batch.done }}/{{ batch.total }}</span>
              </div>
              <div class="rb-tasks">
                <div v-for="t in batch.tasks" :key="t.id" class="rb-task">
                  <span class="st small" :class="'st-' + statusClass(t.status)">{{ t.status }}</span>
                  <span class="rb-title">{{ t.title }}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="rp-next" v-if="proj.nextActions && proj.nextActions.length">
            <label>下一步</label>
            <div class="rp-actions">
              <div v-for="a in proj.nextActions" :key="a.taskId" class="rp-action">
                <span class="st small" :class="a.priority === '高' ? 'st-review' : 'st-todo'">{{ a.priority }}</span>
                {{ a.title }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- Edit modal -->
    <div id="modal-overlay" class="overlay" v-if="editTask_" @click.self="closeTaskEditor()">
      <div id="modal" class="task-modal">
        <h3>{{ editTask_.id ? '编辑任务' : '新建任务' }}</h3>
        <div class="tf-grid">
          <div
            v-for="spec in taskFieldSpecs"
            :key="spec.key"
            class="tf-field"
            :class="spec.span === 'full' ? 'tf-full' : 'tf-half'"
          >
            <label>{{ spec.label }}</label>

            <!-- 阻塞：不让用户手填任务 ID（现实里没人会去看 ID，更不会记得），
                 改成跟随所选项目、点选即可的挑选器。 -->
            <template v-if="spec.key === 'blockers'">
              <div class="blk-picked">
                <span v-for="id in blockerList" :key="id" class="blk-chip">
                  {{ taskTitleById(id) }}
                  <button class="blk-x" title="移除" @click="removeBlocker(id)">×</button>
                </span>
                <span v-if="!blockerList.length" class="blk-empty">未设置依赖</span>
              </div>
              <select class="blk-pick" :value="''" @change="onBlockerPick">
                <option value="">+ 从当前项目的任务里挑选…</option>
                <option v-for="t in blockerCandidates" :key="t.id" :value="t.id">
                  {{ t.title || '(无标题)' }} —— {{ t.id }}
                </option>
              </select>
            </template>

            <select v-else-if="spec.type === 'select'" v-model="editTask_[spec.key]">
              <option v-for="o in specOptions(spec)" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>

            <textarea
              v-else-if="spec.type === 'textarea'"
              v-model="editTask_[spec.key]"
              :class="{ tall: spec.key === 'body' }"
              :placeholder="spec.placeholder || ''"
            ></textarea>

            <input v-else v-model="editTask_[spec.key]" :placeholder="spec.placeholder || ''" />

            <div v-if="spec.hint" class="tf-hint">{{ spec.hint }}</div>
          </div>
        </div>
        <div class="acts">
          <button class="ghost" @click="closeTaskEditor()">取消</button>
          <button class="pri" @click="saveEdit">保存</button>
        </div>
      </div>
    </div>

    <!-- Log edit modal -->
    <!-- Policy edit modal -->
    <div id="policy-overlay" class="overlay" v-if="policyEdit_" @click.self="closePolicyEditor()">
      <div id="policy-modal">
        <h3>项目方针：{{ policyEdit_.name }}</h3>
        <label>使命（一句话：这项目是干嘛的）</label>
        <textarea v-model="policyEdit_.mission" placeholder="例：本地优先的多 agent 任务调度台"></textarea>
        <label>当前目标（本阶段要达成什么 + 完成判据）</label>
        <textarea v-model="policyEdit_.goal" placeholder="例：稳定可用、承接真实业务数据"></textarea>
        <label>应用场景（给谁用、在哪用）</label>
        <textarea v-model="policyEdit_.scenario" placeholder="例：暮雨个人，桌面日常使用"></textarea>
        <label>方针边界（怎么干、不干什么）</label>
        <textarea v-model="policyEdit_.boundary" placeholder="例：元层铁律——永不内置模型能力；Agent 层归外部专家团"></textarea>
        <div class="acts">
          <button class="ghost" @click="closePolicyEditor()">取消</button>
          <button class="pri" @click="savePolicyEdit">保存方针卡</button>
        </div>
      </div>
    </div>

    <div id="log-edit-overlay" class="overlay" v-if="logEdit_" @click.self="closeLogEditor()">
      <div id="log-edit-modal">
        <h3>{{ logCompleting ? '完成日志' : logArchiveMode ? '归档日志' : logEdit_.id ? '编辑日志' : '新建日志' }}</h3>
        <label>标题</label>
        <input v-model="logEdit_.title" placeholder="日志标题" />
        <label>项目</label>
        <select v-model="logEdit_.project" class="logsel">
          <option value="">（不归属）</option>
          <!-- 存量日志里可能有没登记在 registry 的项目 id（旧默认值 fangcun-base 等）。
               没有这一项时，select 会显示成第一个选项，用户以为项目是"方寸"却改不动。 -->
          <option v-if="logEdit_.project && !projects.some(p => p.id === logEdit_.project)"
            :value="logEdit_.project">{{ logEdit_.project }}（未在登记表中）</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
        </select>
        <label>执行内容</label>
        <textarea v-model="logEdit_.content" class="tall" placeholder="执行内容..."></textarea>
        <label>下一步</label>
        <textarea v-model="logEdit_.nextSteps" placeholder="下一步..."></textarea>
        <!-- 关联任务：2026-09-22（用户第 2 条）此前是两个裸输入框，等着用户手填
             id —— 实际等于逼人背 ID。改为「按项目过滤的下拉选择」，第一项为不关联；
             保留下面的手填框，用于跨项目/已归档/列表外的 ID。 -->
        <label>关联任务 ID（可选）</label>
        <select v-model="logEdit_.taskId" class="logsel" :disabled="!logTaskOptions.length">
          <option value="">{{ logTaskOptions.length ? '（不关联）' : '（当前项目下没有可选任务）' }}</option>
          <option v-for="t in logTaskOptions" :key="t.id" :value="t.id">
            {{ t.id }} · {{ t.title || '(无标题)' }} · {{ t.status }}
          </option>
        </select>
        <input v-model="logEdit_.taskId" placeholder="或直接粘贴任务 ID" />
        <div class="hint log-task-picked" v-if="logTaskPicked">已选：{{ logTaskPicked }}</div>
        <!-- 2026-09-23（用户第 1 条）：会话 ID + Agent + 日期 -->
        <label>会话 ID（可选，便于反向查证）</label>
        <input v-model="logEdit_.sessionId" placeholder="如 20260922_183047_334e4a" />
        <label>执行 Agent（可选）</label>
        <select v-model="logEdit_.agentName" class="logsel">
          <option value="">（不指定）</option>
          <option v-for="a in agentPresets" :key="a" :value="a">{{ a }}</option>
        </select>
        <input v-model="logEdit_.agentName" placeholder="或手动输入 Agent 名称" />
        <label>日志日期（默认创建日期）</label>
        <input v-model="logEdit_.logDate" type="date" />
        <template v-if="logCompleting || logArchiveMode">
          <label v-if="logCompleting">保留天数（0=永不）</label>
          <input v-if="logCompleting" v-model="logRetainDays" placeholder="7" />
          <div class="hint" v-if="logCompleting">到期后，点日志页的「清理超期」会把它标为「已归档」（只改状态，不删文件）。</div>
          <label>备注（可选）</label>
          <textarea v-model="logNote" placeholder="备注..."></textarea>
        </template>
        <div class="acts">
          <button class="ghost" @click="closeLogEditor(); logCompleting = false; logArchiveMode = false">取消</button>
          <button v-if="logEdit_.id" class="ghost" title="复制成可直接粘给 agent 的提示词块" @click="copyLogAsPrompt(logEdit_.id)">📋 复制为提示词</button>
          <button v-if="logEdit_.id && !logCompleting && !logArchiveMode" class="danger" @click="destroyLogItem(logEdit_.id); logEdit_ = null">销毁</button>
          <button class="pri" @click="saveLogEdit">{{ logCompleting ? '确认完成' : logArchiveMode ? '确认归档' : logEdit_.id ? '保存' : '创建' }}</button>
        </div>
      </div>
    </div>

    <!-- 指派时间（2026-09-22，用户第 6 条）：任务可设开始+截止时间段，待办只有到期日 -->
    <div v-if="calAssign_" class="overlay" @click.self="calAssign_ = null">
      <div id="cal-assign-modal">
        <h3>📅 指派时间</h3>
        <div class="ca-title">{{ calAssign_.title }}</div>
        <div class="hint" v-if="calAssign_.isTodo">待办只有「到期日」一个时间点。</div>
        <template v-if="!calAssign_.isTodo">
          <label>开始（可选；与截止组成时间段，日历上会横跨多天）</label>
          <input v-model="calAssign_.start" type="date" />
        </template>
        <label>{{ calAssign_.isTodo ? '到期日' : '截止' }}</label>
        <input v-model="calAssign_.end" type="date" />
        <div class="ca-quick">
          <button class="ghost" @click="calQuickSet(0)">今天</button>
          <button class="ghost" @click="calQuickSet(1)">明天</button>
          <button class="ghost" @click="calQuickSet(7)">一周后</button>
          <button class="ghost" @click="calClearDates">清除时间</button>
        </div>
        <div class="acts">
          <button class="ghost" @click="calAssign_ = null">取消</button>
          <button class="pri" @click="saveCalAssign">保存</button>
        </div>
      </div>
    </div>

    <!-- App edit modal (Launchpad) -->
    <!-- Data directory migrate modal -->
    <div v-if="migrateTarget" class="overlay" @click.self="migrateTarget = null">
      <div id="migrate-modal">
        <h3>切换数据目录</h3>
        <div class="mg-row"><span class="k">当前</span><span class="v">{{ dataDir }}</span></div>
        <div class="mg-row"><span class="k">目标</span><span class="v">{{ migrateTarget.dir }}</span></div>
        <div class="mg-row">
          <span class="k">目标现状</span>
          <span class="v" :class="{ warn: !migrateTarget.empty }">
            <template v-if="migrateTarget.empty">空目录，可安全迁入</template>
            <template v-else>
              已有 {{ migrateTarget.taskCount }} 个任务文件<template v-if="migrateTarget.archivedCount">（含 {{ migrateTarget.archivedCount }} 个归档）</template>
            </template>
          </span>
        </div>

        <div class="mg-notice">
          <b>将按顺序执行</b>
          <ul>
            <li>先把当前数据<b>完整备份</b>一份；备份失败则中止，不会动手</li>
            <li>把 <code>task-data/</code> · <code>registry.yaml</code> · <code>docs/</code> <b>复制</b>到目标目录</li>
            <li>切换方寸的数据指向并重新加载</li>
            <li>原目录<b>保留不删</b>，确认无误后你可自行清理</li>
          </ul>
          <div class="mg-hint">回收站（<code>.trash</code>）与本地备份（<code>backups/</code>）不随迁。</div>
          <div class="mg-hint" v-if="!migrateTarget.empty">
            目标目录已有数据，迁入后同名文件将被覆盖（源目录仍完整保留）。
          </div>
        </div>

        <div class="acts">
          <button class="ghost" @click="migrateTarget = null">取消</button>
          <button class="pri" :disabled="migrateBusy" @click="confirmMigrate">
            {{ migrateBusy ? '迁移中…' : (migrateTarget.empty ? '开始迁移' : '覆盖式迁入') }}
          </button>
        </div>
      </div>
    </div>

    <!-- New project modal -->
    <div v-if="projForm" class="overlay" @click.self="closeProjForm()">
      <div id="proj-new-modal">
        <h3>新建项目</h3>
        <label>项目 ID <span class="req">*</span></label>
        <input v-model="projForm.id" placeholder="英文标识，如 novel-forge" />
        <label>显示名称</label>
        <input v-model="projForm.name" placeholder="留空则与 ID 相同" />
        <label>仓库路径</label>
        <input v-model="projForm.repo" placeholder="E:/CODE/CangKu/xxx（供 Hermes 派活定位）" />
        <label>说明</label>
        <input v-model="projForm.description" placeholder="一句话说明（可选）" />
        <div class="hint">
          项目登记进 <code>registry.yaml</code>。写入前会自校验（内容可解析 · 项目数 +1 · 新 ID 可见），
          任一不满足即放弃写入；文件原有注释与字段原样保留。
        </div>
        <div class="acts">
          <button class="ghost" @click="closeProjForm()">取消</button>
          <button class="pri" :disabled="projCreating" @click="confirmNewProject">{{ projCreating ? '写入中…' : '登记项目' }}</button>
        </div>
      </div>
    </div>

    <div id="app-edit-overlay" class="overlay" v-if="editApp_" @click.self="closeAppEditor()">
      <div id="app-edit-modal">
        <h3>{{ editApp_.isNew ? '添加应用' : '编辑应用' }}</h3>
        <label>名称</label>
        <input v-model="editApp_.name" placeholder="应用名称" />
        <label>路径（exe / bat / cmd / ps1 / lnk / 文件夹都行）</label>
        <div style="display:flex;gap:6px;align-items:center;">
          <input v-model="editApp_.path" placeholder="E:/path/to/app.exe" style="flex:1" />
          <button type="button" class="ghost" @click="browseAppPath">浏览…</button>
        </div>
        <label>启动参数（可选，空格分隔）</label>
        <input v-model="editApp_.argsText" placeholder="例：--port 8080" />
        <label>描述（可选）</label>
        <input v-model="editApp_.description" placeholder="应用描述" />
        <div class="hint app-path-hint">选中文件夹或 .lnk 时直接用系统「打开」；.bat/.cmd 经 cmd.exe 执行，.ps1 用 powershell 执行。</div>
        <div class="acts">
          <button class="ghost" @click="closeAppEditor()">取消</button>
          <button v-if="!editApp_.isNew" class="danger" @click="removeApp(editApp_.id)">删除</button>
          <button class="pri" @click="saveEditApp">{{ editApp_.isNew ? '添加' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- ═══════════ Notification Center（通知中心，原型规格移植） ═══════════ -->
    <div v-if="ncOpen" class="nc-wrap" @mousedown.self="closePanel">
      <div class="nc-panel">
        <header class="nc-head">
          <div class="nc-head-title">
            <h1>通知中心 <span v-if="ncUnread > 0" class="nc-count">{{ ncUnread }}</span></h1>
            <p>{{ ncHeadSub }}</p>
          </div>
          <div class="nc-head-act">
            <button class="nc-icon-btn" :class="{ spin: ncLoading }" title="刷新" @click="ncRefresh">
              <span class="nc-ico">⟳</span>
            </button>
            <button class="nc-btn-primary" :disabled="ncUnread === 0" @click="ncMarkAllRead">✓ 全部标为已读</button>
            <button class="nc-icon-btn" title="关闭" @click="closePanel">✕</button>
          </div>
        </header>

        <div class="nc-filters">
          <div class="nc-seg">
            <button :class="{ on: ncFilter === 'all' }" @click="ncSetFilter('all')">全部<span class="n">{{ ncCounts.all }}</span></button>
            <button :class="{ on: ncFilter === 'unread' }" @click="ncSetFilter('unread')">未读<span class="n">{{ ncCounts.unread }}</span></button>
            <button :class="{ on: ncFilter === 'read' }" @click="ncSetFilter('read')">已读<span class="n">{{ ncCounts.read }}</span></button>
          </div>
        </div>

        <div class="nc-list">
          <div v-for="n in ncVisible" :key="n.id" class="nc-item" :class="n.read ? 'read' : 'unread'" @click="ncClickItem(n)">
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
            <div class="nc-acts">
              <button class="nc-act keep" :title="n.read ? '标为已读' : '标为已读'" @click.stop="ncToggleRead(n)">✓</button>
              <button class="nc-act danger" title="删除通知" @click.stop="ncDelete(n)">🗑</button>
            </div>
          </div>
          <div v-if="ncVisible.length === 0" class="nc-empty">
            <div class="nc-empty-ic">🔔</div>
            <h3>{{ ncFilter === 'unread' ? '没有未读通知' : '暂无通知' }}</h3>
            <p>这里会显示待办到期、任务逾期、解析失败与备份失败等事件</p>
          </div>
        </div>

        <footer class="nc-foot">
          <div class="stat">共 <b>{{ ncCounts.all }}</b> 条 · 未读 <b>{{ ncCounts.unread }}</b> 条</div>
          <button class="nc-link" @click="ncClearAll">清空历史 →</button>
        </footer>
      </div>
    </div>

    <!-- Settings modal -->
    <div id="soverlay" class="overlay" v-if="showSettings_" @click.self="showSettings_ = false">
      <div id="smodal">
        <h3>设置</h3>
        <div class="sect">
          <h4>版本与更新</h4>
          <div class="ver-row">
            <span class="ver-num">v{{ appVersion }}</span>
            <span v-if="updateState.checked" class="hint">{{ updateState.msg }}</span>
          </div>
          <div class="sect-btns">
            <button class="ghost" :disabled="updateState.busy" @click="checkUpdate">
              {{ updateState.busy ? '检查中…' : '检查更新' }}
            </button>
            <button v-if="updateState.available" class="pri" :disabled="updateState.busy" @click="downloadUpdate">
              下载 v{{ updateState.version }}
            </button>
            <button v-if="updateState.downloaded" class="pri" @click="installUpdate">
              退出并安装
            </button>
          </div>
          <div class="hint">更新包托管在 GitHub Releases，检查与下载需联网。</div>
        </div>
        <div class="sect">
          <h4>数据目录</h4>
          <div class="hint">{{ dataDir }}</div>
          <div class="sect-btns">
            <button class="ghost" @click="changeDataDir">修改目录…</button>
            <button class="ghost" @click="openDataDir">打开目录</button>
          </div>
        </div>
        <div class="sect">
          <h4>诊断日志</h4>
          <div class="hint logpath">{{ appLogFile || '（未取到日志路径）' }}</div>
          <div class="sect-btns">
            <button class="ghost" @click="openAppLogDir">打开日志目录</button>
            <button class="ghost" @click="copyAppLogPath">复制路径</button>
            <button class="ghost" @click="showAppLogFromSettings">查看最近 200 行</button>
          </div>
          <div class="hint">崩溃、IPC 失败、渲染层异常、启动失败都会写进这个文件。报问题时把最后几十行发我即可。</div>
        </div>
        <!-- 2026-09-23：Agent 预设列表可编辑（用户要求：自定义功能多一点） -->
        <div class="sect">
          <h4>🤖 Agent 预设列表</h4>
          <div class="hint">日志视图的「执行 Agent」筛选下拉会读这里的预设。增删后自动保存到浏览器本地。</div>
          <div class="agent-presets-list">
            <span v-for="(a, i) in agentPresets" :key="a" class="agent-preset-chip">
              {{ a }}
              <button class="agent-preset-del" title="删除此预设" @click="removeAgentPreset(i)">×</button>
            </span>
            <span v-if="!agentPresets.length" class="hint">暂无预设，添加一个吧</span>
          </div>
          <div class="agent-presets-add">
            <input v-model="newAgentName" placeholder="新 Agent 名称（如 opencode）" @keydown.enter="addAgentPreset" />
            <button class="ghost" @click="addAgentPreset">添加</button>
          </div>
        </div>
        <div class="sect">
          <h4>项目列表</h4>
          <div class="projlist">
            <div class="proj-row" v-for="p in projects" :key="p.id" :title="p.repo || ''" @click="openProjectInSettings(p)">
              <span class="proj-row-name">{{ p.name || p.id }}</span>
              <small class="proj-row-id">{{ p.id }}</small>
              <span class="proj-row-desc">{{ p['状态'] || '' }}<template v-if="p['路线图']"> · {{ p['路线图'] }}</template></span>
            </div>
          </div>
        </div>
        <div class="sect backup-sect">
          <h4>🛡️ 备份与恢复</h4>

          <div class="bk-status" :class="bkDotClass">
            <span class="bk-dot"></span>
            <span class="bk-status-text">{{ bkStatusText }}</span>
            <span v-if="bkStatus.nextRunAt" class="bk-next">下次 {{ bkFmt(bkStatus.nextRunAt) }}</span>
          </div>
          <div v-if="bkState.lastError" class="bk-err-line">上次失败（{{ bkState.failStreak }} 次连续）：{{ bkState.lastError }}</div>

          <div class="bk-grid">
            <label>WebDAV 地址</label>
            <input v-model="bkForm.url" placeholder="https://dav.jianguoyun.com/dav/fangcun" />
            <label>账号</label>
            <input v-model="bkForm.username" placeholder="邮箱 / 用户名" />
            <label>密码</label>
            <input
              v-model="bkForm.password"
              type="password"
              :placeholder="bkForm.hasPassword ? '已加密保存（留空=不修改）' : '应用密码（坚果云需用应用密码）'"
            />
            <label>自动备份</label>
            <div class="bk-inline">
              <input id="bk-enabled" type="checkbox" v-model="bkForm.enabled" />
              <label for="bk-enabled" class="bk-cb">启用 · 每</label>
              <input type="number" v-model.number="bkForm.intervalHours" min="0" max="168" class="bk-num" />
              <span>小时 · 启动后</span>
              <input type="number" v-model.number="bkForm.firstDelayMinutes" min="0" max="1440" class="bk-num" />
              <span>分钟首次</span>
            </div>
            <label>保留份数</label>
            <div class="bk-inline">
              <span>本地</span>
              <input type="number" v-model.number="bkForm.localKeep" min="1" max="200" class="bk-num" />
              <span>远端</span>
              <input type="number" v-model.number="bkForm.remoteKeep" min="0" max="200" class="bk-num" />
              <label class="bk-cb"><input type="checkbox" v-model="bkForm.allowSelfSigned" /> 允许自签证书（NAS）</label>
            </div>
            <label>存放目录</label>
            <div class="bk-inline">
              <input v-model="bkForm.localDir" class="bk-path" placeholder="留空 = 数据目录下的 backups/" />
              <button class="ghost bk-mini" @click="bkPickDir">浏览…</button>
              <button class="ghost bk-mini" @click="bkOpenDir">打开</button>
            </div>
          </div>

          <div class="sect-btns">
            <button class="pri" :disabled="bkBusy" @click="bkSaveAndRun">{{ bkBusy ? '备份中…' : '立即备份' }}</button>
            <button class="ghost" :disabled="bkBusy" @click="bkRunLocalOnly">仅本地</button>
            <button class="ghost" :disabled="bkTesting" @click="bkTestRemote">{{ bkTesting ? '测试中…' : '测试远端' }}</button>
            <button class="ghost" @click="bkSaveConfig">保存配置</button>
            <button class="ghost" @click="bkOpenDir">打开备份文件夹</button>
            <!-- 刚做完一次备份后，直接定位到那个文件所在目录（原 openBackupFolder 一直没入口） -->
            <button v-if="backupInfo" class="ghost" :title="'最近一次备份：' + backupInfo.path + '（' + backupInfo.sizeKB + ' KB）'"
              @click="openBackupFolder">最近备份所在目录</button>
          </div>

          <div class="sect-btns bk-manual">
            <span class="bk-manual-label">手动流转（不依赖网盘账号）</span>
            <button class="ghost" :disabled="bkBusy" @click="bkExportTo">📤 导出到…</button>
            <button class="ghost" :disabled="bkBusy" @click="bkVerifyPackage">🔍 校验备份包…</button>
            <button class="ghost" :disabled="bkBusy" @click="bkRestoreFromFile">📥 从文件恢复…</button>
          </div>
          <div v-if="bkMsg" :class="'llm-config-msg ' + bkMsgType">{{ bkMsg }}</div>
          <div v-if="bkForm.url && !bkForm.hasPassword" class="hint">
            提示：密码只有保存后才会加密留存，重启应用后仍可自动备份。
          </div>

          <div class="bk-history">
            <div class="bk-tabs">
              <span :class="{ on: bkTab === 'local' }" @click="bkSwitchTab('local')">本地 ({{ bkLocal.length }})</span>
              <span :class="{ on: bkTab === 'remote' }" @click="bkSwitchTab('remote')">远端 ({{ bkRemote.length }})</span>
            </div>
            <div class="bk-list">
              <div v-for="b in bkCurrentList" :key="b.name" class="bk-item">
                <div class="bk-item-main">
                  <span class="bk-item-name">{{ b.name }}</span>
                  <span class="bk-item-meta">
                    {{ b.bytes != null ? (b.bytes / 1024).toFixed(0) + ' KB' : '—' }} · {{ bkFmt(b.mtime) }}
                  </span>
                </div>
                <button class="ghost bk-restore" :disabled="bkBusy" @click="bkRestore(b)">恢复</button>
              </div>
              <div v-if="!bkCurrentList.length" class="hint">暂无备份{{ bkTab === 'remote' ? '（需先配置并测试 WebDAV）' : '' }}</div>
            </div>
          </div>

          <div v-if="bkVerifyResult" class="bk-verify" :class="bkVerifyResult.ok ? 'ok' : 'bad'">
            <div class="bk-verify-head">
              {{ bkVerifyResult.ok ? '✅ 备份包完整可用' : '❌ 备份包校验未通过' }}
              <span class="bk-verify-path">{{ bkVerifyResult.name }}</span>
            </div>
            <div v-if="bkVerifyResult.manifest" class="bk-verify-meta">
              备份时间 {{ bkFmt(bkVerifyResult.manifest.createdAt) }} ·
              {{ bkVerifyResult.manifest.totalFiles }} 个文件 ·
              {{ (bkVerifyResult.manifest.totalBytes / 1024).toFixed(1) }} KB
            </div>
            <ul v-if="bkVerifyResult.errors && bkVerifyResult.errors.length" class="bk-verify-errs">
              <li v-for="(e, i) in bkVerifyResult.errors.slice(0, 8)" :key="i">{{ e }}</li>
            </ul>
            <button class="ghost bk-mini" @click="bkVerifyResult = null">关闭</button>
          </div>

          <div class="hint">
            备份范围：task-data/ + registry.yaml + docs/。密钥文件（llm-config.json、backup-config.json 等）永不入包，
            每次备份的 manifest 里会记录被排除项。恢复前必做 sha256 + 结构双重校验，校验不过不动现有数据。
          </div>

          <div class="bk-notice">
            <b>数据安全须知</b>
            <ul>
              <li>备份包内含任务数据<strong>完整明文内容</strong>，未加密。请勿放入公开可访问的目录或公开分享链接。</li>
              <li>API Key 等密钥<strong>永不进入备份包</strong>；从备份恢复后，LLM 与 WebDAV 配置需要重新填写。</li>
              <li>恢复会覆盖当前数据。应用会自动为现有数据打快照并在失败时回滚，但请勿在恢复过程中断电或强制退出。</li>
              <li>云端副本由你所用的网盘客户端负责同步，方寸无法校验远端是否完整。建议定期用「校验备份包」抽查下载回来的副本。</li>
              <li>备份只覆盖数据，<strong>不含代码与 git 历史</strong>。手写的备份包请自行保留校验文件（<code>.sha256</code>），
                  它是判断文件是否损坏的唯一依据。</li>
              <li>备份目录若指向网盘同步文件夹，轮换会同步删除云端旧包，这是预期行为。</li>
            </ul>
          </div>

          <button class="ghost bk-log-toggle" @click="bkToggleLog">📋 {{ bkShowLog ? '收起日志' : '查看备份日志' }}</button>
          <pre v-if="bkShowLog" class="bk-log">{{ bkLogLines.length ? bkLogLines.join('\n') : '(暂无日志)' }}</pre>

          <div class="sect">
            <label>项目方针</label>
            <div class="hint" style="margin-bottom:8px">每项目一张方针卡（使命/目标/场景/边界）。派活或开新会话时复制给 agent，替代口头交代。</div>
            <div class="policy-list">
              <div v-for="p in projects" :key="'pol-' + p.id" class="policy-row" @click="openPolicyEdit(p.id)">
                <span class="policy-name">{{ p.name || p.id }}</span>
                <span class="policy-state" :class="{ has: policyMap[p.id] }">{{ policyMap[p.id] ? '已立' : '未立' }}</span>
                <button v-if="policyMap[p.id]" class="ghost" title="复制方针文本（粘给 agent）" @click.stop="copyPolicyText(p.id)">复制</button>
              </div>
            </div>
          </div>

          <div class="sect-btns" style="margin-top: 12px">
            <button class="ghost" @click="exportTasksToFile">导出任务 JSON</button>
            <button class="ghost" @click="importTasksFromFile">导入任务 JSON</button>
            <button class="ghost" @click="showSettings_ = false">关闭</button>
          </div>
        </div>
      </div>
    </div>



    <div id="toast" :class="[toast.type, { show: toast.show }]">{{ toast.msg }}</div>

    <!-- Drag status picker -->
    <div class="drag-status-picker" v-if="draggingId" :style="pickerStyle">
      <div class="sp-title">拖到目标状态</div>
      <div
        v-for="s in STATUSES"
        :key="s"
        class="sp-bucket"
        :class="{ dragover: dragoverCol === s }"
        @dragover.prevent="dragoverCol = s"
        @drop="onDrop($event, s)"
      >
        <span class="sp-dot" :style="{ background: statusColor(s) }"></span>
        {{ s }}
      </div>
    </div>

    <!-- First-run wizard -->
    <div v-if="showWizard" class="overlay wizard-overlay">
      <div class="wizard">
        <div class="wizard-header">
          <h2>{{ wizardSteps[wizardStep].title }}</h2>
          <p class="wizard-step-indicator">步骤 {{ wizardStep + 1 }} / {{ wizardSteps.length }}</p>
        </div>
        <div class="wizard-body">
          <div v-if="wizardStep === 0">
            <p class="wizard-desc">欢迎使用方寸！请先选择数据目录。</p>
            <div class="wizard-field">
              <label>数据目录</label>
              <div class="wizard-input-row">
                <input v-model="wizardDataDir" placeholder="选择数据目录路径" />
                <button class="ghost" @click="browseWizardDir">浏览…</button>
              </div>
              <small class="wizard-hint">方寸将在此目录下创建 task-data/ 和 registry.yaml</small>
            </div>
          </div>
          <div v-if="wizardStep === 1">
            <p class="wizard-desc">选择初始化方式：</p>
            <div class="wizard-options">
              <label class="wizard-option" :class="{ selected: wizardInitMode === 'fresh' }">
                <input type="radio" v-model="wizardInitMode" value="fresh" />
                <div>
                  <strong>新建空白看板</strong>
                  <small>从零开始，创建全新的任务看板</small>
                </div>
              </label>
              <label class="wizard-option" :class="{ selected: wizardInitMode === 'import' }">
                <input type="radio" v-model="wizardInitMode" value="import" />
                <div>
                  <strong>从 Python tegula 导入</strong>
                  <small>复制现有任务数据和项目注册表</small>
                </div>
              </label>
            </div>
            <div v-if="wizardInitMode === 'import'" class="wizard-field">
              <label>Python tegula 目录</label>
              <div class="wizard-input-row">
                <input v-model="wizardPythonDir" placeholder="E:\CODE\CangKu\fangcun" />
                <button class="ghost" @click="browsePythonDir">浏览…</button>
              </div>
            </div>
          </div>
          <div v-if="wizardStep === 2">
            <p class="wizard-desc">确认配置：</p>
            <div class="wizard-summary">
              <div class="wizard-summary-row"><span>数据目录</span><code>{{ wizardDataDir }}</code></div>
              <div class="wizard-summary-row"><span>初始化方式</span><span>{{ wizardInitMode === 'fresh' ? '新建空白看板' : '从 Python tegula 导入' }}</span></div>
              <div v-if="wizardInitMode === 'import'" class="wizard-summary-row"><span>Python tegula 目录</span><code>{{ wizardPythonDir }}</code></div>
            </div>
          </div>
        </div>
        <div class="wizard-footer">
          <button v-if="wizardStep > 0" class="ghost" @click="wizardStep--">上一步</button>
          <div class="wizard-footer-right">
            <button v-if="wizardStep < wizardSteps.length - 1" class="pri" @click="wizardNext" :disabled="!wizardCanNext">下一步</button>
            <button v-else class="pri" @click="wizardFinish" :disabled="wizardFinishing">{{ wizardFinishing ? '初始化中…' : '完成' }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, reactive, watch } from 'vue'
import { marked } from 'marked'
import {
  parseCalDate, calISO, dayStart, addDays, buildMonth, rangeLabel, shiftRange,
  type CalEvent as CalEventT,
} from './calendar'
import {
  classifyLogImport, classifySummary,
  type ImportItem,
} from './logdedupe'
import DOMPurify from 'dompurify'

const STATUSES = ['草稿', '待审批', '待办', '进行中', '待验收', '完成', '驳回'] as const
type Status = typeof STATUSES[number]

// ── 任务表单元数据 ───────────────────────────────────────────────────
// 字段清单与枚举的唯一来源在主进程（data/index.ts 的 TASK_FIELD_SPECS）。
// 这里保留一份内置兜底，仅用于 IPC 未就绪的极端情况，正常启动会被覆盖。
const PRIORITIES = ['高', '中', '低'] as const
const taskFieldSpecs = ref<any[]>([])
const taskStatuses = ref<string[]>([...STATUSES])
const taskPriorities = ref<string[]>([...PRIORITIES])

async function loadTaskMeta() {
  try {
    const specs: any = await window.tegula.taskFieldSpecs()
    if (Array.isArray(specs) && specs.length) taskFieldSpecs.value = specs
    const enums: any = await window.tegula.taskEnums()
    if (Array.isArray(enums?.statuses) && enums.statuses.length) taskStatuses.value = enums.statuses
    if (Array.isArray(enums?.priorities) && enums.priorities.length) taskPriorities.value = enums.priorities
  } catch {
    // 拉取失败：走下面的最小兜底
  }
  if (!taskFieldSpecs.value.length) {
    taskFieldSpecs.value = [
      { key: 'title', label: '标题', type: 'text', span: 'full' },
      { key: 'project', label: '项目', type: 'select', span: 'half', optionsFrom: 'projects' },
      { key: 'status', label: '状态', type: 'select', span: 'half', options: taskStatuses.value },
      { key: 'priority', label: '优先级', type: 'select', span: 'half', options: taskPriorities.value },
      { key: 'tags', label: '标签', type: 'tags', span: 'full' },
      { key: 'body', label: '正文', type: 'textarea', span: 'full' },
    ]
  }
}

interface Task {
  id: string
  title?: string
  status?: string
  project?: string
  priority?: string
  tags?: string[]
  body?: string
  created?: string
  updated?: string
  blockers?: string[]
  batch?: string
  _archived?: boolean
}

interface Project {
  id: string
  name?: string
  repo?: string
  ['状态']?: string
  ['路线图']?: string
}

// ── State ───────────────────────────────────────────────────────────────

const tasks = ref<Task[]>([])
const projects = ref<Project[]>([])
const blockers = ref<any[]>([])
const curView = ref('active')
const curProj = ref('__all__')
const groupMode = ref('status')
const sortMode = ref('active')
const showArchiveHint = ref(!localStorage.getItem('fc_archive_hint_seen'))
function closeArchiveHint() {
  showArchiveHint.value = false
  localStorage.setItem('fc_archive_hint_seen', '1')
}
const searchQuery = ref('')
// 解析失败的任务文件（主进程收集）。以前 parseTask 失败是静默跳过 ——
// 2026-09-18 真实发生过 6 个任务因标题含 ": " 而在看板上隐身数月。
const parseErrors = ref<string[]>([])
const searchIncludeArchive = ref(true)
const dueFilter = ref('')
const isNaturalQuery = ref(false)
const naturalResults = ref<Task[]>([])
const backupInfo = ref<{ path: string; sizeKB: number } | null>(null)

// First-run wizard state
const showWizard = ref(false)
const wizardStep = ref(0)
const wizardInitMode = ref<'fresh' | 'import'>('fresh')
const wizardDataDir = ref('')
const wizardPythonDir = ref('')
const wizardFinishing = ref(false)
const wizardSteps = [
  { title: '选择数据目录' },
  { title: '初始化方式' },
  { title: '确认配置' },
]
const wizardCanNext = computed(() => {
  if (wizardStep.value === 0) return wizardDataDir.value.trim().length > 0
  if (wizardStep.value === 1 && wizardInitMode.value === 'import') return wizardPythonDir.value.trim().length > 0
  return true
})

watch(searchIncludeArchive, () => { loadAll() })
const draggingId = ref<string | null>(null)
const dragoverCol = ref<string | null>(null)
const previewTask = ref<Task | null>(null)
const editTask_ = ref<any>(null)
// 启动台「添加/编辑应用」模态的开关 + 表单载体。
// ⚠ 此前 template（v-if / v-model / 取消按钮）与 openAddApp / saveEditApp 全都在用它，
// 唯独这里没声明 → 点「+ 添加应用」立刻 ReferenceError，界面毫无反应；
// v-if 恒为 undefined 也让模态永不出现。同一个按钮因此被反复报修（"第六次了"），
// 而历次修复都在改 CSS / dialog / 原子写 —— 没碰到真因。
const editApp_ = ref<any>(null)
const showSettings_ = ref(false)

// ── 备份 v2（WebDAV + 静默调度 + 可验证恢复） ────────────────────────

interface BkForm {
  url: string
  username: string
  password: string
  hasPassword: boolean
  enabled: boolean
  intervalHours: number
  firstDelayMinutes: number
  localKeep: number
  remoteKeep: number
  allowSelfSigned: boolean
  localDir: string
}

const bkForm = ref<BkForm>({
  url: '', username: '', password: '', hasPassword: false,
  enabled: true, intervalHours: 6, firstDelayMinutes: 5,
  localKeep: 10, remoteKeep: 10, allowSelfSigned: false, localDir: '',
})
const bkMsg = ref('')
const bkMsgType = ref('info')
const bkBusy = ref(false)
const bkTesting = ref(false)
const bkTab = ref<'local' | 'remote'>('local')
const bkLocal = ref<any[]>([])
const bkRemote = ref<any[]>([])
const bkStatus = ref<any>({ enabled: false, running: false, nextRunAt: null, state: {} })
const bkState = computed<any>(() => bkStatus.value.state || {})
const bkShowLog = ref(false)
const bkLogLines = ref<string[]>([])
const bkVerifyResult = ref<any>(null)
let bkUnsub: (() => void) | null = null

const bkCurrentList = computed(() => (bkTab.value === 'local' ? bkLocal.value : bkRemote.value))
const bkAlert = computed(() => !bkStatus.value.running && (bkState.value.failStreak || 0) > 0)

const bkDotClass = computed(() => {
  if (bkStatus.value.running) return 'bk-running'
  if ((bkState.value.failStreak || 0) > 0) return 'bk-bad'
  if (bkState.value.lastSuccessAt) return 'bk-ok'
  return 'bk-idle'
})

const bkStatusText = computed(() => {
  const st = bkState.value
  if (bkStatus.value.running) return '正在备份…'
  if ((st.failStreak || 0) > 0) return `连续失败 ${st.failStreak} 次`
  if (st.lastSuccessAt) return `上次成功 ${bkFmt(st.lastSuccessAt)} · ${st.lastFiles || 0} 个文件`
  return bkStatus.value.enabled || bkStatus.value.intervalHours ? '尚未执行过备份' : '自动备份已关闭'
})

const bkTooltip = computed(() => {
  const parts = ['备份：' + bkStatusText.value]
  if (bkState.value.lastRemotePath) parts.push('云端：已同步')
  else if (bkForm.value.url) parts.push('云端：未同步')
  return parts.join(' · ')
})

function bkFmt(ts: string | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (isNaN(d.getTime())) return String(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function bkInitBackup() {
  await bkRefreshStatus()
  try {
    bkUnsub = window.tegula.onBackupStatus((s: any) => { bkStatus.value = s })
  } catch { /* 订阅失败不影响手动操作 */ }
}

async function bkRefreshStatus() {
  const r = await window.tegula.backupStatus()
  if (r.ok) bkStatus.value = r.status
}

async function bkLoadConfig() {
  const r = await window.tegula.backupGetConfig()
  if (!r.ok) return
  const c = r.config
  bkForm.value = {
    url: c.remote.url || '',
    username: c.remote.username || '',
    password: '',
    hasPassword: !!c.remote.hasPassword,
    enabled: !!c.enabled,
    intervalHours: c.intervalHours,
    firstDelayMinutes: c.firstDelayMinutes,
    localKeep: c.localKeep,
    remoteKeep: c.remoteKeep,
    allowSelfSigned: !!c.remote.allowSelfSigned,
    localDir: c.localDir || '',
  }
}

async function bkLoadList() {
  const l = await window.tegula.backupListLocal()
  if (l.ok) bkLocal.value = l.items
  if (bkTab.value === 'remote') {
    const rr = await window.tegula.backupListRemote()
    bkRemote.value = rr.ok ? rr.items : []
  }
}

function bkSwitchTab(t: 'local' | 'remote') {
  bkTab.value = t
  bkLoadList()
}

async function bkSaveConfig(silent = false): Promise<boolean> {
  const f = bkForm.value
  const patch: any = {
    enabled: f.enabled,
    intervalHours: f.intervalHours,
    firstDelayMinutes: f.firstDelayMinutes,
    localKeep: f.localKeep,
    remoteKeep: f.remoteKeep,
    localDir: f.localDir.trim(),
    remote: {
      url: f.url.trim(),
      username: f.username.trim(),
      allowSelfSigned: f.allowSelfSigned,
    },
  }
  // 留空 = 沿用已保存密文；只有真输入了新密码才提交
  if (f.password.trim()) patch.remote.password = f.password.trim()

  const r = await window.tegula.backupSetConfig(patch)
  if (!r.ok) {
    bkMsg.value = '保存失败：' + (r.error || '未知错误')
    bkMsgType.value = 'error'
    return false
  }
  bkForm.value.password = ''
  bkForm.value.hasPassword = !!r.config.remote.hasPassword
  if (!silent) {
    bkMsg.value = '配置已保存'
    bkMsgType.value = 'success'
  }
  await bkRefreshStatus()
  return true
}

function bkReportResult(r: any, label: string) {
  const res = r.result
  if (r.ok && res) {
    bkMsg.value = `${label}成功 · ${res.files} 个文件 · ${(res.rawBytes / 1024).toFixed(0)} KB` +
      (res.remotePath ? ' · 已上云' : ' · 仅本地')
    bkMsgType.value = res.remotePath ? 'success' : 'info'
  } else {
    const first = (res && res.errors && res.errors[0]) || r.error || '未知错误'
    const extra = res && res.warnings && res.warnings.length ? `（${res.warnings[0]}）` : ''
    bkMsg.value = `${label}失败：${first}${extra}`
    bkMsgType.value = 'error'
  }
}

async function bkSaveAndRun() {
  if (bkBusy.value) return
  if (!(await bkSaveConfig(true))) return
  bkBusy.value = true
  bkMsg.value = ''
  try {
    bkReportResult(await window.tegula.backupRun(), '备份')
  } finally {
    bkBusy.value = false
    await bkLoadList()
    await bkRefreshStatus()
  }
}

async function bkRunLocalOnly() {
  if (bkBusy.value) return
  bkBusy.value = true
  bkMsg.value = ''
  try {
    bkReportResult(await window.tegula.backupRunLocalOnly(), '本地备份')
  } finally {
    bkBusy.value = false
    await bkLoadList()
    await bkRefreshStatus()
  }
}

async function bkTestRemote() {
  if (bkTesting.value) return
  bkTesting.value = true
  bkMsg.value = ''
  try {
    const r = await window.tegula.backupTestRemote({
      url: bkForm.value.url.trim(),
      username: bkForm.value.username.trim(),
      password: bkForm.value.password.trim(),
      allowSelfSigned: bkForm.value.allowSelfSigned,
    })
    bkMsg.value = (r.ok ? '✅ ' : '❌ ') + (r.detail || r.error || '测试失败')
    bkMsgType.value = r.ok ? 'success' : 'error'
  } finally {
    bkTesting.value = false
  }
}

async function bkRestore(b: any) {
  if (bkBusy.value) return
  const where = bkTab.value === 'local' ? '本地' : '远端'
  if (!confirm(`确认从${where}备份恢复？\n\n${b.name}\n\n当前数据会先做快照，恢复失败将自动回滚。`)) return
  bkBusy.value = true
  try {
    const source = bkTab.value === 'local'
      ? { kind: 'local', path: b.path }
      : { kind: 'remote', name: b.name }
    const r = await window.tegula.backupRestore(source)
    if (r.ok) {
      bkMsg.value = `已恢复 ${r.restoredFiles} 个文件；恢复前快照：${r.snapshotDir || '(无)'}`
      bkMsgType.value = 'success'
      await loadAll()
    } else {
      bkMsg.value = '恢复失败：' + ((r.errors && r.errors[0]) || r.error || '未知错误')
      bkMsgType.value = 'error'
    }
  } finally {
    bkBusy.value = false
    await bkLoadList()
  }
}

async function bkOpenDir() {
  const r = await window.tegula.backupOpenDir()
  if (!r.ok) bkMsg.value = '打开目录失败：' + (r.error || '')
}

async function bkToggleLog() {
  bkShowLog.value = !bkShowLog.value
  if (bkShowLog.value) {
    const r = await window.tegula.backupLog(150)
    if (r.ok) bkLogLines.value = r.lines
  }
}

async function bkPickDir() {
  const r = await window.tegula.backupPickDir()
  if (r.ok && r.dir) bkForm.value.localDir = r.dir
}

/** 导出到任意目录（典型用途：网盘同步文件夹，由客户端负责上传） */
async function bkExportTo() {
  if (bkBusy.value) return
  bkBusy.value = true
  bkMsg.value = ''
  try {
    const r = await window.tegula.backupExportTo({})
    if (r.canceled) return
    if (r.ok) {
      const res = r.result
      bkMsg.value = `已导出 ${res.files} 个文件 · ${(res.bytes / 1024).toFixed(0)} KB → ${res.dir}` +
        (res.toolPath ? '（含独立恢复脚本 fangcun-restore.py）' : '')
      bkMsgType.value = 'success'
      if (res.errors && res.errors.length) {
        bkMsg.value += ' ｜ 提醒：' + res.errors[0]
        bkMsgType.value = 'info'
      }
    } else {
      bkMsg.value = '导出失败：' + ((r.result && r.result.errors && r.result.errors[0]) || r.error || '未知错误')
      bkMsgType.value = 'error'
    }
  } finally {
    bkBusy.value = false
  }
}

/** 校验任意位置的备份包（含从网盘下载回来的副本） */
async function bkVerifyPackage() {
  if (bkBusy.value) return
  bkBusy.value = true
  bkVerifyResult.value = null
  try {
    const r = await window.tegula.backupVerifyPackage()
    if (r.canceled) return
    bkVerifyResult.value = {
      ok: !!r.ok,
      name: String(r.path || '').split(/[\\/]/).pop() || '',
      errors: r.errors || [],
      manifest: r.manifest || null,
      entries: r.entries || 0,
    }
  } finally {
    bkBusy.value = false
  }
}

/** 从任意 zip 文件恢复（先校验，校验不过不动数据） */
async function bkRestoreFromFile() {
  if (bkBusy.value) return
  const pick = await window.tegula.backupPickRestoreFile()
  if (!pick.ok || !pick.path) return
  const name = String(pick.path).split(/[\\/]/).pop()
  if (!confirm(
    `确认从该文件恢复？\n\n${name}\n\n` +
    `恢复前会先做完整性校验；校验不通过则不会改动任何数据。\n` +
    `现有数据会自动打快照，替换失败会回滚。`
  )) return
  bkBusy.value = true
  try {
    const r = await window.tegula.backupRestore({ kind: 'local', path: pick.path })
    if (r.ok) {
      bkMsg.value = `已恢复 ${r.restoredFiles} 个文件；恢复前快照：${r.snapshotDir || '(无)'}`
      bkMsgType.value = 'success'
      await loadAll()
    } else {
      bkMsg.value = '恢复失败：' + ((r.errors && r.errors[0]) || r.error || '未知错误')
      bkMsgType.value = 'error'
    }
  } finally {
    bkBusy.value = false
    await bkLoadList()
  }
}

const batchMode = ref(false)
const selectedBatch = ref<string[]>([])
const logBatchMode = ref(false)
const selectedLogBatch = ref<string[]>([])
const dataDir = ref('')

// ── Todos ─────────────────────────────────────────────────────────
interface Todo {
  id: string
  title: string
  done: boolean
  // ⚠ 实际存的是中文「高/中/低」（主进程 normalizePriority 归一）。
  // 这里此前写成 'high' | 'normal' | 'low' —— 类型与数据不符，是历史残留。
  priority: string
  due?: string
  project?: string
  createdAt: string
  updatedAt: string
}
const todos = ref<Todo[]>([])
const todoInput = ref('')
const todoFilter = ref('all')

// ── Review ─────────────────────────────────────────────────────────
const reviewModal = ref<{ id: string; title: string } | null>(null)
const launchpadApps = ref<any[]>([])
const launchpadConfigPath = ref('')
const blockerChains = ref<any[]>([])
const totalBlockedTasks = computed(() => blockerChains.value.reduce((sum, s) => sum + (s.blockedTasks?.length || 0), 0))
const roadmapData = ref<any>({ projects: [] })
const projectProgress = ref<Record<string, any>>({})

// ── 通知中心（Notification Center）─────────────────────────────────
// UI 按用户原型 notification-center.html 移植；数据走 notifications:* IPC
const NC_TYPE_META: Record<string, { icon: string; label: string; glyph: string }> = {
  'todo-due':      { icon: 'calendar', label: '待办到期', glyph: '📅' },
  'task-deadline': { icon: 'task',     label: '任务逾期', glyph: '📋' },
  'task-timeout':  { icon: 'approve',  label: '超时未回写', glyph: '⏱' },
  'parse-error':   { icon: 'security', label: '解析失败', glyph: '⚠' },
  'backup-failed': { icon: 'storage',  label: '备份失败', glyph: '💾' },
}
const ncOpen = ref(false)
const ncReady = ref(false)
const ncLoading = ref(false)
const ncUnread = ref(0)
const ncItems = ref<any[]>([])
const ncFilter = ref<'all' | 'unread' | 'read'>('all')
let ncTimer: number | null = null

const ncCounts = computed(() => {
  const unread = ncItems.value.filter(n => !n.read).length
  return { all: ncItems.value.length, unread, read: ncItems.value.length - unread }
})
const ncVisible = computed(() => {
  return ncItems.value.filter(n => {
    if (ncFilter.value === 'unread' && n.read) return false
    if (ncFilter.value === 'read' && !n.read) return false
    return true
  })
})
const ncHeadSub = computed(() => ncUnread.value
  ? `你有 ${ncUnread.value} 条未读通知`
  : '全部通知均已读')

function ncRelTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (isNaN(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

async function ncLoad(): Promise<void> {
  try {
    const [list, unread] = await Promise.all([
      (window as any).tegula.notificationsList(),
      (window as any).tegula.notificationsUnreadCount(),
    ])
    ncItems.value = list || []
    ncUnread.value = unread || 0
  } catch { /* IPC 失败静默，ncReady 已做入口探测 */ }
}

async function ncRefresh(): Promise<void> {
  if (ncLoading.value) return
  ncLoading.value = true
  try {
    await (window as any).tegula.notificationsScan()
    await ncLoad()
  } catch { /* ignore */ }
  setTimeout(() => { ncLoading.value = false }, 400)
}

function ncToggle(): void {
  if (ncOpen.value) { closePanel(); return }
  ncOpen.value = true
  ncLoad()
}

function closePanel(): void {
  ncOpen.value = false
}

function ncSetFilter(f: 'all' | 'unread' | 'read'): void {
  ncFilter.value = f
}

async function ncClickItem(n: any): Promise<void> {
  if (!n.read) {
    try {
      await (window as any).tegula.notificationsMarkRead(n.id)
      n.read = true
      ncUnread.value = Math.max(0, ncUnread.value - 1)
    } catch { /* ignore */ }
  }
}

async function ncToggleRead(n: any): Promise<void> {
  try {
    await (window as any).tegula.notificationsMarkRead(n.id)
    if (!n.read) { n.read = true; ncUnread.value = Math.max(0, ncUnread.value - 1) }
  } catch { /* ignore */ }
}

async function ncMarkAllRead(): Promise<void> {
  try {
    await (window as any).tegula.notificationsMarkAllRead()
    await ncLoad()
  } catch { /* ignore */ }
}

async function ncDelete(n: any): Promise<void> {
  try {
    await (window as any).tegula.notificationsDelete(n.id)
    await ncLoad()
  } catch { /* ignore */ }
}

async function ncClearAll(): Promise<void> {
  try {
    await (window as any).tegula.notificationsClear()
    await ncLoad()
  } catch { /* ignore */ }
}

function onDocumentClick(e: MouseEvent): void {
  if (!ncOpen.value) return
  const wrap = (e.target as HTMLElement).closest('.nc-wrap, .nc-panel, .nc-bell')
  if (!wrap) closePanel()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && ncOpen.value) closePanel()
}

function ncInit(): void {
  const t = (window as any).tegula
  ncReady.value = !!(t && typeof t.notificationsList === 'function')
  if (!ncReady.value) return  // preload 未暴露通知 IPC → 隐藏铃铛（防僵尸按钮）
  document.addEventListener('mousedown', onDocumentClick)
  document.addEventListener('keydown', onKeydown)
  ncLoad()
  // 30s 轮询未读数（轻量，只拉计数）
  ncTimer = window.setInterval(() => {
    (window as any).tegula.notificationsUnreadCount().then((c: number) => { ncUnread.value = c || 0 }).catch(() => {})
  }, 30_000)
}

const toast = reactive({ show: false, msg: '', type: 'info' })



// Logs polling: refresh logs list every 5s when viewing logs
watch(curView, (val) => {
  if (val === 'logs') {
    loadLogs()
    logPollingTimer = setInterval(loadLogs, 5000)
  } else {
    if (logPollingTimer) {
      clearInterval(logPollingTimer)
      logPollingTimer = null
    }
  }
})

const views = [
  { id: 'active', label: '看板' },
  { id: 'todos', label: '待办' },
  { id: 'logs', label: '日志' },
  { id: 'projects', label: '项目' },
  { id: 'blockers', label: '阻塞' },
  { id: 'roadmap', label: '路线图' },
  { id: 'calendar', label: '日历' },
  { id: 'archive', label: '归档' },
  { id: 'launchpad', label: '启动台' },
]

const pickerStyle = {
  right: '20px',
  top: '50%',
  transform: 'translateY(-50%)',
}

// ── Computed ────────────────────────────────────────────────────────────

const boardClass = computed(() => ({
  pv: curView.value === 'projects',
  'batch-mode': batchMode.value,
}))

// Normalize project field: array → first element, or empty string
function normProject(p: any): string {
  if (!p) return ''
  if (Array.isArray(p)) return p[0] || ''
  return p
}

// filteredTasks defined after archiveTask below

const columns = computed(() => {
  const filtered = filteredTasks.value
  const cols: Record<string, Task[]> = {}

  if (groupMode.value === 'status') {
    STATUSES.forEach(s => (cols[s] = []))
    filtered.forEach(t => {
      const k = t.status || '草稿'
      if (!cols[k]) cols[k] = []
      cols[k].push(t)
    })
    return STATUSES.map(s => ({ key: s, label: s, tasks: cols[s] || [] }))
  }

  if (groupMode.value === 'priority') {
    const groups: Record<string, Task[]> = {}
    filtered.forEach(t => {
      const k = localPriority(t.priority)
      if (!groups[k]) groups[k] = []
      groups[k].push(t)
    })
    // 已识别优先级固定三列；无法识别的值兜底成「其他」一列。
    // 早期这里用 high/normal/low 作 key，而数据里是中文，导致所有有优先级的任务在
    // 「按优先级」视图下集体消失。
    const cols = taskPriorities.value.map(p => ({ key: p, label: p + '优先级', tasks: groups[p] || [] }))
    const others = Object.keys(groups).filter(k => !taskPriorities.value.includes(k))
    if (others.length) {
      cols.push({ key: '其他', label: '其他优先级', tasks: others.flatMap(k => groups[k]) })
    }
    return cols
  }

  const groups: Record<string, Task[]> = {}
  filtered.forEach(t => {
    const k = normProject(t.project) || '未归属'
    if (!groups[k]) groups[k] = []
    groups[k].push(t)
  })
  return Object.entries(groups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => ({ key: k, label: k, tasks: v }))
})

const projectStats = computed(() => {
  return projects.value.map(p => {
    const projTasks = tasks.value.filter(t => normProject(t.project) === p.id)
    const active = projTasks.filter(t => t.status !== '完成' && t.status !== '驳回')
    const completed = projTasks.filter(t => t.status === '完成')
    let lastActivity: string | null = null
    for (const t of projTasks) {
      if (t.updated && (!lastActivity || t.updated > lastActivity)) {
        lastActivity = t.updated
      }
    }
    return {
      id: p.id,
      name: p.name || p.id,
      taskCount: projTasks.length,
      activeTasks: active.length,
      completedTasks: completed.length,
      lastActivity,
      health: computeHealth(projTasks, lastActivity),
    }
  })
})

// ── Functions ───────────────────────────────────────────────────────────

function computeHealth(tasks: Task[], lastActivity: string | null): string {
  if (tasks.length === 0) return 'idle'
  if (!lastActivity) return 'dormant'
  const days = (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24)
  if (days > 30) return 'dormant'
  if (days > 7) return 'stuck'
  return 'active'
}

function healthLabel(h: string): string {
  return { active: '活跃', stuck: '停滞', dormant: '休眠', idle: '空闲' }[h] || h
}

function isActiveStatus(s: string): boolean {
  return ['进行中', '待验收', '待审批', '待办'].includes(s)
}

function isStale(t: Task): boolean {
  if (!t.updated) return false
  const days = (Date.now() - new Date(t.updated).getTime()) / (1000 * 60 * 60 * 24)
  return days > 14 && isActiveStatus(t.status || '')
}

function isOverdue(t: Task): boolean {
  return false
}

function statusClass(s: string): string {
  return {
    草稿: 'draft', 待审批: 'review', 待办: 'todo',
    进行中: 'doing', 待验收: 'verify', 完成: 'done', 驳回: 'reject',
  }[s] || 'draft'
}

function statusColor(s: string): string {
  return {
    草稿: '#9ca3af', 待审批: '#f59e0b', 待办: '#6366f1',
    进行中: '#d9a44a', 待验收: '#e8a34a', 完成: '#5e9154', 驳回: '#c96a6a',
  }[s] || '#9ca3af'
}

function truncate(s: string, n: number): string {
  return s?.length > n ? s.slice(0, n) + '...' : s || ''
}

function formatDate(d?: string): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('zh-CN')
}

function relativeTime(d: string): string {
  const diff = (Date.now() - new Date(d).getTime()) / (1000 * 60 * 60 * 24)
  if (diff < 1) return '今天'
  if (diff < 7) return `${Math.floor(diff)}天前`
  if (diff < 30) return `${Math.floor(diff / 7)}周前`
  return `${Math.floor(diff / 30)}月前`
}

// ── Data loading ────────────────────────────────────────────────────────

async function loadLaunchpad() {
  try {
    launchpadApps.value = await window.tegula.launchpadLoadApps()
    launchpadConfigPath.value = await window.tegula.launchpadGetConfigPath()
  } catch {
    launchpadApps.value = []
  }
}

/**
 * 阻塞链数据。
 *
 * 2026-09-22 补：`loadViewData('blockers')` 一直在调用它，但**这个函数从未被定义** ——
 * 点「阻塞」页签直接 `Uncaught ReferenceError: loadBlockerChains is not defined`，
 * 页面停在上一个视图，且不弹任何错。tsc / vite / stub e2e / IPC 对账全都抓不到
 * （函数体里的未定义名要等运行到那一行才抛），已由 `check-template-bindings.cjs`
 * 新增的「② 调用了但未定义」检查兜住。
 */
async function loadBlockerChains() {
  try {
    blockerChains.value = await window.tegula.getBlockerChains()
  } catch {
    blockerChains.value = []
  }
}

// ── 数据目录迁移 ─────────────────────────────────────────────────────
const migrateTarget = ref<any>(null)
const migrateBusy = ref(false)

// ── 新建规划 / 新建项目（替代 Electron 未实现的 window.prompt） ────────
const projForm = ref<{ id: string; name: string; repo: string; description: string } | null>(null)
const projCreating = ref(false)

/**
 * 切换数据目录。
 *
 * 旧实现是 `prompt('输入新数据目录路径')` —— Electron 未实现 window.prompt()，
 * 调用即抛错且无 try/catch，点这个按钮什么都不会发生。而且它只切指针不搬数据。
 * 现在：目录选择对话框 → 只读体检 → 自建模态确认 → 备份+复制+切指针。
 */
async function changeDataDir() {
  const picked = await window.tegula.browseDirectory()
  if (!picked) return

  const r = await window.tegula.dataInspect(picked)
  if (!r.ok) {
    showToast('检查目录失败：' + (r.error || '未知错误'), 'error')
    return
  }
  const info = r.info
  if (info.isCurrent) {
    showToast('这就是当前数据目录', 'info')
    return
  }
  if (info.insideCurrent) {
    showToast('目标不能位于当前数据目录内部', 'error')
    return
  }
  // 目标已有方寸数据：让用户选「仅切换指向」还是「复制式迁移」。
  // 2026-09-22 数据分裂事故：仓库根与 %APPDATA% 各有一份数据时，
  // 覆盖式迁移会拿旧数据盖掉新数据 —— 必须给「仅切换」出路。
  if (!info.empty) {
    if (confirm(`目标目录已有方寸数据（${info.taskCount} 个任务文件）。\n\n【确定】= 仅切换指向（推荐，两边数据都已各自保留，不复制不覆盖）\n【取消】= 返回，改用下方「覆盖式迁入」流程`)) {
      try {
        const sr = await window.tegula.setDataDir(info.dir)
        if (!sr.ok) { showToast('切换失败：' + sr.error, 'error'); return }
        dataDir.value = info.dir
        showToast('已切换数据目录（仅指向，未复制）：' + info.dir, 'success')
        await loadAll()
      } catch (e: any) {
        showToast('切换异常：' + (e?.message || e), 'error')
      }
      return
    }
    // 用户选了取消 → 走原有覆盖式迁移确认弹窗
  }
  migrateTarget.value = info
}

async function confirmMigrate() {
  const info = migrateTarget.value
  if (!info || migrateBusy.value) return
  migrateBusy.value = true
  try {
    const r = await window.tegula.dataMigrate(info.dir, { allowExisting: !info.empty })
    if (!r.ok) {
      showToast('迁移失败：' + (r.error || '未知错误'), 'error')
      return
    }
    dataDir.value = r.to
    migrateTarget.value = null
    await loadAll()
    showToast(`已迁移 ${r.migrated.copiedFiles} 个文件到新目录（原目录已保留）`, 'success')
  } finally {
    migrateBusy.value = false
  }
}

async function openDataDir() {
  await window.tegula.launchpadOpenFolder(dataDir.value)
}

/** 视图历史栈 + 返回（左上角「← 返回」走这里）。
 *  此前所有视图切换都是裸赋值 `curView.value = v`，从项目页点进某个项目后
 *  没有任何后退入口 —— 只能再点一次左侧页签绕回去。 */
const viewHistory = ref<string[]>([])
const canGoBack = computed(() => viewHistory.value.length > 0)

/** 视图数据加载（切换与返回共用，避免两处逻辑漂移） */
function loadViewData(v: string) {
  if (v === 'launchpad') {
    loadLaunchpad()
  } else if (v === 'blockers') {
    loadBlockerChains()
  } else if (v === 'roadmap') {
    loadRoadmap()
  } else if (v === 'todos') {
    loadTodos()
  } else if (v === 'logs') {
    loadLogs()
  } else if (v === 'calendar') {
    // 日历要看任务 + 待办两条数据源（2026-09-22，用户第 6 条：此前完全不拉待办）
    loadAll()
    loadTodos()
  } else {
    loadAll()
  }
}

/** 唯一跳转入口：入栈 + 加载。所有视图跳转都必须走它，否则「返回」会丢来源 */
function navigateTo(v: string) {
  if (v !== curView.value) {
    viewHistory.value.push(curView.value)
    if (viewHistory.value.length > 20) viewHistory.value.shift()
  }
  curView.value = v
  loadViewData(v)
}

function switchView(v: string) {
  navigateTo(v)
}

/** 返回上一个视图（出栈，不再入栈） */
function goBack() {
  const prev = viewHistory.value.pop()
  if (!prev) return
  curView.value = prev
  loadViewData(prev)
}

async function loadRoadmap() {
  try {
    const result = await window.tegula.aggregateRoadmap()
    roadmapData.value = result
  } catch {
    roadmapData.value = { projects: [] }
  }
}


function roadmapHealthLabel(h: string): string {
  return { active: '活跃', stuck: '卡住', idle: '空闲' }[h] || h
}

async function loadProjectProgressMap() {
  try {
    // 一次 IPC 拿全部项目进度。原先逐项目 await = 项目数 × 全量扫描，
    // 12 个项目在 5000 任务档要 13.9s（压测数据），现在是 1 次扫描。
    projectProgress.value = await window.tegula.allProjectProgress()
  } catch {
    projectProgress.value = {}
  }
}

async function loadAll() {
  const [t, p, b, dd] = await Promise.all([
    window.tegula.loadTasks(curView.value),
    window.tegula.loadProjects(),
    window.tegula.findBlockers(),
    window.tegula.getDataDir(),
  ])
  tasks.value = t
  projects.value = p
  blockers.value = b
  dataDir.value = dd
  // also load progress for task preview
  await loadProjectProgressMap()
  if (searchIncludeArchive.value) {
    try {
      const arch = await window.tegula.loadTasks('archive')
      archivedTasks.value = arch.map((a: Task) => ({ ...a, _archived: true }))
    } catch { archivedTasks.value = [] }
  } else {
    archivedTasks.value = []
  }
  // 解析失败的文件必须显性可见 —— 静默跳过才是任务"人间蒸发"的根因
  try {
    parseErrors.value = await window.tegula.parseErrors()
  } catch {
    parseErrors.value = []
  }
}

function showParseErrors() {
  alert(
    `以下任务文件无法解析，已从看板中跳过：\n\n${parseErrors.value.join('\n')}\n\n` +
    `常见原因：标题含 ": "（如 "fix: xxx"）、字段值以 [ 或 # 开头、字段值含换行。\n` +
    `修复：python scripts/fix-bad-frontmatter.py（先跑预演，确认后加 --apply）`
  )
}


function batchSetStatus(status: string) {
  if (selectedBatch.value.length === 0) return
  executeBatchStatus(status)
}

async function executeBatchStatus(status: string) {
  const ids = [...selectedBatch.value]
  const result = await window.tegula.batchEdit(ids, { status })
  if (result.fails.length === 0) {
    showToast(`已将 ${result.ok} 个任务设为「${status}」`, 'success')
  } else {
    showToast(`${result.ok} 成功，${result.fails.length} 失败`, 'error')
  }
  selectedBatch.value = []
  batchMode.value = false
  naturalResults.value = []
  isNaturalQuery.value = false
  loadAll()
}

async function executeBatchArchive() {
  const ids = [...selectedBatch.value]
  if (ids.length === 0) return
  if (!confirm(`批量归档 ${ids.length} 个任务？`)) return
  const result = await window.tegula.batchArchive(ids)
  if (result.fails.length === 0) {
    showToast(`已归档 ${result.ok} 个任务`, 'success')
  } else {
    showToast(`${result.ok} 成功，${result.fails.length} 失败`, 'error')
  }
  selectedBatch.value = []
  batchMode.value = false
  loadAll()
}

async function executeBatchDelete() {
  const ids = [...selectedBatch.value]
  if (ids.length === 0) return
  if (!confirm(`批量删除 ${ids.length} 个任务？此操作不可恢复。`)) return
  const result = await window.tegula.batchDelete(ids)
  if (result.fails.length === 0) {
    showToast(`已删除 ${result.ok} 个任务`, 'success')
  } else {
    showToast(`${result.ok} 成功，${result.fails.length} 失败`, 'error')
  }
  selectedBatch.value = []
  batchMode.value = false
  loadAll()
}

// ── Natural Query ─────────────────────────────────────────────────────

async function executeNaturalQuery() {
  const q = searchQuery.value.trim()
  if (!q) {
    isNaturalQuery.value = false
    naturalResults.value = []
    return
  }
  // 把「含归档」开关传下去 —— 此前自然查询在主进程硬跳过 archive，勾了也搜不到
  const result = await window.tegula.naturalQuery(q, { includeArchive: searchIncludeArchive.value })
  if (result.error) {
    showToast(result.error, 'error')
    return
  }
  naturalResults.value = result.tasks
  isNaturalQuery.value = true
}

// ── Task operations ─────────────────────────────────────────────────────

function emptyTaskForm(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const spec of taskFieldSpecs.value) {
    out[spec.key] = spec.key === 'status' ? '待办' : spec.key === 'priority' ? '中' : ''
  }
  return out
}

/** spec 的选项：静态 options，或运行时从 projects 生成 */
function specOptions(spec: any): Array<{ value: string; label: string }> {
  if (spec.optionsFrom === 'projects') {
    return [
      { value: '', label: '未归属' },
      ...projects.value.map((p: any) => ({ value: p.id, label: p.name || p.id })),
    ]
  }
  return (spec.options || []).map((o: string) => ({ value: o, label: o }))
}

function openNew() {
  editTask_.value = emptyTaskForm()
}

async function openEdit(t: Task) {
  // 表单值统一从主进程取：字段清单在主进程，前端不重复维护字段映射
  let values: Record<string, string>
  try {
    values = await window.tegula.taskFormValues(t.id)
  } catch {
    values = emptyTaskForm()
  }
  editTask_.value = { ...values, id: t.id }
  previewTask.value = null
}

/** 表单里是否有内容需要挽留 */
function isDirtyFields(o: any, keys: string[]): boolean {
  return !!o && keys.some(k => String(o[k] ?? '').trim())
}

/** 关闭任务编辑器：有内容先问一句。
 *  遮罩点击（@click.self）也走这里 —— 此前是裸关，鼠标碰到窗口外那块半透明遮罩，
 *  写了一半的表单直接消失且无提示，属于最容易挨骂的那种交互。 */
function closeTaskEditor() {
  if (isDirtyFields(editTask_.value, ['title', 'blockers', 'memo', 'body', 'tags'])) {
    if (!confirm('编辑内容尚未保存，确定关闭并丢弃吗？')) return
  }
  editTask_.value = null
}

/** 关闭日志编辑器：同上（日志正文往往最长，误关代价最大） */
function closeLogEditor() {
  if (isDirtyFields(logEdit_.value, ['title', 'content', 'nextSteps'])) {
    if (!confirm('日志内容尚未保存，确定关闭并丢弃吗？')) return
  }
  logEdit_.value = null
  logCompleting.value = false
  logArchiveMode.value = false
}

/** 对象里只要还有非空文本就认为有内容（用于字段名不固定的几个模态） */
function hasAnyText(o: any): boolean {
  return !!o && typeof o === 'object' &&
    Object.values(o).some(v => typeof v === 'string' && v.trim())
}

function closePolicyEditor() {
  if (hasAnyText(policyEdit_.value) && !confirm('方针卡尚未保存，确定关闭并丢弃吗？')) return
  policyEdit_.value = null
}

function closeProjForm() {
  if (hasAnyText(projForm.value) && !confirm('项目信息尚未保存，确定关闭并丢弃吗？')) return
  projForm.value = null
}

function closeAppEditor() {
  if (hasAnyText(editApp_.value) && !confirm('应用信息尚未保存，确定关闭并丢弃吗？')) return
  editApp_.value = null
}

// ── 阻塞字段的选择器 ────────────────────────────────────────────────────
// 表单里 blockers 存的是逗号分隔字符串（见 data/index.ts 的 taskToFormValues），
// 这里给出「id 数组」视图与候选列表 —— 用户不该被要求手打任务 ID。

/** 已选依赖（id 数组视图） */
const blockerList = computed<string[]>(() => {
  const raw = String(editTask_.value?.blockers ?? '')
  return raw.split(',').map(s => s.trim()).filter(Boolean)
})

/** 候选任务：跟随表单里所选的项目，排除自己与已选中的 */
const blockerCandidates = computed<any[]>(() => {
  const e = editTask_.value
  if (!e) return []
  const proj = String(e.project ?? '').trim()
  const chosen = new Set(blockerList.value)
  return tasks.value
    .filter((t: any) => t.id !== e.id && !chosen.has(t.id))
    .filter((t: any) => {
      if (!proj) return true
      const p = t.project
      return Array.isArray(p) ? p.includes(proj) : p === proj
    })
    .slice(0, 300)
})

function taskTitleById(id: string): string {
  const t = tasks.value.find((x: any) => x.id === id) as any
  return t ? (t.title || id) : `${id}（不在当前视图）`
}

function setBlockers(ids: string[]) {
  if (editTask_.value) editTask_.value.blockers = ids.join(', ')
}

function onBlockerPick(e: Event) {
  const el = e.target as HTMLSelectElement
  if (!el.value) return
  setBlockers([...blockerList.value, el.value])
  el.value = ''
}

function removeBlocker(id: string) {
  setBlockers(blockerList.value.filter(x => x !== id))
}

async function saveEdit() {
  const e = editTask_.value
  if (!e) return
  if (!String(e.title || '').trim()) {
    showToast('标题不能为空', 'error')
    return
  }

  const patch: any = {}
  for (const spec of taskFieldSpecs.value) {
    if (spec.key === 'body') continue
    const raw = String(e[spec.key] ?? '').trim()
    if (spec.type === 'tags' || spec.type === 'list') {
      patch[spec.key] = raw ? raw.split(',').map((s: string) => s.trim()).filter(Boolean) : []
    } else {
      patch[spec.key] = raw
    }
  }
  const payload = { ...patch, body: e.body ?? '' }

  try {
    if (e.id) {
      await window.tegula.editTask(e.id, payload)
    } else {
      await window.tegula.newTask(payload)
    }
  } catch (err: any) {
    showToast('保存失败：' + (err?.message || '未知错误'), 'error')
    return
  }
  editTask_.value = null
  showToast(e.id ? '已更新' : '已创建', 'success')
  loadAll()
}

async function deleteTask(id: string) {
  if (!confirm('确定删除此任务？\n会移入 task-data/.trash，可人工找回。')) return
  // 主进程这次可能抛异常（历史上：目标同名文件已存在于 .trash → renameSync 抛 →
  // 这里没有 try/catch → 按钮点了完全没反应，用户 2026-09-25 第 5 条）。
  // 任何失败都必须变成看得见的一句话 + 日志留痕。
  try {
    const result = await window.tegula.deleteTask(id)
    if (result) {
      previewTask.value = null
      showToast('已删除', 'success')
      loadAll()
    } else {
      const msg = `删除失败：任务不存在（${id}）`
      showToast(msg, 'error')
      appErrors.value.push({ scope: 'deleteTask', message: msg, at: Date.now() })
    }
  } catch (e: any) {
    const msg = `删除「${id}」失败：${e?.message || e}`
    showToast(msg, 'error')
    appErrors.value.push({ scope: 'deleteTask', message: msg, at: Date.now() })
  }
}

async function archiveTask(t: Task) {
  if (!confirm(`确认归档「${t.title}」？\n归档后任务将进入归档视图，此操作不可自动逆转。`)) return
  const result = await window.tegula.archiveTask(t.id)
  if (result.ok) {
    previewTask.value = null
    showToast('已归档', 'success')
    loadAll()
  } else {
    showToast(`归档失败: ${result.error || '未知错误'}`, 'error')
  }
}

/** 非终态直达完成/驳回：挂死任务（如超时未回写）没有验收方可走，必须给终结入口 */
async function forceCloseTask(t: Task, status: '完成' | '驳回') {
  const word = status === '完成' ? '标记完成' : '驳回'
  if (!confirm(`确认将「${t.title}」直接${word}？\n此操作跳过验收流程（适用于挂死/废弃任务），留痕于结果记录。`)) return
  const result = await window.tegula.moveStatus(t.id, status)
  if (result.ok) {
    previewTask.value = null
    showToast(`已${word}`, 'success')
    loadAll()
  } else {
    showToast(`${word}失败: ${result.error || '未知错误'}`, 'error')
  }
}

async function restoreTask(t: Task) {
  if (!confirm(`确认还原「${t.title}」？\n任务将回到「待办」状态；若已归档，会一并移回活跃区。`)) return
  const result = await window.tegula.unarchiveTask(t.id)
  if (result.ok) {
    previewTask.value = null
    showToast('已还原', 'success')
    loadAll()
  } else {
    showToast(`还原失败: ${result.error || '未知错误'}`, 'error')
  }
}

function onBodyChange(e: Event) {
  const target = e.target as HTMLInputElement
  if (target.tagName === 'INPUT' && target.type === 'checkbox') {
    toggleCheck(target)
  }
}

function toggleCheck(el: HTMLInputElement) {
  const li = el.closest('li')
  if (!li || !previewTask.value) return
  const body = previewTask.value.body || ''
  // CRLF defense: strip trailing CR from each line before matching
  const lines = body.split('\n').map(l => l.replace(/\r$/, ''))
  const liText = (li.textContent || '').replace(/^\s+|\s+$/g, '').replace(/^-\s*\[[ x]\]\s*/, '')
  const lineIdx = lines.findIndex(l => {
    const m = l.match(/^- \[[ x]\]s*(.*)$/)
    return m && m[1].trim() === liText.trim()
  })
  if (lineIdx === -1) return
  const checked = el.checked
  lines[lineIdx] = `- [${checked ? 'x' : ' '}] ${liText}`
  const newBody = lines.join('\n')
  previewTask.value = { ...previewTask.value, body: newBody }
  // 勾选即时反馈：同步看板列表里的同一任务，不等 500ms debounce 落盘
  const idx = tasks.value.findIndex(t => t.id === previewTask.value!.id)
  if (idx !== -1) tasks.value[idx] = { ...tasks.value[idx], body: newBody }
  saveCheckChange(previewTask.value.id, newBody)
}

const _checkSaveTimers: Record<string, number> = {}
/** 待落盘的勾选内容：即使定时器被清掉，这里仍保有最新 body */
const _pendingCheckSaves: Record<string, string> = {}
const taskLogs = ref<any[]>([])

/** 反向索引：该任务的关联日志（含已完成 / 已归档） */
async function loadLogsForTask(taskId: string) {
  if (!taskId) {
    taskLogs.value = []
    return
  }
  try {
    taskLogs.value = await window.tegula.logsForTask(taskId)
  } catch {
    taskLogs.value = []
  }
}

/** 一键完成日志：不走「填保留天数」模态，直接按默认 7 天完成 */
async function quickCompleteLog(log: any) {
  try {
    const r = await window.tegula.logsComplete(log.id, 7, '')
    if (r && !r.ok) {
      showToast(`完成失败：${r.error || '未知原因'}`, 'error')
      return
    }
    showToast('日志已完成（保留 7 天）', 'success')
    await loadLogs()
  } catch (e: any) {
    const msg = e?.message || e
    showToast('完成失败：' + msg, 'error')
  }
}






async function persistCheckBody(id: string, body: string): Promise<boolean> {
  try {
    await window.tegula.editTask(id, { body })
  } catch (e: any) {
    showToast('勾选保存失败：' + (e?.message || '未知错误'), 'error')
    return false
  }
  // 所有勾选框都已勾选 → 自动标记完成
  const hasCheckbox = /^- \[[ x]\]/gm.test(body)
  const hasUnchecked = /^- \[ \]/gm.test(body)
  if (hasCheckbox && !hasUnchecked) {
    try {
      await window.tegula.moveStatus(id, '完成')
    } catch {
      // 状态推进失败不应吞掉正文已保存的事实
    }
  }
  return true
}

function saveCheckChange(id: string, body: string) {
  const prev = _checkSaveTimers[id]
  if (prev) clearTimeout(prev)
  _pendingCheckSaves[id] = body
  _checkSaveTimers[id] = window.setTimeout(() => { void flushCheckSaves(id) }, 500)
}

/**
 * 立即落盘待保存的勾选（省略 id 则全部）。
 * 关闭详情面板、切换任务、应用退出前都会调用 —— 旧实现只在 500ms 定时器里保存，
 * 用户勾完立刻关面板就会丢。
 */
async function flushCheckSaves(id?: string): Promise<boolean> {
  const ids = id ? [id] : Object.keys(_pendingCheckSaves)
  let wrote = false
  for (const tid of ids) {
    const body = _pendingCheckSaves[tid]
    if (body === undefined) continue
    const timer = _checkSaveTimers[tid]
    if (timer) { clearTimeout(timer); delete _checkSaveTimers[tid] }
    delete _pendingCheckSaves[tid]
    if (await persistCheckBody(tid, body)) wrote = true
  }
  return wrote
}

// 面板关闭或切换任务时自动 flush 上一个任务 —— 比逐个改调用点可靠
watch(
  () => previewTask.value?.id ?? null,
  async (nextId: string | null, prevId: string | null) => {
    if (prevId && prevId !== nextId && _pendingCheckSaves[prevId] !== undefined) {
      const wrote = await flushCheckSaves(prevId)
      if (wrote) loadAll()
    }
  }
)

// 关窗前尽力落盘（此时无法 await，但已发出的 IPC 通常能写完）
window.addEventListener('beforeunload', () => { void flushCheckSaves() })

function renderBody(body: string): string {
  if (!body) return ''
  let html = marked.parse(body, { breaks: true, gfm: true }) as string
  // Sanitize HTML to prevent XSS — allow <input> for checkboxes, data-check attr
  html = DOMPurify.sanitize(html, {
    ADD_TAGS: ['input'],
    ADD_ATTR: ['data-check'],
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr',
      'ul', 'ol', 'li',
      'strong', 'em', 'b', 'i',
      'code', 'pre',
      'blockquote',
      'a', 'img',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'input', 'del'
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'type', 'checked', 'disabled', 'data-check']
  })
  // Make checkboxes interactive (replace marked's disabled inputs with clickable ones)
  html = html.replace(
    /<input[^>]*disabled[^>]*type="checkbox"[^>]*>/g,
    (match) => {
      const isChecked = /checked/.test(match)
      return `<input type="checkbox" data-check="${isChecked ? 'checked' : 'unchecked'}" ${isChecked ? 'checked' : ''}>`
    }
  )
  // Add check-item class to li elements containing checkboxes
  html = html.replace(/<li>(<input type="checkbox")/g, '<li class="check-item">$1')
  return html
}

const archivedTasks = ref<Task[]>([])


/**
 * 展示层优先级兜底归一。主进程 parseTask 已做过归一，这里只防历史数据里的英文残留。
 * 不要在别处再写一套映射 —— 优先级别名表在主进程 data/index.ts。
 */
function localPriority(p: any): string {
  const s = String(p ?? '').trim()
  if (!s) return '中'
  const map: Record<string, string> = {
    '高': '高', '中': '中', '低': '低',
    high: '高', urgent: '高', critical: '高',
    medium: '中', normal: '中',
    low: '低',
  }
  return map[s.toLowerCase()] || s
}

function priorityLabel(p: string): string {
  return p ? localPriority(p) : '—'
}

/** 详情面板里的时间展示：有开始+截止就是一个时间段（2026-09-22，用户第 6 条） */
function previewTimeLabel(t: any): string {
  return rangeLabel(t?.start ?? t?.fm?.start, t?.deadline ?? t?.fm?.deadline)
}
const filteredTasks = computed(() => {
  if (isNaturalQuery.value && naturalResults.value.length > 0) {
    return naturalResults.value
  }
  let result = [...tasks.value]
  // 「含归档」只服务于活跃视图与搜索：归档视图的 tasks.value 本身就是 loadTasks('archive') 的结果，
  // 再把 archivedTasks 拼进来 = 同一批任务各出现两次（用户 2026-09-25：「归档页签内是否勾选含归档
  // 会出现不同显示效果，不是应该只显示归档内容吗」）。
  if (curView.value !== 'archive' && searchIncludeArchive.value && archivedTasks.value.length > 0) {
    result = [...result, ...archivedTasks.value]
  }
  if (curProj.value !== '__all__') {
    result = result.filter(t => normProject(t.project) === curProj.value)
  }
  if (searchQuery.value) {
    const q = searchQuery.value
    // Auto-detect natural query syntax (#tag @project)
    if (q.includes('#') || q.includes('@')) {
      const nq = naturalResults.value
      if (isNaturalQuery.value && nq.length > 0) {
        const nqIds = new Set(nq.map(t => t.id))
        result = result.filter(t => nqIds.has(t.id))
        return result
      }
    }
    const lq = q.toLowerCase()
    result = result.filter(t =>
      t.title?.toLowerCase().includes(lq) ||
      t.id?.toLowerCase().includes(lq) ||
      normProject(t.project).toLowerCase().includes(lq) ||
      t.tags?.join(' ').toLowerCase().includes(lq)
    )
  }
  if (dueFilter.value) {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    // 日期算术统一走 calendar.ts（addDays 用本地日历日构造，天然免疫 DST/时区偏移）
    const weekLater = addDays(today, 7)
    result = result.filter(t => {
      const due = (t as any).deadline || t.fm.deadline
      if (!due) return false
      const dueDate = new Date(due)
      if (isNaN(dueDate.getTime())) return false
      if (dueFilter.value === 'overdue') return dueDate < today && t.status !== '完成' && t.status !== '驳回'
      if (dueFilter.value === 'today') return dueDate >= today && dueDate < addDays(today, 1)
      if (dueFilter.value === 'week') return dueDate >= today && dueDate <= weekLater
      return true
    })
  }
  return result
})

function openCard(t: Task) {
  previewTask.value = t
  loadLogsForTask(t.id)
}

async function copyId(id: string) {
  try {
    await navigator.clipboard.writeText(id)
    showToast('已复制 ID', 'success')
  } catch {
    showToast('复制失败', 'error')
  }
}

/**
 * 打开任务的 markdown 文件（资源管理器定位）。
 * 后端 `openFile` 通道一直都在（主进程还带路径白名单校验），只是没有入口 —— 同 openReview 那一类。
 */
async function openTaskFile(t: any): Promise<void> {
  const p = t?.path
  if (!p) {
    showToast('拿不到这个任务的文件路径', 'error')
    return
  }
  try {
    const r: any = await window.tegula.openFile(p)
    if (r && r.ok === false) showToast('打开失败：' + (r.error || ''), 'error')
  } catch (e: any) {
    showToast('打开失败：' + (e?.message || e), 'error')
  }
}

// ── 任务卡右键菜单 ─────────────────────────────────────────────────────
// 用户反馈「方寸内右键没什么用」。这里放卡片上的高频操作，
// 省得每次都先点开详情面板再翻按钮。
const ctxMenu = ref<{ x: number; y: number; task: Task } | null>(null)

function openCardMenu(e: MouseEvent, t: Task) {
  ctxMenu.value = { x: e.clientX, y: e.clientY, task: t }
}

function closeCardMenu() {
  ctxMenu.value = null
}

/** 执行菜单动作并收起菜单（先收菜单，免得挡住随后的确认框） */
function ctxRun(fn: (t: Task) => void) {
  const t = ctxMenu.value?.task
  closeCardMenu()
  if (t) fn(t)
}

async function copyTaskId(t: Task) {
  try {
    await navigator.clipboard.writeText(t.id)
    showToast('已复制 ID：' + t.id, 'success')
  } catch {
    showToast('复制失败', 'error')
  }
}

async function copyTaskTitle(t: Task) {
  try {
    await navigator.clipboard.writeText(t.title || t.id)
    showToast('已复制标题', 'success')
  } catch {
    showToast('复制失败', 'error')
  }
}

function deleteTaskById(t: Task) {
  deleteTask(t.id)
}

async function copyTaskClick(id: string) {
  if (!confirm('复制此任务？')) return
  const result = await window.tegula.copyTask(id)
  if (result.ok) {
    showToast('已复制', 'success')
    loadAll()
  } else {
    showToast('复制失败', 'error')
  }
}

// ── Todos ─────────────────────────────────────────────────────────

// ── Policies（项目方针）──────────────────────────────────────────────
const policyMap = ref<Record<string, boolean>>({})
const policyEdit_ = ref<any>(null)

async function loadPolicyMap() {
  const map: Record<string, boolean> = {}
  for (const p of projects.value) {
    try {
      const r = await window.tegula.policyGet(p.id)
      map[p.id] = !!(r.ok && r.policy)
    } catch { map[p.id] = false }
  }
  policyMap.value = map
}

async function openPolicyEdit(projectId: string) {
  const proj = projects.value.find(p => p.id === projectId)
  let mission = '', goal = '', scenario = '', boundary = ''
  try {
    const r = await window.tegula.policyGet(projectId)
    if (r.ok && r.policy) ({ mission, goal, scenario, boundary } = r.policy)
  } catch { /* 未立则空表单 */ }
  policyEdit_.value = { id: projectId, name: proj?.name || projectId, mission, goal, scenario, boundary }
}

async function savePolicyEdit() {
  const e = policyEdit_.value
  if (!e) return
  try {
    const r = await window.tegula.policySave({ projectId: e.id, mission: e.mission, goal: e.goal, scenario: e.scenario, boundary: e.boundary })
    if (r.ok) {
      showToast('方针卡已保存', 'success')
      policyEdit_.value = null
      loadPolicyMap()
    } else {
      showToast('保存失败：' + (r.error || '未知错误'), 'error')
    }
  } catch (err: any) {
    showToast('保存失败：' + (err.message || err), 'error')
  }
}

async function copyPolicyText(projectId: string) {
  try {
    const r = await window.tegula.policyText(projectId)
    if (r.ok) {
      await navigator.clipboard.writeText(r.text)
      showToast('方针已复制，可直接粘给 agent', 'success')
    } else {
      showToast(r.error || '复制失败', 'error')
    }
  } catch (err: any) {
    showToast('复制失败：' + (err.message || err), 'error')
  }
}

// ── Calendar view ──────────────────────────────────────────────────────
// 2026-09-21 从老版 board.html 移植；2026-09-22 重做（用户第 6 条）。原文四条抱怨：
//   ① 「连一个指派时间或时间段的按钮都没有」 —— 只能拖已排期任务改截止，没有任何指派入口
//   ② 「未能和看板上的任务或待办真正联动」   —— 旧实现只读 filteredTasks，完全不看待办
//   ③ 「貌似根本不支持跨月」                —— 非本月的任务全被丢进「未安排（…本月之外）」
//   ④ 「时间或时间段」                      —— 只有单日 deadline，没有区间概念
// 现在：start + deadline 组成时间段（跨天画成连续色带）；待办按 due 上日历；
//       任务卡右键 / 任务详情 / 待办项 / 未安排条目四处都有「指派时间」；
//       未安排拆成「无日期」与「其它月份（可一键跳转）」，跨月不再是一锅粥。
const CAL_DOW = ['一', '二', '三', '四', '五', '六', '日']
const calYear = ref(new Date().getFullYear())
const calMonth = ref(new Date().getMonth())
const calDragOverDay = ref<number | null>(null)
const calShowTodos = ref(localStorage.getItem('fc_cal_show_todos') !== '0')
const calShowLogs = ref(localStorage.getItem('fc_cal_show_logs') !== '0')
let calDragId: string | null = null
let calDragKind: 'task' | 'todo' = 'task'

const pad2 = (n: number): string => String(n).padStart(2, '0')

function calMove(delta: number) {
  let m = calMonth.value + delta
  let y = calYear.value
  if (m < 0) { m = 11; y-- } else if (m > 11) { m = 0; y++ }
  calMonth.value = m; calYear.value = y
}
function calToday() {
  calYear.value = new Date().getFullYear()
  calMonth.value = new Date().getMonth()
}
function calGoto(y: number, m: number) {
  calYear.value = y
  calMonth.value = m
}
function calToggleTodos() {
  calShowTodos.value = !calShowTodos.value
  localStorage.setItem('fc_cal_show_todos', calShowTodos.value ? '1' : '0')
}
function calToggleLogs() {
  calShowLogs.value = !calShowLogs.value
  localStorage.setItem('fc_cal_show_logs', calShowLogs.value ? '1' : '0')
}

// 日期算术全部在 calendar.ts 里（纯函数，可被 scripts/test/e2e-calendar.cjs 直接断言）——
// 跨月边界这类错误在界面上只表现为"少一天/多一天"，肉眼抓不住，必须靠脚本。
const taskStart = (t: any): Date | null => parseCalDate(t?.start ?? t?.fm?.start)
const taskDue = (t: any): Date | null => parseCalDate(t?.deadline ?? t?.fm?.deadline)

/** 日历只关心非终态任务 */
const calActiveTasks = computed(() =>
  filteredTasks.value.filter(t => t.status !== '完成' && t.status !== '驳回'))

/** 未完成的待办（done 的不占日历） */
const calActiveTodos = computed(() => todos.value.filter(t => !t.done))

type CalEvent = CalEventT<Task, Todo>

/** 一次算清：格子 / 未安排 / 其它月份（纯函数，见 calendar.ts） */
const calMonthData = computed(() => buildMonth<Task, Todo, any>({
  year: calYear.value,
  month: calMonth.value,
  today: new Date(),
  tasks: calActiveTasks.value.map(t => ({
    ...t,
    priority: localPriority(t.priority),
    start: (t as any).start ?? t.fm?.start,
    deadline: (t as any).deadline ?? t.fm?.deadline,
  })),
  todos: calActiveTodos.value.map(td => ({ ...td, priority: localPriority(td.priority) })),
  showTodos: calShowTodos.value,
  // 2026-09-23（用户第 3 条）：日志上日历
  logs: logs.value,
  showLogs: calShowLogs.value,
}))

const calCells = computed(() => calMonthData.value.cells)
const calUnscheduled = computed(() => calMonthData.value.unscheduled as unknown as Task[])
const calOtherMonths = computed(() => calMonthData.value.otherMonths)
const calOtherTotal = computed(() => calMonthData.value.otherTotal)

function prioColor(p: any): string {
  const s = localPriority(p)
  return s === '高' ? '#c96a6a' : s === '中' ? '#d9a44a' : s === '低' ? '#7a9e6b' : '#d5d3e0'
}

// ── 指派时间（模态：开始 + 截止 / 待办只有到期日）──────────────────────
const calAssign_ = ref<{
  id: string; title: string; isTodo: boolean; start: string; end: string
} | null>(null)

function openCalAssignTask(t: any) {
  const s = taskStart(t), e = taskDue(t)
  calAssign_.value = {
    id: t.id, title: t.title || t.id, isTodo: false,
    start: s ? calISO(s) : '',
    end: e ? calISO(e) : '',
  }
}

function openCalAssignTodo(id: string) {
  const td = todos.value.find(x => x.id === id)
  if (!td) return
  const d = parseCalDate(td.due)
  calAssign_.value = {
    id: td.id, title: td.title, isTodo: true, start: '',
    end: d ? calISO(d) : '',
  }
}

function calQuickSet(days: number) {
  const a = calAssign_.value
  if (!a) return
  const target = calISO(addDays(new Date(), days))
  if (a.isTodo) { a.end = target; return }
  if (!a.start) { a.end = target } else { a.end = target; if (a.start > a.end) a.start = a.end }
}

function calClearDates() {
  const a = calAssign_.value
  if (!a) return
  a.start = ''
  a.end = ''
}

async function saveCalAssign() {
  const a = calAssign_.value
  if (!a) return
  if (a.start && a.end && a.end < a.start) {
    showToast('截止不能早于开始', 'error')
    return
  }
  try {
    if (a.isTodo) {
      const r: any = await window.tegula.todosUpdate(a.id, { due: a.end || '' })
      if (!r || r.ok === false) { showToast('指派失败：' + (r?.error || '未知原因'), 'error'); return }
      showToast(a.end ? `待办到期日已设为 ${a.end}` : '已清除待办到期日', 'success')
      await loadTodos()
    } else {
      const r: any = await window.tegula.editTask(a.id, { start: a.start, deadline: a.end })
      if (!r || r.ok === false) { showToast('指派失败：' + (r?.error || '未知原因'), 'error'); return }
      const label = a.start && a.end ? `${a.start} → ${a.end}` : (a.end || a.start || '已清除')
      showToast(`时间已设为 ${label}`, 'success')
      loadAll()
    }
    calAssign_.value = null
  } catch (e: any) {
    showToast('指派失败：' + (e?.message || e), 'error')
  }
}

// ── 拖拽改期 ───────────────────────────────────────────────────────────
function onCalDragStart(e: DragEvent, id: string, kind: 'task' | 'todo' | 'log' = 'task') {
  calDragId = id
  calDragKind = kind
  e.dataTransfer?.setData('text/plain', id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onCalEventClick(ev: CalEvent) {
  if (ev.kind === 'todo') { openCalAssignTodo(ev.id); return }
  // 2026-09-23（用户第 3 条）：日志事件点击 → 打开日志编辑框
  if (ev.kind === 'log') {
    const log = logs.value.find((l: any) => l.id === ev.id)
    if (log) openLog(log)
    return
  }
  const t = calActiveTasks.value.find(x => x.id === ev.id)
  if (t) openCard(t)
}

async function onCalDrop(e: DragEvent, cell: { day: number } | null) {
  e.preventDefault()
  calDragOverDay.value = null
  if (!cell) return
  const id = calDragId || e.dataTransfer?.getData('text/plain')
  const kind = calDragKind
  calDragId = null
  if (!id) return
  const target = calISO(new Date(calYear.value, calMonth.value, cell.day))
  try {
    if (kind === 'todo') {
      const r: any = await window.tegula.todosUpdate(id, { due: target })
      if (!r || r.ok === false) { showToast('改期失败：' + (r?.error || '未知原因'), 'error'); return }
      showToast(`待办到期日已改为 ${target}`, 'success')
      await loadTodos()
      return
    }
    // 2026-09-23（用户第 3 条）：日志拖拽改期
    if (kind === 'log') {
      const r: any = await window.tegula.logsUpdate(id, { logDate: target })
      if (r && r.ok === false) { showToast('改期失败：' + (r?.error || '未知原因'), 'error'); return }
      showToast(`日志日期已改为 ${target}`, 'success')
      await loadLogs()
      return
    }
    const t = calActiveTasks.value.find(x => x.id === id)
    const s = t ? taskStart(t) : null
    const ed = t ? taskDue(t) : null
    let patch: Record<string, string>
    let msg: string
    if (s && ed) {
      // 时间段整体平移：保持长度，把「开始」落到目标日（算术在 calendar.ts，可单测）
      const shifted = shiftRange(calISO(s), calISO(ed), target)
      patch = { start: shifted.start, deadline: shifted.end }
      msg = `时间段已移到 ${shifted.start} → ${shifted.end}`
    } else {
      patch = { deadline: target }
      msg = `截止已改为 ${target}`
    }
    const r: any = await window.tegula.editTask(id, patch)
    if (r && r.ok) {
      showToast(msg, 'success')
      loadAll()
    } else {
      showToast('改期失败：' + (r?.error || '未知原因'), 'error')
    }
  } catch (err: any) {
    showToast('改期失败：' + (err?.message || err), 'error')
  }
}

const filteredTodos = computed(() => {
  let list = todos.value
  if (todoFilter.value === 'active') list = list.filter(t => !t.done)
  if (todoFilter.value === 'done') list = list.filter(t => t.done)
  // 项目联动：选了项目（非全部）时只显示归属该项目或不归属的
  if (todoProjectFilter.value !== '__all__') {
    list = list.filter(t => !t.project || t.project === todoProjectFilter.value)
  }
  return list
})

const todoProjectFilter = ref('__all__')

async function loadTodos() {
  try {
    todos.value = await window.tegula.todosList()
  } catch {
    todos.value = []
  }
}

async function executeTodoAdd() {
  const text = todoInput.value.trim()
  // 2026-09-22：原来空输入是**静默 return**，用户点了没有任何反应，
  // 从外面看就像"按钮无效"。所有分支都必须有反馈。
  if (!text) {
    showToast('请先在左侧输入框里填写待办内容', 'info')
    return
  }
  // 快速语法：p0/p1/p2 优先级；归属项目跟当前筛选联动
  let priority = '中'
  let title = text
  const m = text.match(/^(.*?)\s+(p[012])$/i)
  if (m) { title = m[1]; priority = { p0: '高', p1: '中', p2: '低' }[m[2].toLowerCase()] || '中' }
  const project = todoProjectFilter.value !== '__all__' ? todoProjectFilter.value : undefined
  try {
    const result = await window.tegula.todosCreate(title, priority, undefined, project)
    if (result && result.ok) {
      todoInput.value = ''
      showToast('已添加', 'success')
      await loadTodos()
    } else {
      showToast('添加失败：' + ((result && result.error) || '未知原因'), 'error')
    }
  } catch (e: any) {
    // 落到这里说明 IPC 本身炸了（通道缺失/主进程异常），必须让人看见
    showToast('添加失败：' + (e?.message || e), 'error')
  }
}

// ── 拖拽提示的稳定显示（2026-09-22，用户第 4/5 条）──────────────────────
// 症状：拖动文件时「松手导入…」提示高频闪烁、按不住。
// 两个真因，都得治：
//   ① 提示是 v-if 的**流内元素** —— 它一出现就把下方内容顶下去，
//      光标位置相对内容变了 → 触发 dragleave → 提示消失 → dragover 又出现… 自激振荡；
//   ② 把 dragover/dragleave 直接映射成 boolean，而 dragleave 在容器内
//      子元素之间切换时也会来一发。
// 处置：提示改成 position:fixed 悬浮层 + pointer-events:none（不参与布局与命中），
//       进出用 dragenter/dragleave **深度计数**，drop/dragend 统一归零。
const dragDepth = reactive<Record<'todo' | 'log' | 'global', number>>({ todo: 0, log: 0, global: 0 })

function dragEnter(zone: 'todo' | 'log' | 'global'): void {
  dragDepth[zone] = (dragDepth[zone] || 0) + 1
}
function dragLeave(zone: 'todo' | 'log' | 'global'): void {
  dragDepth[zone] = Math.max(0, (dragDepth[zone] || 0) - 1)
}
function dragResetAll(): void {
  dragDepth.todo = 0
  dragDepth.log = 0
  dragDepth.global = 0
}

const todoDragOver = computed(() => dragDepth.todo > 0)
const logDragOver = computed(() => dragDepth.log > 0)
/** 当前页签不支持导入时，全局兜底提示（明确告诉用户去哪，而不是毫无反应） */
const globalDropHint = computed(() =>
  dragDepth.global > 0 && curView.value !== 'todos' && curView.value !== 'logs')

/** 拖到不支持导入的页签：给一句明确指引，并重置计数 */
function onAppDrop(e: DragEvent): void {
  dragResetAll()
  if (curView.value === 'todos' || curView.value === 'logs') return
  e.preventDefault()
  showToast('当前页签不支持导入文件 —— 请到「待办」或「日志」页签再拖入', 'info')
}

function onTodoDrop(e: DragEvent) {
  e.preventDefault()
  dragResetAll()
  const files = Array.from(e.dataTransfer?.files || [])
  if (!files.length) return
  void importTextLinesAsTodos(files)
}

/**
 * 拖入 txt/md 逐行建待办（2026-09-22 加重名/重复处置）。
 * 用户第 4 条：同名/重复内容**没有任何提示**，且会重复生成。
 * 现在：批内去重 + 与现存待办比对，重复的集中问一次，再报"写入 N 条 / 跳过 M 条重复"。
 */
async function importTextLinesAsTodos(files: File[]): Promise<void> {
  const usable = files.filter(f => /\.(txt|md)$/i.test(f.name))
  if (!usable.length) {
    showToast('仅支持 .txt / .md 文件', 'error')
    return
  }
  const project = todoProjectFilter.value !== '__all__' ? todoProjectFilter.value : undefined
  const existing = new Set(todos.value.map(t => t.title.trim()))
  const unique: string[] = []
  const dupInBatch: string[] = []
  for (const f of usable) {
    const text = await f.text()
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      if (existing.has(t) || unique.includes(t)) { dupInBatch.push(t); continue }
      unique.push(t)
    }
  }
  const dupTotal = dupInBatch.length
  if (!unique.length) {
    showToast(dupTotal ? `全部 ${dupTotal} 条都是已存在的同名待办，未新增` : '没有可导入的行', 'info')
    return
  }
  if (dupTotal) {
    const sample = dupInBatch.slice(0, 3).join('、')
    if (!confirm(`有 ${dupTotal} 条与现有待办重复，将被跳过：\n${sample}${dupTotal > 3 ? ' …' : ''}\n\n继续导入剩余 ${unique.length} 条？`)) {
      showToast('已取消导入', 'info')
      return
    }
  }
  let added = 0
  for (const title of unique) {
    const r = await window.tegula.todosCreate(title, '中', undefined, project)
    if (r.ok) added++
  }
  showToast(`已导入 ${added} 条待办${dupTotal ? `，跳过 ${dupTotal} 条重复` : ''}`, added ? 'success' : 'error')
  loadTodos()
}

async function toggleTodo(id: string) {
  const result = await window.tegula.todosToggle(id)
  if (result.ok) {
    loadTodos()
  }
}

async function deleteTodo(id: string) {
  if (!confirm('确定删除此待办？')) return
  await window.tegula.todosDelete(id)
  showToast('已删除', 'success')
  loadTodos()
}

// ── Logs ───────────────────────────────────────────────────────────

const logs = ref<any[]>([])
const logSearchInput = ref('')
const logStatusFilter = ref('')
const logProjectFilter = ref('')
const logAgentFilter = ref('')
const logDateFrom = ref('')
const logDateTo = ref('')
const logEdit_ = ref<any>(null)
// Agent 预设列表（设置页可增删，存 localStorage）
const agentPresets = ref<string[]>(JSON.parse(localStorage.getItem('fc_agent_presets') || '["hermes","opencode","codex","deepseek","claude"]'))
const newAgentName = ref('')

function addAgentPreset() {
  const name = newAgentName.value.trim()
  if (!name) return
  if (agentPresets.value.includes(name)) { showToast('已存在', 'info'); return }
  agentPresets.value.push(name)
  localStorage.setItem('fc_agent_presets', JSON.stringify(agentPresets.value))
  newAgentName.value = ''
  showToast('已添加', 'success')
}

function removeAgentPreset(index: number) {
  const removed = agentPresets.value[index]
  agentPresets.value.splice(index, 1)
  localStorage.setItem('fc_agent_presets', JSON.stringify(agentPresets.value))
  // 如果当前筛选用的是被删的预设，清掉
  if (logAgentFilter.value === removed) logAgentFilter.value = ''
  showToast('已删除', 'info')
}
let logPollingTimer: ReturnType<typeof setInterval> | null = null

const filteredLogs = computed(() => {
  let list = logs.value
  if (logStatusFilter.value) {
    list = list.filter(l => l.status === logStatusFilter.value)
  }
  return list
})

async function loadLogs() {
  try {
    const filter: any = {}
    if (logStatusFilter.value) filter.status = logStatusFilter.value
    if (logProjectFilter.value) filter.project = logProjectFilter.value
    if (logAgentFilter.value) filter.agent = logAgentFilter.value
    if (logDateFrom.value) filter.dateFrom = logDateFrom.value
    if (logDateTo.value) filter.dateTo = logDateTo.value
    logs.value = await window.tegula.logsList(filter)
  } catch {
    logs.value = []
  }
}

function logStatusLabel(status: string): string {
  return { active: '进行中', completed: '已完成', archived: '已归档' }[status] || status
}

function toggleLogBatchMode() {
  logBatchMode.value = !logBatchMode.value
  if (!logBatchMode.value) selectedLogBatch.value = []
}

function toggleSelectAllLogs() {
  if (selectedLogBatch.value.length === filteredLogs.value.length) {
    selectedLogBatch.value = []
  } else {
    selectedLogBatch.value = filteredLogs.value.map((l: any) => l.id)
  }
}

async function executeBatchLogComplete() {
  const ids = [...selectedLogBatch.value]
  if (ids.length === 0) return
  if (!confirm(`批量完成 ${ids.length} 条日志？`)) return
  let ok = 0
  for (const id of ids) {
    try {
      const r = await window.tegula.logsComplete(id, 7, '')
      if (r?.ok) ok++
    } catch { /* skip */ }
  }
  showToast(`已批量完成 ${ok}/${ids.length} 条日志`, ok ? 'success' : 'error')
  selectedLogBatch.value = []
  logBatchMode.value = false
  loadLogs()
}

async function executeBatchLogArchive() {
  const ids = [...selectedLogBatch.value]
  if (ids.length === 0) return
  if (!confirm(`批量归档 ${ids.length} 条日志？`)) return
  let ok = 0
  for (const id of ids) {
    try {
      const r = await window.tegula.logsArchive(id)
      if (r?.ok) ok++
    } catch { /* skip */ }
  }
  showToast(`已批量归档 ${ok}/${ids.length} 条日志`, ok ? 'success' : 'error')
  selectedLogBatch.value = []
  logBatchMode.value = false
  loadLogs()
}

async function executeBatchLogDestroy() {
  const ids = [...selectedLogBatch.value]
  if (ids.length === 0) return
  if (!confirm(`批量销毁 ${ids.length} 条日志？文件将被永久删除。`)) return
  let ok = 0
  for (const id of ids) {
    try {
      const r = await window.tegula.logsDestroy(id)
      if (r?.ok) ok++
    } catch { /* skip */ }
  }
  showToast(`已批量销毁 ${ok}/${ids.length} 条日志`, ok ? 'success' : 'error')
  selectedLogBatch.value = []
  logBatchMode.value = false
  loadLogs()
}

function onLogCardClick(log: any) {
  if (logBatchMode.value) {
    const idx = selectedLogBatch.value.indexOf(log.id)
    if (idx >= 0) selectedLogBatch.value.splice(idx, 1)
    else selectedLogBatch.value.push(log.id)
  } else {
    openLog(log)
  }
}

function openLog(log: any) {
  logEdit_.value = { ...log }
  logCompleting.value = false
  logArchiveMode.value = false
  // 2026-09-23（用户第2条）：修复日志模态框输入聚焦问题
  // 自动聚焦到标题输入框，确保用户可以立即输入
  setTimeout(() => {
    const titleInput = document.querySelector('#log-edit-modal input[placeholder="日志标题"]') as HTMLInputElement
    if (titleInput) titleInput.focus()
  }, 50)
}

const logCompleting = ref(false)
const logArchiveMode = ref(false)
const logRetainDays = ref('7')
const logNote = ref('')

function openNewLog() {
  // 项目默认跟随顶栏的项目筛选（没筛选就用第一个登记项目），而不是硬编码一个 id
  const project = curProj.value !== '__all__'
    ? curProj.value
    : (projects.value[0]?.id || '')
  logEdit_.value = { id: '', title: '', project, content: '', nextSteps: '', taskId: '', sessionId: '', agentName: '', logDate: '' }
  logCompleting.value = false
  logArchiveMode.value = false
  logRetainDays.value = '7'
  logNote.value = ''
}

/** 日志可关联的任务候选：按所选项目过滤（用户第 2 条：便于选择，而非手填 ID） */
const logTaskOptions = computed(() => {
  const proj = logEdit_.value?.project
  const all = [...tasks.value, ...archivedTasks.value]
  const seen = new Set<string>()
  const out: Array<{ id: string; title: string; status: string }> = []
  for (const t of all) {
    if (seen.has(t.id)) continue
    if (proj && normProject(t.project) !== proj) continue
    seen.add(t.id)
    out.push({ id: t.id, title: t.title || '', status: t.status })
    if (out.length >= 500) break
  }
  return out
})

/** 当前已关联任务的回显（id 不在任务列表里时提示"列表外"） */
const logTaskPicked = computed(() => {
  const id = logEdit_.value?.taskId
  if (!id) return ''
  const t = [...tasks.value, ...archivedTasks.value].find(x => x.id === id)
  return t ? `${t.id} · ${t.title || '(无标题)'} · ${t.status}` : `${id}（不在当前任务列表中）`
})

// ── 日志：导入外部文本（老版本有，桌面化时丢了）────────────────────────
// 按钮选择与直接拖入两条路都通；每个文件生成一条日志，标题取文件名。
// 2026-09-22（用户第 4 条）：同名/重复此前**静默生成**，现在先判重、集中问一次。
// 2026-09-22（补）：判重口径从"仅文件名"扩到「文件名 + 正文内容指纹」——
//   改名重导同一份内容同样会被拦住（用户："防呆不防傻"→ 这一版把"傻"也补上）。
const LOG_IMPORT_RE = /\.(txt|md|markdown|log)$/i

async function importTextFilesAsLogs(files: File[]): Promise<number> {
  const usable = files.filter(f => LOG_IMPORT_RE.test(f.name))
  if (!usable.length) {
    if (files.length) showToast('仅支持 .txt / .md / .log 文件', 'error')
    return 0
  }
  // 取**全量**日志参与判重（logs.value 可能正被状态/搜索条件过滤，
  // 用过滤后的列表判重会漏过"已归档的同名/同内容"，那就等于没有判重）
  let existing: any[] = []
  try {
    existing = await window.tegula.logsList()
  } catch { /* 取不到就退化为"不判重"，不阻断导入 */ }

  const items: ImportItem[] = []
  for (const f of usable) {
    try {
      items.push({ title: f.name.replace(/\.[^.]+$/, ''), text: await f.text() })
    } catch { /* 单个文件读失败不阻断其余 */ }
  }
  if (!items.length) {
    showToast('文件读取失败，没有可导入的内容', 'error')
    return 0
  }

  const cls = classifyLogImport(items, existing)
  const skipped = cls.dupTitle.length + cls.dupContent.length + cls.dupInBatch.length
  if (!cls.fresh.length) {
    showToast(`全部被拦截，未新增 —— ${classifySummary(cls)}`, 'info')
    return 0
  }
  if (skipped) {
    const lines: string[] = []
    const sample = (arr: string[]) => arr.slice(0, 3).join('、') + (arr.length > 3 ? ' …' : '')
    if (cls.dupTitle.length) lines.push(`同名：${sample(cls.dupTitle)}`)
    if (cls.dupContent.length) lines.push(`内容相同（只是改了名）：${sample(cls.dupContent)}`)
    if (cls.dupInBatch.length) lines.push(`同一批里重复：${sample(cls.dupInBatch)}`)
    if (!confirm(`检测到 ${skipped} 个重复文件（按「文件名 + 正文内容指纹」判定）：\n${lines.join('\n')}\n\n重复的跳过，继续导入其余 ${cls.fresh.length} 个？`)) {
      showToast('已取消导入', 'info')
      return 0
    }
  }

  const project = curProj.value !== '__all__' ? curProj.value : (projects.value[0]?.id || '')
  let ok = 0
  for (const it of cls.fresh) {
    try {
      const r = await window.tegula.logsCreate(it.title, project, it.text)
      if (r?.ok) ok++
    } catch { /* 单个文件失败不阻断其余 */ }
  }
  showToast(`已导入 ${ok} 条日志${skipped ? `，跳过 ${skipped} 个重复` : ''}`, ok ? 'success' : 'error')
  loadLogs()
  return ok
}

function importLogFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.txt,.md,.markdown,.log'
  input.multiple = true
  input.onchange = async (e: any) => {
    await importTextFilesAsLogs(Array.from(e.target.files || []))
  }
  input.click()
}

async function onLogDrop(e: DragEvent) {
  e.preventDefault()
  dragResetAll()
  await importTextFilesAsLogs(Array.from(e.dataTransfer?.files || []))
}

/** 从任务详情写一条执行日志：预填 taskId 与项目，省得再手填一遍 */
function openLogForTask(taskId: string) {
  openNewLog()
  logEdit_.value.taskId = taskId
  const t = previewTask.value
  if (t?.project) logEdit_.value.project = normProject(t.project)
  if (t?.title) logEdit_.value.title = `${t.title} — 执行记录`
}

async function saveLogEdit() {
  const e = logEdit_.value
  if (!e.title?.trim()) {
    showToast('标题不能为空', 'error')
    return
  }
  try {
    if (logCompleting.value) {
      const rd = parseInt(logRetainDays.value) || 7
      const result = await window.tegula.logsComplete(e.id, rd, logNote.value || undefined)
      if (result.ok) {
        showToast(`已标记完成（保留 ${rd} 天）`, 'success')
      } else {
        showToast(`完成失败：${result.error || '未知原因'}`, 'error')
        return
      }
    } else if (logArchiveMode.value) {
      const result = await window.tegula.logsArchive(e.id, logNote.value || undefined)
      if (result.ok) {
        showToast('已归档', 'success')
      } else {
        showToast(`归档失败：${result.error || '未知原因'}`, 'error')
        return
      }
    } else if (e.id) {
      // 2026-09-22：此前只回写 title/content/nextSteps —— 在界面上改了「项目」或
      // 「关联任务」点保存会提示"已更新"，但字段被静默丢弃（用户报障「改不了项目」）。
      // 2026-09-23：补上 sessionId/agentName/logDate 三个新字段。
      const r: any = await window.tegula.logsUpdate(e.id, {
        title: e.title,
        content: e.content,
        nextSteps: e.nextSteps,
        project: e.project,
        taskId: e.taskId || '',
        sessionId: e.sessionId || '',
        agentName: e.agentName || '',
        logDate: e.logDate || '',
      })
      if (r && !r.ok) {
        showToast(`更新失败：${r.error || '未知原因'}`, 'error')
        return
      }
      showToast('已更新', 'success')
    } else {
      const r: any = await window.tegula.logsCreate(
        e.title, e.project, e.content, e.taskId || undefined,
        { sessionId: e.sessionId || '', agentName: e.agentName || '', logDate: e.logDate || '' },
      )
      if (r && !r.ok) {
        showToast(`创建失败：${r.error || '未知原因'}`, 'error')
        return
      }
      showToast('已创建', 'success')
    }
    logEdit_.value = null
    logCompleting.value = false
    logArchiveMode.value = false
    await loadLogs()
  } catch (err: any) {
    showToast(`保存失败: ${err.message || err}`, 'error')
  }
}

function completeLogItem(id: string) {
  const log = logs.value.find(l => l.id === id)
  if (!log) return
  logEdit_.value = { ...log }
  logCompleting.value = true
  logArchiveMode.value = false
  logRetainDays.value = '7'
  logNote.value = ''
  logBatchMode.value = false
}

function archiveLogItem(id: string) {
  const log = logs.value.find(l => l.id === id)
  if (!log) return
  logEdit_.value = { ...log }
  logCompleting.value = false
  logArchiveMode.value = true
  logRetainDays.value = '7'
  logNote.value = ''
  logBatchMode.value = false
}

async function destroyLogItem(id: string) {
  if (!confirm('确定销毁此日志？文件将被永久删除。')) return
  const result = await window.tegula.logsDestroy(id)
  if (result.ok) {
    showToast('已销毁', 'success')
    await loadLogs()
  } else {
    showToast(`销毁失败：${result.error || '未知原因'}`, 'error')
  }
}

async function executeLogSearch() {
  if (!logSearchInput.value.trim()) {
    await loadLogs()
    return
  }
  try {
    logs.value = await window.tegula.logsSearch(logSearchInput.value)
  } catch {
    logs.value = []
  }
}

/**
 * 把一条日志复制成可直接粘给 agent 的提示词块。
 * 后端 `logs:inject`（返回"上次执行日志"格式的文本）早就写好并注册了通道，
 * 但界面从来没有入口 —— 而"日志 → 提示词"正是方寸定位里的核心动作。
 */
async function copyLogAsPrompt(id: string): Promise<void> {
  try {
    const text: any = await window.tegula.logsInject(id)
    if (!text) {
      showToast('这条日志注入不了（可能已被销毁或归档）', 'error')
      return
    }
    await navigator.clipboard.writeText(String(text))
    showToast('已复制为提示词，可直接粘给 agent', 'success')
  } catch (e: any) {
    showToast('复制失败：' + (e?.message || e), 'error')
  }
}

async function executeLogCleanup() {
  try {
    const result = await window.tegula.logsCleanup()
    const n = Array.isArray(result) ? result.length : 0
    if (n) {
      showToast(`已将 ${n} 条超期日志标为「已归档」（仅改状态，文件未删）`, 'success')
    } else {
      showToast('没有超期日志：需先点「完成」并填保留天数，到期后才会被清理', 'info')
    }
    await loadLogs()
  } catch (e: any) {
    showToast('清理失败：' + (e?.message || e), 'error')
  }
}

// ── Review ─────────────────────────────────────────────────────────

const reviewReason = ref('')

function openReview(t: Task) {
  reviewModal.value = { id: t.id, title: t.title || t.id }
  reviewReason.value = ''
  previewTask.value = null
}

async function acceptTask() {
  if (!reviewModal.value) return
  const result = await window.tegula.reviewAccept(reviewModal.value.id)
  if (result.ok) {
    showToast('已通过', 'success')
    reviewModal.value = null
    loadAll()
  } else {
    showToast(result.error || '操作失败', 'error')
  }
}

async function rejectTask() {
  if (!reviewModal.value) return
  if (!reviewReason.value.trim()) {
    showToast('驳回理由必填', 'error')
    return
  }
  const result = await window.tegula.reviewReject(reviewModal.value.id, reviewReason.value)
  if (result.ok) {
    showToast('已驳回', 'success')
    reviewModal.value = null
    loadAll()
  } else {
    showToast(result.error || '操作失败', 'error')
  }
}

// ── Drag and drop ───────────────────────────────────────────────────────

function onDragStart(e: DragEvent, id: string) {
  draggingId.value = id
  e.dataTransfer?.setData('text/plain', id)
  // 1x1 透明像素作为拖拽图像，消除系统默认的半透明"分身"幻影
  const img = new Image()
  img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setDragImage(img, 0, 0)
  }
}

function onDragOver(e: DragEvent, status: string) {
  dragoverCol.value = status
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move'
  }
}

async function onDrop(e: DragEvent, status: string) {
  e.preventDefault()
  const id = draggingId.value || e.dataTransfer?.getData('text/plain')
  if (id) {
    try {
      const result = await window.tegula.moveStatus(id, status)
      if (result.ok) {
        showToast(`已移动到「${status}」`, 'success')
      } else {
        showToast(`移动失败: ${result.error || '未知错误'}`, 'error')
      }
    } catch (err) {
      showToast(`移动失败: ${err}`, 'error')
    }
  }
  draggingId.value = null
  dragoverCol.value = null
  loadAll()
}

// ── Batch mode ──────────────────────────────────────────────────────────

function toggleBatchMode() {
  batchMode.value = !batchMode.value
  if (!batchMode.value) selectedBatch.value = []
}

function toggleBatchSelect(id: string) {
  const idx = selectedBatch.value.indexOf(id)
  if (idx >= 0) selectedBatch.value.splice(idx, 1)
  else selectedBatch.value.push(id)
}

function toggleSelectAll() {
  if (selectedBatch.value.length === filteredTasks.value.length) {
    selectedBatch.value = []
  } else {
    selectedBatch.value = filteredTasks.value.map(t => t.id)
  }
}

// ── Project view ────────────────────────────────────────────────────────

function openProject(p: any) {
  curProj.value = p.id
  navigateTo('active')
}

function openProjectInSettings(p: Project) {
  curProj.value = p.id
  navigateTo('active')
  showToast(`已切换项目：${p.name || p.id}`, 'info')
}

/**
 * 新建项目：真正写入 registry.yaml。
 * 此前是 `prompt('项目名称：')` + "项目添加功能开发中" —— 双重不可用：
 * prompt 在 Electron 里直接抛错（连提示都弹不出来），而且功能本来就没实现。
 */
function openNewProject() {
  projForm.value = { id: '', name: '', repo: '', description: '' }
}

async function confirmNewProject() {
  const f = projForm.value
  if (!f || projCreating.value) return
  if (!f.id.trim()) {
    showToast('项目 ID 不能为空', 'error')
    return
  }
  projCreating.value = true
  try {
    const r: any = await window.tegula.registryAddProject({
      id: f.id.trim(),
      name: f.name.trim() || f.id.trim(),
      repo: f.repo.trim(),
      description: f.description.trim(),
    })
    if (r && r.ok) {
      showToast('项目已登记到 registry.yaml', 'success')
      projForm.value = null
      await loadAll()
    } else {
      showToast('登记失败：' + ((r && r.error) || '未知错误'), 'error')
    }
  } catch (e: any) {
    showToast('登记失败：' + (e?.message || '未知错误'), 'error')
  } finally {
    projCreating.value = false
  }
}

// ── Launchpad ─────────────────────────────────────────────────────────

function openAddApp() {
  editApp_.value = { name: '', path: '', description: '', argsText: '', isNew: true }
}

function openEditApp(app: any) {
  editApp_.value = { ...app, argsText: Array.isArray(app.args) ? app.args.join(' ') : '', isNew: false }
}

async function saveEditApp() {
  const e = editApp_.value
  if (!e.name || !e.path) {
    showToast('名称和路径必填', 'error')
    return
  }
  // 路径直接进 cmd（执行器按扩展名分派）；参数可选
  const args = String(e.argsText || '').trim()
    ? String(e.argsText).trim().split(/\s+/).filter(Boolean)
    : undefined
  const app = { name: e.name, path: e.path, cmd: e.path, args, description: e.description }
  if (e.isNew) {
    await window.tegula.launchpadAddApp(app)
  } else {
    await window.tegula.launchpadUpdateApp(e.id, app)
  }
  editApp_.value = null
  showToast(e.isNew ? '已添加' : '已更新', 'success')
  loadLaunchpad()
}

async function removeApp(id: string) {
  if (!confirm('确定删除？')) return
  await window.tegula.launchpadRemoveApp(id)
  editApp_.value = null
  showToast('已删除', 'success')
  loadLaunchpad()
}

async function browseAppPath() {
  const result = await window.tegula.browseFile()
  if (result) {
    editApp_.value.path = result
  }
}

function openConfigPath() {
  window.tegula.launchpadOpenFolder(launchpadConfigPath.value)
}

function refreshApps() {
  loadLaunchpad()
  showToast('已刷新', 'info')
}

async function launchAppClick(app: any) {
  const t: any = (window as any).tegula || {}
  // 先落一条「渲染层点了启动」的痕迹再调主进程。
  // 理由：2026-09-25 用户报「启动台依旧报错」，但日志里**一条 launchpad 记录都没有** ——
  // 分不清是"没点"还是"点了但主进程没收到/主进程是旧代码"。这条线一写，两种情况立刻可分。
  try {
    await t.applogWrite?.('INFO', 'launchpad-ui', `点击启动：${app?.name || app?.id || '(未知)'}`,
      JSON.stringify({ cmd: app?.cmd, path: app?.path, hasLaunchApi: typeof t.launchpadLaunchApp === 'function' }))
  } catch { /* 日志写不进去也不能挡住启动 */ }

  if (typeof t.launchpadLaunchApp !== 'function') {
    const msg = '当前运行的主进程/预加载是旧版本，没有启动台接口 —— 请托盘右键「退出」后重新启动'
    showToast(msg, 'error')
    appErrors.value.push({ scope: 'launchpad', message: msg, at: Date.now() })
    return
  }
  try {
    const result = await window.tegula.launchpadLaunchApp(app)
    showToast(result.message, result.ok ? 'success' : 'error')
    if (!result.ok) {
      // 失败把「启动了什么」也带上，并留一条错误条 + 日志可查
      appErrors.value.push({
        scope: 'launchpad',
        message: `启动「${app.name}」失败：${result.message}（命令：${app.cmd || app.path}）`,
        at: Date.now(),
      })
    }
  } catch (e: any) {
    const msg = `启动「${app.name}」失败：${e?.message || e}（命令：${app.cmd || app.path}）`
    showToast(msg, 'error')
    appErrors.value.push({ scope: 'launchpad', message: msg, at: Date.now() })
  }
}

// ── Settings / Backup ──────────────────────────────────────────────────

// ── 版本与更新（2026-09-22 用户第 2 条：设置里看不到版本，也没有检查更新）──
// updater IPC（update:check / download / quitAndInstall）一直都在（updater.ts），
// 只是渲染层从未消费。这里补上 UI 消费：当前版本 + 检查更新 + 下载 + 安装。
const appVersion = ref('')
const updateState = ref<{ checked: boolean; busy: boolean; available: boolean; downloaded: boolean; version: string; msg: string }>({
  checked: false, busy: false, available: false, downloaded: false, version: '', msg: '',
})

async function loadAppVersion(): Promise<void> {
  try {
    const v = await (window as any).tegula.getAppVersion()
    appVersion.value = String(v || '')
  } catch { appVersion.value = '' }
}

async function checkUpdate(): Promise<void> {
  const t: any = (window as any).tegula || {}
  updateState.value.busy = true
  updateState.value.checked = false
  updateState.value.msg = '检查中…'
  try {
    await t.updateCheck()
    // 结果经 onUpdateAvailable / onUpdateNotAvailable 事件回调（见 onMounted 订阅）
    // 2026-09-23（用户第 5 条）：检查完成后给明确反馈，不再静默
  } catch (e: any) {
    updateState.value.msg = '检查失败：' + (e?.message || e)
    updateState.value.checked = true
    updateState.value.busy = false
    showToast('检查失败：' + (e?.message || e), 'error')
  }
}

async function downloadUpdate(): Promise<void> {
  const t: any = (window as any).tegula || {}
  updateState.value.busy = true
  try {
    await t.updateDownload()
    updateState.value.msg = '下载中…（进度见通知）'
  } catch (e: any) {
    updateState.value.msg = '下载失败：' + (e?.message || e)
  } finally {
    updateState.value.busy = false
  }
}

function installUpdate(): void {
  const t: any = (window as any).tegula || {}
  try { t.updateQuitAndInstall() } catch { /* ignore */ }
}

function showSettings() {
  loadPolicyMap()
  showSettings_.value = true
  // 打开设置时同步备份配置与历史
  bkMsg.value = ''
  bkLoadConfig()
  bkLoadList()
  bkRefreshStatus()
}

async function triggerBackup() {
  if (bkBusy.value) return
  bkBusy.value = true
  try {
    // 走新的备份链路：零依赖 zip 打包 → 自校验 → 本地 → WebDAV → 核对
    const r = await window.tegula.backupRun()
    const res = r.result
    if (r.ok && res) {
      backupInfo.value = { path: res.localPath, sizeKB: Math.round(res.localBytes / 1024) }
      const cloud = res.remotePath ? ' · 已上云' : (res.warnings && res.warnings.length ? ' · 仅本地' : '')
      showToast(`备份成功 · ${res.files} 个文件 · ${(res.rawBytes / 1024).toFixed(0)} KB${cloud}`, 'success')
    } else {
      const first = (res && res.errors && res.errors[0]) || r.error || '未知错误'
      showToast('备份失败：' + first, 'error')
    }
    await bkLoadList()
    await bkRefreshStatus()
  } finally {
    bkBusy.value = false
  }
}

/**
 * 打开「最近一次备份」所在目录。
 * 2026-09-22：这个函数此前**定义了但没有任何入口**（死代码）—— 已接到备份区按钮上。
 * 顺带把原来只认 `\` 的切分改成跨平台（用正则去掉最后一段路径）。
 */
async function openBackupFolder(): Promise<void> {
  const p = backupInfo.value?.path
  if (!p) { await bkOpenDir(); return }
  const dir = p.replace(/[\\/][^\\/]*$/, '')
  const r: any = await window.tegula.launchpadOpenFolder(dir)
  if (r && r.ok === false) bkMsg.value = '打开目录失败：' + (r.error || '')
}

function showBackup() {
  triggerBackup()
}

function exportTasksToFile() {
  window.tegula.exportTasks().then((result: any) => {
    if (result.ok && result.data) {
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `fangcun-tasks-${Date.now()}.json`
      a.click()
      URL.revokeObjectURL(url)
      showToast(`已导出 ${result.count} 个任务`, 'success')
    } else {
      showToast('导出失败', 'error')
    }
  })
}

function importTasksFromFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = (e: any) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev: any) => {
      try {
        const data = JSON.parse(ev.target.result)
        if (!Array.isArray(data)) { showToast('格式错误：需要 JSON 数组', 'error'); return }
        window.tegula.importTasks(data).then((res: any) => {
          if (res.ok) { showToast(`已导入 ${res.imported} 个任务`, 'success'); loadAll() }
          else showToast('导入失败', 'error')
        })
      } catch { showToast('JSON 解析失败', 'error') }
    }
    reader.readAsText(file)
  }
  input.click()
}


// ── Toast ───────────────────────────────────────────────────────────────

function showToast(msg: string, type: 'success' | 'error' | 'info' = 'info') {
  toast.msg = msg
  toast.type = type
  toast.show = true
  setTimeout(() => { toast.show = false }, 2000)
}

// ── 应用日志 / 错误出口（2026-09-22，用户第 8 条）────────────────────────
// 此前任何失败（启动台启动失败、导入失败、脚本异常）界面上只有一句干巴巴的
// 提示，终端里什么都没有。现在：全局异常 → main.ts 上报 → 主进程落盘
// （userData/logs/fangcun-YYYYMMDD.log）→ 这里给可见的错误条与日志抽屉。
const appErrors = ref<Array<{ scope: string; message: string; at: number }>>([])
const appErrOpen = ref(false)
const appLogFile = ref('')
const appLogTail = ref<string[]>([])

/** 接收 main.ts 广播；3 秒内完全相同的错误只留一条，避免刷屏 */
function onAppError(e: Event): void {
  const d = (e as CustomEvent).detail || {}
  const message = String(d.message || '')
  if (!message) return
  const last = appErrors.value[appErrors.value.length - 1]
  if (last && last.message === message && Date.now() - last.at < 3000) return
  appErrors.value.push({ scope: String(d.scope || 'error'), message, at: Date.now() })
  if (appErrors.value.length > 30) appErrors.value.shift()
}

async function loadAppLogPath(): Promise<void> {
  try { appLogFile.value = await window.tegula.applogPath() } catch { appLogFile.value = '' }
}

async function toggleAppLogPanel(): Promise<void> {
  appErrOpen.value = !appErrOpen.value
  if (!appErrOpen.value) return
  await loadAppLogPath()
  try { appLogTail.value = await window.tegula.applogTail(200) } catch { appLogTail.value = [] }
}

async function openAppLogDir(): Promise<void> {
  const t: any = (window as any).tegula || {}
  // 主进程/preload 是启动时读进内存的：开发态改了主进程但没重启 Electron 时，
  // 这个接口根本不存在 —— 原来只会抛 TypeError 被吞成一句无信息量的「打开日志目录失败」。
  if (typeof t.applogOpenDir !== 'function') {
    showToast('当前运行的主进程/预加载还是旧版本，没有日志接口 —— 请托盘右键「退出」后重新启动', 'error')
    return
  }
  try {
    const r: any = await t.applogOpenDir()
    if (r && r.ok === false) {
      showToast(`打开日志目录失败：${r.error || '未知原因'}（路径 ${r.dir || appLogFile.value || '未知'}）`, 'error')
    } else if (r && r.dir) {
      appLogFile.value = r.dir
    }
  } catch (e: any) {
    showToast('打开日志目录失败：' + (e?.message || e), 'error')
  }
}

/**
 * 运行期新鲜度自检（2026-09-22）。
 *
 * 开发态只有**渲染层**走 vite 热更；主进程与 preload 是启动时读进内存的。
 * 于是会出现最坑的一种状态：界面是新代码、通道是旧代码 ——
 * 新按钮看得见，一点就报莫名其妙的错（本例：`applogOpenDir` 未定义 → "打开日志目录失败"）。
 * 这里主动探测并把它翻成一句人话，省得再花一轮排查"改了没用"。
 */
async function checkRuntimeFreshness(): Promise<void> {
  const t: any = (window as any).tegula || {}
  const need = ['applogWrite', 'applogPath', 'applogOpenDir', 'applogTail', 'todosCreate', 'logsUpdate', 'launchpadLaunchApp']
  const missing = need.filter(k => typeof t[k] !== 'function')
  if (missing.length) {
    pushRuntimeStale(`preload 未暴露新接口：${missing.join('、')}`)
    return
  }
  try {
    const p = await t.applogPath()
    if (!p) pushRuntimeStale('主进程未返回日志路径')
  } catch (e: any) {
    pushRuntimeStale('主进程未注册 applog 通道（' + (e?.message || e) + '）')
  }
}

function pushRuntimeStale(why: string): void {
  if (appErrors.value.some(e => e.scope === 'runtime-stale')) return
  appErrors.value.push({
    scope: 'runtime-stale',
    message: `运行中的 Electron 主进程/预加载是旧代码（${why}）—— 请用**托盘右键「退出」**彻底关掉再重启 npm run dev。关窗只是隐藏窗口，不会重启进程；开发态的渲染层会热更，主进程不会`,
    at: Date.now(),
  })
}

async function copyAppLogPath(): Promise<void> {
  try {
    await navigator.clipboard.writeText(appLogFile.value || '')
    showToast('日志路径已复制', 'success')
  } catch {
    showToast('复制失败：' + (appLogFile.value || ''), 'error')
  }
}

/** 从设置里看日志：先关设置，再展开抽屉（抽屉在模态之下，否则被遮住） */
async function showAppLogFromSettings(): Promise<void> {
  showSettings_.value = false
  if (!appErrOpen.value) await toggleAppLogPanel()
}

// ── Mount ───────────────────────────────────────────────────────────────

async function checkFirstRun() {
  try {
    const first = await window.tegula.isFirstRun()
    if (first) {
      showWizard.value = true
      wizardDataDir.value = await window.tegula.getDataDir()
    }
  } catch { /* ignore */ }
}

async function browseWizardDir() {
  const result = await window.tegula.browseDirectory()
  if (result) wizardDataDir.value = result
}

async function browsePythonDir() {
  const result = await window.tegula.browseDirectory()
  if (result) wizardPythonDir.value = result
}

function wizardNext() {
  if (wizardStep.value < wizardSteps.length - 1) wizardStep.value++
}

async function wizardFinish() {
  wizardFinishing.value = true
  try {
    if (wizardInitMode.value === 'fresh') {
      await window.tegula.createFreshSetup(wizardDataDir.value)
    } else {
      await window.tegula.createFreshSetup(wizardDataDir.value)
      await window.tegula.importFromPythonTegula(wizardDataDir.value, wizardPythonDir.value)
    }
    showWizard.value = false
    loadAll()
  } catch (e: any) {
    showToast('初始化失败: ' + (e.message || e), 'error')
  } finally {
    wizardFinishing.value = false
  }
}

onMounted(() => {
  checkFirstRun()
  loadTaskMeta()
  loadAll()
  // 版本号（设置页首区块显示）
  loadAppVersion()
  // 更新事件订阅：updater 主进程回调 → 设置页状态更新
  const t: any = (window as any).tegula || {}
  if (typeof t.onUpdateAvailable === 'function') {
    t.onUpdateAvailable((d: any) => {
      updateState.value.checked = true
      updateState.value.available = true
      updateState.value.version = d?.version || ''
      updateState.value.msg = '发现新版本 v' + (d?.version || '?')
      updateState.value.busy = false
      showToast('发现新版本 v' + (d?.version || '?'), 'success')
    })
    t.onUpdateNotAvailable(() => {
      updateState.value.checked = true
      updateState.value.available = false
      updateState.value.msg = '已是最新版本'
      updateState.value.busy = false
      showToast('已是最新版本', 'info')
    })
    t.onUpdateProgress((d: any) => {
      updateState.value.msg = '下载中… ' + (d?.percent != null ? Math.round(d.percent) + '%' : '')
    })
    t.onUpdateDownloaded((d: any) => {
      updateState.value.downloaded = true
      updateState.value.msg = 'v' + (d?.version || '?') + ' 已就绪，退出时自动安装'
    })
    t.onUpdateError((d: any) => {
      updateState.value.checked = true
      updateState.value.busy = false
      updateState.value.msg = '更新出错：' + (d?.message || '未知')
      showToast('更新出错：' + (d?.message || '未知'), 'error')
    })
  }
  // 备份状态全局订阅：顶栏指示灯随调度结果实时变化（失败会显红）
  bkInitBackup()
  ncInit()
  // 渲染层错误出口（2026-09-22）：main.ts 的全局上报会广播到这里，
  // 界面上给一条可见的错误条 + 「打开日志」，不再让失败无声无息。
  window.addEventListener('fc-app-error', onAppError as EventListener)
  loadAppLogPath()
  checkRuntimeFreshness()
  // 拖拽计数兜底归零：拖出窗口 / 在窗口外松手时不会有 drop，计数会泄漏
  window.addEventListener('dragend', dragResetAll)
  window.addEventListener('drop', dragResetAll)
})

onUnmounted(() => {
  if (ncTimer) { clearInterval(ncTimer); ncTimer = null }
  document.removeEventListener('mousedown', onDocumentClick)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('fc-app-error', onAppError as EventListener)
  window.removeEventListener('dragend', dragResetAll)
  window.removeEventListener('drop', dragResetAll)
})
</script>

<style>
:root {
  --bg: #eef0f4;
  --ink: #3c4150;
  --muted: #6b7180;
  --accent: #9b8fc4;
  --accent-soft: #c3bce0;
  --card: #ffffff;
  --border: #e4e2ee;
  --shadow: 0 8px 32px rgba(90,90,130,0.12);
  --radius: 18px;
  --success: #5e9154;
  --warning: #d9a44a;
  --danger: #c96a6a;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  background: var(--bg);
  color: var(--ink);
  min-height: 100vh;
}

#app { display: flex; flex-direction: column; height: 100vh; }

/* ── 按钮基座（2026-09-22）──────────────────────────────────────────────
   .ghost / .pri / .ok / .danger / .warning 此前**只在特定祖先下**定义
   （`#bar button.ghost`、`.acts .pri`、`.lp-ctrls button.ghost` …）。
   于是待办 `.todos-ctrls`、日志 `.logs-ctrls`、日历 `.calhead` 里的按钮
   匹配不到任何规则 → 直接退化成 Chromium 默认按钮长相。用户反馈过两轮。
   这里补一组**与祖先无关**的兜底。用 `:where()` 把选择器特异性压到 (0,1,0)，
   且放在样式表最前面：任何已有的更具体/同特异性的规则都仍然覆盖它。
   配套守卫：scripts/test/check-button-styles.cjs（自动扫同类漏样式）。 */
button { font-family: inherit; cursor: pointer; }
button[disabled] { opacity: .55; cursor: not-allowed; }
button:not([class]) {
  padding: 6px 14px; border: 0; border-radius: 8px;
  font-size: 12px; font-weight: 600;
  background: var(--accent); color: #fff;
}
:where(button.ghost)   { padding: 6px 14px; border: 1px solid var(--border); border-radius: 8px;
                         font-size: 12px; font-weight: 600; background: #fff; color: var(--ink); }
:where(button.pri)     { padding: 6px 14px; border: 0; border-radius: 8px; font-size: 12px; font-weight: 600;
                         background: var(--accent); color: #fff; }
:where(button.ok)      { padding: 6px 14px; border: 0; border-radius: 8px; font-size: 12px; font-weight: 600;
                         background: var(--success); color: #fff; }
:where(button.warning) { padding: 6px 14px; border: 0; border-radius: 8px; font-size: 12px; font-weight: 600;
                         background: var(--warning); color: #fff; }
:where(button.danger)  { padding: 6px 14px; border: 0; border-radius: 8px; font-size: 12px; font-weight: 600;
                         background: var(--danger); color: #fff; }
:where(button.ghost):hover { background: #f4f1fc; border-color: var(--accent-soft); }
:where(button.pri):hover, :where(button.ok):hover,
:where(button.warning):hover, :where(button.danger):hover { filter: brightness(1.06); }

.blob { position: fixed; border-radius: 50%; filter: blur(70px); opacity: 0.38; z-index: 0; pointer-events: none; }
.blob.b1 { width: 460px; height: 460px; background: #cfc6ec; top: -140px; left: -100px; }
.blob.b2 { width: 420px; height: 420px; background: #cdd9ee; bottom: -130px; right: -90px; }

#bar {
  position: relative; z-index: 2; padding: 10px 16px;
  background: rgba(255,255,255,0.72); backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--border); display: flex;
  justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;
}
#bar .title { font-weight: 700; font-size: 15px; }
#bar .title small { color: var(--accent); font-weight: 600; margin-left: 6px; font-size: 13px; }
#bar .ctrls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
#bar select, #bar input {
  padding: 4px 8px; border: 1px solid var(--border); border-radius: 8px;
  font-size: 12px; background: #fff; color: var(--ink); outline: none; font-family: inherit;
}
#bar input.search { width: 140px; }
#bar button {
  cursor: pointer; padding: 4px 12px; border: 0; border-radius: 8px;
  font-size: 12px; font-weight: 600; background: var(--accent); color: #fff;
}
#bar button.ghost { background: #fff; color: var(--ink); border: 1px solid var(--border); }
#bar .chk { display: flex; align-items: center; gap: 3px; font-size: 11px; color: var(--muted); }

#views {
  position: relative; z-index: 2; padding: 6px 16px; display: flex; gap: 6px;
  background: rgba(255,255,255,0.5); border-bottom: 1px solid var(--border);
}
/* 错误条 / 日志抽屉（全局，任何页签都在） */
.errbar {
  position: relative; z-index: 3; display: flex; align-items: center; gap: 8px;
  padding: 6px 16px; background: #fdf3f3; border-bottom: 1px solid #e8c9c9;
  font-size: 12px; color: #8a4545;
}
.errbar-ico { flex: none; }
.errbar-msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.errbar-msg b { font-weight: 700; }
.errpanel {
  position: relative; z-index: 3; background: #fff; border-bottom: 1px solid var(--border);
  padding: 8px 16px 12px;
}
.errpanel-head { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--muted); margin-bottom: 6px; }
.errpanel-head code { background: #f4f1fc; padding: 1px 6px; border-radius: 4px; color: var(--ink); }
.errpanel-body {
  max-height: 240px; overflow: auto; background: #f7f7fa; border: 1px solid var(--border);
  border-radius: 8px; padding: 8px 10px; font-size: 11px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-all; color: #4a4f5c;
}
#views.batch-on { background: #fffdf5; border-bottom-color: #f0e8d0; }
.vbtn {
  font-size: 12px; cursor: pointer; padding: 4px 14px; border: 1px solid var(--border);
  border-radius: 999px; background: #fff; color: var(--muted); font-weight: 600;
}
.vbtn.on { background: var(--accent); color: #fff; border-color: var(--accent); }

#board {
  flex: 1; display: flex; gap: 12px; padding: 14px;
  align-items: flex-start; overflow-x: auto; min-height: 60vh;
}
#board.pv { flex-direction: column; overflow-x: hidden; align-items: stretch; }

.col {
  background: #fff; border: 1px solid var(--border); border-radius: var(--radius);
  min-width: 240px; padding: 10px; flex: 1; box-shadow: var(--shadow);
}
.col[data-status="待办"] { border-left: 4px solid #9ca3af; }
.col[data-status="进行中"] { border-left: 4px solid #6366f1; background: #fafaff; }
.col[data-status="待验收"] { border-left: 4px solid #f59e0b; background: #fffdf5; }
.col[data-status="完成"] { border-left: 4px solid #10b981; background: #f5fdf8; }
.col[data-status="驳回"] { border-left: 4px solid #ef4444; background: #fdf5f5; }
.col[data-status="草稿"] { border-left: 4px solid #9ca3af; }
.col[data-status="待审批"] { border-left: 4px solid #f59e0b; }
.col.empty { border-style: dashed; opacity: 0.62; box-shadow: none; background: #fbfbfe; }
.col.dragover { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(155,143,196,0.22); background: #f4f1fc; }

.status-label { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; }
.status-dot { width: 10px; height: 10px; border-radius: 50%; }
.col[data-status="进行中"] .status-dot { background: #6366f1; }
.col[data-status="待验收"] .status-dot { background: #f59e0b; }
.col[data-status="完成"] .status-dot { background: #10b981; }
.col[data-status="驳回"] .status-dot { background: #ef4444; }
.col[data-status="待办"] .status-dot { background: #9ca3af; }

.emptyhint { color: var(--muted); font-size: 11px; text-align: center; padding: 16px 0; border: 1px dashed var(--border); border-radius: 10px; margin-top: 2px; }

.col h3 {
  margin: 4px 0 10px; font-size: 13px; color: var(--muted); font-weight: 700;
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
}
.col h3 .n { background: var(--accent-soft); color: #4a4368; border-radius: 999px; padding: 0 8px; font-size: 11px; font-weight: 600; }

.card {
  border: 1px solid var(--border); border-radius: 12px; padding: 8px 10px; margin-bottom: 8px;
  background: #fbfbfe; cursor: pointer; transition: background 0.15s, box-shadow 0.15s;
}
.card:hover { background: #f1eefb; box-shadow: 0 4px 14px rgba(120,110,170,0.14); }
.card.active-t { border-left: 3px solid var(--accent); background: #f4f1fc; }
.card.overdue { border-left: 3px solid var(--danger); background: #faf3f3; }
.card.stale { opacity: 0.52; filter: saturate(0.55); }
.card.stale:hover { opacity: 0.8; filter: none; }
.card.selected {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
  border-left: 4px solid var(--accent);
  background: #f1eefb;
  box-shadow: 0 2px 12px rgba(155, 143, 196, 0.24);
}
.card.dragging { opacity: 0.35; transform: scale(0.97); }

/* 卡片正文预览：两行截断，长文不撑高卡片 */
.card .card-preview {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.5;
  margin: 4px 0 0;
  word-break: break-word;
}
/* 归档任务来源徽标：搜索结果里只有归档任务会带它，一眼区分活跃/归档 */
.card .src-badge {
  display: inline-block;
  font-size: 10px;
  color: #6f6396;
  background: #f0edf9;
  border: 1px solid #ded8f0;
  border-radius: 4px;
  padding: 0 5px;
  margin-top: 4px;
}

/* 详情面板按钮分组：流转（改状态）与操作（不改状态）分开，避免一排按钮堆砌 */
.task-acts { display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
.acts-group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.acts-group .acts-label { font-size: 11px; color: var(--muted); width: 28px; flex: none; letter-spacing: 0.5px; }

/* 任务详情：关联日志反向索引 */
.logs-section { margin-top: 12px; }
.logs-section > label { font-size: 12px; color: var(--muted); display: block; margin-bottom: 5px; }
.task-logs-list { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.task-log-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--border); }
.task-log-item:last-child { border-bottom: none; }
.task-log-main { flex: 1; min-width: 0; }
.task-log-title { font-size: 12.5px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-log-meta { font-size: 11px; color: var(--muted); }
.task-log-done { padding: 3px 9px; font-size: 11.5px; flex: none; }

/* 批量操作条 */
.batch-bar .batch-actions { display: flex; gap: 4px; flex-wrap: wrap; }
.batch-count { font-weight: 600; color: var(--accent); }

/* 任务表单：字段清单驱动，CSS Grid 自动分列 */
.task-modal .tf-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; margin-bottom: 12px; }
.task-modal .tf-field { display: flex; flex-direction: column; min-width: 0; }
.task-modal .tf-field.tf-full { grid-column: 1 / -1; }
.task-modal .tf-field label { font-size: 12px; color: var(--muted); margin-bottom: 3px; }
.task-modal .tf-field input,
.task-modal .tf-field select,
.task-modal .tf-field textarea {
  width: 100%; padding: 6px 9px; border: 1px solid var(--border);
  border-radius: 7px; font-size: 13px; background: #fff; color: var(--ink);
  font-family: inherit;
}
.task-modal .tf-field textarea { resize: vertical; min-height: 52px; }
.task-modal .tf-field textarea.tall { min-height: 130px; }
.task-modal .tf-hint { font-size: 11px; color: var(--muted); margin-top: 2px; }

.card-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.ttl { font-size: 13px; font-weight: 600; line-height: 1.4; }
.batch { display: inline-block; background: var(--accent-soft); color: #4a4368; border-radius: 6px; font-size: 10px; padding: 1px 6px; margin-right: 5px; font-weight: 600; }
.st { font-size: 10px; padding: 1px 6px; border-radius: 6px; font-weight: 600; white-space: nowrap; }
.st-draft { background: #eceded; color: #7a7f8c; }
.st-review { background: #fef3c7; color: #92400e; }
.st-todo { background: #e0e7ff; color: #3730a3; }
.st-doing { background: #c7d2fe; color: #3730a3; }
.st-verify { background: #fef3c7; color: #92400e; animation: pulse 2s infinite; }
.st-done { background: #d1fae5; color: #065f46; }
.st-reject { background: #fee2e2; color: #991b1b; }

@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

.result-preview { display: block; margin-top: 4px; font-size: 11px; color: var(--muted); }
.ptags { margin-top: 5px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.ptag { background: #eef0fb; color: #5b5478; border-radius: 6px; font-size: 10px; padding: 1px 6px; }

.batch-chk { width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent); margin-right: 6px; flex-shrink: 0; }
.batch-chk:checked { outline: 2px solid var(--accent); outline-offset: 1px; }

/* Overlay */
.overlay { position: fixed; inset: 0; background: rgba(60,65,80,0.32); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 60; }
#modal, #rmodal, #smodal {
  background: #fff; border-radius: 16px; padding: 18px 20px; width: 460px; max-height: 88vh;
  overflow: auto; box-shadow: var(--shadow); border: 1px solid var(--border);
}
#modal h3, #rmodal h3, #smodal h3 { margin: 0 0 12px; font-size: 16px; color: var(--ink); }
#modal label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 3px; font-weight: 600; }
#modal input, #modal select, #modal textarea {
  width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--border);
  border-radius: 8px; font-size: 13px; color: var(--ink); outline: none; font-family: inherit;
}
#modal textarea { height: 64px; resize: vertical; }
#modal textarea.tall { height: 120px; }
#modal .row2 { display: flex; gap: 10px; }
#modal .row2 > div { flex: 1; }
.acts { margin-top: 16px; display: flex; gap: 6px; justify-content: flex-end; }
.acts button { padding: 6px 14px; border: 0; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; }
.acts .pri { background: var(--accent); color: #fff; }
.acts .ok { background: #5e9154; color: #fff; }
.acts .no { background: #c2706f; color: #fff; }
.acts .danger { background: #d98a8a; color: #fff; }
.acts .ghost { background: #eee; color: #333; }

/* Preview modal */
.meta { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.meta .k { font-size: 11px; color: var(--muted); font-weight: 600; }
.meta .v { font-size: 13px; }
.body label { font-size: 11px; color: var(--muted); font-weight: 600; display: block; margin-bottom: 4px; }
.body-text { font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }

/* Project view */
.alertbar { display: flex; align-items: center; gap: 10px; background: #fdf6f6; border: 1px solid #eedcdc; border-radius: 12px; padding: 8px 14px; margin-bottom: 12px; font-size: 12.5px; }
.alertbar .ico { flex: none; }
.alertbar b { color: #8a4343; }
.pvgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; width: 100%; }
.tile { position: relative; background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px 8px 15px; cursor: pointer; transition: box-shadow 0.15s, transform 0.15s; overflow: hidden; box-shadow: var(--shadow); }
.tile:hover { box-shadow: 0 4px 16px rgba(120,110,170,0.16); transform: translateY(-1px); }
.tile::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; border-radius: 4px 0 0 4px; }
.t-active::before { background: #5e9154; }
.t-stuck::before { background: #c2706f; }
.t-dormant::before { background: #b6b2c4; }
.t-idle::before { background: #d9b87a; }
.t-unknown::before { background: #9a95ad; }
.trow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tname { font-size: 13.5px; font-weight: 700; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.thealth { margin-left: auto; flex: none; font-size: 10px; color: var(--muted); }
.tstats { display: flex; gap: 14px; margin-top: 7px; }
.ts { text-align: left; min-width: 0; }
.ts .n { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; color: var(--ink); }
.ts .n.warn { color: #c99a4e; }
.ts .l { font-size: 9.5px; color: var(--muted); }
.tile-add { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; border: 2px dashed var(--border); background: #fafafa; cursor: pointer; transition: all 0.15s; min-height: 140px; }
.tile-add:hover { border-color: var(--accent); background: #f4f1fc; }
.tile-add .add-icon { font-size: 32px; color: var(--muted); font-weight: 300; }
.tile-add .add-text { font-size: 12px; color: var(--muted); font-weight: 600; }

/* Settings */
#smodal { width: 720px; max-height: 86vh; display: flex; flex-direction: column; }
#smodal > .sect:last-of-type { flex: 0 0 auto; }
.ver-row { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.ver-num { font-size: 15px; font-weight: 700; color: var(--ink); font-family: var(--mono, monospace); }
#smodal .sect { border-top: 1px solid var(--border); padding: 14px 0; margin-top: 6px; flex: 0 0 auto; }
#smodal .sect:first-of-type { border-top: 0; padding-top: 0; }
#smodal .sect h4 { margin: 0 0 10px; font-size: 14px; color: var(--accent); }
#smodal .hint { font-size: 11px; color: var(--muted); margin-top: 4px; }
#smodal .hint.logpath { word-break: break-all; color: var(--ink); }
#smodal .sect .pri { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; margin-top: 8px; }
#smodal .sect .ghost { background: #fff; color: var(--ink); border: 1px solid var(--border); border-radius: 8px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; }
.projlist { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.proj-row { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; font-size: 13px; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
.proj-row:hover { background: #f4f1fc; border-color: var(--accent); }
.proj-row-name { font-weight: 600; color: var(--ink); }
.proj-row-id { margin-left: auto; font-size: 11px; color: var(--muted); flex: none; }
.proj-row-desc { width: 100%; font-size: 11px; color: var(--muted); margin-top: 2px; line-height: 1.4; }

/* Toast */
#toast { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 9999; padding: 8px 16px; border-radius: 10px; font-size: 13px; font-weight: 600; box-shadow: 0 8px 24px rgba(0,0,0,0.18); pointer-events: none; opacity: 0; transition: opacity 0.3s, transform 0.3s; max-width: 90vw; text-align: center; }
#toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
#toast.success { background: #e3f1de; color: #3f6b3a; border: 1px solid #bcd4b4; }
#toast.error { background: #f6e2e2; color: #8a4343; border: 1px solid #e2c4c4; }
#toast.info { background: #eef0fb; color: #5b5478; border: 1px solid #c3bce0; }

/* Drag status picker */
.drag-status-picker {
  position: fixed; z-index: 999; background: #fff; border: 2px solid var(--accent);
  border-radius: 16px; padding: 16px 14px; box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  display: flex; flex-direction: column; gap: 6px;
}
.drag-status-picker .sp-title { font-size: 13px; font-weight: 700; color: var(--accent); margin-bottom: 8px; text-align: center; }
.sp-bucket {
  display: flex; align-items: center; gap: 8px; padding: 8px 14px; border: 1px solid var(--border);
  border-radius: 10px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s;
}
.sp-bucket:hover, .sp-bucket.dragover { background: #f4f1fc; border-color: var(--accent); box-shadow: 0 0 0 2px rgba(155,143,196,0.22); }
.sp-dot { width: 12px; height: 12px; border-radius: 50%; flex: none; }

/* Launchpad */
.launchpad { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
.lp-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; flex-wrap: wrap; gap: 8px; }
.lp-header h3 { font-size: 16px; font-weight: 700; }
.lp-ctrls { display: flex; gap: 6px; }
.lp-ctrls button { padding: 5px 12px; border: 0; border-radius: 8px; font-size: 12px; font-weight: 600; background: var(--accent); color: #fff; cursor: pointer; }
.lp-ctrls button.ghost { background: #fff; color: var(--ink); border: 1px solid var(--border); }
.lp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.lp-card { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 12px; display: flex; align-items: center; gap: 10px; cursor: pointer; transition: box-shadow 0.15s, transform 0.15s; box-shadow: var(--shadow); }
.lp-card:hover { box-shadow: 0 4px 16px rgba(120,110,170,0.16); transform: translateY(-1px); }
.lp-icon { width: 36px; height: 36px; border-radius: 8px; background: var(--accent-soft); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; flex: none; }
.lp-info { flex: 1; min-width: 0; }
.lp-name { font-size: 13px; font-weight: 600; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-desc { font-size: 10.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-launch { padding: 4px 10px; background: var(--accent); color: #fff; border: 0; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; flex: none; }
.app-path-hint { margin-top: 6px; font-size: 11px; color: var(--muted); line-height: 1.5; }
#app-edit-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 400px; box-shadow: var(--shadow); border: 1px solid var(--border); }
#app-edit-modal h3 { margin: 0 0 12px; font-size: 16px; }
#app-edit-modal label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 3px; font-weight: 600; }
#app-edit-modal input { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; color: var(--ink); outline: none; font-family: inherit; }

/* Markdown body */
.body-text.markdown { font-size: 12.5px; line-height: 1.65; }
.body-text.markdown h3 { font-size: 13px; margin: 8px 0 4px; color: var(--ink); }
.body-text.markdown ul { padding-left: 18px; margin: 4px 0; }
.body-text.markdown li { margin-bottom: 2px; list-style: disc; }
.body-text.markdown li.check-item { list-style: none; margin-left: -18px; display: flex; align-items: center; gap: 5px; }
.body-text.markdown li.check-item input[type="checkbox"] { width: 14px; height: 14px; accent-color: var(--accent); }
.body-text.markdown code { background: #eee; padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }
.body-text.markdown strong { color: var(--ink); }
.body-text.markdown br { display: block; content: ""; margin: 3px 0; }

/* Search checkbox */
#bar .chk { display: flex; align-items: center; gap: 3px; font-size: 11px; color: var(--muted); white-space: nowrap; }
#bar .chk input { width: 14px; height: 14px; accent-color: var(--accent); }



/* 解析失败提示：任务文件坏掉时必须在界面上可见，不能静默跳过 */
.parse-warn { font-size: 11px; color: var(--danger); background: #fff; border: 1px solid #eedcdc; border-radius: 6px; padding: 3px 8px; margin-left: 10px; cursor: pointer; white-space: nowrap; flex: none; }
.parse-warn:hover { background: #fce4e4; }

/* Batch bar：悬浮在内容区顶部居中（点击右上角☑按钮后出现在视线附近），带阴影 */
/* 批量操作栏：贴视口底部居中悬浮。
   此前固定 top:96px 压在列表头几行上，且离刚点的 ☑ 很远 —— 用户反馈"位置总是很奇怪"。
   改到底部后不遮内容，且始终在视线下方。 */
.batch-bar {
  position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); z-index: 40;
  display: flex; align-items: center; gap: 8px; padding: 8px 16px;
  background: #fffdf5; border: 1px solid #f0e8d0; border-radius: 12px;
  box-shadow: 0 8px 24px rgba(90,90,130,0.18); font-size: 12px; flex-wrap: wrap;
  max-width: calc(100vw - 32px);
}
/* 批量栏出现时给内容区留底部空间，避免遮住最后一条 */
#app:has(.batch-bar) #board { padding-bottom: 84px; }
/* 左上角返回按钮：紧贴标题右侧（后续高频按钮也放这一带） */
.nav-back { margin-left: 4px; padding: 2px 10px; font-size: 12px; }
.batch-count { font-weight: 600; color: var(--ink); flex: none; }
.batch-actions { display: flex; gap: 4px; flex-wrap: wrap; }
.batch-actions button { padding: 4px 12px; font-size: 11px; background: #fff; color: var(--ink); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-weight: 600; white-space: nowrap; flex-shrink: 0; }
.batch-actions button:hover { background: #f4f1fc; border-color: var(--accent); }
.batch-actions button.danger { background: #fce4e4; color: var(--danger); border-color: #eedcdc; }
.batch-actions button.danger:hover { background: #f8d7d7; }

.batch-mode-btn.active { background: var(--accent) !important; color: #fff !important; box-shadow: inset 0 0 0 2px rgba(255,255,255,0.3); }

.batch-bar .ghost { padding: 4px 12px; font-size: 11px; background: #fff; color: var(--ink); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; flex: none; }


.nq-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; background: var(--accent-soft); color: var(--accent); border-radius: 6px; font-size: 10px; font-weight: 700; margin-left: 8px; }

/* Blockers view */
.blockers-view { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
.blockers-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.blockers-header h3 { font-size: 16px; font-weight: 700; }
.blockers-count { font-size: 12px; color: var(--muted); }
.blocker-chains { display: flex; flex-direction: column; gap: 12px; }
.chain-card { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; box-shadow: var(--shadow); }
.chain-main { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.chain-id { font-size: 11px; color: var(--muted); background: var(--bg); padding: 2px 6px; border-radius: 4px; }
.chain-title { font-weight: 600; flex: 1; }
.chain-arrow { font-size: 11px; color: var(--muted); padding: 4px 0; text-align: center; }
.chain-blockers { display: flex; flex-wrap: wrap; gap: 8px; }
.chain-blocker { display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: #faf3f3; border: 1px solid #eedcdc; border-radius: 8px; font-size: 12px; }
.chain-blocker.done { background: #f0f7ee; border-color: #d4e8d0; opacity: 0.7; }
.cb-status { font-weight: 700; }
.chain-blocker .cb-status { color: var(--danger); }
.chain-blocker.done .cb-status { color: var(--success); }
.cb-id { font-size: 10px; color: var(--muted); }
.cb-title { font-weight: 500; }

.add-note-btn { background: none; border: 1px dashed var(--border); border-radius: 6px; padding: 4px 8px; font-size: 11px; color: var(--muted); cursor: pointer; width: 100%; }
.add-note-btn:hover { border-color: var(--accent); color: var(--accent); }



.plan-title { font-size: 13px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-status { font-size: 10px; padding: 1px 6px; border-radius: 6px; font-weight: 600; white-space: nowrap; }

/* Edit modal */
.deadline { color: var(--muted); font-size: 11px; }
.dp-item { background: var(--bg); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; border: 1px solid var(--border); }
.dp-item.dp-decided { background: #f0f7ee; border-color: #d4e8d0; }
.dp-item.dp-skipped { opacity: 0.6; }
.dp-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.dp-id { font-size: 11px; color: var(--muted); }
.dp-status-badge { font-size: 9px; padding: 1px 5px; border-radius: 4px; font-weight: 700; }
.dp-status-badge.dp-pending { background: #fef3c7; color: #92400e; }
.dp-status-badge.dp-decided { background: #d1fae5; color: #065f46; }
.dp-status-badge.dp-skipped { background: #eceded; color: #7a7f8c; }
.dp-question { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
.dp-options { display: flex; gap: 6px; flex-wrap: wrap; }
.dp-options button { padding: 4px 10px; font-size: 11px; background: #fff; color: var(--ink); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
.dp-options button:hover { background: #f4f1fc; border-color: var(--accent); }
.dp-chosen { font-size: 11px; color: var(--success); font-weight: 500; }

/* Notification system */


/* Empty state */
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; gap: 12px; }
.empty-icon { font-size: 36px; opacity: 0.5; }
.empty-text { font-size: 13px; color: var(--muted); }

/* Archive hint */
.archive-hint { margin: 8px 16px; padding: 8px 12px; background: #fffdf5; border: 1px solid #f0e8d0; border-radius: 10px; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #7a6f4a; position: relative; z-index: 2; }
.archive-hint button { padding: 4px 10px; background: var(--accent); color: #fff; border: 0; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 600; flex: none; }

/* Roadmap view */
.roadmap-view { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
.roadmap-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.roadmap-header h3 { font-size: 16px; font-weight: 700; }
.roadmap-ctrls { display: flex; gap: 6px; }
.roadmap-ctrls button { padding: 5px 12px; border: 0; border-radius: 8px; font-size: 12px; font-weight: 600; background: var(--accent); color: #fff; cursor: pointer; }
.roadmap-ctrls button.ghost { background: #fff; color: var(--ink); border: 1px solid var(--border); }
.roadmap-content { display: flex; flex-direction: column; gap: 14px; }
.roadmap-project { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; box-shadow: var(--shadow); }
.rp-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.rp-name { font-size: 14px; font-weight: 700; flex: 1; }
.rp-batches { display: flex; flex-direction: column; gap: 8px; }
.rp-batch { background: var(--bg); border-radius: 8px; padding: 8px 10px; border-left: 4px solid #9ca3af; }
.rp-batch.rb-active { border-left-color: #6366f1; background: #fafaff; }
.rp-batch.rb-completed { border-left-color: #10b981; background: #f5fdf8; }
.rp-batch.rb-blocked { border-left-color: #ef4444; background: #fdf5f5; }
.rb-header { display: flex; justify-content: space-between; font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.rb-count { color: var(--muted); }
.rb-tasks { display: flex; flex-wrap: wrap; gap: 6px; }
.rb-task { display: flex; align-items: center; gap: 4px; font-size: 11px; }
.rb-title { color: var(--ink); }
.rp-next { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px; }
.rp-next label { font-size: 11px; color: var(--muted); font-weight: 600; }
.rp-actions { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
.rp-action { font-size: 12px; display: flex; align-items: center; gap: 6px; }

/* Progress bar */
.progress-bar { height: 4px; background: var(--bg); border-radius: 2px; overflow: hidden; margin: 4px 0; }
.progress-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.3s; }

/* Due filter */
#bar select.due-filter { width: 90px; }

/* Archived card */
.card._archived { opacity: 0.55; filter: saturate(0.5); }
.card._archived:hover { opacity: 0.85; filter: none; }

/* Warning button (archive) */
.acts .warning { background: #f0a83a; color: #fff; }

/* Wizard */
.wizard-overlay { z-index: 100; }
.wizard { background: #fff; border-radius: 18px; padding: 28px 32px; width: 560px; max-width: 90vw; box-shadow: 0 12px 48px rgba(90,90,130,0.2); border: 1px solid var(--border); }
.wizard-header { margin-bottom: 20px; }
.wizard-header h2 { font-size: 20px; color: var(--ink); margin: 0; }
.wizard-step-indicator { font-size: 12px; color: var(--muted); margin-top: 4px; }
.wizard-desc { font-size: 14px; color: var(--ink); margin: 0 0 16px; }
.wizard-field { margin-bottom: 16px; }
.wizard-field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; font-weight: 600; }
.wizard-input-row { display: flex; gap: 8px; }
.wizard-input-row input { flex: 1; padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; color: var(--ink); outline: none; font-family: inherit; background: #fff; }
.wizard-input-row button { flex: none; }
.wizard-hint { display: block; margin-top: 4px; font-size: 11px; color: var(--muted); }
.wizard-options { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
.wizard-option { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; transition: all 0.15s; }
.wizard-option:hover { border-color: var(--accent-soft); }
.wizard-option.selected { border-color: var(--accent); background: #f4f1fc; }
.wizard-option input { margin-top: 2px; }
.wizard-option strong { display: block; font-size: 13px; color: var(--ink); }
.wizard-option small { display: block; font-size: 11px; color: var(--muted); margin-top: 2px; }
.wizard-summary { background: var(--bg); border-radius: 10px; padding: 14px 16px; }
.wizard-summary-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.wizard-summary-row:last-child { border-bottom: 0; }
.wizard-summary-row span:first-child { color: var(--muted); }
.wizard-summary-row code { background: #eee; padding: 2px 6px; border-radius: 4px; font-size: 11px; }
.wizard-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 24px; }
.wizard-footer-right { margin-left: auto; }

/* ── 备份 v2 ─────────────────────────────────────────────────────── */
.backup-btn { position: relative; }
.backup-btn.bk-bad { border-color: #e2c4c4; background: #fdf5f5; }
.backup-btn.bk-ok { border-color: #bcd4b4; }
.bk-alert-dot { position: absolute; top: 1px; right: 1px; width: 7px; height: 7px; border-radius: 50%; background: #c96a6a; box-shadow: 0 0 0 2px #fff; }
.bk-spin { display: inline-block; animation: bk-rot 1s linear infinite; }
@keyframes bk-rot { to { transform: rotate(360deg); } }

.backup-sect .bk-status { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12.5px; margin-bottom: 10px; background: #fafafd; }
.bk-status .bk-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.bk-status.bk-ok .bk-dot { background: #5e9154; }
.bk-status.bk-bad .bk-dot { background: #c96a6a; }
.bk-status.bk-running .bk-dot { background: #d9a44a; animation: bk-pulse 1.2s ease-in-out infinite; }
@keyframes bk-pulse { 50% { opacity: 0.35; } }
.bk-status .bk-next { margin-left: auto; color: var(--muted); font-size: 11.5px; }
.bk-err-line { font-size: 12px; color: #8a4343; background: #fdf5f5; border: 1px solid #eedcdc; border-radius: 6px; padding: 6px 10px; margin-bottom: 10px; word-break: break-all; }

.bk-grid { display: grid; grid-template-columns: 92px 1fr; gap: 8px 10px; align-items: center; margin-bottom: 12px; }
.bk-grid > label { font-size: 12.5px; color: var(--muted); }
.bk-grid input:not([type=checkbox]) { width: 100%; padding: 6px 9px; border: 1px solid var(--border); border-radius: 7px; font-size: 12.5px; background: #fff; color: var(--ink); }
.bk-inline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); }
.bk-inline .bk-num { width: 58px; padding: 4px 6px; border: 1px solid var(--border); border-radius: 6px; font-size: 12.5px; }
.bk-cb { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }

.bk-history { margin-top: 12px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.bk-tabs { display: flex; background: #fafafd; border-bottom: 1px solid var(--border); }
.bk-tabs span { flex: 1; text-align: center; padding: 7px; font-size: 12.5px; color: var(--muted); cursor: pointer; }
.bk-tabs span.on { color: var(--ink); background: #fff; font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
.bk-list { max-height: 190px; overflow-y: auto; }
.bk-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--border); }
.bk-item:last-child { border-bottom: none; }
.bk-item-main { flex: 1; min-width: 0; }
.bk-item-name { display: block; font-size: 12.5px; color: var(--ink); font-family: ui-monospace, Consolas, monospace; }
.bk-item-meta { font-size: 11px; color: var(--muted); }
.bk-restore { padding: 3px 9px; font-size: 11.5px; }
.bk-log-toggle { margin-top: 8px; font-size: 12px; }
.bk-log { margin-top: 6px; max-height: 180px; overflow: auto; background: #2f3240; color: #d7dae6; padding: 10px; border-radius: 8px; font-size: 11px; line-height: 1.55; font-family: ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-all; }
.bk-path { flex: 1; min-width: 0; padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; background: #fff; color: var(--ink); }
.bk-mini { padding: 3px 9px; font-size: 11.5px; }
.bk-manual { margin-top: 8px; padding: 8px 10px; border: 1px dashed var(--border); border-radius: 8px; background: #fafafd; }
.bk-manual-label { display: block; width: 100%; font-size: 11.5px; color: var(--muted); margin-bottom: 6px; }
.bk-verify { margin-top: 10px; padding: 9px 11px; border-radius: 8px; font-size: 12.5px; border: 1px solid var(--border); background: #fafafd; }
.bk-verify.ok { background: #e3f1de; border-color: #bcd4b4; color: #3f6b3a; }
.bk-verify.bad { background: #f6e2e2; border-color: #e2c4c4; color: #8a4343; }
.bk-verify-head { font-weight: 600; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.bk-verify-path { font-weight: 400; font-size: 11.5px; color: var(--muted); word-break: break-all; }
.bk-verify-meta { margin-top: 3px; font-size: 11.5px; color: var(--muted); }
.bk-verify-errs { margin: 6px 0 0 16px; font-size: 11.5px; line-height: 1.6; }
.bk-notice { margin-top: 10px; padding: 9px 11px; border: 1px solid #e5dcc4; background: #fdfbf4; border-radius: 8px; font-size: 11.5px; line-height: 1.65; color: #6a6350; }
.bk-notice b { display: block; margin-bottom: 4px; color: #8a7a46; }
.bk-notice ul { margin-left: 16px; }
.bk-notice li { margin-bottom: 2px; }
.bk-notice code { background: #efe9d8; padding: 0 4px; border-radius: 3px; }

/* ── 数据目录迁移模态 ─────────────────────────────────────────────── */
#migrate-modal {
  background: var(--card);
  border-radius: var(--radius);
  padding: 18px 20px;
  width: 560px;
  max-width: 92vw;
  max-height: 86vh;
  overflow-y: auto;
  box-shadow: var(--shadow);
}
#migrate-modal h3 { margin: 0 0 12px; font-size: 16px; color: var(--ink); }
.mg-row { display: flex; gap: 10px; font-size: 12.5px; margin-bottom: 6px; align-items: baseline; }
.mg-row .k { color: var(--muted); flex: none; width: 62px; }
.mg-row .v { color: var(--ink); word-break: break-all; }
.mg-row .v.warn { color: #a8813a; }
.mg-notice {
  margin-top: 12px; padding: 10px 12px;
  border: 1px solid #e5dcc4; background: #fdfbf4; border-radius: 8px;
  font-size: 11.5px; line-height: 1.7; color: #6a6350;
}
.mg-notice b { display: block; margin-bottom: 4px; color: #8a7a46; }
.mg-notice ul { margin-left: 16px; }
.mg-notice code { background: #efe9d8; padding: 0 4px; border-radius: 3px; }
.mg-hint { margin-top: 5px; color: #8a8270; }

/* ── 新建规划 / 新建项目模态 ──────────────────────────────────────── */
#plan-new-modal,
#proj-new-modal {
  background: var(--card);
  border-radius: var(--radius);
  padding: 18px 20px;
  width: 470px;
  max-width: 92vw;
  max-height: 86vh;
  overflow-y: auto;
  box-shadow: var(--shadow);
}
#plan-new-modal h3,
#proj-new-modal h3 { margin: 0 0 10px; font-size: 16px; color: var(--ink); }
#plan-new-modal label,
#proj-new-modal label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
#plan-new-modal input,
#plan-new-modal textarea,
#plan-new-modal select,
#proj-new-modal input {
  width: 100%; padding: 7px 10px;
  border: 1px solid var(--border); border-radius: 7px;
  font-size: 13px; background: #fff; color: var(--ink);
  font-family: inherit;
}
#plan-new-modal textarea { resize: vertical; min-height: 66px; }
#plan-new-modal .hint,
#proj-new-modal .hint { margin-top: 10px; font-size: 11px; color: var(--muted); line-height: 1.6; }
#proj-new-modal code { background: #eee; padding: 0 4px; border-radius: 3px; }
.req { color: var(--danger); }

/* Policy（方针区） */
.policy-list { display: flex; flex-direction: column; gap: 4px; }
.policy-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; }
.policy-row:hover { border-color: var(--accent); }
.policy-name { flex: 1; font-size: 12px; font-weight: 600; }
.policy-state { font-size: 10px; color: var(--muted); border: 1px solid var(--border); padding: 1px 6px; border-radius: 8px; }
.policy-state.has { color: #5e9154; border-color: #5e9154; }
/* 项目卡上的方针入口：卡内全宽小按钮，颜色弱化，不抢主统计的视线 */
.pv-policy { margin-top: 8px; width: 100%; font-size: 11px; padding: 4px 8px; border-radius: 8px; }
#policy-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 560px; max-height: 88vh; overflow-y: auto; box-shadow: var(--shadow); border: 1px solid var(--border); }
/* 方针弹窗必须盖在设置面板之上：两者都用 .overlay（z-index:60），而设置面板在 DOM 里更靠后，
   同层级下后出现的赢 —— 于是从设置里点方针，弹窗被设置整个盖住（用户 2026-09-25 第 3 条）。
   给方针overlay 一个更高的层级，任何入口点进来都看得见。 */
#policy-overlay { z-index: 90; }
#policy-modal h3 { margin: 0 0 12px; font-size: 16px; }
#policy-modal label { font-size: 11px; color: var(--muted); margin: 8px 0 4px; display: block; }
#policy-modal textarea { width: 100%; box-sizing: border-box; min-height: 56px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; resize: vertical; }

/* 任务卡右键菜单 */
.ctx-backdrop { position: fixed; inset: 0; z-index: 60; }
.ctx-menu { position: fixed; z-index: 61; min-width: 172px; background: #fff; border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 10px 30px rgba(30,30,60,.18); padding: 4px; }
.ctx-title { padding: 6px 10px 4px; color: var(--muted); font-size: 11px; border-bottom: 1px solid var(--border); margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
.ctx-menu button { display: block; width: 100%; text-align: left; padding: 6px 10px; background: none; border: 0; border-radius: 6px; cursor: pointer; font-size: 12.5px; color: var(--ink); font-family: inherit; }
.ctx-menu button:hover { background: #f4f1fc; }
.ctx-menu button.danger { color: var(--danger); }
.ctx-menu button.danger:hover { background: #fce4e4; }
.ctx-sep { height: 1px; background: var(--border); margin: 4px 0; }

/* 阻塞选择器（任务表单） */
.blk-picked { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 5px; min-height: 22px; align-items: center; }
.blk-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 2px 4px 2px 8px; background: var(--accent-soft); color: var(--accent); border-radius: 999px; }
.blk-x { background: none; border: 0; cursor: pointer; color: inherit; font-size: 13px; line-height: 1; padding: 0 3px; border-radius: 50%; }
.blk-x:hover { background: rgba(0,0,0,.08); }
.blk-empty { font-size: 11px; color: var(--muted); }
.blk-pick { width: 100%; }
/* 日志视图的拖入提示 */
.logs-view.drop-target { outline: 2px dashed var(--accent); outline-offset: -6px; }


/* Calendar view（视觉对齐老版 board.html） */
/* ⚠ #board 是「横排看板」布局：display:flex + align-items:flex-start。
   column 方向的视图会继承 flex-start，子元素于是按**内容宽度**收缩 ——
   日历格子因此变成一排细长竖条、右边大片空白（用户反复反馈"丑得要死"）。
   非看板视图必须显式改回 stretch。 */
#board.calendar-view,
#board.todos-view,
#board.logs-view,
#board.blockers-view,
#board.launchpad,
#board.roadmap-view { align-items: stretch; }
.calendar-view { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
.calhead { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.calhead .m { font-size: 15px; font-weight: 700; min-width: 120px; }
.cal-hint { font-size: 11px; color: var(--muted); margin-left: auto; }
.calgrid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; width: 100%; }
.caldow { font-size: 11px; color: var(--muted); text-align: center; font-weight: 700; padding: 3px 0; }
.calcell { background: #fff; border: 1px solid var(--border); border-radius: 10px; min-height: 92px; padding: 5px 6px; overflow: hidden; display: flex; flex-direction: column; gap: 3px; transition: border-color .15s, background .15s; }
.calcell.blank { background: transparent; border: 0; }
.calcell.today { border-color: var(--accent); background: #f8f6fe; box-shadow: 0 0 0 2px rgba(155,143,196,.22); }
.calcell.past { background: #fbf7f7; }
.calcell.past .dnum { color: #c4bfd0; }
.calcell.dragover { outline: 2px dashed var(--accent); outline-offset: -2px; background: #f1eefb; }
.dnum { font-size: 11px; color: var(--muted); font-weight: 700; margin-bottom: 1px; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; }
.calcell.today .dnum { color: #fff; background: var(--accent); border-radius: 999px; }
.cev { font-size: 10.5px; background: #f5f4fa; border: 1px solid var(--border); border-radius: 6px; padding: 2px 5px; margin-bottom: 3px; cursor: pointer; display: flex; gap: 4px; align-items: center; overflow: hidden; white-space: nowrap; }
.cev:hover { background: #eef0fb; border-color: var(--accent-soft); }
.cev .pd { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.cev .t { overflow: hidden; text-overflow: ellipsis; }
.calunsched { margin-top: 12px; }
.calunsched h4 { font-size: 12px; color: var(--muted); margin: 0 0 6px; }
.calunsched .items { display: flex; flex-wrap: wrap; gap: 6px; }
.calunsched .cev { background: #fff; border: 1px solid var(--border); min-width: 120px; }

/* ── 日历：时间段色带 + 待办标识（2026-09-22）──────────────────────────
   跨天任务在每一天的格子里各画一段，靠 span-start/mid/end 去掉内侧圆角与外边距，
   横向看起来连续（格子本身有间距，做不到真·一根条形，但语义连续已足够）。 */
.cev.span-start { border-top-right-radius: 0; border-bottom-right-radius: 0; border-right-width: 0; }
.cev.span-mid   { border-radius: 0; border-left-width: 0; border-right-width: 0; }
.cev.span-end   { border-top-left-radius: 0; border-bottom-left-radius: 0; border-left-width: 0; }
.cev.span-start { background: #eeeafa; }
.cev.span-mid   { background: #eeeafa; }
.cev.span-end   { background: #eeeafa; }
.cev.cev-todo { background: #eef4fd; border-color: #d5e3f7; }
.cev.cev-todo:hover { background: #e3eefc; border-color: #a9c8ee; }
.cev.cev-log { background: #f3f0fa; border-color: #e0daf5; }
.cev.cev-log:hover { background: #ece8f8; border-color: #c4b8e8; }
.calunsched .cev.chip { cursor: grab; }
.calunsched .cev.chip.other { background: #fbf7f1; border-color: #efdfc8; color: #8a7040; }
.cal-hint-inline { font-size: 10.5px; color: var(--accent); margin-left: 6px; font-weight: 500; }
.cal-other-head { margin-top: 12px !important; }
.cal-empty { font-size: 11px; color: var(--muted); }
.cal-chk { margin-left: 8px; }

#cal-assign-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 420px; box-shadow: var(--shadow); border: 1px solid var(--border); }
#cal-assign-modal h3 { margin: 0 0 8px; font-size: 16px; }
#cal-assign-modal .ca-title { font-size: 13px; font-weight: 600; color: var(--ink); background: #f4f1fc; border-radius: 8px; padding: 6px 10px; margin-bottom: 6px; }
#cal-assign-modal label { display: block; font-size: 11px; font-weight: 600; color: var(--muted); margin: 10px 0 4px; }
#cal-assign-modal input[type="date"] { width: 100%; box-sizing: border-box; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }
#cal-assign-modal .ca-quick { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
#cal-assign-modal .acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.todo-due { font-size: 10px; color: #3f6fa8; background: #eef4fd; border: 1px solid #d5e3f7; padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
.todo-assign { background: none; border: 0; cursor: pointer; color: var(--muted); font-size: 12px; padding: 0 4px; border-radius: 4px; flex: none; }
.todo-assign:hover { color: var(--accent); background: #f4f1fc; }

/* Todos view */
.todos-view { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
.todos-view.drop-target { outline: 2px dashed var(--accent); outline-offset: -6px; }
/* 拖放提示统一为「固定悬浮层」：text-align/padding 那套会参与文档流，
   一出现就把下方内容顶下去 → 光标相对内容位移 → dragleave/dragover 自激闪烁
   （用户第 5 条「抖动、不能稳定显示」的真因）。固定定位 + pointer-events:none 根治。 */
.todo-drop-hint, .log-drop-hint, .drop-hint {
  position: fixed; left: 50%; top: 92px; transform: translateX(-50%);
  z-index: 60; pointer-events: none;
  background: rgba(155,143,196,.97); color: #fff;
  border-radius: 999px; padding: 8px 18px;
  font-size: 12px; font-weight: 700; white-space: nowrap;
  box-shadow: 0 8px 24px rgba(90,90,130,.28);
}
.drop-hint.global { background: rgba(107,113,128,.97); }
.todo-project { font-size: 10px; color: var(--muted); background: var(--bg); border: 1px solid var(--border); padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
.todos-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.todos-header h3 { font-size: 16px; font-weight: 700; }
.todos-ctrls { display: flex; gap: 8px; align-items: center; }
.todo-input { width: 320px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }
.todo-input::placeholder { color: #9ca3af; font-size: 10.5px; }
.todo-filter { padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }
.todos-list { display: flex; flex-direction: column; gap: 6px; }
.todo-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #fff; border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); transition: background 0.15s; }
.todo-item:hover { background: #f4f1fc; }
.todo-item.prio { border-left: 3px solid var(--danger); }
.todo-item.done { opacity: 0.5; }
.todo-item.done .todo-title { text-decoration: line-through; }
.todo-chk { width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent); flex-shrink: 0; }
.todo-title { flex: 1; font-size: 13px; font-weight: 500; }
.todo-prio { font-size: 10px; padding: 1px 6px; border-radius: 6px; background: #fee2e2; color: #991b1b; font-weight: 600; }
.todo-del { background: none; border: 0; cursor: pointer; color: var(--muted); font-size: 14px; padding: 0 4px; border-radius: 4px; }
.todo-del:hover { color: var(--danger); background: #fce4e4; }

/* Logs view */
.logs-view { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
.logs-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.logs-header h3 { font-size: 16px; font-weight: 700; }
.logs-ctrls { display: flex; gap: 8px; align-items: center; }
.log-search { width: 240px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }
.log-search::placeholder { color: #9ca3af; font-size: 10.5px; }
.log-filter { padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }
.logs-list { display: flex; flex-direction: column; gap: 8px; }
.log-card { padding: 10px 14px; background: #fff; border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); transition: background 0.15s; cursor: pointer; }
.log-card:hover { background: #f4f1fc; }
.log-card.active { border-left: 3px solid #6366f1; }
.log-card.completed { opacity: 0.7; border-left: 3px solid #5e9154; }
.log-card.archived { opacity: 0.5; border-left: 3px solid #b6b2c4; }
.log-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.log-status-badge { font-size: 10px; padding: 1px 6px; border-radius: 6px; font-weight: 600; }
.log-status-badge.active { background: #dbeafe; color: #1d4ed8; }
.log-status-badge.completed { background: #dcfce7; color: #166534; }
.log-status-badge.archived { background: #f3f4f6; color: #6b7280; }
.log-card-title { flex: 1; font-size: 13px; font-weight: 600; }
.log-card-date { font-size: 10.5px; color: var(--muted); }
.log-card-body { font-size: 12px; color: var(--muted); margin-bottom: 6px; line-height: 1.4; }
.log-card-meta { display: flex; gap: 10px; font-size: 10.5px; color: var(--muted); }
.log-project { font-size: 10px; color: var(--muted); background: var(--bg); border: 1px solid var(--border); padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
.log-task { color: var(--accent); }
.log-completed { color: #5e9154; }
.log-agent { color: #8b7fb8; }
.log-session { color: #6b7a99; font-family: monospace; font-size: 9.5px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-card.selected { border-color: var(--accent); background: #f4f1fc; box-shadow: 0 0 0 2px rgba(100, 80, 200, 0.2); }
.log-card-actions { display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; }

/* Agent 预设列表（2026-09-23） */
.agent-presets-list { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.agent-preset-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; background: #f3f0fa; border: 1px solid #e0daf5; border-radius: 12px; font-size: 11px; color: #6b5b9e; }
.agent-preset-del { background: none; border: 0; cursor: pointer; color: #b0a0d0; font-size: 13px; padding: 0 2px; border-radius: 50%; line-height: 1; }
.agent-preset-del:hover { color: #c96a6a; background: #f0e8e8; }
.agent-presets-add { display: flex; gap: 6px; }
.agent-presets-add input { flex: 1; padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }

/* Log edit modal */
#log-edit-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 560px; max-height: 88vh; overflow-y: auto; box-shadow: var(--shadow); border: 1px solid var(--border); }
#log-edit-modal h3 { margin: 0 0 12px; font-size: 16px; }
#log-edit-modal label { display: block; font-size: 11px; font-weight: 600; color: var(--muted); margin: 10px 0 4px; }
#log-edit-modal input { width: 100%; box-sizing: border-box; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }
#log-edit-modal textarea { width: 100%; box-sizing: border-box; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; font-family: inherit; resize: vertical; line-height: 1.5; }
#log-edit-modal .acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
#log-edit-modal select.logsel {
  width: 100%; box-sizing: border-box; padding: 7px 10px;
  border: 1px solid var(--border); border-radius: 8px;
  font-size: 13px; background: #fff; color: var(--ink); outline: none; font-family: inherit;
}
#log-edit-modal select.logsel:disabled { background: #f6f6f9; color: var(--muted); }
#log-edit-modal .log-task-picked { font-size: 11px; color: var(--accent); margin-top: 4px; }

/* Dispatch modal */

/* Review modal */
#review-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 460px; box-shadow: var(--shadow); border: 1px solid var(--border); }
#review-modal h3 { margin: 0 0 12px; font-size: 16px; }
.review-info { margin-bottom: 12px; }
.review-task-title { font-size: 14px; font-weight: 700; }
.review-task-id { font-size: 11px; color: var(--muted); }
.review-reason { width: 100%; box-sizing: border-box; min-height: 80px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; font-family: inherit; resize: vertical; line-height: 1.5; }

/* ============ Notification Center（原型 notification-center.html 移植） ============ */
.nc-bell { position: relative; }
.nc-badge {
  position: absolute; top: -4px; right: -4px;
  background: #FF3B30; color: #fff; font-size: 10px; font-weight: 700;
  padding: 1px 5px; border-radius: 99px; min-width: 16px; text-align: center;
  box-shadow: 0 2px 7px rgba(255,59,48,.36);
  animation: nc-pop .5s cubic-bezier(.34,1.4,.64,1) both;
}
@keyframes nc-pop { from { transform: scale(.4); opacity: 0 } to { transform: scale(1); opacity: 1 } }

.nc-wrap {
  position: fixed; inset: 0; z-index: 70;
  background: rgba(30,30,40,.32); backdrop-filter: blur(4px);
  display: flex; align-items: flex-start; justify-content: flex-end;
  padding: 60px 24px 24px;
}
.nc-panel {
  width: 460px; max-width: calc(100vw - 48px); max-height: calc(100vh - 120px);
  background: #fff; border: 1px solid var(--border); border-radius: 16px;
  box-shadow: 0 24px 64px rgba(0,0,0,.18);
  display: flex; flex-direction: column; overflow: hidden;
  animation: nc-in .34s cubic-bezier(.16,1,.3,1) both;
}
@keyframes nc-in { from { opacity: 0; transform: translateY(-10px) scale(.98) } to { opacity: 1; transform: none } }

.nc-head { padding: 16px 18px 0; border-bottom: 1px solid var(--border); }
.nc-head-title h1 { font-size: 17px; font-weight: 700; letter-spacing: -.02em; display: flex; align-items: center; gap: 8px; }
.nc-count {
  background: #FF3B30; color: #fff; font-size: 11px; font-weight: 700;
  padding: 2px 7px; border-radius: 99px; min-width: 20px; text-align: center;
  box-shadow: 0 2px 7px rgba(255,59,48,.36);
}
.nc-head-title p { font-size: 12px; color: var(--muted); margin-top: 4px; }
.nc-head-act { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.nc-icon-btn {
  width: 30px; height: 30px; padding: 0; border-radius: 8px;
  border: 1px solid var(--border); background: rgba(255,255,255,.6); color: var(--muted);
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  font-size: 14px; transition: background .16s, color .16s;
}
.nc-icon-btn:hover { background: #fff; color: var(--ink); }
.nc-icon-btn.spin .nc-ico { display: inline-block; animation: nc-spin .7s cubic-bezier(.16,1,.3,1); }
@keyframes nc-spin { to { transform: rotate(360deg) } }
.nc-btn-primary {
  height: 30px; padding: 0 12px; border-radius: 8px; border: 0;
  background: var(--ink); color: #fff; font-size: 12px; font-weight: 600;
  cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
  font-family: inherit; transition: opacity .16s;
}
.nc-btn-primary:disabled { opacity: .35; cursor: default; }

.nc-filters { display: flex; align-items: center; gap: 12px; padding: 10px 18px; border-bottom: 1px solid var(--border); }
.nc-seg { display: flex; gap: 2px; padding: 3px; border-radius: 9px; background: rgba(0,0,0,.05); }
.nc-seg button {
  border: 0; background: transparent; font-family: inherit; font-size: 12.5px; font-weight: 500;
  color: var(--muted); cursor: pointer; padding: 4px 12px; border-radius: 7px;
  display: inline-flex; align-items: center; gap: 6px; transition: color .2s; white-space: nowrap;
}
.nc-seg button:hover { color: var(--ink); }
.nc-seg button.on { color: var(--ink); background: #fff; font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
.nc-seg .n { font-size: 11px; font-weight: 600; color: var(--muted); }
.nc-seg button.on .n { color: var(--accent); }

.nc-list { flex: 1; overflow-y: auto; padding: 4px 0 8px; }
.nc-item {
  position: relative; display: grid; grid-template-columns: auto 1fr auto;
  gap: 12px; padding: 12px 18px 12px 22px;
  border-bottom: 1px solid rgba(0,0,0,.04); cursor: pointer; overflow: hidden;
  transition: background .18s;
  animation: nc-item-in .4s cubic-bezier(.16,1,.3,1) both;
}
@keyframes nc-item-in { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
.nc-item:hover { background: rgba(0,0,0,.028); }
.nc-item.unread { background: rgba(155,143,196,.06); }
.nc-item.unread:hover { background: rgba(155,143,196,.11); }
.nc-item.unread::before {
  content: ''; position: absolute; left: 10px; top: 20px;
  width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
  box-shadow: 0 0 0 3.5px rgba(155,143,196,.15);
}
.nc-av {
  width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0; color: #fff;
  display: flex; align-items: center; justify-content: center; font-size: 16px;
  box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 3px 9px rgba(0,0,0,.08);
  transition: transform .3s cubic-bezier(.34,1.4,.64,1);
}
.nc-item:hover .nc-av { transform: scale(1.06); }
.nc-av-system { background: linear-gradient(140deg,#9b8fc4,#6d5fa8); }
.nc-av-calendar { background: linear-gradient(140deg,#FF2D55,#C41E3A); }
.nc-av-task { background: linear-gradient(140deg,#34C759,#2AA148); }
.nc-av-approve { background: linear-gradient(140deg,#FF9500,#D97706); }
.nc-av-security { background: linear-gradient(140deg,#FF3B30,#C41E3A); }
.nc-av-storage { background: linear-gradient(140deg,#FFCC00,#FF9500); }

.nc-body { min-width: 0; display: flex; flex-direction: column; gap: 3px; padding-top: 1px; }
.nc-meta { display: flex; align-items: center; gap: 7px; }
.nc-tag { font-size: 10.5px; font-weight: 600; padding: 1.5px 6.5px; border-radius: 5px; white-space: nowrap; }
.nc-t-system { color: #6d5fa8; background: rgba(155,143,196,.15); }
.nc-t-calendar { color: #C41E3A; background: rgba(255,45,85,.12); }
.nc-t-task { color: #1E8E3E; background: rgba(52,199,89,.15); }
.nc-t-approve { color: #B26700; background: rgba(255,149,0,.15); }
.nc-t-security { color: #C41E3A; background: rgba(255,59,48,.12); }
.nc-t-storage { color: #9A6B00; background: rgba(255,204,0,.2); }
.nc-prio {
  font-size: 9.5px; font-weight: 700; letter-spacing: .05em;
  color: #fff; background: #FF3B30; padding: 1.5px 5.5px; border-radius: 5px;
}
.nc-row1 { display: flex; align-items: baseline; gap: 9px; }
.nc-title {
  font-size: 13px; font-weight: 600; line-height: 1.4; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.nc-item.read .nc-title { color: var(--muted); font-weight: 500; }
.nc-time { font-size: 11px; color: var(--muted); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.nc-content {
  font-size: 12.5px; color: var(--ink); line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  word-break: break-all;
}
.nc-item.read .nc-content { color: var(--muted); }

.nc-acts {
  display: flex; align-items: center; gap: 4px; flex-shrink: 0; align-self: center; padding-left: 6px;
  opacity: 0; transform: translateX(7px); pointer-events: none;
  transition: opacity .2s, transform .24s;
}
.nc-item:hover .nc-acts, .nc-item:focus-within .nc-acts { opacity: 1; transform: none; pointer-events: auto; }
.nc-act {
  width: 27px; height: 27px; border-radius: 7px; border: 0; background: transparent;
  color: var(--muted); cursor: pointer; display: flex; align-items: center; justify-content: center;
  font-size: 13px; transition: background .16s, color .16s;
}
.nc-act:hover { background: rgba(0,0,0,.07); color: var(--ink); }
.nc-act.danger:hover { background: rgba(255,59,48,.12); color: #FF3B30; }
.nc-act.keep { color: var(--success); }

.nc-empty { padding: 56px 24px; text-align: center; }
.nc-empty-ic {
  width: 52px; height: 52px; border-radius: 14px; margin: 0 auto 12px;
  background: rgba(0,0,0,.04); color: var(--muted);
  display: flex; align-items: center; justify-content: center; font-size: 24px;
}
.nc-empty h3 { font-size: 14px; font-weight: 600; margin-bottom: 5px; }
.nc-empty p { font-size: 12px; color: var(--muted); line-height: 1.6; }

.nc-foot {
  padding: 10px 18px; border-top: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  background: rgba(255,255,255,.4);
}
.nc-foot .stat { font-size: 12px; color: var(--muted); }
.nc-foot .stat b { color: var(--ink); font-weight: 600; }
.nc-link {
  color: var(--accent); border: 0; background: transparent; cursor: pointer;
  font-size: 12.5px; font-weight: 500; font-family: inherit;
  display: inline-flex; align-items: center; gap: 4px;
}
.nc-link:hover { text-decoration: underline; }

</style>
