import { MCPTool, MCPRequest, MCPResponse, MCPToolResult } from './types'
import * as fs from 'fs'
import * as path from 'path'
import { loadTasks, parseRegistry, getDataDir } from '../data'
import * as tasks from '../data/tasks'
import * as services from '../services'
import * as logs from '../services/logs'
import type { Task } from '../data'
import { appendTrace } from '../llm/trace'
import { buildExternalUsageRecord, isUsageReportOk } from '../../shared/usageReport'
import { recordRead, readStats } from './usage'
// 行为审计（2026-11-14 · 卡「拷问 AI」）：纯逻辑在 shared，持久层在 services
import { auditRound, auditReportText, observedFromReadStats } from '../../shared/behaviorAudit'
import { declareWork, claimWork, loadSession, normalizeRefs } from '../services/behaviorAuditStore'
// 收卡机检（ADR-003 一期 · 2026-11-02）：外部 agent 交单时先机检再落卡。
// 四类判据面向**交付物文本**，不起进程（cmd 在这里一律 unknown，跑测试是“待验收”的事）。
import { renderIntakeSection } from '../../shared/intake'
// 存在性检查与报告跑一次都收在 services/intake（tools 里不再写第二份口径）
import { checkIntake } from '../services/intake'
// agent 直接要点架构图（2026-11-02）：与界面按钮同一个服务，不另写一套生成
import { archForProject } from '../services/projectArch'
// 记忆层（2026-11-17）：暮雨「方寸要管记忆，当 DSH 的记忆层」。
// 读口直接读源文件；写口只写 memory/，**永远不碰 task-data/**（塞进去会被 parseTask 当任务卡扫）。
import { searchMemory, readMemory, memoryOverview, memoryBriefing, memoryCore, createMemory, MEMORY_TYPES, MEMORY_CORE_BUDGET, coreBudget, searchLedgers } from '../services/memory'
import { getPref } from '../services/prefs'
import { generatePlanDraft } from '../llm/planDraft'
import { buildPlanDraftInputFromDisk, buildPlanDraftInputFromDiskWithRepo } from '../llm/planDraftInput'
import { gateForDeck } from '../data/qnGate'
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
import {
  loadDecisions, normalizeDecisionStatus, addDecision,
  DECISION_PENDING, AGENT_WRITABLE_DECISION_STATUSES,
} from '../data/decisions'
import { getPolicy, savePolicy } from '../services/policies'
import { applySmapFromTask } from '../services/smapApply'
import { listPlanFiles, readPlan, proposeStage, parkedPlanSummary } from '../data/plans'
// 结构地图“结构大改就过期”（2026-11-08）：判断在 shared，取数在 services
import { structureDrift } from '../services/structureDrift'
// 问卷：agent 侧此前只有「界面里点」，MCP 一个字都读不到也写不进（2026-11-08 补）
import { listDecks, createDeck, convergenceStatus } from '../data/questionnaires'
import { bankStats, nextOpen, importQuestions } from '../data/questionBank'
// 结构地图“提议 → 签字 → 落地”（2026-11-08 暮雨拍板：AI 写进去落一张待审批卡）
import {
  buildSmapProposalBody, smapProposalCriteria,
} from '../../shared/smapProposal'

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

/**
 * 记忆开关（2026-11-20）：缺省开（`!== false`），关掉后 agent 的五个出口都说"已关闭"。
 *
 * ⚠ 只关 agent 的自动读写；记忆页（IPC）照常能用 —— 否则用户想静音只能删数据。
 * ⚠ 读 prefs 失败（纯 Node 测试没有 electron app）按"开"处理，不把测试/启动搞挂。
 */
function memoryOff(): MCPToolResult | null {
  let enabled = true
  try { enabled = getPref('memoryEnabled') !== false } catch { enabled = true }
  if (enabled) return null
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ok: true,
        enabled: false,
        hint: '记忆已关闭（方寸 → 设置 → 通用 → 记忆）。关掉 ≠ 没有记忆：数据还在，记忆页照常可看可管。',
      }, null, 2),
    }],
  }
}

/**
 * 读取单个记忆开关（2026-11-24）。
 *
 * 为什么要有它：`memoryInjectCore` / `memoryBriefing` 这两个子开关
 * **之前在 UI 上存在、后端零消费** —— 用户点掉「按项目开工简报」，什么都没变。
 * 那是本仓最讨厌的那种病：界面说关了，闸门里没关（与 I10「规矩写报告里 ≠ 写闸门里」同一条）。
 *
 * 语义两条（与总开关一致）：
 *  ① **键不存在 = 开**（`!== false`），升级用户第一次打开必须是开的；
 *  ② 读 prefs 失败（纯 Node 测试没有 electron）**按开处理**，不把测试搞挂。
 */
function memorySubPref(key: 'memoryInjectCore' | 'memoryBriefing'): boolean {
  try { return getPref(key) !== false } catch { return true }
}

