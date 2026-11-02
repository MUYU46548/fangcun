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
import { atomicWrite } from '../data'

export interface BackupRemote {
  url: string
  username: string
  /** safeStorage 密文的 base64；空表示未设置 */
  passwordEnc: string
  allowSelfSigned: boolean
}

/**
 * 备份瘦身（2026-10-11 用户第 2 条）。
 *
 * 用户报“包怎么还是这么大？62.6MB，网盘上传噩梦”——真凶是 `docs/执行日志/_attachments/`
 * 里一个 **57MB 的 stray 附件**（一份误挂到执行日志上的游戏 bundle），它每次都被原样打进包。
 *
 * 两个旋钮都在这里，**都不静默**：被跳过的文件会逐条记进 manifest（`omittedFiles`），
 * 设置页也会把当前体积构成摊开给用户看（`backup:sizeReport`）。
 */
export interface BackupSlimConfig {
  /** 排除 `docs/执行日志/_attachments/`（执行日志的附件目录 —— 图片/打包物，通常是体积黑洞） */
  excludeLogAttachments: boolean
  /** 跳过大于这个 MB 数的单个文件（0 = 不限）。默认 10：markdown 数据仓库里超过 10MB 的单文件
   *  基本只可能是误挂进来的产物，留着只会让每份备份都多驮一次。 */
  maxFileMB: number
}

export interface BackupConfig {
  enabled: boolean
  /** 自动备份间隔（小时），0 = 关闭自动 */
  intervalHours: number
  /** 应用启动后多久做首次自动备份（分钟） */
  firstDelayMinutes: number
  /** 本地保留份数 */
  localKeep: number
  /** 本地备份总占用上限（MB）。超过时从最旧开始淘汰，0 = 不限（2026-10-18 体积线，老配置无此键走默认） */
  maxLocalMb: number
  /** 远端保留份数（0 = 不轮换远端） */
  remoteKeep: number
  /** 本地备份目录，空则用 <dataDir>/backups */
  localDir: string
  remote: BackupRemote
  /** 瘦身旋钮（体积控制）。老配置里没有这个键 → 走默认值 */
  slim: BackupSlimConfig
  /** 备份加密（2026-10-31）：默认关。开了之后产出 .fcz（FCENC1 容器）。 */
  encrypt: BackupEncrypt
}

export interface BackupEncrypt {
  enabled: boolean
  /**
   * 是否用系统密钥库（safeStorage）记住口令。
   * ⚠ 记住 = 方寸自己能解开（自动备份才跑得起来），防的是"网盘/别人拿到文件"，
   *   **不防"这台机器已经被别人登录"** —— 这句必须原样告诉用户。
   */
  remember: boolean
  /** safeStorage 密文（base64）；空 = 没记住 */
  passwordEnc: string
}

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: true,
  intervalHours: 6,
  firstDelayMinutes: 5,
  // 2026-10-21 暮雨拍板：本地滚动保留 10 → 5（约 5×9.4MB≈47MB，一周回滚窗口）。
  // ⚠ 只对"没有配置文件 / 配置里没这个键"的新环境生效；已有配置里显式写着 10 的
  //    按项目铁律“显式值优先”不覆盖 —— 老用户的值要单独迁移（本机已随本轮改成 5）。
  localKeep: 5,
  maxLocalMb: 0,
  remoteKeep: 10,
  localDir: '',
  remote: {
    url: '',
    username: '',
    passwordEnc: '',
    allowSelfSigned: false,
  },
  // 默认就瘦身：>10MB 的单文件不进包（记进 manifest 的 omittedFiles，不静默）。
  // 附件目录**默认不排除** —— 那是用户自己的东西，去留应该由他在界面上看见体积后再决定。
  slim: { excludeLogAttachments: false, maxFileMB: 10 },
  // 默认不加密：加密会把"恢复"从"双击就行"变成"要记得口令"，不该替用户默认打开。
  encrypt: { enabled: false, remember: false, passwordEnc: '' },
}

/** 执行日志附件目录（相对数据根的路径前缀，用来做瘦身判定与体积报告） */
export const LOG_ATTACHMENTS_REL = 'docs/执行日志/_attachments'

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
          // 老配置里没有 slim 键 → 走默认（否则会把瘦身旋钮读成 undefined）
          slim: { ...DEFAULT_BACKUP_CONFIG.slim, ...(parsed.slim || {}) },
          encrypt: { ...DEFAULT_BACKUP_CONFIG.encrypt, ...(parsed.encrypt || {}) },
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

