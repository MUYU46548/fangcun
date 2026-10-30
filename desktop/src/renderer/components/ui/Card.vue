<script setup lang="ts">
/**
 * UI 基座 · Card（shadcn-vue 口径，最薄一层：边框 + 圆角 + 卡面 + 贴地投影）
 * 卡 task-20261011-004 第 ④ 步第一单（决策视图改版，2026-10-14）。
 *
 * ⚠ 投影**不用** App.vue 的 `--shadow`（`0 8px 32px`，那是给弹窗用的浮起阴影）：
 *   列表里每行都背一层 32px 大模糊，卡与卡之间会糊成一片、右下角拖出一团发虚的边。
 *
 * ⚠ 2026-10-27 校正（暮雨：「决策仍为另一套带阴影的 UI 风格」）：
 *   原来这里是 `rounded-[14px]` + 独立阴影，而看板老卡 `.card` 是 `9px` + `0 1px 2px rgba(90,90,130,.05)`。
 *   **同一屏里两种圆角两种阴影 = 看起来就是两套 UI**（他不是在说"没统一"，是在说"统一不到一起"）。
 *   现在与老卡**逐值对齐**：圆角 9px、阴影同一档、hover 用老卡那档 `0 2px 8px`。
 *   ⚠ 以后要动这两个值，**必须同时改 `.card`**，否则又分叉（有断言守着：e2e-renderer-web 的「同卡同貌」）。
 */
import { cn } from './cn'

const props = defineProps<{ class?: any }>()
</script>

<template>
  <!-- 与 App.vue 的 `.card` 同一档：贴地 --el-1、hover --el-2。
       ⚠ 2026-10-30 起投影走**全局外观令牌**（flat 下这两个都是 none）——
       不许再写字面量，否则「切回扁平」会在这里留下一块散不掉的影子。 -->
  <div
    :class="cn(
      'rounded-[9px] border border-[var(--ui-border)] bg-[var(--ui-card)] shadow-[var(--el-1)] transition-shadow hover:shadow-[var(--el-2)]',
      props.class
    )"
  >
    <slot />
  </div>
</template>
