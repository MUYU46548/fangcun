/**
 * 撤销能力收口（卡 task-20261018-001）
 *
 * 用户原话（2026-10-18）：「根本没有撤回选项，狂按 Ctrl+Z 也没用」。
 * 本轮补的不是「全站撤销栈」，而是把已经躺在 `.backup` 里的历史版本接出来：
 *   - 日志：历史版本列表（时间 + 标题 + 大小）→ 逐版预览 / 恢复到任意一版；
 *   - 任务卡：同样的历史版本列表 → 逐版预览 / 恢复；
 *   - 恢复前必须先把当前版备份一次（撤错了还能再撤回来）；
 *   - 非法版本（路径穿越 / 不存在的文件名 / 结构坏掉）一律拒写，当前文件零改动。
 *
 * 运行：node scripts/test/e2e-undo-history.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

// electron 桩注入必须在业务模块之前
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-undo-history-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT
fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'),
  'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示\n', 'utf-8')

const DIST = path.resolve(__dirname, '../../desktop/dist/main')
const REPO = path.resolve(__dirname, '../..')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

/** 同一毫秒内连写会撞备份文件名（rotateBackup 已补到毫秒，但同毫秒仍会覆盖）——
 *  测试里每次写前跨过一个毫秒，钉的是「版本能力」而不是「时钟分辨率」。 */
function tick() {
  const end = Date.now() + 3
  while (Date.now() < end) { /* spin */ }
}

