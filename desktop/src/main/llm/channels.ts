/**
 * BYOK 多通道 · 存储（0.6.0 第 2 批 · 2026-11-02）
 *
 * 为什么不改 `llm-config.json` 的结构：那个文件是"主通道"的落点，已被设置页、余额查询、
 * 花销统计、`planDraft`、`archAi` 好几处按**单通道**读。往里塞数组 = 一次性动五条调用链。
 *
 * 所以：**主通道继续留在 `llm-config.json`（零改动），备用通道存 `llm-channels.json`**，
 * 读的时候两边合成一条降级链（主通道永远排第一）。想加第二家供应商，只影响这一个新文件。
 *
 * 一条纪律：**密钥只进主进程**。这个文件不进渲染层，`getChannelsForRenderer` 只给掩码。
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { atomicWrite } from '../data'
import { getConfig, isMaskedKey } from './config'
import type { ChannelLike } from '../../shared/llmChannel'

export interface StoredChannel {
  id: string
  label: string
  baseUrl: string
  apiKey: string
  model: string
  enabled: boolean
}

/** 渲染层能看到的形态：密钥只给"有没有 + 提示串" */
export interface ChannelView {
  id: string
  label: string
  baseUrl: string
  model: string
  enabled: boolean
  hasApiKey: boolean
  keyHint: string
  /** 这条是主通道（来自 llm-config.json）—— 主通道不能在这里删 */
  primary: boolean
}

function channelsPath(): string {
  return path.join(app.getPath('userData'), 'llm-channels.json')
}

function s(v: unknown): string {
  return String(v ?? '').trim()
}

/** 掩码展示（与 config.keyHint 同口径，这里不重复实现，直接借用主通道那套） */
export { keyHint } from './config'

function normalizeOne(raw: any, i: number): StoredChannel | null {
  if (!raw || typeof raw !== 'object') return null
  const id = s(raw.id) || `backup-${i + 1}`
  if (id === 'main') return null   // main 由 llm-config.json 提供，不许在备用文件里伪造
  return {
    id,
    label: s(raw.label) || `备用通道 ${i + 1}`,
    baseUrl: s(raw.baseUrl).replace(/\/+$/, ''),
    apiKey: s(raw.apiKey),
    model: s(raw.model),
    enabled: raw.enabled === false ? false : true,
  }
}

/** 读备用通道。文件不存在 = 没有备用（不是错误） */
export function loadBackupChannels(): StoredChannel[] {
  const p = channelsPath()
  if (!fs.existsSync(p)) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.channels) ? parsed.channels : [])
    const out: StoredChannel[] = []
    const seen = new Set<string>()
    arr.forEach((raw: any, i: number) => {
      const one = normalizeOne(raw, i)
      if (!one || seen.has(one.id)) return
      seen.add(one.id)
      out.push(one)
    })
    return out
  } catch (e) {
    // 坏文件不静默：备份后当"没有备用通道"，否则降级链会拿一条读不出密钥的通道去试
    try { fs.renameSync(p, `${p}.bad-${Date.now()}`) } catch { /* 备份失败也不挡启动 */ }
    console.warn(`[llm] 备用通道配置解析失败(${(e as Error).message})，已备份`)
    return []
  }
}

function persist(list: StoredChannel[]): void {
  atomicWrite(channelsPath(), JSON.stringify({ channels: list }, null, 2), 0o600)
}

/**
 * 主通道 + 备用通道 = 一条链。
 * 主通道永远排第一（`primaryId='main'`），备用按文件里的顺序。
 */
export function effectiveChannels(): { channels: ChannelLike[]; primaryId: string } {
  const cfg = getConfig()
  const main: ChannelLike = {
    id: 'main',
    label: '主通道',
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    enabled: true,
  }
  return { channels: [main, ...loadBackupChannels()], primaryId: 'main' }
}

/** 回渲染层：密钥一律掩码；主通道那条标明 primary（不可删） */
export function getChannelsForRenderer(): { channels: ChannelView[]; primaryId: string } {
  const cfg = getConfig()
  const backups = loadBackupChannels()
  const view: ChannelView[] = [{
    id: 'main',
    label: '主通道',
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    enabled: true,
    hasApiKey: !!cfg.apiKey,
    keyHint: cfg.apiKey ? keyHintOf(cfg.apiKey) : '',
    primary: true,
  }]
  for (const b of backups) {
    view.push({
      id: b.id, label: b.label, baseUrl: b.baseUrl, model: b.model, enabled: b.enabled,
      hasApiKey: !!b.apiKey, keyHint: b.apiKey ? keyHintOf(b.apiKey) : '', primary: false,
    })
  }
  return { channels: view, primaryId: 'main' }
}

function keyHintOf(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return key[0] + '*'.repeat(Math.max(0, key.length - 2)) + key.slice(-1)
  return `${key.slice(0, 3)}${'*'.repeat(Math.max(3, key.length - 7))}${key.slice(-4)}`
}

export interface UpsertInput {
  id?: string
  label?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  enabled?: boolean
}

/**
 * 增 / 改一条备用通道。
 * ⚠ 密钥防线与主通道同口径：**掩码 / 空串 = 未修改**，绝不覆盖已存密钥。
 */
export function upsertBackupChannel(input: UpsertInput): { ok: boolean; error?: string; channels?: StoredChannel[] } {
  const id = s(input?.id) || `backup-${Date.now().toString(36)}`
  if (id === 'main') return { ok: false, error: '主通道请在“模型通道”那块改，不在这里' }
  const list = loadBackupChannels()
  const i = list.findIndex((c) => c.id === id)
  const base: StoredChannel = i >= 0
    ? { ...list[i] }
    : { id, label: s(input?.label) || `备用通道 ${list.length + 1}`, baseUrl: '', apiKey: '', model: '', enabled: true }

  if (typeof input?.label === 'string' && s(input.label)) base.label = s(input.label)
  if (typeof input?.baseUrl === 'string') base.baseUrl = s(input.baseUrl).replace(/\/+$/, '')
  if (typeof input?.model === 'string') base.model = s(input.model)
  if (typeof input?.enabled === 'boolean') base.enabled = input.enabled
  // 掩码/空 = 未修改
  if (!isMaskedKey(input?.apiKey)) base.apiKey = s(input.apiKey)

  if (i >= 0) list[i] = base
  else {
    if (list.length >= 5) return { ok: false, error: '备用通道最多 5 条 —— 再多就不叫降级链了' }
    list.push(base)
  }
  persist(list)
  return { ok: true, channels: list }
}

export function removeBackupChannel(id: string): { ok: boolean; error?: string; channels?: StoredChannel[] } {
  const want = s(id)
  if (!want || want === 'main') return { ok: false, error: '主通道不能删（它是 llm-config.json 那份）' }
  const list = loadBackupChannels()
  const next = list.filter((c) => c.id !== want)
  if (next.length === list.length) return { ok: false, error: `没有这条备用通道：${want}` }
  persist(next)
  return { ok: true, channels: next }
}
