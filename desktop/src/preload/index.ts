import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('tegula', {
  selfCheck: () => ipcRenderer.invoke('selfCheck'),
  getDataDir: () => ipcRenderer.invoke('getDataDir'),
  
  // Tasks
  loadTasks: (view = 'active') => ipcRenderer.invoke('loadTasks', view),
  newTask: (fields: any) => ipcRenderer.invoke('newTask', fields),
  editTask: (id: string, fields: any) => ipcRenderer.invoke('editTask', id, fields),
  moveStatus: (id: string, status: string) => ipcRenderer.invoke('moveStatus', id, status),
  deleteTask: (id: string) => ipcRenderer.invoke('deleteTask', id),
  archiveTask: (id: string) => ipcRenderer.invoke('archiveTask', id),
  unarchiveTask: (id: string) => ipcRenderer.invoke('unarchiveTask', id),
  /** 已完成任务自动归档（2026-10-03 卡 012）：列出超期 + 一键归档 */
  tasksOverdue: (days: number) => ipcRenderer.invoke('tasks:overdue', days),
  tasksArchiveOverdue: (days: number) => ipcRenderer.invoke('tasks:archiveOverdue', days),
  /** 回收站（2026-09-26 卡 034）：一律按文件名操作 */
  trashList: () => ipcRenderer.invoke('trash:list'),
  trashRestore: (name: string) => ipcRenderer.invoke('trash:restore', name),
  trashPurge: (name: string) => ipcRenderer.invoke('trash:purge', name),
  getTask: (id: string) => ipcRenderer.invoke('getTask', id),
  
  // Projects
  loadProjects: () => ipcRenderer.invoke('loadProjects'),
  parseErrors: () => ipcRenderer.invoke('parseErrors'),
  scanProjectStatus: () => ipcRenderer.invoke('scanProjectStatus'),
  findBlockers: () => ipcRenderer.invoke('findBlockers'),
  batchEdit: (ids: string[], fields: any) => ipcRenderer.invoke('batchEdit', ids, fields),
  batchArchive: (ids: string[]) => ipcRenderer.invoke('batchArchive', ids),
  batchDelete: (ids: string[]) => ipcRenderer.invoke('batchDelete', ids),
  quickAdd: (text: string) => ipcRenderer.invoke('quickAdd', text),
  naturalQuery: (q: string, opts?: any) => ipcRenderer.invoke('naturalQuery', q, opts),
  // 表单字段清单（唯一来源在主进程 data/index.ts）
  taskFieldSpecs: () => ipcRenderer.invoke('taskFieldSpecs'),
  taskEnums: () => ipcRenderer.invoke('taskEnums'),
  taskFormValues: (id: string | null) => ipcRenderer.invoke('taskFormValues', id),
  getProjectProgress: (projectId: string) => ipcRenderer.invoke('getProjectProgress', projectId),
  allProjectProgress: () => ipcRenderer.invoke('allProjectProgress'),

  // Plan
  createPlan: (fields: any) => ipcRenderer.invoke('createPlan', fields),
  listPlans: () => ipcRenderer.invoke('listPlans'),
  getPlan: (id: string) => ipcRenderer.invoke('getPlan', id),
  decidePlanPoint: (id: string, dpId: string, choice: string) => ipcRenderer.invoke('decidePlanPoint', id, dpId, choice),
  findTimeoutTasks: (threshold?: number) => ipcRenderer.invoke('findTimeoutTasks', threshold),
  
  // Registry
  registryAddProject: (fields: any) => ipcRenderer.invoke('registry:addProject', fields),
  registryRemoveProject: (id: string) => ipcRenderer.invoke('registry:removeProject', id),

  // ── 备份 v2（WebDAV + 调度 + 可验证恢复）
  backupGetConfig: () => ipcRenderer.invoke('backup:getConfig'),
  backupSetConfig: (patch: any) => ipcRenderer.invoke('backup:setConfig', patch),
  backupStatus: () => ipcRenderer.invoke('backup:status'),
  backupRun: () => ipcRenderer.invoke('backup:run'),
  backupRunLocalOnly: () => ipcRenderer.invoke('backup:runLocalOnly'),
  backupListLocal: () => ipcRenderer.invoke('backup:listLocal'),
  backupListRemote: () => ipcRenderer.invoke('backup:listRemote'),
  backupTestRemote: (input: any) => ipcRenderer.invoke('backup:testRemote', input),
  backupRestore: (source: any) => ipcRenderer.invoke('backup:restore', source),
  backupLog: (lines?: number) => ipcRenderer.invoke('backup:log', lines),
  backupOpenDir: () => ipcRenderer.invoke('backup:openDir'),
  backupExportTo: (input: any) => ipcRenderer.invoke('backup:exportTo', input),
  backupVerifyPackage: (zipPath?: string) => ipcRenderer.invoke('backup:verifyPackage', zipPath),
  backupPickRestoreFile: () => ipcRenderer.invoke('backup:pickRestoreFile'),
  backupPickDir: () => ipcRenderer.invoke('backup:pickDir'),
  onBackupStatus: (cb: (status: any) => void) => {
    const listener = (_e: any, status: any) => cb(status)
    ipcRenderer.on('backup:status', listener)
    return () => ipcRenderer.removeListener('backup:status', listener)
  },

  isFirstRun: () => ipcRenderer.invoke('isFirstRun'),
  createFreshSetup: (targetDir: string) => ipcRenderer.invoke('createFreshSetup', targetDir),
  importFromPythonTegula: (targetDir: string, pythonDir: string) => ipcRenderer.invoke('importFromPythonTegula', targetDir, pythonDir),
  browseDirectory: () => ipcRenderer.invoke('browseDirectory'),
  browseFile: () => ipcRenderer.invoke('browseFile'),
  
  // Activity
  loadActivity: (limit = 50) => ipcRenderer.invoke('loadActivity', limit),
  
  // Notes ── 2026-10-06 整块删除（暮雨批：笔记功能可以删）
  // 10 条通道（notesForTask / createNote / updateNote / listNotes / deleteNote /
  // attachNote / detachNote / exportNotes / importNotes / importNoteFromFile）都是
  // 「渲染层零调用」—— 界面里从来没有过笔记入口。`notes/` 数据文件没动。

  // ── Tasks Import/Export（设置页「导出/导入任务 JSON」按钮）────────────
  // 此前渲染层在调 window.tegula.exportTasks/importTasks，主进程也注册了同名
  // handler（ipc.ts），唯独 preload 这层没有暴露 → 点击必 TypeError（僵尸按钮第 4、5 例）。
  exportTasks: () => ipcRenderer.invoke('exportTasks'),
  importTasks: (data: any[]) => ipcRenderer.invoke('importTasks', data),

  // Logs
  logsList: (filter?: any) => ipcRenderer.invoke('logs:list', filter),
  logsForTask: (taskId: string) => ipcRenderer.invoke('logs:forTask', taskId),
  logsGet: (id: string) => ipcRenderer.invoke('logs:get', id),
  logsCreate: (title: string, project: string, content: string, taskId?: string, extra?: { sessionId?: string; agentName?: string; prevAgentName?: string; logDate?: string; taskIds?: string[]; nextSteps?: string; continueFrom?: string }) => ipcRenderer.invoke('logs:create', title, project, content, taskId, extra),
  logsUpdate: (id: string, updates: any) => ipcRenderer.invoke('logs:update', id, updates),
  logsComplete: (id: string, retainDays: number | null, note?: string) => ipcRenderer.invoke('logs:complete', id, retainDays, note),
  logsArchive: (id: string, note?: string) => ipcRenderer.invoke('logs:archive', id, note),
  /** 撤销完成 / 撤销归档，退回「待处理」（2026-09-28：不再等于「进行中」） */
  logsReopen: (id: string) => ipcRenderer.invoke('logs:reopen', id),
  /** 手动开 / 关「进行中」（2026-09-28 用户第 2 条）。可撤销，且不是完成/归档的前置条件。 */
  logsSetRunning: (id: string, running: boolean) => ipcRenderer.invoke('logs:setRunning', id, running),
  logsDestroy: (id: string) => ipcRenderer.invoke('logs:destroy', id),
  // logs:search 已删（2026-10-01）：搜索改由 logs:list 的 filter.query 承担，
  // 与项目/Agent/日期筛选同一条取数路径（此前两条路互不相干，一刷新搜索就丢）。
  // 需要"全文搜"的调用方（MCP search_logs）直接用 services/logs.ts 的 searchLogs()。
  logsInject: (id: string) => ipcRenderer.invoke('logs:inject', id),
  /** 附件（2026-10-01 卡 036）：主进程弹系统选文件框 → 复制进数据目录 → 返回更新后的日志 */
  logsAttachFiles: (logId: string) => ipcRenderer.invoke('logs:attachFiles', logId),
  /** 解除关联（文件不删） */
  logsDetachAttachment: (logId: string, rel: string) => ipcRenderer.invoke('logs:detachAttachment', logId, rel),
  /** 附件 → data URL（预览唯一通道）；超大文件返回 tooLarge */
  logsAttachmentData: (rel: string) => ipcRenderer.invoke('logs:attachmentData', rel),
  /** 用系统程序打开附件 */
  logsOpenAttachment: (rel: string) => ipcRenderer.invoke('logs:openAttachment', rel),
  /** 复制到剪贴板（主进程通道：不受 file:// 起源与窗口焦点限制，见 shared/clipboard.ts） */
  clipboardWriteText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
  /** UI 偏好（真身在主进程 prefs.json，见 main/services/prefs.ts） */
  prefsGet: () => ipcRenderer.invoke('prefs:get'),
  prefsSet: (key: string, value: any) => ipcRenderer.invoke('prefs:set', key, value),
  /** 一次写多个键（合并为一次读-改-写，并回读校验）；返回 { ok, written, error } */
  prefsSetMany: (patch: Record<string, any>) => ipcRenderer.invoke('prefs:setMany', patch),
  logsCleanup: () => ipcRenderer.invoke('logs:cleanup'),

  // Blockers
  getBlockerChains: () => ipcRenderer.invoke('getBlockerChains'),
  /** Git 联动（卡 017）：只读某张卡存续期间它所属仓库的提交 + 提到本卡 ID 的提交 */
  gitTaskCommits: (taskId: string) => ipcRenderer.invoke('git:taskCommits', taskId),
  
  // Roadmap + Suggestions
  aggregateRoadmap: (projectId?: string) => ipcRenderer.invoke('aggregateRoadmap', projectId),
  suggestActions: (projectId: string) => ipcRenderer.invoke('suggestActions', projectId),
  suggestCrossProject: () => ipcRenderer.invoke('suggestCrossProject'),
  copyTask: (id: string) => ipcRenderer.invoke('copyTask', id),
  getRoadmapTrend: (days?: number) => ipcRenderer.invoke('getRoadmapTrend', days),
  detectParallelOpportunities: () => ipcRenderer.invoke('detectParallelOpportunities'),
  suggestMilestones: () => ipcRenderer.invoke('suggestMilestones'),

  cronCheck: () => ipcRenderer.invoke('cronCheck'),

  // ── Notifications（通知中心） ──
  notificationsList: (filter?: { unreadOnly?: boolean }) => ipcRenderer.invoke('notifications:list', filter),
  notificationsUnreadCount: () => ipcRenderer.invoke('notifications:unreadCount'),
  notificationsMarkRead: (id: string) => ipcRenderer.invoke('notifications:markRead', id),
  notificationsMarkAllRead: () => ipcRenderer.invoke('notifications:markAllRead'),
  notificationsDelete: (id: string) => ipcRenderer.invoke('notifications:delete', id),
  notificationsClear: () => ipcRenderer.invoke('notifications:clear'),
  notificationsScan: () => ipcRenderer.invoke('notifications:scan'),
  // 2026-10-01 P0-4/P0-5：扫描器状态 + 被静音提醒的可见与恢复
  notificationsScannerStatus: () => ipcRenderer.invoke('notifications:scannerStatus'),
  notificationsListMuted: () => ipcRenderer.invoke('notifications:listMuted'),
  notificationsUnmuteAll: () => ipcRenderer.invoke('notifications:unmuteAll'),

  // Services / Workbench
  scanServices: () => ipcRenderer.invoke('scanServices'), 
  // LLM
  llmGetConfig: () => ipcRenderer.invoke('llm:getConfig'),
  llmSetConfig: (cfg: any) => ipcRenderer.invoke('llm:setConfig', cfg),
  llmResetConfig: () => ipcRenderer.invoke('llm:resetConfig'),
  llmTestConnection: (cfg?: any) => ipcRenderer.invoke('llm:testConnection', cfg),
  llmChat: (content: string, options: any) => ipcRenderer.invoke('llm:chat', content, options),
  llmAudit: (projectId: string, model?: string) => ipcRenderer.invoke('llm:auditProject', projectId, model),
  llmDecompose: (goal: string, projectId?: string, model?: string) => ipcRenderer.invoke('llm:decomposeGoal', goal, projectId, model),
  llmDecide: (dp: any, model?: string) => ipcRenderer.invoke('llm:decideDP', dp, model),
  llmReview: (projectId?: string, model?: string) => ipcRenderer.invoke('llm:quarterlyReview', projectId, model),
  llmRoadmap: (goal?: string, projectId?: string, model?: string) => ipcRenderer.invoke('llm:generateRoadmap', goal, projectId, model),

  // Launchpad
  policyGet: (projectId: string) => ipcRenderer.invoke('policy:get', projectId),
  policySave: (p: any) => ipcRenderer.invoke('policy:save', p),
  policyText: (projectId: string) => ipcRenderer.invoke('policy:text', projectId),
  // 在途一屏（Q2）：只读聚合 —— 各 repo 契约 + 任务卡 + 执行日志 + git 提交时间。
  // 方寸**绝不写**任何项目仓库；写操作只走 prefs（既有 prefs:set 通道）。
  tripBoard: () => ipcRenderer.invoke('trip:board'),
  contractText: (projectId: string) => ipcRenderer.invoke('trip:contractText', projectId),
  tripOpenRepo: (projectId: string) => ipcRenderer.invoke('trip:openRepo', projectId),
  tripInitContract: (projectId: string) => ipcRenderer.invoke('trip:initContract', projectId),
  launchpadLoadApps: () => ipcRenderer.invoke('launchpad:loadApps'),
  launchpadAddApp: (app: any) => ipcRenderer.invoke('launchpad:addApp', app),
  launchpadUpdateApp: (id: string, updates: any) => ipcRenderer.invoke('launchpad:updateApp', id, updates),
  launchpadRemoveApp: (id: string) => ipcRenderer.invoke('launchpad:removeApp', id),
  launchpadLaunchApp: (appConfig: any) => ipcRenderer.invoke('launchpad:launchApp', appConfig),
  launchpadOpenFolder: (folderPath: string) => ipcRenderer.invoke('launchpad:openFolder', folderPath),
  launchpadOpenUrl: (url: string) => ipcRenderer.invoke('launchpad:openUrl', url),
  launchpadGetConfigPath: () => ipcRenderer.invoke('launchpad:getConfigPath'),

  // ── Todos ─────────────────────────────────────────────────────────
  todosList: (filter?: any) => ipcRenderer.invoke('todos:list', filter),
  todosCreate: (title: string, priority?: string, due?: string, project?: string) => ipcRenderer.invoke('todos:create', title, priority, due, project),
  todosUpdate: (id: string, updates: any) => ipcRenderer.invoke('todos:update', id, updates),
  todosToggle: (id: string) => ipcRenderer.invoke('todos:toggle', id),
  todosDelete: (id: string) => ipcRenderer.invoke('todos:delete', id),
  /** 待办数据健康度（坏文件隔离留痕） */
  todosHealth: () => ipcRenderer.invoke('todos:health'),

  // ── Dispatch ───────────────────────────────────────────────────────
  // 2026-10-06（卡 004）：`dispatchPreview` / `dispatchExecute` **已删**。
  // 桌面「派活」入口早在 9/20 就判死（用户：派活极不可靠、易失控，执行过程/进度/结果都看不见），
  // 现在右键只给「📐 复制为派工单」（纯文本拼接、只复制不派发）。
  // 但这两个通道一直留在 preload + 主进程里 —— **渲染层零调用**，整条是死代码。
  // 删掉它，并给 check-ipc-parity 补了第 ⑤ 类（死通道）断言，下次这类残留会被查出来。
  // ⚠ CLI 侧的 `tegula dispatch` / `_build_prompt` **不是死代码**（agent 面在用），未动。

  // ── Review ─────────────────────────────────────────────────────────
  reviewAccept: (id: string, reason?: string) => ipcRenderer.invoke('review:accept', id, reason),
  reviewReject: (id: string, reason: string) => ipcRenderer.invoke('review:reject', id, reason),

  // ── File open ─────────────────────────────────────────────────────
  openFile: (filePath: string) => ipcRenderer.invoke('openFile', filePath),

  // Data directory
  setDataDir: (newDir: string) => ipcRenderer.invoke('setDataDir', newDir),
  dataInspect: (dir: string) => ipcRenderer.invoke('data:inspect', dir),
  dataMigrate: (targetDir: string, opts?: any) => ipcRenderer.invoke('data:migrate', targetDir, opts),

  // Updater
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateQuitAndInstall: () => ipcRenderer.invoke('update:quitAndInstall'),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  onUpdateAvailable: (callback: any) => ipcRenderer.on('update:available', (_e, data) => callback(data)),
  onUpdateNotAvailable: (callback: any) => ipcRenderer.on('update:not-available', (_e, data) => callback(data)),
  onUpdateProgress: (callback: any) => ipcRenderer.on('update:progress', (_e, data) => callback(data)),
  onUpdateDownloaded: (callback: any) => ipcRenderer.on('update:downloaded', (_e, data) => callback(data)),
  onUpdateError: (callback: any) => ipcRenderer.on('update:error', (_e, data) => callback(data)),

  // ── Skill 管理 ────────────────────────────────────────────────────
  skillsCheck: () => ipcRenderer.invoke('skills:check'),
  skillsInstall: () => ipcRenderer.invoke('skills:install'),
  /** 装到指定可直装目标（卡 011）：'hermes' | 'dsh' */
  skillsInstallTo: (targetId: string) => ipcRenderer.invoke('skills:installTo', targetId),
  /** 技能安装专区（2026-09-26 卡 038） */
  skillsList: () => ipcRenderer.invoke('skills:list'),
  skillsOpenDir: (which: string) => ipcRenderer.invoke('skills:openDir', which),
  /** 在资源管理器里显示某个技能的 SKILL.md（装到 WorkBuddy 这类只能手动导入的 agent） */
  skillsReveal: (dirOrFile: string) => ipcRenderer.invoke('skills:reveal', dirOrFile),
  /** 「装到别的 agent」目标检测（Hermes 可直装；其余给文件+打开对方） */
  agentsList: () => ipcRenderer.invoke('agents:list'),
  agentsOpen: (id: string) => ipcRenderer.invoke('agents:open', id),
  // MCP 接入材料（卡 002 · A 路线：只出材料，方寸不写外部应用文件）
  mcpInfo: () => ipcRenderer.invoke('mcp:info'),
  mcpSnippet: (targetId: string, entryId: string) => ipcRenderer.invoke('mcp:snippet', targetId, entryId),
  mcpSelfInstall: (targetId: string, entryId: string) => ipcRenderer.invoke('mcp:selfInstall', targetId, entryId),
  mcpOpenConfig: (targetId: string) => ipcRenderer.invoke('mcp:openConfig', targetId),
  /** 日志置顶 / 改项目归属（卡 037 右键菜单） */
  logsSetPinned: (id: string, pinned: boolean) => ipcRenderer.invoke('logs:setPinned', id, pinned),
  logsSetProject: (id: string, project: string) => ipcRenderer.invoke('logs:setProject', id, project),
  /** 待办置顶（卡 037 第二批） */
  todosSetPinned: (id: string, pinned: boolean) => ipcRenderer.invoke('todos:setPinned', id, pinned),
  /** 回收站文件正文预览（不是 id，是文件名） */
  trashRead: (name: string) => ipcRenderer.invoke('trash:read', name),
  /** 起一个"空闲"的启动台应用（只认启动台里带 port 的） */
  servicesStart: (port: number) => ipcRenderer.invoke('services:start', port),
  // 技能直接导入（2026-09-26 卡 005）：kind='folder' | 'file'
  skillsImported: () => ipcRenderer.invoke('skills:imported'),
  skillsImportPick: (kind: string) => ipcRenderer.invoke('skills:importPick', kind),
  skillsImport: (srcPath: string, opts?: { overwrite?: boolean }) => ipcRenderer.invoke('skills:import', srcPath, opts),
  skillsRemove: (name: string) => ipcRenderer.invoke('skills:remove', name),

  // ── 服务 / 端口（2026-09-26 卡 006）：只读监控，没有任何"杀进程"通道 ──
  servicesList: () => ipcRenderer.invoke('services:list'),
  servicesAdd: (svc: { name: string; port: number; note?: string; project?: string }) => ipcRenderer.invoke('services:add', svc),
  servicesRemove: (port: number) => ipcRenderer.invoke('services:remove', port),
  servicesOpen: (port: number) => ipcRenderer.invoke('services:open', port),
  servicesAdopt: (port: number, name?: string) => ipcRenderer.invoke('services:adopt', port, name),

  // ── 应用日志（诊断）────────────────────────────────────────────────
  // 渲染层出错时主动回报主进程落盘；界面提供「打开日志目录 / 查看尾部」。
  applogWrite: (level: string, scope: string, message: string, detail?: string) =>
    ipcRenderer.invoke('applog:write', level, scope, message, detail),
  applogPath: () => ipcRenderer.invoke('applog:path'),
  applogDir: () => ipcRenderer.invoke('applog:dir'),
  applogTail: (lines?: number) => ipcRenderer.invoke('applog:tail', lines),
  applogOpenDir: () => ipcRenderer.invoke('applog:openDir'),
})
