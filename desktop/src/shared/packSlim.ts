/**
 * 上下文包「瘦身」口径（2026-11-24 · 暮雨：「上下文包有问题也要改，垃圾内容太多」）
 *
 * ## 实测（不是估的）
 *
 * `buildContextPack('fangcun-base')` = **7868 字 / 187 行**，按节：
 *
 * | 节 | 字数 | 占比 | 其中重复 |
 * |---|---|---|---|
 * | ① 立项契约 | 2276 | 28.9% | 758 字是 REV 历史叙述 |
 * | ③ 方针（含结构地图） | 1960 | 24.9% | 结构地图 ~1100 字是给人读的 |
 * | ⑦ 硬约束 | 1109 | 14.1% | **909 字逐行复述 §1（82%）** |
 * | ⑤ 未完成卡 | 1090 | 13.9% | — |
 * | ④ 决策卡 | 950 | 12.1% | — |
 * | ② 登记表 | 270 | 3.4% | — |
 * | ⑥ 日志 | 98 | 1.2% | — |
 *
 * 三个**真问题**（不是"A 字看起来多"）：
 *
 * ### ① §7 整节是复述
 *
 * `§7 干活时的硬约束` 把契约的「不要什么」和方针的「边界」**原样再贴一遍**：
 * 909 / 1109 字与 §1 逐行相同。§7 自己独有的只有两句（"改完必须真跑验证"、
 * "这一包是只读快照会过期"）。
 *
 * 同一批规矩出现两次，不只是浪费 —— 它会**制造两份可漂移的副本**：
 * 以后改契约「不要什么」，§7 那份不会跟着变（它是拼包时从同一个字段取的，
 * 但 agent 读到两段不同长度的同一内容时，会以为其中一段是"补充说明"）。
 *
 * ### ② REV 历史叙述占了契约节三分之一
 *
 * 契约里 `REV-003 → REV-005 → REV-009`、还有一整段 `~~删除线~~`（已被 REV-008 推翻）。
 * 这些是**给人看的历史**（"当初为什么这么定"），agent 要的是**现在是什么**。
 *
 * ⚠ 但**不能一刀砍掉**：这份契约的正文有陈旧处（写着"BYOK 本阶段接"），
 * 而 REV-005/009 才是现行口径 —— REV 在这里是**承重**的。
 * 所以只做无损压缩：删掉作者自己划掉的部分（`~~…~~` 明确表示"收回"）。
 *
 * ### ③ 结构地图是给人读的
 *
 * 1100 字里有模块表（有用：agent 找文件）、也有四段架构散文（人读更舒服）。
 * agent 有仓库可读，散文是重复劳动。
 *
 * ## 本模块的原则
 *
 * **只做"能证明无损"的删减。** 凡是删了可能丢信息的，一律：
 *   ① 不删，或
 *   ② 删了**必须留一句"这里省略了什么、原文在哪"**。
 *
 * 绝不"为了变短而让 agent 以为它看到了全部" —— 那比冗长危险得多。
 */

/** 瘦身报告：让包自己说得出"我省了什么"（不静默） */
export interface SlimReport {
  /** 省掉的总字数（含标记文字） */
  savedChars: number
  /** 逐条省略记录：省了什么、原文在哪 */
  omitted: { what: string; chars: number; where: string }[]
}

/**
 * ① 去掉作者**自己划掉**的段落（`~~…~~`）。
 *
 * 为什么这个删减是**无损**的：删除线在 Markdown 里的语义就是"这段不再算数"。
 * 留着它等于把"已经被推翻的规定"当现行规矩喂给 agent ——
 * 那不是多给信息，是**给错信息**（本仓 2026-10-11 的反面教材：
 * 一张卡一直把已被收回的 0.3.2 发布说明当方向证据）。
 *
 * ⚠ 只认**成对**的 `~~`。落单的 `~~` 原样保留（那是写坏了，不该被我"顺手修好"）。
 */
