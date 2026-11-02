/**
 * 方寸自绘架构图 · 生成内核的审计层（0.6.0 · 2026-11-02）
 *
 * 为什么要有这一层（卡 task-20261030-002，暮雨 10-31 念回第 7 条）：
 *   上一版只是「扫 import 画图」—— 暮雨原话「根本没有调用 AI 去生成。人家可是自带审计的严格生成，
 *   不是 AI 想怎么画就怎么画的」。要的不是"让 AI 自由画"，是**生成完逐条审计，指不回证据就不许进图**。
 *
 * 三条硬口径（与审计一一对应）：
 *  ① **每个节点 / 每条连线都必须指回一条真实事实**：目录、import、IPC 计数、端口、包名、入口文件。
 *     指不回的一律拒收 —— 拒收不是"猜它大概是哪个"，是把它列进 `issues` 并说清为什么。
 *  ② **审计不过要能退回重画**：`issues` 逐条给「哪一条 + 为什么 + 期望的写法」，
 *     调用方（`main/services/archAi.ts`）把它喂回模型重试；重试用完仍不过 → 降级为扫描图。
 *  ③ **降级必须自报家门**：无 AI / 无网络时仍出扫描图，但 `source` 必须是 `scan`，
 *     界面上要写「这是扫描图，不是生成图」—— 不许拿扫描图冒充生成结果。
 *
 * 纯逻辑：不读盘、不联网、不碰 electron（Node 可直跑，样板见 `shared/archGraph.ts`）。
 */
import { buildArchGraph, type ArchEdge, type ArchEdgeKind, type ArchGraph, type ArchNode, type ArchNodeKind, type ArchScanFacts } from './archGraph'

/** AI 草稿里的一个节点（`id` 是证据前缀形式，见 `ARCH_EVIDENCE_FORMS`） */
export interface ArchDraftNode {
  id: string
  label?: string
  kind?: ArchNodeKind
  evidence?: string[]
}

export interface ArchDraftEdge {
  from: string
  to: string
  kind?: ArchEdgeKind
  label?: string
  evidence?: string[]
}

export interface ArchDraft {
  title?: string
  subtitle?: string
  nodes?: ArchDraftNode[]
  edges?: ArchDraftEdge[]
}

export interface ArchAuditIssue {
  /** 哪一类对象不过 */
  target: 'node' | 'edge'
  /** 对象标识（节点 id 或 from->to） */
  id: string
  /** 为什么不过（人能读懂，能直接贴回给模型） */
  reason: string
  /** 期望的写法（给模型的具体修法） */
  expect: string
}

export interface ArchAuditResult {
  /** 没有任何 issue 才 true（空草稿也是 false：没画 = 没交付） */
  ok: boolean
  /** 通过审计的对象数 */
  acceptedNodes: number
  acceptedEdges: number
  issues: ArchAuditIssue[]
  /**
   * 不阻断的修正（例如"标签过长/含异常字符，已丢弃改用 id 显示"）。
   * 为什么标签不进 issues、也不做语义比对：中文层名（「主进程 / 服务」）与英文目录名本来不重合，
   * 硬比对会误杀合理写法；而标签编得再花也改不了节点 id 与证据（那才是事实）。
   * 标签只做"能否显示"的清理。
   */
  notes: string[]
  /** 只保留通过审计的对象（调用方只能用这一份画图） */
  clean: { nodes: ArchDraftNode[]; edges: ArchDraftEdge[] }
}

/** 证据 id 的合法形状（写错形状 = 不知道怎么核，直接拒） */
export const ARCH_EVIDENCE_FORMS = [
  'dir:<仓库相对目录>',
  'entry:<仓库相对文件>',
  'deps:<包名>',
  'import:<源目录>-><目标目录>',
  'ipc:handle:<条数>',
  'ipc:invoke:<条数>',
  'ipc:bridge:<条数>',
  'port:<端口号>',
] as const

const RE_NODE_ID = /^(dir|entry|deps):(.+)$/
const RE_EDGE_EVIDENCE = /^import:(.+?)->(.+)$/

function s(v: unknown): string {
  return String(v ?? '').trim()
}

/**
 * 一条证据能不能在事实里落地。
 * 返回 null = 能落地；否则返回"为什么不行"。
 */
