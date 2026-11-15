/**
 * 判据的**人说**（2026-11-15 暮雨第 1 条）
 *
 * 原话：「项目里面我看不懂的“判据”依然存在，依然界面一坨，信息堆一堆，结果就是什么都看不懂，
 *        用户直接不看。」
 *
 * 病根不在"判据这个概念"，而在**它只用机器语法展示**：
 * 卡上写的是 `str: docs/x.md 含 'foo'`、`num: docs/x.md 行数 >= 10`、`cmd: node x.cjs`，
 * 而这三行对用户唯一的含义是「这一次要验的就是：那个文件里得有这句话 / 这个文件至少十行 /
 * 这条命令得跑通」。用户看到的是前者，于是他跳过了 —— 跳过之后，"通过了没"这件事就没人判。
 *
 * 所以这一层只做一件事：**把同一行判据翻成一句中文**，并与机检结果并排给。
 * 三条硬口径：
 *  ① **不许美化失败**：翻不出来就诚实说「这条机器判不了，要人来看」，绝不糊一句"检查通过"。
 *  ② **不许丢原文**：译文旁边永远留着 raw，用户要能核对"到底验的是不是这句"。
 *  ③ **纯逻辑**：不碰 fs、不跑命令、不读 Vue。判据解析复用 `checkSpec.ts`（同一真源），
 *     这里只负责"说法"，不负责"判法" —— 判法有两份就会分叉。
 */

import { parseCheckLine, type ParsedCheck } from './checkSpec'

/** 一条判据的"人说" + 机检结果 */
export interface CriteriaExplain {
  /** 卡上原文（永远保留，用户要能核对） */
  raw: string
  /** 一句中文：这次到底要验什么 */
  plain: string
  /** 凭什么这么译（写清取到了哪几个成分；判不了时写清缺什么） */
  basis: string
  /** 类型标签：命令 / 文件含原文 / 数字 / 存在 / 人看 */
  kindLabel: string
  /** 机检状态（来自执行结果；没跑过 = ''，与"没过"必须分开） */
  state: 'pass' | 'fail' | 'unknown' | ''
  /** 机检实际值（数字类给"实际 12 行"；没跑过 = ''） */
  actual: string
  /** 一行结论（给列表右侧那一列） */
  verdict: string
}

const KIND_LABEL: Record<string, string> = {
  cmd: '跑命令',
  str: '文件含原文',
  num: '数字达标',
  file: '文件存在',
  unknown: '需人看',
}

/**
 * 把一条解析后的判据翻成一句中文。
 *
 * ⚠ 这里**不判断通过与否** —— 通过与不通过取决于真机检（`checks/runner.ts`）。
 *   本函数只回答"这条在验什么"，所以它可以被界面、日志、面板复用而不产生第二套判法。
 */
export function explainParsedCheck(c: ParsedCheck): { plain: string; basis: string; kindLabel: string } {
  const kindLabel = KIND_LABEL[c.kind] || '需人看'
  if (c.kind === 'cmd') {
    return {
      plain: `跑通这条命令：${c.command}`,
      basis: '命令退出码 0 算过',
      kindLabel,
    }
  }
  if (c.kind === 'str') {
    return {
      plain: `${c.path} 里必须出现「${c.text}」`,
      basis: '在这个文件里搜这段原文',
      kindLabel,
    }
  }
  if (c.kind === 'num') {
    const METRIC: Record<string, string> = { lines: '行', entries: '条', bytes: '字节', chars: '字符' }
    const OP: Record<string, string> = { '>=': '不少于', '<=': '不多于', '==': '正好', '!=': '不能是', '>': '多于', '<': '少于' }
    const unit = METRIC[c.metric] || c.metric
    return {
      plain: `${c.path} 的${unit}数${OP[c.op] || c.op} ${c.expected}`,
      basis: '数是现算的，不是记着的',
      kindLabel,
    }
  }
  if (c.kind === 'file') {
    if (c.everyLineContains) {
      return {
        plain: `${c.pattern} 存在，且每一行都含「${c.everyLineContains}」`,
        basis: '文件在 + 逐行都命中',
        kindLabel,
      }
    }
    if (c.contains) {
      return {
        plain: `${c.pattern} 存在，且里面有「${c.contains}」`,
        basis: '文件在 + 含这段原文',
        kindLabel,
      }
    }
    return { plain: `${c.pattern} 得存在`, basis: '只看文件在不在', kindLabel }
  }
  // unknown：**这句必须是"我判不了"，不是"没问题"**
  const reason = (c as { reason?: string }).reason || '格式认不出'
  return {
    plain: '这条机器判不了 —— 需要人来判',
    basis: reason,
    kindLabel,
  }
}

/** 机检结果（与 `checks/runner.ts` 的 CheckResult 同形，只取用得上的两个字段） */
export interface CheckResultLike {
  state?: string
  actual?: string | number
  detail?: string
}

/**
 * 一条判据 → 可读卡片。
 *
 * @param raw   卡上那行原文
 * @param res   对应的机检结果（没跑过就传 undefined —— 与"跑了但没过"必须区分）
 */
export function explainCriteria(raw: string, res?: CheckResultLike | null): CriteriaExplain {
  const parsed = parseCheckLine(raw)
  const { plain, basis, kindLabel } = explainParsedCheck(parsed)
  const st = String(res?.state || '').toLowerCase()
  const state: CriteriaExplain['state'] =
    st === 'pass' || st === 'fail' || st === 'unknown' ? st : ''

  let actual = ''
  if (res && (res.actual === 0 || res.actual)) actual = String(res.actual)
  else if (res && res.detail) actual = String(res.detail)

  // 结论一句话 —— 顺序很重要：**没跑过 ≠ 没过**（这两件事混起来，用户会以为跑挂了）
  let verdict: string
  if (!state) verdict = '还没跑'
  else if (state === 'pass') verdict = '过'
  else if (state === 'fail') verdict = actual ? '没过（' + actual + '）' : '没过'
  else verdict = '机器判不了'

  return { raw: String(raw ?? '').trim(), plain, basis, kindLabel, state, actual, verdict }
}

/** 一批判据 → 可读卡片（`results` 按同下标对应；缺项 = 没跑过） */
export function explainCriteriaList(raws: string[], results?: Array<CheckResultLike | null>): CriteriaExplain[] {
  const list = Array.isArray(raws) ? raws : []
  const res = Array.isArray(results) ? results : []
  return list.map((r, i) => explainCriteria(r, res[i] ?? null))
}

/**
 * 给"一坨文字"做减法：一块内容该不该默认展开。
 *
 * 判据区最常见的失败不是写错，是**一次铺 20 条**，用户滚两屏就放弃了。
 * 规则：≤3 条全展开；更多就只展开前 3 条，其余折叠（**不隐藏**，写明还有几条）。
 */
export function foldPlan(items: string[], keep = 3): { head: string[]; rest: string[]; moreLine: string } {
  const list = (Array.isArray(items) ? items : []).map((x) => String(x ?? '')).filter((x) => x.trim())
  const n = Math.max(0, Math.floor(keep))
  const head = list.slice(0, n)
  const rest = list.slice(n)
  const moreLine = rest.length ? `还有 ${rest.length} 条（点开看全部）` : ''
  return { head, rest, moreLine }
}
