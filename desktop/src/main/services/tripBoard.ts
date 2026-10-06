/**
 * Fangcun Desktop — 「在途一屏」数据聚合（Q2 · 立项契约 ② 验收线之①）
 *
 * 一行一个在途项目，回答三问：**在哪一步 / 下一步 / 卡在谁**。
 * 数据全部读现成的：registry（项目登记）+ 各 repo 的 `立项契约.md` + 任务卡 + 执行日志 + git 提交时间。
 *
 * 红线（2026-10-05 暮雨拍板，三条）：
 *   1. **零硬编码项目清单** —— 项目由「判据」推导（默认：有未完结卡 或 30 天内有提交），
 *      用户可手动指定并记进 prefs（`fc_trip_mode` / `fc_trip_projects` / `fc_trip_criteria`）；
 *   2. **缺值一律空串/null**，由界面显示「未填」—— 绝不回退默认值（假成功比空白危险得多）；
 *   3. **只读**：不写任何项目仓库；本模块没有任何写盘调用。
 *
 * 健康度：机器只给**默认值**（提交新鲜度 + 是否有进行中的卡），用户可用 `fc_health_overrides`
 * 覆盖（如司天「预算受限、暂时搁置」这种机器永远算不出的状态），覆盖后在界面上带锁标记。
 */
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { parseRegistry, loadAllTasksRaw } from '../data'
import * as logs from './logs'
import * as prefs from './prefs'

export const CONTRACT_BASENAME = '立项契约.md'
export const TRIP_CRITERIA = ['cards', 'cards_or_commit', 'cards_or_log', 'manual'] as const
export type TripCriteria = typeof TRIP_CRITERIA[number]
export const TRIP_COLUMNS = ['end', 'current', 'next', 'who', 'health', 'counts', 'commit', 'dirty'] as const
export type TripColumn = typeof TRIP_COLUMNS[number]
export const TRIP_HEALTH = ['active', 'stuck', 'dormant', 'idle', 'paused'] as const
export type TripHealth = typeof TRIP_HEALTH[number]

/** 契约里随一屏/任务书下发的四个字段（⑤现状底数、⑥下一队列在文件里，不占屏宽） */
const CONTRACT_FIELDS = ['终态形态', '验收线', '不要什么', '选型定死'] as const

export interface TripContract {
  exists: boolean
  path: string
  endState: string
  acceptLine: string
  notWant: string
  choice: string
}

export interface TripCell {
  text: string
  /** 'task' = 来自任务卡；'log' = 来自执行日志（无卡项目，如司天）；'' = 没有 */
  from: 'task' | 'log' | ''
  sub: string
}

export interface TripRow {
  id: string
  name: string
  repo: string
  contract: TripContract
  current: TripCell
  next: TripCell
  who: { text: string; kind: 'exec' | 'review' | 'none' }
  health: { value: TripHealth; locked: boolean }
  counts: { todo: number; doing: number; review: number; logs: number }
  lastCommit: string
  recentCommit: boolean
  flags: { noCards: boolean; noLogs: boolean }
}

export interface TripBoard {
  generatedAt: string
  mode: 'auto' | 'manual'
  criteria: TripCriteria
  rows: TripRow[]
  /**
   * 登记了但**没进这一屏**的项目（判据没命中）。
   *
   * 为什么要回传：2026-10-05 用户「添加完项目刷新几遍根本看不到」—— 他加的项目没有任务卡、
   * 30 天内也没有提交，判据自然不收。但界面上**一个字都不说**，用户只会以为自己加失败了。
   * 现在的做法：把这批项目如实交出去，界面在表下写一行「另有 N 个未显示 —— 为什么 + 怎么让它显示」。
   */
  hidden: { id: string; name: string; reason: string; kind: 'not-picked' | 'no-activity' }[]
  /**
   * 是不是"手动指定但一个都没勾过"被自动兜底了。
   *
   * 2026-10-05 实测：prefs 里 `fc_trip_mode=manual` 而 `fc_trip_projects` 键**根本不存在**
   * （写盘只落了字符串键）→ 手动清单为空 → 15 个项目全部出局 → 用户看到一片空白，
   * 而界面上的说明还写着"它们没有未完结任务"（方寸自己有几十张卡，是假话）。
   *
   * 判据：`fc_trip_projects` 键**不存在** = 用户从没做过勾选这个动作 → 那不是"选了空清单"，
   * 是"没做过选择"，按自动走（界面会说明这次是兜底的）。
   * 键存在但为 `[]` = 用户主动清空过 → 尊重，界面给明确空态 + 一键回自动。
   */
  modeFallback: boolean
}

