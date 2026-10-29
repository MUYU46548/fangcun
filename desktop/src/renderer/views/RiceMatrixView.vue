<!--
  需求矩阵（RICE 决策矩阵）—— 项目页第 7 种摆法（2026-10-28）

  施工输入：
    · 《方寸-RICE打分口径-20261024.md》v1.1（四维口径 / 证据映射 / 池宿主 / 拍板回写）
    · 《方寸-RICE格式闸结论-全栈-20261024.md》schema v1（节式格式 / 两个 MCP 写工具 / 验收线）
    · 设计判断与「为什么不再丢」：docs/ADR-002-需求矩阵.md

  口径全在 shared/rice.ts（e2e-rice 纯 Node 跑），这里只管摆与手改。
  三条必须出现在界面上：
   ① **总分不落盘** —— 池里只有 R/I/C/E，总分与等级现算；
   ② **分数不替人做决定** —— 等级只是池内相对位置，拍板是用户动作；
   ③ **每个数字带得走局限** —— 页面底部常驻 RICE_LIMITS，不许只有数字。
  ⚠ 零网络：只走 window.tegula 上的 rice 系列通道（本地文件 IPC）。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  RICE_EVIDENCE_LEVELS,
  RICE_EVIDENCE_TO_C,
  RICE_EMPTY_TEXT,
  RICE_LIMITS,
  RICE_STANCE,
  RICE_RECHECK,
  riceWhyReview,
  RICE_IMPACT_VALUES,
  RICE_CONFIDENCE_VALUES,
  levelOfMap,
  riceGeometry,
  riceSummary,
  scoreOf,
  type RiceItem,
  type RicePool,
} from '../../shared/rice'
import { toPlain } from '../../shared/plain'

const props = defineProps<{ toast?: (m: string) => void }>()

const loading = ref(false)
const saving = ref(false)
const err = ref('')
const poolPath = ref('')
const budget = ref(0)
const items = ref<RiceItem[]>([])
const filter = ref<'all' | 'P0' | 'P1' | 'P2' | 'CUT' | 'pending'>('all')
const highlight = ref('')
const tip = (m: string) => { if (props.toast) props.toast(m) }

function poolOf(): RicePool {
  return { budget: budget.value, items: items.value }
}

async function load() {
  loading.value = true
  err.value = ''
  try {
    const r: any = await (window as any).tegula.riceGet()
    if (!r || r.ok === false) {
      err.value = String(r?.error || '读取池失败')
      return
    }
    poolPath.value = String(r.path || '')
    budget.value = Number(r.pool?.budget) || 0
    items.value = Array.isArray(r.pool?.items) ? r.pool.items : []
  } catch (e: any) {
    err.value = String(e?.message || e || '读取池失败')
  } finally {
    loading.value = false
  }
}
onMounted(load)

/** 手改单条：走 upsert（幂等写），回来直接用主进程回传的整池重绘 —— 不自己猜合入结果 */
async function patch(it: RiceItem, patch: Record<string, any>) {
  if (saving.value) return
  saving.value = true
  try {
    const payload = {
      eid: it.eid,
      title: it.title,
      origin: it.origin,
      R: it.R,
      I: it.I,
      C: it.C,
      E_days: it.E_days,
      E_cost: it.E_cost,
      evidence: it.evidence,
      note: it.note,
      by: '页签手改 ' + today(),
      ...patch,
    }
    const r: any = await (window as any).tegula.riceUpsert(toPlain([payload]), toPlain({ by: '页签手改' }))
    if (!r || r.ok === false) {
      tip(String(r?.error || '保存失败'))
      return
    }
    if (Array.isArray(r.rejected) && r.rejected.length) {
      tip(r.rejected[0].error || '这条被拒了')
      return
    }
    if (r.pool) {
      budget.value = Number(r.pool.budget) || 0
      items.value = Array.isArray(r.pool.items) ? r.pool.items : []
    }
    tip('已保存，总分与等级已重算')
  } catch (e: any) {
    tip(String(e?.message || e || '保存失败'))
  } finally {
    saving.value = false
  }
}

