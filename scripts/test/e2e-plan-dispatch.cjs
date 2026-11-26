/**
 * 规划派单两模式 + 规划备忘（2026-11-26）
 *
 * 这份测试钉的是用户三问拍板后的三条产品规则：
 *   ① 定向规划要有「规划备忘」这个家（不是任务卡，也不能塞阶段卡）；
 *   ② 全项目规划没已批准澄清卷时**先出卷**，出完停手；
 *   ③ 全项目规划的阶段**逐格提成**，不许先攒整份草案。
 *
 * 同时钉两处性能/行为修复（都是"用户报了症状、根因不在界面文案"的那一类）：
 *   · 问卷每次存草稿不许再全库扫描（`refreshDeckNotice` 里不许出现 `listDecks`）；
 *   · 问卷长文本输入不许每敲一个字重渲染整个弹窗（不许再 `v-model="editText"`）。
 *
 * 纯逻辑部分编译真身 `shared/planDispatch.ts` / `shared/planMemo.ts` 直接跑；
 * 接线部分用源码守卫（本机跑不起 Electron 时也能给出精确红）。
 *
 * 运行：node scripts/test/e2e-plan-dispatch.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { mkTmpPath } = require('./_tmp.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(ROOT, 'desktop')
const OUT = mkTmpPath('fc-plan-dispatch-')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}
function read(rel) {
  const p = path.join(ROOT, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''
}

function build() {
  fs.mkdirSync(OUT, { recursive: true })
  const ts = path.join(DESKTOP, 'node_modules', 'typescript', 'bin', 'tsc')
  execFileSync(process.execPath, [
    ts,
    path.join(DESKTOP, 'src', 'shared', 'planDispatch.ts'),
    path.join(DESKTOP, 'src', 'shared', 'planMemo.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'ES2020',
    '--strict', 'false', '--skipLibCheck',
  ], { cwd: DESKTOP, stdio: 'pipe' })
}

build()
const D = require(path.join(OUT, 'planDispatch.js'))
const M = require(path.join(OUT, 'planMemo.js'))

const TODAY = '2026-11-26'
const full = D.buildPlanTaskBook({ project: 'fangcun-base', projectName: '方寸', mode: 'full', today: TODAY })
const targeted = D.buildPlanTaskBook({
  project: 'fangcun-base', projectName: '方寸', mode: 'targeted',
  focus: '只规划记忆系统：检索质量、合并、审批体验', today: TODAY,
})

// ── ① 全项目：先出卷 + 逐格提成 ─────────────────────────────────────────
check('全项目任务书带 fc-plan 标记，mode=full', /<!-- fc-plan v1\n[\s\S]*?mode: full/.test(full))
check('全项目第一步是查澄清卷', /先查澄清卷/.test(full) && /qn_list/.test(full))
check('全项目没卷时先出卷（不落任务卡替代）', /先出卷/.test(full) && /qn_propose/.test(full) && /不要用任务卡替代/.test(full))
check('全项目出完卷立刻停手', /立刻停手/.test(full))
check('全项目有卷后逐格提成', /逐格提成/.test(full) && /stage_plan_propose/.test(full))
check('全项目明确禁止先攒整份草案', /不要先把 2–5 个阶段攒成一份草案/.test(full))
check('全项目最后把排除项/待拍板问题落一张规划备忘', /规划备忘/.test(full) && /plan-memo/.test(full))
check('全项目任务书里有日期与项目标签', full.includes('fangcun-base（方寸）') && full.includes(TODAY))

// ── ② 定向：规划备忘 + 不建阶段卡 ───────────────────────────────────────
check('定向任务书带 fc-plan 标记，mode=targeted', /<!-- fc-plan v1\n[\s\S]*?mode: targeted/.test(targeted))
check('定向任务书带 focus', /只规划记忆系统：检索质量、合并、审批体验/.test(targeted))
check('定向产物是规划备忘卡', /规划备忘/.test(targeted) && /plan-memo/.test(targeted))
check('定向不建阶段卡', /不要建阶段卡/.test(targeted))
check('定向标题格式含模式前缀与焦点', /\[规划·定向\] 方寸 · <focus 摘要> · 2026-11-26/.test(targeted))
check('定向不要求澄清卷（更轻的那条路）', !/先查澄清卷/.test(targeted))

// ── ③ 引导词校验（marker 注入 / 换行 / 超长 / 空）────────────────────────
check('引导词禁止 -->（会把注释提前闭合）', D.normalizePlanFocus('a --> b').ok === false)
check('引导词禁止换行', D.normalizePlanFocus('a\nb').ok === false)
check('引导词上限 500 字', D.normalizePlanFocus('x'.repeat(501)).ok === false)
check('引导词 500 字整放行', D.normalizePlanFocus('x'.repeat(500)).ok === true)
check('定向空引导词不许生成任务书', (() => {
  try { D.buildPlanTaskBook({ project: 'p', mode: 'targeted', focus: '   ', today: TODAY }); return false } catch { return true }
})())
check('定向坏引导词不许生成任务书（-->)', (() => {
  try { D.buildPlanTaskBook({ project: 'p', mode: 'targeted', focus: 'a --> b', today: TODAY }); return false } catch { return true }
})())
check('全项目忽略 focus（不把定向范围塞进全量单）', !/focus: 只规划/.test(full))

// ── ④ 规划备忘识别（type / 标签 / 状态 / 模式 / focus）──────────────────
const memoByType = { fm: { type: 'plan-memo', title: '[规划·定向] 方寸 · 只规划记忆系统 · 2026-11-26', tags: ['规划', '定向'] } }
const memoByTag = { fm: { title: '随便写的', tags: ['规划备忘'] } }
check('type=plan-memo 认得出来', M.isPlanMemo(memoByType) === true)
check('标签「规划备忘」也认（旧写法兜底）', M.isPlanMemo(memoByTag) === true)
check('普通卡不是备忘', M.isPlanMemo({ fm: { title: '普通卡', tags: ['ui'] } }) === false)
check('null 不抛', M.isPlanMemo(null) === false)
check('备忘状态默认待读', M.planMemoStatusOf({}) === '待读')
check('备忘状态认已采纳', M.planMemoStatusOf({ plan_memo_status: '已采纳' }) === '已采纳')
check('认不出的状态回落待读（不造第四态）', M.planMemoStatusOf({ plan_memo_status: '乱写' }) === '待读')
check('模式从标签认', M.planMemoModeOf(memoByType.fm) === '定向')
check('模式从标题认（[规划·定向] 里的 · 不会切错）', M.planMemoModeOf({ title: '[规划·定向] 方寸 · 只规划记忆系统 · 2026-11-26' }) === '定向')
check('focus 从标题三段分离出来', M.planMemoFocusOf(memoByType.fm) === '只规划记忆系统')
check('focus 认不出就给空串（不猜）', M.planMemoFocusOf({ title: '普通标题' }) === '')

// ── ⑤ 接线守卫（本机跑不起 Electron 也能精确红）─────────────────────────
const ipc = read('desktop/src/main/ipc.ts')
check('界面任务列表过滤规划备忘', /loadTasks[\s\S]{0,400}isPlanMemo/.test(ipc))
const planIpc = read('desktop/src/main/plan-ipc.ts')
check('作战计划有独立的备忘读口 plans:memos', /guardedHandle\('plans:memos'/.test(planIpc))
check('作战计划有备忘状态写口 plans:memoStatus', /guardedHandle\('plans:memoStatus'/.test(planIpc))
check('备忘状态只改 plan_memo_status（不借任务状态）', /plan_memo_status:\s*status/.test(planIpc) && !/moveStatus\(/.test(planIpc))
const planView = read('desktop/src/renderer/views/PlanView.vue')
check('作战计划页真渲染「规划备忘」段', /data-plan-memos/.test(planView) && /plansMemos/.test(planView))
check('备忘行有采纳/过期/标回待读', /setMemoStatus\(m\.id, '已采纳'\)/.test(planView) && /setMemoStatus\(m\.id, '已过期'\)/.test(planView))
const dialog = read('desktop/src/renderer/components/PlanDispatchDialog.vue')
check('规划弹窗默认定向、全项目要手点', /const mode = ref<PlanMode>\('targeted'\)/.test(dialog))
check('规划弹窗不再叠第二个花钱确认（App 侧 confirmed）', /confirmed: true/.test(read('desktop/src/renderer/App.vue')))
check('项目页按钮改成打开弹窗（不再直接发 plan）', /openPlanDialog\(ctl\.pvCurrent\)/.test(read('desktop/src/renderer/views/ProjectsView.vue')))

// ── ⑥ 问卷卡顿两处根因 ──────────────────────────────────────────────────
const qnIpc = read('desktop/src/main/questionnaire-ipc.ts')
// 判据必须看**代码**，不看注释：注释里写「原来调 listDecks()」是解释历史，不是回潮。
const qnIpcCode = qnIpc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const refreshBody = (qnIpcCode.match(/function refreshDeckNotice\([\s\S]*?\n  \}/) || [''])[0]
check('问卷保存不再全库扫描（refreshDeckNotice 里不许 listDecks）', !!refreshBody && !/listDecks/.test(refreshBody))
check('问卷保存改成只读这一卷（getDeck）', /getDeck\(deck\)/.test(refreshBody))
const qnModal = read('desktop/src/renderer/components/QuestionnaireModal.vue')
const qnModalCode = qnModal.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
check('问卷长文本不再 v-model 逐字重渲染', !/v-model="editText"/.test(qnModalCode) && /:value="editText"/.test(qnModalCode))
check('问卷输入落到非响应式原文（防抖落盘仍保留）', /let editDraftText/.test(qnModalCode) && /editDraftText = el \? el\.value/.test(qnModalCode))

console.log('')
if (failures.length) {
  console.log('失败明细：')
  for (const x of failures) console.log('  · ' + x)
}
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
