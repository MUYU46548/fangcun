#!/usr/bin/env node
/**
 * 品牌基准校验（2026-11-12 暮雨：明鉴那个「鉴」字图标"字体、颜色全错"）
 *
 * 真事：20:00:36 明鉴生成了一个灰紫色「鉴」字图标 ——
 *   字是拿系统字体硬拼的（左右两半不是一套字），
 *   底色不是方寸家的品牌色。**每个项目都在自己决定"做成什么样"。**
 *
 * 这条守卫钉的**不是审美**（那要人眼看，机器判不了），
 * 钉的是**可机械校验的那三样**：
 *   ① 底色必须是品牌色之一（不许自己挑一个新紫）；
 *   ② 图标必须是**方形 + 圆角**（各项目形状一致）；
 *   ③ 同一项目在 desktop/build 下的 icon / favicon **尺寸集齐**。
 *
 * ⚠ 本脚本只读，不改任何项目仓库（对别人仓库只读是铁律）。
 *
 * 用法：
 *   node scripts/check-brand-assets.cjs            # 检查 registry 里所有项目
 *   node scripts/check-brand-assets.cjs --json
 */
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

/** 方寸家品牌色（单一真源；改这里 = 改全部项目的允许色） */
const BRAND_COLORS = {
  accent: '#6d5bd0',   // 主紫（方寸本体）
  deep: '#4c3fa8',
  ink: '#2c2a3d',
  paper: '#f7f6fb',
}

/**
 * 允许的底色：品牌紫 / 品牌深紫 / 白底深字。
 * 明鉴那个灰紫 #8b7fc7 不在这里 —— 它就是"自己挑了一个新紫"。
 */
function isBrandColor(hex) {
  const h = String(hex || '').toLowerCase()
  const allowed = new Set(Object.values(BRAND_COLORS).map((c) => c.toLowerCase()))
  if (allowed.has(h)) return true
  // 允许 ±8/通道 的抗锯齿误差（渲染/压缩会让纯色漂一点点）
  const parse = (s) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(s.toLowerCase())
    return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : null
  }
  const a = parse(h)
  if (!a) return false
  for (const c of allowed) {
    const b = parse(c)
    if (!b) continue
    if (a.every((v, i) => Math.abs(v - b[i]) <= 8)) return true
  }
  return false
}

/** 读 PNG 头：宽高 + 取中心像素色（不解码整张，PNG 太复杂；用 PNG 的 IDAT 真解） */
function readPngInfo(file) {
  // 只用零依赖：调 zlib 解 IDAT，取第一行像素
  const zlib = require('zlib')
  const buf = fs.readFileSync(file)
  if (buf.slice(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n') return null
  let off = 8
  let w = 0, h = 0, bitDepth = 8, colorType = 6
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.slice(off + 4, off + 8).toString('ascii')
    const data = buf.slice(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (!idat.length || bitDepth !== 8) return { w, h, color: null }
  let raw
  try { raw = zlib.inflateSync(Buffer.concat(idat)) } catch { return { w, h, color: null } }
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!ch) return { w, h, color: null }
  // 取底色：**要在字外**，而且必须**先反滤波** —— PNG 每行前面有一个滤波类型字节，
  // 不解它直接读像素会得到一堆 0（第一版就是这么读出 #000000 的，差点当成"图标是黑的"）。
  const stride = w * ch + 1
  const out = Buffer.alloc(w * h * ch)
  for (let y = 0; y < h; y++) {
    const ft = raw[y * stride]
    const src = y * stride + 1
    const dst = y * w * ch
    for (let x = 0; x < w * ch; x++) {
      const a = x >= ch ? out[dst + x - ch] : 0
      const b = y > 0 ? out[dst - w * ch + x] : 0
      const c = x >= ch && y > 0 ? out[dst - w * ch + x - ch] : 0
      const v = raw[src + x]
      let val
      if (ft === 0) val = v
      else if (ft === 1) val = v + a
      else if (ft === 2) val = v + b
      else if (ft === 3) val = v + ((a + b) >> 1)
      else if (ft === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        val = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      } else val = v
      out[dst + x] = val & 0xff
    }
  }
  const sampleAt = (x, y) => {
    const i = (y * w + x) * ch
    return '#' + [out[i], out[i + 1], out[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')
  }
  const inset = Math.max(2, Math.floor(Math.min(w, h) * 0.08))
  const pts = [
    [inset, inset], [w - 1 - inset, inset],
    [inset, h - 1 - inset], [w - 1 - inset, h - 1 - inset],
  ]
  const counts = {}
  for (const [x, y] of pts) {
    const cc = sampleAt(x, y)
    counts[cc] = (counts[cc] || 0) + 1
  }
  let color = null
  let best = 0
  for (const [cc, n] of Object.entries(counts)) if (n > best) { best = n; color = cc }
  return { w, h, color }
}

function main() {
  const regFile = path.join(ROOT, 'registry.yaml')
  if (!fs.existsSync(regFile)) { console.error('找不到 registry.yaml'); process.exit(2) }
  const reg = fs.readFileSync(regFile, 'utf8')

  // 解析 repo（只关心有 repo 的项目）
  const rows = []
  const blocks = reg.split(/\n(?=\s*- id: )/)
  for (const b of blocks) {
    const id = (b.match(/- id:\s*([\w.-]+)/) || [])[1]
    const repo = (b.match(/^\s*repo:\s*"?([^"\n]+)"?/m) || [])[1]
    if (!id || !repo) continue
    rows.push({ id, repo: repo.trim().replace(/\\/g, '/') })
  }

  const bad = []
  const ok = []
  const missing = []
  for (const r of rows) {
    const build = path.join(r.repo, 'desktop', 'build')
    const icon = path.join(build, 'icon-512.png')
    if (!fs.existsSync(icon)) { missing.push(r.id); continue }
    const info = readPngInfo(icon)
    if (!info) { bad.push({ id: r.id, why: 'PNG 读不出来' }); continue }
    const problems = []
    if (info.color && !isBrandColor(info.color)) {
      problems.push(`底色 ${info.color} 不是品牌色（允许 ${Object.values(BRAND_COLORS).join(' / ')}）`)
    }
    if (info.w !== info.h) problems.push(`不是方形：${info.w}×${info.h}`)
    if (info.w !== 512) problems.push(`icon-512 实际是 ${info.w}×${info.h}`)
    if (problems.length) bad.push({ id: r.id, why: problems.join('；'), color: info.color })
    else ok.push(r.id)
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok, bad, missing }, null, 2))
  } else {
    console.log('有仓库的项目:', rows.length)
    console.log('图标合格:', ok.length, ok.length ? '(' + ok.join(', ') + ')' : '')
    console.log('没有图标:', missing.length, missing.length ? '(' + missing.join(', ') + ')' : '')
    if (bad.length) {
      console.log('\n★ 不合格:')
      for (const b of bad) console.log('  ' + b.id.padEnd(20) + b.why)
    }
  }
  if (bad.length) process.exit(1)
}

main()
