#!/usr/bin/env node
/**
 * DSH 插件诊断（2026-11-21 · 暮雨：“插件页就算写‘不通’，世界上也不会有任何人知道有什么问题。
 * 现在的困境是方寸本体、方寸插件、DSH 三者各有自己的版本，不匹配就炸”）
 *
 * 钉的是**诊断本身不许说假话**：
 *  ① 三方版本从哪读：DSH 基座版本必须来自 app.asar 的 package.json（不是 Electron 的 `version` 文件）；
 *  ② 插件没进 bundles / 版本低于签名派单门槛 → 明确 bad，并指出“升级哪一边”；
 *  ③ 派单审计里的拒绝原因要翻成人话（bad-signature / no-secret / open-failed 各给各的动作）；
 *  ④ 两边密钥路径不一致要单独报（这是最难查的一种：只看“验签失败”永远查不出来）；
 *  ⑤ 只读：不写 DSH 配置、不改 profile。
 *
 * 运行：node scripts/test/e2e-dsh-plugin.cjs
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const Module = require('module')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const { mkTmp } = require('./_tmp.cjs')
const REPO = path.resolve(__dirname, '../..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

/** 造一个最小 asar：16 字节头 + JSON 头 + package.json 内容（与真 asar 同布局） */
function writeFakeAsar(asarPath, pkg) {
  const pkgBuf = Buffer.from(JSON.stringify(pkg), 'utf8')
  const headerObj = { files: { 'package.json': { size: pkgBuf.length, offset: '0' } } }
  const headerText = JSON.stringify(headerObj)
  const headerLen = Buffer.byteLength(headerText)
  const padded = Math.ceil(headerLen / 4) * 4
  const buf = Buffer.alloc(16 + padded + pkgBuf.length)
  buf.writeUInt32LE(4, 0)
  buf.writeUInt32LE(headerLen, 4)
  buf.writeUInt32LE(headerLen, 8)
  buf.writeUInt32LE(headerLen, 12)
  buf.write(headerText, 16, 'utf8')
  pkgBuf.copy(buf, 16 + padded)
  fs.mkdirSync(path.dirname(asarPath), { recursive: true })
  fs.writeFileSync(asarPath, buf)
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8')
}

function setupHome(root, opts = {}) {
  const home = path.join(root, 'dsh-home')
  const profile = path.join(home, 'profiles', 'desktop')
  writeJson(path.join(profile, 'package.json'), {
    name: 'dsh-profile-desktop',
    dependencies: { 'dsh-fangcun': 'link:E:/x/dsh-fangcun' },
    dsh: { profile: { bundles: opts.bundled === false ? ['@deepseek-ai/dsh-base'] : ['@deepseek-ai/dsh-base', 'dsh-fangcun'] } },
  })
  if (opts.pluginVersion !== null) {
    writeJson(path.join(profile, 'node_modules', 'dsh-fangcun', 'package.json'), {
      name: 'dsh-fangcun',
      version: opts.pluginVersion || '0.7.3',
      dsh: {
        compatibility: {
          dsh: '>=0.2.1-rc.2',
          dshReleases: { '0.2.2-rc.5': 'verified' },
        },
      },
    })
  }
  return { home, profile }
}

function pushAudit(dataRoot, row) {
  const dir = path.join(dataRoot, '.dispatch-dsh')
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, 'audit.jsonl'), JSON.stringify(row) + '\n', 'utf-8')
}

