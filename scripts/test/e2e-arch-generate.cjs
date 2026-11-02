/**
 * 自绘架构图 · 生成内核审计（0.6.0 · 2026-11-02）
 *
 * 判据一句话：**不许编。** AI 可以画，但每个节点/连线都要指回一条真实事实；
 * 指不回的一律拒收、逐条说清为什么、并且**拒收的东西绝不能出现在送给渲染器的 clean 里**。
 *
 * 真跑编译产物 `dist/shared/archGenerate.js`（纯逻辑，无 electron / 无网络）。
 * 运行：node scripts/test/e2e-arch-generate.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'archGenerate.js')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')) }
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const { auditArchDraft, evidenceProblem, renderAuditFeedback, allowedEvidence, ARCH_EVIDENCE_FORMS } = require(ART)

/** 夹具：结构与真实扫描事实同形（够用，不假装是某个真项目） */
const FACTS = {
  project: { id: 'demo', name: '演示', repo: 'E:/demo' },
  packageJson: { name: 'demo', version: '1.0.0', deps: ['electron', 'vue'], scripts: {} },
  dirs: [
    { path: 'src/renderer', files: 12, samples: ['src/renderer/App.vue'], exts: ['.vue'] },
    { path: 'src/main', files: 9, samples: ['src/main/index.ts'], exts: ['.ts'] },
    { path: 'src/shared', files: 4, samples: ['src/shared/util.ts'], exts: ['.ts'] },
  ],
  entries: ['src/main/index.ts'],
  imports: [
    { from: 'src/renderer', to: 'src/shared', count: 6, samples: ['x.ts'] },
    { from: 'src/main', to: 'src/shared', count: 3, samples: ['y.ts'] },
  ],
  ipc: { handles: 7, handleSamples: ['a'], invokes: 7, invokeSamples: ['b'], bridgeUses: 5, bridgeSamples: ['c'] },
  ports: [{ port: 8753, source: 'templates' }],
  scannedFiles: 25,
  truncated: false,
}

console.log('== ① 合法草稿：每条证据都能落地 ==')
const good = {
  nodes: [
    { id: 'dir:src/renderer', label: 'renderer', evidence: ['dir:src/renderer'] },
    { id: 'dir:src/main', label: 'main', evidence: ['dir:src/main', 'ipc:handle:7'] },
    { id: 'dir:src/shared', label: '共享逻辑', evidence: ['dir:src/shared'] },
    { id: 'entry:src/main/index.ts', label: '入口', evidence: ['entry:src/main/index.ts'] },
  ],
  edges: [
    { from: 'dir:src/renderer', to: 'dir:src/shared', evidence: ['import:src/renderer->src/shared'] },
    { from: 'dir:src/main', to: 'dir:src/shared', evidence: ['import:src/main->src/shared'] },
  ],
}
const g = auditArchDraft(good, FACTS)
check('★★ 全合规 → ok=true', g.ok === true, JSON.stringify(g.issues))
check('  4 个节点 / 2 条连线全留下', g.acceptedNodes === 4 && g.acceptedEdges === 2,
  JSON.stringify({ n: g.acceptedNodes, e: g.acceptedEdges }))

console.log('\n== ② 编造的节点：一律拒收，且不进 clean ==')
const fake = {
  nodes: [
    ...good.nodes,
    { id: 'dir:src/不存在的模块', label: '编的', evidence: ['dir:src/不存在的模块'] },
  ],
  edges: good.edges,
}
const f = auditArchDraft(fake, FACTS)
check('★★ 编造的目录 → ok=false', f.ok === false)
check('★★ 拒收的节点**不进 clean**（渲染器拿不到它）',
  f.clean.nodes.every((n) => n.id !== 'dir:src/不存在的模块') && f.acceptedNodes === 4,
  JSON.stringify(f.clean.nodes.map((n) => n.id)))
check('★ 给出的原因点名"没有这个目录"', f.issues.some((i) => /没有这个目录/.test(i.reason)),
  JSON.stringify(f.issues.map((i) => i.reason)))
check('★ 给出的 expect 说明该怎么改', f.issues.every((i) => i.expect && i.expect.length > 4))

