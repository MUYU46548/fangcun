import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { atomicWrite } from '../data'

export interface LaunchApp {
  id: string
  name: string
  icon?: string
  path: string
  cmd: string
  args?: string[]
  /**
   * @deprecated 2026-10-15 **不再使用、也不再让用户填**。
   *
   * 暮雨原话：「端口永远是记不住的，不要指望根据端口去配置。你永远不知道用户有什么端口。」
   * 之前把 `port` 当**配置项**（"这个应用对外提供哪个端口"），于是出现了那条旧案：
   * vite 的 8090 被登在打包 exe 上 → 点「启动」永远"空闲" → 又被读成"启动台坏了"。
   *
   * 新口径：**端口是观测结果，不是配置项**。用户一个端口都不用填 ——
   * 启动一个应用时前后各取一次监听表，**diff 出来的就是它开的端口**（见 `observedPorts`）。
   * 字段保留只为读老文件不报错；UI 不展示、不写入。
   */
  port?: number
  /** 上次启动时**观测到**它新开的端口（自动记录，用户不需要填，也永远不需要记） */
  observedPorts?: number[]
  /** 上次观测时间（ISO） */
  observedAt?: string
  description?: string
}

const CONFIG_FILENAME = 'apps.json'

function getConfigPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILENAME)
}

/**
 * 定位示例配置。
 * 原实现用 `__dirname/../public`，而 __dirname 是 dist/main/launchpad，
 * 该路径指向 dist/main/public（不存在），示例永远加载不到。改为多候选探测。
 */
function getSamplePath(): string | null {
  const candidates: string[] = []
  try {
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'public', 'apps.json.sample'))
    }
  } catch { /* 非打包环境无此属性 */ }
  try {
    candidates.push(path.join(app.getAppPath(), 'public', 'apps.json.sample'))
  } catch { /* ignore */ }
  // 开发环境：dist/main/launchpad → desktop/
  candidates.push(path.join(__dirname, '..', '..', '..', 'public', 'apps.json.sample'))
  candidates.push(path.join(process.cwd(), 'public', 'apps.json.sample'))

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch { /* 继续找 */ }
  }
  return null
}

export function loadApps(): LaunchApp[] {
  const configPath = getConfigPath()
  
  if (!fs.existsSync(configPath)) {
    // Try to initialize from sample
    const samplePath = getSamplePath()
    if (samplePath) {
      try {
        const sample = fs.readFileSync(samplePath, 'utf-8')
        fs.writeFileSync(configPath, sample, 'utf-8')
      } catch (e) {
        console.warn(`[launchpad] 示例配置初始化失败：${(e as Error).message}`)
      }
    }
    return []
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    return Array.isArray(data?.apps) ? data.apps : []
  } catch (e) {
    console.warn(`[launchpad] apps.json 解析失败：${(e as Error).message}`)
    return []
  }
}

export function saveApps(apps: LaunchApp[]): void {
  const configPath = getConfigPath()
  // 原子写：避免写一半崩溃后 apps.json 变成非法 JSON（会让启动台静默清空）
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  atomicWrite(configPath, JSON.stringify({ apps }, null, 2))
}

export function addApp(newApp: LaunchApp): LaunchApp[] {
  const apps = loadApps()
  const id = newApp.name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now().toString(36)
  apps.push({ ...newApp, id })
  saveApps(apps)
  return apps
}

export function updateApp(id: string, updates: Partial<LaunchApp>): LaunchApp[] {
  let apps = loadApps()
  apps = apps.map(a => a.id === id ? { ...a, ...updates } : a)
  saveApps(apps)
  return apps
}

export function removeApp(id: string): LaunchApp[] {
  let apps = loadApps()
  apps = apps.filter(a => a.id !== id)
  saveApps(apps)
  return apps
}

export function getAppConfigPath(): string {
  return getConfigPath()
}

/**
 * 记下「这个应用启动后新开了哪些端口」（2026-10-15）。
 *
 * 为什么是"记下"而不是"让用户填"：端口号是记不住的，而且用户也不可能预先知道一个应用会开什么端口。
 * 唯一可靠的来源是**观测**：启动前取一次监听表、启动后再取一次，差集就是它的端口。
 *
 * 合并策略：**并集去重 + 最近一次排前面**（同一个应用换端口=常见事，历史不该丢，
 * 但"最近开的"最可能是现在有效的）。`port`（旧字段）不再写入 —— 让它自然从新文件里消失。
 */
export function recordObservedPorts(id: string, ports: number[], at?: string): LaunchApp[] {
  const clean = Array.from(new Set((ports || []).filter(p => Number.isInteger(p) && p > 0 && p <= 65535)))
  const apps = loadApps()
  const next = apps.map(a => {
    if (a.id !== id) return a
    const prev = Array.isArray(a.observedPorts) ? a.observedPorts.filter(p => Number.isInteger(p)) : []
    const merged = clean.concat(prev.filter(p => !clean.includes(p)))
    const out: LaunchApp = { ...a, observedPorts: merged.slice(0, 20), observedAt: at || new Date().toISOString() }
    delete (out as any).port
    return out
  })
  saveApps(next)
  return next
}
