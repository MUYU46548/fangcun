/**
 * Fangcun Desktop — 通知中心服务
 *
 * 设计原则（可扩展优先）：
 *  - 通知 = 事件的一条持久化记录，type 是开放字符串，新增事件源只需约定 type + sourceId
 *  - 去重键 = type + sourceId + key（事件指纹，如 due 值）：同一事件只产生一条记录，
 *    重复发生时更新已有记录（刷新 body/时间），不再弹系统通知
 *  - 存储复用 todos 的 index.json 模式，随数据目录走（换目录不丢）
 *
 * 预留的 type 约定（不封闭，新增类型无需改本文件结构）：
 *  todo-due / task-deadline / task-timeout / parse-error / backup-failed
 */
import * as fs from 'fs'
import * as path from 'path'
import { getDataDir, atomicWriteBackup } from '../data'

export interface Notification {
  id: string
  type: string
  level: 'info' | 'warning' | 'error'
  title: string
  body?: string
  sourceId?: string
  key?: string
  createdAt: string
  updatedAt: string
  read: boolean
}

export interface PushInput {
  type: string
  level?: 'info' | 'warning' | 'error'
  title: string
  body?: string
  sourceId?: string
  key?: string
  osNotify?: boolean
}

/** 上限：超出时先淘汰已读最旧，再淘汰最旧 */
const MAX_NOTIFICATIONS = 300

function getStorePath(): string {
  const dir = path.join(getDataDir(), 'notifications')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'index.json')
}

function normalize(raw: any): Notification {
  return {
    id: String(raw?.id ?? ''),
    type: String(raw?.type ?? 'unknown'),
    level: raw?.level === 'error' || raw?.level === 'warning' ? raw.level : 'info',
    title: String(raw?.title ?? ''),
    body: raw?.body === undefined ? undefined : String(raw.body),
    sourceId: raw?.sourceId === undefined ? undefined : String(raw.sourceId),
    key: raw?.key === undefined ? undefined : String(raw.key),
    createdAt: String(raw?.createdAt ?? ''),
    updatedAt: String(raw?.updatedAt ?? ''),
    read: !!raw?.read,
  }
}

function loadAll(): Notification[] {
  const p = getStorePath()
  if (!fs.existsSync(p)) return []
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (!Array.isArray(raw)) return []
    return raw.map(normalize)
  } catch {
    return []
  }
}

function saveAll(list: Notification[]): void {
  const p = getStorePath()
  atomicWriteBackup(p, JSON.stringify(list, null, 2))
}

function dedupKey(n: { type: string; sourceId?: string; key?: string }): string {
  return `${n.type}|${n.sourceId ?? ''}|${n.key ?? ''}`
}

// ── 忽略名单（muted）────────────────────────────────────────────────────
// 用户主动删掉某条通知 = 表达「别再提示我这件事」。若只删记录不记条件，
// 下一轮扫描会照原条件把它重建出来（"删了又复活"）。
// 这里把 dedupKey 记入忽略表，pushNotification 见到直接跳过。
// 事件本身再变化（如截止日改了导致 key 变）会被视为新事件，不受影响。
function getMutedPath(): string {
  const dir = path.dirname(getStorePath())
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'muted.json')
}

/** 静音时长：删除后 **7 天**自动恢复提醒（2026-10-01 用户拍板：不再永久拉黑）。
 *  此前是永久拉黑且无任何恢复入口 —— 用户点过一次 🗑，同类事件从此永远静默，自己还察觉不到。 */
export const MUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 测试注入：静音时长。设成负值可立刻验证「到期恢复」，不必等 7 天。 */
let muteTtlMs = MUTE_TTL_MS
export function _setMuteTtlForTest(ms: number): void { muteTtlMs = ms }

interface MutedFile { keys?: string[]; exp?: Record<string, string> }

/** 忽略表：key → 过期时刻（ms）。过期后自动从表里消失 = 提醒恢复。 */
function loadMuted(): Map<string, number> {
  try {
    const raw: MutedFile = JSON.parse(fs.readFileSync(getMutedPath(), 'utf-8'))
    const now = Date.now()
    const m = new Map<string, number>()
    const keys = Array.isArray(raw?.keys) ? raw.keys.map(String) : []
    const exp = raw?.exp && typeof raw.exp === 'object' ? raw.exp : {}
    let renew = false
    for (const k of keys) {
      const e = exp[k] ? Date.parse(String(exp[k])) : NaN
      if (!isNaN(e)) {
        if (e > now) m.set(k, e)          // 未过期 → 继续静音
        // 过期 → 不进表 = 恢复提醒
      } else {
        // 老格式条目（永久静音时代留下的，没有过期时间）：补一次 TTL 后写回，
        // 免得历史拉黑永久卡住；只在首次遇到时写，之后 exp 里就有值了。
        m.set(k, now + muteTtlMs)
        renew = true
      }
    }
    if (renew) saveMuted(m)
    return m
  } catch {
    return new Map()
  }
}

function saveMuted(m: Map<string, number>): void {
  const keys = [...m.keys()].sort()
  const exp: Record<string, string> = {}
  for (const [k, v] of m) exp[k] = new Date(v).toISOString()
  const p = getMutedPath()
  atomicWriteBackup(p, JSON.stringify({ keys, exp }, null, 2))
}

/** 查看当前生效中的忽略表（供设置页 / 诊断用；已过期的不算） */
export function listMuted(): string[] {
  return [...loadMuted().keys()].sort()
}

