/**
 * Fangcun Desktop — IPC Bridge
 * Connects renderer (Vue) to main process (data layer)
 */

import { ipcMain, app, dialog, shell, BrowserWindow, clipboard } from 'electron'
import * as data from './data'
import * as tasks from './data/tasks'
import * as services from './services'
import * as todosService from './services/todos'
import * as logsService from './services/logs'
import * as notificationsService from './services/notifications'
import * as notifierService from './services/notifier'
import * as path from 'path'
import * as fs from 'fs'
import { registerLlmIpcHandlers } from './llm-ipc'
import { runBackup } from './backup'
import * as launchpad from './launchpad'
import * as policies from './services/policies'
import * as prefs from './services/prefs'
import * as appLog from './services/appLog'
import { checkSkillsStatus, installSkills, installSkillsTo, autoCheckSkills, listSkillsForUi, openSkillsDir, getHermesSkillsDirPath, resolveRevealTarget } from './services/skillInstaller'
import { importSkillFromPath, listImportedSkills, pickSkillFile, pickSkillFolder, removeImportedSkill } from './services/skillImport'
import { listServices, addManualService, removeManualService, openService, adoptUnregistered, startService } from './services/portRegistry'
import { detectAgentTargets } from './services/agents'
import { listMcpEntries, detectMcpTargets, buildMcpSnippet, buildSelfInstallPrompt } from './services/mcpConnect'
import type { McpEntryId } from './services/mcpConnect'
import { guardedHandle } from './guarded-ipc'

