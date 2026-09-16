/**
 * Fangcun Desktop — IPC Bridge
 * Connects renderer (Vue) to main process (data layer)
 */

import { ipcMain, app } from 'electron'
import * as data from './data'
import * as tasks from './data/tasks'
import * as services from './services'
import * as path from 'path'
import * as fs from 'fs'
import { registerLlmIpcHandlers } from './llm-ipc'
import * as launchpad from './launchpad'

export function registerIpcHandlers(): void {
  // Initialize paths
  data.initPaths()
  
  // Register LLM handlers
  registerLlmIpcHandlers()

  // ── Startup self-check ────────────────────────────────────────────
  ipcMain.handle('selfCheck', () => {
    return data.startupSelfCheck()
  })

  // ── Tasks CRUD ────────────────────────────────────────────────────
  ipcMain.handle('loadTasks', (_event, view = 'active') => {
    const all = data.loadTasks(view)
    return all.map(t => ({
      id: t.id,
      title: t.fm.title,
      project: t.fm.project,
      status: t.fm.status,
      priority: t.fm.priority,
      assignee: t.fm.assignee,
      tags: t.fm.tags,
      created: t.fm.created,
      updated: t.fm.updated,
      blockers: t.fm.blockers,
      body: t.body,
      batch: t.fm.batch,
    }))
  })

  ipcMain.handle('getTask', (_event, id: string) => {
    const task = tasks.readTask(id)
    if (!task) return null
    return {
      id: task.id,
      title: task.fm.title,
      project: task.fm.project,
      status: task.fm.status,
      priority: task.fm.priority,
      assignee: task.fm.assignee,
      tags: task.fm.tags,
      created: task.fm.created,
      updated: task.fm.updated,
      blockers: task.fm.blockers,
      body: task.body,
      batch: task.fm.batch,
    }
  })

  ipcMain.handle('newTask', (_event, fields: tasks.NewTaskFields) => {
    const task = tasks.createTask(fields)
    return { ok: true, id: task.id }
  })

  ipcMain.handle('editTask', (_event, id: string, fields: any) => {
    const task = tasks.updateTask(id, fields)
    return { ok: !!task, id }
  })

  ipcMain.handle('moveStatus', (_event, id: string, status: string) => {
    const task = tasks.moveStatus(id, status as any)
    return { ok: !!task, id }
  })

  ipcMain.handle('deleteTask', (_event, id: string) => {
    const ok = tasks.deleteTask(id)
    return { ok }
  })

  ipcMain.handle('archiveTask', (_event, id: string) => {
    const task = tasks.archiveTask(id)
    return { ok: !!task, id }
  })

  // ── Projects ──────────────────────────────────────────────────────
  ipcMain.handle('loadProjects', () => {
    return data.parseRegistry()
  })

  ipcMain.handle('scanProjectStatus', () => {
    return tasks.scanProjectStatus()
  })

  ipcMain.handle('findBlockers', () => {
    return tasks.findBlockers()
  })

  // ── Registry ──────────────────────────────────────────────────────
  ipcMain.handle('regSave', (_event: any, payload: any) => {
    return { ok: true }
  })

  // ── Backup / Restore ──────────────────────────────────────────────
  ipcMain.handle('backup', () => {
    try {
      const backupDir = path.join(data.getDataDir(), 'backups')
      fs.mkdirSync(backupDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const backupPath = path.join(backupDir, `backup-${stamp}.zip`)
      
      // Simple backup: copy task-data manifest
      const taskDir = data.getTaskDir()
      const files = fs.readdirSync(taskDir).filter(f => f.endsWith('.md'))
      const manifest = files.map(f => {
        const p = path.join(taskDir, f)
        return { file: f, size: fs.statSync(p).size, mtime: fs.statSync(p).mtime.toISOString() }
      })
      fs.writeFileSync(backupPath + '.json', JSON.stringify(manifest, null, 2))
      return { ok: true, path: backupPath + '.json' }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle('restore', (_event, backupPath: string) => {
    return { ok: true }
  })

  // ── Activity Log ──────────────────────────────────────────────────
  ipcMain.handle('loadActivity', (_event, limit = 50) => {
    return data.readActivity(limit)
  })

  // ── Data directory info ───────────────────────────────────────────
  ipcMain.handle('getDataDir', () => {
    return data.getDataDir()
  })

  // ── Notes ────────────────────────────────────────────────────────
  ipcMain.handle('notesForTask', (_event, taskId: string) => {
    return services.getNotesForTask(taskId)
  })

  ipcMain.handle('createNote', (_event, note: any) => {
    try {
      const result = services.createNote(note.title || '', note.content || '', note.taskId)
      return { ok: true, note: result }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle('listNotes', () => {
    return services.listNotes()
  })

  ipcMain.handle('deleteNote', (_event, noteId: string) => {
    const ok = services.deleteNote(noteId)
    return { ok }
  })

  // ── Services / Workbench ──────────────────────────────────────────
  ipcMain.handle('scanServices', () => {
    return services.scanServices()
  })

  // ── Launchpad ─────────────────────────────────────────────────────
  ipcMain.handle('launchpad:loadApps', () => {
    return launchpad.loadApps()
  })

  ipcMain.handle('launchpad:addApp', (_event, app: any) => {
    return launchpad.addApp(app)
  })

  ipcMain.handle('launchpad:updateApp', (_event, id: string, updates: any) => {
    return launchpad.updateApp(id, updates)
  })

  ipcMain.handle('launchpad:removeApp', (_event, id: string) => {
    return launchpad.removeApp(id)
  })

  ipcMain.handle('launchpad:launchApp', (_event, appConfig: any) => {
    return launchpad.launchApp(appConfig)
  })

  ipcMain.handle('launchpad:openFolder', (_event, folderPath: string) => {
    return launchpad.openFolder(folderPath)
  })

  ipcMain.handle('launchpad:openUrl', (_event, url: string) => {
    return launchpad.openUrl(url)
  })

  ipcMain.handle('launchpad:getConfigPath', () => {
    return launchpad.getAppConfigPath()
  })
}
