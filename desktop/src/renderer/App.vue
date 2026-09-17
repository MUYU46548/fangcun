<template>
  <div id="app">
    <!-- Decorative blobs -->
    <div class="blob b1"></div>
    <div class="blob b2"></div>

    <!-- Top bar -->
    <header id="bar">
      <span class="title">方寸 tegula<small id="count">{{ tasks.length }}</small></span>
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
        <input
          v-model="quickAddInput"
          placeholder="快速添加: 标题 p1 #tag @user to:待办 due:MM-DD"
          class="quick-add"
          @keydown.enter="executeQuickAdd"
          @input="quickAddError = ''"
        />
        <span v-if="quickAddError" class="qa-error">{{ quickAddError }}</span>
        <label class="chk"><input type="checkbox" v-model="searchIncludeArchive" /> 含归档</label>
        <select v-model="sortMode">
          <option value="active">活跃优先</option>
          <option value="updated">最近更新</option>
          <option value="created">创建时间</option>
        </select>
        <button @click="openNew">+ 新建</button>
        <button class="ghost" @click="showBackup">💾</button>
        <button class="ghost" @click="toggleBatchMode">☑</button>
        <button class="ghost notify-btn" @click="toggleNotifyPanel">🔔<span v-if="unreadCount" class="notify-badge">{{ unreadCount }}</span></button>
        <button class="ghost" @click="showSettings">⚙</button>
      </span>
    </header>

    <!-- View tabs -->
    <nav id="views">
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
    <div v-if="batchMode && selectedBatch.length" class="batch-bar">
      <span class="batch-count">已选 {{ selectedBatch.length }}</span>
      <button class="ghost" @click="toggleSelectAll">{{ selectedBatch.length === filteredTasks.length ? '取消全选' : '全选' }}</button>
      <div class="batch-actions">
        <button class="ghost" @click="batchSetStatus('待办')">待办</button>
        <button class="ghost" @click="batchSetStatus('进行中')">进行中</button>
        <button class="ghost" @click="batchSetStatus('待验收')">待验收</button>
        <button class="ghost" @click="batchSetStatus('完成')">完成</button>
        <button class="ghost" @click="batchSetStatus('驳回')">驳回</button>
        <button class="ghost" @click="executeBatchArchive">归档</button>
      </div>
      <button class="ghost" @click="selectedBatch = []; batchMode = false">取消</button>
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
          <small v-if="t.body" class="result-preview">{{ truncate(t.body, 60) }}</small>
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
          :class="{ done: todo.done, prio: todo.priority === 'high' }"
        >
          <input
            type="checkbox"
            class="todo-chk"
            :checked="todo.done"
            @change="toggleTodo(todo.id)"
          />
          <span class="todo-title">{{ todo.title }}</span>
          <span v-if="todo.priority === 'high'" class="todo-prio">高</span>
          <button class="todo-del" @click.stop="deleteTodo(todo.id)">×</button>
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

    <!-- Dispatch modal -->
    <div id="dispatch-overlay" class="overlay" v-if="dispatchModal" @click.self="dispatchModal = null">
      <div id="dispatch-modal">
        <h3>⚡ 派活</h3>
        <div class="dispatch-info">
          <div class="dispatch-task-title">{{ dispatchModal.title }}</div>
          <div class="dispatch-task-id">{{ dispatchModal.id }}</div>
          <div class="dispatch-status">当前状态：{{ dispatchModal.status }}</div>
        </div>
        <label>任务书（复制给 agent 执行）</label>
        <textarea class="dispatch-prompt" readonly>{{ dispatchModal.prompt }}</textarea>
        <div class="acts">
          <button class="ghost" @click="dispatchModal = null">取消</button>
          <button class="ghost" @click="copyDispatchPrompt">📋 复制任务书</button>
          <button class="pri" @click="executeDispatchClick">▶ 派活</button>
        </div>
      </div>
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
          <div><span class="k">优先级</span><span class="v">{{ previewTask.priority || '—' }}</span></div>
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
        <div class="acts">
          <button class="ghost" @click="dispatchTaskClick(previewTask.id)" v-if="previewTask.status !== '完成' && previewTask.status !== '驳回'">⚡ 派活</button>
          <button class="ok" @click="openReview(previewTask)" v-if="previewTask.status === '待验收'">✅ 验收</button>
          <button class="ghost" @click="copyId(previewTask.id)">📋 复制ID</button>
          <button class="ghost" @click="copyTaskClick(previewTask.id)">📑 复制任务</button>
          <button class="ok" @click="openEdit(previewTask)">编辑</button>
          <button v-if="previewTask.status === '完成' || previewTask.status === '驳回'" class="ok" @click="restoreTask(previewTask)">↩ 还原</button>
          <button v-else class="warning" @click="archiveTask(previewTask)">归档</button>
          <button class="danger" @click="deleteTask(previewTask.id)">删除</button>
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
    <div id="modal-overlay" class="overlay" v-if="editTask_" @click.self="editTask_ = null">
      <div id="modal">
        <h3>{{ editTask_.id ? '编辑任务' : '新建任务' }}</h3>
        <label>标题</label>
        <input v-model="editTask_.title" placeholder="任务标题" />
        <div class="row2">
          <div>
            <label>状态</label>
            <select v-model="editTask_.status">
              <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <div>
            <label>优先级</label>
            <select v-model="editTask_.priority">
              <option value="high">高</option>
              <option value="normal">中</option>
              <option value="low">低</option>
            </select>
          </div>
        </div>
        <label>项目</label>
        <select v-model="editTask_.project">
          <option value="">未归属</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
        </select>
        <label>标签（逗号分隔）</label>
        <input v-model="editTask_.tagsInput" placeholder="tag1, tag2" />
        <label>正文</label>
        <textarea v-model="editTask_.body" class="tall" placeholder="任务描述..."></textarea>
        <div class="acts">
          <button class="ghost" @click="editTask_ = null">取消</button>
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

    <!-- App edit modal (Launchpad) -->
    <div id="app-edit-overlay" class="overlay" v-if="editApp_" @click.self="editApp_ = null">
      <div id="app-edit-modal">
        <h3>{{ editApp_.isNew ? '添加应用' : '编辑应用' }}</h3>
        <label>名称</label>
        <input v-model="editApp_.name" placeholder="应用名称" />
        <label>路径（exe 或 bat）</label>
        <input v-model="editApp_.path" placeholder="E:/path/to/app.exe" />
        <label>描述（可选）</label>
        <input v-model="editApp_.description" placeholder="应用描述" />
        <div class="acts">
          <button class="ghost" @click="editApp_ = null">取消</button>
          <button v-if="!editApp_.isNew" class="danger" @click="removeApp(editApp_.id)">删除</button>
          <button class="pri" @click="saveEditApp">{{ editApp_.isNew ? '添加' : '保存' }}</button>
        </div>
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
        <div class="sect">
          <button class="pri" @click="triggerBackup">立即备份</button>
          <button v-if="backupInfo" class="ghost" @click="openBackupFolder">打开备份文件夹</button>
          <button class="ghost" @click="exportTasksToFile">导出任务 JSON</button>
          <button class="ghost" @click="importTasksFromFile">导入任务 JSON</button>
          <button class="ghost" @click="exportNotesToFile">导出笔记 JSON</button>
          <button class="ghost" @click="showSettings_ = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- Notification panel -->
    <div v-if="showNotifyPanel" class="notify-overlay" @click.self="showNotifyPanel = false">
      <div class="notify-panel">
        <div class="notify-header">
          <h3>🔔 通知</h3>
          <div class="notify-ctrls">
            <button class="ghost" @click="refreshNotifications">⟳ 刷新</button>
            <button class="ghost" @click="clearNotifications">清空</button>
            <button class="ghost" @click="showNotifyPanel = false">✕</button>
          </div>
        </div>
        <div class="notify-list">
          <div v-if="!notifyCache.length" class="notify-empty">暂无通知</div>
          <div
            v-for="(n, i) in notifyCache"
            :key="n.ts + i"
            class="notify-item"
            :class="['nt-' + n.type, { expanded: n.expanded }]"
            @click="toggleNotify(i)"
          >
            <span class="notify-icon">{{ n.type === 'success' ? '✅' : n.type === 'error' ? '❌' : 'ℹ️' }}</span>
            <div class="notify-body">
              <div class="notify-msg">{{ n.msg }}</div>
              <div class="notify-time">{{ formatRelativeTime(n.timestamp) }}</div>
            </div>
            <button class="notify-del" @click.stop="deleteNotify(i)" title="删除">×</button>
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
        <input v-model="llmConfigForm.apiKey" type="password" placeholder="sk-..." />
        <label>默认模型</label>
        <input v-model="llmConfigForm.model" placeholder="gpt-4o-mini" />
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
        <div v-if="llmTestResult" :class="'llm-config-msg ' + (llmTestResult.ok ? 'success' : 'error')">
          {{ llmTestResult.ok ? '✅ ' + llmTestResult.msg : '❌ ' + llmTestResult.msg }}
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
import { ref, computed, onMounted, reactive, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const STATUSES = ['草稿', '待审批', '待办', '进行中', '待验收', '完成', '驳回'] as const
type Status = typeof STATUSES[number]

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
const searchIncludeArchive = ref(true)
const dueFilter = ref('')
const quickAddInput = ref('')
const quickAddError = ref('')
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
const llmTestResult = ref<{ ok: boolean; msg: string } | null>(null)
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

// ── Dispatch ───────────────────────────────────────────────────────
const dispatchModal = ref<{ id: string; title: string; prompt: string; status: string } | null>(null)

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

const toast = reactive({ show: false, msg: '', type: 'info' })

// ── Notification system ───────────────────────────────────────────────
const NOTIFY_CACHE_KEY = 'tegula_notify'
const NOTIFY_MAX = 50
const NOTIFY_RULES_KEY = 'tegula_notify_rules'

interface NotifyRule {
  id: string
  name: string
  enabled: boolean
  type: 'timeout' | 'stuck' | 'event'
  threshold?: number
}

function loadNotifyRules(): NotifyRule[] {
  try {
    const raw = localStorage.getItem(NOTIFY_RULES_KEY)
    if (!raw) return getDefaultNotifyRules()
    return JSON.parse(raw)
  } catch {
    return getDefaultNotifyRules()
  }
}

function getDefaultNotifyRules(): NotifyRule[] {
  return [
    { id: 'rule-timeout', name: '超时任务提醒', enabled: true, type: 'timeout', threshold: 48 },
    { id: 'rule-stuck', name: '卡住项目提醒', enabled: true, type: 'stuck' },
    { id: 'rule-event', name: '事件提醒', enabled: true, type: 'event' },
  ]
}

function saveNotifyRules(rules: NotifyRule[]): void {
  localStorage.setItem(NOTIFY_RULES_KEY, JSON.stringify(rules))
}

const notifyRules = ref<NotifyRule[]>(loadNotifyRules())

interface NotifyItem {
  ts: string
  timestamp: number
  msg: string
  type: 'success' | 'error' | 'info'
  read: boolean
  expanded: boolean
}

function loadNotifyCache(): NotifyItem[] {
  try {
    const raw = localStorage.getItem(NOTIFY_CACHE_KEY)
    if (!raw) return []
    const items: any[] = JSON.parse(raw)
    return items.map((n: any) => ({
      ...n,
      timestamp: n.timestamp ?? Date.now(),
      expanded: n.expanded ?? false,
    }))
  } catch {
    return []
  }
}

function saveNotifyCache(items: NotifyItem[]) {
  localStorage.setItem(NOTIFY_CACHE_KEY, JSON.stringify(items))
}

const notifyCache = ref<NotifyItem[]>(loadNotifyCache())
const showNotifyPanel = ref(false)

const unreadCount = computed(() => notifyCache.value.filter(n => !n.read).length)

function formatRelativeTime(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}秒前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const day = Math.floor(hr / 24)
  return `${day}天前`
}

