import { app, BrowserWindow, Tray, Menu, shell } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { registerIpcHandlers } from './main/ipc'
import { registerBackupIpcHandlers } from './main/backup-ipc'
import { registerPlanIpcHandlers } from './main/plan-ipc'
import { registerLlmChannelIpcHandlers } from './main/channel-ipc'
import { registerPlanRunIpcHandlers } from './main/plan-run-ipc'
import { registerMirrorIpcHandlers } from './main/mirror-ipc'
import { registerWasteIpcHandlers } from './main/waste-ipc'
import { registeredChannels } from './main/guarded-ipc'
import { getPref } from './main/services/prefs'
import { startMCPServer, stopMCPServer } from './main/mcp'
import { initUpdater, registerUpdaterIpc } from './main/updater'
import { startScheduler } from './main/backup/scheduler'
import { startScanner, stopScanner } from './main/services/notifier'
import { startIdleReminder, stopIdleReminder } from './main/services/idleReminder'
import { syncSelfRepoOnBoot } from './main/services/selfSync'
import { autoCheckSkills } from './main/services/skillInstaller'
import * as appLog from './main/services/appLog'

// ── 入口分流的说明（2026-10-18）──────────────────────────────────────────
// 本文件**不再**自己判断 `--mcp-bridge`：TypeScript 把所有 import 编译成顶部 require，
// 写在文件中间的分流判断永远晚于 `require('./main/ipc')` 的顶层副作用（实测死在 ipc.js:897，
// 纯 node 模式下 ipcMain 是 undefined）。真入口是 src/boot.ts —— 它只有两个 require，
// 且都在判断之后。真因见 main/mcp/bridge-standalone.ts 顶部注释。

// ── 最先安装全局兜底（2026-09-22）────────────────────────────────────────
// 用户第 8 条：“任何失败或崩溃根本查不到日志”。此前主进程零兜底 ——
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

// ── 关掉 Windows 原生遮挡检测（2026-10-10，用户复报“对话框偶发无法输入”）────
// 复现描述：编辑框点不动/打不进字，**点一下别的窗口再回来就好了**。
// 09-25 那轮已把模糊合成层全部清掉（见下方注释），当时的结论是“剩下的嫌疑只有
// 合成器 / 核显驱动”。现在剩两条并列的嫌疑，两条都要有出口：
//   ① 核显驱动“失焦即停绘” —— 设置页的 fc_disable_gpu 开关就是给它准备的；
//   ② Windows 上 Chromium **自己判断**“窗口被别的窗口盖住”就暂停渲染与输入处理
//      （CalculateNativeWinOcclusion）。方寸关窗=收托盘、常驻后台，这条命中率最高。
// 必须在 app ready 之前 appendSwitch。
// ⚠ 这是**唯一**的 disable-features 调用点：将来要再加特性开关，请合并进这个
//   逗号分隔列表（'A,B,C'），别新起一次调用 —— 后一次调用会**覆盖**前一次。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

// ── 硬件加速开关（2026-09-25，用户第 1/3/9 条的**人工验证杠杆**）─────────────
// “点输入框光标不进去、要切到别的窗口再切回来才恢复”这条：本轮已把全部常驻实时模糊
// 合成层清掉（#bar 的 backdrop-filter + .blob 的 blur 改缓存纹理）。若仍然复发，
// 剩下的嫌疑就只有“合成器 / 核显驱动”这一层 —— 本机是 i5-14600K 核显，
// Chromium 在核显驱动上出现“失焦即停绘”是有先例的。
// 所以给一个**用户能自己翻的开关**（设置页）：关掉硬件加速、重启即生效。
// 必须在 app ready 之前调用 disableHardwareAcceleration()，故在此同步读 prefs。
// prefs 的所有消费方都是函数内懒调用 getPath，import 阶段不读盘（见上方注释）。
try {
  if (getPref('fc_disable_gpu') === true) {
    app.disableHardwareAcceleration()
    try { console.warn('[boot] 已按设置关闭硬件加速（fc_disable_gpu=true）') } catch { /* ignore */ }
    try { appLog.warn('boot', '已按设置关闭硬件加速（fc_disable_gpu=true）') } catch { /* ignore */ }
  }
} catch { /* 读不到就按默认：保留硬件加速 */ }

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
/** 渲染进程崩过一次就自动重载一次（2026-10-30 白屏事故的兜底） */
let rendererRecovered = false

