#!/usr/bin/env node
/**
 * 架构图生成 · 失败分型 / 进度 / 取消（2026-11-07）
 *
 * 直接对应 11-03 那条驳回：
 *   「生成失败，降级为扫描图。且生成过程可能耗时很长（没其他提示，挂着窗口干等），
 *     用户等不及会点关闭，是否有影响？」
 *
 * 三条判据（都在这套里）：
 *   ① 失败要说清**坏在哪一步**（not_json / truncated / …），不是笼统一句"生成失败"；
 *   ② 长耗时要**有进度**（第几次 / 在干嘛），不是转个圈；
 *   ③ 取消要**真取消**：不再发下一次调用，也不产出任何图。
 *
 * 运行：node scripts/test/e2e-arch-progress.cjs
 */
const path = require('path')
const { mkTmp } = require('./_tmp.cjs')
const Module = require('module')

const REPO = path.resolve(__dirname, '../..')
const DIST = path.join(REPO, 'desktop', 'dist')
const STUB = path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
process.env.FC_TEST_USERDATA = mkTmp('fc-arch-prog-')

const orig = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB
  return orig.call(this, request, ...rest)
}

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

const { generateArchGraph, parseArchDraft } = require(path.join(DIST, 'main', 'services', 'archAi.js'))

const FACTS = {
  project: { id: 'demo', name: '演示项目' },
  dirs: [{ path: 'src/main', files: 12, exts: ['.ts'] }, { path: 'src/shared', files: 6, exts: ['.ts'] }],
  imports: [{ from: 'src/main', to: 'src/shared', count: 9 }],
  entries: ['src/main/index.ts'],
  packageJson: { deps: ['electron'], name: 'demo' },
  ipc: { handles: 12, invokes: 8, bridgeUses: 3 },
  ports: [],
  scannedFiles: 18,
  truncated: false,
}

console.log('== ① 解析失败要分型，不许只有一句"失败" ==')
{
  const prose = parseArchDraft('我先解释一下这个项目的结构：它分为主进程与渲染进程……')
  check('★★ 满篇散文 → kind=not_json（不是"解析失败"四个字）',
    prose.draft === null && prose.kind === 'not_json', JSON.stringify({ kind: prose.kind, error: prose.error }))

  const cut = parseArchDraft('{"title":"演示","nodes":[{"id":"dir:src/main",')
  check('★★ 中途断掉 → kind=truncated', cut.draft === null && cut.kind === 'truncated', JSON.stringify({ kind: cut.kind }))

  const empty = parseArchDraft('')
  check('★ 一个字都没有 → kind=no_content', empty.kind === 'no_content', JSON.stringify({ kind: empty.kind }))

  const ok = parseArchDraft('{"title":"t","nodes":[],"edges":[]}')
  check('★ 合法 JSON → 无 kind', ok.draft !== null && !ok.kind, JSON.stringify({ kind: ok.kind }))
}

async function main() {
console.log('\n== ② 进度：每一步都要说出来 ==')
{
  const events = []
  let n = 0
  const callLlm = async () => {
    n++
    // 第一次给散文（必挂），第二次给空（必挂）→ 走完两次尝试后降级
    return { text: n === 1 ? '我不太确定，先说说我的理解……' : '', model: 'fake' }
  }
  const r = await generateArchGraph(FACTS, {
    callLlm,
    maxAttempts: 2,
    onProgress: (p) => events.push(p),
  })
  check('★ 生成过程中真的推了进度事件（不是干等）', events.length >= 3, JSON.stringify(events.map((e) => e.phase)))
  check('★★ 进度里带得出"第几次/共几次"（人能判断还要等多久）',
    events.some((e) => e.attempt === 1 && e.maxAttempts === 2),
    JSON.stringify(events[0]))
  check('★ 解析失败后有一句"按类型重试"，不是闷头再发一次',
    events.some((e) => e.phase === 'retry'), JSON.stringify(events.map((e) => e.phase)))
  check('★ 降级时也推一条 done（界面能收尾，不留"生成中"）', events[events.length - 1].phase === 'done',
    JSON.stringify(events[events.length - 1]))
  check('★★ 两次都没成 → source=scan 且 failKind 说得清（这次是 no_content）',
    r.source === 'scan' && r.failKind === 'no_content',
    JSON.stringify({ source: r.source, failKind: r.failKind, reason: r.reason }))
}

console.log('\n== ③ 取消：真取消，不产图 ==')
{
  const events = []
  let called = 0
  const r = await generateArchGraph(FACTS, {
    maxAttempts: 3,
    callLlm: async () => { called++; return { text: '{"title":"t","nodes":[],"edges":[]}' } },
    shouldAbort: () => true,     // 一开始就取消
    onProgress: (p) => events.push(p),
  })
  check('★★ 取消后一次模型都没调（不是"点了取消还偷偷发请求"）', called === 0, `called=${called}`)
  check('★★ 结果标明 cancelled，且 source=scan（不许当成功）',
    r.cancelled === true && r.source === 'scan' && r.failKind === 'cancelled',
    JSON.stringify({ cancelled: r.cancelled, source: r.source, failKind: r.failKind }))
  check('★ 取消也推了事件（界面能立刻回到可点状态）',
    events.some((e) => e.phase === 'cancelled'), JSON.stringify(events.map((e) => e.phase)))
  check('★ 取消时 attempts=0（一次都没跑完，不许虚报）', r.attempts === 0, String(r.attempts))
  // 「不写半成品图」的硬证据：取消态的图必须与**纯扫描图**逐节点一致，
  // 一个 AI 节点都不许混进来；同时文案明说已取消，不许让人以为拿到了生成结果。
  const { buildArchGraph } = require(path.join(DIST, 'shared', 'archGraph.js'))
  const pureScan = buildArchGraph(FACTS)
  check('★★ 取消后一个 AI 节点都没混进来（与纯扫描图逐节点一致）',
    Array.isArray(r.graph.nodes) && r.graph.nodes.length === pureScan.nodes.length
    && r.graph.nodes.every((n, i) => n.id === pureScan.nodes[i].id),
    JSON.stringify({ got: (r.graph.nodes || []).length, scan: pureScan.nodes.length }))
  check('★ 图上明说"已取消"和"这是扫描图，不是生成图"',
    /已取消/.test(String(r.graph.text || '')) && /这是扫描图，不是生成图/.test(String(r.graph.text || '')),
    String(r.graph.text || '').slice(0, 120))
  // 生成链**根本不写盘**（图只作为返回值交给界面）—— 所以取消不可能留下半成品文件。
  // 这条静态断言防的是"以后有人往 archAi 里加 fs.writeFile"。
  const archSrc = require('fs').readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'services', 'archAi.ts'), 'utf-8')
  check('★★ 生成链不含任何写盘调用（取消不可能留下半成品文件）',
    !/writeFileSync|writeFile\(|appendFileSync/.test(archSrc))
}

console.log('\n== ④ 反例：截断但能补全 → 不算失败 ==')
{
  const good = '{"title":"演示","nodes":[{"id":"dir:src/main"}],"edges":[]'
  const r2 = parseArchDraft(good)
  check('★ 差一个右括号 → 补全后可用，且标 repaired（不冒充"一次画完"）',
    r2.draft !== null && r2.repaired === true, JSON.stringify({ draft: !!r2.draft, repaired: r2.repaired }))
}

}

main().then(() => {
  console.log('')
  if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  · ' + f) }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
})
