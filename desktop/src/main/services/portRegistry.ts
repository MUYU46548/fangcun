/**
 * Fangcun Desktop — 端口 / 服务登记与监控（2026-09-26 卡 006）
 *
 * 用户回执原文：「之前想让方寸管理端口，事实上端口从未被管理，依旧乱七八糟。」
 * 查证结论（别再从记忆猜）：
 *   - `launchpad/config.ts` 的 `LaunchApp` **早有 `port?: number` 字段，但全仓无人读**；
 *     `public/apps.json.sample` 里 4 个应用一个都没填 → "从未被管理"是字面事实。
 *   - 用户选的口径是 **A 档：只读监控 + 冲突预警**（不做"结束占用进程"）。
 *     所以本模块**永远不杀任何进程**，只回答"这个端口现在什么状态、谁占着"。
 *
 * 数据源两条（用户选 B）：
 *   ① 启动台 `apps.json` 里登记的 port（字段早就有，这里把它盘活）
 *   ② `<userData>/services.json` —— 手填的"外部服务"清单（tegula 8753 / 墨坊 8765 之类）
 *
 * 占用者怎么查：Windows 上 `netstat -ano` 一次拿到**全部** LISTENING 的 端口→PID，
 * `tasklist /FO CSV` 一次拿到 PID→进程名，再在内存里对表。每个端口各调一次命令会很慢，
 * 且 netstat 反复调用会拖住界面。
 */

import * as fs from 'fs'
import * as path from 'path'
import * as net from 'net'
import { execFile } from 'child_process'
import { app, shell } from 'electron'
import * as appLog from './appLog'
import * as launchpad from '../launchpad'

export interface ManualService {
  name: string
  port: number
  /** 可选备注（比如"Python 版方寸看板"），界面上当副标题 */
  note?: string
  project?: string
}

export interface ServiceRow {
  id: string
  name: string
  port: number
  note: string
  project: string
  /** launchpad = 启动台 apps.json 登记的；manual = 手填清单 */
  source: 'launchpad' | 'manual'
  listening: boolean
  pid: number | null
  processName: string
  /** 同一端口在清单里出现多次（真实冲突，必须预警） */
  duplicated: boolean
}

export interface UnregisteredRow {
  port: number
  pid: number | null
  processName: string
}

/**
 * 「像服务/开发进程」的进程名白名单（2026-09-26）。
 *
 * 为什么需要它：`netstat` 会把**整机**监听端口都给出来 —— 实测一次就倒出 14 个，
 * 里面是 QQ（4001/4301/5283/9210/9410）、svchost、System、msedge 的 devtools（9222）。
 * 用户选的是 B 档（"启动台 + 手填清单"），不是"全盘扫描全列出来" —— 所以这里收窄到
 * **有可能被他管的那些**（node/python/java… 起来的服务），并把滤掉的数量如实报出来
 * （`hiddenCount`），绝不静默隐藏。
 */
const SERVERISH = /^(node|python|pythonw|py|java|javaw|dotnet|go|bun|deno|ruby|php|nginx|caddy|httpd|docker|dockerd|postgres|mysqld?|redis-server|mongod|uvicorn|gunicorn|hypercorn|vite|electron|watchman|code)$/i

/**
 * 一键启动某个登记端口对应的**启动台应用**（2026-09-26 用户回执：
 * 「服务页没看到 8090 有动静」—— 页面是对的（那天 vite 真退了），但光显示"空闲"不解决问题，
 * 得能当场把它拉起来）。
 *
 * 安全线：**只认启动台里带 port 的应用**；端口对不上就拒绝，方寸不会替用户拉起陌生东西，
 * 也永远不会"杀"任何进程（本模块全程只读 + 这一处 spawn 走的是启动台既有执行器）。
 */
export async function startService(port: number): Promise<{ ok: boolean; message: string }> {
  const n = Number(port)
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return { ok: false, message: `端口不合法：${port}` }
  let target: any = null
  try { target = (launchpad.loadApps() || []).find((a: any) => Number(a.port) === n) } catch (e: any) {
    return { ok: false, message: `读启动台配置失败：${e?.message || e}` }
  }
  if (!target) return { ok: false, message: `端口 ${n} 不在启动台登记里，方寸不替你启动别的程序（可在启动台里给它填 port）` }
  try {
    const r: any = await (launchpad as any).launchApp(target)
    const ok = !!(r && r.ok)
    return { ok, message: (r && r.message) || (ok ? `已启动「${target.name}」` : `启动「${target.name}」失败`) }
  } catch (e: any) {
    appLog.error('services', '启动服务失败', e?.stack || e)
    return { ok: false, message: `启动失败：${e?.message || e}` }
  }
}

export function isServerishProcess(name: string): boolean {
  const n = String(name || '').trim().replace(/\.exe$/i, '')
  if (!n) return false
  return SERVERISH.test(n)
}

