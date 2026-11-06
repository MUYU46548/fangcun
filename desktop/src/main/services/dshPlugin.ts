/**
 * DSH 侧的方寸插件（2026-11-06 暮雨：“依然未体现 DSH 插件相关，且 DSH 插件应该自带把方寸接入的功能”）。
 *
 * 事实（本机核实，别再猜）：
 *  · DSH 的插件是真的 npm 包，装在 `~/.dsh/profiles/<档>/node_modules/`；
 *  · **方寸已经有一个专属插件 `dsh-fangcun`**（源码 `E:\CODE\CangKu\dsh-fangcun`，本机是 `link:` 装的），
 *    它在 profile 的 `dsh.profile.bundles` 里 → 宿主启动就会加载；
 *  · 它**自带接入**：`lib/mcp-pipe.js` 直连方寸的命名管道 `\\.\pipe\tegula-mcp`，
 *    不需要用户在 `cordis.patch.yml` 里手抄 command/args/env；
 *  · 但 `cordis.patch.yml` 里还留着一条**更早的手工通道**（`- id: mcp-fangcun` +
 *    `@deepseek-ai/dsh-mcp-client`，command 指向开发版的 electron.exe）——两条并存，
 *    而这条指向 dev 路径，dev 目录一清就断。方寸以前对此**一个字都没说**。
 *
 * 这个模块只读 DSH 侧的文件（不 import 插件代码、不改任何配置），把上面三件事摊开。
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { dshHome } from './probe'
import { pipeNameFor } from '../mcp/pipe'

export interface DshPluginRow {
  /** 包名（dsh-fangcun） */
  name: string
  /** 装进 bundles 了没有（= 宿主会加载） */
  bundled: boolean
  /** 声明的版本号（node_modules 里那份 package.json） */
  version: string
  /** dependencies 里的原始 spec：`link:E:/…` / `file:…tgz` / `^0.3.0` */
  spec: string
  /** link: 时指向的真实目录（便于核对是不是本地开发版） */
  linkedDir?: string
  /** 插件自带的接入通道（它是直连命名管道的，不需要用户配 MCP） */
  selfConnect: string
}

export interface DshLegacyBridge {
  /** patch 里的行号 */
  line: number
  /** 插件包名（@deepseek-ai/dsh-mcp-client） */
  plugin: string
  command: string
  /** 那个 command 指向的文件在不在 —— 不在就是"配了但连不上" */
  commandExists: boolean
  /** 指向开发目录（node_modules/electron / dist）—— 装机后要重配 */
  isDevPath: boolean
}

export interface DshPluginStatus {
  /** ~/.dsh */
  dshHome: string
  /** DSH 本体在不在（%LOCALAPPDATA%\Programs\DeepSeek Harness 或 ~/.dsh 存在） */
  installed: boolean
  /** 用的哪个 profile */
  profile: string
  profileDir: string
  /** 方寸插件（名字里带 fangcun 的、已装进 bundles 的） */
  plugins: DshPluginRow[]
  /** 插件自带的通道现在通不通（命名管道在不在） */
  pipe: { path: string; alive: boolean }
  /** patch 里那条旧的手工 MCP 桥（可空） */
  legacy?: DshLegacyBridge
  /** 一句人话结论（界面直接显示） */
  summary: string
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}
function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
function readJson(p: string): any {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return null }
}

/** 当前 profile：优先 desktop（与本机 cordis.patch.yml 同口径），否则取第一个有 package.json 的 */
function pickProfile(home: string): string {
  const dir = path.join(home, 'profiles')
  const prefer = ['desktop', 'web', 'headless']
  for (const p of prefer) if (isDir(path.join(dir, p))) return p
  try {
    const first = fs.readdirSync(dir).find((n) => isDir(path.join(dir, n)))
    if (first) return first
  } catch { /* 读不到就当没有 */ }
  return 'desktop'
}

/**
 * 从 patch 里找旧的手工 MCP 桥（`- id: mcp-fangcun` 那一段）。
 *
 * 只认 `- id: <含 fangcun>` 这一行，再往下取同段的 command / name。
 * 注释行一律跳过 —— 本机 patch 顶部就有一整段讲 fangcun 的注释，
 * 不剥注释会把说明当成配置（probe.fangcunConfigHit 同一个坑）。
 */
