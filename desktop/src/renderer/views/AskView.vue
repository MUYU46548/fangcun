<template>
    <main id="board" class="ask-view">
      <div class="ask-head">
        <div class="ask-lead">问一句，方寸手里的事实直接答</div>
        <div class="ask-lead-sub">
          项目台账、任务卡、执行日志、AI 花销都在这儿，不用一页页翻。
          答不了会明说“不知道”，不编。
        </div>
      </div>
      <div class="ask-box">
        <div class="ask-row">
          <input class="ask-in" v-model="ctl.askQ" :disabled="ctl.askBusy"
                 placeholder="比如：方寸到哪了 / 欠着什么 / 哪个项目停着"
                 @keyup.enter="ctl.runAsk()" />
          <button class="pri ask-go" :disabled="ctl.askBusy || !ctl.askQ.trim()" @click="ctl.runAsk()">{{ ctl.askBusy ? '查…' : '查一下' }}</button>
        </div>
        <div class="ask-groups">
          <div class="ask-group" v-for="g in ctl.askGroups" :key="g.name">
            <span class="ask-group-k" v-if="ctl.askGroups.length > 1">{{ g.name }}</span>
            <button class="ghost ask-chip" v-for="p in g.items" :key="p.label"
                    :title="p.hint" :disabled="ctl.askBusy" @click="ctl.askQuick(p.q)">{{ p.label }}</button>
          </div>
        </div>
        <div class="ask-hint">
          这一页不花钱：答案都从台账现算。点上面任一个，或者自己写一句。
          <br />
          <b>“打包给 DSH”什么时候出现？</b>只有结构化真算不出来的时候（比如“这事该怎么办”这类要判断的问题）——
          方寸不再调自己的模型，只把问题 + 台账事实打包复制，你粘到 DSH 里用你配的模型回答。
          出现就一定给，不出现就是这题已经答完了，不用猜。
        </div>
      </div>

      <div class="ask-ans" v-if="ctl.askAns">
        <div class="ask-title">{{ ctl.askAns.title }}</div>
        <div class="ask-line" v-for="(l, i) in ctl.askAns.lines" :key="'al' + i">{{ l }}</div>
        <div class="ask-rows" v-if="ctl.askAns.rows && ctl.askAns.rows.length">
          <div class="ask-item" v-for="(r, i) in ctl.askAns.rows" :key="'ar' + i">
            <span class="ask-k">{{ r.k }}</span>
            <span class="ask-v">{{ r.v }}<em class="ask-sub" v-if="r.sub">{{ r.sub }}</em></span>
          </div>
        </div>
        <div class="ask-foot">
          <span class="ask-src" v-if="ctl.askAns.source">来源：{{ ctl.askAns.source }}</span>
          <Button class="ask-llm-btn" variant="ghost" size="tool" v-if="ctl.askAns.needsLlm" @click="ctl.askToDshPackage()">
            📋 打包给 DSH（不调模型）
          </Button>
          <!-- 出单（2026-10-22 · 03 任务三）：从台账 + 决策卡派生下一批任务卡。
               一次调用 = 一批；产出只落“待审批”（点头才转正）。这是全应用**第二处**会
               为规划花 token 的入口（另一处是上面的模糊问答）。 -->
          <Button class="ask-llm-btn ask-batch-btn" data-cost variant="ghost" size="tool" v-if="ctl.askAns.projectId" :disabled="ctl.batchBusy" @click="ctl.runBatch()">
            {{ ctl.batchBusy ? '正在出…' : '📋 出下一批任务卡（会计费）' }}
          </Button>
        </div>
        <!-- 随纠（2026-10-22 · 03 任务二）：从这条答案直接改这个项目的方向 ——
             一句话 + 一次点击，不填表单。改完挂撤销条（Ctrl+Z 同效），决策卡自动留痕。
             只认固定句式（改 <字段> 为 <值>）：不猜，参数清。 -->
        <div class="ask-correct" v-if="ctl.askAns.projectId">
          <Button class="ask-correct-open" variant="ghost" size="tool" v-if="!ctl.correctOpen" @click="ctl.openCorrect()">
            ✎ 一句话改这个项目（状态 / 路线图 / 说明）
          </Button>
          <template v-else>
            <div class="ask-correct-row">
              <input class="ask-in" v-model="ctl.correctText" :disabled="ctl.correctBusy"
                     placeholder="改 路线图 为 跑通第一单（项目名可省）" @keyup.enter="ctl.runCorrect()" />
              <button class="pri ask-go" :disabled="ctl.correctBusy || !ctl.correctText.trim()" @click="ctl.runCorrect()">
                {{ ctl.correctBusy ? '改…' : '就这么改' }}
              </button>
              <button class="ghost ask-chip" :disabled="ctl.correctBusy" @click="ctl.closeCorrect()">算了</button>
            </div>
            <div class="ask-correct-hint">
              能改的就三个字段：状态 / 路线图 / 说明（说明就是“欠着”那一栏）。
              改完自动记一张决策卡（出处“方寸随纠”），顶部撤销条能一步退回去。
            </div>
            <div class="ask-correct-err" v-if="ctl.correctErr">{{ ctl.correctErr }}</div>
          </template>
        </div>

        <!-- D-151（2026-11-20）：方寸不再调自己的模型答模糊题；按钮只打包给 DSH，不调 llm:ask。 -->
      </div>


      <!-- 月度花销报表（2026-10-22 · 03 任务三）：**常驻**在这一页底部，不用翻设置页。
           为什么要按自然月而不是"近 30 天"：1 号那天滚动窗口会把上个月的账算进"本月"，
           用户一核对就发现数字对不上 —— 报表错一次就没人再信它。
           ⚠ 只算供应商真报了 usage 的调用，没报的只计数、不折算（10-17 口径）。 -->
      <div class="ask-report" v-if="ctl.usageMonths.length">
        <div class="ask-report-h">
          AI 花销 · 按自然月
          <em class="ask-report-src">数据源：本机 AI 调用留痕（外部客户端经 MCP 上报的另计，不混算）</em>
        </div>
        <div class="usage-dash" data-usage-chart v-if="currentValue">
          <div class="usage-dash-h">
            用量概览
            <em>本机 AI 留痕 · 只算供应商报了 usage 的调用 · 口径：实测，不按 token 估钱</em>
          </div>
          <div class="usage-cards">
            <div class="usage-card" data-ucard="tokens">
              <div class="uc-label">{{ isCurrentMonth ? '本月 TOKEN（新输入 + 输出）' : (currentValue.month + ' TOKEN · 本月还没有调用') }}</div>
              <div class="uc-big">{{ fmtTok(currentTokens) }}</div>
              <div class="uc-sub">
                新输入 {{ fmtTok(currentValue.new_input_tokens) }} · 输出 {{ fmtTok(currentValue.completion_tokens) }}
                <em v-if="currentValue.cache_read_tokens">缓存重读 {{ fmtTok(currentValue.cache_read_tokens) }} 不计</em>
              </div>
              <div class="uc-spark" aria-label="每日 token 柱">
                <i v-for="d in currentDays" :key="'t' + d.date" data-uday="tokens"
                  :style="{ height: dayPct(d) }"
                  :title="d.date + ' · ' + fmtTok(dayMain(d)) + ' tokens'"></i>
              </div>
            </div>
            <div class="usage-card" data-ucard="calls">
              <div class="uc-label">本月调用</div>
              <div class="uc-big">{{ currentValue.calls }}</div>
              <div class="uc-sub">
                成功 {{ currentValue.ok }} · 失败 {{ currentValue.fail }}
                <em>{{ currentValue.token_calls }} 次带 token</em>
              </div>
              <div class="uc-spark calls" aria-label="每日调用柱">
                <i v-for="d in currentDays" :key="'c' + d.date" data-uday="calls"
                  :style="{ height: callsPct(d) }"
                  :title="d.date + ' · ' + d.calls + ' 次'"></i>
              </div>
            </div>
            <div class="usage-card" data-ucard="forecast">
              <div class="uc-label">按当前速度（不是限额）</div>
              <div class="uc-big">{{ fmtTok(projectedTokens) }}</div>
              <div class="uc-sub">
                预计本月 · 已过 {{ elapsedDays }} 天 · 日均 {{ fmtTok(avgDaily) }}
              </div>
              <div class="uc-note">
                方寸读不到你的订阅 5 小时/周/月配额，不编额度；
                只给本机实测与按已用天数外推。
              </div>
            </div>
          </div>

          <!-- Token 预算（2026-11-21 · 暮雨：“用户如果自设 token 预算可以图像化体现就更好了”）
               只做可视化：方寸读不到订阅的 5h/周/月配额，不拿它冒充“额度”。
               预算存 prefs（fc_usage_budget_tokens），未设时**不画 0% 环**——那会把“没设”说成“没超”。 -->
          <div class="usage-budget" data-usage-budget>
            <div class="ub-head">
              <b>本月 token 预算</b>
              <em>自己设上限，只做可视化，不是供应商配额</em>
              <span class="ub-grow"></span>
              <input class="ub-in" type="number" min="0" step="1000" v-model="budgetInput"
                     placeholder="例：5000000" @keyup.enter="saveBudget()" />
              <Button variant="outline" size="tool" @click="saveBudget()">保存</Button>
              <Button v-if="budgetTokens > 0" variant="outline" size="tool" @click="clearBudget()">清除</Button>
            </div>
            <div class="ub-body">
              <div v-if="budgetTokens > 0" class="ub-ring-wrap">
                <svg class="ub-ring" viewBox="0 0 36 36" data-budget-ring
                     :data-pct="budgetRingPct" :data-budget-state="budgetState">
                  <circle class="ub-ring-bg" cx="18" cy="18" r="15.9155" pathLength="100" />
                  <circle class="ub-ring-fg" cx="18" cy="18" r="15.9155" pathLength="100"
                          :stroke-dasharray="budgetRingDash" />
                </svg>
                <div class="ub-ring-text">
                  <b>{{ budgetState === 'over' ? '超 ' + budgetPctInt + '%' : budgetPctInt + '%' }}</b>
                  <span>{{ fmtTok(budgetUsed) }} / {{ fmtTok(budgetTokens) }}</span>
                </div>
              </div>
              <div v-else class="ub-unset">
                未设预算 —— 设了才会画环。<b>未设 ≠ 没超支</b>（方寸读不到你的订阅额度）。
              </div>
              <div class="ub-trend">
                <div class="ub-trend-h">近 14 天 token（新输入 + 输出）</div>
                <svg class="ub-bars" viewBox="0 0 280 80" preserveAspectRatio="none" aria-label="近 14 天 token 柱">
                  <rect v-for="(d, i) in last14" :key="d.date" :x="4 + i * 19.5" :y="barY(d)" width="14"
                        :height="barH(d)" rx="2" class="ub-bar" :class="{ empty: !d.tokens }"
                        data-ubar :data-empty="d.tokens ? '0' : '1'">
                    <title>{{ d.date }} · {{ fmtTok(d.tokens) }} tokens</title>
                  </rect>
                </svg>
                <div class="ub-axis">
                  <span>{{ last14.length ? last14[0].date.slice(5) : '' }}</span>
                  <span>{{ last14.length ? last14[last14.length - 1].date.slice(5) : '' }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="ask-report-row" v-for="m in ctl.usageMonths" :key="m.month">
          <span class="arr-m">{{ m.month }}</span>
          <span class="arr-c">{{ m.calls }} 次<em v-if="m.fail">（失败 {{ m.fail }}）</em></span>
          <span class="arr-t">新输入 <b>{{ Number(m.new_input_tokens || 0).toLocaleString() }}</b> · 输出 {{ Number(m.completion_tokens || 0).toLocaleString() }}<em>· total {{ Number(m.total_tokens || 0).toLocaleString() }} 为副列（含缓存重读 {{ Number(m.cache_read_tokens || 0).toLocaleString() }}）</em><em v-if="m.token_calls < m.calls">· {{ m.calls - m.token_calls }} 次没给数字，只计数</em><em v-if="m.external_calls" class="arr-ext">· 其中 {{ m.external_calls }} 笔是外部上报<em v-if="(m.unattributed_pct || 0) > 0">，未归因 {{ m.unattributed_pct }}%</em></em></span>
          <!-- 金额（2026-10-25 卡 005）：**没有就是“未折算”**，不写 0 元。
               “未折算”后面带上笔数 —— 否则那一行看起来像"全月只花这么点"。 -->
          <span class="arr-cost" :class="{ none: !m.cost_calls }">
            <template v-if="m.cost_calls">≈ ¥{{ ctl.fmtCost(m.cost) }}<em v-if="m.unpriced_calls">· {{ m.unpriced_calls }} 次未折算</em></template>
            <template v-else>未折算</template>
          </span>
        </div>
      </div>
      <div class="ask-report ask-report-empty" v-else>
        AI 花销 · 按自然月：还没有任何调用记录（一次都没走过 AI 通道）。
      </div>

      <!-- 跨渠道 token 对比（0.6.0 第 2 批 · 2026-11-02）
           口径：只比 token；金额列只转述记录里已有的标注（供应商自报 / 用户自填 / 未折算）；
           方寸不内置单价表、不猜单价；local 与 external 分开算，不做跨渠道金额合计。 -->
      <div class="chan-report" v-if="ctl.chanReport" data-chan-report>
        <div class="chan-head">
          <b>跨渠道 token 对比</b>
          <span class="chan-src">数据源：AI 调用留痕（方寸自己调的与外部客户端上报的分开算）</span>
          <span class="chan-grow"></span>
          <select class="chan-sel" v-model.number="ctl.chanDays" @change="ctl.loadChannels()">
            <option :value="7">近 7 天</option>
            <option :value="30">近 30 天</option>
            <option :value="90">近 90 天</option>
            <option :value="0">全部</option>
          </select>
          <select class="chan-sel" v-model="ctl.chanPick" @change="ctl.loadChannels()">
            <option value="">全部渠道</option>
            <option v-for="c in ctl.chanReport.channels" :key="c.key" :value="c.key">{{ c.label }}</option>
          </select>
        </div>
        <div class="chan-note">{{ ctl.chanReport.note }}</div>
        <div v-if="ctl.chanReadError" class="chan-err">读留痕失败：{{ ctl.chanReadError }}（这张表此刻不能说"没花钱"）</div>
        <div v-if="ctl.chanReport.rows.length" class="chan-grid">
          <div class="chan-row chan-row-head">
            <span class="chan-name">渠道</span>
            <span class="chan-num">调用</span>
            <span class="chan-num">输入</span>
            <span class="chan-num">输出</span>
            <span class="chan-num">合计 token</span>
            <span class="chan-money">金额</span>
          </div>
          <div class="chan-row" v-for="row in ctl.chanReport.rows" :key="row.key" :data-chan="row.key">
            <span class="chan-name">{{ row.label }}</span>
            <span class="chan-num">{{ row.calls }}</span>
            <span class="chan-num">{{ row.promptTokens.toLocaleString() }}</span>
            <span class="chan-num">{{ row.completionTokens.toLocaleString() }}</span>
            <span class="chan-num"><b>{{ row.totalTokens.toLocaleString() }}</b><em v-if="row.noTokenCalls" class="chan-noTok">· {{ row.noTokenCalls }} 次没给数字</em></span>
            <span class="chan-money" :class="{ none: row.money.kind === 'none' }">{{ row.money.text }}</span>
          </div>
          <div class="chan-row chan-row-total">
            <span class="chan-name">总计</span>
            <span class="chan-num">{{ ctl.chanReport.totals.calls }}</span>
            <span class="chan-num">{{ ctl.chanReport.totals.promptTokens.toLocaleString() }}</span>
            <span class="chan-num">{{ ctl.chanReport.totals.completionTokens.toLocaleString() }}</span>
            <span class="chan-num"><b>{{ ctl.chanReport.totals.totalTokens.toLocaleString() }}</b></span>
            <span class="chan-money">不跨渠道合计</span>
          </div>
        </div>
        <div v-else class="chan-empty">{{ ctl.chanReport.emptyText }}</div>
      </div>
    </main>
</template>

<script setup lang="ts">
import Button from '../components/ui/Button.vue'
import { computed, onMounted, ref } from 'vue'
import { readUiPref, saveUiPref } from '../prefs'

/**
 * 问答页（2026-11-03 · App.vue 拆分「视图刀」）
 *
 * 只搬模板：所有状态 / 取数 / 花销口径仍在 App.vue（下一刀再收进 useAsk）。
 * 进门自己拉一次：常用问题 / 月报表 / 跨渠道 token / 账户口径。
 */
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点 */
const askCtl = ctl

// 用量概览（参考 2026-11-17 的两张图）：本月大数 + 每日柱 + 按当前速度外推。
// 只画本机实测；方寸拿不到订阅的 5h/周/月限额，**不编额度**。
const currentValue = computed(() => ((ctl.usageMonths || [])[0] || null) as any)
const currentDays = computed(() => ((currentValue.value && currentValue.value.days) || []) as any[])
const dayMain = (d: any) => (Number(d && d.new_input_tokens) || 0) + (Number(d && d.completion_tokens) || 0)
const currentTokens = computed(() => (currentValue.value ? dayMain(currentValue.value) : 0))
const maxDay = computed(() => Math.max(1, ...currentDays.value.map(dayMain)))
const dayPct = (d: any) => `${Math.max(2, Math.min(100, dayMain(d) / maxDay.value * 100))}%`
const maxCalls = computed(() => Math.max(1, ...currentDays.value.map((d) => Number(d.calls) || 0)))
const callsPct = (d: any) => `${Math.max(2, Math.min(100, (Number(d.calls) || 0) / maxCalls.value * 100))}%`
const elapsedDays = computed(() => {
  const m = currentValue.value && currentValue.value.month
  if (!m) return 0
  const [y, mo] = String(m).split('-').map(Number)
  const now = new Date()
  if (now.getFullYear() === y && now.getMonth() + 1 === mo) return now.getDate()
  return new Date(y, mo, 0).getDate()
})
const avgDaily = computed(() => currentTokens.value / Math.max(1, elapsedDays.value))
const projectedTokens = computed(() => {
  const m = currentValue.value && currentValue.value.month
  if (!m) return 0
  const [y, mo] = String(m).split('-').map(Number)
  const dim = new Date(y, mo, 0).getDate()
  return Math.round(avgDaily.value * dim)
})
const fmtTok = (v: any) => {
  const n = Number(v) || 0
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return n.toLocaleString()
}

// ── 本月 token 预算（2026-11-21）────────────────────────────────────────
// 存储真身在 prefs.json（键 fc_usage_budget_tokens）；localStorage 只是同 origin 的读缓存。
// 未设 = 不画环（“未设 ≠ 没超支”）；超支时弧封顶 100%，文字写“超 X%”。
const BUDGET_KEY = 'fc_usage_budget_tokens'
const budgetTokens = ref(0)
const budgetInput = ref('')
/** 本地时区的 YYYY-MM（不能用 toISOString：东八区在月初/月末会差一天） */
function localMonthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const isCurrentMonth = computed(() => String(currentValue.value?.month || '') === localMonthKey())
/** 预算只跟**本月**比：拿上个月的数当本月，比没有更误导 */
const budgetUsed = computed(() => (isCurrentMonth.value ? currentTokens.value : 0))
const budgetPct = computed(() => (budgetTokens.value > 0 ? budgetUsed.value / budgetTokens.value * 100 : 0))
const budgetPctInt = computed(() => Math.max(0, Math.round(budgetPct.value)))
/** 环的弧封顶 100（超支靠颜色 + 文案说“超 X%”，不画超过一圈的荒谬图形） */
const budgetRingPct = computed(() => Math.min(100, Math.max(0, Math.round(budgetPct.value))))
const budgetState = computed(() => {
  if (budgetTokens.value <= 0) return 'unset'
  if (budgetPct.value > 100) return 'over'
  if (budgetPct.value >= 80) return 'tight'
  return 'ok'
})
const budgetRingDash = computed(() => {
  const p = Math.max(0, Math.min(100, budgetPct.value))
  return `${p} ${100 - p}`
})

/** 近 14 天：把最近两个月的 days 合起来、按本地日期补零（缺日 = 0 次，不是“读不到”） */
const dayMap = computed<Record<string, number>>(() => {
  const map: Record<string, number> = {}
  for (const month of (ctl.usageMonths || []).slice(0, 2)) {
    for (const d of (month && month.days) || []) {
      const key = String(d && d.date || '')
      if (!key) continue
      map[key] = (map[key] || 0) + dayMain(d)
    }
  }
  return map
})
const last14 = computed<{ date: string; tokens: number }[]>(() => {
  const out: { date: string; tokens: number }[] = []
  const now = new Date()
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = localDateKey(d)
    out.push({ date: key, tokens: dayMap.value[key] || 0 })
  }
  return out
})
const max14 = computed(() => Math.max(1, ...last14.value.map((d) => d.tokens)))
function barH(d: { tokens: number }): number {
  if (!d.tokens) return 1
  return Math.max(3, Math.min(72, d.tokens / max14.value * 72))
}
function barY(d: { tokens: number }): number {
  return 80 - barH(d)
}

function applyBudget(v: any): void {
  const n = Math.max(0, Math.floor(Number(v) || 0))
  budgetTokens.value = n
  budgetInput.value = n > 0 ? String(n) : ''
  saveUiPref(BUDGET_KEY, n)
}
function saveBudget(): void {
  applyBudget(budgetInput.value)
}
function clearBudget(): void {
  applyBudget(0)
}

onMounted(async () => {
  void ctl.initAsk()
  // 真身优先（localStorage 可能因为换 origin 被清空）
  try {
    const p: any = await (window as any).tegula?.prefsGet?.()
    const n = Math.max(0, Math.floor(Number(p?.[BUDGET_KEY]) || 0))
    budgetTokens.value = n
    budgetInput.value = n > 0 ? String(n) : ''
  } catch {
    const n = Math.max(0, Math.floor(Number(readUiPref<number>(BUDGET_KEY, 0)) || 0))
    budgetTokens.value = n
    budgetInput.value = n > 0 ? String(n) : ''
  }
})
</script>
