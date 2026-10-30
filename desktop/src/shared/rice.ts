/**
 * 需求矩阵（RICE）—— 纯逻辑（2026-10-28）
 *
 * 口径真源：`docs/ADR-002-需求矩阵.md`（施工输入 =《方寸-RICE打分口径》v1.1 +
 * 《方寸-RICE格式闸结论-全栈》schema v1）。
 *
 * 为什么整块放 shared/：解析/渲染/校验/评分/等级全是**口径**，不是布局。
 * 口径埋在组件里，就只有"起得来界面"的机器能验它；放这里就能用 Node 直接断言
 * （样板 `shared/mismatch.ts` / `shared/neverRead.ts`）。
 *
 * 四条不许忘的硬约束：
 *  ① **总分不落盘** —— 池文件只存 R/I/C/E 四个原始分，RICE = R×I×C÷E 由页签现算。
 *     手改单项永远不会出现"总分与分项打架"（格式闸定稿设计）。
 *  ② **幂等** —— 同 eid 再灌只覆盖分数/备注/打分，**保留已存在的 拍板 与 决策id**。
 *  ③ **取值域硬校验** —— I/C/证据四档照 schema §3.2；非法条目**拒该条不拒整批**。
 *  ④ **不替人做决定** —— 等级只是池内相对位置（前 20% / 中位），拍板是用户动作；
 *     每个数字都要带得走「它证明不了什么」（RICE_LIMITS）。
 */

// ── 取值域（与 Python 侧 tegula/core.py 逐一对应；check-rice.py 会逐字对账）──

/** I 影响（省手工量）五档 */
export const RICE_IMPACT_VALUES = [0.25, 0.5, 1, 2, 3]

/** C 信心（证据等级）四档 */
export const RICE_CONFIDENCE_VALUES = [0.95, 0.85, 0.7, 0.6]

/** 证据等级 → C 值。**agent 共识≠证据，推断上限 0.7**。 */
export const RICE_EVIDENCE_TO_C: Record<string, number> = {
  亲口要: 0.95,
  实测踩过: 0.85,
  agent推断: 0.7,
  纯直觉: 0.6,
}

export const RICE_EVIDENCE_LEVELS = Object.keys(RICE_EVIDENCE_TO_C)

/** 来源类型：四类异源条目统一挂在池里 */
export const RICE_ORIGIN_TYPES = ['task', 'idea', 'todo', 'external']

/** 拍板值：空 = 未拍板 */
export const RICE_VERDICTS = ['有效', 'CUT']

export type RiceLevel = 'P0' | 'P1' | 'P2' | 'CUT'

export interface RiceItem {
  /** `rice-<type>-<原id>`；external 用 `rice-ext-<短hash>` */
  eid: string
  title: string
  /** type:id，type ∈ RICE_ORIGIN_TYPES */
  origin: string
  /** 每周真实频次（估数）—— 同时是散点气泡大小 */
  R: number
  /** 省手工量（五档） */
  I: number
  /** 信心（四档，由证据等级决定） */
  C: number
  /** 占几天（正整数，进公式） */
  E_days: number
  /** 预估花费（元，旁注，不进公式） */
  E_cost: number
  evidence: string
  /** 打分：谁 + 哪天 */
  by: string
  note: string
  /** '' | 有效 | CUT */
  verdict: '' | '有效' | 'CUT'
  /** 拍板落账成功后回填 */
  decisionId: string
  /** 手改时无法解析的已知字段原文：原样写回，**不静默吞掉** */
  raw?: Record<string, string>
  /** 未知字段（手写的扩展列）：原样透传，写回时不丢 */
  extra?: Array<{ k: string; v: string }>
  /**
   * 这条需求属于哪个项目（只读派生，不落盘）。
   * 由主进程在 rice:get 时按 origin 真读任务 / 待办 / 想法补上；
   * 界面不自己猜、也不依赖当前已加载的任务列表。
   */
  project?: string
}

export interface RicePool {
  /** 月预算（元）—— 容量护栏；0 = 未设置（不当成"没超支"） */
  budget: number
  items: RiceItem[]
}

/** 池文件头。`月预算` 必须落在文件里 —— 放 prefs 里就跟着 origin 一起没了。 */
export const RICE_HEADER = [
  '# 需求矩阵评估池（RICE）',
  '',
  '> 四个原始分在这里，总分由页签现算（不落盘）。口径见 docs/ADR-002-需求矩阵.md。',
].join('\n')

