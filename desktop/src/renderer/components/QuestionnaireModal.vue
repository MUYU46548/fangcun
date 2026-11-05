<!--
  问卷弹窗（2026-11-05）

  为什么做成弹窗、而不是独立页签：暮雨原话“我设想的就是问卷弹窗”。
  他 11-04 那 4 份问卷（`references/问卷样本/`）是这套东西的原型，本组件是它的产品化。

  边界（每条都对应一次真实讨论）：
   · **不做 GUI 出题器** —— 问卷是 agent 写的（“我现在的问卷全都是 agent 写的”），
     方寸只负责：呈现 → 收答案 → 存草稿 → 批准落库。
   · **草稿 → 批准**（他要求的）—— 点选只改草稿；必须点「批准并落库」才建决策卡。
     没批准就关掉 = 什么都没发生，且要明确告诉他。
   · **反问**（他最重要的一条）——“有时候用户想选一个根本不存在的选项，或者发出灵魂反问。
     而那种反问往往才是戳破迷雾、一锤定音的。” 反问不进决策，回给 agent 重写这一题。
   · **不写别人仓库** —— 批准只写方寸 `task-data/`；decision-log 段落导出成 md 给你自己贴。

  草稿是**每动一下就存**的（`questionnaireSaveAnswers`）：关窗、切页都不丢。
