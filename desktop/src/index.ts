import { app, BrowserWindow, Tray, Menu } from 'electron'
import * as path from 'path'
import { registerIpcHandlers } from './main/ipc'
import { startMCPServer, stopMCPServer } from './main/mcp'
import { initUpdater, registerUpdaterIpc } from './main/updater'
import { startScheduler } from './main/backup/scheduler'
import { startScanner, stopScanner } from './main/services/notifier'

// ── userData 目录统一（发版阻塞项，2026-09-20 修复）──
// Electron 默认 userData 在打包态取 productName（= %APPDATA%/方寸），
// dev 态取 package.json name（= %APPDATA%/fangcun-desktop）——
// 两侧不一致会让安装版的 LLM 配置/通知/备份状态读不到或重新初始化。
// 统一固定为 fangcun-desktop（dev 态真实数据所在，保持连续性）。
// 必须在 app ready 之前执行；已核实全部消费方（llm/config、backup/config、
// launchpad/config、data/index）均为函数内懒调用 getPath，import 阶段无读取。
app.setPath('userData', path.join(app.getPath('appData'), 'fangcun-desktop'))

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
