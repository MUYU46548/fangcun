<!--
  接力对话框（2026-10-31 · 渲染层拆分「浮层刀」第三块）

  **边界**：与 LogEditModal / TaskPreview 同一套 —— 组件只「显示 + 收集意图」，
  状态与动作留在 App。父组件用 `reactive()` 包一个 `relayCtl` 传进来。

  ⚠ 由父组件 `v-if="relay_"` 决定挂不挂；组件内部保留同一守卫。
  ⚠ 这个对话框要能在任何视图下打开（任务详情底部的「从这里继续」），不能放进 LogsView。
  ⚠ 这里**不许**用 Tailwind 工具类（views/ 的同款纪律；样式仍全在 app.css）。
-->
<template>
  <div id="relay-overlay" class="overlay" v-if="relay_" @mousedown.self="closeRelay">
    <div id="relay-modal">
      <h3>⏭ 接力 · 从这里继续</h3>
      <div class="hint">一次动作做完四件事：出清旧的、继承上下文、建立新日志、可以立刻开跑。</div>
      <div class="relay-src">
        <span class="rs-label">源</span>
        <span class="rs-id">{{ relay_.src.id }}</span>
        <span>「{{ relay_.src.title || '(无标题)' }}」· <b>{{ relay_.src.status === 'completed' ? '已完成' : relay_.src.status === 'archived' ? '已归档' : '待处理' }}</b></span>
        <span class="rs-grow"></span>
        <span>执行内容与下一步都留空待写 · 要旧内容点行尾「带入」</span>
      </div>
      <label>新日志标题</label>
      <input v-model="relay_.title" placeholder="给接下来这段工作起个标题" />
      <label>项目</label>
      <select v-model="relay_.project" class="logsel">
        <option value="">（不归属）</option>
        <option v-if="relay_.project && !projects.some(p => p.id === relay_.project)"
          :value="relay_.project">{{ relay_.project }}（未在登记表中）</option>
        <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
      </select>
      <div class="hint">继承自源：<b>{{ (projects.find(p => p.id === relay_.project)?.name) || relay_.project || '（不归属）' }}</b></div>
      <!-- 2026-09-30 用户第 3 条（卡 004）补的「执行内容」框；同日用户第 1 条（卡 006）指出
           两框上下颠倒：人类认知与日志卡的读法都是「先做了什么 → 接下来做什么」，
           所以执行内容在上、下一步在下（与「新建/编辑日志」对话框同序）。 -->
      <label>执行内容（本次做了什么；可粘贴上次会话的完成情况汇总）</label>
      <textarea v-model="relay_.content" class="font-[inherit]" placeholder="执行内容...（留空则新日志正文为空，之后可再编辑补写）"></textarea>
      <!-- 2026-10-02 用户「下一步依旧每次都直接挪用上次的输入结果」：不再预填源的下一步，
           改为**默认留空**（与执行内容同一口径：源的「下一步」属于上一段的计划，新日志该写本次的），
           需要旧内容时点行尾「带入」按钮**主动取** —— 挪用变申请，主动权在用户手里。
           保留 label 紧邻 textarea 的兄弟结构：renderer-web 的 relayTaOf() 与顺序断言都靠它定位。 -->
      <label class="ns-label">下一步
        <button type="button" class="ghost relay-bring" title="把源日志的「下一步」原文放进本框（框里已有内容时不会覆盖）"
          @click.stop="bringSourceNextSteps">⧉ 带入源的下一步</button>
      </label>
      <textarea v-model="relay_.nextSteps" placeholder="下一步...（默认留空，本次自己写；要用源里的内容点上方「带入源的下一步」）"></textarea>
      <label>关联任务</label>
      <div v-if="relay_.taskCandidates.length" class="log-task-multi">
        <label v-for="t in relay_.taskCandidates" :key="t.id" class="log-task-opt">
          <input type="checkbox" :value="t.id" v-model="relay_.taskIds" />
          <span class="lto-id">{{ t.id }}</span>
          <span class="lto-title">{{ t.title || '(无标题)' }}</span>
          <span class="lto-st">{{ t.status }}</span>
        </label>
      </div>
      <div v-else class="hint">源日志没有关联任务 —— 新日志先不挂任务</div>
      <!-- 2026-10-03 用户反馈1（卡 task-20261003-001，用户拍板拆两字段）：
           此前一个「执行 Agent」字段承担两种含义（编辑框还把它标成「上次执行 Agent」），
           用户原话「接力只能填执行 Agent，不能填上次的执行 Agent，明明上次更重要」。
           现在：上次 = 接力来源那段是谁跑的（找上次会话用，继承源、可改、可手补）；
           本次 = 新日志这段由谁跑（默认沿用源）。 -->
      <label>上次的执行 Agent（接力来源这段是谁跑的 —— 找上次的会话看这里）</label>
      <select v-model="relay_.prevAgentName" class="logsel">
        <option value="">（不指定）</option>
        <option v-if="relay_.prevAgentName && !agentPresets.includes(relay_.prevAgentName)"
          :value="relay_.prevAgentName">{{ relay_.prevAgentName }}（继承自源）</option>
        <option v-for="a in agentPresets" :key="a" :value="a">{{ a }}</option>
      </select>
      <input v-model="relay_.prevAgentName" placeholder="或手动输入上次的执行 Agent（源没记录时在这里补）" />
      <label>本次执行 Agent（新日志这段由谁跑）</label>
      <select v-model="relay_.agentName" class="logsel">
        <option value="">（不指定）</option>
        <option v-if="relay_.agentName && !agentPresets.includes(relay_.agentName)"
          :value="relay_.agentName">{{ relay_.agentName }}（继承自源）</option>
        <option v-for="a in agentPresets" :key="a" :value="a">{{ a }}</option>
      </select>
      <!-- 2026-10-30（暮雨第 6 条）：以前只能"先创建、再点编辑、再贴会话 ID"——
           一个字段强制点两次。会话 ID 是创建时就知道的，必须在这张表里一次填完。 -->
      <label>本次会话 ID（粘贴这次 agent 会话的 ID，可留空）</label>
      <input v-model="relay_.sessionId" placeholder="例如 019a… / hermes-… —— 建好后卡面上直接可查，不用再编辑一次" />
      <div class="hint">上次的执行 Agent：<b>{{ relay_.prevAgentName || '（源日志没记）' }}</b>（从源日志继承）· 本次：<b>{{ relay_.agentName || '（不指定）' }}</b>（默认沿用源）；会话 ID 与日期按新日志重新记</div>
      <div class="relay-opts">
        <label class="relay-opt"><input type="checkbox" v-model="relay_.archiveSource" />
          <span>接力后把源日志归档（出清）
            <i>旧的移进「已归档」，不占「待处理」，也不进「已完成」的清理队列 —— 调度台干净。</i></span></label>
        <label class="relay-opt"><input type="checkbox" v-model="relay_.completeSourceTasks" />
          <span>顺手把源日志的关联任务置「完成」
            <i>旧任务一次性出清；不勾则任务状态保持不动。</i></span></label>
      </div>
      <!-- 关闭防丢确认条（2026-09-30 用户第 2 条，卡 006）：
           此前走原生 window.confirm，用户实测两次「点到旁边数据全丢、防护未生效」——
           ① 脏检查只比对三个文本框，只动过勾选/下拉时判定为「没改」，直接静默关；
           ② 原生框在窗口外/被回车一击带过，起不到「必须看一眼」的作用。
           现在：任何字段与打开时的快照不同 → 对话框内出确认条，必须点「丢弃」才真关。 -->
      <div v-if="relayDiscard_" class="relay-discard" role="alertdialog" aria-live="polite">
        <span class="rd-text">⚠ 这次的改动还没创建，关掉就没了：<b>{{ relayDirtyHint }}</b></span>
        <span class="rd-acts">
          <button class="ghost" @click="relayDiscard_ = false">继续填写</button>
          <button class="danger" @click="discardRelay">丢弃并关闭</button>
        </span>
      </div>
      <div class="acts">
        <button class="ghost" @click="closeRelay">取消</button>
        <button class="ghost" title="只建新日志（待处理），不改源日志" @click="executeRelay(false)">创建</button>
        <button class="pri" title="建新日志并标「进行中」，随时可跑" @click="executeRelay(true)">创建并开跑</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toRef } from 'vue'

/** 唯一 prop：接力控制器（父组件 reactive 包过的那一坨）。状态 toRef、动作解构。 */
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl

const relay_ = toRef(ctl, 'relay_')
const relayDiscard_ = toRef(ctl, 'relayDiscard_')
const relayDirtyHint = toRef(ctl, 'relayDirtyHint')
const projects = toRef(ctl, 'projects')
const agentPresets = toRef(ctl, 'agentPresets')

const { closeRelay, bringSourceNextSteps, discardRelay, executeRelay } = ctl
</script>
