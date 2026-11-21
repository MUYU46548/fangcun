/**
 * electron 最小桩 — 让主进程代码可在纯 Node 下跑端到端测试。
 * 仅测试用，不参与打包。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const BrowserWindowStub = { windows: [] }

const userData = process.env.FC_TEST_USERDATA || path.join(os.tmpdir(), 'fc-e2e-userdata')

/** `app.setPath` 的调用流水（测试可断言"日志目录被钉到数据根"）。只记账，不改真实路径。 */
const appSetPathCalls = []
/** `shell.showItemInFolder` 的调用流水 */
const shellRevealed = []

class NotificationStub {
  constructor(opts) { this.opts = opts; this.handlers = {} }
  // 2026-10-29：真机通知支持 click（点通知回到具体对象）。桩必须同形，
  // 否则 notifier 里 n.on('click', …) 会直接抛，把"点通知"这条链永远测不到。
  on(ev, cb) { this.handlers[ev] = cb; return this }
  show() { NotificationStub.lastShown = this.opts; NotificationStub.last = this }
  /** 模拟用户点了这条系统通知 */
  click() { if (this.handlers.click) return this.handlers.click() }
}
NotificationStub.last = null
// 2026-10-17 改 true：挂机提醒 e2e 要走真弹断言；e2e-notifications 自带临时覆写不受影响
NotificationStub.isSupported = () => true
NotificationStub.lastShown = null

module.exports = {
  app: {
    getPath: (name) => {
      if (name === 'userData') return userData
      if (name === 'exe') return path.join(process.cwd(), 'fake-electron.exe')
      return os.tmpdir()
    },
    getAppPath: () => path.resolve(__dirname, '../../desktop'),
    isPackaged: false,
    // 2026-11-21 开机自启：桩只记账/回默认值（isPackaged=false 时业务层直接说“开发态不可用”）
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: () => {},
    // 2026-11-07 由 check-electron-stub 对账补：`appLog.ts` 启动时会 `app.setPath('userData', …)`
    // 把日志目录钉到数据根。桩没有 → 应用日志那条链在测试里第一步就断。
    // 只记账，不改真实路径（测试的 userData 由 FC_TEST_USERDATA 决定）。
    setPath: (name, p) => { appSetPathCalls.push([name, p]) },
    /** 调用流水（测试可断言"日志目录被钉到数据根"） */
    setPathCalls: appSetPathCalls,
    // 2026-11-06 补：`skillInstaller.autoCheckSkills()` 要写 appVersion（技能同步留痕），
    // 桩此前没有这个方法 → e2e-agent-targets 直接 TypeError 崩在测试自身，
    // 整份测试一条断言都没跑（= 那批"自动同步"的改动一直没有被这层守到）。
    // 读真实 package.json 而不是写死：版本一升，测试跟着走，不会变成"永远对"的符号。
    getVersion: () => {
      try {
        return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../desktop/package.json'), 'utf-8')).version || '0.0.0-e2e'
      } catch {
        return '0.0.0-e2e'
      }
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    // 可逆的假加密，用于验证"密码不明文落盘"
    encryptString: (s) => Buffer.from('ENCV1:' + s, 'utf8'),
    decryptString: (b) => {
      const s = b.toString('utf8')
      if (!s.startsWith('ENCV1:')) throw new Error('cipher mismatch')
      return s.slice(6)
    },
  },
  BrowserWindow: {
    // 默认没有窗口（通知类断言不依赖窗口）；要测“聚焦/点通知”时用 _setTestWindows 注入假窗口
    getAllWindows: () => BrowserWindowStub.windows,
    // 2026-11-07 由 check-electron-stub 对账补：`backup-ipc.ts` 6 处用它把 webContents 反查成窗口
    // （备份进度往窗口推消息的后半段）。桩没有 → 一走到就 TypeError，而那条链一直"看起来没事"。
    fromWebContents: (wc) => BrowserWindowStub.windows.find((w) => w && w.webContents === wc) || null,
    // 同上：`ipc.ts` 用它决定"弹窗挂在哪个窗口上"
    getFocusedWindow: () => BrowserWindowStub.windows[0] || null,
    _setTestWindows: (arr) => { BrowserWindowStub.windows = arr || [] },
  },
  Notification: NotificationStub,
  // shell 桩：记录调用 + 支持注入失败，便于断言"打开失败"路径
  shell: {
    opened: [],
    external: [],
    /** 2026-11-07 补：`ipc.ts` 用它在资源管理器里定位文件（"在文件夹中显示"） */
    revealed: shellRevealed,
    failNext: '',
    showItemInFolder(p) {
      shellRevealed.push(p)
    },
    async openPath(p) {
      this.opened.push(p)
      if (this.failNext) { const f = this.failNext; this.failNext = ''; return f }
      return ''
    },
    async openExternal(u) {
      this.external.push(u)
      if (this.failNext) { const f = this.failNext; this.failNext = ''; throw new Error(f) }
    },
  },
  ipcMain: { handle: () => {} },
  // powerMonitor 桩（2026-10-17 挂机提醒）：测试设 globalThis.__FC_IDLE_SEC 控制
  // 系统空闲秒数，配合 startIdleReminder(intervalMs) 的短间隔轮询做真弹断言
  powerMonitor: {
    getSystemIdleTime: () => Number(globalThis.__FC_IDLE_SEC || 0),
  },
  // dialog 桩：默认“用户取消”，测试可用 `dialog.next = { canceled:false, filePaths:[...] }`
  // 脚本化一次返回值（技能导入的"选文件/选文件夹"两条入口要能各自断言）
  dialog: {
    calls: [],
    next: null,
    async showOpenDialog(opts) {
      this.calls.push(opts)
      const n = this.next
      this.next = null
      return n || { canceled: true, filePaths: [] }
    },
  },
}
