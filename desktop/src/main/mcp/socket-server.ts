import * as net from 'net'
import * as fs from 'fs'
import { app } from 'electron'
import { handleMCPRequest } from './handler'
import { pipeNameFor } from './pipe'

/**
 * 管道名单一出处（2026-10-18）：桥（bridge-standalone）与服务器都从 pipe.ts 取。
 * 此前两边各写一份字符串，任何一个改动都会让「方寸在跑但连不上」——这种 bug 只会被
 * 用户看见，不会在测试里红。
 */
export function getPipeName(): string {
  return pipeNameFor(process.platform, app.getPath('temp'))
}

let server: net.Server | null = null
let pipePath = ''

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void {
  // 延迟 require：socket-server 在 e2e 里会被单独加载，appLog 依赖 app.getPath，
  // 顶层 import 会在没 ready 的桩里炸。
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const appLog = require('../services/appLog')
    appLog[level]('mcp', msg, extra)
  } catch {
    try { process.stderr.write(`[mcp] ${msg}\n`) } catch { /* ignore */ }
  }
}

export function startMCPServer(): void {
  if (server) return

  pipePath = getPipeName()

  // Unix 下清残留 socket；Windows 的 named pipe 随进程消失，无需处理
  if (process.platform !== 'win32' && fs.existsSync(pipePath)) {
    try { fs.unlinkSync(pipePath) } catch { /* 清不掉就交给 listen 报错 */ }
  }

  server = net.createServer((socket) => {
    // 多个 MCP 客户端（DSH + Hermes + Claude Code）可能同时连，每个客户端一条连接；
    // 服务端按连接各自维护缓冲，不共享状态。
    let buffer = ''
    socket.setEncoding('utf-8')

    socket.on('data', (data: string) => {
      buffer += data

      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue

        // 1) 解析失败 = JSON-RPC 层的错，必须带 id:null 回包（规范要求）
        let req: any
        try {
          req = JSON.parse(line)
        } catch {
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n')
          continue
        }

        // 2) 工具执行失败**不能**变成传输层错误（那会让客户端判定连接坏了并丢弃整条会话）。
        //    单独兜住，仍然按 JSON-RPC 正常回 result + isError。
        let resp: any
        try {
          resp = handleMCPRequest(req)
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          log('error', 'MCP 请求处理异常', { method: req && req.method, message })
          resp = {
            jsonrpc: '2.0',
            id: req && req.id !== undefined ? req.id : null,
            result: {
              content: [{ type: 'text', text: `方寸内部错误：${message}` }],
              isError: true,
            },
          }
        }

        // 3) 通知（无 id）**绝不回包** —— 回一个 error 上去会让严格客户端判定协议违规。
        if (resp) socket.write(JSON.stringify(resp) + '\n')
      }
    })

    socket.on('error', () => {
      // 客户端断开是常态（用户关掉 agent），不是错误
    })
  })

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      log('warn', `MCP 管道已被占用（${pipePath}）—— 另一个方寸实例可能还在跑`)
    } else {
      log('error', `MCP 服务启动失败：${e.message}`, e.stack)
    }
  })

  server.listen(pipePath, () => {
    log('info', `MCP 服务已监听 ${pipePath}`)
  })
}

export function stopMCPServer(): void {
  if (server) {
    server.close()
    server = null
  }
  if (process.platform !== 'win32' && pipePath && fs.existsSync(pipePath)) {
    try { fs.unlinkSync(pipePath) } catch { /* ignore */ }
  }
}

export function getServerPath(): string {
  return pipePath || getPipeName()
}
