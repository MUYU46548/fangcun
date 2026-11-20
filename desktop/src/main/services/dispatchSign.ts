/**
 * 派单签名（2026-11-20 · 父卡「派单防滥用」）
 *
 * 问题：任何能写 `<数据根>/.dispatch-dsh/` 的进程/agent 都能让 DSH 开一个花钱会话 ——
 * 插件每 8 秒自动消费，文件就是全部凭证。
 *
 * 口径：**用户手势 = 方寸 GUI 的按钮**。GUI 落派单时用一把只存在 userData 的密钥签名；
 * 插件只认签名有效的派单。agent 直接往数据根写文件 → 没有签名 → 插件拒收并记 red 审计。
 *
 * ⚠ 边界（别把它吹成密码学铁墙）：
 *   · 密钥在 `%APPDATA%/方寸/dispatch-secret`，不在数据根 —— 只写数据根的 agent 伪造不了；
 *   · 能读整个用户目录的 agent 仍可能拿到密钥；真正的强边界要 DSH 侧再点一次确认（下一刀）。
 *   · 签名只证明"这份派单是方寸主进程写的"，不证明"用户真的想开"——所以插件侧还要
 *     冷却/日上限/单发，三层一起才是有用的闸。
 *
 * 本模块不 import electron：由主进程启动时 `configureDispatchSecretDir(app.getPath('userData'))`，
 * 测试用 `FC_DISPATCH_SECRET_PATH` 指到临时文件。这样 `contextPack` 的纯 e2e 不需要起 Electron。
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

let secretDir = ''

/** 主进程启动时把 `app.getPath('userData')` 配进来（不 import electron，纯测试也能跑） */
export function configureDispatchSecretDir(dir: string): void {
  secretDir = String(dir || '').trim()
}

/**
 * 密钥落点。优先级：
 *  ① `FC_DISPATCH_SECRET_PATH`（测试/便携部署显式指定）
 *  ② 主进程配置的 userData 目录
 *  ③ `%APPDATA%/方寸` / `Fangcun` / `fangcun-desktop` 下已存在的那份
 *  ④ 默认 `%APPDATA%/方寸/dispatch-secret`（首次创建）
 *
 * 插件侧按同一组 APPDATA 目录找；生产安装版就是 `%APPDATA%/方寸`。
 */
export function resolveDispatchSecretPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.FC_DISPATCH_SECRET_PATH || '').trim()
  if (explicit) return explicit
  if (secretDir) return path.join(secretDir, 'dispatch-secret')
  const appData = String(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')).trim()
  for (const name of ['方寸', 'Fangcun', 'fangcun-desktop']) {
    const p = path.join(appData, name, 'dispatch-secret')
    if (fs.existsSync(p)) return p
  }
  return path.join(appData, '方寸', 'dispatch-secret')
}

/** 读密钥；没有就生成一份（32 字节 hex，权限尽量 0o600）。失败抛错，调用方不许写无签名派单。 */
export function ensureDispatchSecret(env: NodeJS.ProcessEnv = process.env): string {
  const p = resolveDispatchSecretPath(env)
  try {
    const raw = fs.readFileSync(p, 'utf-8').trim()
    if (raw) return raw
  } catch { /* 不存在/读不到 → 下面创建 */ }
  const secret = crypto.randomBytes(32).toString('hex')
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, secret + '\n', { encoding: 'utf-8', mode: 0o600 })
  } catch (e: any) {
    throw new Error('派单签名密钥写不进去：' + String(e?.message || e))
  }
  return secret
}

/** 一次性 nonce（16 字节 hex）：让同一秒内连续两份派单也不同 */
export function newDispatchNonce(): string {
  return crypto.randomBytes(16).toString('hex')
}

/**
 * 签名覆盖的规范串 —— 与 dsh-fangcun `lib/dispatch.js#canonicalDispatch` **必须逐字一致**。
 * 用 `\n` 分隔；`body` 放最后，里面有什么都不影响字段边界。
 */
export function canonicalDispatch(p: {
  source?: string
  project?: string
  at?: string
  kind?: string
  nonce?: string
  chars?: number
  missing?: string[]
  body?: string
}): string {
  return [
    String(p.source || ''),
    String(p.project || ''),
    String(p.at || ''),
    String(p.kind || ''),
    String(p.nonce || ''),
    String(Number(p.chars) || 0),
    (Array.isArray(p.missing) ? p.missing : []).join('|'),
    String(p.body || ''),
  ].join('\n')
}

export function signDispatch(secret: string, payload: Parameters<typeof canonicalDispatch>[0]): string {
  return crypto.createHmac('sha256', String(secret || '')).update(canonicalDispatch(payload), 'utf-8').digest('hex')
}

export function verifyDispatch(secret: string, payload: Parameters<typeof canonicalDispatch>[0], sig: string): boolean {
  const want = signDispatch(secret, payload)
  const got = String(sig || '').trim().toLowerCase()
  if (!secret || !/^[0-9a-f]{64}$/.test(got) || want.length !== got.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(got, 'hex'))
  } catch {
    return false
  }
}
