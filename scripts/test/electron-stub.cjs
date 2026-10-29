/**
 * electron 最小桩 — 让主进程代码可在纯 Node 下跑端到端测试。
 * 仅测试用，不参与打包。
 */
const os = require('os')
const path = require('path')

const BrowserWindowStub = { windows: [] }

const userData = process.env.FC_TEST_USERDATA || path.join(os.tmpdir(), 'fc-e2e-userdata')

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
    // 默认没有窗口（通知类断言不依赖窗口）；要测「聚焦/点通知」时用 _setTestWindows 注入假窗口
    getAllWindows: () => BrowserWindowStub.windows,
    _setTestWindows: (arr) => { BrowserWindowStub.windows = arr || [] },
  },
  Notification: NotificationStub,
  // shell 桩：记录调用 + 支持注入失败，便于断言"打开失败"路径
  shell: {
    opened: [],
    external: [],
    failNext: '',
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
  // dialog 桩：默认「用户取消」，测试可用 `dialog.next = { canceled:false, filePaths:[...] }`
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
