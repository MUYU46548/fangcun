/**
 * 记忆召回 · 纯函数（2026-11-20 v2）
 *
 * 跑的是编译产物 `desktop/dist/shared/memoryRank.js`，不碰 fs / electron。
 * 判据不是"函数能跑"，而是：
 *   ① 搜 `kill` 第一条必须是 D5（不是 D1，也不是靠时间碰巧）；
 *   ② 可信度/重要度/新鲜度/预算真的参与排序与裁剪；
 *   ③ 去重不会把「规模测试 0 / 1」判成同一条，也不会漏掉真正的近似重复；
 *   ④ 超预算必须报 truncated / dropped，至少留 1 条，不许静默少给。
 */
const path = require('path')
const fs = require('fs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'shared', 'memoryRank.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}

console.log('== 记忆召回 · 纯函数 ==')
check('★★ 编译产物在（先跑 tsc -p tsconfig.main.json）', fs.existsSync(DIST), DIST)
if (!fs.existsSync(DIST)) {
  console.log(`\nRESULT ${pass} / ${fail}`); process.exit(1)
}
const R = require(DIST)
const NOW = Date.parse('2026-11-20T00:00:00+08:00')

// ── ① 分词 / 去重 ──────────────────────────────────────────────────
check('★ tokenize("kill") 含 kill', R.tokenize('kill').includes('kill'))
const tk = R.tokenize('停进程')
check('★ tokenize("停进程") 含二字组与整段',
  tk.includes('停进') && tk.includes('进程') && tk.includes('停进程'), JSON.stringify(tk))
check('★★ 去重：规模测试 0 与 1 不是同一条（单数字不许丢）',
  R.similarity('规模测试 0', '规模测试 1') < R.MEMORY_BUDGETS.dedupe,
  String(R.similarity('规模测试 0', '规模测试 1')))
check('★ 去重：标点差异不影响同一句（≈1）',
  R.similarity('禁止 agent 自行 kill 宿主：先报 PID。', '禁止 agent 自行 kill 宿主 先报 PID') >= 0.99)
check('★ 去重：空 claim 相似度 0（不把空对空判成重复）',
  R.similarity('', '') === 0 && R.similarity('abc', '') === 0)
const dupItems = [
  { id: 'a', claim: '禁止 agent 自行 kill 宿主：先盘点轮次、报 PID 与理由、等用户点头。', file: 'memory/a.md' },
  { id: 'b', claim: '用户问「可不可以」不是让你开工；没有命令式动词就不产生写操作。', file: 'memory/b.md' },
]
const dup = R.findDuplicate('禁止 agent 自行 kill 宿主：先盘点轮次、报 PID 与理由、等用户点头', dupItems)
check('★★ 写前查重能抓到近似重复（标点差异）', dup && dup.item.id === 'a', JSON.stringify(dup))
check('★ 不同 claim 不会被判重复', R.findDuplicate('完全不相关的一句话', dupItems) === null)
check('★ 空 claim 不触发重复', R.findDuplicate('', dupItems) === null)

// ── ② 参数换算 ─────────────────────────────────────────────────────
check('★★ 半衰期 0 = 新鲜度 1（纪律/决定不衰减）',
  R.freshnessOf('2020-01-01T00:00:00+08:00', 0, NOW) === 1)
check('★★ 半衰期 365 天：一年前 ≈ 0.5',
  Math.abs(R.freshnessOf('2025-11-20T00:00:00+08:00', 365, NOW) - 0.5) < 0.01,
  String(R.freshnessOf('2025-11-20T00:00:00+08:00', 365, NOW)))
check('★ 时间认不出 → 0.7（不当 0 / 不当 1970）',
  R.freshnessOf('不是时间', 365, NOW) === 0.7)
check('★ 重要度 1→0.40、5→1.00',
  Math.abs(R.importanceFactor(1) - 0.4) < 1e-9 && Math.abs(R.importanceFactor(5) - 1) < 1e-9)
