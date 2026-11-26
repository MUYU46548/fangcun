<!--
  规划派单弹窗（2026-11-26）

  为什么要有它：原来「让 DSH 做规划」点一下 = 直接发全项目派单，用户既没机会写
  "只规划哪一块"，也不知道它到底会产什么。用户 2026-11-26 拍板了三种落地：
    · 定向 → 一张「规划备忘」（作战计划页有家），不建阶段卡；
    · 全项目 → 没已批准澄清卷时先出卷，有卷时逐格提成阶段卡；
    · 两种模式共用现有派单管子（context:dispatchMessage），不新增 IPC。

  ⚠ 这个弹窗本身就是花钱确认：不再叠原来的 costAsk（用户 2026-11-25 设计卡明确）。
  ⚠ 不加新的顶栏 / 项目页按钮 —— 只改已有「让 DSH 做规划」的行为。
-->
<template>
  <div class="overlay" @mousedown.self="emit('close')">
    <div class="plan-send" data-plan-send>
      <div class="ps-hd">
        <b>让 DSH 做规划 · {{ projectName || project }}</b>
        <span class="ps-sub">会写一份规划派单，并在 DSH 里开一个新会话；DSH 会用你配置的模型读仓库，可能产生真实费用。</span>
      </div>

      <div class="ps-modes">
        <label class="ps-mode" :class="{ on: mode === 'targeted' }">
          <input type="radio" value="targeted" v-model="mode" />
          <span class="ps-mode-t">定向规划 <em>推荐</em></span>
          <span class="ps-mode-d">只规划你写的那一块；产物是一张「规划备忘」，不建阶段卡，更省。</span>
        </label>
        <label class="ps-mode" :class="{ on: mode === 'full' }">
          <input type="radio" value="full" v-model="mode" />
          <span class="ps-mode-t">全项目规划 <em>最贵</em></span>
          <span class="ps-mode-d">读全量、出全量阶段。没有已批准的澄清卷时会先出卷，不会直接出阶段；有卷则逐格提成阶段卡。</span>
        </label>
      </div>

      <div v-if="mode === 'targeted'" class="ps-focus">
        <label class="ps-lb" for="ps-focus-input">只规划哪一块？</label>
        <textarea id="ps-focus-input" v-model="focus" rows="3" class="ps-ta font-[inherit]"
          placeholder="例：只规划记忆系统：检索质量、合并、审批体验"></textarea>
        <div class="ps-chips">
          <Button v-for="c in chips" :key="c" variant="ghost" size="sm" @click="focus = c">{{ c }}</Button>
        </div>
        <div v-if="focusError" class="ps-bad">{{ focusError }}</div>
        <div v-else class="ps-hint">范围写越窄，规划越省；留空不能发。</div>
      </div>

      <div v-if="mode === 'full'" class="ps-focus">
        <div class="ps-hint">全项目规划不需要引导词。它会先查这个项目有没有已批准的澄清卷：
          没有就先出卷并停下等你答；有才逐格提成阶段卡。</div>
      </div>

      <div class="ps-deck">
        <span v-if="deckState === 'loading'" class="ps-hint">正在查这个项目的澄清卷…</span>
        <span v-else-if="approvedDecks.length" class="ps-ok">已批准的澄清卷：{{ approvedDecks.join(' / ') }}</span>
        <span v-else class="ps-warn">这个项目还没有已批准的澄清卷{{ mode === 'full' ? ' —— 全项目规划会先出卷，不会直接出阶段' : '（定向规划不要求先有卷）' }}</span>
      </div>

      <div v-if="blockedReason" class="ps-bad">{{ blockedReason }}</div>

      <div class="ps-ft">
        <Button variant="ghost" size="tool" @click="emit('close')">取消</Button>
        <Button variant="primary" size="tool" :disabled="!canSend" @click="send">
          {{ sending ? '发送中…' : '发送规划' }}
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from './ui/Button.vue'
import { normalizePlanFocus, type PlanMode } from '../../shared/planDispatch'

const props = defineProps<{
  project: string
  projectName: string
  deckState: 'loading' | 'ready'
  approvedDecks: string[]
  sending: boolean
  blockedReason: string
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'send', payload: { mode: PlanMode; focus: string }): void
}>()

const mode = ref<PlanMode>('targeted')
const focus = ref('')
const focusResult = computed(() => normalizePlanFocus(focus.value))
const focusError = computed(() => (mode.value === 'targeted' && focusResult.value.focus && !focusResult.value.ok
  ? focusResult.value.error || '引导词不合法'
  : ''))
const canSend = computed(() => {
  if (props.sending || props.blockedReason) return false
  if (mode.value === 'full') return true
  return focusResult.value.ok && !!focusResult.value.focus
})

const chips = [
  '只规划记忆系统：检索质量、合并、审批体验',
  '只规划决策系统：决策卡、审批入口、与任务卡的关系',
  '只规划前端交互：项目页按钮太多，怎么收',
]

function send(): void {
  if (!canSend.value) return
  emit('send', { mode: mode.value, focus: focusResult.value.focus })
}
</script>

<style scoped>
.plan-send {
  width: min(640px, 92vw);
  max-height: 86vh;
  overflow: auto;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px 12px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, .18);
}
.ps-hd { display: flex; flex-direction: column; gap: 3px; margin-bottom: 10px; }
.ps-hd b { font-size: 14.5px; }
.ps-sub { font-size: 11.5px; color: var(--muted); line-height: 1.65; }
.ps-modes { display: flex; flex-direction: column; gap: 7px; margin-bottom: 10px; }
.ps-mode {
  display: grid;
  grid-template-columns: 18px 1fr;
  gap: 2px 7px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  cursor: pointer;
}
.ps-mode.on { border-color: var(--accent); background: var(--tint-2); }
.ps-mode input { margin-top: 2px; }
.ps-mode-t { font-size: 12.5px; font-weight: 600; }
.ps-mode-t em { font-style: normal; font-size: 10.5px; font-weight: 500; color: var(--accent); margin-left: 6px; }
.ps-mode-d { grid-column: 2; font-size: 11px; color: var(--muted); line-height: 1.6; }
.ps-focus { margin-bottom: 10px; }
.ps-lb { display: block; font-size: 12px; font-weight: 600; margin-bottom: 5px; }
.ps-ta {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 9px;
  font-size: 12.5px;
  color: var(--ink);
  background: #fff;
  outline: none;
  resize: vertical;
}
.ps-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.ps-deck { margin: 2px 0 10px; font-size: 11.5px; line-height: 1.65; }
.ps-hint { color: var(--muted); font-size: 11.5px; line-height: 1.65; }
.ps-ok { color: var(--success); }
.ps-warn { color: var(--warning); }
.ps-bad { color: var(--danger); font-size: 11.5px; line-height: 1.65; margin-top: 4px; }
.ps-ft { display: flex; justify-content: flex-end; gap: 7px; border-top: 1px solid var(--border); padding-top: 10px; }
</style>
