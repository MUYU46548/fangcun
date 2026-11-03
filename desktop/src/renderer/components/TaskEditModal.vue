<!--
  任务编辑 / 新建（2026-11-02 · App.vue 后三刀第一刀「浮层」收尾）

  **边界**：只搬模板。字段 spec（主进程下发）、阻塞挑选、批次候选、历史版本仍在 App.vue，
  父组件用 `taskEditCtl` 转接 —— 字段集合与保存逻辑一个字没搬。
  ⚠ 阻塞不再手填 ID：输入即筛（标题 / ID 都认），不输入时只露最近 8 张。
  ⚠ 隐藏字段 ≠ 丢值：`saveEdit` 仍按全量 spec 收集，这里只管显示不显示。
-->
<template>
  <div id="modal-overlay" class="overlay" v-if="ctl.editTask_" @mousedown.self="ctl.closeTaskEditor()">
    <div id="modal" class="task-modal">
      <h3>{{ ctl.editTask_.id ? '编辑任务' : '新建任务' }}</h3>
      <!-- 2026-10-31（暮雨第 2 条“感觉很难填写”）：先把"最少要填什么"说清，
           免得一屏十几个框看着像必须全填。 -->
      <div class="tf-lead">只填<b>标题</b>就能建卡；其余留空不影响任何东西。每个框下面都写清它到底影响什么。</div>
      <div class="tf-grid">
        <div
          v-for="spec in ctl.visibleFieldSpecs"
          :key="spec.key"
          class="tf-field"
          :class="spec.span === 'full' ? 'tf-full' : 'tf-half'"
        >
          <label>{{ spec.label }}</label>

          <!-- 阻塞：不让用户手填任务 ID（现实里没人会去看 ID，更不会记得），
               改成跟随所选项目、点选即可的挑选器。 -->
          <template v-if="spec.key === 'blockers'">
            <div class="blk-picked">
              <span v-for="id in ctl.blockerList" :key="id" class="blk-chip">
                {{ ctl.taskTitleById(id) }}
                <button class="blk-x" title="移除" @click="ctl.removeBlocker(id)">×</button>
              </span>
              <span v-if="!ctl.blockerList.length" class="blk-empty">未设置依赖</span>
            </div>
            <!-- 2026-10-31 第二轮（暮雨：“和附属日志一样的问题，毫无筛选能力，一堆列表拉出来”）：
                 原来是一个装 300 项的原生 <select>，找一张卡要滚半天。改成**搜索优先**：
                 输入即筛（标题/ID 都认），不输入时只露最近 8 张，并说清"从哪来的"。
                 原生 select 在几百项时没有搜索框，这是系统控件的硬伤，不是样式问题。 -->
            <input class="blk-search" v-model="ctl.blockerQuery" spellcheck="false"
              placeholder="搜标题或 ID（只列当前项目的任务）" />
            <div class="blk-results">
              <button v-for="t in ctl.blockerPickList" :key="'bp-' + t.id" type="button" class="blk-hit"
                @click="ctl.pickBlocker(t.id)">
                <span class="blk-hit-t">{{ t.title || '(无标题)' }}</span>
                <span class="blk-hit-id">{{ t.id }}</span>
                <span class="blk-hit-s">{{ t.status || '—' }}</span>
              </button>
              <div v-if="!ctl.blockerPickList.length" class="blk-none">
                {{ ctl.blockerQuery.trim() ? '没搜到 —— 换个词，或先把这个任务的项目改对' : '当前项目还没有可挑的任务' }}
              </div>
              <div v-else-if="!ctl.blockerQuery.trim() && ctl.blockerCandidates.length > ctl.blockerPickList.length" class="blk-more">
                还有 {{ ctl.blockerCandidates.length - ctl.blockerPickList.length }} 张没列 —— 输入标题或 ID 直接筛
              </div>
            </div>
          </template>

          <select v-else-if="spec.type === 'select'" v-model="ctl.editTask_[spec.key]">
            <option v-for="o in ctl.specOptions(spec)" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>

          <!-- 2026-10-31 第二轮（暮雨：“批次从来没被有效利用，每次都自己瞎编，最后越来越乱”）：
               批次框改成**带候选**的输入框 —— 已存在的批次名直接可选，想新造仍然可以打。
               路线图只认名字相同的一批，所以"顺手变成一个新的"才是乱源。 -->
          <template v-else-if="spec.key === 'batch'">
            <input v-model="ctl.editTask_[spec.key]" list="fc-batch-options" :placeholder="spec.placeholder || ''" />
            <datalist id="fc-batch-options">
              <option v-for="b in ctl.batchOptions" :key="'bt-' + b" :value="b"></option>
            </datalist>
          </template>

          <textarea
            v-else-if="spec.type === 'textarea'"
            v-model="ctl.editTask_[spec.key]"
            :class="{ tall: spec.key === 'body' }"
            :placeholder="spec.placeholder || ''"
          ></textarea>

          <input v-else v-model="ctl.editTask_[spec.key]" :placeholder="spec.placeholder || ''" />

          <div v-if="spec.hint" class="tf-hint">{{ spec.hint }}</div>
        </div>
      </div>
      <!-- 历史版本（2026-10-18 卡 001；2026-10-31 收口）：把 atomicWrite 本来就在写的
           .backup 接出来 —— 看见列表、逐版预览、恢复任意一版。恢复前会自动备份当前版。 -->
      <div v-if="ctl.editTask_.id" class="ver-sect">
        <button class="ghost ver-toggle" @click="ctl.toggleTaskHistory">
          🕘 历史版本<span v-if="ctl.taskVersions.length"> · {{ ctl.taskVersions.length }}</span>
        </button>
        <div v-if="ctl.taskHistoryOpen" class="ver-panel">
          <div class="ver-head">
            <b>这张卡的历史版本</b>
            <span class="ver-sub">本机最近 10 版；恢复前会把当前版再备份一次</span>
            <button class="ver-x" title="收起" @click="ctl.taskHistoryOpen = false">×</button>
          </div>
          <div v-if="ctl.taskVersionBusy" class="ver-empty">读取中…</div>
          <div v-else-if="!ctl.taskVersions.length" class="ver-empty">没有历史版本（本机只留最近 10 版，更早的要靠整包备份）</div>
          <div v-else class="ver-list">
            <div v-for="v in ctl.taskVersions" :key="v.file" class="ver-row" :class="{ on: ctl.taskVersionPreview?.file === v.file }">
              <button class="ver-main" @click="ctl.previewTaskVersion(v)">
                <span class="ver-title">{{ v.title || '(无标题)' }}</span>
                <span class="ver-meta">{{ v.at ? ctl.formatDateTime(v.at) : '时间不详' }} · {{ ctl.versionSizeText(v.size) }} · {{ v.status || '状态未知' }}</span>
              </button>
              <button class="ver-restore" @click="ctl.restoreTaskVersionItem(v)">恢复</button>
            </div>
          </div>
          <pre v-if="ctl.taskVersionPreview" class="ver-preview">{{ ctl.taskVersionPreview.content }}</pre>
        </div>
      </div>
      <div class="acts">
        <button class="ghost" @click="ctl.closeTaskEditor()">取消</button>
        <button class="pri" @click="ctl.saveEdit">保存</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点 */
const taskEditCtl = ctl
</script>
