/**
 * MCP 读卡计量（2026-10-25 卡 006 第二件）——「13 writes, 1 read」的答案
 *
 * 要解决的事（暮雨原话）：「看板任务一堆待办，很多我都不知道到底做了没有。」
 * 根因不是状态字段不准，而是**状态只反映"有人改过它"，不反映"有人读过它"**。
 * 一张卡放了三个月没人打开，和"今天刚看过准备做"在数据上一模一样。
 *
 * 三条设计约束：
 *  ① **只读行为不许写进任务文件**。给卡加 `引用次数` 字段会让每次读取都变成写操作 ——
 *     乐观锁噪音、mtime 全变、备份体积上涨，而且"读"会污染"改"。
 *     所以计数落**独立追加日志** `mcp-usage.jsonl`，任务文件一个字节都不动。
 *  ② **写失败静默**。计量是锦上添花，绝不能因为磁盘满了就让 agent 读不到卡。
 *  ③ **只记 id + 时间 + 来源**，不记查询串原文（可能含项目名/人名等业务词）。
 */

import * as fs from 'fs'
import * as path from 'path'
import { getDataDir } from '../data'
import type { NeverReadInput } from '../../shared/neverRead'

/** 一次读取事件 */
export interface UsageEvent {
  ts: string
  /** 哪条 MCP 工具：get_task / list_tasks / search_tasks */
  via: string
  /** 这次读到/返回的卡 id（最多留 200，避免一次 list 把日志撑爆） */
  ids: string[]
}

const MAX_IDS_PER_EVENT = 200

export function usageFilePath(): string {
  return path.join(getDataDir(), 'mcp-usage.jsonl')
}

/** 记一次读取。永远不抛 —— 计量失败不能挡住 agent 读卡。 */
export function recordRead(via: string, ids: unknown): void {
  try {
    const list = (Array.isArray(ids) ? ids : [])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
      .slice(0, MAX_IDS_PER_EVENT)
    if (!list.length) return
    const ev: UsageEvent = { ts: new Date().toISOString(), via: String(via || 'unknown'), ids: list }
    const p = usageFilePath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify(ev) + '\n', 'utf-8')
  } catch { /* 铁律：静默 */ }
}

export interface ReadStat {
  id: string
  /** 被读过多少次 */
  reads: number
  /** 最后一次读的时间（ISO）；从未读过为空串 */
  lastRead: string
  /** 最后一次是通过哪条工具读的 */
  lastVia: string
}

/**
 * 聚合最近 N 天的读取统计（按卡 id）。
 * `days <= 0` 表示不限时间。坏行跳过，不因为一行坏数据整份作废。
 */
function scanEvents(days: number): { stats: Map<string, ReadStat>; events: number } {
  const out = new Map<string, ReadStat>()
  let events = 0
  let raw = ''
  try {
    raw = fs.readFileSync(usageFilePath(), 'utf-8')
  } catch {
    return { stats: out, events }
  }
  const since = days > 0 ? Date.now() - days * 86400_000 : 0
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let ev: any
    try { ev = JSON.parse(s) } catch { continue }
    const ts = String(ev?.ts || '')
    const t = Date.parse(ts)
    if (!Number.isFinite(t)) continue
    if (since && t < since) continue
    events++
    const via = String(ev?.via || '')
    const list: string[] = Array.isArray(ev?.ids) ? ev.ids.map((x: unknown) => String(x)) : []
    for (const id of list) {
      if (!id) continue
      const cur = out.get(id) || { id, reads: 0, lastRead: '', lastVia: '' }
      cur.reads++
      // `>=` 而不是 `>`：同一条毫秒内的两次读（agent 连续 get 两张卡很常见）用 `>` 时
      // 第二次不会覆盖 → `lastVia` 永远记着**前一次**的工具名。
      // 2026-10-27 实测：`e2e-mcp-usage` 的「记下最后来源」那条断言就是这个红
      // （期望 list_tasks、实际 get_task），连续跑三次稳定复现。
      if (!cur.lastRead || ts >= cur.lastRead) { cur.lastRead = ts; cur.lastVia = via }
      out.set(id, cur)
    }
  }
  return { stats: out, events }
}

export function readStats(days = 30): Map<string, ReadStat> {
  return scanEvents(days).stats
}

/**
 * 给界面用：一次扫描同时给「按卡的统计」与「窗口内事件条数」。
 *
 * 为什么需要事件条数（卡 20261025-006 第三件的口径）：
 *   `mcp-usage.jsonl` 根本不存在时，`readStats()` 返回空 Map，
 *   于是**所有卡都是 0 引用** —— 界面上报「42 张没人碰过」是冤枉，
 *   真相是"计量还没开始"。两者必须分开，所以把条数一起带出去。
 */
export function readSummary(days = 30): { stats: Record<string, ReadStat>; events: number } {
  const { stats, events } = scanEvents(days)
  const obj: Record<string, ReadStat> = {}
  stats.forEach((v, k) => { obj[k] = v })
  return { stats: obj, events }
}

/**
 * 「最近 N 天一次都没被读过」的卡（卡 006 第三件的数据源）。
 * 只返回 id 列表，排序交给调用方 —— 这里不做优先级判断。
 */
export function neverRead(ids: string[], days = 30): string[] {
  const stats = readStats(days)
  return ids.filter((id) => !stats.has(String(id)))
}

/**
 * 主进程的 `Task` → 读卡判定要的形状（卡 20261025-006 第三件）。
 *
 * 为什么单独导出：这层字段映射**最容易写错**，而且错了不会有任何报错 ——
 * 只会让清单里每张卡的标题/项目变成空串（本仓栽过同款：手写字段列表漏了 `deadline`）。
 * 单独一个函数就能被 e2e 拿**真数据根**直接断言，不必起 Electron。
 *
 * ⚠ 字段是**英文键**：`TaskFrontmatter` 是 `{title, project, status, priority, updated}`，
 *   中文（`标题: …`）只是**文件里的 YAML 键名**，解析后已映射成英文。
 *   2026-10-27 第一版按 `fm.标题` 写，断言一跑全是空串 —— 这就是"没跑过的断言等于没写"。
 * ⚠ `project` 可能是数组（`项目: [fangcun-base]`，老卡还有裸标量）：两种都要接住，
 *   否则项目列会变成空串或者 `a,b` 黏在一起的分不清形态。
 */
export function taskToNeverReadInput(t: any): NeverReadInput {
  const fm = t?.fm || {}
  const project = fm.project
  return {
    id: String(t?.id ?? fm.id ?? ''),
    title: String(fm.title ?? ''),
    project: Array.isArray(project) ? project.join(' / ') : String(project ?? ''),
    status: String(fm.status ?? ''),
    priority: String(fm.priority ?? ''),
    updated: fm.updated ?? '',
  }
}
