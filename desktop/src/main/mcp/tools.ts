import { MCPTool, MCPRequest, MCPResponse, MCPToolResult } from './types'
import { loadTasks, parseRegistry, getDataDir } from '../data'
import * as tasks from '../data/tasks'
import * as services from '../services'
import * as logs from '../services/logs'
import type { Task } from '../data'

// 2026-10-01 P0-3：这里**曾经**有一份私有 loadAllTasks 扫描（自己 walk task 目录、
// 跳过 archive/.trash）。它让 MCP 与 UI 对同一批数据给出不同答案 —— search_tasks
// 永远搜不到归档任务，而 UI 的「全部」含归档；view=trash 语义也对不上。现在读路径
// 一律走 data.loadTasks / tasks.listTrash，两个对外读口一个口径
// （契约由 scripts/test/e2e-mcp-views.cjs 真跑编译产物钉死）。

// ── Tool Definitions ────────────────────────────────────────────────────

export const MCP_TOOLS: MCPTool[] = [
  {
    name: 'list_tasks',
    description: 'List tasks with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', description: 'Filter: active, archive, trash, all', default: 'active' },
        project: { type: 'string', description: 'Filter by project ID' },
        status: { type: 'string', description: 'Filter by status' },
      },
    },
  },
  {
    name: 'search_tasks',
    description: 'Full-text search across task titles, bodies, and tags',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_task',
    description: 'Get a single task by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_task',
    description: 'Create a new task',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        status: { type: 'string', description: 'Initial status', default: '待办' },
        project: { type: 'string', description: 'Project ID' },
        priority: { type: 'string', description: '优先级：高 / 中 / 低（也接受 high/medium/low，写入前会自动归一）', default: '中' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
        body: { type: 'string', description: 'Task body/content' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description: 'Update a task',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID' },
        fields: { type: 'object', description: 'Fields to update' },
      },
      required: ['id', 'fields'],
    },
  },
  {
    name: 'move_status',
    description: 'Move a task to a different status',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID' },
        status: { type: 'string', description: 'Target status' },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'delete_task',
    description: 'Delete a task (move to trash)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_projects',
    description: 'List all registered projects',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_project_status',
    description: 'Get detailed project status and health',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Project ID (omit for all)' },
      },
    },
  },
  {
    name: 'find_blockers',
    description: 'Find tasks with blocking dependencies',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'scan_services',
    description: 'Scan running services declared in registry',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_roadmap',
    description: 'Get project roadmap with progress',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID (omit for all)' },
      },
    },
  },
  {
    name: 'get_data_dir',
    description: 'Get current data directory path',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'plan_list',
    description: 'List all plans',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'plan_get',
    description: 'Get a single plan by task ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Plan task ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'plan_pending',
    description: 'List plans with pending decisions',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'gate_list',
    description: 'List all acceptance gates',
    inputSchema: { type: 'object', properties: {} },
  },
  // ── 日志（2026-09-29 用户第 2 条）：日志没有可复制给 AI 的 ID，agent 只能整篇被注入。
  //    这三个工具让 agent 拿着 ID 自己去取，读操作、零写入。
  {
    name: 'list_logs',
    description: 'List execution logs (方寸执行日志). Returns id/title/status/project so a log can be located by ID. Pass `chain` to list an entire relay chain (接力链).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Filter by project ID' },
        status: { type: 'string', description: 'Filter: active | completed | archived' },
        chain: { type: 'string', description: 'Log ID: return every log in that log\'s relay chain (upstream ancestors + downstream descendants + itself), oldest → newest' },
        limit: { type: 'number', description: 'Max rows returned (default 50)' },
      },
    },
  },
  {
    name: 'search_logs',
    description: 'Full-text search across log titles, contents and project names',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },
  {
    name: 'get_log',
    description: 'Get one execution log by ID (e.g. log_20260929052313_ddimzo): content, next steps, status, links, plus relay chain up/downstream (接力链上下游) so the agent can walk the chain itself.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Log ID' } },
      required: ['id'],
    },
  },
]

// ── Tool Handler ────────────────────────────────────────────────────────

