/**
 * 每日推进面（0.6.0 P2）—— “今天推哪一格”的纯逻辑
 *
 * 这一条带只回答一个问题：**现在该推哪一格，这一格要过哪些判据。**
 * 不让人选（有路线就不用每次重新判断），也只挂日志页顶部 —— 不新增页面、不新增导航。
 *
 * 为什么抽成纯函数（同 `shared/neverRead.ts` 的理由）：
 *   选格规则是**口径**，不是布局。写进组件里就只有"起得来界面"的机器能验它；
 *   放 shared/ 就能用 Node 直接跑，反例也能钉死。
 *
 * 三条硬口径：
 *  ① **只认“已冻结”的阶段卡**（未裁决的格子不许推 —— 那是还没批的计划）。
 *  ② **判据没跑过 ≠ 已通过**（fail-closed）。没有结果就是"未过"，继续停在当前格，
 *     绝不因为"查不到结果"就把这一格当成做完了。
 *  ③ **取序号最小的那张**（P2 在 P3 前面），不按时间、不随机、不看数组顺序 ——
 *     同一份数据跑一百次必须是同一格。
 *
 * 输出恒为 3 行（含空态）：站会三问的最小版 —— 推哪格 / 判据 / 状态。
 */

/** 计划里的一张阶段卡（只需要选格与展示用到的字段） */
export interface DailyStageInput {
  id: string
  title?: string
  status?: string
  criteria?: string[]
  verdict?: string
  /** 缺块（技术方案 / 照抄点 / 判据）—— 缺判据的卡一定不能算过 */
  missing?: string[]
}

/** 一份计划卡（真源 `task-data/plans/<项目id>.md`） */
export interface DailyPlanInput {
  file: string
  title?: string
  stages: DailyStageInput[]
}

/**
 * 判据执行结果（P3 执行器 / P4 写回产物）。
 * 结构：`{ [计划文件]: { [阶段id]: 是否全部通过 } }`。
 * 只有**显式 true** 才算过；false / 缺失都按"未过"处理（fail-closed）。
 */
export type DailyCheckResults = Record<string, Record<string, boolean>>

export type DailyCriteriaKind = 'cmd' | 'str' | 'num' | 'file' | 'other'

export interface DailyBandResult {
  /** ready = 有格子可推；none = 没有冻结的计划；all-passed = 冻结的都已通过 */
  kind: 'ready' | 'none' | 'all-passed'
  file: string
  planTitle: string
  stage: DailyStageInput | null
  /** 阶段序号（P0 → 0）；没有阶段时为 -1 */
  stageIndex: number
  criteriaCount: number
  criteriaKinds: Record<DailyCriteriaKind, number>
  /** 还有多少张阶段卡等你裁决（待裁决 / 未冻结）—— 0 表示没有积压 */
  pendingCount: number
  /** 恒为 3 行（含空态）—— 界面按行渲染，不做二次加工 */
  lines: string[]
  /** 空态/完成态的一句话（ready 时为空串） */
  message: string
}

const FROZEN = '已冻结'
/**
 * “等你裁决”的几种写法（2026-11-02）：
 * 计划卡的状态字段是**它自己的一套词**（已冻结 / 待裁决 / 未冻结 / 完成 / 未完成），
 * 不是任务的 7 态、也不是决策卡的 3 态。此前这一条带只认“已冻结”，
 * 于是 7 张待裁决的卡在唯一的日频入口里一个字都看不到 —— 用户原话“待裁决的东西在哪里？没看见”。
 * 现在它们必须**在条上被数出来**，哪怕今天推的是别的格子。
 */
const PENDING = ['待裁决', '待裁决（未冻结）', '未冻结']

/** `P12` → 12；不是 P 序号 → Infinity（排最后，不猜它排第几） */
export function stageOrdinal(id: string): number {
  const m = /^P(\d+)$/i.exec(String(id ?? '').trim())
  if (!m) return Number.POSITIVE_INFINITY
  const n = Number(m[1])
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY
}

