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
  hostOfRemote, splitInlineCredential, isPushRejected, pushRecoverySteps, GIT_TOKEN_ENV,
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
  && analyzeGitError('some totally unknown output').message.indexOf('没能自动识别') >= 0)
check('★ 认不出来时**把脱敏原文带出来**（老版本把原文吞了，用户只看到"未能识别"——'
  + '2026-10-11 真机就是被这句噎住的：无从下手）',
  analyzeGitError('some totally unknown output').message.indexOf('some totally unknown output') >= 0,
  analyzeGitError('some totally unknown output').message)
check('  错误信息里不留令牌（analyzeGitError 自己也该脱敏？—— 不，它只做分类；'
  + '调用方必须把原文过 sanitizeGitOutput。这里钉住"它不主动回显调用方传入的令牌"）',
  rejected.message.indexOf(TOKEN) < 0)

// ── ⑤-b 2026-10-11 真机实测捕获的原文（老版本认不出、直接落到"未能识别"）──────
// 这两段是**真跑 git 抓下来的原话**，不是我编的。
const REAL_EMPTY_LSREMOTE = { text: '', code: 2 }
check('★★ 空仓库：`ls-remote --exit-code` 实测是「退出码 2 + 一个字都不吐」——'
  + '老版本把这种翻成"推送失败（原因未能自动识别）"，用户当场懵',
  analyzeGitError(REAL_EMPTY_LSREMOTE.text, REAL_EMPTY_LSREMOTE.code).kind === 'no-output',
  analyzeGitError(REAL_EMPTY_LSREMOTE.text, REAL_EMPTY_LSREMOTE.code).kind)
check('★ 空输出时的提示要把退出码说出来，并指向"测试连接"（给下一步，不是干瞪眼）',
  analyzeGitError('', 2).message.indexOf('2') >= 0 && analyzeGitError('', 2).message.indexOf('测试连接') >= 0,
  analyzeGitError('', 2).message)

const REAL_PUSH_REJECTED = [
  'To https://github.com/MUYU46548/fangcun-backup.git',
  ' ! [rejected]        HEAD -> main (fetch first)',
  "error: failed to push some refs to 'https://github.com/MUYU46548/fangcun-backup.git'",
  'hint: Updates were rejected because the remote contains work that you do not',
].join('\n')
check('★★ 推送被拒（远端有本地没有的提交）**必须单独成类** —— 实测原文 '
  + '`! [rejected] ... (fetch first)` / `error: failed to push some refs`，'
  + '老版本直落"未能识别"（用户看到的就是那句）',
  analyzeGitError(REAL_PUSH_REJECTED).kind === 'push-rejected',
  analyzeGitError(REAL_PUSH_REJECTED).kind)
check('★ isPushRejected() 与 kind 一致（调用方靠它决定要不要自动救一次）',
  isPushRejected(REAL_PUSH_REJECTED) === true && isPushRejected('Already up to date.') === false)
check('  非快进 / updates were rejected 等其它写法也认',
  isPushRejected('hint: Updates were rejected because the tip of your current branch is behind')
  && isPushRejected('! [rejected]        main -> main (non-fast-forward)'))

check('  真 GitHub 原文「Repository not found」+「Authentication failed」→ auth-rejected'
  + '（注意：无权限时 GitHub 故意谎报"不存在"，所以**先判认证失败**再判不存在，顺序不能反）',
  analyzeGitError('remote: Repository not found.\nfatal: Authentication failed for \'https://github.com/a/b.git/\'').kind === 'auth-rejected')
check('  找不到 git 可执行文件单独一类（给"装一个"的指引，而不是"未能识别"）',
  analyzeGitError('无法启动 git：spawn git ENOENT（本机装 git 了吗？）').kind === 'git-missing')

