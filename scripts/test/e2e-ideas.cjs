#!/usr/bin/env node
/**
 * 想法（2026-10-22 · 念头没有家）数据层测试
 *
 * 真跑编译产物 `dist/main/services/ideas.js` + **临时数据目录**（不碰真实 ideas / todos / task-data）。
 *
 * 这条功能存在的**唯一理由**是"现有三处都放不下"，所以最硬的断言不是四态能流转，
 * 而是第 7 节那批：
 *
 *   **记一堆想法，任务卡数 / 待办数 / 在途一屏的 rows / task-data 里的文件数 一个都不许变。**
 *
 * 如果哪天有人为了省事把想法写进 task-data 或塞进 todos，那几条会当场变红。
 * 只验"功能能用"不验"没污染别人"，等于给静默错版留门。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ideas-'))
const DATA = path.join(TMP, 'data')
const USERDATA = path.join(TMP, 'userdata')
process.env.FC_TEST_USERDATA = USERDATA
for (const d of [DATA, path.join(DATA, 'task-data'), USERDATA]) fs.mkdirSync(d, { recursive: true })

// electron 桩：本进程注入（避免 spawnSync —— 本机一律 EBUSY）
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

// 注册表只留一个项目：用来验证"想法的存在不影响在途一屏"
fs.writeFileSync(path.join(DATA, 'registry.yaml'), [
  'members: []',
  'projects:',
  '  - id: has-card',
  '    name: 有卡项目',
  '    说明: 欠着：①甲项',
  'released: []',
  '',
].join('\n'), 'utf-8')

// 一张真任务卡（在途一屏的 rows 得有东西可算）
fs.writeFileSync(path.join(DATA, 'task-data', 'task-20261020-001.md'), [
  '---',
  'id: task-20261020-001',
  'title: 真任务卡',
  'project: has-card',
  'status: 待办',
  'priority: 中',
  '---',
  '',
  '## 方案',
  '夹具卡。',
  '',
].join('\n'), 'utf-8')

const data = require(path.join(DIST, 'data', 'index.js'))
data.setDataDir(DATA)
const ideas = require(path.join(DIST, 'services', 'ideas.js'))
const todosService = require(path.join(DIST, 'services', 'todos.js'))
const tripBoard = require(path.join(DIST, 'services', 'tripBoard.js'))

let PASS = 0
const FAILS = []
function check(name, cond, detail) {
  if (cond) { PASS++; console.log('PASS  ' + name) }
  else { FAILS.push(name); console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')) }
}

/** 现有口径的快照 —— 第 7 节就是靠"前后一致"来证明零污染 */
function snapshot() {
  const taskFiles = fs.readdirSync(path.join(DATA, 'task-data')).filter((f) => f.endsWith('.md'))
  let rows = -1
  try { rows = tripBoard.buildTripBoard().rows.length } catch { rows = -2 }
  return {
    todos: todosService.listTodos().length,
    tasks: data.loadAllTasksRaw('active').length,
    taskFiles: taskFiles.length,
    rows,
  }
}

