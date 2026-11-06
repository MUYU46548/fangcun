/**
 * 把方寸的 MCP 端点**接进 Hermes**（2026-11-06 暮雨：“Hermes 要接，而且应该通过方寸去接”）。
 *
 * ── 为什么这文件必须单独存在 ──────────────────────────────────────────
 * `mcpConnect.ts` 有一条硬守卫：**零写调用**（A 路线：方寸只出材料，不写别人的配置）。
 * 那条守卫本身是对的，它挡住的是“方寸四处乱写别人家的文件”。
 * Hermes 是**方寸自己的宿主**：方寸的技能本来就直装进 `%LOCALAPPDATA%\hermes\skills`，
 * 而 Hermes 的 MCP 配置一直没人接（`check-agent-mcp` 报“未配置方寸”）——
 * 用户要的是“点一下接上”，不是“复制一段自己去贴”。
 *
 * 所以：**写能力只在这个文件里**，且只写**一个**目标（Hermes 的 config.yaml），
 * `mcpConnect.ts` 继续保持零写。测试里两条守卫都留着（见 e2e-mcp-connect ③ 与 e2e-hermes-link）。
 *
 * ── 写别人文件的四条纪律（缺一条都不许上线）────────────────────────────
 *   ① **先备份**：同目录 `config.yaml.bak-fangcun-<时间戳>`，失败原样还原；
 *   ② **文本块插入**，绝不 `load`+`dump`（那会把用户的注释、引号风格、键顺序全洗掉）；
 *   ③ **原子写**：写 `.tmp` 再 rename，中途崩了不会留下半个文件；
 *   ④ **写完必须自证**：把新增块整段抠掉后要与原文**逐字节相同**，且 YAML 能解析
 *      （解析交给 Python 侧的测试去做 —— 主进程不带 yaml 库，这里只做结构断言）。
 *
 * 幂等：已有真实 `fangcun` 条目就一个字都不写（返回 changed:false），
 * 并把命中的行号告诉用户 —— “已经接上了”和“刚接上”必须能分清。
 */

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import * as appLog from './appLog'
import { buildMcpSnippet, hermesHome, type McpEntryId } from './mcpConnect'
import { fangcunConfigHit } from './probe'

export interface HermesLinkStatus {
  configPath: string
  /** 配置文件在不在（不在就不写 —— 不替 Hermes 建配置） */
  present: boolean
  linked: boolean
  /** 命中位置（人话） */
  where: string
}

export interface HermesLinkResult {
  ok: boolean
  /** 给人看的一句话（成功/失败都要有内容，不许空着） */
  message: string
  /** 这次到底改了没有（幂等命中时为 false） */
  changed: boolean
  /** 备份文件绝对路径（没写就不给） */
  backupPath?: string
  /** 插入的块（失败时为 attempted，便于排障） */
  block?: string
  error?: string
}

/** Hermes 的配置文件真身 —— 与 `mcpConnect.hermesHome()` 同一份解析，不另起口径 */
export function hermesConfigPath(): string {
  return path.join(hermesHome(), 'config.yaml')
}

export function hermesMcpLinkStatus(): HermesLinkStatus {
  const configPath = hermesConfigPath()
  let present = false
  try { present = fs.statSync(configPath).isFile() } catch { present = false }
  const hit = present ? fangcunConfigHit(configPath) : { linked: false, where: '' }
  return {
    configPath,
    present,
    linked: hit.linked,
    where: hit.linked ? hit.where : (present ? '没有 fangcun 条目' : '配置文件不存在'),
  }
}