function addNotify(msg: string, type: 'success' | 'error' | 'info' = 'info') {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  // Deduplication: skip if same ts+msg already exists
  const exists = notifyCache.value.some(n => n.ts === ts && n.msg === msg)
  if (exists) return
  notifyCache.value.unshift({ ts, timestamp: Date.now(), msg, type, read: false, expanded: false })
  if (notifyCache.value.length > NOTIFY_MAX) notifyCache.value.pop()
  saveNotifyCache(notifyCache.value)
}

function toggleNotify(index: number) {
  notifyCache.value[index].expanded = !notifyCache.value[index].expanded
  saveNotifyCache(notifyCache.value)
}

function deleteNotify(index: number) {
  notifyCache.value.splice(index, 1)
  saveNotifyCache(notifyCache.value)
}

async function toggleNotifyPanel() {
  showNotifyPanel.value = !showNotifyPanel.value
  if (showNotifyPanel.value) {
    await refreshNotifications()
  }
}

async function refreshNotifications() {
  try {
    const result = await window.tegula.detectEvents('all')
    if (result) {
      addNotify(result, 'info')
    } else {
      addNotify('未检测到异常事件', 'success')
    }
  } catch (err: any) {
    addNotify(`刷新失败: ${err.message || err}`, 'error')
  }
}

