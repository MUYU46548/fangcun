/**
 * 许可闸的 IPC + 咽喉集成自检（2026-11-18）。
 *
 * 纯 Node 跑**编译产物**：用 electron-stub 截住 `ipcMain.handle`，
 * 真调 `license:status` / `license:ack`，再调 `chatDetailed` 证明
 * “未确认时连配置检查都轮不到”。不联网、不写真实数据根。
 *
 * 前提：`cd desktop && npm run build`。
 * 用法：node desktop/test/license-ipc.cjs
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const REPO = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(REPO, 'desktop')
const electronStub = path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-license-ipc-'))
const userData = path.join(tmp, 'userdata')
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(path.join(tmp, 'task-data'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'registry.yaml'), 'members: []\nprojects: []\n', 'utf-8')
process.env.FC_TEST_USERDATA = userData
delete process.env.FANGCUN_LICENSE_ACK

// 把主进程的 require('electron') 指到桩，并截获 ipcMain.handle
const handlers = {}
const stub = require(electronStub)
stub.ipcMain.handle = (channel, fn) => { handlers[channel] = fn }
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return electronStub
  return origResolve.call(this, request, ...args)
}

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name) }
  else { fail += 1; console.log('  [FAIL] ' + name + (detail ? '  → ' + String(detail).slice(0, 240) : '')) }
}

async function main() {
  try {
    const data = require(path.join(DESKTOP, 'dist/main/data/index.js'))
    data.setDataDir(tmp)
    const { registerLicenseIpcHandlers } = require(path.join(DESKTOP, 'dist/main/license-ipc.js'))
    registerLicenseIpcHandlers()

    console.log('\n【I1】IPC 面真的注册了')
    check('license:status 已注册', typeof handlers['license:status'] === 'function')
    check('license:ack 已注册', typeof handlers['license:ack'] === 'function')

    console.log('\n【I2】启动问状态：未确认')
    let st = await handlers['license:status']({})
    check('ok=true', st.ok === true, JSON.stringify(st))
    check('acked=false', st.acked === false, JSON.stringify(st))
    check('required 带版本/指纹', st.required && st.required.version && st.required.sha, JSON.stringify(st.required))

    console.log('\n【I3】点同意：落盘 + 回读 acked')
    const ack = await handlers['license:ack']({})
    check('ack ok=true', ack.ok === true, JSON.stringify(ack))
    check('ack.acked=true', ack.acked === true, JSON.stringify(ack))
    check('文件落在 config/license_ack.json',
      fs.existsSync(path.join(tmp, 'config', 'license_ack.json')))
    st = await handlers['license:status']({})
    check('再问已 acked', st.acked === true, JSON.stringify(st))
    check('确认时间是服务端给的', !!(st.ack && st.ack.at), JSON.stringify(st.ack))

    console.log('\n【I4】咽喉：未确认时 chatDetailed 先抛许可错误（配置检查之前）')
    const lic = require(path.join(DESKTOP, 'dist/main/license.js'))
    lic.clear(tmp)
    const chat = require(path.join(DESKTOP, 'dist/main/llm/chat.js'))
    let err = ''
    try { await chat.chatDetailed('hi') } catch (e) { err = String(e && e.message) }
    check('抛的是许可拒绝', /未确认许可协议/.test(err), err)
    check('不是“未配置 API Key”', !/未配置 API Key/.test(err), err)

    console.log('\n【I4b】降级链：未确认时直接回人话，不去试三条通道')
    const fb = require(path.join(DESKTOP, 'dist/main/llm/fallback.js'))
    const fr = await fb.chatWithFallback('hi')
    check('ok=false', fr.ok === false, JSON.stringify(fr))
    check('error 是许可拒绝', /未确认许可协议/.test(String(fr.error)), fr.error)
    check('没有尝试任何通道', Array.isArray(fr.attempts) && fr.attempts.length === 0, JSON.stringify(fr.attempts))

    console.log('\n【I5】签后放行：越过闸，才轮到配置错误（不联网）')
    await handlers['license:ack']({})
    err = ''
    try { await chat.chatDetailed('hi') } catch (e) { err = String(e && e.message) }
    check('已不再是许可错误', !/未确认许可协议/.test(err), err)
    check('到了配置检查（未配置 Key）', /未配置 API Key/.test(err), err)
  } finally {
    Module._resolveFilename = origResolve
    delete process.env.FC_TEST_USERDATA
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  console.log(`\nlicense-ipc: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
