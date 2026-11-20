<!--
  设置 · 通用（2026-10-30 App.vue 拆分第七刀）：版本与更新 / 外观主题 / 外观形态 / 念头上限 / 顶部工具栏。状态仍留在 App，经 provide("fc-settings") 共享。
-->
<script setup lang="ts">
import { inject, onMounted, ref } from 'vue'
import Button from '../ui/Button.vue'

defineProps<{ active: boolean }>()
const ctx: any = inject('fc-settings')
const {
  appVersion, updateState, checkUpdate, downloadUpdate, installUpdate, disableGpu, onDisableGpuChange, THEME_LIST, theme, setTheme, APPEARANCE_LIST, appearance, setAppearance, IDEA_TEXT_DEFAULT, IDEA_TEXT_HARD_MAX, IDEA_TEXT_MIN, ideaMaxChars, onIdeaMaxChange, views, viewLayout, VIEW_PRESETS, VIEWS_MIN_VISIBLE, VIEWS_MAX_VISIBLE, curLayoutName, onViewVisibleChange, resetCollapsedViews, openViewLayout, applyViewPreset,
} = ctx

// ── 记忆开关（2026-11-20）────────────────────────────────────────────
// 真身 prefs.json；缺省开（键不存在 = 开）。只关 agent 的自动读写，
// 记忆页照常可看可管 —— 否则用户想静音只能删数据。
const memoryEnabled = ref(true)
const memoryInjectCore = ref(true)
const memoryBriefing = ref(true)
const memoryMsg = ref('')

async function loadMemoryPrefs(): Promise<void> {
  try {
    const p: any = await (window as any).tegula.prefsGet()
    memoryEnabled.value = p?.memoryEnabled !== false
    memoryInjectCore.value = p?.memoryInjectCore !== false
    memoryBriefing.value = p?.memoryBriefing !== false
  } catch { /* 读不到偏好按开处理；不挡设置页 */ }
}

async function saveMemoryPrefs(): Promise<void> {
  memoryMsg.value = '存…'
  try {
    const r: any = await (window as any).tegula.prefsSetMany({
      memoryEnabled: memoryEnabled.value,
      memoryInjectCore: memoryInjectCore.value,
      memoryBriefing: memoryBriefing.value,
    })
    memoryMsg.value = r?.ok === false ? ('没存进去：' + (r?.error || '未知原因')) : '已保存（立即生效）'
  } catch (e: any) {
    memoryMsg.value = '没存进去：' + (e?.message || e)
  }
}

onMounted(loadMemoryPrefs)
</script>

