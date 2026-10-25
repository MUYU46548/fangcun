import { LLMConfig, LLMError, getConfig, isMaskedKey } from './config'
import { appendTrace, traceFilePath } from './trace'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  timeout?: number
  system?: string
  baseUrl?: string
  apiKey?: string
  /** 调用链留痕触发点（如 "desktop.planToDraft"）。留痕只落元数据，不落正文。 */
  trigger?: string
}

/** 由 baseUrl 推导出三个端点。用户填 .../v1 或 .../v1/chat/completions 都能工作。 */
export function resolveEndpoints(baseUrl: string): { root: string; chat: string; models: string } {
  let t = (baseUrl || '').trim().replace(/\/+$/, '')
  for (const suffix of ['/chat/completions', '/completions']) {
    if (t.endsWith(suffix)) {
      t = t.slice(0, -suffix.length)
      break
    }
  }
  t = t.replace(/\/+$/, '')
  if (!/\/v\d+$/.test(t)) t = `${t}/v1`
  return { root: t, chat: `${t}/chat/completions`, models: `${t}/models` }
}

function buildPayload(
  messages: ChatMessage[],
  cfg: LLMConfig,
  options: ChatOptions,
  stream: boolean,
  maxTokensOverride?: number
): Record<string, unknown> {
  return {
    model: options.model || cfg.model,
    messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: maxTokensOverride ?? options.maxTokens ?? 2048,
    stream,
  }
}

/**
 * 鉴权头。TokenHub 等网关对 `Authorization: <key>`（缺 Bearer 前缀）会返回
 * 401002「API Key 不存在或签名校验失败」——这里做保底，杜绝前缀丢失。
 */
function buildHeaders(cfg: LLMConfig): Record<string, string> {
  const raw = (cfg.apiKey || '').trim()
  const token = raw.toLowerCase().startsWith('bearer ') ? raw : `Bearer ${raw}`
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: token,
    // 客户端标识（2026-10-25 卡 005 第 6 条）：供应商后台看到"未归因应用"，就是因为
    // 请求里没有任何身份信息。这三行是方寸**能做的那一步**；能不能被识别取决于
    // 供应商是否收录（国内多数不收录）—— 那是对方的事，不是继续改我们能解决的。
    'User-Agent': 'Fangcun-Desktop',
    'X-Title': 'Fangcun',
    'HTTP-Referer': 'https://github.com/MUYU46548/fangcun',
  }
}

/** 落盘配置的密钥兜底：渲染进程传掩码/空时，一律用磁盘上的真实密钥 */
function resolveConfig(options: ChatOptions): LLMConfig {
  const baseCfg = getConfig()
  const optKey = options.apiKey
  return {
    baseUrl: (options.baseUrl || baseCfg.baseUrl || '').trim(),
    apiKey: !isMaskedKey(optKey) ? String(optKey).trim() : baseCfg.apiKey,
    model: (options.model || baseCfg.model || '').trim(),
    timeout: baseCfg.timeout,
  }
}

function buildMessages(content: string | ChatMessage[], system?: string): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (system) messages.push({ role: 'system', content: system })
  if (typeof content === 'string') {
    messages.push({ role: 'user', content })
  } else {
    messages.push(...content)
  }
  return messages
}

/** 从响应里取正文；推理模型的 content 可能为空而 reasoning_content 有值 */
function extractText(data: any): { text: string; reasoning: string; finish: string } {
  const choice = data?.choices?.[0]
  const message = choice?.message ?? {}
  return {
    text: typeof message.content === 'string' ? message.content : '',
    reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
    finish: String(choice?.finish_reason ?? ''),
  }
}

/** 从响应里取用量（OpenAI 兼容 usage 字段；缺字段给 null——「花销可见」的数据源，不编数） */
export interface ChatUsage {
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
}

function extractUsage(data: any): ChatUsage {
  const u = data?.usage
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    promptTokens: num(u?.prompt_tokens),
    completionTokens: num(u?.completion_tokens),
    totalTokens: num(u?.total_tokens),
  }
}

/** 全 null 的空用量（调用未发生/异常时占位） */
export const emptyUsage: ChatUsage = { promptTokens: null, completionTokens: null, totalTokens: null }

/** 用量转人话（无数据返回空串，调用方按需拼） */
export function usageLabel(u: ChatUsage): string {
  if (u.totalTokens === null && u.promptTokens === null && u.completionTokens === null) return ''
  const parts: string[] = []
  if (u.promptTokens !== null) parts.push(`入 ${u.promptTokens}`)
  if (u.completionTokens !== null) parts.push(`出 ${u.completionTokens}`)
  if (u.totalTokens !== null) parts.push(`共 ${u.totalTokens}`)
  return `（tokens ${parts.join(' / ')}）`
}

