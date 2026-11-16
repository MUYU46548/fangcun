/**
 * MCP 写口闸 + 写侧留痕（2026-11-11 · 卡《MCP 写口无闸》）
 *
 * ## 由来
 * 暮雨 2026-11-10：「首战 S4 允许你跑，不过这会不会太越界了？哪怕是另一款自有产品也必须开
 * agent 模式放开解锁才能 agent 直接调用」——他问得对：方寸此前**写数据全程无闸**。
 * 12 个写工具（任务四件 / 规划两件 / 问卷两件 / 结构地图 / 收卡 / 生图 / 记分 / 记账）
 * 只要接上 MCP 就能写；只有「最终拍板」（批准问卷、冻结阶段、smap_apply、决策卡新增）留给了人。
 *
 * ## 三档（沿用 20261017-002 的动作分级，落到数据层）
 *   · `read`        —— 只读：写一律拒（连试都不许）；
 *   · `write`       —— 读写：写数据放行，**破坏性**默认拒（默认档）；
 *   · `destructive` —— 读写 + 破坏性：删卡 / 改分 / 驳回类流转放行。
 * 「读」不做成要开闸 —— agent 连看一眼都要点一次，没人会用。
 *
 * ## 留痕（缺一不算过关）
 * 每次**写**（含被拒的尝试）追加一行到数据根下的 `.mcp-writes.jsonl`（与读侧计量 `mcp-usage.jsonl` 同级）：
 *   `{ts, client, via, tier, ok, error, args}` —— `args` 只留**可核对的关键字段**，
 *   正文类一律折成长度（`body:1234 chars`）：留痕是为了回答“谁写了什么、落到哪张卡”，
 *   不是为了把整段内容再抄一份（抄一份 = 密钥/私事在审计日志里多活一遍）。
 * 读卡计量仍走 `mcp-usage.jsonl`（2026-10-25 卡 006），两条日志**互不替代**。
 *
 * ## 为什么闸在 `handleMCPToolCall` 的**入口**（而不是每个 case 里）
 * 12 个写工具 × 以后还会加 → 散着写必然漏一个。入口一处判，新增工具只要登记档位；
 * 未登记的工具按 `write` 处理（默认不是放行）。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getDataDir } from '../data'
import { getPref, setPref } from '../services/prefs'

export type McpWriteMode = 'read' | 'write' | 'destructive'
export const MCP_WRITE_MODE_KEY = 'mcpWriteMode'
export const WRITE_LOG_FILENAME = '.mcp-writes.jsonl'
/** 单文件上限：超了就轮转一份 `.1`（审计日志不该涨成体积黑洞，2026-11-10 附件那课的复用） */
const MAX_LOG_BYTES = 2 * 1024 * 1024

export const WRITE_MODES: { mode: McpWriteMode; label: string; hint: string }[] = [
  { mode: 'read', label: '只读', hint: 'agent 只能看，任何写操作都被拒（连尝试都不许）' },
  { mode: 'write', label: '读写', hint: '可以建卡/改卡/写规划；删卡、改分、驳回类流转仍拒（默认）' },
  { mode: 'destructive', label: '读写 + 破坏性', hint: '删卡 / 改分 / 驳回类流转也放行 —— 只在明确要 agent 代劳处置时开' },
]

export type ToolTier = 'read' | 'write' | 'destructive'

/**
 * 只读白名单。⚠ 这里是**白名单**：没列进来的按 `write` 算。
 * 新增只读工具要登记，否则它在「只读」档下会被拒 —— 宁可多拒一次，不可默默放行。
 */
const READ_TOOLS = new Set([
  'list_tasks', 'get_task', 'search_tasks',
  'list_projects', 'get_project_status', 'find_blockers', 'scan_services', 'get_roadmap', 'get_data_dir',
  'plan_list', 'plan_get', 'plan_pending', 'gate_list', 'decision_list', 'project_charter',
  'stage_plan_get', 'qn_list', 'rice_pool_list',
  'list_logs', 'search_logs', 'get_log', 'inject_logs', 'never_read',
  // 运行态查询（2026-11-11 卡 20261017-002）：纯读，只读档下也必须能用
  'app_mode',
])

