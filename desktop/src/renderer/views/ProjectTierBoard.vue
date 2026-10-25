<!--
  项目梯度榜（Tier List）—— 2026-10-25 暮雨

  两轮口径合并后才是它现在的样子：
    ① 「单独搞个可选启用的项目优先级视图就可以了，并没有改其他任何现成功能的理由，
        就一个手动排序小玩具。」
    ② 「放进项目页签里面就好。这玩意纯属小玩具，没必要提到那么高级。
        而且当前形态为列表，和我丢的参考图里的**梯度榜**完全不同。」
  → 所以：不占顶级页签（是项目页的第 5 种摆法），形状是「分档 + 拖进拖出」，不是一维名次。

  **边界（写死在 services/projectTiers.ts 顶部，另有测试守着）**
  只服务这一页：不参与看板分组、不影响一屏行序、不动 registry。
-->
<template>
  <div class="tierboard">
    <div class="tier-head">
      <span class="tier-ttl">项目梯度榜</span>
      <span class="tier-sub">把项目胶囊拖进不同档位即改档 —— 松手就保存，没有保存按钮</span>
      <span class="tier-grow"></span>
      <span class="tier-count">{{ assignedCount }} / {{ projects.length }} 已分档</span>
      <button class="ghost tier-btn" :disabled="busy" @click="load">{{ busy ? '读取中…' : '⟳ 刷新' }}</button>
      <button class="ghost tier-btn" @click="addTier">＋ 加一档</button>
    </div>

    <div v-if="error" class="skills-error">{{ error }}</div>
    <div v-if="saveError" class="skills-error">{{ saveError }}</div>

    <div class="tier-rows">
      <div
        v-for="(t, ti) in tiers"
        :key="t.id"
        class="tier-row"
        :class="{ over: overTarget === t.id }"
        @dragover.prevent="onOver(t.id)"
        @dragleave="onLeave(t.id)"
        @drop.prevent="onDrop(t.id)"
      >
        <div class="tier-label" :style="{ background: tierColor(ti) }">
          <input
            v-if="editingId === t.id"
            v-model="editingLabel"
            class="tier-label-input"
            @keyup.enter="commitRename(t)"
            @blur="commitRename(t)"
          />
          <span v-else class="tier-label-txt" title="点一下改名" @click="startRename(t)">{{ t.label }}</span>
          <button class="tier-del" title="删掉这一档（档里的项目回到「未分档」）" @click.stop="removeTier(t)">✕</button>
        </div>
        <div class="tier-items">
          <span
            v-for="pid in t.items"
            :key="pid"
            class="tier-chip"
            :class="{ orphan: !projName(pid) }"
            :data-pid="pid"
            draggable="true"
            :title="projName(pid) || (pid + '（已不在登记表，可拖走或删掉这档）')"
            @dragstart="onChipStart($event, pid)"
          >{{ projName(pid) || pid }}</span>
          <span v-if="!t.items.length" class="tier-empty">拖项目到这一档</span>
        </div>
      </div>
    </div>

    <!-- 未分档：新登记的项目先落这儿，拖进档位才算排过 -->
    <div
      class="tier-row tier-pool"
      :class="{ over: overTarget === POOL }"
      @dragover.prevent="onOver(POOL)"
      @dragleave="onLeave(POOL)"
      @drop.prevent="onDrop(POOL)"
    >
      <div class="tier-label tier-label-pool">未分档</div>
      <div class="tier-items">
        <span
          v-for="pid in pool"
          :key="pid"
          class="tier-chip"
          :data-pid="pid"
          draggable="true"
          :title="projName(pid) || pid"
          @dragstart="onChipStart($event, pid)"
        >{{ projName(pid) || pid }}</span>
        <span v-if="!pool.length" class="tier-empty">全部项目都已分档</span>
      </div>
    </div>

    <div class="tier-note">
      这一页只给自己看：<b>不改看板分组、也不改一屏的顺序</b>。档位名可点着改，
      「＋ 加一档」随便加；删档时档里的项目会回到「未分档」，不会消失。
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
// ⚠ 过桥必须给裸对象：`tiers.value` 是 Vue 响应式代理，contextBridge 走结构化克隆会抛
//   「An object could not be cloned」——本项目 09-25 / 10-05 各踩过一次，这里第三次。
import { toPlain } from '../../shared/plain'

interface Tier { id: string; label: string; items: string[] }

const props = defineProps<{
  projects: Array<{ id: string; name?: string }>
  toast?: (msg: string, kind?: string) => void
}>()

