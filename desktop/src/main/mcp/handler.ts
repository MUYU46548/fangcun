import { MCPRequest, MCPResponse, MCPToolResult } from './types'
import { MCP_TOOLS, handleMCPToolCall } from './tools'

/**
 * JSON-RPC 2.0 / MCP 分发。
 *
 * ⚠ 返回 `null` = **不回包**（通知没有 id，规范规定不得回应）。
 *   2026-10-18 之前这里对 `notifications/initialized` 回了 -32601 —— 探针实测到的原样输出：
 *     → {"jsonrpc":"2.0","method":"notifications/initialized"}
 *     ← {"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found: notifications/initialized"}}
 *   严格实现的客户端（DSH 用的 @deepseek-ai/dsh-mcp-client）会把它判成协议违规并断开整条会话，
 *   用户看到的就是「方寸明明开着，agent 却说调用不到」。同时 `ping` 也返回 -32601，
 *   不少客户端在心跳失败时直接重连/放弃。
 */
export function handleMCPRequest(req: MCPRequest): MCPResponse | null {
  const id = req.id
  const hasId = id !== undefined && id !== null
  const method = String(req.method || '')

  // ── 通知：一律静默。任何 notifications/* 都不该有回包 ──
  if (!hasId || method.startsWith('notifications/')) {
    return null
  }

  switch (method) {
    case 'initialize': {
      // 规范要求服务端回「自己支持的版本」；对已知版本回显客户端所请求的，
      // 避免客户端因版本号更旧而主动降级或拒绝（2024-11-05 只是我们最早对齐的基线）。
      const asked = req.params && typeof req.params.protocolVersion === 'string'
        ? req.params.protocolVersion : ''
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18']
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: supported.includes(asked) ? asked : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fangcun', version: '0.3.9' },
          instructions:
            '方寸（fangcun）任务看板。任务卡落 task-data/*.md；写操作走 create_task / update_task / move_status，'
            + '受乐观锁保护（update_task 传 updated 可防覆盖）。列出任务用 list_tasks，搜索用 search_tasks。',
        },
      }
    }

    case 'ping':
      // MCP 基础方法，必须支持（空对象即可）
      return { jsonrpc: '2.0', id, result: {} }

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } }

    case 'tools/call': {
      const { name, arguments: args } = req.params || {}
      if (!name) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'tools/call 缺少工具名' } }
      }
      const result: MCPToolResult = handleMCPToolCall(name, args || {})
      return { jsonrpc: '2.0', id, result }
    }

    // ── 未声明能力但常见的探测：回空列表比回 -32601 友好，
    //    客户端不会因此判定服务端坏了（我们自己也不声明这些 capabilities）。──
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } }
    case 'resources/templates/list':
      return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } }
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } }

    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
  }
}
