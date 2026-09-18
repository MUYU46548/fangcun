import { LLMConfig, LLMError, getConfig, isMaskedKey } from './config'

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

/**
 * 非流式调用，返回文本。
 * 推理模型（如 minimax-*、deepseek-*）思考会吃掉 token 预算，若首轮就 length 截断
 * 且正文为空，自动翻倍 max_tokens 重试一次 —— 避免用户拿到"空结果"。
 */
export async function chat(
  content: string | ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  const cfg = resolveConfig(options)
  if (!cfg.apiKey) {
    throw new LLMError('未配置 API Key，请在「LLM 配置」中填写后重试')
  }
  if (!cfg.baseUrl) {
    throw new LLMError('未配置 Base URL')
  }

  const { chat: chatUrl } = resolveEndpoints(cfg.baseUrl)
  const messages = buildMessages(content, options.system)
  const timeoutSec = options.timeout || cfg.timeout

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
        if (chunkData === '[DONE]') return
        try {
          const chunk = JSON.parse(chunkData)
          const delta = chunk.choices?.[0]?.delta
          const piece = delta?.content
          if (piece) yield piece
        } catch {
          // 单行解析失败不影响整体流
        }
      }
    }
  } catch (e) {
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
      return '鉴权失败（401002）。两种可能：① 请求头缺少 `Bearer ` 前缀；② 保存的 Key 被覆盖成了掩码 `***`。请重新粘贴 Key 并保存后再测。'
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
