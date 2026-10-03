/**
 * 「装到别的 agent」目标检测（2026-09-26 卡 005 回执）
 *
 * 用户原文：「**技能没找到任何可以安装给 WorkBuddy 的地方，依然只有安装到 Hermes**。」
 * —— 上一版把「以 WorkBuddy 为例」当成了**界面参考**（照它的导入面板做方寸自己的导入），
 *    其实用户要的是**目标列表**：Hermes 之外，还有别的 agent 可装。
 *
 * 事实（本机实测，别再猜）：
 *   · `C:\\Program Files\\WorkBuddy\\WorkBuddy.exe` 存在，是打包过的 Electron 应用，
 *     它的技能目录**不在** `%APPDATA%\\WorkBuddy`（那个目录是空的），我们无从得知、也不能瞎写；
 *   · 用户自己贴的 WorkBuddy 面板口径：接受「文件夹或 .zip（需含 SKILL.md）」或「.md（需带 YAML）」；
 *   · Hermes 真实技能目录 = `%LOCALAPPDATA%\\hermes\\skills`（**不是** `~/.hermes/skills`）；
 *     DSH 的技能目录 = `~/.dsh/skills`（2026-10-03 实测：方寸技能卡已被 DSH 装到这里）。
 *
 * 所以本模块只做**能证实的**两件事：
 *   ① `installable: true` 的（Hermes / DSH）走方寸自己的安装器；
 *   ② 其余只给「显示文件 + 打开对方 + 一句话步骤」——**绝不假装能直装**，
 *      也绝不往猜出来的目录里写东西。
 *
 * ── 2026-10-03 卡 task-20261003-011（用户原话：「DSH 在上一轮已经完成安装，
 *    但方寸**检测不到** DSH 安装了」）────────────────────────────────
 *   · 加 DSH 探测（小尾巴⑩「装卡区加 DSH 第四探测目标」）：落点已知 → 与 Hermes 同级可直装；
 *   · 每行附加**已接入**两问（技能副本在不在 + MCP 配置有没有 fangcun）——
 *     纯文件探测，不用 LLM，也不猜。
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { cliRuns, dshHome } from './probe'
import { detectMcpTargets } from './mcpConnect'

export interface AgentTarget {
  id: string
  name: string
  /** installable=方寸能真的装进去；manual=只能给文件 + 打开对方，由用户拖进它的导入面板 */
  mode: 'installable' | 'manual'
  /** 检测不到时为 false（界面按「没装」处理，不给按钮） */
  detected: boolean
  /** 证据：检测依据的路径（界面上显示出来，方便核对） */
  evidence: string
  /** 方寸的技能目录（installable 才有） */
  skillsDir?: string
  /** 可执行文件 / 配置目录（manual 用来"打开对方"） */
  openPath?: string
  /** 一句话步骤 */
  howTo: string
  /** 卡 011：技能副本已落进对方技能目录（skillsDir 可知时才判断；否则 undefined） */
  skillLinked?: boolean
  /** 卡 011：对方 MCP 配置里已有 fangcun 条目（配置文件可知时才判断；否则 undefined） */
  mcpLinked?: boolean
  /** 卡 011：判定依据（人话 + 事实，界面徽章 title 用） */
  linkDetail?: string
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}

/** 方寸主技能 id —— 「技能副本落没落地」的判据（与 skills/manifest.json 首条一致） */
const PRIMARY_SKILL = 'fangcun-bridge'

function skillCopied(skillsDir?: string): boolean {
  if (!skillsDir) return false
  return isFile(path.join(skillsDir, PRIMARY_SKILL, 'SKILL.md'))
}

/** MCP 配置里有没有 fangcun 条目 —— 纯文本包含（YAML / TOML / JSON 三种写法都能覆盖） */
function configHasFangcun(cfgPath?: string): boolean {
  if (!cfgPath) return false
  try { return fs.readFileSync(cfgPath, 'utf-8').includes('fangcun') } catch { return false }
}

/**
 * 目录存在 ≠ 装好了（2026-10-03 卡 task-20261003-007）：本机 ~/.config/opencode 是 9月1
 *  的实验残留，PATH 里 hermes/node 的 opencode.cmd 已损坏（跑出「找不到路径」）——
 *  只看目录就把「已检测到」标在一个根本跑不起来的软件上，用户原话「本机未安装OpenCode」。
 *  口径：runProbe 能跑出 status 0 才算检测到；跑不动就不列（与 .claude/.codex 缺目录不列同义）。
 *  ⚠ 实现落在 `./probe`（cliRuns）—— mcpConnect 也要用，放这里会与它成环。
 */
