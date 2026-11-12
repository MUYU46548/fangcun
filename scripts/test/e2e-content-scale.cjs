/**
 * 内容量闸（contentScale.ts）回归 —— 纯函数，脱浏览器真跑。
 *
 * 由来：暮雨 2026-11-12
 *   「那两间房纯属垃圾，而且连整个游戏的玩法本身可能都有问题，撑不起那么大的内容量」
 *
 * 这条闸钉的**不是质量**，是**顺序**：核心没被判过"立得住"，就不许铺几小时内容。
 * 所以断言要能区分两件事：
 *   ① 小原型（≤ 上限）永远放行 —— 否则连验证都做不了；
 *   ② 大内容量：没判词 → 拦；判词=垃圾 → 拦；判词=立得住/能玩 → 放。
 *
 * 另配**反例自证**：把上限调大，同一条大内容量必须从"拦"变"放" ——
 * 证明断言咬的是规则而不是巧合。
 */
const path = require('path')
const fs = require('fs')
const { mkTmpPath } = require('./_tmp.cjs')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(ROOT, 'desktop')
const SRC = path.join(DESKTOP, 'src', 'shared', 'contentScale.ts')
const OUT = mkTmpPath('fc-contentscale-')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function compile() {
  fs.mkdirSync(OUT, { recursive: true })
  execFileSync(process.execPath, [
    path.join(DESKTOP, 'node_modules', 'typescript', 'bin', 'tsc'),
    SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'ES2020',
    '--strict', 'false', '--skipLibCheck',
  ], { cwd: DESKTOP, stdio: 'pipe' })
  const js = path.join(OUT, 'contentScale.js')
  if (!fs.existsSync(js)) throw new Error('编译产物不存在: ' + js)
  return require(js)
}

function main() {
  console.log('== 内容量闸 e2e ==')
  const g = compile()

  // ── ① 抽取：真实设计稿里出现过的写法 ──────────────────────────────
  // ⚠ 「4–5 小时」按**上限 5** 算（判断风险要按最坏情况）；第一版断言写成 4，是断言错了不是代码错了。
  check('★ 抽得出「总时长 4–5 小时」，且按上限 5 计（判断风险按最坏）',
    g.extractScale('总时长 4–5 小时。三幕。').hours === 5,
    JSON.stringify(g.extractScale('总时长 4–5 小时。三幕。')))
  check('★ 抽得出「三幕」',
    g.extractScale('总时长 4–5 小时。三幕。').acts === 3)
  check('★ 抽得出中文数字「七（房间）」这种把量词塞进括号的写法',
    g.extractScale('七（房间）× 三幕都照同一形状写').rooms === 7,
    JSON.stringify(g.extractScale('七（房间）× 三幕都照同一形状写')))
  check('★ 也抽得出「七间房」',
    g.extractScale('一共七间房').rooms === 7,
    JSON.stringify(g.extractScale('一共七间房')))
  check('★ 抽得出「20–30 分钟」里的 20（分钟不算小时，不该被当小时）',
    g.extractScale('单次时长 20–30 分钟').hours === undefined,
    JSON.stringify(g.extractScale('单次时长 20–30 分钟')))
  check('★ 没写量的文本抽出来是空的（不瞎猜）',
    JSON.stringify(g.extractScale('把按钮颜色改成品牌紫')) === '{}')

  // ── ② 闸的核心行为：真实那份"4–5 小时三幕"必须被拦 ─────────────────
  const REAL = '总时长 4–5 小时。三幕。玩家在避难所里走一年，发三枚瓶子。'
  const r1 = g.contentScaleGate(REAL, '')
  check('★★ 真实那份规划 + 没有判词 → 拦下', r1.ok === false, JSON.stringify(r1).slice(0, 160))
  check('★★ 拦下时说得清抽到了什么（要点到 5 小时 / 3 幕）',
    /5.*小时/.test(r1.error || '') && /3 幕/.test(r1.error || ''), r1.error)
  check('★★ 拦下时给的是"先做最小原型"的建议，不是"改判据"',
    /最小原型/.test(r1.hint || '') && !/改判据/.test(r1.hint || ''), r1.hint)

  // ── ③ 判词三态 ────────────────────────────────────────────────────
  check('★★ 判词=垃圾 → 大内容量照样拦', g.contentScaleGate(REAL, '垃圾').ok === false)
  check('★★ 判词=立得住 → 放行（人点头了就可以铺量）',
    g.contentScaleGate(REAL, '立得住').ok === true)
  check('★★ 判词=能玩 → 放行', g.contentScaleGate(REAL, '能玩').ok === true)
  check('★ 判词=未判 → 拦', g.contentScaleGate(REAL, '未判').ok === false)

  // ── ④ 小原型永远放行（否则连验证都做不了）────────────────────────
  check('★★ 20 分钟的小原型 + 没判词 → **放行**（不然没法验证核心）',
    g.contentScaleGate('单次时长 20 分钟，1 间房，1 幕', '').ok === true)
  check('★ 完全没提量的卡 → 放行（这条闸只管"铺量"）',
    g.contentScaleGate('把日志列表的排序改对', '').ok === true)

  // ── ⑤ 边界：正好等于上限也算过 ────────────────────────────────────
  check('★ 正好 0.5 小时（=上限）→ 放行',
    g.contentScaleGate('单次时长 0.5 小时', '').ok === true)
  check('★ 0.6 小时（超一点点）→ 拦',
    g.contentScaleGate('单次时长 0.6 小时', '').ok === false)

  // ── ⑥ 反例自证：把上限调大，同一条必须从"拦"变"放" ────────────────
  const oldHours = g.UNCORE_LIMITS.hours
  g.UNCORE_LIMITS.hours = 10
  const after = g.contentScaleGate(REAL, '')
  check('★★ 反例自证：上限调到 10 小时后，同一条不再因小时数被拦',
    !/5.*小时/.test(after.error || ''), after.error)
  g.UNCORE_LIMITS.hours = oldHours
  check('★★ 还原上限后重新拦住', g.contentScaleGate(REAL, '').ok === false)

  // ── ⑦ 纯函数卫生 ──────────────────────────────────────────────────
  const src = fs.readFileSync(SRC, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')
  check('★★ contentScale.ts 零 Vue / 零 DOM / 零 IO（所以能脱浏览器真跑）',
    !/from 'vue'/.test(src) && !/\bdocument\./.test(src) && !/require\(/.test(src),
    '出现了运行时依赖')

  console.log(`\nRESULT ${pass} pass / ${fail} fail`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log(' -', f)
    process.exit(1)
  }
}

try { main() } catch (e) {
  console.error('FATAL', e && (e.stack || e.message || e))
  process.exit(2)
}

