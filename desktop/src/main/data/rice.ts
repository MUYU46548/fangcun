/**
 * 需求矩阵（RICE）—— 数据层（2026-10-28）
 *
 * 宿主文件：`task-data/rice-pool.md`（节式，与 decisions.md 同款；TS / Python 两端同文件读写）。
 * 口径与校验全部在 `shared/rice.ts`（纯逻辑，Node 直接可验）；这里只做四件事：
 *   ① 读 / 原子写池文件（坏文件不覆盖、读不出来显式报错）
 *   ② 来源存在性注入（task / idea / todo → 真读对应数据源；external 不校验）
 *   ③ 幂等 upsert（同 eid 覆盖分数/备注/打分，保留 拍板 + 决策id）
 *   ④ 拍板落账（包装 addDecision）+ 回填池条目的 拍板 / 决策id
 *
 * ⚠ 画线：**页签/agent 都不许手搓直改 rice-pool.md** —— 绕过本模块就等于绕过
 *   原子写与审计（fangcun-bridge 边界纪律同款）。`rice_pool_upsert` / `decision_record`
 *   两个 MCP 写工具是唯一入口。
 */
import * as fs from 'fs'
import * as path from 'path'
import { atomicWrite, getTaskDir, logActivity } from './index'
import * as tasks from './tasks'
import { addDecision } from './decisions'
import { listIdeas } from '../services/ideas'
import { listTodos } from '../services/todos'
import {
  mergeRiceUpsert,
  parseRicePool,
  renderRicePool,
  scoreOf,
  splitOrigin,
  type RiceItem,
  type RicePool,
} from '../../shared/rice'

export interface RiceReadResult {
  ok: boolean
  error?: string
  pool: RicePool
  /** 池文件绝对路径（界面可以复制走 / 排错时一眼看到在哪） */
  path: string
}

export function ricePoolPath(): string {
  return path.join(getTaskDir(), 'rice-pool.md')
}

function emptyPool(): RicePool {
  return { budget: 0, items: [] }
}

function readPool(): { pool: RicePool; error?: string } {
  const p = ricePoolPath()
  if (!fs.existsSync(p)) return { pool: emptyPool() }
  let text = ''
  try {
    text = fs.readFileSync(p, 'utf-8')
  } catch (e) {
    // 读不出来就说读不出来 —— 空池会让人以为"从来没打过分"
    return { pool: emptyPool(), error: '读不出 rice-pool.md：' + ((e as Error)?.message || String(e)) }
  }
  try {
    return { pool: parseRicePool(text) }
  } catch (e) {
    return { pool: emptyPool(), error: 'rice-pool.md 解析失败：' + ((e as Error)?.message || String(e)) }
  }
}

function savePool(pool: RicePool): void {
  fs.mkdirSync(getTaskDir(), { recursive: true })
  atomicWrite(ricePoolPath(), renderRicePool(pool))
}

export function getRicePool(): RiceReadResult {
  const { pool, error } = readPool()
  if (!error && pool?.items) {
    // 2026-10-30 暮雨第 5 条：界面要能按项目切换。项目不落进池文件（保持单一事实来源），
    // 每次读池时按 origin 真读对应数据源补一个只读字段；读不到 = 空串（未归属），不猜。
    pool.items = pool.items.map((it) => ({ ...it, project: projectOfOrigin(it.origin) }))
  }
  return { ok: !error, error, pool, path: ricePoolPath() }
}

/** origin → 项目 id（task / todo / idea 各读各的真身；external 或读不到 = 空串） */
function projectOfOrigin(origin: string): string {
  const o = splitOrigin(origin)
  if (!o) return ''
  const normalize = (p: any): string => {
    if (!p) return ''
    return Array.isArray(p) ? String(p[0] || '') : String(p)
  }
  try {
    if (o.type === 'task') {
      const t: any = tasks.readTask(o.id)
      return normalize(t?.fm?.project ?? t?.project)
    }
    if (o.type === 'todo') {
      const t: any = listTodos().find((x: any) => String(x.id) === o.id)
      return normalize(t?.project ?? t?.fm?.project)
    }
    if (o.type === 'idea') {
      const t: any = listIdeas().find((x: any) => String(x.id) === o.id)
      return normalize(t?.project ?? t?.fm?.project)
    }
  } catch { /* 读不到就归未归属，不猜 */ }
  return ''
}

