/**
 * 草案「就地改三块」的唯一口径（2026-11-12 · 0.7.0 规划根基第二轮）
 *
 * 为什么要有这一层：草案入口第一版只能**整格原样提成** —— 用户看到某格判据写歪了、
 * 或技术方案少一条，唯一的路是回去让 agent 重写整份草案。而“人裁决”这个动作本身就
 * 该包含“我改一下再收”。所以第二轮要做的是：**提成时就地改**，改完仍过同一条闸。
 *
 * 三条硬纪律（改了哪条都要先改这里，不要在界面或主进程各写一份）：
 *   ① **草案文件仍然只读**：改的是“这次提成要落地的内容”，`_drafts/*.md` 一个字节不写。
 *      文件名、阶段号、标题都不可改 —— 它们决定“提的是哪一格”，可改会造出无源卡。
 *   ② **缺什么由这里算**：以前 `readDraft` 自己算一遍、界面再猜一遍，必然对不上
 *      （与 `shared/clarify.ts` 同一条教训）。主进程与渲染层共用本文件。
 *   ③ **不许静默吞**：超限、判据没前缀、表格缺列 —— 逐条报出来，不截断不糊过去。
 *
 * 纯函数：不 import fs / electron / node 内置。主进程与渲染层都能直接用，也能被 Node 直接断言。
 */

/** 判据前缀白名单 —— 没有前缀的判据在闸门里恒为 unknown（等于永远不给过） */
export const CRITERIA_PREFIX = /^(cmd|str|num|file)\s*[:：]/

/** 体积上限：挡住“把整篇文档贴进来”，同时给足正常写作空间 */
export const LIMITS = {
  approach: 40,
  criteria: 60,
  copyRows: 60,
  line: 1000,
  cell: 400,
}

/** 三块的真身（可编辑的部分只有这三块 + 每行内容） */
export interface EditableStage {
  id: string
  title: string
  what: string
  approach: string[]
  copyRows: string[][]
  criteria: string[]
}

/** 界面提交的改动：只给改过的块；没给的块 = 原样 */
export interface StagePatch {
  approach?: string[]
  copyRows?: string[][]
  criteria?: string[]
}

export const isSepRow = (cells: string[]): boolean =>
  cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(String(c || '').replace(/\s/g, '')))

const nonSep = (rows: string[][]): string[][] => (rows || []).filter((r) => !isSepRow(r))

/**
 * 这一格缺什么（空数组 = 三块齐全，可以提成）。
 *
 * ⚠ 口径与 `plans.parseStage` / `proposeStage` 对齐，别各说各的：
 *   · 技术方案：至少 1 条；
 *   · 照抄点：表头 + 至少 1 行数据（分隔线不算数据行）；
 *   · 判据：至少 1 条，且每条都必须带 cmd:/str:/num:/file: 前缀。
 */
export function missingOf(s: { approach?: string[]; copyRows?: string[][]; criteria?: string[] }): string[] {
  const out: string[] = []
  const approach = (s.approach || []).filter((x) => String(x || '').trim())
  const criteria = (s.criteria || []).filter((x) => String(x || '').trim())
  const dataRows = nonSep(s.copyRows || [])
  if (!approach.length) out.push('技术方案')
  if (dataRows.length < 2) out.push('照抄点')
  if (!criteria.length) out.push('判据')
  const bad = criteria.find((c) => !CRITERIA_PREFIX.test(String(c).trim()))
  if (bad) out.push(`判据没前缀：${String(bad).trim().slice(0, 24)}`)
  return out
}

/** 单行清洗：折行压成空格（否则一行正文能把块结构顶开，多写出一张卡） */
function oneLine(raw: unknown): string {
  return String(raw == null ? '' : raw)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, LIMITS.line)
}

/**
 * 多行文本 → 列表项。
 * 顺手剥掉行首的 `- ` / `* ` / `1. `：用户从别处粘一段 markdown 列表进来是常态，
 * 粘完变成 `- - 做法` 才是真坑。
 */
export function linesToList(text: unknown): string[] {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .map((l) => l.slice(0, LIMITS.line))
}

export const listToLines = (list: unknown): string =>
  (Array.isArray(list) ? list : []).map((x) => String(x == null ? '' : x)).join('\n')

/** 表格文本 → 行（只认 `|` 开头的行；空行与非表格行忽略） */
export function parseCopyTable(text: unknown): string[][] {
  const rows: string[][] = []
  for (const raw of String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')) {
    const t = raw.trim()
    if (!t.startsWith('|')) continue
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim().slice(0, LIMITS.cell))
    if (cells.some((c) => c)) rows.push(cells)
  }
  return rows
}

export const tableToText = (rows: unknown): string =>
  (Array.isArray(rows) ? rows : [])
    .filter((r) => Array.isArray(r))
    .map((r: string[]) => `| ${r.map((c) => String(c == null ? '' : c)).join(' | ')} |`)
    .join('\n')

