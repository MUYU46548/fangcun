<template>
  <div id="app">
    <!-- Decorative blobs -->
    <div class="blob b1"></div>
    <div class="blob b2"></div>

    <!-- Top bar -->
    <header id="bar">
      <span class="title">方寸 tegula<small id="count">{{ tasks.length }}</small></span>
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
        <button class="ghost suggest-btn" @click="openSuggestModal">💡</button>
        <select v-model="dueFilter" class="due-filter">
          <option value="">全部时间</option>
          <option value="overdue">已逾期</option>
          <option value="today">今天到期</option>
          <option value="week">本周到期</option>
        </select>
        <label class="chk"><input type="checkbox" v-model="searchIncludeArchive" /> 含归档</label>
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
        <button class="ghost batch-mode-btn" :class="{ active: batchMode }" @click="toggleBatchMode">
          <span v-if="!batchMode">☑</span>
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

    <!-- Batch action bar -->
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
      <span>📋 归档视图：此处仅显示已完成/驳回的任务。归档操作只能由你亲自判定，不会自动执行。</span>
      <button @click="showArchiveHint = false; localStorage.setItem('fc_archive_hint_seen','1')">知道了</button>
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
          @click="openCard(t)"
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
        </div>
        <div class="tile tile-add" @click="openNewProject">
          <div class="add-icon">+</div>
          <div class="add-text">添加项目</div>
        </div>
      </div>
    </main>

    <!-- Blockers view -->
    <main id="board" class="blockers-view" v-else-if="curView === 'blockers'">
      <div class="blockers-header">
        <h3>阻塞链</h3>
        <span class="blockers-count">{{ blockerChains.length }} 条活跃阻塞链</span>
      </div>
      <div class="blocker-chains">
        <div v-if="!blockerChains.length" class="empty-state">
          <div class="empty-icon">✓</div>
          <div class="empty-text">没有阻塞链 — 所有任务畅通</div>
        </div>
        <div v-for="chain in blockerChains" :key="chain.id" class="chain-card">
          <div class="chain-main">
            <span class="chain-id">{{ chain.id }}</span>
            <span class="chain-title">{{ chain.title }}</span>
            <span class="st" :class="'st-' + statusClass(chain.status)">{{ chain.status }}</span>
          </div>
          <div class="chain-arrow">↓ 等待</div>
          <div class="chain-blockers">
            <div v-for="b in chain.blockers" :key="b.id" class="chain-blocker" :class="{ done: b.isDone }">
              <span class="cb-status">{{ b.isDone ? '✓' : '◌' }}</span>
              <span class="cb-id">{{ b.id }}</span>
              <span class="cb-title">{{ b.title }}</span>
              <span class="st small" :class="'st-' + statusClass(b.status)">{{ b.status }}</span>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- Todos view -->
    <main id="board" class="todos-view" v-else-if="curView === 'todos'">
      <div class="todos-header">
        <h3>待办</h3>
        <div class="todos-ctrls">
          <input
            v-model="todoInput"
            placeholder="快速添加待办（Enter 添加）"
            class="todo-input"
            @keydown.enter="executeTodoAdd"
          />
          <select v-model="todoFilter" class="todo-filter">
            <option value="all">全部</option>
            <option value="active">未完成</option>
            <option value="done">已完成</option>
          </select>
        </div>
      </div>
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
          <span v-if="localPriority(todo.priority) === '高'" class="todo-prio">高</span>
          <button class="todo-del" @click.stop="deleteTodo(todo.id)">×</button>
        </div>
      </div>
    </main>

    <!-- Logs view -->
    <main id="board" class="logs-view" v-else-if="curView === 'logs'">
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
          <button @click="openNewLog">+ 新建日志</button>
          <button class="ghost" @click="executeLogCleanup">清理超期</button>
        </div>
      </div>
      <div class="logs-list">
        <div v-if="!filteredLogs.length" class="empty-state">
          <div class="empty-icon">📋</div>
          <div class="empty-text">暂无执行日志</div>
        </div>
        <div
          v-for="log in filteredLogs"
          :key="log.id"
          class="log-card"
          :class="{ completed: log.status === 'completed', archived: log.status === 'archived' }"
          @click="openLog(log)"
        >
          <div class="log-card-head">
            <span class="log-status-badge" :class="log.status">{{ logStatusLabel(log.status) }}</span>
            <span class="log-card-title">{{ log.title || '(无标题)' }}</span>
            <span class="log-card-date">{{ formatDate(log.created) }}</span>
          </div>
          <div class="log-card-body">{{ truncate(log.content, 120) }}</div>
          <div class="log-card-meta">
            <span v-if="log.project" class="log-project">{{ log.project }}</span>
            <span v-if="log.taskId" class="log-task">📍 {{ log.taskId }}</span>
            <span v-if="log.completed" class="log-completed">✓ {{ formatDate(log.completed) }}</span>
          </div>
          <div class="log-card-actions" @click.stop>
            <button v-if="log.status === 'active'" class="ghost" @click="completeLogItem(log.id)">完成</button>
            <button v-if="log.status !== 'archived'" class="ghost" @click="archiveLogItem(log.id)">归档</button>
            <button class="danger" @click="destroyLogItem(log.id)">销毁</button>
          </div>
        </div>
      </div>
    </main>

    <!-- Notes view -->
    <main id="board" class="notes-view" v-else-if="curView === 'notes'">
      <div class="notes-header">
        <h3>笔记</h3>
        <div class="notes-ctrls">
          <button @click="openNewNote">+ 新建笔记</button>
          <button class="ghost" @click="importNoteFromFile">导入 .md</button>
          <button class="ghost" @click="exportNotesToFile">导出全部</button>
        </div>
      </div>
      <div class="notes-grid">
        <div v-if="!notes.length" class="empty-state">
          <div class="empty-icon">📝</div>
          <div class="empty-text">暂无笔记</div>
        </div>
        <div v-for="note in notes" :key="note.id" class="note-card" @click="openNote(note)">
          <div class="note-card-title">{{ note.title || '(无标题)' }}</div>
          <div class="note-card-content">{{ truncate(note.content, 100) }}</div>
          <div class="note-card-meta">
            <span v-if="note.taskId" class="note-task">📍 {{ note.taskId }}</span>
            <span class="note-date">{{ formatDate(note.updatedAt) }}</span>
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
          <button class="lp-launch" @click.stop="launchAppClick(app)">启动</button>
        </div>
      </div>
    </main>

    <!-- Plans view -->
    <main id="board" class="plans-view" v-else-if="curView === 'plans'">
      <div class="plans-header">
        <h3>规划</h3>
        <button @click="openNewPlan">+ 新建规划</button>
      </div>
      <div class="plans-grid">
        <div v-if="!plans.length" class="empty-state">
          <div class="empty-icon">📋</div>
          <div class="empty-text">暂无规划</div>
        </div>
        <div v-for="plan in plans" :key="plan.id" class="plan-card" @click="openPlan(plan.id)">
          <div class="plan-card-head">
            <span class="plan-title">{{ plan.fm.title || plan.id }}</span>
            <span class="st plan-status" :class="planStatusClass((plan.fm as any).plan_status)">{{ planStatusLabel((plan.fm as any).plan_status) }}</span>
          </div>
          <div class="plan-body-preview">{{ truncate(plan.body, 80) }}</div>
        </div>
      </div>
    </main>

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
          <div v-if="previewTask.deadline"><span class="k">截止</span><span class="v">{{ previewTask.deadline }}</span></div>
          <div v-if="previewTask.batch"><span class="k">批次</span><span class="v">{{ previewTask.batch }}</span></div>
          <div v-if="previewTask.archived"><span class="k">来源</span><span class="v">📦 已归档</span></div>
          <div><span class="k">创建</span><span class="v">{{ formatDate(previewTask.created) }}</span></div>
          <div><span class="k">更新</span><span class="v">{{ formatDate(previewTask.updated) }}</span></div>
        </div>
        <div class="body" v-if="previewTask.body">
          <label>正文</label>
          <div class="body-text markdown" v-html="renderBody(previewTask.body)" @change="onBodyChange"></div>
        </div>
        <div class="notes-section" v-if="previewTask">
          <label>笔记 ({{ taskNotes.length }})</label>
          <div class="notes-list">
            <div v-for="note in taskNotes" :key="note.id" class="note-item">
              <div class="note-item-title">{{ note.title || '(无标题)' }}</div>
              <div class="note-item-content">{{ truncate(note.content, 80) }}</div>
              <button class="note-del" @click.stop="deleteNoteItem(note.id)">×</button>
            </div>
          </div>
          <button class="add-note-btn" @click="openAddNoteForTask(previewTask.id)">+ 添加笔记</button>
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
            <template v-else>
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
              <button
                class="warning"
                title="移入归档视图。仅手动触发，不会自动归档"
                @click="archiveTask(previewTask)"
              >📦 归档</button>
            </template>
          </div>
          <div class="acts-group">
            <span class="acts-label">操作</span>
            <button class="ok" title="编辑任务的全部字段" @click="openEdit(previewTask)">✏️ 编辑</button>
            <button class="ghost" title="复制任务 ID" @click="copyId(previewTask.id)">📋 ID</button>
            <button class="ghost" title="复制一份任务" @click="copyTaskClick(previewTask.id)">📑 副本</button>
            <button class="danger" title="删除任务（会进入 trash，可人工找回）" @click="deleteTask(previewTask.id)">🗑 删除</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Plan detail modal -->
    <div id="plan-detail-overlay" class="overlay" v-if="planDetail_" @click.self="planDetail_ = null">
      <div id="plan-detail-modal">
        <h3>{{ planDetail_.title }}</h3>
        <div class="plan-detail-status">
          <span class="st plan-status" :class="planStatusClass(planDetail_.plan?.status)">{{ planStatusLabel(planDetail_.plan?.status) }}</span>
        </div>
        <div class="plan-detail-section" v-if="planDetail_.plan?.objective">
          <label>目标</label>
          <div>{{ planDetail_.plan.objective }}</div>
        </div>
        <div class="plan-detail-section" v-if="planDetail_.plan?.milestones?.length">
          <label>里程碑 ({{ planDetail_.plan.milestones.length }})</label>
          <ul>
            <li v-for="ms in planDetail_.plan.milestones" :key="ms.name">{{ ms.name }} <span class="deadline">(截止: {{ ms.deadline || '未设定' }})</span></li>
          </ul>
        </div>
        <div class="plan-detail-section" v-if="planDetail_.plan?.decisions?.length">
          <label>决策点 ({{ planDetail_.plan.decisions.length }})</label>
          <div class="dp-list">
            <div v-for="dp in planDetail_.plan.decisions" :key="dp.id" class="dp-item" :class="'dp-' + dp.status">
              <div class="dp-header">
                <span class="dp-id">{{ dp.id }}</span>
                <span class="dp-status-badge" :class="'dp-' + dp.status">{{ dp.status === 'pending' ? '待定' : dp.status === 'decided' ? '已决策' : '跳过' }}</span>
              </div>
              <div class="dp-question">{{ dp.question }}</div>
              <div class="dp-options" v-if="dp.status === 'pending'">
                <button v-for="opt in dp.options" :key="opt" @click="decideDP(planDetail_.id, dp.id, opt)">{{ opt }}</button>
              </div>
              <div v-else class="dp-chosen">已选: {{ dp.chosen }} <span v-if="dp.decidedAt">({{ formatDate(dp.decidedAt) }})</span></div>
            </div>
          </div>
        </div>
        <div class="plan-detail-section" v-if="planDetail_.plan?.risks?.length">
          <label>风险</label>
          <ul><li v-for="r in planDetail_.plan.risks" :key="r">{{ r }}</li></ul>
        </div>
        <div class="acts">
          <button class="ghost" @click="planDetail_ = null">关闭</button>
        </div>
      </div>
    </div>

    <!-- Roadmap view -->
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
        <div class="roadmap-suggestions" v-if="crossSugs && crossSugs.length">
          <h4>跨项目建议</h4>
          <ul><li v-for="s in crossSugs" :key="s">{{ s }}</li></ul>
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

            <select v-if="spec.type === 'select'" v-model="editTask_[spec.key]">
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

    <!-- Note edit modal -->
    <div id="note-edit-overlay" class="overlay" v-if="noteEdit_" @click.self="noteEdit_ = null">
      <div id="note-edit-modal">
        <h3>{{ noteEdit_.id ? '编辑笔记' : '新建笔记' }}</h3>
        <label>标题</label>
        <input v-model="noteEdit_.title" placeholder="笔记标题" />
        <label>内容</label>
        <textarea v-model="noteEdit_.content" class="tall" placeholder="笔记内容..."></textarea>
        <label>关联任务 ID（可选）</label>
        <input v-model="noteEdit_.taskId" placeholder="留空则不关联" />
        <div class="acts">
          <button class="ghost" @click="noteEdit_ = null">取消</button>
          <button v-if="noteEdit_.id" class="danger" @click="deleteNoteItem(noteEdit_.id)">删除</button>
          <button class="pri" @click="saveNoteEdit">{{ noteEdit_.id ? '保存' : '创建' }}</button>
        </div>
      </div>
    </div>

    <!-- Log edit modal -->
    <div id="log-edit-overlay" class="overlay" v-if="logEdit_" @click.self="logEdit_ = null">
      <div id="log-edit-modal">
        <h3>{{ logCompleting ? '完成日志' : logArchiveMode ? '归档日志' : logEdit_.id ? '编辑日志' : '新建日志' }}</h3>
        <label>标题</label>
        <input v-model="logEdit_.title" placeholder="日志标题" />
        <label>项目</label>
        <input v-model="logEdit_.project" placeholder="项目 id" />
        <label>执行内容</label>
        <textarea v-model="logEdit_.content" class="tall" placeholder="执行内容..."></textarea>
        <label>下一步</label>
        <textarea v-model="logEdit_.nextSteps" placeholder="下一步..."></textarea>
        <label>关联任务 ID（可选）</label>
        <input v-model="logEdit_.taskId" placeholder="留空则不关联" />
        <template v-if="logCompleting || logArchiveMode">
          <label v-if="logCompleting">保留天数（0=永不）</label>
          <input v-if="logCompleting" v-model="logRetainDays" placeholder="7" />
          <label>备注（可选）</label>
          <textarea v-model="logNote" placeholder="备注..."></textarea>
        </template>
        <div class="acts">
          <button class="ghost" @click="logEdit_ = null; logCompleting = false; logArchiveMode = false">取消</button>
          <button v-if="logEdit_.id && !logCompleting && !logArchiveMode" class="danger" @click="destroyLogItem(logEdit_.id); logEdit_ = null">销毁</button>
          <button class="pri" @click="saveLogEdit">{{ logCompleting ? '确认完成' : logArchiveMode ? '确认归档' : logEdit_.id ? '保存' : '创建' }}</button>
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

    <!-- New plan modal -->
    <div v-if="planForm" class="overlay" @click.self="planForm = null">
      <div id="plan-new-modal">
        <h3>新建规划</h3>
        <label>标题 <span class="req">*</span></label>
        <input v-model="planForm.title" placeholder="这次要规划什么" />
        <label>目标</label>
        <textarea v-model="planForm.objective" rows="3" placeholder="想达到什么结果"></textarea>
        <label>所属项目</label>
        <select v-model="planForm.project">
          <option value="">未归属</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
        </select>
        <div class="hint">创建后可在规划视图里补充里程碑、决策点与风险。</div>
        <div class="acts">
          <button class="ghost" @click="planForm = null">取消</button>
          <button class="pri" :disabled="planCreating" @click="confirmNewPlan">{{ planCreating ? '创建中…' : '创建' }}</button>
        </div>
      </div>
    </div>

    <!-- New project modal -->
    <div v-if="projForm" class="overlay" @click.self="projForm = null">
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
          <button class="ghost" @click="projForm = null">取消</button>
          <button class="pri" :disabled="projCreating" @click="confirmNewProject">{{ projCreating ? '写入中…' : '登记项目' }}</button>
        </div>
      </div>
    </div>

    <div id="app-edit-overlay" class="overlay" v-if="editApp_" @click.self="editApp_ = null">
      <div id="app-edit-modal">
        <h3>{{ editApp_.isNew ? '添加应用' : '编辑应用' }}</h3>
        <label>名称</label>
        <input v-model="editApp_.name" placeholder="应用名称" />
        <label>路径（exe 或 bat）</label>
        <div style="display:flex;gap:6px;align-items:center;">
          <input v-model="editApp_.path" placeholder="E:/path/to/app.exe" style="flex:1" />
          <button type="button" class="ghost" @click="browseAppPath">浏览…</button>
        </div>
        <label>描述（可选）</label>
        <input v-model="editApp_.description" placeholder="应用描述" />
        <div class="acts">
          <button class="ghost" @click="editApp_ = null">取消</button>
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
          <h4>数据目录</h4>
          <div class="hint">{{ dataDir }}</div>
          <div class="sect-btns">
            <button class="ghost" @click="changeDataDir">修改目录…</button>
            <button class="ghost" @click="openDataDir">打开目录</button>
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
        <div class="sect">
          <h4>💡 AI 建议</h4>
          <div class="sect-btns">
            <button class="pri" @click="openSuggestModal()">打开建议面板</button>
          </div>
          <div class="hint" v-if="curProj !== '__all__'">当前选中项目：{{ getProjName(curProj) }}</div>
          <div class="hint" v-else>当前选中项目：全部（跨项目建议无需选择）</div>
        </div>
        <div class="sect">
          <h4>🎯 项目设计规划</h4>
          <div class="sect-btns">
            <button class="pri" @click="openLlmPlanning">打开规划面板</button>
            <button class="ghost" @click="openLlmConfig">LLM 配置</button>
          </div>
          <div class="hint">支持 audit / decompose / decide-dp / review / roadmap-gen</div>
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

          <div class="sect-btns" style="margin-top: 12px">
            <button class="ghost" @click="exportTasksToFile">导出任务 JSON</button>
            <button class="ghost" @click="importTasksFromFile">导入任务 JSON</button>
            <button class="ghost" @click="exportNotesToFile">导出笔记 JSON</button>
            <button class="ghost" @click="showSettings_ = false">关闭</button>
          </div>
        </div>
      </div>
    </div>



    <!-- Suggestion Modal (direct access from top bar 💡) -->
    <div v-if="suggestModal" class="overlay" @click.self="suggestModal = null">
      <div class="suggest-modal">
        <div class="suggest-header">
          <h3>💡 AI 建议</h3>
          <button class="ghost" @click="suggestModal = null">✕</button>
        </div>
        <div class="suggest-controls">
          <select v-model="suggestProjectId" class="suggest-proj-select">
            <option value="__all__">全部项目（跨项目建议）</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
          </select>
          <button class="pri" :disabled="suggestLoading || suggestProjectId === '__all__'" @click="openSuggestActions">项目建议</button>
          <button class="ghost" :disabled="suggestLoading" @click="openSuggestCrossProject">跨项目建议</button>
        </div>
        <div class="suggest-body">
          <div v-if="!suggestLoading && !suggestError && !suggestResults.length" class="suggest-hint">选择项目后点击「项目建议」，或点击「跨项目建议」获取跨项目建议</div>
          <div v-if="suggestLoading" class="suggest-loading">⏳ 加载中...</div>
          <div v-else-if="suggestError" class="suggest-error">❌ {{ suggestError }}</div>
          <ul v-else-if="suggestResults.length">
            <li v-for="(s, i) in suggestResults" :key="i">{{ s }}</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- LLM Planning Modal -->
    <div v-if="llmPlanning_" class="overlay" @click.self="llmPlanning_ = false">
      <div id="llm-planning-modal">
        <h3>🎯 项目设计规划</h3>
        <div class="hint">选择规划命令并填写参数，调用 LLM 生成结构化建议</div>
        <label>命令</label>
        <select v-model="llmCmd" @change="onLlmCmdChange">
          <option value="audit">audit — 项目健康度审计</option>
          <option value="decompose">decompose — 智能任务拆解</option>
          <option value="decide-dp">decide-dp — 决策支持</option>
          <option value="review">review — 季度复盘</option>
          <option value="roadmap-gen">roadmap-gen — 路线图生成</option>
        </select>

        <!-- Common: project -->
        <label v-if="llmCmd !== 'decide-dp'">项目 ID（可选）</label>
        <select v-model="llmParams.projectId" v-if="['audit', 'decompose', 'review', 'roadmap-gen'].includes(llmCmd)">
          <option value="">全部 / 未指定</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
        </select>

        <!-- decompose: goal -->
        <label v-if="llmCmd === 'decompose'">目标描述 *</label>
        <textarea v-if="llmCmd === 'decompose'" v-model="llmParams.goal" rows="3" placeholder="需要拆解的项目目标…"></textarea>

        <!-- roadmap-gen: goal -->
        <label v-if="llmCmd === 'roadmap-gen'">目标（可选）</label>
        <input v-if="llmCmd === 'roadmap-gen'" v-model="llmParams.goal" placeholder="路线图目标（留空则基于当前任务生成）" />

        <!-- decide-dp: simplified fields -->
        <template v-if="llmCmd === 'decide-dp'">
          <label>问题 *</label>
          <textarea v-model="llmParams.dpQuestion" rows="2" placeholder="需要决策的问题…"></textarea>
          <label>选项（每行一个）*</label>
          <textarea v-model="llmParams.dpOptions" rows="3" placeholder="选项 A&#10;选项 B&#10;选项 C"></textarea>
          <div class="dp-id-row">
            <label>决策点 ID</label>
            <span class="dp-id-auto">{{ llmParams.dpId || '(自动生成)' }}</span>
          </div>
        </template>

        <!-- Model override with chips -->
        <label>模型（可选，留空用全局配置）</label>
        <input v-model="llmParams.model" list="llm-model-history" placeholder="如 gpt-4o-mini" />
        <datalist id="llm-model-history">
          <option v-for="m in modelHistory" :key="m" :value="m" />
        </datalist>
        <div class="model-chips">
          <span class="chip" @click="llmParams.model = 'gpt-4o-mini'">gpt-4o-mini</span>
          <span class="chip" @click="llmParams.model = 'gpt-4o'">gpt-4o</span>
          <span class="chip" @click="llmParams.model = 'deepseek-chat'">deepseek-chat</span>
          <span class="chip" @click="llmParams.model = 'qwen-turbo'">qwen-turbo</span>
          <span class="chip" @click="llmParams.model = 'moonshot-v1-8k'">moonshot-v1-8k</span>
          <span class="chip" @click="llmParams.model = 'claude-3-haiku-20240307'">claude-3-haiku</span>
        </div>

        <div class="acts">
          <button class="ghost" @click="llmPlanning_ = false">取消</button>
          <button class="pri" :disabled="llmRunning" @click="executeLlmCmd">
            {{ llmRunning ? '执行中…' : '▶ 执行' }}
          </button>
        </div>

        <!-- Result -->
        <div v-if="llmResult || llmError || llmRunning" class="llm-result-section">
          <div v-if="llmRunning" class="llm-running">⏳ 正在调用 LLM，请稍候…</div>
          <div v-else-if="llmError" class="llm-error">❌ {{ llmError }}</div>
          <div v-else class="llm-result markdown" v-html="renderLlmMarkdown(llmResult)"></div>
        </div>
      </div>
    </div>

    <!-- LLM Config Modal -->
    <div v-if="llmConfig_" class="overlay" @click.self="llmConfig_ = false">
      <div id="llm-config-modal">
        <h3>LLM 配置</h3>
        <div class="hint">配置 OpenAI 兼容 API（支持 DeepSeek / Moonshot / 通义千问 等）</div>
        <label>Base URL</label>
        <input v-model="llmConfigForm.baseUrl" placeholder="https://api.openai.com/v1" />
        <label>API Key</label>
        <input v-model="llmConfigForm.apiKey" type="password" :placeholder="llmApiKeyPlaceholder" />
        <div v-if="llmKeyHint" class="hint">
          已保存 <code>{{ llmKeyHint }}</code> —— 留空保存表示不修改；只有要换 Key 时才粘贴新的
        </div>
        <label>默认模型</label>
        <input v-model="llmConfigForm.model" placeholder="gpt-4o-mini" />
        <div v-if="llmModelOptions.length" class="hint">
          该 Key 可用：
          <span class="chip" v-for="m in llmModelOptions.slice(0, 8)" :key="m" @click="llmConfigForm.model = m">{{ m }}</span>
        </div>
        <label>超时（秒）</label>
        <input v-model.number="llmConfigForm.timeout" type="number" min="10" max="600" />
        <div class="acts">
          <button class="ghost" @click="llmConfig_ = false">取消</button>
          <button class="ghost" @click="resetLlmConfigInForm">恢复默认</button>
          <button class="ghost" :disabled="llmTestRunning" @click="testLlmConnection">
            {{ llmTestRunning ? '测试中…' : '🔌 测试连接' }}
          </button>
          <button class="pri" @click="saveLlmConfig">保存</button>
        </div>
        <div v-if="llmConfigMsg" :class="'llm-config-msg ' + llmConfigMsgType">{{ llmConfigMsg }}</div>
        <div v-if="llmTestResult" class="llm-test-result">
          <div :class="'llm-config-msg ' + (llmTestResult.ok ? 'success' : 'error')">
            {{ llmTestResult.ok ? '✅ 连接正常' : '❌ 连接失败' }}
          </div>
          <div class="ping-steps">
            <div v-for="(s, i) in (llmTestResult.steps || [])" :key="i" class="ping-step">
              <span class="mark" :class="s.ok ? 'ok' : 'bad'">{{ s.ok ? '✓' : '✗' }}</span>
              <span class="name">{{ s.name }}</span>
              <span v-if="s.status" class="code">{{ s.status }}</span>
              <span class="detail">{{ s.detail }}</span>
              <span class="url">{{ s.url }}</span>
            </div>
          </div>
          <div v-if="llmTestResult.hint" class="llm-config-msg info">{{ llmTestResult.hint }}</div>
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
const showSettings_ = ref(false)
const suggestModal = ref<'actions' | 'cross' | null>(null)
const suggestProjectId = ref<string>('__all__')
const suggestTitle = ref('')
const suggestResults = ref<string[]>([])
const suggestLoading = ref(false)
const suggestError = ref('')

