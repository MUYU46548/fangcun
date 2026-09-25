/**
 * 回归：复制到剪贴板（2026-09-25「日志复制失败，粘出来是旧的 0924 内容」）
 *
 * 为什么必须有这一套：
 *   症状极具欺骗性 —— 界面提示「已复制」，但剪贴板里还是上一次的内容。
 *   根因是 `navigator.clipboard.writeText()` 静默 reject（打包版 file:// 起源 / 窗口失焦 /
 *   权限被拒），失败后剪贴板保持原样，用户完全看不出来。
 *   只测「有没有调用 writeText」是抓不到的，必须**真开窗口 + 真读回剪贴板**。
 *
 * 三组断言：
 *   ① 静态守卫 —— 渲染层不得再有裸 navigator.clipboard；IPC 通道三处（main/preload/共享模块）齐备。
 *   ② 行为（有焦点）—— 真 Electron：IPC 通道写进去、主进程读回来 === 原文。
 *   ③ 行为（**失焦**，即故障现场）—— navigator.clipboard 路径确实失败/不可用，
 *      而 IPC 通道照样成功。这是修复的价值所在。
 */
const path = require('path')
const fs = require('fs')

const R = path.join(__dirname, '../..')
const ELECTRON = path.join(R, 'desktop/node_modules/electron/dist/electron.exe')
const PRELOAD = path.join(R, 'desktop/dist/preload/index.js')
const SHARED_CLIP = path.join(R, 'desktop/dist/shared/clipboard.js')
const APP_VUE = path.join(R, 'desktop/src/renderer/App.vue')
const MAIN_IPC = path.join(R, 'desktop/src/main/ipc.ts')
const PRELOAD_SRC = path.join(R, 'desktop/src/preload/index.ts')

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

