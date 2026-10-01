#!/usr/bin/env node
/**
 * MCP 读路径契约测试（2026-10-01 · 平行实现审计后的 P0-3）
 *
 * 背景：MCP（命名管道，供 Hermes/Claude 等外部 agent）与桌面 IPC 是**两个对外读口**，
 * 共享同一批 task-data。审计发现两处对外契约偏差：
 *   ① mcp/tools.ts 曾有**私有 loadAllTasks 扫描**，自己 walk 并跳过 archive/.trash
 *      → `search_tasks` 永远搜不到归档任务，而 UI 的「全部」含归档 —— 问 MCP 和问 UI 会得到
 *      不同答案；
 *   ② `list_tasks view=trash` 落进 data.loadTasks 的 else 分支 → 返回**活跃+归档**，
 *      根本不是回收站（schema 与返回内容不符）。
 * 修法 = 删掉私有扫描，全部改走 data.loadTasks / tasks.listTrash，让两个读口一个口径。
 *
 * 这个套件**真跑编译产物**（dist/main），不是源码字符串比对：建一个临时数据目录
 * （活跃 + 归档 + 回收站各一条夹具），逐条断言 view 语义与全文搜索的覆盖面。
 * ⚠ setDataDir 里的「持久化用户选择」依赖 electron 的 app.getPath，纯 Node 下会抛
 *   并被它的 try/catch 吞掉 —— 所以本测试**不会**改掉真实 app 的数据目录配置。
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')

// 夹具文件先落盘，再交给子进程跑（子进程 require 编译产物，避免污染本进程模块缓存）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-views-'))
const DATA = path.join(TMP, 'data')
fs.mkdirSync(path.join(DATA, 'task-data', 'archive'), { recursive: true })
fs.mkdirSync(path.join(DATA, 'task-data', '.trash'), { recursive: true })
fs.writeFileSync(path.join(DATA, 'registry.yaml'),
  'members: []\nprojects:\n  - id: fm-demo\n    name: 契约演示\nreleased: []\n', 'utf-8')

const mkTask = (id, title, extra) => [
  '---',
  `id: ${id}`,
  `标题: ${title}`,
  '项目: [fm-demo]',
  `状态: ${extra.status}`,
  '更新: 2026-10-01T09:00:00+08:00',
  '---',
  `正文：${title}（${extra.where}）`,
  '',
].join('\n')

fs.writeFileSync(path.join(DATA, 'task-data', 'task-live.md'),
  mkTask('task-live', '契约夹具活跃任务', { status: '待办', where: 'active' }), 'utf-8')
fs.writeFileSync(path.join(DATA, 'task-data', 'archive', 'task-arch.md'),
  mkTask('task-arch', '契约夹具归档任务', { status: '完成', where: 'archive' }), 'utf-8')
fs.writeFileSync(path.join(DATA, 'task-data', '.trash', 'task-gone.md'),
  mkTask('task-gone', '契约夹具回收站任务', { status: '待办', where: 'trash' }), 'utf-8')

const DRIVER = `
const D = ${JSON.stringify(path.join(REPO, 'desktop'))}
const out = []
const check = (name, cond, detail) => out.push({ name, pass: !!cond, detail: String(detail || '').slice(0, 220) })

const tools = require(D + '/dist/main/mcp/tools.js')
const data = require(D + '/dist/main/data/index.js')

check('MCP 模块可加载，20 个工具（名字是 fangcun-hermes-bridge 的对外契约）',
  Array.isArray(tools.MCP_TOOLS) && tools.MCP_TOOLS.length === 20,
  Array.isArray(tools.MCP_TOOLS) ? tools.MCP_TOOLS.length : typeof tools.MCP_TOOLS)

const DATA_DIR = ${JSON.stringify(DATA)}
data.setDataDir(DATA_DIR)
check('setDataDir 指到临时数据目录', data.getDataDir() === DATA_DIR, data.getDataDir())

const call = (name, args) => {
  const r = tools.handleMCPToolCall(name, args || {})
  const txt = r && r.content && r.content[0] && r.content[0].text
  try { return JSON.parse(txt) } catch (e) { return { __raw: txt, __err: String(e).slice(0, 160) } }
}
const ids = (r) => (Array.isArray(r) ? r.map(x => x.id || x.title) : r)
const has = (r, s) => Array.isArray(r) && r.some(x => String(x.id || '').indexOf(s) >= 0 || String(x.title || '').indexOf(s) >= 0)

const active = call('list_tasks', { view: 'active' })
const all = call('list_tasks', { view: 'all' })
const arch = call('list_tasks', { view: 'archive' })
const trash = call('list_tasks', { view: 'trash' })

check('view=active 只有活跃（不含归档、不含回收站）',
  Array.isArray(active) && has(active, 'task-live') && !has(active, 'task-arch') && !has(active, 'task-gone'),
  ids(active))
check('view=all 含活跃 + 归档（回收站不算在内）',
  Array.isArray(all) && has(all, 'task-live') && has(all, 'task-arch') && !has(all, 'task-gone'),
  ids(all))
check('view=archive 只有归档',
  Array.isArray(arch) && has(arch, 'task-arch') && !has(arch, 'task-live'), ids(arch))
check('★★ view=trash 返回的就是回收站（修复前：落 else 分支返回活跃+归档，schema 名不副实）',
  Array.isArray(trash) && has(trash, 'task-gone') && !has(trash, 'task-live'),
  JSON.stringify(trash).slice(0, 200))

const s1 = call('search_tasks', { query: '契约夹具归档任务' })
check('★★ search_tasks 能搜到**归档**任务（修复前：私有扫描跳过 archive → 永远搜不到）',
  Array.isArray(s1) && s1.length >= 1, ids(s1))
const s2 = call('search_tasks', { query: '契约夹具活跃任务' })
check('search_tasks 能搜到活跃任务', Array.isArray(s2) && s2.length >= 1, ids(s2))
const s3 = call('search_tasks', { query: '契约夹具回收站任务' })
check('search_tasks 不把回收站里的东西搜出来（回收站不参与全文搜索）',
  Array.isArray(s3) && s3.length === 0, ids(s3))

const pf = call('list_tasks', { view: 'active', project: 'fm-demo' })
check('★ list_tasks 按项目过滤真的生效（fm.project 是数组，旧写法 === 永不匹配）',
  Array.isArray(pf) && pf.length === 1, JSON.stringify(pf).slice(0, 160))
const st = call('list_tasks', { view: 'active', status: '待办' })
check('list_tasks 按状态过滤生效', Array.isArray(st) && st.length === 1, JSON.stringify(st).slice(0, 160))

// 源码守卫：私有扫描不许回来
const src = require('fs').readFileSync(D + '/src/main/mcp/tools.ts', 'utf-8')
check('源码守卫：MCP 不再自带私有全量扫描（loadAllTasks 应消失）',
  !/function\\s+loadAllTasks\\s*\\(/.test(src))
check('源码守卫：search_tasks 走 data.loadTasks（与 UI 同一口径）',
  /case\\s+'search_tasks'[\\s\\S]{0,200}?loadTasks\\(/.test(src))

console.log(JSON.stringify(out))
`

const driverPath = path.join(TMP, 'driver.js')
fs.writeFileSync(driverPath, DRIVER, 'utf-8')

const r = spawnSync('node', [driverPath], { encoding: 'utf-8', timeout: 120000 })

let pass = 0
let fail = 0
const lines = []
const check = (name, cond, detail) => {
  if (cond) { pass++; lines.push('PASS  ' + name) }
  else { fail++; lines.push('FAIL  ' + name + (detail ? '  → ' + detail : '')) }
}

if (r.status !== 0) {
  check('MCP 契约驱动能跑通', false, `exit=${r.status} ${String(r.stderr || '').slice(-400)}`)
} else {
  let res
  try {
    res = JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop())
    check('MCP 契约驱动能跑通', true)
  } catch (e) {
    res = null
    check('MCP 契约驱动能跑通', false, String(r.stdout).slice(-300))
  }
  if (res) for (const c of res) check(c.name, c.pass, c.detail)
}

console.log(lines.join('\n'))
console.log(`通过 ${pass} / 失败 ${fail}`)
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail > 0 ? 1 : 0)
