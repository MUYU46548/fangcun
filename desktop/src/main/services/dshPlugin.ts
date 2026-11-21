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
 * 2026-11-21（暮雨：“插件页就算写‘不通’，世界上也不会有任何人知道有什么问题。
 *   方寸本体、方寸插件、DSH 三者各有自己的版本，不匹配就炸”）：
 *   这一页不再只报“通/不通”，而是把**三方版本 + 兼容声明 + 派单审计**摊开，
 *   每条给出“哪一环不对、该升级哪一边”。只读 DSH 侧文件，不 import 插件代码、不改配置。
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { dshHome } from './probe'
import { pipeNameFor } from '../mcp/pipe'
import { getDataDir } from '../data'
import { resolveDispatchSecretPath } from './dispatchSign'

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
  /** 插件在 package.json 里自报的 DSH 兼容范围（没有就是没声明） */
  compatDsh?: string
  /** 插件自报“验证过”的 DSH 版本 → compatible / verified */
  compatReleases?: Record<string, string>
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

/** 派单审计里的一行（插件 `appendDispatchAudit` 写的） */
export interface DshDispatchAuditRow {
  at: string
  ok: boolean
  reason?: string
  source?: string
  project?: string
  kind?: string
  sessionId?: string
  file?: string
  error?: string
}

/** 诊断清单的一条：状态 + 人话 + 该做什么。**不做“只有通/不通”的二元结论。** */
export interface DshDiagnosticCheck {
  key: string
  label: string
  status: 'ok' | 'warn' | 'bad' | 'unknown'
  detail: string
  /** 坏/警告时该做什么；正常时为空串 */
  action: string
}

export interface DshDispatchStatus {
  /** `<数据根>/.dispatch-dsh` */
  dir: string
  /** 目录里还没被消费的派单数 */
  pending: number
  /** rejected/ 里被拒的派单数（证据保留） */
  rejected: number
  /** 签名密钥是否存在（不返回内容） */
  secret: {
    present: boolean
    /** 方寸自己会写/读的路径 */
    path: string
    /** 插件会挑中的路径（它按 APPDATA 下 方寸/Fangcun/fangcun-desktop 顺序找第一份存在的） */
    pluginPath: string
    /** 两边指向同一份（present && pluginPath === path）；不同 = 验签必失败 */
    same: boolean
  }
  /** 审计里最近一行（没有就是 undefined） */
  last?: DshDispatchAuditRow
  /** 最近 5 行（新的在前） */
  recent: DshDispatchAuditRow[]
}

export interface DshPluginStatus {
  /** ~/.dsh */
  dshHome: string
  /** DSH 本体在不在（%LOCALAPPDATA%\Programs\DeepSeek Harness 或 ~/.dsh 存在） */
  installed: boolean
  /** DSH 基座版本（从 app.asar 里的 package.json 读；读不到为空串） */
  dshVersion: string
  /** 版本是从哪读到的（给人核对用） */
  dshVersionFrom: string
  /** 用的哪个 profile */
  profile: string
  profileDir: string
  /** 方寸插件（名字里带 fangcun 的、已装进 bundles 的） */
  plugins: DshPluginRow[]
  /** 插件自带的通道现在通不通（命名管道在不在） */
  pipe: { path: string; alive: boolean }
  /** 派单链路实况（2026-11-21） */
  dispatch: DshDispatchStatus
  /** 诊断清单 */
  checks: DshDiagnosticCheck[]
  /** 一句人话结论 */
  verdict: string
  /** patch 里那条旧的手工 MCP 桥（可空） */
  legacy?: DshLegacyBridge
  /** 一句人话结论（旧字段，兼容渲染层） */
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

// ── DSH 基座版本：从 app.asar 的 package.json 里读（2026-11-21）─────────────
// 为什么要读 asar：DSH 的 `version` 文件写的是 Electron 版本（本机实测 44.7.0），
// 不是 DSH 自己的版本；而插件 compat 表比的是 DSH 版本，拿 Electron 版本去比只会得出假结论。
// asar 头格式：offset 0 / 4 / 8 各一个 u32，offset 12 = 头 JSON 长度，JSON 从 offset 16 开始。
//
// ⚠ 2026-11-21 真机修（暮雨截图：DSH 基座“读不到”）：Electron 给 `fs` 打了 asar 补丁，
//   `fs.openSync('...\\app.asar')` 会被当成“打开 asar 里的某个路径”，直接 ENOENT——
//   普通 Node 里同样的代码是好的（我的单测就是这么过的），只有打包后的 Electron 会坏。
//   修法：读 asar **本体**一律走 `original-fs`（Electron 提供的不带 asar 补丁的 fs）。
function rawFs(): typeof fs {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ofs = require('original-fs')
    if (ofs && typeof ofs.openSync === 'function') return ofs as typeof fs
  } catch { /* 纯 Node / 单测没有 original-fs → 用普通 fs */ }
  return fs
}

