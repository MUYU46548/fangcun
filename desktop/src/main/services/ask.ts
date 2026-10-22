/**
 * 「随问」—— 结构化查询面（2026-10-22 · 施工单包 03 任务一）
 *
 * 用户要的是「随时丢进去问」。而 agent 团队的通病是：没有持久台账、每问一次烧一次 token。
 * 方寸赢的地方恰恰是**结构化记忆** —— 所以这里的第一原则是：
 *
 *   **能用现成数据算出来的，绝不调模型。**
 *
 * 判据落成代码：`answer()` 返回的 `needsLlm` **只有 unmatched 才为 true**。
 * 界面据此说真话：「这条结构化答不了，得靠 AI」，而不是假装答了、或者偷偷调一次模型。
 *
 * 三条与 03 单对齐的硬约定：
 *   ① **零副作用**：只读（registry / 任务卡 / 执行日志 / ai-trace / tripBoard 的 git 只读缓存），
 *      本模块不写任何文件。纠偏/出单是别的模块的事。
 *   ② **不编**：取不到就写「未记录 / 没有」，不回退默认值、不拿字符数折算 token
 *      （沿用 tripBoard 与 usageStats 的既有口径）。
 *   ③ **来源必须可指认**：每个答案都带 `source`（registry / 任务卡 / 执行日志 / ai-trace），
 *      界面直接印出来 —— 用户最恨"这个数字不知道哪来的"。
 */
import { buildTripBoard, relTime } from './tripBoard'
import { parseRegistry, loadAllTasksRaw } from '../data'
import { usageStats } from '../llm/trace'
import { daysSinceDue } from '../../shared/time'

export const ASK_KINDS = [
  'cost', 'owe', 'blocked', 'who', 'due', 'dormant',
  'next', 'progress', 'counts', 'tasks', 'unmatched',
] as const
export type AskKind = typeof ASK_KINDS[number]

export interface AskRow {
  /** 左侧键（项目名 / 卡标题 / 字段名） */
  k: string
  /** 右侧值 */
  v: string
  /** 附注（来源 / 时点），界面用更淡的字 */
  sub?: string
}

export interface AskAnswer {
  kind: AskKind
  /** 一句话结论（界面上唯一的大字） */
  title: string
  /** 结构化正文行（补充说明，不是结论） */
  lines: string[]
  rows: AskRow[]
  /** 命中的项目 id（「随纠」拿它直接改；没指定项目就空） */
  projectId?: string
  /** 只有结构化答不了的时候才 true —— 这不是"建议调模型"，是"这次真的没算出来" */
  needsLlm: boolean
  /** 数据从哪来（界面直印） */
  source: string
}

// ── 小工具 ────────────────────────────────────────────────────────────────
const PRIO_RANK: Record<string, number> = { 高: 0, 中: 1, 低: 2 }
const prioRank = (p: unknown) => {
  const s = String(p ?? '')
  return s in PRIO_RANK ? PRIO_RANK[s] : 3
}
/** 未完成 = 不是终态。**空状态算未完成**（没填 ≠ 做完，与 boardCards / tripBoard 同口径） */
const isOpen = (fm: any) => {
  const s = String(fm?.status || '')
  return s !== '完成' && s !== '驳回'
}
const asList = (v: unknown): string[] => {
  if (v == null || v === '') return []
  return Array.isArray(v) ? v.map(String) : [String(v)]
}

/** 项目清单（含 released 段 —— 「哪些项目停着」这类问题里它们也该出现，只是标注不同） */
function projectList(): any[] {
  return parseRegistry(true) as any[]
}

/**
 * 从一句话里认出项目。
 *
 * 用**名字最长匹配**：`方寸` 与 `方寸看板` 同时登记时，问「方寸看板到哪了」要命中后者。
 * 认不出就返回 null —— 上层按"全部项目"处理，绝不默认成第一个（那是最会撒谎的一种默认）。
 */
function pickProject(q: string, projects: any[]): any | null {
  let best: any = null
  let bestLen = 0
  for (const p of projects) {
    for (const key of [String(p?.name || ''), String(p?.id || '')]) {
      if (!key) continue
      if (q.includes(key) && key.length > bestLen) { best = p; bestLen = key.length }
    }
  }
  return best
}

