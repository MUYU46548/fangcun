import { app, BrowserWindow, Tray, Menu } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { registerIpcHandlers } from './main/ipc'
import { registerBackupIpcHandlers } from './main/backup-ipc'
import { registeredChannels } from './main/guarded-ipc'
import { startMCPServer, stopMCPServer } from './main/mcp'
import { initUpdater, registerUpdaterIpc } from './main/updater'
import { startScheduler } from './main/backup/scheduler'
import { startScanner, stopScanner } from './main/services/notifier'
import * as appLog from './main/services/appLog'

// ── 最先安装全局兜底（2026-09-22）────────────────────────────────────────
// 用户第 8 条：「任何失败或崩溃根本查不到日志」。此前主进程零兜底 ——
// 未捕获异常/未处理 rejection 直接消失，终端里只剩 vite 的噪声。
// 必须在任何业务 import 的副作用之前跑，越早越好。
appLog.installProcessHandlers()

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

// ── 单实例锁（2026-09-25，用户第 11 条）──────────────────────────────────
// 用户双击桌面快捷方式时，若方寸已在运行，第二个实例会把现有窗口提到前台
// 而不是打开一个空壳。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 没拿到锁 = 已有实例在跑，让它处理 then 退出
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

/** 渲染层 e2e 用：隐藏窗口跑，避免测试时窗口在屏幕上闪 */
const hidden = process.env.FC_E2E_RENDERER === '1'

function createWindow(): void {
  mainWindow = new BrowserWindow({
    show: !hidden,
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
  // 备份 IPC 此前只注册在假入口 src/main/index.ts（从不被加载）——
  // 真实入口漏注册导致设置页全部备份按钮是僵尸（2026-09-21 用户实测暴露）
  registerBackupIpcHandlers()

  // ── 主进程自证：本进程到底是哪份构建、关键通道在不在 ──────────────────
  // 2026-09-25 用户报「启动台依旧报错」，日志里却有渲染层的点击痕迹、没有主进程的
  // `[launchpad] 请求启动` —— 无法判断是"没点到"还是"主进程跑的是旧代码"。
  // 这行把两件事一次性说清：dist 的写入时间（=哪次构建）+ 关键通道注册状态。
  try {
    const st = fs.statSync(__filename)
    const channels = registeredChannels()
    appLog.info('boot', '主进程自证', {
      mainFile: __filename,
      builtAt: new Date(st.mtimeMs).toISOString(),
      channelCount: channels.length,
      launchpadChannel: channels.includes('launchpad:launchApp'),
      launchpadVariant: channels.filter((c) => c.startsWith('launchpad:')),
    })
  } catch (e) {
    appLog.warn('boot', '主进程自证失败', (e as Error).message)
  }

  // 24 寸显示器默认最大化
  mainWindow.maximize()

  if (isDev) {
    // 显式 IPv4：vite 5 的默认 host 'localhost' 在部分环境只绑 [::1]，
    // 而 Chromium 解析 localhost 时可能先试 127.0.0.1 → ERR_CONNECTION_REFUSED
    // （2026-09-25 日志里 5 次 `页面加载失败 -102 ERR_CONNECTION_REFUSED http://localhost:5173/`）。
    // vite.config 已固定 host: '127.0.0.1'，两端都用 127.0.0.1 即无歧义。
    mainWindow.loadURL('http://127.0.0.1:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'))
  }

  // ── 渲染层可观测（2026-09-22）────────────────────────────────────────
  // 之前渲染层报错在终端里一条都看不到：preload 失败、白屏、脚本异常
  // 全都是"界面没反应 + 终端安静"。这几条把真因捞进日志文件。
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    appLog.error('window', `页面加载失败 ${code} ${desc}`, url)
  })
  mainWindow.webContents.on('preload-error', (_e, preloadPath, err) => {
    appLog.error('window', `preload 失败: ${preloadPath}`, err instanceof Error ? err.stack : err)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    appLog.error('window', `渲染进程退出: ${details.reason}`, details)
  })
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // level: 0=verbose 1=info 2=warning 3=error
    if (level >= 2) {
      appLog.append(level === 3 ? 'ERROR' : 'WARN', 'renderer-console',
        `${message} (${sourceId}:${line})`)
    }
  })
  mainWindow.webContents.on('unresponsive', () => appLog.warn('window', '窗口无响应'))

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

  // 各子系统的启动失败此前是静默的（抛了就抛了）。逐个包起来并落盘。
  const boot = (name: string, fn: () => void) => {
    try {
      fn()
      appLog.info('boot', `${name} 已启动`)
    } catch (e) {
      appLog.error('boot', `${name} 启动失败`, e instanceof Error ? e.stack : e)
    }
  }

  boot('MCP 服务', () => startMCPServer())
  boot('静默备份调度', () => startScheduler())
  boot('通知扫描器', () => startScanner())
  boot('自动更新', () => {
    initUpdater(mainWindow)
    registerUpdaterIpc()
  })
  appLog.info('boot', '全部子系统启动流程结束', { logFile: appLog.getLogFile() })
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
  appLog.info('boot', '退出中')
  stopMCPServer()
  stopScanner()
})
