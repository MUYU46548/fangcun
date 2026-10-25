/**
 * Fangcun Desktop — Ideas Service（想法）
 *
 * 随手记一个念头，之后决定 **做 / 搁置 / 不做**。
 *
 * ── 为什么它必须是独立的一类，不能塞进现有三处（2026-10-22 暮雨问的原话）──
 *
 * · 待办（todos）：有优先级、有到期日、只有 `done` 一个布尔。念头一进去就被套上期限与
 *   优先级 —— 而"还没想好做不做"的东西本来就没有期限；它还会按天飘红"逾期"。
 * · 日志（docs/执行日志）：那是"某段时间做了什么"的记录（有起止、有 active/finished）。
 *   念头是"还没发生的事"，塞进去等于给日志掺假。
 * · 任务卡（task-data/*.md）：整套状态机（草稿/待审批/待办/进行中/待验收/完成/驳回）
 *   + 验收标准 + 阻塞 + 优先级。念头套上这套就是**过度承诺** —— 一张"想法卡"会被
 *   在途一屏算成"下一步"、被阻塞视图算成"卡住的任务"，产出的全是假信号。
 *
 * 所以这个实体刻意做得很轻：**只有 内容 / 记下的时间 / 一个四态**。
 * 不给优先级、不给截止日、不给验收标准、不归属项目 —— 一旦有了这些，它就又变成待办了。
 *
 * ── 四态 ──
 *   新记   = 还没决定（默认，记下来那一刻就是它）
 *   已立项 = 决定做 → 已在待办里生出一条，双向留痕（本卡 `promoted.id`）
 *   已搁置 = 先放着（不是否决，将来可能捡回来）
 *   已否决 = 想过了，不做（**留着有价值**："这条我想过"，别当垃圾清掉）
 *
 * ⚠ 已否决 ≠ 删除。删除只给"记错了 / 手滑"用，真删、且界面必须挂撤销条。
 *
 * ⚠ 落盘位置是 `<dataDir>/ideas/index.json`，**绝不能放 task-data/**：
 *   那个目录下所有 .md 都会被 `parseTask` 当成任务卡扫，扫失败会进 `parseErrors`
 *   顶栏红 chip —— 一条念头不该有能力污染任务台账。
 */

import * as fs from 'fs'
import * as path from 'path'
import { getDataDir, atomicWrite } from '../data'
import * as appLog from './appLog'
import * as todosService from './todos'

/** 四态的唯一来源。界面的筛选 / 分组都按这个数组走，不许自己再写一份 */
export const IDEA_STATUSES = ['新记', '已立项', '已搁置', '已否决'] as const
export type IdeaStatus = (typeof IDEA_STATUSES)[number]

/** 「已经有结论」的三态（用来把待定区和已决区分开） */
export const IDEA_DECIDED: readonly IdeaStatus[] = ['已立项', '已搁置', '已否决']

export interface Idea {
  id: string
  /** 念头本身（唯一必填）。允许换行 —— 一句半句话本来就可能断行 */
  text: string
  status: IdeaStatus
  /** 为什么搁置 / 为什么不做的备注（一句话，可空）。空 = 没写，不糊"暂无备注" */
  note: string
  createdAt: string
  updatedAt: string
  /** 做出决定的时间。新记 = 空串（没做过决定，不假填一个时间） */
  decidedAt: string
  /** 立项产出到哪了。只有「已立项」有值，用来回查是哪条待办 */
  promoted: { kind: 'todo'; id: string } | null
}

/**
 * 单条念头的长度上限。
 *
 * 2026-10-25（暮雨）：「MAX_TEXT = 4000 太小了，或者弄个用户可以自己设置的设置项
 *  ……但是设个硬上限 20000」。所以现在三件东西：
 *   · 默认 10000（比原来宽一倍多，贴一段长建议够用）
 *   · 设置页滑块可调（1000 ~ 20000，步长 1000），落 `prefs.json` 的 `fc_idea_max_chars`
 *   · **硬上限 20000** —— 用户能从界面上调到这个数，但代码不接受比它更大（prefs.json
 *     是可以手改的，手改出 999999 也得被夹回来，否则"硬上限"就是句空话）
 *
 * ⚠ 仍然是**超了直接报错，不静默截断**（截断 = 用户以为存住了，其实后半段没了）。
 */
