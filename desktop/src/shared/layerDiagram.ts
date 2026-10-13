/**
 * 分层架构图 —— **纯函数**（2026-10-13 暮雨定的第二步）。
 *
 * 来源：`docs/小样-微服务架构图-20261012/saas-microservices-architecture.html`。
 * 那份小样的 SVG 是**手写死坐标**（266 个标签），喂不进数据；这里把它收敛成
 * 「**给数据 → 出 SVG 字符串**」，与 `blockers.ts` / `boardCards.ts` 同款布局 ——
 * 算法不埋在组件里，`node` 直跑编译产物就能断言（`scripts/test/e2e-layer-diagram.cjs`）。
 *
 * 硬约束由**构造**保证（正是小样上 `check-arch-geometry.cjs` 量过的那几条）：
 *   ① 图不出 viewBox ② 层与层不重叠 ③ 卡片不出层 ④ 文字不出卡片（按字宽预排，不靠截断糊）
 *
 * 颜色只认**语义名**（`accent` / `ok` / `warn` …，落成 `var(--xxx)`）或 `#rrggbb`；
 * 渲染层负责主题映射 —— 免得与 `check-themes` 打架。不依赖 DOM、不碰 IPC。
 */

export interface LayerCard {
  /** 主标签（卡片正文） */
  label: string
  /** 次标签（小字，可省） */
  sub?: string
}
export interface LayerLane {
  /** 层名 */
  name: string
  /** 英文副标签（可省） */
  sub?: string
  /** 语义色名或 `#rrggbb`；缺省按内置色板轮转 */
  color?: string
  cards: LayerCard[]
}
export interface LayerDiagramSpec {
  lanes: LayerLane[]
  /** 层间协议标注：`between[i]` 画在 `lanes[i]` 与 `lanes[i+1]` 之间 */
  between?: string[]
  /** 整图宽度（px），高度自动 */
  width?: number
  /** 图标题（可省） */
  caption?: string
}

/** 内置色板：**只放 App.vue 里真实存在的语义令牌名**（`--accent` / `--success` / `--warning` /
 *  `--danger` / `--muted`）。⚠ 曾用 `--ok` / `--warn` / `--info` —— 方寸主题里根本没定义这三个，
 *  渲染出来是**全黑**（SVG 拿不到变量就回退默认色）。守卫 `e2e-layer-diagram` 会对着 App.vue
 *  逐个复核这些名字，改名不同步会当场红。 */
export const PALETTE = ['accent', 'success', 'warning', 'danger', 'muted'] as const

// —— 几何常量（改这里就够了）——
const PAD = 24          // 画布内边距
const LANE_TITLE_H = 30 // 层标题带高度
const LANE_V_PAD = 8    // 卡片区上下留白
const LANE_H_PAD = 14   // 卡片区左右留白
const CARD_H = 46
const CARD_GAP = 12
const BETWEEN_H = 40    // 层间协议带高度
const CARD_MIN_W = 96
const CARD_PAD = 12
const FS_CARD = 13
const FS_SUB = 11
const FS_LANE = 13
const CAPTION_H = 24

/**
 * 字宽估算：CJK / 全角 ≈ 1em，ASCII ≈ 0.55em。
 * 这是「文字不出卡片」这条硬约束的**唯一依据** —— 估不准宁可把卡片排宽一点。
 */
export function estimateTextWidth(s: string, fontSize: number): number {
  let w = 0
  for (const ch of String(s == null ? '' : s)) {
    const c = ch.codePointAt(0) || 0
    // 0x2E7F 之上基本是 CJK / 全角标点 / 全角字母
    w += (c > 0x2e7f ? 1.0 : 0.55) * fontSize
  }
  return w
}

/** XML 转义（`&` 必须第一个换，否则会把后换进去的实体再转一遍）。 */
function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 语义名 → `var(--name)`；`#rrggbb` / `#rgb` 原样返回。 */
function resolveColor(c: string | undefined, idx: number): string {
  const name = String(c || PALETTE[idx % PALETTE.length])
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(name) ? name : `var(--${name})`
}

/** 一张卡片在给定宽度下所需的**最小**宽度（正文与副标签各算一遍，取大者）。
 *  导出给断言用 —— 「文字不出卡片」这条硬约束得能独立复算，不能只信实现。 */
export function minCardWidth(c: LayerCard): number {
  const lw = estimateTextWidth(c.label, FS_CARD)
  const sw = c.sub ? estimateTextWidth(c.sub, FS_SUB) : 0
  return Math.max(CARD_MIN_W, Math.ceil(Math.max(lw, sw)) + CARD_PAD * 2)
}

interface LaneLayout {
  lane: LayerLane
  color: string
  cols: number
  rows: number
  cardW: number
  height: number
}

/**
 * 生成分层架构图 SVG。
 *
 * @throws 当 `lanes` 为空 —— 静默返回空串会让调用方以为"画好了"，宁可抛。
 */
