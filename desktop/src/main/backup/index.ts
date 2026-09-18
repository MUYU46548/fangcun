/**
 * 备份编排 — 一次完整的备份事务
 *
 * 流程（任一步骤失败都不静默）：
 *   收集数据 → 打包 zip → 【强制自校验】→ 落盘本地 → 本地轮换
 *   → 上传 WebDAV → 核对远端大小 → 远端轮换 → 更新状态
 *
 * 设计约束：
 *  - 校验不通过的包绝不上传，也绝不覆盖本地已有备份
 *  - 密钥文件（llm-config.json 等）永不入包，排除记录写入 manifest 以便审计
 *  - 状态持久化，失败计数可累积，供 UI 显性告警
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import * as data from '../data'
import {
  getBackupConfig, getBackupState, saveBackupState, appendBackupLog,
  decryptSecret, BackupConfig,
} from './config'
import { createSnapshot, verifyZip, sha256OfBuffer, BackupManifest } from './packer'
import { extractZipTo, extractFileFromZip } from './packer'
import { WebdavClient, WebdavError } from './webdav'

export interface RunOptions {
  trigger?: 'manual' | 'scheduled' | 'startup'
  /** 只备本地，跳过远端（远端未配置时自动跳过） */
  localOnly?: boolean
}

export interface RunResult {
  ok: boolean
  partial: boolean
  trigger: string
  localPath: string | null
  localBytes: number
  remotePath: string | null
  remoteBytes: number
  files: number
  rawBytes: number
  durationMs: number
  zipSha256: string
  verifyOk: boolean
  errors: string[]
  warnings: string[]
  excludedSecrets: string[]
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function getLocalBackupDir(): string {
  const cfg = getBackupConfig()
  if (cfg.localDir && cfg.localDir.trim()) return cfg.localDir.trim()
  return path.join(data.getDataDir(), 'backups')
}

export function backupFileBase(): string {
  return `fangcun-data-${stamp()}`
}

/** 备份数据根：桌面版为 userData（内含 task-data/ registry.yaml docs/） */
function resolveRoot(): string {
  return data.getDataDir()
}

/**
 * 执行一次备份。
 * 注意：本函数不抛异常，所有失败都以结果对象返回，便于调度器统一记账。
 */
export async function runBackup(opts: RunOptions = {}): Promise<RunResult> {
  const started = Date.now()
  const trigger = opts.trigger || 'manual'
  const cfg = getBackupConfig()
  const errors: string[] = []
  const warnings: string[] = []

  const result: RunResult = {
    ok: false, partial: false, trigger,
    localPath: null, localBytes: 0,
    remotePath: null, remoteBytes: 0,
    files: 0, rawBytes: 0, durationMs: 0,
    zipSha256: '', verifyOk: false,
    errors, warnings, excludedSecrets: [],
  }

  saveBackupState({ lastRunAt: new Date().toISOString() })

  // ── 1. 打包 ──────────────────────────────────────────────────────────
  let snapshot
  try {
    snapshot = createSnapshot({
      rootDir: resolveRoot(),
      includes: ['task-data', 'registry.yaml', 'docs'],
      appVersion: '0.2.1',
    })
  } catch (e) {
    errors.push(`打包失败：${(e as Error).message}`)
    return finish(result, started)
  }

  result.files = snapshot.manifest.totalFiles
  result.rawBytes = snapshot.manifest.totalBytes
  result.zipSha256 = snapshot.zipSha256
  result.excludedSecrets = snapshot.manifest.excludedSecrets

  if (result.files === 0) {
    errors.push('没有可备份的数据文件（task-data/registry.yaml/docs 均为空或不存在）')
    return finish(result, started)
  }

  // ── 2. 强制自校验（不通过就不落盘、不上传） ──────────────────────────
  const verify = verifyZip(snapshot.zipBuffer)
  result.verifyOk = verify.ok
  if (!verify.ok) {
    errors.push(`备份包自校验失败，已中止：${verify.errors.slice(0, 3).join('；')}`)
    return finish(result, started)
  }

  // ── 3. 本地落盘 ──────────────────────────────────────────────────────
  const localDir = getLocalBackupDir()
  const base = backupFileBase()
  try {
    fs.mkdirSync(localDir, { recursive: true })
    const zipPath = path.join(localDir, `${base}.zip`)
    fs.writeFileSync(zipPath, snapshot.zipBuffer)

    // sidecar：sha256 + manifest，恢复与审计用
    fs.writeFileSync(`${zipPath}.sha256`, snapshot.zipSha256, 'utf-8')
    fs.writeFileSync(
      path.join(localDir, `${base}.manifest.json`),
      JSON.stringify(snapshot.manifest, null, 2),
      'utf-8'
    )

    // 回读校验：确认落盘内容与内存一致（防磁盘写入静默损坏）
    const readBack = fs.readFileSync(zipPath)
    if (sha256OfBuffer(readBack) !== snapshot.zipSha256) {
      errors.push('本地写入后回读校验失败（磁盘内容与内存不一致）')
      try { fs.rmSync(zipPath, { force: true }) } catch {}
      return finish(result, started)
    }

    result.localPath = zipPath
    result.localBytes = readBack.length
  } catch (e) {
    errors.push(`本地写入失败：${(e as Error).message}`)
    return finish(result, started)
  }

  // ── 4. 本地轮换 ──────────────────────────────────────────────────────
  try {
    const removed = rotateLocal(localDir, cfg.localKeep)
    if (removed > 0) appendBackupLog(`本地轮换删除 ${removed} 个旧备份`)
  } catch (e) {
    warnings.push(`本地轮换失败：${(e as Error).message}`)
  }

  // ── 5. 上传远端 ──────────────────────────────────────────────────────
  const remoteConfigured = !!cfg.remote.url
  if (opts.localOnly || !remoteConfigured) {
    if (!remoteConfigured && !opts.localOnly) {
      warnings.push('未配置 WebDAV，仅完成本地备份')
    }
    return finish(result, started)
  }

  try {
    const password = decryptSecret(cfg.remote.passwordEnc)
    const client = new WebdavClient({
      baseUrl: cfg.remote.url,
      username: cfg.remote.username,
      password,
      allowSelfSigned: cfg.remote.allowSelfSigned,
      timeoutMs: 120000,
    })

    await client.ensureCollection('')

    const zipName = `${base}.zip`
    await client.put(zipName, snapshot.zipBuffer, 'application/zip')
    await client.put(`${zipName}.sha256`, Buffer.from(snapshot.zipSha256, 'utf-8'), 'text/plain')
    await client.put(
      `${base}.manifest.json`,
      Buffer.from(JSON.stringify(snapshot.manifest, null, 2), 'utf-8'),
      'application/json'
    )

    // 核对远端大小 —— 上传"看起来成功"但截断的情况必须抓出来
    const remoteSize = await client.statSize(zipName)
    if (remoteSize !== null && remoteSize !== snapshot.zipBuffer.length) {
      errors.push(`远端大小与本地不一致（远端 ${remoteSize} / 本地 ${snapshot.zipBuffer.length}），备份可能被截断`)
    } else {
      result.remotePath = `${cfg.remote.url}/${zipName}`
      result.remoteBytes = snapshot.zipBuffer.length
    }

    // 远端轮换：一次备份产出 3 个文件，按 base 聚合成一个"备份组"
    if (cfg.remoteKeep > 0) {
      try {
        const removed = await rotateRemote(client, cfg.remoteKeep)
        if (removed > 0) appendBackupLog(`远端轮换删除 ${removed} 个旧备份组`)
      } catch (e) {
        warnings.push(`远端轮换失败：${(e as Error).message}`)
      }
    }
  } catch (e) {
    const msg = e instanceof WebdavError ? e.message : `上传失败：${(e as Error).message}`
    errors.push(msg)
  }

  return finish(result, started)
}

function finish(result: RunResult, started: number): RunResult {
  result.durationMs = Date.now() - started
  const localOk = !!result.localPath
  const remoteOk = !getBackupConfig().remote.url || !!result.remotePath
  result.partial = localOk && !remoteOk
  result.ok = localOk && result.errors.length === 0

  const now = new Date().toISOString()
  if (result.ok) {
    saveBackupState({
      lastSuccessAt: now,
      lastError: null,
      failStreak: 0,
      lastLocalPath: result.localPath,
      lastRemotePath: result.remotePath,
      lastFiles: result.files,
      lastBytes: result.rawBytes,
      lastDurationMs: result.durationMs,
    })
    appendBackupLog(
      `OK trigger=${result.trigger} files=${result.files} raw=${result.rawBytes}B zip=${result.localBytes}B ` +
      `remote=${result.remotePath ? 'yes' : 'no'} ${result.durationMs}ms`
    )
  } else {
    const prev = getBackupState()
    saveBackupState({
      lastError: result.errors.join(' | ').slice(0, 500),
      lastErrorAt: now,
      failStreak: (prev.failStreak || 0) + 1,
      lastLocalPath: result.localPath,
      lastRemotePath: result.remotePath,
      lastFiles: result.files,
      lastBytes: result.rawBytes,
      lastDurationMs: result.durationMs,
    })
    appendBackupLog(`FAIL trigger=${result.trigger} errors=${result.errors.join(' | ').slice(0, 300)}`)
  }
  return result
}

// ── 轮换 ─────────────────────────────────────────────────────────────────

export function listLocalBackups(): Array<{ name: string; path: string; bytes: number; mtime: string; sha256: string | null }> {
  const dir = getLocalBackupDir()
  if (!fs.existsSync(dir)) return []
  const out: Array<{ name: string; path: string; bytes: number; mtime: string; sha256: string | null }> = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.zip')) continue
    const p = path.join(dir, f)
    try {
      const st = fs.statSync(p)
      const sc = `${p}.sha256`
      out.push({
        name: f, path: p, bytes: st.size, mtime: st.mtime.toISOString(),
        sha256: fs.existsSync(sc) ? fs.readFileSync(sc, 'utf-8').trim().slice(0, 16) : null,
      })
    } catch { /* 跳过不可读条目 */ }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name))
}

