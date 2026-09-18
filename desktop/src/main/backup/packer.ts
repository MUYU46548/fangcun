/**
 * 快照打包器 — 零依赖 ZIP 实现
 *
 * 为什么不用 PowerShell Compress-Archive：
 *  - 中文路径 / 空格路径需要多层 shell 转义，极易被注入或损坏
 *  - 无法流式产出 sha256 清单
 *  - 2GB 文件数上限与老旧 Win 版本行为不一致
 * 这里手写 ZIP 结构（local header + central directory + EOCD）+ zlib deflateRaw，
 * 行为完全可控，且跨平台。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import * as crypto from 'crypto'
import { isExcluded, isSecretLike } from './rules'

// ── CRC32 ────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f)
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f)
  return { time, date }
}

interface ZipEntry {
  nameBuf: Buffer
  crc: number
  compSize: number
  rawSize: number
  offset: number
  time: number
  date: number
  data: Buffer
  method: number
}

/** 内存中构建 zip。数据量级为 markdown 文本，全内存可接受。 */
class ZipWriter {
  private chunks: Buffer[] = []
  private entries: ZipEntry[] = []
  private offset = 0

  private push(b: Buffer): void {
    this.chunks.push(b)
    this.offset += b.length
  }

  addFile(name: string, content: Buffer, mtime: Date, compress = true): void {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf-8')
    const raw = content
    let data = raw
    let method = 0
    if (compress && raw.length > 0) {
      const deflated = zlib.deflateRawSync(raw, { level: 6 })
      // 压缩没收益就用 store，避免小文件反而变大
      if (deflated.length < raw.length) {
        data = deflated
        method = 8
      }
    }
    const { time, date } = dosDateTime(mtime)
    const crc = crc32(raw)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(0x0800, 6) // UTF-8 flag
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(nameBuf.length, 26)
    header.writeUInt16LE(0, 28)

    const entryOffset = this.offset
    this.push(header)
    this.push(nameBuf)
    this.push(data)

    this.entries.push({
      nameBuf, crc, compSize: data.length, rawSize: raw.length,
      offset: entryOffset, time, date, data, method,
    })
  }

  finish(): Buffer {
    const cdStart = this.offset
    for (const e of this.entries) {
      const h = Buffer.alloc(46)
      h.writeUInt32LE(0x02014b50, 0)
      h.writeUInt16LE(20, 4) // version made by
      h.writeUInt16LE(20, 6) // version needed
      h.writeUInt16LE(0x0800, 8)
      h.writeUInt16LE(e.method, 10)
      h.writeUInt16LE(e.time, 12)
      h.writeUInt16LE(e.date, 14)
      h.writeUInt32LE(e.crc, 16)
      h.writeUInt32LE(e.compSize, 20)
      h.writeUInt32LE(e.rawSize, 24)
      h.writeUInt16LE(e.nameBuf.length, 28)
      h.writeUInt16LE(0, 30) // extra len
      h.writeUInt16LE(0, 32) // comment len
      h.writeUInt16LE(0, 34) // disk number
      h.writeUInt16LE(0, 36) // internal attrs
      h.writeUInt32LE(0, 38) // external attrs
      h.writeUInt32LE(e.offset, 42)
      this.push(h)
      this.push(e.nameBuf)
    }
    const cdSize = this.offset - cdStart

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(this.entries.length, 8)
    eocd.writeUInt16LE(this.entries.length, 10)
    eocd.writeUInt32LE(cdSize, 12)
    eocd.writeUInt32LE(cdStart, 16)
    eocd.writeUInt16LE(0, 20)
    this.push(eocd)

    return Buffer.concat(this.chunks)
  }
}

// ── manifest ─────────────────────────────────────────────────────────────

export interface ManifestEntry {
  path: string
  size: number
  sha256: string
  mtime: string
}

