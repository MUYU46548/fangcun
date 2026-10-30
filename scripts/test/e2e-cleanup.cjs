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
 *     计量没开始时说「不算数」、口径文案必须跟着数字、任务文件**逐字节不变**。
 *
 * 运行：node scripts/test/e2e-cleanup.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '../..')
const DIST = path.join(REPO, 'desktop', 'dist')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-'))
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
// 一条读卡记录：只有 task-a 被 agent 读过（事件真身是 `ids` 数组，不是单个 id）
fs.writeFileSync(path.join(DATA, 'mcp-usage.jsonl'), [
  JSON.stringify({ ids: ['task-a'], ts: new Date().toISOString(), via: 'get_task' }),
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
check('读到 3 张活跃卡（真 md → loadTasks；驳回也在活跃区）',
  data.loadTasks('active').length === 3, String(data.loadTasks('active').length))
check('分母 = 未完成卡（3 张里 1 张驳回 → 2）', r.neverRead.openTotal === 2, String(r.neverRead.openTotal))
check('★★ 只有 task-b 进「没人碰过」（task-a 读过、task-c 是驳回）',
  r.neverRead.rows.length === 1 && r.neverRead.rows[0].id === 'task-b',
  JSON.stringify(r.neverRead.rows.map((x) => x.id)))
check('★ 计数与行数一致（不许一个数一个清单）', r.neverRead.count === r.neverRead.rows.length)
check('★★ 驳回卡进「返工」清单，理由来自 result_log',
  r.rework.count === 1 && r.rework.rows[0].id === 'task-c' && r.rework.rows[0].reason.indexOf('按钮点不动') >= 0,
  JSON.stringify(r.rework.rows))
check('★ 已驳回的不重复进「没人碰过」（它不是未完成卡）',
  !r.neverRead.rows.some((x) => x.id === 'task-c'))
check('★ 计量有记录时 windowEvents > 0（数字算数）', r.neverRead.windowEvents > 0, String(r.neverRead.windowEvents))
check('★ 总览把两个数字说在一句里', r.text.indexOf('1') >= 0 && r.text.indexOf('没人碰过') >= 0 && r.text.indexOf('驳回') >= 0, r.text)
check('★★ 口径文案与数字同源（清理候选 ≠ 优先级）',
  r.rule === CLEANUP_RULE && r.rule.indexOf('不是优先级') >= 0, r.rule)
check('★ 返工清单最多带 5 条样例（不把整板搬进设置页）', r.rework.rows.length <= 5)

console.log('\n== ② 计量没开始：不许报「N 张没人碰过」 ==')
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

console.log('\n== ④ 源码守卫 ==')
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
