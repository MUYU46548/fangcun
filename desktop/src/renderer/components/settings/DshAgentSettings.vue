<!--
  设置 · Agent · DSH 与花费（2026-11-21 · 卡 2bd6106a）

  为什么从「通用」搬进来：这两组直接决定“agent 会不会被开 / 会不会花钱”，
  是 Agent 语义，不是外观或启动项。用户原话：“设置藏太深了，找了超过五分钟……
  既然是拍给 DSH 和 Agent 高度相关，居然藏在通用而不是 Agent 里，如‘花钱动作前确认’”。

  ⚠ 只搬 UI 位置，不动数据：`prefs.costConfirm` 与
    `<数据根>/.dispatch-dsh/dispatch-settings.json` 的键名、默认值一个都不改。
-->
<script setup lang="ts">
import { inject, onMounted, ref } from 'vue'
import Button from '../ui/Button.vue'

defineProps<{ active: boolean }>()
const ctx: any = inject('fc-settings')
const { costConfirm, setCostConfirm } = ctx

/** 花钱确认开关（2026-11-20）：真身 prefs.json 的 costConfirm；默认开 */
function onCostConfirmChange(e: Event): void {
  const v = !!(e.target as HTMLInputElement | null)?.checked
  void setCostConfirm(v)
}

// ── DSH 派单总闸（2026-11-21 · 卡 `…闸要下在-e4264e6c`）─────────────────
// 默认 **关**：没被用户显式打开之前，三个入口全置灰，插件也整目录拒收。
// 真源 = `<数据根>/.dispatch-dsh/dispatch-settings.json`；这里读写的 `dispatch:settings`
// 与 health.dispatch 是**同一个对象**，界面不自己算"今天几单"。
const dispatch = ref<any>(null)
const dispatchDraft = ref({ enabled: false, cooldownSec: '', dailyCap: '', concurrency: '' })
const dispatchMsg = ref('')
const dispatchSaving = ref(false)

function dispatchDraftOf(s: any): typeof dispatchDraft.value {
  return {
    enabled: s?.enabled === true,
    cooldownSec: s?.cooldownSec === undefined ? '' : String(s.cooldownSec),
    dailyCap: s?.dailyCap === undefined ? '' : String(s.dailyCap),
    concurrency: s?.concurrency === undefined ? '' : String(s.concurrency),
  }
}

async function loadDispatchPrefs(): Promise<void> {
  try {
    const r: any = await (window as any).tegula.dispatchSettingsGet?.()
    if (!r || r.ok === false) {
      dispatchMsg.value = '读不到派单设置：' + (r?.error || '主进程没有返回')
      return
    }
    dispatch.value = r
    dispatchDraft.value = dispatchDraftOf(r.settings)
    if (r.settingsError) dispatchMsg.value = String(r.settingsError)
  } catch (e: any) {
    dispatchMsg.value = '读不到派单设置：' + (e?.message || e)
  }
}

async function saveDispatchPrefs(): Promise<void> {
  dispatchSaving.value = true
  dispatchMsg.value = '存…'
  try {
    const d = dispatchDraft.value
    const r: any = await (window as any).tegula.dispatchSettingsSet?.({
      enabled: d.enabled,
      cooldownSec: d.cooldownSec,
      dailyCap: d.dailyCap,
      concurrency: d.concurrency,
    })
    if (!r || r.ok === false) {
      dispatchMsg.value = '没存进去：' + (r?.error || '未知原因')
      return
    }
    dispatchMsg.value = '已保存（立即生效）'
    // 按钮置灰状态跟着同一个真源刷新 —— 不能等重启界面
    await ctx.refreshDispatchGate?.()
    await loadDispatchPrefs()
  } catch (e: any) {
    dispatchMsg.value = '没存进去：' + (e?.message || e)
  } finally {
    dispatchSaving.value = false
  }
}

onMounted(() => { void loadDispatchPrefs() })
</script>