/** 生成要插进 `mcp_servers:` 里的那一段（缩进 2，不含 `mcp_servers:` 首行） */
function fangcunBlock(entryId: McpEntryId): { ok: boolean; block: string; message: string } {
  const sn = buildMcpSnippet('hermes', entryId)
  if (!sn.ok) return { ok: false, block: '', message: sn.message }
  const lines = sn.snippet.split('\n')
  // 首行是 `mcp_servers:` —— 我们只要它下面那段（已经有 mcp_servers 段时只插子项）
  if (!/^mcp_servers:\s*$/.test(lines[0])) {
    return { ok: false, block: '', message: `配置段形状变了（首行不是 mcp_servers:）：${lines[0]}` }
  }
  return { ok: true, block: lines.slice(1).join('\n'), message: '' }
}

/**
 * 找 `mcp_servers:` 这一段的插入点（行号，插在这一行之前）。
 *
 * 返回 null = 文件里没有 `mcp_servers:` 段；否则返回“该段最后一个子项之后”的行号。
 * ⚠ 只认**行首无缩进**的顶层键作为段结束标志 —— 缩进 2 的 `  fangcun:` 是子项，不是新段。
 */
function findMcpServersInsertAt(lines: string[]): number | null {
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^mcp_servers:\s*(#.*)?$/.test(lines[i])) { start = i; break }
  }
  if (start < 0) return null
  let last = start
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i]
    const t = raw.trim()
    const indented = /^\s/.test(raw)
    if (t === '') continue
    // 段结束：顶格的新键 / 顶格的注释块（注释大概率在讲下一段）
    if (!indented) break
    last = i
  }
  // 插在“最后一个子项”之后（即 last + 1）；若段是空的，就是 start + 1
  return last + 1
}

/** 行尾风格跟随原文件（CRLF 机器上别混进裸 LF） */
function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 把一段文本按行拆开，丢掉末尾空行（拼接时统一由调用方补） */
function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 接入 Hermes（幂等）。**它会写 `%LOCALAPPDATA%\hermes\config.yaml`** —— 调用方必须先征求用户同意。
 */
