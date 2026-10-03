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
import { cliRuns, dshHome } from './probe'

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

// ── 目标检测（七家：六家官方落点 + WorkBuddy） ─────────────────────────
// 格式来源（2026-10-02 官方文档核实，勿凭记忆改）：
//   DSH      → ~/.dsh/profiles/<p>/cordis.patch.yml 顶层数组追加 - id/name/config
//   Claude   → 项目 .mcp.json 或 ~/.claude.json 的 mcpServers（另有 claude mcp add CLI）
//   Cursor   → ~/.cursor/mcp.json 的 mcpServers（官方 help/customization/mcp）
//   Codex    → ~/.codex/config.toml [mcp_servers.x]（下划线，官方 developers.openai.com）
//   OpenCode → opencode.json 的 mcp.<name>（type:"local" + command 数组）
//   Hermes   → ~/.hermes/config.yaml 的 mcp_servers.<name>（官方 MCP 集成文档）
//   WorkBuddy→ **落点不可知**（打包应用，技能目录也不在 %APPDATA%\WorkBuddy）。
//              2026-10-03 用户：「似乎没有让 WorkBuddy 自装接入 MCP 的选项」——
//              方寸不猜它的配置文件，但**可以出「自装指令」**：让 WorkBuddy 自己去找
//              它自己的配置（它最清楚），用户只需贴一段话给它。

export function detectMcpTargets(): McpTarget[] {
  const out: McpTarget[] = []

  // ① DSH：profiles 下的 cordis.patch.yml（本机 desktop 档）
  {
    const profilesDir = path.join(dshHome(), 'profiles')
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
      howTo: '把配置段**原样追加**到 cordis.patch.yml 顶层数组末尾 —— 它是 insert: 形式（裸行在 DSH 里是「按 id 覆盖」，id 不存在会被静默跳过，2026-10-03 实测），落盘后热加载生效、无需重启。技能卡复制到 ~/.dsh/skills/<名>/SKILL.md（目录不存在先建）。',
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
  // detected 与装卡区同口径（2026-10-03 卡007）：目录在 ≠ 装了 —— 还要 opencode --version 能跑；
  // 本机目录是 9月1 实验残留、hermes/node 的 cmd 已损坏，只看目录会把「已检测到」标给跑不起来的软件。
  {
    const dir = home('.config', 'opencode')
    const cfg = [path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc')].find(isFile)
    out.push({
      id: 'opencode',
      name: 'OpenCode',
      detected: isDir(dir) && cliRuns('opencode --version'),
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

  // ⑦ WorkBuddy：打包应用，**落点不可知**（2026-10-03 用户要「让它自装」的入口）
  {
    const wb = 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe'
    out.push({
      id: 'workbuddy',
      name: 'WorkBuddy',
      detected: isFile(wb),
      evidence: wb,
      // configPath 刻意留 undefined：方寸不猜它的配置位置，界面因此不显示「📂 打开配置文件」
      howTo: 'WorkBuddy 是打包过的应用，MCP 配置文件位置方寸无法确认（**不猜、不代写**）。点「🤖 让它自装」把指令贴给 WorkBuddy —— 由它自己找到配置文件并写入，装完自己验证再向你汇报。',
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
      // 2026-10-03 卡009（DSH 自装实测反馈）：DSH 的 patch 语义里**裸行 = 按 id 覆盖已有行**，
      // id 不存在则警告后静默跳过（桌面版无控制台 → 用户永远看不到那个错）；
      // 只有 `insert:` 才是「新增插件行」。原裸行写法接不通，实测改 insert: 后热加载生效。
      return {
        ok: true, message: '',
        snippet: [
          '- insert:',
          '    - id: mcp-fangcun',
          `      name: '@deepseek-ai/dsh-mcp-client'`,
          '      config:',
          '        serverName: fangcun',
          '        transport: stdio',
          `        command: ${cmd}`,
          `        args: ${argsJson(args)}`,
          ...(entry.id === 'A' ? ['        failOnStartupError: false'] : []),
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
    case 'workbuddy':
      // 落点不可知（打包应用）→ 给一份**通用 mcpServers 写法**当起点；
      // 自装指令里会明确"形状不符就按你自己的文档改写，但 command/args 原样保留"。
      return {
        ok: true, message: '',
        snippet: JSON.stringify({
          mcpServers: { fangcun: { command: cmd, args } },
        }, null, 2),
      }
    default:
      return { ok: false, snippet: '', message: `未知目标（${targetId}）` }
  }
}

// ── 自装指令（2026-10-03 卡 task-20261003-006 · A 路线第三渠道）──────────────
// 用户口径：「直接让对应 Agent 自己安装。代价是用户消耗额外 token，但不耗我们的 token，
// 现地 Agent 操作比我们盲打盲猜好」。方寸仍然**零写入** —— 只生成一段贴给目标 agent 的
// 指令（技能卡源路径 + 按它家格式生成的配置段 + 目标配置文件 + 自检步骤），
// 复制技能卡、写配置、重启验证全部由对方自己动手。

/** 技能卡真源：dev = 仓库 skills/；打包 = 安装包 resources/skills/（随包分发） */
function skillCardPath(): string | undefined {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'skills', 'fangcun-bridge', 'SKILL.md')]
    : [path.join(devRepoRoot(), 'skills', 'fangcun-bridge', 'SKILL.md')]
  return candidates.find(isFile)
}

export function buildSelfInstallPrompt(targetId: string, entryId: McpEntryId):
  { ok: boolean; prompt: string; message: string } {
  const sn = buildMcpSnippet(targetId, entryId)
  if (!sn.ok) return { ok: false, prompt: '', message: sn.message }
  const t = detectMcpTargets().find(x => x.id === targetId)
  if (!t) return { ok: false, prompt: '', message: `未知目标（${targetId}）` }

  const skill = skillCardPath()
  const cfg = t.configPath
    || `未检测到现成的配置文件 —— 按你自己的文档定位（方寸不猜、不替你写）`
  // 落点不可知的目标（WorkBuddy）：配置段只是"通用形状"，必须明确让它按自家格式改写。
  const shapeNote = t.configPath
    ? []
    : ['   ⚠ 上面这段是**通用 mcpServers 形状**；如果你家的配置格式不是这样，按你自己的文档改写，',
       '     但 `command` 与 `args` 必须原样保留（那是方寸的真实入口路径）。']
  const prompt = [
    `你是 ${t.name}。请自行完成「方寸（fangcun）任务看板」的接入 —— 由你现地操作，比外部盲写更可靠：`,
    '',
    '1）安装技能卡（SKILL.md 标准格式：技能目录/SKILL.md，frontmatter 含 name/description）：',
    skill
      ? `   源文件：${skill}`
      : '   源文件：本机未找到随包技能卡，请从方寸仓库 skills/fangcun-bridge/ 取 SKILL.md',
    '   复制到你自己的技能目录（按你自己的规则放，装完确认重启后能加载）。',
    '',
    '2）配置 MCP 服务（配置段已按你家格式生成，可直接使用）：',
    `   目标配置文件：${cfg}`,
    ...shapeNote,
    '   配置段：',
    ...sn.snippet.split('\n').map(l => '   ' + l),
    '   保存后按你自己的方式重启生效。',
    '',
    '3）自检：列出你加载到的技能与 MCP 工具，确认能看到方寸能力（如 list_tasks / search_tasks），',
    '   然后向用户汇报：装到哪了、配置写到哪了、怎么验证的。',
  ].join('\n')
  return { ok: true, prompt, message: '' }
}
