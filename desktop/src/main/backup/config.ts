/**
 * 备份配置 — 凭据安全存储
 *
 * 安全约定（红线）：
 *  1. WebDAV 密码只用 Electron safeStorage（Windows DPAPI / macOS Keychain）加密后落盘，
 *     配置文件中永远只有密文，绝无明文密码。
 *  2. 该配置文件不出现在任何备份包、日志、git 提交里。
 *  3. 密钥类源文件（llm-config.json 等）由 EXCLUDE_RULES 统一排除，绝不随备份上云。
 */
import * as fs from 'fs'
import * as path from 'path'
import { app, safeStorage } from 'electron'

export interface BackupRemote {
  url: string
  username: string
  /** safeStorage 密文的 base64；空表示未设置 */
  passwordEnc: string
  allowSelfSigned: boolean
}

export interface BackupConfig {
  enabled: boolean
  /** 自动备份间隔（小时），0 = 关闭自动 */
  intervalHours: number
  /** 应用启动后多久做首次自动备份（分钟） */
  firstDelayMinutes: number
  /** 本地保留份数 */
  localKeep: number
  /** 远端保留份数（0 = 不轮换远端） */
  remoteKeep: number
  /** 本地备份目录，空则用 <dataDir>/backups */
  localDir: string
  remote: BackupRemote
}

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: true,
  intervalHours: 6,
  firstDelayMinutes: 5,
  localKeep: 10,
  remoteKeep: 10,
  localDir: '',
  remote: {
    url: '',
    username: '',
    passwordEnc: '',
    allowSelfSigned: false,
  },
}

/**
 * 排除规则集中在 rules.ts（零依赖，可单独测试）。
 * 此处 re-export 以保持既有引用可用。
 */
export {
  SECRET_BASENAMES,
  SECRET_SUFFIXES,
  EXCLUDE_DIRS,
  EXCLUDE_SUFFIXES,
  isExcluded,
  isSecretLike,
} from './rules'

export function getBackupPaths() {
  const dir = app.getPath('userData')
  return {
    configPath: path.join(dir, 'backup-config.json'),
    statePath: path.join(dir, 'backup-state.json'),
    logPath: path.join(dir, 'backup.log'),
  }
}

let _config: BackupConfig | null = null

export function getBackupConfig(): BackupConfig {
  if (_config) return _config
  const { configPath } = getBackupPaths()
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      if (parsed && typeof parsed === 'object') {
        _config = {
          ...DEFAULT_BACKUP_CONFIG,
          ...parsed,
          remote: { ...DEFAULT_BACKUP_CONFIG.remote, ...(parsed.remote || {}) },
        }
        return _config
      }
    } catch (e) {
      const bad = `${configPath}.bad-${Date.now()}`
      try { fs.renameSync(configPath, bad) } catch {}
      console.warn(`[backup] 配置解析失败(${(e as Error).message})，已备份到 ${bad}`)
    }
  }
  _config = JSON.parse(JSON.stringify(DEFAULT_BACKUP_CONFIG))
  return _config
}

export function setBackupConfig(patch: Partial<BackupConfig> & { remote?: Partial<BackupRemote> & { password?: string } }): BackupConfig {
  const current = getBackupConfig()
  const next: BackupConfig = {
    ...current,
    ...patch,
    remote: { ...current.remote, ...(patch.remote || {}) } as BackupRemote,
  }

  // password 是明文入参，绝不落盘 —— 立即转密文
  const plainPassword = patch.remote?.password
  if (typeof plainPassword === 'string' && plainPassword !== '') {
    next.remote.passwordEnc = encryptSecret(plainPassword)
  }
  // 删除可能混入的明文字段，防止上游手滑
  delete (next.remote as any).password

  normalize(next)
  _config = next
  persist(next)
  return next
}

