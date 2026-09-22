/**
 * 备份 IPC — 渲染层入口
 *
 * 安全：密码只在「渲染层 → 主进程」方向出现一次，主进程立即加密存储；
 *      返回给渲染层的配置永远只有 hasPassword 布尔标记。
 */
import { ipcMain, shell, dialog, BrowserWindow } from 'electron'
import { guardedHandle } from './guarded-ipc'
import * as fs from 'fs'
import * as path from 'path'
import {
  getBackupConfig, setBackupConfig, getBackupConfigForRenderer,
  getBackupState, getBackupPaths, decryptSecret, BackupConfig,
} from './backup/config'
import {
  runBackup, listLocalBackups, listRemoteBackups, getLocalBackupDir,
  exportSnapshotTo, verifyPackage,
} from './backup'
import { getBackupStatus, rescheduleScheduler, runBackupNow } from './backup/scheduler'
import { restoreFrom, listRestoreSources } from './backup/restore'
import { WebdavClient } from './backup/webdav'

function fail(e: unknown) {
  return { ok: false as const, error: (e as Error)?.message || String(e) }
}

function tailLog(maxLines = 120): string[] {
  const { logPath } = getBackupPaths()
  if (!fs.existsSync(logPath)) return []
  try {
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
    return lines.slice(-maxLines)
  } catch {
    return []
  }
}

