/**
 * 任务字段一致性端到端测试
 *
 * 覆盖本轮修复：
 *  - 优先级取值统一（normal/high/low ↔ 高/中/低）
 *  - 编辑表单字段完整（打开→不改→保存 不丢字段）
 *  - 字段清单单一来源，且前端枚举不与主进程漂移
 *
 * 运行：node scripts/test/e2e-task-fields.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

// ── 1. electron 桩注入（必须在业务模块之前） ────────────────────────────
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-fields-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT

const DIST = path.resolve(__dirname, '../../desktop/dist/main')
const REPO = path.resolve(__dirname, '../..')

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
}

function main() {
  console.log('== 任务字段一致性测试 ==')
  console.log('root:', TEST_ROOT)

  fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
  writeFile(path.join(TEST_ROOT, 'registry.yaml'), 'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示\n')

  const data = require(path.join(DIST, 'data', 'index.js'))
  const tasks = require(path.join(DIST, 'data', 'tasks.js'))
  data.setDataDir(TEST_ROOT)
  check('数据目录已绑定', data.getDataDir() === TEST_ROOT, data.getDataDir())

  // ── 优先级枚举与别名 ─────────────────────────────────────────────────
  check('PRIORITIES 为中文三档', JSON.stringify(data.PRIORITIES) === JSON.stringify(['高', '中', '低']),
    JSON.stringify(data.PRIORITIES))

  const aliasCases = [
    ['高', '高'], ['中', '中'], ['低', '低'],
    ['high', '高'], ['HIGH', '高'], ['urgent', '高'], ['critical', '高'],
    ['normal', '中'], ['medium', '中'], ['Normal', '中'],
    ['low', '低'], ['p0', '高'], ['p2', '低'],
    ['', ''], [undefined, ''], [null, ''],
  ]
  let aliasOk = 0
  const aliasBad = []
  for (const [input, want] of aliasCases) {
    const got = data.normalizePriority(input)
    if (got === want) aliasOk++
    else aliasBad.push(`${JSON.stringify(input)}→${got} (期望 ${want})`)
  }
  check('优先级别名全部归一正确', aliasOk === aliasCases.length, aliasBad.join('; '))
  check('未知优先级原样保留不丢数据', data.normalizePriority('紧急') === '紧急')
  check('isKnownPriority 判定正确',
    data.isKnownPriority('normal') && data.isKnownPriority('高') && !data.isKnownPriority('紧急'))

  // ── createTask 默认值与归一 ──────────────────────────────────────────
  const t1 = tasks.createTask({ title: '默认优先级任务' })
  check('新建任务默认优先级为「中」', t1.fm.priority === '中', String(t1.fm.priority))

  const t2 = tasks.createTask({ title: '英文优先级任务', priority: 'normal' })
  check('createTask 把 normal 归一为「中」', t2.fm.priority === '中', String(t2.fm.priority))

  const t3 = tasks.createTask({ title: '高优任务', priority: 'high' })
  check('createTask 把 high 归一为「高」', t3.fm.priority === '高', String(t3.fm.priority))

  const t3raw = fs.readFileSync(t3.path, 'utf-8')
  check('落盘 frontmatter 使用中文键「优先级: 高」', /优先级:\s*高/.test(t3raw),
    t3raw.split('\n').slice(0, 12).join(' | '))
  check('落盘不出现英文优先级值', !/优先级:\s*(normal|high|low)/.test(t3raw))

  // ── 读取历史英文数据 ─────────────────────────────────────────────────
  const legacyPath = path.join(TEST_ROOT, 'task-data', 'task-legacy-001.md')
  writeFile(legacyPath, '---\nid: task-legacy-001\n标题: 历史任务\n状态: 待办\n优先级: normal\n创建: 2026-01-01T00:00:00.000Z\n---\n\n正文\n')
  const legacy = data.parseTask(legacyPath)
  check('读取历史 normal 任务被归一为「中」', legacy && legacy.fm.priority === '中',
    legacy ? String(legacy.fm.priority) : 'parse 失败')

  // ── updateTask 写入归一 ──────────────────────────────────────────────
  const t4 = tasks.createTask({ title: '待更新任务' })
  tasks.updateTask(t4.id, { priority: 'low' })
  const t4raw = fs.readFileSync(t4.path, 'utf-8')
  check('updateTask 把 low 归一为「低」并落盘', /优先级:\s*低/.test(t4raw), t4raw.split('\n').slice(0, 10).join(' | '))
  check('updateTask 不把英文值写回文件', !/优先级:\s*(low|normal|high)/.test(t4raw))

  // ── 字段清单 ─────────────────────────────────────────────────────────
  const specs = data.TASK_FIELD_SPECS
  check('字段清单非空', Array.isArray(specs) && specs.length >= 10, String(specs.length))
  const keys = specs.map(s => s.key)
  check('字段清单无重复 key', new Set(keys).size === keys.length, keys.join(','))
  for (const must of ['title', 'project', 'status', 'priority', 'assignee', 'deadline', 'batch', 'tags', 'blockers', 'memo', 'body']) {
    check(`字段清单包含 ${must}`, keys.includes(must))
  }
  check('每个字段都有 label 与 span',
    specs.every(s => s.label && (s.span === 'half' || s.span === 'full')))
  check('select 类型字段都带选项来源',
    specs.filter(s => s.type === 'select').every(s => Array.isArray(s.options) || s.optionsFrom))
  check('EDITABLE_FM_KEYS 不含 body', !data.EDITABLE_FM_KEYS.includes('body'))

  // ── 表单值往返 ───────────────────────────────────────────────────────
  const rich = tasks.createTask({
    title: '字段齐全任务',
    project: 'demo',
    status: '进行中',
    priority: '高',
    assignee: '暮雨',
    deadline: '12-31',
    tags: ['ui', 'bug'],
    blockers: ['task-20260101-001'],
    body: '正文第一行\n- [ ] 待勾',
  })
  tasks.updateTask(rich.id, { batch: '2026-Q3', memo: '记得先备份' })

  const full = tasks.readTask(rich.id)
  const form = data.taskToFormValues(full)
  check('taskToFormValues 覆盖全部字段清单',
    data.TASK_FIELD_SPECS.every(s => s.key in form),
    Object.keys(form).join(','))
  check('数组字段转为逗号串', form.tags === 'ui, bug', String(form.tags))
  check('blockers 转为逗号串', String(form.blockers) === 'task-20260101-001', String(form.blockers))
  check('body 原样带出', form.body.includes('待勾'))

  const patch = data.formValuesToPatch(form)
  check('formValuesToPatch 还原数组', Array.isArray(patch.tags) && patch.tags.join(',') === 'ui,bug',
    JSON.stringify(patch.tags))
  check('formValuesToPatch 优先级保持中文', patch.priority === '高', String(patch.priority))
  check('formValuesToPatch 不含 body', !('body' in patch))

  // ── 「打开编辑 → 不改 → 保存」不丢字段（本轮核心修复） ────────────────
  const before = tasks.readTask(rich.id)
  const beforeSnapshot = JSON.stringify({
    assignee: before.fm.assignee,
    deadline: before.fm.deadline,
    batch: before.fm.batch,
    memo: before.fm.memo,
    blockers: before.fm.blockers,
    tags: before.fm.tags,
  })

  // 模拟前端 saveEdit：取表单值 → 原样提交
  const formAgain = data.taskToFormValues(tasks.readTask(rich.id))
  const patchAgain = data.formValuesToPatch(formAgain)
  tasks.updateTask(rich.id, { ...patchAgain, body: formAgain.body })

  const after = tasks.readTask(rich.id)
  const afterSnapshot = JSON.stringify({
    assignee: after.fm.assignee,
    deadline: after.fm.deadline,
    batch: after.fm.batch,
    memo: after.fm.memo,
    blockers: after.fm.blockers,
    tags: after.fm.tags,
  })
  check('不改动直接保存后字段完全保留', beforeSnapshot === afterSnapshot, `${beforeSnapshot} → ${afterSnapshot}`)
  check('正文在往返后保持', after.body.includes('待勾'))

  // ── 未知字段不被表单清空 ─────────────────────────────────────────────
  tasks.updateTask(rich.id, { context: 'some context', agent: 'hermes' })
  const withUnknown = tasks.readTask(rich.id)
  const form3 = data.taskToFormValues(withUnknown)
  tasks.updateTask(rich.id, { ...data.formValuesToPatch(form3), body: form3.body })
  const afterUnknown = tasks.readTask(rich.id)
  check('表单未覆盖的未知字段（context/agent）不被清空',
    afterUnknown.fm.context === 'some context' && afterUnknown.fm.agent === 'hermes',
    JSON.stringify({ context: afterUnknown.fm.context, agent: afterUnknown.fm.agent }))

  // ── 「按优先级分组」不再丢任务（本轮修复的看板 bug） ──────────────────
  const all = data.loadTasks('active')
  const byPrio = {}
  for (const t of all) {
    const p = t.fm.priority || ''
    byPrio[p] = (byPrio[p] || 0) + 1
  }
  const known = Object.keys(byPrio).filter(k => ['高', '中', '低'].includes(k))
  const unknown = Object.keys(byPrio).filter(k => k && !['高', '中', '低'].includes(k))
  check('所有已识别优先级都是中文档位', known.length > 0, JSON.stringify(byPrio))
  check('不存在英文优先级残留导致的孤儿分组', unknown.length === 0, JSON.stringify(unknown))
  const grouped = ['高', '中', '低'].reduce((n, p) => n + (byPrio[p] || 0), 0)
  const total = all.filter(t => t.fm.priority).length
  check('按优先级分组后任务数不丢', grouped === total, `${grouped} vs ${total}`)

  // ── IPC 扁平化必须自动展开（防再次漏字段） ───────────────────────────
  const ipcSrc = fs.readFileSync(path.join(REPO, 'desktop/src/main/ipc.ts'), 'utf-8')
  check('IPC 用展开式扁平化任务（...t.fm）', /\.\.\.t\.fm/.test(ipcSrc))
  check('IPC 不再手写字段列表（会漏 deadline 等）', !/title:\s*t\.fm\.title/.test(ipcSrc))

  // ── 前后端枚举防漂移 ─────────────────────────────────────────────────
  const appVue = fs.readFileSync(path.join(REPO, 'desktop/src/renderer/App.vue'), 'utf-8')
  const statusMatch = appVue.match(/const STATUSES = \[([^\]]+)\]/)
  const prioMatch = appVue.match(/const PRIORITIES = \[([^\]]+)\]/)
  const parseList = (s) => s.split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).filter(x => !/^\.\.\./.test(x))

  check('前端 STATUSES 与主进程一致',
    !!statusMatch && JSON.stringify(parseList(statusMatch[1])) === JSON.stringify([...data.STATUSES]),
    statusMatch ? statusMatch[1] : '未找到')
  check('前端 PRIORITIES 与主进程一致',
    !!prioMatch && JSON.stringify(parseList(prioMatch[1])) === JSON.stringify([...data.PRIORITIES]),
    prioMatch ? prioMatch[1] : '未找到')

  // 前端不应再出现英文优先级字面量
  check('App.vue 不再硬编码英文优先级值',
    !/option value="(normal|high|low)"/.test(appVue) && !/t\.priority \|\| 'normal'/.test(appVue))

  // ── 待办优先级同源 ───────────────────────────────────────────────────
  const todos = require(path.join(DIST, 'services', 'todos.js'))
  const td = todos.createTodo('测试待办', 'high')
  check('待办优先级也归一为中文', td.priority === '高', String(td.priority))
  const tdDefault = todos.createTodo('默认待办')
  check('待办默认优先级为「中」', tdDefault.priority === '中', String(tdDefault.priority))

  // ── FIELD_MAP 必须覆盖 Python 侧全部中文键（防跨语言字段丢失） ────────
  // Python CLI 用中文键写文件，TS 若漏映射就静默读不到（曾漏「标签」，Python 写的标签全丢）。
  const corePy = fs.readFileSync(path.join(REPO, 'tegula/core.py'), 'utf-8')
  const mkMatch = corePy.match(/MANAGED_KEYS\s*=\s*\{([^}]+)\}/)
  check('能从 core.py 提取 MANAGED_KEYS', !!mkMatch)
  if (mkMatch) {
    const pyKeys = parseList(mkMatch[1])
    const zhKeys = pyKeys.filter(k => /[\u4e00-\u9fa5]/.test(k))
    const missing = zhKeys.filter(k => !(k in data.FIELD_MAP))
    check('FIELD_MAP 覆盖 Python 侧全部中文键', missing.length === 0,
      `Python 有 ${zhKeys.length} 个中文键，缺失: ${missing.join(', ') || '无'}`)

    // 反向：映射回中文键时，tags 必须回到「标签」（Python 认的写法）
    const reverseOk = data.FIELD_MAP['标签'] === 'tags'
    check('标签正确映射到 tags', reverseOk, String(data.FIELD_MAP['标签']))
  }

  // ── 归档识别与自然查询 ───────────────────────────────────────────────
  const archDir = path.join(TEST_ROOT, 'task-data', 'archive')
  writeFile(path.join(archDir, 'task-archive-001.md'),
    '---\nid: task-archive-001\n标题: 已归档任务\n状态: 完成\n优先级: 高\n标签: ui\n---\n\n归档正文\n')

  check('isArchivedPath 正确识别归档路径', tasks.isArchivedPath(path.join(archDir, 'x.md')))
  check('isArchivedPath 不误判活跃任务', !tasks.isArchivedPath(path.join(TEST_ROOT, 'task-data', 'a.md')))

  const actOnly = tasks.parseNaturalQuery('#ui')
  check('自然查询默认不含归档',
    !actOnly.tasks.some(t => tasks.isArchivedPath(t.path)),
    JSON.stringify(actOnly.tasks.map(t => t.path)))

  const withArch = tasks.parseNaturalQuery('#ui', { includeArchive: true })
  check('includeArchive 传入后可搜到归档任务',
    withArch.tasks.some(t => tasks.isArchivedPath(t.path)), String(withArch.tasks.length))

  const byStatus = tasks.parseNaturalQuery('status:进行中')
  check('status: 精确筛选生效',
    byStatus.tasks.length > 0 && byStatus.tasks.every(t => t.fm.status === '进行中'),
    byStatus.tasks.map(t => t.fm.status).join(','))

  const byStatusDone = tasks.parseNaturalQuery('status:完成 归档', { includeArchive: true })
  check('status: 可与归档范围组合',
    byStatusDone.tasks.every(t => t.fm.status === '完成'), String(byStatusDone.tasks.length))

  const prioQuery = tasks.parseNaturalQuery('prio:高')
  check('prio: 精确筛选生效且认英文别名',
    prioQuery.tasks.length > 0 && prioQuery.tasks.every(t => t.fm.priority === '高'),
    prioQuery.tasks.map(t => t.fm.priority).join(','))

  const byPrioEn = tasks.parseNaturalQuery('priority:high')
  check('priority:high 被归一后参与筛选',
    byPrioEn.tasks.length > 0 && byPrioEn.tasks.every(t => t.fm.priority === '高'), String(byPrioEn.tasks.length))

  const archQuery = tasks.parseNaturalQuery('归档')
  check('「归档」关键词自动扩展到归档范围',
    archQuery.tasks.length > 0 && archQuery.tasks.every(t => tasks.isArchivedPath(t.path)),
    String(archQuery.tasks.length))

  // ── 日志反向索引与目录跟随 ───────────────────────────────────────────
  const logs = require(path.join(DIST, 'services', 'logs.js'))
  logs.createLog('日志A', 'demo', '内容A', rich.id)
  logs.createLog('日志B', 'demo', '内容B', rich.id)
  logs.createLog('无关日志', 'demo', '内容C', 'task-other')

  const forTask = logs.logsForTask(rich.id)
  check('logsForTask 只返回该任务的日志',
    forTask.length === 2 && forTask.every(l => l.taskId === rich.id),
    forTask.map(l => l.title).join(','))
  check('logsForTask 空 id 返回空数组', logs.logsForTask('').length === 0)
  check('logsForTask 不返回其他任务的日志', !forTask.some(l => l.title === '无关日志'))

  const logsDir = path.join(TEST_ROOT, 'docs', '执行日志')
  check('日志目录跟随数据目录（不再自己推导一套）', fs.existsSync(logsDir), logsDir)
  check('日志文件已落盘', fs.readdirSync(logsDir).filter(f => f.endsWith('.md')).length >= 3,
    fs.readdirSync(logsDir).join(','))

  // ── registry.yaml 项目登记 ───────────────────────────────────────────
  const regPath = path.join(TEST_ROOT, 'registry.yaml')
  // 造一份带手写注释与自定义字段的 registry，验证写入不会把它们冲掉
  writeFile(regPath, [
    '# 手写注释：这一行不能被丢掉',
    'members:',
    '  - 暮雨',
    '',
    'projects:',
    '  - id: demo',
    '    name: 演示',
    '    状态: 活跃开发中',
    '',
  ].join('\n'))

  check('登记：空 ID 被拒', !data.addProjectToRegistry({ id: '' }).ok)
  check('登记：含空格的非法 ID 被拒', !data.addProjectToRegistry({ id: 'bad id' }).ok)

  const countBefore = data.parseRegistry(true).length
  const addOk = data.addProjectToRegistry({ id: 'new-proj', name: '新项目', repo: 'E:/CODE/demo', description: '测试用' })
  check('登记：正常写入成功', addOk.ok, addOk.error || '')

  const regAfter = fs.readFileSync(regPath, 'utf-8')
  check('登记：手写注释未被破坏（未用 dump 重写）', regAfter.includes('这一行不能被丢掉'))
  check('登记：原有自定义字段未丢', regAfter.includes('状态: 活跃开发中'))
  check('登记：members 段仍在', regAfter.includes('members:'))
  check('登记：项目数恰好 +1', data.parseRegistry(true).length === countBefore + 1,
    `${countBefore} → ${data.parseRegistry(true).length}`)

  const newProj = data.parseRegistry(true).find(p => p.id === 'new-proj')
  check('登记：字段写入正确',
    !!newProj && newProj.name === '新项目' && newProj.repo === 'E:/CODE/demo',
    JSON.stringify(newProj))
  check('登记：中文说明字段可读', !!newProj && newProj['说明'] === '测试用',
    String(newProj && newProj['说明']))
  check('登记：重复 ID 被拒', !data.addProjectToRegistry({ id: 'new-proj' }).ok)

  // ── 数据目录体检与搬迁 ───────────────────────────────────────────────
  const inspectEmpty = data.inspectDataDir(path.join(TEST_ROOT, '_empty-target'))
  check('体检：不存在的目录标记为空', inspectEmpty.empty && !inspectEmpty.exists, JSON.stringify(inspectEmpty))

  const inspectSelf = data.inspectDataDir(TEST_ROOT)
  check('体检：能识别当前目录', inspectSelf.isCurrent)
  check('体检：任务数含归档分开统计',
    inspectSelf.taskCount > 0 && inspectSelf.archivedCount >= 1,
    `total=${inspectSelf.taskCount} archived=${inspectSelf.archivedCount}`)
  check('体检：识别出目标位于当前目录内部',
    data.inspectDataDir(path.join(TEST_ROOT, 'task-data', 'archive')).insideCurrent)

  // ── 搬迁到空目录 ─────────────────────────────────────────────────────
  // 目标必须在数据目录之外 —— 迁入自己内部会被拒绝（下面有专门的用例验证）
  const migrateDest = path.join(os.tmpdir(), 'fc-migrate-a-' + Date.now())
  const mr = data.migrateDataDir(migrateDest)
  check('搬迁到空目录成功', mr.ok, mr.errors.join(';'))
  check('搬迁报告了复制文件数', mr.copiedFiles > 0, String(mr.copiedFiles))
  check('搬迁涵盖 task-data / registry.yaml / docs',
    mr.copiedEntries.includes('task-data') && mr.copiedEntries.includes('registry.yaml'),
    mr.copiedEntries.join(','))

  check('源数据目录未被删除（复制而非移动）', fs.existsSync(path.join(TEST_ROOT, 'task-data')))
  check('源 registry.yaml 仍在', fs.existsSync(path.join(TEST_ROOT, 'registry.yaml')))

  const sampleTask = 'task-data/' + fs.readdirSync(path.join(TEST_ROOT, 'task-data'))
    .find(f => f.endsWith('.md') && !f.startsWith('_'))
  check('搬迁后任务文件内容逐字一致',
    fs.readFileSync(path.join(TEST_ROOT, sampleTask), 'utf-8') ===
    fs.readFileSync(path.join(migrateDest, sampleTask), 'utf-8'), sampleTask)
  check('搬迁后 registry.yaml 一致',
    fs.readFileSync(path.join(TEST_ROOT, 'registry.yaml'), 'utf-8') ===
    fs.readFileSync(path.join(migrateDest, 'registry.yaml'), 'utf-8'))

  // 回收站不随迁（属本地缓存，旧目录里仍保留）
  writeFile(path.join(TEST_ROOT, 'task-data', '.trash', 'deleted.md'), 'x')
  const migrateDest2 = path.join(os.tmpdir(), 'fc-migrate-b-' + Date.now())
  data.migrateDataDir(migrateDest2)
  check('.trash 不随迁', !fs.existsSync(path.join(migrateDest2, 'task-data', '.trash')))
  check('旧目录的 .trash 原样保留', fs.existsSync(path.join(TEST_ROOT, 'task-data', '.trash', 'deleted.md')))

  // ── 搬迁的拒绝路径 ───────────────────────────────────────────────────
  const mrConflict = data.migrateDataDir(migrateDest)
  check('目标已有数据时默认拒绝', !mrConflict.ok, JSON.stringify(mrConflict.errors))
  check('显式 allowExisting 后放行', data.migrateDataDir(migrateDest, { allowExisting: true }).ok)

  const mrInside = data.migrateDataDir(path.join(TEST_ROOT, 'task-data', 'sub'))
  check('拒绝迁入当前目录内部', !mrInside.ok, JSON.stringify(mrInside.errors))

  const mrSelf = data.migrateDataDir(TEST_ROOT)
  check('拒绝迁到当前目录本身', !mrSelf.ok, JSON.stringify(mrSelf.errors))

  // ── 前端不再使用 Electron 不支持的 prompt() ──────────────────────────
  const appSrc2 = fs.readFileSync(path.join(REPO, 'desktop/src/renderer/App.vue'), 'utf-8')
  // 剥掉注释再检查：注释里解释"为什么不能用 prompt()"不该被算成调用
  const appCode = appSrc2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const promptHits = appCode.match(/[^.\w]prompt\(/g) || []
  check('App.vue 不再调用 prompt()（Electron 未实现）', promptHits.length === 0, promptHits.join(','))
  check('切换数据目录走目录选择对话框', /async function changeDataDir[\s\S]{0,400}browseDirectory/.test(appSrc2))
  check('切换数据目录先做只读体检', /async function changeDataDir[\s\S]{0,400}dataInspect/.test(appSrc2))
  check('新建规划改用自建模态（不再 prompt）',
    /function openNewPlan\(\)[\s\S]{0,300}planForm\.value/.test(appCode))
  check('新建项目改用自建模态（不再 prompt）',
    /function openNewProject\(\)[\s\S]{0,300}projForm\.value/.test(appCode))

  // ── 读取缓存必须跟随外部改动失效（目录签名机制） ──────────────────────
  // 缓存是「一次刷新扫 15 遍」的解法，但它一旦失灵就是静默读到旧数据 —— 比慢更危险。
  // 这里逐条验证「外部改动（Python CLI / 手改文件 / 直接 fs 写）立即可见」。
  {
    const cacheRoot = path.join(os.tmpdir(), 'fc-cache-' + Date.now())
    const ctd = path.join(cacheRoot, 'task-data')
    fs.mkdirSync(path.join(ctd, 'archive'), { recursive: true })
    fs.writeFileSync(path.join(cacheRoot, 'registry.yaml'), 'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示\n', 'utf-8')
    data.setDataDir(cacheRoot)

    const mk = (rel, title, status = '草稿') => {
      const p = path.join(ctd, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, `---\nid: ${path.basename(rel, '.md')}\n标题: ${title}\n状态: ${status}\n---\nbody\n`, 'utf-8')
    }

    mk('c1.md', '第一个')
    const first = data.loadTasks('active').length
    check('缓存：首次读取正确', first === 1, String(first))
    check('缓存：重复读取结果一致', data.loadTasks('active').length === 1)

    mk('c2.md', '第二个')
    check('缓存：外部新增文件立即可见', data.loadTasks('active').length === 2, String(data.loadTasks('active').length))

    mk('c2.md', '第二个改了')
    const afterEdit = data.loadTasks('active').find(t => t.id === 'c2')
    check('缓存：外部改内容立即可见', !!afterEdit && afterEdit.fm.title === '第二个改了', afterEdit && afterEdit.fm.title)

    fs.unlinkSync(path.join(ctd, 'c1.md'))
    check('缓存：外部删除立即可见', data.loadTasks('active').length === 1, String(data.loadTasks('active').length))

    mk(path.join('archive', 'a1.md'), '归档的', '完成')
    check('缓存：active 视图不含归档', data.loadTasks('active').length === 1, String(data.loadTasks('active').length))
    check('缓存：archive 视图能看到归档', data.loadTasks('archive').length === 1, String(data.loadTasks('archive').length))

    const updated = tasks.updateTask('c2', { 标题: '第二次改' })
    const after = data.loadTasks('active').find(t => t.id === 'c2')
    check('缓存：updateTask 后立即读到新标题',
      !!updated && !!after && after.fm.title === '第二次改', after && after.fm.title)
    check('缓存：写后任务数不变', data.loadTasks('active').length === 1)

    fs.writeFileSync(path.join(ctd, 'bad.md'), '---\n标题: [bad\n---\nbody\n', 'utf-8')
    const bad1 = data.loadTasks('active').length
    const bad2 = data.loadTasks('active').length
    check('缓存：解析失败的文件不计入且结果稳定', bad1 === bad2 && bad1 === 1, `${bad1}/${bad2}`)

    // ── 解析失败必须显性可见（静默跳过 = 任务人间蒸发） ──
    fs.writeFileSync(path.join(ctd, 'note.md'), '这是一段没有 frontmatter 的说明，不是任务文件。\n', 'utf-8')
    data.loadTasks('active')
    const errs = data.getParseErrors()
    check('解析失败可见：坏文件被列出', errs.some(e => e.includes('bad.md')), JSON.stringify(errs))
    check('解析失败可见：列出的是相对路径', errs.every(e => !e.includes(ctd)), JSON.stringify(errs))
    check('解析失败可见：非任务文件不被误报',
      !errs.some(e => e.includes('note.md')), JSON.stringify(errs))
    fs.writeFileSync(path.join(ctd, 'bad.md'), '---\n标题: "[bad] 已修"\n---\nbody\n', 'utf-8')
    check('解析失败可见：修好后不再报',
      !data.getParseErrors().some(e => e.includes('bad.md')), JSON.stringify(data.getParseErrors()))

    // ── 批量项目进度必须与逐个调用等价（防两条实现漂移） ──
    fs.writeFileSync(path.join(ctd, 'c3.md'), '---\nid: c3\n标题: 带项目\n状态: 完成\n项目: [demo]\n---\nbody\n', 'utf-8')
    fs.writeFileSync(path.join(ctd, 'c4.md'), '---\nid: c4\n标题: 多项目\n状态: 待办\n项目: [demo, other]\n---\nbody\n', 'utf-8')
    const batch = tasks.getAllProjectProgress()
    const singleDemo = tasks.getProjectProgress('demo')
    check('批量进度：demo 与逐个调用一致',
      batch.demo.total === singleDemo.total &&
      batch.demo.completed === singleDemo.completed &&
      batch.demo.percent === singleDemo.percent,
      `批量 ${JSON.stringify(batch.demo)} vs 单个 ${JSON.stringify(singleDemo)}`)
    check('批量进度：多项目归属都计入', !!batch.other && batch.other.total === 1, JSON.stringify(batch.other))
    check('批量进度：完成数/百分比正确',
      batch.demo.total === 2 && batch.demo.completed === 1 && batch.demo.percent === 50,
      JSON.stringify(batch.demo))

    data.setDataDir(TEST_ROOT)
    const leak = data.loadTasks('active').some(t => t.id === 'c2')
    check('缓存：切换数据目录后旧目录任务不泄漏', !leak)
    data.setDataDir(TEST_ROOT)
    try { fs.rmSync(cacheRoot, { recursive: true, force: true }) } catch {}
  }

  // ── 假成功通道已移除 ─────────────────────────────────────────────────
  const preloadSrc = fs.readFileSync(path.join(REPO, 'desktop/src/preload/index.ts'), 'utf-8')
  check('regSave 假成功通道已移除', !/regSave/.test(preloadSrc))
  check('新项目走 registry:addProject 真实写入',
    /registryAddProject/.test(preloadSrc) &&
    /registry:addProject/.test(fs.readFileSync(path.join(REPO, 'desktop/src/main/ipc.ts'), 'utf-8')))

  console.log('')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  if (failures.length) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  process.exit(fail === 0 ? 0 : 1)
}

try {
  main()
} catch (e) {
  console.error('测试异常:', e)
  process.exit(2)
}
