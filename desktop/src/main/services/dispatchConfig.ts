/**
 * 派单配置 + 审计的**主进程唯一读写口**（2026-11-21 · 卡 `…闸要下在-e4264e6c`）。
 *
 * 为什么必须有这个文件：
 *   · 方寸设置页、写侧闸门、health（`mcp:dshPlugin` / `dispatch:settings`）三处都要
 *     "现在到底开没开、冷却几秒、今天已几单"；
 *   · 如果每一处各自读文件、各自算一遍，迟早出现两个数字（这条管子上已经犯过一次：
 *     `760ab7f3` 与 `9d8bf98a` 同日两个默认口径）。
 *
 * 所以：**这里算一次，别处只渲染。**
 *
 * ## 真源
 *
 *     <数据根>/.dispatch-dsh/dispatch-settings.json
 *
 * 插件（`dsh-fangcun/lib/dispatch.js`）读同一个文件、用同一套判据（JS 版，
 * 跨语言契约测试逐项比对）。文件不存在 / 读坏了 / 字段非法 → **按默认值（关）**。
 *
 * ## 审计
 *
 * `audit.jsonl` 一行一条。两条写入口：
 *   · 本模块 `appendDispatchAudit`（方寸写侧拒单：disabled / cooldown / daily-cap / concurrency）；
 *   · 插件消费端（签名/格式/开会话结果）。
 * 只数 `ok:true` 的算额度 —— 被拒的单不占当天额度。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getDataDir, atomicWrite } from '../data'
import {
  DISPATCH_SETTINGS_DEFAULTS,
  DISPATCH_SETTINGS_FILENAME,
  type DispatchAuditRow,
  type DispatchGate,
  type DispatchSettings,
  checkDispatch,
  normalizeDispatchSettings,
  validateDispatchSettingsPatch,
} from '../../shared/dispatchGate'

/** `<数据根>/.dispatch-dsh`（与 `contextPack.dispatchDir()` 同一口径） */
export function dispatchDirPath(): string {
  return path.join(getDataDir(), '.dispatch-dsh')
}

export function dispatchSettingsPath(): string {
  return path.join(dispatchDirPath(), DISPATCH_SETTINGS_FILENAME)
}

function dispatchAuditPath(): string {
  return path.join(dispatchDirPath(), 'audit.jsonl')
}

export interface DispatchSettingsState {
  settings: DispatchSettings
  /** 文件是否存在（false = 还在用默认值 → 默认关） */
  exists: boolean
  /** 文件存在但读不出来 / 不是对象时的那句话；正常为空串 */
  error: string
  path: string
}

/**
 * 读设置。**任何异常都落到默认值（关）**，并且把 `error` 交给调用方 ——
 * "读不出来"必须能说，但绝不能因为读不出来就放行。
 */
export function readDispatchSettingsState(): DispatchSettingsState {
  const p = dispatchSettingsPath()
  let exists = false
  try {
    exists = fs.existsSync(p)
  } catch { exists = false }
  if (!exists) {
    return { settings: { ...DISPATCH_SETTINGS_DEFAULTS }, exists: false, error: '', path: p }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        settings: { ...DISPATCH_SETTINGS_DEFAULTS }, exists: true, path: p,
        error: '设置文件不是 JSON 对象 —— 按默认值（未启用）处理',
      }
    }
    return { settings: normalizeDispatchSettings(raw), exists: true, error: '', path: p }
  } catch (e: any) {
    return {
      settings: { ...DISPATCH_SETTINGS_DEFAULTS }, exists: true, path: p,
      error: '设置文件读不出来（' + String(e?.message || e) + '）—— 按默认值（未启用）处理',
    }
  }
}

export function readDispatchSettings(): DispatchSettings {
  return readDispatchSettingsState().settings
}

/** 解析 `audit.jsonl`（坏行跳过：审计文件不能反过来卡住派单） */
export function readDispatchAudit(): DispatchAuditRow[] {
  const p = dispatchAuditPath()
  let text = ''
  try { text = fs.readFileSync(p, 'utf-8') } catch { return [] }
  const rows: DispatchAuditRow[] = []
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try {
      const row = JSON.parse(s)
      if (row && typeof row === 'object') rows.push(row as DispatchAuditRow)
    } catch { /* 坏行跳过 */ }
  }
  return rows
}

/** 追加一行审计。返回是否落盘（失败不抛 —— 审计不该挡住"已经开出的会话"）。 */
export function appendDispatchAudit(row: DispatchAuditRow): boolean {
  try {
    fs.mkdirSync(dispatchDirPath(), { recursive: true })
    const line = JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'
    fs.appendFileSync(dispatchAuditPath(), line, 'utf-8')
    return true
  } catch {
    return false
  }
}

