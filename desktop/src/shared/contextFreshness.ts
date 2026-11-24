/**
 * 「这一包里的材料还算不算数」的口径（2026-11-24 · 暮雨第 2 条）
 *
 * ## 原话
 *
 * > 「排给DSH的内容会不会太诡异了？会不会太浪费上下文？不过本来就是给AI看的，
 * >   我就没要求说人话。里面一堆不说人话的东西。也许AI能看懂？」
 *
 * ## 实测（2026-11-24 · `buildContextPack('fangcun-base')`）
 *
 * 总 **7789 字 / 186 行**，按节拆开：
 *
 * | 节 | 字数 | 占比 |
 * |---|---|---|
 * | ① 立项契约 | 2198 | 28.2% |
 * | ③ 方针（含结构地图） | 1961 | 25.2% |
 * | ⑦ 硬约束（从①③复述） | 1110 | 14.3% |
 * | ⑤ 未完成卡 | 1091 | 14.0% |
 * | ④ 决策卡 | 951 | 12.2% |
 *
 * **①②③⑦ 四节加起来 5269 字 = 67%**，而它们回答的是同一个问题：
 * "这项目是什么、不能碰什么"。
 *
 * ## 真正的病不是"太长"，是"过期的那部分占了大头"
 *
 * 契约节里原样写着：
 *   · 「**一屏视图不存在**」（做完了，`e2e-trip-board` 44 条钉着）
 *   · 「**6 个项目在方寸零任务卡**」（早补了）
 *
 * 这些字是"当时的断点"，不是今天的现状。但上下文包**逐字照搬** ——
 * 每个开工的 agent 都会读到"一屏视图不存在"，然后可能去建一个已经有了的东西。
 *
 * **模型不会怀疑上下文包；它只会照着做。** 所以一份写错的包比没有包更糟。
 *
 * `missing` 机制已经在了（缺什么要明说），但它只管"有没有"，不管"还算不算数"。
 * 这里补的就是后者：**过期的材料要当场标出来，而不是静悄悄混在事实里**。
 *
 * ⚠ 只预警，不删 —— 删掉原文等于把"当时为什么会这么想"也一起删了，
 *   那正是契约存在的一半理由（另一半是约束）。
 */

/** 一节材料的新鲜度结论 */
export interface FreshnessVerdict {
  /** 有没有可机读的时间锚（有锚才谈得上"过期"） */
  hasAnchor: boolean
  /** 时间锚（ISO 或 YYYY-MM-DD）；没有就是空串 */
  anchor: string
  /** 距今天数；NaN = 算不出（没有锚 / 锚坏了） */
  ageDays: number
  /** 判为过期（有锚且超过阈值） */
  stale: boolean
  /** 判为"没锚 = 无法判断新旧"（**这不等于新鲜**） */
  unknownAge: boolean
}

/** 多久算过期。90 天与 `structureMapStale` 同一口径（本仓已有一个 90 天判据，不另造一个数）。 */
export const STALE_DAYS = 90

/**
 * 从一段正文里找"最后核实：YYYY-MM-DD"这类时间锚。
 *
 * 认三种写法（本仓真实数据里都出现过）：
 *   · `最后核实：2026-11-12` （结构地图的标准写法）
 *   · `（2026-10-05 10:18 实跑）` （契约里的断点标注）
 *   · `更新：2026-11-24T…` （frontmatter 风格）
 *
 * ⚠ 取**最晚**的那个日期：一段材料里可能有多处日期，材料本身"有多新"由最新的那处决定。
 *   取第一个会把"2026-10-05 断点"当成材料日期 —— 那正好反过来。
 */
export function findLastVerified(text: string): string {
  const src = String(text || '')
  const dates: string[] = []
  // 明确带"核实/实跑/更新"语境的日期优先
  for (const m of src.matchAll(/(?:最后核实|核实|实跑|更新)\s*[:：]?\s*(20\d{2})-(\d{2})-(\d{2})/g)) {
    dates.push(`${m[1]}-${m[2]}-${m[3]}`)
  }
  if (!dates.length) {
    // 退一步：任何 ISO 日期（别把 `2026-09-05` 这种正文里的历史日期当锚，除非它紧跟着核实语义）
    for (const m of src.matchAll(/(20\d{2})-(\d{2})-(\d{2})T/g)) {
      dates.push(`${m[1]}-${m[2]}-${m[3]}`)
    }
  }
  if (!dates.length) return ''
  dates.sort()
  return dates[dates.length - 1]
}

/**
 * 判断一段材料的新鲜度。
 *
 * @param text 材料正文
 * @param today 今天（毫秒时间戳或 Date；测试注入口，真实调用不传）
 *
 * ⚠ `unknownAge`（没锚）**不等于** `stale`（过期）—— 两者话不一样：
 *   · 没锚 = "我不知道它新旧"，要靠人；
 *   · 过期 = "它确实旧了"。
 *   合并成一句会让"没有日期"看起来很严重，而"三个月没更新"看起来很正常。
 */
export function judgeFreshness(text: string, today: number | Date = Date.now()): FreshnessVerdict {
  const anchor = findLastVerified(text)
  if (!anchor) return { hasAnchor: false, anchor: '', ageDays: NaN, stale: false, unknownAge: true }
  const at = Date.parse(`${anchor}T00:00:00Z`)
  if (!Number.isFinite(at)) return { hasAnchor: false, anchor, ageDays: NaN, stale: false, unknownAge: true }
  const now = today instanceof Date ? today.getTime() : Number(today)
  const ageDays = Math.floor((now - at) / 86400000)
  return { hasAnchor: true, anchor, ageDays, stale: ageDays > STALE_DAYS, unknownAge: false }
}

/**
 * 给上下文包用的那一句话（**空串 = 不用提**，别在包上添"一切正常"的噪音）。
 *
 * 两个调用点共用这一份措辞：① 契约节  ② 方针节。
 */
export function freshnessNote(label: string, v: FreshnessVerdict): string {
  if (!v.hasAnchor) {
    return `- ⚠ ${label}**没有"最后核实"日期** —— 我判断不了它还算不算数；`
      + '里面的"当前断点/计划"可能是早就做完的事。**别把这段当今天的现状**，先核。'
  }
  if (v.stale) {
    return `- ⚠ ${label}最后核实是 **${v.anchor}**（${v.ageDays} 天前，超过 ${STALE_DAYS} 天）`
      + ' —— 里面的"当前断点/计划"很可能已经过时。**拿它当方向可以，当现状不行**，'
      + '涉及"这一步到底做没做"的，去代码/看板上核一遍再说。'
  }
  return ''
}