/** 子开关关掉时的返回体（说清"关了哪个"，不说成"没有记忆"）。 */
function subOff(key: 'memoryInjectCore' | 'memoryBriefing'): MCPToolResult {
  const zh = key === 'memoryInjectCore' ? '开工自动注入核心' : '按项目开工简报'
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ok: true,
        enabled: true,
        subEnabled: false,
        switch: key,
        hint: `「${zh}」这个子开关是关的（方寸 → 设置 → 通用 → 记忆）。关掉 ≠ 没有记忆：数据还在，`
          + '要临时取一次就显式传 force: true；也可去设置里打开它。',
      }, null, 2),
    }],
  }
}

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
        clarify: { type: 'string', description: '澄清问卷卷名：声明了就必须答完并批准，卡才能进「待办」（2026-11-09 硬锁）' },
      },
      required: ['title'],
    },
  },
  {
    name: 'arch_generate',
    description:
      '让方寸给某个已登记项目**生成架构图**（只读扫描，零模型）。'
      + '节点只能来自真实目录 / 入口 / 依赖，连线只能来自真实 import / IPC / 端口计数；'
      + '2026-11-20 D-152 起方寸不再自带模型调用 —— 只出扫描图（`source` 恒为 `scan`），不花 token；'
      + '要 AI 解读请在 DSH 里做。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目 id 或项目名（registry 里登记的）' },
        max_attempts: { type: 'number', description: '已废弃（扫描图一次出）；保留参数仅为兼容旧调用方' },
      },
      required: ['project'],
    },
  },
  {
    name: 'plan_draft',
    description:
      '⚠ 2026-11-20 起 BYOK 已退役：方寸不再自己调模型，本工具保留名称/参数以兼容旧脚本，'
      + '调用会返回「请在 DSH 桌面版里做规划」的提示，不花 token、不写草案。'
      + '规划的正路是「方寸派单 → DSH 里的 agent 做规划」（dispatchToDsh kind=plan）；'
      + 'agent 已经想好草案时用 plan_submit（只跑闸，不调模型）。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目 id（如 fangcun-base）' },
        deck: { type: 'string', description: '澄清问卷卷名（必须先答完并批准；没带 = 拒，零写入）' },
        max_open: { type: 'number', description: '未结卡最多带几张正文（默认 24，上限 60）' },
        max_done: { type: 'number', description: '已完成卡最多列几张标题（默认 8，上限 40）' },
      },
      required: ['project'],
    },
  },
  {
    name: 'plan_submit',
    description:
      'agent 当大脑、方寸当闸（2026-11-10，暮雨拍板方向）：agent 自己把草案想好，'
      + '把 JSON 交给方寸，方寸跑**同一套闸**（宪法页 / 本轮先问 / 判据现状体检 / 依据必须真实）再落 plans/_drafts。'
      + '**不调模型、不花 token、秒回**。JSON 形状与 plan_draft 要求完全一致：'
      + '{"constitution":[{kind,text,cites}],"asks":[{ask,why}],"asksNote":"","stages":[{id,title,what,approach,copy,criteria,cites}]}。'
      + '没带卷 / 卷没答完 / 宪法缺失 / 判据现状已满足 → 拒（零写入）。'
      // 2026-11-17 暮雨定案：「规划功能几乎要全部重做……以后可以直接在 DSH 里派活做规划」。
      // 本工具**保留可用**（暮雨：「所有功能都要」），但**不再是规划的正路**。
      + '\n\n⚠ 2026-11-17 起：这不是规划的正路。正路 = 写一份 `kind=plan` 的派单交给 DSH 里的 agent'
      + '（方寸：dispatchToDsh(project, "plan")）；规划在那边做，方寸只负责打包项目现实 + 事后机检 + 记账。'
      + '本工具保留可用，但那套「宪法页 + 七道并列否决」正在重做，对新项目大概率会被「必须先有已批准问卷」直接拒。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目 id（如 fangcun-base）' },
        deck: { type: 'string', description: '澄清问卷卷名（必须先答完并批准；没带 = 拒）' },
        draft: {
          type: 'object',
          description: '草案 JSON（constitution / asks / asksNote / stages），形状同 plan_draft 的输出要求',
        },
        max_open: { type: 'number', description: '组装证据时未结卡最多带几张正文（默认 24）' },
        max_done: { type: 'number', description: '已完成卡最多列几张标题（默认 8）' },
      },
      required: ['project', 'deck', 'draft'],
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
        taskId: {
          type: 'string',
          description: '关联的任务卡 id：卡上 `拍板: D-xxx` 的旧拍板会自动变成“交付物必须回应”的判据',
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
      + 'Currency must be CNY (no FX conversion). At least one token field or cost is required. '
      // 2026-11-08：card 之前**只认不宣**（buildExternalUsageRecord 支持 card 字段与 note 里的
      // card=xxx，但 schema 里没声明）→ 模型看不到这个参数，就不会传。
      // 实测 217 条外部调用只有 4 条带 card（1.8%），于是 99% 的 token 归不到任何一张卡。
      + 'ALWAYS pass `card` (the task id you are working on) — without it the tokens are booked as (未归因) '
      + 'and nobody can tell what they paid for.',
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
        card: { type: 'string', description: 'Task id this call was made for (e.g. task-20261107-004). Pass it — otherwise booked as (未归因).' },
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
  //
  // 2026-11-24 补上了——那个"只落待审批"的设计就是下面这张 `decision_propose`
  // （2026-11-23 问卷 K1 拍板：「决策应该有自己的审批入口」）：
  //   · agent 只能写「待审批」，转正是用户点的（它传「有效」会被拒，不是被悄悄改）；
  //   · 待审批不进 agent 开工读到的"最近有效决策"，读不到未批准的规矩比读到假规矩安全。
  {
    name: 'decision_list',
    description: 'READ-ONLY. Read 决策卡 (task-data/decisions.md): what has already been decided, '
      + 'when, by which project, and whether it still holds (待审批/有效/已撤销/已合并). '
      + 'Check this BEFORE proposing something that may contradict an earlier decision. '
      + 'To record a NEW decision use `decision_propose` — it lands as 待审批 and only the user can approve it.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Filter by project id (optional)' },
        status: { type: 'string', description: '待审批 | 有效 | 已撤销 | 已合并（可选，旧词会归一）' },
        query: { type: 'string', description: 'Match 内容 / 备注 / 出处 (optional)' },
        limit: { type: 'number', description: 'Max rows, newest first (default 30)' },
      },
    },
  },
  // 2026-11-24（2026-11-23 问卷 K1 拍板：「审批就不该走任务卡……决策应该有自己的审批入口」）
  {
    name: 'decision_propose',
    description: 'PROPOSE a decision (决策卡). It ALWAYS lands as 状态: 待审批 — the user approves it in the '
      + '决策 page before it counts. You cannot make a decision effective: passing 有效 is refused, not silently '
      + 'downgraded. Pending decisions are NOT returned to agents by decision_list/context packs, because an '
      + 'unapproved rule must never be read as a current one. One decision per call; if one already exists with '
      + 'the same content on the same date, nothing is written (deduped).',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What was decided, one sentence.' },
        source: { type: 'string', description: 'Where it came from: which conversation / deck / evidence (required).' },
        project: { type: 'string', description: 'Project id, or 全局 (optional).' },
        scope: { type: 'string', description: '生效范围: 本卷 / 全局 / a project id (optional).' },
        landing: { type: 'string', description: '落地: task id / commit:xxx / 不做(理由) (optional).' },
        agent: { type: 'string', description: 'Who proposes (agent name, optional).' },
      },
      required: ['content', 'source'],
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
    name: 'memory_search',
    description: 'READ-ONLY. Search 方寸记忆 (memory/*.md): past incidents, lessons and cross-project 纪律. '
      + 'It answers "what happened / which rule was bought with a real loss / which applies across projects", '
      + 'NOT "what to do next" (that is a task card). Results are ranked by relevance × confidence × importance '
      + '× freshness × usage, and each row carries only the one-line claim (never the full evidence) — '
      + 'use memory_read for the verbatim evidence. Revoked entries are excluded unless includeRevoked is true; '
      + 'pending agent proposals are excluded unless includePending is true (they are not effective yet).',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Full-text keyword; ranked over claim / tags / evidence, and the id (e.g. D5)' },
        type: { type: 'string', description: `One of: ${MEMORY_TYPES.join(' / ')}` },
        scope: { type: 'string', description: '适用范围, e.g. 跨项目' },
        project: { type: 'string', description: 'Project id, e.g. dsh-fangcun' },
        includeRevoked: { type: 'boolean', description: 'Include 已撤销 entries (default false)' },
        includePending: { type: 'boolean', description: 'Include 待审批 agent proposals (default false)' },
        includeLedgers: {
          type: 'boolean',
          description: 'Also search the four LEDGERS (155 决策 / 365 日志 / 384 任务卡 / 17 方针) — '
            + 'returns POINTERS (srcPath + title + summary), never the source text. '
            + 'Use it for "did we ever decide / write / do X" — the claim store only holds hand-written lessons.',
        },
        ledgerKind: { type: 'string', description: 'With includeLedgers: decision / log / card / charter' },
        limit: { type: 'integer', description: 'Max rows (default 10, max 50) — each row is a one-line claim + metadata, never the full evidence' },
      },
    },
  },
  {
    name: 'memory_read',
    description: 'READ-ONLY. Read one memory entry by its `file` path from memory_search '
      + '(e.g. memory/claims/xxx.md). Refuses any path outside memory/. Returns the verbatim evidence; '
      + 'pass `anchor` (e.g. "D5") to read only that section of a long evidence file — '
      + 'a missing anchor is an error, never a silent full-file dump.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Relative path from memory_search, e.g. memory/claims/x.md' },
        maxChars: {
          type: 'integer',
          description: 'Max characters returned (default 8000, max 200000). Truncation is reported, never silent.',
        },
        anchor: {
          type: 'string',
          description: 'Optional section heading inside the evidence file, e.g. D5 or 事故经过; not found → error.',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'memory_core',
    description: 'READ-ONLY. Fixed core memory (memory/core.md): the small, generated block of pinned claims '
      + 'that is safe to inject into every session (hard cap 800 chars). Full evidence is NEVER injected; use '
      + 'memory_search / memory_read on demand. This is the only memory content fangcun_context auto-injects — '
      + 'a generated core, not a dynamic top-N of all memories. If the memory switch is off, it returns '
      + 'enabled:false with a clear hint instead of pretending the core is missing.',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: 'Return the core even if the 「开工自动注入核心」 sub-switch is off '
            + '(use for a one-off read the user explicitly asked for). Default false.',
        },
      },
    },
  },
  {
    name: 'memory_write',
    description: 'PROPOSE a 方寸 memory entry for user approval. Writes ONLY under memory/ and ALWAYS lands as '
      + '状态: 待审批 — the user must approve it in the 记忆 page; you cannot make it effective, and default '
      + 'memory_search will not return it. Use when the user explicitly asks to record an incident/lesson, '
      + 'or when a lesson was bought with a real loss. One memory = one claim (1–2 sentences, ≤200 chars) '
      + 'plus verbatim evidence; never summarize away the details. `claim`+`evidence` are the v2 fields; '
      + '`title`/`body` are accepted as legacy aliases. Only one entry per claim — if a similar one exists, '
      + 'report it to the user instead of duplicating.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...MEMORY_TYPES], description: '事故 / 教训 / 纪律 / 决定 / 偏好 / 事实' },
        claim: { type: 'string', description: 'One-sentence memory (≤200 chars, ideally ≤120) — the only text that gets recalled. One claim per entry.' },
        evidence: { type: 'string', description: 'Verbatim original text / verified facts. Required (or pass legacy `body`); do not summarize.' },
        source: { type: 'string', description: 'Where it came from: user quote / incident / file path. Required — untraceable memory is rumor.' },
        confidence: { type: 'number', description: '0–1; agent proposals are capped at 0.8. Default 0.7.' },
        importance: { type: 'integer', description: '1–5; 5 = irreversible loss / safety. Default 3.' },
        project: { type: 'string', description: 'Project id, or 跨项目 (default: empty = cross-project-ish)' },
        scope: { type: 'string', description: '适用范围, e.g. 跨项目' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
        pinned: { type: 'boolean', description: 'Pin into the generated core (only a few; ≤8).' },
        supersedes: { type: 'string', description: 'Optional id of the memory this one replaces; on approval the old one becomes 已撤销 + 被取代.' },
        evidencePath: { type: 'string', description: 'Optional pointer to a long evidence file under memory/ (e.g. memory/lessons/施工纪律-跨项目.md).' },
        evidenceAnchor: { type: 'string', description: 'Optional section heading in that evidence file (e.g. D5).' },
        title: { type: 'string', description: 'Legacy alias for `claim` (deprecated).' },
        body: { type: 'string', description: 'Legacy alias for `evidence` (deprecated).' },
        impact: { type: 'string', description: 'Legacy label 严重/高/中/低 (prefer numeric `importance`).' },
      },
      required: ['type', 'source'],
    },
  },
  {
    name: 'memory_briefing',
    description: 'READ-ONLY. Bounded briefing of EFFECTIVE memories relevant to one project: entries whose '
      + '`项目` is that project or 跨项目, ranked by importance / freshness / usage. Pending agent proposals '
      + 'and revoked entries are excluded. Returns one-line claims + metadata only — use memory_read for the '
      + 'verbatim evidence. Call it before starting work on a project; it is how past incidents/lessons enter '
      + 'the current context (default 5 claims, ≤800 chars).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id, e.g. fangcun-base' },
        limit: { type: 'integer', description: 'Max rows (default 5, max 20)' },
        force: {
          type: 'boolean',
          description: 'Return the briefing even if the 「按项目开工简报」 sub-switch is off. Default false.',
        },
      },
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
  {
    name: 'stage_plan_propose',
    description: 'Propose a NEW stage card into task-data/plans/<file>.md. It lands as 状态: 待裁决 — '
      + 'the user freezes it with one click in 作战计划 (通过/冻结), so you cannot self-approve. '
      + 'ALL THREE blocks are mandatory (技术方案 / 照抄点 / 判据) — a card missing one can never be frozen. '
      + 'Every 判据 line MUST start with cmd: / str: / num: / file:, otherwise the gate treats it as unknown forever. '
      + 'Refuses to overwrite an existing stage id.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Plan file name, e.g. fangcun-base.md' },
        project: { type: 'string', description: 'Alternative to file: project id (= <project>.md)' },
        deck: { type: 'string', description: '澄清问卷卷名（必须先答完并批准；没带 = 拒，零写入）' },
        stageId: { type: 'string', description: 'P8 — omit for the next free number' },
        title: { type: 'string', description: 'What this stage delivers (one line)' },
        what: { type: 'string', description: 'One-sentence scope (optional)' },
        approach: { type: 'array', items: { type: 'string' }, description: '技术方案 bullets: how you plan to do it' },
        copyRows: {
          type: 'array',
          description: '照抄点 table rows: [["项","来源","原文"], [...]]. First row may be the header.',
          items: { type: 'array', items: { type: 'string' } },
        },
        criteria: {
          type: 'array', items: { type: 'string' },
          description: '判据 bullets, each prefixed cmd: / str: / num: / file:',
        },
        agent: { type: 'string', description: 'Who proposes (agent name)' },
      },
      required: ['title', 'approach', 'copyRows', 'criteria'],
    },
  },
  // ── 问卷：agent 出卷 → 用户在问卷页答 → 批准才落决策卡（2026-11-08）────────
  {
    name: 'qn_list',
    description: 'List questionnaires (问卷) with how many questions, how many already answered, '
      + 'and whether each was approved — plus the project 题库 progress (answered / open / blacklist) '
      + 'and the NEXT batch of open questions (≤6) to put into a deck. '
      + 'Call this before asking the user anything in chat: an open questionnaire is where his decisions belong.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id — limits the 题库 progress + next batch to it (optional)' },
        batch: { type: 'number', description: 'How many open questions to return in `next` (default 6, max 20)' },
      },
    },
  },
  {
    name: 'qn_bank_import',
    description: 'Bulk-load questions into the project 题库 as 待答 (the queue). '
      + 'This is how a few hundred questions get in at once (e.g. distilled from the user 骂过 whats, legacy decks). '
      + 'Idempotent by question fingerprint: an already-answered / 否决 / 你自判 question is REFUSED and reported in `conflicts` — '
      + 'it never overwrites an answer. 作废 questions are re-queued. Nothing else is written.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id these questions belong to (omit for global)' },
        source: { type: 'string', description: 'Where they came from, e.g. 2026-11-08 会话第 3 轮 / 四卷档案恢复' },
        questions: {
          type: 'array',
          description: 'Questions to queue',
          items: {
            type: 'object',
            properties: {
              ask: { type: 'string', description: 'The question itself (one sentence)' },
              line: { type: 'string', description: '验收线 — what would prove this answer was violated (recommended)' },
            },
            required: ['ask'],
          },
        },
      },
      required: ['questions'],
    },
  },
  {
    name: 'qn_propose',
    description: 'Write a NEW questionnaire deck (task-data/questionnaires/<deck>.md) for the user to answer. '
      + 'Hard checks, nothing is written unless all pass: every question needs an id like S1, at least 2 options, '
      + 'every option needs a COST description (d), and every question needs a 验收线 (line). '
      + 'It never overwrites an existing deck — pick another deck name for a revision. '
      + 'This only asks questions; it writes no decision and no task card.',
    inputSchema: {
      type: 'object',
      properties: {
        deck: { type: 'string', description: 'File stem, e.g. 方寸-0.7-取舍 (omit to derive from title)' },
        title: { type: 'string', description: 'Deck title; include 宪法层 / 裁决层 to tag the layer' },
        project: { type: 'string', description: 'Project id this deck is about (optional)' },
        boundary: { type: 'string', description: '使用边界 sentence for the deck (optional)' },
        questions: {
          type: 'array',
          description: 'Questions in order',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'S1 / M2 — letter(s) + digits, unique' },
              nav: { type: 'string', description: 'Short nav name shown in the left column' },
              ask: { type: 'string', description: 'The question itself' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    k: { type: 'string', description: 'A / B / C' },
                    t: { type: 'string', description: 'Option title' },
                    d: { type: 'string', description: 'What it is + what it costs (required)' },
                  },
                  required: ['k', 't', 'd'],
                },
              },
              look: { type: 'string', description: '【看一眼】reference / entry point (optional)' },
              src: { type: 'string', description: '【出处】where the evidence comes from (optional)' },
              line: { type: 'string', description: '【验收线】what counts as a violation after choosing (required)' },
            },
            required: ['id', 'options', 'line'],
          },
        },
      },
      required: ['title', 'questions'],
    },
  },
  // ── 结构地图：提议 → 用户签字 → 落地（2026-11-08 暮雨拍板）─────────────────
  // “AI 写进去落一张待审批卡”。两条硬边界：
  //   ① `smap_propose` **不写** policies —— 只落一张待审批卡；
  //   ② `smap_apply` 只认**状态=完成**的卡（那是用户的签字），没签字一个字节都不动。
  {
    name: 'smap_propose',
    description: 'Propose a NEW version of the project 结构地图 as a 「待审批」 task card. '
      + 'This does NOT touch policies/<project>.md — it only creates a card for the user to approve. '
      + 'mapText MUST contain a 最后核实：YYYY-MM-DD line (otherwise it is a map nobody can trust). '
      + 'Put what you actually scanned in `reason`.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id, e.g. fangcun-base' },
        mapText: { type: 'string', description: 'New 结构地图 body: 最后核实：YYYY-MM-DD + 模块清单 + 主数据流' },
        reason: { type: 'string', description: 'Why it differs — what you scanned (files/dirs). Empty = the user has to guess, and it will be rejected.' },
        agent: { type: 'string', description: 'Who proposes (agent name)' },
      },
      required: ['project', 'mapText'],
    },
  },
  {
    name: 'smap_apply',
    description: 'Apply an APPROVED 结构地图 proposal card into policies/<project>.md. '
      + 'Hard gate: the card status MUST be 完成 (= the user signed it). Anything else is refused. '
      + 'Backs up the current policy first and reads it back to prove the write landed.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The proposal task id (must be in 完成)' },
      },
      required: ['taskId'],
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
  // ── 日志写口：agent 零写权限（2026-11-19 暮雨拍板）────────────────────
  // 原话：「AI 自动写日志我记得已经禁了（因为很乱，日志本来就是用户自己存上下文的地方，
  //        AI 自己写让人搞不懂哪些没做）」。
  // 查实三处漏：① create_log 的 `userAsked` 是模型自己填的，闸只证明了"模型说用户同意"；
  // ② update_log 当时没有任何闸（6dzpgc 就是 05:07 被它从 3.6K 改成 17K 的）；
  // ③ 05:18 的 4pxuly 连 create_log 审计都没有 —— 走的是 CLI 旁路。
  // 所以 agent 面**不再提供任何日志写工具**（建 / 改 / 状态 / 挂附件全部移除），
  // 只保留读：list_logs / search_logs / get_log / inject_logs。
  // 写入只允许在方寸界面（logs:create / update / complete / archive / destroy）。
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
    name: 'app_mode',
    description:
      '当前运行态：客户端态（成品，数据在 userData）还是开发态（源码仓库），以及判断依据。'
      + '客户端态下**没有**改源码的入口（MCP 层零文件写工具）—— 改源码必须由人切到开发态。',
    inputSchema: { type: 'object', properties: {} },
  },
  // ── 使命草稿（2026-11-14 · 长 Loop P1-2）：从项目 README 起草，人点头才写 ───────
  {
    name: 'mission_draft',
    description:
      '从项目仓库的 README 起草「使命」建议 —— 那些使命空着的项目，README 里往往已经写清了它是干嘛的。'
      + '⚠ 只是**草稿**，不自动写：使命是"你对这个项目的定义"，不是仓库的。'
      + '⚠ 草稿**逐字来自 README**（不改写、不润色），并带上原文供核对；抽不出就明说原因，不糊一条凑数。'
      + '已经写了使命的项目不会被建议覆盖。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '只给某一个项目起草；不填则所有使命为空的' },
      },
    },
  },
  {
    name: 'audit_declare',
    description:
      '开工前声明：这轮打算读哪些卡 / 文件、改哪些东西。写进一份**旁路**日志（不动任务卡）。'
      + '交付时用 audit_check 核对"声明 vs 实际"，能抓出"嘴上说读了、其实没读"。'
      + '⚠ 这不是绩效考核，是让你自己少挨骂：把"我本来该看什么"先列出来，比事后被指出"没读设定"便宜得多。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '本轮会话 id（DSH/Hermes 的 session id）；不填则按 default 记' },
        project: { type: 'string', description: '项目 id（可选）' },
        plan: {
          type: 'array',
          description: '这轮要读/要做的东西。每项 {kind,id} 或直接写 id（默认 kind=task）',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', description: 'task / file / cmd / ipc …（开放，不锁死）' },
              id: { type: 'string', description: '卡 id / 文件相对路径 / 命令名' },
            },
            required: ['id'],
          },
        },
      },
      required: ['plan'],
    },
  },
  {
    name: 'audit_check',
    description:
      '交付时核对：把这轮**实际做了什么**报上来，方寸拿它跟开工声明、以及 MCP 侧客观读记录对账。'
      + '三类问题会被点出来：①声称读了但无痕迹 ②声明了没做也没解释 ③动了声明范围外的东西。'
      + '⚠ 只审行为（读没读/做没做），**不评判质量** —— 质量裁决会死循环，这里不做。'
      + '⚠ 文件级读取 MCP 看不见（发生在 client 侧）：所以 file:* 只跟你的声明/自报对账，'
      + '不会被判成"没读"。真正有客观记录的是 task:*。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '本轮会话 id（要跟 audit_declare 用同一个）' },
        did: {
          type: 'array',
          description: '这轮实际读了/做了什么。每项 {kind,id} 或直接写 id（默认 kind=task）',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string' },
              id: { type: 'string' },
            },
            required: ['id'],
          },
        },
      },
      required: ['did'],
    },
  },
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

