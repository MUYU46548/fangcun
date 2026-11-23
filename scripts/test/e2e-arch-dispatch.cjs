#!/usr/bin/env node
/**
 * 架构图生成 · 「全走 DSH」链路（2026-11-22 · 卡 80f271dd）
 *
 * 真跑编译产物，不连 DSH、不写真实派单文件（派单/轮询都注入假实现）。
 * 判据（卡上的六步，缺一步不算通）：
 *   ① 任务书里必须写死「怎么交」——建一张带 nonce 的卡，body 里一个 json 代码块；
 *   ② 派单被拒（总闸没开）→ 明说 no_dsh，**不轮询、不降级成假生成**；
 *   ③ 等不到草稿 → timeout；取消只停等待（不能假装 DSH 会话也停了）；
 *   ④ 回来的草稿逐条过审计；编的目录 → audit_rejected 并**带着原因重派**；
 *   ⑤ 两次都不过 → 扫描图，文案必须写「这是扫描图，不是生成图」；
 *   ⑥ 通过审计的图，节点数字只从扫描事实取（草稿编不出数字）。
 *
 * 运行：node scripts/test/e2e-arch-dispatch.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { mkTmpPath } = require('./_tmp.cjs')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}
const ROOT = mkTmpPath('fc-arch-dispatch-')
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

const promptMod = require(path.join(DIST, 'shared', 'archPrompt.js'))
const dispatchMod = require(path.join(DIST, 'main', 'services', 'archDispatch.js'))
const aiMod = require(path.join(DIST, 'main', 'services', 'archAi.js'))

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
const fenced = (o) => '画好了：\n\n```json\n' + JSON.stringify(o) + '\n```\n'
const nonceOf = (text) => {
  const m = /\[架构图草稿\]\s*(arch-\d{14}-[0-9a-f]{4})/.exec(String(text || ''))
  return m ? m[1] : ''
}

;(async () => {
  console.log('== ① 任务书：怎么交必须写死 ==')
  const prompt = promptMod.buildArchDispatchPrompt({ facts: FACTS, projectId: 'demo', projectName: '演示项目', nonce: 'arch-20261122120000-abcd' })
  check('任务书带项目 id', prompt.includes('demo'))
  check('任务书带 nonce 标题（回收按它认卡）', prompt.includes('[架构图草稿] arch-20261122120000-abcd'))
  check('★ 任务书写死交付方式：fangcun_write 建卡', /fangcun_write/.test(prompt) && /create_task/.test(prompt))
  check('★ body 必须是 ```json 代码块', /```json/.test(prompt))
  check('任务书带证据清单（只许引用这些）', prompt.includes('dir:src/main') && prompt.includes('import:src/renderer->src/shared'))
  check('任务书带 JSON 输出格式示例', /"nodes"/.test(prompt) && /"edges"/.test(prompt))
  const withFeedback = promptMod.buildArchDispatchPrompt({ facts: FACTS, projectId: 'demo', nonce: 'n', feedback: '节点 dir:src/支付网关 编的' })
  check('★ 重派时把上一版被拒原因带进任务书', withFeedback.includes('节点 dir:src/支付网关 编的'))
  check('archDraftTitle 只由 nonce 决定', promptMod.archDraftTitle('abc') === '[架构图草稿] abc')

  console.log('\n== ② 草稿回收：围栏 / 裸 JSON / 按 nonce 认卡 ==')
  check('围栏里抠 JSON', promptMod.extractDraftText('说明\n```json\n{"nodes":[]}\n```\n后记') === '{"nodes":[]}')
  check('裸 JSON 前后有说明也抠得出', promptMod.extractDraftText('这是结果 {"a":1} 完') === '{"a":1}')
  check('认不出就原样返回（交给 parseArchDraft 判失败类型）', promptMod.extractDraftText('没有 JSON') === '没有 JSON')
  const tasks = [
    { fm: { title: '别的卡' }, body: 'x' },
    { fm: { title: '[架构图草稿] arch-1' }, body: '{"nodes":[]}' },
  ]
  check('★ 按 nonce 认卡，不按项目名', promptMod.findDraftBody(tasks, 'arch-1') === '{"nodes":[]}')
  check('没有这个 nonce → 空串（不许拿别的卡凑）', promptMod.findDraftBody(tasks, 'arch-2') === '')

  console.log('\n== ③ 派单 + 等卡（注入假 DSH）==')
  {
    let t = 1000
    const prompts = []
    let polls = 0
    const r = await dispatchMod.dispatchArchToDsh(
      { facts: FACTS, projectId: 'demo', attempt: 1, maxAttempts: 2, feedback: '' },
      {
        now: () => t,
        sleep: async (ms) => { t += ms },
        waitMs: 5000,
        pollMs: 100,
        dispatch: (_pid, p) => { prompts.push(p); return { ok: true, at: 'now' } },
        loadTasks: () => { polls++; return polls >= 3 ? [{ fm: { title: '[架构图草稿] ' + nonceOf(prompts[0]) }, body: fenced(GOOD_DRAFT) }] : [] },
      },
    )
    check('★ 派单 ok + 等到卡 → 返回草稿正文', r.ok === true && /"nodes"/.test(r.text || ''), JSON.stringify(r))
    check('派单只发一次（等卡期间不重复派）', prompts.length === 1, String(prompts.length))
    check('派单任务书里带 nonce', !!nonceOf(prompts[0]))
    check('等卡不是死等：轮询了多次', polls >= 3, String(polls))
  }
  {
    const r = await dispatchMod.dispatchArchToDsh(
      { facts: FACTS, projectId: 'demo', attempt: 1, maxAttempts: 2, feedback: '' },
      {
        now: () => 1000,
        sleep: async () => {},
        waitMs: 1000,
        dispatch: () => ({ ok: false, disabled: true, reason: 'disabled', error: '派单总闸没开' }),
      },
    )
    check('★★ 总闸没开 → no_dsh（不是 timeout）', r.ok === false && r.failKind === 'no_dsh', JSON.stringify(r))
    check('总闸没开不轮询（没有会话可等）', r.sessionId === undefined || r.sessionId === '')
  }
  {
    let t = 1000
    let dispatchCalls = 0
    const r = await dispatchMod.dispatchArchToDsh(
      { facts: FACTS, projectId: 'demo', attempt: 1, maxAttempts: 2, feedback: '' },
      {
        now: () => t,
        sleep: async (ms) => { t += ms },
        waitMs: 500,
        pollMs: 100,
        dispatch: () => { dispatchCalls++; return { ok: true } },
        loadTasks: () => [],
      },
    )
    check('★★ 等不到草稿 → timeout，且说清等了多少秒', r.ok === false && r.failKind === 'timeout' && /秒/.test(r.error || ''), JSON.stringify(r))
    check('timeout 只派一次（不偷偷重复开会话）', dispatchCalls === 1, String(dispatchCalls))
  }
  {
    let t = 1000
    const r = await dispatchMod.dispatchArchToDsh(
      { facts: FACTS, projectId: 'demo', attempt: 1, maxAttempts: 2, feedback: '' },
      {
        now: () => t,
        sleep: async (ms) => { t += ms },
        shouldAbort: () => true,
        dispatch: () => ({ ok: true }),
        loadTasks: () => [],
      },
    )
    check('★★ 取消 → cancelled，并说清 DSH 会话停不了', r.ok === false && r.failKind === 'cancelled' && /还在跑|取消/.test(r.error || ''), JSON.stringify(r))
  }
  {
    let t = 1000
    let calls = 0
    const r = await dispatchMod.dispatchArchToDsh(
      { facts: FACTS, projectId: 'demo', attempt: 2, maxAttempts: 2, feedback: 'x' },
      {
        now: () => t,
        sleep: async (ms) => { t += ms },
        waitMs: 2000,
        pollMs: 100,
        dispatch: () => {
          calls++
          return calls === 1 ? { ok: false, cooling: true, leftMs: 10 } : { ok: true }
        },
        loadTasks: () => [{ fm: { title: '[架构图草稿] ' + 'arch-20261122120000-ffff' }, body: '{"nodes":[]}' }],
      },
    )
    // 第二次派单的 nonce 与假卡不同 → 等不到；这里只验"冷却后真重派了一次"
    check('★ 冷却不是失败：等完再派一次', calls === 2, String(calls))
    check('冷却重派后仍按 nonce 认卡（没认到就是 timeout，不是 OK）', r.ok === false && r.failKind === 'timeout', JSON.stringify(r))
  }

  console.log('\n== ④ 生成内核：DSH 草稿 → 逐条审计 → 不过重派 ≤2 次 ==')
  {
    let calls = 0
    const r = await aiMod.generateArchGraph(FACTS, {
      projectId: 'demo',
      dispatch: async () => { calls++; return { ok: true, text: fenced(GOOD_DRAFT), nonce: 'arch-x' } },
    })
    check('★★ 过审 → source=ai（DSH 生成图）', r.source === 'ai' && r.ok === true, JSON.stringify({ source: r.source, failKind: r.failKind }))
    check('★★ 图表头写明是 DSH 生成图', /DSH 生成图/.test(r.graph.text), r.graph.text)
    check('★ 节点数字只从事实取（src/main = 9 个文件）',
      (r.graph.nodes.find((n) => n.id === 'src/main') || {}).files === 9,
      JSON.stringify(r.graph.nodes.map((n) => [n.id, n.files])))
    check('连线条数只从事实取（renderer→shared = 6）',
      (r.graph.edges.find((e) => e.from === 'src/renderer' && e.to === 'src/shared') || {}).count === 6)
    check('只派一次就过 → attempts=1', calls === 1 && r.attempts === 1)
  }
  {
    const feedbacks = []
    let calls = 0
    const r = await aiMod.generateArchGraph(FACTS, {
      projectId: 'demo',
      maxAttempts: 2,
      dispatch: async (req) => {
        calls++
        feedbacks.push(req.feedback)
        return { ok: true, text: fenced(calls === 1 ? FAKE_DRAFT : GOOD_DRAFT) }
      },
    })
    check('★★ 第一版编了不存在的目录 → 第二版重派后过审', r.source === 'ai' && r.attempts === 2, JSON.stringify({ source: r.source, attempts: r.attempts }))
    check('★★ 审计意见真的喂回第二单（点名"支付网关"）', /支付网关|事实里没有这个目录/.test(feedbacks[1] || ''), String(feedbacks[1]).slice(0, 160))
    check('第二次任务书是新的（不是拿旧正文重画）', calls === 2)
  }
  {
    let calls = 0
    const r = await aiMod.generateArchGraph(FACTS, {
      projectId: 'demo',
      maxAttempts: 2,
      dispatch: async () => { calls++; return { ok: true, text: fenced(FAKE_DRAFT) } },
    })
    check('★★ 两次都不过 → 降级扫描图', r.source === 'scan' && r.failKind === 'audit_rejected', JSON.stringify({ source: r.source, failKind: r.failKind }))
    check('降级文案自报家门："这是扫描图，不是生成图"', r.graph.text.includes('这是扫描图，不是生成图'), r.graph.text)
    check('降级最多派两次', calls === 2, String(calls))
  }
  {
    let calls = 0
    const r = await aiMod.generateArchGraph(FACTS, {
      projectId: 'demo',
      dispatch: async () => {
        calls++
        return { ok: false, failKind: 'timeout', error: '等了 480 秒，DSH 没有交回带 nonce 的草稿卡' }
      },
    })
    check('★★ 等不到草稿 → 扫描图 + failKind=timeout（不是假装生成）', r.source === 'scan' && r.failKind === 'timeout', JSON.stringify({ source: r.source, failKind: r.failKind }))
    check('timeout 原因为"没有交回草稿卡"', /没有交回|等/.test(r.reason || ''), r.reason)
    check('派单失败不重派第二次（一次就够，别烧两次钱）', calls === 1, String(calls))
  }
  {
    let calls = 0
    const r = await aiMod.generateArchGraph(FACTS, {
      projectId: 'demo',
      shouldAbort: () => true,
      dispatch: async () => { calls++; return { ok: true, text: fenced(GOOD_DRAFT) } },
    })
    check('★★ 点取消（还没派）→ 扫描图 + cancelled，不派单', r.source === 'scan' && r.cancelled === true && calls === 0, JSON.stringify({ source: r.source, cancelled: r.cancelled, calls }))
  }
  {
    let calls = 0
    const r = await aiMod.generateArchGraph(FACTS, {
      projectId: 'demo',
      dispatch: async () => {
        calls++
        return { ok: false, failKind: 'cancelled', error: '已取消等待（DSH 会话可能还在跑）' }
      },
    })
    check('★★ 派单侧报取消 → 扫描图 + cancelled（不把半成品当成功）', r.source === 'scan' && r.cancelled === true && r.failKind === 'cancelled', JSON.stringify({ source: r.source, cancelled: r.cancelled, failKind: r.failKind }))
    check('取消后不再派第二次', calls === 1, String(calls))
  }

  console.log('\n== ⑤ 导出 HTML：来源要跟着走（不许离线件把口径丢了）==')
  const { renderArchHtml } = require(path.join(DIST, 'shared', 'archSvg.js'))
  {
    const aiRes = await aiMod.generateArchGraph(FACTS, {
      projectId: 'demo',
      dispatch: async () => ({ ok: true, text: fenced(GOOD_DRAFT) }),
    })
    const scanRes = await aiMod.generateArchGraph(FACTS, { projectId: 'demo' })
    check('★ 生成图的导出件里写「DSH 生成图」', /DSH 生成图/.test(renderArchHtml(aiRes.graph)), renderArchHtml(aiRes.graph).slice(0, 120))
    check('★ 扫描图的导出件里写「扫描图，不是生成图」', /扫描图，不是生成图/.test(renderArchHtml(scanRes.graph)), renderArchHtml(scanRes.graph).slice(0, 120))
  }

  console.log(`\nRESULT ${pass} / ${pass + fail}`)
  if (fail) {
    console.log('\n失败明细：')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
})().catch((e) => { console.error(e); process.exit(1) })
