/**
 * JSON 输出体检（2026-11-07）—— 把"模型没给 JSON"拆成**能对症的三类**。
 *
 * 为什么要有（`docs/投入产出-第一条真事实-20261107.md` 的第三条事实）：
 *   方寸自己的 10 次 AI 调用里 5 次失败，而且**全部失败在同一个点** ——
 *   `plan-draft` 3 挂 2（"模型没有返回内容" / "输出里没有 JSON 对象"）、
 *   `archGenerate` 2 挂 2（`JSON 解析失败：Expected ',' or ']'`）。
 *   过去这三类的错误文案只说了"失败"，没人能一眼看出该改什么：
 *     · `no_content` —— 模型一个字没吐（额度/超时/被风控）→ 重试有意义；
 *     · `not_json`   —— 吐了但满篇散文（提示词没说清/被长解释带跑）→ **补一句"只输出 JSON"再要一次**；
 *     · `truncated`  —— 说到一半被 max_tokens 掐了 → 再要一次**更小的**输出，不是"注意格式"；
 *     · `invalid`    —— 结构对但内容坏（少逗号等）→ 视同 not_json。
 *   分型的价值不在文案好看，在于**重试策略不同**：三类都写"生成失败"，就只能盲目重试。
 *
 * 纯函数、零依赖 —— `e2e-json-repair.cjs` 直接喂各种脏输出验。
 */

export type JsonFailKind = 'no_content' | 'not_json' | 'truncated' | 'invalid'

export interface JsonShape {
  /** 抠出来的候选 JSON 文本（找不到就是空串） */
  body: string
  /** 空串 = 能直接 JSON.parse；否则是失败类型 */
  kind: '' | JsonFailKind
  /** 给人看的一句话（必须说清坏在哪一步） */
  message: string
}

/** 去掉 ```json 围栏（模型最爱加的包装） */
function stripFence(text: string): string {
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  return m ? m[1].trim() : text
}

/**
 * 判一段模型输出是什么形状。
 * ⚠ 只判断"能不能 parse"，**不修**（补全交给调用方自己的 repair，因为补全策略与技术栈有关）。
 *
 * ⚠ 2026-11-07 修正：判断"截断"不能用 `lastIndexOf('}')` ——
 *   `{"nodes":[{"id":"a"` 这种在**数组中途**断掉的输出，最后一个 `}` 是内层对象的，
 *   `lastIndexOf` 会以为"闭合了"，于是被判成 `invalid`（坏结构），
 *   而它真正的原因是**话没说完**（该让模型少写点），重试指令完全不同。
 *   所以这里做**配平扫描**（跳过字符串内的括号），深度没回到 0 就是截断。
 */
export function inspectJson(text: string): JsonShape {
  const raw = String(text || '').trim()
  if (!raw) return { body: '', kind: 'no_content', message: '模型没有返回内容（一个字都没有）' }
  const body = stripFence(raw)
  const start = body.indexOf('{')
  if (start < 0) {
    return { body: '', kind: 'not_json', message: `模型回了 ${raw.length} 个字符，但里面没有 JSON 对象` }
  }
  const tail = body.slice(start)
  // 配平扫描：找到第一个让深度归零的位置（= 完整 JSON 的结尾）
  let depthObj = 0
  let depthArr = 0
  let inStr = false
  let esc = false
  let closeAt = -1
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') depthObj++
    else if (c === '}') depthObj--
    else if (c === '[') depthArr++
    else if (c === ']') depthArr--
    if (depthObj === 0 && depthArr === 0) { closeAt = i; break }
  }
  if (closeAt < 0) {
    return {
      body: tail,
      kind: 'truncated',
      // 保留「不完整」三个字：既有断言（e2e-plan-draft 的"坏 JSON 明确报错"）
      // 从 0.6.0 起就认这个词，分型改造不该把一条老判据悄悄废掉。
      message: `输出在 JSON 中途结束、JSON 不完整（很可能被 max_tokens 截断）：已写 ${tail.length} 个字符仍未闭合`,
    }
  }
  const cand = tail.slice(0, closeAt + 1)
  try {
    JSON.parse(cand)
    return { body: cand, kind: '', message: '' }
  } catch (e: any) {
    return { body: cand, kind: 'invalid', message: `JSON 结构坏了：${e?.message || e}` }
  }
}

/**
 * 重试时该对模型说什么 —— **按类型给不同指令**，这才是分型的用处。
 * 三类都写"请输出合法 JSON"，模型会照旧给你一段散文加一句"我保证是 JSON"。
 */
export function jsonRetryNudge(kind: string): string {
  switch (kind) {
    case 'no_content':
      return '上一次你一个字都没返回。请直接输出 JSON 对象本身，不要任何前言。'
    case 'truncated':
      return '上一次输出在 JSON 中途被截断了。请**减少条目数量**（同类条目砍到最少），确保 JSON 完整闭合，最后一个字符必须是 }。'
    case 'invalid':
      return '上一次的 JSON 结构坏了（引号/逗号/括号）。请重新输出一个**结构正确**的 JSON，不要在字符串里放未转义的换行。'
    case 'not_json':
    default:
      return '上一次返回里没有 JSON 对象。**只输出一个 JSON 对象**，不要解释文字、不要 Markdown 围栏、不要"好的，我来分析"。'
  }
}
