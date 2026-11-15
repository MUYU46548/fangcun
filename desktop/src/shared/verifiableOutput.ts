/**
 * 可核实产出（2026-11-15 · 决策 D-141，O1 选 A）
 *
 * 为什么有这一层：`docs/产品定义-方寸-20261027.md` 的「突破点」把账压成一句话 ——
 *   **过去 N 天花了多少 token，产出了几件「真的被用起来」的东西？**
 *   「真的被用起来」= 验收通过 / 被合并 / 已发布 / 被别处引用。
 *   **不算「卡变完成」——那是自报。**
 *
 * 而 `shared/waste.ts` 的产出格实现的是 `N 张卡完成` —— **与产品定义直接相反，
 * 而且它每天被印在自检报告上**（2026-11-15 自检报告原文：`356 次提交 · 198 张卡完成`）。
 *
 * ## 为什么不新写一套判据
 *
 * `shared/mismatch.ts` 的 `hasVerifiableOutput()` 早在 2026-10-29（暮雨第 4 条 A 项）
 * 就在做同一件事：卡里能不能找到**可核实**的东西 ——
 *   · 仓库内真实存在的路径（本仓，或该卡项目对应的仓库）
 *   · 带上下文的提交号（`提交 abc1234` / `commit abc1234`）
 *   · http(s) 链接
 *
 * 同一件事写三份、各写各的，正是这个仓库反复犯的病
 * （判词四档散在 5 文件 8 处、日志挑卡写了三份、判据解析三处各一套）。
 * 所以这里**不再写第二份判据**，而是把 `mismatch` 里那份**提出来当唯一真源**，
 * `mismatch` 与 `waste` 两边都引它。改口径只改这一个文件。
 *
 * ## 它证明不了什么（必须跟着数字一起说）
 *
 * 「可核实」只证明**东西在场**：文件在、提交号在、链接在。
 * 它**证明不了有用** —— 一个存在但没人打开的文件，与一堆完成卡一样白费。
 * 所以 caveat 照旧必填，缺了整格不产出。
 */

/** 卡上有没有「可核实的一件东西」的判定材料 */
export interface VerifiableInput {
  /** 卡正文（已去掉 frontmatter） */
  body: string
}

export interface VerifiableOptions {
  /** 本仓（数据目录所在的仓库）里某相对路径是否真实存在 */
  exists: (rel: string) => boolean
  /** 该卡项目对应的其它仓库；同名相对路径在任一仓存在即算 */
  repos?: { name: string; exists: (rel: string) => boolean }[]
}

const RE_URL = /https?:\/\/[^\s)）]+/
const RE_COMMIT_CTX = /(提交|commit|sha)[^\n]{0,24}?\b[0-9a-f]{7,40}\b/i

/** 正文里裸露的疑似路径（不是反引号包着的那种） */
const PATH_BARE = /(?:^|[\s（("'`、,，:：])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6})(?=$|[\s）)"'`,，。;；])/g
/** 反引号包着的路径（单反引号或双反引号都认） */
const PATH_IN_TEXT = /`{1,2}([^`\n]+?\.[A-Za-z0-9]{1,6})`{1,2}/

/**
 * 这张卡上有没有「可核实的一件东西」。
 *
 * 三样中任一样成立即可：真实存在的路径 / 带上下文的提交号 / http(s) 链接。
 * 通配与省略号不认（`*.md`、`a/.../b.md` 不是可判路径）。
 */
export function hasVerifiableOutput(input: VerifiableInput, opts: VerifiableOptions): boolean {
  const body = String(input?.body ?? '')
  if (!body.trim()) return false
  if (RE_URL.test(body)) return true
  if (RE_COMMIT_CTX.test(body)) return true

  const cands: string[] = []
  const back = new RegExp(PATH_IN_TEXT.source, 'g')
  let bm: RegExpExecArray | null
  while ((bm = back.exec(body))) cands.push(bm[1])
  const bare = new RegExp(PATH_BARE.source, 'g')
  let pm: RegExpExecArray | null
  while ((pm = bare.exec(body))) cands.push(pm[1])

  const alts = Array.isArray(opts?.repos) ? opts.repos : []
  for (const raw of cands) {
    let rel = String(raw || '').split(String.fromCharCode(92)).join('/')
    while (rel.startsWith('./') || rel.startsWith('/')) rel = rel.slice(rel.startsWith('./') ? 2 : 1)
    rel = rel.trim()
    if (!rel || /\.\.|[*{}]/.test(rel)) continue
    if (opts.exists(rel)) return true
    for (const a of alts) if (a.exists(rel)) return true
  }
  return false
}

/**
 * 口径声明 —— 与数字同时上屏，不许省。
 * 写成常量是为了让「缺了它就不许显示」这条能被断言钉住。
 */
export const VERIFIABLE_CAVEAT =
  '它证明不了什么：可核实产出只证明东西在场（文件 / 提交号 / 链接），不证明它有用 —— '
  + '一个存在但没人打开的文件，与一堆没人验收的完成卡一样是白费'
