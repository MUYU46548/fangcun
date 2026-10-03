/**
 * MCP 接入材料生成（2026-10-02 卡 002 · A 路线）
 *
 * 口径（暮雨拍板）：
 *   ① A 路线 —— 方寸只出材料：按本机安装路径动态生成配置段 + 复制 + 打开目标文件；
 *      **方寸不写任何外部应用的文件**（候选②「产品自注册」已被否决，别复活）。
 *   ② 不猜、不写：检测不到的目标照样列出（detected=false），配置路径如实标注。
 *   ③ 配置段禁写死 E:/CODE/... —— 全部从 __dirname / homedir 动态解析；
 *      打包版入口尚未随包分发（见卡 002 断点），解析不到就如实报 unavailable，不装可用。
 *
 * 两个入口（与 skills/fangcun-bridge/SKILL.md 同口径）：
 *   A · node dist/cli/tegula-mcp.js —— named pipe 桥，读写全量，依赖桌面版运行
 *   B · python tegula.py mcp        —— 14 只读工具，方寸没开也能读，不占 TCP 端口
 * 两者均实测 cwd 无关（桥的 pipe 路径写死；python 入口按文件位置解析数据根），
 * 所以配置段一律不带 cwd —— 少一个会漂移的路径。
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { app } from 'electron'

export type McpEntryId = 'A' | 'B'

export interface McpEntry {
  id: McpEntryId
  label: string
  available: boolean
  /** 不可用时的原因（available=false 必填） */
  detail: string
  command: string
  args: string[]
  /** 给人看的一行说明 */
  usage: string
}

export interface McpTarget {
  id: string
  name: string
  detected: boolean
  /** 检测依据 / 目标配置文件路径（界面上显示，便于核对） */
  evidence: string
  /** 真实存在的配置文件 → 「📂 打开配置文件」才可用；否则 undefined */
  configPath?: string
  /** 一句话步骤：配置段贴到哪、怎么生效 */
  howTo: string
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}
function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
function home(...seg: string[]): string {
  return path.join(os.homedir(), ...seg)
}

// ── 入口解析（本机安装路径，动态） ─────────────────────────────────────

/** 开发态仓库根（dist/main/services → 上溯 4 层），打包态为 app.asar 内部路径（不可用） */
function devRepoRoot(): string {
  return path.resolve(__dirname, '../../../..')
}

export function listMcpEntries(): McpEntry[] {
  const out: McpEntry[] = []

  // 入口 A：named pipe 桥。开发态 = desktop/dist/cli/tegula-mcp.js；
  // 打包态只认 app.asar.unpacked 下的真文件（asar 内文件外部 node 跑不了，fs 虚拟可见 ≠ 可执行）。
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'cli', 'tegula-mcp.js')]
    : [path.join(__dirname, '../../cli', 'tegula-mcp.js')]
  const bridge = candidates.find(c => isFile(c))
  out.push({
    id: 'A',
    label: '入口 A · named pipe 桥（读写全量）',
    available: !!bridge,
    detail: bridge ? '' : (app.isPackaged
      ? '打包版尚未随包分发该入口（见卡 002 断点），待 asarUnpack 后可用'
      : '未找到 dist/cli/tegula-mcp.js —— 先在 desktop/ 跑 npm run build'),
    command: 'node',
    args: bridge ? [bridge] : [],
    usage: '读 + 写（create/update/move/delete），依赖方寸桌面版在运行',
  })

  // 入口 B：python stdio 只读。开发态 = 仓库根 tegula.py；打包态不随包分发 Python 侧。
  const repo = devRepoRoot()
  const tegulaPy = path.join(repo, 'tegula.py')
  const pyAvailable = !app.isPackaged && isFile(tegulaPy)
  out.push({
    id: 'B',
    label: '入口 B · Python stdio（只读，方寸没开也能读）',
    available: pyAvailable,
    detail: pyAvailable ? '' : (app.isPackaged
      ? '打包版不含 Python CLI，此入口不可用'
      : `未找到 ${tegulaPy}`),
    command: 'python',
    args: pyAvailable ? [tegulaPy, 'mcp'] : [],
    usage: '只读 14 工具，不依赖桌面版、不占任何 TCP 端口',
  })

  return out
}