function onEvidence(it: RiceItem, v: string) {
  const c = RICE_EVIDENCE_TO_C[v]
  void patch(it, { evidence: v, C: c === undefined ? it.C : c })
}

function onEvidenceEv(it: RiceItem, e: Event) {
  onEvidence(it, (e.target as HTMLSelectElement).value)
}

function onNum(it: RiceItem, field: 'R' | 'I' | 'C' | 'E_days' | 'E_cost', e: Event) {
  const el = e.target as HTMLInputElement
  const n = Number(el.value)
  if (!Number.isFinite(n)) {
    tip('要填数字')
    return
  }
  void patch(it, { [field]: n })
}

async function setBudget() {
  const n = Number(budget.value)
  if (!Number.isFinite(n) || n < 0) return tip('月预算要填非负数')
  const r: any = await (window as any).tegula.riceSetBudget(n)
  if (!r || r.ok === false) return tip(String(r?.error || '预算保存失败'))
  if (r.pool) {
    budget.value = Number(r.pool.budget) || 0
    items.value = Array.isArray(r.pool.items) ? r.pool.items : []
  }
  tip('月预算已存进 rice-pool.md')
}

function today() {
  const d = new Date()
  const m = d.getMonth() + 1
  const day = d.getDate()
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day)
}

/** 拍板是**用户动作**：页面按钮 = 用户点，agent 不代拍 */
async function decide(it: RiceItem, cut: boolean) {
  if (cut && !confirm(`把「${it.title}」记为 CUT（砍掉）？\n会在 decisions.md 记一张「已撤销」的决策卡，池里留痕不删。`)) return
  const status = cut ? '已撤销' : '有效'
  const r: any = await (window as any).tegula.riceDecide(
    toPlain([{ eid: it.eid, 状态: status }]),
    toPlain({ batch: 'rice-export-' + today().replace(/-/g, '') })
  )
  if (!r) return tip('落账失败：没有返回结果')
  if (r.ok === false && !(r.results && r.results.some((x: any) => x.ok))) {
    return tip(String(r.error || r.results?.[0]?.error || '落账失败'))
  }
  if (r.pool) {
    budget.value = Number(r.pool.budget) || 0
    items.value = Array.isArray(r.pool.items) ? r.pool.items : []
  }
  const one = (r.results || [])[0]
  tip(one && one.ok ? `已落账 ${one.decisionId}${one.exists ? '（已存在，幂等）' : ''}` : String(one?.error || '落账失败'))
}

const levels = computed(() => levelOfMap(items.value))
const summary = computed(() => riceSummary(poolOf()))
// 「为什么做，为什么砍」：分数只是入口，理由逐条 —— 拍板却没写理由的要被点名（原型第 3 条设计判断）
const why = computed(() => riceWhyReview(poolOf()))

/** 表格：按总分降序；总分算不出的排最后（不拿 0 假装有分） */
const rows = computed(() => {
  const list = items.value
    .map((it) => ({ it, s: scoreOf(it), level: levels.value[it.eid] || 'P2' }))
    .sort((a, b) => {
      const av = Number.isFinite(a.s) ? a.s : -Infinity
      const bv = Number.isFinite(b.s) ? b.s : -Infinity
      if (bv !== av) return bv - av
      return a.it.eid < b.it.eid ? -1 : 1
    })
  if (filter.value === 'all') return list
  if (filter.value === 'pending') return list.filter((r) => !r.it.verdict)
  return list.filter((r) => r.level === filter.value)
})

const W = 720
const H = 320
const PAD = 30
const geo = computed(() => riceGeometry(items.value, W, H, PAD))
const splitPx = computed(() => {
  const g = geo.value
  const innerW = W - PAD * 2
  const innerH = H - PAD * 2
  return {
    x: g.maxX > 0 ? PAD + (g.splitX / g.maxX) * innerW : W / 2,
    y: g.maxY > 0 ? H - PAD - (g.splitY / g.maxY) * innerH : H / 2,
  }
})

const levelCls: Record<string, string> = { P0: 'lv0', P1: 'lv1', P2: 'lv2', CUT: 'lvx' }
const coord = (n: number) => Math.round(n * 10) / 10
const scoreText = (n: number) => (Number.isFinite(n) ? String(n) : '—')

