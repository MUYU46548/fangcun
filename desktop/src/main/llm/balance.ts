/**
 * 余额观测记账（2026-10-25 卡 005）——「账户口径」的真账。
 *
 * 暮雨给的参考实现（DSH 小鲸鱼挂件）里最值钱的一条：**主账不走价格表**。
 * 它每 60 秒调一次 `GET /user/balance`，把**余额下降额**累加成消费，余额上升（充值/赠金）
 * 单独记、不冲抵。价格怎么变都不影响它 —— 因为价格已经在供应商的账单里生效了。
 *
 * 所以方寸这边要分清两种账，界面上必须分开写：
 *  ① **账户口径**（本文件）：余额差值。准，但粒度粗（两次观测之间的总额），且只有
 *     DeepSeek / OpenRouter 这类**有官方余额接口**的端点才有；
 *  ② **逐笔口径**（trace 的 token）：即时、能归到单次调用，但只有 token 是硬数据，
 *     金额要靠供应商自报或用户自填单价 —— 没有就写「未折算」。
 *
 * 三条不做：不内置价目表、不联网抓价、不拿字符数折金额。
 * 三条不做错：充值不当负消费、首次观测只立基线（不假装知道之前花了多少）、
 * 账本损坏时**拒绝覆盖**（先备份再报错，绝不静默重来）。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { app } from 'electron'
import { atomicWrite } from '../data'
import * as appLog from '../services/appLog'
import { getConfig } from './config'
import {
  applyObservation, formatAmount, parseAmount, parseDeepseekBalance, parseOpenRouterCredits,
  providerOf, balanceUrlOf, isBalanceOk, EMPTY_TOTALS,
  type BookTotals, type BalanceSnapshot, type BalanceFailure,
} from '../../shared/balance'

const LEDGER_NAME = 'balance-ledger.json'
const FETCH_TIMEOUT_MS = 10_000

interface StoredBook {
  provider: string
  currency: string
  spent: string
  recharged: string
  lastBalance: string | null
  observations: number
  updatedAt: string
}

interface StoredLedger {
  v: 1
  books: Record<string, StoredBook>
}

function ledgerPath(): string {
  return path.join(app.getPath('userData'), LEDGER_NAME)
}

/**
 * 账本按**密钥指纹**分本（一把 key 一本账）。
 * ⚠ 只存指纹前 8 位，不存密钥本身 —— 账本是给人看的文件，不该带凭据。
 */
function fingerprint(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 8)
}

interface LedgerReadOk { ok: true; data: StoredLedger }
interface LedgerReadFail { ok: false; reason: string }
/** type predicate：strict:false 下 `!r.ok` 收窄不生效，必须显式守卫（见 shared/balance.ts 注释） */
function isLedgerOk(r: LedgerReadOk | LedgerReadFail): r is LedgerReadOk {
  return (r as LedgerReadOk).ok === true
}

function readLedger(): LedgerReadOk | LedgerReadFail {
  const p = ledgerPath()
  if (!fs.existsSync(p)) return { ok: true, data: { v: 1, books: {} } }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (!raw || typeof raw !== 'object' || typeof raw.books !== 'object' || raw.books === null) {
      return { ok: false, reason: '账本结构不对（缺 books）' }
    }
    return { ok: true, data: { v: 1, books: raw.books as Record<string, StoredBook> } }
  } catch (e: any) {
    return { ok: false, reason: `账本读不出来：${e?.message || e}` }
  }
}

/** 账本坏了就备份再拒绝写 —— 不能把用户的历史消费一删了之 */
function quarantineLedger(): string {
  const p = ledgerPath()
  const bad = `${p}.bad-${Date.now()}`
  try { fs.renameSync(p, bad) } catch { /* 备份失败也不覆盖 */ }
  return bad
}

function toTotals(b: StoredBook | undefined): BookTotals {
  if (!b) return { ...EMPTY_TOTALS }
  return {
    spent: parseAmount(b.spent) ?? 0n,
    recharged: parseAmount(b.recharged) ?? 0n,
    lastBalance: b.lastBalance === null ? null : parseAmount(b.lastBalance),
    observations: Number(b.observations) || 0,
  }
}

function toStored(provider: string, currency: string, t: BookTotals, at: string): StoredBook {
  return {
    provider,
    currency,
    spent: formatAmount(t.spent, 8),
    recharged: formatAmount(t.recharged, 8),
    lastBalance: t.lastBalance === null ? null : formatAmount(t.lastBalance, 8),
    observations: t.observations,
    updatedAt: at,
  }
}

export interface BalanceStatus {
  /** 这台机器上能不能查余额（有端点 + 该端点有官方余额接口） */
  supported: boolean
  /** 为什么不能查（supported=false 时给人看的一句话） */
  reason: string
  provider: string
  currency: string
  /** 账户口径已观测消费（人话字符串，保留 2 位） */
  spent: string
  recharged: string
  lastBalance: string
  observations: number
  updatedAt: string
  /** 观测次数不足 2 时说明"还只是基线" */
  note: string
}

const EMPTY_STATUS: BalanceStatus = {
  supported: false, reason: '', provider: '', currency: '', spent: '0.00', recharged: '0.00',
  lastBalance: '', observations: 0, updatedAt: '', note: '',
}

