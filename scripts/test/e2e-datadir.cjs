#!/usr/bin/env node
/**
 * 数据根解析端到端测试（initPaths）
 *
 * 回归场景（2026-09-22 定位）：
 *   dev 态 `desktop/task-data` 是指向项目根真身的 **junction**。initPaths 曾把
 *   「该目录下存在 task-data」当作数据根标志 → 向上探测在 desktop/ 这一层就命中，
 *   DATA_DIR 锁死在 desktop/。后果：registry.yaml 找不到，notifications / todos /
 *   policies / backups 全落到 desktop/ 下（备份 manifest 的 dataDirLabel 已现 "desktop"），
 *   桌面版与 CLI 的数据根分叉。
 *
 * 修法：数据根标志里 registry.yaml 为强标志；task-data 必须用 **lstat** 判定为真实目录
 *      （不跟随链接），因此 junction 不再误导探测。
 *
 * 运行：node scripts/test/e2e-datadir.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')
const { execFileSync } = require('child_process')

// ── electron 桩注入（必须在业务模块之前） ────────────────────────────────
// 注意：桩的 app.getPath('exe') 取 process.cwd()，因此 chdir 后 exeDir 同步变化，
// 正合 dev 态的实况（electron . 的 cwd 就是 desktop/）。
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-datadir-'))
process.env.FC_TEST_USERDATA = path.join(TMP, 'userdata')

const DIST = path.resolve(__dirname, '../../desktop/dist/main')
const REPO = path.resolve(__dirname, '../..')

let pass = 0
let fail = 0

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
}

function section(t) {
  console.log('')
  console.log(`---- ${t} ----`)
}

const data = require(path.join(DIST, 'data', 'index.js'))
const origCwd = process.cwd()

try {
  // ── 夹具：<TMP>/monorepo/{registry.yaml, task-data/, desktop/} ─────────
  const MONO = path.join(TMP, 'monorepo')
  const DESK = path.join(MONO, 'desktop')
  fs.mkdirSync(path.join(MONO, 'task-data'), { recursive: true })
  fs.writeFileSync(path.join(MONO, 'registry.yaml'), 'projects:\n  - id: fixture\n', 'utf-8')
  fs.mkdirSync(DESK, { recursive: true })

  // ── 1. junction 误导探测（核心回归点）────────────────────────────────
  section('1. junction 不再被当作数据根')
  const junctionPath = path.join(DESK, 'task-data')
  fs.symlinkSync(path.join(MONO, 'task-data'), junctionPath, 'junction')
  check('夹具：desktop/task-data 是链接', fs.lstatSync(junctionPath).isSymbolicLink())

  process.chdir(DESK)
  data.initPaths()
  check('dev 态(cwd=desktop/) + junction → 数据根解析为项目根',
    data.getDataDir() === MONO, `实际 ${data.getDataDir()}`)
  check('  └ TASK_DIR 指向真实 task-data',
    data.getTaskDir() === path.join(MONO, 'task-data'), `实际 ${data.getTaskDir()}`)

  // ── 2. 未过度修正：真实目录仍被识别 ──────────────────────────────────
  section('2. 真实 task-data 目录仍被认作数据根')
  fs.unlinkSync(junctionPath)
  fs.mkdirSync(junctionPath)
  data.initPaths()
  check('嵌套的真实 task-data 目录 → 数据根为该层',
    data.getDataDir() === DESK, `实际 ${data.getDataDir()}`)

  // ── 3. 全无标记 → 回退 userData ─────────────────────────────────────
  section('3. 无任何标记时回退 userData')
  const BARE = path.join(TMP, 'bare')
  fs.mkdirSync(BARE, { recursive: true })
  process.chdir(BARE)
  data.initPaths()
  check('无 registry.yaml / task-data → 回退 userData',
    data.getDataDir() === process.env.FC_TEST_USERDATA, `实际 ${data.getDataDir()}`)

  // ── 4. 与 CLI 解析一致（MVP 条件：两边读同一份数据）──────────────────
  section('4. 桌面版与 CLI 指向同一份 task-data')
  process.chdir(REPO)
  data.initPaths()
  check('仓库根启动 → 数据根 = 仓库根',
    data.getDataDir() === REPO, `实际 ${data.getDataDir()}`)

  let cliTd = ''
  try {
    cliTd = execFileSync('python', ['-c', 'import tegula.core as c; print(c.TASK_DIR)'],
      { cwd: REPO, encoding: 'utf-8' }).trim()
  } catch (e) {
    cliTd = ''
  }
  if (cliTd) {
    check('桌面版 getTaskDir() === CLI core.TASK_DIR',
      data.getTaskDir() === cliTd, `桌面 ${data.getTaskDir()} vs CLI ${cliTd}`)
    check('  └ 指向的是仓库根下的 task-data',
      cliTd === path.join(REPO, 'task-data'), `CLI ${cliTd}`)
  } else {
    console.log('SKIP  CLI 对比（python 不可用）')
  }
} finally {
  process.chdir(origCwd)
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) { /* 清理失败不影响结论 */ }
}

console.log('')
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
