/**
 * UI 偏好持久化（userData/prefs.json）
 *
 * 为什么不能只放 localStorage（014，2026-09-25 用户报「执行 Agent 预设丢失」）：
 *   localStorage 绑定**起源**。dev 的 vite host 从 `localhost` 改成 `127.0.0.1` 就等于换了 origin，
 *   用户攒的 Agent 预设当场清空；打包版是 `file://`，与 dev 又是另一套。
 *   而预设是**用户资产**，不是缓存 —— 不能因为换了访问方式就没了。
 *
 * 约定：主进程这个文件是**真身**，localStorage 降级为读缓存（两边都写，读不到真身才用缓存）。
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { atomicWriteBackup } from '../data'

const PREFS_FILENAME = 'prefs.json'

export type Prefs = Record<string, unknown>

export function getPrefsPath(): string {
  return path.join(app.getPath('userData'), PREFS_FILENAME)
}

/** 读全部偏好。文件不存在或 JSON 坏了都回退空对象，**绝不抛**（UI 启动路径不可被它拖垮）。 */
export function getPrefs(): Prefs {
  try {
    const data = JSON.parse(fs.readFileSync(getPrefsPath(), 'utf-8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    return data as Prefs
  } catch {
    return {}
  }
}

export function getPref(key: string): unknown {
  return getPrefs()[key]
}

/** 合并写入单个键，返回写入后的完整偏好。先写临时文件再 rename（原子替换，半截文件不会覆盖好文件）。 */
export function setPref(key: string, value: unknown): Prefs {
  const next: Prefs = { ...getPrefs(), [key]: value }
  try {
    const p = getPrefsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    atomicWriteBackup(p, JSON.stringify(next, null, 2))
  } catch (e: any) {
    // 写失败不影响 UI：缓存里还有一份，下次启动会重试
    console.error('[prefs] 写入失败：', e?.message || e)
  }
  return next
}

/**
 * 一次写入**多个键**，并**回读校验**，返回"到底存住了没有"。
 *
 * 为什么要有这个（2026-10-05 用户实测）：
 *   · 用户点「保存」，界面弹"已保存"，但 `prefs.json` 里 **四个键只落了两个**（两个数组键没有）。
 *     写盘失败被 try/catch 吞掉 → 界面说的和磁盘上的不是一回事 = 假成功。
 *   · 一次 IPC 写完多个键，既省掉多次"读全量→整文件替换"，也让成功/失败成为**可回答的问题**。
 * 回读以**磁盘**为准（不信内存对象），任何键对不上就如实报出来，由界面告诉用户。
 */
export function setPrefs(patch: Prefs): { ok: boolean; written: string[]; error?: string } {
  const keys = Object.keys(patch || {})
  if (!keys.length) return { ok: true, written: [] }
  const next: Prefs = { ...getPrefs(), ...patch }
  try {
    const p = getPrefsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    atomicWriteBackup(p, JSON.stringify(next, null, 2))
  } catch (e: any) {
    return { ok: false, written: [], error: `写入失败：${e?.message || e}` }
  }
  try {
    const back = JSON.parse(fs.readFileSync(getPrefsPath(), 'utf-8')) as Prefs
    const bad = keys.filter(k => JSON.stringify(back?.[k]) !== JSON.stringify(patch[k]))
    if (bad.length) {
      return { ok: false, written: keys.filter(k => !bad.includes(k)), error: `这些键没写进文件：${bad.join('、')}` }
    }
    return { ok: true, written: keys }
  } catch (e: any) {
    return { ok: false, written: [], error: `写入后回读失败：${e?.message || e}` }
  }
}