export const IDEA_TEXT_MIN = 1000
export const IDEA_TEXT_DEFAULT = 10000
export const IDEA_TEXT_HARD_MAX = 20000

function clampIdeaLimit(n: number): number {
  if (!Number.isFinite(n)) return IDEA_TEXT_DEFAULT
  return Math.min(IDEA_TEXT_HARD_MAX, Math.max(IDEA_TEXT_MIN, Math.floor(n)))
}

/**
 * 当前生效的上限（每次调用现读 prefs，改了立刻生效，不用重启）。
 *
 * 读取失败一律回默认 —— 上限是"守门"，不是"阻塞用户记念头"的理由。
 */
export function ideaTextLimit(): number {
  let raw: unknown = undefined
  try {
    // 延迟 require：让本模块能脱离 electron 单测（prefs 依赖 app.getPath）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    raw = require('./prefs').getPref('fc_idea_max_chars')
  } catch {
    return IDEA_TEXT_DEFAULT
  }
  if (raw === undefined || raw === null || raw === '') return IDEA_TEXT_DEFAULT
  // ⚠ **不许直接 Number(raw)**（2026-10-25 测试当场抓到）：
  //   `Number([]) === 0` / `Number('') === 0` / `Number(true) === 1` —— 把「读不懂的值」
  //   静默变成 0 再夹到下限 1000，用户手改出个 `[]` 会得到「上限 1000」这种完全无关的结果。
  //   所以先按类型分类：数字直接用；字符串（手改常带引号）容错；其余一律回落默认。
  if (typeof raw === 'number') return Number.isFinite(raw) ? clampIdeaLimit(raw) : IDEA_TEXT_DEFAULT
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return IDEA_TEXT_DEFAULT
    const n = Number(s)
    return Number.isFinite(n) ? clampIdeaLimit(n) : IDEA_TEXT_DEFAULT
  }
  return IDEA_TEXT_DEFAULT
}

function getIdeasPath(): string {
  const dir = path.join(getDataDir(), 'ideas')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'index.json')
}

export function isIdeaStatus(v: unknown): v is IdeaStatus {
  return (IDEA_STATUSES as readonly string[]).includes(String(v))
}

/**
 * 归一一条记录。
 *
 * 状态非法时归「新记」而不是丢掉这条：**念头的正文比状态重要**，宁可退化成"还没决定"，
 * 也不能因为一个脏状态把用户写下的半句话吞掉（＝静默内容丢失）。
 */
function normalizeIdea(raw: any): Idea {
  const status = isIdeaStatus(raw?.status) ? (raw.status as IdeaStatus) : '新记'
  const promoted = raw?.promoted && raw.promoted.kind === 'todo' && raw.promoted.id
    ? { kind: 'todo' as const, id: String(raw.promoted.id) }
    : null
  return {
    id: String(raw?.id ?? ''),
    text: String(raw?.text ?? ''),
    status,
    note: String(raw?.note ?? ''),
    createdAt: String(raw?.createdAt ?? ''),
    updatedAt: String(raw?.updatedAt ?? ''),
    // 只有做过决定的三态才该有 decidedAt；新记即使文件里带值也不认（不给假时间）
    decidedAt: IDEA_DECIDED.includes(status) ? String(raw?.decidedAt ?? '') : '',
    promoted: status === '已立项' ? promoted : null,
  }
}

let lastLoadError: { at: string; file: string; quarantined: string; error: string } | null = null

