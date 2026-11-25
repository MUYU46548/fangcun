/**
 * 记忆 v3 端到端生命周期 · 搜 → 读 → 写 → 批 → 注入（2026-11-25 · P16.6）
 *
 * 这是 P16 验收判据之一（`e2e-memory-lifecycle.cjs` 退出码 0），也是一份**可演示的脚本**：
 * 跑一遍就能看到一条记忆从「agent 写、待审批」到「用户批、检索命中、注入 core / 简报、
 * 读原文、被新版本取代、被合并」的完整路径。
 *
 * 判据不是"函数能跑"，而是每一步的**边界**都成立：
 *  ① 写 → 永远待审批；默认检索看不见，includePending 才看得见；
 *  ② 批 → 用户通过后才有效；默认检索能命中；
 *  ③ 注入 → core 只装钉住的 claim，简报按项目带 claim，证据正文不自动进；
 *  ④ 读 → 证据逐字返回；锚点找不到必须报错，不许静默塞全文；
 *  ⑤ 作用域 → topic:t1 生效时不串 topic:t2；world 恒中；
 *  ⑥ 取代 → 新版本通过后旧版自动「已撤销 + 被取代」，文件不删；
 *  ⑦ 合并 → 幸存者是最长原句，被并条目标「已撤销 + 被合并」，merged.jsonl 留档；
 *  ⑧ 计量 → usage.jsonl 真有 search / read / briefing 记录（core 不进召回统计，D3=B）。
 *
 * 运行：node scripts/test/e2e-memory-lifecycle.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')

// electron 桩 + 隔离的 prefs：产品模块 import electron，纯 Node 下要重定向
{
  const ud = path.join(os.tmpdir(), 'fc-e2e-lifecycle-' + process.pid)
  fs.mkdirSync(ud, { recursive: true })
  fs.writeFileSync(path.join(ud, 'prefs.json'), JSON.stringify({ memoryCoreBudget: 4000 }), 'utf-8')
  process.env.FC_TEST_USERDATA = ud
  const STUB = path.join(__dirname, 'electron-stub.cjs')
  const Module = require('module')
  const origResolve = Module._resolveFilename
  Module._resolveFilename = function (request, ...args) {
    if (request === 'electron') return STUB
    return origResolve.call(this, request, ...args)
  }
}

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}

console.log('== 记忆 v3 生命周期：搜 → 读 → 写 → 批 → 注入 ==')

const mem = require(path.join(DIST, 'main', 'services', 'memory.js'))
const data = require(path.join(DIST, 'main', 'data', 'index.js'))
const usage = require(path.join(DIST, 'main', 'services', 'memoryUsage.js'))

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-lifecycle-'))
fs.writeFileSync(path.join(tmpRoot, 'registry.yaml'), 'projects: []\n', 'utf-8')
fs.mkdirSync(path.join(tmpRoot, 'task-data'), { recursive: true })
data.setDataDir(tmpRoot)

// ── ① 写：agent 提案 → 待审批 ─────────────────────────────────────────
console.log('\n-- ① 写（agent 只能落待审批）--')
const CLAIM = '端到端：先写后批，证据逐字保留'
const made = mem.createMemory({
  type: '教训', claim: CLAIM, evidence: '原文逐字：这是生命周期测试的证据，不能被摘要。',
  source: 'e2e-lifecycle', project: 'p1', pinned: true, importance: 5, confidence: 0.8,
}, { pending: true })
check('★★ 写入口真落盘', made.ok === true && fs.existsSync(path.join(tmpRoot, made.file)), made.error || '')
const pendingText = fs.readFileSync(path.join(tmpRoot, made.file), 'utf-8')
check('★★ 强制写 状态: 待审批（不是有效）', /^状态: 待审批$/m.test(pendingText))
check('★★ 默认检索看不见待审批', mem.searchMemory({ q: '端到端' }).total === 0)
check('★ includePending 才看得见', mem.searchMemory({ q: '端到端', includePending: true }).total === 1)

// ── ② 批：用户通过 → 有效 ─────────────────────────────────────────────
console.log('\n-- ② 批（用户点头后才算数）--')
const approved = mem.setMemoryStatus(made.file, '有效')
const hit = mem.searchMemory({ q: '端到端' })
check('★★ 通过后变有效、默认可检索', approved.ok === true && hit.total === 1, approved.error || '')
check('★★ 检索只给 claim、不带证据正文', hit.rows[0].claim === CLAIM && !String(hit.rows[0].claim).includes('生命周期测试的证据'))

// ── ③ 注入：core / 简报 ───────────────────────────────────────────────
console.log('\n-- ③ 注入（core 只装钉住；简报按项目）--')
mem.generateCore()
const core = mem.memoryCore()
check('★★ core 含钉住的 claim', core.ok === true && core.text.includes(CLAIM), core.error || '')
check('★ core 预算来自 prefs（4000）', core.budget === 4000, String(core.budget))
check('★★ core 不塞证据正文', !core.text.includes('生命周期测试的证据'))
const brief = mem.memoryBriefing('p1')
check('★★ 简报按项目带 claim', brief.items.some((x) => x.id === made.id && x.claim === CLAIM))
check('★ 简报不带证据正文', !JSON.stringify(brief.items).includes('生命周期测试的证据'))

// ── ④ 读：证据逐字；锚点找不到必须报错 ─────────────────────────────────
console.log('\n-- ④ 读（原文按需取）--')
const read = mem.readMemory(made.file, 8000)
check('★★ 读原文逐字返回', read.ok === true && read.text.includes('这是生命周期测试的证据，不能被摘要。'), read.error || '')
const badAnchor = mem.readMemory(made.file, 8000, '不存在的锚')
check('★★ 锚点找不到 → 报错（不许静默塞全文）', badAnchor.ok === false && /锚/.test(String(badAnchor.error)), badAnchor.error)

// ── ⑤ 作用域：topic 不串味，world 恒中 ─────────────────────────────────
console.log('\n-- ⑤ 作用域（topic 不串味，world 恒中）--')
function makeTopic(claim, topic) {
  const r = mem.createMemory({ type: '纪律', claim, evidence: '证据 ' + topic, source: 'e2e-lifecycle', project: 'p1' }, { force: true })
  if (!r.ok) throw new Error(r.error)
  const p = path.join(tmpRoot, r.file)
  fs.writeFileSync(p, fs.readFileSync(p, 'utf-8').replace('格式: 2', `作用域: ${topic}\n格式: 3`), 'utf-8')
  return r
}
const t1 = makeTopic('作用域测试：只属于 t1', 'topic:t1')
const t2 = makeTopic('作用域测试：只属于 t2', 'topic:t2')
mem.setMemoryStatus(t1.file, '有效')
mem.setMemoryStatus(t2.file, '有效')
const scoped = mem.searchMemory({ q: '作用域测试', scopes: ['topic:t1'] })
const scopedIds = scoped.rows.map((x) => x.id)
check('★★ 活跃 t1 时命中 t1', scopedIds.includes(t1.id) && !scopedIds.includes(t2.id), JSON.stringify(scopedIds))
const worldScoped = mem.searchMemory({ q: '端到端', scopes: ['topic:t1'] })
check('★★ world 恒中（生命周期那条也能被带回）', worldScoped.rows.some((x) => x.id === made.id),
  JSON.stringify(worldScoped.rows.map((x) => x.id)))

// ── ⑥ 取代：新版本通过 → 旧版撤销 ─────────────────────────────────────
console.log('\n-- ⑥ 取代（改动 = 新版本，不原地改）--')
const fork = mem.createMemory({
  type: '教训', claim: CLAIM, evidence: '原文逐字：这是生命周期测试的证据（第二版）。',
  source: 'e2e-lifecycle', supersedes: made.id,
}, { pending: true })
check('★★ 另存新版本落待审批', fork.ok === true && /^状态: 待审批$/m.test(fs.readFileSync(path.join(tmpRoot, fork.file), 'utf-8')), fork.error || '')
mem.setMemoryStatus(fork.file, '有效')
const oldText = fs.readFileSync(path.join(tmpRoot, made.file), 'utf-8')
check('★★ 旧版自动「已撤销 + 被取代」', /^状态: 已撤销$/m.test(oldText) && new RegExp('^被取代: ' + fork.id + '$', 'm').test(oldText))
check('★ 旧版文件没删', fs.existsSync(path.join(tmpRoot, made.file)))

// ── ⑦ 合并：只并原句 + merged.jsonl ───────────────────────────────────
console.log('\n-- ⑦ 合并（只许并、不许新增）--')
const m1 = makeTopic('合并测试：按进程名批量杀浏览器会连带杀掉用户窗口', 'world')
const m2 = makeTopic('合并测试：绝不按进程名批量杀浏览器，会连带杀掉用户窗口', 'world')
mem.setMemoryStatus(m1.file, '有效')
const merged = mem.mergeMemories([m1.id, m2.id])
check('★★ 合并成功、幸存者是最长原句', merged.ok === true && merged.id === m2.id, merged.error || '')
check('★★ 被并条目标「已撤销 + 被合并」', /^状态: 已撤销$/m.test(fs.readFileSync(path.join(tmpRoot, m1.file), 'utf-8'))
  && new RegExp('^被合并: ' + m2.id + '$', 'm').test(fs.readFileSync(path.join(tmpRoot, m1.file), 'utf-8')))
check('★★ merged.jsonl 追加了记录', fs.existsSync(path.join(tmpRoot, 'memory', 'merged.jsonl'))
  && /"survivor":"/.test(fs.readFileSync(path.join(tmpRoot, 'memory', 'merged.jsonl'), 'utf-8')))

// ── ⑧ 计量：usage.jsonl 真有召回记录 ──────────────────────────────────
console.log('\n-- ⑧ 计量（召回才记；core 不进召回）--')
const u = usage.readMemoryUsage(30, Date.now(), { recallOnly: true })
check('★★ usage.jsonl 存在且真记了事件', fs.existsSync(path.join(tmpRoot, 'memory', 'usage.jsonl')) && u.events > 0, 'events=' + u.events)
check('★ 召回计数里有刚才搜到的条目', u.counts.has(fork.id) || u.counts.has(made.id) || u.counts.has(t1.id),
  JSON.stringify([...u.counts.keys()]))

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  · ' + f)
  process.exit(1)
}
