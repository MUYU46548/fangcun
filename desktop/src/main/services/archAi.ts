/**
 * 自绘架构图 · 生成内核（0.6.0 · 2026-11-02；2026-11-22 改成「DSH 执行 + 证据审计」）
 *
 * 关掉旧口径的地方：上一版是"扫 import 画图"，暮雨 10-31 念回第 7 条明确否了 ——
 * “根本没有调用 AI 去生成。人家可是自带审计的严格生成，不是 AI 想怎么画就怎么画的。”
 *
 * ## 2026-11-22 的链路（卡 80f271dd · D4「全走 DSH」的真落地）
 *
 *  ① **给事实**：只读扫描结果 → 摘要 + 「只能引用这些」的证据清单（与审计同一份事实）；
 *  ② **派给 DSH**：`opts.dispatch` 写一份派单文件，DSH 会话按任务书建一张草稿卡
 *     （提示词与回收格式见 `shared/archPrompt.ts`）；
 *  ③ **逐条审**：`shared/archGenerate.auditArchDraft` —— 指不回真实目录/import/IPC 的一律拒收，
 *     把「哪一条 + 为什么 + 怎么改」喂回去重派；重试用完仍不过 → **降级为扫描图并自报家门**。
 *
 * 三条边界（越界即错）：
 *  · 不联网猜事实：模型只能引用 `allowedEvidence` 里的 id；
 *  · 不信任草稿里的任何数字：图上的文件数 / 连线条数一律从扫描事实取（见 `draftToGraph`）；
 *  · 无 DSH（派单被拒 / 等不到草稿）**仍然出图**，但 `source` 必须是 `scan`，文案写明
 *    "这是扫描图，不是生成图"。
 *
 * `callLlm` 仍是**测试注入口**（e2e 用它验纯逻辑）；桌面/MCP 的生产路径不传它。
 */
import { appendTrace } from '../llm/trace'
import { buildArchGraph, type ArchGraph, type ArchScanFacts } from '../../shared/archGraph'
import { inspectJson, jsonRetryNudge, type JsonFailKind } from '../../shared/jsonRepair'
import {
  ARCH_EVIDENCE_LIMIT,
  ARCH_SYSTEM_PROMPT,
  archFactBrief,
  buildArchPrompt,
} from '../../shared/archPrompt'
import {
  auditArchDraft,
  draftToGraph,
  renderAuditFeedback,
  type ArchAuditResult,
  type ArchDraft,
} from '../../shared/archGenerate'

export { ARCH_EVIDENCE_LIMIT, ARCH_SYSTEM_PROMPT, archFactBrief, buildArchPrompt }

export const ARCH_TRIGGER = 'desktop.archGenerate'
export const DEFAULT_MAX_ATTEMPTS = 2

export interface ArchGenerateDeps {
  /** ⚠ 只给测试注入；生产路径用 `dispatch` 走 DSH，方寸进程内不发模型请求 */
  callLlm?: (prompt: string, system: string) => Promise<{ text: string; usage?: any; model?: string }>
  appendTrace?: (rec: any) => void
  now?: string
}

/** 一次「派给 DSH 并等草稿」的请求（由 main 侧实现，测试可注入假实现） */
export interface ArchDispatchRequest {
  facts: ArchScanFacts
  projectId: string
  attempt: number
  maxAttempts: number
  /** 上一版被拒的原因（首轮为空） */
  feedback: string
}

/** 派单结果：要么拿到草稿正文，要么给一个能落到界面上的失败分型 */
export interface ArchDispatchReply {
  ok: boolean
  text?: string
  error?: string
  /** 失败分型：no_dsh（总闸没开）/ dispatch_failed / timeout / cancelled */
  failKind?: ArchFailKind
  sessionId?: string
  nonce?: string
}

/** 失败分型：界面要能说"坏在哪一步"，不是笼统一句"生成失败" */
export type ArchFailKind =
  | JsonFailKind
  | 'audit_rejected'
  | 'call_failed'
  | 'no_model'
  | 'cancelled'
  | 'dispatch_failed'
  | 'timeout'
  | 'no_dsh'

/** 进度事件 —— 长耗时不许让用户干等（11-03 驳回理由之一） */
export interface ArchProgress {
  phase: 'dispatch' | 'wait' | 'call' | 'parse' | 'audit' | 'retry' | 'done' | 'cancelled'
  attempt: number
  maxAttempts: number
  /** 给人看的一句话 */
  text: string
}

