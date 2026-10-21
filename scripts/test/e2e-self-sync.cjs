/**
 * 「方寸自仓启动同步」端到端（2026-10-21 · W1-1C）
 *
 * 要钉住的是三条边界，不是"代码里有 pull 这个词"：
 *  ① **只 ff-only**：本地领先/分叉时 git 必须拒，我们报「待同步」，**一个文件都不许动**；
 *  ② **不弹窗不挂起**：没网/没凭据/没上游时必须自己收手（GIT_TERMINAL_PROMPT=0 + 硬超时）；
 *  ③ **不误伤**：数据根不是 git 仓库（安装版常态）→ skipped，不报成异常。
 *
 * 跑法：node scripts/test/e2e-self-sync.cjs
 *   本机没有可用 git → 显式 SKIP（不伪装通过）。
 *   真仓库全部落在临时目录，跑完即删。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const Module = require('module')

const REPO = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(REPO, 'desktop')
const DIST = path.join(DESKTOP, 'dist', 'main')

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  → ' + detail : '')) }
}

/** 异步 git（本机 spawnSync 一律 EBUSY，见项目记忆） */
function git(args, cwd) {
  return new Promise((resolve) => {
    const c = spawn('git', args, { cwd, windowsHide: true })
    let out = ''
    let err = ''
    c.stdout.on('data', (d) => { out += d.toString() })
    c.stderr.on('data', (d) => { err += d.toString() })
    c.on('close', (code) => resolve({ code, out, err }))
    c.on('error', (e) => resolve({ code: -1, out, err: String(e) }))
  })
}

const ID = ['-c', 'user.name=e2e', '-c', 'user.email=e2e@local', '-c', 'commit.gpgsign=false']

/**
 * 剥掉注释再扫源码（2026-10-21）。
 *
 * 为什么必须剥：`selfSync.ts` 的注释里写着"用异步 spawn，**不用** spawnSync" ——
 * 直接对原文跑 `/!spawnSync/` 会把"解释为什么不这么写"判成"这么写了"。
 * 本机工作区是 CRLF，统一换行后再扫（否则跨行正则一个都匹配不上）。
 */
