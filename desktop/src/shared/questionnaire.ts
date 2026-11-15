/**
 * 问卷解析（2026-11-05）—— 吃**手写 md**，吐结构化题目。
 *
 * 为什么不上 GUI 出题器：问卷本来就是 agent 写的（暮雨原话“我现在的问卷全都是 agent 写的”）。
 * 方寸该干的是**把 md 变成能点的东西**，而不是替 agent 出题 —— 出题那步要读遍项目材料，
 * 方寸做个表单出来只会更差。
 *
 * 格式不另发明，就按他 2026-11-04 那 4 份样本定（`references/问卷样本/`）：
 *
 * ```md
 * # 司天问卷·宪法层（2026-11-04）
 *
 * **使用边界**：给暮雨答（打勾/否决/改一句）；答案落 decision-log…
 *
 * ## S1 最终形态            ← 题号 + 导航名
 * 司天做一件还是两件？        ← 题干（可缺）
 * - **A. 生成器+编辑器分两件**——抄业界主流…
 * - **B. 一体化单件**——抄易制地图形态…
 *
 * 【出处】四问总表§一…
 * 【验收线】落档后，凡跨形态派单的司天任务卡一律打回
 * ```
 *
 * 三条容错（样本里真实出现过，不处理就会丢题）：
 *  ① **题干可以没有** —— 墨坊 M1 是 `## M1 …` 直接跟选项；
 *  ② 破折号有三种写法：`——`（两个 em dash，样本主力）/ `—` / `— `；
 *  ③ `## 裁决层预埋`、`## 看一眼·入口总表` 不是题，是**表**，要单独认。
 *
 * 纯函数、零依赖 —— `e2e-questionnaire.cjs` 直接拿 4 份真样本跑。
 */

export interface QOption {
  /** 选项键：A / B / C…（样本里就是单个大写字母） */
  k: string
  /** 选项标题（`**A. 这个**` 里的“这个”） */
  t: string
  /** 选项说明（破折号后面那段；可以是空串） */
  d: string
}

export interface QItem {
  id: string
  /** `## S1 最终形态` 里的“最终形态”，左栏用它 */
  nav: string
  /** 题干；样本里可能没有，空串就是没有 */
  ask: string
  options: QOption[]
  src: string
  line: string
  look: string
  /** 已答过（样本里写「已答过」「预填确认」这类）——界面要标成“这题答过” */
  prefilled: boolean
  prefilledNote: string
  /**
   * **我的意见**（2026-11-15 暮雨：「不要只是给我看不懂的问题，这是方寸本身也存在的问题」）。
   *
   * 病根不在"问题问得不好"，在于**卷子只给选项、不给判断** —— 于是"出一份问卷"这个动作
   * 把决策成本原样转嫁回用户，看起来像在帮忙，其实只是把题目排整齐了。
   * 所以卷面新增一行 `【意见】`：**推荐哪个 + 一句为什么**。空着是允许的（有些题我确实不知道），
   * 但空着与"没想过"是一回事，界面必须让这个区别可见（见 `QItem.opinion` 的空态处理）。
   */
  opinion: string
  /** 意见里点名推荐的那一档（`【意见】B：…` 里的 B）；认不出就空串 */
  recommend: string
}

export interface QLookRow {
  nm: string
  ds: string
  url: string
}

export interface QParked {
  q: string
  need: string
  when: string
}

export interface QDeck {
  title: string
  /** 卷面 `**项目**：xxx` 的原文（可能空）。落决策卡必须带归属，不能一律当全局。 */
  project: string
  /** 宪法层 / 裁决层（从标题里认；认不出就空串） */
  layer: string
  boundary: string
  /**
   * 取代关系：本卷取代了哪一卷（卷面 `**取代**：<旧卷>`，2026-11-11 问卷管理）。
   *
   * 为什么做在卷面而不是答案文件：卷是不可变产物，取代是**卷与卷之间**的考古事实；
   * 塞进 answers.json 会跟“谁作废了谁”混成一团。旧卷据此在列表里折叠并标「已被取代」。
   */
  supersedes?: string
  questions: QItem[]
  /** 「看一眼·入口总表」——全卷共用的一张参照表 */
  lookTable: QLookRow[]
  /** 「裁决层预埋」——不现在答的那些题 */
  parked: QParked[]
  /**
   * 预埋表的表头（原样保留）。
   * 为什么留：司天写「题 | 挂出条件 | 参照物」，墨坊写「题 | 缺什么 | 什么时候能答」——
   * 同一个位置三种说法。界面若硬编一种，另一份就变成错标题（“缺什么：两件亲跑实测后”读不通）。
   */
  parkedHead: string[]
  error?: string
}

