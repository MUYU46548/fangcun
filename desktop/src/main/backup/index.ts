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
import * as data from '../data'
import {
  getBackupConfig, getBackupState, saveBackupState, appendBackupLog,
  decryptSecret, BackupConfig,
} from './config'
import {
  createSnapshot, verifyZip, sha256OfBuffer, BackupManifest, OmittedEntry, planSnapshot,
} from './packer'
import { BACKUP_INCLUDES, LOG_ATTACHMENTS_REL, scopeSources } from './scope'
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
  /** 被瘦身跳过的文件（逐条记账，界面直接显示"少了什么/省了多少"） */
  omittedFiles: OmittedEntry[]
  omittedBytes: number
  /** 2026-10-18：本地轮换逐条记录（base + 释放 MB + 触发原因），结果对象直接可审计 */
  rotated: Array<{ base: string; mb: number; reason: string }>
  /** 本地轮换释放的总字节（三件套实测合计） */
  rotatedFreedBytes: number
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

/** 备份数据根：桌面版为 userData（内含 task-data/ registry.yaml policies/ docs/） */
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
    omittedFiles: [], omittedBytes: 0,
    rotated: [], rotatedFreedBytes: 0,
  }

  saveBackupState({ lastRunAt: new Date().toISOString() })

  // ── 1. 打包 ──────────────────────────────────────────────────────────
  let snapshot
  try {
    snapshot = createSnapshot(scopeSources())
  } catch (e) {
    errors.push(`打包失败：${(e as Error).message}`)
    return finish(result, started)
  }

  result.files = snapshot.manifest.totalFiles
  result.rawBytes = snapshot.manifest.totalBytes
  result.zipSha256 = snapshot.zipSha256
  result.excludedSecrets = snapshot.manifest.excludedSecrets
  result.omittedFiles = snapshot.manifest.omittedFiles || []
  result.omittedBytes = snapshot.manifest.omittedBytes || 0

  if (result.files === 0) {
    errors.push('没有可备份的数据文件（task-data/registry.yaml/docs 均为空或不存在）')
    return finish(result, started)
  }

  // ── 1.5 半包守卫（2026-10-18 恢复演练抓到的真坑）───────────────────────
  // task-data 是任务卡真源；docs 兜底凑数会打出"恢复必被拒"的半包，
  // 用户却已看到备份成功的 toast —— 必须在落盘前拒绝，而不是等恢复时才炸。
  const hasTaskData = snapshot.manifest.files.some(f => f.path.startsWith('task-data/'))
  if (!hasTaskData) {
    errors.push('数据根缺少 task-data/（任务卡真源），这份包恢复不出来 —— 已拒绝落盘。请检查数据根路径是否指错')
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

  // ── 4. 本地轮换（份数线 localKeep + 体积线 maxLocalMb，逐条记账 2026-10-18）──
  // 2026-10-21（W1-1A 补真缺口）：**先写待删清单、再动手删**。
  // 原来的顺序是"删完才逐条记账"——功能看着一样，但删除中途崩掉（磁盘占用/权限/断电）
  // 就会出现"文件没了、日志里查不到删了什么"，而这正是"删除前存档"要挡的唯一场景。
  // 做法：先 dryRun 一次拿到计划（rotateLocal 本来就有 dryRun，不新造机制），记完再真删。
  try {
    const plan = rotateLocal(localDir, cfg.localKeep, cfg.maxLocalMb, true)
    if (plan.removed.length > 0) {
      const list = plan.removed.map((r) => `${r.base}(${(r.bytes / 1048576).toFixed(2)}MB)`).join('、')
      appendBackupLog(`轮换计划淘汰 ${plan.removed.length} 组（保留 ${cfg.localKeep} 份 / 上限 ${cfg.maxLocalMb || '不限'}MB）：${list}`)
    }
    const rep = rotateLocal(localDir, cfg.localKeep, cfg.maxLocalMb)
    result.rotated = rep.removed.map((r, i) => ({
      base: r.base,
      mb: +(r.bytes / 1048576).toFixed(2),
      reason: rep.reasons[i]?.reason || '',
    }))
    result.rotatedFreedBytes = rep.freedBytes
    for (const r of result.rotated) {
      appendBackupLog(`轮换淘汰 ${r.base}（释放 ${r.mb}MB，${r.reason}）`)
    }
    if (rep.unrecognized.length > 0) {
      warnings.push(`备份目录有 ${rep.unrecognized.length} 个非标准命名的 zip 未参与轮换（手工改名/导入包？）：${rep.unrecognized.slice(0, 3).join(', ')}${rep.unrecognized.length > 3 ? ' …' : ''}`)
    }
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
      `remote=${result.remotePath ? 'yes' : 'no'} omitted=${result.omittedFiles.length}(${result.omittedBytes}B) ` +
      `${result.durationMs}ms`
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
  // 2026-09-25（用户第 5 条）：用户要的是「最后更新的自动排在前面」。
  // 原来只按**文件名**倒序 —— 名字里的时间戳是代理值，一旦有手工改名/导入的包就失序。
  // 主判据改成 mtime（真正的最后更新），文件名只做同毫秒的稳定 tiebreak。
  return out.sort((a, b) =>
    (Date.parse(b.mtime) || 0) - (Date.parse(a.mtime) || 0) || b.name.localeCompare(a.name))
}

/**
 * 轮换执行报告（2026-10-18 体积线+逐条记账改造）。
 * 「先预览再删」：dryRun=true 时只算不删，返回的 removed 就是将要删的清单。
 */
export interface RotateReport {
  /** 逐条删除记录：base + 该组 zip 字节数（含 .zip / .zip.sha256 / .manifest.json 三件套） */
  removed: Array<{ base: string; bytes: number }>
  /** 本次轮换释放的总字节数（三件套合计） */
  freedBytes: number
  /** 轮换后剩余组数 */
  kept: number
  /** 目录里不匹配标准名 fangcun-data-YYYYMMDD-HHMMSS 的 .zip（不参与轮换计数，人工关注） */
  unrecognized: string[]
  /** 触发淘汰的原因（逐条对应 removed 的顺序）："份数超限" | "体积超限" */
  reasons: Array<{ base: string; reason: string }>
}

/** 目录体检（不删任何东西）：配置 keep/maxMb 与目录实际状态的差异诊断，轮换体检/演练脚本共用。 */
export function diagnoseRotation(dir: string, keep: number, maxMb: number): {
  dirExists: boolean
  standardCount: number
  totalBytes: number
  unrecognized: string[]
  oldestStandard: string | null
  newestStandard: string | null
  /** 体检结论（人话，逐条） */
  verdicts: string[]
} {
  const verdicts: string[] = []
  if (!fs.existsSync(dir)) {
    return { dirExists: false, standardCount: 0, totalBytes: 0, unrecognized: [], oldestStandard: null, newestStandard: null, verdicts: ['目录不存在：' + dir] }
  }
  const groups = collectGroups(dir)
  const bytes = groups.reduce((s, g) => s + g.bytes, 0)
  const unrecognized = fs.readdirSync(dir).filter((f) => f.endsWith('.zip') && !/^fangcun-data-\d{8}-\d{6}\.zip$/.test(f))
  const sorted = [...groups].sort((a, b) => a.mtimeMs - b.mtimeMs)
  const oldest = sorted[0] || null
  const newest = sorted[sorted.length - 1] || null
  if (unrecognized.length > 0) {
    verdicts.push(`有 ${unrecognized.length} 个非标准命名的 zip 不参与轮换（手工改名/导入包/旧版格式）：${unrecognized.slice(0, 5).join(', ')}${unrecognized.length > 5 ? ' …' : ''}`)
  }
  if (groups.length > keep) {
    verdicts.push(`份数 ${groups.length} > 保留线 ${keep}：按配置下次轮换会淘汰最旧 ${groups.length - keep} 组（本函数只是体检，不删）`)
  } else {
    verdicts.push(`份数 ${groups.length} ≤ 保留线 ${keep}：份数线未触发`)
  }
  if (maxMb > 0 && bytes > maxMb * 1024 * 1024) {
    verdicts.push(`体积 ${(bytes / 1048576).toFixed(1)}MB > 上限 ${maxMb}MB：按配置下次轮换会从最旧开始淘汰到线下（本函数只是体检，不删）`)
  } else if (maxMb > 0) {
    verdicts.push(`体积 ${(bytes / 1048576).toFixed(1)}MB ≤ 上限 ${maxMb}MB：体积线未触发`)
  } else {
    verdicts.push('体积线未启用（maxLocalMb=0）')
  }
  return {
    dirExists: true,
    standardCount: groups.length,
    totalBytes: bytes,
    unrecognized,
    oldestStandard: oldest ? oldest.base : null,
    newestStandard: newest ? newest.base : null,
    verdicts,
  }
}

/** 收集标准命名的备份组（一组 = base + zip/sha256/manifest 三件套）。bytes=三件套实测合计；mtimeMs 以 zip 为准。 */
function collectGroups(dir: string): Array<{ base: string; bytes: number; mtimeMs: number }> {
  const bases = new Map<string, { bytes: number; mtimeMs: number }>()
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^(fangcun-data-\d{8}-\d{6})\.(zip|zip\.sha256|manifest\.json)$/)
    if (!m) continue
    try {
      const st = fs.statSync(path.join(dir, f))
      const cur = bases.get(m[1]) || { bytes: 0, mtimeMs: 0 }
      cur.bytes += st.size
      if (m[2] === 'zip') cur.mtimeMs = st.mtimeMs
      bases.set(m[1], cur)
    } catch { /* 单个不可读跳过 */ }
  }
  return Array.from(bases.entries()).map(([base, v]) => ({ base, ...v }))
}

