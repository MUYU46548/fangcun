/**
 * Fangcun Desktop — IPC Bridge
 * Connects renderer (Vue) to main process (data layer)
 */

import { ipcMain, app, dialog, BrowserWindow } from 'electron'
import * as data from './data'
import * as tasks from './data/tasks'
import * as services from './services'
import * as todosService from './services/todos'
import * as logsService from './services/logs'
import * as notificationsService from './services/notifications'
import * as notifierService from './services/notifier'
import * as path from 'path'
import * as fs from 'fs'
import { execSync } from 'child_process'
import * as os from 'os'
import { registerLlmIpcHandlers } from './llm-ipc'
import { runBackup } from './backup'
import * as launchpad from './launchpad'
import * as policies from './services/policies'

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

  /**
   * Task → 渲染层视图对象。
   *
   * 用展开而不是手写字段列表：之前两处各写一份，都漏了 deadline/memo，
   * 直接后果是「截止日期筛选」永远拿不到值。新增字段不需要再来改这里。
   * 同时保留 fm 与 path，供需要完整 frontmatter / 文件路径的场景使用。
   */
  function flattenTask(t: data.Task) {
    return {
      ...t.fm,
      id: t.id,
      fm: t.fm,
      body: t.body,
      path: t.path,
      // 归档按路径判定 —— 完成/驳回的任务可能仍在活跃区，只看 status 会误判
      archived: tasks.isArchivedPath(t.path),
    }
  }

  ipcMain.handle('loadTasks', (_event, view = 'active') => {
    return data.loadTasks(view).map(flattenTask)
  })

  // 解析失败的任务文件：以前是静默跳过（任务"人间蒸发"），现在交给界面显性提示
  ipcMain.handle('parseErrors', () => data.getParseErrors())

  ipcMain.handle('getTask', (_event, id: string) => {
    const task = tasks.readTask(id)
    return task ? flattenTask(task) : null
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

  ipcMain.handle('unarchiveTask', (_event, id: string) => {
    const task = tasks.unarchiveTask(id)
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
    return tasks.getBlockerChains().map(c => ({ id: c.id, title: c.title, blockers: c.blockers.map(b => b.id) }))
  })

  // ── Plan System ─────────────────────────────────────────────────────
  ipcMain.handle('createPlan', (_event, fields: any) => {
    try {
      const result = tasks.createPlan(fields)
      return { ok: true, id: result.id }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('listPlans', () => {
    return tasks.listPlans()
  })

  ipcMain.handle('getPlan', (_event, id: string) => {
    return tasks.getPlan(id)
  })

  ipcMain.handle('decidePlanPoint', (_event, id: string, dpId: string, choice: string) => {
    return tasks.decidePlanPoint(id, dpId, choice)
  })

  // ── Timeout + Progress ──────────────────────────────────────────────
  ipcMain.handle('findTimeoutTasks', (_event, threshold?: number) => {
    return tasks.findTimeoutTasks(threshold)
  })

  ipcMain.handle('getProjectProgress', (_event, projectId: string) => {
    return tasks.getProjectProgress(projectId)
  })

  // 一次扫描出全部项目进度：前端原先逐项目调用 = 项目数 × 全量扫描
  ipcMain.handle('allProjectProgress', () => {
    return tasks.getAllProjectProgress()
  })

  // ── Batch Ops ──────────────────────────────────────────────────────
  ipcMain.handle('batchEdit', (_event, ids: string[], fields: any) => {
    return tasks.batchEdit(ids, fields)
  })

  ipcMain.handle('batchArchive', (_event, ids: string[]) => {
    return tasks.batchArchive(ids)
  })

  ipcMain.handle('batchDelete', (_event, ids: string[]) => {
    return tasks.batchDelete(ids)
  })

  // ── Quick Add ───────────────────────────────────────────────────────
  ipcMain.handle('quickAdd', (_event, text: string) => {
    return tasks.quickAdd(text)
  })

  // ── Natural Query ───────────────────────────────────────────────────
  // ── Task metadata（新建/编辑表单的唯一字段来源） ────────────────────
  ipcMain.handle('taskFieldSpecs', () => data.TASK_FIELD_SPECS)

  ipcMain.handle('taskEnums', () => ({
    statuses: data.STATUSES,
    priorities: data.PRIORITIES,
  }))

  /** 取某任务的表单值（数组字段转逗号串）。id 为 null 时返回空表单。 */
  ipcMain.handle('taskFormValues', (_event, id: string | null) => {
    const task = id ? tasks.readTask(id) : null
    return data.taskToFormValues(task)
  })

  ipcMain.handle('naturalQuery', (_event, q: string, opts?: { includeArchive?: boolean }) => {
    return tasks.parseNaturalQuery(q, opts || {})
  })

  // ── Registry ──────────────────────────────────────────────────────
  // 原 regSave 是 `return { ok: true }` 的空实现：前端拿到成功、实际什么都没写，
  // 属于「假成功」，已移除。新建项目改走 registry:addProject（真写入 + 写前自校验）。
  ipcMain.handle('registry:addProject', (_event, fields: data.NewProjectFields) => {
    try {
      return data.addProjectToRegistry(fields || { id: '' })
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
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

      // 5. write checksum sidecar
      const checksum = data.computeChecksum(backupPath)
      const checksumPath = backupPath + '.sha256'
      fs.writeFileSync(checksumPath, checksum, 'utf-8')

      // 6. rotate (keep 10)
      const backups = fs.readdirSync(backupDir).filter(f => f.endsWith('.zip')).sort()
      let removed = 0
      while (backups.length > 10) {
        const old = backups.shift()!
        try { fs.unlinkSync(path.join(backupDir, old)); removed++ } catch {}
        try { fs.unlinkSync(path.join(backupDir, old + '.sha256')) } catch {}
      }

      const sizeKB = fs.statSync(backupPath).size / 1024
      return { ok: true, path: backupPath, sizeKB: Math.round(sizeKB), removed, checksum }
    } catch (e: any) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('restore', async (_event, backupPath: string) => {
    try {
      if (!fs.existsSync(backupPath)) {
        return { ok: false, error: '备份文件不存在: ' + backupPath }
      }

      // Verify checksum if sidecar exists
      const checksumPath = backupPath + '.sha256'
      if (fs.existsSync(checksumPath)) {
        const expected = fs.readFileSync(checksumPath, 'utf-8').trim()
        const actual = data.computeChecksum(backupPath)
        if (expected !== actual) {
          return { ok: false, error: `备份文件校验失败: 期望 ${expected}, 实际 ${actual}` }
        }
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

  /**
   * 目录选择。
   * 必须传父窗口：不传时 Windows 上对话框不置顶，用户点「浏览…」看不到任何变化，
   * 表现得就像按钮坏了。同时加 try/catch —— 对话框异常不应把 IPC 变成静默挂起。
   */
  ipcMain.handle('browseDirectory', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        title: '选择目录',
        properties: ['openDirectory' as const, 'createDirectory' as const],
      }
      const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return result.canceled ? null : result.filePaths[0] ?? null
    } catch (e) {
      console.warn('[browseDirectory]', (e as Error).message)
      return null
    }
  })

  ipcMain.handle('browseFile', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        title: '选择程序',
        properties: ['openFile' as const],
        filters: [
          { name: '可执行文件', extensions: ['exe', 'bat', 'cmd'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      }
      const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return result.canceled ? null : result.filePaths[0] ?? null
    } catch (e) {
      console.warn('[browseFile]', (e as Error).message)
      return null
    }
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

  /** 数据目录体检（只读）：判断目标能否迁入、里面已有多少数据 */
  ipcMain.handle('data:inspect', (_event, dir: string) => {
    try {
      return { ok: true, info: data.inspectDataDir(dir) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  /**
   * 搬迁数据目录：备份 → 复制 → 切换指针。
   *
   * 关键纪律：
   *  - 用「复制」而非「移动」，源目录原样保留，出问题数据还在
   *  - 备份失败直接中止（没有回滚点的写操作不做）
   *  - 目标已有数据时必须显式 allowExisting，不静默覆盖
   */
  ipcMain.handle('data:migrate', async (
    _event,
    targetDir: string,
    opts?: { allowExisting?: boolean; skipBackup?: boolean }
  ) => {
    try {
      const from = data.getDataDir()
      const info = data.inspectDataDir(targetDir)

      if (info.isCurrent) return { ok: false, error: '目标就是当前数据目录' }
      if (info.insideCurrent) return { ok: false, error: '目标位于当前数据目录内部，不能迁入' }
      if (!info.empty && !opts?.allowExisting && info.exists) {
        return {
          ok: false,
          error: `目标目录已存在方寸数据（${info.taskCount} 个任务文件），需显式确认才能迁入`,
          needsConfirm: true,
          info,
        }
      }

      // ① 迁移前备份：拿不到回滚点就不动手
      let backupPath: string | null = null
      if (!opts?.skipBackup) {
        const r = await runBackup({ trigger: 'manual', localOnly: true })
        if (!r.ok) {
          return { ok: false, error: `迁移前备份失败，已中止：${r.errors[0] || '未知错误'}` }
        }
        backupPath = r.localPath
      }

      // ② 复制数据
      const migrated = data.migrateDataDir(targetDir, { allowExisting: !!opts?.allowExisting })
      if (!migrated.ok) {
        return { ok: false, error: migrated.errors.join('；'), backupPath, migrated }
      }

      // ③ 切换指针
      data.setDataDir(targetDir)

      return { ok: true, from, to: data.getDataDir(), backupPath, migrated }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ── Notes ─────────────────────────────────────────────────────────
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

  ipcMain.handle('updateNote', (_event, noteId: string, updates: any) => {
    try {
      const result = services.updateNote(noteId, updates)
      return { ok: !!result, note: result }
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

  ipcMain.handle('importNoteFromFile', (_event, filePath: string, taskId?: string) => {
    try {
      const note = services.importNoteFromFile(filePath, taskId)
      return { ok: !!note, note }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('attachNote', (_event, noteId: string, taskId: string) => {
    const ok = services.attachNote(noteId, taskId)
    return { ok }
  })

  ipcMain.handle('detachNote', (_event, noteId: string) => {
    const ok = services.detachNote(noteId)
    return { ok }
  })

  // ── Blocker chains ─────────────────────────────────────────────────
  ipcMain.handle('getBlockerChains', () => {
    return tasks.getBlockerChains()
  })

  // ── Notes Import/Export ────────────────────────────────────────────
  ipcMain.handle('exportNotes', () => {
    return tasks.exportNotes()
  })

  ipcMain.handle('importNotes', (_event, data: any[]) => {
    return tasks.importNotes(data)
  })

  // ── Task Import/Export ────────────────────────────────────────────
  ipcMain.handle('exportTasks', () => {
    return tasks.exportTasks()
  })

  ipcMain.handle('importTasks', (_event, data: any[]) => {
    return tasks.importTasks(data)
  })

  // ── Roadmap + Suggestions ─────────────────────────────────────────
  ipcMain.handle('aggregateRoadmap', (_event, projectId?: string) => {
    return tasks.aggregateRoadmap(projectId)
  })

  ipcMain.handle('suggestActions', (_event, projectId: string) => {
    return tasks.suggestActions(projectId)
  })

  ipcMain.handle('suggestCrossProject', () => {
    return tasks.suggestCrossProject()
  })

  ipcMain.handle('copyTask', (_event, id: string) => {
    return tasks.copyTask(id)
  })

  ipcMain.handle('getRoadmapTrend', (_event, days?: number) => {
    return tasks.getRoadmapTrend(days)
  })

  ipcMain.handle('detectParallelOpportunities', () => {
    return tasks.detectParallelOpportunities()
  })

  ipcMain.handle('suggestMilestones', () => {
    return tasks.suggestMilestones()
  })

  ipcMain.handle('detectEvents', (_event, eventType: string) => {
    return tasks.detectEvents(eventType)
  })

  // ── Notifications（通知中心） ─────────────────────────────────────
  ipcMain.handle('notifications:list', (_event, filter?: { unreadOnly?: boolean }) => {
    return notificationsService.listNotifications(filter)
  })

  ipcMain.handle('notifications:unreadCount', () => {
    return notificationsService.getUnreadCount()
  })

  ipcMain.handle('notifications:markRead', (_event, id: string) => {
    return notificationsService.markRead(id)
  })

  ipcMain.handle('notifications:markAllRead', () => {
    return notificationsService.markAllRead()
  })

  ipcMain.handle('notifications:delete', (_event, id: string) => {
    return notificationsService.deleteNotification(id)
  })

  ipcMain.handle('notifications:clear', () => {
    return notificationsService.clearAll()
  })

  ipcMain.handle('notifications:scan', () => {
    return notifierService.scanOnce()
  })

  ipcMain.handle('cronCheck', () => {
    return tasks.cronCheck()
  })

  // ── Services / Workbench ──────────────────────────────────────────
  ipcMain.handle('scanServices', () => {
    return services.scanServices()
  })

  // ── Launchpad ─────────────────────────────────────────────────────
  // ── Policies（方针区）──────────────────────────────────────────────
  ipcMain.handle('policy:get', (_event, projectId: string) => {
    try { return { ok: true, policy: policies.getPolicy(projectId) } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('policy:save', (_event, p: any) => {
    try { return policies.savePolicy(p) }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('policy:text', (_event, projectId: string) => {
    try {
      const p = policies.getPolicy(projectId)
      return p ? { ok: true, text: policies.policyToText(p) } : { ok: false, error: '方针卡不存在' }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

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

  // ── Todos ──────────────────────────────────────────────────────────
  ipcMain.handle('todos:list', (_event, filter?) => {
    return todosService.listTodos(filter)
  })

  ipcMain.handle('todos:create', (_event: any, title: string, priority?: string, due?: string, project?: string) => {
    try {
      const todo = todosService.createTodo(title, priority as any, due, project)
      return { ok: true, todo }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('todos:update', (_event: any, id: string, updates: any) => {
    try {
      const todo = todosService.updateTodo(id, updates)
      return { ok: !!todo, todo }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('todos:toggle', (_event: any, id: string) => {
    const todo = todosService.toggleTodo(id)
    return { ok: !!todo, todo }
  })

  ipcMain.handle('todos:delete', (_event: any, id: string) => {
    const ok = todosService.deleteTodo(id)
    return { ok }
  })

  // ── Logs ────────────────────────────────────────────────────────────
  ipcMain.handle('logs:list', (_event, filter?) => {
    return logsService.listLogs(filter)
  })

  /** 反向索引：任务详情面板展示该任务的关联日志 */
  ipcMain.handle('logs:forTask', (_event, taskId: string) => {
    return logsService.logsForTask(taskId)
  })

  ipcMain.handle('logs:get', (_event, id: string) => {
    return logsService.getLog(id)
  })

  ipcMain.handle('logs:create', (_event, title: string, project: string, content: string, taskId?: string) => {
    try {
      const log = logsService.createLog(title, project, content, taskId)
      return { ok: true, log }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('logs:update', (_event, id: string, updates: any) => {
    try {
      const log = logsService.updateLog(id, updates)
      return { ok: !!log, log }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('logs:complete', (_event, id: string, retainDays: number | null, note?: string) => {
    try {
      const log = logsService.completeLog(id, retainDays, note)
      return { ok: !!log, log }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('logs:archive', (_event, id: string, note?: string) => {
    try {
      const log = logsService.archiveLog(id, note)
      return { ok: !!log, log }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('logs:destroy', (_event, id: string) => {
    const ok = logsService.destroyLog(id)
    return { ok }
  })

  ipcMain.handle('logs:search', (_event, query: string) => {
    return logsService.searchLogs(query)
  })

  ipcMain.handle('logs:inject', (_event, id: string) => {
    return logsService.injectLog(id)
  })

  ipcMain.handle('logs:cleanup', () => {
    return logsService.cleanupLogs()
  })

  // ── Dispatch ────────────────────────────────────────────────────────
  ipcMain.handle('dispatch:preview', (_event: any, id: string) => {
    try {
      const task = tasks.readTask(id)
      if (!task) return { ok: false, error: '任务不存在' }
      const prompt = buildDispatchPrompt(task)
      return { ok: true, prompt, status: task.fm.status }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('dispatch:execute', (_event: any, id: string) => {
    try {
      const result = executeDispatch(id)
      return result
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  // ── Review ──────────────────────────────────────────────────────────
  ipcMain.handle('review:accept', (_event: any, id: string) => {
    try {
      const result = reviewTask(id, 'accept')
      return result
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('review:reject', (_event: any, id: string, reason: string) => {
    try {
      const result = reviewTask(id, 'reject', reason)
      return result
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  // ── File open (path whitelist) ─────────────────────────────────────
  ipcMain.handle('openFile', (_event: any, filePath: string) => {
    return validateAndOpenFile(filePath)
  })
}

// ── Dispatch helpers ─────────────────────────────────────────────────────

function buildDispatchPrompt(task: any): string {
  const title = task.fm.title || task.id
  const project = task.fm.project || '未归属'
  const body = task.body || ''
  return [
    `执行方寸任务 ${task.id}：${title}`,
    `项目：${project}`,
    `任务卡：${task.path}`,
    '## 任务正文',
    body,
  ].join('\n')
}

function executeDispatch(id: string): { ok: boolean; error?: string; command?: string } {
  const task = tasks.readTask(id)
  if (!task) return { ok: false, error: '任务不存在' }
  if (task.fm.status === '完成' || task.fm.status === '驳回') {
    return { ok: false, error: '任务已终态，不派活' }
  }
  if (task.fm.status === '进行中') {
    return { ok: false, error: '任务已在进行中（重复派活风险），请先完成或等待当前执行结束' }
  }
  // Check blockers
  if (task.fm.blockers && task.fm.blockers.length > 0) {
    return { ok: false, error: `被阻塞：前置任务 ${task.fm.blockers.join(', ')} 未完成` }
  }
  // Move to 进行中
  tasks.moveStatus(id, '进行中')
  const prompt = buildDispatchPrompt(task)
  return { ok: true, command: prompt }
}

function reviewTask(id: string, verdict: 'accept' | 'reject', reason?: string): { ok: boolean; error?: string } {
  const task = tasks.readTask(id)
  if (!task) return { ok: false, error: '任务不存在' }
  if (task.fm.status !== '待验收') {
    return { ok: false, error: `当前状态为「${task.fm.status || '未知'}」，仅「待验收」可验收` }
  }
  if (verdict === 'accept') {
    tasks.moveStatus(id, '完成')
    return { ok: true }
  } else {
    if (!reason || !reason.trim()) {
      return { ok: false, error: '驳回理由必填（写入结果记录，留痕可追溯）' }
    }
    tasks.moveStatus(id, '驳回')
    // Append rejection reason to result log
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 16)
    const logLine = `[${ts}] 验收驳回：${reason}`
    const prevLog = (task.fm as any).result_log || ''
    ;(task.fm as any).result_log = (prevLog + '\n' + logLine).trim()
    tasks.updateTask(id, { result_log: (task.fm as any).result_log } as any)
    return { ok: true }
  }
}

function validateAndOpenFile(filePath: string): { ok: boolean; error?: string } {
  const raw = String(filePath || '').trim().replace(/^["']|["']$/g, '')
  if (!raw) return { ok: false, error: '路径为空' }
  // Simple existence check for now
  if (!fs.existsSync(raw)) return { ok: false, error: `路径不存在: ${raw}` }
  try {
    const { execFileSync } = require('child_process')
    if (fs.statSync(raw).isDirectory()) {
      execFileSync('explorer', [raw])
    } else {
      execFileSync('cmd', ['/c', 'start', '', raw])
    }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: `打开失败: ${e.message}` }
  }
}
