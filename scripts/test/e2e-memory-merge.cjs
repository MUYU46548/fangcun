/**
 * 合并有根 · 端到端（2026-11-25 · P16.3）
 *
 * 判据不是"能合并"，而是**只并该并的、并完不丢原文、拒绝时说清为什么**：
 *  ① 只算有效条目、同类型 + 同作用域、覆盖比 ≥45% 才成候选；
 *  ② 合并句必须是**原句之一**（选最长的那句），不生成新句子；
 *  ③ 被并条目标「已撤销 + 被合并」，文件不删；`merged.jsonl` 追加一行；
 *  ④ 幸存者文件**逐字节不变**（写入即只读，合并也不能改它）；
 *  ⑤ 不足 2 条 / id 不存在 / 非有效 / 类型不同 / 作用域不同 → 拒绝并点名。
 *
 * 运行：node scripts/test/e2e-memory-merge.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')

// 与 e2e-memory 同一套桩：产品模块 import electron，纯 Node 下要重定向
{
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

console.log('== 合并有根 ==')
const mem = require(path.join(DIST, 'main', 'services', 'memory.js'))
const data = require(path.join(DIST, 'main', 'data', 'index.js'))

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-mem-merge-'))
fs.writeFileSync(path.join(tmpRoot, 'registry.yaml'), 'projects: []\n', 'utf-8')
fs.mkdirSync(path.join(tmpRoot, 'task-data'), { recursive: true })
data.setDataDir(tmpRoot)

const created = []
function make(opts, writeOpts = {}) {
  const r = mem.createMemory({ source: 'e2e-merge', ...opts }, writeOpts)
  if (!r.ok) throw new Error('夹具创建失败：' + (r.error || ''))
  created.push(r)
  return r
}

const m1 = make({ type: '纪律', claim: '不要按进程名批量杀浏览器，只按 PID 精确处理', evidence: 'm1 原文' })
const m2 = make({ type: '纪律', claim: '绝不按进程名批量杀浏览器 —— 会连带杀掉用户的窗口', evidence: 'm2 原文' })
// 夹具要造重复样本，查重会拦，所以 force（这是测试夹具，不是产品路径）
const m3 = make({ type: '事故', claim: '不要按进程名批量杀浏览器，只按 PID 精确处理', evidence: 'm3 原文' }, { force: true })

// 同句不同作用域：直接改盘上的 frontmatter（测试夹具，不走写入即只读）
const m4 = make({ type: '纪律', claim: '同一条规矩的两种说法', evidence: 'm4 原文' })
const m5 = make({ type: '纪律', claim: '同一条规矩的两种说法', evidence: 'm5 原文' }, { force: true })
for (const [r, scope] of [[m4, 'topic:x'], [m5, 'topic:y']]) {
  const p = path.join(tmpRoot, r.file)
  fs.writeFileSync(p, fs.readFileSync(p, 'utf-8').replace('格式: 2', `作用域: ${scope}\n格式: 2`), 'utf-8')
}
const m6 = make({ type: '纪律', claim: '这条已经被撤销', evidence: 'm6 原文' })
mem.setMemoryStatus(m6.file, '已撤销', '夹具')

// ① 候选
const cand = mem.mergeCandidates()
check('★★ 只算「有效 + 同类型 + 同作用域 + 覆盖 ≥45%」的簇',
  cand.ok === true && cand.clusters.some((c) => c.ids.includes(m1.id) && c.ids.includes(m2.id)),
  JSON.stringify(cand.clusters.map((c) => c.ids)))
check('★ 类型不同（m3）不并进来',
  !cand.clusters.some((c) => c.ids.includes(m3.id)), JSON.stringify(cand.clusters.map((c) => c.ids)))
check('★ 作用域不同（m4/m5）不并进来',
  !cand.clusters.some((c) => c.ids.includes(m4.id)), JSON.stringify(cand.clusters.map((c) => c.ids)))
check('★ 已撤销（m6）不进候选',
  !cand.clusters.some((c) => c.ids.includes(m6.id)), JSON.stringify(cand.clusters.map((c) => c.ids)))

// ② 合并
const survivorTextBefore = fs.readFileSync(path.join(tmpRoot, m2.file), 'utf-8')
const merged = mem.mergeMemories([m1.id, m2.id])
check('★★ 合并成功，幸存者是最长的那句原话', merged.ok === true && merged.id === m2.id,
  (merged.error || '') + ' id=' + (merged.id || ''))
check('★★ 返回被合并的 id', Array.isArray(merged.merged) && merged.merged.length === 1 && merged.merged[0] === m1.id,
  JSON.stringify(merged.merged))
const m1Text = fs.readFileSync(path.join(tmpRoot, m1.file), 'utf-8')
check('★★ 被并条目标「已撤销 + 被合并」，文件没删',
  /^状态: 已撤销$/m.test(m1Text) && new RegExp('^被合并: ' + m2.id + '$', 'm').test(m1Text),
  m1Text.slice(0, 160))
check('★★ 幸存者文件逐字节不变（合并不能改已批准条目的正文）',
  fs.readFileSync(path.join(tmpRoot, m2.file), 'utf-8') === survivorTextBefore)

// ③ merged.jsonl
const ledger = path.join(tmpRoot, 'memory', 'merged.jsonl')
check('★★ merged.jsonl 追加了一行', fs.existsSync(ledger), ledger)
const line = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf-8').trim().split('\n').pop() : ''
let row = null
try { row = JSON.parse(line) } catch { row = null }
check('★★ 这一行记了 ids / survivor / 合并句 / scope / kind',
  row && row.ids.length === 2 && row.survivor === m2.id && row.claim === merged.claim
    && row.scope === 'world' && row.kind === '纪律',
  line.slice(0, 200))

// ④ 拒绝
check('★★ 少于两条 → 拒绝', mem.mergeMemories([m3.id]).ok === false)
check('★★ id 不存在 → 拒绝', mem.mergeMemories([m3.id, 'mem-nope']).ok === false)
check('★★ 已撤销条目 → 拒绝', mem.mergeMemories([m6.id, m4.id]).ok === false
  && /有效/.test(String(mem.mergeMemories([m6.id, m4.id]).error)), mem.mergeMemories([m6.id, m4.id]).error)
check('★★ 类型不同 → 拒绝', mem.mergeMemories([m2.id, m3.id]).ok === false
  && /类型|作用域/.test(String(mem.mergeMemories([m2.id, m3.id]).error)), mem.mergeMemories([m2.id, m3.id]).error)
check('★★ 作用域不同 → 拒绝', mem.mergeMemories([m4.id, m5.id]).ok === false
  && /作用域/.test(String(mem.mergeMemories([m4.id, m5.id]).error)), mem.mergeMemories([m4.id, m5.id]).error)

// ⑤ 合并后计数：两条都还在（一条撤销），total 不因合并减少文件
const ov = mem.memoryOverview()
check('★★ 合并后文件一条没少（撤销 ≠ 删除）', ov.total >= created.length, 'total=' + ov.total)
check('★ 已撤销计数包含被并条目', ov.revoked >= 2, 'revoked=' + ov.revoked)

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  · ' + f)
  process.exit(1)
}