console.log('\n== ③ 没有证据 / 证据形状不认识 ==')
const noEv = auditArchDraft({ nodes: [{ id: 'dir:src/main', label: 'main' }], edges: [] }, FACTS)
check('★★ 节点没给证据 → 拒收', noEv.ok === false && /没有给出证据/.test(noEv.issues[0].reason), JSON.stringify(noEv.issues))
const badShape = auditArchDraft({ nodes: [{ id: 'dir:src/main', label: 'main', evidence: ['我觉得它很重要'] }], edges: [] }, FACTS)
check('★★ 证据形状不认识 → 拒收（不猜）', badShape.ok === false && /形状不认识/.test(badShape.issues[0].reason), JSON.stringify(badShape.issues))
const badId = auditArchDraft({ nodes: [{ id: 'src/main', label: 'main', evidence: ['dir:src/main'] }], edges: [] }, FACTS)
check('★★ 节点 id 不是证据形式 → 拒收', badId.ok === false && /不是证据形式/.test(badId.issues[0].reason), JSON.stringify(badId.issues))

console.log('\n== ④ 连线：两端必须是过了审的节点，证据必须落地 ==')
const edgeToGhost = auditArchDraft({
  nodes: good.nodes,
  edges: [{ from: 'dir:src/main', to: 'dir:src/幽灵', evidence: ['import:src/main->src/幽灵'] }],
}, FACTS)
check('★★ 连到没过审的节点 → 拒收', edgeToGhost.ok === false && /两端必须都是通过审计的节点/.test(edgeToGhost.issues[0].reason),
  JSON.stringify(edgeToGhost.issues))
const edgeNoEv = auditArchDraft({
  nodes: good.nodes,
  edges: [{ from: 'dir:src/main', to: 'dir:src/shared' }],
}, FACTS)
check('★★ 连线没有证据 → 拒收', edgeNoEv.ok === false && /连线没有给出证据/.test(edgeNoEv.issues[0].reason))
const edgeFake = auditArchDraft({
  nodes: good.nodes,
  edges: [{ from: 'dir:src/renderer', to: 'dir:src/main', evidence: ['import:src/renderer->src/main'] }],
}, FACTS)
check('★★ 凭印象连一条事实里没有的 import → 拒收', edgeFake.ok === false && /没有这组 import/.test(edgeFake.issues[0].reason),
  JSON.stringify(edgeFake.issues))

console.log('\n== ⑤ 空草稿 / 重复 / 标签对不上 ==')
check('★★ 空草稿 → ok=false（没画 = 没交付）', auditArchDraft({}, FACTS).ok === false)
check('  空草稿的 issue 说"一个节点都没有"', /一个节点都没有/.test(auditArchDraft({}, FACTS).issues[0].reason))
const dup = auditArchDraft({ nodes: [good.nodes[0], good.nodes[0]], edges: [] }, FACTS)
check('★ 同一 id 两次 → 拒收第二份', dup.ok === false && /出现两次/.test(dup.issues[0].reason))
const wrongLabel = auditArchDraft({
  nodes: [{ id: 'dir:src/main', label: '微信支付网关', evidence: ['dir:src/main'] }], edges: [],
}, FACTS)
check('★★ 标签不参与事实审计（编个花名字也改不了节点身份与证据）→ 节点照样通过',
  wrongLabel.ok === true && wrongLabel.acceptedNodes === 1, JSON.stringify(wrongLabel.issues))
check('★ 正常中文层名（“共享逻辑”）不会被误伤',
  auditArchDraft({ nodes: [good.nodes[2]], edges: [] }, FACTS).ok === true)
const crazyLabel = auditArchDraft({
  nodes: [{ id: 'dir:src/main', label: '<script>alert(1)</script>很长很长很长很长很长', evidence: ['dir:src/main'] }], edges: [],
}, FACTS)
check('★★ 标签含异常字符/超长 → 丢弃标签改用 id 显示（不当第二份数据）',
  crazyLabel.ok === true && crazyLabel.clean.nodes[0].label === ''
  && crazyLabel.notes.some((x) => /丢弃|改用 id/.test(x)),
  JSON.stringify({ label: crazyLabel.clean.nodes[0].label, notes: crazyLabel.notes }))

