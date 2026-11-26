/**
 * “agent 上下文包”（2026-10-22 · 出单卡“规划上下文包 b 版核对补齐”的落地物）
 *
 * 缘起（10-16 进度汇报原话）：暮雨说的痛点是“AI 写代码没全局意识、天天乱改、忘记东西”——
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
import { buildProjectAlias, decisionMatchesProject } from '../../shared/decisionScope'
import { getPolicy } from './policies'
import { readContractFile, repoOfProject } from './tripBoard'
import * as logs from './logs'
// 2026-11-24：把「该 AI 干的活」从用户通知面板搬进派单任务书（见 §6b）
import * as notificationsSvc from './notifications'
import { ensureDispatchSecret, newDispatchNonce, signDispatch } from './dispatchSign'
import { DISPATCH_SETTINGS_DEFAULTS, checkDispatch, dispatchGateText } from '../../shared/dispatchGate'
import { appendDispatchAudit, lastDispatchAttemptMs, readDispatchAudit, readDispatchSettings } from './dispatchConfig'
import { describeDispatchDelivery } from '../../shared/dispatchDelivery'
import type { DispatchConsumerProbe, DispatchDelivery } from '../../shared/dispatchDelivery'
// 2026-11-24（暮雨第 2 条）：材料的新鲜度由一份纯判定管，别在包拼装里就地写 if
import { judgeFreshness, freshnessNote, STALE_DAYS } from '../../shared/contextFreshness'
// 2026-11-24（暮雨：「垃圾内容太多」）：瘦身口径也收成一处纯逻辑
import {
  dropStruckBlocks, fixNestedLabelLines, compactStructureMap, slimNote, clipAtPunct,
  HARD_RULES_HEADER, HARD_RULES_UNIVERSAL,
} from '../../shared/packSlim'

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
 * ⚠ 不能一律写成 `- **标签**：<整段>`：契约的“不要什么 / 选型定死”是多行长文本（含 Markdown 表格），
 * 塞进一行列表项后，第二行起没有任何缩进 —— 读起来像是"包自己说的话"，而不是契约原文。
 * 所以：短句一行；带换行的原文**原样成块**（表格能正常渲染），只是前面挂一条标签。
 */
function fieldBlock(label: string, v?: string): string[] {
  const t = String(v ?? '').trim()
  if (!t) return [`- **${label}**：（未填）`]
  if (!t.includes('\n') && t.length <= 100) return [`- **${label}**：${t}`]
  return [`- **${label}**：`, '', t, '']
}

