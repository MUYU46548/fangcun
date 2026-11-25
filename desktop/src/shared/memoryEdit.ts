/**
 * 记忆 v3 · 编辑防呆（2026-11-25 · P16.3）
 *
 * 抄 `harm-m422/dsh-memory` 的 `memory_fact edit`：**find 必须在原文唯一出现**。
 *   · 0 次  → 「没动」（不是错误：目标已经不在，调用方知道就行）
 *   · 多次  → **报错拒绝**（防改错地方 —— 这是本模块存在的唯一理由）
 *   · 1 次  → 只替换那一处，其余字节原样
 *
 * 为什么不用正则：调用方给的是原文片段，不是模式；转义规则一多就变成"改错地方"的
 * 新来源。这里只做纯字符串定位，规则只有一条：**唯一才动**。
 *
 * 本模块是纯函数；落盘 + `.bak` 由调用方（主进程服务）负责。
 */

export type UniqueMatchStatus = 'missing' | 'multiple' | 'ok'

export interface UniqueMatch {
  status: UniqueMatchStatus
  /** 唯一命中时的起点；missing/multiple 为 -1 */
  index: number
  /** 命中次数（0 / ≥2 / 1） */
  count: number
}

/** 在原文里找 find：唯一才算 ok。 */
export function locateUnique(haystack: string, find: string): UniqueMatch {
  const text = String(haystack == null ? '' : haystack)
  const needle = String(find == null ? '' : find)
  if (!needle) return { status: 'missing', index: -1, count: 0 }
  const first = text.indexOf(needle)
  if (first < 0) return { status: 'missing', index: -1, count: 0 }
  // 第一次之后还有没有第二次：有就是多次（不数总数，够了就拒）
  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return { status: 'multiple', index: -1, count: 2 }
  return { status: 'ok', index: first, count: 1 }
}

export interface UniqueEditResult {
  ok: boolean
  /** 替换后的全文（ok=false 时原样返回） */
  text: string
  /** 真的改了一个字节以上 */
  changed: boolean
  error?: string
}

/**
 * 唯一命中才替换；多次命中直接拒绝；0 次视为「没动」。
 * 不写盘、不备份 —— 调用方负责 `.bak` 与原子写。
 */
export function replaceUnique(text: string, find: string, replace: string): UniqueEditResult {
  const source = String(text == null ? '' : text)
  const hit = locateUnique(source, find)
  if (hit.status === 'missing') return { ok: true, text: source, changed: false }
  if (hit.status === 'multiple') {
    return {
      ok: false,
      text: source,
      changed: false,
      error: 'find 命中多次，拒绝改（防改错地方）；请给更长的唯一片段',
    }
  }
  const next = source.slice(0, hit.index) + String(replace == null ? '' : replace) + source.slice(hit.index + find.length)
  return { ok: true, text: next, changed: next !== source }
}
