/**
 * 分层架构图纯函数 端到端（2026-10-13 暮雨第 2 步）
 *
 * 真跑编译产物 `desktop/dist/shared/layerDiagram.js` —— **不依赖 electron、不依赖 DOM**
 * （纯函数布局，与 `blockers.ts` / `boardCards.ts` 同款）。
 *
 * 判据全是**构造级硬约束**（就是小样上 `check-arch-geometry.cjs` 量过的那几条）：
 *   ① 图不出 viewBox ② 层与层不重叠 ③ 卡片不出层 ④ 文字不出卡片（按字宽复算）⑤ XML 转义
 *
 * 运行：node scripts/test/e2e-layer-diagram.cjs
 */
const path = require('path')
const fs = require('fs')

const DIST = path.resolve(__dirname, '../../desktop/dist/shared/layerDiagram.js')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

const ATTR = (tag, k) => {
  const m = new RegExp(k + '="([^"]*)"').exec(tag)
  return m ? m[1] : null
}
const rectsOf = (svg) => (svg.match(/<rect [^>]*\/>/g) || []).map((t) => ({
  tag: t, x: +ATTR(t, 'x'), y: +ATTR(t, 'y'), w: +ATTR(t, 'width'), h: +ATTR(t, 'height'),
  fillOpacity: ATTR(t, 'fill-opacity'),
}))
const laneRects = (svg) => rectsOf(svg).filter((r) => r.fillOpacity === '0.06')
const cardRects = (svg) => rectsOf(svg).filter((r) => Math.abs(r.h - 46) < 0.01)
const inside = (a, b) => a.x >= b.x - 0.01 && a.y >= b.y - 0.01 &&
  a.x + a.w <= b.x + b.w + 0.01 && a.y + a.h <= b.y + b.h + 0.01

