<template>
<div id="policy-overlay" class="overlay" v-if="ctl.policyEdit_" @mousedown.self="ctl.closePolicyEditor()">
  <div id="policy-modal">
    <h3>项目方针：{{ ctl.policyEdit_.name }}</h3>
    <!-- 2026-11-14 整块拆掉「核心判词」——
         暮雨原话：「判词未通过，而且这堆东西貌似从来意义不大，反正根本看不懂」。
         他说得对，而且病根很具体：这套东西把"这个项目值不值得往上堆内容"
         包装成「立得住 / 能玩 / 垃圾 / 未判」四个档位按钮，还要人先理解它控制的是
         **AI 出计划时能不能铺 4-5 小时的内容量** —— 那是一层没人要求过的抽象管理概念。
         拆掉之后：数据字段保留（`coreVerdict` 仍在方针卡里，不填就是未判），
         contentScale 闸对自己保守——**他不必理解它，也不必看见它**。 -->
    <!-- 2026-11-14（长 Loop P1-2）：14 个项目里 7 个使命是空的，
         但其中 5 个的 README 里**已经写清了**——病根是"方寸从没去读项目现实"。
         这里给一个「从 README 取一句」的按钮：点一下把原文那句话填进来，你再改。
         ⚠ 只是**填进输入框**，不保存；不点保存什么都不写。
         ⚠ 草稿逐字来自 README（不改写），并把原文显示出来供核对。
         ⚠⚠ **按钮必须在 `<label>` 外面**：放进 label 里时，浏览器把点击当成
           "点了这个 label" 并转发给关联的表单控件，按钮自身的 click 就收不到
           （2026-11-14 实测：`.click()` 与 `dispatchEvent` 都触发不了，
            断言里 `afterClick=0 afterDispatch=0` 就是这个原因）。 -->
    <div class="pf-mission-row">
      <label>使命（一句话：这项目是干嘛的）</label>
      <Button v-if="missionDraftBtnVisible" variant="ghost" size="sm" class="pf-mission-draft"
        :title="missionDraftHint" @click="ctl.draftMissionNow()">📄 从 README 取一句</Button>
    </div>
    <textarea v-model="ctl.policyEdit_.mission" placeholder="例：本地优先的多 agent 任务调度台"></textarea>
    <!-- 草稿取回来之后把**原文**摆出来：让人一眼能核"它有没有被改写过" -->
    <div v-if="ctl.policyEdit_.__missionSource" class="pf-mission-src">
      <span class="pf-mission-src-tag">摘自 {{ ctl.policyEdit_.__missionSourceFile }}</span>
      <span class="pf-mission-src-text">{{ ctl.policyEdit_.__missionSource }}</span>
    </div>
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
 *
 * 2026-11-14：删掉「核心判词」四档选择器后，本组件不再需要任何判词逻辑
 *（`verdictPicked` / `pickVerdict` / 提示文案全部移除）。
 * ⚠ `coreVerdict` 字段**仍在数据里**（方针卡照旧带着它），保存时由 App.vue 原样透传 —— 
 *   界面不显示不等于数据要丢（已写的判词不许因为拆界面而消失）。
 */
import { computed } from 'vue'
import Button from './ui/Button.vue'
import { isMissionEmpty } from '../../shared/missionDraft'

const props = defineProps<{ ctl: any }>()

/** 使命为空时才给「从 README 取一句」——已写了自己东西的不该被建议覆盖 */
const missionDraftBtnVisible = computed(() => isMissionEmpty(props.ctl?.policyEdit_?.mission))
const missionDraftHint = computed(() => {
  const p = props.ctl?.policyEdit_
  const repo = String(p?.repo || '')
  return repo
    ? `从 ${repo} 的 README 里取一句原文填进来（不保存，你可以再改）`
    : '这个项目没登记工作目录，读不到 README —— 得你自己写一句'
})
</script>