// ── 各意图的实现 ──────────────────────────────────────────────────────────

function answerCost(): AskAnswer {
  // 30 天窗口是 usageStats 的既有口径；**不叫"本月"** —— 自然月与滚动 30 天不是一回事，
  // 含糊其辞正是"数字对不上"的根源。
  const st = usageStats(30)
  const lines: string[] = []
  if (!st.calls) {
    lines.push('近 30 天一次 AI 调用都没有 —— 这期间没走过 AI 通道。')
  } else {
    if (st.token_calls < st.calls) {
      // 只统计真报了 usage 的，剩下的单独计数，不折算（2026-10-17 第 10 条口径）
      lines.push(`其中 ${st.token_calls} 次供应商给了用量，${st.calls - st.token_calls} 次没给 —— 没给的那部分只计数、不折算成 token。`)
    }
    if (st.firstTs) lines.push(`窗口内最早一条：${st.firstTs}；最近一条：${st.lastTs}`)
  }
  return {
    kind: 'cost',
    title: st.calls
      ? `近 30 天 ${st.calls} 次调用，共 ${st.total_tokens.toLocaleString()} tokens（成功 ${st.ok} / 失败 ${st.fail}）`
      : '近 30 天没有 AI 调用',
    lines,
    rows: [
      ...st.byModel.map((m) => ({
        k: m.model,
        v: m.total_tokens ? `${m.total_tokens.toLocaleString()} tokens` : `${m.token_calls}/${m.calls} 次有数字`,
        sub: `${m.calls} 次调用`,
      })),
      ...st.byTrigger.slice(0, 6).map((t) => ({
        k: `触发点 ${t.trigger}`,
        v: `${t.total_tokens.toLocaleString()} tokens`,
        sub: `${t.calls} 次`,
      })),
    ],
    needsLlm: false,
    source: '本机 AI 调用留痕（近 30 天）',
  }
}

function answerOwe(q: string, projects: any[]): AskAnswer {
  const picked = pickProject(q, projects)
  const pool = picked ? [picked] : projects
  const rows: AskRow[] = []
  for (const p of pool) {
    const note = String(p?.['说明'] || '').trim()
    if (!note) continue
    rows.push({ k: String(p?.name || p?.id || ''), v: note, sub: '你手写的' })
  }
  const nm = picked ? String(picked?.name || picked?.id) : ''
  return {
    kind: 'owe',
    title: picked
      ? (rows.length ? `${nm}：欠着这些（见下表）` : `${nm}：这栏还空着（没写欠着）`)
      : (rows.length ? `${rows.length} 个项目写了欠账` : '还没有任何项目写过欠账'),
    lines: rows.length
      ? ['这条读的是你手写的「说明」—— 方寸不替你裁，也不替你补。']
      : [`这${picked ? '个' : '些'}项目的「说明」还空着。要么真没欠账，要么还没写 —— 界面不猜。`],
    rows,
    projectId: picked ? String(picked.id) : undefined,
    needsLlm: false,
    source: '项目登记表里你手写的「说明」',
  }
}

function answerWho(q: string, projects: any[]): AskAnswer {
  const board = buildTripBoard()
  const picked = pickProject(q, projects)
  const rows = board.rows
    .filter((r) => (picked ? r.id === String(picked.id) : true))
    .filter((r) => r.who.kind !== 'none' && r.who.text)
    .map((r) => ({
      k: r.name,
      v: r.who.text,
      sub: r.who.kind === 'review' ? '待验收 · 等验收人' : '进行中 · 等执行人',
    }))
  return {
    kind: 'who',
    title: picked
      ? (rows.length ? `${String(picked?.name || picked?.id)}：${rows[0].v}` : `${String(picked?.name || picked?.id)} 没有在等谁（没有待验收/进行中的卡）`)
      : (rows.length ? `${rows.length} 个项目在等人` : '没有项目在等人'),
    lines: ['有「待验收」的卡就在等验收人，否则有「进行中」的卡就在等执行人。没填名字就写「未指定」，不编人名。'],
    rows,
    projectId: picked ? String(picked.id) : undefined,
    needsLlm: false,
    source: '任务卡上的「验收」与「指派」',
  }
}