function findLegacyBridge(patchPath: string): DshLegacyBridge | undefined {
  let text = ''
  try { text = fs.readFileSync(patchPath, 'utf-8') } catch { return undefined }
  const lines = text.split(/\r?\n/)
  const code = (s: string) => !!s.trim() && !/^\s*(#|\/\/|;)/.test(s)

  for (let i = 0; i < lines.length; i++) {
    if (!code(lines[i])) continue
    if (!/^\s*-\s*id:\s*\S*fangcun/i.test(lines[i])) continue
    // 往下取同段的 name / command（缩进大于等于本行、到下一个 `- ` 顶格项为止）
    const baseIndent = (lines[i].match(/^\s*/) || [''])[0].length
    let plugin = ''
    let command = ''
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j]
      if (!code(raw)) continue
      const ind = (raw.match(/^\s*/) || [''])[0].length
      if (/^\s*-\s/.test(raw) && ind <= baseIndent) break
      const mName = /^\s*name:\s*['"]?([^'"\s]+)/.exec(raw)
      if (mName && !plugin) plugin = mName[1]
      // 值可能是带引号的（path 里常含空格/中文），去掉首尾引号再把 YAML 的双反斜杠还原
      const mCmd = /^\s*command:\s*(.+?)\s*$/.exec(raw)
      if (mCmd && !command) command = mCmd[1].replace(/^['"]|['"]$/g, '').replace(/\\\\/g, '\\')
    }
    const exists = !!command && isFile(command)
    return {
      line: i + 1,
      plugin,
      command,
      commandExists: exists,
      // 指向开发目录：dev 的 electron / 仓库里的 dist / node_modules
      isDevPath: !!command && /node_modules|\\dist\\|\/dist\//.test(command),
    }
  }
  return undefined
}

export function detectDshPlugin(): DshPluginStatus {
  const home = dshHome()
  const profile = pickProfile(home)
  const profileDir = path.join(home, 'profiles', profile)
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  const pkg = readJson(path.join(profileDir, 'package.json')) || {}
  const deps: Record<string, string> = (pkg && pkg.dependencies) || {}
  const bundles: string[] = ((pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []).map(String)

  const plugins: DshPluginRow[] = []
  for (const name of Object.keys(deps)) {
    if (!/fangcun/i.test(name)) continue
    const spec = String(deps[name] || '')
    const linkedDir = spec.startsWith('link:') ? spec.slice(5) : undefined
    const modPkg = readJson(path.join(profileDir, 'node_modules', name, 'package.json')) || {}
    plugins.push({
      name,
      bundled: bundles.includes(name),
      version: String(modPkg.version || ''),
      spec,
      linkedDir,
      // 这句话是插件的既定设计（dsh-fangcun 的三条边界之一：只走对外接口）
      selfConnect: '命名管道（插件自己直连方寸，不需要在 patch 里写 command）',
    })
  }
  // bundles 里登记了但 dependencies 里没有（例如手工塞进 node_modules）也要露出来
  for (const name of bundles) {
    if (!/fangcun/i.test(name) || plugins.some((p) => p.name === name)) continue
    const modPkg = readJson(path.join(profileDir, 'node_modules', name, 'package.json')) || {}
    plugins.push({
      name, bundled: true, version: String(modPkg.version || ''), spec: '(bundles 里登记，dependencies 无)',
      selfConnect: '命名管道（插件自己直连方寸）',
    })
  }

  const pipePath = pipeNameFor(process.platform, os.tmpdir())
  // 命名管道用 existsSync 判（Windows 上 `\\.\pipe\x` 能 stat 到）；非 Windows 是普通 socket 文件
  let alive = false
  try { alive = fs.existsSync(pipePath) } catch { alive = false }

  const legacy = findLegacyBridge(patchPath)
  const installed = isDir(path.join(home, 'profiles')) || isDir(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness'))

  let summary: string
  if (!installed) {
    summary = '本机没装 DSH —— 这一块只读，不给它造目录'
  } else if (!plugins.length) {
    summary = '本机装了 DSH，但没装方寸插件（dsh-fangcun）—— 装上它方寸就能被 DSH 直接用'
  } else {
    const p = plugins[0]
    summary = `${p.name} ${p.version || '(版本未知)'} 已装进 bundles；自带接入 = 命名管道，`
      + (alive ? '现在通（方寸在跑）' : '现在不通（方寸没在跑？）')
  }

  return {
    dshHome: home,
    installed,
    profile,
    profileDir,
    plugins,
    pipe: { path: pipePath, alive },
    legacy,
    summary,
  }
}