/** 保留最新 keep 份，其余删除。返回删除数量。 */
export function rotateLocal(dir: string, keep: number): number {
  if (!fs.existsSync(dir)) return 0
  const bases = new Set<string>()
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^(fangcun-data-\d{8}-\d{6})\./)
    if (m) bases.add(m[1])
  }
  const sorted = Array.from(bases).sort()
  let removed = 0
  while (sorted.length > keep) {
    const b = sorted.shift()!
    for (const ext of ['.zip', '.zip.sha256', '.manifest.json']) {
      const p = path.join(dir, b + ext)
      try {
        if (fs.existsSync(p)) { fs.unlinkSync(p); if (ext === '.zip') removed++ }
      } catch { /* 单个删除失败不中断 */ }
    }
  }
  return removed
}

async function rotateRemote(client: WebdavClient, keep: number): Promise<number> {
  const files = await client.list('')
  const bases = new Set<string>()
  for (const f of files) {
    const m = f.name.match(/^(fangcun-data-\d{8}-\d{6})\./)
    if (m) bases.add(m[1])
  }
  const sorted = Array.from(bases).sort()
  let removed = 0
  while (sorted.length > keep) {
    const b = sorted.shift()!
    for (const name of [`${b}.zip`, `${b}.zip.sha256`, `${b}.manifest.json`]) {
      try {
        await client.remove(name)
        if (name.endsWith('.zip')) removed++
      } catch { /* 远端删除失败不中断轮换 */ }
    }
  }
  return removed
}

