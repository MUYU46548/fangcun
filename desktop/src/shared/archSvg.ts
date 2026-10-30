/**
 * 方寸自绘架构图 —— SVG / 独立 HTML 渲染（纯函数，2026-10-30）
 *
 * 2026-10-30 暮雨第 3 条（「质量极差，无实战意义」）后重做：
 *   · **分层带**：界面 / 桥 / 主进程 / 共享 / 外部依赖各占一条横带，层名写在左边；
 *   · **正交连线**：相邻层直接上下走；跨层走右侧（向下）或左侧（向上）的专用通道，
 *     不再让贝塞尔曲线从方块中间穿过去；
 *   · **标签不糊**：只给"值得读"的连线写标签（IPC / 桥 / ≥3 条的 import），
 *     文字带白描边（paint-order: stroke），压在线上也读得清；
 *   · 一切坐标仍由**行序 + 序号**算出来（不量 DOM），Node 里能直接断言。
 *
 * 交互（不联网、不引第三方）：
 *  · 点节点 → 高亮它相关的连线，其余变淡（同一份 SVG 里用 class 切）；
 *  · `<title>` 给悬停提示；证据列在 `renderArchHtml` 里逐条列出。
 */

import { rowLabel, rowOfNode, type ArchGraph, type ArchNode } from './archGraph'

const BOX_W = 214
const BOX_H = 64
const GAP_X = 24
const GAP_Y = 122
const PAD = 26
/** 左侧分层带宽度 */
const BAND_W = 96
/** 左右通道（跨层连线走这里，避免穿过方块） */
const GUTTER = 34

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
  /** 每条横带的几何（画带子 + 校验"层是满的"用） */
  bands: Array<{ row: number; label: string; x: number; y: number; w: number; h: number }>
}

/** 布局（纯算术）：行内均分；左侧留出分层带；跨层通道在内容区两侧。 */
export function layoutArch(graph: ArchGraph): ArchLayout {
  const rows = groupRows(graph)
  const maxCount = rows.reduce((m, r) => Math.max(m, r.nodes.length), 1)
  const contentW = maxCount * BOX_W + Math.max(0, maxCount - 1) * GAP_X
  const width = Math.max(980, BAND_W + GUTTER * 2 + contentW)
  const contentX = BAND_W + GUTTER
  const innerW = width - contentX - GUTTER
  const boxes: ArchLayout['boxes'] = []
  const bands: ArchLayout['bands'] = []
  rows.forEach((r, ri) => {
    const n = r.nodes.length
    const total = n * BOX_W + (n - 1) * GAP_X
    const startX = contentX + Math.max(0, (innerW - total) / 2)
    const top = PAD + ri * GAP_Y
    bands.push({ row: r.row, label: rowLabel(r.row), x: 8, y: top - 22, w: BAND_W - 8, h: BOX_H + 44 })
    r.nodes.forEach((node, i) => {
      boxes.push({ node, x: startX + i * (BOX_W + GAP_X), y: top, w: BOX_W, h: BOX_H })
    })
  })
  const byId: ArchLayout['byId'] = {}
  for (const b of boxes) byId[b.node.id] = { x: b.x, y: b.y, w: b.w, h: b.h }
  const height = PAD * 2 + Math.max(1, rows.length) * GAP_Y + 10
  return { width, height, boxes, byId, bands }
}

type Box = { x: number; y: number; w: number; h: number }

/**
 * 正交连线。三种走法：
 *   ① 相邻层（上下只差一条带）：下 → 上，直接在带间空隙里折一下；
 *   ② 同层：右侧通道绕过去（不压同层方块）；
 *   ③ 跨层（向下）：右侧通道；跨层向上：左侧通道。
 * 返回路径 + 标签落点，供 SVG 与校验共用。
 */