// ── 小工具（本地实现，不外引）────────────────────────────────────────────
function asList(v: unknown): string[] {
  if (v == null || v === '') return []
  if (Array.isArray(v)) return v.map(String)
  return [String(v)]
}

/** frontmatter 的「项目」可能是字符串也可能是数组 —— 两侧都能比中 */
function matchProject(fmProject: unknown, id: string): boolean {
  return asList(fmProject).includes(id)
}

function withinDays(iso: string, days: number): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return false
  return (Date.now() - t) / 86400000 <= days
}

export function relTime(iso: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const mins = Math.floor((Date.now() - t) / 60000)
  if (mins < 60) return mins <= 1 ? '刚刚' : `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return `${Math.floor(days / 30)} 个月前`
}

/** 优先级排序权重：高 > 中 > 低 > 未设 */
function prioWeight(v: unknown): number {
  const s = String(v || '')
  return s === '高' ? 0 : s === '中' ? 1 : s === '低' ? 2 : 3
}

/**
 * 解析一份立项契约（**纯函数**：只吃 repo 路径）。
 *
 * 与 Python 侧 `read_contract_file()` 同口径：按 `## ` 小节取，标题含字段关键词即可
 * （「## ① 终态形态」「## 终态形态」都认）。缺字段给空串，由界面显示「未填」。
 */
export function readContractFile(repo: string): TripContract {
  const p = repo ? path.join(repo, CONTRACT_BASENAME) : ''
  const out: TripContract = { exists: false, path: p, endState: '', acceptLine: '', notWant: '', choice: '' }
  if (!p || !fs.existsSync(p)) return out
  let raw = ''
  try {
    raw = fs.readFileSync(p, 'utf-8')
  } catch {
    return out
  }
  out.exists = true
  const heads: { name: string; start: number; bodyStart: number }[] = []
  const re = /^##\s+(.+?)\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    heads.push({ name: m[1].trim(), start: m.index, bodyStart: m.index + m[0].length })
  }
  const get = (key: string): string => {
    for (let i = 0; i < heads.length; i++) {
      if (!heads[i].name.includes(key)) continue
      const end = i + 1 < heads.length ? heads[i + 1].start : raw.length
      return raw.slice(heads[i].bodyStart, end).trim()
    }
    return ''
  }
  out.endState = get(CONTRACT_FIELDS[0])
  out.acceptLine = get(CONTRACT_FIELDS[1])
  out.notWant = get(CONTRACT_FIELDS[2])
  out.choice = get(CONTRACT_FIELDS[3])
  return out
}

// ── git（带缓存；失败一律给空串，绝不抛）──────────────────────────────────
const gitCache = new Map<string, { at: number; iso: string }>()
const GIT_TTL = 60_000

export function gitLastCommitAt(repo: string): string {
  if (!repo || !fs.existsSync(repo)) return ''
  const hit = gitCache.get(repo)
  const now = Date.now()
  if (hit && now - hit.at < GIT_TTL) return hit.iso
  let iso = ''
  try {
    iso = String(execFileSync('git', ['-C', repo, 'log', '-1', '--format=%cI'], {
      timeout: 8000, encoding: 'utf-8', windowsHide: true,
    }) || '').trim()
  } catch {
    // 不是 git 仓库 / 没装 git / 超时 —— 都按"没有这个信息"处理，界面显示空
    iso = ''
  }
  gitCache.set(repo, { at: now, iso })
  return iso
}