export function dropStruckBlocks(text: string): { text: string; removedChars: number } {
  const src = String(text || '')
  let removed = 0
  // 成对的 ~~…~~（可以跨行），替换成等量空行以保持段落结构
  const out = src.replace(/~~([\s\S]*?)~~/g, (m) => {
    removed += m.length
    return ''
  })
  return { text: out.replace(/\n{3,}/g, '\n\n'), removedChars: removed }
}

/**
 * ② 去掉「标签后直接跟列表符」这类**嵌套坏掉**的行前缀。
 *
 * 实测真身（2026-11-24，`buildContextPack` 第 164 行）：
 *   `- 不做：- **运营期要用户手动喂的规划工具**（…）`
 *
 * 这是拼包时把**多行字段塞进一行标签**造成的：`不做：` 后面接的原文本身以 `- ` 开头。
 * 后果不是难看，是**结构塌了** —— agent 看到 `- 不做：- **X**` 会把它读成一个
 * 名为"不做："的条目，而不是"X 属于不做的那一类"。
 *
 * 修法：标签后紧跟列表符时，把标签变成段落标题，列表另起。
 */
export function fixNestedLabelLines(text: string): string {
  const lines = String(text || '').split('\n')
  const out: string[] = []
  for (const l of lines) {
    const m = /^(-\s+)([^：:\n]{1,8})([：:])\s*(-\s+)(.*)$/.exec(l)
    if (m) {
      out.push(`${m[1]}${m[2]}${m[3]}`)
      out.push(`${m[4]}${m[5]}`)
      continue
    }
    out.push(l)
  }
  return out.join('\n')
}

/**
 * ③ 硬约束只留「不重复的那部分」。
 *
 * 契约的「不要什么」和方针的「边界」**已经在 §1 / §3 里原文出现过**，
 * §7 再贴一遍是纯重复（实测 909/1109 字）。
 *
 * 所以 §7 只留：
 *   · 一句指路（"契约的不要什么 / 方针的边界见第 1、3 节，这里不重复"）——
 *     为什么值得花这 ~40 字：**防止 agent 看到一个只有 3 条的"硬约束"节，
 *     反推出"这项目没有别的规矩"**；
 *   · 方寸自己的两条通用规矩（验证 / 快照会过期）。
 */
export const HARD_RULES_HEADER =
  '- 本项目的具体边界（不要什么 / 方针边界）见第 1、3 节原文 —— **这里不重复，别以为没有**。'

export const HARD_RULES_UNIVERSAL: readonly string[] = [
  '- 改完必须真跑验证（不是"应该没问题"）；拿不准就停下来问，别猜。',
  '- 这一包是**只读的现状快照**，会过期 —— 你动手前如果隔了很久，先重新生成一份。',
]

/**
 * ④ 结构地图压成"agent 版"。
 *
 * ## 实测（2026-11-24，真身 1772 字 / 5 段）
 *
 * | 段 | 字数 | 类型 | 怎么处理 |
 * |---|---|---|---|
 * | `最后核实：2026-11-12` | 17 | 元信息 | **留**（新鲜度判据要用） |
 * | 模块表（13 行） | 1035 | 表，含约束 | **留**（agent 找文件唯一靠它） |
 * | 主数据流 | 309 | 散文 | 省略 |
 * | 桌面端数据流 | 233 | 散文 | 省略 |
 * | 规约层 | 170 | **散文但含硬约束** | **留** |
 *
 * ## 为什么不是"散文一律砍"
 *
 * 第一版按"散文超过 N 段就砍"来做，实测会把**规约层**砍掉 —— 而它写着
 * 「`shared/` 里的是口径不是工具函数，只许有一份实现」。
 * 砍掉它，agent 完全可能再写一份同义逻辑，**而它本来是对的、是在守纪律**。
 *
 * 所以判据不是"文体"，是**有没有约束力**：
 *   · 含「不许 / 必须 / 只许 / 禁止 / 判据」这类词的段落 → **留**（那是规矩，不是描述）；
 *   · 纯描述（数据流怎么走 / 文件放在哪）→ 省略，但写明省了什么、原文在哪。
 *
 * 描述型散文 agent 有仓库可读，重复劳动；规矩型散文删了会直接导致犯错。
 *
 * @param mapText 方针卡里的结构地图原文
 * @returns text 压缩后的正文；omitted 被省略了什么（用于在包里写明）
 */
