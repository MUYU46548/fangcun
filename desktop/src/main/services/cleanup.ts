/**
 * 整理体检（2026-10-30，卡 task-20261025-006 剩下的两件之一）
 *
 * 用户原话：「看板任务一堆待办，很多我都不知道到底做了没有」。
 * 上一轮只做到「能看见 0 引用」，这一件把它接进**整理流程**：一次体检摊开两批卡 ——
 *   ① 没人碰过（近 N 天 0 引用）② 被驳回后没人管（`shared/rework.ts` 的口径）。
 *
 * 三条不许越界（卡 20261027-003 的推理，用户当场否掉了"排序"用法）：
 *  ① **这是清理候选，不是优先级**。「不动」是多因的：没空做 / 已被更强实现替代 / 前提没成立，
 *     三者在计量里长得一模一样 —— 从中推"重要程度"是伪造因果。
 *  ② **只给动作**：回看板筛出来（核一下还要不要）/ 看返工台（退回或归档）。不自动删、不自动改。
 *  ③ **口径必须跟着数字走**：只算 agent 经 MCP 读卡，界面里点开不算；计量没开始时数字不算数。
 *
 * 纯函数（输入注入），所以 `e2e-cleanup.cjs` 能用真数据根直接跑。
 */
import { pickNeverRead, type NeverReadInput, type NeverReadResult } from '../../shared/neverRead'
import { pickRework, type ReworkRow } from '../../shared/rework'

/** 任务视图 + 结果记录 / 独立驳回理由 */
export interface CleanupTask extends NeverReadInput {
  result_log?: string
  reject_reason?: string
}

export interface CleanupReworkBrief {
  count: number
  oldestDays: number
  text: string
  rows: ReworkRow[]
}

export interface CleanupReport {
  days: number
  neverRead: NeverReadResult
  rework: CleanupReworkBrief
  /** 一句话总览（两个数字必须同时出现） */
  text: string
  /** 口径（界面必须与数字并排显示，不许只给数字） */
  rule: string
}

export const CLEANUP_RULE =
  '口径：没人碰过只算 agent 经 MCP 读卡（你在界面里点开不算）；它只是清理候选，不是优先级，也不代表"不重要"。'

export function buildCleanupReport(
  tasks: CleanupTask[],
  stats: Record<string, any>,
  opts: { days?: number; windowEvents?: number } = {}
): CleanupReport {
  const days = Number.isFinite(Number(opts.days)) ? Math.max(0, Math.floor(Number(opts.days))) : 30
  const windowEvents = Number.isFinite(Number(opts.windowEvents)) ? Math.max(0, Math.floor(Number(opts.windowEvents))) : 0
  const neverRead = pickNeverRead(tasks as never, stats as never, { days, windowEvents })
  const rw = pickRework(tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    updated: t.updated,
    result_log: t.result_log,
    reject_reason: t.reject_reason,
  })))
  const rework: CleanupReworkBrief = {
    count: rw.count,
    oldestDays: rw.oldestDays,
    text: rw.text,
    rows: rw.rows.slice(0, 5),
  }
  const text = `没人碰过 ${neverRead.count} 张 · 驳回后没人管 ${rework.count} 张`
  return { days, neverRead, rework, text, rule: CLEANUP_RULE }
}
