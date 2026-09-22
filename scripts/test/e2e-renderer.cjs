/**
 * 渲染层 e2e 的运行器：用真实 Electron 拉起 dist/renderer，跑 renderer-main.cjs 的断言。
 *
 * 用法：node scripts/test/e2e-renderer.cjs [--show]
 *   --show  显示窗口（调试用；默认隐藏窗口静默跑）
 *
 * 退出码：有断言失败 → 1。
 * ⚠ 需要先 `npm run build`（读的是 desktop/dist/renderer）。
 */
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(ROOT, 'desktop')
const ELECTRON = path.join(DESKTOP, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron')
const INDEX = path.join(DESKTOP, 'dist', 'renderer', 'index.html')
// ⚠ 必须放在 desktop/ 下：Electron 主进程 require('electron') 从**文件所在目录**
// 向上找 node_modules，放 scripts/test 里会直接 MODULE_NOT_FOUND。
const MAIN = path.join(DESKTOP, 'test', 'renderer-main.cjs')

if (!fs.existsSync(ELECTRON)) {
  console.log('FAIL  找不到 electron 可执行文件:', ELECTRON)
  process.exit(1)
}
if (!fs.existsSync(INDEX)) {
  console.log('FAIL  找不到渲染层构建产物:', INDEX, '—— 请先 npm run build')
  process.exit(1)
}

const show = process.argv.includes('--show')
const args = ['--disable-gpu', MAIN]
if (!show) args.push('--hidden')

// ⚠ 必须抹掉 ELECTRON_RUN_AS_NODE：本环境（含 CI/沙箱）可能带这个变量，
// 一旦存在，electron.exe 会退化成纯 Node 跑 —— `require('electron')` 拿到的是
// 可执行文件路径字符串而不是 API，报错表现为 "Cannot read properties of undefined"。
const env = { ...process.env, FC_E2E_RENDERER: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(ELECTRON, args, {
  cwd: DESKTOP,
  stdio: ['ignore', 'pipe', 'pipe'],
  env,
})

let out = ''
child.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d) })
child.stderr.on('data', (d) => {
  const s = d.toString()
  out += s
  // Electron 的启动噪声（GPU/缓存告警）不算失败，但要能看到
  if (!/DevTools|GPU|gpu_|cache|Vulkan|ERROR:gpu/.test(s)) process.stdout.write(s)
})

child.on('close', (code) => {
  if (/RESULT SKIP/.test(out)) {
    console.log('\n渲染层 e2e 已跳过（环境无法加载页面）—— 不算失败，但也没验证到。')
    process.exit(0)
  }
  const m = out.match(/RESULT (\d+) \/ (\d+)/)
  if (!m) {
    // 没有 RESULT 行 = Electron 没跑到断言就没了（崩溃/被环境掐死）。
    // 这种情况**绝不能当成通过** —— 本项目吃过"假成功"的亏，宁可是噪声。
    console.log('\nFAIL  渲染层 e2e 未产出结果（Electron 中途退出，退出码 ' + code + '）')
    console.log('      tail: ' + out.trim().split('\n').slice(-4).join(' ⏎ '))
    process.exit(1)
  }
  console.log(`\n渲染层 e2e 汇总：${m[1]} / ${m[2]}`)
  process.exit(code === null ? 1 : code)
})

// 兜底：卡死就超时失败，别把 CI 挂住
setTimeout(() => {
  console.log('FAIL  渲染层 e2e 超时（120s）')
  try { child.kill() } catch { /* ignore */ }
  process.exit(1)
}, 120000)
