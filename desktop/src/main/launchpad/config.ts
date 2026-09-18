import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

export interface LaunchApp {
  id: string
  name: string
  icon?: string
  path: string
  cmd: string
  args?: string[]
  port?: number
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
  const tmp = `${configPath}.tmp`
  // 原子写：避免写一半崩溃后 apps.json 变成非法 JSON（会让启动台静默清空）
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify({ apps }, null, 2), 'utf-8')
  fs.renameSync(tmp, configPath)
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
