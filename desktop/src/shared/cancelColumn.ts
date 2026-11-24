/**
 * 「已取消」这一列的口径（2026-11-24 · K2 落地）
 *
 * ## 拍板原话（2026-11-23 问卷《方寸-决策机制三岔路》K2）
 *
 * > 「在B的基础上，已取消默认隐藏，多搞一个按钮当开关，不影响当前看板已经完美的整屏全状态布局。」
 *
 * 拆成三条硬要求：
 *   ① 「已取消」是**第八个合法状态**（不是别名、不映射成「驳回」）；
 *   ② 看板**默认不显示**这一列 —— 现有七列布局一个字都不动；
 *   ③ 给一个**开关**，打开才多出这一列。
 *
 * ## 为什么它不能映射成「驳回」
 *
 * | | 含义 | 之后会发生什么 |
 * |---|---|---|
 * | 驳回 | **被否决**了 | 进返工台，还可能被再挖出来问一次 |
 * | 已取消 | **决定不做了** | 终态，谁都不该再推它 |
 *
 * 并成一个值，等于让"否决"和"放弃"永远分不开 —— 而复盘时这两种的结论正好相反：
 * 一个是"方案不行要改"，一个是"这事不归我们管了"。
 *
 * ## 这个文件存在的理由
 *
 * 「完成 / 驳回算不算终态」这件事在代码里有 **十几处各写了一遍字面量**
 * （blockers / boardCards / neverRead / taskPick / calendar / time / rework…）。
 * 加第八个状态时，任何一处漏改都会造出一个安静的 bug：
 * 一张「已取消」的卡仍被算作"挡着别人的活"、仍进"没人读过"清单、
 * 仍占日历负担 —— 界面看起来一切正常，就是数字不对。
 *
 * 所以口径收在这里：**判定只此一份**，上面那些模块改为 import 它。
 */

/** 第八个状态。字面量只许出现在这里（别处一律引用常量） */
export const CANCEL_STATUS = '已取消'

/**
 * 终态：不再推进、不进"下一步"推荐、不算"还挡着别人"、不占日历负担。
 *
 * ⚠ 「驳回」**不在**这里：它可以返工（`shared/rework.ts` 整套功能就建立在这个前提上）。
 * ⚠ Python 侧同一口径：`tegula/core.py` 的 `TERMINAL_STATUSES`，verify.py 会比对两处。
 */
export const TERMINAL_STATUSES: readonly string[] = ['完成', CANCEL_STATUS]

/** 一旦进入这些状态，就不是"还在办"了（含驳回：驳回也要人处理，但不再是进行中的活） */
export const CLOSED_STATUSES: readonly string[] = ['完成', '驳回', CANCEL_STATUS]

export function isTerminalStatus(status: unknown): boolean {
  return TERMINAL_STATUSES.includes(String(status ?? '').trim())
}

/** 已经不需要再推（完成 / 驳回 / 已取消 三者的并集口径） */
export function isClosedStatus(status: unknown): boolean {
  return CLOSED_STATUSES.includes(String(status ?? '').trim())
}

/** 只看"是不是被取消"（有些地方要区分：取消是终态，驳回不是） */
export function isCancelled(status: unknown): boolean {
  return String(status ?? '').trim() === CANCEL_STATUS
}

// ── 显示开关 ──────────────────────────────────────────────────────────────

/**
 * 看板显示「已取消」列的偏好键（存 `prefs.json`，与其它界面偏好同一处）。
 *
 * ⚠ **缺省关**：暮雨的硬要求是"不影响当前看板已经完美的整屏全状态布局"。
 *   所以判据写 `=== true`（只有明确存了 true 才开），**不能**写成 `!== false`
 *   —— 那样老用户升级上来会突然多一列，等于替他改了布局。
 */
export const SHOW_CANCELLED_PREF_KEY = 'showCancelledColumn'

/** 这个偏好值算不算"打开"（只认严格 true，缺省 / 脏值一律关） */
export function showCancelledEnabled(raw: unknown): boolean {
  return raw === true || raw === 'true'
}
