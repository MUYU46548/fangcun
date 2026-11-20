/**
 * 顶栏工作区布局（2026-11-18 · 暮雨）
 *
 * 原话：「依然很臃肿，现有做法并不够优雅，我有个更好的点子，让用户更灵活地调整顶部工具栏：
 * 提供 2-3 种预设工作区，满足不同流派的需求，按照一定风格放置若干高频按钮在外面，
 * 其他折叠（甚至顺序可以调整）。另外留一个自定义模式，让用户自己排序或折叠
 * （有最少按钮和最多按钮限制，防止按钮全被折叠找不到或按钮太多挤爆页面）。」
 * 以及：「顺便打勾太丑太蠢了，做个可视化拖拽排序不难吧？单独弄个小画布，
 * 打开自定义模式让玩家自己拖，可以保存可以取消。」
 *
 * ## 为什么逻辑单独在这儿（不埋在 App.vue 里）
 * 拖拽画布最容易出的是"边界没夹住"：拖到 6 个、拖到 13 个、把一个不存在的 id 塞进来。
 * 那些错误在界面上只表现为"拖了一下没反应"或"页签凭空少一个"，肉眼抓不住。
 * 抽成纯函数就能在 Node 里逐条钉住（`e2e-view-layout.cjs`），不用起浏览器。
 *
 * ## 三条硬规矩
 * 1. **下限**：顶栏至少留 `MIN_VISIBLE` 个 —— 否则工具会被折叠藏没（2026-10-25 就定过 7）。
 * 2. **上限**：顶栏最多 `MAX_VISIBLE` 个 —— 再多就把页面挤爆（这是这次新加的）。
 * 3. **未知 id 一律丢弃**：布局是从 prefs.json 读的，手改坏了不能让界面凭空多出页签。
 *    ⚠ 但也**不许因为一个坏值就整体回落** —— 用户拖了半天的成果不该被一条脏数据抹掉。
 */

/** 顶栏至少留几个页签在外面（2026-10-25 暮雨定的下限） */
export const MIN_VISIBLE = 7

/**
 * 顶栏最多放几个页签在外面（2026-11-18 新增上限：防"按钮太多挤爆页面"）。
 *
 * ⚠ **定 15，不是 12**（两稿都被自己的测试/截图纠正过）：
 *   ① 12 会逼默认布局也改（老默认 13 个在场）→ 等于顺手替用户改了顶栏（本仓教训 #9）；
 *   ② 13（= 默认可见数）虽然不越界，但**默认就顶到上限**——进自定义模式想加一个会被立刻拒绝，
 *      那正是暮雨嫌弃的"打勾太丑太蠢"。上限存在的意义是**留出可加的空间**，不是把默认卡死。
 *   页签总数 16，所以 15 的含义是"至少留 1 个在「更多」里"（「更多」按钮本身不能被清空）。
 */
export const MAX_VISIBLE = 15

export interface ViewLayout {
  /** 用户在自定义模式里调过的顺序；空数组 = 用源码默认顺序 */
  order: string[]
  /** 收进「更多」的页签 id */
  hidden: string[]
  /** 当前用的是哪套预设；'custom' = 自己拖出来的 */
  preset: string
}

export interface ViewPreset {
  id: string
  /** 顶栏按钮上显示的名字 */
  label: string
  /** 一句话说清这套是给谁用的 */
  desc: string
  /** 想放外面的页签（按显示顺序）；数量会被夹进 [MIN, MAX] */
  visible: string[]
}

/**
 * 三套预设 + 当前默认。
 *
 * ⚠ 设计口径（2026-11-18 · 第二稿，被自己的测试纠正过一次）：
 *   第一稿把「日常」写成 8 个并当默认 —— 那等于**顺手改了用户每天看到的那一行**，
 *   与"用户只说要能自己调"是两回事（本仓教训 #9：只修他提的那个症状）。
 *   所以「日常」= **现有观感的原样**（收 启动台/技能/服务 三个），
 *   想更简就点「专注」—— 那才是"收敛"的那一套，由用户自己选。
 */
