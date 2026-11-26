/**
 * 规划派单任务书（2026-11-26）
 *
 * 为什么要有这个纯逻辑模块：
 *   · 两种规划模式（定向 / 全项目）对 agent 的**落地方式**完全不同，而这段规矩
 *     不能再散落在提示词、界面文案、文档三处各写一遍 —— 本仓反复栽在"三份口径"上；
 *   · 它要能**离线测**：marker 会不会把注释提前闭合、focus 超长、定向为空，
 *     这些都是"发出去才发现"的错，必须在 Node 里先断言。
 *
 * 边界：
 *   · 这里只生成**文本**，不发派单、不碰文件、不调 IPC；
 *   · 目标 `<project>` 的上下文包仍由 `contextPack.ts` 拼，本模块的输出只做 `prefix`；
 *   · 产物落地规则写死在任务书里（见下方三段），因为用户 2026-11-26 已拍板：
 *     ① 定向规划要有「规划备忘」这个家（不能只塞任务卡）；
 *     ② 全项目规划没已批准澄清卷时**先出卷**，不许落任务卡替代；
 *     ③ 全项目规划的阶段**一开始就逐格提成**（`stage_plan_propose`），
 *        不许先攒整份草案再 `plan_submit` —— 用户的评价是"只会丢东西"。
 */

export const PLAN_MODES = ['targeted', 'full'] as const
export type PlanMode = typeof PLAN_MODES[number]

export const PLAN_MODE_LABELS: Record<PlanMode, string> = {
  targeted: '定向规划',
  full: '全项目规划',
}

/** 引导词上限：够写清一块范围，又不至于把整份任务书变成另一篇文档 */
export const PLAN_FOCUS_MAX = 500

export interface PlanDispatchInput {
  project: string
  projectName?: string
  mode: PlanMode
  focus?: string
  /** `YYYY-MM-DD`；不传 = 取运行环境的本地日期（测试必须传，否则断言会随日期漂） */
  today?: string
}

export interface PlanFocusResult {
  ok: boolean
  focus: string
  error?: string
}

/**
 * 归一 / 校验定向引导词。
 *
 * ⚠ 三条拒绝都是**安全点**，不是吹毛求疵：
 *   · `-->`：任务书开头是一段 HTML 注释形状的 marker；提前闭合会把后面的正文
 *     变成注释外的自由文本（旧插件/展示层都会读错）；
 *   · 换行：marker 是逐行 `key: value`，换行等于往里面插新字段；
 *   · 超长：引导词会进 marker 与任务书，500 字已经能写清一块范围，再多就是规划本身了。
 */
export function normalizePlanFocus(raw: unknown): PlanFocusResult {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n').trim()
  if (!text) return { ok: true, focus: '' }
  if (text.includes('-->') || text.includes('<!--')) {
    return { ok: false, focus: text, error: '引导词里不能出现 HTML 注释标记（<!-- / -->）' }
  }
  if (text.includes('\n')) return { ok: false, focus: text, error: '引导词只能写一行（换行会把派单标记拆坏）' }
  if (text.length > PLAN_FOCUS_MAX) {
    return { ok: false, focus: text, error: `引导词太长（${text.length} 字，上限 ${PLAN_FOCUS_MAX} 字）` }
  }
  return { ok: true, focus: text }
}

