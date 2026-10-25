<!--
  项目优先级视图（2026-10-25 暮雨）

  原话：「拖拽排序不该和其他视图放在一起用，单独搞个可选启用的项目优先级视图就可以了，
  并没有改其他任何现成功能的理由，就一个手动排序小玩具。」

  **边界（这条最重要，别顺手扩）**
  - 只服务这一页。看板分组顺序、一屏行序、registry 一律**不动**。
  - 只是一条有序 id 列表：没有权重分、没有公式、不会自动排。
  - 可选启用：设置里打开「优先级页签」它才出现在顶栏（默认关 —— 顶栏已经 15 个页签了）。

  **为什么拖完立即保存**：这是一份"我现在的取舍"快照，不是待提交的表单。
  多一步"保存"按钮只会让人拖完忘了点，然后以为存住了 —— 那正是本项目最忌讳的假成功。
  保存失败则**回滚**到拖之前的顺序并明说，绝不停在一个"看着改了其实没落盘"的状态。
-->
<template>
  <main id="board" class="priority-view">
    <div class="pri-head">
      <h3>项目优先级</h3>
      <span class="pri-count">{{ rows.length }} 个项目</span>
      <span class="pri-f1"></span>
      <button class="skills-btn" :disabled="busy" @click="load">{{ busy ? '读取中…' : '刷新' }}</button>
    </div>
    <div class="pri-note">
      拖动行改顺序，<b>松手即保存</b>。这一页只给自己看 —— <b>不影响看板分组，也不影响一屏的顺序</b>。
      没排过的项目排在末尾（按登记顺序），新登记的项目也一样，不会丢。
    </div>

    <div v-if="error" class="skills-error">{{ error }}</div>
    <div v-if="saveError" class="skills-error">{{ saveError }}</div>

    <div v-if="rows.length" class="pri-list">
      <div
        v-for="(p, i) in rows"
        :key="p.id"
        class="pri-row"
        :class="{ dragging: dragIdx === i, over: overIdx === i && dragIdx !== i }"
        :data-proj="p.id"
        draggable="true"
        :title="p.tip"
        @dragstart="onStart($event, i)"
        @dragover.prevent="onOver(i)"
        @dragleave="onLeave(i)"
        @drop.prevent="onDrop(i)"
        @dragend="onEnd"
      >
        <span class="pri-rank">{{ i + 1 }}</span>
        <span class="pri-handle" aria-hidden="true">⠿</span>
        <span class="pri-name">{{ p.name }}</span>
        <span v-if="p.stateShort" class="pri-state" :title="p.stateRaw">{{ p.stateShort }}</span>
        <span class="pri-id">{{ p.id }}</span>
      </div>
    </div>
    <div v-else class="empty-state"><div class="empty-text">还没有登记任何项目</div></div>
  </main>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Row {
  id: string
  name: string
  stateRaw: string
  stateShort: string
  tip: string
}

const rows = ref<Row[]>([])
const busy = ref(false)
const error = ref('')
const saveError = ref('')

// 拖拽状态：dragIdx = 被拖的行，overIdx = 当前悬停的目标行
const dragIdx = ref(-1)
const overIdx = ref(-1)

function toRow(p: any): Row {
  const id = String(p?.id || '')
  const name = String(p?.name || p?.id || '')
  // registry 的状态字段是中文键（`状态`），历史数据里也可能叫 status —— 两个都认
  const stateRaw = String(p?.['状态'] ?? p?.status ?? '').trim()
  const stateShort = stateRaw.length > 26 ? stateRaw.slice(0, 26) + '…' : stateRaw
  return { id, name, stateRaw, stateShort, tip: stateRaw || name }
}

async function load(): Promise<void> {
  busy.value = true
  error.value = ''
  saveError.value = ''
  try {
    const [projs, ord] = await Promise.all([
      (window as any).tegula.loadProjects(),
      (window as any).tegula.projectOrderGet(),
    ])
    const list: any[] = Array.isArray(projs) ? projs : []
    const byId = new Map<string, Row>()
    for (const p of list) {
      const r = toRow(p)
      if (r.id) byId.set(r.id, r)
    }
    // 读排序失败也要能看：按登记顺序显示，并把原因说出来（不静默）
    if (ord && ord.ok === false && ord.error) error.value = String(ord.error)
    const order: string[] = Array.isArray(ord?.order) ? ord!.order : []
    const seen = new Set<string>()
    const out: Row[] = []
    // ① 排过序的，按 order 走；order 里已不存在的 id 直接忽略（不崩、不显示幽灵行）
    for (const id of order) {
      const r = byId.get(id)
      if (r && !seen.has(id)) { out.push(r); seen.add(id) }
    }
    // ② 没排过的（含新登记的项目）追加在末尾，保持登记顺序
    for (const p of list) {
      const r = toRow(p)
      if (r.id && !seen.has(r.id)) { out.push(r); seen.add(r.id) }
    }
    rows.value = out
  } catch (e: any) {
    error.value = `读取失败：${e?.message || e}`
    rows.value = []
  } finally {
    busy.value = false
  }
}

function onStart(ev: DragEvent, i: number): void {
  dragIdx.value = i
  overIdx.value = i
  try {
    // Firefox/Chromium 都要 setData 才认这个拖拽
    ev.dataTransfer?.setData('text/plain', rows.value[i]?.id || '')
  } catch { /* 某些环境不可用，不影响重排 */ }
}

function onOver(i: number): void {
  if (dragIdx.value < 0) return
  overIdx.value = i
}

function onLeave(i: number): void {
  if (overIdx.value === i) overIdx.value = -1
}

function onEnd(): void {
  dragIdx.value = -1
  overIdx.value = -1
}

async function onDrop(target: number): Promise<void> {
  const from = dragIdx.value
  onEnd()
  if (from < 0 || target < 0 || from === target) return
  const next = [...rows.value]
  const [moved] = next.splice(from, 1)
  next.splice(target, 0, moved)
  rows.value = next
  // 拖完立即落盘；失败就重读磁盘（回到真实顺序），并明说没存住
  saveError.value = ''
  try {
    const r: any = await (window as any).tegula.projectOrderSet(next.map((x) => x.id))
    if (!r?.ok) throw new Error(r?.error || '未知原因')
  } catch (e: any) {
    const msg = `顺序没存住：${e?.message || e} —— 已回到磁盘上的顺序`
    await load()
    saveError.value = msg
  }
}

onMounted(() => { void load() })
</script>
