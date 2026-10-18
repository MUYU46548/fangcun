#!/usr/bin/env node
/**
 * 探针②：按「方寸.exe --mcp-bridge」自举方式走完整 MCP 握手。
 * 用法：node scripts/test/probe-mcp-bridge.cjs [exe] [extraArg...]
 *   默认 exe = desktop/node_modules/electron/dist/electron.exe
 *   dev 态额外第一个参数必须是 app 目录（electron 的约定），脚本自动补。
 */
const path = require('path')
const { spawn } = require('child_process')

const desktop = path.resolve(__dirname, '../../desktop')
const exe = process.argv[2] || path.join(desktop, 'node_modules/electron/dist/electron.exe')
// dev 态：exe 是 electron.exe 时要把 app 目录作为第一个参数
const isElectronDev = /electron(\.exe)?$/i.test(path.basename(exe))
// 额外参数（例如 --disable-gpu）从第 4 个位置起追加
const extra = process.argv.slice(3)
const args = isElectronDev ? [desktop, ...extra, '--mcp-bridge'] : [...extra, '--mcp-bridge']

console.log('spawn:', exe, JSON.stringify(args))
// ⚠ 必须清掉 ELECTRON_RUN_AS_NODE：它会让 electron.exe/方寸.exe 退化成纯 node，
//   于是 `--mcp-bridge` 被 Node 的 CLI 解析器判成 "bad option"（exit 9），
//   看起来像产品 bug，其实是测试/宿主环境带进来的变量（本机开发 shell 就有）。
const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE
const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv })
const events = []
const t0 = Date.now()
const push = (dir, line) => events.push({ t: Date.now() - t0, dir, line })

child.stdout.on('data', d => {
  for (const l of d.toString('utf-8').split('\n')) if (l.trim()) push('out', l.trim())
})
child.stderr.on('data', d => {
  for (const l of d.toString('utf-8').split('\n')) if (l.trim()) push('err', l.trim())
})
child.on('exit', (code, sig) => push('exit', `code=${code} sig=${sig}`))
child.on('error', e => push('spawn-error', e.message))

const send = (obj, delay) => setTimeout(() => { push('in', JSON.stringify(obj)); child.stdin.write(JSON.stringify(obj) + '\n') }, delay)

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1.0.0' } } }, 2000)
send({ jsonrpc: '2.0', method: 'notifications/initialized' }, 2400)
send({ jsonrpc: '2.0', id: 2, method: 'ping' }, 2600)
send({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 2800)
send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_data_dir', arguments: {} } }, 3200)
send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_projects', arguments: {} } }, 3600)

setTimeout(() => {
  for (const e of events) {
    const line = e.line.length > 300 ? e.line.slice(0, 300) + ' …' : e.line
    console.log(`+${String(e.t).padStart(5)}ms [${e.dir}] ${line}`)
  }
  child.kill()
  process.exit(0)
}, 5200)