export interface BackupManifest {
  schemaVersion: number
  kind: 'fangcun-data-backup'
  createdAt: string
  hostname: string
  appVersion: string
  dataDirLabel: string
  totalFiles: number
  totalBytes: number
  files: ManifestEntry[]
  /** 审计：本次被排除的敏感文件（只记相对路径，不含内容） */
  excludedSecrets: string[]
}

export interface SnapshotResult {
  zipBuffer: Buffer
  zipSha256: string
  manifest: BackupManifest
  manifestBuffer: Buffer
}

export interface SnapshotSources {
  /** 数据根目录（桌面版为 userData；CLI 为仓库根） */
  rootDir: string
  /** 相对 rootDir 的待备份路径，文件或目录 */
  includes: string[]
  appVersion?: string
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 递归收集文件，返回 [相对路径, 绝对路径] */
function collect(rootDir: string, relPath: string, out: Array<{ rel: string; abs: string }>, excluded: string[]): void {
  const abs = path.join(rootDir, relPath)
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    return // 源不存在就跳过，不算错误（docs/ 可能尚未创建）
  }

  if (st.isFile()) {
    const rel = relPath.replace(/\\/g, '/')
    if (isExcluded(rel)) {
      if (isSecretLike(rel)) excluded.push(rel)
      return
    }
    out.push({ rel, abs })
    return
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const childRel = `${relPath}/${e.name}`
    if (isExcluded(childRel)) {
      // 只把「密钥类」排除项记账进 manifest，缓存/临时目录不制造噪音
      if (isSecretLike(childRel)) excluded.push(childRel.replace(/\\/g, '/'))
      continue
    }
    if (e.isDirectory()) {
      collect(rootDir, childRel, out, excluded)
    } else if (e.isFile()) {
      out.push({ rel: childRel.replace(/\\/g, '/'), abs: path.join(abs, e.name) })
    }
  }
}

/**
 * 生成快照：收集 → 逐文件 sha256 → 打包 zip → 附带 manifest.json。
 * 全程只读，不修改任何源文件。
 */
export function createSnapshot(sources: SnapshotSources): SnapshotResult {
  const { rootDir, includes } = sources
  if (!fs.existsSync(rootDir)) {
    throw new Error(`数据根目录不存在：${rootDir}`)
  }

  const collected: Array<{ rel: string; abs: string }> = []
  const excluded: string[] = []
  for (const inc of includes) {
    collect(rootDir, inc, collected, excluded)
  }

  // 去重（includes 可能重叠）
  const seen = new Set<string>()
  const unique = collected.filter(c => (seen.has(c.rel) ? false : (seen.add(c.rel), true)))
  unique.sort((a, b) => a.rel.localeCompare(b.rel))

  // 审计：数据根顶层的敏感文件（密钥类）即便不在 includes 内，也要显式记账，
  // 让用户能从 manifest 一眼看到"哪些机密存在于本地但被有意排除在备份之外"。
  try {
    for (const name of fs.readdirSync(rootDir)) {
      if (isSecretLike(name) && !unique.some(u => u.rel === name)) {
        excluded.push(name)
      }
    }
  } catch { /* 根目录不可读不阻断备份 */ }

  const zip = new ZipWriter()
  const manifestFiles: ManifestEntry[] = []
  let totalBytes = 0

  for (const item of unique) {
    let buf: Buffer
    let st: fs.Stats
    try {
      buf = fs.readFileSync(item.abs)
      st = fs.statSync(item.abs)
    } catch (e) {
      throw new Error(`读取失败 ${item.rel}：${(e as Error).message}`)
    }
    const isTextish = /\.(md|markdown|ya?ml|json|txt|csv|log|html?|css|js|ts)$/i.test(item.rel)
    zip.addFile(item.rel, buf, st.mtime, isTextish)
    manifestFiles.push({
      path: item.rel,
      size: buf.length,
      sha256: sha256(buf),
      mtime: st.mtime.toISOString(),
    })
    totalBytes += buf.length
  }

  const manifest: BackupManifest = {
    schemaVersion: 1,
    kind: 'fangcun-data-backup',
    createdAt: new Date().toISOString(),
    hostname: require('os').hostname(),
    appVersion: sources.appVersion || '0.2.1',
    dataDirLabel: path.basename(rootDir) || 'data',
    totalFiles: manifestFiles.length,
    totalBytes,
    files: manifestFiles,
    excludedSecrets: Array.from(new Set(excluded)).sort(),
  }

  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8')
  zip.addFile('manifest.json', manifestBuffer, new Date(), true)

  const zipBuffer = zip.finish()
  return { zipBuffer, zipSha256: sha256(zipBuffer), manifest, manifestBuffer }
}

