/**
 * 撤销条的状态中枢（2026-10-21）。
 *
 * 为什么从 App.vue 搬出来：撤销条是**全站一个**，但触发它的地方不止主界面 ——
 * 决策卡（`components/DecisionBoard.vue`）也在改数据，误点一样要能撤。
 * 状态留在 App.vue 的 setup 里，子组件就只能靠 emit 一层层往上传；放成一个模块级
 * 单例，谁改的数据谁就 `offerUndo()`，条子永远只有一条。
 *
 * 语义（别扩大）：
 *  · 只记**上一笔**：8 秒内有效，下一次动作直接顶掉上一笔。不做多级撤销栈 ——
 *    真要做就得动全站每条写路径，代价远大于收益，而用户的实际痛点是"刚点错这一下"。
 *  · 只接受**真撤得回**的动作：回调里自己负责把数据改回去（并刷新列表）。
 *  · Ctrl+Z 与点按钮等价，但**焦点在输入框里时一律放行原生撤销**（见 App.vue onShortcutKeydown）。
 */
import { ref } from 'vue'

export interface UndoAction {
  /** 一句话说清"刚才做了什么"（带对象名，别只写"已完成"） */
  label: string
  /** 撤回动作本身；抛错由 runUndo 统一兜住并提示 */
  run: () => Promise<void>
}

/** 当前可撤的那一笔（null = 没有） */
export const undoBar = ref<UndoAction | null>(null)

let timer: ReturnType<typeof setTimeout> | null = null
/**
 * 有效窗口：**60 秒**（2026-10-21 暮雨实测后改，原来 8 秒）。
 *
 * 8 秒的原意是"够人反应过来"，但真实场景是：点完成 → 界面刷新 → 人去别的页面看了一眼 →
 * 回来想撤 → 已经过了 8 秒 → 按 Ctrl+Z 什么都没发生。用户当场报"按 Ctrl+Z 没能撤回"。
 * 撤销条存在的意义就是**给误操作留一条回路**，它不该比人的反应慢半拍就消失。
 * 挂着不碍事：一条细条 + 一个 ✕，下一次动作还会顶掉它。
 */
const WINDOW_MS = 60000

export function dismissUndo(): void {
  if (timer) { clearTimeout(timer); timer = null }
  undoBar.value = null
}

export function offerUndo(label: string, run: () => Promise<void>): void {
  dismissUndo()
  undoBar.value = { label, run }
  timer = setTimeout(() => { undoBar.value = null; timer = null }, WINDOW_MS)
}

/** 执行撤销。**先清条再跑** —— 否则连点会重复撤回（第二次已经没东西可撤）。 */
export async function runUndo(onError?: (msg: string) => void): Promise<boolean> {
  const b = undoBar.value
  if (!b) return false
  dismissUndo()
  try {
    await b.run()
    return true
  } catch (e: any) {
    onError?.(`撤销异常：${e?.message || e}`)
    return false
  }
}
