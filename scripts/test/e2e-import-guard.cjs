#!/usr/bin/env node
/**
 * 导入防呆端到端测试（开发清单第 6 条，2026-10-14）
 *
 * 起因（用户原话）：「自己手搓导入文件用错字段名时，现在会静默落一个空壳还报"成功"」——
 * 老实现只认英文键（`title`），手搓的人写中文（`标题`，因为任务卡 frontmatter 就是中文键），
 * 结果字段全被丢掉、落一张 `(无标题)` 的空卡，还回 `{ok: true, imported: 1}`。
 *
 * 本测试真跑**主进程编译产物** `dist/main/data/tasks.js`（electron 桩 + 临时数据目录），
 * 因此同时也盖住了「界面背后跟主程序通信那层」的批量导入接口 —— 开发清单第 7 条指出
 * 三次"测试全绿、真机就炸"都炸在这一层。判据：**报错要指明错哪，且一个文件都不许写。**
 *
 * 运行：node scripts/test/e2e-import-guard.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

// ── 1. electron 桩注入（必须在业务模块之前）────────────────────────────
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-import-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT

const DIST = path.resolve(__dirname, '../../desktop/dist/main')
const TASK_DIR = path.join(TEST_ROOT, 'task-data')

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
  return !!cond
}
/** 盘上现有几个任务 md（用来证"一个文件都没写"） */
const files = () => (fs.existsSync(TASK_DIR) ? fs.readdirSync(TASK_DIR).filter((f) => f.endsWith('.md')) : [])
const texts = () => files().map((f) => fs.readFileSync(path.join(TASK_DIR, f), 'utf-8')).join('\n---\n')

if (!fs.existsSync(path.join(DIST, 'data', 'tasks.js'))) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）')
  console.log('RESULT 0 / 1')
  process.exit(1)
}

fs.mkdirSync(TASK_DIR, { recursive: true })
const data = require(path.join(DIST, 'data', 'index.js'))
const tasks = require(path.join(DIST, 'data', 'tasks.js'))
data.setDataDir(TEST_ROOT)

console.log('== 导入防呆（主进程 data/tasks.js）==')
console.log('数据目录：' + TASK_DIR)

// ── ① 自己的导出格式（英文键）必须能读回去 ──────────────────────────────
{
  const before = files().length
  const r = tasks.importTasks([
    { title: '英文键：导出格式 round-trip', project: 'f', status: '待办', priority: '高', tags: ['x'], body: '正文甲' },
  ])
  check('① 英文键（自己 exportTasks 的格式）导入成功', r.ok === true && r.imported === 1, JSON.stringify(r))
  check('① 真落了一个文件', files().length === before + 1, `${before} → ${files().length}`)
  check('① 内容没丢（标题 / 正文 / 标签都在盘上）',
    texts().includes('英文键：导出格式 round-trip') && texts().includes('正文甲'), '')
}

// ── ② 中文键（手搓文件最自然的写法）也要认 ──────────────────────────────
{
  const before = files().length
  const r = tasks.importTasks([
    { 标题: '中文键：手搓导入', 项目: '方寸', 状态: '待办', 标签: ['a', 'b'], 正文: '正文乙' },
  ])
  check('★ ② 中文键（标题/项目/状态/标签/正文）导入成功', r.ok === true && r.imported === 1, JSON.stringify(r))
  check('② 真落了一个文件', files().length === before + 1, `${before} → ${files().length}`)
  check('★ ② 中文键的内容没被丢（这正是老实现"静默落空壳"的地方）',
    texts().includes('中文键：手搓导入'), '')
}

// ── ③ 字段名写错 → 当场报错、指明错哪、一个文件都不写 ───────────────────
{
  const before = files().length
  const r = tasks.importTasks([{ 题目: '字段名写错了', 项目: '方寸' }])
  check('★★ ③ 不认识的字段名被拦下（老实现会静默丢掉它并报成功）', r.ok === false, JSON.stringify(r))
  check('★★ ③ 报错里**点名**是哪个字段（要能照着改）',
    String(r.error || '').includes('题目') && String(r.error || '').includes('第 1 条'),
    String(r.error))
  check('★★ ③ 报错里给出可用字段名', String(r.error || '').includes('title') && String(r.error || '').includes('标题'), String(r.error))
  check('★★ ③ 一个文件都没写（先体检、后落盘）', files().length === before, `${before} → ${files().length}`)
  check('③ problems 数组带明细（界面可以逐条展示）', Array.isArray(r.problems) && r.problems.length >= 1, JSON.stringify(r.problems))
}

// ── ④ 没有标题 → 拒绝（不许落 (无标题) 空壳）───────────────────────────
{
  const before = files().length
  const r = tasks.importTasks([{ 项目: '方寸' }])
  check('★ ④ 没有「标题」被拦下（不再落 (无标题) 空壳）',
    r.ok === false && String(r.error || '').includes('标题'), JSON.stringify(r))
  check('★ ④ 同样一个文件都没写', files().length === before, `${before} → ${files().length}`)
}

// ── ⑤ 批里只要有一条不合格 → 整批拒绝（不留半截结果）──────────────────
{
  const before = files().length
  const r = tasks.importTasks([
    { 标题: '这条是好的' },
    { 题目: '这条字段名错了' },
  ])
  check('★★ ⑤ 半合法批次整体拒绝（第 1 条也不许落盘 —— 否则用户拿到半截数据还以为是全的）',
    r.ok === false && files().length === before, `ok=${r.ok} ${before} → ${files().length}`)
  check('⑤ 报错指到第 2 条', String(r.error || '').includes('第 2 条'), String(r.error))
}

// ── ⑥ 中英别名同时写 → 提醒（潜在的下笔错误，不能静默其中一个赢）───────
{
  const before = files().length
  const r = tasks.importTasks([{ 标题: 'A', title: 'B' }])
  check('★ ⑥ 同一字段中英别名都写 → 报"写了两次"', r.ok === false && String(r.error || '').includes('两次'), JSON.stringify(r))
  check('⑥ 也没落盘', files().length === before, `${before} → ${files().length}`)
}

// ── ⑦ 边界：非数组 / 空数组 / 非对象条目 ────────────────────────────────
{
  check('⑦ 非数组 → ok:false', tasks.importTasks('不是数组').ok === false)
  const r = tasks.importTasks([])
  check('⑦ 空数组 → ok:true 且 imported=0（空文件不算错）', r.ok === true && r.imported === 0, JSON.stringify(r))
  const before = files().length
  const r2 = tasks.importTasks(['字符串条目'])
  check('★ ⑦ 条目不是对象 → 拦下且说清 (此前 `continue` 静默跳过)',
    r2.ok === false && String(r2.error || '').includes('第 1 条'), JSON.stringify(r2))
  check('⑦ 没落盘', files().length === before, `${before} → ${files().length}`)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
