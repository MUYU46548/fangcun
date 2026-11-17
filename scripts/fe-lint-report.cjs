#!/usr/bin/env node
/**
 * ESLint 违规清单汇总 · A1a 交付物（2026-11-17）
 *
 * ## 为什么需要它
 *
 * 暮雨定的 A1a：「先跑一遍看实际违规数、误报数」。`npx eslint --format json` 吐的是
 * 一个几 MB 的 JSON，人读不了；而"哪些该改、哪些本来就该豁免"这个判断，
 * **必须基于可核对的清单**，不能基于一句"差不多 500 个"。
 *
 * 所以本脚本只做**汇总与分类**，不改代码、不判是非：
 *   ① 按规则分组（哪种违规最多）
 *   ② 裸 button 按文件排序（从哪修起）
 *   ③ **按类名初判"像是非操作按钮"** —— 折叠头 / 计数徽章 / 整行可点项，
 *      这些就是 `check-ui-freeze` 里 43 条 ALLOW 的老先例，不该硬换成 Button
 *   ④ 与 `scripts/fe-audit.cjs` 的独立计数对账（两套代码数同一个东西，差一条都要说）
 *
 * ## 它不做的事
 *
 * - 不判断"这个 button 该不该迁移"（那是人判断，脚本只把候选分堆）
 * - 不给分数（分数是假精确）
 *
 * 用法：
 *   cd desktop && npx eslint src/renderer --format json -o ../.fe-lint.json
 *   node scripts/fe-lint-report.cjs .fe-lint.json
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

/** 类名像"非操作按钮"的：折叠区头 / 计数徽章 / 整行可点项 / 标签片
 *
 * ⚠ 2026-11-17 首版误判：原来的正则含 `nav` / `link`，于是 `class="ghost nav-back"`
 *   （顶栏「← 返回」，**是真按钮**）被判成"非操作按钮"。
 *   现在去掉 `nav`（顶栏按钮全是真按钮），并排除 `*-back` / `ico`（图标按钮也是真按钮）。
 *   这条只是**初判**，最终得人看 —— 但它不该先把真按钮划进豁免堆。 */
const NON_BUTTON_HINT = /(chip|tab|row|item|cell|head|toggle|card|pill|tag|opt|deck|dot|-bar|picker|hit|smap-pending)/i
/** 命中上面但其实是真按钮的，扣回来 */
const REAL_BUTTON_HINT = /(nav-back|nav ico|\bico\b|sync-btn|qn-entry|btn)/i

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

/** 取源码某一行（给清单附上下文，人不用另开文件） */
function lineOf(file, n) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    return (lines[n - 1] || '').trim().slice(0, 110)
  } catch { return '' }
}

function main() {
  const arg = process.argv[2] || path.join(ROOT, '.fe-lint.json')
  const data = readJson(arg)
  if (!data) {
    console.error(`FAIL  读不到 ESLint JSON：${arg}`)
    console.error('      先跑：cd desktop && npx eslint src/renderer --format json -o ../.fe-lint.json')
    process.exit(2)
  }

  // ── 汇总 ──────────────────────────────────────────────────────────
  const byRule = new Map()
  const buttons = []
  const selects = []
  const hardColors = []
  let fatal = 0

  for (const f of data) {
    for (const m of f.messages) {
      if (!m.ruleId) { fatal++; continue }
      byRule.set(m.ruleId, (byRule.get(m.ruleId) || 0) + 1)
      const item = { file: path.relative(ROOT, f.filePath), line: m.line, text: lineOf(f.filePath, m.line) }
      if (m.ruleId === 'vue/no-restricted-syntax') {
        (String(m.message).includes('button') ? buttons : selects).push(item)
      } else if (m.ruleId === 'no-restricted-syntax') {
        hardColors.push(item)
      }
    }
  }

  console.log('=== A1a · ESLint 事实清单 ===')
  console.log(`扫描文件 ${data.length} 个 · 可归因违规 ${[...byRule.values()].reduce((a, b) => a + b, 0)} 条 · parse 错误 ${fatal} 条\n`)

  if (fatal) {
    console.log(`⚠ 有 ${fatal} 条 parse 错误 —— 那些文件**没被检查**，下面的统计不完整。`)
    console.log('  先修 parser 配置再看结论（否则这是假绿）。\n')
  }

  console.log('── 按规则 ──')
  for (const [k, v] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(5)}  ${k}`)
  }

  // ── 裸 button 分布 ───────────────────────────────────────────────
  const byFile = new Map()
  for (const b of buttons) byFile.set(b.file, (byFile.get(b.file) || 0) + 1)
  console.log(`\n── 裸 <button> 共 ${buttons.length} 个，分布在 ${byFile.size} 个文件 ──`)
  console.log('   从哪修起（前 12）：')
  for (const [f, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`   ${String(n).padStart(4)}  ${f}`)
  }

  // ── 按类名初判：哪些"可能本来就不该是 Button" ────────────────────
  const maybeNotButton = buttons.filter((b) => NON_BUTTON_HINT.test(b.text) && !REAL_BUTTON_HINT.test(b.text))
  const likelyReal = buttons.length - maybeNotButton.length
  console.log(`\n── 初判（按类名，不是结论） ──`)
  console.log(`  像"非操作按钮"（折叠头/徽章/整行可点）：${maybeNotButton.length}`)
  console.log(`  像是真按钮（该迁移）：            ${likelyReal}`)
  if (maybeNotButton.length) {
    console.log('  样例（这些要先判断，别硬换 Button —— Button 有 hover 底色与固定高度，会把列表项压垮）：')
    for (const b of maybeNotButton.slice(0, 6)) {
      console.log(`    ${b.file}:${b.line}`)
      console.log(`      ${b.text}`)
    }
  }

  // ── 与独立体检对账（两套代码数同一个东西）────────────────────────
  console.log('\n── 与 scripts/fe-audit.cjs 对账（两套代码独立数）──')
  let audit = null
  try {
    const { execFileSync } = require('child_process')
    audit = JSON.parse(execFileSync(process.execPath,
      [path.join(ROOT, 'scripts', 'fe-audit.cjs'), '--json', '方寸'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
  } catch (e) {
    console.log('  （跑不动 fe-audit，跳过对账）')
  }
  if (audit) {
    const fc = (audit.results || [])[0]
    const other = fc && fc.facts ? fc.facts.bareButtons : null
    const ok = other === buttons.length
    console.log(`  eslint 数：${buttons.length}`)
    console.log(`  fe-audit 数：${other}`)
    console.log(ok ? '  ✓ 一致' : '  ⚠ 不一致 —— 两套代码对同一个事实给出了两个数，必须查清哪个错（别挑好看的那个用）')
  }

  // ── 硬编码颜色 ───────────────────────────────────────────────────
  console.log(`\n── 硬编码颜色 ${hardColors.length} 处 ──`)
  for (const c of hardColors.slice(0, 5)) console.log(`  ${c.file}:${c.line}  ${c.text}`)

  console.log('\n=== 这不是门槛，是账 ===')
  console.log('规则现在是 warn：不拦构建、不拦提交。要不要转 error、要不要接 build，')
  console.log('等你看完这份账再定（A1b）。')
}

main()
