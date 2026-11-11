/**
 * 「澄清: 卷」的唯一解析入口（2026-11-11 · 卡《进队列锁只落了一半》）
 *
 * 为什么要有这一层：卡的澄清卷此前在**三个地方各认一遍**，而且三种写法互不兼容 ——
 *   · 界面派工单（`App.vue`）认 `fm.clarify` / `fm['澄清']` / 正文 `澄清问卷：<卷>`（**要求冒号**）；
 *   · 问卷落卡（`deckToCards`）写的是 `## 澄清问卷` 下一行 `<卷>（已批准）`（**没有冒号**）；
 *   · 数据层（进队列闸 / 阶段卡）此前压根不认。
 * 结果就是「问卷落的卡反而过不了派工闸」—— 同一条事实三种读法，必然对不上。
 * 现在三种写法都收在这一个纯函数里，主进程与渲染层共用（可被 e2e 直接断言）。
 *
 * 口径（缺字段 ≠ 拒绝，见 qnQueueGate.ts 顶部）：
 *   返回空串 = 这张卡**没有声明**澄清卷（普通任务卡），不是「声明了但卷是空的」。
 */

export interface ClarifySource {
  fm?: Record<string, any> | null
  body?: string | null
}

/** 去掉「（已批准）」、列表符号、引号 —— 只留卷名本身 */
export function normalizeDeckName(raw: unknown): string {
  let s = String(raw ?? '').trim()
  s = s.replace(/^[-*+]\s*/, '')
  s = s.replace(/[（(]\s*已批准\s*[）)]/g, '')
  s = s.replace(/^[「『"'《]+/, '')
  s = s.replace(/[」』"'》，。；;,]+$/, '')
  return s.trim()
}

/**
 * 拆「卷」与「题」：`<卷>#<题号>`。
 *
 * 两种澄清的差别（2026-11-11 定，别混）：
 *   · `澄清: 某卷`     —— 这张卡压**整卷**的结论（规划草稿 / 阶段卡）；
 *   · `澄清: 某卷#S3`  —— 这张卡只压**那一道题**的答案（问卷落卡 `deckToCards` 写的形态：
 *     只有 S3 答了、其余还挂着，就为 S3 落一张卡 —— 这是用户点的，不是 agent 绕闸）。
 * 不区分会两头堵：整卷要求会把“已答的那道题”锁死；一题要求又放过“整卷没答完”。
 */
export function splitClarify(raw: unknown): { deck: string; qid: string } {
  const s = normalizeDeckName(raw)
  const at = s.lastIndexOf('#')
  if (at <= 0) return { deck: s, qid: '' }
  const deck = s.slice(0, at).trim()
  const qid = s.slice(at + 1).trim()
  if (!/^[A-Za-z]+\d+$/.test(qid)) return { deck: s, qid: '' }
  return { deck, qid }
}

/**
 * 从任务卡读澄清卷名；没有就返回空串。
 *
 * 认法（顺序固定，先结构化字段、后正文标记）：
 *   ① frontmatter `clarify`（英文键，TS 内部用）
 *   ② frontmatter `澄清`（中文键，文件里的真身）
 *   ③ 正文小节 `## 澄清问卷` 的下一行（`deckToCards` 落卡写的就是这种）
 *   ④ 正文行内 `澄清问卷：<卷>`（旧写法 / 人手写）
 */
export function clarifyOf(input: ClarifySource | null | undefined): string {
  const fm = (input && input.fm) || {}
  const direct = normalizeDeckName(fm.clarify ?? (fm as any)['澄清'])
  if (direct) return direct

  const body = String((input && input.body) || '').replace(/\r\n/g, '\n')
  if (!body) return ''

  // ③ 小节形态：标题行之后的第一行非空内容
  const sec = /^#{1,6}[ \t]*澄清问卷[^\n]*\n([\s\S]*)$/m.exec(body)
  if (sec) {
    for (const line of sec[1].split('\n')) {
      const t = normalizeDeckName(line)
      if (!t) continue
      if (/^#/.test(t)) break        // 撞到下一节标题 = 本节是空的
      return t
    }
  }

  // ④ 行内形态：必须带冒号，否则 `## 澄清问卷` 这类标题会被误当卷名
  const inline = /澄清问卷\s*[：:]\s*([^\s\n]+)/.exec(body)
  if (inline) return normalizeDeckName(inline[1])
  return ''
}
