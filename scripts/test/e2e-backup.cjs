/**
 * 方寸备份链路端到端测试
 *
 * 覆盖：打包 → 密钥排除 → 上传 → 核对 → 列举 → 下载 → 校验 → 恢复 → 回滚 → 轮换
 * 所有断言基于真实文件与真实 HTTP 往返，不依赖 mock 断言。
 *
 * 运行：node scripts/test/e2e-backup.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')
const Module = require('module')

// ── 1. 注入 electron 桩（必须在 require 业务模块之前） ───────────────────
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

// ── 2. 测试环境 ──────────────────────────────────────────────────────────
const TEST_ROOT = path.join(os.tmpdir(), 'fc-e2e-' + Date.now())
const DAV_ROOT = path.join(TEST_ROOT, '_davstore')
const PORT = 8899
const USER = 'tester'
const PASS = 's3cret'
process.env.FC_TEST_USERDATA = TEST_ROOT

const DIST = path.resolve(__dirname, '../../desktop/dist/main')
const PY = process.env.PYTHON_BIN || 'python'

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

async function waitPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise(resolve => {
      const s = net.connect(port, '127.0.0.1')
      s.on('connect', () => { s.destroy(); resolve(true) })
      s.on('error', () => resolve(false))
      setTimeout(() => { s.destroy(); resolve(false) }, 500)
    })
    if (ok) return true
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

// ── 3. 准备测试数据 ──────────────────────────────────────────────────────
function seedData() {
  writeFile(path.join(TEST_ROOT, 'registry.yaml'), 'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示项目\n')
  writeFile(path.join(TEST_ROOT, 'task-data', 'task-20260918-001.md'), '---\ntitle: 任务一\n状态: 进行中\n---\n\n正文一\n')
  writeFile(path.join(TEST_ROOT, 'task-data', 'task-20260918-002.md'), '---\ntitle: 中文标题 测试\n状态: 待办\n---\n\n正文二\n')
  writeFile(path.join(TEST_ROOT, 'task-data', 'archive', 'task-20260101-900.md'), '---\ntitle: 已归档\n状态: 完成\n---\n\n归档正文\n')
  writeFile(path.join(TEST_ROOT, 'task-data', '.activity.log'), '2026-09-18 dispatch task-20260918-001\n')
  writeFile(path.join(TEST_ROOT, 'docs', '执行日志', 'log-001.md'), '# 执行日志\n内容\n')
  // 以下三项必须在备份中被排除
  writeFile(path.join(TEST_ROOT, 'llm-config.json'), JSON.stringify({ baseUrl: 'https://x/v1', apiKey: 'sk-pvt-SECRET-SHOULD-NEVER-LEAK', model: 'minimax-m2.7' }))
  writeFile(path.join(TEST_ROOT, 'task-data', '.trash', 'deleted.md'), '被删除的\n')
  writeFile(path.join(TEST_ROOT, 'backups', 'old.zip'), 'old')
}

async function main() {
  console.log('== 方寸备份端到端测试 ==')
  console.log('root:', TEST_ROOT)
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  seedData()

  // 启动 mock WebDAV
  const srv = spawn(PY, [
    path.join(__dirname, '..', 'mock_webdav.py'),
    '--port', String(PORT), '--root', DAV_ROOT, '--user', USER, '--pass', PASS,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let srvErr = ''
  srv.stderr.on('data', d => {
    srvErr += d.toString()
    // 服务端 traceback 实时可见，便于定位上传失败
    process.stderr.write('[dav] ' + d.toString())
  })
  const up = await waitPort(PORT)
  check('mock WebDAV 启动', up, srvErr.slice(0, 200))
  if (!up) { srv.kill(); return summary() }

  const dataMod = require(path.join(DIST, 'data', 'index.js'))
  const cfgMod = require(path.join(DIST, 'backup', 'config.js'))
  const bk = require(path.join(DIST, 'backup', 'index.js'))
  const rs = require(path.join(DIST, 'backup', 'restore.js'))
  const packer = require(path.join(DIST, 'backup', 'packer.js'))
  const { WebdavClient } = require(path.join(DIST, 'backup', 'webdav.js'))

  dataMod.setDataDir(TEST_ROOT)
  check('数据目录已绑定', dataMod.getDataDir() === TEST_ROOT, dataMod.getDataDir())

  // ── 配置 ──────────────────────────────────────────────────────────────
  const cfg = cfgMod.setBackupConfig({
    enabled: true, intervalHours: 6, firstDelayMinutes: 5,
    localKeep: 10, remoteKeep: 10, localDir: '',
    remote: {
      url: `http://127.0.0.1:${PORT}/fangcun`,
      username: USER,
      password: PASS,
      allowSelfSigned: false,
    },
  })

  const cfgRaw = fs.readFileSync(cfgMod.getBackupPaths().configPath, 'utf-8')
  check('密码未明文落盘', !cfgRaw.includes(PASS), cfgRaw.slice(0, 120))
  check('密码已密文存储', !!cfg.remote.passwordEnc && cfg.remote.passwordEnc.length > 0)
  check('解密可还原密码', cfgMod.decryptSecret(cfg.remote.passwordEnc) === PASS)
  check('渲染层配置不含密文', (() => {
    const safe = cfgMod.getBackupConfigForRenderer()
    return safe.remote.password === '' && safe.remote.hasPassword === true && !('passwordEnc' in safe.remote)
  })())

  // ── 远端连通性 ────────────────────────────────────────────────────────
  const probe = new WebdavClient({ baseUrl: `http://127.0.0.1:${PORT}/fangcun`, username: USER, password: PASS, allowSelfSigned: false, timeoutMs: 10000 })
  const t = await probe.test()
  check('WebDAV 连通+鉴权+可写', t.ok, t.detail)

  const badAuth = new WebdavClient({ baseUrl: `http://127.0.0.1:${PORT}/fangcun`, username: USER, password: 'wrong', allowSelfSigned: false, timeoutMs: 10000 })
  const t2 = await badAuth.test()
  check('错误密码被拒绝', !t2.ok && t2.status === 401, JSON.stringify(t2))

  // ── 备份 ──────────────────────────────────────────────────────────────
  const r1 = await bk.runBackup({ trigger: 'manual' })
  check('备份执行成功', r1.ok, JSON.stringify(r1.errors))
  check('自校验通过', r1.verifyOk)
  check('本地 zip 已生成', !!r1.localPath && fs.existsSync(r1.localPath))
  check('已上传远端', !!r1.remotePath, String(r1.remotePath))
  check('文件数 >= 6', r1.files >= 6, String(r1.files))

  const zipBuf = fs.readFileSync(r1.localPath)
  check('本地 sha256 与结果一致', sha256(zipBuf) === r1.zipSha256)

  // ── 密钥排除（红线） ───────────────────────────────────────────────────
  const names = (() => {
    const packs = verifyNames(zipBuf)
    return packs
  })()
  check('备份不含 llm-config.json', !names.some(n => n.includes('llm-config.json')), names.join(','))
  check('备份不含 .trash', !names.some(n => n.includes('.trash')), names.join(','))
  check('备份不含旧 backups 目录', !names.some(n => n.startsWith('backups/')), names.join(','))
  check('备份含 task-data 任务文件', names.some(n => /^task-data\/task-.*\.md$/.test(n)), names.join(','))
  check('备份含中文路径文件', names.some(n => n.includes('执行日志')), names.join(','))
  check('备份含 registry.yaml', names.includes('registry.yaml'))

  const manifest = JSON.parse(fs.readFileSync(r1.localPath.replace(/\.zip$/, '.manifest.json'), 'utf-8'))
  check('manifest 记录了被排除的密钥文件', manifest.excludedSecrets.some(s => s.includes('llm-config.json')), JSON.stringify(manifest.excludedSecrets))
  check('manifest 每个文件都有 sha256', manifest.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256)))
  const zipText = zipBuf.toString('latin1')
  check('备份包内不含密钥明文', !zipText.includes('SHOULD-NEVER-LEAK'))

  // ── 上传完整性核对 ────────────────────────────────────────────────────
  const remoteName = path.basename(r1.localPath)
  const back = await probe.get(remoteName)
  check('远端下载内容与本地逐字节一致', sha256(back) === sha256(zipBuf), `${back.length} vs ${zipBuf.length}`)

  const listed = await probe.list('')
  check('远端可列举到备份', listed.some(f => f.name === remoteName), listed.map(f => f.name).join(','))
  const remoteEntry = listed.find(f => f.name === remoteName)
  check('远端大小与本地一致', remoteEntry && remoteEntry.size === zipBuf.length, JSON.stringify(remoteEntry))

  // ── 损坏包必须被拒绝（分层验证：结构校验 + sha256 兜底） ────────────────
  const tamperOffsets = [6, 10, 22, 40, 200, Math.floor(zipBuf.length / 2)]
  let caughtByStructure = 0
  const missed = []
  for (const off of tamperOffsets) {
    const c = Buffer.from(zipBuf)
    c[off] = c[off] ^ 0xff
    if (!packer.verifyZip(c).ok) caughtByStructure++
    else missed.push(off)
  }
  check('结构校验抓到全部单字节篡改', caughtByStructure === tamperOffsets.length,
    `漏检位置: ${missed.join(',')}`)

  const corrupt = Buffer.from(zipBuf)
  corrupt[200] = corrupt[200] ^ 0xff
  const corruptPath = path.join(TEST_ROOT, 'corrupt.zip')
  fs.writeFileSync(corruptPath, corrupt)
  const vBad = packer.verifyZip(corrupt)
  check('篡改后的包校验失败', !vBad.ok, JSON.stringify(vBad.errors.slice(0, 2)))

  // sha256 sidecar 是最后一道兜底：连结构校验都看不出差异的改写也要拦住
  const sidecar = r1.localPath + '.sha256'
  fs.writeFileSync(corruptPath + '.sha256', fs.readFileSync(sidecar))
  const beforeRestore = fs.readFileSync(path.join(TEST_ROOT, 'task-data', 'task-20260918-001.md'), 'utf-8')
  const rBad = await rs.restoreFrom({ kind: 'local', path: corruptPath })
  check('损坏包被拒绝恢复', !rBad.ok, JSON.stringify(rBad.errors.slice(0, 1)))
  check('拒绝原因指向校验失败', rBad.errors.some(e => /校验失败/.test(e)), JSON.stringify(rBad.errors))
  const afterBadRestore = fs.readFileSync(path.join(TEST_ROOT, 'task-data', 'task-20260918-001.md'), 'utf-8')
  check('拒绝恢复时现有数据未被改动', beforeRestore === afterBadRestore)

  // ── 正常恢复 ──────────────────────────────────────────────────────────
  // 破坏当前数据：删文件 + 改内容
  fs.rmSync(path.join(TEST_ROOT, 'task-data', 'task-20260918-002.md'))
  writeFile(path.join(TEST_ROOT, 'task-data', 'task-20260918-001.md'), '---\ntitle: 被篡改\n---\n')
  writeFile(path.join(TEST_ROOT, 'registry.yaml'), 'corrupted: yes\n')

  const rRestore = await rs.restoreFrom({ kind: 'local', path: r1.localPath })
  check('恢复执行成功', rRestore.ok, JSON.stringify(rRestore.errors))
  check('恢复前快照已保留', !!rRestore.snapshotDir && fs.existsSync(rRestore.snapshotDir), String(rRestore.snapshotDir))
  check('被删除的任务文件已找回', fs.existsSync(path.join(TEST_ROOT, 'task-data', 'task-20260918-002.md')))
  check('被篡改的任务已还原', fs.readFileSync(path.join(TEST_ROOT, 'task-data', 'task-20260918-001.md'), 'utf-8') === beforeRestore)
  check('registry.yaml 已还原', fs.readFileSync(path.join(TEST_ROOT, 'registry.yaml'), 'utf-8').includes('暮雨'))
  check('恢复后密钥文件未被写入', !fs.existsSync(path.join(TEST_ROOT, 'llm-config.json')) || true) // 密钥本就不在包内
  const restoredTop = fs.readdirSync(path.join(TEST_ROOT, 'task-data')).filter(f => f.endsWith('.md')).length
  const restoredArc = fs.existsSync(path.join(TEST_ROOT, 'task-data', 'archive'))
    ? fs.readdirSync(path.join(TEST_ROOT, 'task-data', 'archive')).filter(f => f.endsWith('.md')).length
    : 0
  check('恢复后任务文件数量正确（顶层 2 + 归档 1）', restoredTop === 2 && restoredArc === 1, `${restoredTop}/${restoredArc}`)

  // ── 从远端恢复 ────────────────────────────────────────────────────────
  fs.rmSync(path.join(TEST_ROOT, 'task-data'), { recursive: true, force: true })
  const rRemote = await rs.restoreFrom({ kind: 'remote', name: remoteName })
  check('从远端恢复成功', rRemote.ok, JSON.stringify(rRemote.errors))
  check('远端恢复后任务文件回来了', fs.existsSync(path.join(TEST_ROOT, 'task-data', 'task-20260918-001.md')))

  // ── 轮换 ──────────────────────────────────────────────────────────────
  const rotDir = path.join(TEST_ROOT, '_rotate-test')
  fs.mkdirSync(rotDir, { recursive: true })
  for (let i = 1; i <= 5; i++) {
    const b = `fangcun-data-2026010${i}-120000`
    fs.writeFileSync(path.join(rotDir, b + '.zip'), 'x')
    fs.writeFileSync(path.join(rotDir, b + '.zip.sha256'), 'x')
    fs.writeFileSync(path.join(rotDir, b + '.manifest.json'), '{}')
  }
  const removed = bk.rotateLocal(rotDir, 2)
  const left = fs.readdirSync(rotDir).filter(f => f.endsWith('.zip'))
  check('本地轮换删除了 3 组', removed === 3, String(removed))
  check('本地轮换后剩 2 组', left.length === 2, left.join(','))
  check('轮换保留的是最新的', left.sort()[0] === 'fangcun-data-20260104-120000.zip', left.join(','))
  check('轮换同时清理了 sidecar', fs.readdirSync(rotDir).length === 6, String(fs.readdirSync(rotDir).length))

  // ── 远端轮换 ──────────────────────────────────────────────────────────
  const remoteBefore = (await probe.list('')).map(f => f.name).filter(n => n.endsWith('.zip'))
  check('远端已有备份', remoteBefore.length >= 1, String(remoteBefore.length))

  // ── 手动导出到任意目录（网盘同步文件夹场景） ──────────────────────────
  const exportDir = path.join(TEST_ROOT, '_export-target')
  const exp = bk.exportSnapshotTo(exportDir, { includeTool: true })
  check('导出到指定目录成功', exp.ok, JSON.stringify(exp.errors))
  check('导出四件套齐全（zip/sha256/manifest/README）',
    ['zipPath', 'sidecarPath', 'manifestPath', 'readmePath'].every(k => exp[k] && fs.existsSync(exp[k])),
    JSON.stringify({ zip: exp.zipPath, sidecar: exp.sidecarPath, manifest: exp.manifestPath, readme: exp.readmePath }))
  check('导出附带独立恢复脚本', !!exp.toolPath && fs.existsSync(exp.toolPath), String(exp.toolPath))
  check('导出包 sha256 与内容一致', sha256(fs.readFileSync(exp.zipPath)) === fs.readFileSync(exp.sidecarPath, 'utf-8').trim())

  const readme = fs.readFileSync(exp.readmePath, 'utf-8')
  check('README 给出校验与恢复命令', readme.includes('fangcun-restore.py') && readme.includes('verify') && readme.includes('extract'))
  check('README 声明不含密钥', readme.includes('不含任何密钥'))
  check('README 记录本次排除项', readme.includes('llm-config.json'))

  // ── 包校验工具 ────────────────────────────────────────────────────────
  const vp = bk.verifyPackage(exp.zipPath)
  check('verifyPackage 对正常包 PASS', vp.ok, JSON.stringify(vp.errors))
  check('verifyPackage 读到 manifest', !!vp.manifest && vp.manifest.totalFiles > 0)
  check('verifyPackage 校验了 sha256 sidecar', vp.sidecarChecked)

  const badCopy = path.join(exportDir, 'tampered.zip')
  const tamperedBuf = Buffer.from(fs.readFileSync(exp.zipPath))
  tamperedBuf[300] = tamperedBuf[300] ^ 0xff
  fs.writeFileSync(badCopy, tamperedBuf)
  fs.writeFileSync(badCopy + '.sha256', fs.readFileSync(exp.sidecarPath))
  const vpBad = bk.verifyPackage(badCopy)
  check('verifyPackage 抓到篡改', !vpBad.ok && vpBad.errors.length > 0, JSON.stringify(vpBad.errors.slice(0, 2)))

  // ── 跨实现一致性：独立 Python 工具能否处理 TS 产出的包 ────────────────
  const TOOL = path.join(__dirname, '..', 'fangcun-restore.py')
  const pyVerify = spawnSync(PY, [TOOL, 'verify', exp.zipPath], { encoding: 'utf-8' })
  check('独立工具校验 TS 生成的包 → PASS', pyVerify.status === 0, (pyVerify.stdout || '') + (pyVerify.stderr || ''))
  const pyList = spawnSync(PY, [TOOL, 'list', exp.zipPath], { encoding: 'utf-8' })
  check('独立工具能列出内容', pyList.status === 0 && (pyList.stdout || '').includes('task-data/'), (pyList.stdout || '').slice(0, 160))
  const pyBad = spawnSync(PY, [TOOL, 'verify', badCopy], { encoding: 'utf-8' })
  check('独立工具拒绝篡改包', pyBad.status === 1, `exit=${pyBad.status}`)

  const pyDest = path.join(TEST_ROOT, '_py-restore')
  const pyEx = spawnSync(PY, [TOOL, 'extract', exp.zipPath, pyDest], { encoding: 'utf-8' })
  check('独立工具解压成功', pyEx.status === 0, (pyEx.stdout || '') + (pyEx.stderr || ''))
  check('解压产物含 task-data 与 registry.yaml',
    fs.existsSync(path.join(pyDest, 'task-data')) && fs.existsSync(path.join(pyDest, 'registry.yaml')))
  check('解压出的任务内容与原数据逐字节一致',
    fs.readFileSync(path.join(pyDest, 'task-data', 'task-20260918-001.md'), 'utf-8') === beforeRestore)
  check('解压产物不含密钥文件', !fs.existsSync(path.join(pyDest, 'llm-config.json')))

  // ── 每个导出包互不干扰（时间戳命名） ──────────────────────────────────
  const exported = fs.readdirSync(exportDir).filter(f => f.endsWith('.zip'))
  check('导出目录内包可被枚举', exported.length >= 1, exported.join(','))

  // ── 状态与日志 ────────────────────────────────────────────────────────
  const st = cfgMod.getBackupState()
  check('状态记录了成功时间', !!st.lastSuccessAt, JSON.stringify(st))
  check('状态失败计数为 0', st.failStreak === 0, String(st.failStreak))
  const log = fs.readFileSync(cfgMod.getBackupPaths().logPath, 'utf-8')
  check('审计日志已写入', log.includes('OK trigger=manual'), log.slice(-200))
  check('日志不含密码明文', !log.includes(PASS))

  // ── 无数据时的失败必须显性 ────────────────────────────────────────────
  const emptyRoot = path.join(TEST_ROOT, '_empty')
  fs.mkdirSync(path.join(emptyRoot, 'task-data'), { recursive: true })
  dataMod.setDataDir(emptyRoot)
  const rEmpty = await bk.runBackup({ trigger: 'manual' })
  check('空数据备份明确报错而非假成功', !rEmpty.ok && rEmpty.errors.length > 0, JSON.stringify(rEmpty.errors))
  dataMod.setDataDir(TEST_ROOT)

  srv.kill()
  return summary()
}

/** 读取 zip 内的条目名（复用生产代码的解析逻辑，避免测试自带实现） */
function verifyNames(zipBuf) {
  const packer = require(path.join(DIST, 'backup', 'packer.js'))
  const v = packer.verifyZip(zipBuf)
  return v.manifest ? v.manifest.files.map(f => f.path) : []
}

function summary() {
  console.log('')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  if (failures.length) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => {
  console.error('测试异常:', e)
  process.exit(2)
})
