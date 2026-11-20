/**
 * 派单闸 e2e：**没有用户点击 → 不产生派单；真点一次 → 才产生一份**。
 *
 * 2026-11-19 · 卡「施工当前真点击 e2e：让 e2e-renderer 真开真点，SKIP 判失败」。
 *
 * 为什么单独一条命令：卡上的判据写的就是它 ——
 *   `node scripts/test/e2e-dispatch-click-only.cjs` 退出码 0
 * 它验两件事，缺一不可：
 *
 *   ① **运行时**（真 Electron + 真 DOM 点击，`FC_E2E_ONLY=dispatch` 只跑那 5 条）：
 *      启动后零点击 → `dispatchDsh` 调用数 0；打开项目详情但没点按钮 → 仍是 0；
 *      真点「发送给 DSH」→ 才 1 次（demo / kind=work）。不碰真实 `.dispatch-dsh/`。
 *   ② **静态**（源码守卫）：渲染层里对派单通道的**调用**只许出现在
 *      `App.vue` 的 `dispatchToDsh` 函数体里，且那个函数只许被模板的 `@click` 引用。
 *      脚本里任何别的地方出现 `dispatchToDsh(` / `dispatchDsh(` 都判失败 ——
 *      那正是"没人点也会派单"的形态（onMounted / watch / 定时器里顺手派一单）。
 *
 * ⚠ 失败即非零退出；**SKIP 不是通过**（与 e2e-renderer 同一口径）。
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

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

// ── 一、静态守卫：渲染层不许有"无人点击"的派单调用点 ────────────────────
const RENDERER = path.join(DESKTOP, 'src', 'renderer')
const REF = /dispatch(?:ToDsh|Dsh)/

const files = []
;(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(vue|ts)$/.test(e.name)) files.push(p)
  }
})(RENDERER)

let templateSites = 0
const badSites = []
let sawDefinition = false
let sawChannelCall = false

for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  const src = fs.readFileSync(f, 'utf8')
  // SFC 里 <template> 在前、<script> 在后；按最后一个 `<script` 切。
  const scriptAt = src.lastIndexOf('\n<script')
  const tpl = scriptAt >= 0 ? src.slice(0, scriptAt) : src
  const script = scriptAt >= 0 ? src.slice(scriptAt) : ''

  // ① 模板里：派单引用必须挂在 @click 上（"用户点才派"的唯一合法形态）
  tpl.split('\n').forEach((line, i) => {
    if (!REF.test(line)) return
    templateSites++
    if (!/@click/.test(line)) badSites.push(`${rel}:${i + 1} 模板里出现派单引用，但不在 @click 上`)
  })

  // ② 脚本里：只有 App.vue 的定义体是合法区；其余出现"调用"都判失败
  let defStart = -1
  let defEnd = -1
  if (rel.endsWith('/renderer/App.vue')) {
    defStart = script.indexOf('async function dispatchToDsh(')
    if (defStart >= 0) {
      // ⚠ 本仓是 CRLF（Windows 工作区）：只找 '\n}\n' 会永远落空，
      // 回落成 script.length 后 "函数体" = 文件剩余全部 → 守卫变味。
      const tail = script.slice(defStart).search(/\r?\n\}\r?\n/)
      defEnd = tail >= 0 ? defStart + tail + 3 : script.length
      sawDefinition = true
      const body = script.slice(defStart, defEnd)
      // 源码守卫先剥注释再扫（注释里写"不 spawn"是解释，不是调用）
      const code = body.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
      sawChannelCall = /tegula\.dispatchDsh\s*\(/.test(code)
      check('静态守卫 · 派单函数体确实调用主进程通道 tegula.dispatchDsh', sawChannelCall)
      check('静态守卫 · 派单函数体不 spawn / exec 进程（只落文件，不拉起会话）',
        !/child_process|spawn\s*\(|exec\s*\(/.test(code))
    }
    let off = 0
    script.split('\n').forEach((line, i) => {
      const lineStart = off
      off += line.length + 1
      if (!REF.test(line)) return
      if (lineStart >= defStart && lineStart <= defEnd) return // 定义体内部
      // setup 暴露（`... dispatchToDsh, ...`）：不是调用，允许
      if (!/dispatchToDsh\s*[.(]/.test(line)) return
      badSites.push(`${rel}:${i + 1} 脚本里出现派单调用（定义/暴露之外）→ 可能无人点击就派单`)
    })
  } else {
    script.split('\n').forEach((line, i) => {
      if (REF.test(line)) badSites.push(`${rel}:${i + 1} 渲染层脚本里直接引用派单通道`)
    })
  }
}

check('静态守卫 · 找到了派单函数定义（否则本守卫是空转）', sawDefinition)
check('静态守卫 · 模板里至少有一处 @click 派单入口（否则守卫是空转）', templateSites >= 1, 'sites=' + templateSites)
check('静态守卫 · 没有任何"无人点击"的派单调用点', badSites.length === 0, badSites.join(' | '))

const preloadSrc = fs.readFileSync(path.join(DESKTOP, 'test', 'renderer-preload.cjs'), 'utf8')
check('静态守卫 · 假 preload 记账 dispatchDsh（运行时断言才不是纸面事实）', /rec\('dispatchDsh'/.test(preloadSrc))

// 2026-11-20：花钱动作的视觉提示（不是只写在文案里）
const projSrc = fs.readFileSync(path.join(RENDERER, 'views', 'ProjectsView.vue'), 'utf8')
check('静态守卫 · 两个 DSH 花钱按钮都带 data-cost（金色 ¥ 角标靠它生效）',
  (projSrc.match(/data-cost/g) || []).length >= 2,
  `出现 ${(projSrc.match(/data-cost/g) || []).length} 次`)
const cssSrc = fs.readFileSync(path.join(DESKTOP, 'src', 'renderer', 'styles', 'app.css'), 'utf8')
check('静态守卫 · app.css 有 button[data-cost] 的描边 + ¥ 角标规则',
  /button\[data-cost\]/.test(cssSrc) && /button\[data-cost\]::after/.test(cssSrc))

const mainSrc = fs.readFileSync(MAIN, 'utf8')
check('静态守卫 · renderer-main 同时有「零点击不派单」与「真点一次才派单」两条断言',
  /启动后零点击/.test(mainSrc) && /真点一次「发送给 DSH」/.test(mainSrc))

if (fail) {
  console.log(`\n静态守卫失败 ${fail} 条 —— 不进入运行时。`)
  process.exit(1)
}

// ── 二、运行时：真 Electron，零点击 → 0 次；真点一次 → 1 次 ───────────────
if (!fs.existsSync(ELECTRON)) {
  console.log('FAIL  找不到 electron 可执行文件:', ELECTRON)
  process.exit(1)
}
if (!fs.existsSync(INDEX)) {
  console.log('FAIL  找不到渲染层构建产物:', INDEX, '—— 请先 npm run build')
  process.exit(1)
}

const args = ['--no-sandbox', '--disable-gpu', MAIN, '--hidden']
const env = { ...process.env, FC_E2E_RENDERER: '1', FC_E2E_ONLY: 'dispatch', FC_E2E_COST_CONFIRM: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(ELECTRON, args, { cwd: DESKTOP, stdio: ['ignore', 'pipe', 'pipe'], env })
let out = ''
child.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d) })
child.stderr.on('data', (d) => {
  const s = d.toString()
  out += s
  if (!/DevTools|GPU|gpu_|cache|Vulkan|ERROR:gpu/.test(s)) process.stdout.write(s)
})

child.on('close', (code) => {
  if (/RESULT SKIP/.test(out)) {
    console.log('\nFAIL  派单闸 e2e 被跳过：本机开不起来 ≠ 通过（SKIP 判失败）')
    process.exit(1)
  }
  const m = out.match(/RESULT (\d+) \/ (\d+)/)
  if (!m) {
    console.log('\nFAIL  派单闸 e2e 未产出结果（Electron 中途退出，退出码 ' + code + '）')
    console.log('      tail: ' + out.trim().split('\n').slice(-4).join(' ⏎ '))
    process.exit(1)
  }
  const c = out.match(/CLICKS (\d+)/)
  const clicks = c ? Number(c[1]) : -1
  const runtimeFail = Number(m[2])
  const runtimePass = Number(m[1])
  check('运行时 · 派单闸断言全过（' + runtimePass + ' 条）', runtimeFail === 0, 'fail=' + runtimeFail)
  check('运行时 · 真的点了 DOM（CLICKS > 0）', clicks > 0, 'clicks=' + (clicks < 0 ? '缺失' : clicks))

  console.log(`\n派单闸 e2e 汇总：${pass} / ${fail} · 真点击 ${clicks < 0 ? '缺失' : clicks} 次`)
  if (fail) {
    console.log('\n失败项：')
    for (const f of failures) console.log(' -', f)
  }
  process.exit(fail ? 1 : 0)
})

setTimeout(() => {
  console.log('FAIL  派单闸 e2e 超时（90s）')
  try { child.kill() } catch { /* ignore */ }
  process.exit(1)
}, 90000)
