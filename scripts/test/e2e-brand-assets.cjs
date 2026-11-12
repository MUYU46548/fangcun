/**
 * 反例自证：品牌底色守卫真的咬得住吗？
 *
 * 做法：不碰明鉴仓库（对别人仓库只读是铁律），
 *   在临时目录造两张同形状 PNG —— 一张品牌紫、一张明鉴现在那个灰紫 ——
 *   喂给同一个判定函数，必须一绿一红。
 *
 * 若不这么做，这条守卫可能只是"读了文件说没问题"，根本没验过颜色。
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { mkTmp } = require('./_tmp.cjs')

const ROOT = path.resolve(__dirname, '..', '..')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

/** 造一张纯色 RGBA PNG（零依赖，Filter 0 = 不滤波） */
function writeSolidPng(file, w, h, [r, g, b]) {
  const stride = w * 4 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0
    for (let x = 0; x < w; x++) {
      const i = y * stride + 1 + x * 4
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255
    }
  }
  const idat = zlib.deflateSync(raw)
  const chunks = []
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crcBuf = Buffer.alloc(4)
    // CRC32
    let c = ~0
    for (let i = 0; i < td.length; i++) {
      c ^= td[i]
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
    }
    crcBuf.writeUInt32BE((~c) >>> 0)
    chunks.push(len, td, crcBuf)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  chunk('IHDR', ihdr)
  chunk('IDAT', idat)
  chunk('IEND', Buffer.alloc(0))
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]))
}

function main() {
  console.log('== 反例自证：品牌底色守卫 ==')
  const tmp = mkTmp('fc-brand-')

  // 把守卫里的判定函数单独跑（require 会执行 main，所以用正则抽出函数体先编译）
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'check-brand-assets.cjs'), 'utf8')
  const fnSrc = (src.match(/const BRAND_COLORS = \{[\s\S]*?\n\}/) || [])[0]
  const isSrc = (src.match(/function isBrandColor\(hex\) \{[\s\S]*?\n\}/) || [])[0]
  if (!fnSrc || !isSrc) {
    console.error('FATAL 抽不出判定函数 —— 守卫结构变了，本自证失效（不许当通过）')
    process.exit(2)
  }
  // eslint-disable-next-line no-new-func
  const isBrandColor = new Function(fnSrc + '\n' + isSrc + '\nreturn isBrandColor')()

  // ① 明鉴现在那个色：必须不过
  check('★★ 明鉴现在的 #8778bd 判定为**不合格**', isBrandColor('#8778bd') === false)
  // ② 品牌紫：必须过
  check('★★ 品牌紫 #6d5bd0 判定为合格', isBrandColor('#6d5bd0') === true)
  // ③ 抗锯齿容差：差 6 个通道仍算品牌色
  check('★ 容差生效：比品牌紫深 6 个通道仍算合格', isBrandColor('#6755ca') === true)
  // ④ 差太远：不算
  check('★ 差 40 个通道不算品牌色', isBrandColor('#9d8ded') === false)
  // ⑤ 白底（允许 paper）
  check('★ 白底 #f7f6fb 合格', isBrandColor('#f7f6fb') === true)
  // ⑥ 乱写不崩
  check('★ 非颜色串不崩且判不合格', isBrandColor('') === false && isBrandColor('red') === false)

  // ⑦ 端到端：造两张真 PNG，喂真读取 + 真判定
  const good = path.join(tmp, 'good.png')
  const bad = path.join(tmp, 'bad.png')
  writeSolidPng(good, 512, 512, [0x6d, 0x5b, 0xd0])
  writeSolidPng(bad, 512, 512, [0x87, 0x78, 0xbd])

  // 复用守卫里的 readPngInfo
  const readSrc = (src.match(/function readPngInfo\(file\) \{[\s\S]*?\n  return \{ w, h, color \}\n\}/) || [])[0]
  if (!readSrc) {
    console.error('FATAL 抽不出 readPngInfo —— 本自证失效')
    process.exit(2)
  }
  // eslint-disable-next-line no-new-func
  const readPngInfo = new Function('fs', 'zlib', 'path', 'require', readSrc + '\nreturn readPngInfo')(fs, zlib, path, require)

  const gi = readPngInfo(good)
  const bi = readPngInfo(bad)
  check('★★ 端到端：造的品牌色 PNG 读出来就是 #6d5bd0 且判定合格',
    gi && gi.color === '#6d5bd0' && isBrandColor(gi.color), JSON.stringify(gi))
  check('★★ 端到端：造的灰紫 PNG 读出来是 #8778bd 且判定**不合格**',
    bi && bi.color === '#8778bd' && isBrandColor(bi.color) === false, JSON.stringify(bi))
  check('★ 反滤波真的做了（不是把 0 当成黑色底）',
    bi && bi.color !== '#000000', 'bi=' + JSON.stringify(bi))

  console.log(`\nRESULT ${pass} pass / ${fail} fail`)
  if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log(' -', f)); process.exit(1) }
}

try { main() } catch (e) { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2) }