// ── 远端读取（恢复用） ───────────────────────────────────────────────────

export function makeClient(): WebdavClient {
  const cfg = getBackupConfig()
  if (!cfg.remote.url) throw new Error('未配置 WebDAV 地址')
  return new WebdavClient({
    baseUrl: cfg.remote.url,
    username: cfg.remote.username,
    password: decryptSecret(cfg.remote.passwordEnc),
    allowSelfSigned: cfg.remote.allowSelfSigned,
    timeoutMs: 120000,
  })
}

export async function listRemoteBackups(): Promise<Array<{ name: string; bytes: number | null; mtime: string | null }>> {
  const client = makeClient()
  const files = await client.list('')
  return files
    .filter(f => f.name.endsWith('.zip'))
    .map(f => ({ name: f.name, bytes: f.size, mtime: f.mtime }))
    .sort((a, b) => b.name.localeCompare(a.name))
}

/** 下载远端备份到本地临时目录，返回本地路径 */
export async function downloadRemote(name: string, destDir: string): Promise<string> {
  const client = makeClient()
  const buf = await client.get(name)
  fs.mkdirSync(destDir, { recursive: true })
  const p = path.join(destDir, name)
  fs.writeFileSync(p, buf)
  return p
}

// ── 手动导出（落到任意目录，例如网盘同步文件夹） ─────────────────────────

export interface ExportResult {
  ok: boolean
  dir: string
  zipPath: string | null
  sidecarPath: string | null
  manifestPath: string | null
  readmePath: string | null
  toolPath: string | null
  bytes: number
  files: number
  errors: string[]
}

