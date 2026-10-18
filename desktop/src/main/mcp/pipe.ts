/**
 * MCP 管道名 / 路径的**唯一出处**（2026-10-18）
 *
 * 为什么单独一个文件：桥（bridge-standalone）必须能**完全不依赖 electron** 运行 ——
 * 它在两种形态下都可能被启动：
 *   ① 正常 Electron 主进程模式（`方寸.exe --mcp-bridge`）；
 *   ② 纯 node 模式（环境里存在 ELECTRON_RUN_AS_NODE=1 时，electron.exe 退化成 node；
 *      实测本机开发 shell 就带着这个变量，此时 require('electron').ipcMain 是 undefined，
 *      任何碰 electron 的代码都会当场炸）。
 * 所以本文件只做纯字符串计算，两侧共用，禁止各自手写字面量。
 */

export const MCP_PIPE_BASENAME = 'tegula-mcp'

/**
 * Windows: \\.\pipe\tegula-mcp；其它平台: <临时目录>/tegula-mcp.sock
 *
 * `FC_MCP_PIPE` 是**测试专用**重定向（与 probe.ts 里 FC_DSH_HOME 同一套做法）：
 * e2e 要起一个假主实例来验桥的转发，不重定向就会连到用户真实在跑的方寸，
 * 断言变成"看运气"。生产环境不设这个变量，行为就是固定管道名。
 */
export function pipeNameFor(platform: NodeJS.Platform, tmpDir: string): string {
  if (process.env.FC_MCP_PIPE) return process.env.FC_MCP_PIPE
  if (platform === 'win32') return `\\\\.\\pipe\\${MCP_PIPE_BASENAME}`
  return `${tmpDir.replace(/[\\/]+$/, '')}/${MCP_PIPE_BASENAME}.sock`
}