export function linkHermesMcp(entryId: McpEntryId): HermesLinkResult {
  const configPath = hermesConfigPath()

  let original = ''
  try {
    original = fs.readFileSync(configPath, 'utf-8')
  } catch (e: any) {
    const msg = `读不到 Hermes 配置（${configPath}）—— 方寸不替它新建配置文件`
    appLog.warn('mcp', msg, e?.message || String(e))
    return { ok: false, changed: false, message: msg, error: e?.message || String(e) }
  }

  // 幂等：已有真实条目就一个字都不写（注释里出现 fangcun 不算，见 probe.fangcunConfigHit）
  const hit = fangcunConfigHit(configPath)
  if (hit.linked) {
    const msg = `Hermes 已经接上了（${hit.where}），这次没有改动任何文件`
    appLog.info('mcp', msg)
    return { ok: true, changed: false, message: msg }
  }

  const b = fangcunBlock(entryId)
  if (!b.ok) return { ok: false, changed: false, message: `生成配置段失败：${b.message}`, error: b.message }

  const eol = detectEol(original)
  const blockLines = splitLines(b.block)
  const lines = splitLines(original)

  const insertAt = findMcpServersInsertAt(lines)
  let next: string[]
  if (insertAt === null) {
    // 没有 mcp_servers 段：在文件末尾新建一段
    next = [...lines, 'mcp_servers:', ...blockLines]
  } else {
    next = [...lines.slice(0, insertAt), ...blockLines, ...lines.slice(insertAt)]
  }
  const newText = next.join(eol) + eol

  // 备份（同目录，带时间戳）—— 写之前先落，写坏才有东西可还原
  const backupPath = `${configPath}.bak-fangcun-${stamp()}`
  try {
    fs.writeFileSync(backupPath, original, 'utf-8')
  } catch (e: any) {
    const msg = `备份失败，已放弃写入：${e?.message || e}`
    appLog.error('mcp', msg, backupPath)
    return { ok: false, changed: false, message: msg, error: e?.message || String(e) }
  }

  // 原子写：同目录 .tmp → rename
  const tmp = `${configPath}.fangcun-tmp`
  try {
    fs.writeFileSync(tmp, newText, 'utf-8')
    fs.renameSync(tmp, configPath)
  } catch (e: any) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 清不掉也只是留个 .tmp */ }
    try { fs.copyFileSync(backupPath, configPath) } catch { /* 还原失败要明说 */ }
    const msg = `写入失败，已从备份还原：${e?.message || e}`
    appLog.error('mcp', msg, { configPath, backupPath })
    return { ok: false, changed: false, message: msg, backupPath, error: e?.message || String(e) }
  }

  // 写完自证（三条，缺一条都还原）：
  //   ① 读回来的内容 == 刚写下去的内容（编码 / 换行没被转换）；
  //   ② 把新增块按行抠掉后，剩下的**逐行**等于原文（只加不删、顺序没乱）；
  //   ③ 按 fangcunConfigHit 的口径（剥注释）确实命中新条目。
  // ⚠ 不能用 `readBack.split(block).join('')` —— 块前后各有一个换行会留下空行，
  //   判据会永远对不上（2026-11-06 首版就是这么把自己判红的）。
  let ok = false
  let reason = ''
  try {
    const readBack = fs.readFileSync(configPath, 'utf-8')
    if (readBack !== newText) reason = '读回来的内容与写下去的不一致（编码或换行被改了）'

    const readLines = splitLines(readBack)
    const expectBody = insertAt === null
      ? readLines.slice(0, lines.length)
      : readLines.slice(0, insertAt).concat(readLines.slice(insertAt + blockLines.length))
    const bodySame = expectBody.length === lines.length && expectBody.every((l, i) => l === lines[i])
    if (!reason && !bodySame) reason = '把新增块抠掉后与原文对不上（说明动了别的行）'

    // 被抠掉的那一段必须**就是**我们想加的块（防止“插对了行数、插错了内容”）
    const removed = insertAt === null ? readLines.slice(lines.length) : readLines.slice(insertAt, insertAt + blockLines.length)
    const expectRemoved = insertAt === null ? ['mcp_servers:', ...blockLines] : blockLines
    if (!reason && removed.join('\n') !== expectRemoved.join('\n')) {
      reason = '真正插进去的不是我们生成的那一段'
    }

    if (!reason && !fangcunConfigHit(configPath).linked) reason = '回读时仍然找不到 fangcun 条目'
    ok = !reason
  } catch (e: any) {
    reason = `回读失败：${e?.message || e}`
  }

  if (!ok) {
    try { fs.copyFileSync(backupPath, configPath) } catch { /* 还原失败下面会写进错误信息 */ }
    const msg = `写后自证没通过（${reason}），已还原到 ${backupPath}`
    appLog.error('mcp', msg, { configPath, backupPath })
    return { ok: false, changed: false, message: msg, backupPath, error: reason }
  }

  appLog.info('mcp', `已把 fangcun 接进 Hermes（入口 ${entryId}）`, { configPath, backupPath, insertAt })
  // message 里把**写入的 command 原文**带出来：这条路径以后就是 Hermes 启动方寸的方式，
  // 用户有权一眼看见它指向哪（dev 下会是 node/electron 的路径，装正式版后应重新接一次）。
  const cmd = /^ {4}command:\s*(.+)$/m.exec(blockLines.join('\n'))
  const cmdText = cmd ? cmd[1].replace(/^"|"$/g, '').replace(/\\\\/g, '\\') : ''
  const devNote = app.isPackaged ? '' : '（注意：这是开发版，command 指向开发目录 —— 装上正式版后建议再点一次重接）'
  return {
    ok: true,
    changed: true,
    message: `已接入 Hermes：mcp_servers 下新增 fangcun。command = ${cmdText || '(见配置文件)'}；备份 ${path.basename(backupPath)}；Hermes 里 /reload-mcp 生效。${devNote}`,
    backupPath,
    block: blockLines.join(eol),
  }
}
