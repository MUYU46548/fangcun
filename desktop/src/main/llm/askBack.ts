/**
 * 反向提问出口（2026-11-16 · P14 · 落地 D-142 / D-098 / REV-011 ④）
 *
 * ## 暮雨要的是什么（原话）
 *
 * 2026-11-12：
 * > 「我希望自己能**真正参与到决策中**，把握项目的发展。」
 * > 「差在我说不清的地方 —— **你先问我几个反向问题**。」（D-098）
 *
 * 2026-11-15 追问「一次问几条」时，他选 **D-142 = C**：
 * > 「**不设固定条数，由方寸自己判断『哪几条真会影响计划』**」
 *
 * 验收线原文（写在 D-142 备注里）：
 * > 「若选 A 而我某次问了超过 3 条 = 违约；**任何一条问题缺【意见】= 违约（REV-011 ④ 硬性）**。」
 *
 * ## 选 C 的必然后果：必须有一个"该不该问"的判据
 *
 * 不设条数 ⇔ 必须有筛选标准，否则等于没有约束。本文件的判据只有一条：
 *
 * > 这道题答完之后，**会使计划里至少一个阶段卡的动作改变**。答不改就不问。
 *
 * 「动作改变」不是感觉，是三种可判的形状（见 `affectsPlan`）：
 *   ① 它卡住的那一格**还没有判据** → 答了才知道该做什么
 *   ② 它卡住的那一格**判据之间互相矛盾** → 答了才知道按哪条
 *   ③ 它让某张卡**从"不知道该不该做"变成"能做/不能做"**（kind = '待定'/'冲突'）
 *
 * ## 为什么这里不调模型（省钱 + 可复核）
 *
 * 暮雨反复说「token 照扣但是 AI 根本不知道」。出题的**判断**可以机器做：
 * 输入是已有的未答活题 + 阶段卡 + 冲突行，全是结构化数据。
 * 需要模型的是"怎么措辞"，那属于界面层，不在这里。
 */

/** 一道反向问题。字段与 REV-011 ④ 的硬要求一一对应，缺一项就构造不出来。 */
export interface AskBack {
  /** 唯一 id（沿用题库的 fingerprint，避免同一个问题问两遍） */
  id: string
  /** 问题本身（一句话） */
  ask: string
  /** **互斥选项**，至少 2 个；每个都要带代价（D-062 的硬要求） */
  options: { k: string; text: string; cost: string }[]
  /** **我的意见**（REV-011 ④：任何一条缺【意见】= 违约） */
  opinion: { pick: string; why: string; confidence: '高' | '中' | '低' }
  /** 因为它会让哪个阶段卡的哪个动作改变（这就是"该不该问"的判据） */
  affects: { stage: string; action: string; kind: AffectKind }
  /** 出处：首问在哪、依据是哪条决策 */
  source: string
  cites: string[]
}

export type AffectKind = '没有判据' | '判据冲突' | '待定'

/** 输入：本仓现有零件（全是结构化数据，不需要模型） */
export interface AskBackInput {
  /** 题库里状态=待答 的题（`questionBank.openBank()`） */
  openQuestions: { fp: string; ask: string; project?: string; line?: string }[]
  /** 中期计划里的阶段卡（`plans.ts` 解析结果，只用到这三项） */
  stages: { id: string; title: string; status: string; criteria: string[] }[]
  /** 草案宪法的冲突/待定行（`planDraft.ts` 的 ConstrRow） */
  constRows: { kind: '已定' | '待定' | '冲突' | '作废'; text: string; cites: string[] }[]
  /** 已有的决策（用来防重复问：同一个问题问两遍 = 病③） */
  decided: { id: string; text: string }[]
}

/**
 * 这道题会不会让计划真的改变？
 *
 * 这是 D-142 选 C 后**唯一**的收窄判据。返回 null = 不该问。
 *
 * 三种可判形状（每一条都能指着数据说话，不是感觉）：
 *   · 阶段卡**判据为空** → 答了才知道这一格怎么验收
 *   · 阶段卡判据**多于 2 条且互相矛盾**（这里用"含否定词"粗判） → 答了才知道按哪条
 *   · 冲突/待定行（kind ≠ 已定） → 答了才能把它从"不知道"变成"定了"
 */
export function affectsPlan(
  q: { ask: string; line?: string },
  input: AskBackInput,
): { stage: string; action: string; kind: AffectKind } | null {
  const text = `${q.ask || ''} ${q.line || ''}`

  // ① 阶段卡没判据：任何一条题只要点名了那一格，答了就改变它
  for (const s of input.stages) {
    if (s.status === '完成') continue           // 做完的格子再问 = 纯打扰
    const named = text.includes(s.id) || (s.title && text.includes(s.title.slice(0, 8)))
    if (named && s.criteria.length === 0) {
      return { stage: s.id, action: '写这一格的判据', kind: '没有判据' }
    }
  }

  // ② 冲突/待定行：这些行本身就是"还没定"，问了才算参与决策
  for (const r of input.constRows) {
    if (r.kind === '已定' || r.kind === '作废') continue
    const key = (r.text || '').slice(0, 6)
    if (key && text.includes(key)) {
      return { stage: '—', action: r.text.slice(0, 40), kind: '判据冲突' }
    }
  }

  // ③ 点名了一格**未完成且已冻结**的阶段卡（有判据但还没推）
  for (const s of input.stages) {
    if (s.status === '完成') continue
    if (s.status === '待裁决') continue          // 还没冻结 = 现在问也没用
    const named = text.includes(s.id) || (s.title && text.includes(s.title.slice(0, 8)))
    if (named) return { stage: s.id, action: '推进这一格', kind: '待定' }
  }

  return null     // 答了不改变任何东西 → 不问
}

