/**
 * 只测试用的最小 ZIP 写入器（见 e2e-skill-import.cjs 的用法说明）。
 * 单独一个文件是为了让 skill 导入测试与备份测试共用同一份造包逻辑，避免两边写法漂移。
 */
// ── 最小 ZIP 写入器（只测试用）──────────────────────────────────────────
// 为什么要自己写：需要造出**真实世界**的两种包 ——
//   ① 带目录条目（Windows 资源管理器打出来的 zip 一定有，旧解压器会对 `xxx/` 直接 writeFileSync 失败）
//   ② deflate 压缩条目（Compress-Archive 默认压）
// 外加造一个**恶意包**（条目名带 `../`）验证 zip slip 防护。
const zlib = require('zlib')
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}
function makeZip(entries) {
  const locals = []
  const cds = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const raw = e.dir ? Buffer.alloc(0) : Buffer.from(e.content == null ? '' : e.content)
    const crc = crc32(raw)
    let data = raw
    let method = 0
    if (!e.dir && e.compress) { data = zlib.deflateRawSync(raw); method = 8 }
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6)
    lh.writeUInt16LE(method, 8); lh.writeUInt16LE(0x2821, 10); lh.writeUInt16LE(0x2821, 12)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28)
    locals.push(lh, nameBuf, data)
    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6)
    cdh.writeUInt16LE(0, 8); cdh.writeUInt16LE(method, 10); cdh.writeUInt16LE(0x2821, 12); cdh.writeUInt16LE(0x2821, 14)
    cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(data.length, 20); cdh.writeUInt32LE(raw.length, 24)
    cdh.writeUInt16LE(nameBuf.length, 28); cdh.writeUInt16LE(0, 30); cdh.writeUInt16LE(0, 32)
    cdh.writeUInt32LE(offset, 42)
    cds.push(cdh, nameBuf)
    offset += lh.length + nameBuf.length + data.length
  }
  const cdBuf = Buffer.concat(cds)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cdBuf, eocd])
}
module.exports = { makeZip, crc32 }
