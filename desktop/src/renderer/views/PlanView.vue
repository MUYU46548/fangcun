<!--
  作战计划（0.6.0 P1）—— 项目页第 8 种摆法

  **这一页只服务一个决策**：这张阶段卡**能不能冻结**（冻结了才允许往下推）。
  所以三块必须同时在场：技术方案 / 照抄点表 / 判据；缺一块就报红，且**不给"通过"**。

  三个动作（P1 判据写死，恰好三个、没有第四态）：
    通过   → 写 `状态: 已冻结` + `裁决: 通过 · 日期`
    打回   → 写 `打回理由:`（空理由不许提交 —— 空着等于没打回）
    改一句 → 修订记录多一行 + 状态退回「未冻结」

  数据真身在 `main/data/plans.ts`（行级就地改，不重写整篇）；组件只管显示与收集意图。
-->
<template>
  <div class="plan-view">
    <div class="plan-head">
      <h3>作战计划 · 裁决</h3>
      <span class="plan-sub">三块齐全才给"通过"；打回必须写理由；改一句会留痕并把状态退回未冻结</span>
      <button class="ghost plan-reload" @click="load()">⟳ 重读</button>
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

      <div v-for="s in doc.stages" :key="doc.file + s.id" class="plan-stage" :class="{ bad: s.missing.length }">
        <div class="plan-stage-head">
          <span class="plan-id">{{ s.id }}</span>
          <span class="plan-title">{{ s.title }}</span>
          <span class="plan-status">{{ s.status || '未填状态' }}</span>
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
          <span v-if="s.rejectReason" class="plan-reason">上次打回：{{ s.rejectReason }}</span>
          <span v-if="s.verdict" class="plan-verdict">{{ s.verdict }}</span>
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

interface Stage {
  id: string; title: string; status: string; what: string
  approach: string[]; copyRows: string[][]; criteria: string[]
  verdict: string; rejectReason: string; missing: string[]
}
interface Doc { file: string; title: string; stages: Stage[] }

const docs = ref<Doc[]>([])
const loading = ref(false)
const busy = ref(false)
const msg = ref('')
const msgType = ref<'ok' | 'bad'>('ok')
const text = ref('')
const textTarget = ref<{ file: string; stageId: string; action: 'reject' | 'amend' } | null>(null)

const missCount = (doc: Doc) => doc.stages.filter((s) => s.missing.length).length

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

onMounted(() => { void load() })
</script>
