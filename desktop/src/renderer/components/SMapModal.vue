<!--
  结构地图一览（2026-11-02 · App.vue 后三刀第一刀「浮层」续）

  **边界**：只搬模板。`smapOpen` / `smapRows` / `openPolicyFromSmap` 仍在 App.vue，
  父组件用 `smapCtl` 转接 —— 不复制任何推导。
-->
<template>
  <div id="smap-overlay" class="overlay" v-if="ctl.smapOpen" @mousedown.self="ctl.smapOpen = false">
    <div id="smap-modal">        <h3>🗺 结构地图 <span class="smap-sub">模块清单 + 每模块一句话职责 + 主数据流</span></h3>
      <p class="smap-hint">
        <b>结构地图专供 agent 施工参考。</b>
        它进 MCP 的 <code>project_charter</code>：agent 先知道“谁连谁、数据从哪到哪”，才不用满仓库瞎找。
        你要保证的只有一件事：<b>日期别过期</b>。第一行必须是<b>最后核实日期</b> ——
        超过 90 天、或者没写日期，agent 会看到“已过期”标记，就不知道该不该信这份地图。
        内容由 agent 起草、你过目。
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
              <!-- 2026-11-08：AI 只能提议，签字是你的 —— 所以“有几张在等你”必须在这里说出来 -->
              <button v-if="row.pending" class="smap-pending" @click.stop="ctl.openMapProposal(row.id)">
                ⏳ {{ row.pending }} 张提议等你签字
              </button>
            </div>
            <!-- 2026-11-08：结构大改也会让地图失效（新增/删掉模块目录）—— 理由直接写在这里，
                 否则行上只写“最后核实 · X 月 X 日”，看不出它为什么已经不能信了。 -->
            <div v-if="row.staleReason" class="smap-meta smap-drift" :title="row.staleReason">⚠ {{ row.staleReason }}</div>
          </div>
          <Button class="smap-open" variant="ghost" size="tool" @click="ctl.openPolicyFromSmap(row.id)">
            {{ row.has && row.verified ? '查看 / 编辑' : row.hasPolicy ? '去填' : '先立方针卡' }}
          </Button>
        </div>
        <div v-if="!ctl.smapRows.length" class="hint">还没有登记项目</div>
      </div>
      <div class="acts">
        <Button variant="ghost" size="tool" @click="ctl.smapOpen = false">关闭</Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import Button from './ui/Button.vue'
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点 */
const smapCtl = ctl
</script>
