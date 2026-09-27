/**
 * 待办服务 —— 数据安全 + 排序（2026-09-26 卡 033「待办几乎各种问题都没修」专项整修）
 *
 * 专项整修先盘了问题清单，本测试钉住其中**数据层**那三条（最要命的）：
 *   ① 写入必须是原子的：不再 writeFileSync 直接覆盖（写一半崩 = 整个 index.json 损坏）；
 *   ② 坏文件必须**隔离保留**，不能被下一次写入静默覆盖 ——
 *      旧实现解析失败静默 `return []`，用户下一按"添加"就把历史待办清零，
 *      而界面上只表现为"待办突然空了"。用户对数据丢失极敏感，这是本模块最严重的问题；
 *   ③ 排序规则固定可断言：未完成在前 → 优先级（高/中/低）→ 新建在前。
 *
 * 运行：node scripts/test/e2e-todos.cjs
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

const TEST_ROOT = path.join(os.tmpdir(), 'fc-todos-' + Date.now())
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

function main() {
  console.log('== 待办服务：数据安全 + 排序 ==')
  console.log('root:', TEST_ROOT)

  fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
  const data = require(path.join(DIST, 'data', 'index.js'))
  const todos = require(path.join(DIST, 'services', 'todos.js'))
  data.setDataDir(TEST_ROOT)

  const todosFile = path.join(TEST_ROOT, 'todos', 'index.json')

  // ── 1. 基础 CRUD ─────────────────────────────────────────────────
  const a = todos.createTodo('低优先的老任务', '低', undefined, 'demo')
  const b = todos.createTodo('高优先的新任务', '高')
  const c = todos.createTodo('中优先的任务', '中')
  check('创建后文件落在 <数据根>/todos/index.json', fs.existsSync(todosFile), todosFile)
  check('列表能取回三条', todos.listTodos().length === 3, String(todos.listTodos().length))
  check('新建默认 done=false', todos.listTodos().every(t => t.done === false))

  // ── 2. 排序：未完成 → 优先级 → 新建在前 ───────────────────────────
  let order = todos.listTodos().map(t => t.title)
  check('★ 排序：高优先排在最前', order[0] === '高优先的新任务', JSON.stringify(order))
  check('★ 排序：低优先排在最后', order[order.length - 1] === '低优先的老任务', JSON.stringify(order))

  todos.toggleTodo(a.id)
  order = todos.listTodos().map(t => t.title)
  check('★ 已完成沉到末尾（哪怕优先级低）', order[order.length - 1] === '低优先的老任务', JSON.stringify(order))

  todos.toggleTodo(a.id)
  const toggled = todos.listTodos().find(t => t.id === a.id)
  check('再勾一次能取消完成', toggled && toggled.done === false)

  const upd = todos.updateTodo(b.id, { title: '改过的标题', due: '2026-10-01', project: 'demo2' })
  check('更新返回新记录', !!upd && upd.title === '改过的标题' && upd.due === '2026-10-01' && upd.project === 'demo2',
    JSON.stringify(upd))
  check('更新也落盘了', todos.listTodos().find(t => t.id === b.id).title === '改过的标题')

  // ── 3. 原子写：不留 .tmp 残渣、内容可读 ──────────────────────────
  check('★ 写完不留 .tmp 残渣（原子写会清掉）', !fs.existsSync(todosFile + '.tmp'))
  check('写完文件是合法 JSON 数组', (() => {
    try { return Array.isArray(JSON.parse(fs.readFileSync(todosFile, 'utf-8'))) } catch { return false }
  })())

  // ── 4. 坏文件：必须隔离保留，不能被静默清零 ★★ 本轮核心 ──────────
  const beforeBadCount = todos.listTodos().length
  const garbage = '{ 这不是合法 JSON ]['
  fs.writeFileSync(todosFile, garbage, 'utf-8')

  const afterBad = todos.listTodos()
  check('★ 坏文件时列表返回空（不抛异常）', Array.isArray(afterBad) && afterBad.length === 0, JSON.stringify(afterBad))

  const dirFiles = fs.readdirSync(path.join(TEST_ROOT, 'todos'))
  const corrupt = dirFiles.filter(n => n.startsWith('index.json.corrupt-'))
  check('★ 坏文件被改名隔离（index.json.corrupt-*）', corrupt.length === 1, JSON.stringify(dirFiles))
  check('★ 隔离出来的那份**内容原样保留**（能被人工救回）',
    corrupt.length === 1 && fs.readFileSync(path.join(TEST_ROOT, 'todos', corrupt[0]), 'utf-8') === garbage)

  const health = todos.todosHealth()
  check('★ todosHealth 报出这次事故（界面才有东西可显示）', health.ok === false && !!health.lastError, JSON.stringify(health))
  check('事故记录里有坏文件路径与原因',
    !!health.lastError && String(health.lastError.file).endsWith('index.json') && !!health.lastError.error,
    JSON.stringify(health.lastError))

  // 隔离之后再写：新数据能正常落盘，且**没有覆盖**那份坏文件
  const fresh = todos.createTodo('坏文件之后新建的', '中')
  check('坏文件之后仍能新建（自愈）', todos.listTodos().length === 1 && todos.listTodos()[0].id === fresh.id)
  check('★★ 隔离出来的坏文件仍在磁盘上（历史没被销毁）',
    fs.existsSync(path.join(TEST_ROOT, 'todos', corrupt[0])),
    JSON.stringify(fs.readdirSync(path.join(TEST_ROOT, 'todos'))))
  check('坏文件内容仍是原样（没被新数据覆盖）',
    fs.readFileSync(path.join(TEST_ROOT, 'todos', corrupt[0]), 'utf-8') === garbage)

  // ── 5. 顶层不是数组：同样按坏文件处理（不能当空列表糊过去）──────────
  fs.writeFileSync(todosFile, '{"oops": "不是数组"}', 'utf-8')
  const afterObj = todos.listTodos()
  const dirFiles2 = fs.readdirSync(path.join(TEST_ROOT, 'todos'))
  check('★ 顶层不是数组也按坏文件隔离', afterObj.length === 0 &&
    dirFiles2.filter(n => n.startsWith('index.json.corrupt-')).length === 2, JSON.stringify(dirFiles2))

  // ── 6. 历史优先级写法（high/normal/low）读取时归一 ────────────────
  fs.writeFileSync(todosFile, JSON.stringify([
    { id: 'x1', title: '英文优先级', done: false, priority: 'high', createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z' },
    { id: 'x2', title: '没写优先级', done: false, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' },
  ]), 'utf-8')
  const norm = todos.listTodos()
  check('存量 high → 高', norm.find(t => t.id === 'x1').priority === '高', JSON.stringify(norm.map(t => [t.id, t.priority])))
  check('缺省优先级 → 中（不出现 undefined）', norm.find(t => t.id === 'x2').priority === '中')

  // ── 7. 删除 ──────────────────────────────────────────────────────
  check('删除存在的返回 true', todos.deleteTodo('x1') === true)
  check('删除不存在的返回 false（不抛）', todos.deleteTodo('不存在') === false)
  check('删除后只剩一条', todos.listTodos().length === 1, String(todos.listTodos().length))

  // ── 8. 置顶（2026-09-26 卡 037 第二批）─────────────────────────────────
  {
    const lowPin = todos.createTodo('钉住的低优先级', '低')
    todos.createTodo('没钉住的高优先级', '高')
    todos.setTodoPinned(lowPin.id, true)
    const list = todos.listTodos()
    check('★ 待办置顶写回（pinned: true）',
      !!list.find(t => t.id === lowPin.id && t.pinned === true),
      JSON.stringify(list.map(t => [t.title, t.pinned])))
    check('★ 置顶排最前（连"高优先级"也压不过它）',
      list[0].id === lowPin.id, list.map(t => t.title).join(' | '))
    todos.setTodoPinned(lowPin.id, false)
    const list2 = todos.listTodos()
    check('★ 取消置顶后不再是第一（高优先级回到最前）',
      list2[0].title === '没钉住的高优先级', list2.map(t => t.title).join(' | '))
    check('  置顶不存在的 id 返回 null（不抛）', todos.setTodoPinned('nope', true) === null)
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
