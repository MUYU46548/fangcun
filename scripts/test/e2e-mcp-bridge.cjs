#!/usr/bin/env node
/**
 * MCP 桥 e2e（2026-10-18）
 *
 * 为什么要这一套：用户报「方寸开着，Hermes / DSH 都调不到方寸」。真因是入口形态本身不可用
 * （asar 内 js 外部 node 跑不了 / 裸 `node` 不在 GUI 进程 PATH 里 / 协议回应不合规）。
 * 这些都不是"界面点一下就能看出来"的，必须钉成断言。
 *
 * 本套测试**不启动 Electron**：桥模块刻意零 electron 依赖，直接用 node 起真桥进程，
 * 对端是假主实例（真 TCP/named pipe server），验证的是**真实子进程边界上的字节流**。
 *
 * 运行：node scripts/test/e2e-mcp-bridge.cjs
 */
const path = require('path')
const net = require('net')
const os = require('os')
const { spawn } = require('child_process')

const BRIDGE = path.resolve(__dirname, '../../desktop/dist/main/mcp/bridge-standalone.js')
const PIPE = process.platform === 'win32'
  ? `\\\\.\\pipe\\fc-e2e-mcp-${process.pid}`
  : path.join(os.tmpdir(), `fc-e2e-mcp-${process.pid}.sock`)

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}

function startFakeHost(handler) {
  const state = { sockets: [], server: null }
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      state.sockets.push(socket)
      let buf = ''
      socket.on('data', (d) => {
        buf += d.toString('utf-8')
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (!line.trim()) continue
          const reply = handler(line)
          // 假主实例也必须守 JSON-RPC：通知（无 id）不回包。
          // 不守的话测出来的"桥多回了一条"其实是测试桩自己造的，会误判产品。
          if (reply) socket.write(JSON.stringify(reply) + '\n')
        }
      })
      socket.on('error', () => {})
    })
    state.server = server
    server.listen(PIPE, () => resolve(state))
  })
}

/** 起桥子进程，收齐 stdout/stderr */
function runBridge(lines, { timeoutMs = 6000, expectExit = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, FC_MCP_PIPE: PIPE, ELECTRON_RUN_AS_NODE: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d.toString('utf-8') })
    child.stderr.on('data', d => { err += d.toString('utf-8') })
    for (const l of lines) child.stdin.write(l + '\n')
    const timer = setTimeout(() => { try { child.kill() } catch {} ; resolve({ out, err, code: null }) }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ out, err, code })
    })
  })
}

async function main() {
  console.log('== MCP 桥 e2e ==')
  console.log('bridge:', BRIDGE)
  console.log('pipe:', PIPE)

  // ── 反例前置：管道不存在时必须**明确失败**且不污染 stdout ──────────────
  {
    const r = await runBridge(['{"jsonrpc":"2.0","id":1,"method":"ping"}'])
    check('★ 方寸没开时桥退出码非 0（不能让客户端以为连上了）', r.code !== 0, String(r.code))
    check('★ 退出前给出中文可操作原因（指向"先打开方寸"）',
      /方寸桌面版没有在运行|不存在/.test(r.err), r.err.trim().slice(0, 120))
    check('★★ 失败时 stdout 必须为空（往协议通道写提示 = 客户端 JSON 解析崩）',
      r.out.trim() === '', JSON.stringify(r.out.slice(0, 120)))
  }

  // ── 正向：真 pipe 上的逐行转发 ────────────────────────────────────────
  const seen = []
  const host = await startFakeHost((line) => {
    seen.push(line)
    const req = JSON.parse(line)
    // 通知不回包（JSON-RPC 2.0 硬规定）
    if (req.id === undefined || req.id === null) return null
    if (req.method === 'initialize') {
      return { jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }
    }
    if (req.method === 'tools/list') {
      return { jsonrpc: '2.0', id: req.id, result: { tools: [] } }
    }
    return { jsonrpc: '2.0', id: req.id, result: { ok: true, echoed: req.method } }
  })

  {
    const lines = [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    ]
    const r = await runBridge(lines, { timeoutMs: 2500 })
    const outLines = r.out.split('\n').filter(l => l.trim())
    check('★ 桥把 stdin 每一行原样转给管道（到服务端 3 条）', seen.length === 3, String(seen.length))
    check('★ 服务端回包逐行进 stdout', outLines.length === 2, String(outLines.length))
    check('★★ stdout 每一行都是合法 JSON（夹杂调试输出会让客户端整条会话崩）',
      outLines.every(l => { try { JSON.parse(l); return true } catch { return false } }), r.out.slice(0, 200))
    check('★ 回包顺序与请求一致（id=1 在前）',
      outLines[0] && JSON.parse(outLines[0]).id === 1, outLines[0])
    check('★ 通知（无 id）不产生回包 —— 只有 2 条回包对应 2 个带 id 的请求',
      outLines.length === 2 && !outLines.some(l => JSON.parse(l).id === undefined), JSON.stringify(outLines.map(l => JSON.parse(l).id)))
    check('★ 正常工作时 stderr 安静（不留噪声）', r.err.trim() === '', r.err.slice(0, 120))
  }

  // ── 反例：服务端断开 → 桥必须退出，不许挂成僵尸 ──────────────────────
  {
    const p = runBridge(['{"jsonrpc":"2.0","id":9,"method":"ping"}'], { timeoutMs: 5000 })
    setTimeout(() => {
      // 必须 reset 已建立的连接（server.close() 只停止接受新连接，存量 socket 不会断）
      for (const s of host.sockets) { try { s.destroy() } catch {} }
      try { host.server.close() } catch {}
    }, 300)
    const r = await p
    check('★ 服务端断开后桥进程随之退出（客户端不会卡死等 EOF）', r.code !== null, String(r.code))
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
