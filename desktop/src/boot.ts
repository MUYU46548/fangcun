/**
 * 真·入口分发（2026-10-18）
 *
 * 为什么需要这一层：TypeScript 会把 `import` 全部编译成**顶部的 require**，
 * 所以「在 index.ts 里写 if (argv 含 --mcp-bridge)」根本来不及 —— `require('./main/ipc')`
 * 已经在分流判断之前执行完毕（注册 897 个通道的顶层副作用，其中 `ipcMain.handle` 在纯 node
 * 模式下是 undefined，当场 TypeError）。2026-10-18 的实测就是死在 dist/index.js:39。
 *
 * 现在：本文件**只有两个 require，且都在判断之后**，桥模式加载不到任何 electron 业务模块。
 * package.json 的 "main" 指向本文件。
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MCP_BRIDGE_FLAG, runStdioBridge } = require('./main/mcp/bridge-standalone')

if (process.argv.includes(MCP_BRIDGE_FLAG)) {
  // 桥进程：只做 stdio ↔ named pipe 转发，永不进 Electron 生命周期
  runStdioBridge()
} else {
  // 正常桌面端
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('./index')
}
