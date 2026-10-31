<!--
  任务预览弹窗（2026-10-31 · 渲染层拆分「浮层刀」第一块）

  **边界**：与 `BoardView.vue` / `LogsView.vue` 同一套 —— 组件只「显示 + 收集意图」，
  状态与动作留在 App。父组件用 `reactive()` 包一个 `taskPreviewCtl` 传进来，
  组件用 `toRef` 接状态、直接解构接函数。

  ⚠ 弹窗由父组件 `v-if="previewTask"` 决定挂不挂；组件内部保留同一守卫，
    这样单独使用也不会渲染空壳。

  ⚠ 这里**不许**用 Tailwind 工具类：`tailwind.config.js` 的 content 只覆盖
    `src/renderer/components/`，但这条纪律仍按 views/ 的同款执行 —— 样式全在 app.css。
-->
<template>
  <div id="roverlay" class="overlay" v-if="previewTask" @mousedown.self="previewTask = null">
    <div id="rmodal">
      <h3>
        {{ previewTask.title || previewTask.id }}
        <span class="st" :class="'st-' + statusClass(previewTask.status)">{{ previewTask.status }}</span>
      </h3>
      <div class="meta">
        <div><span class="k">ID</span><span class="v">{{ previewTask.id }}</span></div>
        <div><span class="k">项目</span><span class="v">{{ previewTask.project || '—' }}</span></div>
        <div><span class="k">优先级</span><span class="v">{{ priorityLabel(previewTask.priority) }}</span></div>
        <div v-if="previewTask.assignee"><span class="k">指派</span><span class="v">{{ previewTask.assignee }}</span></div>
        <div><span class="k">时间</span><span class="v">{{ previewTimeLabel(previewTask) }}</span></div>
        <div v-if="previewTask.batch"><span class="k">批次</span><span class="v">{{ previewTask.batch }}</span></div>
        <!-- 返工归因（2026-10-06 卡 003）：表单里能填，这里也得看得见 —— 否则填完等于石沉大海 -->
        <div v-if="previewTask.attribution"><span class="k">返工归因</span><span class="v">{{ previewTask.attribution }}</span></div>
        <div v-if="previewTask.archived"><span class="k">来源</span><span class="v">📦 已归档</span></div>
        <div><span class="k">创建</span><span class="v">{{ formatDate(previewTask.created) }}</span></div>
        <div><span class="k">更新</span><span class="v">{{ formatDate(previewTask.updated) }}</span></div>
      </div>
      <!-- 上次驳回（2026-10-30 暮雨第 2 条）：理由可选、可改、退回返工后仍在卡上。
           没有理由也如实说「当时没写理由」—— 那不是"没问题"。 -->
      <div class="reject-block" v-if="rejectReasonOf(previewTask) || previewTask.reject_at || previewTask.status === '驳回'">
        <label>
          上次驳回
          <span v-if="previewTask.reject_at" class="reject-at">· {{ formatDateTime(previewTask.reject_at) }}</span>
        </label>
        <template v-if="rejectEdit">
          <textarea v-model="rejectEditText" class="reject-edit font-[inherit]" rows="2"
            placeholder="哪里不行 / 要改成什么样（可以留空）"></textarea>
          <div class="reject-acts">
            <button class="ghost" @click="rejectEdit = false">取消</button>
            <button class="ok" :disabled="rejectSaving" @click="saveRejectEdit">{{ rejectSaving ? '保存中…' : '保存理由' }}</button>
          </div>
        </template>
        <template v-else>
          <div class="reject-text">{{ rejectReasonOf(previewTask) || '（当时没写理由）' }}</div>
          <button class="ghost reject-edit-btn" title="改这条驳回理由（不影响状态）"
            @click="startRejectEdit">✏️ 改理由</button>
        </template>
      </div>
      <div class="body" v-if="previewTask.body">
        <label>正文</label>
        <div class="body-text markdown" v-html="renderBody(previewTask.body)" @change="onBodyChange"></div>
      </div>
      <!-- 架构图（2026-10-13 暮雨第 2 条 · 方案 A）：frontmatter 的 `架构` 是
           LayerDiagramSpec 的 JSON，交给 shared/layerDiagram 的纯函数画成 SVG。
           ⚠ JSON 读不出来要**说人话**，绝不静默留白 —— 否则用户以为"填了没生效"。 -->
      <div class="arch-section" v-if="previewArch.state !== 'none'">
        <label>架构图</label>
        <div v-if="previewArch.state === 'ok'" class="arch-svg" v-html="previewArch.svg"></div>
        <!-- archify 技能卡：照实说明，**不硬转、也不误报"读不出来"**（2026-10-14 清单第 9 条） -->
        <div v-else-if="previewArch.state === 'archify'" class="arch-error arch-archify">
          这是一张 <b>archify 技能卡</b>（<code>{{ previewArch.archify?.type }}</code><template
            v-if="previewArch.archify?.views"> · {{ previewArch.archify?.views }} 个视图</template><template
            v-if="previewArch.archify?.counts"> · {{ previewArch.archify?.counts }}</template>）。
          它的格式与方寸的分层架构图不是一回事，所以这里不画图（硬转会丢信息）；
          结构摘要见正文，原始 JSON 完整存在「架构」字段里。
        </div>
        <div v-else class="arch-error">架构图 JSON 读不出来：{{ previewArch.error }}</div>
      </div>
      <div class="logs-section" v-if="previewTask">
        <label>关联日志 ({{ taskLogs.length }})</label>
        <div class="task-logs-list">
          <!-- 2026-09-28 用户：这条列表项此前**没有任何点击处理器** —— 单击、双击都没反应，
               人只能反复点、以为是双击才行。现在单击 = 打开只读预览（与日志页一致）。 -->
          <div v-for="log in taskLogs" :key="log.id" class="task-log-item"
            title="点击查看这条日志"
            @click="openLogPreview(log)">
            <span class="log-status-badge" :class="logStatusClass(log)">{{ logStatusLabel(log) }}</span>
            <div class="task-log-main">
              <div class="task-log-title">{{ log.title || '(无标题)' }}</div>
              <div class="task-log-meta" :title="log.created">{{ formatDateTime(log.created) }}</div>
            </div>
            <button
              v-if="log.status !== 'completed' && log.status !== 'archived'"
              class="ghost task-log-done"
              title="一键标记完成（默认保留 7 天）—— 完成后这里会变成「撤销」"
              @click.stop="quickCompleteLog(log)"
            >✓ 完成</button>
            <!-- 2026-10-21 暮雨第 1 条：这里原来只有「✓ 完成」，一旦点错（无二次确认），
                 该行就**只剩一个状态角标**，撤销得跑去日志页翻分区找那条卡 ——
                 这就是"撤销按钮在（但不在我眼前）"。误操作的正解是原地回退。 -->
            <button
              v-else
              class="ghost task-log-done"
              title="撤销完成 / 归档，退回「待处理」（只改状态，不删文件）"
              @click.stop="reopenLogItem(log.id)"
            >↩ 撤销</button>
          </div>
          <div v-if="!taskLogs.length" class="hint">该任务暂无关联日志</div>
        </div>
        <button class="add-note-btn" @click="openLogForTask(previewTask.id)">+ 写一条执行日志</button>
      </div>
      <!-- Git 联动（卡 017，2026-10-06）：这张卡存续期间它所属仓库的提交 + 提到本卡 ID 的提交。
           只读 git log；读不到就照实说原因（没归属项目 / 没登记工作目录 / 不是 git 仓库）。 -->
      <div class="logs-section gitlink-section" v-if="previewTask">
        <label>
          相关提交
          <span v-if="taskCommits && taskCommits.repo" class="gitlink-repo">{{ taskCommits.repo }}</span>
        </label>
        <div v-if="taskCommitsLoading" class="hint">读取中…</div>
        <template v-else-if="taskCommits">
          <div v-if="taskCommits.note" class="hint">{{ taskCommits.note }}</div>
          <template v-else>
            <div v-if="(taskCommits.mentioned || []).length" class="gitlink-list">
              <div class="gitlink-head">提交信息里提到本卡（{{ taskCommits.mentioned.length }}）</div>
              <div v-for="c in taskCommits.mentioned" :key="'m-' + c.hash" class="gitlink-row">
                <span class="gl-short">{{ c.short }}</span>
                <span class="gl-subject" :title="c.subject">{{ c.subject }}</span>
                <span class="gl-date">{{ c.date ? formatDate(c.date) : '—' }}</span>
              </div>
            </div>
            <div v-if="(taskCommits.commits || []).length" class="gitlink-list">
              <div class="gitlink-head">卡片存续期间的提交（{{ taskCommits.commits.length }}）</div>
              <div v-for="c in taskCommits.commits" :key="'c-' + c.hash" class="gitlink-row">
                <span class="gl-short">{{ c.short }}</span>
                <span class="gl-subject" :title="c.subject">{{ c.subject }}</span>
                <span class="gl-date">{{ c.date ? formatDate(c.date) : '—' }}</span>
              </div>
            </div>
            <div v-if="!(taskCommits.mentioned || []).length && !(taskCommits.commits || []).length" class="hint">
              这段时间里这个仓库没有提交，提交信息里也没提到 {{ previewTask.id }}
            </div>
          </template>
        </template>
      </div>
      <div class="acts task-acts">
        <div class="acts-group">
          <span class="acts-label">流转</span>
          <button
            v-if="previewTask.status === '完成' || previewTask.status === '驳回'"
            class="ok"
            :title="previewTask.status === '驳回'
              ? '退回「待办」重新开工 —— 只改状态，文件一个不动'
              : '退回「待办」—— 只改状态，文件一个不动'"
            @click="restoreTask(previewTask)"
          >{{ previewTask.status === '驳回' ? '↩ 退回返工' : '↩ 退回待办' }}</button>
          <!-- 终态的「删除」不放这里：它与「操作」组里那个删除按钮重复（用户 2026-09-25 第 5 条）。
               底部「操作」组的删除对任何状态都在，单一入口，不重复。
               2026-10-06 用户报「驳回任务只能还原和归档，为了省事点了归档」——
               删除其实在下面「操作」组，但流转组只摆两个按钮时，人不会往下找。
               所以这里补一句**出路提示**（不加第三个按钮）：三种去向 + 各自后果一次说清。 -->
          <span v-if="previewTask.status === '完成' || previewTask.status === '驳回'" class="acts-hint">
            接着做 →「退回」｜先收起 →「归档」（文件移进 archive/，随时能还原）｜不要了 → 下面「操作」组最右的「删除」（进回收站，可找回）
          </span>
          <template v-else>
            <!-- 验收裁决弹窗（accept / reject + 驳回理由）此前**没有任何入口** ——
                 后端 review:accept / review:reject 通道齐全，openReview 也写好了，
                 但没人调用它。这里补上正式入口：待验收任务可走完整裁决流程，
                 不想走流程的仍可用下面的「完成/驳回」直达。 -->
            <!-- 2026-10-25（暮雨第 1 条）：待审批卡此前**没有正向出口** —— 只有下面两个
                 forceClose 按钮（跳过流程、不写结论），用户原话「要么完成要么驳回，
                 没有其他去处，理由都填不了」。现在待审批与待验收共用同一个裁决弹窗：
                 待审批 →「批准」转正为「待办」/「驳回」；待验收 →「通过」/「驳回」。
                 理由一律写入结果记录，卡片上查得到。 -->
            <button
              v-if="previewTask.status === '待验收' || previewTask.status === '待审批'"
              class="pri"
              :title="previewTask.status === '待审批'
                ? '审批裁决：批准转正为「待办」/ 驳回（驳回必须填理由，会写进结果记录）'
                : '正式验收裁决：通过 / 驳回（驳回必须填理由，会写进结果记录）'"
              @click="openReview(previewTask)"
            >{{ previewTask.status === '待审批' ? '⚖ 审批裁决' : '✅ 验收裁决' }}</button>
            <button
              class="ok"
              title="直接标记完成（跳过验收，适用于挂死/废弃任务）"
              @click="forceCloseTask(previewTask, '完成')"
            >✓ 完成</button>
            <button
              class="danger"
              title="直接驳回（不要求先到待验收；理由可选，会留在卡上）"
              @click="openDirectReject(previewTask)"
            >✕ 驳回</button>
          </template>
          <button
            class="warning"
            title="移入归档视图（文件移到 task-data/archive/）。任何状态都可以归档"
            @click="archiveTask(previewTask)"
          >📦 归档</button>
        </div>
        <div class="acts-group">
          <span class="acts-label">操作</span>
          <button class="ok" title="编辑任务的全部字段" @click="openEdit(previewTask)">✏️ 编辑</button>
          <button class="ghost" title="指派开始/截止时间（时间段会显示在日历上）" @click="openCalAssignTask(previewTask)">📅 指派时间</button>
          <button class="ghost" title="复制任务 ID" @click="copyId(previewTask.id)">📋 ID</button>
          <button class="ghost" title="在文件管理器中定位这个任务的 markdown 文件" @click="openTaskFile(previewTask)">📄 文件</button>
          <button class="ghost" title="复制一份任务" @click="copyTaskClick(previewTask.id)">📑 副本</button>
          <button class="danger" title="删除任务（会进入 trash，可人工找回）" @click="deleteTask(previewTask.id)">🗑 删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { statusClass } from '../../shared/status'