console.log('\n== ⑥ 反馈能喂回模型：具体到"哪条 + 为什么 + 怎么改" ==')
const fb = renderAuditFeedback(f)
check('★ 反馈含被拒条目 id', fb.includes('dir:src/不存在的模块'))
check('★ 反馈含原因与改法', /没有这个目录/.test(fb) && /改成：/.test(fb))
check('★ 反馈重申硬规矩（编的一律不许进图）', /编的一律不许进图/.test(fb))
check('  通过时不产生反馈', renderAuditFeedback(g) === '')

console.log('\n== ⑦ 提示词名单与审计同一份事实（不许"提示词说有、审计说不认"）==')
const allowed = allowedEvidence(FACTS)
check('★ 名单非空且形状都是合法前缀', allowed.length > 0
  && allowed.every((e) => ARCH_EVIDENCE_FORMS.some((f2) => e.startsWith(f2.split(':')[0] + ':'))), String(allowed.length))
const contradictions = allowed.filter((e) => evidenceProblem(e, FACTS) !== null)
check('★★ 名单里的每一条都能通过审计（同一份事实，零矛盾）', contradictions.length === 0, contradictions.join(' | '))

console.log('\n== ⑧ 单条证据核验的边界 ==')
check('dir: 真目录 → 能落地', evidenceProblem('dir:src/main', FACTS) === null)
check('entry: 真入口 → 能落地', evidenceProblem('entry:src/main/index.ts', FACTS) === null)
check('deps: 真依赖 → 能落地', evidenceProblem('deps:electron', FACTS) === null)
check('deps: 假依赖 → 落不了地', /依赖里没有/.test(String(evidenceProblem('deps:lodash', FACTS))))
check('port: 真端口 → 能落地', evidenceProblem('port:8753', FACTS) === null)
check('port: 假端口 → 落不了地', /没有扫到这个端口/.test(String(evidenceProblem('port:1', FACTS))))
check('ipc: 计数为 0 时说"计数为 0"而不是"通过"',
  /计数为 0/.test(String(evidenceProblem('ipc:handle:7', { ...FACTS, ipc: { ...FACTS.ipc, handles: 0 } }))))

console.log('\n== ⑨ 过审草稿 → 图：数字只从事实取，来源必须自报 ==')
const { draftToGraph } = require(ART)
const gai = draftToGraph(g.clean, FACTS, { source: 'ai' })
check('★★ AI 图的节点数与过审节点一致', gai.nodes.length === 4, String(gai.nodes.length))
check('★★ 节点上的文件数来自扫描事实（不是草稿给的）',
  gai.nodes.find((n) => n.id === 'src/renderer').files === 12
  && gai.nodes.find((n) => n.id === 'src/main').files === 9,
  JSON.stringify(gai.nodes.map((n) => n.id + ':' + n.files)))
check('★★ 连线条数来自事实（import ×6 / ×3）',
  gai.edges.length === 2 && gai.edges.every((e) => e.count > 0)
  && gai.edges.find((e) => e.from === 'src/renderer').count === 6,
  JSON.stringify(gai.edges.map((e) => e.from + '->' + e.to + ':' + e.count)))
check('★★ 图表头自报"AI 生成图"', /AI 生成图/.test(gai.text) && /证据审计/.test(gai.subtitle), gai.text)
const scan = draftToGraph({ nodes: [], edges: [] }, FACTS, { source: 'scan', note: '没配模型' })
check('★★ 降级图自报"扫描图，不是生成图"（不许冒充）', /扫描图/.test(scan.text) && /不是生成图/.test(scan.text), scan.text)
check('★ 降级图仍带扫描事实里的缺项（不装完整）', Array.isArray(scan.missing))

// 入口/依赖在图上各占一格：草稿列了多个 entry 也合并
const merged = draftToGraph({
  nodes: [
    { id: 'entry:src/main/index.ts', label: '入口', evidence: ['entry:src/main/index.ts'] },
    { id: 'entry:src/cli/run.ts', label: '入口', evidence: ['entry:src/cli/run.ts'] },
  ],
  edges: [],
}, { ...FACTS, entries: ['src/main/index.ts', 'src/cli/run.ts'] }, { source: 'ai' })
check('★ 多个入口合并成 __entry__ 一个节点', merged.nodes.length === 1 && merged.nodes[0].id === '__entry__',
  JSON.stringify(merged.nodes.map((n) => n.id)))

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('\n失败项：'); for (const x of failures) console.log('  · ' + x) }
process.exit(fail ? 1 : 0)
