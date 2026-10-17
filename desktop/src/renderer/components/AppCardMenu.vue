<script setup lang="ts">
/**
 * 启动台卡片右键菜单（reka-ui `ContextMenu`）
 * 2026-10-17 暮雨：「不能右键卡片进行编辑和删除」—— 编辑原先藏在弹窗里、删除更藏在编辑弹窗里，
 * 卡片本身只有一个 ✏️ 和 📁。右键是这条路最短的入口，所以直接给菜单。
 *
 * 结构照抄 `TaskCardMenu.vue`（同一套 reka-ui 用法），差别只有菜单项：
 * 启动台的卡片背后是"一条登记"，不是任务，所以没有状态流转那几项。
 *
 * ⚠ 与任务卡菜单一样：组件**没有自己的根元素**（根是 ContextMenuRoot），触发元素由调用方塞进来。
 * ⚠ 菜单项用 `as="button"`：e2e 按 `.ctx-menu button` 找元素。
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
  app: { id: string; name?: string; path?: string; cmd?: string }
}>()

const emit = defineEmits<{ (e: 'pick', payload: { app: any; action: string }): void }>()

function pick(action: string): void {
  emit('pick', { app: props.app, action })
}

/** 与 TaskCardMenu 同一套：preflight 关着，必须显式重置 button 的 UA 外观 */
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
          {{ props.app.name || props.app.id }}
        </ContextMenuLabel>

        <ContextMenuItem as="button" :class="ITEM" @select="pick('launch')">🚀 启动</ContextMenuItem>
        <ContextMenuItem as="button" :class="ITEM" @select="pick('edit')">✏️ 编辑登记</ContextMenuItem>
        <ContextMenuItem as="button" :class="ITEM" @select="pick('folder')">📁 打开所在文件夹</ContextMenuItem>

        <ContextMenuSeparator class="my-1 h-px bg-[var(--ui-border)]" />

        <ContextMenuItem as="button" :class="[ITEM, DANGER]" @select="pick('delete')">🗑 删除这条登记</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>
