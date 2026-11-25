/**
 * 记忆 v3 · 引擎三件（2026-11-25 · P16.3）
 *
 * 跑的是编译产物（先 `npx tsc -p tsconfig.main.json`）：
 *   `desktop/dist/shared/memoryV3.js`   作用域模型（world / topic / file / session）
 *   `desktop/dist/shared/memoryEdit.js` 编辑防呆（find 唯一才动）
 *   `desktop/dist/shared/memoryMerge.js` 合并有根（只许并、不许新增）
 *
 * 判据（不是"函数能跑"）：
 *   ① 作用域：四类都认，非法值**回 world 而不是报错/丢条**；v2 条目缺字段 = world；
 *   ② 编辑：同一个片段出现两次 → **拒绝**（这是唯一防呆理由）；0 次 = 没动，不是错误；
 *   ③ 合并：同 scope+kind 才聚；合并句必须是原句之一（不新增）；证据逐字拼接；
 *      没根（token 覆盖率过低）→ 丢弃。
 *
 * 反例自证：
 *   · 把 `locateUnique` 的第二次命中检查删掉 → "多次必须拒"精确变红；
 *   · 让 `mergeCluster` 拼一句新文案 → "合并句必须来自原句"精确变红；
 *   · 把 `scopeOfEntry` 的坏值回退去掉 → "非法值回 world"精确变红。
 *
 * 运行：node scripts/test/e2e-memory-v3.cjs
 */
