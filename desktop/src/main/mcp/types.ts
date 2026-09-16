export interface MCPTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface MCPRequest {
  jsonrpc: string
  id?: string | number
  method: string
  params?: any
}

export interface MCPResponse {
  jsonrpc: string
  id?: string | number
  result?: any
  error?: { code: number; message: string }
}

export interface MCPToolResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}
