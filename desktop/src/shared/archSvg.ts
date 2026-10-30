/**
 * 方寸自绘架构图 —— SVG / 独立 HTML 渲染（纯函数，2026-10-30）
 *
 * 为什么不量 DOM：图上的一切坐标都由**行序 + 序号**算出来（不依赖 getBoundingClientRect），
 * 这样同一份图在 Node 里能直接断言（`e2e-project-arch.cjs` 真跑这个文件）。
 *
 * 交互（不联网、不引第三方）：
 *  · 点节点 → 高亮它相关的连线，其余变淡（同一份 SVG 里用 class 切）；
 *  · `<title>` 给悬停提示；证据列在 `renderArchHtml` 里逐条列出。
 */

import { rowOfNode, type ArchGraph, type ArchNode } from './archGraph'

const BOX_W = 200
const BOX_H = 66
const GAP_X = 28
const GAP_Y = 104
const PAD = 24

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function clip(s: string, n: number): string {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** 行序 → 该行的节点（保持输入顺序，图才稳定，断言才不会随机红） */
export function groupRows(graph: ArchGraph): Array<{ row: number; nodes: ArchNode[] }> {
  const map = new Map<number, ArchNode[]>()
  for (const n of graph.nodes || []) {
    const r = rowOfNode(n)
    if (!map.has(r)) map.set(r, [])
    map.get(r)!.push(n)
  }
  return Array.from(map.entries()).sort((a, b) => a[0] - b[0]).map(([row, nodes]) => ({ row, nodes }))
}

export interface ArchLayout {
  width: number
  height: number
  boxes: Array<{ node: ArchNode; x: number; y: number; w: number; h: number }>
  byId: Record<string, { x: number; y: number; w: number; h: number }>
}

/** 布局（纯算术）：行内均分；节点宽固定，行多则整体加宽 */
export function layoutArch(graph: ArchGraph): ArchLayout {
  const rows = groupRows(graph)
  const maxCount = rows.reduce((m, r) => Math.max(m, r.nodes.length), 1)
  const width = Math.max(760, PAD * 2 + maxCount * BOX_W + (maxCount - 1) * GAP_X + 60)
  const boxes: ArchLayout['boxes'] = []
  rows.forEach((r, ri) => {
    const n = r.nodes.length
    const total = n * BOX_W + (n - 1) * GAP_X
    const startX = (width - total) / 2
    r.nodes.forEach((node, i) => {
      boxes.push({ node, x: startX + i * (BOX_W + GAP_X), y: PAD + ri * GAP_Y, w: BOX_W, h: BOX_H })
    })
  })
  const byId: ArchLayout['byId'] = {}
  for (const b of boxes) byId[b.node.id] = { x: b.x, y: b.y, w: b.w, h: b.h }
  return { width, height: PAD * 2 + Math.max(1, rows.length) * GAP_Y - (GAP_Y - BOX_H), boxes, byId }
}

function edgePath(a: { x: number; y: number; w: number; h: number }, b: typeof a): string {
  const ax = a.x + a.w / 2
  const ay = a.y + a.h
  const bx = b.x + b.w / 2
  const by = b.y
  if (Math.abs(ay - by) < 4) {
    // 同一行：右侧绕出、左侧绕回
    const sx = a.x + a.w
    const sy = a.y + a.h / 2
    const ex = b.x
    const ey = b.y + b.h / 2
    return `M ${sx} ${sy} C ${sx + 40} ${sy}, ${ex - 40} ${ey}, ${ex} ${ey}`
  }
  const dy = Math.max(28, (by - ay) / 2)
  return `M ${ax} ${ay} C ${ax} ${ay + dy}, ${bx} ${by - dy}, ${bx} ${by}`
}

const COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
  entry: { fill: '#17181c', stroke: '#17181c', text: '#ffffff' },
  layer: { fill: '#ffffff', stroke: '#c9c6d6', text: '#17181c' },
  shared: { fill: '#f6f4fb', stroke: '#b9b3d0', text: '#3c3f47' },
  external: { fill: '#fbfbfa', stroke: '#d8d5cf', text: '#6b6f78' },
}

const KIND_LABEL: Record<string, string> = {
  import: 'import',
  ipc: 'IPC',
  bridge: '桥',
}