/** 读一个文本文件；读不到给空串（节点新鲜度的判断不该因为一次读盘失败就炸掉整包） */
function safeReadText(p: string): string {
  try { return fs.readFileSync(p, 'utf-8') } catch { return '' }
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
  if (!reg) return { ok: false, error: `项目登记表里没有“${pid}”` }
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
    // 2026-11-24（暮雨：「垃圾内容太多」）：契约里的 `~~删除线~~` 是**作者自己划掉的**，
    // Markdown 语义就是"这段不再算数"。留着它等于把已被推翻的规定当现行规矩喂给 agent ——
    // 那不是多给信息，是**给错信息**（本仓的反面教材：一张卡把已被收回的发布说明当方向证据）。
    // 只删成对的 `~~…~~`；落单的 `~~` 原样留着（那是写坏了，不该被我顺手"修好"）。
    for (const [label, v] of [
      ['终态形态', contract.endState],
      ['验收线', contract.acceptLine],
      ['不要什么', contract.notWant],
      ['选型定死', contract.choice],
    ] as const) out.push(...fieldBlock(label, dropStruckBlocks(v).text))
    if (contract.placeholderFields.length) out.push(`- ⚠ 仍是模板占位（不是内容）：${contract.placeholderFields.join('、')}`)
    if (contract.unmatched.length) out.push(`- ⚠ 这些小节名对不上标准六节：${contract.unmatched.join('、')}`)
    // 2026-11-24（暮雨第 2 条）：**契约原文逐字照搬，但它里面的"当前断点"早就不成立了**。
    // 实测这份契约写着「一屏视图不存在」「6 个项目在方寸零任务卡」—— 两件都做完了。
    // 模型不会怀疑上下文包，所以要么标出过期、要么它就会去建一个已经存在的东西。
    // ⚠ 时间锚只能从**原文**里找：`TripContract` 只暴露六个字段，断点那几行不在里面。
    const contractRaw = repo ? safeReadText(path.join(repo, '立项契约.md')) : ''
    const fresh = freshnessNote('这份契约', judgeFreshness(contractRaw))
    if (fresh) out.push(fresh)
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
      // 2026-11-24（暮雨：「垃圾内容太多」）：结构地图 1772 字里，
      // 模块表（1035）与规约层（170，含硬约束）是 agent 要的；
      // 「主数据流 / 桌面端数据流」两段描述（542 字）它有仓库可读，是重复劳动。
      // 判据在 `shared/packSlim.compactStructureMap`：**按有没有约束力决定去留，不按文体**。
      const mapCompact = compactStructureMap(pol.structureMap)
      out.push('', '### 结构地图', '', mapCompact.text)
      // 省了什么必须写在包里 —— 不许让 agent 以为它看到了完整那张图
      const mapNote = slimNote(mapCompact.omitted, `policies/${pid}.md`)
      if (mapNote) out.push(mapNote)
      // 2026-11-24（暮雨第 2 条）：结构地图是「一张写下来的现状」，最容易悄悄过期。
      // 判据与共享模块同一份（`shared/contextFreshness`），阈值沿用本仓既有的 90 天。
      const mapFresh = freshnessNote('这张结构地图', judgeFreshness(pol.structureMap))
      if (mapFresh) out.push(mapFresh)
    } else {
      out.push('- ⚠ 没有结构地图（烂地图比没地图危险 —— 别照着猜模块分布）')
    }
  } else {
    out.push('- （这个项目还没立方针）')
    missing.push('方针')
  }
  out.push('')

  // ── ④ 有效决策 ────────────────────────────────────────────────
  out.push('## 4. 已经拍板的事（决策卡 · 只列“有效”）')
  let decs: any[] = []
  try {
    const alias = buildProjectAlias(parseRegistry(true) as { id: string; name?: string }[])
    // ⚠ 2026-11-23：归属判定换成 decisionMatchesProject。
    //   老写法是 `!项目 || 项目 === pid` —— 于是
    //     · 写 `项目: 全局` 的（D-033 模型成本架构 / D-031 数据零外部依赖 / D-032 交付三铁律）
    //       **任何项目都拿不到**（「全局」既不是空串也不等于任何 pid）；
    //     · 写中文名的（`方寸` / `司天`）用 id 查不到。
    //   实测 fangcun-base：老口径 60 条 → 正确口径 71 条，漏 11 条**全是全局规矩**。
    decs = loadDecisions().filter((d) => String(d.状态 || '') === '有效'
      && decisionMatchesProject((d as any).项目, pid, alias))
  } catch {
    decs = []
  }
  /**
   * 决策**自足程度**（2026-11-24 · 暮雨：「垃圾内容太多」）。
   *
   * ## 为什么需要它
   *
   * 这个项目 74 条有效决策里，**41 条是"答题型"**：内容是
   * `K2：在B的基础上，已取消默认隐藏…` / `N2：全部默认开` 这种
   * 「题号 + 选项」的形态。它们都是真决定，但：
   *   · **脱离那道题就读不懂**（"全部默认开"—— 什么叫全部？开什么？）；
   *   · 对 agent 的约束力最弱：它们回答"甲方想要哪个选项"，
   *     而 agent 真正要守的是**"你不能做什么"**。
   *
   * 按日期倒序取 12 条，结果**全是最近三份问卷**，
   * 把 `D-032 交付三铁律` / `D-031 数据零外部依赖` / `D-152 全走DSH` 这些
   * **真正的规矩**全挤出去了 —— 这不是"少几条"，是**给错了方向**
   * （契约里还写着「BYOK 本阶段接」，而 D-152 早已改判"全走DSH"）。
   *
   * ## 判据
   *
   * 自足 = 这句话单独拿出来还看得懂。**只看形态，不看重要性** ——
   * "哪条更重要"是人的判断，我不该替用户打这个分。
   *
   * 所以排序是：**先按自足，再按日期**。同一天里，正着读得懂的排前面。
   */
  const isAnswerShaped = (d: any): boolean => {
    const c = String(d?.内容 || '').trim()
    // `K2：B. …` / `S1：A. …` / `N2：…`（题号 + 冒号，后接选项字母或直接是答案）
    if (/^[A-Z]\d*\s*[：:]\s*[A-D][.、]/.test(c)) return true
    // 只有题号没有内容（"N2：全部默认开" 这种仍算半自足，但排在自足之后）
    return false
  }
  decs.sort((a, b) => {
    const sa = isAnswerShaped(a) ? 1 : 0
    const sb = isAnswerShaped(b) ? 1 : 0
    if (sa !== sb) return sa - sb                  // 自足的在前
    return String(b.日期 || '').localeCompare(String(a.日期 || ''))
  })
  // 2026-11-24（暮雨：「垃圾内容太多」）：
  // **别让一份问卷把决策节吃光**。
  //
  // 实测：74 条有效决策里，按日期倒序取 12 条，结果是 **11 条问卷答案**
  // （"K1：A. …" / "N2：全部默认开" 这类）。它们都是真的决定，但**离开了那道题就读不懂**，
  // 而且对 agent 的约束力最弱 —— 它们回答的是"甲方想要哪个选项"，不是"你不能做什么"。
  //
  // 更糟的是被挤掉的：**D-152「全走DSH，方寸无任何理由留自带模型调用」（11-20，排第 19）**
  // —— 而契约 §1 里还写着「LLM 智能层本阶段接（BYOK）」。两条互相矛盾，
  // 包里给了旧的那条、藏了新的那条。这不是"少几条"，是**给了错的方向**。
  //
  // 判据：**同一个出处（同一份问卷 / 同一个来源）最多占 3 条**。
  // 为什么是 3 而不是"每条都要有"：问卷一次能出十来个选项题，
  // 若每条都算，任何限定条数都会被一份新问卷淹没。
  // ⚠ 被挤掉的照旧明说"另有 N 条"，不假装那就是全部。
  const PER_SOURCE_CAP = 3
  /**
   * 把「出处」归到**它的来源**上。
   *
   * ⚠ 第一版直接拿 `出处` 原文当 key，结果**一条都没限住** —— 因为问卷落卡的出处带着题号：
   *     `问卷 方寸-通知默认策略-20261121 · N1`
   *     `问卷 方寸-通知默认策略-20261121 · N2`
   *   每条字符串都不同，于是"同一份问卷"看起来像五个不同来源。
   *
   * 所以取 `· <题号>` **之前**的部分。注意不能简单按 `-` 切 —— 卷名里本来就有 `-`。
   */
  const sourceGroupOf = (src: string): string => {
    const s = String(src || '').trim()
    if (!s) return ''
    const head = s.split('·')[0].trim()
    return head || s
  }
  const seenSource = new Map<string, number>()
  const kept: any[] = []
  for (const d of decs) {
    const src = String(d.出处 || '').trim()
    // 没有出处的**不参与限流**（那种条数很少，且往往是手写的老规矩，更该给 agent 看）
    if (!src) { kept.push(d); continue }
    const g = sourceGroupOf(src)
    const n = seenSource.get(g) || 0
    if (n >= PER_SOURCE_CAP) continue
    seenSource.set(g, n + 1)
    kept.push(d)
  }
  const shownDecs = kept.slice(0, 12)
  /**
   * 一条决策在包里最多占多少字（2026-11-24）。
   *
   * 实测真身：`L1` 那条是 **150+ 字的口述**（"我自己爱用git，一键无脑备份……
   * 顺便问卷功能没做输入保护，刚才我打的字全没了"）—— 它是**真实反馈**，
   * 但作为"现行规矩"它只有前半句有效，后半句是一次事故的具体抱怨。
   *
   * 关键：**截断必须让 agent 知道自己看到的是截断的**，否则它会以为那就是全文。
   * 所以尾部一定带 `…（全文见决策页 <id>）`。
   */
  const DEC_CHAR_CAP = 90
  if (shownDecs.length) {
    // 2026-11-24：**「最新」不等于「最要紧」** —— 这一行必须说清楚，
    // 否则 agent 会以为列出来的就是全部现行规矩，而没列的那些可以不管。
    out.push('- 下面是**最近**拍板的一部分（不是全部，也不等于最要紧的都在这里）：')
    for (const d of shownDecs) {
      const src = String(d.出处 || '').trim()
      // 生效范围只在这条**不是**"本卷"时标出来：满屏都是「本卷」等于没有信息。
      const scope = String((d as any).生效范围 || '').trim()
      const scopeTag = scope && scope !== '本卷' ? `〔${scope}〕` : ''
      const rawContent = String(d.内容 || '').trim()
      const body = clipAtPunct(rawContent, DEC_CHAR_CAP)
      const idTag = rawContent.replace(/\s+/g, ' ').trim().length > DEC_CHAR_CAP
        ? `…（全文见决策页 ${String(d.id || '')}）`
        : ''
      out.push(`- ${fmtDay(d.日期)} · ${scopeTag}${body}${idTag}${src ? `（出处：${src}）` : ''}`)
    }
    if (kept.length > shownDecs.length || decs.length > kept.length) {
      const more = decs.length - shownDecs.length
      out.push(`- …… 另有 ${more} 条，去“决策”页看`
        + (decs.length > kept.length ? `（同一份问卷最多列 ${PER_SOURCE_CAP} 条 —— 其余的条目脱离原题就读不懂）` : ''))
    }
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
      // 2026-11-24（暮雨：「垃圾内容太多」）：**卡标题在包里要封顶**。
      // 实测真身里有 60+ 字的标题（"【UI 不统一·守卫漏了】6 个真花钱入口只有 2 个带 ¥ 角标
      // —— 因为守卫只读 ProjectsView.vue；同一按钮还有 26/28/28 三种高度"），
      // 一条就顶三行。标题的作用是**让 agent 认出这张卡**，不是把卡读完 —— 正文它会去读。
      const titleRaw = String(fm.title || t.id)
      const title = clipAtPunct(titleRaw, 46)
      out.push(`- **${title}**（${meta}）`)
      const plan = String(t?.body || '').split(/^##\s*方案\s*$/m)[1] || ''
      const step = plan.split(/\r?\n/).map((x) => x.trim()).find((x) => x.startsWith('-'))
      if (step) {
        const stepText = firstLine(step.replace(/^-\s*(\[[ xX]\]\s*)?/, ''))
        // 2026-11-24：**别把标题再说一遍**。实测真身：`[账本] 方寸：备份选型（0.3.4-B …）`
        // 下面紧跟一行 `备份选型（0.3.4-B 数据安全项，10-09 起无下文）` ——
        // 同一句话出现两次，agent 会以为那是"方案的第一步"。
        const dupTitle = stepText && (
          titleRaw.includes(stepText) || stepText.includes(titleRaw)
          || (stepText.length > 12 && titleRaw.slice(0, 12) === stepText.slice(0, 12))
        )
        if (!dupTitle) out.push(`  ${stepText}`)
      }
    }
    if (open.length > maxTasks) out.push(`- …… 另有 ${open.length - maxTasks} 张，去“看板”筛“${name}”看全`)
  } else {
    out.push('- （没有未完成的卡）')
    missing.push('未完成任务卡')
  }
  out.push('')

  // ── ⑤b 被驳回、还没人处理的卡（AI 自己捡；人永远不看返工台）──────────
  // 2026-11-26 用户：「人不用看返工台，永远不用」「AI 直接读驳回的卡开工（还要有限）」。
  // 以前驳回卡只进「体检」面板给用户看 —— 用户不做，等于丢失。
  const rejected = tasks.filter((t: any) => String(t?.fm?.status || '') === '驳回')
  if (rejected.length) {
    out.push(`## 5b. 被驳回的卡（${rejected.length} 张 · AI 自己捡，人永远不看返工台）`)
    out.push('每轮最多处理 **2 张**：能重做的用 `fangcun_write` move 回「进行中」并直接开工；')
    out.push('判定方向已错（驳回理由里写「没必要做 / 方向错 / 大后期」）→ move 到「已取消」，并在卡正文补一句处置理由。不要等用户。')
    for (const t of rejected.slice(0, 3)) {
      const fm: any = t?.fm || {}
      const why = String(fm.reject_reason || fm['驳回理由'] || '未写理由')
      const at = String(fm.reject_at || fm['驳回时间'] || '').slice(0, 10)
      out.push(`- **${clipAtPunct(String(fm.title || t.id), 46)}**（${at || '时间不详'} 驳回：${clipAtPunct(why, 90)}）`)
    }
    out.push('')
  }

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

  // ── ⑥b 方寸手上「该 AI 干、还挂着」的事（2026-11-24）────────────────
  //
  // 暮雨原话：「这种弹出来让人什么都做不了的通知有什么意义？本来就是 AI 自己的问题，
  // 要弹也是去弹给 AI 看」。
  //
  // 「卷批准了没落卡」「草案没提成」「技能副本落后」「有反问待重出题」这四类的下一步动作
  // 全在 agent 手里（它有 create_task / stage_plan_propose / qn_propose / 装技能），
  // 用户自己点不动。所以它们从**用户的通知面板**移到**派单任务书**里来 ——
  // 这一节就是那根管子：有过期未处理的 agent 活，就在这里点名，没有就一个字节都不加。
  //
  // 口径：只列 `owner==='agent'` 且**未读**的（已读 = 用户看过了/派过了），
  // 最多 8 条，超出只说还有几条 —— 任务书不该变成第二块通知墙。
  try {
    const agentOwned = notificationsSvc.listNotifications()
      .filter((n: any) => n.owner === 'agent' && !n.read)
      .slice(0, 8)
    if (agentOwned.length) {
      out.push('## 6b. 方寸手上挂着「该 AI 做、还没人做」的事')
      out.push('下面是方寸扫描到的、**下一步动作在 agent 手里**的活（用户点的通知里已不再打扰他）。')
      out.push('开工前先看一眼：与本次任务相关的顺手做掉；不相关的在交回时说一句“没做，因为…”。')
      for (const n of agentOwned) {
        out.push(`- 【${n.type}】${String(n.title || '')}${n.sourceId ? `（${String(n.sourceId)}）` : ''}`)
      }
      const total = notificationsSvc.listNotifications().filter((n: any) => n.owner === 'agent' && !n.read).length
      if (total > agentOwned.length) out.push(`- …… 另有 ${total - agentOwned.length} 条，到通知中心筛「该我做」看全`)
      out.push('')
    }
  } catch { /* 读不到通知不该让整份任务书挂掉 */ }

  // ── ⑦ 干活时的硬约束 ────────────────────────────────────────────
  //
  // ⚠ 2026-11-24（暮雨：「上下文包有问题也要改，垃圾内容太多」）：
  //   这一节原来把契约的「不要什么」和方针的「边界」**原样再贴一遍** ——
  //   实测 909 / 1109 字（82%）与第 1 节逐行相同。
  //
  //   重复不只是费字，还会**制造两份可漂移的副本**：agent 在同一份包里读到
  //   同一批规矩的两个版本（一个带完整 REV 链、一个被截断），会以为其中一段是补充说明。
  //
  //   所以这一节只留**别处没有的**：一句指路 + 方寸自己的两条通用规矩。
  //   那句指路值得花 40 字 —— 没有它，agent 会看到一个只有两条的"硬约束"节，
  //   反推出"这项目没有别的规矩"。
  out.push('## 7. 干活时的硬约束')
  for (const h of HARD_RULES_UNIVERSAL) out.push(h)
  out.push(HARD_RULES_HEADER)
  out.push('')

  if (missing.length) {
    out.push('---', `⚠ 这一包缺了：${missing.join('、')}。**缺不等于没有**，别拿空白当结论 —— 要么去补，要么问人。`)
  }

  // 2026-11-24（暮雨：「垃圾内容太多」）：
  // `fixNestedLabelLines` 修的是拼包时的**结构塌陷**，不是排版洁癖 ——
  // 实测真身有过 `- 不做：- **运营期要用户手动喂的规划工具**（…）`：
  // 标签后面直接跟列表符，agent 会把它读成一个叫"不做："的条目，
  // 而不是"X 属于不做的那一类"。放在最后统一修，省得每个字段各修一遍。
  const text = fixNestedLabelLines(out.join('\n'))
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