/** 判据前缀：`cmd:` / `str:` / `num:` / `file:` 四类；其余归 other（未知即不认） */
export function criteriaKindOf(text: string): DailyCriteriaKind {
  const m = /^\s*([A-Za-z]+)\s*[:：]/.exec(String(text ?? ''))
  const k = m ? m[1].toLowerCase() : ''
  if (k === 'cmd' || k === 'str' || k === 'num' || k === 'file') return k
  return 'other'
}

function countKinds(criteria: string[]): Record<DailyCriteriaKind, number> {
  const out: Record<DailyCriteriaKind, number> = { cmd: 0, str: 0, num: 0, file: 0, other: 0 }
  for (const c of criteria) out[criteriaKindOf(c)]++
  return out
}

/** 计划显示名：标题优先，否则用文件名（去掉 .md） */
export function planLabel(plan: DailyPlanInput): string {
  const t = String(plan?.title ?? '').trim()
  if (t) return t
  return String(plan?.file ?? '').replace(/\.md$/i, '')
}

/**
 * 选“今天推哪一格”。
 *
 * 规则按优先级：
 *   ① 阶段状态 = 已冻结（其余一律不看）；
 *   ② 判据结果不是显式 true（false / 没跑过 / 没有结果都算未过）；
 *   ③ 阶段序号升序（P0 → P1 → …），同序号按计划文件名，再按原数组顺序；
 *   ④ 取第一张。
 *
 * 不修改传入的数组（调用方可能在同一个数组上反复算）。
 */
export function pickDailyStage(
  plans: DailyPlanInput[],
  results?: DailyCheckResults,
): { plan: DailyPlanInput; stage: DailyStageInput; index: number } | null {
  const list = Array.isArray(plans) ? plans : []
  const res = results && typeof results === 'object' ? results : {}
  const candidates: Array<{ plan: DailyPlanInput; stage: DailyStageInput; index: number }> = []
  for (const plan of list) {
    if (!plan || !Array.isArray(plan.stages)) continue
    plan.stages.forEach((stage, index) => {
      if (!stage || !String(stage.id ?? '').trim()) return
      if (String(stage.status ?? '').trim() !== FROZEN) return
      const perPlan = res[plan.file]
      const passed = perPlan ? perPlan[stage.id] : undefined
      if (passed === true) return
      candidates.push({ plan, stage, index })
    })
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => {
    const oa = stageOrdinal(a.stage.id)
    const ob = stageOrdinal(b.stage.id)
    if (oa !== ob) return oa < ob ? -1 : 1
    const fa = String(a.plan.file ?? '')
    const fb = String(b.plan.file ?? '')
    if (fa !== fb) return fa < fb ? -1 : 1
    return a.index - b.index
  })
  return candidates[0]
}

/** 判据行：`判据 3 条（cmd 1 · str 1 · num 1）：① cmd: … ｜ ② str: …` */
function criteriaLine(stage: DailyStageInput): string {
  const criteria = Array.isArray(stage.criteria) ? stage.criteria.map((c) => String(c ?? '').trim()).filter(Boolean) : []
  if (!criteria.length) {
    const missing = Array.isArray(stage.missing) && stage.missing.includes('判据')
    return missing
      ? '判据 0 条 —— 这张卡缺“判据”，不能算过'
      : '判据 0 条 —— 没有判据就等于没法验收，不能算过'
  }
  const kinds = countKinds(criteria)
  const kindText = (['cmd', 'str', 'num', 'file'] as DailyCriteriaKind[])
    .filter((k) => kinds[k] > 0)
    .map((k) => `${k} ${kinds[k]}`)
    .join(' · ')
  const items = criteria
    .map((c, i) => `${'①②③④⑤⑥⑦⑧⑨⑩'[i] || String(i + 1) + '.'} ${c}`)
    .join(' ｜ ')
  return `判据 ${criteria.length} 条${kindText ? `（${kindText}${kinds.other ? ` · other ${kinds.other}` : ''}）` : ''}：${items}`
}

