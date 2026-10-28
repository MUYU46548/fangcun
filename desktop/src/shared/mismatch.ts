/**
 * 「对不上」检测 —— 纯逻辑（2026-10-27，REV-008 一期 R4「让对不上可见」）
 *
 * 为什么抽成纯函数：三类判定全是**口径**，不是布局。口径写进组件，就只有"起得来界面"的机器能验它。
 * 放进 shared/ 就能用 Node 直接跑（样板 `shared/neverRead.ts`）。
 *
 * 三类，全部机械可判、零 LLM：
 *  ① **状态过期** —— registry 的「状态」里写了"最后核对"的日期，但仓库在那之后还在动。
 *     这是"按过期地图开车"的机械形态：判断建立在旧信息上，而没人报。
 *     ⚠ 没写日期的**不算过期**，单独归 `noDate`：不许把它当"很新"也不当"很旧"。
 *  ② **引用断裂** —— 卡正文里写的仓库内路径，磁盘上已经不存在（改名/删除后没回改卡）。
 *     ⚠ 必须**先在该卡「项目」对应的仓库里找**，否则跨项目卡会被全量误报
 *       （实测：账本卡引用 NovelForge 的 `scripts/utils/handoff.py`，在方寸里当然没有）。
 *     ⚠ 带行号（`ideas.ts:269`）、通配（`{a,b}.js`）、省略号（`docs/.../x`）的都**不是可判路径**，直接跳过。
 *  ③ **完成但没判据** —— 状态=完成，正文里找不到任何验收判据字样。
 *     "完成"是自报（004 卡的证据门），没有判据的完成等于没验。
 *
 * 文件系统不在这里碰：由调用方注入 `exists(path)`。这样测试给假实现即可，不需要真实磁盘。
 */

export interface RepoInfo {
  /** registry 里的 id 或 name，都用来匹配卡的「项目」字段 */
  keys: string[]
  /** 绝对路径 */
  path: string
  /** registry「状态」原文 */
  status: string
  /** 该仓库最后一次提交日期 YYYY-MM-DD；取不到为 null */
  lastCommit: string | null
}

export interface TaskRef {
  /** 卡文件名（含 .md） */
  name: string
  /** 正文（含 frontmatter） */
  text: string
}

export interface StaleRow {
  project: string
  why: string
  statusDate: string | null
  lastCommit: string | null
  deltaDays: number | null
}

export interface BrokenRow {
  task: string
  ref: string
  /** 找过的仓库名，第一个恒为「本仓」 */
  searched: string[]
}

export interface MovedRow {
  task: string
  ref: string
  why: string
}

export interface NoCriteriaRow {
  task: string
  title: string
}

export interface MismatchResult {
  stale: StaleRow[]
  /** 状态里连日期都没写 —— 不算过期，但也不能当作"已核对" */
  noDate: StaleRow[]
  broken: BrokenRow[]
  moved: MovedRow[]
  nocriteria: NoCriteriaRow[]
  total: number
}

const CRITERIA_WORDS = ['验收标准', '验收判据', '判定标准', '验收条件', 'Definition of Done', 'DoD']