/** 供测试与手动刷新使用 */
export function clearGitCache(): void {
  gitCache.clear()
}

/**
 * 在项目文件夹里**创建**「立项契约.md」（2026-10-05 用户：让方寸直接写，弹窗确认即可，不静默做）。
 *
 * 与「只读、不写他人仓库」的关系（边界说清楚，别让下一个人以为红线没了）：
 *   · **只在文件不存在时创建** —— 已存在一律拒绝，绝不覆盖用户或 AI 写过的任何内容；
 *   · 只写这一个固定文件名、固定模板内容，**不接受任意路径、任意内容**；
 *   · 调用方（渲染层）必须先弹确认框，把「写到哪 / 写什么 / 什么情况会拒绝」念清楚再动手。
 */
export function initContractFile(projectId: string): { ok: boolean; path?: string; error?: string } {
  const repo = repoOfProject(projectId)
  if (!repo) return { ok: false, error: '该项目在 registry 里没有登记文件夹路径' }
  if (!fs.existsSync(repo)) return { ok: false, error: `文件夹不存在：${repo}` }
  const target = path.join(repo, CONTRACT_BASENAME)
  if (fs.existsSync(target)) {
    return { ok: false, error: `「${CONTRACT_BASENAME}」已经存在，没有覆盖它（要改就直接编辑那个文件）` }
  }
  try {
    fs.writeFileSync(target, contractTemplate(projectId), 'utf-8')
  } catch (e: any) {
    return { ok: false, error: `写入失败：${e?.message || e}` }
  }
  return { ok: true, path: target }
}

/**
 * 按项目 id 取登记的工作目录（渲染层只传 id，主进程去 registry 取路径 → 防任意路径调用） */
export function repoOfProject(projectId: string): string {
  const id = String(projectId || '').trim()
  if (!id) return ''
  for (const p of parseRegistry(true) as any[]) {
    if (String(p?.id || '') === id) return String(p?.repo || '')
  }
  return ''
}

/**
 * 契约骨架（点「复制模板」时给用户的东西）。
 *
 * 只是**文本**，方寸不写任何仓库 —— 用户自己去 `<repo>/立项契约.md` 落盘。
 * 与仓库里方寸自己那份 `立项契约.md` 同一套六字段。
 */
export function contractTemplate(projectId: string): string {
  const id = String(projectId || '').trim()
  let name = id
  for (const p of parseRegistry(true) as any[]) {
    if (String(p?.id || '') === id) { name = String(p?.name || id); break }
  }
  return [
    `# 立项契约 · ${name}（${id}）`,
    '',
    '> **真源就是本文件**（放在项目仓库根，与 AGENTS.md 同级）。',
    '> **第一个读者是 AI**：agent 在本仓库开工前先读本文件；与「最新一句话」冲突时以契约为准，除非走 REV 修订。',
    '> 模板：《立项契约包 v1》甲节（六字段 + 五机制条款）。',
    '',
    '---',
    '',
    '## ① 终态形态',
    '',
    '（一句话：我一开始想要的就是 ___。用户原话直录，不改写。）',
    '',
    '## ② 验收线',
    '',
    '（「完整投入真实使用」的判据链 —— 操作链每环无断点。用户定终点，我们拆链。）',
    '',
    '## ③ 不要什么',
    '',
    '（负面清单，用户原话直录；改需求 ≠ 删此栏。）',
    '',
    '## ④ 选型定死',
    '',
    '（框架/通道/形态：为什么选、否决了谁、退出条件。**④ 未定不开工**。）',
    '',
    '## ⑤ 现状底数',
    '',
    '（一行现状 + 引用出处。）',
    '',
    '## ⑥ 下一队列',
    '',
    '（有验收锚点的下一步；不登记没锚点的条目。）',
    '',
    '---',
    '',
    '## 五条机制条款（全项目通用）',
    '',
    '1. **契约第一个读者是 AI**：契约进各项目仓库、与 AGENTS.md 同级；每份任务书加开工前置步「先读契约再动工」。',
    '2. **变更走契约**：中途换方向 = 显式 REV 留痕，禁口头漂移。',
    '3. **返工归因标签**：每轮返工收尾打一枚（需求没拟死 / 选型没论证 / 执行层改不对）；同一 bug 三轮不过换执行者，禁死磕。',
    '4. **选型关口**：④ 未定不开工。',
    '5. **念回签收**：契约成稿后「原话 + 翻译」并列念回，用户点头才算拟死。',
    '',
    '## REV 修订记录',
    '',
    '| REV | 日期 | 变更 | 依据 |',
    '|---|---|---|---|',
    '| —— | —— | —— | —— |',
    '',
  ].join('\n')
}

