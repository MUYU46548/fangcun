/**
 * 问卷的两份“出口提示词”（2026-11-05）
 *
 * 为什么需要它们：
 *   暮雨原话——“反问往往才是戳破迷雾、一锤定音的”。可反问在界面上只记了一句话，
 *   谁来拿它重写题？没有出口的话，「问题清单」只是另一个记录文件（这是我在原型评审时
 *   自己指出的最大闭环缺口）。所以这里把反问**打包成一段可直接粘给 agent 的提示词**。
 *
 * 两个出口，方向相反、时机不同：
 *   · `buildRewritePrompt` —— 有反问时。拿“反问 + 原题 + 出处 + 验收线”去让 agent **重出题**。
 *     这一轮往往比原卷更接近真问题。
 *   · `buildWorkOrderPrompt` —— 没有反问、整卷答完时。拿答卷去让 agent **出施工单**。
 *     ⚠ 有反问就**不许**给这个：问题还没定，出的单必然是错的（这正是“问卷不是施工单”的意思）。
 *
 * 纯函数、零依赖 —— `e2e-questionnaire-prompt.cjs` 直接喂数据验正反。
 */

export interface QOptLike { k: string; t: string; d?: string }
export interface QItemLike {
  id: string
  nav?: string
  ask?: string
  options?: QOptLike[]
  src?: string
  line?: string
  look?: string
}
export interface QAnsLike {
  kind: 'pick' | 'skip' | 'reject' | 'askback' | 'amend'
  k?: string
  text?: string
}

export interface PromptOpts {
  /** 卷名（文件名去后缀），提示词里要写清“改的是哪一卷” */
  deck: string
  /** 卷标题 */
  title: string
  /** 问卷原文路径（让 agent 去读原卷，而不是靠这段摘要猜） */
  path?: string
  /** 项目名（agent 需要知道给谁出题） */
  project?: string
  questions: QItemLike[]
  answers: Record<string, QAnsLike>
}

/** 被反问的题（有实际内容的才算 —— 留空按界面的语义等同否决，不进这里） */
export function askbacksOf(
  questions: QItemLike[],
  answers: Record<string, QAnsLike>
): { q: QItemLike; text: string }[] {
  const out: { q: QItemLike; text: string }[] = []
  for (const q of questions) {
    const a = answers[q.id]
    if (!a || a.kind !== 'askback') continue
    const text = String(a.text || '').trim()
    if (!text) continue
    out.push({ q, text })
  }
  return out
}

/** 已答的题（打勾 / 改一句）—— “定下来的东西”，出施工单时要用 */
export function settledOf(
  questions: QItemLike[],
  answers: Record<string, QAnsLike>
): { q: QItemLike; label: string; line: string }[] {
  const out: { q: QItemLike; label: string; line: string }[] = []
  for (const q of questions) {
    const a = answers[q.id]
    if (!a) continue
    if (a.kind === 'pick') {
      const o = (q.options || []).find((x) => x.k === a.k)
      out.push({ q, label: `${a.k || ''}. ${o ? o.t : ''}`.trim(), line: String(q.line || '') })
      continue
    }
    if (a.kind === 'amend' && String(a.text || '').trim()) {
      out.push({ q, label: String(a.text).trim(), line: String(q.line || '') })
    }
  }
  return out
}

/** 没定下来的（跳过 / 未答）—— 出施工单前必须点出来，否则 agent 会自己拍脑袋 */
export function openOf(
  questions: QItemLike[],
  answers: Record<string, QAnsLike>
): { id: string; nav: string }[] {
  return questions
    .filter((q) => {
      const a = answers[q.id]
      if (!a) return true
      return a.kind === 'skip'
    })
    .map((q) => ({ id: q.id, nav: String(q.nav || q.ask || '') }))
}

function optLine(o: QOptLike): string {
  const d = String(o.d || '').trim()
  return `   - ${o.k}. ${o.t}${d ? ` —— ${d}` : ''}`
}

/**
 * 「重出题」提示词（有反问时）。
 *
 * 三条硬要求写进提示词里，因为它们正是 4 份样本反复强调、而 agent 最容易偷懒的地方：
 *   ① 反问说的是“题问错了”，不是“选项不够”—— 先想清楚他为什么这么问；
 *   ② 每个选项必须有“是什么 + 代价”，缺代价就等于让人在黑暗里选；
 *   ③ 格式照旧（否则方寸解析不了，下一轮又白问）。
 */
