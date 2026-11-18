<!--
  顶部工具栏工作区 · 拖拽画布（2026-11-18 · 暮雨）

  原话：
    「依然很臃肿……提供 2-3 种预设工作区……另外留一个自定义模式，让用户自己排序或折叠
     （有最少按钮和最多按钮限制，防止按钮全被折叠找不到或按钮太多挤爆页面）。」
    「顺便打勾太丑太蠢了，做个可视化拖拽排序不难吧？单独弄个小画布，打开自定义模式让玩家
     自己拖，可以保存可以取消。」

  所以这一块是**弹窗里的一张画布**，不是设置页里一行复选框：
    上排 = 顶栏（会显示在外面），下排 = 更多（收起来的）。
    把块从一个区拖到另一个区 = 显示/收起；在同一区里拖 = 改顺序。
    底下两个计数实时报"现在几个 / 下限多少 / 上限多少"，**越界当场说人话**，不是拖完才拒绝。

  ⚠ 类名全部 `vl-*` 自起，不复用 `.views-pick` / `.fpop` —— 断言常按 class 数"这一块有几行"，
    套旧类会让旧断言凭空变红（MEMORY 第 2 条）。
  ⚠ 只有「保存」才写盘；「取消」把草稿整个丢掉 —— 拖到一半反悔不该留下痕迹。
-->
<template>
  <div class="vl-shell" @mousedown.self="$emit('close')">
    <div class="vl-box" role="dialog" aria-label="顶部工具栏工作区">
      <div class="vl-head">
        <h3>顶部工具栏：选个工作区</h3>
        <span class="vl-sub">
          拖一块就能换个位置 —— 上下两个区之间拖 = 显示还是收起，同一个区里拖 = 改顺序。
          也可以直接点它（点一下在两个区之间来回搬）。
        </span>
      </div>

      <!-- 预设：三套 + 自定义。点一下立刻把画布换成那套，但**还没落盘**（要按保存） -->
      <div class="vl-presets">
        <Button
          v-for="p in presets"
          :key="'vp-' + p.id"
          :variant="draft.preset === p.id ? 'primary' : 'ghost'"
          size="tool"
          :title="p.desc"
          @click="usePreset(p.id)"
        >{{ p.label }}</Button>
        <Button
          :variant="draft.preset === 'custom' ? 'primary' : 'ghost'"
          size="tool"
          title="自己拖出来的那套（拖动任何一块之后就会切到这里）"
          @click="draft.preset = 'custom'"
        >自定义</Button>
        <span class="vl-cur">{{ presets.find((x) => x.id === draft.preset)?.desc || '你自己拖出来的顺序' }}</span>
      </div>

      <div class="vl-zones">
        <!-- 上：顶栏 -->
        <div class="vl-zone" :class="{ over: dropZone === 'on' }"
          @dragover.prevent="onDragOver('on')" @dragleave="onDragLeave('on')" @drop.prevent="onDrop('on', -1)">
          <div class="vl-zone-head">
            <b>顶栏</b>
            <span class="vl-count" :class="{ bad: !withinMax }">
              {{ onIds.length }} 个 · 最多 {{ MAX_VISIBLE }}
            </span>
          </div>
          <div class="vl-list">
            <div
              v-for="(id, i) in onIds"
              :key="'on-' + id"
              class="vl-item"
              :class="{ dragging: dragId === id, over: dropZone === 'on' && dropIndex === i }"
              draggable="true"
              :data-view="id"
              @dragstart="onDragStart(id)"
              @dragend="onDragEnd"
              @dragover.prevent.stop="onDragOver('on', i)"
              @drop.prevent.stop="onDrop('on', i)"
              @click="toggleItem(id)"
            >
              <span class="vl-grip" aria-hidden="true"></span>
              <span class="vl-name">{{ labelOf(id) }}</span>
            </div>
            <div v-if="!onIds.length" class="vl-empty">一个都没放 —— 至少留 {{ MIN_VISIBLE }} 个</div>
          </div>
        </div>

        <!-- 下：更多 -->
        <div class="vl-zone" :class="{ over: dropZone === 'off' }"
          @dragover.prevent="onDragOver('off')" @dragleave="onDragLeave('off')" @drop.prevent="onDrop('off', -1)">
          <div class="vl-zone-head">
            <b>收进「更多 ▾」</b>
            <span class="vl-count">{{ offIds.length }} 个 · 点顶栏的「更多」才看得到</span>
          </div>
          <div class="vl-list">
            <div
              v-for="(id, i) in offIds"
              :key="'off-' + id"
              class="vl-item off"
              :class="{ dragging: dragId === id, over: dropZone === 'off' && dropIndex === i }"
              draggable="true"
              :data-view="id"
              @dragstart="onDragStart(id)"
              @dragend="onDragEnd"
              @dragover.prevent.stop="onDragOver('off', i)"
              @drop.prevent.stop="onDrop('off', i)"
              @click="toggleItem(id)"
            >
              <span class="vl-grip" aria-hidden="true"></span>
              <span class="vl-name">{{ labelOf(id) }}</span>
            </div>
            <div v-if="!offIds.length" class="vl-empty">没收起任何一个</div>
          </div>
        </div>
      </div>

      <!-- 越界与提示：三条口径都在这里说人话，不靠 toast 一闪而过 -->
      <div class="vl-msg" :class="{ bad: !withinMin || !withinMax }">{{ hintText }}</div>

      <div class="vl-foot">
        <Button variant="ghost" size="tool" @click="$emit('reset')">恢复默认（日常）</Button>
        <span class="vl-grow"></span>
        <Button variant="ghost" size="tool" @click="$emit('close')">取消</Button>
        <Button variant="primary" size="tool" :disabled="!withinMin || !withinMax" @click="save">
          保存
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from './ui/Button.vue'
import {
  MAX_VISIBLE, MIN_VISIBLE, applyPreset, moveView,
  splitVisible, type ViewLayout, type ViewPreset,
} from '../../shared/viewLayout'

