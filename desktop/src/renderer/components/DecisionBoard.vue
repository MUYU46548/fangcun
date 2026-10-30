<script setup lang="ts">
/**
 * 决策视图（shadcn-vue 口径落地版）
 * 卡 task-20261011-004 第 ④ 步第一单 · 2026-10-14（小样：docs/小样-决策视图改版-20261014/）
 *
 * 为什么单独成组件、不再写在 App.vue 里：
 *   ① `tailwind.config.js` 的 `content` **绝不能扫 App.vue** —— 它里面有 `.fixed`/`.hidden`/
 *      `.block` 这类与 Tailwind 工具类**同名**的老类名，一扫就凭空生成规则、全仓观感漂移
 *      （第 ① 步「产物 CSS 逐字节不变」就是被这个坑破的）。视图按组件边界切出去，
 *      新代码用 utilities、老代码一行不动。
 *   ② App.vue 是 14000 行单文件；视图边界清楚，将来才好逐个换手搓控件。
 *
 * 数据真身仍在主进程（`main/data/decisions.ts`，与 Python CLI 双腿同文件 decisions.md），
 * 这里只经 IPC 读写。三态（有效/已撤销/已合并）不挂任务状态机：决策不流转。
 * 三态配色走 `--badge-*-fg/bg` 令牌，由 `check-themes.cjs` 量对比度。
 *
 * ⚠ 测试钩子用 `data-dec="…"` 而不是"没有样式的类名"：类名只该承载样式，
 *   e2e 想找元素就找属性，改名/改样式不会互相绊倒。
 */
import { computed, onMounted, ref } from 'vue'
import { TabsRoot, TabsList, TabsTrigger } from 'reka-ui'
import { parseDecisionLine } from '../../shared/decisionInput'
// 撤销条是全站一个（状态在 renderer/undo.ts）：子组件直接 offer，不用往上一层 emit
import { offerUndo } from '../undo'
import Button from './ui/Button.vue'
import Badge from './ui/Badge.vue'
import Card from './ui/Card.vue'
import Input from './ui/Input.vue'

interface Decision {
  id: string
  内容: string
  日期: string
  状态: string
  项目?: string
  出处?: string
  备注?: string
}

const emit = defineEmits<{ (e: 'notify', msg: string, type: 'success' | 'error' | 'info'): void }>()

/** 筛选项就是三态 + 全部；与主进程 `DECISION_STATUSES` 同一套词（改一处要改两处） */
const FILTERS = ['全部', '有效', '已撤销', '已合并']
/** 「项目筛选」里代表"没填项目"的那一项；数据支持（decisions.md 的项目列），界面补上 */
const NO_PROJECT = '（未归属）'
const ALL_PROJECTS = '全部项目'

const items = ref<Decision[]>([])
const filter = ref('全部')
const projFilter = ref(ALL_PROJECTS)
const smartText = ref('')
const newContent = ref('')
const newDate = ref('')
const newSource = ref('')
const newProject = ref('')
const busy = ref(false)

/* ── 生命周期管理（2026-10-17 暮雨：「决策卡当然需要有生命周期管理」）──────────
   三态本身是"还作不作数"，生命周期管的是**一条决策从记下到失效的整段**：
   ① 找得到（搜索）② 成批动（多选 + 批量改状态/删除）③ 看得见什么时候被动过（更新时刻）。
   刻意不做：状态流转图 / 审批流 / 关联任务 —— 那是项目管理，方寸不是那个东西。 */
/** 搜索：内容 / 出处 / 项目 / 备注，四个字段都认（记不住在哪写的时候就靠它） */
const query = ref('')
/** 多选模式下选中的 id */
const selected = ref<string[]>([])
const selectMode = ref(false)
const batchBusy = ref(false)
/** 批量删除的两段式：第一次点只把按钮换成"确认删除 N 条" */
const batchDeleteConfirm = ref(false)