/** 「发送给 DSH」的派单目录（数据根下的 `.dispatch-dsh/`，不属于任何项目仓库）
 *
 * ⚠ 文案口径：UI 上是「发送给 DSH」（暮雨 2026-11-17：「🧠 派给 DSH 按钮太丑了，
 *   改成『发送给DSH』都能让人看懂」）。目录名与函数名 `dispatchDir` / `dispatchToDsh`
 *   是内部标识，沿用旧名，不跟着改。 */
export function dispatchDir(): string {
  const { getDataDir } = require('../data') as { getDataDir: () => string }
  return path.join(getDataDir(), '.dispatch-dsh')
}

export interface DispatchResult {
  ok: boolean
  error?: string
  /** 派单文件绝对路径 */
  path?: string
  projectId?: string
  chars?: number
  /** 上下文包里缺了哪几处（缺了要当场说，别让 agent 以为"这项目没这些规矩"） */
  missing?: string[]
  at?: string
  /** 派单用途（2026-11-17 暮雨：以后直接在 DSH 里派活做规划） */
  kind?: DispatchKind
  /** 冷却中：这次**没有写任何文件**（renderer 拿它区分"失败"与"等一会儿"） */
  cooling?: boolean
  /** 冷却还剩多少毫秒（拒绝时给出，renderer 拿它起倒计时） */
  leftMs?: number
  /** 本次生效的冷却时长（成功时给出。renderer 照它显示，不许自己另写一个数） */
  cooldownMs?: number
  /** 派单总闸没开（默认态）：这次没有写文件，也不是故障 —— 是用户还没启用 */
  disabled?: boolean
  /** 这次是闸门的哪一条拦下的：disabled / cooldown / daily-cap / concurrency */
  reason?: string
  /** 今天已成功开过的会话数 / 日上限（0 = 不限） */
  today?: number
  dailyCap?: number
  /** 今天还能开几个（-1 = 不限） */
  leftToday?: number
  enabled?: boolean
  /**
   * 这份派单**是不是真的会被消费**（2026-11-24 暮雨第 8 条）。
   *
   * 原话：「如果 DSH 未启动，方寸的 DSH 联动功能（各种派单类）是否会有智能的处理方式？
   * 还是卡着骗用户已成功？」
   *
   * 诚实回答（改之前）：**会骗**。方寸只负责把文件写进 `.dispatch-dsh/`，
   * 消费方是 DSH 里的插件；DSH 没开 = 没人来取 = 文件静静躺着。
   * 而界面弹的是绿色 `已发送给 DSH：「X」的上下文包……DSH 那边会冒出一个新会话`，
   * 用户以为派成功了，实际什么都不会发生。
   *
   * 现在成功路径带上这个信号，由渲染层把话说全：
   *   · `queued`      —— 文件已落盘，**但要等 DSH 打开后由插件消费**（不是"已经开工"）；
   *   · `sent`        —— 宿主明确回报已开（当前文件通道拿不到这个，保留值待真通道）；
   *   · `will-consume`—— 探测到消费方在场（DSH 在跑且插件装着），8 秒内会被取走。
   *
   * ⚠ 判据只认**能核实的东西**（DSH 进程 / 插件装没装）。探测不到就报 `queued`，
   *   绝不因为"探测不到"就说成功 —— 那正是这条要治的病。
   */
  delivery?: 'queued' | 'will-consume' | 'sent'
  /** 给界面直接显示的一句话（delivery 的人话版；UI 不许自己另编一套） */
  deliveryHint?: string
  /** 消费方是否在场（探到了 = 真的有人在取；没探到 / 没核实 = false） */
  consumerPresent?: boolean
  /** 这条派单是从哪条日志派出去的（空 = 从项目页派的，不涉及日志） */
  logId?: string
  /** 那条日志现在是不是「进行中」（2026-11-24 第 1 条：派单成功后自动标） */
  logRunning?: boolean
  /** 没标上 / 没动它的原因（有值 ≠ 派单失败；派单文件已经落盘了） */
  logRunningError?: string
}

