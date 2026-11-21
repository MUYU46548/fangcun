#!/usr/bin/env node
/**
 * DSH 基座版本读取 · Electron asar 补丁回归（2026-11-21）
 *
 * 真实现场（方寸 0.7.0 安装版）：
 *   `detectDshVersion()` 在候选循环里先 `if (!isFile(p)) continue`；
 *   Electron 的 fs 带 asar 补丁，`fs.statSync('...\\resources\\app.asar').isFile()` 返回 **false**
 *   （asar 被当成目录）→ 两个候选全被跳过 → 页面显示“装了 DSH，但读不到基座版本”。
 *   普通 Node 与旧 e2e 的假 asar 都没有这个补丁，所以测试一直绿。
 *
 * 本测试直接**模拟 Electron 的 asar 补丁**：在 require 业务模块之前把 `fs.statSync(...app.asar)`
 * 改成“是目录、不是文件”，再看 detectDshPlugin() 还能不能读出 0.2.2-rc.5。
 * 修复前必红（''）；修复后必绿。
 *
 * 运行：node scripts/test/e2e-dsh-plugin-asar.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

// ⚠ 必须在 require dshPlugin 之前打补丁（CommonJS 的 import * as fs 在模块加载时取值）
const realStatSync = fs.statSync
fs.statSync = function patchedStatSync(p, ...args) {
  if (/\.asar$/i.test(String(p))) return { isFile: () => false, isDirectory: () => true }
  return realStatSync.call(fs, p, ...args)
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
  const headerText = JSON.stringify({ files: { 'package.json': { size: pkgBuf.length, offset: '0' } } })
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

function main() {
  console.log('== DSH 基座版本 · Electron asar 补丁回归 ==')
  const root = mkTmp('fc-dsh-asar-')
  const local = path.join(root, 'localappdata')
  const asar = path.join(local, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
  writeFakeAsar(asar, { name: '@deepseek-ai/dsh-desktop', version: '0.2.2-rc.5' })

  // 先证明“补丁真的生效”：在模拟环境里 asar 是目录、不是文件
  check('★ 模拟生效：Electron 补丁下 app.asar 的 statSync().isFile() 为 false',
    fs.statSync(asar).isFile() === false && fs.statSync(asar).isDirectory() === true)

  const home = path.join(root, 'dsh-home')
  writeJson(path.join(home, 'profiles', 'desktop', 'package.json'), {
    name: 'dsh-profile-desktop',
    dependencies: { 'dsh-fangcun': 'link:E:/x/dsh-fangcun' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-fangcun'] } },
  })
  writeJson(path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-fangcun', 'package.json'), {
    name: 'dsh-fangcun', version: '0.7.3',
  })
  const dataRoot = path.join(root, 'data')
  fs.mkdirSync(path.join(dataRoot, 'task-data'), { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'registry.yaml'), 'projects:\n  - id: demo\n    name: 演示\n', 'utf-8')

  process.env.LOCALAPPDATA = local
  process.env.FC_DSH_HOME = home
  process.env.FC_TEST_USERDATA = path.join(root, 'userdata')
  process.env.FC_DISPATCH_SECRET_PATH = path.join(root, 'dispatch-secret')
  fs.writeFileSync(process.env.FC_DISPATCH_SECRET_PATH, 'a'.repeat(64), 'utf-8')

  try {
    const data = require(path.join(DIST, 'data', 'index.js'))
    data.setDataDir(dataRoot)
    const mod = require(path.join(DIST, 'services', 'dshPlugin.js'))
    const s = mod.detectDshPlugin('0.7.0')

    check('★★ 修复后：即使 asar 被 stat 成目录，也能读出 DSH 基座版本 0.2.2-rc.5',
      s.dshVersion === '0.2.2-rc.5', `dshVersion="${s.dshVersion}" from="${s.dshVersionFrom}"`)
    check('★ 版本来源指向 app.asar 本体', /app\.asar$/i.test(String(s.dshVersionFrom || '')), String(s.dshVersionFrom))
    check('★ 诊断里 DSH 基座不是 unknown（版本读到了就是 ok）',
      (s.checks.find((c) => c.key === 'dsh') || {}).status === 'ok',
      JSON.stringify(s.checks.find((c) => c.key === 'dsh')))

    // 源码守卫：候选循环里不许再出现“读之前先 isFile”的预检
    const src = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'services', 'dshPlugin.ts'), 'utf-8')
    const block = src.slice(src.indexOf('function detectDshVersion'), src.indexOf('function detectDshVersion') + 1200)
    check('★★ 源码守卫：detectDshVersion 里不许再对 asar 候选做 isFile 预检',
      !/if\s*\(\s*!isFile\s*\(\s*p\s*\)\s*\)/.test(block), block.slice(0, 120))
    check('★ 源码守卫：读 asar 本体仍走 original-fs', /original-fs/.test(src))
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
    fs.statSync = realStatSync
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f) }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