/** 坏文件改名隔离（与 todos 同一套：绝不静默覆盖，用户数据丢了没法救） */
function quarantineCorrupt(file: string, error: string): void {
  let dest = `${file}.corrupt-${Date.now()}`
  try {
    fs.renameSync(file, dest)
  } catch (e: any) {
    dest = `${file}（改名失败：${e?.message || e}）`
  }
  lastLoadError = { at: new Date().toISOString(), file, quarantined: dest, error }
  appLog.error('ideas', `想法文件解析失败，已隔离原文件：${dest}`, error)
}

function loadIdeas(): Idea[] {
  const p = getIdeasPath()
  if (!fs.existsSync(p)) return []
  let text = ''
  try {
    text = fs.readFileSync(p, 'utf-8')
  } catch (e: any) {
    lastLoadError = { at: new Date().toISOString(), file: p, quarantined: '', error: `读取失败：${e?.message || e}` }
    return []
  }
  try {
    const raw = JSON.parse(text)
    if (!Array.isArray(raw)) throw new Error('顶层不是数组')
    return raw.map(normalizeIdea)
  } catch (e: any) {
    quarantineCorrupt(p, e?.message || String(e))
    return []
  }
}

function saveIdeas(list: Idea[]): void {
  atomicWrite(getIdeasPath(), JSON.stringify(list, null, 2))
}

/** 数据健康度（坏文件隔离留痕，界面用来显性化"数据出过事"） */
export function ideasHealth(): { ok: boolean; path: string; lastError: typeof lastLoadError } {
  loadIdeas()
  return { ok: lastLoadError === null, path: getIdeasPath(), lastError: lastLoadError }
}

/**
 * 列想法。
 *
 * 排序刻意是「**最新记的排最前**」：想法是一堆并列的念头，没有优先级也没有先后，
 * 按创建时间倒序就是唯一说得通的顺序。已决区同理 —— 最近决定的在最上面。
 */