import { priorityLabel } from '../../shared/priority'
import { formatDate, formatDateTime } from '../../shared/time'
import { renderBody } from '../markdown'

/**
 * 唯一 prop：任务预览控制器（父组件用 `reactive()` 包过的那一坨）。
 * 状态 → toRef；动作 → 直接解构。和 BoardView / LogsView 同一套。
 */
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl

// ── 状态 ──────────────────────────────────────────────────────────────
const previewTask = toRef(ctl, 'previewTask')
const previewArch = toRef(ctl, 'previewArch')
const rejectEdit = toRef(ctl, 'rejectEdit')
const rejectEditText = toRef(ctl, 'rejectEditText')
const rejectSaving = toRef(ctl, 'rejectSaving')
const taskLogs = toRef(ctl, 'taskLogs')
const taskCommits = toRef(ctl, 'taskCommits')
const taskCommitsLoading = toRef(ctl, 'taskCommitsLoading')

// ── 动作 ──────────────────────────────────────────────────────────────
const {
  previewTimeLabel, rejectReasonOf, startRejectEdit, saveRejectEdit, onBodyChange,
  openLogPreview, quickCompleteLog, reopenLogItem, openLogForTask,
  logStatusClass, logStatusLabel,
  restoreTask, openReview, forceCloseTask, openDirectReject, archiveTask,
  openEdit, openCalAssignTask, copyId, openTaskFile, copyTaskClick, deleteTask,
} = ctl
</script>
