#!/usr/bin/env node
/**
 * 「哪些待办其实没人碰过」派生逻辑断言（卡 20261025-006 第三件，2026-10-27）
 *
 * 真跑**编译产物** `dist/shared/neverRead.js`（纯逻辑，不要 electron、不起子进程 → 本机可跑）。
 * 判据一句话：**"没人碰过"必须说清是"没有 agent 经 MCP 读过"，而不是"从来没人看过"** ——
 * 而且计量还没开始时不许报这个数，那会把全部未完成卡一起冤枉掉。
 *
 * 运行：node scripts/test/e2e-never-read.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'neverRead.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const { isOpenForRead, pickNeverRead, neverReadSummary } = require(ART)

console.log('== 读取情况 · 纯逻辑 ==')

// ── ① 「未完成」的判定：完成/驳回不算，**空状态算未完成** ──────────────
check('isOpenForRead: 待办 / 进行中 / 待审批 / 待验收 / 草稿 → true',
  ['待办', '进行中', '待审批', '待验收', '草稿'].every(s => isOpenForRead(s)))
check('★ isOpenForRead: 完成 / 驳回 → false（做完了没人读是正常的，不该进清单）',
  isOpenForRead('完成') === false && isOpenForRead('驳回') === false)
check('★★ isOpenForRead: 空状态算**未完成**（没填 ≠ 做完）',
  isOpenForRead('') === true && isOpenForRead('   ') === true &&
  isOpenForRead(null) === true && isOpenForRead(undefined) === true)

// ── ② 只有 0 引用的进清单 ──────────────────────────────────────────────
const T = (id, extra = {}) => Object.assign({ id, title: id, project: 'demo', status: '待办', priority: '中', updated: '2026-09-20T00:00:00.000Z' }, extra)
const base = [
  T('a'),                                    // 没人读 → 进
  T('b'),                                    // 读过 → 不进
  T('c', { status: '完成' }),                 // 完成 → 不进
  T('d', { status: '驳回' }),                 // 驳回 → 不进
  T('e', { status: '' }),                    // 空状态 → 进
]
const stats = { b: { reads: 3, lastRead: '2026-10-26T00:00:00.000Z', lastVia: 'get_task' } }
const r1 = pickNeverRead(base, stats, { days: 30, windowEvents: 9 })
check('★ 有读记录的卡不进清单', !r1.rows.some(x => x.id === 'b'))
check('★ 完成 / 驳回的卡不进清单', !r1.rows.some(x => x.id === 'c') && !r1.rows.some(x => x.id === 'd'))
check('★★ 空状态的卡进清单（没填 ≠ 做完）', r1.rows.some(x => x.id === 'e'))
check('★ 分母 openTotal 只数未完成的（5 张里 3 张）', r1.openTotal === 3, 'openTotal=' + r1.openTotal)
check('★ count === rows.length', r1.count === r1.rows.length)
check('★ windowEvents 原样透传（界面靠它决定说不说"没人碰过"）', r1.windowEvents === 9)
check('★ 进清单的行 reads 恒为 0', r1.rows.every(x => x.reads === 0))

// 反例：把 reads 判据去掉 → 全部未完成卡都会进清单
const rBad = pickNeverRead(base, stats, { days: 30, windowEvents: 9 })
check('★ 反例自证：若 b 也进了清单 → 说明 reads 判据失效', !rBad.rows.some(x => x.id === 'b'),
  '这时 b 被算进来了')

// ── ③ 去重：同一个 id 出现两次只算一张 ────────────────────────────────
const rDup = pickNeverRead([T('dup'), T('dup', { title: '第二份' })], {}, { days: 30, windowEvents: 1 })
check('★ 同 id 重复出现 → 清单里只有一条', rDup.rows.length === 1, 'rows=' + rDup.rows.length)
check('  重复时保留第一次见到的那个', rDup.rows[0].title === 'dup', rDup.rows[0].title)
const rNoId = pickNeverRead([{ id: '' }, { id: '   ' }, T('ok')], {}, { days: 30, windowEvents: 1 })
check('★ 空 id / 纯空白 id 的卡被丢掉（不进清单也不占分母）', rNoId.rows.length === 1 && rNoId.openTotal === 1)

// ── ④ 排序：优先级 高→中→低，同优先级**躺得最久的在前** ─────────────────
const rSort = pickNeverRead([
  T('p-low', { priority: '低', updated: '2026-01-01T00:00:00.000Z' }),
  T('p-high-newer', { priority: '高', updated: '2026-09-01T00:00:00.000Z' }),
  T('p-high-older', { priority: '高', updated: '2026-08-01T00:00:00.000Z' }),
  T('p-mid', { priority: '中', updated: '2026-02-01T00:00:00.000Z' }),
], {}, { days: 30, windowEvents: 1 })
check('★★ 排序：高优先级的排在低优先级前面（哪怕它更新更近）',
  rSort.rows.map(x => x.id).indexOf('p-high-newer') < rSort.rows.map(x => x.id).indexOf('p-low'),
  rSort.rows.map(x => x.id).join(' > '))
check('★ 同优先级里最久没更新的排前面',
  rSort.rows[0].id === 'p-high-older' && rSort.rows[1].id === 'p-high-newer',
  rSort.rows.map(x => x.id).join(' > '))

// 秒级 Unix 时间戳（Python 版 tegula 的写法）必须和 ISO 一起可比 —— 否则排序会整段错位
const rSec = pickNeverRead([
  T('iso-new', { updated: '2026-09-20T00:00:00.000Z' }),
  T('sec-old', { updated: 1787930114 }),  // 2026-08-27 左右，秒级
], {}, { days: 30, windowEvents: 1 })
check('★★ 秒级 Unix 时间戳和 ISO 一起能排（不因 Date.parse 失败被当成"最久没动"）',
  rSec.rows[0].id === 'sec-old', '实际第一条=' + rSec.rows[0].id)

// 读不出时间的排最后（不猜它很老、也不假装它很新）
const rBadTime = pickNeverRead([
  T('bad-time', { updated: '不是时间' }),
  T('good-time', { updated: '2026-05-01T00:00:00.000Z' }),
], {}, { days: 30, windowEvents: 1 })
check('★ 更新时间解析不出来的排最后（不用 Infinity 冒充"最久"）',
  rBadTime.rows[rBadTime.rows.length - 1].id === 'bad-time',
  rBadTime.rows.map(x => x.id).join(' > '))

// ── ⑤ 文案：口径必须跟数字在一起 ──────────────────────────────────────
const withEvents = neverReadSummary(r1)
check('★★ 有读卡记录时，文案里写明「只算 agent 经 MCP 读卡，界面里点开不算」',
  withEvents.includes('agent') && withEvents.includes('MCP') && withEvents.includes('界面'),
  withEvents)
check('★ 文案里带分子分母（不是只给一个数）',
  withEvents.includes('张 / 共'), withEvents)

const noEvents = neverReadSummary(Object.assign({}, r1, { windowEvents: 0 }))
check('★★ 一条读卡记录都没有时，文案**不许**出现「N 张没人碰过」那种分子分母',
  !noEvents.includes('张 / 共') && !noEvents.includes('0 引用'), noEvents)
check('★★ 而且要说清是「还没有任何 agent 读卡记录」（不是"全都没人碰过"）',
  noEvents.includes('还没有任何 agent 读卡记录'), noEvents)

const noneOpen = neverReadSummary({ rows: [], count: 0, openTotal: 0, windowEvents: 5, days: 30 })
check('★ 一张未完成的卡都没有时，文案说「当前没有未完成的卡」而不是「没人碰过 0」',
  noneOpen.includes('没有未完成的卡') && !noneOpen.includes('没人碰过'), noneOpen)

// ── ⑥ 输入健壮性：别的调用方传空进来自证不炸 ────────────────────────────
const rEmpty = pickNeverRead([], {}, { days: 30, windowEvents: 0 })
check('★ 空任务列表 → 空清单、不抛异常', rEmpty.count === 0 && rEmpty.openTotal === 0)
const rNull = pickNeverRead(null, null, {})
check('★ null 入参 → 当空处理（不抛异常）', rNull.count === 0 && rNull.days === 30)
check('★ days 非数字 → 退回 30（不把窗口算成 0 = 不限时间）',
  pickNeverRead([], {}, { days: 'abc' }).days === 30)
check('★ windowEvents 负数 → 归一成 0', pickNeverRead([], {}, { windowEvents: -3 }).windowEvents === 0)

// ── ⑦ 真数据根端到端：真 md → loadTasks → taskToNeverReadInput → pickNeverRead ──
// 为什么还要这一节：①~⑥ 测的是纯逻辑，**字段映射那一层一个字都没验**。
// 主进程真身的字段全在 `fm` 里而且是中文键（`fm.标题` / `fm.项目` 可能是数组）——
// 映射写错不会有任何报错，只会让清单里每张卡的标题变成空串（本仓栽过同款：漏了 deadline）。
// 所以这里用临时数据根写两张真卡，走完整链。
function realDataChecks() {
  console.log('\n── ⑦ 真数据根（真 md → 映射 → 判定）──')
  const os = require('os')
  const Module = require('module')
  const STUB = path.join(REPO, 'scripts/test/electron-stub.cjs')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-never-read-'))
  const orig = Module._resolveFilename
  process.env.FC_TEST_USERDATA = base
  try {
    fs.mkdirSync(path.join(base, 'task-data'), { recursive: true })
    fs.writeFileSync(path.join(base, 'registry.yaml'),
      'projects:\n  - id: demo\n    name: 演示项目\n', 'utf-8')
    const card = (id, title, status, prio, upd) => [
      '---', `id: ${id}`, `标题: ${title}`, '项目: [demo]', `状态: ${status}`,
      `优先级: ${prio}`, "创建: '2026-09-01T00:00:00.000Z'", `更新: '${upd}'`, '---', '## 方案', '- [ ] 占位', '',
    ].join('\n')
    fs.writeFileSync(path.join(base, 'task-data', 'task-nr-001.md'),
      card('task-nr-001', '真数据卡甲', '待办', '高', '2026-09-02T00:00:00.000Z'), 'utf-8')
    fs.writeFileSync(path.join(base, 'task-data', 'task-nr-002.md'),
      card('task-nr-002', '真数据卡乙', '完成', '低', '2026-09-03T00:00:00.000Z'), 'utf-8')
    // 只读「乙」——所以甲才是"没人碰过"的那张
    fs.writeFileSync(path.join(base, 'mcp-usage.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), via: 'get_task', ids: ['task-nr-002'] }) + '\n', 'utf-8')

    Module._resolveFilename = function (r, ...a) { return r === 'electron' ? STUB : orig.call(this, r, ...a) }
    // eslint-disable-next-line
    const data = require(path.join(REPO, 'desktop/dist/main/data/index.js'))
    data.setDataDir(base)
    // eslint-disable-next-line
    const U = require(path.join(REPO, 'desktop/dist/main/mcp/usage.js'))

    const tasks = data.loadTasks('active')
    check('  真数据根：loadTasks 读到两张卡', tasks.length === 2, 'n=' + tasks.length)
    const mapped = tasks.map(U.taskToNeverReadInput)
    const one = mapped.find(x => x.id === 'task-nr-001') || {}
    check('★★ 字段映射认得出中文 frontmatter（标题不是空串）', one.title === '真数据卡甲', JSON.stringify(one))
    check('★ 项目数组拼成字符串（不是 [object Object]）', one.project === 'demo', String(one.project))
    check('★ 状态 / 优先级 / 更新时间都取到了',
      one.status === '待办' && one.priority === '高' && String(one.updated).indexOf('2026-09-02') === 0,
      JSON.stringify({ s: one.status, p: one.priority, u: one.updated }))

    const { stats, events } = U.readSummary(30)
    check('★ 真 mcp-usage.jsonl 读出一条事件', events === 1, 'events=' + events)
    const res = pickNeverRead(mapped, stats, { days: 30, windowEvents: events })
    check('★★ 真数据判定：完成的那张不进清单，只剩甲',
      res.rows.length === 1 && res.rows[0].id === 'task-nr-001',
      res.rows.map(r => r.id + '/' + r.title).join(','))
    check('  分母只数未完成（1 张）', res.openTotal === 1, 'openTotal=' + res.openTotal)
  } finally {
    Module._resolveFilename = orig
    try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响结论 */ }
  }
}
realDataChecks()

console.log('')
if (fail) {
  console.log(`RESULT ${pass} / ${fail}`)
  console.log('失败项：')
  failures.forEach(f => console.log('  - ' + f))
  process.exit(1)
}
console.log(`RESULT ${pass} / 0`)
