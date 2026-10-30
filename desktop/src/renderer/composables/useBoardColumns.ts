/**
 * 看板列 composable（2026-10-30 · 渲染层拆分第二批第一刀）
 *
 * 只做一件事：把 App.vue 里的 `const columns = computed(...)` 换成可复用的入口。
 * 规则本体在 `shared/grouping.ts::buildBoardColumns`（纯函数，e2e-grouping 直接编译断言）；
 * 这里只负责把 ref 接进去，不复制一套状态。
 */
import { computed, type Ref } from 'vue'
import {
  buildBoardColumns,
  type BoardGroupMode,
  type GroupingTask,
  type TaskGroup,
} from '../../shared/grouping'

export interface UseBoardColumnsOptions<T extends GroupingTask> {
  tasks: Ref<T[]>
  mode: Ref<BoardGroupMode | string>
  statuses: readonly string[]
  priorities: Ref<string[]>
  nameOf?: (id: string) => string
}

export function useBoardColumns<T extends GroupingTask>(opts: UseBoardColumnsOptions<T>) {
  return computed<TaskGroup<T>[]>(() => buildBoardColumns(opts.tasks.value, opts.mode.value, {
    statuses: opts.statuses,
    priorities: opts.priorities.value,
    nameOf: opts.nameOf,
  }))
}
