import { app, BrowserWindow, Tray, Menu } from 'electron'
import * as path from 'path'
import { registerIpcHandlers } from './main/ipc'
import { startMCPServer, stopMCPServer } from './main/mcp'
import { initUpdater, registerUpdaterIpc } from './main/updater'
import { startScheduler } from './main/backup/scheduler'
import { startScanner, stopScanner } from './main/services/notifier'

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
    icon: path.join(__dirname, '../public/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  registerIpcHandlers()

  // 24 寸显示器默认最大化
  mainWindow.maximize()

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'))
  }

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
}

function createTray(): void {
  const iconPath = path.join(__dirname, '../public/icon.ico')
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
  createWindow()
  createTray()
  startMCPServer()
  startScheduler()
  startScanner()
  
  // Initialize auto-updater
  initUpdater(mainWindow)
  registerUpdaterIpc()
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

app.on('before-quit', () => {
  stopMCPServer()
  stopScanner()
})