/** 界面上与数字一起出现的「它证明不了什么」（R7：只有数字没有局限 = 不合格） */
export const RICE_LIMITS = [
  '总分 = 频次 × 省工 × 信心 ÷ 工期，由页面现算、不落盘；改任一分项，总分与等级当场重算。',
  '等级只是「池内相对位置」（P0 = 前 20%，P1 到中位），池子一变等级就变，它不是绝对标准。',
  '使用频次、省手工量都是估数；没有实测来源时，它证明不了"该做"。',
  '证据等级是信心的唯一依据：agent 推断上限 70%，"agent 们都说好"不算证据。',
  '分数只把判断显性化，不替你做决定；真正的取舍在分数之外。',
]

/**
 * 原型里那句写在最显眼处的立场（2026-10-29 暮雨第 1 条）：
 * 「分数只把判断显性化，不替你做决定。真正的取舍在分数之外。」
 * 单独成常量、单独渲染 —— 混在 RICE_LIMITS 五条里就没人看得见（而它是最该被看见的一句）。
 */
export const RICE_STANCE = '分数只把判断显性化，不替你做决定。真正的取舍在分数之外。'

/** 原型的重评触发条件：只有一个，不搞一堆阈值 */
export const RICE_RECHECK = '重评触发：当季容量变动超过 20%，或出现新的实测证据。'

export const RICE_EMPTY_TEXT =
  '评估池里还没有条目 —— 先把候选需求加进来，再回来看分数与等级。'

// ── 小工具 ────────────────────────────────────────────────────────────

/** 两位小数（**half-up**，与 Python `_rice_round2` 逐字一致）。
 *  ⚠ 别换成 Python 的 round()：它是银行家舍入，2.125 会变 2.12 而 JS 给 2.13 ——
 *    同一条目两条腿算出不同分数，比不四舍五入更糟。 */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return NaN
  return Math.round(n * 100) / 100
}

/** RICE = R × I × C ÷ E；E 非正或任一项非法 → NaN（不假装算得出） */
export function scoreOf(it: RiceItem): number {
  if (!it) return NaN
  const { R, I, C, E_days } = it
  if (![R, I, C, E_days].every((x) => Number.isFinite(x))) return NaN
  if (E_days <= 0) return NaN
  return round2((R * I * C) / E_days)
}

export function splitOrigin(origin: string): { type: string; id: string } | null {
  const s = String(origin ?? '').trim()
  const i = s.indexOf(':')
  if (i <= 0) return null
  const type = s.slice(0, i).trim()
  const id = s.slice(i + 1).trim()
  if (!type || !id) return null
  if (!RICE_ORIGIN_TYPES.includes(type)) return null
  return { type, id }
}

function num(v: unknown): number {
  const s = String(v ?? '').trim()
  if (!s) return NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

function pickField(arr: number[], q: number): number {
  if (!arr.length) return NaN
  const s = arr.slice().sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))
  return s[i]
}

