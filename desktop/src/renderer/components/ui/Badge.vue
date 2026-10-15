<script setup lang="ts">
/**
 * UI 基座 · Badge（shadcn-vue 口径）
 * 卡 task-20261011-004 第 ④ 步第一单（决策视图改版，2026-10-14）。
 *
 * 三态色取自 `App.vue` 的 `--badge-*-fg/bg` 令牌（**不是**写在本文件里的散装色值）——
 * 这样 `check-themes.cjs` 会像量其它 13 对一样量它们，掉到 WCAG AA 以下当场变红。
 * ⚠ 这三个令牌与主题**无关**（徽章只出现在白卡面上），但仍随主题块一起被量一遍。
 */
import { cva } from 'class-variance-authority'
import { cn } from './cn'

const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-[5px] text-[11.5px] font-semibold leading-none',
  {
    variants: {
      variant: {
        ok: 'border-[color-mix(in_srgb,var(--badge-ok-fg)_22%,transparent)] bg-[var(--badge-ok-bg)] text-[var(--badge-ok-fg)]',
        revoked:
          'border-[color-mix(in_srgb,var(--badge-revoked-fg)_22%,transparent)] bg-[var(--badge-revoked-bg)] text-[var(--badge-revoked-fg)]',
        merged:
          'border-[color-mix(in_srgb,var(--badge-merged-fg)_22%,transparent)] bg-[var(--badge-merged-bg)] text-[var(--badge-merged-fg)]',
        neutral: 'border-[var(--ui-border)] bg-[var(--ui-muted)] text-[var(--ui-muted-foreground)]',
      },
    },
    defaultVariants: { variant: 'neutral' },
  }
)

const props = defineProps<{
  variant?: 'ok' | 'revoked' | 'merged' | 'neutral'
  class?: any
}>()
</script>

<template>
  <span :class="cn(badgeVariants({ variant: props.variant }), props.class)"><slot /></span>
</template>