export function evidenceProblem(ev: string, facts: ArchScanFacts): string | null {
  const e = s(ev)
  if (!e) return '证据是空串'
  const dirs = new Set((facts?.dirs || []).map((d) => s(d.path)))
  const entries = new Set((facts?.entries || []).map((x) => s(x)))
  const deps = new Set(((facts?.packageJson && facts.packageJson.deps) || []).map((x) => s(x)))
  const imports = new Set((facts?.imports || []).map((i) => `${s(i.from)}->${s(i.to)}`))
  const ports = new Set((facts?.ports || []).map((p) => String(p.port)))

  const m = RE_NODE_ID.exec(e)
  if (m) {
    const [, kind, val] = m
    if (kind === 'dir') return dirs.has(val) ? null : `事实里没有这个目录：${val}`
    if (kind === 'entry') return entries.has(val) ? null : `事实里没有这个入口文件：${val}`
    return deps.has(val) ? null : `package.json 的依赖里没有：${val}`
  }
  const im = RE_EDGE_EVIDENCE.exec(e)
  if (im) {
    const key = `${im[1]}->${im[2]}`
    return imports.has(key) ? null : `事实里没有这组 import：${key}`
  }
  if (/^ipc:handle:\d+$/.test(e)) {
    return (facts?.ipc?.handles || 0) > 0 ? null : '事实里 ipcMain.handle 计数为 0'
  }
  if (/^ipc:invoke:\d+$/.test(e)) {
    return (facts?.ipc?.invokes || 0) > 0 ? null : '事实里 ipcRenderer.invoke 计数为 0'
  }
  if (/^ipc:bridge:\d+$/.test(e)) {
    return (facts?.ipc?.bridgeUses || 0) > 0 ? null : '事实里 window.tegula.* 计数为 0'
  }
  if (/^port:\d+$/.test(e)) {
    const n = e.slice(5)
    return ports.has(n) ? null : `事实里没有扫到这个端口：${n}`
  }
  return `证据形状不认识（只认 ${ARCH_EVIDENCE_FORMS.join(' / ')}）`
}

function nodeKindOf(id: string): ArchNodeKind {
  if (id.startsWith('entry:')) return 'entry'
  if (id.startsWith('deps:')) return 'external'
  return 'layer'
}

/**
 * 标签清理：**不做语义审计**（改过一次，见下），只挡"过长 / 含异常字符"。
 *
 * 为什么撤掉"标签必须与目录同名"的检查：中文层名（「主进程 / 服务」「共享逻辑」）本来就与
 * 英文目录名不重合，硬比对会误杀大量完全合理的写法；而标签编得再花，也改不了
 * 节点 id 与证据（那才是事实）。所以口径是：**标签只是显示用，编不编不影响审计结论。**
 * 唯一保留的是"别把标签当第二份数据"：超长或带 `[]{}<>|` 的，丢掉改用 id。
 */
function labelIsRenderable(label: string): boolean {
  return label.length > 0 && label.length <= 20 && !/[\[\]{}<>|]/.test(label)
}

/**
 * 审计一份 AI 草稿。**永不抛**；任何输入都给一份结果（哪怕全拒）。
 */