/** 清空忽略表：此后被忽略的事件会重新提示 */
export function unmuteAll(): number {
  const keys = loadMuted()
  saveMuted(new Map())
  return keys.size
}

/** 幂等推送：同 type+sourceId+key 只留一条，重复推送刷新内容不重弹。
 *  命中忽略名单（用户删过这条）时直接跳过：created=false / muted=true。 */
export function pushNotification(input: PushInput): { notification: Notification | null; created: boolean; muted?: boolean } {
  const list = loadAll()
  const dk = dedupKey(input)
  if (loadMuted().has(dk)) return { notification: null, created: false, muted: true }
  const now = new Date().toISOString()
  const existing = list.find(n => dedupKey(n) === dk)
  if (existing) {
    existing.title = input.title
    existing.body = input.body
    existing.level = input.level ?? existing.level
    existing.updatedAt = now
    saveAll(list)
    return { notification: existing, created: false }
  }
  const n: Notification = {
    id: `ntf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: input.type,
    level: input.level ?? 'info',
    title: input.title,
    body: input.body,
    sourceId: input.sourceId,
    key: input.key,
    createdAt: now,
    updatedAt: now,
    read: false,
  }
  list.unshift(n)
  saveAll(list)
  return { notification: n, created: true }
}

export function listNotifications(filter?: { unreadOnly?: boolean }): Notification[] {
  let list = loadAll()
  if (filter?.unreadOnly) list = list.filter(n => !n.read)
  return list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export function getUnreadCount(): number {
  return loadAll().filter(n => !n.read).length
}

export function markRead(id: string): boolean {
  const list = loadAll()
  const n = list.find(x => x.id === id)
  if (!n) return false
  n.read = true
  n.updatedAt = new Date().toISOString()
  saveAll(list)
  return true
}

export function markAllRead(): number {
  const list = loadAll()
  let c = 0
  for (const n of list) {
    if (!n.read) {
      n.read = true
      c++
    }
  }
  if (c) saveAll(list)
  return c
}

export function deleteNotification(id: string): boolean {
  const list = loadAll()
  const idx = list.findIndex(x => x.id === id)
  if (idx < 0) return false
  const [removed] = list.splice(idx, 1)
  saveAll(list)
  // 删除 = 用户明确表示「别再提示我这件事」，记入忽略表，否则下一轮扫描会原样重建。
  // 静音 **7 天后自动恢复**（2026-10-01 用户拍板，不再是永久拉黑）。
  const muted = loadMuted()
  muted.set(dedupKey(removed), Date.now() + muteTtlMs)
  saveMuted(muted)
  return true
}

/** 清空全部（含未读），用于「清空历史」 */
export function clearAll(): number {
  const list = loadAll()
  const c = list.length
  saveAll([])
  return c
}

/** 事件消失时清掉对应通知（解析错误被修复、任务进了回收站、待办被删等）。
 *
 *  此前是「把 read 置 true」，于是列表里长期堆着一批已读、却永远不会消失的
 *  「僵尸通知」—— 用户看到的现象就是"删了还在 / 已读了还挂在列表里"。
 *  事件本身已经不存在，通知不该继续占位，所以改为直接删除。计数语义不变。 */
export function resolveNotifications(type: string, sourceId?: string): number {
  const list = loadAll()
  const kept = list.filter(n => !(n.type === type && (sourceId === undefined || n.sourceId === sourceId)))
  const c = list.length - kept.length
  if (c) saveAll(kept)
  return c
}

/** 超量淘汰：已读最旧优先 */
export function prune(): number {
  const list = loadAll()
  if (list.length <= MAX_NOTIFICATIONS) return 0
  const sorted = [...list].sort((a, b) =>
    (a.read !== b.read) ? (a.read ? -1 : 1) : (a.updatedAt < b.updatedAt ? -1 : 1)
  )
  const drop = new Set(sorted.slice(0, list.length - MAX_NOTIFICATIONS).map(n => n.id))
  const kept = list.filter(n => !drop.has(n.id))
  saveAll(kept)
  return drop.size
}

/** 重置模块级状态（测试用） */
// ===== Added for 2026-10-08: notification age-based cleanup =====
/** 已读 info/warning 超过 N 天后自动清理。error 永不清理（用户拍板 10-08）。 */
const EXPIRY_MS = 30 * 24 * 60 * 60 * 1000
let expiryMs = EXPIRY_MS
/** 测试注入：清理阈值。设成负值可立刻验证「到期清理」，不必等 30 天。 */
export function _setExpiryForTest(ms: number): void { expiryMs = ms }

/**
 * 清理超期通知：
 *  - 必须是已读（未读不清理）
 *  - level 不是 error（error 永不清理）
 *  - updatedAt 距今超过 EXPIRY_MS
 * 返回清理条数。
 */
export function cleanupExpired(now = new Date()): number {
  const list = loadAll()
  const cutoff = now.getTime() - expiryMs
  const kept = list.filter(n => {
    if (!n.read) return true          // 未读不清理
    if (n.level === 'error') return true  // error 永不清理
    const t = Date.parse(n.updatedAt || n.createdAt)
    if (isNaN(t)) return true          // 无法解析 = 保留
    return t >= cutoff                 // 未超期 = 保留
  })
  const c = list.length - kept.length
  if (c) saveAll(kept)
  return c
}
export function _resetForTest(): void {
  /* 存储即文件，无内存态；保留空实现以对称 */
}
