/**
 * 自绘架构图 · 生成内核（0.6.0 · 2026-11-02）
 *
 * 关掉旧口径的地方：上一版是"扫 import 画图"，暮雨 10-31 念回第 7 条明确否了 ——
 * “根本没有调用 AI 去生成。人家可是自带审计的严格生成，不是 AI 想怎么画就怎么画的。”
 *
 * 现在的链路（三步，每步都必须可解释）：
 *  ① **给事实**：把只读扫描结果压成一段摘要 + 一份"只能引用这些"的证据清单（与审计同一份事实）；
 *  ② **要草稿**：模型输出 JSON（nodes / edges，每个都带 evidence id）；
 *  ③ **逐条审**：`shared/archGenerate.auditArchDraft` —— 指不回真实目录/import/IPC 的一律拒收，
 *     并把“哪一条 + 为什么 + 怎么改”喂回去重试；重试用完仍不过 → **降级为扫描图并自报家门**。
 *
 * 三条边界（越界即错）：
 *  · 不联网猜事实：模型只能引用 `allowedEvidence` 里的 id；
 *  · 不信任草稿里的任何数字：图上的文件数 / 连线条数一律从扫描事实取（见 `draftToGraph`）；
 *  · 无 AI（未配置 / 调用失败）**仍然出图**，但 `source` 必须是 `scan`，文案写明"这是扫描图，不是生成图"。
 */
import { getConfig, isMaskedKey } from '../llm/config'
import { chatWithFallback } from '../llm/fallback'
import { appendTrace } from '../llm/trace'
import { buildArchGraph, type ArchGraph, type ArchScanFacts } from '../../shared/archGraph'
import {
  auditArchDraft,
  allowedEvidence,
  draftToGraph,
  renderAuditFeedback,
  type ArchAuditResult,
  type ArchDraft,
} from '../../shared/archGenerate'

export const ARCH_TRIGGER = 'desktop.archGenerate'
export const DEFAULT_MAX_ATTEMPTS = 2

/**
 * 输出上限（2026-11-05，暮雨第 2 条“架构图 AI 生成失败”的真因）
 *
 * 原来写死 2048 —— 而架构图的 JSON 要带 evidence 数组，方寸自己这种规模一次就要
 * 4000+ 字符。`ai-trace.jsonl` 里两次 `desktop.archGenerate` 全是
 * `JSON 解析失败：Expected ',' or ']' ... at position 4387`：**输出被 max_tokens 截断**，
 * 断在数组中间，于是每次都以"降级为扫描图"收场。用户看到的是"AI 生成失败"，
 * 真实原因却是"话没说完就被掐了"。
 */
export const ARCH_MAX_TOKENS = 4096

/** 喂给模型的证据条数上限（原来 160：清单太长，模型总想多画，输出必然撑爆） */
export const ARCH_EVIDENCE_LIMIT = 80

export interface ArchGenerateDeps {
  callLlm?: (prompt: string, system: string) => Promise<{ text: string; usage?: any; model?: string }>
  appendTrace?: (rec: any) => void
  now?: string
}

export interface ArchGenerateOptions extends ArchGenerateDeps {
  /** 最多尝试几次（默认 2：首次 + 一次按审计意见重画） */
  maxAttempts?: number
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
}

const SYSTEM_PROMPT = [
  '你是架构图生成器。你只按证据画图，不按印象画图。',
  '',
  '硬规矩（违反即被审计拒收）：',
  '1) 节点 id 只能写成 dir:<目录> / entry:<文件> / deps:<包名>，且必须在给的清单里；',
  '2) 每条连线必须给 evidence，形状是 import:<源目录>-><目标目录>，且必须在给的清单里；',
  '3) 不许发明目录、模块、包名、端口；清单里没有的东西一个都不许出现；',
  '4) 不许输出数字（文件数 / 条数）；数字一律由系统从扫描事实填；',
  '5) 只输出 JSON，不要解释、不要 Markdown 围栏；',
  '6) **保持精简**：节点最多 12 个、连线最多 20 条 —— 挑最能说明结构的那几块，画全反而看不清；',
  '7) 输出必须**是完整闭合的 JSON**（最后一个字符是 }）。宁少画几个节点，也不许半途停住。',
  '',
  '输出格式：',
  '{"title":"项目名 · 架构图","subtitle":"一句话","nodes":[{"id":"dir:src/main","label":"主进程","evidence":["dir:src/main"]}],"edges":[{"from":"dir:src/main","to":"dir:src/shared","kind":"import","evidence":["import:src/main->src/shared"]}]}',
].join('\n')

