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
// ⚠ 2026-11-24 改（C1=A：抄 Generative Agents 的归一化加权和）：
// 原断言是「低可信 + 两年前的 LOW 被 0.15 门槛挡掉」——那**正是旧乘法模型的行为**，
// 也正是 C1 要废掉的那条语义：时间一票否决 → 老记忆静默消失。
// 现在 LOW 仍然**留在结果里**（三条都在），但**排在最后**。
// 判据从「被淘汰」改成「还在、且排最后」——这才是「时间只影响排位，不影响存亡」。
check('★★ 搜 kill：低可信 + 两年前的 LOW **不再被时间淘汰**（C1 的核心改动）',
  rk.rows.some((x) => x.item.id === 'LOW'), JSON.stringify(rk.rows.map((x) => x.item.id)))
check('★★ 搜 kill：LOW 虽然留下了，但排在 D5 与 EV 之后（时间只降排位）',
  rk.rows.findIndex((x) => x.item.id === 'LOW') === rk.rows.length - 1,
  JSON.stringify(rk.rows.map((x) => [x.item.id, x.score])))
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

// ── ④ 归一化加权和（2026-11-24 · C1=A 抄 Generative Agents）──────────
// 这一节钉的是**模型的语义**，不是某个具体分数。改模型的人必须让这几条继续绿，
// 否则就是把「时间一票否决 → 老记忆静默消失」偷偷改回去了。
const DAY = 86400000
const ago = (d) => new Date(NOW - d * DAY).toISOString()

check('★ minMax 整组相同 → 全给 1（不是 0）',
  R.minMax(5, 5, 5) === 1 && R.minMax(0, 0, 0) === 1,
  `${R.minMax(5, 5, 5)} / ${R.minMax(0, 0, 0)}`)
check('★ minMax 正常区间 → 端点 0 与 1',
  R.minMax(3, 1, 5) === 0.5 && R.minMax(1, 1, 5) === 0 && R.minMax(5, 1, 5) === 1)
check('★ RANK_WEIGHTS 三项都是 1（与论文默认一致）',
  R.RANK_WEIGHTS.relevance === 1 && R.RANK_WEIGHTS.importance === 1 && R.RANK_WEIGHTS.recency === 1)

// ★★ C1 的验收线本身：一条重要度 5 的旧事故，**多久之后都还搜得到**
for (const days of [365, 730, 1095]) {
  const old = [{
    id: 'OLD5', claim: 'BOM 会写进数据文件，害得解析器读不到',
    confidence: 0.9, importance: 5, halfLife: 365, time: ago(days), tags: ['BOM'],
  }, {
    id: 'NEW2', claim: '今天记的一件小事', confidence: 0.7, importance: 2,
    halfLife: 365, time: ago(0), tags: ['杂'],
  }]
  const r5 = R.rankMemories(old, { q: 'BOM', now: NOW, minScore: 0.15, limit: 10 })
  check(`★★ C1 验收线：重要度 5 的事故，${days} 天后仍搜得到（不被时间淘汰）`,
    r5.rows.some((x) => x.item.id === 'OLD5'),
    JSON.stringify(r5.rows.map((x) => [x.item.id, x.score])))
}

// ★★ 时间只降排位，不淘汰：三条都命中，最老的排最后但仍然在
const threeAges = [
  { id: 'T0', claim: 'BOM 今天刚遇到', confidence: 0.9, importance: 5, halfLife: 365, time: ago(0), tags: ['BOM'] },
  { id: 'T180', claim: 'BOM 半年前遇到', confidence: 0.9, importance: 5, halfLife: 365, time: ago(180), tags: ['BOM'] },
  { id: 'T1095', claim: 'BOM 三年前遇到', confidence: 0.9, importance: 5, halfLife: 365, time: ago(1095), tags: ['BOM'] },
]
const rAges = R.rankMemories(threeAges, { q: 'BOM', now: NOW, minScore: 0.15, limit: 10 })
check('★★ 三条同相关度、只差时间 → 全部留下（时间不淘汰）',
  rAges.rows.length === 3, JSON.stringify(rAges.rows.map((x) => x.item.id)))
check('★★ 且严格按新→旧排（时间仍影响排位）',
  rAges.rows.map((x) => x.item.id).join('>') === 'T0>T180>T1095',
  rAges.rows.map((x) => `${x.item.id}@${x.score}`).join(' '))

// ★★ 反例：把新鲜度做回**乘数**，上面那种"三年后仍搜得到"就会塌
// 这里不改源码，只用同一个函数算一遍乘法，证明两者语义确实不同 ——
// 免得以后有人以为"只是换个写法"。
{
  const oldItem = threeAges[2]
  const rel = 1, conf = R.confidenceOf(oldItem.confidence)
  const imp = R.importanceFactor(oldItem.importance)
  const fre = R.freshnessOf(oldItem.time, oldItem.halfLife, NOW)
  const multScore = rel * conf * imp * fre
  check('★★ 反例自证：同一条用**乘法**算必然跌破 0.15（证明这不是"换个写法"）',
    multScore < 0.15, `mult=${multScore.toFixed(3)} < 0.15；加法模型下它仍被返回`)
}

// ★★ 门槛必须打在**绝对匹配质量**上，不能打在归一化后的分数上
// （2026-11-24 当场抓到的真缺陷：min-max 让分数永远落在高位，0.15 门槛形同虚设）
//
// ⚠ 构造要点：JUNK 必须**有非零相关度**才会走到归一化那一步。
//   第一版拿"毫不相干"的词做 JUNK，relevance 直接是 0，被更早的 `relevance <= 0` 滤掉，
//   于是注入 `gate -> mixed` 这个 bug 时它**照样绿** —— 假绿。这里是修正后的版本：
//   JUNK 用弱命中（只在证据里出现一次），
//   · 正确实现：gate = rel × conf = 0.3 × 0.9 = 0.27 > 0.15 → 其实也会进……
//   所以门槛改成 0.5，让"弱命中"必须被挡，而"真命中"（rel=1）能过。
{
  const junk = [
    { id: 'STRONG', claim: 'zzneedle 这条真的含探针', evidence: '', confidence: 0.9, importance: 5, halfLife: 0, time: ago(0), tags: [] },
    { id: 'JUNK', claim: '一条别的话', evidence: 'zzneedle 只在证据里出现一次', confidence: 0.9, importance: 5, halfLife: 0, time: ago(0), tags: [] },
  ]
  const rj = R.rankMemories(junk, { q: 'zzneedle', now: NOW, minScore: 0.5, limit: 10 })
  check('★★ 门槛打在绝对质量上：弱命中(只在证据)不许被归一化抬过 0.5 门槛',
    rj.rows.length === 1 && rj.rows[0].item.id === 'STRONG',
    JSON.stringify(rj.rows.map((x) => [x.item.id, x.score, x.gate])))
  check('★ 每条带 gate（= relevance × confidence），界面/测试能看清为什么被挡',
    typeof rj.rows[0].gate === 'number' && rj.rows[0].gate > 0, String(rj.rows[0].gate))
}

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
