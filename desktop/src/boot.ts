/**
 * 真·入口分发（2026-10-18）
 *
 * 为什么需要这一层：TypeScript 会把 `import` 全部编译成**顶部的 require**，
 * 所以「在 index.ts 里写 if (argv 含 --mcp-bridge)」根本来不及 —— `require('./main/ipc')`
 * 已经在分流判断之前执行完毕（注册 897 个通道的顶层副作用，其中 `ipcMain.handle` 在纯 node
 * 模式下是 undefined，当场 TypeError）。2026-10-18 的实测就是死在 dist/index.js:39。
 *
 * 桥模式的实现方式（**二段式**，别改成「在 Electron 主进程里直接收发 stdio」）：
 *   本进程（Electron 模式）只做一件事 —— 用 `ELECTRON_RUN_AS_NODE=1` **fork 自己**，
 *   把 stdio 原样继承给那个纯 node 子进程，然后等它退出。
 *
 *   ⚠ 为什么不直接在 Electron 主进程里跑桥（2026-10-18 实测教训）：
 *     · GUI 模式下 `process.stdin` 的生命周期不归我们管，桥会在 ~240ms 内就认为 stdin EOF
 *       并退出（exit 0、无任何报错），客户端只看到"服务瞬间没了"；
 *     · 顺带还会拉起 GPU 进程，本机核显上稳定崩
 *       `GPU process exited unexpectedly: exit_code=-1073741819`（0xC0000005）；
 *     · 打包版与开发态行为还不一致（开发态带 ELECTRON_RUN_AS_NODE 时反而是对的），
 *       这种"有时能跑"的东西不该留在产品里。
 *
 *   纯 node 子进程则一切正常：stdio 是真实管道、零 Chromium、启动几十毫秒。
 *   实测（打包版 win-unpacked）：
 *     ELECTRON_RUN_AS_NODE=1 方寸.exe "resources/app.asar/dist/main/mcp/bridge-standalone.js"
 *   —— Electron 的 asar 支持在 node 模式下仍然生效，所以包内路径可直接跑，不需要 asarUnpack。
 */

import * as path from 'path'
import { spawn } from 'child_process'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MCP_BRIDGE_FLAG } = require('./main/mcp/bridge-standalone')

if (process.argv.includes(MCP_BRIDGE_FLAG)) {
  // __dirname 在打包态是 `<安装目录>/resources/app.asar/dist`，开发态是 `desktop/dist`；
  // 两种形态下相对路径一致，所以不分支。
  const bridgeScript = path.join(__dirname, 'main', 'mcp', 'bridge-standalone.js')

  // 父进程（Electron）不需要任何渲染能力，先关掉 GPU，避免无谓的 GPU 进程崩溃噪音。
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const elec = require('electron')
    if (elec && elec.app) {
      elec.app.disableHardwareAcceleration()
      elec.app.commandLine.appendSwitch('disable-gpu')
    }
  } catch { /* 纯 node 模式或被裁掉 electron 模块：跳过 */ }

  const child = spawn(process.execPath, [bridgeScript], {
    stdio: 'inherit',                       // MCP 的 stdin/stdout/stderr 原样交给子进程
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  })
  // 父进程必须活到子进程结束：它退出会带走继承的句柄，客户端看到的就是 EOF。
  child.on('exit', (code) => process.exit(code === null ? 1 : code))
  child.on('error', (e) => {
    process.stderr.write(`[fangcun-mcp] 桥子进程启动失败：${e.message}\n`)
    process.exit(1)
  })
} else {
  // 正常桌面端
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('./index')
}
