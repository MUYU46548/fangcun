<!--
  绑定附属日志（2026-11-02 · App.vue 后三刀第一刀「浮层」收尾）

  **边界**：只搬模板。候选 / 六维筛选 / 已占用原因 / 保存绑定全在 `useLogGroups`，
  父组件用 `logAttachCtl` 转接 —— 状态只有一份，筛选逻辑不复制。
  ⚠ 候选来自**全量日志**，不受主界面项目 / 搜索筛选影响（2026-10-30 暮雨第 4 条）。
-->
<template>
  <div v-if="ctl.logAttachTarget" class="overlay" @mousedown.self="ctl.logAttachTarget = null">
    <div id="log-attach-modal">
      <h3>🔗 绑定附属日志</h3>
      <div class="la-main">
        <span class="la-lbl">主日志</span>
        <b>{{ ctl.logAttachTarget.title || ctl.logAttachTarget.id }}</b>
        <span v-if="ctl.logAttachLoading" class="la-loading">正在读取全部日志…</span>
      </div>
      <div class="la-hint">
        勾选同一轮一起跑的那几条（进度通知 / 并行通道）。绑定后它们会收进主日志下面的框，
        每条仍可单独打开、单独改、单独完成；绑定关系落盘，下次还在。
        一个附属只能归一个主日志；最多 20 条。勾选顺序 = 开工单里的顺序。
      </div>
      <div class="la-filters">
        <input v-model="ctl.logAttachQuery" class="la-search" spellcheck="false"
          placeholder="搜索标题 / 正文 / ID / 任务 / 会话…" />
        <select v-model="ctl.logAttachProject" class="la-sel" title="按项目筛选">
          <option value="">全部项目</option>
          <option v-for="p in ctl.logAttachProjects" :key="'lap-' + p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <select v-model="ctl.logAttachStatus" class="la-sel" title="按状态筛选">
          <option value="">全部状态</option>
          <option value="running">进行中</option>
          <option value="active">待处理</option>
          <option value="completed">已完成</option>
          <option value="archived">已归档</option>
        </select>
        <select v-model="ctl.logAttachAgent" class="la-sel" title="按执行 Agent 筛选">
          <option value="">全部 Agent</option>
          <option v-for="a in ctl.logAttachAgents" :key="'laa-' + a" :value="a">{{ a }}</option>
        </select>
        <select v-model="ctl.logAttachPrio" class="la-sel" title="按优先级筛选">
          <option value="">全部优先级</option>
          <option value="高">高</option>
          <option value="中">中</option>
          <option value="低">低</option>
          <option value="__none__">未标</option>
        </select>
        <input v-model="ctl.logAttachDateFrom" type="date" class="la-sel la-date" title="起始日期（含）" />
        <span class="la-sep">→</span>
        <input v-model="ctl.logAttachDateTo" type="date" class="la-sel la-date" title="截止日期（含）" />
        <button class="ghost" title="清空全部筛选条件" @click="ctl.clearLogAttachFilters">清空筛选</button>
        <label class="la-toggle" title="已被别的组占用的日志不能重复绑定；打开这里可以看清它们为什么不出现">
          <input type="checkbox" v-model="ctl.logAttachShowBlocked" /> 显示已占用
        </label>
      </div>
      <div class="la-countline">
        <span>筛出 <b>{{ ctl.logAttachRows.length }}</b> 条</span>
        <span v-if="ctl.logAttachBlockedCount && !ctl.logAttachShowBlocked" class="la-blocked-note">
          · 另有 {{ ctl.logAttachBlockedCount }} 条已被别的组占用或自己就是主日志
        </span>
        <span v-else-if="ctl.logAttachBlockedCount" class="la-blocked-note">
          · 其中 {{ ctl.logAttachBlockedCount }} 条已被占用（灰显，不可选）
        </span>
        <span class="la-grow"></span>
        <button class="ghost" title="把当前筛选出来的可绑定日志全部勾上（最多 20 条）"
          @click="ctl.selectAllLogAttachFiltered">全选筛选结果</button>
        <button class="ghost" @click="ctl.clearLogAttachPick">清空已选</button>
      </div>
      <div class="la-list">
        <label v-for="row in ctl.logAttachRows" :key="'la-' + row.log.id" class="la-row"
          :class="{ picked: row.picked, blocked: row.blocked }">
          <input type="checkbox" :checked="row.picked" :disabled="row.blocked"
            @change="ctl.toggleLogAttachPick(row.log.id)" />
          <span class="log-status-badge" :class="ctl.logStatusClass(row.log)">{{ ctl.logStatusLabel(row.log) }}</span>
          <span v-if="row.log.priority" class="log-prio-badge" :class="'lp-' + ctl.logPrioKey(row.log.priority)"
            :title="'优先级：' + ctl.localPriority(row.log.priority)">{{ ctl.localPriority(row.log.priority) }}</span>
          <span class="la-text">
            <span class="la-title">{{ row.log.title || row.log.id }}</span>
            <span class="la-sub">
              <span>{{ row.log.project || '未归属' }}</span>
              <span v-if="row.log.agentName">🤖 {{ row.log.agentName }}</span>
              <span>{{ ctl.formatDate(row.log.created) }}</span>
              <span class="la-id">{{ row.log.id }}</span>
            </span>
          </span>
          <span v-if="row.blocked" class="la-blocked">{{ row.reason }}</span>
          <span v-else-if="row.picked" class="la-picked">已选</span>
        </label>
        <div v-if="!ctl.logAttachRows.length" class="la-empty">
          没有符合条件的日志。换个关键词 / 放宽日期，或点“清空筛选”看全部。
          <template v-if="ctl.logAttachBlockedCount">（另有 {{ ctl.logAttachBlockedCount }} 条被占用，勾“显示已占用”可查看原因）</template>
        </div>
      </div>
      <div class="acts">
        <span class="la-count">
          已选 {{ ctl.logAttachPick.length }} / 20 条<template v-if="ctl.logAttachPickedOutside">（{{ ctl.logAttachPickedOutside }} 条不在当前筛选内）</template>
        </span>
        <button class="ghost" @click="ctl.logAttachTarget = null">取消</button>
        <button class="ok" :disabled="ctl.logAttachBusy || ctl.logAttachPick.length > 20" @click="ctl.saveLogAttach">{{ ctl.logAttachBusy ? '保存中…' : '保存绑定' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点 */
const logAttachCtl = ctl
</script>
