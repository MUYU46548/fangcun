<script setup lang="ts">
/**
 * 免责与知情声明弹窗（2026-10-16，暮雨第 1 条）—— 做法照抄绒花墨坊的
 * `NovelForge/console/src/DisclaimerDialog.vue`（那是暮雨点的参照物：
 * 「希望你还记得要学绒花墨坊写那些需要用户首次强制同意确认的免责声明，主要是涉及到钱是非多」）。
 *
 * 两种模式：
 *   first-run —— 首启强制。必须滚到条款底部才能勾选「我已阅读并同意」；勾了才能确认；
 *                旁边是「不同意并退出」（window.close()）。刻意**没有**遮罩点击关闭、
 *                **没有** ESC 旁路 —— 这是真锁模态（Tab 焦点困在弹窗内），不是视觉遮挡。
 *   view      —— 随时查看（设置页 / 帮助页入口）。普通弹窗，底部显示既往确认时间。
 *
 * ⚠ 强制模式**刻意不用 `.overlay` 这个 class**：App.vue 的全局 Esc 处理会取 DOM 里
 *   最后一个可见 `.overlay`、点它的 `.acts .ghost` —— 而本弹窗的 `.acts` 里有
 *   「不同意并退出」，按一下 ESC 就把人踢出软件，这是不能接受的。
 *   （view 模式没这个顾虑，走 `.overlay`：ESC 命中兜底 → 派发 mousedown 到遮罩 → 关掉。）
 *
 * ⚠ 文案不写在这个文件里：见 `../disclaimer.ts`（单一事实源，改字只改那里）。
 */
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import Button from './ui/Button.vue'
import {
  DISCLAIMER_VERSION,
  DISCLAIMER_SHORT_SECTIONS,
  DISCLAIMER_FULL_SECTIONS,
  ackDisclaimer,
} from '../disclaimer'

const props = defineProps<{
  open: boolean
  /** 'first-run' = 首启强制；'view' = 随时查看 */
  mode?: string
  /** 既往确认时间（ISO 串），view 模式显示 */
  ackedAt?: string
}>()
const emit = defineEmits(['close', 'ack'])

const detailView = ref(false)   // false = 短版 / true = 完整版
const forced = computed(() => props.mode === 'first-run')
const sections = computed(() => (detailView.value ? DISCLAIMER_FULL_SECTIONS : DISCLAIMER_SHORT_SECTIONS))

const scrolledToEnd = ref(true) // 内容不足一屏时，视为已到底（不用滚也算读完）
const agreed = ref(false)
const bodyEl = ref<HTMLElement | null>(null)
const dlgEl = ref<HTMLElement | null>(null)

/** 滚到底才允许勾选 —— 判据留 24px 容差（不同缩放下 scrollHeight 有亚像素差） */
function checkScroll(): void {
  const el = bodyEl.value
  if (!el) return
  scrolledToEnd.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
}

watch(() => props.open, async (v) => {
  if (!v) return
  agreed.value = false
  detailView.value = false
  await nextTick()
  checkScroll()
  await nextTick()
  const first = dlgEl.value?.querySelector<HTMLElement>('button, input, [tabindex]')
  first?.focus()
})

function onAgree(): void {
  const at = ackDisclaimer()
  emit('ack', at)
}

/** 不同意 = 退出软件。走 window.close()：触发主进程 before-quit 钩子（存盘确认照常工作） */
function onExit(): void {
  window.close()
}

/** 只有 view 模式允许点遮罩关闭；强制模式点遮罩什么也不发生 */
function onMaskDown(): void {
  if (!forced.value) emit('close')
}

/** focus trap：Tab 循环困在弹窗内（真锁模态，不是"视觉上盖住"） */
function onKeydownTab(e: KeyboardEvent): void {
  if (e.key !== 'Tab') return
  const dlg = dlgEl.value
  if (!dlg) return
  const focusables = dlg.querySelectorAll<HTMLElement>(
    'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
  )
  if (!focusables.length) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const active = dlg.contains(document.activeElement) ? document.activeElement as HTMLElement : null
  if (e.shiftKey) {
    if (!active || active === first) { e.preventDefault(); last.focus() }
  } else {
    if (!active || active === last) { e.preventDefault(); first.focus() }
  }
}