function answerBlocked(q: string, projects: any[]): AskAnswer {
  const tasks = loadAllTasksRaw('active')
  const picked = pickProject(q, projects)
  const idOf = (t: any) => String(t?.id || t?.fm?.id || '')
  const titleOf = (t: any) => String(t?.fm?.title || t?.id || '')
  const projOf = (t: any) => asList(t?.fm?.project)
  const inScope = (t: any) => (picked ? projOf(t).includes(String(picked.id)) : true)
  const open = tasks.filter((t: any) => isOpen(t?.fm) && inScope(t))
  const byId = new Map<string, any>()
  for (const t of tasks) byId.set(idOf(t), t)
  const rows: AskRow[] = []
  for (const t of open) {
    const srcs = asList(t?.fm?.blockers).filter(Boolean)
    if (!srcs.length) continue
    const alive = srcs.filter((sid) => {
      const s = byId.get(sid)
      return s ? isOpen(s?.fm) : true // 找不到源卡也算"还挂着"（卡可能被删/在归档里）
    })
    if (!alive.length) continue
    rows.push({
      k: titleOf(t),
      v: `被 ${alive.length} 张卡挡着：${alive.map((sid) => { const s = byId.get(sid); return s ? titleOf(s) : sid }).join(' / ')}`,
      sub: picked ? String(picked.name || picked.id) : (projOf(t)[0] || '未归属'),
    })
  }
  return {
    kind: 'blocked',
    title: picked
      ? (rows.length ? `${String(picked?.name || picked?.id)}：${rows.length} 张卡被挡着` : `${String(picked?.name || picked?.id)} 没有被挡着的卡`)
      : (rows.length ? `${rows.length} 张卡被别的卡挡着` : '没有被挡着的卡'),
    lines: [
      '只看**未完成**的卡；源卡已经完成/驳回的不算（那是历史关系，不是当下的墙）。',
      '想看"解哪个最划算"去阻塞页签 —— 那边按传递效应算，不是只数这一层。',
    ],
    rows,
    projectId: picked ? String(picked.id) : undefined,
    needsLlm: false,
    source: '任务卡上的「阻塞」关系',
  }
}

function answerDue(q: string, projects: any[]): AskAnswer {
  const tasks = loadAllTasksRaw('active')
  const picked = pickProject(q, projects)
  const projOf = (t: any) => asList(t?.fm?.project)
  const inScope = (t: any) => (picked ? projOf(t).includes(String(picked.id)) : true)
  // 逾期算术**走 shared/time.daysSinceDue**（单一来源）—— 不在这里内联"一天多少毫秒"：
  // 那正是 e2e-calendar 守卫盯着的写法，各写一套必然漂移。
  const overdue: Array<{ t: any; d: number }> = []
  const today: Array<{ t: any; d: number }> = []
  const soon: Array<{ t: any; d: number }> = []
  for (const t of tasks) {
    if (!isOpen(t?.fm) || !inScope(t)) continue
    const d = daysSinceDue(t?.fm?.deadline)
    if (!Number.isFinite(d)) continue // 没填截止 / 解析不了 → 不进这个口径（不猜）
    if (d >= 1) overdue.push({ t, d })
    else if (d >= 0) today.push({ t, d })
    else if (d >= -3) soon.push({ t, d })
  }
  const label = (x: { t: any; d: number }) => ({
    k: String(x.t?.fm?.title || x.t?.id || ''),
    v: x.d >= 1 ? `逾期 ${Math.floor(x.d)} 天` : x.d >= 0 ? '今天到期' : `${Math.ceil(-x.d)} 天后到期`,
    sub: `${String(x.t?.fm?.status || '未填状态')} · ${String(x.t?.fm?.deadline || '')}`,
  })
  return {
    kind: 'due',
    title: `逾期 ${overdue.length} 张 · 今天到期 ${today.length} 张 · 三天内 ${soon.length} 张`,
    lines: [
      '和看板、待办上的「逾期 N 天」是同一套算法，不会两处对不上。',
      '只算填了截止日期的卡 —— 没填不等于没逾期，所以不猜。',
    ],
    rows: [...overdue.sort((a, b) => b.d - a.d), ...today, ...soon.sort((a, b) => a.d - b.d)].map(label),
    projectId: picked ? String(picked.id) : undefined,
    needsLlm: false,
    source: '任务卡上的「截止」日期',
  }
}

