/**
 * 决策卡的「归属」口径 —— **唯一实现**（2026-11-23）。
 *
 * ## 为什么要有这个文件
 *
 * 决策卡的 `项目` 字段在真数据里**同时存在三种写法**，而四个消费点各自写了一遍
 * "字符串相等才算"，于是：
 *
 *   · 写 `项目: 全局` 的 → **任何项目都看不到**。过滤条件是 `!项目 || 项目 === pid`，
 *     而「全局」既不是空串，也不等于任何 pid —— 它被当成"某个叫全局的项目"，
 *     没有项目叫这个名字，于是对谁都不算数。
 *   · 写中文名的（`方寸` / `司天` / `绒花墨坊`）→ 用 id 查（`fangcun-base` / `sitian` /
 *     `project-2`）一律查不到。
 *   · 写 id 的 → 用中文名查不到。
 *
 * 实测（2026-11-23，真台账 145 条有效决策）：
 *
 * ```
 * fangcun-base 按老口径（项目===pid 或空）  → 60 条
 * 加上中文名「方寸」                        → 63 条
 * 再加上「全局」                            → 71 条     ← 老口径漏 11 条
 * ```
 *
 * 漏掉的里面是 `D-033`（模型/成本架构）、`D-031`（数据零外部依赖）、
 * `D-032`（交付三铁律）、`D-019`（任务卡必须有用户侧验证栏）这类**全局规矩** ——
 * 它们从来没进过任何项目的上下文包。**这就是"决策形同虚设"最直接的一环**：
 * 不是没人记，是记了发不到。
 *
 * ## 口径（三条，别再加分支）
 *
 *  ① 空串 / `全局` / `all` / `*` → **全局**：对所有项目算数；
 *  ② 命中登记表的 `id` 或 `name` → 归一成 **id**；
 *  ③ 认不出 → 原样当"未登记的项目"（**不吞、不猜**）。
 *     宁可查不到，也不许把它算给某个项目 —— 猜错比查不到坏得多。
 *
 * ⚠ 与 `tegula/core.py` 的 `resolve_decision_project()` **逐字同口径**
 *   （判据 `scripts/test/check-decisions.py` 钉着两侧一致）。
 *   改这一处必须改那一处，否则"桌面看得到、CLI 看不到"就是这么来的。
 */

/** 决策卡里表示"这规矩对所有项目都算数"的写法（归一后也是它） */
export const DECISION_SCOPE_GLOBAL = '全局'

/** 认作全局的原始写法（大小写不敏感） */
const GLOBAL_ALIASES = new Set(['全局', 'all', '*', 'global'])

/** 登记表里一项的最小形状（`parseRegistry()` 的返回就是它） */
export interface ProjectRef {
  id: string
  name?: string
}

export type DecisionScopeKind = 'global' | 'project' | 'unknown'

export interface DecisionScope {
  kind: DecisionScopeKind
  /** kind=global → '全局'；kind=project → 项目 id；kind=unknown → 原样的字符串 */
  id: string
  /** 原始写法（排查用，不参与判断） */
  raw: string
}

/**
 * 建 id/名称 → id 的映射。**名称与 id 撞车时 id 赢**（id 才是身份）。
 *
 * 不做模糊匹配、不做前缀匹配、不折叠标点 —— 那些都会把
 * "`方寸`" 和 "`方寸-DSH插件`" 这类不同项目搅在一起。
 */
export function buildProjectAlias(projects: ProjectRef[] | null | undefined): Map<string, string> {
  const alias = new Map<string, string>()
  for (const p of projects || []) {
    const id = String(p?.id || '').trim()
    if (!id) continue
    alias.set(id, id)
  }
  for (const p of projects || []) {
    const id = String(p?.id || '').trim()
    const name = String(p?.name || '').trim()
    if (!id || !name) continue
    // id 优先：名称与某个 id 同名时，不许把那个 id 覆盖成别的项目
    if (!alias.has(name)) alias.set(name, id)
  }
  return alias
}

/**
 * 一条决策的 `项目` 字段 → 归属。
 *
 * @param raw 决策卡里的原始字符串
 * @param alias `buildProjectAlias()` 的结果；不传 = 不做名称映射（只有 id 与全局能认）
 * @param projectIds 当前登记表里**真实存在**的 id 集合。
 *        不传 = 不做校验（把非空非全局的值一律当项目）。
 *        传了 = 只在集合内的才算 project，其余算 unknown ——
 *        这条是给"显示层"用的：`龙猫` 这种已注销项目不该被当成还能用的项目。
 *        ⚠ **匹配（decisionMatchesProject）不传它**：匹配只问"是不是同一个 id"，
 *        额外要求"必须已登记"会让注册表一读失败就全变 unknown（那条路走过，会静默丢决策）。
 */
export function resolveDecisionScope(
  raw: unknown,
  alias?: Map<string, string>,
  projectIds?: Set<string>,
): DecisionScope {
  const s = String(raw ?? '').trim()
  if (!s) return { kind: 'global', id: DECISION_SCOPE_GLOBAL, raw: s }
  if (GLOBAL_ALIASES.has(s.toLowerCase())) {
    return { kind: 'global', id: DECISION_SCOPE_GLOBAL, raw: s }
  }
  const hit = alias?.get(s)
  if (hit) return { kind: 'project', id: hit, raw: s }
  // 没有别名表时：非空非全局的值**原样当项目**（不猜，也不贬成 unknown）
  if (!alias) return { kind: 'project', id: s, raw: s }
  // 有别名表但查不到：可能是没了登记的项目，也可能是打错的字。两种都不算给任何项目
  if (projectIds && !projectIds.has(s)) return { kind: 'unknown', id: s, raw: s }
  return { kind: 'unknown', id: s, raw: s }
}

/**
 * 这条决策对 `projectId` 算不算数。
 *
 * 全局恒算数；其余**比 id 字符串相等**。
 *
 * ⚠ 这里刻意**不**要求"归属必须是登记表里的项目"：
 *   本函数的两个真实调用点（`contextPack` / `planDraftInput`）拿到的 project 都来自
 *   登记表，但**匹配**与**校验**是两件事 —— 加上"必须已登记"会让注册表一读失败
 *   （或测试用临时项目 `p1`）时把**已有决策全部判死**，那是静默丢数据。
 *   要判"这归属是不是个真项目"请用 `resolveDecisionScope(..., alias, projectIds)`。
 */
export function decisionMatchesProject(
  decisionProject: unknown,
  projectId: string,
  alias?: Map<string, string>,
): boolean {
  const pid = String(projectId || '').trim()
  if (!pid) return false
  const scope = resolveDecisionScope(decisionProject, alias)
  if (scope.kind === 'global') return true
  return scope.id === pid
}

/**
 * 归一写入值：新写入的 `项目` 字段一律存 id 或「全局」，不存中文名。
 *
 * ⚠ 空串**保持空串**，不许归一成「全局」：
 *   空 = "没说这条归谁"（老卡就是这样），「全局」= "这条对所有项目都算数"。
 *   两者在读取时结果一样（都算全局），但写盘语义不同 ——
 *   把"没说"改写成"明说全局"是替用户改口径，而且会让"没填"永远消失。
 */
export function normalizeDecisionProjectForWrite(raw: unknown, alias?: Map<string, string>): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  return resolveDecisionScope(s, alias).id
}