export function registerIpcHandlers(): void {
  // Initialize paths
  data.initPaths()
  
  // Register LLM handlers
  registerLlmIpcHandlers()

  // ── Startup self-check ────────────────────────────────────────────
  guardedHandle('selfCheck', () => {
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

  guardedHandle('loadTasks', (_event, view = 'active') => {
    return data.loadTasks(view).map(flattenTask)
  })

  // 解析失败的任务文件：以前是静默跳过（任务"人间蒸发"），现在交给界面显性提示
  guardedHandle('parseErrors', () => data.getParseErrors())

  guardedHandle('getTask', (_event, id: string) => {
    const task = tasks.readTask(id)
    return task ? flattenTask(task) : null
  })

  guardedHandle('newTask', (_event, fields: tasks.NewTaskFields) => {
    const task = tasks.createTask(fields)
    return { ok: true, id: task.id }
  })

  guardedHandle('editTask', (_event, id: string, fields: any) => {
    const task = tasks.updateTask(id, fields)
    return { ok: !!task, id }
  })

  guardedHandle('moveStatus', (_event, id: string, status: string) => {
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

  guardedHandle('deleteTask', (_event, id: string) => {
    return tasks.deleteTask(id)
  })

  guardedHandle('archiveTask', (_event, id: string) => {
    const task = tasks.archiveTask(id)
    return { ok: !!task, id }
  })

  guardedHandle('unarchiveTask', (_event, id: string) => {
    const task = tasks.unarchiveTask(id)
    return { ok: !!task, id }
  })

  // ── 已完成任务自动归档（2026-10-03 卡 task-20261003-012）────────────
  // 仿日志清理：设置保留天数（0 = 关闭），列出「已超期」的那批 + 一键归档。
  // 归档动作仍走既有 archiveTask（移动文件 + 失效缓存 + 记活动日志），且**逐条可追溯**。
  guardedHandle('tasks:overdue', (_event, days: number) => {
    const d = Number(days)
    if (!Number.isFinite(d) || d <= 0) return { ok: true, count: 0, items: [], days: d }
    const list = tasks.listOverdueCompleted(d)
    return {
      ok: true,
      days: d,
      count: list.length,
      items: list.map(t => ({
        id: t.id,
        title: String((t.fm as any)?.title ?? ''),
        updated: String((t.fm as any)?.updated ?? ''),
      })),
    }
  })

  guardedHandle('tasks:archiveOverdue', (_event, days: number) => {
    const d = Number(days)
    if (!Number.isFinite(d) || d <= 0) {
      return { ok: false, archived: [], failed: [], message: '保留天数为 0（功能关闭），不执行归档' }
    }
    const r = tasks.archiveOverdueCompleted(d)
    return { ok: true, ...r }
  })

  // ── 回收站（2026-09-26 卡 034）─────────────────────────────────────
  // 按**文件名**操作，不按 id：回收站里同一 id 可能有多份历史副本，用户要还原的是"那一份"。
  guardedHandle('trash:list', () => {
    return { ok: true, items: tasks.listTrash() }
  })

  guardedHandle('trash:restore', (_event, name: string) => {
    return tasks.restoreTrashItem(name)
  })

  guardedHandle('trash:purge', (_event, name: string) => {
    return tasks.purgeTrashItem(name)
  })

  // ── Projects ──────────────────────────────────────────────────────
  guardedHandle('loadProjects', () => {
    return data.parseRegistry()
  })

  guardedHandle('scanProjectStatus', () => {
    return tasks.scanProjectStatus()
  })

  guardedHandle('findBlockers', () => {
    // 2026-09-23：getBlockerChains() 现在返回 BlockerSource[]，用 blockedTasks 替代旧 blockers
    return tasks.getBlockerChains().map(c => ({ id: c.id, title: c.title, blockers: (c as any).blockedTasks?.map((t: any) => t.id) || [] }))
  })

  // ── Plan System ─────────────────────────────────────────────────────
  guardedHandle('createPlan', (_event, fields: any) => {
    try {
      const result = tasks.createPlan(fields)
      return { ok: true, id: result.id }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  guardedHandle('listPlans', () => {
    return tasks.listPlans()
  })

  guardedHandle('getPlan', (_event, id: string) => {
    return tasks.getPlan(id)
  })

  guardedHandle('decidePlanPoint', (_event, id: string, dpId: string, choice: string) => {
    return tasks.decidePlanPoint(id, dpId, choice)
  })

  // ── Timeout + Progress ──────────────────────────────────────────────
  guardedHandle('findTimeoutTasks', (_event, threshold?: number) => {
    return tasks.findTimeoutTasks(threshold)
  })

  guardedHandle('getProjectProgress', (_event, projectId: string) => {
    return tasks.getProjectProgress(projectId)
  })

  // 一次扫描出全部项目进度：前端原先逐项目调用 = 项目数 × 全量扫描
  guardedHandle('allProjectProgress', () => {
    return tasks.getAllProjectProgress()
  })

  // ── Batch Ops ──────────────────────────────────────────────────────
  guardedHandle('batchEdit', (_event, ids: string[], fields: any) => {
    return tasks.batchEdit(ids, fields)
  })

  guardedHandle('batchArchive', (_event, ids: string[]) => {
    return tasks.batchArchive(ids)
  })

  guardedHandle('batchDelete', (_event, ids: string[]) => {
    return tasks.batchDelete(ids)
  })

  // ── Quick Add ───────────────────────────────────────────────────────
  guardedHandle('quickAdd', (_event, text: string) => {
    return tasks.quickAdd(text)
  })

  // ── Natural Query ───────────────────────────────────────────────────
  // ── Task metadata（新建/编辑表单的唯一字段来源） ────────────────────
  guardedHandle('taskFieldSpecs', () => data.TASK_FIELD_SPECS)

  guardedHandle('taskEnums', () => ({
    statuses: data.STATUSES,
    priorities: data.PRIORITIES,
  }))

  /** 取某任务的表单值（数组字段转逗号串）。id 为 null 时返回空表单。 */
  guardedHandle('taskFormValues', (_event, id: string | null) => {
    const task = id ? tasks.readTask(id) : null
    return data.taskToFormValues(task)
  })

  guardedHandle('naturalQuery', (_event, q: string, opts?: { includeArchive?: boolean }) => {
    return tasks.parseNaturalQuery(q, opts || {})
  })

  // ── Registry ──────────────────────────────────────────────────────
  // 原 regSave 是 `return { ok: true }` 的空实现：前端拿到成功、实际什么都没写，
  // 属于「假成功」，已移除。新建项目改走 registry:addProject（真写入 + 写前自校验）。
  guardedHandle('registry:addProject', (_event, fields: data.NewProjectFields) => {
    try {
      return data.addProjectToRegistry(fields || { id: '' })
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ── First run setup ───────────────────────────────────────────────
  guardedHandle('isFirstRun', () => {
    return data.isFirstRun()
  })

  guardedHandle('createFreshSetup', (_event, targetDir: string) => {
    try {
      data.createFreshSetup(targetDir)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  guardedHandle('importFromPythonTegula', (_event, targetDir: string, pythonDir: string) => {
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
  guardedHandle('browseDirectory', async (event) => {
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

  guardedHandle('browseFile', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        title: '选择程序',
        properties: ['openFile' as const],
        filters: [
          // 启动台支持的类型（2026-09-22）：bat/cmd 经 cmd.exe、ps1 经 powershell、
          // lnk 交系统 ShellExecute —— 示例配置里就有三个 .bat，此前选不到也跑不起来。
          { name: '可执行 / 脚本 / 快捷方式', extensions: ['exe', 'bat', 'cmd', 'ps1', 'lnk', 'com'] },
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
  guardedHandle('loadActivity', (_event, limit = 50) => {
    return data.readActivity(limit)
  })

  // ── Data directory info ───────────────────────────────────────────
  guardedHandle('getDataDir', () => {
    return data.getDataDir()
  })

  guardedHandle('setDataDir', (_event, newDir: string) => {
    try {
      data.setDataDir(newDir)
      return { ok: true, dir: data.getDataDir() }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  /** 数据目录体检（只读）：判断目标能否迁入、里面已有多少数据 */
  guardedHandle('data:inspect', (_event, dir: string) => {
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
  guardedHandle('data:migrate', async (
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
  guardedHandle('notesForTask', (_event, taskId: string) => {
    return services.getNotesForTask(taskId)
  })

  guardedHandle('createNote', (_event, note: any) => {
    try {
      const result = services.createNote(note.title || '', note.content || '', note.taskId)
      return { ok: true, note: result }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  guardedHandle('updateNote', (_event, noteId: string, updates: any) => {
    try {
      const result = services.updateNote(noteId, updates)
      return { ok: !!result, note: result }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  guardedHandle('listNotes', () => {
    return services.listNotes()
  })

  guardedHandle('deleteNote', (_event, noteId: string) => {
    const ok = services.deleteNote(noteId)
    return { ok }
  })

  guardedHandle('importNoteFromFile', (_event, filePath: string, taskId?: string) => {
    try {
      const note = services.importNoteFromFile(filePath, taskId)
      return { ok: !!note, note }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  guardedHandle('attachNote', (_event, noteId: string, taskId: string) => {
    const ok = services.attachNote(noteId, taskId)
    return { ok }
  })

  guardedHandle('detachNote', (_event, noteId: string) => {
    const ok = services.detachNote(noteId)
    return { ok }
  })

  // ── Blocker chains ─────────────────────────────────────────────────
  guardedHandle('getBlockerChains', () => {
    return tasks.getBlockerChains()
  })

  // ── Notes Import/Export ────────────────────────────────────────────
  guardedHandle('exportNotes', () => {
    return tasks.exportNotes()
  })

  guardedHandle('importNotes', (_event, data: any[]) => {
    return tasks.importNotes(data)
  })

  // ── Task Import/Export ────────────────────────────────────────────
  guardedHandle('exportTasks', () => {
    return tasks.exportTasks()
  })

  guardedHandle('importTasks', (_event, data: any[]) => {
    return tasks.importTasks(data)
  })

  // ── Roadmap + Suggestions ─────────────────────────────────────────
  guardedHandle('aggregateRoadmap', (_event, projectId?: string) => {
    return tasks.aggregateRoadmap(projectId)
  })

  guardedHandle('suggestActions', (_event, projectId: string) => {
    return tasks.suggestActions(projectId)
  })

  guardedHandle('suggestCrossProject', () => {
    return tasks.suggestCrossProject()
  })

  guardedHandle('copyTask', (_event, id: string) => {
    return tasks.copyTask(id)
  })

  guardedHandle('getRoadmapTrend', (_event, days?: number) => {
    return tasks.getRoadmapTrend(days)
  })

  guardedHandle('detectParallelOpportunities', () => {
    return tasks.detectParallelOpportunities()
  })

  guardedHandle('suggestMilestones', () => {
    return tasks.suggestMilestones()
  })

  guardedHandle('detectEvents', (_event, eventType: string) => {
    return tasks.detectEvents(eventType)
  })

  // ── Notifications（通知中心） ─────────────────────────────────────
  guardedHandle('notifications:list', (_event, filter?: { unreadOnly?: boolean }) => {
    return notificationsService.listNotifications(filter)
  })

  guardedHandle('notifications:unreadCount', () => {
    return notificationsService.getUnreadCount()
  })

  guardedHandle('notifications:markRead', (_event, id: string) => {
    return notificationsService.markRead(id)
  })

  guardedHandle('notifications:markAllRead', () => {
    return notificationsService.markAllRead()
  })

  guardedHandle('notifications:delete', (_event, id: string) => {
    return notificationsService.deleteNotification(id)
  })

  guardedHandle('notifications:clear', () => {
    return notificationsService.clearAll()
  })

  guardedHandle('notifications:scan', () => {
    return notifierService.scanOnce()
  })

  // ── 2026-10-01 P0-4：扫描器状态可见 ────────────────────────────────
  // 此前 getScannerStatus() 没有通道：「扫描器停摆」与「扫不到事件」在界面上长得
  // 一模一样，用户只能得出通知中心是坏的。面板页脚显示「上次扫描 / 运行中」。
  guardedHandle('notifications:scannerStatus', () => {
    return notifierService.getScannerStatus()
  })

  // ── 2026-10-01 P0-5：被静音的提醒要看得见、能恢复 ──────────────────────
  // 删过一条通知 = 静音（7 天 TTL）。此前 listMuted/unmuteAll 三个文件里零命中：
  // 点过 🗑 的提醒在 7 天内彻底消失且用户不知情。
  guardedHandle('notifications:listMuted', () => {
    return notificationsService.listMuted()
  })

  guardedHandle('notifications:unmuteAll', () => {
    return notificationsService.unmuteAll()
  })

  guardedHandle('cronCheck', () => {
    return tasks.cronCheck()
  })

  // ── Services / Workbench ──────────────────────────────────────────
  guardedHandle('scanServices', () => {
    return services.scanServices()
  })

  // ── Launchpad ─────────────────────────────────────────────────────
  // ── Policies（方针区）──────────────────────────────────────────────
  guardedHandle('policy:get', (_event, projectId: string) => {
    try { return { ok: true, policy: policies.getPolicy(projectId) } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  guardedHandle('policy:save', (_event, p: any) => {
    try { return policies.savePolicy(p) }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  guardedHandle('policy:text', (_event, projectId: string) => {
    try {
      const p = policies.getPolicy(projectId)
      return p ? { ok: true, text: policies.policyToText(p) } : { ok: false, error: '方针卡不存在' }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

  guardedHandle('launchpad:loadApps', () => {
    return launchpad.loadApps()
  })

  guardedHandle('launchpad:addApp', (_event, app: any) => {
    return launchpad.addApp(app)
  })

  guardedHandle('launchpad:updateApp', (_event, id: string, updates: any) => {
    return launchpad.updateApp(id, updates)
  })

  guardedHandle('launchpad:removeApp', (_event, id: string) => {
    return launchpad.removeApp(id)
  })

  guardedHandle('launchpad:launchApp', async (_event, appConfig: any) => {
    // 这一层兜住执行器的抛出：抛出去只会让渲染层拿到一个没有信息的 rejected promise，
    // 用户看到的是"点了没反应"。改成返回 {ok:false,message} —— 至少界面上有一句话。
    try {
      return await launchpad.launchApp(appConfig)
    } catch (e: any) {
      appLog.error('launchpad', '启动通道异常', e?.stack || e)
      return { ok: false, message: `启动失败: ${e?.message || e}` }
    }
  })

  guardedHandle('launchpad:openFolder', (_event, folderPath: string) => {
    return launchpad.openFolder(folderPath)
  })

  guardedHandle('launchpad:openUrl', (_event, url: string) => {
    return launchpad.openUrl(url)
  })

  guardedHandle('launchpad:getConfigPath', () => {
    return launchpad.getAppConfigPath()
  })

  // ── Todos ──────────────────────────────────────────────────────────
  guardedHandle('todos:list', (_event, filter?) => {
    return todosService.listTodos(filter)
  })

  guardedHandle('todos:create', (_event: any, title: string, priority?: string, due?: string, project?: string) => {
    try {
      const todo = todosService.createTodo(title, priority as any, due, project)
      return { ok: true, todo }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  guardedHandle('todos:update', (_event: any, id: string, updates: any) => {
    try {
      const todo = todosService.updateTodo(id, updates)
      return { ok: !!todo, todo }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  guardedHandle('todos:toggle', (_event: any, id: string) => {
    const todo = todosService.toggleTodo(id)
    return { ok: !!todo, todo }
  })

  guardedHandle('todos:delete', (_event: any, id: string) => {
    const ok = todosService.deleteTodo(id)
    return { ok }
  })

  // 待办数据健康度（2026-09-26 卡 033）：坏文件被隔离后要让界面看得见，
  // 否则用户只会看到"待办空了"而不知道发生过什么。
  guardedHandle('todos:health', () => {
    return todosService.todosHealth()
  })

  // ── Logs ────────────────────────────────────────────────────────────
  // 卡 037 右键菜单：置顶与改归属都不受「非 active 不可编辑」守卫限制（视图/归类属性）
  guardedHandle('logs:setPinned', (_event, id: string, pinned: boolean) => {
    return logsService.setLogPinned(String(id || ''), !!pinned)
  })
  guardedHandle('logs:setProject', (_event, id: string, project: string) => {
    return logsService.setLogProject(String(id || ''), String(project || ''))
  })
  guardedHandle('todos:setPinned', (_event, id: string, pinned: boolean) => {
    const t = todosService.setTodoPinned(String(id || ''), !!pinned)
    return t ? { ok: true, data: t } : { ok: false, error: '待办不存在' }
  })

  guardedHandle('logs:list', (_event, filter?) => {
    return logsService.listLogs(filter)
  })

  /** 反向索引：任务详情面板展示该任务的关联日志 */
  guardedHandle('logs:forTask', (_event, taskId: string) => {
    return logsService.logsForTask(taskId)
  })

  guardedHandle('logs:get', (_event, id: string) => {
    return logsService.getLog(id)
  })

  guardedHandle('logs:create', (_event, title: string, project: string, content: string, taskId?: string, extra?: { sessionId?: string; agentName?: string; prevAgentName?: string; logDate?: string; taskIds?: string[]; nextSteps?: string; continueFrom?: string }) => {
    return logsService.createLog(title, project, content, taskId, extra)
  })

  guardedHandle('logs:update', (_event, id: string, updates: any) => {
    return logsService.updateLog(id, updates)
  })

  guardedHandle('logs:complete', (_event, id: string, retainDays: number | null, note?: string) => {
    return logsService.completeLog(id, retainDays, note)
  })

  guardedHandle('logs:archive', (_event, id: string, note?: string) => {
    return logsService.archiveLog(id, note)
  })

  // 2026-09-28 用户第 2 条：「进行中」只能手动开关，且可撤销。
  // 这是 running 的**唯一写入路径**（创建/完成/归档只会关掉它）。
  guardedHandle('logs:setRunning', (_event, id: string, running: boolean) => {
    return logsService.setLogRunning(String(id || ''), !!running)
  })

  // 撤销完成 / 撤销归档，退回「待处理」。**不等于「进行中」** —— 要不要进行中由用户另外开。
  guardedHandle('logs:reopen', (_event, id: string) => {
    return logsService.reopenLog(id)
  })

  guardedHandle('logs:destroy', (_event, id: string) => {
    return logsService.destroyLog(id)
  })

  guardedHandle('logs:inject', (_event, id: string) => {
    return logsService.injectLog(id)
  })

  // ── 附件（2026-10-01 用户第 1 条 → 卡 036）：日志 ↔ 文件的唯一入口 ──────
  // 选文件在这里做（要用 BrowserWindow 的模态对话框），复制/挂载逻辑全在 logs.ts，
  // 渲染层只管拿到更新后的 entry。文件**复制**进数据目录，源文件不动。
  guardedHandle('logs:attachFiles', async (_event, logId: string) => {
    const opts: Electron.OpenDialogOptions = {
      title: '选择要关联到这条日志的文件（截图 / 分析报告）',
      properties: ['openFile', 'multiSelections'],
    }
    const win = BrowserWindow.getFocusedWindow()
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (picked.canceled || !picked.filePaths.length) return { ok: false, error: 'canceled' }
    const r = logsService.addAttachments(String(logId || ''), picked.filePaths)
    if (r.ok) appLog.info('logs', `日志 ${logId} 新增附件 ${picked.filePaths.length} 个`)
    return r
  })

  // 解除关联（文件留在磁盘上，见 detachAttachment 注释）
  guardedHandle('logs:detachAttachment', (_event, logId: string, rel: string) =>
    logsService.detachAttachment(String(logId || ''), String(rel || '')))

  // 预览用 data URL；超大文件由 logs.ts 返回 tooLarge，界面改给「用系统程序打开」
  guardedHandle('logs:attachmentData', (_event, rel: string) =>
    logsService.readAttachmentData(String(rel || '')))

  guardedHandle('logs:openAttachment', async (_event, rel: string) => {
    const abs = logsService.resolveAttachment(String(rel || ''))
    if (!abs) return { ok: false, error: '附件不存在（或路径不在数据目录内，已拒绝）' }
    try {
      const err = await shell.openPath(abs)
      return err ? { ok: false, error: err } : { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('logs:cleanup', () => {
    return logsService.cleanupLogs()
  })

  // ── 剪贴板 ──────────────────────────────────────────────────────────
  // 渲染层的 navigator.clipboard 在打包版(file://)或被拒时会**静默失败**：剪贴板里仍留着
  // 上一次的内容，用户以为复制成功（2026-09-25「日志复制失败，粘出来是旧的 0924 内容」的真因）。
  // 主进程的 clipboard 模块不受起源/焦点限制，渲染层统一优先走这条通道。
  guardedHandle('clipboard:writeText', (_event, text: string) => {
    try {
      clipboard.writeText(String(text ?? ''))
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  // ── UI 偏好 ─────────────────────────────────────────────────────────
  // 014：Agent 预设等用户资产以前只存 localStorage，而 localStorage 绑定 origin
  //（dev 的 localhost→127.0.0.1、打包版 file://）——换 origin 就清空。真身移到主进程 prefs.json。
  guardedHandle('prefs:get', () => prefs.getPrefs())
  guardedHandle('prefs:set', (_event, key: string, value: unknown) => prefs.setPref(key, value))

  // ── Dispatch ────────────────────────────────────────────────────────
  guardedHandle('dispatch:preview', (_event: any, id: string) => {
    try {
      const task = tasks.readTask(id)
      if (!task) return { ok: false, error: '任务不存在' }
      const prompt = buildDispatchPrompt(task)
      return { ok: true, prompt, status: task.fm.status }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  guardedHandle('dispatch:execute', (_event: any, id: string) => {
    try {
      const result = executeDispatch(id)
      return result
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  // ── Review ──────────────────────────────────────────────────────────
  guardedHandle('review:accept', (_event: any, id: string, reason?: string) => {
    try {
      const result = reviewTask(id, 'accept', reason)
      return result
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  guardedHandle('review:reject', (_event: any, id: string, reason: string) => {
    try {
      const result = reviewTask(id, 'reject', reason)
      return result
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  // ── File open (path whitelist) ─────────────────────────────────────
  guardedHandle('openFile', (_event: any, filePath: string) => {
    return validateAndOpenFile(filePath)
  })

  // ── 应用日志（诊断）────────────────────────────────────────────────
  // 之前任何失败都查不到原因（用户第 8 条）。这里把主进程日志目录、
  // 尾部内容与「打开日志目录」暴露给界面，并在渲染层出错时由前端主动回报。
  //
  // ⚠ 2026-09-22 事故：这段曾误缩进进 reviewTask() 函数体内、位于 return 之后，
  //   成了不可达死代码 —— 通道从未注册，界面上"运行中的主进程是旧代码"横幅
  //   常驻（实际是 0.2.2 出厂就缺通道，不是旧进程）。IPC 注册语句必须落在
  //   registerIpcHandlers() 的函数体顶层，e2e 已加注册断言守住（e2e-applog.cjs）。
  guardedHandle('applog:write', (_e: any, level: string, scope: string, message: string, detail?: unknown) => {
    const lv = (level === 'ERROR' || level === 'WARN' ? level : 'INFO') as 'INFO' | 'WARN' | 'ERROR'
    appLog.append(lv, 'renderer:' + (scope || 'unknown'), String(message ?? ''), detail)
    return { ok: true }
  })

  guardedHandle('applog:path', () => appLog.getLogFile())
  guardedHandle('applog:dir', () => appLog.getLogDir())
  guardedHandle('applog:tail', (_e: any, lines?: number) => appLog.tail(lines && lines > 0 ? lines : 300))
  guardedHandle('applog:openDir', async () => {
    const dir = appLog.getLogDir()
    try {
      const err = await shell.openPath(dir)
      if (err) {
        appLog.warn('applog', `打开日志目录失败：${dir}`, err)
        // 把路径一起带回渲染层：界面上的"失败"否则完全无法定位
        return { ok: false, error: err, dir }
      }
      return { ok: true, dir }
    } catch (e: any) {
      appLog.error('applog', `打开日志目录异常：${dir}`, e?.stack || e)
      return { ok: false, error: e?.message || String(e), dir }
    }
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
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 16)
  if (verdict === 'accept') {
    tasks.moveStatus(id, '完成')
    // 2026-09-25（用户第 7 条）：通过同样写结果记录 —— 此前只有驳回留痕，
    // 「通过」这件事在卡上完全无迹可查（用户原话：验收裁决只能填驳回理由，那通过呢？）
    const note = (reason || '').trim()
    const line = note ? `[${ts}] 验收通过：${note}` : `[${ts}] 验收通过`
    const prev = String((task.fm as any).result_log || '')
    tasks.updateTask(id, { result_log: (prev + '\n' + line).trim() } as any)
    return { ok: true }
  } else {
    if (!reason || !reason.trim()) {
      return { ok: false, error: '驳回理由必填（写入结果记录，留痕可追溯）' }
    }
    tasks.moveStatus(id, '驳回')
    // Append rejection reason to result log
    const logLine = `[${ts}] 验收驳回：${reason}`
    const prevLog = (task.fm as any).result_log || ''
    ;(task.fm as any).result_log = (prevLog + '\n' + logLine).trim()
    tasks.updateTask(id, { result_log: (task.fm as any).result_log } as any)
    return { ok: true }
  }
}


  guardedHandle('skills:check', () => {
    return checkSkillsStatus()
  })

  guardedHandle('skills:install', () => {
    return installSkills()
  })

  // 装到指定可直装目标（卡 task-20261003-011）：'hermes' | 'dsh'。
  // 未知目标由 installSkillsTo 显式报错返回，不静默当 Hermes 处理。
  guardedHandle('skills:installTo', (_event, targetId: string) => {
    return installSkillsTo(String(targetId || 'hermes'))
  })

  // 技能安装专区（2026-09-26 卡 038）：面板数据源 + 打开目录
  // 此前 skills:check / skills:install 已存在，但渲染层从来没有入口 —— 功能在、界面不在。
  guardedHandle('skills:list', () => {
    return listSkillsForUi()
  })

  guardedHandle('skills:openDir', (_event, which: string) => {
    return openSkillsDir(which)
  })

  // ── 技能直接导入（2026-09-26 卡 005，用户参照 WorkBuddy）──────────────
  // 三件事：列出「外部导入」的技能 / 选包（文件或文件夹）+ 导入 / 移除。
  // 导入逻辑全在主进程（解压、校验、落位、防穿越），渲染层只传路径与一个"要不要覆盖"的布尔。
  guardedHandle('skills:imported', () => {
    return { ok: true, items: listImportedSkills() }
  })

  guardedHandle('skills:importPick', (_event, kind: string) => {
    return kind === 'folder' ? pickSkillFolder() : pickSkillFile()
  })

  guardedHandle('skills:import', (_event, srcPath: string, opts?: { overwrite?: boolean }) => {
    return importSkillFromPath(String(srcPath || ''), { overwrite: !!opts?.overwrite })
  })

  guardedHandle('skills:remove', (_event, name: string) => {
    return removeImportedSkill(String(name || ''))
  })

  // ── 服务 / 端口（2026-09-26 卡 006）────────────────────────────────
  // 用户选 A 档：只读监控 + 冲突预警。这里**没有**"结束占用进程"的通道，别顺手加。
  // 回收站卡片预览（2026-09-26：用户说卡片是"死卡"，得能先看内容再决定）
  guardedHandle('trash:read', (_event, name: string) => {
    return tasks.readTrashItem(String(name || ''))
  })

  // 装到别的 agent：目标检测 + 打开对方（只允许打开**检测到的那份清单**里的路径）
  guardedHandle('agents:list', () => {
    return detectAgentTargets(getHermesSkillsDirPath())
  })
  guardedHandle('agents:open', async (_event, id: string) => {
    const target = detectAgentTargets(getHermesSkillsDirPath()).find(t => t.id === String(id) && t.detected)
    if (!target || !target.openPath) return { ok: false, message: `检测不到这个 agent（${id}）` }
    if (target.mode === 'installable' && target.skillsDir) {
      shell.openPath(target.skillsDir)
      return { ok: true, message: `已打开 ${target.skillsDir}` }
    }
    const err = await shell.openPath(target.openPath)
    return err ? { ok: false, message: err } : { ok: true, message: `已打开 ${target.name}` }
  })

  // ── MCP 接入材料（2026-10-02 卡 002 · A 路线：只出材料 + 打开文件，不写入）──
  guardedHandle('mcp:info', () => {
    return { ok: true, entries: listMcpEntries(), targets: detectMcpTargets() }
  })
  guardedHandle('mcp:snippet', (_event, targetId: string, entryId: string) => {
    return buildMcpSnippet(String(targetId || ''), String(entryId || '') as McpEntryId)
  })
  // 打开目标配置文件：只允许打开 detectMcpTargets() 实测存在的 configPath（不猜、不建）
  guardedHandle('mcp:selfInstall', (_event, targetId: string, entryId: string) => {
    return buildSelfInstallPrompt(targetId, entryId as McpEntryId)
  })
  guardedHandle('mcp:openConfig', async (_event, targetId: string) => {
    const t = detectMcpTargets().find(x => x.id === String(targetId))
    if (!t) return { ok: false, message: `未知目标（${targetId}）` }
    if (!t.configPath) return { ok: false, message: `${t.name} 的配置文件本机未检测到，方寸不代建 —— 先按上面的步骤新建` }
    const err = await shell.openPath(t.configPath)
    return err ? { ok: false, message: err } : { ok: true, message: `已打开 ${t.configPath}` }
  })

  // 在资源管理器里显示某个技能的 SKILL.md（给 WorkBuddy 这类只能手动导入的 agent 用）
  // 路径裁决（白名单两个根）抽成纯函数 `resolveRevealTarget` —— e2e-skills 直接断言它。
  guardedHandle('skills:reveal', (_event, dirOrFile: string) => {
    const t = resolveRevealTarget(String(dirOrFile || ''))
    if (!t.ok || !t.skillMd) return { ok: false, message: t.message }
    try {
      shell.showItemInFolder(t.skillMd)
      return { ok: true, message: t.message }
    } catch (e: any) {
      return { ok: false, message: `显示失败：${e?.message || e}` }
    }
  })

  guardedHandle('services:start', (_event, port: number) => startService(Number(port)))

  guardedHandle('services:list', () => {
    return listServices()
  })

  guardedHandle('services:add', (_event, svc: { name: string; port: number; note?: string; project?: string }) => {
    return addManualService({
      name: String(svc?.name || ''),
      port: Number(svc?.port),
      note: svc?.note == null ? '' : String(svc.note),
      project: svc?.project == null ? '' : String(svc.project),
    })
  })

  guardedHandle('services:remove', (_event, port: number) => {
    return removeManualService(Number(port))
  })

  guardedHandle('services:open', (_event, port: number) => {
    return openService(Number(port))
  })

  guardedHandle('services:adopt', (_event, port: number, name?: string) => {
    return adoptUnregistered(Number(port), name == null ? undefined : String(name))
  })

  // 首次启动自动检测 skills
  autoCheckSkills()

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
