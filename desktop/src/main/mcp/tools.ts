import { MCPTool, MCPRequest, MCPResponse, MCPToolResult } from './types'
import { loadTasks, parseRegistry, getDataDir } from '../data'
import * as tasks from '../data/tasks'
import * as services from '../services'
import * as logs from '../services/logs'
import type { Task } from '../data'
import { appendTrace } from '../llm/trace'
import { buildExternalUsageRecord, isUsageReportOk } from '../../shared/usageReport'
import { recordRead, readStats } from './usage'
// 收卡机检（ADR-003 一期 · 2026-11-02）：外部 agent 交单时先机检再落卡。
// 四类判据面向**交付物文本**，不起进程（cmd 在这里一律 unknown，跑测试是“待验收”的事）。
import { renderIntakeSection } from '../../shared/intake'
// 存在性检查与报告跑一次都收在 services/intake（tools 里不再写第二份口径）
import { checkIntake } from '../services/intake'
// agent 直接要点架构图（2026-11-02）：与界面按钮同一个服务，不另写一套生成
import { archForProject } from '../services/projectArch'
import { generatePlanDraft } from '../llm/planDraft'
import { buildPlanDraftInputFromDisk } from '../llm/planDraftInput'
import { generateArchGraph } from '../services/archAi'
// 需求矩阵（2026-10-28）：写口只有这两个 + 一个只读列表。
// 为什么必须补写口：格式闸实勘确认 agent 经 MCP 的写工具**只有任务卡四件**，
// 决策卡与池文件此前根本没有通道（spec §四 引用的"现有写回层入口"对它们不存在）。
import { getRicePool, upsertRiceItems } from '../data/rice'
import { levelOfMap, riceSummary, scoreOf } from '../../shared/rice'
// ── 只读口补齐（2026-11-08 暮雨拍板：“开只读口，后续 AI 可写”）─────────────
// 决策 / 项目方针（含结构地图）/ 作战计划三块正文 —— 这三样此前 MCP **一个字都读不到**，
// 于是“决策、方针、结构地图形同虚设”不是 AI 懒，是它没有入口。本轮只开读，不碰写：
//   · 决策的写口（decision_record）是 2026-11-03 明确移除的，只在需求矩阵页由用户点；
//     要开口必须先有“AI 只能落待审批”的设计，不在这一刀里顺手破。
//   · 方针的写口是 savePolicy（界面在用）；结构地图也在同一份文件里。
// 也就是说：**读口在这一层开，写口将来从同一层接** —— 下面三个 case 是唯一入口。
import { loadDecisions, normalizeDecisionStatus } from '../data/decisions'
import { getPolicy } from '../services/policies'
import { listPlanFiles, readPlan } from '../data/plans'

// 2026-10-01 P0-3：这里**曾经**有一份私有 loadAllTasks 扫描（自己 walk task 目录、
// 跳过 archive/.trash）。它让 MCP 与 UI 对同一批数据给出不同答案 —— search_tasks
// 永远搜不到归档任务，而 UI 的“全部”含归档；view=trash 语义也对不上。现在读路径
// 一律走 data.loadTasks / tasks.listTrash，两个对外读口一个口径
// （契约由 scripts/test/e2e-mcp-views.cjs 真跑编译产物钉死）。

