/**
 * 许可协议总闸 —— **主进程侧的判据**（2026-11-18）。
 *
 * 背景（审计 `docs/审计-AI调用入口与授权闸-20261118.md`）：
 *   方寸的免责声明确认此前只写渲染层 localStorage（`fc_disclaimer_ack`），
 *   主进程 / MCP / Python **一处都不读** —— 任何本机进程一条 IPC/MCP/CLI 调用
 *   就能让方寸开始花作者的钱，而作者以为“我同意过了才会跑”。
 *
 * 现在把“同意”从文案变成判据：
 *   · 记录落**数据根** `<dataDir>/config/license_ack.json`（version + 正文指纹 + 时间 + 来源）；
 *   · 版本或正文指纹一变 → 旧记录失效（stale），重新弹；
 *   · 判据只有这一份；`llm/chat.ts` 的咽喉、IPC、Python 都读它。
 *
 * 失败方向：**未确认 = 什么都不做**（不是降级、不是打 WARN），拒文要说清去哪点同意。
 *
 * 边界（如实声明）：
 *   ① 它拦的是接口级自我解锁：Agent 不能通过产品自身的 API 给自己开闸。
 *      本机恶意程序直接改数据根文件不在本机制范围内。
 *   ② 测试旁路 `FANGCUN_LICENSE_ACK=1`（仅测试进程；state 里如实标 bypass）。
 *   ③ 本文件不 import electron —— 纯函数，可被 Node 测试直接跑；
 *      数据根由调用方传入（主进程传 `getDataDir()`）。
 */
import * as fs from 'fs'
import * as path from 'path'
import { LICENSE_CONTENT_SHA, LICENSE_VERSION } from '../shared/license'

export { LICENSE_CONTENT_SHA, LICENSE_VERSION }

/** 同意的落点（相对数据根）。放 config/：数据清理不会顺手把“签字”扫掉。 */
export const ACK_REL = path.join('config', 'license_ack.json')

/** 仅测试进程应设；值必须是 "1"。生产启动路径不设它。 */
export const ENV_BYPASS = 'FANGCUN_LICENSE_ACK'

export interface LicenseAck {
  version?: string
  sha?: string
  at?: string
  source?: string
}

export interface LicenseState {
  ok: boolean
  acked: boolean
  bypass: boolean
  stale: boolean
  ack: LicenseAck | null
  required: { version: string; sha: string }
  /** 数据根为空/不可读时的人话原因；正常为空串 */
  error?: string
}

function normVersion(v: unknown): string {
  const s = String(v ?? '').trim()
  return s.endsWith('.0') && s.split('.').length === 2 ? s.slice(0, -2) : s
}

function bypassed(env: Record<string, string | undefined> = process.env): boolean {
  return String(env[ENV_BYPASS] || '').trim() === '1'
}

function readRaw(root: string): LicenseAck | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, ACK_REL), 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function state(root: string, env: Record<string, string | undefined> = process.env): LicenseState {
  const dir = String(root || '').trim()
  const required = { version: LICENSE_VERSION, sha: LICENSE_CONTENT_SHA }
  // ⚠ 2026-11-18 修：**bypass 必须在这之前判**。
  //   原来"数据根未就绪"直接 return acked:false —— 于是测试环境（桩里 `getDataDir()` 返回
  //   undefined）即使设了 `FANGCUN_LICENSE_ACK=1` 也照样被拒，10 条降级链断言全部变成
  //   "都在问同一件事"。放行开关比数据根更**优先**：它是显式的测试/救援通道，
  //   不该被"目录还没准备好"这种无关条件挡住。
  const bypass = bypassed(env)
  if (!dir) {
    return {
      ok: false, acked: bypass, bypass, stale: false, ack: null, required,
      error: bypass ? '' : '数据根未就绪',
    }
  }
  const raw = readRaw(dir)
  let stale = false
  if (raw) {
    const vOk = normVersion(raw.version) === normVersion(LICENSE_VERSION)
    const sOk = String(raw.sha || '').trim() === LICENSE_CONTENT_SHA
    stale = !(vOk && sOk)
  }
  return {
    ok: true,
    acked: Boolean(bypass || (raw && !stale)),
    bypass,
    stale,
    ack: raw ? { version: raw.version, sha: raw.sha, at: raw.at, source: raw.source } : null,
    required,
  }
}

export function isAcked(root: string, env: Record<string, string | undefined> = process.env): boolean {
  return state(root, env).acked
}

/**
 * 写入同意记录。**版本与正文指纹由服务端常量决定**，不信客户端自称。
 * 只应由 GUI IPC 调用；MCP/CLI 没有写口。
 */
export function record(root: string, source = 'gui', at?: string): { ok: boolean; error?: string; state: LicenseState } {
  const dir = String(root || '').trim()
  if (!dir) return { ok: false, error: '数据根未就绪，无法记录同意', state: state(dir) }
  const payload = {
    product: '方寸',
    version: LICENSE_VERSION,
    sha: LICENSE_CONTENT_SHA,
    at: at || new Date().toISOString(),
    source: String(source || 'unknown').slice(0, 40),
  }
  const file = path.join(dir, ACK_REL)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
    fs.renameSync(tmp, file)
  } catch (e) {
    return { ok: false, error: `写入同意记录失败：${(e as Error).message}`, state: state(dir) }
  }
  return { ok: true, state: state(dir) }
}

/** 撤销同意（测试/排障用；界面没有这个入口）。 */
export function clear(root: string): boolean {
  try {
    fs.unlinkSync(path.join(root, ACK_REL))
    return true
  } catch {
    return true
  }
}

/** 未确认时的统一拒文（IPC/MCP/Python 共用同一口径）。 */
export function refusalMessage(action = '调用模型'): string {
  return (
    `未确认许可协议（免责与知情声明）—— 按设计，确认之前方寸不调用任何模型（${action}）。\n` +
    '怎么继续：打开方寸桌面端，在首启弹窗里滚到底部、勾选并点“我已阅读并同意”；' +
    '确认是**一次性的**，之后这个数据目录不再询问（条款改版才会重新弹）。\n' +
    '不想同意：点“不同意并退出”，方寸不会调用任何模型、也不会花你的钱。'
  )
}

/** 咽喉调用：未确认直接抛；错误带 403，便于 IPC/MCP 原样回给调用方。 */
export function assertLicensed(root: string, action = '调用模型'): void {
  const st = state(root)
  if (st.acked) return
  const err = new Error(refusalMessage(action)) as Error & { code?: number; licenseRequired?: boolean }
  err.name = 'LicenseRequiredError'
  err.code = 403
  err.licenseRequired = true
  throw err
}

/** `tegula check` / 诊断用：一行说清状态（不打印任何敏感内容）。 */
export function selfCheck(root: string): { ok: boolean; message: string } {
  const st = state(root)
  if (st.bypass) return { ok: true, message: '许可协议：已按测试环境变量豁免（生产启动路径不设它）' }
  if (st.acked) {
    return { ok: true, message: `许可协议：已确认（v${st.ack?.version || LICENSE_VERSION}，${st.ack?.at || '时间未知'}，来源 ${st.ack?.source || '未知'}）` }
  }
  if (st.stale) return { ok: false, message: `许可协议：条款已更新，需要重新确认（旧记录 v${st.ack?.version || '?'} 已失效）` }
  return { ok: false, message: '许可协议：尚未确认 —— 打开桌面端会强制弹出；确认前所有 AI 功能不可用' }
}