const filters = [
  { v: 'all', label: '全部' },
  { v: 'P0', label: 'P0' },
  { v: 'P1', label: 'P1' },
  { v: 'P2', label: 'P2' },
  { v: 'CUT', label: 'CUT' },
  { v: 'pending', label: '未拍板' },
] as const
</script>

<template>
  <div class="rice">
    <div class="rice-head">
      <span class="rice-ttl">需求矩阵</span>
      <span class="rice-sub">{{ summary.text }}</span>
      <span class="rice-grow"></span>
      <button class="ghost" :disabled="loading || saving" @click="load">
        {{ loading ? '⟳ 读取中…' : '↻ 刷新' }}</button>
    </div>

    <!-- 原型里那句写在最显眼处的立场：分数不替你做决定（不许只塞进底部局限列表） -->
    <div class="rice-stance">{{ RICE_STANCE }}</div>

    <div class="rice-where" v-if="poolPath">
      池文件：<code>{{ poolPath }}</code>
      <span class="rice-where-hint">（分数只存 R/I/C/E 四个原始分；总分与等级由本页现算，不落盘）</span>
    </div>

    <div class="rice-budget">
      <label>月预算（元）</label>
      <input class="rice-num" type="number" min="0" step="1" v-model.number="budget" @change="setBudget" />
      <span class="rice-budget-hint" v-if="summary.budget > 0">
        P0 花费 ¥{{ summary.p0Cost }} / ¥{{ summary.budget }}
        <b :class="{ over: summary.guard === 'over' || summary.guard === 'tight' }">{{ Math.round((summary.budgetRatio || 0) * 100) }}%</b>
        · 余量 ¥{{ summary.headroom }}
      </span>
      <span class="rice-budget-hint" v-else>预算未设置 —— 页面不会把「没设预算」说成「没超支」</span>
      <span class="rice-guard" :class="summary.guard">{{ summary.guardText }}</span>
    </div>

    <div v-if="err" class="rice-err">{{ err }}</div>
    <div v-else-if="!items.length" class="rice-empty">
      <div>{{ RICE_EMPTY_TEXT }}</div>
      <div class="rice-empty-sub">
        池文件不存在时这里是空的，<b>不是</b>读取失败；灌入后会出现在下方表格与散点里。
      </div>
    </div>

    <template v-else>
      <!-- 散点：横轴成本（天），纵轴 RICE，气泡大小 = 使用频次 -->
      <div class="rice-chart">
        <svg :viewBox="`0 0 ${W} ${H}`" class="rice-svg" role="img" aria-label="RICE 决策矩阵散点图">
          <rect :x="PAD" :y="PAD" :width="W - PAD * 2" :height="H - PAD * 2" class="rice-plot" />
          <!-- 象限分割线（成本中位 / 得分中位） -->
          <line :x1="splitPx.x" :y1="PAD" :x2="splitPx.x" :y2="H - PAD" class="rice-split" />
          <line :x1="PAD" :y1="splitPx.y" :x2="W - PAD" :y2="splitPx.y" class="rice-split" />
          <text :x="PAD + 6" :y="PAD + 14" class="rice-quad">高收益 · 低成本（优先做）</text>
          <text :x="W - PAD - 6" :y="PAD + 14" class="rice-quad" text-anchor="end">高收益 · 高成本（要想清楚）</text>
          <text :x="PAD + 6" :y="H - PAD - 8" class="rice-quad">低收益 · 低成本（顺手）</text>
          <text :x="W - PAD - 6" :y="H - PAD - 8" class="rice-quad" text-anchor="end">低收益 · 高成本（别做）</text>

          <circle
            v-for="p in geo.points" :key="p.eid"
            :cx="p.x" :cy="p.y" :r="p.r"
            class="rice-dot" :class="[levelCls[p.level], { on: highlight === p.eid }]"
            @click="highlight = p.eid"
          >
            <title>{{ p.title }}｜RICE {{ p.score }}｜{{ p.level }}｜{{ p.quadrant }}</title>
          </circle>

          <text :x="W - PAD" :y="H - 6" class="rice-axis" text-anchor="end">成本（天）→</text>
          <text :x="PAD - 8" :y="PAD + 2" class="rice-axis" text-anchor="end">得分</text>
        </svg>
        <div class="rice-legend">
          <span v-for="p in geo.points" :key="'lg' + p.eid" class="rice-lg" :class="levelCls[p.level]">
            {{ p.level }} {{ p.title }}
          </span>
        </div>
      </div>

      <div class="rice-filters">
        <button v-for="f in filters" :key="f.v" class="ghost rice-fbtn" :class="{ on: filter === f.v }"
          @click="filter = f.v">{{ f.label }}</button>
        <span class="rice-grow"></span>
        <span class="rice-tip">点气泡高亮同行；改任一分项立即重算并落盘</span>
      </div>

      <div class="rice-tablewrap">
        <table class="rice-table">
          <thead>
            <tr>
              <th>等级</th><th>需求</th><th>来源</th>
              <th>R 频次</th><th>I 省工</th><th>C 信心</th><th>E 天</th><th>E 元</th>
              <th>证据</th><th>总分</th><th>拍板</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.it.eid" :class="{ on: highlight === r.it.eid }" @click="highlight = r.it.eid">
              <td><span class="rice-lv" :class="levelCls[r.level]">{{ r.level }}</span></td>
              <td class="rice-name">
                <div class="rice-title" :title="(r.it.note ? r.it.note + '\n' : '') + '打分：' + (r.it.by || '—')">{{ r.it.title }}</div>
                <div class="rice-eid">{{ r.it.eid }}</div>
              </td>
              <td class="rice-origin">{{ r.it.origin }}</td>
              <td><input class="rice-num" type="number" min="0" step="1" :value="r.it.R"
                @change="onNum(r.it, 'R', $event)" /></td>
              <td>
                <select class="rice-sel" :value="r.it.I" @change="onNum(r.it, 'I', $event)">
                  <option v-for="v in RICE_IMPACT_VALUES" :key="v" :value="v">{{ v }}</option>
                </select>
              </td>
              <td>
                <select class="rice-sel" :value="r.it.C" @change="onNum(r.it, 'C', $event)">
                  <option v-for="v in RICE_CONFIDENCE_VALUES" :key="v" :value="v">{{ v }}</option>
                </select>
              </td>
              <td><input class="rice-num" type="number" min="1" step="1" :value="r.it.E_days"
                @change="onNum(r.it, 'E_days', $event)" /></td>
              <td><input class="rice-num" type="number" min="0" step="1" :value="r.it.E_cost"
                @change="onNum(r.it, 'E_cost', $event)" /></td>
              <td>
                <select class="rice-sel" :value="r.it.evidence" @change="onEvidenceEv(r.it, $event)">
                  <option v-for="v in RICE_EVIDENCE_LEVELS" :key="v" :value="v">{{ v }}</option>
                </select>
              </td>
              <td class="rice-score" :title="`R${r.it.R} × I${r.it.I} × C${r.it.C} ÷ E${r.it.E_days}`">{{ scoreText(r.s) }}</td>
              <td class="rice-verdict">
                <template v-if="r.it.verdict">
                  <span class="rice-vd" :class="{ cut: r.it.verdict === 'CUT' }">{{ r.it.verdict }}</span>
                  <span class="rice-did">{{ r.it.decisionId }}</span>
                </template>
                <template v-else>
                  <button class="ghost rice-vbtn" :disabled="saving" @click.stop="decide(r.it, false)">有效</button>
                  <button class="ghost rice-vbtn cut" :disabled="saving" @click.stop="decide(r.it, true)">CUT</button>
                </template>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="11" class="rice-none">这个筛选下没有条目（换「全部」看看）</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- 「为什么做，为什么砍」（2026-10-29 暮雨第 1 条 · 原型第 3 条设计判断）：
         分数只是入口，理由逐条写；拍板却没写理由的条目必须被点名 —— 那就是没拍板。
         被砍项的判据来自原型原话：「它最危险的地方是听起来很酷」。 -->
    <div class="rice-why" v-if="items.length">
      <div class="rice-why-h">
        为什么做，为什么砍
        <span class="rice-why-sub">{{ why.text }}</span>
      </div>
      <div class="rice-why-cols" v-if="why.keep.length || why.cut.length">
        <div class="rice-why-col">
          <div class="rice-why-t">✓ 做（{{ why.keep.length }}）</div>
          <div class="rice-why-row" v-for="r in why.keep" :key="'k' + r.eid">
            <b>{{ r.title }}</b>
            <span class="rice-why-reason" :class="{ missing: !r.hasWhy }">
              {{ r.hasWhy ? r.why : '⚠ 拍板时没写理由 —— 说不清为什么，就是没拍板' }}
            </span>
            <span class="rice-why-ev" v-if="r.evidence">证据：{{ r.evidence }}</span>
          </div>
          <div class="rice-why-none" v-if="!why.keep.length">还没有决定要做的</div>
        </div>
        <div class="rice-why-col">
          <div class="rice-why-t cut">✕ 砍（{{ why.cut.length }}）</div>
          <div class="rice-why-row" v-for="r in why.cut" :key="'c' + r.eid">
            <b>{{ r.title }}</b>
            <span class="rice-why-reason" :class="{ missing: !r.hasWhy }">
              {{ r.hasWhy ? r.why : '⚠ 砍了却没写理由 —— 下次它还会以「听起来很酷」的样子回来' }}
            </span>
            <span class="rice-why-ev" v-if="r.evidence">证据：{{ r.evidence }}</span>
          </div>
          <div class="rice-why-none" v-if="!why.cut.length">还没有砍掉的</div>
        </div>
      </div>
      <div class="rice-why-empty" v-else>
        还没有拍板记录 —— 在表格里点「有效 / CUT」，把理由写进备注，这里就是这季度取舍的底稿。
      </div>
      <div class="rice-why-foot">{{ RICE_RECHECK }}</div>
    </div>

    <div class="rice-limits">
      <div class="rice-limits-h">这页证明不了什么</div>
      <div class="rice-limit" v-for="(l, i) in RICE_LIMITS" :key="i">· {{ l }}</div>
    </div>
  </div>
