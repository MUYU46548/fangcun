/**
 * 把「方寸自己的真实数据」组装成规划输入（2026-11-02）
 *
 * 存在的理由：`generatePlanDraft` 早就写好了，却**从来没有调用方** ——
 * 它一直是"数据层/生成器入口"，没有界面按钮、没有 MCP 工具，所以方寸从来没有真的规划过自己。
 *
 * 卡 task-20261027-003 列的第三条根因是"输入只有标题层，正文一个字都不进"，
 * 这里就是补那一条：把每张卡的「方案」与「结果记录」原文取出来喂进去。
 *
 * 三条口径：
 *  ① **只读**：不写任何卡、不改任何状态。
 *  ② **正文有上限**：中位方案 261 字 / 结果 617 字，全塞会爆上下文。
 *     所以未结卡给正文，已完成卡只给标题（已完成的细节对"下一步做什么"帮助小）。
 *  ③ **无正文就说没有**：取不到就留空，绝不编一段。
 */
import { loadTasks, parseRegistry } from '../data'
import { loadDecisions } from '../data/decisions'
import { effectiveAcceptances } from '../data/questionnaires'
import { getPolicy } from '../services/policies'
import { readProjectDocs } from '../services/repoDocs'
import { extractMirror } from '../../shared/planMirror'
import { isUnjudged } from '../../shared/coreVerdict'
import type { PlanDraftInput, DraftTaskRef, DraftDecisionRef, PlanDraftRepoDocs } from './planDraft'

export interface BuildInputOptions {
  project: string
  /** 未结卡最多带几张（默认 24） */
  maxOpen?: number
  /** 最近完成的卡最多列几张标题（默认 8） */
  maxDone?: number
}

/** 未结 = 这些状态；空状态算未结（没填 ≠ 做完） */
const OPEN = new Set(['', '草稿', '待审批', '待办', '进行中', '待验收'])

export function buildPlanDraftInput(rawTasks: any[], opts: BuildInputOptions): PlanDraftInput {
  const want = String(opts.project || '').trim()
  // ⚠ 这里必须是**英文键**：`loadTasks()` 会把 YAML 的中文键名映射成 fm.project / fm.status / fm.title。
  //   按 fm.项目 写会全部读到空串（AGENTS.md 记过同一个坑：never-read 测试第一版就是这么错的）。
  const projOf = (t: any) => {
    const raw = t?.fm?.project
    const first = Array.isArray(raw) ? raw[0] : raw
    return String(first || '').trim()
  }
  const mine = (rawTasks || []).filter((t) => projOf(t) === want)

  const statusOf = (t: any) => String(t?.fm?.status || '').trim()
  const open = mine.filter((t) => OPEN.has(statusOf(t)))
  const done = mine.filter((t) => statusOf(t) === '完成')

  // 未结卡按"最久没动"排前面 —— 那才是真正在等决策的
  const touch = (t: any) => String(t?.fm?.updated || t?.fm?.created || '')
  open.sort((a, b) => touch(a).localeCompare(touch(b)))

  const refs: DraftTaskRef[] = []
  for (const t of open.slice(0, opts.maxOpen ?? 24)) {
    const pair = extractMirror(String(t?.body || ''))
    refs.push({
      id: String(t?.id || ''),
      title: String(t?.fm?.title || ''),
      status: statusOf(t) || '未填',
      plan: pair.plan.text,
      actual: pair.actual.text,
    })
  }
  // 已完成的只给标题：让模型知道"这些已经做过"，避免把做过的再列一遍
  for (const t of done.slice(-(opts.maxDone ?? 8))) {
    refs.push({ id: String(t?.id || ''), title: String(t?.fm?.title || ''), status: '完成' })
  }

  return {
    project: want,
    projectName: want,
    tasks: refs,
    decisions: effectiveDecisions(want),
    rulings: effectiveAcceptances(want),
    // 2026-11-10：这三样此前**从磁盘组装时一个都没带** —— 草案却在自我介绍里写
    // “按产品定义 + 投入产出账 + 现有卡与 git 事实起草”（假话）。
    // 现在把能拿到的真带上：立项契约（policies/<id>.md）与仓库根（判据现状体检要用）。
    definition: charterText(want),
    repoRoot: repoOf(want),
    // 2026-11-12：核心判词一起带上。空串 = 未判，内容量闸会按"未判"处理
    // （只许最小原型）—— 这是"核心没验过就别铺量"那张闸的唯一输入。
    coreVerdict: coreVerdictOf(want),
  }
}

/** 立项契约原文（任务 / 目标 / 场景 / 边界）—— 取不到就空串，绝不编一段 */
function charterText(project: string): string {
  try {
    const p = getPolicy(project)
    if (!p) return ''
    const rows: string[] = []
    if (String(p.mission || '').trim()) rows.push(`任务：${p.mission}`)
    if (String(p.goal || '').trim()) rows.push(`目标：${p.goal}`)
    if (String(p.scenario || '').trim()) rows.push(`场景：${p.scenario}`)
    if (String(p.boundary || '').trim()) rows.push(`边界：${p.boundary}`)
    return rows.join('\n')
  } catch {
    return ''
  }
}

/** 项目仓库根（判据现状体检用）；没登记 repo 就空串，不猜路径 */
function repoOf(project: string): string {
  try {
    const hit = (parseRegistry() || []).find((r: any) => String(r?.id || '') === project)
    return String(hit?.repo || '').trim()
  } catch {
    return ''
  }
}

