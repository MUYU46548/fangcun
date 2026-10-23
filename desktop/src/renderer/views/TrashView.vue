<!--
  回收站（2026-10-23 拆成组件 · 拆分计划第 1 批第 8 块）

  这一块**不是一块视图，是一个完整功能**：视图 64 行 + 两个弹窗（按日期清理 / 正文预览）
  + 240 行脚本（列表 / 搜索 / 还原 / 彻底删除 / 多选批量 / 预览读正文）。

  ⚠ 上次我按"视图模板行数"估它是低耦合，估错了；这次按真实总量整块搬。

  一个 prop：`toast`。它没有别的外部依赖 ——
  `confirm` 是原生、`renderBody` 从 `renderer/markdown.ts` 取（与任务详情同源）、
  时间与状态映射从 `shared/` 取。

  ⚠ 删除语义写在最前面，别改：
  一律按**文件名**操作（同一 id 可能有 `x.md` / `x.2.md` 多份历史副本）；
  还原时同名冲突交主进程 moveIntoDir（内容相同去重、不同则新的占规范名、旧的改名保留），
  绝不覆盖、绝不删除。
-->
<template>
    <main id="board" class="trash-view">
      <div class="trash-header">
        <h3>回收站</h3>
        <span class="trash-stats">{{ trashItems.length }} 项 · {{ trashTotalKb }} KB · 新的在最前</span>
        <input v-model="trashQuery" class="trash-search" placeholder="搜 id / 标题 / 文件名…" />
        <button class="trash-refresh" @click="loadTrash()" title="重新读取 task-data/.trash">刷新</button>
        <button class="ghost" title="按日期批量清理：彻底删除某个日期之前进回收站的所有条目（先预览再确认）"
          @click="openTrashPurge">🗓 按日期清理</button>
        <button class="ghost batch-mode-btn" :class="{ active: trashBatchMode }" @click="toggleTrashBatchMode"
          title="开启批量选择，点击条目即勾选/取消">
          <span v-if="!trashBatchMode">☑ 多选</span>
          <span v-else>☑ <i style="color:#fff">{{ selectedTrashBatch.length || 0 }}</i></span>
        </button>
      </div>
      <div v-if="trashBatchMode" class="batch-bar">
        <span class="batch-count">已选 {{ selectedTrashBatch.length }}</span>
        <button class="ghost" @click="toggleSelectAllTrash">{{ selectedTrashBatch.length === filteredTrash.length ? '取消全选' : '全选' }}</button>
        <button class="ghost" title="批量还原：终态回归档区，其余回活跃区；同名冲突不覆盖" @click="executeBatchTrashRestore">批量还原</button>
        <button class="danger" title="批量从磁盘彻底删除（会二次确认，不可撤销）" @click="executeBatchTrashPurge">彻底删除</button>
        <button class="ghost" title="退出多选模式并清空选择" @click="exitTrashBatch">取消</button>
      </div>
      <div class="trash-notebar">
        删掉的任务先来这儿 —— 数据没丢，可以还原；「彻底删除」才真的从磁盘删掉，不可撤销。
        <b>点卡片任意位置能看正文</b>，看完再决定删还是留。
      </div>

      <div v-if="trashLoading" class="empty-state"><div class="empty-text">读取中…</div></div>
      <div v-else-if="!trashItems.length" class="empty-state">
        <div class="empty-icon">🗑</div>
        <div class="empty-text">回收站是空的 — 没有已删除的任务</div>
      </div>
      <div v-else-if="!filteredTrash.length" class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-text">没有匹配「{{ trashQuery }}」的条目</div>
        <button class="trash-btn" @click="trashQuery = ''">清空搜索</button>
      </div>
      <div v-else class="trash-list" :class="{ batching: trashBatchMode }">
        <div v-for="it in filteredTrash" :key="it.name" class="trash-item"
          :class="{ selected: trashBatchMode && selectedTrashBatch.includes(it.name) }"
          @click="onTrashItemClick(it, $event)">
          <!-- 2026-09-30 用户第 5 条（卡 task-20260930-005）：显式勾选框 —— 此前选中只有
               边框/底色变化，且 hover 会盖掉它，用户「看不清到底是否选中」。 -->
          <span v-if="trashBatchMode" class="trash-batch-chk"
            :class="{ on: selectedTrashBatch.includes(it.name) }">✓</span>
          <div class="trash-main"
            :title="trashBatchMode ? '点击勾选/取消勾选' : '点击看正文（只读预览）'">
            <div class="trash-line1">
              <span class="trash-id">{{ it.id }}</span>
              <span class="trash-title">{{ it.title || '(无标题)' }}</span>
              <span v-if="it.status" class="st small" :class="'st-' + statusClass(it.status)">{{ it.status }}</span>
              <span v-if="it.project" class="trash-proj">{{ it.project }}</span>
            </div>
            <div class="trash-line2">
              <span class="trash-name" :title="it.name">{{ it.name }}</span>
              <span class="trash-meta">· {{ it.bytes || 0 }} B · 删于 {{ it.mtime ? relativeTime(it.mtime) : '—' }}</span>
            </div>
          </div>
          <div class="trash-actions" v-show="!trashBatchMode">
            <button class="trash-btn" @click="restoreTrashItem(it)" title="还原：终态回「归档」，其余回活跃区；同名冲突不覆盖，旧版改名保留">↩ 还原</button>
            <button class="trash-btn danger" @click="purgeTrashItem(it)" title="从磁盘彻底删除这一份，不可撤销">🗑 彻底删除</button>
          </div>
        </div>
      </div>
    </main>

    <div id="trash-purge-overlay" class="overlay" v-if="trashPurgeOpen" @mousedown.self="closeTrashPurge()">
      <div id="trash-purge-modal">
        <h3>按日期清理回收站</h3>
        <div class="hint">
          彻底删除<b>进回收站时间早于</b>下面所选日期的条目。这里删的是回收站里的文件本身，
          <b>删了就找不回来</b> —— 所以先「预览命中」看清是哪些，再确认。
        </div>
        <div class="lpurge-row">
          <label>早于</label>
          <input v-model="trashPurgeDate" type="date" class="log-filter" @change="resetTrashPurgePreview" />
          <button class="ghost" @click="setTrashCutoff(7)">7 天前</button>
          <button class="ghost" @click="setTrashCutoff(30)">30 天前</button>
          <button class="ghost" @click="setTrashCutoff(90)">90 天前</button>
        </div>
        <div class="lpurge-actions">
          <button class="ghost" :disabled="trashPurgeBusy" @click="runTrashPurgePreview">预览命中</button>
          <button class="danger" :disabled="trashPurgeBusy || !trashPurgePreview || !trashPurgePreview.count"
            @click="executeTrashPurge">确认彻底删除</button>
          <button class="ghost" @click="closeTrashPurge">取消</button>
        </div>
        <div v-if="trashPurgePreview" class="lpurge-preview">
          <div><b>将彻底删除 {{ trashPurgePreview.count }} 项</b></div>
          <ul v-if="trashPurgePreview.count" class="lpurge-list">
            <li v-for="(t, i) in trashPurgePreview.titles.slice(0, 8)" :key="i">{{ t }}</li>
            <li v-if="trashPurgePreview.count > 8" class="lpurge-more">…等共 {{ trashPurgePreview.count }} 项</li>
          </ul>
          <div v-else>没有早于该日期的条目，无需清理。</div>
        </div>
      </div>
    </div>

    <div id="trash-preview-overlay" class="overlay" v-if="trashPreview" @mousedown.self="trashPreview = null">
      <div id="trash-preview-modal">
        <h3>
          {{ trashPreview.item.title || trashPreview.item.id }}
          <span class="st" :class="'st-' + statusClass(trashPreview.item.status)">{{ trashPreview.item.status || '—' }}</span>
        </h3>
        <div class="meta">
          <div><span class="k">文件名</span><span class="v">{{ trashPreview.item.name }}</span></div>
          <div><span class="k">ID</span><span class="v">{{ trashPreview.item.id }}</span></div>
          <div><span class="k">项目</span><span class="v">{{ trashPreview.item.project || '—' }}</span></div>
          <div><span class="k">大小</span><span class="v">{{ trashPreview.item.bytes || 0 }} B</span></div>
          <div><span class="k">删于</span><span class="v">{{ trashPreview.item.mtime ? relativeTime(trashPreview.item.mtime) : '—' }}</span></div>
        </div>
        <div v-if="trashPreview.loading" class="hint">读取中…</div>
        <div v-else-if="trashPreview.error" class="skills-error">{{ trashPreview.error }}</div>
        <div v-else class="trash-preview-body">
          <div v-if="trashPreview.truncated" class="hint">文件很大，只显示前 512 KB</div>
          <div class="trash-preview-text markdown" v-html="renderBody(trashPreview.text)"></div>
        </div>
        <div class="trash-preview-actions">
          <button class="trash-btn" @click="restoreFromPreview()">↩ 还原这一份</button>
          <button class="trash-btn danger" @click="purgeFromPreview()">🗑 彻底删除（不可撤销）</button>
          <button class="trash-btn" @click="trashPreview = null">关闭</button>
        </div>
      </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { relativeTime } from '../../shared/time'
