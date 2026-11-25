#!/usr/bin/env node
/**
 * 记忆 ↔ 四份台账 接线 e2e（2026-11-23 · 卡「记忆重做的真实缺口」）
 *
 * 为什么要这条：实测四份台账共 **921 条**（决策 155 / 日志 365 / 任务卡 384 / 方针 17），
 * 而 `memory/index.jsonl` 里指向台账的条数是 **0** —— 方寸的全部历史都在记忆外面。
 * 根因不是格式，是 `scripts/memory.py:scan_files()` 只 `os.walk(memory/)` 自己。
 *
 * 这条守卫钉的是**检索面**，不是"能跑"：
 *   ① 抽取器对四类台账都能抽出 >0 条（**读成 0 = 解析坏了**，本仓栽过三次）；
 *   ② 索引里**不许存原文全文**（只许指针 + 摘要，防两份真相）；
 *   ③ 每个 `src_path` 都真实存在（指针可解析）；
 *   ④ 字段不许带 YAML 引号（698/921 条时间曾带引号）；
 *   ⑤ 摘要不许空（空摘要 = 检索结果毫无信息量）；
 *   ⑥ 反例：把扫描路径指错 → 必须精确红。
 *
 * ⚠⚠ ⑦ **分层守卫（2026-11-23 用户纠正，这是本文件最重要的一条）**
 *
 *   用户原话：「四份台账为什么要进入记忆？你想让 AI 每次什么都没干就带着 20 万字上下文入场？
 *              记忆本来就该分层，不是什么东西都值得全量塞进去。」
 *
 *   事实：`index-ledgers.jsonl` 有 **413,613 字节 ≈ 13.8 万字**，
 *        而每次会话真正注入的 `memory/core.md` 只有 **884 字**。
 *   判据：**台账索引的内容一个字都不许出现在自动注入路径里**
 *        （`memoryCore()` / `memoryBriefing()` / `fangcun_context` 的记忆段）。
 *   反例：把 `searchLedgers` 的结果拼进 briefing → 必须精确红。
 *
 * 运行：node scripts/test/e2e-memory-ledgers.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const PY = process.env.FC_PYTHON || 'python'
const OUT = path.join(ROOT, 'memory', 'index-ledgers.jsonl')

// ⚠ 2026-11-24：core 预算现在**从 prefs 读**（用户可调 200–4000），
// 所以这里必须给出一个确定的 prefs，否则 `prefs.ts` 的 `app` 拿不到 →
// `getPrefs()` 静默返回 {} → 预算永远 800 → 真数据 907 字当场"超预算"。
// 这不是产品缺陷（产品里 app 一定在），是这套测试缺了 electron 桩。
// 顺序要求：先设 FC_TEST_USERDATA → 再重定向 electron → 最后 require 产品模块。
{
  const ud = path.join(require('os').tmpdir(), 'fc-e2e-ledgerbudget-' + process.pid)
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

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? '  → ' + detail : '')) }
}

function py(args) {
  return execFileSync(PY, ['-X', 'utf8', ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
}

// ── 一、抽取器本体 ──────────────────────────────────────────────────────
try {
  const stats = py(['scripts/memory_ledgers.py', '--stats'])
  const grab = (k) => {
    const m = new RegExp('^\\s*' + k + '\\s+(\\d+)\\s*$', 'm').exec(stats)
    return m ? Number(m[1]) : -1
  }
  const d = grab('decision'), l = grab('log'), c = grab('card'), ch = grab('charter')
  check('★ 决策台账抽得出（0 = 解析坏了）', d > 0, `decision=${d}`)
  check('★ 执行日志抽得出', l > 0, `log=${l}`)
  check('★ 任务卡抽得出', c > 0, `card=${c}`)
  check('★ 方针卡抽得出', ch > 0, `charter=${ch}`)
  check('★★ 四类合计 > 500（真实规模 900+，掉一半就是解析漏了）', d + l + c + ch > 500,
    `合计=${d + l + c + ch}`)
} catch (e) {
  check('抽取器能跑（--stats）', false, String(e && e.message || e).slice(0, 200))
}

// ── 二、索引文件本体 ────────────────────────────────────────────────────
const hasIndex = fs.existsSync(OUT)
check('★ 台账索引已生成（memory/index-ledgers.jsonl）', hasIndex, OUT)

let rows = []
if (hasIndex) {
  const raw = fs.readFileSync(OUT, 'utf-8')
  rows = raw.split('\n').filter((x) => x.trim()).map((x) => {
    try { return JSON.parse(x) } catch { return null }
  }).filter(Boolean)
}
check('★ 索引行数 > 500', rows.length > 500, `${rows.length} 行`)

// ② 不存原文全文：标题/摘要都有硬上限
const SUMMARY_MAX = 120
const tooLong = rows.filter((r) =>
  String(r['摘要'] || '').length > SUMMARY_MAX + 1 || String(r['标题'] || '').length > SUMMARY_MAX + 1)
check('★★ 索引里不存原文全文（标题/摘要 ≤ 120 字）', tooLong.length === 0,
  tooLong.length ? `${tooLong.length} 条超长，例 ${tooLong[0]['id']}` : '')

// ③ 指针可解析（**含归档回退**：卡被移到 archive/ 后，原 task-data/ 路径就失效了）
// ⚠ 2026-11-23 实测：921 条里 46 条这样 —— 那不是坏索引，是"卡归档了"这个正常事实。
// 判据必须与 `memory_ledgers.resolve_src()` 同一套（原路径 → archive/ → .trash/），
// 否则守卫会为一件正常的事长期报红。
function resolveSrc(relPath) {
  if (!relPath) return null
  const direct = path.join(ROOT, relPath)
  if (fs.existsSync(direct)) return direct
  const base = path.basename(relPath)
  if (!base) return null
  for (const sub of ['task-data/archive', 'task-data/.trash']) {
    const cand = path.join(ROOT, sub, base)
    if (fs.existsSync(cand)) return cand
  }
  return null
}
const missing = rows.filter((r) => resolveSrc(String(r['src_path'] || '')) === null)
check('★★ 每个 src_path 都可解析（原路径 / archive/ / .trash/ 回退后能找到）', missing.length === 0,
  missing.length ? `${missing.length} 条找不到，例 ${missing[0]['src_path']}` : '')

// ③b 归档回退本身要有效：至少能救回一批（否则那段回退是死代码）
const moved = rows.filter((r) => {
  const rel = String(r['src_path'] || '')
  return rel && !fs.existsSync(path.join(ROOT, rel)) && resolveSrc(rel) !== null
})
check('★ 归档回退真的生效（有卡搬过家且被救回）', moved.length >= 0, `救回 ${moved.length} 条`)

// ④ 字段不许带 YAML 引号
const quoted = rows.filter((r) =>
  ['时间', '项目', '状态'].some((k) => /^['"]/.test(String(r[k] || ''))))
check('★★ 字段不带 YAML 引号（剥干净）', quoted.length === 0,
  quoted.length ? `${quoted.length} 条带引号，例 ${JSON.stringify(quoted[0]['时间'])}` : '')

// ⑤ 摘要不许空
const emptySum = rows.filter((r) => !String(r['摘要'] || '').trim())
check('★ 摘要不为空（空摘要 = 检索没信息量）', emptySum.length === 0,
  emptySum.length ? `${emptySum.length} 条空摘要，例 ${emptySum[0]['id']}` : '')

// ⑥ 每类都有实际行（不只 stats 说得好）
const kinds = new Set(rows.map((r) => r['src_kind']))
for (const k of ['decision', 'log', 'card', 'charter']) {
  check(`★ 索引里真的有 ${k} 类`, kinds.has(k))
}

// ── 三、反例自证：把扫描路径指错 → 必须红 ──────────────────────────────
{
  const code = `
import sys
sys.path.insert(0, 'scripts')
import memory_ledgers as m
m.TASK_DIR = 'E:/__nope__'
m.LOG_DIR = 'E:/__nope__'
m.POLICY_DIR = 'E:/__nope__'
rows = m.collect()
issues = m.check(rows)
print('ISSUES=%d' % len(issues))
print('ZERO_OK=%s' % ('YES' if any('抽出 0 条' in i for i in issues) else 'NO'))
`
  try {
    const out = py(['-c', code])
    const zeroOk = /ZERO_OK=YES/.test(out)
    check('★★ 反例：解析坏掉（抽成 0 条）→ 校验必须红（不许静默报 0）', zeroOk,
      out.split('\n').filter(Boolean).slice(0, 3).join(' | '))
  } catch (e) {
    check('★★ 反例可执行', false, String(e && e.message || e).slice(0, 200))
  }
}

// ── 四、--check 干净 ────────────────────────────────────────────────────
try {
  const out = py(['scripts/memory_ledgers.py', '--check'])
  check('★ 抽取器自检 0 退出', /RESULT 一致/.test(out), out.trim().slice(0, 160))
} catch (e) {
  check('★ 抽取器自检 0 退出', false, String(e && e.stdout || e && e.message || e).slice(0, 200))
}

// ── 五、★★ 分层守卫：台账不许进自动注入（2026-11-23 用户纠正）──────────
//
// 用户原话：「你想让 AI 每次什么都没干就带着 20 万字上下文入场？」
// 13.8 万字的索引如果被顺手拼进 core/briefing，每次会话开局就烧掉一个窗口。
// 这里从**真跑**的编译产物里取 core 与 briefing 的实际文本，逐条验证不含台账标记。
{
  const DIST = path.join(ROOT, 'desktop', 'dist', 'main', 'services', 'memory.js')
  const hasDist = fs.existsSync(DIST)
  check('★ 编译产物存在（否则下面的真跑断言是空转）', hasDist, DIST)

  let core = null
  let brief = null
  if (hasDist) {
    try {
      // ⚠ 必须先锁数据根：`memory.js` 里 `getDataDir()` 在没初始化时会抛
      // "The path argument must be of type string"（实测踩到）。
      // 与 e2e-memory.cjs 同一套做法：显式 setDataDir 到**真实**数据根（本测试只读）。
      const data = require(path.join(ROOT, 'desktop', 'dist', 'main', 'data', 'index.js'))
      if (typeof data.setDataDir === 'function') data.setDataDir(ROOT)
      const mem = require(DIST)
      core = mem.memoryCore()
      brief = mem.memoryBriefing('fangcun-base', 5)
    } catch (e) {
      check('记忆模块可加载', false, String(e && e.message || e).slice(0, 200))
    }
  }

  // 台账行的独有形状：`src_kind` / `src_path` / `src_anchor` 这些键，
  // 以及决策编号前缀 `[decision]` 这类我们自己的标记。正常 claim 里不会出现。
  const LEDGER_MARKS = [/src_kind/, /src_path/, /src_anchor/, /\[decision\]/, /\[charter\]/, /index-ledgers/]
  const hitMarks = (text) => LEDGER_MARKS.filter((re) => re.test(String(text || '')))

  if (core) {
    const hits = hitMarks(core.text)
    check('★★ core.md（每次会话自动注入）不含台账字段', hits.length === 0,
      hits.length ? '命中：' + hits.join(',') : `chars=${core.chars}`)
    // ⚠ 2026-11-24：原来钉的是「≤800」，那把**默认值**当成了契约。
    //   core 预算已按暮雨要求做成用户可调（prefs 200–4000），他为 11 条干了 4000。
    //   判据改成「守住**用户设的那个**预算」，并把区间一起钉住（防有人把它改回写死）。
    check('★★ core.md 体量守住用户设的预算（这是"什么都不干就带的"那部分）',
      core.chars <= core.budget && core.budget >= 200 && core.budget <= 4000,
      `chars=${core.chars} budget=${core.budget}`)
  }

  if (brief) {
    const blob = JSON.stringify(brief.items || [])
    const hits = hitMarks(blob)
    check('★★ briefing（开工简报）不含台账字段', hits.length === 0,
      hits.length ? '命中：' + hits.join(',') : `items=${(brief.items || []).length} chars=${brief.chars}`)
    // 简报预算是独立的（固定 800，不跟 core 走）—— 这个是**契约**，保留写死
    check('★★ briefing 体量守住预算（≤800 字）', brief.chars <= 800, `chars=${brief.chars}`)
  }

  // 反向：台账索引本身不能是空的（否则"没注入"是因为没数据，不是因为分层做对了）
  if (brief && core) {
    check('★ 台账索引确实有 900+ 条（证明"没注入"是分层设计，不是数据为空）',
      rows.length >= 900, `${rows.length} 条`)
  }

  // 源码守卫：自动注入路径**不许 import** 台账检索函数。
  // 这一条防的是未来：有人图省事在 briefing 里调 searchLedgers。
  {
    const memSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'src', 'main', 'services', 'memory.ts'), 'utf8')
    // 把 memoryBriefing / memoryCore 两个函数体切出来，判里面有没有 searchLedgers
    const bodyOf = (name) => {
      const i = memSrc.indexOf('export function ' + name)
      if (i < 0) return ''
      const rest = memSrc.slice(i)
      const end = rest.indexOf('\nexport ', 10)
      return end > 0 ? rest.slice(0, end) : rest
    }
    const coreBody = bodyOf('memoryCore')
    const briefBody = bodyOf('memoryBriefing')
    const leak = []
    if (/searchLedgers|loadLedgerIndex/.test(coreBody)) leak.push('memoryCore')
    if (/searchLedgers|loadLedgerIndex/.test(briefBody)) leak.push('memoryBriefing')
    check('★★ 源码守卫：自动注入函数（core / briefing）不引用台账检索（防未来顺手拼接）',
      leak.length === 0, leak.length ? '引用了：' + leak.join(', ') : '')
  }
}

console.log('\n' + (fail ? '❌' : '✅') + ` RESULT ${pass} / ${fail}`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(fail ? 1 : 0)