/**
 * 图本体（纯 SVG 字符串，含内联 <style>，因此贴进页面或存成 HTML 都自带样式）。
 * `active` 只影响初始高亮：给某节点 id，它的边先亮起来。
 */
export function renderArchSvg(graph: ArchGraph, opts: { active?: string } = {}): string {
  const lay = layoutArch(graph)
  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lay.width} ${lay.height}" class="archd-svg" role="img" aria-label="${esc(graph.title)}">`)
  out.push(`<style>
.archd-svg text { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.archd-edge path { fill: none; stroke: #b6b1c7; stroke-width: 1.4; opacity: .85; }
.archd-edge.import path { stroke: #8f88a8; }
.archd-edge.ipc path { stroke: #b07a2a; stroke-dasharray: 5 3; }
.archd-edge.bridge path { stroke: #2f6f8f; stroke-dasharray: 2 3; }
.archd-edge.on path { stroke-width: 2.6; opacity: 1; }
.archd-edge.dim { opacity: .12; }
.archd-edge-label { font-size: 9.5px; fill: #7d7889; }
.archd-edge.on .archd-edge-label { fill: #3c3f47; }
.archd-node { cursor: pointer; }
.archd-node .box { stroke-width: 1.2; transition: filter .15s; }
.archd-node:hover .box { filter: drop-shadow(0 2px 6px rgba(40, 40, 70, .18)); }
.archd-node.on .box { stroke: #6b5bb5; stroke-width: 2.2; }
.archd-node.dim { opacity: .35; }
.archd-node .ttl { font-size: 12.5px; font-weight: 700; }
.archd-node .sub { font-size: 10px; opacity: .75; }
.archd-node .cnt { font-size: 20px; font-weight: 700; letter-spacing: -.02em; }
.archd-legend text { font-size: 10px; fill: #7d7889; }
</style>`)
  out.push('<defs><marker id="archd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#b6b1c7"/></marker></defs>')

  // 先画边（节点压在上面）
  for (const e of graph.edges || []) {
    const a = lay.byId[e.from]
    const b = lay.byId[e.to]
    if (!a || !b) continue
    const d = edgePath(a, b)
    const mid = { x: (a.x + a.w / 2 + b.x + b.w / 2) / 2, y: (a.y + a.h + b.y) / 2 }
    const hot = opts.active && (e.from === opts.active || e.to === opts.active)
    const cls = ['archd-edge', e.kind, hot ? 'on' : '', opts.active && !hot ? 'dim' : ''].filter(Boolean).join(' ')
    out.push(`<g class="${cls}" data-edge="${esc(e.from)}-${esc(e.to)}">`)
    out.push(`<path d="${d}" marker-end="url(#archd-arrow)"><title>${esc(e.label)}${e.samples && e.samples.length ? '\n' + esc(e.samples.join('\n')) : ''}</title></path>`)
    out.push(`<text class="archd-edge-label" x="${mid.x}" y="${mid.y - 4}" text-anchor="middle">${esc(clip(e.label, 34))}</text>`)
    out.push('</g>')
  }

  for (const b of lay.boxes) {
    const n = b.node
    const c = COLORS[n.kind] || COLORS.layer
    const hot = opts.active === n.id
    const cls = ['archd-node', hot ? 'on' : '', opts.active && !hot ? 'dim' : ''].filter(Boolean).join(' ')
    out.push(`<g class="${cls}" data-node="${esc(n.id)}">`)
    out.push(`<rect class="box" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="12" fill="${c.fill}" stroke="${c.stroke}"/>`)
    out.push(`<text class="ttl" x="${b.x + 14}" y="${b.y + 24}" fill="${c.text}">${esc(clip(n.label, 16))}</text>`)
    out.push(`<text class="cnt" x="${b.x + b.w - 14}" y="${b.y + 28}" fill="${c.text}" text-anchor="end">${n.files}</text>`)
    out.push(`<text class="sub" x="${b.x + 14}" y="${b.y + 44}" fill="${c.text}">${esc(clip(n.note, 30))}</text>`)
    out.push(`<text class="sub" x="${b.x + 14}" y="${b.y + 58}" fill="${c.text}">${esc(clip(n.samples[0] || '', 30))}</text>`)
    out.push(`<title>${esc(n.label)} · ${n.files} 个文件\n${esc(n.note)}${n.samples.length ? '\n' + esc(n.samples.join('\n')) : ''}</title>`)
    out.push('</g>')
  }

  // 图例（连线颜色 = 证据类型）
  let lx = PAD
  const ly = lay.height - 8
  for (const k of ['import', 'ipc', 'bridge']) {
    out.push(`<g class="archd-legend"><rect x="${lx}" y="${ly - 8}" width="16" height="2" fill="${k === 'ipc' ? '#b07a2a' : k === 'bridge' ? '#2f6f8f' : '#8f88a8'}"/><text x="${lx + 22}" y="${ly - 3}">${KIND_LABEL[k]}（来自源码计数）</text></g>`)
    lx += 150
  }
  out.push('</svg>')
  return out.join('\n')
}

