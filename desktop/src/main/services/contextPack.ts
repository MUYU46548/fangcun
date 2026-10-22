/**
 * 「agent 上下文包」（2026-10-22 · 出单卡「规划上下文包 b 版核对补齐」的落地物）
 *
 * 缘起（10-16 进度汇报原话）：暮雨说的痛点是「AI 写代码没全局意识、天天乱改、忘记东西」——
 * 那不是"界面上立规划"（那个 10-16 已经做了：🗂 规划弹窗），而是**给 agent 的项目上下文包**：
 * 一次把该项目的契约 / 规划 / 已有决策 / 进度喂给本地助手。
 *
 * 所以这个模块只干一件事：**把散在六处的现状拼成一段能直接粘贴的 Markdown**。
 * 不总结、不评价、不生成新内容 —— 拼错了才是灾难（agent 会照着错的干）。
 *
 * 六处来源：
 *   ① 立项契约（各 repo 的 `立项契约.md`）
 *   ② 项目登记表三字段（状态 / 路线图 / 欠着）
 *   ③ 方针（`policies/<id>.md`：使命 / 目标 / 边界 / 结构地图）
 *   ④ 有效决策卡（不含已撤销 / 已合并）
 *   ⑤ 未完成的任务卡（按优先级）
 *   ⑥ 最近几条执行日志
 *
 * **缺什么就说什么**：每一节都带 `missing` 说明（"这个项目没立契约"不是空着不提），
 * 因为"没写"和"写了但空"对 agent 是两回事。
 */
import * as fs from 'fs'
import * as path from 'path'
import { parseRegistry, loadAllTasksRaw } from '../data'
import { loadDecisions } from '../data/decisions'
import { getPolicy } from './policies'
import { readContractFile, repoOfProject } from './tripBoard'
import * as logs from './logs'

export interface ContextPack {
  ok: boolean
  error?: string
  projectId?: string
  projectName?: string
  /** 可直接粘贴的 Markdown */
  text?: string
  chars?: number
  /** 哪些来源是缺的（不许静默：缺了要让 agent / 人一眼看到） */
  missing?: string[]
  /** 每节各收了多少条，便于"这包是不是空的"一眼判断 */
  counts?: { tasks: number; decisions: number; logs: number }
}

const PRIO_RANK: Record<string, number> = { 高: 0, 中: 1, 低: 2 }
const prioRank = (p: unknown) => (String(p ?? '') in PRIO_RANK ? PRIO_RANK[String(p)] : 3)

const asList = (v: unknown): string[] => {
  if (v == null || v === '') return []
  return Array.isArray(v) ? v.map(String) : [String(v)]
}

/** 只留第一句（方案第一条），避免包里塞满长文 —— agent 要的是方向，正文它会自己读卡 */
function firstLine(s: string, max = 90): string {
  const one = String(s || '').replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max) + '…' : one
}

/**
 * 一个字段怎么落进包里。
 *
 * ⚠ 不能一律写成 `- **标签**：<整段>`：契约的「不要什么 / 选型定死」是多行长文本（含 Markdown 表格），
 * 塞进一行列表项后，第二行起没有任何缩进 —— 读起来像是"包自己说的话"，而不是契约原文。
 * 所以：短句一行；带换行的原文**原样成块**（表格能正常渲染），只是前面挂一条标签。
 */
function fieldBlock(label: string, v?: string): string[] {
  const t = String(v ?? '').trim()
  if (!t) return [`- **${label}**：（未填）`]
  if (!t.includes('\n') && t.length <= 100) return [`- **${label}**：${t}`]
  return [`- **${label}**：`, '', t, '']
}

function fmtDay(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!s) return ''
  // ISO / 秒级时间戳 / YYYY-MM-DD 都收，只取日期段
  if (/^\d{9,10}$/.test(s)) {
    const d = new Date(Number(s) * 1000)
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : s
  }
  return s.slice(0, 10)
}