/**
 * 补齐表格骨架：表头 + 分隔线 + 数据行。
 * 用户手填时常常只写“表头 + 几行字”，缺了 `|---|` 那一行；这里补上（与 `proposeStage` 的兜底同义）。
 *
 * 「第一行算不算表头」的判法（2026-11-12 实测修正，第一版在这里错了）：
 *   · **两行及以上** → 第一行就是表头（这是 Markdown 表格的默认读法）。第一版还去比对
 *     表头文字是不是「项/来源/原文」，于是“表头甲 | 表头乙”这种用户自拟表头被当成数据行，
 *     前面又插了一整套「项/来源/原文」—— 落地后一张表两个表头。
 *   · **只有一行** → 看不出来：像常见表头（项/来源/原文/抄哪块…）就只补分隔线，
 *     否则按数据算、连标准表头一起补（单行当表头会被判成“缺照抄点”，那才是更难懂的结果）。
 */
export function normalizeCopyRows(rows: unknown): string[][] {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => Array.isArray(r) && r.some((c) => String(c || '').trim()))
  if (!list.length) return []
  const out = list.map((r: string[]) => r.map((c) => String(c == null ? '' : c).trim().slice(0, LIMITS.cell)))
  const HEADERISH = /^(项|来源|原文|位置|参照|抄哪块|落到哪|不抄什么|怎么算抄到位)$/
  if (out.length >= 2 && isSepRow(out[1])) return out.slice(0, LIMITS.copyRows)   // 已经是完整表格
  if (out.length === 1) {
    // 只有一行：看不出来是表头还是数据。像常见表头 → 当表头补分隔线；否则当数据补整套骨架
    if (!HEADERISH.test(out[0][0] || '')) out.unshift(['项', '来源', '原文'])
    out.splice(1, 0, out[0].map(() => '---'))
    return out.slice(0, LIMITS.copyRows)
  }
  // 两行及以上：第一行就是表头，只补分隔线（**不再插标准表头** —— 那会造出“一张表两个表头”）
  out.splice(1, 0, out[0].map(() => '---'))
  return out.slice(0, LIMITS.copyRows)
}

/** 三块的体检：超限 / 空行 / 表格列数对不上 —— 逐条报，不截断不糊 */
export function validateStage(s: { approach?: string[]; copyRows?: string[][]; criteria?: string[] }): string[] {
  const errs: string[] = []
  const approach = s.approach || []
  const criteria = s.criteria || []
  const rows = s.copyRows || []
  if (approach.length > LIMITS.approach) errs.push(`技术方案 ${approach.length} 条，超过上限 ${LIMITS.approach}`)
  if (criteria.length > LIMITS.criteria) errs.push(`判据 ${criteria.length} 条，超过上限 ${LIMITS.criteria}`)
  if (rows.length > LIMITS.copyRows) errs.push(`照抄点 ${rows.length} 行，超过上限 ${LIMITS.copyRows}`)
  const longA = approach.find((x) => String(x).length > LIMITS.line)
  if (longA) errs.push(`技术方案有一行 ${String(longA).length} 字，超过上限 ${LIMITS.line}`)
  const longC = criteria.find((x) => String(x).length > LIMITS.line)
  if (longC) errs.push(`判据有一行 ${String(longC).length} 字，超过上限 ${LIMITS.line}`)
  // 表格列数：数据行与表头列数必须一致（不一致写进计划卡就是错位的表）
  if (rows.length >= 2) {
    const w = rows[0].length
    const off = rows.slice(2).findIndex((r) => r.length !== w)
    if (off >= 0) errs.push(`照抄点第 ${off + 1} 条数据是 ${rows.slice(2)[off].length} 列，表头是 ${w} 列`)
  }
  return errs
}

/** 改动摘要（写进「提议人」那一行，让计划卡里看得见“这格是提成时改过的”） */
export interface EditSummary {
  changed: { approach: boolean; copyRows: boolean; criteria: boolean }
  count: number
  /** `技术方案 / 判据`（空串 = 一处没改） */
  note: string
}

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])
const sameRows = (a: string[][], b: string[][]): boolean =>
  a.length === b.length && a.every((r, i) => sameList(r, b[i] || []))

export function diffStage(base: { approach?: string[]; copyRows?: string[][]; criteria?: string[] }, now: { approach?: string[]; copyRows?: string[][]; criteria?: string[] }): EditSummary {
  const changed = {
    approach: !sameList(base.approach || [], now.approach || []),
    copyRows: !sameRows(base.copyRows || [], now.copyRows || []),
    criteria: !sameList(base.criteria || [], now.criteria || []),
  }
  const names: string[] = []
  if (changed.approach) names.push('技术方案')
  if (changed.copyRows) names.push('照抄点')
  if (changed.criteria) names.push('判据')
  return { changed, count: names.length, note: names.join(' / ') }
}

/**
 * 把界面提交的改动合到草案原块上。**只有三块可改**，id / title / what 一律以草案为准
 * （否则“提的是哪一格”就说不清了，也会造出没有来源的卡）。
 */
export function applyPatch<T extends { approach?: string[]; copyRows?: string[][]; criteria?: string[] }>(base: T, patch?: StagePatch | null): T {
  if (!patch) return base
  const out: T = { ...base }
  if (Array.isArray(patch.approach)) out.approach = patch.approach.map(oneLine).filter(Boolean)
  if (Array.isArray(patch.criteria)) out.criteria = patch.criteria.map(oneLine).filter(Boolean)
  if (Array.isArray(patch.copyRows)) out.copyRows = normalizeCopyRows(patch.copyRows)
  return out
}

/** 一句话回执：提成时到底改了哪几块（界面与日志共用同一句，不各写各的） */
export function editNote(sum: EditSummary): string {
  return sum.count ? `提成时改过：${sum.note}` : ''
}
