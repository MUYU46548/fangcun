#!/usr/bin/env node
/**
 * 第八个状态「已取消」的口径（2026-11-24 · 落地 2026-11-23 问卷 K2）
 *
 * ## 拍板原话
 *
 * > 「在B的基础上，已取消默认隐藏，多搞一个按钮当开关，不影响当前看板已经完美的整屏全状态布局。」
 *
 * 拆成三条可判定的要求，也就是本守卫的三段：
 *   ① **它是独立状态**（不是别名、不映射成「驳回」）；
 *   ② **看板默认不显示**这一列，且**给得出开关**；
 *   ③ 「已取消」在各处判定里算哪一头，**口径只有一份**，且真被用上了。
 *
 * ## 为什么第 ③ 段最要命
 *
 * 「完成 / 驳回算不算终态」这件事此前在代码里有 **十几处各写了一遍字面量**
 * （blockers / boardCards / neverRead / taskPick / calendar / time / core.py 4 处 / 3 个 Python 脚本）。
 * 加第八个状态时，**每一处漏改都会造出一个安静的错误**：
 *
 *   · 阻塞页：一张已取消的卡继续被算成"还挡着别人的活" → 推荐先去解一张不存在的卡；
 *   · 下一步推荐：已取消的卡继续被选中 → agent 开工去做一件已经决定不做的事；
 *   · 没人读过：已取消的卡一直挂在清单里 → 噪音越攒越多；
 *   · 日历：已取消的卡继续占负担 → 数字全对不上；
 *   · 未完成清单：决定不做的卡仍算欠账 → 永远还不完。
 *
 * 以上每一种，**界面看起来都完全正常**，只有数字是错的。所以这一段的断言不是"能跑"，
 * 而是「这几处**都不许再写第二份字面量**」+ 「口径函数对该认的都对」。
 *
 * 运行：node scripts/test/e2e-cancel-status.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const DIST_SHARED = path.join(REPO, 'desktop', 'dist', 'shared')
const SRC_SHARED = path.join(REPO, 'desktop', 'src', 'shared')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

const ART = path.join(DIST_SHARED, 'cancelColumn.js')
if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const cc = require(ART)

console.log('== 第八个状态「已取消」 · 口径 ==')

// ── ① 独立状态，不是别名 ────────────────────────────────────────────────
console.log('\n-- ① 独立状态，不是「驳回」的马甲 --')
check('★ 常量就是「已取消」', cc.CANCEL_STATUS === '已取消', String(cc.CANCEL_STATUS))
check('★ 终态是 完成 + 已取消（**不含驳回** —— 驳回要返工，不是终态）',
  JSON.stringify([...cc.TERMINAL_STATUSES]) === JSON.stringify(['完成', '已取消']),
  JSON.stringify([...cc.TERMINAL_STATUSES]))
check('★ 已收口是 完成 + 驳回 + 已取消',
  JSON.stringify([...cc.CLOSED_STATUSES]) === JSON.stringify(['完成', '驳回', '已取消']),
  JSON.stringify([...cc.CLOSED_STATUSES]))
check('isTerminalStatus(已取消) 为真', cc.isTerminalStatus('已取消') === true)
check('★★ isTerminalStatus(驳回) 为假（并进来就等于永远分不开"否决"和"放弃"）',
  cc.isTerminalStatus('驳回') === false)
check('isClosedStatus(驳回) 为真（它不用再推，但也不是终态）', cc.isClosedStatus('驳回') === true)
check('isCancelled 只认已取消', cc.isCancelled('已取消') && !cc.isCancelled('驳回') && !cc.isCancelled('完成'))
check('空值 / undefined / 脏值都不算终态',
  !cc.isTerminalStatus('') && !cc.isTerminalStatus(undefined) && !cc.isTerminalStatus('随便什么'))
check('前后空白做归一', cc.isTerminalStatus('  已取消  ') === true)

// 两侧枚举逐字一致（verify.py 也钉一遍；这里再钉一次是因为这条最容易在只改一边时溜过去）
const TS_INDEX = path.join(REPO, 'desktop', 'src', 'main', 'data', 'index.ts')
const tsSrc = fs.readFileSync(TS_INDEX, 'utf8')
const tsList = (() => {
  const m = /export const STATUSES\s*=\s*\[([^\]]*)\]/.exec(tsSrc)
  return m ? [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]) : []
})()
const pySrc = fs.readFileSync(path.join(REPO, 'tegula', 'core.py'), 'utf8')
const pyList = (() => {
  const m = /^STATUSES = \[([^\]]*)\]/m.exec(pySrc)
  return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : []
})()
check('★★ TS 与 Python 的状态枚举逐字一致（含第八个）',
  tsList.length === 8 && JSON.stringify(tsList) === JSON.stringify(pyList),
  `ts=${JSON.stringify(tsList)} py=${JSON.stringify(pyList)}`)
check('★ 第八个排在末尾（不插到中间去动既有列的语义位置）', tsList[tsList.length - 1] === '已取消')

// ── ② 看板默认隐藏 + 开关 ───────────────────────────────────────────────
console.log('\n-- ② 看板默认隐藏，给一个开关 --')
check('★ 偏好键存在且是稳定字符串', typeof cc.SHOW_CANCELLED_PREF_KEY === 'string' && cc.SHOW_CANCELLED_PREF_KEY.length > 0,
  cc.SHOW_CANCELLED_PREF_KEY)
check('★★ 缺省（没存过）判为**关** —— 老用户升级上来布局不许变',
  cc.showCancelledEnabled(undefined) === false)
check('★ 脏值（字符串 "false" / 0 / null）一律判关', [
  cc.showCancelledEnabled('false'), cc.showCancelledEnabled(0),
  cc.showCancelledEnabled(null), cc.showCancelledEnabled(''),
].every((v) => v === false))
check('显式 true 才开', cc.showCancelledEnabled(true) === true)
check('显式 "true" 也开（prefs 落盘可能是字符串）', cc.showCancelledEnabled('true') === true)

const APP = path.join(REPO, 'desktop', 'src', 'renderer', 'App.vue')
const appSrc = fs.readFileSync(APP, 'utf8')
check('★ App.vue 从 shared/cancelColumn 取开关口径（不自己写 if）',
  /SHOW_CANCELLED_PREF_KEY/.test(appSrc) && /showCancelledEnabled/.test(appSrc))
check('★ 列过滤真的接在 columns 上（不是只算不用）',
  /columnsRaw\.value\.filter\(\(c\) => c\.key !== CANCEL_STATUS\)/.test(appSrc))
check('★ 有切换按钮且落盘（刷新后还记着）',
  /function toggleCancelledColumn\(\)/.test(appSrc) && /saveUiPref\(SHOW_CANCELLED_PREF_KEY/.test(appSrc))
check('★ 按钮绑在模板上（不是死控件）',
  /@click="toggleCancelledColumn"/.test(appSrc))
check('★ 按钮只在「按状态」分组时出现（按项目/优先级时这一列不存在，显示开关是错的）',
  /v-if="isBoardView && groupMode === 'status'"/.test(appSrc))

// ── ③ 口径只有一份，且真被用上了 ───────────────────────────────────────
console.log('\n-- ③ 终态口径只有一份，各处都改用常量 --')
const mustUseConstant = [
  ['shared/blockers.ts', /const DONE = new Set\(CLOSED_STATUSES\)/],
  ['shared/boardCards.ts', /const DONE = new Set\(CLOSED_STATUSES\)/],
  ['shared/neverRead.ts', /const CLOSED_STATUSES = CLOSED_SET/],
  ['shared/taskPick.ts', /const TERMINAL_STATUSES = CLOSED_SET/],
  ['shared/time.ts', /if \(isClosedStatus\(status\)\) return false/],
]
for (const [rel, re] of mustUseConstant) {
  const src = fs.readFileSync(path.join(REPO, 'desktop', 'src', rel), 'utf8')
  check(`★ ${rel} 改用统一口径（不再自己写 ['完成','驳回']）`, re.test(src) && !/'完成',\s*'驳回'/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')))
}

const calSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'calendar.ts'), 'utf8')
check('★ renderer/calendar.ts 的 isTerminal 走统一口径',
  /return isClosedStatus\(status\)/.test(calSrc))

// Python 侧：4 处字面量换成常量，3 个脚本补上「已取消」
const pyCore = pySrc
check('★★ core.py 的 4 处终态判断都用 _CLOSED_STATUSES（不再各写一份）',
  !/in \("完成", "驳回"\)/.test(pyCore), '还有裸露的字面量')
check('★ core.py 定义了 _CLOSED_STATUSES 且含三个值',
  /_CLOSED_STATUSES = frozenset\(\{"完成", "驳回", "已取消"\}\)/.test(pyCore))
check('★ core.py 的 TERMINAL_STATUSES 不含驳回（同 TS 口径）',
  /TERMINAL_STATUSES = frozenset\(\{"完成", "已取消"\}\)/.test(pyCore))

const pyScripts = [
  ['scripts/inventory-unfinished.py', 'DONE_STATUSES = {"完成", "驳回", "已取消"}'],
  ['scripts/project-portfolio.py', 'DONE = {"完成", "驳回", "已取消"}'],
]
for (const [rel, needle] of pyScripts) {
  const src = fs.readFileSync(path.join(REPO, rel), 'utf8')
  check(`★ ${rel} 把已取消算作已收口`, src.includes(needle), needle)
}

// ── ④ 行为端到端：编译产物真跑，不是只看源码 ──────────────────────────
console.log('\n-- ④ 行为：已取消的卡确实退出那些清单 --')
const taskPick = require(path.join(DIST_SHARED, 'taskPick.js'))
const cards = [
  { id: 't1', title: '还在办的活', status: '进行中', project: 'p' },
  { id: 't2', title: '已经取消的活', status: '已取消', project: 'p' },
  { id: 't3', title: '被驳回的活', status: '驳回', project: 'p' },
]
const picked = taskPick.pickTasks ? taskPick.pickTasks(cards, '') : null
if (picked) {
  const ids = (Array.isArray(picked) ? picked : picked.tasks || []).map((t) => t.id)
  check('★★ 挑卡时不把「已取消」的卡选进来（决定不做的事不该再被推荐）',
    !ids.includes('t2'), JSON.stringify(ids))
}
const timeMod = require(path.join(DIST_SHARED, 'time.js'))
const overdue = timeMod.isOverdue({ status: '已取消', deadline: '2020-01-01' })
check('★★ 已取消的卡不算逾期（它不需要再做）', overdue === false)
check('对照：进行中的卡该逾期还是逾期（判据没被写死成 false）',
  timeMod.isOverdue({ status: '进行中', deadline: '2020-01-01' }) === true)

const neverRead = require(path.join(DIST_SHARED, 'neverRead.js'))
if (typeof neverRead.isOpenForRead === 'function') {
  check('★ 已取消不进"没人读过"清单', neverRead.isOpenForRead('已取消') === false)
  check('对照：进行中的卡仍算未完成', neverRead.isOpenForRead('进行中') === true)
  check('空状态仍算未完成（没填 ≠ 做完）', neverRead.isOpenForRead('') === true)
}

console.log(`\nRESULT ${pass} / ${pass + fail}`)
if (fail) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