export function buildContextPack(projectId: string, opts: { maxTasks?: number; maxLogs?: number } = {}): ContextPack {
  const pid = String(projectId || '').trim()
  if (!pid) return { ok: false, error: '要说清给哪个项目出上下文包' }

  const reg = (parseRegistry(true) as any[]).find((p) => String(p?.id) === pid)
  if (!reg) return { ok: false, error: `项目登记表里没有「${pid}」` }
  const name = String(reg.name || pid)
  const missing: string[] = []

  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`

  const out: string[] = []
  out.push(`# ${name} · agent 上下文包`, '')
  out.push(`> 生成：${stamp}　项目 id：\`${pid}\``)
  out.push('> 这一包只把现状拼在一起，**不评价、不建议**。要我干啥，看第 5 节和你自己的活儿。')
  out.push('')

  // ── ① 立项契约 ────────────────────────────────────────────────
  const repo = repoOfProject(pid)
  const contract = readContractFile(repo)
  out.push('## 1. 这个项目的边界（立项契约）')
  if (contract.exists) {
    for (const [label, v] of [
      ['终态形态', contract.endState],
      ['验收线', contract.acceptLine],
      ['不要什么', contract.notWant],
      ['选型定死', contract.choice],
    ] as const) out.push(...fieldBlock(label, v))
    if (contract.placeholderFields.length) out.push(`- ⚠ 仍是模板占位（不是内容）：${contract.placeholderFields.join('、')}`)
    if (contract.unmatched.length) out.push(`- ⚠ 这些小节名对不上标准六节：${contract.unmatched.join('、')}`)
  } else {
    out.push(`- （这个项目还没有立项契约${repo ? `：${repo}` : '（也没登记工作目录）'}）`)
    missing.push('立项契约')
  }
  out.push('')

  // ── ② 登记表三字段 ────────────────────────────────────────────
  out.push('## 2. 现在的状态（项目登记表 · 手写）')
  const st = String(reg['状态'] || '').trim()
  const rm = String(reg['路线图'] || '').trim()
  const owe = String(reg['说明'] || '').trim()
  out.push(st ? `- **状态**：${st}` : '- **状态**：（未填）')
  out.push(rm ? `- **路线图**：${rm}` : '- **路线图**：（未填）')
  out.push(owe ? `- **欠着**：${owe}` : '- **欠着**：（未填）')
  if (!st || !rm || !owe) missing.push('登记表三字段（有未填的）')
  out.push('')

  // ── ③ 方针 ────────────────────────────────────────────────────
  out.push('## 3. 方针')
  const pol = getPolicy(pid)
  if (pol) {
    for (const [label, v] of [
      ['使命', pol.mission],
      ['目标', pol.goal],
      ['场景', pol.scenario],
      ['边界', pol.boundary],
    ] as const) out.push(...fieldBlock(label, v))
    if (pol.structureMap && pol.structureMap.trim()) {
      out.push('', '### 结构地图', '', pol.structureMap.trim())
    } else {
      out.push('- ⚠ 没有结构地图（烂地图比没地图危险 —— 别照着猜模块分布）')
    }
  } else {
    out.push('- （这个项目还没立方针）')
    missing.push('方针')
  }
  out.push('')

  // ── ④ 有效决策 ────────────────────────────────────────────────
  out.push('## 4. 已经拍板的事（决策卡 · 只列「有效」）')
  let decs: any[] = []
  try {
    decs = loadDecisions().filter((d) => String(d.状态 || '') === '有效'
      // 归属本项目 或 全局（项目为空）
      && (!String(d.项目 || '').trim() || String(d.项目) === pid))
  } catch {
    decs = []
  }
  decs.sort((a, b) => String(b.日期 || '').localeCompare(String(a.日期 || '')))
  if (decs.length) {
    for (const d of decs.slice(0, 12)) {
      const src = String(d.出处 || '').trim()
      out.push(`- ${fmtDay(d.日期)} · ${String(d.内容 || '').trim()}${src ? `（出处：${src}）` : ''}`)
    }
    if (decs.length > 12) out.push(`- …… 另有 ${decs.length - 12} 条，去「决策」页看`)
  } else {
    out.push('- （没有记过有效决策 —— 这不等于"没有约定"，可能是没人记）')
    missing.push('有效决策卡')
  }
  out.push('')

  // ── ⑤ 未完成的任务卡 ──────────────────────────────────────────
  const maxTasks = opts.maxTasks ?? 15
  const tasks = loadAllTasksRaw('active').filter((t: any) => asList(t?.fm?.project).includes(pid))
  const open = tasks
    .filter((t: any) => {
      const s = String(t?.fm?.status || '')
      return s !== '完成' && s !== '驳回'
    })
    .sort((a: any, b: any) => prioRank(a?.fm?.priority) - prioRank(b?.fm?.priority))
  out.push(`## 5. 还没做完的卡（${open.length} 张${tasks.length !== open.length ? `，另有 ${tasks.length - open.length} 张已完成` : ''}）`)
  if (open.length) {
    for (const t of open.slice(0, maxTasks)) {
      const fm: any = t?.fm || {}
      const meta = [
        String(fm.status || '未填状态'),
        fm.priority ? `优先级 ${String(fm.priority)}` : '优先级未设',
        fm.assignee ? `指派 ${String(fm.assignee)}` : '',
        fm.deadline ? `截止 ${String(fm.deadline)}` : '',
      ].filter(Boolean).join(' · ')
      out.push(`- **${String(fm.title || t.id)}**（${meta}）`)
      const plan = String(t?.body || '').split(/^##\s*方案\s*$/m)[1] || ''
      const step = plan.split(/\r?\n/).map((x) => x.trim()).find((x) => x.startsWith('-'))
      if (step) out.push(`  ${firstLine(step.replace(/^-\s*(\[[ xX]\]\s*)?/, ''))}`)
    }
    if (open.length > maxTasks) out.push(`- …… 另有 ${open.length - maxTasks} 张，去「看板」筛「${name}」看全`)
  } else {
    out.push('- （没有未完成的卡）')
    missing.push('未完成任务卡')
  }
  out.push('')

  // ── ⑥ 最近执行日志 ────────────────────────────────────────────
  const maxLogs = opts.maxLogs ?? 3
  let recent: any[] = []
  try {
    recent = logs.listLogs({ project: pid })
      .sort((a: any, b: any) => String(b.created || '').localeCompare(String(a.created || '')))
  } catch {
    recent = []
  }
  out.push(`## 6. 最近做了什么（执行日志 · 最近 ${Math.min(maxLogs, recent.length)} 条 / 共 ${recent.length} 条）`)
  if (recent.length) {
    for (const l of recent.slice(0, maxLogs)) {
      out.push(`- ${fmtDay(l.created)} · ${String(l.title || l.id || '')}${l.status === 'completed' ? '（已完成）' : ''}`)
    }
  } else {
    out.push('- （这个项目还没有执行日志）')
    missing.push('执行日志')
  }
  out.push('')

  // ── ⑦ 干活时的硬约束（从契约与方针里提，不新造规矩）────────────────
  out.push('## 7. 干活时的硬约束')
  const hard: string[] = []
  if (contract.exists && contract.notWant.trim()) hard.push(`不做：${contract.notWant.trim()}`)
  if (pol && String(pol.boundary || '').trim()) hard.push(`方针边界：${String(pol.boundary).trim()}`)
  hard.push('改完必须真跑验证（不是"应该没问题"）；拿不准就停下来问，别猜。')
  hard.push('这一包是**只读的现状快照**，会过期 —— 你动手前如果隔了很久，先重新生成一份。')
  for (const h of hard) out.push(`- ${h}`)
  out.push('')

  if (missing.length) {
    out.push('---', `⚠ 这一包缺了：${missing.join('、')}。**缺不等于没有**，别拿空白当结论 —— 要么去补，要么问人。`)
  }

  const text = out.join('\n')
  return {
    ok: true,
    projectId: pid,
    projectName: name,
    text,
    chars: text.length,
    missing,
    counts: { tasks: open.length, decisions: decs.length, logs: recent.length },
  }
}

/**
 * 落到 `docs/context-pack-<id>.md`（给"要一份能提交/能贴进别处"的场景）。
 * 只写这一个文件，不碰任何项目仓库。
 */
export function writeContextPackFile(projectId: string): { ok: boolean; path?: string; error?: string; chars?: number } {
  const r = buildContextPack(projectId)
  if (!r.ok) return { ok: false, error: r.error }
  try {
    const { getDataDir } = require('../data') as { getDataDir: () => string }
    const dir = path.join(getDataDir(), 'docs')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, `context-pack-${String(r.projectId)}.md`)
    fs.writeFileSync(p, String(r.text), 'utf-8')
    return { ok: true, path: p, chars: r.chars }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}
