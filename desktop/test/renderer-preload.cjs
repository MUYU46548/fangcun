/**
 * 渲染层测试用 preload —— 用内存里的假后端替掉真 IPC。
 *
 * 目的：让“装了没装 / 点了有没有反应”这类问题第一次能被自动断言。
 * 项目已有的五类静态检查（vite / tsc / e2e / IPC 对账 / 模板绑定）**全都抓不到**
 * "按钮存在、通道齐全、但点了没反应"这一类问题 —— 本次用户第 1 条就是这个形状。
 *
 * 只测试用，不参与打包。
 */
const { contextBridge } = require('electron')

// 夹具里的“同一天”必须**跟着今天走**（2026-10-01 教训）：原先写死 2026-09-30，
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
  // 记忆层（2026-11-17）· 夹具默认给**真形状的三条**：
  // 一条事故、一条纪律、一条已撤销。为什么不全空 —— 空数组会让
  // "列表渲染出来了吗"和"筛选生效了吗"永远无法区分（本仓栽过）。
  memory: [
    {
      id: 'inc-20261117-01', type: '事故', scope: '', project: 'dsh-fangcun',
      time: '2026-11-17T17:52:00+08:00', status: '有效', impact: '高',
      title: '强杀宿主进程打断施工轮次', summary: '两次 Stop-Process -Force，第二次打断正在跑的轮次。',
      file: 'memory/incidents/a.md', tags: ['强杀进程'],
    },
    {
      id: 'lesson-20261117-01', type: '纪律', scope: '跨项目', project: '跨项目',
      time: '2026-11-17T18:15:00+08:00', status: '有效', impact: '高',
      title: '施工纪律（跨项目）', summary: '征询不等于授权；越急越要先锁范围。',
      file: 'memory/lessons/b.md', tags: ['纪律'],
    },
    {
      id: 'inc-20261009-01', type: '教训', scope: '', project: 'rosa-chuangzuo',
      time: '2026-10-09T00:00:00+08:00', status: '已撤销', impact: '中',
      title: '一条已撤销的教训', summary: '这条用来验证「默认不返回已撤销」。',
      file: 'memory/incidents/c.md', tags: [],
    },
  ],
  memoryOverview: { total: 3, effective: 2, revoked: 1, byType: { 事故: 1, 纪律: 1, 教训: 1 } },
  // 层厚度（2026-11-16 · 骨架继承试点第一批）：横比 + 单项目报告。
  // 默认给**一个真形状**的最小夹具 —— 空数组会让"表渲染出来了吗"永远无法区分。
  layerBoard: [
    {
      ok: true, id: 'demo', name: '演示项目', repo: 'E:/demo',
      totalLines: 300, totalFiles: 4,
      rows: [
        { layer: 'src', role: '产品', files: 2, lines: 100 },
        { layer: 'tests', role: '测试', files: 2, lines: 200 },
      ],
      named: [], groups: [], verdict: '测试比产品厚。',
      unreadable: [], nonText: [], skipped: [{ dir: 'node_modules', why: '依赖' }],
      specSource: '', claims: {}, claimsNote: '', claimRows: [], missing: '', note: '',
    },
  ],
  layerProfile: null,
  layerSpec: { ok: true, spec: null, exists: false, path: 'task-data/layer-specs/demo.json' },
  // 竞品（2026-11-17）：一个真形状的最小夹具 —— 空数组会让「列表渲染出来了吗」永远无法区分。
  // ⚠ 故意给两条：一条有 focus、一条没有，好让「关注什么是空的」那格能被断言到。
  competitorOverview: {
    ok: true,
    dir: 'task-data/competitors',
    summary: { total: 16, withCompetitors: 1, withReports: 1 },
    rows: [{
      projectId: 'demo',
      projectName: '演示项目',
      competitors: [
        { name: '样例竞品甲', url: 'https://example.com/a', focus: '列表密度：一屏能扫多少条' },
        { name: '样例竞品乙', url: 'https://example.com/b', focus: '' },
      ],
      reports: ['2026-11-17-样例甲.md'],
      taskFile: true,
    }],
  },
  // 同步阶段流（2026-10-25 卡 004）：订阅者列表 + 一个"按住不放的 push"。
  // 真通道是主进程跑 git 时一条条推阶段过来；夹具里必须能**手动喂阶段、手动结束**，
  // 否则“阶段文字”“秒数在动”“结束态停留 3 秒”这三件事在测试里根本无从验起。
  syncSubs: [],
  // BYOK 多通道（2026-11-02）：只有主通道（备用要断言"加完真的出现在列表里"）
  llmChannels: [
    { id: 'main', label: '主通道', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', enabled: true, hasApiKey: true, keyHint: 'sk-****wxyz', primary: true },
  ],
  // AI 生成图（2026-11-02）：默认走"过审"分支；setArchScanOnly(true) 换降级分支
  archScanOnly: false,
  archGraph: null,
  // 账户口径（2026-10-25 卡 005）：默认"有官方余额接口"，可用 __fcTest.setBalanceUnsupported(true)
  // 切到"这个端点没有余额接口"的真实常见态 —— 那条降级路径必须被验过。
  balanceUnsupported: false,
  // 模型单价夹具（2026-10-25 卡 005）：一行真数据，够验"读得到 + 改得动"
  prices: [{ model: 'deepseek-chat', in: '2.00000000', out: '8.00000000' }],
  // 读取情况：“哪些待办其实没人碰过”（卡 20261025-006 第三件）
  // ⚠ 桩**不许写成空数组**（`rows: []` 会让"没人碰过 0"永远成立，那一整片断言等于没测）。
  // ⚠ 也**不许把 id 写死**：任务夹具在整个断言流程里会被前面若干节换成别的卡
  //   （2026-10-27 实测：写死 task-demo-001 → 到这一节时任务夹具只剩 2 张别的卡，
  //   于是"筛完只剩那几张"永远红，且看起来像筛选坏了）。
  //   所以默认**从当前任务夹具现算**；`setNeverRead()` 用于造特定形态（冻结一份）。
  neverRead: null,
  syncHold: false,
  syncResolve: null,
  // 顶栏“无法解析”红灯的夹具：两个坏文件（含一个带 ": " 的真坑）
  parseErrors: ['task-20261001-001.md', 'task-20261002-002.md'],
  // 想法（2026-10-22）：三条覆盖三种状态 ——
  //   新记（四个动作都能点）/ 已搁置（能“捡回来”）/ 已立项（能“撤销立项”且带 promoted）
  ideas: [
    { id: 'idea-a', text: '给启动台加个搜索框', status: '新记', note: '', createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z', decidedAt: '', promoted: null },
    { id: 'idea-b', text: '端口面板要不要合并进服务页', status: '已搁置', note: '等启动台稳了再说', createdAt: '2026-10-19T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z', decidedAt: '2026-10-20T10:00:00.000Z', promoted: null },
    { id: 'idea-c', text: '做个一键导出周报', status: '已立项', note: '', createdAt: '2026-10-18T10:00:00.000Z', updatedAt: '2026-10-18T12:00:00.000Z', decidedAt: '2026-10-18T12:00:00.000Z', promoted: { kind: 'todo', id: 'todo-from-idea-c' } },
  ],
  // 规划管理（2026-10-16 第 1 项）：预置 1 条带 2 决策点的规划（1 已定 1 待定），
  // “🗂 规划”弹窗列表/详情/留痕三态都有东西可断言。
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
  // 项目梯度榜（2026-10-25）：分档 + 每档项目 id，落 task-data/project-tiers.json。
  // ⚠ 假 preload 必须与真 preload 同步（少一条 API，视图 onMounted 直接抛，
  //   断言只会看到一片“读取失败”）—— 这条今天已经踩第二次了。
  projectTiers: [
    { id: 'core', label: '核心', items: ['demo'] },
    { id: 'next', label: '次优先', items: ['demo2'] },
    { id: 'queue', label: '排队', items: [] },
    { id: 'hold', label: '搁置', items: [] },
  ],
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
  //   lp-empty  ：还没观测到任何端口 → 不许写“无”/“—”这类噪音，整行不渲染
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
    // ⚠ 这两张（同为“待办”列）的 created / updated 是**故意错开的**（2026-09-29）：
    //   默认序 001→002；按 updated 倒序要变成 002→001；按 created 倒序要回到 001→002。
    //   这样"排序下拉"才可被真断言 —— 三者两两不同，任何一支写错都会当场红。
    {
      id: 'task-demo-001', title: '演示任务', status: '待办', priority: '高',
      // 2026-11-11 补 `澄清`：派工单出厂闸（2026-11-09 S3=B）要求卡上带澄清卷，
      // 夹具没有它 → 「复制为派工单」被闸拒，那一串断言从 11-09 起一直是红的（只是没人跑）。
      clarify: '司天-宪法层', project: 'demo', tags: [], body: '正文', deadline: FIX_DEADLINE,
      created: '2026-09-20T00:00:00.000Z', updated: '2026-09-01T00:00:00.000Z',
      fm: { id: 'task-demo-001', title: '演示任务', status: '待办', priority: '高', project: 'demo', clarify: '司天-宪法层' },
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
      clarify: '司天-宪法层', tags: [], body: '',
      created: '2026-09-01T00:00:00.000Z', updated: '2026-09-01T00:00:00.000Z',
      fm: { id: 'task-demo-003', title: '未归属任务', status: '进行中', priority: '低', clarify: '司天-宪法层' },
      path: 'C:/mock/task-data/task-demo-003.md',
    },
    // 2026-09-28：真实 frontmatter 里“项目”是**数组**（`项目: [fangcun-base]`）——
    // 卡上要显示的所属项目必须过 normProject，否则永远匹配不到名字（用户报“看不见所属项目”）。
    {
      id: 'task-demo-004', title: '数组项目的任务', status: '待验收', priority: '中',
      project: ['demo2'], tags: [], body: '',
      created: '2026-09-02T00:00:00.000Z', updated: '2026-09-02T11:22:33.000Z',
      fm: { id: 'task-demo-004', title: '数组项目的任务', status: '待验收', project: ['demo2'] },
      path: 'C:/mock/task-data/task-demo-004.md',
    },
    // 2026-09-29：日历“改法 A”（格子最多 2 条 + “+N 条”）要**同一天有多条**才验得了。
    // 这三条全压在 FIX_DEADLINE（= 今天，与 001 同一天）；created/updated 一律取很早的日期 ——
    // 免得不小心把"排序下拉"那组断言的头名（002 / 001）挤掉。
    // ⚠ 状态**刻意各不相同**（进行中/进行中/待验收）：demo 项目的状态分布条才有 3 段可验；
    //   而且它们一律不带"待办"状态 —— 否则会挤进“待办”列，把排序断言的期望序打乱。
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
  // 架构图生成是否"挂住"（2026-11-05）：验生成中横幅用
  archHold: false,
  // 技能自动同步的留痕（2026-11-05）：默认"刚跑过、与当前版本一致"。
  // 断言要换形态就 `__fcTest.setSkillSync({ stale: true, ... })`。
  // ⚠ 版本**不写死**：由 e2e-renderer-web 从 desktop/package.json 注入 window.__FC_VER
  //   （写死 0.6.3 的话，一升版本这条就变成"在验一个不存在的版本"，绿得毫无意义）。
  skillSync: {
    ok: true,
    currentVersion: window.__FC_VER || '0.0.0',
    stale: false,
    staleReason: '',
    skills: ['fangcun-bridge', 'skill-management-policy'],
    status: {
      at: '2026-11-05T01:20:00.000Z',
      appVersion: window.__FC_VER || '0.0.0',
      trigger: 'boot',
      ok: true,
      skills: ['fangcun-bridge', 'skill-management-policy'],
      targets: [
        { id: 'hermes', name: 'Hermes', present: true, needsInstall: false, installed: [], skipped: ['fangcun-bridge', 'skill-management-policy'], errors: [] },
        { id: 'dsh', name: 'DSH', present: true, needsInstall: false, installed: [], skipped: ['fangcun-bridge', 'skill-management-policy'], errors: [] },
      ],
    },
  },
  // 归档区：故意放一条与活跃任务**同 id** 的副本（历史遗留/手工拷贝真会出现），
  // “含归档”勾选后板子必须去重，不能把同一张卡显示两遍。
  archived: [
    {
      id: 'task-demo-001', title: '演示任务（归档副本）', status: '完成', priority: '高',
      clarify: '司天-宪法层', project: 'demo', tags: [], body: '',
      created: '2026-08-01T00:00:00.000Z', updated: '2026-08-01T00:00:00.000Z',
      fm: { id: 'task-demo-001', title: '演示任务（归档副本）', status: '完成', clarify: '司天-宪法层' },
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
    // 归档区补一条“驳回”—— 刻意不用待办/进行中：那两个是未完成态，会把
    // “只看未完成勾选后一张不剩（archAfter===0）”的断言搞红。驳回和完成一样是终态
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

/**
 * “哪些待办没人碰过”的假数据（卡 20261025-006 第三件）。
 *
 * 两件必须同时做到，否则这一片断言是假绿：
 *  ① **不能是空数组** —— `rows: []` 会让"没人碰过 0"永远成立，看起来全绿其实什么都没验；
 *  ② **不能写死 id** —— 任务夹具在断言流程里会被前面若干节换掉（2026-10-27 实测：
 *     写死 task-demo-001 后，到这一节时任务夹具只剩两张别的卡，"筛完只剩那几张"永远红，
 *     而且看起来像筛选坏了）。所以默认**从当前任务夹具现算**。
 * `__fcTest.setNeverRead(...)` 会冻结一份，用来造特定形态（如 windowEvents=0）。
 */
function computeNeverRead() {
  if (store.neverRead) return store.neverRead
  const CLOSED = ['完成', '驳回']
  const all = (store.tasks || []).map((t) => ({
    id: t.id,
    title: t.title || (t.fm && t.fm.title) || t.id,
    project: t.project || (t.fm && t.fm.project) || '',
    status: t.status || (t.fm && t.fm.status) || '',
    priority: t.priority || (t.fm && t.fm.priority) || '中',
    updated: t.updated || (t.fm && t.fm.updated) || '2026-09-20T00:00:00.000Z',
    reads: 0,
  }))
  let open = all.filter((t) => CLOSED.indexOf(t.status) < 0)
  // 兜底：当前夹具全是完成卡时，仍然给一条（不然"筛完 0 张"分不清是逻辑坏还是夹具没料）
  if (!open.length) open = all.slice(0, 1)
  const rows = open.slice(0, 2)
  return { ok: true, rows, count: rows.length, openTotal: Math.max(open.length, rows.length), windowEvents: 5, days: 30 }
}

let seq = 0
const nextId = (p) => `${p}-${Date.now()}-${(seq++).toString(36)}`

const ok = (extra) => Object.assign({ ok: true }, extra || {})

/**
 * 结构化克隆校验 —— 复刻真机 contextBridge 的**第一跳**语义。
 *
 * 2026-10-05 踩的坑（用户原话“勾一下闪退一下”= 勾选写不进盘）：
 *   渲染层把 **Vue 响应式代理**（`ref([]).value`、v-for 元素）直接当 IPC 载荷传，
 *   真机在“页面世界 → 隔离世界”这一跳就抛 `An object could not be cloned` ——
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
  // ⚠ 2026-10-17：这里原来只有 5 个状态（缺“待审批”和“待验收”），与主进程 `STATUSES`
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

/** 作战计划夹具（可变）：裁决后重读要能看到状态变化，界面才验得了“点完回执” */
const PLAN_DOCS = [{
  file: 'demo.md',
  title: '演示 · 作战计划',
  stages: [
    {
      id: 'P0', title: '格式与机检', status: '已冻结', what: '把结构定成文件格式',
      approach: ['存储 task-data/plans/<项目id>.md'],
      copyRows: [['抄哪块', '落到哪', '不抄什么', '怎么算抄到位'], ['---', '---', '---', '---'], ['SOW 五段', '五个二级标题', '合同语言', '五个节名都在']],
      criteria: ['cmd: echo ok', 'str: 五个二级标题都在', 'num: 照抄点行数 ≥ 1'],
      verdict: '通过 · 2026-10-29', rejectReason: '', missing: [],
    },
    {
      id: 'P1', title: '作战计划页签', status: '待裁决', what: '',
      approach: [], copyRows: [], criteria: [], verdict: '', rejectReason: '', missing: [],
    },
  ],
}, {
  // 第二个项目（2026-11-05 第 1 条）：项目筛选要能切，夹具里就得**真有两个项目**的计划卡 ——
  // 只有一个的话，"按项目筛"要么不渲染、要么永远只能筛出全部，等于没验。
  // ⚠ 这一份的 stage 状态是「完成」：它**不进**“待裁决 N 张”清单，
  //   于是上游那条 `pendingItems.length === 1` 不会因为新增夹具而红。
  file: 'demo2.md',
  title: '第二个项目 · 作战计划',
  stages: [
    {
      id: 'P0', title: '第二个项目的阶段卡', status: '完成', what: '只用来验项目筛选',
      approach: ['x'], copyRows: [['a', 'b'], ['---', '---'], ['1', '2']],
      criteria: ['str: x'], verdict: '通过 · 2026-11-01', rejectReason: '', missing: [],
    },
  ],
}]

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
  // 2026-11-08：使用手册页头要显示版本号（暮雨第 1 条）。以前这条通道没桩 → 页面拍到 'v…'，
  // 看起来像坏了。版本同样**不写死**，取 e2e 从 package.json 注入的 __FC_VER。
  getAppVersion: async () => (window.__FC_VER || '0.0.0'),
  // 阻塞源夹具（2026-10-09 监控台断言）：demo 项目压着 1 条阻塞 → 详情页
  // “⚠ 1 个阻塞源 · 看卡在谁”入口必须出现（pvBlocked 按被阻塞任务所属项目计）。
  findBlockers: () => [
    { id: 'task-demo-001', title: '演示任务', blockers: ['task-demo-002'] },
  ],
  // 解析失败清单（2026-10-23 补）：此前恒返回 `[]` —— 于是顶栏那条“⚠ N 个文件无法解析”
  // **从来没有在任何断言里出现过**。而这条提示正是“任务静默消失”的防线（parseTask 失败
  // 返 null 被跳过 = 卡人间蒸发，用户几个月才发现）。桩返空数组 = 这道防线等于没测。
  parseErrors: () => {
    rec('parseErrors')
    return store.parseErrors.slice()
  },
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
  // 作战计划卡读口（0.6.0 P1）+ 每日推进面（P2）——
  // 日志页顶部那条“今天推哪一格”靠它渲染。夹具必须带**判据原文**，
  // 否则“3 秒内看到今天推哪一格及其判据”这条只能在纯逻辑里验，界面侧永远验不到。
  plansGet: (file) => {
    rec('plansGet', [file])
    const docs = PLAN_DOCS
    return { ok: true, files: PLAN_DOCS.map((d) => d.file), docs: file ? docs.filter((d) => d.file === file) : docs }
  },
  // 裁决（2026-11-03）：冻结/打回要真的改夹具状态 —— 否则“点完按钮变已冻结”没法验。
  plansVerdict: (input) => {
    cloneGuard('plansVerdict', [input])
    rec('plansVerdict', [input])
    const doc = PLAN_DOCS.find((d) => d.file === (input && input.file))
    const s = doc && doc.stages.find((x) => x.id === (input && input.stageId))
    if (!doc || !s) return { ok: false, error: '找不到这个阶段' }
    const action = input.action
    if (action === 'pass') { s.status = '已冻结'; s.verdict = '通过 · 2026-11-03' }
    else if (action === 'reject') { s.status = '驳回'; s.rejectReason = String(input.text || '') }
    else if (action === 'amend') { s.status = '未冻结'; s.verdict = '改一句 · 2026-11-03' }
    return { ok: true, doc }
  },
  // 跑判据 / 推进一格（0.6.0 P4 界面入口，2026-11-02 接上界面）。
  // 夹具按 stageId 分两种形态，覆盖两条路：
  //   P0 → 判据全过（闸门放行、推进成功）
  //   P1 → 判据未过（闸门挡下、打回理由带实际值）
  // ⚠ 两条都要过 cloneGuard：真机这一跳传 Vue 代理会直接抛，报文进不到主进程。
  plansChecks: (input) => {
    cloneGuard('plansChecks', [input])
    rec('plansChecks', [input])
    const stageId = (input && input.stageId) || ''
    if (stageId === 'P1') {
      return ok({
        file: 'demo.md', stageId: 'P1', status: '待裁决',
        results: [
          { ok: false, state: 'fail', kind: 'cmd', detail: '退出码 3',
            raw: 'cmd: node scripts/test/e2e-plan-run.cjs 退出码 0', evidence: { exitCode: 3 } },
          { ok: true, state: 'pass', kind: 'str', detail: '文件含指定原文',
            raw: "str: desktop/src/App.vue 含 'plan'", evidence: {} },
        ],
        gate: {
          canAdvance: false, total: 2, passed: 1, failed: 1, unknown: 0,
          blocked: [{ raw: 'cmd: node scripts/test/e2e-plan-run.cjs 退出码 0', state: 'fail', actual: '实际值：退出码 3' }],
          diff: '判据未过：1 条未过 / 0 条未判定 / 共 2 条',
          reason: '还有 1 条判据未过 —— 不许跨格',
        },
      })
    }
    return ok({
      file: 'demo.md', stageId: stageId || 'P0', status: '已冻结',
      results: [
        { ok: true, state: 'pass', kind: 'cmd', detail: '退出码 0', raw: 'cmd: echo ok', evidence: { exitCode: 0 } },
        { ok: true, state: 'pass', kind: 'str', detail: '文件含指定原文',
          raw: "str: desktop/src/App.vue 含 'plan'", evidence: {} },
      ],
      gate: {
        canAdvance: true, total: 2, passed: 2, failed: 0, unknown: 0, blocked: [], diff: '',
        reason: '2 条判据全过 —— 可以完成这一格',
      },
    })
  },
  plansAdvance: (input) => {
    cloneGuard('plansAdvance', [input])
    rec('plansAdvance', [input])
    const stageId = (input && input.stageId) || ''
    if (stageId === 'P1') {
      return ok({
        advanced: false, blocked: true, error: '判据未过，不能跨格',
        status: '未完成', evidence: '',
        rejectReason: '判据未过：1 条未过 / 0 条未判定 / 共 2 条；“cmd: node scripts/test/e2e-plan-run.cjs 退出码 0”→ 实际值：退出码 3（未过）',
      })
    }
    return ok({
      advanced: true, blocked: false, status: '完成',
      evidence: '自检 2026-11-02T01:00:00.000Z · 2/2 判据通过',
      rejectReason: '',
    })
  },
  // 规划草案入口（2026-11-11）：夹具给两份草案 —— 一份三块齐全、一份缺判据（界面必须不给提议按钮）
  plansDrafts: () => {
    rec('plansDrafts')
    return {
      ok: true,
      dir: 'C:/mock/task-data/plans/_drafts',
      drafts: [
        {
          file: 'fangcun-base-2026-11-11.md', project: 'fangcun-base', version: 'draft-2026-11-11', date: '2026-11-11',
          constitution: [
            { type: '已定', text: '判断半是硬锁：没卷不许出单', cite: 'decision:D-061' },
            { type: '待定', text: '0.7.0 是否包含 UI 美化', cite: 'task:ui美化' },
          ],
          asks: ['0.7.0 里要不要接 UI 美化？'],
          stages: [
            {
              id: 'P12', title: '规划草案的界面入口', what: '草案能被看见并提成阶段卡',
              approach: ['读 _drafts/*.md', '走 proposeStage 同一条闸'],
              copyRows: [['抄哪块', '落到哪', '不抄什么', '怎么算抄到位'], ['---', '---', '---', '---'], ['CI 报告', '逐格结论', '趋势图', 'num: 每格三态']],
              criteria: ['cmd: node scripts/test/e2e-plan-drafts.cjs', 'file: desktop/src/main/data/planDrafts.ts'],
              missing: [],
            },
            {
              id: 'P13', title: '缺块的那一格', what: '用来验“缺块不给提”',
              approach: ['只有技术方案'],
              copyRows: [],
              criteria: [],
              missing: ['照抄点', '判据'],
            },
          ],
          path: 'C:/mock/task-data/plans/_drafts/fangcun-base-2026-11-11.md',
        },
      ],
      broken: [{ file: '_drafts/坏草案.md', why: '草案里一个阶段卡都没有' }],
      decks: [{ deck: '方寸-规划判断半-裁决层B', project: 'fangcun-base' }],
    }
  },
  plansProposeFromDraft: (input) => {
    cloneGuard('plansProposeFromDraft', [input])
    rec('plansProposeFromDraft', [input])
    const stageId = (input && input.stageId) || ''
    if (!input || !input.deck) return { ok: false, error: '必须附澄清问卷（deck）' }
    const patch = (input && input.patch) || null
    // 与主进程同顺序：先看合并后的三块齐不齐，再谈落不落盘。
    // P13 在草案里缺照抄点与判据 —— 只有 patch 把这两块补上才放行（这正是“改完仍走同一条闸”）。
    if (stageId === 'P13') {
      const hasCopy = !!(patch && Array.isArray(patch.copyRows) && patch.copyRows.length >= 3)
      const hasCriteria = !!(patch && Array.isArray(patch.criteria) && patch.criteria.length > 0)
      if (!hasCopy || !hasCriteria) return { ok: false, error: '这一格还缺 照抄点 / 判据 —— 三块齐全才给提成阶段卡' }
    }
    const names = []
    if (patch && Array.isArray(patch.approach)) names.push('技术方案')
    if (patch && Array.isArray(patch.copyRows)) names.push('照抄点')
    if (patch && Array.isArray(patch.criteria)) names.push('判据')
    return ok({
      ok: true, planFile: 'fangcun-base.md', draft: 'fangcun-base-2026-11-11.md',
      edit: names.length
        ? { changed: { approach: names.includes('技术方案'), copyRows: names.includes('照抄点'), criteria: names.includes('判据') }, count: names.length, note: names.join(' / ') }
        : { changed: { approach: false, copyRows: false, criteria: false }, count: 0, note: '' },
    })
  },
  // BYOK 多通道（2026-11-02）：主通道 + 一条备用；upsert / remove 都回"落盘后的真相"
  llmChannelsList: () => {
    rec('llmChannelsList')
    return { ok: true, primaryId: 'main', channels: store.llmChannels.slice() }
  },
  llmChannelsUpsert: (input) => {
    cloneGuard('llmChannelsUpsert', [input])
    rec('llmChannelsUpsert', [input])
    const list = store.llmChannels.map((c) => ({ ...c }))
    const i = list.findIndex((c) => c.id === 'backup-1')
    const one = {
      id: 'backup-1',
      label: (input && input.label) || '备用通道 1',
      baseUrl: (input && input.baseUrl) || '',
      model: (input && input.model) || '',
      enabled: true,
      hasApiKey: !!(input && input.apiKey),
      keyHint: input && input.apiKey ? 'sk-****abcd' : '',
      primary: false,
    }
    if (i >= 0) list[i] = one
    else list.push(one)
    store.llmChannels = list
    return { ok: true, primaryId: 'main', channels: list.slice() }
  },
  llmChannelsRemove: (id) => {
    cloneGuard('llmChannelsRemove', [id])
    rec('llmChannelsRemove', [id])
    if (String(id) === 'main') return { ok: false, error: '主通道不能删' }
    store.llmChannels = store.llmChannels.filter((c) => c.id !== id)
    return { ok: true, primaryId: 'main', channels: store.llmChannels.slice() }
  },
  // 跨渠道 token 对比（2026-11-02）：夹具覆盖三种金额标注 + 一个"没给 token 数字"的渠道
  channelsGet: (opts) => {
    cloneGuard('channelsGet', [opts])
    rec('channelsGet', [opts])
    const pick = opts && Array.isArray(opts.channels) && opts.channels.length ? opts.channels[0] : ''
    const all = [
      { key: 'local:deepseek-chat', label: 'deepseek-chat', kind: 'local', calls: 3,
        promptTokens: 3000, completionTokens: 1500, totalTokens: 4500, noTokenCalls: 0,
        money: { kind: 'provider', text: '¥0.0096 · 供应商自报', providerCost: '0.0096', userPriceCost: '' },
        firstAt: '2026-11-01T10:00:00.000Z', lastAt: '2026-11-02T10:00:00.000Z' },
      { key: 'ext:hermes', label: 'hermes（外部上报）', kind: 'external', calls: 1,
        promptTokens: 5000, completionTokens: 2000, totalTokens: 7000, noTokenCalls: 0,
        money: { kind: 'none', text: '未折算', providerCost: '', userPriceCost: '' },
        firstAt: '2026-11-02T08:00:00.000Z', lastAt: '2026-11-02T08:00:00.000Z' },
      { key: 'local:mimo-v2.6-flash', label: 'mimo-v2.6-flash', kind: 'local', calls: 2,
        promptTokens: 400, completionTokens: 100, totalTokens: 500, noTokenCalls: 1,
        money: { kind: 'user-price', text: '¥0.0001 · 用户自填', providerCost: '', userPriceCost: '0.0001' },
        firstAt: '2026-11-02T09:00:00.000Z', lastAt: '2026-11-02T09:00:00.000Z' },
    ]
    const rows = pick ? all.filter((x) => x.key === pick) : all
    return {
      ok: true, readError: '',
      report: {
        days: (opts && opts.days) || 30, from: '2026-10-03T00:00:00.000Z', to: '2026-11-02T12:00:00.000Z',
        rows,
        totals: rows.reduce((a, x) => ({
          calls: a.calls + x.calls, promptTokens: a.promptTokens + x.promptTokens,
          completionTokens: a.completionTokens + x.completionTokens, totalTokens: a.totalTokens + x.totalTokens,
          noTokenCalls: a.noTokenCalls + x.noTokenCalls,
        }), { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, noTokenCalls: 0 }),
        channels: all.map((x) => ({ key: x.key, label: x.label, kind: x.kind })),
        note: '口径：只比 token（跨渠道金额不可比，不做换算）。金额列只转述记录里已有的标注：供应商自报 / 用户自填 / 未折算；'
          + '方寸不内置单价表、不猜单价。方寸自己调的（local）与外部客户端报上来的（external）分开算，不合并。'
          + '它证明不了什么：外部客户端没上报的调用根本不在表里，token 少不等于那边用得少。',
        emptyText: '近 30 天没有 AI 调用记录 —— 不是"没花钱"，是这段时间里方寸没调用过、外部客户端也没上报',
      },
    }
  },
  // 投入产出账（0.6.0 P5）：三格齐全的夹具。
  // 三格的 caveat 必须带“它证明不了什么”—— 界面断言会逐格检查（缺一格就红）。
  wasteGet: (opts) => {
    rec('wasteGet', [opts])
    return {
      ok: true,
      ledger: {
        days: 30,
        note: '口径：ai-trace 只记方寸自己发起的调用；外部 agent 的花销不在这一格；提交只算数据目录所在的仓库，其它仓库不算。',
        emptyText: '三格都取不到（ai-trace / git / 任务都没读到）—— 不拿 0 或“—”冒充。',
        cells: [
          { key: 'spend', label: '花了多少（近 30 天）', value: '¥0.0123 · 1,234 tokens',
            detail: '3 次调用', caveat: '它证明不了什么：ai-trace 只记方寸自己发起的调用，外部 agent 没上报的花销不在这一格；它也没有项目字段，不能分摊到某个项目。' },
          { key: 'output', label: '产出了什么（近 30 天）', value: '12 次提交 · 3 张卡完成',
            detail: '提交按数据目录所在的仓库统计', caveat: '它证明不了什么：提交数只说明仓库被改过，不说明改动有用；完成卡数是自报状态，不等于验收通过。' },
          { key: 'rejected', label: '哪几条被否', value: '2 张',
            detail: '驳回样例甲、驳回样例乙', caveat: '它证明不了什么：只列当前状态为“驳回”的卡；被否后删掉/归档的不在这里，也不代表它们没被否过。' },
        ],
      },
    }
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
  // ⚠ 2026-10-12：这里**必须** rec —— 顶栏“⟳ 同步”按钮的断言判据就是"真调到没有"
  //   （`callCount('backupGitPush')` 涨没涨）。此前它是裸箭头函数、从不计数
  //   → 断言恒 `calls=0`，把"按钮真的接线了"误报成"装饰按钮"（假红）。
  //   全局纪律：凡是断言要按"调用次数"判的通道，假 preload 里**一律先 rec**。
  backupGitPush: () => {
    rec('backupGitPush', [])
    // 被 __fcTest.holdSync() 按住时返回一个悬着的 Promise —— 断言就能在"进行中"这一帧
    // 检查胶囊文字与秒数（真 git 跑完得太快，抓不到中间态）
    if (store.syncHold) {
      return new Promise((resolve) => { store.syncResolve = resolve })
    }
    return { ok: false, message: '（夹具：没有真 git）' }
  },
  /**
   * 发送给 DSH（2026-11-17）：**必须 rec**。
   * 判据是「点按钮真调到通道没有」+「kind 有没有传对」——
   * 不 rec 就永远 calls=0，把"按钮接线了"误报成"装饰按钮"（本文件上方那条纪律）。
   */
  dispatchDsh: (projectId, kind) => {
    rec('dispatchDsh', [projectId, kind])
    return { ok: true, path: '（夹具）', projectId: String(projectId || ''), chars: 1234, missing: [], at: '2026-11-17T00:00:00.000Z', kind: kind || 'work' }
  },
  /**
   * 同步阶段流（2026-10-25 卡 004）：与真 preload 同名同形状，返回退订函数。
   * ⚠ 假桩必须与真桩同步（少一条 → 视图里 onSyncProgress 是 undefined，
   *   `syncPhase` 永远空 → 断言会看到“同步中”，把"没接线"误当成"降级正确"）。
   */
  onSyncProgress: (cb) => {
    rec('onSyncProgress', [])
    store.syncSubs.push(cb)
    return () => { store.syncSubs = store.syncSubs.filter((f) => f !== cb) }
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
  // 路线图夹具（2026-10-23 补）：此前一律 `{ projects: [] }` —— 于是路线图页在测试里
  // 永远停在“暂无路线图数据”，项目/批次/任务/下一步**四种渲染逻辑一条都没被验过**。
  // 拆组件时把它搬丢了，测试照样全绿。现在按 main/data/tasks.ts 的 RoadmapProject 真实形状给。
  aggregateRoadmap: () => {
    rec('aggregateRoadmap')
    return {
      generatedAt: 1761200000000,
      projects: [{
        id: 'demo', name: '演示项目', health: 'active', taskCount: 4,
        blockers: [],
        batches: [
          { name: 'P0 核心', status: 'completed', total: 2, done: 2,
            tasks: [
              { id: 'rm-1', title: '核心一', status: '完成' },
              { id: 'rm-2', title: '核心二', status: '完成' },
            ] },
          { name: 'P1 功能', status: 'active', total: 2, done: 0,
            tasks: [
              { id: 'rm-3', title: '功能一', status: '进行中' },
              { id: 'rm-4', title: '功能二', status: '待办' },
            ] },
        ],
        nextActions: [
          { taskId: 'rm-3', title: '功能一', priority: '高', batch: 'P1 功能' },
          { taskId: 'rm-4', title: '功能二', priority: '中', batch: 'P1 功能' },
        ],
      }],
    }
  },
  backupStatus: () => ({ ok: true, status: { enabled: false, running: false, nextRunAt: null, state: {} } }),
  /**
   * 备份配置：**返回真实形状** `{ok, config}`（2026-11-12 修）。
   *
   * ⚠ 原来这里是 `() => ({})` —— `r.ok` 是 undefined、`r.config` 是 undefined。
   *   渲染层 `bkLoadConfig()` 里读 `c.remote.url`（**没有可选链**），当场抛
   *   `Cannot read properties of undefined (reading 'remote')`；
   *   而 `bkSaveAndRun()` 第一步就是 `await bkSaveConfig(true)`，它又调 `backup:setConfig`
   *   → 那里 `r.config.remote.hasPassword` 再抛一次。
   *   结果：点「立即备份」**一个通道都没调**（实测 calls=[]），界面毫无反应 ——
   *   看起来就是“备份按钮坏了”。**根因是桩形状不对，整条路径从没被真跑过。**
   *   （与本文件 2026-10-23 记的“backupLog / backupListRemote 返回裸数组”是同一类洞。）
   */
  backupGetConfig: () => {
    rec('backupGetConfig')
    return {
      ok: true,
      config: {
        enabled: true, intervalHours: 6, firstDelayMinutes: 5,
        localKeep: 5, remoteKeep: 10, localDir: '',
        remote: { url: '', username: '', password: '', hasPassword: false, allowSelfSigned: false },
        slim: { excludeLogAttachments: false, maxFileMB: 10 },
        encrypt: { enabled: false, remember: false, password: '', hasPassword: false },
        secretStorageAvailable: true,
      },
    }
  },
  onBackupStatus: () => () => {},
  /**
   * 备份日志（2026-10-23 补夹具）。
   * ⚠ 形状必须是 `{ ok, lines }` —— 主进程 `backup:log` 回的就是这个（main/backup-ipc.ts:161）。
   *   此前桩返回**裸数组** `[]`：渲染层 `if (r.ok) bkLogLines = r.lines` 两个分支都拿不到东西，
   *   于是“查看备份日志”面板从来没被真渲染过一次 —— 空桩让整块界面等于没测。
   */
  backupLog: (n) => {
    rec('backupLog', [n])
    const all = [
      '[2026-10-23 21:00:01] INFO  备份 开始（range=full）',
      '[2026-10-23 21:00:04] INFO  备份 已打包 5 个文件 → fangcun-data-20261023-210004.zip',
      '[2026-10-23 21:00:05] WARN  备份 WebDAV 未配置，已跳过远端',
    ]
    const max = Number(n) || 120
    return { ok: true, lines: all.slice(Math.max(0, all.length - max)) }
  },
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
      // 卡 004：只有“日志转来”这条路带值（与真身 createTodo 同口径：无值不落键）
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
  //   ① “已立项”不许走 setStatus 进来；② 立项必须真往 store.todos 塞一条；
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

  // 记忆层（2026-11-17）· 假 preload 必须与真实现同步登记 ——
  // 否则界面断言测的是"假契约"，新通道过 cloneGuard 时也没人看守（AGENTS.md 踩坑第 1 条）。
  memorySearch: (q) => {
    rec('memorySearch', [q])
    const rows = (store.memory || []).filter((r) => {
      if (!q) return true
      if (!q.includeRevoked && r.status === '已撤销') return false
      if (q.type && !String(r.type).includes(q.type)) return false
      if (q.q) {
        const hay = `${r.title} ${r.summary} ${r.id}`.toLowerCase()
        if (!hay.includes(String(q.q).toLowerCase())) return false
      }
      return true
    })
    return { ok: true, total: rows.length, rows, returned: rows.length, overview: store.memoryOverview || { total: rows.length, effective: rows.length, revoked: 0, byType: {} } }
  },
  memoryRead: (file) => {
    rec('memoryRead', [file])
    // 假桩也要有真硬闸：只认 memory/，否则断言测不出越界被拒
    if (!String(file || '').startsWith('memory/') || String(file).includes('..')) {
      return { ok: false, error: '只能读 memory/ 下的文件' }
    }
    const hit = (store.memory || []).find((r) => r.file === file)
    return hit ? { ok: true, text: `---\nid: ${hit.id}\n---\n\n# ${hit.title}\n\n${hit.summary || ''}` } : { ok: false, error: 'not found' }
  },
  memoryOverview: () => {
    rec('memoryOverview')
    return store.memoryOverview || { total: 0, effective: 0, revoked: 0, byType: {}, hint: '记忆库还没有任何条目' }
  },
  memoryRebuild: () => {
    rec('memoryRebuild')
    return { count: (store.memory || []).length, path: 'memory/index.jsonl' }
  },
  // 写入（2026-11-18）· 桩必须**真动 store**，不能只 return ok()：
  // 只返回 ok 的桩会让"写进去了没有"这条断言永远绿（本仓 MEMORY 第十节的老坑）。
  memoryCreate: (input) => {
    rec('memoryCreate', [input])
    cloneGuard('memoryCreate', [input])
    const i = input || {}
    if (!String(i.type || '').trim()) return { ok: false, error: '类型不能空' }
    if (!String(i.title || '').trim()) return { ok: false, error: '标题不能空' }
    if (!String(i.body || '').trim()) return { ok: false, error: '原文不能空' }
    if (!String(i.source || '').trim()) return { ok: false, error: '来源不能空' }
    const file = `memory/2026-11/mem-20261118-${String((store.memory || []).length + 1).padStart(2, '0')}.md`
    store.memory = store.memory || []
    store.memory.push({
      id: `mem-20261118-${String(store.memory.length + 1).padStart(2, '0')}`,
      type: i.type, scope: i.scope || '', project: i.project || '', time: '2026-11-18T00:00:00Z',
      status: i.status || '有效', impact: i.impact || '', title: i.title,
      summary: String(i.body).slice(0, 120), file, source: i.source, tags: i.tags || [],
    })
    store.memoryOverview = {
      total: store.memory.length,
      effective: store.memory.filter((r) => r.status !== '已撤销').length,
      revoked: store.memory.filter((r) => r.status === '已撤销').length,
      byType: {},
    }
    return { ok: true, file }
  },
  memoryUpdate: (file, input) => {
    rec('memoryUpdate', [file, input])
    cloneGuard('memoryUpdate', [file, input])
    if (!String(file || '').startsWith('memory/')) return { ok: false, error: '只能改 memory/ 下的文件' }
    const hit = (store.memory || []).find((r) => r.file === file)
    if (!hit) return { ok: false, error: 'not found' }
    if (!String((input || {}).body || '').trim()) return { ok: false, error: '原文不能空' }
    hit.title = (input || {}).title || hit.title
    hit.type = (input || {}).type || hit.type
    hit.summary = String((input || {}).body).slice(0, 120)
    return { ok: true, file }
  },
  memorySetStatus: (file, status) => {
    rec('memorySetStatus', [file, status])
    cloneGuard('memorySetStatus', [file, status])
    const hit = (store.memory || []).find((r) => r.file === file)
    if (!hit) return { ok: false, error: 'not found' }
    if (status !== '有效' && status !== '已撤销') return { ok: false, error: '状态只能是 有效 / 已撤销' }
    hit.status = status
    store.memoryOverview = {
      total: (store.memory || []).length,
      effective: (store.memory || []).filter((r) => r.status !== '已撤销').length,
      revoked: (store.memory || []).filter((r) => r.status === '已撤销').length,
      byType: {},
    }
    return { ok: true, file }
  },

  /**
   * 真退出（2026-11-17 · 卡 p0-1「不同意并退出」永远退不掉）。
   *
   * ⚠ 假桩必须记一笔 —— 这是这条修复**唯一**能被断言的方式：
   *   真退出会杀掉进程，e2e 里不可能真退；能验的只有"点『不同意』时到底走了哪条路"。
   *   走 `window.close()` = 被主进程防抖成 hide = 退不掉（这就是原 bug）。
   *   所以断言要问的是：`quitForReal` 有没有被调用（而不是 window.close 有没有被调用）。
   */
  quitForReal: () => {
    rec('quitForReal')
    return { ok: true }
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
    if (status === '已立项') return { ok: false, error: '“立项”要走“做”那个动作' }
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
  ideasPromote: (id, opts) => {
    // 2026-11-08：第二参 target 必须记下来 —— 真主进程支持 {target:'task'} 建任务卡，
    // 假桩此前只认“变成待办”，于是“做成任务卡”这条路径**在渲染层等于没测**（踩过 6 次的同款坑）。
    rec('ideasPromote', [id, opts || null])
    const i = store.ideas.find((x) => x.id === id)
    if (!i) return { ok: false, error: '没有这条想法（可能已经删了）' }
    if (i.status === '已立项') return { ok: false, error: '已经立项过了' }
    const now = new Date().toISOString()
    if (opts && opts.target === 'task') {
      // 做成任务卡：真往任务夹具里塞一张（能进看板/阻塞链），与主进程 promoteIdea 同语义
      const tid = nextId('task')
      const title = i.text.split('\n')[0].trim()
      store.tasks.push({
        id: tid, title, status: '待办', priority: '中', project: '', tags: [], body: i.text,
        created: now, updated: now,
        fm: { id: tid, title, status: '待办', priority: '中', project: '' },
        path: 'C:/mock/task-data/' + tid + '.md',
      })
      i.status = '已立项'
      i.decidedAt = i.decidedAt || now
      i.updatedAt = now
      i.promoted = { kind: 'task', id: tid }
      return { ok: true, idea: JSON.parse(JSON.stringify(i)), taskId: tid }
    }
    // 真往待办塞一条 —— 与主进程 promoteIdea 同语义
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
  /**
   * 日志列表（2026-10-23 补：记账 + 真按 filter 过滤）。
   * ⚠ 此前是 `() => store.logs.slice()` —— **不看 filter 也不记账**，于是
   *   “搜索框里打的词到底有没有进 IPC”“项目/Agent/日期筛选有没有生效”全都验不到：
   *   界面能打字、能选下拉，但传了什么完全看不见（第 11 块拆分时这里正是最容易坏的地方）。
   *   过滤语义照抄主进程 main/services/logs.ts:listLogs（query 命中标题/正文/下一步/项目）。
   */
  logsList: (filter) => {
    rec('logsList', [filter])
    const f = filter || {}
    const q = String(f.query || '').trim().toLowerCase()
    const hit = (s) => String(s || '').toLowerCase().includes(q)
    let rows = (store.logs || []).filter((l) => {
      if (f.project && l.project !== f.project) return false
      if (f.status && l.status !== f.status) return false
      if (f.agent && l.agentName !== f.agent) return false
      const d = String(l.logDate || l.created || '').slice(0, 10)
      if (f.dateFrom && d < f.dateFrom) return false
      if (f.dateTo && d > f.dateTo) return false
      if (q && !(hit(l.title) || hit(l.content) || hit(l.nextSteps) || hit(l.project))) return false
      return true
    })
    rows = rows.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    return rows
  },
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
  // 桩此前无条件 ok() = 桩-现实漂移（批量优先级的“跳过 N 条”会永远测不到）。
  logsUpdate: (id, updates) => {
    rec('logsUpdate', [id, updates])
    const l = (store.logs || []).find(x => x.id === id)
    if (!l) return { ok: false, error: '日志不存在' }
    if (l.status !== 'active') return { ok: false, error: `日志状态为 ${l.status}，无法编辑` }
    Object.assign(l, updates)
    return ok()
  },
  // 2026-10-17：桩此前是 `() => ok()` —— 既不记账也不动状态，于是“保存并完成 = 先
  // logsUpdate 再 logsComplete”这类**顺序断言恒红**（调用都发生了，桩看不见）。
  // 按真后端 logs.ts 语义补：记账 + 状态置“完成”。
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
  // （“转换后源日志进了已归档分区”这种断言会恒绿假过）—— 搬真实语义进桩。
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
  // 2026-09-28 用户第 2 条：“进行中”是手动开关，唯一写入路径
  // 2026-11-01：同步真后端的"退回上一格"语义（已完成/已归档点开再撤销要回原格，不是待处理）
  logsSetRunning: (id, running) => {
    rec('logsSetRunning', [id, running])
    const l = store.logs.find(x => x.id === id)
    if (!l) return { ok: false, error: '日志不存在' }
    if (running) {
      if (l.status !== 'active') { l.runningFrom = l.status; l.status = 'active' }
    } else if (l.status === 'active' && l.runningFrom) {
      l.status = l.runningFrom
      l.runningFrom = undefined
    }
    l.running = !!running
    return ok({ log: l })
  },
  // ── 主日志 + 附属日志（2026-10-30 暮雨第 4 条）──────────────────────
  // 桩按真后端语义：关系只存在主日志的 attached 上；全组动作跳过完成/归档。
  logsSetAttached: (mainId, ids) => {
    cloneGuard('logsSetAttached', [mainId, ids])
    rec('logsSetAttached', [mainId, ids])
    const main = store.logs.find(x => x.id === mainId)
    if (!main) return { ok: false, error: '主日志不存在' }
    const want = (Array.isArray(ids) ? ids : []).map(String).filter((x) => x && x !== mainId)
    main.attached = Array.from(new Set(want))
    return ok({ data: main })
  },
  logsGroupRunning: (mainId, running) => {
    rec('logsGroupRunning', [mainId, running])
    const main = store.logs.find(x => x.id === mainId)
    if (!main) return { ok: false, error: '主日志不存在' }
    const ids = [main.id, ...(main.attached || [])]
    const changed = []
    const skipped = []
    for (const id of ids) {
      const l = store.logs.find(x => x.id === id)
      if (!l || l.status !== 'active' || !!l.running === !!running) { skipped.push(id); continue }
      l.running = !!running
      changed.push(id)
    }
    return ok({ changed, skipped })
  },
  logsGroupComplete: (mainId, retainDays, note) => {
    rec('logsGroupComplete', [mainId, retainDays, note])
    const main = store.logs.find(x => x.id === mainId)
    if (!main) return { ok: false, error: '主日志不存在' }
    const ids = [main.id, ...(main.attached || [])]
    const changed = []
    const skipped = []
    for (const id of ids) {
      const l = store.logs.find(x => x.id === id)
      if (!l || l.status === 'completed' || l.status === 'archived') { skipped.push(id); continue }
      l.status = 'completed'; l.running = false; l.completed = new Date().toISOString(); l.retainDays = retainDays
      changed.push(id)
    }
    return ok({ changed, skipped })
  },
  logsStateSnapshot: (id) => {
    rec('logsStateSnapshot', [id])
    const l = store.logs.find(x => x.id === id)
    if (!l) return { ok: false, error: '日志不存在' }
    return ok({
      status: l.status, running: !!l.running,
      runningFrom: l.runningFrom || null,
      completed: l.completed || null, retainDays: l.retainDays ?? null,
      retainUntil: l.retainUntil || null, note: l.note || '', archiveNote: l.archiveNote || '',
    })
  },
  logsRestoreState: (id, snap) => {
    rec('logsRestoreState', [id, snap])
    const l = store.logs.find(x => x.id === id)
    if (!l) return { ok: false, error: '日志不存在' }
    Object.assign(l, snap || {})
    return ok({ data: l })
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
  /**
   * 清理超期日志（2026-10-23 补夹具）：主进程返回**被归档的日志 id 数组**
   * （main/services/logs.ts:878 `cleanupLogs(): string[]`），界面按 `length` 说
   * “已将 N 条超期日志标为“已归档””。
   * ⚠ 此前桩恒返回空数组 → 那句话里的 N 永远是 0，界面只会说“没有超期日志”，
   *   于是“真清理到东西之后文案对不对”这一支从没被验过。
   */
  logsCleanup: () => { rec('logsCleanup'); return ['log-old-a', 'log-old-b'] },
  // 2026-10-13 暮雨第 2 条：按日期批量清理“已归档”日志（软删）。
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
  // ⚠ 2026-10-29：这三个入口此前**根本没登记**（`logsPickFiles` / `logsAttachData` 缺，
  //   `logsAttachFiles` 也不收 sources）——
  //   于是“新建日志时先选附件、保存时一起挂上”这条链路在无头断言里**从未被跑过**，
  //   真机上“创建日志 + 粘贴图 → 保存永远失败”就这么漏过去了。
  //   现在按真 preload 的签名登记，并给每条**都加 cloneGuard**（真实机第一跳语义）。
  logsPickFiles: () => {
    rec('logsPickFiles')
    return { ok: true, paths: ['C:/fake/截图A.png'] }
  },
  logsAttachFiles: (id, sources) => {
    cloneGuard('logsAttachFiles', [id, sources])
    rec('logsAttachFiles', [id, sources])
    const row = (store.logs || []).find(x => x.id === id)
    if (!row) return { ok: false, error: '日志不存在' }
    // 真实现是主进程弹系统框（sources 为空时）或直接复制这批路径（有 sources 时）；
    // 桩两种都走“追加条目”，并**如实记下调用方给了几个 sources**，供断言对账。
    const n = Array.isArray(sources) && sources.length ? sources.length : 1
    const add = Array.from({ length: n }, (_, i) =>
      `docs/执行日志/_attachments/${id}/新添加_${(row.attachments || []).length + i + 1}.png`)
    row.attachments = [...(row.attachments || []), ...add]
    return { ok: true, data: { ...row }, added: add.length }
  },
  logsAttachData: (id, items) => {
    cloneGuard('logsAttachData', [id, items])
    rec('logsAttachData', [id, items])
    const row = (store.logs || []).find(x => x.id === id)
    if (!row) return { ok: false, error: '日志不存在' }
    const list = Array.isArray(items) ? items : []
    const add = list.map((it, i) =>
      `docs/执行日志/_attachments/${id}/${String((it && it.name) || '粘贴')}_${(row.attachments || []).length + i + 1}.png`)
    row.attachments = [...(row.attachments || []), ...add]
    return { ok: true, data: { ...row }, added: add.length, skipped: [] }
  },
  // 2026-10-29：这两个此前**完全没登记** —— 单条“📋 复制”与新的“⧉ 开工单”在无头断言里都是死通道。
  // 桩只负责**记账 + 返回可辨认的文本**；真正的拼接语义（主日志在前、副日志标“并行”）
  // 由 e2e-mcp-logs 跑真 services/logs.injectLogs 验 —— 桩里再实现一遍就等于自欺。
  // 点系统通知回到对象（2026-10-29）：真通道是主进程 webContents.send('notify:focus')。
  // 桩负责订阅 + 提供 __fcTest.emitNotifyFocus 供断言手动喂一条。
  onNotifyFocus: (cb) => {
    rec('onNotifyFocus')
    store.notifySubs = store.notifySubs || []
    store.notifySubs.push(cb)
    return () => { store.notifySubs = (store.notifySubs || []).filter(x => x !== cb) }
  },
  logsInject: (id) => {
    cloneGuard('logsInject', [id])
    rec('logsInject', [id])
    const row = (store.logs || []).find(x => x.id === id)
    if (!row) return null
    return 'mock-log:' + id + ':' + String(row.content || '')
  },
  logsInjectMany: (ids) => {
    cloneGuard('logsInjectMany', [ids])
    rec('logsInjectMany', [ids])
    const list = Array.isArray(ids) ? ids.map(String) : []
    const rows = list.map(id => (store.logs || []).find(x => x.id === id)).filter(Boolean)
    if (!rows.length) return { text: '', found: [], missing: list }
    return {
      text: 'mock-bundle ' + list.join(' + '),
      found: rows.map(r => r.id),
      missing: list.filter(id => !rows.some(r => r.id === id)),
    }
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
    // 1×1 透明 PNG，够断言“img 的 src 真是 data:image/png”
    data: { mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', name: 'x.png' },
  }),
  logsOpenAttachment: (rel) => {
    rec('logsOpenAttachment', [rel])
    // 2026-10-30 白屏事故：可执行/安装包不直接运行，只返回"去文件夹里定位"
    if (/\.(exe|msi|bat|cmd|ps1|lnk|scr|jar)$/i.test(String(rel || ''))) {
      return { ok: false, needsReveal: true, ext: '.exe', error: '“Fangcun-Setup.exe”是可执行 / 安装文件，方寸不会直接运行它', hint: '请先在文件夹中定位，确认来源后再双击。' }
    }
    return { ok: true }
  },
  // 可执行附件不直接运行，只定位（2026-10-30 白屏事故）
  logsRevealAttachment: (rel) => { rec('logsRevealAttachment', [rel]); return { ok: true, path: 'C:/mock/' + rel } },
  // 自仓启动同步状态（2026-10-21 · W1-1C）：真主进程启动时跑完 git pull 后给结果，
  // 桩默认“已是最新”；断言用 __fcTest.setSelfSync() 换成“待同步”再看界面说没说真话。
  // 项目路线文档实况（2026-10-21 · W1-批次 2）：真主进程读仓库 README/ROADMAP + 最近 docs 变更。
  // 桩给一份“两份文档都在 + 一条 docs 提交”的常态；断言用 __fcTest.setProjectDocs() 换形态。
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
    // 2026-10-21：此前恒返回 `[]` —— “任务详情的关联日志”那块在无头断言里是**死的**
    // （连"完成后这里有没有撤销按钮"都验不了）。按真后端语义补：按 taskIds 过滤。
    // ⚠ 真后端返回的是**数组本身**（不是 {ok:...}），桩必须同形状。
    return (store.logs || []).filter(l => (l.taskIds || []).indexOf(taskId) >= 0)
  },

  // ── 剪贴板（渲染层复制一律走主进程通道，见 shared/clipboard.ts ①）─────
  clipboardWriteText: (text) => { rec('clipboardWriteText', [text]); return ok() },

  // ── 开工简报（2026-11-16 · 治病① 的入口）─────────────────────────────
  // ⚠ 桩必须与真后端**同形状**：真身返回 { ok, project, markdown, bytes, budget, overBudget }。
  //   这里故意给一份**带「算不出」的**简报 —— 因为渲染层那条"别拿空白当结论"的
  //   toast 只有在算不出时才出现，给一份全好的简报等于那条断言永远测不到。
  brief: (projectId) => {
    rec('brief', [projectId])
    return ok({
      ok: true,
      project: projectId,
      markdown: '# 开工简报 · ' + projectId + '\n\n## ① 上次做到哪\n\n- **算不出**：没有日志\n',
      bytes: 1200,
      budget: 8192,
      overBudget: false,
    })
  },

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
  // ── 问卷（2026-11-05）：吃 agent 写的 md，弹窗里答，批准后落决策卡 ──
  questionnaireList: () => {
    rec('questionnaireList')
    return {
      ok: true,
      dir: 'C:/mock/task-data/questionnaires',
      decks: [
        { deck: '司天-宪法层', title: '司天问卷·宪法层（2026-11-04）', layer: '宪法层', total: 3, answered: 0, approved: false, project: 'sitian', ageDays: 2, refCount: 0 },
        { deck: '墨坊-宪法层', title: '墨坊问卷·宪法层（2026-11-04）', layer: '宪法层', total: 2, answered: 2, approved: true, project: 'ronghua', ageDays: 40, refCount: 0 },
      ],
    }
  },
  // ── 问卷管理（2026-11-11）：搜索 / 归档候选 / 归档 / 取消归档 ────────────
  // 假 preload 必须同步登记（记忆第 7 次）：漏一个，界面上那条路就只会吐一句 toast，
  // 断言测到的其实是“被 try/catch 吞掉”。
  questionnaireSearch: (query, opts) => {
    rec('questionnaireSearch', [query || '', opts || null])
    const q = String(query || '').trim()
    const all = [
      { deck: '司天-宪法层', title: '司天问卷·宪法层（2026-11-04）', layer: '宪法层', total: 3, answered: 0, approved: false, project: 'sitian' },
      { deck: '墨坊-宪法层', title: '墨坊问卷·宪法层（2026-11-04）', layer: '宪法层', total: 2, answered: 2, approved: true, project: 'ronghua' },
    ]
    const hits = {}
    const decks = all.filter((d) => {
      const where = []
      if (d.deck.indexOf(q) >= 0 || d.title.indexOf(q) >= 0) where.push('卷名')
      if (d.project.indexOf(q) >= 0) where.push('项目')
      // 题面命中：墨坊那卷的 M1 问的是“稿子形态”，搜“稿”要能命中题面
      if (q === '稿' && d.deck === '墨坊-宪法层') where.push('题面 M1')
      if (!where.length) return false
      hits[d.deck] = where
      return true
    })
    return { ok: true, decks: q ? decks : all, hits, scanned: all.length }
  },
  questionnaireArchivable: (days) => {
    rec('questionnaireArchivable', [days])
    // 夹具：墨坊那卷已批准 40 天、无卡引用 → 够格归入历史卷
    return {
      ok: true, days: Number(days) || 30,
      decks: [{ deck: '墨坊-宪法层', title: '墨坊问卷·宪法层（2026-11-04）', approved: true, ageDays: 40, refCount: 0 }],
      blocked: [],
    }
  },
  questionnaireArchive: (deck, reason) => {
    rec('questionnaireArchive', [deck || '', reason || ''])
    return { ok: true, deck }
  },
  questionnaireUnarchive: (deck) => {
    rec('questionnaireUnarchive', [deck || ''])
    return { ok: true, deck }
  },
  // 题库 ↔ 卷 ↔ 卡 关系视图（0.7.0 P11）：夹具给三条能对上账的关系行
  questionnaireBankRelations: (project) => {
    rec('questionnaireBankRelations', [project || ''])
    return {
      ok: true,
      rows: [
        {
          id: 'Q001', ask: '验收线要不要写进卡里？', status: '已答', project: project || 'sitian',
          line: '每张卡的验收清单非空', fingerprint: 'aaaa1111',
          sources: [{ deck: '司天-宪法层', qid: 'S1', status: '已批准', answered: true,
            delivered: [{ cardId: 'task-demo-1', date: '2026-11-01', passed: true }] }],
          cards: ['task-demo-1'], notes: [],
        },
        {
          id: 'Q002', ask: '备份要不要做恢复演练？', status: '已答', project: project || 'sitian',
          line: '每季度一次恢复演练并留证据', fingerprint: 'bbbb2222',
          sources: [{ deck: '司天-宪法层', qid: 'S2', status: '已批准', answered: true, delivered: [] }],
          cards: [], notes: ['答案都在，但还没有卡带着这条验收线'],
        },
        {
          id: 'Q003', ask: '多项目优先级谁说了算？', status: '待答', project: project || 'sitian',
          line: '', fingerprint: 'cccc3333', sources: [], cards: [],
          notes: ['没有卷问过它（题在库里，卷已删或从未出卷）'],
        },
      ],
      stats: { questions: 3, withDeck: 2, withCard: 1, orphan: 1, answeredNoCard: 1 },
    }
  },
  questionnaireBatchAction: (input) => {
    rec('questionnaireBatchAction', [input && input.action ? input.action : '', (input && input.decks) || []])
    cloneGuard('questionnaireBatchAction', [input])
    const decks = (input && input.decks) || []
    // 夹具故意留一卷“卷面坏掉”：批量里它必须失败并被点名，其余照做
    const bad = decks.filter((d) => String(d).indexOf('坏') >= 0)
    return {
      ok: bad.length === 0,
      action: input && input.action === 'void' ? 'void' : 'archive',
      done: decks.filter((d) => bad.indexOf(d) < 0),
      failed: bad.map((d) => ({ deck: d, error: '卷面解析不出题（坏卷）' })),
      note: bad.length ? `逐卷走同一条通道：成功 1 卷、失败 ${bad.length} 卷` : '逐卷走同一条通道：全部处理完成',
    }
  },
  // 结论集收敛进度（P8 · D-064）：夹具给一句“未收敛”，让界面那行有东西可验
  questionnaireConvergence: (deck) => {
    rec('questionnaireConvergence', [deck || ''])
    return {
      summary: '未收敛：连续不变 1/3（本轮新增 0 / 减少 0 / 共 12 条）',
      need: 3, project: 'sitian',
      snapshot: { algo: 1, project: 'sitian', streak: 1, lastAdded: 0, lastRemoved: 0, total: 12, fps: [] },
    }
  },
  questionnaireGet: (deck) => {
    rec('questionnaireGet', [deck])
    if (!store.qnApproved) store.qnApproved = {}
    const approvedAt = store.qnApproved[deck] || ''
    // 第二卷：只有 1 题、没有反问 —— 用来验“反问清零后才给『生成施工单』”那个分支。
    // 没有它的话，那个按钮在测试里永远点到不到（只验了“有反问”一侧 = 半条断言）。
    if (deck === '墨坊-宪法层') {
      return {
        ok: true, deck, path: 'C:/mock/task-data/questionnaires/墨坊-宪法层.md',
        approvedAt: '2026-11-05T10:00:00.000Z',
        answers: {},
        parsed: {
          title: '墨坊问卷·宪法层（2026-11-04）', layer: '宪法层',
          boundary: '给暮雨答', lookTable: [], parked: [], parkedHead: [],
          questions: [{
            id: 'M1', nav: '稿子形态', ask: '墨坊先做哪一种稿？',
            options: [
              { k: 'A', t: '长文', d: '一次成篇' },
              { k: 'B', t: '短帖', d: '快速出稿' },
            ],
            src: 'M1 原话', line: '不带形态标签的稿子一律打回',
            look: '', prefilled: false, prefilledNote: '',
            opinion: 'B：先出短篇能把管线跑通，长篇容易卡在素材。', recommend: 'B',
          }],
        },
      }
    }
    return {
      ok: true,
      deck,
      path: 'C:/mock/task-data/questionnaires/' + deck + '.md',
      approvedAt,
      answers: JSON.parse(JSON.stringify(store.qnAnswers || {})),
      // 2026-11-08：审计结论 / 作废态也必须回给组件（此前只回 answers，界面永远是“没校验”）
      audits: (() => {
        const out = {}
        for (const k of Object.keys(store.qnAudits || {})) {
          const [d, id] = k.split('::')
          if (d === deck) out[id] = store.qnAudits[k]
        }
        return out
      })(),
      voidedAt: (store.qnVoided && store.qnVoided[deck] && store.qnVoided[deck].at) || '',
      voidReason: (store.qnVoided && store.qnVoided[deck] && store.qnVoided[deck].reason) || '',
      costGaps: [],
      parsed: {
        title: '司天问卷·宪法层（2026-11-04）',
        layer: '宪法层',
        boundary: '给暮雨答（打勾/否决/改一句）；答案落 decision-log',
        // 「入口总表」：裁决层 A 靠这张表给链接，不逐题重复贴
        lookTable: [
          { nm: 'WorldPainter', ds: '桌面手绘地图', url: 'https://www.worldpainter.net' },
          { nm: '易制地图', ds: '网页涂色', url: 'https://www.yizhihua.com' },
        ],
        // 「预埋」：现在答不了的那些题。表头原样给 —— 司天写“挂出条件/参照物”，
        // 墨坊写“缺什么/什么时候能答”，界面不许硬编一种。
        parkedHead: ['题', '挂出条件', '参照物'],
        parked: [
          { q: '手感对标（WorldPainter / vvd）', need: '两件亲跑实测后', when: '实测截图' },
          { q: '旧司天什么留什么丢', need: '本地供旧司天实况图后', when: '旧司天截图' },
        ],
        questions: [
          {
            id: 'S1', nav: '最终形态', ask: '司天做一件还是两件？',
            options: [
              { k: 'A', t: '生成器 + 编辑器分两件', d: '抄业界主流（Gaea 生成 → WorldPainter 编辑）' },
              { k: 'B', t: '一体化单件', d: '抄易制地图形态，每样都得自己写' },
              { k: 'C', t: '只做编辑器', d: '生成外包给现成件' },
            ],
            src: '四问总表§一', line: '凡跨形态派单的司天任务卡一律打回',
            look: 'WorldPainter — 桌面手绘；易制地图 — 网页涂色', prefilled: false, prefilledNote: '',
            // 2026-11-15：给这条夹具一条**真意见**，界面才能验「我倾向 B」与角标。
            // 只给选项 = 把决策成本转嫁回用户 —— 这一条同时是那个病根的回归证据。
            opinion: 'B：先出短篇能把管线跑通，长篇容易卡在素材。', recommend: 'B',
          },
          {
            id: 'S3', nav: '验收方式', ask: '每轮产出怎么验收？',
            options: [
              { k: 'A', t: '你亲眼看', d: '每轮附“看什么”清单' },
              { k: 'B', t: '像素基线自动比对', d: '机器先过一遍' },
            ],
            src: '11-03 施工单事故结论④', line: '无“看什么”清单即不合格',
            look: '', prefilled: false, prefilledNote: '',
          },
          {
            id: 'S5', nav: '平台（已答过）', ask: '平台按 Windows 11 桌面本地，对吗？',
            options: [], src: '10-16 原话', line: '环境段统一 Win11',
            look: '', prefilled: true, prefilledNote: '这题答过 —— 沿用就打勾，变则改一句',
          },
        ],
      },
    }
  },
  questionnaireSaveAnswers: (deck, answers) => {
    rec('questionnaireSaveAnswers', [deck, answers])
    cloneGuard('questionnaireSaveAnswers', [deck, answers])
    store.qnAnswers = JSON.parse(JSON.stringify(answers || {}))
    return { ok: true }
  },
  questionnaireApprove: (deck) => {
    rec('questionnaireApprove', [deck])
    if (!store.qnApproved) store.qnApproved = {}
    store.qnApproved[deck] = new Date().toISOString()
    return { ok: true, cards: 1, existed: 0, exportPath: 'C:/mock/task-data/questionnaires/' + deck + '.decision-log.md', text: '# 答卷\n' }
  },
  questionnairePrompt: (deck, kind) => {
    rec('questionnairePrompt', [deck, kind])
    // 复刻后端语义：有反问就不许出施工单（桩必须和后端同规，否则测的是假规矩）
    const asks = Object.keys(store.qnAnswers || {}).filter((k) => {
      const a = store.qnAnswers[k]
      return a && a.kind === 'askback' && String(a.text || '').trim()
    })
    if (kind === 'build' && asks.length) {
      return { ok: false, askbacks: asks.length, open: 0,
        error: `还有 ${asks.length} 道题被反问 —— 问题还没定，这时候出的施工单必然是错的。先「重出题」。` }
    }
    const text = kind === 'rewrite'
      ? '# 重出题提示词\n\n只重写被反问的那 1 道题，别把整卷重发。\n暮雨的反问：这题问错了：真正该问的是地图给谁看\n'
      : '# 施工单提示词\n\n## 已定的（照这个做）\n- **M1** 选择：A. 长文\n  - 验收线：不带形态标签的稿子一律打回\n'
    return { ok: true, kind, askbacks: asks.length, open: 0, text }
  },
  questionnaireOpenDir: () => { rec('questionnaireOpenDir'); return { ok: true, dir: 'C:/mock/task-data/questionnaires' } },
  // ── 2026-11-08（暮雨第 5 条“帮我验所谓的三块界面”）───────────────
  // 实测发现：组件调了 5 个问卷 API，假桩**一个都没有** —— 点下去是 TypeError，
  // 被组件自己的 try/catch 吞成一句 toast。于是“三块界面验收”在渲染层从来是空的。
  // 这与记忆里“假 preload 必须同步”同款（第 7 次），补上并全部记账。
  questionnaireAuditQueue: () => {
    rec('questionnaireAuditQueue')
    // 给一条“该看一眼了”，让 selectDeck 那屏的 due 列表也有东西可验
    return { ok: true, rows: [{ deck: '司天-宪法层', id: 'S1', ask: '最终形态是什么', days: 12, due: true, refuted: false }] }
  },
  questionnaireAudit: (deck, id, verdict, evidence) => {
    rec('questionnaireAudit', [deck, id, verdict, evidence || ''])
    if (!store.qnAudits) store.qnAudits = {}
    store.qnAudits[deck + '::' + id] = { verdict, evidence: String(evidence || ''), at: new Date().toISOString() }
    return { ok: true, id, verdict, revoked: false }
  },
  questionnaireMakeCards: (deck, opts) => {
    rec('questionnaireMakeCards', [deck, opts || null])
    if (!store.qnCards) store.qnCards = {}
    store.qnCards[deck] = { created: 1, at: new Date().toISOString() }
    return { ok: true, created: 1, existed: 0, taskIds: ['task-from-qn-001'], project: (opts && opts.project) || '' }
  },
  questionnaireDispatchContext: (deck, project) => {
    rec('questionnaireDispatchContext', [deck || '', project || ''])
    cloneGuard('questionnaireDispatchContext', [deck, project])
    return {
      gate: { ok: true, deck: deck || '司天-宪法层', project: project || 'sitian' },
      rulings: [{ deck: deck || '司天-宪法层', qid: 'S1', line: '出现反例即违约' }],
    }
  },
  appMode: () => {
    rec('appMode')
    // 夹具固定为开发态：渲染层要能显示“依据逐条摊开”，而不是只显示一句结论
    return {
      mode: 'dev', packaged: false,
      exePath: 'C:/mock/node_modules/electron/dist/electron.exe',
      appPath: 'C:/mock/fangcun/desktop',
      dataDir: 'C:/mock/data',
      summary: '开发态：这是源码仓库。AI 改源码前必须先说明改哪个文件 / 改什么 / 为什么，人点头再动手。',
      signals: [
        { key: 'app.isPackaged', value: 'false', note: '不是打包版（npm run dev / electron .）' },
        { key: '应用路径', value: 'C:/mock/fangcun/desktop', note: '在源码目录里 = 开发态' },
        { key: '可执行文件', value: 'electron.exe', note: 'electron.exe = 开发态' },
        { key: '数据目录', value: 'C:/mock/data', note: '开发态的数据在仓库里' },
      ],
    }
  },
  questionnaireVoidDeck: (deck, reason) => {
    rec('questionnaireVoidDeck', [deck, reason || ''])
    if (!store.qnVoided) store.qnVoided = {}
    if (!String(reason || '').trim()) return { ok: false, error: '作废必须写原因' }
    store.qnVoided[deck] = { at: new Date().toISOString(), reason }
    return { ok: true, deck }
  },
  questionnaireReopenDeck: (deck) => {
    rec('questionnaireReopenDeck', [deck])
    if (store.qnVoided) delete store.qnVoided[deck]
    return { ok: true, deck }
  },

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
      prompt: `请把方寸（tegula）的“${id}”这个技能装到你自己身上：\n- 技能文件（绝对路径）：${dir}/${id}/SKILL.md`,
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

  // ── 技能自动同步的留痕（2026-11-05 暮雨：“更新后无法自动更新技能吗？”）──
  // 默认“已同步且与当前版本一致”。断言用 `__fcTest.setSkillSync({ stale: true, ... })`
  // 换成“升级后没同步”的形态，再看技能页有没有说真话 —— 这条正是它存在的全部意义：
  // 以前"没同步"和"同步成功"在界面上长得一模一样。
  skillsSyncStatus: () => { rec('skillsSyncStatus'); return ok(store.skillSync) },
  skillsSyncNow: () => {
    rec('skillsSyncNow')
    const nowVersion = store.skillSync.currentVersion
    store.skillSync = {
      ...store.skillSync,
      stale: false,
      staleReason: '',
      status: {
        at: new Date().toISOString(), appVersion: nowVersion, trigger: 'manual', ok: true,
        skills: store.skillSync.skills,
        targets: store.skillSync.status.targets.map((t) => ({ ...t, needsInstall: false, installed: ['fangcun-bridge'], errors: [] })),
      },
    }
    return ok({ ...store.skillSync, lastRun: store.skillSync.status })
  },

  // ── 技能直接导入（2026-09-26 卡 005）──────────────────────────────
  skillsImported: () => { rec('skillsImported'); return ok({ items: store.imported.slice() }) },
  skillsImportPick: (kind) => {
    rec('skillsImportPick', [kind])
    return ok(store.pickPath ? { path: store.pickPath } : { canceled: true })
  },
  skillsImport: (srcPath, opts) => {
    rec('skillsImport', [srcPath, !!(opts && opts.overwrite)])
    if (store.importExists && !(opts && opts.overwrite)) {
      return ok({ ok: false, code: 'exists', name: store.importName, error: `“${store.importName}”已经存在` })
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
  //   服务页“启动台应用”分区一起删除 —— 真 preload 里也没有了。
  //   假 preload 与真 preload 必须同步：留着它会造出"界面以为有这个通道"的假绿。

  // ── 装到别的 agent（2026-09-26 回执：只有 Hermes 可装；2026-10-03 卡 011：加 DSH）──
  agentsList: () => {
    rec('agentsList')
    return ok({ agents: [
      { id: 'hermes', name: 'Hermes', mode: 'installable', detected: true,
        evidence: 'C:/mock/hermes/skills', skillsDir: 'C:/mock/hermes/skills', howTo: '点上面“⚡ 装到 Hermes”',
        skillLinked: true, mcpLinked: false, linkDetail: '技能副本已装 · MCP 配置未含 fangcun' },
      { id: 'dsh', name: 'DSH (DeepSeek Harness)', mode: 'installable', detected: true,
        evidence: 'C:/mock/home/.dsh/profiles/desktop/cordis.patch.yml', skillsDir: 'C:/mock/home/.dsh/skills',
        skillLinked: false, mcpLinked: true, linkDetail: '技能副本未装 · MCP 配置含 fangcun',
        howTo: '点“⚡ 装到 DSH”写进 ~/.dsh/skills/<名>/SKILL.md' },
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
  // 在任何断言里都是空的（永远“检测中…”），组件拆坏了也没人知道。
  // 现在按主进程真实形状给：两个入口（A 可用 / B 不可用）+ 两个目标（一个检测到、一个没有）。
  mcpInfo: () => {
    rec('mcpInfo')
    return ok({
      entries: [
        { id: 'A', label: 'MCP 客户端配置（A）', available: true, usage: '写进对方的 MCP servers 段', detail: '' },
        { id: 'B', label: '整文件替换（B）', available: false, usage: '', detail: '需要对方没有既有配置才可用' },
      ],
      targets: [
        // 2026-11-06：多了 `linked`（配置文件里到底有没有 fangcun 条目）——
        // 暮雨：“方寸已有专属 DSH 插件，但技能页签中完全无体现。”
        // 三行各司其职：Hermes=装了但没接入（验"方寸未接入"+“⚡ 接入到 Hermes”按钮）、
        // DSH=没装（反例：不许说接入）、Cursor=装且已接入（验"方寸已接入"）。
        { id: 'hermes', name: 'Hermes', detected: true, evidence: 'C:/mock/hermes/config.yaml',
          configPath: 'C:/mock/hermes/config.yaml', linked: false,
          linkedDetail: 'C:/mock/hermes/config.yaml 里还没有 fangcun 条目',
          howTo: '复制配置段 → 打开配置文件粘贴保存' },
        { id: 'dsh', name: 'DSH', detected: false, evidence: 'C:/mock/home/.dsh/cordis.patch.yml',
          configPath: 'C:/mock/home/.dsh/cordis.patch.yml', howTo: '复制配置段 → 粘贴保存' },
        { id: 'cursor', name: 'Cursor', detected: true, evidence: 'C:/mock/cursor/mcp.json',
          configPath: 'C:/mock/cursor/mcp.json', linked: true,
          linkedDetail: 'C:/mock/cursor/mcp.json 里已有 fangcun 条目（第 7 行 "fangcun": {）',
          howTo: '复制配置段 → 粘贴保存' },
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
  // 2026-11-06：方寸唯一会写别人配置文件的通道（只 Hermes）。桩必须记账，
  // 否则“点了按钮到底走没走主进程”这件事在渲染层永远测不到。
  // 2026-11-06：DSH 侧的方寸插件（只读块）。
  // 暮雨：“依然未体现 DSH 插件相关，且 DSH 插件应该自带把方寸接入的功能。”
  mcpDshPlugin: () => {
    rec('mcpDshPlugin')
    return ok({
      dshHome: 'C:/mock/.dsh',
      installed: true,
      profile: 'desktop',
      profileDir: 'C:/mock/.dsh/profiles/desktop',
      plugins: [{
        name: 'dsh-fangcun', bundled: true, version: '0.3.0',
        spec: 'link:E:/CODE/CangKu/dsh-fangcun', linkedDir: 'E:/CODE/CangKu/dsh-fangcun',
        selfConnect: '命名管道（插件自己直连方寸，不需要在 patch 里写 command）',
      }],
      pipe: { path: '\\\\.\\pipe\\tegula-mcp', alive: true },
      legacy: {
        line: 38, plugin: '@deepseek-ai/dsh-mcp-client',
        command: 'E:\\CODE\\CangKu\\fangcun\\desktop\\node_modules\\electron\\dist\\electron.exe',
        commandExists: true, isDevPath: true,
      },
      summary: 'dsh-fangcun 0.3.0 已装进 bundles；自带接入 = 命名管道，现在通（方寸在跑）',
    })
  },
  mcpLinkHermes: (entryId) => {
    rec('mcpLinkHermes', [entryId])
    return ok({
      ok: true, changed: true,
      message: '已接入 Hermes：mcp_servers 下新增 fangcun（入口 ' + entryId + '）。备份在 config.yaml.bak-fangcun-x。Hermes 里执行 /reload-mcp 即生效。',
      backupPath: 'C:/mock/hermes/config.yaml.bak-fangcun-x',
    })
  },
  // 读取情况（卡 20261025-006 第三件）—— 真通道是 `usage:neverRead`（主进程读 mcp-usage.jsonl）。
  // 记账：`__fcTest.callCount('usageNeverRead')` 能验"打开筛选面板时真拉了一次"。
  usageNeverRead: (days) => {
    rec('usageNeverRead', [days])
    return ok(JSON.parse(JSON.stringify(computeNeverRead())))
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
  // 裁决（2026-10-30）：此前两个通道**根本没登记**，界面一点就抛。
  // ⚠ 桩只记账、**不改 store**：改 store 会污染后面“按状态列排序/批量还原”等断言
  //   （2026-10-30 实测：拖拽测试把 task-demo-001 移出待办，排序块只剩一张卡）。
  reviewAccept: (id, reason) => { rec('reviewAccept', [id, reason]); return ok() },
  reviewReject: (id, reason) => { rec('reviewReject', [id, reason]); return ok() },
  rejectTaskDirect: (id, reason) => { rec('rejectTaskDirect', [id, reason]); return ok() },
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
  // 2026-10-30 驳回返工台：这两个原先只回 ok()、**不记账**，于是“点了到底有没有走通道”
  // 根本断言不出来。补上 rec（与 moveStatus 同口径），断言才能分辨真动作与假动作。
  archiveTask: (id) => { rec('archiveTask', [id]); return ok() },
  unarchiveTask: (id) => { rec('unarchiveTask', [id]); return ok() },
  deleteTask: () => ok(),
  copyTask: () => ok(),
  // 2026-10-13：此前是 `() => ({})`（永远空表单）。“架构图”的条件显示与表单回填都靠它拿值 ——
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
  // 自然语言搜索（2026-10-23 补）：此前恒返回 `[]` —— 而 App 那边读的是 `result.tasks`，
  // 于是“回车搜 #标签 @项目”这条路**从来没被验过**（返回 [] → 结果永远是空列表）。
  naturalQuery: (q, opts) => {
    rec('naturalQuery', [q, opts])
    const hit = store.tasks.filter((t) => String(t.id) === 'task-demo-001')
    return { ok: true, tasks: JSON.parse(JSON.stringify(hit)), parsed: { raw: q } }
  },
  // 近 14 天趋势夹具（2026-11-03）：必须有可见数据，路线图上的折线/数字才验得到
  getRoadmapTrend: (days) => {
    rec('getRoadmapTrend', [days])
    const n = Math.max(1, Math.min(90, Number(days) || 14))
    const pts = []
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(2026, 10, 3 - i)
      pts.push({
        ts: d.getTime(), date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        name: '演示项目',
        active: 2 + (i % 3), completed: n - i, blocked: i % 2,
      })
    }
    return { demo: pts }
  },
  suggestCrossProject: () => { rec('suggestCrossProject'); return store.crossSuggest.slice() },
  detectParallelOpportunities: () => {
    rec('detectParallelOpportunities')
    return [
      { type: 'parallel', project: '', reason: '夹具：跨项目可并行（A 与 B 互不依赖）' },
      { type: 'batch', project: 'demo', reason: '夹具：本项目两个批次可并行' },
      { type: 'batch', project: 'other', reason: '别的项目的机会（不该出现在演示项目页）' },
    ]
  },
  suggestMilestones: () => { rec('suggestMilestones'); return store.milestones.slice() },
  // 监控台“建议动作 / 可并行机会”（2026-10-23 补）：此前恒返回 [] ——
  // 它们是 10-11 接回的**死通道**，但接回来之后没有任何断言碰过，
  // 于是"接了但没渲染 / 渲染了但字段名错"两种坏法都不会被发现。
  suggestActions: (projectId) => {
    rec('suggestActions', [projectId])
    return ['夹具建议：先把 P1 批次收口', '夹具建议：这条卡挡着两张待办']
  },
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
  /**
   * 诊断日志尾部（2026-10-23 补夹具）：主进程返回 `string[]`（main/services/appLog.ts:134），
   * 界面直接把数组 join('\n') 塞进 `.errpanel-body`。
   * ⚠ 此前桩恒返回空数组 → 抽屉里永远只有“（日志为空）”这一句，
   *   等于“日志抽屉显示的行到底是不是主进程给的”从来没被断言过。
   */
  applogTail: (n) => {
    rec('applogTail', [n])
    return [
      '[2026-10-23 20:58:11] ERROR 备份 远端连接超时（ECONNRESET）',
      '[2026-10-23 20:58:12] INFO  renderer 已上报错误到日志文件',
    ]
  },
  applogOpenDir: () => ok(),
  applogWrite: (level, scope, message, detail) => { rec('applogWrite', [level, scope, message, detail]); return ok() },

  // ── UI 偏好真身（userData/prefs.json，014 那一套）─────────────────
  // 2026-09-28 补：此前假 preload 里**根本没有 prefsGet/prefsSet** ——
  // syncBoardPrefs 的 `await window.tegula.prefsGet()` 直接抛、被 catch 吞掉，
  // 于是"偏好真的落盘了吗"在渲染层 e2e 里**永远验证不到**（只能靠源码断言猜）。
  // 现在给一个内存真身：多视图选择（fc_board_view / fc_todo_view）与分组方式
  // 都走这条路径，断言可以真读回 `__fcTest.prefs()`。
  //
  // ⚠ 2026-10-05 又踩了同一个坑（“勾一下闪退一下”= 勾选写不进盘）：渲染层把 **Vue 响应式代理**
  //   （`ref([]).value`、v-for 元素）直接当 IPC 载荷 → 真机 contextBridge 在“页面→隔离世界”
  //   这一跳就抛 `An object could not be cloned`（preload 与主进程都收不到，日志里一个字都没有）。
  //   假 preload 不做克隆校验 → 这个 bug **在渲染层 e2e 里测不出来**（真机必崩、测试全绿）。
  //   所以这里按真机语义补上：参数过不了结构化克隆，就当它是真机里的那种失败。
  prefsGet: () => JSON.parse(JSON.stringify(store.prefs)),
  prefsSet: (key, value) => { cloneGuard('prefsSet', [key, value]); rec('prefsSet', [key, value]); store.prefs[key] = value; return ok() },
  /** 项目梯度榜（2026-10-25）：项目页第 5 种摆法，真身是 task-data/project-tiers.json */
  projectTiersGet: () => {
    rec('projectTiersGet', [])
    return ok({ tiers: JSON.parse(JSON.stringify(store.projectTiers)), path: 'task-data/project-tiers.json' })
  },
  projectTiersSet: (tiers) => {
    cloneGuard('projectTiersSet', [tiers])
    rec('projectTiersSet', [tiers])
    store.projectTiers = Array.isArray(tiers) ? JSON.parse(JSON.stringify(tiers)) : []
    return ok({ tiers: JSON.parse(JSON.stringify(store.projectTiers)) })
  },
  // 层厚度（2026-11-16 · 骨架继承试点第一批）：项目页第 9 种摆法。
  // 假 preload 必须在场 —— 否则新通道在渲染层断言里永远验不到（AGENTS.md「会再犯的硬规则 1」）。
  // ⚠ 形状必须**照真身**：`layer:board` 真返回一个**数组**（profileAll 的 Promise），
  //   `layer:profile` 返回**裸对象**。这里若图省事套 `ok()`（Object.assign 进对象），
  //   数组就变成 {0:…,1:…} —— 界面上一个项目都不显示，而表头照样渲染，看着像"没数据"。
  layerProfile: (projectId, opts) => {
    rec('layerProfile', [projectId, opts])
    const hit = (store.layerBoard || []).find((p) => p && p.id === projectId)
    return hit ? JSON.parse(JSON.stringify(hit))
      : { ok: false, id: projectId, missing: '夹具里没有这个项目', rows: [] }
  },
  layerBoard: (opts) => {
    rec('layerBoard', [opts])
    return JSON.parse(JSON.stringify(store.layerBoard || []))
  },
  layerSpec: (projectId) => {
    rec('layerSpec', [projectId])
    return JSON.parse(JSON.stringify(store.layerSpec))
  },
  // ── 竞品（2026-11-17）────────────────────────────────────────────────
  // ⚠ 新通道**必须在这里同步登记**，否则「守卫存在」只是纸面事实
  //   （AGENTS.md 踩坑第 1 条：新通道不登记 → 渲染层断言测不到它）。
  competitorOverview: () => {
    rec('competitorOverview', [])
    return JSON.parse(JSON.stringify(store.competitorOverview || { ok: true, rows: [] }))
  },
  competitorReadReport: (projectId, fileName) => {
    rec('competitorReadReport', [projectId, fileName])
    return { ok: true, text: '# 夹具采集结果\n\n这是假 preload 里的样例，不是真采集。' }
  },
  competitorWriteTask: (projectId) => {
    rec('competitorWriteTask', [projectId])
    return { ok: true, path: 'task-data/competitors/' + projectId + '/采集任务单.md' }
  },
  // 2026-10-05 补：在途一屏的“保存”改走**一次写多键 + 回读校验**（prefs:setMany）。
  // 假 preload 缺这个 API 的话，渲染层的 `?.prefsSetMany?.(...)` 会静默变 undefined，
  // “保存到底写没写进去”在渲染层 e2e 里就**永远验证不到**（记忆里的老坑）。
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
  // 029：方针卡现在也带 structureMap（结构地图），所以走可注入的 store，测试能造“有地图 + 最后核实日期”。
  policyGet: (id) => {
    const p = store.policies ? store.policies[id] : undefined
    if (!p) return { ok: true, policy: null }
    // 2026-11-12：核心判词也要在这里给默认值 —— 不给的话弹窗拿到 undefined，
    // 点「未判（清空）」时 String(undefined ?? '') 恰好还是 ''，看起来"没坏"，
    // 但断言就分不清"是因为没传字段"还是"因为人清了"。默认值必须显式。
    return { ok: true, policy: Object.assign({ projectId: id, mission: '', goal: '', scenario: '', boundary: '', structureMap: '', coreVerdict: '', updatedAt: '' }, p) }
  },
  policySave: (p) => { rec('policySave', [p]); return ok({ path: 'C:/mock/policies/' + (p && p.projectId) + '.md' }) },
  policyText: () => '',
  // 使命草稿（2026-11-14 · P1-2）：从 README 取一句。
  // 默认给一条**看起来像真的**夹具（草稿 + 原文），断言据此验"填进去了且原文也展示了"。
  // 要换形态就 `__fcTest.setMissionDraft({ draft:'', reason:'…' })`。
  policyMissionDraft: (id) => {
    rec('policyMissionDraft', [id])
    const d = store.missionDraft || {
      project: id, draft: '演示项目的使命（来自 README 原文）',
      sourceText: '演示项目的使命（来自 README 原文）',
      sourceFile: 'README.md', from: 'excerpt', reason: '',
    }
    return ok({ draft: d })
  },
  // 结构漂移批量判定（2026-11-08）：默认“没有漂移”；用例用 __fcTest.setStructureDrift 注入
  policyDriftAll: async (items) => ok({
    rows: (items || []).map((it) => {
      const hit = (store.structureDrift || {})[it.project]
      return hit
        ? { project: it.project, status: 'ok', stale: !!hit.stale, reason: String(hit.reason || '') }
        : { project: it.project, status: 'ok', stale: false, reason: '' }
    }),
  }),
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
        // 2026-10-22 · 03 任务三：四栏台账第四栏（demo2 刻意留空 → 界面必须写“未写”）
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
        lines: ['这条读的是你手写的“说明”—— 方寸不替你裁，也不替你补。'],
        rows: [{ k: '演示项目', v: '欠着：①夹具欠账 ②第二件', sub: '你手写的' }],
        needsLlm: false, source: '项目登记表里你手写的“说明”',
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
  // 随纠（2026-10-22 · 03 任务二）：桩复刻主进程语义的最小版 —— 只认“改 <字段> 为 <值>”。
  // ⚠ 必须记账并真返回 before/field：断言要验"撤销真把旧值传回去了"。
  correctPreview: (text, pid) => {
    rec('correctPreview', [text, pid])
    const m = String(text || '').match(/(状态|路线图|说明)\s*(?:改成|改为|为|成)\s*(.+)$/)
    if (!m) return { ok: false, error: '没认出要改哪个字段' }
    return { ok: true, projectId: pid, field: m[1], to: m[2].trim(), echo: '“演示项目”的' + m[1] + '：旧 → ' + m[2].trim() }
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
      echo: '“' + (p ? p.name : pid) + '”的' + m[1] + '：' + (before || '（空）') + ' → ' + m[2].trim(),
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
  // 导出指定备份（2026-09-25 第 10 条）：给两份假备份，验证“默认最新”与传参
  backupListLocal: () => { rec('backupListLocal'); return ({
    ok: true,
    items: [
      { name: 'fangcun-data-20260920-101010.zip', path: 'C:/mock/backups/fangcun-data-20260920-101010.zip', bytes: 111111, mtime: '2026-09-20T10:10:10.000Z', sha256: null },
      { name: 'fangcun-data-20260925-202020.zip', path: 'C:/mock/backups/fangcun-data-20260925-202020.zip', bytes: 222222, mtime: '2026-09-25T20:20:20.000Z', sha256: null },
    ],
  }) },
  /**
   * 远端备份列表（2026-10-23 补夹具）：形状与 `backupListLocal` 一样是 `{ ok, items }`
   * （main/backup-ipc.ts:108）。⚠ 此前桩返回裸 `[]` → `rr.ok ? rr.items : []` 恒走 else，
   * “远端 (N)”那个计数永远 0、远端备份行从来不渲染 ——
   * 于是“远端恢复传的是 name 还是 path”这条最容易错的分支从没被点过。
   */
  backupListRemote: () => {
    rec('backupListRemote')
    return ({
      ok: true,
      items: [
        { name: 'fangcun-data-20261021-030000.zip', path: 'dav:/fc/fangcun-data-20261021-030000.zip', bytes: 333333, mtime: '2026-10-21T03:00:00.000Z', sha256: null },
      ],
    })
  },
  /**
   * 备份：**返回真实形状** `{ok, result}`（2026-11-12 修）。
   *
   * ⚠ 原来这里是 `() => ok()` —— 返回 `{}`，于是 `r.result` 是 undefined，
   *   而 `App.vue#triggerBackup` 恰好要读 `r.result.localPath`。
   *   更糟的是真实 bug 在**另一个地方**：`useBackup` 忘了导出 `backupInfo`，
   *   渲染层解构出 undefined，`backupInfo.value = …` 抛「Cannot set properties of undefined」。
   *   桩返回空对象 + 那个 ref 是 undefined —— 两条叠在一起，界面「点了备份没反应 / 报失败」，
   *   而**备份本身是成功的**（zip 21.7MB 已落盘）。
   *   现在给足真实字段，`triggerBackup` 的成功分支在无头里也能真跑通。
   */
  backupRun: () => {
    rec('backupRun')
    return ok({
      ok: true,
      result: {
        ok: true, trigger: 'manual', files: 128, localPath: 'C:/mock/backups/fangcun-data-demo.zip',
        localBytes: 21 * 1024 * 1024, remotePath: null, warnings: [], errors: [],
      },
    })
  },
  backupRunLocalOnly: () => {
    rec('backupRunLocalOnly')
    return ok({
      ok: true,
      result: {
        ok: true, trigger: 'manual', files: 128, localPath: 'C:/mock/backups/fangcun-data-demo.zip',
        localBytes: 21 * 1024 * 1024, remotePath: null, warnings: [], errors: [],
      },
    })
  },
  backupSaveConfig: () => ok(),
  /**
   * ⚠ 同样要给真实形状 `{ok, config}`：`bkSaveConfig()` 里读 `r.config.remote.hasPassword`
   *   （没有可选链），空对象会抛 → `bkSaveAndRun` 在调 `backupRun` **之前**就死了。
   *   这就是“点立即备份一点反应都没有”的直接原因（详见上面 backupGetConfig 那段）。
   */
  backupSetConfig: () => {
    rec('backupSetConfig')
    return {
      ok: true,
      config: {
        enabled: true, intervalHours: 6, firstDelayMinutes: 5,
        localKeep: 5, remoteKeep: 10, localDir: '',
        remote: { url: '', username: '', password: '', hasPassword: false, allowSelfSigned: false },
        slim: { excludeLogAttachments: false, maxFileMB: 10 },
        encrypt: { enabled: false, remember: false, password: '', hasPassword: false },
        secretStorageAvailable: true,
      },
    }
  },
  backupTestRemote: () => ok(),
  /**
   * 恢复备份（2026-10-23 补记账 + 真形状）。
   * ⚠ 必须 `rec` 出 source：远端恢复要求传 `{ kind: 'remote', name }`、本地恢复传
   *   `{ kind: 'local', path }` —— 传错主进程会去本地找这个"路径"，
   *   用户看到的是"远端备份恢复不了"。不记账就只能断言"按钮存在"，抓不到这条。
   */
  backupRestore: (source) => { rec('backupRestore', [source]); return ok({ restoredFiles: 5, snapshotDir: 'C:/mock/snap-20261023' }) },
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
        // 金额三态各来一条（2026-10-25 卡 005）：十月有金额且 1 笔未折算；九月纯未折算
        { month: '2026-10', calls: 3, ok: 2, fail: 1, token_calls: 2, prompt_tokens: 90, completion_tokens: 40, total_tokens: 1300, cost: '0.42000000', cost_calls: 2, provider_cost_calls: 1, unpriced_calls: 1, external_calls: 1, byTrigger: [{ trigger: 'desktop.ask', calls: 2, total_tokens: 300 }] },
        { month: '2026-09', calls: 1, ok: 1, fail: 0, token_calls: 1, prompt_tokens: 10, completion_tokens: 5, total_tokens: 500, cost: '0.00000000', cost_calls: 0, provider_cost_calls: 0, unpriced_calls: 1, external_calls: 0, byTrigger: [{ trigger: 'desktop.draftProjectBrief', calls: 1, total_tokens: 500 }] },
      ],
    }
  },
  /**
   * 账户口径（2026-10-25 卡 005）：余额差值。
   * ⚠ 夹具给的数字是**定死的**（3.60 / 100.00 充值 / 3 次观测），断言按它核对界面；
   *   `balanceUnsupported` 切到"没有余额接口"的真实常见态，验降级文案不编数字。
   */
  llmBalanceStatus: () => {
    rec('llmBalanceStatus', [])
    if (store.balanceUnsupported) {
      return {
        supported: false, reason: '这个端点没有官方余额接口 —— 账户口径不可用，只能看 token（或自己填单价）',
        provider: 'unknown', currency: '', spent: '0.00', recharged: '0.00', lastBalance: '',
        observations: 0, updatedAt: '', note: '',
      }
    }
    return {
      supported: true, reason: '', provider: 'deepseek', currency: 'CNY',
      spent: '3.60', recharged: '100.00', lastBalance: '196.40',
      observations: 3, updatedAt: '2026-10-25T10:00:00.000Z', note: '',
    }
  },
  llmBalanceObserve: () => {
    rec('llmBalanceObserve', [])
    return {
      ok: true, message: '本次观测到消费 1.20 CNY（余额 195.20）',
      status: {
        supported: true, reason: '', provider: 'deepseek', currency: 'CNY',
        spent: '4.80', recharged: '100.00', lastBalance: '195.20',
        observations: 4, updatedAt: '2026-10-25T10:05:00.000Z', note: '',
      },
    }
  },
  /**
   * 模型单价（2026-10-25 卡 005 B 档）：夹具预置一行，用来验"设置里能改、改完真的过桥"。
   * ⚠ 空表也是合法状态（= 一律未折算），这条降级在断言里单独验。
   */
  // ── 项目结构图桩（2026-10-29 修正版）：真身是"找到该项目仓库里的 archify 产物并打开"。
  // 桩按**找不到**的情况回话 —— 那正是界面最需要说清楚的路径（不许静默、不许自己画一张）。
  projectDiagram: (projectId) => {
    cloneGuard('projectDiagram', [projectId])
    rec('projectDiagram', [projectId])
    if (!projectId) return { ok: false, error: '没给项目 id' }
    return {
      ok: false,
      error: '演示项目 还没有 archify 结构图 —— 先用 archify 生成一份 HTML，落到该仓库 docs/ 下（文件名带“架构图”或 architecture），再点这里；方寸自绘是旁边那个按钮。',
    }
  },
  // ── 方寸自绘架构图桩（2026-10-30，卡 task-20261030-002）──────────────
  // 图模型照真身字段造：节点=目录、边=import/ipc/bridge、证据与缺项都有内容 ——
  // 断言要验的是“界面有没有把证据和缺项**摆出来**”，不是"能不能跑通"。
  archGet: (projectId, opts) => {
    cloneGuard('archGet', [projectId, opts])
    rec('archGet', [projectId, opts])
    store.archProjectId = projectId   // 进度事件要带同一个 id，否则 App 的回调会把它过滤掉
    if (!projectId) return { ok: false, error: '没给项目 id' }
    const RESULT = {
      ok: true,
      repo: 'C:/mock/demo',
      project: { id: projectId, name: '演示项目', repo: 'C:/mock/demo' },
      graph: {
        title: '演示项目 · 架构图',
        subtitle: '证据来自 package.json 与源码里的真实 import / IPC 计数 · C:/mock/demo',
        text: '6 个组件 · 3 条连线 · 扫描 11 个文件',
        scannedFiles: 11,
        truncated: false,
        nodes: [
          { id: 'src/renderer', label: '渲染层（界面）', kind: 'layer', files: 2, samples: ['src/renderer/App.vue'], note: 'src/renderer · .vue' },
          { id: 'src/preload', label: '预加载 / 桥', kind: 'layer', files: 1, samples: ['src/preload/index.ts'], note: 'src/preload · .ts' },
          { id: 'src/main', label: '主进程', kind: 'layer', files: 3, samples: ['src/main/index.ts', 'src/main/ipc.ts'], note: 'src/main · .ts' },
          { id: 'src/shared', label: '共享逻辑', kind: 'shared', files: 4, samples: ['src/shared/util.ts'], note: 'src/shared · .ts' },
          { id: '__entry__', label: '入口', kind: 'entry', files: 1, samples: ['src/main/index.ts'], note: 'package.json main: src/main/index.ts' },
          { id: '__deps__', label: '外部依赖', kind: 'external', files: 7, samples: ['vue', 'electron'], note: '来自 package.json（未扫 node_modules）' },
        ],
        edges: [
          { from: 'src/renderer', to: 'src/shared', kind: 'import', label: 'import ×2', count: 2, samples: ['src/renderer/App.vue → ../shared/util'] },
          { from: 'src/preload', to: 'src/main', kind: 'ipc', label: 'IPC：3 个 handle / 1 个 invoke', count: 4, samples: ['src/preload/index.ts:2 · ipcRenderer.invoke(...)'] },
          { from: 'src/renderer', to: 'src/preload', kind: 'bridge', label: '桥调用 ×12', count: 12, samples: ['src/renderer/App.vue:3 · window.tegula.get(...)'] },
        ],
        missing: [{ what: '端口清单', why: '源码里没有读到 listen(...) —— 端口不是猜出来的，没读到就不列' }],
        evidence: ['package.json：demo 1.0.0 · main=src/main/index.ts', '只读扫描：11 个文件'],
      },
    }
    store.archGraph = RESULT.graph
    return RESULT
  },
  // AI 生成图（2026-11-02）：点一下才调模型。默认走"过审"；store.archScanOnly=true 换成降级分支。
  archGenerate: (projectId) => {
    cloneGuard('archGenerate', [projectId])
    rec('archGenerate', [projectId])
    const build = () => {
      if (!projectId) return { ok: false, error: '没给项目 id' }
      const g = store.archGraph || { title: '演示项目 · 架构图', subtitle: '', text: '', nodes: [], edges: [], missing: [], evidence: [], scannedFiles: 0, truncated: false }
      if (store.archScanOnly) {
        return {
          ok: true, source: 'scan', attempts: 0, issues: [], notes: [],
          reason: '没配模型（缺 端点地址 / 密钥）—— 先出扫描图，配好模型再重画',
          graph: { ...g, subtitle: '没配模型（缺 端点地址 / 密钥）', text: '这是 **扫描图**，不是生成图 · ' + g.text },
        }
      }
      return {
        ok: true, source: 'ai', attempts: 1, issues: [], notes: [], usage: { totalTokens: 456 }, model: 'mock-model',
        graph: { ...g, subtitle: 'AI 生成 · 逐条证据审计', text: '这是 **AI 生成图**（每个节点/连线都过了证据审计） · ' + g.text },
      }
    }
    // 2026-11-05：`__fcTest.holdArch(true)` 时挂 1.4 秒 —— 真机上一次生成要十几秒，
    // 假桩同步返回的话"生成中横幅 / 关闭确认"这两块**一帧都量不到**。
    if (store.archHold) return new Promise((res) => setTimeout(() => res(build()), 1400))
    return build()
  },
  // ── 2026-11-07（修 11-03 驳回）：进度 / 取消 / 上次结果 ──────────────
  // ⚠ 假 preload 必须与真 preload 同步。这三个是 preload/index.ts 新增的，
  //   漏一个 → App.vue 的 generateSelfArch 在**调 archGenerate 之前**就 TypeError，
  //   整块架构图断言连锁红（11-07 实测：16 条，全崩在"测试自身"而不是被测代码）。
  archCancel: (projectId) => {
    cloneGuard('archCancel', [projectId])
    rec('archCancel', [projectId])
    return { ok: true }
  },
  archLastRun: (projectId) => {
    rec('archLastRun', [projectId])
    return store.archLast ? { ok: true, ...store.archLast } : { ok: true, none: true }
  },
  /** 返回取消订阅函数；挂住的 cb 由 __fcTest.emitArchProgress 触发 */
  onArchProgress: (cb) => {
    rec('onArchProgress', [])
    store.archProgressCb = cb
    return () => { if (store.archProgressCb === cb) store.archProgressCb = null }
  },
  archExport: (projectId, opts) => {
    cloneGuard('archExport', [projectId, opts])
    rec('archExport', [projectId, opts])
    return { ok: true, path: 'C:/mock/demo/docs/方寸架构图-演示项目.html' }
  },
  // ── 整理体检桩（2026-10-30，卡 20261025-006）：两批清理候选一起回 ──
  cleanupScan: (days) => {
    rec('cleanupScan', [days])
    return {
      ok: true,
      days: 30,
      text: '没人碰过 2 张 · 驳回后没人管 1 张 · 挂着进行中没动 2 张',
      rule: '口径：没人碰过只算 agent 经 MCP 读卡（你在界面里点开不算）；“挂着进行中”只说明这个任务文件没被写过，'
        + '不代表有人在干、也不代表没人干 —— 它只是提醒你核一下：活干完了就关单，不干了就退回待办。'
        + '这三栏都是清理候选，不是优先级，也不代表"不重要"。',
      // 第三栏（2026-11-05 从通知中心挪进来）：夹具给 2 张，卡最久的排前面
      stalled: {
        count: 2,
        thresholdHours: 24,
        text: '挂着“进行中”超过 24 小时没动',
        rows: [
          { id: 'st-1', title: '挂了一周的进行中', hours: 168 },
          { id: 'st-2', title: '挂了两天的进行中', hours: 50 },
        ],
      },
      neverRead: {
        rows: [
          { id: 'nr-1', title: '没人读过的甲', project: 'demo', status: '待办', priority: '高', updated: '2026-09-01T00:00:00.000Z', reads: 0 },
          { id: 'nr-2', title: '没人读过的乙', project: 'demo', status: '待办', priority: '中', updated: '2026-09-02T00:00:00.000Z', reads: 0 },
        ],
        count: 2, openTotal: 5, windowEvents: 7, days: 30,
      },
      rework: {
        count: 1,
        oldestDays: 12,
        text: '1 张卡被驳回后没人再管（最早 12 天前）',
        rows: [{ id: 'rw-1', title: '被驳回的甲', reason: '按钮点不动', hasReason: true, ageDays: 12, updatedMs: 0 }],
      },
    }
  },
  // ── 需求矩阵（RICE）桩（2026-10-29）：页签此前在无头断言里完全没被打开过 ──
  // 夹具刻意做成“两条已拍板 + 一条没写理由 + 一条未拍板”，好让四种界面判断都能被验到。
  riceGet: () => {
    rec('riceGet', [])
    return {
      ok: true,
      path: 'E:/demo/task-data/rice-pool.md',
      pool: {
        budget: 100,
        items: [
          { eid: 'rice-task-k1', title: '要做的功能', origin: 'task:task-demo-001', R: 10, I: 3, C: 0.95, E_days: 3, E_cost: 85, evidence: '亲口要', by: 'hermes 2026-10-29', note: '每周省三次手工', verdict: '有效', decisionId: 'D-001', project: 'demo' },
          { eid: 'rice-task-k2', title: '没写理由就做了', origin: 'task:task-demo-002', R: 8, I: 2, C: 0.85, E_days: 2, E_cost: 10, evidence: '实测踩过', by: 'hermes 2026-10-29', note: '', verdict: '有效', decisionId: 'D-002', project: 'ghost-proj' },
          { eid: 'rice-ext-c1', title: '听起来很酷的东西', origin: 'external:c1', R: 2, I: 0.5, C: 0.6, E_days: 8, E_cost: 30, evidence: '纯直觉', by: 'hermes 2026-10-29', note: '听起来很酷，但没人要', verdict: 'CUT', decisionId: 'D-003', project: '' },
          { eid: 'rice-task-p1', title: '还没决定的', origin: 'task:task-demo-003', R: 5, I: 1, C: 0.7, E_days: 4, E_cost: 5, evidence: 'agent 共识', by: 'hermes 2026-10-29', note: '', verdict: '', decisionId: '', project: '' },
        ],
      },
    }
  },
  riceSetBudget: (n) => { rec('riceSetBudget', [n]); return { ok: true, pool: { budget: n, items: [] } } },
  riceUpsert: (items) => { cloneGuard('riceUpsert', [items]); rec('riceUpsert', [items]); return { ok: true, added: (items || []).length, updated: 0, rejected: [], warnings: [] } },
  riceDecide: (payload) => { cloneGuard('riceDecide', [payload]); rec('riceDecide', [payload]); return { ok: true } },
  llmGetPrices: () => {
    rec('llmGetPrices', [])
    return { ok: true, rows: store.prices.slice(), updatedAt: '2026-10-25T10:00:00.000Z' }
  },
  llmSetPrices: (rows) => {
    cloneGuard('llmSetPrices', [rows])
    rec('llmSetPrices', [rows])
    // 与真主进程同样的清洗口径：空模型名的行丢掉；价格原样收（夹具不做数值校验）
    const clean = (Array.isArray(rows) ? rows : [])
      .filter((r) => String((r && r.model) || '').trim())
      .map((r) => ({ model: String(r.model).trim(), in: String(r.in || '0'), out: String(r.out || '0') }))
    store.prices = clean
    return { ok: true, rows: clean.slice() }
  },
  llmGetConfig: () => ({}),
  llmSetConfig: () => ok(),
  llmResetConfig: () => ok(),
  llmTestConnection: () => ok(),
  // AI 规划写回层（2026-10-12）：e2e 不真调 LLM，桩返回成功+假 usage（“花销可见”链路可断言）
  llmPlanToDraft: () => ({ ok: true, created: [{ id: 'task-e2e-draft-1', title: 'e2e 假草稿' }], usage: { promptTokens: 120, completionTokens: 80, totalTokens: 200 } }),
  llmDraftProjectBrief: () => ({ ok: true, taskId: 'task-e2e-brief-1', usage: { promptTokens: 100, completionTokens: 60, totalTokens: 160 } }),
  // 决策卡（2026-10-12）：本地 CRUD 桩，假数据供视图用例断言
  // ⚠ 2026-10-14：三条各自带上“项目”（含一条刻意留空）—— 项目筛选与项目字段的断言靠它
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
        return Promise.resolve({ ok: false, error: `导入被拦下，一个文件都没写：第 ${i + 1} 条的字段名“${badKey}”不认识（可用：${known.slice(0, 6).join(' / ')}）` })
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
  // 2026-10-12：“今天”那一格到底压了几条 —— 从**夹具真身**数出来，别在断言里写死。
  // 起因：待办也上日历之后，"今天"从 4 条变 5 条，写死 `+2 条` 的旧断言当场假红。
  // ⚠ 口径必须与 App.vue 造日历事件完全一致 —— 第一版漏了“完成的待办不上日历”
  //   （多选夹具里那条 done:true 的 `td-3` 被多算成一条 → 期望 +4、实际 +3，还是假红）。
  fixTodayCount: () => {
    const dl = (store.tasks || []).filter(t => (t.deadline || (t.fm && t.fm.deadline)) === FIX_DEADLINE).length
    // 待办的日历判据（App.vue）：① 未完成；② 有 due 且等于今天 ——“没 due”不算今天
    // （裸 { created: 1 } 这种夹具不带 due，若按"没 due 就今天"数会凭空多出几条）。
    const td = (store.todos || []).filter(t => !t.done && t.due === FIX_DEADLINE).length
    return dl + td
  },
  // 格子内最多铺几条 —— 由 e2e-runner 注入 App.vue 的同名常量（见 renderer-web-assert.js 顶部）。
  calCellCap: () => (typeof globalThis.__fcCalCellCap === 'number' ? globalThis.__fcCalCellCap : 2),
  calls: () => JSON.parse(JSON.stringify(store.calls)),
  callCount: (name) => store.calls.filter(c => c.name === name).length,
  // 作战计划夹具复位（2026-11-03）：裁决会改 PLAN_DOCS，后面的每日推进面断言要靠它
  // 恢复“P0 已冻结 / P1 待裁决”的原始形态，否则“另有 N 张待裁决”会被前面的点击吃掉。
  // 技能自动同步留痕（2026-11-05）：断言换形态用它 —— 默认"刚跑过、版本一致"，
  // 要验“升级后没同步”就 setSkillSync({ stale: true, staleReason: '...' })。
  /** 让 archGenerate 挂住 1.4 秒（验“生成中横幅 + 关闭确认”用） */
  holdArch: (v) => { store.archHold = v !== false; return store.archHold },
  /** 注入"上次生成结果"，验关窗后回来还能查到上次怎么了 */
  setArchLast: (r) => { store.archLast = r || null; return store.archLast },
  /** 推一条进度事件（真机由主进程 event.sender.send 推） */
  emitArchProgress: (p) => {
    rec('emitArchProgress', [p])
    const payload = Object.assign({ projectId: store.archProjectId || 'demo' }, p || {})
    if (typeof store.archProgressCb === 'function') store.archProgressCb(payload)
    return !!store.archProgressCb
  },
  setSkillSync: (patch) => {
    store.skillSync = Object.assign({}, store.skillSync, patch || {})
    rec('setSkillSync')
    return JSON.parse(JSON.stringify(store.skillSync))
  },
  resetPlanDocs: () => {
    const p0 = PLAN_DOCS[0].stages.find(s => s.id === 'P0')
    if (p0) { p0.status = '已冻结'; p0.verdict = '通过 · 2026-10-29'; p0.rejectReason = '' }
    const p1 = PLAN_DOCS[0].stages.find(s => s.id === 'P1')
    if (p1) { p1.status = '待裁决'; p1.verdict = ''; p1.rejectReason = '' }
  },
  todos: () => JSON.parse(JSON.stringify(store.todos)),
  // 想法（2026-10-22）：断言要能读到真身 —— 特别是"点“做”之后待办里是不是真多了一条"
  ideas: () => JSON.parse(JSON.stringify(store.ideas)),
  setIdeas: (items) => { store.ideas = (items || []).slice() },
  logs: () => JSON.parse(JSON.stringify(store.logs)),
  trash: () => JSON.parse(JSON.stringify(store.trash)),
  tasks: () => JSON.parse(JSON.stringify(store.tasks)),
  // ── 同步阶段流（2026-10-25 卡 004）─────────────────────────────────────
  /** 让下一次 backupGitPush 悬着不返回（于是能停在"进行中"那一帧做断言） */
  holdSync: () => { store.syncHold = true },
  /** 主进程"报一个阶段" —— 真通道是 git 跑到哪报到哪，这里手动喂 */
  /** 主进程"推送一条通知点击" —— 真通道由系统通知 click 触发，这里手动喂 */
  emitNotifyFocus: (type, sourceId) => {
    const subs = (store.notifySubs || []).slice()
    subs.forEach((cb) => { try { cb({ type, sourceId }) } catch { /* 组件已卸 */ } })
    return subs.length
  },
  emitSyncProgress: (phase) => {
    const at = Date.now()
    store.syncSubs.slice().forEach((cb) => { try { cb({ phase, at }) } catch { /* 组件已卸 */ } })
    return store.syncSubs.length
  },
  /** 结束那次 push（ok=true → ✓ 已同步；false → ⚠ 未同步） */
  releaseSync: (ok, message) => {
    store.syncHold = false
    const f = store.syncResolve
    store.syncResolve = null
    if (f) f(ok ? { ok: true, message: message || '已同步 12 个文件' } : { ok: false, message: message || '连不上远端' })
    return true
  },
  /** 把单价夹具改回初始那行（断言收尾用，别污染后面的用例） */
  restorePrices: () => { store.prices = [{ model: 'deepseek-chat', in: '2.00000000', out: '8.00000000' }] },
  /** 单价表真身（改完断言读它，不读界面） */
  prices: () => JSON.parse(JSON.stringify(store.prices)),
  // ── 读取情况（卡 20261025-006 第三件）────────────────────────────────
  /** 读卡夹具真身（动态算出来的那份，不是写死的常量） */
  neverRead: () => JSON.parse(JSON.stringify(computeNeverRead())),
  /**
   * 冻结一份读卡夹具。两种必须能造的形态：
   *  ① `windowEvents: 0` —— 计量还没开始。此时界面**不许**说“N 张没人碰过”
   *     （那会冤枉所有卡），必须换成"还没有任何 agent 读卡记录"；
   *  ② `rows: []` —— 有记录但全都有人读过，筛出来是空板。
   */
  setNeverRead: (patch) => {
    store.neverRead = Object.assign({ ok: true }, computeNeverRead(), patch || {})
    return JSON.parse(JSON.stringify(store.neverRead))
  },
  /** 恢复动态模式（收尾用，别污染后面的用例） */
  restoreNeverRead: () => { store.neverRead = null; return true },
  /** 账户口径降级夹具：切到"这个端点没有余额接口"（多数中转/MiMo 的真实情况） */
  setBalanceUnsupported: (v) => { store.balanceUnsupported = !!v },
  /** AI 架构图降级夹具（2026-11-02）：true = 没配模型 → 后端返回 source=scan */
  setArchScanOnly: (v) => { store.archScanOnly = !!v },
  /** 还挂着几个阶段订阅 —— 收尾不干净时会越挂越多（每次同步 +1） */
  syncSubs: () => store.syncSubs.length,
  /** 项目列表（2026-10-25 优先级视图断言要用它算期望行数，不写死条数） */
  projects: () => JSON.parse(JSON.stringify(store.projects)),
  /** 梯度榜真身（拖完落盘后断言读它，而不是读界面） */
  projectTiers: () => JSON.parse(JSON.stringify(store.projectTiers)),
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
  /** 自仓同步状态（W1-1C）：传 null 恢复默认“已是最新” */
  setSelfSync: (obj) => { store.selfSync = obj || null },
  /** 项目路线文档（W1-批次 2）：传 null 恢复默认夹具；传 ok:false 造“读不到”形态 */
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
  /** 造“结构大改”判定结果：{ demo: { stale: true, reason: '…' } } */
  setStructureDrift: (m) => { store.structureDrift = m || {} },
  /** 造方针卡（含结构地图）：{ demo: { structureMap: '> 最后核实：2026-01-01…' } } */
  setPolicies: (m) => { store.policies = m || {} },
  // 使命草稿夹具（2026-11-14 · P1-2）：传 { draft:'', reason:'…' } 可验"抽不出来时如实说"
  setMissionDraft: (d) => { store.missionDraft = d || null },
  /**
   * 注入在途一屏的返回（含 rows / hidden / modeFallback）。
   * 2026-10-05 用：造“手动指定 + 一个都没勾 → 一屏全空”这个用户实测场景，
   * 验证空屏里有出口（“改回自动”）而不是死局。
   */
  setTripBoard: (obj) => { store.tripBoard = obj || null },
  /** 卡 012：注入“超期的已完成任务”条数（0 = 无 → 提示条不渲染） */
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
