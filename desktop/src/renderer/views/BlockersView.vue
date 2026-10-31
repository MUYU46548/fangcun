<!--
  阻塞源视图（从 App.vue 抽出，2026-10-22 · 拆分计划第 1 批第 2 块）

  **2026-10-31 结构重做（暮雨第 7 条：「按它们该服务哪个决策做一次结构重做，单加出口不能从根本解决」）**：
  这一页只服务一个决策 —— **现在先解哪一张？**
  所以三层，从上到下就是读的顺序：
    ① 一行结论（有几个源、挡着几张、先解谁）；
    ② 「先解这个」一张大卡（收益 + 解锁名单 + 去处理）；
    ③ 「其余按收益排队」的队列（每行一句为什么 + 去处理）。
  原来的完整阻塞链**没有删**，降级成折叠的"证据"—— 想核对"到底谁挡谁"才展开。

  派生全在 `shared/blockers.ts` 的纯函数里（`buildBlockerQueue`），组件不重算 ——
  与 `e2e-blockers.cjs` 跑的是同一份代码，界面和测试不会各说一套。
-->
<template>
    <main id="board" class="blockers-view">
      <div class="blockers-header">
        <h3>阻塞 · 先解哪一张</h3>
        <span class="blockers-count">{{ queue.total }} 个阻塞源，影响 {{ queue.blocked }} 个任务</span>
      </div>
      <div class="blockers-lead">
        {{ queue.text }}
        <span v-if="queue.inert" class="bl-inert">其中 {{ queue.inert }} 个源挡着的卡都已收口，解了没有收益。</span>
      </div>

      <!-- ① 先解这个（收益最高且真有人受益）—— 只在真有收益时出现 -->
      <div v-if="queue.top" class="blocker-advice">
        <div class="ba-head">
          <span class="ba-kicker">先解这个</span>
          <span class="ba-title">{{ queue.top.title }}</span>
          <span class="ba-id">{{ queue.top.id }}</span>
          <span v-if="queue.top.status" class="st small" :class="'st-' + statusClass(queue.top.status)">{{ queue.top.status }}</span>
          <button class="ok ba-done" title="直接标记完成（跳过裁决，会二次确认）—— 解掉它，后面那几张就解锁了"
            @click="emit('finish-task', queue.top.id)">✓ 标完成</button>
          <button class="ghost ba-go" @click="emit('open-task', queue.top.id)">打开卡片 →</button>
        </div>
        <div class="ba-note">
          它一解，<b>{{ queue.top.unlock }}</b> 个任务就不再被卡（其中
          {{ queue.top.direct }} 个是它直接挡住的，其余是「挡住的人又被它挡住」的连带）
        </div>
        <div v-if="queue.top.unlockTitles.length" class="ba-who">
          解开后能动：{{ queue.top.unlockTitles.join('、') }}<span v-if="queue.top.unlock > queue.top.unlockTitles.length"> 等</span>
        </div>
      </div>

      <!-- ② 其余按收益排队 -->
      <div v-if="rest.length" class="blocker-queue">
        <div class="bq-head">其余按收益排队 <em>（解了没人受益的不排前面）</em></div>
        <div class="bq-row" v-for="(r, i) in rest" :key="r.id" :class="{ inert: !r.unlock }">
          <span class="bq-rank">{{ i + 2 }}</span>
          <div class="bq-main">
            <div class="bq-title">{{ r.title }}<span class="bq-id">{{ r.id }}</span></div>
            <div class="bq-why">{{ r.why }}</div>
          </div>
          <button class="ghost bq-go" @click="emit('open-task', r.id)">打开卡片 →</button>
          <button v-if="!r.status || (r.status !== '完成' && r.status !== '驳回')" class="ok bq-done"
            title="直接标记完成（跳过裁决，会二次确认）" @click="emit('finish-task', r.id)">✓</button>
        </div>
      </div>

      <!-- ③ 证据：完整阻塞链（默认折叠） -->
      <details class="blocker-evidence" v-if="chains.length">
        <summary>完整阻塞链 · {{ chains.length }} 条（点开核对「谁挡谁」）</summary>
        <div class="blocker-chains">
          <div v-for="src in chains" :key="src.id" class="chain-card">
            <div class="chain-main">
              <span class="chain-id">{{ src.id }}</span>
              <span class="chain-title">{{ src.title }}</span>
              <span class="st" :class="'st-' + statusClass(src.status)">{{ src.status }}</span>
              <button class="ghost chain-go" @click="emit('open-task', src.id)">打开卡片 →</button>
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
      </details>

      <div v-if="!chains.length" class="empty-state">
        <div class="empty-icon">✓</div>
        <div class="empty-text">没有阻塞源 — 没有任何一张卡在等别的卡</div>
        <div class="empty-sub">要加依赖：在任务详情里填「阻塞」，或在新建任务时挑一张「做完它才能开始」的卡。</div>
      </div>
    </main>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { buildBlockerQueue, computeBlockerImpact, type BlockerImpact } from '../../shared/blockers'
import { statusClass } from '../../shared/status'

/** 唯一输入：主进程 findBlockers 给的阻塞链 */
const props = defineProps<{ chains: any[] }>()
/** 2026-10-31：点「打开卡片」→ 打开那张卡；点「标完成」→ 直接解掉（落盘与确认都在 App，组件只发意图） */
const emit = defineEmits<{
  (e: 'open-task', id: string): void
  (e: 'finish-task', id: string): void
}>()

/** 决策队列（结论 / 先解这个 / 其余排序）—— 算法在 shared/blockers.ts */
const queue = computed(() => buildBlockerQueue(props.chains))
/** 「先解这个」之外的行（按同一份排序，编号从 2 起） */
const rest = computed(() => {
  const topId = queue.value.top?.id
  return queue.value.rows.filter((r) => r.id !== topId)
})
/** 按 id 取，给证据区用 */
const blockerImpactById = computed<Record<string, BlockerImpact>>(() => {
  const m: Record<string, BlockerImpact> = {}
  for (const r of computeBlockerImpact(props.chains)) m[r.id] = r
  return m
})
</script>
