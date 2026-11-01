/**
 * 判据执行器（0.6.0 P3）—— 四类前缀真跑，产出 通过 / 未过 / 无法判定 三态
 *
 * 分工：
 *   · `shared/checkSpec.ts` 只解析（纯逻辑，Node 可直跑）；
 *   · 这里只执行（fs / child_process），**不写回计划卡** —— 写回是 P4 的事；
 *   · `tegula/checks.py` 是只读镜像（只解析不执行），不开第二执行器。
 *
 * 三条铁律：
 *  ① **未知即 unknown**：未知前缀、没写清的判据、`cmd:` 超时，一律 unknown。
 *     unknown 的 `ok` 是 false —— 调用方（P4 跨格 / P7 自检）绝不能把它当通过。
 *  ② **unknown ≠ fail**：超时不是"判据不成立"，是"这次没判出来"；
 *     结果里用 `state` 分开，面板也分开说。
 *  ③ **执行是显式调用**：没有任何"加载计划卡就顺手跑命令"的路径。P3 只出结果对象，
 *     不挂界面、不自动跑 —— 真正跑起来是用户点自检（P7）或跨格（P4）时。
 */
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import {
  parseCheckLine,
  type CheckKind,
  type CheckState,
  type NumMetric,
  type NumOp,
  type ParsedCheck,
} from '../../shared/checkSpec'

/** `cmd:` 默认超时（写死 60s；测试可传更小值，但不能大于它） */
export const DEFAULT_CMD_TIMEOUT_MS = 60_000
/** 单条命令保留的输出尾巴，避免一条日志刷爆内存 */
export const MAX_OUTPUT_CHARS = 4_000

export interface CheckEvidence {
  /** str / num / file 的目标（相对 root） */
  path?: string
  pattern?: string
  /** file: 命中的文件（相对 root） */
  matched?: string[]
  /** num: 实际值与比较式 */
  actual?: number
  expected?: number
  op?: NumOp
  metric?: NumMetric
  /** cmd: */
  command?: string
  exitCode?: number | null
  signal?: string | null
  timedOut?: boolean
  stdoutTail?: string
  stderrTail?: string
  /** str / file: 期望出现的原文 */
  text?: string
}

export interface CheckResult {
  /** 只有 state=pass 才是 true；unknown 也是 false（fail-closed） */
  ok: boolean
  state: CheckState
  kind: CheckKind | 'unknown'
  /** 一句话结论（可直接展示） */
  detail: string
  evidence: CheckEvidence
  /** 卡上的原文 —— 结果必须能指回是哪一行 */
  raw: string
}

export interface RunChecksOptions {
  /** 判据里的相对路径以它为根（项目仓库；测试传临时目录） */
  root?: string
  /** 只对 cmd: 生效；默认 60000，传更小值可加速测试；大于 60000 会被夹住 */
  timeoutMs?: number
}

/** 超时夹取：默认 60s，上限也 60s（"超时上限写死"） */
export function clampCmdTimeout(ms?: number): number {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CMD_TIMEOUT_MS
  return Math.min(Math.floor(n), DEFAULT_CMD_TIMEOUT_MS)
}

function tail(s: string, max = MAX_OUTPUT_CHARS): string {
  const t = String(s ?? '')
  return t.length <= max ? t : '…' + t.slice(t.length - max)
}

function result(
  p: ParsedCheck,
  state: CheckState,
  detail: string,
  evidence: CheckEvidence = {},
): CheckResult {
  return { ok: state === 'pass', state, kind: p.kind, detail, evidence, raw: p.raw }
}

function unknownSpec(p: ParsedCheck): CheckResult {
  const reason = p.kind === 'unknown' ? p.reason : '判据没解析出来'
  return result(p, 'unknown', reason)
}

function resolveInRoot(root: string, rel: string): string {
  return path.isAbsolute(rel) ? rel : path.join(root, rel)
}

function relToRoot(root: string, abs: string): string {
  const r = path.relative(root, abs)
  return (r || path.basename(abs)).replace(/\\/g, '/')
}

function readText(root: string, rel: string): { ok: true; text: string; abs: string } | { ok: false; error: string } {
  const abs = resolveInRoot(root, rel)
  try {
    if (!fs.existsSync(abs)) return { ok: false, error: `文件不存在：${rel}` }
    if (!fs.statSync(abs).isFile()) return { ok: false, error: `不是文件：${rel}` }
    return { ok: true, text: fs.readFileSync(abs, 'utf-8'), abs }
  } catch (e: any) {
    return { ok: false, error: `读不了文件 ${rel}：${e?.message || e}` }
  }
}