function median(arr: number[]): number {
  if (!arr.length) return NaN
  const s = arr.slice().sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// ── 解析 / 渲染（节式，与 decisions.md 同款；两端逐字节兼容）────────────

const SECTION_RE = /^##\s+(rice-\S+)\s*(.*)$/
const KV_RE = /^-\s*([^:：]{1,24}?)\s*[:：]\s*(.*)$/
const KNOWN_KEYS = ['标题', '来源', 'R', 'I', 'C', 'E天', 'E元', '证据', '打分', '备注', '拍板', '决策id']

function emptyItem(eid: string, title: string): RiceItem {
  return {
    eid,
    title,
    origin: '',
    R: NaN,
    I: NaN,
    C: NaN,
    E_days: NaN,
    E_cost: 0,
    evidence: '',
    by: '',
    note: '',
    verdict: '',
    decisionId: '',
  }
}

/**
 * 解析 rice-pool.md。坏行宽容跳过（别让手改坏一行拖死整页），
 * 但**已知字段里解析不出的原文留在 raw 里**，写回时原样吐回 —— 不静默清空。
 */
export function parseRicePool(text: string): RicePool {
  const src = String(text ?? '')
  const pool: RicePool = { budget: 0, items: [] }
  const bm = /月预算\s*[（(]?\s*元\s*[）)]?\s*[:：]\s*(-?\d+(?:\.\d+)?)/.exec(src)
  if (bm) pool.budget = Math.max(0, Number(bm[1]))

  let cur: RiceItem | null = null
  let last: { kind: 'field'; name: string } | { kind: 'extra'; idx: number } | null = null

  const flush = () => {
    if (cur) pool.items.push(cur)
    cur = null
    last = null
  }

  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim()
    const sec = SECTION_RE.exec(line)
    if (sec) {
      flush()
      cur = emptyItem(sec[1], (sec[2] || '').trim())
      continue
    }
    if (!cur) continue
    const kv = KV_RE.exec(line)
    if (kv) {
      const k = kv[1].trim()
      const v = kv[2].trim()
      if (k === '标题') {
        cur.title = v
        last = { kind: 'field', name: 'title' }
      } else if (k === '来源') {
        cur.origin = v
        last = { kind: 'field', name: 'origin' }
      } else if (k === 'R' || k === 'I' || k === 'C' || k === 'E天' || k === 'E元') {
        const field = k === 'E天' ? 'E_days' : k === 'E元' ? 'E_cost' : k
        const n = num(v)
        ;(cur as any)[field] = n
        if (!Number.isFinite(n)) {
          cur.raw = cur.raw || {}
          cur.raw[field] = v
        }
        last = { kind: 'field', name: field }
      } else if (k === '证据') {
        cur.evidence = v
        last = { kind: 'field', name: 'evidence' }
      } else if (k === '打分') {
        cur.by = v
        last = { kind: 'field', name: 'by' }
      } else if (k === '备注') {
        cur.note = v
        last = { kind: 'field', name: 'note' }
      } else if (k === '拍板') {
        cur.verdict = (v === '有效' || v === 'CUT' ? v : '') as any
        last = { kind: 'field', name: 'verdict' }
      } else if (k === '决策id') {
        cur.decisionId = v
        last = { kind: 'field', name: 'decisionId' }
      } else if (KNOWN_KEYS.includes(k)) {
        last = null
      } else {
        cur.extra = cur.extra || []
        cur.extra.push({ k, v })
        last = { kind: 'extra', idx: cur.extra.length - 1 }
      }
      continue
    }
    // 续行：备注多行的第二行起（渲染时是裸行），拼回上一字段
    if (line && last) {
      if (last.kind === 'field') {
        const name = last.name as keyof RiceItem
        const prev = (cur as any)[last.name]
        if (typeof prev === 'string') (cur as any)[last.name] = (prev ? prev + '\n' : '') + line
        else if (typeof prev === 'number') (cur as any)[last.name] = prev
        else (cur as any)[name] = line
      } else if (cur.extra && cur.extra[last.idx]) {
        cur.extra[last.idx].v = (cur.extra[last.idx].v ? cur.extra[last.idx].v + '\n' : '') + line
      }
    }
  }
  flush()
  return pool
}

function numText(it: RiceItem, field: 'R' | 'I' | 'C' | 'E_days' | 'E_cost'): string {
  const raw = it.raw && it.raw[field] !== undefined ? it.raw[field] : null
  if (raw !== null) return raw
  const v = (it as any)[field]
  return Number.isFinite(v) ? String(v) : ''
}

/** 渲染池文件。顺序 = 池内顺序（不在写盘时偷偷排序：界面排序是界面的事）。 */
export function renderRicePool(pool: RicePool): string {
  const out: string[] = [RICE_HEADER]
  out.push('> 月预算（元）: ' + (Number.isFinite(pool.budget) ? pool.budget : 0))
  out.push('')
  for (const it of pool.items || []) {
    out.push(`## ${it.eid} ${it.title || ''}`.trimEnd())
    out.push(`- 标题: ${it.title || ''}`)
    out.push(`- 来源: ${it.origin || ''}`)
    out.push(`- R: ${numText(it, 'R')}`)
    out.push(`- I: ${numText(it, 'I')}`)
    out.push(`- C: ${numText(it, 'C')}`)
    out.push(`- E天: ${numText(it, 'E_days')}`)
    out.push(`- E元: ${numText(it, 'E_cost')}`)
    out.push(`- 证据: ${it.evidence || ''}`)
    out.push(`- 打分: ${it.by || ''}`)
    out.push(`- 备注: ${it.note || ''}`)
    out.push(`- 拍板: ${it.verdict || ''}`)
    out.push(`- 决策id: ${it.decisionId || ''}`)
    for (const ex of it.extra || []) out.push(`- ${ex.k}: ${ex.v}`)
    out.push('')
  }
  return out.join('\n') + '\n'
}