;(async () => {
  console.log('---- 1. 记一条：轻，不给优先级不给期限 ----')
  const a1 = ideas.addIdea('  给方寸加个随手记念头的地方  ')
  check('记一条 → 成功，状态是「新记」', a1.ok && a1.idea.status === '新记', JSON.stringify(a1).slice(0, 90))
  check('★ 首尾空白被吃掉（念头不需要前导空格）', a1.ok && a1.idea.text === '给方寸加个随手记念头的地方', a1.ok ? a1.idea.text : '')
  check('★★ 没有 decidedAt（还没做决定，不假填一个时间）', a1.ok && a1.idea.decidedAt === '', a1.ok ? a1.idea.decidedAt : '')
  check('★★ 没有 promoted（还没立项）', a1.ok && a1.idea.promoted === null)
  check('★ 只有这些键，没有 priority / due / project（加了就又变待办了）',
    a1.ok && Object.keys(a1.idea).sort().join(',') === 'createdAt,decidedAt,id,note,promoted,status,text,updatedAt',
    a1.ok ? Object.keys(a1.idea).sort().join(',') : '')

  console.log('\n---- 2. 拒绝的几类（都不许落盘） ----')
  const cnt0 = ideas.listIdeas().length
  const empty = ideas.addIdea('   \n  ')
  check('空内容 → 显式报错', empty.ok === false && /空/i.test(empty.error), empty.error)
  const long = ideas.addIdea('啊'.repeat(4001))
  check('超长（4001 字）→ 报错并说清上限，不静默截断',
    long.ok === false && /4000/.test(long.error), long.error)
  check('★ 这两次都没落盘（条目数不变）', ideas.listIdeas().length === cnt0, String(ideas.listIdeas().length))

  console.log('\n---- 3. 手滑连点两下不会记两条 ----')
  const dup = ideas.addIdea('给方寸加个随手记念头的地方')
  check('★ 完全相同 + 仍停在「新记」→ 不落第二条', dup.ok && dup.duplicate === true, JSON.stringify(dup).slice(0, 80))
  check('  并返回已有的那条（id 一致，不是新建后丢掉）', dup.ok && dup.idea.id === a1.idea.id)
  check('  条目数仍然只有 1', ideas.listIdeas().length === 1, String(ideas.listIdeas().length))

  console.log('\n---- 4. 四态流转：搁置 / 否决 / 撤回待定 ----')
  const held = ideas.setIdeaStatus(a1.idea.id, '已搁置', '等有空再说')
  check('搁置 → 状态变 + 备注留下 + 记了 decidedAt',
    held.ok && held.idea.status === '已搁置' && held.idea.note === '等有空再说' && !!held.idea.decidedAt,
    held.ok ? JSON.stringify(held.idea).slice(0, 110) : held.error)
  check('★ 回传 before（撤销条靠它反推）', held.ok && held.before.status === '新记', held.ok ? held.before.status : '')
  const rejected = ideas.setIdeaStatus(a1.idea.id, '已否决', '不值当')
  check('否决 → 状态变 + decidedAt 不被刷新（同一个决定时点）',
    rejected.ok && rejected.idea.status === '已否决' && rejected.idea.decidedAt === held.idea.decidedAt,
    rejected.ok ? `${rejected.idea.decidedAt} vs ${held.idea.decidedAt}` : '')
  const back = ideas.setIdeaStatus(a1.idea.id, '新记')
  check('★★ 撤回成「新记」→ decidedAt 清空（退回去就是真的退回去，不留半截决定时间）',
    back.ok && back.idea.status === '新记' && back.idea.decidedAt === '', back.ok ? back.idea.decidedAt : '')
  const bogus = ideas.setIdeaStatus(a1.idea.id, '随便写着玩')
  check('不存在的状态 → 显式报错', bogus.ok === false && /没有/.test(bogus.error), bogus.error)

  console.log('\n---- 5. 「已立项」不许从状态路走进来（假账防线） ----')
  const fake = ideas.setIdeaStatus(a1.idea.id, '已立项')
  check('★★ 直接改状态成「已立项」→ 拒绝', fake.ok === false, fake.ok ? '居然通过了' : '')
  check('  并且说清为什么（要走「做」那个动作，它才真建待办）',
    /待办|假账/.test(fake.error || ''), fake.error)
  check('  状态没被改（还是新记）', ideas.listIdeas()[0].status === '新记', ideas.listIdeas()[0].status)

  console.log('\n---- 6. 立项：真在待办里生出一条 + 双向留痕 ----')
  const todosBefore = todosService.listTodos().length
  const pro = ideas.promoteIdea(a1.idea.id)
  check('立项成功，状态转「已立项」', pro.ok && pro.idea.status === '已立项', pro.ok ? '' : pro.error)
  check('★★ 待办里**真的多了一条**（不是只改状态）',
    todosService.listTodos().length === todosBefore + 1,
    `${todosBefore} → ${todosService.listTodos().length}`)
  const theTodo = todosService.listTodos().find((t) => t.id === pro.todoId)
  check('★★ 那条待办的 id 就是想法里记的 promoted.id（能回查）',
    !!theTodo && pro.ok && pro.idea.promoted && pro.idea.promoted.id === theTodo.id,
    pro.ok ? JSON.stringify(pro.idea.promoted) : '')
  check('★ 待办标题取念头第一行（待办列表是一行一条，多行塞进去会撑歪）',
    !!theTodo && theTodo.title === '给方寸加个随手记念头的地方', theTodo && theTodo.title)
  check('★ 待办带上了 decidedAt（立项也是一个决定时点）', pro.ok && !!pro.idea.decidedAt)
  const again = ideas.promoteIdea(a1.idea.id)
  check('★★ 重复立项 → 拒绝（否则一点两下待办里出两条）', again.ok === false, again.ok ? '居然通过' : '')
  check('  待办数没涨', todosService.listTodos().length === todosBefore + 1)

  console.log('\n---- 7. ★★ 灵魂断言：想法不进任何现有口径 ----')
  // 先清干净，再记一批纯想法（不立项），逐项比快照
  ideas.deleteIdea(a1.idea.id)
  const snap0 = snapshot()
  for (let i = 0; i < 8; i++) ideas.addIdea('纯念头 ' + i + '：这个可能会做也可能不做')
  const snap1 = snapshot()
  check('★★ 8 条想法进来，待办数一个没变',
    snap1.todos === snap0.todos, `${snap0.todos} → ${snap1.todos}`)
  check('★★ 任务卡数一个没变（loadAllTasksRaw 看不见想法）',
    snap1.tasks === snap0.tasks, `${snap0.tasks} → ${snap1.tasks}`)
  check('★★ task-data 目录里的 .md 文件数一个没变（没往任务目录塞东西）',
    snap1.taskFiles === snap0.taskFiles, `${snap0.taskFiles} → ${snap1.taskFiles}`)
  check('★★ 在途一屏的 rows 一个没变（想法不会被算成"在途项目"）',
    snap1.rows === snap0.rows, `${snap0.rows} → ${snap1.rows}`)
  check('★ 想法自己落在 ideas/index.json（不在 task-data、不在 todos）',
    fs.existsSync(path.join(DATA, 'ideas', 'index.json'))
    && !fs.existsSync(path.join(DATA, 'task-data', 'ideas.md')),
    ideas.ideasHealth().path)
  check('★ 这 8 条一条都没进待办的标题里',
    !todosService.listTodos().some((t) => String(t.title || '').indexOf('纯念头') >= 0),
    JSON.stringify(todosService.listTodos().map((t) => t.title)))

  console.log('\n---- 8. 撤销立项 / 已完成的不许撤 ----')
  const one = ideas.addIdea('这条要立项再撤回')
  const p2 = ideas.promoteIdea(one.idea.id)
  const n0 = todosService.listTodos().length
  const un = ideas.unpromoteIdea(one.idea.id)
  check('撤销立项 → 想法回「新记」', un.ok && un.idea.status === '新记', un.ok ? '' : un.error)
  check('★ promoted 清空、decidedAt 清空（真的退回原状）',
    un.ok && un.idea.promoted === null && un.idea.decidedAt === '',
    un.ok ? JSON.stringify({ p: un.idea.promoted, d: un.idea.decidedAt }) : '')
  check('★★ 待办里那条被删掉了（不留孤儿）',
    todosService.listTodos().length === n0 - 1, `${n0} → ${todosService.listTodos().length}`)
  check('  孤儿 id 确实不在待办里了',
    !todosService.listTodos().some((t) => t.id === p2.todoId))

  const p3 = ideas.promoteIdea(one.idea.id)
  todosService.toggleTodo(p3.todoId) // 用户真把那条待办做完了
  const un2 = ideas.unpromoteIdea(one.idea.id)
  check('★★ 待办已被做完 → 不许撤销立项（那是用户的东西了，删了等于删他的成果）',
    un2.ok === false && /做完/.test(un2.error), un2.ok ? '居然撤了' : un2.error)
  check('  那条待办还在（没被偷偷删掉）',
    todosService.listTodos().some((t) => t.id === p3.todoId))
  const notPromoted = ideas.unpromoteIdea(ideas.addIdea('没立项的').idea.id)
  check('没立项的去撤销 → 显式报错（不许静默成功）', notPromoted.ok === false)

  console.log('\n---- 9. 删 + 撤销删除（当没删过） ----')
  const del1 = ideas.addIdea('记错了的一条')
  const rm = ideas.deleteIdea(del1.idea.id)
  check('删除 → 返回被删的那条（界面挂撤销要用）', rm.ok && rm.removed.id === del1.idea.id)
  check('  列表里没有了', !ideas.listIdeas().some((i) => i.id === del1.idea.id))
  const res = ideas.restoreIdea(rm.removed)
  check('★★ 撤销删除 → 原 id 原 createdAt 都回来了（撤销 = 当没删过，不是重新记一条）',
    res.ok && res.idea.id === del1.idea.id && res.idea.createdAt === del1.idea.createdAt,
    res.ok ? `${res.idea.id} / ${res.idea.createdAt}` : '')
  check('重复恢复 → 拒绝（不许同一 id 存两条）', ideas.restoreIdea(rm.removed).ok === false)
  check('  列表里还是只有一条', ideas.listIdeas().filter((i) => i.id === del1.idea.id).length === 1)

  console.log('\n---- 10. 脏数据与坏文件 ----')
  // 手工写一份带脏状态的库，看归一行为
  const p = path.join(DATA, 'ideas', 'index.json')
  const good = JSON.parse(fs.readFileSync(p, 'utf-8'))
  fs.writeFileSync(p, JSON.stringify([
    { id: 'i-dirty', text: '状态写错的一条', status: '进行中', createdAt: '2026-10-20T00:00:00.000Z' },
    { id: 'i-ok', text: '正常的一条', status: '已搁置', note: '', createdAt: '2026-10-19T00:00:00.000Z', decidedAt: '2026-10-19T01:00:00.000Z' },
    { id: 'i-nodec', text: '新记却带着决定时间', status: '新记', decidedAt: '2026-10-18T00:00:00.000Z', createdAt: '2026-10-18T00:00:00.000Z' },
    { id: '', text: '没 id 的脏记录', createdAt: '2026-10-17T00:00:00.000Z' },
  ], null, 2), 'utf-8')
  const dirty = ideas.listIdeas()
  const d1 = dirty.find((i) => i.id === 'i-dirty')
  check('★★ 非法状态（写成「进行中」）→ 归「新记」而不是丢掉这条（正文比状态重要）',
    !!d1 && d1.status === '新记' && d1.text === '状态写错的一条', d1 ? d1.status : '整条没了')
  check('★ 新记却带着 decidedAt → 不认那个时间（不给假时间）',
    dirty.find((i) => i.id === 'i-nodec').decidedAt === '')
  check('★ 没 id 的脏记录不进列表（没法定位，留着只会让删/改全部失效）',
    !dirty.some((i) => i.text === '没 id 的脏记录'))

  fs.writeFileSync(p, '{ 这不是 JSON', 'utf-8')
  const h = ideas.ideasHealth()
  check('★★ 坏文件 → 隔离改名（不静默返回空让下次写入把它覆盖掉）',
    h.ok === false && fs.existsSync(p) === false
    && fs.readdirSync(path.join(DATA, 'ideas')).some((f) => f.indexOf('.corrupt-') >= 0),
    JSON.stringify(h.lastError))
  check('  隔离后还能正常记新的（不是崩了）', ideas.addIdea('坏文件之后记的').ok === true)

  // 收尾：还原成干净数据（后面的断言不依赖上面的脏数据）
  ideas.deleteIdea(ideas.listIdeas().find((i) => i.text === '坏文件之后记的').id)

  console.log('\n---- 11. 排序与统计 ----')
  // 上一节把库写坏又被隔离了，这里铺一份干净的（刻意乱序写入，看读出来会不会自己排好）
  fs.writeFileSync(path.join(DATA, 'ideas', 'index.json'), JSON.stringify([
    { id: 'i-old', text: '早记的', status: '已搁置', note: '', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', decidedAt: '2026-10-02T00:00:00.000Z', promoted: null },
    { id: 'i-new', text: '晚记的', status: '新记', note: '', createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', decidedAt: '', promoted: null },
    { id: 'i-mid', text: '中间记的', status: '已否决', note: '不值当', createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', decidedAt: '2026-10-11T00:00:00.000Z', promoted: null },
  ], null, 2), 'utf-8')
  const list = ideas.listIdeas()
  check('★★ 最新记的排最前（想法没有优先级也没有先后，只有时间）',
    list.length === 3 && list.map((i) => i.id).join(',') === 'i-new,i-mid,i-old',
    JSON.stringify(list.map((i) => i.id)))
  const sum = ideas.ideasSummary()
  const total = sum['新记'] + sum['已立项'] + sum['已搁置'] + sum['已否决']
  check('★ 统计四态之和 = 列表条数（分区标题上的数字与实际一致）',
    total === ideas.listIdeas().length, `${total} vs ${ideas.listIdeas().length}`)
  check('  四态键齐全（界面按固定四态渲染，缺键会显示 undefined）',
    ['新记', '已立项', '已搁置', '已否决'].every((k) => typeof sum[k] === 'number'),
    JSON.stringify(sum))
  check('  状态筛选生效',
    ideas.listIdeas({ status: '已搁置' }).every((i) => i.status === '已搁置'))

  console.log(`\n==== ${PASS} 通过 / ${FAILS.length} 失败 ====`)
  if (FAILS.length) { FAILS.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1) }
})().catch((e) => {
  console.log('FAIL  测试本身抛异常：' + (e && e.stack || e))
  process.exit(1)
})
