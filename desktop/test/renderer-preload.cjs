/**
 * 渲染层测试用 preload —— 用内存里的假后端替掉真 IPC。
 *
 * 目的：让「装了没装 / 点了有没有反应」这类问题第一次能被自动断言。
 * 项目已有的五类静态检查（vite / tsc / e2e / IPC 对账 / 模板绑定）**全都抓不到**
 * "按钮存在、通道齐全、但点了没反应"这一类问题 —— 本次用户第 1 条就是这个形状。
 *
 * 只测试用，不参与打包。
 */
const { contextBridge } = require('electron')

const store = {
  todos: [],
  // 归档日志独立分区（2026-09-25 第 16 条）：三条不同状态，其中一条已归档
  logs: [
    { id: 'log-demo-1', title: '进行中的日志', content: '内容A', status: 'active', project: 'demo', created: '2026-09-24T00:00:00.000Z' },
    { id: 'log-demo-2', title: '已完成的日志', content: '内容B', status: 'completed', project: 'demo', created: '2026-09-23T00:00:00.000Z' },
    { id: 'log-demo-3', title: '归档的日志', content: '内容C', status: 'archived', project: 'demo', created: '2026-09-22T00:00:00.000Z' },
  ],
  calls: [],
  tasks: [
    {
      id: 'task-demo-001', title: '演示任务', status: '待办', priority: '高',
      project: 'demo', tags: [], body: '正文', deadline: '2026-09-30',
      created: '2026-09-01T00:00:00.000Z', updated: '2026-09-01T00:00:00.000Z',
      fm: { id: 'task-demo-001', title: '演示任务', status: '待办', priority: '高', project: 'demo' },
      path: 'C:/mock/task-data/task-demo-001.md',
    },
    // 分组视图用：一个查不到名字的项目 id（标签必须回退成 id，不能空白）+ 一个完全没项目的
    {
      id: 'task-demo-002', title: '幽灵项目任务', status: '待办', priority: '中',
      project: 'ghost-proj', tags: [], body: '',
      created: '2026-09-01T00:00:00.000Z', updated: '2026-09-01T00:00:00.000Z',
      fm: { id: 'task-demo-002', title: '幽灵项目任务', status: '待办', priority: '中', project: 'ghost-proj' },
      path: 'C:/mock/task-data/task-demo-002.md',
    },
    {
      id: 'task-demo-003', title: '未归属任务', status: '进行中', priority: '低',
      tags: [], body: '',
      created: '2026-09-01T00:00:00.000Z', updated: '2026-09-01T00:00:00.000Z',
      fm: { id: 'task-demo-003', title: '未归属任务', status: '进行中', priority: '低' },
      path: 'C:/mock/task-data/task-demo-003.md',
    },
  ],
  projects: [{ id: 'demo', name: '演示项目' }, { id: 'demo2', name: '第二个项目' }],
  // 归档区：故意放一条与活跃任务**同 id** 的副本（历史遗留/手工拷贝真会出现），
  // 「含归档」勾选后板子必须去重，不能把同一张卡显示两遍。
  archived: [
    {
      id: 'task-demo-001', title: '演示任务（归档副本）', status: '完成', priority: '高',
      project: 'demo', tags: [], body: '',
      created: '2026-08-01T00:00:00.000Z', updated: '2026-08-01T00:00:00.000Z',
      fm: { id: 'task-demo-001', title: '演示任务（归档副本）', status: '完成' },
      path: 'C:/mock/task-data/archive/task-demo-001.md',
    },
    {
      id: 'task-demo-090', title: '真归档任务', status: '完成', priority: '低',
      project: 'demo', tags: [], body: '',
      created: '2026-08-01T00:00:00.000Z', updated: '2026-08-01T00:00:00.000Z',
      fm: { id: 'task-demo-090', title: '真归档任务', status: '完成' },
      path: 'C:/mock/task-data/archive/task-demo-090.md',
    },
  ],
}

function rec(name, args) {
  store.calls.push({ name, args: JSON.parse(JSON.stringify(args || [])) })
}

let seq = 0
const nextId = (p) => `${p}-${Date.now()}-${(seq++).toString(36)}`

const ok = (extra) => Object.assign({ ok: true }, extra || {})

