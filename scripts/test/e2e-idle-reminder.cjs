/**
 * 挂机提醒端到端测试（2026-10-17 四件补立项④）
 *
 * 覆盖 main/services/idleReminder.ts：
 *  - computeIdleAction 纯函数全表（关/未达阈/达阈/已通知静默/回来重置/阈值下限钳制）
 *  - readIdlePrefs（缺省 开+30min / 显式关 / 阈值非法回落 / 下限钳制）
 *  - 真轮询链路（powerMonitor 桩+短间隔）：达阈真弹系统通知（Notification 桩记录）、
 *    一次挂机只弹一次、回来重置后再挂再弹、关掉后零弹窗
 *
 * 运行：node scripts/test/e2e-idle-reminder.cjs（electron 桩注入，纯 node 直调 dist/main）
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

const TEST_ROOT = path.join(os.tmpdir(), 'fc-idle-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT
// 桩在 require 时把 userData 常量化——必须先设 env 再 require 桩（e2e-plans 同纪律）
const electron = require(STUB)

const DIST = path.resolve(__dirname, '../../desktop/dist/main')
const idle = require(path.join(DIST, 'services', 'idleReminder.js'))

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function writePrefs(obj) {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  fs.writeFileSync(path.join(TEST_ROOT, 'prefs.json'), JSON.stringify(obj))
}

function prefsFile() {
  try {
    return JSON.parse(fs.readFileSync(path.join(TEST_ROOT, 'prefs.json'), 'utf-8'))
  } catch { return {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const A = idle.computeIdleAction

try {
  // ── 1. computeIdleAction 纯函数 ──
  check('开关关掉不动作', A({ enabled: false, thresholdMin: 30, idleSeconds: 3600, alreadyNotified: false }) === null)
  check('未达阈不动作', A({ enabled: true, thresholdMin: 30, idleSeconds: 100, alreadyNotified: false }) === null)
  const n1 = A({ enabled: true, thresholdMin: 30, idleSeconds: 1801, alreadyNotified: false })
  check('达阈弹并报分钟', n1 && n1.kind === 'notify' && n1.idleMinutes === 30, JSON.stringify(n1))
  check('已通知静默', A({ enabled: true, thresholdMin: 30, idleSeconds: 3600, alreadyNotified: true }) === null)
  check('回来重置（通知过）', A({ enabled: true, thresholdMin: 30, idleSeconds: 0, alreadyNotified: true })?.kind === 'reset')
  check('回来不重复重置', A({ enabled: true, thresholdMin: 30, idleSeconds: 0, alreadyNotified: false }) === null)
  const clamped = A({ enabled: true, thresholdMin: 1, idleSeconds: 299, alreadyNotified: false })
  check('阈值误填 1 分钟被钳为下限 5（299s<5min 不弹）', clamped === null, JSON.stringify(clamped))

  // ── 2. readIdlePrefs ──
  writePrefs({})
  let rp = idle.readIdlePrefs()
  check('缺省=开+30min', rp.enabled === true && rp.thresholdMin === 30, JSON.stringify(rp))
  writePrefs({ idleReminder: { enabled: false, thresholdMin: 45 } })
  rp = idle.readIdlePrefs()
  check('显式关+阈值 45 读回', rp.enabled === false && rp.thresholdMin === 45, JSON.stringify(rp))
  writePrefs({ idleReminder: { enabled: true, thresholdMin: 0 } })
  rp = idle.readIdlePrefs()
  check('阈值 0 回落 30', rp.thresholdMin === 30, JSON.stringify(rp))
  writePrefs({ idleReminder: { enabled: true, thresholdMin: 2 } })
  rp = idle.readIdlePrefs()
  check('阈值 2 钳到下限 5', rp.thresholdMin === 5, JSON.stringify(rp))

  // ── 3. 真轮询（powerMonitor 桩+短间隔）──
  let firstShown = null   // 跨 then 闭包引用（作用域教训）
  let beforeShown = null
  writePrefs({ idleReminder: { enabled: true, thresholdMin: 5 } })  // 阈值 5min
  idle.startIdleReminder(40)
  check('启动后 0 秒空闲不弹', electron.Notification.lastShown === null)

  globalThis.__FC_IDLE_SEC = 301  // 5 分钟出头
  sleep(150).then(() => {         // 挨过 3 拍
    firstShown = electron.Notification.lastShown
    check('达阈真弹系统通知', firstShown && String(firstShown.title).includes('挂机提醒') && String(firstShown.body).includes('5 分钟'),
          JSON.stringify(firstShown))
    // 同一轮挂机再等几拍——不重复弹
    return sleep(150)
  }).then(() => {
    check('一次挂机只弹一次', electron.Notification.lastShown === firstShown)
    // 回来（空闲归零）→ 重置；再挂 → 再弹
    globalThis.__FC_IDLE_SEC = 0
    return sleep(120)
  }).then(() => {
    globalThis.__FC_IDLE_SEC = 301
    return sleep(140)
  }).then(() => {
    const second = electron.Notification.lastShown
    check('回来重置后再挂再弹', second && second !== firstShown && String(second.body).includes('5 分钟'),
          JSON.stringify(second))
    // 关掉 → 完全不弹
    writePrefs({ idleReminder: { enabled: false, thresholdMin: 5 } })
    beforeShown = electron.Notification.lastShown
    globalThis.__FC_IDLE_SEC = 0
    return sleep(120)
  }).then(() => {
    globalThis.__FC_IDLE_SEC = 3600
    return sleep(140)
  }).then(() => {
    check('关掉后挂机 1 小时也不弹', electron.Notification.lastShown === beforeShown, '')
    idle.stopIdleReminder()
    finish()
  }).catch((e) => { check('轮询链异常', false, String(e)); finish() })
} catch (e) {
  check('测试体异常', false, String(e))
  finish()
}

function finish() {
  console.log(`\n${'='.repeat(50)}\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('失败清单：')
    for (const name of failures) console.log(`  - ${name}`)
  }
  process.exit(fail ? 1 : 0)
}
