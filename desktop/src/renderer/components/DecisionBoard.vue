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
  filter.value === '全部' ? byProject.value : byProject.value.filter((d) => d.状态 === filter.value)
)

/** 空态得说清是"哪一层筛空了的" —— 只说"没有决策"会在项目筛空时骗人 */
const emptyHint = computed(() => {
  if (!items.value.length) return '还没有决策记录——定了大事，记一条，防它消失'
  if (!byProject.value.length) return `「${projFilter.value}」下还没有决策`
  return filter.value === '全部' ? '这里没有决策' : `「${projFilter.value}」下没有「${filter.value}」的决策`
})

/** 计数跟着**当前项目筛**走 —— 否则四个页签上的数字加起来对不上列表里的张数（界面说假话） */
function countOf(s: string): number {
  return s === '全部' ? byProject.value.length : byProject.value.filter((d) => d.状态 === s).length
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
    const r: any = await window.tegula.decisionSetStatus(d.id, status)
    if (r?.ok) emit('notify', r.message || `${d.id} → ${status}`, 'info')
    else emit('notify', r?.error || '改状态失败', 'error')
    await refresh() // 成功刷新；失败也刷新（把下拉回滚成服务端的真值）
  } catch (e: any) {
    emit('notify', `改状态异常：${e?.message || e}`, 'error')
    await refresh()
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
    <div class="flex items-center gap-3.5">
      <h3 class="text-[16px] font-bold tracking-[0.2px]">决策记录</h3>
      <TabsRoot
        v-model="filter"
        class="inline-flex gap-0.5 rounded-[11px] border border-[var(--ui-border)] bg-[var(--ui-muted)] p-[3px]"
      >
        <TabsList class="inline-flex gap-0.5">
          <TabsTrigger
            v-for="s in FILTERS"
            :key="s"
            :value="s"
            data-dec="tab"
            class="inline-flex cursor-pointer items-center gap-1 rounded-lg border-0 bg-transparent px-[13px] py-[5px] text-[12.5px] font-medium text-[var(--ui-muted-foreground)] outline-none transition-colors hover:text-[var(--ui-foreground)] data-[state=active]:bg-[var(--ui-card)] data-[state=active]:font-semibold data-[state=active]:text-[var(--ui-foreground)] data-[state=active]:shadow-[0_1px_2px_rgba(60,65,80,0.10)]"
          >
            {{ s }}<span class="text-[11px] font-normal text-[var(--ui-muted-foreground)]">{{ countOf(s) }}</span>
          </TabsTrigger>
        </TabsList>
      </TabsRoot>
      <span class="flex-1"></span>
      <!-- 按项目筛选（开发清单第 4 条）：数据早就支持项目列，这里补界面。
           用原生 select 而不是 Tabs —— 项目是**动态**集合（Tabs 那套是固定三态） -->
      <select
        v-model="projFilter"
        data-dec="proj-filter"
        title="按项目筛选"
        class="h-[30px] max-w-[180px] cursor-pointer appearance-none rounded-[9px] border border-[var(--ui-input)] bg-[var(--ui-card)] pl-2.5 pr-[26px] font-[inherit] text-[12px] text-[var(--ui-foreground)] outline-none hover:bg-[var(--ui-accent)]"
      >
        <option v-for="o in projOptions" :key="o" :value="o">{{ o }}</option>
      </select>
      <Button variant="outline" size="icon" title="刷新" @click="refresh">⟳</Button>
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
        :class="d.状态 === '有效' ? '' : 'bg-[var(--ui-muted)]'"
      >
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
              class="h-[30px] cursor-pointer appearance-none rounded-[9px] border border-[var(--ui-input)] bg-[var(--ui-card)] pl-2.5 pr-[26px] font-[inherit] text-[12px] font-semibold text-[var(--ui-foreground)] outline-none hover:bg-[var(--ui-accent)] disabled:opacity-50"
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
        </div>

        <div
          v-if="d.备注"
          class="mt-2 whitespace-pre-line border-t border-dashed border-[var(--ui-border)] pt-2 text-[12px] leading-[1.65] text-[var(--ui-muted-foreground)]"
        >
          {{ d.备注 }}
        </div>
      </Card>
    </div>
  </div>
</template>
