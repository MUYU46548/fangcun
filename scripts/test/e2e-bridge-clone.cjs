/**
 * 回归：渲染层 → IPC 载荷过 contextBridge（2026-09-25「启动台第 6 次报修」真因）
 *
 * 为什么必须有这一套：
 *   该 bug 的表现是「点了完全没反应」，而且**主进程一条日志都没有** ——
 *   故障发生在渲染层的序列化阶段（页面参数搬进隔离世界那一跳），
 *   任何只测主进程执行器 / preload 的用例都抓不到它（前 6 次修复全栽在这）。
 *   这里用「真 Electron + 真 preload + 真 contextBridge」把这条路径钉死。
 *
 * 两组断言：
 *   ① 静态守卫 —— 对象列表的 v-for 元素被整只传进处理器、又整只当 IPC 载荷时必须过 toPlain()。
 *      （历史上就是这么翻车的：launchpadApps 的元素直接塞进 launchpadLaunchApp）
 *   ② 行为测试 —— 真开一个 Electron，真 preload，页面里传真 Proxy，看主进程收不收得到。
 */
const path = require('path')
const fs = require('fs')

const R = path.join(__dirname, '../..')
const ELECTRON = path.join(R, 'desktop/node_modules/electron/dist/electron.exe')
const PRELOAD = path.join(R, 'desktop/dist/preload/index.js')
const SHARED_PLAIN = path.join(R, 'desktop/dist/shared/plain.js')
const APP_VUE = path.join(R, 'desktop/src/renderer/App.vue')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail) {
  if (cond) { pass++; return }
  fail++; failures.push(name + (detail ? '  [' + detail + ']' : ''))
}
function report() {
  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) { console.log('\n失败项：'); for (const f of failures) console.log(' -', f) }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

// ── ① 静态守卫（精确规则，零误报）────────────────────────────────────────
/**
 * 扫描思路：
 *   1) 找出「持有对象数组」的 ref（ref<string[]> 这类原始值列表天然安全，跳过）
 *   2) 找 v-for="X in 该列表" —— X 是响应式代理
 *   3) 模板里若把 X **整只**传给某个处理器（f(app) / f(app, ...)），记下处理器名
 *   4) 到该处理器的函数体内找 window.tegula.*(X) —— 整只当载荷，必须写成 toPlain(X)
 * 只走这条真路径，所以不会把 `f(t.id)`（字符串）或本地同名变量误判成问题。
 */
function scanBridgePayloads(src) {
  const offenders = []
  // 1) ref<...[]> 且泛型不是原始值列表
  const listRe = /const\s+(\w+)\s*=\s*ref<([^>]*)\[\]>\(\[\]\)/g
  const objectLists = new Set()
  let m
  while ((m = listRe.exec(src))) {
    const generic = m[2].trim().toLowerCase()
    if (generic === 'string' || generic === 'number' || generic === 'boolean') continue
    objectLists.add(m[1])
  }
  for (const list of objectLists) {
    // 2) v-for="X in list"
    const vforRe = new RegExp(`v-for="\\s*(\\w+)\\s*(?:,\\s*\\w+\\s*)?in\\s*${list}\\b[^"]*"`, 'g')
    const vars = new Set()
    while ((m = vforRe.exec(src))) vars.add(m[1])
    for (const v of vars) {
      // 3) 模板里 X 被整只传给处理器
      const handlerRe = new RegExp(`(\\w+)\\(\\s*${v}\\s*[,)]`, 'g')
      const handlers = new Set()
      while ((m = handlerRe.exec(src))) handlers.add(m[1])
      for (const h of handlers) {
        // 4) 该处理器（顶格 function）的函数体
        const fnRe = new RegExp(`^(?:async\\s+)?function\\s+${h}\\s*\\(`, 'm')
        const fi = src.search(fnRe)
        if (fi < 0) continue
        const rest = src.slice(fi + 1)
        const bodyEnd = rest.search(/^\}/m)
        const body = bodyEnd < 0 ? rest : rest.slice(0, bodyEnd)
        const callRe = new RegExp(`window\\.tegula\\.(\\w+)\\(\\s*${v}\\s*[,)]`, 'g')
        let c
        while ((c = callRe.exec(body))) {
          offenders.push(`${h} → window.tegula.${c[1]}(${v})`)
        }
      }
    }
  }
  return offenders
}

;(function staticGuard() {
  const src = fs.readFileSync(APP_VUE, 'utf8')
  check('静态守卫：能识别出「对象列表的 v-for 元素」这条路径（非空转）',
    /launchpadApps/.test(src) && scanBridgePayloads(src) !== null)
  check('静态守卫：整只当 IPC 载荷的响应式元素必经 toPlain()',
    scanBridgePayloads(src).length === 0, '未包装：' + scanBridgePayloads(src).join(' | '))

  // 红测：把修复退回去，守卫必须报出来（否则这条守卫是摆设）
  const regressed = src.replace('launchpadLaunchApp(toPlain(app))', 'launchpadLaunchApp(app)')
  check('静态守卫自证：退回旧写法时能抓到（红测）',
    scanBridgePayloads(regressed).length === 1, JSON.stringify(scanBridgePayloads(regressed)))
  check('源码：启动台启动点已用 toPlain', /launchpadLaunchApp\(toPlain\(app\)\)/.test(src))
  check('源码：已引入渲染层共享的 plain.ts', /from '\.\.\/shared\/plain'/.test(src))
})()