/**
 * 派单冷却（2026-11-20 · 暮雨；2026-11-21 改为**共享设置**驱动）。
 *
 * 暮雨原话：「规划类派活类任务的按钮有没有冷却机制？比如点一次倒计时 10s，
 *   防止用户狂点开一堆会话浪费钱。」
 *
 * **没有冷却时是什么样**：点一次 = 写一份派单文件；插件每 8 秒消费最新一份并
 * `agents.create` + `followup`，也就是真的开一个模型会话、烧一份上万字的上下文。
 * 连点 N 次就是 N 个会话 —— 钱是按会话烧的，手滑一次就翻倍。
 *
 * 2026-11-21 起冷却**不再是一个写死的 10 秒常量**：
 *   · 出厂总闸是关的（`dispatchEnabled:false`）；
 *   · 用户打开之后，冷却秒数 / 日上限 / 在途数从
 *     `<数据根>/.dispatch-dsh/dispatch-settings.json` 读；
 *   · 判据只有一条（`shared/dispatchGate.ts#checkDispatch`），插件消费端用同一套。
 *
 * ⚠ 这一层只是第二道闸。真正防滥用的是「默认关 + 签名」：
 *   文件在不在都不该等于"可以开会话"。
 */
export const DISPATCH_COOLDOWN_MS = DISPATCH_SETTINGS_DEFAULTS.cooldownSec * 1000

