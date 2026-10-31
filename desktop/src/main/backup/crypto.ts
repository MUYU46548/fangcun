/**
 * 备份包加密（2026-10-31 暮雨拍板"按改进后的方案开始做"）
 *
 * 目标：**备份离开这台机器时是密文，但没装方寸也能解开**。
 * 所以格式必须是"自带说明 + 标准算法"，恢复脚本用 Python 标准库就能解。
 *
 * 构造（不用 GCM —— 见下）：
 *   scrypt(密码, salt) → 64 字节 → encKey(32) + macKey(32)
 *   AES-256-CTR 加密 zip（CTR 只需要块密码，Python 侧好实现）
 *   HMAC-SHA256 做 **encrypt-then-MAC**（先加密再认，改一个字节必拒）
 *
 * 为什么不直接 AES-GCM：Node 侧一行就能用，但 **Python 标准库没有 AES**，
 * 恢复脚本要手写 GCM 认证标签与 GHASH；而 CTR+HMAC 只需要一个 AES 块密码，
 * 认证部分用标准库 hmac 就够 —— 少写一半最容易错的密码学代码。
 *
 * 文件格式（全部大端）：
 *   0   magic  "FCENC1" (6B)
 *   6   ver    1 (1B)
 *   7   N      scrypt 代价参数 (4B)
 *   11  r      (4B)
 *   15  p      (4B)
 *   19  salt   16B
 *   35  iv     16B
 *   51  tag    HMAC-SHA256(header[0..51] || ciphertext) (32B)
 *   83  ciphertext
 *
 * 红线：
 *  · 密码**只在本次调用里存在**，不写日志、不进 manifest、不落盘（除非用户在设置里选择记住，
 *    那条走 safeStorage，和 WebDAV 密码同一套）；
 *  · 先 `verifyZip` 校验明文包，再加密 —— 校验的对象永远是明文，不会"因为加密了就不校验"；
 *  · 解不开时必须**说清是哪一种**（格式不认 / 密码不对 / 文件被改过），不许糊成一句"失败"。
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto'

export const CRYPTO_MAGIC = 'FCENC1'
export const CRYPTO_VERSION = 1
export const CRYPTO_HEADER_BYTES = 83
/** scrypt 参数：N=2^15, r=8, p=1（约 32MB 内存，桌面机上是"几百毫秒"档） */
export const DEFAULT_KDF = { N: 32768, r: 8, p: 1 } as const

export interface KdfParams { N: number; r: number; p: number }

export class BackupCryptoError extends Error {
  code: 'format' | 'password' | 'tampered' | 'weak-password'
  constructor(code: BackupCryptoError['code'], message: string) {
    super(message)
    this.code = code
    this.name = 'BackupCryptoError'
  }
}

function writeU32(buf: Buffer, offset: number, v: number): void {
  buf.writeUInt32BE(v >>> 0, offset)
}

/** 派生 64 字节：前 32 = 加密键，后 32 = 认证据键 */
function deriveKeys(password: string, salt: Buffer, kdf: KdfParams): { enc: Buffer; mac: Buffer } {
  const need = 64
  // maxmem 必须显式放宽：默认 32MB 时 128*N*r 正好卡在边界上会抛 "memory limit exceeded"
  const maxmem = Math.max(64 * 1024 * 1024, 128 * kdf.N * kdf.r * 2)
  const dk = scryptSync(Buffer.from(password, 'utf8'), salt, need, {
    N: kdf.N, r: kdf.r, p: kdf.p, maxmem,
  })
  return { enc: dk.subarray(0, 32), mac: dk.subarray(32, 64) }
}

/** 是不是方寸的加密备份（只看魔数，不做解密） */
export function isEncryptedBackup(buf: Buffer): boolean {
  return Buffer.isBuffer(buf) && buf.length >= CRYPTO_HEADER_BYTES &&
    buf.subarray(0, CRYPTO_MAGIC.length).toString('latin1') === CRYPTO_MAGIC
}

