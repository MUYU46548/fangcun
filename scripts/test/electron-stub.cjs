/**
 * electron 最小桩 — 让主进程代码可在纯 Node 下跑端到端测试。
 * 仅测试用，不参与打包。
 */
const os = require('os')
const path = require('path')

const userData = process.env.FC_TEST_USERDATA || path.join(os.tmpdir(), 'fc-e2e-userdata')

class NotificationStub {
  constructor(opts) { this.opts = opts }
  show() { NotificationStub.lastShown = this.opts }
}
NotificationStub.isSupported = () => false
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
  BrowserWindow: { getAllWindows: () => [] },
  Notification: NotificationStub,
  shell: { openPath: async () => '' },
  ipcMain: { handle: () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}
