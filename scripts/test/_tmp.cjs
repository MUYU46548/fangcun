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
 * 清理走 `process.on('exit')`：watchdog / 断言失败 / `process.exit(1)` 都会触发
 * （`finally` 不会 —— 11-05 那次渲染 profile 泄漏就是只写了 finally）。
 * 被 SIGKILL 之类硬杀时确实清不到，那种残留交给 `clean-fc-cdp.ps1` 的每日兜底。
 *
 * ⚠ 不要在清理里 `process.exit()` 或打印：exit 钩子里抛错会盖掉真实退出码。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

/** 本进程建过的临时目录（清理按后进先出，父目录先建的话先删子目录） */
const DIRS = []

function rmrfQuiet(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 }) } catch { /* 删不掉留给每日兜底 */ }
}

/** 建一个临时目录，进程退出时自动删 */
function mkTmp(prefix = 'fc-tmp-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  DIRS.push(d)
  return d
}

/** 固定名字的临时路径（不带随机后缀；用来替 `mkTmpPath('fc-x-')`） */
function mkTmpPath(prefix = 'fc-tmp-') {
  const d = path.join(os.tmpdir(), prefix + Date.now())
  fs.mkdirSync(d, { recursive: true })
  DIRS.push(d)
  return d
}

/** 手动提前清理（测试自己已经删过的目录，这里再删一次是幂等的） */
function dropTmp(d) {
  const i = DIRS.indexOf(d)
  if (i >= 0) DIRS.splice(i, 1)
  rmrfQuiet(d)
}

process.on('exit', () => {
  for (let i = DIRS.length - 1; i >= 0; i--) rmrfQuiet(DIRS[i])
})

module.exports = { mkTmp, mkTmpPath, dropTmp }