export function buildLayerDiagram(spec: LayerDiagramSpec): string {
  const lanes = (spec && spec.lanes) || []
  if (!lanes.length) throw new Error('buildLayerDiagram: lanes 不能为空')

  const children: string[] = []
  const captionH = spec.caption ? CAPTION_H : 0
  let y = PAD + captionH
  const layouts: LaneLayout[] = []

  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]
    const color = resolveColor(lane.color, i)
    const innerW = (spec.width || 680) - PAD * 2
    const cardAreaW = innerW - LANE_H_PAD * 2

    // 一层内所有卡片的最宽需求 —— 用它决定列数，列数一确定，卡片宽度必 >= 需求（见下方证明式）
    const laneReq = lane.cards.reduce((m, c) => Math.max(m, minCardWidth(c)), CARD_MIN_W)
    let cols = Math.max(1, Math.floor((cardAreaW + CARD_GAP) / (laneReq + CARD_GAP)))
    cols = Math.min(cols, Math.max(1, lane.cards.length))
    if (!lane.cards.length) cols = 1
    const rows = Math.max(1, Math.ceil(lane.cards.length / cols))
    // cols*(laneReq+gap) <= cardAreaW+gap  ⇒  cardW = (cardAreaW-(cols-1)gap)/cols >= laneReq
    const cardW = (cardAreaW - (cols - 1) * CARD_GAP) / cols

    const contentH = rows * CARD_H + (rows - 1) * CARD_GAP
    const height = LANE_TITLE_H + LANE_V_PAD * 2 + contentH
    layouts.push({ lane, color, cols, rows, cardW, height })

    // ── 层底板 ──
    children.push(
      `<rect x="${PAD}" y="${y}" width="${innerW}" height="${height}" rx="10" ` +
      `fill="${color}" fill-opacity="0.06" stroke="${color}" stroke-opacity="0.45" />`
    )
    // ── 层标题带 ──
    children.push(
      `<rect x="${PAD}" y="${y}" width="${innerW}" height="${LANE_TITLE_H}" rx="10" fill="${color}" fill-opacity="0.16" />`
    )
    children.push(
      `<text x="${PAD + 12}" y="${y + LANE_TITLE_H * 0.68}" font-size="${FS_LANE}" font-weight="700" ` +
      `fill="${color}">${esc(lane.name)}</text>`
    )
    if (lane.sub) {
      children.push(
        `<text x="${PAD + innerW - 12}" y="${y + LANE_TITLE_H * 0.68}" text-anchor="end" font-size="${FS_SUB}" ` +
        `fill="${color}" fill-opacity="0.85">${esc(lane.sub)}</text>`
      )
    }
    // ── 卡片 ──
    const cardTop0 = y + LANE_TITLE_H + LANE_V_PAD
    for (let n = 0; n < lane.cards.length; n++) {
      const r = Math.floor(n / cols)
      const c = n % cols
      const cx = PAD + LANE_H_PAD + c * (cardW + CARD_GAP)
      const cy = cardTop0 + r * (CARD_H + CARD_GAP)
      const card = lane.cards[n]
      children.push(
        `<rect x="${cx.toFixed(1)}" y="${cy}" width="${cardW.toFixed(1)}" height="${CARD_H}" rx="8" ` +
        `fill="var(--card)" stroke="${color}" stroke-opacity="0.55" />`
      )
      const labelY = card.sub ? cy + CARD_H * 0.42 : cy + CARD_H * 0.58
      children.push(
        `<text x="${(cx + CARD_PAD).toFixed(1)}" y="${labelY.toFixed(1)}" font-size="${FS_CARD}" ` +
        `fill="var(--ink)">${esc(card.label)}</text>`
      )
      if (card.sub) {
        children.push(
          `<text x="${(cx + CARD_PAD).toFixed(1)}" y="${(cy + CARD_H * 0.76).toFixed(1)}" font-size="${FS_SUB}" ` +
          `fill="var(--muted)">${esc(card.sub)}</text>`
        )
      }
    }

    y += height
    // ── 层间协议带 ──
    if (i < lanes.length - 1) {
      const label = (spec.between && spec.between[i]) || ''
      children.push(
        `<line x1="${PAD}" y1="${y + BETWEEN_H / 2}" x2="${(spec.width || 680) - PAD}" y2="${y + BETWEEN_H / 2}" ` +
        `stroke="var(--border)" stroke-width="1" stroke-dasharray="4 4" />`
      )
      if (label) {
        const cx = (spec.width || 680) / 2
        const tw = estimateTextWidth(label, FS_SUB)
        children.push(
          `<rect x="${(cx - tw / 2 - 8).toFixed(1)}" y="${(y + BETWEEN_H / 2 - 10).toFixed(1)}" ` +
          `width="${(tw + 16).toFixed(1)}" height="20" rx="10" fill="var(--card)" stroke="var(--border)" />`
        )
        children.push(
          `<text x="${cx.toFixed(1)}" y="${(y + BETWEEN_H / 2 + 4).toFixed(1)}" text-anchor="middle" ` +
          `font-size="${FS_SUB}" fill="var(--muted)">${esc(label)}</text>`
        )
      }
      y += BETWEEN_H
    }
  }

  const totalH = y + PAD
  const totalW = spec.width || 680
  const head = spec.caption
    ? `<text x="${PAD}" y="${PAD + 16}" font-size="${FS_LANE}" font-weight="700" fill="var(--ink)">${esc(spec.caption)}</text>`
    : ''
  const aria = esc(spec.caption || `${lanes.length} 层架构图`)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${Math.ceil(totalH)}" ` +
    `width="100%" role="img" aria-label="${aria}" font-family="inherit">` +
    head +
    children.join('') +
    `</svg>`
  )
}
