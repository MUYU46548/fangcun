/**
 * Fangcun Desktop — 应用日志（崩溃/失败可查）
 *
 * 背景（2026-09-22，用户第 8 条）：
 *   启动台启动失败、导入失败、任何异常，界面上只有一句"启动失败"，
 *   调试终端里只有 vite/concurrently 的噪声 —— **没有任何地方能查到原因**。
 *   全仓此前零 uncaughtException / unhandledRejection / 渲染层错误转发 / 文件日志。
 *
 * 设计约束：
 *   - 零外部依赖（只用 fs / path），与备份模块同口径，Node 下也能跑（e2e 用桩）。
 *   - 落盘位置固定 `userData/logs/`（dev 与打包态经 app.setPath 已统一），
 *     **不进数据目录**，因此不会被备份包带走、也不污染 task-data。
 *   - 写日志永不抛：任何内部异常都吞掉，绝不因日志把主流程搞崩。
 */

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

const MAX_FILE_BYTES = 4 * 1024 * 1024 // 单文件上限，超过就滚到 .1
const KEEP_DAYS = 14                    // 只保留最近 14 天

let LOG_DIR: string | null = null
let installed = false
let inWrite = false // 防 console 包装递归

/** 日志目录：userData/logs（取不到 userData 时退到进程 cwd） */
export function getLogDir(): string {
  if (LOG_DIR) return LOG_DIR
  try {
    LOG_DIR = path.join(app.getPath('userData'), 'logs')
  } catch {
    LOG_DIR = path.join(process.cwd(), 'logs')
  }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  } catch {
    /* 目录建不出来也不能抛 */
  }
  return LOG_DIR
}

function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

/** 当天日志文件（按天分文件，便于"哪个时间出的问题"直接定位） */
export function getLogFile(): string {
  return path.join(getLogDir(), `fangcun-${today()}.log`)
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

function stamp(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** 单文件超限时滚到 .1（只留一代，够回溯即可） */
function rotate(): void {
  const f = getLogFile()
  try {
    if (fs.existsSync(f) && fs.statSync(f).size > MAX_FILE_BYTES) {
      fs.renameSync(f, f + '.1')
    }
  } catch {
    /* 滚不动就算了 */
  }
}

/** 清理超过 KEEP_DAYS 的历史日志 */
function prune(): void {
  try {
    const dir = getLogDir()
    const cutoff = Date.now() - KEEP_DAYS * 86400000
    for (const fn of fs.readdirSync(dir)) {
      if (!/^fangcun-\d{8}\.log(\.1)?$/.test(fn)) continue
      const p = path.join(dir, fn)
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p)
      } catch { /* 单个删不掉不影响其它 */ }
    }
  } catch { /* ignore */ }
}

function stringifyDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return ''
  if (typeof detail === 'string') return detail
  if (detail instanceof Error) return detail.stack || detail.message
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

/** 追加一条日志。永不抛。 */
export function append(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  if (inWrite) return
  inWrite = true
  try {
    rotate()
    if (level === 'ERROR') prune()
    const det = stringifyDetail(detail)
    const lines = [`${stamp()} [${level}] [${scope}] ${message}`]
    if (det) lines.push(det.split('\n').map(l => '    ' + l).join('\n'))
    fs.appendFileSync(getLogFile(), lines.join('\n') + '\n', 'utf-8')
  } catch {
    /* 写日志失败不能影响业务 */
  } finally {
    inWrite = false
  }
}

export const info = (scope: string, msg: string, detail?: unknown) => append('INFO', scope, msg, detail)
export const warn = (scope: string, msg: string, detail?: unknown) => append('WARN', scope, msg, detail)
export const error = (scope: string, msg: string, detail?: unknown) => append('ERROR', scope, msg, detail)

/** 把任意异常按统一格式落盘 */
export function logException(scope: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  append('ERROR', scope, msg, e instanceof Error ? e.stack : e)
  return msg
}

/** 读最近 N 行（供界面"查看日志"与问题反馈） */
export function tail(lines = 300): string[] {
  const f = getLogFile()
  try {
    if (!fs.existsSync(f)) return []
    const all = fs.readFileSync(f, 'utf-8').split('\n')
    return all.slice(Math.max(0, all.length - lines))
  } catch {
    return []
  }
}

/**
 * 安装全局兜底。必须在业务代码之前调用（src/index.ts 顶部）。
 * 只落盘 + 计数，**不吞异常语义**：uncaughtException 下进程状态已不可信，
 * 但 Electron 主进程还有托盘/调度在跑，直接退出反而丢掉正在写的备份 —— 故选择记录后继续。
 */
export function installProcessHandlers(): void {
  if (installed) return
  installed = true
  info('boot', '方寸启动', { electron: process.versions.electron, node: process.versions.node, pid: process.pid })

  process.on('uncaughtException', (e) => {
    logException('uncaughtException', e)
  })
  process.on('unhandledRejection', (reason) => {
    logException('unhandledRejection', reason)
  })

  // console.error / warn 也进日志：主进程里散落的 console.warn 才是真实线索
  const origError = console.error.bind(console)
  const origWarn = console.warn.bind(console)
  console.error = (...args: unknown[]) => {
    append('ERROR', 'console', args.map(a => (typeof a === 'string' ? a : stringifyDetail(a))).join(' '))
    origError(...args)
  }
  console.warn = (...args: unknown[]) => {
    append('WARN', 'console', args.map(a => (typeof a === 'string' ? a : stringifyDetail(a))).join(' '))
    origWarn(...args)
  }
}
