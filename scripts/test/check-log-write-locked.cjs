#!/usr/bin/env node
/**
 * 日志写口对 agent 关闭 · 守卫（2026-11-19）。
 *
 * 用户原话：「AI 自动写日志我记得已经禁了（因为很乱，日志本来就是用户自己存上下文的地方，
 *            AI 自己写让人搞不懂哪些没做）」。
 * 查实这口子有三个面：
 *   ① 方寸 MCP：create_log / update_log / set_log_status / attach_log_files；
 *   ② DSH 插件：fangcun_log_write；
 *   ③ Python CLI：`tegula log create/edit/complete/archive/destroy/link/unlink`（审计都看不到）。
 *
 * 本守卫钉住的是**"口子真的关了"**，不是"文档里写了"：
 *   A. 源码 + **编译产物**（dist/main/mcp/tools.js）的工具面里，四个写工具都不存在；
 *   B. 插件仓库（同机默认 ../dsh-fangcun）里没有 fangcun_log_write 定义与路由；
 *   C. 真跑 CLI：`tegula log create` 非零退出 + 明确说"拒绝" + **临时目录里没多出任何日志文件**；
 *      读口 `log list` 仍退出 0（别把读也一起关死）；
 *   D. 桌面界面 IPC 的五个写口还在（写入只允许人做 —— UI 不能被误伤）；
 *   E. Python HTTP（web.py）没有日志写 API。
 *
 * ⚠ 全绿才算关好。任何一条红都意味着"AI 还能写日志"。
 * ⚠ CLI 反例跑在**临时复制的便携目录**里，绝不碰真实 docs/执行日志。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const PY = process.platform === 'win32' ? 'python' : 'python3'

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

const WRITE_TOOLS = ['create_log', 'update_log', 'set_log_status', 'attach_log_files']
const READ_TOOLS = ['list_logs', 'search_logs', 'get_log', 'inject_logs']
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ── A. MCP 工具面：源码 + 编译产物 ──────────────────────────────────────
const toolsSrcPath = path.join(ROOT, 'desktop', 'src', 'main', 'mcp', 'tools.ts')
const toolsSrc = fs.readFileSync(toolsSrcPath, 'utf8')
for (const n of WRITE_TOOLS) {
  check(`MCP 源码里没有工具定义 ${n}`, !new RegExp(`name:\\s*['"]${escapeRe(n)}['"]`).test(toolsSrc))
}

const toolsDist = path.join(ROOT, 'desktop', 'dist', 'main', 'mcp', 'tools.js')
if (!fs.existsSync(toolsDist)) {
  check('MCP 编译产物存在（先 cd desktop && npm run build）', false, toolsDist)
} else {
  let names = []
  try {
    const mod = require(toolsDist)
    names = (mod.MCP_TOOLS || []).map((t) => String(t && t.name || ''))
  } catch (e) {
    check('MCP 编译产物可加载', false, String(e && e.message || e))
  }
  if (names.length) {
    for (const n of WRITE_TOOLS) check(`MCP 编译产物工具面里没有 ${n}`, names.indexOf(n) < 0)
    for (const n of READ_TOOLS) check(`MCP 读口仍在：${n}`, names.indexOf(n) >= 0)
  }
}

// ── B. 插件仓库：fangcun_log_write 不许回来 ───────────────────────────
const PLUGIN = process.env.DSH_FANGCUN_REPO || path.join(ROOT, '..', 'dsh-fangcun')
const pluginTool = path.join(PLUGIN, 'lib', 'tool.js')
if (!fs.existsSync(pluginTool)) {
  console.log(`SKIP  插件仓库不在 ${PLUGIN}（可用 DSH_FANGCUN_REPO 指定）—— 插件侧另有 npm test 钉着`)
} else {
  const p = fs.readFileSync(pluginTool, 'utf8')
  check('插件里没有工具定义 fangcun_log_write', !/name:\s*['"]fangcun_log_write['"]/.test(p))
  check('插件路由表里没有 fangcun_log_write', !/fangcun_log_write\s*:/.test(p))
  check('插件仍保留读口 fangcun_logs / fangcun_log',
    /name:\s*['"]fangcun_logs['"]/.test(p) && /name:\s*['"]fangcun_log['"]/.test(p))
}

// ── C. CLI：写动作拒绝、读动作仍可用（临时便携目录，不碰真实数据）──────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-loglock-'))
try {
  fs.cpSync(path.join(ROOT, 'tegula'), path.join(TMP, 'tegula'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'tegula.py'), path.join(TMP, 'tegula.py'))
  fs.writeFileSync(path.join(TMP, 'registry.yaml'), 'members: []\nprojects: []\nreleased: []\n', 'utf8')
  fs.mkdirSync(path.join(TMP, 'task-data'), { recursive: true })

  // ⚠ 必须给 PYTHONIOENCODING=utf-8：Windows 控制台默认 GBK，跑出来的中文
  //    在 Node 里按 UTF-8 解就是乱码，正则永远匹配不上（首跑实测）。
  const run = (args) => spawnSync(PY, ['tegula.py', ...args], {
    cwd: TMP,
    encoding: 'utf8',
    timeout: 90000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })

  const w = run(['log', 'create', '--project', 'demo', '--title', '守卫反例', '--content', '不该落盘'])
  const wOut = String(w.stdout || '') + String(w.stderr || '')
  check('CLI log create 非零退出', w.status !== 0, `status=${w.status} err=${String(w.error || '')}`)
  check('CLI log create 明确说「拒绝」并指路界面', /拒绝/.test(wOut) && /方寸界面/.test(wOut), wOut.slice(0, 200))

  const logsDir = path.join(TMP, 'docs', '执行日志')
  const created = fs.existsSync(logsDir) ? fs.readdirSync(logsDir).filter((f) => f.endsWith('.md')) : []
  check('CLI 被拒后临时目录里没有多出日志文件', created.length === 0, created.join(','))

  const r = run(['log', 'list'])
  check('CLI 读口 log list 仍可用（退出 0）', r.status === 0, `status=${r.status} ${String(r.stderr || '').slice(0, 160)}`)
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
}

// ── D. 界面写口仍在（写入只允许人做，别把 UI 误伤）──────────────────
const ipcSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'src', 'main', 'ipc.ts'), 'utf8')
for (const ch of ['logs:create', 'logs:update', 'logs:complete', 'logs:archive', 'logs:destroy']) {
  check(`桌面界面写口仍在：${ch}`, ipcSrc.indexOf(`'${ch}'`) >= 0 || ipcSrc.indexOf(`"${ch}"`) >= 0)
}

// ── E. Python HTTP 没有日志写 API ──────────────────────────────────
const webSrc = fs.readFileSync(path.join(ROOT, 'tegula', 'web.py'), 'utf8')
check('Python HTTP（web.py）没有日志写 API', !/api_log_(create|update|complete|archive|destroy)/.test(webSrc))

console.log(`\n日志写口守卫：${pass} 通过 / ${fail} 失败`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log(' -', f)
  process.exit(1)
}