export function detectAgentTargets(hermesSkillsDir: string): AgentTarget[] {
  const home = os.homedir()
  const out: AgentTarget[] = []

  // MCP 侧的检测结论只算一次：DSH 落点、各家配置文件路径都取自它 —— 不另造第二份口径。
  const mcpById = new Map(detectMcpTargets().map(t => [t.id, t]))
  const dshMcp = mcpById.get('dsh')

  // ① Hermes：方寸自己就在用的那套（唯一能直装的）
  out.push({
    id: 'hermes',
    name: 'Hermes',
    mode: 'installable',
    detected: isDir(hermesSkillsDir),
    evidence: hermesSkillsDir,
    skillsDir: hermesSkillsDir,
    howTo: '点「⚡ 装到 Hermes」直接写进技能目录，重载后即可用。',
  })

  // ② DSH（DeepSeek Harness）：落点已知 → 与 Hermes 同性质，可直装
  //    （对应用户 2026-10-03 反馈：「DSH 已安装，方寸检测不到」）
  out.push({
    id: 'dsh',
    name: 'DSH (DeepSeek Harness)',
    mode: 'installable',
    detected: !!dshMcp?.detected,
    evidence: dshMcp?.evidence || dshHome(),
    skillsDir: path.join(dshHome(), 'skills'),
    howTo: '技能卡点「⚡ 装到 DSH」写进 ~/.dsh/skills/<名>/SKILL.md；MCP 接入见下方「接入 MCP」的 DSH 行（配置段贴进 cordis.patch.yml，保存即热加载、无需重启）。',
  })

  // ③ WorkBuddy：第三方打包应用，只给「显示文件 + 打开它」
  const wb = 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe'
  out.push({
    id: 'workbuddy',
    name: 'WorkBuddy',
    mode: 'manual',
    detected: isFile(wb),
    evidence: wb,
    openPath: wb,
    howTo: '点「📂 显示 SKILL.md」把文件在资源管理器里亮出来 → 打开 WorkBuddy 的「导入技能」面板 → 把 SKILL.md（或整个技能文件夹）拖进去。',
  })

  // ④ OpenCode / Claude Code / Codex / Cursor：有目录才列；OpenCode 额外要求「能跑」（卡007）
  const cliTargets: Array<{ id: string; name: string; probe: string; howTo: string; runProbe?: string }> = [
    { id: 'opencode', name: 'OpenCode', probe: path.join(home, '.config', 'opencode'),
      runProbe: 'opencode --version',
      howTo: 'OpenCode 的技能放法随版本不同，方寸不猜它的目录：点「📂 显示 SKILL.md」后按它的文档放。' },
    { id: 'claudecode', name: 'Claude Code', probe: path.join(home, '.claude'),
      howTo: 'Claude Code 读 ~/.claude/skills/<名>/SKILL.md：点「📂 显示 SKILL.md」，把整个技能文件夹拷过去即可。' },
    { id: 'codex', name: 'Codex', probe: path.join(home, '.codex'),
      howTo: '点「📂 显示 SKILL.md」，按 Codex 的技能目录放。' },
    { id: 'cursor', name: 'Cursor', probe: path.join(home, '.cursor'),
      howTo: '点「📂 显示 SKILL.md」，按 Cursor 的规则目录放。' },
  ]
  for (const t of cliTargets) {
    if (!isDir(t.probe)) continue
    if (t.runProbe && !cliRuns(t.runProbe)) continue
    out.push({
      id: t.id, name: t.name, mode: 'manual', detected: true,
      evidence: t.probe, openPath: t.probe, howTo: t.howTo,
    })
  }

  // ⑤ 「已接入」两问（卡 011）：技能副本 + MCP 配置含 fangcun。
  //    两问都要**落点可知**才有意义 —— 不可知就留 undefined（界面显示「不可知」，不是「未接入」）。
  for (const t of out) {
    if (t.skillsDir) t.skillLinked = skillCopied(t.skillsDir)
    const cfg = mcpById.get(t.id)?.configPath
    if (cfg) t.mcpLinked = configHasFangcun(cfg)
    const bits: string[] = []
    if (t.skillLinked !== undefined) bits.push(t.skillLinked ? '技能副本已装' : '技能副本未装')
    if (t.mcpLinked !== undefined) bits.push(t.mcpLinked ? 'MCP 配置含 fangcun' : 'MCP 配置未含 fangcun')
    t.linkDetail = bits.length
      ? bits.join(' · ')
      : '（落点不可知：对方技能目录 / 配置文件位置本机确认不了 —— 不猜）'
  }

  return out
}
