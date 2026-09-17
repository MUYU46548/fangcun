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
  getTask: (id: string) => ipcRenderer.invoke('getTask', id),
  
  // Projects
  loadProjects: () => ipcRenderer.invoke('loadProjects'),
  scanProjectStatus: () => ipcRenderer.invoke('scanProjectStatus'),
  findBlockers: () => ipcRenderer.invoke('findBlockers'),
  batchEdit: (ids: string[], fields: any) => ipcRenderer.invoke('batchEdit', ids, fields),
  batchArchive: (ids: string[]) => ipcRenderer.invoke('batchArchive', ids),
  quickAdd: (text: string) => ipcRenderer.invoke('quickAdd', text),
  naturalQuery: (q: string) => ipcRenderer.invoke('naturalQuery', q),
  getProjectProgress: (projectId: string) => ipcRenderer.invoke('getProjectProgress', projectId),

  // Plan
  createPlan: (fields: any) => ipcRenderer.invoke('createPlan', fields),
  listPlans: () => ipcRenderer.invoke('listPlans'),
  getPlan: (id: string) => ipcRenderer.invoke('getPlan', id),
  decidePlanPoint: (id: string, dpId: string, choice: string) => ipcRenderer.invoke('decidePlanPoint', id, dpId, choice),
  findTimeoutTasks: (threshold?: number) => ipcRenderer.invoke('findTimeoutTasks', threshold),
  
  // Registry
  regSave: (payload: any) => ipcRenderer.invoke('regSave', payload),
  
  // ── Backup
  backup: () => ipcRenderer.invoke('backup'),
  restore: (backupPath: string) => ipcRenderer.invoke('restore', backupPath),
  listBackups: () => ipcRenderer.invoke('listBackups'),
  isFirstRun: () => ipcRenderer.invoke('isFirstRun'),
  createFreshSetup: (targetDir: string) => ipcRenderer.invoke('createFreshSetup', targetDir),
  importFromPythonTegula: (targetDir: string, pythonDir: string) => ipcRenderer.invoke('importFromPythonTegula', targetDir, pythonDir),
  browseDirectory: () => ipcRenderer.invoke('browseDirectory'),
  
  // Activity
  loadActivity: (limit = 50) => ipcRenderer.invoke('loadActivity', limit),
  
  // Notes
  notesForTask: (taskId: string) => ipcRenderer.invoke('notesForTask', taskId),
  createNote: (note: any) => ipcRenderer.invoke('createNote', note),
  updateNote: (noteId: string, updates: any) => ipcRenderer.invoke('updateNote', noteId, updates),
  listNotes: () => ipcRenderer.invoke('listNotes'),
  deleteNote: (noteId: string) => ipcRenderer.invoke('deleteNote', noteId),
  exportNotes: () => ipcRenderer.invoke('exportNotes'),
  importNotes: (data: any[]) => ipcRenderer.invoke('importNotes', data),

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
  detectEvents: (eventType: string) => ipcRenderer.invoke('detectEvents', eventType),
  cronCheck: () => ipcRenderer.invoke('cronCheck'),

  // Services / Workbench
  scanServices: () => ipcRenderer.invoke('scanServices'), 
  // LLM
  llmGetConfig: () => ipcRenderer.invoke('llm:getConfig'),
  llmSetConfig: (cfg: any) => ipcRenderer.invoke('llm:setConfig', cfg),
  llmResetConfig: () => ipcRenderer.invoke('llm:resetConfig'),
  llmChat: (content: string, options: any) => ipcRenderer.invoke('llm:chat', content, options),
  llmAudit: (projectId: string, model?: string) => ipcRenderer.invoke('llm:auditProject', projectId, model),
  llmDecompose: (goal: string, projectId?: string, model?: string) => ipcRenderer.invoke('llm:decomposeGoal', goal, projectId, model),
  llmDecide: (dp: any, model?: string) => ipcRenderer.invoke('llm:decideDP', dp, model),
  llmReview: (projectId?: string, model?: string) => ipcRenderer.invoke('llm:quarterlyReview', projectId, model),
  llmRoadmap: (goal?: string, projectId?: string, model?: string) => ipcRenderer.invoke('llm:generateRoadmap', goal, projectId, model),

  // Launchpad
  launchpadLoadApps: () => ipcRenderer.invoke('launchpad:loadApps'),
  launchpadAddApp: (app: any) => ipcRenderer.invoke('launchpad:addApp', app),
  launchpadUpdateApp: (id: string, updates: any) => ipcRenderer.invoke('launchpad:updateApp', id, updates),
  launchpadRemoveApp: (id: string) => ipcRenderer.invoke('launchpad:removeApp', id),
  launchpadLaunchApp: (appConfig: any) => ipcRenderer.invoke('launchpad:launchApp', appConfig),
  launchpadOpenFolder: (folderPath: string) => ipcRenderer.invoke('launchpad:openFolder', folderPath),
  launchpadOpenUrl: (url: string) => ipcRenderer.invoke('launchpad:openUrl', url),
  launchpadGetConfigPath: () => ipcRenderer.invoke('launchpad:getConfigPath'),

  // Data directory
  setDataDir: (newDir: string) => ipcRenderer.invoke('setDataDir', newDir),

  // Updater
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateQuitAndInstall: () => ipcRenderer.invoke('update:quitAndInstall'),
  onUpdateAvailable: (callback: any) => ipcRenderer.on('update:available', (_e, data) => callback(data)),
  onUpdateNotAvailable: (callback: any) => ipcRenderer.on('update:not-available', (_e, data) => callback(data)),
  onUpdateProgress: (callback: any) => ipcRenderer.on('update:progress', (_e, data) => callback(data)),
  onUpdateDownloaded: (callback: any) => ipcRenderer.on('update:downloaded', (_e, data) => callback(data)),
  onUpdateError: (callback: any) => ipcRenderer.on('update:error', (_e, data) => callback(data)),
})
