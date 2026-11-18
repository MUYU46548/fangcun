/**
 * 许可协议总闸的Node侧自检（2026-11-18）。
 *
 * 判据在 `src/main/license.ts`：未确认不许调模型、同意落数据根、
 * 版本/正文指纹变化即失效、测试旁路如实标 bypass。
 * 另外钉住“咽喉真的接了闸”（chat/stream/ping 三处都调 assertLicensed）
 * 与“三处常量同源”（shared / Python / disclaimer 正文指纹）。
 *
 * 用法：先 `npm run build`，再 `node test/license-gate.cjs`
 */
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const { LICENSE_VERSION, LICENSE_CONTENT_SHA } = require(path.join(ROOT, 'dist/shared/license.js'))
const lic = require(path.join(ROOT, 'dist/main/license.js'))

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name) }
  else { fail += 1; console.log('  [FAIL] ' + name + (detail ? '  → ' + String(detail).slice(0, 240) : '')) }
}

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-license-'))
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  return dir
}

function main() {
  const root = tmpRoot()
  const oldBypass = process.env.FANGCUN_LICENSE_ACK
  delete process.env.FANGCUN_LICENSE_ACK
  try {
    console.log('\n【L1】未确认：state 必须是 false，assertLicensed 必须抛')
    let st = lic.state(root)
    check('acked=false', st.acked === false, JSON.stringify(st))
    check('bypass=false', st.bypass === false)
    let raised = ''
    try { lic.assertLicensed(root, '调用模型') } catch (e) { raised = String(e && e.message) }
    check('assertLicensed 抛错', !!raised)
    check('拒文指向桌面端 + 同意', raised.includes('桌面端') && raised.includes('同意'), raised)

    console.log('\n【L2】签字：落 config/license_ack.json，版本/指纹由服务端决定')
    const r = lic.record(root, 'gui')
    check('record 成功', r.ok === true, r.error)
    const file = path.join(root, 'config', 'license_ack.json')
    check('文件存在', fs.existsSync(file), file)
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'))
    check('版本 = shared', saved.version === LICENSE_VERSION, saved.version)
    check('指纹 = shared', saved.sha === LICENSE_CONTENT_SHA, saved.sha)
    check('带时间与来源', !!saved.at && saved.source === 'gui', JSON.stringify(saved))
    st = lic.state(root)
    check('签后 acked=true', st.acked === true, JSON.stringify(st))
    check('签后 assertLicensed 不抛', (() => { try { lic.assertLicensed(root); return true } catch { return false } })())

    console.log('\n【L3】条款改版：旧记录失效')
    const bad = { ...saved, version: '0.9' }
    fs.writeFileSync(file, JSON.stringify(bad), 'utf-8')
    st = lic.state(root)
    check('旧版本 → acked=false', st.acked === false, JSON.stringify(st))
    check('旧版本 → stale=true', st.stale === true)
    delete bad.version
    bad.version = LICENSE_VERSION
    bad.sha = '000000000000'
    fs.writeFileSync(file, JSON.stringify(bad), 'utf-8')
    check('指纹不符 → acked=false', lic.state(root).acked === false)

    console.log('\n【L4】测试旁路：只认 =1，且如实标 bypass')
    lic.clear(root)   // 先清掉 L3 留下的坏记录，旁路语义测的是“没签过也能开”
    process.env.FANGCUN_LICENSE_ACK = '0'
    check('=0 不生效', lic.state(root).acked === false)
    process.env.FANGCUN_LICENSE_ACK = '1'
    st = lic.state(root)
    check('=1 放行', st.acked === true)
    check('标记 bypass（不伪装成用户签过）', st.bypass === true)
    check('bypass 时 ack 记录仍为空', !st.ack, JSON.stringify(st.ack))
    // ⚠ 2026-11-18 补这条（真 bug 的回回归）：**数据根为空时 bypass 也必须优先**。
    //   原来 `state('')` 直接 return acked:false —— 于是测试环境（桩里 `getDataDir()`
    //   返回 undefined）设了 FANGCUN_LICENSE_ACK=1 也照样被拒，
    //   `e2e-llm-fallback` 的 10 条降级链断言全部变成"都在问同一件事"（实测就是这么红的）。
    //   判据：放行是**显式通道**，不该被"目录还没准备好"这种无关条件挡住。
    const emptyRoot = lic.state('')
    check('数据根为空 + bypass=1 → 仍然放行（bypass 优先于"目录未就绪"）',
      emptyRoot.acked === true && emptyRoot.bypass === true, JSON.stringify(emptyRoot))
    process.env.FANGCUN_LICENSE_ACK = '0'
    const emptyRootNoBypass = lic.state('')
    check('数据根为空 + bypass=0 → 仍然拒，且说清原因（不是空字符串）',
      emptyRootNoBypass.acked === false && String(emptyRootNoBypass.error || '').indexOf('数据根') >= 0,
      JSON.stringify(emptyRootNoBypass))
    process.env.FANGCUN_LICENSE_ACK = '1'
    delete process.env.FANGCUN_LICENSE_ACK

    console.log('\n【L5】咽喉：chat / stream / ping 三处都接了 assertLicensed')
    const chatSrc = fs.readFileSync(path.join(ROOT, 'src/main/llm/chat.ts'), 'utf-8')
    check('chatDetailed 调闸', /chatDetailed[\s\S]{0,300}assertLicensed/.test(chatSrc))
    check('streamChat 调闸', /streamChat[\s\S]{0,300}assertLicensed/.test(chatSrc))
    check('pingConnection 调闸', /pingConnection[\s\S]{0,300}assertLicensed/.test(chatSrc))

    console.log('\n【L6】三处常量同源：shared / Python / disclaimer 正文指纹')
    const py = fs.readFileSync(path.join(ROOT, '..', 'tegula_llm.py'), 'utf-8')
    const pyVer = /^LICENSE_VERSION\s*=\s*"([^"]+)"/m.exec(py)
    const pySha = /^LICENSE_CONTENT_SHA\s*=\s*"([0-9a-f]{12})"/m.exec(py)
    check('Python 版本 = shared', !!pyVer && pyVer[1] === LICENSE_VERSION, pyVer && pyVer[1])
    check('Python 指纹 = shared', !!pySha && pySha[1] === LICENSE_CONTENT_SHA, pySha && pySha[1])
    const disclaimer = fs.readFileSync(path.join(ROOT, 'src/renderer/disclaimer.ts'), 'utf-8').replace(/\r\n/g, '\n')
    const begin = '// === LICENSE-CONTENT-BEGIN ===\n'
    const end = '\n// === LICENSE-CONTENT-END ==='
    const i = disclaimer.indexOf(begin)
    const j = disclaimer.indexOf(end, i)
    check('disclaimer 有指纹标记', i >= 0 && j > i)
    if (i >= 0 && j > i) {
      const body = disclaimer.slice(i + begin.length, j)
      const actual = crypto.createHash('sha256').update(body, 'utf-8').digest('hex').slice(0, 12)
      check('disclaimer 正文指纹 = shared（改文案忘重算会红）', actual === LICENSE_CONTENT_SHA, actual)
    }
    check('renderer 版本镜像 = shared', (() => {
      const m = /export const DISCLAIMER_VERSION\s*=\s*'([^']+)'/.exec(disclaimer)
      return !!m && m[1] === LICENSE_VERSION
    })(), LICENSE_VERSION)
  } finally {
    if (oldBypass === undefined) delete process.env.FANGCUN_LICENSE_ACK
    else process.env.FANGCUN_LICENSE_ACK = oldBypass
    fs.rmSync(root, { recursive: true, force: true })
  }

  console.log(`\nlicense-gate: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main()