/** 极简 glob：只支持 `*` 与 `?`（不含 `**`），逐段展开；目录不存在 → 空结果 */
export function expandGlob(root: string, pattern: string): string[] {
  const parts = String(pattern || '').split(/[\\/]/).filter((s) => s && s !== '.')
  if (!parts.length) return []
  let bases = [root]
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]
    const next: string[] = []
    const hasWild = /[*?]/.test(seg)
    for (const base of bases) {
      if (!hasWild) {
        const p = path.join(base, seg)
        if (fs.existsSync(p)) next.push(p)
        continue
      }
      let names: string[] = []
      try {
        names = fs.readdirSync(base)
      } catch {
        continue
      }
      const re = new RegExp('^' + seg
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/\\\\]*')
        .replace(/\?/g, '[^/\\\\]') + '$')
      for (const n of names) if (re.test(n)) next.push(path.join(base, n))
    }
    bases = next
  }
  const files: string[] = []
  for (const p of bases) {
    try {
      if (fs.statSync(p).isFile()) files.push(p)
    } catch { /* 半路消失的忽略 */ }
  }
  return files.sort()
}

function runCommand(command: string, root: string, timeoutMs: number): Promise<{
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  error?: Error
}> {
  return new Promise((resolve) => {
    let child: any
    try {
      child = spawn(command, {
        cwd: root,
        shell: true,
        windowsHide: true,
        env: process.env,
      })
    } catch (e: any) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: e })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (r: any): void => {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = null }
      resolve(r)
    }
    // 杀进程树：Windows 上 `shell:true` 起来的是 cmd.exe，只 kill 它会把真正干活的子进程留下
    const killTree = (): void => {
      try { child.kill() } catch { /* 已经退出 */ }
      if (process.platform === 'win32' && child.pid) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        } catch { /* 尽力而为 */ }
      }
    }
    timer = setTimeout(() => {
      timedOut = true
      killTree()
      finish({ code: null, signal: 'timeout', stdout, stderr, timedOut: true })
    }, timeoutMs)
    try {
      child.stdout?.on('data', (d: any) => { stdout = tail(stdout + String(d)) })
      child.stderr?.on('data', (d: any) => { stderr = tail(stderr + String(d)) })
    } catch { /* 极端情况下流不可用也不影响 close */ }
    child.on('error', (e: Error) => {
      finish({ code: null, signal: null, stdout, stderr, timedOut: false, error: e })
    })
    child.on('close', (code: number | null, signal: string | null) => {
      finish({ code, signal, stdout, stderr, timedOut })
    })
  })
}

async function runCmd(p: ParsedCheck & { kind: 'cmd' }, opts: RunChecksOptions): Promise<CheckResult> {
  const root = opts.root || process.cwd()
  const timeoutMs = clampCmdTimeout(opts.timeoutMs)
  const r = await runCommand(p.command, root, timeoutMs)
  const evidence: CheckEvidence = {
    command: p.command,
    exitCode: r.code,
    signal: r.signal,
    timedOut: r.timedOut,
    stdoutTail: tail(r.stdout || ''),
    stderrTail: tail(r.stderr || ''),
  }
  if (r.error) {
    return result(p, 'fail', `命令起不来：${r.error.message}`, evidence)
  }
  if (r.timedOut) {
    // 超时 ≠ 判据不成立；它是"这次没判出来"
    return result(p, 'unknown', `超时（${timeoutMs}ms）—— 归 unknown，不算 fail`, evidence)
  }
  if (r.code === 0) {
    return result(p, 'pass', '退出码 0', evidence)
  }
  const why = r.signal ? `被信号 ${r.signal} 结束` : `退出码 ${r.code}`
  return result(p, 'fail', why, evidence)
}

function runStr(p: ParsedCheck & { kind: 'str' }, opts: RunChecksOptions): CheckResult {
  const root = opts.root || process.cwd()
  const read = readText(root, p.path)
  // ⚠ tsconfig strict=false 下可辨识联合不会因 `!read.ok` 收窄（见 AGENTS「踩过的坑 5」），
  //   所以这里用 `'error' in read` 让类型收窄，别指望 truthy 检查。
  if ('error' in read) return result(p, 'fail', read.error, { path: p.path, text: p.text })
  const evidence: CheckEvidence = { path: p.path, text: p.text }
  if (read.text.includes(p.text)) return result(p, 'pass', `文件含指定原文（${p.path}）`, evidence)
  return result(p, 'fail', `文件里没有这段原文：${p.path}`, evidence)
}

