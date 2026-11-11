/**
 * 题库（2026-11-09）—— 「同一道题不许问第二次」的那本账
 *
 * 暮雨拍板（D-060）：**题库落点 = 独立 `task-data/question-bank.md`**；
 * 已答 / 否决 / 你自判 永不复问；作废可重问（需求变过）。
 *
 * 为什么必须独立成文件、不能只靠 `<卷>.answers.json`：
 * 卷是可以删的（11-08 四卷就是这么删的）。答案跟着卷走 = 卷删了黑名单也没了，
 * 同一个问题可以换个卷名再问一遍 —— 那正是问卷变成“新填表负担”的起点。
 *
 * 指纹 = 题干归一化后的 sha1 前 8 位（去空白/标点/题号前缀、统一大小写）。
 * 不做语义相似度：宁可漏合并，也不要把两道真不同的题合成一道。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { getTaskDir, atomicWrite } from './index'
import { localDay } from '../../shared/time'

export type BankStatus = '待答' | '已答' | '否决' | '作废' | '你自判'

export interface BankEntry {
  id: string
  ask: string
  project: string
  firstAsked: string
  status: BankStatus
  answer: string
  source: string
  /**
   * 验收线（2026-11-10 补）。
   *
   * 为什么题库要自己存一份：验收线此前只活在问卷 md 里，靠 `effectiveAcceptances`
   * 从“仍存在的卷”派生 —— **卷删了/归档了，线就悄悄没了**，而题库还写着“已答”。
   * 那正是 D-060 要防的同一类事（答案跟着卷走 = 卷删了记录也没了）。
   */
  line: string
  fingerprint: string
}

const HEADER = [
  '# 问题台账（题库）',
  '',
  '> 每条一题。状态：待答 / 已答 / 否决 / 作废 / 你自判。',
  '> 已答 / 否决 / 你自判 = **永不复问**；作废 = 可重问（需求变过）。',
  '> 指纹按题干归一化算（去空白/标点/题号、统一大小写），不做语义相似度。',
  '',
].join('\n')

function bankPath(): string {
  return path.join(getTaskDir(), 'question-bank.md')
}

