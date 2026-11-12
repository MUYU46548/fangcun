<template>
<div id="policy-overlay" class="overlay" v-if="ctl.policyEdit_" @mousedown.self="ctl.closePolicyEditor()">
  <div id="policy-modal">
    <h3>项目方针：{{ ctl.policyEdit_.name }}</h3>
    <!-- 核心判词（2026-11-12）。暮雨：「这种东西填了真的有用吗？我觉得全不填都行」
         —— 这句是对的，所以**默认不填**：空着照样能用，方寸按最保守（只许最小原型）处理。
         只有当你真想让它往上铺内容量时，才需要在这里说一句。
         ⚠ 词表在 shared/coreVerdict（唯一真源），这里一个词都不许写死。 -->
    <label>
      核心判词（可选 —— 不填也不影响别的，只是方寸会保守地只做最小原型）
      <span class="pf-label-hint">点一个档位就行，一句话可写可不写</span>
    </label>
    <div class="pf-verdict-picks">
      <Button v-for="v in VERDICT_LEVELS" :key="v.key" type="button" class="pf-vpick"
        :variant="verdictPicked === v.key ? 'primary' : 'ghost'" size="sm"
        @click="pickVerdict(v.key)" :title="v.hint">{{ v.label }}</Button>
    </div>
    <input v-model="ctl.policyEdit_.coreVerdict" class="pf-verdict-input"
      :placeholder="verdictPlaceholder" />
    <div class="pf-map-tip">
      填「{{ SCALE_OK_KEYS[0] }}」或「{{ SCALE_OK_KEYS[1] }}」= 允许往上铺内容量；
      空着或用「{{ UNJUDGED }}」= 只许最小原型。
    </div>
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
import { computed } from 'vue'
import Button from './ui/Button.vue'
import {
  VERDICT_LEVELS, UNJUDGED, SCALE_OK_KEYS,
  parseVerdict, composeVerdict,
} from '../../shared/coreVerdict'

const props = defineProps<{ ctl: any }>()

/** 当前输入框里是哪个档位（点亮按钮用；不强制格式） */
const verdictPicked = computed<string>(() => {
  const t = String(props.ctl?.policyEdit_?.coreVerdict || '').trim()
  if (!t) return UNJUDGED
  const { level } = parseVerdict(t)
  return level || ''
})

const verdictPlaceholder = computed(() => {
  const ex = VERDICT_LEVELS.find((v) => v.allowsScale)
  return `不填也行。要填就点上面，或直接写一句，例：${ex ? ex.key : ''} —— 哪几分钟确实是游戏`
})

/** 点档位 = 换掉档位词，**保留已写的理由**（不整段覆盖掉人写的话） */
function pickVerdict(key: string): void {
  const cur = String(props.ctl?.policyEdit_?.coreVerdict || '').trim()
  const { reason } = parseVerdict(cur)
  const today = new Date().toISOString().slice(0, 10)
  props.ctl.policyEdit_.coreVerdict = composeVerdict(key, reason, today)
}
</script>