function main() {
  console.log('== 撤销能力收口 e2e ==')
  console.log('root:', TEST_ROOT)

  const data = require(path.join(DIST, 'data', 'index.js'))
  data.setDataDir(TEST_ROOT)
  const logs = require(path.join(DIST, 'services', 'logs.js'))
  const tasks = require(path.join(DIST, 'data', 'tasks.js'))

  const LOGS_DIR = path.join(TEST_ROOT, 'docs', '执行日志')
  const LOG_BACKUP = path.join(LOGS_DIR, '.backup')
  const TASK_BACKUP = path.join(TEST_ROOT, 'task-data', '.backup')

  // ── 一、日志历史版本列表 ─────────────────────────────────────────────
  const L = logs.createLog('第一版', 'demo', '内容一').data
  tick()
  logs.updateLog(L.id, { title: '第二版', content: '内容二' })
  tick()
  logs.updateLog(L.id, { title: '第三版', content: '内容三' })

  const vs = logs.listLogVersions(L.id)
  check('★ 历史版本列表 > 1 版（不是只有"上一版"一个入口）', vs.length >= 2, String(vs.length))
  check('★ 列表带标题（能从列表里认出是哪一版）', vs[0]?.title === '第二版', JSON.stringify(vs[0]))
  check('★ 列表带时间与大小（时间 + 标题 + 大小三件齐）',
    !!vs[0]?.at && typeof vs[0]?.size === 'number' && vs[0].size > 0, JSON.stringify(vs[0]))
  const v1 = vs.find(v => v.title === '第一版')
  check('★ 较早的那版也在列表里', !!v1, JSON.stringify(vs.map(v => v.title)))

  const detail = logs.getLogVersion(L.id, v1.file)
  check('★ 单版可预览（返回该版正文）',
    detail.ok === true && detail.data?.content === '内容一' && detail.data?.title === '第一版',
    JSON.stringify({ ok: detail.ok, t: detail.data?.title, c: detail.data?.content }))

  const beforeLogCount = logs.listLogVersions(L.id).length
  const restored = logs.restoreLogVersion(L.id, v1.file)
  check('★ 恢复到指定旧版返回 ok', restored.ok === true, JSON.stringify(restored))
  check('★★ 恢复后内容逐字等于该版本',
    logs.getLog(L.id).content === '内容一' && logs.getLog(L.id).title === '第一版',
    JSON.stringify({ t: logs.getLog(L.id).title, c: logs.getLog(L.id).content }))
  check('★★ 恢复前自动备份当前版（撤错了还能再撤回来）',
    logs.listLogVersions(L.id).length > beforeLogCount &&
    logs.listLogVersions(L.id).some(v => v.title === '第三版'),
    JSON.stringify(logs.listLogVersions(L.id).map(v => v.title)))

  const logCurrent = logs.getLog(L.id).content
  const badPath = logs.restoreLogVersion(L.id, '../../evil.bak')
  check('★ 路径穿越版本文件名 → 拒写', badPath.ok === false && logs.getLog(L.id).content === logCurrent,
    JSON.stringify(badPath))
  const badName = logs.restoreLogVersion(L.id, `${L.id}.md.99999999999999999.bak`)
  check('★ 不存在的版本文件 → 拒写（不造文件、不改当前）',
    badName.ok === false && logs.getLog(L.id).content === logCurrent)
  fs.mkdirSync(LOG_BACKUP, { recursive: true })
  const brokenLog = `${L.id}.md.88888888888888888.bak`
  fs.writeFileSync(path.join(LOG_BACKUP, brokenLog), '这不是日志，没有 frontmatter', 'utf-8')
  const badStruct = logs.restoreLogVersion(L.id, brokenLog)
  check('★★ 结构坏掉的版本 → 拒写，当前文件零改动',
    badStruct.ok === false && logs.getLog(L.id).content === logCurrent,
    JSON.stringify(badStruct))

  // ── 二、任务卡历史版本 + 撤回 ───────────────────────────────────────
  const T = tasks.createTask({ title: '任务一', body: '正文一' })
  tick()
  tasks.updateTask(T.id, { title: '任务二', body: '正文二' })
  tick()
  tasks.updateTask(T.id, { title: '任务三', body: '正文三' })

  const tvs = tasks.listTaskVersions(T.id)
  check('★ 任务卡也有历史版本列表（不是日志专属）', tvs.length >= 2, String(tvs.length))
  check('★ 任务版本列表带标题 / 时间 / 大小',
    tvs[0]?.title === '任务二' && !!tvs[0]?.at && tvs[0]?.size > 0, JSON.stringify(tvs[0]))
  const t1 = tvs.find(v => v.title === '任务一')
  check('★ 较早的任务版本也在列表里', !!t1, JSON.stringify(tvs.map(v => v.title)))

  const tDetail = tasks.getTaskVersion(T.id, t1.file)
  check('★ 任务单版可预览（正文原文）',
    tDetail.ok === true && String(tDetail.data?.content || '').includes('正文一'),
    JSON.stringify({ ok: tDetail.ok, head: String(tDetail.data?.content || '').slice(0, 40) }))

  const beforeTaskCount = tasks.listTaskVersions(T.id).length
  const tRestored = tasks.restoreTaskVersion(T.id, t1.file)
  check('★ 任务恢复到指定旧版返回 ok', tRestored.ok === true, JSON.stringify(tRestored))
  const tNow = tasks.readTask(T.id)
  check('★★ 任务恢复后标题 / 正文逐字等于该版本',
    tNow?.fm?.title === '任务一' && tNow?.body === '正文一',
    JSON.stringify({ t: tNow?.fm?.title, b: tNow?.body }))
  check('★★ 任务恢复前也自动备份当前版',
    tasks.listTaskVersions(T.id).length > beforeTaskCount &&
    tasks.listTaskVersions(T.id).some(v => v.title === '任务三'),
    JSON.stringify(tasks.listTaskVersions(T.id).map(v => v.title)))

  const tCurrent = tNow?.body
  const tBadPath = tasks.restoreTaskVersion(T.id, '../../../evil.bak')
  check('★ 任务版本路径穿越 → 拒写',
    tBadPath.ok === false && tasks.readTask(T.id)?.body === tCurrent, JSON.stringify(tBadPath))
  const tBadName = tasks.restoreTaskVersion(T.id, `${T.id}.md.99999999999999999.bak`)
  check('★ 任务版本不存在 → 拒写',
    tBadName.ok === false && tasks.readTask(T.id)?.body === tCurrent)
  fs.mkdirSync(TASK_BACKUP, { recursive: true })
  const brokenTask = `${T.id}.md.88888888888888888.bak`
  fs.writeFileSync(path.join(TASK_BACKUP, brokenTask), '没有 frontmatter 的坏文件', 'utf-8')
  const tBadStruct = tasks.restoreTaskVersion(T.id, brokenTask)
  check('★★ 任务版本结构坏掉 → 拒写，当前卡零改动',
    tBadStruct.ok === false && tasks.readTask(T.id)?.body === tCurrent,
    JSON.stringify(tBadStruct))

  const noTask = tasks.listTaskVersions('task-nope')
  check('★ 不存在的任务 → 空列表（不抛异常）',
    Array.isArray(noTask) && noTask.length === 0, JSON.stringify(noTask))

  // ── 三、界面接线（静态守卫）─────────────────────────────────────────
  // 这一节防的是「主进程能力做完了、界面还是只有一个旧按钮」——上一轮的日志撤回
  // 就只接了"最新一版"，列表根本没人调。
  const app = fs.readFileSync(path.join(REPO, 'desktop/src/renderer/App.vue'), 'utf-8')
  for (const [name, needle] of [
    ['日志：读历史版本列表', 'logsVersions'],
    ['日志：读单版内容', 'logsVersionGet'],
    ['日志：恢复到指定版本', 'logsRestoreVersion'],
    ['任务：读历史版本列表', 'tasksVersions'],
    ['任务：读单版内容', 'tasksVersionGet'],
    ['任务：恢复到指定版本', 'tasksRestoreVersion'],
  ]) {
    check(`★ 界面接线：${name}`, app.includes(needle), needle)
  }
  check('★ 日志弹窗有「历史版本」入口',
    /logHistoryOpen/.test(app) && (app.match(/历史版本/g) || []).length >= 2,
    'App.vue 未出现历史版本面板')
  check('★ 任务弹窗也有「历史版本」入口', /taskHistoryOpen/.test(app), 'App.vue 未出现任务历史面板')

  // ── 四、源码守卫：恢复只能走已知备份目录 ─────────────────────────────
  const logsSrc = fs.readFileSync(path.join(REPO, 'desktop/src/main/services/logs.ts'), 'utf-8')
  const tasksSrc = fs.readFileSync(path.join(REPO, 'desktop/src/main/data/tasks.ts'), 'utf-8')
  check('★ 日志恢复不直接接收任意路径（先按列表校验文件名）',
    /function safeLogVersion/.test(logsSrc) || /versions\.find|listLogVersions\(/.test(logsSrc),
    '找不到按列表校验的实现')
  check('★ 任务恢复不直接接收任意路径（先按列表校验文件名）',
    /listTaskVersions\(/.test(tasksSrc) && /restoreTaskVersion/.test(tasksSrc),
    '找不到任务版本恢复实现')

  console.log(`\nRESULT ${pass} pass / ${fail} fail`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log(' -', f)
    process.exit(1)
  }
}

try { main() } catch (e) {
  console.error('FATAL', e && (e.stack || e.message || e))
  process.exit(2)
}
