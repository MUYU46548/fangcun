<!--
  结构地图一览（2026-11-02 · App.vue 后三刀第一刀「浮层」续）

  **边界**：只搬模板。`smapOpen` / `smapRows` / `openPolicyFromSmap` 仍在 App.vue，
  父组件用 `smapCtl` 转接 —— 不复制任何推导。
-->
<template>
  <div id="smap-overlay" class="overlay" v-if="ctl.smapOpen" @mousedown.self="ctl.smapOpen = false">
    <div id="smap-modal">        <h3>🗺 结构地图 <span class="smap-sub">模块清单 + 每模块一句话职责 + 主数据流</span></h3>
      <p class="smap-hint">
        每张方针卡里有一个“结构地图”小节。第一行必须是<b>最后核实日期</b>——
        烂地图比没地图危险，因为读者不知道它烂。内容由 agent 起草、你过目。
      </p>
      <div class="smap-list">
        <div v-for="row in ctl.smapRows" :key="row.id" class="smap-item"
          :class="{ done: row.has, missing: !row.has, nopolicy: !row.hasPolicy }">
          <span class="smap-dot"></span>
          <div class="smap-main">
            <div class="smap-name">{{ row.name }}</div>
            <div class="smap-meta">
              <template v-if="!row.hasPolicy">连方针卡都还没立</template>
              <template v-else-if="!row.has">方针卡在，但没有结构地图</template>
              <template v-else-if="row.verified">最后核实 · {{ row.verified }}</template>
              <template v-else>有结构地图，但没写最后核实日期</template>
            </div>
          </div>
          <button class="ghost smap-open" @click="ctl.openPolicyFromSmap(row.id)">
            {{ row.has && row.verified ? '查看 / 编辑' : row.hasPolicy ? '去填' : '先立方针卡' }}
          </button>
        </div>
        <div v-if="!ctl.smapRows.length" class="hint">还没有登记项目</div>
      </div>
      <div class="acts">
        <button class="ghost" @click="ctl.smapOpen = false">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点 */
const smapCtl = ctl
</script>