export function handleMCPToolCall(name: string, args: any): MCPToolResult {
  switch (name) {
    case 'list_tasks': {
      const view = args.view || 'active'
      // 回收站**不是** data.loadTasks 的视图：它落进 else 分支返回的是「活跃+归档」，
      // schema 写着 trash 返回的却不是回收站（2026-10-01 P0-3 对外契约偏差）。
      // 真回收站条目在 tasks.listTrash()，条目形状是扁平的（status/project 在顶层）。
      let result: any[] = view === 'trash' ? (tasks.listTrash() as any[]) : (loadTasks(view) as any[])
      // 取字段：任务有 fm 包裹，回收站条目是扁平的 —— 两种形状一起认
      const val = (t: any, k: string) => (t && t.fm && t.fm[k] !== undefined) ? t.fm[k] : t[k]
      if (args.project) {
        const want = String(args.project)
        result = result.filter((t: any) => {
          const proj = val(t, 'project')
          // fm.project 是**数组**（`项目: [fm-demo]`），旧写法 `=== args.project` 恒不匹配 → 过滤后永远 []
          return (Array.isArray(proj) ? proj : [proj]).some((x: any) => String(x || '') === want)
        })
      }
      if (args.status) {
        const wantSt = String(args.status)
        result = result.filter((t: any) => String(val(t, 'status') || '') === wantSt)
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.map((t: any) => ({ id: t.id, title: val(t, 'title'), status: val(t, 'status'), project: val(t, 'project') })), null, 2) }] }
    }
    
    case 'get_task': {
      const task = tasks.readTask(args.id)
      if (!task) return { content: [{ type: 'text', text: `Task not found: ${args.id}` }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify({ id: task.id, title: task.fm.title, status: task.fm.status, priority: task.fm.priority, project: task.fm.project, created: task.fm.created, updated: task.fm.updated, tags: task.fm.tags, body: task.body }, null, 2) }] }
    }
    
    case 'create_task': {
      const task = tasks.createTask({
        title: args.title,
        status: args.status,
        project: args.project,
        priority: args.priority,
        tags: args.tags,
        body: args.body,
      })
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: task.id }) }] }
    }
    
    case 'update_task': {
      const task = tasks.updateTask(args.id, args.fields)
      if (!task) return { content: [{ type: 'text', text: `Task not found: ${args.id}` }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: task.id }) }] }
    }
    
    case 'move_status': {
      const task = tasks.moveStatus(args.id, args.status)
      if (!task) return { content: [{ type: 'text', text: `Task not found: ${args.id}` }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: task.id, status: args.status }) }] }
    }
    
    case 'delete_task': {
      const ok = tasks.deleteTask(args.id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok }) }] }
    }
    
    case 'list_projects': {
      const projects = parseRegistry()
      return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] }
    }
    
    case 'get_project_status': {
      const status = tasks.scanProjectStatus()
      if (args.id) {
        const found = status.find((s: any) => s.id === args.id)
        return { content: [{ type: 'text', text: JSON.stringify(found || null, null, 2) }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] }
    }
    
    case 'find_blockers': {
      const blockers = tasks.getBlockerChains()
      return { content: [{ type: 'text', text: JSON.stringify(blockers, null, 2) }] }
    }
    
    case 'scan_services': {
      const svcs = services.scanServices()
      return { content: [{ type: 'text', text: JSON.stringify(svcs, null, 2) }] }
    }
    
    case 'get_roadmap': {
      const allTasks = loadTasks('active') as any[]
      const projects = args.project ? [{ id: args.project, name: args.project }] : parseRegistry()
      const roadmap = (projects as any[]).map((p: any) => {
        const projTasks = allTasks.filter((t: any) => t.fm.project === p.id)
        const byStatus: Record<string, any[]> = {}
        for (const t of projTasks) {
          const s = t.fm.status || '未知'
          if (!byStatus[s]) byStatus[s] = []
          byStatus[s].push({ id: t.id, title: t.fm.title })
        }
        return { project: p.name || p.id, tasks: byStatus }
      })
      return { content: [{ type: 'text', text: JSON.stringify(roadmap, null, 2) }] }
    }
    
    case 'get_data_dir': {
      return { content: [{ type: 'text', text: getDataDir() }] }
    }

    case 'search_tasks': {
      const query = args.query || ''
      // 'all' = 活跃 + 归档（与 UI 的「全部」同口径）。此前用的是**私有扫描**，
      // 它跳过 archive → 搜不到归档任务，同一个问题问 MCP 和问 UI 会得到不同答案。
      const pool = loadTasks('all') as any[]
      const results = pool.filter((t: any) => {
        const q = query.toLowerCase()
        return (t.fm.title || '').toLowerCase().includes(q) ||
          t.body.toLowerCase().includes(q) ||
          (t.fm.tags || []).some((tag: string) => tag.toLowerCase().includes(q))
      })
      return { content: [{ type: 'text', text: JSON.stringify(results.map((t: any) => ({
        id: t.id, title: t.fm.title, status: t.fm.status, project: t.fm.project
      })), null, 2) }] }
    }

    case 'plan_list': {
      const plans = tasks.listPlans()
      return { content: [{ type: 'text', text: JSON.stringify(plans.map((t: any) => ({
        id: t.id, title: t.fm.title, status: t.fm.status, plan_status: t.fm.plan_status
      })), null, 2) }] }
    }

    case 'plan_get': {
      const result = tasks.getPlan(args.id)
      if (!result) return { content: [{ type: 'text', text: `Plan not found: ${args.id}` }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify({
        id: result.task.id, title: result.task.fm.title, plan: result.plan
      }, null, 2) }] }
    }

    case 'plan_pending': {
      const plans = tasks.listPlans()
      const pending = plans.filter((t: any) => (t.fm as any).plan_status === 'draft' || (t.fm as any).plan_status === 'active')
      return { content: [{ type: 'text', text: JSON.stringify(pending.map((t: any) => ({
        id: t.id, title: t.fm.title, plan_status: t.fm.plan_status
      })), null, 2) }] }
    }

    case 'gate_list': {
      // Gates are in-memory only in Python version; return empty for now
      return { content: [{ type: 'text', text: JSON.stringify([], null, 2) }] }
    }

    case 'list_logs': {
      // chain 过滤（2026-09-29 方案二）：给一条日志 ID，返回它所在接力链的全部成员
      // （上游祖先 + 自身 + 下游子孙），从老到新 —— AI 顺着链自己走，不用整篇注入。
      if (args.chain) {
        const cid = String(args.chain)
        const self = logs.getLog(cid)
        if (!self) return { content: [{ type: 'text', text: `Log not found: ${cid}` }], isError: true }
        const ch = logs.logChain(cid)
        const members = [...ch.upstream, self, ...ch.downstream]
        const rows = members.slice(0, Number(args.limit) > 0 ? Number(args.limit) : 50).map((l: any) => ({
          id: l.id, title: l.title, status: logs.logStatusText(l), project: l.project,
          created: l.created, completed: l.completed || '', taskId: l.taskId || '', running: !!l.running,
          continuesFrom: l.continueFrom || '', isHead: !l.continueFrom, isTail: false,
        }))
        if (rows.length) rows[rows.length - 1].isTail = true
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
      }
      const filter: any = {}
      if (args.project) filter.project = args.project
      if (args.status) filter.status = args.status
      const limit = Number(args.limit) > 0 ? Number(args.limit) : 50
      const rows = logs.listLogs(filter).slice(0, limit).map((l: any) => ({
        id: l.id, title: l.title, status: logs.logStatusText(l), project: l.project,
        created: l.created, completed: l.completed || '', taskId: l.taskId || '', running: !!l.running,
        continuesFrom: l.continueFrom || '',
      }))
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
    }

    case 'search_logs': {
      const rows = logs.searchLogs(String(args.query || ''), 50).map((l: any) => ({
        id: l.id, title: l.title, status: logs.logStatusText(l), project: l.project, created: l.created,
      }))
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
    }

    case 'get_log': {
      const entry = logs.getLog(String(args.id || ''))
      if (!entry) return { content: [{ type: 'text', text: `Log not found: ${args.id}` }], isError: true }
      // 接力链上下游（方案二）：agent 拿到这条就能看见前后文，顺链自己走
      const ch = logs.logChain(entry.id)
      const mini = (l: any) => ({ id: l.id, title: l.title, status: logs.logStatusText(l), created: l.created })
      return { content: [{ type: 'text', text: JSON.stringify({
        id: entry.id, title: entry.title, status: logs.logStatusText(entry), project: entry.project,
        created: entry.created, completed: entry.completed || '', running: !!entry.running,
        taskId: entry.taskId || '', agentName: entry.agentName || '',
        content: entry.content, nextSteps: entry.nextSteps || '',
        continuesFrom: entry.continueFrom || '',
        chain: {
          upstream: ch.upstream.map(mini),    // 旧 → 新，直到链头
          downstream: ch.downstream.map(mini), // 近 → 远，直到链尾
        },
      }, null, 2) }] }
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }
}