function countMetric(text: string, metric: NumMetric): number {
  if (metric === 'bytes') return Buffer.byteLength(text, 'utf-8')
  if (metric === 'chars') return Array.from(text).length
  const lines = text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  if (metric === 'lines') return lines.length
  // entries = Markdown 列表项（- / * / + / 1. / 1)）
  return lines.filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(l)).length
}

function compare(actual: number, op: NumOp, expected: number): boolean {
  switch (op) {
    case '>=': return actual >= expected
    case '<=': return actual <= expected
    case '==': return actual === expected
    case '!=': return actual !== expected
    case '>': return actual > expected
    case '<': return actual < expected
    default: return false
  }
}

function runNum(p: ParsedCheck & { kind: 'num' }, opts: RunChecksOptions): CheckResult {
  const root = opts.root || process.cwd()
  const read = readText(root, p.path)
  const evidence: CheckEvidence = { path: p.path, op: p.op, expected: p.expected, metric: p.metric }
  if ('error' in read) return result(p, 'fail', read.error, evidence)
  const actual = countMetric(read.text, p.metric)
  evidence.actual = actual
  const detail = `${p.metricText} = ${actual}，要求 ${p.op} ${p.expected}`
  return result(p, compare(actual, p.op, p.expected) ? 'pass' : 'fail', detail, evidence)
}

function runFile(p: ParsedCheck & { kind: 'file' }, opts: RunChecksOptions): CheckResult {
  const root = opts.root || process.cwd()
  const matches = expandGlob(root, p.pattern)
  const evidence: CheckEvidence = { pattern: p.pattern }
  if (!matches.length) {
    return result(p, 'fail', `没有匹配的文件：${p.pattern}`, evidence)
  }
  evidence.matched = matches.map((m) => relToRoot(root, m))
  if (p.contains) evidence.text = p.contains
  if (p.everyLineContains) evidence.text = p.everyLineContains

  if (p.everyLineContains) {
    const bad: string[] = []
    for (const abs of matches) {
      let text = ''
      try { text = fs.readFileSync(abs, 'utf-8') } catch (e: any) {
        return result(p, 'fail', `读不了 ${relToRoot(root, abs)}：${e?.message || e}`, evidence)
      }
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
      const missing = lines.filter((l) => !l.includes(p.everyLineContains as string))
      if (missing.length) bad.push(`${relToRoot(root, abs)} 有 ${missing.length} 行不含「${p.everyLineContains}」`)
    }
    if (bad.length) return result(p, 'fail', bad.join('；'), evidence)
    return result(p, 'pass', `${matches.length} 个文件每行都含「${p.everyLineContains}」`, evidence)
  }

  if (p.contains) {
    for (const abs of matches) {
      try {
        if (fs.readFileSync(abs, 'utf-8').includes(p.contains)) {
          return result(p, 'pass', `${relToRoot(root, abs)} 含「${p.contains}」`, evidence)
        }
      } catch { /* 下一个 */ }
    }
    return result(p, 'fail', `命中的文件都不含「${p.contains}」`, evidence)
  }

  return result(p, 'pass', `存在（命中 ${matches.length} 个文件）`, evidence)
}

/**
 * 跑一条判据。
 * `cmd:` 会执行命令（root = 项目仓库）；其余三类只读文件。
 */
export async function runCriterion(raw: string, opts: RunChecksOptions = {}): Promise<CheckResult> {
  const spec = parseCheckLine(raw)
  if (spec.kind === 'unknown') return unknownSpec(spec)
  if (spec.kind === 'cmd') return runCmd(spec, opts)
  if (spec.kind === 'str') return runStr(spec, opts)
  if (spec.kind === 'num') return runNum(spec, opts)
  return runFile(spec, opts)
}

export interface CheckRunSummary {
  results: CheckResult[]
  total: number
  passed: number
  failed: number
  unknown: number
  /** 全部通过才算 true（空清单是 false —— 没有判据等于没验过） */
  allPassed: boolean
}

/** 顺序执行（不并发）：一条命令超时不该拖垮同批其它判据，结果顺序也要和卡上一致 */
export async function runCriteria(lines: string[], opts: RunChecksOptions = {}): Promise<CheckRunSummary> {
  const results: CheckResult[] = []
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!String(line ?? '').trim()) continue
    results.push(await runCriterion(line, opts))
  }
  const passed = results.filter((r) => r.state === 'pass').length
  const failed = results.filter((r) => r.state === 'fail').length
  const unknown = results.filter((r) => r.state === 'unknown').length
  return {
    results,
    total: results.length,
    passed,
    failed,
    unknown,
    allPassed: results.length > 0 && passed === results.length,
  }
}
