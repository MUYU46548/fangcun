import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

export interface LLMConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeout: number
}

const DEFAULT_CONFIG: LLMConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  timeout: 60,
}

let _config: LLMConfig | null = null

function getConfigPath(): string {
  const userData = app.getPath('userData')
  return path.join(userData, 'llm-config.json')
}

export function getConfig(): LLMConfig {
  if (_config) return _config
  
  const configPath = getConfigPath()
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8')
      _config = JSON.parse(raw)
      return _config!
    }
  } catch {}
  
  _config = { ...DEFAULT_CONFIG }
  return _config
}

export function setConfig(cfg: Partial<LLMConfig>): LLMConfig {
  const current = getConfig()
  _config = { ...current, ...cfg }
  
  const configPath = getConfigPath()
  try {
    fs.writeFileSync(configPath, JSON.stringify(_config, null, 2), 'utf-8')
  } catch {}
  
  return _config
}

export function resetConfig(): LLMConfig {
  _config = { ...DEFAULT_CONFIG }
  return _config
}

export class LLMError extends Error {
  code: number | null
  body: string
  
  constructor(message: string, code?: number, body?: string) {
    super(message)
    this.name = 'LLMError'
    this.code = code ?? null
    this.body = body ?? ''
  }
}