function main() {
  console.log('== 分层架构图纯函数 e2e ==')
  const mod = require(DIST)
  const { buildLayerDiagram, estimateTextWidth, minCardWidth } = mod

  check('导出三个面向（buildLayerDiagram / estimateTextWidth / minCardWidth / PALETTE）',
    typeof buildLayerDiagram === 'function' && typeof estimateTextWidth === 'function' && typeof minCardWidth === 'function'
    && Array.isArray(mod.PALETTE))

  // ① 空输入必须**抛**，不许静默回空串（静默 = 调用方以为画好了）
  let threw = false
  try { buildLayerDiagram({ lanes: [] }) } catch { threw = true }
  check('★ lanes 为空 → 抛错（不是静默返回空串）', threw)

  // ② 字宽估算：CJK 比 ASCII 宽
  check('字宽估算：一个汉字宽于一个 ASCII 字母',
    estimateTextWidth('中', 13) > estimateTextWidth('a', 13) * 1.5,
    `${estimateTextWidth('中', 13)} vs ${estimateTextWidth('a', 13)}`)

  const W = 680
  const spec = {
    width: W,
    caption: '示例架构',
    lanes: [
      { name: '客户端层', sub: 'CLIENT', color: 'accent', cards: [
        { label: 'Web App' }, { label: '移动端' }, { label: '桌面端' }, { label: 'Open API' }] },
      { name: '核心服务层', sub: 'CORE', color: 'success', cards: [
        { label: '用户', sub: 'user' }, { label: '订单', sub: 'order' }, { label: '支付', sub: 'pay' },
        { label: '商品', sub: 'item' }, { label: '通知', sub: 'notify' }, { label: '搜索', sub: 'search' },
        { label: '一个特别特别长的服务名字用来逼出折行', sub: 'long' }] },
      { name: '基础设施层', sub: 'INFRA', color: '#88aacc', cards: [
        { label: 'PostgreSQL' }, { label: 'Redis' }, { label: 'RabbitMQ' }] },
    ],
    between: ['HTTP / WSS', 'TCP / Redis / AMQP'],
  }
  const svg = buildLayerDiagram(spec)

  check('★ 输出是可独立渲染的 <svg>（带 xmlns + viewBox + role=img）',
    svg.startsWith('<svg ') && svg.indexOf('xmlns="http://www.w3.org/2000/svg"') > 0
    && /viewBox="0 0 680 \d+"/.test(svg) && svg.includes('role="img"'))
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)
  const vw = +vb[1]
  const vh = +vb[2]
  check('★ viewBox 宽度等于传入 width', vw === W, `${vw} vs ${W}`)

  const lanes = laneRects(svg)
  const cards = cardRects(svg)
  const totalCards = spec.lanes.reduce((n, l) => n + l.cards.length, 0)
  check('层底板数 = spec.lanes.length', lanes.length === spec.lanes.length, `${lanes.length}`)
  check('★★ 卡片数 = Σ spec 卡片数（一张不丢也不多）', cards.length === totalCards,
    `${cards.length} vs ${totalCards}`)

  // ③ 图不出 viewBox（所有 rect 都在框内）
  const outside = rectsOf(svg).filter((r) => r.x < -0.01 || r.y < -0.01 || r.x + r.w > vw + 0.01 || r.y + r.h > vh + 0.01)
  check('★★ 所有 rect 都在 viewBox 内（图不溢出）', outside.length === 0,
    JSON.stringify(outside.slice(0, 3).map((r) => [r.x, r.y, r.w, r.h])))

  // ② 层与层不重叠（按 y 区间）
  const sorted = lanes.slice().sort((a, b) => a.y - b.y)
  let overlap = false
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y < sorted[i - 1].y + sorted[i - 1].h - 0.01) overlap = true
  }
  check('★★ 层与层不重叠（按 y 区间严格递增）', !overlap)

  // 每张卡片**恰好**落在一个层底板内
  let uncontained = 0
  let multi = 0
  const cardsPerLane = new Map()
  for (const c of cards) {
    const owners = lanes.filter((l) => inside(c, l))
    if (owners.length === 0) uncontained++
    if (owners.length > 1) multi++
    if (owners.length === 1) cardsPerLane.set(owners[0], (cardsPerLane.get(owners[0]) || 0) + 1)
  }
  check('★★ 每张卡片都落在某个层底板内（卡片不出层）', uncontained === 0, `${uncontained} 张在外`)
  check('★ 没有卡片横跨两层（归属唯一）', multi === 0, `${multi} 张跨层`)
  check('★ 每层卡片数 = spec 里那一层写了几张',
    sorted.every((l) => cardsPerLane.get(l) !== undefined) &&
    sorted.reduce((n, l) => n + (cardsPerLane.get(l) || 0), 0) === totalCards)

  // ④ 文字不出卡片：卡片宽 >= 该层最大 minCardWidth（按字宽独立复算）
  const laneOrder = lanes.slice().sort((a, b) => a.y - b.y)
  let tooNarrow = []
  laneOrder.forEach((lr, i) => {
    const inLane = cards.filter((c) => inside(c, lr))
    if (!inLane.length) return
    const w = inLane[0].w
    const need = spec.lanes[i].cards.reduce((m, c) => Math.max(m, minCardWidth(c)), 0)
    if (w + 0.5 < need) tooNarrow.push({ lane: spec.lanes[i].name, w, need })
  })
  check('★★ 卡片宽度 >= 文字所需（按字宽复算，文字不出卡片）', tooNarrow.length === 0,
    JSON.stringify(tooNarrow))

  // ⑤ 折行：核心层 7 张卡 + 一张超长名 → 必然多行（层高 > 单行所需）
  const singleRowH = 30 + 8 * 2 + 46
  check('★ 卡片多/名字长时自动折行（层高超过单行）',
    laneOrder.some((l) => l.h > singleRowH + 1),
    JSON.stringify(laneOrder.map((l) => l.h)))

  // ⑥ 层间协议标签
  check('★ 层间协议标注都画出来了', svg.includes('HTTP / WSS') && svg.includes('TCP / Redis / AMQP'))
  check('  caption 出现在图里', svg.includes('示例架构'))

  // ⑦ 颜色：语义名走 var(--x)，#rrggbb 原样
  check('★ 语义色名落成 var(--accent) / var(--success)', svg.includes('var(--accent)') && svg.includes('var(--success)'))
  check('★ 十六进制色原样保留（#88aacc）', svg.includes('#88aacc'))

  // ⑦b 色板里的每个语义名都必须是 App.vue 里**真实存在的 CSS 变量**。
  //     ⚠ 这条是补的：第一版色板写了 `--ok` / `--warn` / `--info`，而方寸主题只定义
  //     `--success` / `--warning` —— SVG 拿不到变量就回退默认色，整张图变黑，但断言全绿。
  {
    const appVue = fs.readFileSync(path.resolve(__dirname, '../../desktop/src/renderer/App.vue'), 'utf-8')
    const missing = (mod.PALETTE || []).filter((name) => !new RegExp('--' + name + '\\s*:').test(appVue))
    check('★★ 色板里的语义名都能在 App.vue 找到同名 CSS 变量（否则 SVG 变黑、断言却全绿）',
      Array.isArray(mod.PALETTE) && mod.PALETTE.length > 0 && missing.length === 0,
      'missing=' + JSON.stringify(missing) + ' palette=' + JSON.stringify(mod.PALETTE))
  }

  // ⑧ 转义：标签里的元字符不许裸着进 SVG
  const nasty = buildLayerDiagram({
    lanes: [{ name: '层<&>', color: 'accent', cards: [{ label: 'a<b>&"c\'', sub: 'x&y' }] }],
  })
  check('★★ 标签里的 < > & " \' 全部被转义（没有裸 <b>）',
    nasty.indexOf('<b>') < 0 && nasty.includes('&lt;b&gt;') && nasty.includes('&amp;') && nasty.includes('&quot;'))
  check('★ 转义顺序正确（&amp; 没有被二次转义成 &amp;amp;）',
    nasty.indexOf('&amp;amp;') < 0)

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) { console.log('\n失败项：'); for (const f of failures) console.log(' -', f) }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