// ── 校验（schema §3.2 的取值域硬校验）────────────────────────────────

export interface RiceInput {
  eid: string
  title: string
  origin: string
  R: number
  I: number
  C?: number
  E_days: number
  E_cost?: number
  evidence: string
  by?: string
  note?: string
}

export interface ValidatedRice {
  ok: boolean
  item?: RiceItem
  errors: string[]
  warnings: string[]
}

/** 单条入参 → 池条目。错误逐条列出（调用方拒该条、继续整批）。 */
export function validateRiceInput(raw: any): ValidatedRice {
  const errors: string[] = []
  const warnings: string[] = []
  const r = (raw && typeof raw === 'object' ? raw : {}) as any

  const eid = String(r.eid ?? '').trim()
  if (!eid) errors.push('eid 为空')
  else if (/\s/.test(eid)) errors.push('eid 不能含空白（它同时是节标题标识）')

  const title = String(r.title ?? '').trim()
  if (!title) errors.push('标题为空')

  const origin = String(r.origin ?? '').trim()
  const sp = splitOrigin(origin)
  if (!origin) errors.push('来源为空（type:id，type ∈ ' + RICE_ORIGIN_TYPES.join('/') + '）')
  else if (!sp) errors.push('来源格式不对：' + origin + '（type:id，type ∈ ' + RICE_ORIGIN_TYPES.join('/') + '）')

  const ev = String(r.evidence ?? '').trim()
  if (!RICE_EVIDENCE_LEVELS.includes(ev)) {
    errors.push('证据必须是 ' + RICE_EVIDENCE_LEVELS.join('/') + '，收到：' + (ev || '(空)'))
  }

  const R = num(r.R)
  if (!Number.isFinite(R)) errors.push('R 不是数字：' + String(r.R ?? ''))
  else if (R < 0) errors.push('R 必须非负')

  const I = num(r.I)
  if (!Number.isFinite(I)) errors.push('I 不是数字：' + String(r.I ?? ''))
  else if (!RICE_IMPACT_VALUES.includes(I)) {
    errors.push('I 必须 ∈ {' + RICE_IMPACT_VALUES.join(',') + '}，收到：' + I)
  }

  // C：给了就校验；没给从证据等级推（**C 的唯一依据是证据**）
  let C = r.C === undefined || r.C === null || String(r.C).trim() === '' ? NaN : num(r.C)
  if (!Number.isFinite(C)) {
    C = RICE_EVIDENCE_TO_C[ev] ?? NaN
  } else if (!RICE_CONFIDENCE_VALUES.includes(C)) {
    errors.push('C 必须 ∈ {' + RICE_CONFIDENCE_VALUES.join(',') + '}，收到：' + C)
  } else if (RICE_EVIDENCE_TO_C[ev] !== undefined && RICE_EVIDENCE_TO_C[ev] !== C) {
    warnings.push('C=' + C + ' 与证据「' + ev + '」对应的 ' + RICE_EVIDENCE_TO_C[ev] + ' 不一致（按入参写，不替你改）')
  }

  const E_days = num(r.E_days)
  if (!Number.isFinite(E_days)) errors.push('E天 不是数字：' + String(r.E_days ?? ''))
  else if (!Number.isInteger(E_days) || E_days <= 0) errors.push('E天 必须是正整数（进公式）')

  const E_cost = r.E_cost === undefined || r.E_cost === null || String(r.E_cost).trim() === '' ? 0 : num(r.E_cost)
  if (!Number.isFinite(E_cost)) errors.push('E元 不是数字：' + String(r.E_cost))
  else if (E_cost < 0) errors.push('E元 必须非负')

  if (errors.length) return { ok: false, errors, warnings }

  return {
    ok: true,
    errors,
    warnings,
    item: {
      eid,
      title,
      origin,
      R,
      I,
      C,
      E_days,
      E_cost,
      evidence: ev,
      by: String(r.by ?? '').trim(),
      note: String(r.note ?? '').trim(),
      verdict: '',
      decisionId: '',
    },
  }
}

// ── 幂等 upsert（同 eid 覆盖分数/备注/打分，保留拍板 + 决策id）─────────