export interface ArchGenerateOptions extends ArchGenerateDeps {
  /** 项目 id（派单要写进任务书；不传就用 facts.project.id） */
  projectId?: string
  /** 生产路径：派给 DSH 并收回草稿（main/services/archDispatch.ts 实现） */
  dispatch?: (req: ArchDispatchRequest) => Promise<ArchDispatchReply>
  /** 最多尝试几次（默认 2：首次 + 一次按审计意见重画） */
  maxAttempts?: number
  /** 进度回调（每次状态变化都调；界面据此显示"第几次 / 在干嘛"） */
  onProgress?: (p: ArchProgress) => void
  /** 取消检查：返回 true 就中止，绝不把半成品图当结果交出去 */
  shouldAbort?: () => boolean
}

export interface ArchGenerateResult {
  /** 有图可看就算 true（降级也算"完成"，但 source 会写 scan） */
  ok: boolean
  source: 'ai' | 'scan'
  graph: ArchGraph
  audit?: ArchAuditResult
  attempts: number
  /** source=scan 时必填：为什么降级 */
  reason?: string
  model?: string
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  /** 这一版是"输出被截断后补全"救回来的（不是模型一次画完的） */
  repaired?: boolean
  /** 失败分型（source=scan 时必填 —— 说清为什么降级） */
  failKind?: ArchFailKind
  /** 用户主动取消（不算失败，但也不许当成功） */
  cancelled?: boolean
  /** 这次 DSH 会话 / 派单（有就带出来，界面和 lastRun 可追） */
  sessionId?: string
  nonce?: string
}

/**
 * 把被截断的 JSON 收尾（2026-11-05）。
 *
 * 为什么需要它：模型输出被 max_tokens 掐断时，最后一个节点/连线往往只差几个字符就完整 ——
 * 实测两次都断在 `position 4387/4388`（总长 4401），差 14 个字符，这一整次就白花了。
 * 这里只做一件事：**退到最后一个完整的对象**，再把缺的 `]` / `}` 补上。
 * 不是伪造数据：补的是**结构**，节点与连线全是模型真写出来的，之后照样逐条过证据审计。
 */
export function repairTruncatedJson(body: string): string | null {
  const cnt = (x: string, ch: string) => x.split(ch).length - 1
  let cut = body.lastIndexOf('}')
  while (cut > 0) {
    const cand = body.slice(0, cut + 1)
    const openArr = cnt(cand, '[') - cnt(cand, ']')
    const openObj = cnt(cand, '{') - cnt(cand, '}')
    if (openArr >= 0 && openObj >= 0) return cand + ']'.repeat(openArr) + '}'.repeat(openObj)
    cut = body.lastIndexOf('}', cut - 1)
  }
  return null
}

/**
 * 从模型输出里抠 JSON（容 ```json 围栏、容前后有解释文字）。
 *
 * 2026-11-05 加 `repaired`：解析失败时先试一次"截断补全"，补成功就照常往下走，
 * 但**如实标出来**（调用方会把它写进结果，界面上能看出这一版是"话没说完"收的尾）。
 */
export function parseArchDraft(text: string): {
  draft: ArchDraft | null
  error?: string
  repaired?: boolean
  /** 失败分型（2026-11-07）：截断要"少画点"，不是"注意格式" */
  kind?: ArchFailKind
} {
  const shape = inspectJson(text)
  if (!shape.kind) {
    try {
      const obj = JSON.parse(shape.body)
      if (!obj || typeof obj !== 'object') return { draft: null, error: 'JSON 不是对象', kind: 'invalid' }
      return { draft: obj as ArchDraft }
    } catch (e: any) {
      return { draft: null, error: `JSON 解析失败：${e?.message || e}`, kind: 'invalid' }
    }
  }
  // 截断的还能救：退到最后一个完整对象再补齐括号（11-05 加，救回过一次 4401 字符的输出）
  if (shape.kind === 'truncated') {
    const fixed = repairTruncatedJson(shape.body)
    if (fixed) {
      try {
        const obj = JSON.parse(fixed)
        if (obj && typeof obj === 'object') return { draft: obj as ArchDraft, repaired: true }
      } catch { /* 补完还是不行，按截断报 */ }
    }
  }
  return { draft: null, error: shape.message, kind: shape.kind }
}