// ── ② 行为测试：真 Electron 走一遍 contextBridge ─────────────────────────
if (!fs.existsSync(ELECTRON) || !fs.existsSync(PRELOAD) || !fs.existsSync(SHARED_PLAIN)) {
  console.log('（Electron / 构建产物缺失，跳过行为部分）')
  report()
}
const scratch = process.env.TMPDIR || require('os').tmpdir()
const harness = path.join(scratch, 'e2e_bridge_clone_harness.cjs')
const plainSrc = fs.readFileSync(SHARED_PLAIN, 'utf8')
fs.writeFileSync(harness, `
const { app, BrowserWindow, ipcMain } = require('electron')
const PAY = []
ipcMain.handle('launchpad:launchApp', async (_e, cfg) => { PAY.push(cfg); return { ok: true, message: 'harness-ok' } })
app.commandLine.appendSwitch('disable-gpu')
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: {
    preload: ${JSON.stringify(PRELOAD.replace(/\\/g, '/'))}, contextIsolation: true, sandbox: false } })
  await w.loadURL('data:text/html,<h1>t</h1>')
  const res = await w.webContents.executeJavaScript(\`
    (async () => {
      const __m = { exports: {} };
      (function (module, exports) { ${plainSrc.replace(/`/g, '\\`')} })(__m, __m.exports);
      const toPlain = __m.exports.toPlain;
      const out = {};
      const base = { name: '司天', cmd: 'E:/Software/SiTian/SiTian.exe', path: 'E:/Software/SiTian/SiTian.exe', id: 's1' };
      const proxied = new Proxy({ ...base, name: '绒花墨坊' }, {});
      try { await window.tegula.launchpadLaunchApp(proxied); out.raw_proxy = 'no-throw'; }
      catch (e) { out.raw_proxy = String(e).slice(0, 60); }
      try { out.wrapped = await window.tegula.launchpadLaunchApp(toPlain(proxied)); }
      catch (e) { out.wrapped = 'THROW:' + String(e).slice(0, 60); }
      const nested = new Proxy({ projectId: 'p', mission: new Proxy({ name: '深层' }, {}) }, {});
      try { out.nested = await window.tegula.launchpadLaunchApp(toPlain(nested)); }
      catch (e) { out.nested = 'THROW:' + String(e).slice(0, 60); }
      out.plain = await window.tegula.launchpadLaunchApp(base);
      out.sameRef = toPlain(base) === base;
      return JSON.stringify(out);
    })()
  \`)
  console.log('PAGE ' + res)
  console.log('PAYLOAD ' + JSON.stringify(PAY))
  app.exit(0)
})
setTimeout(() => { console.log('TIMEOUT'); app.exit(2) }, 25000)
`, 'utf8')

const { execFileSync } = require('child_process')
let out = ''
try {
  out = execFileSync(ELECTRON, [harness], { cwd: path.join(R, 'desktop'), encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })
} catch (e) { out = (e.stdout || '') + (e.stderr || '') }
const page = (out.match(/PAGE (\{.*\})/) || [])[1]
const pay = (out.match(/PAYLOAD (\[.*\])/) || [])[1]
if (!page) {
  console.log('（Electron 未能运行，跳过行为部分：' + out.slice(0, 200).replace(/\n/g, ' ') + '）')
  report()
}
const p = JSON.parse(page)
const payloads = JSON.parse(pay)
check('危害在案：裸代理过 bridge 直接抛错（前 6 次修复的盲区）',
  typeof p.raw_proxy === 'string' && p.raw_proxy.includes('could not be cloned'), p.raw_proxy)
check('修复生效：toPlain(代理) 成功跨越 bridge', p.wrapped && p.wrapped.ok === true, JSON.stringify(p.wrapped))
check('载荷正确：主进程确实收到代理那一次的数据',
  payloads.some(x => x && x.name === '绒花墨坊' && x.id === 's1'), JSON.stringify(payloads))
check('嵌套代理：同样被剥离并通过', p.nested && p.nested.ok === true, JSON.stringify(p.nested))
check('载荷正确：嵌套数据保留',
  payloads.some(x => x && x.projectId === 'p' && x.mission && x.mission.name === '深层'))
check('无回归：裸对象照常通行', p.plain && p.plain.ok === true)
check('零开销：裸对象 toPlain 返回同一引用', p.sameRef === true)
report()
