<!--
  路线图（2026-10-23 拆成组件 · 拆分计划第 1 批第 7 块）

  这块是**真正干净**的一块：52 行模板 + 4 个状态/函数，零弹窗、零跨视图状态。
  数据全来自两个 IPC：`aggregateRoadmap`（项目 / 批次 / 任务）与 `suggestMilestones`（阶段里程碑）。

  **2026-10-31 结构重做（暮雨第 7 条）**：这一页服务一个决策 —— **这个项目现在该推哪一批？**
    · 顶部：一行跨项目结论（谁在推、谁卡着、最接近收口的是哪批）；
    · 每个项目：**当前批次**顶到第一行（名字 + 还剩几张 + 进度条），其余批次默认收起；
    · 「下一步」仍是那 2-3 张能立刻动的卡，点行进卡。
  批次**数据顺序不动**（`rb-completed` 在前之类是老断言的口径），收起来的只是视觉 ——
  用 `.focus` + CSS 隐藏，DOM 里一条不少（renderer-web 按 `.rp-batch` 数过 2 条）。
-->
<template>
    <main id="board" class="roadmap-view">
      <div class="roadmap-header">
        <h3>路线图 · 该推哪一批</h3>
        <div class="roadmap-ctrls">
          <button class="ghost" @click="loadRoadmap">⟳ 刷新</button>
        </div>
      </div>
      <div class="roadmap-lead">
        按批次看每个项目走到哪。<b>点任意任务行</b>进卡；不知道先干哪个，就从「下一步」挑一个。
      </div>
      <!-- 一行跨项目结论：这一页的"先干什么" -->
      <div class="roadmap-focus-bar" v-if="roadmapData.projects && roadmapData.projects.length">{{ focus.text }}</div>

      <!-- 阶段里程碑（2026-10-11，C 组死通道接回）：按批次前缀 P0/P1/P2/P3 算各阶段完成度，
           例如「核心阶段完成」「功能阶段进行中 60%」—— 一眼看出项目走到哪一段了。
           ⚠ 类名 `.rms-strip` 不能动：renderer-web 按它等"里程碑条出现"。 -->
      <div class="rms-strip" v-if="roadmapMilestones.length">
        <span class="rms-label">阶段里程碑</span>
        <span v-for="(m, i) in roadmapMilestones" :key="i" class="rms-item" :class="'rms-' + m.status">
          <b>{{ m.project_name || m.project }}</b> · {{ m.milestone }}
          <template v-if="m.status === 'in_progress' && m.progress != null"> {{ m.progress }}%</template>
        </span>
      </div>

      <div class="roadmap-content">
        <div v-if="!roadmapData.projects || !roadmapData.projects.length" class="empty-state">
          <div class="empty-icon">🗺️</div>
          <div class="empty-text">还没有排过批次的任务</div>
          <div class="empty-sub">给任务卡填上「批次」（如 P0 核心 / 2026-Q3），它们就会按批聚到这里。</div>
        </div>
        <div v-for="(proj, pi) in focus.rows" :key="proj.id" class="roadmap-project"
          :class="{ focus: !showAll[proj.id] }">
          <div class="rp-header">
            <span class="rp-name">{{ proj.name }}</span>
            <span class="rp-health st" :class="'st-' + proj.health">{{ roadmapHealthLabel(proj.health) }}</span>
            <!-- 当前批次：这一页的答案。没有可推的批次就明说，不糊一个空进度条 -->
            <span class="rp-focus" v-if="proj.current">
              现在推 <b>{{ proj.current.name }}</b> · 还剩 {{ proj.remaining }} 张
            </span>
            <span class="rp-focus done" v-else>{{ proj.totalBatches ? '全部批次已收口' : '还没排批' }}</span>
            <button class="ghost rp-toggle" @click="toggleAll(proj.id)">
              {{ showAll[proj.id] ? '只看当前批次' : '看全部批次（' + proj.totalBatches + '）' }}
            </button>
          </div>
          <!-- 进度条：只在真有当前批次时出现（0/0 不画） -->
          <div class="rp-bar" v-if="proj.current" :title="proj.current.done + ' / ' + proj.current.total">
            <span class="rp-bar-in" :style="{ width: proj.percent + '%' }"></span>
          </div>
          <!-- 2026-10-31 第二轮：没排批次的卡不再伪装成一个「未分类」阶段，
               而是摊在这儿说清欠账有多少、怎么归位。 -->
          <div class="rp-unbatched" v-if="proj.unbatched">
            ⚠ <b>{{ proj.unbatched }}</b> 张卡没排批次 —— 它们不属于任何阶段，也不会出现在上面。
            <span class="rp-unbatched-hint">在任务里填「批次」（如 P0 核心 / 2026-Q3）就会归位；同一个名字 = 同一批。</span>
          </div>

          <div class="rp-batches">
            <div v-for="batch in batchesOf(pi)" :key="batch.name" class="rp-batch" :class="['rb-' + batch.status, { 'is-current': !!proj.current && batch.name === proj.current.name }]">
              <div class="rb-header">
                <span class="rb-name">{{ batch.name }}</span>
                <span class="rb-count">{{ batch.done }}/{{ batch.total }}</span>
              </div>
              <div class="rb-tasks">
                <div v-for="t in batch.tasks" :key="t.id" class="rb-task rb-click" title="点这张卡进详情"
                  @click="emit('open-task', t.id)">
                  <span class="st small" :class="'st-' + statusClass(t.status)">{{ t.status }}</span>
                  <span class="rb-title">{{ t.title }}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="rp-next" v-if="proj.nextActions && proj.nextActions.length">
            <label>下一步</label>
            <div class="rp-actions">
              <div v-for="a in proj.nextActions" :key="a.taskId" class="rp-action rb-click" title="点这张卡进详情"
                @click="emit('open-task', a.taskId)">
                <span class="st small" :class="a.priority === '高' ? 'st-review' : 'st-todo'">{{ a.priority }}</span>
                {{ a.title }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { statusClass } from '../../shared/status'
import { focusRoadmap, type RoadmapProjectLike } from '../../shared/roadmapFocus'

const roadmapData = ref<any>({ projects: [] })
/** 阶段里程碑（P0/P1/P2/P3 各阶段完成度），随路线图一起加载 */
const roadmapMilestones = ref<any[]>([])
/** 2026-10-31：点任务行 → 打开卡（跳转与落盘在 App，组件只发意图） */
const emit = defineEmits<{ (e: 'open-task', id: string): void }>()
/** 哪些项目展开"全部批次"。默认收起 —— 这一页先回答"推哪一批" */
const showAll = reactive<Record<string, boolean>>({})
function toggleAll(id: string): void { showAll[id] = !showAll[id] }

/** 决策视图：当前批次 / 还剩几张 / 排序 / 跨项目结论 —— 算法在 shared/roadmapFocus.ts */
const focus = computed(() => focusRoadmap((roadmapData.value?.projects || []) as RoadmapProjectLike[]))
/** 按 focus 的行顺序取回原始项目；批次顺序保持主进程给的顺序，且**剔除「未分类」**
 *  （2026-10-31：它不是阶段，是欠账 —— 由上面那行 `proj.unbatched` 单独说明） */
function batchesOf(index: number): any[] {
  const row = focus.value.rows[index]
  const raw = (roadmapData.value?.projects || []).find((p: any) => String(p.id) === row?.id)
  return ((raw?.batches || []) as any[]).filter((b) => b && b.name !== '未分类')
}

/**
 * 拉路线图 + 里程碑。
 *
 * 两个 IPC 分开 try：里程碑挂了不该把整页路线图也拖空 —— 原来就是这样写的，
 * 搬过来时保持（数据来源不同，失败面也不同）。
 */
async function loadRoadmap(): Promise<void> {
  try {
    roadmapData.value = await window.tegula.aggregateRoadmap()
  } catch {
    roadmapData.value = { projects: [] }
  }
  try {
    const m: any = await (window as any).tegula.suggestMilestones()
    roadmapMilestones.value = Array.isArray(m) ? m : []
  } catch { roadmapMilestones.value = [] }
}

function roadmapHealthLabel(h: string): string {
  return ({ active: '活跃', stuck: '停滞', idle: '空闲' } as Record<string, string>)[h] || h
}

// 进页面就加载（空页 = 说假话）；App.vue 的 loadViewData('roadmap') 已显式空掉
onMounted(() => { void loadRoadmap() })
</script>