export function auditArchDraft(draft: ArchDraft, facts: ArchScanFacts): ArchAuditResult {
  const issues: ArchAuditIssue[] = []
  const notes: string[] = []
  const rawNodes = Array.isArray(draft?.nodes) ? draft.nodes : []
  const rawEdges = Array.isArray(draft?.edges) ? draft.edges : []

  const nodeIds = new Set<string>()
  const cleanNodes: ArchDraftNode[] = []
  for (const n of rawNodes) {
    const id = s(n?.id)
    if (!id) {
      issues.push({ target: 'node', id: '(空)', reason: '节点没有 id', expect: '写成 dir:<目录> / entry:<文件> / deps:<包名>' })
      continue
    }
    if (nodeIds.has(id)) {
      issues.push({ target: 'node', id, reason: '同一个 id 出现两次', expect: '合并成一条，或给不同的 id' })
      continue
    }
    if (!RE_NODE_ID.test(id)) {
      issues.push({
        target: 'node', id,
        reason: '节点 id 不是证据形式（不知道它对应什么）',
        expect: `写成 ${ARCH_EVIDENCE_FORMS.slice(0, 3).join(' / ')}`,
      })
      continue
    }
    const ev = Array.isArray(n.evidence) ? n.evidence.map(s).filter(Boolean) : []
    if (!ev.length) {
      issues.push({ target: 'node', id, reason: '节点没有给出证据', expect: '至少给一条能落地的证据，例如与 id 同形的 dir:<目录>' })
      continue
    }
    let bad = ''
    for (const e of ev) {
      const p = evidenceProblem(e, facts)
      if (p) { bad = `证据「${e}」落不了地：${p}`; break }
    }
    if (bad) {
      issues.push({ target: 'node', id, reason: bad, expect: '只引用事实里真的存在的东西；编的模块/目录一律不许进图' })
      continue
    }
    // 标签只做"能不能显示"的清理，不做事实审计（见 labelIsRenderable 的理由）
    let label = s(n.label)
    if (label && !labelIsRenderable(label)) {
      notes.push(`节点 ${id} 的标签「${label.slice(0, 12)}…」过长或含异常字符，已丢弃、改用 id 显示`)
      label = ''
    }
    nodeIds.add(id)
    cleanNodes.push({ id, label, kind: n.kind || nodeKindOf(id), evidence: ev })
  }

  const cleanEdges: ArchDraftEdge[] = []
  const seenEdge = new Set<string>()
  for (const e of rawEdges) {
    const from = s(e?.from)
    const to = s(e?.to)
    const key = `${from}->${to}`
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      issues.push({
        target: 'edge', id: key,
        reason: `连线两端必须都是通过审计的节点（from ${nodeIds.has(from) ? '✓' : '✗'} / to ${nodeIds.has(to) ? '✓' : '✗'}）`,
        expect: '先把两端节点画出来并通过审计，再连这条线',
      })
      continue
    }
    if (seenEdge.has(key)) {
      issues.push({ target: 'edge', id: key, reason: '同一对节点连了两次', expect: '合并成一条，把条数写进 label' })
      continue
    }
    const ev = Array.isArray(e.evidence) ? e.evidence.map(s).filter(Boolean) : []
    if (!ev.length) {
      issues.push({ target: 'edge', id: key, reason: '连线没有给出证据', expect: `给一条 import:${from.replace(/^(dir|entry|deps):/, '')}->${to.replace(/^(dir|entry|deps):/, '')}` })
      continue
    }
    let bad = ''
    for (const x of ev) {
      const p = evidenceProblem(x, facts)
      if (p) { bad = `证据「${x}」落不了地：${p}`; break }
    }
    if (bad) {
      issues.push({ target: 'edge', id: key, reason: bad, expect: '连线只能来自真实的 import / IPC 计数，不许凭印象连' })
      continue
    }
    seenEdge.add(key)
    cleanEdges.push({ from, to, kind: e.kind || 'import', label: s(e.label), evidence: ev })
  }

  if (!rawNodes.length) {
    issues.push({ target: 'node', id: '(无)', reason: '草稿里一个节点都没有', expect: '至少画出事实里真实存在的目录' })
  }

  return {
    ok: issues.length === 0 && cleanNodes.length > 0,
    acceptedNodes: cleanNodes.length,
    acceptedEdges: cleanEdges.length,
    issues,
    notes,
    clean: { nodes: cleanNodes, edges: cleanEdges },
  }
}

/**
 * 把审计不过的原因写成"喂回模型"的一段话。
 * **必须具体**：只说"不合格"等于让模型再猜一次。
 */
export function renderAuditFeedback(result: ArchAuditResult): string {
  if (result.ok) return ''
  const L: string[] = ['上一版图被审计拒收，逐条原因如下（改完再交一次）：']
  const top = result.issues.slice(0, 20)
  for (const i of top) L.push(`- [${i.target}] ${i.id}：${i.reason}。改成：${i.expect}`)
  if (result.issues.length > top.length) L.push(`- ……另有 ${result.issues.length - top.length} 条同类问题`)
  L.push('硬规矩：节点只能是真实存在的目录 / 入口 / 依赖；连线只能来自真实 import / IPC 计数。编的一律不许进图。')
  return L.join('\n')
}

/**
 * 把**通过审计的**草稿变成渲染用的图。
 *
 * ⚠ 两条不许越界：
 *  ① 图上的**一切数字**（files / count / 端口）都从 `facts` 取，不信任草稿 ——
 *     草稿里根本没有数字字段（`ArchDraftNode` 只有 id/label/kind/evidence），所以编不出数字；
 *  ② `source` 必须如实：`ai` = 模型生成且过审；`scan` = 降级扫描图。界面上要按它写标。
 *
 * 入口与外部依赖在图上各只占一个节点（`__entry__` / `__deps__`，与 `buildArchGraph` 同口径），
 * 草稿里逐个列出的 `entry:` / `deps:` 在这里合并，样例取事实里的那一份。
 */
