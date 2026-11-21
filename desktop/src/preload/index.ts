import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('tegula', {
  selfCheck: () => ipcRenderer.invoke('selfCheck'),
  getDataDir: () => ipcRenderer.invoke('getDataDir'),

  /**
   * 真退出（2026-11-17 · 卡 p0-1「不同意并退出」永远退不掉）。
   *
   * ⚠ 别用 `window.close()` 代替它：主进程在 close 事件里把它防抖成 `hide()`
   *   （"关窗≠退出、常驻托盘"是设计），所以 window.close() 只会让窗口消失、进程留在托盘。
   *   这条通道由主进程置位 isQuitting 再 quit，是唯一真能退出的路。
   */
  quitForReal: () => ipcRenderer.invoke('app:quitForReal'),

  // 许可协议总闸（2026-11-18）：渲染层只能读/签，不能替别人签 —— IPC 不出主窗口。
  licenseStatus: () => ipcRenderer.invoke('license:status'),
  licenseAck: () => ipcRenderer.invoke('license:ack'),

  // 记忆层（2026-11-17）：检索 / 读原文 / 概览 / 重建索引。只读为主，写走 agent 落盘。
  memorySearch: (q: any) => ipcRenderer.invoke('memorySearch', q),
  memoryRead: (file: string) => ipcRenderer.invoke('memoryRead', file),
  memoryOverview: () => ipcRenderer.invoke('memoryOverview'),
  memoryRebuild: () => ipcRenderer.invoke('memoryRebuild'),
  // 写入（2026-11-18）：记忆是用户资产，他自己也得能改 —— 不该只有 agent 能落盘
  memoryCreate: (input: any) => ipcRenderer.invoke('memoryCreate', input),
  memoryUpdate: (file: string, input: any) => ipcRenderer.invoke('memoryUpdate', file, input),
  memorySetStatus: (file: string, status: string, reason?: string) => ipcRenderer.invoke('memorySetStatus', file, status, reason || ''),
  // 导入 / 一键整理（2026-11-20）：都落待审批，重复跳过
  memoryImport: (input: any) => ipcRenderer.invoke('memoryImport', input),
  memoryOrganize: (input: any) => ipcRenderer.invoke('memoryOrganize', input),
  /** 批量改分类/标签/参数（不碰正文与状态） */
  memoryBatchUpdate: (files: string[], patch: any) => ipcRenderer.invoke('memoryBatchUpdate', files, patch),
  /** 有新待审批 → 通知中心/系统通知（主进程自己算 count，不信渲染层） */
  memoryNotifyPending: () => ipcRenderer.invoke('memoryNotifyPending'),
  
  // Tasks
  loadTasks: (view = 'active') => ipcRenderer.invoke('loadTasks', view),
  newTask: (fields: any) => ipcRenderer.invoke('newTask', fields),
  editTask: (id: string, fields: any) => ipcRenderer.invoke('editTask', id, fields),
  /** 任务卡历史版本（2026-10-18 卡 001）：列表 / 单版预览 / 恢复到指定版本 */
  tasksVersions: (id: string) => ipcRenderer.invoke('tasks:versions', id),
  tasksVersionGet: (id: string, file: string) => ipcRenderer.invoke('tasks:versionGet', id, file),
  tasksRestoreVersion: (id: string, file: string) => ipcRenderer.invoke('tasks:restoreVersion', id, file),
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
  // `scanProjectStatus` 死通道已删（2026-10-11，卡 20261006-002 E 组）：
  // 渲染层从不调（项目进度走 allProjectProgress），MCP 侧直接调 `tasks.scanProjectStatus()` 函数、不走 IPC。
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
  // `getProjectProgress` 死通道已删（2026-10-11）：渲染层用 allProjectProgress（一次全量，避免 N 次全扫）；
  // 函数本体保留 —— bench-load / e2e-task-fields 直接调它做基准与断言。
  allProjectProgress: () => ipcRenderer.invoke('allProjectProgress'),

  // Plan
  createPlan: (fields: any) => ipcRenderer.invoke('createPlan', fields),
  listPlans: () => ipcRenderer.invoke('listPlans'),
  getPlan: (id: string) => ipcRenderer.invoke('getPlan', id),
  decidePlanPoint: (id: string, dpId: string, choice: string) => ipcRenderer.invoke('decidePlanPoint', id, dpId, choice),
  // `findTimeoutTasks` 死通道已删（2026-10-11）：它是**既有命名误导**（只算“派活→现在”，与文件变没变无关），
  // 真僵尸卡判据是下面的 stalledTasks；函数本体保留给内部 detectEvents 用。
  stalledTasks: (thresholdHours?: number) => ipcRenderer.invoke('stalledTasks', thresholdHours),
  
  // Registry
  registryAddProject: (fields: any) => ipcRenderer.invoke('registry:addProject', fields),
  registryRemoveProject: (id: string) => ipcRenderer.invoke('registry:removeProject', id),
  /** 项目说明三字段（状态 / 路线图 / 说明）—— 2026-10-22 施工单包 06 */
  registryReadFields: (id: string) => ipcRenderer.invoke('registry:readFields', id),
  registryUpdateFields: (id: string, patch: any) => ipcRenderer.invoke('registry:updateFields', id, patch),

  // ── 随问（2026-10-22 · 03 任务一）：结构化查询，零 LLM ──────────────
  askPresets: () => ipcRenderer.invoke('ask:presets'),
  askQuery: (q: string) => ipcRenderer.invoke('ask:query', q),
  /** agent 上下文包（2026-10-22）：把项目现状拼成一段可粘贴的 Markdown，只读 */
  contextPack: (projectId: string, opts?: any) => ipcRenderer.invoke('context:pack', projectId, opts),
  contextPackFile: (projectId: string) => ipcRenderer.invoke('context:packFile', projectId),
  /**
   * 发送给 DSH（2026-11-17）：只落一份派单文件，插件看见就会在 DSH 里开新会话。
   * `kind` = 'work'（默认，马上干活）| 'plan'（做规划，产出机检判据）。
   *
   * ⚠ 文案口径：UI 上是「发送给 DSH」；暮雨 2026-11-17：「🧠 派给 DSH 按钮太丑了，
   *   改成『发送给DSH』都能让人看懂」。方法名 `dispatchDsh` 是内部标识，沿用旧名。
   */
  dispatchDsh: (projectId: string, kind?: 'work' | 'plan') => ipcRenderer.invoke('context:dispatchDsh', projectId, kind),
  /**
   * 带任务书的派单（2026-11-20 · D-150）：文档拆卡 / 出单改成 DSH 派单。
   * `message` = 界面固定生成的任务书（不是 agent 自由文本）；方寸只落文件，不调模型。
   */
  dispatchMessageDsh: (projectId: string, kind: 'work' | 'plan', message: string) =>
    ipcRenderer.invoke('context:dispatchMessage', projectId, kind, message),
  /** 开工简报（2026-11-16 · 治病①）：上次做到哪 / 这次先做什么 / 有哪些规矩别犯。只读 */
  brief: (projectId: string) => ipcRenderer.invoke('brief:get', projectId),
  briefFile: (projectId: string) => ipcRenderer.invoke('brief:write', projectId),
  /** 随纠（03 任务二）：一句话改项目方向，决策卡留痕；undo 用 apply 回传的 before 反推 */
  correctPreview: (text: string, projectId?: string) => ipcRenderer.invoke('correct:preview', text, projectId),
  correctApply: (text: string, projectId?: string) => ipcRenderer.invoke('correct:apply', text, projectId),
  correctUndo: (args: any) => ipcRenderer.invoke('correct:undo', args),

  // ── 备份 v2（WebDAV + 调度 + 可验证恢复）
  backupGetConfig: () => ipcRenderer.invoke('backup:getConfig'),
  backupSetConfig: (patch: any) => ipcRenderer.invoke('backup:setConfig', patch),
  backupStatus: () => ipcRenderer.invoke('backup:status'),
  backupRun: (opt?: { password?: string }) => ipcRenderer.invoke('backup:run', opt),  backupRunLocalOnly: (opt?: { password?: string }) => ipcRenderer.invoke('backup:runLocalOnly', opt),
  backupListLocal: () => ipcRenderer.invoke('backup:listLocal'),
  backupListRemote: () => ipcRenderer.invoke('backup:listRemote'),
  backupTestRemote: (input: any) => ipcRenderer.invoke('backup:testRemote', input),
  backupRestore: (source: any, password?: string) => ipcRenderer.invoke('backup:restore', source, password),
  backupLog: (lines?: number) => ipcRenderer.invoke('backup:log', lines),
  backupOpenDir: () => ipcRenderer.invoke('backup:openDir'),
  backupExportTo: (input: any) => ipcRenderer.invoke('backup:exportTo', input),
  backupVerifyPackage: (zipPath?: string, password?: string) => ipcRenderer.invoke('backup:verifyPackage', zipPath, password),
  backupResticScript: (os?: 'win' | 'posix') => ipcRenderer.invoke('backup:resticScript', os),
  // 体积报告（2026-10-11 用户第 2 条）：把"备份范围里什么最占地方、按当前瘦身设置会跳过什么"摊开
  backupSizeReport: () => ipcRenderer.invoke('backup:sizeReport'),
  // 作战计划（0.6.0 P1）：只有读与裁决两个口
  plansGet: (file?: string) => ipcRenderer.invoke('plans:get', file),
  plansVerdict: (input: { file: string; stageId: string; action: 'pass' | 'reject' | 'amend'; text?: string }) =>
    ipcRenderer.invoke('plans:verdict', input),
  // 作战计划 · 跑判据 / 推进（0.6.0 P4 界面入口）：只有人点才会起进程，打开卡不会
  plansChecks: (input: { file: string; stageId: string; repo?: string }) =>
    ipcRenderer.invoke('plans:checks', input),
  plansAdvance: (input: { file: string; stageId: string; repo?: string }) =>
    ipcRenderer.invoke('plans:advance', input),
  // 规划草案入口（2026-11-11 · 0.7.0 规划根基）：读草案（含「缺什么」与可选澄清卷）
  plansDrafts: () => ipcRenderer.invoke('plans:drafts'),
  // 草案某一格 → 真阶段卡：**走同一条闸**（proposeStage），不另开写口。
  // 2026-11-12：`patch` 是提成时在界面上就地改过的三块（技术方案 / 照抄点 / 判据）；
  // 不带 = 整格原样提。草案文件本身永远只读。
  plansProposeFromDraft: (input: {
    draft: string; stageId: string; deck: string
    patch?: { approach?: string[]; copyRows?: string[][]; criteria?: string[] }
  }) => ipcRenderer.invoke('plans:proposeFromDraft', input),
  // 投入产出账（0.6.0 P5）：只读
  wasteGet: (opts?: { days?: number; repo?: string }) => ipcRenderer.invoke('waste:get', opts),
  // 计划与实际的对照镜（卡 20261027-004）：只读，返回两段原文
  mirrorGet: (taskId: string) => ipcRenderer.invoke('mirror:get', taskId),
  /** 跨渠道 token 对比（0.6.0 第 2 批）：只读，只比 token */
  channelsGet: (opts?: { days?: number; channels?: string[] }) => ipcRenderer.invoke('channels:get', opts),
  /** 大附件（2026-10-30 卡 004）：只列不删；删除是用户点、主进程校验路径在附件目录内 */
  backupBigAttachments: (minMb?: number) => ipcRenderer.invoke('backup:bigAttachments', minMb),
  backupDeleteAttachment: (rel: string) => ipcRenderer.invoke('backup:deleteAttachment', rel),
  backupOpenAttachments: () => ipcRenderer.invoke('backup:openAttachments'),
  // Git 通道（2026-10-11）：只推不拉；令牌在渲染层只出现一次（填进去），之后再没回传
  backupGitStatus: () => ipcRenderer.invoke('backup:gitStatus'),
  backupGitSave: (patch: any) => ipcRenderer.invoke('backup:gitSave', patch),
  backupGitSaveToken: (token: string, username?: string) => ipcRenderer.invoke('backup:gitSaveToken', token, username),
  backupGitClearToken: () => ipcRenderer.invoke('backup:gitClearToken'),
  backupGitTest: () => ipcRenderer.invoke('backup:gitTest'),
  // 2026-10-11 用户第 1 条：改成把**真实文件**镜像进仓库（不再推压缩包），所以没有入参
  backupGitPush: () => ipcRenderer.invoke('backup:gitPush'),
  /**
   * 同步阶段流（2026-10-25 卡 004）：主进程真走到哪一步就报哪一步。
   * 返回退订函数（组件卸载/重开时要摘掉，别越挂越多）。
   */
  onSyncProgress: (cb: (p: { phase: string; at: number }) => void) => {
    const listener = (_e: any, p: any) => cb(p)
    ipcRenderer.on('sync:progress', listener)
    return () => ipcRenderer.removeListener('sync:progress', listener)
  },
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
  // “渲染层零调用”—— 界面里从来没有过笔记入口。`notes/` 数据文件没动。

  // ── Tasks Import/Export（设置页“导出/导入任务 JSON”按钮）────────────
  // 此前渲染层在调 window.tegula.exportTasks/importTasks，主进程也注册了同名
  // handler（ipc.ts），唯独 preload 这层没有暴露 → 点击必 TypeError（僵尸按钮第 4、5 例）。
  exportTasks: () => ipcRenderer.invoke('exportTasks'),
  importTasks: (data: any[]) => ipcRenderer.invoke('importTasks', data),

  // Logs
  logsList: (filter?: any) => ipcRenderer.invoke('logs:list', filter),
  logsForTask: (taskId: string) => ipcRenderer.invoke('logs:forTask', taskId),
  logsGet: (id: string) => ipcRenderer.invoke('logs:get', id),
  logsCreate: (title: string, project: string, content: string, taskId?: string, extra?: { sessionId?: string; agentName?: string; prevAgentName?: string; logDate?: string; taskIds?: string[]; nextSteps?: string; continueFrom?: string; priority?: string; fromTodo?: string }) => ipcRenderer.invoke('logs:create', title, project, content, taskId, extra),
  logsUpdate: (id: string, updates: any) => ipcRenderer.invoke('logs:update', id, updates),
  /** 该日志本地留着的历史版本（最新在前）—— 列表带标题 / 时间 / 大小 */
  logsVersions: (id: string) => ipcRenderer.invoke('logs:versions', id),
  /** 单版预览（正文按需读，避免一次把 10 版全文塞给渲染层） */
  logsVersionGet: (id: string, file: string) => ipcRenderer.invoke('logs:versionGet', id, file),
  /** 恢复到指定历史版本（写前自动备份当前版） */
  logsRestoreVersion: (id: string, file: string) => ipcRenderer.invoke('logs:restoreVersion', id, file),
  logsComplete: (id: string, retainDays: number | null, note?: string) => ipcRenderer.invoke('logs:complete', id, retainDays, note),
  logsArchive: (id: string, note?: string) => ipcRenderer.invoke('logs:archive', id, note),
  /** 撤销完成 / 撤销归档，退回“待处理”（2026-09-28：不再等于“进行中”） */
  logsReopen: (id: string) => ipcRenderer.invoke('logs:reopen', id),
  /** 读状态快照 / 按快照还原（2026-10-30 撤销要回到点之前那一格，含“进行中”） */
  logsStateSnapshot: (id: string) => ipcRenderer.invoke('logs:stateSnapshot', id),
  logsRestoreState: (id: string, snap: any) => ipcRenderer.invoke('logs:restoreState', id, snap),
  /** 主日志 + 附属日志（2026-10-30 暮雨第 4 条）：关系落盘，一键全进行中 / 全完成 */
  logsSetAttached: (mainId: string, ids: string[]) => ipcRenderer.invoke('logs:setAttached', mainId, ids),
  logsGroupRunning: (mainId: string, running: boolean) => ipcRenderer.invoke('logs:groupRunning', mainId, running),
  logsGroupComplete: (mainId: string, retainDays: number | null, note?: string) => ipcRenderer.invoke('logs:groupComplete', mainId, retainDays, note),
  /** 手动开 / 关“进行中”（2026-09-28 用户第 2 条）。可撤销，且不是完成/归档的前置条件。 */
  logsSetRunning: (id: string, running: boolean) => ipcRenderer.invoke('logs:setRunning', id, running),
  logsDestroy: (id: string) => ipcRenderer.invoke('logs:destroy', id),
  // logs:search 已删（2026-10-01）：搜索改由 logs:list 的 filter.query 承担，
  // 与项目/Agent/日期筛选同一条取数路径（此前两条路互不相干，一刷新搜索就丢）。
  // 需要"全文搜"的调用方（MCP search_logs）直接用 services/logs.ts 的 searchLogs()。
  logsInject: (id: string) => ipcRenderer.invoke('logs:inject', id),
  /** 多条日志拼成一份开工单（第一条当主日志，其余标“并行日志”）—— 与 MCP inject_logs 同一段文本 */
  logsInjectMany: (ids: string[]) => ipcRenderer.invoke('logs:injectMany', ids),
  /**
   * 附件（2026-10-01 卡 036）：主进程弹系统选文件框 → 复制进数据目录 → 返回更新后的日志。
   * 2026-10-25（第 4 条）：传 `sources` 时**不再弹框**，直接用这批路径 —— 新建日志时先选好，
   * 存好之后再挂（`logsPickFiles` 拿路径 → 保存成功 → 带 sources 调这里）。
   */
  logsAttachFiles: (logId: string, sources?: string[]) => ipcRenderer.invoke('logs:attachFiles', logId, sources),
  /** 只弹选文件框、拿路径，不落盘（新建态用；落盘要等日志有 id） */
  logsPickFiles: () => ipcRenderer.invoke('logs:pickFiles'),
  /** 粘贴图片：data URL → 主进程校验（mime 白名单 / 20MB / 文件名清洗）→ 落盘 */
  logsAttachData: (logId: string, items: Array<{ name?: string; dataUrl: string }>) =>
    ipcRenderer.invoke('logs:attachData', logId, items),
  /** 解除关联（文件不删） */
  logsDetachAttachment: (logId: string, rel: string) => ipcRenderer.invoke('logs:detachAttachment', logId, rel),
  /** 附件 → data URL（预览唯一通道）；超大文件返回 tooLarge */
  logsAttachmentData: (rel: string) => ipcRenderer.invoke('logs:attachmentData', rel),
  /** 用系统程序打开附件 */
  logsOpenAttachment: (rel: string) => ipcRenderer.invoke('logs:openAttachment', rel),
  /** 可执行/安装包附件不直接运行，只在文件夹中定位（2026-10-30 白屏事故） */
  logsRevealAttachment: (rel: string) => ipcRenderer.invoke('logs:revealAttachment', rel),
  /** 复制到剪贴板（主进程通道：不受 file:// 起源与窗口焦点限制，见 shared/clipboard.ts） */
  clipboardWriteText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
  /** UI 偏好（真身在主进程 prefs.json，见 main/services/prefs.ts） */
  prefsGet: () => ipcRenderer.invoke('prefs:get'),
  prefsSet: (key: string, value: any) => ipcRenderer.invoke('prefs:set', key, value),
  /** MCP 写口（2026-11-11 卡《MCP 写口无闸》）：档位读 / 改档 / 最近写侧清单 */
  mcpWriteMode: () => ipcRenderer.invoke('mcp:writeMode'),
  mcpSetWriteMode: (mode: string) => ipcRenderer.invoke('mcp:writeModeSet', mode),
  mcpWrites: (limit?: number) => ipcRenderer.invoke('mcp:writes', limit),
  /** 运行态（2026-11-11 卡 20261017-002）：客户端态 / 开发态 + 判断依据 */
  appMode: () => ipcRenderer.invoke('app:mode'),
  /** 项目梯度榜（2026-10-25）：只给项目页的“梯度榜”摆法用，见 services/projectTiers.ts */
  /** 项目结构图（方寸内核：项目 → 在途 → 已完成 → 日志；不是代码架构图） */
  projectDiagram: (projectId: string) => ipcRenderer.invoke('project:diagram', projectId),
  /** 方寸自绘架构图（2026-10-30）：只读扫源码 → 图模型；导出由用户选保存位置 */
  archGet: (projectId: string, opts?: { strict?: boolean; excluded?: string[] }) => ipcRenderer.invoke('arch:get', projectId, opts),
  archExport: (projectId: string, opts?: { strict?: boolean; excluded?: string[] }) => ipcRenderer.invoke('arch:export', projectId, opts),
  /** AI 生成图（0.6.0）：点一下才会调模型；返回 source=ai|scan，界面按它写"生成图 / 扫描图" */
  archGenerate: (projectId: string) => ipcRenderer.invoke('arch:generate', projectId),
  // 2026-11-07（修 11-03 驳回）：进度推送 / 取消 / 上次结果
  archCancel: (projectId: string) => ipcRenderer.invoke('arch:cancel', projectId),
  archLastRun: (projectId: string) => ipcRenderer.invoke('arch:lastRun', projectId),
  /** 进度订阅；返回取消订阅函数（组件卸载要解掉，否则每次重开都多一个监听） */
  onArchProgress: (cb: (p: any) => void) => {
    const h = (_e: any, p: any) => cb(p)
    ipcRenderer.on('arch:progress', h)
    return () => { try { ipcRenderer.removeListener('arch:progress', h) } catch { /* ignore */ } }
  },
  /** 层厚度（2026-11-16）：只读扫盘，回答「层 → 文件数 → 行数 → 占比」 */
  layerProfile: (projectId: string, opts?: { depth?: number; force?: boolean }) => ipcRenderer.invoke('layer:profile', projectId, opts),
  layerBoard: (opts?: { depth?: number; force?: boolean }) => ipcRenderer.invoke('layer:board', opts),
  layerSpec: (projectId: string) => ipcRenderer.invoke('layer:spec', projectId),
  /** 竞品档案（2026-11-17）：读 registry 的 competitors 段 + 读采集回填目录 */
  competitorOverview: () => ipcRenderer.invoke('competitor:overview'),
  competitorReadReport: (projectId: string, fileName: string) =>
    ipcRenderer.invoke('competitor:readReport', projectId, fileName),
  /** 生成采集任务单给 agent（唯一写盘动作，写数据根不写项目仓库） */
  competitorWriteTask: (projectId: string) => ipcRenderer.invoke('competitor:writeTask', projectId),
  /** 整理体检（2026-10-30）：没人碰过 + 驳回没人管，两批清理候选一起给 */
  cleanupScan: (days?: number) => ipcRenderer.invoke('cleanup:scan', days),
  projectTiersGet: () => ipcRenderer.invoke('projectTiers:get'),
  projectTiersSet: (tiers: unknown) => ipcRenderer.invoke('projectTiers:set', tiers),
  /** 一次写多个键（合并为一次读-改-写，并回读校验）；返回 { ok, written, error } */
  prefsSetMany: (patch: Record<string, any>) => ipcRenderer.invoke('prefs:setMany', patch),
  logsCleanup: () => ipcRenderer.invoke('logs:cleanup'),
  /** 按日期批量清理“已归档”日志（软删：移进 logsDir/.trash，可恢复）。dryRun=只报命中条数 */
  logsPurgeArchived: (beforeDate: string, opts?: { dryRun?: boolean }) => ipcRenderer.invoke('logs:purgeArchived', beforeDate, opts),

  // Blockers
  getBlockerChains: () => ipcRenderer.invoke('getBlockerChains'),
  /** Git 联动（卡 017）：只读某张卡存续期间它所属仓库的提交 + 提到本卡 ID 的提交 */
  gitTaskCommits: (taskId: string) => ipcRenderer.invoke('git:taskCommits', taskId),
  /** 方寸自仓启动同步状态（2026-10-21 · W1-1C）：只读；界面用它显示“待同步” */
  selfSyncStatus: () => ipcRenderer.invoke('sync:selfStatus'),
  /** 项目路线文档实况（2026-10-21 · W1-批次 2）：只读 README/ROADMAP + 最近 docs 变更；一天一批 */
  projectDocs: (projectId: string) => ipcRenderer.invoke('project:docs', projectId),
  
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
  /**
   * 通知列表变更广播（2026-11-21）：主进程每次落盘变更后推一次。
   * 返回退订函数；老版本没有这条，调用方要按“可选增强”处理。
   */
  onNotificationsChanged: (cb: () => void) => {
    const fn = () => { try { cb() } catch { /* 渲染层自己处理 */ } }
    ipcRenderer.on('notifications:changed', fn)
    return () => ipcRenderer.removeListener('notifications:changed', fn)
  },
  // 2026-10-01 P0-4/P0-5：扫描器状态 + 被静音提醒的可见与恢复
  notificationsScannerStatus: () => ipcRenderer.invoke('notifications:scannerStatus'),
  notificationsListMuted: () => ipcRenderer.invoke('notifications:listMuted'),
  notificationsUnmuteAll: () => ipcRenderer.invoke('notifications:unmuteAll'),

  // Services / Workbench
  // `scanServices` 死通道已删（2026-10-11，卡 20261006-002 E 组）：服务页走 servicesAdd/Remove/Open，
  // 端口清单来自 `ports:*`；MCP 侧直接调 `services.scanServices()` 函数、不走 IPC。
  // LLM：只保留用量/单价（BYOK 配置与模型调用已退役）
  // 2026-10-17 暮雨第 10 条“花销可见”：累计 token / 次数（数据源 = ai-trace.jsonl）
  llmUsageStats: (days?: number) => ipcRenderer.invoke('llm:usageStats', days),
  /** 月度花销（2026-10-22 · 03 任务三）：按自然月切，不是滚动 30 天 */
  llmUsageMonthly: (months?: number) => ipcRenderer.invoke('llm:usageMonthly', months),
  /** 模型单价（2026-10-25 卡 005 B 档）：元/百万 tokens，用户自己填；空表 = 一律未折算 */
  llmGetPrices: () => ipcRenderer.invoke('llm:getPrices'),
  llmSetPrices: (rows: any) => ipcRenderer.invoke('llm:setPrices', rows),
  // GUI 自调用模型的通道（config/balance/chat/planning）已按 2026-11-20 暮雨口径删除；
  // MCP/CLI 入口保留为“BYOK 已退役，请去 DSH”的提示版。
  // 决策卡（2026-10-12）：与 Python CLI 同文件（task-data/decisions.md）
  decisionList: () => ipcRenderer.invoke('decision:list'),
  decisionAdd: (input: any) => ipcRenderer.invoke('decision:add', input),
  decisionSetStatus: (id: string, status: string, note?: string) => ipcRenderer.invoke('decision:setStatus', id, status, note),
  // 2026-10-17：编辑 / 删除（决策原来只能新增 + 改状态，"写错一句就只能撤销"）
  decisionUpdate: (id: string, patch: any) => ipcRenderer.invoke('decision:update', id, patch),
  decisionDelete: (id: string) => ipcRenderer.invoke('decision:delete', id),

  // Launchpad
  policyGet: (projectId: string) => ipcRenderer.invoke('policy:get', projectId),
  policySave: (p: any) => ipcRenderer.invoke('policy:save', p),
  /** 结构地图落地：只认状态=完成（用户签字）；返回写前备份/写后读回结果 */
  smapApply: (taskId: string) => ipcRenderer.invoke('smap:apply', taskId),
  // 使命草稿（2026-11-14 · P1-2）：从项目 README 取一句当建议；只读、不写盘
  policyMissionDraft: (projectId: string) => ipcRenderer.invoke('policy:missionDraft', projectId),
  policyText: (projectId: string) => ipcRenderer.invoke('policy:text', projectId),
  /** 结构地图“结构大改”批量判定：只读，主进程算，带缓存 */
  policyDriftAll: (items: Array<{ project: string; repo: string; since: string }>) => ipcRenderer.invoke('policy:driftAll', items),
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
  // dueTime（2026-10-12 暮雨）：到期日的**可选时间**（HH:MM）—— 空串即未设。
  todosCreate: (title: string, priority?: string, due?: string, project?: string, fromLog?: string, dueTime?: string) => ipcRenderer.invoke('todos:create', title, priority, due, project, fromLog, dueTime),
  todosUpdate: (id: string, updates: any) => ipcRenderer.invoke('todos:update', id, updates),
  todosToggle: (id: string) => ipcRenderer.invoke('todos:toggle', id),
  todosDelete: (id: string) => ipcRenderer.invoke('todos:delete', id),
  /** 待办数据健康度（坏文件隔离留痕） */
  todosHealth: () => ipcRenderer.invoke('todos:health'),

  // ── 想法（2026-10-22）：随手记一个念头，之后决定 做 / 搁置 / 不做 ──
  // 只有 内容 / 记下的时间 / 四态。没有优先级、没有截止日、不归属项目。
  ideasList: (filter?: any) => ipcRenderer.invoke('ideas:list', filter),
  ideasSummary: () => ipcRenderer.invoke('ideas:summary'),
  ideasAdd: (text: string) => ipcRenderer.invoke('ideas:add', text),
  ideasUpdateText: (id: string, text: string) => ipcRenderer.invoke('ideas:updateText', id, text),
  ideasSetStatus: (id: string, status: string, note?: string) => ipcRenderer.invoke('ideas:setStatus', id, status, note),
  /** 立项 = 真在待办里生出一条（不是只改个状态） */
  ideasPromote: (id: string, opts?: any) => ipcRenderer.invoke('ideas:promote', id, opts),
  ideasUnpromote: (id: string) => ipcRenderer.invoke('ideas:unpromote', id),
  ideasDelete: (id: string) => ipcRenderer.invoke('ideas:delete', id),
  ideasRestore: (idea: any) => ipcRenderer.invoke('ideas:restore', idea),
  ideasHealth: () => ipcRenderer.invoke('ideas:health'),

  // ── Dispatch ───────────────────────────────────────────────────────
  // 2026-10-06（卡 004）：`dispatchPreview` / `dispatchExecute` **已删**。
  // 桌面“派活”入口早在 9/20 就判死（用户：派活极不可靠、易失控，执行过程/进度/结果都看不见），
  // 现在右键只给“📐 复制为派工单”（纯文本拼接、只复制不派发）。
  // 但这两个通道一直留在 preload + 主进程里 —— **渲染层零调用**，整条是死代码。
  // 删掉它，并给 check-ipc-parity 补了第 ⑤ 类（死通道）断言，下次这类残留会被查出来。
  // ⚠ CLI 侧的 `tegula dispatch` / `_build_prompt` **不是死代码**（agent 面在用），未动。

  // ── Review ─────────────────────────────────────────────────────────
  reviewAccept: (id: string, reason?: string) => ipcRenderer.invoke('review:accept', id, reason),
  reviewReject: (id: string, reason: string) => ipcRenderer.invoke('review:reject', id, reason),
  /** 直接驳回（2026-10-30 暮雨第 2 条）：非终态卡都能退回，理由可选 */
  rejectTaskDirect: (id: string, reason?: string) => ipcRenderer.invoke('review:rejectDirect', id, reason),

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
  /** 开机自启（默认关；开发态 supported=false） */
  getAutoStart: () => ipcRenderer.invoke('app:getAutoStart'),
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke('app:setAutoStart', enabled),
  onUpdateAvailable: (callback: any) => ipcRenderer.on('update:available', (_e, data) => callback(data)),
  /**
   * 点系统通知 → 渲染层回到具体对象（2026-10-29 dsh-notify 借鉴 #2）。
   * 主进程发 `notify:focus`，渲染层按 type 切视图并打开那张卡；返回取消订阅函数。
   */
  onNotifyFocus: (cb: (p: { type: string; sourceId: string }) => void) => {
    const listener = (_e: any, p: any) => cb(p || { type: '', sourceId: '' })
    ipcRenderer.on('notify:focus', listener)
    return () => ipcRenderer.removeListener('notify:focus', listener)
  },
  onUpdateNotAvailable: (callback: any) => ipcRenderer.on('update:not-available', (_e, data) => callback(data)),
  onUpdateProgress: (callback: any) => ipcRenderer.on('update:progress', (_e, data) => callback(data)),
  onUpdateDownloaded: (callback: any) => ipcRenderer.on('update:downloaded', (_e, data) => callback(data)),
  onUpdateError: (callback: any) => ipcRenderer.on('update:error', (_e, data) => callback(data)),

  // ── Skill 管理 ────────────────────────────────────────────────────
  skillsCheck: () => ipcRenderer.invoke('skills:check'),
  skillsInstall: () => ipcRenderer.invoke('skills:install'),
  /** 装到指定可直装目标（卡 011）：'hermes' | 'dsh' */
  skillsInstallTo: (targetId: string) => ipcRenderer.invoke('skills:installTo', targetId),
  /* ── 问卷（2026-11-05）：吃 agent 写的 md，弹窗里答，批准后落决策卡 ── */
  questionnaireList: () => ipcRenderer.invoke('questionnaire:list'),
  questionnaireGet: (deck: string) => ipcRenderer.invoke('questionnaire:get', deck),
  questionnaireSaveAnswers: (deck: string, answers: any, approvedAt?: string) =>
    ipcRenderer.invoke('questionnaire:saveAnswers', deck, answers, approvedAt),
  questionnaireApprove: (deck: string) => ipcRenderer.invoke('questionnaire:approve', deck),
  questionnairePrompt: (deck: string, kind: 'rewrite' | 'build') =>
    ipcRenderer.invoke('questionnaire:prompt', deck, kind),
  questionnaireOpenDir: () => ipcRenderer.invoke('questionnaire:openDir'),
  // 作废与事后校验（2026-11-07）：不作废 = agent 拿过期答案干活；不校验 = 决策卡永远“有效”。
  questionnaireVoidDeck: (deck: string, reason: string) =>
    ipcRenderer.invoke('questionnaire:voidDeck', deck, reason),
  questionnaireReopenDeck: (deck: string) => ipcRenderer.invoke('questionnaire:reopenDeck', deck),
  questionnaireVoidAnswer: (deck: string, qid: string, reason: string) =>
    ipcRenderer.invoke('questionnaire:voidAnswer', deck, qid, reason),
  questionnaireAudit: (deck: string, qid: string, verdict: 'ok' | 'refuted', evidence: string) =>
    ipcRenderer.invoke('questionnaire:audit', deck, qid, verdict, evidence),
  questionnaireAuditQueue: () => ipcRenderer.invoke('questionnaire:auditQueue'),

  // 问卷管理（2026-11-11）：搜索 / 归档候选 / 归档与取消归档
  questionnaireSearch: (query: string, opts?: { project?: string; from?: string; to?: string }) =>
    ipcRenderer.invoke('questionnaire:search', query, opts),
  questionnaireArchivable: (days?: number) => ipcRenderer.invoke('questionnaire:archivable', days),
  questionnaireArchive: (deck: string, reason?: string) => ipcRenderer.invoke('questionnaire:archive', deck, reason),
  questionnaireUnarchive: (deck: string) => ipcRenderer.invoke('questionnaire:unarchive', deck),
  /** 结论集收敛进度（P8 · D-064）：一句人话 + 还要几轮 */
  questionnaireConvergence: (deck: string) => ipcRenderer.invoke('questionnaire:convergence', deck),
  /** 答卷 → 真任务卡（幂等；没批准 / 有反问 / 已作废一律拒） */
  questionnaireMakeCards: (deck: string, opts?: { project?: string; priority?: string }) =>
    ipcRenderer.invoke('questionnaire:makeCards', deck, opts),
  /** 派工单出厂上下文（2026-11-09 · S3=B）：闸结果 + 已落档验收线 */
  questionnaireDispatchContext: (deck: string, project: string) =>
    ipcRenderer.invoke('questionnaire:dispatchContext', deck, project),
  /** 题库 ↔ 卷 ↔ 卡 的关系视图（0.7.0 P11）：哪条结论来自哪卷、哪条已落成卡 */
  questionnaireBankRelations: (project?: string) => ipcRenderer.invoke('questionnaire:bankRelations', project),
  /** 多卷批量处置（P11）：逐卷走同一条通道，失败逐条点名 */
  questionnaireBatchAction: (input: { decks?: string[]; action?: string; reason?: string; days?: number }) =>
    ipcRenderer.invoke('questionnaire:batchAction', input),

  /** 技能安装专区（2026-09-26 卡 038） */
  skillsList: () => ipcRenderer.invoke('skills:list'),
  /** 上次自动同步的留痕 + 它还算不算数（2026-11-05）：升级后旧进程没退 = 同步没跑，界面要能看出来 */
  skillsSyncStatus: () => ipcRenderer.invoke('skills:syncStatus'),
  /** 现在补同步一次（不重启、不等托盘退出） */
  skillsSyncNow: () => ipcRenderer.invoke('skills:syncNow'),
  skillsOpenDir: (which: string) => ipcRenderer.invoke('skills:openDir', which),
  /** 在资源管理器里显示某个技能的 SKILL.md（装到 WorkBuddy 这类只能手动导入的 agent） */
  skillsReveal: (dirOrFile: string) => ipcRenderer.invoke('skills:reveal', dirOrFile),
  /** “装到别的 agent”目标检测（Hermes 可直装；其余给文件+打开对方） */
  agentsList: () => ipcRenderer.invoke('agents:list'),
  agentsOpen: (id: string) => ipcRenderer.invoke('agents:open', id),
  // MCP 接入材料（卡 002 · A 路线：只出材料，方寸不写外部应用文件）
  mcpInfo: () => ipcRenderer.invoke('mcp:info'),
  mcpSnippet: (targetId: string, entryId: string) => ipcRenderer.invoke('mcp:snippet', targetId, entryId),
  mcpSelfInstall: (targetId: string, entryId: string) => ipcRenderer.invoke('mcp:selfInstall', targetId, entryId),
  mcpOpenConfig: (targetId: string) => ipcRenderer.invoke('mcp:openConfig', targetId),
  /** Hermes 接入（2026-11-06）：这是方寸唯一会写别人配置文件的通道（只写 Hermes config.yaml） */
  mcpLinkHermes: (entryId: string) => ipcRenderer.invoke('mcp:linkHermes', entryId),
  /** DSH 侧的方寸插件状态（只读：插件装没装、自带通道通不通、旧的手工桥指向哪） */
  mcpDshPlugin: () => ipcRenderer.invoke('mcp:dshPlugin'),
  /** 打开 DSH profile 目录（只打开资源管理器，不写任何配置） */
  mcpDshProfileOpen: () => ipcRenderer.invoke('mcp:dshProfileOpen'),
  /** 生成方寸自己的派单签名密钥（只写方寸 userData，不碰 DSH） */
  dispatchEnsureSecret: () => ipcRenderer.invoke('dispatch:ensureSecret'),
  /** “哪些待办没人碰过”（卡 20261025-006 第三件）—— 只读，来自 mcp-usage.jsonl */
  usageNeverRead: (days?: number) => ipcRenderer.invoke('usage:neverRead', days),
  checkMismatch: (days?: number) => ipcRenderer.invoke('mismatch:check', days),
  // 需求矩阵（RICE · 2026-10-28）：读池 / 幂等灌分 / 拍板落账 / 改月预算。
  // ⚠ 页面零网络：这里只是本地文件 IPC，不连任何端点。
  riceGet: () => ipcRenderer.invoke('rice:get'),
  riceUpsert: (items: unknown, meta?: unknown) => ipcRenderer.invoke('rice:upsert', items, meta),
  riceDecide: (items: unknown, meta?: unknown) => ipcRenderer.invoke('rice:decide', items, meta),
  riceSetBudget: (budget: number) => ipcRenderer.invoke('rice:setBudget', budget),
  /** 日志置顶 / 改项目归属（卡 037 右键菜单） */
  logsSetPinned: (id: string, pinned: boolean) => ipcRenderer.invoke('logs:setPinned', id, pinned),
  logsSetProject: (id: string, project: string) => ipcRenderer.invoke('logs:setProject', id, project),
  /** 待办置顶（卡 037 第二批） */
  todosSetPinned: (id: string, pinned: boolean) => ipcRenderer.invoke('todos:setPinned', id, pinned),
  /** 回收站文件正文预览（不是 id，是文件名） */
  trashRead: (name: string) => ipcRenderer.invoke('trash:read', name),
  // ⚠ 2026-10-16（用户第 2 条）：`servicesStartApp` 已删 —— 启动应用走“启动台”页
  //   的 `launchpadLaunchApp`，服务页只管端口监控（详见 main/ipc.ts 那段说明）。
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
  // 渲染层出错时主动回报主进程落盘；界面提供“打开日志目录 / 查看尾部”。
  applogWrite: (level: string, scope: string, message: string, detail?: string) =>
    ipcRenderer.invoke('applog:write', level, scope, message, detail),
  applogPath: () => ipcRenderer.invoke('applog:path'),
  // `applogDir` 死通道已删（2026-10-11，卡 20261006-002 E 组）：与 applogOpenDir 重复
  // （后者打开目录时本来就把 dir 回给界面），渲染层从来没调过。
  applogTail: (lines?: number) => ipcRenderer.invoke('applog:tail', lines),
  // 2026-10-17 暮雨第 5 条：清理旧日志（days<=0 = 全清，当天那份只截断）
  applogPurge: (days?: number) => ipcRenderer.invoke('applog:purge', days),
  applogOpenDir: () => ipcRenderer.invoke('applog:openDir'),
})
