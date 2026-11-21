/**
 * Fangcun Desktop — IPC Bridge
 * Connects renderer (Vue) to main process (data layer)
 */

import { ipcMain, app, dialog, shell, BrowserWindow, clipboard } from 'electron'
import * as data from './data'
import * as tasks from './data/tasks'
// ⚠ `services` 通配导入已移除（2026-10-11）：它唯一的用处是 scanServices 的死通道，
//   那条通道删掉后这里就没有引用了。MCP 侧仍直接调 `services.scanServices()`。
import * as todosService from './services/todos'
import * as ideasService from './services/ideas'
import * as logsService from './services/logs'
// 记忆层（2026-11-17）：界面读口。写口暂不开 —— 原文逐字录入靠 agent 落盘，
// 界面上「新建记忆」会诱导随手写摘要，那正好破坏这条记忆的价值。
import * as memoryService from './services/memory'
import * as notificationsService from './services/notifications'
import * as notifierService from './services/notifier'
import * as path from 'path'
import * as fs from 'fs'
import { registerLlmIpcHandlers } from './llm-ipc'
import { registerLicenseIpcHandlers } from './license-ipc'
// 使命草稿（2026-11-14 · 长 Loop P1-2）：从项目 README 抽一句话当建议，人点头才写
import { draftMissionFromReadme } from '../shared/missionDraft'
import { registerDecisionIpcHandlers } from './decision-ipc'
import { registerQuestionnaireIpcHandlers } from './questionnaire-ipc'
import { runBackup } from './backup'
import * as launchpad from './launchpad'
import * as policies from './services/policies'
import { applySmapFromTask } from './services/smapApply'
import { getAutoStartStatus, setAutoStart } from './services/autoStart'
import * as tripBoard from './services/tripBoard'
import * as ask from './services/ask'
import * as correct from './services/correct'
import * as contextPack from './services/contextPack'
import { configureDispatchSecretDir, ensureDispatchSecret, resolveDispatchSecretPath } from './services/dispatchSign'
import * as brief from './services/brief'
import * as prefs from './services/prefs'
import * as projectTiers from './services/projectTiers'
import * as appLog from './services/appLog'
import * as gitLink from './services/gitLink'
import * as selfSync from './services/selfSync'
import * as repoDocs from './services/repoDocs'
import * as layerScan from './services/layerScan'
import * as competitors from './services/competitors'
import { checkSkillsStatus, installSkills, installSkillsTo, autoCheckSkills, getSkillSyncStatus, listSkillsForUi, openSkillsDir, getHermesSkillsDirPath, resolveRevealTarget } from './services/skillInstaller'
import { importSkillFromPath, listImportedSkills, pickSkillFile, pickSkillFolder, removeImportedSkill } from './services/skillImport'
import { listServices, addManualService, removeManualService, openService, adoptUnregistered } from './services/portRegistry'
import { detectAgentTargets } from './services/agents'
import { listMcpEntries, detectMcpTargets, buildMcpSnippet, buildSelfInstallPrompt } from './services/mcpConnect'
import type { McpEntryId } from './services/mcpConnect'
// 唯一一处“方寸写别人配置文件”的能力（只写 Hermes 的 config.yaml），见 hermesLink.ts 顶部四条纪律
import { linkHermesMcp } from './services/hermesLink'
import { detectDshPlugin } from './services/dshPlugin'
import { guardedHandle } from './guarded-ipc'
// 退出闸（2026-11-17 · 卡 p0-1）：「不同意并退出」要真退，必须置位与 close 钩子**同一个**状态
import { markQuitting } from './quitGate'
import { readSummary as readUsageSummary, taskToNeverReadInput } from './mcp/usage'
// MCP 写口闸 + 写侧留痕（2026-11-11 卡《MCP 写口无闸》）—— 设置页与清单都读这一层
import * as writeGate from './mcp/writeGate'
// 运行态识别（2026-11-11 卡 task-20261017-002）：客户端态 / 开发态必须一眼看得见
import { detectAppMode } from './services/appMode'
import { attachmentOpenPolicy } from '../shared/attachments'
import { resolveLinkPath } from '../shared/linkPath'
import { pickNeverRead } from '../shared/neverRead'
import { buildCleanupReport } from './services/cleanup'
import { checkMismatch } from './services/mismatch'
import { findArtifactForProject } from './services/projectDiagram'
import { archForProject, scanProject } from './services/projectArch'
// AI 生成图（2026-11-02）：模型画 → 证据审计 → 不过重画 → 仍不过降级扫描图
import { generateArchGraph } from './services/archAi'
import { buildArchGraph } from '../shared/archGraph'
import { renderArchHtml } from '../shared/archSvg'
import * as rice from './data/rice'

/**
 * 读一个仓库的 README（2026-11-14 · 长 Loop P1-2）。
 *
 * 只读**一个文件**，不 spawn git、不碰网络 —— 这是它和 `repoDocs.ts` 那套（要跑
 * `git log` 取最近动过 docs 的提交）的分界。起草使命只需要"这项目是什么"那句话。
 *
 * ⚠ 大小写四种都试：Windows 上 `README.MD` 很常见，而 Linux 上大小写敏感
 *   （`readme.md` 也存在）。不试全就报"没有 README"，那是冤枉。
 */
function readReadmeOf(repo: string): { md: string; sourceFile: string } | null {
  const dir = String(repo || '').trim()
  if (!dir) return null
  for (const name of ['README.md', 'Readme.md', 'readme.md', 'README.MD', 'README.markdown']) {
    try {
      const f = path.join(dir, name)
      if (fs.existsSync(f)) return { md: fs.readFileSync(f, 'utf-8'), sourceFile: name }
    } catch { /* 读不到就当没有，别因为一个坏文件炸掉整个 IPC */ }
  }
  return null
}