/**
 * 距离冷却结束还有多少毫秒（0 = 可以派）。**纯读**，不改状态。
 *
 * 从审计真身算，不靠内存 —— 重启后方寸与插件的答案才是同一个：
 * 内存里记"10 秒内派过"会在下一进程里凭空消失，而钱已经花过了。
 */
export function dispatchCooldownLeft(projectId: string, now: number = Date.now()): number {
  const pid = String(projectId || '').trim()
  if (!pid) return 0
  const gate = checkDispatch(pid, readDispatchSettings(), readDispatchAudit(), now)
  return gate.reason === 'cooldown' ? gate.leftMs : 0
}

/**
 * 把同一个项目**还没被插件消费**的旧派单删掉，只留这次写的那份。
 *
 * 为什么必须清：插件每 8 秒消费**最新一份**。如果 DSH 没开着，用户每 10 秒点一次
 * 就会堆一份；等 DSH 一开，插件会一份一份全开成会话 —— 那些都是旧点击的幽灵，
 * 用户早就不记得自己点过，但钱照烧。
 *
 * 只删**同一个项目**的：别的项目的派单是另一次操作，不动。
 * 删不掉就留着（Windows 上可能正被插件读着）—— 少删一份比删错一份强。
 */
function pruneStaleDispatches(dir: string, projectId: string, keepName: string): void {
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { return }
  const prefix = `dispatch-${projectId}-`
  for (const name of names) {
    if (name === keepName || !name.startsWith(prefix)) continue
    // 文件名：dispatch-<项目 id>-<14 位时间戳>.md。用"剩余部分正好是时间戳"判定，
    // 不用正则抓 `.+-(\d{14})` —— 那会把 `a` 项目的文件当成 `a-b` 项目的（前缀包含）。
    if (!/^\d{14}\.md$/.test(name.slice(prefix.length))) continue
    try { fs.unlinkSync(path.join(dir, name)) } catch { /* 正被插件读着就下次再说 */ }
  }
}

