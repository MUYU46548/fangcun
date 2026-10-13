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

// ② content 只许扫 components/ui/ 底下（第 ① 步零 diff 的前提）
{
  const content = (cfg && cfg.content) || []
  const list = Array.isArray(content) ? content : (content.files || [])
  // ⚠ 判据不能写成"glob 里有没有 App.vue" —— 那条太字面，`./src/renderer/**/*.{vue,ts,js}`
  //   能绕过它却照样把 App.vue 全扫一遍（反例当场验过）。正解是**正向白名单**：只认 components/ui。
  const outOfScope = list.filter((g) => !String(g).includes('components/ui'))
  check('★★ content 只扫 components/ui/（扫到 App.vue 的话，`.fixed`/`.hidden` 这类同名老类名会凭空生成工具类，零 diff 破功）',
    list.length > 0 && outOfScope.length === 0, JSON.stringify(list))
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

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) { console.log('\n失败项：'); for (const f of failures) console.log(' -', f) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
