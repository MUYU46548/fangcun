/**
 * 阻塞链关键路径（纯逻辑）—— 卡 20260925-023，2026-10-06
 *
 * 回答界面上一直答不出来的那个问题：**先解哪个阻塞最划算。**
 *
 * 为什么不直接用 `blockedTasks.length` 排序：那只数了"直接挡住几个"，
 * 而真正贵的是**传递效应** —— A 挡住 B、B 又挡住 C，解 A 的价值是 2 不是 1。
 *
 * 算法（只读、无副作用）：
 *   ① 从 chains 反推“被谁挡着”：任务 → 挡它的阻塞源集合（一个任务可被多个源挡）；
 *   ② 对每个**未完成**的候选源 S，模拟"S 被解掉"：把 S 从所有人的集合里摘掉，
 *      然后迭代 —— 谁集合空了谁解锁；解锁的人若本身也在挡别人，就从别人的集合里再摘掉它；
 *   ③ 记“因 S 而解锁的任务数”（不含 S 自己）。
 *
 * 为什么放 shared/：它是纯逻辑，`tsc` 编出 `dist/shared/blockers.js` 后可直接断言
 * （见 `scripts/test/e2e-blockers.cjs`）—— 埋在 App.vue 里就只能靠真点界面才验得到。
 *
 * 2026-10-31（暮雨第 7 条：阻塞页"单加出口不能从根本解决"）：
 * 这一页要服务的决策只有一句 —— **现在先解哪一张？** 所以除了算收益，再给一份
 * `buildBlockerQueue`：按收益排好的可执行队列 + 每行"解了会解锁谁"的名单。
 * 界面据此把"先解这个"做成主区，把完整阻塞链降级成折叠的证据。
 */

export interface BlockerSourceLike {
  id: string
  title?: string
  status?: string
  /** 主进程已判定的"这个源自身已终态" —— 已完成的源不参与推荐 */
  isDone?: boolean
  blockedTasks?: { id: string; title?: string; status?: string }[]
}

export interface BlockerImpact {
  id: string
  title: string
  /** 它直接挡住几个 */
  direct: number
  /** 解开它之后，一共有几个任务不再被卡（含传递） */
  unlock: number
}

const DONE = new Set(['完成', '驳回'])

interface ImpactWithIds extends BlockerImpact {
  unlockedIds: string[]
  status: string
}

/** 内部：算收益，同时把"解锁了谁"的 id 留下来（界面要列名字，不能只有一个数） */
function computeImpactDetail(chains: BlockerSourceLike[] | null | undefined): ImpactWithIds[] {
  const list = Array.isArray(chains) ? chains : []
  const titleOf: Record<string, string> = {}
  const doneOf: Record<string, boolean> = {}
  const directOf: Record<string, number> = {}
  const blockersOf: Record<string, Set<string>> = {}
  const blockedIdsOf: Record<string, string[]> = {}

  for (const s of list) {
    if (!s || !s.id) continue
    titleOf[s.id] = s.title || s.id
    doneOf[s.id] = !!s.isDone
    const blocked = Array.isArray(s.blockedTasks) ? s.blockedTasks : []
    directOf[s.id] = blocked.length
    blockedIdsOf[s.id] = []
    for (const t of blocked) {
      if (!t || !t.id) continue
      titleOf[t.id] = t.title || t.id
      doneOf[t.id] = DONE.has(String(t.status || ''))
      if (!blockersOf[t.id]) blockersOf[t.id] = new Set()
      blockersOf[t.id].add(s.id)
      blockedIdsOf[s.id].push(t.id)
    }
  }

  const rows: ImpactWithIds[] = []
  for (const src of Object.keys(directOf)) {
    if (doneOf[src]) continue                     // 已完成的源没有"先解它"可言
    const map: Record<string, Set<string>> = {}
    for (const [k, v] of Object.entries(blockersOf)) {
      const set = new Set(v)
      set.delete(src)
      map[k] = set
    }
    const unlocked = new Set<string>()
    let changed = true
    while (changed) {
      changed = false
      for (const [t, set] of Object.entries(map)) {
        if (unlocked.has(t) || doneOf[t]) continue
        if (set.size === 0) {
          unlocked.add(t)
          changed = true
          for (const k of Object.keys(map)) map[k].delete(t)   // t 解锁 → 它作为源也不再挡别人
        }
      }
    }
    unlocked.delete(src)
    rows.push({
      id: src,
      title: titleOf[src] || src,
      direct: directOf[src],
      unlock: unlocked.size,
      unlockedIds: Array.from(new Set([...blockedIdsOf[src] || [], ...unlocked])),
      status: String(list.find((s) => s && s.id === src)?.status || ''),
    })
  }
  return rows.sort((a, b) => b.unlock - a.unlock || b.direct - a.direct)
}

