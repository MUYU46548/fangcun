/**
 * 任务删除/归档 —— 同名重复副本的健壮性回归
 *
 * 背景（2026-09-25 用户第 5 条「完成和驳回任务依旧删不掉」）：
 *   真实数据里同一 id 同时存在于 `task-data/archive/` 与 `task-data/.trash/`（8 个任务如此）。
 *   `fs.renameSync` 在 Windows 上目标已存在就直接抛 EPERM/EEXIST →
 *   guardedHandle rethrow → 渲染层 await 收到 rejected promise →
 *   按钮点了完全没反应（静默失败）。
 *
 * 本测试固定三件事：
 *   ① 目标同名文件已存在时，删除/归档/还原都不是「抛」，而是去重或幂等成功；
 *   ② readTask 优先返回活跃区副本，绝不优先命中回收站里的那份；
 *   ③ 删除一次后再删（幂等）仍返回 true，不产生无限重复的 trash 文件。
 *
 * 运行：node scripts/test/e2e-task-delete.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

// ── electron 桩注入（必须在业务模块之前） ────────────────────────────
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-del-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT

const DIST = path.resolve(__dirname, '../../desktop/dist/main')

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

function main() {
  console.log('== 任务删除/归档重复副本健壮性测试 ==')
  console.log('root:', TEST_ROOT)

  fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
  fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'),
    'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示\n', 'utf-8')

  const data = require(path.join(DIST, 'data', 'index.js'))
  const tasks = require(path.join(DIST, 'data', 'tasks.js'))
  data.setDataDir(TEST_ROOT)

  const taskDir = path.join(TEST_ROOT, 'task-data')
  const archiveDir = path.join(taskDir, 'archive')
  const trashDir = path.join(taskDir, '.trash')

  // ── 1. 基础：创建 → 归档 → 删除 ─────────────────────────────────────
  const t1 = tasks.createTask({ title: '可删任务一', project: 'demo' })
  check('创建任务落在活跃区', fs.existsSync(path.join(taskDir, `${t1.id}.md`)))

  const a1 = tasks.archiveTask(t1.id)
  check('归档后任务可读', !!a1)
  check('归档后文件在 archive/', fs.existsSync(path.join(archiveDir, `${t1.id}.md`)))
  check('归档后活跃区不再有该文件', !fs.existsSync(path.join(taskDir, `${t1.id}.md`)))

  let deleted = null
  let threw = null
  try { deleted = tasks.deleteTask(t1.id) } catch (e) { threw = e }
  check('删除归档任务不抛异常', threw === null, threw ? String(threw.message) : '')
  check('删除归档任务返回 true', deleted === true, String(deleted))
  check('删除后文件进 .trash/', fs.existsSync(path.join(trashDir, `${t1.id}.md`)))
  check('删除后 archive/ 里已无该文件', !fs.existsSync(path.join(archiveDir, `${t1.id}.md`)))

  // ── 2. 幂等：再删一次不抛、返回 true、不新增副本 ────────────────────
  let again = null
  threw = null
  try { again = tasks.deleteTask(t1.id) } catch (e) { threw = e }
  check('重复删除不抛异常', threw === null, threw ? String(threw.message) : '')
  check('重复删除幂等返回 true', again === true, String(again))
  const t1TrashCount = fs.readdirSync(trashDir).filter(n => n.startsWith(t1.id)).length
  check('重复删除不新增 trash 副本', t1TrashCount === 1, `trash 内 ${t1.id} 相关文件数 = ${t1TrashCount}`)

  // ── 3. 核心回归：同一 id 同时存在于 archive/ 与 .trash/ ─────────────
  //    这正是线上 8 个任务的真实状态
  const t2 = tasks.createTask({ title: '可删任务二', project: 'demo' })
  fs.mkdirSync(archiveDir, { recursive: true })
  fs.mkdirSync(trashDir, { recursive: true })
  const t2Body = fs.readFileSync(path.join(taskDir, `${t2.id}.md`), 'utf-8')
  fs.writeFileSync(path.join(trashDir, `${t2.id}.md`), t2Body, 'utf-8')   // 假装曾被删过
  fs.writeFileSync(path.join(archiveDir, `${t2.id}.md`), t2Body, 'utf-8') // 又归档了一份
  fs.rmSync(path.join(taskDir, `${t2.id}.md`))                            // 活跃区没有

  threw = null
  let r2 = null
  try { r2 = tasks.deleteTask(t2.id) } catch (e) { threw = e }
  check('同名副本同时存在时删除不抛异常', threw === null, threw ? String(threw.message) : '')
  check('同名副本同时存在时删除返回 true', r2 === true, String(r2))
  check('删除后 archive/ 副本被清掉', !fs.existsSync(path.join(archiveDir, `${t2.id}.md`)))
  check('删除后 .trash 里至少有该任务', fs.readdirSync(trashDir).some(n => n.startsWith(t2.id)))

  // ── 4. readTask 优先活跃区，不优先命中回收站 ────────────────────────
  const t3 = tasks.createTask({ title: '活跃优先', project: 'demo', status: '进行中' })
  const t3Body = fs.readFileSync(path.join(taskDir, `${t3.id}.md`), 'utf-8')
  fs.mkdirSync(trashDir, { recursive: true })
  fs.writeFileSync(path.join(trashDir, `${t3.id}.md`),
    t3Body.replace('活跃优先', '垃圾桶里的旧版'), 'utf-8')
  const read3 = tasks.readTask(t3.id)
  check('readTask 命中活跃区副本', !!read3 && read3.path === path.join(taskDir, `${t3.id}.md`),
    read3 ? read3.path : 'null')

  // ── 5. 归档时归档区已有同名副本 → 不抛，且不留两份 ──────────────────
  const t4 = tasks.createTask({ title: '归档去重', project: 'demo' })
  const t4Body = fs.readFileSync(path.join(taskDir, `${t4.id}.md`), 'utf-8')
  fs.mkdirSync(archiveDir, { recursive: true })
  fs.writeFileSync(path.join(archiveDir, `${t4.id}.md`), t4Body, 'utf-8') // 归档区先有一份
  threw = null
  try { tasks.archiveTask(t4.id) } catch (e) { threw = e }
  check('归档时同名副本已存在不抛异常', threw === null, threw ? String(threw.message) : '')
  const t4ArchiveCount = fs.readdirSync(archiveDir).filter(n => n.startsWith(t4.id)).length
  check('归档去重后 archive/ 内只有一份', t4ArchiveCount === 1, `archive 内 ${t4.id} 相关文件数 = ${t4ArchiveCount}`)

  // ── 6. 未知 id 删除返回 false（不是抛） ─────────────────────────────
  threw = null
  let r6 = null
  try { r6 = tasks.deleteTask('task-19990101-999') } catch (e) { threw = e }
  check('删除未知 id 不抛异常', threw === null, threw ? String(threw.message) : '')
  check('删除未知 id 返回 false', r6 === false, String(r6))

  // ── 7. 批量归档必须「真归档」（用户 2026-09-25 第 2 条：假归档）────────
  const b1 = tasks.createTask({ title: '批量归档甲', project: 'demo', status: '进行中' })
  const b2 = tasks.createTask({ title: '批量归档乙', project: 'demo', status: '待办' })
  const br = tasks.batchArchive([b1.id, b2.id, 'task-19990101-999'])
  check('batchArchive 不抛异常', true)
  check('batchArchive 成功数 = 2', br.ok === 2, JSON.stringify(br))
  check('batchArchive 不存在的 id 计入 fails', br.fails.length === 1 && br.fails[0].id === 'task-19990101-999',
    JSON.stringify(br.fails))
  check('批量归档后文件确实进了 archive/', fs.existsSync(path.join(archiveDir, `${b1.id}.md`)) && fs.existsSync(path.join(archiveDir, `${b2.id}.md`)))
  check('批量归档后活跃区已无文件', !fs.existsSync(path.join(taskDir, `${b1.id}.md`)) && !fs.existsSync(path.join(taskDir, `${b2.id}.md`)))

  // 关键：旧实现只把 status 改成「完成」而不移动文件 —— 断言状态没被偷改
  const b1After = tasks.readTask(b1.id)
  check('批量归档不偷改状态（不再用 status=完成 冒充归档）', b1After?.fm.status === '进行中',
    String(b1After?.fm.status))

  // 归档视图按路径能查到，且带 archived 标记（三套标签同源）
  const archView = data.loadTasks('archive')
  check('归档视图能看到批量归档的任务', archView.some(t => t.id === b1.id) && archView.some(t => t.id === b2.id))
  check('归档任务带 archived=true 盖章', archView.find(t => t.id === b1.id)?.archived === true,
    String(archView.find(t => t.id === b1.id)?.archived))
  const activeView = data.loadTasks('active')
  check('活跃视图不含已归档任务', !activeView.some(t => t.id === b1.id) && !activeView.some(t => t.id === b2.id))
  check('活跃视图的任务没有 archived 盖章', activeView.every(t => t.archived !== true))

  // ── 8. 同 id 存在陈旧副本：新的必须占规范名，旧的改名保留（绝不销毁）─
  //    真实数据里就存在这种组合：活跃区是今天改过的，.trash 里躺着 9-18 的旧副本。
  //    旧实现两种错法：deleteTask 让新来的加 .2 后缀（→ readTask 读到旧版本），
  //    archiveTask/unarchiveTask 直接 rmSync 源文件（→ 静默销毁当前版本）。
  const week = new Date(Date.now() - 7 * 86400000)

  // 8a. 删除时回收站已有陈旧副本
  const s1 = tasks.createTask({ title: '同id并存', project: 'demo', status: '进行中' })
  const s1Active = path.join(taskDir, `${s1.id}.md`)
  const s1Fresh = fs.readFileSync(s1Active, 'utf-8')
  fs.mkdirSync(trashDir, { recursive: true })
  fs.writeFileSync(path.join(trashDir, `${s1.id}.md`), s1Fresh.replace('同id并存', '同id并存-一周前的旧版本'), 'utf-8')
  fs.utimesSync(path.join(trashDir, `${s1.id}.md`), week, week)
  fs.utimesSync(s1Active, new Date(), new Date())

  check('有陈旧回收站副本时删除仍返回成功', tasks.deleteTask(s1.id) === true)
  check('★ 回收站规范名装的是【刚删的当前版本】',
    fs.readFileSync(path.join(trashDir, `${s1.id}.md`), 'utf-8') === s1Fresh)
  check('★ 旧副本被改名保留（没被删掉）', fs.existsSync(path.join(trashDir, `${s1.id}.md.old`)))
  const s1Reread = tasks.readTask(s1.id)
  check('★ readTask 不再读到旧版本', !!s1Reread && s1Reread.fm.title === '同id并存',
    String(s1Reread && s1Reread.fm.title))

  // 8b. 归档时归档区已有陈旧副本 —— 旧实现在这里 rmSync 销毁当前版本
  const s2 = tasks.createTask({ title: '归档不许销毁当前版本', project: 'demo', status: '待办' })
  const s2Active = path.join(taskDir, `${s2.id}.md`)
  const s2Fresh = fs.readFileSync(s2Active, 'utf-8')
  fs.mkdirSync(archiveDir, { recursive: true })
  fs.writeFileSync(path.join(archiveDir, `${s2.id}.md`), s2Fresh.replace('归档不许销毁当前版本', '归档区旧副本'), 'utf-8')
  fs.utimesSync(path.join(archiveDir, `${s2.id}.md`), week, week)
  fs.utimesSync(s2Active, new Date(), new Date())
  tasks.archiveTask(s2.id)
  check('★ 归档不销毁当前版本（归档区规范名是刚归档的那份）',
    fs.readFileSync(path.join(archiveDir, `${s2.id}.md`), 'utf-8') === s2Fresh)
  check('★ 归档区旧副本改名保留', fs.existsSync(path.join(archiveDir, `${s2.id}.md.old`)))
  check('★ 归档后 readTask 拿到新版本', tasks.readTask(s2.id)?.fm.title === '归档不许销毁当前版本')

  // 8c. 反过来：进来的那份更旧 → 它让位，规范名继续由更新的那份占着
  const s3 = tasks.createTask({ title: '旧的该让位', project: 'demo', status: '待办' })
  const s3Active = path.join(taskDir, `${s3.id}.md`)
  const s3Fresh = fs.readFileSync(s3Active, 'utf-8')
  const future = new Date(Date.now() + 7 * 86400000)
  fs.writeFileSync(path.join(archiveDir, `${s3.id}.md`), s3Fresh.replace('旧的该让位', '归档区更新的那份'), 'utf-8')
  fs.utimesSync(path.join(archiveDir, `${s3.id}.md`), future, future)
  fs.utimesSync(s3Active, week, week)
  tasks.archiveTask(s3.id)
  check('★ 更旧的归档请求不让它顶掉更新的副本',
    fs.readFileSync(path.join(archiveDir, `${s3.id}.md`), 'utf-8').includes('归档区更新的那份'))
  check('★ 让位的那份也被保留（.old）', fs.existsSync(path.join(archiveDir, `${s3.id}.md.old`)))

  // ── 9. 文件名不是 `${id}.md` 的副本：板子上看得见、却删不掉 ────────────
  // 真实数据里躺着 `task-20260904-001.2.md` / `task-20260907-001.2.md` 这类旧名副本
  // （状态正是「驳回/完成」—— 用户 2026-09-24 第 1 条「驳回和完成依旧是删不掉的」）。
  // 根因：loadTasks 会把这些 `.md` 读成任务（板子上看得见），而 deleteTask 只按
  // `${id}.md` 精确找文件 → 找不到 → 返回 false → 界面「删除失败：任务不存在」。
  console.log('\n== 9. 非规范文件名的副本（看得见但删不掉）==')
  const d1 = tasks.createTask({ title: '完成态要能删', project: 'demo', status: '完成' })
  const d1Canon = path.join(taskDir, `${d1.id}.md`)
  const d1Copy = path.join(taskDir, `${d1.id}.2.md`)
  fs.writeFileSync(d1Copy, fs.readFileSync(d1Canon, 'utf-8'), 'utf-8')
  const view1 = data.loadTasks('active').filter(t => t.id === d1.id)
  check('同一 id 的两个文件在活跃视图里只出现一次（不再显示两遍）',
    view1.length === 1, `出现 ${view1.length} 次`)
  check('保留的是规范名那份', view1[0] && view1[0].path === d1Canon, view1[0] && view1[0].path)
  let threw9 = null
  let del9 = null
  try { del9 = tasks.deleteTask(d1.id) } catch (e) { threw9 = e }
  check('非规范名副本存在时删除不抛异常', threw9 === null, threw9 ? String(threw9.message) : '')
  check('★ 非规范名副本存在时删除返回 true（不再是「任务不存在」）', del9 === true, String(del9))
  check('★ 活跃区两份都被清掉（不留看得见却删不掉的孤儿）',
    !fs.existsSync(d1Canon) && !fs.existsSync(d1Copy))
  check('回收站里能看到该任务（可人工找回）',
    fs.readdirSync(trashDir).some(n => n === `${d1.id}.md` || n.startsWith(`${d1.id}.`)))
  check('★ 再删一次幂等返回 true（旧名副本也算「已删过」）', tasks.deleteTask(d1.id) === true)

  // 9b. 归档区里的终态任务必须能删 —— 用户报的「完成/驳回删不掉」正是这一批
  const d2 = tasks.createTask({ title: '归档区驳回态', project: 'demo', status: '驳回' })
  tasks.archiveTask(d2.id)
  const del10 = tasks.deleteTask(d2.id)
  check('★ 归档区里的「驳回」任务能删（用户第 1 条）', del10 === true, String(del10))
  check('删除后归档区不再有该文件', !fs.existsSync(path.join(archiveDir, `${d2.id}.md`)))

  // 9c. 前缀相似的不同 id 不能互相误伤（匹配必须带点号）
  const p1 = tasks.createTask({ title: '前缀一', project: 'demo', status: '待办' })
  const p1File = path.join(taskDir, `${p1.id}.md`)
  const p1Like = path.join(taskDir, `${p1.id}0.md`)
  fs.writeFileSync(p1Like,
    fs.readFileSync(p1File, 'utf-8').replace(`id: ${p1.id}`, `id: ${p1.id}0`), 'utf-8')
  tasks.deleteTask(p1.id)
  check('★ 删除 task-A 不误删 task-A0（前缀相似不能连坐）', fs.existsSync(p1Like))
  check('同批只删掉了自己的那份', !fs.existsSync(p1File))

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
