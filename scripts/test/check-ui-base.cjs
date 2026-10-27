/**
 * UI 基座（shadcn-vue + Tailwind）接线守卫 —— 卡 task-20261011-004
 *
 * 起因：第 ① 步的验收线是「**产物 CSS 逐字节不变**」（零观感回归）。它靠两条硬约束成立，
 * 而这两条**都是能被后人无意改坏的**：
 *   ① `preflight: false` —— 一开就引入全局 line-height 与 `list-style:none`，全仓观感漂移；
 *   ② `content` 不扫 `App.vue` —— App.vue 里有 `.fixed`/`.hidden`/`.block` 这类与 Tailwind
 *      工具类**同名**的老类名，一扫就凭空多出 `.fixed{position:fixed}`，零 diff 当场破功。
 * 所以把"这层接线长什么样"钉成断言，而不是靠注释里的祈祷。
 *
 * 运行：node scripts/test/check-ui-base.cjs
 */
const path = require('path')
const fs = require('fs')

const DESKTOP = path.resolve(__dirname, '../../desktop')
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf-8')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

console.log('== UI 基座接线守卫（卡 20261011-004）==')

// ① Tailwind 配置存在且 preflight 关
let cfg = null
try { cfg = require(path.join(DESKTOP, 'tailwind.config.js')) } catch (e) { /* 下面断言会报 */ }
check('★ tailwind.config.js 存在且能被 require', !!cfg && typeof cfg === 'object')
check('★★ preflight 必须关（开了会全局改 line-height + 干掉 Markdown 列表符号）',
  !!cfg && cfg.corePlugins && cfg.corePlugins.preflight === false,
  cfg ? JSON.stringify(cfg.corePlugins) : 'no config')

// ② content 只能落在 `src/renderer/components/` 里，**绝不匹配 App.vue**（永久底线）
{
  const content = (cfg && cfg.content) || []
  const list = Array.isArray(content) ? content : (content.files || [])
  // ⚠ 判据不能写成"glob 里有没有 App.vue" —— 那条太字面，`./src/renderer/**/*.{vue,ts,js}`
  //   能绕过它却照样把 App.vue 全扫一遍（反例当场验过）。正解是**正向白名单**：
  //   每个 glob 都必须落在 `src/renderer/components/` 里面。
  //   ⚠ 2026-10-14（第 ④ 步）：名单从「只许 components/ui/」放宽到「只许 components/」——
  //     因为承载视图的组合组件 `components/DecisionBoard.vue` 也在 components/ 下。
  //     **放宽的是目录，不是底线**：App.vue 依然一个 glob 都不许碰到。
  const scopeBad = list.filter(
    (g) => !String(g).includes('src/renderer/components/') || /App\.vue/.test(String(g))
  )
  check('★★ content 只扫 src/renderer/components/ 下、且绝不匹配 App.vue（扫到 App.vue 的话，`.fixed`/`.hidden` 这类同名老类名会凭空生成工具类，零 diff 破功）',
    list.length > 0 && scopeBad.length === 0, JSON.stringify(list))

  // ★ 覆盖完整性：components/ 下**每个**源码文件都得被某个 glob 覆盖到。
  //   漏一个 = 那个组件用到的工具类不会被生成 → 界面**静默没样式**（CSS 不报错，最像"看起来没问题"）。
  const exts = new Set(['.vue', '.ts', '.js'])
  const globExts = new Set()
  for (const g of list) {
    const s = String(g)
    const brace = s.match(/\{([^}]*)\}/)
    if (brace) for (const e of brace[1].split(',')) globExts.add('.' + e.trim())
    else if (/\.[a-z]+$/.test(s)) globExts.add(s.slice(s.lastIndexOf('.')))
  }
  const compFiles = []
  const walkComp = (dir) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walkComp(p)
      else if (exts.has(path.extname(e.name))) compFiles.push(p)
    }
  }
  walkComp(path.join(DESKTOP, 'src', 'renderer', 'components'))
  const usesCompDir = list.some((g) => String(g).includes('src/renderer/components/'))
  const uncovered = compFiles.filter((f) => !usesCompDir || !globExts.has(path.extname(f)))
  check('★ components/ 下每个源码文件都被 content 覆盖（漏掉 = 类名不生成、界面静默没样式）',
    compFiles.length > 0 && uncovered.length === 0,
    `files=${compFiles.length} globExts=[${[...globExts]}] uncovered=${uncovered.map((f) => path.basename(f)).join(',')}`)
}