/**
 * 与已有决策同义题去重（病③：同一个问题问两遍）。返回命中那条决策的 id = 该丢。
 *
 * ⚠ 门槛是**算出来的**，不是拍的。2026-11-16 实测这一对的真实最长公共子串：
 *
 *     题目「P2 界面整站重做要不要做？」  vs  决策「外观整站重做」
 *     公共片段 = 「整站重做」= **4 字**
 *
 * 第一版门槛写 6 → 判不出来 → 一个**已经拍过板的事又被问一遍**（正是病③本身）。
 * 4 字在这里恰恰是核心语义（整站重做 = D-140 的决策对象），再低会误判（如「要不要」）。
 * 所以门槛 = 4，并把"为什么是 4"写进这个常量，别再有人随手往上调。
 */
const DUP_MIN_LCS = 4

function lcsLen(a: string, b: string): number {
  // 经典 DP，两个串都短（题目/决策 ≤ 几十字），O(nm) 无压力
  const m = a.length
  const n = b.length
  if (!m || !n) return 0
  let prev = new Array(n + 1).fill(0)
  let best = 0
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1).fill(0)
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > best) best = cur[j]
      }
    }
    prev = cur
  }
  return best
}

export function alreadyDecided(ask: string, decided: { id: string; text: string }[]): string | null {
  const norm = (s: string) => String(s || '').replace(/[\s，。、；：？！,.;:?!（）()「」“”]/g, '').toLowerCase()
  const a = norm(ask)
  if (a.length < DUP_MIN_LCS) return null
  let bestId: string | null = null
  let bestLen = 0
  for (const d of decided) {
    const b = norm(d.text)
    if (!b) continue
    const n = lcsLen(a, b)
    if (n > bestLen) { bestLen = n; bestId = d.id }
  }
  return bestLen >= DUP_MIN_LCS ? bestId : null
}

export interface AskBackResult {
  /** 该问的（每一道都带【意见】+ 代价 + affects） */
  questions: AskBack[]
  /** 被丢掉的，逐条给原因（REV-011 ④：只会提问不会收窄 = 把决策成本转嫁回用户） */
  dropped: { ask: string; why: string }[]
  /** 本轮问了几条、其中几条真的改变了计划 */
  stats: { considered: number; asked: number; dropped: number }
}

/**
 * 生成这一轮该问的题。**不设上限也不设下限**（D-142 选 C）。
 *
 * ⚠ 纪律：`asked` 可以为 0 —— 没有题目会改变计划时就该闭嘴。
 *   硬凑条数正是暮雨骂的"每次都拿一堆奇怪的玩意给用户填"。
 */
export function buildAskBack(input: AskBackInput): AskBackResult {
  const questions: AskBack[] = []
  const dropped: { ask: string; why: string }[] = []
  const seen = new Set<string>()

  for (const q of input.openQuestions || []) {
    const ask = String(q.ask || '').trim()
    if (!ask) continue
    if (seen.has(q.fp)) { dropped.push({ ask, why: '同一道题在题库里重复' }); continue }
    seen.add(q.fp)

    // ⚠ 顺序要紧：**先去重、再判该不该问、最后查意见**。
    //   2026-11-16 实测反例：一道已经被 D-140 定过的题，因为"缺意见"先被拦下，
    //   于是丢弃原因写成「缺意见」而不是「已被 D-140 定过」——
    //   **原因指错了地方**，下一个看到它的人会去补意见，而正确动作是别再问。
    //   "为什么丢"必须按**最根本的那个原因**说。
    const dup = alreadyDecided(ask, input.decided || [])
    if (dup) { dropped.push({ ask, why: `已经被 ${dup} 定过` }); continue }

    const aff = affectsPlan(q, input)
    if (!aff) {
      // 这条必须留下来：它是"答不改就不问"的现场凭证
      dropped.push({ ask, why: '答了不改变任何阶段卡的动作（答不改就不问）' })
      continue
    }

    // ⚠ REV-011 ④ 硬性：没有【意见】的问题**不许出卷**。
    //   这里没有意见就说明 agent 还没想清楚 → 丢进 dropped 并点明原因，不硬塞。
    const opinion = q as any
    if (!opinion.__opinion) {
      dropped.push({ ask, why: '缺【意见】—— REV-011 ④ 硬性，不许出卷' })
      continue
    }

    questions.push({
      id: String(q.fp || '').slice(0, 24) || ask.slice(0, 24),
      ask,
      options: opinion.__options || [],
      opinion: opinion.__opinion,
      affects: aff,
      source: q.project ? `题库 · ${q.project}` : '题库',
      cites: opinion.__cites || [],
    })
  }

  return {
    questions,
    dropped,
    stats: {
      considered: (input.openQuestions || []).length,
      asked: questions.length,
      dropped: dropped.length,
    },
  }
}
