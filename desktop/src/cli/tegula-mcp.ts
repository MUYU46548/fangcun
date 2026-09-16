#!/usr/bin/env node
/**
 * tegula-mcp — MCP stdio transport CLI
 * 
 * Protocol converter: stdio ↔ named pipe (Electron MCP server)
 * 
 * Usage:
 *   tegula-mcp              # Connect to running Electron app
 *   tegula-mcp --pipe PATH  # Explicit pipe path
 * 
 * External MCP agents spawn this CLI with stdio transport.
 * This script does NOT contain business logic — it only forwards
 * JSON-RPC messages between stdin/stdout and the named pipe.
 */

import * as net from 'net'
import * as readline from 'readline'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

function getPipePath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\tegula-mcp'
  }
  const tmpDir = process.env.TEMP || '/tmp'
  return path.join(tmpDir, 'tegula-mcp.sock')
}

function findPipePath(): string {
  // Check explicit path first
  const args = process.argv.slice(2)
  const pipeIdx = args.indexOf('--pipe')
  if (pipeIdx >= 0 && args[pipeIdx + 1]) {
    return args[pipeIdx + 1]
  }
  
  return getPipePath()
}

function connectToPipe(pipePath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath)
    
    socket.on('connect', () => {
      resolve(socket)
    })
    
    socket.on('error', (e: any) => {
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOENT') {
        reject(new Error('方寸桌面版未启动，请先打开方寸应用'))
      } else {
        reject(new Error(`连接失败: ${e.message}`))
      }
    })
    
    setTimeout(() => {
      socket.destroy()
      reject(new Error('连接超时'))
    }, 5000)
  })
}

async function main() {
  const pipePath = findPipePath()
  
  let socket: net.Socket
  try {
    socket = await connectToPipe(pipePath)
  } catch (e) {
    process.stderr.write(`tegula-mcp: ${(e as Error).message}\n`)
    process.exit(1)
  }
  
  // Read from stdin, forward to pipe
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  })
  
  let responseBuffer = ''
  
  socket.on('data', (data) => {
    responseBuffer += data.toString('utf-8')
    
    let idx: number
    while ((idx = responseBuffer.indexOf('\n')) >= 0) {
      const line = responseBuffer.slice(0, idx)
      responseBuffer = responseBuffer.slice(idx + 1)
      if (line.trim()) {
        process.stdout.write(line + '\n')
      }
    }
  })
  
  socket.on('close', () => {
    process.exit(0)
  })
  
  socket.on('error', () => {
    process.exit(1)
  })
  
  // Forward stdin lines to socket
  rl.on('line', (line) => {
    if (line.trim()) {
      socket.write(line + '\n')
    }
  })
  
  rl.on('close', () => {
    socket.end()
    process.exit(0)
  })
}

main().catch((e) => {
  process.stderr.write(`tegula-mcp: ${e.message}\n`)
  process.exit(1)
})
