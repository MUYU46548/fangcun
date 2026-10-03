/**
 * 已完成任务自动归档（2026-10-03 卡 task-20261003-012）
 *
 * 用户口径：「看板已完成任务自动归档，**仿日志清理的保留天数设置**，默认关闭」。
 *
 * 本测试钉住四件事：
 *   ① 判据是「状态=完成 **且** 更新时间早于 N 天前」—— 不动的旧卡收走、刚动过的不收；
 *   ② 保留天数 0 = 功能关闭 → 永远空清单、永远不归档（默认必须是关的）；
 *   ③ 归档真的把文件移进 archive/（不是只改状态那种假归档），且可逆；
 *   ④ 时间字段三种老写法（ISO / 秒级 Unix / 毫秒）都要认。
 *
 * ⚠ 隔离：`FC_TEST_USERDATA` + `setDataDir(临时目录)` —— 否则会动**真实 task-data**。
 *
 * 运行：node scripts/test/e2e-archive-overdue.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

// ── electron 桩注入（必须在业务模块之前）────────────────────────────
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-arch-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT

const DIST = path.resolve(__dirname, '../../desktop/dist/main')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
}

/** 直接手写一张任务卡（这样能精确控制「更新」字段的写法） */
function writeCard(dir, id, status, updatedLine) {
  const body = [
    '---',
    `id: ${id}`,
    `标题: ${id} 的标题`,
    '项目: [demo]',
    `状态: ${status}`,
    `创建: '2026-01-01T00:00:00.000Z'`,
    updatedLine,
    '---',
    '',
    '## 结果记录',
    '做过一些事',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(dir, `${id}.md`), body, 'utf-8')
}

function main() {
  console.log('== 已完成任务自动归档测试 ==')
  console.log('root:', TEST_ROOT)

  const taskDir = path.join(TEST_ROOT, 'task-data')
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'),
    'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示\n', 'utf-8')

  const data = require(path.join(DIST, 'data', 'index.js'))
  const tasks = require(path.join(DIST, 'data', 'tasks.js'))
  data.setDataDir(TEST_ROOT)

  const iso = (daysAgo) => `更新: '${new Date(Date.now() - daysAgo * 86400000).toISOString()}'`
  const sec = (daysAgo) => `更新: ${Math.floor((Date.now() - daysAgo * 86400000) / 1000)}`
  const ms = (daysAgo) => `更新: ${Date.now() - daysAgo * 86400000}`

  // ── 夹具 ────────────────────────────────────────────────────────────
  writeCard(taskDir, 'task-old-done-iso', '完成', iso(60))     // 超期（ISO 写法）
  writeCard(taskDir, 'task-old-done-sec', '完成', sec(45))     // 超期（秒级 Unix）
  writeCard(taskDir, 'task-old-done-ms', '完成', ms(40))       // 超期（毫秒）
  writeCard(taskDir, 'task-fresh-done', '完成', iso(1))        // 不超期（刚完成）
  writeCard(taskDir, 'task-old-todo', '待办', iso(90))         // 状态不是完成 → 不收
  writeCard(taskDir, 'task-no-updated', '完成', '附言: 没写更新时间')  // 退到 mtime（刚写）→ 不收

  const list30 = tasks.listOverdueCompleted(30)
  const ids30 = list30.map(t => t.id).sort()
  check('★ 30 天阈值：两条超期的已完成任务都被列出来',
    JSON.stringify(ids30) === JSON.stringify(['task-old-done-iso', 'task-old-done-sec']),
    JSON.stringify(ids30))
  check('  刚完成的（1 天前）不在清单里', !ids30.includes('task-fresh-done'))
  check('  状态不是「完成」的不在清单里（旧的待办不会被收走）', !ids30.includes('task-old-todo'))
  check('  没写「更新」字段的退到文件 mtime —— 刚写的卡不被当成"老得不能再老"',
    !ids30.includes('task-no-updated'), JSON.stringify(ids30))
  // ⚠ 既有数据层口径（实测，别改）：frontmatter 里的**数字**时间戳一律按**秒级 Unix**解析
  //   （真实数据写的是 `创建: 1791024659`）。所以"毫秒"写法并不是一种真实格式 ——
  //   写了会被当秒 → 跑到 58616 年 → 永远不超期。这里把它钉成**负面案例**，防止
  //   以后有人"顺手支持毫秒"却把真实数据里的秒级卡一起理解错。
  check('  数字时间戳按既有口径当秒级解析：毫秒写法会跑到未来 → 不收（记录口径，不是缺陷）',
    !ids30.includes('task-old-done-ms'), JSON.stringify(ids30))

  // 阈值大小真的起作用
  check('★ 阈值 100 天：三条都在 100 天内 → 一条都不剩',
    tasks.listOverdueCompleted(100).length === 0, JSON.stringify(tasks.listOverdueCompleted(100).map(t => t.id)))
  check('  阈值 35 天：45/60 天那两张仍都在',
    tasks.listOverdueCompleted(35).length === 2, JSON.stringify(tasks.listOverdueCompleted(35).map(t => t.id)))

  // ── 关闭态 ─────────────────────────────────────────────────────────
  check('★ 保留天数 0 = 功能关闭 → 清单为空（默认必须是关的）', tasks.listOverdueCompleted(0).length === 0)
  check('  负数/NaN 同样当关闭处理', tasks.listOverdueCompleted(-5).length === 0 && tasks.listOverdueCompleted(NaN).length === 0)
  const off = tasks.archiveOverdueCompleted(0)
  check('★ 关闭态执行归档 → 一个都不动', off.archived.length === 0 && off.failed.length === 0, JSON.stringify(off))
  check('  关闭态下活跃区文件原封不动',
    fs.existsSync(path.join(taskDir, 'task-old-done-iso.md')))

  // ── 执行归档 ───────────────────────────────────────────────────────
  const r = tasks.archiveOverdueCompleted(30)
  check('★ 归档 2 条超期任务，无失败',
    r.archived.length === 2 && r.failed.length === 0, JSON.stringify(r))

  const archiveDir = path.join(taskDir, 'archive')
  for (const id of ['task-old-done-iso', 'task-old-done-sec']) {
    check(`  「${id}」文件真的移进 archive/（不是只改状态那种假归档）`,
      fs.existsSync(path.join(archiveDir, `${id}.md`)) && !fs.existsSync(path.join(taskDir, `${id}.md`)))
  }
  check('  没超期的卡一个都没动', fs.existsSync(path.join(taskDir, 'task-fresh-done.md')))
  check('  状态非完成的一点没动', fs.existsSync(path.join(taskDir, 'task-old-todo.md')))

  check('★ 归档后再查：清单为空（幂等，不会重复收）', tasks.listOverdueCompleted(30).length === 0)
  const again = tasks.archiveOverdueCompleted(30)
  check('  再执行一次：0 条（幂等）', again.archived.length === 0 && again.failed.length === 0, JSON.stringify(again))

  // ── 可逆：还原回活跃区 ─────────────────────────────────────────────
  const back = tasks.unarchiveTask('task-old-done-iso')
  check('★ 归档可逆：还原回活跃区且状态置回「待办」',
    !!back && String((back.fm || {}).status) === '待办' && fs.existsSync(path.join(taskDir, 'task-old-done-iso.md')),
    JSON.stringify(back && back.fm && back.fm.status))

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
