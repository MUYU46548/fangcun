<!--
  设置 · Agent（2026-10-30 App.vue 拆分第八刀）：模型单价 / 挂机提醒 / Agent 预设 / MCP 写口。BYOK 配置与模型调用已按 2026-11-20 暮雨口径删除。
-->
<script setup lang="ts">
import { inject, reactive, ref, watch } from 'vue'

const props = defineProps<{ active: boolean }>()
const ctx: any = inject('fc-settings')
const {
  addAgentPreset, addPriceRow, agentPresets, idleCfg, idleSave, idleSaving, loadUsageStats, newAgentName, priceMsg, priceRows, priceSaving, removeAgentPreset, savePrices, usageStats_,
} = ctx

// ── MCP 写口（2026-11-11 · 卡《MCP 写口无闸》）────────────────────────────
// 暮雨原话：“哪怕是另一款自有产品也必须开 agent 模式放开解锁才能 agent 直接调用”。
// 这一块只做三件：看得见当前档位 / 能收紧 / 看得见谁写了什么（含被拒的尝试）。
const writeMode = ref('write')
const writeModes = ref<{ mode: string; label: string; hint: string }[]>([])
const writeRows = ref<any[]>([])
const writeBusy = ref(false)
const writeMsg = ref('')
const writeMsgBad = ref(false)

async function loadWriteGate(): Promise<void> {
  try {
    const r: any = await (window as any).tegula.mcpWriteMode()
    if (r && r.mode) writeMode.value = String(r.mode)
    if (r && Array.isArray(r.modes)) writeModes.value = r.modes
  } catch (e: any) {
    writeMsg.value = '读不到档位：' + (e?.message || e)
    writeMsgBad.value = true
  }
  await loadWrites()
}

async function loadWrites(): Promise<void> {
  try {
    const r: any = await (window as any).tegula.mcpWrites(30)
    writeRows.value = Array.isArray(r?.rows) ? r.rows : []
  } catch (e: any) {
    writeMsg.value = '读不到写侧清单：' + (e?.message || e)
    writeMsgBad.value = true
  }
}

async function saveWriteMode(): Promise<void> {
  if (writeBusy.value) return
  writeBusy.value = true
  writeMsg.value = ''
  writeMsgBad.value = false
  try {
    const r: any = await (window as any).tegula.mcpSetWriteMode(writeMode.value)
    if (r && r.ok) {
      writeMode.value = String(r.mode || writeMode.value)
      writeMsg.value = '已改为「' + modeLabel(r.mode) + '」（已留痕）'
    } else {
      writeMsg.value = '改档失败：' + (r?.error || '没落盘')
      writeMsgBad.value = true
    }
    await loadWrites()
  } catch (e: any) {
    writeMsg.value = '改档失败：' + (e?.message || e)
    writeMsgBad.value = true
  } finally {
    writeBusy.value = false
  }
}

function modeLabel(m: string): string {
  const f = writeModes.value.find((x) => x.mode === m)
  return f ? f.label : String(m || '')
}

