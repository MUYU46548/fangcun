/**
 * 架构图生成 · 派给 DSH 并等草稿（2026-11-22 · 卡 80f271dd）
 *
 * 为什么是「写派单文件 + 等一张卡」而不是直接调 DSH：
 *  · 方寸不 import DSH、不 spawn 它（硬边界，`contextPack.dispatchToDsh` 同一套理由）；
 *  · 插件在 DSH 进程里看见派单文件才开会话，项目 cwd 由插件从 registry 解析；
 *  · 回程**没有**反向管道，所以用「DSH 建一张带 nonce 的草稿卡，方寸轮询任务库」。
 *    这条回程顺便满足产品口径：生成物落在卡上（待审批/可归档），不是凭空塞进界面。
 *
 * 判据（卡 80f271dd）：
 *  · 会话 cwd 由插件决定（不是 `_no-cwd`）—— 这里只负责把项目 id 写进任务书；
 *  · 10 秒冷却 / 总闸 / 日上限由 `dispatchMessageToDsh` 统一判（真源同一份）；
 *  · 等不到 / 派不出去 / 被取消 → 都返回**可落到界面**的失败分型，调用方降级扫描图。
 */
import type { ArchScanFacts } from '../../shared/archGraph'
import {
  archDraftTitle,
  buildArchDispatchPrompt,
  extractDraftText,
  findDraftBody,
} from '../../shared/archPrompt'
import { loadTasks } from '../data'
import { dispatchMessageToDsh } from './contextPack'
import type { ArchDispatchReply, ArchDispatchRequest } from './archAi'

/** 等草稿的上限。DSH 要开会话、读仓库、写卡 —— 8 分钟是"人还愿意等"的量级 */
export const ARCH_WAIT_MS = 8 * 60_000
/** 轮询间隔：任务库是本地文件，1.5 秒足够，也不至于把目录刷爆 */
export const ARCH_POLL_MS = 1500
/** 冷却等待的余量（派单闸按毫秒判，卡在边界上会再拒一次） */
export const ARCH_COOLDOWN_SLACK_MS = 300

interface DispatchLike {
  ok: boolean
  error?: string
  path?: string
  projectId?: string
  at?: string
  cooling?: boolean
  leftMs?: number
  disabled?: boolean
  enabled?: boolean
  reason?: string
  sessionId?: string
}

export interface ArchDispatchDeps {
  /** 测试注入：默认走 `dispatchMessageToDsh`（真写签名派单文件） */
  dispatch?: (projectId: string, prompt: string) => DispatchLike
  /** 测试注入：默认 `loadTasks('all')` */
  loadTasks?: (view?: string) => any[]
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  waitMs?: number
  pollMs?: number
  shouldAbort?: () => boolean
  onProgress?: (p: { phase: 'wait'; text: string }) => void
}

/** 一次派单的 nonce：时间戳 + 随机后缀（标题里认它，不认项目名） */
export function newArchNonce(now: number = Date.now(), rand: () => number = Math.random): string {
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const tail = Math.floor(rand() * 0x10000).toString(16).padStart(4, '0')
  return `arch-${stamp}-${tail}`
}

function clampInt(v: unknown, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 派给 DSH 并等草稿卡。
 *
 * ⚠ 取消只能停**等待**，不能停已经在跑的 DSH 会话（方寸没有它的取消通道）。
 *   返回 `cancelled` 时界面必须说清这一点，别让用户以为"点取消 = 那边也停了"。
 */
export async function dispatchArchToDsh(
  input: ArchDispatchRequest,
  deps: ArchDispatchDeps = {},
): Promise<ArchDispatchReply> {
  const pid = String(input?.projectId || '').trim()
  if (!pid) return { ok: false, failKind: 'dispatch_failed', error: '没给项目 id，派不了单' }
  const facts = (input.facts || {}) as ArchScanFacts
  const attempt = Math.max(1, Number(input.attempt) || 1)
  const maxAttempts = Math.max(1, Number(input.maxAttempts) || 2)
  const feedback = String(input.feedback || '')

  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const sleep = typeof deps.sleep === 'function'
    ? deps.sleep
    : (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)))
  const list = typeof deps.loadTasks === 'function' ? deps.loadTasks : (view?: string) => loadTasks(view || 'all')
  const onProgress = deps.onProgress || (() => {})
  const aborted = () => !!(deps.shouldAbort && deps.shouldAbort())

  const nonce = newArchNonce(now())
  const prompt = buildArchDispatchPrompt({
    facts,
    projectId: pid,
    projectName: String((facts?.project && facts.project.name) || ''),
    nonce,
    attempt,
    maxAttempts,
    feedback,
  })

  const dispatch = typeof deps.dispatch === 'function'
    ? deps.dispatch
    : (projectId: string, text: string) => dispatchMessageToDsh(projectId, 'work', text)

  let sent = dispatch(pid, prompt)
  // 冷却不是失败：等冷却过去再派一次（卡 80f271dd 要求同一项目 10 秒内只产生 1 个派单文件，
  // 但重试是**用户可见的第二次尝试**，不该被上一次的冷却直接判死）。
  if (sent && !sent.ok && sent.cooling) {
    const wait = clampInt(Number(sent.leftMs) + ARCH_COOLDOWN_SLACK_MS, 0, 30_000)
    onProgress({ phase: 'wait', text: `派单冷却中，等 ${Math.ceil(wait / 1000)} 秒再派…` })
    await sleep(wait)
    if (aborted()) {
      return { ok: false, failKind: 'cancelled', error: '已取消——冷却等待期间被取消，没有派第二次', nonce }
    }
    sent = dispatch(pid, prompt)
  }
  if (!sent || !sent.ok) {
    return {
      ok: false,
      failKind: sent && sent.disabled ? 'no_dsh' : 'dispatch_failed',
      error: String(sent?.error || '派单被拒（没有写派单文件）'),
      nonce,
    }
  }

  const waitMs = clampInt(deps.waitMs === undefined ? ARCH_WAIT_MS : deps.waitMs, 0, 60 * 60_000)
  const pollMs = clampInt(deps.pollMs === undefined ? ARCH_POLL_MS : deps.pollMs, 50, 30_000)
  const deadline = now() + waitMs
  const sessionId = String((sent as DispatchLike).sessionId || '')
  let lastText = ''

  while (now() < deadline) {
    if (aborted()) {
      return {
        ok: false,
        failKind: 'cancelled',
        error: '已取消等待（DSH 会话可能还在跑 —— 方寸没有它的取消通道）',
        nonce,
        sessionId,
      }
    }
    const body = findDraftBody(list('all'), nonce)
    if (body) {
      const text = extractDraftText(body)
      if (text) return { ok: true, text, nonce, sessionId }
      lastText = '草稿卡正文里没有 JSON'
    }
    const left = Math.max(0, Math.round((deadline - now()) / 1000))
    onProgress({ phase: 'wait', text: `等 DSH 交草稿卡… 还剩 ${left} 秒` })
    await sleep(pollMs)
  }
  return {
    ok: false,
    failKind: 'timeout',
    error: lastText || `等了 ${Math.round(waitMs / 1000)} 秒，DSH 没有交回带 nonce 的草稿卡`,
    nonce,
    sessionId,
  }
}
