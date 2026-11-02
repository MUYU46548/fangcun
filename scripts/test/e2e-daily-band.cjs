#!/usr/bin/env node
/**
 * 每日推进面“今天推哪一格”纯逻辑断言（0.6.0 P2，2026-11-01）
 *
 * 真跑**编译产物** `dist/shared/dailyBand.js`（纯逻辑，不要 electron、不起子进程 → 本机可跑）。
 * 判据一句话：**"今天推哪一格"必须是可算的，不是猜的** ——
 *   · 只推“已冻结”的阶段卡（没裁决的计划不许往前跑）；
 *   · 判据没跑过 / 结果缺失 = **未过**（fail-closed，绝不当成做完了）；
 *   · 有多张未过时取**序号最小**的（P2 在 P3 前），不看数组顺序、不看时间、不随机；
 *   · 输出**恒为 3 行**（含空态）—— 站会三问的最小版。
 *
 * 最后一段拿**真实计划卡**（`task-data/plans/fangcun-base.md`）跑一遍：
 * 2026-10-31 的教训是“夹具全绿、真数据一读就露馅”，所以真卡必须进回归。
 *
 * 运行：node scripts/test/e2e-daily-band.cjs
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const Module = require('module')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'dailyBand.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const { stageOrdinal, criteriaKindOf, planLabel, pickDailyStage, buildDailyBand } = require(ART)

console.log('== 每日推进面 · 纯逻辑 ==')

// ── ① 阶段序号：只认 P + 数字；认不出就排最后（不猜） ────────────────────
check('stageOrdinal: P0 / P7 / P12 → 0 / 7 / 12',
  stageOrdinal('P0') === 0 && stageOrdinal('P7') === 7 && stageOrdinal('P12') === 12)
check('stageOrdinal: 前后空白不影响（" P3 " → 3）', stageOrdinal(' P3 ') === 3)
check('★ stageOrdinal: 认不出的 id → Infinity（排最后，不猜它排第几）',
  stageOrdinal('Q3') === Infinity && stageOrdinal('') === Infinity && stageOrdinal(null) === Infinity)

// ── ② 判据前缀：四类各归各，未知归 other（未知**不能**冒充 cmd） ──────────
check('criteriaKindOf: cmd / str / num / file 四类',
  criteriaKindOf('cmd: python x.py') === 'cmd' && criteriaKindOf('str: 本文件含 A') === 'str'
  && criteriaKindOf('num: 判据条数 ≥ 2') === 'num' && criteriaKindOf('file: docs/x.md 存在') === 'file')
check('★ criteriaKindOf: 未知前缀 → other（不许宽松放行）',
  criteriaKindOf('foo: 随便') === 'other' && criteriaKindOf('随便一句') === 'other')
check('criteriaKindOf: 全角冒号也认', criteriaKindOf('cmd：python x.py') === 'cmd')

// ── ③ 选格：只推已冻结；未过按序号最小；结果缺失算未过 ────────────────────
const stage = (id, status, extra = {}) => Object.assign({
  id, title: id + ' 标题', status, criteria: ['cmd: echo ok'], verdict: '', missing: [],
}, extra)
const plan = (file, stages, title = '') => ({ file, title: title || file.replace(/\.md$/, ''), stages })

const P = plan('demo.md', [
  stage('P0', '已冻结'),
  stage('P1', '待裁决'),        // 未裁决 → 永不选
  stage('P2', '已冻结'),
  stage('P3', '已冻结'),
])
const pick1 = pickDailyStage([P])
check('★ 只推“已冻结”的阶段卡（待裁决的 P1 不被选中）',
  !!pick1 && pick1.stage.id === 'P0', pick1 && pick1.stage.id)
check('★ 未过卡 ≥ 2 时取序号最小的那张（P0 不是按数组顺序碰巧第一）',
  pick1.stage.id === 'P0')

const scrambled = plan('demo.md', [
  stage('P3', '已冻结'),
  stage('P1', '已冻结'),
  stage('P2', '已冻结'),
])
const pick2 = pickDailyStage([scrambled])
check('★★ 数组顺序打乱也取 P1（不按时间 / 不随机 / 不看谁排在前面）',
  !!pick2 && pick2.stage.id === 'P1', pick2 && pick2.stage.id)
const again = pickDailyStage([scrambled])
check('★ 同一份数据连算两次结果一致（确定性）', again.stage.id === pick2.stage.id)

const passedP1 = { 'demo.md': { P1: true } }
const pick3 = pickDailyStage([scrambled], passedP1)
check('★ 显式通过（true）的格子跳过，轮到 P2',
  !!pick3 && pick3.stage.id === 'P2', pick3 && pick3.stage.id)
const failedP1 = { 'demo.md': { P1: false } }
check('★ 显式未过（false）仍停在 P1', pickDailyStage([scrambled], failedP1).stage.id === 'P1')
check('★★ 结果缺失（没跑过）算未过 —— fail-closed，绝不当成做完了',
  pickDailyStage([plan('a.md', [stage('P0', '已冻结')])], {}).stage.id === 'P0')
check('★ 只有 true 算过，字符串 "true" 不算（结果必须是显式布尔）',
  pickDailyStage([plan('a.md', [stage('P0', '已冻结'), stage('P1', '已冻结')])], { 'a.md': { P0: 'true' } }).stage.id === 'P0')

check('★ 没有已冻结的卡 → 不选任何格', pickDailyStage([plan('x.md', [stage('P0', '待裁决')])]) === null)
check('★ 空输入 / 坏输入不抛：[] / null / undefined',
  pickDailyStage([]) === null && pickDailyStage(null) === null && pickDailyStage(undefined) === null)
check('不修改传入的阶段数组（纯函数）',
  scrambled.stages.map((s) => s.id).join(',') === 'P3,P1,P2')

// ── ④ 输出恒为 3 行（含空态）────────────────────────────────────────────
const cases = [
  ['空输入', []],
  ['没有冻结', [plan('x.md', [stage('P0', '待裁决')])]],
  ['有格子', [P]],
  ['全部通过', [plan('y.md', [stage('P0', '已冻结')]),], { 'y.md': { P0: true } }],
]
for (const [name, plans, results] of cases) {
  const b = buildDailyBand(plans, results)
  check(`★ ${name}：lines 恒为 3 行`, Array.isArray(b.lines) && b.lines.length === 3, String(b.lines && b.lines.length))
  check(`  ${name}：每行都是非空字符串`, b.lines.every((l) => typeof l === 'string' && l.trim().length > 0))
}

// ── ⑤ 空态：说人话，不渲染空格子 ─────────────────────────────────────────
// 2026-11-02（暮雨“待裁决的东西在哪里？没看见”）：等裁决的卡**必须被数出来**。
// 此前这条带只认“已冻结”，7 张待裁决的卡在唯一的日频入口里一个字都没有。
const pendingOnly = buildDailyBand([plan('x.md', [stage('P0', '待裁决')])])
check('★★ 只有待裁决的卡 → 首行直接说“有 1 张阶段卡等你裁决”',
  pendingOnly.kind === 'none' && pendingOnly.pendingCount === 1
  && pendingOnly.lines[0] === '有 1 张阶段卡等你裁决', pendingOnly.lines[0])
check('★ 待裁决空态的 message 与首行一致（界面/日志同一个口径）',
  pendingOnly.message === pendingOnly.lines[0])

const empty = buildDailyBand([plan('x.md', [])])
check('★★ 一张卡都没有 → 仍是“本仓还没有冻结的作战计划”（不报 0 张待裁决）',
  empty.kind === 'none' && empty.pendingCount === 0
  && empty.lines[0] === '本仓还没有冻结的作战计划', empty.lines[0])
check('★ 空态 message 与首行一致（界面/日志同一个口径）', empty.message === empty.lines[0])
check('★ 空态 stage 为 null（不是造一张空格子出来）', empty.stage === null)

// 三种“等裁决”写法都算积压（打回/改一句之后都会落到这几个值）
check('★★ 待裁决 / 待裁决（未冻结）/ 未冻结 都计入 pendingCount',
  buildDailyBand([plan('x.md', [
    stage('P0', '待裁决'), stage('P1', '待裁决（未冻结）'), stage('P2', '未冻结'), stage('P3', '已冻结'),
  ])]).pendingCount === 3,
  String(buildDailyBand([plan('x.md', [
    stage('P0', '待裁决'), stage('P1', '待裁决（未冻结）'), stage('P2', '未冻结'), stage('P3', '已冻结'),
  ])]).pendingCount))

const allPassed = buildDailyBand([plan('y.md', [stage('P0', '已冻结')])], { 'y.md': { P0: true } })
check('★ 冻结的格子全通过 → 明确说“都过了判据”，不退回空态话术',
  allPassed.kind === 'all-passed' && /都过了判据/.test(allPassed.lines[0]), allPassed.lines[0])
const allPassedWithPending = buildDailyBand(
  [plan('y.md', [stage('P0', '已冻结'), stage('P1', '待裁决')])], { 'y.md': { P0: true } })
check('★★ 全过但还有待裁决 → 第二行报出待裁决张数（不让人以为没事了）',
  allPassedWithPending.kind === 'all-passed'
  && /还有 1 张卡待裁决/.test(allPassedWithPending.lines[1]), allPassedWithPending.lines[1])

// ── ⑥ 有格子：第一行点名阶段，第二行**带判据原文**（不只是条数） ──────────
const rich = plan('demo.md', [stage('P2', '已冻结', {
  title: '每日推进面',
  verdict: '通过 · 2026-10-29',
  criteria: [
    'cmd: `node scripts/test/e2e-daily-band.cjs` 退出码 0',
    'num: 输出行数恒为 3',
    'str: 无已冻结计划时显示“本仓还没有冻结的作战计划”',
  ],
})])
const b1 = buildDailyBand([rich])
check('★ 第一行 = 今天推：计划 · 阶段 · 标题',
  b1.lines[0] === '今天推：demo · P2 · 每日推进面', b1.lines[0])
check('★★ 第二行含每条判据的原文（"及其判据"不是只报条数）',
  b1.stage.criteria.every((c) => b1.lines[1].includes(c)), b1.lines[1])
check('★ criteriaCount / criteriaKinds 与数据一致',
  b1.criteriaCount === 3 && b1.criteriaKinds.cmd === 1 && b1.criteriaKinds.num === 1 && b1.criteriaKinds.str === 1)
check('★ 第三行带状态 + 裁决，并说明"判据尚未执行"',
  /状态：已冻结/.test(b1.lines[2]) && /裁决 通过/.test(b1.lines[2]) && /尚未执行/.test(b1.lines[2]), b1.lines[2])
check('★ 未执行与"已跑过未过"分开说（不把 unknown 说成 fail）',
  /尚未执行/.test(b1.lines[2]) && !/已跑过/.test(b1.lines[2]))
const b2 = buildDailyBand([rich], { 'demo.md': { P2: false } })
check('★ 有 false 结果 → 第三行说“判据已跑过：未过”',
  /判据已跑过：未过/.test(b2.lines[2]), b2.lines[2])

// 2026-11-02：推的格子之外还有等裁决的卡 → 第三行必须报出来
const withPending = buildDailyBand([plan('demo.md', [
  stage('P2', '已冻结', { criteria: ['cmd: echo ok'] }),
  stage('P3', '待裁决'), stage('P4', '待裁决'),
])])
check('★★ 推着一格、另有 2 张待裁决 → 第三行报出张数（否则它们永远看不见）',
  withPending.kind === 'ready' && withPending.pendingCount === 2
  && /另有 2 张待裁决/.test(withPending.lines[2]), withPending.lines[2])
check('★ 没有积压时不写“另有 0 张”（不制造噪音）',
  !/另有/.test(b1.lines[2]), b1.lines[2])

const noCriteria = plan('nc.md', [stage('P5', '已冻结', { criteria: [], missing: ['判据'] })])
const b3 = buildDailyBand([noCriteria])
check('★ 冻结卡缺判据 → 第二行点名“缺判据，不能算过”，不装看不见',
  /缺“判据”/.test(b3.lines[1]) && /不能算过/.test(b3.lines[1]), b3.lines[1])

// ── ⑦ 多计划：阶段序号优先，同名序号按文件名（结果稳定） ──────────────────
const multi = [
  plan('b.md', [stage('P1', '已冻结')]),
  plan('a.md', [stage('P0', '已冻结')]),
]
check('★ 多计划按阶段序号取（P0 在 P1 前，不受文件顺序影响）',
  buildDailyBand(multi).stage.id === 'P0')
const tie = [plan('b.md', [stage('P0', '已冻结')]), plan('a.md', [stage('P0', '已冻结')])]
check('★ 同序号按文件名升序（确定性，不随机）',
  buildDailyBand(tie).file === 'a.md')

// ── ⑧ 真实计划卡回归（2026-10-31 的教训：夹具不等于真数据） ────────────────
console.log('\n== 真实计划卡回归 ==')
const TEST_UD = path.join(os.tmpdir(), 'fc-daily-band-' + Date.now())
fs.mkdirSync(TEST_UD, { recursive: true })
process.env.FC_TEST_USERDATA = TEST_UD
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return path.join(__dirname, 'electron-stub.cjs')
  return origResolve.call(this, request, ...args)
}
const PLAN_MD = path.join(REPO, 'task-data', 'plans', 'fangcun-base.md')
if (!fs.existsSync(PLAN_MD)) {
  console.log('SKIP  真实计划卡不在场（' + PLAN_MD + '）—— 这条不是通过，是没得测')
} else {
  const before = fs.statSync(PLAN_MD)
  const data = require(path.join(REPO, 'desktop', 'dist', 'main', 'data', 'index.js'))
  data.setDataDir(REPO)
  const { readPlan } = require(path.join(REPO, 'desktop', 'dist', 'main', 'data', 'plans.js'))
  const doc = readPlan('fangcun-base.md')
  check('★ 真卡读得到（8 张阶段卡）', !!doc && doc.stages.length === 8, doc ? String(doc.stages.length) : 'null')
  if (doc) {
    const real = buildDailyBand([doc])
    const firstFrozen = doc.stages.filter((s) => String(s.status || '').trim() === '已冻结')[0]
    check('★ 真卡：选中第一张“已冻结”的阶段卡', !!firstFrozen && real.stage.id === firstFrozen.id,
      JSON.stringify({ picked: real.stage && real.stage.id, firstFrozen: firstFrozen && firstFrozen.id, kind: real.kind }))
    check('★ 真卡：三行且第二行带判据原文',
      real.lines.length === 3 && !!firstFrozen && firstFrozen.criteria.every((c) => real.lines[1].includes(c)),
      real.lines[1])
    check('★ 真卡读取是只读的（文件字节数与 mtime 一个不变）', (() => {
      const after = fs.statSync(PLAN_MD)
      return after.size === before.size && after.mtimeMs === before.mtimeMs
    })())
  }
}

// ── ⑨ 接线守卫：这条带必须真挂在日志页，且**不新增 IPC / 不新开页面** ─────
console.log('\n== 接线守卫 ==')
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf-8')
const LOGS = read('desktop/src/renderer/views/LogsView.vue')
const COMPOSER = read('desktop/src/renderer/composables/useDailyBand.ts')
const APP = read('desktop/src/renderer/App.vue')
const CSS = read('desktop/src/renderer/styles/app.css')
check('★ 日志页模板里真有这条带（class="daily-band"）', /class="daily-band"/.test(LOGS))
check('★ 日志页进入时重读（onMounted → loadDailyBand）', /onMounted\(\(\) => \{ void loadDailyBand\(\) \}\)/.test(LOGS))
check('★ 选格走 shared/dailyBand（界面不自己写规则）',
  /from '\.\.\/\.\.\/shared\/dailyBand'/.test(COMPOSER) && /buildDailyBand\(/.test(COMPOSER))
check('★ 取数复用 P1 已有的 plansGet，没有新增 IPC 口',
  /api\.plansGet\(\)/.test(COMPOSER) && (read('desktop/src/main/plan-ipc.ts').match(/guardedHandle\('/g) || []).length === 2)
check('★ 不新开页面：daily-band 只在日志页 + 样式里出现',
  (APP.match(/daily-band/g) || []).length === 0 && /\.daily-band \{/.test(CSS))
check('★ 空态文案真源在 shared（界面没有第二份"还没有冻结"）',
  /本仓还没有冻结的作战计划/.test(read('desktop/src/shared/dailyBand.ts'))
  && !/本仓还没有冻结的作战计划/.test(LOGS))

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log(' - ' + f)) }
process.exit(fail ? 1 : 0)
