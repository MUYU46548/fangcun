#!/usr/bin/env node
/**
 * MCP 协议合规 e2e（2026-10-18）
 *
 * 为什么单开一套：桥（传输层）通了 ≠ 客户端愿意用。真实 MCP 客户端在 initialize 之后
 * 会立刻发 `notifications/initialized`（无 id 的通知）并周期性 `ping`。
 * 2026-10-18 之前服务端对这两者都回 `-32601 Method not found` ——
 * 严格客户端会判协议违规并丢弃整条会话，用户看到的就是「方寸开着，agent 说调不到」。
 *
 * 本套直接跑编译产物 main/mcp/handler.js（真代码），只桩掉它下方的数据层依赖。
 * 运行：node scripts/test/e2e-mcp-protocol.cjs
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

const TEST_ROOT = path.join(os.tmpdir(), 'fc-mcp-proto-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT
fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'),
  'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示\n', 'utf-8')

const DIST = path.resolve(__dirname, '../../desktop/dist/main')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}

function main() {
  console.log('== MCP 协议合规 e2e ==')
  const data = require(path.join(DIST, 'data', 'index.js'))
  if (typeof data.setDataDir === 'function') data.setDataDir(TEST_ROOT)

  const { handleMCPRequest } = require(path.join(DIST, 'mcp', 'handler.js'))

  // ── ① 通知（无 id）必须**零回包** ─────────────────────────────────────
  {
    const r1 = handleMCPRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })
    check('★★ notifications/initialized 不回包（回 -32601 会让严格客户端断会话）', r1 === null, JSON.stringify(r1))
    const r2 = handleMCPRequest({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })
    check('★ notifications/cancelled 也不回包', r2 === null, JSON.stringify(r2))
    const r3 = handleMCPRequest({ jsonrpc: '2.0', method: 'anything/else' })
    check('★ 任何无 id 的消息都不回包（JSON-RPC 2.0 硬规定）', r3 === null, JSON.stringify(r3))
    const r4 = handleMCPRequest({ jsonrpc: '2.0', id: undefined, method: 'ping' })
    check('★ id 为 undefined 的 ping 也不回包（不是"请求"就不要应答）', r4 === null, JSON.stringify(r4))
  }

  // ── ② ping 必须支持 ──────────────────────────────────────────────────
  {
    const r = handleMCPRequest({ jsonrpc: '2.0', id: 'p1', method: 'ping' })
    check('★★ ping 返回空对象 result（心跳失败会让客户端重连/放弃）',
      r && r.result && Object.keys(r.result).length === 0 && r.id === 'p1', JSON.stringify(r))
  }

  // ── ③ initialize 回显客户端版本（不做无谓降级）────────────────────────
  {
    const r24 = handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    check('★ initialize(2024-11-05) 回显同版本', r24.result.protocolVersion === '2024-11-05', r24.result.protocolVersion)
    const r25 = handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    check('★ initialize(2025-06-18) 回显同版本', r25.result.protocolVersion === '2025-06-18', r25.result.protocolVersion)
    const rBad = handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
    check('  未知版本回落到基线 2024-11-05', rBad.result.protocolVersion === '2024-11-05', rBad.result.protocolVersion)
    check('★ 声明 tools 能力 + 带 instructions（agent 才知道怎么用）',
      !!r24.result.capabilities.tools && typeof r24.result.instructions === 'string' && r24.result.instructions.length > 20,
      JSON.stringify(Object.keys(r24.result)))
  }

  // ── ④ tools/list 结构 ────────────────────────────────────────────────
  {
    const r = handleMCPRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = r.result.tools
    check('★ tools/list 返回非空工具集', Array.isArray(tools) && tools.length > 0, String(tools && tools.length))
    check('★ 每个工具都有 name/description/inputSchema（缺一个客户端就不显示）',
      tools.every(t => t.name && t.description && t.inputSchema && t.inputSchema.type === 'object'),
      JSON.stringify(tools.filter(t => !t.name || !t.inputSchema).map(t => t.name)))
    check('★ 写侧工具齐全（create_task / update_task / move_status 缺一就不能"记录"）',
      ['create_task', 'update_task', 'move_status', 'delete_task'].every(n => tools.some(t => t.name === n)),
      JSON.stringify(tools.map(t => t.name)))
  }

  // ── ⑤ tools/call 正向 + 反例 ─────────────────────────────────────────
  {
    const r = handleMCPRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_data_dir', arguments: {} } })
    check('★ tools/call get_data_dir 返回 content[].text',
      r.result && Array.isArray(r.result.content) && r.result.content[0].type === 'text', JSON.stringify(r).slice(0, 160))

    const bad = handleMCPRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: '不存在的工具', arguments: {} } })
    check('★ 未知工具名 → 仍按 JSON-RPC 回 result（isError），不炸传输层',
      bad && (bad.result && bad.result.isError === true || bad.error), JSON.stringify(bad).slice(0, 200))

    const noName = handleMCPRequest({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {} })
    check('★ 缺工具名 → -32602 参数错误（带 id）',
      noName.error && noName.error.code === -32602 && noName.id === 5, JSON.stringify(noName))
  }

  // ── ⑥ 未知方法：带 id 才报错 ─────────────────────────────────────────
  {
    const r = handleMCPRequest({ jsonrpc: '2.0', id: 6, method: 'resources/subscribe' })
    check('★ 未知方法（带 id）→ -32601', r.error && r.error.code === -32601, JSON.stringify(r))
    // 探测类方法宽容回空（我们不声明这些能力，但客户端常先探一下）
    const rl = handleMCPRequest({ jsonrpc: '2.0', id: 7, method: 'resources/list' })
    check('  未声明能力的探测（resources/list）回空列表而不是报错',
      rl.result && Array.isArray(rl.result.resources), JSON.stringify(rl))
    const pl = handleMCPRequest({ jsonrpc: '2.0', id: 8, method: 'prompts/list' })
    check('  prompts/list 同样回空列表', pl.result && Array.isArray(pl.result.prompts), JSON.stringify(pl))
  }

  // ── ⑦ 源码守卫：socket-server 不许对 null 回包、不许把异常变成 Parse error ──
  {
    const src = fs.readFileSync(path.join(DIST, 'mcp', 'socket-server.js'), 'utf-8').replace(/\r\n/g, '\n')
    check('★ socket-server 对 handler 返回 null 时不得写回包',
      /if\s*\(resp\)\s*socket\.write/.test(src), '未找到 if (resp) socket.write 守卫')
    check('★ 工具异常必须包成 result+isError，不能退化成 -32700 Parse error',
      /isError:\s*true/.test(src) && /catch\s*\(e\)/.test(src), '未找到 try/catch 包装')
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
