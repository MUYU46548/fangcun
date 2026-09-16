import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { MCP_TOOLS } from './tools'
import { handleMCPRequest } from './handler'

let server: net.Server | null = null
let pipePath: string = ''

function getPipePath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\tegula-mcp'
  }
  const tmpDir = app.getPath('temp')
  return path.join(tmpDir, 'tegula-mcp.sock')
}

export function startMCPServer(): void {
  if (server) return
  
  pipePath = getPipePath()
  
  // Clean up old socket on Unix
  if (process.platform !== 'win32' && fs.existsSync(pipePath)) {
    fs.unlinkSync(pipePath)
  }
  
  server = net.createServer((socket) => {
    let buffer = ''
    
    socket.on('data', (data) => {
      buffer += data.toString('utf-8')
      
      // Process complete JSON lines
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        
        try {
          const req = JSON.parse(line)
          const resp = handleMCPRequest(req)
          socket.write(JSON.stringify(resp) + '\n')
        } catch (e) {
          const err = { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }
          socket.write(JSON.stringify(err) + '\n')
        }
      }
    })
    
    socket.on('error', () => {
      // Client disconnected
    })
  })
  
  server.listen(pipePath, () => {
    // Server started
  })
  
  server.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
      // Another instance is running
    }
  })
}

export function stopMCPServer(): void {
  if (server) {
    server.close()
    server = null
  }
  if (process.platform !== 'win32' && fs.existsSync(pipePath)) {
    fs.unlinkSync(pipePath)
  }
}

export function getServerPath(): string {
  return pipePath
}
