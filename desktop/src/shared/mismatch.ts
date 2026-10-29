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

/**
 * 「完成但找不到产出」（2026-10-29 暮雨第 4 条 A 项）。
 *
 * 为什么单独一组：上一组只判\"有没有写验收判据\"，而 RICE 那张卡**写了判据**
 * （`结果记录：[…] 验收通过`）却**东西根本不在** —— 判据是自述，产出才是事实。
 * 这一组只回答一个问题：这张已完成卡上，有没有**任何一件可核实的东西**。
 */
export interface NoOutputRow {
  task: string
  title: string
  /** 完成/更新距今多少天（判据的一部分：昨天刚关的卡不质疑） */
  ageDays: number | null
  why: string
}

export interface MismatchResult {
  stale: StaleRow[]
  /** 状态里连日期都没写 —— 不算过期，但也不能当作"已核对" */
  noDate: StaleRow[]
  broken: BrokenRow[]
  moved: MovedRow[]
  nocriteria: NoCriteriaRow[]
  nooutput: NoOutputRow[]
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

/** ④ 完成但找不到产出（2026-10-29 暮雨第 4 条 A 项）─────────────────────
 *
 * 与 ③ 的分工：③ 问"写没写判据"，④ 问"东西在不在"。
 * RICE 那张卡 ③ 放它过去（写了「验收通过」），可产品里根本没有入口 ——
 * 判据是自述，产出才是事实。这一组只认**可核实的东西**：
 *   · 卡里提到的仓库内路径，磁盘上真的存在（本仓，或该卡项目对应的仓库）
 *   · 带上下文的提交号（`提交 abc1234` / `commit abc1234`）
 *   · http(s) 链接
 * 三样一个都没有，且这张卡已经关了一段时间 → 才报。
 *
 * ⚠ 这不是"判决"：很多卡本来就没有文件产出（口头拍板、调研结论）。所以界面文案
 *   必须带"只是提示"的口径，且**默认门槛是 7 天**——昨天刚关的卡不质疑。
 */
const RE_URL = /https?:\/\/[^\s)）]+/
const RE_COMMIT_CTX = /(提交|commit|sha)[^\n]{0,24}?\b[0-9a-f]{7,40}\b/i
/** 正文里裸露的疑似路径（不是反引号包着的那种，②③ 已有自己的口径） */
const PATH_BARE = /(?:^|[\s（("'`、,，:：])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6})(?=$|[\s）)"'`,，。;；])/g

function stripFrontmatter(text: string): string {
  const s = String(text ?? '')
  if (!s.startsWith('---')) return s
  const end = s.indexOf('\n---', 3)
  return end < 0 ? s : s.slice(end + 4)
}

function titleOfCard(text: string): string {
  const ti = /^标题:[ \t]*(.*)$/m.exec(String(text ?? ''))
  return ti ? (ti[1] || '').trim().replace(/^['"]|['"]$/g, '') : ''
}

/** 卡上的「更新」离今天多少天（认 ISO / MM-DD / 秒级时间戳三种写法） */
function ageDaysOf(text: string, todayISO: string): number | null {
  const m = /^更新:[ \t]*(.*)$/m.exec(String(text ?? ''))
  if (!m) return null
  const v = (m[1] || '').trim()
  let iso: string | null = null
  const full = RE_FULL_DATE.exec(v)
  if (full) iso = toISO(Number(full[1]), Number(full[2]), Number(full[3]))
  else if (/^\d{9,13}$/.test(v)) {
    const n = Number(v)
    const d = new Date(n > 1e12 ? n : n * 1000)
    if (!Number.isNaN(d.getTime())) {
      iso = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
    }
  } else {
    const md = RE_MD_DATE.exec(v)
    if (md) {
      const y = Number((todayISO || '').slice(0, 4)) || new Date().getUTCFullYear()
      iso = toISO(y, Number(md[1]), Number(md[2]))
    }
  }
  if (!iso || !todayISO) return null
  return daysBetween(iso, todayISO)
}

/** 这张完成卡上有没有「可核实的一件东西」 */
function hasVerifiableOutput(
  body: string,
  task: TaskRef,
  opts: { exists: (rel: string) => boolean; reposOf?: (t: TaskRef) => { name: string; exists: (rel: string) => boolean }[] },
): boolean {
  if (RE_URL.test(body)) return true
  if (RE_COMMIT_CTX.test(body)) return true
  const cands: string[] = []
  const back = new RegExp(PATH_IN_TEXT.source, 'g')
  let bm: RegExpExecArray | null
  while ((bm = back.exec(body))) cands.push(bm[1])
  const bare = new RegExp(PATH_BARE.source, 'g')
  let pm: RegExpExecArray | null
  while ((pm = bare.exec(body))) cands.push(pm[1])
  const alts = opts.reposOf ? opts.reposOf(task) : []
  for (const raw of cands) {
    let rel = String(raw || '').split(String.fromCharCode(92)).join('/')
    while (rel.startsWith('./') || rel.startsWith('/')) rel = rel.slice(rel.startsWith('./') ? 2 : 1)
    rel = rel.trim()
    if (!rel || /\.\.|[*{}]/.test(rel)) continue   // 通配 / 省略号不是可判路径
    if (opts.exists(rel)) return true
    for (const a of alts) if (a.exists(rel)) return true
  }
  return false
}

export function pickNoOutput(
  tasks: TaskRef[],
  opts: {
    todayISO: string
    exists: (rel: string) => boolean
    reposOf?: (t: TaskRef) => { name: string; exists: (rel: string) => boolean }[]
    /** 完成/更新少于这么多天的卡不质疑（默认 7） */
    minAgeDays?: number
  },
): NoOutputRow[] {
  const minAge = Number.isFinite(opts.minAgeDays as number) ? Number(opts.minAgeDays) : 7
  const out: NoOutputRow[] = []
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (isNoiseTaskName(t.name)) continue
    const text = String(t.text ?? '')
    const st = /^状态:[ 	]*(.*)$/m.exec(text)
    if (!st || (st[1] || '').trim() !== '完成') continue
    const body = stripFrontmatter(text)
    if (hasVerifiableOutput(body, t, opts)) continue
    const age = ageDaysOf(text, opts.todayISO)
    if (age !== null && age < minAge) continue
    out.push({
      task: t.name,
      title: titleOfCard(text) || t.name,
      ageDays: age,
      why: '已完成，但卡里找不到可核实的产出（没有存在的文件路径 / 提交号 / 链接）',
    })
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
  /** ④ 的门槛（天）：完成多久之后才开始被要求"东西在哪"。默认 7 */
  noOutputDays?: number
}): MismatchResult {
  const { stale, noDate } = pickStale(input.repos, input.todayISO, input.days ?? 3)
  const { broken, moved } = pickBroken(input.tasks, input.exists, { reposOf: input.reposOf })
  const nocriteria = pickNoCriteria(input.tasks)
  const nooutput = pickNoOutput(input.tasks, {
    todayISO: input.todayISO,
    exists: input.exists,
    reposOf: input.reposOf,
    minAgeDays: input.noOutputDays ?? 7,
  })
  return {
    stale,
    noDate,
    broken,
    moved,
    nocriteria,
    nooutput,
    total: stale.length + noDate.length + broken.length + moved.length + nocriteria.length + nooutput.length,
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
  if (r.nooutput.length) parts.push(`完成但找不到产出 ${r.nooutput.length}`)
  return parts.join(' · ') + '（只是对不上，不是做错了；不阻挡任何操作）'
}
