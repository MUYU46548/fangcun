#!/usr/bin/env node
/**
 * 作战计划页（0.6.0 P1）—— 数据层 + 接线断言
 *
 * P1 的判据写在计划卡里，这里是它的执行版：
 *   cmd  : 本脚本退出码 0
 *   str  : `PlanView.vue` 含三种动作分支，且每支都有写文件路径（不是假按钮）
 *   num  : 打回后重读文件，`打回理由:` 非空（反例：不写 → 精确红）
 *   file : 项目页摆法注册处含 `plan`，且摆法总数 = 8
 *
 * 另外钉住两件最容易做错的事：
 *   ① **缺块不许通过**（界面禁用只是第一道，主进程也要拦）；
 *   ② 写裁决是**行级就地改**，不许把表格/缩进/修订记录洗一遍。
 *
 * 运行：node scripts/test/e2e-plan-tab.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const DIST = path.join(REPO, 'desktop', 'dist')
const PLANS = path.join(DIST, 'main', 'data', 'plans.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

if (!fs.existsSync(PLANS)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + PLANS)
  console.log('RESULT 0 / 1')
  process.exit(1)
}

// ── 临时数据根（绝不动真实 task-data）────────────────────────────────────
const Module = require('module')
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-plan-'))
// setDataDir 要求目录里已经有 registry.yaml 或 task-data（防手滑指错盘）
fs.mkdirSync(path.join(TMP, 'task-data', 'plans'), { recursive: true })
const data = require(path.join(DIST, 'main', 'data', 'index.js'))
data.setDataDir(TMP)

const plans = require(PLANS)
const PLAN_PATH = path.join(TMP, 'task-data', 'plans', 'demo.md')

const GOOD = `# 演示项目 · 作战计划

- 状态: 待裁决
- 版本: v1

---

## 阶段卡

### P0 · 齐全的一张

- 状态: 已冻结
- 做什么: 演示三块齐全。

- 技术方案:
  - 第一句方案
  - 第二句方案

- 照抄点:

| 抄哪块 | 落到哪 | 不抄什么 | 怎么算抄到位 |
|---|---|---|---|
| GitHub PR review | 三个动作 | 审批链 | num: 动作数恒为 3 |

- 判据:
  - cmd: \`node x.cjs\` 退出码 0
  - num: 动作数 = 3

### P1 · 缺判据的一张

- 状态: 待裁决
- 做什么: 少一块。

- 技术方案:
  - 有方案

- 照抄点:

| 抄哪块 | 落到哪 | 不抄什么 | 怎么算抄到位 |
|---|---|---|---|
| Linear | 卡片 | 评论 | num: ≤4 |

### P2 · 缺照抄点的一张

- 状态: 待裁决
- 做什么: 少表格。

- 技术方案:
  - 有方案

- 判据:
  - num: 数量 = 1

## 修订记录

- 2026-10-29 · v1 冻结
`

fs.writeFileSync(PLAN_PATH, GOOD, 'utf-8')

console.log('== ① 读取：三块解析与缺块点名 ==')

const doc = plans.readPlan('demo.md')
check('★ 读到 3 张阶段卡', doc && doc.stages.length === 3, String(doc && doc.stages.length))
const s0 = doc.stages.find((s) => s.id === 'P0')
const s1 = doc.stages.find((s) => s.id === 'P1')
const s2 = doc.stages.find((s) => s.id === 'P2')
check('★★ 三块齐全的那张：missing 为空', s0 && s0.missing.length === 0, JSON.stringify(s0 && s0.missing))
check('★★ 缺判据 → missing 里点名“判据”', s1 && s1.missing.includes('判据'), JSON.stringify(s1 && s1.missing))
check('★★ 缺照抄点 → missing 里点名“照抄点”', s2 && s2.missing.includes('照抄点'), JSON.stringify(s2 && s2.missing))
check('★ 表头/分隔线/数据行都解出来了（3 行）', s0 && s0.copyRows.length === 3, String(s0 && s0.copyRows.length))
check('★ 标题与修订记录都读到了', /演示项目/.test(doc.title) && doc.revision.length === 1,
  JSON.stringify({ title: doc.title, rev: doc.revision }))

console.log('\n== ② 通过：缺块必须被主进程拦下（不能只靠按钮禁用）==')

const badPass = plans.writePlanVerdict({ file: 'demo.md', stageId: 'P1', action: 'pass' })
check('★★ 缺判据的卡“通过”被拒，且说明缺什么',
  !badPass.ok && /缺/.test(String(badPass.error)), String(badPass.error))

const okPass = plans.writePlanVerdict({ file: 'demo.md', stageId: 'P0', action: 'pass' })
const afterPass = plans.readPlan('demo.md')
const p0After = afterPass.stages.find((s) => s.id === 'P0')
check('★ 齐全的卡能通过', okPass.ok === true, String(okPass.error))
check('★ 通过后状态写进文件（已冻结）', p0After.status === '已冻结', p0After.status)
check('★ 通过留了裁决行（含日期与“通过”）', /通过/.test(p0After.verdict) && /\d{4}-\d{2}-\d{2}/.test(p0After.verdict), p0After.verdict)
check('★ 修订记录多了一行（ADR supersede 的最小版）', afterPass.revision.length === 2,
  JSON.stringify(afterPass.revision))

console.log('\n== ③ 打回：必须真写进文件（空理由不许提交）==')

const emptyReject = plans.writePlanVerdict({ file: 'demo.md', stageId: 'P1', action: 'reject', text: '   ' })
check('★★ 空理由打回被拒（空着等于没打回）', !emptyReject.ok, String(emptyReject.error))

const rj = plans.writePlanVerdict({ file: 'demo.md', stageId: 'P1', action: 'reject', text: '判据里没有可执行的命令' })
const afterReject = plans.readPlan('demo.md')
const p1After = afterReject.stages.find((s) => s.id === 'P1')
const rawAfter = fs.readFileSync(PLAN_PATH, 'utf-8')
check('★★ 打回成功', rj.ok === true, String(rj.error))
check('★★ 重读文件：`打回理由:` 非空（判据 num 那条）',
  p1After.rejectReason === '判据里没有可执行的命令' && /打回理由:\s*\S/.test(rawAfter),
  p1After.rejectReason)
check('★ 打回理由同时进修订记录', afterReject.revision.some((l) => l.includes('打回')), JSON.stringify(afterReject.revision))
check('★ 打回把状态退回“待裁决”', p1After.status === '待裁决', p1After.status)

console.log('\n== ④ 改一句：留痕 + 退回未冻结 ==')

const am = plans.writePlanVerdict({ file: 'demo.md', stageId: 'P2', action: 'amend', text: '把照抄点补成四栏表' })
const afterAmend = plans.readPlan('demo.md')
const p2After = afterAmend.stages.find((s) => s.id === 'P2')
check('★ 改一句成功并留痕', am.ok && afterAmend.revision.some((l) => l.includes('改一句')), JSON.stringify(afterAmend.revision))
check('★★ 改一句后状态标“未冻结”', /未冻结/.test(p2After.status), p2After.status)

console.log('\n== ⑤ 行级就地改：表格/缩进/其它阶段不许被洗 ==')

const rawNow = fs.readFileSync(PLAN_PATH, 'utf-8')
check('★★ 表格列宽与竖线原样保留（没被重排）',
  rawNow.includes('| 抄哪块 | 落到哪 | 不抄什么 | 怎么算抄到位 |') &&
  rawNow.includes('| GitHub PR review | 三个动作 | 审批链 | num: 动作数恒为 3 |'))
check('★ 缩进列表原样保留', rawNow.includes('  - 第一句方案') && rawNow.includes('  - 第二句方案'))
check('★★ 没被改的 P0 段正文一字不动', rawNow.includes('- 做什么: 演示三块齐全。'))
check('★ 空行结构还在（不是被压缩成一段）', rawNow.includes('\n\n- 技术方案:'))

console.log('\n== ⑥ 接线：三个动作各自有写路径（源码守卫）==')

const view = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'views', 'PlanView.vue'), 'utf-8')
check('★ PlanView 里有三个动作分支（pass / reject / amend）',
  /action === 'pass'/.test(view) && /action === 'reject'/.test(view) && /action === 'amend'/.test(view))
check('★★ 三个动作都真调 plansVerdict（不是只改本地状态）',
  /plansVerdict\(\{[\s\S]{0,120}file: doc\.file[\s\S]{0,80}action/.test(view))
check('★ 缺块时“通过”被禁用', /:disabled="busy \|\| s\.missing\.length > 0"/.test(view))

const appVue = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'App.vue'), 'utf-8')
check('★★ 项目页摆法注册处含 plan', /v-else-if="pvView === 'plan'"/.test(appVue))
// 只数**项目页**那一组（别的视图也有一组 `{ v: ... }`，全篇数会把 23 当成 8）
const projBlock = (appVue.split("curView.value === 'projects'")[1] || '').split("return []")[0]
const optionCount = (projBlock.match(/\{ v: '[a-z]+', label:/g) || []).length
check('★★ 项目页摆法总数 = 8（P1 判据 file 那条）', optionCount === 8, String(optionCount))
check('★ 持久化白名单也加了 plan（否则重启静默退回项目墙）', /fc_pv_view === 'plan'/.test(appVue))
// ⚠ 2026-11-01（P5 DOM 实测抓到的真 bug）：P1 只把 plan 加进了 viewOptions 与持久化读取，
//   **没加进 PV_VIEWS**（setViewMode 的白名单）—— 点“作战计划”会被 `PV_VIEWS.includes(v)?v:'tiles'`
//   静默退回项目墙，P1 的页面其实一直点不开。这里改钉白名单本身。
const pvViewsSrc = (appVue.match(/const PV_VIEWS: string\[\] = \[([^\]]*)\]/) || [])[1] || ''
check('★★ 摆法切换白名单含 plan（PV_VIEWS；漏了 = 点页签静默退回项目墙）',
  /'plan'/.test(pvViewsSrc), pvViewsSrc)
check('★ 白名单条数 = 摆法数（两处注册不许漂移）',
  (pvViewsSrc.match(/'[a-z]+'/g) || []).length === optionCount,
  `PV_VIEWS=${(pvViewsSrc.match(/'[a-z]+'/g) || []).length} options=${optionCount}`)

const ipc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'plan-ipc.ts'), 'utf-8')
check('★ IPC 只有两个口（plans:get / plans:verdict），没有第三个',
  (ipc.match(/guardedHandle\('/g) || []).length === 2, String((ipc.match(/guardedHandle\('/g) || []).length))

console.log('\n== ⑦ 真卡回归：真实 fangcun-base.md 必须每张三块齐全 ==')
// 2026-10-31 实测踩过：真实卡里 `- 判据:` 与首条之间隔一个空行，
// 按"空行即结束"解析会把 8 张卡全判成**缺判据**（假红，界面上会禁止通过）。
// 这条用真文件钉住，防解析器再退回那种写法。
data.setDataDir(REPO)
const real = plans.readPlan('fangcun-base.md')
check('★★ 真卡能读出来（≥1 张）', !!real && real.stages.length >= 1, String(real && real.stages.length))
check('★★ 真卡每张都不缺块（三块齐全）',
  !!real && real.stages.every((s) => s.missing.length === 0),
  JSON.stringify((real ? real.stages : []).map((s) => s.id + ':' + (s.missing.join('/') || 'ok'))))
check('★ 真卡的判据不是空数组（空行没打断收集）',
  !!real && real.stages.every((s) => s.criteria.length > 0),
  JSON.stringify((real ? real.stages : []).map((s) => s.criteria.length)))

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) { console.log('\n失败项：'); for (const f of failures) console.log('  - ' + f) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