export function compactStructureMap(mapText: string): { text: string; omitted: string[] } {
  const src = String(mapText || '')
  if (!src.trim()) return { text: '', omitted: [] }

  const paras = src.split(/\n\s*\n/).filter((x) => x.trim())
  const keep: string[] = []
  const omitted: string[] = []
  for (const para of paras) {
    const isTable = /^\s*\|/m.test(para)
    const isMeta = /^\s*(>\s*)?最后核实/.test(para.trim())
    // 约束型：出现"规矩词"就留 —— 见上面那张表，砍了 170 字的规约层是净亏
    const isRule = /不[许准能]|必须|只许|禁止|判据|不许|一律/.test(para)
    if (isTable || isMeta || isRule) {
      keep.push(para)
      continue
    }
    const head = para.split('\n')[0].replace(/[*#>`]/g, '').trim().slice(0, 40)
    omitted.push(head || '（无标题段）')
  }
  return { text: keep.join('\n\n').trim(), omitted }
}

/** 给包里用的"省略了什么"说明（空数组 → 空串，不加噪音） */
export function slimNote(omitted: string[], where: string): string {
  if (!omitted.length) return ''
  return `- ⚠ 为省上下文，这里省掉了 ${omitted.length} 段（${omitted.join(' / ')}）—— 原文在 \`${where}\`。`
}

/**
 * 把一句话截到 cap 以内，但**在标点处收**，不在字中间砍。
 *
 * 为什么值得单写一个函数：第一版直接用 `slice(0, 46) + '…'`，
 * 实测截出 `…缺的只有「方寸→DSH」那根管子（不配 KEY…` ——
 * 括号开在那儿没合上。对人不算事，对模型是**语法残缺**：
 * 它可能把那半句当一个完整条件读。
 *
 * 收尾顺序（从"最好断"到"最差"）：
 *   句末标点（。！？；）> 逗号（，、）> 空格 > 硬切
 * 并且**只有真的省了东西才加 `…`** —— 没截短就别画蛇添足。
 */
export function clipAtPunct(s: string, cap: number): string {
  const one = String(s || '').replace(/\s+/g, ' ').trim()
  if (one.length <= cap) return one

  /** 把截断处没闭合的括号补齐（中英文各一组） */
  const closeParens = (cut: string): string => {
    let out = cut
    for (const [open, close] of [['（', '）'], ['(', ')'], ['「', '」'], ['【', '】'], ['[', ']']] as const) {
      const o = (out.split(open).length - 1)
      const c = (out.split(close).length - 1)
      if (o > c) out += close.repeat(o - c)
    }
    return out
  }

  const head = one.slice(0, cap)
  // 从"最好断"到"最差"：句末标点 > 逗号顿号 > 空格 > 硬切
  //
  // ⚠ 第一版只在**硬切**那条路上补括号，于是在标点处收时就漏了 ——
  //   实测截出 `…那根管子（不配…`，括号开在半空。
  //   守卫当场抓到（它就是为这个写的）。现在**每条路都过同一个 closeParens**。
  const marks = ['。', '；', '！', '？', '，', '、', ';', ',', ' ']
  for (const mk of marks) {
    const at = head.lastIndexOf(mk)
    if (at >= cap * 0.5) return closeParens(head.slice(0, at).trimEnd()) + '…'
  }
  return closeParens(head) + '…'
}
