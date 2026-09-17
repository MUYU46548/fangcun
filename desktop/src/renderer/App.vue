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
        <input v-model="searchQuery" placeholder="搜索..." class="search" />
        <label class="chk"><input type="checkbox" v-model="searchIncludeArchive" /> 含归档</label>
        <select v-model="sortMode">
          <option value="active">活跃优先</option>
          <option value="updated">最近更新</option>
          <option value="created">创建时间</option>
        </select>
        <button @click="openNew">+ 新建</button>
        <button class="ghost" @click="showBackup">💾</button>
        <button class="ghost" @click="toggleBatchMode">☑</button>
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

    <!-- Archive hint -->
    <div v-if="curView === 'archive' && showArchiveHint" class="archive-hint">
      <span>📋 归档视图：此处仅显示已完成/驳回的任务。归档操作只能由你亲自判定，不会自动执行。</span>
      <button @click="showArchiveHint = false; localStorage.setItem('fc_archive_hint_seen','1')">知道了</button>
    </div>

    <!-- Kanban board -->
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
          <input
            v-if="batchMode"
            type="checkbox"
            class="batch-chk"
            :checked="selectedBatch.includes(t.id)"
            @click.stop="toggleBatchSelect(t.id)"
          />
          <div class="card-head">
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
          <div class="body-text">{{ previewTask.body }}</div>
        </div>
        <div class="acts">
          <button class="ghost" @click="copyId(previewTask.id)">📋 复制ID</button>
          <button class="ok" @click="openEdit(previewTask)">编辑</button>
          <button v-if="!previewTask._archived" class="warning" @click="archiveTask(previewTask)">归档</button>
          <button class="danger" @click="deleteTask(previewTask.id)">删除</button>
        </div>
      </div>
    </div>

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
            <div class="memrow" v-for="p in projects" :key="p.id">
              <span>{{ p.name || p.id }}</span>
              <small>{{ p.id }}</small>
            </div>
          </div>
        </div>
        <div class="sect">
          <button class="pri" @click="triggerBackup">立即备份</button>
          <button class="ghost" @click="showSettings_ = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- Toast -->
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, reactive } from 'vue'

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
const draggingId = ref<string | null>(null)
const dragoverCol = ref<string | null>(null)
const previewTask = ref<Task | null>(null)
const editTask_ = ref<any>(null)
const showSettings_ = ref(false)
const batchMode = ref(false)
const selectedBatch = ref<string[]>([])
const dataDir = ref('')
const launchpadApps = ref<any[]>([])
const launchpadConfigPath = ref('')
const editApp_ = ref<any>(null)

const toast = reactive({ show: false, msg: '', type: 'info' })

const views = [
  { id: 'active', label: '看板' },
  { id: 'projects', label: '项目' },
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
  } else {
    loadAll()
  }
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

const archivedTasks = ref<Task[]>([])

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
  if (searchIncludeArchive.value) {
    try {
      const arch = await window.tegula.loadTasks('archive')
      archivedTasks.value = arch.map((a: Task) => ({ ...a, _archived: true }))
    } catch { archivedTasks.value = [] }
  } else {
    archivedTasks.value = []
  }
}

const filteredTasks = computed(() => {
  let result = [...tasks.value]
  if (searchIncludeArchive.value && archivedTasks.value.length > 0) {
    result = [...result, ...archivedTasks.value]
  }
  if (curProj.value !== '__all__') {
    result = result.filter(t => normProject(t.project) === curProj.value)
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter(t =>
      t.title?.toLowerCase().includes(q) ||
      t.id?.toLowerCase().includes(q) ||
      normProject(t.project).toLowerCase().includes(q) ||
      t.tags?.join(' ').toLowerCase().includes(q)
    )
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

// ── Project view ────────────────────────────────────────────────────────

function openProject(p: any) {
  curProj.value = p.id
  curView.value = 'active'
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

// ── Settings / Backup ──────────────────────────────────────────────────

function showSettings() {
  showSettings_.value = true
}

async function triggerBackup() {
  const res = await window.tegula.backup()
  showToast(res.ok ? '备份成功' : '备份失败', res.ok ? 'success' : 'error')
}

function showBackup() {
  triggerBackup()
}

// ── Toast ───────────────────────────────────────────────────────────────

function showToast(msg: string, type: 'success' | 'error' | 'info' = 'info') {
  toast.msg = msg
  toast.type = type
  toast.show = true
  setTimeout(() => { toast.show = false }, 2000)
}

// ── Mount ───────────────────────────────────────────────────────────────

onMounted(loadAll)
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

.archive-hint { margin: 8px 16px; padding: 8px 12px; background: #fffdf5; border: 1px solid #f0e8d0; border-radius: 10px; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #7a6f4a; }
.archive-hint button { padding: 4px 10px; background: var(--accent); color: #fff; border: 0; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 600; }

.card._archived { opacity: 0.55; filter: saturate(0.5); }
.card._archived:hover { opacity: 0.85; filter: none; }

.acts .warning { background: #f0a83a; color: #fff; }

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

.batch-chk { position: absolute; top: 6px; left: 6px; z-index: 3; accent-color: var(--accent); width: 15px; height: 15px; cursor: pointer; opacity: 0; transition: opacity 0.12s; }
.card:hover .batch-chk, .batch-chk.checked, .batch-mode .card .batch-chk { opacity: 1; }

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
.memrow { display: flex; align-items: center; justify-content: space-between; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 6px 12px; font-size: 13px; }

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
</style>