function readAllAt(fd: number, buf: Buffer, position: number): number {
  const rfs = rawFs()
  let off = 0
  while (off < buf.length) {
    const n = rfs.readSync(fd, buf, off, buf.length - off, position + off)
    if (!n) break
    off += n
  }
  return off
}

function readAsarPackage(asarPath: string): { version: string; name: string } | null {
  const rfs = rawFs()
  let fd = -1
  try {
    fd = rfs.openSync(asarPath, 'r')
    const head = Buffer.alloc(16)
    if (readAllAt(fd, head, 0) < 16) return null
    const headerLen = head.readUInt32LE(12)
    if (!headerLen || headerLen > 64 * 1024 * 1024) return null
    const headerBuf = Buffer.alloc(headerLen)
    if (readAllAt(fd, headerBuf, 16) < headerLen) return null
    const header = JSON.parse(headerBuf.toString('utf8'))
    const entry = header?.files?.['package.json']
    if (!entry || !Number.isFinite(Number(entry.size))) return null
    const base = 16 + Math.ceil(headerLen / 4) * 4
    const buf = Buffer.alloc(Number(entry.size))
    if (readAllAt(fd, buf, base + Number(entry.offset)) < buf.length) return null
    const pkg = JSON.parse(buf.toString('utf8'))
    return { version: String(pkg?.version || ''), name: String(pkg?.name || '') }
  } catch {
    return null
  } finally {
    if (fd >= 0) { try { rfs.closeSync(fd) } catch { /* 关不掉也不影响读到的结果 */ } }
  }
}

function detectDshVersion(home: string): { version: string; from: string } {
  const la = String(process.env.LOCALAPPDATA || '')
  const candidates = [
    path.join(la, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    path.join(la, 'DeepSeek Harness', 'resources', 'app.asar'),
  ]
  for (const p of candidates) {
    // ⚠ 不要先 `isFile(p)`：Electron 的 asar 补丁会把 `app.asar` 本体 stat 成**目录**，
    // 这个预检在打包后的程序里恒为 false（2026-11-21 真机：上一版就死在这一行）。
    // `readAsarPackage` 用 original-fs，路径不存在 / 不是合法 asar 都会返回 null，不需要预检。
    const pkg = readAsarPackage(p)
    if (pkg?.version) return { version: pkg.version, from: p }
  }
  // 便携/其它安装形态：profile 里若有一份 dsh-desktop，也认
  for (const name of ['@deepseek-ai/dsh-desktop', '@deepseek-ai/dsh']) {
    const p = path.join(home, 'profiles', 'desktop', 'node_modules', name, 'package.json')
    const j = readJson(p)
    if (j?.version) return { version: String(j.version), from: p }
  }
  return { version: '', from: '' }
}

// ── 派单链路实况（2026-11-21）─────────────────────────────────────────────
function readAuditRows(dir: string): DshDispatchAuditRow[] {
  try {
    const text = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf-8')
    const rows: DshDispatchAuditRow[] = []
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim()
      if (!s) continue
      try {
        const row = JSON.parse(s)
        if (row && typeof row === 'object') rows.push(row as DshDispatchAuditRow)
      } catch { /* 坏行跳过：审计不能卡住界面 */ }
    }
    return rows
  } catch {
    return []
  }
}

function countFiles(dir: string, re: RegExp): number {
  try { return fs.readdirSync(dir).filter((n) => re.test(n)).length } catch { return 0 }
}

/**
 * 插件侧会挑中的密钥路径（与 `dsh-fangcun/lib/dispatch.js#resolveDispatchSecret` 同口径）。
 * 必须单列一份：两边挑到不同文件时，验签会稳定失败而界面上只看到“bad-signature”——
 * 这是“三方各自版本/目录不一致”里最难查的一种。
 */
