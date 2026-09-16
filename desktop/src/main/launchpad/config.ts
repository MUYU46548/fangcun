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

function getSamplePath(): string {
  // In dev: public/apps.json.sample
  // In prod: resources/apps.json.sample
  return path.join(__dirname, '../public/apps.json.sample')
}

export function loadApps(): LaunchApp[] {
  const configPath = getConfigPath()
  
  if (!fs.existsSync(configPath)) {
    // Try to initialize from sample
    const samplePath = getSamplePath()
    if (fs.existsSync(samplePath)) {
      const sample = fs.readFileSync(samplePath, 'utf-8')
      fs.writeFileSync(configPath, sample, 'utf-8')
    }
    return []
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    return data.apps || []
  } catch {
    return []
  }
}

export function saveApps(apps: LaunchApp[]): void {
  const configPath = getConfigPath()
  fs.writeFileSync(configPath, JSON.stringify({ apps }, null, 2), 'utf-8')
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