const RE_H1 = /^#\s+(.+?)\s*$/
const RE_H2 = /^##\s+([A-Za-z]+\d+)\s*(.*)$/
const RE_H2_ANY = /^##\s+(.+?)\s*$/
/** `- **A. 标题**——说明` ：破折号三种写法都吃 */
const RE_OPT = /^[-*]\s+\*\*\s*([A-Za-z0-9]{1,3})\s*[.、]\s*(.+?)\s*\*\*\s*(?:——|—{1,2}|-{2,4})?\s*(.*)$/
const RE_FIELD = /^【(.+?)】\s*(.*)$/
const RE_TABLE_ROW = /^\|(.+)\|\s*$/

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))
}

function splitRow(line: string): string[] {
  const inner = line.replace(/^\|/, '').replace(/\|\s*$/, '')
  return inner.split('|').map((c) => c.trim())
}

/**
 * 从一段意见里认出"推荐哪一档"。
 *
 * 认的形态（都来自真实写法）：`B：…` / `B. …` / `选 B` / `推荐 B` / `建议 B`。
 * 为什么只认**开头或"选/推荐/建议"紧跟的那个字母**：意见里常出现 "不比 A 差" 这种反向提及，
 * 全文搜字母会把"提到过"当成"推荐了"—— 那会把意见指错方向，比没有意见更糟。
 * 认不出返回空串（界面据此显示"这一题我没有把握"，而不是随便点亮一个）。
 */
export function recommendOf(opinion: string): string {
  const t = String(opinion || '').trim()
  if (!t) return ''
  const head = /^([A-Za-z])[\s.、:：—-]/.exec(t)
  if (head) return head[1].toUpperCase()
  const tail = /(?:选|推荐|建议|倾向)\s*([A-Za-z])(?![A-Za-z])/.exec(t)
  if (tail) return tail[1].toUpperCase()
  // 整段只有"B"三个字符以内的情况（极简写法）
  const bare = /^([A-Za-z])$/.exec(t)
  if (bare) return bare[1].toUpperCase()
  return ''
}

/**
 * 解析一份问卷 md。
 *
 * ⚠ 一律**不抛异常**：解析失败返回 `{ questions: [], error }` —— 调用方要把错误摆到界面上。
 *   静默返回空卷 = “这卷 0 题”，用户会以为问卷丢了（方寸历史上就是被这种静默坑过）。
 */