/**
 * 技能自动同步的补跑节流（2026-11-05 暮雨：“更新后无法自动更新技能？”）。
 *
 * 为什么需要补跑：自动同步原先只在 `registerIpcHandlers()`（= 建窗）里跑**一次**。
 * 而方寸是常驻托盘、关窗≠退出；升级安装包后旧进程还活着，新实例被单实例锁顶掉
 * 直接 `app.quit()` —— **新代码从来没机会跑那句 autoCheckSkills**，用户看到的
 * 就是"升级了但技能还是旧的"。
 * 两个补跑点：① 再点一次图标（second-instance）② 窗口重新显示（show）。
 * 节流 5 分钟：读两份 SKILL.md 算 md5 很便宜，但没必要每次切窗口都写一次状态文件。
 */
const SKILL_SYNC_MIN_MS = 5 * 60_000
let skillSyncedAt = Date.now()

function syncSkillsSoon(trigger: string): void {
  const now = Date.now()
  if (now - skillSyncedAt < SKILL_SYNC_MIN_MS) return
  skillSyncedAt = now
  try {
    const s = autoCheckSkills(trigger)
    // autoCheckSkills 自己会逐目标记账；这里只留一行"这次是谁触发的、结果如何"
    appLog.info('skills', `补跑自动同步（${trigger}）：${s.ok ? '全部成功' : '有失败'}`, {
      skills: s.skills,
      targets: s.targets.map((t) => ({ id: t.id, present: t.present, installed: t.installed.length, errors: t.errors.length })),
    })
  } catch (e: any) {
    appLog.warn('skills', `补跑自动同步失败（${trigger}）`, e?.message || String(e))
  }
}

// ── 单实例锁（2026-09-25，用户第 11 条）──────────────────────────────────
// 用户双击桌面快捷方式时，若方寸已在运行，第二个实例会把现有窗口提到前台
// 而不是打开一个空壳。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 没拿到锁 = 已有实例在跑，让它处理 second-instance，本实例退出。
  //
  // ⚠ 2026-09-25：这里原来是**静默** app.quit() —— 一旦“已安装版还在托盘里跑”而你又启动 dev
  //   （两者共用同一个 userData：C:\Users\<u>\AppData\Roaming\fangcun-desktop），
  //   dev 实例会拿到 !gotLock、退码 0、界面与终端都毫无提示，
  //   外加 Chromium 报 "Unable to move the cache: 拒绝访问" —— 看起来像"程序坏了/启动不了了"。
  //   现在必须把原因说出来：终端一行 + 应用日志一行。
  const msg = '已有方寸实例在运行（同一 userData 被占用），本次启动退出。'
    + '若要在 dev 里调试，请先在托盘右键“退出”正在运行的方寸，再启动 dev。'
  try { console.warn('[boot] ' + msg) } catch { /* ignore */ }
  try { appLog.warn('boot', msg) } catch { /* 日志走不通也不能改变控制流 */ }
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    // 2026-11-05：升级安装包后再点一次图标时，**旧进程**会收到这个事件 ——
    // 那一刻它的 resources 目录已被新安装包覆盖，补跑一次就同步到位（见 syncSkillsSoon）。
    syncSkillsSoon('second-instance')
  })
}

/** 渲染层 e2e 用：隐藏窗口跑，避免测试时窗口在屏幕上闪 */
const hidden = process.env.FC_E2E_RENDERER === '1'

/**
 * 这个 URL 是不是方寸自己那份页面（dev 走 vite，打包走 renderer/index.html）。
 *
 * 存在的理由只有一个：给出"可以导航"的**白名单**，而不是给黑名单。
 * 2026-11-05 暮雨第 10 条的白屏事故里，任何"猜哪些链接是坏的"的做法都会漏 ——
 * 正文里的链接是用户/agent 随手写的，什么形式都有。
 */
