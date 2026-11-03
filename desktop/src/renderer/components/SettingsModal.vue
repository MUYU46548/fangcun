<!--
  设置弹窗（2026-11-02 · App.vue 后三刀第一刀「浮层」收尾）

  **边界**：只搬外壳与七个分类的挂载。各分类内部状态仍在自己的组件 / composable 里；
  外壳状态（当前分类、数据目录、日志清理 / 看板归档、导出导入）由父组件 `settingsCtl` 转接。

  ⚠ 分类页签是**侧边栏**（2026-10-03 用户口径）：折叠解决“太长”，侧边栏解决“找不到”。
  ⚠ `font-[inherit]` 由 components/settings 内部负责，这里不新增裸按钮样式。
-->
<template>
  <div id="soverlay" class="overlay" v-if="ctl.showSettings_" @mousedown.self="ctl.showSettings_ = false">
    <div id="smodal">
      <nav class="settings-nav">
        <div class="settings-nav-title">设置</div>
        <button v-for="t in ctl.settingsTabs" :key="t.id" class="settings-nav-btn"
                :class="{ on: ctl.settingsTab === t.id }" @click="ctl.selectSettingsTab(t.id)">
          <span class="sn-ico">{{ t.icon }}</span><span class="sn-name">{{ t.name }}</span>
        </button>
      </nav>
      <div class="settings-body">
      <GeneralSettings :active="ctl.settingsTab === 'general'" />
      <div class="sect" v-show="ctl.settingsTab === 'data'">
        <h4>数据目录</h4>
        <div class="hint">{{ ctl.dataDir }}</div>
        <div class="sect-btns">
          <button class="ghost" @click="ctl.changeDataDir">修改目录…</button>
          <button class="ghost" @click="ctl.openDataDir">打开目录</button>
        </div>
      </div>
      <!-- 整理体检 + 大附件：已切到 components/DataHygienePanel.vue
           （App.vue 拆分第一刀，2026-10-30）。两块都是只读通道 + 两个跳转事件，
           边界干净；破坏性动作（删附件）仍只在主进程一条通道里，组件只负责确认与刷新。 -->
      <DataHygienePanel v-show="ctl.settingsTab === 'data'" :toast="ctl.showToast"
        @goto-never-read="ctl.gotoNeverRead" @goto-rework="ctl.gotoRework" />
      <DiagSettings :active="ctl.settingsTab === 'diag'" />
      <div class="sect" v-show="ctl.settingsTab === 'data'">
        <h4>日志清理</h4>
        <div class="hint">已完成日志默认保留这么多天，到期后点日志页的“清理超期”标为“已归档”（只改状态，不删文件）。逐条完成时填的天数仍然优先。</div>
        <div class="sect-btns retain-row">
          <input type="number" min="0" step="1" class="retain-input"
            v-model.number="ctl.logRetainDefault" @change="ctl.onLogRetainDefaultChange" />
          <span class="hint">天（0 = 永不清理）</span>
        </div>
      </div>
      <!-- 2026-10-03 卡 012：看板已完成任务自动归档（仿日志清理；**默认关闭**） -->
      <div class="sect" v-show="ctl.settingsTab === 'data'">
        <h4>看板归档</h4>
        <div class="hint">“已完成”且超过这么多天没更新过的任务，会被移进归档区（“归档”标签里能看到、可随时还原，文件不会被删）。0 = 关闭。</div>
        <div class="sect-btns retain-row">
          <input type="number" min="0" step="1" class="retain-input"
            v-model.number="ctl.archiveDays" @change="ctl.onArchiveDaysChange" />
          <span class="hint">天（0 = 关闭）</span>
        </div>
        <label class="chk">
          <input type="checkbox" v-model="ctl.archiveAuto" @change="ctl.onArchiveAutoChange" />
          启动方寸时自动执行（默认关；开了它才会在启动时动文件）
        </label>
        <div class="sect-btns" v-if="ctl.archiveDays > 0">
          <button class="ghost" @click="ctl.refreshArchiveOverdue()">刷新超期清单</button>
          <button class="ghost" :disabled="ctl.archiveOverdue.count === 0" @click="ctl.runArchiveOverdue()">
            立即归档超期的 {{ ctl.archiveOverdue.count }} 个
          </button>
        </div>
      </div>
      <!-- 模型通道（AI 规划用，2026-10-12）：BYOK——端点/密钥/模型全在用户手里。
           后端 12 条 LLM 通道 10-06 起就绪，这是配置界面第一次装。
           密钥只存本机（llm-config.json，0600），回显永远只有掩码；不预填任何默认端点（含国外）。 -->
      <AgentSettings :active="ctl.settingsTab === 'agent'" />
      <ProjectSettings :active="ctl.settingsTab === 'projects'" />
      <!-- 备份与恢复：已切到 components/settings/BackupSettings.vue（拆分第六刀）
           状态在 useBackup 单例里，App 与这里共用同一份。 -->
      <BackupSettings v-show="ctl.settingsTab === 'backup'" />

      <!-- 底部动作条：与"当前在哪个分类"无关（导出/导入/关闭随时可用），所以挂在 body 末尾 -->
      <div class="settings-foot">
        <button class="ghost" @click="ctl.exportTasksToFile">导出任务 JSON</button>
        <button class="ghost" @click="ctl.importTasksFromFile">导入任务 JSON</button>
        <button class="pri" @click="ctl.showSettings_ = false">关闭</button>
      </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import GeneralSettings from './settings/GeneralSettings.vue'
import DiagSettings from './settings/DiagSettings.vue'
import AgentSettings from './settings/AgentSettings.vue'
import ProjectSettings from './settings/ProjectSettings.vue'
import BackupSettings from './settings/BackupSettings.vue'
import DataHygienePanel from './DataHygienePanel.vue'

const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点 */
const settingsCtl = ctl
</script>