async function postChat(
  url: string,
  payload: Record<string, unknown>,
  cfg: LLMConfig,
  timeoutSec: number
): Promise<{ status: number; data: any }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(cfg),
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const bodyText = await response.text()
    if (!response.ok) {
      throw new LLMError(
        `LLM API HTTP ${response.status}: ${response.statusText}`,
        response.status,
        bodyText.slice(0, 800),
        url
      )
    }
    try {
      return { status: response.status, data: JSON.parse(bodyText) }
    } catch {
      throw new LLMError('LLM 返回的不是合法 JSON', response.status, bodyText.slice(0, 800), url)
    }
  } catch (e) {
    if (e instanceof LLMError) throw e
    if ((e as Error).name === 'AbortError') {
      throw new LLMError(`LLM API 超时（${timeoutSec}s）`, undefined, '', url)
    }
    throw new LLMError(`LLM API 调用失败: ${(e as Error).message}`, undefined, '', url)
  } finally {
    clearTimeout(timer)
  }
}

/** AI 调用链留痕：只落元数据，正文绝不落盘；写失败静默不打断主链 */
function traceOnce(opts: {
  trigger: string
  model: string
  promptChars: number
  completionChars: number
  durationMs: number
  ok: boolean
  stream: boolean
  error?: string
  /** 2026-10-17 暮雨第 10 条「花销可见」：把响应里的真实 token 一起留痕 ——
   *  原先只记字符数，界面上永远算不出花了多少。供应商没给 usage 时三个字段就是 null（不编数）。 */
  usage?: ChatUsage
}): void {
  appendTrace({
    ts: new Date().toISOString().slice(0, 19),
    trigger: opts.trigger,
    model: opts.model,
    prompt_chars: opts.promptChars,
    completion_chars: opts.completionChars,
    duration_ms: opts.durationMs,
    ok: opts.ok,
    stream: opts.stream,
    ...(opts.error ? { error: opts.error.slice(0, 200) } : {}),
    ...(opts.usage
      ? {
          prompt_tokens: opts.usage.promptTokens,
          completion_tokens: opts.usage.completionTokens,
          total_tokens: opts.usage.totalTokens,
        }
      : {}),
  })
}

function promptLen(content: string | ChatMessage[]): number {
  if (typeof content === 'string') return content.length
  return content.reduce((n, m) => n + (m.content || '').length, 0)
}

/**
 * 非流式调用详情版：正文+用量+finish，写回层等「花销可见」场景用。
 * 推理模型（如 minimax-*、deepseek-*）思考会吃掉 token 预算，若首轮就 length 截断
 * 且正文为空，自动翻倍 max_tokens 重试一次 —— 避免用户拿到"空结果"。
 */
export async function chatDetailed(
  content: string | ChatMessage[],
  options: ChatOptions = {}
): Promise<{ text: string; usage: ChatUsage; finish: string }> {
  const cfg = resolveConfig(options)
  if (!cfg.apiKey) {
    throw new LLMError('未配置 API Key，请在设置 → 模型通道中填写后重试')
  }
  if (!cfg.baseUrl) {
    throw new LLMError('未配置 Base URL（设置 → 模型通道），或用预设按钮一键填')
  }
  if (!cfg.model && !options.model) {
    throw new LLMError('未配置模型名（设置 → 模型通道），或用预设按钮一键填')
  }

  const { chat: chatUrl } = resolveEndpoints(cfg.baseUrl)
  const messages = buildMessages(content, options.system)
  const timeoutSec = options.timeout || cfg.timeout
  const t0 = Date.now()
  const pChars = promptLen(content)

  try {
    let maxTokens = options.maxTokens ?? 2048
    let { data } = await postChat(chatUrl, buildPayload(messages, cfg, options, false, maxTokens), cfg, timeoutSec)
    let { text, reasoning, finish } = extractText(data)

    if (!text && finish === 'length' && maxTokens < 8192) {
      maxTokens = Math.min(maxTokens * 4, 8192)
      const retry = await postChat(chatUrl, buildPayload(messages, cfg, options, false, maxTokens), cfg, timeoutSec)
      data = retry.data
      ;({ text, reasoning, finish } = extractText(data))
    }

    if (!text) {
      const detail = reasoning
        ? `模型只产出了思考过程（finish_reason=${finish || 'unknown'}），正文为空。`
        : `模型返回空正文（finish_reason=${finish || 'unknown'}）。`
      throw new LLMError(
        `${detail} 已尝试 max_tokens=${maxTokens}。请改用非推理模型，或继续调大 max_tokens。`,
        undefined,
        JSON.stringify(data).slice(0, 800),
        chatUrl
      )
    }
    traceOnce({
      trigger: options.trigger || 'unknown',
      model: cfg.model || options.model || '',
      promptChars: pChars,
      completionChars: text.length,
      durationMs: Date.now() - t0,
      ok: true,
      stream: false,
      usage: extractUsage(data),
    })
    return { text, usage: extractUsage(data), finish }
  } catch (e) {
    traceOnce({
      trigger: options.trigger || 'unknown',
      model: cfg.model || options.model || '',
      promptChars: pChars,
      completionChars: 0,
      durationMs: Date.now() - t0,
      ok: false,
      stream: false,
      error: (e as Error).message,
    })
    throw e
  }
}