export function parseQuestionnaire(md: string): QDeck {
  const text = String(md || '').replace(/\r\n/g, '\n')
  const deck: QDeck = {
    title: '', project: '', layer: '', boundary: '',
    questions: [], lookTable: [], parked: [], parkedHead: [],
  }
  if (!text.trim()) return { ...deck, error: '文件是空的' }

  const lines = text.split('\n')
  let cur: QItem | null = null
  /** 当前正在收「出处 / 验收线 / 看一眼 / 意见」这种跨行的字段 */
  let field: '' | 'src' | 'line' | 'look' | 'opinion' = ''
  let inLookTable = false
  let inParked = false
  let parkedHeader: string[] = []
  let inBoundary = false
  let askTaken = false

  const flush = () => {
    // ⚠ 不能只收“有选项”的：S5 那种「已答过，沿用打勾」的确认题**一个选项都没有**
    //   （样本原文就是一句“已答过：现阶段先按 Windows 11 准备…沿用打勾，变则改一句”）。
    //   按 options.length 收题会把它整题丢掉 —— 丢的恰是“不用重答”的那题，最难察觉。
    if (cur && (cur.options.length || cur.ask.trim())) deck.questions.push(cur)
    cur = null
    field = ''
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.replace(/\s+$/, '')

    // 一级标题
    const h1 = RE_H1.exec(line)
    if (h1 && !line.startsWith('##')) {
      flush()
      inBoundary = false
      deck.title = h1[1]
      if (/宪法层/.test(deck.title)) deck.layer = '宪法层'
      else if (/裁决层/.test(deck.title)) deck.layer = '裁决层'
      else if (/预埋/.test(deck.title)) deck.layer = '预埋'
      continue
    }

    // 二级标题：题 or 表
    const h2any = RE_H2_ANY.exec(line)
    if (h2any) {
      inBoundary = false      // 边界段到下一个标题为止（否则整卷会被吃进 boundary）
      const title = h2any[1]
      // 表：入口总表 / 裁决层预埋
      if (/入口总表/.test(title)) { flush(); inLookTable = true; inParked = false; continue }
      if (/预埋|摊不开/.test(title)) { flush(); inParked = true; inLookTable = false; parkedHeader = []; continue }
      const h2 = RE_H2.exec(line)
      if (!h2) { flush(); continue }   // 既不是题也不是表：跳过（比如「## 结构」说明段）
      flush()
      inLookTable = false
      inParked = false
      cur = {
        id: h2[1], nav: (h2[2] || '').trim(),
        ask: '', options: [], src: '', line: '', look: '',
        prefilled: false, prefilledNote: '', opinion: '', recommend: '',
      }
      askTaken = false
      continue
    }

    // 空行：字段与边界段都到此为止
    if (!line.trim()) { field = ''; inBoundary = false; continue }

    // 表行
    if (RE_TABLE_ROW.test(line)) {
      const cells = splitRow(line)
      if (isSeparatorRow(cells)) continue
      if (inLookTable) {
        if (/^名字|^名称/.test(cells[0] || '')) continue
        deck.lookTable.push({ nm: cells[0] || '', ds: cells[1] || '', url: cells[2] || '' })
        continue
      }
      if (inParked) {
        if (/^题/.test(cells[0] || '')) { parkedHeader = cells; deck.parkedHead = cells; continue }
        if (cells.length >= 2) deck.parked.push({ q: cells[0] || '', need: cells[1] || '', when: cells[2] || '' })
        continue
      }
      continue
    }

    // 项目（`**项目**：fangcun-base`）—— 落决策卡要带归属，不能一律当全局
    if (/^\*\*项目\*\*/.test(line)) {
      deck.project = line.replace(/^\*\*项目\*\*\s*[:：]?\s*/, '').trim()
      inBoundary = false
      continue
    }

    // 取代关系（`**取代**：<旧卷>` / `**取代：** <旧卷>`）—— 两种写法都吃
    if (/^\*\*取代\*\*/.test(line)) {
      deck.supersedes = line
        .replace(/^\*\*取代\*\*\s*[:：]?\s*/, '')
        .replace(/^\*\*取代\s*[:：]\s*\*\*\s*/, '')
        .trim()
      inBoundary = false
      continue
    }

    // 使用边界（可能跨行，到下一个 `##` 或空行两连为止）
    if (/^\*\*使用边界\*\*/.test(line)) {
      deck.boundary = line.replace(/^\*\*使用边界\*\*\s*[:：]?\s*/, '')
      inBoundary = true
      continue
    }
    if (inBoundary) {
      if (/^\*\*/.test(line)) { inBoundary = false }
      else { deck.boundary += '\n' + line.trim(); continue }
    }

    // 字段行【出处】【验收线】【看一眼】【看点】【意见】
    const f = RE_FIELD.exec(line)
    if (f) {
      const name = f[1]
      const val = f[2] || ''
      if (!cur) continue
      if (/出处/.test(name)) { cur.src = val; field = 'src' }
      else if (/验收线/.test(name)) { cur.line = val; field = 'line' }
      else if (/看一眼/.test(name)) { cur.look = val; field = 'look' }
      else if (/意见|建议|推荐/.test(name)) {
        // 【意见】B：理由…… —— 三个写法都认（意见 / 建议 / 推荐），因为写卷的是 agent，
        // 它会挑一个顺手的词；只认一个就等于让另一种写法静默失效。
        cur.opinion = val
        const r = recommendOf(val)
        if (r) cur.recommend = r
        field = 'opinion'
      }
      else field = ''
      continue
    }

    // 字段续行
    if (field && cur) {
      if (field === 'src') cur.src += '\n' + line.trim()
      else if (field === 'line') cur.line += '\n' + line.trim()
      else if (field === 'look') cur.look += '\n' + line.trim()
      else if (field === 'opinion') {
        cur.opinion += '\n' + line.trim()
        // 续行里也可能才出现选项字母（`【意见】` 单独一行、下一行写 `B —— 因为…`）
        if (!cur.recommend) {
          const r = recommendOf(cur.opinion)
          if (r) cur.recommend = r
        }
      }
      continue
    }

    // 选项
    const opt = RE_OPT.exec(line)
    if (opt && cur) {
      cur.options.push({ k: opt[1].toUpperCase(), t: opt[2].trim(), d: (opt[3] || '').trim() })
      continue
    }

    // 题干：选项之前的第一段非空文字
    if (cur && !askTaken && !cur.options.length && !/^[>|]/.test(line)) {
      cur.ask = line.trim()
      askTaken = true
      // 「已答过 / 预填」这类题：题干里会写，单独标出来给界面用
      if (/已答过|预填|沿用打勾|变则改一句/.test(line)) {
        cur.prefilled = true
        cur.prefilledNote = cur.ask
      }
      continue
    }
    // 题干之后的补充说明（样本里偶尔有）→ 并进题干
    if (cur && askTaken && !cur.options.length && !/^[>|]/.test(line)) {
      cur.ask += '\n' + line.trim()
    }
  }
  flush()

  if (!deck.questions.length) {
    return { ...deck, error: '没认出任何题目 —— 检查是不是 `## S1 题名` + `- **A. 选项**——说明` 这个写法' }
  }
  // 选项少于 2 个的题单独报出来（它可能是解析漏了，也可能是“只问一句”的自由题）
  const thin = deck.questions.filter((q) => q.options.length < 2 && !q.prefilled)
  if (thin.length) {
    deck.error = `有 ${thin.length} 道题只认出 ${thin.map((q) => q.id).join('、')} 的 ${
      thin.map((q) => q.options.length).join('/')} 个选项 —— 多半是选项写法不一样`
  }
  return deck
}

