/**
 * 层厚度 · 纯逻辑（2026-11-16）
 *
 * 由来：暮雨 2026-11-15 深夜 ——「骨架补齐以后，规划会自己长出来」。
 * 他给的判断是：**方寸唯一比人强的地方是跨项目横着比**。所以这一层的产出不是
 * "这个项目有哪些模块"（目录里自己看得见），而是两句话：
 *
 *   ① 单项目：**号称是 A，但 88% 的行数在 B**
 *   ② 横比：  十几个项目放一起，谁在写业务、谁在写测试、谁在堆素材
 *
 * ⚠ 为什么算法在这里而不在组件里 / 主进程里：
 * 本仓的规矩（`blockers.ts` / `boardCards.ts` 同款）——**算法不埋在组件里**，
 * `node` 直跑编译产物就能断言。行数这种事最怕"看起来对"。
 *
 * ⚠ 口径来自 2026-11-16 命令行版首跑踩到的五个坑（每个都让数变成假数，
 * 而报告看起来完全正常）：
 *   ① 浏览器 profile（隔壁同类产品 `.test-edge-profile-3d` = 287 万行）撑爆分母
 *   ② 拿全仓当分母 → 剩下 90% 是测试，不是"这层薄"
 *   ③ 打包产物 / 内嵌 Python 运行时被当产品代码（方寸 36 万、另一款产品 31.9 万）
 *   ④ `.ts` 既是 TypeScript 也是 MPEG 视频分片
 *   ⑤ 只认 UTF-8 会把 GBK 脚本当二进制丢掉（某项目 31 行 → 0 行）
 * 这些口径**每条都在这里有对应实现**，且 `e2e-layer-profile` 逐条钉住。
 */

/** 层在"产品 / 测试 / 工具"里的归属。判据是**目录名**，不是文件内容 —— 这一点必须写进界面。 */
export type LayerRole = '产品' | '测试' | '工具'

export interface LayerRow {
  layer: string
  role: LayerRole
  files: number
  lines: number
}

export interface LayerNamed {
  name: string
  lines: number
  files: number
  /** 命中的文件样例（界面上点开看"这层到底算进了什么"） */
  sample: string[]
  note: string
}

export interface LayerGroup {
  name: string
  lines: number
  members: string[]
  /** spec 点了名、但一层都没扫到的成员 —— 不是"它是 0"，是"名字对不上" */
  missing: string[]
}

/** 项目自己的「声称的分层」。**口径必须人给**，脚本不替人决定哪层叫什么。 */
export interface LayerSpec {
  source?: string
  layers: Record<string, { paths: string[]; note?: string }>
  groups?: Record<string, string[]>
  claims?: Record<string, number>
  claimsNote?: string
  /** 通用规则猜不到的排除项（例：quartz 的 `public/` 是生成的站点） */
  exclude?: string[]
}

export interface SkippedDir {
  dir: string
  why: string
  nested?: boolean
}

export interface BadFile {
  file: string
  why: string
}

export interface LayerProfile {
  ok: boolean
  id: string
  name: string
  repo: string
  /** 扫到多少文本行 / 多少文件（**平方米是体量，不是质量**） */
  totalLines: number
  totalFiles: number
  /** 按目录聚合的层（depth 齿深） */
  rows: LayerRow[]
  /** 按 spec 声称的分层聚合 */
  named: LayerNamed[]
  /** spec 给的大块（生成器 / 编辑器 / …） */
  groups: LayerGroup[]
  /** 一句话结论 —— 这个模块存在的理由 */
  verdict: string
  /** 读不动 / 不是文本 / 被规则挡掉的，逐条给原因（不许静默改分母） */
  unreadable: BadFile[]
  nonText: BadFile[]
  skipped: SkippedDir[]
  specSource: string
  claims: Record<string, number>
  claimsNote: string
  /** 对账结果：声称 vs 实测 */
  claimRows: { name: string; claim: number; got: number | null }[]
  /** 读不到时的原因（仓库不在 / 没登记）——那时**所有数字都是 undefined，不是 0** */
  missing: string
  note: string
}

