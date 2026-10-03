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

// 夹具里的「同一天」必须**跟着今天走**（2026-10-01 教训）：原先写死 2026-09-30，
// 跨月第一天日历断言必红 —— 日历只画当前月，9-30 那格根本不在视口里，
// 于是每个月 1 号都会冒出 3 条假红（当时被误当成回归）。压在"今天"才是这个夹具的本意。
const FIX_DEADLINE = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()
const FIX_MMDD = FIX_DEADLINE.slice(5)

const store = {
  todos: [],
  // 方针卡（2026-09-25 第 7 条三态 + 029 结构地图）：demo 已填但**没有**结构地图、
  // demo2 连文件都没有 —— 刻意留成"两个缺口各一种"，缺口条才有东西可显示。
  policies: {
    demo: { mission: '使命内容', goal: '', scenario: '', boundary: '', structureMap: '' },
  },
  // 归档日志独立分区（2026-09-25 第 16 条）：三条不同状态，其中一条已归档
  logs: [
    { id: 'log-demo-1', title: '进行中的日志', content: '内容A', status: 'active', project: 'demo', created: '2026-09-24T00:00:00.000Z' },
    { id: 'log-demo-2', title: '已完成的日志', content: '内容B', status: 'completed', project: 'demo', created: '2026-09-23T00:00:00.000Z' },
    { id: 'log-demo-3', title: '归档的日志', content: '内容C', status: 'archived', project: 'demo', created: '2026-09-22T00:00:00.000Z' },
  ],
  calls: [],
  // 通知中心点击跳转测试用（2026-10-01 用户第 1 条）
  notifications: [],
  // P0-4/P0-5 夹具
  ncStatus: { running: true, lastScanAt: new Date().toISOString() },
  ncMuted: [],
  ncMutedCount: 0,
  // 已完成任务自动归档（2026-10-03 卡 012）：默认 0 条超期 → 提示条不渲染；
  // 断言要测提示条时先 __fcTest.setOverdue(n) 再重进看板页。
  overdueCount: 0,
  overdueItems: [
    { id: 'task-overdue-1', title: '早该收起来的活', updated: '2026-09-01T00:00:00.000Z' },
  ],
  // UI 偏好真身（userData/prefs.json）。空对象 = 首次运行，界面走默认值 ——
  // 多视图的"旧视图永远是默认"这条断言就是靠它成立。
  prefs: {},
  // 技能直接导入（2026-09-26 卡 005）：一条已导入的外部技能
  imported: [
    {
      name: 'external-demo', description: '外部丢进来的示例技能', version: '0.3.1',
      dir: 'C:/mock/hermes/skills/external-demo', files: 3, bytes: 4096,
      importedAt: '2026-09-26T10:00:00.000Z', source: 'D:/packages/external-demo.zip',
    },
  ],
  // 服务 / 端口（2026-09-26 卡 006）：一条手填(监听中) + 一条启动台(空闲) + 一条未登记但正在监听
  services: [
    { id: 'manual:8753', name: '方寸看板', port: 8753, note: 'Python 版 tegula', project: '', source: 'manual', listening: true, pid: 1234, processName: 'python', duplicated: false },
    { id: 'app:nobody', name: '没人跑的服务', port: 9100, note: '', project: '', source: 'launchpad', listening: false, pid: null, processName: '', duplicated: false },
  ],
  servicesUnreg: [{ port: 8090, pid: 5016, processName: 'node' }],
  // 导入行为脚本：pickPath 是"用户选中的包路径"；importExists 打开后第一次导入返回重名
  pickPath: 'C:/fake/incoming-skill.zip',
  importExists: false,
  importName: 'incoming-skill',
  // 回收站（2026-09-26 卡 034）：一条普通 + 一条同名副本（.2.md），验证"按文件名操作"
  trash: [
    { name: 'task-demo-901.md', id: 'task-demo-901', title: '被删掉的演示任务', status: '待办', project: 'demo', bytes: 512, mtime: '2026-09-26T09:00:00.000Z' },
    { name: 'task-demo-902.2.md', id: 'task-demo-902', title: '同名副本（历史遗留）', status: '完成', project: 'demo', bytes: 640, mtime: '2026-09-25T08:00:00.000Z' },
  ],
  tasks: [
    // ⚠ 这两张（同为「待办」列）的 created / updated 是**故意错开的**（2026-09-29）：
    //   默认序 001→002；按 updated 倒序要变成 002→001；按 created 倒序要回到 001→002。
    //   这样"排序下拉"才可被真断言 —— 三者两两不同，任何一支写错都会当场红。
    {
      id: 'task-demo-001', title: '演示任务', status: '待办', priority: '高',
      project: 'demo', tags: [], body: '正文', deadline: FIX_DEADLINE,
      created: '2026-09-20T00:00:00.000Z', updated: '2026-09-01T00:00:00.000Z',
      fm: { id: 'task-demo-001', title: '演示任务', status: '待办', priority: '高', project: 'demo' },
      path: 'C:/mock/task-data/task-demo-001.md',
    },
    // 分组视图用：一个查不到名字的项目 id（标签必须回退成 id，不能空白）+ 一个完全没项目的
    {
      id: 'task-demo-002', title: '幽灵项目任务', status: '待办', priority: '中',
      project: 'ghost-proj', tags: [], body: '',
      created: '2026-09-05T00:00:00.000Z', updated: '2026-09-10T00:00:00.000Z',
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
    // 2026-09-28：真实 frontmatter 里「项目」是**数组**（`项目: [fangcun-base]`）——
    // 卡上要显示的所属项目必须过 normProject，否则永远匹配不到名字（用户报「看不见所属项目」）。
    {
      id: 'task-demo-004', title: '数组项目的任务', status: '待验收', priority: '中',
      project: ['demo2'], tags: [], body: '',
      created: '2026-09-02T00:00:00.000Z', updated: '2026-09-02T11:22:33.000Z',
      fm: { id: 'task-demo-004', title: '数组项目的任务', status: '待验收', project: ['demo2'] },
      path: 'C:/mock/task-data/task-demo-004.md',
    },
    // 2026-09-29：日历「改法 A」（格子最多 2 条 + 「+N 条」）要**同一天有多条**才验得了。
    // 这三条全压在 FIX_DEADLINE（= 今天，与 001 同一天）；created/updated 一律取很早的日期 ——
    // 免得不小心把"排序下拉"那组断言的头名（002 / 001）挤掉。
    // ⚠ 状态**刻意各不相同**（进行中/进行中/待验收）：demo 项目的状态分布条才有 3 段可验；
    //   而且它们一律不带"待办"状态 —— 否则会挤进「待办」列，把排序断言的期望序打乱。
    {
      id: 'task-demo-011', title: '日历密度样例一', status: '进行中', priority: '中',
      project: 'demo', tags: [], body: '', deadline: FIX_DEADLINE,
      created: '2026-08-01T00:00:00.000Z', updated: '2026-08-01T00:00:00.000Z',
      fm: { id: 'task-demo-011', title: '日历密度样例一', status: '进行中', priority: '中', project: 'demo' },
      path: 'C:/mock/task-data/task-demo-011.md',
    },
    {
      id: 'task-demo-012', title: '日历密度样例二', status: '进行中', priority: '低',
      project: 'demo', tags: [], body: '', deadline: FIX_DEADLINE,
      created: '2026-08-01T00:00:00.000Z', updated: '2026-08-01T00:00:00.000Z',
      fm: { id: 'task-demo-012', title: '日历密度样例二', status: '进行中', priority: '低', project: 'demo' },
      path: 'C:/mock/task-data/task-demo-012.md',
    },
    {
      id: 'task-demo-013', title: '日历密度样例三', status: '待验收', priority: '中',
      project: 'demo', tags: [], body: '', deadline: FIX_DEADLINE,
      created: '2026-08-01T00:00:00.000Z', updated: '2026-08-01T00:00:00.000Z',
      fm: { id: 'task-demo-013', title: '日历密度样例三', status: '待验收', priority: '中', project: 'demo' },
      path: 'C:/mock/task-data/task-demo-013.md',
    },
  ],
  // demo 登记了工作目录、demo2 没有 —— 概览卡那条"未登记工作目录"的回退才有东西可验
  projects: [
    { id: 'demo', name: '演示项目', repo: 'E:/CODE/mock/demo' },
    { id: 'demo2', name: '第二个项目' },
  ],
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
  notificationsList: () => (store.notifications || []).slice(),
  // ⚠ 必须返回 Promise（真 IPC 是异步的）：渲染层写的是 `.then(...)`，
  //   返回裸数字会抛 "then is not a function" —— 这个错只会在测试跑得够久、
  //   轮询定时器触发时才现形（2026-09-26 加了服务页测试之后就跑到了这一步）
  notificationsUnreadCount: () =>
    Promise.resolve((store.notifications || []).filter(n => !n.read).length),
  notificationsScan: () => ({ ok: true }),
  // P0-4/P0-5：扫描器状态 + 被静音提醒（夹具可由测试注入）
  notificationsScannerStatus: () => (store.ncStatus || { running: true, lastScanAt: new Date().toISOString() }),
  notificationsListMuted: () => (store.ncMuted || []).slice(),
  notificationsUnmuteAll: () => { rec('notificationsUnmuteAll'); store.ncMuted = []; return (store.ncMutedCount || 0) },
  // 通知点击跳转按 sourceId 取任务（真 IPC 返回 flattenTask 或 null）
  getTask: (id) => { rec('getTask', [id]); return (store.tasks || []).find(x => x.id === id) || null },

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
  // 待办数据健康度（2026-09-26 卡 033）
  todosHealth: () => { rec('todosHealth'); return ok({ path: 'C:/mock/todos/index.json', lastError: null }) },
  todosSetPinned: (id, pinned) => {
    rec('todosSetPinned', [id, pinned])
    const t = store.todos.find(x => x.id === id)
    if (!t) return { ok: false, error: 'not found' }
    t.pinned = !!pinned
    return ok({ data: t })
  },
  todosDelete: (id) => {
    rec('todosDelete', [id])
    store.todos = store.todos.filter(x => x.id !== id)
    return ok()
  },

  // ── 日志 ───────────────────────────────────────────────────────
  // 与主进程 listLogs 一致：置顶优先（桩不排序的话，渲染层那条排序断言等于在测假数据）
  logsList: () => store.logs.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)),
  logsCreate: (title, project, content, taskId) => {
    rec('logsCreate', [title, project, content, taskId])
    const l = { id: nextId('log'), title, project, content, taskId, status: 'active', created: new Date().toISOString() }
    store.logs.push(l)
    return ok({ log: l })
  },
  logsUpdate: () => ok(),
  logsComplete: () => ok(),
  logsArchive: () => ok(),
  logsDestroy: (id) => { rec('logsDestroy', [id]); store.logs = store.logs.filter(x => x.id !== id); return ok() },
  // 卡 037：置顶 / 改归属。2026-09-28：reopen = 撤销完成/归档 → 待处理（**不再等于进行中**）
  logsReopen: (id) => {
    rec('logsReopen', [id])
    const l = store.logs.find(x => x.id === id)
    if (l) { l.status = 'active'; l.completed = null; l.running = false }
    return ok({ log: l })
  },
  // 2026-09-28 用户第 2 条：「进行中」是手动开关，唯一写入路径
  logsSetRunning: (id, running) => {
    rec('logsSetRunning', [id, running])
    const l = store.logs.find(x => x.id === id)
    if (!l) return { ok: false, error: '日志不存在' }
    if (running && l.status !== 'active') { l.status = 'active'; l.completed = null }
    l.running = !!running
    return ok({ log: l })
  },
  logsSetPinned: (id, pinned) => {
    rec('logsSetPinned', [id, pinned])
    const l = store.logs.find(x => x.id === id)
    if (!l) return { ok: false, error: '日志不存在' }
    l.pinned = !!pinned
    return ok({ log: l })
  },
  logsSetProject: (id, project) => {
    rec('logsSetProject', [id, project])
    const l = store.logs.find(x => x.id === id)
    if (!l) return { ok: false, error: '日志不存在' }
    l.project = project
    return ok({ log: l })
  },
  logsCleanup: () => [],
  // ── 附件（2026-10-01 卡 036）：假 preload 返回与真 IPC 同形的 { ok, data } ──
  logsAttachFiles: (id) => {
    rec('logsAttachFiles', [id])
    const row = (store.logs || []).find(x => x.id === id)
    if (!row) return { ok: false, error: '日志不存在' }
    // 真实现是主进程弹系统框后复制进数据目录；这里直接追加一个不同名的条目，
    // 让「点添加 → 网格多一项」这条 UI 链路可断言。
    const rel = `docs/执行日志/_attachments/${id}/新添加_${(row.attachments || []).length + 1}.png`
    row.attachments = [...(row.attachments || []), rel]
    return { ok: true, data: { ...row } }
  },
  logsDetachAttachment: (id, rel) => {
    rec('logsDetachAttachment', [id, rel])
    const row = (store.logs || []).find(x => x.id === id)
    if (!row) return { ok: false, error: '日志不存在' }
    row.attachments = (row.attachments || []).filter(x => x !== rel)
    return { ok: true, data: { ...row } }
  },
  logsAttachmentData: () => ({
    ok: true,
    // 1×1 透明 PNG，够断言「img 的 src 真是 data:image/png」
    data: { mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', name: 'x.png' },
  }),
  logsOpenAttachment: () => { rec('logsOpenAttachment', []); return { ok: true } },
  logsForTask: () => [],

  // ── 剪贴板（渲染层复制一律走主进程通道，见 shared/clipboard.ts ①）─────
  clipboardWriteText: (text) => { rec('clipboardWriteText', [text]); return ok() },

  // ── 技能安装专区（2026-09-26 卡 038）────────────────────────────
  // 一条已装（最新）+ 一条未装，正好把两种状态文案都覆盖
  skillsCheck: () => ok({ needsInstall: false, skills: [] }),
  skillsInstall: () => { rec('skillsInstall'); return ok({ installed: ['fangcun-bridge'], skipped: [], errors: [] }) },
  skillsList: () => {
    rec('skillsList')
    const dir = 'C:/mock/skills'
    const hermes = 'C:/mock/hermes/skills'
    const mk = (id, target, version, installed, body) => ({
      id, target, version,
      file: `skills/${id}/SKILL.md`,
      absPath: `${dir}/${id}/SKILL.md`,
      exists: true, bytes: 1234, installed, outdated: !installed,
      hash: 'a'.repeat(32), body,
      prompt: `请把方寸（tegula）的「${id}」这个技能装到你自己身上：\n- 技能文件（绝对路径）：${dir}/${id}/SKILL.md`,
    })
    return ok({
      version: '0.2.6', lastUpdated: '2026-09-25', skillsDir: dir, hermesDir: hermes, unlisted: [],
      skills: [
        mk('fangcun-bridge', 'Hermes', '1.0.0', true, '---\nname: 方寸接线卡\n---\n正文甲'),
        mk('skill-management-policy', 'All', '1.1.0', false, '---\nname: 技能纪律\n---\n正文乙'),
      ],
      // 多目标状态（卡 010/011）：fangcun-bridge 在 Hermes 最新、在 DSH 有更新；
      // skill-management-policy 两边都没装 —— 卡片上三种徽章文案都能被断言到。
      targets: [
        { id: 'hermes', name: 'Hermes', dir: hermes, present: true, skills: [
          { id: 'fangcun-bridge', installed: true, outdated: false },
          { id: 'skill-management-policy', installed: false, outdated: true },
        ] },
        { id: 'dsh', name: 'DSH', dir: 'C:/mock/home/.dsh/skills', present: true, skills: [
          { id: 'fangcun-bridge', installed: true, outdated: true },
          { id: 'skill-management-policy', installed: false, outdated: true },
        ] },
        { id: 'ghost', name: 'Ghost', dir: 'C:/mock/ghost/skills', present: false, skills: [
          { id: 'fangcun-bridge', installed: false, outdated: true },
          { id: 'skill-management-policy', installed: false, outdated: true },
        ] },
      ],
    })
  },
  skillsOpenDir: (which) => { rec('skillsOpenDir', [which]); return ok({ dir: which === 'hermes' ? 'C:/mock/hermes/skills' : 'C:/mock/skills' }) },

  // ── 技能直接导入（2026-09-26 卡 005）──────────────────────────────
  skillsImported: () => { rec('skillsImported'); return ok({ items: store.imported.slice() }) },
  skillsImportPick: (kind) => {
    rec('skillsImportPick', [kind])
    return ok(store.pickPath ? { path: store.pickPath } : { canceled: true })
  },
  skillsImport: (srcPath, opts) => {
    rec('skillsImport', [srcPath, !!(opts && opts.overwrite)])
    if (store.importExists && !(opts && opts.overwrite)) {
      return ok({ ok: false, code: 'exists', name: store.importName, error: `「${store.importName}」已经存在` })
    }
    // 成功之后把它挂进"已导入"列表，好让界面刷新出卡片（贴近真主进程的行为）
    if (!store.imported.some(x => x.name === store.importName)) {
      store.imported.push({
        name: store.importName, description: '刚导入的技能', version: '',
        dir: `C:/mock/hermes/skills/${store.importName}`, files: 2, bytes: 800,
        importedAt: new Date().toISOString(), source: srcPath,
      })
    }
    return ok({ ok: true, name: store.importName, target: `C:/mock/hermes/skills/${store.importName}`, files: 2, bytes: 800 })
  },
  skillsRemove: (name) => {
    rec('skillsRemove', [name])
    store.imported = store.imported.filter(x => x.name !== name)
    return ok({ ok: true, dir: `C:/mock/hermes/skills/${name}` })
  },

  // ── 服务 / 端口（2026-09-26 卡 006）：只读监控，没有"杀进程"通道 ────
  servicesList: () => {
    rec('servicesList')
    const rows = store.services.slice()
    return ok({
      rows,
      unregistered: store.servicesUnreg.slice(),
      listeningCount: rows.filter(r => r.listening).length,
      idleCount: rows.filter(r => !r.listening).length,
      duplicatePorts: [],
      hiddenCount: 12,
      servicesJsonPath: 'C:/mock/userData/services.json',
      appsJsonPath: 'C:/mock/userData/apps.json',
    })
  },
  servicesAdd: (svc) => {
    rec('servicesAdd', [svc])
    if (!svc || !String(svc.name || '').trim()) return ok({ ok: false, error: '服务名不能为空' })
    const port = Number(svc.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return ok({ ok: false, error: '端口不合法' })
    if (store.services.some(s => s.port === port)) return ok({ ok: false, error: `${port} 已经在清单里了` })
    store.services.push({ id: `manual:${port}`, name: svc.name, port, note: svc.note || '', project: '', source: 'manual', listening: false, pid: null, processName: '', duplicated: false })
    return ok({ ok: true })
  },
  servicesRemove: (port) => {
    rec('servicesRemove', [port])
    store.services = store.services.filter(s => s.port !== port)
    return ok({ ok: true })
  },
  servicesOpen: (port) => {
    rec('servicesOpen', [port])
    return ok({ ok: true, url: `http://127.0.0.1:${port}/` })
  },
  servicesAdopt: (port, name) => {
    rec('servicesAdopt', [port, name])
    store.servicesUnreg = store.servicesUnreg.filter(u => u.port !== port)
    store.services.push({ id: `manual:${port}`, name: name || `端口 ${port}`, port, note: '', project: '', source: 'manual', listening: true, pid: 1, processName: name || '', duplicated: false })
    return ok({ ok: true })
  },


  // 空闲的启动台应用一键启动（2026-09-26 回执：「服务页没看到 8090 有动静」）
  servicesStart: (port) => {
    rec('servicesStart', [port])
    const row = store.services.find(s => s.port === port)
    if (!row) return ok({ ok: false, message: `端口 ${port} 不在启动台登记里` })
    row.listening = true
    row.pid = 9999
    row.processName = 'node'
    return ok({ ok: true, message: `已启动「${row.name}」` })
  },

  // ── 装到别的 agent（2026-09-26 回执：只有 Hermes 可装；2026-10-03 卡 011：加 DSH）──
  agentsList: () => {
    rec('agentsList')
    return ok({ agents: [
      { id: 'hermes', name: 'Hermes', mode: 'installable', detected: true,
        evidence: 'C:/mock/hermes/skills', skillsDir: 'C:/mock/hermes/skills', howTo: '点上面「⚡ 装到 Hermes」',
        skillLinked: true, mcpLinked: false, linkDetail: '技能副本已装 · MCP 配置未含 fangcun' },
      { id: 'dsh', name: 'DSH (DeepSeek Harness)', mode: 'installable', detected: true,
        evidence: 'C:/mock/home/.dsh/profiles/desktop/cordis.patch.yml', skillsDir: 'C:/mock/home/.dsh/skills',
        skillLinked: false, mcpLinked: true, linkDetail: '技能副本未装 · MCP 配置含 fangcun',
        howTo: '点「⚡ 装到 DSH」写进 ~/.dsh/skills/<名>/SKILL.md' },
      { id: 'workbuddy', name: 'WorkBuddy', mode: 'manual', detected: true,
        evidence: 'C:/Program Files/WorkBuddy/WorkBuddy.exe', openPath: 'C:/Program Files/WorkBuddy/WorkBuddy.exe',
        linkDetail: '（落点不可知）',
        howTo: '显示 SKILL.md → 打开 WorkBuddy 的导入技能面板 → 拖进去' },
      { id: 'claudecode', name: 'Claude Code', mode: 'manual', detected: false,
        evidence: 'C:/mock/home/.claude', howTo: '—' },
    ] })
  },
  skillsInstallTo: (targetId) => {
    rec('skillsInstallTo', [targetId])
    return ok({ installed: ['fangcun-bridge', 'skill-management-policy'], skipped: [], errors: [] })
  },
  agentsOpen: (id) => { rec('agentsOpen', [id]); return ok({ ok: true, message: '已打开 ' + id }) },
  skillsReveal: (p) => { rec('skillsReveal', [p]); return ok({ ok: true, message: '已在资源管理器里亮出 SKILL.md' }) },

  // ── 已完成任务自动归档（2026-10-03 卡 012）──────────────────────────
  // 默认 0 条超期（设置页/看板提示条在 count=0 时都不渲染）→ 需要一个可注入的开关来测提示条。
  tasksOverdue: (days) => {
    rec('tasksOverdue', [days])
    return ok(store.overdueCount > 0
      ? { ok: true, days, count: store.overdueCount, items: store.overdueItems }
      : { ok: true, days, count: 0, items: [] })
  },
  tasksArchiveOverdue: (days) => {
    rec('tasksArchiveOverdue', [days])
    return ok({ ok: true, archived: ['task-overdue-1'], failed: [] })
  },

  // ── 回收站（2026-09-26 卡 034）────────────────────────────────
  trashRead: (name) => {
    rec('trashRead', [name])
    const it = store.trash.find(x => x.name === name)
    if (!it) return { ok: false, error: '回收站里已经找不到这个文件' }
    return { ok: true, text: `# ${it.title}\n\n正文：被删那份的原文。`, truncated: false }
  },
  trashList: () => { rec('trashList'); return { ok: true, items: store.trash.slice() } },
  trashRestore: (name) => {
    rec('trashRestore', [name])
    const i = store.trash.findIndex(x => x.name === name)
    if (i < 0) return { ok: false, error: '回收站里已经找不到这个文件' }
    const it = store.trash[i]
    store.trash.splice(i, 1)
    return ok({ to: it.name, archived: it.status === '完成' })
  },
  trashPurge: (name) => {
    rec('trashPurge', [name])
    store.trash = store.trash.filter(x => x.name !== name)
    return ok()
  },

  // ── 任务操作 ───────────────────────────────────────────────────
  editTask: (id, fields) => {
    rec('editTask', [id, fields])
    const t = store.tasks.find(x => x.id === id)
    if (t) Object.assign(t, fields)
    return ok()
  },
  newTask: () => ok(),
  // 2026-09-28：改成**记录调用** —— 多视图断言要验证"列表视图里拖一行到别的分区
  // 仍然等于改状态"。此前它只是 `() => ok()`，调没调用在 e2e 里看不出来。
  moveStatus: (id, status) => { rec('moveStatus', [id, status]); return ok() },
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

  // ── UI 偏好真身（userData/prefs.json，014 那一套）─────────────────
  // 2026-09-28 补：此前假 preload 里**根本没有 prefsGet/prefsSet** ——
  // syncBoardPrefs 的 `await window.tegula.prefsGet()` 直接抛、被 catch 吞掉，
  // 于是"偏好真的落盘了吗"在渲染层 e2e 里**永远验证不到**（只能靠源码断言猜）。
  // 现在给一个内存真身：多视图选择（fc_board_view / fc_todo_view）与分组方式
  // 都走这条路径，断言可以真读回 `__fcTest.prefs()`。
  prefsGet: () => JSON.parse(JSON.stringify(store.prefs)),
  prefsSet: (key, value) => { rec('prefsSet', [key, value]); store.prefs[key] = value; return ok() },

  // ── 其它（不参与断言，返回空实现避免 undefined 报错）──────────
  browseDirectory: () => null,
  browseFile: () => null,
  // 项目章程三态（2026-09-25 第 7 条）：demo 已填、demo2 连文件都没有。
  // 029：方针卡现在也带 structureMap（结构地图），所以走可注入的 store，测试能造「有地图 + 最后核实日期」。
  policyGet: (id) => {
    const p = store.policies ? store.policies[id] : undefined
    if (!p) return { ok: true, policy: null }
    return { ok: true, policy: Object.assign({ projectId: id, mission: '', goal: '', scenario: '', boundary: '', structureMap: '', updatedAt: '' }, p) }
  },
  policySave: (p) => { rec('policySave', [p]); return ok({ path: 'C:/mock/policies/' + (p && p.projectId) + '.md' }) },
  policyText: () => '',
  openFile: () => ok(),
  setDataDir: () => ok(),
  dataInspect: () => ok(),
  dataMigrate: () => ok(),
  createFreshSetup: () => ok(),
  importFromPythonTegula: () => ok(),
  registryAddProject: () => ok(),
  // 备份 v2（现行家族）；裸 backup/restore/listBackups 已随族3（卡004）删除 —— 夹具同步
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
  // 2026-09-28 卡 026-001：点备份行 = 校验这一份（取 manifest 摘要给用户看）
  backupVerifyPackage: (zipPath) => {
    rec('backupVerifyPackage', [zipPath])
    return ok({
      ok: true,
      path: zipPath || '',
      entries: 91,
      manifest: { createdAt: '2026-09-25T20:20:20.000Z', totalFiles: 91, totalBytes: 1097000 },
      errors: [],
    })
  },
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
  // 夹具"同一天"是哪一天（跟随今天，见文件头 FIX_DEADLINE）—— 断言要按它算期望值，
  // 禁止再写死 '09-30' 之类的字面量，否则每月 1 号假红。
  fixDeadline: FIX_DEADLINE,
  fixMmdd: FIX_MMDD,
  calls: () => JSON.parse(JSON.stringify(store.calls)),
  callCount: (name) => store.calls.filter(c => c.name === name).length,
  todos: () => JSON.parse(JSON.stringify(store.todos)),
  logs: () => JSON.parse(JSON.stringify(store.logs)),
  trash: () => JSON.parse(JSON.stringify(store.trash)),
  tasks: () => JSON.parse(JSON.stringify(store.tasks)),
  imported: () => JSON.parse(JSON.stringify(store.imported)),
  services: () => JSON.parse(JSON.stringify(store.services)),
  /** 脚本化导入行为：是否重名 / 选中的包路径（null = 用户取消） */
  setImport: (name, opts) => {
    if (name) store.importName = name
    if (opts && 'exists' in opts) store.importExists = !!opts.exists
    if (opts && 'pickPath' in opts) store.pickPath = opts.pickPath
  },
  /** 重新灌测试数据：前面的回收站测试会把两条都还原/彻底删掉，后面的预览测试要重来一遍 */
  setTrash: (items) => { store.trash = (items || []).slice() },
  setLogs: (items) => { store.logs = (items || []).slice() },
  setTodos: (items) => { store.todos = (items || []).slice() },
  setServices: (rows) => { store.services = (rows || []).slice() },
  // 通知中心点击跳转：注入通知夹具 + 任务夹具（2026-10-01 用户第 1 条）
  setNotifications: (items) => { store.notifications = (items || []).slice() },
  /** P0-4/P0-5：注入扫描器状态与被静音提醒（含被恢复的条数，供断言 toast 文案） */
  setNcExtras: (status, muted, mutedCount) => {
    if (status) store.ncStatus = status
    if (muted) store.ncMuted = muted.slice()
    if (mutedCount !== undefined) store.ncMutedCount = mutedCount
  },
  setTasks: (items) => { store.tasks = (items || []).slice() },
  /** 卡 012：注入「超期的已完成任务」条数（0 = 无 → 提示条不渲染） */
  setOverdue: (n, items) => {
    store.overdueCount = Number(n) || 0
    if (items) store.overdueItems = items.slice()
  },
  // 029：注入方针卡（含 structureMap + 最后核实日期）用
  setPolicies: (obj) => { store.policies = Object.assign({}, obj || {}) },
  // UI 偏好真身快照（多视图选择断言用：`prefs().fc_board_view === 'list'`）
  prefs: () => JSON.parse(JSON.stringify(store.prefs)),
  reset: () => { store.calls.length = 0 },
})
