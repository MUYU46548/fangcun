<script setup lang="ts">
/**
 * 任务卡右键菜单（reka-ui `ContextMenu`）
 * 卡 task-20261011-004 第 ④ 步第二单 · 2026-10-14
 *
 * 换掉的是**手搓浮层**（`.ctx-backdrop` + `.ctx-menu` + `left: clientX / top: clientY`）。
 * 手搓那版有四个硬伤，全是"抄现成方案"一句话解决的：
 *   ① **不翻转**：贴着窗口右/下边右键，菜单直接出屏（`position:fixed` + 指针坐标，没有 flip/shift）；
 *   ② **无 Esc**：只能点遮罩关；
 *   ③ **全屏遮罩**：菜单开着时整页盖一层透明 div，挡住 hover / 滚动；
 *   ④ **无键盘与 aria**：没有 `role=menu`、没有方向键导航、关闭后焦点不归还。
 * reka-ui 这版自带 floating-ui 定位（flip/shift 防越界）、Esc/点外面关闭、方向键 + 首字母跳转、
 * `role=menu/menuitem` 与焦点归还 —— 而且**不引入任何包裹元素**（`ContextMenuRoot` 只渲染 slot 与 Teleport），
 * 所以卡片的 DOM 与布局一个像素不动。
 *
 * ⚠ 组件**没有自己的根元素**：根是 `ContextMenuRoot`，触发元素就是调用方塞进来的那个卡片。
 *   因此只能用在"单个元素"上，且调用方不能用 `v-show` 挂在组件上（要挂就挂里面那个元素）。
 * ⚠ 菜单项用 `as="button"` 渲染成真 `<button>`：全仓的 e2e（含真 Electron 那套）按
 *   `.ctx-menu button` 选元素，改标签会让它们集体失明。
 * ⚠ 内容根保留 `class="ctx-menu"` —— 那是**测试钩子**（不是样式）；样式全在下面的 utilities 里。
 */
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  ContextMenuPortal,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from 'reka-ui'

const props = defineProps<{
  task: { id: string; title?: string; status?: string }
}>()

/** 只报"点了哪一项"，动作本身留在 App（它才知道怎么改数据） */
const emit = defineEmits<{ (e: 'pick', payload: { task: any; action: string }): void }>()

function pick(action: string): void {
  emit('pick', { task: props.task, action })
}

/**
 * 菜单项统一样式：hover/键盘高亮走 reka-ui 的 `data-highlighted`（不自己写 hover 判断）。
 *
 * ⚠ `border-0 bg-transparent font-[inherit]` 三个不能省：本仓 Tailwind **关着 preflight**
 *   （故意的，见 tailwind.config.js），所以浏览器对 `<button>` 的默认外观还在 ——
 *   不重置的话菜单项会各带一圈浅灰边框 + 用系统 UI 字体，跟旁边的手搓菜单一眼看出是两个东西。
 *   （2026-10-14 截图目检时抓到的，断言当时全绿 —— 又是"断言全绿但东西是坏的"那一类。）
 */
const ITEM =
  'flex w-full cursor-pointer select-none items-center rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-[12.5px] font-[inherit] text-[var(--ui-foreground)] outline-none data-[highlighted]:bg-[var(--ui-accent)]'
const DANGER =
  'text-[var(--ui-destructive)] data-[highlighted]:bg-[color-mix(in_srgb,var(--ui-destructive)_14%,transparent)]'
</script>

<template>
  <ContextMenuRoot>
    <ContextMenuTrigger as-child>
      <slot />
    </ContextMenuTrigger>
    <ContextMenuPortal>
      <ContextMenuContent
        class="ctx-menu z-[61] min-w-[196px] rounded-[10px] border border-[var(--ui-border)] bg-[var(--ui-popover)] p-1 shadow-[0_10px_30px_rgba(30,30,60,0.18)] outline-none"
      >
        <ContextMenuLabel
          class="block max-w-[260px] truncate px-2.5 pb-1 pt-1.5 text-[11px] font-semibold text-[var(--ui-muted-foreground)]"
        >
          {{ props.task.title || props.task.id }}
        </ContextMenuLabel>

        <ContextMenuItem as="button" :class="ITEM" @select="pick('view')">🔍 查看详情</ContextMenuItem>
        <ContextMenuItem as="button" :class="ITEM" @select="pick('edit')">✏️ 编辑</ContextMenuItem>
        <ContextMenuItem v-if="props.task.status === '待验收'" as="button" :class="ITEM" @select="pick('review')">
          ✅ 验收裁决
        </ContextMenuItem>
        <ContextMenuItem as="button" :class="ITEM" @select="pick('assignTime')">📅 指派时间</ContextMenuItem>
        <ContextMenuItem as="button" :class="ITEM" @select="pick('copyId')">📋 复制 ID</ContextMenuItem>
        <ContextMenuItem as="button" :class="ITEM" @select="pick('copyTitle')">🔤 复制标题</ContextMenuItem>
        <!-- 弹药库（卡 031）：卡内容 + 六字段派工单 + 约束卡七条 + 验收四条 + 驳回纪律。
             纯文本拼接、零智能；**只复制，不派发** —— 派发永远留人手（9/20 判死 agent 派活）。 -->
        <ContextMenuItem
          as="button"
          :class="ITEM"
          title="拼一份可直接粘给 agent 的派工单（六字段 + 约束卡七条 + 验收四条 + 驳回纪律）"
          @select="pick('copyDispatch')"
        >
          📐 复制为派工单
        </ContextMenuItem>

        <ContextMenuSeparator class="my-1 h-px bg-[var(--ui-border)]" />

        <ContextMenuItem as="button" :class="ITEM" @select="pick('archive')">📦 归档</ContextMenuItem>
        <ContextMenuItem as="button" :class="[ITEM, DANGER]" @select="pick('delete')">🗑 删除</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>