/**
 * 派单用途。
 *
 * 暮雨 2026-11-17 定案：「规划功能几乎要全部重做……现在定死了 DSH 绑方寸，
 * **以后可以直接在 DSH 里派活做规划**。」
 *
 * 所以同一根管子上要跑两种活，而它们对模型的要求完全不同：
 *   · `work` 开工：**改代码/改卡**（0.6.0 只有这一种）；
 *   · `plan` 规划：**产出可机检的判据**，不许直接开干。
 *
 * ⚠ 缺省 `work`：老派单文件没有这个字段，行为必须与 0.6.0 完全一致。
 */
export const DISPATCH_KINDS = ['work', 'plan'] as const
export type DispatchKind = typeof DISPATCH_KINDS[number]

export function normalizeDispatchKind(raw: unknown): DispatchKind {
  const k = String(raw ?? '').trim().toLowerCase()
  return (DISPATCH_KINDS as readonly string[]).includes(k) ? (k as DispatchKind) : 'work'
}

/**
 * 把某个项目的上下文包**发送给 DSH**（2026-11-17）。
 *
 * ⚠ 文案口径：UI 上是「发送给 DSH」，不是「派给 DSH」。
 *   暮雨 2026-11-17：「🧠 派给 DSH 按钮太丑了，改成『发送给DSH』都能让人看懂」。
 *   函数名 `dispatchToDsh` 与 IPC 通道 `context:dispatchDsh` 是内部标识，沿用旧名。
 *
 * 暮雨原话：「管子现在就做，它是其他一切的前提。」
 *
 * ## 为什么是"写文件"而不是"直接调 DSH"
 *
 * 三方各有硬边界，只有文件能同时满足：
 *   ① 方寸**不 import DSH 的任何东西**（它连 DSH 有没有装都只是只读探测）；
 *   ② 插件**不 import 方寸代码**（`test/plugin.test.mjs ③` 钉着）；
 *   ③ 两边都不能把上万字的上下文包塞进命令行参数。
 *
 * 所以：**方寸写一份派单文件，插件看见就消费**。跨进程只经文件，谁也不用知道对方的内部。
 *
 * ## 为什么是"一次一份"，不是队列
 *
 * 队列要处理排序、去重、失败重试、堆积清理 —— 那是另一个子系统。
 * 而「发送给 DSH」是**人在界面上点一次的即时动作**，同时点两次的语义本来就是"最后一次算"。
 * 所以：**同名覆盖**，插件消费后**删掉**。简单到不会坏。
 *
 * ⚠ 不在这里调 `exec` / `spawn` 去戳 DSH —— 方寸不知道 DSH 在不在、是哪个 profile。
 *   那是插件的活（它在 DSH 进程里，天然知道）。
 *
 * @param kind `work`（默认，马上干活）或 `plan`（做规划，产出机检判据）。
 *             认不出的值回落 `work` —— 不许静默升级成 plan，那会让模型莫名被要求写判据。
 * @param now 模拟时刻（只给测试/回放用）。真实调用不传 = 现在。
 *            冷却判定与文件头 `at` 都用它，测试才不用真等 10 秒。
 */