function clearNotifications() {
  notifyCache.value = []
  saveNotifyCache(notifyCache.value)
}

// Mark all as read when panel is opened
watch(showNotifyPanel, (val) => {
  if (val) {
    notifyCache.value.forEach(n => { n.read = true })
    saveNotifyCache(notifyCache.value)
  }
})

const views = [
  { id: 'active', label: '看板' },
  { id: 'todos', label: '待办' },
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
    const groups: Record<string, Task[]> = { high: [], normal: [], low: [] }
    filtered.forEach(t => {
      const k = t.priority || 'normal'
      if (!groups[k]) groups[k] = []
      groups[k].push(t)
    })
    return [
      { key: 'high', label: '高优先级', tasks: groups.high },
      { key: 'normal', label: '中优先级', tasks: groups.normal },
      { key: 'low', label: '低优先级', tasks: groups.low },
    ]
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

async function changeDataDir() {
  const newDir = prompt('输入新数据目录路径（需包含 registry.yaml 或 task-data/）')
  if (!newDir) return
  const result = await window.tegula.setDataDir(newDir)
  if (result.ok) {
    dataDir.value = result.dir
    await loadAll()
    toast.msg = '数据目录已切换'
    toast.type = 'success'
    toast.show = true
    setTimeout(() => (toast.show = false), 2000)
  } else {
    toast.msg = `切换失败: ${result.error}`
    toast.type = 'error'
    toast.show = true
    setTimeout(() => (toast.show = false), 3000)
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
    const result: Record<string, any> = {}
    for (const p of projects.value) {
      result[p.id] = await window.tegula.getProjectProgress(p.id)
    }
    projectProgress.value = result
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
}

function openNote(note: any) {
  noteEdit_.value = { ...note }
}

function openNewNote() {
  noteEdit_.value = { title: '', content: '', taskId: '' }
}

function openNewPlan() {
  const title = prompt('规划标题：')
  if (!title) return
  const objective = prompt('规划目标：') || ''
  window.tegula.createPlan({ title, objective }).then((result: any) => {
    if (result.ok) {
      showToast('已创建', 'success')
      loadPlans()
    } else {
      showToast('创建失败', 'error')
    }
  })
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



// ── Quick Add ─────────────────────────────────────────────────────────

async function executeQuickAdd() {
  const text = quickAddInput.value.trim()
  if (!text) return
  const result = await window.tegula.quickAdd(text)
  if (result.ok) {
    quickAddInput.value = ''
    quickAddError.value = ''
    showToast('已创建', 'success')
    loadAll()
  } else {
    quickAddError.value = result.error || '创建失败'
  }
}

// ── Batch Ops ─────────────────────────────────────────────────────────

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

// ── Natural Query ─────────────────────────────────────────────────────

async function executeNaturalQuery() {
  const q = searchQuery.value.trim()
  if (!q) {
    isNaturalQuery.value = false
    naturalResults.value = []
    return
  }
  const result = await window.tegula.naturalQuery(q)
  if (result.error) {
    showToast(result.error, 'error')
    return
  }
  naturalResults.value = result.tasks
  isNaturalQuery.value = true
}

// ── Task operations ─────────────────────────────────────────────────────

function openNew() {
  editTask_.value = { title: '', status: '待办', priority: 'normal', project: '', tagsInput: '', body: '' }
}

function openEdit(t: Task) {
  editTask_.value = {
    id: t.id,
    title: t.title || '',
    status: t.status || '待办',
    priority: t.priority || 'normal',
    project: t.project || '',
    tagsInput: t.tags?.join(', ') || '',
    body: t.body || '',
  }
  previewTask.value = null
}

async function saveEdit() {
  const e = editTask_.value
  const fields: any = {
    title: e.title,
    status: e.status,
    priority: e.priority,
    project: e.project,
    body: e.body,
    tags: e.tagsInput ? e.tagsInput.split(',').map((s: string) => s.trim()) : [],
  }
  if (e.id) {
    await window.tegula.editTask(e.id, fields)
  } else {
    await window.tegula.newTask(fields)
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
const taskNotes = ref<any[]>([])

async function loadNotesForTask(taskId: string) {
  try {
    taskNotes.value = await window.tegula.notesForTask(taskId)
  } catch {
    taskNotes.value = []
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

function saveCheckChange(id: string, body: string) {
  if (_checkSaveTimers[id]) clearTimeout(_checkSaveTimers[id])
  _checkSaveTimers[id] = setTimeout(async () => {
    await window.tegula.editTask(id, { body })
    // 所有勾选框都已勾选 → 自动标记完成
    const hasCheckbox = /^- \[[ x]\]/gm.test(body)
    const hasUnchecked = /^- \[ \]/gm.test(body)
    if (hasCheckbox && !hasUnchecked) {
      await window.tegula.moveStatus(id, '完成')
    }
    loadAll()
  }, 300)
}

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
  const result = await window.tegula.todosCreate(text, 'normal')
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

// ── Dispatch ───────────────────────────────────────────────────────

async function dispatchTaskClick(id: string) {
  const result = await window.tegula.dispatchPreview(id)
  if (result.ok) {
    dispatchModal.value = { id, title: previewTask.value?.title || id, prompt: result.prompt, status: result.status }
    previewTask.value = null
  } else {
    showToast(result.error || '获取任务书失败', 'error')
  }
}

function copyDispatchPrompt() {
  if (dispatchModal.value) {
    navigator.clipboard.writeText(dispatchModal.value.prompt)
    showToast('已复制任务书', 'success')
  }
}

async function executeDispatchClick() {
  if (!dispatchModal.value) return
  if (!confirm('确认派活？任务状态将变为「进行中」。')) return
  const result = await window.tegula.dispatchExecute(dispatchModal.value.id)
  if (result.ok) {
    showToast('已派活', 'success')
    dispatchModal.value = null
    loadAll()
  } else {
    showToast(result.error || '派活失败', 'error')
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

function openNewProject() {
  const name = prompt('项目名称：')
  if (name) {
    showToast('项目添加功能开发中', 'info')
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
  window.tegula.llmGetConfig().then((cfg: any) => {
    llmConfigForm.value = { ...cfg }
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
      llmError.value = result?.error || '调用失败'
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
  if (!f.baseUrl || !f.apiKey) {
    llmConfigMsg.value = 'Base URL 和 API Key 均为必填'
    llmConfigMsgType.value = 'error'
    return
  }
  const result = await window.tegula.llmSetConfig({
    baseUrl: f.baseUrl,
    apiKey: f.apiKey,
    model: f.model || 'gpt-4o-mini',
    timeout: f.timeout || 60
  })
  if (result.ok) {
    llmConfigMsg.value = '已保存'
    llmConfigMsgType.value = 'success'
  } else {
    llmConfigMsg.value = '保存失败'
    llmConfigMsgType.value = 'error'
  }
}

function resetLlmConfigInForm() {
  window.tegula.llmResetConfig().then((result: any) => {
    if (result.ok) {
      window.tegula.llmGetConfig().then((cfg: any) => {
        llmConfigForm.value = { ...cfg }
        llmConfigMsg.value = '已恢复默认配置'
        llmConfigMsgType.value = 'success'
      })
    }
  })
}

async function testLlmConnection() {
  const f = llmConfigForm.value
  if (!f.baseUrl || !f.apiKey) {
    llmTestResult.value = { ok: false, msg: '请先填写 Base URL 和 API Key' }
    return
  }
  llmTestRunning.value = true
  llmTestResult.value = null
  try {
    const result = await window.tegula.llmChat('ping', {
      baseUrl: f.baseUrl,
      apiKey: f.apiKey,
      model: f.model || 'gpt-4o-mini',
      timeout: Math.min(f.timeout || 60, 30)
    })
    if (result.ok) {
      llmTestResult.value = { ok: true, msg: '连接成功' }
    } else {
      llmTestResult.value = { ok: false, msg: result.error || '连接失败' }
    }
  } catch (e: any) {
    llmTestResult.value = { ok: false, msg: e.message || '连接异常' }
  } finally {
    llmTestRunning.value = false
  }
}

async function triggerBackup() {
  const res = await window.tegula.backup()
  if (res.ok) {
    backupInfo.value = { path: res.path, sizeKB: res.sizeKB }
    showToast(`备份成功 (${res.sizeKB} KB)`, 'success')
  } else {
    showToast('备份失败', 'error')
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
  loadAll()
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
.card.selected { outline: 2px solid var(--accent); outline-offset: 1px; }
.card.dragging { opacity: 0.35; transform: scale(0.97); }

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

/* Quick add input */
#bar input.quick-add { width: 260px; font-size: 11px; color: var(--ink); background: #fff; border: 1px solid var(--border); }
#bar input.quick-add::placeholder { color: #9ca3af; font-size: 10.5px; }

/* QA error */
.qa-error { position: absolute; right: 16px; top: 42px; font-size: 11px; color: var(--danger); background: #fff; padding: 2px 8px; border-radius: 6px; border: 1px solid #eedcdc; z-index: 10; white-space: nowrap; }

/* Batch bar */
.batch-bar { display: flex; align-items: center; gap: 8px; padding: 6px 16px; background: #fffdf5; border-bottom: 1px solid #f0e8d0; font-size: 12px; }
.batch-count { font-weight: 600; color: var(--ink); flex: none; }
.batch-actions { display: flex; gap: 4px; flex: 1; flex-wrap: wrap; }
.batch-actions button { padding: 3px 10px; font-size: 11px; background: #fff; color: var(--ink); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-weight: 600; }
.batch-actions button:hover { background: #f4f1fc; border-color: var(--accent); }
.batch-bar .ghost { padding: 3px 10px; font-size: 11px; background: #fff; color: var(--ink); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; flex: none; }


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
.notify-btn { position: relative; }
.notify-badge {
  position: absolute; top: -4px; right: -4px;
  background: #e5484d; color: #fff; font-size: 9px; font-weight: 700;
  min-width: 16px; height: 16px; border-radius: 999px;
  display: flex; align-items: center; justify-content: center;
  padding: 0 4px; line-height: 1;
}
.notify-overlay {
  position: fixed; inset: 0; background: rgba(60,65,80,0.32);
  backdrop-filter: blur(4px); display: flex; align-items: flex-start;
  justify-content: flex-end; z-index: 100; padding: 50px 20px 0 0;
}
.notify-panel {
  background: #fff; border-radius: 16px; width: 420px; max-height: 70vh;
  box-shadow: 0 8px 32px rgba(0,0,0,0.18); border: 1px solid var(--border);
  display: flex; flex-direction: column; overflow: hidden;
}
.notify-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 16px; border-bottom: 1px solid var(--border);
}
.notify-header h3 { margin: 0; font-size: 15px; color: var(--ink); }
.notify-ctrls { display: flex; gap: 6px; }
.notify-ctrls button {
  padding: 4px 10px; font-size: 11px; border: 1px solid var(--border);
  border-radius: 6px; background: #fff; color: var(--ink); cursor: pointer;
  font-weight: 600;
}
.notify-ctrls button:hover { background: #f4f1fc; border-color: var(--accent); }
.notify-list { overflow-y: auto; flex: 1; padding: 8px; }
.notify-empty { text-align: center; color: var(--muted); font-size: 12px; padding: 30px 0; }
.notify-item {
  display: flex; gap: 10px; padding: 10px 12px; border-radius: 10px;
  border-left: 3px solid var(--border); background: #fafafa; margin-bottom: 6px;
  transition: background 0.15s;
  cursor: pointer; position: relative;
}
.notify-item:hover { background: #f4f1fc; }
.notify-item.nt-success { border-left-color: var(--success); }
.notify-item.nt-error { border-left-color: var(--danger); }
.notify-item.nt-info { border-left-color: var(--accent); }
.notify-icon { font-size: 14px; flex: none; }
.notify-body { flex: 1; min-width: 0; }
.notify-msg { font-size: 12px; color: var(--ink); line-height: 1.4; word-break: break-word; }
.notify-time { font-size: 10px; color: var(--muted); margin-top: 3px; }
.notify-item.expanded .notify-msg {
  white-space: pre-wrap; overflow: visible;
}
.notify-del {
  flex: none; background: none; border: none; font-size: 16px;
  color: var(--muted); cursor: pointer; padding: 0 4px; line-height: 1;
  border-radius: 4px; align-self: flex-start; margin-top: 2px;
}
.notify-del:hover { color: var(--danger); background: #fce4e4; }

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
.llm-result-section .llm-error { padding: 12px; background: #fdf5f5; border: 1px solid #eedcdc; border-radius: 8px; color: #8a4343; font-size: 13px; }
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

/* Dispatch modal */
#dispatch-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 560px; max-height: 88vh; overflow-y: auto; box-shadow: var(--shadow); border: 1px solid var(--border); }
#dispatch-modal h3 { margin: 0 0 12px; font-size: 16px; }
.dispatch-info { margin-bottom: 12px; }
.dispatch-task-title { font-size: 14px; font-weight: 700; }
.dispatch-task-id { font-size: 11px; color: var(--muted); }
.dispatch-status { font-size: 11px; color: var(--warning); margin-top: 4px; }
.dispatch-prompt { width: 100%; box-sizing: border-box; min-height: 200px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 11.5px; font-family: ui-monospace, "SF Mono", Menlo, monospace; background: var(--bg); resize: vertical; line-height: 1.5; }

/* Review modal */
#review-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 460px; box-shadow: var(--shadow); border: 1px solid var(--border); }
#review-modal h3 { margin: 0 0 12px; font-size: 16px; }
.review-info { margin-bottom: 12px; }
.review-task-title { font-size: 14px; font-weight: 700; }
.review-task-id { font-size: 11px; color: var(--muted); }
.review-reason { width: 100%; box-sizing: border-box; min-height: 80px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; font-family: inherit; resize: vertical; line-height: 1.5; }

</style>