export interface UpsertResult {
  pool: RicePool
  added: string[]
  updated: string[]
  rejected: Array<{ eid: string; error: string }>
  warnings: Array<{ eid: string; warning: string }>
}

/**
 * 合入一批初分。**不落盘**（IO 在 data/rice.ts），这里只决定"变成什么样"。
 *
 * `originExists` 由调用方注入（纯逻辑不碰文件系统）：引用 task/idea/todo 时校验存在性，
 * 不存在 → **拒该条、不拒整批**；external 不校验。
 *
 * `by` / `date` 决定 `打分` 列：`<by> <date>`。条目自带 by 时以条目为准。
 */
export function mergeRiceUpsert(
  pool: RicePool,
  inputs: any[],
  opts: { by?: string; date?: string; originExists?: (type: string, id: string) => boolean } = {}
): UpsertResult {
  const next: RicePool = { budget: Number.isFinite(pool?.budget) ? pool.budget : 0, items: (pool?.items || []).slice() }
  const added: string[] = []
  const updated: string[] = []
  const rejected: Array<{ eid: string; error: string }> = []
  const warnings: Array<{ eid: string; warning: string }> = []
  const date = opts.date || new Date().toISOString().slice(0, 10)

  for (const raw of Array.isArray(inputs) ? inputs : []) {
    const v = validateRiceInput(raw)
    const eid = String((raw && raw.eid) ?? '').trim() || '(无 eid)'
    if (!v.ok || !v.item) {
      rejected.push({ eid, error: v.errors.join('；') })
      continue
    }
    const it = v.item
    for (const w of v.warnings) warnings.push({ eid: it.eid, warning: w })

    // 来源存在性：引用不存在 → 拒该条（不许把分数挂在幽灵条目上）
    const sp = splitOrigin(it.origin)!
    if (sp.type !== 'external' && opts.originExists && !opts.originExists(sp.type, sp.id)) {
      rejected.push({ eid: it.eid, error: '来源不存在：' + it.origin })
      continue
    }

    const idx = next.items.findIndex((x) => x.eid === it.eid)
    if (idx < 0) {
      it.by = it.by || [opts.by, date].filter(Boolean).join(' ')
      next.items.push(it)
      added.push(it.eid)
      continue
    }
    const old = next.items[idx]
    // 覆盖：分数 / 备注 / 打分（规格 §3.2）。title/origin 缺才补，不拿新值洗掉旧值。
    old.R = it.R
    old.I = it.I
    old.C = it.C
    old.E_days = it.E_days
    old.E_cost = it.E_cost
    old.evidence = it.evidence
    old.by = it.by || [opts.by, date].filter(Boolean).join(' ')
    if (raw && raw.note !== undefined) old.note = it.note
    if (!old.title) old.title = it.title
    if (!old.origin) old.origin = it.origin
    // verdict / decisionId **不动** —— 这是幂等的要害
    updated.push(it.eid)
  }

  return { pool: next, added, updated, rejected, warnings }
}

// ── 等级 / 象限 / 散点几何（页签端现算）──────────────────────────────

export interface RiceLevelRow {
  eid: string
  score: number
  level: RiceLevel
}

/**
 * 等级按**池内相对位置**分（不是绝对分数线 —— 原型那套 P0≥2000 在方寸量级不适用）：
 * P0 = 前 20%，P1 = 到中位，其余 P2；已拍板 CUT 的恒为 CUT。
 * 同分共享档位（用切分分数比较，避免同分被腰斩成两档）。
 */
export function riceLevels(items: RiceItem[]): RiceLevelRow[] {
  const valid = (items || []).filter((it) => Number.isFinite(scoreOf(it)))
  const live = valid.filter((it) => it.verdict !== 'CUT')
  const sorted = live.slice().sort((a, b) => scoreOf(b) - scoreOf(a))
  const n = sorted.length
  const p0Count = n ? Math.max(1, Math.ceil(n * 0.2)) : 0
  const p1Count = n ? Math.max(p0Count, Math.ceil(n * 0.5)) : 0
  const p0Cut = p0Count ? scoreOf(sorted[p0Count - 1]) : Infinity
  const p1Cut = p1Count ? scoreOf(sorted[p1Count - 1]) : Infinity

  const rows: RiceLevelRow[] = []
  for (const it of items || []) {
    const s = scoreOf(it)
    if (it.verdict === 'CUT') {
      rows.push({ eid: it.eid, score: s, level: 'CUT' })
      continue
    }
    if (!Number.isFinite(s)) {
      rows.push({ eid: it.eid, score: s, level: 'P2' })
      continue
    }
    const level: RiceLevel = s >= p0Cut ? 'P0' : s >= p1Cut ? 'P1' : 'P2'
    rows.push({ eid: it.eid, score: s, level })
  }
  return rows
}

