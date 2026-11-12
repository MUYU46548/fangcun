/**
 * 内容量闸（2026-11-12 暮雨：记忆圣所那两间房不该留着，
 * 而且「连整个游戏的玩法本身可能都有问题，撑不起那么大的内容量」）
 *
 * 这条闸不判断好坏（那要审美，机器判不了）。它判断的是**顺序**：
 *   核心玩法还没被人确认"立得住"，就不许往上铺几小时的内容。
 *
 * 为什么非要这么判：
 *   记忆圣所 2026-11-12 一天出了 6 份设计稿，最后那份写「总时长 4–5 小时，三幕」，
 *   而核心循环从没被任何人确认过值得玩。方寸所有闸照样放行 —— 因为它的判据全是
 *   「文件存在 / 三元组齐不齐」，这种判据对"铺错了量级"完全无感。
 *   于是 AI 可以一路通过所有检查，把内容堆到五小时，而没人问过核心能不能撑住。
 *
 * 判据形状刻意做成**确定性**的，不调模型、不猜：
 *   ① 从计划/阶段卡文本里抽出**声称的内容量**（小时数 / 幕数 / 房间数 / 章节数）；
 *   ② 看这个项目有没有**人给过"核心立得住"的判词**；
 *   ③ 没有判词 + 声称量超过上限 ⇒ 拦下来，并说清"先验证核心，别铺量"。
 *
 * ⚠ 本文件零 Vue / 零 DOM / 零 IO，纯函数 —— 所以能被测试直接断言。
 */
import { UNJUDGED, VERDICT_KEYS, VERDICT_LEVELS, verdictAllowsScale } from './coreVerdict'

/** 核心未验证时允许的最大内容量（超过就要判词） */
export const UNCORE_LIMITS = {
  /** 小时 */
  hours: 0.5,
  /** 幕 / 章节 */
  acts: 1,
  /** 房间 / 关卡 */
  rooms: 1,
}

/** 人给过的判词档位：只有 allowsScale 的档位算"核心立得住"（词表唯一真源见 shared/coreVerdict） */
export type CoreVerdict = string

export interface ScaleClaim {
  /** 抽出来的量，键为 hours / acts / rooms；没提到就是不存在 */
  hours?: number
  acts?: number
  rooms?: number
  /** 命中原文（报错时要能指出"你这句话说的"） */
  evidence?: string[]
}

export interface ScaleGateResult {
  ok: boolean
  /** 抽到的量 */
  claim: ScaleClaim
  /** 人的判词 */
  verdict: CoreVerdict
  /** ok=false 时给用户看的一句话 */
  error?: string
  /** ok=false 时的行动建议（不是"改判据"，是"先验证核心"） */
  hint?: string
}

