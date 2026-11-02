/**
 * BYOK 多供应商 · 通道与降级链（0.6.0 第 2 批 · 2026-11-02）
 *
 * 卡上要的三件：① 供应商清单与接入方式 ② 统一适配层 ③ 主备通道 + 失败降级链 + 每次失败留痕可见。
 * 这个文件负责 ②③ 的**判断部分**（纯逻辑，Node 可直跑）；真正发请求在 `main/llm/chat.ts`。
 *
 * 三条硬口径：
 *  ① **未配齐的通道不进链**：缺端点 / 缺 key / 缺模型 → 跳过并说清缺什么（不许拿半条通道去试，试了也只是白等一次超时）。
 *  ② **不是所有失败都该换通道**：401/403/429/5xx/网络错 → 换下一条；400（请求本身不合法）→ 停下，
 *     换通道也只会再错一遍，白烧一次。这条是"降级"与"乱重试"的分界线。
 *  ③ **降级必须说出来**：谁失败了、因为什么、最后用了谁 —— 界面与留痕都读同一份 `describeChain`。
 *
 * 为什么所有端点都是"OpenAI 兼容"：D-033 定的是 MiMo / DeepSeek，两家都吃 `/chat/completions` +
 * Bearer 令牌；接入方式差异只在 baseUrl 与模型名，所以适配层就是"一套请求形状 + 可换端点"，
 * 不需要为每家写一个 SDK（零依赖红线）。
 */

export interface ChannelLike {
  id: string
  label?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  enabled?: boolean
}

export interface ReadyChannel {
  id: string
  label: string
  baseUrl: string
  model: string
  /** 只用于发请求；**绝不进日志、绝不回渲染层** */
  apiKey: string
}

export interface SkippedChannel {
  id: string
  label: string
  /** 缺什么（人能读懂，能直接贴到设置页旁边） */
  reason: string
}

export interface ChainPlan {
  chain: ReadyChannel[]
  skipped: SkippedChannel[]
}

function s(v: unknown): string {
  return String(v ?? '').trim()
}

/**
 * 一条通道能不能用。返回空串 = 能用；否则是"缺什么"。
 * `enabled === false` 单独算"用户手动停用"，与"没配完"分开说。
 */