/** 题干归一化：去掉题号前缀、标点、空白，统一小写 */
export function normalizeAsk(raw: string): string {
  return String(raw || '')
    .replace(/^\s*(?:##\s*)?[A-Za-z]+\d+\s*/g, '')   // 题号前缀
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：,.!?;:“”‘’"'（）()【】\[\]《》<>—…·]/g, '')
    .toLowerCase()
}

export function fingerprintOf(raw: string): string {
  return crypto.createHash('sha1').update(normalizeAsk(raw)).digest('hex').slice(0, 8)
}

function stripKv(line: string): { k: string; v: string } | null {
  const m = /^-\s*(问题|项目|首问|状态|答案|出处|验收线|指纹)\s*[:：]\s*(.*)$/.exec(line)
  return m ? { k: m[1], v: m[2].trim() } : null
}

/** 最近一次 loadBank 的读取错误（空 = 没出错；“文件不存在”不算错） */
let _bankError = ''
export function bankLoadError(): string { return _bankError }

export function loadBank(): BankEntry[] {
  _bankError = ''
  const p = bankPath()
  if (!fs.existsSync(p)) return []
  let text = ''
  // 2026-11-11（评审抓到）：读失败此前 `catch { return [] }` —— 与“题库是空的”长得一模一样，
  // 于是进队列闸在题库坏掉时**静默放行**。现在把错误留在 `_bankError` 里，由闸决定 fail-closed。
  try { text = fs.readFileSync(p, 'utf-8') } catch (e: any) { _bankError = String(e?.message || e); return [] }
  const out: BankEntry[] = []
  let cur: BankEntry | null = null
  const flush = () => {
    if (!cur) return
    if (!cur.ask) { cur = null; return }
    if (!cur.fingerprint) cur.fingerprint = fingerprintOf(cur.ask)
    if (!cur.id) cur.id = `Q-${String(out.length + 1).padStart(4, '0')}`
    out.push(cur)
    cur = null
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const h = /^##\s+(Q-\d+)\s*$/.exec(line)
    if (h) { flush(); cur = { id: h[1], ask: '', project: '', firstAsked: '', status: '待答', answer: '', source: '', line: '', fingerprint: '' }; continue }
    if (!cur) continue
    const kv = stripKv(line)
    if (!kv) continue
    if (kv.k === '问题') cur.ask = kv.v
    else if (kv.k === '项目') cur.project = kv.v
    else if (kv.k === '首问') cur.firstAsked = kv.v
    else if (kv.k === '状态') cur.status = (kv.v as BankStatus) || '待答'
    else if (kv.k === '答案') cur.answer = kv.v
    else if (kv.k === '出处') cur.source = kv.v
    else if (kv.k === '验收线') cur.line = kv.v
    else if (kv.k === '指纹') cur.fingerprint = kv.v
  }
  flush()
  return out
}

function renderBank(items: BankEntry[]): string {
  const L: string[] = [HEADER]
  for (const it of items) {
    L.push(`## ${it.id}`)
    L.push(`- 问题: ${it.ask}`)
    if (it.project) L.push(`- 项目: ${it.project}`)
    if (it.firstAsked) L.push(`- 首问: ${it.firstAsked}`)
    L.push(`- 状态: ${it.status || '待答'}`)
    if (it.answer) L.push(`- 答案: ${it.answer}`)
    if (it.source) L.push(`- 出处: ${it.source}`)
    if (it.line) L.push(`- 验收线: ${it.line}`)
    L.push(`- 指纹: ${it.fingerprint || fingerprintOf(it.ask)}`)
    L.push('')
  }
  return L.join('\n')
}

function nextId(items: BankEntry[]): string {
  let max = 0
  for (const it of items) {
    const m = /^Q-(\d+)$/.exec(it.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `Q-${String(max + 1).padStart(4, '0')}`
}

export interface UpsertInput {
  ask: string
  project?: string
  status: BankStatus
  answer?: string
  source?: string
  firstAsked?: string
  /** 验收线（问卷 md 里的【验收线】原文）；批准时一并落库，卷删了也还在 */
  line?: string
  /** 题库条目 id（如 Q-0010）：从题库提请的题会带 `【出处】题库 Q-0010`，批准时按它归并 */
  ref?: string
}

/** 幂等写入：按指纹合并；首问保留第一次，状态/答案/出处更新到最新 */
export function upsertEntries(inputs: UpsertInput[]): { added: number; updated: number; items: BankEntry[] } {
  const items = loadBank()
  const byFp = new Map(items.map((x) => [x.fingerprint, x]))
  const byId = new Map(items.map((x) => [x.id, x]))
  let added = 0
  let updated = 0
  for (const raw of inputs || []) {
    const ask = String(raw?.ask || '').trim()
    if (!ask) continue
    const fp = fingerprintOf(ask)
    // 从题库提请的题：问法会改（“判据是什么”变成“停止条件用哪一种”），
    // 指纹对不上，但 `【出处】题库 Q-0010` 指回同一条 —— 按 id 归并，别新长一条。
    const old = (raw.ref && byId.get(String(raw.ref).trim())) || byFp.get(fp)
    if (old) {
      old.status = raw.status
      if (raw.answer) old.answer = String(raw.answer)
      if (raw.source) old.source = String(raw.source)
      if (raw.line) old.line = String(raw.line)
      if (raw.project && !old.project) old.project = String(raw.project)
      updated++
    } else {
      const it: BankEntry = {
        id: nextId(items),
        ask,
        project: String(raw.project || '').trim(),
        firstAsked: String(raw.firstAsked || localDay()),
        status: raw.status,
        answer: String(raw.answer || ''),
        source: String(raw.source || ''),
        line: String(raw.line || ''),
        fingerprint: fp,
      }
      items.push(it)
      byFp.set(fp, it)
      added++
    }
  }
  if (added || updated) {
    fs.mkdirSync(path.dirname(bankPath()), { recursive: true })
    atomicWrite(bankPath(), renderBank(items))
  }
  return { added, updated, items }
}

/** 某个项目的题库（含全局：项目为空）；project 为空时只取全局 */
export function bankOf(project: string): BankEntry[] {
  const p = String(project || '').trim()
  return loadBank().filter((x) => !String(x.project || '').trim() || (!!p && String(x.project) === p))
}

/** 还没答的题（闸用）：待答 */
export function openBank(project: string): BankEntry[] {
  return bankOf(project).filter((x) => x.status === '待答')
}

/** 永不复问的状态 */
export function neverAskAgain(): Set<string> {
  return new Set(loadBank().filter((x) => x.status === '已答' || x.status === '否决' || x.status === '你自判')
    .map((x) => x.fingerprint))
}

/** 出卷前查重：已答 / 否决 / 你自判 的题不许再问；待答/作废 允许（待答是队列，作废可重问） */
export function collisionsFor(asks: { id?: string; ask?: string; nav?: string }[]): { id: string; ask: string; fp: string; entry: BankEntry }[] {
  const all = loadBank()
  const bad = new Set(all.filter((x) => x.status === '已答' || x.status === '否决' || x.status === '你自判')
    .map((x) => x.fingerprint))
  const byFp = new Map(all.map((x) => [x.fingerprint, x]))
  const out: { id: string; ask: string; fp: string; entry: BankEntry }[] = []
  for (const q of asks || []) {
    const text = String(q?.ask || q?.nav || '').trim()
    if (!text) continue
    const fp = fingerprintOf(text)
    if (!bad.has(fp)) continue
    const entry = byFp.get(fp)
    if (entry) out.push({ id: String(q?.id || ''), ask: text, fp, entry })
  }
  return out
}

// ── 规模支撑（2026-11-10）──────────────────────────────────────────────
// 暮雨 2026-11-10 原话：“我预想一个项目几十个甚至几百个题目呢（尤其是初创时，
// 几百个题目真不过分）。” 4 条题库靠肉眼翻得完，300 条不行 —— 下面三件是
// “几百条也能用”的最小支撑，不做：批量入队、进度口径、下一批取件。

export interface ImportInput {
  ask: string
  project?: string
  source?: string
  line?: string
}

export interface ImportResult {
  ok: boolean
  added: number
  /** 命中了旧的「待答 / 作废」条目：补出处/验收线，不新长一条 */
  merged: number
  /** 命中已答 / 否决 / 你自判：**拒绝并原样报回来**，绝不覆盖 */
  conflicts: { id: string; ask: string; status: BankStatus }[]
  items: BankEntry[]
}

/**
 * 批量入队（agent / 云端提炼好的题一次灌进来）。
 *
 * 与 `upsertEntries` 的分工：那个是**批准回写**（可以改任何状态），
 * 这个是**进货**（只能新增待答；碰到已定案的题就拒，不许把答案冲掉）。
 */
export function importQuestions(inputs: ImportInput[]): ImportResult {
  const items = loadBank()
  const byFp = new Map(items.map((x) => [x.fingerprint, x]))
  let added = 0
  let merged = 0
  const conflicts: { id: string; ask: string; status: BankStatus }[] = []
  for (const raw of inputs || []) {
    const ask = String(raw?.ask || '').trim()
    if (!ask) continue
    const fp = fingerprintOf(ask)
    const old = byFp.get(fp)
    if (old) {
      if (old.status === '已答' || old.status === '否决' || old.status === '你自判') {
        conflicts.push({ id: old.id, ask: old.ask, status: old.status })
        continue
      }
      if (raw.source) old.source = String(raw.source)
      if (raw.line) old.line = String(raw.line)
      if (raw.project && !old.project) old.project = String(raw.project)
      // 作废 = 当时答得对、之后需求变了 → 现在重新排队（D-060：作废可重问）
      if (old.status === '作废') old.status = '待答'
      merged++
      continue
    }
    const it: BankEntry = {
      id: nextId(items),
      ask,
      project: String(raw.project || '').trim(),
      firstAsked: localDay(),
      status: '待答',
      answer: '',
      source: String(raw.source || ''),
      line: String(raw.line || ''),
      fingerprint: fp,
    }
    items.push(it)
    byFp.set(fp, it)
    added++
  }
  if (added || merged) {
    fs.mkdirSync(path.dirname(bankPath()), { recursive: true })
    atomicWrite(bankPath(), renderBank(items))
  }
  return { ok: conflicts.length === 0, added, merged, conflicts, items }
}

export interface BankStats {
  project: string
  total: number
  answered: number
  open: number
  /** 否决 + 你自判 = 黑名单（永不复问） */
  blacklist: number
  voided: number
}

/** 进度口径（界面 / qn_list 都读它，别各算各的） */
export function bankStats(project: string): BankStats {
  const list = bankOf(project)
  const count = (s: BankStatus) => list.filter((x) => x.status === s).length
  const answered = count('已答')
  const open = count('待答')
  return {
    project: String(project || '').trim(),
    total: list.length,
    answered,
    open,
    blacklist: count('否决') + count('你自判'),
    voided: count('作废'),
  }
}

/**
 * 下一批（默认 ≤6 题）。
 *
 * 为什么钉 6：问卷行业实测题多完成率崩（方案 §六 风险清单同一条）。
 * 几百题不是“一口气答完”，是“每次 6 题、看得见进度”的队列。
 */
export function nextOpen(project: string, n = 6): BankEntry[] {
  const lim = Math.max(1, Math.min(20, Math.floor(Number(n) || 6)))
  return openBank(project).slice(0, lim)
}