function factBrief(facts: ArchScanFacts): string {
  const f = facts || ({} as ArchScanFacts)
  const dirs = (f.dirs || []).map((d) => `${d.path}（${d.files} 个文件：${(d.exts || []).join('/') || '代码'}）`)
  const imports = (f.imports || []).map((i) => `${i.from} -> ${i.to} ×${i.count}`)
  const entries = (f.entries || []).slice(0, 10)
  const deps = ((f.packageJson && f.packageJson.deps) || []).slice(0, 40)
  const ipc = f.ipc || ({} as ArchScanFacts['ipc'])
  const ports = (f.ports || []).map((p) => `${p.port}（${p.source}）`)
  return [
    `项目：${(f.project && (f.project.name || f.project.id)) || '(未知)'}`,
    `代码目录（${dirs.length}）：${dirs.join('；') || '无'}`,
    `入口文件：${entries.join(', ') || '无'}`,
    `依赖：${deps.join(', ') || '无'}`,
    `目录间 import（${imports.length}）：${imports.slice(0, 60).join('；') || '无'}`,
    `IPC：handle ${ipc.handles || 0} / invoke ${ipc.invokes || 0} / 桥 ${ipc.bridgeUses || 0}`,
    `端口：${ports.join(', ') || '无'}`,
    `扫描文件数：${f.scannedFiles || 0}${f.truncated ? '（已截断）' : ''}`,
  ].join('\n')
}

function buildPrompt(facts: ArchScanFacts, feedback = ''): string {
  const allowed = allowedEvidence(facts, ARCH_EVIDENCE_LIMIT)
  return [
    '扫描事实：',
    factBrief(facts),
    '',
    `只能引用的证据 id（共 ${allowed.length} 条，一个都不许多）：`,
    allowed.join('\n') || '（空 —— 没有可用证据，请输出空 nodes/edges）',
    feedback ? '\n' + feedback : '',
  ].join('\n')
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
export function parseArchDraft(text: string): { draft: ArchDraft | null; error?: string; repaired?: boolean } {
  const raw = String(text || '').trim()
  if (!raw) return { draft: null, error: '模型没有返回内容' }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fence ? fence[1].trim() : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0) return { draft: null, error: '返回里找不到 JSON 对象' }
  // 末尾不是 `}` = 输出被截断（不是"前后有解释文字"那种）；这时 end 会小于 start
  const complete = end > start
  try {
    if (!complete) throw new Error('输出在 JSON 中途结束（很可能被 max_tokens 截断）')
    const obj = JSON.parse(body.slice(start, end + 1))
    if (!obj || typeof obj !== 'object') return { draft: null, error: 'JSON 不是对象' }
    return { draft: obj as ArchDraft }
  } catch (e: any) {
    const fixed = repairTruncatedJson(body.slice(start))
    if (fixed) {
      try {
        const obj = JSON.parse(fixed)
        if (obj && typeof obj === 'object') return { draft: obj as ArchDraft, repaired: true }
      } catch { /* 补完还是不行，走下面的错误 */ }
    }
    return { draft: null, error: `JSON 解析失败：${e?.message || e}` }
  }
}

function configProblem(): string {
  let cfg: any
  try {
    cfg = getConfig()
  } catch {
    return '读不到模型配置'
  }
  const lack: string[] = []
  if (!cfg?.baseUrl) lack.push('端点地址')
  if (!cfg?.model) lack.push('模型名')
  if (isMaskedKey(cfg?.apiKey)) lack.push('密钥')
  return lack.length ? `没配模型（缺 ${lack.join(' / ')}）` : ''
}