// ── 主聚合 ───────────────────────────────────────────────────────────────
interface RawPrefs {
  fc_trip_mode?: string
  fc_trip_criteria?: string
  fc_trip_projects?: unknown
  fc_health_overrides?: Record<string, unknown> | null
}

export function buildTripBoard(): TripBoard {
  const p = (prefs.getPrefs() || {}) as RawPrefs
  const rawMode: 'auto' | 'manual' = p.fc_trip_mode === 'manual' ? 'manual' : 'auto'
  const rawCriteria: TripCriteria =
    (TRIP_CRITERIA as readonly string[]).includes(String(p.fc_trip_criteria || ''))
      ? (p.fc_trip_criteria as TripCriteria)
      : 'cards_or_commit'
  const manualIds = asList(p.fc_trip_projects)
  // 「手动指定」但**从没勾过任何项目**（键都不存在）→ 那不是"选了空清单"，是"没做过选择"。
  // 照字面执行的话一屏会空得像界面坏了（2026-10-05 用户实测：「一屏是空的」+ 15 个全在
  // 「另有 N 个」里，连方寸自己都被说成"没有未完结任务"）。这里兜底回自动，并让人知道。
  const neverPicked = p.fc_trip_projects === undefined
  const fallback = neverPicked && (rawMode === 'manual' || rawCriteria === 'manual')
  const mode: 'auto' | 'manual' = fallback ? 'auto' : rawMode
  const criteria: TripCriteria = fallback && rawCriteria === 'manual' ? 'cards_or_commit' : rawCriteria
  const overrides: Record<string, unknown> =
    p.fc_health_overrides && typeof p.fc_health_overrides === 'object' ? p.fc_health_overrides : {}

  const projects = parseRegistry(true).filter((x: any) => !x?._released)
  const tasks = loadAllTasksRaw('active')
  const allLogs = logs.listLogs({})
  const rows: TripRow[] = []
  const hidden: TripBoard['hidden'] = []

  for (const proj of projects as any[]) {
    const id = String(proj?.id || '')
    if (!id) continue
    const repo = String(proj?.repo || '')
    const name = String(proj?.name || id)

    const projTasks = tasks.filter((t: any) => matchProject(t?.fm?.project, id))
    const byStatus = (s: string) => projTasks.filter((t: any) => String(t?.fm?.status || '') === s)
    const doing = byStatus('进行中')
    const todo = byStatus('待办')
    const review = byStatus('待验收')
    const undone = doing.length + todo.length + review.length

    const myLogs = allLogs
      .filter((l: any) => String(l?.project || '') === id)
      .sort((a: any, b: any) => String(b?.created || '').localeCompare(String(a?.created || '')))
    const latestLog = myLogs[0]

    const lastIso = gitLastCommitAt(repo)
    const recent30 = withinDays(lastIso, 30)
    const recent7 = withinDays(lastIso, 7)

    // 判据命中（机器口径 —— 只是默认值，用户可切 manual）
    // ⚠ 手动优先于判据：mode=manual 或 判据选了 manual 时，**只认用户勾的清单** ——
    //   否则"我明明手动选了，它还按判据加人"（首次实现踩过：manual 没优先，测试当场抓到）。
    const manualMode = mode === 'manual' || criteria === 'manual'
    const hit = manualMode
      ? manualIds.includes(id)
      : criteria === 'cards'
        ? undone > 0
        : criteria === 'cards_or_log'
          ? (undone > 0 || myLogs.length > 0)
          : (undone > 0 || recent30)
    if (!hit) {
      hidden.push({
        id,
        name,
        kind: manualMode ? 'not-picked' : 'no-activity',
        // 手动模式下**不许**再说"没有未完结任务"—— 那是另一回事（2026-10-05：方寸自己有
        // 几十张未完结卡，却因为没被勾选而被说成"没有未完结任务"，界面在说假话）。
        reason: manualMode
          ? '你选的是「手动指定」，但没勾它'
          : (undone > 0 ? '' : (myLogs.length ? '没有未完结任务，30 天内也没有提交' : '没有任务卡、没有执行日志，30 天内也没有提交')),
      })
      continue
    }

    // ── 当前步骤：进行中的卡 → 没有就回落到最近一条日志（司天这类 0 卡项目靠它）
    let current: TripCell = { text: '', from: '', sub: '' }
    if (doing.length) {
      const t: any = doing[0]
      current = { text: String(t?.fm?.title || t?.id || ''), from: 'task', sub: '' }
    } else if (latestLog) {
      current = { text: String(latestLog.title || latestLog.id || ''), from: 'log', sub: relTime(String(latestLog.created || '')) }
    }

    // ── 下一步：待办里优先级最高那张
    let next: TripCell = { text: '', from: '', sub: '' }
    if (todo.length) {
      const sorted = [...todo].sort((a: any, b: any) => prioWeight(a?.fm?.priority) - prioWeight(b?.fm?.priority))
      const t: any = sorted[0]
      next = {
        text: String(t?.fm?.title || t?.id || ''),
        from: 'task',
        sub: `${todo.length} 张待办（最高：${String(t?.fm?.priority || '未设')}）`,
      }
    }

    // ── 卡在谁：进行中卡的指派人 / 待验收卡的验收人
    let who: TripRow['who'] = { text: '', kind: 'none' }
    if (review.length) {
      const r: any = review[0]
      who = { text: `${String(r?.fm?.review || '') || '待指定'}（验收）`, kind: 'review' }
    } else if (doing.length) {
      const d: any = doing[0]
      who = { text: `${String(d?.fm?.assignee || '') || '未指派'}（执行）`, kind: 'exec' }
    } else if (todo.length) {
      who = { text: '未指派', kind: 'none' }
    }

    // ── 健康度：用户覆盖优先（🔒），否则机器默认
    const lockedRaw = String(overrides[id] ?? '')
    const locked = (TRIP_HEALTH as readonly string[]).includes(lockedRaw)
    let hv: TripHealth
    if (locked) {
      hv = lockedRaw as TripHealth
    } else if (doing.length > 0 || recent7) {
      hv = 'active'
    } else if (recent30) {
      hv = 'stuck'
    } else if (projTasks.length > 0) {
      hv = 'dormant'
    } else {
      hv = 'idle'
    }

    rows.push({
      id,
      name,
      repo,
      contract: readContractFile(repo),
      current,
      next,
      who,
      health: { value: hv, locked },
      counts: { todo: todo.length, doing: doing.length, review: review.length, logs: myLogs.length },
      lastCommit: relTime(lastIso),
      recentCommit: recent30,
      flags: { noCards: projTasks.length === 0, noLogs: myLogs.length === 0 },
    })
  }

  // 排在前面的：有进行中的 → 有待验收的 → 有待办的 → 其余
  rows.sort((a, b) => {
    const rank = (r: TripRow) => (r.counts.doing ? 0 : r.counts.review ? 1 : r.counts.todo ? 2 : 3)
    const d = rank(a) - rank(b)
    return d !== 0 ? d : a.name.localeCompare(b.name)
  })

  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    generatedAt: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    mode,
    criteria,
    rows,
    hidden,
    modeFallback: fallback,
  }
}
