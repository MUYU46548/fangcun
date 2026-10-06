/**
 * 阻塞链关键路径（纯逻辑）—— 卡 20260925-023，2026-10-06
 *
 * 回答界面上一直答不出来的那个问题：**先解哪个阻塞最划算。**
 *
 * 为什么不直接用 `blockedTasks.length` 排序：那只数了"直接挡住几个"，
 * 而真正贵的是**传递效应** —— A 挡住 B、B 又挡住 C，解 A 的价值是 2 不是 1。
 *
 * 算法（只读、无副作用）：
 *   ① 从 chains 反推「被谁挡着」：任务 → 挡它的阻塞源集合（一个任务可被多个源挡）；
 *   ② 对每个**未完成**的候选源 S，模拟"S 被解掉"：把 S 从所有人的集合里摘掉，
 *      然后迭代 —— 谁集合空了谁解锁；解锁的人若本身也在挡别人，就从别人的集合里再摘掉它；
 *   ③ 记「因 S 而解锁的任务数」（不含 S 自己）。
 *
 * 为什么放 shared/：它是纯逻辑，`tsc` 编出 `dist/shared/blockers.js` 后可直接断言
 * （见 `scripts/test/e2e-blockers.cjs`）—— 埋在 App.vue 里就只能靠真点界面才验得到。
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

export function computeBlockerImpact(chains: BlockerSourceLike[] | null | undefined): BlockerImpact[] {
  const list = Array.isArray(chains) ? chains : []
  const titleOf: Record<string, string> = {}
  const doneOf: Record<string, boolean> = {}
  const directOf: Record<string, number> = {}
  const blockersOf: Record<string, Set<string>> = {}

  for (const s of list) {
    if (!s || !s.id) continue
    titleOf[s.id] = s.title || s.id
    doneOf[s.id] = !!s.isDone
    const blocked = Array.isArray(s.blockedTasks) ? s.blockedTasks : []
    directOf[s.id] = blocked.length
    for (const t of blocked) {
      if (!t || !t.id) continue
      titleOf[t.id] = t.title || t.id
      doneOf[t.id] = DONE.has(String(t.status || ''))
      if (!blockersOf[t.id]) blockersOf[t.id] = new Set()
      blockersOf[t.id].add(s.id)
    }
  }

  const rows: BlockerImpact[] = []
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
    rows.push({ id: src, title: titleOf[src] || src, direct: directOf[src], unlock: unlocked.size })
  }
  return rows.sort((a, b) => b.unlock - a.unlock || b.direct - a.direct)
}