/** 独立 HTML（导出给用户，落到哪里由用户选；方寸自己不往项目仓库写） */
export function renderArchHtml(graph: ArchGraph): string {
  const svg = renderArchSvg(graph)
  const missing = (graph.missing || []).map((m) => `<li><b>${esc(m.what)}</b>：${esc(m.why)}</li>`).join('\n')
  const evidence = (graph.evidence || []).map((e) => `<li>${esc(e)}</li>`).join('\n')
  const nodes = (graph.nodes || [])
    .map((n) => `<li><b>${esc(n.label)}</b> <code>${esc(n.note)}</code> · ${n.files} 个文件${n.samples.length ? '<br><span class="s">' + esc(n.samples.join(' · ')) + '</span>' : ''}</li>`)
    .join('\n')
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(graph.title)}</title>
<style>
:root { --ink:#17181c; --muted:#777b84; --line:#e6e5e2; --bg:#f7f7f5; --card:#fff; }
* { box-sizing: border-box; }
body { margin:0; padding:28px 32px 48px; background:var(--bg); color:var(--ink);
  font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; line-height:1.65; }
h1 { font-size:22px; margin:0 0 4px; }
.sub { color:var(--muted); font-size:12.5px; margin:0 0 14px; }
.text { display:inline-block; font-size:12px; background:#fff; border:1px solid var(--line); border-radius:999px; padding:4px 12px; margin-bottom:16px; }
.panel { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:10px; overflow:auto; }
.cols { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:18px; }
.cols section { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px 16px; }
h2 { font-size:13px; margin:0 0 8px; }
ul { margin:0; padding-left:18px; font-size:12px; color:#3c3f47; }
li { margin:3px 0; }
code { font-family:ui-monospace,Consolas,monospace; font-size:11px; color:var(--muted); }
.s { color:var(--muted); font-size:11px; }
.miss { color:#8a5a00; }
.foot { margin-top:18px; font-size:11.5px; color:var(--muted); }
@media(max-width:900px){ .cols{grid-template-columns:1fr} }
</style></head>
<body>
<h1>${esc(graph.title)}</h1>
<p class="sub">${esc(graph.subtitle)}</p>
<div class="text">${esc(graph.text)}</div>
<div class="panel">${svg}</div>
${missing ? `<div class="cols"><section><h2 class="miss">缺什么（缺不等于没有）</h2><ul>${missing}</ul></section>` : '<div class="cols"><section><h2>缺什么</h2><ul><li>没缺（扫到 package.json / 代码目录 / 入口，连线也有证据）</li></ul></section>'}
<section><h2>证据</h2><ul>${evidence}</ul></section></div>
<div class="cols"><section><h2>组件明细</h2><ul>${nodes}</ul></section>
<section><h2>怎么读这张图</h2><ul>
<li>节点 = 真实存在的目录（数字是扫到的代码文件数），不是"应该有"的模块。</li>
<li>连线 = 目录之间真实的 import / IPC 计数；没有证据的地方不画箭头。</li>
<li>外部依赖只列清单，不猜它们之间的调用关系。</li>
<li>这张图由方寸本地只读扫描生成，没有调用任何模型、没有联网。</li>
</ul></section></div>
<p class="foot">方寸自绘架构图 · ${esc(graph.scannedFiles)} 个文件 · 缺项已如实列出</p>
</body></html>`
}
