#!/usr/bin/env node
/**
 * 开发态 Electron 启动器（带**主进程热重启**）
 *
 * 为什么必须要有它（2026-09-22，用户第 1/3 条的真因）：
 *   `npm run dev` 之前是 `wait-on … && electron .`：
 *     · 渲染层走 vite dev server —— 改源码立刻热更，**看起来"代码已生效"**
 *     · 主进程 / preload 只在启动时读一次 `dist/**`
 *   于是 tsc --watch 把新 dist 写出来了，**正在跑的 Electron 还用着内存里的旧代码**。
 *   表现极具欺骗性：新按钮出现了、新提示文案出现了（渲染层是新的），
 *   但新 IPC 通道不存在、新执行器不生效（主进程是旧的）——
 *     · 启动台 .bat 仍报 spawn EINVAL（旧执行器）
 *     · `window.tegula.applogOpenDir()` 直接 TypeError → 界面只说「打开日志目录失败」
 *   用户会以为"改了没用"，而其实只是**没重启**。
 *   叠加"关窗 ≠ 退出"（进程常驻托盘），这个坑已经反复吃过。
 *
 * 现在：监听 `dist/**`（排除 renderer，那是 vite 的事）→ 变更即重启 Electron。
 *
 * 用法：
 *   node scripts/dev-electron-watch.cjs            # 正常拉起
 *   node scripts/dev-electron-watch.cjs --dry      # 不启 Electron，用占位子进程验证重启逻辑
 *   OPEN_DEVTOOLS=1 node scripts/dev-electron-watch.cjs   # 透传 devtools
 */
const path = require('path')
const fs = require('fs')
const net = require('net')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const DESKTOP = path.join(ROOT, 'desktop')
const DIST = path.join(DESKTOP, 'dist')
const ENTRY = path.join(DIST, 'index.js')
const DRY = process.argv.includes('--dry')

const chokidar = require(path.join(DESKTOP, 'node_modules', 'chokidar'))

const log = (...a) => console.log('[dev-electron]', ...a)

function waitPort(port, timeoutMs = 60000) {
  // ⚠ 双栈探测（2026-09-22 事故）：vite 5 的 localhost 在部分环境只绑 [::1]
  //   （IPv6 回环），不监听 IPv4 127.0.0.1 —— 单探 127.0.0.1 会 ECONNREFUSED，
  //   60s 超时后 concurrently -k 全杀，npm run dev 整体启动失败。
  //   两个栈并行探，任一连通即就绪。
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      let remaining = 2
      let ok = false
      const done = (connected) => {
        if (ok) return
        remaining--
        if (connected) { ok = true; resolve(); return }
        if (remaining === 0) {
          if (Date.now() - t0 > timeoutMs) return reject(new Error(`等 ${port} 端口超时`))
          setTimeout(tick, 300)
        }
      }
      for (const host of ['127.0.0.1', '::1']) {
        const s = net.connect(port, host)
        s.once('connect', () => { s.destroy(); done(true) })
        s.once('error', () => { s.destroy(); done(false) })
      }
    }
    tick()
  })
}

function waitFile(p, timeoutMs = 120000) {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fs.existsSync(p)) return resolve()
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`等 ${p} 超时（tsc 还没编出来？）`))
      setTimeout(tick, 300)
    }
    tick()
  })
}

let child = null
let restarting = false

function startChild() {
  if (DRY) {
    child = spawn(process.execPath, ['-e', "console.log('child up pid=' + process.pid); setInterval(()=>{},1000)"], {
      stdio: 'inherit',
    })
  } else {
    const env = { ...process.env, NODE_ENV: 'development' }
    // ⚠ 必须删掉：带这个变量时 electron.exe 会退化成纯 Node，
    // require('electron') 拿到的是可执行文件路径字符串，报错面目全非。
    delete env.ELECTRON_RUN_AS_NODE
    const electronBin = require(path.join(DESKTOP, 'node_modules', 'electron'))
    child = spawn(electronBin, ['.'], { cwd: DESKTOP, stdio: 'inherit', env })
  }
  child.on('exit', (code, signal) => {
    if (restarting) return
    log(`Electron 退出（code=${code} signal=${signal}）—— 一并结束 dev 进程`)
    process.exit(code === null ? 0 : code)
  })
}

function restart(reason) {
  if (restarting) return
  restarting = true
  log(`检测到 ${reason} → 重启 Electron（主进程/preload 改完必须重启才生效）`)
  const old = child
  if (old && !old.killed) {
    try { old.kill() } catch { /* ignore */ }
  }
  setTimeout(() => {
    restarting = false
    startChild()
  }, 800)
}

async function main() {
  log(`等待 vite (5173) 与 ${path.relative(ROOT, ENTRY)} …`)
  if (!DRY) await waitPort(5173)   // dry 模式只验证重启逻辑，不等 vite
  await waitFile(ENTRY)
  log('依赖就绪，拉起 Electron' + (DRY ? '（dry 模式，用占位子进程代替）' : ''))
  startChild()

  const watcher = chokidar.watch([
    path.join(DIST, '**/*.js'),
    path.join(DIST, '**/*.json'),
  ], {
    ignored: [path.join(DIST, 'renderer', '**')], // 渲染层由 vite 负责
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  })
  watcher.on('change', (f) => restart(path.relative(ROOT, f)))
  watcher.on('add', (f) => restart(path.relative(ROOT, f)))
  log('已监听 dist/**（排除 dist/renderer）')

  const bye = () => {
    restarting = true // 别把主动退出当成崩溃
    try { child && child.kill() } catch { /* ignore */ }
    try { watcher.close() } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}

main().catch((e) => {
  log('启动失败：' + e.message)
  process.exit(1)
})