check('★ 可信度夹到 0–1', R.confidenceOf(2) === 1 && R.confidenceOf(-1) === 0)
check('★ 召回权重夹到 0.5–2', R.weightOf(9) === 2 && R.weightOf(0) === 0.5)
check('★ 预算常量是 v2 口径',
  R.MEMORY_BUDGETS.core === 800 && R.MEMORY_BUDGETS.briefing === 800
  && R.MEMORY_BUDGETS.search === 1500 && R.MEMORY_BUDGETS.claimHard === 200,
  JSON.stringify(R.MEMORY_BUDGETS))

// ── ③ 排序 ────────────────────────────────────────────────────────
const items = [
  {
    id: 'D5', claim: '禁止 agent 自行 kill 宿主：先盘点轮次、报 PID 与理由、等用户点头。',
    project: '跨项目', confidence: 0.95, importance: 5, halfLife: 0,
    time: '2026-11-17T00:00:00+08:00', pinned: true, tags: ['杀进程'], code: 'D5',
  },
  {
    id: 'D1', claim: '用户问「可不可以」不是让你开工；没有命令式动词就不产生写操作。',
    project: '跨项目', confidence: 0.95, importance: 5, halfLife: 0,
    time: '2026-11-17T00:00:00+08:00', pinned: true, tags: ['授权'], code: 'D1',
  },
  {
    id: 'LOW', claim: 'kill 的旧教训，可信度低',
    project: '跨项目', confidence: 0.5, importance: 2, halfLife: 365,
    time: '2024-01-01T00:00:00+08:00',
  },
  {
    id: 'EV', claim: '某事故（claim 不含关键词）',
    project: '跨项目', confidence: 0.9, importance: 4, halfLife: 365,
    time: '2026-11-01T00:00:00+08:00', evidence: '这次 kill 了宿主',
  },
  {
    id: 'PROJ', claim: 'fangcun-base 项目里的记忆',
    project: 'fangcun-base', confidence: 0.8, importance: 3, halfLife: 365,
    time: '2026-11-19T00:00:00+08:00',
  },
]
const before = JSON.stringify(items)
const rk = R.rankMemories(items, { q: 'kill', now: NOW })
check('★★ 搜 kill：第一条是 D5', rk.rows[0] && rk.rows[0].item.id === 'D5',
  JSON.stringify(rk.rows.map((x) => x.item.id)))
check('★ 搜 kill：D5 分数 0.95（相关度 1 × 可信 0.95 × 重要 1 × 不衰减）',
  Math.abs(rk.rows[0].score - 0.95) < 0.01, String(rk.rows[0].score))
check('★ 搜 kill：只在证据里命中的 EV 排在 D5 之后，且相关度 ≤0.3',
  rk.rows.some((x) => x.item.id === 'EV') && rk.rows.find((x) => x.item.id === 'EV').relevance <= 0.3,
  JSON.stringify(rk.rows.map((x) => [x.item.id, x.relevance])))
check('★★ 搜 kill：不含关键词的 D1 不进结果（pinned 也不绕过相关度）',
  !rk.rows.some((x) => x.item.id === 'D1'))
check('★ 搜 kill：低可信 + 两年前的 LOW 被 0.15 门槛挡掉',
  !rk.rows.some((x) => x.item.id === 'LOW'), JSON.stringify(rk.rows.map((x) => x.item.id)))
check('★ total 是裁剪前的命中数，不是返回数', rk.total >= 2 && rk.returned === rk.rows.length)
check('★ chars = 返回条目的 claim 长度之和',
  rk.chars === rk.rows.reduce((n, x) => n + String(x.item.claim).length, 0), String(rk.chars))
check('★ 排序不改传入数组（纯函数）', JSON.stringify(items) === before)

const strict = R.rankMemories(items, { q: 'kill', minScore: 0.99, now: NOW })
check('★★ 门槛生效：0.99 门槛下 kill 全被挡掉', strict.total === 0 && strict.rows.length === 0)
const limited = R.rankMemories(items, { q: 'kill', limit: 1, now: NOW })
check('★ limit 生效且 truncated 说出来（total 仍是裁剪前）',
  limited.returned === 1 && limited.total >= 2 && limited.truncated === true,
  JSON.stringify({ returned: limited.returned, total: limited.total }))
