/**
 * 澄清闸（2026-11-09）—— 「判断半」的硬锁
 *
 * 由来：暮雨 2026-11-09 拍板
 *   · 闸门硬度 = **硬锁**：不过澄清问卷的规划草稿 / 阶段卡 / 施工单，锁状态、进不了队列；
 *   · 「零问题」= 所有相关旧题都已答且无未决冲突才算过（D-060，选 B）；
 *   · 闸必须落在**写路径**里判 —— 提示词约束已经实测无效（AI 不问不读）。
 *
 * 判定（一条都不许放宽）：
 *   ① 必须带卷（deck）；没带 = 拿猜测当结论；
 *   ② 卷必须存在、能解析、归属项目对得上；
 *   ③ 答案必须**已批准**（草稿不算：没批准就关掉 = 什么都没发生）；
 *   ④ 不许有未答 / 跳过 / 反问（跳过 = 下次还问；反问 = 这题问错了）；
 *   ⑤ 整卷全是否决/作废 = 等于没问，闸不开（“真草稿不存在零含糊”）。
 *
 * S2 会在这上面加“跨卷旧题是否都答完”的检查（D-060 的后半句）。
 */
import { getDeck, projectForDeck } from './questionnaires'
import { openBank, bankLoadError } from './questionBank'
import { splitClarify } from '../../shared/clarify'

export interface QnGateResult {
  ok: boolean
  error?: string
  deck?: string
  project?: string
  total?: number
  answered?: number
  /** 还没定的题（未答 / 跳过 / 反问） */
  open?: { id: string; nav: string }[]
  /** 整卷都被否决/作废（等于没问） */
  allClosed?: boolean
}

export function gateForDeck(deckName: string, project?: string): QnGateResult {
  // `澄清: <卷>#<题号>` 也会被调到这里（调用方忘了拆）—— 拆掉题号再按整卷判，
  // 这样“整卷没过”仍然会拦，不会因为多了个后缀就查不到卷。
  const name = String(splitClarify(deckName).deck || deckName || '').trim()
  const want = String(project || '').trim()
  if (!name) {
    return { ok: false, error: '必须附澄清问卷（deck）—— 没问过就出单 = 把猜测当结论' }
  }
  const g = getDeck(name)
  if (!g.ok || !g.parsed) return { ok: false, error: g.error || `读不到问卷：${name}` }
  const parsed = g.parsed
  const deckProject = projectForDeck(name, parsed)
  if (want && deckProject && deckProject !== want) {
    return { ok: false, error: `这卷属于「${deckProject}」，不是「${want}」—— 别拿别的项目的答案当依据` }
  }
  if (!parsed.questions.length) {
    return { ok: false, error: `卷《${name}》一道题都没有 —— 空的不是澄清` }
  }

  const answers = g.answers || {}
  const open: { id: string; nav: string }[] = []
  let answered = 0
  let closed = 0
  for (const q of parsed.questions) {
    const a = answers[q.id]
    if (a && (a.kind === 'pick' || a.kind === 'amend')) answered++
    else if (a && (a.kind === 'reject' || a.kind === 'void')) closed++
    // 没答 / 跳过 / 反问 都算“没定”：跳过是下次还问，反问是这题问错了
    else open.push({ id: q.id, nav: String(q.nav || q.ask || q.id) })
  }
  if (closed === parsed.questions.length) {
    return {
      ok: false, allClosed: true, deck: name, project: deckProject,
      total: parsed.questions.length,
      error: `卷《${name}》全部被否决/作废 —— 等于没问，闸不开（真草稿不存在零含糊）`,
    }
  }
  if (open.length) {
    return {
      ok: false, deck: name, project: deckProject, total: parsed.questions.length, answered, open,
      error: `卷《${name}》还有 ${open.length} 道没定（未答 / 跳过 / 反问）：${open.map((x) => x.id).join('、')}`
        + ' —— 答完并批准，再出单',
    }
  }
  if (!g.approvedAt) {
    return { ok: false, deck: name, project: deckProject, total: parsed.questions.length, answered, error: `卷《${name}》还没批准 —— 草稿答案不算数，先点「批准并落库」` }
  }
  // D-060（选 B）：零问题 = **所有相关旧题都已答且无未决冲突**，不是“这张卷答完就行”。
  const target = want || deckProject
  const undone = openBank(target)
  // 题库读失败 ≠ 题库是空的：后者是“没有待答”，前者是“判不了”。
  // 静默放行会让闸在最需要它的时候失效（2026-11-11 评审抓到）。
  const bankErr = bankLoadError()
  if (bankErr) {
    return {
      ok: false, deck: name, project: deckProject,
      error: `题库（task-data/question-bank.md）读不出来：${bankErr} —— 判不了“有没有待答旧题”，先修题库`,
    }
  }
  if (undone.length) {
    return {
      ok: false, deck: name, project: deckProject, total: parsed.questions.length, answered,
      open: undone.map((e) => ({ id: e.id, nav: e.ask })),
      error: `题库里还有 ${undone.length} 道相关旧题没答：${undone.map((e) => e.id).join('、')}`
        + ' —— 先答完（D-060：所有相关旧题都已答且无未决冲突才算过）',
    }
  }
  return { ok: true, deck: name, project: deckProject, total: parsed.questions.length, answered }
}