export const PRESETS: ViewPreset[] = [
  {
    id: 'daily',
    label: '日常',
    desc: '默认：高频页签在外，启动台 / 技能 / 服务收进「更多」',
    visible: ['active', 'ask', 'todos', 'ideas', 'memory', 'logs', 'projects', 'blockers',
      'roadmap', 'calendar', 'archive', 'trash', 'decisions'],
  },
  {
    id: 'focus',
    label: '专注',
    desc: '只留干活那条线：卡 → 日志 → 项目，加一个每天第一眼看的东西。适合被任务压住的时候',
    visible: ['active', 'logs', 'projects', 'todos', 'memory', 'blockers', 'ask'],
  },
  {
    id: 'tidy',
    label: '盘点',
    desc: '整理归档流：看板 / 归档 / 回收站 / 日志 / 项目 / 决策 / 阻塞 —— 一次把摊子收干净',
    visible: ['active', 'archive', 'trash', 'logs', 'projects', 'decisions', 'blockers'],
  },
]

/**
 * 老默认（2026-10-25）：只收 启动台 / 技能 / 服务。
 * 现在它**就是**「日常」预设 —— 保留这个名字是为了让"从老键迁移"读得懂。
 */
export const LEGACY_DEFAULT_HIDDEN = ['launchpad', 'skills', 'services']

/**
 * 新用户的默认布局 = 第一套预设「日常」那 8 个。
 *
 * 为什么默认就要"少"（2026-11-18）：暮雨两次说顶栏臃肿，而"折叠"只有他主动点才发生 ——
 * **默认态才是他每天看到的东西**。默认给 8 个高频页，其余收进「更多」，要用时一次点开就有；
 * 反过来默认摊 13 个，等于把"收拾"这件事永远留给他。
 */
export function defaultLayout(): ViewLayout {
  const p = PRESETS.find((x) => x.id === 'daily') || PRESETS[0]
  if (!p) return { order: [], hidden: [...LEGACY_DEFAULT_HIDDEN], preset: 'daily' }
  // ⚠ **order 留空**：默认就是"源码顺序"，不是"把预设里那 8 个提到前面"。
  //   两者在界面上看起来一样（都是 active → ask → todos …），但留空让
  //   `isDefaultLayout()` 与 `normalizeLayout(空布局)` 得到**同一个对象** ——
  //   否则"什么也没动过的布局"和"点了恢复默认"会算出两种结果，按钮禁用态永远不对。
  const visible = new Set(p.visible.filter((id) => ALL_DEFAULT_IDS.includes(id)))
  const hidden = ALL_DEFAULT_IDS.filter((id) => !visible.has(id))
  return { order: [], hidden, preset: p.id }
}

/**
 * 兜底用的"页签全集"（只在 `defaultLayout()` 没拿到真实 id 表时用）。
 * ⚠ 与 `App.vue` 的 `views` 表同序 —— `e2e-view-layout` 有一条断言比对两边，
 *   加页签时漏改这里会当场红（而不是悄悄少一个）。
 */
export const ALL_DEFAULT_IDS = ['active', 'ask', 'todos', 'ideas', 'memory', 'logs', 'projects',
  'blockers', 'roadmap', 'calendar', 'archive', 'trash', 'launchpad', 'decisions', 'skills', 'services']

/** 老用户从老键迁移时的兜底：把老的三个 + 回收站一起收，保证不越上限 */
export const DEFAULT_HIDDEN = LEGACY_DEFAULT_HIDDEN

