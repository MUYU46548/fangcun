<!--
  方寸绘制架构图（2026-10-30，卡 task-20261030-002；同日按暮雨第 3 条重做）

  与“架构图”按钮（打开仓库里 archify 产物）的分工：
    · 那个是打开**别人画好的**；
    · 这个是方寸**只读扫源码**自己画的（节点=真实目录，连线=真实 import/IPC 计数）。

  2026-10-30 暮雨原话：“质量极差，无实战意义……人家 archify 是层层校验才能画出来的，
  agent 画一笔都要审批，不通过自己重画。”所以这一版不是"扫完直接画"：
    · 七道校验门（证据 / 唯一 / 规模 / 行宽 / 标签 / 几何 / 比例）逐条摆出来；
    · 人可以**逐块剔除**（这一笔画得不认可），也可以整张**驳回重画**（按诊断做减法）；
    · **通过**之后才允许导出 —— 没签字的图不落盘。

  这里不画新的几何：SVG 由 `shared/archSvg.ts` 的纯函数给（同一份代码在 Node 里被
  `e2e-project-arch.cjs` 真跑断言）。组件只做三件事：贴图、点节点、把证据/校验/缺项摆出来。
-->
<script setup lang="ts">
import Button from './ui/Button.vue'
import { computed, ref, watch } from 'vue'
import { renderArchSvg } from '../../shared/archSvg'
import type { ArchGraph } from '../../shared/archGraph'
import type { ArchReview } from '../../shared/archValidate'

const props = defineProps<{
  graph: ArchGraph
  review?: ArchReview | null
  repairs?: string[]
  /** 历次驳回理由（最新在后）；空 = 没被驳回过 */
  rejects?: string[]
  busy?: boolean
  /** 生成进度一句话（第几次 / 在审计哪一条）—— 11-03 驳回"挂着窗口干等" */
  phase?: string
  /** 上次生成结果（关窗后回来也查得到） */
  lastRun?: any
  /** 生成已耗时（秒）。由父组件的计时器给 —— 组件不自己起表，切图重挂也不重置 */
  elapsed?: number
  version?: number
  approved?: boolean
  /** 已剔除的节点 id（父组件持有，切图后仍在） */
  excluded?: string[]
  /** 已剔除节点的名字（节点已不在图里，侧栏要能列出来并“放回”） */
  excludedInfo?: Array<{ id: string; label: string }>
}>()
const emit = defineEmits<{
  (e: 'cancel'): void
  (e: 'close'): void
  (e: 'export'): void
  (e: 'exclude', id: string): void
  (e: 'restore', id: string): void
  (e: 'approve'): void
  (e: 'reject', reason: string): void
  /** AI 生成图（2026-11-02）：点一下才调模型；审计不过会自动降级成扫描图 */
  (e: 'generate'): void
}>()

const active = ref('')
const rejecting = ref(false)
const rejectText = ref('')
/**
 * 生成中要关面板时的二次确认（2026-11-05 暮雨第 2 条：“用户等不及会点关闭，是否有影响？”）
 *
 * 答案是有影响：生成在主进程里继续跑、token 照花，但面板已经关了，**结果没人看得见**。
 * 所以这里不直接关，先把代价说清楚；`busy` 结束会自动收起这条提示（人已经走了就不用再问）。
 */
const closeWarn = ref(false)
watch(() => props.busy, (v) => { if (!v) closeWarn.value = false })

function requestClose(): void {
  if (props.busy && !closeWarn.value) { closeWarn.value = true; return }
  emit('close')
}
watch(() => props.graph, () => { active.value = '' })

/** 被剔除的块已经不在图里，但侧栏还要能把它们列出来（父组件传名字进来） */
const excludedNodes = computed(() => props.excludedInfo || [])
const svg = computed(() => renderArchSvg(props.graph, { active: active.value }))
const node = computed(() => (props.graph.nodes || []).find((n) => n.id === active.value) || null)
const missing = computed(() => props.graph.missing || [])
const evidence = computed(() => props.graph.evidence || [])
const gates = computed(() => props.review?.gates || [])
const errorGates = computed(() => gates.value.filter((g) => g.severity === 'error' && !g.pass))
const canApprove = computed(() => !!props.review?.ok && !props.busy)

/** 事件委托：点 SVG 里任意 [data-node] 都算选中（不必给每个节点绑事件） */
function onCanvasClick(e: MouseEvent): void {
  const el = (e.target as Element | null)?.closest?.('[data-node]')
  const id = el ? String(el.getAttribute('data-node') || '') : ''
  active.value = active.value === id ? '' : id
}

