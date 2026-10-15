<script setup lang="ts">
/**
 * UI 基座 · Button（shadcn-vue 口径：cva 变体 + Tailwind utilities + cn 合并）
 * 卡 task-20261011-004 第 ④ 步第一单（决策视图改版，2026-10-14）。
 *
 * ⚠ 颜色一律走第 ② 步的 `--ui-*`（`var()` 链），**不写死色值** —— 切 `data-theme` 自动跟随。
 * ⚠ 不依赖 App.vue 的 `.ghost/.pri` 那套全局类：那套是给老视图的兜底，新组件自带样式，
 *   两边互不干扰（老视图一个像素不动）。
 */
import { cva } from 'class-variance-authority'
import { cn } from './cn'

const buttonVariants = cva(
  // ⚠ `font-[inherit]` 不能省：preflight 是关着的（本仓有意），`<button>` 的 UA 默认字体还在，
  //   不重置就跟周围的老界面不是一个字体。判据：check-ui-base.cjs 的"原生控件兜底"一节。
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-[inherit] font-semibold transition-[background-color,border-color,color,filter,opacity] duration-100 outline-none disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-[var(--ui-primary)] text-[var(--ui-primary-foreground)] hover:brightness-105',
        outline:
          'border border-[var(--ui-border)] bg-[var(--ui-card)] text-[var(--ui-foreground)] hover:bg-[var(--ui-accent)]',
        ghost:
          'border border-transparent text-[var(--ui-muted-foreground)] hover:bg-[var(--ui-accent)] hover:text-[var(--ui-foreground)]',
        danger: 'bg-[var(--ui-destructive)] text-[var(--ui-destructive-foreground)] hover:brightness-105',
      },
      size: {
        sm: 'h-7 rounded-lg px-2.5 text-[12px]',
        md: 'h-[34px] rounded-[10px] px-4 text-[13px]',
        icon: 'h-[34px] w-[34px] rounded-[10px] p-0',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  }
)

const props = defineProps<{
  variant?: 'primary' | 'outline' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'icon'
  class?: any
}>()
</script>

<template>
  <!-- type="button"：默认值是 submit，放进表单会意外提交 —— 组件不该有这种副作用 -->
  <button type="button" :class="cn(buttonVariants({ variant: props.variant, size: props.size }), props.class)">
    <slot />
  </button>
</template>