/**
 * 保留最新 keep 份、总占用不超 maxMb（0=不限），超出部分从最旧删除。返回逐条报告。
 * 2026-10-18 两处升级（体积线 task-20261018-004）：
 *  ① 排序判据从「文件名字典序」改为 zip 的 mtime —— 与 listLocalBackups 的 2026-09-25
 *    修正对齐（名字是代理值，手工改名/导入包会失序；mtime 才是真正的"最新"）；
 *  ② 新增体积线：份数达标但总占用超 maxMb 时，继续从最旧淘汰到线下。
 * 兼容：keep 语义不变；原「返回删除份数」的老调用（e2e）改用 report.removed.length。
 */
export function rotateLocal(dir: string, keep: number, maxMb = 0, dryRun = false): RotateReport {
  const empty: RotateReport = { removed: [], freedBytes: 0, kept: 0, unrecognized: [], reasons: [] }
  if (!fs.existsSync(dir)) return empty
  const groups = collectGroups(dir)
  const unrecognized = fs.readdirSync(dir).filter((f) => f.endsWith('.zip') && !/^fangcun-data-\d{8}-\d{6}\.zip$/.test(f))
  // 最旧在前（mtime 升序；mtime 异常的按 base 兜底排序，保证确定性）
  const sorted = [...groups].sort((a, b) => a.mtimeMs - b.mtimeMs || a.base.localeCompare(b.base))
  const report: RotateReport = { removed: [], freedBytes: 0, kept: sorted.length, unrecognized, reasons: [] }

  const groupFiles = (base: string) => ['.zip', '.zip.sha256', '.manifest.json'].map((ext) => path.join(dir, base + ext))

  for (const g of sorted) {
    const overCount = sorted.length - report.removed.length > keep
    const overSize = maxMb > 0 && (groups.reduce((s, x) => s + x.bytes, 0) - report.freedBytes) > maxMb * 1024 * 1024
    if (!overCount && !overSize) break
    const reason = overCount ? '份数超限' : '体积超限'
    if (!dryRun) {
      for (const p of groupFiles(g.base)) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p) } catch { /* 单个删除失败不中断 */ }
      }
    }
    report.removed.push({ base: g.base, bytes: g.bytes })
    report.reasons.push({ base: g.base, reason })
    report.freedBytes += g.bytes
  }
  report.kept = sorted.length - report.removed.length
  return report
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
    // 同 listLocalBackups：按最后更新倒序（远端 mtime 可能缺，缺的排最后）
    .sort((a, b) =>
      (Date.parse(b.mtime || '') || 0) - (Date.parse(a.mtime || '') || 0) || b.name.localeCompare(a.name))
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
  /** zip 本体字节数（不是目录里所有文件之和 —— 导出只落这一个文件） */
  bytes: number
  /** 包内数据文件数（给人看的说明用，不是落盘文件数） */
  files: number
  errors: string[]
}

