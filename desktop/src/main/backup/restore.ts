/**
 * 恢复流程 — 可验证、可回滚
 *
 * 铁律：
 *  1. 解压前必须通过 完整性校验（sha256 sidecar + zip 结构 + 逐条 CRC）
 *  2. 替换前先把现有数据整体改名为 snapshot，替换失败原样回滚
 *  3. 校验不通过绝不动现有数据
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as data from '../data'
import { verifyZip, extractZipTo, sha256OfBuffer, BackupManifest } from './packer'
import { getLocalBackupDir, listLocalBackups } from './index'
import { downloadRemote, makeClient } from './index'

export interface RestoreResult {
  ok: boolean
  restoredFiles: number
  dataDir: string
  snapshotDir: string | null
  manifest: BackupManifest | null
  errors: string[]
  warnings: string[]
}

/** 恢复目标：数据根下允许被替换的相对路径 */
const RESTORE_TARGETS = ['task-data', 'registry.yaml', 'docs']

/**
 * 从本地 zip 恢复。
 * `fromRemote` 为远端文件名时，先下载再恢复。
 */
export async function restoreFrom(
  source: { kind: 'local'; path: string } | { kind: 'remote'; name: string }
): Promise<RestoreResult> {
  const errors: string[] = []
  const warnings: string[] = []
  const dataDir = data.getDataDir()
  const result: RestoreResult = {
    ok: false, restoredFiles: 0, dataDir, snapshotDir: null, manifest: null, errors, warnings,
  }

  // ── 1. 取包 ──────────────────────────────────────────────────────────
  let zipPath = ''
  if (source.kind === 'local') {
    zipPath = source.path
    if (!fs.existsSync(zipPath)) {
      errors.push(`备份文件不存在：${zipPath}`)
      return result
    }
  } else {
    try {
      const tmp = path.join(os.tmpdir(), `fangcun-restore-dl-${Date.now()}`)
      zipPath = await downloadRemote(source.name, tmp)
    } catch (e) {
      errors.push(`远端下载失败：${(e as Error).message}`)
      return result
    }
  }

  // ── 2. 校验（不通过绝不继续） ────────────────────────────────────────
  let zipBuffer: Buffer
  try {
    zipBuffer = fs.readFileSync(zipPath)
  } catch (e) {
    errors.push(`读取备份失败：${(e as Error).message}`)
    return result
  }

  const sidecar = `${zipPath}.sha256`
  if (fs.existsSync(sidecar)) {
    const expected = fs.readFileSync(sidecar, 'utf-8').trim()
    const actual = sha256OfBuffer(zipBuffer)
    if (expected && expected !== actual) {
      errors.push(`归档 sha256 校验失败（期望 ${expected.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…），已拒绝恢复`)
      return result
    }
  } else {
    warnings.push('缺少 .sha256 校验文件，已退化为结构校验')
  }

  const verify = verifyZip(zipBuffer)
  if (!verify.ok) {
    errors.push(`备份包校验失败，已拒绝恢复：${verify.errors.slice(0, 3).join('；')}`)
    return result
  }
  result.manifest = verify.manifest

  // ── 3. 解压到临时目录 ────────────────────────────────────────────────
  const stagingRoot = path.join(os.tmpdir(), `fangcun-restore-stage-${Date.now()}`)
  try {
    fs.mkdirSync(stagingRoot, { recursive: true })
    result.restoredFiles = extractZipTo(zipBuffer, stagingRoot)
  } catch (e) {
    errors.push(`解压失败：${(e as Error).message}`)
    try { fs.rmSync(stagingRoot, { recursive: true, force: true }) } catch {}
    return result
  }

  // 至少要有 task-data 才算有效备份
  if (!fs.existsSync(path.join(stagingRoot, 'task-data'))) {
    errors.push('备份包内没有 task-data 目录，不是有效的数据备份')
    try { fs.rmSync(stagingRoot, { recursive: true, force: true }) } catch {}
    return result
  }

  // ── 4. 快照现有数据（整体改名，失败可原样回滚） ──────────────────────
  const snapshotDir = path.join(dataDir, `_restore-snapshot-${Date.now()}`)
  const moved: Array<{ from: string; to: string }> = []
  try {
    fs.mkdirSync(snapshotDir, { recursive: true })
    for (const rel of RESTORE_TARGETS) {
      const src = path.join(dataDir, rel)
      if (fs.existsSync(src)) {
        const dst = path.join(snapshotDir, rel)
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.renameSync(src, dst)
        moved.push({ from: src, to: dst })
      }
    }
  } catch (e) {
    // 快照阶段失败：把已移动的还原回去
    for (const m of moved.reverse()) {
      try { fs.renameSync(m.to, m.from) } catch {}
    }
    errors.push(`快照现有数据失败，已中止：${(e as Error).message}`)
    try { fs.rmSync(stagingRoot, { recursive: true, force: true }) } catch {}
    return result
  }

  // ── 5. 落位 ──────────────────────────────────────────────────────────
  try {
    let placed = 0
    for (const rel of RESTORE_TARGETS) {
      const staged = path.join(stagingRoot, rel)
      if (!fs.existsSync(staged)) continue
      const dst = path.join(dataDir, rel)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.renameSync(staged, dst)
      placed++
    }
    if (placed === 0) throw new Error('没有任何数据被恢复')

    try { fs.rmSync(stagingRoot, { recursive: true, force: true }) } catch {}
    result.snapshotDir = snapshotDir
    result.ok = true
    return result
  } catch (e) {
    // ── 6. 回滚 ────────────────────────────────────────────────────────
    errors.push(`写入失败：${(e as Error).message}，正在回滚…`)
    for (const rel of RESTORE_TARGETS) {
      const dst = path.join(dataDir, rel)
      try {
        if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true })
      } catch {}
    }
    for (const m of moved) {
      try { fs.renameSync(m.to, m.from) } catch (err) {
        errors.push(`回滚失败：${m.from} —— ${(err as Error).message}`)
      }
    }
    result.snapshotDir = moved.length ? snapshotDir : null
    return result
  }
}

/** 列出可恢复的来源（本地 + 可选远端） */
export async function listRestoreSources(includeRemote = false): Promise<{
  local: Array<{ name: string; path: string; bytes: number; mtime: string }>
  remote: Array<{ name: string; bytes: number | null; mtime: string | null }>
  remoteError: string | null
}> {
  const local = listLocalBackups().map(b => ({ name: b.name, path: b.path, bytes: b.bytes, mtime: b.mtime }))
  let remote: Array<{ name: string; bytes: number | null; mtime: string | null }> = []
  let remoteError: string | null = null
  if (includeRemote) {
    try {
      const c = makeClient()
      const files = await c.list('')
      remote = files
        .filter(f => f.name.endsWith('.zip'))
        .map(f => ({ name: f.name, bytes: f.size, mtime: f.mtime }))
        .sort((a, b) => b.name.localeCompare(a.name))
    } catch (e) {
      remoteError = (e as Error).message
    }
  }
  return { local, remote, remoteError }
}

export { getLocalBackupDir }
