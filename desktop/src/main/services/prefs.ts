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
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
    fs.renameSync(tmp, p)
  } catch (e: any) {
    // 写失败不影响 UI：缓存里还有一份，下次启动会重试
    console.error('[prefs] 写入失败：', e?.message || e)
  }
  return next
}