/**
 * 导出一份完整备份到指定目录（不触发远端上传、不影响自动备份的轮换目录）。
 * 典型用途：导出到网盘同步文件夹（OneDrive / 坚果云 / 群晖 Drive 等），由客户端负责上传。
 *
 * 2026-09-26（用户第 1 条）：**只落一个 zip**。此前这里连同 sidecar / manifest / README /
 * 恢复脚本一共写 4 个文件，用户原话「导出又是导出四个文件，我只认识压缩包…只应该存在一样东西」。
 * 完整性不靠外层附件撑着：zip 内含逐文件 sha256 的 manifest，导出前 verifyZip 自校验、
 * 落盘后回读比对 sha256 —— 去掉的那几个只是给人看的说明，不是校验依据。
 */
export function exportSnapshotTo(destDir: string): ExportResult {
  const errors: string[] = []
  const result: ExportResult = {
    ok: false, dir: destDir,
    zipPath: null,
    bytes: 0, files: 0, errors,
  }

  if (!destDir || !destDir.trim()) {
    errors.push('未指定导出目录')
    return result
  }

  let snapshot
  try {
    snapshot = createSnapshot(scopeSources())
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

    // 回读校验：确认磁盘上的内容与内存一致
    const readBack = fs.readFileSync(zipPath)
    if (sha256OfBuffer(readBack) !== snapshot.zipSha256) {
      try { fs.rmSync(zipPath, { force: true }) } catch {}
      errors.push('导出后回读校验失败，文件可能写入不完整')
      return result
    }

    result.zipPath = zipPath
    result.bytes = readBack.length
    result.files = snapshot.manifest.totalFiles
    result.ok = errors.length === 0

    appendBackupLog(
      `EXPORT dir=${destDir} name=${zipName} files=${result.files} bytes=${result.bytes}`
    )
  } catch (e) {
    errors.push(`导出失败：${(e as Error).message}`)
  }

  return result
}