// ── LLM Planning ────────────────────────────────────────────────────
const llmPlanning_ = ref(false)
const llmConfig_ = ref(false)
const llmCmd = ref('audit')
const llmParams = ref<{ projectId: string; goal: string; model: string; dpId: string; dpQuestion: string; dpOptions: string; dpStatus: string }>({
  projectId: '', goal: '', model: '', dpId: '', dpQuestion: '', dpOptions: '', dpStatus: 'pending'
})
const llmRunning = ref(false)
const llmResult = ref('')
const llmError = ref('')
const llmConfigForm = ref({ baseUrl: '', apiKey: '', model: '', timeout: 60 })
const llmConfigMsg = ref('')
const llmConfigMsgType = ref('info')
const llmTestRunning = ref(false)
const llmTestResult = ref<{ ok: boolean; hint?: string; steps?: any[]; models?: string[] } | null>(null)
const llmKeyHint = ref('')
const llmHasApiKey = ref(false)
const llmModelOptions = ref<string[]>([])
const llmApiKeyPlaceholder = computed(() =>
  llmHasApiKey.value ? '留空 = 沿用已保存的 Key' : 'sk-...'
)

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
const modelHistory = ref<string[]>(JSON.parse(localStorage.getItem('tegula_llm_model_history') || '[]'))