/** 破坏性：删数据 / 改别人的分数 / 驳回类流转 */
const DESTRUCTIVE_TOOLS = new Set(['delete_task', 'rice_pool_upsert'])

export function tierOf(name: string, args?: any): ToolTier {
  const n = String(name || '')
  if (READ_TOOLS.has(n)) return 'read'
  if (DESTRUCTIVE_TOOLS.has(n)) return 'destructive'
  // 「替用户签字」这条只算 `update_task` 的**后门**：`move_status` 到 完成/驳回 在 tools.ts 里
  // 是**无条件**硬拒的（连 destructive 档也不放），所以它不该被算成“开档就能用”的破坏性操作 ——
  // 那样用户开了档，agent 收到的还是一条“去开档”的错误话术，反而误导。
  if (n === 'update_task' && /^(驳回|完成)$/.test(String(args?.fields?.status || ''))) return 'destructive'
  return 'write'
}

export function getWriteMode(): McpWriteMode {
  const raw = String(getPref(MCP_WRITE_MODE_KEY) || '').trim()
  if (raw === 'read' || raw === 'write' || raw === 'destructive') return raw
  return 'write'
}

export function writeLogPath(): string {
  return path.join(getDataDir(), WRITE_LOG_FILENAME)
}

export interface WriteEvent {
  ts: string
  /** 哪条 MCP 工具 */
  via: string
  tier: ToolTier
  /** 客户端名（initialize 里的 clientInfo.name）；未知就写 'unknown' */
  client: string
  ok: boolean
  error?: string
  /** 落下的东西（新卡 id / 移到的状态 这类一句摘要；没有就空） */
  result?: string
  /** 可核对的关键字段（正文折成长度） */
  args: Record<string, unknown>
}

/** 参数脱敏：只留能回答“写了什么/落在哪”的键，正文类一律折成长度 */
export function summarizeArgs(name: string, args: any): Record<string, unknown> {
  const a = args || {}
  const out: Record<string, unknown> = {}
  const keep = ['id', 'ids', 'title', 'status', 'project', 'priority', 'deck', 'qid', 'eid', 'stageId', 'file', 'batch', 'by', 'model', 'card', 'taskId']
  for (const k of keep) {
    const v = a[k]
    if (v === undefined || v === null || v === '') continue
    out[k] = Array.isArray(v) ? v.slice(0, 20) : v
  }
  if (a.fields && typeof a.fields === 'object') {
    const keys = Object.keys(a.fields)
    const short: Record<string, unknown> = {}
    for (const k of keys) {
      if (k === 'body' || k === 'result_log' || k === 'plan') short[k] = `${String(a.fields[k] ?? '').length} chars`
      else if (Object.prototype.hasOwnProperty.call(out, k)) continue
      else short[k] = a.fields[k]
    }
    out.fields = short
  }
  if (typeof a.body === 'string') out.body = `${a.body.length} chars`
  if (typeof a.deliverable === 'string') out.deliverable = `${a.deliverable.length} chars`
  if (Array.isArray(a.criteria)) out.criteria = `${a.criteria.length} 条`
  if (Array.isArray(a.items)) out.items = `${a.items.length} 条`
  if (typeof a.content === 'string') out.content = `${a.content.length} chars`
  if (typeof a.amount !== 'undefined') out.amount = a.amount
  return out
}

function rotateIfHuge(p: string): void {
  try {
    if (!fs.existsSync(p)) return
    if (fs.statSync(p).size < MAX_LOG_BYTES) return
    fs.renameSync(p, p + '.1')
  } catch { /* 轮转失败不挡写入 */ }
}

