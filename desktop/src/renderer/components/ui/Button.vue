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
  'ui-btn-elev inline-flex shrink-0 appearance-none items-center justify-center gap-1.5 whitespace-nowrap border-0 border-solid font-[inherit] font-semibold transition-[background-color,border-color,color,filter,opacity,box-shadow] duration-100 outline-none disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-[var(--ui-primary)] text-[var(--ui-primary-foreground)] hover:brightness-105',
        outline:
          'border border-[var(--ui-border)] bg-[var(--ui-card)] text-[var(--ui-foreground)] hover:bg-[var(--ui-accent)]',
        // 2026-10-17 暮雨第 4 条补：“决策”页混着两种按钮 —— 这里原来的 ghost 是**无边框**的
        // （hover 才浮出来），而老界面的 `.ghost` 一律白底 + 1px 描边。同一行里一眼看出是两套。
        // 统一到老那套：有边框、次要文字色，弱在文字不在框。
        ghost:
          'border border-[var(--ui-border)] bg-[var(--ui-card)] text-[var(--ui-muted-foreground)] hover:bg-[var(--ui-accent)] hover:text-[var(--ui-foreground)]',
        danger: 'bg-[var(--ui-destructive)] text-[var(--ui-destructive-foreground)] hover:brightness-105',
        /**
         * `success`（2026-11-12 · 卡《基座 Button 缺 bare/success/xl》的变体二）。
         *
         * 为什么必须有：老界面的 `.ok` 是**绿色＝成功态**（“✓ 处理完了 / ✓ 通过（冻结）/ 变成待办 →”）。
         * 基座原来只有 primary/outline/ghost/danger —— 换 primary 会把“通过”变成品牌色，**语义就变了**。
         * 所以那四处一直是手搓 `<button class="ok …">` + 豁免，等这个变体。
         *
         * 几何零像素差：老 `.ok` 实测是 `height: var(--btn-h)`（28）+ `--btn-r` + `--btn-px` + `--btn-fs`，
         * 正好等于基座的 `tool` 档 —— 迁移时只换颜色，尺寸一个像素不动。
         * 令牌用 `--ui-success`（shadcn 没这个语义色，本仓扩展；`check-ui-base` 已钉住它存在）。
         */
        success: 'bg-[var(--ui-success)] text-[var(--ui-success-foreground)] hover:brightness-105',
      },
      size: {
        // 2026-10-17 暮雨第 4 条：“按钮视觉风格不统一……我更喜欢扁平化圆角”——
        // 尺寸与圆角**改读 App.vue 里那组老令牌**（--btn-h / --btn-h-lg / --btn-h-sm / --btn-r），
        // 不再各写各的 34px/10px。判据：新按钮和老按钮放在同一行，高度与圆角必须对得上。
        //
        // 2026-11-11（UI 批 4）：补 `tool` 一档 = 老 `.ghost` 的默认档（28 / 8 / 12px / 内距 14）。
        //   为什么必须补：老界面里**绝大多数**按钮（工具行、卡片动作、页头动作）都吃
        //   `:where(button.ghost)` 那套 28px；而基座原来只有 24（sm）与 34（md）两档。
        //   直接拿 sm 去迁 28px 的老按钮 = 每迁一个就矮 4px，与同行的下拉框/输入框（27~28）错位，
        //   而“目检高度对得上”正是 U2=A 的判据。补这一档后工具行迁移是**零像素差**的。
        // 2026-11-12 实测修：原来写的是**不带类型前缀**的 `text-[<变量>]` —— Tailwind **猜不出**
        //   这个变量是长度还是颜色，于是把它生成成 `color: var(--btn-fs)`（`color: 12px` 是无效值，字号压根没生效）。
        //   更糟的是 tailwind-merge 也认成“文字色”，把变体那一条 `text-[var(--ui-success-foreground)]`
        //   当成同组冲突**合并掉** → 绿底上出现深灰字（`plan-act-pass` 实测 rgb(60,65,80)）。
        //   显式加类型前缀 `length:`，两件事一起解决。判据：渲染层那条“success 的字是白的”。
        //   ⚠ 注释里也别再出现那个旧字面量：Tailwind 扫的是**整份文本**（含注释），写一遍就照样生成一条废规则。
        tool: 'h-[var(--btn-h)] rounded-[var(--btn-r)] px-[var(--btn-px)] text-[length:var(--btn-fs)]',
        sm: 'h-[var(--btn-h-sm)] rounded-[var(--btn-r)] px-2.5 text-[11.5px]',
        // 大档用单独一档圆角（--btn-r-lg=10）：24 高的 sm 配 10 会圆成胶囊
        md: 'h-[var(--btn-h-lg)] rounded-[var(--btn-r-lg)] px-3.5 text-[12.5px]',
        icon: 'h-[var(--btn-h-lg)] w-[var(--btn-h-lg)] rounded-[var(--btn-r-lg)] p-0',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  }
)

const props = defineProps<{
  variant?: 'primary' | 'outline' | 'ghost' | 'danger' | 'success'
  size?: 'tool' | 'sm' | 'md' | 'icon'
  class?: any
}>()
</script>

<template>
  <!-- type="button"：默认值是 submit，放进表单会意外提交 —— 组件不该有这种副作用 -->
  <button type="button" :class="cn(buttonVariants({ variant: props.variant, size: props.size }), props.class)">
    <slot />
  </button>
</template>