function edgeRoute(a: Box, b: Box, width: number): { d: string; lx: number; ly: number; anchor: 'start' | 'middle' | 'end' } {
  const sameRow = Math.abs(a.y - b.y) < 4
  const ax = a.x + a.w / 2
  const bx = b.x + b.w / 2
  if (sameRow) {
    const gx = width - GUTTER / 2
    const sy = a.y + a.h / 2
    const ey = b.y + b.h / 2
    return {
      d: `M ${a.x + a.w} ${sy} L ${gx} ${sy} L ${gx} ${ey} L ${b.x + b.w} ${ey}`,
      lx: gx - 8, ly: (sy + ey) / 2 - 4, anchor: 'end',
    }
  }
  const down = b.y > a.y
  const gap = down ? b.y - (a.y + a.h) : a.y - (b.y + b.h)
  if (gap > 0 && gap <= GAP_Y - BOX_H + 8) {
    // 相邻层：中间横移一段，短、清楚
    const sy = down ? a.y + a.h : a.y
    const ey = down ? b.y : b.y + b.h
    const midY = down ? sy + gap / 2 : sy - gap / 2
    return {
      d: `M ${ax} ${sy} L ${ax} ${midY} L ${bx} ${midY} L ${bx} ${ey}`,
      lx: (ax + bx) / 2, ly: midY - 5, anchor: 'middle',
    }
  }
  // 跨层：一律走**右侧**通道（2026-10-30 视觉返工：左侧是分层带，标签会压在层名上）。
  // 横向段放在**分层带之外**（带底 +30 / 带顶 -30），否则线会从层名上横穿过去。
  const gx = width - GUTTER / 2
  const sy = down ? a.y + a.h + 30 : a.y - 30
  const ey = down ? b.y - 30 : b.y + b.h + 30
  return {
    d: `M ${ax} ${down ? a.y + a.h : a.y} L ${ax} ${sy} L ${gx} ${sy}` +
      ` L ${gx} ${ey} L ${bx} ${ey} L ${bx} ${down ? b.y : b.y + b.h}`,
    lx: gx - 8,
    ly: (sy + ey) / 2,
    anchor: 'end',
  }
}

const COLORS: Record<string, { fill: string; stroke: string; text: string; accent: string }> = {
  entry: { fill: '#17181c', stroke: '#17181c', text: '#ffffff', accent: '#17181c' },
  layer: { fill: '#ffffff', stroke: '#c9c6d6', text: '#17181c', accent: '#6b5bb5' },
  shared: { fill: '#f6f4fb', stroke: '#b9b3d0', text: '#3c3f47', accent: '#8f80c9' },
  external: { fill: '#fbfbfa', stroke: '#d8d5cf', text: '#6b6f78', accent: '#b8b3a8' },
}

const KIND_LABEL: Record<string, string> = {
  import: 'import',
  ipc: 'IPC',
  bridge: '桥',
}
const STROKE: Record<string, string> = {
  import: '#8f88a8',
  ipc: '#b07a2a',
  bridge: '#2f6f8f',
}