import { statusClass } from '../../shared/status'
import { renderBody } from '../markdown'

const props = defineProps<{ toast: (msg: string, type?: 'success' | 'error' | 'info') => void }>()

// 多选状态（2026-09-30 用户补充：回收站也要多选，是常用场景）
const trashBatchMode = ref(false)
const selectedTrashBatch = ref<string[]>([])

// ── 回收站（2026-09-26 卡 034）──────────────────────────────────────────
// 现象：`.trash/` 里有几十个文件、数据完好，但界面没有任何入口，用户以为"东西没了"。
// 语义：一律按**文件名**操作（回收站里同一 id 可能有多份历史副本：`x.md` 与 `x.2.md`），
//       还原时的同名冲突交给主进程的 moveIntoDir（内容相同去重、不同则新的占规范名、
//       旧的改名保留）→ 绝不覆盖、绝不删除。
interface TrashItem {
  name: string
  id: string
  title?: string
  status?: string
  project?: string
  bytes?: number
  mtime?: string
}

const trashItems = ref<TrashItem[]>([])
const trashLoading = ref(false)
const trashQuery = ref('')

/** 回收站条目总占用（KB）—— 几十项时一眼知道"这些垃圾有多大" */
const trashTotalKb = computed(() =>
  Math.round(trashItems.value.reduce((s, x) => s + (x.bytes || 0), 0) / 1024))

