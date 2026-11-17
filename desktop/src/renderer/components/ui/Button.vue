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
        // 统一到老那套：有边框 + 白底。
        //
        // ⚠⚠ 2026-11-17 改前景色（暮雨原话）：
        //   「让基座 ghost 用主墨色，不然看起来很怪，**次要色给我的感觉是取消和退出**」
        // 这条注释原先写的是“次要文字色”，但**事实是老 `.ghost` 用主墨色 `var(--ink)`**：
        //   实测（1440×900，同一行并排）老 `.ghost` 是 `rgb(60,65,80)` = --ink，
        //   基座 ghost 是 `rgb(98,103,117)` = --muted。两个放一起，基座那几枚明显发灰。
        // 所以这里改成 `--ui-foreground`（= --ink）。**只改 ghost，不动 bare**：
        //   bare 是待办行尾那种“静音钮”，压暗是它的本意（那几枚本来就该退到背景里）。
        ghost:
          'border border-[var(--ui-border)] bg-[var(--ui-card)] text-[var(--ui-foreground)] hover:bg-[var(--ui-accent)]',
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
        /**
         * `bare`（2026-11-12 · 卡《基座 Button 缺 bare/success/xl》的变体一）。
         *
         * 为什么必须有：待办行尾那三枚（`✏️ 编辑` / `📅 指派` / `× 删除`）是**静音钮** ——
         * 透明底、无框、平时压暗、hover 才亮。基座最接近的 ghost 是**白底 + 1px 描边**，
         * 套上去整行从“安静的一组小动作”变成一排白框阵（豁免表里写的就是这句）。
         *
         * ⚠ 内距要归零：cva 里 size 的 `px-*` 后写会赢，所以下面用 `compoundVariants` 给 bare 补 `px-0`，
         *   而不是在这里写 `!px-0`（那是跟自己的合并顺序打架）。
         * ⚠ 它是**透明**的，不是“白底去边框”：`bg-transparent` 必须显式写，否则会继承 Card 的底色
         *   而看起来像一块色块。hover 的底色/描边由使用处按语义给（危险色 vs 强调色不同）。
         */
        bare: 'border-0 bg-transparent text-[var(--ui-muted-foreground)] shadow-none hover:bg-[var(--ui-accent)] hover:text-[var(--ui-foreground)]',
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
        /**
         * `inline`（2026-11-12 · 卡《缺 bare/success/xl》变体一的第二半）。
         *
         * 为什么还要多一档：`bare + sm` 仍有 **24 的固定高度**，而 `proj-del`(18.5) /
         * `trip-hbtn`(22) / `te-time-clear`(24×30) 是**行内小控件** —— 它们的高度由
         * 行高与内距自然撑出来，不是某个档位。给它们 24 就等于给整行加了一条下限，
         * 表格行、代码行、输入框边上的小钮都会被撑高（卡里 2026-11-11 量过）。
         *
         * 所以这一档**不写高度**：高度交给使用处的 font-size / line-height / padding。
         * 它只保证“小件该有的样子”（圆角 8、字号 11.5、内距可由 class 覆盖）。
         * ⚠ 别把 h-* 加回来 —— 那正是这一档存在的理由。
         */
        inline: 'rounded-[var(--btn-r)] px-[5px] text-[11.5px] leading-[1.5]',
        // 大档用单独一档圆角（--btn-r-lg=10）：24 高的 sm 配 10 会圆成胶囊
        md: 'h-[var(--btn-h-lg)] rounded-[var(--btn-r-lg)] px-3.5 text-[12.5px]',
        icon: 'h-[var(--btn-h-lg)] w-[var(--btn-h-lg)] rounded-[var(--btn-r-lg)] p-0',
      },
    },
    /**
     * ⚠ 2026-11-12 改：默认档从 `md`(34) 换成 `tool`(28)。
     *
     * 起因是暮雨那句“有些按钮偷偷变大了”。量了 888 个可见按钮：全站工具行是 26/28，
     * 而基座 Button 的默认档是 **34（弹窗主按钮/输入框档）** —— 于是**少数忘了写 size 的**
     * 在工具栏里凭空高出一截（实测决策页 `☑ 多选` / `⟳`、想法页`记下来` 五处）。
     *
     * 为什么不逐个补 size 就完事：那只是把这次的现场擦掉。默认值决定“下一个漏写的人掉到哪一档”，
     * 而工具行是这个组件**绝大多数**的落点（157 处里 100+ 在工具栏/卡片动作里）。
     * 让默认值落到最常用的那一档，漏写就从“明显变高”降级为“恰好正确”。
     *
     * 弹窗主按钮仍然显式写 `size="md"`（34 那一档没取消，只是不再当默认）。
     */
    defaultVariants: { variant: 'outline', size: 'tool' },
    compoundVariants: [
      /**
       * `bare` 的内距必须归零（2026-11-12）。
       *
       * 为什么放在 compoundVariants 而不是写进 variant 字符串：cva 拼类是
       * `base → variant → size → compound`，size 里的 `px-*` **后写会赢** ——
       * 在 variant 里写 `px-0` 会被 size 的 `px-[var(--btn-px)]` 盖掉。
       * 这里匹配 (bare, *) 再补一次 `px-0`，顺序上排在 size 之后，才真的归零。
       * 判据见 e2e-renderer-web 的“静音钮是 24×24、内距 0”那几条。
       */
      { variant: 'bare', class: 'px-0' },
    ],
  }
)

const props = defineProps<{
  variant?: 'primary' | 'outline' | 'ghost' | 'danger' | 'success' | 'bare'
  size?: 'tool' | 'sm' | 'inline' | 'md' | 'icon'
  class?: any
}>()
</script>

<template>
  <!-- type="button"：默认值是 submit，放进表单会意外提交 —— 组件不该有这种副作用 -->
  <button type="button" :class="cn(buttonVariants({ variant: props.variant, size: props.size }), props.class)">
    <slot />
  </button>
</template>