// ── 校验 ─────────────────────────────────────────────────────────────────

export interface VerifyResult {
  ok: boolean
  errors: string[]
  manifest: BackupManifest | null
  entryCount: number
}

/**
 * 读回 zip 逐项校验：central directory 可解析 + 每条记录的 crc 与实际解压结果一致 + manifest 自洽。
 * 这是"备份是不是真的能恢复"的第一道证据，不通过就不许上传。
 */
export function verifyZip(zipBuffer: Buffer): VerifyResult {
  const errors: string[] = []
  let manifest: BackupManifest | null = null
  let entryCount = 0

  try {
    const entries = readCentralDirectory(zipBuffer)
    entryCount = entries.length
    if (entries.length === 0) errors.push('zip 内没有任何条目')

    for (const e of entries) {
      // local header 与 central directory 必须完全一致。
      // 只信 CD 会让"改 local header 骗过部分解压器"的篡改静默通过。
      const lh = readLocalHeader(zipBuffer, e.localOffset)
      if (!lh) {
        errors.push(`local header 无法解析：${e.name}`)
        continue
      }
      if (lh.name !== e.name) errors.push(`local/CD 文件名不一致：${e.name} ≠ ${lh.name}`)
      if (lh.method !== e.method) errors.push(`local/CD 压缩算法不一致：${e.name}`)
      if (lh.flags !== e.flags) errors.push(`local/CD 标志位不一致：${e.name}`)
      if (lh.time !== e.time || lh.date !== e.date) errors.push(`local/CD 时间戳不一致：${e.name}`)
      if (!lh.hasDataDescriptor) {
        // 设置 data descriptor 标志时，local header 的 crc/size 合法地为 0，不参与比对
        if (lh.crc !== e.crc) errors.push(`local/CD CRC 不一致：${e.name}`)
        if (lh.compSize !== e.compSize) errors.push(`local/CD 压缩尺寸不一致：${e.name}`)
        if (lh.rawSize !== e.rawSize) errors.push(`local/CD 原始尺寸不一致：${e.name}`)
      }

      const raw = extractEntry(zipBuffer, e)
      if (!raw) {
        errors.push(`条目无法解压：${e.name}`)
        continue
      }
      if (crc32(raw) !== e.crc) {
        errors.push(`CRC 校验失败：${e.name}`)
      }
      if (e.name === 'manifest.json') {
        try {
          manifest = JSON.parse(raw.toString('utf-8'))
        } catch {
          errors.push('manifest.json 不是合法 JSON')
        }
      }
    }

    if (!manifest) {
      errors.push('缺少 manifest.json')
    } else {
      const inZip = new Set(entries.map(e => e.name))
      for (const f of manifest.files) {
        if (!inZip.has(f.path)) errors.push(`manifest 列出的文件缺失：${f.path}`)
      }
      if (manifest.totalFiles !== manifest.files.length) {
        errors.push(`manifest totalFiles(${manifest.totalFiles}) 与实际(${manifest.files.length}) 不一致`)
      }
      // 抽样复核 sha256（全量复核在大包上过慢，抽首尾各 5 个）
      const sample = [...manifest.files.slice(0, 5), ...manifest.files.slice(-5)]
      for (const f of sample) {
        const e = entries.find(x => x.name === f.path)
        if (!e) continue
        const raw = extractEntry(zipBuffer, e)
        if (raw && sha256(raw) !== f.sha256) {
          errors.push(`sha256 不匹配：${f.path}`)
        }
      }
    }
  } catch (err) {
    errors.push(`zip 结构解析失败：${(err as Error).message}`)
  }

  return { ok: errors.length === 0, errors, manifest, entryCount }
}

