import { MCPRequest, MCPResponse, MCPToolResult } from './types'
import { MCP_TOOLS, handleMCPToolCall } from './tools'

export function handleMCPRequest(req: MCPRequest): MCPResponse {
  const id = req.id
  
  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'tegula', version: '0.1.0' },
        },
      }
    
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: MCP_TOOLS },
      }
    
    case 'tools/call': {
      const { name, arguments: args } = req.params || {}
      const result: MCPToolResult = handleMCPToolCall(name, args || {})
      return {
        jsonrpc: '2.0',
        id,
        result,
      }
    }
    
    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      }
  }
}
