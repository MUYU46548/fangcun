/**
 * 撤销栈（全站一个，2026-10-21 初版 → 2026-10-30 暮雨第 5 条改成多级）。
 *
 * 为什么从 App.vue 搬出来：撤销条是**全站一个**，但触发它的地方不止主界面 ——
 * 决策卡（`components/DecisionBoard.vue`）也在改数据，误点一样要能撤。
 * 状态留在 App.vue 的 setup 里，子组件就只能靠 emit 一层层往上传；放成一个模块级
 * 单例，谁改的数据谁就 `offerUndo()`，栈永远只有一条。
 *
 * 2026-10-30 暮雨原话：
 *   “撤回到底是不是局部生效的稀缺按钮？不应该随时想撤什么操作都能撤吗
 *    （除了已经二次确认彻底删除的东西）。”
 * 所以从“只记上一笔 / 60 秒过期”改成**会话内多级栈**：
 *   · 每笔可撤动作都进栈（最多 30 笔），Ctrl+Z 一笔一笔往回走；
 *   · 不再按时间自动消失 —— 误点“通过”过了十分钟也应该撤得回来；
 *   · 只有**二次确认过的硬删除**（销毁日志 / 清空回收站）不进栈，因为数据已经没了；
 *   · 撤销本身不再 offer 新动作（否则 Ctrl+Z 会自我循环）。
 *
 * 语义仍然克制：`run` 由**动作的发起方**提供，负责把数据改回去并刷新列表；
 * 这个模块只负责顺序、去重和"先弹栈再执行"（连点不会重复撤同一笔）。
 */
import { computed, ref } from 'vue'

export interface UndoAction {
  /** 一句话说清"刚才做了什么"（带对象名，别只写"已完成"） */
  label: string
  /** 撤回动作本身；抛错由 runUndo 统一兜住并提示 */
  run: () => Promise<void>
  /** 记录时刻（历史面板显示） */
  at?: number
  /** 稳定 id（同一次动作重复登记时去重） */
  key?: string
}

const MAX_STACK = 30

/**
 * 撤销条驻留时长（2026-11-01 暮雨第 2 条）。
 *
 * 用户原话：“撤回的横幅提示是否滞留时间过长？我觉得放个5秒就差不多了，一直挂在顶上很烦。”
 * 所以**横幅的表现**只在刚改完的 5 秒里：说得清"刚才做了什么 + 还能不能撤"。
 * 但**撤销能力**不跟着消失 —— 栈还留着，Ctrl+Z 照样撤，缩成角上一个“↩ 可撤 N 步”的小胶囊，
 * 点一下能把条子叫回来（"误点十分钟后也该撤得回来"是 2026-10-30 暮雨自己定的口径，不能被
 * 这次"嫌它烦"顺手推翻）。
 */
export const UNDO_BAR_MS = 5000

/** 整个会话的撤销栈（旧 → 新） */
export const undoStack = ref<UndoAction[]>([])

/** 横幅是否展开（5 秒后收起；栈本身不动） */
export const undoBarVisible = ref(false)

/** 当前栈顶（模板里 `v-if="undoBar"` / `undoBar.label` 仍按旧接口用） */
export const undoBar = computed<UndoAction | null>(() => {
  const s = undoStack.value
  return s.length ? s[s.length - 1] : null
})

/** 可撤步数 */
export const undoCount = computed(() => undoStack.value.length)

/** 历史面板用（新 → 旧，附序号） */
export const undoHistory = computed(() =>
  undoStack.value
    .map((a, i) => ({ ...a, index: i }))
    .slice()
    .reverse(),
)

let hideTimer: ReturnType<typeof setTimeout> | null = null

function clearHideTimer(): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
}

/** 把横幅再展开 5 秒（点小胶囊 / 新动作都会调它） */
export function showUndoBar(): void {
  if (!undoStack.value.length) return
  undoBarVisible.value = true
  clearHideTimer()
  hideTimer = setTimeout(() => { undoBarVisible.value = false; hideTimer = null }, UNDO_BAR_MS)
}

/** 清空全部可撤动作（不是撤销，是"别再拿旧动作来撤"） */
export function dismissUndo(): void {
  clearHideTimer()
  undoStack.value = []
  undoBarVisible.value = false
}

/**
 * 登记一笔可撤动作。
 *
 * 2026-10-30：同一个 `key` 短时间内重复登记时**覆盖**而不是叠一条 ——
 * 典型现场是"连点两次标为进行中"（第二次其实是撤销），叠两条会让 Ctrl+Z 看起来撤错对象。
 * 没有 key 的动作按普通条目入栈。
 */
export function offerUndo(label: string, run: () => Promise<void>, key?: string): void {
  const entry: UndoAction = { label, run, at: Date.now(), key }
  const s = undoStack.value.slice()
  if (key) {
    const i = s.findIndex((x) => x.key === key)
    if (i >= 0) s.splice(i, 1)
  }
  s.push(entry)
  // 只保留最近 MAX_STACK 笔：更早的不是"不能撤"，是"已经滚出记忆"（历史面板会显示真实步数）
  undoStack.value = s.length > MAX_STACK ? s.slice(s.length - MAX_STACK) : s
  // 新动作 = 重新把横幅摆出来 5 秒（哪怕刚被收起来）
  showUndoBar()
}

/**
 * 执行撤销（栈顶一笔）。返回是否真的撤了一笔。
 *
 * 先弹栈再跑：连点两次不会对同一条动作执行两遍（第二次撤的是更早那笔）。
 * 跑失败则把这笔放回栈顶 —— 用户还能重试，也能在历史里看到它卡在哪。
 */
export async function runUndo(onError?: (msg: string) => void): Promise<boolean> {
  const s = undoStack.value.slice()
  const b = s.pop()
  if (!b) return false
  undoStack.value = s
  if (!s.length) {
    clearHideTimer()
    undoBarVisible.value = false
  }
  try {
    await b.run()
    return true
  } catch (e: any) {
    undoStack.value = [...undoStack.value, b]
    showUndoBar()
    onError?.(`撤销失败：${e?.message || e}`)
    return false
  }
}

/**
 * 撤到历史里的某一步（含这一步）：新 → 旧逐笔执行。
 * 历史面板点"撤到这一步"时用；任何一笔失败就停下并保留剩下的。
 */
export async function runUndoTo(index: number, onError?: (msg: string) => void): Promise<number> {
  let done = 0
  while (undoStack.value.length > index) {
    const ok = await runUndo(onError)
    if (!ok) break
    done++
  }
  return done
}
