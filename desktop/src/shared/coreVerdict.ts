/**
 * 核心判词的**唯一真源**（2026-11-12 暮雨第 N 次：「垃圾能玩之类的文本怎么又给我写死在代码里了？方寸要发布的」）
 *
 * 病根：同一套词表当时散在 5 个文件、8 处 ——
 *   · `contentScale.ts`：CORE_VERDICTS 数组、CoreVerdict 联合类型、coreVerified 里的 === 比较、报错文案
 *   · `services/policies.ts`：CORE_VERDICT_SKELETON 骨架四行
 *   · `PolicyEditModal.vue`：VERDICT_PICKS 数组 + pickVerdict 里的正则
 *   · `App.vue`：`/^>\s*未判/` 判断"这是不是骨架提示"
 *   · `llm/planDraftInput.ts`：**同一个正则又写了一遍**
 *
 * 为什么这不能忍（不是洁癖）：
 *   ① 加一个档位要改 5 个文件，漏一个就是"界面能选、闸不认"这种静默错；
 *   ② 方寸是要发布的 —— 词表写死在源码里，用户既不能改也不能本地化；
 *   ③ 同一条判据写两遍，改一处忘一处，正是本项目反复吃亏的那一类。
 *
 * 现在**只有这里**定义词与含义，别处一律 import。
 * 守卫：`scripts/test/check-verdict-single-source.cjs`。
 *
 * ⚠ 本文件零 Vue / 零 DOM / 零 IO（内容量闸要用它，主进程与渲染层都要能引）。
 */

export interface VerdictLevel {
  /** 存进方针卡的词（也是解析时的前缀） */
  key: string
  /** 界面上按钮的字 */
  label: string
  /** 一句话说明：选它意味着什么（界面上当 title） */
  hint: string
  /** 选它时，是否允许铺内容量（核心已验证） */
  allowsScale: boolean
  /** 选它时自动填进输入框的尾巴（"—— " 后面的引导语） */
  cue: string
}

/**
 * 档位表。想加/改档位**只动这里**。
 *
 * 顺序即界面上的顺序：从"最有把握"到"没判过"。
 * 「未判」是一个**独立档位**而不是"空字符串的别名"：人要能明确表达"我还没看"，
 * 这与"我看过了但说不清"是两件事，前者不该被判词闸当成后者。
 */
export const VERDICT_LEVELS: VerdictLevel[] = [
  {
    key: '立得住',
    label: '立得住',
    hint: '核心玩法/用途已经验证过 —— 可以往上铺内容量',
    allowsScale: true,
    cue: '（一句话说清验证过什么）',
  },
  {
    key: '能玩',
    label: '能玩',
    hint: '能玩但不惊艳 —— 先按这个基准往前推，别指望它自己变好',
    allowsScale: true,
    cue: '（一句话说清哪几分钟确实是游戏）',
  },
  {
    key: '垃圾',
    label: '垃圾',
    hint: '这个方向不行 —— 铺多少内容都是白费；该换方向，不是加料',
    allowsScale: false,
    cue: '（一句话说清烂在哪）',
  },
  {
    key: '未判',
    label: '未判（清空）',
    hint: '还没看过 / 还不确定 —— 只许做最小原型，不许铺内容量',
    allowsScale: false,
    cue: '',
  },
]

/** 「未判」这一档的 key（别处不许写字符串字面量） */
export const UNJUDGED = VERDICT_LEVELS[VERDICT_LEVELS.length - 1].key

/** 允许铺内容量的档位词（由 allowsScale 派生，不另写一遍） */
export const SCALE_OK_KEYS: string[] = VERDICT_LEVELS.filter((v) => v.allowsScale).map((v) => v.key)

/** 所有档位词（解析/守卫用） */
export const VERDICT_KEYS: string[] = VERDICT_LEVELS.map((v) => v.key)

/** 判词文本的形态：`<档位词> —— <理由> <日期>`，也接受只有档位词或只有自由文本 */
export function parseVerdict(raw: unknown): { level: string; reason: string } {
  const t = String(raw ?? '').trim()
  if (!t) return { level: UNJUDGED, reason: '' }
  for (const v of VERDICT_LEVELS) {
    if (v.key === UNJUDGED) continue
    if (t === v.key || t.startsWith(v.key)) {
      const rest = t.slice(v.key.length).replace(/^[\s—\-–:：]+/, '').trim()
      return { level: v.key, reason: rest }
    }
  }
  // 认不出档位词：当成"人写了自由文本" —— 视为已判但说不清哪一档，
  // **不猜**成"立得住"（那会让闸放行一个从没验证过的方向）。
  return { level: '', reason: t }
}

/** 拼成存盘的那一行。reason 为空时用该档位的 cue 引导人去写 */
export function composeVerdict(level: string, reason: string, date: string): string {
  const lv = VERDICT_LEVELS.find((v) => v.key === level)
  if (!lv || lv.key === UNJUDGED) return ''
  const r = String(reason || '').trim()
  return `${lv.key} —— ${r || lv.cue}${date ? ' ' + date : ''}`
}

/** 这个判词是否允许铺内容量 */
export function verdictAllowsScale(raw: unknown): boolean {
  const { level } = parseVerdict(raw)
  return SCALE_OK_KEYS.indexOf(level) >= 0
}

/** 项目**没有**给出可用的判词（空 / 只有骨架 / 选了未判） */
export function isUnjudged(raw: unknown): boolean {
  const t = String(raw ?? '').trim()
  if (!t) return true
  if (/^>/.test(t)) return true   // 骨架是引用块（`> 未判 —— …`），不是判词
  return parseVerdict(t).level === UNJUDGED
}

/**
 * 方针卡里「核心判词」节的骨架（人没填时写这个）。
 * 由 VERDICT_LEVELS 生成，**不再手写四个词**。
 */
export function verdictSkeleton(): string {
  const names = VERDICT_LEVELS.map((v) => v.key).join(' / ')
  const ex = VERDICT_LEVELS.find((v) => v.key !== UNJUDGED && v.allowsScale)
  return [
    `> ${UNJUDGED} —— 核心玩法还没被人确认过。`,
    `> 四选一写在这里：**${names}**，后面跟一句话理由与日期。`,
    `> 例：\`${ex ? ex.key : ''} —— 装配台那 5 分钟确实是游戏 2026-11-12\``,
    '> 未判时，方寸只允许做最小原型（0.5 小时 / 1 幕 / 1 间房），不许铺内容量。',
  ].join('\n')
}
