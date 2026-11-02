/**
 * 收卡机检（ADR-003 一期 · 外部 agent 交单的收卡侧）
 *
 * 一句话：**外部 agent 把交付物交进来那一刻，先按卡上写的判据机检一遍**，
 * 过 = 落“待审批”，不过 = 红标 + 留痕但**照样落卡**（东西不许丢）。
 *
 * 为什么要有这一层（2026-11-01 执行单段 2）：
 * 方寸此前对"交付物"只有**事后**扫描（`shared/mismatch.ts` 的 pickNoCriteria /
 * pickNoOutput —— 卡关了才发现没判据、没产出）。事后扫描救不了已经丢的东西，
 * 而"判据写进建卡/收卡那一秒"才有拦截力（评审三步②）。
 *
 * 四类机检（全部面向**交付物文本**，不起进程、不跑测试）：
 *   str:    '<原文>'          交付物必须含这段原文
 *   count:  '<原文>' == N     出现次数（>= <= == != > < 都收）
 *   format: <正则>            交付物必须匹配（写坏正则 → unknown，绝不猜）
 *   file:   <相对路径> 存在   仓库里真存在（存在性由调用方注入，纯逻辑不碰 fs）
 *
 * 三条硬口径：
 *  ① **unknown ≠ pass**：解析不出 / 写坏正则 / 不认识的判据 → unknown，挡住"过"；
 *  ② **没有判据 = 收不了**：判据为空时 ok=false —— 没判据的卡收了也验不了（同 pickNoCriteria 口径）；
 *  ③ **不阻挡落卡是调用方的事**：这里只出报告。`ok=false` 不等于"拒收"，
 *     调用方（MCP intake_task）照样建卡，但要把 summary 写进正文并标红。
 *
 * ⚠ 为什么 `cmd:` 在这里是 unknown：收卡瞬间跑测试套件动辄几十秒、还可能改环境，
 *   那是“待验收”阶段人点自检时的事（P3/P4 的 runner），不是收卡动作该做的。
 */

export type IntakeState = 'pass' | 'fail' | 'unknown'
export type IntakeKind = 'str' | 'count' | 'format' | 'file'

export interface IntakeRow {
  /** 卡上的判据原文 */
  raw: string
  kind: IntakeKind | 'unknown'
  state: IntakeState
  /** 一句话结论（含实际值，能直接贴回卡上） */
  detail: string
}

export interface IntakeReport {
  /** 全部判据通过才 true（空判据也是 false） */
  ok: boolean
  total: number
  passed: number
  failed: number
  unknown: number
  rows: IntakeRow[]
  /** 一句话总结（写进卡正文第一行） */
  summary: string
  /** 每条不过/未判定的原文 + 实际值（写进卡正文的清单） */
  redFlags: string[]
}

export interface IntakeOptions {
  /** `file:` 判据的存在性检查（相对仓库根）。不注入 → 一律 unknown，不猜 */
  exists?: (rel: string) => boolean
}