const tiny = R.rankMemories(items, { q: 'kill', maxChars: 100, now: NOW })
check('★ 预算极小也至少留 1 条（不能返回空）', tiny.rows.length === 1, String(tiny.rows.length))

const proj = R.rankMemories(items, { project: 'fangcun-base', projectFirst: true, now: NOW })
check('★★ 无查询（简报）：本项目条目排第一',
  proj.rows[0] && proj.rows[0].item.id === 'PROJ',
  JSON.stringify(proj.rows.slice(0, 3).map((x) => [x.item.id, x.score])))
check('★ 无查询：跨项目也进简报（total 含全部）', proj.total === items.length)

const confA = [{ id: 'hi', claim: 'alpha rule', confidence: 0.95, importance: 3, halfLife: 0, time: '2026-11-01T00:00:00+08:00' },
  { id: 'lo', claim: 'alpha rule', confidence: 0.5, importance: 3, halfLife: 0, time: '2026-11-01T00:00:00+08:00' }]
const confRank = R.rankMemories(confA, { q: 'alpha', now: NOW })
check('★★ 同相关度下，可信度高的排前面', confRank.rows[0].item.id === 'hi',
  JSON.stringify(confRank.rows.map((x) => [x.item.id, x.score])))

const impA = [{ id: 'imp5', claim: 'beta rule', confidence: 0.8, importance: 5, halfLife: 0, time: '2026-11-01T00:00:00+08:00' },
  { id: 'imp2', claim: 'beta rule', confidence: 0.8, importance: 2, halfLife: 0, time: '2026-11-19T00:00:00+08:00' }]
const impRank = R.rankMemories(impA, { q: 'beta', now: NOW })
check('★★ 同相关度/可信度下，重要度高的排前面（时间新也压不过）',
  impRank.rows[0].item.id === 'imp5',
  JSON.stringify(impRank.rows.map((x) => [x.item.id, x.score])))

const tieA = [{ id: 'old', claim: 'tie rule old', confidence: 0.8, importance: 3, halfLife: 0, time: '2026-11-01T00:00:00+08:00' },
  { id: 'new', claim: 'tie rule new', confidence: 0.8, importance: 3, halfLife: 0, time: '2026-11-19T00:00:00+08:00' }]
const tieRank = R.rankMemories(tieA, { q: 'tie', now: NOW })
check('★ 完全同分时时间新的排前面', tieRank.rows[0].item.id === 'new',
  JSON.stringify(tieRank.rows.map((x) => [x.item.id, x.score])))

const phrase = R.rankMemories(items, { q: '禁止 agent 自行 kill 宿主', now: NOW })
check('★★ 整句命中 claim → relevance 保底 0.95',
  phrase.rows[0] && phrase.rows[0].item.id === 'D5' && phrase.rows[0].relevance >= 0.95,
  JSON.stringify(phrase.rows[0] && [phrase.rows[0].item.id, phrase.rows[0].relevance]))

// ── ④ core 生成 ───────────────────────────────────────────────────
const coreAll = R.renderCore(items, { budget: 10000 })
check('★ renderCore 预算充足：钉住/非钉住都按重要度排（含 [D5]）',
  coreAll.text.includes('[D5]') && coreAll.text.includes('D1') && !coreAll.truncated,
  coreAll.text.slice(0, 120))
const coreTiny = R.renderCore(items, { budget: 100 })
check('★★ renderCore 超预算：至少留 1 条，dropped/truncated 说出来',
  coreTiny.text.length > 0 && coreTiny.truncated === true && coreTiny.dropped > 0,
  JSON.stringify({ chars: coreTiny.chars, dropped: coreTiny.dropped }))
const corePrefix = R.renderCore(items.slice(0, 1), { budget: 200, prefix: '人工补充'.repeat(20) })
check('★ renderCore 的人工补充块也算预算（前缀太长就丢条目）',
  corePrefix.chars <= 200 && corePrefix.text.startsWith('人工补充'),
  JSON.stringify({ chars: corePrefix.chars, dropped: corePrefix.dropped }))

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
