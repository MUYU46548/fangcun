/**
 * 投入产出账（0.6.0 P5）—— “花了多少 / 产出了什么 / 哪几条被否”的纯逻辑
 *
 * 这一层只做**编排与口径**，不读盘、不起 git：
 *   · 读 ai-trace、跑 git、读任务在 `main/usage/ledger.ts`；
 *   · 三格各自的算法与"它证明不了什么"在这里定死，界面只渲染。
 *
 * 四条硬口径：
 *  ① **取不到就整格不渲染** —— 不填 0、不写“—”、不拿字符数折算 token。
 *     0 是一个可核对的真值；"没有数据"不是 0。
 *  ② **每个数字都带局限**（`caveat`，以“它证明不了什么”开头）——
 *     数字离开口径就是假话，所以缺 caveat 的格子直接不产出（不是偷偷少一行）。
 *  ③ **ai-trace 只算方寸自己发起的调用**（origin 缺省=local；external 排除），
 *     并且明说它没有项目字段、不能分摊到项目。
 *  ④ **提交数只说明仓库被改过**，完成卡是自报状态 —— 两件事都写在数字旁边。
 */
import { parseAmount, formatAmount } from './balance'
import { parseTime } from './time'

export interface WasteTraceRecord {
  ts?: string
  /** 外部上报的备注里带 `cache_read=` 与 `card=`（方寸自己的调用没有） */
  note?: string
  /** 归因到哪张卡（2026-11-07 起由上报方显式给；缺省 = 未归因） */
  card?: string
  /** 缺省 = local（方寸自己发起的调用） */
  origin?: 'local' | 'external'
  cost?: string
  total_tokens?: number | null
  prompt_tokens?: number | null
  completion_tokens?: number | null
}

export interface WasteTaskRecord {
  id: string
  title?: string
  status?: string
  /** ISO / 秒级或毫秒时间戳（本仓三种写法都有） */
  updated?: string | number
}

export interface WasteInput {
  /** 窗口天数；0 = 不限 */
  days?: number
  /** 计算窗口的基准时间（测试固定用） */
  now?: string | number
  /** null = 读不到（不是空数组） */
  trace?: WasteTraceRecord[] | null
  /** git 提交的短 hash 列表；null = 读不到 */
  commits?: string[] | null
  /** null = 读不到 */
  tasks?: WasteTaskRecord[] | null
}

export type WasteCellKey = 'spend' | 'external' | 'output' | 'rejected'

export interface WasteCell {
  key: WasteCellKey
  label: string
  /** 一个可读数字（不含占位符） */
  value: string
  /** “它证明不了什么：…”—— 必填，缺了整格不产出 */
  caveat: string
  /** 构成说明（调用次数 / 未折算笔数 / 卡名…） */
  detail?: string
  /** 可复算的原始数字（P7 的"额外一格"要用；不直接上屏） */
  raw?: {
    cost?: string
    tokens?: number
    calls?: number
    commits?: number
    done?: number
    rejected?: number
  }
}

export interface WasteLedger {
  days: number
  cells: WasteCell[]
  /** 口径声明（页面必须显示） */
  note: string
  /** 三格都取不到时的一句话（界面据此显示，不渲染空格子） */
  emptyText: string
}

const CAVEAT_PREFIX = '它证明不了什么'

function makeCell(
  key: WasteCellKey, label: string, value: string, caveat: string, detail = '',
  raw?: WasteCell['raw'],
): WasteCell | null {
  const v = String(value || '').trim()
  if (!v) return null
  // 缺局限的数字一律不产出 —— 宁可少一格，也不让一个没有前提的数字上屏
  if (!caveat || caveat.indexOf(CAVEAT_PREFIX) < 0) return null
  return { key, label, value: v, caveat, detail: String(detail || '').trim() || undefined, raw }
}

function nowMs(now?: string | number): number {
  if (now === undefined || now === null || now === '') return Date.now()
  const t = parseTime(now as any)
  return Number.isFinite(t) ? t : Date.now()
}