/** 只读状态：给界面用的口径说明 + 数字（不做任何网络请求） */
export function getBalanceStatus(): BalanceStatus {
  const cfg = getConfig()
  const provider = providerOf(cfg.baseUrl)
  const url = balanceUrlOf(cfg.baseUrl)
  if (!cfg.baseUrl) {
    return { ...EMPTY_STATUS, reason: '还没配置 AI 通道（设置 → AI 通道）' }
  }
  if (!url) {
    return {
      ...EMPTY_STATUS,
      provider,
      reason: '这个端点没有官方余额接口 —— 账户口径不可用，只能看 token（或自己填单价）',
    }
  }
  const led = readLedger()
  if (!isLedgerOk(led)) return { ...EMPTY_STATUS, provider, reason: `账本异常：${led.reason}` }
  const book = led.data.books[fingerprint(cfg.apiKey)]
  const t = toTotals(book)
  return {
    supported: true,
    reason: '',
    provider,
    currency: book?.currency || (provider === 'deepseek' ? 'CNY' : 'USD'),
    spent: formatAmount(t.spent, 2),
    recharged: formatAmount(t.recharged, 2),
    lastBalance: t.lastBalance === null ? '' : formatAmount(t.lastBalance, 2),
    observations: t.observations,
    updatedAt: book?.updatedAt || '',
    note: t.observations < 2
      ? '还需要再一次观测才有差值（首次只立基线，不猜之前花了多少）'
      : '',
  }
}

export interface ObserveResult {
  ok: boolean
  /** 给人看的一句话（成功也带：这次余额多少、算出来的差额是什么） */
  message: string
  status: BalanceStatus
}

/**
 * 观测一次余额并记账。
 * 永远 resolve（不抛）—— 查余额失败绝不能影响界面别处的任何东西。
 */
export async function observeBalance(): Promise<ObserveResult> {
  const cfg = getConfig()
  const provider = providerOf(cfg.baseUrl)
  const url = balanceUrlOf(cfg.baseUrl)
  if (!url || !cfg.apiKey) {
    return { ok: false, message: getBalanceStatus().reason || '还没配置可查余额的端点与密钥', status: getBalanceStatus() }
  }

  let json: unknown
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          Accept: 'application/json',
          // 与 chat 通道一致的客户端标识；余额接口也一样，便于供应商侧归因
          'User-Agent': 'Fangcun/balance-probe',
        },
        signal: ctl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      // ⚠ 只报状态码，不把响应体（可能含账户信息）糊到界面上
      const msg = `余额接口返回 HTTP ${res.status}${res.status === 401 ? '（密钥无效或没有余额查询权限）' : ''}`
      appLog.warn('balance', `观测失败：${msg}`)
      return { ok: false, message: msg, status: getBalanceStatus() }
    }
    json = await res.json()
  } catch (e: any) {
    const aborted = e?.name === 'AbortError'
    const msg = aborted ? `余额接口超时（${FETCH_TIMEOUT_MS / 1000} 秒）` : `连不上余额接口：${e?.message || e}`
    appLog.warn('balance', `观测失败：${msg}`)
    return { ok: false, message: msg, status: getBalanceStatus() }
  }

  const parsed: BalanceSnapshot | BalanceFailure =
    provider === 'deepseek' ? parseDeepseekBalance(json) : parseOpenRouterCredits(json)
  if (!isBalanceOk(parsed)) {
    appLog.warn('balance', `解析失败：${parsed.reason}`)
    return { ok: false, message: parsed.reason, status: getBalanceStatus() }
  }

  const led = readLedger()
  if (!isLedgerOk(led)) {
    const bad = quarantineLedger()
    appLog.error('balance', `账本损坏，已备份到 ${bad}，本次不写入`, led.reason)
    return { ok: false, message: `账本损坏（已备份到 ${path.basename(bad)}），本次观测没有写入`, status: getBalanceStatus() }
  }

  const fp = fingerprint(cfg.apiKey)
  const prevBook = led.data.books[fp]
  const before = toTotals(prevBook)
  const after = applyObservation(before, parsed.balance)
  const at = new Date().toISOString()
  led.data.books[fp] = toStored(parsed.source, parsed.currency, after, at)
  try {
    atomicWrite(ledgerPath(), JSON.stringify(led.data, null, 2))
  } catch (e: any) {
    appLog.error('balance', '账本写盘失败', e?.message || String(e))
    return { ok: false, message: `账本写不进去：${e?.message || e}`, status: getBalanceStatus() }
  }

  const dSpent = after.spent - before.spent
  const dRecharge = after.recharged - before.recharged
  let message: string
  if (before.lastBalance === null) {
    message = `已立基线：当前余额 ${formatAmount(parsed.balance, 2)} ${parsed.currency}（首次不猜历史消费）`
  } else if (dRecharge > 0n) {
    message = `余额上升 ${formatAmount(dRecharge, 2)} ${parsed.currency} —— 记为充值/赠金，没有冲抵已有消费`
  } else if (dSpent > 0n) {
    message = `本次观测到消费 ${formatAmount(dSpent, 2)} ${parsed.currency}（余额 ${formatAmount(parsed.balance, 2)}）`
  } else {
    message = `余额没动（${formatAmount(parsed.balance, 2)} ${parsed.currency}）`
  }
  appLog.info('balance', `观测成功：${message}`)
  return { ok: true, message, status: getBalanceStatus() }
}