export function setBackupConfig(patch: Partial<BackupConfig> & { remote?: Partial<BackupRemote> & { password?: string }; encrypt?: Partial<BackupEncrypt> & { password?: string } }): BackupConfig {
  const current = getBackupConfig()
  const next: BackupConfig = {
    ...current,
    ...patch,
    remote: { ...current.remote, ...(patch.remote || {}) } as BackupRemote,
    // ⚠ slim 必须**嵌套合并**，不能靠上面的浅展开 —— 否则渲染层只传 `{maxFileMB}` 时
    //   `excludeLogAttachments` 会被整块覆盖成 undefined（"只改一项却把另一项清零"）。
    slim: { ...current.slim, ...(patch.slim || {}) } as BackupSlimConfig,
    // 加密同理：只传 `{enabled}` 时不能把 remember/passwordEnc 抹掉。
    encrypt: { ...current.encrypt, ...(patch.encrypt || {}) } as BackupEncrypt,
  }

  // password 是明文入参，绝不落盘 —— 立即转密文
  const plainPassword = patch.remote?.password
  if (typeof plainPassword === 'string' && plainPassword !== '') {
    next.remote.passwordEnc = encryptSecret(plainPassword)
  }
  // 删除可能混入的明文字段，防止上游手滑
  delete (next.remote as any).password

  // 备份加密口令：同样只在内存里过一手 → safeStorage 密文。空字符串 = 清除。
  const encPw = patch.encrypt?.password
  if (typeof encPw === 'string') {
    if (encPw === '') {
      next.encrypt.passwordEnc = ''
      next.encrypt.remember = false
    } else if (next.encrypt.remember) {
      next.encrypt.passwordEnc = encryptSecret(encPw)
    }
  }
  delete (next.encrypt as any).password

  normalize(next)
  _config = next
  persist(next)
  return next
}

function normalize(cfg: BackupConfig): void {
  cfg.intervalHours = clampInt(cfg.intervalHours, 0, 24 * 7, DEFAULT_BACKUP_CONFIG.intervalHours)
  cfg.firstDelayMinutes = clampInt(cfg.firstDelayMinutes, 0, 24 * 60, DEFAULT_BACKUP_CONFIG.firstDelayMinutes)
  cfg.localKeep = clampInt(cfg.localKeep, 1, 200, DEFAULT_BACKUP_CONFIG.localKeep)
  // 0 = 不限；上限 10240MB（10GB，同 slim 上限理由）。老配置无此键 → undefined → 回落默认 0
  cfg.maxLocalMb = clampInt((cfg as any).maxLocalMb, 0, 10240, DEFAULT_BACKUP_CONFIG.maxLocalMb)
  cfg.remoteKeep = clampInt(cfg.remoteKeep, 0, 200, DEFAULT_BACKUP_CONFIG.remoteKeep)
  cfg.remote.url = String(cfg.remote.url || '').trim().replace(/\/+$/, '')
  cfg.remote.username = String(cfg.remote.username || '').trim()
  if (!cfg.slim || typeof cfg.slim !== 'object') cfg.slim = { ...DEFAULT_BACKUP_CONFIG.slim }
  cfg.slim.excludeLogAttachments = !!cfg.slim.excludeLogAttachments
  // 0 = 不限；上限 10240MB（10GB —— 再大就不是"瘦身"了，是误操作）
  cfg.slim.maxFileMB = clampInt(cfg.slim.maxFileMB, 0, 10240, DEFAULT_BACKUP_CONFIG.slim.maxFileMB)
  if (!cfg.encrypt || typeof cfg.encrypt !== 'object') cfg.encrypt = { ...DEFAULT_BACKUP_CONFIG.encrypt }
  cfg.encrypt.enabled = !!cfg.encrypt.enabled
  cfg.encrypt.remember = !!cfg.encrypt.remember
  cfg.encrypt.passwordEnc = String(cfg.encrypt.passwordEnc || '')
  // 没记住口令 = 没有密文（防止"关掉记住"之后旧密文还留在配置里）
  if (!cfg.encrypt.remember) cfg.encrypt.passwordEnc = ''
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
    atomicWrite(configPath, JSON.stringify(cfg, null, 2), 0o600)
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

/** 备份加密口令（明文，只在内存里用；调用方用完别留）。没记住 / 解不开都返回空串。 */
export function getBackupEncryptPassword(): string {
  const cfg = getBackupConfig()
  if (!cfg.encrypt.passwordEnc) return ''
  try {
    return decryptSecret(cfg.encrypt.passwordEnc)
  } catch {
    return ''
  }
}

/** 出 IPC 的配置：密码字段一律替换为布尔标记 */
export function getBackupConfigForRenderer() {
  const cfg = getBackupConfig()
  const { passwordEnc, ...remoteSafe } = cfg.remote
  const { passwordEnc: encPw, ...encSafe } = cfg.encrypt
  return {
    ...cfg,
    remote: {
      ...remoteSafe,
      hasPassword: !!passwordEnc,
      password: '',
    },
    encrypt: {
      ...encSafe,
      hasPassword: !!encPw,
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
    atomicWrite(statePath, JSON.stringify(next, null, 2), 0o600)
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