export function listIdeas(filter?: { status?: IdeaStatus }): Idea[] {
  let list = loadIdeas().filter((i) => i.id && i.text)
  if (filter?.status) list = list.filter((i) => i.status === filter.status)
  return list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

/** 统计（分区标题上的数字用它，不在界面自己数） */
export function ideasSummary(): Record<IdeaStatus, number> {
  const out = { 新记: 0, 已立项: 0, 已搁置: 0, 已否决: 0 } as Record<IdeaStatus, number>
  for (const i of loadIdeas()) if (i.id && i.text) out[i.status] += 1
  return out
}

/**
 * 记一条。
 *
 * 重复保护：**完全相同的内容、且还停在「新记」** → 不重复落盘，返回 `duplicate: true`。
 * 为什么只管"还停在待定"这一种：已经立项/否决的再记一遍，可能是真想重开（或确实是另一件事），
 * 那属于用户的决定，不该被"你记过了"拦住。手滑连点两下才是最需要拦的场景。
 */
export function addIdea(
  text: string,
): { ok: true; idea: Idea; duplicate: boolean } | { ok: false; error: string } {
  const t = String(text ?? '').trim()
  if (!t) return { ok: false, error: '念头是空的 —— 写一句再存' }
  const MAX_TEXT = ideaTextLimit()
  if (t.length > MAX_TEXT) {
    return { ok: false, error: `太长了（${t.length} 字）—— 上限 ${MAX_TEXT} 字，可在「设置 → 通用 → 念头长度上限」调整（最大 ${IDEA_TEXT_HARD_MAX}）` }
  }
  const all = loadIdeas()
  const dup = all.find((i) => i.status === '新记' && i.text.trim() === t)
  if (dup) return { ok: true, idea: dup, duplicate: true }

  const now = new Date().toISOString()
  const idea: Idea = {
    id: `idea-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: t,
    status: '新记',
    note: '',
    createdAt: now,
    updatedAt: now,
    decidedAt: '',
    promoted: null,
  }
  all.push(idea)
  saveIdeas(all)
  return { ok: true, idea, duplicate: false }
}

/** 改内容（记下来才想起还要补半句 —— 念头本来就该能改） */
export function updateIdeaText(
  id: string,
  text: string,
): { ok: true; idea: Idea } | { ok: false; error: string } {
  const t = String(text ?? '').trim()
  if (!t) return { ok: false, error: '内容不能清空 —— 想删就删这条' }
  const maxNow = ideaTextLimit()
  if (t.length > maxNow) {
    return { ok: false, error: `太长了（${t.length} 字）—— 上限 ${maxNow} 字，可在设置页调大（最大 ${IDEA_TEXT_HARD_MAX}）` }
  }
  const all = loadIdeas()
  const idx = all.findIndex((i) => i.id === id)
  if (idx < 0) return { ok: false, error: '没有这条想法（可能已经删了）' }
  all[idx] = { ...all[idx], text: t, updatedAt: new Date().toISOString() }
  saveIdeas(all)
  return { ok: true, idea: all[idx] }
}

/**
 * 改状态（搁置 / 否决 / 撤回成待定）。
 *
 * ⚠ **「已立项」不能从这条路走进来** —— 立项必须真在待办里生出一条（`promoteIdea`）。
 *   允许直接把状态改成已立项，就会产出一批"说是立项了、待办里根本没有"的假账。
 */
export function setIdeaStatus(
  id: string,
  status: IdeaStatus,
  note?: string,
): { ok: true; idea: Idea; before: { status: IdeaStatus; note: string } } | { ok: false; error: string } {
  if (!isIdeaStatus(status)) return { ok: false, error: `没有「${status}」这个状态` }
  if (status === '已立项') return { ok: false, error: '「立项」要走「做」那个动作 —— 它会真在待办里生出一条；直接改状态会留下假账' }

  const all = loadIdeas()
  const idx = all.findIndex((i) => i.id === id)
  if (idx < 0) return { ok: false, error: '没有这条想法（可能已经删了）' }
  const cur = all[idx]
  if (cur.status === '已立项') {
    return { ok: false, error: '这条已经立项了（待办里有对应的一条）—— 要撤回先点待办那边的「由想法转来」撤销' }
  }
  const before = { status: cur.status, note: cur.note }
  const now = new Date().toISOString()
  all[idx] = {
    ...cur,
    status,
    note: note === undefined ? cur.note : String(note).trim(),
    decidedAt: status === '新记' ? '' : (cur.decidedAt || now),
    updatedAt: now,
  }
  saveIdeas(all)
  return { ok: true, idea: all[idx], before }
}

/**
 * 立项 = 决定做 → **真在待办里生出一条**，然后把这念头标成已立项并记住那条待办的 id。
 *
 * 顺序刻意是「先建待办，成功后才改想法状态」：反过来的话，待办创建失败会留下一条
 * "说立项了但待办里没有"的假账。两边都失败时用户只会看到"没成"，而不是看到成功。
 *
 * 为什么落到**待办**而不是任务卡：待办是"要做的事"里最轻的一档，不需要项目、不需要验收线。
 * 念头刚拍板时往往还不知道归哪个项目、怎么算做完 —— 硬要求选项目就是逼用户当场编。
 * 等它长到需要验收了，再从待办升级（那是另一件事，不在这里替用户决定）。
 */
export function promoteIdea(
  id: string,
  opts?: { priority?: string },
): { ok: true; idea: Idea; todoId: string } | { ok: false; error: string } {
  const all = loadIdeas()
  const idx = all.findIndex((i) => i.id === id)
  if (idx < 0) return { ok: false, error: '没有这条想法（可能已经删了）' }
  const cur = all[idx]
  if (cur.status === '已立项') return { ok: false, error: '已经立项过了（待办里有对应的一条）' }
  if (!cur.text.trim()) return { ok: false, error: '内容是空的，没法立项' }

  let todo: any
  try {
    // ⚠ 2026-10-25（暮雨第 3 条）：「标题取念头第一行，多行正文塞进去会把列表撑歪」——
    //   这条注释本身就是错的。待办的「内容」字段一直是**可以写长的 textarea**
    //   （`App.vue` 的 `todoEdit_.title`，placeholder 原话「待办内容（可以写长一点）」），
    //   列表里靠 `.todo-title { white-space: nowrap; text-overflow: ellipsis }` 压成一行显示。
    //   所以「日志 → 待办」那条路（`logToTodoText`）早就把全文塞进 title 了，只有这里砍成首行
    //   —— 结果是念头的正文**立项即永久丢失**（用户原话：「转进来只剩日志里的标题，甚至
    //   不是正文，还被截断了」）。现在与 `logToTodoText` 同范式：**全文进 title，一位不丢**。
    const title = cur.text.trim()
    todo = todosService.createTodo(title, opts?.priority || '中')
  } catch (e: any) {
    return { ok: false, error: `待办没建成：${e?.message || e}` }
  }

  const now = new Date().toISOString()
  all[idx] = {
    ...cur,
    status: '已立项',
    decidedAt: cur.decidedAt || now,
    updatedAt: now,
    promoted: { kind: 'todo', id: String(todo?.id || '') },
  }
  saveIdeas(all)
  return { ok: true, idea: all[idx], todoId: String(todo?.id || '') }
}

/**
 * 撤销立项：删掉那条待办，想法退回到「新记」。
 *
 * 为什么允许真删待办：这条待办是本功能刚生成的、且用户点的是"撤销"，删了就是恢复原状。
 * 如果那条待办已经被用户改过 / 已经做完 —— 那是用户的东西了，不动，明说让人自己去处理。
 */
export function unpromoteIdea(
  id: string,
): { ok: true; idea: Idea } | { ok: false; error: string } {
  const all = loadIdeas()
  const idx = all.findIndex((i) => i.id === id)
  if (idx < 0) return { ok: false, error: '没有这条想法（可能已经删了）' }
  const cur = all[idx]
  if (cur.status !== '已立项' || !cur.promoted) return { ok: false, error: '这条还没立项，没得撤' }

  const todoId = cur.promoted.id
  const todo = todoId ? todosService.listTodos().find((t) => t.id === todoId) : undefined
  if (todo && todo.done) {
    return { ok: false, error: '那条待办你已经做完了 —— 撤不了立项。要清掉它请去待办页删' }
  }
  if (todo) todosService.deleteTodo(todoId)

  const now = new Date().toISOString()
  all[idx] = {
    ...cur,
    status: '新记',
    decidedAt: '',
    updatedAt: now,
    promoted: null,
  }
  saveIdeas(all)
  return { ok: true, idea: all[idx] }
}

/** 真删（只给"记错了 / 手滑"用）。返回被删的那条，供界面挂撤销 */
export function deleteIdea(
  id: string,
): { ok: true; removed: Idea } | { ok: false; error: string } {
  const all = loadIdeas()
  const idx = all.findIndex((i) => i.id === id)
  if (idx < 0) return { ok: false, error: '没有这条想法（可能已经删了）' }
  const removed = all[idx]
  all.splice(idx, 1)
  saveIdeas(all)
  return { ok: true, removed }
}

/**
 * 把删掉的整条原样插回去（撤销条用）。
 * 保留原 id 与 createdAt —— 撤销的语义是"当没删过"，不是"重新记一条"。
 */
export function restoreIdea(
  idea: Idea,
): { ok: true; idea: Idea } | { ok: false; error: string } {
  if (!idea || !idea.id) return { ok: false, error: '没有可恢复的内容' }
  const all = loadIdeas()
  if (all.some((i) => i.id === idea.id)) return { ok: false, error: '这条已经回来了（重复恢复）' }
  const back = normalizeIdea(idea)
  all.push(back)
  saveIdeas(all)
  return { ok: true, idea: back }
}