export function encryptBackup(plain: Buffer, password: string, kdf: KdfParams = { ...DEFAULT_KDF }): Buffer {
  const pw = String(password ?? '')
  if (pw.length < 8) {
    throw new BackupCryptoError('weak-password', '口令至少 8 个字符 —— 短口令对离线爆破毫无意义')
  }
  const salt = randomBytes(16)
  const iv = randomBytes(16)
  const keys = deriveKeys(pw, salt, kdf)

  const header = Buffer.alloc(CRYPTO_HEADER_BYTES)
  header.write(CRYPTO_MAGIC, 0, 'latin1')
  header.writeUInt8(CRYPTO_VERSION, 6)
  writeU32(header, 7, kdf.N)
  writeU32(header, 11, kdf.r)
  writeU32(header, 15, kdf.p)
  salt.copy(header, 19)
  iv.copy(header, 35)

  const cipher = createCipheriv('aes-256-ctr', keys.enc, iv)
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])

  // tag 覆盖「头部前 51 字节 + 密文」：改 salt/iv/参数/密文都会失效
  const mac = createHmac('sha256', keys.mac)
  mac.update(header.subarray(0, 51))
  mac.update(ct)
  mac.digest().copy(header, 51)

  return Buffer.concat([header, ct])
}

/**
 * 解密。失败一律抛 `BackupCryptoError`，并且**三种原因分开报** ——
 * 「密码不对」和「文件被改过」如果混成一句，用户永远不知道该重输口令还是该换一份备份。
 */
export function decryptBackup(buf: Buffer, password: string): Buffer {
  if (!isEncryptedBackup(buf)) {
    throw new BackupCryptoError('format', '这不是方寸的加密备份（文件头不是 FCENC1）')
  }
  const ver = buf.readUInt8(6)
  if (ver !== CRYPTO_VERSION) {
    throw new BackupCryptoError('format', `加密备份版本 ${ver} 不认识（当前支持 ${CRYPTO_VERSION}）`)
  }
  const kdf: KdfParams = { N: buf.readUInt32BE(7), r: buf.readUInt32BE(11), p: buf.readUInt32BE(15) }
  // 参数来自文件本身 —— 不设上限的话，一份恶意文件能让 scrypt 吃掉几个 GB
  if (kdf.N < 1024 || kdf.N > 1 << 20 || kdf.r < 1 || kdf.r > 32 || kdf.p < 1 || kdf.p > 8) {
    throw new BackupCryptoError('format', '加密参数不合理（文件可能损坏或被篡改）')
  }
  const salt = buf.subarray(19, 35)
  const iv = buf.subarray(35, 51)
  const tag = buf.subarray(51, 83)
  const ct = buf.subarray(CRYPTO_HEADER_BYTES)
  const keys = deriveKeys(String(password ?? ''), Buffer.from(salt), kdf)

  const mac = createHmac('sha256', keys.mac)
  mac.update(buf.subarray(0, 51))
  mac.update(ct)
  const expect = mac.digest()
  if (expect.length !== tag.length || !timingSafeEqual(expect, Buffer.from(tag))) {
    throw new BackupCryptoError('tampered', '口令不对，或者这份备份被改过 —— 两种都过不了校验，方寸分不出是哪一种')
  }

  const d = createDecipheriv('aes-256-ctr', keys.enc, Buffer.from(iv))
  return Buffer.concat([d.update(ct), d.final()])
}

/** 给人看的一句话：这份备份加没加密、加密了该怎么恢复 */
export function cryptoHint(encrypted: boolean): string {
  return encrypted
    ? '这是加密备份（.fcz）。恢复要口令 —— 口令忘了就打不开，方寸也没有后门。用 fangcun-restore.py --password 或方寸的「恢复」入口。'
    : '这是未加密备份（.zip）。任何人拿到它就能读到全部任务与日志 —— 要传出去请用加密备份。'
}