<template>
          <div class="sect" v-show="active">
            <h4>版本与更新</h4>
            <div class="ver-row">
              <span class="ver-num">v{{ appVersion }}</span>
              <span v-if="updateState.checked" class="hint">{{ updateState.msg }}</span>
            </div>
            <div class="sect-btns">
              <button class="ghost font-[inherit]" :disabled="updateState.busy" @click="checkUpdate">
                {{ updateState.busy ? '检查中…' : '检查更新' }}
              </button>
              <button v-if="updateState.available" class="pri font-[inherit]" :disabled="updateState.busy" @click="downloadUpdate">
                下载 v{{ updateState.version }}
              </button>
              <button v-if="updateState.downloaded" class="pri font-[inherit]" @click="installUpdate">
                退出并安装
              </button>
            </div>
            <div class="hint">更新包托管在 GitHub Releases，检查与下载需联网。</div>
            <!-- 2026-09-25（用户第 1/3/9 条）：界面卡顿/点不动的人工验证杠杆。
                 去完全部实时模糊层后若仍复发，那就是合成器/核显驱动层的问题
                 —— 关掉硬件加速重启即可验证（必须重启才生效）。 -->
            <label class="chk gpu-chk" title="关掉 Chromium 的 GPU 合成。若“点输入框要切窗口才恢复”仍复发，勾上它重启再试。">
              <input type="checkbox" v-model="disableGpu" @change="onDisableGpuChange" />
              禁用硬件加速（界面若出现卡顿/点不动的兜底，需重启生效）
            </label>
          </div>
          <!-- 2026-09-29 用户第 4 条：多主题外观（参考另一款自有产品的色板与摆法） -->
          <div class="sect" v-show="active">
            <h4>外观主题</h4>
            <div class="hint">只换配色，不改布局；六套全部过可读性检查（正文 / 次要文字 / 按钮白字对比度 ≥ WCAG AA）。</div>
            <div class="theme-swatches">
              <button v-for="t in THEME_LIST" :key="t.id" class="theme-swatch font-[inherit]"
                :class="{ on: theme === t.id }" :title="'切换到主题：' + t.name" @click="setTheme(t.id)">
                <span class="sw-dot" :style="{ background: t.dot }"></span>
                <span class="sw-name">{{ t.name }}</span>
                <span v-if="theme === t.id" class="sw-check">✓</span>
              </button>
            </div>
          </div>
          <!-- 2026-10-30 卡 004：全局外观（阴影 / 扁平）——
               与上面的主题**互相独立**：换主题不改影子，换外观不改配色。
               默认扁平；选阴影后卡片 / 按钮 / 弹层按三档高度浮起来，即时生效、落 prefs.json。 -->
          <div class="sect" v-show="active">
            <h4>外观形态</h4>
            <div class="hint">只换“有没有影子”，不改配色与布局；与上面的主题互不影响，随时可切回来。</div>
            <div class="appearance-row">
              <button v-for="a in APPEARANCE_LIST" :key="a.id" class="appearance-btn font-[inherit]"
                :class="[{ on: appearance === a.id }, 'ap-' + a.id]"
                :title="a.hint" @click="setAppearance(a.id)">
                <span class="ap-preview"><span class="ap-card"></span></span>
                <span class="ap-name">{{ a.name }}</span>
                <span class="ap-hint">{{ a.id === 'flat' ? '零阴影' : '三档高度' }}</span>
              </button>
            </div>
          </div>
          <!-- 念头长度上限（2026-10-25 暮雨：“MAX_TEXT = 4000 太小了，或者弄个用户可以
               自己设置的设置项……但是设个硬上限 20000”）。
               ⚠ 三个数与主进程 `services/ideas.ts` 的 IDEA_TEXT_* 必须一致 ——
                 主进程是真守门人（prefs.json 可手改，它会再夹一次），这里是给人看的量程。 -->
          <div class="sect" v-show="active">
            <h4>念头长度上限</h4>
            <div class="hint">
              “想法池”里单条念头最多能写多少<b>字符</b>（含标点与换行）。超了会明确报错，不会悄悄截断。
              默认 {{ IDEA_TEXT_DEFAULT }}，最大 {{ IDEA_TEXT_HARD_MAX }}。
            </div>
            <div class="slider-row">
              <input type="range" class="slider font-[inherit]"
                :min="IDEA_TEXT_MIN" :max="IDEA_TEXT_HARD_MAX" step="1000"
                v-model.number="ideaMaxChars" @change="onIdeaMaxChange"
                :aria-label="'念头长度上限（字）'" />
              <span class="slider-val">{{ ideaMaxChars.toLocaleString() }} 字</span>
            </div>
            <div class="hint">改完立刻生效（落进 prefs.json，重启也在）；滑块到头也不会超过 {{ IDEA_TEXT_HARD_MAX }}。</div>
          </div>
          <div class="sect" v-show="active">
            <h4>顶栏页签</h4>
            <div class="hint">
              现在有三套工作区预设，还能自己拖。勾上 = 顶栏直接显示；取消 = 收进顶栏的“更多 ▾”。
              <b>下限 {{ VIEWS_MIN_VISIBLE }} 个、上限 {{ VIEWS_MAX_VISIBLE }} 个</b> —— 收光了找不到工具，放满了页面被挤爆。
            </div>
            <div class="views-presets">
              <Button v-for="p in VIEW_PRESETS" :key="'vpres-' + p.id" size="tool"
                :variant="viewLayout.preset === p.id ? 'primary' : 'ghost'"
                :title="p.desc" @click="applyViewPreset(p.id)">{{ p.label }}</Button>
              <Button size="tool" variant="ghost" title="打开拖拽画布：排序 + 显示/收起，能保存能取消"
                @click="openViewLayout">▦ 自定义（拖拽）…</Button>
              <span class="views-cur">当前：{{ curLayoutName }}</span>
            </div>
            <div class="views-pick">
              <label v-for="v in views" :key="'vp-' + v.id" class="views-pick-item"
                :class="{ off: viewLayout.hidden.includes(v.id) }">
                <input type="checkbox" :checked="!viewLayout.hidden.includes(v.id)"
                  @change="onViewVisibleChange(v.id, $event)" />
                <span>{{ v.label }}</span>
              </label>
            </div>
            <div class="sect-btns">
              <Button variant="ghost" size="tool" @click="resetCollapsedViews">恢复默认（日常工作区）</Button>
            </div>
          </div>
          <!-- 记忆开关（2026-11-20）：一个总开关 + 两个子开关。
               只影响 agent 的自动读写；记忆页照常可看可管。默认开（键不存在 = 开）。 -->
          <div class="sect" v-show="active">
            <h4>记忆</h4>
            <div class="hint">
              记忆是方寸的可选功能。这里只控制 <b>agent 会不会自动读记忆</b>；
              关掉后数据还在，记忆页照常能看、能改。
            </div>
            <label class="chk mem-pref"><input type="checkbox" v-model="memoryEnabled" @change="saveMemoryPrefs" />
              启用记忆（默认开）
            </label>
            <label class="chk mem-pref"><input type="checkbox" v-model="memoryInjectCore" :disabled="!memoryEnabled" @change="saveMemoryPrefs" />
              开工时自动带上常读记忆（最多 800 字）
            </label>
            <label class="chk mem-pref"><input type="checkbox" v-model="memoryBriefing" :disabled="!memoryEnabled" @change="saveMemoryPrefs" />
              开工时按项目给一份提醒（最多 5 条）
            </label>
            <div class="hint">「开工常读」是在记忆页勾了「开工时常读」的那几条；这里不用逐条挑。</div>
            <div class="hint" v-if="memoryMsg">{{ memoryMsg }}</div>
          </div>
</template>
