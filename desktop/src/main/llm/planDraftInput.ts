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
import { loadTasks } from '../data'
import { extractMirror } from '../../shared/planMirror'
import type { PlanDraftInput, DraftTaskRef } from './planDraft'

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
  }
}

/** 直接按数据根读一遍再组装（给 IPC / MCP 用） */
export function buildPlanDraftInputFromDisk(opts: BuildInputOptions): PlanDraftInput {
  return buildPlanDraftInput(loadTasks() as any[], opts)
}