const RE_HOURS = /(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:小时|钟头)/g
const RE_ACT_RANGE = /(\d+)\s*[–\-~—]\s*(\d+)\s*幕/g
const RE_ACTS = /(\d+)\s*幕/g
const RE_ROOM_RANGE = /(\d+)\s*[–\-~—]\s*(\d+)\s*(?:间|个)?\s*房/g
const RE_ROOMS = /(\d+)\s*(?:间|个)\s*房/g
/** 「七间房」这类中文数字也认（设计稿真的这么写） */
const CN_DIGIT: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}
const RE_ROOMS_CN = /([一二三四五六七八九十])\s*间\s*房/g
/** 「七（房间）」这种把量词塞进括号的写法，设计稿真的这么写 */
const RE_ROOMS_CN_PAREN = /([一二三四五六七八九十])\s*[（(]\s*房/g
const RE_ACTS_CN = /([一二三四五六七八九十])\s*幕/g

/**
 * 从一段文本里抽出"声称了多大内容量"。
 * 取**最大值**：一份规划里既写"20–30 分钟"又写"4–5 小时"，按 4–5 小时算。
 */
export function extractScale(text: string): ScaleClaim {
  const s = String(text || '')
  const ev: string[] = []
  const claim: ScaleClaim = {}

  let v: number | undefined
  for (const m of s.matchAll(RE_HOURS)) {
    const n = Number(m[1])
    if (Number.isFinite(n) && (v === undefined || n > v)) {
      v = n
      ev.push(m[0].trim())
    }
  }
  if (v !== undefined) claim.hours = v

  // 范围 "3–5 幕" 取上限
  let acts: number | undefined
  for (const m of s.matchAll(RE_ACT_RANGE)) {
    const n = Math.max(Number(m[1]), Number(m[2]))
    if (Number.isFinite(n) && (acts === undefined || n > acts)) { acts = n; ev.push(m[0].trim()) }
  }
  for (const m of s.matchAll(RE_ACTS)) {
    const n = Number(m[1])
    if (Number.isFinite(n) && (acts === undefined || n > acts)) { acts = n; ev.push(m[0].trim()) }
  }
  for (const m of s.matchAll(RE_ACTS_CN)) {
    const n = CN_DIGIT[m[1]]
    if (n && (acts === undefined || n > acts)) { acts = n; ev.push(m[0].trim()) }
  }
  if (acts !== undefined) claim.acts = acts

  let rooms: number | undefined
  for (const m of s.matchAll(RE_ROOM_RANGE)) {
    const n = Math.max(Number(m[1]), Number(m[2]))
    if (Number.isFinite(n) && (rooms === undefined || n > rooms)) { rooms = n; ev.push(m[0].trim()) }
  }
  for (const m of s.matchAll(RE_ROOMS)) {
    const n = Number(m[1])
    if (Number.isFinite(n) && (rooms === undefined || n > rooms)) { rooms = n; ev.push(m[0].trim()) }
  }
  for (const m of s.matchAll(RE_ROOMS_CN)) {
    const n = CN_DIGIT[m[1]]
    if (n && (rooms === undefined || n > rooms)) { rooms = n; ev.push(m[0].trim()) }
  }
  for (const m of s.matchAll(RE_ROOMS_CN_PAREN)) {
    const n = CN_DIGIT[m[1]]
    if (n && (rooms === undefined || n > rooms)) { rooms = n; ev.push(m[0].trim() + '间房）') }
  }
  if (rooms !== undefined) claim.rooms = rooms

  if (ev.length) claim.evidence = Array.from(new Set(ev))
  return claim
}

/** 判词是否等于"核心立得住"（判定依据来自 shared/coreVerdict，本文件不重复词表） */
export function coreVerified(verdict: CoreVerdict): boolean {
  return verdictAllowsScale(verdict)
}

/**
 * 内容量闸。
 * @param text 计划卡 / 阶段卡 / 草案正文
 * @param verdict 人给这个项目核心玩法的判词（空 = 没判过）
 */
export function contentScaleGate(text: string, verdict: CoreVerdict): ScaleGateResult {
  const claim = extractScale(text)
  const v = String(verdict || '').trim()

  const over: string[] = []
  if (claim.hours !== undefined && claim.hours > UNCORE_LIMITS.hours) over.push(`${claim.hours} 小时`)
  if (claim.acts !== undefined && claim.acts > UNCORE_LIMITS.acts) over.push(`${claim.acts} 幕`)
  if (claim.rooms !== undefined && claim.rooms > UNCORE_LIMITS.rooms) over.push(`${claim.rooms} 间房`)

  if (!over.length) return { ok: true, claim, verdict: v }

  if (coreVerified(v)) {
    // 判过且立得住 —— 铺量是被允许的，这里只如实回报抽到了什么
    return { ok: true, claim, verdict: v }
  }

  // 「被判为否定档」这个语义从词表派生，不写死具体词
  const denied = VERDICT_LEVELS.find((x) => !x.allowsScale && x.key !== UNJUDGED)
  const why = (denied && v.startsWith(denied.key))
    ? `这个方向已经被判为「${denied.key}」`
    : '核心玩法从来没被人判过一句'
  return {
    ok: false,
    claim,
    verdict: v,
    error: `这一格声称要做 ${over.join(' / ')}，但${why} —— 没有判词就铺这么大，`
      + '做出来的东西极可能是白费（记忆圣所 2026-11-12 的现场）。',
    hint: `先做只验证核心循环的最小原型（上限：${UNCORE_LIMITS.hours} 小时 / `
      + `${UNCORE_LIMITS.acts} 幕 / ${UNCORE_LIMITS.rooms} 间房），等暮雨给一句判词`
      + `（${VERDICT_KEYS.join(' / ')}），再决定要不要铺量。`,
  }
}


