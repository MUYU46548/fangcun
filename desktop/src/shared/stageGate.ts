/**
 * 阶段推进闸门（0.6.0 P4）—— “这一格能不能标完成 / 跨到下一格”的纯逻辑
 *
 * 为什么单独成文件（与 `shared/blockers.ts` / `shared/dailyBand.ts` 同一理由）：
 * “过没过”是**口径**，不是页面装饰。写进组件里就只有起得来界面的人能验；
 * 放 shared/ 就能用 Node 直接跑，反例也能钉死。
 *
 * 三条硬口径：
 *  ① **全部通过才放行**：任何一条 fail 或 unknown 都挡住（fail-closed）。
 *  ② **没有判据 = 没过**：空清单不算"没东西要验"，那叫"没验过"。
 *  ③ **打回要带 diff**：每条被挡的判据都要附上**原文 + 实际值** ——
 *     只说"未过"等于让人回去猜是哪条、差多少。
 *
 * unknown 与 fail 在结果里分开计数（`未过` / `未判定`），但**同样挡路**：
 * 超时、未知前缀都不是"通过"，也不该被说成"判据不成立"。
 */

export type GateCheckState = 'pass' | 'fail' | 'unknown'

/** 闸门只看这几项；`CheckResult`（runner）可以直接传进来（结构兼容） */
export interface GateCheck {
  raw: string
  state: GateCheckState
  /** 一句话结论（runner 的 detail；打回理由里拿它当"实际值"的兜底） */
  detail?: string
  evidence?: {
    /** num: 实际数字 */
    actual?: number | string | null
    /** cmd: 退出码 */
    exitCode?: number | null
    timedOut?: boolean
    [k: string]: any
  }
}

export interface BlockedCheck {
  raw: string
  state: 'fail' | 'unknown'
  /** 给打回理由用：实际值 / 退出码 / 结论 */
  actual: string
}

export interface StageGateResult {
  /** 全部通过才 true（空清单也是 false） */
  canAdvance: boolean
  total: number
  passed: number
  failed: number
  unknown: number
  blocked: BlockedCheck[]
  /** 写进 `- 打回理由:` 的 diff（canAdvance 时为空串） */
  diff: string
  /** 一句话（界面/报告直接用） */
  reason: string
}

function actualOf(c: GateCheck): string {
  const ev = c.evidence || {}
  if (ev.actual !== undefined && ev.actual !== null && ev.actual !== '') {
    return `实际值 ${ev.actual}`
  }
  if (ev.exitCode !== undefined && ev.exitCode !== null) {
    return `实际值：退出码 ${ev.exitCode}`
  }
  if (ev.timedOut) return '实际值：超时（未判定）'
  const d = String(c.detail || '').trim()
  if (d) return `实际：${d}`
  return c.state === 'unknown' ? '实际值：未判定' : '实际值：未给出'
}

/**
 * 判定一张阶段卡能否推进。
 * @param checks 判据结果（顺序与卡上一致；runner 的 CheckResult[] 可直接传）
 */
export function evaluateStageGate(checks: GateCheck[]): StageGateResult {
  const list = (Array.isArray(checks) ? checks : []).filter((c) => c && typeof c.raw === 'string')
  const passed = list.filter((c) => c.state === 'pass').length
  const failed = list.filter((c) => c.state === 'fail').length
  const unknown = list.filter((c) => c.state === 'unknown').length
  const blocked: BlockedCheck[] = list
    .filter((c) => c.state !== 'pass')
    .map((c) => ({ raw: c.raw, state: c.state === 'unknown' ? 'unknown' : 'fail', actual: actualOf(c) }))

  const total = list.length
  const allPass = total > 0 && passed === total
  if (allPass) {
    return {
      canAdvance: true, total, passed, failed, unknown, blocked: [],
      diff: '', reason: `${total} 条判据全过 —— 可以完成这一格`,
    }
  }

  if (!total) {
    const reason = '这张卡没有判据 —— 没判据 = 没验过，不许跨格'
    return {
      canAdvance: false, total: 0, passed: 0, failed: 0, unknown: 0, blocked: [],
      diff: reason, reason,
    }
  }

  const head = `判据未过：${failed} 条未过 / ${unknown} 条未判定 / 共 ${total} 条`
  const rows = blocked.map((b, i) => {
    const tag = b.state === 'unknown' ? '未判定' : '未过'
    return `${i + 1}. “${b.raw}”→ ${b.actual}（${tag}）`
  })
  const diff = [head].concat(rows).join('\n')
  const reason = unknown
    ? `还有 ${failed + unknown} 条判据没通过（其中 ${unknown} 条未判定）—— 不许跨格`
    : `还有 ${failed} 条判据未过 —— 不许跨格`
  return { canAdvance: false, total, passed, failed, unknown, blocked, diff, reason }
}