const path = require('path')
const fs = require('fs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'shared')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}

console.log('== 记忆 v3 引擎三件 ==')

const v3Path = path.join(DIST, 'memoryV3.js')
const editPath = path.join(DIST, 'memoryEdit.js')
const mergePath = path.join(DIST, 'memoryMerge.js')
check('★★ 编译产物在（先跑 npx tsc -p tsconfig.main.json）',
  fs.existsSync(v3Path) && fs.existsSync(editPath) && fs.existsSync(mergePath), DIST)
if (!fs.existsSync(v3Path) || !fs.existsSync(editPath) || !fs.existsSync(mergePath)) {
  console.log(`\nRESULT ${pass} / ${fail}`)
  process.exit(1)
}

const V3 = require(v3Path)
const E = require(editPath)
const M = require(mergePath)

// ── ① 作用域 ──────────────────────────────────────────────────────
console.log('\n-- ① 作用域 --')
check('★ world 解析', JSON.stringify(V3.parseScope('world')) === JSON.stringify({ kind: 'world', value: '' }))
check('★ 空串 = world', V3.parseScope('').kind === 'world')
check('★ topic:方寸', V3.parseScope('topic:方寸').kind === 'topic' && V3.parseScope('topic:方寸').value === '方寸')
const f = V3.parseScope(String.raw`file:E:\CODE\CangKu\x.ts`)
check('★★ file 路径统一成 /', f && f.kind === 'file' && f.value === 'E:/CODE/CangKu/x.ts', JSON.stringify(f))
check('★★ file 拒绝 .. 逃逸', V3.parseScope('file:../etc/passwd') === null)
check('★ topic: 空值非法', V3.parseScope('topic:') === null)
check('★ 未知类型非法', V3.parseScope('bogus:x') === null)
check('★ v2 条目无字段 = world', V3.scopeOfEntry({}).kind === 'world')
check('★★ 非法作用域回 world（不许因此丢条）', V3.scopeOfEntry({ 作用域: 'nope' }).kind === 'world')
check('★ 认英文别名 scope', V3.scopeOfEntry({ scope: 'topic:a' }).value === 'a')
check('★ formatScope 往返', V3.formatScope({ kind: 'topic', value: 'a' }) === 'topic:a'
  && V3.formatScope({ kind: 'world', value: '' }) === 'world')
check('★ 格式版本：缺省 = 2', V3.formatVersion({}) === 2)
check('★ 格式版本：3 = 3', V3.formatVersion({ 格式: '3' }) === 3)
check('★ isV3Entry', V3.isV3Entry({ 格式: '3' }) && !V3.isV3Entry({ 格式: '2' }))
check('★★ world 恒匹配', V3.scopeMatches({ kind: 'world', value: '' }, []))
check('★★ 同作用域才匹配', V3.scopeMatches({ kind: 'topic', value: 'a' }, [{ kind: 'topic', value: 'a' }]))
check('★★ 不同作用域不匹配（不串味）', !V3.scopeMatches({ kind: 'topic', value: 'a' }, [{ kind: 'topic', value: 'b' }]))
check('★ activeScopes 过滤 world/非法', V3.activeScopes(['world', 'topic:a', 'nope', '']).length === 1)
const scopeEntries = [
  { id: 'a', scopeV3: 'world' },
  { id: 'b', scopeV3: 'topic:fangcun-base' },
  { id: 'c', scopeV3: 'file:E:/CODE/x.ts' },
]
check('★ 空活跃集 = 不过滤（不是只留 world）', V3.filterByScopes(scopeEntries, []).length === 3)
check('★★ world 恒中 + 同作用域命中',
  V3.filterByScopes(scopeEntries, V3.activeScopes(['topic:fangcun-base'])).map((e) => e.id).join(',') === 'a,b')
check('★★ 不同作用域不出现（不串味）',
  V3.filterByScopes(scopeEntries, V3.activeScopes(['file:E:/CODE/y.ts'])).every((e) => e.id !== 'c'))
check('★ 返回副本，不原地改调用方数组',
  (() => { const src = [...scopeEntries]; return V3.filterByScopes(src, []) !== src })())

// ── ② 编辑防呆 ────────────────────────────────────────────────────
console.log('\n-- ② 编辑防呆 --')
const src = '第一段。目标句在这里。第三段。'
check('★ 唯一命中', E.locateUnique(src, '目标句').status === 'ok')
check('★ 没找到 = missing', E.locateUnique(src, '不存在的句子').status === 'missing')
check('★★ 出现两次 = multiple（拒绝的根据）', E.locateUnique('a目标b目标c', '目标').status === 'multiple')
check('★ 空 needle = missing（不猜）', E.locateUnique(src, '').status === 'missing')
const ok = E.replaceUnique(src, '目标句', '改写句')
check('★ 唯一命中才替换', ok.ok && ok.changed && ok.text === '第一段。改写句在这里。第三段。', ok.text)
const bad = E.replaceUnique('aXbXc', 'X', 'Y')
check('★★ 多次命中拒绝，原文一字不动', bad.ok === false && bad.text === 'aXbXc' && !!bad.error)
const noop = E.replaceUnique(src, '不存在', 'Y')
check('★ 0 次 = 没动（不是错误）', noop.ok === true && noop.changed === false && noop.text === src)

// ── ③ 合并有根 ────────────────────────────────────────────────────
console.log('\n-- ③ 合并有根 --')
const A = { id: 'm1', scope: 'world', kind: '纪律', claim: '不要按进程名批量杀浏览器，只按 PID 精确处理' }
const B = { id: 'm2', scope: 'world', kind: '纪律', claim: '绝不按进程名批量杀浏览器 —— 会连带杀掉用户的窗口' }
const C = { id: 'm3', scope: 'world', kind: '纪律', claim: '发布前必须跑全量回归' }
const D = { id: 'm4', scope: 'topic:x', kind: '纪律', claim: '不要按进程名批量杀浏览器，只按 PID 精确处理' }
const F = { id: 'm5', scope: 'world', kind: '教训', claim: '绝不按进程名批量杀浏览器 —— 会连带杀掉用户的窗口' }

check('★ 同句相似度 = 1', M.jaccard(A.claim, A.claim) === 1)
check('★ 不相干相似度低', M.jaccard(C.claim, '天气很好适合散步') < 0.2)
check('★★ 覆盖比（短句是长句子集也算重合）', M.overlapCoefficient(A.claim, B.claim) >= 0.45,
  String(M.overlapCoefficient(A.claim, B.claim)))
const clusters = M.clusterEntries([A, B, C, D, F])
check('★★ 同 scope+kind 且重合高才聚', clusters.length === 1 && clusters[0].ids.sort().join(',') === 'm1,m2',
  JSON.stringify(clusters.map((c) => c.ids)))
const plan = clusters.length === 1 ? M.mergeCluster(clusters[0]) : null
check('★★ 合并句必须来自原句（不新增内容）', !!plan && [A.claim, B.claim].includes(plan.claim), plan && plan.claim)
check('★★ 有根 = true', !!plan && plan.grounded === true && plan.share >= 0.34)
check('★ 证据逐字带上两句', !!plan && plan.evidence.includes(A.claim) && plan.evidence.includes(B.claim))
check('★ 被合并的 id 都列出来', !!plan && plan.ids.sort().join(',') === 'm1,m2')
const all = M.planMerges([A, B, C, D, F])
check('★★ planMerges：只合并该并的，其余 kept', all.merges.length === 1 && all.kept.sort().join(',') === 'm3,m4,m5',
  JSON.stringify(all))
check('★ consumed = 被吃掉的 id', all.consumed.sort().join(',') === 'm1,m2')
check('★★ 没根的直接丢（覆盖率 <34%）', M.groundingShare('完全不相干的新句子', ['甲甲甲', '乙乙乙']) < 0.34)
check('★ 少于两条不合并', M.mergeCluster({ scope: 'world', kind: '纪律', ids: ['x'], claims: ['一句'] }) === null)

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f2 of failures) console.log('  · ' + f2)
  process.exit(1)
}