import { checkMcpWrite, recordWrite, summarizeArgs } from './writeGate'
// 运行态（2026-11-11 卡 20261017-002）：让 agent 一进门就知道自己在成品态还是开发态
import { detectAppMode, MCP_CODE_WRITE_TOOLS } from '../services/appMode'

export interface ToolCallContext {
  /** MCP 客户端名（socket-server 从 initialize 的 clientInfo 取） */
  client?: string
}

/** 审计用的一句话摘要：从结果 JSON 里抠“落下了什么”，抠不到就空 */
function resultDigest(out: MCPToolResult): string {
  try {
    const text = String((out && out.content && out.content[0] && (out.content[0] as any).text) || '')
    if (!text || text[0] !== '{') return ''
    const o = JSON.parse(text)
    if (o && typeof o === 'object') {
      if (typeof o.id === 'string' && o.id) return `id=${o.id}`
      if (typeof o.status === 'string' && o.status) return `status=${o.status}`
      if (typeof o.ok === 'boolean') return `ok=${o.ok}`
    }
  } catch { /* 非 JSON 结果：不记摘要 */ }
  return ''
}

/**
 * MCP 工具入口 —— **写口闸与写侧留痕的唯一落点**（2026-11-11 卡《MCP 写口无闸》）。
 *
 * 顺序：① 判档位（read 一律放行；写/破坏性看 prefs 里的档位）→ ② 被拒也要留痕
 *      → ③ 真正的业务分支 `handleToolCallInner` → ④ 写成功/失败各记一行。
 * 为什么包在入口：12 个写工具散着各判一遍，迟早漏一个；新增工具只要在 writeGate 里登记档位。
 */
