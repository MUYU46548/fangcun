/**
 * 结论集与收敛判据（2026-11-11 · P8 of 0.7.0 · 拍板 D-064）
 *
 * 暮雨 2026-11-09 选的停止条件是「结论集连续 3 轮重算不变即收敛」（D-064）：
 *   · **结论集** = 有效决策去掉日期 / 出处 / 「生效范围」之后的实质内容集合（去重）；
 *   · 每答完一卷重算一次，与上一次快照比对；
 *   · 新增 0 条 → 连续零新增 +1；新增 >0 → 归零；
 *   · 连续 3 次 → 判定「问够了」。
 *
 * 为什么这一步必须落成代码：没有它，“问够没问够”就只能靠感觉；
 * 而判断半的全部前提是“停止条件由机器判定”（D-064 的验收线原话）。
 *
 * 三条纪律：
 *  ① **纯函数**（无文件、无 Electron）—— 才能被 e2e 直接断言，不必起进程；
 *  ② **只读决策，不写决策**：本模块只产出指纹与差值，落盘由调用方（approveDeck）负责；
 *  ③ **绝不静默**：指纹算法版本变了要在快照里带 `algo`，老快照不被硬套。
 */

/** 指纹算法版本 —— 改了归一化规则就 +1，旧快照自动作废（不硬套） */
export const CONVERGENCE_ALGO = 1

/** 连续多少次零新增算收敛（D-064 定死 3） */
export const CONVERGENCE_STREAK = 3

/**
 * 决策内容归一：只留“定了什么”。
 *
 * 具体去掉：
 *  - 行首日期 `[2026-11-10]` / `2026-11-10`；
 *  - 「生效范围：本卷 / 全局」这类范围标注；
 *  - 「出处：…」与结尾的括号备注（那是台账坐标，不是结论本身）；
 *  - 全部空白、常见中英文标点（全角/半角不同写法视为同一句）。
 */
