<!--
  作战计划（0.6.0 P1）—— 项目页第 8 种摆法

  **这一页只服务一个决策**：这张阶段卡**能不能冻结**（冻结了才允许往下推）。
  所以三块必须同时在场：技术方案 / 照抄点表 / 判据；缺一块就报红，且**不给"通过"**。

  三个动作（P1 判据写死，恰好三个、没有第四态）：
    通过   → 写 `状态: 已冻结` + `裁决: 通过 · 日期`
    打回   → 写 `打回理由:`（空理由不许提交 —— 空着等于没打回）
    改一句 → 修订记录多一行 + 状态退回“未冻结”

  数据真身在 `main/data/plans.ts`（行级就地改，不重写整篇）；组件只管显示与收集意图。
-->
<template>
  <div class="plan-view">
    <div class="plan-head">
      <h3>作战计划 · 裁决</h3>
      <span class="plan-sub">三块齐全才给"通过"；打回必须写理由；改一句会留痕并把状态退回未冻结</span>
      <button class="ghost plan-reload" @click="load()">⟳ 重读</button>
    </div>

    <!-- 待裁决清单（2026-11-02）—— 此前“待裁决”只藏在每张卡的状态胶囊里，
         而日志页的每日推进面只认“已冻结”，于是 7 张等裁决的卡在界面上等于不存在
         （暮雨原话：“待裁决的东西在哪里？没看见”）。这里给一个显式出口：
         几张、哪几张、缺什么，点一下滚过去。 -->
    <div v-if="pendingStages.length" class="plan-pending" data-plan-pending>
      <div class="plan-pending-head">
        <b>{{ pendingStages.length }} 张阶段卡等你裁决</b>
        <span class="plan-pending-hint">没冻结的格子推不动 —— 逐张点“通过（冻结）”或“打回”，或“改一句”退回重写</span>
      </div>
      <div class="plan-pending-list">
        <button v-for="p in pendingStages" :key="p.key" class="plan-pending-item" @click="scrollToStage(p.key)">
          <span class="plan-pending-id">{{ p.stageId }}</span>
          <span class="plan-pending-title">{{ p.title }}</span>
          <span v-if="p.missing" class="plan-pending-miss">缺 {{ p.missing }}</span>
        </button>
      </div>
    </div>

    <!-- 投入产出账（0.6.0 P5）—— 只显示取得到的格子；每个数字旁边都有“它证明不了什么”。
         口径声明**永远在**：ai-trace 只记方寸自己发起的调用，外部 agent 的花销不在这一格。 -->
    <div v-if="wasteLedger" class="waste-block" data-waste-block>
      <div class="waste-head">
        <b>投入产出账</b>
        <span class="waste-span">近 {{ wasteLedger.days || '全部' }} 天</span>
        <span class="waste-note">{{ wasteLedger.note }}</span>
      </div>
      <div v-if="wasteLedger.cells.length" class="waste-grid">
        <div v-for="c in wasteLedger.cells" :key="c.key" class="waste-cell" :data-waste="c.key">
          <div class="waste-label">{{ c.label }}</div>
          <div class="waste-value">{{ c.value }}</div>
          <div v-if="c.detail" class="waste-detail">{{ c.detail }}</div>
          <div class="waste-caveat">{{ c.caveat }}</div>
        </div>
      </div>
      <div v-else class="waste-empty">{{ wasteLedger.emptyText }}</div>
    </div>
    <div v-else-if="wasteError" class="waste-block waste-error">
      投入产出账读取失败：{{ wasteError }}
    </div>

    <div v-if="loading" class="plan-empty">读取中…</div>
    <div v-else-if="!docs.length" class="plan-empty">
      还没有计划卡 —— 真源是 <code class="plan-code">task-data/plans/&lt;项目id&gt;.md</code>
    </div>

    <div v-for="doc in docs" :key="doc.file" class="plan-doc">
      <div class="plan-doc-head">
        <b>{{ doc.title || doc.file }}</b>
        <span class="plan-file">{{ doc.file }}</span>
        <span class="plan-stat">{{ doc.stages.length }} 个阶段 · 缺块 {{ missCount(doc) }} 张</span>
      </div>

      <div v-for="s in doc.stages" :key="doc.file + s.id" class="plan-stage" :class="{ bad: s.missing.length }"
        :data-stage="doc.file + '::' + s.id">
        <div class="plan-stage-head">
          <span class="plan-id">{{ s.id }}</span>
          <span class="plan-title">{{ s.title }}</span>
          <span class="plan-status">{{ s.status || '未填状态' }}</span>
          <span v-if="s.evidence" class="plan-evidence" :title="'完成证据：' + s.evidence">✔ {{ s.evidence }}</span>
          <span v-if="s.missing.length" class="plan-miss">缺 {{ s.missing.join(' / ') }} —— 不能通过</span>
          <span v-else class="plan-ok">三块齐全</span>
        </div>
        <div class="plan-what" v-if="s.what">{{ s.what }}</div>

        <div class="plan-block">
          <div class="plan-block-h">技术方案<span v-if="!s.approach.length" class="plan-block-miss">缺</span></div>
          <ul v-if="s.approach.length" class="plan-ul"><li v-for="(a, i) in s.approach" :key="'a' + i">{{ a }}</li></ul>
        </div>

        <div class="plan-block">
          <div class="plan-block-h">照抄点<span v-if="s.copyRows.length < 3" class="plan-block-miss">缺</span></div>
          <table v-if="s.copyRows.length >= 3" class="plan-table">
            <thead>
              <tr><th v-for="(c, i) in s.copyRows[0]" :key="'h' + i">{{ c }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="(row, ri) in s.copyRows.slice(2)" :key="'r' + ri">
                <td v-for="(c, ci) in row" :key="'c' + ci">{{ c }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="plan-block">
          <div class="plan-block-h">判据<span v-if="!s.criteria.length" class="plan-block-miss">缺</span></div>
          <ul v-if="s.criteria.length" class="plan-ul"><li v-for="(c, i) in s.criteria" :key="'c' + i">{{ c }}</li></ul>
        </div>

        <div class="plan-acts">
          <button class="ok plan-act-pass" :disabled="busy || s.missing.length > 0"
            :title="s.missing.length ? '缺块不能通过' : '冻结这张阶段卡'"
            @click="verdict(doc, s, 'pass')">✓ 通过（冻结）</button>
          <button class="danger plan-act-reject" :disabled="busy" @click="openText(doc, s, 'reject')">↩ 打回</button>
          <button class="ghost plan-act-amend" :disabled="busy" @click="openText(doc, s, 'amend')">✎ 改一句</button>
          <!-- P4 界面入口（2026-11-02）：只有点这里才起进程；打开这一页永远不会跑判据 -->
          <button class="ghost plan-run-checks" :disabled="runBusy" title="真跑这一格的判据（不写任何文件）"
            @click="runChecks(doc, s)">⚙ 跑判据</button>
          <button class="pri plan-run-advance" :disabled="runBusy" title="跑判据 → 闸门 → 判据全过才写得进完成"
            @click="advance(doc, s)">▶ 推进这一格</button>
          <span v-if="s.rejectReason" class="plan-reason">上次打回：{{ s.rejectReason }}</span>
          <span v-if="s.verdict" class="plan-verdict">{{ s.verdict }}</span>
        </div>

        <!-- 判据结果（P4）：逐条三态 + 闸门结论。缺省不渲染，不写“未跑”占位 -->
        <div v-if="runOf(doc, s)" class="plan-run" :class="{ bad: runOf(doc, s).blocked }">
          <div class="plan-run-head">{{ runHead(doc, s) }}</div>
          <ul v-if="runOf(doc, s).results.length" class="plan-run-list">
            <li v-for="(r, ri) in runOf(doc, s).results" :key="'run' + ri" class="plan-run-item" :class="r.state">
              <span class="plan-run-tag">{{ stateText(r.state) }}</span>
              <span class="plan-run-raw">{{ r.raw }}</span>
              <span class="plan-run-detail">{{ r.detail }}</span>
            </li>
          </ul>
          <div v-if="runOf(doc, s).advanced" class="plan-run-advanced">已写成“完成”，证据：{{ s.evidence }}</div>
        </div>

        <div class="plan-text" v-if="textTarget && textTarget.file === doc.file && textTarget.stageId === s.id">
          <textarea class="plan-ta font-[inherit]" v-model="text" rows="2"
            :placeholder="textTarget.action === 'reject' ? '打回理由（必填）：哪里不成立、要改成什么样' : '改哪一句、改成什么'"></textarea>
          <div class="plan-text-acts">
            <button class="ghost" @click="closeText()">取消</button>
            <button class="pri" :disabled="busy || !text.trim()" @click="submitText()">
              {{ textTarget.action === 'reject' ? '确认打回' : '确认修改' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="msg" class="plan-msg" :class="msgType">{{ msg }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useWasteLedger } from '../composables/useWasteLedger'

interface Stage {
  id: string; title: string; status: string; what: string
  approach: string[]; copyRows: string[][]; criteria: string[]
  verdict: string; rejectReason: string; evidence: string; missing: string[]
}
interface Doc { file: string; title: string; stages: Stage[] }

const docs = ref<Doc[]>([])
const loading = ref(false)
const busy = ref(false)
const msg = ref('')
const msgType = ref<'ok' | 'bad'>('ok')
const text = ref('')
const textTarget = ref<{ file: string; stageId: string; action: 'reject' | 'amend' } | null>(null)
// 投入产出账（P5）：只读；三格取不到就不渲染那一格
const { wasteLedger, wasteError, loadWasteLedger } = useWasteLedger()

const missCount = (doc: Doc) => doc.stages.filter((s) => s.missing.length).length

/** 等你裁决的阶段卡（2026-11-02）—— 与 `shared/dailyBand` 的 PENDING 同一套词。
 *  为什么要在页面顶部数一遍：计划卡的状态词是它自己的一套，任务 7 态 / 决策 3 态里都没有“待裁决”，
 *  除了这张卡上的小胶囊，没有任何地方会告诉你"有 N 张在等你"。 */
const pendingStages = computed(() => {
  const out: Array<{ key: string; stageId: string; title: string; missing: string }> = []
  for (const d of docs.value) {
    for (const s of d.stages) {
      const st = String(s.status || '').trim()
      if (st === '待裁决' || st === '待裁决（未冻结）' || st === '未冻结') {
        out.push({
          key: d.file + '::' + s.id,
          stageId: s.id,
          title: s.title || '(无标题)',
          missing: (s.missing || []).join(' / '),
        })
      }
    }
  }
  return out
})

function scrollToStage(key: string): void {
  const el = document.querySelector('[data-stage="' + key + '"]') as HTMLElement | null
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

// ── P4：跑判据 / 推进一格（2026-11-02 接上界面）────────────────────────
// 结果按“文件::阶段”各存一份，不互相覆盖；**没点过就整块不渲染**（不写"未跑"占位）。
// 这两条路径是唯一会起进程的地方 —— 打开这一页（plansGet）永远不会跑判据。
interface RunState {
  loading: boolean
  results: any[]
  gate: any
  advanced: boolean
  blocked: boolean
  error: string
}

const runBusy = ref(false)
const runStates = ref<Record<string, RunState>>({})
const runKey = (doc: Doc, s: Stage): string => doc.file + '::' + s.id
function runOf(doc: Doc, s: Stage): RunState | null { return runStates.value[runKey(doc, s)] || null }

const STATE_TEXT: Record<string, string> = { pass: '通过', fail: '未过', unknown: '未判定' }
function stateText(x: string): string { return STATE_TEXT[x] || x }

function emptyRun(error = '', loading = false): RunState {
  return { loading, results: [], gate: null, advanced: false, blocked: false, error }
}

function runHead(doc: Doc, s: Stage): string {
  const r = runOf(doc, s)
  if (!r) return ''
  if (r.loading) return '正在跑 ' + s.id + ' 的判据…'
  if (r.error) return '没跑成：' + r.error
  const reason = String((r.gate && r.gate.reason) || '')
  if (r.advanced) return '判据全过 → 已推进成“完成”（' + reason + '）'
  if (r.blocked) return reason || '判据未过'
  return reason || '判据全过'
}

async function runChecks(doc: Doc, s: Stage): Promise<void> {
  if (runBusy.value) return
  const key = runKey(doc, s)
  runBusy.value = true
  runStates.value = { ...runStates.value, [key]: emptyRun('', true) }
  msg.value = ''
  try {
    const r: any = await (window as any).tegula.plansChecks({ file: doc.file, stageId: s.id })
    if (!r?.ok) {
      runStates.value = { ...runStates.value, [key]: emptyRun('读取失败：' + (r?.error || '未知错误')) }
      return
    }
    const gate = r.gate || null
    runStates.value = {
      ...runStates.value,
      [key]: {
        loading: false, results: r.results || [], gate,
        advanced: false, blocked: !(gate && gate.canAdvance), error: '',
      },
    }
    msg.value = gate && gate.canAdvance
      ? s.id + ' 判据全过 —— 可以点“推进这一格”'
      : s.id + ' 判据没过 —— 看下面逐条实际值'
    msgType.value = gate && gate.canAdvance ? 'ok' : 'bad'
  } catch (e: any) {
    runStates.value = { ...runStates.value, [key]: emptyRun('读取异常：' + (e?.message || e)) }
  } finally {
    runBusy.value = false
  }
}

async function advance(doc: Doc, s: Stage): Promise<void> {
  if (runBusy.value) return
  const key = runKey(doc, s)
  runBusy.value = true
  runStates.value = { ...runStates.value, [key]: emptyRun('', true) }
  msg.value = ''
  try {
    const r: any = await (window as any).tegula.plansAdvance({ file: doc.file, stageId: s.id })
    if (!r?.ok) {
      runStates.value = { ...runStates.value, [key]: emptyRun('推进失败：' + (r?.error || '未知错误')) }
      msg.value = '没推进 ' + s.id + '：' + (r?.error || '未知错误')
      msgType.value = 'bad'
      return
    }
    runStates.value = {
      ...runStates.value,
      [key]: {
        loading: false, results: r.results || [], gate: r.gate || null,
        advanced: !!r.advanced, blocked: !!r.blocked, error: r.error || '',
      },
    }
    if (r.advanced) {
      msg.value = '已推进 ' + s.id + ' —— 判据全过，写进了“完成”'
      msgType.value = 'ok'
    } else if (r.blocked) {
      msg.value = '没推进 ' + s.id + '：判据没过，打回理由已写进卡里'
      msgType.value = 'bad'
    } else {
      msg.value = '没推进 ' + s.id + '：' + (r.error || '闸门拒绝')
      msgType.value = 'bad'
    }
    // 结果块里的“证据”要靠重读后的对象，所以推进后一律重读（不自己拼状态）
    await load()
  } finally {
    runBusy.value = false
  }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const r: any = await (window as any).tegula.plansGet()
    docs.value = r?.ok ? (r.docs || []) : []
    if (!r?.ok) msg.value = '读取失败：' + (r?.error || '未知错误')
  } catch (e: any) {
    docs.value = []
    msg.value = '读取异常：' + (e?.message || e)
    msgType.value = 'bad'
  } finally {
    loading.value = false
  }
}

function openText(doc: Doc, s: Stage, action: 'reject' | 'amend'): void {
  textTarget.value = { file: doc.file, stageId: s.id, action }
  text.value = ''
  msg.value = ''
}
function closeText(): void { textTarget.value = null; text.value = '' }

async function verdict(doc: Doc, s: Stage, action: 'pass' | 'reject' | 'amend', why = ''): Promise<void> {
  if (busy.value) return
  busy.value = true
  msg.value = ''
  try {
    const r: any = await (window as any).tegula.plansVerdict({
      file: doc.file, stageId: s.id, action, text: why,
    })
    if (!r?.ok) {
      msg.value = '没写成：' + (r?.error || '未知错误')
      msgType.value = 'bad'
      return
    }
    // 三种动作各自一句话（也让"三个分支"在源码里看得见，不是靠三元表达式糊过去）
    if (action === 'pass') msg.value = `已冻结 ${s.id}`
    else if (action === 'reject') msg.value = `已打回 ${s.id}——理由已写进卡里`
    else if (action === 'amend') msg.value = `已记录修改 ${s.id}——状态退回未冻结`
    msgType.value = 'ok'
    textTarget.value = null
    text.value = ''
    await load()
  } finally {
    busy.value = false
  }
}

function submitText(): void {
  const t = textTarget.value
  if (!t) return
  const doc = docs.value.find((d) => d.file === t.file)
  const s = doc?.stages.find((x) => x.id === t.stageId)
  if (doc && s) void verdict(doc, s, t.action, text.value.trim())
}

onMounted(() => { void load(); void loadWasteLedger() })
</script>
