/**
 * Ctrl+Z 该归谁（2026-11-12 暮雨第 3 条）。
 *
 * 用户原话：
 *   “编辑日志文本时，有时想撤销错误的粘贴，结果好像自动撤销了一条日志操作，
 *    我还找不到是哪一条被动了。”
 *
 * 真因不是撤销栈坏了，是 **`App.vue` 的全局快捷键把原生撤销吃掉了**：
 * 2026-10-21 为治“狂按 Ctrl+Z 也没用”，规则写成“不管焦点在哪，只要撤销条在就撤数据动作”。
 * 当时没算代价 —— 用户正在日志 textarea 里打字/粘贴时按 Ctrl+Z，
 * 心里想的是“撤我刚粘的那一段”，结果撤掉十分钟前的一条数据动作。
 *
 * 所以判据拆成两条，都必须是**纯函数**（能脱离浏览器真跑、能反例自证）：
 *   ① 焦点在“可编辑文本”里 → 原生撤销（撤字）；
 *   ② 其它任何地方（按钮 / 卡片 / 空白） → 撤数据动作。
 *
 * 为什么 ② 仍然是默认：2026-10-21 那次报障的现场是“点完完成、焦点落在按钮/卡片上”，
 * 那种情形必须继续接管，否则“狂按 Ctrl+Z 也没用”会第二次复发。
 *
 * ⚠ 本文件同时被主进程 tsconfig 编译（`lib` 只有 ES2020、没有 DOM），
 * 所以只接受**结构类型**，不许写 `HTMLElement` / `EventTarget` 这类 DOM 类型。
 */

/** 只有这几种输入才是“有文本可以撤”的（range / checkbox / radio 没有原生撤销语义）。 */
const TEXT_INPUT_TYPES = [
  'text', 'search', 'url', 'email', 'password', 'number', 'tel',
  'date', 'datetime-local', 'month', 'time', 'week',
]

/** 判定“这个事件目标是可编辑文本”所需的最小结构（DOM Element 天然满足）。 */
export interface EditableLike {
  tagName?: string
  type?: string
  isContentEditable?: boolean
}

/** 焦点是否落在一个“可以撤字”的地方。 */
export function isEditableTarget(t: EditableLike | null | undefined): boolean {
  if (!t) return false
  const tag = String(t.tagName || '').toUpperCase()
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') {
    const ty = String(t.type || 'text').toLowerCase()
    return TEXT_INPUT_TYPES.indexOf(ty) >= 0
  }
  // 富文本 / 可编辑块：浏览器会沿着祖先算出 isContentEditable，直接用它的结论，
  // 不去自己爬 DOM（爬了在 `contenteditable="inherit"` 的嵌套里会算错）。
  return t.isContentEditable === true
}

export type UndoKeyOwner = 'native' | 'data'

/**
 * Ctrl+Z 归谁。
 * @param hasUndo 撤销栈里还有没有可撤的数据动作
 * @param editable 焦点是不是在可编辑文本里
 */
export function decideUndoKey(hasUndo: boolean, editable: boolean): UndoKeyOwner {
  if (!hasUndo) return 'native'   // 没有可撤的数据动作 → 一律让给原生
  if (editable) return 'native'   // 在打字 → 撤字，别动数据
  return 'data'
}