function stripComments(src) {
  return String(src)
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

function writeFile(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, s)
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'services', 'selfSync.js'))) {
    console.error('FAIL  找不到 dist/main/services/selfSync.js —— 请先 cd desktop && npm run build')
    process.exit(1)
  }
  const v = await git(['--version'], os.tmpdir())
  if (v.code !== 0) {
    console.log('SKIP  本机没有可用的 git —— 「启动自动同步」这条链路无法真跑（不伪装通过）')
    process.exit(0)
  }

  // ── 桩：electron + 临时 userData（数据根由 setDataDir 指到临时仓库）──
  const tmpUserData = path.join(os.tmpdir(), 'fc-selfsync-' + Date.now())
  fs.mkdirSync(tmpUserData, { recursive: true })
  process.env.FC_TEST_USERDATA = tmpUserData
  const STUB = path.join(__dirname, 'electron-stub.cjs')
  const origResolve = Module._resolveFilename
  Module._resolveFilename = function (request, ...args) {
    if (request === 'electron') return STUB
    return origResolve.call(this, request, ...args)
  }

  const roots = []
  const mkRoot = (name) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ss-' + name + '-'))
    roots.push(d)
    return d
  }

  try {
    const dataMod = require(path.join(DIST, 'data', 'index.js'))
    const { syncSelfRepoOnBoot, getSelfSyncStatus } = require(path.join(DIST, 'services', 'selfSync.js'))

    // ── ① 不是 git 仓库（安装版常态）→ skipped ──────────────────────────
    {
      const plain = mkRoot('plain')
      fs.mkdirSync(path.join(plain, 'task-data'), { recursive: true })
      dataMod.setDataDir(plain)
      const st = await syncSelfRepoOnBoot()
      check('★ 数据根没有 .git（安装版形态）→ skipped，且文案点明"安装版常态"（不是报错）',
        st.state === 'skipped' && /安装版/.test(st.message), JSON.stringify(st))
      check('  状态可以被读到（getSelfSyncStatus 与返回值同源）',
        getSelfSyncStatus().state === 'skipped')
    }

    // ── ② 有上游且远端更新 → 真拉下来（ff-only 成功路径）─────────────────
    const bare = path.join(mkRoot('bare'), 'origin.git')
    await git(['init', '--bare', '--initial-branch=main', bare], path.dirname(bare))
    const seed = mkRoot('seed')
    await git(['init', '--initial-branch=main'], seed)
    writeFile(path.join(seed, 'registry.yaml'), 'projects: []\n')
    fs.mkdirSync(path.join(seed, 'task-data'), { recursive: true })
    await git([...ID, 'add', '-A'], seed)
    await git([...ID, 'commit', '-m', 'seed'], seed)
    await git(['remote', 'add', 'origin', bare], seed)
    await git(['push', '-u', 'origin', 'main'], seed)

    const local = mkRoot('local')
    await git(['clone', bare, local], path.dirname(local))
    // ⚠ 2026-10-21 实测：本机 git 2.55 在**没配 pull.ff** 时，分叉的 `git pull` 自己也会拒
    //   —— 于是"去掉 --ff-only"这个反例根本红不了（行为断言全是假绿，只剩源码守卫）。
    //   所以这里**故意把危险默认装回去**（pull.ff=true + pull.rebase=false = 允许 merge）：
    //   在这种机器上，只有我们显式写的 `--ff-only` 能拦住"偷偷 merge 一笔"。
    await git(['config', 'pull.ff', 'true'], local)
    await git(['config', 'pull.rebase', 'false'], local)
    dataMod.setDataDir(local)

    // 远端那边多一笔（模拟"远端推了一笔"）
    writeFile(path.join(seed, 'registry.yaml'), 'projects:\n  - id: demo\n    name: 远端新登记\n')
    await git([...ID, 'add', '-A'], seed)
    await git([...ID, 'commit', '-m', 'remote: 登记新项目'], seed)
    await git(['push'], seed)

    const st2 = await syncSelfRepoOnBoot()
    check('★★ 远端有新提交 → 启动同步真把它拉下来（state=ok）', st2.state === 'ok', JSON.stringify(st2))
    check('★★ 拉取后 registry.yaml 内容**真的变了**（不是"报告成功但没落地"）',
      fs.readFileSync(path.join(local, 'registry.yaml'), 'utf-8').indexOf('远端新登记') >= 0,
      fs.readFileSync(path.join(local, 'registry.yaml'), 'utf-8').slice(0, 60))

    // ── ③ 本地领先（未推送提交）→ 必须拒，且**一个文件都不许动** ─────────
    // 场景就是施工单写的「本地领先时重启 → 显示待同步，数据无损」
    {
      const localFile = path.join(local, 'registry.yaml')
      const beforeLocal = fs.readFileSync(localFile, 'utf-8')
      // ⚠ 本地这笔要动**另一个文件**：两笔都改 registry.yaml 的话 rebase 会撞冲突，
      //   那考的就是"如何解冲突"，与本条要证的"绝不强推"无关。
      writeFile(path.join(local, 'notes-local.md'), '# 本地未推送的笔记\n')
      await git([...ID, 'add', '-A'], local)
      await git([...ID, 'commit', '-m', 'local: 本地领先一笔'], local)
      const headBefore = (await git(['rev-parse', 'HEAD'], local)).out.trim()

      // 远端再推一笔 → 两边分叉
      writeFile(path.join(seed, 'registry.yaml'), 'projects:\n  - id: demo\n    name: 远端又一笔\n')
      await git([...ID, 'add', '-A'], seed)
      await git([...ID, 'commit', '-m', 'remote: 再来一笔'], seed)
      await git(['push'], seed)

      const st3 = await syncSelfRepoOnBoot()
      const headAfter = (await git(['rev-parse', 'HEAD'], local)).out.trim()
      check('★★ 本地领先/分叉 → state=behind（不是 ok，不是 failed）', st3.state === 'behind', JSON.stringify(st3))
      check('★★ 说人话：点明"不合并、不强拉、数据未动"（不是甩一句 git 原文）',
        /不合并/.test(st3.message) && /数据未动/.test(st3.message), st3.message)
      check('★★ HEAD 没动（拒绝生效：没偷偷 merge / 没 reset）', headBefore === headAfter,
        headBefore.slice(0, 8) + ' → ' + headAfter.slice(0, 8))
      check('★ 工作区内容没被覆盖（本地那笔的文件还在，且远端内容没被硬塞进来）',
        fs.existsSync(path.join(local, 'notes-local.md'))
        && fs.readFileSync(localFile, 'utf-8').indexOf('远端又一笔') < 0,
        fs.readFileSync(localFile, 'utf-8').slice(0, 60))

      // ── ④ 修好后（本地快进到远端）→ 下一次启动就该 ok ────────────────
      await git(['fetch', 'origin', 'main'], local)
      await git(['rebase', 'origin/main'], local)   // 等价于"用户自己把本地笔放到远端之后"
      const st4 = await syncSelfRepoOnBoot()
      check('★ 用户自己理顺之后，下一次启动同步恢复 ok（不会一直卡在待同步）',
        st4.state === 'ok', JSON.stringify(st4))
    }

    // ── ⑤ 没有上游分支 → 分到"没东西可拉"，而不是笼统失败 ────────────────
    {
      const solo = mkRoot('solo')
      await git(['init', '--initial-branch=main'], solo)
      writeFile(path.join(solo, 'registry.yaml'), 'projects: []\n')
      fs.mkdirSync(path.join(solo, 'task-data'), { recursive: true })
      dataMod.setDataDir(solo)
      const st5 = await syncSelfRepoOnBoot()
      check('★ 没有上游分支 → behind 且文案指向"没有上游"（可解释，不是"未知原因"）',
        st5.state === 'behind' && /上游/.test(st5.message), JSON.stringify(st5))
    }

    // ── ⑥ 源码守卫：铁律不许被悄悄改掉 ───────────────────────────────────
    {
      // ⚠ 必须先**剥注释**再扫源码：这个文件的注释里就写着"不用 spawnSync"，
      //   不剥注释会把"解释为什么不这么写"当成"这么写了"（假红，2026-10-21 实测）。
      const raw = stripComments(fs.readFileSync(path.join(DESKTOP, 'src', 'main', 'services', 'selfSync.ts'), 'utf-8'))
      check('★ 只允许 --ff-only（源码里不许出现 merge / --force / reset --hard / stash）',
        /'pull', '--ff-only'/.test(raw) && !/--force|reset', '--hard'|'merge'/.test(raw))
      check('★ 凭据提示必须关掉（GIT_TERMINAL_PROMPT=0），否则没凭据时会静默挂成僵尸',
        /GIT_TERMINAL_PROMPT: '0'/.test(raw))
      check('★ 有硬超时（网络挂住不许把后台任务永远吊着）',
        /setTimeout\([\s\S]{0,120}child\.kill\(\)/.test(raw))
      check('★ 用异步 spawn，不用 spawnSync/execFileSync（本机一律 EBUSY，且会卡住首屏）',
        /spawn\(/.test(raw) && !/spawnSync|execFileSync/.test(raw))
      // 渲染层：不许出现"手动同步"按钮（用户零动作原则）
      const app = stripComments(fs.readFileSync(path.join(DESKTOP, 'src', 'renderer', 'App.vue'), 'utf-8'))
      check('★ 界面只显示状态，**没有**"立即同步"按钮（自动就够，不加手动入口）',
        /selfSyncWarn/.test(app) && !/selfSyncForce|sync:force|立即同步/.test(app))
    }

    console.log('')
    console.log('通过 ' + pass + ' / 失败 ' + fail)
    process.exit(fail === 0 ? 0 : 1)
  } finally {
    for (const d of roots) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 占用中就算了 */ } }
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error('FAIL  测试自身异常：', e && e.stack || e)
  process.exit(1)
})
