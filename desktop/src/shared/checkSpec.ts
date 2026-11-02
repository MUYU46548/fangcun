/**
 * 判据行解析（0.6.0 P3）—— “这一条判据到底怎么机检”的纯逻辑
 *
 * 真源：`task-data/plans/<项目id>.md` 每张阶段卡“判据”区的 `- cmd:/str:/num:/file:` 行。
 * 这一层**只解析，不碰文件、不跑命令** —— 执行在 `main/checks/runner.ts`，
 * Python 侧 `tegula/checks.py` 只做同一套解析（只读镜像，不开第二执行器）。
 *
 * 三条硬口径：
 *  ① **未知前缀 = unknown**（`foo:` / `human:` / 没前缀），永远不当通过。
 *     设计稿明写：`human:` 合法但不可机检 —— 它进结果，但状态是 unknown。
 *  ② **已知前缀但没写清 = 也 unknown**。典型是 `str:` 没写目标文件、`num:` 指标认不出、
 *     `file:` 后面跟着一段没法机检的说明。宁可说"判不了"，也不猜一个结果。
 *  ③ **原样保留 raw** —— 结果面板要能指回是卡上的哪一行，不能只剩一个布尔。
 *
 * 语法（与设计稿 4.3 一致，比稿子更严一点）：
 *   cmd:  <命令>                          # 退出码 0 即通过（反引号包起来的命令也认）
 *   str:  <相对路径> 含 '<原文>'           # 引号优先；不含空格的单个词可不加引号
 *   num:  <相对路径> <指标> <比较> <数字>   # 指标：行数 / 条目数 / 字节数 / 字符数
 *   file: <相对路径或 glob> 存在[且含 '<原文>'][且每行含 '<原文>']
 *
 * ⚠ 为什么 `str:` 要求引号（或单个词）：判据是中文散文，`含三种动作分支` 这种句子
 *   机器没法判断"文件里到底该出现哪几个字"。不要求引号就会变成"拿整句去搜、必不中"，
 *   那是**假失败**，比 unknown 更误导。
 */

export type CheckKind = 'cmd' | 'str' | 'num' | 'file'
export type CheckState = 'pass' | 'fail' | 'unknown'

/** `num:` 支持的文件指标（都是可复算的，不猜业务含义） */
export type NumMetric = 'lines' | 'entries' | 'bytes' | 'chars'
export type NumOp = '>=' | '<=' | '==' | '!=' | '>' | '<'

export interface BaseCheck {
  /** 卡上的原文（去掉列表符号与首尾空白） */
  raw: string
  kind: CheckKind | 'unknown'
}
export interface CmdCheck extends BaseCheck { kind: 'cmd'; command: string }
export interface StrCheck extends BaseCheck { kind: 'str'; path: string; text: string }
export interface NumCheck extends BaseCheck {
  kind: 'num'
  path: string
  metric: NumMetric
  /** 卡上写的指标原文（行数 / 条目数…），结果面板回显用 */
  metricText: string
  op: NumOp
  expected: number
}
export interface FileCheck extends BaseCheck {
  kind: 'file'
  pattern: string
  requireExists: boolean
  contains?: string
  everyLineContains?: string
}
export interface UnknownCheck extends BaseCheck {
  kind: 'unknown'
  /** 为什么判不了 —— 必须能直接贴回卡上，不许只说"格式错误" */
  reason: string
}
export type ParsedCheck = CmdCheck | StrCheck | NumCheck | FileCheck | UnknownCheck

const KNOWN = new Set(['cmd', 'str', 'num', 'file'])

/** 去掉 Markdown 列表符号与首尾空白（卡里读出来是 `cmd: …`，但容忍被人加 `- `） */
export function normalizeCheckLine(raw: string): string {
  return String(raw ?? '').replace(/^\s*[-*+]\s+/, '').trim()
}

function unknown(raw: string, reason: string): UnknownCheck {
  return { kind: 'unknown', raw, reason }
}

const QUOTE_PAIRS: Array<[string, string]> = [
  ["'", "'"], ['"', '"'], ['`', '`'], ['“', '”'], ['『', '』'],
]