function inWindow(ts: string | number | undefined, since: number): boolean {
  if (!since) return true
  const t = parseTime(ts as any)
  // 时间解析不了：不知道在不在窗口内 —— 按 ai-trace 既有口径"计入"，不静默丢调用
  return !Number.isFinite(t) || t >= since
}

function hasToken(x: WasteTraceRecord): boolean {
  return typeof x.total_tokens === 'number' || typeof x.prompt_tokens === 'number' || typeof x.completion_tokens === 'number'
}

function tokenCount(x: WasteTraceRecord): number {
  if (typeof x.total_tokens === 'number' && Number.isFinite(x.total_tokens)) return x.total_tokens
  const p = typeof x.prompt_tokens === 'number' && Number.isFinite(x.prompt_tokens) ? x.prompt_tokens : 0
  const c = typeof x.completion_tokens === 'number' && Number.isFinite(x.completion_tokens) ? x.completion_tokens : 0
  return p + c
}

/**
 * 组装三格。顺序固定：花了多少 → 产出了什么 → 哪几条被否。
 * 任何一格的数据源是 null（读不到）就不产出那一格。
 */
export function buildWasteLedger(input: WasteInput = {}): WasteLedger {
  const days = Number.isFinite(Number(input.days)) ? Math.max(0, Math.floor(Number(input.days))) : 30
  const anchor = nowMs(input.now)
  const since = days > 0 ? anchor - days * 86400000 : 0
  const cells: WasteCell[] = []

  // ① 花了多少 —— 只算方寸自己发起的调用（origin 缺省=local）
  let externalSkipped = 0
  if (Array.isArray(input.trace)) {
    const local: WasteTraceRecord[] = []
    for (const x of input.trace) {
      if (!x) continue
      if ((x.origin || 'local') === 'external') { externalSkipped++; continue }
      if (inWindow(x.ts, since)) local.push(x)
    }
    const costCalls = local.filter((x) => parseAmount(x.cost) !== null)
    const tokenCalls = local.filter(hasToken)
    if (local.length && (costCalls.length || tokenCalls.length)) {
      const sum = costCalls.reduce((a, x) => a + (parseAmount(x.cost) as bigint), 0n)
      const tokens = tokenCalls.reduce((a, x) => a + tokenCount(x), 0)
      const parts: string[] = []
      if (costCalls.length) parts.push(`¥${formatAmount(sum, 4)}`)
      if (tokenCalls.length) parts.push(`${tokens.toLocaleString('en-US')} tokens`)
      const unpriced = local.length - costCalls.length
      const detail = [
        `${local.length} 次调用`,
        unpriced ? `${unpriced} 笔未折算金额` : '',
        externalSkipped ? `已排除 ${externalSkipped} 条外部上报` : '',
      ].filter(Boolean).join(' · ')
      const cell = makeCell(
        'spend', `花了多少（近 ${days || '全部'} 天）`, parts.join(' · '),
        `${CAVEAT_PREFIX}：ai-trace 只记方寸自己发起的调用，外部 agent 没上报的花销不在这一格；它也没有项目字段，不能分摊到某个项目。`,
        detail,
        { cost: costCalls.length ? formatAmount(sum, 8) : undefined, tokens: tokenCalls.length ? tokens : undefined, calls: local.length },
      )
      if (cell) cells.push(cell)
    }
  }

  // ①b 外部 agent 的花销（2026-11-07 新增）—— **单列一格，绝不混进上面那格**
  //
  // 为什么必须单列：实测 227 条 trace 里 217 条是外部上报，token 占 99.99%；
  // 而"花了多少"那格按口径只算 local → 整本账其实在描述 0.0024% 的流量。
  // 但直接混算更糟（外部上报没法复验、不含方寸上下文）。所以：**分成两格，各自说清口径**。
  if (Array.isArray(input.trace)) {
    const ext = input.trace.filter((x) => x && (x.origin === 'external') && inWindow(x.ts, since))
    // ⚠ 只有"报了 prompt_tokens"的记录才能算新输入（新输入 = prompt − cache_read）。
    //   只报 total 的记录一律不进分子 —— 拿 total 顶替就等于把"上下文长度"当"新读入"，
    //   正是这份账原来最错的地方。一条 prompt 都没有 → **整格不产出**（宁缺勿假）。
    const tok = ext.filter((x) => typeof x.prompt_tokens === 'number' && Number.isFinite(x.prompt_tokens))
    if (ext.length && tok.length) {
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      let prompt = 0
      let cache = 0
      let completion = 0
      let withCard = 0
      let attributedTokens = 0
      for (const x of tok) {
        const p = num(x.prompt_tokens)
        const cRaw = num(x.completion_tokens)
        prompt += p
        completion += cRaw
        const note = String(x.note || '')
        const m = /cache_read=(\d+)/.exec(note)
        const cacheN = m ? Number(m[1]) : 0
        cache += cacheN
        const card = String(x.card || '').trim() || (/card=([^\s]+)/.exec(note) || [])[1] || ''
        if (card && card !== '(未归因)') { withCard++; attributedTokens += tokenCount(x) }
      }
      const totalTok = tok.reduce((a, x) => a + tokenCount(x), 0)
      const newInput = Math.max(0, prompt - cache)
      const cachePct = prompt > 0 ? Math.round((cache / prompt) * 1000) / 10 : 0
      const attrPct = ext.length ? Math.round((withCard / ext.length) * 1000) / 10 : 0
      const fmt = (n: number) => n.toLocaleString('en-US')
      const cell = makeCell(
        'external',
        `外部 agent 花了多少（近 ${days || '全部'} 天）`,
        `${fmt(newInput)} 新输入 · 缓存重读占 ${cachePct}%`,
        `${CAVEAT_PREFIX}：外部上报是自己报的，方寸没法复验；没有 card 的那部分归因不到任何需求，`
        + `所以它能说明"花了多少"，说明不了"花在哪件活上"。`,
        `${ext.length} 次外部调用 · 归因 ${withCard}/${ext.length}（${attrPct}%）`
        + ` · 已归因 token 占 ${totalTok ? Math.round((attributedTokens / totalTok) * 1000) / 10 : 0}%`
        + ` · 输出 ${fmt(completion)} tokens`,
        { tokens: tokenCount(tok[0]) ? tok.reduce((a, x) => a + tokenCount(x), 0) : undefined, calls: ext.length },
      )
      if (cell) cells.push(cell)
    }
  }

  // ② 产出了什么 —— git 提交 + 完成的卡（两边各算各的，都不猜）
  const tasksKnown = Array.isArray(input.tasks)
  const commitsKnown = Array.isArray(input.commits)
  if (tasksKnown || commitsKnown) {
    const done = tasksKnown
      ? (input.tasks as WasteTaskRecord[]).filter((t) => t && String(t.status || '') === '完成' && inWindow(t.updated, since)).length
      : null
    const commits = commitsKnown ? (input.commits as string[]).filter((x) => String(x || '').trim()).length : null
    const parts: string[] = []
    if (commits !== null) parts.push(`${commits} 次提交`)
    if (done !== null) parts.push(`${done} 张卡完成`)
    const detail = [
      commitsKnown ? '提交按数据目录所在的仓库统计' : 'git 读不到（可能不是仓库）',
      tasksKnown ? '完成数只认更新时间在窗口内的卡' : '任务读不到',
    ].join(' · ')
    const cell = makeCell(
      'output', `产出了什么（近 ${days || '全部'} 天）`, parts.join(' · '),
      `${CAVEAT_PREFIX}：提交数只说明仓库被改过，不说明改动有用；完成卡数是自报状态，不等于验收通过。`,
      detail,
      { commits: commits === null ? undefined : commits, done: done === null ? undefined : done },
    )
    if (cell) cells.push(cell)
  }

  // ③ 哪几条被否 —— 只列**当前状态**为驳回的卡（历史被否后删掉的不在）
  if (tasksKnown) {
    const rej = (input.tasks as WasteTaskRecord[]).filter((t) => t && String(t.status || '') === '驳回')
    const names = rej.slice(0, 3).map((t) => String(t.title || t.id || '')).filter(Boolean)
    const cell = makeCell(
      'rejected', '哪几条被否', rej.length ? `${rej.length} 张` : '没有被否的卡',
      `${CAVEAT_PREFIX}：只列当前状态为“驳回”的卡；被否后删掉/归档的不在这里，也不代表它们没被否过。`,
      rej.length ? names.join('、') + (rej.length > 3 ? ` 等 ${rej.length} 张` : '') : '',
      { rejected: rej.length },
    )
    if (cell) cells.push(cell)
  }

  return {
    days,
    cells,
    note: '口径：ai-trace 只记方寸自己发起的调用；外部 agent 的花销不在这一格；提交只算数据目录所在的仓库，其它仓库不算。',
    emptyText: '三格都取不到（ai-trace / git / 任务都没读到）—— 不拿 0 或“—”冒充。',
  }
}

