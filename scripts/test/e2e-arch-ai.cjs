/**
 * 自绘架构图 · 生成内核端到端（0.6.0 · 2026-11-02）
 *
 * 真跑编译产物 `dist/main/services/archAi.js`，但**不真调模型**（注入 callLlm）。
 * 判据不是"能出图"，而是三件事：
 *  ① 指不回证据的节点一个都不许进图；
 *  ② 审计不过要能按意见重画，重试用完仍不过 → 降级；
 *  ③ 降级必须自报家门（source=scan + 文案写明"这是扫描图，不是生成图"），且没配模型时**零调用**。
 *
 * 运行：node scripts/test/e2e-arch-ai.cjs
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const Module = require('module')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}
const ROOT = path.join(os.tmpdir(), 'fc-arch-ai-' + Date.now())
process.env.FC_TEST_USERDATA = path.join(ROOT, 'userdata')
fs.mkdirSync(process.env.FC_TEST_USERDATA, { recursive: true })

const REPO = path.resolve(__dirname, '../..')
const DIST = path.join(REPO, 'desktop', 'dist')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')) }
}

const { generateArchGraph, parseArchDraft } = require(path.join(DIST, 'main', 'services', 'archAi.js'))

const FACTS = {
  project: { id: 'demo', name: '演示项目', repo: 'E:/demo' },
  packageJson: { name: 'demo', version: '1.0.0', deps: ['electron', 'vue'], scripts: {} },
  dirs: [
    { path: 'src/renderer', files: 12, samples: ['src/renderer/App.vue'], exts: ['.vue'] },
    { path: 'src/main', files: 9, samples: ['src/main/index.ts'], exts: ['.ts'] },
    { path: 'src/shared', files: 4, samples: ['src/shared/util.ts'], exts: ['.ts'] },
  ],
  entries: ['src/main/index.ts'],
  imports: [
    { from: 'src/renderer', to: 'src/shared', count: 6, samples: ['x'] },
    { from: 'src/main', to: 'src/shared', count: 3, samples: ['y'] },
  ],
  ipc: { handles: 7, handleSamples: ['a'], invokes: 7, invokeSamples: ['b'], bridgeUses: 5, bridgeSamples: ['c'] },
  ports: [{ port: 8753, source: 'templates' }],
  scannedFiles: 25,
  truncated: false,
}

const GOOD_DRAFT = {
  nodes: [
    { id: 'dir:src/renderer', label: '界面', evidence: ['dir:src/renderer'] },
    { id: 'dir:src/main', label: '主进程', evidence: ['dir:src/main', 'ipc:handle:7'] },
    { id: 'dir:src/shared', label: '共享', evidence: ['dir:src/shared'] },
    { id: 'entry:src/main/index.ts', label: '入口', evidence: ['entry:src/main/index.ts'] },
  ],
  edges: [
    { from: 'dir:src/renderer', to: 'dir:src/shared', evidence: ['import:src/renderer->src/shared'] },
    { from: 'dir:src/main', to: 'dir:src/shared', evidence: ['import:src/main->src/shared'] },
  ],
}
const FAKE_DRAFT = {
  nodes: [
    { id: 'dir:src/renderer', label: '界面', evidence: ['dir:src/renderer'] },
    { id: 'dir:src/支付网关', label: '支付网关', evidence: ['dir:src/支付网关'] },
  ],
  edges: [],
}

;(async () => {
  console.log('== ① 没配模型：零调用直接降级，并自报"扫描图" ==')
  let calls = 0
  const noCfg = await generateArchGraph(FACTS, {
    // 不注入 callLlm → 走真实配置检查；测试 userData 是空目录 → 未配置
  })
  check('★ 降级为扫描图', noCfg.source === 'scan' && noCfg.ok === true, JSON.stringify({ s: noCfg.source, ok: noCfg.ok }))
  check('★★ 原因写明没配模型', /没配模型/.test(String(noCfg.reason)), String(noCfg.reason))
  check('★★ 图上有节点（扫描图照样能看）', noCfg.graph.nodes.length > 0, String(noCfg.graph.nodes.length))
  check('★★ 文案自报"扫描图，不是生成图"', /扫描图/.test(noCfg.graph.text) && /不是生成图/.test(noCfg.graph.text), noCfg.graph.text)
  check('★ 没配模型时一次调用都没发', calls === 0)

  console.log('\n== ② 注入 callLlm 返回合法草稿 → AI 图 ==')
  const okRes = await generateArchGraph(FACTS, {
    now: '2026-11-02T00:00:00.000Z',
    callLlm: async () => { calls++; return { text: JSON.stringify(GOOD_DRAFT), usage: { totalTokens: 321 }, model: 'fake' } },
  })
  check('★★ 来源=ai、一次过', okRes.source === 'ai' && okRes.attempts === 1,
    JSON.stringify({ s: okRes.source, a: okRes.attempts, r: okRes.reason }))
  check('★★ 图上的节点来自草稿且数字来自事实',
    okRes.graph.nodes.length === 4 && okRes.graph.nodes.find((n) => n.id === 'src/main').files === 9,
    JSON.stringify(okRes.graph.nodes.map((n) => n.id + ':' + n.files)))
  check('★ 图表头自报"AI 生成图"', /AI 生成图/.test(okRes.graph.text), okRes.graph.text)
  check('★ 连线条数来自事实（6 / 3）',
    okRes.graph.edges.map((e) => e.count).sort((a, b) => a - b).join(',') === '3,6',
    JSON.stringify(okRes.graph.edges.map((e) => e.count)))
  check('★ usage 透传上来', okRes.usage && okRes.usage.totalTokens === 321)

  console.log('\n== ③ 第一次编造 → 按审计意见重画 → 第二次过 ==')
  let n = 0
  const retry = await generateArchGraph(FACTS, {
    callLlm: async () => { n++; return { text: JSON.stringify(n === 1 ? FAKE_DRAFT : GOOD_DRAFT) } },
  })
  check('★★ 第二次通过 → source=ai 且 attempts=2', retry.source === 'ai' && retry.attempts === 2,
    JSON.stringify({ s: retry.source, a: retry.attempts }))
  check('★ 真调了两次', n === 2, String(n))
  check('★★ 编的节点最终没进图', retry.graph.nodes.every((x) => x.id !== 'src/支付网关'),
    JSON.stringify(retry.graph.nodes.map((x) => x.id)))

  console.log('\n== ④ 两次都编造 → 降级，且把审计原因说清楚 ==')
  const bad = await generateArchGraph(FACTS, {
    callLlm: async () => ({ text: JSON.stringify(FAKE_DRAFT) }),
  })
  check('★★ 降级为扫描图', bad.source === 'scan', bad.source)
  check('★★ 降级原因点名"审计"而不是含糊失败', /审计/.test(String(bad.reason)), String(bad.reason))
  check('★★ 保留审计明细（哪几条不过）', !!bad.audit && bad.audit.issues.length > 0,
    bad.audit ? String(bad.audit.issues.length) : 'no audit')
  check('★★ 降级图里没有编造节点', bad.graph.nodes.every((x) => x.id !== 'src/支付网关'))

  console.log('\n== ⑤ 模型吐的不是 JSON → 重试 → 仍不行就降级 ==')
  const junk = await generateArchGraph(FACTS, { callLlm: async () => ({ text: '我觉得这个项目挺清晰的' }) })
  check('★ 非 JSON → 降级（不崩）', junk.source === 'scan')
  const fenced = await generateArchGraph(FACTS, {
    callLlm: async () => ({ text: '好的，图如下：\n```json\n' + JSON.stringify(GOOD_DRAFT) + '\n```\n以上。' }),
  })
  check('★★ 带 ```json 围栏 + 前后解释文字也能解析（模型常见输出）', fenced.source === 'ai', fenced.source + ' / ' + String(fenced.reason))

  console.log('\n== ⑥ 调用抛错 → 降级，且留痕 ==')
  const traces = []
  const boom = await generateArchGraph(FACTS, {
    appendTrace: (r) => traces.push(r),
    callLlm: async () => { throw new Error('401 未授权') },
  })
  check('★ 抛错 → 降级（不是整个功能挂掉）', boom.source === 'scan')
  check('★★ 原因带原始错误（能查）', /401/.test(String(boom.reason)), String(boom.reason))
  check('★★ 失败也留痕（花销/失败可见）', traces.length === 1 && traces[0].ok === false && /401/.test(traces[0].error),
    JSON.stringify(traces.map((t) => t.ok)))

  console.log('\n== ⑦ 审计通过时留痕带 token（花销可见）==')
  const okTraces = []
  await generateArchGraph(FACTS, {
    appendTrace: (r) => okTraces.push(r),
    callLlm: async () => ({ text: JSON.stringify(GOOD_DRAFT), usage: { totalTokens: 99 } }),
  })
  check('★ 留痕一条且 ok=true', okTraces.length === 1 && okTraces[0].ok === true, JSON.stringify(okTraces.map((t) => t.ok)))
  check('★ 留痕带 total_tokens', okTraces[0].total_tokens === 99, String(okTraces[0].total_tokens))

  console.log('\n== ⑧ 解析器的边界 ==')
  check('空串 → 报错不抛', parseArchDraft('').draft === null && !!parseArchDraft('').error)
  check('没有 JSON → 报错', parseArchDraft('纯文字').draft === null)
  check('合法 JSON → 出对象', !!parseArchDraft('{"nodes":[]}').draft)

  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) { console.log('\n失败项：'); for (const f of failures) console.log('  · ' + f) }
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('EXCEPTION', e); process.exit(2) })