const QUOTED = /^(['"])([\s\S]*)\1$/
const CMP = /^(>=|<=|==|!=|>|<|≥|≤|＝|=)\s*(\d+)$/

/** 去掉列表符号与首尾空白（卡上从 `- ` 读出来时带前缀） */
export function normalizeIntakeLine(raw: string): string {
  return String(raw ?? '').replace(/^\s*[-*+]\s+/, '').trim()
}

function row(raw: string, kind: IntakeKind | 'unknown', state: IntakeState, detail: string): IntakeRow {
  return { raw, kind, state, detail }
}

function compare(actual: number, op: string, expected: number): boolean {
  switch (op) {
    case '>=': case '≥': return actual >= expected
    case '<=': case '≤': return actual <= expected
    case '==': case '=': case '＝': return actual === expected
    case '!=': return actual !== expected
    case '>': return actual > expected
    case '<': return actual < expected
    default: return false
  }
}

/** 数出现次数（不重叠、按 UTF-16 索引推进；空串不数） */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  const h = String(haystack ?? '')
  let n = 0
  let i = h.indexOf(needle)
  while (i >= 0) {
    n++
    i = h.indexOf(needle, i + needle.length)
  }
  return n
}

/** 单条判据机检。**永不抛**；判不了给 unknown + 可读理由。 */
export function checkIntakeLine(raw: string, deliverable: string, opts: IntakeOptions = {}): IntakeRow {
  const line = normalizeIntakeLine(raw)
  const text = String(deliverable ?? '')
  const m = /^([A-Za-z]+)\s*[:：]\s*([\s\S]*)$/.exec(line)
  if (!m) {
    return row(line, 'unknown', 'unknown', '没有 str / count / format / file 前缀，收卡机检判不了')
  }
  const prefix = m[1].toLowerCase()
  const body = m[2].trim()

  if (prefix === 'cmd') {
    return row(line, 'unknown', 'unknown',
      'cmd: 不在收卡时跑 —— 测试套件放“待验收”阶段由人点自检，收卡瞬间起进程会拖慢且污染环境')
  }
  if (prefix === 'human') {
    return row(line, 'unknown', 'unknown', 'human: 合法，但那是“人来验”，不是可机检的收卡判据')
  }

  if (prefix === 'str') {
    const q = QUOTED.exec(body)
    if (!q) return row(line, 'str', 'unknown', "str: 原文要带引号（例：str: 'CJK 统一表意文字'）—— 否则分不清原文与说明")
    const needle = q[2]
    if (!needle) return row(line, 'str', 'unknown', 'str: 原文是空串，没法判')
    return text.includes(needle)
      ? row(line, 'str', 'pass', '交付物含指定原文')
      : row(line, 'str', 'fail', `交付物里找不到这段原文：${needle.slice(0, 40)}`)
  }

  if (prefix === 'count') {
    // ⚠ 不能拿 QUOTED 整段匹配：`count: '|' == 4` 里引号只包住原文，
    //   整段匹配必然落空（首版就是这么错的，测试当场红）。
    //   所以“开头一个引号串 + 尾部一个比较式”分开抓，原文可含除引号外的任意字符。
    const c = /^(['"])([\s\S]*?)\1\s*(>=|<=|==|!=|>|<|≥|≤|＝|=)\s*(\d+)\s*$/.exec(body)
    if (!c) return row(line, 'count', 'unknown', "count: 只认 count: '<原文>' <比较> <数字>（例：count: '诉求' == 6）")
    const actual = countOccurrences(text, c[2])
    const expected = Number(c[4])
    const ok = compare(actual, c[3], expected)
    return row(line, 'count', ok ? 'pass' : 'fail', `实际出现 ${actual} 次，要求 ${c[3]} ${expected}`)
  }

  if (prefix === 'format') {
    if (!body) return row(line, 'format', 'unknown', 'format: 后面要跟一个正则')
    let re: RegExp
    try {
      const slashed = /^\/(.*)\/([gimsuy]*)$/.exec(body)
      re = slashed ? new RegExp(slashed[1], slashed[2]) : new RegExp(body)
    } catch (e: any) {
      // 写坏正则 → unknown。**绝不**当成"不匹配所以 fail"：那会冤枉合格交付物
      return row(line, 'format', 'unknown', `format: 正则写坏了（${e?.message || e}）`)
    }
    return re.test(text)
      ? row(line, 'format', 'pass', '交付物匹配格式要求')
      : row(line, 'format', 'fail', '交付物不匹配这条格式要求')
  }

  if (prefix === 'file') {
    const fm = /^(\S+)(?:\s+存在)?$/.exec(body)
    if (!fm) return row(line, 'file', 'unknown', 'file: 只认“<相对路径> 存在”')
    const rel = fm[1].replace(/\\/g, '/')
    if (/^[A-Za-z]:\//.test(rel) || rel.startsWith('/')) {
      return row(line, 'file', 'unknown', `file: 要写相对路径（拿到的是绝对路径“${rel}”）`)
    }
    if (typeof opts.exists !== 'function') {
      return row(line, 'file', 'unknown', `file: 没有注入存在性检查，判不了“${rel}”`)
    }
    return opts.exists(rel)
      ? row(line, 'file', 'pass', `文件存在：${rel}`)
      : row(line, 'file', 'fail', `文件不存在：${rel}`)
  }

  return row(line, 'unknown', 'unknown', `未知前缀 ${m[1]}: —— 只认 str / count / format / file`)
}

/**
 * 机检一份交付物。
 * **任何输入都不抛**；判据为空 = 收不了（ok=false），交付物为空 = 每条 fail（不是 pass）。
 */
export function checkDeliverable(
  deliverable: string,
  criteria: string[],
  opts: IntakeOptions = {},
): IntakeReport {
  const text = String(deliverable ?? '')
  const lines = (Array.isArray(criteria) ? criteria : [])
    .map((c) => normalizeIntakeLine(c))
    .filter((c) => c.length > 0)

  if (!lines.length) {
    const summary = '收卡机检：卡上没写判据 —— 没判据就验不了，这张卡只能当草稿'
    return {
      ok: false, total: 0, passed: 0, failed: 0, unknown: 0, rows: [],
      summary, redFlags: ['（卡上没有 str / count / format / file 判据）'],
    }
  }

  const rows = lines.map((l) => checkIntakeLine(l, text, opts))
  const passed = rows.filter((r) => r.state === 'pass').length
  const failed = rows.filter((r) => r.state === 'fail').length
  const unknown = rows.filter((r) => r.state === 'unknown').length
  const ok = passed === rows.length && rows.length > 0
  const redFlags = rows
    .filter((r) => r.state !== 'pass')
    .map((r, i) => `${i + 1}. “${r.raw}”→ ${r.detail}（${r.state === 'unknown' ? '未判定' : '不过'}）`)

  const summary = ok
    ? `收卡机检：${passed}/${rows.length} 全过`
    : `收卡机检：${passed}/${rows.length} 通过 · ${failed} 条不过 · ${unknown} 条未判定`

  return { ok, total: rows.length, passed, failed, unknown, rows, summary, redFlags }
}

/**
 * 把机检报告渲染成卡正文的一节（**留痕**：谁交的、什么时候、哪几条不过）。
 * 调用方应当在 ok=false 时也照样落卡 —— 这一节就是"红标"的载体。
 */
export function renderIntakeSection(report: IntakeReport, meta: { at: string; agent?: string; model?: string }): string {
  const L: string[] = []
  L.push('## 收卡机检')
  L.push('')
  L.push(`- 时间：${meta.at}`)
  if (meta.agent) L.push(`- 交单人：${meta.agent}`)
  if (meta.model) L.push(`- 模型：${meta.model}`)
  L.push(`- 结果：${report.summary.replace(/^收卡机检：/, '')}`)
  L.push(`- 口径：机检不过**不阻挡落卡**，但不过的条目必须逐条列出（红标）；判据由建卡方写在卡上`)
  if (report.rows.length) {
    L.push('')
    L.push('| 判据原文 | 类型 | 结论 | 判定 |')
    L.push('|---|---|---|---|')
    for (const r of report.rows) {
      const state = r.state === 'pass' ? '通过' : r.state === 'fail' ? '不过' : '未判定'
      L.push(`| ${r.raw.replace(/\|/g, '\\|')} | ${r.kind} | ${r.detail.replace(/\|/g, '\\|')} | ${state} |`)
    }
  }
  if (report.redFlags.length) {
    L.push('')
    L.push('### ⚠ 红标（这几条没过）')
    L.push('')
    for (const f of report.redFlags) L.push(`- ${f}`)
  }
  return L.join('\n')
}