/** 本地日期（不用 toISOString —— 那会把东八区晚上 8 点写成前一天的 UTC 日期） */
export function localDay(now: Date = new Date()): string {
  const d = now
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 派单正文开头的模式标记。
 *
 * 形状与设计卡一致（`fc-plan v1` + 逐行 key: value）。新插件读它、剥掉它、
 * 按模式收窄话术；旧插件不认识也只是把它当正文显示，不会崩。
 */
export function buildPlanMarker(mode: PlanMode, focus = ''): string {
  const m = PLAN_MODES.includes(mode) ? mode : 'full'
  const f = m === 'targeted' ? String(focus || '').trim() : ''
  return ['<!-- fc-plan v1', `mode: ${m}`, `focus: ${f}`, '-->'].join('\n')
}

function projectLabel(project: string, projectName?: string): string {
  const id = String(project || '').trim()
  const name = String(projectName || '').trim()
  return name && name !== id ? `${id}（${name}）` : id
}

/**
 * 全项目规划的任务书。
 *
 * 为什么把"先出卷 / 逐格提成"写在这一层而不是只写插件提示词：
 *   · 这是**方寸**的产品规则（谁有卷、产什么卡，方寸最清楚）；
 *   · 派单正文在签名范围内、并且会原样进会话 —— 新插件按它执行，
 *     旧插件也能读到（只是多了它自己那段旧话术，任务书第一句就写明"以本任务书为准"）。
 */
export function buildFullPlanTaskBook(input: PlanDispatchInput): string {
  const pid = String(input.project || '').trim()
  const label = projectLabel(pid, input.projectName)
  const day = String(input.today || '').trim() || localDay()
  return [
    buildPlanMarker('full'),
    '',
    `【方寸 · 全项目规划】项目：${label} · ${day}`,
    '',
    '这次是「全项目规划」，不是马上改代码。**以本任务书为准；后面若出现旧的规划话术（一张规划卡 / plan_submit 攒整份草案），一律作废。**',
    '',
    '## 落地顺序（不许跳步）',
    '',
    `1. **先查澄清卷**：\`qn_list(project="${pid}")\`。`,
    '   - **没有已批准的卷**（decks 里没有 approved=true 且未作废/未被取代的）→ **先出卷**：',
    '     用 `qn_propose` 出 1 份最多 6 题的选择题，只问真正影响规划方向的取舍；',
    '     每题至少 2 个选项、每个选项写清代价 `d`、每题写验收线 `line`。',
    '     出完**立刻停手**，告诉用户「问卷已放到问卷页，答完并批准后回复我继续」。',
    '     这一轮**不要**提阶段卡、不要写规划备忘、不要用任务卡替代、不要伪造阶段。',
    '   - 有已批准的卷 → 进入下一步。',
    '2. **逐格提成**：每想清一个阶段，就**立刻**用 `fangcun_write action=stage_plan_propose` 提一格（带 deck）。',
    '   **不要先把 2–5 个阶段攒成一份草案再提交** —— 一次只想清一格就落一格，丢也只丢最后那一格；',
    '   等全部想清再写，中间发现的东西会整块丢掉（用户 2026-11-26 的原话："只会遗失信息，只会丢东西"）。',
    '3. 每格三块齐全：技术方案 `approach` / 照抄点 `copyRows`（`| 项 | 来源 | 原文 |`）/ 判据 `criteria`',
    '   （每条以 `cmd:` / `str:` / `num:` / `file:` 开头）。写不出判据的条目不要提；',
    '   依据引不出就写"缺依据"，不要编。',
    '4. 每提一格就告诉用户「P? 已落成待裁决，等你点通过（冻结）」；**不要自称已通过**。',
    '5. 全部阶段提完后，再落**一张**「规划备忘」卡：`fangcun_write create`，',
    '   `type: plan-memo`、`status: 待审批`、`tags: ["规划","全项目","规划备忘"]`；',
    '   正文写：排除项（这次不做什么 + 为什么）、需要用户拍板的问题（≤3）。',
    '   这两样不落盘就会随聊天丢掉。',
    '',
    '三条硬约束：① 方寸不砍功能；② 只有用户能拍板的方向写进问题，别替他定；',
    '③ 完成/驳回是用户签字，不要设。',
  ].join('\n')
}

/**
 * 定向规划的任务书。
 *
 * 与全项目最大的区别（用户 2026-11-26 拍板）：
 *   · 产物是**一张规划备忘卡**，不是阶段卡 —— 硬塞阶段卡会逼出假"照抄点/判据"；
 *   · 只写用户点名的那一块，不重排整个项目；
 *   · **不要求澄清卷**（这是"更轻"的那条路），但要把需要拍板的问题写进备忘。
 */
export function buildTargetedPlanTaskBook(input: PlanDispatchInput): string {
  const pid = String(input.project || '').trim()
  const label = projectLabel(pid, input.projectName)
  const titleProject = String(input.projectName || '').trim() || pid
  const day = String(input.today || '').trim() || localDay()
  const f = normalizePlanFocus(input.focus)
  if (!f.ok) throw new Error(f.error || '定向引导词不合法')
  if (!f.focus) throw new Error('定向规划必须先写清"只规划哪一块"')
  const focus = f.focus
  // 标题只放摘要：focus 最长 500 字，整段塞进标题会把卡片列表撑爆
  const shortFocus = focus.length > 60 ? focus.slice(0, 60) + '…' : focus
  return [
    buildPlanMarker('targeted', focus),
    '',
    `【方寸 · 定向规划】项目：${label} · ${day}`,
    `只规划：${focus}`,
    '',
    '这次是「定向规划」，**以本任务书为准**；不要重排整个项目，不要给无关领域出阶段。',
    '需要材料时用 `fangcun_search` / `fangcun_memory_search`。',
    '',
    '## 产出（不建阶段卡、不改代码）',
    '',
    '- 现状与问题（≤5 条，每条带依据）',
    '- 可选方案 2–3 个（各自的代价 / 风险 / 影响面）',
    '- 推荐方案 + 理由',
    '- 若确有可执行步骤：给 1–3 个阶段各自的判据（`cmd:` / `str:` / `num:` / `file:`）；',
    '  但**不要现在提成阶段卡** —— 那要等用户看完备忘再决定',
    '- 明确不做什么（防止范围蔓延）',
    '- 需要用户拍板的问题（≤3）',
    '',
    '## 落地（只有一张卡）',
    '',
    '用 `fangcun_write create` 落一张「规划备忘」：',
    '- `title`: `[规划·定向] ' + titleProject + ' · ' + shortFocus + ' · ' + day + '`',
    '- `type`: `plan-memo`',
    '- `status`: `待审批`',
    '- `tags`: `["规划","定向","规划备忘"]`',
    '- `body`: 上面几节全文',
    '',
    '这张卡会出现在「项目页 → 作战计划 → 规划备忘」，**不会混进任务列表**。',
    '不要建阶段卡；用户看完后要拆阶段，再走 `stage_plan_propose`（那时才需要澄清卷）。',
  ].join('\n')
}

export function buildPlanTaskBook(input: PlanDispatchInput): string {
  if (input.mode === 'targeted') {
    const f = normalizePlanFocus(input.focus)
    if (!f.ok) throw new Error(f.error || '定向引导词不合法')
    if (!f.focus) throw new Error('定向规划必须先写清"只规划哪一块"')
  }
  return input.mode === 'targeted' ? buildTargetedPlanTaskBook(input) : buildFullPlanTaskBook(input)
}
