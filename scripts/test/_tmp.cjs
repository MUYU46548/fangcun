/**
 * 测试临时目录的**统一入口**（2026-11-06 暮雨：“持续往 C 盘塞垃圾文件”）。
 *
 * 真因不是浏览器 profile（那条 11-05 修过），是**每个 e2e 脚本各建一个
 * `os.tmpdir()/fc-xxx-<时间戳>` 目录、跑完不删**。本机实测：
 * 2956 个目录 / 2767MB —— 一次全量回归就能新增几十个，C 盘每天都在掉。
 *
 * 用法（替掉原来的 mkdtempSync）：
 *   const { mkTmp } = require('./_tmp.cjs')
 *   const TEST_ROOT = mkTmp('fc-logs-')          // 原写法：fs.mkdtempSync(path.join(os.tmpdir(), 'fc-logs-'))
 *   const TEST_ROOT = mkTmpPath('fc-drill-')     // 原写法：path.join(os.tmpdir(), 'fc-drill-' + Date.now())
 *
 * 2026-11-22 修（卡 task-20261106-002）：目录结构改成 `<tmp>/fc-x-xxx/root/`。
 * 原因：`checks/runner.ts` 用 `spawn(cmd, { cwd: root })` 跑 `cmd:` 判据，Windows 下
 * cmd.exe 以 root 为 cwd，**进程退出后句柄释放有延迟** → 进程 exit 钩子里删 root 会 EBUSY，
 * 异常又被旧代码 `catch {}` 吞掉，于是每次 e2e-checks 都留一个空目录。
 * 实测（2026-11-22）：把 root 降一层后，**删外层目录当场成功**（锁在 root 上，外层可删）。
 * 删不掉时**不再静默**：追加一行到 `%LOCALAPPDATA%\Maintenance\clean-fc-tmp.log`，
 * 交给每日兜底；下次跑测试时也能看见“哪个目录没删掉、为什么”。
 *
 * 清理走 `process.on('exit')`：watchdog / 断言失败 / `process.exit(1)` 都会触发
 * （`finally` 不会 —— 11-05 那次渲染 profile 泄漏就是只写了 finally）。
 * 被 SIGKILL 之类硬杀时确实清不到，那种残留交给每日兜底。
 *
 * ⚠ 不要在清理里 `process.exit()` 或打印：exit 钩子里抛错会盖掉真实退出码。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

/**
 * 临时根**不再放 C 盘**（2026-11-22）：放仓库同盘的 `.test-tmp/`（.gitignore）。
 * 理由：Windows 下 `checks/runner.ts` 用 cmd.exe 以测试根为 cwd 跑判据，句柄释放有延迟，
 * 进程 exit 钩子里删目录会 EBUSY（实测：即使把 root 降一层、删外层也仍 EBUSY）。
 * 与其和 Windows 抢删除，不如**一开始就不写 C 盘** —— 删不掉也只是 E 盘的一份残留，
 * 下次跑测试时由 sweepOld() 清掉。
 * 想换位置：`FC_TEST_TMP_BASE=<绝对路径>`。
 */
const REPO = path.resolve(__dirname, '..', '..')
const BASE = process.env.FC_TEST_TMP_BASE
  ? path.resolve(process.env.FC_TEST_TMP_BASE)
  : path.join(REPO, '.test-tmp')
fs.mkdirSync(BASE, { recursive: true })

/** 启动时扫一遍：删 24 小时前的旧残留（并发跑测试时不会误删新目录） */
function sweepOld() {
  let names = []
  try { names = fs.readdirSync(BASE) } catch { return }
  const cutoff = Date.now() - 24 * 3600 * 1000
  for (const n of names) {
    const p = path.join(BASE, n)
    try {
      const st = fs.statSync(p)
      if (st.mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
    } catch { /* 被占用/已删：留给下一次 */ }
  }
}
sweepOld()

/** 本进程建过的临时目录：{ outer, root }；root 是给测试用的那一层 */
const DIRS = []

/** 删目录；返回 null=成功，否则返回错误码/消息（不抛） */
function rmrfQuiet(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    return null
  } catch (e) {
    return e && (e.code || e.message) ? (e.code || e.message) : 'unknown'
  }
}

/** 删不掉时写一行账（不阻断退出） */
function logFailure(p, why) {
  try {
    const dir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Maintenance')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(
      path.join(dir, 'clean-fc-tmp.log'),
      `${new Date().toISOString()}\t${p}\t${why}\n`,
      'utf-8'
    )
  } catch { /* 连日志都写不了就只能放弃，但绝不假装删掉了 */ }
}

/** 建 `<base>/<prefix><suffix>/root/`，返回 root；清理时删 outer */
function make(prefix, fixedName) {
  const outer = fixedName
    ? path.join(BASE, prefix + Date.now())
    : fs.mkdtempSync(path.join(BASE, prefix))
  const root = path.join(outer, 'root')
  fs.mkdirSync(root, { recursive: true })
  DIRS.push({ outer, root })
  return root
}

/** 建一个临时目录，进程退出时自动删 */
function mkTmp(prefix = 'fc-tmp-') {
  return make(prefix, false)
}

/** 固定名字的临时路径（不带随机后缀；用来替 `mkTmpPath('fc-x-')`） */
function mkTmpPath(prefix = 'fc-tmp-') {
  return make(prefix, true)
}

/** 手动提前清理（传 root；删的是它的外层目录） */
function dropTmp(root) {
  const i = DIRS.findIndex((d) => d.root === root)
  if (i < 0) { rmrfQuiet(root); return }
  const { outer } = DIRS[i]
  DIRS.splice(i, 1)
  const why = rmrfQuiet(outer)
  if (why) logFailure(outer, why)
}

process.on('exit', () => {
  for (let i = DIRS.length - 1; i >= 0; i--) {
    const { outer } = DIRS[i]
    const why = rmrfQuiet(outer)
    if (why) logFailure(outer, why)
  }
})

module.exports = { mkTmp, mkTmpPath, dropTmp, BASE }
