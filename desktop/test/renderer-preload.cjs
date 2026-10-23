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
  // 想法（2026-10-22）：三条覆盖三种状态 ——
  //   新记（四个动作都能点）/ 已搁置（能「捡回来」）/ 已立项（能「撤销立项」且带 promoted）
  ideas: [
    { id: 'idea-a', text: '给启动台加个搜索框', status: '新记', note: '', createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z', decidedAt: '', promoted: null },
    { id: 'idea-b', text: '端口面板要不要合并进服务页', status: '已搁置', note: '等启动台稳了再说', createdAt: '2026-10-19T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z', decidedAt: '2026-10-20T10:00:00.000Z', promoted: null },
    { id: 'idea-c', text: '做个一键导出周报', status: '已立项', note: '', createdAt: '2026-10-18T10:00:00.000Z', updatedAt: '2026-10-18T12:00:00.000Z', decidedAt: '2026-10-18T12:00:00.000Z', promoted: { kind: 'todo', id: 'todo-from-idea-c' } },
  ],
  // 规划管理（2026-10-16 第 1 项）：预置 1 条带 2 决策点的规划（1 已定 1 待定），
  // 「🗂 规划」弹窗列表/详情/留痕三态都有东西可断言。
  plans: [
    {
      id: 'plan-e2e-001',
      fm: { id: 'plan-e2e-001', title: '0.3.7 发版计划', project: 'demo', status: '草稿', plan_status: 'draft' },
      plan: {
        objective: '把启动台三件事收口',
        status: 'draft',
        milestones: [{ name: '设计稿定稿', deadline: '2026-10-20' }],
        decisions: [
          { id: 'dp_001', question: '端口模型走哪版？', options: ['端口=配置项', '端口=观测结果'], status: 'decided', chosen: '端口=观测结果', decidedAt: '2026-10-16T10:00:00.000Z' },
          { id: 'dp_002', question: '发版窗口？', options: ['周五', '下周一'], status: 'pending', chosen: '', decidedAt: '' },
        ],
        risks: [],
      },
    },
  ],
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
  // 死通道接回夹具（2026-10-11 卡 20261006-002）：跨项目建议 / 阶段里程碑 / 活动日志 ——
  // 各给一条，让那几条 UI strip 有东西可渲染（空数组 = strip 不渲染，断言就验不到）。
  crossSuggest: ['优先处理卡住项目：演示项目'],
  milestones: [{ project: 'demo', project_name: '演示项目', phase: 'P0', milestone: '核心阶段完成', status: 'completed', tasks_done: 3, tasks_total: 3 }],
  activity: [{ ts: '2026-10-11T01:00:00.000Z', tid: 'task-demo-001', action: 'done', detail: '模拟完工' }],
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
  // 服务 / 端口（2026-09-26 卡 006 → 2026-10-15 改模型）
  // ⚠ 新口径：**端口是观测结果，不是配置项**。所以：
  //   · `services`（已登记行）里**只有手填**（用户认领的）；启动台应用不再往这里塞端口；
  //   · 启动台应用走 `servicesApps`（按应用列，端口来自观测）；
  //   · 旧字段 `cmd` 在手填行上恒为空串（手填没有启动命令）。
  services: [
    { id: 'manual:8753', name: '方寸看板', port: 8753, note: 'Python 版 tegula', project: '', source: 'manual', cmd: '', listening: true, pid: 1234, processName: 'python', duplicated: false },
    { id: 'manual:9100', name: '没人认领的服务', port: 9100, note: '', project: '', source: 'manual', cmd: '', listening: false, pid: null, processName: '', duplicated: false },
  ],
  // 启动台应用行（端口=观测结果）。两条对照：
  //   lp-observe：观测到过端口（:9100 现在在监听）→ 卡片/服务页要显示出来
  //   lp-empty  ：还没观测到任何端口 → 不许写「无」/「—」这类噪音，整行不渲染
  //   还有一条带**旧字段 port**（已停用）→ 要给出"该字段已停用"的提示，而不是拿它去启动
  servicesApps: [
    { id: 'lp-ronghua', name: '绒花墨坊', cmd: 'E:/Software/RongHuaMoFang/绒花墨坊.exe', path: 'E:/Software/RongHuaMoFang/绒花墨坊.exe', description: '控制台', observedPorts: [9100], listeningPorts: [9100], observedAt: '2026-10-15T10:00:00.000Z', legacyPortNote: '旧配置项 port=8090 已停用（方寸现在自动观测端口）—— 可以删掉，留着也不影响。' },
    { id: 'lp-fresh', name: '刚加的应用', cmd: 'E:/mock/serve.bat', path: 'E:/mock/serve.bat', description: '', observedPorts: [], listeningPorts: [], observedAt: '', legacyPortNote: '' },
  ],
  // 启动台登记（2026-10-15：点卡片=启动；端口不再由用户填）
  launchpad: [
    { id: 'lp-ronghua', name: '绒花墨坊', path: 'E:/Software/RongHuaMoFang/绒花墨坊.exe', cmd: 'E:/Software/RongHuaMoFang/绒花墨坊.exe', description: '控制台', observedPorts: [9100] },
    { id: 'lp-fresh', name: '刚加的应用', path: 'E:/mock/serve.bat', cmd: 'E:/mock/serve.bat', description: '' },
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
  // 2026-10-22 · 06 单：demo 补 状态 / 路线图 两字段，三行并列与就地编辑才有东西可验
  projects: [
    { id: 'demo', name: '演示项目', repo: 'E:/CODE/mock/demo',
      状态: '活跃开发中（演示夹具）', 路线图: '跑通第一单',
      说明: '演示用项目——说明条转正断言靠这条（批次第 2 项）' },
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
    // 2026-10-17 暮雨第 2 条（快选要**叠加**，不能冲掉上一组）：叠加必须有两种状态才验得动，
    // 归档区补一条「驳回」—— 刻意不用待办/进行中：那两个是未完成态，会把
    // 「只看未完成勾选后一张不剩（archAfter===0）」的断言搞红。驳回和完成一样是终态
    // （boardCards.DONE = 完成+驳回），快选叠加能测，终态过滤语义不破。
    {
      id: 'task-demo-092', title: '被驳回的归档任务', status: '驳回', priority: '中',
      project: 'demo', tags: [], body: '',
      created: '2026-08-02T00:00:00.000Z', updated: '2026-08-02T00:00:00.000Z',
      fm: { id: 'task-demo-092', title: '被驳回的归档任务', status: '驳回' },
      path: 'C:/mock/task-data/archive/task-demo-092.md',
    },
  ],
}

function rec(name, args) {
  store.calls.push({ name, args: JSON.parse(JSON.stringify(args || [])) })
}

let seq = 0
const nextId = (p) => `${p}-${Date.now()}-${(seq++).toString(36)}`

const ok = (extra) => Object.assign({ ok: true }, extra || {})

/**
 * 结构化克隆校验 —— 复刻真机 contextBridge 的**第一跳**语义。
 *
 * 2026-10-05 踩的坑（用户原话「勾一下闪退一下」= 勾选写不进盘）：
 *   渲染层把 **Vue 响应式代理**（`ref([]).value`、v-for 元素）直接当 IPC 载荷传，
 *   真机在「页面世界 → 隔离世界」这一跳就抛 `An object could not be cloned` ——
 *   **报文根本进不到 preload，更进不到主进程**（所以主进程日志里一个字都没有）。
 *   假 preload 此前不做克隆校验 → 这个 bug 在渲染层 e2e 里测不出来（真机必崩、测试全绿）。
 * 现在按真机语义补上：参数克隆不过，就当它是真机里的那种失败（让测试红，而不是静默通过）。
 */
const cloneGuard = (name, args) => {
  for (const a of args) {
    try {
      structuredClone(a)
    } catch (e) {
      throw new Error(`[假 preload] ${name} 的参数不可结构化克隆（Vue 响应式代理？）——`
        + ` 真机 contextBridge 会抛 "An object could not be cloned"，报文进不到 preload/主进程。`
        + ` 修法：传参前过 toPlain()。原始错误：${e && e.message}`)
    }
  }
}

// 表单字段规格 —— 抽成常量，`taskFieldSpecs` 与 `taskFormValues` 共用一份。
// ⚠ 必须与主进程 `TASK_FIELD_SPECS` 逐条同步（少一条 = 条件显示 / 表单回填的断言永远验不到）。
const TASK_FIELD_SPECS = [
  { key: 'title', label: '标题', type: 'text', span: 'full' },
  { key: 'project', label: '项目', type: 'select', span: 'half', optionsFrom: 'projects' },
  // ⚠ 2026-10-17：这里原来只有 5 个状态（缺「待审批」和「待验收」），与主进程 `STATUSES`
  //   的 7 个**不同步** —— 于是"状态下拉里必须有待验收"这类断言在沙箱里永远找不到元素。
  //   假 preload 与真实现必须逐字一致（MEMORY 第五节），少一个都是自欺。
  { key: 'status', label: '状态', type: 'select', span: 'half', options: ['草稿', '待审批', '待办', '进行中', '待验收', '完成', '驳回'] },
  { key: 'priority', label: '优先级', type: 'select', span: 'half', options: ['高', '中', '低'] },
  { key: 'start', label: '开始', type: 'text', span: 'half' },
  { key: 'deadline', label: '截止', type: 'text', span: 'half' },
  { key: 'batch', label: '批次', type: 'text', span: 'half' },
  { key: 'tags', label: '标签', type: 'tags', span: 'full' },
  { key: 'blockers', label: '阻塞', type: 'list', span: 'full' },
  { key: 'memo', label: '附言', type: 'textarea', span: 'full' },
  // 2026-10-13（暮雨第 3 条）：架构图字段 + **条件显示**。
  {
    key: 'architecture', label: '架构图', type: 'textarea', span: 'full',
    visibleWhen: { hasValue: true, tag: '项目说明', titlePrefix: '项目说明' },
  },
  { key: 'body', label: '正文', type: 'textarea', span: 'full' },
]

contextBridge.exposeInMainWorld('tegula', {
  // ── 启动期必需面 ────────────────────────────────────────────────
  isFirstRun: () => { rec('isFirstRun'); return false },
  getDataDir: () => { rec('getDataDir'); return 'C:/mock-data' },
  selfCheck: () => { rec('selfCheck'); return ok({ message: 'OK' }) },
  taskFieldSpecs: () => {
    rec('taskFieldSpecs')
    return TASK_FIELD_SPECS
  },
  taskEnums: () => ({ statuses: ['草稿', '待审批', '待办', '进行中', '待验收', '完成', '驳回'], priorities: ['高', '中', '低'] }),
  loadTasks: (v) => { rec('loadTasks', [v]); return (v === 'archive' ? (store.archived || []) : store.tasks).slice() },
  loadProjects: () => store.projects.slice(),
  // 阻塞源夹具（2026-10-09 监控台断言）：demo 项目压着 1 条阻塞 → 详情页
  // 「⚠ 1 个阻塞源 · 看卡在谁」入口必须出现（pvBlocked 按被阻塞任务所属项目计）。
  findBlockers: () => [
    { id: 'task-demo-001', title: '演示任务', blockers: ['task-demo-002'] },
  ],
  parseErrors: () => [],
  allProjectProgress: () => ({}),
  // ── Plan 四通道（2026-10-16 第 1 项）：真 preload 早已暴露、渲染层今天接；
  //    假实现贴 main/data/tasks.ts 同语义（decidePlanPoint 全定完自动转 active）。
  createPlan: (fields) => {
    rec('createPlan', [fields])
    const id = 'plan-e2e-' + String((store.plans.length + 1)).padStart(3, '0')
    const t = {
      id,
      fm: { id, title: fields.title, project: fields.project || '', status: '草稿', plan_status: 'draft' },
      plan: {
        objective: fields.objective || '', status: 'draft',
        milestones: fields.milestones || [],
        decisions: (fields.decisions || []).map((d, i) => ({ id: 'dp_' + String(i + 1).padStart(3, '0'), question: d.question, options: d.options, status: 'pending', chosen: '', decidedAt: '' })),
        risks: fields.risks || [],
      },
    }
    store.plans.push(t)
    return { id, task: t }
  },
  listPlans: () => { rec('listPlans', []); return store.plans.slice() },
  getPlan: (id) => { rec('getPlan', [id]); const t = store.plans.find(p => p.id === id); return t ? { task: t, plan: t.plan } : null },
  decidePlanPoint: (id, dpId, choice) => {
    rec('decidePlanPoint', [id, dpId, choice])
    const t = store.plans.find(p => p.id === id)
    if (!t) return { ok: false, error: '任务不存在' }
    const dp = t.plan.decisions.find(d => d.id === dpId)
    if (!dp) return { ok: false, error: `决策点 ${dpId} 不存在` }
    dp.status = 'decided'; dp.chosen = choice; dp.decidedAt = new Date().toISOString()
    if (t.plan.decisions.every(d => d.status !== 'pending') && t.plan.status === 'draft') {
      t.plan.status = 'active'; t.fm.plan_status = 'active'; t.fm.status = '进行中'
    }
    return { ok: true }
  },
  // 停滞卡（2026-10-11 监控台 P0）：夹具给一条**属于 demo 项目**的 —— 让监控台那块有东西可断。
  // 不给的话"僵尸卡"整块永远不渲染，断言就成空转（反面教材见 tegula-testing：
  // 假 preload 缺 API → await 抛了被 catch 吞掉 → 那条断言永远验不到）。
  stalledTasks: () => ([{ id: 'task-demo-011', title: '日历密度样例一', hours: 30 }]),
  // Git 通道 + restic 脚本（2026-10-11）：**必须给，哪怕是空实现** ——
  // 渲染层 await 一个不存在的 API 会抛，而调用点大多包了 try/catch，
  // 结果就是"那条断言永远验不到"（tegula-testing 里的反面教材）。
  backupGitStatus: () => ({ ok: true, config: { remote: '', branch: 'main' }, hasToken: false }),
  backupGitSave: (patch) => ({ ok: true, ...(patch && patch.remote ? {} : {}) }),
  backupGitSaveToken: () => ({ ok: true, persistent: true }),
  backupGitClearToken: () => ({ ok: true }),
  backupGitTest: () => ({ ok: false, message: '（夹具：没有真 git）' }),
  // ⚠ 2026-10-12：这里**必须** rec —— 顶栏「⟳ 同步」按钮的断言判据就是"真调到没有"
  //   （`callCount('backupGitPush')` 涨没涨）。此前它是裸箭头函数、从不计数
  //   → 断言恒 `calls=0`，把"按钮真的接线了"误报成"装饰按钮"（假红）。
  //   全局纪律：凡是断言要按"调用次数"判的通道，假 preload 里**一律先 rec**。
  backupGitPush: () => {
    rec('backupGitPush', [])
    return { ok: false, message: '（夹具：没有真 git）' }
  },
  backupResticScript: () => ({ ok: true, script: '# 夹具脚本' }),
  loadActivity: (n) => { rec('loadActivity', [n]); return store.activity.slice() },
  // 阻塞链夹具（2026-10-22 修）：此前一律返回 [] —— 于是"阻塞页有没有东西"从来没被验过，
  // 拆视图组件时页是空的也照样全绿。现在给一条真形状的链（源卡 + 被它挡住的卡）。
  getBlockerChains: () => {
    rec('getBlockerChains')
    return [{
      id: 'task-demo-002',
      title: '卡住别人的演示任务',
      status: '待办',
      blockedTasks: [{ id: 'task-demo-001', title: '被挡住的演示任务', status: '待办' }],
    }]
  },
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
  todosCreate: (title, priority, due, project, fromLog, dueTime) => {
    rec('todosCreate', [title, priority, due, project, fromLog, dueTime])
    const t = {
      id: nextId('todo'), title: String(title || ''), done: false,
      priority: priority || '中', due: due || undefined, project: project || undefined,
      // 卡 004：只有「日志转来」这条路带值（与真身 createTodo 同口径：无值不落键）
      fromLog: fromLog ? String(fromLog) : undefined,
      // 2026-10-12 可选时间：空串 → 不落键（与真身 normalizeDueTime 同口径）
      dueTime: dueTime ? String(dueTime) : undefined,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    store.todos.push(t)
    return ok({ todo: t })
  },
  todosUpdate: (id, updates) => {
    rec('todosUpdate', [id, updates])
    const t = store.todos.find(x => x.id === id)
    if (!t) return { ok: false, error: 'not found' }
    // 与真身同口径：dueTime 传空串 = **清空字段**（不是存空串）
    if (updates && 'dueTime' in updates && !updates.dueTime) {
      const { dueTime, ...rest } = updates
      Object.assign(t, rest)
      delete t.dueTime
    } else {
      Object.assign(t, updates)
    }
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

  // ── 想法（2026-10-22）────────────────────────────────────────────
  // 桩必须复刻主进程的**四条硬语义**，否则断言等于在测假数据：
  //   ① 「已立项」不许走 setStatus 进来；② 立项必须真往 store.todos 塞一条；
  //   ③ 撤销立项要删掉那条待办；④ 删掉的东西能原样插回来。
  ideasList: () => {
    rec('ideasList')
    return store.ideas.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  },
  ideasSummary: () => {
    rec('ideasSummary')
    const out = { 新记: 0, 已立项: 0, 已搁置: 0, 已否决: 0 }
    for (const i of store.ideas) out[i.status] += 1
    return out
  },
  ideasAdd: (text) => {
    rec('ideasAdd', [text])
    const t = String(text || '').trim()
    if (!t) return { ok: false, error: '念头是空的 —— 写一句再存' }
    const dup = store.ideas.find((i) => i.status === '新记' && i.text.trim() === t)
    if (dup) return { ok: true, idea: JSON.parse(JSON.stringify(dup)), duplicate: true }
    const now = new Date().toISOString()
    const idea = { id: nextId('idea'), text: t, status: '新记', note: '', createdAt: now, updatedAt: now, decidedAt: '', promoted: null }
    store.ideas.push(idea)
    return { ok: true, idea: JSON.parse(JSON.stringify(idea)), duplicate: false }
  },
  ideasSetStatus: (id, status, note) => {
    rec('ideasSetStatus', [id, status, note])
    if (status === '已立项') return { ok: false, error: '「立项」要走「做」那个动作' }
    const i = store.ideas.find((x) => x.id === id)
    if (!i) return { ok: false, error: '没有这条想法（可能已经删了）' }
    if (i.status === '已立项') return { ok: false, error: '这条已经立项了' }
    const before = { status: i.status, note: i.note }
    i.status = status
    if (note !== undefined) i.note = String(note || '')
    i.decidedAt = status === '新记' ? '' : (i.decidedAt || new Date().toISOString())
    i.updatedAt = new Date().toISOString()
    return { ok: true, idea: JSON.parse(JSON.stringify(i)), before }
  },
  ideasPromote: (id) => {
    rec('ideasPromote', [id])
    const i = store.ideas.find((x) => x.id === id)
    if (!i) return { ok: false, error: '没有这条想法（可能已经删了）' }
    if (i.status === '已立项') return { ok: false, error: '已经立项过了' }
    // 真往待办塞一条 —— 与主进程 promoteIdea 同语义
    const now = new Date().toISOString()
    const todo = { id: nextId('todo'), title: i.text.split('\n')[0].trim(), done: false, priority: '中', createdAt: now, updatedAt: now }
    store.todos.push(todo)
    i.status = '已立项'
    i.decidedAt = i.decidedAt || now
    i.updatedAt = now
    i.promoted = { kind: 'todo', id: todo.id }
    return { ok: true, idea: JSON.parse(JSON.stringify(i)), todoId: todo.id }
  },
  ideasUnpromote: (id) => {
    rec('ideasUnpromote', [id])
    const i = store.ideas.find((x) => x.id === id)
    if (!i) return { ok: false, error: '没有这条想法' }
    if (i.status !== '已立项' || !i.promoted) return { ok: false, error: '这条还没立项，没得撤' }
    const t = store.todos.find((x) => x.id === i.promoted.id)
    if (t && t.done) return { ok: false, error: '那条待办你已经做完了 —— 撤不了立项' }
    if (t) store.todos = store.todos.filter((x) => x.id !== t.id)
    i.status = '新记'
    i.decidedAt = ''
    i.promoted = null
    i.updatedAt = new Date().toISOString()
    return { ok: true, idea: JSON.parse(JSON.stringify(i)) }
  },
  ideasDelete: (id) => {
    rec('ideasDelete', [id])
    const idx = store.ideas.findIndex((x) => x.id === id)
    if (idx < 0) return { ok: false, error: '没有这条想法（可能已经删了）' }
    const removed = store.ideas.splice(idx, 1)[0]
    return { ok: true, removed: JSON.parse(JSON.stringify(removed)) }
  },
  ideasRestore: (idea) => {
    rec('ideasRestore', [idea])
    if (!idea || !idea.id) return { ok: false, error: '没有可恢复的内容' }
    if (store.ideas.some((x) => x.id === idea.id)) return { ok: false, error: '这条已经回来了' }
    store.ideas.push(JSON.parse(JSON.stringify(idea)))
    return { ok: true, idea: JSON.parse(JSON.stringify(idea)) }
  },
  ideasHealth: () => { rec('ideasHealth'); return { ok: true, path: '', lastError: null } },

  // ── 日志 ───────────────────────────────────────────────────────
  // 与主进程 listLogs 一致：置顶优先（桩不排序的话，渲染层那条排序断言等于在测假数据）
  logsList: () => store.logs.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)),
  logsCreate: (title, project, content, taskId, extra) => {
    rec('logsCreate', [title, project, content, taskId, extra])
    const l = { id: nextId('log'), title, project, content, taskId, status: 'active', created: new Date().toISOString(),
      ...(extra && extra.priority ? { priority: extra.priority } : {}),
      // 卡 004：来源链随 extra 落到夹具上，防重断言才验得到真路径
      ...(extra && extra.fromTodo ? { fromTodo: extra.fromTodo } : {}) }
    store.logs.push(l)
    return ok({ log: l, data: l })
  },
  // 2026-10-09：把真实语义搬进桩 —— 真后端 logs.ts:495 拒改非 active 日志，
  // 桩此前无条件 ok() = 桩-现实漂移（批量优先级的「跳过 N 条」会永远测不到）。
  logsUpdate: (id, updates) => {
    rec('logsUpdate', [id, updates])
    const l = (store.logs || []).find(x => x.id === id)
    if (!l) return { ok: false, error: '日志不存在' }
    if (l.status !== 'active') return { ok: false, error: `日志状态为 ${l.status}，无法编辑` }
    Object.assign(l, updates)
    return ok()
  },
  // 2026-10-17：桩此前是 `() => ok()` —— 既不记账也不动状态，于是「保存并完成 = 先
  // logsUpdate 再 logsComplete」这类**顺序断言恒红**（调用都发生了，桩看不见）。
  // 按真后端 logs.ts 语义补：记账 + 状态置「完成」。
  logsComplete: (id, payload) => {
    rec('logsComplete', [id, payload])
    const l = (store.logs || []).find(x => x.id === id)
    // ⚠ 2026-10-21：这里原写 `l.status = '完成'` —— 真后端是 `'completed'`（logs.ts:659）。
    //   桩的错值和界面的 `status !== 'completed'` 判据对不上，于是"完成后卡片变成什么样"
    //   在无头断言里永远验不出来（假绿）。改用真值，并补上 completed 时间戳。
    if (l) { l.status = 'completed'; l.completed = new Date().toISOString(); l.running = false }
    return ok()
  },
  // 2026-10-09：真后端 archiveLog 会把 status 置 archived，桩此前无条件 ok() 不动状态
  // （「转换后源日志进了已归档分区」这种断言会恒绿假过）—— 搬真实语义进桩。
  logsArchive: (id) => {
    rec('logsArchive', [id])
    const l = (store.logs || []).find(x => x.id === id)
    if (l) l.status = 'archived'
    return ok()
  },
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
  // 2026-10-13 暮雨第 2 条：按日期批量清理「已归档」日志（软删）。
  // 桩与真后端同形：dryRun 只报命中、**不改 store**；非 dryRun 才把命中项移出。
  logsPurgeArchived: (beforeDate, opts) => {
    rec('logsPurgeArchived', [beforeDate, opts])
    const dryRun = !!(opts && opts.dryRun)
    const cut = String(beforeDate || '').slice(0, 10)
    const hit = (store.logs || []).filter(l => l.status === 'archived' && String(l.created || '').slice(0, 10) < cut)
    const ids = hit.map(l => l.id)
    const titles = hit.map(l => l.title || '')
    if (dryRun) return { ok: true, dryRun: true, count: ids.length, ids, titles }
    if (!ids.length) return { ok: true, dryRun: false, count: 0, ids: [], titles: [] }
    store.logs = (store.logs || []).filter(l => !ids.includes(l.id))
    return { ok: true, dryRun: false, count: ids.length, ids, titles, trashDir: 'mock/.trash' }
  },
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
  // 自仓启动同步状态（2026-10-21 · W1-1C）：真主进程启动时跑完 git pull 后给结果，
  // 桩默认「已是最新」；断言用 __fcTest.setSelfSync() 换成「待同步」再看界面说没说真话。
  // 项目路线文档实况（2026-10-21 · W1-批次 2）：真主进程读仓库 README/ROADMAP + 最近 docs 变更。
  // 桩给一份「两份文档都在 + 一条 docs 提交」的常态；断言用 __fcTest.setProjectDocs() 换形态。
  projectDocs: (projectId) => {
    rec('projectDocs', [projectId])
    return store.projectDocs || {
      ok: true, repo: 'E:/CODE/mock/demo', cached: false, readAt: '2026-10-21T00:00:00.000Z', note: '',
      readme: {
        rel: 'README.md', title: '演示项目', bytes: 1024, mtime: '2026-10-19T00:00:00.000Z',
        excerpt: '一个用来跑断言的演示项目，README 默认显示两行摘要。第二段也进摘要，因为它常常才是有信息量的那句。',
        more: '一个用来跑断言的演示项目，README 默认显示两行摘要。第二段也进摘要，因为它常常才是有信息量的那句。展开之后还能看到第三段与第四段的内容，用来验证点开确实读到了 more。',
      },
      roadmap: {
        rel: 'docs/ROADMAP.md', title: '路线图', bytes: 2048, mtime: '2026-10-20T00:00:00.000Z',
        excerpt: '下一步：把看板分组做成可折叠的分区头。',
        more: '下一步：把看板分组做成可折叠的分区头。再往后：把 15074 行拆成组件。',
      },
      docsCommits: [{ hash: 'abc1234', date: '2026-10-20', subject: 'docs: 补 W1 施工单', files: ['docs/方寸-W1地基施工单.md'] }],
    }
  },
  selfSyncStatus: () => {
    rec('selfSyncStatus')
    return store.selfSync || { state: 'ok', at: '2026-10-21T00:00:00.000Z', message: '已是最新', repo: 'C:/mock/repo' }
  },
  logsForTask: (taskId) => {
    rec('logsForTask', [taskId])
    // 2026-10-21：此前恒返回 `[]` —— 「任务详情的关联日志」那块在无头断言里是**死的**
    // （连"完成后这里有没有撤销按钮"都验不了）。按真后端语义补：按 taskIds 过滤。
    // ⚠ 真后端返回的是**数组本身**（不是 {ok:...}），桩必须同形状。
    return (store.logs || []).filter(l => (l.taskIds || []).indexOf(taskId) >= 0)
  },

  // ── 剪贴板（渲染层复制一律走主进程通道，见 shared/clipboard.ts ①）─────
  clipboardWriteText: (text) => { rec('clipboardWriteText', [text]); return ok() },

  // ── 技能安装专区（2026-09-26 卡 038）────────────────────────────
  // 一条已装（最新）+ 一条未装，正好把两种状态文案都覆盖
  skillsCheck: () => {
    rec('skillsCheck')
    return ok({
      targetId: 'hermes', targetName: 'Hermes', needsInstall: false,
      skills: [{ name: 'fangcun-bridge', installed: true, outdated: false, hash: 'abc' }],
    })
  },
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
    const apps = (store.servicesApps || []).slice()
    return ok({
      rows,
      apps,
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


  // ⚠ 2026-10-16（用户第 2 条）：`servicesStartApp`（启动应用 + 观测端口）已随
  //   服务页「启动台应用」分区一起删除 —— 真 preload 里也没有了。
  //   假 preload 与真 preload 必须同步：留着它会造出"界面以为有这个通道"的假绿。

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
  // ── MCP 接入材料（2026-10-23 补）────────────────────────────────────
  // 此前**一组都没有**：`typeof t.mcpInfo !== 'function'` 恒为 true，于是 MCP 那一区
  // 在任何断言里都是空的（永远「检测中…」），组件拆坏了也没人知道。
  // 现在按主进程真实形状给：两个入口（A 可用 / B 不可用）+ 两个目标（一个检测到、一个没有）。
  mcpInfo: () => {
    rec('mcpInfo')
    return ok({
      entries: [
        { id: 'A', label: 'MCP 客户端配置（A）', available: true, usage: '写进对方的 MCP servers 段', detail: '' },
        { id: 'B', label: '整文件替换（B）', available: false, usage: '', detail: '需要对方没有既有配置才可用' },
      ],
      targets: [
        { id: 'hermes', name: 'Hermes', detected: true, evidence: 'C:/mock/hermes/config.json',
          configPath: 'C:/mock/hermes/config.json', howTo: '复制配置段 → 打开配置文件粘贴保存' },
        { id: 'dsh', name: 'DSH', detected: false, evidence: 'C:/mock/home/.dsh/cordis.patch.yml',
          configPath: 'C:/mock/home/.dsh/cordis.patch.yml', howTo: '复制配置段 → 粘贴保存' },
      ],
    })
  },
  mcpSnippet: (targetId, entryId) => {
    rec('mcpSnippet', [targetId, entryId])
    return ok({ ok: true, snippet: '[mcp_servers.fangcun]\ncommand = "node"  # entry=' + entryId + ' target=' + targetId })
  },
  mcpSelfInstall: (targetId, entryId) => {
    rec('mcpSelfInstall', [targetId, entryId])
    return ok({ ok: true, prompt: '把 fangcun 的 MCP 配置写进你自己的配置（entry=' + entryId + '）' })
  },
  mcpOpenConfig: (targetId) => {
    rec('mcpOpenConfig', [targetId])
    return ok({ ok: true, message: '已打开 ' + targetId + ' 的配置文件' })
  },
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
  // 2026-10-18 Bundle A：此前是 `() => ok()` —— 返回布尔形状，与真主进程
  // `{ ok: 数量, fails: [...] }` 不符（批量栏 toast 会把数量显示成 "true"）；
  // 且不落 store，"确定改期后卡面日期刷新"这类断言无从验起。改成真改 + 记录调用。
  batchEdit: (ids, fields) => {
    rec('batchEdit', [ids, fields])
    const list = Array.isArray(ids) ? ids : []
    let n = 0
    for (const id of list) {
      const t = (store.tasks || []).find((x) => x.id === id)
      if (t) {
        t.fm = { ...(t.fm || {}), ...(fields || {}) }
        // 真身 loadTasks 会把 fm 摊平到顶层（渲染层 `t.deadline || t.fm.deadline` 双读、
        // fixTodayCount 也按顶层判据数）—— mock 这里同步摊，否则改动对顶层不可见
        for (const k of Object.keys(fields || {})) t[k] = fields[k]
        n++
      }
    }
    const fails = list
      .filter((id) => !(store.tasks || []).some((x) => x.id === id))
      .map((id) => ({ id, error: '任务不存在' }))
    return { ok: n, fails }
  },
  batchArchive: () => ok(),
  batchDelete: () => ok(),
  archiveTask: () => ok(),
  unarchiveTask: () => ok(),
  deleteTask: () => ok(),
  copyTask: () => ok(),
  // 2026-10-13：此前是 `() => ({})`（永远空表单）。「架构图」的条件显示与表单回填都靠它拿值 ——
  // 空对象会让"有值才显示"永远不成立（断言假绿/假红都踩过）。**照真身口径**：
  // 读 `task.fm[key]`（不认扁平键），数组类 join 成逗号串 —— 与 data.taskToFormValues 同形。
  taskFormValues: (id) => {
    rec('taskFormValues', [id])
    const t = (store.tasks || []).find(x => x.id === id)
    if (!t || !t.fm) return {}
    const out = {}
    for (const s of TASK_FIELD_SPECS) {
      if (s.key === 'body') { out.body = t.body == null ? '' : String(t.body); continue }
      const v = t.fm[s.key]
      if (s.type === 'tags' || s.type === 'list') {
        out[s.key] = Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v))
      } else {
        out[s.key] = v == null ? '' : String(v)
      }
    }
    return out
  },
  naturalQuery: () => [],
  getRoadmapTrend: () => ({}),
  suggestCrossProject: () => { rec('suggestCrossProject'); return store.crossSuggest.slice() },
  detectParallelOpportunities: () => [],
  suggestMilestones: () => { rec('suggestMilestones'); return store.milestones.slice() },
  suggestActions: () => [],
  quickAdd: (t) => {
    rec('quickAdd', [t])
    const title = String(t || '')
    store.tasks.unshift({
      id: 'task-quick-1', title, status: '待办', priority: '', project: '', tags: [], body: '',
      created: new Date().toISOString(), updated: new Date().toISOString(),
      fm: { id: 'task-quick-1', title, status: '待办' },
      path: 'C:/mock/task-data/task-quick-1.md',
    })
    return ok({ id: 'task-quick-1' })
  },
  backupSizeReport: () => ok({ report: { ok: true, root: 'C:/mock', files: 3, totalBytes: 1024, keptBytes: 1024, omittedBytes: 0, omitted: [], byTop: [], logAttachments: { bytes: 0, files: 0 }, largest: [] } }),
  cronCheck: () => ({}),

  // ── 启动台 ─────────────────────────────────────────────────────
  // ⚠ 返回形状跟真主进程一致：loadApps 直接回**数组**（不是 {ok}），launchApp/openFolder 回 {ok,...}
  launchpadLoadApps: () => store.launchpad.slice(),
  // ⚠ 2026-10-17：这三个原来**不记账**（直接返回 store.launchpad）—— 于是"点删除有没有真走到 IPC"
  //   这类断言恒红/测不出来。桩必须 rec，"看起来像真 preload"不等于能验顺序。
  launchpadAddApp: (input) => { rec('launchpadAddApp', [input]); return store.launchpad.slice() },
  launchpadUpdateApp: (id, updates) => { rec('launchpadUpdateApp', [id, updates]); return store.launchpad.slice() },
  launchpadRemoveApp: (id) => { rec('launchpadRemoveApp', [id]); return store.launchpad.slice() },
  launchpadLaunchApp: (app) => { rec('launchpadLaunchApp', [app && app.id]); return ok({ pid: 4242, message: `已启动：${app && app.name}` }) },
  launchpadOpenFolder: (p) => { rec('launchpadOpenFolder', [p]); return ok({ message: '已打开' }) },
  launchpadOpenFolder: () => ok(),
  launchpadOpenUrl: () => ok(),
  launchpadGetConfigPath: () => 'C:/mock/apps.json',

  // ── 诊断日志（新通道；渲染层错误上报会用到）────────────────────
  applogPath: () => 'C:/mock/data/logs/fangcun-20260922.log',
  applogTail: () => [],
  applogOpenDir: () => ok(),
  applogWrite: (level, scope, message, detail) => { rec('applogWrite', [level, scope, message, detail]); return ok() },

  // ── UI 偏好真身（userData/prefs.json，014 那一套）─────────────────
  // 2026-09-28 补：此前假 preload 里**根本没有 prefsGet/prefsSet** ——
  // syncBoardPrefs 的 `await window.tegula.prefsGet()` 直接抛、被 catch 吞掉，
  // 于是"偏好真的落盘了吗"在渲染层 e2e 里**永远验证不到**（只能靠源码断言猜）。
  // 现在给一个内存真身：多视图选择（fc_board_view / fc_todo_view）与分组方式
  // 都走这条路径，断言可以真读回 `__fcTest.prefs()`。
  //
  // ⚠ 2026-10-05 又踩了同一个坑（「勾一下闪退一下」= 勾选写不进盘）：渲染层把 **Vue 响应式代理**
  //   （`ref([]).value`、v-for 元素）直接当 IPC 载荷 → 真机 contextBridge 在「页面→隔离世界」
  //   这一跳就抛 `An object could not be cloned`（preload 与主进程都收不到，日志里一个字都没有）。
  //   假 preload 不做克隆校验 → 这个 bug **在渲染层 e2e 里测不出来**（真机必崩、测试全绿）。
  //   所以这里按真机语义补上：参数过不了结构化克隆，就当它是真机里的那种失败。
  prefsGet: () => JSON.parse(JSON.stringify(store.prefs)),
  prefsSet: (key, value) => { cloneGuard('prefsSet', [key, value]); rec('prefsSet', [key, value]); store.prefs[key] = value; return ok() },
  // 2026-10-05 补：在途一屏的「保存」改走**一次写多键 + 回读校验**（prefs:setMany）。
  // 假 preload 缺这个 API 的话，渲染层的 `?.prefsSetMany?.(...)` 会静默变 undefined，
  // 「保存到底写没写进去」在渲染层 e2e 里就**永远验证不到**（记忆里的老坑）。
  prefsSetMany: (patch) => {
    cloneGuard('prefsSetMany', [patch])
    rec('prefsSetMany', [patch])
    const written = []
    for (const [k, v] of Object.entries(patch || {})) { store.prefs[k] = JSON.parse(JSON.stringify(v)); written.push(k) }
    return { ok: true, written }
  },

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
  // 在途一屏（Q2）：夹具可注入。默认两行 ——
  //   demo  = 有契约 + 有卡（current 来自任务卡）
  //   demo2 = 无契约 + 0 卡 + 有日志（current 回落日志）、健康度**人工锁定**
  tripBoard: () => ok(store.tripBoard || {
    generatedAt: '2026-10-05 11:00',
    mode: 'auto',
    criteria: 'cards_or_commit',
    rows: [
      {
        id: 'demo', name: '演示项目', repo: 'E:/CODE/mock/demo',
        contract: {
          exists: true, path: 'E:/CODE/mock/demo/立项契约.md',
          endState: '桌面客户端为主产品。', acceptLine: '', notWant: '', choice: '',
          sections: [{ name: '① 终态形态', field: '终态形态' }], filled: ['终态形态'],
          placeholderFields: [], unmatched: [],
        },
        current: { text: '正在做的事', from: 'task', sub: '' },
        next: { text: '要做的下一件', from: 'task', sub: '1 张待办（最高：中）' },
        who: { text: 'hermes（执行）', kind: 'exec' },
        // 2026-10-22 · 03 任务三：四栏台账第四栏（demo2 刻意留空 → 界面必须写「未写」）
        owe: '欠着：①夹具欠账 ②第二件',
        health: { value: 'active', locked: false },
        counts: { todo: 1, doing: 1, review: 0, logs: 0 },
        lastCommit: '1 天前', recentCommit: true, dirty: 3,
        flags: { noCards: false, noLogs: true },
      },
      {
        id: 'demo2', name: '第二个项目', repo: '',
        contract: {
          exists: false, path: '', endState: '', acceptLine: '', notWant: '', choice: '',
          sections: [], filled: [], placeholderFields: [], unmatched: [],
        },
        current: { text: '进度日志1001', from: 'log', sub: '3 天前' },
        next: { text: '', from: '', sub: '' },
        who: { text: '', kind: 'none' },
        health: { value: 'paused', locked: true },
        counts: { todo: 0, doing: 0, review: 0, logs: 7 },
        lastCommit: '3 天前', recentCommit: true, dirty: 0,
        flags: { noCards: true, noLogs: false },
      },
    ],
    // 登记了但没进这一屏的项目（判据没命中）—— 界面要显式说出来
    hidden: [
      { id: 'demo3', name: '还没开工的项目', kind: 'no-activity', reason: '没有任务卡、没有执行日志，30 天内也没有提交' },
    ],
  }),
  contractText: () => ok({ exists: false, text: '## ① 终态形态\n', path: '', repo: '' }),
  tripOpenRepo: () => ok({ repo: 'E:/CODE/mock/demo' }),
  tripInitContract: () => ok({ path: 'E:/CODE/mock/demo/立项契约.md' }),
  openFile: (p) => { rec('openFile', [p]); return ok() },
  setDataDir: () => ok(),
  dataInspect: () => ok(),
  dataMigrate: () => ok(),
  createFreshSetup: () => ok(),
  importFromPythonTegula: () => ok(),
  registryAddProject: () => ok(),
  // ── 随问（2026-10-22 · 施工单包 03 任务一）────────────────────────────
  // 桩复刻主进程语义的**最小版**：结构化命中 → needsLlm=false；算不出来 → needsLlm=true。
  // ⚠ 必须记账：断言要验"点常用问题真的把原串传下去了""点交给 AI 才真调 llmAsk"。
  askPresets: () => {
    rec('askPresets')
    return {
      // ⚠ 与主进程 services/ask.ASK_PRESETS 逐字一致（含 group / hint）——
      //   假 preload 少一栏，界面就会退化成"一个『常用』组里挤九个按钮"（2026-10-22 真踩过）。
      presets: [
        { label: '都在哪一步', q: '各项目都到哪了', group: '看进展', hint: '一行一个项目：现在做到哪、下一步是什么' },
        { label: '下一步干什么', q: '下一步该做什么', group: '看进展', hint: '待办里优先级最高的那张卡' },
        { label: '在等谁', q: '谁在等谁', group: '看进展', hint: '哪个项目卡在等人的环节（验收人 / 执行人）' },
        { label: '欠着什么', q: '欠着什么', group: '看进展', hint: '你自己写下的欠账清单（项目登记表里那栏）' },
        { label: '卡在哪', q: '卡在哪', group: '看问题', hint: '哪张卡被别的卡挡着、被谁挡' },
        { label: '哪些逾期了', q: '哪些逾期了', group: '看问题', hint: '逾期几天，外加三天内到期的' },
        { label: '哪些项目停着', q: '哪些项目停着', group: '看问题', hint: '30 天没动静的项目（休眠 / 停滞）' },
        { label: '还有多少没做完', q: '还有多少没做完', group: '看账', hint: '未完成的卡有多少，按状态分开' },
        { label: '本月烧了多少钱', q: '本月烧了多少钱', group: '看账', hint: '按自然月算的 AI 调用与 token' },
      ],
      projects: [{ id: 'demo', name: '演示项目' }, { id: 'demo2', name: '第二个项目' }],
    }
  },
  askQuery: (q) => {
    rec('askQuery', [q])
    const s = String(q || '')
    if (s.indexOf('欠着') >= 0) {
      return {
        ok: true, kind: 'owe', title: '1 个项目写了欠账',
        lines: ['这条读的是你手写的「说明」—— 方寸不替你裁，也不替你补。'],
        rows: [{ k: '演示项目', v: '欠着：①夹具欠账 ②第二件', sub: '你手写的' }],
        needsLlm: false, source: '项目登记表里你手写的「说明」',
      }
    }
    if (s.indexOf('到哪') >= 0) {
      return {
        ok: true, kind: 'progress', title: '演示项目：活跃开发中（演示夹具）',
        lines: ['当前步骤：演示任务（来自任务卡）', '卡在谁：暮雨（验收）'],
        rows: [], projectId: 'demo', needsLlm: false,
        source: 'registry 手写字段 + tripBoard（任务卡/执行日志/git）',
      }
    }
    return {
      ok: true, kind: 'unmatched', title: '这句话结构化答不了',
      lines: ['方寸只在**两种**情况下动模型：模糊问答、批次出单。这一句既没命中结构化意图，也没点名项目——'],
      rows: [], needsLlm: true, source: '',
    }
  },
  // 随纠（2026-10-22 · 03 任务二）：桩复刻主进程语义的最小版 —— 只认「改 <字段> 为 <值>」。
  // ⚠ 必须记账并真返回 before/field：断言要验"撤销真把旧值传回去了"。
  correctPreview: (text, pid) => {
    rec('correctPreview', [text, pid])
    const m = String(text || '').match(/(状态|路线图|说明)\s*(?:改成|改为|为|成)\s*(.+)$/)
    if (!m) return { ok: false, error: '没认出要改哪个字段' }
    return { ok: true, projectId: pid, field: m[1], to: m[2].trim(), echo: '「演示项目」的' + m[1] + '：旧 → ' + m[2].trim() }
  },
  correctApply: (text, pid) => {
    rec('correctApply', [text, pid])
    const m = String(text || '').match(/(状态|路线图|说明)\s*(?:改成|改为|为|成)\s*(.+)$/)
    if (!m) return { ok: false, error: '没认出要改哪个字段。能改的就三个：状态 / 路线图 / 说明' }
    const p = (store.projects || []).find((x) => x.id === pid)
    const before = p ? String(p[m[1]] || '') : ''
    if (p) p[m[1]] = m[2].trim()
    return {
      ok: true,
      echo: '「' + (p ? p.name : pid) + '」的' + m[1] + '：' + (before || '（空）') + ' → ' + m[2].trim(),
      projectId: pid, field: m[1], before, decisionId: 'dec-e2e-1',
    }
  },
  correctUndo: (args) => {
    rec('correctUndo', [args])
    const p = (store.projects || []).find((x) => x.id === (args && args.projectId))
    if (!p) return { ok: false, error: '没有这个项目' }
    p[args.field] = args.before
    return { ok: true }
  },
  // 出单（2026-10-22 · 03 任务三）：一次调用出一批待审批卡
  llmPlanBatch: (pid) => {
    rec('llmPlanBatch', [pid])
    return {
      ok: true,
      created: [{ id: 'ai-batch-1', title: '夹具出单卡一' }, { id: 'ai-batch-2', title: '夹具出单卡二' }],
      usage: { totalTokens: 999 },
    }
  },
  llmAsk: (q) => {
    rec('llmAsk', [q])
    return { ok: true, text: '（AI 回答夹具）事实里没有这一项。', usage: { totalTokens: 321 }, facts_chars: 987 }
  },
  // 2026-10-22 · 施工单包 06：项目三字段读写。
  // ⚠ 桩必须**真改 store 并记账** —— 断言要验"保存后详情页显示新值""撤销真写回旧值"，
  //   桩若只 return ok() 而不动 store，两条断言都会恒绿（MEMORY 第十节的老坑）。
  registryReadFields: (id) => {
    rec('registryReadFields', [id])
    const p = (store.projects || []).find((x) => x.id === id)
    if (!p) return { ok: false, error: '没有这个项目' }
    return { ok: true, fields: { 状态: p['状态'] || '', 路线图: p['路线图'] || '', 说明: p['说明'] || '' } }
  },
  registryUpdateFields: (id, patch) => {
    rec('registryUpdateFields', [id, patch])
    const p = (store.projects || []).find((x) => x.id === id)
    if (!p) return { ok: false, error: '没有这个项目' }
    const keys = Object.keys(patch || {})
    const allowed = ['状态', '路线图', '说明']
    const bad = keys.filter((k) => allowed.indexOf(k) < 0)
    // 与主进程同一口径：白名单外一律整体拒绝（不静默忽略）
    if (bad.length) return { ok: false, error: '只允许改 状态 / 路线图 / 说明' }
    const before = {}
    for (const k of keys) { before[k] = String(p[k] || ''); p[k] = String(patch[k] || '') }
    return { ok: true, before, changed: keys }
  },
  // 备份 v2（现行家族）；裸 backup/restore/listBackups 已随族3（卡004）删除 —— 夹具同步
  // 导出指定备份（2026-09-25 第 10 条）：给两份假备份，验证「默认最新」与传参
  backupListLocal: () => { rec('backupListLocal'); return ({
    ok: true,
    items: [
      { name: 'fangcun-data-20260920-101010.zip', path: 'C:/mock/backups/fangcun-data-20260920-101010.zip', bytes: 111111, mtime: '2026-09-20T10:10:10.000Z', sha256: null },
      { name: 'fangcun-data-20260925-202020.zip', path: 'C:/mock/backups/fangcun-data-20260925-202020.zip', bytes: 222222, mtime: '2026-09-25T20:20:20.000Z', sha256: null },
    ],
  }) },
  backupListRemote: () => [],
  backupRun: () => ok(),
  backupRunLocalOnly: () => ok(),
  backupSaveConfig: () => ok(),
  backupSetConfig: () => ok(),
  backupTestRemote: () => ok(),
  backupRestore: () => ok(),
  backupOpenDir: () => ok(),
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
  // 月度花销（2026-10-22 · 03 任务三）：按自然月。夹具刻意两个月、其中一条无 usage。
  llmUsageMonthly: () => {
    rec('llmUsageMonthly')
    return {
      months: [
        { month: '2026-10', calls: 3, ok: 2, fail: 1, token_calls: 2, prompt_tokens: 90, completion_tokens: 40, total_tokens: 1300, byTrigger: [{ trigger: 'desktop.ask', calls: 2, total_tokens: 300 }] },
        { month: '2026-09', calls: 1, ok: 1, fail: 0, token_calls: 1, prompt_tokens: 10, completion_tokens: 5, total_tokens: 500, byTrigger: [{ trigger: 'desktop.draftProjectBrief', calls: 1, total_tokens: 500 }] },
      ],
    }
  },
  llmGetConfig: () => ({}),
  llmSetConfig: () => ok(),
  llmResetConfig: () => ok(),
  llmTestConnection: () => ok(),
  // AI 规划写回层（2026-10-12）：e2e 不真调 LLM，桩返回成功+假 usage（「花销可见」链路可断言）
  llmPlanToDraft: () => ({ ok: true, created: [{ id: 'task-e2e-draft-1', title: 'e2e 假草稿' }], usage: { promptTokens: 120, completionTokens: 80, totalTokens: 200 } }),
  llmDraftProjectBrief: () => ({ ok: true, taskId: 'task-e2e-brief-1', usage: { promptTokens: 100, completionTokens: 60, totalTokens: 160 } }),
  // 决策卡（2026-10-12）：本地 CRUD 桩，假数据供视图用例断言
  // ⚠ 2026-10-14：三条各自带上「项目」（含一条刻意留空）—— 项目筛选与项目字段的断言靠它
  decisionList: () => { rec('decisionList'); return { ok: true, items: [
    { id: 'D-001', 内容: '司天不发版，唯一目标=标注+导出真图', 日期: '2026-10-11', 状态: '有效', 项目: '司天', 出处: '10-11 09:42 四答定调②', 备注: '', 更新: '' },
    { id: 'D-002', 内容: '启动台死因 10-14 前裁决', 日期: '2026-09-14', 状态: '已撤销', 项目: '绒花墨坊', 出处: '台账 #4', 备注: '被 10-12 快照复盘取代', 更新: '' },
    { id: 'D-003', 内容: '方寸 AI 规划整包一次交齐', 日期: '2026-10-12', 状态: '已合并', 出处: '12:21 群指令', 备注: '并入 10-14 交付计划', 更新: '' },
  ] } },
  decisionAdd: (input) => { rec('decisionAdd', [input]); return { ok: true, id: 'D-004' } },
  decisionSetStatus: (id, status, note) => { rec('decisionSetStatus', [id, status, note]); return { ok: true, message: `${id} → ${status}` } },
  // 2026-10-17：编辑 / 删除（与真 preload 同步；桩不记账 = 顺序断言恒红）
  decisionUpdate: (id, patch) => { rec('decisionUpdate', [id, patch]); return { ok: true, message: `已更新 ${id}` } },
  decisionDelete: (id) => { rec('decisionDelete', [id]); return { ok: true, message: `已删除 ${id}` } },
  // ⚠ 真 IPC 是 Promise（ipcRenderer.invoke）—— 假 preload 必须同款，否则界面 .then 直接炸（2026-10-14 实测）
  exportTasks: () => Promise.resolve(ok({ data: [], count: 0 })),
  // 导入：与主进程**同款防呆**（表外字段名 → 失败，并把那句点名的话回给界面）。
  // 假 preload 与真 preload/真实现必须同步 —— 否则界面断言测的是"假契约"（MEMORY 第五节）。
  importTasks: (data) => {
    rec('importTasks', [data])
    const known = ['id', 'title', 'project', 'status', 'priority', 'assignee', 'tags', 'created', 'updated',
      'blockers', 'body', '标题', '项目', '状态', '优先级', '指派', '标签', '创建', '更新', '阻塞', '正文', '内容']
    const list = Array.isArray(data) ? data : []
    for (let i = 0; i < list.length; i++) {
      const it = list[i]
      if (!it || typeof it !== 'object') continue
      const badKey = Object.keys(it).find((k) => !known.includes(k))
      if (badKey) {
        return Promise.resolve({ ok: false, error: `导入被拦下，一个文件都没写：第 ${i + 1} 条的字段名「${badKey}」不认识（可用：${known.slice(0, 6).join(' / ')}）` })
      }
    }
    return Promise.resolve(ok())
  },
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
  // 2026-10-12：「今天」那一格到底压了几条 —— 从**夹具真身**数出来，别在断言里写死。
  // 起因：待办也上日历之后，"今天"从 4 条变 5 条，写死 `+2 条` 的旧断言当场假红。
  // ⚠ 口径必须与 App.vue 造日历事件完全一致 —— 第一版漏了「完成的待办不上日历」
  //   （多选夹具里那条 done:true 的 `td-3` 被多算成一条 → 期望 +4、实际 +3，还是假红）。
  fixTodayCount: () => {
    const dl = (store.tasks || []).filter(t => (t.deadline || (t.fm && t.fm.deadline)) === FIX_DEADLINE).length
    // 待办的日历判据（App.vue）：① 未完成；② 有 due 且等于今天 ——「没 due」不算今天
    // （裸 { created: 1 } 这种夹具不带 due，若按"没 due 就今天"数会凭空多出几条）。
    const td = (store.todos || []).filter(t => !t.done && t.due === FIX_DEADLINE).length
    return dl + td
  },
  // 格子内最多铺几条 —— 由 e2e-runner 注入 App.vue 的同名常量（见 renderer-web-assert.js 顶部）。
  calCellCap: () => (typeof globalThis.__fcCalCellCap === 'number' ? globalThis.__fcCalCellCap : 2),
  calls: () => JSON.parse(JSON.stringify(store.calls)),
  callCount: (name) => store.calls.filter(c => c.name === name).length,
  todos: () => JSON.parse(JSON.stringify(store.todos)),
  // 想法（2026-10-22）：断言要能读到真身 —— 特别是"点「做」之后待办里是不是真多了一条"
  ideas: () => JSON.parse(JSON.stringify(store.ideas)),
  setIdeas: (items) => { store.ideas = (items || []).slice() },
  logs: () => JSON.parse(JSON.stringify(store.logs)),
  trash: () => JSON.parse(JSON.stringify(store.trash)),
  tasks: () => JSON.parse(JSON.stringify(store.tasks)),
  imported: () => JSON.parse(JSON.stringify(store.imported)),
  services: () => JSON.parse(JSON.stringify(store.services)),
  /** 启动台应用行（端口=观测结果）—— 断言用它算期望值，不写死条数 */
  servicesApps: () => JSON.parse(JSON.stringify(store.servicesApps || [])),
  /** 脚本化导入行为：是否重名 / 选中的包路径（null = 用户取消） */
  setImport: (name, opts) => {
    if (name) store.importName = name
    if (opts && 'exists' in opts) store.importExists = !!opts.exists
    if (opts && 'pickPath' in opts) store.pickPath = opts.pickPath
  },
  /** 重新灌测试数据：前面的回收站测试会把两条都还原/彻底删掉，后面的预览测试要重来一遍 */
  setTrash: (items) => { store.trash = (items || []).slice() },
  setLogs: (items) => { store.logs = (items || []).slice() },
  /** 自仓同步状态（W1-1C）：传 null 恢复默认「已是最新」 */
  setSelfSync: (obj) => { store.selfSync = obj || null },
  /** 项目路线文档（W1-批次 2）：传 null 恢复默认夹具；传 ok:false 造「读不到」形态 */
  setProjectDocs: (obj) => { store.projectDocs = obj || null },
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
  /**
   * 注入在途一屏的返回（含 rows / hidden / modeFallback）。
   * 2026-10-05 用：造「手动指定 + 一个都没勾 → 一屏全空」这个用户实测场景，
   * 验证空屏里有出口（「改回自动」）而不是死局。
   */
  setTripBoard: (obj) => { store.tripBoard = obj || null },
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
