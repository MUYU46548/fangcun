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
const { BACKUP_INCLUDES, LOG_ATTACHMENTS_REL } = require(path.join(DIST, 'backup', 'scope.js'))

// 瘦身旋钮可用环境变量预演：FC_MAX_MB=0 关闭体积上限、FC_SKIP_ATTACHMENTS=1 排除附件目录
const MAX_MB = process.env.FC_MAX_MB !== undefined ? Number(process.env.FC_MAX_MB) : 10
const SKIP_ATT = process.env.FC_SKIP_ATTACHMENTS === '1'

const snap = createSnapshot({
  rootDir: data.getDataDir(),
  // ⚠ 用**共享的范围真源**（2026-10-11 用户第 2 条：policies/ 此前漏在备份范围之外；
  //   这个预演脚本自己写一份 includes 的话，就会重复当年那个错）
  includes: BACKUP_INCLUDES.slice(),
  appVersion: '0.2.1',
  maxFileMB: MAX_MB,
  excludePrefixes: SKIP_ATT ? [LOG_ATTACHMENTS_REL] : [],
})
const v = verifyZip(snap.zipBuffer)

console.log('瘦身设置     :', `单文件上限 ${MAX_MB || '不限'}MB · 排除附件目录 ${SKIP_ATT ? '开' : '关'}`)
const om = snap.manifest.omittedFiles || []
console.log('被瘦身跳过   :', om.length, `个 / ${((snap.manifest.omittedBytes || 0) / 1024 / 1024).toFixed(1)} MB`)
for (const o of om.slice().sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 6)) {
  console.log('              ', (o.size / 1024 / 1024).toFixed(1) + ' MB', o.path, '——', o.reason)
}
if (om.length > 6) console.log('               … 其余', om.length - 6, '个')

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
