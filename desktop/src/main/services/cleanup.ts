/**
 * 整理体检（2026-10-30，卡 task-20261025-006 剩下的两件之一）
 *
 * 用户原话：“看板任务一堆待办，很多我都不知道到底做了没有”。
 * 上一轮只做到“能看见 0 引用”，这一件把它接进**整理流程**：一次体检摊开两批卡 ——
 *   ① 没人碰过（近 N 天 0 引用）② 被驳回后没人管（`shared/rework.ts` 的口径）。
 *
 * 三条不许越界（卡 20261027-003 的推理，用户当场否掉了"排序"用法）：
 *  ① **这是清理候选，不是优先级**。“不动”是多因的：没空做 / 已被更强实现替代 / 前提没成立，
 *     三者在计量里长得一模一样 —— 从中推"重要程度"是伪造因果。
 *  ② **只给动作**：回看板筛出来（核一下还要不要）/ 看返工台（退回或归档）。不自动删、不自动改。
 *  ③ **口径必须跟着数字走**：只算 agent 经 MCP 读卡，界面里点开不算；计量没开始时数字不算数。
 *
 * 纯函数（输入注入），所以 `e2e-cleanup.cjs` 能用真数据根直接跑。
 */
import { pickNeverRead, type NeverReadInput, type NeverReadResult } from '../../shared/neverRead'
import { pickRework, type ReworkRow } from '../../shared/rework'
import { parseTime } from '../../shared/time'

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

export interface CleanupStalledRow { id: string; title: string; hours: number }

export interface CleanupStalledBrief {
  count: number
  thresholdHours: number
  /** 前几条样例（卡最久的排前面） */
  rows: CleanupStalledRow[]
  text: string
}

export interface CleanupReport {
  days: number
  neverRead: NeverReadResult
  rework: CleanupReworkBrief
  stalled: CleanupStalledBrief
  /** 一句话总览（两个数字必须同时出现） */
  text: string
  /** 口径（界面必须与数字并排显示，不许只给数字） */
  rule: string
}

export const CLEANUP_RULE =
  '口径：没人碰过只算 agent 经 MCP 读卡（你在界面里点开不算）；“挂着进行中”只说明这个任务文件没被写过，'
  + '不代表有人在干、也不代表没人干 —— 它只是提醒你核一下：活干完了就关单，不干了就退回待办。'
  + '这三栏都是清理候选，不是优先级，也不代表"不重要"。'

/** “挂着进行中多久算久” —— 与原先通知的判据一致，改的只是"在哪儿说" */
export const STALLED_HOURS = 24

/**
 * 挂着“进行中”但很久没动（2026-11-05 从通知中心**挪出来**）
 *
 * 暮雨原话：“任务没动静我又能做什么？我什么都做不了。”“那东西一直都要做，但是没人做。”
 * 挪的理由不是判据不准，是**它宣称的东西超出了方寸能看见的范围**：
 * 方寸只知道"这个 .md 文件没被写"，而"没被写"至少三种原因 ——
 *   ① 活干完了没人关单（实例：卡里写着 commit + 57/57 通过，状态还挂“进行中”）
 *   ② 在别的项目忙 ③ 真的没人接手
 * 三种原因你要做的事完全不同，压成一句"没人接手"就是在替你下结论，
 * 而方寸**没有能力**观测外部 agent 在不在干活（`ai-trace.jsonl` 只记方寸自己发起的调用）。
 * 所以它现在只是整理体检里的一栏：**你主动点开才看**，不占未读数、不弹、不催。
 */
export function pickStalled(
  tasks: CleanupTask[],
  opts: { thresholdHours?: number; now?: number } = {}
): CleanupStalledBrief {
  const thresholdHours = Number.isFinite(Number(opts.thresholdHours))
    ? Math.max(1, Math.floor(Number(opts.thresholdHours)))
    : STALLED_HOURS
  const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now()
  const rows: CleanupStalledRow[] = []
  for (const t of tasks) {
    // 只认精确的“进行中”：空状态不是进行中（同 boardCards.openOnly 的口径，别把没填当在做）
    if (String(t.status || '').trim() !== '进行中') continue
    const at = Number(parseTime((t as any).updated))
    // 时间解析不出来就跳过 —— 不拿 mtime 兜、不猜。“算不出来”不该变成“卡住了”
    if (!Number.isFinite(at) || at <= 0) continue
    const hours = Math.floor((nowMs - at) / 3600_000)
    if (hours < thresholdHours) continue
    rows.push({ id: t.id, title: t.title || t.id, hours })
  }
  rows.sort((a, b) => b.hours - a.hours)   // 卡最久的排前面：它最可能是“忘了关单”
  return {
    count: rows.length,
    thresholdHours,
    rows: rows.slice(0, 5),
    text: `挂着“进行中”超过 ${thresholdHours} 小时没动`,
  }
}

export function buildCleanupReport(
  tasks: CleanupTask[],
  stats: Record<string, any>,
  opts: { days?: number; windowEvents?: number; now?: number } = {}
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
  const stalled = pickStalled(tasks, { thresholdHours: STALLED_HOURS, now: opts.now })
  const text = `没人碰过 ${neverRead.count} 张 · 驳回后没人管 ${rework.count} 张 · 挂着进行中没动 ${stalled.count} 张`
  return { days, neverRead, rework, stalled, text, rule: CLEANUP_RULE }
}