/** 来源存在性：只认能真读到的条目；external 永远算存在（它本来就没有原条目） */
function originExists(type: string, id: string): boolean {
  try {
    if (type === 'task') return !!tasks.readTask(id)
    if (type === 'todo') return listTodos().some((t) => t.id === id)
    if (type === 'idea') return listIdeas().some((i) => i.id === id)
  } catch {
    return false
  }
  return false
}

function todayISO(): string {
  const d = new Date()
  const m = d.getMonth() + 1
  const day = d.getDate()
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day)
}

export interface RiceUpsertMeta {
  by?: string
  batch?: string
  date?: string
}

export interface RiceUpsertResult {
  ok: boolean
  error?: string
  added: string[]
  updated: string[]
  rejected: Array<{ eid: string; error: string }>
  warnings: Array<{ eid: string; warning: string }>
  /** 写盘后的整池（界面拿它直接重绘，不再自己猜合入结果） */
  pool?: RicePool
  batch?: string
}

/**
 * 幂等灌入初分。同 eid 连灌两遍：**池条目数不变**（格式闸验收线）。
 * 非法条目逐条拒（`rejected`），整批照常落盘 —— 一条坏数据不该挡住其余 20 条。
 */
export function upsertRiceItems(inputs: any[], meta: RiceUpsertMeta = {}): RiceUpsertResult {
  const { pool, error } = readPool()
  if (error) {
    return { ok: false, error, added: [], updated: [], rejected: [], warnings: [] }
  }
  const batch = String(meta.batch || '').trim()
  const date = String(meta.date || '').trim() || todayISO()
  const merged = mergeRiceUpsert(pool, inputs, {
    by: String(meta.by || 'agent').trim() || 'agent',
    date,
    originExists,
  })
  try {
    savePool(merged.pool)
  } catch (e) {
    return {
      ok: false,
      error: '写入 rice-pool.md 失败：' + ((e as Error)?.message || String(e)),
      added: merged.added,
      updated: merged.updated,
      rejected: merged.rejected,
      warnings: merged.warnings,
    }
  }
  logActivity(
    'rice-pool',
    'rice-upsert',
    `批次 ${batch || '(未命名)'}：新增 ${merged.added.length} / 更新 ${merged.updated.length} / 拒 ${merged.rejected.length}`
  )
  return { ok: true, ...merged, batch }
}

export interface RiceDecisionInput {
  eid: string
  内容?: string
  项目?: string
  状态?: string
  出处?: string
  备注?: string
}

export interface RiceDecisionResult {
  ok: boolean
  error?: string
  batch?: string
  results: Array<{
    eid: string
    ok: boolean
    decisionId?: string
    exists?: boolean
    error?: string
  }>
  pool?: RicePool
}

/** 条目挂在哪个项目：task 来源读卡的「项目」第一个值；其余留空（不猜） */
function projectOfItem(it: RiceItem): string {
  const sp = splitOrigin(it.origin)
  if (!sp || sp.type !== 'task') return ''
  try {
    const t = tasks.readTask(sp.id)
    const p = (t?.fm as any)?.project
    if (Array.isArray(p)) return String(p[0] || '')
    return String(p || '')
  } catch {
    return ''
  }
}

/** 拍板备注的默认口径（分数 + 证据 + 旁注），用户可覆盖 */
export function defaultDecisionNote(it: RiceItem): string {
  const s = scoreOf(it)
  return (
    `RICE=${Number.isFinite(s) ? s : '—'}（R${it.R}×I${it.I}×C${it.C}÷E${it.E_days}）` +
    `；证据=${it.evidence || '—'}` +
    (Number.isFinite(it.E_cost) ? `；E元=${it.E_cost}` : '')
  )
}