/**
 * 组装那一条带。**任何输入都返回 3 行**（含空态）—— 界面不需要再判断"有几行"。
 */
export function buildDailyBand(plans: DailyPlanInput[], results?: DailyCheckResults): DailyBandResult {
  const list = Array.isArray(plans) ? plans : []
  const picked = pickDailyStage(list, results)
  const frozenTotal = list.reduce((n, p) => {
    if (!p || !Array.isArray(p.stages)) return n
    return n + p.stages.filter((s) => s && String(s.status ?? '').trim() === FROZEN).length
  }, 0)
  // 待裁决的卡数 —— 必须始终在条上说出来，否则它们只存在于计划文件里，界面上一眼都看不到
  const pendingCount = list.reduce((n, p) => {
    if (!p || !Array.isArray(p.stages)) return n
    return n + p.stages.filter((s) => s && PENDING.includes(String(s.status ?? '').trim())).length
  }, 0)

  if (!picked) {
    if (!frozenTotal) {
      const lines = pendingCount
        ? [
            `有 ${pendingCount} 张阶段卡等你裁决`,
            '到“项目页 → 作战计划”逐张点“通过”冻结 —— 没冻结的格子推不动',
            '冻结之后，这里每天告诉你推哪一格、这一格要过哪些判据',
          ]
        : [
            '本仓还没有冻结的作战计划',
            '到“项目页 → 作战计划”点“通过”冻结一张阶段卡',
            '冻结之后，这里每天告诉你推哪一格、这一格要过哪些判据',
          ]
      return {
        kind: 'none', file: '', planTitle: '', stage: null, stageIndex: -1,
        criteriaCount: 0, criteriaKinds: { cmd: 0, str: 0, num: 0, file: 0, other: 0 },
        pendingCount, lines, message: lines[0],
      }
    }
    const lines = [
      '已冻结的阶段都过了判据',
      pendingCount
        ? `还有 ${pendingCount} 张卡待裁决 —— 去项目页裁决下一张`
        : '今天没有要推的格子 —— 去项目页裁决下一张',
      '本仓当前没有“未过”的已冻结阶段',
    ]
    return {
      kind: 'all-passed', file: '', planTitle: '', stage: null, stageIndex: -1,
      criteriaCount: 0, criteriaKinds: { cmd: 0, str: 0, num: 0, file: 0, other: 0 },
      pendingCount, lines, message: lines[0],
    }
  }

  const { plan, stage, index } = picked
  const name = planLabel(plan)
  const criteria = Array.isArray(stage.criteria) ? stage.criteria.map((c) => String(c ?? '').trim()).filter(Boolean) : []
  const kinds = countKinds(criteria)
  const status = String(stage.status ?? '').trim() || '未填状态'
  const verdict = String(stage.verdict ?? '').trim()
  const rec = results && results[plan.file] ? results[plan.file][stage.id] : undefined
  const execText = rec === false
    ? '判据已跑过：未过'
    // 2026-11-03：P3/P4 早就落地了，旧文案还写着"P3 之后会自动判定"——那是假的，
    // 判据不会自己跑（跑测试要起进程）。这里直接给它该去的地方与两个按钮。
    : '判据尚未执行 —— 到“项目页 → 作战计划”点“⚙ 跑判据”；全过后点“▶ 推进这一格”'
  const lines = [
    `今天推：${name} · ${stage.id} · ${String(stage.title ?? '').trim() || '(无标题)'}`,
    criteriaLine(stage),
    `状态：${status}${verdict ? ` · 裁决 ${verdict}` : ''} · ${execText}`
      + (pendingCount ? ` · 另有 ${pendingCount} 张待裁决（项目页 → 作战计划）` : ''),
  ]
  return {
    kind: 'ready',
    file: String(plan.file ?? ''),
    planTitle: name,
    stage,
    stageIndex: stageOrdinal(stage.id),
    criteriaCount: criteria.length,
    criteriaKinds: kinds,
    pendingCount,
    lines,
    message: '',
  }
}
