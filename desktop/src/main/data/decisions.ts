/**
 * Fangcun Desktop — Decision Cards (决策卡)
 * AI 规划包第 3 件（2026-10-12）。与 Python CLI（tegula/core.py 决策卡区）双腿同文件：
 * task-data/decisions.md，节式格式——两端读写同一文件，逐字节兼容（含多行备注的续行规则）。
 * 有意不挂任务状态机：决策不流转，只有 有效/已撤销/已合并 三态。
 *
 * 2026-10-14（暮雨：“'拍板''作数''已并入'很难看，让我们说中文”）：三态改白话中文。
 *   旧值（作数/已作废/已并入）**读取时归一**（见 LEGACY_STATUS_ALIASES），
 *   新写入一律用新值 —— 老文件不用改也能正常显示，任一次写回即自愈。
 */

import * as fs from 'fs'
import * as path from 'path'
import { atomicWrite, getTaskDir, logActivity } from './index'

export type DecisionStatus = '待审批' | '有效' | '已撤销' | '已合并'

/**
 * 决策卡四态（2026-11-24 加第一个「待审批」· 2026-11-23 问卷 K1 拍板）。
 *
 * K1 原话：「审批就不该走任务卡，不要什么都混进任务卡里面。**决策应该有自己的审批入口。**」
 *
 * 「待审批」这一档存在的唯一理由：让 agent 能**提议**决策而不可能让它生效。
 * 决策的 MCP 写口 `decision_record` 是 2026-11-03 明确移除的，当时留的话是
 * 「要开口必须先有『AI 只能落待审批』的设计」—— 现在那个设计就是这个状态。
 *
 * 三条硬规矩：
 *   ① agent 提的决策**一律**落「待审批」（`AGENT_WRITABLE_DECISION_STATUSES`），
 *      它传「有效」也不认 —— 转正是用户点的；
 *   ② 待审批的决策**不算数**：不进 agent 开工读到的"最近有效决策"清单，
 *      也不进决策证据链（读不到未批准的规矩，比读到假规矩安全）；
 *   ③ 用户驳回 → 「已撤销」（留痕，不删文件）。
 */
export const DECISION_STATUSES: DecisionStatus[] = ['待审批', '有效', '已撤销', '已合并']

/** 刚被 agent 提议时的那一档 —— 唯一允许 agent 直接写的值 */
export const DECISION_PENDING: DecisionStatus = '待审批'

/**
 * agent 写决策时**唯一**被接受的状态。
 * 不在这里的一律拒：不是"改成待审批"，而是**明确报错** ——
 * 模型以为写了个有效决策、实际落了待审批，会比拒掉更坑它。
 */
export const AGENT_WRITABLE_DECISION_STATUSES: readonly string[] = [DECISION_PENDING]

/** 老值 → 新值。**只读兼容**，不写回；与 Python core._normalize_decision_status 逐字一致。 */
export const LEGACY_STATUS_ALIASES: Record<string, DecisionStatus> = {
  作数: '有效',
  已作废: '已撤销',
  已并入: '已合并',
}

/** 归一三态：新值原样、老值翻译、空值给默认、其它非法值原样（交给上层校验报错）。 */
export function normalizeDecisionStatus(raw: string | undefined | null): DecisionStatus {
  const s = String(raw ?? '').trim()
  if (!s) return '有效'
  if ((DECISION_STATUSES as string[]).includes(s)) return s as DecisionStatus
  return LEGACY_STATUS_ALIASES[s] || (s as DecisionStatus)
}

export interface Decision {
  id: string
  内容: string
  日期: string
  状态: DecisionStatus
  项目: string
  出处: string
  备注: string
  更新: string
  /** 这条决策管到哪儿（`本卷` / `全局` / 空）。**老卡没有就是空串**，不补默认值。 */
  生效范围: string
  /** 落到哪了：`task-xxx` / `commit:xxx` / `不做(理由)`。空 = 还没对过账，不是"已落地"。 */
  落地: string
}

const DEF_HEADER = '# 决策记录（决策卡）\n\n> 定下来的事都在这——谁定的、哪天定的、还作不作数。状态：有效 / 已撤销 / 已合并。\n'