/** 回收站内搜索：id / 标题 / 文件名 三个字段都认 */
const filteredTrash = computed(() => {
  const q = trashQuery.value.trim().toLowerCase()
  if (!q) return trashItems.value
  return trashItems.value.filter(x =>
    String(x.id || '').toLowerCase().includes(q) ||
    String(x.title || '').toLowerCase().includes(q) ||
    String(x.name || '').toLowerCase().includes(q))
})

async function loadTrash(): Promise<void> {
  trashLoading.value = true
  try {
    const r = await window.tegula.trashList()
    trashItems.value = (r && r.items) || []
  } catch {
    trashItems.value = []
  } finally {
    trashLoading.value = false
  }
}

async function restoreTrashItem(it: TrashItem): Promise<void> {
  const r = await window.tegula.trashRestore(it.name)
  if (r && r.ok) {
    props.toast(`已还原 ${it.id}${r.archived ? '（回归档区）' : ''}`, 'success')
    await loadTrash()
    // 还原会改任务列表，但**这里不能刷任务**：回收站视图的顶栏计数刻意显示「—」
    // （见 countText 注释），在这儿 loadAll 会把它变成任务条数，自相矛盾。
    // 切回看板时 loadViewData 自己会拉 —— 原来那句 `if (curView !== 'trash')` 于是恒为真，
    // 搬进组件后连判断都不需要了。
  } else {
    props.toast(`还原失败：${(r && r.error) || '未知原因'}`, 'error')
  }
}

async function purgeTrashItem(it: TrashItem): Promise<void> {
  if (!confirm(`彻底删除「${it.title || it.id}」？\n\n文件：${it.name}\n这是从磁盘删除，不可撤销。`)) return
  const r = await window.tegula.trashPurge(it.name)
  if (r && r.ok) {
    props.toast(`已彻底删除 ${it.name}`, 'success')
    await loadTrash()
  } else {
    props.toast(`删除失败：${(r && r.error) || '未知原因'}`, 'error')
  }
}

