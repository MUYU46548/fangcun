/**
 * 进队列闸（2026-11-11）—— 「判断半」硬锁的**第二个时点**
 *
 * 规格单 §3.1 写了两个时点，此前只落了第一个：
 *   · 出厂（提案）：`plan_draft` / `stage_plan_propose` 必须带 deck —— ✅ 已落（qnGate.ts）
 *   · **进队列（施工）：卡 / 阶段「可派」必须有 `澄清: <卷> 已批准` 且无未答活题 —— ❌ 没落**
 * 漏的正是「汇合点」：草稿卡可以直接被改成待办派出去，出厂闸拦不住它。
 *
 * ## 闸放在哪
 * **数据层的状态写入口**，不在界面上各写一遍：
 *   · 任务卡：`data/tasks.ts#moveStatus` / `updateTask(status)` / `createTask(status=待办)`
 *     —— 桌面 GUI（ipc）与 MCP（tools.ts）都走同一条；
 *   · 阶段卡：`data/plans.ts#writePlanVerdict(pass)`（通过 = 冻结 = 可派）与 `proposeStage`。
 *
 * ## 过渡口径：**没声明 `澄清:` 的卡不拦**（这一条是刻意选的，理由写清）
 * 卡上原文建议「缺字段 = 拒绝」。真按那样落，仓里 300 多张存量卡 + 用户每天新建的
 * 普通待办会**全部锁死**（买东西、发版、回邮件都要先答一份问卷）—— 那不是硬锁，那是把
 * 看板拆了。REV-008 也写着「缺口只报告，不阻挡」。所以这里的语义是：
 *   **声明了澄清卷 ⇒ 必须过闸；没声明 ⇒ 不是这件事的适用对象**（普通任务卡照旧）。
 * 「声明」的唯一真源是 `shared/clarify.ts#clarifyOf`（三种写法都认，含问卷落卡那种没冒号的）。
 * 判决：真正被硬锁的是**规划流水线产出的卡**（`deckToCards` 落卡必带 `## 澄清问卷`）
 * 与**阶段卡**（`proposeStage` 必写 `- 澄清:`），而不是所有待办。
 *
 * ## 「可派」有三个面，口径**故意不同**（2026-11-11 两轴评审指出过，写在代码里免得再吵）
 *   ① 进队列（本文件）：声明了才查 —— 否则 300+ 存量卡全锁死；
 *   ② 桌面「复制为派工单」（`shared/arsenal.ts#buildDispatchResult`，2026-11-09 S3=B 拍板）：
 *      **没卷一律不许派** —— 那是把活交给外部 agent 的最后一道门，比状态流转更外一层；
 *   ③ CLI `tegula dispatch`：按过渡口径放行，但派活体检里**明确提醒**“这张卡没有澄清卷”。
 * 三者不是“同一个闸写错三遍”，而是三层不同强度的门：越靠近“把活交出去”，越硬。
 * 要统一它们就得先答一个问题：存量 300+ 张无卷卡还要不要能派活/进队列。
 */
import { clarifyOf, splitClarify } from '../../shared/clarify'
import type { QnGateResult } from './qnGate'

/**
 * ⚠ 这里用**调用时 require** 而不是顶层 import：
 *   `tasks.ts`（写入口）→ 本文件 → `qnGate.ts` → `questionnaires.ts` → `tasks.ts` 是一个环。
 *   顶层 import 会让 ESM/CJS 的加载顺序决定 `createTask` 是不是 undefined —— 那种 bug
 *   只在“先 import 哪个模块”的时候才炸（测试与打包版顺序还不一样）。调用时取模块就没有这个隐患。
 */
function gateMod(): typeof import('./qnGate') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./qnGate') as typeof import('./qnGate')
}

export interface QueueGateResult {
  ok: boolean
  error?: string
  /** 卡上声明的卷（空 = 没声明） */
  deck?: string
  project?: string
  /** true = 没声明澄清卷，闸不适用（不是失败） */
  skipped?: boolean
  /** 闸内部结果（界面/测试要看点名了哪几题） */
  detail?: QnGateResult
}

/** 任务卡的归属项目：`项目` 可能写成数组（`[a, b]`），也可能裸标量（老卡） */
export function projectOfFm(fm: any): string {
  const p = fm?.project ?? fm?.['项目']
  const first = Array.isArray(p) ? p[0] : String(p ?? '').split(',')[0]
  return String(first ?? '').trim()
}

function wrap(deck: string, project: string, g: QnGateResult): QueueGateResult {
  if (g.ok) return { ok: true, deck, project, detail: g }
  return {
    ok: false, deck, project, detail: g,
    error: `进队列被拦：卡上声明的澄清卷《${deck}》没过闸 —— ${g.error || '未通过'}`
      + `。补法：先把《${deck}》答完并批准（或答掉题库里的相关旧题），再把状态改回「待办」；`
      + '不许绕过闸直接派（没问过就施工 = 把猜测当执行）。',
  }
}

/** 任务卡进「待办」（可派）时的闸 */
export function queueGateForTask(task: { fm?: any; body?: string } | null | undefined): QueueGateResult {
  const fm = (task && task.fm) || {}
  const raw = clarifyOf({ fm, body: task ? task.body : '' })
  const project = projectOfFm(fm)
  if (!raw) return { ok: true, skipped: true, project }
  const { deck, qid } = splitClarify(raw)
  if (!deck) return { ok: true, skipped: true, project }
  // 题目级：`<卷>#<题号>`（问卷落卡）→ 只判那一题；整卷级：判整卷 + 题库（D-060）
  const g = qid ? gateMod().gateForQuestion(deck, qid, project) : gateMod().gateForDeck(deck, project)
  return wrap(qid ? `${deck}#${qid}` : deck, project, g)
}

/**
 * 阶段卡「可派」（通过 / 冻结）时的闸。
 *
 * 阶段块里的 `- 澄清: <卷>` 由 `proposeStage` 必写（出厂闸已强制带卷），
 * 所以这里正常都能过；真正会被拦的是**提案之后卷被作废 / 又有反问**这种时间差。
 * 老阶段块没有这一行 → 不拦（同过渡口径）。
 */
export function queueGateForStage(project: string, clarify: string | undefined): QueueGateResult {
  const raw = String(clarify || '').trim()
  if (!raw || raw === '缺卷') return { ok: true, skipped: true, project }
  const { deck, qid } = splitClarify(raw)
  if (!deck) return { ok: true, skipped: true, project }
  const g = qid ? gateMod().gateForQuestion(deck, qid, project) : gateMod().gateForDeck(deck, project)
  return wrap(raw, project, g)
}