const TEST_DIR_NAMES = new Set(['test', 'tests', 'spec', 'specs', '__tests__', 'e2e'])
const TOOL_DIR_NAMES = new Set(['scripts', 'tools', 'tooling', 'dev-scripts'])

/** 把层粗分三类。**按目录名**，不按内容 —— 项目若把测试放 `src/` 就会算进产品。 */
export function roleOf(layer: string): LayerRole {
  const parts = String(layer || '').toLowerCase().split('/')
  if (parts.some((p) => TEST_DIR_NAMES.has(p))) return '测试'
  if (parts.some((p) => TOOL_DIR_NAMES.has(p))) return '工具'
  return '产品'
}

/** 齿到 depth 段。不足 depth 段就用父目录全路径；根下文件记 `(根)`。 */
export function layerOf(rel: string, depth: number): string {
  const segs = String(rel || '').replace(/\\/g, '/').split('/')
  if (segs.length === 1) return '(根)'
  if (segs.length - 1 <= depth) return segs.slice(0, -1).join('/')
  return segs.slice(0, depth).join('/')
}

/** 按目录层聚合逐文件行数。 */
export function groupLayers(recs: [string, number][], depth: number): LayerRow[] {
  const map = new Map<string, { files: number; lines: number }>()
  for (const [rel, n] of recs) {
    const layer = layerOf(rel, depth)
    const cur = map.get(layer) || { files: 0, lines: 0 }
    cur.files += 1
    cur.lines += n
    map.set(layer, cur)
  }
  const rows: LayerRow[] = []
  for (const [layer, v] of map) {
    rows.push({ layer, role: roleOf(layer), files: v.files, lines: v.lines })
  }
  rows.sort((a, b) => (b.lines - a.lines) || a.layer.localeCompare(b.layer))
  return rows
}

/**
 * 路径匹配：以 `/` 结尾 = 目录前缀；含 `*` / `?` = 通配；否则目录前缀或整文件相等。
 *
 * ⚠ 这条踩过一次：第一版只认"整文件相等"，于是 spec 写 `utils/terrain`（少个 `*`）时
 * 生成器整层扫到 **0 个文件** —— 而报告上"0 行"和"这层真的没代码"长得一模一样。
 */
export function matchPath(rel: string, pats: string[]): boolean {
  const r = String(rel || '').replace(/\\/g, '/')
  for (const raw of pats || []) {
    const p = String(raw || '')
    if (!p) continue
    if (p.includes('*') || p.includes('?')) {
      // 极简 glob：`*` 不跨 `/`，`**` 跨 —— 够用且不引依赖
      const re = new RegExp('^' + p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*')
        .replace(/\?/g, '[^/]') + '$')
      if (re.test(r)) return true
      continue
    }
    const q = p.replace(/\/+$/, '')
    if (r === q || r.startsWith(q + '/')) return true
  }
  return false
}

/** 按 spec 的 layers 聚合。跑在**文件级**（`utils/terrain*.js` 这种前缀分法，目录聚合天生看不见）。 */
export function applySpec(recs: [string, number][], spec: LayerSpec | null): LayerNamed[] {
  if (!spec || !spec.layers) return []
  const out: LayerNamed[] = []
  for (const [name, item] of Object.entries(spec.layers)) {
    const hit = recs.filter(([rel]) => matchPath(rel, item.paths || []))
    hit.sort((a, b) => b[1] - a[1])
    out.push({
      name,
      lines: hit.reduce((s, [, n]) => s + n, 0),
      files: hit.length,
      sample: hit.slice(0, 4).map(([rel]) => rel),
      note: item.note || '',
    })
  }
  out.sort((a, b) => b.lines - a.lines)
  return out
}

/** spec 里的「哪几层是一伙的」（生成器 / 编辑器 …）。这个分法**也是人给的**。 */
export function applyGroups(named: LayerNamed[], spec: LayerSpec | null): LayerGroup[] {
  if (!spec || !spec.groups) return []
  const byName = new Map(named.map((n) => [n.name, n]))
  const out: LayerGroup[] = []
  for (const [name, members] of Object.entries(spec.groups)) {
    const list = Array.isArray(members) ? members : []
    out.push({
      name,
      lines: list.reduce((s, m) => s + (byName.get(m)?.lines || 0), 0),
      members: list,
      missing: list.filter((m) => !byName.has(m)),
    })
  }
  out.sort((a, b) => b.lines - a.lines)
  return out
}

