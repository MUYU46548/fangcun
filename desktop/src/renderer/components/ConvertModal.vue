<!--
  日志 ⇄ 待办 转换确认（2026-11-02 · App.vue 后三刀第一刀「浮层」续）

  **边界**：只搬模板。状态与动作仍在 `useLogConvert`，父组件用 `convertCtl` 转接。
  ⚠ 遮罩用 `@mousedown.self`（不是 `@click.self`）—— 拖选文字滑出弹窗时不许被当成“点了遮罩”。
-->
<template>
  <div v-if="ctl.convAsk_" class="overlay" @mousedown.self="ctl.convAsk_ = null">
    <div id="conv-modal">
      <h3>{{ ctl.convAsk_.kind === 'log2todo' ? '日志 → 待办' : '待办 → 日志' }}</h3>
      <div class="conv-src">源：{{ ctl.convAsk_.kind === 'log2todo' ? '日志' : '待办' }}“{{ ctl.convAsk_.src.title || ctl.convAsk_.src.id }}”</div>
      <div class="hint">会新建一条{{ ctl.convAsk_.kind === 'log2todo'
        ? '待办（首行取“下一步”首条 —— 是（待填写）这类占位就改用日志标题；日志正文与下一步会一起带过去，项目/优先级跟着走）'
        : '日志（标题/项目/优先级带过去，到期压进正文首行）' }}；同一条只转一次。</div>
      <label class="conv-opt">
        <input type="checkbox" v-model="ctl.convAsk_.archive" />
        <span>顺手把源{{ ctl.convAsk_.kind === 'log2todo' ? '归档' : '标“已转出”' }}
          <i>{{ ctl.convAsk_.kind === 'log2todo'
            ? '源日志移入“已归档”分区（列表不再重复，随时可找回）'
            : '源待办折叠进“已转出”（不是删除，展开可看可撤销）' }}</i></span>
      </label>
      <div class="hint conv-default">不勾 = 源原样保留，两边都看得见。</div>
      <div class="acts">
        <button class="ghost" @click="ctl.convAsk_ = null">取消</button>
        <button class="pri" @click="ctl.runConvert">转换</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点：convertCtl 的键必须与 App.vue 里同名控制器一致 */
const convertCtl = ctl
</script>