interface CdEntry {
  name: string
  flags: number
  method: number
  time: number
  date: number
  crc: number
  compSize: number
  rawSize: number
  localOffset: number
}

interface LocalHeader {
  name: string
  flags: number
  method: number
  time: number
  date: number
  crc: number
  compSize: number
  rawSize: number
  hasDataDescriptor: boolean
}

function readLocalHeader(buf: Buffer, offset: number): LocalHeader | null {
  if (offset < 0 || offset + 30 > buf.length) return null
  if (buf.readUInt32LE(offset) !== 0x04034b50) return null
  const flags = buf.readUInt16LE(offset + 6)
  const method = buf.readUInt16LE(offset + 8)
  const time = buf.readUInt16LE(offset + 10)
  const date = buf.readUInt16LE(offset + 12)
  const crc = buf.readUInt32LE(offset + 14)
  const compSize = buf.readUInt32LE(offset + 18)
  const rawSize = buf.readUInt32LE(offset + 22)
  const nameLen = buf.readUInt16LE(offset + 26)
  if (offset + 30 + nameLen > buf.length) return null
  const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf-8')
  return { name, flags, method, time, date, crc, compSize, rawSize, hasDataDescriptor: (flags & 0x0008) !== 0 }
}

function readCentralDirectory(buf: Buffer): CdEntry[] {
  // 从尾部找 EOCD（可能有 comment，最多回退 64KB）
  let eocd = -1
  const start = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('未找到 EOCD 记录')

  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: CdEntry[] = []

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`central directory 第 ${i} 条签名异常`)
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const time = buf.readUInt16LE(p + 12)
    const date = buf.readUInt16LE(p + 14)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const rawSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf-8')
    out.push({ name, flags, method, time, date, crc, compSize, rawSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function extractEntry(buf: Buffer, e: CdEntry): Buffer | null {
  const p = e.localOffset
  if (buf.readUInt32LE(p) !== 0x04034b50) return null
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const dataStart = p + 30 + nameLen + extraLen
  const data = buf.subarray(dataStart, dataStart + e.compSize)
  if (e.method === 0) return Buffer.from(data)
  if (e.method === 8) {
    try {
      return zlib.inflateRawSync(data)
    } catch {
      return null
    }
  }
  return null
}

/** 从 zip 取指定文件内容（恢复流程用） */
export function extractFileFromZip(zipBuffer: Buffer, name: string): Buffer | null {
  const entries = readCentralDirectory(zipBuffer)
  const e = entries.find(x => x.name === name)
  if (!e) return null
  return extractEntry(zipBuffer, e)
}

/** 解压全部条目到目录（恢复流程用）。返回写出的文件数。 */
export function extractZipTo(zipBuffer: Buffer, destDir: string): number {
  const entries = readCentralDirectory(zipBuffer)
  let n = 0
  for (const e of entries) {
    if (e.name === 'manifest.json') continue
    const rel = e.name.replace(/\\/g, '/')
    // 防目录穿越：拒绝绝对路径与 ..
    if (rel.startsWith('/') || rel.split('/').some(s => s === '..')) {
      throw new Error(`备份条目路径非法：${e.name}`)
    }
    const raw = extractEntry(zipBuffer, e)
    if (!raw) throw new Error(`条目解压失败：${e.name}`)
    if (crc32(raw) !== e.crc) throw new Error(`条目 CRC 校验失败：${e.name}`)
    const abs = path.join(destDir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, raw)
    n++
  }
  return n
}

export function sha256OfBuffer(buf: Buffer): string {
  return sha256(buf)
}