/** 去重 + 只认已知 id，保持首次出现的顺序 */
function cleanIds(ids: unknown, known: Set<string>): string[] {
  if (!Array.isArray(ids)) return []
  const out: string[] = []
  for (const raw of ids) {
    const id = String(raw ?? '').trim()
    if (!id || !known.has(id) || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/**
 * 把磁盘上读到的任意值规整成一套合法布局。
 *
 * @param raw       prefs.json 里的 `fc_view_layout`（可能是任何东西）
 * @param allIds    源码里真实存在的页签 id（含顺序）
 * @param legacy    老键 `fc_views_collapsed`（升级上来的用户只有这个）
 */
export function normalizeLayout(raw: unknown, allIds: string[], legacy?: unknown): ViewLayout {
  const known = new Set(allIds)
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  const hasLegacy = Array.isArray(legacy) && legacy.length > 0

  /**
   * 三条来源要分得清（混成一条就会"每次启动都在改用户的布局"）：
   *   ① 新键在 → 用它（哪怕内容是坏的，也只在**这个来源**里夹取，不整体回落）
   *   ② 新键没有、老键在 → 老用户升级：按老键算，但**数量要补齐到合法**（老键通常只有 3 个）
   *   ③ 两个都没有 → 从没存过 = 默认布局。**必须与 `defaultLayout()` 完全一致**，
   *      否则"没动过"和"点了恢复默认"会算出两种布局，禁用态/文案永远对不上。
   */
  if (!src && !hasLegacy) {
    const def = defaultLayout()
    return { order: [], hidden: def.hidden.filter((id) => known.has(id)), preset: def.preset }
  }

  // ① 顺序：只保留已知 id，剩下的由调用方按源码顺序补到后面（这里不补，保持"用户动过哪些"可辨）
  const order = cleanIds(src?.order, known)

  // ② 隐藏：新键优先，没有就退回老键
  const hiddenRaw = src ? src.hidden : legacy
  let hidden = cleanIds(hiddenRaw, known)

  // ③ 夹进 [MIN, MAX]：可见数 = 总数 - 隐藏数
  const total = allIds.length
  const cap = Math.min(MAX_VISIBLE, total) // 页签总数不足上限时上限就是总数
  const floorHidden = Math.max(0, total - cap) // 至少得藏掉这么多（上限）
  const maxHidden = Math.max(0, total - MIN_VISIBLE) // 最多只能藏这么多（下限）
  if (hidden.length < floorHidden) {
    // 藏得不够 → 按源码顺序补到上限（把排在最后的先收起来，前面的高频页保住）
    const rest = allIds.filter((id) => !hidden.includes(id))
    hidden = hidden.concat(rest.slice(rest.length - (floorHidden - hidden.length)))
  } else if (hidden.length > maxHidden) {
    // 藏得太多 → 从尾部放回来几个（用户最近动过的顺序未知，按源码顺序兜底）
    const back = allIds.filter((id) => hidden.includes(id)).slice(0, hidden.length - maxHidden)
    hidden = hidden.filter((id) => !back.includes(id))
  }

  const preset = typeof src?.preset === 'string' && src.preset ? String(src.preset) : 'daily'
  return { order, hidden, preset }
}

/** 按布局算出顶栏的真实显示顺序：用户的顺序在前，没提到的按源码顺序跟在后面 */
export function resolveOrder(layout: ViewLayout, allIds: string[]): string[] {
  const known = new Set(allIds)
  const head = layout.order.filter((id) => known.has(id))
  const tail = allIds.filter((id) => !head.includes(id))
  return head.concat(tail)
}

/** 可见 / 收起两组（保持 resolveOrder 的顺序） */
export function splitVisible(layout: ViewLayout, allIds: string[]): { visible: string[]; hidden: string[] } {
  const seq = resolveOrder(layout, allIds)
  const hide = new Set(layout.hidden)
  return { visible: seq.filter((id) => !hide.has(id)), hidden: seq.filter((id) => hide.has(id)) }
}

export interface LayoutResult {
  ok: boolean
  layout: ViewLayout
  /** ok=false 时的人话原因；ok=true 时为空 */
  error: string
}

/**
 * 勾上 / 取消一个页签。
 *
 * 返回而不是抛，是因为界面要**当场把人话弹出来**（"顶栏至少留 7 个"），
 * 而不是默默不改 —— 默默不改就是"点了没反应"。
 */
export function toggleVisible(layout: ViewLayout, id: string, allIds: string[]): LayoutResult {
  const known = new Set(allIds)
  if (!known.has(id)) return { ok: false, layout, error: '没有这个页签' }
  const hide = new Set(layout.hidden)
  const visibleCount = allIds.length - hide.size
  if (hide.has(id)) {
    if (visibleCount >= MAX_VISIBLE) {
      return {
        ok: false, layout,
        error: `顶栏最多放 ${MAX_VISIBLE} 个页签（再放就挤爆了）—— 先收一个再放`,
      }
    }
    hide.delete(id)
  } else {
    if (visibleCount <= MIN_VISIBLE) {
      return {
        ok: false, layout,
        error: `顶栏至少留 ${MIN_VISIBLE} 个页签（收起来后就只剩 ${visibleCount - 1} 个了）—— 先放回几个再收`,
      }
    }
    hide.add(id)
  }
  return { ok: true, layout: { ...layout, hidden: [...hide], preset: 'custom' }, error: '' }
}

/**
 * 拖拽改顺序：把 `dragId` 放到 `overId` 的位置（before/after 由调用方算好目标下标）。
 * 用 id 而不是下标，是因为界面上拖完一次列表会重排，下标立刻就不准了。
 */
export function moveView(layout: ViewLayout, dragId: string, targetIndex: number, allIds: string[]): ViewLayout {
  const seq = resolveOrder(layout, allIds)
  const from = seq.indexOf(dragId)
  if (from < 0) return layout
  const rest = seq.filter((_, i) => i !== from)
  const to = Math.max(0, Math.min(rest.length, targetIndex))
  rest.splice(to, 0, dragId)
  return { ...layout, order: rest, preset: 'custom' }
}

/** 套用一套预设（数量已经是设计好的，但仍然过一遍夹取） */
export function applyPreset(presetId: string, allIds: string[], presets: ViewPreset[] = PRESETS): LayoutResult {
  const p = presets.find((x) => x.id === presetId)
  if (!p) return { ok: false, layout: defaultLayout(), error: '没有这套预设' }
  const known = new Set(allIds)
  const visible = cleanIds(p.visible, known).slice(0, MAX_VISIBLE)
  const hidden = allIds.filter((id) => !visible.includes(id))
  // 预设自身设计就可能低于下限（比如只写了 5 个）—— 那是预设写错了，不是用户操作错了
  if (visible.length < MIN_VISIBLE) {
    return {
      ok: false, layout: defaultLayout(),
      error: `这套预设只有 ${visible.length} 个页签，少于下限 ${MIN_VISIBLE} —— 预设写错了`,
    }
  }
  return { ok: true, layout: { order: visible.concat(hidden), hidden, preset: p.id }, error: '' }
}

/** 布局是不是"什么都没动过"（用于「恢复默认」按钮的禁用态） */
export function isDefaultLayout(layout: ViewLayout): boolean {
  if (layout.order.length) return false
  if (layout.preset !== 'daily') return false
  // 与 defaultLayout() 逐项比，而不是与某个写死的常量比 ——
  // 否则"改了默认预设却忘了改这里"，按钮会永远显示"已是默认"（或永远不是）。
  const def = defaultLayout()
  const a = [...layout.hidden].sort().join('|')
  const b = [...def.hidden].sort().join('|')
  return a === b
}

/** 一句话说清当前布局（顶栏按钮与设置页共用，避免两处各写一份文案） */
export function describeLayout(layout: ViewLayout, presets: ViewPreset[] = PRESETS): string {
  if (layout.preset === 'custom') return '自定义'
  const p = presets.find((x) => x.id === layout.preset)
  return p ? p.label : '自定义'
}
