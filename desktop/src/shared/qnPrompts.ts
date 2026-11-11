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
  kind: 'pick' | 'skip' | 'reject' | 'askback' | 'amend' | 'void' | 'self'
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
      // 作废的题不算“还没定”——它明确不作数了。混进 open 会让施工单里多出一堆"待定"。
      if (a.kind === 'void') return false
      return a.kind === 'skip'
    })
    .map((q) => ({ id: q.id, nav: String(q.nav || q.ask || '') }))
}

/** 已作废的项（当时答过、现在不作数）—— 出施工单时单列，防 agent 又拿旧答案当依据 */
export function voidedOf(
  questions: QItemLike[],
  answers: Record<string, QAnsLike>
): { id: string; nav: string; why: string }[] {
  return questions
    .filter((q) => {
      const a = answers[q.id]
      return !!(a && a.kind === 'void')
    })
    .map((q) => ({ id: q.id, nav: String(q.nav || q.ask || ''), why: String(answers[q.id].text || '') }))
}

function optLine(o: QOptLike): string {
  const d = String(o.d || '').trim()
  return `   - ${o.k}. ${o.t}${d ? ` —— ${d}` : ''}`
}

/** 没有写“代价”的选项（说明段为空）。
 *  暮雨 11-05 认可的第一条：「没写代价的选项不许进卷」——
 *  他看得见"这是什么"、看不见"选它要付什么"，等于在黑暗里选。 */
export function costGapsOf(questions: QItemLike[]): { id: string; k: string; t: string }[] {
  const out: { id: string; k: string; t: string }[] = []
  for (const q of questions) {
    for (const o of q.options || []) {
      if (!String(o.d || '').trim()) out.push({ id: q.id, k: o.k, t: o.t })
    }
  }
  return out
}

/**
 * 「重出题 / 补代价」提示词。
 *
 * 两条来由（都是他 11-05 亲口认可的补充）：
 *   ① 反问 —— “题问错了”；
 *   ② **没写代价的选项** —— 不许进卷。补代价是出卷人的活，不是答的人的活（他只能"改一句"，那是推翻框架的口子）。
 *
 * 三条硬要求写进提示词里，因为它们正是 4 份样本反复强调、而 agent 最容易偷懒的地方：
 *   ① 反问说的是“题问错了”，不是“选项不够”—— 先想清楚他为什么这么问；
 *   ② 每个选项必须有“是什么 + 代价”，缺代价就等于让人在黑暗里选；
 *   ③ 格式照旧（否则方寸解析不了，下一轮又白问）。
 */
export function buildRewritePrompt(opts: PromptOpts): string {
  const asks = askbacksOf(opts.questions, opts.answers)
  const gaps = costGapsOf(opts.questions)
  const who = opts.project ? `项目「${opts.project}」` : '这个项目'
  // 两样都没有就返回空串让调用方显式处理 —— 不编一段假提示词（"没有可重出的东西"必须说出来）
  if (!asks.length && !gaps.length) return ''
  const L: string[] = []
  const parts: string[] = []
  if (asks.length) parts.push(`${asks.length} 道题被**反问**了`)
  if (gaps.length) parts.push(`${gaps.length} 个选项**没写代价**`)
  L.push(`你在给${who}出问卷。上一卷《${opts.title || opts.deck}》里有${parts.join('、')}。`)
  if (asks.length) {
    L.push('反问的意思不是“选项不够”，是**这题问错了**：真问题在别处。')
  }
  L.push('')
  L.push(`原卷在 \`${opts.path || `task-data/questionnaires/${opts.deck}.md`}\`，先读一遍再动手。`)
  if (asks.length) {
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
      L.push(`**你的反问**：${text}`)
    })
  }
  if (gaps.length) {
    L.push('')
    L.push('## 没写代价的选项（补上“选它要付什么”）')
    L.push('这些选项只写了“这是什么”，没写“代价”。他答的时候看不见代价，等于在黑暗里选 ——')
    L.push('**不许删选项**（删了他想选就选不到），把代价补齐即可：')
    const byQ = new Map<string, { k: string; t: string }[]>()
    for (const g of gaps) {
      if (!byQ.has(g.id)) byQ.set(g.id, [])
      byQ.get(g.id)!.push({ k: g.k, t: g.t })
    }
    for (const [qid, list] of byQ) {
      L.push(`- **${qid}**：${list.map((x) => `${x.k}. ${x.t}`).join('；')}`)
    }
  }
  L.push('')
  L.push('## 要你做什么')
  const steps: string[] = []
  if (asks.length) {
    steps.push(`**只重写上面这 ${asks.length} 道题**，别把整卷重发一遍 —— 其余题他没意见。`)
    steps.push('先想清楚他为什么这么问：反问往往指出“整道题的前提错了”。如果确实问错了，'
      + '就换一个真问题；如果只是问法不清楚，把题意写得更直白。**不要把他的反问降级成一个选项。**')
  } else {
    steps.push('**只补代价，别动题目结构** —— 他没对题目提意见，只是这些选项缺代价。')
  }
  steps.push('每题 2–4 个**互斥**选项；每个选项必须写清“这是什么 + 代价是什么”，只写名词的选项等于没给。')
  steps.push('保住【看一眼】【出处】【验收线】三段。没【验收线】的题不许出 —— 那句话是事后校验唯一依据。')
  steps.forEach((s, i) => L.push(`${i + 1}. ${s}`))

  L.push(`${steps.length + 1}. 输出格式照旧，方寸要能解析：`)
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
  L.push(`${steps.length + 2}. 写成 md 放到 \`task-data/questionnaires/\` 下（文件名别覆盖原卷，建议 \`${opts.deck}-v2.md\`），`)
  L.push('   放好之后告诉用户“可以答了”。')
  return L.join('\n') + '\n'
}