export function channelProblem(ch: ChannelLike): string {
  if (!ch || typeof ch !== 'object') return '通道数据坏了'
  if (ch.enabled === false) return '已停用'
  const lack: string[] = []
  if (!s(ch.baseUrl)) lack.push('端点地址')
  if (!s(ch.apiKey)) lack.push('密钥')
  if (!s(ch.model)) lack.push('模型名')
  if (!lack.length) {
    const url = s(ch.baseUrl)
    if (!/^https?:\/\//i.test(url)) return `端点不像地址（要 http(s)://…）：${url}`
    return ''
  }
  return `缺 ${lack.join(' / ')}`
}

/**
 * 解析降级链：**主通道在前**，其余按配置顺序；不可用的剔除并逐条给原因。
 * `primaryId` 指向不存在/不可用的通道时，退化为"按顺序取第一条可用的"，并把这个事实记在 skipped 里。
 */
export function buildChain(channels: ChannelLike[], primaryId?: string): ChainPlan {
  const list = Array.isArray(channels) ? channels.filter((c) => c && typeof c === 'object') : []
  const skipped: SkippedChannel[] = []
  const ready: ReadyChannel[] = []

  for (const ch of list) {
    const id = s(ch.id) || `ch-${ready.length + skipped.length + 1}`
    const label = s(ch.label) || id
    const p = channelProblem(ch)
    if (p) {
      skipped.push({ id, label, reason: p })
      continue
    }
    ready.push({ id, label, baseUrl: s(ch.baseUrl).replace(/\/+$/, ''), model: s(ch.model), apiKey: s(ch.apiKey) })
  }

  const want = s(primaryId)
  let chain = ready
  if (want) {
    const i = ready.findIndex((c) => c.id === want)
    if (i > 0) chain = [ready[i], ...ready.slice(0, i), ...ready.slice(i + 1)]
    else if (i < 0) {
      skipped.push({
        id: want, label: want,
        reason: `主通道“${want}”不在可用通道里 —— 已按顺序改用“${ready[0] ? ready[0].label : '(没有可用通道)'}”`,
      })
    }
  }
  return { chain, skipped }
}

/** 降级判定 */
export type FailureVerdict = 'retry-next' | 'stop'

export interface FailureClass {
  verdict: FailureVerdict
  /** 一句话原因（写进留痕与界面） */
  reason: string
  /** 给人看的下一步（设置页旁边那种话） */
  hint: string
}

function codeOf(err: any): number | null {
  const n = Number(err?.code ?? err?.status ?? NaN)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 这个失败该不该换下一条通道。
 * ⚠ 分界线：**请求本身不合法**（400 / 参数错）换通道也一样错，白烧一次；**通道/凭据/限流/网络**才换。
 */
export function classifyFailure(err: any): FailureClass {
  const code = codeOf(err)
  const msg = String(err?.message ?? err ?? '')
  const low = msg.toLowerCase()

  if (code === 401 || code === 403) {
    return { verdict: 'retry-next', reason: `认证失败（${code}）`, hint: '密钥可能不对或没权限 —— 换备用通道试试，或回设置页重填' }
  }
  if (code === 429) {
    return { verdict: 'retry-next', reason: '限流（429）', hint: '这条通道此刻被限流 —— 已自动换下一条' }
  }
  if (code !== null && code >= 500) {
    return { verdict: 'retry-next', reason: `服务端错误（${code}）`, hint: '供应商那边出问题了 —— 已自动换下一条' }
  }
  if (code === 408 || /timeout|timed out|ETIMEDOUT/.test(low) || /超时/.test(msg)) {
    return { verdict: 'retry-next', reason: '超时', hint: '这条通道没在上限内回话 —— 已自动换下一条' }
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|socket hang up|network/i.test(low)) {
    return { verdict: 'retry-next', reason: '网络连不上', hint: '地址不可达 —— 已自动换下一条；一直这样要检查端点或代理' }
  }
  if (code === 400 || code === 422) {
    return { verdict: 'stop', reason: `请求本身不合法（${code}）`, hint: '换通道也是同样的错，先改请求/参数，不要靠降级掩盖' }
  }
  if (/未配置|没有配置|no api key|miss/i.test(msg)) {
    // 配置缺失属于"这条通道没就绪"，交给 buildChain 提前剔除；走到这里说明是运行期才发现
    return { verdict: 'retry-next', reason: '这条通道配置不全', hint: '去设置页补齐端点 / 密钥 / 模型' }
  }
  // 认不出的错误：**换下一条**（宁可多试一条，也别把一次可恢复的失败说成彻底失败），但如实说"没认出类型"
  return { verdict: 'retry-next', reason: `未识别的失败：${msg.slice(0, 80) || '(无消息)'}`, hint: '已尝试换下一条通道；这条错误没被分类，留痕里有原文' }
}

export interface AttemptRecord {
  channelId: string
  channelLabel: string
  ok: boolean
  /** 失败原因（ok=true 时为空） */
  reason?: string
  durationMs?: number
}

/**
 * 降级结果的一句话（界面 toast / 留痕 / 报告共用一份话术）。
 * 只在"真的用了备用"或"全挂了"时产出长句；主通道一次成功返回空串（不制造噪音）。
 */
export function describeChain(attempts: AttemptRecord[], winnerId?: string): string {
  const list = Array.isArray(attempts) ? attempts : []
  if (!list.length) return ''
  const failed = list.filter((a) => !a.ok)
  const win = list.find((a) => a.ok)
  if (win && !failed.length && list.length === 1) return ''   // 主通道一次过，不吭声

  if (win) {
    const why = failed.map((f) => `${f.channelLabel} ${f.reason || '失败'}`).join(' → ')
    return `已切到“${win.channelLabel}”：${why}`
  }
  const all = list.map((f) => `${f.channelLabel}（${f.reason || '失败'}）`).join(' → ')
  return `所有通道都失败了：${all}`
}

/** 界面/日志里展示通道时的统一标签：主通道带“主”字 */
export function channelTag(c: { id: string; label?: string }, primaryId?: string): string {
  const label = s(c.label) || s(c.id)
  return s(primaryId) && s(primaryId) === s(c.id) ? `${label}（主）` : label
}
