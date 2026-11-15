/**
 * 弹药库 · 派工单文本（卡 031 六字段 schema）
 *
 * 定位：**卡片模板文本**。定稿依据 `docs/执行日志/log_20260925104339_pltcb4.md`
 * §2.1（六字段）· §1.1（约束卡七条）· §1.2（验收四条）· §1.3（驳回纪律）· §4（分诊卡）。
 *
 * 三条铁律（拍板时定的，不许悄悄改）：
 *   ① **不新建模块**：弹药库 = 既有任务卡 + 这份模板，不引入第二种卡片、不动状态机。
 *   ② **字段进卡片模板文本，不进 registry JSON**（零依赖红线）。
 *   ③ **零智能**：这里只有纯文本拼接。不调 LLM、不自动改写、不自动派发 ——
 *      “9/20 已判死 agent 派活”，派发永远留人手。
 *
 * 状态标记用**既有事实映射**，不加新字段：
 *   归档 = 文件已在 `task-data/archive/`（方寸唯一权威判据是路径）
 *   已派 = 状态 ∈ {进行中, 待验收, 完成}
 *   待派 = 其余（草稿 / 待审批 / 待办 / 驳回 —— 驳回要重派，所以回到待派）
 */

export const ARSENAL_FIELDS = [
  '任务目标',
  '工作目录/范围',
  '项目事实/放置位置',
  '抽象档位',
  '验收判据',
  '驳回上限',
] as const

export const DISMISS_LIMIT_DEFAULT = 2

export type ArsenalStatus = '待派' | '已派' | '归档'

