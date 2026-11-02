<template>
  <div v-if="ctl.showWizard" class="overlay wizard-overlay">
  <div class="wizard">
    <div class="wizard-header">
      <h2>{{ ctl.ctl.wizardSteps[ctl.wizardStep].title }}</h2>
      <p class="wizard-step-indicator">步骤 {{ ctl.wizardStep + 1 }} / {{ ctl.ctl.wizardSteps.length }}</p>
    </div>
    <div class="wizard-body">
      <div v-if="ctl.wizardStep === 0">
        <p class="wizard-desc">欢迎使用方寸！请先选择数据目录。</p>
        <div class="wizard-field">
          <label>数据目录</label>
          <div class="wizard-input-row">
            <input v-model="ctl.wizardDataDir" placeholder="选择数据目录路径" />
            <button class="ghost" @click="browseWizardDir">浏览…</button>
          </div>
          <small class="wizard-hint">方寸将在此目录下创建 task-data/ 和 registry.yaml</small>
        </div>
      </div>
      <div v-if="ctl.wizardStep === 1">
        <p class="wizard-desc">选择初始化方式：</p>
        <div class="wizard-options">
          <label class="wizard-option" :class="{ selected: ctl.wizardInitMode === 'fresh' }">
            <input type="radio" v-model="ctl.wizardInitMode" value="fresh" />
            <div>
              <strong>新建空白看板</strong>
              <small>从零开始，创建全新的任务看板</small>
            </div>
          </label>
          <label class="wizard-option" :class="{ selected: ctl.wizardInitMode === 'import' }">
            <input type="radio" v-model="ctl.wizardInitMode" value="import" />
            <div>
              <strong>从 Python tegula 导入</strong>
              <small>复制现有任务数据和项目注册表</small>
            </div>
          </label>
        </div>
        <div v-if="ctl.wizardInitMode === 'import'" class="wizard-field">
          <label>Python tegula 目录</label>
          <div class="wizard-input-row">
            <input v-model="ctl.wizardPythonDir" placeholder="E:\CODE\CangKu\fangcun" />
            <button class="ghost" @click="browsePythonDir">浏览…</button>
          </div>
        </div>
      </div>
      <div v-if="ctl.wizardStep === 2">
        <p class="wizard-desc">确认配置：</p>
        <div class="wizard-summary">
          <div class="wizard-summary-row"><span>数据目录</span><code>{{ ctl.wizardDataDir }}</code></div>
          <div class="wizard-summary-row"><span>初始化方式</span><span>{{ ctl.wizardInitMode === 'fresh' ? '新建空白看板' : '从 Python tegula 导入' }}</span></div>
          <div v-if="ctl.wizardInitMode === 'import'" class="wizard-summary-row"><span>Python tegula 目录</span><code>{{ ctl.wizardPythonDir }}</code></div>
        </div>
      </div>
    </div>
    <div class="wizard-footer">
      <button v-if="ctl.wizardStep > 0" class="ghost" @click="ctl.ctl.wizardStep--">上一步</button>
      <div class="wizard-footer-right">
        <button v-if="ctl.wizardStep < ctl.ctl.wizardSteps.length - 1" class="pri" @click="ctl.wizardNext" :disabled="!ctl.wizardCanNext">下一步</button>
        <button v-else class="pri" @click="ctl.wizardFinish" :disabled="ctl.wizardFinishing">{{ ctl.wizardFinishing ? '初始化中…' : '完成' }}</button>
      </div>
    </div>
  </div>
</div>
</template>

<script setup lang="ts">
/**
 * 首次启动向导（2026-11-02 · App.vue 后三刀第一刀「浮层」）
 *
 * 只搬模板：wizard* 那一组状态与 wizardNext / wizardFinish 仍住 App.vue。
 * `wizardStep--` 是对 ctl 的 getter 返回值自减 —— 因此 setter 必须存在（见 App.vue 的 wizardCtl）。
 */
defineProps<{ ctl: any }>()
</script>