export function handleMCPToolCall(name: string, args: any, ctx?: ToolCallContext): MCPToolResult | Promise<MCPToolResult> {
  const client = String(ctx?.client || 'unknown')
  const decision = checkMcpWrite(name, args)
  if (!decision.ok) {
    recordWrite({
      via: name, tier: decision.tier, client, ok: false,
      error: decision.error, args: summarizeArgs(name, args),
    })
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: decision.error }) }], isError: true }
  }
  const audited = decision.tier !== 'read'
  const audit = (ok: boolean, detail?: { error?: string; result?: string }) => {
    if (!audited) return
    recordWrite({
      via: name, tier: decision.tier, client, ok,
      error: detail?.error, result: detail?.result,
      args: summarizeArgs(name, args),
    })
  }

  // handleToolCallInner **是同步函数**（只有 plan_draft / plan_submit 两个分支内部返回 Promise）。
  // 所以这里两条路径都要在：同步工具走下面那段，异步分支走 thenable 那段。
  let out: MCPToolResult | Promise<MCPToolResult>
  try {
    out = handleToolCallInner(name, args)
  } catch (e: any) {
    const msg = String(e?.message || e)
    audit(false, { error: msg })
    return { content: [{ type: 'text', text: `方寸内部错误：${msg}` }], isError: true }
  }
  if (out && typeof (out as any).then === 'function') {
    return Promise.resolve(out).then(
      (r) => { audit(!(r && (r as any).isError), { error: (r && (r as any).isError) ? String(((r as any).content?.[0] as any)?.text || '').slice(0, 200) : undefined, result: resultDigest(r) }); return r },
      (e) => {
        const msg = String(e?.message || e)
        audit(false, { error: msg })
        return { content: [{ type: 'text', text: `方寸内部错误：${msg}` }], isError: true } as MCPToolResult
      },
    )
  }
  audit(!(out && (out as any).isError), {
    error: (out && (out as any).isError) ? String(((out as any).content?.[0] as any)?.text || '').slice(0, 200) : undefined,
    result: resultDigest(out as MCPToolResult),
  })
  return out
}

/**
 * 工具分发主体。
 *
 * ⚠ **必须保持同步签名**（2026-11-14 踩过一次，别重犯）：
 *   有两个分支（`plan_draft` / `plan_submit`）要**真去读项目仓库**（P2-3），读仓库是异步的。
 *   第一版我把整个函数改成 `async` —— 结果**所有**工具都开始返回 Promise，
 *   而 `e2e-mcp-context` 这类同步消费方（`call('decision_list')` 直接读 `.decisions`）
 *   当场全红：这是**对外契约被顺手改掉**，不是测试写死。
 *   正解：函数保持同步，**只有需要异步的那两个分支**返回 Promise（内部用 async IIFE）。
 *   `handleMCPToolCall` 本来就同时接受两种返回值，所以调用方零改动。
 */