/** 用既有事实推断弹药库状态（**派生**，不是新字段） */
export function arsenalStatus(input: { status?: string; path?: string }): ArsenalStatus {
  const p = String(input?.path || '').replace(/\\/g, '/')
  if (/(^|\/)archive\//.test(p)) return '归档'
  const st = String(input?.status || '').trim()
  if (st === '进行中' || st === '待验收' || st === '完成') return '已派'
  return '待派'
}

export interface DispatchInput {
  id?: string
  title?: string
  /** 卡的正文（原文照贴，不改写、不总结） */
  body?: string
  status?: string
  path?: string
  priority?: string
  tags?: string[]
  /** 卡的 `type` 字段（bug / review / design）—— 与标签一起决定要不要下发前端施工纪律 */
  type?: string
  /** 项目根绝对路径（来自 registry 的 repo 字段） */
  projectRoot?: string
  projectName?: string
  /** 覆盖用：卡上已有的验收条目（有就带上，没有就留空给人写） */
  acceptance?: string[]
  /** 澄清问卷卷名（2026-11-09 硬锁）：没有它，派工单不许出厂 */
  clarify?: string
  /** 已落档的验收线（来自问卷，追加在第 7 节；不覆盖第 5 节人工验收） */
  rulings?: { deck: string; qid: string; line: string }[]
  /** 是否执行“没卷不许派”（默认 true；老调用方要原文就传 false） */
  strict?: boolean
}

const line = (s: string) => s

/** `type`/标签能认出的类别（与 Python 侧 `_task_kind` 同一套认法，**别在这里另立口径**） */
function kindOf(input: DispatchInput): '' | 'bug' | 'review' | 'design' {
  const tp = String(input?.type || '').trim().toLowerCase()
  const tags = (input?.tags || []).map((x) => String(x).toLowerCase()).join(' ')
  if (tp === 'bug' || tags.indexOf('bug') >= 0 || tags.indexOf('缺陷') >= 0) return 'bug'
  if (tp === 'review' || tp === '评审' || tags.indexOf('评审') >= 0 || tags.indexOf('review') >= 0) return 'review'
  if (tp === 'design' || tp === '设计' || tags.indexOf('设计') >= 0
      || tags.indexOf('design') >= 0 || tags.indexOf('ui') >= 0) return 'design'
  return ''
}

/**
 * 前端施工纪律 R1–R5（2026-11-15 暮雨交来，全本 `docs/施工纪律-前端.md`）。
 *
 * ⚠ 这段与 `tegula/core.py` 的 `UI_DISCIPLINE_BLOCK` **是同一套口径的两处投影**：
 *   · CLI 任务书（`tegula dispatch`）走 Python 那份；
 *   · 桌面「📐 复制为派工单」走这一份。
 * 两条入口都得说，否则"派工单带了纪律、任务书没带"（或反过来）就变成看运气。
 * 但**真源只有一处**：`docs/施工纪律-前端.md`。这里和那边都只放立刻要看见的硬约束。
 */
const UI_DISCIPLINE_LINES = [
  '## 前端施工纪律（R1–R5 · 全本 docs/施工纪律-前端.md）',
  '- **R1 视觉反馈（硬前置）**：改完 UI 必须**真截图自己看**（桌面 1440×900 + 窄屏 900×700 = Electron 最小窗口），',
  '  确认无明显丑/断/错位才许提交。**无截图的“应该没问题”式提交一律打回**。',
  '  本仓命令：`FC_SHOT_ONLY="<用例>" node scripts/test/e2e-renderer-web.cjs --shots`；',
  '  窄屏：`FC_SHOT_SIZE="900,700" FC_SHOT_ONLY="<用例>" node scripts/test/e2e-renderer-web.cjs --shots=<目录>`；',
  '  改完再跑 `node scripts/test/e2e-renderer-web.cjs`（截图证“看着对”，断言证“行为对”）。',
  '- R1 附加：**新界面必须在 CASES_ALL 里补一条截图用例** —— 没进清单的页签 = 从没人看过的页签。',
  '- **R2 用户实点验收**：交付物是装得上、点得动的实物，不是 diff、不是截图合集；',
  '  验收线写“用户实点通过”。**禁止用“测试绿”替代这条**。',
  '- **R3 令牌单源**：颜色/字号/间距/阴影一律引用令牌（`styles/app.css` 的 `:root` + `--ui-*`）；',
  '  **禁止写死十六进制与像素阴影**。新增手搓按钮/浮层类会被 `check-ui-freeze` 当场拦下。',
  '- **R4 组件小步**：一次一个组件，验收过再下一个；**禁止整页/整应用一次性生成**。',
  '- **R5 完成定义**：前端件的“完整”＝用户零担心 + 预期不需再改（对标备份按钮）。',
]

/**
 * 拼一份可以直接粘给 agent 的派工单。**纯文本拼接，零智能。**
 *
 * “预填的是字节，结构化发生在人脑子里”—— 卡正文原文照贴，
 * 六字段里**只有已知的填上**（项目根、驳回上限默认值、卡上已有的验收条目），
 * 其余留空由人亲手写：连目标都预填会诱发锚定效应，把派工卡写烂。
 */
export function buildDispatchText(input: DispatchInput): string {
  const t = String(input?.title || input?.id || '(无标题)').trim()
  const body = String(input?.body || '').trim()
  const root = String(input?.projectRoot || '').trim()
  const projName = String(input?.projectName || '').trim()
  const st = arsenalStatus({ status: input?.status, path: input?.path })
  const rawStatus = String(input?.status || '').trim() || '—'
  const prio = String(input?.priority || '').trim()
  const tags = (input?.tags || []).map(String).filter(Boolean)
  const acceptance = (input?.acceptance || []).map(String).filter((s) => s.trim())

  const L: string[] = []
  L.push(line(`# 派工单：${t}`))
  L.push('')
  L.push(`- 卡 id：${input?.id || '—'}`)
  L.push(`- 弹药库状态：${st}（原状态：${rawStatus}${prio ? ' · 优先级 ' + prio : ''}）`)
  if (tags.length) L.push(`- 标签：${tags.join('、')}`)
  if (projName) L.push(`- 项目：${projName}${root ? `（${root}）` : ''}`)
  L.push('')
  L.push('## 1 任务目标')
  L.push('（一句话：这次要做成什么。**留空由人亲手写** —— 预填目标会让人顺手接受一个模糊目标。）')
  L.push('')
  L.push('## 2 工作目录 / 范围')
  L.push(`- 项目根：${root || '（待填：项目根绝对路径）'}`)
  L.push('- 边界：只动 …（写死改哪些文件、动哪个模块，防顺手重构）')
  L.push('- **先搜后写**：动手前先列出“已有相关实现清单”，再开始写（把"没搜就造"变成"搜过才造"）')
  L.push('')
  L.push('## 3 项目事实 / 放置位置')
  L.push('（三五行项目事实：异常在哪处理 / 校验在哪层 / 配置缺失怎么办；')
  L.push(' 工具函数一律进公共目录，禁落业务模块。活跃项目的这本从方针卡“项目事实”节抄。）')
  L.push('')
  L.push('## 4 抽象档位')
  L.push('单实现直接写，不抽接口；出现第二个真实调用方再抽。')
  L.push('（"要不要抽象"是架构决策，不由执行方裁量。）')
  L.push('')
  L.push('## 5 验收判据')
  if (acceptance.length) {
    for (const a of acceptance) L.push(`- ${a.replace(/^[-*]\s*/, '')}`)
  } else {
    L.push('- （可对照条目，**禁形容词**：不写"质量好/运行流畅"，要写"verify.py 全绿"这种能对照的）')
  }
  L.push('- 兜底报备：diff 里每条新增兜底逐条报“防的是什么 + **失败时用户看到什么**”；')
  L.push('  写不清失败表现 = 这个兜底自己不知道吞了什么，直接打回。')
  L.push('')
  L.push('## 6 驳回上限')
  L.push(String(DISMISS_LIMIT_DEFAULT) + ' 轮（到限升级给人，不让它第三次说服自己）')
  L.push('')
  // 2026-11-09（S3 直连）：把“你答过的验收线”追加进来，**不覆盖**第 5 节人工验收 ——
  // 那一节留空是防锚定，这一节是防“答过的线躺在问卷里没人用”。
  L.push('## 7 已落档的验收（来自问卷 · 追加，不替代第 5 节）')
  const rulings = (input?.rulings || [])
    .filter((r) => r && String(r.line || '').trim())
    .map((r) => `${r.qid}（${r.deck}）：${String(r.line).trim()}`)
  if (rulings.length) {
    for (const r of rulings) L.push(`- ${r}`)
  } else {
    L.push('- （本项目还没有已落档的验收线）')
  }
  L.push('')
  L.push('## 8 澄清问卷（没附 = 不许派）')
  const clarify = String(input?.clarify || '').trim()
  L.push(clarify ? `- ${clarify}` : '- （缺 —— 这张卡没有附澄清问卷，按 2026-11-09 硬锁不许派）')
  L.push('')
  if (body) {
    L.push('---')
    L.push('')
    L.push('## 卡内容（原文，不改写、不总结）')
    L.push('')
    L.push(body)
    L.push('')
  }
  L.push('---')
  L.push('')
  // 前端施工纪律只对**会动界面**的卡下发（2026-11-15）。
  // 判定与 Python 侧 `_task_kind` 同一套认法：`type` 或标签里的 设计/ui/design。
  // 不按标题猜（"改一下按钮"不等于设计卡）—— 与那边写下的理由一致。
  if (kindOf(input) === 'design') L.push(...UI_DISCIPLINE_LINES, '')
  L.push('## 约束卡（七条，每张派工卡都带）')
  L.push('1. **只做指定那一步** —— 防范围膨胀。')
  L.push('2. **范围写死** —— 改哪些文件、动哪个模块，写进卡里，防"顺手重构"。')
  L.push('3. **答完停下回报，不自行续做** —— 做完这步就停，下一步等派。')
  L.push('4. **结论区分“实测”与“未验证”** —— "跑过 verify.py 全绿"和"我觉得应该好了"必须分开写。')
  L.push('5. **允许否决** —— 根因不在本卡范围就建议改派/拆卡，不为有产出硬做。')
  L.push('6. **长任务分批跑** —— 每批有可验收的中间产物。')
  L.push('7. **同一模块第三次暴雷，就地修改判重写** —— 先用测试钉死现有行为再重写。')
  L.push('')
  L.push('## 验收四条')
  L.push('1. 验收判据**禁形容词** —— 必须写成能对照的条目。')
  L.push('2. **只读代码就判过 = 视为未完成** —— 带界面的修复必须桌面实际点一遍。')
  L.push('3. **实现者自报不算数** —— 能写成机器判据的以脚本结果为准；实现和验收不能是同一份上下文。')
  L.push('4. **新增兜底须报备**（报备制非禁令）—— 防"错误暴露"=吞错误，直接打回；防"数据损坏"=好兜底，留下但记录权衡。')
  L.push('')
  L.push('## 驳回纪律')
  L.push('- 打回返工**在同一会话里追加指令，不开新会话**（重开 = 上下文全丢，是"越修越崩"的常见成因）。')
  L.push(`- 上限 ${DISMISS_LIMIT_DEFAULT} 轮；到限换会话或升级给 TA。`)
  L.push('')
  L.push('## 分诊（这张卡该不该派）')
  L.push('**该派**：结果需要被检查（有客观判据）／要跑很久守不住／需要多个视角／步骤清晰能拆开。')
  L.push('**不该派**：两分钟能干完／边做边改方向／强依赖 TA 实时判断／自己都没想清楚要什么。')
  return L.join('\n')
}

/**
 * 派工单出厂的硬闸（2026-11-09 · S3=B）。
 *
 * 暮雨拍板把“派工单 / 任务书生成口”也纳入澄清闸：**没附卷 = 不许派**。
 * 这是纯函数，数据层（卡上的 `澄清:` 字段 + 问卷答案）由调用方先查好再传进来。
 */
export function buildDispatchResult(input: DispatchInput): { ok: boolean; text?: string; error?: string } {
  const strict = input?.strict !== false
  const clarify = String(input?.clarify || '').trim()
  if (strict && !clarify) {
    return { ok: false, error: '这张卡没有附澄清问卷（澄清: <卷>）—— 没问过就派 = 把猜测当执行。先出卷、答完、批准，再把卷名写进卡。' }
  }
  return { ok: true, text: buildDispatchText(input) }
}