export interface DispatchSettingsWriteResult {
  ok: boolean
  settings?: DispatchSettings
  changed?: boolean
  error?: string
  path?: string
}

/**
 * 写设置（设置页的唯一写口）。
 *
 * 校验 → 合并（只改传进来的项）→ atomicWrite → **回读核对**。
 * 回读是为了防"界面说已保存、磁盘上没变"——同一个坑 2026-10-05 在 prefs 上踩过。
 */
export function writeDispatchSettings(patch: unknown): DispatchSettingsWriteResult {
  const checked = validateDispatchSettingsPatch(patch)
  if (!checked.ok) return { ok: false, error: (checked as { ok: false; error: string }).error }
  const cur = readDispatchSettingsState()
  const next = normalizeDispatchSettings({ ...cur.settings, ...checked.patch })
  const changed = JSON.stringify(next) !== JSON.stringify(cur.settings)
  const p = cur.path
  if (!changed) return { ok: true, settings: next, changed: false, path: p }
  try {
    fs.mkdirSync(dispatchDirPath(), { recursive: true })
    atomicWrite(p, JSON.stringify(next, null, 2) + '\n')
  } catch (e: any) {
    return { ok: false, error: '设置写不进去：' + String(e?.message || e) }
  }
  const back = readDispatchSettingsState()
  if (JSON.stringify(back.settings) !== JSON.stringify(next)) {
    return {
      ok: false,
      error: '写入后回读不一致：' + (back.error || JSON.stringify(back.settings)),
      settings: back.settings,
      path: p,
    }
  }
  return { ok: true, settings: back.settings, changed: true, path: p }
}

/** 目录里还没被插件消费的派单（按项目过滤；projectId 空 = 全部） */
export function pendingDispatchCount(projectId = ''): number {
  const pid = String(projectId || '').trim()
  let names: string[] = []
  try { names = fs.readdirSync(dispatchDirPath()) } catch { return 0 }
  const re = pid ? new RegExp(`^dispatch-${pid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{14}\\.md$`) : /^dispatch-.*\.md$/
  return names.filter((n) => re.test(n)).length
}

/**
 * 这个项目上一次**写派单文件**的时刻（ms；没有就是 NaN）。
 *
 * 为什么冷却需要它：插件 8 秒才消费一次，而它的 `ok:true` 审计行要等消费成功才出现。
 * 如果冷却只认审计，DSH 关着时连点 5 次会写 5 份文件（虽然会被"同项目只留最新一份"清掉，
 * 但用户看到的是"冷却没生效"）。文件名里的 14 位时间戳就是写入时刻（UTC），
 * 直接解析，不依赖内存（重启后仍然算数）。
 */
export function lastDispatchAttemptMs(projectId: string): number {
  const pid = String(projectId || '').trim()
  if (!pid) return NaN
  const prefix = `dispatch-${pid}-`
  let names: string[] = []
  try { names = fs.readdirSync(dispatchDirPath()) } catch { return NaN }
  let max = NaN
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.md$/.exec(name.slice(prefix.length))
    if (!m) continue
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
    if (!Number.isFinite(max) || t > max) max = t
  }
  return max
}

function countRejected(): number {
  try {
    return fs.readdirSync(path.join(dispatchDirPath(), 'rejected')).filter((n) => !n.startsWith('.')).length
  } catch { return 0 }
}

export interface DispatchHealth {
  /** 真源文件 */
  file: string
  /** `file` = 读了文件；`default` = 文件不存在，用默认值（关） */
  source: 'file' | 'default'
  settings: DispatchSettings
  settingsError: string
  /** 全局视角的闸（没有具体项目 → 不判冷却；判 enabled / 日上限） */
  gate: DispatchGate
  today: number
  last?: DispatchAuditRow
  recent: DispatchAuditRow[]
  pending: number
  rejected: number
}

/**
 * health 的 `dispatch` 块：设置 + 闸 + 最近审计。
 * 设置页与 `mcp:dshPlugin` **都只渲染这一份**，不再各算一个数。
 */
export function buildDispatchHealth(now: number = Date.now()): DispatchHealth {
  const st = readDispatchSettingsState()
  const rows = readDispatchAudit()
  const gate = checkDispatch('', st.settings, rows, now)
  return {
    file: st.path,
    source: st.exists ? 'file' : 'default',
    settings: st.settings,
    settingsError: st.error,
    gate,
    today: gate.today,
    last: rows.length ? rows[rows.length - 1] : undefined,
    recent: rows.slice(-5).reverse(),
    pending: pendingDispatchCount(),
    rejected: countRejected(),
  }
}
