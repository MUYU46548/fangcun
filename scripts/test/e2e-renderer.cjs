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
// ⚠ `--no-sandbox` 不是可选项：受限/托管环境里 Chromium 沙箱会让渲染进程**无法加载任何页面**。
// 实测（2026-10-14 探针，见本文件提交说明）：不加 → 连一个极简本地 HTML 都 `ERR_FAILED (-2)`，
// 于是 e2e-renderer 长期恒 SKIP、真点击那层等于没验；加上 → loadFile / file:// / data: 全部正常，
// 整套真点击断言这才跑得起来。**仅测试运行器使用，不进打包产物**（打包入口是 desktop/src/index.ts）。
const args = ['--no-sandbox', '--disable-gpu', MAIN]
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
  // 2026-11-19（卡「施工当前真点击 e2e…」）：**SKIP 不再是"不算失败"**。
  // 理由：这一层是唯一能证明"按钮在、点下去有反应"的东西；它一跳过，
  // 上层所有"机器判据"就都是空转，而 SKIP 还退出 0 —— 假绿。
  // 起不来就是起不来：红，并说清怎么修（桌面会话 / npm run build / electron 可执行文件）。
  if (/RESULT SKIP/.test(out)) {
    console.log('\nFAIL  渲染层 e2e 被跳过：本机开不起来 ≠ 通过（SKIP 判失败）')
    console.log('      检查：① 是否在真实桌面会话里跑；② 是否已 npm run build；③ electron 可执行文件是否存在。')
    process.exit(1)
  }
  const m = out.match(/RESULT (\d+) \/ (\d+)/)
  if (!m) {
    // 没有 RESULT 行 = Electron 没跑到断言就没了（崩溃/被环境掐死）。
    // 这种情况**绝不能当成通过** —— 本项目吃过"假成功"的亏，宁可是噪声。
    console.log('\nFAIL  渲染层 e2e 未产出结果（Electron 中途退出，退出码 ' + code + '）')
    console.log('      tail: ' + out.trim().split('\n').slice(-4).join(' ⏎ '))
    process.exit(1)
  }
  // 真点击数：没有 `CLICKS n`，或 n == 0，都说明这次"只读了 DOM，没点"。
  // 那正是本套断言存在的意义（按钮在 ≠ 点得动），所以当失败处理。
  const c = out.match(/CLICKS (\d+)/)
  const clicks = c ? Number(c[1]) : -1
  if (clicks <= 0) {
    console.log('\nFAIL  渲染层 e2e 没有真点击（CLICKS ' + (clicks < 0 ? '缺失' : clicks) + '）')
    process.exit(1)
  }
  console.log(`\n渲染层 e2e 汇总：${m[1]} / ${m[2]} · 真点击 ${clicks} 次`)
  process.exit(code === null ? 1 : code)
})

// 兜底：卡死就超时失败，别把 CI 挂住
setTimeout(() => {
  console.log('FAIL  渲染层 e2e 超时（120s）')
  try { child.kill() } catch { /* ignore */ }
  process.exit(1)
}, 120000)
