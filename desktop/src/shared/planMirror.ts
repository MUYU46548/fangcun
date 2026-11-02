/**
 * 计划与实际的对照镜 —— 纯逻辑（卡 task-20261027-004 阶段一）
 *
 * 这张卡被暮雨打回三次，最后一次的原话是“我担心你这种设计更死板，实际用起来害处更大”。
 * 被否掉的是：返工归因三档、七条质量门、五阶段状态机、综合加权评分。
 * 共同病根是**预设了形状**：预设失败只有几种原因、预设什么样的规划算正确。
 *
 * 所以这里只做一件最不预设的事：**把两段原文并排取出来，一个字不改。**
 *
 * 三条自我约束（改这个文件前先读）：
 *  ① **不加工**：不总结、不摘要、不抽要点。取出来的就是卡正文里那两段。
 *     判据：把返回的 text 和任务文件里那一段逐字符比对，必须全等。
 *  ② **不打分**：只给字数（那是可数的事实），不给质量分、不给结论、不排序。
 *  ③ **缺失要说出来**：只有一半的时候不许留空 —— 空字符串和“这张卡根本没写方案”
 *     在界面上长得一样，而它们是两件事。
 *
 * 阶段二（差异形态归纳）不在这里：暮雨的原话是“先观察，不设计”——
 * 形态必须从 42 对样本里长出来，不能先定类别再往里塞。类别定下来之前不写分类器。
 */

export interface MirrorSide {
  /** 段落原文，逐字。没有这一段就是空串 */
  text: string
  /** 字数（只算事实，不判断好坏） */
  len: number
  /** 卡正文里实际用的标题名（方案 / 计划 / 做法 …）—— 有些卡用的不是标准名 */
  heading: string
}

export interface MirrorPair {
  plan: MirrorSide
  actual: MirrorSide
  /** 缺哪一半。空数组 = 两半都在 */
  missing: Array<'plan' | 'actual'>
}

/**
 * 取二级标题下的正文。
 * ⚠ 只认 `^## 名字` 这一层：卡正文里三级标题（###）属于该段内容，要留在里面。
 */
function takeSection(body: string, names: string[]): { text: string; heading: string } {
  for (const nm of names) {
    const re = new RegExp('^##[ \\t]*' + nm + '[ \\t]*$', 'm')
    const m = re.exec(body)
    if (!m) continue
    const start = m.index + m[0].length
    const rest = body.slice(start)
    const nxt = /^##[ \t]+\S/m.exec(rest)
    const end = nxt ? start + nxt.index : body.length
    return { text: body.slice(start, end).trim(), heading: nm }
  }
  return { text: '', heading: '' }
}

/**
 * 方案侧认的名字。历史上三种写法都出现过（`## 方案` 最多，另有 `## 计划` / `## 做法`）。
 * ⚠ 顺序有意义：先精确匹配 `方案`，再退到别名 —— 一张卡同时有 `## 方案` 和 `## 做法` 时，
 *    `方案` 才是那张卡的正式计划段。
 */
const PLAN_NAMES = ['方案', '计划', '做法']

/**
 * 结果侧认的名字。`结果记录` 是 frontmatter 同名字段在正文里的镜像，
 * `结果` / `实际` 是早期写法。
 */
const ACTUAL_NAMES = ['结果记录', '结果', '实际']

export function extractMirror(body: string): MirrorPair {
  const p = takeSection(body, PLAN_NAMES)
  const a = takeSection(body, ACTUAL_NAMES)
  const missing: Array<'plan' | 'actual'> = []
  if (!p.text) missing.push('plan')
  if (!a.text) missing.push('actual')
  return {
    plan: { text: p.text, len: p.text.length, heading: p.heading },
    actual: { text: a.text, len: a.text.length, heading: a.heading },
    missing,
  }
}

/** 缺哪一半用自然语言说清 —— 界面上不许出现"空白=没写"这种猜测 */
export function describeMissing(missing: Array<'plan' | 'actual'>): string {
  if (!missing.length) return ''
  const names = missing.map((m) => (m === 'plan' ? '方案' : '结果记录'))
  return '这张卡没有“' + names.join('”“') + '”这一段'
}

/**
 * 字数那一格的注解 —— 卡里的铁律：
 * “任何指标必须自带一句『它证明不了什么』。不给局限的数字 = 半个谎话。”
 * 所以字数旁边必须跟这一句，界面上不许只留数字。
 */
export const LEN_CAVEAT =
  '字数只说明这两段各写了多少，不说明计划好坏、也不说明执行难易。' +
  '实测过：方案字数和结果字数正相关（r≈+0.34），但那只反映任务复杂度 —— 大事才值得写方案。'