// 2026-10-30 暮雨第 3 条：被驳回后“退回返工”的卡，agent 必须读得到上次为什么被打回。
// 没有这一段，MCP 只回标题/状态，返工卡就退化成一张大号待办。
function reworkOf(fm: any): { is_rework: boolean; reason: string } {
  const reason = String(fm?.reject_reason ?? fm?.['驳回理由'] ?? '').trim()
  const at = String(fm?.reject_at ?? fm?.['驳回时间'] ?? '').trim()
  const log = String(fm?.result_log ?? fm?.['结果记录'] ?? '')
  return { is_rework: !!(reason || at || /驳回/.test(log)), reason }
}

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
    name: 'arch_generate',
    description:
      '让方寸给某个已登记项目**生成架构图**（AI 画 + 逐条证据审计）。'
      + '模型只能引用扫描事实里真实存在的目录 / 入口 / 依赖 / import / IPC / 端口；'
      + '指不回证据的节点与连线一律拒收，并会把“哪条不过、为什么”写进 issues；'
      + '审计不过的会按意见自动重画（默认 2 次），仍不过或无模型时**降级为扫描图**，'
      + '`source` 会如实写 ai 或 scan。会调用你在方寸设置里配的模型（BYOK），每次调用产生花销。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目 id 或项目名（registry 里登记的）' },
        max_attempts: { type: 'number', description: '最多重画几次（默认 2，上限 3）' },
      },
      required: ['project'],
    },
  },
  {
    name: 'plan_draft',
    description:
      '让方寸**给自己起草一份作战计划草案**（BYOK，会真调模型并产生花销）。'
      + '输入是该项目未结卡的「方案 + 结果记录原文」和已完成卡标题 —— '
      + '所以它能看见哪张卡已写好施工方案、哪张自报了没做的部分。'
      + '输出是 2–5 张阶段卡（P0/P1…）+ 每条的机器判据 + 依据引用，落 plans/_drafts，状态恒“待裁决”。'
      + '引不出真实依据的条目会被丢弃并计入 dropped，不会编造。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目 id（如 fangcun-base）' },
        max_open: { type: 'number', description: '未结卡最多带几张正文（默认 24，上限 60）' },
        max_done: { type: 'number', description: '已完成卡最多列几张标题（默认 8，上限 40）' },
      },
      required: ['project'],
    },
  },
  {
    name: 'intake_task',
    description:
      '收卡（ADR-003 一期）：把交付物 + 卡上判据交进方寸，**先机检再落卡**。'
      + '判据四类：str: \'原文\' / count: \'原文\' == N / format: <正则> / file: <相对路径> 存在。'
      + '全过 → 落“待审批”（REV-009）；有不过 → 落“草稿”+ 正文红标 + 逐条留痕（**不阻挡，东西不丢**）。'
      + '返回机检报告；agent 据此决定是否返工。cmd: 判据在收卡时不跑（归“待验收”阶段）。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Card title' },
        project: { type: 'string', description: 'Project id' },
        deliverable: { type: 'string', description: '交付物全文（Markdown）。空字符串 = 每条判据都不过' },
        criteria: {
          type: 'array', items: { type: 'string' },
          description: "收卡判据，四类：str: '原文' / count: '原文' == 6 / format: <正则> / file: docs/x.md 存在",
        },
        agent: { type: 'string', description: '交单人（写进留痕）' },
        model: { type: 'string', description: '模型名（写进留痕）' },
        priority: { type: 'string', description: '高 / 中 / 低', default: '中' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
        force_status: {
          type: 'string',
          description: '强制落卡状态（默认按机检自动：全过→待审批，有不过→草稿）',
        },
      },
      required: ['title', 'deliverable', 'criteria'],
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
  // ── 只读口补齐（2026-11-08 暮雨拍板：“开只读口，后续 AI 可写”）─────────────
  // 这三样此前 MCP 一个字都读不到 —— 所以“决策/方针/结构地图形同虚设”不是 AI 懒，是没入口。
  // ⚠ 全部只读。写口将来从同一层接，但**不是这一刀**：
  //   决策的写（decision_record）2026-11-03 明确移除、只在需求矩阵页由用户点；
  //   要开 AI 写，必须先有“只落待审批”的设计，不能顺手破。
  {
    name: 'decision_list',
    description: 'READ-ONLY. Read 决策卡 (task-data/decisions.md): what has already been decided, '
      + 'when, by which project, and whether it still holds (有效/已撤销/已合并). '
      + 'Check this BEFORE proposing something that may contradict an earlier decision. '
      + 'Decisions are made by the user in the UI — this tool cannot write one.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Filter by project id (optional)' },
        status: { type: 'string', description: '有效 | 已撤销 | 已合并（可选，旧词会归一）' },
        query: { type: 'string', description: 'Match 内容 / 备注 / 出处 (optional)' },
        limit: { type: 'number', description: 'Max rows, newest first (default 30)' },
      },
    },
  },
  {
    name: 'project_charter',
    description: 'READ-ONLY. Read a project charter (policies/<id>.md): mission / goal / scenario / boundary '
      + 'plus the 结构地图 section (module list + one-line duties + main data flow). '
      + 'Sections that are missing are reported as missing — this tool never invents content.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Project id, e.g. fangcun-base' } },
      required: ['project'],
    },
  },
  {
    name: 'stage_plan_get',
    description: 'READ-ONLY. Read 作战计划 stage cards from task-data/plans/*.md: the three blocks '
      + '(技术方案 / 照抄点 / 判据) plus status / verdict / reject reason. '
      + 'Omit `file` for an overview of every plan file. Freezing or rejecting a stage is the user\'s click.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Plan file name, e.g. fangcun-base.md (omit for overview)' },
        stageId: { type: 'string', description: 'Only this stage, e.g. P3 (optional)' },
      },
    },
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
    description: 'Create an execution log (方寸执行日志). ⚠ ONLY when the user explicitly asks for a log — '
      + 'it is the user\'s private context notebook, NOT the place to report work. '
      + 'Requires userAsked: true, otherwise the call is rejected. '
      + 'To close out work use update_task (+ move_status → 待验收) instead.',
    inputSchema: {
      type: 'object',
      properties: {
        userAsked: { type: 'boolean', description: 'Must be true — set it only when the user explicitly asked you to write a log' },
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
      'Mark a log as running (进行中) or idle (取消进行中). That is ALL an agent may do to a log. '
      + 'Logs are execution records, NOT acceptance items: there is no request_close / cancel_close. '
      + 'When the work is done, move the linked TASK to 待验收 with move_status — 完成 / 驳回 stay user-only sign-off. '
      + 'complete / archive / reopen on a log are USER-ONLY and are rejected here.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Log ID' },
        action: { type: 'string', description: 'running | idle' },
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

export function handleMCPToolCall(name: string, args: any): MCPToolResult | Promise<MCPToolResult> {
  switch (name) {
    case 'list_tasks': {
      const view = args.view || 'active'
      // 回收站**不是** data.loadTasks 的视图：它落进 else 分支返回的是“活跃+归档”，
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
      return { content: [{ type: 'text', text: JSON.stringify(result.map((t: any) => {
        const rw = reworkOf(t.fm || t)
        return {
          id: t.id, title: val(t, 'title'), status: val(t, 'status'), project: val(t, 'project'),
          // 返工卡：列表里就标出来，agent 不用先 get_task 才知道它是被打回的
          rework: rw.is_rework, reject_reason: rw.reason,
        }
      }), null, 2) }] }
    }
    
    case 'get_task': {
      const task = tasks.readTask(args.id)
      if (!task) 
      return { content: [{ type: 'text', text: `Task not found: ${args.id}` }], isError: true }
      // 只有真读到了才记（读一张不存在的卡不算"碰过它"）
      recordRead('get_task', [task.id])
      const rw = reworkOf(task.fm)
      return { content: [{ type: 'text', text: JSON.stringify({
        id: task.id, title: task.fm.title, status: task.fm.status, priority: task.fm.priority,
        project: task.fm.project, created: task.fm.created, updated: task.fm.updated, tags: task.fm.tags,
        // 2026-10-30 暮雨第 3 条：驳回理由 / 结果记录 / 返工标记必须一起回，
        // 否则 agent 读到的“驳回后待办”和普通待办完全一样。
        result_log: task.fm.result_log || '',
        reject_reason: rw.reason,
        reject_at: task.fm.reject_at || '',
        rework: rw.is_rework,
        body: task.body,
      }, null, 2) }] }
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
    
    case 'plan_draft': {
      // 让方寸给自己起草一份计划（2026-11-02）。此前 generatePlanDraft 没有任何调用方 ——
      // 生成器写好了两个月，方寸从没真的规划过自己。
      // 输入 = 该项目未结卡的【方案 + 结果记录原文】+ 已完成卡标题；输出落 plans/_drafts，状态恒“待裁决”。
      const proj = String(args.project || '').trim()
      if (!proj) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: '要给 project（项目 id）' }) }], isError: true }
      }
      const input = buildPlanDraftInputFromDisk({
        project: proj,
        maxOpen: Math.min(60, Math.max(1, Number(args.max_open) || 24)),
        maxDone: Math.min(40, Math.max(0, Number(args.max_done) || 8)),
      })
      return generatePlanDraft(input).then((r) => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: r.ok,
            error: r.error,
            file: r.file,
            stages: (r.stages || []).length,
            dropped: (r.dropped || []).length,
            missing_citations: r.missingCitations,
            model: r.model,
            // REV-005 边界③：每次花销可见
            usage: r.usage,
            preview: (r.markdown || '').slice(0, 1200),
          }),
        }],
        isError: !r.ok,
      }))
    }

    case 'arch_generate': {
      // 让 agent 直接要点图（0.6.0）。与界面按钮走同一个服务：AI 画 → 审计 → 不过重画 → 降级。
      // ⚠ 这里会真调模型（花钱），所以返回体里必须带 usage —— REV-005 边界③“花销每次可见”。
      const want = String(args.project || '').trim()
      if (!want) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: '要给 project（项目 id 或名字）' }) }], isError: true }
      }
      const view = archForProject(want)
      if (!view.ok || !view.facts) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: view.error || '扫不出可用事实' }) }], isError: true }
      }
      const maxAttempts = Math.min(3, Math.max(1, Number(args.max_attempts) || 2))
      return generateArchGraph(view.facts, { maxAttempts }).then((r) => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            project: view.project ? view.project.id : want,
            source: r.source,
            attempts: r.attempts,
            reason: r.reason || '',
            model: r.model || '',
            usage: r.usage || null,
            graph: {
              title: r.graph.title,
              text: r.graph.text,
              nodes: r.graph.nodes.map((x) => ({ id: x.id, label: x.label, kind: x.kind, files: x.files })),
              edges: r.graph.edges.map((x) => ({ from: x.from, to: x.to, kind: x.kind, count: x.count })),
              missing: r.graph.missing,
            },
            issues: r.audit ? r.audit.issues : [],
            notes: r.audit ? r.audit.notes : [],
            next: r.source === 'ai'
              ? '生成图：每个节点/连线都指回了证据，可以直接用'
              : '降级扫描图：' + (r.reason || '没配模型') + ' —— 想拿生成图，先让用户配好模型再调一次',
          }, null, 2),
        }],
      }))
    }

    case 'intake_task': {
      // 收卡 = 机检 + 落卡。**不阻挡**：机检不过照样建卡，东西不许丢；
      // 区别只在状态（过 → 待审批；不过 → 草稿）与正文里的红标留痕。
      const criteria = Array.isArray(args.criteria) ? args.criteria.map((c: any) => String(c)) : []
      const deliverable = String(args.deliverable ?? '')
      const report = checkIntake(deliverable, criteria)
      const at = new Date().toISOString()
      const status = String(args.force_status || (report.ok ? '待审批' : '草稿'))
      const body = [
        '## 交付物', '',
        deliverable || '（空 —— 交单方没给交付物）', '',
        renderIntakeSection(report, { at, agent: args.agent, model: args.model }),
      ].join('\n')
      const task = tasks.createTask({
        title: args.title,
        status: status as any,
        project: args.project,
        priority: args.priority,
        tags: args.tags,
        body,
      })
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        id: task.id,
        status: task.fm?.status || status,
        intake: {
          ok: report.ok,
          total: report.total,
          passed: report.passed,
          failed: report.failed,
          unknown: report.unknown,
          summary: report.summary,
          redFlags: report.redFlags,
        },
        next: report.ok
          ? '全过 → 落“待审批”，等用户点头转正'
          : '有不过 → 落“草稿”并标红：东西没丢，但判据没过，返工后再交',
      }, null, 2) }] }
    }

    case 'update_task': {
      const task = tasks.updateTask(args.id, args.fields)
      if (!task) return { content: [{ type: 'text', text: `Task not found: ${args.id}` }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: task.id }) }] }
    }
    
    case 'move_status': {
      // 2026-10-30（用户拍板“完成是签字，不是干活”）：
      // agent 最多把卡移到“待验收”；完成 / 驳回是用户的验收签字，硬拒。
      const want = String(args.status || '')
      if (want === '完成' || want === '驳回') {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          error: `“${want}”只能由用户验收裁决：agent 最多移到“待验收”。`,
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
      // 'all' = 活跃 + 归档（与 UI 的“全部”同口径）。此前用的是**私有扫描**，
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

    // ── 只读口（2026-11-08 暮雨拍板）────────────────────────────────────
    case 'decision_list': {
      const all = loadDecisions()
      const wantStatus = String(args.status || '').trim()
        ? normalizeDecisionStatus(String(args.status))
        : ''
      const proj = String(args.project || '').trim()
      const q = String(args.query || '').trim().toLowerCase()
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 30))
      const rows = all
        .filter((d) => !wantStatus || d.状态 === wantStatus)
        .filter((d) => !proj || String(d.项目 || '') === proj)
        .filter((d) => {
          if (!q) return true
          return `${d.内容} ${d.备注} ${d.出处}`.toLowerCase().indexOf(q) >= 0
        })
        .reverse()   // 文件是按时间追加的，倒过来 = 最新的在前
        .slice(0, limit)
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        total: all.length,
        returned: rows.length,
        readOnly: '决策只由用户在界面拍板；本工具只读。要新增，让用户在“需求矩阵”页点。',
        decisions: rows,
      }, null, 2) }] }
    }

    case 'project_charter': {
      const id = String(args.project || '').trim()
      if (!id) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'project 必填' }) }], isError: true }
      const p = getPolicy(id)
      if (!p) {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false, project: id,
          error: '这个项目还没有方针卡（policies/<id>.md 不存在）—— 没有就是没有，不要替它编。',
        }) }], isError: true }
      }
      // 缺哪块**明说**：缺 ≠ 空字符串。
      // ⚠ 两种“看起来有、其实没有”必须算缺，否则 reader 会拿到一段占位符当事实：
      //   ① 空字段在文件里被写成 `（未填写）` 占位；
      //   ② 一键补骨架时结构地图装的是“待填”模板（> 最后核实：（待填…）+ 模块清单：待填）。
      const hasReal = (v: string): boolean => {
        const t = String(v || '').trim()
        if (!t || t === '（未填写）' || t === '(未填写)') return false
        if (t.indexOf('模块清单：待填') >= 0) return false
        return true
      }
      const missing: string[] = []
      if (!hasReal(p.mission)) missing.push('使命')
      if (!hasReal(p.goal)) missing.push('目标')
      if (!hasReal(p.scenario)) missing.push('场景')
      if (!hasReal(p.boundary)) missing.push('边界')
      if (!hasReal(p.structureMap)) missing.push('结构地图')
      // 结构地图的“最后核实”日期要算成天数（2026-11-08 暮雨：“结构地图留，虽然我看不懂有啥用”）。
      // 他不看这块，看的是 agent —— 所以 agent 必须能判断这图**还准不准**：
      // 没写日期，或超过 90 天，一律标 stale，并在 hint 里点名“该核了”。
      const mapText = String(p.structureMap || '')
      const mDate = /最后核实[：:]\s*(\d{4})-(\d{2})-(\d{2})/.exec(mapText)
      let mapAgeDays: number | null = null
      if (mDate) {
        const t = Date.parse(`${mDate[1]}-${mDate[2]}-${mDate[3]}T00:00:00`)
        if (!Number.isNaN(t)) mapAgeDays = Math.floor((Date.now() - t) / 86400000)
      }
      const mapStale = mapAgeDays === null || mapAgeDays > 90
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true, project: id, updatedAt: p.updatedAt || '',
        mission: p.mission || '', goal: p.goal || '', scenario: p.scenario || '',
        boundary: p.boundary || '', structureMap: mapText,
        structureMapVerifiedAt: mDate ? `${mDate[1]}-${mDate[2]}-${mDate[3]}` : '',
        structureMapAgeDays: mapAgeDays,
        structureMapStale: mapStale,
        missingSections: missing,
        hint: missing.length
          ? '缺的这几节是真没写，不是本工具读不到；别根据项目名替它补内容。'
          : (mapStale
            ? '结构地图没有“最后核实”日期，或已超过 90 天 —— 动手前先跟用户核一遍，或照实际代码改它。'
            : '五节齐全，结构地图是近 90 天内核过的。'),
      }, null, 2) }] }
    }

    case 'stage_plan_get': {
      const wantFile = String(args.file || '').trim()
      const wantStage = String(args.stageId || '').trim().toUpperCase()
      if (!wantFile) {
        // 概览：只给“有哪些计划卡、几格、几格还没裁决”，不塞正文（几十格会把 token 烧光）
        const files = listPlanFiles()
        const docs = files.map((f) => {
          const d = readPlan(f)
          if (!d) return { file: f, error: '读不出来（格式可能坏了）' }
          const pending = d.stages.filter((s) => {
            const st = String(s.status || '').trim()
            return st === '待裁决' || st === '待裁决（未冻结）' || st === '未冻结' || !st
          }).length
          const done = d.stages.filter((s) => String(s.status || '').trim() === '完成').length
          return { file: f, title: d.title || '', stages: d.stages.length, pending, done }
        })
        return { content: [{ type: 'text', text: JSON.stringify({
          files: docs.length, plans: docs,
          hint: '要看某一格的 技术方案 / 照抄点 / 判据 → 带 file（+ 可选 stageId）再调一次。',
        }, null, 2) }] }
      }
      const doc = readPlan(wantFile)
      if (!doc) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `读不出来：${wantFile}` }) }], isError: true }
      const stages = wantStage
        ? doc.stages.filter((s) => String(s.id || '').toUpperCase() === wantStage)
        : doc.stages
      if (wantStage && !stages.length) {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false, error: `这张计划卡里没有阶段 ${wantStage}`,
          stages: doc.stages.map((s) => s.id),
        }) }], isError: true }
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true, file: wantFile, title: doc.title || '',
        revision: doc.revision || [],
        stages,
        readOnly: '冻结 / 打回 / 改一句都是用户在界面上点；agent 只读。',
      }, null, 2) }] }
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
        // 主日志 + 附属（2026-10-30 第 4 条）：agent 也要能看见"这一轮还有哪几条并行通道"
        attached: Array.isArray(l.attached) ? l.attached : [],
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
      // 2026-11-08 暮雨第 3 条：“为什么 AI 还在未经我同意的情况下擅自写日志（那些内容本来应该写任务）？”
      // 2026-11-03 的口径早就写在技能卡里（“执行日志是用户自己记上下文的私人笔记，agent 不写”），
      // 但**只在文档里拦不住** —— 工具在，模型就会用。这里改成工具层硬拦：
      // 不带 userAsked: true 一律拒绝，并把 AI 该走的出口直接写在错误里。
      if (args.userAsked !== true) {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          error: '执行日志是用户自己记上下文的私人笔记，AI 不主动写（2026-11-03 用户拍板）。',
          howTo: '干完活的收口动作是 update_task（把做了什么/判据写进卡正文）+ move_status → 待验收。'
            + '只有用户明确说“记一条日志”时，才带 userAsked: true 再调本工具。',
          suggested: ['update_task', 'intake_task', 'move_status'],
        }) }], isError: true }
      }
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
        hint: '后面用 attach_log_files 挂附件；日志只记过程 —— 本轮做完把关联任务移到“待验收”（move_status），完成/驳回由用户点。',
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
      // 2026-11-01 暮雨：“日志有被滥用的迹象……它们不是应该进任务看板的待验收吗？”
      // 对。**签字对象是任务卡，不是日志**：日志只记过程，AI 干完把任务移到“待验收”。
      // 所以 request_close / cancel_close 这套“日志收口”彻底取消；完成/归档/退回仍是用户点。
      if (action === 'request_close' || action === 'cancel_close') {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          error: '日志不再有“等你确认”：收口属于任务卡，不属于日志。'
            + '请用 move_status 把关联任务移到“待验收”，日志只记过程；完成/驳回由用户点。',
          allowed: ['running', 'idle'],
        }) }], isError: true }
      }
      if (action === 'complete' || action === 'archive' || action === 'reopen') {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          error: `“${action}”只能由用户在界面点：完成/归档/退回是签字，不是干活。`
            + 'AI 的收口动作只有一个：move_status 把关联任务移到“待验收”。',
          allowed: ['running', 'idle'],
        }) }], isError: true }
      }
      let r: any
      if (action === 'running') {
        r = logs.setLogRunning(id, true)
      } else if (action === 'idle') {
        r = logs.setLogRunning(id, false)
      } else {
        return { content: [{ type: 'text', text: `Unknown action: ${action} (running | idle)` }], isError: true }
      }
      if (!r || !r.ok) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: r?.error || '状态没改成功' }) }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true, id,
        status: r.data ? logs.logStatusText(r.data) : action,
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

    // ── 多日志一起灌（2026-10-29 暮雨第 6 条：“主日志带多条副日志一起进开工单”）──
    // 真实用法长出来的需求：一条主日志讲这一轮干了什么，另几条是并行通道的进度通知；
    // 只灌主日志，agent 就会漏掉并行的另一半。这里按**给定顺序**拼成一份，主日志在前。
    case 'inject_logs': {
      const ids: string[] = (Array.isArray(args.ids) ? args.ids : []).map((x: any) => String(x || '')).filter(Boolean)
      if (!ids.length) return { content: [{ type: 'text', text: 'ids 不能为空（主日志放第一个）' }], isError: true }
      // 拼接逻辑在 services/logs（与界面“多选 → 开工单”同一份文本，不许两处各拼一次）
      const r = logs.injectLogs(ids)
      if (!r.found.length) return { content: [{ type: 'text', text: `这些日志都不存在：${ids.join(', ')}` }], isError: true }
      return { content: [{ type: 'text', text: r.text }] }
    }

    case 'never_read': {
      // “哪些待办其实没人碰过”—— 只读，不写任何东西。
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
        // “多久没更新”是判断"卡死了"的辅助：从没读过 + 很久没更新 = 大概率没人管
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

    // 2026-10-30（用户拍板“决策是拍板，AI 只能记，不能替你表决”）：
    // `decision_record` 已从 MCP 移除。决策落账只走桌面界面的“需求矩阵”页（rice:decide 是用户点击触发的 IPC），
    // agent 再也不能替用户把某条需求记成“有效 / CUT”。

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }
}