function isOwnPage(raw: string): boolean {
  try {
    const u = new URL(String(raw || ''))
    if (isDev) return u.host === '127.0.0.1:5173' || u.host === 'localhost:5173'
    if (u.protocol !== 'file:') return false
    const p = decodeURIComponent(u.pathname).replace(/\//g, '\\').toLowerCase()
    return p.endsWith('\\renderer\\index.html')
  } catch {
    // 解析不了的一律不放行（宁可拦下并交系统打开，也不让窗口变成白纸）
    return false
  }
}

/**
 * 把被拦下的链接交给系统打开（2026-11-05 暮雨第 10 条）。
 *
 * 分工：渲染层对 `.markdown a` 有更聪明的处理（相对路径按数据根/项目仓库解析、
 * 文件不存在时给明确提示）；这里只是**兜底**，保证"拦下来之后不会什么都不发生"。
 * 打不开就写应用日志 —— 静默失败等于让用户以为点坏了。
 */
function openTargetExternally(raw: string): void {
  const target = String(raw || '').trim()
  if (!target) return
  try {
    if (/^(https?|mailto):/i.test(target)) {
      void shell.openExternal(target)
      return
    }
    let p = target
    if (/^file:/i.test(target)) {
      const u = new URL(target)
      p = decodeURIComponent(u.pathname)
      if (process.platform === 'win32') p = p.replace(/^\//, '')
    }
    if (!fs.existsSync(p)) {
      appLog.warn('window', '链接指向的文件不存在，未打开', p)
      return
    }
    void shell.openPath(p).then((err) => {
      if (err) appLog.warn('window', '系统拒绝打开这个文件', { path: p, err })
    })
  } catch (e: any) {
    appLog.warn('window', '链接打开失败', { target, error: e?.message || String(e) })
  }
}


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
      // 窗口被遮挡 / 收进托盘时，Chromium 默认把渲染节流到极低频（backgroundThrottling
      // 默认 true）—— 表现就是光标不闪、输入事件不进去，切到别的窗口再回来才恢复。
      // 方寸是常驻托盘的窗口应用（关窗≠退出），这条必须关掉。
      backgroundThrottling: false,
    },
  })

  registerIpcHandlers()
  // 备份 IPC 此前只注册在假入口 src/main/index.ts（从不被加载）——
  // 真实入口漏注册导致设置页全部备份按钮是僵尸（2026-09-21 用户实测暴露）
  registerBackupIpcHandlers()
  // 作战计划（0.6.0 P1）：只读 + 裁决两个口
  registerPlanIpcHandlers()
  // 作战计划 · 跑判据 / 推进（0.6.0 P4）：执行器只在这个文件里，打开卡不会跑命令
  registerPlanRunIpcHandlers()
  // BYOK 多通道（0.6.0 第 2 批）：主通道 + 备用通道的增删查（密钥只回掩码）
  registerLlmChannelIpcHandlers()
  // 投入产出账（0.6.0 P5）：只读
  registerWasteIpcHandlers()
  // 计划与实际的对照镜（卡 20261027-004 阶段一）：只读取两段原文，零加工
  registerMirrorIpcHandlers()

  // ── 主进程自证：本进程到底是哪份构建、关键通道在不在 ──────────────────
  // 2026-09-25 用户报“启动台依旧报错”，日志里却有渲染层的点击痕迹、没有主进程的
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

  // ── 点链接不许把整个界面换掉（2026-11-05 暮雨第 10 条）───────────────
  // 现场：日志 / 任务正文里的“蓝色链接”是 markdown 渲染出来的 `<a href>`，
  // 而 Electron **默认没有任何拦截** —— 点它 = 让整个窗口导航到那个地址。
  // 相对路径（日志里大量是 `[xx](desktop/src/main/data/tasks.ts)`）会落到
  // file:// 的一张白纸，https 会把方寸整个换掉：两种都是“白屏永久卡死、必须大退”，
  // 因为 Vue 应用已经不在这个文档里了，连返回都没得返回。
  //
  // 三道闸，缺一道就会复发：
  //   ① `will-navigate` —— 只放行方寸自己那份页面，其余一律拦下；
  //   ② `setWindowOpenHandler` —— `target=_blank` / `window.open` 一律 deny（不开新窗）；
  //   ③ 拦截后**交给系统打开**，不做静默丢弃（静默 = 用户以为点坏了）。
  // 渲染层另有 `.markdown a` 的点击委托（能给“文件不存在”这类明确提示），这里是兜底。
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (isOwnPage(url)) return
    e.preventDefault()
    appLog.warn('window', '拦下了一次整窗导航（会把界面换成目标页 = 白屏）', url)
    openTargetExternally(url)
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    appLog.warn('window', '拦下了新窗口请求（方寸不开新窗，交系统打开）', url)
    openTargetExternally(url)
    return { action: 'deny' }
  })

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
    // 2026-10-30 暮雨报障：点安装包附件后整个方寸白屏成空壳、持续卡死、只能退出重进。
    // 根因在附件打开策略（可执行文件不再直接运行），但这里补一道兜底：
    // 渲染进程非正常退出 → 自动重载一次；30 秒后才允许下一次，避免崩溃循环。
    if (details.reason !== 'clean-exit' && !rendererRecovered) {
      rendererRecovered = true
      appLog.warn('window', '渲染进程非正常退出，800ms 后自动重载一次')
      setTimeout(() => {
        try { mainWindow?.webContents.reload() } catch (e: any) { appLog.error('window', '自动重载失败', e?.message || String(e)) }
      }, 800)
      setTimeout(() => { rendererRecovered = false }, 30_000)
    }
  })
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // level: 0=verbose 1=info 2=warning 3=error
    if (level >= 2) {
      appLog.append(level === 3 ? 'ERROR' : 'WARN', 'renderer-console',
        `${message} (${sourceId}:${line})`)
    }
  })
  mainWindow.webContents.on('unresponsive', () => {
    appLog.warn('window', '窗口无响应')
    // 2026-10-30 白屏/卡死：渲染层卡住时用户只能退出重进。这里补一次自动重载兜底。
    if (!rendererRecovered && !isQuitting) {
      rendererRecovered = true
      appLog.warn('window', '窗口无响应超过阈值，1s 后自动重载一次')
      setTimeout(() => {
        try { mainWindow?.webContents.reload() } catch (e: any) { appLog.error('window', '无响应后自动重载失败', e?.message || String(e)) }
      }, 1000)
      setTimeout(() => { rendererRecovered = false }, 30_000)
    }
  })

  // ── 输入框右键菜单（2026-10-11 用户：“写日志时在文本框里无法鼠标右键粘贴，
  //    workbuddy 都能右键剪切复制粘贴”）────────────────────────────────────
  // **Electron 默认一个右键菜单都不提供** —— 这是它和浏览器手感差最明显的一处。
  // 方寸此前只给"任务卡片"做了自己的菜单（渲染层 @contextmenu.prevent），输入框里右键是死的。
  // 这里按 Chromium 给的 params 分流：可编辑元素给 剪切/复制/粘贴/全选；只选中了文字给 复制；
  // 其余情况**不弹**（别在空白处弹一个全灰的菜单，那比没有更烦人）。
  // ⚠ 用 role 而不是自己调 clipboard —— role 走 Chromium 原生实现，剪切/粘贴能正确进 undo 栈；
  //   自己实现会破坏撤销，而且拿不到"当前焦点在哪个输入框"的正确上下文。
  // ⚠ `enabled` 直接透传 editFlags：光秃秃一个"粘贴"点了没反应，用户会以为是坏的。
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const items: any[] = []
    if (params.isEditable) {
      items.push(
        { role: 'cut', label: '剪切', enabled: params.editFlags.canCut },
        { role: 'copy', label: '复制', enabled: params.editFlags.canCopy },
        { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      )
    } else if (String(params.selectionText || '').trim()) {
      items.push({ role: 'copy', label: '复制' })
    }
    if (!items.length) return
    try { Menu.buildFromTemplate(items).popup({ window: mainWindow || undefined }) } catch { /* 弹不出菜单不该影响主流程 */ }
  })

  // 窗口重新显示时补跑一次技能同步（2026-11-05）—— 用户从托盘点开、切回方寸，
  // 都是"我现在要用它了"的时刻；这时候顺手对一次版比任何定时器都自然。
  mainWindow.on('show', () => syncSkillsSoon('show'))

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
  boot('挂机提醒', () => startIdleReminder())
  // 方寸自仓启动同步（2026-10-21 · W1-1C）：后台 `git pull --ff-only`，**不弹窗、不加按钮**。
  // 只在数据根是 git 仓库且有上游时真做事；失败（本地领先/分叉/没网）落日志 + 状态行显示“待同步”。
  // 不 await：开窗不该等网络；失败也不影响任何功能。
  void syncSelfRepoOnBoot().catch((e) => appLog.error('selfsync', '启动同步异常', e instanceof Error ? e.stack : e))
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
  stopIdleReminder()
})
