/**
 * 问卷「出卷」规格 → Markdown（2026-11-08）
 *
 * 为什么需要它：方寸的问卷一直是 **agent 写的**（`task-data/questionnaires/*.md`），
 * 但 agent 侧此前**没有任何出卷通道** —— 只能靠人把格式抄给它，抄歪一个破折号整题就丢。
 * 于是“让 AI 出问卷”这件事在数据上是成立的，在链路上是断的。
 *
 * 这一层只做两件事：
 *   ① `validateDeckSpec`：按暮雨 2026-11-05 认下的两条硬规矩机检
 *      —— **没写代价的选项不许进卷**、**没验收线的题不许出**；
 *   ② `buildDeckMarkdown`：吐成 `shared/questionnaire.ts` 能直接解析的格式
 *      （`## S1 题名` + 题干 + `- **A. 标题**——是什么；代价`+ 【看一眼】【出处】【验收线】）。
 *
 * 纯函数、零依赖 —— 用例直接喂规格断言，不经过 Electron。
 */

export interface QnOptSpec {
  /** A / B / C（单个字母或 1-3 位字母数字） */
  k: string
  /** 选项标题 */
  t: string
  /** 说明：**必须写“这是什么 + 选它要付什么”**，空 = 不合格 */
  d?: string
}

export interface QnItemSpec {
  /** 题号：`S1` / `M2`（解析器只认 `## <字母><数字>`） */
  id: string
  /** 导航名（左栏显示） */
  nav?: string
  /** 题干（可缺，但缺了人不知道在问什么） */
  ask?: string
  options: QnOptSpec[]
  /** 参照物 / 入口（可选） */
  look?: string
  /** 证据来源（可选） */
  src?: string
  /** 验收线：**必填** —— 事后校验的唯一依据 */
  line?: string
}

export interface QnDeckSpec {
  /** 卷标题；含「宪法层 / 裁决层 / 预埋」时解析器会自动标层 */
  title: string
  /** 归属项目 id（只写进正文，不进 frontmatter） */
  project?: string
  /** 使用边界；缺省给一句标准话术 */
  boundary?: string
  questions: QnItemSpec[]
  /** 文件名（不含 .md）；缺省从标题派生 */
  deck?: string
}

export interface QnSpecIssue {
  /** 题号（卷级问题为空串） */
  id: string
  /** 一句话说清 */
  msg: string
}

const RE_ID = /^[A-Za-z]+\d+$/
const RE_OPT_KEY = /^[A-Za-z0-9]{1,3}$/
// ⚠ 这里不许写任何具体人名：方寸要发布（和隔壁同类产品一样），写死名字 = 别人拿到就看见“给暮雨答”。
const DEFAULT_BOUNDARY = '给你答（点选 / 否决 / 反问）；答案要你批准后才落决策卡。'

/**
 * 机检一份出卷规格。
 *
 * 判据（每一条都能被用例精确打红）：
 *   · 卷必须有标题、至少 1 道题；
 *   · 题号必须能被解析器认出来（`## S1`），且卷内不重复；
 *   · 每题 ≥2 个互斥选项，选项键不重复，标题与**代价**都不许空；
 *   · 每题的【验收线】必填 —— 空着就等于事后没得校验。
 */
export function validateDeckSpec(spec: QnDeckSpec): QnSpecIssue[] {
  const out: QnSpecIssue[] = []
  const s = spec || ({} as QnDeckSpec)
  if (!String(s.title || '').trim()) out.push({ id: '', msg: '卷标题为空' })
  const qs = Array.isArray(s.questions) ? s.questions : []
  if (!qs.length) out.push({ id: '', msg: '一道题都没有' })
  const seen = new Set<string>()
  for (const q of qs) {
    const id = String(q?.id || '').trim()
    if (!RE_ID.test(id)) {
      out.push({ id, msg: '题号必须是「字母+数字」（如 S1 / M2）—— 解析器只认 `## <字母><数字>`' })
      continue
    }
    if (seen.has(id.toUpperCase())) out.push({ id, msg: '题号重复' })
    seen.add(id.toUpperCase())
    const opts = Array.isArray(q.options) ? q.options : []
    if (opts.length < 2) out.push({ id, msg: `只有 ${opts.length} 个选项（至少 2 个互斥选项）` })
    const keys = new Set<string>()
    for (const o of opts) {
      const k = String(o?.k || '').trim().toUpperCase()
      if (!RE_OPT_KEY.test(k)) out.push({ id, msg: `选项键「${o?.k || ''}」不合法（单个字母/数字）` })
      if (keys.has(k)) out.push({ id, msg: `选项键 ${k} 重复` })
      keys.add(k)
      if (!String(o?.t || '').trim()) out.push({ id, msg: `选项 ${k || '?'} 没写标题` })
      // 暮雨 11-05 原话认可的第一条：没写代价的选项不许进卷
      if (!String(o?.d || '').trim()) out.push({ id, msg: `选项 ${k || '?'} 没写代价（只写“是什么”不够）` })
    }
    if (!String(q?.line || '').trim()) out.push({ id, msg: '没写【验收线】—— 事后拿什么判违约' })
  }
  return out
}

/** 卷名 → 文件名（去路径、去非法字符；解析器按文件名去后缀当卷名） */
export function deckNameOf(spec: QnDeckSpec): string {
  const raw = String(spec?.deck || spec?.title || '').trim() || '问卷'
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[.。\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned || '问卷'
}

/** 一键吐 Markdown（必须先过 validateDeckSpec；这里不做二次把关） */
export function buildDeckMarkdown(spec: QnDeckSpec): string {
  const L: string[] = []
  const today = new Date()
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  // 2026-11-10：旧卷标题里已经带过日期（`…（2026-11-09）`），再拼一次就是
  // 「（2026-11-09）（2026-11-09）」—— 列表里一排卷全是双日期，认不出新旧。
  const rawTitle = String(spec.title || '问卷').trim()
  const title = /[（(]\d{4}-\d{2}-\d{2}[）)]\s*$/.test(rawTitle) ? rawTitle : `${rawTitle}（${day}）`
  L.push(`# ${title}`)
  L.push('')
  if (spec.project) L.push(`**项目**：${spec.project}`)
  L.push(`**使用边界**：${String(spec.boundary || '').trim() || DEFAULT_BOUNDARY}`)
  L.push('')
  for (const q of spec.questions || []) {
    const id = String(q.id || '').trim()
    const nav = String(q.nav || '').trim()
    L.push(`## ${id}${nav ? ' ' + nav : ''}`)
    const ask = String(q.ask || '').trim()
    if (ask) L.push(ask)
    for (const o of q.options || []) {
      const k = String(o.k || '').trim().toUpperCase()
      const t = String(o.t || '').trim()
      const d = String(o.d || '').trim()
      L.push(`- **${k}. ${t}**——${d}`)
    }
    if (String(q.look || '').trim()) L.push(`【看一眼】${String(q.look).trim()}`)
    if (String(q.src || '').trim()) L.push(`【出处】${String(q.src).trim()}`)
    if (String(q.line || '').trim()) L.push(`【验收线】${String(q.line).trim()}`)
    L.push('')
  }
  return L.join('\n')
}
