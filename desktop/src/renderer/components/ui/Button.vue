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
  // ⚠⚠ 2026-10-30（暮雨第 4 条，第三次提）：**`border-0 border-solid appearance-none` 三件缺一不可**。
  //   真因不是"阴影没去掉"，是 preflight 关着 → `<button>` 的 UA `border-style: outset` 还在！
  //   Tailwind 的 `border` 只设宽度、不设样式，于是每个按钮都带着 Windows 那圈**外凸立体边**
  //   （截图里看起来就是"带阴影"）。决策页是唯一大量用 Button 组件的页，所以只有它"永远和别人不一样"。
  //   `border-0` 兜底，ghost/outline 再用 `border` 把宽度加回来 —— tailwind-merge 按后者生效。
  //   守卫：check-ui-base.cjs 钉死这三个类；e2e-renderer-web 量 computedStyle 的 border-style。
  // ⚠ 2026-10-31（用户：外观只影响卡片，按钮从不变）：按钮也读 --el-1/--el-2。
  //   flat 下两档都是 none，shadow 下才有贴地/浮起；与 Card.vue 同一套高度。
  //   ⚠ 必须用 `.ui-elev-1`，不能写 `shadow-[var(--el-1)]` —— Tailwind 会把后者当颜色，
  //     生成 --tw-shadow-color，计算值仍是 none（2026-10-31 实测抓到的真因）。
  'ui-elev-1 inline-flex shrink-0 appearance-none items-center justify-center gap-1.5 whitespace-nowrap border-0 border-solid font-[inherit] font-semibold transition-[background-color,border-color,color,filter,opacity,box-shadow] duration-100 outline-none disabled:pointer-events-none disabled:opacity-50',
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
