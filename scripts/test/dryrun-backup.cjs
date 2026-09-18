/**
 * 只读预演 — 对真实数据目录跑一次"打包 + 自校验"，全程在内存中，不落盘、不上传。
 * 用来在真正启用备份前，确认纳入范围与密钥排除是否符合预期。
 *
 * 运行：node scripts/test/dryrun-backup.cjs
 */
const path = require('path')
const fs = require('fs')
const Module = require('module')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const REAL = process.env.FC_REAL_DATA || path.join(process.env.APPDATA || '', 'fangcun-desktop')
process.env.FC_TEST_USERDATA = REAL

if (!fs.existsSync(REAL)) {
  console.error('数据目录不存在：' + REAL)
  process.exit(2)
}

const DIST = path.resolve(__dirname, '../../desktop/dist/main')
const data = require(path.join(DIST, 'data', 'index.js'))
data.setDataDir(REAL)
const { createSnapshot, verifyZip } = require(path.join(DIST, 'backup', 'packer.js'))

const snap = createSnapshot({
  rootDir: data.getDataDir(),
  includes: ['task-data', 'registry.yaml', 'docs'],
  appVersion: '0.2.1',
})
const v = verifyZip(snap.zipBuffer)

console.log('数据根       :', data.getDataDir())
console.log('纳入文件数   :', snap.manifest.totalFiles)
console.log('原始体积     :', snap.manifest.totalBytes, `B (${(snap.manifest.totalBytes / 1024).toFixed(1)} KB)`)
console.log('压缩后       :', snap.zipBuffer.length, `B (${(snap.zipBuffer.length / 1024).toFixed(1)} KB)`)
console.log('zip sha256   :', snap.zipSha256.slice(0, 16) + '…')
console.log('结构自校验   :', v.ok ? 'PASS' : 'FAIL → ' + v.errors.join('; '))
console.log('检出条目数   :', v.entryCount)
console.log('被排除的敏感项:', snap.manifest.excludedSecrets.length ? snap.manifest.excludedSecrets.join(', ') : '(无)')

const leak = snap.manifest.files.filter(f => /llm-config|backup-config|credentials|\.env($|\.)|\.key$|\.pem$|\.p12$/i.test(f.path))
console.log('密钥泄漏检查 :', leak.length ? 'LEAK → ' + leak.map(f => f.path).join(', ') : 'PASS（无密钥进包）')

console.log('\n条目示例（前 8 个）:')
for (const f of snap.manifest.files.slice(0, 8)) {
  console.log('  ', f.path, `(${f.size}B)`)
}
if (snap.manifest.files.length > 8) console.log(`   … 其余 ${snap.manifest.files.length - 8} 个`)

const ok = v.ok && leak.length === 0
console.log('\n预演结论     :', ok ? 'PASS — 可安全启用备份' : 'FAIL — 请先排查')
process.exit(ok ? 0 : 1)
