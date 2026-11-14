/**
 * 开工声明与交付核实（2026-11-14 · 行为审计的持久层）
 *
 * 纯逻辑在 `shared/behaviorAudit.ts`（可被 node 直接断言）；这里只管**读写磁盘**。
 *
 * ## 为什么落盘而不是放内存
 * 声明发生在**开工前**、核实发生在**交付后** —— 中间可能跨进程、跨会话、跨重启。
 * 放内存等于"换个会话就找不到自己说过什么"，那样审计只剩一句空话。
 *
 * ## 落哪儿
 * `task-data/.behavior-audit.jsonl`：追加日志，**不进任务文件**。
 * 理由同 `mcp-usage.jsonl`（卡 006）：给任务卡加字段会让"读"污染"写"，
 * 乐观锁噪音、mtime 全变、备份体积上涨 —— 审计是旁路，不是数据本身。
 *
 * ## 写失败静默（铁律）
 * 审计是锦上添花。磁盘满 / 权限错**绝不能**让 agent 用不了工具 —— 那会让它绕过审计，
 * 而这套东西的价值全靠"它愿意用"。所以所有写操作 try/catch 吞掉。
 *
 * ⚠ 这个文件**不做判定**。判定只在 shared/behaviorAudit 里做一次，避免两处口径打架
 *   （本仓栽过：never-read 与 cleanup 各写一遍"算不算未完成"，结果一个算空状态一个不算）。
 */

import * as fs from 'fs'
import * as path from 'path'
import { getDataDir } from '../data'
import type { AuditDeclaration, AuditRef } from '../../shared/behaviorAudit'

/** 磁盘上一条记录 */
type AuditRecord =
  | { type: 'declare'; ts: string; sessionId: string; project?: string; plan: AuditRef[] }
  | { type: 'claim'; ts: string; sessionId: string; did: AuditRef[] }

export function auditFilePath(): string {
  return path.join(getDataDir(), 'task-data', '.behavior-audit.jsonl')
}

function append(rec: AuditRecord): { ok: boolean; error?: string } {
  try {
    const p = auditFilePath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify(rec) + '\n', 'utf-8')
    return { ok: true }
  } catch (err: any) {
    // 静默失败但**如实回报**给调用方（工具层要能看见"没写进去"）
    return { ok: false, error: String(err?.message || err) }
  }
}

/** 归一化 refs：丢掉空 id，kind 默认 'task'（最常见的场景），id 去空白 */
export function normalizeRefs(input: unknown): AuditRef[] {
  const out: AuditRef[] = []
  for (const raw of Array.isArray(input) ? input : []) {
    if (!raw) continue
    const o: any = typeof raw === 'string' ? { id: raw } : raw
    const id = String(o.id ?? o.path ?? o.name ?? '').trim()
    if (!id) continue
    out.push({ kind: String(o.kind || 'task').trim().toLowerCase(), id })
  }
  return out
}

/** 记一份开工声明。同 sessionId 后者覆盖前者（最新一次开工才作数）。 */
export function declareWork(sessionId: string, plan: unknown, project?: string): { ok: boolean; count: number; error?: string } {
  const refs = normalizeRefs(plan)
  const sid = String(sessionId || '').trim() || 'unknown'
  if (!refs.length) return { ok: false, count: 0, error: '声明是空的 —— 至少要写一条"这轮要读/要做的东西"' }
  const r = append({ type: 'declare', ts: new Date().toISOString(), sessionId: sid, project: project ? String(project) : '', plan: refs })
  return { ok: r.ok, count: refs.length, error: r.error }
}

/** 记一份交付自报 */
export function claimWork(sessionId: string, did: unknown): { ok: boolean; count: number; error?: string } {
  const refs = normalizeRefs(did)
  const sid = String(sessionId || '').trim() || 'unknown'
  if (!refs.length) return { ok: false, count: 0, error: '自报是空的 —— 这轮什么都没做？' }
  const r = append({ type: 'claim', ts: new Date().toISOString(), sessionId: sid, did: refs })
  return { ok: r.ok, count: refs.length, error: r.error }
}

interface Loaded {
  decl: AuditDeclaration | null
  claim: { did: AuditRef[] } | null
  /** 坏行数（坏数据不许让整份作废，但要能看见） */
  badLines: number
}

/**
 * 读某个 session 的最新声明与最新自报。
 *
 * 「最新」定义：按写入顺序**最后一条**各取一份 —— 同一会话里补声明/补自报很常见，
 * 拿第一条会把"我后来改了计划"当成没改。
 */
export function loadSession(sessionId: string): Loaded {
  const sid = String(sessionId || '').trim() || 'unknown'
  const out: Loaded = { decl: null, claim: null, badLines: 0 }
  let raw = ''
  try {
    raw = fs.readFileSync(auditFilePath(), 'utf-8')
  } catch {
    return out
  }
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let rec: any
    try { rec = JSON.parse(s) } catch { out.badLines++; continue }
    if (String(rec?.sessionId || '') !== sid) continue
    if (rec.type === 'declare') {
      out.decl = { ts: String(rec.ts || ''), project: String(rec.project || ''), plan: normalizeRefs(rec.plan) }
    } else if (rec.type === 'claim') {
      out.claim = { did: normalizeRefs(rec.did) }
    }
  }
  return out
}

/** 这段时间内有哪些 session 声明过（给界面/工具列"待核"清单用） */
export function recentSessions(limit = 20): Array<{ sessionId: string; ts: string; count: number }> {
  const rows: Array<{ sessionId: string; ts: string; count: number }> = []
  let raw = ''
  try {
    raw = fs.readFileSync(auditFilePath(), 'utf-8')
  } catch {
    return rows
  }
  const last = new Map<string, { ts: string; count: number }>()
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let rec: any
    try { rec = JSON.parse(s) } catch { continue }
    if (rec.type !== 'declare') continue
    const sid = String(rec.sessionId || '')
    if (!sid) continue
    last.set(sid, { ts: String(rec.ts || ''), count: (rec.plan || []).length })
  }
  for (const [sessionId, v] of last) rows.push({ sessionId, ...v })
  rows.sort((a, b) => b.ts.localeCompare(a.ts))
  return rows.slice(0, Math.max(1, limit))
}