export function normalizeDecisionContent(raw: unknown): string {
  let s = String(raw ?? '')
  s = s.replace(/\r\n/g, '\n')
  // 日期：`[2026-11-10]` 或 `2026-11-10`（行首或行内都去）
  s = s.replace(/\[\s*\d{4}-\d{2}-\d{2}\s*\]/g, ' ')
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
  // 范围 / 出处标注：`生效范围：本卷`「出处：问卷 X · S1」
  // ⚠ 2026-11-23：`decisions.ts` 读盘时已经把范围摘成独立字段，所以**新读出来的内容**
  //   不再带这条尾巴 —— 但这行**不能删**：
  //   ① 结论集快照（`decisions.convergence.json`）里存的是**旧文本**，删了就与历史指纹对不上，
  //      表现为"昨天收敛了、今天突然冒出 20 条新增"（假警报比缺警报更耗人）；
  //   ② 任何绕过解析器直接传原文的调用方（脚本/测试）仍会带尾巴。
  //   双重保险的代价只是多一次 replace，收益是历史可比。
  s = s.replace(/生效范围\s*[:：]\s*[^\n]*/g, ' ')
  s = s.replace(/出处\s*[:：]\s*[^\n]*/g, ' ')
  // 括号备注（中文括号里通常是“为什么 / 什么时候”的旁注）
  s = s.replace(/[（(][^）)]*[）)]/g, ' ')
  // 标点与空白归一：全角转半角 + 去掉所有标点，只留字与数字
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  s = s.replace(/[\s"'`~!@#$%^&*()_+=[\]{}|\\;:,.<>/?·、，。；：！？…—–\-]/g, '')
  return s.trim()
}

/** FNV-1a 32 位（不引依赖；冲突概率对这种规模够用，且快照里同时存了原文） */
export function fingerprintOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export interface ConclusionEntry {
  fp: string
  /** 归一化后的实质内容（快照里留一份，便于人看“这条是什么”） */
  text: string
  /** 原决策 id（只作参考，不进指纹） */
  id?: string
}

export interface ConclusionSet {
  algo: number
  total: number
  entries: ConclusionEntry[]
  fps: string[]
}

/**
 * 从决策卡里取「结论集」。
 *
 * 只收 `状态 === '有效'` 的（已撤销/已合并的不算 —— 否则撤销过的结论会一直撑着集合）；
 * 项目过滤：`project` 有值时收「本项目 + 全局（项目为空）」。
 */
export function conclusionSetOf(decisions: any[], project?: string): ConclusionSet {
  const want = String(project || '').trim()
  const seen = new Map<string, ConclusionEntry>()
  for (const d of Array.isArray(decisions) ? decisions : []) {
    if (!d) continue
    if (String(d['状态'] || d.status || '').trim() !== '有效') continue
    const p = String(d['项目'] ?? d.project ?? '').trim()
    if (want && p && p !== want) continue
    const text = normalizeDecisionContent(d['内容'] ?? d.content ?? '')
    if (!text) continue
    const fp = fingerprintOf(text)
    if (!seen.has(fp)) seen.set(fp, { fp, text, id: String(d.id || '') })
  }
  const entries = [...seen.values()]
  return { algo: CONVERGENCE_ALGO, total: entries.length, entries, fps: entries.map((e) => e.fp) }
}

export interface ConvergenceSnapshot {
  algo: number
  project: string
  updatedAt: string
  /** 连续零新增次数 */
  streak: number
  /** 本轮新增几条实质结论 */
  lastAdded: number
  /** 本轮消失几条（撤销/作废造成） */
  lastRemoved: number
  total: number
  /** 指纹集合（比对用） */
  fps: string[]
}

export interface ConvergenceStep {
  /** 本轮新增几条 */
  added: number
  /** 本轮消失几条 */
  removed: number
  /** 新快照（可直接落盘） */
  snapshot: ConvergenceSnapshot
  /** 是否已判收敛 */
  converged: boolean
  /** 是否因为算法版本/项目不同而重起炉灶（此时 added 无意义，按第一轮算） */
  restarted: boolean
}

/**
 * 走一步：把当前结论集与上一份快照比，产出新快照。
 *
 * ⚠ “不变” = **既没有新增、也没有消失**（2026-11-11 自测抓到的坑）：
 *   只数新增时，一卷被作废（结论消失）会被当成“又是零新增”继续加分 —— 收藏着虚假的收敛。
 *   所以任何变化（added 或 removed > 0）都把连续计数归零。
 *
 * 重起炉灶的两种情况（都不硬套旧 streak）：
 *  - 快照的 `algo` 与当前不同（归一化规则改过，旧指纹不可比）；
 *  - 快照的 `project` 不一致（拿 A 项目的进度套 B 项目 = 假账）。
 * 重起时把当前全部结论算作“本轮新增”（它们对这个项目确实是第一次被记录下来）。
 */
export function stepConvergence(input: {
  prev?: ConvergenceSnapshot | null
  current: ConclusionSet
  project?: string
  now?: string
}): ConvergenceStep {
  const project = String(input.project || '').trim()
  const cur = input.current
  const prev = input.prev
  const restart = !prev || prev.algo !== cur.algo || String(prev.project || '') !== project
  const prevFps = new Set(restart ? [] : (prev && Array.isArray(prev.fps) ? prev.fps : []))
  const curFps = new Set(cur.fps)
  let added = 0
  let removed = 0
  if (restart) {
    added = curFps.size
  } else {
    for (const fp of curFps) if (!prevFps.has(fp)) added++
    for (const fp of prevFps) if (!curFps.has(fp)) removed++
  }
  const unchanged = added === 0 && removed === 0
  const streak = restart ? 0 : (unchanged ? (prev!.streak || 0) + 1 : 0)
  const snapshot: ConvergenceSnapshot = {
    algo: cur.algo,
    project,
    updatedAt: String(input.now || new Date().toISOString()),
    streak,
    lastAdded: added,
    lastRemoved: removed,
    total: cur.total,
    fps: cur.fps,
  }
  return { added, removed, snapshot, converged: streak >= CONVERGENCE_STREAK, restarted: restart }
}

/** 一句话人话（界面/CLI/回写都用它，免得三处各写一遍口径） */
export function describeConvergence(s: ConvergenceSnapshot | null | undefined): string {
  if (!s) return '还没算过（答完一卷会自动算一次）'
  const n = CONVERGENCE_STREAK
  if (s.streak >= n) return `已收敛：连续 ${s.streak} 轮结论集不变（共 ${s.total} 条结论）`
  return `未收敛：连续不变 ${s.streak}/${n}（本轮新增 ${s.lastAdded} / 减少 ${s.lastRemoved} / 共 ${s.total} 条）`
}