const batchMode = ref(false)
const selectedBatch = ref<string[]>([])
const dataDir = ref('')

// ── Todos ─────────────────────────────────────────────────────────
interface Todo {
  id: string
  title: string
  done: boolean
  priority: 'high' | 'normal' | 'low'
  due?: string
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
const noteEdit_ = ref<any>(null)
const blockerChains = ref<any[]>([])
const notes = ref<any[]>([])
const plans = ref<any[]>([])
const planDetail_ = ref<any>(null)
const roadmapData = ref<any>({ projects: [] })
const crossSugs = ref<string[]>([])
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
  { id: 'plans', label: '规划' },
  { id: 'notes', label: '笔记' },
  { id: 'roadmap', label: '路线图' },
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

// ── 数据目录迁移 ─────────────────────────────────────────────────────
const migrateTarget = ref<any>(null)
const migrateBusy = ref(false)

// ── 新建规划 / 新建项目（替代 Electron 未实现的 window.prompt） ────────
const planForm = ref<{ title: string; objective: string; project: string } | null>(null)
const planCreating = ref(false)
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

function switchView(v: string) {
  curView.value = v
  if (v === 'launchpad') {
    loadLaunchpad()
  } else if (v === 'notes') {
    loadNotes()
  } else if (v === 'blockers') {
    loadBlockerChains()
  } else if (v === 'plans') {
    loadPlans()
  } else if (v === 'roadmap') {
    loadRoadmap()
  } else if (v === 'todos') {
    loadTodos()
  } else if (v === 'logs') {
    loadLogs()
  } else {
    loadAll()
  }
}

function planStatusClass(status: string): string {
  return status === 'active' ? 'doing' : status === 'achieved' ? 'done' : status === 'abandoned' ? 'reject' : 'draft'
}

function planStatusLabel(status: string): string {
  return status === 'active' ? '进行中' : status === 'achieved' ? '已完成' : status === 'abandoned' ? '已放弃' : '草稿'
}

async function loadPlans() {
  try {
    plans.value = await window.tegula.listPlans()
  } catch {
    plans.value = []
  }
}

async function loadRoadmap() {
  try {
    const result = await window.tegula.aggregateRoadmap()
    roadmapData.value = result
    crossSugs.value = await window.tegula.suggestCrossProject()
  } catch {
    roadmapData.value = { projects: [] }
    crossSugs.value = []
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
  // also load progress and notes for task preview
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

function openNote(note: any) {
  noteEdit_.value = { ...note }
}

function openNewNote() {
  noteEdit_.value = { title: '', content: '', taskId: '' }
}

/** 新建规划：Electron 未实现 prompt()，旧写法点了没反应，改用自建模态 */
function openNewPlan() {
  planForm.value = {
    title: '',
    objective: '',
    project: curProj.value === '__all__' ? '' : curProj.value,
  }
}

async function confirmNewPlan() {
  const f = planForm.value
  if (!f || planCreating.value) return
  if (!f.title.trim()) {
    showToast('规划标题不能为空', 'error')
    return
  }
  planCreating.value = true
  try {
    const result: any = await window.tegula.createPlan({
      title: f.title.trim(),
      objective: f.objective.trim(),
      project: f.project || undefined,
    })
    if (result && result.ok) {
      showToast('已创建规划', 'success')
      planForm.value = null
      loadPlans()
    } else {
      showToast('创建失败：' + ((result && result.error) || '未知错误'), 'error')
    }
  } catch (e: any) {
    showToast('创建失败：' + (e?.message || '未知错误'), 'error')
  } finally {
    planCreating.value = false
  }
}

async function openPlan(id: string) {
  const result = await window.tegula.getPlan(id)
  if (result) {
    planDetail_.value = { id, title: result.task.fm.title || result.task.id, ...result }
  }
}

async function decideDP(planId: string, dpId: string, choice: string) {
  const result = await window.tegula.decidePlanPoint(planId, dpId, choice)
  if (result.ok) {
    await openPlan(planId)
    await loadPlans()
    showToast(`已决策: ${dpId} = ${choice}`, 'success')
  } else {
    showToast('决策失败', 'error')
  }
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

function closeTaskEditor() {
  editTask_.value = null
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
  if (!confirm('确定删除此任务？')) return
  await window.tegula.deleteTask(id)
  previewTask.value = null
  showToast('已删除', 'success')
  loadAll()
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
  if (!confirm(`确认还原「${t.title}」？\n任务将回到「待办」状态。`)) return
  const result = await window.tegula.moveStatus(t.id, '待办')
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
  const lines = body.split('\n')
  const liText = (li.textContent || '').replace(/^\s+|\s+$/g, '').replace(/^-\s*\[[ x]\]\s*/, '')
  const lineIdx = lines.findIndex(l => {
    const m = l.match(/^- \[[ x]\]\s*(.*)$/)
    return m && m[1].trim() === liText.trim()
  })
  if (lineIdx === -1) return
  const checked = el.checked
  lines[lineIdx] = `- [${checked ? 'x' : ' '}] ${liText}`
  const newBody = lines.join('\n')
  previewTask.value = { ...previewTask.value, body: newBody }
  saveCheckChange(previewTask.value.id, newBody)
}

const _checkSaveTimers: Record<string, number> = {}
/** 待落盘的勾选内容：即使定时器被清掉，这里仍保有最新 body */
const _pendingCheckSaves: Record<string, string> = {}
const taskNotes = ref<any[]>([])

async function loadNotesForTask(taskId: string) {
  try {
    taskNotes.value = await window.tegula.notesForTask(taskId)
  } catch {
    taskNotes.value = []
  }
}

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
    if (r && r.ok === false) {
      showToast('完成失败：' + (r.error || '未知错误'), 'error')
      return
    }
    showToast('日志已完成（保留 7 天）', 'success')
    await loadLogsForTask(previewTask.value?.id || '')
    loadLogs()
  } catch (e: any) {
    showToast('完成失败：' + (e?.message || '未知错误'), 'error')
  }
}

function openAddNoteForTask(taskId: string) {
  noteEdit_.value = { title: '', content: '', taskId }
}

async function saveNoteEdit() {
  const e = noteEdit_.value
  if (!e.title?.trim() && !e.content?.trim()) {
    showToast('标题和内容不能同时为空', 'error')
    return
  }
  try {
    if (e.id) {
      await window.tegula.updateNote(e.id, { title: e.title, content: e.content, taskId: e.taskId || undefined })
      showToast('已更新', 'success')
    } else {
      await window.tegula.createNote({ title: e.title, content: e.content, taskId: e.taskId || undefined })
      showToast('已创建', 'success')
    }
    noteEdit_.value = null
    await loadNotesForTask(e.taskId)
    await loadNotes()
  } catch (err: any) {
    showToast(`保存失败: ${err.message || err}`, 'error')
  }
}

async function deleteNoteItem(noteId: string) {
  if (!confirm('确定删除此笔记？')) return
  await window.tegula.deleteNote(noteId)
  showToast('已删除', 'success')
  await loadNotes()
}

async function importNoteFromFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.md,.txt'
  input.onchange = async (e: any) => {
    const file = e.target.files?.[0]
    if (!file) return
    const result = await window.tegula.importNoteFromFile(file.path)
    if (result.ok) {
      showToast('已导入', 'success')
      loadNotes()
    } else {
      showToast('导入失败', 'error')
    }
  }
  input.click()
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
const filteredTasks = computed(() => {
  if (isNaturalQuery.value && naturalResults.value.length > 0) {
    return naturalResults.value
  }
  let result = [...tasks.value]
  if (searchIncludeArchive.value && archivedTasks.value.length > 0) {
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
    const weekLater = new Date(today.getTime() + 7 * 86400000)
    result = result.filter(t => {
      const due = (t as any).deadline || t.fm.deadline
      if (!due) return false
      const dueDate = new Date(due)
      if (isNaN(dueDate.getTime())) return false
      if (dueFilter.value === 'overdue') return dueDate < today && t.status !== '完成' && t.status !== '驳回'
      if (dueFilter.value === 'today') return dueDate >= today && dueDate < new Date(today.getTime() + 86400000)
      if (dueFilter.value === 'week') return dueDate >= today && dueDate <= weekLater
      return true
    })
  }
  return result
})

function openCard(t: Task) {
  previewTask.value = t
  // 详情面板需要笔记与关联日志。此前 loadNotesForTask 只在"添加笔记"入口调用，
  // 直接点卡片进详情时笔记区长期是空的。
  loadNotesForTask(t.id)
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

const filteredTodos = computed(() => {
  if (todoFilter.value === 'active') return todos.value.filter(t => !t.done)
  if (todoFilter.value === 'done') return todos.value.filter(t => t.done)
  return todos.value
})

async function loadTodos() {
  try {
    todos.value = await window.tegula.todosList()
  } catch {
    todos.value = []
  }
}

async function executeTodoAdd() {
  const text = todoInput.value.trim()
  if (!text) return
  const result = await window.tegula.todosCreate(text, '中')
  if (result.ok) {
    todoInput.value = ''
    showToast('已添加', 'success')
    loadTodos()
  } else {
    showToast('添加失败', 'error')
  }
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
const logEdit_ = ref<any>(null)
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
    logs.value = await window.tegula.logsList(filter)
  } catch {
    logs.value = []
  }
}

function logStatusLabel(status: string): string {
  return { active: '进行中', completed: '已完成', archived: '已归档' }[status] || status
}

function openLog(log: any) {
  logEdit_.value = { ...log }
}

const logCompleting = ref(false)
const logArchiveMode = ref(false)
const logRetainDays = ref('7')
const logNote = ref('')

function openNewLog() {
  const project = projects.value[0]?.id || 'fangcun-base'
  logEdit_.value = { id: '', title: '', project, content: '', nextSteps: '', taskId: '' }
  logCompleting.value = false
  logArchiveMode.value = false
  logRetainDays.value = '7'
  logNote.value = ''
}

/** 从任务详情写一条执行日志：预填 taskId 与项目，省得再手填一遍 */
function openLogForTask(taskId: string) {
  openNewLog()
  logEdit_.value.taskId = taskId
  const t = previewTask.value
  if (t?.project) logEdit_.value.project = t.project
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
        showToast('操作失败', 'error')
        return
      }
    } else if (logArchiveMode.value) {
      const result = await window.tegula.logsArchive(e.id, logNote.value || undefined)
      if (result.ok) {
        showToast('已归档', 'success')
      } else {
        showToast('操作失败', 'error')
        return
      }
    } else if (e.id) {
      await window.tegula.logsUpdate(e.id, { title: e.title, content: e.content, nextSteps: e.nextSteps })
      showToast('已更新', 'success')
    } else {
      await window.tegula.logsCreate(e.title, e.project, e.content, e.taskId || undefined)
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
}

function archiveLogItem(id: string) {
  const log = logs.value.find(l => l.id === id)
  if (!log) return
  logEdit_.value = { ...log }
  logCompleting.value = false
  logArchiveMode.value = true
  logRetainDays.value = '7'
  logNote.value = ''
}

async function destroyLogItem(id: string) {
  if (!confirm('确定销毁此日志？文件将被永久删除。')) return
  const result = await window.tegula.logsDestroy(id)
  if (result.ok) {
    showToast('已销毁', 'success')
    await loadLogs()
  } else {
    showToast('操作失败', 'error')
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

async function executeLogCleanup() {
  try {
    const result = await window.tegula.logsCleanup()
    showToast(result.length ? `已归档 ${result.length} 条超期日志` : '无超期日志', 'info')
    await loadLogs()
  } catch {
    showToast('清理失败', 'error')
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
  // Set effectAllowed for Electron compatibility
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
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
  curView.value = 'active'
}

function openProjectInSettings(p: Project) {
  curProj.value = p.id
  curView.value = 'active'
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
  editApp_.value = { name: '', path: '', description: '', isNew: true }
}

function openEditApp(app: any) {
  editApp_.value = { ...app, isNew: false }
}

async function saveEditApp() {
  const e = editApp_.value
  if (!e.name || !e.path) {
    showToast('名称和路径必填', 'error')
    return
  }
  const app = { name: e.name, path: e.path, cmd: e.path, description: e.description }
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
  try {
    const result = await window.tegula.launchpadLaunchApp(app)
    showToast(result.message, result.ok ? 'success' : 'error')
  } catch {
    showToast('启动失败', 'error')
  }
}

function getProjName(id: string): string {
  const p = projects.value.find(p => p.id === id)
  return p ? (p.name || p.id) : id
}

function openSuggestModal() {
  suggestProjectId.value = curProj.value === '__all__' ? '' : curProj.value
  suggestModal.value = 'actions'
  suggestResults.value = []
  suggestError.value = ''
  suggestLoading.value = false
}

async function openSuggestActions() {
  const proj = suggestProjectId.value
  if (!proj || proj === '__all__') {
    showToast('请先选择具体项目', 'error')
    return
  }
  suggestLoading.value = true
  suggestError.value = ''
  suggestResults.value = []
  try {
    const result = await window.tegula.suggestActions(proj)
    suggestResults.value = result || []
  } catch (e: any) {
    suggestError.value = e.message || '获取建议失败'
  } finally {
    suggestLoading.value = false
  }
}

async function openSuggestCrossProject() {
  suggestLoading.value = true
  suggestError.value = ''
  suggestResults.value = []
  try {
    const result = await window.tegula.suggestCrossProject()
    suggestResults.value = result || []
  } catch (e: any) {
    suggestError.value = e.message || '获取建议失败'
  } finally {
    suggestLoading.value = false
  }
}

// ── Settings / Backup ──────────────────────────────────────────────────

function showSettings() {
  showSettings_.value = true
  // 打开设置时同步备份配置与历史
  bkMsg.value = ''
  bkLoadConfig()
  bkLoadList()
  bkRefreshStatus()
}

// ── LLM Planning ────────────────────────────────────────────────────

function openLlmPlanning() {
  llmPlanning_.value = true
  llmResult.value = ''
  llmError.value = ''
  onLlmCmdChange()
}

function openLlmConfig() {
  llmConfig_.value = true
  llmConfigMsg.value = ''
  llmTestResult.value = null
  llmModelOptions.value = []
  llmKeyHint.value = ''
  window.tegula.llmGetConfig().then((cfg: any) => {
    // apiKey 一律留空回填：把掩码 '***' 填进表单再保存，会把真实密钥覆盖掉（401 的根因）
    llmConfigForm.value = {
      baseUrl: cfg.baseUrl || '',
      apiKey: '',
      model: cfg.model || '',
      timeout: cfg.timeout || 60
    }
    llmHasApiKey.value = !!cfg.hasApiKey
    llmKeyHint.value = cfg.apiKeyHint || ''
  })
}

function onLlmCmdChange() {
  llmParams.value = { projectId: '', goal: '', model: '', dpId: '', dpQuestion: '', dpOptions: '', dpStatus: 'pending' }
  llmResult.value = ''
  llmError.value = ''
}

async function executeLlmCmd() {
  llmRunning.value = true
  llmResult.value = ''
  llmError.value = ''
  try {
    const cmd = llmCmd.value
    const p = llmParams.value
    const model = p.model || undefined
    let result: any

    // Save model to history (deduplicated, max 10)
    if (p.model?.trim()) {
      const m = p.model.trim()
      const idx = modelHistory.value.indexOf(m)
      if (idx !== -1) modelHistory.value.splice(idx, 1)
      modelHistory.value.unshift(m)
      if (modelHistory.value.length > 10) modelHistory.value.pop()
      localStorage.setItem('tegula_llm_model_history', JSON.stringify(modelHistory.value))
    }

    switch (cmd) {
      case 'audit':
        if (!p.projectId) {
          llmError.value = '请选择项目'
          llmRunning.value = false
          return
        }
        result = await window.tegula.llmAudit(p.projectId, model)
        break
      case 'decompose':
        if (!p.goal?.trim()) {
          llmError.value = '请填写目标描述'
          llmRunning.value = false
          return
        }
        result = await window.tegula.llmDecompose(p.goal, p.projectId || undefined, model)
        break
      case 'decide-dp':
        if (!p.dpQuestion?.trim() || !p.dpOptions?.trim()) {
          llmError.value = '问题和选项均为必填'
          llmRunning.value = false
          return
        }
        const dpId = p.dpId?.trim() || 'dp-' + Date.now().toString(36)
        const options = p.dpOptions.split('\n').map(s => s.trim()).filter(Boolean)
        const dp = { id: dpId, question: p.dpQuestion, options, status: p.dpStatus }
        result = await window.tegula.llmDecide(dp, model)
        break
      case 'review':
        result = await window.tegula.llmReview(p.projectId || undefined, model)
        break
      case 'roadmap-gen':
        result = await window.tegula.llmRoadmap(p.goal || undefined, p.projectId || undefined, model)
        break
      default:
        llmError.value = '未知命令: ' + cmd
        llmRunning.value = false
        return
    }

    if (result?.ok) {
      llmResult.value = result.content || '(空结果)'
    } else {
      // 失败必须给全证据：错误原文 + 实际端点 + 状态码 + 网关响应体
      const parts = [result?.error || '调用失败']
      if (result?.url) parts.push('端点：' + result.url)
      if (result?.status) parts.push('状态码：' + result.status)
      if (result?.body) parts.push('网关响应：' + String(result.body).slice(0, 300))
      llmError.value = parts.join('\n')
    }
  } catch (e: any) {
    llmError.value = e.message || '调用异常'
  } finally {
    llmRunning.value = false
  }
}

function renderLlmMarkdown(text: string): string {
  if (!text) return ''
  let html = marked.parse(text, { breaks: true, gfm: true }) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr',
      'ul', 'ol', 'li',
      'strong', 'em', 'b', 'i',
      'code', 'pre',
      'blockquote',
      'a', 'img',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'del'
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class']
  })
}

async function saveLlmConfig() {
  const f = llmConfigForm.value
  if (!f.baseUrl) {
    llmConfigMsg.value = 'Base URL 必填'
    llmConfigMsgType.value = 'error'
    return
  }
  if (!llmHasApiKey.value && !f.apiKey.trim()) {
    llmConfigMsg.value = '首次配置必须填写 API Key'
    llmConfigMsgType.value = 'error'
    return
  }
  // 只有用户真的输入了新 Key 才提交该字段；留空表示沿用已保存的密钥
  const payload: any = {
    baseUrl: f.baseUrl.trim(),
    model: f.model || 'gpt-4o-mini',
    timeout: f.timeout || 60
  }
  if (f.apiKey.trim()) payload.apiKey = f.apiKey.trim()

  const result = await window.tegula.llmSetConfig(payload)
  if (result.ok) {
    llmConfigMsg.value = '已保存'
    llmConfigMsgType.value = 'success'
    llmHasApiKey.value = !!result.hasApiKey
    if (f.apiKey.trim()) {
      const cfg = await window.tegula.llmGetConfig()
      llmKeyHint.value = cfg.apiKeyHint || ''
      llmConfigForm.value.apiKey = ''
    }
  } else {
    llmConfigMsg.value = '保存失败：' + (result.error || '未知错误')
    llmConfigMsgType.value = 'error'
  }
}

function resetLlmConfigInForm() {
  window.tegula.llmResetConfig().then((result: any) => {
    if (result.ok) {
      window.tegula.llmGetConfig().then((cfg: any) => {
        llmConfigForm.value = {
          baseUrl: cfg.baseUrl || '',
          apiKey: '',
          model: cfg.model || '',
          timeout: cfg.timeout || 60
        }
        llmHasApiKey.value = !!cfg.hasApiKey
        llmKeyHint.value = cfg.apiKeyHint || ''
        llmTestResult.value = null
        llmConfigMsg.value = cfg.hasApiKey ? '已恢复默认端点/模型（密钥保留）' : '已恢复默认配置'
        llmConfigMsgType.value = 'success'
      })
    } else {
      llmConfigMsg.value = '恢复失败：' + (result.error || '未知错误')
      llmConfigMsgType.value = 'error'
    }
  })
}

async function testLlmConnection() {
  const f = llmConfigForm.value
  if (!f.baseUrl) {
    llmTestResult.value = { ok: false, hint: '请先填写 Base URL' }
    return
  }
  if (!llmHasApiKey.value && !f.apiKey.trim()) {
    llmTestResult.value = { ok: false, hint: '请先填写 API Key' }
    return
  }
  llmTestRunning.value = true
  llmTestResult.value = null
  try {
    // apiKey 留空时主进程自动回落到已保存的密钥
    const result = await window.tegula.llmTestConnection({
      baseUrl: f.baseUrl.trim(),
      apiKey: f.apiKey.trim(),
      model: (f.model || '').trim() || undefined,
      timeout: Math.min(f.timeout || 60, 30)
    })
    llmTestResult.value = result
    if (Array.isArray(result.models) && result.models.length) {
      llmModelOptions.value = result.models
    }
  } catch (e: any) {
    llmTestResult.value = { ok: false, hint: e.message || '测试异常' }
  } finally {
    llmTestRunning.value = false
  }
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

async function openBackupFolder() {
  if (backupInfo.value) {
    await window.tegula.launchpadOpenFolder(backupInfo.value.path.substring(0, backupInfo.value.path.lastIndexOf('\\')))
  }
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

function exportNotesToFile() {
  window.tegula.exportNotes().then((result: any) => {
    if (result.ok && result.data) {
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `fangcun-notes-${Date.now()}.json`
      a.click()
      URL.revokeObjectURL(url)
      showToast(`已导出 ${result.count} 条笔记`, 'success')
    } else {
      showToast('导出失败', 'error')
    }
  })
}

// ── Toast ───────────────────────────────────────────────────────────────

function showToast(msg: string, type: 'success' | 'error' | 'info' = 'info') {
  toast.msg = msg
  toast.type = type
  toast.show = true
  setTimeout(() => { toast.show = false }, 2000)
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
  // 备份状态全局订阅：顶栏指示灯随调度结果实时变化（失败会显红）
  bkInitBackup()
  ncInit()
})

onUnmounted(() => {
  if (ncTimer) { clearInterval(ncTimer); ncTimer = null }
  document.removeEventListener('mousedown', onDocumentClick)
  document.removeEventListener('keydown', onKeydown)
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
#smodal { width: 560px; }
#smodal .sect { border-top: 1px solid var(--border); padding: 14px 0; margin-top: 6px; }
#smodal .sect:first-of-type { border-top: 0; padding-top: 0; }
#smodal .sect h4 { margin: 0 0 10px; font-size: 14px; color: var(--accent); }
#smodal .hint { font-size: 11px; color: var(--muted); margin-top: 4px; }
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

/* Batch bar */
.batch-bar { display: flex; align-items: center; gap: 8px; padding: 6px 16px; background: #fffdf5; border-bottom: 1px solid #f0e8d0; font-size: 12px; flex-wrap: wrap; }
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

/* Notes view */
.notes-view { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
.notes-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.notes-header h3 { font-size: 16px; font-weight: 700; }
.notes-ctrls { display: flex; gap: 6px; }
.notes-ctrls button { padding: 5px 12px; border: 0; border-radius: 8px; font-size: 12px; font-weight: 600; background: var(--accent); color: #fff; cursor: pointer; }
.notes-ctrls button.ghost { background: #fff; color: var(--ink); border: 1px solid var(--border); }
.notes-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
.note-card { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; cursor: pointer; transition: box-shadow 0.15s; box-shadow: var(--shadow); }
.note-card:hover { box-shadow: 0 4px 16px rgba(120,110,170,0.16); }
.note-card-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.note-card-content { font-size: 11.5px; color: var(--muted); line-height: 1.5; }
.note-card-meta { display: flex; justify-content: space-between; margin-top: 8px; font-size: 10px; color: var(--muted); }
.note-task { background: var(--accent-soft); color: var(--accent); padding: 1px 6px; border-radius: 4px; }

/* Notes section in preview */
.notes-section { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 10px; }
.notes-section label { font-size: 11px; color: var(--muted); font-weight: 600; display: block; margin-bottom: 4px; }
.notes-list { margin-bottom: 6px; }
.note-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: var(--bg); border-radius: 6px; margin-bottom: 4px; }
.note-item-title { font-size: 12px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.note-item-content { font-size: 10.5px; color: var(--muted); flex: 2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.note-del { background: none; border: 0; cursor: pointer; color: var(--muted); font-size: 14px; padding: 0 4px; }
.note-del:hover { color: var(--danger); }
.add-note-btn { background: none; border: 1px dashed var(--border); border-radius: 6px; padding: 4px 8px; font-size: 11px; color: var(--muted); cursor: pointer; width: 100%; }
.add-note-btn:hover { border-color: var(--accent); color: var(--accent); }

/* Note edit modal */
#note-edit-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 460px; box-shadow: var(--shadow); border: 1px solid var(--border); }
#note-edit-modal h3 { margin: 0 0 12px; font-size: 16px; }
#note-edit-modal label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 3px; font-weight: 600; }
#note-edit-modal input, #note-edit-modal textarea { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; color: var(--ink); outline: none; font-family: inherit; }
#note-edit-modal textarea { height: 80px; resize: vertical; }
#note-edit-modal textarea.tall { height: 120px; }

/* Plans view */
.plans-view { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
.plans-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.plans-header h3 { font-size: 16px; font-weight: 700; }
.plans-header button { padding: 5px 12px; border: 0; border-radius: 8px; font-size: 12px; font-weight: 600; background: var(--accent); color: #fff; cursor: pointer; }
.plans-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
.plan-card { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; cursor: pointer; transition: box-shadow 0.15s; box-shadow: var(--shadow); }
.plan-card:hover { box-shadow: 0 4px 16px rgba(120,110,170,0.16); }
.plan-card-head { display: flex; align-items: center; gap: 8px; }
.plan-title { font-size: 13px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-status { font-size: 10px; padding: 1px 6px; border-radius: 6px; font-weight: 600; white-space: nowrap; }
.plan-body-preview { font-size: 11px; color: var(--muted); margin-top: 6px; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }

/* Plan detail modal */
#plan-detail-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 560px; max-height: 88vh; overflow: auto; box-shadow: var(--shadow); border: 1px solid var(--border); }
#plan-detail-modal h3 { margin: 0 0 12px; font-size: 16px; }
.plan-detail-status { margin-bottom: 14px; }
.plan-detail-section { margin-bottom: 14px; border-top: 1px solid var(--border); padding-top: 10px; }
.plan-detail-section label { display: block; font-size: 12px; color: var(--muted); font-weight: 600; margin-bottom: 6px; }
.plan-detail-section ul { padding-left: 18px; }
.plan-detail-section li { font-size: 12px; margin-bottom: 4px; }
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
.roadmap-suggestions { background: #fffdf5; border: 1px solid #f0e8d0; border-radius: 10px; padding: 10px 14px; }
.roadmap-suggestions h4 { font-size: 13px; color: var(--accent); margin-bottom: 6px; }
.roadmap-suggestions ul { padding-left: 18px; }
.roadmap-suggestions li { font-size: 12px; margin-bottom: 4px; }

/* Suggest button in top bar */
.suggest-btn {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.suggest-btn:hover {
  background: #f4f1fc;
  border-color: var(--accent);
}

/* Suggest modal */
.suggest-modal {
  background: #fff;
  border-radius: 16px;
  width: 520px;
  max-height: 75vh;
  box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.suggest-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
.suggest-header h3 { margin: 0; font-size: 16px; color: var(--ink); }
.suggest-header .ghost {
  padding: 4px 10px;
  background: #fff;
  color: var(--ink);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
.suggest-header .ghost:hover { background: #f4f1fc; border-color: var(--accent); }
.suggest-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: #fafafa;
}
.suggest-controls .suggest-proj-select {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 12px;
  background: #fff;
  color: var(--ink);
  outline: none;
  font-family: inherit;
}
.suggest-controls .pri {
  background: var(--accent);
  color: #fff;
  border: 0;
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.suggest-controls .pri:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.suggest-controls .ghost {
  background: #fff;
  color: var(--ink);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.suggest-controls .ghost:hover { background: #f4f1fc; border-color: var(--accent); }
.suggest-controls .ghost:disabled { opacity: 0.45; cursor: not-allowed; }
.suggest-hint {
  text-align: center;
  padding: 20px;
  color: var(--muted);
  font-size: 12px;
}
.suggest-body {
  padding: 16px 20px;
  overflow-y: auto;
  flex: 1;
}
.suggest-loading { text-align: center; padding: 24px; color: var(--muted); font-size: 14px; }
.suggest-error { padding: 16px; background: #fdf5f5; border: 1px solid #eedcdc; border-radius: 8px; color: #8a4343; font-size: 13px; }
.suggest-empty { text-align: center; padding: 24px; color: var(--muted); font-size: 13px; }
.suggest-body ul { list-style: none; padding: 0; margin: 0; }
.suggest-body li {
  padding: 12px 16px;
  margin-bottom: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink);
}
.suggest-body li:last-child { margin-bottom: 0; }

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

/* LLM Planning Modal */
#llm-planning-modal {
  background: #fff; border-radius: 16px; padding: 18px 20px;
  width: 580px; max-height: 88vh; overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0,0,0,0.18); border: 1px solid var(--border);
}
#llm-planning-modal h3 { margin: 0 0 4px; font-size: 16px; color: var(--ink); }
#llm-planning-modal label {
  display: block; font-size: 12px; color: var(--muted);
  margin: 10px 0 3px; font-weight: 600;
}
#llm-planning-modal input,
#llm-planning-modal select,
#llm-planning-modal textarea {
  width: 100%; box-sizing: border-box; padding: 6px 8px;
  border: 1px solid var(--border); border-radius: 8px; font-size: 13px;
  color: var(--ink); outline: none; font-family: inherit;
}
#llm-planning-modal textarea { height: 64px; resize: vertical; }
.llm-result-section { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px; }
.llm-result-section .llm-running { text-align: center; padding: 16px; color: var(--muted); font-size: 13px; }
.llm-result-section .llm-error { padding: 12px; background: #fdf5f5; border: 1px solid #eedcdc; border-radius: 8px; color: #8a4343; font-size: 13px; white-space: pre-wrap; word-break: break-all; line-height: 1.6; }
.llm-result-section .llm-result {
  font-size: 12.5px; line-height: 1.65; color: var(--ink);
  background: var(--bg); border-radius: 8px; padding: 12px 14px;
  max-height: 400px; overflow-y: auto;
}
.llm-result h2 { font-size: 14px; margin: 10px 0 6px; color: var(--accent); }
.llm-result h3 { font-size: 13px; margin: 8px 0 4px; color: var(--ink); }
.llm-result ul { padding-left: 18px; margin: 4px 0; }
.llm-result li { margin-bottom: 3px; list-style: disc; }
.llm-result p { margin: 4px 0; }
.llm-result code { background: #eee; padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }
.llm-result strong { color: var(--ink); }

/* LLM Config Modal */
#llm-config-modal {
  background: #fff; border-radius: 16px; padding: 18px 20px;
  width: 460px; box-shadow: 0 8px 32px rgba(0,0,0,0.18); border: 1px solid var(--border);
}
#llm-config-modal h3 { margin: 0 0 4px; font-size: 16px; color: var(--ink); }
#llm-config-modal label {
  display: block; font-size: 12px; color: var(--muted);
  margin: 10px 0 3px; font-weight: 600;
}
#llm-config-modal input {
  width: 100%; box-sizing: border-box; padding: 6px 8px;
  border: 1px solid var(--border); border-radius: 8px; font-size: 13px;
  color: var(--ink); outline: none; font-family: inherit;
}
.llm-config-msg { margin-top: 10px; font-size: 12px; padding: 6px 10px; border-radius: 6px; }
.llm-config-msg.success { background: #e3f1de; color: #3f6b3a; border: 1px solid #bcd4b4; }
.llm-config-msg.error { background: #f6e2e2; color: #8a4343; border: 1px solid #e2c4c4; }
.llm-config-msg.info { background: #eef0fb; color: #5b5478; border: 1px solid #c3bce0; }
.llm-test-result { margin-top: 10px; }
.ping-steps { margin-top: 8px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.ping-step { display: grid; grid-template-columns: 18px 44px 42px 1fr; gap: 6px; align-items: start; padding: 7px 10px; font-size: 12px; border-bottom: 1px solid var(--border); }
.ping-step:last-child { border-bottom: none; }
.ping-step .mark { font-weight: 700; text-align: center; }
.ping-step .mark.ok { color: #4a7c3f; }
.ping-step .mark.bad { color: #a24848; }
.ping-step .name { color: var(--ink); }
.ping-step .code { color: var(--muted); font-variant-numeric: tabular-nums; }
.ping-step .detail { color: var(--ink); line-height: 1.5; }
.ping-step .url { grid-column: 2 / -1; color: var(--muted); font-size: 11px; word-break: break-all; }
#llm-config-modal code { background: #eee; padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }

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

/* Model chips */
.model-chips {
  display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;
}
.model-chips .chip {
  display: inline-block; padding: 3px 8px; font-size: 11px;
  background: #f4f1fc; color: #5b5478; border: 1px solid #c3bce0;
  border-radius: 12px; cursor: pointer; transition: all 0.15s;
}
.model-chips .chip:hover {
  background: #e4def8; border-color: var(--accent);
}

/* Decision point auto ID */
.dp-id-row {
  display: flex; align-items: center; gap: 8px; margin-top: 6px;
}
.dp-id-row label { margin: 0 !important; }
.dp-id-auto {
  font-size: 11px; color: var(--muted); font-style: italic;
}

/* Todos view */
.todos-view { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
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
.log-project { font-weight: 500; }
.log-task { color: var(--accent); }
.log-completed { color: #5e9154; }
.log-card-actions { display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; }

/* Log edit modal */
#log-edit-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 560px; max-height: 88vh; overflow-y: auto; box-shadow: var(--shadow); border: 1px solid var(--border); }
#log-edit-modal h3 { margin: 0 0 12px; font-size: 16px; }
#log-edit-modal label { display: block; font-size: 11px; font-weight: 600; color: var(--muted); margin: 10px 0 4px; }
#log-edit-modal input { width: 100%; box-sizing: border-box; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }
#log-edit-modal textarea { width: 100%; box-sizing: border-box; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; font-family: inherit; resize: vertical; line-height: 1.5; }
#log-edit-modal .acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }

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
