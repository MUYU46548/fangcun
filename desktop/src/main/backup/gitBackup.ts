/**
 * Git 备份通道 · 执行器（2026-10-11，卡 `task-20261002-003`）
 *
 * 场景：**把数据目录里的真实文件镜像进一个 git 仓库**，让每份任务/日志/方针卡都有
 * 逐文件 diff 与历史 —— 这才叫"用 git 备份"。
 *
 * ⚠ 2026-10-11 用户第 1 条（真机反馈）：
 *   「GIT 可以用了…但是推上去的怎么是一个压缩包？全世界没有任何软件的 git 备份直接扔压缩包上去。
 *     哪怕司天都不扔压缩包。那要 git 有什么用？压缩包只应用于网盘等场景。」
 *   老实现把整个备份 zip 当成一个 blob 推进去 —— 仓库里只有一个 zip，历史里看不出任何东西改了。
 *   现在改成**镜像工作树**：把 `task-data/ + registry.yaml + policies/ + docs/` 原样铺进仓库，
 *   每次提交都是"哪个文件加了改动一行的 diff"。
 *
 * 与 zip 通道的关系：**共用同一套范围与瘦身判据**（`scope.ts` + `packer.planSnapshot`），
 * 所以 git 里有的东西 ≈ zip 里有的东西，不会漂移。
 *
 * 安全设计全部落在 `gitBackupPure.ts` 里（纯函数，可被 node 直接断言）：
 * 令牌不进 argv、输出脱敏、缺凭证立刻失败、错误分类。**本文件只负责把那些约定拼起来跑**。
 *
 * 抄司天（`E:/CODE/CangKu/SiTian/src/main/gitSyncHandler.js`，794 行）的凭据做法。
 */
import { app, safeStorage } from 'electron'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import {
  buildCredentialArgs, buildGitEnv, sanitizeGitOutput, analyzeGitError,
  hostOfRemote, splitInlineCredential, isPushRejected, pushRecoverySteps,
  GIT_TOKEN_ENV, GIT_USER_ENV,
} from './gitBackupPure'
import { scopeSources, REPO_GITIGNORE } from './scope'
import { planSnapshot } from './packer'

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

/**
 * 测试连接（`git ls-remote`）—— 给确定性反馈，别让用户猜。
 *
 * ⚠ 2026-10-11 真机修：**不能用 `--exit-code`**。实测空仓库（刚建、还没有任何提交）
 *   下 `git ls-remote --exit-code` 会「退出码 2 + 一个字都不吐」，于是被翻成
 *   「未能自动识别」—— 用户看到的是"填了地址却说没填/失败"，其实是**一切正常**。
 *   现在：能列出 refs → 连上了；列不出来但也没报错 → 连上了（这是个空仓库）；
 *   有报错 → 才按 analyzeGitError 说人话。
 */
export async function gitTestRemote(): Promise<{ ok: boolean; message: string }> {
  const cfg = readGitConfig()
  if (!cfg.remote) return { ok: false, message: '仓库地址还是空的 —— 填好地址先点「保存」，再点这里测试。' }
  const r = await runGit(['ls-remote', cfg.remote], app.getPath('userData'), getGitToken())
  if (r.ok) {
    return { ok: true, message: r.out.trim() ? '连上了，而且令牌能读这个仓库。' : '连上了（这个仓库还是空的，第一次推送会自动建分支）。' }
  }
  const info = analyzeGitError(r.out, r.code)
  return { ok: false, message: info.message }
}

/**
 * 把数据目录**镜像**进工作副本：清掉除 `.git` 之外的一切，再按 plan 铺进去。
 *
 * 为什么要"清空重铺"而不是"增量覆盖"：镜像必须是**双向可删**的 ——
 * 用户删掉一个任务/一张方针卡，仓库里也该跟着删。只 add 不改删的话，git 历史里
 * 会永远留着已经不存在的东西（用户会以为"删了还在"，那是另一种静默失败）。
 */
function mirrorInto(dir: string, files: Array<{ rel: string; abs: string }>): void {
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git') continue
    try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }) } catch { /* 单个删不掉不阻断 */ }
  }
  for (const f of files) {
    const dest = path.join(dir, f.rel)
    const parent = path.dirname(dest)
    if (parent !== dir) fs.mkdirSync(parent, { recursive: true })
    fs.copyFileSync(f.abs, dest)
  }
  // 纵深防御：万一有密钥类文件被误拷进来，git 也不追踪
  fs.writeFileSync(path.join(dir, '.gitignore'), REPO_GITIGNORE, 'utf-8')
}

