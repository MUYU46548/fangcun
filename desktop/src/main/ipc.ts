/**
 * Fangcun Desktop — IPC Bridge
 * Connects renderer (Vue) to main process (data layer)
 */

import { ipcMain, app, dialog } from 'electron'
import * as data from './data'
import * as tasks from './data/tasks'
import * as services from './services'
import * as path from 'path'
import * as fs from 'fs'
import { execSync } from 'child_process'
import * as os from 'os'
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
    try {
      const task = tasks.moveStatus(id, status as any)
      if (!task) {
        return { ok: false, id, error: `任务不存在或无法读取: ${id}` }
      }
      return { ok: true, id }
    } catch (e: any) {
      return { ok: false, id, error: e.message }
    }
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
      const taskDir = data.getTaskDir()
      const regFile = data.getRegistryPath()
      const backupDir = path.join(data.getDataDir(), 'backups')
      fs.mkdirSync(backupDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const backupPath = path.join(backupDir, `backup-${stamp}.zip`)
      const tempDir = path.join(os.tmpdir(), `fc-backup-${stamp}`)

      // 1. robocopy task-data → temp (exclude .tmp, .bak, .trash, .backup)
      try {
        execSync(
          `robocopy "${taskDir}" "${tempDir}${path.sep}task-data" /E /XF *.tmp *.bak /XD .trash .backup backups /NJH /NJS`,
          { timeout: 30000 }
        )
      } catch (e: any) {
        // robocopy exit 0-7 = success, 8+ = real error
        if (e.status && e.status >= 8) throw e
      }

      // 2. copy registry.yaml
      if (fs.existsSync(regFile)) {
        fs.copyFileSync(regFile, path.join(tempDir, 'registry.yaml'))
      }

      // 3. compress
      execSync(
        `powershell -Command "Compress-Archive -Path '${tempDir}${path.sep}*' -DestinationPath '${backupPath}' -Force"`,
        { timeout: 60000 }
      )

      // 4. cleanup temp
      fs.rmSync(tempDir, { recursive: true, force: true })

      // 5. rotate (keep 10)
      const backups = fs.readdirSync(backupDir).filter(f => f.endsWith('.zip')).sort()
      let removed = 0
      while (backups.length > 10) {
        const old = backups.shift()!
        try { fs.unlinkSync(path.join(backupDir, old)); removed++ } catch {}
      }

      const sizeKB = fs.statSync(backupPath).size / 1024
      return { ok: true, path: backupPath, sizeKB: Math.round(sizeKB), removed }
    } catch (e: any) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('restore', async (_event, backupPath: string) => {
    try {
      if (!fs.existsSync(backupPath)) {
        return { ok: false, error: '备份文件不存在: ' + backupPath }
      }
      const dataDir = data.getDataDir()
      const taskDir = data.getTaskDir()
      const regFile = data.getRegistryPath()
      const tempDir = path.join(os.tmpdir(), `fc-restore-${Date.now()}`)

      // 1. extract to temp
      execSync(
        `powershell -Command "Expand-Archive -Path '${backupPath}' -DestinationPath '${tempDir}' -Force"`,
        { timeout: 60000 }
      )

      // 2. snapshot current (rename task-data → task-data.snapshot)
      const snapshotDir = path.join(dataDir, `task-data.snapshot-${Date.now()}`)
      if (fs.existsSync(taskDir)) {
        fs.renameSync(taskDir, snapshotDir)
      }
      const snapshotReg = regFile + '.snapshot'
      if (fs.existsSync(regFile)) {
        fs.copyFileSync(regFile, snapshotReg)
      }

      try {
        // 3. move extracted data into place
        const extractedTaskDir = path.join(tempDir, 'task-data')
        if (fs.existsSync(extractedTaskDir)) {
          fs.renameSync(extractedTaskDir, taskDir)
        } else {
          throw new Error('备份中缺少 task-data 目录')
        }
        const extractedReg = path.join(tempDir, 'registry.yaml')
        if (fs.existsSync(extractedReg)) {
          fs.copyFileSync(extractedReg, regFile)
        }

        // 4. cleanup temp + snapshot
        fs.rmSync(tempDir, { recursive: true, force: true })
        if (fs.existsSync(snapshotDir)) {
          fs.rmSync(snapshotDir, { recursive: true, force: true })
        }
        if (fs.existsSync(snapshotReg)) {
          fs.unlinkSync(snapshotReg)
        }

        return { ok: true }
      } catch (innerErr: any) {
        // rollback snapshot
        if (fs.existsSync(snapshotDir) && !fs.existsSync(taskDir)) {
          fs.renameSync(snapshotDir, taskDir)
        }
        if (fs.existsSync(snapshotReg) && !fs.existsSync(regFile)) {
          fs.copyFileSync(snapshotReg, regFile)
          fs.unlinkSync(snapshotReg)
        }
        throw innerErr
      }
    } catch (e: any) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  // ── List backups ──────────────────────────────────────────────────
  ipcMain.handle('listBackups', () => {
    try {
      const backupDir = path.join(data.getDataDir(), 'backups')
      if (!fs.existsSync(backupDir)) return []
      const files = fs.readdirSync(backupDir)
        .filter(f => f.endsWith('.zip'))
        .map(f => {
          const p = path.join(backupDir, f)
          const stat = fs.statSync(p)
          return { name: f, path: p, size: stat.size, mtime: stat.mtime.toISOString() }
        })
        .sort((a, b) => b.mtime.localeCompare(a.mtime))
      return files
    } catch {
      return []
    }
  })

  // ── First run setup ───────────────────────────────────────────────
  ipcMain.handle('isFirstRun', () => {
    return data.isFirstRun()
  })

  ipcMain.handle('createFreshSetup', (_event, targetDir: string) => {
    try {
      data.createFreshSetup(targetDir)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('importFromPythonTegula', (_event, targetDir: string, pythonDir: string) => {
    try {
      data.importFromPythonTegula(targetDir, pythonDir)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('browseDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  // ── Activity Log ──────────────────────────────────────────────────
  ipcMain.handle('loadActivity', (_event, limit = 50) => {
    return data.readActivity(limit)
  })

  // ── Data directory info ───────────────────────────────────────────
  ipcMain.handle('getDataDir', () => {
    return data.getDataDir()
  })

  ipcMain.handle('setDataDir', (_event, newDir: string) => {
    try {
      data.setDataDir(newDir)
      return { ok: true, dir: data.getDataDir() }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
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