/**
 * 「出一份新问卷」提示词（2026-11-08）
 *
 * 来由：暮雨原话——“方寸依然不会主动发问卷，怎么让 AI 出问卷？”
 * 真相是**链路断了**：问卷本来就是 agent 写的，但 agent 侧没有出卷入口，
 * 也没人告诉它格式（破折号写法差一点整题就丢）。现在方寸开了 `qn_propose`，
 * 这段提示词负责把“什么时候该出卷、每题必须带什么”讲清楚。
 *
 * 三条硬要求都来自已经吃过亏的地方：
 *   ① 每个选项必须有代价（他看不见代价就等于在黑暗里选）；
 *   ② 每题必须有验收线（事后校验的唯一依据）；
 *   ③ 只问真取舍 —— 能自己查证的事不许拿去问他。
 */
export function buildDeckAuthoringPrompt(opts?: { project?: string; focus?: string }): string {
  const who = opts?.project ? `项目「${opts.project}」` : '当前项目'
  const L: string[] = []
  L.push(`请你给${who}出一份问卷，交给用户在方寸的「问卷」页答。`)
  if (opts?.focus) L.push(`这一轮要弄清楚的事：${opts.focus}`)
  L.push('')
  L.push('## 什么时候该出卷（不是让你随便出）')
  L.push('- 有几个**互斥的取舍**只有他能定（做 A 还是做 B、先修这个还是先发版），聊天里问一句答不清；')
  L.push('- 你已经把材料读完了，问题背后有事实依据；')
  L.push('- 能自己查证的事（代码里有没有、文档怎么写的）**不许拿去问** —— 那是你没干活。')
  L.push('')
  L.push('## 怎么出一份能用的问卷')
  L.push('1. 每题 2–4 个**互斥**选项；每个选项写清“这是什么 + 选它要付什么代价”，只写名词的选项等于没给；')
  L.push('2. 每题必须有【验收线】：选了它之后，什么情况算违约（事后拿这句话校验）；')
  L.push('3. 有依据的题带上【出处】；需要他去看一眼的，带【看一眼】入口；')
  L.push('4. 拿不准的别硬问，写进“预埋”说明它现在答不了（缺什么 / 什么时候能答）。')
  L.push('')
  L.push('## 落盘方式（别手写 md，走工具）')
  L.push('调方寸的 `qn_propose`，传 title + questions[]：')
  L.push('```json')
  L.push('{ "title": "项目名-裁决层A", "project": "项目id",')
  L.push('  "questions": [')
  L.push('    { "id": "S1", "nav": "最终形态", "ask": "做一件还是两件？",')
  L.push('      "options": [ { "k": "A", "t": "分两件", "d": "抄业界主流；代价是联调成本翻倍" },' )
  L.push('                   { "k": "B", "t": "一体化", "d": "上手快；代价是后期拆不动" } ],')
  L.push('      "src": "四问总表§一", "line": "落档后跨形态派单的任务卡一律打回" } ] }')
  L.push('```')
  L.push('机检不过会被拒（一个字节都不写）：选项缺代价、题目缺验收线、题号不是字母+数字。')
  L.push('')
  L.push('出完告诉他：“问卷已放到问卷页，共 N 题等你答”。**不要**在聊天里把题目再问一遍。')
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
  L.push(`你在给${who}出施工单。决策已经由用户在问卷《${opts.title || opts.deck}》里定下来了，`)
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
    L.push('这些题用户跳过或没答。施工单里遇到它们必须显式标成“待定”，')
    L.push('或者绕开、先做不受影响的部分：')
    open.forEach((o) => L.push(`- ${o.id} ${o.nav}`))
  }
  const voided = voidedOf(opts.questions, opts.answers)
  if (voided.length) {
    L.push('')
    L.push('## 已作废的（曾经这么定过，现在不作数 —— 别再拿它当依据）')
    voided.forEach((o) => L.push(`- ${o.id} ${o.nav}${o.why ? `（作废原因：${o.why}）` : ''}`))
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
