<!--
  规划管理（2026-11-02 · App.vue 后三刀第一刀「浮层」续）

  **边界**：只搬模板。三条通道 / 列表 / 详情 / 决策留痕仍在 App.vue，父组件用 `plansCtl` 转接。
  决策点选定即留痕（选项+时间落任务文件）；再点其他选项=改选，留痕覆盖（decidedAt 刷新）。
-->
<template>
  <div v-if="ctl.plansModal" class="overlay" @mousedown.self="ctl.closePlans()">
    <div id="plans-modal">
      <h3>规划 · {{ ctl.plansModal.name }}</h3>

      <!-- 列表态 -->
      <div v-if="!ctl.planDetail && !ctl.planCreating">
        <div class="hint" v-if="ctl.planListBusy">读取中…</div>
        <div class="hint" v-else-if="!ctl.planList.length">
          这个项目还没有规划——点下面“＋ 新建规划”：目标、里程碑、要决定的决策点一次写清，
          决策点逐个选定后规划自动转“进行中”。
        </div>
        <div class="plan-row" v-for="t in ctl.planList" :key="t.fm.id" :data-plan-id="t.fm.id">
          <div class="plan-row-main">
            <b>{{ t.fm.title }}</b>
            <span class="plan-badge" :data-plan-status="t.fm.plan_status || 'draft'">{{ ctl.planStatusLabel(t.fm.plan_status) }}</span>
          </div>
          <button class="ghost" @click="ctl.openPlanDetail(t.fm.id)">看决策点 →</button>
        </div>
      </div>

      <!-- 详情态：决策点选择+留痕+回看 -->
      <div v-else-if="ctl.planDetail">
        <div class="hint" v-if="ctl.planDetail.plan.objective">目标：{{ ctl.planDetail.plan.objective }}</div>
        <div v-if="ctl.planDetail.plan.milestones.length">
          <div class="ms-suggest-h">里程碑</div>
          <div v-for="(m, i) in ctl.planDetail.plan.milestones" :key="'pm' + i">· {{ m.name }}<template v-if="m.deadline">（{{ m.deadline }}）</template></div>
        </div>
        <div class="plan-dp" v-for="dp in ctl.planDetail.plan.decisions" :key="dp.id" :data-dp-id="dp.id">
          <div class="plan-dp-q">{{ dp.question }}</div>
          <div class="hint" v-if="dp.status !== 'pending'">
            ✓ 已选：<b>{{ dp.chosen }}</b>（{{ ctl.planWhen(dp.decidedAt) }}）——再点其他选项=改选，留痕覆盖
          </div>
          <div class="plan-dp-opts">
            <button v-for="op in dp.options" :key="op" class="ghost"
                    :class="{ pri: dp.chosen === op }" @click="ctl.decideDp(dp, op)">{{ op }}</button>
          </div>
        </div>
        <div class="hint hint-warn" v-if="!ctl.planDetail.plan.decisions.length">这条规划没有决策点。</div>
        <div class="hint" v-else-if="ctl.planDetail.plan.decisions.every(d => d.status !== 'pending')">
          决策点全定完——规划已自动转“进行中”，选择留痕都记在任务卡里。
        </div>
      </div>

      <!-- 表单态：新建规划 -->
      <div v-else>
        <label>规划标题 *</label>
        <input v-model="ctl.planForm.title" placeholder="例：0.3.7 发版计划" />
        <label>目标（可空）</label>
        <input v-model="ctl.planForm.objective" placeholder="例：把启动台三件事收口并发 0.3.7" />
        <label>里程碑（每行一条，可空；格式 名称|截止，截止可省）</label>
        <textarea v-model="ctl.planForm.milestones" rows="2" placeholder="设计稿定稿|2026-10-20&#10;发版"></textarea>
        <template v-for="(dp, i) in ctl.planForm.dps" :key="'dpf' + i">
          <label>决策点 {{ i + 1 }} · 要决定的问题 *</label>
          <input v-model="dp.question" placeholder="例：端口模型走哪版？" />
          <label>选项（每行一个）*</label>
          <textarea v-model="dp.options" rows="2" placeholder="端口=配置项&#10;端口=观测结果"></textarea>
          <button class="ghost" v-if="ctl.planForm.dps.length > 1" @click="ctl.planForm.dps.splice(i, 1)">删这条决策点</button>
        </template>
        <button class="ghost" @click="ctl.planForm.dps.push({ question: '', options: '' })">＋ 加决策点</button>
      </div>

      <div class="acts">
        <button class="ghost" @click="ctl.closePlans()">关闭</button>
        <button class="ghost" v-if="ctl.planDetail" @click="ctl.backPlanList()">← 回列表</button>
        <button class="pri" v-if="!ctl.planDetail && !ctl.planCreating" @click="ctl.startPlanCreate()">＋ 新建规划</button>
        <button class="pri" v-else-if="ctl.planCreating" :disabled="!ctl.planForm.title.trim()" @click="ctl.submitPlan()">建规划</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点 */
const plansCtl = ctl
</script>