<template>
  <!-- 花钱动作确认（2026-11-20 · 暮雨）：默认开；关掉后按钮仍带金色 ¥ 角标，
       但不再弹窗。弹窗里勾「以后不再提示」也会把这里关掉。 -->
  <div class="sect" v-show="active">
    <h4>花钱动作前确认</h4>
    <label class="chk" title="调用 DSH 或模型前先弹窗说明可能产生的费用；关掉后不再拦，但按钮仍有 ¥ 角标">
      <input type="checkbox" :checked="costConfirm" @change="onCostConfirmChange" />
      调用 DSH / 模型前弹窗确认（防止新手误触）
    </label>
    <div class="hint">默认开。关掉后所有「发送给 DSH / 让 DSH 做规划 / 文档拆卡 / 出单」不再弹窗，但仍带金色 ¥ 角标。</div>
  </div>
  <!-- DSH 派单总闸（2026-11-21 · 暮雨：「设置页里没看到任何地方能设置 DSH 调用限制」）。
       默认关：没打开之前三个入口全置灰，插件也整目录拒收 ——
       「没人点，就开不出来」是结构事实，不靠纪律、不靠上限。 -->
  <div class="sect" v-show="active">
    <h4>DSH 派单（花费会话）</h4>
    <div class="hint">
      默认<b>关闭</b>：没打开之前，「发送给 DSH / 让 DSH 做规划 / 日志发送」全部置灰，
      插件也会拒收任何派单文件（手写、别的 agent 写、旧残留重建，一样开不出会话）。
    </div>
    <div class="hint">
      这一页只管<b>开不开 / 冷却 / 日上限 / 并发</b>，<b>不管权限</b>。
      派单会话的操作权限（只读 / 工作区内修改 / 完全权限）由 DSH 决定：
      <b>DSH 设置 → 通用 → 权限默认档</b>。默认可能是「完全权限」，第一次派单前先去 DSH 确认。
    </div>
    <div class="hint">
      出厂值是<b>保守</b>的（1 个在途 / 日 3 单 / 30 秒冷却）；长程任务按需调高即可。
      方寸<b>不会</b>自动超时、也<b>不会</b>自动杀派单会话 —— 要停请手动停，别让长任务被掐断。
    </div>
    <label class="chk" title="打开后才会写派单文件；关闭状态下连签名派单也不会被消费">
      <input type="checkbox" v-model="dispatchDraft.enabled" />
      启用 DSH 派单（默认关闭）
    </label>
    <div class="sect-btns retain-row">
      <span class="hint">冷却</span>
      <input type="number" min="0" max="86400" step="1" class="retain-input"
        v-model="dispatchDraft.cooldownSec" aria-label="同一项目冷却秒数" />
      <span class="hint">秒（0 = 不冷却）</span>
    </div>
    <div class="sect-btns retain-row">
      <span class="hint">每天最多</span>
      <input type="number" min="0" max="1000" step="1" class="retain-input"
        v-model="dispatchDraft.dailyCap" aria-label="每日派单会话上限" />
      <span class="hint">个会话（0 = 不限）</span>
    </div>
    <div class="sect-btns retain-row">
      <span class="hint">同时最多</span>
      <input type="number" min="1" max="100" step="1" class="retain-input"
        v-model="dispatchDraft.concurrency" aria-label="同时在途派单会话上限" />
      <span class="hint">个在途（1–100）</span>
    </div>
    <div class="sect-btns">
      <Button variant="ghost" size="tool" :disabled="dispatchSaving" @click="saveDispatchPrefs">
        {{ dispatchSaving ? '保存中…' : '保存派单设置' }}
      </Button>
      <Button variant="ghost" size="tool" :disabled="dispatchSaving" @click="loadDispatchPrefs">刷新</Button>
    </div>
    <!-- 只渲染主进程返回的真身：今天几单 / 上限 / 文件来源 -->
    <div class="hint" v-if="dispatch">
      今天已开 {{ dispatch.today }} 个会话<template v-if="dispatch.settings && dispatch.settings.dailyCap > 0">（上限 {{ dispatch.settings.dailyCap }}）</template>；
      真源：{{ dispatch.source === 'file' ? dispatch.file : '默认值（未启用，文件还没生成）' }}
    </div>
    <div class="hint" v-if="dispatchMsg">{{ dispatchMsg }}</div>
  </div>
</template>
