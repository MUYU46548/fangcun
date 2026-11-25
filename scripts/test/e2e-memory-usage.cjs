/**
 * 记忆召回计量 · 口径（2026-11-25 · P16.1）
 *
 * ## 它钉的是哪条（用户 2026-11-25 问卷）
 *
 * · D3=B：`usage.jsonl` **保留 core 行**（core 每轮注入也要留痕）；
 * · R2=A：排序的新鲜度锚是**上次被召回**，不是"上次被注入"。
 *
 * 两条直接拼会出事：core 每轮把 11 条钉住记忆各记一次 → `hits30d` 变常数 →
 * 「按使用强度召回」永远空转，B7 说的"常用老记忆不掉队"也永远做不到。
 *
 * 所以口径拆开：**日志里 core 照记（D3=B），但 hitsMap 只算 search / read / briefing（召回）**。
 *
 * 判据：
 *   ① core 行不影响 hitsMap（钉住条目不再被刷成常数）；
 *   ② search / read / briefing 各算一次，次数与 lastAt 都对得上；
 *   ③ 30 天窗口外的事件不算；
 *   ④ 文件不存在 = `started:false`（「计量没开始」≠「0 次」）。
 *
 * 运行：node scripts/test/e2e-memory-usage.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')

// 必须先桩 electron：data/index.ts 里有 `import { app } from 'electron'`
const ud = path.join(os.tmpdir(), 'fc-e2e-memusage-' + process.pid)
fs.mkdirSync(ud, { recursive: true })
fs.writeFileSync(path.join(ud, 'prefs.json'), '{}', 'utf-8')
process.env.FC_TEST_USERDATA = ud
{
  const STUB = path.join(__dirname, 'electron-stub.cjs')
  const Module = require('module')
  const orig = Module._resolveFilename
  Module._resolveFilename = function (request, ...args) {
    if (request === 'electron') return STUB
    return orig.call(this, request, ...args)
  }
}

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}

console.log('== 记忆召回计量 · 口径 ==')

const dataPath = path.join(DIST, 'data', 'index.js')
const usagePath = path.join(DIST, 'services', 'memoryUsage.js')
check('★★ 编译产物在（先跑 tsc -p tsconfig.main.json）',
  fs.existsSync(dataPath) && fs.existsSync(usagePath), usagePath)
if (!fs.existsSync(dataPath) || !fs.existsSync(usagePath)) {
  console.log(`\nRESULT ${pass} / ${fail}`)
  process.exit(1)
}

// 临时数据根：setDataDir 要求有 registry.yaml 或 task-data
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-memusage-'))
fs.mkdirSync(path.join(tmp, 'task-data'), { recursive: true })
const data = require(dataPath)
data.setDataDir(tmp)

const usage = require(usagePath)
check('★ memoryUsagePath 落在临时数据根（没碰真库）',
  usage.memoryUsagePath().startsWith(tmp), usage.memoryUsagePath())

const p = usage.memoryUsagePath()
fs.mkdirSync(path.dirname(p), { recursive: true })

const now = Date.parse('2026-11-25T12:00:00+08:00')
const at = (days) => new Date(now - days * 86400000).toISOString()
const events = [
  { at: at(1), tool: 'core', ids: ['A', 'B'], n: 2 },
  { at: at(2), tool: 'search', ids: ['A'], n: 1, q: 'x' },
  { at: at(3), tool: 'read', ids: ['B'], n: 1 },
  { at: at(4), tool: 'briefing', ids: ['A'], n: 1 },
  { at: at(45), tool: 'search', ids: ['A'], n: 1 }, // 30 天窗口外
]
fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')

// ① hitsMap 只算召回：A = search + briefing = 2；B = read = 1
const hits = usage.hitsMap(30)
check('★★ core 注入不进 hitsMap（钉住条目不再被刷成常数）', hits.get('A') === 2 && hits.get('B') === 1,
  `A=${hits.get('A')} B=${hits.get('B')}`)
check('★★ 30 天外的事件不算（A 没有 +1）', hits.get('A') === 2, `A=${hits.get('A')}`)

// ② 日志里 core 还在（D3=B 保留）；全量读回能看到 3 次 A
const all = usage.readMemoryUsage(30)
check('★ usage.jsonl 仍保留 core 行（D3=B：core 也记）', all.counts.get('A') === 3,
  `A=${all.counts.get('A')}`)
check('★ 全量 events 计数 = 窗口内 4 条（core/search/read/briefing）', all.events === 4, String(all.events))

// ③ lastAt 用的是最近一次**召回**，不是 core 注入
const recall = usage.readMemoryUsage(30, Date.now(), { recallOnly: true })
check('★★ lastAt 取召回时刻（search 第 2 天），不是 core 第 1 天',
  recall.lastAt.get('A') === at(2), `${recall.lastAt.get('A')} vs ${at(2)}`)

// ④ 文件不存在 = 计量没开始，不是 0 次
const backup = p + '.bak'
fs.renameSync(p, backup)
try {
  const none = usage.readMemoryUsage(30)
  check('★★ 没有 usage.jsonl 时 started=false（「没开始」≠「0 次」）',
    none.started === false && none.counts.size === 0, JSON.stringify({ started: none.started, n: none.counts.size }))
  check('★ 此时 hitsMap 是空 Map（不是报错）', usage.hitsMap(30).size === 0)
} finally {
  fs.renameSync(backup, p)
}

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  · ' + f)
  process.exit(1)
}