/** 产品代码行数（占比的**唯一**合法分母）。 */
export function productLines(rows: LayerRow[]): number {
  return rows.filter((r) => r.role === '产品').reduce((s, r) => s + r.lines, 0)
}

/**
 * 一句话结论。**这是整个模块存在的理由** —— 必须回答问题，不是罗列。
 *
 * 分母规则（踩过一次）：占比用**产品代码**；只有 spec 点名的几块内部比才用它们的合计，
 * 因为那才是"两块之间谁厚谁薄"的诚实口径（2026-11-15 手算的 92% / 8% 正是这个口径）。
 */
export function verdictOf(
  rows: LayerRow[], named: LayerNamed[], groups: LayerGroup[], totalLines: number,
): string {
  if (totalLines <= 0) {
    return '扫不到任何代码行 —— 这不是「厚度为 0」，是**没扫到**：路径 / 扩展名 / 排除规则至少有一个不对。'
  }
  const parts: string[] = []
  const prod = productLines(rows)
  const { base, label } = denominatorOf(rows, named, groups)

  if (groups.length) {
    const top = groups[0]
    parts.push(`【${top.name}】${fmt(top.lines)} 行，占${label} ${pct(top.lines, base)}。`)
    for (const g of groups.slice(1)) {
      parts.push(`【${g.name}】${fmt(g.lines)} 行（${pct(g.lines, base)}）。`)
    }
    const last = groups[groups.length - 1]
    if (groups.length >= 2 && last.lines > 0) {
      parts.push(`「${top.name}」是「${last.name}」的 ${(top.lines / last.lines).toFixed(1)} 倍。`)
    }
  } else if (named.length) {
    const top = named[0]
    parts.push(`声称的分层里最厚的是「${top.name}」：${fmt(top.lines)} 行，占${label} ${pct(top.lines, base)}。`)
  }

  const byRole: Record<string, number> = { 产品: 0, 测试: 0, 工具: 0 }
  for (const r of rows) byRole[r.role] = (byRole[r.role] || 0) + r.lines
  parts.push(`产品 ${fmt(byRole['产品'])} 行 · 测试 ${fmt(byRole['测试'])} 行 · 工具 ${fmt(byRole['工具'])} 行` +
    `（全仓合计 ${fmt(totalLines)}）。`)
  if (rows.length) {
    parts.push('最厚的三个目录层：' +
      rows.slice(0, 3).map((r) => `${r.layer} ${fmt(r.lines)}行`).join(' · '))
  }
  return parts.join(' ')
}

/** spec 点名的几块**内部**的占比 —— "两块之间谁厚谁薄"的唯一诚实口径。 */
export function innerShares(groups: LayerGroup[]): { name: string; share: number }[] {
  const total = groups.reduce((s, g) => s + g.lines, 0)
  if (total <= 0) return []
  return groups.map((g) => ({ name: g.name, share: (g.lines / total) * 100 }))
}

/**
 * 选占比的**分母**，并把选择理由说出来。
 *
 * ⚠ 2026-11-16 被真 spec 当场揭出的 bug：某个项目（project-3）是纯 Python CLI 项目，
 * 代码全在 `scripts/` 底下 —— 而 `roleOf()` 按**目录名**把 `scripts/` 一律判成"工具"。
 * 于是"产品代码"只剩 1,346 行（`gui/` + `desktop/`），而 spec 圈出的层合计 13,256 行
 * → **占比算出 444.6%**。
 *
 * 444% 这种数**不可能是真的**，所以它必须不可能出现：
 *   ① 默认分母 = 产品代码（"层与层之间谁厚谁薄"的诚实口径）；
 *   ② spec 点名的层合计**超过**产品代码 → 说明"产品"这个标签在该项目上失真
 *      （它的主干不在 `src/` 那类目录里），改用**全仓合计**当分母；
 *   ③ 换分母必须**大声说** —— 静默换分母和静默改排除规则是同一种病。
 */