-->
<template>
  <div id="qn-modal" class="qn" @mousedown.self="$emit('close')">
    <div class="qn-dlg">
      <!-- ── 选卷 ─────────────────────────────────────────── -->
      <template v-if="!deck">
        <div class="qn-hd">
          <span class="qn-ttl">问卷</span>
          <span class="qn-sub">{{ decks.length }} 卷 · 说清“你想要什么”，不触发任何开发</span>
          <span class="qn-grow"></span>
          <button class="ghost" @click="openDir">📂 问卷目录</button>
          <button class="ghost" @click="$emit('close')">关闭</button>
        </div>
        <div class="qn-body">
          <div v-if="!decks.length" class="qn-empty">
            还没有问卷。<br>
            把 agent 写的问卷 md 放进 <code>{{ dir || 'task-data/questionnaires/' }}</code>，
            格式照 <code>## S1 题名</code> + <code>- **A. 选项**——说明</code>，刷新即可。
          </div>
          <div v-else class="qn-decks">
            <button v-for="d in decks" :key="d.deck" class="qn-deck" @click="openDeck(d.deck)">
              <span class="qd-main">
                <b>{{ d.title || d.deck }}</b>
                <span class="qd-badge" v-if="d.layer">{{ d.layer }}</span>
                <span class="qd-badge ok" v-if="d.approved">已批准</span>
                <span class="qd-badge bad" v-if="d.error">解析有问题</span>
              </span>
              <span class="qd-meta">{{ d.answered }} / {{ d.total }} 题{{ d.error ? ' · ' + d.error : '' }}</span>
            </button>
          </div>
        </div>
      </template>

      <!-- ── 答题 ─────────────────────────────────────────── -->
      <template v-else>
        <div class="qn-hd">
          <button class="ghost qn-back" @click="backToList">← 全部问卷</button>
          <span class="qn-ttl">{{ deck.parsed.title || deck.deck }}</span>
          <span class="qn-sub">已答 {{ answeredCount }} / {{ total }}</span>
          <span class="qn-grow"></span>
          <div class="qn-seg">
            <button :class="{ on: view === 'one' }" @click="view = 'one'">一次一题</button>
            <button :class="{ on: view === 'all' }" @click="view = 'all'">整卷</button>
          </div>
          <button class="ghost" @click="$emit('close')">关闭</button>
        </div>
        <div class="qn-bar"><i :style="{ width: (total ? answeredCount / total * 100 : 0) + '%' }"></i></div>

        <div class="qn-cols">
          <div class="qn-rail">
            <button v-for="q in deck.parsed.questions" :key="q.id" class="qn-rail-i"
              :class="{ on: view === 'one' && q.id === curId }" @click="goto(q.id)">
              <span class="ri-k">{{ q.id }}</span>
              <span class="ri-t">{{ q.nav || q.ask || q.id }}</span>
              <span class="ri-s" :class="stateClass(q.id)">{{ stateGlyph(q.id) }}</span>
            </button>
            <button v-if="parked.length" class="qn-rail-x" :class="{ on: extra === 'parked' }"
              @click="toggleExtra('parked')">
              📌 预埋 {{ parked.length }} 项<span class="rx-n">现在答不了</span>
            </button>
            <button v-if="lookRows.length" class="qn-rail-x" :class="{ on: extra === 'look' }"
              @click="toggleExtra('look')">
              🔗 入口总表 {{ lookRows.length }} 条<span class="rx-n">照着眼就行</span>
            </button>
            <div class="qn-rail-foot">
              · 没答　○ 跳过　✕ 否决<br>❗ 反问（回给 agent）　✓ 已答
            </div>
          </div>

          <div class="qn-main">
            <!-- 额外页：预埋表 / 入口总表 / 提示词。⚠ 一定是链头，插到中间会让后面整段不渲染 -->
            <div v-if="extra === 'parked'" class="qn-extra">
              <div class="xe-hd">
                <b>预埋 {{ parked.length }} 项</b>
                <span class="xe-sub">现在答不了 —— 不是遗漏，是等条件。条件到了 agent 会把它变成正式题。</span>
                <span class="qn-grow"></span>
                <button class="ghost" @click="extra = ''">收起</button>
              </div>
              <table class="xe-tb">
                <thead>
                  <tr><th v-for="(h, hi) in parkedHead" :key="hi">{{ h }}</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(p, i) in parked" :key="i">
                    <td class="xe-q">{{ p.q }}</td>
                    <td>{{ p.need }}</td>
                    <td>{{ p.when }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-else-if="extra === 'look'" class="qn-extra">
              <div class="xe-hd">
                <b>看一眼 · 入口总表</b>
                <span class="xe-sub">全卷共用 —— 答题时不用懂名词，照着看就行。</span>
                <span class="qn-grow"></span>
                <button class="ghost" @click="extra = ''">收起</button>
              </div>
              <table class="xe-tb">
                <thead><tr><th>名字</th><th>一句话</th><th>入口</th></tr></thead>
                <tbody>
                  <tr v-for="(r, i) in lookRows" :key="i">
                    <td class="xe-q">{{ r.nm }}</td>
                    <td>{{ r.ds }}</td>
                    <td class="xe-url">{{ r.url }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-else-if="extra === 'prompt'" class="qn-extra">
              <div class="xe-hd">
                <b>{{ promptKind === 'rewrite' ? '重出题提示词' : '出施工单提示词' }}</b>
                <span class="xe-sub">{{ promptKind === 'rewrite'
                  ? '粘给 agent：它只重写被反问的那几题，不重发整卷'
                  : '粘给 agent：把已定的翻成可验收的小步，没定的标成待定' }}</span>
                <span class="qn-grow"></span>
                <button class="ghost" @click="copyPrompt">⧉ 复制</button>
                <button class="ghost" @click="extra = ''">收起</button>
              </div>
              <pre class="xe-pre">{{ promptText }}</pre>
            </div>

            <!-- 整卷 -->
            <div v-else-if="view === 'all'" class="qn-all">
              <div v-for="q in deck.parsed.questions" :key="q.id" class="qn-card"
                :class="{ ans: isAnswered(q.id), askc: answers[q.id] && answers[q.id].kind === 'askback' }">
                <div class="qc-hd"><span class="qc-id">{{ q.id }}</span><span class="qc-ask">{{ q.ask || q.nav }}</span></div>
                <div v-if="q.look" class="qn-look">
                  <button class="look-hd" @click="toggleLook(q.id)">
                    <span class="arw" :class="{ open: lookOpen[q.id] }">▶</span>
                    看一眼 · 不用懂名词，点开照着眼就行
                  </button>
                  <div v-if="lookOpen[q.id]" class="look-bd">{{ q.look }}</div>
                </div>
                <div v-if="q.prefilled" class="qn-note">这题答过 —— 沿用就打勾，变则改一句</div>
                <div class="qn-opts">
                  <button v-for="o in q.options" :key="o.k" class="qn-opt"
                    :class="{ on: answers[q.id] && answers[q.id].kind === 'pick' && answers[q.id].k === o.k }"
                    @click="pick(q.id, o.k)">
                    <span class="kk">{{ o.k }}</span>
                    <span class="txt"><b>{{ o.t }}</b><small v-if="o.d">{{ o.d }}</small></span>
                  </button>
                </div>
                <div v-if="answers[q.id]" class="qn-state">
                  {{ stateText(q.id) }}
                  <button class="undo" @click="reset(q.id)">撤销这次操作</button>
                </div>
                <div class="qn-acts">
                  <button class="ghost" @click="mark(q.id, 'skip')">跳过</button>
                  <button class="danger" @click="mark(q.id, 'reject')">否决</button>
                  <button class="ask" @click="startEdit(q.id, 'askback')">❗ 反问…</button>
                  <button class="ghost" @click="startEdit(q.id, 'amend')">改一句…</button>
                </div>
                <div v-if="editing && editing.id === q.id" class="qn-edit" :class="{ ask: editing.kind === 'askback' }">
                  <div class="qe-hint">{{ editing.kind === 'askback'
                    ? '这题问错了 —— 说一句真正该问的（会回给 agent 重写这一题；留空 = 否决）'
                    : '选项都不对？补一句（会原样落进 decision-log）' }}</div>
                  <textarea v-model="editText" rows="2"></textarea>
                  <div class="qe-row">
                    <button class="ghost" @click="editing = null">取消</button>
                    <button class="pri" @click="commitEdit">确定</button>
                  </div>
                </div>
                <div class="qn-meta">
                  <button class="meta-t" @click="toggleMeta(q.id + '-src')">▸ 出处{{ metaOpen[q.id + '-src'] ? '：' + q.src : '' }}</button>
                  <button class="meta-t" @click="toggleMeta(q.id + '-line')">▸ 验收线{{ metaOpen[q.id + '-line'] ? '：' + q.line : '' }}</button>
                </div>
              </div>
            </div>

            <!-- 一次一题 -->
            <div v-else-if="currentQ" class="qn-one">
              <div class="q-id">{{ currentQ.id }}</div>
              <div class="q-ask">{{ currentQ.ask || currentQ.nav }}</div>
              <div v-if="currentQ.prefilled" class="qn-note">这题答过 —— {{ currentQ.prefilledNote || '沿用就打勾，变则改一句' }}</div>
              <div v-if="currentQ.look" class="qn-look">
                <button class="look-hd" @click="toggleLook(currentQ.id)">
                  <span class="arw" :class="{ open: lookOpen[currentQ.id] }">▶</span>
                  看一眼 · 不用懂名词，点开照着眼就行
                </button>
                <div v-if="lookOpen[currentQ.id]" class="look-bd">{{ currentQ.look }}</div>
              </div>
              <div class="qn-opts">
                <button v-for="o in currentQ.options" :key="o.k" class="qn-opt"
                  :class="{ on: answers[currentQ.id] && answers[currentQ.id].kind === 'pick' && answers[currentQ.id].k === o.k }"
                  @click="pick(currentQ.id, o.k)">
                  <span class="kk">{{ o.k }}</span>
                  <span class="txt"><b>{{ o.t }}</b><small v-if="o.d">{{ o.d }}</small></span>
                </button>
              </div>
              <div v-if="answers[currentQ.id]" class="qn-state">
                {{ stateText(currentQ.id) }}
                <button class="undo" @click="reset(currentQ.id)">撤销这次操作</button>
              </div>
              <div v-if="editing && editing.id === currentQ.id" class="qn-edit" :class="{ ask: editing.kind === 'askback' }">
                <div class="qe-hint">{{ editing.kind === 'askback'
                  ? '这题问错了 —— 说一句真正该问的（会回给 agent 重写这一题；留空 = 否决）'
                  : '选项都不对？补一句（会原样落进 decision-log）' }}</div>
                <textarea v-model="editText" rows="3"></textarea>
                <div class="qe-row">
                  <button class="ghost" @click="editing = null">取消</button>
                  <button class="pri" @click="commitEdit">确定</button>
                </div>
              </div>
              <div class="qn-meta">
                <button class="meta-t" @click="toggleMeta(currentQ.id + '-src')">▸ 出处{{ metaOpen[currentQ.id + '-src'] ? '：' + currentQ.src : '' }}</button>
                <button class="meta-t" @click="toggleMeta(currentQ.id + '-line')">▸ 验收线{{ metaOpen[currentQ.id + '-line'] ? '：' + currentQ.line : '' }}</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 底栏 -->
        <div class="qn-ft">
          <template v-if="extra">
            <button class="ghost" @click="extra = ''">← 返回题目</button>
            <span class="qn-grow"></span>
            <span class="qn-ft-note">{{ extra === 'prompt' ? '复制后粘给 agent 就行' : '这不是题目 —— 不用答，看看就好' }}</span>
          </template>
          <template v-else-if="!summary">
            <button class="ghost" @click="mark(curId, 'skip')">跳过</button>
            <button class="danger" @click="mark(curId, 'reject')">否决</button>
            <button class="ask" @click="startEdit(curId, 'askback')">❗ 反问…</button>
            <button class="ghost" @click="startEdit(curId, 'amend')">改一句…</button>
            <span class="qn-grow"></span>
            <button class="ghost" @click="prev" :disabled="idx === 0">← 上一题</button>
            <button class="pri" @click="next">{{ idx === total - 1 ? '答完了 · 看结果' : '下一题 →' }}</button>
          </template>
          <template v-else>
            <button class="ghost" @click="summary = false">← 回去改</button>
            <button class="ghost" @click="copyMd">⧉ 复制 md</button>
            <button class="ghost" v-if="approved" @click="downloadMd">⬇ 导出</button>
            <!-- 出口（2026-11-05）：有反问只能「重出题」；反问清零了才给「出施工单」。
                 为什么不给两个都显示：问题还没定时出的单必然是错的（问卷不是施工单）。 -->
            <button v-if="askCount" class="ask" :disabled="promptBusy" @click="openPrompt('rewrite')">
              ❗ 打包成重出题（{{ askCount }}）
            </button>
            <button v-else class="ghost" :disabled="promptBusy" @click="openPrompt('build')">
              📋 生成施工单提示词
            </button>
            <span class="qn-grow"></span>
            <span v-if="approved" class="qn-ok">已落库 · {{ approved.slice(0, 16).replace('T', ' ') }}</span>
            <button v-if="!approved" class="pri" :disabled="busy" @click="approve">✓ 批准并落库</button>
            <button v-else class="pri" @click="$emit('close')">关闭</button>
          </template>
        </div>

        <div class="qn-hint">
          <template v-if="!summary">草稿每改一下就存 · 点「批准并落库」才真正写入决策卡</template>
          <template v-else-if="!approved">上面是草稿 —— 没批准就关掉 = 什么都没发生</template>
          <template v-else>已批准：决策卡已建、decision-log 段落已导出到 questionnaires 目录</template>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

const emit = defineEmits<{ (e: 'close'): void; (e: 'toast', msg: string, kind?: string): void }>()

interface QOpt { k: string; t: string; d: string }
interface QItem { id: string; nav: string; ask: string; options: QOpt[]; src: string; line: string; look: string; prefilled: boolean; prefilledNote: string }
interface QParked { q: string; need: string; when: string }
interface QParsed {
  title: string; layer: string; questions: QItem[]
  lookTable: { nm: string; ds: string; url: string }[]
  /** 「预埋」——现在答不了的那些题（样本里叫“裁决层预埋”或“摊不开的”） */
  parked: QParked[]
  /** 预埋表的表头（原样；两份样本说法不同，硬编一种就会写成错标题） */
  parkedHead: string[]
}
interface QAns { kind: 'pick' | 'skip' | 'reject' | 'askback' | 'amend'; k?: string; text?: string }
interface QDeckBrief { deck: string; title: string; layer: string; total: number; answered: number; approved: boolean; error?: string }

const api = () => (window as any).tegula

const decks = ref<QDeckBrief[]>([])
const dir = ref('')
const deck = ref<{ deck: string; parsed: QParsed } | null>(null)
const answers = ref<Record<string, QAns>>({})
const approved = ref('')
const view = ref<'one' | 'all'>('one')
const curId = ref('')
const summary = ref(false)
const editing = ref<null | { id: string; kind: 'askback' | 'amend' }>(null)
const editText = ref('')
const lookOpen = ref<Record<string, boolean>>({})
const metaOpen = ref<Record<string, boolean>>({})
const busy = ref(false)
/**
 * main 区的“额外页”：预埋表 / 入口总表 / 提示词。
 * 空串 = 正常答题。它必须排在最前面判断 —— 否则会掉进题流里（本项目有过先例）。
 */
const extra = ref<'' | 'parked' | 'look' | 'prompt'>('')
const promptKind = ref<'rewrite' | 'build'>('rewrite')
const promptText = ref('')
const promptBusy = ref(false)

const toast = (m: string, k = 'info') => emit('toast', m, k)
const total = computed(() => deck.value ? deck.value.parsed.questions.length : 0)
const idx = computed(() => deck.value ? deck.value.parsed.questions.findIndex((q) => q.id === curId.value) : 0)
const currentQ = computed<QItem | null>(() => deck.value ? (deck.value.parsed.questions[idx.value] || null) : null)
const answeredCount = computed(() => (deck.value ? deck.value.parsed.questions.filter((q) => isAnswered(q.id)).length : 0))
/** 预埋项（现在答不了的题）—— 不放题流里，它们不是“待答” */
const parked = computed<QParked[]>(() => (deck.value ? deck.value.parsed.parked || [] : []))
/** 表头原样用；解析不出来才退回一套中性的 */
const parkedHead = computed<string[]>(() => {
  const h = (deck.value ? deck.value.parsed.parkedHead : []) || []
  return h.length >= 2 ? h : ['题', '缺什么', '什么时候能答']
})
/** 「看一眼·入口总表」—— 全卷共用的一张参照表（裁决层 A 的链接全在这一张里） */
const lookRows = computed(() => (deck.value ? deck.value.parsed.lookTable || [] : []))
/** 有几句反问 —— 决定汇总页给哪个出口（重出题 / 出施工单） */
const askCount = computed(() => {
  if (!deck.value) return 0
  return deck.value.parsed.questions.filter((q) => {
    const a = answers.value[q.id]
    return !!(a && a.kind === 'askback' && String(a.text || '').trim())
  }).length
})

function isAnswered(id: string): boolean {
  const a = answers.value[id]
  if (!a) return false
  if (a.kind === 'amend' || a.kind === 'askback') return !!(a.text || '').trim()
  return true
}
function stateGlyph(id: string): string {
  const a = answers.value[id]
  if (!a) return '·'
  if (a.kind === 'skip') return '○'
  if (a.kind === 'reject') return '✕'
  if (a.kind === 'askback') return '❗'
  return '✓'
}
function stateClass(id: string): string {
  const a = answers.value[id]
  if (!a) return ''
  if (a.kind === 'skip') return 'skip'
  if (a.kind === 'reject') return 'rej'
  if (a.kind === 'askback') return 'ask'
  return 'ans'
}
function stateText(id: string): string {
  const a = answers.value[id]
  if (!a) return ''
  if (a.kind === 'skip') return '已跳过 —— 下次进项目还会问'
  if (a.kind === 'reject') return '已否决 —— 这题不该问，不再出现'
  if (a.kind === 'askback') return '❗ 已反问：' + (a.text || '')
  if (a.kind === 'amend') return '已记录你的说法：' + (a.text || '')
  return '已选：' + a.k
}

async function loadList(): Promise<void> {
  try {
    const r: any = await api().questionnaireList()
    decks.value = (r && r.decks) || []
    dir.value = (r && r.dir) || ''
  } catch (e: any) {
    toast('读问卷列表失败：' + (e?.message || e), 'error')
  }
}

async function openDeck(name: string): Promise<void> {
  try {
    const r: any = await api().questionnaireGet(name)
    if (!r || r.ok === false) { toast(String(r?.error || '打不开这一卷'), 'error'); return }
    deck.value = { deck: r.deck, parsed: r.parsed }
    answers.value = r.answers || {}
    approved.value = r.approvedAt || ''
    summary.value = false
    // 打开落在“第一道还没答的题”上，省得从 S1 一路翻
    const first = (r.parsed.questions as QItem[]).find((q) => !isAnswered(q.id))
    curId.value = (first || r.parsed.questions[0]).id
    if (r.parsed.error) toast(String(r.parsed.error), 'error')
  } catch (e: any) {
    toast('打不开这一卷：' + (e?.message || e), 'error')
  }
}

function backToList(): void {
  deck.value = null
  summary.value = false
  void loadList()
}

/** 每动一下就存草稿 —— 关窗/切页都不丢 */
async function save(): Promise<void> {
  if (!deck.value) return
  try {
    await api().questionnaireSaveAnswers(deck.value.deck, answers.value)
  } catch { /* 草稿存失败不该挡住答题，下一次动作会再试 */ }
}

function pick(id: string, k: string): void {
  answers.value[id] = { kind: 'pick', k }
  editing.value = null
  void save()
}
function mark(id: string, kind: 'skip' | 'reject'): void {
  answers.value[id] = { kind }
  editing.value = null
  void save()
}
function reset(id: string): void {
  delete answers.value[id]
  editing.value = null
  void save()
}
function startEdit(id: string, kind: 'askback' | 'amend'): void {
  editing.value = { id, kind }
  editText.value = ''
}
function commitEdit(): void {
  const e = editing.value
  if (!e) return
  const v = editText.value.trim()
  if (e.kind === 'askback' && !v) { answers.value[e.id] = { kind: 'reject' }; editing.value = null; void save(); return }
  if (!v) { toast('说一句再确定'); return }
  answers.value[e.id] = { kind: e.kind, text: v }
  editing.value = null
  void save()
}
function goto(id: string): void {
  curId.value = id
  view.value = 'one'
  editing.value = null
}
function prev(): void {
  const qs = deck.value?.parsed.questions || []
  if (idx.value > 0) curId.value = qs[idx.value - 1].id
}
function next(): void {
  const qs = deck.value?.parsed.questions || []
  if (!isAnswered(curId.value)) { toast('这题还没答 —— 选一个，或者点「跳过」'); return }
  if (idx.value >= qs.length - 1) { summary.value = true; return }
  curId.value = qs[idx.value + 1].id
}
function toggleLook(id: string): void { lookOpen.value[id] = !lookOpen.value[id] }
function toggleMeta(k: string): void { metaOpen.value[k] = !metaOpen.value[k] }

/** 生成 md（与数据层导出同一形状：逐题 + 反问段） */
function mdText(): string {
  const d = deck.value
  if (!d) return ''
  const lines: string[] = [`# ${d.parsed.title || d.deck} 答卷（${new Date().toISOString().slice(0, 10)}）`, '']
  const asks: { id: string; text: string }[] = []
  d.parsed.questions.forEach((q) => {
    const a = answers.value[q.id]
    if (!a) { lines.push(`- **${q.id}** —— 未答`); return }
    if (a.kind === 'skip') { lines.push(`- **${q.id}** —— 跳过（下次再问）`); return }
    if (a.kind === 'reject') { lines.push(`- **${q.id}** —— 否决：这题不该问`); return }
    if (a.kind === 'askback') { lines.push(`- **${q.id}** —— 反问（见下）`); asks.push({ id: q.id, text: a.text || '' }); return }
    if (a.kind === 'amend') { lines.push(`- **${q.id}** —— ${a.text}（自述）`); return }
    const o = q.options.find((x) => x.k === a.k)
    lines.push(`- **${q.id}** —— ${a.k}. ${o ? o.t : ''}`)
  })
  if (asks.length) {
    lines.push('', '## 反问（回给 agent 重写题目）', '')
    asks.forEach((x) => lines.push(`- **${x.id}**：${x.text}`))
  }
  return lines.join('\n') + '\n'
}

/**
 * 复制（带兜底）。Electron 里 navigator.clipboard 一般可用，但 `file://` 或没聚焦时会拒 ——
 * 拒了还要能复制，否则按钮看起来就是坏的（本项目踩过“点了没反应”）。
 */
async function copyText(t: string, okMsg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(t)
    toast(okMsg, 'success')
    return
  } catch { /* 走兜底 */ }
  const ta = document.createElement('textarea')
  ta.value = t
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy'); toast(okMsg, 'success') } catch { toast('复制失败：环境不允许，请手动选中复制', 'error') }
  ta.remove()
}

async function copyMd(): Promise<void> {
  await copyText(mdText(), '已复制答卷，可直接贴进 decision-log')
}

function toggleExtra(k: 'parked' | 'look'): void {
  extra.value = extra.value === k ? '' : k
}

/**
 * 生成出口提示词。两个方向：
 *   rewrite —— 拿反问去让 agent 重出题（只重写那几题）；
 *   build   —— 拿答卷去出施工单（有反问时后端会拒，这里如实把话转给用户）。
 */
async function openPrompt(kind: 'rewrite' | 'build'): Promise<void> {
  if (!deck.value || promptBusy.value) return
  promptBusy.value = true
  try {
    const r: any = await api().questionnairePrompt(deck.value.deck, kind)
    if (!r || r.ok === false) { toast(String(r?.error || '生成失败'), 'error'); return }
    promptKind.value = kind
    promptText.value = String(r.text || '')
    extra.value = 'prompt'
  } catch (e: any) {
    toast('生成失败：' + (e?.message || e), 'error')
  } finally {
    promptBusy.value = false
  }
}

async function copyPrompt(): Promise<void> {
  if (!promptText.value) return
  await copyText(promptText.value, '已复制提示词 —— 粘给 agent 就行')
}
function downloadMd(): void {
  const blob = new Blob([mdText()], { type: 'text/markdown;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = '问卷-' + (deck.value?.deck || 'answer') + '.md'
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

async function approve(): Promise<void> {
  if (!deck.value || busy.value) return
  busy.value = true
  try {
    const r: any = await api().questionnaireApprove(deck.value.deck)
    if (!r || r.ok === false) { toast(String(r?.error || '批准失败'), 'error'); return }
    approved.value = new Date().toISOString()
    const n = Number(r.cards || 0)
    const ex = Number(r.existed || 0)
    toast(n ? `已批准：新建 ${n} 张决策卡${ex ? `，${ex} 张已存在` : ''}` : `已批准：${ex} 张决策卡都已存在`, 'success')
  } catch (e: any) {
    toast('批准失败：' + (e?.message || e), 'error')
  } finally {
    busy.value = false
  }
}

async function openDir(): Promise<void> {
  const r: any = await api().questionnaireOpenDir()
  if (r && r.ok === false) toast(String(r.error || '打不开目录'), 'error')
}

watch(summary, (v) => { if (v && !approved.value) toast('以上都是草稿 —— 点「批准并落库」才写到决策卡') })

onMounted(() => { void loadList() })
</script>

<style scoped>
.qn { position: fixed; inset: 0; background: rgba(60, 65, 80, .42); display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 60; }
.qn-dlg { width: min(920px, 100%); max-height: min(90vh, 800px); background: var(--card); border: 1px solid var(--border); border-radius: 16px; display: flex; flex-direction: column; overflow: hidden; }
.qn-hd { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.qn-ttl { font-size: 14.5px; font-weight: 700; }
.qn-sub { font-size: 11.5px; color: var(--muted); }
.qn-grow { flex: 1; }
.qn-back { font-size: 11.5px; }
.qn-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.qn-seg button { border: 0; background: #fff; color: var(--muted); font-size: 11.5px; padding: 4px 10px; }
.qn-seg button.on { background: var(--accent); color: #fff; font-weight: 600; }
.qn-bar { height: 3px; background: var(--tint-2); }
.qn-bar i { display: block; height: 100%; background: var(--accent); transition: width .25s; }
.qn-body { padding: 16px; overflow: auto; flex: 1; }
.qn-empty { font-size: 12px; color: var(--muted); line-height: 2; }
.qn-empty code { background: var(--tint-3); padding: 1px 5px; border-radius: 4px; }
.qn-decks { display: flex; flex-direction: column; gap: 8px; }
.qn-deck { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; border: 1px solid var(--border); background: #fff; border-radius: 10px; padding: 10px 13px; }
.qn-deck:hover { border-color: var(--accent-soft); background: #fcfbff; }
.qd-main { flex: 1; min-width: 0; font-size: 13px; display: flex; align-items: center; gap: 7px; }
.qd-badge { font-size: 10.5px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0 7px; }
.qd-badge.ok { color: var(--success); border-color: #cfe6d5; }
.qd-badge.bad { color: var(--danger); border-color: var(--danger); }
.qd-meta { font-size: 11.5px; color: var(--muted); flex: none; }

.qn-cols { display: flex; flex: 1; min-height: 0; }
.qn-rail { width: 172px; flex: none; border-right: 1px solid var(--border); background: var(--tint-2); padding: 8px; overflow: auto; }
.qn-rail-i { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; border: 1px solid transparent; background: transparent; border-radius: 8px; padding: 6px 8px; font-size: 11.5px; color: var(--muted); }
.qn-rail-i:hover { background: #fff; }
.qn-rail-i.on { background: #fff; border-color: var(--accent-soft); color: var(--ink); font-weight: 600; }
.ri-k { font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; color: var(--accent); flex: none; width: 22px; }
.ri-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ri-s { flex: none; font-size: 10px; }
.ri-s.ans { color: var(--success); }
.ri-s.rej { color: var(--danger); }
.ri-s.ask { color: var(--warning); }
.qn-rail-x {
  display: flex; align-items: center; gap: 5px; width: 100%; margin-top: 6px;
  border: 1px dashed var(--border); background: transparent; border-radius: 8px;
  padding: 6px 8px; font-size: 11px; color: var(--muted); text-align: left;
}
.qn-rail-x:hover { background: #fff; color: var(--ink); }
.qn-rail-x.on { background: #fff; border-style: solid; border-color: var(--accent-soft); color: var(--ink); font-weight: 600; }
.qn-rail-x .rx-n { margin-left: auto; font-size: 9.5px; font-weight: 400; color: var(--muted); }
.qn-rail-foot { margin-top: 8px; padding: 8px; font-size: 10.5px; color: var(--muted); line-height: 1.8; border-top: 1px dashed var(--border); }

.qn-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.qn-main > div { flex: 1; min-height: 0; overflow: auto; }
.qn-one, .qn-all { padding: 16px 20px; }
.qn-all { display: flex; flex-direction: column; gap: 12px; }
.q-id { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--accent); font-weight: 700; }
.q-ask { font-size: 16.5px; font-weight: 700; line-height: 1.45; margin: 3px 0 11px; }
.qn-card { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
.qn-card.ans { border-color: var(--accent-soft); background: #fcfbff; }
.qn-card.askc { border-color: var(--warning); background: #fdf9f2; }
.qc-hd { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.qc-id { font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; color: var(--accent); font-weight: 700; }
.qc-ask { font-size: 13.5px; font-weight: 700; line-height: 1.5; }
.qn-note { font-size: 11.5px; color: var(--warning); background: #fdf6ec; border: 1px solid #f0e0c8; border-radius: 8px; padding: 6px 9px; margin: 8px 0; line-height: 1.65; }

.qn-look { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin: 8px 0; }
.look-hd { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; border: 0; background: var(--tint-2); padding: 7px 10px; font-size: 11.5px; color: var(--ink); }
.look-hd:hover { background: var(--tint); }
.look-hd .arw { font-size: 9px; color: var(--muted); transition: transform .15s; }
.look-hd .arw.open { transform: rotate(90deg); }
.look-bd { padding: 7px 10px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--muted); line-height: 1.8; white-space: pre-wrap; }

.qn-opts { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.qn-opt { display: flex; gap: 9px; align-items: flex-start; width: 100%; text-align: left; border: 1px solid var(--border); background: #fff; border-radius: 10px; padding: 9px 11px; }
.qn-opt:hover { border-color: var(--accent-soft); background: #fcfbff; }
.qn-opt.on { border-color: var(--accent); background: var(--tint); }
.qn-opt .kk { flex: none; width: 20px; height: 20px; line-height: 18px; text-align: center; border: 1px solid var(--border); border-radius: 6px; font-size: 10.5px; font-weight: 700; color: var(--muted); font-family: ui-monospace, Consolas, monospace; }
.qn-opt.on .kk { background: var(--accent); border-color: var(--accent); color: #fff; }
.qn-opt .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.qn-opt .txt b { font-size: 13px; font-weight: 600; }
.qn-opt .txt small { font-size: 11.5px; color: var(--muted); line-height: 1.6; }

.qn-state { margin-top: 9px; font-size: 11.5px; color: var(--muted); background: var(--tint-2); border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; line-height: 1.7; }
.qn-state .undo { border: 0; background: transparent; color: var(--accent); font-size: 11px; text-decoration: underline; text-underline-offset: 2px; margin-left: 8px; padding: 0; }
.qn-acts { display: flex; gap: 6px; margin-top: 9px; flex-wrap: wrap; }
.qn-acts button { font-size: 11.5px; padding: 3px 10px; }
.qn-acts .ask { color: var(--warning); border-color: #f0e0c8; }

.qn-edit { margin-top: 9px; border: 1px solid var(--accent-soft); background: var(--tint); border-radius: 10px; padding: 9px 10px; }
.qn-edit.ask { border-color: #f0e0c8; background: #fdf6ec; }
.qe-hint { font-size: 11.5px; color: var(--muted); margin-bottom: 6px; line-height: 1.7; }
.qn-edit.ask .qe-hint { color: var(--warning); }
.qn-edit textarea { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px; font: inherit; font-size: 12.5px; color: var(--ink); background: #fff; outline: none; resize: vertical; }
.qe-row { display: flex; gap: 7px; justify-content: flex-end; margin-top: 7px; }
.qe-row button { font-size: 11.5px; }

/* 额外页（预埋表 / 入口总表 / 提示词）—— 它们不是题，所以不带选项和动作 */
.qn-extra { padding: 16px 20px; }
.xe-hd { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.xe-hd b { font-size: 14px; }
.xe-sub { font-size: 11.5px; color: var(--muted); line-height: 1.7; }
.xe-tb { width: 100%; border-collapse: collapse; font-size: 12px; }
.xe-tb th {
  text-align: left; font-weight: 600; font-size: 11px; color: var(--muted);
  border-bottom: 1px solid var(--border); padding: 5px 8px; background: var(--tint-2);
}
.xe-tb td { border-bottom: 1px solid var(--tint-2); padding: 6px 8px; vertical-align: top; line-height: 1.7; }
.xe-tb .xe-q { font-weight: 600; color: var(--ink); }
.xe-tb .xe-url { color: var(--accent); word-break: break-all; font-size: 11.5px; }
.xe-pre {
  margin: 0; padding: 11px 13px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--tint-2); font-size: 11.5px; line-height: 1.8; white-space: pre-wrap;
  word-break: break-word; font-family: ui-monospace, Consolas, monospace; color: var(--ink);
}
.qn-ft-note { font-size: 11px; color: var(--muted); }

.qn-meta { margin-top: 10px; border-top: 1px dashed var(--border); padding-top: 7px; display: flex; flex-direction: column; gap: 2px; }
.meta-t { border: 0; background: transparent; text-align: left; color: var(--muted); font-size: 11px; padding: 2px 0; line-height: 1.7; }
.meta-t:hover { color: var(--accent); }

.qn-ft { border-top: 1px solid var(--border); padding: 10px 16px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.qn-ft button { font-size: 12px; }
.qn-ft .ask { color: var(--warning); border-color: #f0e0c8; }
.qn-ok { font-size: 11.5px; color: var(--success); }
.qn-hint { padding: 6px 16px 10px; font-size: 10.5px; color: var(--muted); }
@media (max-width: 860px) { .qn-rail { display: none; } }
</style>