function pluginSecretPick(): string {
  const explicit = String(process.env.FC_DISPATCH_SECRET_PATH || '').trim()
  if (explicit) return explicit
  const appData = String(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')).trim()
  for (const name of ['方寸', 'Fangcun', 'fangcun-desktop']) {
    const p = path.join(appData, name, 'dispatch-secret')
    try { if (fs.existsSync(p)) return p } catch { /* 下一份 */ }
  }
  return ''
}

/** 插件拒绝派单的原因 → 人话 + 该做什么。**这句是本页存在的理由。** */
const DISPATCH_REASONS: Record<string, { text: string; action: string }> = {
  'no-secret': {
    text: '插件找不到方寸的派单密钥 —— 它读的目录和方寸写的不是同一处（常见：一个用安装版、一个读开发态 userData）',
    action: '两边升级到同一版本并重启 DSH / 方寸；仍不行就看密钥路径是否一致',
  },
  'bad-signature': {
    text: '插件验签失败 —— 插件比方寸旧，或两边不是同一把密钥',
    action: '把 dsh-fangcun 升到 0.7.3+（旧插件不认识签名派单），再重启 DSH',
  },
  unsigned: {
    text: '这份派单没有 GUI 签名（agent 直接往 .dispatch-dsh 写文件会被拒，这是防滥用设计，不是故障）',
    action: '派单请从方寸界面点「发送给 DSH」',
  },
  'bad-format': {
    text: '插件不认这份派单的格式 —— 方寸与插件的派单格式版本不匹配',
    action: '方寸与 dsh-fangcun 一起升级到同一条发布线（不要只升一边）',
  },
  cooldown: {
    text: '派单被冷却限制拦下（同一时间太密）',
    action: '等冷却结束，或到 DSH 插件设置里调「派单限流」',
  },
  'daily-cap': {
    text: '派单达到每日上限',
    action: '到 DSH 插件设置里调「派单限流」；默认已是不限',
  },
  concurrency: {
    text: '并行派单已满（同时在跑的会话达到上限）',
    action: '等手上的会话结束，或到插件设置里调并发数',
  },
  'open-failed': {
    text: 'DSH 基座没能开新会话 —— 宿主接口变了（插件与当前 DSH 版本不兼容）',
    action: '升级 dsh-fangcun（看它的 compat 表是否覆盖当前 DSH）；不行就回退 DSH 版本',
  },
}

function reasonOf(row: DshDispatchAuditRow | undefined): { text: string; action: string } | null {
  if (!row || row.ok) return null
  const r = String(row.reason || '')
  return DISPATCH_REASONS[r] || {
    text: `插件拒了派单：${r || '未写原因'}${row.error ? '（' + row.error + '）' : ''}`,
    action: '看 .dispatch-dsh/rejected/ 里的原文与 audit.jsonl 的最近一行',
  }
}

function parseVersion(v: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
function cmpVersion(a: string, b: string): number {
  const A = parseVersion(a)
  const B = parseVersion(b)
  if (!A || !B) return 0
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i]
  return 0
}

/** 签名派单的最低插件版本（0.7.3 起才验签；更旧的会拒或忽略） */
const MIN_SIGNED_PLUGIN = '0.7.3'
const RANK: Record<DshDiagnosticCheck['status'], number> = { ok: 0, unknown: 1, warn: 2, bad: 3 }

export function detectDshPlugin(appVersion = ''): DshPluginStatus {
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
    const compat = modPkg?.dsh?.compatibility || {}
    plugins.push({
      name,
      bundled: bundles.includes(name),
      version: String(modPkg.version || ''),
      spec,
      linkedDir,
      // 这句话是插件的既定设计（dsh-fangcun 的三条边界之一：只走对外接口）
      selfConnect: '命名管道（插件自己直连方寸，不需要在 patch 里写 command）',
      compatDsh: compat.dsh ? String(compat.dsh) : '',
      compatReleases: compat.dshReleases && typeof compat.dshReleases === 'object' ? compat.dshReleases : undefined,
    })
  }
  // bundles 里登记了但 dependencies 里没有（例如手工塞进 node_modules）也要露出来
  for (const name of bundles) {
    if (!/fangcun/i.test(name) || plugins.some((p) => p.name === name)) continue
    const modPkg = readJson(path.join(profileDir, 'node_modules', name, 'package.json')) || {}
    const compat = modPkg?.dsh?.compatibility || {}
    plugins.push({
      name, bundled: true, version: String(modPkg.version || ''), spec: '(bundles 里登记，dependencies 无)',
      selfConnect: '命名管道（插件自己直连方寸）',
      compatDsh: compat.dsh ? String(compat.dsh) : '',
      compatReleases: compat.dshReleases && typeof compat.dshReleases === 'object' ? compat.dshReleases : undefined,
    })
  }

  const pipePath = pipeNameFor(process.platform, os.tmpdir())
  // 命名管道用 existsSync 判（Windows 上 `\\.\pipe\x` 能 stat 到）；非 Windows 是普通 socket 文件
  let alive = false
  try { alive = fs.existsSync(pipePath) } catch { alive = false }

  const legacy = findLegacyBridge(patchPath)
  const installed = isDir(path.join(home, 'profiles')) || isDir(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness'))
  const dshVer = detectDshVersion(home)

  // ── 派单实况 ──
  const dispatchDir = path.join(getDataDir(), '.dispatch-dsh')
  const auditRows = readAuditRows(dispatchDir)
  const recent = auditRows.slice(-5).reverse()
  const last = recent[0]
  const secretPath = resolveDispatchSecretPath()
  const pluginSecretPath = pluginSecretPick()
  const dispatch: DshDispatchStatus = {
    dir: dispatchDir,
    pending: countFiles(dispatchDir, /^dispatch-.*\.md$/i),
    rejected: countFiles(path.join(dispatchDir, 'rejected'), /\./),
    secret: {
      present: isFile(secretPath),
      path: secretPath,
      pluginPath: pluginSecretPath,
      same: !!pluginSecretPath && path.resolve(pluginSecretPath).toLowerCase() === path.resolve(secretPath).toLowerCase(),
    },
    last,
    recent,
  }

  // ── 诊断清单：每一项只回答“这一环现在是什么状态 + 坏了该动哪里” ──
  const checks: DshDiagnosticCheck[] = []
  const plugin = plugins.find((p) => p.bundled) || plugins[0]
  checks.push({
    key: 'app', label: '方寸本体',
    status: 'ok',
    detail: appVersion ? `v${appVersion}` : '版本由主进程提供（这里没拿到）',
    action: '',
  })
  checks.push({
    key: 'dsh', label: 'DSH 基座',
    status: installed ? (dshVer.version ? 'ok' : 'unknown') : 'bad',
    detail: installed
      ? (dshVer.version ? `v${dshVer.version}` : '装了 DSH，但读不到基座版本（不影响用，只是没法核对兼容表）')
      : '本机没装 DSH —— 这一块只读，不给它造目录',
    action: installed ? '' : '先安装 DeepSeek Harness，再回来装 dsh-fangcun',
  })
  checks.push({
    key: 'plugin', label: '方寸插件',
    status: !installed ? 'unknown' : (!plugins.length ? 'bad' : (!plugin?.bundled ? 'bad' : (plugin.version && cmpVersion(plugin.version, MIN_SIGNED_PLUGIN) < 0 ? 'bad' : 'ok'))),
    detail: !plugins.length
      ? (installed ? '没装 dsh-fangcun —— 方寸的 MCP / 派单都不通' : 'DSH 不在场，无法判断')
      : `${plugin?.name} ${plugin?.version || '(版本未知)'}${plugin?.bundled ? '（已进 bundles）' : '（**没进 bundles**：装了也不会加载）'}`,
    action: !plugins.length
      ? '在 DSH 里装 dsh-fangcun（npm 包 / GitHub Release 的 tgz 都行）'
      : (!plugin?.bundled
        ? '把 dsh-fangcun 加进 profile 的 dsh.profile.bundles'
        : (plugin.version && cmpVersion(plugin.version, MIN_SIGNED_PLUGIN) < 0
          ? `升到 ${MIN_SIGNED_PLUGIN}+：更旧的插件不认识签名派单`
          : '')),
  })
  if (plugin && dshVer.version) {
    const rel = plugin.compatReleases?.[dshVer.version]
    checks.push({
      key: 'compat', label: '插件 ↔ DSH 兼容',
      status: rel ? 'ok' : 'unknown',
      detail: rel
        ? `插件自报：DSH ${dshVer.version} = ${rel}`
        : `插件没登记 DSH ${dshVer.version}（不一定是坏，但没验过；插件声明范围 ${plugin.compatDsh || '未写'}）`,
      action: rel ? '' : '升级 dsh-fangcun 到覆盖当前 DSH 的版本；否则只能以实际派单为准',
    })
  }
  checks.push({
    key: 'pipe', label: 'MCP 通道',
    status: alive ? 'ok' : 'bad',
    detail: `${pipePath} —— ${alive ? '通（插件能读方寸任务）' : '不通（方寸没在跑 / MCP 服务没起来）'}`,
    action: alive ? '' : '确认方寸正在运行；启动日志里搜「MCP 服务 已启动」',
  })
  const secretOk = dispatch.secret.present && dispatch.secret.same
  checks.push({
    key: 'secret', label: '派单签名密钥',
    // 第一次用之前“不存在”是正常态（点派单时才生成）；但两边指向不同文件 = 必炸。
    status: secretOk ? 'ok' : (dispatch.secret.present ? 'bad' : 'warn'),
    detail: secretOk
      ? `两边读同一份：${dispatch.secret.path}（只读存在性，不显示内容）`
      : (dispatch.secret.present
        ? `两边读的**不是同一份**：方寸写 ${dispatch.secret.path}，插件会挑 ${dispatch.secret.pluginPath || '(没找到任何一份)'} —— 验签会稳定失败`
        : `还没有（${dispatch.secret.path}）—— 第一次点「发送给 DSH」时会自动生成，不是故障`),
    action: secretOk ? '' : (dispatch.secret.present
      ? '把旧的那份删掉或统一 userData，再点一次「发送给 DSH」'
      : '点一次「发送给 DSH」生成密钥；若点过仍没有，检查两侧 userData 是否同一个'),
  })
  const badReason = reasonOf(last)
  checks.push({
    key: 'dispatch', label: '派单链路',
    status: badReason ? 'bad' : (dispatch.pending > 0 ? 'warn' : 'ok'),
    detail: badReason
      ? `最近一次被拒（${last?.at ? String(last.at).slice(0, 19).replace('T', ' ') : '时间不详'}）：${badReason.text}`
      : dispatch.pending > 0
        ? `有 ${dispatch.pending} 份派单还没被消费 —— 插件没在跑 / 不在这个 profile`
        : (last
          ? `最近一次成功：${String(last.at || '').slice(0, 19).replace('T', ' ')}${last.project ? ' · ' + last.project : ''}${last.sessionId ? ' · 会话 ' + String(last.sessionId).slice(0, 8) : ''}`
          : '还没有派单记录（没点过「发送给 DSH」，或审计文件还没生成）'),
    action: badReason ? badReason.action : (dispatch.pending > 0 ? '确认 DSH 已启动且加载了 dsh-fangcun；重启 DSH 后再看' : ''),
  })
  if (legacy) {
    checks.push({
      key: 'legacy', label: '旧手工桥',
      status: 'warn',
      detail: `cordis.patch.yml 第 ${legacy.line} 行还有一条手工桥（${legacy.plugin || '名字未写明'}），command 指向 ${legacy.command || '(未写)'}${legacy.commandExists ? '' : '（文件不存在，这条其实连不上）'}`,
      action: '插件已自带接入，这条可以删（方寸不代改 DSH 配置）',
    })
  }

  const worst = checks.reduce((acc, c) => (RANK[c.status] > RANK[acc.status] ? c : acc), checks[0])
  const verdict = worst.status === 'bad'
    ? `有 ${checks.filter((c) => c.status === 'bad').length} 处明确不通：${checks.filter((c) => c.status === 'bad').map((c) => c.label).join('、')} —— 先修「${worst.label}」`
    : worst.status === 'warn'
      ? `能通，但有 ${checks.filter((c) => c.status === 'warn').length} 处要注意：${checks.filter((c) => c.status === 'warn').map((c) => c.label).join('、')}`
      : (checks.every((c) => c.status === 'ok')
        ? '三方版本、通道、签名密钥、派单审计都一致 —— 这一页没有需要你动手的地方'
        : '没有明确故障；标了“未知”的项是读不到证据，不是“没问题”')

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
    dshVersion: dshVer.version,
    dshVersionFrom: dshVer.from,
    profile,
    profileDir,
    plugins,
    pipe: { path: pipePath, alive },
    dispatch,
    checks,
    verdict,
    legacy,
    summary,
  }
}