export interface ServicesPayload {
  ok: boolean
  error?: string
  rows: ServiceRow[]
  /** 正在监听、但不在登记表里、且**像是服务**的端口（提示可以登记进来） */
  unregistered: UnregisteredRow[]
  /** 被过滤掉的监听端口数（系统进程/聊天软件等）—— 如实报出，不静默隐藏 */
  hiddenCount: number
  listeningCount: number
  idleCount: number
  duplicatePorts: number[]
  servicesJsonPath: string
  appsJsonPath: string
}

// ── 手填清单（services.json）────────────────────────────────────────────

function getServicesJsonPath(): string {
  return path.join(app.getPath('userData'), 'services.json')
}

function getAppsJsonPath(): string {
  return path.join(app.getPath('userData'), 'apps.json')
}

export function readManualServices(): { ok: boolean; services: ManualService[]; error?: string } {
  const p = getServicesJsonPath()
  if (!fs.existsSync(p)) return { ok: true, services: [] }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    const arr = Array.isArray(data?.services) ? data.services : []
    const services: ManualService[] = []
    for (const s of arr) {
      const port = Number(s?.port)
      const name = String(s?.name ?? '').trim()
      if (!name || !Number.isInteger(port) || port < 1 || port > 65535) continue
      services.push({ name, port, note: String(s?.note ?? ''), project: String(s?.project ?? '') })
    }
    return { ok: true, services }
  } catch (e) {
    // 坏文件不静默当空：报出来（但也不能让整个页面崩）
    return { ok: false, services: [], error: `services.json 解析失败：${(e as Error).message}` }
  }
}