contextBridge.exposeInMainWorld('tegula', {
  // ── 启动期必需面 ────────────────────────────────────────────────
  isFirstRun: () => { rec('isFirstRun'); return false },
  getDataDir: () => { rec('getDataDir'); return 'C:/mock-data' },
  selfCheck: () => ok(),
  taskFieldSpecs: () => {
    rec('taskFieldSpecs')
    return [
      { key: 'title', label: '标题', type: 'text', span: 'full' },
      { key: 'project', label: '项目', type: 'select', span: 'half', optionsFrom: 'projects' },
      { key: 'status', label: '状态', type: 'select', span: 'half', options: ['草稿', '待办', '进行中', '完成', '驳回'] },
      { key: 'priority', label: '优先级', type: 'select', span: 'half', options: ['高', '中', '低'] },
      { key: 'start', label: '开始', type: 'text', span: 'half' },
      { key: 'deadline', label: '截止', type: 'text', span: 'half' },
      { key: 'batch', label: '批次', type: 'text', span: 'half' },
      { key: 'tags', label: '标签', type: 'tags', span: 'full' },
      { key: 'blockers', label: '阻塞', type: 'list', span: 'full' },
      { key: 'memo', label: '附言', type: 'textarea', span: 'full' },
      { key: 'body', label: '正文', type: 'textarea', span: 'full' },
    ]
  },
  taskEnums: () => ({ statuses: ['草稿', '待审批', '待办', '进行中', '待验收', '完成', '驳回'], priorities: ['高', '中', '低'] }),
  loadTasks: (v) => { rec('loadTasks', [v]); return (v === 'archive' ? (store.archived || []) : store.tasks).slice() },
  loadProjects: () => store.projects.slice(),
  findBlockers: () => [],
  parseErrors: () => [],
  allProjectProgress: () => ({}),
  getProjectProgress: () => ({}),
  loadActivity: () => [],
  getBlockerChains: () => [],
  aggregateRoadmap: () => ({ projects: [] }),
  backupStatus: () => ({ ok: true, status: { enabled: false, running: false, nextRunAt: null, state: {} } }),
  backupGetConfig: () => ({}),
  onBackupStatus: () => () => {},
  backupLog: () => [],
  notificationsList: () => [],
  notificationsUnreadCount: () => 0,
  notificationsScan: () => ({ ok: true }),

  // ── 待办（本测试的主角）────────────────────────────────────────
  todosList: (_f) => { rec('todosList'); return store.todos.slice() },
  todosCreate: (title, priority, due, project) => {
    rec('todosCreate', [title, priority, due, project])
    const t = {
      id: nextId('todo'), title: String(title || ''), done: false,
      priority: priority || '中', due: due || undefined, project: project || undefined,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    store.todos.push(t)
    return ok({ todo: t })
  },
  todosUpdate: (id, updates) => {
    rec('todosUpdate', [id, updates])
    const t = store.todos.find(x => x.id === id)
    if (!t) return { ok: false, error: 'not found' }
    Object.assign(t, updates)
    return ok({ todo: t })
  },
  todosToggle: (id) => {
    rec('todosToggle', [id])
    const t = store.todos.find(x => x.id === id)
    if (!t) return { ok: false }
    t.done = !t.done
    return ok({ todo: t })
  },
  todosDelete: (id) => {
    rec('todosDelete', [id])
    store.todos = store.todos.filter(x => x.id !== id)
    return ok()
  },

  // ── 日志 ───────────────────────────────────────────────────────
  logsList: () => store.logs.slice(),
  logsCreate: (title, project, content, taskId) => {
    rec('logsCreate', [title, project, content, taskId])
    const l = { id: nextId('log'), title, project, content, taskId, status: 'active', created: new Date().toISOString() }
    store.logs.push(l)
    return ok({ log: l })
  },
  logsUpdate: () => ok(),
  logsComplete: () => ok(),
  logsArchive: () => ok(),
  logsDestroy: () => ok(),
  logsSearch: () => [],
  logsCleanup: () => [],
  logsForTask: () => [],

  // ── 任务操作 ───────────────────────────────────────────────────
  editTask: (id, fields) => {
    rec('editTask', [id, fields])
    const t = store.tasks.find(x => x.id === id)
    if (t) Object.assign(t, fields)
    return ok()
  },
  newTask: () => ok(),
  moveStatus: () => ok(),
  batchEdit: () => ok(),
  batchArchive: () => ok(),
  batchDelete: () => ok(),
  archiveTask: () => ok(),
  unarchiveTask: () => ok(),
  deleteTask: () => ok(),
  copyTask: () => ok(),
  taskFormValues: () => ({}),
  naturalQuery: () => [],
  scanProjectStatus: () => ({}),
  getRoadmapTrend: () => ({}),
  suggestCrossProject: () => [],
  detectParallelOpportunities: () => [],
  suggestMilestones: () => [],
  suggestActions: () => [],
  cronCheck: () => ({}),
  scanServices: () => ({}),

  // ── 启动台 ─────────────────────────────────────────────────────
  launchpadLoadApps: () => [],
  launchpadAddApp: () => [],
  launchpadUpdateApp: () => [],
  launchpadRemoveApp: () => [],
  launchpadLaunchApp: () => ok({ message: 'ok' }),
  launchpadOpenFolder: () => ok(),
  launchpadOpenUrl: () => ok(),
  launchpadGetConfigPath: () => 'C:/mock/apps.json',

  // ── 诊断日志（新通道；渲染层错误上报会用到）────────────────────
  applogPath: () => 'C:/mock/data/logs/fangcun-20260922.log',
  applogDir: () => 'C:/mock/data/logs',
  applogTail: () => [],
  applogOpenDir: () => ok(),
  applogWrite: (level, scope, message, detail) => { rec('applogWrite', [level, scope, message, detail]); return ok() },

  // ── 其它（不参与断言，返回空实现避免 undefined 报错）──────────
  browseDirectory: () => null,
  browseFile: () => null,
  // 项目章程三态（2026-09-25 第 7 条）：demo 已填、demo2 连文件都没有
  policyGet: (id) => (id === 'demo'
    ? { ok: true, policy: { projectId: 'demo', mission: '使命内容', goal: '', scenario: '', boundary: '', updatedAt: '' } }
    : { ok: true, policy: null }),
  policySave: (p) => { rec('policySave', [p]); return ok({ path: 'C:/mock/policies/' + (p && p.projectId) + '.md' }) },
  policyText: () => '',
  openFile: () => ok(),
  setDataDir: () => ok(),
  dataInspect: () => ok(),
  dataMigrate: () => ok(),
  createFreshSetup: () => ok(),
  importFromPythonTegula: () => ok(),
  registryAddProject: () => ok(),
  listBackups: () => [],
  backup: () => ok(),
  restore: () => ok(),
  // 导出指定备份（2026-09-25 第 10 条）：给两份假备份，验证「默认最新」与传参
  backupListLocal: () => ({
    ok: true,
    items: [
      { name: 'fangcun-data-20260920-101010.zip', path: 'C:/mock/backups/fangcun-data-20260920-101010.zip', bytes: 111111, mtime: '2026-09-20T10:10:10.000Z', sha256: null },
      { name: 'fangcun-data-20260925-202020.zip', path: 'C:/mock/backups/fangcun-data-20260925-202020.zip', bytes: 222222, mtime: '2026-09-25T20:20:20.000Z', sha256: null },
    ],
  }),
  backupListRemote: () => [],
  backupListSources: () => [],
  backupState: () => ({}),
  backupRun: () => ok(),
  backupRunLocalOnly: () => ok(),
  backupSaveConfig: () => ok(),
  backupSetConfig: () => ok(),
  backupTestRemote: () => ok(),
  backupRestore: () => ok(),
  backupOpenDir: () => ok(),
  backupLocalDir: () => 'C:/mock/data/backups',
  backupExportTo: (input) => { rec('backupExportTo', [input]); return ok({ result: { files: 3, bytes: 2048, dir: 'C:/mock/out' } }) },
  backupVerifyPackage: () => ok(),
  backupPickRestoreFile: () => null,
  backupPickDir: () => null,
  llmGetConfig: () => ({}),
  llmSetConfig: () => ok(),
  llmResetConfig: () => ok(),
  llmTestConnection: () => ok(),
  exportTasks: () => ok(),
  importTasks: () => ok(),
  updateCheck: () => ok(),
  updateDownload: () => ok(),
  updateQuitAndInstall: () => ok(),
  onUpdateAvailable: () => () => {},
  onUpdateNotAvailable: () => () => {},
  onUpdateProgress: () => () => {},
  onUpdateDownloaded: () => () => {},
  onUpdateError: () => () => {},
})

// 测试侧只读入口（断言用）
contextBridge.exposeInMainWorld('__fcTest', {
  calls: () => JSON.parse(JSON.stringify(store.calls)),
  callCount: (name) => store.calls.filter(c => c.name === name).length,
  todos: () => JSON.parse(JSON.stringify(store.todos)),
  logs: () => JSON.parse(JSON.stringify(store.logs)),
  tasks: () => JSON.parse(JSON.stringify(store.tasks)),
  reset: () => { store.calls.length = 0 },
})
