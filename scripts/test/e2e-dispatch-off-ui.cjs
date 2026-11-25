/**
 * 派单总闸「默认关」· 真点击 e2e（2026-11-21 · 卡 `…闸要下在-e4264e6c`）
 *
 * 为什么单独一条：主进程模块测试只证明"写不出派单文件"，用户真正看到的是
 * **三个入口有没有置灰、有没有写明为什么**。这条用真 Electron + 真 DOM：
 *
 *   ① 假 preload 以 `FC_E2E_DISPATCH_OFF=1` 返回 `enabled:false`（与全新安装同形）；
 *   ② 项目页两个派单按钮 → 文案「未启用 DSH 派单」+ disabled + title 指向设置页；
 *   ③ 日志页「发送给 DSH」同样禁用（不能留第二条路）；
 *   ④ 设置 → Agent → DSH 派单：四项可见、启用未勾、数值是默认 30/3/1；
 *      点「保存派单设置」真走 `dispatchSettingsSet`。
 *
 * ⚠ SKIP / 中途退出都判失败（与 `e2e-dispatch-click-only.cjs` 同一口径）。
 *
 * 运行：`node scripts/test/e2e-dispatch-off-ui.cjs`（需先 `npm run build`）
 */
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(ROOT, 'desktop')
const ELECTRON = path.join(DESKTOP, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron')
const INDEX = path.join(DESKTOP, 'dist', 'renderer', 'index.html')
const MAIN = path.join(DESKTOP, 'test', 'renderer-main.cjs')
const PRELOAD = path.join(DESKTOP, 'test', 'renderer-preload.cjs')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

// ── 一、静态守卫：这条 e2e 的两个前提真的写着（否则运行时是空转）──────────
const preloadSrc = fs.readFileSync(PRELOAD, 'utf8')
check('★ 假 preload 认得 FC_E2E_DISPATCH_OFF（能造出"全新安装"）',
  /FC_E2E_DISPATCH_OFF/.test(preloadSrc))
check('★ 假 preload 在关闭态返回 enabled:false / reason:disabled',
  /enabled:\s*false/.test(preloadSrc) && /reason:\s*'disabled'/.test(preloadSrc))
const mainSrc = fs.readFileSync(MAIN, 'utf8')
check('★ renderer-main 有 dispatch-off 场景分支', /FC_E2E_ONLY === 'dispatch-off'/.test(mainSrc))
check('★ renderer-main 的关闭场景真的检查三个入口 + 设置页四项',
  /未启用 DSH 派单/.test(mainSrc) && /DSH 派单（花费会话）/.test(mainSrc) && /dispatchSettingsSet/.test(mainSrc))

if (fail) {
  console.log(`\n静态守卫失败 ${fail} 条 —— 不进入运行时。`)
  process.exit(1)
}

// ── 二、运行时：真 Electron + 真点击 ────────────────────────────────────
if (!fs.existsSync(ELECTRON)) {
  console.log('FAIL  找不到 electron 可执行文件:', ELECTRON)
  process.exit(1)
}
if (!fs.existsSync(INDEX)) {
  console.log('FAIL  找不到渲染层构建产物:', INDEX, '—— 请先 npm run build')
  process.exit(1)
}

const args = ['--no-sandbox', '--disable-gpu', MAIN, '--hidden']
const env = {
  ...process.env,
  FC_E2E_RENDERER: '1',
  FC_E2E_ONLY: 'dispatch-off',
  FC_E2E_DISPATCH_OFF: '1',
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
}
delete env.ELECTRON_RUN_AS_NODE

// 2026-11-25：windowsHide —— 无控制台的父进程下会闪一个黑窗（暮雨实测）。
// 对 GUI 程序它只抑制控制台分配，不影响 Electron 自己的窗口。
const child = spawn(ELECTRON, args, { cwd: DESKTOP, stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true })
let out = ''
child.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d) })
child.stderr.on('data', (d) => {
  const s = d.toString()
  out += s
  if (!/DevTools|GPU|gpu_|cache|Vulkan|ERROR:gpu/.test(s)) process.stdout.write(s)
})

child.on('close', (code) => {
  if (/RESULT SKIP/.test(out)) {
    console.log('\nFAIL  默认关 e2e 被跳过：本机开不起来 ≠ 通过（SKIP 判失败）')
    process.exit(1)
  }
  const m = out.match(/RESULT (\d+) \/ (\d+)/)
  if (!m) {
    console.log('\nFAIL  默认关 e2e 未产出结果（Electron 中途退出，退出码 ' + code + '）')
    console.log('      tail: ' + out.trim().split('\n').slice(-4).join(' ⏎ '))
    process.exit(1)
  }
  const runtimeFail = Number(m[2])
  const runtimePass = Number(m[1])
  const c = out.match(/CLICKS (\d+)/)
  const clicks = c ? Number(c[1]) : -1
  check('运行时 · 默认关断言全过（' + runtimePass + ' 条）', runtimeFail === 0, 'fail=' + runtimeFail)
  check('运行时 · 真的点了 DOM（CLICKS > 0）', clicks > 0, 'clicks=' + (clicks < 0 ? '缺失' : clicks))

  console.log(`\n默认关 e2e 汇总：${pass} / ${fail} · 真点击 ${clicks < 0 ? '缺失' : clicks} 次`)
  if (fail) {
    console.log('\n失败项：')
    for (const f of failures) console.log(' - ' + f)
  }
  process.exit(fail ? 1 : 0)
})

setTimeout(() => {
  console.log('FAIL  默认关 e2e 超时（90s）')
  try { child.kill() } catch { /* ignore */ }
  process.exit(1)
}, 90000)