/**
 * 定位随应用分发的独立恢复工具。
 * 打包后在 resources/public 下；开发时回落仓库 scripts/。
 */
function resolveRestoreToolPath(): string | null {
  const candidates: string[] = []
  try {
    if (process.resourcesPath) {
      // extraResources 落在 asar 之外，优先级最高（一定可读）
      candidates.push(path.join(process.resourcesPath, 'tools', 'fangcun-restore.py'))
      candidates.push(path.join(process.resourcesPath, 'public', 'fangcun-restore.py'))
    }
  } catch { /* 非打包环境无此属性 */ }
  try {
    // 打包后 app.getAppPath() 指向 app.asar，Electron 的 fs 可读 asar 内部
    candidates.push(path.join(app.getAppPath(), 'public', 'fangcun-restore.py'))
  } catch { /* ignore */ }
  // 开发环境：仓库 scripts/
  try {
    candidates.push(path.join(app.getAppPath(), '..', 'scripts', 'fangcun-restore.py'))
  } catch { /* ignore */ }
  candidates.push(path.join(process.cwd(), 'scripts', 'fangcun-restore.py'))
  candidates.push(path.join(process.cwd(), '..', 'scripts', 'fangcun-restore.py'))

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c
    } catch { /* 继续找下一个 */ }
  }
  return null
}