/**
 * 生成一张架构图。**永不放任失败**：任何一步出问题都退到扫描图，并说明为什么。
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

  // 没配模型 → 零调用直接降级（与 P6 起草器同一条闸：不偷偷发请求）
  // ⚠ 注入了 callLlm 就跳过配置检查：那是测试/自检路径，配置由调用方负责。
  const injected = typeof opts.callLlm === 'function'
  const lack = injected ? '' : configProblem()
  if (lack) return fallback(`${lack} —— 先出扫描图，配好模型再重画`)

  const maxAttempts = Math.max(1, Number(opts.maxAttempts) || DEFAULT_MAX_ATTEMPTS)
  const nowIso = String(opts.now || new Date().toISOString())
  // 2026-11-02 BYOK 多通道：主通道挂了自动换备用；降级话术写进 note，失败逐次留痕。
  const call = opts.callLlm || (async (prompt: string, system: string) => {
    const r = await chatWithFallback(prompt, {
      system, trigger: ARCH_TRIGGER, noTrace: true, maxTokens: ARCH_MAX_TOKENS, temperature: 0,
    })
    if (!r.ok) throw new Error(r.error || r.note || '模型调用失败（所有通道都试过了）')
    return {
      text: r.text,
      usage: {
        promptTokens: r.usage?.promptTokens,
        completionTokens: r.usage?.completionTokens,
        totalTokens: r.usage?.totalTokens,
      },
      model: String(r.model || getConfig().model || ''),
    }
  })

  let feedback = ''
  let lastAudit: ArchAuditResult | undefined
  let lastError = ''
  let model = ''
  let usage: ArchGenerateResult['usage']

  for (let i = 1; i <= maxAttempts; i++) {
    const t0 = Date.now()
    let text = ''
    try {
      const r = await call(buildPrompt(facts, feedback), SYSTEM_PROMPT)
      text = String(r?.text || '')
      if (r?.model) model = String(r.model)
      if (r?.usage) usage = r.usage
    } catch (e: any) {
      lastError = `调用模型失败：${e?.message || e}`
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

    const parsed = parseArchDraft(text)
    if (!parsed.draft) {
      lastError = parsed.error || '模型返回不是可用草稿'
      try {
        (opts.appendTrace || appendTrace)({
          ts: nowIso, trigger: ARCH_TRIGGER, model, prompt_chars: 0, completion_chars: text.length,
          duration_ms: Date.now() - t0, ok: false, stream: false,
          error: lastError.slice(0, 300), origin: 'local' as const,
        })
      } catch { /* ignore */ }
      // 解析失败也给一次重试机会（把"格式不对"当反馈喂回去）
      // 说清到底是"格式不对"还是"话没说完"：后者要模型**少画几个节点**，不是"注意格式"
      feedback = /截断|中途结束|Expected/.test(lastError)
        ? '上一版输出在 JSON 中途被截断了。请**减少节点与连线数量**（节点 ≤ 8、连线 ≤ 12），确保 JSON 完整闭合。'
        : '上一版不是合法 JSON（或缺少 nodes）。只输出一个 JSON 对象，键名 nodes / edges，不要解释文字。'
      continue
    }

    const audit = auditArchDraft(parsed.draft, facts)
    lastAudit = audit
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

    if (audit.ok) {
      return {
        ok: true,
        source: 'ai',
        graph: draftToGraph(audit.clean, facts, {
          source: 'ai',
          // 断过尾的这一版要在图上留一句：读者有权知道它是"话没说完"收的尾
          ...(parsed.repaired ? { subtitle: `（本次输出被截断，按完整节点收尾）` } : {}),
        }),
        audit,
        attempts: i,
        model,
        usage,
        repaired: parsed.repaired === true,
      }
    }
    feedback = renderAuditFeedback(audit)
  }

  const why = lastError
    || (lastAudit
      ? `模型 ${maxAttempts} 次都没通过证据审计（最后一次 ${lastAudit.issues.length} 条不过）—— 先出扫描图`
      : '模型没有给出可用草稿 —— 先出扫描图')
  return fallback(why, { attempts: maxAttempts, audit: lastAudit, model, usage })
}