// ── 按日期清理回收站（2026-10-17 暮雨第 2 条：「删除此之前的所有内容」）──────
// 与「清理已归档日志」同构：先预览、再确认。差别只有一个 —— 那边是软删（移进日志回收站），
// 这边删的是回收站里的文件本身，**不可撤销**，所以文案必须说满。
const trashPurgeOpen = ref(false)
const trashPurgeDate = ref('')
const trashPurgeBusy = ref(false)
const trashPurgePreview = ref<{ count: number; names: string[]; titles: string[] } | null>(null)

/** 本地日历日 → YYYY-MM-DD。⚠ 不能用 toISOString().slice(0,10)：那是 UTC，
    东八区晚上 8 点后会退回前一天，用户选"今天"实际删的是"昨天之前"。 */
function ymdLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function setTrashCutoff(days: number): void {
  const d = new Date()
  d.setDate(d.getDate() - days)
  trashPurgeDate.value = ymdLocal(d)
  resetTrashPurgePreview()
}

function openTrashPurge(): void {
  setTrashCutoff(30)
  trashPurgeOpen.value = true
}
function closeTrashPurge(): void { trashPurgeOpen.value = false }
function resetTrashPurgePreview(): void { trashPurgePreview.value = null }

/** 预览：命中 = 进回收站时间**早于**所选日期零点。先看清再删，不允许盲删。 */
function runTrashPurgePreview(): void {
  const cutoff = new Date(`${trashPurgeDate.value}T00:00:00`).getTime()
  if (!trashPurgeDate.value || !isFinite(cutoff)) {
    props.toast('先选一个日期', 'error')
    return
  }
  const hits = trashItems.value.filter(it => {
    const t = Date.parse(it.mtime || '')
    return isFinite(t) && t < cutoff
  })
  trashPurgePreview.value = {
    count: hits.length,
    names: hits.map(h => h.name),
    titles: hits.map(h => `${h.title || '(无标题)'} · ${h.id}${h.mtime ? ' · ' + h.mtime.slice(0, 10) : ''}`),
  }
}

async function executeTrashPurge(): Promise<void> {
  const p = trashPurgePreview.value
  if (!p || !p.count || trashPurgeBusy.value) return
  trashPurgeBusy.value = true
  let ok = 0
  try {
    for (const name of p.names) {
      try {
        const r: any = await window.tegula.trashPurge(name)
        if (r?.ok) ok++
      } catch { /* 单条失败不打断整批，最后按成功数报 */ }
    }
  } finally {
    trashPurgeBusy.value = false
  }
  props.toast(ok === p.count ? `已彻底删除 ${ok} 项` : `已删除 ${ok}/${p.count} 项，其余失败`, ok === p.count ? 'success' : 'error')
  trashPurgePreview.value = null
  trashPurgeOpen.value = false
  await loadTrash()
}

// ── 回收站多选（2026-09-30 用户补充：「待办和回收站也加入多选，这些也是常用场景」）──
// 交互与看板/日志/待办同一套：工具条开关 → 点条目勾选 → 悬浮批量栏执行。
// 选中键用 it.name（同 id 可能有同名副本，name = trash 里的文件名，唯一）。
function toggleTrashBatchMode() {
  trashBatchMode.value = !trashBatchMode.value
  if (!trashBatchMode.value) selectedTrashBatch.value = []
  else props.toast('批量模式：点击条目勾选，再从下方批量栏执行', 'success')
}
function toggleTrashBatchSelect(name: string) {
  const idx = selectedTrashBatch.value.indexOf(name)
  if (idx >= 0) selectedTrashBatch.value.splice(idx, 1)
  else selectedTrashBatch.value.push(name)
}
/**
 * 回收站条目点击（2026-09-30 用户第 5 条，卡 task-20260930-005）。
 * 热区从 .trash-main 扩到**整行** —— 行内 padding / 两行之间的空隙原来都是死区，
 * 点了没反应，用户只能「点好几次」碰运气。动作按钮（还原/删除）的点击不参与选择。
 */