export function dispatchToDsh(
  projectId: string,
  kindRaw?: unknown,
  now: number = Date.now(),
  consumer?: DispatchConsumerProbe | null,
): DispatchResult {
  return dispatchMessageToDsh(projectId, kindRaw, '', now, consumer)
}

/**
 * 带一段「这次要做的事」的派单（2026-11-20 · D-150）。
 *
 * 为什么要有它：文档拆卡 / 出单不再调方寸自己的模型（问卷 D2 选 B：都改成 DSH 派单），
 * 但这两件事**不是**通用的“开工”或“做规划”——它们需要一句明确的任务书：
 *   · 文档拆卡：把下面这份文档拆成≤20 张待审批卡；
 *   · 出单：从台账+决策卡派生下一批 3-8 张待审批卡。
 * DSH 插件仍按 `kind=work` 开会话；`prefix` 会放在上下文包**前面**，agent 一进来先看到它。
 *
 * ⚠ 不是“自由文本派单口”：prefix 由界面固定生成（不是 agent 传入），
 *   冷却/旧派单清理/文件头格式与 `dispatchToDsh` 完全同一套。
 *
 * @param prefix 这次要做的事（Markdown）。空串 = 与 `dispatchToDsh` 逐字一致。
 */
/**
 * 派单成功后把**这一条**日志标为「进行中」（2026-11-24 · 暮雨第 1 条）。
 *
 * 暮雨原话：「建议方寸日志派活成功后日志自动标进行中（**未测试过绑定日志全组派活**）。」
 *
 * 后半句是提醒，不是需求：把"绑定的一整组"一起拉起来是**另一个决定**
 * （组里可能有几条是已经做完的，硬拉回来会毁掉它们的完成时间与保留期）。
 * 所以这里只动传进来的那一条；全组开关仍由用户在界面上点。
 *
 * 三种情况都返回结构化结果而不是抛：
 *   · 没传 logId（项目页派的单，不涉及日志）→ `{running:false}`，不是错误；
 *   · 日志不存在 / 已被销毁 → 记一条警告，派单照常成功；
 *   · 已经是进行中 → 幂等成功（重复派单不会出错）。
 *
 * ⚠ **绝不影响派单结果**：派单文件已经落盘了，那件事已经发生了。
 *   为了"标个状态"去报派单失败，会让用户以为没派出去 —— 那是更大的谎。
 */
function markLogRunningAfterDispatch(logId?: string): { running: boolean; error?: string } {
  const id = String(logId || '').trim()
  if (!id) return { running: false }
  try {
    const cur = logs.getLog(id)
    if (!cur) return { running: false, error: `日志不存在（${id}），没标进行中` }
    // 只拉"待处理"这一格：已完成 / 已归档的日志不该被一次派单悄悄改写生命周期
    // （它们有自己的 runningFrom 记忆机制，走 setLogRunning 的常规入口才对）。
    if (cur.status !== 'active') {
      return { running: false, error: `日志是「${cur.status === 'completed' ? '已完成' : '已归档'}」，没自动改回进行中` }
    }
    if (cur.running === true) return { running: true }
    const r = logs.setLogRunning(id, true)
    return r.ok ? { running: true } : { running: false, error: r.error || '标记失败' }
  } catch (e: any) {
    return { running: false, error: String(e?.message || e) }
  }
}