function answerDormant(): AskAnswer {
  const board = buildTripBoard()
  const rows = board.rows
    .filter((r) => r.health.value === 'dormant' || r.health.value === 'stuck')
    .map((r) => ({
      k: r.name,
      v: r.health.value === 'dormant' ? '休眠' : '停滞',
      sub: [r.lastCommit ? `最后提交 ${relTime(r.lastCommit)}` : '没有提交记录', r.counts.todo + r.counts.doing + r.counts.review ? `${r.counts.todo + r.counts.doing + r.counts.review} 张未完结` : '没有未完结卡'].join(' · '),
    }))
  const hiddenCount = board.hidden.length
  return {
    kind: 'dormant',
    title: rows.length ? `${rows.length} 个项目冷下来了` : '没有项目冷下来',
    lines: [
      '超过 30 天没动静算「休眠」，7~30 天算「停滞」；你手动标过的以你的为准。',
      hiddenCount ? `另有 ${hiddenCount} 个项目没进这一屏（没有未完结任务、30 天内也没提交）—— 它们其实也算停着，只是不在判据的收口范围里。` : '',
    ].filter(Boolean),
    rows,
    needsLlm: false,
    source: '按任务活动和提交时间算出来的',
  }
}

function answerNext(q: string, projects: any[]): AskAnswer {
  const board = buildTripBoard()
  const picked = pickProject(q, projects)
  const scoped = board.rows.filter((r) => (picked ? r.id === String(picked.id) : true))
  const rows: AskRow[] = scoped.map((r) => ({
    k: r.name,
    v: r.next.text || '（没有待办卡）',
    sub: r.next.sub || (r.current.text ? `当前：${r.current.text}` : ''),
  }))
  const empty = scoped.filter((r) => !r.next.text).length
  return {
    kind: 'next',
    title: picked
      ? (scoped[0]?.next.text
        ? `${String(picked?.name || picked?.id)}下一步：${scoped[0].next.text}`
        : `${String(picked?.name || picked?.id)}没有待办卡`)
      : `${scoped.length - empty} 个项目有明确下一步`,
    lines: ['「下一步」取的是待办里优先级最高的那张 —— 不是 AI 的建议，是队列里排第一的那张卡。'],
    rows,
    projectId: picked ? String(picked.id) : undefined,
    needsLlm: false,
    source: '待办卡里优先级最高的那张',
  }
}

function answerProgress(q: string, projects: any[], forced?: any): AskAnswer {
  const board = buildTripBoard()
  const picked = forced || pickProject(q, projects)
  if (picked) {
    const row = board.rows.find((r) => r.id === String(picked.id))
    const reg = picked
    const lines = [
      `状态（手写）：${String(reg?.['状态'] || '未填')}`,
      `路线图（手写）：${String(reg?.['路线图'] || '未填')}`,
    ]
    if (row) {
      lines.unshift(
        `当前步骤：${row.current.text || '未填'}${row.current.sub ? `（${row.current.sub}）` : ''}`,
        `下一步：${row.next.text || '没有待办卡'}`,
        `卡在谁：${row.who.text || '没在等人'}`,
        `任务：待办 ${row.counts.todo} · 进行中 ${row.counts.doing} · 待验收 ${row.counts.review} · 执行日志 ${row.counts.logs}`,
      )
    } else {
      lines.push('这个项目没进「在途一屏」（没有未完结任务、30 天内也没提交）—— 所以没有任务级实况，只有上面两条手写值。')
    }
    return {
      kind: 'progress',
      title: `${String(reg?.name || reg?.id)}：${String(reg?.['状态'] || row?.current.text || '没有实况记录')}`,
      lines,
      rows: [],
      projectId: String(picked.id),
      needsLlm: false,
      source: '你手写的项目字段 + 任务卡 / 执行日志',
    }
  }
  const rows = board.rows.map((r) => ({
    k: r.name,
    v: r.current.text || '未填',
    sub: [r.current.from === 'log' ? '来自执行日志' : r.current.from === 'task' ? '来自任务卡' : '', r.who.text ? `等 ${r.who.text}` : ''].filter(Boolean).join(' · '),
  }))
  return {
    kind: 'progress',
    title: `${rows.length} 个在途项目（另 ${board.hidden.length} 个没进这一屏）`,
    lines: board.hidden.length
      ? [`没进的：${board.hidden.slice(0, 5).map((h) => `${h.name}（${h.reason}）`).join('；')}${board.hidden.length > 5 ? ' …' : ''}`]
      : [],
    rows,
    needsLlm: false,
    source: '在途一屏（任务卡 / 执行日志 / 提交时间）',
  }
}

