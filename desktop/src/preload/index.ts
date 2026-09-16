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
  
  // Registry
  regSave: (payload: any) => ipcRenderer.invoke('regSave', payload),
  
  // Backup
  backup: () => ipcRenderer.invoke('backup'),
  restore: (path: string) => ipcRenderer.invoke('restore', path),
  
  // Activity
  loadActivity: (limit = 50) => ipcRenderer.invoke('loadActivity', limit),
  
  // Notes
  notesForTask: (taskId: string) => ipcRenderer.invoke('notesForTask', taskId),
  createNote: (note: any) => ipcRenderer.invoke('createNote', note),
  listNotes: () => ipcRenderer.invoke('listNotes'),
  deleteNote: (noteId: string) => ipcRenderer.invoke('deleteNote', noteId),
  
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