function normalize(cfg: BackupConfig): void {
  cfg.intervalHours = clampInt(cfg.intervalHours, 0, 24 * 7, DEFAULT_BACKUP_CONFIG.intervalHours)
  cfg.firstDelayMinutes = clampInt(cfg.firstDelayMinutes, 0, 24 * 60, DEFAULT_BACKUP_CONFIG.firstDelayMinutes)
  cfg.localKeep = clampInt(cfg.localKeep, 1, 200, DEFAULT_BACKUP_CONFIG.localKeep)
  cfg.remoteKeep = clampInt(cfg.remoteKeep, 0, 200, DEFAULT_BACKUP_CONFIG.remoteKeep)
  cfg.remote.url = String(cfg.remote.url || '').trim().replace(/\/+$/, '')
  cfg.remote.username = String(cfg.remote.username || '').trim()
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function persist(cfg: BackupConfig): void {
  const { configPath } = getBackupPaths()
  const tmp = `${configPath}.tmp`
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmp, configPath)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    throw new Error(`备份配置写入失败：${(e as Error).message}`)
  }
}

// ── 凭据加解密 ───────────────────────────────────────────────────────────

export function isSecretStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function encryptSecret(plain: string): string {
  if (!isSecretStorageAvailable()) {
    // 系统密钥库不可用：宁可不记住密码，也不明文落盘
    throw new Error('系统密钥库不可用，无法安全保存密码。密码将在本次会话内有效，重启后需重新输入。')
  }
  return safeStorage.encryptString(plain).toString('base64')
}

/** 取密码明文，仅用于构造请求头，绝不写日志/落盘/回传渲染层 */
export function decryptSecret(passwordEnc: string): string {
  if (!passwordEnc) return ''
  if (!isSecretStorageAvailable()) {
    throw new Error('系统密钥库不可用，无法解密已保存的 WebDAV 密码')
  }
  try {
    return safeStorage.decryptString(Buffer.from(passwordEnc, 'base64'))
  } catch {
    throw new Error('WebDAV 密码解密失败（可能换了机器或系统账户），请在设置中重新输入')
  }
}

export function hasRemotePassword(): boolean {
  return !!getBackupConfig().remote.passwordEnc
}

/** 出 IPC 的配置：密码字段一律替换为布尔标记 */
export function getBackupConfigForRenderer() {
  const cfg = getBackupConfig()
  const { passwordEnc, ...remoteSafe } = cfg.remote
  return {
    ...cfg,
    remote: {
      ...remoteSafe,
      hasPassword: !!passwordEnc,
      password: '',
    },
    secretStorageAvailable: isSecretStorageAvailable(),
  }
}

export function resetBackupConfig(): BackupConfig {
  _config = JSON.parse(JSON.stringify(DEFAULT_BACKUP_CONFIG))
  persist(_config)
  return _config
}

// ── 运行状态 ─────────────────────────────────────────────────────────────

export interface BackupState {
  lastRunAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  failStreak: number
  lastLocalPath: string | null
  lastRemotePath: string | null
  lastFiles: number
  lastBytes: number
  lastDurationMs: number
}

export const DEFAULT_BACKUP_STATE: BackupState = {
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastErrorAt: null,
  failStreak: 0,
  lastLocalPath: null,
  lastRemotePath: null,
  lastFiles: 0,
  lastBytes: 0,
  lastDurationMs: 0,
}

export function getBackupState(): BackupState {
  const { statePath } = getBackupPaths()
  if (!fs.existsSync(statePath)) return { ...DEFAULT_BACKUP_STATE }
  try {
    return { ...DEFAULT_BACKUP_STATE, ...JSON.parse(fs.readFileSync(statePath, 'utf-8')) }
  } catch {
    return { ...DEFAULT_BACKUP_STATE }
  }
}

export function saveBackupState(patch: Partial<BackupState>): BackupState {
  const next = { ...getBackupState(), ...patch }
  const { statePath } = getBackupPaths()
  try {
    const tmp = `${statePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmp, statePath)
  } catch (e) {
    console.warn(`[backup] 状态写入失败：${(e as Error).message}`)
  }
  return next
}

/** 追加一行审计日志。绝不写入密码/密钥。 */
export function appendBackupLog(line: string): void {
  const { logPath } = getBackupPaths()
  try {
    const stamp = new Date().toISOString()
    fs.appendFileSync(logPath, `[${stamp}] ${line}\n`, 'utf-8')
    // 日志超过 512KB 时截断保留后一半，避免无限增长
    const st = fs.statSync(logPath)
    if (st.size > 512 * 1024) {
      const content = fs.readFileSync(logPath, 'utf-8')
      fs.writeFileSync(logPath, content.slice(-256 * 1024), 'utf-8')
    }
  } catch {
    // 日志失败不能影响主流程
  }
}
