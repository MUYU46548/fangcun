/**
 * Git 备份通道的**纯逻辑**部分（2026-10-11，卡 `task-20261002-003` 备份多通道 · Git 支线）
 *
 * 为什么单独一个文件：这里放的全是**安全红线**上的判断 —— 令牌怎么进 git、输出怎么脱敏、
 * 报错怎么翻人话。它们必须是纯函数，这样在没有 git、没有 electron 的机器上也能被
 * `scripts/test/e2e-git-backup.cjs` 直接断言。
 * （另一半 `gitBackup.ts` 要 spawn git、要 safeStorage，只能在真机上跑。）
 *
 * 抄的是司天那套已经踩过坑的做法（`E:/CODE/CangKu/SiTian/src/main/gitSyncHandler.js`）：
 *
 *   · 令牌**不进 argv、不进 `.git/config`** —— 只经 `-c credential.helper=` 注入的环境变量传；
 *   · 所有 git 调用 `GIT_TERMINAL_PROMPT=0` —— 缺凭证**立刻失败**，不许挂死在那儿等人输密码
 *     （GUI 应用没有终端可输，挂死就是"点了没反应"）；
 *   · 回给渲染层 / 落日志的一切文本都过 `sanitizeGitOutput`；
 *   · 报错要**区分「令牌被拒」与「压根没找到凭据」** —— 这两者的指引完全相反
 *     （前者去换令牌，后者去填令牌）。司天旧实现把两者混为一谈，把"权限不足"也说成"去填令牌"。
 */

export type GitErrorKind = 'auth-rejected' | 'no-credential' | 'remote-not-found' | 'network' | 'not-a-repo' | 'unknown'

export interface GitErrorInfo {
  kind: GitErrorKind
  /** 给人看的一句话（不含任何令牌 / URL 内嵌凭据） */
  message: string
}

/**
 * 抹掉文本里的令牌与 URL 内嵌凭据。
 * **任何要回渲染层或写日志的 git 输出都必须先过它** —— git 的报错里会原样回显带令牌的 URL。
 */
export function sanitizeGitOutput(text: unknown, token?: string | null): string {
  let s = String(text ?? '')
  const t = String(token ?? '').trim()
  if (t) {
    // 令牌可能出现在多种位置：URL 里的 user:token@、裸串、Authorization 头
    s = s.split(t).join('***')
  }
  // https://user:secret@host/... → https://user:***@host/...
  s = s.replace(/(https?:\/\/[^\s/@:]+):[^\s/@]+@/gi, '$1:***@')
  return s
}

/**
 * 把 git 的 stdout+stderr 翻成人话，并给出 `kind` —— 调用方据此决定按钮怎么摆、提示怎么写。
 * 判据只认**真实出现过**的那几种输出形态（照抄司天踩过的坑，不是拍脑袋编的）。
 */
export function analyzeGitError(text: unknown): GitErrorInfo {
  const raw = String(text ?? '')
  const s = raw.toLowerCase()

  // 「压根没找到凭据」与「令牌被拒」必须分开 —— 指引相反
  if (s.includes('authentication failed') || s.includes('invalid username or password')
    || s.includes('403') || s.includes('401') || s.includes('permission denied')
    || s.includes('access denied') || s.includes('bad credentials')) {
    return { kind: 'auth-rejected', message: '远程仓库拒绝了这个令牌。多半是令牌过期或权限不够（要能写这个仓库）—— 换一个再试。' }
  }
  if (s.includes('could not read username') || s.includes('terminal prompts disabled')
    || s.includes('no such device or address') || s.includes('could not read password')) {
    return { kind: 'no-credential', message: '没有可用的凭据：这个仓库还需要认证，但令牌没填（或没存住）。先在上面填好访问令牌。' }
  }
  if (s.includes('repository not found') || s.includes('does not exist')) {
    return { kind: 'remote-not-found', message: '找不到这个远程仓库：地址写错了，或者令牌没有访问它的权限（私有仓库会故意报"不存在"）。' }
  }
  if (s.includes('could not resolve host') || s.includes('connection timed out')
    || s.includes('failed to connect') || s.includes('network is unreachable')) {
    return { kind: 'network', message: '连不上远程仓库：检查网络，或仓库地址是否可达。' }
  }
  if (s.includes('not a git repository')) {
    return { kind: 'not-a-repo', message: '目标文件夹不是一个 git 仓库。' }
  }
  // 认不出来就如实说"认不出来"，并把原文（已脱敏）带出去 —— 不编原因
  return { kind: 'unknown', message: '推送失败（原因未能自动识别）。' }
}

