/**
 * 外部命令可用性探测（2026-10-03 从 agents.ts 抽出）
 *
 * 抽出理由：`mcpConnect.ts` 要用它判断 OpenCode 是否真能跑，`agents.ts` 也要用；
 * 而 `agents.ts` 反过来又要读 `mcpConnect.detectMcpTargets()` 的检测结论（DSH 落点、配置文件路径）
 * —— 两边互相 import 会成环。把它放进这个零依赖的小模块，两边都只依赖它。
 *
 * 口径（2026-10-03 卡 task-20261003-007）：**目录存在 ≠ 装好了**。
 *   本机 `~/.config/opencode` 是 9 月 1 的实验残留，PATH 里那份 `opencode.cmd` 已损坏
 *   （跑出“找不到路径”）—— 只看目录就把“已检测到”标在一个根本跑不起来的软件上，
 *   用户原话“本机未安装 OpenCode”。所以：真的能跑出 status 0 才算数。
 */

import { spawnSync } from 'child_process'
import * as fs from 'fs'
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

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}
function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

/**
 * 某个 agent 的 MCP 配置文件里有没有 fangcun 条目 —— **逐行、先剥注释**。
 *
 * 为什么要剥注释：本机 `cordis.patch.yml` 第 29 行就写着
 * `# fangcun (tegula) task-board bridge over the desktop app's named pipe.`，
 * 只做 `text.includes('fangcun')` 会把这个说明注释当成"已接入" —— 插件行删了照样报绿。
 * 这套判据 `agents.ts`（“已接入”徽章）与 `mcpConnect.ts`（MCP 区状态）共用，
 * 两处必须说同一句话。
 */
export function fangcunConfigHit(cfgPath?: string): { linked: boolean; where: string } {
  if (!cfgPath) return { linked: false, where: '' }
  let text = ''
  try { text = fs.readFileSync(cfgPath, 'utf-8') } catch {
    return { linked: false, where: '配置文件读不出来' }
  }
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (!raw) continue
    // 注释行不算（# YAML / // TOML-JSON5 / ; ini）
    if (raw.startsWith('#') || raw.startsWith('//') || raw.startsWith(';')) continue
    if (raw.includes('fangcun')) {
      return { linked: true, where: `第 ${i + 1} 行 ${raw.slice(0, 80)}` }
    }
  }
  return { linked: false, where: '' }
}

/** 布尔包装（调用方只关心有没有时用它） */
export function configHasFangcun(cfgPath?: string): boolean {
  return fangcunConfigHit(cfgPath).linked
}

export interface ClaudeCodeProbe {
  detected: boolean
  /** 检测依据（路径或不可执行原因），界面上显示出来便于核对 */
  evidence: string
  /** 一句话解释为什么这么判 */
  detail: string
}

/**
 * Claude Code 到底装没装（2026-11-06 暮雨：“MCP 页报 Claude Code 已接入，可本机根本没有它”）。
 *
 * 真因：旧判据是 `isDir(~/.claude) || isFile(~/.claude.json)` —— 而 `~/.claude` 那个目录
 * **只要有个 skills/ 子目录就算存在**。本机 `.claude/skills/` 下躺着 4 个技能，是别的工具
 * 往"看起来标准的落点"里塞的；Claude Code 本体（CLI / 用户级配置）一个都没有，
 * 于是"已检测到 + 可打开配置文件"全是假的。
 *
 * 判据按强度从强到弱，命中任一条即算装上：
 *   ① `~/.claude.json` —— Claude Code 的用户级配置，跑过任意一次会话就会写；
 *   ② `~/.claude/settings.json` —— 它的设置文件（手工建的目录不会带这个）；
 *   ③ CLI 可执行文件的已知落点（~/.local/bin、~/.claude/local、npm 全局、bun）；
 *   ④ `claude --version` 能跑（唯一能证明"真能起来"的判据，最慢，放最后）。
 * **只有 `~/.claude/skills` 不算** —— 那是技能落点，不是本体。宁可说"没检测到"（
 * 用户可以自己 `claude --version` 核对），也不把这个"已接入"标在一个不存在的软件上。
 *
 * `opts.skipCli`：e2e 专用。测试要造"只有 skills 目录"的现场，但如果跑测试的机器
 * 真装了 Claude Code，④ 会把反例判成假红 —— 跳过它，反例才只测文件判据。
 */
export function probeClaudeCode(opts?: { skipCli?: boolean }): ClaudeCodeProbe {
  const home = os.homedir()
  const dotClaude = path.join(home, '.claude')

  const userCfg = path.join(home, '.claude.json')
  if (isFile(userCfg)) {
    return { detected: true, evidence: userCfg, detail: '用户级配置 ~/.claude.json 在（Claude Code 跑过一次会话就会写）' }
  }
  const settings = path.join(dotClaude, 'settings.json')
  if (isFile(settings)) {
    return { detected: true, evidence: settings, detail: 'Claude Code 的设置文件 ~/.claude/settings.json 在' }
  }

  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  const dirs = [
    path.join(home, '.local', 'bin'),
    path.join(dotClaude, 'local'),
    path.join(process.env.APPDATA || '', 'npm'),
    path.join(home, '.bun', 'bin'),
  ].filter(Boolean)
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, 'claude' + ext)
      if (isFile(p)) return { detected: true, evidence: p, detail: 'CLI 可执行文件在已知落点' }
    }
  }

  // `FC_NO_CLI_PROBE=1` 是同一件事的环境开关（e2e 要给 agents.detectAgentTargets 关掉它，
  // 但那个入口没有参数可传）。与 FC_DSH_HOME 同一套“测试专用重定向”约定。
  if (!opts?.skipCli && process.env.FC_NO_CLI_PROBE !== '1' && cliRuns('claude --version')) {
    return { detected: true, evidence: 'claude --version 可执行', detail: 'CLI 在 PATH 里能跑起来' }
  }

  const onlySkills = isDir(path.join(dotClaude, 'skills'))
  return {
    detected: false,
    evidence: onlySkills ? `${dotClaude}（只有 skills/）` : dotClaude,
    detail: onlySkills
      ? '~/.claude 下只有 skills/（技能落点目录），没有 Claude Code 本体 —— 不算装上'
      : '没找到 Claude Code 的用户配置 / 设置文件 / CLI 可执行文件',
  }
}

/**
 * DSH（DeepSeek Harness）的配置根 —— 默认 `~/.dsh`。
 *
 * `FC_DSH_HOME` 是**测试专用**的重定向（与 e2e 里改 `LOCALAPPDATA` 同一套做法）：
 * e2e 要真跑“装到 DSH”这条写路径，不重定向就会写进**用户真实的 ~/.dsh/skills**。
 * 生产环境不设这个变量，行为就是 `~/.dsh`。
 */
export function dshHome(): string {
  return process.env.FC_DSH_HOME || path.join(os.homedir(), '.dsh')
}
