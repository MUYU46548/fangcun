#!/usr/bin/env node
/**
 * 整理体检 —— 真数据端到端（2026-10-30，卡 task-20261025-006）
 *
 * 卡上被退回时写得很清楚：剩下两件 —— ① 把 `never_read` 接进整理/体检；② 给 0 引用清单补
 * **真数据**端到端（此前只有渲染层夹具）。这个脚本两件一起钉：
 *
 *   · 真临时数据根：3 张真 .md（2 张待办 + 1 张驳回，驳回卡带理由）+ 真的 `mcp-usage.jsonl`；
 *   · 走主进程真链路：`data.loadTasks` → `taskToNeverReadInput` → `readSummary` →
 *     `buildCleanupReport`（与 IPC `cleanup:scan` 同一段代码）；
 *   · 判据：读过的那张**不进**清单、驳回复工卡**不进**没人碰过但**进**返工清单、
 *     计量没开始时说“不算数”、口径文案必须跟着数字、任务文件**逐字节不变**。
 *
 * 运行：node scripts/test/e2e-cleanup.cjs
 */
const fs = require('fs')
const { mkTmp, mkTmpPath } = require('./_tmp.cjs')
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '../..')
const DIST = path.join(REPO, 'desktop', 'dist')
const TMP = mkTmp('cleanup-')
const DATA = path.join(TMP, 'data')
const USERDATA = path.join(TMP, 'userdata')
process.env.FC_TEST_USERDATA = USERDATA
for (const d of [DATA, path.join(DATA, 'task-data'), USERDATA]) fs.mkdirSync(d, { recursive: true })

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const ART = path.join(DIST, 'main', 'services', 'cleanup.js')
if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）')
  console.log('RESULT 0 / 1')
  process.exit(1)
}

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

const data = require(path.join(DIST, 'main', 'data', 'index.js'))
const usage = require(path.join(DIST, 'main', 'mcp', 'usage.js'))
const { neverReadSummary } = require(path.join(DIST, 'shared', 'neverRead.js'))
const { buildCleanupReport, CLEANUP_RULE } = require(ART)

// 数据根必须有 registry.yaml 才能 setDataDir
fs.writeFileSync(path.join(DATA, 'registry.yaml'), 'members:\n  - 测试\nprojects:\n  - id: demo\n    name: 演示\n', 'utf8')
data.setDataDir(DATA)

