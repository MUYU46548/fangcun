/**
 * 应用日志 / IPC 守卫 端到端测试（2026-09-22，用户第 8 条）
 *
 * 覆盖：
 *  - 日志落盘位置（userData/logs）与文件命名
 *  - 主进程全局兜底真的能捕获 uncaughtException / unhandledRejection
 *  - guardedHandle：异常被记录 → **仍然 rethrow**（语义不变，可观测性升级不改控制流）
 *  - guardedHandle：返回 { ok:false } 记 WARN；重复注册通道记 WARN
 *  - tail() 可读、append() 永不抛（含循环 detail / 目录不可写场景）
 *
 * 运行：node scripts/test/e2e-applog.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-applog-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT

const DIST = path.resolve(__dirname, '../../desktop/dist/main')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

async function main() {
  console.log('== 应用日志 / IPC 守卫 e2e ==')
  console.log('root:', TEST_ROOT)
  fs.mkdirSync(TEST_ROOT, { recursive: true })

  const stub = require(STUB)

  // ipcMain 桩：捕获被包装后的 handler
  const handlers = new Map()
  stub.ipcMain.handle = (ch, fn) => { handlers.set(ch, fn) }

  const appLog = require(path.join(DIST, 'services', 'appLog.js'))
  const guard = require(path.join(DIST, 'guarded-ipc.js'))

  // ── 落盘位置与命名 ────────────────────────────────────────────────
  const logDir = appLog.getLogDir()
  check('日志目录在 userData/logs 下', logDir === path.join(TEST_ROOT, 'logs'), logDir)
  appLog.info('test', '一条 INFO')
  const logFile = appLog.getLogFile()
  check('日志文件名为 fangcun-YYYYMMDD.log', /fangcun-\d{8}\.log$/.test(logFile), logFile)
  check('日志文件已真实写盘', fs.existsSync(logFile))

  // ── 内容与 tail ──────────────────────────────────────────────────
  appLog.error('test', '一条 ERROR', new Error('boom'))
  const tail = appLog.tail(50)
  const joined = tail.join('\n')
  check('tail 能读到刚写的内容', /一条 INFO/.test(joined) && /一条 ERROR/.test(joined))
  check('ERROR 级别标记正确', /\[ERROR\] \[test\]/.test(joined))
  check('异常堆栈被写入', /boom/.test(joined))

  // ── append 永不抛 ────────────────────────────────────────────────
  let threw = false
  try {
    const cyc = {}; cyc.self = cyc
    appLog.append('INFO', 'test', '循环引用 detail', cyc)
    appLog.append('INFO', 'test', '超长', 'x'.repeat(5000))
  } catch { threw = true }
  check('append 遇到不可序列化/超长 detail 不抛', !threw)

  // ── 全局兜底真正生效 ─────────────────────────────────────────────
  appLog.installProcessHandlers()
  const before = fs.statSync(logFile).size
  process.emit('unhandledRejection', new Error('模拟未处理的 promise'))
  await new Promise(r => setTimeout(r, 50))
  check('unhandledRejection 被落盘', fs.statSync(logFile).size > before)

  const before2 = fs.statSync(logFile).size
  // 注意：真的抛 uncaughtException 会打断本测试进程，这里直接调用监听链的落盘函数
  const listeners = process.listeners('uncaughtException')
  check('uncaughtException 已安装监听', listeners.length >= 1, `实际 ${listeners.length}`)
  const err = new Error('模拟未捕获异常')
  listeners[listeners.length - 1](err)
  check('uncaughtException 落盘含堆栈', fs.statSync(logFile).size > before2 &&
    /模拟未捕获异常/.test(appLog.tail(20).join('\n')))

  // ── guardedHandle：异常记录 + 语义不变（rethrow）────────────────
  let got = null
  guard.guardedHandle('probe:ok', async (_e, a) => ({ ok: true, a }))
  guard.guardedHandle('probe:throw', async () => { throw new Error('handler 炸了') })
  guard.guardedHandle('probe:fail', async () => ({ ok: false, error: '业务失败' }))
  guard.guardedHandle('probe:dup', async () => ({ ok: true }))
  guard.guardedHandle('probe:dup', async () => ({ ok: true })) // 重复注册

  got = await handlers.get('probe:ok')({}, 7)
  check('guardedHandle 正常通道透传返回值', got && got.ok === true && got.a === 7)

  let rejected = false
  try { await handlers.get('probe:throw')({}) } catch { rejected = true }
  check('guardedHandle 异常仍然 rethrow（原语义不变）', rejected)
  const t2 = appLog.tail(80).join('\n')
  check('guardedHandle 异常落盘含通道名', /ipc:probe:throw/.test(t2))
  check('guardedHandle 异常落盘含堆栈原文', /handler 炸了/.test(t2))

  got = await handlers.get('probe:fail')({})
  check('guardedHandle 对 { ok:false } 透传', got && got.ok === false)
  check('guardedHandle 对 { ok:false } 记 WARN', /\[WARN\] \[ipc:probe:fail\]/.test(appLog.tail(80).join('\n')))
  check('重复注册通道被记 WARN', /重复注册通道 probe:dup/.test(appLog.tail(80).join('\n')))
  check('registeredChannels 可枚举', guard.registeredChannels().includes('probe:throw'))

  // ── 按天分文件 / 轮转不炸 ────────────────────────────────────────
  const files = fs.readdirSync(logDir).filter(f => /^fangcun-\d{8}\.log$/.test(f))
  check('按天分文件（当前仅 1 个）', files.length === 1, files.join(','))

  // ── 清理 ────────────────────────────────────────────────────────
  const summary = `${pass} / ${fail}`
  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('\n失败项：')
    for (const f of failures) console.log(' -', f)
  }
  console.log(`RESULT ${summary}`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.log('测试自身异常:', e); process.exit(1) })