function writeManualServices(services: ManualService[]): { ok: boolean; error?: string } {
  const p = getServicesJsonPath()
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = `${p}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ services }, null, 2), 'utf-8')
    fs.renameSync(tmp, p)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function addManualService(input: ManualService): { ok: boolean; error?: string } {
  const name = String(input?.name ?? '').trim()
  const port = Number(input?.port)
  if (!name) return { ok: false, error: '服务名不能为空' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: `端口不合法：${input?.port}（要 1-65535 的整数）` }
  const cur = readManualServices()
  if (!cur.ok) {
    // 坏文件上绝不静默重写：那会把里面原有的登记**整段吞掉**（数据安全铁律）
    return { ok: false, error: `${cur.error} —— 先修好或删掉 ${getServicesJsonPath()} 再登记（原文件没动）` }
  }
  if (cur.services.some(s => s.port === port)) return { ok: false, error: `${port} 已经在清单里了` }
  const next = cur.services.concat([{ name, port, note: String(input?.note ?? ''), project: String(input?.project ?? '') }])
  const w = writeManualServices(next)
  if (!w.ok) return w
  appLog.info('services', `登记端口 ${port}（${name}）`)
  return { ok: true }
}

export function removeManualService(port: number): { ok: boolean; error?: string } {
  const p = Number(port)
  const cur = readManualServices()
  if (!cur.ok) return { ok: false, error: `${cur.error} —— 先修好或删掉 ${getServicesJsonPath()}（原文件没动）` }
  if (!cur.services.some(s => s.port === p)) return { ok: false, error: `${p} 不在手填清单里（启动台登记的要改 apps.json）` }
  const w = writeManualServices(cur.services.filter(s => s.port !== p))
  if (!w.ok) return w
  appLog.info('services', `移除登记端口 ${p}`)
  return { ok: true }
}

// ── 占用者查询（只读，绝不杀进程）──────────────────────────────────────

function runCmd(cmd: string, args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise(resolve => {
    try {
      execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => {
        resolve(String(stdout || ''))
      })
    } catch {
      resolve('')
    }
  })
}

/** netstat -ano → Map<端口, PID>（只看 LISTENING） */
async function buildListenMap(): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const text = await runCmd('netstat', ['-ano', '-p', 'TCP'])
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S*?:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line)
    if (!m) continue
    const port = Number(m[1])
    const pid = Number(m[2])
    if (Number.isInteger(port) && Number.isInteger(pid) && !out.has(port)) out.set(port, pid)
  }
  return out
}

/** tasklist → Map<PID, 进程名> */
async function buildProcessMap(): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const text = await runCmd('tasklist', ['/FO', 'CSV', '/NH'])
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split('","').map(c => c.replace(/^"|"$/g, ''))
    if (cells.length < 2) continue
    const name = cells[0]
    const pid = Number(cells[1])
    if (name && Number.isInteger(pid)) out.set(pid, name.replace(/\.exe$/i, ''))
  }
  return out
}

/** 兜底：netstat 不可用时用一次 TCP 连接探活（拿不到 PID 就留空） */
function probeByConnect(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise(resolve => {
    let done = false
    const finish = (v: boolean) => { if (!done) { done = true; try { sock.destroy() } catch { /* ignore */ } resolve(v) } }
    const sock = net.connect({ host: '127.0.0.1', port })
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
    sock.once('timeout', () => finish(false))
  })
}

/**
 * 「未登记但正在监听」要过滤掉系统噪声：
 * 排除 <1024 的特权端口（系统服务）与 49152-65535 的 RPC 动态端口（Windows 上几十个）。
 * 剩下的（比如 3000/8080/8753/8765）才是用户自己起的服务。
 */
function isInterestingPort(port: number): boolean {
  return port >= 1024 && port <= 49151
}

// ── 汇总 ────────────────────────────────────────────────────────────────

export async function listServices(): Promise<ServicesPayload> {
  const manual = readManualServices()
  const out: ServicesPayload = {
    // ⚠ 坏文件必须显式 ok=false（2026-09-26 测试抓出来的真 bug）：
    //   渲染层是「ok===false 才把 error 摆到页面上」，所以 ok 留 true 时
    //   用户会看到一个空的清单、却看不到"文件坏了"这个原因 —— 静默失败。
    ok: manual.ok,
    error: manual.ok ? undefined : manual.error,
    rows: [],
    unregistered: [],
    hiddenCount: 0,
    listeningCount: 0,
    idleCount: 0,
    duplicatePorts: [],
    servicesJsonPath: getServicesJsonPath(),
    appsJsonPath: getAppsJsonPath(),
  }

  // 启动台登记（有 port 的才算）
  let apps: any[] = []
  try {
    const p = getAppsJsonPath()
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
      apps = Array.isArray(data?.apps) ? data.apps : []
    }
  } catch (e) {
    out.ok = false
    out.error = (out.error ? out.error + '；' : '') + `apps.json 解析失败：${(e as Error).message}`
  }

  const seeds: Omit<ServiceRow, 'listening' | 'pid' | 'processName' | 'duplicated'>[] = []
  for (const a of apps) {
    const port = Number(a?.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    seeds.push({
      id: `app:${String(a?.id ?? a?.name ?? port)}`,
      name: String(a?.name ?? '(未命名应用)'),
      port,
      note: String(a?.description ?? ''),
      project: '',
      source: 'launchpad',
    })
  }
  for (const s of manual.services) {
    seeds.push({ id: `manual:${s.port}`, name: s.name, port: s.port, note: String(s.note ?? ''), project: String(s.project ?? ''), source: 'manual' })
  }

  const listen = await buildListenMap()
  let proc = new Map<number, string>()
  if (listen.size) proc = await buildProcessMap()

  const byPort = new Map<number, number>()
  for (const s of seeds) byPort.set(s.port, (byPort.get(s.port) || 0) + 1)
  out.duplicatePorts = [...byPort.entries()].filter(([, n]) => n > 1).map(([p]) => p).sort((a, b) => a - b)

  for (const s of seeds) {
    let pid: number | null = listen.has(s.port) ? (listen.get(s.port) as number) : null
    let listening = pid !== null
    if (!listen.size) listening = await probeByConnect(s.port)   // netstat 拿不到时的兜底
    const processName = pid !== null ? (proc.get(pid) || '未知进程') : ''
    out.rows.push({ ...s, listening, pid, processName, duplicated: (byPort.get(s.port) || 0) > 1 })
    if (listening) out.listeningCount++
    else out.idleCount++
  }
  out.rows.sort((a, b) => a.port - b.port)

  const registered = new Set(seeds.map(s => s.port))
  const unreg: UnregisteredRow[] = []
  let hidden = 0
  for (const [port, pid] of listen) {
    if (registered.has(port)) continue
    const processName = proc.get(pid) || '未知进程'
    // 两道滤网：端口段（滤掉系统端口与 RPC 动态端口）+ 进程名（滤掉聊天软件/系统组件）
    if (!isInterestingPort(port) || !isServerishProcess(processName)) {
      hidden++
      continue
    }
    unreg.push({ port, pid, processName })
  }
  out.hiddenCount = hidden
  unreg.sort((a, b) => a.port - b.port)
  out.unregistered = unreg

  return out
}

/** 打开 http://127.0.0.1:<port>（只允许打开登记过的端口） */
export async function openService(port: number): Promise<{ ok: boolean; url?: string; error?: string }> {
  const p = Number(port)
  const payload = await listServices()
  const row = payload.rows.find(r => r.port === p)
  if (!row) return { ok: false, error: `${p} 不在登记清单里 —— 先在页面上登记它再打开` }
  const url = `http://127.0.0.1:${p}/`
  try {
    await shell.openExternal(url)
    return { ok: true, url }
  } catch (e) {
    return { ok: false, url, error: (e as Error)?.message || String(e) }
  }
}

/** 把"未登记但正在监听"的端口登记进手填清单（名字默认取占用它的进程名） */
export function adoptUnregistered(port: number, name?: string): { ok: boolean; error?: string } {
  const p = Number(port)
  return addManualService({ name: (name && name.trim()) || `端口 ${p}`, port: p, note: '从"未登记但正在监听"里登记' })
}
