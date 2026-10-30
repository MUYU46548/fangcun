<!--
  设置 · Agent（2026-10-30 App.vue 拆分第八刀）：模型通道（BYOK）/ 模型单价 / 挂机提醒 / Agent 预设。状态经 provide("fc-settings") 共享。
-->
<script setup lang="ts">
import { inject } from 'vue'

defineProps<{ active: boolean }>()
const ctx: any = inject('fc-settings')
const {
  addAgentPreset, addPriceRow, agentPresets, applyLlmPreset, confirmLlmPreset, fmtShort, idleCfg, idleSave, idleSaving, llmCfg, llmHostOf, llmKeyHint, llmLastCall, llmPresetPending, llmReset, llmResetting, llmSave, llmSaving, llmTest, llmTesting, loadUsageStats, newAgentName, priceMsg, priceRows, priceSaving, removeAgentPreset, savePrices, usageStats_,
} = ctx
</script>

<template>
    <div class="sect" v-show="active">
      <h4>✨ 模型通道（AI 规划用）</h4>
      <div class="hint">项目详情页「✨ AI 规划」按钮走这里。密钥只存本机、回显只有掩码；每次调用的 token 与耗时随结果提示。</div>

      <!-- 状态条（2026-10-27）：此前界面上**完全看不出配没配好** —— 用户得自己比对四个输入框
           猜上一次到底通没通。这里直接摊开「配没配 + 上次什么时候用过、花了多少」。
           数据来自 ai-trace（llm:usageStats 的 last 字段），不额外读文件。 -->
      <div class="llm-status" :class="llmCfg.baseUrl ? 'on' : 'off'">
        <span class="llm-status-dot"></span>
        <span v-if="!llmCfg.baseUrl">未配置 —— 填好下面三项，点「测试连接」确认再保存</span>
        <span v-else-if="llmLastCall">
          已配置 · {{ llmHostOf(llmCfg.baseUrl) }} · 最近一次 {{ fmtShort(llmLastCall.ts) }}，
          <template v-if="llmLastCall.total_tokens != null">{{ llmLastCall.total_tokens }} tokens / </template>
          {{ (llmLastCall.duration_ms / 1000).toFixed(1) }} 秒<template v-if="!llmLastCall.ok">（失败）</template>
        </span>
        <span v-else>已配置 · {{ llmHostOf(llmCfg.baseUrl) }} · 还没跑过调用</span>
      </div>

      <div class="llm-presets">
        <button class="ghost font-[inherit]" @click="applyLlmPreset('deepseek')">DeepSeek 一键填</button>
        <button class="ghost font-[inherit]" @click="applyLlmPreset('mimo-api')">MiMo 按量付费</button>
        <button class="ghost font-[inherit]" @click="applyLlmPreset('mimo-plan')">MiMo Token Plan</button>
      </div>

      <!-- 覆盖确认条（2026-10-27）：预设会**直接盖掉已填的端点/模型**，此前一点就没、无法撤销。
           照 relay-discard 那套（不用原生 confirm，用户已踩过两次「防护未生效」）：
           对话框内条子 + 必须点「覆盖」才生效。API Key 预设一律不碰。 -->
      <div v-if="llmPresetPending" class="llm-overwrite" role="alertdialog" aria-live="polite">
        <span class="lo-text">
          ⚠ 会覆盖当前配置：<b>{{ llmHostOf(llmCfg.baseUrl) }} · {{ llmCfg.model || '（空）' }}</b>
          → <b>{{ llmHostOf(llmPresetPending.baseUrl) }} · {{ llmPresetPending.model }}</b>（API Key 不动）
        </span>
        <span class="lo-acts">
          <button class="ghost font-[inherit]" @click="llmPresetPending = null">取消</button>
          <button class="danger font-[inherit]" @click="confirmLlmPreset()">覆盖</button>
        </span>
      </div>

      <div class="llm-grid">
        <div>
          <label>Base URL（API 端点）</label>
          <input class="font-[inherit]" v-model="llmCfg.baseUrl" placeholder="如 https://api.deepseek.com（OpenAI 兼容）" />
        </div>
        <div class="llm-row2">
          <div>
            <label>模型名</label>
            <input class="font-[inherit]" v-model="llmCfg.model" placeholder="如 deepseek-chat / mimo-v2.6-flash" />
          </div>
          <div>
            <label>超时（秒）</label>
            <input class="font-[inherit]" type="number" min="10" step="10" v-model.number="llmCfg.timeout" />
          </div>
        </div>
        <div>
          <label>API Key（保存后回显为掩码；修改就重填）</label>
          <input class="font-[inherit]" v-model="llmCfg.apiKey" :placeholder="llmKeyHint ? `已存：${llmKeyHint}（改填新值才覆盖）` : '粘贴你的密钥'" />
        </div>
      </div>

      <div class="sect-btns">
        <button class="ghost font-[inherit]" :disabled="llmTesting" @click="llmTest">{{ llmTesting ? '测试中…' : '测试连接' }}</button>
        <button class="pri font-[inherit]" :disabled="llmSaving" @click="llmSave">{{ llmSaving ? '保存中…' : '保存' }}</button>
        <button class="ghost font-[inherit]" :disabled="llmResetting" @click="llmReset">重置（保留密钥）</button>
      </div>

      <!-- 小米两个端点（2026-10-18 暮雨第 3 条）：按量付费与 Token Plan 的 Base URL / Key 都不同，
           控制台各自一键复制。这里把两个都摆出来，并说清哪条适用方寸 —— 别让用户拿 Plan 的 key
           去连按量付费端点（必 401，且报错还看不出是端点错了）。
           2026-10-27：改成折叠。这段只对"想用小米"的人有用，却常驻挡在所有输入框上方 ——
           暮雨配的是第三方中转站，每次都要跨过一段与他无关的说明。 -->
      <details class="llm-mimo">
        <summary>用小米 MiMo？看两套凭证的区别</summary>
        <div class="hint">
          小米有<b>两套凭证</b>，不能混用：按量付费 = <code>api.xiaomimimo.com/v1</code> + <code>sk-</code> 开头的 Key；
          Token Plan = <code>token-plan-cn.xiaomimimo.com/v1</code> + <code>tp-</code> 开头的 Key（控制台各自一键复制）。
          按小米条款，<b>Token Plan 仅限编程工具内使用，不要用于方寸这类应用后端</b>；给方寸用请选按量付费。
        </div>
      </details>
    </div>
    <!-- 模型单价（可选，2026-10-25 卡 005 B 档）——**空表就是"一律未折算"**。
         为什么不内置默认价：暮雨原话「单价表从哪里来？每家都不一样，还随时可能变」。
         内置常量过半年就是谎话，而且不会报错，只会安静地算错。 -->
    <div class="sect" v-show="active">
      <h4>模型单价（可选）</h4>
      <div class="hint">
        单位：<b>元 / 百万 tokens</b>。填了才会在月度报表里折算金额，并标「按你填的单价」；
        <b>不填就是「未折算」</b> —— 方寸不内置任何默认价。
        <br>DeepSeek / OpenRouter 这类<b>有官方余额接口</b>的端点优先看「账户口径」，那条不需要单价。
      </div>
      <div class="price-head" v-if="priceRows.length">
        <span class="price-model">模型名</span>
        <span class="price-num">输入价</span>
        <span class="price-num">输出价</span>
        <span class="price-del"></span>
      </div>
      <div class="price-rows">
        <div class="price-row" v-for="(r, i) in priceRows" :key="'pr-' + i">
          <input class="price-model font-[inherit]" v-model="r.model" placeholder="模型名（与请求里一致）" />
          <input class="price-num font-[inherit]" type="number" min="0" step="0.01" v-model="r.in" placeholder="输入价" />
          <input class="price-num font-[inherit]" type="number" min="0" step="0.01" v-model="r.out" placeholder="输出价" />
          <button class="ghost price-del font-[inherit]" title="删掉这一行（保存后生效）" @click="priceRows.splice(i, 1)">✕</button>
        </div>
        <div class="price-empty" v-if="!priceRows.length">
          还没有单价 —— 现在所有调用都是「未折算」。要用金额报表就加一行（模型名照抄设置里的那个）。
        </div>
      </div>
      <div class="sect-btns">
        <button class="ghost font-[inherit]" @click="addPriceRow">＋ 加一行</button>
        <button class="pri font-[inherit]" :disabled="priceSaving" @click="savePrices">{{ priceSaving ? '保存中…' : '保存单价' }}</button>
        <span class="price-state" v-if="priceMsg">{{ priceMsg }}</span>
      </div>
    </div>
    <!-- AI 用量（2026-10-17 暮雨第 10 条：「说花销可见，但我看不到啊」）。
         数据源是方寸自己的调用留痕 ai-trace.jsonl（主进程 llm:usageStats 汇总）。
         ⚠ 只算**供应商真报了 usage** 的调用；没报的单列次数，不拿字符数折算成 token（不编数）。 -->
    <div class="sect" v-show="active">
      <h4>💰 AI 用量（花销可见）</h4>
      <div class="hint">
        统计来自方寸自己的调用留痕。只累加<b>供应商真的返回了 token 用量</b>的调用 ——
        老记录只有字符数，会单列成「未计 token」的次数，不折算、不估算。
      </div>
      <div class="sect-btns">
        <button class="ghost font-[inherit]" @click="loadUsageStats(30)">看近 30 天</button>
        <button class="ghost font-[inherit]" @click="loadUsageStats(0)">看全部</button>
      </div>
      <div v-if="usageStats_" class="usage-box">
        <div class="usage-line">
          <b>{{ usageStats_.calls }}</b> 次调用（成功 {{ usageStats_.ok }} · 失败 {{ usageStats_.fail }}）·
          其中 {{ usageStats_.token_calls }} 次带 token 数据
        </div>
        <div class="usage-line" v-if="usageStats_.token_calls">
          tokens：入 <b>{{ usageStats_.prompt_tokens }}</b> · 出 <b>{{ usageStats_.completion_tokens }}</b> ·
          共 <b>{{ usageStats_.total_tokens }}</b>
        </div>
        <div class="usage-line" v-else>这个区间里还没有带 token 的调用记录（老记录只有字符数，不折算）</div>
        <div class="usage-chips" v-if="usageStats_.byModel.length">
          <span v-for="m in usageStats_.byModel.slice(0, 6)" :key="m.model" class="usage-chip">
            {{ m.model }} · {{ m.calls }} 次<template v-if="m.token_calls"> · {{ m.total_tokens }} tokens</template>
          </span>
        </div>
        <div class="usage-line dim" v-if="usageStats_.lastTs">最近一次调用：{{ usageStats_.lastTs }}</div>
      </div>
      <div v-else class="hint">还没查过 —— 点上面任意一个按钮。</div>
    </div>

    <!-- 挂机提醒（2026-10-17 四件补立项④）：powerMonitor 空闲检测，独立于通知中心 7 类扫描
         （2026-10-01「很吵」红线）。一次挂机最多弹一次、回来即重置；关掉则完全不轮询。 -->
    <div class="sect" v-show="active">
      <h4>😴 挂机提醒</h4>
      <div class="hint">人离开电脑一段时间后，系统通知轻提一声「回来看方寸」。一次挂机最多弹一次，回来即重置；关掉则完全不轮询。</div>
      <label style="display:flex;align-items:center;gap:8px;">
        <!-- 2026-10-17 暮雨第 4 条：「关了五次都没用，每次打开设置发现它都是勾选的」——
             真因不是存储坏了，是**改完不点「保存挂机设置」就关掉设置页 = 没保存**，
             下次打开又读回旧值。勾选框与分钟数改成 change 即存（那个保存按钮留着当安全网）。 -->
        <input class="font-[inherit]" type="checkbox" v-model="idleCfg.enabled" @change="idleSave" />
        挂机后提醒我（默认开；勾掉立刻保存）
      </label>
      <label>离开多久提醒（分钟，最小 5）</label>
      <input class="font-[inherit]" type="number" min="5" step="5" v-model.number="idleCfg.thresholdMin" @change="idleSave" />
      <div class="sect-btns">
        <button class="pri font-[inherit]" :disabled="idleSaving" @click="idleSave">{{ idleSaving ? '保存中…' : '保存挂机设置' }}</button>
      </div>
    </div>
    <!-- 2026-09-23：Agent 预设列表可编辑（用户要求：自定义功能多一点） -->
    <div class="sect" v-show="active">
      <h4>🤖 Agent 预设列表</h4>
      <div class="hint">日志视图的「执行 Agent」筛选下拉会读这里的预设。增删后自动保存到浏览器本地。</div>
      <div class="agent-presets-list">
        <span v-for="(a, i) in agentPresets" :key="a" class="agent-preset-chip">
          {{ a }}
          <button class="agent-preset-del font-[inherit]" title="删除此预设" @click="removeAgentPreset(i)">×</button>
        </span>
        <span v-if="!agentPresets.length" class="hint">暂无预设，添加一个吧</span>
      </div>
      <div class="agent-presets-add">
        <input class="font-[inherit]" v-model="newAgentName" placeholder="新 Agent 名称（如 opencode）" @keydown.enter="addAgentPreset" />
        <button class="ghost font-[inherit]" @click="addAgentPreset">添加</button>
      </div>
    </div>
</template>