/** 整段被一对引号包着 → 返回里面的原文；否则 null */
export function unquoteFull(s: string): string | null {
  const t = String(s ?? '').trim()
  for (const [a, b] of QUOTE_PAIRS) {
    if (t.length >= a.length + b.length && t.startsWith(a) && t.endsWith(b)) {
      return t.slice(a.length, t.length - b.length)
    }
  }
  return null
}

/**
 * 判据里的“要匹配的原文”：必须整段带引号，或不含空格的单个词。
 * 两样都不是 → null（调用方据此给 unknown，而不是拿整句去搜）
 */
export function parseLiteral(s: string): string | null {
  const t = String(s ?? '').trim()
  if (!t) return null
  const q = unquoteFull(t)
  if (q !== null) return q
  if (!/\s/.test(t)) return t
  return null
}

/** `行数` / `lines` → lines；认不出 → null（不糊一个默认指标） */
export function parseMetric(s: string): NumMetric | null {
  const k = String(s ?? '').trim().toLowerCase()
  if (k === '行数' || k === 'lines' || k === 'line') return 'lines'
  if (k === '条目数' || k === 'entries' || k === 'items') return 'entries'
  if (k === '字节数' || k === 'bytes') return 'bytes'
  if (k === '字符数' || k === 'chars') return 'chars'
  return null
}

export function normalizeOp(s: string): NumOp | null {
  const k = String(s ?? '').trim()
  if (k === '>=' || k === '≥') return '>='
  if (k === '<=' || k === '≤') return '<='
  if (k === '=' || k === '==' || k === '＝') return '=='
  if (k === '!=' || k === '≠') return '!='
  if (k === '>') return '>'
  if (k === '<') return '<'
  return null
}

/** 判据里写的文件都必须是**相对路径** —— 绝对路径换台机器就失效（也不该让判据乱翻盘） */
function looksRelativePath(p: string): boolean {
  const t = String(p ?? '').trim()
  if (!t) return false
  if (/^[A-Za-z]:[\\/]/.test(t)) return false
  if (t.startsWith('/') || t.startsWith('\\')) return false
  return /[\\/]/.test(t) // 至少要像条路径（`本文件` 这种指代不认）
}

/**
 * `cmd:` 后面取命令：
 *   · 反引号开头 → 取反引号里的那段（卡上的写法：`` `node x.cjs` 退出码 0 ``）；
 *   · 否则去掉尾部的“退出码 0”与 `# 注释`（设计稿允许用注释补一句说明）。
 * 命令本身不看引号 —— `cmd: echo \`date\`` 这种反引号是 shell 替换，不该被剥。
 */
