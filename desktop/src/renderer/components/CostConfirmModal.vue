<!--
  花钱动作确认（2026-11-20 · 暮雨：「所有会调用外部agent产生真实费用的按钮…
  首次点击弹窗提示（可在设置中关闭，防止新手误触）」）

  **边界**：只讲清楚"这一步会花钱"并给取消出口；真正的调用/冷却/落卡仍在 App.vue。
  ⚠ 遮罩必须 `@mousedown.self`：弹窗里有 checkbox，拖选滑出遮罩不许误关。
  ⚠ 本组件的类名只复用全局 `.overlay/.hint/.chk/.acts`，不新增手搓按钮类
    （check-ui-freeze 会扫；新增 class 要登记理由，这里没必要）。
-->
<template>
  <div v-if="ctl.costAskForm" class="overlay" @mousedown.self="ctl.finishCostAsk(false)">
    <div id="cost-confirm-modal">
      <h3>{{ ctl.costAskForm.title }}</h3>
      <p class="hint">{{ ctl.costAskForm.detail }}</p>
      <div class="hint hint-warn">
        ⚠ 这会调用外部模型 / 开一个 DSH 会话，可能产生真实费用。方寸不预置端点、不代收费用；
        花销由你与模型服务方结算。
      </div>
      <label class="chk" title="关掉后可在 设置 → 通用 →「花钱动作前确认」重新打开">
        <input type="checkbox" v-model="ctl.costAskForm.noMore" />
        以后不再提示（可在设置里重新打开）
      </label>
      <div class="acts">
        <Button variant="ghost" size="tool" @click="ctl.finishCostAsk(false)">取消</Button>
        <Button variant="primary" size="tool" @click="ctl.finishCostAsk(true)">{{ ctl.costAskForm.confirmText }}</Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import Button from './ui/Button.vue'
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
</script>
