/**
 * MCP 自举桥（2026-10-18）—— 让「方寸.exe 自己」当 MCP 桥，零外部依赖
 *
 * 为什么要有这个文件（真因取证，别再回退）：
 *   此前入口 A 是 `node <安装目录>/resources/app.asar.unpacked/dist/cli/tegula-mcp.js`。三重死结：
 *     ① electron-builder 的 files 是 `dist/**\/*`，dist/cli 全被打进 app.asar —— **外部 node 根本
 *        执行不了 asar 内的文件**（那是 Electron 的 fs 虚拟层，只对 Electron 进程有效）；打包配置里
 *        又没有 asarUnpack。等于入口 A 在**安装版上从来不可用**。
 *     ② 配置段写的 `command: node` 依赖 PATH。GUI 应用（Hermes / DSH 从快捷方式启动）继承用户 PATH，
 *        本机用户 PATH 里**没有独立 node**（只有 hermes 自带的一份），于是 spawn ENOENT。
 *     ③ 就算 node 找得到，MCP 客户端没配 cwd 时相对路径还会漂。
 *   现在：客户端直接 spawn 方寸自己的可执行文件 + `--mcp-bridge`，由 src/boot.ts 在**加载任何
 *   electron 业务模块之前**分流到本文件 —— 不建窗、不拿单实例锁、不读 asar 外部文件、不碰任何
 *   依赖 electron 的模块（见 pipe.ts 里对 ELECTRON_RUN_AS_NODE 的说明）。
 *
 * 本模块只做「stdio ↔ named pipe」纯转发，**不含业务逻辑**。
 * 业务仍在主实例里（handler.ts），乐观锁与审计照旧生效 —— 桥不绕过任何写规则。
 */

import * as net from 'net'
import * as readline from 'readline'
import * as os from 'os'
import { pipeNameFor } from './pipe'

function pipePath(): string {
  const tmp = process.env.TEMP || process.env.TMP || os.tmpdir()
  return pipeNameFor(process.platform, tmp)
}

function connect(pipe: string, timeoutMs = 10000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(
        `连接方寸桌面版超时（${timeoutMs}ms）：管道 ${pipe} 无响应。`
        + '请确认方寸正在运行（托盘图标），必要时右键「退出」后重新打开。',
      ))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      const code = e && e.code
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        reject(new Error(
          `方寸桌面版没有在运行（管道 ${pipe} 不存在）。请先打开方寸，再让 agent 重试。`,
        ))
      } else {
        reject(new Error(`连接方寸失败：${e && e.message ? e.message : String(e)}`))
      }
    })
  })
}

/**
 * 跑 stdio 桥。Promise 到任一端关闭才结束。
 * ⚠ stdout 是协议通道：这里**任何** console.log 都会污染 JSON-RPC 流，诊断一律走 stderr。
 */
export async function runStdioBridge(): Promise<void> {
  const pipe = pipePath()

  let socket: net.Socket
  try {
    socket = await connect(pipe)
  } catch (e) {
    process.stderr.write(`[fangcun-mcp] ${(e as Error).message}\n`)
    process.exit(1)
    return
  }

  // 协议错误不得让进程无声挂掉 —— 客户端只会看到"工具不可用"。
  socket.on('error', (e: Error) => {
    process.stderr.write(`[fangcun-mcp] 管道错误：${e.message}\n`)
    process.exit(1)
  })
  socket.on('close', () => process.exit(0))

  let outBuf = ''
  socket.setEncoding('utf-8')
  socket.on('data', (chunk: string) => {
    outBuf += chunk
    let idx: number
    while ((idx = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, idx)
      outBuf = outBuf.slice(idx + 1)
      if (line.trim()) process.stdout.write(line + '\n')
    }
  })

  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (line: string) => {
    if (line.trim()) socket.write(line + '\n')
  })
  rl.on('close', () => {
    try { socket.end() } catch { /* 已断开就算了 */ }
    process.exit(0)
  })
}

/** 桥模式的命令行开关（boot.ts 与配置段生成共用一处字面量） */
export const MCP_BRIDGE_FLAG = '--mcp-bridge'

// 直接运行本文件时自跑（`node dist/main/mcp/bridge-standalone.js`）——
// 这是排障用的单文件探针：不依赖 electron / 不依赖方寸 exe，直接验「管道通不通」。
// e2e 也用它起真桥进程。
if (require.main === module) {
  runStdioBridge()
}