/** 秒级 Unix 时间戳 → 「10-15 14:32」；解析不出来给空串（不糊一个假时间） */
function relTime(raw: string): string {
  if (!raw) return ''
  const n = Number(raw)
  // 数据里是**秒级**时间戳（addDecision / setDecisionStatus 都是 Math.floor(Date.now()/1000)）
  const d = Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date(raw)
  if (isNaN(d.getTime())) return ''
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function matchesQuery(d: Decision): boolean {
  const q = query.value.trim().toLowerCase()
  if (!q) return true
  return [d.内容, d.出处, d.项目, d.备注, d.id]
    .some((v) => String(v || '').toLowerCase().indexOf(q) >= 0)
}

function toggleSelectMode(): void {
  selectMode.value = !selectMode.value
  if (!selectMode.value) selected.value = []
}

function toggleOne(id: string): void {
  const i = selected.value.indexOf(id)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(id)
}

function toggleAllVisible(): void {
  const ids = filtered.value.map((d) => d.id)
  const allIn = ids.length > 0 && ids.every((id) => selected.value.indexOf(id) >= 0)
  selected.value = allIn ? [] : ids
}

/** 批量改状态：逐条走同一条 `decisionSetStatus`（留痕/日志与单条完全一致，不另开一条捷径） */
async function batchSetStatus(status: string): Promise<void> {
  const ids = [...selected.value]
  if (!ids.length || batchBusy.value) return
  batchBusy.value = true
  let ok = 0
  try {
    for (const id of ids) {
      try {
        const r: any = await window.tegula.decisionSetStatus(id, status)
        if (r?.ok) ok++
      } catch { /* 单条失败不打断整批 */ }
    }
  } finally {
    batchBusy.value = false
  }
  emit('notify', ok === ids.length ? `${ok} 条已设为「${status}」` : `${ok}/${ids.length} 条成功`, ok === ids.length ? 'success' : 'error')
  selected.value = []
  await refresh()
}

/** 批量删除：同样逐条走 `deleteDecision` —— 每条都会先留底，不会因为"批量的"就绕过 */
async function doBatchDelete(): Promise<void> {
  const ids = [...selected.value]
  if (!ids.length || batchBusy.value) return
  batchBusy.value = true
  let ok = 0
  try {
    for (const id of ids) {
      try {
        const r: any = await window.tegula.decisionDelete(id)
        if (r?.ok) ok++
      } catch { /* 同上 */ }
    }
  } finally {
    batchBusy.value = false
  }
  emit('notify', ok === ids.length ? `已删除 ${ok} 条（都留底在 decisions-deleted.md）` : `${ok}/${ids.length} 条成功`, ok === ids.length ? 'success' : 'error')
  selected.value = []
  batchDeleteConfirm.value = false
  await refresh()
}

/** 现有条目里出现过的项目名（给筛选下拉与录入时的 datalist 用；不含"未归属"那一项） */
const knownProjects = computed(() => {
  const set = new Set<string>()
  for (const d of items.value) if (d.项目) set.add(d.项目)
  return [...set].sort()
})
const projOptions = computed(() => {
  const opts = [ALL_PROJECTS, ...knownProjects.value]
  if (items.value.some((d) => !d.项目)) opts.push(NO_PROJECT)
  return opts
})

/** 项目筛 → 状态筛，两级串联（顺序不影响结果，但读取顺序要跟界面一致，好排查） */
const byProject = computed(() => {
  if (projFilter.value === ALL_PROJECTS) return items.value
  if (projFilter.value === NO_PROJECT) return items.value.filter((d) => !d.项目)
  return items.value.filter((d) => d.项目 === projFilter.value)
})
const filtered = computed(() =>
  (filter.value === '全部' ? byProject.value : byProject.value.filter((d) => d.状态 === filter.value))
    .filter(matchesQuery)
)

/** 空态得说清是"哪一层筛空了的" —— 只说"没有决策"会在项目筛空时骗人 */
const emptyHint = computed(() => {
  if (!items.value.length) return '还没有决策记录——定了大事，记一条，防它消失'
  if (!byProject.value.length) return `「${projFilter.value}」下还没有决策`
  if (query.value.trim()) return `没有匹配「${query.value.trim()}」的决策（搜的是内容 / 出处 / 项目 / 备注）`
  return filter.value === '全部' ? '这里没有决策' : `「${projFilter.value}」下没有「${filter.value}」的决策`
})

/** 计数跟着**当前项目筛与搜索词**走 —— 否则页签上的数字加起来对不上列表里的张数（界面说假话） */
function countOf(s: string): number {
  const base = byProject.value.filter(matchesQuery)
  return s === '全部' ? base.length : base.filter((d) => d.状态 === s).length
}

/**
 * 贴一句话自动拆字段（开发清单第 5 条）。
 * 规则在 `shared/decisionInput.ts`（纯函数、有独立断言）；这里只负责**预填**：
 * 拆完不动「记下」——用户还能改。拆不出东西时也得说话，不许静默什么都不发生。
 */
function splitSmart(): void {
  const text = smartText.value.trim()
  if (!text) return
  const r = parseDecisionLine(text, { projects: knownProjects.value })
  newContent.value = r.内容 || text
  if (r.日期) newDate.value = r.日期
  if (r.项目) newProject.value = r.项目
  if (r.出处) newSource.value = r.出处
  emit(
    'notify',
    r.命中.length ? `已拆出：${r.命中.join('、')} —— 检查一下再点「记下」` : '没拆出别的字段，整句留在「内容」里',
    'info'
  )
}

function badgeOf(s: string): 'ok' | 'revoked' | 'merged' | 'neutral' {
  if (s === '有效') return 'ok'
  if (s === '已撤销') return 'revoked'
  if (s === '已合并') return 'merged'
  return 'neutral'
}

async function refresh() {
  try {
    const r: any = await window.tegula.decisionList()
    if (r?.ok) items.value = r.items || []
  } catch (e: any) {
    emit('notify', `读取决策记录失败：${e?.message || e}`, 'error')
  }
}

async function add() {
  const content = newContent.value.trim()
  if (!content || busy.value) return
  busy.value = true
  try {
    const r: any = await window.tegula.decisionAdd({
      内容: content,
      日期: newDate.value || new Date().toISOString().slice(0, 10),
      出处: newSource.value.trim(),
      项目: newProject.value.trim(),
    })
    if (r?.ok) {
      emit('notify', `已记 ${r.id}`, 'success')
      newContent.value = ''
      newSource.value = ''
      newProject.value = ''
      smartText.value = ''
      await refresh()
    } else {
      emit('notify', r?.error || '记失败', 'error')
    }
  } catch (e: any) {
    emit('notify', `记录异常：${e?.message || e}`, 'error')
  } finally {
    busy.value = false
  }
}

/** 从 `<select>` 的 change 事件取状态值：断言归脚本，模板不写 `as` */
function setStatusFromEvent(d: Decision, ev: Event): void {
  const el = ev.target as HTMLSelectElement | null
  void setStatus(d, el ? el.value : '')
}

async function setStatus(d: Decision, status: string) {
  if (busy.value || !status) return
  busy.value = true
  try {
    // ⚠ 字段名是中文 `状态`（见 interface Decision）—— 写成 d.status 会拿到 undefined，
    //   撤销条显示「原：未填」、撤回时把状态置空（2026-10-21 实测踩到并被断言抓到）
    const prev = d.状态
    const r: any = await window.tegula.decisionSetStatus(d.id, status)
    if (r?.ok) {
      emit('notify', r.message || `${d.id} → ${status}`, 'info')
      // 三态下拉选错是常见误操作（尤其"已撤销"和"已合并"挨着）→ 当场给撤销（2026-10-21 · 1B 修正版）。
      // ⚠ 撤的是"改回原状态"，不是"删掉这条决策"——两件事别混。
      offerUndo(`${d.id} → ${status}（原：${prev || '未填'}）`, async () => {
        const back: any = await window.tegula.decisionSetStatus(d.id, prev)
        if (!back || back.ok === false) throw new Error(back?.error || '这条决策已被改动，改不回去了')
        await refresh()
      })
    } else emit('notify', r?.error || '改状态失败', 'error')
    await refresh() // 成功刷新；失败也刷新（把下拉回滚成服务端的真值）
  } catch (e: any) {
    emit('notify', `改状态异常：${e?.message || e}`, 'error')
    await refresh()
  } finally {
    busy.value = false
  }
}

/* ── 编辑 / 删除（2026-10-17 暮雨第 5 条）──────────────────────────────
   原状态：决策只能"新增一条"和"改三态"。写错一个字 → 只能撤销再重记，
   记错一条 → 永远留在库里。这就是他说的「失控感」。
   做法：编辑**就地展开**（不弹新窗：弹窗一多，改一句话要跨三层），
   删除走**两段式**（第一次点变成「确认 / 取消」，第二次才真删）——
   与全仓其它破坏性动作同一套交互，且删前主进程会先留底。 */
const editingId = ref('')
const pendingDeleteId = ref('')
const draft = ref({ 内容: '', 日期: '', 项目: '', 出处: '', 备注: '' })

function startEdit(d: Decision): void {
  pendingDeleteId.value = ''
  editingId.value = d.id
  draft.value = {
    内容: d.内容 || '',
    日期: d.日期 || '',
    项目: d.项目 || '',
    出处: d.出处 || '',
    备注: d.备注 || '',
  }
}

function cancelEdit(): void {
  editingId.value = ''
}

async function saveEdit(): Promise<void> {
  if (!editingId.value || busy.value) return
  if (!draft.value.内容.trim()) {
    emit('notify', '内容不能为空', 'error')
    return
  }
  busy.value = true
  try {
    const r: any = await window.tegula.decisionUpdate(editingId.value, { ...draft.value })
    if (r?.ok) {
      emit('notify', r.message || '已更新', 'success')
      editingId.value = ''
      await refresh()
    } else {
      emit('notify', r?.error || '保存失败', 'error')
    }
  } catch (e: any) {
    emit('notify', `保存异常：${e?.message || e}`, 'error')
  } finally {
    busy.value = false
  }
}

function askDelete(d: Decision): void {
  editingId.value = ''
  pendingDeleteId.value = d.id
}

async function confirmDelete(d: Decision): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const r: any = await window.tegula.decisionDelete(d.id)
    if (r?.ok) {
      emit('notify', r.message || `已删除 ${d.id}`, 'success')
      pendingDeleteId.value = ''
      await refresh()
    } else {
      emit('notify', r?.error || '删除失败', 'error')
    }
  } catch (e: any) {
    emit('notify', `删除异常：${e?.message || e}`, 'error')
  } finally {
    busy.value = false
  }
}