/**
 * 导出**已有的**某个备份包到指定目录（2026-09-25 第 10 条：只导指定备份、默认最新）。
 *
 * 与 `exportSnapshotTo` 的区别：那个是「现在重新打一份」（所以永远是全量、文件名是此刻的时间戳），
 * 这个是「把已经存在的那一份搬出去」—— 用户抱怨的正是「导出只能全量（91 文件/1097KB）」，
 * 而他真正想做的往往是把某一次备份复制到网盘。
 *
 * 安全：只允许导出**本地备份目录内**的包（否则这个方法就成了任意文件读取/外带通道）。
 * 与全量导出同一把尺子：导出前 `verifyZip` 自校验，落盘后回读校验 sha256。
 * 同样只落**一个 zip**（2026-09-26 用户第 1 条，理由见 exportSnapshotTo）。
 */
export function exportExistingPackageTo(
  destDir: string,
  packagePath: string,
): ExportResult {
  const errors: string[] = []
  const result: ExportResult = {
    ok: false, dir: destDir,
    zipPath: null,
    bytes: 0, files: 0, errors,
  }

  if (!destDir || !destDir.trim()) { errors.push('未指定导出目录'); return result }
  if (!packagePath || !packagePath.trim()) { errors.push('未指定要导出的备份包'); return result }

  let src = ''
  try { src = path.resolve(packagePath) } catch { errors.push('备份包路径不合法'); return result }

  const localDir = path.resolve(getLocalBackupDir())
  const rel = path.relative(localDir, src)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    errors.push('只能导出本地备份目录内的备份包')
    return result
  }
  if (!fs.existsSync(src)) {
    errors.push('备份包不存在（可能已被轮换清理，去备份列表刷新看看）')
    return result
  }

  let buf: Buffer
  try {
    buf = fs.readFileSync(src)
  } catch (e) {
    errors.push(`读取备份包失败：${(e as Error).message}`)
    return result
  }

  const verify = verifyZip(buf)
  if (!verify.ok) {
    errors.push(`备份包自校验失败，已中止：${verify.errors.slice(0, 3).join('；')}`)
    return result
  }

  const name = path.basename(src)
  const sha = sha256OfBuffer(buf)

  try {
    fs.mkdirSync(destDir, { recursive: true })

    const zipPath = path.join(destDir, name)
    fs.writeFileSync(zipPath, buf)

    const readBack = fs.readFileSync(zipPath)
    if (sha256OfBuffer(readBack) !== sha) {
      try { fs.rmSync(zipPath, { force: true }) } catch { /* ignore */ }
      errors.push('导出后回读校验失败，文件可能写入不完整')
      return result
    }

    result.zipPath = zipPath
    result.bytes = readBack.length
    result.files = (verify.manifest && verify.manifest.totalFiles) || verify.entryCount
    result.ok = errors.length === 0

    appendBackupLog(
      `EXPORT-EXISTING src=${name} dir=${destDir} files=${result.files} bytes=${result.bytes}`
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

/**
 * 备份体积报告（2026-10-11 用户第 2 条）。
 *
 * 用户问「包怎么这么大？」，方寸此前**答不上来** —— 界面上只有一个 62.6MB 的结果，看不到构成。
 * 这里把"备份范围里到底有什么、谁最占地方、按当前瘦身设置会跳过什么"摊开，
 * 让"为什么大"变成可判断的事实，而不是让用户猜。
 *
 * 复用 `planSnapshot` —— 所以**它说会跳过什么，备份时就真跳过什么**（同一套判据）。
 */
export interface SizeReport {
  ok: boolean
  root: string
  /** 备份范围内（含会被瘦身跳过的）文件数与总字节 */
  files: number
  totalBytes: number
  /** 按当前瘦身设置**实际会入包**的字节数 */
  keptBytes: number
  omittedBytes: number
  omitted: OmittedEntry[]
  /** 按顶层路径归类（task-data / docs / policies / registry.yaml …） */
  byTop: Array<{ name: string; bytes: number; files: number }>
  /** 执行日志附件目录专账（体积黑洞通常在这里） */
  logAttachments: { bytes: number; files: number }
  /** 最大的若干个文件 */
  largest: Array<{ path: string; bytes: number }>
  errors: string[]
}

export function sizeReport(): SizeReport {
  const errors: string[] = []
  const root = resolveRoot()
  const empty: SizeReport = {
    ok: false, root, files: 0, totalBytes: 0, keptBytes: 0, omittedBytes: 0,
    omitted: [], byTop: [], logAttachments: { bytes: 0, files: 0 }, largest: [], errors,
  }
  let plan
  try {
    plan = planSnapshot(scopeSources())
  } catch (e) {
    errors.push(`扫描失败：${(e as Error).message}`)
    return empty
  }

  type Row = { rel: string; bytes: number }
  const rows: Row[] = []
  for (const f of plan.files) {
    try { rows.push({ rel: f.rel, bytes: fs.statSync(f.abs).size }) } catch { /* 读不到就跳过 */ }
  }
  for (const o of plan.omitted) rows.push({ rel: o.path, bytes: o.size || 0 })

  const totalBytes = rows.reduce((n, r) => n + r.bytes, 0)
  const omittedBytes = plan.omitted.reduce((n, o) => n + (o.size || 0), 0)

  const topMap = new Map<string, { bytes: number; files: number }>()
  for (const r of rows) {
    const top = r.rel.split('/')[0] || '(根)'
    const cur = topMap.get(top) || { bytes: 0, files: 0 }
    cur.bytes += r.bytes
    cur.files += 1
    topMap.set(top, cur)
  }

  const la = { bytes: 0, files: 0 }
  for (const r of rows) {
    if (r.rel === LOG_ATTACHMENTS_REL || r.rel.startsWith(LOG_ATTACHMENTS_REL + '/')) {
      la.bytes += r.bytes
      la.files += 1
    }
  }

  return {
    ok: true,
    root,
    files: rows.length,
    totalBytes,
    keptBytes: totalBytes - omittedBytes,
    omittedBytes,
    omitted: plan.omitted,
    byTop: Array.from(topMap.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.bytes - a.bytes),
    logAttachments: la,
    largest: rows.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 8)
      .map(r => ({ path: r.rel, bytes: r.bytes })),
    errors,
  }
}

export { extractZipTo, extractFileFromZip, verifyZip, WebdavClient }
export type { BackupManifest }