/**
 * 拍板导出：逐条落 decisions.md（addDecision 幂等白得），成功后回填池条目
 * `拍板:` / `决策id:`。CUT = 状态「已撤销」，池里留痕不删。
 *
 * ⚠ 先校验 eid 在池里、状态合法，再落账 —— 不许出现"决策建了但池里回填不上"。
 * ⚠ 拍板是**用户动作**：这个函数只能由页签按钮或用户直接调用，agent 不代拍。
 */
export function recordRiceDecisions(items: RiceDecisionInput[], meta: { batch?: string; date?: string } = {}): RiceDecisionResult {
  const { pool, error } = readPool()
  if (error) return { ok: false, error, results: [] }
  const batch = String(meta.batch || '').trim() || `rice-export-${todayISO().replace(/-/g, '')}`
  const results: RiceDecisionResult['results'] = []

  for (const raw of Array.isArray(items) ? items : []) {
    const eid = String(raw?.eid ?? '').trim()
    const idx = pool.items.findIndex((x) => x.eid === eid)
    if (idx < 0) {
      results.push({ eid, ok: false, error: '池里没有这个 eid：' + eid })
      continue
    }
    const it = pool.items[idx]
    const status = String(raw?.状态 ?? '').trim() || '有效'
    if (status !== '有效' && status !== '已撤销') {
      results.push({ eid, ok: false, error: `拍板状态只认 有效 / 已撤销（CUT 传已撤销），收到：${status}` })
      continue
    }
    const input = {
      内容: String(raw?.内容 ?? '').trim() || it.title,
      日期: String(meta.date || '').trim() || todayISO(),
      状态: status as '有效' | '已撤销',
      项目: String(raw?.项目 ?? '').trim() || projectOfItem(it),
      出处: String(raw?.出处 ?? '').trim() || `需求矩阵拍板 ${batch}`,
      备注: String(raw?.备注 ?? '').trim() || defaultDecisionNote(it),
    }
    const r = addDecision(input)
    // tsconfig 是 strict:false：`if (!r.ok)` **不收窄**可辨识联合（AGENTS 踩坑 5），
    // 所以这里显式判 'error' in r，别指望 truthy 收窄。
    if (!r.ok && 'error' in r) {
      results.push({ eid, ok: false, error: r.error })
      continue
    }
    if (!r.ok) {
      results.push({ eid, ok: false, error: '决策落账失败' })
      continue
    }
    it.verdict = status === '已撤销' ? 'CUT' : '有效'
    it.decisionId = r.id
    results.push({ eid, ok: true, decisionId: r.id, exists: !!r.exists })
  }

  const okCount = results.filter((x) => x.ok).length
  if (okCount > 0) {
    try {
      savePool(pool)
    } catch (e) {
      return {
        ok: false,
        error: '决策已落账，但回填 rice-pool.md 失败：' + ((e as Error)?.message || String(e)),
        batch,
        results,
        pool,
      }
    }
    logActivity('rice-pool', 'rice-decide', `批次 ${batch}：落账 ${okCount} 条`)
  }
  return { ok: results.every((x) => x.ok), batch, results, pool }
}

/** 改月预算（容量护栏）。预算落在池文件里 —— 放 prefs 里换 origin 就没了。 */
export function setRiceBudget(budget: number): { ok: boolean; error?: string; pool?: RicePool } {
  const b = Number(budget)
  if (!Number.isFinite(b) || b < 0) return { ok: false, error: '月预算必须是非负数（元）' }
  const { pool, error } = readPool()
  if (error) return { ok: false, error }
  pool.budget = Math.round(b * 100) / 100
  try {
    savePool(pool)
  } catch (e) {
    return { ok: false, error: '写入 rice-pool.md 失败：' + ((e as Error)?.message || String(e)) }
  }
  return { ok: true, pool }
}