// ── 目标检测（六家，官方配置落点） ─────────────────────────────────────
// 格式来源（2026-10-02 官方文档核实，勿凭记忆改）：
//   DSH      → ~/.dsh/profiles/<p>/cordis.patch.yml 顶层数组追加 - id/name/config
//   Claude   → 项目 .mcp.json 或 ~/.claude.json 的 mcpServers（另有 claude mcp add CLI）
//   Cursor   → ~/.cursor/mcp.json 的 mcpServers（官方 help/customization/mcp）
//   Codex    → ~/.codex/config.toml [mcp_servers.x]（下划线，官方 developers.openai.com）
//   OpenCode → opencode.json 的 mcp.<name>（type:"local" + command 数组）
//   Hermes   → ~/.hermes/config.yaml 的 mcp_servers.<name>（官方 MCP 集成文档）

export function detectMcpTargets(): McpTarget[] {
  const out: McpTarget[] = []

  // ① DSH：profiles 下的 cordis.patch.yml（本机 desktop 档）
  {
    const profilesDir = home('.dsh', 'profiles')
    let patch: string | undefined
    if (isDir(profilesDir)) {
      const prefer = ['desktop', 'web', 'headless']
      const found: string[] = []
      try {
        for (const p of fs.readdirSync(profilesDir)) {
          const f = path.join(profilesDir, p, 'cordis.patch.yml')
          if (isFile(f)) found.push(f)
        }
      } catch { /* 目录读不了按未检测处理 */ }
      patch = prefer.map(p => found.find(f => path.basename(path.dirname(f)) === p)).find(Boolean)
        || found[0]
    }
    out.push({
      id: 'dsh',
      name: 'DSH (DeepSeek Harness)',
      detected: !!patch,
      evidence: patch || profilesDir,
      configPath: patch,
      howTo: '把配置段追加到 cordis.patch.yml 的顶层数组末尾（每条是 - id/name/config），重启 DSH 生效。技能卡复制到 ~/.dsh/skills/<名>/SKILL.md（目录不存在先建）。',
    })
  }

  // ② Claude Code：CLI 优先；配置文件两处落点
  {
    const dot = home('.claude')
    const json = home('.claude.json')
    const detected = isDir(dot) || isFile(json)
    out.push({
      id: 'claudecode',
      name: 'Claude Code',
      detected,
      evidence: isFile(json) ? json : (isDir(dot) ? dot : '~/.claude'),
      configPath: isFile(json) ? json : undefined,
      howTo: '推荐 CLI：claude mcp add fangcun -s user -- node <入口A的js路径>；或把配置段并进项目根 .mcp.json / ~/.claude.json 的 mcpServers。',
    })
  }

  // ③ Cursor：~/.cursor/mcp.json（可新建）
  {
    const dir = home('.cursor')
    const cfg = path.join(dir, 'mcp.json')
    out.push({
      id: 'cursor',
      name: 'Cursor',
      detected: isDir(dir),
      evidence: isFile(cfg) ? cfg : dir,
      configPath: isFile(cfg) ? cfg : undefined,
      howTo: '把 fangcun 这条并进 ~/.cursor/mcp.json 的 mcpServers（文件没有就按配置段整份新建），重启 Cursor 生效。',
    })
  }

  // ④ Codex：~/.codex/config.toml
  {
    const cfg = home('.codex', 'config.toml')
    out.push({
      id: 'codex',
      name: 'Codex',
      detected: isFile(cfg) || isDir(home('.codex')),
      evidence: isFile(cfg) ? cfg : home('.codex'),
      configPath: isFile(cfg) ? cfg : undefined,
      howTo: '把配置段追加到 ~/.codex/config.toml 末尾（节名必须是 mcp_servers 下划线写法），codex mcp list 验证。',
    })
  }

  // ⑤ OpenCode：~/.config/opencode/opencode.json(.c)
  {
    const dir = home('.config', 'opencode')
    const cfg = [path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc')].find(isFile)
    out.push({
      id: 'opencode',
      name: 'OpenCode',
      detected: isDir(dir),
      evidence: cfg || dir,
      configPath: cfg,
      howTo: '把配置段并进 opencode.json 的 mcp 对象（fangcun: {type:"local", command:[...]}），重启 OpenCode。',
    })
  }

  // ⑥ Hermes：~/.hermes/config.yaml
  {
    const cfg = home('.hermes', 'config.yaml')
    out.push({
      id: 'hermes',
      name: 'Hermes',
      detected: isFile(cfg) || isDir(home('.hermes')),
      evidence: isFile(cfg) ? cfg : home('.hermes'),
      configPath: isFile(cfg) ? cfg : undefined,
      howTo: '把配置段并进 ~/.hermes/config.yaml 的 mcp_servers，会话里 /reload-mcp 即连（技能卡另见上方「装到别的 agent」）。',
    })
  }

  return out
}

// ── 配置段生成（按目标格式 × 所选入口） ────────────────────────────────

function argsJson(args: string[]): string {
  return '[' + args.map(a => JSON.stringify(a)).join(', ') + ']'
}

export function buildMcpSnippet(targetId: string, entryId: McpEntryId):
  { ok: boolean; snippet: string; message: string } {
  const entry = listMcpEntries().find(e => e.id === entryId)
  if (!entry) return { ok: false, snippet: '', message: `未知入口（${entryId}）` }
  if (!entry.available) return { ok: false, snippet: '', message: `入口不可用：${entry.detail}` }
  if (!detectMcpTargets().some(t => t.id === targetId)) {
    return { ok: false, snippet: '', message: `未知目标（${targetId}）` }
  }

  const cmd = entry.command
  const args = entry.args

  switch (targetId) {
    case 'dsh':
      return {
        ok: true, message: '',
        snippet: [
          '- id: mcp-fangcun',
          `  name: '@deepseek-ai/dsh-mcp-client'`,
          '  config:',
          '    serverName: fangcun',
          '    transport: stdio',
          `    command: ${cmd}`,
          `    args: ${argsJson(args)}`,
          ...(entry.id === 'A' ? ['    failOnStartupError: false'] : []),
        ].join('\n'),
      }
    case 'claudecode':
      return {
        ok: true, message: '',
        snippet: JSON.stringify({
          mcpServers: { fangcun: { command: cmd, args } },
        }, null, 2),
      }
    case 'cursor':
      return {
        ok: true, message: '',
        snippet: JSON.stringify({
          mcpServers: { fangcun: { command: cmd, args } },
        }, null, 2),
      }
    case 'codex':
      return {
        ok: true, message: '',
        snippet: [
          '[mcp_servers.fangcun]',
          `command = ${JSON.stringify(cmd)}`,
          `args = ${argsJson(args)}`,
        ].join('\n'),
      }
    case 'opencode':
      return {
        ok: true, message: '',
        snippet: JSON.stringify({
          mcp: { fangcun: { type: 'local', command: [cmd, ...args], enabled: true } },
        }, null, 2),
      }
    case 'hermes':
      return {
        ok: true, message: '',
        snippet: [
          'mcp_servers:',
          '  fangcun:',
          `    command: ${JSON.stringify(cmd)}`,
          `    args: ${argsJson(args)}`,
        ].join('\n'),
      }
    default:
      return { ok: false, snippet: '', message: `未知目标（${targetId}）` }
  }
}