function answerCounts(q: string, projects: any[]): AskAnswer {
  const tasks = loadAllTasksRaw('active')
  const picked = pickProject(q, projects)
  const projOf = (t: any) => asList(t?.fm?.project)
  const scope = picked ? tasks.filter((t: any) => projOf(t).includes(String(picked.id))) : tasks
  const open = scope.filter((t: any) => isOpen(t?.fm))
  const byStatus = new Map<string, number>()
  for (const t of open) {
    const s = String(t?.fm?.status || '未填状态')
    byStatus.set(s, (byStatus.get(s) || 0) + 1)
  }
  return {
    kind: 'counts',
    title: picked
      ? `${String(picked?.name || picked?.id)}：${open.length} 张未完成 / 共 ${scope.length} 张`
      : `${open.length} 张未完成 / 共 ${tasks.length} 张（活跃区）`,
    lines: ['「空状态」按未完成算 —— 没填 != 做完。归档区不在这个口径里（去归档页签看）。'],
    rows: [...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, v: `${v} 张` })),
    projectId: picked ? String(picked.id) : undefined,
    needsLlm: false,
    source: '任务卡的状态（不含归档与回收站）',
  }
}

function answerTasks(q: string, projects: any[]): AskAnswer {
  const tasks = loadAllTasksRaw('active')
  const picked = pickProject(q, projects)
  if (!picked) {
    return {
      kind: 'unmatched',
      title: '要问哪个项目的任务？',
      lines: ['点名一个项目（比如「方寸有哪些未完结的卡」）——项目一多，把全部卡倒出来等于没回答。'],
      rows: [],
      needsLlm: false,
      source: '',
    }
  }
  const projOf = (t: any) => asList(t?.fm?.project)
  const mine = tasks.filter((t: any) => projOf(t).includes(String(picked.id)))
  const open = mine.filter((t: any) => isOpen(t?.fm)).sort((a: any, b: any) => prioRank(a?.fm?.priority) - prioRank(b?.fm?.priority))
  return {
    kind: 'tasks',
    title: `${String(picked?.name || picked?.id)}：${open.length} 张未完成 / 共 ${mine.length} 张`,
    lines: open.length ? ['按优先级排（高→低）；同等优先级按更新时间新的在前。'] : ['这个项目没有未完成的卡。'],
    rows: open.slice(0, 30).map((t: any) => ({
      k: String(t?.fm?.title || t?.id || ''),
      v: String(t?.fm?.status || '未填状态'),
      sub: [String(t?.fm?.priority || '未设优先级'), t?.fm?.deadline ? `截止 ${String(t.fm.deadline)}` : '', t?.fm?.assignee ? `指派 ${String(t.fm.assignee)}` : ''].filter(Boolean).join(' · '),
    })),
    projectId: String(picked.id),
    needsLlm: false,
    source: '任务卡',
  }
}

// ── 意图识别 ──────────────────────────────────────────────────────────────
/**
 * 顺序即优先级，**具体在前、泛化在后**：
 *   「欠着什么」不能被「什么」这类泛词吃掉；「方寸到哪了」不能被「任务」吃掉。
 * 每条都只认少量关键词 —— 宁可落到 unmatched 让人补一句，也别猜错方向给一份像样的错答案。
 */
