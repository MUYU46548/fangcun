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
          <b>“让 AI 答”什么时候出现？</b>只有结构化真算不出来的时候（比如“这事该怎么办”这类要判断的问题）——
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
          <button class="ghost ask-llm-btn" v-if="ctl.askAns.needsLlm" :disabled="ctl.askLlmBusy" @click="ctl.askToLlm()">
            {{ ctl.askLlmBusy ? 'AI 正在答…' : '让 AI 答（这次会计费）' }}
          </button>
          <!-- 出单（2026-10-22 · 03 任务三）：从台账 + 决策卡派生下一批任务卡。
               一次调用 = 一批；产出只落“待审批”（点头才转正）。这是全应用**第二处**会
               为规划花 token 的入口（另一处是上面的模糊问答）。 -->
          <button class="ghost ask-llm-btn ask-batch-btn" v-if="ctl.askAns.projectId" :disabled="ctl.batchBusy" @click="ctl.runBatch()">
            {{ ctl.batchBusy ? '正在出…' : '📋 出下一批任务卡（会计费）' }}
          </button>
        </div>
        <!-- 随纠（2026-10-22 · 03 任务二）：从这条答案直接改这个项目的方向 ——
             一句话 + 一次点击，不填表单。改完挂撤销条（Ctrl+Z 同效），决策卡自动留痕。
             只认固定句式（改 <字段> 为 <值>）：不猜，参数清。 -->
        <div class="ask-correct" v-if="ctl.askAns.projectId">
          <button class="ghost ask-correct-open" v-if="!ctl.correctOpen" @click="ctl.openCorrect()">
            ✎ 一句话改这个项目（状态 / 路线图 / 说明）
          </button>
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

        <div class="ask-llm-ans" v-if="ctl.askLlmAns">
          <div class="ala-h">AI 的回答<em class="ala-meta" v-if="ctl.askLlmMeta">{{ ctl.askLlmMeta }}</em></div>
          <div class="ala-t">{{ ctl.askLlmAns }}</div>
        </div>
        <div class="ask-llm-err" v-if="ctl.askLlmErr">{{ ctl.askLlmErr }}</div>
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
        <div class="ask-report-row" v-for="m in ctl.usageMonths" :key="m.month">
          <span class="arr-m">{{ m.month }}</span>
          <span class="arr-c">{{ m.calls }} 次<em v-if="m.fail">（失败 {{ m.fail }}）</em></span>
          <span class="arr-t">{{ Number(m.total_tokens || 0).toLocaleString() }} tokens<em v-if="m.token_calls < m.calls">· {{ m.calls - m.token_calls }} 次没给数字，只计数</em><em v-if="m.external_calls" class="arr-ext">· 其中 {{ m.external_calls }} 笔是外部上报</em></span>
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

      <!-- 账户口径（2026-10-25 卡 005）：这一行**不是估算**，是官方余额接口的差值。
           暮雨给的参考实现点破了关键 —— 准的办法是不经过价格表：价格怎么变，
           余额下降额都是真花掉的钱。代价（粒度粗、要充值不混进消费）也写在这里。 -->
      <div class="ask-acc" v-if="ctl.balanceStatus">
        <div class="ask-report-h">
          账户口径 · 余额差值
          <em class="ask-report-src">
            {{ ctl.balanceStatus.supported ? '来自供应商余额接口，不是按 token 估算' : '这一口径不可用' }}
          </em>
        </div>
        <template v-if="ctl.balanceStatus.supported">
          <div class="ask-acc-row">
            <span class="arr-m">{{ ctl.providerLabel(ctl.balanceStatus.provider) }}</span>
            <span class="arr-c">观测 {{ ctl.balanceStatus.observations }} 次</span>
            <span class="arr-t">
              已观测消费 <b>{{ ctl.balanceStatus.spent }} {{ ctl.balanceStatus.currency }}</b>
              <em v-if="Number(ctl.balanceStatus.recharged) > 0">· 另有充值 {{ ctl.balanceStatus.recharged }}</em>
            </span>
          </div>
          <div class="ask-acc-note">
            <span v-if="ctl.balanceStatus.note">{{ ctl.balanceStatus.note }}</span>
            <span v-else>这是账户真实扣款（两次观测之间的差额），<b>归不到具体某一次调用</b>；逐笔要看上面的 token。</span>
            <button class="ghost ask-acc-btn" :disabled="ctl.balanceObserving" @click="ctl.refreshBalance">
              {{ ctl.balanceObserving ? '查…' : '⟳ 立刻查一次' }}
            </button>
          </div>
        </template>
        <div class="ask-acc-note" v-else>{{ ctl.balanceStatus.reason }}</div>
      </div>
    </main>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'

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

onMounted(() => { void ctl.initAsk() })
</script>
