/**
 * 决策「智能录入」的解析器（2026-10-14，开发清单第 5 条：贴一句话自动拆字段）
 *
 * 为什么是**纯函数 + 纯规则**，不叫模型：
 *   ① 它要拆的是格式（日期/出处/项目），不是语义 —— 规则 100% 可预期，错了能改规则；
 *   ② 契约 REV-005 那三条边界是给"AI 产出"定的（只落待审批卡、花销可见）。这里是本地字符串处理，
 *      没有产出、没有花销，不该被塞进那条通道；
 *   ③ 放 `shared/` 是为了能在无 electron 的纯 Node 下真跑断言（同 blockers / boardCards 的做法）。
 *
 * ⚠ 一条铁律：**内容句永不因为拆分而残缺**。日期/项目只在句子里当字段用、**不从正文里删**
 *   （"10月12日定的"删掉日期就不成句了）；只有「出处」会从正文里摘出去 ——
 *   它本来就是括注/尾注，摘掉句子更干净。摘完若为空，回退整句（宁可整句重复，不丢字）。
 */
const SEP = '：:，,。；;、-—『』「」《》【】'

/** 本地日期 → YYYY-MM-DD（不用 toISOString：它会按 UTC 切，东八区晚上会差一天） */
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function trimSep(s: string): string {
  let t = s.trim()
  while (t.length && SEP.includes(t[0])) t = t.slice(1).trim()
  while (t.length && SEP.includes(t[t.length - 1])) t = t.slice(0, -1).trim()
  return t
}

export interface ParsedDecisionLine {
  内容: string
  日期: string
  项目: string
  出处: string
  /** 这次真拆出了哪些字段（界面拿它回话；空数组 = 只当内容记） */
  命中: string[]
}

export interface ParseOptions {
  /** 已知项目名（调用方从现有决策 / 注册表给），用来认「这条属于哪个项目」 */
  projects?: string[]
  /** 只有"月日"没写年份时按哪一年补（默认今天） */
  today?: string
}

export function parseDecisionLine(raw: string, opts: ParseOptions = {}): ParsedDecisionLine {
  const projects = (opts.projects || []).filter(Boolean)
  const today = opts.today || ymd(new Date())
  const year = Number(today.slice(0, 4)) || new Date().getFullYear()
  const hits: string[] = []

  let rest = String(raw == null ? '' : raw).trim()
  const full = rest
  let 出处 = ''
  let 日期 = ''
  let 项目 = ''

  // ── ① 先摘「出处」────────────────────────────────────────────────────
  // ⚠ 顺序有讲究：出处里常常带日期（"出自 10-12 群 09:42"），先摘走它，
  //   后面抽日期才不会把出处里的 10-12 当成"哪天定的"。
  // ⚠ 已知口径（不假装它不存在）：出处**摘到句读为止**（。；;，, 与换行）。
  //   若出处后面只用空格接下一句（"出自 X 定：Y"，无标点），后半句会被一起吃进出处。
  //   没有为它加"空格 + 汉字就断"的启发式 —— 那会把"出自 暮雨当日亲口定"这类正常出处切坏。
  //   代价可接受：拆出来的只是**预填**，四个栏位在保存前都能改。
  const marked = rest.match(/(?:出自|来源|出处)\s*[:：]?\s*([^。；;，,\n]+)/)
  if (marked) {
    出处 = trimSep(marked[1].replace(/^[（(]+|[）)]+$/g, ''))
    rest = rest.replace(marked[0], ' ')
    hits.push('出处')
  } else {
    // 没有显式标记时，只看**末尾**的括号 —— 中间括号多半是正文的一部分，不能乱吃
    const tail = rest.match(/[（(]([^（()）]*?(?:群|台账|仓库|文档|日志|会议|聊天|微信|docs)[^（()）]*?)[）)]\s*$/)
    if (tail && typeof tail.index === 'number') {
      出处 = trimSep(tail[1])
      rest = rest.slice(0, tail.index).trim()
      hits.push('出处')
    }
  }

  // ── ② 抽「日期」（只认第一个，认出来就从正文里摘掉）────────────────────
  const ymdRe = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/
  const mdRe = /(\d{1,2})\s*[月\-/]\s*(\d{1,2})\s*日?/
  const relRe = /(今天|昨天|前天)/
  let dm = rest.match(ymdRe)
  if (dm) {
    const [m, mm, dd] = [Number(dm[1]), Number(dm[2]), Number(dm[3])]
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      日期 = `${m}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
      rest = rest.replace(dm[0], ' ')
    }
  }
  if (!日期) {
    dm = rest.match(mdRe)
    if (dm) {
      const [mm, dd] = [Number(dm[1]), Number(dm[2])]
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        日期 = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
        rest = rest.replace(dm[0], ' ')
      }
    }
  }
  if (!日期) {
    dm = rest.match(relRe)
    if (dm) {
      const back = dm[1] === '今天' ? 0 : dm[1] === '昨天' ? 1 : 2
      const d = new Date(`${today}T00:00:00`)
      d.setDate(d.getDate() - back)
      日期 = ymd(d)
      rest = rest.replace(dm[0], ' ')
    }
  }
  if (日期) hits.push('日期')

  // ── ③ 认「项目」（只填字段，**不从正文里删** —— 删了句子读不通）──────────
  for (const p of projects) {
    if (full.includes(p)) {
      项目 = p
      hits.push('项目')
      break
    }
  }

  // ── ④ 剩下的当「内容」；摘空了就回退整句（宁可整句重复，不丢字）─────────
  const 内容 = trimSep(rest) || trimSep(full)

  return { 内容, 日期, 项目, 出处, 命中: hits }
}
