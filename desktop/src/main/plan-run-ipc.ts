/**
 * 作战计划 · 跑判据 / 推进一格（0.6.0 P4 的界面入口）
 *
 * 为什么单开一个文件，而不是塞进 `plan-ipc.ts`：
 * P3 留了一条守卫 ——「打开计划卡不许顺手跑命令」（`plans:get` 那个 handler 里不许出现执行器）。
 * 把执行器写进同一个文件，那条守卫就只能退化成"整文件正则不许命中"，
 * 于是任何一次正常改动都会误伤。拆成两个文件，**结构本身就是那道守卫**：
 *   · `plan-ipc.ts`     读 / 裁决（不碰执行器）
 *   · `plan-run-ipc.ts` 跑判据 / 推进（执行器只在这里）
 *
 * 三条口径：
 *  ① **跑判据是显式动作**：只有人点「跑判据」或「推进这一格」才起进程；
 *     打开计划卡（`plans:get`）永远不会跑任何东西。
 *  ② **闸门在数据层再拦一道**：可否跨格由 `shared/stageGate` 算（全过才放行），
 *     写回由 `data/plans.advanceStage` 再判一次 —— 界面绕不过去，MCP 也绕不过去。
 *  ③ **被闸门挡下不是错误**：`ok:true + advanced:false + blocked:true`，
 *     和"通道本身失败"（`ok:false`）分开说。否则界面上「判据没过」会被渲染成"出错了"。
 *
 * 判据里的相对路径以**仓库根**为根：默认取数据目录（方寸的 task-data 与 desktop/ 同根），
 * 也可以在入参显式给 `repo`（数据根挪到别处时用）。
 */
import { guardedHandle } from './guarded-ipc'
import { getDataDir } from './data'
import { readPlan, advanceStage, type PlanDoc, type PlanStage } from './data/plans'
import { runCriteria, type CheckResult } from './checks/runner'
import { evaluateStageGate, type StageGateResult } from '../shared/stageGate'

export interface PlanRunInput {
  file?: string
  stageId?: string
  /** 判据相对路径的根（默认 = 数据目录） */
  repo?: string
  /** 单条 cmd 的超时（测试用；上限仍被 runner 夹在 60s） */
  timeoutMs?: number
}

export interface PlanRunSummary {
  file: string
  stageId: string
  status: string
  results: CheckResult[]
  gate: StageGateResult
}

export interface AdvanceOutcome {
  ok: boolean
  /** 真的写成了「完成」 */
  advanced: boolean
  /** 被闸门挡下（判据未过 / 未判定）—— 这是正常业务结果，不是通道故障 */
  blocked: boolean
  error?: string
  gate?: StageGateResult
  results?: CheckResult[]
  status?: string
  evidence?: string
  rejectReason?: string
}

function resolveRepo(repo?: string): string {
  const r = String(repo || '').trim()
  if (r) return r
  try { return getDataDir() } catch { return process.cwd() }
}

/** 读卡 + 定位阶段。失败给一句人能读的话（不抛） */
function loadStage(file: string, stageId: string):
  | { ok: true; doc: PlanDoc; stage: PlanStage }
  | { ok: false; error: string } {
  const doc = readPlan(String(file || ''))
  if (!doc) return { ok: false, error: '计划卡不存在' }
  const id = String(stageId || '')
  const stage = doc.stages.find((s) => s.id === id)
  if (!stage) return { ok: false, error: `找不到阶段 ${id || '(空)'}` }
  return { ok: true, doc, stage }
}

/** 跑一张阶段卡的全部判据并算闸门（只读，不写盘） */
export async function runStageChecks(input: PlanRunInput):
  Promise<{ ok: true; summary: PlanRunSummary } | { ok: false; error: string }> {
  const loaded = loadStage(String(input.file || ''), String(input.stageId || ''))
  // ⚠ tsconfig strict=false：可辨识联合不会因 `!x.ok` 收窄（见 AGENTS 踩坑 5），用 `in` 判
  if ('error' in loaded) return { ok: false, error: loaded.error }
  const summary = await runCriteria(loaded.stage.criteria, {
    root: resolveRepo(input.repo),
    timeoutMs: input.timeoutMs,
  })
  const gate = evaluateStageGate(summary.results)
  return {
    ok: true,
    summary: {
      file: loaded.doc.file,
      stageId: loaded.stage.id,
      status: loaded.stage.status,
      results: summary.results,
      gate,
    },
  }
}

export function registerPlanRunIpcHandlers(): void {
  /** 只跑判据：出逐条三态 + 闸门结论，**不写任何文件** */
  guardedHandle('plans:checks', async (_e, input?: PlanRunInput) => {
    try {
      const r = await runStageChecks(input || {})
      if ('error' in r) return { ok: false, error: r.error }
      const s = r.summary
      return { ok: true, file: s.file, stageId: s.stageId, status: s.status, results: s.results, gate: s.gate }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  /** 跑判据 → 闸门 → 推进（判据全过才写得进「完成」；否则只写「未完成」+ 打回理由） */
  guardedHandle('plans:advance', async (_e, input?: PlanRunInput): Promise<AdvanceOutcome> => {
    try {
      const r = await runStageChecks(input || {})
      if ('error' in r) return { ok: false, advanced: false, blocked: false, error: r.error }
      const s = r.summary
      const adv = advanceStage({ file: s.file, stageId: s.stageId, gate: s.gate })
      // blocked 的判据是**闸门放不放行**，不是 advanceStage 有没有给 error：
      // 「判据未过，不能跨格」本身就是 blocked（正常业务），而「还没裁决」才是 error。
      const gatePassed = !!s.gate.canAdvance
      return {
        ok: true,
        advanced: adv.advanced,
        blocked: !adv.advanced && !gatePassed,
        error: adv.error,
        gate: s.gate,
        results: s.results,
        status: adv.stage?.status || '',
        evidence: adv.stage?.evidence || '',
        rejectReason: adv.stage?.rejectReason || '',
      }
    } catch (e) {
      return { ok: false, advanced: false, blocked: false, error: (e as Error).message }
    }
  })
}
