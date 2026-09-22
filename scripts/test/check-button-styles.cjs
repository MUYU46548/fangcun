/**
 * 按钮样式守卫 —— 「模板用了 class，但 CSS 里没有与祖先无关的规则」
 *
 * 背景（2026-09-22，用户两轮反馈）：
 *   `.ghost/.pri/.ok/.danger/.warning` 一度**只在特定祖先下**定义
 *   （`#bar button.ghost`、`.acts .pri`、`.lp-ctrls button.ghost` …）。
 *   待办 `.todos-ctrls`、日志 `.logs-ctrls`、日历 `.calhead` 里的按钮
 *   因此匹配不到任何规则 → 退化成 Chromium 默认样式（"按钮样式仍为默认"）。
 *   vite / tsc / e2e / IPC 对账 / 模板绑定检查**都抓不到**这类问题，故单列。
 *
 * 检查项：
 *   ① 模板里出现的每个按钮 class，样式表里至少要有一条**能命中它**的规则
 *      （完全不存在的 class → 默认样式，直接失败）
 *   ② 项目约定「可跨页签复用」的 5 个共享 class（ghost/pri/ok/danger/warning）
 *      必须有一条**与祖先无关**的全局规则（`.x` / `button.x` / `:where(button.x)`）
 *   ③ 无 class 的 `<button>` 必须落在已有裸按钮样式的区域（#bar），
 *      否则需要全局 `button:not([class])` 基座
 *
 * 运行：node scripts/test/check-button-styles.cjs [被测 App.vue 路径]
 */
const fs = require('fs')
const path = require('path')

const FILE = process.argv[2] || path.resolve(__dirname, '../../desktop/src/renderer/App.vue')

/** 共享按钮 class 约定：任何位置都必须有样式，不能依赖祖先 */
const SHARED = ['ghost', 'pri', 'ok', 'danger', 'warning']

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

/** 扫描开标签，跳过属性值里的 > */
function scanTags(text, tagName) {
  const tags = []
  const re = new RegExp(`<${tagName}\\b`, 'gi')
  let m
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length
    let quote = null
    while (i < text.length) {
      const ch = text[i]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        break
      }
      i++
    }
    tags.push({ attrs: text.slice(m.index + m[0].length, i), index: m.index })
  }
  return tags
}

/** 取静态 class（忽略 :class / v-bind:class 动态绑定） */
function staticClass(attrs) {
  const m = attrs.match(/(?:^|\s)class\s*=\s*"([^"]*)"/) || attrs.match(/(?:^|\s)class\s*=\s*'([^']*)'/)
  if (!m) return null
  return m[1].split(/\s+/).filter(Boolean)
}

/** 父级链（用于判断裸按钮是否落在 #bar 等已有样式的区域）—— 简化：取前文最近的开标签 id */
function enclosingIds(text, index) {
  const before = text.slice(0, index)
  const ids = []
  const re = /<(\w+)\b([^>]*)>/g
  let m
  while ((m = re.exec(before))) {
    const idm = m[2].match(/(?:^|\s)id\s*=\s*"([^"]*)"/)
    if (idm) ids.push(idm[1])
  }
  return ids
}

/** 选择器里去掉伪类/伪元素与 :where()/:not() 外壳，返回「最后一段复合选择器」 */
function lastCompound(selector) {
  let s = selector.replace(/:where\(([^)]*)\)/g, '$1').replace(/:not\(([^)]*)\)/g, '')
  s = s.replace(/::?[a-z-]+(\([^)]*\))?/g, '')
  const parts = s.trim().split(/\s+|>/).filter(Boolean)
  return parts[parts.length - 1] || ''
}

/** 选择器是否需要祖先（多段） */
function needsAncestor(selector) {
  const s = selector.replace(/:where\(([^)]*)\)/g, '$1').replace(/:not\(([^)]*)\)/g, '')
  const core = s.replace(/::?[a-z-]+(\([^)]*\))?/g, '')
  return /[\s>+]/.test(core.trim())
}

