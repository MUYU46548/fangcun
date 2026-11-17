#!/usr/bin/env node
/**
 * 跨项目前端体检（只读）· 2026-11-17
 *
 * ## 为什么要有它
 *
 * 暮雨 2026-11-17：「各项目的前端和交互都很差，有没有什么系统性的解决方法？方寸现在又管不住它们。」
 *
 * 在动手改任何界面之前，先回答一个问题：**谁最该先动？**
 * 这个问题不能靠感觉，因为"前端都差"这句话本身不含信息 —— 差在哪里、差多少、有没有强制力，
 * 三个项目可能完全不同（有的是没基座，有的是有基座没人用）。
 *
 * 所以本脚本只做一件事：**把每个项目的前端现状量成可复算的数字，并逐条列出"掉队项"。**
 *
 * ## 三条硬边界（与方寸既有只读模块同一条铁律）
 *
 * ① **只读**：只 readdir / readFile。不写任何项目仓库、不跑构建、不装依赖、不修改配置。
 * ② **不猜**：认不出形态就说「认不出」；路径不在就说「路径不存在」；绝不回退默认值假装正常。
 * ③ **不打分**：不给 0-100 分。分数是假精确 —— 它会把"473 个裸 button"和"缺少 lint"
 *    压成同一个数字，而这两件的修法完全不同。只给**逐项事实 + 一个门槛判断**。
 *
 * ## 判据（它自己怎么算"掉队"）
 *
 * 每条掉队项都由一个**可解释的阈值**触发，阈值写在 `RULES` 里、打印时一并给出：
 *   - 基座使用率 < 50%            → 「有基座没人用」（最贵的那种：成本已付，收益为零）
 *   - 裸 <button> 数 > 界面文件数 → 「手搓密度过高」
 *   - 无 eslint 配置              → 「无强制力（下一个还会手搓）」
 *   - 硬编码颜色 > 令牌引用       → 「颜色不走令牌」
 *   - 无截图证据目录              → 「没有目检证据」
 *
 * 跑法:
 *   node scripts/fe-audit.cjs              # 全部项目
 *   node scripts/fe-audit.cjs 方寸 司天     # 只看这几个（按项目名或 id 子串匹配）
 *   node scripts/fe-audit.cjs --json       # 机读输出（给别的脚本用）
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')

// ── 扫描时一律跳过的目录（构建产物 / 依赖 / VCS）─────────────────────────
const SKIP_DIR = /(^|[\\/])(node_modules|\.git|dist|build|\.next|out|vendor|Temp|_archive|release|pkg)([\\/]|$)/

/** 界面文件：这些才承载"看得见的东西" */
const UI_EXT = /\.(vue|jsx|tsx|html|css|scss)$/

function walk(dir, out = [], depth = 0) {
  if (depth > 12) return out
  let items
  try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const it of items) {
    const full = path.join(dir, it.name)
    if (SKIP_DIR.test(full)) continue
    if (it.isDirectory()) walk(full, out, depth + 1)
    else out.push(full)
  }
  return out
}

/**
 * 从 registry.yaml 取项目清单 —— **不在脚本里硬编码项目表**。
 * 理由与 `tripBoard.ts` 同一条：零硬编码项目清单，项目由登记表推导。
 */