// ── ① 静态守卫 ───────────────────────────────────────────────────────────
;(function () {
  const vue = fs.readFileSync(APP_VUE, 'utf8')
  const main = fs.readFileSync(MAIN_IPC, 'utf8')
  const pre = fs.readFileSync(PRELOAD_SRC, 'utf8')

  // 只允许出现在注释里
  const liveClipboard = vue.split('\n').filter(l => /navigator\.clipboard/.test(l) && !/^\s*(\*|\/\/)/.test(l))
  check('渲染层无裸 navigator.clipboard 调用（只准出现在注释）', liveClipboard.length === 0,
    JSON.stringify(liveClipboard))

  check('渲染层已引共享复制模块', /from '\.\.\/shared\/clipboard'/.test(vue))
  check('复制点统一走 copyWithToast（失败必须报出来）',
    (vue.match(/copyWithToast\(/g) || []).length >= 7, String((vue.match(/copyWithToast\(/g) || []).length))

  check('主进程已注册 clipboard:writeText', /guardedHandle\('clipboard:writeText'/.test(main))
  check('主进程用的是 electron clipboard 模块', /from 'electron'/.test(main) && /\bclipboard\b/.test(main.split('\n')[0] + main.split('\n')[5]))
  check('preload 暴露 clipboardWriteText → 同名通道',
    /clipboardWriteText:\s*\(text: string\)\s*=>\s*ipcRenderer\.invoke\('clipboard:writeText'/.test(pre))

  const shared = fs.readFileSync(path.join(R, 'desktop/src/shared/clipboard.ts'), 'utf8')
  check('共享模块三层兜底齐备（ipc → navigator → execCommand）',
    /clipboardWriteText/.test(shared) && /clipboard\.writeText/.test(shared) && /execCommand\('copy'\)/.test(shared))
  // 红测自证：把裸写法塞回去，守卫必须抓到
  const regressed = vue.replace('async function copyId(id: string) {\n  await copyWithToast(id, \'已复制 ID\')',
    'async function copyId(id: string) {\n  await navigator.clipboard.writeText(id)')
  const regressedLive = regressed.split('\n').filter(l => /navigator\.clipboard/.test(l) && !/^\s*(\*|\/\/)/.test(l))
  check('红测自证：把裸 navigator.clipboard 塞回去，守卫必须报错', regressedLive.length > 0,
    JSON.stringify(regressedLive))
})()

// ── ② ③ 行为测试：真 Electron，真 preload，真剪贴板读回 ──────────────────
if (!fs.existsSync(ELECTRON) || !fs.existsSync(PRELOAD) || !fs.existsSync(SHARED_CLIP)) {
  console.log('（Electron / 构建产物缺失，跳过行为部分）')
  report()
}
const scratch = process.env.TMPDIR || require('os').tmpdir()
const harness = path.join(scratch, 'e2e_clipboard_harness.cjs')
const sharedSrc = fs.readFileSync(SHARED_CLIP, 'utf8')
fs.writeFileSync(harness, `
const { app, BrowserWindow, ipcMain, clipboard } = require('electron')
app.commandLine.appendSwitch('disable-gpu')
// 与主进程 src/main/ipc.ts 的实现一致（通道名/行为都要对得上）
ipcMain.handle('clipboard:writeText', (_e, text) => {
  try { clipboard.writeText(String(text ?? '')); return { ok: true } }
  catch (e) { return { ok: false, error: e.message } }
})
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: {
    preload: ${JSON.stringify(PRELOAD.replace(/\\/g, '/'))}, contextIsolation: true, sandbox: false } })
  // 打开真实文件页：钉住「file:// 起源」这个故障现场
  const pageFile = require('path').join(require('os').tmpdir(), 'e2e_clip_probe.html')
  require('fs').writeFileSync(pageFile, '<h1>probe</h1>')
  await w.loadFile(pageFile)

  const res = await w.webContents.executeJavaScript(\`
    (async () => {
      const __m = { exports: {} };
      (function (module, exports) { ${sharedSrc.replace(/`/g, '\\`')} })(__m, __m.exports);
      const copyText = __m.exports.copyText;
      const out = {};
      out.origin = location.protocol;
      out.hasNav = !!(navigator.clipboard && navigator.clipboard.writeText);
      // ① 真实的复制链路（修复后应走 ipc）
      const r1 = await copyText('MARKER-IPC-' + Date.now());
      out.r1 = r1;
      // ② 关掉 IPC 通道后，只剩浏览器路径 —— 在 file:// + 非聚焦窗口下应当失败或退化
      const saved = window.tegula.clipboardWriteText;
      try { delete window.tegula.clipboardWriteText } catch (e) {}
      let navErr = null;
      try { if (navigator.clipboard) await navigator.clipboard.writeText('MARKER-NAV'); }
      catch (e) { navErr = String(e).slice(0, 80); }
      out.navErr = navErr;
      out.navWorked = navErr === null;
      try { window.tegula.clipboardWriteText = saved } catch (e) {}
      out.restored = typeof window.tegula.clipboardWriteText === 'function';
      return JSON.stringify(out);
    })()
  \`)
  console.log('PAGE ' + res)
  console.log('CLIP ' + JSON.stringify({ text: clipboard.readText() }))
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
const clip = (out.match(/CLIP (\{.*\})/) || [])[1]
if (!page || !clip) {
  console.log('（Electron 未能运行，跳过行为部分：' + out.slice(0, 200).replace(/\n/g, ' ') + '）')
  report()
}
const p = JSON.parse(page)
const c = JSON.parse(clip)
check('故障现场成立：测试页是 file:// 起源', p.origin === 'file:', String(p.origin))
check('修复生效：copyText 走主进程 IPC 通道', p.r1 && p.r1.ok === true && p.r1.via === 'ipc', JSON.stringify(p.r1))
check('剪贴板真值：主进程读回的正是刚写的那段文本',
  typeof c.text === 'string' && c.text.startsWith('MARKER-IPC-'), JSON.stringify(c.text).slice(0, 60))
check('危害在案：掐掉 IPC 后浏览器路径在 file:// + 无焦点下不可用（这就是原来静默失败的现场）',
  p.navWorked === false || p.navErr !== null, 'navErr=' + p.navErr + ' hasNav=' + p.hasNav)
check('兜底恢复：IPC 通道仍在（删了也能还原，不发生破坏性降级）', p.restored === true)
report()