const props = defineProps<{
  layout: ViewLayout
  views: { id: string; label: string }[]
  presets: ViewPreset[]
}>()
const emit = defineEmits<{
  (e: 'save', v: ViewLayout): void
  (e: 'close'): void
  (e: 'reset'): void
}>()

const allIds = computed(() => props.views.map((v) => v.id))
/** 草稿：所有拖动只动它，保存才交给外面 */
const draft = ref<ViewLayout>({
  order: [...props.layout.order],
  hidden: [...props.layout.hidden],
  preset: props.layout.preset,
})

const split = computed(() => splitVisible(draft.value, allIds.value))
const onIds = computed(() => split.value.visible)
const offIds = computed(() => split.value.hidden)

const withinMin = computed(() => onIds.value.length >= MIN_VISIBLE)
const withinMax = computed(() => onIds.value.length <= MAX_VISIBLE)

const hintText = computed(() => {
  if (!withinMax.value) return `顶栏放了 ${onIds.value.length} 个，超过上限 ${MAX_VISIBLE} —— 收几个再说（再放就挤爆了）`
  if (!withinMin.value) return `顶栏只剩 ${onIds.value.length} 个，少于下限 ${MIN_VISIBLE} —— 都收起来就找不到工具了`
  return `顶栏 ${onIds.value.length} 个（限 ${MIN_VISIBLE}–${MAX_VISIBLE}）· 收起 ${offIds.value.length} 个 —— 满意就按保存`
})

function labelOf(id: string): string {
  return props.views.find((v) => v.id === id)?.label || id
}

function usePreset(id: string): void {
  const r = applyPreset(id, allIds.value, props.presets)
  if (!r.ok) return
  draft.value = { order: [...r.layout.order], hidden: [...r.layout.hidden], preset: r.layout.preset }
}

// ── 拖拽（HTML5 原生 drag，零依赖）─────────────────────────────────────
// 为什么要记 dropIndex：拖到"某一块身上"和拖到"空区"是两种落点，
// 前者要插在它前面，后者追加到末尾 —— 混着用会出现"拖过去顺序没变"。
const dragId = ref('')
const dropZone = ref<'' | 'on' | 'off'>('')
const dropIndex = ref(-1)

function onDragStart(id: string): void {
  dragId.value = id
}
function onDragEnd(): void {
  dragId.value = ''
  dropZone.value = ''
  dropIndex.value = -1
}
function onDragOver(zone: 'on' | 'off', index = -1): void {
  dropZone.value = zone
  dropIndex.value = index
}
function onDragLeave(zone: 'on' | 'off'): void {
  // 只有"离开的正是当前悬停那个区"才清掉，避免子元素抖动
  if (dropZone.value === zone && dropIndex.value < 0) dropZone.value = ''
}

/**
 * 一次落点要同时做两件事：**先决定它在不在顶栏**，再决定插在哪。
 *
 * ⚠ 顺序不能反：先改顺序再改可见性的话，moveView 会按"旧可见性"算下标，
 *   跨区拖动会插到差一位的位置（这类偏移在界面上表现为"拖过去了但位置怪怪的"）。
 */
function onDrop(zone: 'on' | 'off', index: number): void {
  const id = dragId.value
  if (!id) return
  const seq = split.value.visible.concat(split.value.hidden) // 仅用于计算目标下标
  const wantOn = zone === 'on'

  const hide = new Set(draft.value.hidden)
  if (wantOn && hide.has(id)) {
    if (split.value.visible.length >= MAX_VISIBLE) { dragId.value = ''; dropZone.value = ''; return }
    hide.delete(id)
  } else if (!wantOn && !hide.has(id)) {
    if (split.value.visible.length <= MIN_VISIBLE) { dragId.value = ''; dropZone.value = ''; return }
    hide.add(id)
  }
  // 目标区（落点区）里的顺序：拿另一区的块做"插到谁前面"的锚点
  const zoneIds = (wantOn ? split.value.visible : split.value.hidden).filter((x) => x !== id)
  const rest = seq.filter((x) => x !== id)
  let anchorIndex: number
  if (index >= 0 && zoneIds[index]) {
    anchorIndex = rest.indexOf(zoneIds[index])
  } else {
    // 落到空区/末尾 = 放在目标区最后一个元素之后
    const last = zoneIds[zoneIds.length - 1]
    anchorIndex = last ? rest.indexOf(last) + 1 : rest.length
  }
  draft.value = moveView({ ...draft.value, hidden: [...hide] }, id, anchorIndex, rest)
  dragId.value = ''
  dropZone.value = ''
  dropIndex.value = -1
}

/** 点一下 = 在两个区之间搬（鼠标拖不动时的兜底，也是最快的单手操作） */
function toggleItem(id: string): void {
  const hide = new Set(draft.value.hidden)
  const visibleCount = split.value.visible.length
  if (hide.has(id)) {
    if (visibleCount >= MAX_VISIBLE) return
    hide.delete(id)
  } else {
    if (visibleCount <= MIN_VISIBLE) return
    hide.add(id)
  }
  draft.value = { ...draft.value, hidden: [...hide], preset: 'custom' }
}

function save(): void {
  if (!withinMin.value || !withinMax.value) return
  emit('save', {
    order: [...draft.value.order],
    hidden: [...draft.value.hidden],
    preset: draft.value.preset,
  })
}
</script>