export interface GitSyncResult {
  ok: boolean
  message: string
  pushed?: boolean
  recovered?: boolean
  /** 本次同步进仓库的文件数 */
  files?: number
  /** 被排除（密钥类）或被瘦身跳过的文件数 */
  omitted?: number
}

/**
 * 同步数据到 git 仓库（**真实文件，不是压缩包**）。
 *
 * 流程：clone / 对齐远端 → 清空重铺镜像 → add/commit/push；推送被拒就自动救一次。
 * ⚠ 失败**不丢数据**：commit 已经在本地工作副本里，网络/权限好了再点一次即可。
 */
export async function gitSyncData(): Promise<GitSyncResult> {
  const cfg = readGitConfig()
  if (!cfg.remote) return { ok: false, message: '仓库地址还是空的 —— 填好地址先点「保存」，再点「同步」。' }
  const token = getGitToken()
  const dir = workDir()
  const gitDir = path.join(dir, '.git')

  // 1. 准备一个与远端一致的工作副本。
  //    ⚠ clone 失败不再盲目退化成 init —— 那会把「令牌被拒 / 网络不通」的真因吞掉。
  //    （空仓库不需要 init：实测 `git clone` 空仓库是**成功退出**的。）
  if (!fs.existsSync(gitDir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清不掉就让 clone 自己报错 */ }
    fs.mkdirSync(dir, { recursive: true })
    const c = await runGit(['clone', cfg.remote, '.'], dir, token)
    if (!c.ok) return { ok: false, message: analyzeGitError(c.out, c.code).message }
  } else {
    await runGit(['remote', 'set-url', 'origin', cfg.remote], dir, token)
    // 与远端对齐（镜像 = 远端最新 + 本次改动）。取不到远端分支（空仓库/离线）不算错，继续走。
    const f = await runGit(['fetch', 'origin', cfg.branch], dir, token)
    if (f.ok) await runGit(['reset', '--hard', `origin/${cfg.branch}`], dir, token)
  }

  // 2. 算出要镜像哪些文件 —— 与 zip 通道**同一套判据**（范围 + 密钥排除 + 瘦身）。
  let plan
  try {
    plan = planSnapshot(scopeSources())
  } catch (e: any) {
    return { ok: false, message: '扫描数据目录失败：' + (e?.message || e) }
  }
  if (!plan.files.length) return { ok: false, message: '没有可同步的文件（task-data / registry.yaml / policies / docs 都是空的？）' }

  // 3. 清空重铺镜像。
  try {
    mirrorInto(dir, plan.files)
  } catch (e: any) {
    return { ok: false, message: '写入工作副本失败：' + (e?.message || e) }
  }

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const msg = `sync: ${plan.files.length} 个文件 @ ${stamp}`

  const commitAndPush = async (): Promise<GitRun> => {
    await runGit(['add', '-A'], dir, token)
    const commit = await runGit([
      '-c', `user.name=${cfg.authorName}`, '-c', `user.email=${cfg.authorEmail}`,
      'commit', '-m', msg,
    ], dir, token)
    // 「没有改动」不算失败（数据没变时再点一次）
    if (!commit.ok && !/nothing to commit|no changes added/i.test(commit.out)) return commit
    return runGit(['push', 'origin', `HEAD:${cfg.branch}`], dir, token)
  }

  let push = await commitAndPush()

  // 被拒（远端有本地没有的提交）→ 自动救一次：fetch 回远端 → reset --soft 挪到远端之上
  // → 重新 commit + push（**绝不用 --force** —— 仓库里可能有别的机器的提交）。
  let recovered = false
  if (!push.ok && isPushRejected(push.out)) {
    let canRecover = true
    for (const step of pushRecoverySteps(cfg.branch)) {
      const s = await runGit(step, dir, token)
      if (!s.ok) { canRecover = false; push = s; break }
    }
    // ⚠ reset --soft 之后索引被挪到远端之上，工作树内容不变（还是那份镜像）→ 重新 add 最稳。
    if (canRecover) { recovered = true; push = await commitAndPush() }
  }

  const omitted = plan.omitted.length + plan.excludedSecrets.length
  if (!push.ok || (push.out && /rejected/i.test(push.out))) {
    const info = analyzeGitError(push.out, push.code)
    return { ok: false, message: info.message + '（本地提交已保留，网络/权限好了再点一次即可）', recovered, files: plan.files.length, omitted }
  }
  const skipNote = omitted ? `，另有 ${omitted} 个文件按设置跳过（密钥类 / 体积超限）` : ''
  return {
    ok: true,
    message: `已同步 ${plan.files.length} 个文件到 ${cfg.branch}${recovered ? '（远端先前有更新，已先并入再推）' : ''}${skipNote}`,
    pushed: true, recovered, files: plan.files.length, omitted,
  }
}