/**
 * 生成一张架构图。**永不放任失败**：任何一步出问题都退到扫描图，并说明为什么。
 *
 * ⚠ 2026-11-22：生产路径用 `dispatch`（派给 DSH）；只传 `callLlm` 的老测试路径保留。
 *   两者都不传 → 直接扫描图，并明说「方寸不自带模型调用」。
 */
export async function generateArchGraph(
  facts: ArchScanFacts,
  opts: ArchGenerateOptions = {},
): Promise<ArchGenerateResult> {
  const scan = buildArchGraph(facts)
  // 降级 = **直接用扫描图**（它本来就是"从事实画出来的图"），只在文案上自报家门。
  // 早先这里错用了"空草稿过一遍 draftToGraph"，于是降级图一个节点都没有 —— 测试当场抓到。
  const fallback = (reason: string, extra: Partial<ArchGenerateResult> = {}): ArchGenerateResult => {
    const head = '这是扫描图，不是生成图'
    return {
      ok: true,
      source: 'scan',
      graph: {
        ...scan,
        subtitle: reason || '静态扫描',
        text: `${head} · ${scan.text}${reason ? ' · ' + reason : ''}`,
      },
      attempts: extra.attempts ?? 0,
      reason,
      ...extra,
    }
  }

  const useDispatch = typeof opts.dispatch === 'function'
  const call = opts.callLlm
  // 两条执行路径都没有：只出扫描图，不发任何请求（这是"方寸不自带模型"的默认态）
  if (!useDispatch && typeof call !== 'function') {
    return fallback('全走 DSH：方寸只出扫描图（生成请点「让 DSH 画图」）', { failKind: 'no_model' })
  }

  const maxAttempts = Math.max(1, Number(opts.maxAttempts) || DEFAULT_MAX_ATTEMPTS)
  const nowIso = String(opts.now || new Date().toISOString())

  let feedback = ''
  let lastAudit: ArchAuditResult | undefined
  let lastError = ''
  let lastKind: ArchFailKind | undefined
  let model = ''
  let usage: ArchGenerateResult['usage']
  let sessionId = ''
  let nonce = ''

  const emit = (p: ArchProgress) => { try { opts.onProgress && opts.onProgress(p) } catch { /* 进度回调失败不影响生成 */ } }
  const aborted = () => !!(opts.shouldAbort && opts.shouldAbort())

  for (let i = 1; i <= maxAttempts; i++) {
    // 取消检查放在**每次调用前**：已经派出去的会话收不回来，但不许再派下一次，
    // 更不许把半成品图当结果交出去（11-03 驳回："挂着窗口干等，点关闭有没有影响"）。
    if (aborted()) {
      emit({ phase: 'cancelled', attempt: i, maxAttempts, text: '已取消' })
      return fallback('已取消 —— 没有生成任何图', {
        attempts: i - 1, cancelled: true, failKind: 'cancelled', audit: lastAudit, model, usage, sessionId, nonce,
      })
    }

    let text = ''
    let t0 = Date.now()
    if (useDispatch) {
      emit({ phase: 'dispatch', attempt: i, maxAttempts, text: `第 ${i}/${maxAttempts} 次：派给 DSH 画图…` })
      try {
        const reply = await opts.dispatch!({
          facts,
          projectId: String(opts.projectId || (facts?.project && facts.project.id) || ''),
          attempt: i,
          maxAttempts,
          feedback,
        })
        if (!reply || !reply.ok) {
          lastError = String(reply?.error || 'DSH 派单失败')
          lastKind = (reply?.failKind as ArchFailKind) || 'dispatch_failed'
          if (reply?.sessionId) sessionId = String(reply.sessionId)
          if (reply?.nonce) nonce = String(reply.nonce)
          break
        }
        text = String(reply.text || '')
        if (reply.sessionId) sessionId = String(reply.sessionId)
        if (reply.nonce) nonce = String(reply.nonce)
      } catch (e: any) {
        lastError = `派给 DSH 失败：${e?.message || e}`
        lastKind = 'dispatch_failed'
        break
      }
    } else {
      emit({ phase: 'call', attempt: i, maxAttempts, text: `第 ${i}/${maxAttempts} 次：正在让模型画图…` })
      t0 = Date.now()
      try {
        const r = await call!(buildArchPrompt(facts, feedback), ARCH_SYSTEM_PROMPT)
        text = String(r?.text || '')
        if (r?.model) model = String(r.model)
        if (r?.usage) usage = r.usage
      } catch (e: any) {
        lastError = `调用模型失败：${e?.message || e}`
        lastKind = 'call_failed'
        // 失败也留痕（花销可见优先于"好看"）
        try {
          (opts.appendTrace || appendTrace)({
            ts: nowIso, trigger: ARCH_TRIGGER, model, prompt_chars: 0, completion_chars: 0,
            duration_ms: Date.now() - t0, ok: false, stream: false,
            error: String(e?.message || e).slice(0, 300), origin: 'local' as const,
          })
        } catch { /* 留痕失败不挡降级 */ }
        break
      }
    }

    const parsed = parseArchDraft(text)
    if (!parsed.draft) {
      lastError = parsed.error || '返回的不是可用草稿'
      lastKind = parsed.kind || 'invalid'
      emit({ phase: 'parse', attempt: i, maxAttempts, text: `第 ${i} 次：${lastError}` })
      // 注入路径的留痕（生产走 DSH 时不记本地 token —— 花销在 DSH 侧可见）
      if (!useDispatch) {
        try {
          (opts.appendTrace || appendTrace)({
            ts: nowIso, trigger: ARCH_TRIGGER, model, prompt_chars: 0, completion_chars: text.length,
            duration_ms: Date.now() - t0, ok: false, stream: false,
            error: lastError.slice(0, 300), origin: 'local' as const,
          })
        } catch { /* 留痕失败不挡降级 */ }
      }
      // 解析失败也给一次重试机会 —— 但**指令按类型给**（2026-11-07 统一到 shared/jsonRepair）：
      // 截断要"少画几个节点"，不是"注意格式"；这两句说反了，模型会照旧被截断。
      emit({ phase: 'retry', attempt: i, maxAttempts, text: `第 ${i} 次没成（${lastKind}），按类型给一次重试…` })
      feedback = parsed.kind === 'truncated'
        ? '上一版输出在 JSON 中途被截断了。请**减少节点与连线数量**（节点 ≤ 8、连线 ≤ 12），确保 JSON 完整闭合。'
        : jsonRetryNudge(parsed.kind || 'not_json')
      continue
    }

    const audit = auditArchDraft(parsed.draft, facts)
    lastAudit = audit
    if (!useDispatch) {
      try {
        (opts.appendTrace || appendTrace)({
          ts: nowIso, trigger: ARCH_TRIGGER, model,
          prompt_chars: 0, completion_chars: text.length,
          duration_ms: Date.now() - t0, ok: audit.ok, stream: false,
          total_tokens: usage?.totalTokens,
          note: audit.ok ? '审计通过' : `审计拒收 ${audit.issues.length} 条`,
          origin: 'local' as const,
        })
      } catch { /* 留痕失败不影响出图 */ }
    }

    if (audit.ok) {
      emit({ phase: 'done', attempt: i, maxAttempts, text: `第 ${i} 次：审计通过` })
      return {
        ok: true,
        source: 'ai',
        graph: draftToGraph(audit.clean, facts, {
          source: 'ai',
          // 断过尾的这一版要在图上留一句：读者有权知道它是"话没说完"收的尾
          ...(parsed.repaired ? { subtitle: '（本次输出被截断，按完整节点收尾）' } : {}),
        }),
        audit,
        attempts: i,
        model,
        usage,
        repaired: parsed.repaired === true,
        sessionId,
        nonce,
      }
    }
    lastKind = 'audit_rejected'
    emit({ phase: 'audit', attempt: i, maxAttempts, text: `第 ${i} 次：审计拒收 ${audit.issues.length} 条，按意见重派…` })
    feedback = renderAuditFeedback(audit)
  }

  const why = lastError
    || (lastAudit
      ? `DSH ${maxAttempts} 次都没通过证据审计（最后一次 ${lastAudit.issues.length} 条不过）—— 先出扫描图`
      : 'DSH 没有给出可用草稿 —— 先出扫描图')
  emit({ phase: 'done', attempt: maxAttempts, maxAttempts, text: `降级为扫描图：${why}` })
  return fallback(why, {
    attempts: maxAttempts, audit: lastAudit, model, usage,
    failKind: lastKind || 'audit_rejected',
    // 派单侧报"取消"时，界面要按取消处理（不是"没画成"）
    cancelled: lastKind === 'cancelled',
    sessionId, nonce,
  })
}
