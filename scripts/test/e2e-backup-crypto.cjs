#!/usr/bin/env node
/**
 * 备份加密（FCENC1）—— 纯逻辑 + 跨语言断言（2026-10-31）
 *
 * 暮雨拍板：「加密按改进后的方案开始做」。那份方案的**全部价值**在一个地方：
 * **没装方寸也能解开**。所以这套测试的重心不是"Node 能加能解"，而是：
 *   ① 格式与算法自洽（篡改必拒、错口令必拒、短口令不收、参数疯了的文件不把内存吃光）；
 *   ② Python 标准库能独立解开 Node 加的密（恢复脚本只有一份 AES 块实现，必须被标准向量钉住）。
 *
 * 判据不含"密文看起来像密文"这种废话 —— 只测能出事的地方。
 *
 * 运行：node scripts/test/e2e-backup-crypto.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const crypto = require('crypto')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'main', 'backup', 'crypto.js')
const RESTORE = path.join(REPO, 'desktop', 'public', 'fangcun-restore.py')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const { encryptBackup, decryptBackup, isEncryptedBackup, BackupCryptoError, CRYPTO_MAGIC } = require(ART)

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-crypto-'))
function py(args, opts = {}) {
  return execFileSync('python', args, {
    encoding: 'utf8', cwd: TMP,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    ...opts,
  })
}

console.log('== ① Python 侧 AES-256 必须过 FIPS-197 标准向量 ==')
// FIPS-197 C.3：key=000102…1f, pt=00112233445566778899aabbccddeeff → ct=8ea2b7ca516745bfeafc49904b496089
const vec = py(['-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("fr", r"${RESTORE}")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
key = bytes(range(32)); pt = bytes.fromhex("00112233445566778899aabbccddeeff")
print(m._AES256(key).encrypt_block(pt).hex())
`])
check('★★ AES-256 块加密与 FIPS-197 向量一致（恢复脚本自己写的那份）',
  vec.trim() === '8ea2b7ca516745bfeafc49904b496089', vec.trim())

console.log('\n== ② Node 侧：往返 / 篡改 / 错口令 / 短口令 ==')

const plain = Buffer.from('方寸备份明文 —— ' + crypto.randomBytes(32).toString('hex'), 'utf8')
const PW = 'correct horse battery staple'
const enc = encryptBackup(plain, PW)
check('★ 加密后是 FCENC1 容器，不是能直接读的 zip',
  isEncryptedBackup(enc) && enc.subarray(0, 6).toString('latin1') === CRYPTO_MAGIC && enc.length > plain.length)
check('★ 往返一致', decryptBackup(enc, PW).equals(plain))

check('★★ 改一个字节就拒（MAC 覆盖头部 + 密文）', (() => {
  const bad = Buffer.from(enc); bad[bad.length - 5] ^= 0xff
  try { decryptBackup(bad, PW); return false } catch (e) { return e instanceof BackupCryptoError && e.code === 'tampered' }
})())
check('★★ 改 salt/iv 同样拒（不能靠"只认密文"混过去）', (() => {
  const bad = Buffer.from(enc); bad[20] ^= 0x01
  try { decryptBackup(bad, PW); return false } catch (e) { return e.code === 'tampered' }
})())
check('★★ 口令错 → 明确是"口令/篡改"这一类（不是一句"失败"）', (() => {
  try { decryptBackup(enc, 'wrong password'); return false } catch (e) { return e.code === 'tampered' }
})())
check('★ 口令太短直接不收（8 位下限）', (() => {
  try { encryptBackup(plain, '1234'); return false } catch (e) { return e.code === 'weak-password' }
})())
check('★ 不是加密包 → 报"格式不认"（不是"口令错"）', (() => {
  try { decryptBackup(Buffer.from('PK\x03\x04not-encrypted'), PW); return false } catch (e) { return e.code === 'format' }
})())
check('★ 版本号不认识 → 拒绝', (() => {
  const bad = Buffer.from(enc); bad[6] = 9
  try { decryptBackup(bad, PW); return false } catch (e) { return e.code === 'format' }
})())
check('★★ 恶意参数（N 巨大）→ 拒绝而不是让 scrypt 吃几个 GB', (() => {
  const bad = Buffer.from(enc); bad.writeUInt32BE(1 << 30, 7)
  try { decryptBackup(bad, PW); return false } catch (e) { return e.code === 'format' }
})())
check('★ 两次加密的 salt 不同（同一明文密文也不同）',
  !encryptBackup(plain, PW).equals(enc))

console.log('\n== ③ 跨语言：Node 加密 → Python 标准库解开（这才是方案的重点）==')

// 用一个真 zip（含 manifest.json，才能让 verify/extract 走完整路径）
const caseDir = path.join(TMP, 'case'); fs.mkdirSync(caseDir, { recursive: true })
fs.mkdirSync(path.join(caseDir, 'task-data'), { recursive: true })
fs.writeFileSync(path.join(caseDir, 'task-data', 'a.md'), '---\nid: a\ntitle: 测试卡\n---\n正文\n', 'utf8')
const zipPath = path.join(caseDir, 'sample.zip')
py(['-c', `
import zipfile, hashlib, json, os
root = r"${caseDir}"
files = []
for dirpath, _, names in os.walk(root):
    for n in names:
        p = os.path.join(dirpath, n)
        rel = os.path.relpath(p, root).replace(os.sep, '/')
        if rel in ('sample.zip',): continue
        data = open(p, 'rb').read()
        files.append({"path": rel, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
manifest = {"createdAt": "2026-10-31T00:00:00Z", "hostname": "test", "totalFiles": len(files), "totalBytes": sum(f["size"] for f in files), "files": files}
with zipfile.ZipFile(r"${zipPath}", "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(os.path.join(root, f["path"].replace("/", os.sep)), f["path"])
    z.writestr("manifest.json", json.dumps(manifest))
`])

const plainZip = fs.readFileSync(zipPath)
const fcz = path.join(caseDir, 'backup.fcz')
fs.writeFileSync(fcz, encryptBackup(plainZip, PW))

const decrypted = path.join(caseDir, 'decrypted.zip')
py([RESTORE, 'decrypt', fcz, decrypted, '--password', PW])
check('★★ Python 解出来的字节与 Node 加密前的 zip **逐字节一致**',
  fs.readFileSync(decrypted).equals(plainZip),
  `${fs.readFileSync(decrypted).length} vs ${plainZip.length}`)

const verOut = py([RESTORE, 'verify', fcz, '--password', PW])
check('★ Python 的 verify 认加密包并通过（解谜后走原来的四层校验）',
  /PASS/.test(verOut) && /加密备份/.test(verOut), verOut.trim().split('\n').slice(-1)[0])

const extractDir = path.join(caseDir, 'out')
py([RESTORE, 'extract', fcz, extractDir, '--password', PW])
check('★★ Python 的 extract 真把文件还原出来（含 manifest）',
  fs.existsSync(path.join(extractDir, 'task-data', 'a.md')) && fs.existsSync(path.join(extractDir, 'manifest.json')),
  fs.readdirSync(extractDir).join(','))

check('★★ 错口令：Python 明确拒绝，且退出码非 0', (() => {
  try { py([RESTORE, 'verify', fcz, '--password', 'nope-nope-nope']); return false } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '')
    return e.status !== 0 && /口令不对|被改过/.test(out)
  }
})())
check('★ 篡改密文：Python 也拒（两边判据同源）', (() => {
  const bad = path.join(caseDir, 'bad.fcz')
  const buf = fs.readFileSync(fcz); buf[buf.length - 3] ^= 0x01
  fs.writeFileSync(bad, buf)
  try { py([RESTORE, 'verify', bad, '--password', PW]); return false } catch (e) {
    return e.status !== 0 && /口令不对|被改过/.test(String(e.stdout || '') + String(e.stderr || ''))
  }
})())

console.log('\n== ④ 明文包照旧（加密是可选，不是强制）==')
const plainOut = py([RESTORE, 'verify', zipPath])
check('★ 未加密的 zip 仍然原样可校验（老备份不被新功能拖坏）', /PASS/.test(plainOut) && !/加密备份/.test(plainOut), plainOut.trim().split('\n').slice(-1)[0])

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) { console.log('\n失败项：'); for (const f of failures) console.log('  - ' + f) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
