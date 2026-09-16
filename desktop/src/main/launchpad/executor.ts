import { spawn, exec } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { shell } from 'electron'
import { LaunchApp } from './config'

export interface LaunchResult {
  ok: boolean
  pid?: number
  message: string
}

export function launchApp(appConfig: LaunchApp): LaunchResult {
  try {
    // Check if path exists
    const appPath = appConfig.cmd
    if (!fs.existsSync(appPath)) {
      return { ok: false, message: `路径不存在: ${appPath}` }
    }

    const args = appConfig.args || []
    const cwd = appConfig.cmd.includes('\\') || appConfig.cmd.includes('/')
      ? path.dirname(appConfig.cmd)
      : process.cwd()

    const child = spawn(appPath, args, {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })

    child.unref()

    return {
      ok: true,
      pid: child.pid,
      message: `已启动: ${appConfig.name} (PID ${child.pid})`,
    }
  } catch (e) {
    return {
      ok: false,
      message: `启动失败: ${(e as Error).message}`,
    }
  }
}

export function openFolder(folderPath: string): LaunchResult {
  try {
    shell.openPath(folderPath)
    return { ok: true, message: `已打开: ${folderPath}` }
  } catch (e) {
    return { ok: false, message: `打开失败: ${(e as Error).message}` }
  }
}

export function openUrl(url: string): LaunchResult {
  try {
    shell.openExternal(url)
    return { ok: true, message: `已打开: ${url}` }
  } catch (e) {
    return { ok: false, message: `打开失败: ${(e as Error).message}` }
  }
}
