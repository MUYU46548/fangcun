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
 *   · 本机 ~/.hermes/skills 存在；~/.config/opencode 存在；.claude/.codex/.cursor 都不存在。
 *
 * 所以本模块只做**能证实的**两件事：
 *   ① `installable: true` 的（Hermes）走方寸自己的安装器；
 *   ② 其余只给「显示文件 + 打开对方 + 一句话步骤」——**绝不假装能直装**，
 *      也绝不往猜出来的目录里写东西。
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'

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
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}

/** 目录存在 ≠ 装好了（2026-10-03 卡 task-20261003-007）：本机 ~/.config/opencode 是 9月1
 *  的实验残留，PATH 里 hermes/node 的 opencode.cmd 已损坏（跑出「找不到路径」）——
 *  只看目录就把「已检测到」标在一个根本跑不起来的软件上，用户原话「本机未安装OpenCode」。
 *  口径：runProbe 能跑出 status 0 才算检测到；跑不动就不列（与 .claude/.codex 缺目录不列同义）。 */
export function cliRuns(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, { shell: true, windowsHide: true, timeout: 5000 })
    return !r.error && r.status === 0
  } catch { return false }
}

export function detectAgentTargets(hermesSkillsDir: string): AgentTarget[] {
  const home = os.homedir()
  const out: AgentTarget[] = []

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

  // ② WorkBuddy：第三方打包应用，只给「显示文件 + 打开它」
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

  // ③ OpenCode / Claude Code / Codex / Cursor：有目录才列；OpenCode 额外要求「能跑」（卡007）
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

  return out
}