// 进门即加载 —— 与 `loadViewData` 同一条纪律（状态字段懒加载 = 界面说假话）。
// 视图是 v-if 挂载：离开再回来会重新挂载，所以这里 onMounted 就等价于"每次进门拉一次"。
onMounted(refresh)
</script>

<template>
  <div class="flex flex-col gap-3.5">
    <!-- 页头：标题 + 状态筛选（reka-ui Tabs 当分段控件用）+ 刷新 -->
    <div class="flex flex-wrap items-center gap-2.5">
      <h3 class="mr-1 text-[16px] font-bold tracking-[0.2px]">决策记录</h3>
      <TabsRoot
        v-model="filter"
        class="inline-flex gap-0.5 rounded-[var(--btn-r)] border border-[var(--ui-border)] bg-[var(--ui-muted)] p-0.5"
      >
        <TabsList class="inline-flex gap-0.5">
          <TabsTrigger
            v-for="s in FILTERS"
            :key="s"
            :value="s"
            data-dec="tab"
            class="inline-flex h-[28px] cursor-pointer appearance-none items-center gap-1 rounded-md border-0 border-solid bg-transparent px-[13px] text-[12.5px] font-medium text-[var(--ui-muted-foreground)] outline-none transition-colors hover:text-[var(--ui-foreground)] data-[state=active]:bg-[var(--ui-card)] data-[state=active]:font-semibold data-[state=active]:text-[var(--ui-foreground)]"
          >
            {{ s }}<span class="text-[11px] font-normal text-[var(--ui-muted-foreground)]">{{ countOf(s) }}</span>
          </TabsTrigger>
        </TabsList>
      </TabsRoot>
      <span class="flex-1"></span>
      <!-- 搜索（生命周期第 ① 条：找得到）。四个字段都认，记不住写在哪时靠它 -->
      <Input
        v-model="query"
        data-dec="search"
        class="w-[190px] flex-none"
        placeholder="搜内容 / 出处 / 项目…"
        title="在内容、出处、项目、备注里搜"
      />
      <!-- 按项目筛选（开发清单第 4 条）：数据早就支持项目列，这里补界面。
           用原生 select 而不是 Tabs —— 项目是**动态**集合（Tabs 那套是固定三态） -->
      <select
        v-model="projFilter"
        data-dec="proj-filter"
        title="按项目筛选"
        class="h-[var(--btn-h-lg)] max-w-[170px] cursor-pointer appearance-none rounded-[var(--btn-r)] border border-[var(--ui-input)] bg-[var(--ui-card)] pl-2.5 pr-[26px] font-[inherit] text-[12px] text-[var(--ui-foreground)] outline-none hover:bg-[var(--ui-accent)]"
      >
        <option v-for="o in projOptions" :key="o" :value="o">{{ o }}</option>
      </select>
      <Button
        data-dec="select-mode"
        :variant="selectMode ? 'primary' : 'outline'"
        :title="selectMode ? '退出多选' : '多选：批量改状态 / 批量删除'"
        @click="toggleSelectMode"
      >☑ 多选</Button>
      <Button variant="outline" size="icon" title="刷新" @click="refresh">⟳</Button>
    </div>

    <!-- 批量栏（生命周期第 ② 条：成批动）。删除同样两段式，不因为"批量的"就少一道确认 -->
    <div
      v-if="selectMode"
      data-dec="batch-bar"
      class="flex flex-wrap items-center gap-2 rounded-[var(--btn-r)] border border-[var(--ui-border)] bg-[var(--ui-card)] px-3 py-2"
    >
      <span class="text-[12px] font-semibold">已选 {{ selected.length }}</span>
      <Button size="sm" variant="outline" @click="toggleAllVisible">
        {{ filtered.length && selected.length === filtered.length ? '取消全选' : '全选当前' }}
      </Button>
      <span class="flex-1"></span>
      <span class="text-[11.5px] text-[var(--ui-muted-foreground)]">批量设为</span>
      <Button size="sm" variant="ghost" :disabled="!selected.length || batchBusy" @click="batchSetStatus('有效')">有效</Button>
      <Button size="sm" variant="ghost" :disabled="!selected.length || batchBusy" @click="batchSetStatus('已撤销')">已撤销</Button>
      <Button size="sm" variant="ghost" :disabled="!selected.length || batchBusy" @click="batchSetStatus('已合并')">已合并</Button>
      <span class="mx-1 h-4 w-px bg-[var(--ui-border)]"></span>
      <template v-if="!batchDeleteConfirm">
        <Button size="sm" variant="danger" :disabled="!selected.length || batchBusy" @click="batchDeleteConfirm = true">删除所选</Button>
      </template>
      <template v-else>
        <span class="text-[11.5px] text-[var(--ui-muted-foreground)]">删除前每条都会留底到 decisions-deleted.md</span>
        <Button size="sm" variant="ghost" @click="batchDeleteConfirm = false">取消</Button>
        <Button size="sm" variant="danger" :disabled="batchBusy" @click="doBatchDelete">确认删除 {{ selected.length }} 条</Button>
      </template>
      <Button size="sm" variant="ghost" @click="toggleSelectMode">退出多选</Button>
    </div>

    <!-- 贴一句话自动拆字段（第 5 条）：拆完只**预填**，四栏都还能改，不直接落库 -->
    <Card class="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
      <Input
        v-model="smartText"
        data-dec="smart-input"
        class="min-w-[280px] flex-[1_1_320px]"
        placeholder="贴一句话，自动拆出日期 / 项目 / 出处（回车即拆）"
        @keydown.enter="splitSmart"
      />
      <Button variant="outline" :disabled="!smartText.trim()" @click="splitSmart">拆分</Button>
    </Card>

    <!-- 记一条：内容 / 日期 / 项目 / 出处 / 记下 -->
    <Card class="flex flex-wrap items-center gap-2 px-3.5 py-3">
      <Input
        v-model="newContent"
        data-dec="add-input"
        class="min-w-[240px] flex-[1_1_260px]"
        placeholder="记一条新决策（一句话，回车即记）"
        @keydown.enter="add"
      />
      <Input
        v-model="newDate"
        data-dec="add-date"
        type="date"
        class="w-[150px] flex-none"
        title="哪天定的（默认今天）"
      />
      <Input
        v-model="newProject"
        data-dec="add-project"
        class="w-[130px] flex-none"
        list="dec-proj-list"
        placeholder="项目（可留空）"
        title="这条决策属于哪个项目（可留空 = 跨项目 / 未归属）"
      />
      <datalist id="dec-proj-list">
        <option v-for="p in knownProjects" :key="p" :value="p" />
      </datalist>
      <Input
        v-model="newSource"
        data-dec="add-source"
        class="w-[200px] min-w-0 shrink"
        placeholder="出处（如 10-14 群 18:40）"
      />
      <Button variant="primary" :disabled="busy || !newContent.trim()" @click="add">记下</Button>
    </Card>

    <div class="flex max-w-[900px] flex-col gap-2.5">
      <div
        v-if="!filtered.length"
        class="flex flex-col items-center gap-2 py-11 text-[12.5px] text-[var(--ui-muted-foreground)]"
      >
        <div class="text-[26px] opacity-55">🧭</div>
        <div>{{ emptyHint }}</div>
      </div>

      <Card
        v-for="d in filtered"
        :key="d.id"
        data-dec="card"
        class="px-3.5 py-3 transition-colors hover:border-[var(--ui-ring)]"
        :class="[
          d.状态 === '有效' ? '' : 'bg-[var(--ui-muted)]',
          selected.includes(d.id) ? 'border-[var(--ui-ring)] ring-1 ring-[var(--ui-ring)]' : '',
        ]"
      >
        <!-- 多选（生命周期第 ② 条）：只给勾选框，不把整张卡变成点击区 ——
             卡里还有编辑/删除/下拉，整卡可点会让"想改状态"变成"选中了"。 -->
        <label
          v-if="selectMode"
          class="mb-2 flex w-fit cursor-pointer items-center gap-2 text-[11.5px] text-[var(--ui-muted-foreground)]"
        >
          <input
            type="checkbox"
            data-dec="pick"
            class="h-3.5 w-3.5 cursor-pointer accent-[var(--ui-primary)]"
            :checked="selected.includes(d.id)"
            @change="toggleOne(d.id)"
          />
          选中这条
        </label>
        <!-- 编辑态：就地展开（不弹新窗 —— 改一句话不该跨三层） -->
        <div v-if="editingId === d.id" class="flex flex-col gap-2" data-dec="edit-form">
          <Input
            v-model="draft.内容"
            data-dec="edit-content"
            class="w-full"
            placeholder="决策内容（一句话）"
            @keydown.enter="saveEdit"
          />
          <div class="flex flex-wrap items-center gap-2">
            <Input v-model="draft.日期" data-dec="edit-date" type="date" class="w-[150px] flex-none" title="哪天定的" />
            <Input
              v-model="draft.项目"
              data-dec="edit-project"
              class="w-[140px] flex-none"
              list="dec-proj-list"
              placeholder="项目（可留空）"
            />
            <Input
              v-model="draft.出处"
              data-dec="edit-source"
              class="min-w-[160px] flex-1"
              placeholder="出处（可留空）"
            />
          </div>
          <!-- 备注用原生 textarea：备注在数据里本来就是多行（渲染时 whitespace-pre-line），
               用单行 input 会让"可多行"变成假话。preflight 关着 → font-[inherit] 必须写。 -->
          <textarea
            v-model="draft.备注"
            data-dec="edit-note"
            rows="2"
            class="w-full resize-y rounded-[var(--btn-r)] border border-[var(--ui-input)] bg-[var(--ui-card)] px-3 py-2 font-[inherit] text-[12.5px] leading-[1.6] text-[var(--ui-foreground)] outline-none transition-colors placeholder:text-[var(--ui-muted-foreground)] hover:border-[var(--ui-ring)] focus-visible:border-[var(--ui-ring)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--ui-ring)_20%,transparent)]"
            placeholder="备注（可留空，可多行）"
          ></textarea>
          <div class="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" data-dec="edit-cancel" @click="cancelEdit">取消</Button>
            <Button variant="primary" size="sm" data-dec="edit-save" :disabled="busy" @click="saveEdit">保存</Button>
          </div>
        </div>

        <template v-else>
        <div class="flex items-start gap-2.5">
          <Badge data-dec="badge" :variant="badgeOf(d.状态)">
            <span class="h-1.5 w-1.5 rounded-full bg-current"></span>{{ d.状态 }}
          </Badge>
          <div
            class="flex-1 pt-px text-[13.5px] font-semibold leading-[1.55]"
            :class="
              d.状态 === '已撤销' ? 'line-through opacity-75' : d.状态 === '已合并' ? 'opacity-85' : ''
            "
          >
            {{ d.内容 }}
          </div>
          <span class="relative flex-none">
            <select
              data-dec="status"
              class="h-[var(--btn-h-lg)] cursor-pointer appearance-none rounded-[var(--btn-r)] border border-[var(--ui-input)] bg-[var(--ui-card)] pl-2.5 pr-[26px] font-[inherit] text-[12px] font-semibold text-[var(--ui-foreground)] outline-none hover:bg-[var(--ui-accent)] disabled:opacity-50"
              :value="d.状态"
              :disabled="busy"
              @change="setStatusFromEvent(d, $event)"
            >
              <option>有效</option>
              <option>已撤销</option>
              <option>已合并</option>
            </select>
            <span
              class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-[var(--ui-muted-foreground)]"
              >▾</span
            >
          </span>
        </div>

        <div class="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--ui-muted-foreground)]">
          <span
            class="rounded-md border border-[var(--ui-border)] bg-[var(--ui-muted)] px-1.5 py-px font-mono text-[11px]"
            >{{ d.id }}</span
          >
          <span>{{ d.日期 }}</span>
          <template v-if="d.项目">
            <span class="opacity-50">·</span><span>{{ d.项目 }}</span>
          </template>
          <span v-if="d.出处" class="min-w-0 flex-1 truncate">← {{ d.出处 }}</span>
          <!-- 变动时刻（生命周期第 ③ 条：看得见什么时候被动过）—— 解析不出来就不显示，不糊假时间 -->
          <span v-if="relTime(d.更新)" class="flex-none opacity-75" :title="'最近一次变动：' + relTime(d.更新)">
            动于 {{ relTime(d.更新) }}
          </span>
        </div>

        <div
          v-if="d.备注"
          class="mt-2 whitespace-pre-line border-t border-dashed border-[var(--ui-border)] pt-2 text-[12px] leading-[1.65] text-[var(--ui-muted-foreground)]"
        >
          {{ d.备注 }}
        </div>

        <!-- 操作区（2026-10-17）：删除是两段式 —— 先变成「取消 / 确认删除」，
             不会一点就没；确认后主进程还会先留底再删。 -->
        <div class="mt-2 flex flex-wrap items-center justify-end gap-1.5">
          <template v-if="pendingDeleteId === d.id">
            <span class="mr-auto text-[11.5px] text-[var(--ui-muted-foreground)]">
              删除前会先把这条留底到 decisions-deleted.md
            </span>
            <Button variant="ghost" size="sm" data-dec="delete-cancel" @click="pendingDeleteId = ''">取消</Button>
            <Button variant="danger" size="sm" data-dec="delete-confirm" :disabled="busy" @click="confirmDelete(d)">
              确认删除
            </Button>
          </template>
          <template v-else>
            <Button variant="ghost" size="sm" data-dec="edit" @click="startEdit(d)">✏️ 编辑</Button>
            <Button variant="ghost" size="sm" data-dec="delete" @click="askDelete(d)">🗑 删除</Button>
          </template>
        </div>
        </template>
      </Card>
    </div>
  </div>
</template>