// ③ 入口 css 只出 utilities 层
{
  const css = read('src/renderer/tailwind.css')
  check('★ tailwind.css 只写 @tailwind utilities（不加 base / components）',
    /@tailwind\s+utilities/.test(css) && !/@tailwind\s+(base|components)/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')))
}

// ④ vite 内联 postcss + 配置绝对路径 + **不用 autoprefixer**
{
  const vcRaw = read('vite.config.ts')
  // ⚠ 必须先掏空注释再判：本仓在 vite.config.ts 里**特意写了**"为什么不用 autoprefixer"的长注释，
  //   不掏空就会把那段解释当成"用了它"（守卫被自己的文档绊倒）。
  const vc = vcRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  check('★ vite.config.ts 内联 postcss（不依赖就近发现）', /postcss:\s*\{/.test(vc))
  check('★ tailwind 配置走绝对路径（path.resolve(__dirname, ...)）',
    /tailwindcss\(\{\s*config:\s*path\.resolve\(/.test(vc.replace(/\s+/g, ' ')))
  check('★★ 不用 autoprefixer（实测只加 22 条 Electron 空转前缀，且直接破坏"零 diff"验收）',
    !/autoprefixer/i.test(vc))
}

// ⑤ 入口引了 tailwind.css；三件套依赖在位
{
  check('★ main.ts 引了 tailwind.css', /import\s+['"]\.\/tailwind\.css['"]/.test(read('src/renderer/main.ts')))
  const pkg = JSON.parse(read('package.json'))
  const deps = pkg.dependencies || {}
  const dev = pkg.devDependencies || {}
  const missing = ['class-variance-authority', 'clsx', 'tailwind-merge'].filter((d) => !deps[d])
  check('★ shadcn 三件套在 dependencies（cva / clsx / tailwind-merge）', missing.length === 0,
    'missing=' + JSON.stringify(missing))
  check('  tailwindcss 在 devDependencies', !!dev.tailwindcss, String(dev.tailwindcss))
}

// ⑥ 第 ② 步：`--ui-*` token 映射（2026-10-14）
//
// 为什么单独钉：这层最容易出的**不是**"少写一个变量"，而是
//   ① 复制色值而不是 `var()` 链 —— 主题一切就分叉（"主题改了、shadcn 忘了改"）；
//   ② `accent` 接错方向 —— 方寸 `--accent`(品牌主色) 与 shadcn `--ui-accent`(悬停面)
//      同名不同义，接错的表现是**白字压浅染底直接消失**（不是"好看不好看"）；
//   ③ 引用一个**根本不存在的**令牌名 —— CSS 不会报错，元素静默变黑（2026-10-13 踩过同款）。
{
  const app = read('src/renderer/App.vue')
  const uiDecls = [...app.matchAll(/--(ui-[a-z0-9-]+)\s*:\s*([^;]+);/g)]
  const defined = new Set([...app.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]))
  const map = {}
  for (const m of uiDecls) map[m[1]] = m[2].trim()

  check('★ 第 ② 步 `--ui-*` 映射块存在（≥ 20 个令牌）', uiDecls.length >= 20, 'n=' + uiDecls.length)

  // 每个 `var(--x)` 的 x 必须是 App.vue 里真实定义过的令牌（防"静默变黑"）
  const missing = []
  for (const [k, v] of Object.entries(map)) {
    for (const r of v.matchAll(/var\(\s*--([a-z0-9-]+)\s*\)/g)) {
      if (!defined.has(r[1])) missing.push(`${k} → --${r[1]}`)
    }
  }
  check('★★ `--ui-*` 引用的每个令牌都真实存在（引用不存在的名字 = 静默变黑）',
    missing.length === 0, missing.join('；'))

  // 方向被钉死：primary ← 方寸 --accent；accent ← 方寸 --tint
  check('★★ `--ui-primary` 指向方寸品牌主色 `--accent`（不是 shadcn 的 accent）',
    /^var\(\s*--accent\s*\)$/.test(map['ui-primary'] || ''), map['ui-primary'])
  check('★★ `--ui-accent` 指向悬停面 `--tint`（接错 = 白字压浅底消失）',
    /^var\(\s*--tint\s*\)$/.test(map['ui-accent'] || ''), map['ui-accent'])
  check('★ 本仓扩展 `--ui-success` / `--ui-warning`（shadcn 没有这两个语义色）',
    !!map['ui-success'] && !!map['ui-warning'],
    `success=${map['ui-success']} warning=${map['ui-warning']}`)

  // 只许一份：`data-theme` 块里复制 `--ui-*` = 主题一分叉就漏
  const themeBodies = [...app.matchAll(/:root\[data-theme='[a-z]+'\]\s*\{([\s\S]*?)\}/g)].map((m) => m[1])
  const copied = themeBodies.filter((b) => /--ui-[a-z0-9-]+\s*:/.test(b))
  check('★★ `--ui-*` 只在 `:root` 定义一次（主题块里复制色值 = 分叉源头）',
    themeBodies.length > 0 && copied.length === 0,
    `themeBlocks=${themeBodies.length} copied=${copied.length}`)
}

// ⑦ Tailwind 关着 preflight → 组件里的原生表单控件必须自己兜底
//
// 为什么单列一条：`preflight:false` 是本仓的**有意选择**（它会全局改 line-height、干掉列表符号），
// 代价是 `<button>` / `<input>` / `<select>` 的 **UA 默认外观全都还在** —— 系统 UI 字体 + 默认边框。
// 只写 background/border 而不写字体的组件，屏幕上表现为"这块字跟旁边不是一个字体"，
// 而 **所有断言照样全绿**。2026-10-14 加决策视图与右键菜单时连踩两次，都是截图目检才看出来的。
//
// ⚠ 这是**文件级**判据（文件里有控件就必须出现 `font-[inherit]`）—— 一个文件里两个控件只兜底一个
//   它抓不住。之所以不做成"逐个控件"是静态文本里控件与类串的对应关系不可靠（cva/cn/动态拼接）。
//   补得上的部分靠截图目检；这条只负责拦住"完全没兜底"。
{
  const files = []
  const walkVue = (dir) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walkVue(p)
      else if (e.name.endsWith('.vue')) files.push(p)
    }
  }
  walkVue(path.join(DESKTOP, 'src', 'renderer', 'components'))
  const NATIVE = /<input\b|<select\b|<textarea\b|<button\b|as="button"/
  const bad = []
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf-8')
    if (!NATIVE.test(s)) continue
    if (!/font-\[inherit\]/.test(s)) bad.push(path.basename(f))
  }
  check('★★ 用了原生表单控件的组件都写了 `font-[inherit]`（preflight 关着 → 不写就用系统字体，只有肉眼看得出来）',
    files.length > 0 && bad.length === 0, bad.length ? '缺兜底：' + bad.join(',') : '')
}

// ── 同卡同貌（2026-10-27）：Card 组件与 App.vue 的 .card 必须逐值一致 ──────────
// 暮雨原话：「UI 统一依旧迟迟未做，决策仍为另一套带阴影的 UI 风格」。
// 真因不是"没统一"，而是**统一到两个不同的数值上**：新组件 Card 是 14px 圆角 + 独立阴影，
// 看板老卡 .card 是 9px + 0 1px 2px rgba(90,90,130,.05) —— 同一屏两种圆角两种阴影，
// 看上去就是两套 UI。这里钉住"两边必须相等"，改一边不改另一边就红。
{
  const cardVue = fs.readFileSync(path.join(DESKTOP, 'src', 'renderer', 'components', 'ui', 'Card.vue'), 'utf-8')
  const appVue = fs.readFileSync(path.join(DESKTOP, 'src', 'renderer', 'App.vue'), 'utf-8').replace(/\r\n/g, '\n')
  // ⚠ 只在 `cn(...)` 之后找：文件头注释里也写着历史值（`rounded-[14px]`），
  //   直接全文匹配会先命中注释 —— 判据抓错对象，绿红都不可信。
  const classStr = cardVue.slice(cardVue.indexOf('cn('))
  const mR = /rounded-\[(\d+)px\]/.exec(classStr)
  const mS = /shadow-\[0_(\d+)px_(\d+)px_rgba\((\d+),(\d+),(\d+),([0-9.]+)\)\]/.exec(classStr)
  const block2 = /\.card \{([\s\S]*?)\}/.exec(appVue)
  const oR = block2 ? /border-radius:\s*(\d+)px/.exec(block2[1]) : null
  const oS = block2 ? /box-shadow:\s*0 (\d+)px (\d+)px rgba\((\d+),(\d+),(\d+),([0-9.]+)\)/.exec(block2[1]) : null

  check('★ Card 组件写了圆角与阴影（否则这条判据等于没测）',
    !!mR && !!mS, 'r=' + (mR && mR[1]) + ' s=' + !!mS)
  check('★ 老 .card 也解析到了圆角与阴影（App.vue 里那个块还在）', !!oR && !!oS)
  if (mR && oR) {
    check('★★ 新 Card 与老 .card **圆角相同**（同一屏两种圆角 = 看起来两套 UI）',
      mR[1] === oR[1], 'Card=' + mR[1] + 'px vs .card=' + oR[1] + 'px')
  }
  if (mS && oS) {
    const same = mS[1] === oS[1] && mS[2] === oS[2]
      && mS[3] === oS[3] && mS[4] === oS[4] && mS[5] === oS[5] && Number(mS[6]) === Number(oS[6])
    check('★★ 新 Card 与老 .card **阴影同一档**（偏移/模糊/RGBA 逐值相等）', same,
      'Card=' + mS[1] + ' ' + mS[2] + ' rgba(' + mS[3] + ',' + mS[4] + ',' + mS[5] + ',' + mS[6] + ')'
      + ' vs .card=' + oS[1] + ' ' + oS[2] + ' rgba(' + oS[3] + ',' + oS[4] + ',' + oS[5] + ',' + oS[6] + ')')
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) { console.log('\n失败项：'); for (const f of failures) console.log(' -', f) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