export function buildRewritePrompt(opts: PromptOpts): string {
  const asks = askbacksOf(opts.questions, opts.answers)
  const who = opts.project ? `项目「${opts.project}」` : '这个项目'
  if (!asks.length) {
    // 不该被调到（界面只在有反问时给这个入口）；返回空串让调用方显式处理，不编一段假提示词
    return ''
  }
  const L: string[] = []
  L.push(`你在给${who}出问卷。上一卷《${opts.title || opts.deck}》里有 ${asks.length} 道题被**反问**了 ——`)
  L.push('反问的意思不是“选项不够”，是**这题问错了**：真问题在别处。')
  L.push('')
  L.push(`原卷在 \`${opts.path || `task-data/questionnaires/${opts.deck}.md`}\`，先读一遍再动手。`)
  L.push('')
  L.push('## 被反问的题')
  asks.forEach(({ q, text }) => {
    L.push('')
    L.push(`### ${q.id} ${q.nav || ''}`.trim())
    if (q.ask) L.push(`原题：${q.ask}`)
    const opts2 = q.options || []
    if (opts2.length) {
      L.push('原选项：')
      opts2.forEach((o) => L.push(optLine(o)))
    }
    if (q.src) L.push(`原【出处】：${q.src.split('\n')[0]}`)
    if (q.line) L.push(`原【验收线】：${q.line.split('\n')[0]}`)
    L.push(`**暮雨的反问**：${text}`)
  })
  L.push('')
  L.push('## 要你做什么')
  L.push(`1. **只重写上面这 ${asks.length} 道题**，别把整卷重发一遍 —— 其余题他没意见。`)
  L.push('2. 先想清楚他为什么这么问：反问往往指出“整道题的前提错了”。如果确实问错了，')
  L.push('   就换一个真问题；如果只是问法不清楚，把题意写得更直白。**不要把他的反问降级成一个选项。**')
  L.push('3. 每题 2–4 个**互斥**选项；每个选项必须写清“这是什么 + 代价是什么”，')
  L.push('   只写名词的选项等于没给。')
  L.push('4. 保住【看一眼】【出处】【验收线】三段。没【验收线】的题不许出 —— 那句话是事后校验唯一依据。')
  L.push('5. 输出格式照旧，方寸要能解析：')
  L.push('')
  L.push('```md')
  L.push('## S1 题名')
  L.push('题干一句话')
  L.push('- **A. 选项标题**——这是什么；代价是什么')
  L.push('- **B. 选项标题**——这是什么；代价是什么')
  L.push('【看一眼】可选：参照物或入口')
  L.push('【出处】证据来源')
  L.push('【验收线】选了它之后，什么算违约')
  L.push('```')
  L.push('')
  L.push('6. 写成 md 放到 `task-data/questionnaires/` 下（文件名别覆盖原卷，建议 `' + opts.deck + '-v2.md`），')
  L.push('   放好之后告诉暮雨“可以答了”。')
  return L.join('\n') + '\n'
}

/**
 * 「出施工单」提示词（无反问、整卷答完时）。
 *
 * ⚠ 调用方**必须**先确认没有反问 —— 有这个函数不代表可以跳过那个判断。
 *   本函数也会自己再拦一次（有反问就返回空串），因为“问题没定就出单”代价太大。
 */
export function buildWorkOrderPrompt(opts: PromptOpts): string {
  if (askbacksOf(opts.questions, opts.answers).length) return ''
  const settled = settledOf(opts.questions, opts.answers)
  const open = openOf(opts.questions, opts.answers)
  const who = opts.project ? `项目「${opts.project}」` : '这个项目'
  if (!settled.length) return ''
  const L: string[] = []
  L.push(`你在给${who}出施工单。决策已经由暮雨在问卷《${opts.title || opts.deck}》里定下来了，`)
  L.push('**不要再问一遍，也不要替他重新权衡** —— 直接把“要什么”翻成“怎么做”。')
  L.push('')
  L.push('## 已定的（照这个做）')
  settled.forEach((s) => {
    L.push(`- **${s.q.id}** ${s.q.nav || ''}`.trim())
    L.push(`  - 选择：${s.label}`)
    if (s.line) L.push(`  - 验收线：${s.line.split('\n')[0]}`)
  })
  if (open.length) {
    L.push('')
    L.push('## 还没定的（**不许自己拍**）')
    L.push('这些题暮雨跳过或没答。施工单里遇到它们必须显式标成“待定”，')
    L.push('或者绕开、先做不受影响的部分：')
    open.forEach((o) => L.push(`- ${o.id} ${o.nav}`))
  }
  L.push('')
  L.push('## 施工单要求')
  L.push('1. 按可独立验收的**小步**拆，每步一句话说清“做完什么样”；')
  L.push('2. 每步带**验收办法**（怎么验、验什么、谁来验）—— 问卷里的【验收线】原样搬进来，不许改写；')
  L.push('3. 不许出现“优化一下”“完善相关逻辑”这种没法验收的条目；')
  L.push('4. 有前置依赖的写明依赖，不要藏在正文里；')
  L.push('5. 最后单列“不做”的清单（这次明确不做的），免得下次又被当成遗漏。')
  return L.join('\n') + '\n'
}
