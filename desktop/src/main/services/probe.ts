/**
 * 外部命令可用性探测（2026-10-03 从 agents.ts 抽出）
 *
 * 抽出理由：`mcpConnect.ts` 要用它判断 OpenCode 是否真能跑，`agents.ts` 也要用；
 * 而 `agents.ts` 反过来又要读 `mcpConnect.detectMcpTargets()` 的检测结论（DSH 落点、配置文件路径）
 * —— 两边互相 import 会成环。把它放进这个零依赖的小模块，两边都只依赖它。
 *
 * 口径（2026-10-03 卡 task-20261003-007）：**目录存在 ≠ 装好了**。
 *   本机 `~/.config/opencode` 是 9 月 1 的实验残留，PATH 里那份 `opencode.cmd` 已损坏
 *   （跑出「找不到路径」）—— 只看目录就把「已检测到」标在一个根本跑不起来的软件上，
 *   用户原话「本机未安装 OpenCode」。所以：真的能跑出 status 0 才算数。
 */

import { spawnSync } from 'child_process'
import * as os from 'os'
import * as path from 'path'

export function cliRuns(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, { shell: true, windowsHide: true, timeout: 5000 })
    return !r.error && r.status === 0
  } catch {
    return false
  }
}

/**
 * DSH（DeepSeek Harness）的配置根 —— 默认 `~/.dsh`。
 *
 * `FC_DSH_HOME` 是**测试专用**的重定向（与 e2e 里改 `LOCALAPPDATA` 同一套做法）：
 * e2e 要真跑「装到 DSH」这条写路径，不重定向就会写进**用户真实的 ~/.dsh/skills**。
 * 生产环境不设这个变量，行为就是 `~/.dsh`。
 */
export function dshHome(): string {
  return process.env.FC_DSH_HOME || path.join(os.homedir(), '.dsh')
}