function submitReject(): void {
  const why = rejectText.value.trim()
  emit('reject', why)
  rejecting.value = false
  rejectText.value = ''
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
      <span v-if="version && version > 1" class="archd-ver" :title="'被驳回后重画到第 ' + version + ' 版'">第 {{ version }} 版</span>
      <span v-if="approved" class="archd-ok">✅ 已通过</span>
      <span class="archd-grow"></span>
      <!-- 上次生成结果（关窗/切页回来也查得到"上次怎么了"）——
           11-03 驳回原话："点关闭是否有影响？" 现在答案是：结果落盘，重开就看得到。 -->
      <span v-if="lastRun && !busy" class="archd-last" :class="{ bad: lastRun.source !== 'ai' && !lastRun.cancelled }">
        {{ lastRun.cancelled ? '上次：已取消' : lastRun.source === 'ai' ? '上次：生成成功' : '上次：扫描图' }}
        <template v-if="lastRun.reason">· {{ lastRun.reason }}</template>
        <template v-if="lastRun.ms">· {{ Math.round((lastRun.ms || 0) / 1000) }}s</template>
      </span>
      <button v-if="busy" class="danger archd-cancel font-[inherit]" title="取消这次扫描：不会再发下一次请求，也不会写任何图" @click="emit('cancel')">
        取消
      </button>
      <Button class="archd-gen font-[inherit]" variant="ghost" size="tool" :disabled="busy"
        title="只读扫源码重画一版：节点 = 真实目录、连线 = 真实 import / IPC 计数；不走模型（D-152 全走 DSH）"
        @click="emit('generate')">
        {{ busy ? `${phase || '扫描中…'} ${elapsed || 0}s` : '⟳ 重新扫描' }}
      </Button>
      <button class="ghost font-[inherit]" :disabled="busy || !approved || !review?.ok"
        :title="!review?.ok ? '校验没过，先重画或剔除问题块' : (!approved ? '先点“通过这张图”' : '导出成一份独立 HTML（保存位置由你选）')"
        @click="emit('export')">
        {{ busy ? '导出中…' : '导出 HTML…' }}
      </button>
      <button class="ghost font-[inherit]" :title="busy ? '还在生成 —— 点了会先问你一句' : '关闭这张图'"
        @click="requestClose()">{{ busy ? '关闭' : '关闭' }}</button>
    </div>

    <!-- 生成中横幅（2026-11-05 暮雨第 2 条：“耗时很长，没其他提示，挂着窗口干等”）——
         只报**真数字**（已等几秒），不编百分比：模型不回传进度，编一个就是假成功。
         同时把“能不能关”写在这儿，省得他点关闭之后才发现结果没了。 -->
    <div v-if="busy" class="archd-busybar">
      <span class="archd-busybar-dot"></span>
      <span>正在只读扫描源码… 已等 <b>{{ elapsed || 0 }}</b> 秒（通常 1–3 秒；零模型，不发外部请求）</span>
      <span class="archd-busybar-note">现在关掉面板不会中断这次扫描 —— 但结果你看不到</span>
    </div>
    <div v-if="closeWarn" class="archd-closewarn">
      <span>还在扫描（已 {{ elapsed || 0 }} 秒）。<b>现在关掉 = 这次扫描白做</b>，图也看不到。</span>
      <button class="ghost font-[inherit]" @click="closeWarn = false">继续等</button>
      <button class="danger font-[inherit]" @click="emit('close')">仍然关闭</button>
    </div>

    <div class="archd-body">
      <div class="archd-canvas" @click="onCanvasClick" v-html="svg"></div>
      <aside class="archd-side">
        <!-- 选中的块：这一笔认不认可 -->
        <div class="archd-side-block" v-if="node">
          <div class="archd-side-h">{{ node.label }}<span class="archd-side-n">{{ node.files }} 个文件</span></div>
          <div class="archd-side-note">{{ node.note }}</div>
          <div class="archd-side-list">
            <div v-for="(s, i) in node.samples" :key="'s' + i" class="archd-side-item">{{ s }}</div>
            <div v-if="!node.samples.length" class="archd-side-none">这个节点没有可列的文件样例</div>
          </div>
          <Button class="archd-exclude" variant="ghost" size="tool" title="这一块画得不对：把它从图里剔掉（不是改数据，只是这张图不画它）"
            @click="emit('exclude', node.id)">✂ 剔除这一块</Button>
        </div>
        <div class="archd-side-block" v-else>
          <div class="archd-side-h">怎么读</div>
          <div class="archd-side-note">
            点一个方块看它由哪些文件构成；点一下再点一次取消。
            方块里的大数字是扫到的代码文件数，不是"应该有"的模块数。
            不认可哪一块，就点开它再点“剔除这一块”。
          </div>
          <div class="archd-side-none">没有选中的节点</div>
        </div>

        <!-- 校验门（2026-10-30 第 3 条）：先过门，再谈好不好看 -->
        <div class="archd-side-block" v-if="review">
          <div class="archd-side-h">
            校验 <span class="archd-side-n">{{ review.passCount }}/{{ review.total }} 道通过 · {{ review.score }} 分</span>
          </div>
          <div class="archd-gate" v-for="g in gates" :key="g.id" :class="{ bad: !g.pass && g.severity === 'error', warn: !g.pass && g.severity === 'warn' }">
            <span class="ag-i">{{ g.pass ? '✓' : (g.severity === 'error' ? '✕' : '!') }}</span>
            <span class="ag-b">
              <b>{{ g.name }}</b>
              <span class="ag-d">{{ g.detail }}</span>
              <span v-if="!g.pass && g.fix" class="ag-f">修法：{{ g.fix }}</span>
            </span>
          </div>
          <div v-if="!review.ok" class="archd-gate-sum bad">{{ errorGates.length }} 道硬门没过 —— 这张图不能导出，先重画或剔除问题块。</div>
        </div>

        <div class="archd-side-block" v-if="(repairs || []).length || (rejects || []).length">
          <div class="archd-side-h">这一版重画做了什么</div>
          <div class="archd-side-item" v-for="(r, i) in repairs" :key="'r' + i">· {{ r }}</div>
          <div class="archd-reject-why" v-for="(r, i) in (rejects || [])" :key="'rj' + i">第 {{ i + 1 }} 版被驳回：{{ r }}</div>
        </div>

        <div class="archd-side-block" v-if="excludedNodes.length">
          <div class="archd-side-h">已剔除的块 <span class="archd-side-n">{{ excludedNodes.length }} 个</span></div>
          <div class="archd-side-item ex" v-for="n in excludedNodes" :key="'ex' + n.id">
            <span>{{ n.label }}</span>
            <button class="ghost ex-back" @click="emit('restore', n.id)">放回</button>
          </div>
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
      <div class="archd-foot-text">
        节点只来自真实存在的目录；连线只来自真实的 import / IPC 计数 —— 没有证据的地方不画箭头，也不编模块。
        <b>导出前必须过校验并点“通过”</b>：没签字的图不会导出。
      </div>
      <div class="archd-foot-acts">
        <template v-if="!rejecting">
          <Button variant="ghost" size="tool" :disabled="busy" title="这张图不认：写下哪里不行，方寸按诊断重画一版（不会改你的仓库）"
            @click="rejecting = true">↩ 驳回重画</Button>
          <button class="ok" :disabled="!canApprove || approved" :title="review?.ok ? '确认这张图，允许导出' : '校验没过，先把硬门修过'"
            @click="emit('approve')">{{ approved ? '✅ 已通过' : '✅ 通过这张图' }}</button>
        </template>
        <template v-else>
          <input v-model="rejectText" class="archd-reject-in" placeholder="哪里不行（例如：主进程太碎 / 有一条线对不上）"
            @keydown.enter="submitReject" />
          <Button variant="ghost" size="tool" @click="rejecting = false">取消</Button>
          <button class="danger" :disabled="busy" @click="submitReject">驳回并按诊断重画</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.archd {
  width: min(1280px, 96vw); max-height: 92vh; display: flex; flex-direction: column;
  background: var(--card); border: 1px solid var(--border); border-radius: 16px;
  box-shadow: var(--shadow); padding: 14px 16px 10px;
}
.archd-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-bottom: 10px; border-bottom: 1px solid var(--line-2); }
.archd-head-main { display: flex; flex-direction: column; gap: 2px; }
.archd-ttl { font-size: 16px; font-weight: 700; }
.archd-sub { font-size: 11.5px; color: var(--muted); }
.archd-text { font-size: 11.5px; color: var(--ink); background: var(--tint-3); border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px; }
.archd-ver { font-size: 10.5px; font-weight: 700; color: #7a5a12; background: #fbf3df; border: 1px solid #e8d6a6; border-radius: 999px; padding: 2px 8px; }
.archd-ok { font-size: 11px; font-weight: 700; color: #3f6b3a; background: #e9f3e4; border: 1px solid #bcd4b4; border-radius: 999px; padding: 2px 8px; }
.archd-grow { flex: 1; }
.archd-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 12px; padding: 10px 0 6px; }
.archd-canvas { min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--tint-3); padding: 4px; }
.archd-canvas :deep(svg) { width: 100%; height: auto; display: block; }
.archd-side { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.archd-side-block { border: 1px solid var(--border); border-radius: 10px; padding: 9px 11px; background: var(--card); }
.archd-side-h { font-size: 12px; font-weight: 700; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.archd-side-h.miss { color: var(--warning); }
.archd-side-n { font-size: 10.5px; font-weight: 400; color: var(--muted); }
.archd-side-note { font-size: 11.5px; color: var(--muted); line-height: 1.65; margin-top: 4px; }
.archd-side-list { margin-top: 6px; display: flex; flex-direction: column; gap: 3px; }
.archd-side-item { font-size: 11px; color: var(--ink); line-height: 1.55; word-break: break-all; }
.archd-side-none { font-size: 11px; color: var(--muted); margin-top: 4px; }
.archd-gen { font-weight: 600; }
.archd-exclude { margin-top: 8px; width: 100%; font-size: 11.5px; height: 26px; color: #8a4d47; border-color: #e2c4c4; }
.archd-gate { display: flex; gap: 6px; margin-top: 6px; font-size: 11px; line-height: 1.5; }
.archd-gate .ag-i { flex: none; width: 12px; font-weight: 700; color: #3f6b3a; }
.archd-gate.bad .ag-i { color: #b03a2e; }
.archd-gate.warn .ag-i { color: #a8761a; }
.archd-gate .ag-b { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.archd-gate .ag-d { color: var(--muted); }
.archd-gate.bad .ag-d { color: #8a4343; }
.archd-gate .ag-f { color: #7d7889; font-size: 10.5px; }
.archd-gate-sum { margin-top: 8px; font-size: 11px; line-height: 1.55; padding: 6px 8px; border-radius: 7px; }
.archd-gate-sum.bad { color: #8a4343; background: #fbf1f0; border: 1px solid #efd9d6; }
.archd-side-item.ex { display: flex; align-items: center; gap: 6px; }
.archd-reject-why { margin-top: 6px; font-size: 10.5px; line-height: 1.55; color: #8a4343; background: #fbf1f0; border: 1px solid #efd9d6; border-radius: 6px; padding: 4px 7px; }
.archd-side-item.ex span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ex-back { flex: none; font-size: 10.5px; height: 22px; padding: 0 6px; }
.archd-foot { padding-top: 8px; border-top: 1px solid var(--line-2); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.archd-foot-text { flex: 1 1 320px; font-size: 10.5px; color: var(--muted); line-height: 1.6; }
.archd-foot-text b { color: var(--ink); }
.archd-foot-acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.archd-foot-acts button { font-size: 12px; }
.archd-reject-in { width: 280px; height: 28px; padding: 0 9px; border: 1px solid var(--border); border-radius: 7px; font: inherit; font-size: 12px; background: #fff; color: var(--ink); }
/* 生成中横幅 / 关闭确认（2026-11-05 暮雨第 2 条）——
   前者的唯一职责是"让你知道它还在跑、等了多久"；后者是"关掉要付什么代价"。
   两处都不编进度条：模型不回传进度，画一个 60% 就是假成功。 */
.archd-busybar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 0 14px 8px; padding: 7px 10px; border-radius: 8px;
  background: var(--tint); border: 1px solid var(--border);
  font-size: 11.5px; line-height: 1.6; color: var(--ink);
}
.archd-busybar b { color: var(--accent); }
.archd-busybar-note { font-size: 11px; color: var(--muted); }
.archd-busybar-dot {
  flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--accent);
  animation: archd-pulse 1.1s ease-in-out infinite;
}
/* ⚠ 动画挂在**小圆点**上，不挂按钮本体（check-button-styles ④ 守着这条） */
@keyframes archd-pulse { 0%, 100% { opacity: .25 } 50% { opacity: 1 } }
.archd-closewarn {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 0 14px 8px; padding: 7px 10px; border-radius: 8px;
  background: #fbf1f0; border: 1px solid #efd9d6; color: #8a4343;
  font-size: 11.5px; line-height: 1.6;
}
.archd-closewarn b { color: #b03a2e; }
.archd-closewarn .ghost, .archd-closewarn .danger { flex: none; font-size: 11.5px; height: 26px; padding: 0 10px; }

@media (max-width: 960px) {
  .archd-body { grid-template-columns: 1fr; }
  .archd-side { max-height: 260px; }
  .archd-reject-in { width: 100%; }
}
.archd-last { font-size: 10.5px; color: var(--muted); margin-right: 6px; }
.archd-last.bad { color: var(--warning); }
.archd-cancel { font-weight: 600; }
</style>