export function levelOfMap(items: RiceItem[]): Record<string, RiceLevel> {
  const out: Record<string, RiceLevel> = {}
  for (const r of riceLevels(items)) out[r.eid] = r.level
  return out
}

export function quadrantLabel(x: number, y: number, splitX: number, splitY: number): string {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return ''
  const lowCost = x <= splitX
  const highGain = y >= splitY
  if (highGain && lowCost) return '优先做'
  if (highGain && !lowCost) return '要想清楚'
  if (!highGain && lowCost) return '顺手'
  return '别做'
}

export interface RicePoint {
  eid: string
  title: string
  level: RiceLevel
  score: number
  x: number
  y: number
  r: number
  quadrant: string
}

export interface RiceGeometry {
  points: RicePoint[]
  /** 坐标轴上限（画刻度用） */
  maxX: number
  maxY: number
  splitX: number
  splitY: number
}

/**
 * 散点：横轴 = 成本（天数，0 起），纵轴 = RICE 得分（0 起），气泡大小 = 使用频次 R。
 * 只画算得出的条目（E天 非法/总分 NaN 的不画 —— 不拿 0 假装有分）。
 */
export function riceGeometry(items: RiceItem[], width = 560, height = 320, pad = 30): RiceGeometry {
  const rows = (items || [])
    .map((it) => ({ it, s: scoreOf(it) }))
    .filter((x) => Number.isFinite(x.s) && Number.isFinite(x.it.E_days) && x.it.E_days > 0)
  const levels = levelOfMap(rows.map((x) => x.it))
  const xs = rows.map((x) => x.it.E_days)
  const ys = rows.map((x) => x.s)
  const maxX = xs.length ? Math.max(...xs) : 0
  const maxY = ys.length ? Math.max(...ys) : 0
  const splitX = median(xs)
  const splitY = median(ys)
  const maxR = rows.reduce((m, x) => Math.max(m, Number.isFinite(x.it.R) ? x.it.R : 0), 0)
  const innerW = Math.max(1, width - pad * 2)
  const innerH = Math.max(1, height - pad * 2)
  const points: RicePoint[] = rows.map(({ it, s }) => {
    const px = maxX > 0 ? pad + (it.E_days / maxX) * innerW : width / 2
    const py = maxY > 0 ? height - pad - (s / maxY) * innerH : height / 2
    const ratio = maxR > 0 ? Math.max(0, Math.min(1, (it.R || 0) / maxR)) : 0
    return {
      eid: it.eid,
      title: it.title,
      level: levels[it.eid] || 'P2',
      score: s,
      x: Math.round(px * 10) / 10,
      y: Math.round(py * 10) / 10,
      r: Math.round((4 + 10 * Math.sqrt(ratio)) * 10) / 10,
      quadrant: quadrantLabel(it.E_days, s, splitX, splitY),
    }
  })
  return { points, maxX, maxY, splitX, splitY }
}

// ── 「为什么做，为什么砍」（原型第 3 条设计判断，2026-10-29）──────────────
//
// 原型原话：「分数只是入口，理由逐条写」。它最狠的一句是关于被砍项：
// 「它最危险的地方是**听起来很酷** —— RICE 的唯一作用，就是把审美冲动挡在排期之外。」
// 所以这一节不能只列结论：**拍板了却写不出理由**的条目必须被点名，那就是没拍板。

export interface RiceWhyRow {
  eid: string
  title: string
  verdict: '有效' | 'CUT'
  /** 备注（理由）；空 = 没写 */
  why: string
  evidence: string
  hasWhy: boolean
}

export interface RiceWhyReview {
  keep: RiceWhyRow[]
  cut: RiceWhyRow[]
  /** 已拍板但备注为空 —— 说不清为什么，就是没拍板 */
  missingWhy: number
  /** 还没拍板的条数 */
  pending: number
  text: string
}

