/**
 * 启动台执行器端到端测试（2026-09-22，用户第 7 条「启动失败」）
 *
 * 真实启动，不 mock：
 *  - .bat / .cmd 经 cmd.exe 真的被执行（写 marker 文件再断言文件存在）
 *  - 目录 / .lnk 走 shell.openPath（桩里记录调用）
 *  - 不存在的路径、空 cmd、非可执行扩展名 → 必须 ok:false 且**不产生未捕获异常**
 *  - URL 走 shell.openExternal
 *  - shell.openPath 返回错误串时必须 ok:false（旧实现无条件报成功）
 *
 * 运行：node scripts/test/e2e-launchpad.cjs
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

const TEST_ROOT = path.join(os.tmpdir(), 'fc-launch-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT
fs.mkdirSync(TEST_ROOT, { recursive: true })

const DIST = path.resolve(__dirname, '../../desktop/dist/main')

let pass = 0
let fail = 0
const failures = []
let uncaught = null

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

process.on('uncaughtException', (e) => { uncaught = e })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitForFile(p, timeout = 5000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (fs.existsSync(p)) return true
    await sleep(100)
  }
  return false
}

async function main() {
  console.log('== 启动台执行器 e2e ==')
  console.log('root:', TEST_ROOT)

  const stub = require(STUB)
  const launchpad = require(path.join(DIST, 'launchpad', 'index.js'))

  // ── 1. 不存在的路径 ────────────────────────────────────────────────
  let r = await launchpad.launchApp({ id: 'a', name: '不存在', path: '/no/such/app.exe', cmd: '/no/such/app.exe' })
  check('路径不存在 → ok:false', r.ok === false && /路径不存在/.test(r.message), JSON.stringify(r))

  // ── 2. 空配置 ─────────────────────────────────────────────────────
  r = await launchpad.launchApp({ id: 'b', name: '空', path: '', cmd: '' })
  check('空 cmd → ok:false', r.ok === false, JSON.stringify(r))

  // ── 3. 目录 → shell.openPath ──────────────────────────────────────
  const dir = path.join(TEST_ROOT, 'somedir')
  fs.mkdirSync(dir, { recursive: true })
  stub.shell.opened.length = 0
  r = await launchpad.launchApp({ id: 'c', name: '某目录', path: dir, cmd: dir })
  check('目录 → 走 shell.openPath 且 ok', r.ok === true && stub.shell.opened.includes(dir), JSON.stringify({ r, opened: stub.shell.opened }))

  // ── 4. .lnk → shell.openPath（ShellExecute 解快捷方式）──────────────
  const lnk = path.join(TEST_ROOT, 'demo.lnk')
  fs.writeFileSync(lnk, 'dummy')
  stub.shell.opened.length = 0
  r = await launchpad.launchApp({ id: 'd', name: '快捷方式', path: lnk, cmd: lnk })
  check('.lnk → 走 shell.openPath 且 ok', r.ok === true && stub.shell.opened.includes(lnk), JSON.stringify({ r, opened: stub.shell.opened }))

  // ── 5. shell.openPath 返回错误串时必须失败（旧实现无条件报成功）────
  stub.shell.failNext = '拒绝访问'
  r = await launchpad.openFolder(dir)
  check('openPath 报错 → ok:false 且带原因', r.ok === false && /拒绝访问/.test(r.message), JSON.stringify(r))

  // ── 6. .bat 真的被执行（用户报障的原型）───────────────────────────
  const batMarker = path.join(TEST_ROOT, 'bat-ran.txt')
  const bat = path.join(TEST_ROOT, 'run.bat')
  fs.writeFileSync(bat, `@echo off\r\necho bat-ok> "${batMarker}"\r\n`, 'utf-8')
  r = await launchpad.launchApp({ id: 'e', name: '批处理', path: bat, cmd: bat })
  const batRan = await waitForFile(batMarker)
  check('.bat 启动返回 ok:true', r.ok === true, JSON.stringify(r))
  check('.bat 真被执行（marker 文件已生成）', batRan)

  // ── 7. .cmd 同样走 cmd.exe ────────────────────────────────────────
  const cmdMarker = path.join(TEST_ROOT, 'cmd-ran.txt')
  const cmdFile = path.join(TEST_ROOT, 'run.cmd')
  fs.writeFileSync(cmdFile, `@echo off\r\necho cmd-ok> "${cmdMarker}"\r\n`, 'utf-8')
  r = await launchpad.launchApp({ id: 'f', name: '命令脚本', path: cmdFile, cmd: cmdFile })
  check('.cmd 真被执行（marker 文件已生成）', await waitForFile(cmdMarker), JSON.stringify(r))

  // ── 8. 带空格的路径（示例配置里就有 "E:/图书馆/ROSA" 这类）─────────
  const spaced = path.join(TEST_ROOT, 'with space')
  fs.mkdirSync(spaced, { recursive: true })
  const spacedMarker = path.join(TEST_ROOT, 'spaced-ran.txt')
  const spacedBat = path.join(spaced, 'run bat.bat')
  fs.writeFileSync(spacedBat, `@echo off\r\necho ok> "${spacedMarker}"\r\n`, 'utf-8')
  r = await launchpad.launchApp({ id: 'g', name: '带空格', path: spacedBat, cmd: spacedBat })
  check('含空格的 .bat 路径可启动', await waitForFile(spacedMarker), JSON.stringify(r))

  // ── 9. 不可执行文件 → ok:false，且不得产生未捕获异常 ────────────────
  const txt = path.join(TEST_ROOT, 'not-exec.txt')
  fs.writeFileSync(txt, 'hello')
  r = await launchpad.launchApp({ id: 'h', name: '文本', path: txt, cmd: txt })
  check('不可执行扩展名 → ok:false', r.ok === false, JSON.stringify(r))
  await sleep(600)
  check('子进程 error 事件被消费（无未捕获异常）', uncaught === null, uncaught ? String(uncaught.message) : '')

  // ── 11. .exe + 启动参数（2026-09-25）────────────────────────────────
  // ShellExecute 传不了参数 → 界面上的「启动参数」对 .exe 曾静默失效。
  // 用真 exe（把 cmd.exe 复制到临时目录当替身）验证：参数真的生效、cwd 真的是 exe 所在目录。
  {
    const appDir = path.join(TEST_ROOT, 'exedir')
    fs.mkdirSync(appDir, { recursive: true })
    const fakeExe = path.join(appDir, 'fake-app.exe')
    fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), fakeExe)

    // 无参数 .exe：2026-10-17 用户「点启动只出空壳窗口」后改的口径 ——
    // **不再由本方 CreateProcess，改让 explorer.exe 当中间人**（实测：从方寸进程树直接派生，
    // 子 Electron 应用 GPU 进程连崩 -1073741819，只剩空壳；explorer 代启动则正常）。
    // 这条不是"换个 API"，判据是**父进程到底是谁**，所以拦 spawn 断言参数。
    const cp = require('child_process')
    const origSpawn = cp.spawn
    const spawnCalls = []
    cp.spawn = function (file, args, opts) {
      spawnCalls.push({ file, args })
      return { on() { return this }, unref() { }, pid: 4242 }
    }
    stub.shell.opened.length = 0
    let r1
    try {
      r1 = await launchpad.launchApp({ id: 'x1', name: '无参数exe', path: fakeExe, cmd: fakeExe })
    } finally {
      cp.spawn = origSpawn
    }
    const viaExplorer = spawnCalls.find((c) => /explorer(\.exe)?$/i.test(String(c.file)) &&
      (c.args || []).some((a) => String(a).toLowerCase() === fakeExe.toLowerCase()))
    check('.exe 无参数 → 交给 explorer 代启动（不再由本方进程树派生）',
      r1.ok === true && !!viaExplorer, JSON.stringify({ r1, spawnCalls }))
    check('.exe 无参数 → 不再走 shell.openPath（那条路会继承父进程 job）',
      !stub.shell.opened.includes(fakeExe), JSON.stringify(stub.shell.opened))

    stub.shell.opened.length = 0
    const marker = path.join(appDir, 'cwd-marker.txt')
    const r2 = await launchpad.launchApp({
      id: 'x2', name: '带参数exe', path: fakeExe, cmd: fakeExe, args: ['/c', 'echo ok> cwd-marker.txt'],
    })
    check('.exe 带参数 → 不再走 shell.openPath（参数不再被静默丢弃）',
      !stub.shell.opened.includes(fakeExe), JSON.stringify({ r2, opened: stub.shell.opened }))
    check('.exe 带参数 → spawn 成功返回 ok', r2.ok === true, JSON.stringify(r2))
    await waitForFile(marker, 5000)
    check('.exe 带参数 → 参数生效且 cwd = exe 所在目录', fs.existsSync(marker), 'marker 未生成: ' + marker)
  }

  // ── 12. 启动后复查进程（2026-10-17）────────────────────────────────
  // 为什么必须真跑一次：`launchAndVerify` 的全部价值在于"看见了才说成功"。
  // 而 tasklist 的输出在 Node 里是**系统代码页字节**（中文映像名解出来是乱码），
  // 所以"按名字比对"会让复查永远失败 —— 那是"看着诚实、其实是坏的"提示。
  {
    const pids = await launchpad.listImagePids(path.basename(process.execPath))
    check('复查进程：按映像名能拿到 PID（含本进程）', pids.has(process.pid),
      `image=${path.basename(process.execPath)} got=${[...pids].join(',')} me=${process.pid}`)

    const none = await launchpad.listImagePids('no-such-image-' + Date.now() + '.exe')
    check('复查进程：查不到时返回空集而不是抛错/给假数据', none.size === 0, String(none.size))

    // 源码守卫：listImagePids 里不许再出现"按映像名比对"（中文名会因编码永远不相等）
    const src = require('fs').readFileSync(
      path.resolve(__dirname, '../../desktop/src/main/launchpad/executor.ts'), 'utf-8'
    ).replace(/\r\n/g, '\n')
    const fnBody = (/export function listImagePids[\s\S]*?\n}\n/.exec(src) || [''])[0]
    check('源码守卫：listImagePids 不做映像名比对（只信 /FI 的过滤结果）',
      fnBody.length > 0 && !/m\[1\]\.toLowerCase\(\)|name\.toLowerCase\(\)\s*===\s*image/.test(fnBody),
      fnBody.slice(0, 200))
  }

  // ── 10. URL ───────────────────────────────────────────────────────
  stub.shell.external.length = 0
  r = await launchpad.openUrl('https://example.com')
  check('URL → shell.openExternal', r.ok === true && stub.shell.external.includes('https://example.com'), JSON.stringify(r))
  r = await launchpad.openUrl('not a url')
  check('非法 URL → ok:false', r.ok === false, JSON.stringify(r))

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('\n失败项：')
    for (const f of failures) console.log(' -', f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.log('测试自身异常:', e); process.exit(1) })