/**
 * 内容标题末尾的 `生效范围：X`（2026-11-23）。
 *
 * 问卷落卡一直把范围拼进**内容标题**（真实台账 155 条里 102 条是这么写的：
 * `## D-164 Q1：B. 照旧做… 生效范围：本卷`），于是"这条决策管到哪儿"长在正文里 ——
 * 比对、去重、喂 agent 都得各自再剥一遍（`shared/convergence.ts` 里就有一条专门剥它的正则）。
 *
 * ⚠ 与 Python `_split_scope_from_title`（tegula/core.py）**逐字同口径**。
 * ⚠ 只在**末尾**认：正文中间出现"生效范围"是句子的一部分，摘错了决策内容就残缺。
 */
const RE_SCOPE_TAIL = /\s*生效范围\s*[:：]\s*(.+?)\s*$/

export function splitScopeFromTitle(title: string): { 内容: string; 生效范围: string } {
  const t = String(title || '').trim()
  const m = RE_SCOPE_TAIL.exec(t)
  if (!m) return { 内容: t, 生效范围: '' }
  const head = t.slice(0, m.index).trim()
  // 摘完空了就整句留原样（宁可范围漏摘，不许内容变空）
  if (!head) return { 内容: t, 生效范围: '' }
  return { 内容: head, 生效范围: m[1].trim() }
}

function decisionsPath(): string {
  return path.join(getTaskDir(), 'decisions.md')
}

/** 解析节式文件；与 Python load_decisions 同规则（kv 行 + 无前缀续行拼回上一字段）。坏行宽容跳过。 */
export function loadDecisions(): Decision[] {
  const p = decisionsPath()
  if (!fs.existsSync(p)) return []
  let text: string
  try {
    text = fs.readFileSync(p, 'utf-8')
  } catch {
    return []
  }
  const items: Decision[] = []
  let cur: Decision | null = null
  let lastKv: string | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const m = /^##\s+(D-\d+)\s+(.*)$/.exec(line)
    if (m) {
      if (cur) items.push(cur)
      const split = splitScopeFromTitle(m[2].trim())
      cur = {
        id: m[1], 内容: split.内容, 日期: '',
        状态: '有效', 项目: '', 出处: '', 备注: '', 更新: '',
        生效范围: split.生效范围, 落地: '',
      }
      lastKv = null
      continue
    }
    if (!cur) continue
    // ⚠ 认的键必须与 Python 侧逐字一致（含 生效范围 / 落地）。
    //   少认一个 → 那一行会被当成"续行"拼回上一字段，下次写盘就把数据写坏。
    const kv = /^-\s+(日期|状态|项目|出处|备注|更新|生效范围|落地)\s*[:：]\s*(.*)$/.exec(line)
    if (kv) {
      // 状态列过一层归一：老值（作数/已作废/已并入）当场翻成新值，坏值原样留给上层
      ;(cur as any)[kv[1]] = kv[1] === '状态' ? normalizeDecisionStatus(kv[2]) : kv[2].trim()
      lastKv = kv[1]
      continue
    }
    if (line && lastKv) {
      ;(cur as any)[lastKv] = (((cur as any)[lastKv] || '') + '\n' + line).trim()
    }
  }
  if (cur) items.push(cur)
  return items
}

function renderDecisions(items: Decision[]): string {
  const lines: string[] = [DEF_HEADER]
  for (const it of items) {
    lines.push(`## ${it.id} ${it.内容 || ''}`)
    lines.push(`- 日期: ${it.日期 || ''}`)
    lines.push(`- 状态: ${it.状态 || '有效'}`)
    if (it.项目) lines.push(`- 项目: ${it.项目}`)
    // 生效范围：老卡没有就不写行（不凭空造 `本卷` —— 那是替用户改口径）
    if (it.生效范围) lines.push(`- 生效范围: ${it.生效范围}`)
    // 落地：空 = 还没对过账，不写行（写了空行会被读成"核过了，没落地"）
    if (it.落地) lines.push(`- 落地: ${it.落地}`)
    lines.push(`- 出处: ${it.出处 || ''}`)
    if (it.备注) lines.push(`- 备注: ${it.备注}`)
    if (it.更新) lines.push(`- 更新: ${it.更新}`)
    lines.push('')
  }
  return lines.join('\n') + '\n'
}

function saveDecisions(items: Decision[]): void {
  fs.mkdirSync(getTaskDir(), { recursive: true })
  atomicWrite(decisionsPath(), renderDecisions(items))
}

