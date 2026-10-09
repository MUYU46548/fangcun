/**
 * 执行日志 端到端测试（2026-09-22）
 *
 * 覆盖用户报障：
 *  - 「日志根本无法改所选项目」：`updateLog` 原来只接受 title/content/nextSteps，
 *    project 与 taskId 被**静默丢弃** —— 界面提示"已更新"，重开还是老项目。
 *  - 「清理超期」的语义：只把 completed 且过保留期的日志标 archived，**不删文件**。
 *
 * 运行：node scripts/test/e2e-logs.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-logs-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT
fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'),
  'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示\n  - id: nf\n    name: 绒花墨坊\n', 'utf-8')

const DIST = path.resolve(__dirname, '../../desktop/dist/main')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function main() {
  console.log('== 执行日志 e2e ==')
  console.log('root:', TEST_ROOT)

  const data = require(path.join(DIST, 'data', 'index.js'))
  data.setDataDir(TEST_ROOT)
  const logs = require(path.join(DIST, 'services', 'logs.js'))

  const LOGS_DIR = path.join(TEST_ROOT, 'docs', '执行日志')

  // ── 1. 创建 ───────────────────────────────────────────────────────
  // ⚠ 产品 API 现在是 { ok, data, error }（旧签名直接返回 LogEntry）。
  //   旧测试拿 `a.id` = undefined → getLog(undefined) → null → 第 52 行 TypeError，
  //   整套 50 条断言自 2026-09-22 起一直没跑（2026-09-25 对齐）。
  const aRes = logs.createLog('日志A', 'demo', '内容A', 'task-001')
  check('createLog 返回 ok:true', aRes.ok === true, JSON.stringify(aRes.error))
  const a = aRes.data
  check('createLog 返回 LogEntry（含 id）', !!a && !!a.id, JSON.stringify(a))
  check('创建后文件落盘', fs.existsSync(path.join(LOGS_DIR, `${a.id}.md`)))
  check('创建时项目正确写入', logs.getLog(a.id).project === 'demo', logs.getLog(a.id).project)
  check('创建时关联任务写入（tasks 数组）', logs.getLog(a.id).taskId === 'task-001', String(logs.getLog(a.id).taskId))
  const fileText = fs.readFileSync(path.join(LOGS_DIR, `${a.id}.md`), 'utf-8')
  check('文件里确实有 tasks 数组', /tasks:\s*\r?\n?\s*-\s*task-001/.test(fileText), fileText.split('\n').slice(0, 16).join(' | '))

  // ── 2. 改项目 / 改关联任务（用户报障的原型）───────────────────────
  const u1 = logs.updateLog(a.id, { project: 'nf', taskId: 'task-002' })
  check('updateLog 返回 ok:true', u1.ok === true, JSON.stringify(u1.error))
  check('updateLog 返回更新后的对象', !!u1.data && u1.data.project === 'nf', JSON.stringify(u1.data && { p: u1.data.project, t: u1.data.taskId }))
  const reread = logs.getLog(a.id)
  check('★ 项目改动真的落盘（重读仍是新项目）', reread.project === 'nf', reread.project)
  check('★ 关联任务改动真的落盘', reread.taskId === 'task-002', String(reread.taskId))
  const text2 = fs.readFileSync(path.join(LOGS_DIR, `${a.id}.md`), 'utf-8')
  check('文件里 tasks 已换成新 id', /task-002/.test(text2) && !/task-001/.test(text2))

  // ── 3. 清除 ───────────────────────────────────────────────────────
  logs.updateLog(a.id, { project: '', taskId: '' })
  const cleared = logs.getLog(a.id)
  check('项目可清空', !cleared.project, JSON.stringify(cleared.project))
  check('关联任务可解除', cleared.taskId === undefined, String(cleared.taskId))
  const text3 = fs.readFileSync(path.join(LOGS_DIR, `${a.id}.md`), 'utf-8')
  check('解除后 tasks 为空数组', /tasks:\s*\[\]/.test(text3), text3.split('\n').slice(0, 16).join(' | '))

  // ── 4. 标题/内容/下一步仍然可改（别把老能力改坏）──────────────────
  logs.updateLog(a.id, { title: '日志A改', content: '内容A改', nextSteps: '下一步' })
  const u2 = logs.getLog(a.id)
  check('标题可改', u2.title === '日志A改', u2.title)
  check('内容可改', u2.content === '内容A改', u2.content)
  check('下一步可改', u2.nextSteps === '下一步', u2.nextSteps)

  // ── 5. 非 active 的日志不可编辑（不得静默改）──────────────────────
  const b = logs.createLog('日志B', 'demo', '内容B').data
  logs.archiveLog(b.id)
  const bUpd = logs.updateLog(b.id, { project: 'nf' })
  check('已归档日志 updateLog 返回 ok:false（不得静默改）', bUpd.ok === false, JSON.stringify(bUpd))
  check('已归档日志的项目没被偷改', logs.getLog(b.id).project === 'demo', logs.getLog(b.id).project)

  // ── 6. 完成 → 保留期 → 清理超期 ───────────────────────────────────
  const c = logs.createLog('日志C', 'demo', '内容C').data
  logs.completeLog(c.id, 7, '做完了')
  const cc = logs.getLog(c.id)
  check('完成后状态为 completed', cc.status === 'completed', cc.status)
  check('完成后算出 retainUntil', !!cc.retainUntil, String(cc.retainUntil))
  check('未到期不会被清理', logs.cleanupLogs().length === 0, JSON.stringify(logs.cleanupLogs()))

  // 把它伪造成已过期：直接改文件里的 retain_until
  const cPath = path.join(LOGS_DIR, `${c.id}.md`)
  fs.writeFileSync(cPath, fs.readFileSync(cPath, 'utf-8').replace(/retain_until: .*/, 'retain_until: 2000-01-01T00:00:00.000Z'), 'utf-8')
  const archived = logs.cleanupLogs()
  check('过期日志被清理（返回其 id）', archived.includes(c.id), JSON.stringify(archived))
  const afterClean = logs.getLog(c.id)
  check('清理后状态为 archived', afterClean.status === 'archived', afterClean.status)
  check('★ 清理只改状态、文件仍在（不删数据）', fs.existsSync(cPath))

  // ── 6b. 优先级字段（2026-10-08 卡 task-20261008-001，拍板=新增字段）───────
  // 三件事必须钉死：① 能写能读回；② **不标 = 文件里没有这个键**（历史文件零污染）；
  // ③ 下一次写回不丢（parse/render 是白名单全量重建 —— 漏列字段 = 写回即丢）。
  const p1 = logs.createLog('优先级日志', 'demo', '正文', undefined, { priority: '高' }).data
  check('★ 创建时带优先级 → 读回', logs.getLog(p1.id).priority === '高',
  JSON.stringify(logs.getLog(p1.id).priority))
  const pText = fs.readFileSync(path.join(LOGS_DIR, `${p1.id}.md`), 'utf-8')
  check('★ 优先级真落盘（frontmatter 有 priority: 高）', /priority:\s*高/.test(pText),
  pText.split('\n').slice(0, 20).filter(l => l.includes('priority')).join(' | ') || '无 priority 行')
  // 不带优先级创建 → 文件里**不许**出现 priority 键（否则历史日志批量写回时凭空多字段）
  const p2 = logs.createLog('未标优先级', 'demo', '正文').data
  const p2Text = fs.readFileSync(path.join(LOGS_DIR, `${p2.id}.md`), 'utf-8')
  check('★★ 不标优先级 → 文件里没有 priority 键（不写空字段污染历史文件）',
  !/^\s*priority:/m.test(p2Text), p2Text.split('\n').slice(0, 16).join(' | '))
  check('未标优先级读回 undefined', logs.getLog(p2.id).priority === undefined,
  String(logs.getLog(p2.id).priority))
  // 改优先级 + 触发任意一次其它字段写回 → priority 必须还在（白名单漏列就在这里炸）
  const uP = logs.updateLog(p1.id, { priority: '中', content: '正文改过' })
  check('updateLog 改优先级 ok', uP.ok === true, JSON.stringify(uP.error))
  const pReread = logs.getLog(p1.id)
  check('★ 改后读回 = 中', pReread.priority === '中', JSON.stringify(pReread.priority))
  check('★ 别的字段写回不吞优先级（content 改动后 priority 仍在）',
  pReread.priority === '中' && pReread.content === '正文改过',
  JSON.stringify({ priority: pReread.priority, content: pReread.content }))
  // 清除优先级 → 字段从文件里消失（与 taskIds 解除关联同口径）
  logs.updateLog(p1.id, { priority: '' })
  const pCleared = fs.readFileSync(path.join(LOGS_DIR, `${p1.id}.md`), 'utf-8')
  check('★ 清除优先级 → 文件里的 priority 键消失', !/^\s*priority:/m.test(pCleared),
  pCleared.split('\n').filter(l => l.includes('priority')).join(' | ') || '（无）')
  check('清除后读回 undefined', logs.getLog(p1.id).priority === undefined,
    String(logs.getLog(p1.id).priority))

  // ── 6c. 来源链 fromTodo（卡 004 日志⇄待办互转的另一半）────────────────────
  // 与 001 同一个白名单陷阱：parse/render 任一漏列 = 下一次写回把来源静默删掉。
  const f1 = logs.createLog('由待办转来的日志', 'demo', '到期：2026-10-10', undefined,
    { fromTodo: 'todo-20261008-001', priority: '高' }).data
  check('★ createLog 带 fromTodo → 读回', logs.getLog(f1.id).fromTodo === 'todo-20261008-001',
    JSON.stringify(logs.getLog(f1.id).fromTodo))
  const f1Text = fs.readFileSync(path.join(LOGS_DIR, `${f1.id}.md`), 'utf-8')
  check('★★ fromTodo 真落盘（文件键 from_todo）', /from_todo:\s*todo-20261008-001/.test(f1Text),
    f1Text.split('\n').filter(l => l.includes('from_todo')).join(' | ') || '无 from_todo 行')
  // 别的字段写回 → 来源必须活下来（白名单漏列就在这一步炸）
  logs.updateLog(f1.id, { content: '执行内容写了一点' })
  const f1Back = logs.getLog(f1.id)
  check('★★ 改内容写回后 fromTodo 不丢（parse/render 漏列 = 静默丢来源）',
    f1Back.fromTodo === 'todo-20261008-001' && f1Back.content === '执行内容写了一点',
    JSON.stringify({ fromTodo: f1Back.fromTodo, content: f1Back.content }))
  check('★ 写回后 priority 也还在（两个新字段同批，别只保一个）',
    f1Back.priority === '高', JSON.stringify(f1Back.priority))
  // 普通日志不落 from_todo 键（历史文件零污染）
  const f2Text = fs.readFileSync(path.join(LOGS_DIR, `${a.id}.md`), 'utf-8')
  check('★★ 普通日志文件里没有 from_todo 键（无值不落键）',
    !/^\s*from_todo:/m.test(f2Text), f2Text.split('\n').filter(l => l.includes('from_todo')).join(' | ') || '（无）')

  // ── 7. 列表筛选 / 反向索引 ────────────────────────────────────────
  const d = logs.createLog('日志D', 'nf', '内容D', 'task-002').data
  check('按项目筛选', logs.listLogs({ project: 'nf' }).every(l => l.project === 'nf'))
  check('按状态筛选', logs.listLogs({ status: 'archived' }).every(l => l.status === 'archived'))
  check('logsForTask 反查到两条', logs.logsForTask('task-002').length >= 1, String(logs.logsForTask('task-002').length))
  check('logsForTask 空 id 返回空', logs.logsForTask('').length === 0)
  check('按标题搜到', logs.searchLogs('日志D').some(l => l.id === d.id))

  // ── 7b. 搜索 = 筛选的一个维度（2026-10-01 用户第 3 条「日常卡点」）────────
  // 真因：界面此前有两条互不相干的取数路 —— 搜索走 searchLogs(query)（无视项目/
  // Agent/日期），筛选走 listLogs(filter)（无视搜索词）；完成/归档/改筛选任何一次
  // loadLogs 都会把搜索结果整个冲掉，而框里的词还留着 → 用户看到「搜了又没了」。
  // 现在搜索词就是 filter.query，只有一条取数路径，刷新不丢、筛选可叠加。
  const s1 = logs.createLog('搜索夹具·灰度', 'nf', '普通正文', undefined,
    { nextSteps: '把 Gray-Release 开到 30%' }).data
  const s2 = logs.createLog('另一条夹具', 'demo', 'Gray-Release 的正文', undefined, {}).data
  check('★ listLogs({query}) 按标题搜到',
    logs.listLogs({ query: '搜索夹具·灰度' }).some(l => l.id === s1.id),
    JSON.stringify(logs.listLogs({ query: '搜索夹具·灰度' }).map(l => l.id)))
  check('★★ listLogs({query}) 能搜到「下一步」（searchLogs 从不查这一段）',
    logs.listLogs({ query: 'gray-release 开到' }).some(l => l.id === s1.id),
    JSON.stringify(logs.listLogs({ query: 'gray-release' }).map(l => l.id)))
  check('★★ 搜索与项目筛选可叠加（同一条取数路径，nf 下搜「夹具」只剩 nf 那条）', (() => {
    const rows = logs.listLogs({ query: '夹具', project: 'nf' })
    return rows.length >= 1 && rows.every(l => l.project === 'nf') &&
      rows.some(l => l.id === s1.id) && !rows.some(l => l.id === s2.id)
  })(), JSON.stringify(logs.listLogs({ query: '夹具', project: 'nf' }).map(l => l.id + ':' + l.project)))
  check('★ 关键词大小写不敏感', logs.listLogs({ query: 'gray-release' }).some(l => l.id === s1.id))
  check('★ 不传 query = 不过滤（老调用零回归）',
    logs.listLogs({ project: 'nf' }).length >= 1,
    String(logs.listLogs({ project: 'nf' }).length))
  check('★ query 不命中 = 空列表（不会把不相干的漏出来）',
    logs.listLogs({ query: '这个关键词不可能存在xyz' }).length === 0)

  // ── 7c. 附件：日志 ↔ 文件（2026-10-01 用户第 1 条 → 卡 036）────────────
  // 验收三问：存哪（数据目录内）、入口（预览/编辑的附件区）、备份（同目录随日志走）。
  const srcA = path.join(TEST_ROOT, '源截图,逗号和[括号].png')
  fs.writeFileSync(srcA, Buffer.from('89504e470d0a1a0a', 'hex'))
  const att = logs.addAttachments(a.id, [srcA])
  check('★★ addAttachments 成功', att.ok === true, JSON.stringify(att.error))
  const rel1 = ((att.data || {}).attachments || [])[0]
  check('★ 存的是相对数据目录的正斜杠路径（换盘/搬目录不失效）',
    !!rel1 && !/^[a-zA-Z]:/.test(rel1) && rel1.includes('/') && rel1.startsWith('docs/执行日志/_attachments/'),
    String(rel1))
  check('★★ 文件真被复制进数据目录', !!rel1 && fs.existsSync(path.join(TEST_ROOT, ...rel1.split('/'))), String(rel1))
  check('★ 源文件不动（复制不是移动）', fs.existsSync(srcA))
  check('★★ 落盘是**内联列表** `attachments: [...]`（Python 侧 _parse_log 逐行解析只认这种；',
    /^attachments: \[[^\]]*\]$/m.test(fs.readFileSync(path.join(LOGS_DIR, `${a.id}.md`), 'utf-8')),
    fs.readFileSync(path.join(LOGS_DIR, `${a.id}.md`), 'utf-8').split('\n').filter(l => l.includes('attach')).join(' | '))
  check('★★ 文件名里的逗号/方括号被清洗（否则 Python 按逗号切内联列表会劈开一条路径）',
    !/[,;[\]]/.test(path.basename(String(rel1))), path.basename(String(rel1)))
  check('★ 再读回来还在（parse → render → parse 往返）',
    (logs.getLog(a.id).attachments || []).length === 1, JSON.stringify(logs.getLog(a.id).attachments))
  check('★ listLogs 也带出来（列表角标靠它渲染）',
    logs.listLogs({}).some(l => l.id === a.id && (l.attachments || []).length === 1))
  check('★★ _attachments 目录不会被当日志列出来',
    logs.listLogs({}).every(l => !String(l.id).startsWith('_')),
    JSON.stringify(logs.listLogs({}).map(l => l.id).filter(x => String(x).startsWith('_'))))

  // 第二个附件：确认分隔与重名处理
  const srcB = path.join(TEST_ROOT, '分析报告.txt')
  fs.writeFileSync(srcB, 'PASS 139 / 0', 'utf-8')
  const att2 = logs.addAttachments(a.id, [srcB])
  check('★ 第二个附件挂上（同一文件名会自动 (1) 后缀，不覆盖）',
    att2.ok === true && att2.data.attachments.length === 2,
    JSON.stringify((att2.data || {}).attachments))
  check('★ 内联行两个元素都读得回',
    (logs.getLog(a.id).attachments || []).length === 2, JSON.stringify(logs.getLog(a.id).attachments))

  // 安全：路径逃逸
  check('★★ resolveAttachment 拒绝 ../ 逃逸（防任意文件读/打开）',
    logs.resolveAttachment('../../Windows/win.ini') === null)
  check('★★ resolveAttachment 拒绝绝对路径注入',
    logs.resolveAttachment('C:/Windows/win.ini') === null)
  check('★ resolveAttachment 放行真实附件',
    (() => { const p = logs.resolveAttachment(rel1); return !!p && fs.existsSync(p) })(), String(rel1))

  // 预览通道
  const dr = logs.readAttachmentData(rel1)
  check('★ 附件 → data URL（渲染层预览唯一通道）',
    dr.ok === true && String(dr.data.dataUrl).startsWith('data:image/png;base64,'),
    dr.error || String(dr.data.dataUrl).slice(0, 32))
  check('★ 超 8MB 不内联（返回 tooLarge 而不是把渲染层卡死）',
    (() => {
      const big = path.join(TEST_ROOT, 'big.png')
      fs.writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 1))
      const r = logs.addAttachments(a.id, [big])
      const relBig = r.ok ? r.data.attachments[r.data.attachments.length - 1] : ''
      const rd = relBig ? logs.readAttachmentData(relBig) : { ok: false, error: 'no' }
      if (r.ok) logs.detachAttachment(a.id, relBig)
      fs.rmSync(big, { force: true })
      return rd.ok === false && rd.error === 'tooLarge'
    })(), 'big file case')

  // 解除关联 = 只解除引用，不删文件（破坏性操作不藏在按钮后面）
  const det = logs.detachAttachment(a.id, rel1)
  check('★ 解除关联成功', det.ok === true && (det.data.attachments || []).length === 1,
    JSON.stringify((det.data || {}).attachments))
  check('★★ 移除只解除关联、文件仍在数据目录（不隐性销毁）',
    fs.existsSync(path.join(TEST_ROOT, ...String(rel1).split('/'))))
  check('★ 解除后 frontmatter 里的那一项同步消失（不留悬空引用）',
    !(logs.getLog(a.id).attachments || []).includes(rel1))

  // ── 8. taskId 兼容多种历史写法 ────────────────────────────────────
  fs.writeFileSync(path.join(LOGS_DIR, 'legacy-1.md'),
    '---\ntype: execution-log\nid: legacy-1\ntitle: 老写法\nproject: demo\nstatus: active\n关联任务: task-009\n---\n\n# 老写法\n\n## 执行内容\n\nx\n\n## 下一步\n\n（待填写）', 'utf-8')
  check('兼容中文「关联任务」键', logs.getLog('legacy-1').taskId === 'task-009', String(logs.getLog('legacy-1').taskId))
  check('★ 老写法的单值也要被归一成 taskIds 数组',
    JSON.stringify(logs.getLog('legacy-1').taskIds) === JSON.stringify(['task-009']),
    JSON.stringify(logs.getLog('legacy-1').taskIds))

  // ── 9. 一条日志关联**多个**任务（2026-09-25 用户第 2 条）────────────
  // 真因：文件里一直写的是 `tasks: [id]` 数组，代码却只读第一个 —— 于是「一条日志
  // 影响多个任务」这件事在数据层被静默削成单值。下面把这四件事钉死。
  const mRes = logs.createLog('多关联', 'demo', '内容M', undefined,
    { taskIds: ['task-m1', 'task-m2', 'task-m3'] })
  check('createLog 支持 taskIds 数组', mRes.ok === true, JSON.stringify(mRes.error))
  const m = mRes.data
  check('多关联：taskIds 全量保留', JSON.stringify(logs.getLog(m.id).taskIds) === JSON.stringify(['task-m1', 'task-m2', 'task-m3']),
    JSON.stringify(logs.getLog(m.id).taskIds))
  check('多关联：taskId 退化为首个（兼容旧消费方）', logs.getLog(m.id).taskId === 'task-m1', String(logs.getLog(m.id).taskId))
  const mFile = fs.readFileSync(path.join(LOGS_DIR, `${m.id}.md`), 'utf-8')
  check('★ 多关联：三个 ID 全部落到文件 frontmatter 的 tasks',
    /task-m1/.test(mFile) && /task-m2/.test(mFile) && /task-m3/.test(mFile), mFile.split('---')[1])
  check('★ 反向索引能查到第 2、3 个 ID（原先只认第一个）',
    logs.logsForTask('task-m2').some(l => l.id === m.id) && logs.logsForTask('task-m3').some(l => l.id === m.id))
  check('多关联：不关联的任务查不到', logs.logsForTask('task-m1-nope').length === 0)
  check('多关联：重复 ID 去重', (() => {
    const r = logs.createLog('去重', 'demo', 'x', undefined, { taskIds: ['task-d1', 'task-d1', ' task-d1 '] })
    return JSON.stringify(r.data.taskIds) === JSON.stringify(['task-d1'])
  })())
  check('位置参数 taskId 与 extra.taskIds 并存时取并集（taskIds 空则听 taskId）', (() => {
    const r = logs.createLog('位置参数', 'demo', 'x', 'task-e1', { taskIds: [] })
    return r.data.taskId === 'task-e1' && JSON.stringify(r.data.taskIds) === JSON.stringify(['task-e1'])
  })())

  // 改：换成一个完全不同的 ID
  logs.updateLog(m.id, { taskIds: ['task-m9'] })
  check('★ 改多关联：旧 ID 被清掉、新 ID 生效',
    JSON.stringify(logs.getLog(m.id).taskIds) === JSON.stringify(['task-m9'])
    && logs.logsForTask('task-m2').every(l => l.id !== m.id),
    JSON.stringify(logs.getLog(m.id).taskIds))
  check('改多关联：taskId 同步为新的首个', logs.getLog(m.id).taskId === 'task-m9', String(logs.getLog(m.id).taskId))
  // 改：清空 = 解除关联
  logs.updateLog(m.id, { taskIds: [] })
  const mAfter = logs.getLog(m.id)
  check('★ 清空 taskIds = 解除关联（taskId 与 taskIds 都空，不残留旧值）',
    !mAfter.taskId && (!mAfter.taskIds || mAfter.taskIds.length === 0),
    `${mAfter.taskId} / ${JSON.stringify(mAfter.taskIds)}`)
  // 旧调用方仍传单个 taskId → 不能把已有的多关联打散成单值后丢字段
  logs.updateLog(m.id, { taskId: 'task-legacy' })
  check('兼容：旧调用只传 taskId 时归一成 [taskId]',
    JSON.stringify(logs.getLog(m.id).taskIds) === JSON.stringify(['task-legacy']),
    JSON.stringify(logs.getLog(m.id).taskIds))

  // ── 10. 渲染层接线守卫（2026-09-25 第 2/13 条）─────────────────────
  // 数据层通了不等于界面通了 —— 上一轮「三层早通、UI 无入口」的坑（卡 022）就是这么来的。
  const APP = fs.readFileSync(path.resolve(__dirname, '../../desktop/src/renderer/App.vue'), 'utf-8')
  const IPC_SRC = fs.readFileSync(path.resolve(__dirname, '../../desktop/src/main/ipc.ts'), 'utf-8')

  // ── 10b. 搜索与筛选合流（2026-10-01 用户第 3 条「日常卡点」）─────────────
  check('★★ 搜索词进 loadLogs 的 filter（只有一条取数路径），渲染层不再另调 logsSearch',
    /if \(q\) filter\.query = q/.test(APP) && !/window\.tegula\.logsSearch/.test(APP),
    'hasQuery=' + /if \(q\) filter\.query = q/.test(APP) + ' stillCalls=' + /window\.tegula\.logsSearch/.test(APP))
  check('★★ 僵尸通道 logs:search 已随合流删除（新旧并存 = 差评）',
    !/guardedHandle\('logs:search'/.test(IPC_SRC))
  check('★ 边打边搜（防抖 watcher），不再必须按回车',
    /watch\(logSearchInput/.test(APP) && /\}, 300\)/.test(APP))

  // ── 10c. 附件三层接线（2026-10-01 用户第 1 条 → 卡 036）────────────────
  // 数据层通了不等于界面通了（老坑：三层早通、UI 无入口）。这里钉死三个面。
  const PRE_SRC = fs.readFileSync(path.resolve(__dirname, '../../desktop/src/preload/index.ts'), 'utf-8')
  const ATTACH_CH = ['logs:attachFiles', 'logs:detachAttachment', 'logs:attachmentData', 'logs:openAttachment']
  check('★★ 附件四通道：主进程全部注册',
    ATTACH_CH.every(c => IPC_SRC.includes(`'${c}'`)),
    ATTACH_CH.filter(c => !IPC_SRC.includes(`'${c}'`)).join(',') || 'ok')
  check('★★ 附件四通道：preload 全部暴露（主→preload 一致）',
    ATTACH_CH.every(c => PRE_SRC.includes(`invoke('${c}'`)),
    ATTACH_CH.filter(c => !PRE_SRC.includes(`invoke('${c}'`)).join(',') || 'ok')
  check('★★ 渲染层三个面：列表角标 + 只读预览 + 编辑对话框各一块',
    /log-attach-badge/.test(APP) && (APP.match(/data-attach-block/g) || []).length >= 2,
    'blocks=' + (APP.match(/data-attach-block/g) || []).length)
  check('★ 三个操作函数被模板真调用（不是死函数）',
    ['attachAdd', 'attachRemove', 'attachOpen'].every(f => new RegExp('="' + f + '\\(').test(APP)))
  check('★ 预览不走 file:// 直读（dev 态 localhost 起源下读不到本地图片）',
    !/src="file:/.test(APP) && /logsAttachmentData/.test(APP))

  // ── 10d. 排序三前端对齐（2026-10-01 用户第 2 条）─────────────────────
  check('★★ 日志有排序下拉（此前只有"创建倒序"，连正序都翻不过来）',
    /v-model="logSort"/.test(APP) && /value="created_asc"/.test(APP) && /value="title_asc"/.test(APP))
  check('★ 排序偏好落盘（换会话/重启不回默认）', /fc_log_sort/.test(APP))
  check('★ 待办补「优先级从高到低」「最近更新」两种排法',
    /value="priority"/.test(APP) && /todoSort.value === 'priority'/.test(APP) &&
    /todoSort.value === 'updated'/.test(APP))
  check('★ 看板补「优先级」排法（且走 localPriority 归一，high/高 同刻度）',
    /value="prio"/.test(APP) && /mode === 'prio'/.test(APP) && /localPriority/.test(APP))
  check('★ 日志编辑框是多选（checkbox 绑 taskIds），不再只有单选下拉',
    /v-model="logEdit_\.taskIds"/.test(APP) && !/v-model="logEdit_\.taskId"/.test(APP))
  check('保存时发的是 taskIds（不是 taskId）',
    /taskIds: normalizeLogTaskIds\(e\)/.test(APP))
  check('★ 日志正文走 Markdown 渲染（第 13 条）：只读预览接 renderBody',
    /logPreview\.content\)/.test(APP) && /renderBody\(logPreview/.test(APP))
  check('单击日志卡 = 只读预览（编辑移到按钮/预览内，不再靠点卡片）',
    /logPreview\.value = \{ \.\.\.log \}/.test(APP) && /@click="openLog\(log\)"/.test(APP))

  // ── 11. 日志状态模型（2026-09-26 卡 022 → 2026-09-28 用户第 2 条重做）────
  // 用户原话：「日志还是一创建就是进行中，导致我日志依然混乱，分不清哪些没跑、
  //           哪些 Agent 正在跑、哪些跑完了。我需要"进行中"只能由手动开关打上，
  //           且可以撤销（防止误操作），且不成为完成或归档的必要条件。」
  // 真因：`active` 这个状态**创建时就自动打上**，而它的中文显示是「进行中」——
  //       于是"默认态"和"正在跑"共用一个词。现在拆开：
  //         status: active = 待处理（默认）；running: true = 进行中（只能手动开）
  const r1 = logs.createLog('打回1', 'demo', 'x').data
  check('★ 新建日志不再自动是「进行中」（既不是 running，也不是靠 status 冒充）',
    logs.getLog(r1.id).running !== true && logs.getLog(r1.id).status === 'active',
    JSON.stringify({ s: logs.getLog(r1.id).status, r: logs.getLog(r1.id).running }))
  check('★ 新建日志文件里**不写** running 字段（不凭空多出字段）',
    !/running/.test(fs.readFileSync(path.join(LOGS_DIR, `${r1.id}.md`), 'utf-8')))

  // 手动开 / 关「进行中」
  const sr1 = logs.setLogRunning(r1.id, true)
  check('★ setLogRunning(true) 写回成功', sr1 && sr1.ok === true, JSON.stringify(sr1))
  check('★ 读回来 running === true（往返保真）', logs.getLog(r1.id).running === true)
  check('★ 文件里真的落了 running: true',
    /^running: true$/m.test(fs.readFileSync(path.join(LOGS_DIR, `${r1.id}.md`), 'utf-8')))
  check('★ 「进行中」能被筛选捞出（按 running，不再按 status）',
    logs.listLogs({ running: true }).some(l => l.id === r1.id))
  const sr0 = logs.setLogRunning(r1.id, false)
  check('★ 可撤销：setLogRunning(false) 把它放回「待处理」',
    sr0 && sr0.ok === true && logs.getLog(r1.id).running !== true, JSON.stringify(sr0))
  check('★ 撤销后字段从文件里消失（不留 running: false 垃圾）',
    !/running/.test(fs.readFileSync(path.join(LOGS_DIR, `${r1.id}.md`), 'utf-8')))
  check('  不存在的 id 返回 ok:false（不抛）', logs.setLogRunning('不存在', true).ok === false)

  // 「进行中」不是完成/归档的前置条件
  const r2 = logs.createLog('直接的完成', 'demo', 'x').data
  check('★ 「待处理」状态直接完成，不被拒绝（进行中不是前置条件）',
    logs.completeLog(r2.id, 7, '直接完成').ok === true && logs.getLog(r2.id).status === 'completed')
  const r3 = logs.createLog('直接的归档', 'demo', 'x').data
  check('★ 「待处理」状态直接归档，不被拒绝',
    logs.archiveLog(r3.id).ok === true && logs.getLog(r3.id).status === 'archived')
  check('  归档幂等：再点一次仍是 ok，不报「日志已归档」',
    logs.archiveLog(r3.id).ok === true)
  check('★ 完成时顺手关掉「进行中」（不会同时显示已完成 + 进行中）', (() => {
    const r = logs.createLog('先跑再完成', 'demo', 'x').data
    logs.setLogRunning(r.id, true)
    logs.completeLog(r.id, 7)
    return logs.getLog(r.id).running !== true && logs.getLog(r.id).status === 'completed'
  })())

  // 撤销：退回「待处理」，**而不是**自动变成「进行中」
  const r4 = logs.createLog('撤销我', 'demo', 'x').data
  logs.completeLog(r4.id, 30, '做完')
  check('前置：这条已完成且带保留期',
    logs.getLog(r4.id).status === 'completed' && !!logs.getLog(r4.id).retainUntil)
  const rp1 = logs.reopenLog(r4.id)
  check('★ 已完成的日志能撤销', rp1.ok === true, JSON.stringify(rp1.error))
  const r4After = logs.getLog(r4.id)
  check('★ 撤销后状态回到 active（显示为「待处理」）', r4After.status === 'active', r4After.status)
  check('★ 撤销**不会**顺手把人标成「进行中」（那是上一版的坑：撤销本身变成新的意外）',
    r4After.running !== true, JSON.stringify(r4After.running))
  check('★ 撤销顺手清掉「已完成 + 保留期」（不留下自相矛盾的字样）',
    !r4After.completed && !r4After.retainUntil && !r4After.retainDays,
    JSON.stringify({ c: r4After.completed, u: r4After.retainUntil, d: r4After.retainDays }))
  check('★ 撤销后就能编辑了（updateLog 不再拒绝）',
    logs.updateLog(r4.id, { title: '撤销我改' }).ok === true)

  const r5 = logs.createLog('撤销归档', 'demo', 'x').data
  logs.archiveLog(r5.id)
  check('★ 已归档的日志也能撤销', logs.reopenLog(r5.id).ok === true && logs.getLog(r5.id).status === 'active')
  check('★ 撤销只改状态：文件仍在（不删不搬）', fs.existsSync(path.join(LOGS_DIR, `${r5.id}.md`)))
  check('撤销幂等：本来就是 active 时给 ok 且不报错',
    logs.reopenLog(r5.id).ok === true && logs.getLog(r5.id).status === 'active')
  check('撤销不存在的日志给可读原因',
    logs.reopenLog('nope-999').ok === false && /不存在/.test(logs.reopenLog('nope-999').error || ''),
    JSON.stringify(logs.reopenLog('nope-999')))
  check('★ 对已完成的日志开「进行中」= 连带退回未完成（否则卡面自相矛盾）', (() => {
    const r = logs.createLog('已完成又开跑', 'demo', 'x').data
    logs.completeLog(r.id, 7)
    logs.setLogRunning(r.id, true)
    const e = logs.getLog(r.id)
    return e.running === true && e.status === 'active' && !e.completed
  })())

  // 渲染层接线守卫：数据层通了不等于界面有入口（卡 022 的坑就是这么来的）
  const PRELOAD = fs.readFileSync(path.resolve(__dirname, '../../desktop/src/preload/index.ts'), 'utf-8')
  check('★ 日志卡有「进行中」手动开关（模板按钮 + 函数都在）',
    /toggleLogRunning\(log\)/.test(APP) && /async function toggleLogRunning/.test(APP))
  check('★ 开关走的是新通道 logs:setRunning（preload 也暴露了）',
    /window\.tegula\.logsSetRunning\(log\.id, next\)/.test(APP) && /logsSetRunning: \(id: string, running: boolean\) => ipcRenderer\.invoke\('logs:setRunning'/.test(PRELOAD))
  check('★ 只有 running 的卡才有醒目卡面（修前是 active —— 而 active 是"每一条新建日志"的默认值）',
    /\.log-card\.running \{[\s\S]{0,240}linear-gradient/.test(APP) && !/\.log-card\.active \{[\s\S]{0,240}linear-gradient/.test(APP))
  check('★ `active` 的中文显示是「待处理」，不再是「进行中」',
    /return \{ active: '待处理'/.test(APP))
  check('★ 「完成」按钮不再要求先「进行中」（任何未完成/未归档都可用）',
    /log\.status !== 'completed' && log\.status !== 'archived'[\s\S]{0,120}completeLogItem\(log\.id\)/.test(APP))
  check('★ 状态筛选下拉已被分区取代（用户第 5 条：筛选把信息切碎）',
    !/v-model="logStatusFilter"/.test(APP) && !/全部状态/.test(APP) && /groupedLogs/.test(APP) && /log-group-toggle/.test(APP))

  // ── 置顶（2026-09-26 卡 037）──────────────────────────────────────────
  //   用户口径：加**新字段** pinned（不复用 status）——置顶是视图属性，跟生命周期正交；
  //   并且要能在**已完成/已归档**的日志上操作（"正在查的东西钉在上面"）。
  {
    const logs = require(path.join(DIST, 'services/logs.js'))
    const logsDir = path.join(TEST_ROOT, 'docs', '执行日志')

    const a = logs.createLog('钉住我', 'demo', '内容甲')
    const b = logs.createLog('普通的', 'demo', '内容乙')
    const ida = a.data.id, idb = b.data.id

    check('新日志默认不置顶（pinned 不写进文件）',
      logs.getLog(ida).pinned !== true &&
      !/pinned/.test(fs.readFileSync(path.join(logsDir, ida + '.md'), 'utf-8')))

    const set = logs.setLogPinned(ida, true)
    check('★ setLogPinned 写回成功', set && set.ok === true, JSON.stringify(set))
    check('★ 读回来 pinned === true（往返保真）', logs.getLog(ida).pinned === true)
    check('  文件里真的落了 pinned: true',
      /^pinned: true$/m.test(fs.readFileSync(path.join(logsDir, ida + '.md'), 'utf-8')))
    check('★ 列表里置顶的排最前', logs.listLogs()[0].id === ida,
      logs.listLogs().map(l => l.id).join(','))

    logs.setLogPinned(ida, false)
    check('★ 取消置顶后字段从文件里消失（不留 pinned: false 垃圾）',
      !/pinned/.test(fs.readFileSync(path.join(logsDir, ida + '.md'), 'utf-8')))

    // 已完成的日志：内容不可编辑（既有守卫），但置顶/改归属必须可用 —— 它们是视图/归类属性
    logs.completeLog(idb, 7, '做完了')
    check('  前置：这条已是 completed', logs.getLog(idb).status === 'completed')
    check('  （对照）已完成日志改内容仍被拒绝', logs.updateLog(idb, { content: 'x' }).ok === false)
    const proj = logs.setLogProject(idb, 'nf')
    check('★ 已完成的日志也能改项目归属（归类属性 ≠ 内容编辑）',
      proj && proj.ok === true && logs.getLog(idb).project === 'nf', JSON.stringify(proj))
    const pin2 = logs.setLogPinned(idb, true)
    check('★ 已完成的日志也能置顶', pin2 && pin2.ok === true && logs.getLog(idb).pinned === true)
    check('★ 置顶后它排在整个列表最前（跨状态）', logs.listLogs()[0].id === idb,
      logs.listLogs().map(l => l.id).join(','))
    check('  不存在的 id 返回 ok:false（不抛）', logs.setLogPinned('不存在', true).ok === false)
  }

  // ── 接力链（2026-09-29 第 3 条方案二）────────────────────────────────
  //   用户口径：不引入新实体 —— 只多一个字段 continues_from，链 = 沿它往回走的连通分量；
  //   真实动作是「旧的收尾 + 新的开张」，合成一个对话框才不会漏做其中一件。
  {
    const lg = require(path.join(DIST, 'services/logs.js'))
    const logsDir = path.join(TEST_ROOT, 'docs', '执行日志')
    const read = (id) => fs.readFileSync(path.join(logsDir, id + '.md'), 'utf-8')

    // 数据层：createLog 带 continueFrom + nextSteps（对话框预填的落点）
    const s1 = lg.createLog('链头·问题清单', 'demo', '列出14条问题').data
    const s2res = lg.createLog('链二·功能性调整', 'demo', '改三处', undefined, {
      continueFrom: s1.id,
      nextSteps: '清单勾选状态回写、批注导出格式、跨文件引用跳转',
      agentName: 'hermes',
      taskIds: ['task-chain'],
    })
    check('★ createLog 接受 continueFrom（接力）', s2res.ok === true, JSON.stringify(s2res.error))
    const s2 = s2res.data
    check('★ continueFrom 落盘（文件键 continues_from）',
      /^continues_from: /m.test(read(s2.id)), read(s2.id).split('\n').slice(0, 14).join(' | '))
    check('★ 读回保真', lg.getLog(s2.id).continueFrom === s1.id, String(lg.getLog(s2.id).continueFrom))
    check('★ nextSteps 随创建带入', lg.getLog(s2.id).nextSteps === '清单勾选状态回写、批注导出格式、跨文件引用跳转',
      lg.getLog(s2.id).nextSteps)
    check('  普通日志不写 continues_from（无值不落盘，历史文件不长字段）',
      !/continues_from/.test(read(s1.id)))

    // 任意一次写回不得丢链（parse→render 往返保真）
    lg.setLogRunning(s2.id, true)
    check('★★ 任意写回（改运行标记）后链字段仍在', lg.getLog(s2.id).continueFrom === s1.id,
      String(lg.getLog(s2.id).continueFrom))
    lg.setLogRunning(s2.id, false)

    // 第三代 + 分叉：上溯顺序 / BFS 下游 / 分叉不互串
    const s3 = lg.createLog('链三·回归防护', 'demo', 'x', undefined, { continueFrom: s2.id }).data
    const s4 = lg.createLog('分叉·旁支', 'demo', 'y', undefined, { continueFrom: s2.id }).data
    const chHead = lg.logChain(s1.id)
    const dIds = chHead.downstream.map(l => l.id)
    check('★ 链头 downstream：第一代是 s2', dIds[0] === s2.id, dIds.join(','))
    check('★ 第二代 {s3,s4} 都在（同代顺序不依赖文件名）',
      dIds.length === 3 && [s3.id, s4.id].every(x => dIds.includes(x)), dIds.join(','))
    check('★ 链头无 upstream', chHead.upstream.length === 0)
    const chTail = lg.logChain(s3.id)
    check('★★ 末端 upstream = 从链头到父级（旧→新）',
      chTail.upstream.map(l => l.id).join(',') === [s1.id, s2.id].join(','),
      chTail.upstream.map(l => l.id).join(','))
    check('★ 末端无 downstream', chTail.downstream.length === 0)
    check('★ 分叉的 upstream 不互串（s4 同样是 s1→s2）',
      lg.logChain(s4.id).upstream.map(l => l.id).join(',') === [s1.id, s2.id].join(','),
      lg.logChain(s4.id).upstream.map(l => l.id).join(','))

    // MCP：AI 顺链自己走（get_log 带上下游 / list_logs chain 过滤）
    const mcp = require(path.join(DIST, 'mcp', 'tools.js'))
    const gj = JSON.parse(mcp.handleMCPToolCall('get_log', { id: s2.id }).content[0].text)
    check('★★ MCP get_log 带回 continuesFrom', gj.continuesFrom === s1.id, String(gj.continuesFrom))
    check('★★ MCP get_log 带回链上下游（upstream 1 条 / downstream ≥2 条）',
      (gj.chain?.upstream || []).length === 1 && (gj.chain?.downstream || []).length >= 2,
      JSON.stringify(gj.chain))
    const chainRows = JSON.parse(mcp.handleMCPToolCall('list_logs', { chain: s1.id }).content[0].text)
    check('★★ MCP list_logs 支持 chain 过滤（整链从老到新）',
      chainRows.length === 4 && chainRows[0].id === s1.id && chainRows[3].id !== s1.id &&
      chainRows.filter(r => [s3.id, s4.id].includes(r.id)).length === 2,
      chainRows.map(r => r.id).join(','))
    check('  chain 行带 isHead/isTail 标记', chainRows[0].isHead === true && chainRows[3].isTail === true,
      JSON.stringify([chainRows[0].isHead, chainRows[3].isTail]))
    check('  普通 list_logs 行也带 continuesFrom（不加 chain 时可见）',
      JSON.parse(mcp.handleMCPToolCall('list_logs', {}).content[0].text).some(r => r.id === s2.id && r.continuesFrom === s1.id))

    // 上次的执行 Agent（2026-10-03 反馈1，卡 task-20261003-001）：与 continues_from 同款口径
    const pv = lg.createLog('接力后·带上次', 'demo', 'x', undefined, {
      continueFrom: s2.id, agentName: 'DSH', prevAgentName: 'hermes',
    }).data
    check('★★ createLog 接受 prevAgentName 并落盘（文件键 prev_agent_name）',
      /^prev_agent_name: hermes$/m.test(read(pv.id)),
      read(pv.id).split('\n').filter(l => /agent/.test(l)).join(' | '))
    check('★ 读回保真：prev 与本次两个 Agent 字段各归各',
      lg.getLog(pv.id).prevAgentName === 'hermes' && lg.getLog(pv.id).agentName === 'DSH',
      String(lg.getLog(pv.id).prevAgentName) + '/' + String(lg.getLog(pv.id).agentName))
    lg.setLogPinned(pv.id, true)
    check('★★ 任意写回后 prev_agent_name 仍在（parse→render 往返不丢）',
      lg.getLog(pv.id).prevAgentName === 'hermes', String(lg.getLog(pv.id).prevAgentName))
    check('  无值不落盘：普通日志文件不长 prev_agent_name',
      !/prev_agent_name/.test(read(s1.id)))
    const upPrev = lg.updateLog(pv.id, { prevAgentName: '' })
    check('★ updateLog 清空 = 字段从文件消失（空值不落盘，不残留 null）',
      upPrev.ok === true && !/prev_agent_name/.test(read(pv.id)) && !lg.getLog(pv.id).prevAgentName,
      read(pv.id).split('\n').filter(l => /agent/.test(l)).join(' | ') || '(无 agent 行)')
    // ── 2026-10-03 族2 写盘收敛：updateLog 必须留下写前滚动备份 ──────────────
    //   备份在源文件**同级**的 .backup/ 下（docs/执行日志/.backup/<原名>.<时间戳>.bak），
    //   内容 = 本次写盘**之前**的旧文件（此处仍带 prev_agent_name: hermes）。
    const bkDir = path.join(logsDir, '.backup')
    const bkNames = fs.existsSync(bkDir)
      ? fs.readdirSync(bkDir).filter(f => f.startsWith(pv.id + '.') && f.endsWith('.bak'))
      : []
    check('★★ 2026-10-03 族2：updateLog 后该日志在 同级 .backup/ 下有写前 .bak',
      bkNames.length >= 1,
      `dir=${bkDir} 命中=${JSON.stringify(bkNames)}` + (bkNames.length
        ? ` 备份是写前内容=${/prev_agent_name: hermes/.test(fs.readFileSync(path.join(bkDir, bkNames[0]), 'utf-8'))}`
        : ''))
    lg.setLogPinned(pv.id, false)

    // 防御：断链 / 成环（修前代码这两种都会挂死或抛）
    const orphan = lg.createLog('断链者', 'demo', 'z', undefined, { continueFrom: 'log-not-exist' }).data
    check('★ 指向不存在的日志：不抛、自己当链头', lg.logChain(orphan.id).upstream.length === 0,
      JSON.stringify(lg.logChain(orphan.id).upstream))
    const s1Path = path.join(logsDir, s1.id + '.md')
    // s1 没有 continues_from 行（上面已断言）—— 环要靠**插入**这行来造：s1→s3→s2→s1
    fs.writeFileSync(s1Path,
      read(s1.id).replace(/^(id: .*)$/m, `$1\ncontinues_from: ${s3.id}`), 'utf-8')
    check('  （前置）环已造出：s1 现在指向 s3', /^continues_from: /m.test(read(s1.id)))
    const cyc = lg.logChain(s1.id)
    check('★★ 成环不挂死（visited 去重终止，返回上溯两跳）',
      cyc.upstream.map(l => l.id).join(',') === [s2.id, s3.id].join(','),
      JSON.stringify(cyc.upstream.map(l => l.id)))
    fs.writeFileSync(s1Path, read(s1.id).replace(/^continues_from: .*\n/m, ''), 'utf-8')
    check('  环已拆除（s1 回到无上游）', lg.logChain(s1.id).upstream.length === 0)

    // 确认尾巴往返：完成确认 / 归档备注 不得被下一次写回静默吃掉（2026-09-29 顺手修的真数据丢失）
    const t1 = lg.createLog('尾巴往返', 'demo', 'x').data
    lg.completeLog(t1.id, 7, '做完了：验收通过')
    check('★ 完成确认落盘', /## 完成确认/.test(read(t1.id)))
    lg.setLogPinned(t1.id, true) // 任意一次写回
    check('★★ 完成确认在任意写回后仍在（修复前 parse 不读这一节 → 必丢）',
      /## 完成确认[\s\S]*做完了：验收通过/.test(read(t1.id)))
    lg.archiveLog(t1.id, '接力至 xxx')
    check('★ 归档备注落 ## 归档备注 节（不借道完成确认，两者并存）',
      /## 归档备注/.test(read(t1.id)) && /## 完成确认/.test(read(t1.id)))
    lg.setLogPinned(t1.id, false)
    check('★★ 归档备注在任意写回后仍在', /## 归档备注[\s\S]*接力至 xxx/.test(read(t1.id)))
    const reopen = lg.reopenLog(t1.id)
    check('★ 撤销后确认尾巴清干净（退回待处理不留残迹）',
      reopen.ok === true && !/## 完成确认/.test(read(t1.id)) && !/## 归档备注/.test(read(t1.id)),
      read(t1.id))

    // 渲染层接线守卫（静态）：数据层通了不等于界面有入口
    check('★★ 完成态日志卡有接力入口（⏭ 按钮 + openRelay 函数）',
      /从这里继续/.test(APP) && /function openRelay/.test(APP))
    check('★★ 工具条有「分区｜按链」分段开关（默认分区，pref 落真身）',
      /setLogsViewMode\('chain'\)/.test(APP) && /fc_logs_view_mode/.test(APP))
    check('★ 卡面有链标签 ⛓ 续自（可复制源 ID）', /续自/.test(APP) && /shortLogId/.test(APP))
    check('★ 按链 = 链头 + 竖轨，纯渲染层连通分量（不引入新实体）',
      /buildChainSections/.test(APP) && /chain-rail/.test(APP) && /logChain\(id/.test(
        fs.readFileSync(path.join(DIST, 'services', 'logs.js'), 'utf-8').replace(/\r/g, '')) )
    check('★ 接力对话框四件事齐全（归档出清 / 任务置完成 / 创建 / 开跑）',
      /archiveSource/.test(APP) && /completeSourceTasks/.test(APP) && /executeRelay\(true\)/.test(APP))
    check('★ 接力先建新日志、再动源（顺序写死在 executeRelay 里）',
      /logsCreate[\s\S]{0,1200}logsArchive\(src\.id\)/.test(APP))
    check('★ IPC/PRELOAD extra 透传 nextSteps + continueFrom',
      /nextSteps\?: string; continueFrom\?: string/.test(PRELOAD))
    // ── 2026-09-30 用户第 1/2/3/4 条（卡 002~004）────────────────────────
    check('★★ 卡002：新建日志的创建分支必须传 nextSteps（此前漏传 → 新建填的下一步必丢）',
      /logsCreate\([\s\S]{0,400}nextSteps: e\.nextSteps/.test(APP))
    check('★★ 卡003：executeRelay 给 IPC 的 taskIds 必须展开成普通数组（裸响应式代理过 contextBridge 必抛 could not be cloned）',
      /taskIds: \[\.\.\.\(r\.taskIds \|\| \[\]\)\]/.test(APP) &&
      !/taskIds: r\.taskIds \|\| \[\]/.test(APP))
    check('★★ 卡004a：接力对话框有「执行内容」可贴字段（此前只有下一步一个文本框）',
      /v-model="relay_\.content"/.test(APP) && /executeRelay[\s\S]{0,600}r\.content/.test(APP))
    check('★★ 卡004b：接力关闭走 closeRelay 防丢确认（遮罩 + 取消按钮，不再裸置 null）',
      /function closeRelay/.test(APP) && /@click\.self="closeRelay"/.test(APP) &&
      /@click="closeRelay"/.test(APP) && !/@click\.self="relay_ = null"/.test(APP))
    // ── 2026-09-30 用户第 1/2 条（卡 006）：字段顺序 + 关闭防丢 ──────────────
    const RELAY = APP.slice(APP.indexOf('id="relay-modal"'),
      APP.indexOf('指派时间', APP.indexOf('id="relay-modal"') + 1))
    check('★★ 卡006a：接力对话框里执行内容在上、下一步在下（认知顺序，此前上下颠倒）',
      RELAY.indexOf('id="relay-modal"') >= 0 && RELAY.indexOf('relay_.content') >= 0 &&
      RELAY.indexOf('relay_.content') < RELAY.indexOf('relay_.nextSteps'),
      'content@' + RELAY.indexOf('relay_.content') + ' nextSteps@' + RELAY.indexOf('relay_.nextSteps'))
    check('★★ 卡006b：关闭防丢改成对话框内确认条（原生 confirm 已从 closeRelay 移除）',
      /v-if="relayDiscard_"/.test(RELAY) && /discardRelay/.test(RELAY) &&
      /function closeRelay[\s\S]{0,700}relayChanges\(r\)/.test(APP) &&
      !/function closeRelay[\s\S]{0,700}[^a-zA-Z]confirm\(/.test(APP))
    check('★★ 卡006c：脏检查覆盖全部字段（文本 + 下拉 + 勾选 + 出清开关），不只看有没有字',
      /function relayChanges/.test(APP) && /源归档开关/.test(APP) && /关联任务/.test(APP) &&
      /_init: null as any/.test(APP))
    // ── 2026-10-02 用户「下一步依旧每次都直接挪用上次的输入结果」：预填取消，改主动带入 ──
    const OPENRELAY = APP.slice(APP.indexOf('function openRelay'), APP.indexOf('function bringSourceNextSteps'))
    check('★★ 20261002a：openRelay 不再预填源的下一步（默认留空）',
      OPENRELAY.indexOf('function openRelay') >= 0 && /nextSteps: ''/.test(OPENRELAY) &&
      !/nextSteps: src\.nextSteps/.test(OPENRELAY),
      JSON.stringify((OPENRELAY.match(/nextSteps:[^,\n]*/) || [''])[0]))
    check('★★ 20261002b：带入按钮 + bringSourceNextSteps 是唯一取回入口（模板常显，非 hover 藏起）',
      /function bringSourceNextSteps/.test(APP) && /relay-bring/.test(APP) &&
      /@click\.stop="bringSourceNextSteps"/.test(APP))
    check('★★ 20261002c：带入不覆盖已有内容、源为空时明说（不静默吃掉用户刚写的东西）',
      /本框已有内容，未覆盖/.test(APP) && /本来就是空的/.test(APP))
    check('★ 20261002d：带入或手写的内容仍透传落盘（executeRelay 传 r.nextSteps）',
      /executeRelay[\s\S]{0,900}nextSteps: r\.nextSteps/.test(APP))
    check('★ 20261002e：界面不再宣称「下一步已带入」（旧预填文案清干净）',
      !/下一步已带入/.test(APP))
    // ── 2026-10-03 用户反馈1/2（卡 task-20261003-001/002）─────────────────
    check('★★ 反馈1：接力拆两字段（prevAgentName=上次 + agentName=本次），编辑框不再一字段两义',
      /上次的执行 Agent/.test(APP) && /prevAgentName: r\.prevAgentName/.test(APP) &&
      /v-model="logEdit_\.prevAgentName"/.test(APP) && /log-prev-agent/.test(APP))
    check('★★ 反馈2：openRelay 标题不再沿用源（留空 = 每个日志创建新标题）',
      /title: ''/.test(OPENRELAY) && !/title: src\.title/.test(OPENRELAY),
      JSON.stringify((OPENRELAY.match(/title: [^\n]*/) || [''])[0]))
    // ── 2026-10-03 族1（卡 task-20261003-004）：关闭防丢统一口径 ────────────
    check('★★ 族1a：hasAnyText 旧口径的函数体已删除，方针卡/项目/应用/待办收编进 makeDirtyGuard（快照口径）',
      /function makeDirtyGuard/.test(APP) && !/function hasAnyText/.test(APP) &&
      ['policyGuard.dirty', 'projGuard.dirty', 'appGuard.dirty', 'todoGuard.dirty'].every(s => APP.includes(s)))
    check('★★ 族1b：四个打开入口都存快照（Guard.open），关闭函数走 dirty 比对而非裸置 null',
      ['policyGuard.open', 'projGuard.open', 'appGuard.open', 'todoGuard.open'].every(s => APP.includes(s)) &&
      /function closeTodoEditor[\s\S]{0,200}todoGuard\.dirty/.test(APP))
    // ── 2026-10-03 卡 task-20261003-005：日志关闭防丢与接力统一成同一套 ──────
    check('★★ 卡005：日志编辑用对话框内警告条（logDiscardBar/ref），原生 confirm 已移除',
      /ref="logDiscardBar"/.test(APP) &&
      /function closeLogEditor[\s\S]{0,600}logDiscard_\.value = true/.test(APP) &&
      !/日志内容尚未保存，确定关闭并丢弃吗/.test(APP))
    check('★★ 卡005：CSS 层面也共用（:is 圈住 #relay-modal 与 #log-edit-modal 两个宿主）',
      /:is\(#relay-modal, #log-edit-modal\) \.relay-discard/.test(APP))
  }

  // ── 2026-10-03 族2 写盘收敛（源码守卫，静态）────────────────────────────
  //   11 处手写 tmp+rename 已统一改走 data/index.ts 的 atomicWriteBackup（写前滚动备份）。
  //   只允许 data/index.ts（atomicWrite / atomicWriteBackup 本体）保留该写法，防回潮。
  {
    const SRC_MAIN = path.resolve(__dirname, '../../desktop/src/main')
    const GUARD_FILES = [
      'services/logs.ts', 'services/notifications.ts', 'services/policies.ts',
      'services/portRegistry.ts', 'services/prefs.ts', 'llm/config.ts',
      'backup/config.ts', 'launchpad/config.ts', 'data/index.ts',
    ]
    const readSrc = (f) => fs.readFileSync(path.join(SRC_MAIN, f), 'utf-8').replace(/\r/g, '')
    const handWritten = GUARD_FILES.filter((f) => {
      const s = readSrc(f)
      return /writeFileSync\(\s*tmp/.test(s) || /renameSync\(\s*tmp/.test(s)
    })
    check('★★ 2026-10-03 族2a：共享入口存在（data/index.ts 导出 atomicWriteBackup）',
      /export function atomicWriteBackup\(/.test(readSrc('data/index.ts')))
    check('（对照）data/index.ts 仍含手写 tmp+rename（守卫正则本身没写坏）',
      handWritten.includes('data/index.ts'), JSON.stringify(handWritten))
    check('★★ 2026-10-03 族2b：其余 8 个文件不再手写 writeFileSync(tmp / renameSync(tmp（防回潮）',
      handWritten.filter((f) => f !== 'data/index.ts').length === 0,
      JSON.stringify(handWritten.filter((f) => f !== 'data/index.ts')))
    check('★★ 2026-10-03 族2c：logs.ts 本地 atomicallyWrite 只剩薄壳（委托共享 helper，重复实现只留一个）',
      /function atomicallyWrite\([\s\S]{0,200}atomicWriteBackup\(filePath, content\)/.test(
        readSrc('services/logs.ts')))
    check('★★ 2026-10-03 族2d：atomicWrite 带可选 mode（llm/backup 的 0o600 语义不丢）',
      /export function atomicWrite\(filePath: string, content: string, mode\?: number\)/.test(
        readSrc('data/index.ts')))
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('\n失败项：')
    for (const f of failures) console.log(' -', f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
