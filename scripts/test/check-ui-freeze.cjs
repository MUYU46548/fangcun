/**
 * UI 基座 · 冻结手搓守卫（卡 task-20261011-004 的 0.7.0 第一刀）
 *
 * 为什么是这个形状：
 *   迁移是持续活，但"不许再新增手搓"必须一次钉死 —— 否则边迁边加，永远迁不完。
 *   11-07 当天就交了一笔税：想法页新加 `.idea-task` 没样式，`check-button-styles` 当场变红。
 *
 * 判据（**冻结**，不是"逐条猜有没有样式"）：
 *   · 扫 `views/` + `components/` 里 `<button>` 与浮层元素的**静态自定义类名**；
 *   · 与基线 `ui-freeze-baseline.json` 比对：
 *       - 基线里有的 = 历史债，允许存在、也允许迁走（减少会打印进度）；
 *       - 基线里没有的 → **红**，除非在 ALLOW 里逐条登记原因（硬约束③：显式跳过 + 打印原因）；
 *   · 不看"有没有 CSS 规则"：有规则的手搓**也是手搓**，冻结的对象是"新增自定义类"本身。
 *
 * 用法：
 *   node scripts/test/check-ui-freeze.cjs             # 守卫
 *   node scripts/test/check-ui-freeze.cjs --snapshot  # 重新生成基线（只在真正迁完一批后跑）
 *
 * ⚠ 基线只许**变短**，不许靠重刷基线把新增的手搓洗白 —— 重刷要在提交信息里说清迁走了哪些。
 */
const fs = require('fs')
const path = require('path')
const DESKTOP = path.resolve(__dirname, '../../desktop')
const RENDERER = path.join(DESKTOP, 'src/renderer')
const BASELINE = path.join(__dirname, 'ui-freeze-baseline.json')
const SNAPSHOT = process.argv.includes('--snapshot')

/** 共享按钮类：全局规则自带，不算手搓 */
const SHARED = new Set(['ghost', 'pri', 'ok', 'danger', 'warning'])

/** Tailwind 原子类前缀（含任意值 / 变体的另有判据） */
const TW_PREFIX = new Set((
  'p m px py pt pb pl pr mx my mt mb ml mr w h min max text bg border rounded flex grid gap space ' +
  'items justify self order col row overflow cursor font leading tracking opacity shadow transition ' +
  'duration ease absolute relative fixed sticky inset top left right bottom z block inline hidden table ' +
  'whitespace truncate underline antialiased shrink grow basis rotate scale translate divide ring outline ' +
  'object aspect select pointer list align break capitalize uppercase lowercase numeric italic sr-only ' +
  'appearance resize transform filter backdrop placeholder disabled hover focus active group peer first last ' +
  'odd even grid-cols grid-rows flex-col flex-row flex-wrap flex-nowrap space-x space-y'
).split(/\s+/).filter(Boolean))

/** 明确登记的新增豁免：类名 → 为什么仍手搓（写了原因才算数，空理由直接红） */
const ALLOW = {
  // 例：'some-new-btn': '2026-11-07 · 这个按钮带 Canvas 吸附逻辑，基座 Button 不支持，等 W6 第二刀',
  'archd-cancel': '2026-11-07 · 架构图生成取消按钮（W5 第一刀新增），基座 Button 不支持 danger+busy 组合；随 W5 一起迁',
  'qd-row': '2026-11-07 · 待校验清单整行可点（伪按钮），是列表项不是 Button；随问卷迁移一起换',
}

function isTailwind(c) {
  if (!c || c.length > 80) return false
  if (/[[:/!]/.test(c)) return true                 // font-[inherit] / hover:x / w-1/2 / !mt-2
  if (/^\d/.test(c)) return true
  const head = c.split('-')[0]
  if (TW_PREFIX.has(head)) return true
  // 连字符前缀组合（grid-cols-3 / space-x-2 / flex-col 等）
  if (c.startsWith('grid-') || c.startsWith('space-') || c.startsWith('flex-')) return true
  return false
}

function vueFiles() {
  const out = []
  for (const d of ['views', 'components']) {
    const p = path.join(RENDERER, d)
    if (!fs.existsSync(p)) continue
    for (const f of fs.readdirSync(p)) {
      if (f.endsWith('.vue') && fs.statSync(path.join(p, f)).isFile()) out.push(path.join(d, f))
    }
  }
  return out
}

/** 只取模板段里的静态 class="..."；:class / v-bind:class 的动态表达式一律不解析 */
function collect(file) {
  const text = fs.readFileSync(path.join(RENDERER, file), 'utf-8').replace(/\r\n/g, '\n')
  const tplEnd = text.indexOf('<style')
  const tpl = (tplEnd >= 0 ? text.slice(0, tplEnd) : text).replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
  const found = new Set()
  // 按钮 + 浮层（div/section 且类名里带 modal/overlay/dialog/mask）
  const tagRe = /<(button|div|section|aside)\b([^>]*)>/g
  let m
  while ((m = tagRe.exec(tpl))) {
    const tag = m[1]
    const attrs = m[2]
    const cm = attrs.match(/(?:^|\s)class\s*=\s*"([^"]*)"/) || attrs.match(/(?:^|\s)class\s*=\s*'([^']*)'/)
    if (!cm) continue
    const list = cm[1].split(/\s+/).filter(Boolean)
    const overlayish = tag !== 'button' && list.some((c) => /-(modal|overlay|dialog|mask)\b|\b(modal|overlay|dialog|mask)\b/.test(c))
    if (tag !== 'button' && !overlayish) continue
    for (const c of list) {
      if (SHARED.has(c) || isTailwind(c)) continue
      if (!/^[a-z][a-z0-9_-]*$/i.test(c)) continue   // 跳过 Vue 表达式残片
      found.add(c)
    }
  }
  return found
}