export function riceWhyReview(pool: RicePool): RiceWhyReview {
  const items = pool?.items || []
  const rows: RiceWhyRow[] = items
    .filter((it) => it.verdict === '有效' || it.verdict === 'CUT')
    .map((it) => {
      const why = String(it.note || '').trim()
      return {
        eid: it.eid,
        title: it.title,
        verdict: it.verdict as '有效' | 'CUT',
        why,
        evidence: String(it.evidence || '').trim(),
        hasWhy: !!why,
      }
    })
  const keep = rows.filter((r) => r.verdict === '有效')
  const cut = rows.filter((r) => r.verdict === 'CUT')
  const missingWhy = rows.filter((r) => !r.hasWhy).length
  const pending = items.length - rows.length
  const parts: string[] = []
  if (rows.length) parts.push(`已决定 ${rows.length}（做 ${keep.length} / 砍 ${cut.length}）`)
  if (missingWhy) parts.push(`${missingWhy} 条决定没写理由`)
  if (pending) parts.push(`还有 ${pending} 条未决定`)
  const text = parts.join(' · ') || '还没有决定记录'
  return { keep, cut, missingWhy, pending, text }
}

// ── 汇总 / 预算护栏 ───────────────────────────────────────────────────

export type RiceGuard = 'unset' | 'ok' | 'tight' | 'over'

export interface RiceSummary {
  total: number
  decided: number
  pending: number
  cut: number
  /** P0 合计花费（元） */
  p0Cost: number
  /** P0 合计成本天数（人天）—— 预算没设时，这是唯一能看的容量口径 */
  p0Days: number
  budget: number
  /** 预算占用比例；预算未设置（0）= null，**不许说成 0%** */
  budgetRatio: number | null
  /** 余量（元）；预算未设置 = null */
  headroom: number | null
  /** 护栏判定：unset（没设预算）/ ok（有余量）/ tight（≥80%，排满风险）/ over（≥100%） */
  guard: RiceGuard
  /** 护栏那句话（与数字一起出现，不许只有数字） */
  guardText: string
  text: string
}

export function riceSummary(pool: RicePool): RiceSummary {
  const items = pool?.items || []
  const levels = levelOfMap(items)
  const total = items.length
  const cut = items.filter((it) => it.verdict === 'CUT').length
  const decided = items.filter((it) => it.verdict === '有效' || it.verdict === 'CUT').length
  const pending = total - decided
  const p0Cost = round2(
    items
      .filter((it) => levels[it.eid] === 'P0')
      .reduce((s, it) => s + (Number.isFinite(it.E_cost) ? it.E_cost : 0), 0)
  )
  const p0Days = items
    .filter((it) => levels[it.eid] === 'P0')
    .reduce((s, it) => s + (Number.isFinite(it.E_days) ? it.E_days : 0), 0)
  const budget = Number.isFinite(pool?.budget) ? pool.budget : 0
  const budgetRatio = budget > 0 ? round2(p0Cost / budget) : null
  const headroom = budget > 0 ? round2(budget - p0Cost) : null
  const ratio = budgetRatio || 0
  const guard: RiceGuard = budget <= 0 ? 'unset' : ratio >= 1 ? 'over' : ratio >= 0.8 ? 'tight' : 'ok'
  // 原型那句话的口径：**排满不等于好**——一次线上故障就会让整轮延期。
  const guardText = guard === 'unset'
    ? '月预算未设置 —— 不要把「没设预算」读成「没超支」'
    : guard === 'over'
      ? `P0 已超预算 ¥${Math.abs(headroom || 0)}：排满之后，一次线上故障就会让整轮延期`
      : guard === 'tight'
        ? `P0 占 ${Math.round(ratio * 100)}%，只剩 ¥${headroom} 余量 —— 排满等于把风险全押给线上故障`
        : `P0 占 ${Math.round(ratio * 100)}%，余量 ¥${headroom}（留给线上故障与需求变更）`
  const parts = [`${total} 条`, `未决定 ${pending}`, `已决定 ${decided}`, cut ? `砍掉 ${cut}` : '']
  parts.push(budget > 0
    ? `P0 花费 ¥${p0Cost} / 预算 ¥${budget}（${Math.round(ratio * 100)}%）`
    : '月预算未设置')
  if (p0Days > 0) parts.push(`P0 合计 ${p0Days} 人天`)
  const text = (total ? parts.filter(Boolean).join(' · ') : '') || ''
  return { total, decided, pending, cut, p0Cost, p0Days, budget, budgetRatio, headroom, guard, guardText, text }
}
