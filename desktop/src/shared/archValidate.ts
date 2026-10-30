/**
 * 方寸自绘架构图 —— 分层校验（2026-10-30 暮雨第 3 条）
 *
 * 用户原话：「这画出来是什么垃圾？人家 archify 是层层校验才能画出来的，
 * agent 画一笔都要审批，不通过自己重画，这才是我需要的。」
 *
 * 所以这张图不是"扫完直接画"，而是先过**七道可核实的门**：
 *   ① 证据：每个节点/连线都有真实来源（文件数、样例），没有就不许画；
 *   ② 唯一：id / 连线不重复，不自指；
 *   ③ 规模：节点 ≤16、连线 ≤48 —— 超了就说明该合并/该删弱线；
 *   ④ 行宽：一层最多 6 块，否则整行读不过来；
 *   ⑤ 标签：名字装得下（超长就截断是画法，但数据本身不该是一句话）；
 *   ⑥ 几何：方块不重叠、全在画布内、分层带不压方块；
 *   ⑦ 比例：画布不能被拉成一条；
 * 另有两条**警告**（不挡导出）：孤块太多、分层不均 —— 它们说明扫描或归类可能有问题，
 * 要让人看见，但不能假装是错误。
 *
 * 这里只做判断，不修图；修图在 `repairArchGraph`（驳回重画时调用），
 * 每次修什么都会记进 `repairs`，界面必须逐条说出来。
 */
import type { ArchGraph, ArchEdge, ArchNode } from './archGraph'
import { layoutArch } from './archSvg'

export type GateSeverity = 'error' | 'warn'

export interface ArchGate {
  id: string
  name: string
  pass: boolean
  severity: GateSeverity
  /** 一句话说清"这扇门在查什么 / 查到了什么" */
  detail: string
  /** 不通过时给人看的修法（不是自动修，先让人知道该动哪） */
  fix?: string
}

export interface ArchReview {
  ok: boolean
  gates: ArchGate[]
  passCount: number
  total: number
  errors: number
  warnings: number
  /** 0–100，只用于显示进度感，不代表"图好看" */
  score: number
  text: string
}

function idSet(nodes: ArchNode[]): Set<string> {
  return new Set(nodes.map((n) => n.id))
}

function overlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export function evaluateArchGraph(graph: ArchGraph): ArchReview {
  const nodes = graph.nodes || []
  const edges = graph.edges || []
  const ids = idSet(nodes)
  const lay = layoutArch(graph)
  const gates: ArchGate[] = []

  const badNodeEvidence = nodes.filter((n) => !(n.files > 0) || !(n.samples || []).length)
  gates.push({
    id: 'evidence-nodes', name: '节点有证据', severity: 'error',
    pass: badNodeEvidence.length === 0,
    detail: badNodeEvidence.length
      ? `${badNodeEvidence.length} 个节点没有文件数或文件样例：${badNodeEvidence.map((n) => n.id).join('、')}`
      : `${nodes.length} 个节点全部来自真实目录 / 入口 / 依赖清单`,
    fix: '没有样例的节点不该画：要么补扫，要么删掉',
  })

  const badEdgeEvidence = edges.filter((e) =>
    !ids.has(e.from) || !ids.has(e.to) || e.from === e.to || !(e.count > 0) || !(e.samples || []).length)
  gates.push({
    id: 'evidence-edges', name: '连线有证据', severity: 'error',
    pass: badEdgeEvidence.length === 0,
    detail: badEdgeEvidence.length
      ? `${badEdgeEvidence.length} 条连线端点不存在 / 计数为 0 / 没有样例`
      : `${edges.length} 条连线全部带计数与源码样例`,
    fix: '端点不存在的连线一律删；没有样例的连线不能当证据',
  })

  const seen = new Set<string>()
  const dup: string[] = []
  for (const e of edges) {
    const k = `${e.kind}:${e.from}->${e.to}`
    if (seen.has(k)) dup.push(k)
    seen.add(k)
  }
  const dupNodes = nodes.length - ids.size
  gates.push({
    id: 'unique', name: 'id 与连线唯一', severity: 'error',
    pass: dup.length === 0 && dupNodes === 0,
    detail: dup.length || dupNodes
      ? `重复节点 ${dupNodes} 个 / 重复连线 ${dup.length} 条：${dup.slice(0, 3).join('、')}`
      : '没有重复节点 / 重复连线 / 自指',
    fix: '同一对目录的多条连线应先聚合再画',
  })

  const tooMany = nodes.length > 16 || edges.length > 48
  gates.push({
    id: 'scale', name: '规模读得过来', severity: 'error',
    pass: !tooMany,
    detail: `${nodes.length} 个节点 / ${edges.length} 条连线（上限 16 / 48）`,
    fix: '节点太多：把只有一两个文件的目录并回父级；连线太多：只留 ≥2 条的 import',
  })

  const rows = new Map<number, number>()
  for (const b of lay.boxes) {
    const r = b.node.kind === 'entry' ? -1 : b.node.kind === 'external' ? 5 : undefined
    const row = r !== undefined ? r : (lay.bands.find((band) => b.y >= band.y - 24 && b.y <= band.y + band.h)?.row ?? 99)
    rows.set(row, (rows.get(row) || 0) + 1)
  }
  const widest = Math.max(0, ...Array.from(rows.values()))
  gates.push({
    id: 'row-width', name: '每层读得过来', severity: 'error',
    pass: widest <= 6,
    detail: `最宽的一层 ${widest} 块（上限 6）`,
    fix: '把同层里文件最少的几块并回父级，或拆成"核心 / 其余"两张图',
  })

  const longNode = nodes.filter((n) => String(n.label || '').length > 24 || String(n.note || '').length > 60)
  const longEdge = edges.filter((e) => String(e.label || '').length > 44)
  gates.push({
    id: 'label-fit', name: '标签装得下', severity: 'warn',
    pass: longNode.length === 0 && longEdge.length === 0,
    detail: longNode.length || longEdge.length
      ? `${longNode.length} 个节点名 / ${longEdge.length} 条连线标签过长（会被截断）`
      : '节点名与连线标签都在可读长度内',
    fix: '标签应是目录名或计数，不是一句话；过长的多半是归类没做对',
  })

  let overlapCount = 0
  for (let i = 0; i < lay.boxes.length; i++) {
    for (let j = i + 1; j < lay.boxes.length; j++) {
      if (overlap(lay.boxes[i], lay.boxes[j])) overlapCount++
    }
  }
  const outOfCanvas = lay.boxes.filter((b) => b.x < 0 || b.y < 0 || b.x + b.w > lay.width || b.y + b.h > lay.height).length
  const bandHits = lay.bands.filter((band) => lay.boxes.some((b) => b.x < band.x + band.w && overlap(b, band))).length
  gates.push({
    id: 'geometry', name: '几何不打架', severity: 'error',
    pass: overlapCount === 0 && outOfCanvas === 0 && bandHits === 0,
    detail: `方块重叠 ${overlapCount} 处 · 出画布 ${outOfCanvas} 块 · 压分层带 ${bandHits} 处`,
    fix: '这是布局器的错，不是数据的错 —— 应改布局参数，不许用 overflow:hidden 遮',
  })

  const ratio = lay.height > 0 ? lay.width / lay.height : 99
  gates.push({
    id: 'aspect', name: '比例正常', severity: 'warn',
    pass: ratio >= 0.7 && ratio <= 3.2,
    detail: `画布 ${lay.width}×${lay.height}（宽高比 ${ratio.toFixed(2)}，期望 0.7–3.2）`,
    fix: '太扁：分层带全挤在一起；太窄：一行塞太多。调布局，不要缩字号',
  })

  const linked = new Set<string>()
  for (const e of edges) { linked.add(e.from); linked.add(e.to) }
  const orphans = nodes.filter((n) => n.kind !== 'entry' && n.kind !== 'external' && !linked.has(n.id))
  gates.push({
    id: 'orphans', name: '孤块不多', severity: 'warn',
    pass: orphans.length <= Math.max(1, Math.floor(nodes.length / 3)),
    detail: orphans.length
      ? `${orphans.length} 块没有任何连线：${orphans.slice(0, 4).map((n) => n.label).join('、')}`
      : '每块至少有一条真实连线',
    fix: '孤块可能是没扫到 import（真实情况），也可能是归类太细 —— 先别删，点开看文件',
  })

  const errors = gates.filter((g) => g.severity === 'error' && !g.pass).length
  const warnings = gates.filter((g) => g.severity === 'warn' && !g.pass).length
  const passCount = gates.filter((g) => g.pass).length
  const total = gates.length
  const text = errors
    ? `${total} 道校验里有 ${errors} 道没过${warnings ? `，另有 ${warnings} 条警告` : ''} —— 这张图还不能导出`
    : `${total} 道校验全部通过${warnings ? `（${warnings} 条警告，不挡导出）` : ''}`
  return {
    ok: errors === 0,
    gates,
    passCount,
    total,
    errors,
    warnings,
    score: Math.round((passCount / Math.max(1, total)) * 100),
    text,
  }
}