function main() {
  console.log('== 按钮样式守卫 ==')
  console.log('file:', FILE)
  if (!fs.existsSync(FILE)) {
    console.log('FAIL  文件不存在')
    process.exit(1)
  }
  const src = fs.readFileSync(FILE, 'utf-8')

  const tplStart = src.indexOf('<template>')
  const tplEnd = src.indexOf('</template>')
  const styleStart = src.indexOf('<style')
  const styleEnd = src.lastIndexOf('</style>')
  if (tplStart < 0 || tplEnd < 0 || styleStart < 0 || styleEnd < 0) {
    console.log('FAIL  无法切分 template / style 块')
    process.exit(1)
  }
  const tpl = src.slice(tplStart, tplEnd)
  const style = src.slice(styleStart, styleEnd)

  // 样式表选择器清单
  const selectors = []
  const body = style.replace(/\/\*[\s\S]*?\*\//g, '')
  const ruleRe = /([^{}]+)\{/g
  let rm
  while ((rm = ruleRe.exec(body))) {
    const head = rm[1].trim()
    if (!head || head.startsWith('@')) continue
    for (const sel of head.split(',')) {
      const t = sel.trim()
      if (t) selectors.push(t)
    }
  }
  check('样式规则已解析（≥50 条）', selectors.length >= 50, `实际 ${selectors.length}`)

  const buttons = scanTags(tpl, 'button')
  check('模板中检出按钮', buttons.length > 20, `实际 ${buttons.length}`)

  const classSet = new Set()
  let classless = 0
  for (const b of buttons) {
    const cls = staticClass(b.attrs)
    if (!cls || !cls.length) {
      classless++
      continue
    }
    for (const c of cls) classSet.add(c)
  }

  // ── 检查 ①：每个 class 至少能被一条规则命中（合并「同一条规则里的 class」）──
  const unstyled = []
  for (const c of classSet) {
    const hit = selectors.some(sel => {
      // 该选择器最后一段是否含 .c（且只是普通 class 选择）
      return new RegExp(`\\.${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(sel)
    })
    if (!hit) unstyled.push(c)
  }
  check('① 模板中所有按钮 class 都有对应样式规则', unstyled.length === 0,
    unstyled.length ? `无任何规则：${unstyled.join(', ')}` : '')

  // ── 检查 ②：共享 class 必须有「与祖先无关」的全局规则 ──
  const missingGlobal = []
  for (const c of SHARED) {
    const re = new RegExp(`\\.${c}(?![\\w-])`)
    const globalOk = selectors.some(sel => re.test(sel) && !needsAncestor(sel) && re.test(lastCompound(sel)))
    if (!globalOk) missingGlobal.push(c)
  }
  check('② 共享 class（ghost/pri/ok/danger/warning）均有全局兜底规则', missingGlobal.length === 0,
    missingGlobal.length ? `缺全局规则：${missingGlobal.join(', ')}（会随所在容器退化成默认样式）` : '')

  // ── 检查 ③：无 class 的按钮必须被裸按钮基座覆盖 ──
  const hasBase = selectors.some(sel => /button\s*:\s*not\(\[class\]\)|:where\(button\)\s*$/.test(sel))
    || selectors.some(sel => /^button$/.test(sel) && !needsAncestor(sel))
  let bareOutsideBar = 0
  for (const b of buttons) {
    const cls = staticClass(b.attrs)
    if (cls && cls.length) continue
    const ids = enclosingIds(tpl, b.index)
    if (ids.includes('bar')) continue // #bar button 已有样式
    bareOutsideBar++
  }
  check('③ 无 class 按钮已被全局基座覆盖（或都在 #bar 内）',
    bareOutsideBar === 0 || hasBase,
    bareOutsideBar && !hasBase ? `有 ${bareOutsideBar} 个无 class 按钮在 #bar 之外且无基座` : '')

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('\n失败项：')
    for (const f of failures) console.log(' -', f)
  }
  process.exit(fail ? 1 : 0)
}

main()
