<!--
  路线图（2026-10-23 拆成组件 · 拆分计划第 1 批第 7 块）

  这块是**真正干净**的一块：52 行模板 + 4 个状态/函数，零弹窗、零跨视图状态、
  零用户操作（唯一交互就是「⟳ 刷新」）。数据全来自两个 IPC：
  `aggregateRoadmap`（项目 / 批次 / 任务）与 `suggestMilestones`（阶段里程碑）。

  `statusClass` 从 `shared/status.ts` 取，与看板、阻塞页共用同一份映射 ——
  各写一套会出现「同一个状态在路线图是灰、在看板是红」。
-->
<template>
    <main id="board" class="roadmap-view">
      <div class="roadmap-header">
        <h3>路线图</h3>
        <div class="roadmap-ctrls">
          <button class="ghost" @click="loadRoadmap">⟳ 刷新</button>
        </div>
      </div>
      <!-- 阶段里程碑（2026-10-11，C 组死通道接回）：按批次前缀 P0/P1/P2/P3 算各阶段完成度，
           例如「核心阶段完成」「功能阶段进行中 60%」—— 一眼看出项目走到哪一段了。 -->
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
          <div class="empty-text">暂无路线图数据</div>
        </div>
        <div v-for="proj in (roadmapData.projects || [])" :key="proj.id" class="roadmap-project">
          <div class="rp-header">
            <span class="rp-name">{{ proj.name }}</span>
            <span class="rp-health st" :class="'st-' + proj.health">{{ roadmapHealthLabel(proj.health) }}</span>
          </div>
          <div class="rp-batches">
            <div v-for="batch in proj.batches" :key="batch.name" class="rp-batch" :class="'rb-' + batch.status">
              <div class="rb-header">
                <span class="rb-name">{{ batch.name }}</span>
                <span class="rb-count">{{ batch.done }}/{{ batch.total }}</span>
              </div>
              <div class="rb-tasks">
                <div v-for="t in batch.tasks" :key="t.id" class="rb-task">
                  <span class="st small" :class="'st-' + statusClass(t.status)">{{ t.status }}</span>
                  <span class="rb-title">{{ t.title }}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="rp-next" v-if="proj.nextActions && proj.nextActions.length">
            <label>下一步</label>
            <div class="rp-actions">
              <div v-for="a in proj.nextActions" :key="a.taskId" class="rp-action">
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
import { onMounted, ref } from 'vue'
import { statusClass } from '../../shared/status'

const roadmapData = ref<any>({ projects: [] })
/** 阶段里程碑（P0/P1/P2/P3 各阶段完成度），随路线图一起加载 */
const roadmapMilestones = ref<any[]>([])

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