const POOL = '__pool__'
/** 档位底色：低饱和，六套主题下配深色文字都能看 */
const TIER_COLORS = ['#e9c7c7', '#f0dcc0', '#efe8bd', '#cfe0cb', '#d6d8e2', '#e2d6e9']

const tiers = ref<Tier[]>([])
const busy = ref(false)
const error = ref('')
const saveError = ref('')

// 拖拽：被拖的项目 id + 当前悬停的目标（档位 id 或 POOL）
const dragPid = ref('')
const overTarget = ref('')

// 改名
const editingId = ref('')
const editingLabel = ref('')

const nameById = computed(() => {
  const m = new Map<string, string>()
  for (const p of props.projects || []) {
    if (p && p.id) m.set(String(p.id), String(p.name || p.id))
  }
  return m
})
function projName(id: string): string {
  return nameById.value.get(String(id)) || ''
}
/** 已分档项目数（不含池里） */
const assignedCount = computed(() => tiers.value.reduce((n, t) => n + t.items.length, 0))
/** 池 = registry 里有、但任何档都没有的项目 */
const pool = computed(() => {
  const inTier = new Set<string>()
  for (const t of tiers.value) for (const id of t.items) inTier.add(id)
  return (props.projects || []).map((p) => String(p.id)).filter((id) => id && !inTier.has(id))
})
function tierColor(i: number): string {
  return TIER_COLORS[i % TIER_COLORS.length]
}

async function load(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const r: any = await (window as any).tegula.projectTiersGet()
    if (r && r.ok === false && r.error) error.value = String(r.error)
    tiers.value = Array.isArray(r?.tiers)
      ? r.tiers.map((t: any) => ({ id: String(t.id), label: String(t.label || t.id), items: (t.items || []).map(String) }))
      : []
  } catch (e: any) {
    error.value = `读取失败：${e?.message || e}`
    tiers.value = []
  } finally {
    busy.value = false
  }
}

/** 落盘。失败就重读磁盘（回到真实状态）并明说 —— 绝不留在"看着改了其实没存住"。 */
async function save(): Promise<boolean> {
  saveError.value = ''
  try {
    const r: any = await (window as any).tegula.projectTiersSet(toPlain(tiers.value))
    if (!r?.ok) throw new Error(r?.error || '未知原因')
    return true
  } catch (e: any) {
    const msg = `没存住：${e?.message || e} —— 已回到磁盘上的样子`
    await load()
    saveError.value = msg
    return false
  }
}

function onChipStart(ev: DragEvent, pid: string): void {
  dragPid.value = String(pid)
  overTarget.value = ''
  try { ev.dataTransfer?.setData('text/plain', String(pid)) } catch { /* 某些环境不认，不影响重排 */ }
}
function onOver(target: string): void {
  if (!dragPid.value) return
  overTarget.value = target
}
function onLeave(target: string): void {
  if (overTarget.value === target) overTarget.value = ''
}

async function onDrop(target: string): Promise<void> {
  const pid = dragPid.value
  dragPid.value = ''
  overTarget.value = ''
  if (!pid) return
  // 先在所有档里摘掉它（一个项目只能在一档）
  const next = tiers.value.map((t) => ({ ...t, items: t.items.filter((x) => x !== pid) }))
  if (target !== POOL) {
    const idx = next.findIndex((t) => t.id === target)
    if (idx < 0) return
    // 拖回原档 = 不变（避免无意义的落盘）
    const before = tiers.value.find((t) => t.id === target)
    if (before && before.items[0] === pid && before.items.length === 1) return
    next[idx].items = [...next[idx].items, pid]
  }
  const prev = tiers.value
  tiers.value = next
  const ok = await save()
  if (!ok) tiers.value = prev
  else props.toast?.(target === POOL ? '已移到「未分档」' : '已改档', 'success')
}

function addTier(): void {
  const id = 'tier-' + Date.now()
  tiers.value = [...tiers.value, { id, label: '新档位', items: [] }]
  void save()
}

function removeTier(t: Tier): void {
  if (!confirm(`删掉「${t.label}」这一档？\n\n档里的 ${t.items.length} 个项目会回到下面「未分档」，不会被删掉。`)) return
  tiers.value = tiers.value.filter((x) => x.id !== t.id)
  void save()
}

function startRename(t: Tier): void {
  editingId.value = t.id
  editingLabel.value = t.label
}
function commitRename(t: Tier): void {
  if (editingId.value !== t.id) return
  const label = String(editingLabel.value || '').trim()
  editingId.value = ''
  if (!label || label === t.label) return
  tiers.value = tiers.value.map((x) => (x.id === t.id ? { ...x, label } : x))
  void save()
}

onMounted(() => { void load() })
</script>