export function draftToGraph(
  clean: { nodes: ArchDraftNode[]; edges: ArchDraftEdge[] },
  facts: ArchScanFacts,
  meta: { source: 'ai' | 'scan'; note?: string },
): ArchGraph {
  const base = buildArchGraph(facts)
  const dirMap = new Map((facts?.dirs || []).map((d) => [String(d.path), d]))
  const nodes: ArchNode[] = []
  const idMap = new Map<string, string | null>() // 草稿 id → 渲染 id（null = 合并掉的）
  const entrySamples: string[] = []
  const depSamples: string[] = []

  for (const n of clean?.nodes || []) {
    const id = String(n.id || '')
    if (id.startsWith('dir:')) {
      const p = id.slice(4)
      const d = dirMap.get(p)
      nodes.push({
        id: p,
        label: String(n.label || '') || p.split('/').pop() || p,
        kind: n.kind || 'layer',
        files: Number(d?.files) || 0,          // ← 数字只从事实取
        samples: (d?.samples || []).slice(0, 5),
        note: `来自扫描事实：${p} · ${(d?.exts || []).join(' / ') || '代码'}`,
      })
      idMap.set(id, p)
      continue
    }
    if (id.startsWith('entry:')) {
      entrySamples.push(id.slice(6))
      idMap.set(id, '__entry__')
      continue
    }
    if (id.startsWith('deps:')) {
      depSamples.push(id.slice(5))
      idMap.set(id, '__deps__')
      continue
    }
    idMap.set(id, null)
  }

  if (entrySamples.length) {
    nodes.push({
      id: '__entry__', label: '入口', kind: 'entry',
      files: entrySamples.length,
      samples: entrySamples.slice(0, 5),
      note: '模型从扫描事实里挑出的入口文件',
    })
  }
  if (depSamples.length) {
    nodes.push({
      id: '__deps__', label: '外部依赖', kind: 'external',
      files: depSamples.length,
      samples: depSamples.slice(0, 8),
      note: '来自 package.json 的依赖（未扫 node_modules）',
    })
  }

  const edgeKey = (a: string, b: string): string => `${a}->${b}`
  const factImports = new Map((facts?.imports || []).map((i) => [edgeKey(String(i.from), String(i.to)), i]))
  const edges: ArchEdge[] = []
  const seen = new Set<string>()
  for (const e of clean?.edges || []) {
    const from = idMap.get(String(e.from || ''))
    const to = idMap.get(String(e.to || ''))
    if (!from || !to || from === to) continue
    const key = edgeKey(from, to)
    if (seen.has(key)) continue
    seen.add(key)
    const fact = factImports.get(key)
    edges.push({
      from, to,
      kind: e.kind || 'import',
      label: String(e.label || '') || `import ×${Number(fact?.count) || 0}`,
      count: Number(fact?.count) || 0,          // ← 条数只从事实取（拣不到就是 0，不编）
      samples: (fact?.samples || []).slice(0, 4),
    })
  }

  const parts = [`${nodes.length} 个组件`, `${edges.length} 条连线`, `扫描 ${Number(facts?.scannedFiles) || 0} 个文件`]
  if (base.missing.length) parts.push(`缺 ${base.missing.length} 项依据`)
  const head = meta.source === 'ai'
    ? '这是 AI 生成图（每个节点/连线都过了证据审计）'
    : '这是扫描图，不是生成图'
  const text = nodes.length
    ? `${head} · ${parts.join(' · ')}${meta.note ? ' · ' + meta.note : ''}`
    : (meta.source === 'ai'
      ? 'AI 草稿没有一个节点通过审计 —— 没有退化成扫描图，先看审计原因'
      : `${head} · ${base.text}`)

  return {
    ...base,
    title: base.title,
    subtitle: meta.source === 'ai' ? 'AI 生成 · 逐条证据审计' : (meta.note || '静态扫描'),
    nodes,
    edges,
    text,
    scannedFiles: Number(facts?.scannedFiles) || 0,
    truncated: !!facts?.truncated,
  }
}

/** 生成时给模型的"只能引用这些"清单（与审计共用同一份事实，避免"提示词说有、审计说不认"） */
export function allowedEvidence(facts: ArchScanFacts, limit = 120): string[] {
  const out: string[] = []
  for (const d of facts?.dirs || []) out.push(`dir:${s(d.path)}`)
  for (const e of facts?.entries || []) out.push(`entry:${s(e)}`)
  for (const d of (facts?.packageJson && facts.packageJson.deps) || []) out.push(`deps:${s(d)}`)
  for (const i of facts?.imports || []) out.push(`import:${s(i.from)}->${s(i.to)}`)
  if ((facts?.ipc?.handles || 0) > 0) out.push(`ipc:handle:${facts.ipc.handles}`)
  if ((facts?.ipc?.invokes || 0) > 0) out.push(`ipc:invoke:${facts.ipc.invokes}`)
  if ((facts?.ipc?.bridgeUses || 0) > 0) out.push(`ipc:bridge:${facts.ipc.bridgeUses}`)
  for (const p of facts?.ports || []) out.push(`port:${p.port}`)
  return out.slice(0, limit)
}
