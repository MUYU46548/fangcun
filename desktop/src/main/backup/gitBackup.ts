/**
 * Git 备份通道 · 执行器（2026-10-11，卡 `task-20261002-003`）
 *
 * 场景：**把备份 zip 推到一个 git 仓库**。
 * 注意方寸的数据本身**不入 git**（既定决策，`task-data/` 在 .gitignore 里）——
 * 所以这条通道是**单向的**（只推不拉），也就没有冲突处理、没有 merge，比司天那套简单得多。
 *
 * 安全设计全部落在 `gitBackupPure.ts` 里（纯函数，可被 node 直接断言）：
 * 令牌不进 argv、输出脱敏、缺凭证立刻失败、错误分类。**本文件只负责把那些约定拼起来跑**。
 *
 * 抄司天（`E:/CODE/CangKu/SiTian/src/main/gitSyncHandler.js`，794 行）的凭据做法，
 * 按"只推不拉"砍到最小。
 */
import { app, safeStorage } from 'electron'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import {
  buildCredentialArgs, buildGitEnv, sanitizeGitOutput, analyzeGitError,
  hostOfRemote, splitInlineCredential, GIT_TOKEN_ENV, GIT_USER_ENV,
} from './gitBackupPure'

export interface GitBackupConfig {
  /** 远程仓库地址（不含内嵌凭据 —— 保存时会自动抽出） */
  remote: string
  /** 分支，默认 main */
  branch: string
  authorName: string
  authorEmail: string
}

const CONFIG_NAME = 'git-backup.json'
const CRED_NAME = 'git-credentials.json'
/** 工作副本目录（userData 下）—— git 在这里跑，用户看不见也不该管 */
const WORK_DIR_NAME = 'git-backup-work'

function configPath(): string { return path.join(app.getPath('userData'), CONFIG_NAME) }
function credPath(): string { return path.join(app.getPath('userData'), CRED_NAME) }
function workDir(): string { return path.join(app.getPath('userData'), WORK_DIR_NAME) }

const DEFAULT_CONFIG: GitBackupConfig = { remote: '', branch: 'main', authorName: 'fangcun', authorEmail: 'fangcun@local' }

export function readGitConfig(): GitBackupConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8')
    const o = JSON.parse(raw)
    return { ...DEFAULT_CONFIG, ...(o && typeof o === 'object' ? o : {}) }
  } catch { return { ...DEFAULT_CONFIG } }
}

