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
        // 2026-10-17 暮雨第 4 条补：「决策」页混着两种按钮 —— 这里原来的 ghost 是**无边框**的
        // （hover 才浮出来），而老界面的 `.ghost` 一律白底 + 1px 描边。同一行里一眼看出是两套。
        // 统一到老那套：有边框、次要文字色，弱在文字不在框。
        ghost:
          'border border-[var(--ui-border)] bg-[var(--ui-card)] text-[var(--ui-muted-foreground)] hover:bg-[var(--ui-accent)] hover:text-[var(--ui-foreground)]',
        danger: 'bg-[var(--ui-destructive)] text-[var(--ui-destructive-foreground)] hover:brightness-105',
      },
      size: {
        // 2026-10-17 暮雨第 4 条：「按钮视觉风格不统一……我更喜欢扁平化圆角」——
        // 尺寸与圆角**改读 App.vue 里那组老令牌**（--btn-h / --btn-h-lg / --btn-h-sm / --btn-r），
        // 不再各写各的 34px/10px。判据：新按钮和老按钮放在同一行，高度与圆角必须对得上。
        sm: 'h-[var(--btn-h-sm)] rounded-[var(--btn-r)] px-2.5 text-[11.5px]',
        md: 'h-[var(--btn-h-lg)] rounded-[var(--btn-r)] px-3.5 text-[12.5px]',
        icon: 'h-[var(--btn-h-lg)] w-[var(--btn-h-lg)] rounded-[var(--btn-r)] p-0',
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