</template>

<style scoped>
/* 新块用自己的 .rice-* 类：不复用旧块的 class（旧断言按 class 数块会凭空变红，见 AGENTS 踩坑 2） */
.rice { padding: 14px 18px 24px; color: var(--ink); }
.rice-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.rice-ttl { font-size: 16px; font-weight: 700; }
.rice-sub { font-size: 12px; color: var(--muted); }
.rice-grow { flex: 1; }
.rice-where { margin-top: 6px; font-size: 12px; color: var(--muted); }
.rice-where code { background: var(--tint-3); border: 1px solid var(--border); border-radius: 6px; padding: 1px 5px; color: var(--ink); }
.rice-where-hint { margin-left: 6px; }
.rice-budget { margin-top: 10px; display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
.rice-budget label { font-weight: 600; color: var(--ink); }
.rice-budget-hint b { color: var(--success); }
.rice-budget-hint b.over { color: var(--danger); }
.rice-guard { flex-basis: 100%; font-size: 11.5px; color: var(--muted); }
.rice-guard.tight { color: var(--warning); }
.rice-guard.over { color: var(--danger); }
.rice-stance { margin-top: 8px; font-size: 12.5px; color: var(--ink); font-weight: 600; }
.rice-why { margin-top: 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); padding: 12px 14px; }
.rice-why-h { font-size: 13px; font-weight: 700; }
.rice-why-sub { margin-left: 8px; font-weight: 400; font-size: 11.5px; color: var(--muted); }
.rice-why-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 10px; }
.rice-why-t { font-size: 12px; font-weight: 600; color: var(--success); margin-bottom: 6px; }
.rice-why-t.cut { color: var(--danger); }
.rice-why-row { padding: 6px 0; border-top: 1px dashed var(--border); font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
.rice-why-row b { font-weight: 600; }
.rice-why-reason { color: var(--muted); line-height: 1.55; }
.rice-why-reason.missing { color: var(--warning); }
.rice-why-ev { color: var(--muted); font-size: 11.5px; }
.rice-why-none, .rice-why-empty { font-size: 11.5px; color: var(--muted); }
.rice-why-empty { margin-top: 10px; }
.rice-why-foot { margin-top: 10px; font-size: 11.5px; color: var(--muted); }
.rice-err { margin-top: 14px; padding: 10px 12px; border: 1px solid var(--danger); border-radius: 10px; color: var(--danger); background: var(--card); }
.rice-empty { margin-top: 18px; padding: 18px; border: 1px dashed var(--line-2); border-radius: var(--radius); background: var(--tint-3); }
.rice-empty-sub { margin-top: 8px; font-size: 12px; color: var(--muted); }
.rice-chart { margin-top: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); padding: 8px; }
.rice-svg { width: 100%; height: auto; display: block; }
.rice-plot { fill: var(--tint-3); stroke: var(--border); }
.rice-split { stroke: var(--line-2); stroke-dasharray: 4 4; }
.rice-quad { font-size: 10px; fill: var(--muted); }
.rice-axis { font-size: 10px; fill: var(--muted); }
.rice-dot { stroke: var(--card); stroke-width: 1.5; cursor: pointer; opacity: 0.85; }
.rice-dot:hover, .rice-dot.on { opacity: 1; stroke: var(--ink); stroke-width: 2; }
.rice-dot.lv0 { fill: var(--accent); }
.rice-dot.lv1 { fill: var(--warning); }
.rice-dot.lv2 { fill: var(--muted); }
.rice-dot.lvx { fill: var(--danger); }
.rice-legend { display: flex; flex-wrap: wrap; gap: 10px; padding: 4px 6px 6px; font-size: 11px; color: var(--muted); }
.rice-lg::before { content: '●'; margin-right: 4px; }
.rice-lg.lv0::before { color: var(--accent); }
.rice-lg.lv1::before { color: var(--warning); }
.rice-lg.lv2::before { color: var(--muted); }
.rice-lg.lvx::before { color: var(--danger); }
.rice-filters { display: flex; align-items: center; gap: 6px; margin: 12px 0 8px; flex-wrap: wrap; }
.rice-fbtn.on { background: var(--tint); border-color: var(--accent); color: var(--accent); }
.rice-tip { font-size: 11px; color: var(--muted); }
.rice-tablewrap { overflow: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); }
.rice-table { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 1020px; }
.rice-table th, .rice-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: middle; }
.rice-table th { position: sticky; top: 0; background: var(--tint-3); font-weight: 600; color: var(--muted); white-space: nowrap; }
.rice-table tr.on { background: var(--tint-2); }
.rice-name { min-width: 190px; }
.rice-title { font-weight: 600; }
.rice-eid, .rice-origin { font-size: 11px; color: var(--muted); }
.rice-num { width: 58px; padding: 3px 5px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--ink); }
.rice-sel { padding: 3px 4px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--ink); max-width: 104px; }
.rice-score { font-weight: 700; white-space: nowrap; }
.rice-lv { display: inline-block; min-width: 30px; text-align: center; padding: 1px 6px; border-radius: 999px; font-size: 11px; font-weight: 700; }
.rice-lv.lv0 { color: var(--card); background: var(--accent); }
.rice-lv.lv1 { color: var(--card); background: var(--warning); }
.rice-lv.lv2 { color: var(--ink); background: var(--tint); }
.rice-lv.lvx { color: var(--card); background: var(--danger); }
.rice-verdict { white-space: nowrap; }
.rice-vd { font-weight: 600; margin-right: 6px; }
.rice-vd.cut { color: var(--danger); }
.rice-did { font-size: 11px; color: var(--muted); }
.rice-vbtn { padding: 2px 8px; font-size: 11px; margin-right: 4px; }
.rice-vbtn.cut { color: var(--danger); }
.rice-none { color: var(--muted); text-align: center !important; padding: 14px !important; }
.rice-limits { margin-top: 14px; padding: 10px 12px; border: 1px dashed var(--line-2); border-radius: 10px; background: var(--tint-3); }
.rice-limits-h { font-size: 12px; font-weight: 700; margin-bottom: 4px; }
.rice-limit { font-size: 11px; color: var(--muted); line-height: 1.6; }
</style>