export function registerBackupIpcHandlers(): void {
  guardedHandle('backup:getConfig', () => {
    try {
      return { ok: true, config: getBackupConfigForRenderer() }
    } catch (e) {
      return fail(e)
    }
  })

  guardedHandle('backup:setConfig', (_e, patch: Partial<BackupConfig> & { remote?: any }) => {
    try {
      const next = setBackupConfig(patch)
      rescheduleScheduler()
      return { ok: true, config: getBackupConfigForRenderer(), _interval: next.intervalHours }
    } catch (e) {
      return fail(e)
    }
  })

  guardedHandle('backup:status', () => {
    try {
      return { ok: true, status: getBackupStatus() }
    } catch (e) {
      return fail(e)
    }
  })

  guardedHandle('backup:run', async () => {
    try {
      const result = await runBackupNow()
      if (!result) return { ok: false, error: '已有备份任务在执行中' }
      return { ok: result.ok, result }
    } catch (e) {
      return fail(e)
    }
  })

  guardedHandle('backup:runLocalOnly', async () => {
    try {
      const result = await runBackup({ trigger: 'manual', localOnly: true })
      return { ok: result.ok, result }
    } catch (e) {
      return fail(e)
    }
  })

  guardedHandle('backup:listLocal', () => {
    try {
      return { ok: true, items: listLocalBackups() }
    } catch (e) {
      return fail(e)
    }
  })

  guardedHandle('backup:listRemote', async () => {
    try {
      const items = await listRemoteBackups()
      return { ok: true, items }
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * 测试远端。允许用表单里尚未保存的地址/账号/密码；
   * password 为空则回落到已保存的密文解密结果。
   */
  guardedHandle('backup:testRemote', async (_e, input: {
    url?: string; username?: string; password?: string; allowSelfSigned?: boolean
  }) => {
    try {
      const cfg = getBackupConfig()
      const url = (input?.url || cfg.remote.url || '').trim()
      if (!url) return { ok: false, error: '请先填写 WebDAV 地址' }

      let password = input?.password || ''
      if (!password && cfg.remote.passwordEnc) {
        password = decryptSecret(cfg.remote.passwordEnc)
      }
      if (!password) return { ok: false, error: '请填写密码（或先保存一次以便加密留存）' }

      const client = new WebdavClient({
        baseUrl: url,
        username: (input?.username ?? cfg.remote.username ?? '').trim(),
        password,
        allowSelfSigned: input?.allowSelfSigned ?? cfg.remote.allowSelfSigned,
        timeoutMs: 20000,
      })
      const r = await client.test()
      return { ok: r.ok, status: r.status, detail: r.detail, url: r.url }
    } catch (e) {
      return fail(e)
    }
  })

  guardedHandle('backup:listSources', async (_e, includeRemote = false) => {
    try {
      const sources = await listRestoreSources(!!includeRemote)
      return { ok: true, ...sources }
    } catch (e) {
      return fail(e)
    }
  })

  guardedHandle('backup:restore', async (_e, source: { kind: 'local'; path: string } | { kind: 'remote'; name: string }) => {
    try {
      if (!source || (source.kind === 'local' && !source.path) || (source.kind === 'remote' && !source.name)) {
        return { ok: false, error: '恢复来源参数不完整' }
      }
      const r = await restoreFrom(source)
      return { ok: r.ok, ...r }
    } catch (e) {
      return fail(e)
    }
  })

  guardedHandle('backup:state', () => {
    try {
      return { ok: true, state: getBackupState(), nextRunAt: getBackupStatus().nextRunAt }
    } catch (e) {
      return fail(e)
    }
  })

  guardedHandle('backup:log', (_e, maxLines?: number) => {
    try {
      return { ok: true, lines: tailLog(maxLines || 120) }
    } catch (e) {
      return fail(e)
    }
  })

  guardedHandle('backup:openDir', async () => {
    try {
      const dir = getLocalBackupDir()
      fs.mkdirSync(dir, { recursive: true })
      await shell.openPath(dir)
      return { ok: true, dir }
    } catch (e) {
      return fail(e)
    }
  })

  /** 供 UI 展示：本地备份目录（只读展示，不触发副作用） */
  guardedHandle('backup:localDir', () => {
    try {
      return { ok: true, dir: getLocalBackupDir(), exists: fs.existsSync(getLocalBackupDir()) }
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * 导出备份到指定目录（网盘同步文件夹 / U 盘 / 任意路径）。
   * 不弹窗时由调用方传 dir；传空则弹出目录选择框。
   */
  guardedHandle('backup:exportTo', async (e, input: { dir?: string; includeTool?: boolean } = {}) => {
    try {
      let dir = (input.dir || '').trim()
      if (!dir) {
        const win = BrowserWindow.fromWebContents(e.sender)
        const r = win
          ? await dialog.showOpenDialog(win, {
              title: '选择导出目录（例如网盘同步文件夹）',
              properties: ['openDirectory', 'createDirectory'],
            })
          : await dialog.showOpenDialog({
              title: '选择导出目录（例如网盘同步文件夹）',
              properties: ['openDirectory', 'createDirectory'],
            })
        if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
        dir = r.filePaths[0]
      }
      const result = exportSnapshotTo(dir, { includeTool: input.includeTool !== false })
      return { ok: result.ok, result }
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * 校验任意位置的备份包（含手动上传后又下载回来的）。
   * 不传 path 则弹出文件选择框。
   */
  guardedHandle('backup:verifyPackage', async (e, zipPath?: string) => {
    try {
      let target = (zipPath || '').trim()
      if (!target) {
        const win = BrowserWindow.fromWebContents(e.sender)
        const opts = {
          title: '选择要校验的备份包',
          properties: ['openFile' as const],
          filters: [{ name: '方寸备份包', extensions: ['zip'] }],
        }
        const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
        target = r.filePaths[0]
      }
      const v = verifyPackage(target)
      return { ok: v.ok, path: target, ...v }
    } catch (e) {
      return fail(e)
    }
  })

  /** 选择任意 zip 包并恢复（路径由渲染层确认框拦一道） */
  guardedHandle('backup:pickRestoreFile', async (e) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender)
      const opts = {
        title: '选择要恢复的备份包',
        properties: ['openFile' as const],
        filters: [{ name: '方寸备份包', extensions: ['zip'] }],
        defaultPath: getLocalBackupDir(),
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
      return { ok: true, path: r.filePaths[0] }
    } catch (e) {
      return fail(e)
    }
  })

  /** 选择备份存放目录（改为网盘同步文件夹，自动备份直接落那里） */
  guardedHandle('backup:pickDir', async (e) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender)
      const opts = {
        title: '选择备份存放目录',
        properties: ['openDirectory' as const, 'createDirectory' as const],
        defaultPath: getLocalBackupDir(),
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
      return { ok: true, dir: r.filePaths[0] }
    } catch (e) {
      return fail(e)
    }
  })
}
