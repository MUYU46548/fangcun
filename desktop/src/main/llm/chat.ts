import { LLMConfig, LLMError, getConfig } from './config'

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

function buildPayload(
  messages: ChatMessage[],
  cfg: LLMConfig,
  options: ChatOptions,
  stream: boolean
): Record<string, unknown> {
  return {
    model: options.model || cfg.model,
    messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 2048,
    stream,
  }
}

function buildHeaders(cfg: LLMConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  }
}

/**
 * Ensure baseUrl includes /v1 suffix if no /vN version segment is present.
 * Examples:
 *   https://api.openai.com        → https://api.openai.com/v1
 *   https://api.openai.com/v1     → https://api.openai.com/v1  (unchanged)
 *   https://api.openai.com/v1/    → https://api.openai.com/v1  (trailing slash stripped)
 *   https://api.deepseek.com/v2   → https://api.deepseek.com/v2 (unchanged)
 */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/v\d+$/.test(trimmed)) return trimmed
  return `${trimmed}/v1`
}

function buildMessages(content: string | ChatMessage[], system?: string): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (system) {
    messages.push({ role: 'system', content: system })
  }
  if (typeof content === 'string') {
    messages.push({ role: 'user', content })
  } else {
    messages.push(...content)
  }
  return messages
}

/**
 * 非流式调用，返回文本
 */
export async function chat(
  content: string | ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  const baseCfg = getConfig()
  if (!baseCfg.apiKey && !options.apiKey) {
    throw new LLMError(
      'TEGULA_LLM_API_KEY 未设置，请在设置中配置 API Key'
    )
  }
  const cfg: LLMConfig = {
    baseUrl: options.baseUrl || baseCfg.baseUrl,
    apiKey: options.apiKey || baseCfg.apiKey,
    model: baseCfg.model,
    timeout: baseCfg.timeout,
  }

  const messages = buildMessages(content, options.system)
  const payload = buildPayload(messages, cfg, options, false)

  const url = `${normalizeBaseUrl(cfg.baseUrl)}/chat/completions`
  const controller = new AbortController()
  const timeoutMs = (options.timeout || cfg.timeout) * 1000
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
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
        body.slice(0, 500)
      )
    }

    const data = await response.json() as any
    return data.choices?.[0]?.message?.content ?? ''
  } catch (e) {
    if (e instanceof LLMError) throw e
    if ((e as Error).name === 'AbortError') {
      throw new LLMError(`LLM API 超时（${cfg.timeout}s）`)
    }
    throw new LLMError(`LLM API 调用失败: ${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 流式调用，返回 AsyncGenerator
 */
export async function* streamChat(
  content: string | ChatMessage[],
  options: ChatOptions = {}
): AsyncGenerator<string> {
  const baseCfg = getConfig()
  if (!baseCfg.apiKey && !options.apiKey) {
    throw new LLMError(
      'TEGULA_LLM_API_KEY 未设置，请在设置中配置 API Key'
    )
  }
  const cfg: LLMConfig = {
    baseUrl: options.baseUrl || baseCfg.baseUrl,
    apiKey: options.apiKey || baseCfg.apiKey,
    model: baseCfg.model,
    timeout: baseCfg.timeout,
  }

  if (!cfg.apiKey) {
    throw new LLMError(
      'TEGULA_LLM_API_KEY 未设置，请在设置中配置 API Key'
    )
  }

  const messages = buildMessages(content, options.system)
  const payload = buildPayload(messages, cfg, options, true)

  const url = `${normalizeBaseUrl(cfg.baseUrl)}/chat/completions`
  const controller = new AbortController()
  const timeoutMs = (options.timeout || cfg.timeout) * 1000
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
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
        body.slice(0, 500)
      )
    }

    const reader = response.body?.getReader()
    if (!reader) throw new LLMError('无法读取响应流')

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
          // ignore parse errors
        }
      }
    }
  } catch (e) {
    if (e instanceof LLMError) throw e
    if ((e as Error).name === 'AbortError') {
      throw new LLMError(`LLM API 超时（${cfg.timeout}s）`)
    }
    throw new LLMError(`LLM API 调用失败: ${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
}
