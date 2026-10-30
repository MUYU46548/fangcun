import { MCPTool, MCPRequest, MCPResponse, MCPToolResult } from './types'
import { loadTasks, parseRegistry, getDataDir } from '../data'
import * as tasks from '../data/tasks'
import * as services from '../services'
import * as logs from '../services/logs'
import type { Task } from '../data'
import { appendTrace } from '../llm/trace'
import { buildExternalUsageRecord, isUsageReportOk } from '../../shared/usageReport'
import { recordRead, readStats } from './usage'
// 需求矩阵（2026-10-28）：写口只有这两个 + 一个只读列表。
// 为什么必须补写口：格式闸实勘确认 agent 经 MCP 的写工具**只有任务卡四件**，
// 决策卡与池文件此前根本没有通道（spec §四 引用的"现有写回层入口"对它们不存在）。
import { getRicePool, upsertRiceItems } from '../data/rice'
import { levelOfMap, riceSummary, scoreOf } from '../../shared/rice'

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
    name: 'usage_report',
    description:
      'Report AI usage from an external client (e.g. DSH / Hermes) into the Fangcun ledger. '
      + 'Records are marked origin=external and counted separately from Fangcun\'s own calls. '
      + 'Currency must be CNY (no FX conversion). At least one token field or cost is required.',
    inputSchema: {
      type: 'object',
      properties: {
        client: { type: 'string', description: 'Who reports (e.g. dsh / hermes); default "external"' },
        model: { type: 'string', description: 'Model name as you called it' },
        prompt_tokens: { type: 'number', description: 'Non-negative integer' },
        completion_tokens: { type: 'number', description: 'Non-negative integer' },
        total_tokens: { type: 'number', description: 'Non-negative integer (auto-summed if omitted)' },
        cost: { type: 'string', description: 'Provider-reported cost in CNY, optional' },
        currency: { type: 'string', description: 'Only CNY / 元 accepted; default CNY' },
        at: { type: 'string', description: 'ISO time of the call; defaults to now' },
        note: { type: 'string', description: 'Free-form note (max 120 chars)' },
      },
    },
  },
  {
    name: 'never_read',
    description:
      'List open tasks that NO agent has read in the last N days (source: mcp-usage.jsonl). '
      + 'This is the answer to "which todos has nobody actually touched" — status alone cannot tell '
      + 'whether a card was ever opened.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Look-back window in days (default 30)', default: 30 },
        project: { type: 'string', description: 'Only tasks of this project id' },
        limit: { type: 'number', description: 'Max rows (default 50)', default: 50 },
      },
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
    description: 'Get one execution log by ID (e.g. log_20260929052313_ddimzo): content, next steps, status, links, plus relay chain up/downstream (接力链上下游) so the agent can walk the chain itself. Attachments are returned with ABSOLUTE paths (attachments[].abs) plus attachmentsHint saying how many were not included as text — open those paths with a file/vision reader instead of asking for images inline.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Log ID' } },
      required: ['id'],
    },
  },
  // ── 日志写口（2026-10-29 暮雨第 7 条）────────────────────────────────
  // 此前 MCP 只有读日志三件：agent 想建/改/归档日志只能让用户在界面上点。
  // 四条写工具与桌面版同一套 services/logs，不存在第二套写路径。
  {
    name: 'create_log',
    description: 'Create an execution log (方寸执行日志) for this round of work. Returns its id — keep it, the next steps (attach_log_files / update_log / set_log_status) need it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Log title (required)' },
        project: { type: 'string', description: 'Project id, e.g. fangcun-base' },
        content: { type: 'string', description: 'What was done (Markdown; the body of the log)' },
        nextSteps: { type: 'string', description: 'What the next agent should do' },
        taskId: { type: 'string', description: 'Single related task id (legacy field)' },
        taskIds: { type: 'array', items: { type: 'string' }, description: 'Related task ids' },
        priority: { type: 'string', description: '高 | 中 | 低 (leave empty for unmarked)' },
        agentName: { type: 'string', description: 'Who wrote it (agent name)' },
        continueFrom: { type: 'string', description: 'Previous log id this one continues (接力)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_log',
    description: 'Edit an existing execution log (title / content / nextSteps / project / taskIds / priority). Lifecycle fields (status) are NOT here — use set_log_status. Content edits leave an "edited" stamp on the card.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Log ID' },
        title: { type: 'string' },
        content: { type: 'string' },
        nextSteps: { type: 'string' },
        project: { type: 'string' },
        taskIds: { type: 'array', items: { type: 'string' }, description: 'Pass [] to clear the links' },
        priority: { type: 'string', description: '高 | 中 | 低 | empty to clear' },
      },
      required: ['id'],
    },
  },
  {
    name: 'set_log_status',
    description:
      'Move a log along its lifecycle. ALLOWED for agents: running (标进行中) / idle (取消进行中) / '
      + 'request_close (申请收口 → 界面显示「等你确认」) / cancel_close (撤回申请). '
      + 'complete / archive / reopen are USER-ONLY: they are the sign-off, and this tool rejects them. '
      + 'Never claim a round is finished on the user\'s behalf — request_close and let the user click 确认完成.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Log ID' },
        action: { type: 'string', description: 'request_close | cancel_close | running | idle' },
        note: { type: 'string', description: 'Optional note appended to the log' },
      },
      required: ['id', 'action'],
    },
  },
  {
    name: 'attach_log_files',
    description: 'Attach local files (screenshots, reports) to an execution log by ABSOLUTE path. Files are COPIED into the data dir under docs/执行日志/_attachments/<logId>/ — the source is untouched. Returns each attachment with its absolute path.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Log ID' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute local file paths' },
      },
      required: ['id', 'paths'],
    },
  },
  {
    name: 'inject_logs',
    description: 'Bundle several logs into ONE hand-off text (main log first, the rest marked as parallel channels of the same round). Use this when a work order must carry a main log plus side logs (e.g. progress notices from parallel work) — injecting only the main log loses the other half. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Log ids, main log first' },
      },
      required: ['ids'],
    },
  },
  // ── 需求矩阵（RICE · 2026-10-28）────────────────────────────────────
  // 口径真源 docs/ADR-002-需求矩阵.md；池宿主 task-data/rice-pool.md。
  // ⚠ 总分不落盘：池里只有 R/I/C/E 四个原始分，RICE 由读取方现算。
  {
    name: 'rice_pool_list',
    description:
      'Read the requirement pool (task-data/rice-pool.md): every item with its R/I/C/E raw scores, '
      + 'computed RICE score, pool-relative level (P0/P1/P2/CUT), verdict and decision id. '
      + 'The total score is computed on read — it is never stored.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Only items whose task origin belongs to this project id' },
      },
    },
  },
  {
    name: 'rice_pool_upsert',
    description:
      'Upsert RICE initial scores into the requirement pool (idempotent). Same eid twice: '
      + 'overwrites scores/note/scorer and KEEPS the existing verdict + decision id — it never duplicates '
      + 'the entry. Invalid items are rejected one by one (the rest of the batch is still written). '
      + 'Value domains: I ∈ {0.25,0.5,1,2,3}; C ∈ {0.95,0.85,0.7,0.6}; '
      + 'evidence ∈ {亲口要,实测踩过,agent推断,纯直觉}. Agents must not record the user’s verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        batch: { type: 'string', description: 'Batch label for the audit log (e.g. 20261028-批1)' },
        by: { type: 'string', description: 'Who scored (default "agent")' },
        items: {
          type: 'array',
          description: 'Items to upsert',
          items: {
            type: 'object',
            properties: {
              eid: { type: 'string', description: 'rice-<type>-<原id> (external: rice-ext-<短hash>)' },
              title: { type: 'string' },
              origin: { type: 'string', description: 'type:id, type ∈ task/idea/todo/external' },
              R: { type: 'number', description: '每周使用频次（估数，非负）' },
              I: { type: 'number', description: '省手工量，∈ {0.25,0.5,1,2,3}' },
              C: { type: 'number', description: '信心，∈ {0.95,0.85,0.7,0.6}；省略则按证据等级推' },
              E_days: { type: 'number', description: '占几天（正整数，进公式）' },
              E_cost: { type: 'number', description: '预估花费（元，旁注，默认 0）' },
              evidence: { type: 'string', description: '证据等级：亲口要/实测踩过/agent推断/纯直觉' },
              by: { type: 'string', description: '本条打分人（省略用批次的 by）' },
              note: { type: 'string', description: '备注（多行会原样保留）' },
            },
            required: ['eid', 'title', 'origin', 'R', 'I', 'E_days', 'evidence'],
          },
        },
      },
      required: ['items'],
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
      // 读了哪些卡就记哪些（2026-10-25 卡 006）：只落独立日志，**任务文件不动**
      recordRead('list_tasks', result.map((t: any) => t.id))
      return { content: [{ type: 'text', text: JSON.stringify(result.map((t: any) => ({ id: t.id, title: val(t, 'title'), status: val(t, 'status'), project: val(t, 'project') })), null, 2) }] }
    }
    
    case 'get_task': {
      const task = tasks.readTask(args.id)
      if (!task) 
      return { content: [{ type: 'text', text: `Task not found: ${args.id}` }], isError: true }
      // 只有真读到了才记（读一张不存在的卡不算"碰过它"）
      recordRead('get_task', [task.id])
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
      // 2026-10-30（用户拍板「完成是签字，不是干活」）：
      // agent 最多把卡移到「待验收」；完成 / 驳回是用户的验收签字，硬拒。
      const want = String(args.status || '')
      if (want === '完成' || want === '驳回') {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          error: `「${want}」只能由用户验收裁决：agent 最多移到「待验收」。`,
          suggested: '待验收',
        }) }], isError: true }
      }
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
      recordRead('search_tasks', results.map((t: any) => t && t.id))
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
        agentDone: !!l.agentDone,
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
      // ── 附件（2026-10-29 暮雨第 9 条②）：**必须给绝对路径** ──────────────
      // 此前 `get_log` 只回正文，日志里写的 `![](docs/screenshots/x.png)` 对 agent 来说
      // 就是一行相对路径文本：它既不知道这是图，也不知道该从哪读起 ——
      // 于是"贴了一堆图"被读成"只有文字"。相对路径是相对**数据目录**的，
      // 这里解析成绝对路径，并把"有 N 个附件没随文本返回"明写出来。
      // ⚠ 不 base64 内联：一张截图就是几 MB，token 会当场爆掉。
      const atts = (entry.attachments || []).map((rel: string) => {
        const abs = logs.resolveAttachment(rel)
        const ext = String(rel).slice(String(rel).lastIndexOf('.') + 1).toLowerCase()
        return {
          rel,
          abs: abs || '',
          kind: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext) ? 'image' : 'file',
          missing: !abs,
        }
      })
      const images = atts.filter(a => a.kind === 'image' && a.abs)
      return { content: [{ type: 'text', text: JSON.stringify({
        id: entry.id, title: entry.title, status: logs.logStatusText(entry), project: entry.project,
        created: entry.created, completed: entry.completed || '', running: !!entry.running,
        agentDone: !!entry.agentDone,
        taskId: entry.taskId || '', agentName: entry.agentName || '',
        content: entry.content, nextSteps: entry.nextSteps || '',
        continuesFrom: entry.continueFrom || '',
        attachments: atts,
        // 给 agent 的一句人话（它能读到这条提示，就不会再说"只有文本"）
        attachmentsHint: atts.length
          ? `这条日志有 ${atts.length} 个附件（其中 ${images.length} 张图）**没有随文本返回**。`
            + `要看内容请用文件读取工具打开上面的 abs 绝对路径；不要把图片 base64 内联进上下文。`
            + (atts.some(a => a.missing) ? '（标 missing=true 的已不在盘上）' : '')
          : '',
        chain: {
          upstream: ch.upstream.map(mini),    // 旧 → 新，直到链头
          downstream: ch.downstream.map(mini), // 近 → 远，直到链尾
        },
      }, null, 2) }] }
    }

    // ── 日志写口（2026-10-29 暮雨第 7 条）──────────────────────────────
    // 事实核对：MCP 此前**只有读日志三件**（list/search/get），写口一个都没有 ——
    // 所以 agent 说"我改不了它的状态，只能在界面上点"是对的。
    // 补齐四条：建 / 改 / 状态流转 / 挂附件。语义与主进程 IPC 完全同源（都调 services/logs），
    // 不新开第二套写路径。
    case 'create_log': {
      const r = logs.createLog(
        String(args.title || '').trim(),
        String(args.project || '').trim(),
        String(args.content || ''),
        args.taskId ? String(args.taskId) : undefined,
        {
          nextSteps: args.nextSteps ? String(args.nextSteps) : '',
          taskIds: Array.isArray(args.taskIds) ? args.taskIds.map((x: any) => String(x)) : [],
          priority: args.priority ? String(args.priority) : '',
          agentName: args.agentName ? String(args.agentName) : '',
          continueFrom: args.continueFrom ? String(args.continueFrom) : '',
        },
      )
      if (!r.ok || !r.data) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: r.error || '创建失败' }) }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true, id: r.data.id, title: r.data.title, project: r.data.project,
        status: logs.logStatusText(r.data), created: r.data.created,
        hint: '后面用 attach_log_files 挂附件；本轮做完用 set_log_status action=request_close 申请收口（完成只能由用户点）。',
      }) }] }
    }

    case 'update_log': {
      const id = String(args.id || '')
      const r = logs.updateLog(id, {
        ...(args.title !== undefined ? { title: String(args.title) } : {}),
        ...(args.content !== undefined ? { content: String(args.content) } : {}),
        ...(args.nextSteps !== undefined ? { nextSteps: String(args.nextSteps) } : {}),
        ...(args.project !== undefined ? { project: String(args.project) } : {}),
        ...(args.taskIds !== undefined ? { taskIds: Array.isArray(args.taskIds) ? args.taskIds.map((x: any) => String(x)) : [] } : {}),
        ...(args.priority !== undefined ? { priority: String(args.priority) } : {}),
      })
      if (!r.ok || !r.data) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: r.error || '更新失败' }) }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: r.data.id, status: logs.logStatusText(r.data) }) }] }
    }

    case 'set_log_status': {
      const id = String(args.id || '')
      const action = String(args.action || '')
      // 2026-10-30（用户拍板「完成是签字，不是干活」）：
      // 完成 / 归档 / 退回都是**用户签字**，agent 只能申请收口。
      // 这里硬拒，不靠技能卡自觉 —— 拒了才知道自己越权了。
      if (action === 'complete' || action === 'archive' || action === 'reopen') {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          error: `「${action}」只能由用户在界面点：完成/归档/退回是签字，不是干活。`
            + '你可以用 set_log_status action=request_close 标记「等你确认」，用户在卡上点「✅ 确认完成」。',
          allowed: ['request_close', 'cancel_close', 'running', 'idle'],
        }) }], isError: true }
      }
      let r: any
      if (action === 'request_close') {
        r = logs.requestLogClose(id)
      } else if (action === 'cancel_close') {
        r = logs.cancelLogClose(id)
      } else if (action === 'running') {
        r = logs.setLogRunning(id, true)
      } else if (action === 'idle') {
        r = logs.setLogRunning(id, false)
      } else {
        return { content: [{ type: 'text', text: `Unknown action: ${action} (request_close | cancel_close | running | idle)` }], isError: true }
      }
      if (!r || !r.ok) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: r?.error || '状态没改成功' }) }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true, id,
        status: r.data ? logs.logStatusText(r.data) : action,
        agentDone: !!(r.data && r.data.agentDone),
        hint: r.data && r.data.agentDone ? '已标记「等你确认」——完成只能由用户点。' : '',
      }) }] }
    }

    case 'attach_log_files': {
      const id = String(args.id || '')
      const paths = (Array.isArray(args.paths) ? args.paths : []).map((p: any) => String(p || '')).filter(Boolean)
      if (!paths.length) return { content: [{ type: 'text', text: 'paths 不能为空（传本机绝对路径）' }], isError: true }
      const r = logs.addAttachments(id, paths)
      if (!r.ok) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: r.error || '挂附件失败' }) }], isError: true }
      // 回传挂上之后的绝对路径 —— 让 agent 下次能直接读回来核对
      const atts = (r.data?.attachments || []).map((rel: string) => ({ rel, abs: logs.resolveAttachment(rel) || '' }))
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, count: atts.length, attachments: atts }) }] }
    }

    // ── 多日志一起灌（2026-10-29 暮雨第 6 条：「主日志带多条副日志一起进开工单」）──
    // 真实用法长出来的需求：一条主日志讲这一轮干了什么，另几条是并行通道的进度通知；
    // 只灌主日志，agent 就会漏掉并行的另一半。这里按**给定顺序**拼成一份，主日志在前。
    case 'inject_logs': {
      const ids: string[] = (Array.isArray(args.ids) ? args.ids : []).map((x: any) => String(x || '')).filter(Boolean)
      if (!ids.length) return { content: [{ type: 'text', text: 'ids 不能为空（主日志放第一个）' }], isError: true }
      // 拼接逻辑在 services/logs（与界面「多选 → 开工单」同一份文本，不许两处各拼一次）
      const r = logs.injectLogs(ids)
      if (!r.found.length) return { content: [{ type: 'text', text: `这些日志都不存在：${ids.join(', ')}` }], isError: true }
      return { content: [{ type: 'text', text: r.text }] }
    }

    case 'never_read': {
      // 「哪些待办其实没人碰过」—— 只读，不写任何东西。
      const days = Number(args.days) > 0 ? Number(args.days) : 30
      const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 200) : 50
      const pool = loadTasks('active') as any[]
      const val = (t: any, k: string) => (t && t.fm && t.fm[k] !== undefined) ? t.fm[k] : t[k]
      const wanted = args.project ? String(args.project) : ''
      const rows = pool
        .filter((t: any) => {
          if (!wanted) return true
          const proj = val(t, 'project')
          return (Array.isArray(proj) ? proj : [proj]).some((x: any) => String(x || '') === wanted)
        })
        .map((t: any) => ({
          id: t.id,
          title: val(t, 'title'),
          status: val(t, 'status'),
          priority: val(t, 'priority'),
          project: val(t, 'project'),
          updated: val(t, 'updated'),
        }))
      const stats = readStats(days)
      const never = rows.filter((r: any) => !stats.has(String(r.id)))
      const read = rows.filter((r: any) => stats.has(String(r.id)))
      return { content: [{ type: 'text', text: JSON.stringify({
        window_days: days,
        total_open: rows.length,
        never_read: never.length,
        read: read.length,
        // 「多久没更新」是判断"卡死了"的辅助：从没读过 + 很久没更新 = 大概率没人管
        items: never.slice(0, limit),
      }, null, 2) }] }
    }

    case 'usage_report': {
      // 外部用量上报（2026-10-25 卡 005 第三件）。
      // ⚠ 写进去的记录带 origin='external'，月度报表**单独计数** ——
      //   外部数据既没法复验也不含本机上下文，混算就是"账本说假话"。
      const r = buildExternalUsageRecord(args, new Date().toISOString())
      if (!isUsageReportOk(r)) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: r.error }) }], isError: true }
      appendTrace(r.record as any)
      const rec = r.record
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        recorded: {
          ts: rec.ts,
          trigger: rec.trigger,
          model: rec.model,
          prompt_tokens: rec.prompt_tokens,
          completion_tokens: rec.completion_tokens,
          total_tokens: rec.total_tokens,
          ...(rec.cost ? { cost: rec.cost, currency: 'CNY' } : {}),
          origin: 'external',
        },
      }, null, 2) }] }
    }

    case 'rice_pool_list': {
      // 只读：总分与等级在这里现算（池文件里没有总分，手改分项后读出来就是新分）。
      const r = getRicePool()
      if (!r.ok) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: r.error, path: r.path }) }], isError: true }
      const levels = levelOfMap(r.pool.items)
      const want = String(args.project || '').trim()
      const rows = r.pool.items
        .filter((it) => {
          if (!want) return true
          // 池条目本身不带 project；按 task 来源的卡归属过滤
          const m = /^task:(.+)$/.exec(String(it.origin || ''))
          if (!m) return false
          const t = tasks.readTask(m[1])
          const p = (t?.fm as any)?.project
          return (Array.isArray(p) ? p : [p]).some((x: any) => String(x || '') === want)
        })
        .map((it) => ({
          eid: it.eid,
          title: it.title,
          origin: it.origin,
          R: it.R, I: it.I, C: it.C,
          E_days: it.E_days, E_cost: it.E_cost,
          evidence: it.evidence,
          score: scoreOf(it),
          level: levels[it.eid] || '',
          verdict: it.verdict || '',
          decisionId: it.decisionId || '',
          note: it.note || '',
          by: it.by || '',
        }))
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        path: r.path,
        budget: r.pool.budget,
        summary: riceSummary(r.pool).text,
        total: r.pool.items.length,
        items: rows,
      }, null, 2) }] }
    }

    case 'rice_pool_upsert': {
      // 幂等写：同 eid 连灌两遍条目数不变；拒该条不拒整批。
      const r = upsertRiceItems(Array.isArray(args.items) ? args.items : [], {
        by: args.by, batch: args.batch,
      })
      if (!r.ok) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: r.error }) }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        batch: r.batch,
        added: r.added,
        updated: r.updated,
        rejected: r.rejected,
        warnings: r.warnings,
        // 回传整池：调用方不用再猜"合入后长什么样"（也不许自己算）
        total: r.pool ? r.pool.items.length : 0,
        budget: r.pool ? r.pool.budget : 0,
        items: (r.pool ? r.pool.items : []).map((it) => ({
          eid: it.eid, title: it.title, origin: it.origin,
          R: it.R, I: it.I, C: it.C, E_days: it.E_days, E_cost: it.E_cost,
          evidence: it.evidence, score: scoreOf(it),
          verdict: it.verdict || '', decisionId: it.decisionId || '',
        })),
      }, null, 2) }] }
    }

    // 2026-10-30（用户拍板「决策是拍板，AI 只能记，不能替你表决」）：
    // `decision_record` 已从 MCP 移除。决策落账只走桌面界面的「需求矩阵」页（rice:decide 是用户点击触发的 IPC），
    // agent 再也不能替用户把某条需求记成「有效 / CUT」。

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }
}