const INTENTS: Array<{ kind: AskKind; re: RegExp }> = [
  { kind: 'cost', re: /(花销|花了多少钱|烧了多少钱|烧钱|token|费用|成本|用了多少|调用量)/i },
  { kind: 'owe', re: /(欠着|欠什么|欠账|欠了什么|还差)/ },
  { kind: 'blocked', re: /(阻塞|卡在哪|挡住|被挡|卡住)/ },
  { kind: 'who', re: /(在等谁|等谁|谁在等|卡在谁|谁负责|谁做|谁在干)/ },
  { kind: 'due', re: /(逾期|过期|超期|到期|deadline)/i },
  { kind: 'dormant', re: /(停着|停了|没动|休眠|停滞|冷下来|多久没|荒了)/ },
  // ⚠ 「接下来」单独一个词太宽：2026-10-22 实测「你觉得我接下来该不该砍掉它」会命中 next，
  //   于是把一句**判断题**答成"下一步做哪张卡" —— 方向对了但答非所问，比答不出来更糟。
  //   所以「接下来」后面必须跟"做什么/干什么"这类动作疑问才认。
  { kind: 'next', re: /(下一步|下一件|接下来(该|要|需要)?(做|干|搞)(什么|啥)?$|接下来(做|干|搞)(什么|啥)|该(做|干)(什么|啥)|先(做|干)(什么|啥)|做(什么|啥)好)/ },
  { kind: 'progress', re: /(到哪|进展|进度|怎么样了|在干嘛|干到|做到)/ },
  { kind: 'counts', re: /(多少|几张|几个任务|没做完|未完成|剩下|剩余)/ },
  { kind: 'tasks', re: /(任务|卡片|清单|列表)/ },
]

/** 常用问题（界面上的快捷点选）—— 全部走结构化，一条都不烧 token */
export interface AskPreset {
  /** 按钮上的字（≤8 字，得能一眼看懂问的是什么） */
  label: string
  /** 真正发给查询的句子（界面不自己拼文案，两边只用这一份） */
  q: string
  /** 悬停说明：这个会答出什么（不占版面，但第一次用的人不用猜） */
  hint: string
  /** 分组名 —— 九个问题排一行会挤成两行、还孤零零剩一个，分组后每行都整 */
  group: string
}

export const ASK_PRESETS: AskPreset[] = [
  { label: '都在哪一步', q: '各项目都到哪了', group: '看进展', hint: '一行一个项目：现在做到哪、下一步是什么' },
  { label: '下一步干什么', q: '下一步该做什么', group: '看进展', hint: '待办里优先级最高的那张卡' },
  { label: '在等谁', q: '谁在等谁', group: '看进展', hint: '哪个项目卡在等人的环节（验收人 / 执行人）' },
  { label: '欠着什么', q: '欠着什么', group: '看进展', hint: '你自己写下的欠账清单（项目登记表里那栏）' },
  { label: '卡在哪', q: '卡在哪', group: '看问题', hint: '哪张卡被别的卡挡着、被谁挡' },
  { label: '哪些逾期了', q: '哪些逾期了', group: '看问题', hint: '逾期几天，外加三天内到期的' },
  { label: '哪些项目停着', q: '哪些项目停着', group: '看问题', hint: '30 天没动静的项目（休眠 / 停滞）' },
  { label: '还有多少没做完', q: '还有多少没做完', group: '看账', hint: '未完成的卡有多少，按状态分开' },
  { label: '本月烧了多少钱', q: '本月烧了多少钱', group: '看账', hint: '按自然月算的 AI 调用与 token' },
]

/**
 * 主入口。**纯读取**，不写盘、不调模型。
 * 返回 `needsLlm: true` 只表示"结构化这次没算出来"，要不要真去问模型是上层（界面/用户）的事。
 */
export function answer(raw: string): AskAnswer {
  const q = String(raw || '').trim()
  if (!q) {
    return {
      kind: 'unmatched',
      title: '问一句就行',
      lines: ['比如「方寸到哪了」「欠着什么」「哪些项目停着」「本月烧了多少钱」。'],
      rows: [],
      needsLlm: false,
      source: '',
    }
  }
  const projects = projectList()
  for (const it of INTENTS) {
    if (!it.re.test(q)) continue
    switch (it.kind) {
      case 'cost': return answerCost()
      case 'owe': return answerOwe(q, projects)
      case 'blocked': return answerBlocked(q, projects)
      case 'who': return answerWho(q, projects)
      case 'due': return answerDue(q, projects)
      case 'dormant': return answerDormant()
      case 'next': return answerNext(q, projects)
      case 'progress': return answerProgress(q, projects)
      case 'counts': return answerCounts(q, projects)
      case 'tasks': return answerTasks(q, projects)
    }
  }
  // 兜底：点名了项目 + 问号/含糊 → 至少把该项目的实况给全，比一句"我不懂"有用
  const picked = pickProject(q, projects)
  if (picked) return answerProgress(q, projects, picked)
  return {
    kind: 'unmatched',
    title: '这句话结构化答不了',
    lines: [
      '方寸只在**两种**情况下动模型：模糊问答、批次出单。这一句既没命中结构化意图，也没点名项目——',
      '要么换一种问法（点上面的常用问题），要么交给 AI 答 —— 那条会花钱，每次花销都记在下面的月报表里。',
    ],
    rows: [],
    needsLlm: true,
    source: '',
  }
}