function fmtWriteTime(ts: string): string {
  const t = Date.parse(String(ts || ''))
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

function writeTarget(w: any): string {
  const a = (w && w.args) || {}
  if (a.id) return String(a.id)
  if (Array.isArray(a.ids) && a.ids.length) return a.ids.slice(0, 3).join('、')
  if (a.project) return String(a.project)
  if (a.deck) return '卷：' + String(a.deck)
  // 2026-11-11 评审抓到：`create_task` 的新卡 id 只出现在留痕的 `result` 里（args 里没有 id），
  // 此前这里恒显示「—」——“落了什么”这条判据其实是空的。现在两个来源都认。
  if (w && w.result) return String(w.result)
  return '—'
}

watch(() => props.active, (v) => { if (v) loadWriteGate() }, { immediate: true })

// ────────────────────────────────────────────────────────────────────────

</script>

<template>
    <!-- 模型单价（可选，2026-10-25 卡 005 B 档）——**空表就是"一律未折算"**。
         为什么不内置默认价：暮雨原话“单价表从哪里来？每家都不一样，还随时可能变”。
         内置常量过半年就是谎话，而且不会报错，只会安静地算错。 -->
    <div class="sect" v-show="active">
      <h4>模型单价（可选）</h4>
      <div class="hint">
        单位：<b>元 / 百万 tokens</b>。填了才会在月度报表里折算金额，并标“按你填的单价”；
        <b>不填就是“未折算”</b> —— 方寸不内置任何默认价，也不再配置任何模型通道。
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
          还没有单价 —— 现在所有调用都是“未折算”。要用金额报表就加一行（模型名照抄设置里的那个）。
        </div>
      </div>
      <div class="sect-btns">
        <button class="ghost font-[inherit]" @click="addPriceRow">＋ 加一行</button>
        <button class="pri font-[inherit]" :disabled="priceSaving" @click="savePrices">{{ priceSaving ? '保存中…' : '保存单价' }}</button>
        <span class="price-state" v-if="priceMsg">{{ priceMsg }}</span>
      </div>
    </div>
    <!-- AI 用量（2026-10-17 暮雨第 10 条：“说花销可见，但我看不到啊”）。
         数据源是 ai-trace.jsonl（主进程 llm:usageStats 汇总；BYOK 退场后主要是 external:dsh 上报）。
         ⚠ 只算**供应商真报了 usage** 的调用；没报的单列次数，不拿字符数折算成 token（不编数）。 -->
    <div class="sect" v-show="active">
      <h4>💰 AI 用量（花销可见）</h4>
      <div class="hint">
        统计来自 ai-trace；BYOK 退场后主要是 DSH 上报，历史记录保留。只累加<b>供应商真的返回了 token 用量</b>的调用 ——
        老记录只有字符数，会单列成“未计 token”的次数，不折算、不估算。
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
        <!-- 主指标口径（2026-11-07 · W1）：账上 99.3% 的 total 是 cache_read，
             拿 total 当"花销"量的是上下文长度。主指标换成"新输入 + 输出"，total 降副列。 -->
        <div class="usage-line" v-if="usageStats_.token_calls">
          新输入 <b>{{ usageStats_.new_input_tokens }}</b> · 输出 <b>{{ usageStats_.output_tokens }}</b> tokens
          <span class="usage-line dim">（主指标）</span>
        </div>
        <div class="usage-line dim" v-if="usageStats_.token_calls">
          缓存重读 {{ usageStats_.cache_read_tokens }} · total {{ usageStats_.total_tokens }}（副列，含重读）
          · 外部上报未归因 <b>{{ usageStats_.unattributed_pct }}%</b>（{{ usageStats_.unattributed_calls }} 条）
        </div>
        <!-- 显式条件，不接 v-else：中间隔着副列那一行，v-else 链容易被后人插断 -->
        <div class="usage-line" v-if="!usageStats_.token_calls">这个区间里还没有带 token 的调用记录（老记录只有字符数，不折算）</div>
        <div class="usage-chips" v-if="usageStats_.byCard && usageStats_.byCard.length">
          <span v-for="c in usageStats_.byCard.slice(0, 5)" :key="c.card" class="usage-chip">
            {{ c.card }} · {{ c.calls }} 次 · {{ c.total_tokens }} tokens
          </span>
        </div>
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
         （2026-10-01“很吵”红线）。一次挂机最多弹一次、回来即重置；关掉则完全不轮询。 -->
    <div class="sect" v-show="active">
      <h4>😴 挂机提醒</h4>
      <div class="hint">人离开电脑一段时间后，系统通知轻提一声“回来看方寸”。一次挂机最多弹一次，回来即重置；关掉则完全不轮询。</div>
      <label style="display:flex;align-items:center;gap:8px;">
        <!-- 2026-10-17 暮雨第 4 条：“关了五次都没用，每次打开设置发现它都是勾选的”——
             真因不是存储坏了，是**改完不点“保存挂机设置”就关掉设置页 = 没保存**，
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
    <!-- MCP 写口（2026-11-11 卡《MCP 写口无闸》）：暮雨亲口点的越界 ——
         “接上就能写数据”此前没有任何闸。三档 + 写侧清单（含被拒的尝试）。 -->
    <div class="sect" v-show="active">
      <h4>🔐 MCP 写入（agent 能写什么）</h4>
      <div class="hint">
        默认「读写」：agent 可以建卡 / 改卡 / 写规划；删卡、改分、驳回类流转仍被拒。
        「只读」档下 agent 连一次写都做不了。改档本身也留痕（谁、何时、从哪档到哪档）。
      </div>
      <label v-for="m in writeModes" :key="m.mode" style="display:flex;align-items:flex-start;gap:8px;">
        <input class="font-[inherit]" type="radio" :value="m.mode" v-model="writeMode" :disabled="writeBusy" @change="saveWriteMode" />
        <span>
          <b>{{ m.label }}</b>
          <span class="hint" style="display:block">{{ m.hint }}</span>
        </span>
      </label>
      <div class="hint" v-if="writeMsg" :style="writeMsgBad ? 'color:#b91c1c' : ''">{{ writeMsg }}</div>
      <div class="sect-btns">
        <button class="ghost font-[inherit]" :disabled="writeBusy" @click="loadWrites">刷新最近写入</button>
      </div>
      <div class="hint">
        最近 {{ writeRows.length }} 次由 agent 发起的写入（含被拒的尝试）。留痕只记关键字段，正文折成长度。
      </div>
      <table class="mcp-writes" v-if="writeRows.length">
        <thead>
          <tr><th>时间</th><th>客户端</th><th>工具</th><th>结果</th><th>落点</th></tr>
        </thead>
        <tbody>
          <tr v-for="(w, i) in writeRows" :key="i" :class="{ bad: !w.ok }">
            <td>{{ fmtWriteTime(w.ts) }}</td>
            <td>{{ w.client || '—' }}</td>
            <td>{{ w.via }}</td>
            <td :title="w.error || ''">{{ w.ok ? '成功' : (w.error || '被拒') }}</td>
            <td>{{ writeTarget(w) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="hint" v-else>还没有 agent 写过任何东西。</div>
    </div>
    <!-- 2026-09-23：Agent 预设列表可编辑（用户要求：自定义功能多一点） -->
    <div class="sect" v-show="active">
      <h4>🤖 Agent 预设列表</h4>
      <div class="hint">日志视图的“执行 Agent”筛选下拉会读这里的预设。增删后自动保存到浏览器本地。</div>
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

<style scoped>
.mcp-writes { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; }
.mcp-writes th { text-align: left; font-weight: 600; opacity: .7; padding: 3px 6px; border-bottom: 1px solid rgba(127,127,127,.3); }
.mcp-writes td { padding: 3px 6px; border-bottom: 1px solid rgba(127,127,127,.14); vertical-align: top; }
.mcp-writes tr.bad td { color: #b91c1c; }
</style>
