<template>
<div id="policy-overlay" class="overlay" v-if="ctl.policyEdit_" @mousedown.self="ctl.closePolicyEditor()">
  <div id="policy-modal">
    <h3>项目方针：{{ ctl.policyEdit_.name }}</h3>
    <!-- 核心判词（2026-11-12）：放在**最顶上**，因为它是所有别的判断的前提。
         暮雨原话「没有任何人能回答我离达到我的期望到底还有多远」—— 原因是
         从来没有任何一个字段记过"他认为这东西现在什么水平"。这里就是那个字段。
         ⚠ 它不是分数、不是百分比：四档一句话，写完 10 秒。 -->
    <label>
     核心判词（这项目的核心玩法/核心用途，现在立不立得住）
      <span class="pf-label-hint">未判 = 方寸只许做最小原型（0.5 小时 / 1 幕 / 1 间房），不许铺内容量</span>
    </label>
    <div class="pf-verdict-picks">
      <Button v-for="v in VERDICT_PICKS" :key="v.k" type="button"
        :variant="verdictPicked === v.k ? 'primary' : 'ghost'" size="sm"
        class="pf-vpick" :class="{ on: verdictPicked === v.k }" @click="pickVerdict(v.k)"
        :title="v.hint">{{ v.label }}</Button>
    </div>
    <textarea class="tall" v-model="ctl.policyEdit_.coreVerdict"
      placeholder="点上面一个档位，或直接写。&#10;例：垃圾 —— 那两间房纯属垃圾，玩法本身撑不住这么大内容量，2026-11-12&#10;例：能玩 —— 装配台那 5 分钟确实是游戏，2026-11-12"></textarea>
    <div class="pf-map-tip" style="margin:-4px 0 8px">
      判词会被内容量闸读走：判「垃圾」或「未判」时，方寸拒绝一切超过最小原型的阶段卡。
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

const props = defineProps<{ ctl: any }>()

/**
 * 判词四档（2026-11-12）。点一下就填好开头，不用人措辞 ——
 * 人要写的东西越少，越可能真去写。
 */
const VERDICT_PICKS = [
  { k: '立得住', label: '立得住', hint: '核心玩法/用途已经验证过，可以往上铺内容量' },
  { k: '能玩', label: '能玩', hint: '能玩但不惊艳，先按这个基准往前推' },
  { k: '垃圾', label: '垃圾', hint: '这个方向不行 —— 铺多少内容都是白费，方寸会锁死该方向的扩量' },
  { k: '未判', label: '未判（清空）', hint: '还没看过/还不确定。方寸只许做最小原型' },
]

/** 当前文本开头是哪个档位（用来点亮按钮；不强制格式） */
const verdictPicked = computed<string>(() => {
  const t = String(props.ctl?.policyEdit_?.coreVerdict || '').trim()
  if (!t) return '未判'
  for (const v of VERDICT_PICKS) {
    if (v.k !== '未判' && t.startsWith(v.k)) return v.k
  }
  return ''
})

/** 点档位 = 把开头换成该词，**保留已写的理由**（不整段覆盖掉人写的话） */
function pickVerdict(k: string): void {
  const cur = String(props.ctl?.policyEdit_?.coreVerdict || '').trim()
  if (k === '未判') {
    props.ctl.policyEdit_.coreVerdict = ''
    return
  }
  // 去掉旧的档位前缀，留下「—— 理由」那部分
  const rest = cur.replace(/^(立得住|能玩|垃圾|未判)\s*/, '').replace(/^[—\-–]+\s*/, '').trim()
  const today = new Date().toISOString().slice(0, 10)
  props.ctl.policyEdit_.coreVerdict = rest
    ? `${k} —— ${rest}`
    : `${k} —— （一句话理由）${today}`
}
</script>
