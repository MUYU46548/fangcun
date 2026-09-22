import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow, ipcMain } from 'electron'
import log from 'electron-log'

let mainWindow: BrowserWindow | null = null
let isChecking = false
let isDownloading = false

export function initUpdater(window: BrowserWindow): void {
  mainWindow = window

  autoUpdater.logger = log
  autoUpdater.autoDownload = false // 手动确认后下载
  autoUpdater.autoInstallOnAppQuit = true // 退出时自动安装

  autoUpdater.on('update-available', (info) => {
    log.info(`发现新版本: ${info.version}`)
    isChecking = false
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:available', {
        version: info.version,
        releaseNotes: info.releaseNotes,
        releaseDate: info.releaseDate,
      })
    }
  })

  autoUpdater.on('update-not-available', () => {
    log.info('当前已是最新版本')
    isChecking = false
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:not-available', {})
    }
  })

  autoUpdater.on('download-progress', (progress) => {
    log.info(`下载进度: ${progress.percent}%`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:progress', {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      })
    }
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info('更新下载完成')
    isDownloading = false
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:downloaded', {
        version: info.version,
      })
    }
  })

  autoUpdater.on('error', (error) => {
    log.error('更新错误:', error.message)
    isChecking = false
    isDownloading = false
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:error', {
        message: error.message,
      })
    }
  })
}

export function checkForUpdates(): void {
  if (isChecking || isDownloading) return
  isChecking = true
  autoUpdater.checkForUpdates()
}

export function downloadUpdate(): void {
  if (isDownloading) return
  isDownloading = true
  autoUpdater.downloadUpdate()
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall()
}

// IPC 桥接
export function registerUpdaterIpc(): void {
  ipcMain.handle('app:getVersion', () => app.getVersion())
  ipcMain.handle('update:check', () => {
    checkForUpdates()
  })

  ipcMain.handle('update:download', () => {
    downloadUpdate()
  })

  ipcMain.handle('update:quitAndInstall', () => {
    quitAndInstall()
  })
}