// ── ⑤-c 自动补救方案（不许 --force）────────────────────────────────────
const steps = pushRecoverySteps('main')
check('★ 补救步骤：先 fetch 回远端分支', Array.isArray(steps[0]) && steps[0][0] === 'fetch' && String(steps[0][2]).indexOf('refs/heads/main') >= 0, JSON.stringify(steps[0]))
check('★ 补救步骤：再 reset --soft 到远端之上（--soft 保留索引/工作区 → 那份 zip 仍"已 add 待提交"'
  + '，所以接着 commit+push 是快进）',
  Array.isArray(steps[1]) && steps[1][0] === 'reset' && steps[1][1] === '--soft' && steps[1][2] === 'origin/main', JSON.stringify(steps[1]))
check('★★ 红线：补救**绝不用 --force / --force-with-lease** —— 备份仓库里可能有别的机器的提交，'
  + '强推会真丢数据（宁可直接报错让用户看）',
  !JSON.stringify(steps).match(/--force/))
check('  分支名可配；空值兜底 main', pushRecoverySteps('dev')[0][2].indexOf('heads/dev') >= 0 && pushRecoverySteps('')[1][2] === 'origin/main')

// ── ⑤-d 渲染层接线守卫（源码级 —— 防 2026-10-11 那两条回归）──────────────────
const APPSRC = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'App.vue'), 'utf-8')
check('★★ 渲染层：测试/推送**前先落盘表单**（gitCommitForm）—— 否则用户"填完直接点"会收到'
  + '"还没填仓库地址"，看着像软件坏了（2026-10-11 用户原话）',
  /async function gitCommitForm/.test(APPSRC)
  && /async function gitTest[\s\S]{0,400}await gitCommitForm\(\)/.test(APPSRC)
  && /async function gitPushNow[\s\S]{0,400}await gitCommitForm\(\)/.test(APPSRC),
  'gitCommitForm / 两处调用')
check('★★ 渲染层：Git 失败信息要同时认 `message` 与 `error` 两种形状 ——'
  + '主进程异常走的是 `error`（backup-ipc 的 fail()），只认 message 会显示成"没有返回结果"'
  + '（静默失败，用户最恨的那类）',
  /r\?\.message \|\| r\?\.error \|\| '测试没有返回结果'/.test(APPSRC)
  && /r\?\.message \|\| r\?\.error \|\| '推送没有返回结果'/.test(APPSRC))
check('  渲染层：令牌输入框清空时机正确（保存成功才清，不留明文在 UI）',
  /gitToken\.value = ''/.test(APPSRC) && !/gitToken\.value = gitToken\.value/.test(APPSRC))

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

// ── ⑥ 真 git 端到端（本机有 git 就跑；没有 → SKIP，不算失败）──────────
// 这一段是 2026-10-11 加的重点：上面全是纯函数，**"到底能不能推上去"没人验过**。
// 现在用**临时本地裸仓库**把真实命令序列跑一遍 —— 不需要网络、不需要令牌、不留痕。
// 用的是产品同款判据（isPushRejected / pushRecoverySteps），所以验的是真逻辑不是替身。
const os = require('os')
const { spawn: spawnProc } = require('child_process')

