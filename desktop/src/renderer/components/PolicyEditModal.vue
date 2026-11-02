<template>
<div id="policy-overlay" class="overlay" v-if="ctl.policyEdit_" @mousedown.self="ctl.closePolicyEditor()">
  <div id="policy-modal">
    <h3>项目方针：{{ ctl.policyEdit_.name }}</h3>
    <label>使命（一句话：这项目是干嘛的）</label>
    <textarea v-model="ctl.policyEdit_.mission" placeholder="例：本地优先的多 agent 任务调度台"></textarea>
    <label>当前目标（本阶段要达成什么 + 怎么算完成）</label>
    <textarea v-model="ctl.policyEdit_.goal" placeholder="例：稳定可用、承接真实业务数据"></textarea>
    <label>应用场景（给谁用、在哪用）</label>
    <textarea v-model="ctl.policyEdit_.scenario" placeholder="例：个人，桌面日常使用"></textarea>
    <label>方针边界（怎么干、不干什么）</label>
    <textarea v-model="ctl.policyEdit_.boundary" placeholder="例：元层铁律——永不内置模型能力；Agent 层归外部专家团"></textarea>
    <!-- 029：结构地图此前**只存在于文件里**，界面上完全看不到 —— 用户验收驳回原话
         “找不到在哪里”。这里把它变成一个能看能改的普通小节（不再需要手工翻文件）。 -->
    <label>
      结构地图（模块清单 + 每模块一句话职责 + 主数据流）
      <span class="pf-label-hint">第一行必须是“&gt; 最后核实：YYYY-MM-DD”——烂地图比没地图危险，因为读者不知道它烂</span>
    </label>
    <textarea class="tall" v-model="ctl.policyEdit_.structureMap"
      placeholder="&gt; 最后核实：2026-09-28&#10;- 模块清单：…&#10;- 主数据流：数据从哪来 → 经过谁 → 落到哪 → 谁读它"></textarea>
    <div class="pf-map-tools">
      <button class="ghost" type="button" @click="ctl.stampStructureMap()" title="把“最后核实”那行改成今天 —— 你刚确认过内容仍然成立">✓ 标记今天已核实</button>
      <span class="pf-map-tip">改动只写方针卡；派活时它会随任务书下发（不内联全文，只指路）</span>
    </div>
    <div class="acts">
      <button class="ghost" @click="ctl.closePolicyEditor()">取消</button>
      <button class="pri" @click="ctl.savePolicyEdit">保存方针卡</button>
    </div>
  </div>
</div>
</template>

<script setup lang="ts">
/**
 * 项目方针编辑（2026-11-02 · App.vue 后三刀第一刀「浮层」）
 * 只搬模板：状态与动作仍住 App.vue，经 ctl 转接；ctl.policyEdit_ 的 v-model 直接写回 reactive 代理。
 */
defineProps<{ ctl: any }>()
</script>
