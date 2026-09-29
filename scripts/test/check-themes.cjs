/**
 * 主题可读性守卫 —— 2026-09-29（用户第 4 条：「多主题颜色外观…别把文字弄得看不见，
 * 注意文本和按钮对比度」）
 *
 * 存在的理由（一句话）：**没跑过的断言等于没有。** 主题是拿肉眼最容易放过去的改动 ——
 * 换个色板当场好看，但「白字压品牌色」「次要文字压底色」这类对比度只有量了才知道，
 * 2026-09-27 那轮就是全量实测后才发现默认主题有 5 处掉在 WCAG AA（4.5）以下。
 *
 * 这里对**每个主题**（默认 + data-theme 覆盖）逐对量：
 *   正文压底 · 正文压卡面 · 次要文字压底 · 次要文字压卡面 ·
 *   强调色压底 · 白字压强调色 · 正文压选中染色 · 正文压面板底 ·
 *   白字压 成功/警告/危险 · 徽章字压 --accent-soft
 * 并交叉核对：CSS 里的 data-theme 块 与 script 里的 THEME_LIST 必须一一对应
 * （多写一套没入口 / 少写一块点了没反应，都是这一条抓）。
 *
 * 用法：node scripts/test/check-themes.cjs
 * 退出码：任一失败 → 1
 */
const fs = require('fs')
const path = require('path')

const APP = path.resolve(__dirname, '..', '..', 'desktop', 'src', 'renderer', 'App.vue')

let pass = 0
let fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  → ' + detail : '')) }
}

// ── 颜色计算（WCAG 2.1 相对亮度 / 对比度） ─────────────────────────────
function lum(hex) {
  let h = String(hex).trim().replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null
  const v = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
  const f = c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const [r, g, b] = v.map(f)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a, b) {
  const la = lum(a), lb = lum(b)
  if (la == null || lb == null) return null
  const hi = Math.max(la, lb), lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}
const AA = 4.5

// ── 解析令牌 ──────────────────────────────────────────────────────────
const src = fs.readFileSync(APP, 'utf-8')

function parseBlock(re) {
  const m = src.match(re)
  if (!m) return null
  const tokens = {}
  const body = m[1]
  for (const tm of body.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    tokens[tm[1]] = tm[2]
  }
  return tokens
}

const base = parseBlock(/:root\s*\{([\s\S]*?)\}/)
check('解析到默认 :root 令牌', !!base && !!base.bg && !!base.accent, base ? '' : '没匹配到 :root')

const themeBlocks = {}
for (const m of src.matchAll(/:root\[data-theme='([a-z]+)'\]\s*\{([\s\S]*?)\}/g)) {
  const tokens = {}
  for (const tm of m[2].matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    tokens[tm[1]] = tm[2]
  }
  themeBlocks[m[1]] = tokens
}

const listMatch = src.match(/const THEME_LIST = \[([\s\S]*?)\]/)
const listIds = listMatch
  ? [...listMatch[1].matchAll(/\{\s*id:\s*'([a-z]+)'/g)].map(m => m[1])
  : []
check('解析到 THEME_LIST', listIds.length >= 2, JSON.stringify(listIds))

const cssIds = Object.keys(themeBlocks).sort()
const listNonDefault = listIds.filter(id => id !== 'default').sort()
check('CSS 的 data-theme 块 与 THEME_LIST 一一对应（多一块没入口 / 少一块点了没反应）',
  JSON.stringify(cssIds) === JSON.stringify(listNonDefault),
  `css=[${cssIds}] list=[${listNonDefault}]`)

// ── 逐主题量对比度 ────────────────────────────────────────────────────
// 这几个色是**所有主题共用的语义色**（成功/警告/危险 + 徽章字），
// 它们压白字 / 压 --accent-soft 的表现与主题无关，但仍要量一遍。
const SEMANTIC = base
const BADGE_TEXT = '#4a4368'   // .lpill .gn / .batch 压 --accent-soft 的字色

for (const id of ['default', ...listNonDefault]) {
  const t = Object.assign({}, base, id === 'default' ? {} : themeBlocks[id])
  const pairs = [
    ['正文压底 --ink/--bg', t.ink, t.bg],
    ['正文压卡 --ink/--card', t.ink, t.card || '#ffffff'],
    ['次要文字压底 --muted/--bg', t.muted, t.bg],
    ['次要文字压卡 --muted/--card', t.muted, t.card || '#ffffff'],
    ['强调色压底 --accent/--bg', t.accent, t.bg],
    ['按钮白字压强调色 #fff/--accent', '#ffffff', t.accent],
    ['正文压选中染 --ink/--tint', t.ink, t.tint],
    ['正文压面板底 --ink/--tint-3', t.ink, t['tint-3']],
    ['正文压次级描边上的字 --ink/--line-2', t.ink, t['line-2']],
    ['徽章字压 --accent-soft', BADGE_TEXT, t['accent-soft']],
    ['按钮白字压 成功 #fff/--success', '#ffffff', SEMANTIC.success],
    ['按钮白字压 警告 #fff/--warning', '#ffffff', SEMANTIC.warning],
    ['按钮白字压 危险 #fff/--danger', '#ffffff', SEMANTIC.danger],
  ]
  const bad = []
  for (const [label, fg, bg] of pairs) {
    const c = contrast(fg, bg)
    if (c == null) bad.push(`${label}（色值解析失败 fg=${fg} bg=${bg}）`)
    else if (c < AA) bad.push(`${label} = ${c.toFixed(2)}`)
  }
  check(`主题「${id}」全部 13 对对比度 ≥ WCAG AA (4.5)`, bad.length === 0, bad.join('；'))
  if (bad.length === 0) {
    const min = Math.min(...pairs.map(([, fg, bg]) => contrast(fg, bg)))
    console.log(`      ↳ 最低 ${min.toFixed(2)}`)
  }
}

// ── 主题只许是浅色（半吊子暗色 = 文字看不见，墨坊同款硬规矩） ──────────
for (const id of listNonDefault) {
  const t = Object.assign({}, base, themeBlocks[id])
  check(`主题「${id}」是浅色（bg 亮度 > 卡面亮度的 0.5）`,
    lum(t.bg) > 0.5, `bg=${t.bg} lum=${(lum(t.bg) || 0).toFixed(3)}`)
}

console.log('')
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