export function dispatchMessageToDsh(
  projectId: string,
  kindRaw: unknown,
  prefix: string,
  now: number = Date.now(),
  /** 消费方探测结果（2026-11-24）：不传 = 没核实到，措辞退回最保守的那种 */
  consumer?: DispatchConsumerProbe | null,
  /**
   * 这条派单是从哪条执行日志派出去的（2026-11-24 暮雨第 1 条）。
   *
   * 原话：「建议方寸日志派活成功后日志自动标进行中（未测试过绑定日志全组派活）。」
   *
   * 为什么该自动标：日志的「进行中」是**手动开关**（2026-09-28 用户第 2 条定的：
   * 只能手动打、可撤销）。但"从日志页点了发送给 DSH"这件事**本身就是一次开工动作** ——
   * 用户已经用行为说明了"这条现在在跑"，再让他去点一下开关是把同一件事做两次。
   *
   * 三条边界（不做就越界成"替用户改状态"）：
   *   ① **只在派单真成功之后**才标（排队成 `ok:true` 就算成功 —— 文件已落盘会被消费）；
   *   ② **只动这条日志自己**，不碰它的附属日志（暮雨那句"未测试过绑定日志全组派活"
   *      就是在提醒这件事：全组一起拉起来是**另一个决定**，不能顺手替他做了）；
   *   ③ 失败不报给用户（杀不了派单），但要如实写进返回值，免得"标没标上"变成猜。
   */
  logId?: string,
): DispatchResult {
  const pid = String(projectId || '').trim()
  if (!pid) return { ok: false, error: '没给项目 id' }
  const kind = normalizeDispatchKind(kindRaw)
  const pre = String(prefix || '').trim()

  // ① 总闸：**先判，不建包、不写文件**。
  //    2026-11-21 改口径：出厂默认关（`enabled:false`），没被用户显式打开之前，
  //    任何路径都开不出会话。冷却 / 日上限 / 在途是打开之后的第二道闸。
  //    判据只有一条（shared/dispatchGate.ts），插件消费端用的是同一套。
  const settings = readDispatchSettings()
  const gate = checkDispatch(pid, settings, readDispatchAudit(), now, 0, lastDispatchAttemptMs(pid))
  if (!gate.ok) {
    // 拒单也留痕（audit.jsonl）：这是"到底是谁在开会话"的唯一凭据。
    // 只数 ok:true 的算额度，所以这些行不会消耗当天配额。
    appendDispatchAudit({
      ok: false,
      reason: gate.reason,
      stage: 'gui-gate',
      source: 'gui',
      project: pid,
      kind,
    })
    const error = dispatchGateText(gate)
    if (gate.reason === 'disabled') {
      return {
        ok: false,
        disabled: true,
        enabled: false,
        reason: 'disabled',
        error,
        projectId: pid,
        kind,
      }
    }
    if (gate.reason === 'cooldown') {
      return {
        ok: false,
        cooling: true,
        leftMs: gate.leftMs,
        enabled: true,
        reason: 'cooldown',
        error,
        projectId: pid,
        kind,
      }
    }
    return {
      ok: false,
      enabled: true,
      reason: gate.reason,
      today: gate.today,
      dailyCap: gate.dailyCap,
      leftToday: gate.leftToday,
      error,
      projectId: pid,
      kind,
    }
  }

  const r = buildContextPack(pid)
  if (!r.ok) return { ok: false, error: r.error || '上下文包没生成出来' }

  try {
    const dir = dispatchDir()
    fs.mkdirSync(dir, { recursive: true })
    const at = new Date(now).toISOString()
    // 文件名带时间戳 + 项目：插件按时间戳挑最新的一份，人能一眼看出是什么时候派的。
    // kind 不进文件名 —— 文件名要短；用途在头部，人和插件都读得到。
    const stamp = at.replace(/[-:T]/g, '').slice(0, 14)
    const p = path.join(dir, `dispatch-${String(r.projectId)}-${stamp}.md`)
    const bodyText = pre ? `${pre}\n\n---\n\n${String(r.text)}` : String(r.text)
    // 2026-11-20（父卡「派单防滥用」）：GUI 派单必须带签名 ——
    // 密钥只在 userData，agent 直接往数据根写文件没有签名，插件会拒收。
    // 签名覆盖 source/project/at/kind/nonce/chars/missing/body，改一个字都对不上。
    const source = 'gui'
    const nonce = newDispatchNonce()
    let secret = ''
    let sig = ''
    try {
      secret = ensureDispatchSecret()
      sig = signDispatch(secret, {
        source, project: String(r.projectId), at, kind, nonce,
        chars: bodyText.length, missing: r.missing || [], body: bodyText,
      })
    } catch (e: any) {
      return { ok: false, error: '派单签名失败（不会写无签名派单）：' + String(e?.message || e) }
    }
    const body = [
      `<!-- fangcun-dispatch v1`,
      `project: ${String(r.projectId)}`,
      `projectName: ${String(r.projectName || '')}`,
      `at: ${at}`,
      `kind: ${kind}`,
      `source: ${source}`,
      `nonce: ${nonce}`,
      `sig: ${sig}`,
      `chars: ${bodyText.length}`,
      `missing: ${(r.missing || []).join('|')}`,
      `-->`,
      '',
      bodyText,
    ].join('\n')
    fs.writeFileSync(p, body, 'utf-8')
    // 新的一落盘就清掉同项目的旧派单（同一项目同时只留一份"待消费"）。
    pruneStaleDispatches(dir, String(r.projectId), path.basename(p))
    // 2026-11-24（暮雨第 8 条）：**落地 ≠ 有人接**。
    // 判据在 shared/dispatchDelivery（探测结果由 IPC 层异步取好传进来；
    // 没传 = 没核实到，措辞退回最保守的那种，绝不因为"不知道"就说成功）。
    const verdict = describeDispatchDelivery(consumer, bodyText.length)
    // 2026-11-24（暮雨第 1 条）：从日志派出去的活，成功后自动把**这条**日志标进行中。
    // ⚠ 只动自己，不动 attached 全组；失败不影响派单结果，但要如实回传。
    const logStatus = markLogRunningAfterDispatch(logId)
    return {
      ok: true,
      path: p,
      projectId: String(r.projectId),
      chars: bodyText.length,
      missing: r.missing || [],
      at,
      kind,
      delivery: verdict.delivery,
      deliveryHint: verdict.hint,
      consumerPresent: verdict.consumerPresent,
      logId: String(logId || ''),
      logRunning: logStatus.running,
      logRunningError: logStatus.error,
      enabled: true,
      reason: 'ok',
      today: gate.today,
      dailyCap: gate.dailyCap,
      leftToday: gate.leftToday,
      // 倒计时长度以**共享设置**为准：设置页改成 120 秒，这里立刻是 120 秒。
      cooldownMs: settings.cooldownSec * 1000,
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}
