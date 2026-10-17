<script setup lang="ts">
/**
 * UI 基座 · Input（shadcn-vue 口径）
 * 卡 task-20261011-004 第 ④ 步第一单（决策视图改版，2026-10-14）。
 *
 * v-model 用手写 props/emits（不用 `defineModel`）：本仓渲染层由 vite 直接打包、
 * **不过 tsc**，所以不押注编译期特性，显式写出来最稳。
 * ⚠ `@keydown.enter` 之类**没在 emits 里声明**的原生监听会原样落到根 `<input>` 上（Vue 的
 *   属性透传），所以调用方直接写 `@keydown.enter="add"` 就是能用的。
 */
import { cn } from './cn'

const props = defineProps<{
  modelValue?: string
  type?: string
  placeholder?: string
  title?: string
  class?: any
}>()

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

/** 事件里取 value：断言归脚本，模板不写 `as`（本仓统一口径） */
function onInput(ev: Event): void {
  const el = ev.target as HTMLInputElement | null
  emit('update:modelValue', el ? el.value : '')
}
</script>

<template>
  <input
    :type="props.type || 'text'"
    :value="props.modelValue"
    :placeholder="props.placeholder"
    :title="props.title"
    :class="
      cn(
        // ⚠ `font-[inherit]`：preflight 关着，`<input>` 的 UA 默认字体还在（见 check-ui-base 的原生控件兜底一节）
        // 2026-10-17：高度/圆角改读老按钮令牌（34/10 → 32/8）—— 与旁边的按钮同一行必须对得上，
        //   否则「决策」页那种按钮与输入框并排的地方会一眼看出两套尺寸。
        'h-[var(--btn-h-lg)] w-full min-w-0 rounded-[var(--btn-r)] border border-[var(--ui-input)] bg-[var(--ui-card)] px-3 font-[inherit] text-[12.5px] text-[var(--ui-foreground)] outline-none transition-colors placeholder:text-[var(--ui-muted-foreground)] hover:border-[var(--ui-ring)] focus-visible:border-[var(--ui-ring)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--ui-ring)_20%,transparent)] disabled:opacity-50',
        props.class
      )
    "
    @input="onInput"
  />
</template>
