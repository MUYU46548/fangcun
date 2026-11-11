#!/usr/bin/env node
/**
 * 通知类型白名单（2026-11-11 · 跨模块联动审计的最后一条判据）
 *
 * 为什么要有：通知系统最容易烂的方式不是“漏发”，而是**各模块自己发一套**
 * （某个模块自己 setInterval + 自己弹窗），于是同一个事件在多个渠道重复轰炸，
 * 或者界面上出现一个没有中文标签、点了没反应的“裸 type 名”。
 *
 * 判据（四条，全部静态可查）：
 *   ① `notifier.ts` 里 push 的每个 type，**都必须有中文标签**（NC_TYPE_META）；
 *   ② 每个 type 都必须有**可跳目标**（ncTargetOf 里认它，或明确登记“无目标”）；
 *   ③ 通知只能由 `notifier.ts` 发（`pushNotification` 别处不许直接调）；
 *   ④ 只有一处定时器（notifier 的 startScanner），别处不许 setInterval 自造扫描。
 *
 * 运行：node scripts/test/check-notify-types.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf-8')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

console.log('== 通知类型白名单 ==')

const NOTIFIER = read('desktop/src/main/services/notifier.ts')
const UI = read('desktop/src/renderer/composables/useNotifications.ts')

// ① notifier 里 push 过的 type（`type: 'x'`）
const pushed = [...NOTIFIER.matchAll(/type:\s*'([a-z0-9-]+)'/g)].map((m) => m[1])
const PUSHED = [...new Set(pushed)].sort()
// ② 界面标签
const LABELS = [...UI.matchAll(/^\s*'([a-z0-9-]+)':\s*\{[^}]*label:/gm)].map((m) => m[1])
const LABEL_SET = new Set(LABELS)

check('★ 从 notifier 里解析出推送类型（解析失效 = 下面的断言等于没跑）',
  PUSHED.length >= 10, `pushed=${PUSHED.length} → ${PUSHED.join(',')}`)
check('★ 从界面里解析出标签表（解析失效 = 等于没跑）',
  LABEL_SET.size >= 10, `labels=${LABEL_SET.size}`)

const noLabel = PUSHED.filter((t) => !LABEL_SET.has(t))
check('★★ 每个推送类型都有中文标签（否则面板显示裸 type 名）',
  noLabel.length === 0, noLabel.join(', '))

// ② 每个类型都要被 ncTargetOf 认（可跳）或登记为“没有可跳对象”
const targetBody = (UI.match(/function ncTargetOf[\s\S]*?\n  \}/) || [''])[0]
const noTarget = PUSHED.filter((t) => targetBody.indexOf(`'${t}'`) < 0)
check('★★ 每个推送类型都有“点击落点”（行尾箭头与跳转同源，不会 arrow 亮着点了没反应）',
  noTarget.length === 0, noTarget.join(', '))

// ③ pushNotification 只许 notifier 调（别的模块自己发 = 重复轰炸的源头）
const mainTs = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.ts')) mainTs.push(p)
  }
})(path.join(REPO, 'desktop/src/main'))
const offenders = mainTs
  .filter((p) => !p.endsWith('notifier.ts') && !p.endsWith('notifications.ts'))
  .filter((p) => /pushNotification\s*\(/.test(fs.readFileSync(p, 'utf-8')))
  .map((p) => path.relative(REPO, p))
check('★★ 通知只能由 notifier 发（别处直接 pushNotification = 同一事件多渠道轰炸）',
  offenders.length === 0, offenders.join(', '))

// ④ 只有一处定时扫描（**登记豁免要写清原因**，守卫每次打印）
// 2026-11-11 首跑就抓到一处：`idleReminder.ts` 有自己的 setInterval。查过源码 —— 它是
// **刻意独立**的机制（2026-10-17 拍板：一次挂机最多弹一次、只系统通知、不写通知中心库，不进 notifier 的扫描）。
// 所以登记豁免并打印原因，而不是把它并进 notifier（那正是用户说的“加一堆噪音”）。
const TIMER_ALLOW = {
  'desktop/src/main/services/idleReminder.ts':
    '2026-10-17 拍板：挂机提醒是独立机制（一次挂机最多弹一次 / 只系统通知 / 不写通知中心库），'
    + '刻意不进 notifier 的 60s 扫描；并进去会变成“一堆噪音”',
}
const intervals = mainTs
  .filter((p) => /setInterval\s*\(/.test(fs.readFileSync(p, 'utf-8')))
  .map((p) => path.relative(REPO, p).replace(/\\/g, '/'))
  .filter((p) => !/services\/(notifier|dev-electron-watch|appLog)\.ts$/.test(p))
const badIntervals = intervals.filter((p) => !TIMER_ALLOW[p])
for (const p of intervals) {
  if (TIMER_ALLOW[p]) console.log(`SKIP  ${p} —— 已登记豁免：${TIMER_ALLOW[p]}`)
}
check('★ 只有 notifier 一处定时扫描（别处 setInterval 自造扫描 = 第二套通知机制；豁免须写原因）',
  badIntervals.length === 0, badIntervals.join(', '))

// ⑤ 白名单打印出来（人一眼看得见现在有哪几类；新增一类必须同时补标签与落点）
console.log('  当前推送类型：' + PUSHED.join(' · '))

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('失败明细：'); failures.forEach((f) => console.log('  · ' + f)) }
process.exit(fail === 0 ? 0 : 1)