export function extractCommand(body: string): string {
  const s = String(body ?? '').trim()
  const tick = /^`([^`]+)`\s*([\s\S]*)$/.exec(s)
  if (tick) return tick[1].trim()
  let out = s.replace(/\s+#\s.*$/, '').trim()
  out = out.replace(/\s*(?:退出码|exit\s*code)\s*(?:为)?\s*0\s*$/i, '').trim()
  return out
}

/**
 * 解析一行判据。**永不抛**；判不了就返回 `kind: 'unknown'` + 可读理由。
 */
export function parseCheckLine(raw: string): ParsedCheck {
  const line = normalizeCheckLine(raw)
  const m = /^([A-Za-z]+)\s*[:：]\s*([\s\S]*)$/.exec(line)
  if (!m) {
    return unknown(line, '没有 cmd: / str: / num: / file: 前缀，机器判不了')
  }
  const prefix = m[1].toLowerCase()
  const body = m[2].trim()

  if (prefix === 'human') {
    return unknown(line, 'human: 合法，但那是“人来验”，不是可机检判据')
  }
  if (!KNOWN.has(prefix)) {
    return unknown(line, `未知前缀 ${m[1]}: —— 只认 cmd / str / num / file；未知一律 unknown，绝不当通过`)
  }

  if (prefix === 'cmd') {
    const command = extractCommand(body)
    if (!command) return unknown(line, 'cmd: 后面没有命令')
    return { kind: 'cmd', raw: line, command }
  }

  if (prefix === 'str') {
    // 含 两侧都要有空格：中文里 `本文件含 …` 这种没空格的是散文，不认
    const sm = /^(\S+)\s+(?:含|包含|contains)\s+(\S[\s\S]*)$/i.exec(body)
    if (!sm) {
      return unknown(line, "str: 只认“<相对路径> 含 '<原文>'”—— 含 两侧要有空格，原文要带引号")
    }
    const filePath = unquoteFull(sm[1]) ?? sm[1].trim()
    if (!looksRelativePath(filePath)) {
      return unknown(line, `str: 目标文件要写相对路径（拿到的是“${filePath}”；“本文件”这类指代不认）`)
    }
    const text = parseLiteral(sm[2])
    if (text === null) {
      return unknown(line, "str: 要匹配的原文请用引号括起来（或写成不含空格的单个词）—— 否则分不清原文与说明")
    }
    return { kind: 'str', raw: line, path: filePath.replace(/\\/g, '/'), text }
  }

  if (prefix === 'num') {
    const nm = /^(\S+)\s+(\S+)\s*(>=|<=|==|!=|>|<|≥|≤|＝|=)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(body)
    if (!nm) {
      return unknown(line, 'num: 只认“<相对路径> <指标> <比较> <数字>”，指标 = 行数 / 条目数 / 字节数 / 字符数')
    }
    const filePath = unquoteFull(nm[1]) ?? nm[1].trim()
    if (!looksRelativePath(filePath)) {
      return unknown(line, `num: 目标文件要写相对路径（拿到的是“${filePath}”）`)
    }
    const metric = parseMetric(nm[2])
    if (!metric) {
      return unknown(line, `num: 认不出指标“${nm[2]}”—— 只认 行数 / 条目数 / 字节数 / 字符数（不糊默认值）`)
    }
    const op = normalizeOp(nm[3])
    if (!op) return unknown(line, `num: 认不出比较符“${nm[3]}”`)
    return {
      kind: 'num', raw: line, path: filePath.replace(/\\/g, '/'),
      metric, metricText: nm[2], op, expected: Number(nm[4]),
    }
  }

  // file
  const fm = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body)
  if (!fm) return unknown(line, 'file: 后面没有路径')
  const pattern = unquoteFull(fm[1]) ?? fm[1].trim()
  if (!looksRelativePath(pattern)) {
    return unknown(line, `file: 目标要写相对路径（拿到的是“${pattern}”）`)
  }
  // 中文逗号 / 句号当空格处理，`存在，且每行含 x` 与 `存在且每行含 x` 等价
  const rest = String(fm[2] || '').trim().replace(/[，,。；;]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!rest) return { kind: 'file', raw: line, pattern: pattern.replace(/\\/g, '/'), requireExists: true }

  const forms: Array<{ re: RegExp; contains?: 'any' | 'every' }> = [
    { re: /^存在\s*且每行含\s+(\S[\s\S]*)$/, contains: 'every' },
    { re: /^存在\s*且含\s+(\S[\s\S]*)$/, contains: 'any' },
    { re: /^每行含\s+(\S[\s\S]*)$/, contains: 'every' },
    { re: /^含\s+(\S[\s\S]*)$/, contains: 'any' },
    { re: /^存在$/, contains: undefined },
  ]
  for (const f of forms) {
    const r = f.re.exec(rest)
    if (!r) continue
    const literal = f.contains ? parseLiteral(r[1]) : ''
    if (f.contains && literal === null) {
      return unknown(line, 'file: “含”后面的原文要带引号（或写成不含空格的单个词）')
    }
    const out: FileCheck = {
      kind: 'file', raw: line, pattern: pattern.replace(/\\/g, '/'), requireExists: true,
    }
    if (f.contains === 'any') out.contains = literal as string
    if (f.contains === 'every') out.everyLineContains = literal as string
    return out
  }
  return unknown(line, "file: 只认“<路径> 存在”“<路径> 存在且含 '<原文>'”“<路径> 存在且每行含 '<原文>'”")
}

/** 从一批卡上的判据行里解析（空行/纯空白自动跳过，不产生假结果） */
export function parseCheckLines(lines: string[]): ParsedCheck[] {
  return (Array.isArray(lines) ? lines : [])
    .map((l) => normalizeCheckLine(l))
    .filter((l) => l.length > 0)
    .map((l) => parseCheckLine(l))
}