function nextId(items: Decision[]): string {
  let n = 0
  for (const it of items) {
    const m = /^D-(\d+)$/.exec(it.id || '')
    if (m) n = Math.max(n, parseInt(m[1], 10))
  }
  return `D-${String(n + 1).padStart(3, '0')}`
}

export interface DecisionInput {
  内容: string
  日期?: string
  状态?: DecisionStatus
  项目?: string
  出处?: string
  备注?: string
  /** 这条管到哪儿（`本卷` / `全局`）。不传 = 空串（老卡没有这一行） */
  生效范围?: string
  /** 落到哪了：`task-xxx` / `commit:xxx` / `不做(理由)`。**不传 = 空 = 还没对过账** */
  落地?: string
}

/** 记一条决策。同内容+同日期幂等（返回已有 id 标记 exists）。 */
export function addDecision(input: DecisionInput): { ok: true; id: string; exists?: boolean } | { ok: false; error: string } {
  let content = (input.内容 || '').trim()
  if (!content) return { ok: false, error: '决策内容为空' }
  // 兼容：调用方仍可能把 `生效范围：本卷` 拼在内容末尾（问卷落卡的老写法）
  let scope = (input.生效范围 || '').trim()
  if (!scope) {
    const split = splitScopeFromTitle(content)
    content = split.内容
    scope = split.生效范围
  }
  // 入参状态过归一：老值/空值都能进（外部灌料常带老写法），非法值再拦
  const status = normalizeDecisionStatus(input.状态)
  if (!DECISION_STATUSES.includes(status)) {
    return { ok: false, error: `状态必须是 ${DECISION_STATUSES.join('/')}，收到：${input.状态}` }
  }
  const date = (input.日期 || new Date().toISOString().slice(0, 10)).trim()
  const items = loadDecisions()
  for (const it of items) {
    if (it.内容 === content && it.日期 === date) {
      return { ok: true, id: it.id, exists: true }
    }
  }
  const id = nextId(items)
  items.push({
    id, 内容: content, 日期: date, 状态: status,
    // ⚠ 项目**原样存用户写的**，不做 id 归一（2026-11-23 定，与 Python 侧同一条）。
    //   归一读侧做就够了：`项目: 绒花墨坊` 现在能被 `project-2` 查到；
    //   而把它悄悄改写成 `project-2` 是替用户改数据（既有测试「项目已落盘」正是盯这个）。
    项目: (input.项目 || '').trim(),
    生效范围: scope, 落地: (input.落地 || '').trim(),
    出处: (input.出处 || '').trim(), 备注: (input.备注 || '').trim(),
    更新: String(Math.floor(Date.now() / 1000)),
  })
  items.sort((a, b) => (a.日期 < b.日期 ? -1 : a.日期 > b.日期 ? 1 : a.id < b.id ? -1 : 1))
  saveDecisions(items)
  logActivity(id, 'decision-add', content.slice(0, 80))
  return { ok: true, id }
}

/** 改决策状态；备注非空追加（不覆盖）。 */
export function setDecisionStatus(
  id: string,
  status: DecisionStatus,
  note?: string
): { ok: true; message: string } | { ok: false; error: string } {
  const next = normalizeDecisionStatus(status)
  if (!DECISION_STATUSES.includes(next)) {
    return { ok: false, error: `状态必须是 ${DECISION_STATUSES.join('/')}，收到：${status}` }
  }
  const items = loadDecisions()
  for (const it of items) {
    if (it.id === id) {
      it.状态 = next
      const extra = (note || '').trim()
      if (extra) it.备注 = (it.备注 ? it.备注 + '\n' : '') + extra
      it.更新 = String(Math.floor(Date.now() / 1000))
      saveDecisions(items)
      logActivity(id, 'decision-set', `${next}${extra ? '：' + extra.slice(0, 60) : ''}`)
      return { ok: true, message: `${id} → ${next}` }
    }
  }
  return { ok: false, error: `决策卡 ${id} 不存在` }
}

/** 允许通过 updateDecision 改的字段 —— 与界面可编辑字段一一对应（记忆纪律：可写字段 ≡ 界面可编辑字段） */
export interface DecisionPatch {
  内容?: string
  日期?: string
  项目?: string
  出处?: string
  备注?: string
  生效范围?: string
  落地?: string
}