function projects() {
  const p = path.join(ROOT, 'registry.yaml')
  if (!fs.existsSync(p)) return { ok: false, reason: '找不到 registry.yaml', list: [] }
  const text = fs.readFileSync(p, 'utf8')
  const list = []
  let cur = null
  for (const line of text.split('\n')) {
    const idM = line.match(/^\s*-?\s*id:\s*(.+?)\s*$/)
    const nameM = line.match(/^\s*-?\s*name:\s*(.+?)\s*$/)
    const repoM = line.match(/^\s*-?\s*repo:\s*(.+?)\s*$/)
    if (idM) { cur = { id: idM[1].replace(/^["']|["']$/g, ''), name: '', repo: '' }; list.push(cur) }
    else if (nameM && cur && !cur.name) cur.name = nameM[1].replace(/^["']|["']$/g, '')
    else if (repoM && cur && !cur.repo) cur.repo = repoM[1].replace(/^["']|["']$/g, '')
  }
  return { ok: true, list: list.filter((x) => x.repo) }
}

/** 读 package.json（可能不在根目录：方寸的在 desktop/ 下） */
function findPackageJson(repo) {
  const cands = ['package.json', 'desktop/package.json', 'app/package.json', 'web/package.json']
  for (const c of cands) {
    const p = path.join(repo, c)
    if (fs.existsSync(p)) {
      try { return { path: c, json: JSON.parse(fs.readFileSync(p, 'utf8')) } } catch { return { path: c, json: null } }
    }
  }
  return null
}

const hasFile = (repo, names) => names.find((n) => fs.existsSync(path.join(repo, n))) || ''

/** 数一个文件里某模式出现次数 */
function countIn(files, re, opts = {}) {
  let n = 0
  const hits = []
  for (const f of files) {
    let t
    try { t = fs.readFileSync(f, 'utf8') } catch { continue }
    if (opts.stripComments) t = t.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const m = t.match(re)
    if (m) { n += m.length; hits.push({ file: path.relative(ROOT, f), n: m.length }) }
  }
  return { n, hits }
}

/** 单个项目体检 —— 只读 */
function audit(proj) {
  const r = { id: proj.id, name: proj.name || proj.id, repo: proj.repo, ok: true, issues: [], facts: {} }
  if (!fs.existsSync(proj.repo)) {
    r.ok = false
    r.reason = '登记的工作目录不存在'
    return r
  }

  const files = walk(proj.repo)
  const uiFiles = files.filter((f) => UI_EXT.test(f))
  const vue = files.filter((f) => /\.vue$/.test(f))
  const html = files.filter((f) => /\.html$/.test(f))
  const css = files.filter((f) => /\.(css|scss)$/.test(f))
  const py = files.filter((f) => /\.py$/.test(f))
  const jsxCount = files.filter((f) => /\.(jsx|tsx)$/.test(f)).length

  const pkg = findPackageJson(proj.repo)
  const deps = pkg && pkg.json ? { ...(pkg.json.dependencies || {}), ...(pkg.json.devDependencies || {}) } : {}

  // ── 形态：说清它是什么，认不出就认不出 ──
  const feats = []
  if (deps.vue) feats.push('vue@' + deps.vue)
  if (deps.react) feats.push('react@' + deps.react)
  if (deps.preact) feats.push('preact@' + deps.preact)
  if (deps.electron) feats.push('electron@' + deps.electron)
  if (deps.vite) feats.push('vite@' + deps.vite)
  // ⚠ 2026-11-17 首版 bug：Quartz 有 63 个 .tsx + package.json，却因为
  //   `deps.react` 不在（它用 preact/preact-render-to-string）被判成
  //   「Python 为主（1 个 .py，无前端构建）」—— **认不出就当没有，是最糟的那种错**。
  //   所以补两条兜底：有 tsx/jsx 就说 tsx 数量；有 package.json 就说包名。
  if (!feats.length && (jsxCount || pkg)) {
    if (jsxCount) feats.push(`${jsxCount} 个 .tsx/.jsx`)
    const dn = pkg && pkg.json && pkg.json.name
    if (dn) feats.push('pkg=' + dn)
  }
  r.facts.shape = feats.length ? feats.join(' + ') + (pkg ? `（${pkg.path}）` : '')
    : html.length && !pkg ? `无构建：${html.length} 个 html + ${css.length} 个 css`
    : py.length ? `Python 为主（${py.length} 个 .py，无前端构建）`
    : '认不出（无 package.json、无 html、无 py）'

  // ── 设计基座：存在 ≠ 被用 ──
  // ⚠ 2026-11-17 首版 bug：按"目录集合大小"数组件，于是方寸那种**扁平放**的
  //   （`ui/Button.vue` 直接躺在 ui 下）被数成 1 个，而司天那种**一分一目录**的
  //   （`ui/button/Button.vue`）被数成 3 个 —— 同一个东西数出两种结果。
  //   改成数**组件文件本身**，两种摆法都认。
  const baseFiles = files.filter((f) =>
    /[\\/]components[\\/]ui[\\/]/.test(f) && /\.(vue|jsx|tsx)$/.test(f)
  )
  const baseComponents = baseFiles.length
  const uiOwner = vue.filter((f) => !/[\\/]components[\\/]ui[\\/]/.test(f))
  const baseUsers = uiOwner.filter((f) => {
    let t; try { t = fs.readFileSync(f, 'utf8') } catch { return false }
    // 引用写法三种都认：相对 `./ui/button`、`../ui/Button`、别名 `components/ui/Button`
    return /from ['"][^'"]*(components\/ui|\.\.?\/ui\/)[^'"]*['"]/.test(t)
  })
  r.facts.uiFiles = uiOwner.length
  r.facts.baseComponents = baseComponents
  const usage = uiOwner.length ? baseUsers.length / uiOwner.length : 0
  r.facts.baseUsage = baseComponents ? `${baseUsers.length}/${uiOwner.length}（${Math.round(usage * 100)}%）` : '无基座'

  // ── 手搓密度：裸 <button> ──
  const bareBtn = countIn(uiOwner, /<button\b/g, { stripComments: true })
  r.facts.bareButtons = bareBtn.n
  r.facts.bareButtonFiles = bareBtn.hits.length

  // ── 硬编码颜色 vs 令牌 ──
  const hardColor = countIn(css.concat(uiOwner.filter((f) => /\.vue$/.test(f))),
    /(?<!var\([^)]*)(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\))/g, { stripComments: true })
  const varUse = countIn(css.concat(uiOwner.filter((f) => /\.vue$/.test(f))), /var\(--[a-z-]+/g)
  r.facts.hardColors = hardColor.n
  r.facts.tokenRefs = varUse.n

  // ── 强制力：有没有 lint（这是"管不管得住"的唯一硬答案）──
  const eslintCfg = hasFile(proj.repo, [
    'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', '.eslintrc', '.eslintrc.js',
    '.eslintrc.json', '.eslintrc.cjs', 'desktop/eslint.config.js', 'desktop/.eslintrc.json',
  ])
  const lintScript = pkg && pkg.json && pkg.json.scripts
    ? Object.keys(pkg.json.scripts).filter((k) => /lint|eslint/.test(k))
    : []
  r.facts.eslint = eslintCfg || '(无)'
  r.facts.lintScript = lintScript.length ? lintScript.join(',') : '(无)'
  const stylelint = hasFile(proj.repo, ['.stylelintrc', '.stylelintrc.json', 'stylelint.config.js'])
  r.facts.stylelint = stylelint || '(无)'

  // ── 令牌集中度：CSS 变量定义在几处 ──
  const tokenDefs = countIn(css, /--[a-z][a-z0-9-]*\s*:/g)
  r.facts.tokenDefs = tokenDefs.n
  r.facts.tokenDefFiles = tokenDefs.hits.length

  // ── 截图证据 ──
  const shotDirs = []
  const seen = new Set()
  for (const f of files) {
    if (/\.(png|jpg|jpeg|webp)$/i.test(f)) {
      const d = path.relative(ROOT, path.dirname(f))
      if (!seen.has(d)) { seen.add(d); shotDirs.push(d) }
    }
  }
  r.facts.screenshotDirs = shotDirs.length

  // ══ 掉队项：每条带阈值（阈值见 RULES）══════════════════════════════
  if (baseComponents === 0 && (vue.length + html.length) >= 5) {
    r.issues.push({
      level: '严重',
      item: '没有设计基座',
      why: `${vue.length} 个 vue / ${html.length} 个 html，但没有 components/ui —— 每个界面都在重新发明按钮`,
      fix: '先立基座（抄 shadcn-vue，别自己造），再谈样式统一',
    })
  }
  if (baseComponents > 0 && usage < 0.5) {
    r.issues.push({
      level: '严重',
      item: '有基座但没人用',
      why: `基座 ${baseComponents} 个，只有 ${baseUsers.length}/${uiOwner.length}（${Math.round(usage * 100)}%）个界面文件引用它 —— 成本已付、收益为零`,
      fix: '这是最不划算的状态：基座建好了却在旁边手搓。优先把引用率拉上去',
    })
  }
  if (bareBtn.n > uiOwner.length) {
    r.issues.push({
      level: '严重',
      item: '手搓 button 密度过高',
      why: `裸 <button> ${bareBtn.n} 个，分布在 ${bareBtn.hits.length} 个文件（界面文件共 ${uiOwner.length} 个）`,
      fix: '不迁基座就永远不会一致；迁之前先让 lint 拦住新增',
    })
  }
  if (!eslintCfg) {
    r.issues.push({
      level: '严重',
      item: '没有 lint 强制力',
      why: '无 eslint 配置 —— 「统一风格」只靠 AI 自觉，下一个界面照样手搓',
      fix: '这是"方寸管不住"的根源。规则进仓库才叫系统解决，写进文档不算',
    })
  }
  if (hardColor.n > varUse.n) {
    r.issues.push({
      level: '中',
      item: '颜色不走令牌',
      why: `硬编码颜色 ${hardColor.n} 处 > 令牌引用 ${varUse.n} 处`,
      fix: '硬编码颜色是"换主题就崩"的根源；先统一到 CSS 变量',
    })
  }
  if (shotDirs.length === 0) {
    r.issues.push({
      level: '中',
      item: '没有界面截图证据',
      why: '仓库里一张界面截图都没有 —— 界面问题只能靠人每次打开才发现',
      fix: '至少留一份目检截图，改前改后各一张',
    })
  }

  r.score = r.issues.filter((i) => i.level === '严重').length
  return r
}

/** 阈值集中在这，打印时一并给出 —— 不许藏着 */
const RULES = [
  '基座使用率 < 50%（有基座却没人用）',
  '裸 <button> 数 > 界面文件数（手搓密度过高）',
  '无 eslint 配置（无强制力）',
  '硬编码颜色 > 令牌引用（颜色不走令牌）',
  '无截图目录（没有目检证据）',
]

function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const filters = args.filter((a) => !a.startsWith('--'))

  const { ok, reason, list } = projects()
  if (!ok) {
    console.error('FAIL  ' + reason + ' —— 体检不出来就别假装体检过了')
    process.exit(2)
  }
  let picked = list
  if (filters.length) {
    picked = list.filter((p) => filters.some((f) => p.id.includes(f) || (p.name || '').includes(f)))
    if (!picked.length) {
      console.error('FAIL  没有任何项目匹配 ' + filters.join(',') + '（能匹配的：' +
        list.map((p) => p.id).join(', ') + '）')
      process.exit(2)
    }
  }

  const results = picked.map(audit)
  if (asJson) {
    console.log(JSON.stringify({ rules: RULES, results }, null, 2))
    return
  }

  // ── 先打印判据：阈值不许藏着 ──
  console.log('=== 判据（每条掉队项都由下面某条阈值触发）===')
  RULES.forEach((r, i) => console.log(`  ${i + 1}. ${r}`))
  console.log('\n（只读：本脚本不写任何项目仓库、不跑构建、不装依赖）\n')

  // ── 总表 ──
  const head = ['项目', '形态', '基座', '基座使用率', '裸button', 'eslint', '严重项']
  const rows = results.map((r) => [
    r.name,
    String(r.facts.shape || (r.ok ? '' : r.reason)).slice(0, 34),
    String(r.facts.baseComponents ?? '-'),
    String(r.facts.baseUsage ?? '-'),
    String(r.facts.bareButtons ?? '-'),
    String(r.facts.eslint || '-'),
    r.ok ? String(r.score) : '跳过',
  ])
  const widths = head.map((h, i) => Math.max(h.length * 2, ...rows.map((r) => String(r[i]).length)))
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ')
  console.log(line(head))
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'))
  rows.forEach((r) => console.log(line(r)))

  // ── 逐项目掉队清单 ──
  console.log('\n=== 掉队清单（按严重项排序）===')
  const ordered = results.filter((r) => r.ok).sort((a, b) => b.score - a.score)
  for (const r of ordered) {
    console.log(`\n── ${r.name}（${r.id}） 严重 ${r.score} 项 ──`)
    if (!r.issues.length) { console.log('   没有触发任何阈值（不等于"好看"，只是没量到硬缺陷）'); continue }
    for (const it of r.issues) {
      console.log(`   [${it.level}] ${it.item}`)
      console.log(`        为什么：${it.why}`)
      console.log(`        怎么改：${it.fix}`)
    }
  }
  const skipped = results.filter((r) => !r.ok)
  if (skipped.length) {
    console.log('\n=== 跳过（说清为什么，不假装正常）===')
    skipped.forEach((r) => console.log(`   ${r.name}：${r.reason}`))
  }

  console.log('\n=== 一句话结论 ===')
  const worst = ordered[0]
  if (!worst || worst.score === 0) {
    console.log('没有一个项目触发严重项。注意：这不等于"前端好"，只说明没量到硬缺陷。')
  } else {
    console.log(`最该先动：${worst.name}（严重 ${worst.score} 项）。`)
    const noLint = ordered.filter((r) => !r.facts.eslint || r.facts.eslint === '(无)')
    if (noLint.length) {
      console.log(`无 lint 强制力的：${noLint.map((r) => r.name).join('、')} —— ` +
        '这些项目里"统一风格"全靠 AI 自觉，是"管不住"的结构原因。')
    }
  }
}

main()