/** 连线标签要不要显示（导入太密时只显示 ≥5 的；IPC/桥永远显示） */
export function shouldShowEdgeLabel(kind: string, count: number, active = ''): boolean {
  if (active) return true
  if (kind === 'ipc' || kind === 'bridge') return true
  return count >= 5
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
.archd-band { fill: #f7f6fb; stroke: #eceaf3; stroke-width: 1; }
.archd-band.alt { fill: #fcfbf8; stroke: #f0ede6; }
.archd-band-label { font-size: 11px; font-weight: 700; fill: #8b8598; letter-spacing: .04em; }
.archd-edge path { fill: none; stroke: #b6b1c7; stroke-width: 1.5; opacity: .88; stroke-linejoin: round; }
.archd-edge.import path { stroke: #8f88a8; }
.archd-edge.ipc path { stroke: #b07a2a; stroke-dasharray: 5 3; }
.archd-edge.bridge path { stroke: #2f6f8f; stroke-dasharray: 2 3; }
.archd-edge.on path { stroke-width: 2.8; opacity: 1; }
.archd-edge.dim { opacity: .1; }
.archd-edge-label { font-size: 9.5px; fill: #7d7889; paint-order: stroke; stroke: #fff; stroke-width: 3px; stroke-linejoin: round; }
.archd-edge.on .archd-edge-label { fill: #3c3f47; }
.archd-node { cursor: pointer; }
.archd-node .box { stroke-width: 1.2; transition: filter .15s; }
.archd-node:hover .box { filter: drop-shadow(0 2px 6px rgba(40, 40, 70, .18)); }
.archd-node.on .box { stroke: #6b5bb5; stroke-width: 2.2; }
.archd-node.dim { opacity: .32; }
.archd-node .ttl { font-size: 12.5px; font-weight: 700; }
.archd-node .sub { font-size: 10px; opacity: .75; }
.archd-node .cnt { font-size: 20px; font-weight: 700; letter-spacing: -.02em; }
.archd-node .kindbar { rx: 2; }
.archd-legend text { font-size: 10px; fill: #7d7889; }
</style>`)
  out.push('<defs>' + ['import', 'ipc', 'bridge'].map((k) =>
    `<marker id="archd-arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${STROKE[k]}"/></marker>`,
  ).join('') + '</defs>')

  // 分层带（先画，压在最底下）：让"从上到下 = 从界面到内核"一眼看得出来
  for (let i = 0; i < lay.bands.length; i++) {
    const band = lay.bands[i]
    out.push(`<g class="archd-band-g" data-band="${band.row}">`)
    out.push(`<rect class="archd-band${i % 2 ? ' alt' : ''}" x="${band.x}" y="${band.y}" width="${band.w}" height="${band.h}" rx="12"/>`)
    out.push(`<text class="archd-band-label" x="${band.x + 14}" y="${band.y + 26}">${esc(band.label)}</text>`)
    out.push(`</g>`)
  }

  // 先画边（节点压在上面）
  for (const e of graph.edges || []) {
    const a = lay.byId[e.from]
    const b = lay.byId[e.to]
    if (!a || !b) continue
    const route = edgeRoute(a, b, lay.width)
    const hot = !!opts.active && (e.from === opts.active || e.to === opts.active)
    const cls = ['archd-edge', e.kind, hot ? 'on' : '', opts.active && !hot ? 'dim' : ''].filter(Boolean).join(' ')
    out.push(`<g class="${cls}" data-edge="${esc(e.from)}-${esc(e.to)}">`)
    out.push(`<path d="${route.d}" marker-end="url(#archd-arrow-${e.kind})"><title>${esc(e.label)}${e.samples && e.samples.length ? '\n' + esc(e.samples.join('\n')) : ''}</title></path>`)
    if (shouldShowEdgeLabel(e.kind, e.count, opts.active)) {
      const text = e.kind === 'import' ? `import ×${e.count}` : e.kind === 'ipc' ? `IPC ×${e.count}` : `桥 ×${e.count}`
      out.push(`<text class="archd-edge-label" x="${route.lx}" y="${route.ly}" text-anchor="${route.anchor}">${esc(text)}</text>`)
    }
    out.push('</g>')
  }

  for (const b of lay.boxes) {
    const n = b.node
    const c = COLORS[n.kind] || COLORS.layer
    const hot = opts.active === n.id
    const cls = ['archd-node', hot ? 'on' : '', opts.active && !hot ? 'dim' : ''].filter(Boolean).join(' ')
    out.push(`<g class="${cls}" data-node="${esc(n.id)}">`)
    out.push(`<rect class="box" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="12" fill="${c.fill}" stroke="${c.stroke}"/>`)
    // 左侧 3px 色条 = 层级身份（入口/共享/外部一眼分得开）
    out.push(`<rect class="kindbar" x="${b.x}" y="${b.y + 12}" width="3" height="${b.h - 24}" fill="${c.accent}"/>`)
    out.push(`<text class="ttl" x="${b.x + 14}" y="${b.y + 24}" fill="${c.text}">${esc(clip(n.label, 12))}</text>`)
    out.push(`<text class="cnt" x="${b.x + b.w - 14}" y="${b.y + 28}" fill="${c.text}" text-anchor="end">${n.files}</text>`)
    out.push(`<text class="sub" x="${b.x + 14}" y="${b.y + 44}" fill="${c.text}">${esc(clip(n.note, 28))}</text>`)
    out.push(`<text class="sub" x="${b.x + 14}" y="${b.y + 58}" fill="${c.text}">${esc(clip(n.samples[0] || '', 28))}</text>`)
    out.push(`<title>${esc(n.label)} · ${n.files} 个文件\n${esc(n.note)}${n.samples.length ? '\n' + esc(n.samples.join('\n')) : ''}</title>`)
    out.push('</g>')
  }

  // 图例（连线颜色 = 证据类型 + 方向说明）
  let lx = BAND_W + GUTTER
  const ly = lay.height - 12
  for (const k of ['import', 'ipc', 'bridge']) {
    out.push(`<g class="archd-legend"><rect x="${lx}" y="${ly - 8}" width="16" height="2" fill="${STROKE[k]}"/><text x="${lx + 22}" y="${ly - 3}">${KIND_LABEL[k]}（来自源码计数）</text></g>`)
    lx += 150
  }
  out.push(`<g class="archd-legend"><text x="${lay.width - GUTTER}" y="${ly - 3}" text-anchor="end">从上到下 = 从界面到内核</text></g>`)
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
<li>层名只是按目录路径归类（renderer / preload / main / shared），不是猜出来的调用关系。</li>
<li>外部依赖只列清单，不猜它们之间的调用关系。</li>
<li>这张图由方寸本地只读扫描生成，没有调用任何模型、没有联网。</li>
</ul></section></div>
<p class="foot">方寸自绘架构图 · ${esc(graph.scannedFiles)} 个文件 · 缺项已如实列出</p>
</body></html>`
}