/**
 * 改一条决策（2026-10-17 暮雨：“决策似乎并不能进行编辑和删除，也没有其他高级管理功能，
 * 给人失控感”）。
 *
 * 语义与 `updateXxx` 一族保持一致：**没传 ≠ 清空** —— `undefined` 保持原值，传 `''` 才清空。
 * id 与状态不在这里改：状态有专门通道（setDecisionStatus，它还要遵守三态校验），
 * id 是身份，改了等于换一条。
 */
export function updateDecision(
  id: string,
  patch: DecisionPatch
): { ok: true; message: string } | { ok: false; error: string } {
  const items = loadDecisions()
  const hit = items.find((it) => it.id === id)
  if (!hit) return { ok: false, error: `决策卡 ${id} 不存在` }

  const next = { ...hit }
  if (patch.内容 !== undefined) {
    const c = String(patch.内容).trim()
    if (!c) return { ok: false, error: '决策内容不能为空' }
    next.内容 = c
  }
  if (patch.日期 !== undefined) next.日期 = String(patch.日期).trim()
  // ⚠ 项目原样存，不归一成 id（与 addDecision 同一条理由）
  if (patch.项目 !== undefined) next.项目 = String(patch.项目).trim()
  if (patch.出处 !== undefined) next.出处 = String(patch.出处).trim()
  if (patch.备注 !== undefined) next.备注 = String(patch.备注).trim()
  if (patch.生效范围 !== undefined) next.生效范围 = String(patch.生效范围).trim()
  if (patch.落地 !== undefined) next.落地 = String(patch.落地).trim()
  next.更新 = String(Math.floor(Date.now() / 1000))

  // 内容与日期都变了要重新排序（列表按 日期 → id 升序，与 addDecision 同口径）
  const idx = items.indexOf(hit)
  items[idx] = next
  items.sort((a, b) => (a.日期 < b.日期 ? -1 : a.日期 > b.日期 ? 1 : a.id < b.id ? -1 : 1))
  saveDecisions(items)
  logActivity(id, 'decision-update', next.内容.slice(0, 80))
  return { ok: true, message: `已更新 ${id}` }
}

/** 被删决策的留底文件：**刻意不放 `.trash/`** —— 回收站只认任务卡，
    把决策快照塞进去会显示成一条"没有标题、还原后变成脏文件"的怪条目。 */
function deletedLogPath(): string {
  return path.join(getTaskDir(), 'decisions-deleted.md')
}

/**
 * 删一条决策。删之前先把这一条的**完整文本**追加进 `decisions-deleted.md`，
 * 所以"删了还能捞回来"是实话，不是安慰（用户讨厌假话）。
 * 返回被删的 id，供界面提示。
 */
export function deleteDecision(id: string): { ok: true; message: string } | { ok: false; error: string } {
  const items = loadDecisions()
  const hit = items.find((it) => it.id === id)
  if (!hit) return { ok: false, error: `决策卡 ${id} 不存在` }
  const rest = items.filter((it) => it.id !== id)

  try {
    fs.mkdirSync(getTaskDir(), { recursive: true })
    const stamp = new Date().toISOString()
    const block = [
      `## 已删除 ${hit.id}（${stamp}）`,
      `- 内容: ${hit.内容}`,
      `- 日期: ${hit.日期}`,
      `- 状态: ${hit.状态}`,
      hit.项目 ? `- 项目: ${hit.项目}` : '',
      // 新字段也要进留底 —— 留底是"删了还能捞回来"的唯一凭据，漏字段就是捞回来缺一块
      hit.生效范围 ? `- 生效范围: ${hit.生效范围}` : '',
      hit.落地 ? `- 落地: ${hit.落地}` : '',
      `- 出处: ${hit.出处}`,
      hit.备注 ? `- 备注: ${hit.备注}` : '',
      '',
    ].filter(Boolean).join('\n')
    fs.appendFileSync(deletedLogPath(), block + '\n', 'utf-8')
  } catch (e) {
    // 留底失败就不删 —— 宁可删不掉，也不能悄无声息地毁掉一条决策
    return { ok: false, error: `留底失败，已中止删除：${(e as Error).message}` }
  }

  saveDecisions(rest)
  logActivity(id, 'decision-delete', hit.内容.slice(0, 80))
  return { ok: true, message: `已删除 ${id}（留底在 decisions-deleted.md）` }
}
