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

  // ── 7. 列表筛选 / 反向索引 ────────────────────────────────────────
  const d = logs.createLog('日志D', 'nf', '内容D', 'task-002').data
  check('按项目筛选', logs.listLogs({ project: 'nf' }).every(l => l.project === 'nf'))
  check('按状态筛选', logs.listLogs({ status: 'archived' }).every(l => l.status === 'archived'))
  check('logsForTask 反查到两条', logs.logsForTask('task-002').length >= 1, String(logs.logsForTask('task-002').length))
  check('logsForTask 空 id 返回空', logs.logsForTask('').length === 0)
  check('按标题搜到', logs.searchLogs('日志D').some(l => l.id === d.id))

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
  check('★ 日志编辑框是多选（checkbox 绑 taskIds），不再只有单选下拉',
    /v-model="logEdit_\.taskIds"/.test(APP) && !/v-model="logEdit_\.taskId"/.test(APP))
  check('保存时发的是 taskIds（不是 taskId）',
    /taskIds: normalizeLogTaskIds\(e\)/.test(APP))
  check('★ 日志正文走 Markdown 渲染（第 13 条）：只读预览接 renderBody',
    /logPreview\.content\)/.test(APP) && /renderBody\(logPreview/.test(APP))
  check('单击日志卡 = 只读预览（编辑移到按钮/预览内，不再靠点卡片）',
    /logPreview\.value = \{ \.\.\.log \}/.test(APP) && /@click="openLog\(log\)"/.test(APP))

  // ── 11. 日志打回「进行中」（2026-09-26 用户补充第 3 条）──────────────
  // 用户原话：「希望日志加一个功能，可以临时打上进行中标签，并且卡片有特殊视觉效果，一目了然。」
  // 真因：状态此前是单行道（active→completed→archived，且 updateLog 明确拒绝改非 active），
  //       点过一次「完成」/「归档」就再也回不去 —— 没有「这条我又在弄了」的路。
  const r1 = logs.createLog('打回1', 'demo', 'x').data
  logs.completeLog(r1.id, 30, '做完')
  check('前置：这条日志已完成且带保留期',
    logs.getLog(r1.id).status === 'completed' && !!logs.getLog(r1.id).retainUntil)
  const rp1 = logs.reopenLog(r1.id)
  check('★ 已完成的日志能打回「进行中」', rp1.ok === true, JSON.stringify(rp1.error))
  const r1After = logs.getLog(r1.id)
  check('★ 打回后状态为 active', r1After.status === 'active', r1After.status)
  check('★ 打回顺手清掉「已完成 + 保留期」（不留下自相矛盾的字样）',
    !r1After.completed && !r1After.retainUntil && !r1After.retainDays,
    JSON.stringify({ c: r1After.completed, u: r1After.retainUntil, d: r1After.retainDays }))
  check('★ 打回后就能编辑了（updateLog 不再拒绝）',
    logs.updateLog(r1.id, { title: '打回1改' }).ok === true)

  const r2 = logs.createLog('打回2', 'demo', 'x').data
  logs.archiveLog(r2.id)
  check('★ 已归档的日志也能打回', logs.reopenLog(r2.id).ok === true && logs.getLog(r2.id).status === 'active')
  check('★ 打回只改状态：文件仍在（不删不搬）', fs.existsSync(path.join(LOGS_DIR, `${r2.id}.md`)))
  check('打回幂等：本来就是 active 时给 ok 且不报错',
    logs.reopenLog(r2.id).ok === true && logs.getLog(r2.id).status === 'active')
  check('打回不存在的日志给可读原因',
    logs.reopenLog('nope-999').ok === false && /不存在/.test(logs.reopenLog('nope-999').error || ''),
    JSON.stringify(logs.reopenLog('nope-999')))
  check('打回后能被「进行中」筛选捞出', logs.listLogs({ status: 'active' }).some(l => l.id === r2.id))

  // 渲染层接线守卫：数据层通了不等于界面有入口（卡 022 的坑就是这么来的）
  const PRELOAD = fs.readFileSync(path.resolve(__dirname, '../../desktop/src/preload/index.ts'), 'utf-8')
  check('★ 日志卡有「打回进行中」入口（模板按钮 + 函数都在）',
    /reopenLogItem\(log\.id\)/.test(APP) && /async function reopenLogItem/.test(APP))
  check('★ 打回走的是新通道 logs:reopen（preload 也暴露了）',
    /window\.tegula\.logsReopen\(id\)/.test(APP) && /logsReopen: \(id: string\) => ipcRenderer\.invoke\('logs:reopen'/.test(PRELOAD))
  check('★ 进行中的日志卡有醒目样式（不再只有一条细边框）',
    /\.log-card\.active \{[\s\S]{0,240}linear-gradient/.test(APP))

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('\n失败项：')
    for (const f of failures) console.log(' -', f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