export function saveGitConfig(patch: Partial<GitBackupConfig>): { ok: boolean; error?: string; extractedToken?: string } {
  try {
    const cur = readGitConfig()
    const next: GitBackupConfig = { ...cur, ...patch }
    // 地址里内嵌的令牌（https://token@host/x.git）**必须抽出来** ——
    // 否则它会原样写进 .git/config 留明文（司天踩过这条）。
    let extracted = ''
    if (patch.remote !== undefined) {
      const s = splitInlineCredential(next.remote)
      next.remote = s.remote
      extracted = s.token
    }
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf-8')
    return { ok: true, extractedToken: extracted || undefined }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

// ── 令牌保管（照抄司天的语义：能加密就落盘，不能就只留内存，绝不写明文）──────

interface CredFile { [host: string]: { username: string; secret: string } }
/** 拿不到加密能力时的会话内保管 */
const sessionToken = new Map<string, { username: string; token: string }>()

function canPersist(): boolean {
  try { return safeStorage.isEncryptionAvailable() } catch { return false }
}

function readCredFile(): CredFile {
  try {
    const o = JSON.parse(fs.readFileSync(credPath(), 'utf-8'))
    return o && typeof o === 'object' ? o : {}
  } catch { return {} }
}

export function getGitToken(): { username: string; token: string } | null {
  const host = hostOfRemote(readGitConfig().remote)
  if (!host) return null
  if (sessionToken.has(host)) return sessionToken.get(host)!
  if (!canPersist()) return null
  const rec = readCredFile()[host]
  if (!rec?.secret) return null
  try {
    const token = safeStorage.decryptString(Buffer.from(rec.secret, 'base64'))
    if (!token) return null
    const v = { username: rec.username || '', token }
    sessionToken.set(host, v)
    return v
  } catch { return null }   // 换了机器/用户 → 解不开，当作没有，让用户重填
}

/** 保存令牌。**返回给渲染层的永远只有持久化与否，不含令牌本身**。 */
export function saveGitToken(token: string, username = ''): { ok: boolean; persistent: boolean; error?: string } {
  const host = hostOfRemote(readGitConfig().remote)
  const t = String(token || '').trim()
  if (!host) return { ok: false, persistent: false, error: '请先填并保存仓库地址' }
  if (!t) return { ok: false, persistent: false, error: '令牌为空' }
  const u = String(username || '').trim()
  if (!canPersist()) {
    sessionToken.set(host, { username: u, token: t })
    return { ok: true, persistent: false, error: '本机加密存储不可用（已退回本次会话内存保管，重启需重填）' }
  }
  try {
    const all = readCredFile()
    const secret = safeStorage.encryptString(t).toString('base64')
    all[host] = { username: u, secret }
    const tmp = `${credPath()}.tmp-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf-8')
    fs.renameSync(tmp, credPath())      // 原子替换：断电不会留半个 JSON
    sessionToken.set(host, { username: u, token: t })
    return { ok: true, persistent: true }
  } catch (e: any) {
    sessionToken.set(host, { username: u, token: t })
    return { ok: true, persistent: false, error: `凭据写入失败（已退回本次会话内存）：${e?.message || e}` }
  }
}

export function hasGitToken(): boolean { return !!getGitToken() }

export function clearGitToken(): { ok: boolean } {
  const host = hostOfRemote(readGitConfig().remote)
  if (host) sessionToken.delete(host)
  try {
    const all = readCredFile()
    if (host && all[host]) { delete all[host]; fs.writeFileSync(credPath(), JSON.stringify(all, null, 2), 'utf-8') }
    return { ok: true }
  } catch (e: any) { return { ok: false } }
}

// ── 跑 git ────────────────────────────────────────────────────────────

interface GitRun { ok: boolean; code: number; out: string }

/**
 * 跑一条 git 命令。**令牌只经环境变量进**（argv 里绝不出现）。
 * 输出一律过 sanitizeGitOutput 才回给调用方。
 */
function runGit(args: string[], cwd: string, token?: { username: string; token: string } | null): Promise<GitRun> {
  return new Promise((resolve) => {
    const env = buildGitEnv(process.env)
    if (token?.token) {
      env[GIT_TOKEN_ENV] = token.token
      env[GIT_USER_ENV] = token.username || 'x-access-token'
    }
    const full = token?.token ? [...buildCredentialArgs(), ...args] : args
    let out = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', full, { cwd, env, windowsHide: true })
    } catch (e: any) {
      resolve({ ok: false, code: -1, out: `无法启动 git：${e?.message || e}` })
      return
    }
    child.stdout?.on('data', (d) => { out += d.toString() })
    child.stderr?.on('data', (d) => { out += d.toString() })
    child.on('error', (e: any) => resolve({ ok: false, code: -1, out: `无法启动 git：${e?.message || e}（本机装 git 了吗？）` }))
    child.on('close', (code) => resolve({ ok: code === 0, code: code ?? -1, out: sanitizeGitOutput(out, token?.token) }))
  })
}

/** 测试连接（`git ls-remote`）—— 给确定性反馈，别让用户猜 */
export async function gitTestRemote(): Promise<{ ok: boolean; message: string }> {
  const cfg = readGitConfig()
  if (!cfg.remote) return { ok: false, message: '还没填仓库地址' }
  const r = await runGit(['ls-remote', '--exit-code', cfg.remote], app.getPath('userData'), getGitToken())
  if (r.ok) return { ok: true, message: '连上了，而且令牌能读这个仓库。' }
  const info = analyzeGitError(r.out)
  return { ok: false, message: info.message }
}

/**
 * 把一份备份 zip 推上去。
 * 流程：工作副本 clone（首次）→ 复制 zip 进去 → add/commit/push。
 * ⚠ 推送失败**不丢数据**：commit 已经在本地工作副本里了，网络好了再点一次即可。
 */
export async function gitPushPackage(zipPath: string): Promise<{ ok: boolean; message: string; pushed?: boolean }> {
  const cfg = readGitConfig()
  if (!cfg.remote) return { ok: false, message: '还没填仓库地址' }
  if (!zipPath || !fs.existsSync(zipPath)) return { ok: false, message: '找不到要推的备份包' }
  const token = getGitToken()
  const dir = workDir()

  // 首次：clone 一份工作副本（git 在这里跑，用户不必管）
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(dir, { recursive: true })
    const c = await runGit(['clone', '--depth', '1', cfg.remote, '.'], dir, token)
    if (!c.ok) {
      // clone 失败可能只是空仓库 —— 退一步自己 init
      const i = await runGit(['init'], dir, token)
      if (!i.ok) return { ok: false, message: analyzeGitError(i.out).message }
      await runGit(['remote', 'add', 'origin', cfg.remote], dir, token)
    }
  }

  // 只保留最近 3 份 zip（仓库是拿来存放备份的，不该无限长）。
  // 先按时间排序，留下最新 2 份旧的 —— 加上本次要放进去的那份，正好 3 份。
  const name = path.basename(zipPath)
  try {
    const old = fs.readdirSync(dir)
      .filter((x) => x.endsWith('.zip') && x !== name)
      .map((x) => ({ x, t: fs.statSync(path.join(dir, x)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const z of old.slice(2)) { try { fs.unlinkSync(path.join(dir, z.x)) } catch { /* 删不掉就算了，不影响推送 */ } }
  } catch { /* 清理失败不影响推送 */ }

  fs.copyFileSync(zipPath, path.join(dir, name))

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  await runGit(['add', '-A'], dir, token)
  const commit = await runGit([
    '-c', `user.name=${cfg.authorName}`, '-c', `user.email=${cfg.authorEmail}`,
    'commit', '-m', `backup: ${name} @ ${stamp}`,
  ], dir, token)
  // 「没有改动」不算失败（同一份包再推一次）
  if (!commit.ok && !/nothing to commit|no changes added/i.test(commit.out)) {
    return { ok: false, message: analyzeGitError(commit.out).message }
  }

  const push = await runGit(['push', 'origin', `HEAD:${cfg.branch}`], dir, token)
  if (!push.ok) {
    const info = analyzeGitError(push.out)
    return { ok: false, message: info.message + '（本地提交已保留，网络/权限好了再点一次即可）' }
  }
  return { ok: true, message: `已推送 ${name}`, pushed: true }
}
