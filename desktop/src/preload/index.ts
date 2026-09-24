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
  
  // ── Backup
  backup: () => ipcRenderer.invoke('backup'),
  restore: (backupPath: string) => ipcRenderer.invoke('restore', backupPath),
  listBackups: () => ipcRenderer.invoke('listBackups'),

  // ── 备份 v2（WebDAV + 调度 + 可验证恢复）
  backupGetConfig: () => ipcRenderer.invoke('backup:getConfig'),
  backupSetConfig: (patch: any) => ipcRenderer.invoke('backup:setConfig', patch),
  backupStatus: () => ipcRenderer.invoke('backup:status'),
  backupRun: () => ipcRenderer.invoke('backup:run'),
  backupRunLocalOnly: () => ipcRenderer.invoke('backup:runLocalOnly'),
  backupListLocal: () => ipcRenderer.invoke('backup:listLocal'),
  backupListRemote: () => ipcRenderer.invoke('backup:listRemote'),
  backupTestRemote: (input: any) => ipcRenderer.invoke('backup:testRemote', input),
  backupListSources: (includeRemote?: boolean) => ipcRenderer.invoke('backup:listSources', !!includeRemote),
  backupRestore: (source: any) => ipcRenderer.invoke('backup:restore', source),
  backupState: () => ipcRenderer.invoke('backup:state'),
  backupLog: (lines?: number) => ipcRenderer.invoke('backup:log', lines),
  backupOpenDir: () => ipcRenderer.invoke('backup:openDir'),
  backupLocalDir: () => ipcRenderer.invoke('backup:localDir'),
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
  
  // Notes
  notesForTask: (taskId: string) => ipcRenderer.invoke('notesForTask', taskId),
  createNote: (note: any) => ipcRenderer.invoke('createNote', note),
  updateNote: (noteId: string, updates: any) => ipcRenderer.invoke('updateNote', noteId, updates),
  listNotes: () => ipcRenderer.invoke('listNotes'),
  deleteNote: (noteId: string) => ipcRenderer.invoke('deleteNote', noteId),
  attachNote: (noteId: string, taskId: string) => ipcRenderer.invoke('attachNote', noteId, taskId),
  detachNote: (noteId: string) => ipcRenderer.invoke('detachNote', noteId),
  exportNotes: () => ipcRenderer.invoke('exportNotes'),
  importNotes: (data: any[]) => ipcRenderer.invoke('importNotes', data),
  importNoteFromFile: (filePath: string, taskId?: string) => ipcRenderer.invoke('importNoteFromFile', filePath, taskId),

  // ── Tasks Import/Export（设置页「导出/导入任务 JSON」按钮）────────────
  // 此前渲染层在调 window.tegula.exportTasks/importTasks，主进程也注册了同名
  // handler（ipc.ts），唯独 preload 这层没有暴露 → 点击必 TypeError（僵尸按钮第 4、5 例）。
  exportTasks: () => ipcRenderer.invoke('exportTasks'),
  importTasks: (data: any[]) => ipcRenderer.invoke('importTasks', data),

  // Logs
  logsList: (filter?: any) => ipcRenderer.invoke('logs:list', filter),
  logsForTask: (taskId: string) => ipcRenderer.invoke('logs:forTask', taskId),
  logsGet: (id: string) => ipcRenderer.invoke('logs:get', id),
  logsCreate: (title: string, project: string, content: string, taskId?: string, extra?: { sessionId?: string; agentName?: string; logDate?: string }) => ipcRenderer.invoke('logs:create', title, project, content, taskId, extra),
  logsUpdate: (id: string, updates: any) => ipcRenderer.invoke('logs:update', id, updates),
  logsComplete: (id: string, retainDays: number | null, note?: string) => ipcRenderer.invoke('logs:complete', id, retainDays, note),
  logsArchive: (id: string, note?: string) => ipcRenderer.invoke('logs:archive', id, note),
  logsDestroy: (id: string) => ipcRenderer.invoke('logs:destroy', id),
  logsSearch: (query: string) => ipcRenderer.invoke('logs:search', query),
  logsInject: (id: string) => ipcRenderer.invoke('logs:inject', id),
  logsCleanup: () => ipcRenderer.invoke('logs:cleanup'),

  // Blockers
  getBlockerChains: () => ipcRenderer.invoke('getBlockerChains'),
  
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

  // ── Dispatch ───────────────────────────────────────────────────────
  dispatchPreview: (id: string) => ipcRenderer.invoke('dispatch:preview', id),
  dispatchExecute: (id: string) => ipcRenderer.invoke('dispatch:execute', id),

  // ── Review ─────────────────────────────────────────────────────────
  reviewAccept: (id: string) => ipcRenderer.invoke('review:accept', id),
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

  // ── 应用日志（诊断）────────────────────────────────────────────────
  // 渲染层出错时主动回报主进程落盘；界面提供「打开日志目录 / 查看尾部」。
  applogWrite: (level: string, scope: string, message: string, detail?: string) =>
    ipcRenderer.invoke('applog:write', level, scope, message, detail),
  applogPath: () => ipcRenderer.invoke('applog:path'),
  applogDir: () => ipcRenderer.invoke('applog:dir'),
  applogTail: (lines?: number) => ipcRenderer.invoke('applog:tail', lines),
  applogOpenDir: () => ipcRenderer.invoke('applog:openDir'),
})