/** 正文里被反引号包住的疑似仓库内路径 */
const PATH_IN_TEXT = /`((?:desktop|scripts|docs|tegula|templates|task-data|skills|references)\/[^`\s]+?)`/g

const RE_FULL_DATE = /(\d{4})-(\d{2})-(\d{2})/
const RE_MD_DATE = /(?<!\d)(\d{2})-(\d{2})(?!\d)/

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

function toISO(y: number, m: number, d: number): string | null {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null
  return y + '-' + pad(m) + '-' + pad(d)
}

/** 从状态文字里抠出"它说这是哪天"的最晚日期。不猜、不补：抠不到就 null。 */
export function statusDateOf(text: string, todayISO: string): string | null {
  const s = String(text ?? '')
  const today = todayISO || ''
  let best: string | null = null
  const consider = (iso: string | null) => {
    if (!iso) return
    if (today && iso > today) return // 未来日期不是"上次核对"
    if (!best || iso > best) best = iso
  }
  const y0 = today ? Number(today.slice(0, 4)) : new Date().getUTCFullYear()
  // 先扫 ISO 全日期：**出现多个时取最晚那个**（"10-05 起 · 10-20 更新" 要算 10-20，
  // 否则一条状态里写的旧日期会把"它其实最近核对过"判成过期 —— 测试抓到的真 bug）。
  const isoRe = new RegExp(RE_FULL_DATE.source, 'g')
  let mf: RegExpExecArray | null
  let sawISO = false
  while ((mf = isoRe.exec(s))) {
    sawISO = true
    consider(toISO(Number(mf[1]), Number(mf[2]), Number(mf[3])))
  }
  // 没有 ISO 才退到 MM-DD；同样取最晚。⚠ 有 ISO 时不混算：否则 "2025-03-05" 里的
  // "03-05" 会补成今天的年份，把去年的日期抬成今年。
  if (!sawISO) {
    const mdRe = new RegExp(RE_MD_DATE.source, 'g')
    let mm: RegExpExecArray | null
    while ((mm = mdRe.exec(s))) consider(toISO(y0, Number(mm[1]), Number(mm[2])))
  }
  return best
}

function daysBetween(aISO: string, bISO: string): number | null {
  const a = Date.parse(aISO + 'T00:00:00Z')
  const b = Date.parse(bISO + 'T00:00:00Z')
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 86400000)
}

/**
 * ① 状态过期：仓库最后提交**晚于**状态里写的日期 `days` 天以上。
 * 没日期的进 `noDate`（不是过期，是"没核对过"）；没提交记录的跳过（不是 git 仓库 → 无从判断，不猜）。
 */
export function pickStale(repos: RepoInfo[], todayISO: string, days = 3): { stale: StaleRow[]; noDate: StaleRow[] } {
  const stale: StaleRow[] = []
  const noDate: StaleRow[] = []
  for (const r of Array.isArray(repos) ? repos : []) {
    const name = (r.keys && r.keys.length ? r.keys[0] : '') || '(未命名)'
    if (!r.lastCommit) continue
    const sd = statusDateOf(r.status, todayISO)
    if (!sd) {
      noDate.push({ project: name, why: '状态里没写日期', statusDate: null, lastCommit: r.lastCommit, deltaDays: null })
      continue
    }
    const delta = daysBetween(sd, r.lastCommit)
    if (delta === null) continue
    if (delta >= days) {
      stale.push({ project: name, why: '仓库还在动，状态停在 ' + sd.slice(5), statusDate: sd, lastCommit: r.lastCommit, deltaDays: delta })
    }
  }
  stale.sort((a, b) => (b.deltaDays ?? 0) - (a.deltaDays ?? 0))
  return { stale, noDate }
}

/** 取卡的「项目」字段（`[a, b]` / `a` / 块式列表三种写法都要认） */
export function taskProjectsOf(text: string): string[] {
  const s = String(text ?? '')
  const m = /^项目:[ \t]*(.*)$/m.exec(s)
  if (!m) return []
  const raw = (m[1] || '').trim()
  if (raw.startsWith('[')) {
    return raw.replace(/^\[|\]$/g, '').split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  }
  if (raw && raw !== '~' && raw !== 'null') return [raw.replace(/^['"]|['"]$/g, '')]
  // 块式：项目:\n  - a\n  - b
  const out: string[] = []
  const lines = s.split('\n')
  const head = lines.findIndex((l) => /^项目:/.test(l))
  if (head < 0) return []
  for (let i = head + 1; i < lines.length; i++) {
    const mm = /^\s+-\s+(\S.*)$/.exec(lines[i])
    if (!mm) break
    out.push(mm[1].trim().replace(/^['"]|['"]$/g, ''))
  }
  return out
}

/** 剥行号、丢掉不是真路径的写法。返回 null = 不可判，直接跳过。 */
export function sanitizeRef(raw: string): string | null {
  let s = String(raw ?? '').trim()
  s = s.replace(/[.,;)）】\s]+$/, '')
  s = s.replace(/:\d+(-\d+)?$/, '') // ideas.ts:269 → ideas.ts
  if (!s) return null
  if (/[*?<>|{}]/.test(s)) return null
  if (s.includes('...') || s.includes('…')) return null
  if (s.endsWith('/') && s.split('/').filter(Boolean).length < 2) return null
  return s
}

export function isNoiseTaskName(name: string): boolean {
  const n = String(name ?? '')
  return !n.endsWith('.md') || n.startsWith('.') || n.endsWith('.bak') || n.endsWith('~')
}

/**
 * ② 引用断裂 + 归档指向。
 * `exists` 由调用方注入；跨仓库用 `reposOf(taskName)` 给出该卡可能的其他仓库，逐个试。
 */
export function pickBroken(
  tasks: TaskRef[],
  exists: (relPath: string) => boolean,
  opts: { reposOf?: (task: TaskRef) => { name: string; exists: (relPath: string) => boolean }[] } = {},
): { broken: BrokenRow[]; moved: MovedRow[] } {
  const broken: BrokenRow[] = []
  const moved: MovedRow[] = []
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (isNoiseTaskName(t.name)) continue
    const text = String(t.text ?? '')
    const alts = opts.reposOf ? opts.reposOf(t) : []
    const seen = new Set<string>()
    PATH_IN_TEXT.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = PATH_IN_TEXT.exec(text))) {
      const rel = sanitizeRef(m[1])
      if (!rel || seen.has(rel)) continue
      seen.add(rel)
      if (exists(rel)) continue
      // 指向的卡已归档/进回收站 → 不是"文件没了"，是"东西搬了"
      if (rel.startsWith('task-data/') && rel.endsWith('.md')) {
        const tail = rel.slice('task-data/'.length)
        const inStore = ['archive', '.trash'].some((sub) => exists('task-data/' + sub + '/' + tail))
        if (inStore) {
          moved.push({ task: t.name, ref: rel, why: '指向的卡已归档/进回收站，引用未回改' })
          continue
        }
      }
      let hitAlt = false
      for (const a of alts) {
        if (a.exists(rel)) { hitAlt = true; break }
      }
      if (hitAlt) continue
      broken.push({ task: t.name, ref: rel, searched: ['本仓'].concat(alts.map((a) => a.name)) })
    }
  }
  return { broken, moved }
}

/** ③ 完成但没判据 */
export function pickNoCriteria(tasks: TaskRef[]): NoCriteriaRow[] {
  const out: NoCriteriaRow[] = []
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (isNoiseTaskName(t.name)) continue
    const text = String(t.text ?? '')
    const st = /^状态:[ \t]*(.*)$/m.exec(text)
    if (!st || (st[1] || '').trim() !== '完成') continue
    const body = text.startsWith('---') ? text.split('---').slice(2).join('---') : text
    if (CRITERIA_WORDS.some((w) => body.includes(w))) continue
    const ti = /^标题:[ \t]*(.*)$/m.exec(text)
    const title = ti ? (ti[1] || '').trim().replace(/^['"]|['"]$/g, '') : t.name
    out.push({ task: t.name, title })
  }
  return out
}

export function collectMismatch(input: {
  repos: RepoInfo[]
  tasks: TaskRef[]
  todayISO: string
  exists: (relPath: string) => boolean
  reposOf?: (task: TaskRef) => { name: string; exists: (relPath: string) => boolean }[]
  days?: number
}): MismatchResult {
  const { stale, noDate } = pickStale(input.repos, input.todayISO, input.days ?? 3)
  const { broken, moved } = pickBroken(input.tasks, input.exists, { reposOf: input.reposOf })
  const nocriteria = pickNoCriteria(input.tasks)
  return {
    stale,
    noDate,
    broken,
    moved,
    nocriteria,
    total: stale.length + noDate.length + broken.length + moved.length + nocriteria.length,
  }
}

/**
 * 界面上那一行文案 —— 口径必须跟数字在一起（同 `neverReadSummary` 的理由）。
 * 三件事都不能说成"错误"：它们只是**对不上**，不是"做错了"。
 */
export function mismatchSummary(r: MismatchResult): string {
  if (!r || !r.total) return '没发现对不上的地方'
  const parts: string[] = []
  if (r.stale.length) parts.push(`状态过期 ${r.stale.length}`)
  if (r.noDate.length) parts.push(`状态没写日期 ${r.noDate.length}`)
  if (r.broken.length) parts.push(`引用断裂 ${r.broken.length}`)
  if (r.moved.length) parts.push(`指向已归档 ${r.moved.length}`)
  if (r.nocriteria.length) parts.push(`完成但没判据 ${r.nocriteria.length}`)
  return parts.join(' · ') + '（只是对不上，不是做错了；不阻挡任何操作）'
}