/** 给界面用的菜单（问题里可点名的项目）—— 从 registry 现读，不硬编码 */
export function askProjectOptions(): Array<{ id: string; name: string }> {
  return projectList().map((p: any) => ({ id: String(p.id), name: String(p.name || p.id) }))
}

/**
 * 「模糊问答」的**事实包**（2026-10-22 · 03 任务一：模糊问题才走 LLM）。
 *
 * 为什么要有这个函数：03 单写死了「回答限定引用结构化数据，不自由发挥」。
 * 靠提示词里写"请只引用数据"是不够的 —— 模型没数据就只能编。所以先把方寸手里
 * 能拿到的**全部事实**压成一段紧凑文本一起发过去，让它根本没机会自由发挥。
 *
 * 三条约束（都是钱和可信度）：
 *   · **有上限**：整体截到 `MAX` 字符，卡最多列 30 张 —— 模糊问答不该比一次出单还贵。
 *   · **只读**：本函数不写盘、不调模型（调模型的是 llm-ipc，它拿这段当提示词的一部分）。
 *   · **不美化**：缺值就写「未填」，让模型看到的是缺的，而不是被我们补过的。
 */
export function buildContext(): string {
  const MAX = 4000
  const projects = projectList()
  const tasks = loadAllTasksRaw('active')
  const board = buildTripBoard()
  const out: string[] = []

  out.push('## 项目（registry 手写字段）')
  for (const p of projects) {
    out.push(`- ${String(p?.name || p?.id)}：状态=${String(p?.['状态'] || '未填')}；路线图=${String(p?.['路线图'] || '未填')}；欠着=${String(p?.['说明'] || '未填')}`)
  }

  out.push('', '## 在途一屏（任务卡/执行日志/git 聚合）')
  for (const r of board.rows) {
    out.push(`- ${r.name}：当前=${r.current.text || '未填'}；下一步=${r.next.text || '无待办'}；等=${r.who.text || '没在等人'}；待办${r.counts.todo}/进行中${r.counts.doing}/待验收${r.counts.review}/日志${r.counts.logs}；健康=${r.health.value}${r.health.locked ? '(人工)' : ''}`)
  }
  if (board.hidden.length) {
    out.push(`- 未进屏：${board.hidden.map((h) => `${h.name}（${h.reason}）`).join('；')}`)
  }

  const open = tasks.filter((t: any) => isOpen(t?.fm))
  out.push('', `## 未完成卡（共 ${open.length} 张，最多列 30）`)
  for (const t of open
    .sort((a: any, b: any) => prioRank(a?.fm?.priority) - prioRank(b?.fm?.priority))
    .slice(0, 30)) {
    const proj = asList(t?.fm?.project).join(',') || '未归属'
    out.push(`- [${String(t?.fm?.priority || '未设')}] ${String(t?.fm?.title || t?.id)}（${proj} / ${String(t?.fm?.status || '未填状态')}${t?.fm?.deadline ? ` / 截止 ${String(t.fm.deadline)}` : ''}${t?.fm?.assignee ? ` / 指派 ${String(t.fm.assignee)}` : ''}）`)
  }

  const st = usageStats(30)
  out.push('', `## 近 30 天 AI 花销：${st.calls} 次调用，${st.total_tokens} tokens（成功 ${st.ok} / 失败 ${st.fail}；${st.token_calls} 次带 token 数据）`)

  let text = out.join('\n')
  if (text.length > MAX) text = text.slice(0, MAX) + '\n…（后面的事实被截断了，回答时请说明"数据不完整"）'
  return text
}