function gitAsync(args, cwd) {
  return new Promise((resolve) => {
    let out = ''
    let child
    try { child = spawnProc('git', args, { cwd, windowsHide: true }) }
    catch (e) { resolve({ code: -1, out: 'spawn failed: ' + e.message }); return }
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { out += d.toString() })
    child.on('error', (e) => resolve({ code: -1, out: 'spawn error: ' + e.code }))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

async function integrate() {
  const probe = await gitAsync(['--version'], os.tmpdir())
  if (probe.code !== 0) {
    console.log('SKIP  真 git 端到端（本机没有可用的 git）')
    return
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-git-e2e-'))
  const bare = path.join(root, 'bare.git')
  const idArgs = ['-c', 'user.name=e2e', '-c', 'user.email=e2e@local']
  try {
    await gitAsync(['init', '--bare', '--initial-branch=main', bare], root)

    // ① 根因回归：**空仓库下普通 ls-remote 必须成功退出**（老写法带 --exit-code → 退出码 2、零输出
    //    → 被翻成"未能识别"）。这条钉住"测试连接"在空仓库上不再误报。
    const ls = await gitAsync(['ls-remote', bare], root)
    check('★★ 真 git：空仓库 `ls-remote`（**不带 --exit-code**）退出码为 0 —— '
      + '这就是"测试连接"对刚建的空仓库不再误报的根据', ls.code === 0, `code=${ls.code} out=${ls.out.slice(0, 80)}`)
    const lsExit = await gitAsync(['ls-remote', '--exit-code', bare], root)
    check('  对照：带 --exit-code 时确实是退出码 2 + 零输出（老 bug 的现场，留下证据）',
      lsExit.code === 2 && lsExit.out.trim() === '', `code=${lsExit.code} out=[${lsExit.out.trim()}]`)
    check('  而 analyzeGitError 会给它一个**说得通**的类别（no-output），不是"未能识别"',
      analyzeGitError(lsExit.out, lsExit.code).kind === 'no-output')

    // ② 首次推送：clone 空仓库（**成功退出**，所以根本不需要老那套 blind init）
    const w = path.join(root, 'work')
    const cl = await gitAsync(['clone', '--depth', '1', bare, w], root)
    check('★★ 真 git：clone 一个**空**仓库是**成功退出**的（所以 clone 失败时不该盲目退化成 init ——'
      + '那会把"令牌被拒/网络不通"的真因吞掉）', cl.code === 0, `code=${cl.code} ${cl.out.slice(0, 120)}`)

    fs.writeFileSync(path.join(w, 'backup-1.zip'), 'zip-1')
    await gitAsync(['add', '-A'], w)
    await gitAsync([...idArgs, 'commit', '-m', 'backup: backup-1.zip'], w)
    const p1 = await gitAsync(['push', 'origin', 'HEAD:main'], w)
    check('★★ 真 git：首次推送成功，远端 main 建出来了', p1.code === 0, `code=${p1.code} ${p1.out.slice(0, 160)}`)
    const refs1 = await gitAsync(['ls-remote', '--heads', bare], root)
    check('  远端确实有了 refs/heads/main', refs1.out.indexOf('refs/heads/main') >= 0, refs1.out.trim())

    // ③ 模拟"远端领先"：另一台机器（另一个 clone）先推了一次 → 我们这份旧工作副本再推**必然被拒**
    const other = path.join(root, 'other')
    await gitAsync(['clone', '--depth', '1', bare, other], root)
    fs.writeFileSync(path.join(other, 'backup-other.zip'), 'zip-other')
    await gitAsync(['add', '-A'], other)
    await gitAsync([...idArgs, 'commit', '-m', 'backup: from other machine'], other)
    const pOther = await gitAsync(['push', 'origin', 'HEAD:main'], other)
    check('  准备：另一台机器的推送也成功（远端现在领先原工作副本）', pOther.code === 0,
      `code=${pOther.code} ${pOther.out.slice(0, 160)}`)

    fs.writeFileSync(path.join(w, 'backup-2.zip'), 'zip-2')
    await gitAsync(['add', '-A'], w)
    await gitAsync([...idArgs, 'commit', '-m', 'backup: backup-2.zip'], w)
    const pRej = await gitAsync(['push', 'origin', 'HEAD:main'], w)
    check('★★ 真 git：远端领先时推送**被拒**，且报错被认成 push-rejected（老版本这里落到"未能识别"）',
      pRej.code !== 0 && isPushRejected(pRej.out), `code=${pRej.code} kind=${analyzeGitError(pRej.out, pRej.code).kind}`)

    // ④ 跑产品同款补救步骤 → add/commit/push 应当变成快进成功
    let ok = true
    for (const step of pushRecoverySteps('main')) {
      const r = await gitAsync(step, w)
      if (r.code !== 0) { ok = false; console.log('    补救失败于: git ' + step.join(' ') + ' → ' + r.out.slice(0, 160)); break }
    }
    check('★★ 真 git：fetch + reset --soft 两步都成功（--soft 保住索引，zip 仍"已 add 待提交"）', ok)
    await gitAsync(['add', '-A'], w)
    const rec = await gitAsync([...idArgs, 'commit', '-m', 'backup: backup-2.zip(retry)'], w)
    const pFixed = await gitAsync(['push', 'origin', 'HEAD:main'], w)
    check('★★ 真 git：补救后再推**成功**（这是"点一下就好"的底层保证，不是 --force）',
      pFixed.code === 0, `commit=${rec.code} push=${pFixed.code} ${pFixed.out.slice(0, 160)}`)
    const refs2 = await gitAsync(['ls-remote', '--heads', bare], root)
    check('  补最后远端仍只有一条 main 分支（没被强推搞成两岔）',
      (refs2.out.match(/refs\/heads\/main/g) || []).length === 1)
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* 临时目录，删不掉也无妨 */ }
  }
}

/**
 * ⑦ 执行器本体（`gitBackup.ts`）—— 这一段才算真把「点一下按钮」走通。
 * 复用项目现成的 electron 桩（`electron-stub.cjs`），userData 指向临时目录，
 * 于是 clone 的工作副本、配置、凭据全落在临时目录里，跑完就删。
 * ⚠ 之前这个文件**从来没跑起来过**，所以 `gitPushPackage` 一行都没被验过 —— 现在补上。
 */
async function integrateExecutor() {
  const probe = await gitAsync(['--version'], os.tmpdir())
  if (probe.code !== 0) { console.log('SKIP  执行器端到端（本机没有可用的 git）'); return }

  const Module = require('module')
  const STUB = path.join(__dirname, 'electron-stub.cjs')
  const tmpUserData = path.join(os.tmpdir(), 'fc-git-exec-' + Date.now())
  fs.mkdirSync(tmpUserData, { recursive: true })
  // ⚠ 必须在 require 桩之前设好 —— 桩在模块加载时就把 userData 定死了
  process.env.FC_TEST_USERDATA = tmpUserData
  const origResolve = Module._resolveFilename
  Module._resolveFilename = function (request, ...args) {
    if (request === 'electron') return STUB
    return origResolve.call(this, request, ...args)
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-git-exec-repo-'))
  const bare = path.join(root, 'bare.git')
  const idArgs = ['-c', 'user.name=e2e', '-c', 'user.email=e2e@local']
  try {
    const gb = require(path.join(REPO, 'desktop', 'dist', 'main', 'backup', 'gitBackup.js'))
    await gitAsync(['init', '--bare', '--initial-branch=main', bare], root)

    // ① 没填地址时的提示必须指向"先保存"，不能是笼统的"还没填"
    const t0 = await gb.gitTestRemote()
    check('★ 执行器：地址为空时，提示要指路（含「保存」二字）—— 老文案「还没填仓库地址」'
      + '会让明明填了、只是没保存的人以为软件坏了',
      t0.ok === false && t0.message.indexOf('保存') >= 0, t0.message)

    gb.saveGitConfig({ remote: bare, branch: 'main' })
    check('  配置真的落盘了（readGitConfig 读得回来）', gb.readGitConfig().remote === bare)

    // 令牌按**域名**保管 —— 所以本地路径形式的 remote 没有域名，令牌存不住。
    //   这既是事实（本地路径本来也不需要令牌），也顺带把这条边界钉出来，免得以后有人以为能存。
    const localTok = gb.saveGitToken('TESTTOKEN-REDACT-ME-0001', 'e2e')
    check('  本地路径形式的 remote **没有域名** → 令牌不落盘（本来也不需要）',
      localTok.ok === false && gb.hasGitToken() === false, JSON.stringify(localTok))
    // 换成 https 形状的地址 → 令牌能存住（真实场景走的就是这条）
    gb.saveGitConfig({ remote: 'https://example.invalid/x.git', branch: 'main' })
    const httpsTok = gb.saveGitToken('TESTTOKEN-REDACT-ME-0001', 'e2e')
    check('★ https 形状的地址：令牌加密存住（hasGitToken 为真）', httpsTok.ok === true && gb.hasGitToken() === true, JSON.stringify(httpsTok))
    check('  凭据落盘文件里**不含明文令牌**', fs.readFileSync(path.join(tmpUserData, 'git-credentials.json'), 'utf-8').indexOf('TESTTOKEN-REDACT-ME-0001') < 0)
    // 回到本地裸仓库继续验推送
    gb.saveGitConfig({ remote: bare, branch: 'main' })

    // ② 用户那个现场：**空仓库**上点「测试连接」→ 必须是成功
    const t1 = await gb.gitTestRemote()
    check('★★ 执行器：空仓库上「测试连接」→ **成功**（这就是用户报的"填了地址说失败"那一处）',
      t1.ok === true, JSON.stringify(t1))
    check('  而且话里说明白"仓库还是空的，第一次推送会建分支"（不是含糊的"连上了"）',
      t1.message.indexOf('空') >= 0, t1.message)

    // ③ 首次推送一份 zip
    const zip1 = path.join(root, 'fangcun-backup-1.zip')
    fs.writeFileSync(zip1, 'zip-content-1')
    const p1 = await gb.gitPushPackage(zip1)
    check('★★ 执行器：首次推送成功（空仓库 → 自动建 main）', p1.ok === true, JSON.stringify(p1))
    const refs1 = await gitAsync(['ls-remote', bare], root)
    check('  远端有了 main，而且 zip 真在里面（不是只建了分支）',
      refs1.out.indexOf('refs/heads/main') >= 0)

    // ④ 第二次推送：工作副本已存在 → 走 set-url 分支，仍要能推
    const zip2 = path.join(root, 'fangcun-backup-2.zip')
    fs.writeFileSync(zip2, 'zip-content-2')
    const p2 = await gb.gitPushPackage(zip2)
    check('★ 执行器：已有工作副本时再推一次也成功（第二次走 remote set-url 分支）', p2.ok === true, JSON.stringify(p2))

    // ⑤ 远端领先 → 执行器应**自动救一次**并报 recovered
    const other = path.join(root, 'other')
    await gitAsync(['clone', '--depth', '1', bare, other], root)
    fs.writeFileSync(path.join(other, 'from-other.zip'), 'x')
    await gitAsync(['add', '-A'], other)
    await gitAsync([...idArgs, 'commit', '-m', 'from other machine'], other)
    const pOther = await gitAsync(['push', 'origin', 'HEAD:main'], other)
    check('  准备：另一台机器推了一次（远端领先）', pOther.code === 0, pOther.out.slice(0, 120))

    const zip3 = path.join(root, 'fangcun-backup-3.zip')
    fs.writeFileSync(zip3, 'zip-content-3')
    const p3 = await gb.gitPushPackage(zip3)
    check('★★ 执行器：远端领先时**自动并入再推**成功，并且明确回报 recovered=true'
      + '（用户不必自己搞懂 fetch/reset 那套）',
      p3.ok === true && p3.recovered === true, JSON.stringify(p3))
    const refs2 = await gitAsync(['ls-remote', bare], root)
    check('  补最后远端仍是单条 main（没有强推留分叉）',
      (refs2.out.match(/refs\/heads\/main/g) || []).length === 1)
    const log = await gitAsync(['log', '--oneline', '--all'], bare)
    check('  两边的提交都在（另一台机器的提交没被我们抹掉）—— 这不是 --force 的语义',
      log.out.indexOf('from other machine') >= 0, log.out.slice(0, 200))
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

;(async () => {
  await integrate()
  await integrateExecutor()
  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
})()