export function computeBlockerImpact(chains: BlockerSourceLike[] | null | undefined): BlockerImpact[] {
  return computeImpactDetail(chains).map(({ id, title, direct, unlock }) => ({ id, title, direct, unlock }))
}

// ── 决策队列（2026-10-31）──────────────────────────────────────────────

export interface BlockerQueueRow extends BlockerImpact {
  status: string
  /** 解开它之后会解锁的任务标题（最多 5 个，界面直接列名字） */
  unlockTitles: string[]
  /** 一句人话：解了它，谁不再被卡 */
  why: string
}

export interface BlockerQueue {
  rows: BlockerQueueRow[]
  /** 先解这个 = 收益最高且真有人受益；没有这种事就是 null */
  top: BlockerQueueRow | null
  /** 阻塞源总数 */
  total: number
  /** 被挡住的任务总数 */
  blocked: number
  /** 卡在"谁都解不动"上的源数（unlock 为 0，解了也没人受益） —— 它们不是待办，是背景 */
  inert: number
  text: string
}

/**
 * 把阻塞链整理成一份**排好序的可执行队列**。
 * 排序口径与 computeBlockerImpact 一致（传递收益优先、再看直接挡几个），
 * 额外给：每行会解锁谁、一行结论、以及"解了也没人受益"的源有多少。
 * ⚠ 不猜：`unlock === 0` 的行仍然列出来（它确实挡着人，只是档的那批已完成），
 *   但**不进** top，界面也不该把它摆在第一屏。
 */
export function buildBlockerQueue(chains: BlockerSourceLike[] | null | undefined): BlockerQueue {
  const list = Array.isArray(chains) ? chains : []
  const titleOf: Record<string, string> = {}
  const blockedIds = new Set<string>()
  for (const s of list) {
    if (!s || !s.id) continue
    titleOf[s.id] = s.title || s.id
    for (const t of Array.isArray(s.blockedTasks) ? s.blockedTasks : []) {
      if (t && t.id) { titleOf[t.id] = t.title || t.id; blockedIds.add(t.id) }
    }
  }
  const detail = computeImpactDetail(list)
  const rows: BlockerQueueRow[] = detail.map((r) => {
    const unlockTitles = r.unlockedIds.map((id) => titleOf[id] || id).slice(0, 5)
    const extra = r.unlock > r.direct ? `，连带再放 ${r.unlock - r.direct} 张` : ''
    return {
      id: r.id,
      title: r.title,
      direct: r.direct,
      unlock: r.unlock,
      status: r.status,
      unlockTitles,
      why: r.unlock > 0
        ? `解它，${r.unlock} 张不再被卡（直接挡 ${r.direct} 张${extra}）`
        : `它挡着 ${r.direct} 张，但那些卡已经完成/驳回 —— 解它没有收益`,
    }
  })
  const total = rows.length
  const blocked = blockedIds.size
  const inert = rows.filter((r) => r.unlock === 0).length
  const top = rows.find((r) => r.unlock > 0) || null
  const text = total === 0
    ? '没有阻塞 —— 没有任何一张卡在等别的卡'
    : top
      ? `${total} 个阻塞源挡着 ${blocked} 张卡；先解“${top.title}”最划算（它能放 ${top.unlock} 张）`
      : `${total} 个阻塞源，但被挡的卡都已收口 —— 没有值得先解的一张`
  return { rows, top, total, blocked, inert, text }
}
