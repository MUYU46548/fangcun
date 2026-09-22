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
  const a = logs.createLog('日志A', 'demo', '内容A', 'task-001')
  check('创建后文件落盘', fs.existsSync(path.join(LOGS_DIR, `${a.id}.md`)))
  check('创建时项目正确写入', logs.getLog(a.id).project === 'demo', logs.getLog(a.id).project)
  check('创建时关联任务写入（tasks 数组）', logs.getLog(a.id).taskId === 'task-001', String(logs.getLog(a.id).taskId))
  const fileText = fs.readFileSync(path.join(LOGS_DIR, `${a.id}.md`), 'utf-8')
  check('文件里确实有 tasks 数组', /tasks:\s*\r?\n?\s*-\s*task-001/.test(fileText), fileText.split('\n').slice(0, 16).join(' | '))

  // ── 2. 改项目 / 改关联任务（用户报障的原型）───────────────────────
  const u1 = logs.updateLog(a.id, { project: 'nf', taskId: 'task-002' })
  check('updateLog 返回更新后的对象', !!u1 && u1.project === 'nf', JSON.stringify(u1 && { p: u1.project, t: u1.taskId }))
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
  const b = logs.createLog('日志B', 'demo', '内容B')
  logs.archiveLog(b.id)
  check('已归档日志 updateLog 返回 null', logs.updateLog(b.id, { project: 'nf' }) === null)
  check('已归档日志的项目没被偷改', logs.getLog(b.id).project === 'demo', logs.getLog(b.id).project)

  // ── 6. 完成 → 保留期 → 清理超期 ───────────────────────────────────
  const c = logs.createLog('日志C', 'demo', '内容C')
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
  const d = logs.createLog('日志D', 'nf', '内容D', 'task-002')
  check('按项目筛选', logs.listLogs({ project: 'nf' }).every(l => l.project === 'nf'))
  check('按状态筛选', logs.listLogs({ status: 'archived' }).every(l => l.status === 'archived'))
  check('logsForTask 反查到两条', logs.logsForTask('task-002').length >= 1, String(logs.logsForTask('task-002').length))
  check('logsForTask 空 id 返回空', logs.logsForTask('').length === 0)
  check('按标题搜到', logs.searchLogs('日志D').some(l => l.id === d.id))

  // ── 8. taskId 兼容多种历史写法 ────────────────────────────────────
  fs.writeFileSync(path.join(LOGS_DIR, 'legacy-1.md'),
    '---\ntype: execution-log\nid: legacy-1\ntitle: 老写法\nproject: demo\nstatus: active\n关联任务: task-009\n---\n\n# 老写法\n\n## 执行内容\n\nx\n\n## 下一步\n\n（待填写）', 'utf-8')
  check('兼容中文「关联任务」键', logs.getLog('legacy-1').taskId === 'task-009', String(logs.getLog('legacy-1').taskId))

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('\n失败项：')
    for (const f of failures) console.log(' -', f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
