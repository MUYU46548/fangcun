/**
 * MCP 接入材料生成（2026-10-02 卡 002 · A 路线）
 *
 * 钉住四件事：
 *   ① 入口解析按本机路径动态生成、args 为绝对路径且文件真实存在（禁写死 E:/CODE/... 于代码里 —— 断言存在性）
 *   ② 六家目标齐全，配置落点按官方格式（DSH YAML 数组 / Codex 下划线 / OpenCode type:local 等）
 *   ③ A 路线红线：服务只读文件系统做检测，没有任何写外部文件的函数
 *   ④ 坏输入显式拒绝（未知目标 / 未知入口 / 入口不可用 → ok:false）
 *
 * 运行：node scripts/test/e2e-mcp-connect.cjs
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

const TEST_ROOT = path.join(os.tmpdir(), 'fc-mcpconn-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT
process.env.LOCALAPPDATA = path.join(TEST_ROOT, 'localappdata')

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
  console.log('== MCP 接入材料测试 ==')
  const mod = require(path.join(DIST, 'services', 'mcpConnect.js'))

  // ── ① 入口解析 ─────────────────────────────────────────────────
  const entries = mod.listMcpEntries()
  check('listMcpEntries 返回 A/B 两个入口', entries.length === 2 && entries[0].id === 'A' && entries[1].id === 'B',
    JSON.stringify(entries.map(e => e.id)))
  const entryA = entries.find(e => e.id === 'A')
  const entryB = entries.find(e => e.id === 'B')
  check('入口 A 可用（dev 已构建 dist/cli/tegula-mcp.js）', entryA.available === true, entryA.detail)
  check('入口 A args 是绝对路径且文件真实存在',
    entryA.available && path.isAbsolute(entryA.args[0]) && fs.existsSync(entryA.args[0]), JSON.stringify(entryA.args))
  check('入口 B 可用（仓库根 tegula.py）', entryB.available === true, entryB.detail)
  check('入口 B args = [绝对路径 tegula.py, mcp]',
    entryB.available && path.isAbsolute(entryB.args[0]) && entryB.args[1] === 'mcp' && fs.existsSync(entryB.args[0]),
    JSON.stringify(entryB.args))
  check('配置段不带 cwd（两个入口均实测 cwd 无关）',
    entries.every(e => !('cwd' in e)), JSON.stringify(entries))

  // ── ② 六家目标 + 官方格式 ───────────────────────────────────────
  const targets = mod.detectMcpTargets()
  const ids = targets.map(t => t.id)
  check('六家目标齐全', ['dsh', 'claudecode', 'cursor', 'codex', 'opencode', 'hermes'].every(x => ids.includes(x)),
    ids.join(','))
  const dsh = targets.find(t => t.id === 'dsh')
  check('DSH 本机检测到（~/.dsh/profiles/<p>/cordis.patch.yml 真实存在）',
    dsh.detected === true && !!dsh.configPath && fs.existsSync(dsh.configPath), dsh.evidence)

  const expect = (tid, eid, ...subs) => {
    const r = mod.buildMcpSnippet(tid, eid)
    check(`[${tid} × ${eid}] 生成成功`, r.ok === true, r.message)
    if (!r.ok) return
    for (const s of subs) {
      check(`  含 ${JSON.stringify(s)}`, r.snippet.includes(s), r.snippet.slice(0, 200))
    }
  }

  expect('dsh', 'A', '- id: mcp-fangcun', "name: '@deepseek-ai/dsh-mcp-client'", 'serverName: fangcun',
    'transport: stdio', 'failOnStartupError: false')
  expect('dsh', 'B', 'command: python', '"mcp"', 'serverName: fangcun')
  expect('claudecode', 'A', '"mcpServers"', '"fangcun"', '"command"', path.sep === '\\' ? 'tegula-mcp.js' : 'tegula-mcp.js')
  expect('cursor', 'A', '"mcpServers"', '"fangcun"')
  expect('codex', 'A', '[mcp_servers.fangcun]', 'command = ')
  expect('codex', 'B', '[mcp_servers.fangcun]', 'tegula.py')
  expect('opencode', 'A', '"mcp"', '"fangcun"', '"type": "local"', 'tegula-mcp.js')
  expect('hermes', 'A', 'mcp_servers:', '  fangcun:', 'command: "node"')

  // Codex 下划线守卫（官方文档：mcp-servers / mcpservers 会被静默忽略）
  const codexSnippet = mod.buildMcpSnippet('codex', 'A').snippet
  check('Codex 不出现连字符/无分隔节名（必须 mcp_servers 下划线）',
    !codexSnippet.includes('[mcp-servers') && !codexSnippet.includes('[mcpservers'), codexSnippet)

  // 所有配置段必须带本机动态路径（不是占位符）。
  // JSON/YAML 序列化会把反斜杠转义成 \\，比较前把 snippet 里的 \\ 归一成单斜杠。
  const norm = (s) => s.replace(/\\\\/g, '\\')
  for (const tid of ids) {
    const r = mod.buildMcpSnippet(tid, 'A')
    if (!r.ok) continue
    check(`[${tid}] 配置段含本机真实入口路径`, norm(r.snippet).includes(entryA.args[0]),
      norm(r.snippet).slice(0, 160))
  }

  // ── ③ A 路线红线：无写外部文件能力 ──────────────────────────────
  const src = fs.readFileSync(path.join(DIST, 'services', 'mcpConnect.js'), 'utf-8')
  const writeCalls = ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'copyFileSync']
    .filter(w => src.includes(w))
  check('★ 服务源码零写调用（A 路线：方寸不写任何外部应用的文件）',
    writeCalls.length === 0, writeCalls.join(','))

  // ── ④ 坏输入显式拒绝 ───────────────────────────────────────────
  const bad1 = mod.buildMcpSnippet('不存在的目标', 'A')
  check('未知目标 → ok:false 且有原因', bad1.ok === false && !!bad1.message, JSON.stringify(bad1))
  const bad2 = mod.buildMcpSnippet('dsh', 'Z')
  check('未知入口 → ok:false', bad2.ok === false && !!bad2.message, JSON.stringify(bad2))
  const bad3 = mod.buildMcpSnippet('dsh', '')
  check('空入口 → ok:false', bad3.ok === false, JSON.stringify(bad3))

  // ── 清理 ───────────────────────────────────────────────────────
  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
