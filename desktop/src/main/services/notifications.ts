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
import { getDataDir } from '../data'

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
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf-8')
  fs.renameSync(tmp, p)
}

function dedupKey(n: { type: string; sourceId?: string; key?: string }): string {
  return `${n.type}|${n.sourceId ?? ''}|${n.key ?? ''}`
}

/** 幂等推送：同 type+sourceId+key 只留一条，重复推送刷新内容不重弹 */
export function pushNotification(input: PushInput): { notification: Notification; created: boolean } {
  const list = loadAll()
  const dk = dedupKey(input)
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
  list.splice(idx, 1)
  saveAll(list)
  return true
}

/** 清空全部（含未读），用于「清空历史」 */
export function clearAll(): number {
  const list = loadAll()
  const c = list.length
  saveAll([])
  return c
}

/** 事件消失时自动消解未读通知（如解析错误被修复、待办被删除） */
export function resolveNotifications(type: string, sourceId?: string): number {
  const list = loadAll()
  let c = 0
  for (const n of list) {
    if (n.type === type && (sourceId === undefined || n.sourceId === sourceId) && !n.read) {
      n.read = true
      n.updatedAt = new Date().toISOString()
      c++
    }
  }
  if (c) saveAll(list)
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
export function _resetForTest(): void {
  /* 存储即文件，无内存态；保留空实现以对称 */
}