/**
 * 驳回后"自己重画"：按诊断做**有据可查的减法**（不是重新编一张图）。
 *
 * 只做两件事，round 越大越严格：
 *   · 连线超限 → 按计数从低到高删 import（IPC / 桥不删，它们本来就是稀有证据）；
 *   · 节点超限 → 删"只有 1 个文件且没有任何 IPC/桥连线"的碎块（并回父级应由扫描器做，
 *     这里删掉是因为图模型层已经无法知道父级 —— 宁可少画，不许编）。
 * 每次删什么都会写进 repairs，界面逐条展示。
 */
export function repairArchGraph(graph: ArchGraph, round = 1): { graph: ArchGraph; repairs: string[] } {
  const repairs: string[] = []
  let nodes = (graph.nodes || []).slice()
  let edges = (graph.edges || []).slice()

  const maxNodes = Math.max(8, 16 - (round - 1) * 2)
  const maxEdges = Math.max(20, 48 - (round - 1) * 8)

  if (edges.length > maxEdges) {
    const keepImport = edges.filter((e) => e.kind === 'import')
      .sort((a, b) => b.count - a.count)
      .slice(0, Math.max(0, maxEdges - edges.filter((e) => e.kind !== 'import').length))
    const keep = new Set(keepImport.map((e) => `${e.kind}:${e.from}->${e.to}`))
    const before = edges.length
    edges = edges.filter((e) => e.kind !== 'import' || keep.has(`${e.kind}:${e.from}->${e.to}`))
    repairs.push(`连线 ${before} → ${edges.length}：删掉计数最低的 import（IPC / 桥全部保留）`)
  }

  if (nodes.length > maxNodes) {
    const linked = new Set<string>()
    for (const e of edges) { linked.add(e.from); linked.add(e.to) }
    const protectedIds = new Set(nodes.filter((n) => n.kind === 'entry' || n.kind === 'external').map((n) => n.id))
    const weak = nodes
      .filter((n) => !protectedIds.has(n.id) && n.files <= 1 && !linked.has(n.id))
      .sort((a, b) => a.files - b.files)
    const drop = new Set<string>()
    for (const n of weak) {
      if (nodes.length - drop.size <= maxNodes) break
      drop.add(n.id)
    }
    if (!drop.size) {
      // 没有明显碎块：按文件数从少到多删（仍然保留入口/依赖）
      const rest = nodes.filter((n) => !protectedIds.has(n.id)).sort((a, b) => a.files - b.files)
      for (const n of rest) {
        if (nodes.length - drop.size <= maxNodes) break
        drop.add(n.id)
      }
    }
    if (drop.size) {
      const before = nodes.length
      nodes = nodes.filter((n) => !drop.has(n.id))
      edges = edges.filter((e) => !drop.has(e.from) && !drop.has(e.to))
      repairs.push(`节点 ${before} → ${nodes.length}：删掉 ${drop.size} 个碎块（${Array.from(drop).slice(0, 4).join('、')}）`)
    }
  }

  if (!repairs.length) repairs.push('这一版没有可自动修的地方 —— 检查数据源（package.json / 目录 / import）是否完整')
  const text = `${nodes.length} 个组件 · ${edges.length} 条连线 · 扫描 ${graph.scannedFiles} 个文件` +
    (repairs.length ? ` · 重画第 ${round} 版` : '')
  return { graph: { ...graph, nodes, edges, text }, repairs }
}
