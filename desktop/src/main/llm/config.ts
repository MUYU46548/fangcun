import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

export interface LLMConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeout: number
}

/** 密钥掩码。渲染进程只见到掩码；主进程据此判断"用户没有修改密钥"。 */
export const API_KEY_MASK = '***'

const DEFAULT_CONFIG: LLMConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  timeout: 60,
}

let _config: LLMConfig | null = null

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'llm-config.json')
}

/**
 * 判断传入的 apiKey 是否"没有真实修改"。
 * 空 / 纯空白 / 掩码 —— 都视为未修改，绝不能写回磁盘。
 * 这是 401「API Key 不存在」的根因防线：早期版本会把界面回显的 '***' 当真实值存盘。
 */
export function isMaskedKey(v: unknown): boolean {
  if (typeof v !== 'string') return true
  const t = v.trim()
  return t === '' || t === API_KEY_MASK || /^\*+$/.test(t)
}

/** 脱敏展示：前 3 后 4，长度一并给出，便于用户核对粘贴是否正确 */
export function keyHint(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return key[0] + '*'.repeat(Math.max(0, key.length - 2)) + key.slice(-1)
  return `${key.slice(0, 3)}${'*'.repeat(Math.max(3, key.length - 7))}${key.slice(-4)}`
}

function normalize(cfg: Partial<LLMConfig>): LLMConfig {
  const timeout = Number(cfg.timeout)
  return {
    baseUrl: String(cfg.baseUrl || DEFAULT_CONFIG.baseUrl).trim().replace(/\/+$/, ''),
    apiKey: String(cfg.apiKey || '').trim(),
    model: String(cfg.model || DEFAULT_CONFIG.model).trim(),
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_CONFIG.timeout,
  }
}

export function getConfig(): LLMConfig {
  if (_config) return _config

  const configPath = getConfigPath()
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      if (parsed && typeof parsed === 'object') {
        _config = normalize(parsed)
        return _config
      }
      // 配置结构不对：备份坏文件后再回落默认，不静默吞
      const bad = `${configPath}.bad-${Date.now()}`
      try { fs.renameSync(configPath, bad) } catch {}
      console.warn(`[llm] 配置结构异常，已备份到 ${bad}`)
    } catch (e) {
      const bad = `${configPath}.bad-${Date.now()}`
      try { fs.renameSync(configPath, bad) } catch {}
      console.warn(`[llm] 配置解析失败(${(e as Error).message})，已备份到 ${bad}`)
    }
  }

  _config = { ...DEFAULT_CONFIG }
  return _config
}

/** 回显给渲染进程：密钥永不出原值，只给掩码 + 提示串 */
export function getConfigForRenderer(): LLMConfig & { hasApiKey: boolean; apiKeyHint: string } {
  const cfg = getConfig()
  return {
    ...cfg,
    apiKey: cfg.apiKey ? API_KEY_MASK : '',
    hasApiKey: !!cfg.apiKey,
    apiKeyHint: cfg.apiKey ? keyHint(cfg.apiKey) : '',
  }
}

export function setConfig(cfg: Partial<LLMConfig>): LLMConfig {
  const current = getConfig()
  const next: LLMConfig = { ...current }

  if (typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim()) {
    next.baseUrl = cfg.baseUrl.trim().replace(/\/+$/, '')
  }
  // 关键防线：掩码/空值一律"未修改"，绝不覆盖真实密钥
  if (!isMaskedKey(cfg.apiKey)) {
    next.apiKey = String(cfg.apiKey).trim()
  }
  if (typeof cfg.model === 'string' && cfg.model.trim()) {
    next.model = cfg.model.trim()
  }
  if (typeof cfg.timeout === 'number' && Number.isFinite(cfg.timeout) && cfg.timeout > 0) {
    next.timeout = cfg.timeout
  }

  _config = next
  persist(next)
  return _config
}

/** 恢复默认：只重置端点/模型/超时，保留已保存的密钥（清掉会造成"又 401"的体验灾难） */
export function resetConfig(): LLMConfig {
  const current = getConfig()
  _config = { ...DEFAULT_CONFIG, apiKey: current.apiKey }
  persist(_config)
  return _config
}

/** 原子写：先写 tmp 再 rename，避免中断留下半截 JSON。失败必须抛，不静默。 */
function persist(cfg: LLMConfig): void {
  const configPath = getConfigPath()
  const tmp = `${configPath}.tmp`
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmp, configPath)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    throw new LLMError(`LLM 配置写入失败：${(e as Error).message}`)
  }
}

export class LLMError extends Error {
  code: number | null
  body: string
  url: string

  constructor(message: string, code?: number, body?: string, url?: string) {
    super(message)
    this.name = 'LLMError'
    this.code = code ?? null
    this.body = body ?? ''
    this.url = url ?? ''
  }
}
