<script setup lang="ts">
/**
 * UI 基座 · Card（shadcn-vue 口径，最薄一层：边框 + 圆角 + 卡面 + 贴地投影）
 * 卡 task-20261011-004 第 ④ 步第一单（决策视图改版，2026-10-14）。
 *
 * ⚠ 投影**不用** App.vue 的 `--shadow`（`0 8px 32px`，那是给弹窗用的浮起阴影）：
 *   列表里每行都背一层 32px 大模糊，卡与卡之间会糊成一片、右下角拖出一团发虚的边。
 *   shadcn 的 Card 用的是 `shadow-sm` 这一档 —— 这里就照它来。
 */
import { cn } from './cn'

const props = defineProps<{ class?: any }>()
</script>

<template>
  <div
    :class="
      cn(
        'rounded-[14px] border border-[var(--ui-border)] bg-[var(--ui-card)] shadow-[0_1px_2px_rgba(60,65,80,0.06)]',
        props.class
      )
    "
  >
    <slot />
  </div>
</template>