/** 记一次写（含被拒）。永远不抛 —— 审计失败不能变成写失败。 */
export function recordWrite(ev: Omit<WriteEvent, 'ts'> & { ts?: string }): void {
  try {
    const p = writeLogPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    rotateIfHuge(p)
    const line: WriteEvent = {
      ts: ev.ts || new Date().toISOString(),
      via: String(ev.via || ''),
      tier: ev.tier,
      client: String(ev.client || 'unknown'),
      ok: !!ev.ok,
      error: ev.error ? String(ev.error).slice(0, 300) : undefined,
      result: ev.result ? String(ev.result).slice(0, 200) : undefined,
      args: ev.args || {},
    }
    fs.appendFileSync(p, JSON.stringify(line) + '\n', 'utf-8')
  } catch { /* 铁律：静默 */ }
}

export interface WriteGateDecision {
  ok: boolean
  tier: ToolTier
  mode: McpWriteMode
  error?: string
}

/** 入口判定：读一律放行；写看档位。被拒时的错误要说清**当前档位**和怎么改。 */
export function checkMcpWrite(name: string, args?: any): WriteGateDecision {
  const tier = tierOf(name, args)
  const mode = getWriteMode()
  if (tier === 'read') return { ok: true, tier, mode }
  if (mode === 'read') {
    return {
      ok: false, tier, mode,
      error: `方寸的 MCP 写入档位是「只读」——${name} 属于写操作，已被拒绝。`
        + '要放开：方寸 → 设置 → Agent 接入 → 「MCP 写入」改档（改档会留痕）。',
    }
  }
  if (tier === 'destructive' && mode !== 'destructive') {
    return {
      ok: false, tier, mode,
      error: `方寸的 MCP 写入档位是「读写」，不含破坏性操作 ——${name} 会删数据 / 改分 / 走驳回流转，已被拒绝。`
        + '要放开：设置 → Agent 接入 → 「MCP 写入」改成「读写 + 破坏性」。',
    }
  }
  return { ok: true, tier, mode }
}

/**
 * 改档：写 prefs + 追加一条**档位变更**留痕（谁/何时/从哪档到哪档）。
 * 返回回读后的真实档位 —— 不靠“写成功”自证（prefs 有假成功的前科）。
 */
export function setWriteMode(next: McpWriteMode, by = 'user'): { ok: boolean; mode: McpWriteMode; previous: McpWriteMode; error?: string } {
  const want: McpWriteMode = next === 'read' || next === 'destructive' ? next : 'write'
  const previous = getWriteMode()
  if (want === previous) return { ok: true, mode: previous, previous }
  setPref(MCP_WRITE_MODE_KEY, want)
  const back = getWriteMode()
  recordWrite({
    via: 'mcp.writeMode',
    tier: 'destructive',
    client: String(by || 'user'),
    ok: back === want,
    error: back === want ? undefined : `写进 prefs 的是 ${want}，回读却是 ${back}`,
    args: { from: previous, to: want },
  })
  return { ok: back === want, mode: back, previous, error: back === want ? undefined : `改档没落盘：期望 ${want}，回读 ${back}` }
}

/** 最近 N 次写（界面清单用）。坏行跳过，不因一行坏数据把整份清单作废。 */
export function listWrites(limit = 50): { ok: true; rows: WriteEvent[]; path: string } {
  const p = writeLogPath()
  const out: WriteEvent[] = []
  let raw = ''
  try { raw = fs.readFileSync(p, 'utf-8') } catch { return { ok: true, rows: [], path: p } }
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < Math.max(1, limit); i--) {
    const s = lines[i].trim()
    if (!s) continue
    try {
      const ev = JSON.parse(s)
      if (!ev || typeof ev !== 'object') continue
      out.push(ev as WriteEvent)
    } catch { /* 坏行跳过 */ }
  }
  return { ok: true, rows: out, path: p }
}
