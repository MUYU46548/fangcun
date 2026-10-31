<!--
  阻塞源视图（从 App.vue 抽出，2026-10-22 · 拆分计划第 1 批第 2 块）

  **为什么是它而不是方案原定的 calendar**：量了一遍依赖才决定的 ——
  这块只吃一个数据源（chains），派生全靠 `shared/blockers.ts` 的纯函数，**零交互**
  （没有按钮、没有 emit、只读）。calendar 反过来：20+ 个 `cal*` 状态还依赖
  tasks/todos/logs 与四个弹窗，硬拆就是"边拆边改行为"，违背方案的红线。

  派生量在组件里重算而不是从父组件传下来：算法本来就是 `shared/blockers.ts` 的纯函数，
  重算等于走同一份代码，不会有两份真相。
-->
<template>
    <main id="board" class="blockers-view">
      <div class="blockers-header">
        <h3>阻塞源</h3>
        <span class="blockers-count">{{ chains.length }} 个阻塞源，影响 {{ totalBlockedTasks }} 个任务</span>
      </div>
      <!-- 2026-10-31（暮雨第 7 条）：这一页以前**只读** —— 看得出"谁挡了谁"，却点不动任何东西，
           看完只能自己回看板找那张卡。现在每一行都能点进卡里去处置。 -->
      <div class="blockers-lead">
        这一页只回答一件事：<b>现在哪张卡挡着别人</b>。点任意一行进卡处置（改状态 / 拆小 / 归档），
        解完之后它会自己从这一页消失。
      </div>
      <!-- 关键路径建议（卡 023，2026-10-06）：只读计算，点它不会自动改任何状态。
           只在"解了真有人受益"时出现 —— 且 unlock 已把传递效应算进去
           （A 挡住 B、B 又挡住 C，则解 A 的价值是 2，不是 1）。 -->
      <div v-if="blockerAdvice" class="blocker-advice">
        💡 <b>先解这个最划算</b>：
        <span class="ba-title">{{ blockerAdvice.title }}</span>
        <span class="ba-id">{{ blockerAdvice.id }}</span>
        <span class="ba-note">
          它一解，<b>{{ blockerAdvice.unlock }}</b> 个任务就不再被卡（其中
          {{ blockerAdvice.direct }} 个是它直接挡住的，其余是「挡住的人又被它挡住」的连带）
        </span>
        <button class="ghost ba-go" @click="emit('open-task', blockerAdvice.id)">去处理 →</button>
      </div>
      <div class="blocker-chains">
        <div v-if="!chains.length" class="empty-state">
          <div class="empty-icon">✓</div>
          <div class="empty-text">没有阻塞源 — 所有任务畅通</div>
        </div>
        <div v-for="src in chains" :key="src.id" class="chain-card">
          <div class="chain-main">
            <span class="chain-id">{{ src.id }}</span>
            <span class="chain-title">{{ src.title }}</span>
            <span class="st" :class="'st-' + statusClass(src.status)">{{ src.status }}</span>
            <button class="ghost chain-go" @click="emit('open-task', src.id)">去处理 →</button>
          </div>
          <div class="chain-arrow">
            ↓ 阻塞了 {{ src.blockedTasks.length }} 个任务
            <!-- 只在"连带解锁 > 它直接挡住的"时标出来：没有传递效应就不制造噪音 -->
            <span v-if="blockerImpactById[src.id] && blockerImpactById[src.id].unlock > src.blockedTasks.length"
              class="chain-unlock">
              · 解它连带解锁 <b>{{ blockerImpactById[src.id].unlock }}</b> 个
            </span>
          </div>
          <div class="chain-blockers">
            <div v-for="t in src.blockedTasks" :key="t.id" class="chain-blocker">
              <span class="cb-status">◌</span>
              <span class="cb-id">{{ t.id }}</span>
              <span class="cb-title">{{ t.title }}</span>
              <span class="st small" :class="'st-' + statusClass(t.status)">{{ t.status }}</span>
            </div>
          </div>
        </div>
      </div>
    </main>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { computeBlockerImpact, type BlockerImpact } from '../../shared/blockers'
import { statusClass } from '../../shared/status'

/** 唯一输入：主进程 findBlockers 给的阻塞链 */
const props = defineProps<{ chains: any[] }>()
/** 2026-10-31：点「去处理」→ 打开那张卡（落盘与跳转留给 App，组件只发意图） */
const emit = defineEmits<{ (e: 'open-task', id: string): void }>()

const totalBlockedTasks = computed(() =>
  props.chains.reduce((sum, s) => sum + (s.blockedTasks?.length || 0), 0))

/** 传递效应（A 挡 B、B 又挡 C ⇒ 解 A 值 2，不是 1）—— 算法在 shared/blockers.ts */
const blockerImpact = computed<BlockerImpact[]>(() => computeBlockerImpact(props.chains))
/** 顶部那句建议只在"真有传递收益"时出现 —— 解了没人受益就不吹 */
const blockerAdvice = computed<BlockerImpact | null>(() => {
  const top = blockerImpact.value[0]
  return top && top.unlock > 0 ? top : null
})
/** 按 id 取，给卡片行用 */
const blockerImpactById = computed<Record<string, BlockerImpact>>(() => {
  const m: Record<string, BlockerImpact> = {}
  for (const r of blockerImpact.value) m[r.id] = r
  return m
})
</script>
