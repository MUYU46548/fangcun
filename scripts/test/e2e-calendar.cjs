/**
 * 日历纯逻辑端到端测试（2026-09-22，用户第 6 条）
 *
 * 为什么单独测日期算术：时间段横跨月末/月初、MM-DD 没年份、把"另一月"误判成
 * "未安排" —— 这类错误在界面上只表现为"少一天/多一天"，肉眼几乎抓不住。
 * calendar.ts 是不依赖 Vue/DOM 的纯函数，所以能用 tsc 编出来直接在 Node 里断言。
 *
 * 运行：node scripts/test/e2e-calendar.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(ROOT, 'desktop')
const SRC = path.join(DESKTOP, 'src', 'renderer', 'calendar.ts')
const OUT = path.join(os.tmpdir(), 'fc-cal-' + Date.now())

let pass = 0
let fail = 0
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
  const js = path.join(OUT, 'calendar.js')
  if (!fs.existsSync(js)) throw new Error('编译产物不存在: ' + js)
  return require(js)
}

function days(cal, y, m, evs) {
  // 取某月中 span 不为 null 的天号
  const cells = evs.cells
  return cells.filter(c => c).map(c => ({ day: c.day, evs: c.events }))
    .filter(x => x.evs.length)
}

function cellOf(res, day) {
  // 用"天号"取格子，而不是数组下标 —— 各月的首格留白数不同，
  // 按下标取会在非 9 月的用例上悄悄错位（本测试自己先踩过一次）。
  return res.cells.find(c => c && c.day === day)
}

function main() {
  console.log('== 日历纯逻辑 e2e ==')
  let cal
  try {
    cal = compile()
  } catch (e) {
    console.log('FAIL  编译 calendar.ts 失败:', e.message)
    process.exit(1)
  }

  const TODAY = new Date(2026, 8, 22) // 2026-09-22

  // ── 1. 日期解析 ────────────────────────────────────────────────────
  check('calISO 用本地时区（不因 UTC 挪一天）', cal.calISO(new Date(2026, 0, 1)) === '2026-01-01',
    cal.calISO(new Date(2026, 0, 1)))
  check('完整日期解析', cal.calISO(cal.parseCalDate('2026-10-05', TODAY)) === '2026-10-05')
  check('MM-DD 就近取年（本年内）', cal.calISO(cal.parseCalDate('09-30', TODAY)) === '2026-09-30',
    cal.calISO(cal.parseCalDate('09-30', TODAY)))
  check('MM-DD 就近取年（跨年顺延）', cal.calISO(cal.parseCalDate('01-15', TODAY)) === '2027-01-15',
    cal.calISO(cal.parseCalDate('01-15', TODAY)))
  check('MM-DD 当天不算过期（09-22）', cal.calISO(cal.parseCalDate('09-22', TODAY)) === '2026-09-22')
  check('非法 MM-DD 返回 null', cal.parseCalDate('13-45', TODAY) === null)
  check('空值返回 null', cal.parseCalDate('', TODAY) === null && cal.parseCalDate(null, TODAY) === null &&
    cal.parseCalDate(undefined, TODAY) === null)
  check('垃圾字符串返回 null', cal.parseCalDate('abc', TODAY) === null)

  // ── 2. 单日截止 ────────────────────────────────────────────────────
  const t1 = { id: 't1', title: '单日', status: '待办', priority: '高', deadline: '2026-09-10' }
  let r = cal.buildMonth({ year: 2026, month: 8, today: TODAY, tasks: [t1] })
  check('9 月首格留白 = 1（2026-09-01 是周二，周一为第一格）',
    r.cells[0] === null && r.cells[1] !== null && r.cells[1].day === 1)
  check('单元格总数 = 留白 + 天数', r.cells.length === 1 + 30, String(r.cells.length))
  check('仅截止 → 当天一格、span=only', cellOf(r, 10).events.length === 1 && cellOf(r, 10).events[0].span === 'only')
  check('Today 标记落在 22 号', r.cells.find(c => c && c.isToday).day === 22)
  check('过去日标记正确（10 号为过去）', cellOf(r, 10).isPast === true)

  // ── 3. 时间段（本月内）────────────────────────────────────────────
  const t2 = { id: 't2', title: '区间', status: '进行中', priority: '中', start: '2026-09-05', deadline: '2026-09-08' }
  r = cal.buildMonth({ year: 2026, month: 8, today: TODAY, tasks: [t2] })
  const spans = [5, 6, 7, 8].map(d => cellOf(r, d).events[0].span)
  check('区间首日 span=start', spans[0] === 'start', spans.join(','))
  check('区间中间 span=mid', spans[1] === 'mid' && spans[2] === 'mid', spans.join(','))
  check('区间末日 span=end', spans[3] === 'end', spans.join(','))
  check('区间总天数=4', cellOf(r, 5).events[0].rangeDays === 4, String(cellOf(r, 5).events[0].rangeDays))
  check('区间外不出现', cellOf(r, 4).events.length === 0 && cellOf(r, 9).events.length === 0)

  // ── 4. 时间段跨月末 / 跨月初 ───────────────────────────────────────
  const t3 = { id: 't3', title: '跨月末', status: '进行中', priority: '中', start: '2026-09-29', deadline: '2026-10-03' }
  const sep = cal.buildMonth({ year: 2026, month: 8, today: TODAY, tasks: [t3] })
  const oct = cal.buildMonth({ year: 2026, month: 9, today: TODAY, tasks: [t3] })
  check('跨月末：9/29 = start', cellOf(sep, 29).events[0].span === 'start', cellOf(sep, 29).events[0].span)
  check('跨月末：9/30 尾段 = mid（右侧仍延续到下月）', cellOf(sep, 30).events[0].span === 'mid', cellOf(sep, 30).events[0].span)
  check('跨月末：10/1 首段 = mid（左侧从上月延续）', cellOf(oct, 1).events[0].span === 'mid', cellOf(oct, 1).events[0].span)
  check('跨月末：10/3 = end', cellOf(oct, 3).events[0].span === 'end', cellOf(oct, 3).events[0].span)
  check('跨月末：10 月不重复计入其它月份', oct.otherTotal === 0 && sep.otherTotal === 0)

  const t4 = { id: 't4', title: '跨月初', status: '进行中', priority: '低', start: '2026-08-28', deadline: '2026-09-02' }
  const sep2 = cal.buildMonth({ year: 2026, month: 8, today: TODAY, tasks: [t4] })
  check('跨月初：9/1 首段 = mid', cellOf(sep2, 1).events[0].span === 'mid', cellOf(sep2, 1).events[0].span)
  check('跨月初：9/2 = end', cellOf(sep2, 2).events[0].span === 'end', cellOf(sep2, 2).events[0].span)

  const t5 = { id: 't5', title: '整月', status: '进行中', priority: '中', start: '2026-08-01', deadline: '2026-10-31' }
  const whole = cal.buildMonth({ year: 2026, month: 8, today: TODAY, tasks: [t5] })
  const allMid = Array.from({ length: 30 }, (_, i) => cellOf(whole, i + 1).events[0].span).every(s => s === 'mid')
  check('整月覆盖：30 天全部 mid', allMid)

  // ── 5. 反序 / 单边 ────────────────────────────────────────────────
  const t6 = { id: 't6', title: '反序', status: '待办', priority: '中', start: '2026-09-20', deadline: '2026-09-18' }
  const rev = cal.buildMonth({ year: 2026, month: 8, today: TODAY, tasks: [t6] })
  check('开始晚于截止 → 自动取区间（18~20）', cellOf(rev, 18).events.length === 1 && cellOf(rev, 20).events.length === 1 &&
    cellOf(rev, 17).events.length === 0)
  const t7 = { id: 't7', title: '只有开始', status: '待办', priority: '中', start: '2026-09-12' }
  const onlyS = cal.buildMonth({ year: 2026, month: 8, today: TODAY, tasks: [t7] })
  check('只有开始 → 按单日处理', cellOf(onlyS, 12).events.length === 1 && cellOf(onlyS, 12).events[0].span === 'only')

  // ── 6. 未安排 / 其它月份（跨月投诉的核心）────────────────────────
  const t8 = { id: 't8', title: '无时间', status: '待办', priority: '中' }
  const t9 = { id: 't9', title: '下月', status: '待办', priority: '中', deadline: '2026-11-10' }
  const t10 = { id: 't10', title: '已完成', status: '完成', priority: '中', deadline: '2026-09-15' }
  const t11 = { id: 't11', title: '已驳回', status: '驳回', priority: '中', deadline: '2026-09-16' }
  const mix = cal.buildMonth({ year: 2026, month: 8, today: TODAY, tasks: [t1, t8, t9, t10, t11] })
  check('无时间 → 未安排', mix.unscheduled.map(x => x.id).join() === 't8', mix.unscheduled.map(x => x.id).join())
  check('下月任务不再混进「未安排」', !mix.unscheduled.some(x => x.id === 't9'))
  check('下月任务归入「其它月份」', mix.otherMonths.length === 1 && mix.otherMonths[0].key === '2026-11' &&
    mix.otherMonths[0].count === 1, JSON.stringify(mix.otherMonths))
  check('其它月份合计 = 1', mix.otherTotal === 1, String(mix.otherTotal))
  check('终态任务（完成/驳回）不进日历，也不进未安排',
    !mix.unscheduled.some(x => x.id === 't10' || x.id === 't11') &&
    cellOf(mix, 15).events.length === 0 && cellOf(mix, 16).events.length === 0)
  check('跨月跳转信息含年月（供 calGoto 使用）',
    mix.otherMonths[0].year === 2026 && mix.otherMonths[0].month === 10 && /2026 年 11 月/.test(mix.otherMonths[0].label),
    JSON.stringify(mix.otherMonths[0]))

  // ── 7. 待办联动 ───────────────────────────────────────────────────
  const td1 = { id: 'd1', title: '待办A', done: false, due: '2026-09-25', priority: '中' }
  const td2 = { id: 'd2', title: '待办B', done: true, due: '2026-09-25', priority: '中' }
  const td3 = { id: 'd3', title: '待办C', done: false, due: '2026-10-09', priority: '中' }
  const withTodos = cal.buildMonth({
    year: 2026, month: 8, today: TODAY, tasks: [], todos: [td1, td2, td3], showTodos: true,
  })
  check('待办按 due 上月历（kind=todo）',
    cellOf(withTodos, 25).events.length === 1 && cellOf(withTodos, 25).events[0].kind === 'todo')
  check('已完成待办不上日历', cellOf(withTodos, 25).events.filter(e => e.id === 'd2').length === 0)
  check('下月待办出现在「其它月份」（而不是凭空消失）',
    withTodos.otherMonths.some(g => g.key === '2026-10'), JSON.stringify(withTodos.otherMonths))
  const noTodos = cal.buildMonth({
    year: 2026, month: 8, today: TODAY, tasks: [], todos: [td1], showTodos: false,
  })
  check('关掉「显示待办」后不留痕', cellOf(noTodos, 25).events.length === 0 && noTodos.otherTotal === 0)

  // ── 8. 排序：时间段长、优先级高者靠前 ────────────────────────────
  const a = { id: 'a', title: '长区间', status: '待办', priority: '低', start: '2026-09-03', deadline: '2026-09-09' }
  const b = { id: 'b', title: '单日高', status: '待办', priority: '高', deadline: '2026-09-05' }
  const sorted = cal.buildMonth({ year: 2026, month: 8, today: TODAY, tasks: [b, a] })
  check('时间段任务排在单日任务之前', cellOf(sorted, 5).events[0].id === 'a',
    cellOf(sorted, 5).events.map(e => e.id).join(','))

  // ── 9. 时间段平移（拖动整个区间）───────────────────────────────────
  const sh = cal.shiftRange('2026-09-05', '2026-09-08', '2026-09-20')
  check('平移保持长度（4 天）', sh.start === '2026-09-20' && sh.end === '2026-09-23', JSON.stringify(sh))
  const shCross = cal.shiftRange('2026-09-28', '2026-09-30', '2026-10-01')
  check('平移可跨月', shCross.start === '2026-10-01' && shCross.end === '2026-10-03', JSON.stringify(shCross))
  const shSingle = cal.shiftRange('', '', '2026-09-30')
  check('无区间时只落截止日', shSingle.end === '2026-09-30' && shSingle.start === '', JSON.stringify(shSingle))

  // ── 10. 展示文案 ──────────────────────────────────────────────────
  check('rangeLabel 区间', cal.rangeLabel('2026-09-01', '2026-09-05') === '2026-09-01 → 2026-09-05')
  check('rangeLabel 仅截止', cal.rangeLabel('', '2026-09-05') === '2026-09-05（截止）')
  check('rangeLabel 仅开始', cal.rangeLabel('2026-09-05', '') === '2026-09-05（开始）')
  check('rangeLabel 未指派', cal.rangeLabel(undefined, undefined) === '未指派')

  // ── 11. 渲染层确实在用这份逻辑（防漂移）──────────────────────────
  const appVue = fs.readFileSync(path.join(DESKTOP, 'src', 'renderer', 'App.vue'), 'utf-8')
  check('App.vue 导入 calendar.ts', /from '\.\/calendar'/.test(appVue))
  check('App.vue 使用 buildMonth', /buildMonth</.test(appVue) || /buildMonth\(/.test(appVue))
  check('App.vue 使用 shiftRange', /shiftRange\(/.test(appVue))
  check('App.vue 不再自己写日期算术（无内联 86400000 天差）', !/86400000/.test(appVue))

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('\n失败项：')
    for (const f of failures) console.log(' -', f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