/**
 * 题目级澄清（2026-11-11）：`澄清: <卷>#<题号>` 的判法。
 *
 * 场景：问卷只答了 S3，用户点「落成任务卡」为 S3 落了一张卡 —— 这张卡押的是 **S3 的答案**，
 * 不是整卷。按整卷判会把它锁死（其余题还挂着）；按“一题都不看”又不是闸。
 * 判据：卷存在 / 卷已批准 / 这道题有**真答案**（打勾或改一句且有内容）/ 项目对得上。
 * 题库里其它待答题不参与这一级（那是整卷闸的事，见 gateForDeck 的 D-060 段）。
 */
export function gateForQuestion(deckName: string, qid: string, project?: string): QnGateResult {
  const name = String(splitClarify(deckName).deck || deckName || '').trim()
  const q = String(qid || '').trim()
  const want = String(project || '').trim()
  if (!name) return { ok: false, error: '必须附澄清问卷（deck）—— 没问过就出单 = 把猜测当结论' }
  if (!q) return gateForDeck(name, want)
  const g = getDeck(name)
  if (!g.ok || !g.parsed) return { ok: false, error: g.error || `读不到问卷：${name}` }
  const parsed = g.parsed
  const deckProject = projectForDeck(name, parsed)
  if (want && deckProject && deckProject !== want) {
    return { ok: false, error: `这卷属于「${deckProject}」，不是「${want}」—— 别拿别的项目的答案当依据` }
  }
  const item = parsed.questions.find((x) => String(x.id) === q)
  if (!item) return { ok: false, error: `卷《${name}》里没有题 ${q} —— 卡上写的澄清题号对不上` }
  if (!g.approvedAt) {
    return { ok: false, deck: name, project: deckProject, total: parsed.questions.length, error: `卷《${name}》还没批准 —— 草稿答案不算数，先点「批准并落库」` }
  }
  const a = (g.answers || {})[q]
  const settled = a && (a.kind === 'pick' || (a.kind === 'amend' && !!(a.text || '').trim()))
  if (!settled) {
    const why = !a ? '还没答' : a.kind === 'amend' ? '改一句但没写内容' : `答案是「${a.kind}」`
    return {
      ok: false, deck: name, project: deckProject, total: parsed.questions.length,
      open: [{ id: q, nav: String(item.nav || item.ask || q) }],
      error: `卷《${name}》的 ${q} 没有定下来的答案（${why}）—— 先答这题并批准，再落卡`,
    }
  }
  return { ok: true, deck: name, project: deckProject, total: parsed.questions.length, answered: 1 }
}