const keyHandler = (e: KeyboardEvent): void => {
  if (!forced.value || !props.open) return
  // 强制模式：ESC 不许关（连事件都拦掉，免得被别处的全局手势捡走）
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return }
  onKeydownTab(e)
}

watch(() => [props.open, props.mode], ([o]) => {
  if (o && forced.value) document.addEventListener('keydown', keyHandler, true)
  else document.removeEventListener('keydown', keyHandler, true)
}, { immediate: true })

onBeforeUnmount(() => document.removeEventListener('keydown', keyHandler, true))

function fmtTime(iso: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
  } catch { return iso }
}
</script>

<template>
  <div v-if="open"
       :class="forced
         ? 'fixed inset-0 z-[90] flex items-center justify-center bg-[rgba(30,32,44,.62)] p-6'
         : 'overlay'"
       @mousedown.self="onMaskDown">
    <div ref="dlgEl" role="dialog" aria-modal="true" aria-label="免责与知情声明"
         class="flex max-h-[88vh] w-[min(690px,94vw)] flex-col rounded-2xl border border-[var(--ui-border)] bg-[var(--ui-card)] p-5 shadow-[0_24px_64px_rgba(0,0,0,.28)]">
      <div class="mb-1.5 flex flex-wrap items-baseline gap-2.5">
        <h3 class="m-0 text-[17px] font-bold text-[var(--ui-foreground)]">
          {{ forced ? (detailView ? '免责与知情声明 · 完整版' : '使用前请确认 · 免责与知情声明') : '免责与知情声明 · 完整版' }}
        </h3>
        <span v-if="!forced" class="text-[11.5px] text-[var(--ui-muted-foreground)]">v{{ DISCLAIMER_VERSION }}</span>
      </div>

      <div ref="bodyEl" @scroll="checkScroll"
           class="min-h-[200px] flex-1 overflow-y-auto rounded-[10px] border border-[var(--ui-border)] bg-[var(--ui-accent)] px-3.5 py-2.5">
        <template v-for="(s, i) in sections" :key="i">
          <h4 class="mb-1 mt-3 text-[13.5px] font-bold text-[var(--ui-foreground)]">{{ s.title }}</h4>
          <p v-for="(p, j) in s.paras" :key="'p' + j"
             class="mb-1.5 mt-0 text-[13px] leading-[1.75] text-[var(--ui-foreground)]">{{ p }}</p>
        </template>
      </div>

      <!-- 首启强制模式 -->
      <template v-if="forced">
        <template v-if="!detailView">
          <div class="mt-3.5 flex flex-wrap items-center gap-2.5">
            <label class="flex cursor-pointer items-center gap-1.5 text-[13px] text-[var(--ui-foreground)]">
              <input type="checkbox" v-model="agreed" :disabled="!scrolledToEnd" class="cursor-pointer font-[inherit]" />
              我已阅读并同意以上全部内容
            </label>
            <span class="flex-1"></span>
            <Button variant="danger" size="sm" @click="onExit">不同意并退出</Button>
            <Button variant="primary" size="sm" :disabled="!agreed" @click="onAgree">我已阅读并同意</Button>
          </div>
          <div class="mt-1.5 text-[11.5px] leading-relaxed text-[var(--ui-muted-foreground)]">
            未滚到条款底部前无法勾选 · 不同意则退出软件（不强迫使用） ·
            <button type="button"
                    class="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-[11.5px] text-[var(--ui-primary)] underline"
                    @click="detailView = true">查看完整声明 →</button>
            · 声明更新后会在下次启动时再次弹出
          </div>
        </template>
        <template v-else>
          <div class="mt-3.5 flex">
            <Button variant="outline" size="sm" @click="detailView = false">← 返回确认页</Button>
          </div>
        </template>
      </template>

      <!-- 随时查看模式 -->
      <template v-else>
        <div class="mt-3.5 flex flex-wrap items-center gap-2.5">
          <span v-if="ackedAt" class="text-[11.5px] text-[var(--ui-muted-foreground)]">
            您已于 {{ fmtTime(ackedAt) }} 确认本声明（v{{ DISCLAIMER_VERSION }}）
          </span>
          <span v-else class="text-[11.5px] text-[var(--ui-destructive)]">本机尚未确认过本声明</span>
          <span class="flex-1"></span>
          <Button variant="primary" size="sm" @click="emit('close')">关闭</Button>
        </div>
      </template>
    </div>
  </div>
</template>
