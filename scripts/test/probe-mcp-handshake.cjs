#!/usr/bin/env node
/**
 * 探针：模拟真实 MCP 客户端（DSH / Hermes）走一遍完整握手，把服务端每一次回包原样打出来。
 * 用法：node scripts/test/probe-mcp-handshake.cjs [path/to/tegula-mcp.js]
 */
const path = require('path')
const { spawn } = require('child_process')

const cli = process.argv[2] || path.resolve(__dirname, '../../desktop/dist/cli/tegula-mcp.js')
const child = spawn(process.execPath, [cli], { stdio: ['pipe', 'pipe', 'pipe'] })

const events = []
child.stdout.on('data', d => {
  for (const line of d.toString('utf-8').split('\n')) {
    if (line.trim()) events.push({ t: Date.now(), dir: 'out', line: line.trim() })
  }
})
child.stderr.on('data', d => events.push({ t: Date.now(), dir: 'err', line: d.toString('utf-8').trim() }))
child.on('exit', (code, sig) => events.push({ t: Date.now(), dir: 'exit', line: `code=${code} sig=${sig}` }))

const send = (obj, delay) => setTimeout(() => {
  events.push({ t: Date.now(), dir: 'in', line: JSON.stringify(obj) })
  child.stdin.write(JSON.stringify(obj) + '\n')
}, delay)

// 完全照 MCP 规范顺序
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1.0.0' } } }, 300)
send({ jsonrpc: '2.0', method: 'notifications/initialized' }, 700)   // ← 无 id 的通知
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 1100)
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } }, 1500)
send({ jsonrpc: '2.0', id: 4, method: 'ping' }, 2200)

setTimeout(() => {
  const t0 = events.length ? events[0].t : Date.now()
  for (const e of events) {
    const line = e.line.length > 400 ? e.line.slice(0, 400) + ' …' : e.line
    console.log(`+${String(e.t - t0).padStart(5)}ms [${e.dir}] ${line}`)
  }
  child.kill()
  process.exit(0)
}, 3200)