/**
 * 非流式调用，返回文本。
 * 推理模型（如 minimax-*、deepseek-*）思考会吃掉 token 预算，若首轮就 length 截断
 * 且正文为空，自动翻倍 max_tokens 重试一次 —— 避免用户拿到"空结果"。
 */
export async function chat(
  content: string | ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  const { text } = await chatDetailed(content, options)
  return text
}

/** 流式调用，返回 AsyncGenerator */
export async function* streamChat(
  content: string | ChatMessage[],
  options: ChatOptions = {}
): AsyncGenerator<string> {
  const cfg = resolveConfig(options)
  if (!cfg.apiKey) {
    throw new LLMError('未配置 API Key，请在「LLM 配置」中填写后重试')
  }

  const { chat: chatUrl } = resolveEndpoints(cfg.baseUrl)
  const messages = buildMessages(content, options.system)
  const payload = buildPayload(messages, cfg, options, true)
  const timeoutSec = options.timeout || cfg.timeout

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000)
  const t0 = Date.now()
  const pChars = promptLen(content)
  let gotChars = 0
  let traced = false

  try {
    const response = await fetch(chatUrl, {
      method: 'POST',
      headers: buildHeaders(cfg),
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text()
      throw new LLMError(
        `LLM API HTTP ${response.status}: ${response.statusText}`,
        response.status,
        body.slice(0, 800),
        chatUrl
      )
    }

    const reader = response.body?.getReader()
    if (!reader) throw new LLMError('无法读取响应流', undefined, '', chatUrl)

    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const chunkData = trimmed.slice(6)
        if (chunkData === '[DONE]') {
          traced = true
          traceOnce({
            trigger: options.trigger || 'unknown',
            model: cfg.model || options.model || '',
            promptChars: pChars,
            completionChars: gotChars,
            durationMs: Date.now() - t0,
            ok: true,
            stream: true,
          })
          return
        }
        try {
          const chunk = JSON.parse(chunkData)
          const delta = chunk.choices?.[0]?.delta
          const piece = delta?.content
          if (piece) {
            gotChars += piece.length
            yield piece
          }
        } catch {
          // 单行解析失败不影响整体流
        }
      }
    }
    // 流自然结束（没等到 [DONE] 也算成功消费完）
    traced = true
    traceOnce({
      trigger: options.trigger || 'unknown',
      model: cfg.model || options.model || '',
      promptChars: pChars,
      completionChars: gotChars,
      durationMs: Date.now() - t0,
      ok: true,
      stream: true,
    })
  } catch (e) {
    if (!traced) {
      traceOnce({
        trigger: options.trigger || 'unknown',
        model: cfg.model || options.model || '',
        promptChars: pChars,
        completionChars: gotChars,
        durationMs: Date.now() - t0,
        ok: false,
        stream: true,
        error: (e as Error).message,
      })
    }
    if (e instanceof LLMError) throw e
    if ((e as Error).name === 'AbortError') {
      throw new LLMError(`LLM API 超时（${timeoutSec}s）`, undefined, '', chatUrl)
    }
    throw new LLMError(`LLM API 调用失败: ${(e as Error).message}`, undefined, '', chatUrl)
  } finally {
    clearTimeout(timer)
  }
}

// ── 连接诊断 ────────────────────────────────────────────────────────────

export interface PingStep {
  name: string
  ok: boolean
  url: string
  status?: number
  detail: string
}

export interface PingResult {
  ok: boolean
  steps: PingStep[]
  hint: string
  models: string[]
}