export function registerIpcHandlers(): void {
  // Initialize paths
  data.initPaths()

  // 派单签名密钥落点（2026-11-20）：只在 userData，不在数据根 ——
  // 插件按同一路径校验；agent 只写数据根时拿不到这把钥匙。
  try { configureDispatchSecretDir(app.getPath('userData')) } catch { /* 读不到就退回 APPDATA 探测 */ }
  
  // Register LLM handlers
  registerLlmIpcHandlers()
  // 许可协议闸（2026-11-18）：服务端记录 + 渲染层签字面
  registerLicenseIpcHandlers()
  // 决策卡（拍板记录，2026-10-12）——独立于 LLM 的本地 CRUD，与 Python CLI 同文件
  registerDecisionIpcHandlers()
  registerQuestionnaireIpcHandlers()

  // ── Startup self-check ────────────────────────────────────────────
  guardedHandle('selfCheck', () => {
    return data.startupSelfCheck()
  })

  // ── Tasks CRUD ────────────────────────────────────────────────────

  /**
   * Task → 渲染层视图对象。
   *
   * 用展开而不是手写字段列表：之前两处各写一份，都漏了 deadline/memo，
   * 直接后果是“截止日期筛选”永远拿不到值。新增字段不需要再来改这里。
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

  // ── 记忆层（2026-11-17）────────────────────────────────────────
  // 只读为主：检索 / 读原文 / 概览。写走 agent 落盘（见 services/memory.ts 顶部注释）。
  guardedHandle('memorySearch', (_event, q: any) => {
    // ⚠ 这里**不要** defer 成异步：MCP 分发器整体 async 过一次，
    //   所有工具返回 Promise → e2e-mcp-context 39 条全红（本仓踩过）。
    const r = memoryService.searchMemory(q || {})
    const ov = memoryService.memoryOverview()
    return { ...r, overview: ov }
  })
  guardedHandle('memoryRead', (_event, file: string) => memoryService.readMemory(file))
  guardedHandle('memoryOverview', () => memoryService.memoryOverview())
  // 索引是派生数据：源文件改了之后重算（界面上的"刷新"走这条）
  guardedHandle('memoryRebuild', () => memoryService.rebuildIndex())
  // ── 记忆写入（2026-11-18 暮雨：“记忆页必须开放写，不然出问题用户想改都改不了”）──
  // 三件事都**只碰 `memory/`**（与读同一道 realpath 闸），且都不进 task-data/（台账红线）。
  guardedHandle('memoryCreate', (_event, input: any) => {
    const r = memoryService.createMemory(input || {})
    // 写完重建索引：索引是派生数据，不重建的话新条目在"按类型筛选"里要等下次
    if (r.ok) { try { memoryService.rebuildIndex() } catch { /* 索引失败不影响这条已经写进去 */ } }
    return r
  })
  guardedHandle('memoryUpdate', (_event, file: string, input: any) => {
    const r = memoryService.updateMemory(file, input || {})
    if (r.ok) { try { memoryService.rebuildIndex() } catch { /* 同上 */ } }
    return r
  })
  guardedHandle('memorySetStatus', (_event, file: string, status: string, reason?: string) => {
    const r = memoryService.setMemoryStatus(file, status, reason || '')
    if (r.ok) { try { memoryService.rebuildIndex() } catch { /* 同上 */ } }
    return r
  })
  // 导入 / 一键整理（2026-11-20 问卷 M5 A + M1 B）：两条都只落「待审批」
  guardedHandle('memoryImport', (_event, input: any) => memoryService.importMemories(input || {}))
  guardedHandle('memoryOrganize', (_event, input: any) => memoryService.organizeMemories(input || {}))

  // 2026-11-20：记忆批量归类/改字段（只动 frontmatter 分类，不碰正文/状态）。
  guardedHandle('memoryBatchUpdate', (_event, files: any, patch: any) => {
    const r = memoryService.batchUpdateMemory(Array.isArray(files) ? files : [], patch || {})
    if (r.updated) { try { memoryService.rebuildIndex() } catch { /* 同上 */ } }
    return r
  })

  // 有新记忆待审批 → 通知中心 + 系统通知（渲染层轮询到 pending 增加时调）。
  // 主进程自己算 count/latest，不信渲染层传的数字。
  guardedHandle('memoryNotifyPending', () => {
    const ov = memoryService.memoryOverview()
    if (!ov.pending) return { ok: true, created: false, count: 0 }
    const latest = ov.pendingLatest || null
    const created = notifierService.notifyMemoryPending(ov.pending, latest?.claim || '', latest?.file || '')
    return { ok: true, created, count: ov.pending, latest }
  })

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

  // 任务卡历史版本（2026-10-18 卡 001；2026-10-31 收口）：
  // 与日志侧同款 —— 列表只给元数据，正文按需取，恢复只认列表里出现过的文件名。
  guardedHandle('tasks:versions', (_event, id: string) => {
    return tasks.listTaskVersions(String(id || ''))
  })
  guardedHandle('tasks:versionGet', (_event, id: string, file: string) => {
    return tasks.getTaskVersion(String(id || ''), String(file || ''))
  })
  guardedHandle('tasks:restoreVersion', (_event, id: string, file: string) => {
    return tasks.restoreTaskVersion(String(id || ''), String(file || ''))
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
  // 仿日志清理：设置保留天数（0 = 关闭），列出“已超期”的那批 + 一键归档。
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

  // `scanProjectStatus` 通道已删（2026-10-11，卡 20261006-002 E 组死通道）：
  // 渲染层从不调（项目进度走 allProjectProgress）；MCP 侧直接调 `tasks.scanProjectStatus()`，不走 IPC。
  // 函数本体保留（内部 suggestCrossProject / 事件检测在用）。

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
  // `findTimeoutTasks` 通道已删（2026-10-11，卡 20261006-002 E 组）：命名误导（只算“派活→现在”，
  // 与任务文件有没有变**毫无关系**）＋渲染层零调用。函数本体保留给内部 detectEvents 用。

  // “进行中但文件 N 小时没变”= **真**僵尸卡判据（2026-10-11，监控台 P0）。
  // ⚠ 别拿 findTimeoutTasks 当它用 —— 那个只算“派活 → 现在”，与文件有没有变**毫无关系**
  //   （点“进行中”会把 `更新` 刷成当下，agent 每小时回写一次在它眼里照样"超时"）。
  // 通知中心（services/notifier.ts）一直在用同一条判据，这里只是把它**接到界面上**。
  guardedHandle('stalledTasks', (_event, thresholdHours?: number) => {
    return tasks.findStalledTasks(thresholdHours)
  })

  // `getProjectProgress` 通道已删（2026-10-11）：渲染层用下面这条（一次全量，避免 N × 全扫）；
  // 函数本体保留 —— bench-load / e2e-task-fields 直接调它做基准与断言。

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
  // 属于“假成功”，已移除。新建项目改走 registry:addProject（真写入 + 写前自校验）。
  guardedHandle('registry:addProject', (_event, fields: data.NewProjectFields) => {
    try {
      return data.addProjectToRegistry(fields || { id: '' })
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  /** 项目说明三字段（状态 / 路线图 / 说明）读写 —— 2026-10-22 · 06 单“13 行写回”。
   *  写回走文本块级替换 + 写前自校验，并回传改前旧值供撤销条反推回滚。 */
  guardedHandle('registry:readFields', (_event, id: string) => {
    try {
      return data.readProjectFields(String(id || ''))
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // 单行写法是刻意的：check-ipc-parity 按 `guardedHandle('name'` 同行扫描，拆行会被判成"未注册"。
  guardedHandle('registry:updateFields', (_event, id: string, patch: Record<string, string>) => {
    try {
      return data.updateProjectFields(String(id || ''), (patch || {}) as any)
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
   * 必须传父窗口：不传时 Windows 上对话框不置顶，用户点“浏览…”看不到任何变化，
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
   *  - 用“复制”而非“移动”，源目录原样保留，出问题数据还在
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

  // ── Notes ── 已于 2026-10-06 整块删除（暮雨批：笔记功能可以删）───────────
  // 判据：preload 暴露 + 主进程注册，但**渲染层零调用** —— 界面里从来没有过笔记入口。
  // 通道、`services` 的笔记实现、`tasks` 的笔记导入导出一并删。
  // ⚠ `notes/` 数据目录**不动**：历史笔记文件仍在磁盘上（只是没有界面/通道了）。
  // ⚠ 别误伤：下面 `exportTasks` / `importTasks` 是“导出/导入任务 JSON”（设置页在用）。

  // ── Blocker chains ─────────────────────────────────────────────────
  guardedHandle('getBlockerChains', () => {
    return tasks.getBlockerChains()
  })

  // ── Git 联动（卡 20260925-017，2026-10-06）── 只读 ────────────────────
  // 回答两个问题：① 这张卡存续期间，它所属仓库有哪些提交（按创建~更新+7天的时间窗）；
  // ② 哪些提交信息里提到了本卡 ID（`fix: xxx (#task-20261005-005)` 那类）。
  // 铁律：只读 `git log` —— 不 checkout / 不 fetch / 不写任何仓库、不改任务数据（契约 ③）。
  // 读不到时**显式说明原因**（没归属项目 / 没登记 repo / 不是 git 仓库），不给假数据。
  // ── 实况回流：项目路线文档（2026-10-21 · W1-批次 2）── 只读
  // 读 registry 登记的 repo 里的 README / ROADMAP + 最近动过 docs/ 的提交，
  // **与手写字段并列显示**给用户看真假，绝不覆盖 registry 的手写值。
  // 一天一批（服务侧按 仓库+日期 缓存），不 fetch、不写仓库（铁律同 git:taskCommits）。
  guardedHandle('project:docs', async (_event: any, projectId: string) => {
    const pid = String(projectId || '').trim()
    if (!pid) return { ok: false, repo: '', readme: null, roadmap: null, docsCommits: [], readAt: new Date().toISOString(), cached: false, note: '没指定项目' }
    const proj: any = data.parseRegistry().find((p: any) => p.id === pid)
    if (!proj) return { ok: false, repo: '', readme: null, roadmap: null, docsCommits: [], readAt: new Date().toISOString(), cached: false, note: `registry 里没有项目“${pid}”` }
    // projectHints：让 repoDocs 能在 Hermes 里匹配同名 skill（如 `sitian-development`）。
    // 2026-11-16：那些 skill 里有 60+ 条铁律，不在仓库里 —— 不读就等于没看见项目的宪法。
    return repoDocs.readProjectDocs(String(proj.repo || ''), {
      projectHints: [String(proj.id || ''), String(proj.name || '')],
    })
  })

  // ── 方寸自仓启动同步状态（2026-10-21 · W1-1C）── 只读状态
  // “远端推一笔 → 重启就跟上”是自动的；这里**只报状态**，刻意不提供"立即同步"按钮
  // （用户零动作原则：自动就够，多一个按钮就多一处要维护的失败面）。
  guardedHandle('sync:selfStatus', () => selfSync.getSelfSyncStatus())

  guardedHandle('git:taskCommits', async (_event: any, taskId: string) => {
    try {
      const task = tasks.readTask(taskId)
      if (!task) return { ok: false, error: '任务不存在' }
      const pRaw = (task.fm as any).project
      const pid = Array.isArray(pRaw) ? String(pRaw[0] || '') : String(pRaw || '')
      if (!pid) return { ok: true, repo: '', commits: [], mentioned: [], note: '这张卡没有归属项目，定位不到仓库' }
      const proj: any = data.parseRegistry().find((p: any) => p.id === pid)
      const repo = String(proj?.repo || '')
      if (!repo) {
        return { ok: true, repo: '', commits: [], mentioned: [],
          note: `项目“${proj?.name || pid}”没登记工作目录，定位不到仓库` }
      }
      if (!(await gitLink.isGitRepo(repo))) {
        return { ok: true, repo, commits: [], mentioned: [],
          note: '这个工作目录不是 git 仓库（或本机此刻读不到 git）—— 方寸没法替它编提交记录' }
      }
      const since = gitLink.toIso((task.fm as any).created)
      const until = gitLink.toIso((task.fm as any).updated, 7)
      return {
        ok: true, repo, since, until,
        commits: await gitLink.repoCommitsBetween(repo, since, until),
        mentioned: await gitLink.commitsMentioning(repo, taskId),
      }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
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
  // 此前 getScannerStatus() 没有通道：“扫描器停摆”与“扫不到事件”在界面上长得
  // 一模一样，用户只能得出通知中心是坏的。面板页脚显示“上次扫描 / 运行中”。
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
  // `scanServices` 通道已删（2026-10-11，卡 20261006-002 E 组）：渲染层零调用；
  // MCP 侧直接调 `services.scanServices()` 函数。函数本体保留。

  // ── Launchpad ─────────────────────────────────────────────────────
  // ── Policies（方针区）──────────────────────────────────────────────
  guardedHandle('policy:get', (_event, projectId: string) => {
    try { return { ok: true, policy: policies.getPolicy(projectId) } }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  /**
   * 从项目仓库的 README 起草「使命」（2026-11-14 · 长 Loop P1-2）。
   *
   * 存在的理由：14 个项目里 7 个的使命是空的，而它们**大多在 README 里写清了**
   * —— 病根是"方寸从没去读项目现实"。这里把 README 里那句话捞出来当草稿，
   * 人点一下才填进弹窗（**不自动保存**）。
   *
   * ⚠ 只读 README 一个文件：不 spawn git、不碰网络（与 `policy:drift` 那类要 spawn 的分开）。
   * ⚠ 审批：这是**读**操作，不违反契约③「方寸对项目 repo 只读」（读正是允许的）。
   */
  guardedHandle('policy:missionDraft', (_event, projectId: string) => {
    try {
      const proj = (data.parseRegistry() || []).find((p: any) => p.id === projectId)
      if (!proj) return { ok: false, error: '没有这个项目：' + projectId }
      const repo = String((proj as any).repo || '')
      const got = readReadmeOf(repo)
      const d = draftMissionFromReadme(projectId, got ? got.md : '', {
        sourceFile: got ? got.sourceFile : '',
        fallbackTitle: String((proj as any).name || ''),
      })
      return { ok: true, draft: d }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

  guardedHandle('policy:save', (_event, p: any) => {
    try { return policies.savePolicy(p) }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  /** 结构地图落地（2026-11-21）：界面「签字并应用」与 MCP `smap_apply` 共用同一份 service */
  guardedHandle('smap:apply', (_event, taskId: string) => {
    try { return applySmapFromTask(String(taskId || '')) }
    catch (e: any) { return { ok: false, error: e?.message || String(e) } }
  })

  /**
   * 结构地图「结构大改」批量判定（2026-11-08）：渲染层把 [{project, repo, since}] 传进来，
   * 主进程问 git（带 10 分钟缓存），返回每个项目的 stale + 理由。
   * 为什么批量：一次 IPC 走完，不在渲染层串 12 个往返。
   *
   * ⚠ 2026-11-17：这条通道此前用**同步** spawn git —— 16 个项目 × 5 次 ≈ **4.7 秒**，
   *   且在主进程里同步跑，事件循环整个冻住。暮雨报的「刷新要 5000ms 以上」「点记忆页
   *   几乎整个方寸卡死，狂点好几下才进去」都是它：冻住期间所有 IPC 只能排队。
   *   现在走 `structureDriftAllAsync`（异步 runGit + 并发 4），判定口径未变。
   *   别改回同步版 —— `e2e-structure-drift.cjs` 有断言钉住"产品路径不许同步 spawn git"。
   */
  guardedHandle('policy:driftAll', async (_event, items: any[]) => {
    try {
      const { structureDriftAllAsync } = require('./services/structureDrift')
      const rows = await structureDriftAllAsync(Array.isArray(items) ? items : [])
      return { ok: true, rows }
    } catch (e: any) { return { ok: false, error: e.message, rows: [] } }
  })

  guardedHandle('policy:text', (_event, projectId: string) => {
    try {
      const p = policies.getPolicy(projectId)
      return p ? { ok: true, text: policies.policyToText(p) } : { ok: false, error: '方针卡不存在' }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

  // ── 在途一屏（Q2 · 立项契约 ② 验收线之①）──────────────────────────────
  // 只读聚合：读各 repo 的 `立项契约.md` + 任务卡 + 执行日志 + git 提交时间。
  // 方寸**不写任何项目仓库**；"打开 repo"只收 projectId（路径由主进程从 registry 取），不放任意路径。
  // 2026-10-11 用户：“每次进在途一屏都要卡一下”。真因是**逐项目同步 spawn git**
  //（8 个项目 × 2 条命令 = 0.5–3s 整段阻塞）。现在先并发预热缓存再走原来的同步聚合 ——
  // 命令/缓存键/TTL/失败语义一条没改，只是把等待从"串行阻塞"换成"并发等待"。
  guardedHandle('trip:board', async () => {
    try {
      await tripBoard.warmBoardGit()
      return { ok: true, ...tripBoard.buildTripBoard() }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

  // ── 随问（2026-10-22 · 施工单包 03 任务一）：结构化查询，零 LLM ──────────
  // 成本红线写在这里：这条通道**永远不调模型**。模糊问题由界面明确告知"这条得靠 AI"，
  // 要不要花那个 token 由用户点头（AI 只进“模糊问答”“批次出单”两处）。
  guardedHandle('ask:presets', () => {
    return { presets: ask.ASK_PRESETS, projects: ask.askProjectOptions() }
  })

  guardedHandle('ask:query', async (_event, q: string) => {
    try {
      // 与 trip:board 同一条预热：逐项目**同步** spawn git 会把整段卡住 0.5–3s
      await tripBoard.warmBoardGit()
      return { ok: true, ...ask.answer(String(q || '')) }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  // ── agent 上下文包（2026-10-22 · b 版落地物）：把项目现状拼成一段可粘贴的 Markdown ──
  guardedHandle('context:pack', (_event, projectId: string, opts?: any) => {
    try {
      return contextPack.buildContextPack(String(projectId || ''), opts || {})
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('context:packFile', (_event, projectId: string) => {
    try {
      return contextPack.writeContextPackFile(String(projectId || ''))
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  // ── 发送给 DSH（2026-11-17 · 暮雨：「管子现在就做，它是其他一切的前提」）──────
  // ⚠ 文案口径：UI 上是「发送给 DSH」。暮雨 2026-11-17：「🧠 派给 DSH 按钮太丑了，
  //   改成『发送给DSH』都能让人看懂」。通道名 `context:dispatchDsh` 是内部标识，沿用旧名。
  // 只落一份派单文件；**不 spawn DSH、不碰 DSH 配置** —— 那是插件在自己的进程里做的。
  // 方寸连 DSH 装没装都只是只读探测（`services/dshPlugin.ts`），不能在主进程里去启动它。
  //
  // 2026-11-17 暮雨定案：「以后可以直接在 DSH 里派活**做规划**」→ 加 `kind` 参数。
  // 老调用方不传 = `work`，行为与 0.6.0 完全一致（零破坏）。
  guardedHandle('context:dispatchDsh', (_event, projectId: string, kind?: string) => {
    try {
      return contextPack.dispatchToDsh(String(projectId || ''), kind)
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  // 带任务书的派单（2026-11-20 · D-150）：文档拆卡 / 出单改成 DSH 派单，
  // 不再调方寸自己的模型（llm:docToDrafts / llm:planBatch 已删）。
  // 任务书由界面固定生成，不是 agent 传的自由文本；冷却/清理与上面同一条链路。
  guardedHandle('context:dispatchMessage', (_event, projectId: string, kind: string, message: string) => {
    try {
      return contextPack.dispatchMessageToDsh(String(projectId || ''), kind, String(message || ''))
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  // ── 开工简报（2026-11-16 · 治病①「没有记忆」的入口）─────────────────────
  // 卡 `最高优先级ai-施工的五种病…` 的验收线：跑一轮新入口，agent 必须能答对
  // 「上次做到哪 / 这次先做什么 / 有哪些规矩别犯」，且输出 <= 8KB。
  // 口径真源是 `scripts/brief.py`（这里只跑它，不重算 —— 两份口径迟早分叉）。
  guardedHandle('brief:get', async (_event, projectId: string) => {
    try {
      return await brief.buildBrief(String(projectId || ''))
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('brief:write', async (_event, projectId: string) => {
    try {
      return await brief.writeBriefFile(String(projectId || ''))
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  // ── 随纠（2026-10-22 · 施工单包 03 任务二）：一句话改项目方向，决策卡自动留痕 ──
  // 只认三种固定句式（不调模型、不猜）：见 services/correct.ts 头部。认不出就明说认不出。
  guardedHandle('correct:preview', (_event, text: string, projectId?: string) => {
    try {
      return correct.parseCorrection(String(text || ''), projectId ? String(projectId) : undefined)
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('correct:apply', (_event, text: string, projectId?: string) => {
    try {
      return correct.applyCorrection(String(text || ''), projectId ? String(projectId) : undefined)
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('correct:undo', (_event, args: any) => {
    try {
      return correct.undoCorrection(args || {})
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('trip:contractText', (_event, projectId: string) => {
    try {
      const repo = tripBoard.repoOfProject(projectId)
      if (!repo) return { ok: false, error: '该项目在 registry 里没有登记仓库路径' }
      const c = tripBoard.readContractFile(repo)
      if (c.exists) {
        return { ok: true, exists: true, text: fs.readFileSync(c.path, 'utf-8'), path: c.path, repo }
      }
      // 没有契约 → 给一份骨架（纯文本，落盘由用户自己做）
      return { ok: true, exists: false, text: tripBoard.contractTemplate(projectId), path: c.path, repo }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

  // 移除项目登记（2026-10-05 用户：“项目页签里似乎没有添加和删除项目的入口”）。
  // **只动 registry.yaml 的那一段文本块** —— 任务卡 / 方针卡 / 项目仓库一个字节都不碰；
  // 删掉登记后该项目下的卡会变成“未归属项目”（卡还在）。写前自校验在 data 层。
  guardedHandle('registry:removeProject', (_event, id: string) => {
    try { return data.removeProjectFromRegistry(id) }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  // 在项目文件夹里**创建**“立项契约.md”（2026-10-05 用户：让方寸直接写，弹窗确认即可）。
  // 只建不覆盖：文件已存在一律拒绝；只写固定文件名 + 固定模板，不接任意路径/内容。
  guardedHandle('trip:initContract', (_event, projectId: string) => {
    try { return tripBoard.initContractFile(projectId) }
    catch (e: any) { return { ok: false, error: e.message } }
  })

  guardedHandle('trip:openRepo', async (_event, projectId: string) => {
    try {
      const repo = tripBoard.repoOfProject(projectId)
      if (!repo) return { ok: false, error: '该项目在 registry 里没有登记仓库路径', repo: '' }
      if (!fs.existsSync(repo)) return { ok: false, error: `目录不存在：${repo}`, repo }
      const err = await shell.openPath(repo)
      return err ? { ok: false, error: err, repo } : { ok: true, repo }
    } catch (e: any) { return { ok: false, error: e.message, repo: '' } }
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

  guardedHandle('todos:create', (_event: any, title: string, priority?: string, due?: string, project?: string, fromLog?: string, dueTime?: string) => {
    try {
      const todo = todosService.createTodo(title, priority as any, due, project, fromLog, dueTime)
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

  // ── 想法（2026-10-22 · 念头没有家：待办/日志/任务都放不下）────────────────
  // 刻意做得很轻：只有 内容 / 记下的时间 / 四态。没有优先级、没有截止日、不归属项目 ——
  // 一旦有了这些它就又变成待办了（理由见 services/ideas.ts 头部）。
  guardedHandle('ideas:list', (_event, filter?: any) => {
    try {
      return ideasService.listIdeas(filter || undefined)
    } catch (e: any) {
      return []
    }
  })

  guardedHandle('ideas:summary', () => {
    try {
      return ideasService.ideasSummary()
    } catch {
      return { 新记: 0, 已立项: 0, 已搁置: 0, 已否决: 0 }
    }
  })

  guardedHandle('ideas:add', (_event, text: string) => {
    try {
      return ideasService.addIdea(String(text ?? ''))
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('ideas:updateText', (_event, id: string, text: string) => {
    try {
      return ideasService.updateIdeaText(String(id || ''), String(text ?? ''))
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('ideas:setStatus', (_event, id: string, status: string, note?: string) => {
    try {
      return ideasService.setIdeaStatus(String(id || ''), status as any, note)
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('ideas:promote', (_event, id: string, opts?: any) => {
    try {
      return ideasService.promoteIdea(String(id || ''), opts || undefined)
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('ideas:unpromote', (_event, id: string) => {
    try {
      return ideasService.unpromoteIdea(String(id || ''))
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('ideas:delete', (_event, id: string) => {
    try {
      return ideasService.deleteIdea(String(id || ''))
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('ideas:restore', (_event, idea: any) => {
    try {
      return ideasService.restoreIdea(idea)
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('ideas:health', () => {
    return ideasService.ideasHealth()
  })

  // ── Logs ────────────────────────────────────────────────────────────
  // 卡 037 右键菜单：置顶与改归属都不受“非 active 不可编辑”守卫限制（视图/归类属性）
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

  guardedHandle('logs:create', (_event, title: string, project: string, content: string, taskId?: string, extra?: { sessionId?: string; agentName?: string; prevAgentName?: string; logDate?: string; taskIds?: string[]; nextSteps?: string; continueFrom?: string; priority?: string; fromTodo?: string }) => {
    return logsService.createLog(title, project, content, taskId, extra)
  })

  guardedHandle('logs:update', (_event, id: string, updates: any) => {
    return logsService.updateLog(id, updates)
  })

  guardedHandle('logs:versions', (_event, id: string) => {
    return logsService.listLogVersions(String(id || ''))
  })
  // 逐版预览 / 恢复（2026-10-18 卡 001）：从"只能退一步"扩到"能挑版本"。
  guardedHandle('logs:versionGet', (_event, id: string, file: string) => {
    return logsService.getLogVersion(String(id || ''), String(file || ''))
  })
  guardedHandle('logs:restoreVersion', (_event, id: string, file: string) => {
    return logsService.restoreLogVersion(String(id || ''), String(file || ''))
  })

  guardedHandle('logs:complete', (_event, id: string, retainDays: number | null, note?: string) => {
    return logsService.completeLog(id, retainDays, note)
  })

  guardedHandle('logs:archive', (_event, id: string, note?: string) => {
    return logsService.archiveLog(id, note)
  })

  // 2026-09-28 用户第 2 条：“进行中”只能手动开关，且可撤销。
  // 这是 running 的**唯一写入路径**（创建/完成/归档只会关掉它）。
  guardedHandle('logs:setRunning', (_event, id: string, running: boolean) => {
    return logsService.setLogRunning(String(id || ''), !!running)
  })

  // 撤销完成 / 撤销归档，退回“待处理”。**不等于“进行中”** —— 要不要进行中由用户另外开。
  guardedHandle('logs:reopen', (_event, id: string) => {
    return logsService.reopenLog(id)
  })

  // 主日志 + 附属日志（2026-10-30 暮雨第 4 条）：绑定落盘，一键全进行中 / 全完成。
  guardedHandle('logs:setAttached', (_event, mainId: string, ids: any) => {
    return logsService.setLogAttached(String(mainId || ''), Array.isArray(ids) ? ids.map((x: any) => String(x || '')) : [])
  })
  guardedHandle('logs:groupRunning', (_event, mainId: string, running: boolean) => {
    return logsService.setLogGroupRunning(String(mainId || ''), !!running)
  })
  guardedHandle('logs:groupComplete', (_event, mainId: string, retainDays: number | null, note?: string) => {
    return logsService.completeLogGroup(String(mainId || ''), retainDays, note)
  })

  // 状态快照 / 还原（2026-10-30 暮雨第 5 条）：撤销要回到点之前那一格，
  // 而不是统一退回“待处理”（那会把用户手动标的“进行中”吃掉）。
  guardedHandle('logs:stateSnapshot', (_event, id: string) => {
    return logsService.logStateSnapshot(String(id || ''))
  })
  guardedHandle('logs:restoreState', (_event, id: string, snap: any) => {
    return logsService.restoreLogState(String(id || ''), snap)
  })

  guardedHandle('logs:destroy', (_event, id: string) => {
    return logsService.destroyLog(id)
  })

  guardedHandle('logs:inject', (_event, id: string) => {
    return logsService.injectLog(id)
  })

  // 多条日志 → 一份开工单（2026-10-29 暮雨第 6 条：“主日志带多条副日志一起灌入”）。
  // 与 MCP `inject_logs` 共用 services/logs.injectLogs —— 两处各拼一次必然分叉。
  guardedHandle('logs:injectMany', (_event, ids: any) => {
    return logsService.injectLogs(Array.isArray(ids) ? ids.map((x: any) => String(x || '')) : [])
  })

  // ── 附件（2026-10-01 用户第 1 条 → 卡 036）：日志 ↔ 文件的唯一入口 ──────
  // 选文件在这里做（要用 BrowserWindow 的模态对话框），复制/挂载逻辑全在 logs.ts，
  // 渲染层只管拿到更新后的 entry。文件**复制**进数据目录，源文件不动。
  //
  // 2026-10-25（暮雨第 4 / 7 条）加了两个入口，解决两件事：
  //   ① “新建日志时必须先创建才能挂附件”—— 现在可以先选文件（`logs:pickFiles` 只拿路径，
  //      不落盘），等日志存好再带着路径调 `logs:attachFiles(logId, sources)` 一次挂上；
  //   ② “附件能不能粘贴图片”—— 剪贴板里只有 blob 没有路径（Electron 44 起 `File.path`
  //      也已移除），所以另走 `logs:attachData`：字节进主进程，校验与写盘全在 logs.ts。
  guardedHandle('logs:pickFiles', async () => {
    const picked = await pickFilesForAttach('选择要关联到这条日志的文件（截图 / 分析报告）')
    if (picked.canceled || !picked.filePaths.length) return { ok: false, error: 'canceled', paths: [] }
    return { ok: true, paths: picked.filePaths }
  })

  guardedHandle('logs:attachFiles', async (_event, logId: string, sources?: string[]) => {
    // sources 有值 = 调用方已经选好了（新建态暂存的那批），不再弹第二次框
    let paths = (Array.isArray(sources) ? sources : []).map((s) => String(s || '')).filter(Boolean)
    if (!paths.length) {
      const picked = await pickFilesForAttach('选择要关联到这条日志的文件（截图 / 分析报告）')
      if (picked.canceled || !picked.filePaths.length) return { ok: false, error: 'canceled' }
      paths = picked.filePaths
    }
    const r = logsService.addAttachments(String(logId || ''), paths)
    if (r.ok) appLog.info('logs', `日志 ${logId} 新增附件 ${paths.length} 个`)
    return r
  })

  // 粘贴图片：只收 data URL（字节由渲染层从剪贴板读出来），校验/落盘在 logs.ts
  guardedHandle('logs:attachData', (_event, logId: string, items: any) => {
    const r = logsService.addAttachmentsFromData(String(logId || ''), Array.isArray(items) ? items : [])
    if (r.ok) appLog.info('logs', `日志 ${logId} 粘贴附件 ${r.added ?? 0} 个`)
    return r
  })

  // 解除关联（文件留在磁盘上，见 detachAttachment 注释）
  guardedHandle('logs:detachAttachment', (_event, logId: string, rel: string) =>
    logsService.detachAttachment(String(logId || ''), String(rel || '')))

  // 预览用 data URL；超大文件由 logs.ts 返回 tooLarge，界面改给“用系统程序打开”
  guardedHandle('logs:attachmentData', (_event, rel: string) =>
    logsService.readAttachmentData(String(rel || '')))

  guardedHandle('logs:openAttachment', async (_event, rel: string) => {
    const abs = logsService.resolveAttachment(String(rel || ''))
    if (!abs) return { ok: false, error: '附件不存在（或路径不在数据目录内，已拒绝）' }
    // 2026-10-30 暮雨报障：点附件里的安装包 → 方寸白屏成空壳。
    // 旧实现把任何附件都交给 shell.openPath；`.exe` 会被直接**运行安装程序**，
    // 覆盖到正在跑的方寸就白屏。现在可执行/安装文件一律**不运行**，只允许定位。
    const policy = attachmentOpenPolicy(String(rel || ''))
    if (!policy.run) {
      return { ok: false, needsReveal: true, ext: policy.ext, error: policy.reason, hint: policy.hint }
    }
    try {
      const err = await shell.openPath(abs)
      return err ? { ok: false, error: err } : { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  // 可执行附件只能“在文件夹中显示”，由用户确认来源后自己双击。
  guardedHandle('logs:revealAttachment', (_event, rel: string) => {
    const abs = logsService.resolveAttachment(String(rel || ''))
    if (!abs) return { ok: false, error: '附件不存在（或路径不在数据目录内，已拒绝）' }
    try {
      shell.showItemInFolder(abs)
      return { ok: true, path: abs }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  guardedHandle('logs:cleanup', () => {
    return logsService.cleanupLogs()
  })

  // 按日期批量清理“已归档”日志（2026-10-13 暮雨第 2 条）：
  // 不是硬删 —— 移进 `<数据目录>/docs/执行日志/.trash/`，可恢复。
  // dryRun=true 只报命中条数（界面先预览再确认），绝不落盘。
  guardedHandle('logs:purgeArchived', (_event, beforeDate: string, opts?: { dryRun?: boolean }) => {
    return logsService.purgeArchivedBefore(String(beforeDate || ''), { dryRun: !!opts?.dryRun })
  })

  // ── 剪贴板 ──────────────────────────────────────────────────────────
  // 渲染层的 navigator.clipboard 在打包版(file://)或被拒时会**静默失败**：剪贴板里仍留着
  // 上一次的内容，用户以为复制成功（2026-09-25“日志复制失败，粘出来是旧的 0924 内容”的真因）。
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

  // ── MCP 写口（2026-11-11 · 卡《MCP 写口无闸》）──────────────────────────
  // 三档：只读 / 读写 / 读写+破坏性。改档本身也留痕（谁、何时、从哪档到哪档）——
  // 闸只有“能看见 + 能收紧 + 有记录”三件齐全才算过关（卡上判据）。
  guardedHandle('mcp:writeMode', () => ({
    mode: writeGate.getWriteMode(),
    modes: writeGate.WRITE_MODES,
  }))
  guardedHandle('mcp:writeModeSet', (_event, mode: string) => {
    const r = writeGate.setWriteMode(mode as any, 'user')
    if (r.ok) appLog.info('mcp', `MCP 写入档位：${r.previous} → ${r.mode}`)
    return r
  })
  guardedHandle('mcp:writes', (_event, limit?: number) => {
    const n = Number(limit)
    return writeGate.listWrites(Number.isFinite(n) && n > 0 ? Math.min(500, Math.floor(n)) : 50)
  })

  // ── 运行态（2026-11-11 卡 task-20261017-002）──────────────────────────
  // 客户端态 / 开发态靠可读信号判（isPackaged / 应用路径 / 可执行文件 / 数据目录），
  // 设置页一眼看得见；MCP 的 initialize instructions 也会带同一句话给 agent。
  guardedHandle('app:mode', () => detectAppMode())

  // ── 项目梯度榜（2026-10-25）：只服务项目页的“梯度榜”摆法 ──────────────
  // 边界见 services/projectTiers.ts 顶部注释：不参与看板分组、不影响一屏、不动 registry。
  guardedHandle('projectTiers:get', () => projectTiers.readTiers())
  guardedHandle('projectTiers:set', (_event, tiers: unknown) => {
    const r = projectTiers.writeTiers(tiers)
    if (r.ok) appLog.info('projectTiers', `梯度榜已更新（${r.tiers.length} 档 / ${r.tiers.reduce((n, t) => n + t.items.length, 0)} 项）`)
    return r
  })

  // 一次写完多个偏好键 + 回读校验（2026-10-05）：见 prefs.setPrefs 的注释 ——
  // “提示保存了但实际没保存”的老路必须堵死，凡是用户点了保存的路径都要能回答"存住没有"。
  guardedHandle('prefs:setMany', (_event, patch: Record<string, unknown>) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, written: [], error: '参数必须是 { 键: 值 } 对象' }
    }
    return prefs.setPrefs(patch as any)
  })

  // ── Dispatch ── 已于 2026-10-06（卡 004）整条删除 ────────────────────
  // `dispatch:preview` / `dispatch:execute` 两个 handler + preload 的两条通道一起删。
  // 理由：桌面派活入口 9/20 就判死，渲染层零调用 —— 留着只会骗后来者（本次就骗了一次）。
  // 需要派工单时走“📐 复制为派工单”（纯文本，只复制不派发）。

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

  // 直接驳回（2026-10-30 暮雨第 2 条）：任何非终态卡都能退回，并留下可选理由。
  guardedHandle('review:rejectDirect', (_event: any, id: string, reason?: string) => {
    try {
      return rejectTaskDirect(id, reason)
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
  // 尾部内容与“打开日志目录”暴露给界面，并在渲染层出错时由前端主动回报。
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
  // `applog:dir` 通道已删（2026-10-11，卡 20261006-002 E 组）：与 applog:openDir 重复（后者本就回 dir）。
  guardedHandle('applog:tail', (_e: any, lines?: number) => appLog.tail(lines && lines > 0 ? lines : 300))
  // 2026-10-17 暮雨第 5 条：日志只增不减，没有任何清理机制。days<=0 = 全清（当天那份只截断）。
  guardedHandle('applog:purge', (_e: any, days?: number) => appLog.purgeOldLogs(Number.isFinite(Number(days)) ? Number(days) : 7))
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

  // ── 真退出通道（2026-11-17 · 卡 p0-1「不同意并退出」永远退不掉）──────────
  //
  // 暮雨原话（`log_20261109134505_ev63qw`）：「『不同意并退出』永远退不掉」。
  // 真因：免责声明点「不同意」走渲染层 `window.close()`，而**主进程在 close 事件里
  //   `preventDefault()` 把它改成 `hide()`**（"关窗≠退出、常驻托盘"是设计，本身没错）。
  //   于是"不同意"= 窗口消失、进程还在托盘 —— 用户看到的就是"退不掉"。
  //
  // ⚠ 顺序不能反：必须先 markQuitting() 再 destroy/quit —— close 钩子判的就是那个闸。
  //   反了等于什么都没做（与"点了没反应"同一种形状）。
  // ⚠ 这条通道注册在 `main/ipc.ts` 而不是 `src/index.ts`：`check-ipc-parity` 的主进程
  //   注册扫描只认 `src/main/`。第一版写在 index.ts 里，守卫当场报「僵尸通道」——
  //   那不是误报，它抓的正是"preload 暴露了但某条路径没注册"。
  // 开机自启（2026-11-21）：默认关；只写当前用户启动项。开发态不写，如实说明。
  guardedHandle('app:getAutoStart', () => getAutoStartStatus())
  guardedHandle('app:setAutoStart', (_event, enabled: boolean) => setAutoStart(!!enabled))

  guardedHandle('app:quitForReal', async () => {
    try {
      markQuitting()
      const { BrowserWindow, app } = require('electron') as typeof import('electron')
      // 先销毁窗口：只发 quit 的话 close 钩子仍可能抢先把它 hide 掉
      try {
        for (const w of BrowserWindow.getAllWindows()) w.destroy()
      } catch { /* 已经没了就算了 */ }
      app.quit()
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })
}

// ── Dispatch helpers ─────────────────────────────────────────────────────
// 2026-10-06（卡 004）：buildDispatchPrompt / executeDispatch **已删**。
// 它们是 dispatch:preview / dispatch:execute 的唯一调用方，随通道一起退役。
// （executeDispatch 还会 moveStatus 到“进行中”—— 死代码里藏着状态变更，更该删。）

/**
 * 附件选择框（新建态与编辑态共用）。只负责"弹框 + 拿路径"，落盘在 `logs.ts`。
 * 抽出来是因为新建态要**先选后存**（暮雨第 4 条）：那时候还没有 logId，
 * 不能走"选完立刻挂"那条老路，但选文件这件事本身一模一样。
 */
async function pickFilesForAttach(title: string): Promise<Electron.OpenDialogReturnValue> {
  const opts: Electron.OpenDialogOptions = {
    title,
    properties: ['openFile', 'multiSelections'],
  }
  const win = BrowserWindow.getFocusedWindow()
  return win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
}

export function reviewTask(id: string, verdict: 'accept' | 'reject', reason?: string): { ok: boolean; error?: string } {
  const task = tasks.readTask(id)
  if (!task) return { ok: false, error: '任务不存在' }
  // 2026-10-25（暮雨第 1 条，第二次提）：“待审批”此前**没有任何正向出口** ——
  // 预览面板只给“待验收”开了裁决入口，AI 落的待审批卡只能用 forceCloseTask
  // 直接完成/驳回（跳过流程、不写结论）。后果是审批这件事在卡上无迹可查，
  // “AI 产出只落待审批、用户点头才转正”这条契约在界面上只剩半句。
  // 现在两种状态共用同一条裁决通道：
  //   待审批 accept → 待办（转正）｜reject → 驳回
  //   待验收 accept → 完成        ｜reject → 驳回
  const from = String(task.fm.status || '')
  const isApproval = from === '待审批'
  if (from !== '待验收' && !isApproval) {
    return { ok: false, error: `当前状态为“${from || '未知'}”，仅“待审批”“待验收”可裁决` }
  }
  // ⚠ 2026-10-27 修时区：原先 `new Date().toISOString()` 取的是 **UTC**，却直接当本地时间写进
  //   结果记录。暮雨看到“[2026-10-27 04:24] 审批通过”而那个点人根本不在电脑前，一度怀疑是幽灵 ——
  //   实际是当天中午 12:24。结果记录是**写给人看**的，必须是本地时间（无时区歧义）。
  const _d = new Date()
  const _p2 = (n: number) => String(n).padStart(2, '0')
  const ts = `${_d.getFullYear()}-${_p2(_d.getMonth() + 1)}-${_p2(_d.getDate())} ${_p2(_d.getHours())}:${_p2(_d.getMinutes())}`
  const passWord = isApproval ? '审批通过（转正“待办”）' : '验收通过'
  const failWord = isApproval ? '审批驳回' : '验收驳回'
  if (verdict === 'accept') {
    // 验收清单闸（2026-11-11 卡 011）：清单非空且有没打勾的项 → 拒绝完成。
    // 此前这个字段**没有任何读方**：填了跟没填一样，门控形同虚设。
    // 只对“待验收 → 完成”这一条判；待审批转正不看清单（审批不是验收）。
    if (!isApproval) {
      try {
        tasks.assertReviewChecklist(task.fm)
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) }
      }
    }
    tasks.moveStatus(id, isApproval ? '待办' : '完成')
    // 2026-09-25（用户第 7 条）：通过同样写结果记录 —— 此前只有驳回留痕，
    // “通过”这件事在卡上完全无迹可查（用户原话：验收裁决只能填驳回理由，那通过呢？）
    const note = (reason || '').trim()
    const line = note ? `[${ts}] ${passWord}：${note}` : `[${ts}] ${passWord}`
    const prev = String((task.fm as any).result_log || '')
    tasks.updateTask(id, { result_log: (prev + '\n' + line).trim() } as any)
    return { ok: true }
  } else {
    // 2026-10-30 暮雨第 2 条：**理由不再必填**。真实场景是"这张卡看都看不懂 / 整个就是错的"，
    // 逼他先写一段作文才能退回去，只会让人干脆点“归档”。留空也算一次驳回，
    // 但要在卡上明说“没写理由”；写得出来就原样留在独立的“驳回理由”字段里。
    const note = (reason || '').trim()
    tasks.moveStatus(id, '驳回')
    const logLine = note ? `[${ts}] ${failWord}：${note}` : `[${ts}] ${failWord}（没写理由）`
    const prevLog = String((task.fm as any).result_log || '')
    tasks.updateTask(id, {
      result_log: (prevLog + '\n' + logLine).trim(),
      reject_reason: note,
      reject_at: _d.toISOString(),
    } as any)
    return { ok: true }
  }
}

/**
 * 直接驳回（2026-10-30 暮雨第 2 条）：不限于“待审批 / 待验收”。
 *
 * 为什么单开一条而不是放宽 `reviewTask`：裁决通道有它的语义边界（审批/验收两种），
 * 而“这张卡看都看不懂 / 整个就是错的”可能发生在待办、进行中、草稿任何一步。
 * 这条只做一件事：把非终态卡置为“驳回”并留下（可选的）理由。
 * ⚠ 终态（完成 / 驳回）不许再“直接驳回”——那会让一张已签字的卡凭空变成退回，
 *   要改就走“退回返工”或撤销。
 */
export function rejectTaskDirect(id: string, reason?: string): { ok: boolean; error?: string } {
  const task = tasks.readTask(id)
  if (!task) return { ok: false, error: '任务不存在' }
  const from = String(task.fm.status || '')
  if (from === '完成' || from === '驳回') {
    return { ok: false, error: `“${from}”是终态，先“退回返工”再驳回` }
  }
  const note = String(reason || '').trim()
  const d = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
  tasks.moveStatus(id, '驳回')
  const prevLog = String((task.fm as any).result_log || '')
  const line = note ? `[${ts}] 驳回：${note}` : `[${ts}] 驳回（没写理由）`
  tasks.updateTask(id, {
    result_log: (prevLog + '\n' + line).trim(),
    reject_reason: note,
    reject_at: d.toISOString(),
  } as any)
  return { ok: true }
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

  // 自动同步的留痕 + 手动补一次（2026-11-05 暮雨：“更新后到底会不会自动更新技能”）。
  // 为什么需要这两条：自动同步原来只在建窗时跑、结果只写应用日志 ——
  // 升级安装包后旧进程还在托盘（单实例锁把新实例顶掉），同步就没跑，而界面上**看不出来**。
  guardedHandle('skills:syncStatus', () => {
    return getSkillSyncStatus()
  })
  guardedHandle('skills:syncNow', () => {
    const s = autoCheckSkills('manual')
    appLog.info('skills', `手动同步完成（触发=${s.trigger}）：${s.targets.map((t) => `${t.name} 装${t.installed.length}/跳过${t.skipped.length}/错${t.errors.length}`).join('，')}`)
    return { ok: true, ...getSkillSyncStatus(), lastRun: s }
  })

  guardedHandle('skills:openDir', (_event, which: string) => {
    return openSkillsDir(which)
  })

  // ── 技能直接导入（2026-09-26 卡 005，用户参照 WorkBuddy）──────────────
  // 三件事：列出“外部导入”的技能 / 选包（文件或文件夹）+ 导入 / 移除。
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

  // ── 接入 Hermes（2026-11-06 暮雨：“Hermes 要接，而且应该通过方寸去接”）──
  // 这是方寸**唯一**会写别人配置文件的通道，目标写死在 hermesLink 里（只 Hermes）。
  // 界面点之前必须确认；这里再兜一层“配置在不在”—— 不在就不替它建。
  // 状态不单开通道：`mcp:info` 已经把 linked / linkedDetail 一起下发了（同一份 probe 判据）。
  guardedHandle('mcp:linkHermes', (_event, entryId: string) => {
    const id = String(entryId || 'A') as McpEntryId
    return linkHermesMcp(id)
  })
  // DSH 侧的方寸插件（2026-11-06：暮雨“依然未体现 DSH 插件相关”）——
  // 只读 DSH 的 profile / 管道状态，不写、不改任何 DSH 配置。
  guardedHandle('mcp:dshPlugin', () => ({ ok: true, ...detectDshPlugin(app.getVersion()) }))
  // 2026-11-21：诊断页的“主动修复”只有两件方寸**有资格**做的：
  //   ① 生成自己的派单密钥（落在方寸 userData，不碰 DSH）；
  //   ② 打开 DSH profile 目录（只打开资源管理器，不写）。
  // 插件升级 / 删旧桥这类要改 DSH 配置的动作，方寸仍然只给提示词，由用户或 DSH 自己动手。
  guardedHandle('dispatch:ensureSecret', () => {
    try {
      ensureDispatchSecret()
      return { ok: true, path: resolveDispatchSecretPath() }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })
  guardedHandle('mcp:dshProfileOpen', async () => {
    const s = detectDshPlugin(app.getVersion())
    if (!s.profileDir) return { ok: false, message: '读不到 DSH profile 目录' }
    try {
      const err = await shell.openPath(s.profileDir)
      return err ? { ok: false, message: err, dir: s.profileDir } : { ok: true, dir: s.profileDir, message: '已打开 DSH profile 目录' }
    } catch (e: any) {
      return { ok: false, message: e?.message || String(e), dir: s.profileDir }
    }
  })

  // ── “哪些待办其实没人碰过”的界面出口（2026-10-27 卡 20261025-006 第三件）──
  // 在此之前这件事**只在 MCP 侧存在**：`never_read` 是个 MCP 工具，主进程没有 IPC、
  // preload 没暴露、界面没有入口 —— 所以“agent 主动发现 / 哪些卡没人读”这句承诺
  // 在桌面端一直是空的（卡里写的“IPC 都通了”是错的，2026-10-27 实证）。
  // 口径三条（都写进界面，别只写在这里）：
  //   ① 只认 `mcp-usage.jsonl`（agent 经 MCP 读卡）；**你在界面点开一张卡不算被读过**；
  //   ② 完成 / 驳回不进清单（做完了没人读是正常的）；
  //   ③ 窗口内一条读卡记录都没有时，界面不许报“N 张没人碰过”—— 那是计量没开始。
  guardedHandle('usage:neverRead', (_event, days?: number) => {
    // 空值要单独判：`Number('')` 和 `Number(null)` 都是 0，而 0 在这里是“不限时间”——
    // 直接 Number 会把"没传参"静默变成"不限时间"（卡 20261025-006 第一版就是这么写的）。
    const blank = days === undefined || days === null || String(days).trim() === ''
    const raw = blank ? 30 : Number(days)
    const win = Number.isFinite(raw) ? (raw > 0 ? Math.floor(raw) : 0) : 30
    const { stats, events } = readUsageSummary(win)
    const tasks = data.loadTasks('active').map(taskToNeverReadInput)
    return { ok: true, ...pickNeverRead(tasks, stats, { days: win, windowEvents: events }) }
  })

  // ── 整理体检（2026-10-30，卡 20261025-006 剩下的“接进整理流程”）──────
  // 一次摊开两批**清理候选**：没人碰过 + 驳回后没人管。判据与口径全在
  // services/cleanup.ts（纯函数，e2e-cleanup 用真数据根跑）。
  guardedHandle('cleanup:scan', (_event, days?: number) => {
    const blank = days === undefined || days === null || String(days).trim() === ''
    const raw = blank ? 30 : Number(days)
    const win = Number.isFinite(raw) ? (raw > 0 ? Math.floor(raw) : 0) : 30
    const { stats, events } = readUsageSummary(win)
    const tasks = data.loadTasks('active').map((t) => ({
      ...taskToNeverReadInput(t),
      result_log: String((t.fm as any)?.result_log ?? ''),
      reject_reason: String((t.fm as any)?.reject_reason ?? ''),
    }))
    return { ok: true, ...buildCleanupReport(tasks, stats, { days: win, windowEvents: events }) }
  })

  // ── “对不上”检测（2026-10-27，REV-008 一期 R4“让对不上可见”）──
  // 三类：① 状态过期（registry 写的日期 vs 仓库最后提交）② 引用断裂（卡里的路径磁盘上没了）
  //      ③ 完成但没判据（自报完成，无从复核）。判定全在 `shared/mismatch.ts`（e2e-mismatch 用纯 Node 验）。
  // ⚠ 口径三条，界面必须一起写：**它只是对不上，不是做错了；不阻挡任何操作；取不到 git 的项目要单独列出**。
  // 项目结构图（2026-10-29 暮雨第 2 条）：方寸自己的内核出图 ——
  // 项目 → 在途 → 已完成 → 执行日志。**不是代码架构图**（不读源码、不猜依赖），
  // 那双眼睛归 archify（只导入它的产物）。判断全在 shared/projectDiagram.ts。
  guardedHandle('project:diagram', async (_event, projectId: string) => {
    const r = findArtifactForProject(String(projectId || ''))
    if (!r.ok || !r.hit) return r
    // 方寸**不重画**架构图：archify 的产物是它自己的 HTML，这里只负责用系统浏览器打开。
    try {
      const err = await shell.openPath(r.hit.path)
      if (err) return { ok: false, error: '打开失败：' + err }
      return { ok: true, path: r.hit.path, rel: r.hit.rel, project: r.project }
    } catch (e: any) {
      return { ok: false, error: '打开失败：' + (e?.message || e) }
    }
  })

  // ── 层厚度（2026-11-16 · 骨架继承试点第一批）────────────────────────
  // 由来：暮雨 2026-11-15「骨架补齐以后，规划会自己长出来」+ 2026-11-16
  // 「横比表和单项目报告都要，因为用户根本没空去数目录半小时」。
  //
  // 这两条只回答一件事：**层 → 文件数 → 行数 → 占比**，以及一句「号称是 A，
  // 但 88% 在 B」。不猜架构、不给建议、不写任何项目仓库（只读扫盘）。
  // 口径与踩过的五个假数坑写在 services/layerScan.ts 顶部。
  guardedHandle('layer:profile', (_event, projectId: string, opts?: any) => {
    const pid = String(projectId || '').trim()
    if (!pid) return { ok: false, missing: '没指定项目' }
    const proj: any = data.parseRegistry().find((p: any) => p.id === pid)
    if (!proj) return { ok: false, id: pid, missing: `registry 里没有项目「${pid}」` }
    return layerScan.profileProject(
      { id: String(proj.id || pid), name: String(proj.name || pid), repo: String(proj.repo || '') },
      { depth: Number(opts?.depth) || 3, force: opts?.force === true },
    )
  })

  // 横比：一次扫 registry 里全部项目。**慢是应该的**（十几个仓库的盘），
  // 所以按天缓存，界面上要显示"今天读过 / 刚读"（同 repoDocs 的既有口径）。
  guardedHandle('layer:board', (_event, opts?: any) => {
    const list = data.parseRegistry().map((p: any) => ({
      id: String(p.id || ''), name: String(p.name || ''), repo: String(p.repo || ''),
    })).filter((p: any) => p.id)
    return layerScan.profileAll(list, {
      depth: Number(opts?.depth) || 3,
      force: opts?.force === true,
    })
  })

  // spec 的**唯一真源**在 task-data/layer-specs/<id>.json。
  // 这条只读回来给界面显示"这个项目的分层是谁给的、有没有写坏"，
  // 写 spec 仍是用户的动作（跟问卷/决策同一条边界：agent 不替人定口径）。
  guardedHandle('layer:spec', (_event, projectId: string) => {
    const pid = String(projectId || '').trim()
    if (!pid) return { ok: false, error: '没指定项目' }
    const { spec, error } = layerScan.readSpec(pid)
    return {
      ok: !error,
      error,
      spec,
      path: layerScan.specPathFor(pid),
      exists: !!spec,
    }
  })

  // ── 竞品档案（2026-11-17）────────────────────────────────────────────
  // 由来：竞品能力 10-17 拍板、11-07 做完数据层 + CLI，但**桌面端一个界面都没有**。
  // 实测 `desktop/src` 下 0 个文件提到 competitor —— 没人知道有这功能，于是永远没数据。
  // 这三条把后半段接上（口径全在 services/competitors.ts 顶部，不在这里重写）。
  guardedHandle('competitor:overview', () => competitors.competitorOverview())
  guardedHandle('competitor:readReport', (_event, projectId: string, fileName: string) =>
    competitors.readReport(String(projectId || ''), String(fileName || '')))
  // 唯一会写盘的：生成采集任务单给 agent。写到数据根，**不写项目仓库**。
  guardedHandle('competitor:writeTask', (_event, projectId: string) =>
    competitors.writeTaskFile(String(projectId || '')))

  // ── 方寸自绘架构图（2026-10-30，卡 task-20261030-002）────────────────
  // 与上面那条的分工：archify 产物 = 打开别人画的；这两条 = 方寸**自己只读扫源码**出图。
  // 扫描纪律写在 services/projectArch.ts 顶部（只读 / 不联网 / 不写项目仓库）。
  guardedHandle('arch:get', (_event, projectId: string, opts?: any) => {
    // opts：strict = 驳回后重画；excluded = 人工剔掉的节点（2026-10-30 第 3 条）
    return archForProject(String(projectId || ''), {
      strict: opts?.strict === true,
      excluded: Array.isArray(opts?.excluded) ? opts.excluded.map((x: any) => String(x || '')) : [],
    })
  })
  // 导出：用户点“导出 HTML”→ 选保存位置 → 才写盘（默认落在该仓库 docs/ 下，
  // 但**写这个动作是用户做的**，方寸不自动往项目仓库写）。
  guardedHandle('arch:export', async (_event, projectId: string, opts?: any) => {
    const r = archForProject(String(projectId || ''), {
      strict: opts?.strict === true,
      excluded: Array.isArray(opts?.excluded) ? opts.excluded.map((x: any) => String(x || '')) : [],
    })
    if (!r.ok || !r.graph) return { ok: false, error: r.error || '这张图生成失败' }
    // 校验没过不许导出（2026-10-30 第 3 条）：图是给人看的，不是把诊断一起塞进 HTML 就算完。
    if (r.review && !r.review.ok) {
      return { ok: false, error: '这张图还有校验没过，先按提示重画或剔除问题节点：' + r.review.text }
    }
    const safe = String((r.project && r.project.name) || '项目').replace(/[\\/:*?"<>|]/g, '_')
    const defDir = path.join(String(r.repo || ''), 'docs')
    const defaultPath = path.join(fs.existsSync(defDir) ? defDir : String(r.repo || ''), `方寸架构图-${safe}.html`)
    const win = BrowserWindow.getFocusedWindow()
    const picked = win
      ? await dialog.showSaveDialog(win, { title: '导出架构图 HTML', defaultPath, filters: [{ name: 'HTML', extensions: ['html'] }] })
      : await dialog.showSaveDialog({ title: '导出架构图 HTML', defaultPath, filters: [{ name: 'HTML', extensions: ['html'] }] })
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
    try {
      fs.writeFileSync(picked.filePath, renderArchHtml(r.graph), 'utf8')
      return { ok: true, path: picked.filePath }
    } catch (e: any) {
      return { ok: false, error: '写入失败：' + (e?.message || e) }
    }
  })


  // ── 方寸自绘架构图 · AI 生成（2026-11-02 重做，卡 task-20261030-002）──────────
  // 与 arch:get 的分工：`arch:get` 是"打开就看"的只读口，**绝不调模型**；
  // 这里才是"点一下才花钱"的口 —— 模型画图 → 逐条证据审计 → 不过按意见重画 → 仍不过降级扫描图。
  // ── 架构图生成：进度 / 取消 / 上次结果（2026-11-07，修 11-03 驳回的三条）──
  // 驳回原话：「生成失败，降级为扫描图。且生成过程可能耗时很长（没其他提示，挂着窗口干等），
  //            用户等不及会点关闭，是否有影响？」
  // 现在的答案：
  //   · 进度 → 事件推给界面（第几次 / 在干嘛），不是只转个圈；
  //   · 取消 → 每次调用前检查，取消后**不写任何图**；
  //   · 关窗 → 上次结果落 `arch-last.json`，重开面板能查到"上次怎么了"。
  const archCancelled = new Set<string>()
  const archLastPath = () => path.join(data.getDataDir(), 'arch-last.json')
  const readArchLast = (): Record<string, any> => {
    try { return JSON.parse(fs.readFileSync(archLastPath(), 'utf-8')) || {} } catch { return {} }
  }
  const writeArchLast = (pid: string, rec: any): void => {
    try {
      const all = readArchLast()
      all[pid] = rec
      fs.mkdirSync(path.dirname(archLastPath()), { recursive: true })
      fs.writeFileSync(archLastPath(), JSON.stringify(all, null, 2), 'utf-8')
    } catch { /* 落盘失败不该挡住本次结果 */ }
  }

  guardedHandle('arch:lastRun', (_e, projectId: string) => {
    const rec = readArchLast()[String(projectId || '')]
    return rec ? { ok: true, ...rec } : { ok: true, none: true }
  })

  guardedHandle('arch:cancel', (_e, projectId: string) => {
    archCancelled.add(String(projectId || ''))
    return { ok: true }
  })

  guardedHandle('arch:generate', async (event, projectId: string) => {
    const pid = String(projectId || '')
    archCancelled.delete(pid)
    const started = Date.now()
    try {
      const v = archForProject(pid)
      if (!v.ok || !v.facts) return { ok: false, error: v.error || '扫不出可用的扫描事实' }
      const push = (p: any) => {
        try { event.sender.send('arch:progress', { projectId: pid, ...p }) } catch { /* 窗口关了就算了 */ }
      }
      const r = await generateArchGraph(v.facts, {
        onProgress: push,
        shouldAbort: () => archCancelled.has(pid),
      })
      const rec = {
        at: new Date().toISOString(),
        source: r.source,
        cancelled: r.cancelled === true,
        failKind: r.failKind || '',
        reason: r.reason || '',
        attempts: r.attempts,
        model: r.model || '',
        ms: Date.now() - started,
      }
      writeArchLast(pid, rec)
      return {
        ok: true,
        source: r.source,
        graph: r.graph,
        reason: r.reason,
        attempts: r.attempts,
        issues: r.audit ? r.audit.issues : [],
        notes: r.audit ? r.audit.notes : [],
        usage: r.usage,
        model: r.model,
        failKind: r.failKind || '',
        cancelled: r.cancelled === true,
        repaired: r.repaired === true,
      }
    } catch (e: any) {
      writeArchLast(pid, { at: new Date().toISOString(), source: 'scan', failKind: 'call_failed', reason: String(e?.message || e), ms: Date.now() - started })
      return { ok: false, error: e?.message || String(e) }
    } finally {
      archCancelled.delete(pid)
    }
  })

  guardedHandle('mismatch:check', async (_event, days?: number) => {
    // 空值单独判：Number('') 和 Number(null) 都是 0，而 0 在这里是"不算过期"——直接 Number 会把它静默变成 0
    const blank = days === undefined || days === null || String(days).trim() === ''
    const raw = blank ? 3 : Number(days)
    const win = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 3
    return await checkMismatch({ days: win })
  })

  // ── 需求矩阵（RICE · 2026-10-28）────────────────────────────────────
  // 页签只读/写池文件，**零网络**（格式闸红线）。分数与等级的算法在 `shared/rice.ts`，
  // 这里不重复实现任何口径 —— 界面拿到整池后自己算，主进程只负责数据与审计。
  guardedHandle('rice:get', () => rice.getRicePool())
  guardedHandle('rice:upsert', (_event, items: any[], meta?: any) => {
    return rice.upsertRiceItems(Array.isArray(items) ? items : [], {
      by: meta?.by, batch: meta?.batch,
    })
  })
  guardedHandle('rice:decide', (_event, items: any[], meta?: any) => {
    return rice.recordRiceDecisions(Array.isArray(items) ? items : [], { batch: meta?.batch })
  })
  guardedHandle('rice:setBudget', (_event, budget: number) => rice.setRiceBudget(Number(budget)))

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

  // ⚠ 2026-10-16（用户第 2 条）：`services:startApp` 通道已删。
  //   原设计是"启动一个启动台应用 + 观测它开了哪些端口"，但启动台被正名为**快捷入口**
  //   （用户原话：类似 steam 启动非 steam 游戏的入口，方寸本身不提供服务）——
  //   启动应用回“启动台”页走 `launchpad:launchApp`，本页（服务/端口）只管端口监控。
  //   实现本体 `startAppAndObserve` 保留在 `services/portRegistry.ts`（e2e-ports 仍在测），
  //   只是不再有 IPC 入口。

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

/**
 * 链接解析的三个可信基准（2026-11-05 暮雨第 10 条）。
 * 判据与纯逻辑在 `shared/linkPath.ts`（e2e-linkpath 用真临时目录跑，含 `../` 越界反例）。
 */
function linkRoots(): string[] {
  const roots: string[] = []
  try { roots.push(data.getDataDir()) } catch { /* 数据根取不到就少一条基准 */ }
  try {
    for (const p of data.parseRegistry()) {
      const r = String(p?.repo || '').trim()
      if (r) roots.push(r)
    }
  } catch { /* registry 坏了不该连带打不开文件 */ }
  return roots.filter((r, i, a) => !!r && a.indexOf(r) === i)
}

/**
 * 打开一个文件 / 目录 / 链接目标。
 *
 * 2026-11-05 改法（第 10 条 + 10-30 白屏事故的合并修法）：
 * ① 相对路径按数据根 / 项目仓库解析（见 resolveLinkPath）；
 * ② 改用异步 `shell.openPath` —— 旧的 `execFileSync('cmd', ['/c','start', …])`
 *    在本机实测会 EBUSY，而且把主进程堵在那里；打不开还会**没有任何可见反馈**；
 * ③ 可执行 / 安装包**不直接运行**，只定位 —— 与附件同一套判据（shared/attachments），
 *    这正是 10-30 "点安装包 → 方寸白屏" 的那条教训，不能再从这条通道绕过去。
 */
async function validateAndOpenFile(filePath: string): Promise<{ ok: boolean; error?: string; path?: string; needsReveal?: boolean; hint?: string }> {
  const abs = resolveLinkPath(filePath, linkRoots())
  if (!abs) {
    return { ok: false, error: `找不到这个文件：${String(filePath || '').trim() || '(空路径)'}` }
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch (e: any) {
    return { ok: false, error: `读不到这个路径：${e?.message || e}`, path: abs }
  }
  if (!stat.isDirectory()) {
    const policy = attachmentOpenPolicy(abs)
    if (!policy.run) {
      try { shell.showItemInFolder(abs) } catch { /* 定位失败也得把原因回给用户 */ }
      return { ok: false, needsReveal: true, path: abs, error: policy.reason, hint: policy.hint }
    }
  }
  try {
    const err = await shell.openPath(abs)
    return err ? { ok: false, error: `系统打不开：${err}`, path: abs } : { ok: true, path: abs }
  } catch (e: any) {
    return { ok: false, error: `打开失败：${e?.message || e}`, path: abs }
  }

}