/** 卷面统计（界面顶部/侧栏用） */
export function deckStats(d: QDeck): { total: number; withOptions: number; layers: string[] } {
  return {
    total: d.questions.length,
    withOptions: d.questions.filter((q) => q.options.length >= 2).length,
    layers: d.layer ? [d.layer] : [],
  }
}

/** 一个「没写代价」的选项 */
export interface QCostGap {
  /** 题号 */
  id: string
  /** 选项键 */
  k: string
  /** 选项标题（够界面点名用） */
  t: string
}

/**
 * 代价缺失检查（2026-11-07，暮雨 11-05 认可的四条之一：「没写代价的选项不许进卷」）。
 *
 * 判据：选项的说明段（`——说明`）为空 = 没写代价。
 * 样本里真实存在这类项（S3 的 B、S7 的 A），**等于让人在黑暗里选**：
 * 他看得见"这是什么"，看不见"选它要付什么"。
 *
 * ⚠ 这里**只报告、不删选项**。删掉的后果比留着更坏：卷面少一个选项，
 *   人想选它时只能「改一句」，而"改一句"是他用来推翻框架的口子，不该被这种噪声占用。
 *   正确出口是把缺口点名，交给 `buildRewritePrompt` 让 agent 补齐（出卷人补，不是答的人补）。
 */
export function costGaps(d: QDeck): QCostGap[] {
  const out: QCostGap[] = []
  for (const q of d.questions) {
    for (const o of q.options) {
      if (!String(o.d || '').trim()) out.push({ id: q.id, k: o.k, t: o.t })
    }
  }
  return out
}

/** 卷面问题（出题质量闸，2026-11-07）—— 三类，都来自两份同类调研的可抄清单 */
export interface QDeckIssue {
  kind: 'noCost' | 'noLine' | 'tooMany'
  /** 题号（tooMany 没有具体题） */
  id?: string
  text: string
}

/** Typeform 官方调研：≤6 题/批完成率最高，比长表单高 15% */
export const Q_BATCH_MAX = 6

/**
 * 卷面体检。**只报告、不改卷**：
 *   · `noCost`  —— 选项没写"要付什么"（让人在黑暗里选）；
 *   · `noLine`  —— 题没写【验收线】（事后校验没有判据，`auditAnswer` 会直接拒）；
 *   · `tooMany` —— 一屏超过 `Q_BATCH_MAX` 题（调研数据：完成率明显下降，建议拆批）。
 *
 * 为什么不替它改：题目是 agent 写的（暮雨原话），方寸只做呈现与收答案。
 * 出口是「打包成补代价 / 重出题」，不是替出卷人动刀。
 */
export function deckIssues(d: QDeck): QDeckIssue[] {
  const out: QDeckIssue[] = []
  for (const q of d.questions) {
    for (const o of q.options) {
      if (!String(o.d || '').trim()) out.push({ kind: 'noCost', id: q.id, text: `${q.id}.${o.k} 没写代价` })
    }
    // 只有"要选一个"的题才需要验收线；「预填确认」这类一选项都没有的题不算
    if (q.options.length >= 2 && !String(q.line || '').trim()) {
      out.push({ kind: 'noLine', id: q.id, text: `${q.id} 没写验收线（事后没法校验）` })
    }
  }
  if (d.questions.length > Q_BATCH_MAX) {
    out.push({ kind: 'tooMany', text: `这卷 ${d.questions.length} 题，超过 ${Q_BATCH_MAX} 题/批 —— 建议拆层或拆批` })
  }
  return out
}
