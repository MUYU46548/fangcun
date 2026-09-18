import { app, BrowserWindow, Tray, Menu, dialog } from 'electron'
import * as path from 'path'
import { registerIpcHandlers } from './ipc'
import { registerBackupIpcHandlers } from './backup-ipc'
import { startScheduler } from './backup/scheduler'
import { isFirstRun } from './data'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: '方寸',
    icon: path.join(__dirname, '../../../public/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../../dist/renderer/index.html'))
  }

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
}

function createTray(): void {
  const iconPath = path.join(__dirname, '../../../public/icon.ico')
  tray = new Tray(iconPath)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开方寸',
      click: () => mainWindow?.show(),
    },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])

  tray.setToolTip('方寸 tegula')
  tray.setContextMenu(contextMenu)
  tray.on('click', () => mainWindow?.show())
}

app.whenReady().then(() => {
  // IPC 只注册一次 —— 放在 createWindow 之外，避免重复注册抛 handler 冲突
  registerIpcHandlers()
  registerBackupIpcHandlers()
  createWindow()
  createTray()
  // 静默备份调度：启动后延迟执行，失败会广播到窗口并（连续失败时）弹系统通知
  try {
    startScheduler()
  } catch (e) {
    console.error('[backup] 调度启动失败:', (e as Error).message)
  }
})

app.on('window-all-closed', () => {
  // Windows: tray keeps app alive
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  } else {
    mainWindow?.show()
  }
})
