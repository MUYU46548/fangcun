#!/usr/bin/env node
/**
 * Git 备份通道 · 安全红线断言（2026-10-11，卡 `task-20261002-003` · Git 支线）
 *
 * 真跑**编译产物** `dist/main/backup/gitBackupPure.js`（纯逻辑，不要 electron / 不要 git → 本机可跑）。
 *
 * 这里盯的不是"能不能推上去"（那要真仓库真令牌才知道），而是**四条安全红线**：
 *   ① 令牌**不进 argv** —— `ps` 看不到；
 *   ② 回渲染层 / 落日志的文本**必须脱敏** —— git 报错会原样回显带令牌的 URL；
 *   ③ 缺凭证**立刻失败**（GIT_TERMINAL_PROMPT=0）—— GUI 里挂死就是"点了没反应"；
 *   ④ 「令牌被拒」与「没找到凭据」**必须分开报** —— 指引相反（换令牌 vs 填令牌）。
 *
 * 运行：node scripts/test/e2e-git-backup.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'main', 'backup', 'gitBackupPure.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const {
  sanitizeGitOutput, analyzeGitError, buildGitEnv, buildCredentialArgs,
  hostOfRemote, splitInlineCredential, GIT_TOKEN_ENV,
} = require(ART)

console.log('== Git 备份通道 · 安全红线 ==')

// ⚠ 用**中性形状**的假令牌：不放任何真人令牌形态的串（本轮实测：写了 PAT 形状的假令牌
//   会触发静态密钥扫描，文件直接被拦，连续两次）。“按调用方传入的 token 精确替换”这条
//   核心判据用中性串一样验得到，没必要冒那个风险。
const TOKEN = 'TESTTOKEN-REDACT-ME-0001'

// ── ① 令牌不进 argv ───────────────────────────────────────────────────
const args = buildCredentialArgs()
check('★ 红线①：凭据参数里**一个令牌字样都没有**（令牌只走环境变量）',
  !args.join(' ').includes(TOKEN) && !/ghp_|github_pat_/.test(args.join(' ')),
  JSON.stringify(args))
check('★ 红线①：先清空所有既有 credential.helper（不依赖系统凭据管理器 ——'
  + '司天踩过"存进去了 ≠ 推的时候取得回来"，失败表现是"我明明填了令牌"）',
  args.includes('credential.helper=') && args.includes('credential.helper=!f(){ echo "username=$FANGCUN_GIT_USERNAME"; echo "password=$FANGCUN_GIT_TOKEN"; }; f'))
check('  凭据函数读的环境变量名与导出常量一致（改名不会悄悄错位）',
  args.join(' ').includes('$' + GIT_TOKEN_ENV))
check('  buildCredentialArgs 是纯函数：调用两次结果相同（可被反复调用）',
  JSON.stringify(buildCredentialArgs()) === JSON.stringify(args))

// ── ② 输出脱敏 ────────────────────────────────────────────────────────
check('★ 红线②：报错里的令牌被抹掉', sanitizeGitOutput(`fatal: could not read Password for 'https://${TOKEN}@github.com'`, TOKEN).indexOf(TOKEN) < 0)
check('★ 红线②：URL 内嵌凭据（user:secret@host）被抹成 user:***@host —— '
  + '这也正是 git 报错最常见的回显形态',
  sanitizeGitOutput('remote: https://muyu:supersecret@github.com/x/y.git not found', '')
    === 'remote: https://muyu:***@github.com/x/y.git not found',
  sanitizeGitOutput('https://muyu:supersecret@github.com/x/y.git', ''))
check('★ 红线②：URL 里的密码段不依赖"传没传 token"就已被抹（这是最要紧的那条，'
  + '因为 git 报错回显的就是带凭据的 URL）',
  sanitizeGitOutput('https://x:othersecret@github.com/a.git', TOKEN).indexOf('othersecret') < 0)
check('  正常文本原样保留（脱敏不能把普通内容也吃掉）',
  sanitizeGitOutput('Already up to date.', TOKEN) === 'Already up to date.')
check('  空 / null / undefined → 空串，不产出 "null" 字面量',
  sanitizeGitOutput(null) === '' && sanitizeGitOutput(undefined) === '' && sanitizeGitOutput('') === '')

// ── ③ 缺凭证立刻失败 ──────────────────────────────────────────────────
const env = buildGitEnv({ PATH: '/usr/bin', FOO: 'bar' })
check('★ 红线③：GIT_TERMINAL_PROMPT=0（否则 git 会挂在那儿等人输密码 —— GUI 里就是"点了没反应"）',
  env.GIT_TERMINAL_PROMPT === '0')
check('★ 红线③：清掉 GIT_ASKPASS / SSH_ASKPASS（弹图形凭据框会绕过我们注入的令牌）',
  env.GIT_ASKPASS === '' && env.SSH_ASKPASS === '')
check('  原 env 的其它变量照常带上（别把 PATH 弄丢）',
  env.PATH === '/usr/bin' && env.FOO === 'bar')
check('  非字符串值被丢掉（process.env 里可能有 undefined）',
  !('UNDEF' in buildGitEnv({ UNDEF: undefined })))

// ── ④ 错误分类：被拒 vs 没凭据（指引相反）────────────────────────────
const rejected = analyzeGitError('remote: Invalid username or password.\nfatal: Authentication failed for ...')
const noCred = analyzeGitError('fatal: could not read Username for \'https://github.com\': terminal prompts disabled')
check('★ 红线④：「认证失败」判为 auth-rejected', rejected.kind === 'auth-rejected', rejected.kind)
check('★ 红线④：「读不到用户名 / prompts disabled」判为 no-credential', noCred.kind === 'no-credential', noCred.kind)
check('★★ 两条的 kind **必须不同**（司天旧实现混为一谈，把"权限不足"也说成"去填令牌"）',
  rejected.kind !== noCred.kind)
check('★ 两条给人看的话也不一样，且各自指向正确动作',
  rejected.message.indexOf('换') >= 0 && noCred.message.indexOf('填') >= 0,
  `rejected="${rejected.message}" / noCred="${noCred.message}"`)
check('  仓库不存在（私有仓库会故意报"不存在"）单独一类',
  analyzeGitError('remote: Repository not found.').kind === 'remote-not-found')
check('  网络问题单独一类', analyzeGitError('fatal: unable to access ... Could not resolve host: github.com').kind === 'network')
check('★ 认不出来时如实说"未能识别"，**不编原因**',
  analyzeGitError('some totally unknown output').kind === 'unknown'
  && analyzeGitError('some totally unknown output').message.indexOf('未能自动识别') >= 0)
check('  错误信息里不留令牌（analyzeGitError 自己也该脱敏？—— 不，它只做分类；'
  + '调用方必须把原文过 sanitizeGitOutput。这里钉住"它不主动回显原文"）',
  rejected.message.indexOf(TOKEN) < 0)

// ── ⑤ 域名与内嵌凭据 ──────────────────────────────────────────────────
check('hostOfRemote: https 地址取 host', hostOfRemote('https://github.com/a/b.git') === 'github.com')
check('hostOfRemote: ssh 形式的 scp-like 地址也能取（git@host:path）', hostOfRemote('git@github.com:a/b.git') === 'github.com')
check('hostOfRemote: 空 / 垃圾输入 → 空串（不抛）',
  hostOfRemote('') === '' && hostOfRemote(null) === '' && hostOfRemote('不是地址') === '')
check('hostOfRemote: 大小写归一（同域名不会存成两份凭据）',
  hostOfRemote('https://GitHub.com/a.git') === 'github.com')

const split = splitInlineCredential('https://muyu:' + TOKEN + '@github.com/a/b.git')
check('★ splitInlineCredential：把内嵌令牌抽出来，返回的地址是**脱敏**的'
  + '（否则它会原样写进 .git/config 留明文）',
  split.remote === 'https://github.com/a/b.git' && split.username === 'muyu' && split.token === TOKEN,
  JSON.stringify(split))
check('  没内嵌凭据的地址原样返回，不硬塞空用户名',
  (() => { const s = splitInlineCredential('https://github.com/a/b.git'); return s.remote === 'https://github.com/a/b.git' && s.token === '' })())
check('  只有用户名没密码（user@host）也能拆，且 token 为空而不是拿用户名当令牌',
  (() => { const s = splitInlineCredential('https://muyu@github.com/a.git'); return s.token === '' && s.username === 'muyu' })())
check('★ 脱敏后的 remote 里绝不含令牌（喂给 git 的地址本身就干净）',
  split.remote.indexOf(TOKEN) < 0)
check('  空 / null 输入不抛', splitInlineCredential(null).remote === '' && splitInlineCredential(undefined).token === '')

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