function main() {
  const current = new Map()
  for (const f of vueFiles()) {
    for (const c of collect(f)) {
      if (!current.has(c)) current.set(c, [])
      current.get(c).push(f)
    }
  }
  const names = [...current.keys()].sort()

  if (SNAPSHOT) {
    fs.writeFileSync(BASELINE, JSON.stringify({ note: '手搓类名基线；只许变短。重刷要在提交信息里说清迁走了哪些。', classes: names }, null, 2) + '\n', 'utf-8')
    console.log(`已写基线：${names.length} 个类 → ${path.relative(path.resolve(__dirname, '../..'), BASELINE)}`)
    return
  }

  console.log('== UI 基座 · 冻结手搓 ==')
  let base = { classes: [] }
  if (fs.existsSync(BASELINE)) {
    try { base = JSON.parse(fs.readFileSync(BASELINE, 'utf-8')) } catch { /* 下面按空基线处理并判红 */ }
  } else {
    console.log('⚠ 基线文件不存在 —— 先跑一次 `--snapshot`（没有基线 = 无从判断"新增"）')
  }
  const known = new Set(Array.isArray(base.classes) ? base.classes : [])
  let pass = 0, fail = 0
  const failures = []
  const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS  ${name}`) }
    else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  }

  check('★ 基线非空且是数组（空集上 every 恒真 = 守卫形同虚设）', known.size > 0, `基线 ${known.size} 个类`)
  check('★ 本次扫描确实扫到了按钮/浮层（假桩返回空数组 = 这一块等于没测）', names.length > 0, `扫到 ${names.length} 个类`)

  const added = names.filter((c) => !known.has(c))
  for (const c of added) {
    const reason = String(ALLOW[c] || '').trim()
    if (reason) {
      // 硬约束③：显式跳过 + 打印原因，不静默放行
      console.log(`SKIP  .${c} —— 已登记豁免：${reason}`)
      pass++
    } else {
      check(`★★ 新增手搓类 .${c}（${current.get(c).slice(0, 2).join(', ')}）`, false,
        '基线里没有、ALLOW 里也没写原因 —— 请用 components/ui/{Button,Card,Input,Badge}，或登记豁免并写清为什么')
    }
  }
  if (!added.length) check('★★ 没有新增手搓类（冻结生效）', true)

  const gone = [...known].filter((c) => !current.has(c))
  if (gone.length) console.log(`  迁移进度：基线里 ${gone.length} 个类已消失 → ${gone.slice(0, 8).join(', ')}${gone.length > 8 ? ' …' : ''}`)
  else console.log(`  迁移进度：暂无（基线 ${known.size} 个类仍在）`)

  for (const [c, reason] of Object.entries(ALLOW)) {
    check(`★ 豁免 .${c} 写了原因且确实在用（不许留空豁免）`, !!reason && current.has(c), reason || '没写原因')
  }

  // ── 迁移判据：不能只立"不许新增"的门禁，自己也得真用基座 ──────────
  // 第一刀迁的是**本轮新加**的三块界面按钮（问卷汇总 / 待校验 / 想法页），
  // 它们没有历史观感包袱；历史按钮按同一模式分批，不一次性爆改。
  const MIGRATED = [
    ['views/IdeasView.vue', 1, '想法页 · 做成任务卡'],
    ['components/QuestionnaireModal.vue', 3, '问卷汇总 · 落成任务卡 / 待校验 · 仍成立 / 已被推翻'],
  ]
  for (const [file, min, what] of MIGRATED) {
    const p = path.join(RENDERER, file)
    const src = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''
    const uses = (src.match(/<Button\b/g) || []).length
    check(`★★ ${what} 真用了 components/ui/Button.vue（不是只立守卫不迁移）`,
      /import Button from ['"][^'"]*ui\/Button\.vue['"]/.test(src) && uses >= min,
      `import=${/import Button from/.test(src)} <Button>=${uses}（要求 ≥${min}）`)
  }

  console.log('')
  if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