function renderReadme(m: BackupManifest, zipName: string, zipSha256: string, zipBytes: number): string {
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`
  const excluded = m.excludedSecrets.length ? m.excludedSecrets.join(', ') : '（本次无）'
  return `方寸数据备份说明
================

备份时间   : ${m.createdAt}
来源主机   : ${m.hostname}
备份工具   : 方寸 ${m.appVersion}
文件数     : ${m.totalFiles}
原始体积   : ${kb(m.totalBytes)}（${m.totalBytes.toLocaleString()} B）
压缩后体积 : ${kb(zipBytes)}（${zipBytes.toLocaleString()} B）
归档文件   : ${zipName}
sha256     : ${zipSha256}

包含什么
--------
  task-data/       任务数据（Markdown + frontmatter）
  registry.yaml    项目登记表
  docs/            执行日志等文档
  manifest.json    逐文件 sha256 清单（已含在归档内）

不包含什么（有意排除，防止密钥外泄）
------------------------------------
  llm-config.json、backup-config.json、apps.json、credentials.json、.env、
  *.key / *.pem / *.p12 / *.jks，
  以及 node_modules、Cache、.trash、backups 等缓存与临时目录。
  本次实际排除：${excluded}

怎么校验
--------
  python fangcun-restore.py verify "${zipName}"

  输出 PASS 表示 sha256、ZIP 结构、逐条 CRC、local/central directory 一致性、
  以及 manifest 自洽全部通过。任一项不符会列出具体原因。

怎么恢复
--------
  方式一（推荐，可脱离方寸应用）：
      python fangcun-restore.py extract "${zipName}" <目标目录>
      再把还原出的 task-data/ 与 registry.yaml 放回方寸数据目录。

  方式二（用方寸应用）：
      设置页 →「🛡️ 备份与恢复」→ 本地标签 →「恢复」。
      应用会在恢复前自动给现有数据打快照，失败自动回滚。

恢复前请务必
------------
  · 先确认当前数据已另存一份（用应用恢复会自动快照；手工操作需自行备份）
  · 先校验再解压（独立工具已强制：校验不过直接拒绝解压）
  · 恢复后打开方寸确认任务数量与列表正常

注意
----
  本包含你任务数据的完整内容，但**不含任何密钥**。
  请勿将其放入公开可访问的位置；上传网盘时优先选择私有目录。
`
}

/**
 * 导出一份完整备份到指定目录（不触发远端上传、不影响自动备份的轮换目录）。
 * 典型用途：导出到网盘同步文件夹（OneDrive / 坚果云 / 群晖 Drive 等），由客户端负责上传。
 */
export function exportSnapshotTo(destDir: string, opts: { includeTool?: boolean } = {}): ExportResult {
  const errors: string[] = []
  const result: ExportResult = {
    ok: false, dir: destDir,
    zipPath: null, sidecarPath: null, manifestPath: null, readmePath: null, toolPath: null,
    bytes: 0, files: 0, errors,
  }

  if (!destDir || !destDir.trim()) {
    errors.push('未指定导出目录')
    return result
  }

  let snapshot
  try {
    snapshot = createSnapshot({
      rootDir: resolveRoot(),
      includes: ['task-data', 'registry.yaml', 'docs'],
      appVersion: '0.2.1',
    })
  } catch (e) {
    errors.push(`打包失败：${(e as Error).message}`)
    return result
  }

  if (snapshot.manifest.totalFiles === 0) {
    errors.push('没有可导出的数据文件')
    return result
  }

  // 导出前强制自校验：不通过绝不落盘
  const verify = verifyZip(snapshot.zipBuffer)
  if (!verify.ok) {
    errors.push(`导出包自校验失败，已中止：${verify.errors.slice(0, 3).join('；')}`)
    return result
  }

  const base = backupFileBase()
  const zipName = `${base}.zip`
  try {
    fs.mkdirSync(destDir, { recursive: true })

    const zipPath = path.join(destDir, zipName)
    fs.writeFileSync(zipPath, snapshot.zipBuffer)

    const sidecarPath = `${zipPath}.sha256`
    fs.writeFileSync(sidecarPath, snapshot.zipSha256, 'utf-8')

    const manifestPath = path.join(destDir, `${base}.manifest.json`)
    fs.writeFileSync(manifestPath, JSON.stringify(snapshot.manifest, null, 2), 'utf-8')

    const readmePath = path.join(destDir, `${base}.README.txt`)
    fs.writeFileSync(readmePath, renderReadme(snapshot.manifest, zipName, snapshot.zipSha256, snapshot.zipBuffer.length), 'utf-8')

    if (opts.includeTool) {
      const tool = resolveRestoreToolPath()
      if (tool) {
        const dest = path.join(destDir, 'fangcun-restore.py')
        fs.copyFileSync(tool, dest)
        result.toolPath = dest
      } else {
        errors.push('未找到独立恢复脚本 fangcun-restore.py，已跳过（不影响备份本身可用）')
      }
    }

    // 回读校验：确认磁盘上的内容与内存一致
    const readBack = fs.readFileSync(zipPath)
    if (sha256OfBuffer(readBack) !== snapshot.zipSha256) {
      try { fs.rmSync(zipPath, { force: true }) } catch {}
      errors.push('导出后回读校验失败，文件可能写入不完整')
      return result
    }

    result.zipPath = zipPath
    result.sidecarPath = sidecarPath
    result.manifestPath = manifestPath
    result.readmePath = readmePath
    result.bytes = readBack.length
    result.files = snapshot.manifest.totalFiles
    result.ok = errors.length === 0

    appendBackupLog(
      `EXPORT dir=${destDir} files=${result.files} bytes=${result.bytes} tool=${result.toolPath ? 'yes' : 'no'}`
    )
  } catch (e) {
    errors.push(`导出失败：${(e as Error).message}`)
  }

  return result
}

/** 校验任意路径下的备份包（含手动上传/下载回来的包） */
export function verifyPackage(zipPath: string): {
  ok: boolean
  errors: string[]
  manifest: BackupManifest | null
  entries: number
  sidecarChecked: boolean
  actualSha256: string
} {
  const errors: string[] = []
  let sidecarChecked = false
  let actualSha256 = ''

  if (!fs.existsSync(zipPath)) {
    return { ok: false, errors: [`文件不存在：${zipPath}`], manifest: null, entries: 0, sidecarChecked, actualSha256 }
  }

  let buf: Buffer
  try {
    buf = fs.readFileSync(zipPath)
  } catch (e) {
    return { ok: false, errors: [`读取失败：${(e as Error).message}`], manifest: null, entries: 0, sidecarChecked, actualSha256 }
  }
  actualSha256 = sha256OfBuffer(buf)

  const sidecar = `${zipPath}.sha256`
  if (fs.existsSync(sidecar)) {
    sidecarChecked = true
    const expected = fs.readFileSync(sidecar, 'utf-8').trim()
    if (expected && expected !== actualSha256) {
      errors.push(`sha256 不匹配（期望 ${expected.slice(0, 16)}…，实际 ${actualSha256.slice(0, 16)}…）—— 文件已改动或传输损坏`)
    }
  }

  const v = verifyZip(buf)
  errors.push(...v.errors)

  return {
    ok: errors.length === 0,
    errors,
    manifest: v.manifest,
    entries: v.entryCount,
    sidecarChecked,
    actualSha256,
  }
}

export { extractZipTo, extractFileFromZip, verifyZip, WebdavClient }
export type { BackupManifest }
