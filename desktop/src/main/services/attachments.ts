/**
 * 大附件清单与删除（2026-10-30，卡 task-20261018-004 的「附件治理」那一条）
 *
 * 背景（2026-10-11 用户第 2 条）：备份体积的黑洞是 `docs/执行日志/_attachments`
 * 里一份 57MB 的误挂 bundle。备份已经会给跳过项记账，但**用户没有地方看见**这些大文件。
 *
 * 这个服务的判据只有三条：
 *  ① **只扫附件目录**（数据目录下 `docs/执行日志/_attachments`）—— 不是全盘扫描器；
 *  ② **只列不删**，删除必须由用户点、且路径必须**真实落在附件目录内**（防 `../` 逃逸 / 符号链接）；
 *  ③ 数字说清口径：阈值默认 10MB，返回的是**单个文件**，不是目录合计。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getDataDir } from '../data'

export function attachmentsRoot(): string {
  return path.join(getDataDir(), 'docs', '执行日志', '_attachments')
}

export interface BigAttachment {
  /** 相对数据目录的路径（界面显示 / 回传删除都用它，避免暴露绝对路径） */
  rel: string
  /** 绝对路径（仅主进程内部用） */
  abs: string
  mb: number
  bytes: number
  mtime: string
}

export interface BigAttachmentReport {
  root: string
  minMb: number
  rows: BigAttachment[]
  totalMb: number
  scannedFiles: number
  scannedMb: number
  /** 扫描本身失败（目录读不了）—— 与"没有大文件"必须分开 */
  error?: string
}

function toMb(n: number): number {
  return Math.round((n / 1048576) * 100) / 100
}

/** 列出附件目录里超过阈值的单文件（只读，不删） */
export function listBigAttachments(minMb = 10): BigAttachmentReport {
  const root = attachmentsRoot()
  const limit = Number.isFinite(Number(minMb)) && Number(minMb) >= 0 ? Number(minMb) : 10
  const rows: BigAttachment[] = []
  let scannedFiles = 0
  let scannedBytes = 0
  const dataDir = getDataDir()

  if (!fs.existsSync(root)) {
    return { root, minMb: limit, rows, totalMb: 0, scannedFiles: 0, scannedMb: 0 }
  }
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return
    let ents: fs.Dirent[] = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p, depth + 1); continue }
      if (!e.isFile()) continue
      let st: fs.Stats
      try { st = fs.statSync(p) } catch { continue }
      scannedFiles++
      scannedBytes += st.size
      if (st.size >= limit * 1048576) {
        rows.push({
          rel: path.relative(dataDir, p).split(path.sep).join('/'),
          abs: p,
          mb: toMb(st.size),
          bytes: st.size,
          mtime: new Date(st.mtimeMs).toISOString(),
        })
      }
    }
  }
  walk(root, 0)
  rows.sort((a, b) => b.bytes - a.bytes)
  return {
    root,
    minMb: limit,
    rows,
    totalMb: toMb(rows.reduce((s, r) => s + r.bytes, 0)),
    scannedFiles,
    scannedMb: toMb(scannedBytes),
  }
}

/**
 * 把界面回传的路径解析成**附件目录内的真实文件**；任何逃逸都拒绝。
 * 用具名错误而不是返回 null：界面要把"为什么不行"说出来。
 */
export function resolveAttachmentPath(relOrAbs: string): { ok: boolean; abs?: string; error?: string } {
  const raw = String(relOrAbs || '').trim()
  if (!raw) return { ok: false, error: '没给路径' }
  const dataDir = getDataDir()
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(dataDir, raw)
  let realRoot = ''
  let realFile = ''
  try {
    realRoot = fs.realpathSync(attachmentsRoot())
    realFile = fs.realpathSync(abs)
  } catch {
    return { ok: false, error: '文件不存在（可能已经被删了）' }
  }
  const inRoot = realFile === realRoot || realFile.startsWith(realRoot + path.sep)
  if (!inRoot) return { ok: false, error: '只允许删除附件目录里的文件（这是防误删的硬闸）' }
  try {
    if (!fs.statSync(realFile).isFile()) return { ok: false, error: '只允许删除单个文件，不是目录' }
  } catch {
    return { ok: false, error: '文件读不到' }
  }
  return { ok: true, abs: realFile }
}

/** 删除一个附件（**用户点了才调用**；路径必须先过 resolveAttachmentPath） */
export function deleteAttachment(relOrAbs: string): { ok: boolean; error?: string; freedMb?: number } {
  const r = resolveAttachmentPath(relOrAbs)
  if (!r.ok || !r.abs) return { ok: false, error: r.error || '路径不合法' }
  let bytes = 0
  try { bytes = fs.statSync(r.abs).size } catch { /* 忽略：下面删除会再报 */ }
  try {
    fs.unlinkSync(r.abs)
    return { ok: true, freedMb: toMb(bytes) }
  } catch (e: any) {
    return { ok: false, error: '删除失败：' + (e?.message || e) }
  }
}
