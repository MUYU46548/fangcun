<!--
  方寸自绘架构图（2026-10-30，卡 task-20261030-002）

  与「架构图」按钮（打开仓库里 archify 产物）的分工：
    · 那个是打开**别人画的**；
    · 这个是方寸**只读扫源码**自己画的（节点=真实目录，连线=真实 import/IPC 计数）。

  这里不画新的几何：SVG 由 `shared/archSvg.ts` 的纯函数给（同一份代码在 Node 里被
  `e2e-project-arch.cjs` 真跑断言）。组件只做三件事：贴图、点节点高亮、把证据/缺项摆出来。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { renderArchSvg } from '../../shared/archSvg'
import type { ArchGraph } from '../../shared/archGraph'

const props = defineProps<{ graph: ArchGraph; busy?: boolean }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'export'): void }>()

const active = ref('')
watch(() => props.graph, () => { active.value = '' })

const svg = computed(() => renderArchSvg(props.graph, { active: active.value }))
const node = computed(() => (props.graph.nodes || []).find((n) => n.id === active.value) || null)
const missing = computed(() => props.graph.missing || [])
const evidence = computed(() => props.graph.evidence || [])

/** 事件委托：点 SVG 里任意 [data-node] 都算选中（不必给每个节点绑事件） */
function onCanvasClick(e: MouseEvent): void {
  const el = (e.target as Element | null)?.closest?.('[data-node]')
  const id = el ? String(el.getAttribute('data-node') || '') : ''
  active.value = active.value === id ? '' : id
}
</script>

<template>
  <div id="arch-modal" class="archd">
    <div class="archd-head">
      <div class="archd-head-main">
        <div class="archd-ttl">{{ graph.title }}</div>
        <div class="archd-sub">{{ graph.subtitle }}</div>
      </div>
      <span class="archd-text">{{ graph.text }}</span>
      <span class="archd-grow"></span>
      <button class="ghost font-[inherit]" :disabled="busy" title="导出成一份独立 HTML（保存位置由你选）" @click="emit('export')">
        {{ busy ? '导出中…' : '导出 HTML…' }}
      </button>
      <button class="ghost font-[inherit]" @click="emit('close')">关闭</button>
    </div>

    <div class="archd-body">
      <div class="archd-canvas" @click="onCanvasClick" v-html="svg"></div>
      <aside class="archd-side">
        <div class="archd-side-block" v-if="node">
          <div class="archd-side-h">{{ node.label }}<span class="archd-side-n">{{ node.files }} 个文件</span></div>
          <div class="archd-side-note">{{ node.note }}</div>
          <div class="archd-side-list">
            <div v-for="(s, i) in node.samples" :key="'s' + i" class="archd-side-item">{{ s }}</div>
            <div v-if="!node.samples.length" class="archd-side-none">这个节点没有可列的文件样例</div>
          </div>
        </div>
        <div class="archd-side-block" v-else>
          <div class="archd-side-h">怎么读</div>
          <div class="archd-side-note">
            点一个方块看它由哪些文件构成；点一下再点一次取消。
            方块里的大数字是扫到的代码文件数，不是"应该有"的模块数。
          </div>
          <div class="archd-side-none">没有选中的节点</div>
        </div>

        <div class="archd-side-block" v-if="missing.length">
          <div class="archd-side-h miss">缺什么（缺不等于没有）</div>
          <div class="archd-side-item" v-for="(m, i) in missing" :key="'m' + i">
            <b>{{ m.what }}</b>：{{ m.why }}
          </div>
        </div>

        <div class="archd-side-block">
          <div class="archd-side-h">证据（这些数字从哪来）</div>
          <div class="archd-side-item" v-for="(e, i) in evidence" :key="'e' + i">{{ e }}</div>
        </div>
      </aside>
    </div>

    <div class="archd-foot">
      节点只来自真实存在的目录；连线只来自真实的 import / IPC 计数 —— 没有证据的地方不画箭头，也不编模块。
    </div>
  </div>
</template>

<style scoped>
.archd {
  width: min(1180px, 96vw); max-height: 92vh; display: flex; flex-direction: column;
  background: var(--card); border: 1px solid var(--border); border-radius: 16px;
  box-shadow: var(--shadow); padding: 14px 16px 10px;
}
.archd-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-bottom: 10px; border-bottom: 1px solid var(--line-2); }
.archd-head-main { display: flex; flex-direction: column; gap: 2px; }
.archd-ttl { font-size: 16px; font-weight: 700; }
.archd-sub { font-size: 11.5px; color: var(--muted); }
.archd-text { font-size: 11.5px; color: var(--ink); background: var(--tint-3); border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px; }
.archd-grow { flex: 1; }
.archd-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 12px; padding: 10px 0 6px; }
.archd-canvas { min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--tint-3); padding: 4px; }
.archd-canvas :deep(svg) { width: 100%; height: auto; display: block; }
.archd-side { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.archd-side-block { border: 1px solid var(--border); border-radius: 10px; padding: 9px 11px; background: var(--card); }
.archd-side-h { font-size: 12px; font-weight: 700; display: flex; align-items: baseline; gap: 8px; }
.archd-side-h.miss { color: var(--warning); }
.archd-side-n { font-size: 10.5px; font-weight: 400; color: var(--muted); }
.archd-side-note { font-size: 11.5px; color: var(--muted); line-height: 1.65; margin-top: 4px; }
.archd-side-list { margin-top: 6px; display: flex; flex-direction: column; gap: 3px; }
.archd-side-item { font-size: 11px; color: var(--ink); line-height: 1.55; word-break: break-all; }
.archd-side-none { font-size: 11px; color: var(--muted); margin-top: 4px; }
.archd-foot { padding-top: 6px; border-top: 1px solid var(--line-2); font-size: 10.5px; color: var(--muted); }
@media (max-width: 900px) {
  .archd-body { grid-template-columns: 1fr; }
  .archd-side { max-height: 220px; }
}
</style>