/** git 调用统一的进程环境：清掉交互提示 + 塞进代理相关（都不含令牌） */
export function buildGitEnv(base: NodeJS.ProcessEnv | Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string') env[k] = v
  // 缺凭证立刻失败，绝不挂死等人输密码（GUI 里没有终端可输，"挂死"＝"点了没反应"）
  env.GIT_TERMINAL_PROMPT = '0'
  // 别让 git 弹图形凭据助手 —— 那会绕过我们注入的令牌，还可能把令牌存进系统凭据管理器
  env.GIT_ASKPASS = ''
  env.SSH_ASKPASS = ''
  return env
}

/**
 * 构造凭据注入参数 —— **令牌只出现在环境变量里，不出现在 argv**。
 *
 * 做法（抄司天）：用 `-c credential.helper=` 先**清空**所有既有 helper，再挂一个内联 shell 函数，
 * 该函数从环境变量读令牌吐给 git。这样：
 *   · 令牌不进 argv（`ps` 看不到）；
 *   · 令牌不进 `.git/config`（不是持久 helper）；
 *   · 不依赖系统凭据管理器（司天踩过的坑：存进去了 ≠ 推的时候取得回来）。
 *
 * ⚠ 返回的数组**绝不含令牌本身** —— 这是本函数的契约，测试专门钉这一条。
 */
export function buildCredentialArgs(): string[] {
  return [
    '-c', 'credential.helper=',
    '-c', 'credential.helper=!f(){ echo "username=$FANGCUN_GIT_USERNAME"; echo "password=$FANGCUN_GIT_TOKEN"; }; f',
  ]
}

/** 令牌要走的环境变量名（与 buildCredentialArgs 里的内联函数必须一致） */
export const GIT_TOKEN_ENV = 'FANGCUN_GIT_TOKEN'
export const GIT_USER_ENV = 'FANGCUN_GIT_USERNAME'

/** 从仓库地址里抽出域名（凭据按域名存 —— 换仓库不用重填） */
export function hostOfRemote(remote: unknown): string {
  const s = String(remote ?? '').trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    return (u.host || '').toLowerCase()
  } catch {
    // 不是标准 URL（ssh 形式 git@host:path）→ 抓 @ 与 : 之间那段
    const m = s.match(/^[^@]+@([^:]+):/)
    return m ? m[1].toLowerCase() : ''
  }
}

/**
 * 地址里**内嵌的令牌必须被抽出来**（`https://token@github.com/x.git`）——
 * 否则它会原样写进 `.git/config` 留明文（司天踩过这条）。
 * 返回脱敏后的地址 + 抽出来的部分（调用方决定要不要拿来当令牌用）。
 */
export function splitInlineCredential(remote: unknown): { remote: string; username: string; token: string } {
  const s = String(remote ?? '').trim()
  const m = s.match(/^(https?:\/\/)([^/@\s]+):([^/@\s]+)@(.+)$/i) || s.match(/^(https?:\/\/)([^/@\s]+)@(.+)$/i)
  if (!m) return { remote: s, username: '', token: '' }
  if (m.length === 5) return { remote: m[1] + m[4], username: m[2], token: m[3] }
  return { remote: m[1] + m[3], username: m[2], token: '' }
}