/** 把网关错误体翻成人话。TokenHub 401002 就是"没带 Bearer 前缀"或"Key 本身失效"。 */
export function explainError(status: number, body: string): string {
  let code = ''
  let msg = ''
  try {
    const j = JSON.parse(body)
    const err = j?.error ?? j
    code = String(err?.code ?? '')
    msg = String(err?.message_zh || err?.message || '')
  } catch {
    msg = body.slice(0, 200)
  }

  if (status === 401) {
    if (code === '401002' || /signature|签名/.test(msg)) {
      return '鉴权失败（401002）。两种可能：① 请求头缺少「Bearer 」前缀；② 保存的 Key 被覆盖成了掩码「***」。请重新粘贴 Key 并保存后再测。'
    }
    return `鉴权失败（401）。请确认 Key 未过期、未带首尾空格，且 Base URL 属于同一个平台。${msg ? ' 网关原文：' + msg : ''}`
  }
  if (status === 403) return `无权限（403）。Key 可能未开通该模型。网关原文：${msg}`
  if (status === 404) return `端点不存在（404）。Base URL 路径可能多写或少写了一层，请核对。网关原文：${msg}`
  if (status === 429) return `触发限流（429）。稍后重试或降低并发。网关原文：${msg}`
  if (status >= 500) return `网关异常（${status}）。属服务端问题，稍后重试。网关原文：${msg}`
  return `HTTP ${status}。网关原文：${msg || body.slice(0, 200)}`
}

/**
 * 两段式探测：先 /models 验鉴权（最轻量），再发一次最小 chat 验模型可用性。
 * 任何阶段失败都返回完整证据（URL / 状态码 / 响应体），不吞错。
 */
export async function pingConnection(options: ChatOptions = {}): Promise<PingResult> {
  const cfg = resolveConfig(options)
  const steps: PingStep[] = []
  const ep = resolveEndpoints(cfg.baseUrl)

  if (!cfg.apiKey) {
    return { ok: false, steps, hint: '未配置 API Key', models: [] }
  }
  if (!cfg.baseUrl) {
    return { ok: false, steps, hint: '未配置 Base URL', models: [] }
  }

  // ① 鉴权 + 模型清单
  let models: string[] = []
  let authOk = false
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const r = await fetch(ep.models, { method: 'GET', headers: buildHeaders(cfg), signal: controller.signal })
      const text = await r.text()
      if (r.ok) {
        try {
          const j = JSON.parse(text)
          models = Array.isArray(j?.data) ? j.data.map((m: any) => m?.id).filter(Boolean) : []
        } catch { /* 列表解析失败不算致命 */ }
        authOk = true
        steps.push({ name: '鉴权', ok: true, url: ep.models, status: r.status, detail: `通过，可用模型 ${models.length} 个` })
      } else {
        steps.push({ name: '鉴权', ok: false, url: ep.models, status: r.status, detail: explainError(r.status, text) })
      }
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    steps.push({ name: '鉴权', ok: false, url: ep.models, detail: `网络不可达：${(e as Error).message}` })
  }

  // ② 最小对话（max_tokens 给足，兼容推理模型）
  const model = cfg.model
  let chatOk = false
  if (authOk) {
    try {
      const { data } = await postChat(
        ep.chat,
        { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 64 },
        cfg,
        30
      )
      const { text, reasoning, finish } = extractText(data)
      if (text) {
        chatOk = true
        steps.push({ name: '对话', ok: true, url: ep.chat, status: 200, detail: `模型 \`${model}\` 正常返回（${text.length} 字）` })
      } else if (reasoning) {
        chatOk = true
        steps.push({
          name: '对话', ok: true, url: ep.chat, status: 200,
          detail: `模型 \`${model}\` 可达，但首轮只输出思考过程（finish_reason=${finish}）。属推理模型特性，正式调用会自动放大 max_tokens。`
        })
      } else {
        steps.push({ name: '对话', ok: false, url: ep.chat, status: 200, detail: `模型 \`${model}\` 返回空正文（finish_reason=${finish}）` })
      }
    } catch (e) {
      const err = e as LLMError
      steps.push({
        name: '对话', ok: false, url: err.url || ep.chat, status: err.code ?? undefined,
        detail: err.code ? explainError(err.code, err.body) : err.message
      })
    }
  } else {
    steps.push({ name: '对话', ok: false, url: ep.chat, detail: '跳过：鉴权未通过' })
  }

  const modelMissing = authOk && !!model && models.length > 0 && !models.includes(model)
  let hint = ''
  if (!authOk) hint = '先解决鉴权：重新粘贴 API Key 后保存（界面留空表示不修改），再测一次。'
  else if (!chatOk) hint = `鉴权没问题，问题在模型名。当前配置 \`${model}\`，请从下方可用列表里选一个。`
  else if (modelMissing) hint = `连接正常，但 \`${model}\` 不在 /models 返回的清单里，可能不适用于该 Key。仍可调用，但建议换用清单内的模型。`

  return { ok: authOk && chatOk, steps, hint, models }
}
