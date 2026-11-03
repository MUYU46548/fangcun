#!/usr/bin/env node
/**
 * 路线图趋势（2026-11-03 · task-20261011-002 方案 ①）—— 真跑编译产物 + 临时数据根
 *
 * 判据不是“有趋势数据”，而是**按天回算得对**：
 *   · 点的数量 = 请求的天数（clamp 1–90），日期升序，最后一天是今天；
 *   · 已完成的任务从“完成事件那天”起算 completed，之前仍算 active；
 *   · 阻塞只算“当天仍未到终态”的任务，完成/驳回后不再计入；
 *   · `.activity.log` 里的坏行（历史手写/半截写入）不能让整份趋势打空；
 *   · 读趋势**不改任何文件**（只读）。
 *
 * 运行：node scripts/test/e2e-roadmap-trend.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-roadmap-trend-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT
const DIST = path.resolve(__dirname, '../../desktop/dist/main')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log('FAIL  ' + name + (detail ? '  → ' + detail : ''))
  }
}

/** 本地某天中午的 ISO（离日界足够远，避免时区把日期挪一天） */
function isoDaysAgo(n, hour = 12) {
  const d = new Date()
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, hour, 0, 0, 0)
  return x.toISOString()
}
function localDate(n) {
  const d = new Date()
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - n)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}
function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
}
function taskMd(id, title, status, createdDaysAgo, updatedDaysAgo, blockers = []) {
  return `---
id: ${id}
标题: ${title}
项目: demo
状态: ${status}
创建: '${isoDaysAgo(createdDaysAgo)}'
更新: '${isoDaysAgo(updatedDaysAgo)}'
阻塞: [${blockers.map((b) => `'${b}'`).join(', ')}]
---

正文
`
}

function main() {
  console.log('== 路线图趋势测试 ==')
  console.log('root:', TEST_ROOT)
  fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
  writeFile(path.join(TEST_ROOT, 'registry.yaml'), 'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示\n')

  // 两张卡：A 五天前建、两天前完成；B 四天前建、一天前进“进行中”、带阻塞
  writeFile(path.join(TEST_ROOT, 'task-data', 'task-a.md'), taskMd('task-a', 'A 卡', '完成', 5, 2))
  writeFile(path.join(TEST_ROOT, 'task-data', 'task-b.md'), taskMd('task-b', 'B 卡', '进行中', 4, 1, ['task-x']))

  const activity = [
    JSON.stringify({ ts: isoDaysAgo(2), tid: 'task-a', action: 'move_status', detail: '完成' }),
    JSON.stringify({ ts: isoDaysAgo(1), tid: 'task-b', action: 'move_status', detail: '进行中' }),
    // 历史坏行：必须跳过，不能把整份日志读空
    '{ 这不是 JSON',
    '',
  ].join('\n') + '\n'
  writeFile(path.join(TEST_ROOT, 'task-data', '.activity.log'), activity)

  const data = require(path.join(DIST, 'data', 'index.js'))
  const tasks = require(path.join(DIST, 'data', 'tasks.js'))
  data.setDataDir(TEST_ROOT)

  const before = {
    md: fs.readFileSync(path.join(TEST_ROOT, 'task-data', 'task-a.md'), 'utf-8'),
    log: fs.readFileSync(path.join(TEST_ROOT, 'task-data', '.activity.log'), 'utf-8'),
  }

  const trend = tasks.getRoadmapTrend(7)
  const pts = trend.demo || []
  check('返回 demo 项目的趋势', pts.length === 7, 'points=' + pts.length)
  check('日期升序且最后一天是今天',
    pts.length === 7 && pts[0].date === localDate(6) && pts[6].date === localDate(0)
    && pts.every((p, i) => i === 0 || p.date > pts[i - 1].date),
    JSON.stringify(pts.map((p) => p.date)))
  check('每天都有 ts / name 字段', pts.every((p) => Number.isFinite(p.ts) && p.name === '演示'))

  const at = (n) => pts.find((p) => p.date === localDate(n))
  check('★★ 完成前（3 天前）：A/B 都算活跃，completed=0',
    at(3) && at(3).active === 2 && at(3).completed === 0, JSON.stringify(at(3)))
  check('★★ 完成事件当天（2 天前）：completed=1，A 不再算 active',
    at(2) && at(2).completed === 1 && at(2).active === 1, JSON.stringify(at(2))) // 此时 B 已创建、仍待办
  check('★★ 阻塞只算未到终态的：今天 active=1 / blocked=1 / completed=1',
    at(0) && at(0).active === 1 && at(0).completed === 1 && at(0).blocked === 1, JSON.stringify(at(0)))

  const only1 = tasks.getRoadmapTrend(0)
  check('days=0 → clamp 到 1 天（不返回空数组）', (only1.demo || []).length === 1, String((only1.demo || []).length))
  const huge = tasks.getRoadmapTrend(999)
  check('days 上限 90（不因为手填 999 就扫到未来）', (huge.demo || []).length === 90, String((huge.demo || []).length))

  const after = {
    md: fs.readFileSync(path.join(TEST_ROOT, 'task-data', 'task-a.md'), 'utf-8'),
    log: fs.readFileSync(path.join(TEST_ROOT, 'task-data', '.activity.log'), 'utf-8'),
  }
  check('★★ 读趋势只读：任务文件与活动日志一个字节都没变',
    before.md === after.md && before.log === after.log)

  const all = data.readActivityAll()
  check('活动日志坏行被跳过（读到 2 条有效事件）', all.length === 2, 'n=' + all.length)

  // 接线守卫：界面必须真的调这个通道（否则它又变回死通道）
  const view = fs.readFileSync(path.resolve(__dirname, '../../desktop/src/renderer/views/RoadmapView.vue'), 'utf-8')
  check('★ 路线图界面真调 getRoadmapTrend', /getRoadmapTrend\s*\(/.test(view))
  check('★ 趋势有可见的图形/数字（不是只取数不显示）',
    /rp-spark|rp-trend/.test(view))

  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log('  - ' + f)) }
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch {}
  process.exit(fail ? 1 : 0)
}

main()