/**
 * 核心判词（2026-11-12）：暮雨认为这个项目的核心玩法/核心用途现在是什么水平。
 *
 * 为什么单独取：内容量闸要靠它决定"能不能铺几小时内容"。
 * 取不到就返回空串 = 未判 —— 闸会按"未判"处理（只许最小原型），
 * **绝不默认成"没问题"**。
 */
function coreVerdictOf(project: string): string {
  try {
    const p = getPolicy(project)
    const raw = String((p as any)?.coreVerdict || '').trim()
    // 骨架 / 空 / 明说未判 => 一律当"没判过"。
    // 判定收在 shared/coreVerdict#isUnjudged 一处（此前这里自己写了一遍 `/^>\s*未判/`，
    // 与 App.vue 里那份重复 —— 改一处忘一处正是本项目的常见病）。
    if (isUnjudged(raw)) return ''
    return raw
  } catch {
    return ''
  }
}

/**
 * 有效决策（本项目 + 全局）—— 2026-11-09 补。
 *
 * 只列「有效」：已撤销 / 已合并不许进上下文（否则模型会把撤销过的当现行规矩）。
 * 最多 12 条：决策卡会越来越长，全塞会挤掉卡正文这个更重要的证据。
 */
function effectiveDecisions(project: string): DraftDecisionRef[] {
  try {
    return loadDecisions()
      .filter((d) => String(d.状态 || '') === '有效'
        && (!String(d.项目 || '').trim() || String(d.项目) === project))
      .sort((a, b) => String(b.日期 || '').localeCompare(String(a.日期 || '')))
      .slice(0, 12)
      .map((d) => ({
        id: d.id, 内容: d.内容, 日期: d.日期, 出处: d.出处, 备注: d.备注,
      }))
  } catch {
    return []
  }
}

/**
 * 项目仓库的**真实文档**（2026-11-14 · 长 Loop P2-3）。
 *
 * 为什么要有这一步：长 Loop 的 §3 第一条病灶就是「只读自己的账本，不读项目现实」——
 * 计划器的输入只有方寸的卡 / 决策 / 验收线，对"这个项目仓库里 README 怎么说、
 * ROADMAP 排到哪、最近动过哪些文档"一无所知。于是"规划"退化成从卡标题猜方向。
 *
 * 三条纪律（与 repoDocs 服务一致，这里是它的规划器适配层）：
 *  ① **只读**：只调 readProjectDocs（它自己保证只 read + git log），不写任何东西；
 *  ② **缺就说缺**：没登记 repo / 仓库里没 README → 记进 `missing`，**不造空壳**；
 *  ③ **只给摘要**：README/ROADMAP 只要标题 + 一句话，最近提交只留 5 条 ——
 *     全文塞进去会挤掉卡正文这个更重要的证据。
 *
 * 失败一律返回 null（不抛）：读仓库失败不能把整个规划流程带崩，
 * 但也不能装作读到了 —— 所以 null 时计划器会写一条 `repo:docs` 缺失提示。
 */
async function repoDocsOf(project: string): Promise<PlanDraftRepoDocs | null> {
  const repo = repoOf(project)
  if (!repo) {
    // 没登记仓库根 = 这项目不在本机（或根本没登记 repo）。
    // ⚠ 仍然返回一个**带 missing 的对象**，而不是 null：
    //   null 表示"读失败了"，missing 表示"本来就没有"——这两件事在计划器里话术不同。
    return { repo: '', readme: null, roadmap: null, recentDocsCommits: [], missing: ['项目没登记仓库根，读不到项目现实（只能靠方寸自己的账本）'] }
  }
  try {
    const r = await readProjectDocs(repo)
    const missing: string[] = []
    if (!r.readme) missing.push('仓库里没有 README（或读不出来）')
    if (!r.roadmap) missing.push('仓库里没有 ROADMAP（或读不出来）')
    if (!r.docsCommits.length) missing.push('最近没有动过 docs/ 的提交')
    if (r.note) missing.push(r.note)
    return {
      repo,
      readme: r.readme ? { title: r.readme.title, excerpt: r.readme.excerpt } : null,
      roadmap: r.roadmap ? { title: r.roadmap.title, excerpt: r.roadmap.excerpt } : null,
      recentDocsCommits: r.docsCommits.slice(0, 5).map((c) => ({
        sha: String(c.hash || '').slice(0, 7), date: c.date, subject: c.subject,
      })),
      missing,
    }
  } catch (err: any) {
    // 读失败也要说出来（不许静默当"没有文档"）——但带 null 区别于"本来就缺"
    return {
      repo,
      readme: null, roadmap: null, recentDocsCommits: [],
      missing: ['读仓库文档失败：' + String(err?.message || err)],
    }
  }
}

/** 直接按数据根读一遍再组装（给 IPC / MCP 用） */
export function buildPlanDraftInputFromDisk(opts: BuildInputOptions): PlanDraftInput {
  return buildPlanDraftInput(loadTasks() as any[], opts)
}

/**
 * 同上，但**真去读项目仓库**（2026-11-14 · P2-3）。
 *
 * ⚠ 为什么另开一个 async 版本而不是把原函数改成 async：
 *   原函数被 `e2e-plan-draft` / `e2e-context-pack` 等纯同步断言直接调，
 *   改签名会把那些用例一起打回重写；而"读仓库"本来就该是可选增强。
 *   所以：同步版保持原样（老行为零变化），异步版多带一份 repoDocs。
 */
export async function buildPlanDraftInputFromDiskWithRepo(opts: BuildInputOptions): Promise<PlanDraftInput> {
  const input = buildPlanDraftInputFromDisk(opts)
  input.repoDocs = await repoDocsOf(opts.project)
  return input
}