export function denominatorOf(
  rows: LayerRow[], named: LayerNamed[], groups: LayerGroup[],
): { base: number; label: string; note: string } {
  const prod = productLines(rows)
  const total = rows.reduce((s, r) => s + r.lines, 0)
  const namedTotal = groups.length
    ? groups.reduce((s, g) => s + g.lines, 0)
    : named.reduce((s, n) => s + n.lines, 0)
  if (prod > 0 && namedTotal <= prod) {
    return { base: prod, label: '产品代码', note: '' }
  }
  if (namedTotal > prod) {
    return {
      base: total,
      label: '全仓',
      note: `spec 点名的层合计 ${fmt(namedTotal)} 行**超过**「产品代码」${fmt(prod)} 行 —— `
        + `说明按目录名判定的「产品 / 工具」标签在这个项目上失真（它的主干不在 \`src/\` 那类目录里）。`
        + `所以**改用全仓 ${fmt(total)} 行当分母**；换分母后百分比才可能 ≤100%，`
        + `但它同时也把测试算了进来 —— 看数时请一并看角色分栏。`,
    }
  }
  return { base: prod || total, label: prod ? '产品代码' : '全仓', note: '' }
}

/** 声称 vs 实测逐条对账。`got === null` = spec 里没这个名字（不是 0）。 */
export function claimRows(
  claims: Record<string, number>, named: LayerNamed[],
): { name: string; claim: number; got: number | null }[] {
  const byName = new Map(named.map((n) => [n.name, n.lines]))
  return Object.entries(claims || {}).map(([name, claim]) => ({
    name,
    claim: Number(claim) || 0,
    got: byName.has(name) ? (byName.get(name) as number) : null,
  }))
}

export interface BoardRow {
  id: string
  name: string
  product: number
  test: number
  tool: number
  /** 测试 / 产品。产品 0 时给 null（**不是 0** —— "没代码"和"测试为零"是两件事） */
  testRatio: number | null
  topLayer: string
  /** 读不到仓库时的原因；那时上面所有数都是 undefined 语境 */
  missing: string
}

/** 横比表的一行。 */
export function toBoardRow(p: LayerProfile): BoardRow {
  const sum = (role: LayerRole): number =>
    p.rows.filter((r) => r.role === role).reduce((s, r) => s + r.lines, 0)
  const product = sum('产品')
  return {
    id: p.id,
    name: p.name || p.id,
    product,
    test: sum('测试'),
    tool: sum('工具'),
    testRatio: product > 0 ? sum('测试') / product : null,
    topLayer: p.rows.length ? p.rows[0].layer : '—',
    missing: p.missing || '',
  }
}

export interface BoardAnomaly {
  kind: '测试比产品厚' | '产品为零' | '没有声称的分层'
  text: string
  id: string
}

/**
 * 横比表能直接看出来的异常。**只列能数出来的**，不替用户做判断 ——
 * "测试比产品厚"不一定坏（也可能产品被排除规则挡掉了），所以文案必须带这句。
 */
export function boardAnomalies(rows: BoardRow[]): BoardAnomaly[] {
  const out: BoardAnomaly[] = []
  for (const r of rows) {
    if (r.missing) continue
    if (r.testRatio !== null && r.testRatio >= 1 && r.product > 1000) {
      out.push({
        kind: '测试比产品厚',
        id: r.id,
        text: `${r.name}：产品 ${fmt(r.product)} 行，测试 ${fmt(r.test)} 行 —— 测试是产品的 ${r.testRatio.toFixed(2)} 倍。`,
      })
    }
  }
  for (const r of rows) {
    if (!r.missing && r.product === 0) {
      out.push({
        kind: '产品为零',
        id: r.id,
        text: `${r.name}：产品代码 0 行 —— 要么这仓库本来就不是代码库，要么规则把它的代码全挡掉了。`,
      })
    }
  }
  return out
}

export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return n.toLocaleString('en-US')
}

export function pct(part: number, whole: number): string {
  if (!whole) return '—'
  return `${((part / whole) * 100).toFixed(1)}%`
}
