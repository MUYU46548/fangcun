<!--
  日志只读预览弹窗（2026-10-31 · 渲染层拆分“浮层刀”第五块）

  **边界**：只显示 + 收集意图；状态与动作留在 App。父组件 `v-if="logPreview"`。
  ⚠ 这个弹窗要能在任何视图下打开（任务详情里点关联日志），不能放进 LogsView。
-->
<template>
  <div v-if="logPreview" class="overlay" @mousedown.self="logPreview = null">
    <div id="log-preview-modal">
      <h3>
        <span class="log-status-badge" :class="logStatusClass(logPreview)">{{ logStatusLabel(logPreview) }}</span>
        {{ logPreview.title || '(无标题)' }}
      </h3>
      <div class="lp-meta">
        <span class="log-id" title="日志 ID —— 点一下复制，贴给 AI 就能精确定位这一条"
          @click="copyId(logPreview.id)">⧉ {{ logPreview.id }}</span>
        <span v-if="logPreview.project">{{ (projects.find(p => p.id === logPreview.project)?.name) || logPreview.project }}</span>
        <span v-if="logPreview.taskId">📍 {{ logPreview.taskId }}</span>
        <span v-if="logPreview.agentName">🤖 {{ logPreview.agentName }}</span>
        <span>{{ formatDateTime(logPreview.created) }}</span>
        <span v-if="logPreview.completed">✓ {{ formatDateTime(logPreview.completed) }}</span>
      </div>
      <label>执行内容</label>
      <div class="body-text markdown" v-html="renderBody(logPreview.content)"></div>
      <template v-if="logPreview.nextSteps">
        <label>下一步</label>
        <div class="body-text markdown" v-html="renderBody(logPreview.nextSteps)"></div>
      </template>

      <!-- 附件（2026-10-01 用户第 1 条 → 卡 036）：日志 ↔ 文件的唯一入口。
           图片就地内联（走 logs:attachmentData 的 data URL，不碰 file:// 权限），
           其它类型给“用系统程序打开”；移除只解除关联，文件仍留在数据目录。 -->
      <div class="attach-block" data-attach-block>
        <div class="attach-head">
          <label class="attach-lbl">附件</label>
          <Button class="attach-add" variant="ghost" size="sm" @click="attachAdd(logPreview.id)">＋ 添加文件…</Button>
        </div>
        <div v-if="!logPreview.attachments || !logPreview.attachments.length" class="attach-empty">
          还没有附件 —— 截图、分析报告、日志文件都可以挂上来（文件会复制进数据目录，随日志一起备份）
        </div>
        <div v-else class="attach-grid">
          <div class="attach-item" v-for="a in logPreview.attachments" :key="a">
            <img v-if="isImageRel(a) && attachSrc(a)" :src="attachSrc(a)" :alt="attachName(a)"
              :title="attachName(a) + ' · ' + attachOpenHint(a)" @click.stop="attachOpen(a)" />
            <div v-else class="attach-file" :title="a + ' · ' + attachOpenHint(a)" @click.stop="attachOpen(a)">📄 {{ attachName(a) }}</div>
            <div class="attach-cap">
              <span class="attach-fn" :title="a">{{ attachName(a) }}</span>
              <button class="attach-x" title="解除关联（文件保留，不删）"
                @click.stop="attachRemove(logPreview.id, a)">✕</button>
            </div>
          </div>
        </div>
      </div>

      <div class="acts">
        <!-- ⚠ 2026-11-17 暮雨：「按钮颜色消失，看不清，好像整个按钮都消失了。」
             真因不是配色，是**这个按钮压根没穿衣服**：
             它是这一行里唯一手搓的 `<button class="ghost">`（另两枚是基座 Button）。
             而全局有 `.acts button { border: 0; padding: 6px 14px; … }`（特异性 0,1,1），
             压过了兜底规则 `:where(button.ghost){ border: 1px solid … ; background:#fff }`（0,1,0）。
             于是它变成**透明底 + 无边框** —— 在白色弹窗上就是"看不见"。
             改法：用基座 Button（与旁边两枚同源），class 冲突整类消失。 -->
        <Button variant="ghost" size="tool" @click="openLogFromPreview">✏️ 编辑</Button>
        <Button variant="ghost" size="tool" @click="copyLogAsPrompt(logPreview.id)">📋 复制</Button>
        <Button variant="ghost" size="tool" @click="logPreview = null">关闭</Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { formatDateTime } from '../../shared/time'
import { renderBody } from '../markdown'
// U1=A（2026-11-11）：手搓按钮换基座
import Button from './ui/Button.vue'

const props = defineProps<{ ctl: any }>()
const ctl = props.ctl

const logPreview = toRef(ctl, 'logPreview')
const projects = toRef(ctl, 'projects')

const {
  logStatusClass, logStatusLabel, copyId, attachAdd, isImageRel, attachSrc, attachName,
  attachOpenHint, attachOpen, attachRemove, openLogFromPreview, copyLogAsPrompt,
} = ctl
</script>