/** 界面渲染前再兜一道：没有“它证明不了什么”的格子一律不显示（防旧主进程/坏数据） */
export function sanitizeWasteLedger(ledger: WasteLedger | null): WasteLedger | null {
  if (!ledger) return null
  const cells = (Array.isArray(ledger.cells) ? ledger.cells : [])
    .filter((c) => c && typeof c.caveat === 'string' && c.caveat.indexOf(CAVEAT_PREFIX) >= 0)
  return { ...ledger, cells }
}

export interface WasteInsight {
  ok: boolean
  /** 算得出 = 一条引用 P5 数字的结论；算不出 = “算不出，因为 X” */
  text: string
  reason?: string
  cites: string[]
}

/**
 * P7 的“额外一格”：从投入产出账算一条**原来不知道的事**。
 *
 * 只做可复算的除法（每张完成卡摊到多少花销/token）—— 不做"效率评分"这种拍脑袋指标。
 * 缺数据就明写“算不出，因为 X”，不编。
 */
export function deriveWasteInsight(ledger: WasteLedger): WasteInsight {
  const spend = ledger.cells.find((c) => c.key === 'spend')
  const output = ledger.cells.find((c) => c.key === 'output')
  const done = output?.raw?.done
  if (!spend) {
    return { ok: false, text: '算不出，因为 投入产出账缺少“花了多少”这一格。', reason: '缺少“花了多少”', cites: [] }
  }
  if (!done) {
    return { ok: false, text: '算不出，因为 投入产出账里完成卡为 0（或任务读不到）。', reason: '完成卡为 0', cites: ['ledger:output'] }
  }
  const cost = spend.raw?.cost
  const total = cost ? parseAmount(cost) : null
  if (total !== null) {
    const per = total / BigInt(done)
    return {
      ok: true,
      text: `按投入产出账：近 ${ledger.days || '全部'} 天花了 ${spend.value}，完成 ${done} 张卡 —— 平均每张完成卡约 ¥${formatAmount(per, 6)}。`,
      cites: ['ledger:spend', 'ledger:output'],
    }
  }
  const tokens = spend.raw?.tokens
  if (typeof tokens === 'number' && tokens > 0) {
    return {
      ok: true,
      // 2026-11-07 · W1 口径：这个 tokens 是「方寸自己发起的调用」的 total（含缓存重读），
      // 外部 agent 的花销在单独一格。原句直接说"用了 X tokens，平均每张卡 Y"会被读成因果，
      // 所以把口径与"只是比值"写进句子里 —— 数字没变，说法不再骗人。
      text: `按投入产出账：近 ${ledger.days || '全部'} 天方寸自己用了 ${tokens.toLocaleString('en-US')} tokens（total 含缓存重读，外部 agent 另计），完成 ${done} 张卡 —— 平均每张完成卡约 ${Math.round(tokens / done).toLocaleString('en-US')} tokens（只是比值、不是因果；金额未折算，不能说成花了多少钱）。`,
      cites: ['ledger:spend', 'ledger:output'],
    }
  }
  return { ok: false, text: '算不出，因为 投入产出账里没有任何 token / 金额数字。', reason: '没有 token / 金额', cites: ['ledger:output'] }
}