function onTrashItemClick(it: TrashItem, e: MouseEvent): void {
  const t = e.target as HTMLElement | null
  if (t && t.closest && t.closest('.trash-actions')) return
  if (trashBatchMode.value) toggleTrashBatchSelect(it.name)
  else openTrashPreview(it)
}
function toggleSelectAllTrash() {
  if (selectedTrashBatch.value.length === filteredTrash.value.length) selectedTrashBatch.value = []
  else selectedTrashBatch.value = filteredTrash.value.map((t: any) => t.name)
}
function exitTrashBatch() {
  selectedTrashBatch.value = []
  trashBatchMode.value = false
}
async function executeBatchTrashRestore() {
  const names = [...selectedTrashBatch.value]
  if (!names.length) return
  let ok = 0
  for (const name of names) {
    try {
      const r: any = await window.tegula.trashRestore(name)
      if (r?.ok) ok++
    } catch { /* skip */ }
  }
  props.toast(`已还原 ${ok}/${names.length} 项`, ok ? 'success' : 'error')
  exitTrashBatch()
  await loadTrash()
  // 回收站还原会改任务列表；与单条还原一致，只在非回收站视图才刷（此刻就在回收站，不用）
}
async function executeBatchTrashPurge() {
  const names = [...selectedTrashBatch.value]
  if (!names.length) return
  if (!confirm(`彻底删除选中的 ${names.length} 项？\n\n将从磁盘删除这些文件，不可撤销：\n` +
    names.slice(0, 10).map(n => `· ${n}`).join('\n') + (names.length > 10 ? `\n…等 ${names.length} 个` : ''))) return
  let ok = 0
  for (const name of names) {
    try {
      const r: any = await window.tegula.trashPurge(name)
      if (r?.ok) ok++
    } catch { /* skip */ }
  }
  props.toast(`已彻底删除 ${ok}/${names.length} 项`, ok ? 'success' : 'error')
  exitTrashBatch()
  await loadTrash()
}

/**
 * 回收站卡片预览（2026-09-26 用户回执：「每个卡片都是不能点的死卡，确认这是设计意图？我可没想要这个」）
 *
 * 之前只有「还原 / 彻底删除」两个按钮 —— 卡片本体点了没反应，想删又怕删错，只能凭标题猜。
 * 现在点卡片任意位置读该文件的**源码正文**（只读），看完再决定；浮层里也给同一对动作。
 * 关闭时机有讲究：动作成功且这一份**真的从列表里消失了**才关，没删掉就把浮层留着（别骗用户）。
 */
interface TrashPreviewState {
  item: TrashItem
  text: string
  truncated: boolean
  loading: boolean
  error: string
}
const trashPreview = ref<TrashPreviewState | null>(null)

async function openTrashPreview(it: TrashItem): Promise<void> {
  trashPreview.value = { item: it, text: '', truncated: false, loading: true, error: '' }
  const t: any = window.tegula
  if (typeof t.trashRead !== 'function') {
    trashPreview.value = { item: it, text: '', truncated: false, loading: false, error: '当前主进程/预加载是旧版本，没有预览通道 —— 托盘右键「退出」后重开' }
    return
  }
  try {
    const r: any = await t.trashRead(it.name)
    if (!trashPreview.value || trashPreview.value.item.name !== it.name) return
    trashPreview.value = r && r.ok
      ? { item: it, text: String(r.text || ''), truncated: !!r.truncated, loading: false, error: '' }
      : { item: it, text: '', truncated: false, loading: false, error: `读不出来：${(r && r.error) || '未知原因'}` }
  } catch (e: any) {
    trashPreview.value = { item: it, text: '', truncated: false, loading: false, error: `读不出来：${e?.message || e}` }
  }
}

async function restoreFromPreview(): Promise<void> {
  const st = trashPreview.value
  if (!st) return
  await restoreTrashItem(st.item)
  if (!trashItems.value.some(x => x.name === st.item.name)) trashPreview.value = null
}

async function purgeFromPreview(): Promise<void> {
  const st = trashPreview.value
  if (!st) return
  await purgeTrashItem(st.item)
  if (!trashItems.value.some(x => x.name === st.item.name)) trashPreview.value = null
}

// 进页面就拉（空页＝说假话）；App.vue 的 loadViewData('trash') 已显式空掉
onMounted(() => { void loadTrash() })
</script>