const TASK_DIR = path.join(DATA, 'task-data')
function writeTask(id, fm, body = '') {
  const lines = ['---', `id: ${id}`]
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`)
  lines.push('---', '', body || '正文', '')
  fs.writeFileSync(path.join(TASK_DIR, id + '.md'), lines.join('\n'), 'utf8')
}

writeTask('task-a', { 标题: '被读过的那张', 状态: '待办', 优先级: '中', 项目: '[demo]', 更新: "'2026-10-20T00:00:00.000Z'" })
writeTask('task-b', { 标题: '没人碰过的那张', 状态: '待办', 优先级: '高', 项目: '[demo]', 更新: "'2026-10-19T00:00:00.000Z'" })
writeTask('task-c', {
  标题: '被驳回的那张', 状态: '驳回', 优先级: '中', 项目: '[demo]',
  更新: "'2026-10-18T00:00:00.000Z'",
  result_log: "'[2026-10-18 10:00] 验收驳回：按钮点不动'",
})
// 第四张（2026-11-05）：挂着“进行中”但 72 小时没动 —— 原来它在通知中心报“没人接手”，
// 现在归整理体检的第三栏。它同时被 agent 读过，所以**不该**进“没人碰过”。
const STALLED_ISO = new Date(Date.now() - 72 * 3600_000).toISOString()
writeTask('task-d', {
  标题: '挂着进行中没动的那张', 状态: '进行中', 优先级: '中', 项目: '[demo]',
  更新: `'${STALLED_ISO}'`,
})
// 一条读卡记录：task-a 与 task-d 被 agent 读过（事件真身是 `ids` 数组，不是单个 id）
fs.writeFileSync(path.join(DATA, 'mcp-usage.jsonl'), [
  JSON.stringify({ ids: ['task-a', 'task-d'], ts: new Date().toISOString(), via: 'get_task' }),
].join('\n') + '\n', 'utf8')

const snapshot = () => fs.readdirSync(TASK_DIR).sort().map((f) => {
  const p = path.join(TASK_DIR, f)
  const st = fs.statSync(p)
  return f + ':' + st.size + ':' + st.mtimeMs
}).join('|')
const before = snapshot()

/** 与 IPC `cleanup:scan` 逐字同构的一段（改一处就要改两处 → 本脚本会红） */
function scan(days = 30) {
  const { stats, events } = usage.readSummary(days)
  const tasks = data.loadTasks('active').map((t) => ({
    ...usage.taskToNeverReadInput(t),
    result_log: String((t.fm && t.fm.result_log) || ''),
  }))
  return buildCleanupReport(tasks, stats, { days, windowEvents: events })
}

console.log('== ① 真数据根：两张清单各归各 ==')
const r = scan(30)
check('读到 4 张活跃卡（真 md → loadTasks；驳回也在活跃区）',
  data.loadTasks('active').length === 4, String(data.loadTasks('active').length))
check('分母 = 未完成卡（4 张里 1 张驳回 → 3）', r.neverRead.openTotal === 3, String(r.neverRead.openTotal))
check('★★ 只有 task-b 进“没人碰过”（task-a 读过、task-c 是驳回）',
  r.neverRead.rows.length === 1 && r.neverRead.rows[0].id === 'task-b',
  JSON.stringify(r.neverRead.rows.map((x) => x.id)))
check('★ 计数与行数一致（不许一个数一个清单）', r.neverRead.count === r.neverRead.rows.length)
check('★★ 驳回卡进“返工”清单，理由来自 result_log',
  r.rework.count === 1 && r.rework.rows[0].id === 'task-c' && r.rework.rows[0].reason.indexOf('按钮点不动') >= 0,
  JSON.stringify(r.rework.rows))
check('★ 已驳回的不重复进“没人碰过”（它不是未完成卡）',
  !r.neverRead.rows.some((x) => x.id === 'task-c'))
check('★ 计量有记录时 windowEvents > 0（数字算数）', r.neverRead.windowEvents > 0, String(r.neverRead.windowEvents))
check('★ 总览把两个数字说在一句里', r.text.indexOf('1') >= 0 && r.text.indexOf('没人碰过') >= 0 && r.text.indexOf('驳回') >= 0, r.text)
check('★★ 口径文案与数字同源（清理候选 ≠ 优先级）',
  r.rule === CLEANUP_RULE && r.rule.indexOf('不是优先级') >= 0, r.rule)
check('★ 返工清单最多带 5 条样例（不把整板搬进设置页）', r.rework.rows.length <= 5)

console.log('\n== ② 计量没开始：不许报“N 张没人碰过” ==')
fs.rmSync(path.join(DATA, 'mcp-usage.jsonl'), { force: true })
const r0 = scan(30)
check('没有 mcp-usage.jsonl → windowEvents = 0', r0.neverRead.windowEvents === 0, String(r0.neverRead.windowEvents))
const r0text = neverReadSummary(r0.neverRead)
check('★★ 计量没开始时话术改口（不是"3 张没人碰过"）',
  r0text.indexOf('还没有任何 agent 读卡记录') >= 0, r0text)
check('★ 这时不报具体张数（不冤枉全部未完成卡）',
  r0text.indexOf(' 张') < 0, r0text)

console.log('\n== ③ 只读：体检不许碰任务文件 ==')
const after = snapshot()
check('★★ 两张清单算完，task-data 里每个文件的大小与 mtime 一个不变', before === after,
  before === after ? '' : '前后快照不同')

console.log('\n== ④ 挂着“进行中”没动（2026-11-05 从通知中心挪进来）==')
{
  // 为什么挪：它宣称的判断超出了方寸能看见的范围 —— 只知“文件没被写”，
  // 而没被写至少三种原因（干完了没关单 / 在忙别的 / 真没人做），三种情况下人要做的事完全不同。
  // 放在这里就是“你主动点开核一下”，不再是系统替你下结论。
  const r4 = scan(30)
  check('★★ 第三栏算出 1 张（task-d：挂着进行中 72 小时没动）',
    !!r4.stalled && r4.stalled.count === 1 && r4.stalled.rows[0].id === 'task-d',
    JSON.stringify(r4.stalled && r4.stalled.rows))
  check('★ 小时数是真算的（72 ± 1），不是写死一个数',
    r4.stalled.rows[0].hours >= 71 && r4.stalled.rows[0].hours <= 73,
    String(r4.stalled.rows[0].hours))
  check('★★ 反例：待办 / 驳回的卡不进这一栏（它们天然不会回写，扫了就是噪音）',
    !r4.stalled.rows.some((x) => ['task-a', 'task-b', 'task-c'].includes(x.id)),
    JSON.stringify(r4.stalled.rows.map((x) => x.id)))
  check('★★ 口径写明“不代表有人在干、也不代表没人干”（否则这个数字会被读成结论）',
    /不代表有人在干/.test(r4.rule) && /关单|退回待办/.test(r4.rule), r4.rule.slice(0, 90))
  check('★ 总览一句话里三个数字都在（谁也别想只报一个）',
    /没人碰过/.test(r4.text) && /驳回/.test(r4.text) && /挂着进行中/.test(r4.text), r4.text)

  // 反例一：更新时间是坏值 → 跳过（不拿 mtime 兜、不猜。“算不出来”不该变成“卡住了”）
  writeTask('task-e', { 标题: '更新时间是坏值', 状态: '进行中', 优先级: '低', 项目: '[demo]', 更新: "'不是时间'" })
  const rE = scan(30)
  check('★★ 更新时间是坏值 → 不算“卡住”（算不出来 ≠ 卡住了）',
    !rE.stalled.rows.some((x) => x.id === 'task-e'),
    JSON.stringify(rE.stalled.rows.map((x) => x.id)))

  // 反例二：刚动过的进行中卡不进（24 小时阈值是硬的）
  writeTask('task-f', { 标题: '刚点进行中', 状态: '进行中', 优先级: '低', 项目: '[demo]', 更新: `'${new Date().toISOString()}'` })
  const rF = scan(30)
  check('★ 刚点“进行中”的卡不进（阈值 24 小时不许被放宽）',
    !rF.stalled.rows.some((x) => x.id === 'task-f'),
    JSON.stringify(rF.stalled.rows.map((x) => x.id)))
}

console.log('\n== ⑤ 源码守卫 ==')
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf-8')
const cleanupSrc = read('desktop/src/main/services/cleanup.ts')
const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
check('★★ 体检是纯逻辑（不许写盘 / 联网 / 调模型）',
  !/\b(writeFileSync|appendFileSync|rmSync|unlinkSync|mkdirSync|renameSync)\b|\bfetch\s*\(|\bhttp\.|openai|\bLLM\b/.test(strip(cleanupSrc)))
check('★ 两批口径都来自 shared/（不在服务里重写一套判定）',
  /shared\/neverRead/.test(cleanupSrc) && /shared\/rework/.test(cleanupSrc))
check('★ 主进程 IPC 接了 cleanup:scan，界面有入口',
  /guardedHandle\('cleanup:scan'/.test(read('desktop/src/main/ipc.ts')) &&
  /cleanupScan/.test(read('desktop/src/preload/index.ts')) &&
  // 2026-10-30 拆分第一刀后，入口在 components/DataHygienePanel.vue（App 只留跳转）
  (/runCleanup/.test(read('desktop/src/renderer/App.vue')) ||
    /runCleanup/.test(read('desktop/src/renderer/components/DataHygienePanel.vue'))))

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) {
  console.log('\n失败项：')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