function main() {
  console.log('== DSH 插件诊断 e2e ==')
  const { home, profile } = setupHome(mkTmp('fc-dshplug-'))
  const root = path.dirname(home)
  const dataRoot = path.join(root, 'data')
  fs.mkdirSync(path.join(dataRoot, 'task-data'), { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'registry.yaml'), 'projects:\n  - id: demo\n    name: 演示\n', 'utf-8')

  // 基座版本：伪造 asar（放在 LOCALAPPDATA/Programs/DeepSeek Harness/resources/app.asar）
  const oldLocal = process.env.LOCALAPPDATA
  const fakeLocal = path.join(root, 'localappdata')
  process.env.LOCALAPPDATA = fakeLocal
  writeFakeAsar(path.join(fakeLocal, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'), {
    name: '@deepseek-ai/dsh-desktop', version: '0.2.2-rc.5',
  })

  // 密钥：显式路径 = 两边同一份
  const secretPath = path.join(root, 'dispatch-secret')
  fs.writeFileSync(secretPath, 'a'.repeat(64), 'utf-8')
  process.env.FC_DISPATCH_SECRET_PATH = secretPath
  process.env.FC_DSH_HOME = home

  const data = require(path.join(DIST, 'data', 'index.js'))
  data.setDataDir(dataRoot)
  const mod = require(path.join(DIST, 'services', 'dshPlugin.js'))

  try {
    // ── ① 正常态：三方版本都能读到，密钥同一份，无派单 → 没有 bad ──
    let s = mod.detectDshPlugin('0.7.0')
    check('★★ DSH 基座版本来自 app.asar 的 package.json（不是 Electron 的 version 文件）',
      s.dshVersion === '0.2.2-rc.5', `${s.dshVersion} @ ${s.dshVersionFrom}`)
    check('★ 插件版本 / 是否进 bundles 都读到了', s.plugins.length === 1 && s.plugins[0].version === '0.7.3' && s.plugins[0].bundled === true,
      JSON.stringify(s.plugins))
    check('★ 插件自报的 compat 表透传（界面要拿它跟 DSH 版本核对）',
      s.plugins[0].compatReleases && s.plugins[0].compatReleases['0.2.2-rc.5'] === 'verified')
    // 2026-11-21 真机：Electron 的 fs 带 asar 补丁，直接 openSync('...app.asar') 会 ENOENT。
    // 普通 Node 里测不出来，所以必须用源码守卫钉住“读 asar 本体走 original-fs”。
    {
      const src = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'services', 'dshPlugin.ts'), 'utf-8')
      check('★★ 读 DSH 的 app.asar 必须绕开 Electron 的 asar fs 补丁（original-fs），否则打包后“读不到基座版本”',
        /original-fs/.test(src) && /readAsarPackage/.test(src), 'dshPlugin.ts')
    }
    check('★ 密钥两边同一份 → secret 检查为 ok',
      (s.checks.find(c => c.key === 'secret') || {}).status === 'ok', JSON.stringify(s.checks.find(c => c.key === 'secret')))
    check('★ 兼容表覆盖当前 DSH → compat 检查为 ok',
      (s.checks.find(c => c.key === 'compat') || {}).status === 'ok', JSON.stringify(s.checks.find(c => c.key === 'compat')))
    check('★★ 没有明确不通时，verdict 不许吓人（不许出现「明确不通」）',
      s.verdict.indexOf('明确不通') < 0, s.verdict)

    // 首次使用：密钥还不存在是**正常态**（点派单时才生成），不能报 red 吓人
    process.env.FC_DISPATCH_SECRET_PATH = path.join(root, 'not-yet-created-secret')
    s = mod.detectDshPlugin('0.7.0')
    const secFirst = s.checks.find(c => c.key === 'secret')
    check('★★ 首次使用（密钥尚未生成）→ warn 而不是 bad，并说明点一次派单就会生成',
      secFirst.status === 'warn' && /第一次点|不是故障/.test(secFirst.detail), JSON.stringify(secFirst))
    process.env.FC_DISPATCH_SECRET_PATH = secretPath

    // ── ② 插件没进 bundles → bad，并指出去加 bundles ──
    const h2 = setupHome(mkTmp('fc-dshplug-nb-'), { bundled: false })
    process.env.FC_DSH_HOME = h2.home
    s = mod.detectDshPlugin('0.7.0')
    const pluginCheck = s.checks.find(c => c.key === 'plugin')
    check('★★ 插件装了但没进 bundles → bad（装了也不会加载）', pluginCheck.status === 'bad', JSON.stringify(pluginCheck))
    check('★ 这条的动作要指出「加进 bundles」，不是笼统“重装”', /bundles/.test(pluginCheck.action), pluginCheck.action)

    // ── ③ 旧插件（<0.7.3）→ bad，动作是升级 ──
    const h3 = setupHome(mkTmp('fc-dshplug-old-'), { pluginVersion: '0.7.2' })
    process.env.FC_DSH_HOME = h3.home
    s = mod.detectDshPlugin('0.7.0')
    const oldCheck = s.checks.find(c => c.key === 'plugin')
    check('★★ 插件 0.7.2 < 签名派单门槛 0.7.3 → bad', oldCheck.status === 'bad', JSON.stringify(oldCheck))
    check('★ 动作写明升级到 0.7.3+', /0\.7\.3/.test(oldCheck.action), oldCheck.action)

    // ── ④ 派单审计：bad-signature 要翻成“哪一边旧” ──
    process.env.FC_DSH_HOME = home
    pushAudit(dataRoot, { at: '2026-11-21T00:00:00.000Z', ok: false, reason: 'bad-signature', source: 'gui', project: 'demo', kind: 'work', file: 'dispatch-1.md' })
    s = mod.detectDshPlugin('0.7.0')
    const dispatchCheck = s.checks.find(c => c.key === 'dispatch')
    check('★★ 审计里的 bad-signature 会让派单链路变成 bad', dispatchCheck.status === 'bad', JSON.stringify(dispatchCheck))
    check('★★ bad-signature 的说明要点名“插件比方寸旧 / 不是同一把密钥”',
      /插件比方寸旧|同一把密钥/.test(dispatchCheck.detail), dispatchCheck.detail)
    check('★ 动作指向升级插件并重启 DSH', /0\.7\.3|升级/.test(dispatchCheck.action) && /重启/.test(dispatchCheck.action), dispatchCheck.action)
    check('★ verdict 会点出是「派单链路」这一环坏了', /派单/.test(s.verdict), s.verdict)

    // ── ⑤ 待消费派单 >0 → warn（插件没在跑 / 不在这个 profile）──
    // 先把上一段的拒绝记录清掉，否则“最近一次被拒”会继续压过“有文件没消费”这一事实。
    fs.writeFileSync(path.join(dataRoot, '.dispatch-dsh', 'audit.jsonl'), '', 'utf-8')
    const pendingDir = path.join(dataRoot, '.dispatch-dsh')
    fs.mkdirSync(pendingDir, { recursive: true })
    fs.writeFileSync(path.join(pendingDir, 'dispatch-2.md'), 'x', 'utf-8')
    // 2026-11-21：没有设置文件 = 出厂默认关。此时先说“未启用”，
    // 比“插件没在跑”更准确 —— 用户没打开总闸，插件跑着也不会消费。
    s = mod.detectDshPlugin('0.7.0')
    const d0 = s.checks.find(c => c.key === 'dispatch')
    check('★★ 没有设置文件 → 派单链路说“未启用”（默认关），不是“插件没在跑”',
      d0.status === 'warn' && /未启用/.test(d0.detail) && /设置 → Agent → DSH 派单/.test(d0.action), JSON.stringify(d0))
    // 显式打开之后，才轮到“有文件没人消费”这条诊断
    fs.writeFileSync(path.join(pendingDir, 'dispatch-settings.json'),
      JSON.stringify({ enabled: true, cooldownSec: 0, dailyCap: 0, concurrency: 10 }), 'utf-8')
    s = mod.detectDshPlugin('0.7.0')
    const d2 = s.checks.find(c => c.key === 'dispatch')
    check('★★ 已启用 + 有派单没被消费 → warn，并说明“插件没在跑 / 不在这个 profile”',
      d2.status === 'warn' && /没在跑|profile/.test(d2.detail), JSON.stringify(d2))

    // ── ⑥ 密钥两边路径不一致 → bad（最难查的一种）──
    const otherSecretDir = path.join(root, 'roaming', 'fangcun-desktop')
    fs.mkdirSync(otherSecretDir, { recursive: true })
    fs.writeFileSync(path.join(otherSecretDir, 'dispatch-secret'), 'b'.repeat(64), 'utf-8')
    const oldAppData = process.env.APPDATA
    process.env.APPDATA = path.join(root, 'roaming')
    delete process.env.FC_DISPATCH_SECRET_PATH
    // 让“方寸侧”固定在 root/dispatch-secret（存在），而插件会挑 roaming/fangcun-desktop 那份
    const sign = require(path.join(DIST, 'services', 'dispatchSign.js'))
    sign.configureDispatchSecretDir(root)
    s = mod.detectDshPlugin('0.7.0')
    const sec2 = s.checks.find(c => c.key === 'secret')
    check('★★ 方寸写的路径与插件会挑的路径不一致 → secret 检查为 bad（验签必失败）',
      sec2.status === 'bad' && /不是同一份/.test(sec2.detail), JSON.stringify(sec2))
    sign.configureDispatchSecretDir('')
    process.env.APPDATA = oldAppData
    process.env.FC_DISPATCH_SECRET_PATH = secretPath

    // ── ⑦ 只读守卫：诊断不许改动 profile / patch ──
    const before = fs.readFileSync(path.join(profile, 'package.json'), 'utf-8')
    mod.detectDshPlugin('0.7.0')
    const after = fs.readFileSync(path.join(profile, 'package.json'), 'utf-8')
    check('★★ 诊断只读：profile/package.json 逐字节不变', before === after)
  } finally {
    process.env.LOCALAPPDATA = oldLocal
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f) }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
