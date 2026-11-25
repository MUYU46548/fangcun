/**
 * 记忆 v3 · 作用域模型（2026-11-25 · P16.3）
 *
 * 为什么要有作用域（抄 `harm-m422/dsh-memory` 的四类作用域，用户 2026-11-25 定：自建）：
 * 扁平模型（dsh-diary）的死因是「有用的被最新 6 条挤掉，不相关的一直占着」——
 * **写时定域优于读时过滤**。一条记忆写进去时就该知道它属于：
 *
 *   · `world`            全局常驻：跨项目的纪律 / 用户偏好 / 环境事实
 *   · `topic:<名字>`     长期线：某个项目 / 某个主题的来龙去脉
 *   · `file:<路径>`      某个文件上次做到哪（工具参数自动绑定用）
 *   · `session:<id>`     本次会话的方向（不跨会话）
 *
 * 兼容：v2 条目没有 `作用域` 字段 → 视为 `world`（不改变任何旧数据的语义）。
 * 本模块只做**纯解析/判断**，不碰磁盘、不碰 electron。
 */

export type MemoryScopeKind = 'world' | 'topic' | 'file' | 'session'

export interface MemoryScope {
  kind: MemoryScopeKind
  /** world 为空串；其余是冒号后的值 */
  value: string
}

const KINDS: readonly MemoryScopeKind[] = ['world', 'topic', 'file', 'session']

/** 把 `world` / `topic:名字` / `file:路径` / `session:id` 解成结构；非法返回 null。 */
export function parseScope(raw: unknown): MemoryScope | null {
  if (raw === undefined || raw === null) return { kind: 'world', value: '' }
  const text = String(raw).trim()
  if (!text) return { kind: 'world', value: '' }
  if (text === 'world') return { kind: 'world', value: '' }
  const at = text.indexOf(':')
  if (at <= 0) return null
  const kind = text.slice(0, at).trim().toLowerCase()
  const value = text.slice(at + 1).trim()
  if (!KINDS.includes(kind as MemoryScopeKind)) return null
  if (!value) return null
  if (kind === 'world') return null
  // file 路径统一成 `/`，并拒绝逃逸；只做规范化，不解析相对路径（那是写入方的事）
  if (kind === 'file') {
    const p = value.replace(/\\/g, '/')
    if (p.includes('..')) return null
    return { kind: 'file', value: p }
  }
  return { kind: kind as MemoryScopeKind, value }
}

/** 结构 → 落盘文本。 */
export function formatScope(scope: MemoryScope | null | undefined): string {
  if (!scope || scope.kind === 'world') return 'world'
  return `${scope.kind}:${scope.value}`
}

/**
 * 从 frontmatter 读作用域。认 `作用域`（v3）与 `scope`（英文别名，给外部工具写）。
 * 读不出/非法 → `world`（宁可宽，不要因为一个坏字段把条目变不可见）。
 */
export function scopeOfEntry(fm: Record<string, unknown> | null | undefined): MemoryScope {
  const raw = fm ? (fm['作用域'] ?? fm['scope']) : undefined
  const parsed = parseScope(raw)
  if (parsed) return parsed
  return { kind: 'world', value: '' }
}

/** 格式版本：`格式: 3` → 3；缺省/`2` → 2；其它按 2 处理并在调用方报坏值。 */
export function formatVersion(fm: Record<string, unknown> | null | undefined): number {
  const raw = fm ? fm['格式'] : undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 3 ? 3 : 2
}

export function isV3Entry(fm: Record<string, unknown> | null | undefined): boolean {
  return formatVersion(fm) >= 3
}

/**
 * 一次检索带了一组"当前活跃作用域"，某条记忆是否该被带回：
 *   · world 永远匹配（它是全局常驻）；
 *   · 其它必须 kind + value 完全相同（不做前缀/模糊匹配 —— 那会把两个项目串味）。
 */
export function scopeMatches(entry: MemoryScope, active: readonly MemoryScope[]): boolean {
  if (entry.kind === 'world') return true
  return active.some((a) => a.kind === entry.kind && a.value === entry.value)
}

/** 给调用方拼活跃作用域：world 可以省略（它恒匹配）。 */
export function activeScopes(list: Array<unknown>): MemoryScope[] {
  const out: MemoryScope[] = []
  for (const raw of list) {
    const s = parseScope(raw)
    if (s && s.kind !== 'world') out.push(s)
  }
  return out
}