function handleToolCallInner(name: string, args: any): MCPToolResult | Promise<MCPToolResult> {
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
      try {
        const task = tasks.createTask({
          title: args.title,
          status: args.status,
          project: args.project,
          priority: args.priority,
          tags: args.tags,
          body: args.body,
          clarify: args.clarify,
        })
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: task.id }) }] }
      } catch (e: any) {
        // 进队列闸会在这里抛（声明了澄清卷但没过）—— 原样回，别让 agent 以为是内部错误
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e?.message || e) }) }], isError: true }
      }
    }
    
    case 'plan_draft': {
      // 让方寸给自己起草一份计划（2026-11-02）。此前 generatePlanDraft 没有任何调用方 ——
      // 生成器写好了两个月，方寸从没真的规划过自己。
      // 输入 = 该项目未结卡的【方案 + 结果记录原文】+ 已完成卡标题；输出落 plans/_drafts，状态恒“待裁决”。
      const proj = String(args.project || '').trim()
      if (!proj) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: '要给 project（项目 id）' }) }], isError: true }
      }
      // 硬闸（2026-11-09）：没附澄清问卷 / 卷没答完 / 全是否决作废 → 连模型都不调，零写入。
      const gate = gateForDeck(String(args.deck || ''), proj)
      if (!gate.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false, error: gate.error, gate,
          hint: '先用 qn_propose 出卷 → 等用户答完并批准 → 再带 deck 调 plan_draft。没问过就出计划 = 把猜测当结论。',
        }, null, 2) }], isError: true }
      }
      // 2026-11-14 · P2-3：plan_draft（BYOK 那条）同样**真读项目仓库**。
      // 两条出计划的通道必须读同一份现实 —— 否则 agent 交的草案和方寸自己出的草案
      // 依据不同，用户看到两份互相对不上的计划。
      // ⚠ 用 async IIFE 返回 Promise，**不要让整个分发函数变 async**（见函数头注释）。
      return (async () => {
        const input = await buildPlanDraftInputFromDiskWithRepo({
          project: proj,
          maxOpen: Math.min(60, Math.max(1, Number(args.max_open) || 24)),
          maxDone: Math.min(40, Math.max(0, Number(args.max_done) || 8)),
        })
        const r = await generatePlanDraft(input)
        return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: r.ok,
            error: r.error,
            file: r.file,
            stages: (r.stages || []).length,
            // 2026-11-10：宪法页 + 本轮要先问的问题 —— 没有这两样整份不合格（H2 / V1 的机器版）
            constitution: (r.constitution || []).length,
            asks: (r.asks || []).map((a) => a.ask),
            asks_note: r.asksNote || '',
            already_green: r.alreadyGreen || 0,
            dropped: (r.dropped || []).length,
            missing_citations: r.missingCitations,
            model: r.model,
            // REV-005 边界③：每次花销可见
            usage: r.usage,
            preview: (r.markdown || '').slice(0, 1200),
          }),
        }],
        isError: !r.ok,
      }
      })()
    }

    case 'plan_submit': {
      // 2026-11-10 暮雨拍板方向：**agent 当大脑、方寸当闸**。
      // 方寸自己调 BYOK 一次要 115s（思考 2.5 万字符）、比 agent 侧 RPC 超时还长，
      // 而且同一件事要付两遍钱。这条通道让 agent 把想好的草案交进来，
      // 方寸只跑闸（宪法页 / 本轮先问 / 判据现状体检 / 依据真实）—— 不调模型、秒回。
      const proj = String(args.project || '').trim()
      if (!proj) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: '要给 project（项目 id）' }) }], isError: true }
      }
      const deck = String(args.deck || '').trim()
      const gate = gateForDeck(deck, proj)
      if (!gate.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false, error: gate.error, gate,
          hint: '先出卷 → 等用户答完并批准 → 再带 deck 提交草案。没问过就出计划 = 把猜测当结论。',
          // 2026-11-17：被这道闸拦下的人/agent 十有八九不是"忘了出卷"，
          // 而是"这个项目根本没有卷"。把那时的正路直接给他，别让他去建一份只为过关的卷。
          maybeNoDeck: '若这个项目本来就没有（也不该有）澄清问卷 —— 那说明该走**派单**那条路：',
          howToPlanNow: `方寸派单：dispatchToDsh("${proj}", "plan") → DSH 里开一个规划会话，`
            + '规划在那边做（它能直接读仓库），方寸只负责打包项目现实 + 事后按判据机检 + 记账。'
            + '这条正路**不需要任何问卷**。',
        }, null, 2) }], isError: true }
      }
      let payload: any = args.draft
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload) } catch (e: any) {
          return { content: [{ type: 'text', text: JSON.stringify({
            ok: false, error: `draft 不是合法 JSON：${e?.message || e}`,
          }) }], isError: true }
        }
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'draft 必须是一个对象' }) }], isError: true }
      }
      // 2026-11-14 · P2-3：**真去读项目仓库**（README / ROADMAP / 最近动过 docs 的提交）。
      // 此前计划器只读方寸自己的账本 —— 「规划」退化成从卡标题猜方向。
      // ⚠ 同样用 async IIFE，别让整个分发函数变 async（见函数头注释）。
      return (async () => {
        const input = await buildPlanDraftInputFromDiskWithRepo({
          project: proj,
          maxOpen: Math.min(60, Math.max(1, Number(args.max_open) || 24)),
          maxDone: Math.min(40, Math.max(0, Number(args.max_done) || 8)),
        })
        // 把 agent 想好的 JSON 灌进**同一条管道** —— 之后所有闸与 plan_draft 一模一样。
        const r = await generatePlanDraft(input, {
          callLlm: async () => ({ text: JSON.stringify(payload), model: 'agent', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
        })
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: r.ok,
              error: r.error,
              file: r.file,
              stages: (r.stages || []).length,
              constitution: (r.constitution || []).length,
              asks: (r.asks || []).map((a) => a.ask),
              asks_note: r.asksNote || '',
              already_green: r.alreadyGreen || 0,
              dropped: (r.dropped || []).length,
              missing_citations: r.missingCitations,
              model: 'agent',
              preview: (r.markdown || '').slice(0, 1200),
            }),
          }],
          isError: !r.ok,
        }
      })()
    }

    case 'arch_generate': {
      // 2026-11-20 D-152：只出扫描图，不再调模型（不产生 usage）。
      // 要 AI 解读走 DSH；这里只把真实目录/import 摊开。
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
            next: '扫描图（零模型）：节点/连线全部来自真实目录与 import；要 AI 解读请在 DSH 里做',
          }, null, 2),
        }],
      }))
    }

    case 'intake_task': {
      // 收卡 = 机检 + 落卡。**不阻挡**：机检不过照样建卡，东西不许丢；
      // 区别只在状态（过 → 待审批；不过 → 草稿）与正文里的红标留痕。
      const criteria: string[] = Array.isArray(args.criteria) ? args.criteria.map((c: any) => String(c)) : []
      // 必读闸（2026-11-09）：卡上写了 `拍板: D-xxx`（或 `相关旧拍板:`），交付物就必须出现这个 id。
      // 这是“用输出引用旧拍板当读没读”的机器版 —— 没提或唱反调 = 没读，机检直接红。
      const taskId = String(args.taskId || '').trim()
      // 必读闸「没加成」也要说出来（2026-11-11 评审抓到）：此前 taskId 找不到卡 / 卡上没有
      // `拍板:` 都是静默跳过 —— agent 以为过了必读闸，其实一条判据都没加。
      const intakeNotes: string[] = []
      if (taskId) {
        const card: any = (loadTasks('all') as any[]).find((t) => String(t?.id) === taskId)
        if (!card) {
          intakeNotes.push(`taskId「${taskId}」找不到 —— 没加任何“必读旧拍板”判据（本次交单必有读闸不生效）`)
        } else {
          const text = String(card.body || '')
          const ids: string[] = []
          const re = /(?:拍板|相关旧拍板)[：:]\s*([^\n]+)/g
          let m: RegExpExecArray | null
          while ((m = re.exec(text)) !== null) {
            for (const id of (m[1].match(/D-\d+/g) || [])) if (!ids.includes(id)) ids.push(id)
          }
          for (const id of ids) if (!criteria.some((c) => c.includes(id))) criteria.push(`str: ${id}`)
          if (!ids.length) intakeNotes.push('这张卡上没有 `拍板:` / `相关旧拍板:` —— 没加必读判据（没有旧拍板可读，属正常）')
        }
      }
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
        // 必读闸“没加成”的原因（空数组 = 正常）。不阻挡交单，但必须可见。
        notes: intakeNotes,
        next: report.ok
          ? '全过 → 落“待审批”，等用户点头转正'
          : '有不过 → 落“草稿”并标红：东西没丢，但判据没过，返工后再交',
      }, null, 2) }] }
    }

    case 'update_task': {
      // 进队列闸（2026-11-11）：状态要变「待办」时数据层会抛 —— 必须原样回给 agent，
      // 不能让它只看到一句 "内部错误"（那样它只会换个工具再试一次）。
      try {
        const task = tasks.updateTask(args.id, args.fields)
        if (!task) return { content: [{ type: 'text', text: `Task not found: ${args.id}` }], isError: true }
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: task.id }) }] }
      } catch (e: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e?.message || e) }) }], isError: true }
      }
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
      try {
        const task = tasks.moveStatus(args.id, args.status)
        if (!task) return { content: [{ type: 'text', text: `Task not found: ${args.id}` }], isError: true }
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: task.id, status: args.status }) }] }
      } catch (e: any) {
        // 进队列闸 / 乐观锁冲突都从这里出去，带原文（agent 要能照着补）
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e?.message || e) }) }], isError: true }
      }
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

    case 'mission_draft': {
      // 2026-11-14 · 长 Loop P1-2：7 个项目的使命是空的，但其中 6 个的 README
      // 已经写清了它是干嘛的 —— 病根不是"没人知道"，是"方寸从没去读项目现实"。
      // 这个工具把 README 里那句话捞出来当**草稿**，人来点头才写进方针卡。
      const { draftMissions } = require('../../shared/missionDraft')
      const { getPolicy } = require('../services/policies')
      const projects = parseRegistry() || []
      const only = String(args.project || '').trim()
      const targets = (only ? projects.filter((p: any) => p.id === only) : projects)
        .map((p: any) => ({ id: String(p.id), repo: String(p.repo || ''), mission: String((getPolicy(p.id) || {}).mission || '') }))
      // ⚠ readmeOf 是**同步**读：repoDocs 那套是异步且带 git 调用的（要 spawn），
      //   MCP 工具保持同步签名（见 handler 那条铁律）。这里只需要 README 一个文件，
      //   直接读盘即可 —— 不 spawn、不碰网络。
      const readmeOf = (id: string, repo?: string) => {
        const dir = String(repo || '')
        if (!dir) return null
        for (const name of ['README.md', 'Readme.md', 'readme.md', 'README.MD']) {
          const f = `${dir}/${name}`.replace(/\\/g, '/')
          try {
            if (fs.existsSync(f)) return { md: fs.readFileSync(f, 'utf-8'), sourceFile: name }
          } catch { /* 读不到就当没有 */ }
        }
        return null
      }
      const out = draftMissions(
        targets.map((t: any) => ({ id: t.id, mission: t.mission })),
        (id: string) => {
          const t = targets.find((x: any) => x.id === id)
          return readmeOf(id, t && t.repo)
        },
        (id: string) => {
          const t = targets.find((x: any) => x.id === id)
          return t ? t.repo : ''
        },
      )
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        total: out.total,
        // 抽到可用草稿的
        drafts: out.drafts.filter((d: any) => d.draft).map((d: any) => ({
          project: d.project, draft: d.draft, from: d.from,
          // 原文给足，让人一眼能核"它是不是改写过的"
          source: d.sourceText, sourceFile: d.sourceFile, note: d.reason || '',
        })),
        // 抽不出来的（不许糊，逐条说为什么）
        needYou: out.drafts.filter((d: any) => !d.draft).map((d: any) => ({
          project: d.project, why: d.reason,
        })),
        alreadyHave: out.skippedHasMission,
        rule: '草稿逐字来自 README，未经改写。确认后才写进方针卡（这一步必须人来点）。',
      }, null, 2) }] }
    }

    case 'audit_declare': {
      // 2026-11-14 · 卡「拷问 AI」：开工前把"我要读/要做这些"写下来。
      // 存在的理由（暮雨原话）：「没读设定自己瞎搞，找东西都不知道去哪里找，浪费 token
      // 搜永远不可能找到的地方」—— 把"该看什么"前置，事后就不用骂。
      const r = declareWork(
        String(args.session_id || '').trim(),
        args.plan,
        args.project ? String(args.project) : '',
      )
      if (!r.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false, error: r.error || '写不进审计日志',
        }) }], isError: true }
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        declared: r.count,
        // 交付时用同一条 session_id 调 audit_check
        next: '交付时调 audit_check，把实际做的报上来；方寸会跟这份声明对账。',
      }, null, 2) }] }
    }

    case 'audit_check': {
      const sid = String(args.session_id || '').trim()
      const claimed = normalizeRefs(args.did)
      if (!claimed.length) {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false, error: 'did 是空的 —— 这轮什么都没做？至少报一条。',
        }) }], isError: true }
      }
      // 先落自报（即便后面判定失败，自报本身也是要留痕的事实）
      const wrote = claimWork(sid, claimed)
      const loaded = loadSession(sid)
      // MCP 侧**客观**读记录：只认 task（文件读取发生在 client 侧，MCP 看不见）
      const stats = readStats(30)
      const taskIds = Array.from(new Set(
        claimed.filter((x) => x.kind === 'task').map((x) => x.id)
          .concat((loaded.decl?.plan || []).filter((x) => x.kind === 'task').map((x) => x.id)),
      ))
      const observed = observedFromReadStats(stats, taskIds)
      const rep = auditRound(loaded.decl, { did: claimed }, observed)
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        // 审计本身不判"合格/不合格"：它只把"说的和做的不一致"摆出来，裁决归人
        declared: rep.declared,
        counts: rep.counts,
        summary: rep.summary || '（没有发现不一致）',
        rows: rep.rows.map((r) => ({ verdict: r.verdict, kind: r.ref.kind, id: r.ref.id, why: r.why })),
        report: auditReportText(rep),
        claim_written: wrote.ok,
        claim_error: wrote.error || '',
        // 口径必须写在返回里：agent 要知道哪些是客观记录、哪些只是自报
        note: 'task:* 有 MCP 侧客观读记录可对账；file:* / cmd:* 发生在 client 侧，MCP 看不见，只跟声明与自报对账。',
      }, null, 2) }] }
    }

    case 'app_mode': {
      // 卡 task-20261017-002 第 1 条：态可观测。判据全部是可读信号（isPackaged / 路径 / exe 名），
      // 不靠 AI 猜；`codeWriteTools` 恒空 —— MCP 层没有任何写源码的工具（守卫见 e2e-app-mode）。
      const info = detectAppMode()
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...info,
            codeWriteTools: MCP_CODE_WRITE_TOOLS,
            note: 'MCP 层没有任何写源码的工具；写数据受「MCP 写入」档位约束（只读 / 读写 / 读写+破坏性）。',
          }, null, 2),
        }],
      }
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
      // 2026-11-11（评审抓到）：Python 侧门控已落盘（`task-data/.gates.json`），
      // 而桌面 MCP 这里恒回 `[]`（注释写着 "in-memory only"）—— 同一件事两个答案，
      // agent 经桌面 MCP 根本看不到闸。现在读**同一个文件**，两个入口看到同一批。
      // 文件不存在 = 还没有闸（不是“读不到”）。
      try {
        const p = path.join(getDataDir(), 'task-data', '.gates.json')
        if (!fs.existsSync(p)) return { content: [{ type: 'text', text: JSON.stringify([], null, 2) }] }
        const obj = JSON.parse(fs.readFileSync(p, 'utf-8'))
        const rows = obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.values(obj) : []
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
      } catch (e: any) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `门控文件读不出来（task-data/.gates.json）：${e?.message || e}` }) }],
          isError: true,
        }
      }
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
        readOnly: '本工具只读。要新增决策用 decision_propose（只会落「待审批」，转正在决策页点）。',
        decisions: rows,
      }, null, 2) }] }
    }

    /**
     * 提议一条决策（2026-11-24 · 2026-11-23 问卷 K1 拍板）。
     *
     * 「审批就不该走任务卡……决策应该有自己的审批入口。」
     *
     * 这个 handler 是**唯一**的 agent 决策写口，而它只做一件事：
     * 把内容落成「待审批」。三条硬规矩：
     *   ① 传「有效」/「已撤销」/「已合并」**一律拒**（不是悄悄改成待审批 —— 那会让模型
     *      以为自己已经定了一件事，而实际上只是提了个议案）；
     *   ② 待审批的决策不进 `decision_list` 的"有效"口径、也不进上下文包
     *      （未获批准的规矩被当成现行规矩读，比没有这条规矩更危险）；
     *   ③ 落盘后**读回**确认状态真的是待审批，读不回/读错就报错，不靠"我写过了"。
     */
    case 'decision_propose': {
      const content = String(args.content || '').trim()
      const source = String(args.source || '').trim()
      if (!content) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'content 必填' }) }], isError: true }
      if (!source) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            ok: false,
            error: 'source 必填（这条决策的出处：哪次对话 / 哪份问卷 / 哪条证据）—— 没有出处的决策是谣言',
          }) }],
          isError: true,
        }
      }
      // 想自批的，明确拒，并且说清该怎么做
      const wanted = String(args.status || args.状态 || '').trim()
      if (wanted && !AGENT_WRITABLE_DECISION_STATUSES.includes(normalizeDecisionStatus(wanted))) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            ok: false,
            error: `agent 只能提「待审批」，不能设「${wanted}」。转正由用户在决策页点 —— 这是治理层的锁。`,
          }) }],
          isError: true,
        }
      }
      const r = addDecision({
        内容: content,
        日期: new Date().toISOString().slice(0, 10),
        状态: DECISION_PENDING,
        项目: String(args.project || '').trim(),
        出处: String(args.agent || '').trim() ? `${source}（agent: ${String(args.agent).trim()}）` : source,
        生效范围: String(args.scope || '').trim(),
        落地: String(args.landing || '').trim(),
      })
      if (!r.ok) {
        // TS 窄化：`!r.ok` 之后就是失败那一支（两个成员的联合类型）
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: (r as { ok: false; error: string }).error }) }], isError: true }
      }
      // 读回确认：状态必须真的是待审批（老文件里可能有同名条目被 dedupe 命中）
      const back = loadDecisions().find((d) => d.id === r.id)
      const status = back ? String(back.状态 || '') : ''
      if (!back) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            ok: false, id: r.id, error: '写进去了但读不回来 —— 不要认为它已经落好了，去决策页看一眼',
          }) }],
          isError: true,
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({
          ok: true,
          id: r.id,
          status,
          deduped: r.exists === true,
          pending: status === DECISION_PENDING,
          hint: status === DECISION_PENDING
            ? '已落「待审批」—— 用户在决策页点通过之后才生效；在那之前它不算现行规矩，不要据此行动。'
            : `⚠ 读回状态是「${status}」而不是「待审批」，请让用户确认这条决策的来源与状态。`,
        }, null, 2) }],
      }
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
      const mapStaleByAge = mapAgeDays === null || mapAgeDays > 90
      // 2026-11-08 暮雨拍板：阈值不收窄，但**结构大改就要标过期**。
      // 判据 = 自「最后核实」日起，仓库里出现了新目录 / 删掉了目录，或源文件增删 ≥ 25
      //（噪声路径如 node_modules / dist / docs 不计 —— 否则天天过期，判据等于没有）。
      let drift: { status: string; reason: string; files: number; newDirs: string[]; removedDirs: string[]; stale: boolean } | null = null
      if (!mapStaleByAge && mDate) {
        try {
          const reg = parseRegistry()
          const repo = String((reg.find((x: any) => x && x.id === id) || {}).repo || '').trim()
          drift = structureDrift(repo, `${mDate[1]}-${mDate[2]}-${mDate[3]}`)
        } catch { drift = null }
      }
      const mapStale = mapStaleByAge || !!(drift && drift.stale)
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true, project: id, updatedAt: p.updatedAt || '',
        mission: p.mission || '', goal: p.goal || '', scenario: p.scenario || '',
        boundary: p.boundary || '', structureMap: mapText,
        structureMapVerifiedAt: mDate ? `${mDate[1]}-${mDate[2]}-${mDate[3]}` : '',
        structureMapAgeDays: mapAgeDays,
        structureMapStale: mapStale,
        structureMapStaleReason: mapStaleByAge
          ? (mapAgeDays === null ? '结构地图没写“最后核实”日期' : `结构地图已 ${mapAgeDays} 天没核过（>90 天）`)
          : (drift && drift.stale ? drift.reason : ''),
        structureDrift: drift
          ? { status: drift.status, reason: drift.reason, files: drift.files, newDirs: drift.newDirs, removedDirs: drift.removedDirs }
          : null,
        missingSections: missing,
        hint: missing.length
          ? '缺的这几节是真没写，不是本工具读不到；别根据项目名替它补内容。'
          : (mapStale
            ? `这张地图不能信了（${(drift && drift.stale ? drift.reason : '没写日期或超过 90 天')}）—— 动手前先跟用户核一遍，或照实际代码改它（改走 smap_propose）。`
            : '五节齐全，结构地图是近 90 天内核过的。'),
      }, null, 2) }] }
    }

    case 'memory_search': {
      const off = memoryOff()
      if (off) return off
      // 记忆层（2026-11-17）：读口直接读源文件，不走索引 —— 索引是派生数据，源才是真相。
      const r = searchMemory({
        q: String(args.q || '').trim() || undefined,
        type: String(args.type || '').trim() || undefined,
        scope: String(args.scope || '').trim() || undefined,
        project: String(args.project || '').trim() || undefined,
        includeRevoked: args.includeRevoked === true,
        includePending: args.includePending === true,
        limit: Number(args.limit) || undefined,
      })
      const ov = memoryOverview()

      // ── 台账检索（2026-11-23）───────────────────────────────────────
      // 实测缺口：四份台账 921 条，原先一条都没进记忆（覆盖率 0.0%）。
      // 这里让同一次检索能同时命中"人写的 claim"与"台账里的原始记录"，
      // 后者**只给指针**（srcPath），原文永远留在源文件里。
      let ledgers: any = null
      if (args.includeLedgers === true) {
        const lr = searchLedgers({
          q: String(args.q || '').trim() || undefined,
          kind: String(args.ledgerKind || '').trim() || undefined,
          project: String(args.project || '').trim() || undefined,
          limit: Number(args.limit) || undefined,
        })
        ledgers = {
          ok: lr.ok,
          // 索引没生成时明说"还没抽"，不许让它看起来像"台账里没有" —— 本仓老病
          reason: lr.reason || '',
          total: lr.total,
          returned: lr.rows.length,
          items: lr.rows.map((r) => ({
            id: r.id, kind: r.src_kind, title: r.title, summary: r.summary,
            project: r.project, status: r.status, time: r.time,
            // 指针：调用方拿它去 read 原文
            srcPath: r.srcPath, anchor: r.anchor, matched: r.matched || '',
          })),
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        total: r.total,
        returned: r.rows.length,
        truncated: r.truncated,
        dropped: r.dropped,
        chars: r.chars,
        legacy: r.legacy,
        // 空库要说清是「还没录」而不是「筛出来没有」——混着说会让人以为记忆是空的
        hint: r.total === 0 ? (ov.total === 0
          ? '记忆库还没有任何条目 —— 这不是“筛出来没有”，是还没录过。'
          : (ov.pending > 0 && !args.includePending
            ? `筛出来 0 条；另有 ${ov.pending} 条待审批（默认不返回）。要看待审批用 includePending=true，或让用户在记忆页通过。`
            : `筛出来 0 条（库中共 ${ov.total} 条）。放宽条件试试 includeRevoked=true / includePending=true 或去掉 type。`)) : '',
        overview: {
          total: ov.total, effective: ov.effective, pending: ov.pending, revoked: ov.revoked,
          claims: ov.claims, legacy: ov.legacy, evidence: ov.evidence, pinned: ov.pinned, byType: ov.byType,
        },
        items: r.rows.map((x) => ({
          id: x.id, type: x.type, scope: x.scope, project: x.project, time: x.time,
          status: x.status, impact: x.impact, claim: x.claim, title: x.claim, summary: x.claim,
          confidence: x.confidence, importance: x.importance, score: x.score,
          evidencePath: x.evidencePath, legacy: x.legacy,
          file: x.file, tags: x.tags,
        })),
        next: '要原文/证据用 memory_read({file})；长证据带 anchor（如 D5）只取那一节。检索只给 claim，不塞正文。'
          + (ledgers ? ' 台账命中项用 srcPath 直接读源文件（那是一份指针，不是副本）。' : ''),
        // 只有显式要了才出现，避免每次检索都多一块
        ...(ledgers ? { ledgers } : {}),
      }, null, 2) }] }
    }

    case 'memory_read': {
      const off = memoryOff()
      if (off) return off
      const r = readMemory(String(args.file || ''), Number(args.maxChars) || 8000, String(args.anchor || ''))
      if (!r.ok) {
        // 拒绝要说清为什么，不许静默返回空
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          error: r.error || '读不到',
          hint: '只接受 memory_search 返回的 file（必须以 memory/ 开头，且不含 ..）。anchor 找不到会报错，不会没有任何提示地返回全文。',
        }, null, 2) }], isError: true }
      }
      let text = String(r.text || '')
      if (r.truncated) {
        // 截断必须明说：静默少给会让模型以为"原文就这些"
        text += `\n\n[已截断：原文 ${r.chars} 字符，只返回前 ${text.length} 字符。`
          + '要更多用 maxChars（上限 200000）；仍不够就直接读文件。]'
      }
      return { content: [{ type: 'text', text }] }
    }

    case 'memory_core': {
      const off = memoryOff()
      if (off) {
        const ov = memoryOverview()
        // 老插件只认 text/chars/budget/archived/truncated；给一行明说，别让它以为 core.md 没写
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true,
          enabled: false,
          text: '（记忆开关已关闭）',
          chars: 0,
          budget: MEMORY_CORE_BUDGET,
          archived: ov.effective,
          truncated: false,
          missing: false,
          pinnedCount: 0,
          hint: '记忆已关闭（方寸 → 设置 → 通用 → 记忆）。关掉 ≠ 没有记忆：数据还在，记忆页照常可看可管。',
        }, null, 2) }] }
      }
      const c = memoryCore()
      const ov = memoryOverview()
      // 子开关（2026-11-24）：关掉「开工自动注入核心」就不给正文 —— 但**说明库里有几条**，
      // 让调用方能区分"关着"与"没有记忆"（本仓反复栽的四态混淆）。
      const injectOn = memorySubPref('memoryInjectCore') || args.force === true
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: c.ok,
        enabled: true,
        subEnabled: injectOn,
        switch: 'memoryInjectCore',
        text: injectOn ? c.text : '',
        chars: injectOn ? c.chars : 0,
        budget: c.budget,
        truncated: c.truncated,
        missing: c.missing,
        updatedAt: c.updatedAt,
        pinnedCount: c.pinnedCount,
        generated: c.generated,
        archived: ov.effective,
        hint: !injectOn
          ? '「开工自动注入核心」这个子开关是关的（方寸 → 设置 → 通用 → 记忆）。'
            + `关掉 ≠ 没有记忆：${ov.effective} 条记忆还在，钉住 ${c.pinnedCount} 条；`
            + '要临时取一次就显式传 force: true，或去设置里打开它。'
          : (c.missing
            ? '固定核心还没生成（memory/core.md）；归档里有记忆，按需用 memory_search / memory_read，不要全量注入。'
            : (c.truncated
              ? `核心超过 ${c.budget} 字，已截断 —— 请减少钉住条目或精简 core.manual.md，不要把完整事故塞进来。`
              : `这是生成的核心（钉住 claim，按预算 ${c.budget} 字排）。完整证据用 memory_search 找指针、memory_read 取正文；不会自动注入。`)),
      }, null, 2) }] }
    }

    case 'memory_write': {
      const off = memoryOff()
      if (off) return off
      // 2026-11-19：agent 唯一写入口。**永远落「待审批」**，不能自批自收。
      const r = createMemory({
        type: String(args.type || '').trim(),
        claim: String(args.claim || args.title || '').trim(),
        evidence: String(args.evidence || args.body || ''),
        source: String(args.source || '').trim(),
        confidence: args.confidence !== undefined ? Number(args.confidence) : undefined,
        importance: args.importance !== undefined ? Number(args.importance) : undefined,
        pinned: args.pinned === true,
        project: String(args.project || '').trim(),
        scope: String(args.scope || '').trim(),
        impact: String(args.impact || '').trim(),
        supersedes: String(args.supersedes || '').trim(),
        code: String(args.code || '').trim(),
        evidencePath: String(args.evidencePath || '').trim(),
        evidenceAnchor: String(args.evidenceAnchor || '').trim(),
        tags: Array.isArray(args.tags) ? args.tags.map((x: any) => String(x)) : [],
      }, { pending: true })
      if (!r.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          error: r.error,
          duplicate: r.duplicate || undefined,
          hint: r.duplicate
            ? '已有类似记忆。把它报给用户，让用户决定是否取代；不要换个说法再写一条。'
            : 'claim 与证据都必填；一条只讲一件事。',
        }, null, 2) }], isError: true }
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        file: r.file,
        id: r.id,
        claim: r.claim,
        status: '待审批',
        hint: '已落「待审批」。用户在记忆页点「通过」后才算有效；默认 memory_search 不会返回它。',
      }, null, 2) }] }
    }

    case 'memory_briefing': {
      const off = memoryOff()
      if (off) return off
      const project = String(args.project || '').trim()
      if (!project) {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false, error: '需要 project', hint: '传项目 id，例如 fangcun-base。',
        }, null, 2) }], isError: true }
      }
      // 子开关（2026-11-24）：关掉「按项目开工简报」就真不返回简报。
      // 显式传 force:true 表示"我知道它关着，但我这次就是要一份"——那不算绕过，
      // 因为开关是"别自动喂给我"，不是"不许我看"（记忆页一直是全开的）。
      if (!memorySubPref('memoryBriefing') && args.force !== true) return subOff('memoryBriefing')
      const b = memoryBriefing(project, Number(args.limit) || 5)
      // 复核提醒（2026-11-24）：规划 §3.3 要求「>180 天在简报里标待复核」，
      // 而 `复核` 字段此前只被解析、从没被读过 —— 等于这个承诺没兑现。
      const overdue = b.items.filter((x) => x.reviewOverdue)
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        project: b.project,
        total: b.total,
        returned: b.returned,
        truncated: b.truncated,
        dropped: b.dropped,
        chars: b.chars,
        reviewOverdue: overdue.length,
        items: b.items,
        hint: b.total === 0
          ? '这个项目还没有有效记忆（不是读不到）。'
          : (overdue.length
            ? `其中 ${overdue.length} 条已过复核周期（>180 天）：${overdue.map((x) => x.id + ' @ ' + x.review).join('、')}`
              + ' —— 请向用户确认它还成立吗，不要当成现行规矩直接用。'
            : '要原文/证据用 memory_read({file})；简报只给 claim，不塞正文。'),
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
        // 停放区（`_parked/`）此前完全不在这份概览里 —— agent 照实报“0 张待裁决”，
        // 而用户看着那 22 格以为它偷懒（2026-11-08 联测 P1-2）。
        const parked = parkedPlanSummary()
        return { content: [{ type: 'text', text: JSON.stringify({
          files: docs.length, plans: docs,
          parked: {
            files: parked.files, stages: parked.stages, pending: parked.pending,
            note: parked.files
              ? `另有 ${parked.files} 份「停放中」的计划（task-data/plans/_parked/），共 ${parked.stages} 格、其中 ${parked.pending} 格写着待裁决。`
                + '停放 = 用户主动搁下的方案，算不算“等你裁决”由他定；**不要把它算进活跃计划的 pending，也不要当它不存在**。'
                + '要读某一格 → 带 file="_parked/<文件名>"。'
              : '停放区为空。',
            names: parked.names,
          },
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
        note: '文件里的「## 里程碑」/ 阶段总览表是**规划期快照**（2026-11-08 联测 P1-3）；'
          + '实时状态一律看 stages[].status，别拿表里的状态当现状。',
        readOnly: '冻结 / 打回 / 改一句都是用户在界面上点；agent 只读。新增一格请用 stage_plan_propose。',
      }, null, 2) }] }
    }

    // ── 新增阶段卡：agent 提议 → 落「待裁决」，冻结仍由用户在界面点（2026-11-08）──
    case 'stage_plan_propose': {
      const file = String(args.file || (args.project ? `${args.project}.md` : '')).trim()
      if (!file) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'file 或 project 必填' }) }], isError: true }
      const r = proposeStage({
        file,
        stageId: args.stageId ? String(args.stageId) : undefined,
        title: String(args.title || ''),
        what: args.what ? String(args.what) : '',
        approach: Array.isArray(args.approach) ? args.approach.map(String) : [],
        copyRows: Array.isArray(args.copyRows)
          ? args.copyRows.map((row: any) => (Array.isArray(row) ? row.map(String) : []))
          : [],
        criteria: Array.isArray(args.criteria) ? args.criteria.map(String) : [],
        agent: args.agent ? String(args.agent) : '',
        deck: args.deck ? String(args.deck) : '',
      })
      if (!r.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false, error: r.error,
          hint: '没有写盘。按 error 补齐后重试；三块（技术方案 / 照抄点 / 判据）缺一块都写不进去。'
            + ' 另：2026-11-09 起必须带 deck（澄清问卷，已答完并批准），没有 = 硬锁不写。',
        }, null, 2) }], isError: true }
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true, file, stageId: r.stage?.id, status: r.stage?.status,
        next: '告诉用户「P? 已落成待裁决，等他点通过（冻结）」；不要自己宣称已通过。',
      }, null, 2) }] }
    }

    // ── 问卷：列卷 / 出卷（2026-11-08）────────────────────────────────────
    case 'qn_list': {
      const r = listDecks()
      const project = args.project ? String(args.project) : ''
      const batch = args.batch ? Number(args.batch) : 6
      const bank = bankStats(project)
      const next = nextOpen(project, batch).map((e) => ({ id: e.id, ask: e.ask, source: e.source }))
      // P8（D-064）：结论集收敛进度 —— “问够没问够”由机器判，别靠感觉
      const convergence = project ? convergenceStatus(project) : null
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true, dir: r.dir, decks: r.decks,
        bank,
        next,
        convergence,
        // 2026-11-10 规模支撑：几百条题不是一口气答完，是“每次 ≤6 题 + 看得见进度”的队列。
        // 出卷时把「题库 Q-00xx」写进 src，批准时按 id 归并回同一条（问法改了也对得上）。
        hint: r.decks.length
          ? '有正在等答的卷就先让他答，别在聊天里重新问一遍同样的取舍。'
          : (bank.open
            ? `题库还有 ${bank.open} 道待答 —— 用 next（≤6 题）出一卷，src 写「题库 <id>」；别一口气问几十题。`
            : '题库没有待答了。真需要他拍板、而聊天里问不清的取舍 → 用 qn_propose 出一份卷。'),
      }, null, 2) }] }
    }

    case 'qn_bank_import': {
      const project = args.project ? String(args.project) : ''
      const source = args.source ? String(args.source) : ''
      const list = Array.isArray(args.questions) ? args.questions : []
      const rows = list.map((q: any) => ({
        ask: String(q?.ask || ''),
        project,
        source,
        line: q?.line ? String(q.line) : '',
      }))
      const r = importQuestions(rows)
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: r.ok,
        added: r.added,
        merged: r.merged,
        // 冲突 = 这些题已经定过案：**没有覆盖**，原答案原样保留
        conflicts: r.conflicts,
        bank: bankStats(project),
        next: nextOpen(project, 6).map((e) => ({ id: e.id, ask: e.ask })),
        hint: r.conflicts.length
          ? `有 ${r.conflicts.length} 道题已经定过案，被拒绝（原答案没动）：${r.conflicts.map((c) => c.id).join('、')}。这些不用再问。`
          : `已入队 ${r.added} 道待答${r.merged ? `（另有 ${r.merged} 道补了出处/验收线）` : ''}。用 qn_list 看下一批，一次出 ≤6 题。`,
      }, null, 2) }] }
    }

    case 'qn_propose': {
      const spec = {
        deck: args.deck ? String(args.deck) : '',
        title: String(args.title || ''),
        project: args.project ? String(args.project) : '',
        boundary: args.boundary ? String(args.boundary) : '',
        questions: Array.isArray(args.questions)
          ? args.questions.map((q: any) => ({
            id: String(q?.id || ''),
            nav: q?.nav ? String(q.nav) : '',
            ask: q?.ask ? String(q.ask) : '',
            options: Array.isArray(q?.options)
              ? q.options.map((o: any) => ({ k: String(o?.k || ''), t: String(o?.t || ''), d: String(o?.d || '') }))
              : [],
            look: q?.look ? String(q.look) : '',
            src: q?.src ? String(q.src) : '',
            line: q?.line ? String(q.line) : '',
          }))
          : [],
      }
      const r = createDeck({ spec, agent: args.agent ? String(args.agent) : '' })
      if (!r.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false, error: r.error, issues: r.issues,
          hint: '一个字节都没写。每题必须有 ≥2 个选项、每个选项写清代价（d）、每题有验收线（line）。',
        }, null, 2) }], isError: true }
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true, deck: r.deck, path: r.path, questions: r.questions,
        next: '告诉用户「问卷已放到问卷页，共 N 题等你答」；答完批准后才会落决策卡。',
      }, null, 2) }] }
    }

    // ── 结构地图：提议 → 用户签字 → 落地（2026-11-08 暮雨拍板）──────────────
    case 'smap_propose': {
      const project = String(args.project || '').trim()
      const mapText = String(args.mapText || '').trim()
      if (!project) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'project 必填' }) }], isError: true }
      if (!mapText) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'mapText 必填（新版结构地图正文）' }) }], isError: true }
      const at = new Date().toISOString()
      const body = buildSmapProposalBody({
        project, mapText,
        reason: args.reason ? String(args.reason) : '',
        agent: args.agent ? String(args.agent) : '',
        at,
      })
      const criteria = smapProposalCriteria()
      const report = checkIntake(body, criteria)
      // 机检不过照样落卡（东西不许丢），但落「草稿」并带红标 —— 与 intake_task 同一口径
      const status = report.ok ? '待审批' : '草稿'
      const task = tasks.createTask({
        title: `结构地图更新 · ${project}`,
        status: status as any,
        project,
        priority: '中',
        tags: ['结构地图'],
        body: [body, renderIntakeSection(report, { at, agent: args.agent ? String(args.agent) : '' })].join('\n'),
      })
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        id: task.id,
        status: task.fm?.status || status,
        wrotePolicy: false,
        note: '没有动 policies/ —— 这一版只是提议。用户把卡移到「完成」之后才谈落地。',
        intake: { ok: report.ok, passed: report.passed, failed: report.failed, redFlags: report.redFlags },
        next: report.ok
          ? `等用户签字（把 ${task.id} 移到「完成」），然后调 smap_apply { taskId: "${task.id}" }`
          : '判据没过 → 落了「草稿」带红标：补上「最后核实：YYYY-MM-DD」再交一次',
      }, null, 2) }] }
    }

    case 'smap_apply': {
      // 2026-11-21：逻辑抽到 services/smapApply.ts —— 界面「签字并应用」与 MCP
      // 必须走同一份闸/备份/读回，不能两套。
      const r = applySmapFromTask(String(args.taskId || ''))
      return {
        content: [{ type: 'text', text: JSON.stringify(r, null, 2) }],
        ...(r.ok ? {} : { isError: true }),
      }
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

    // ── 日志写口已对 agent 关闭（2026-11-19）────────────────────────────
    // 原来的 create_log / update_log / set_log_status / attach_log_files 四个 case 已删除。
    // 别在这里补回来：执行日志是用户自己存上下文的私人笔记，AI 只读不写；
    // 写入只走界面 IPC（logs:create / logs:update / logs:complete / logs:archive / logs:destroy）。
    // 收工回写仍走 update_task + move_status → 待验收。

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
