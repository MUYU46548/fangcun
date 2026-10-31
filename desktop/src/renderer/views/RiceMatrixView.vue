<!--
  需求矩阵（RICE 决策矩阵）—— 项目页第 7 种摆法（2026-10-28，2026-10-30 视觉重画）

  施工输入：
    · 《方寸-RICE打分口径-20261024.md》v1.1（四维口径 / 证据映射 / 池宿主 / 拍板回写）
    · 《方寸-RICE格式闸结论-全栈-20261024.md》schema v1（节式格式 / 两个 MCP 写工具 / 验收线）
    · 设计判断与「为什么不再丢」：docs/ADR-002-需求矩阵.md
    · 视觉原型：docs/小样-RICE决策矩阵-20261025/（2026-10-30 暮雨：「视觉还没照原型重画」）

  口径全在 shared/rice.ts（e2e-rice 纯 Node 跑），这里只管摆与手改。
  三条必须出现在界面上：
    ① 总分不落盘 —— 池里只有 R/I/C/E，总分与等级现算；
    ② 分数不替人做决定 —— 等级只是池内相对位置，拍板是用户动作；
    ③ 每个数字带得走局限 —— 页面底部常驻 RICE_LIMITS，不许只有数字。

  视觉按原型重画（2026-10-30），搬的是**结构与口径**，不搬原型里的演示数据：
    · 顶部 KPI 四格（候选 / P0 / P0 成本 / 预算占用）—— 先给结论，再给明细
    · 散点 = 主角：象限底色 + 网格 + P0 阈值线 + 气泡编号（编号与表格 # 列同一套）
    · 打分表带条形长度与等级徽章 —— 排序看的是相对位置，不只看一个数字
    · 「为什么做，为什么砍」独立成一节，左边是决策记录与容量统计，右边逐条理由
    · 结尾的「立即启动 / 排队候补 / 有余量再说 / 砍掉」四格与底部口径条
  ⚠ 零网络：只走 window.tegula 上的 rice 系列通道（本地文件 IPC）。
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
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
  splitOrigin,
  type RiceItem,
  type RiceLevel,
  type RicePool,
} from '../../shared/rice'
import { toPlain } from '../../shared/plain'
import { copyText } from '../../shared/clipboard'

const props = defineProps<{ toast?: (m: string) => void; tasks?: any[]; projects?: any[] }>()

const loading = ref(false)
const saving = ref(false)
const err = ref('')
const poolPath = ref('')
const budget = ref(0)
const items = ref<RiceItem[]>([])
const filter = ref<'all' | 'P0' | 'P1' | 'P2' | 'CUT' | 'pending'>('all')
/** 项目切换（2026-10-30 暮雨第 5 条：「完全不能按项目切换吗？」） */
const projectFilter = ref<string>('all')
const highlight = ref('')
const hover = ref('')
/** 「补理由」内联编辑（只服务「为什么做，为什么砍」里被点名的缺理由项） */
const reasonFor = ref('')
const reasonDraft = ref('')
const reasonSaving = ref(false)

function openReason(eid: string) {
  const it = itemByEid.value.get(eid)
  if (!it) return
  reasonFor.value = eid
  reasonDraft.value = String(it.note || '')
}

function closeReason() {
  reasonFor.value = ''
  reasonDraft.value = ''
}

async function saveReason(eid: string) {
  const it = itemByEid.value.get(eid)
  if (!it || reasonSaving.value) return
  const text = reasonDraft.value.trim()
  if (!text) { tip('理由不能是空的 —— 写一句为什么做 / 为什么砍'); return }
  reasonSaving.value = true
  try {
    await patch(it, { note: text })
    closeReason()
  } finally {
    reasonSaving.value = false
  }
}
// 筛选/项目一变，右侧明细里的旧条目就不该继续挂着（否则会出现"筛了 P1，明细还是 P0"）
watch([filter, projectFilter], () => { highlight.value = ''; hover.value = '' })
const tip = (m: string) => { if (props.toast) props.toast(m) }

/** 任务 id → 任务（只用于把 origin 映射回项目；读不到就归「未归属」） */
const taskMap = computed(() => {
  const m = new Map<string, any>()
  for (const t of props.tasks || []) if (t && t.id) m.set(String(t.id), t)
  return m
})

function normProj(p: any): string {
  if (!p) return ''
  return Array.isArray(p) ? String(p[0] || '') : String(p)
}

/** 这条需求属于哪个项目：优先用主进程补的只读字段，其次从任务缓存推；都没有 = 未归属 */
function projectOf(it: RiceItem): string {
  const direct = normProj((it as any).project)
  if (direct) return direct
  const o = splitOrigin(it.origin || '')
  if (!o || o.type !== 'task') return ''
  const t = taskMap.value.get(o.id)
  if (!t) return ''
  return normProj(t.project ?? t.fm?.project)
}

const projectName = (id: string): string => {
  if (!id) return '未归属'
  const p = (props.projects || []).find((x: any) => String(x.id) === id)
  return p ? String(p.name || p.id) : id
}

/** 每个项目下有几条需求 —— 下拉里直接写出来，免得切过去才发现是空的（2026-10-31 第 2/4 条） */
const projectCounts = computed(() => {
  const m = new Map<string, number>()
  for (const it of items.value) {
    const key = projectOf(it) || '__none__'
    m.set(key, (m.get(key) || 0) + 1)
  }
  return m
})

const projectOptions = computed(() => {
  const m = new Map<string, string>()
  for (const p of props.projects || []) {
    if (p && p.id) m.set(String(p.id), String(p.name || p.id))
  }
  for (const it of items.value) {
    const pid = projectOf(it)
    if (pid && !m.has(pid)) m.set(pid, pid)
  }
  const list = [
    { id: 'all', name: '全部项目' },
    ...Array.from(m, ([id, name]) => ({ id, name })),
    { id: '__none__', name: '未归属' },
  ]
  return list.map((o) => ({
    ...o,
    count: o.id === 'all' ? items.value.length : (projectCounts.value.get(o.id) || 0),
  }))
})

/** 任务卡属于哪个项目（任务缓存里两种写法都有：t.project / t.fm.project） */
function projectOfTask(t: any): string {
  if (!t) return ''
  return normProj(t.project ?? t.fm?.project)
}

/** 这个项目下的任务卡（只用来回答「为什么这里没有需求、我该怎么办」） */
const projectTasks = computed(() => {
  if (projectFilter.value === 'all' || projectFilter.value === '__none__') return []
  return (props.tasks || []).filter((t: any) => projectOfTask(t) === projectFilter.value)
})

/** 已经在池里的任务 id（用来算「还有几张任务卡没进池」） */
const pooledTaskIds = computed(() => {
  const s = new Set<string>()
  for (const it of items.value) {
    const o = splitOrigin(it.origin || '')
    if (o && o.type === 'task') s.add(String(o.id))
  }
  return s
})

const projectMissingTasks = computed(() => projectTasks.value.filter((t: any) => !pooledTaskIds.value.has(String(t.id))))

/** 空项目的出口：把「往池里加需求」这件事写成一张能直接粘给 agent 的指令 */
async function copyAddPrompt(): Promise<void> {
  const name = projectName(projectFilter.value)
  const list = projectMissingTasks.value.slice(0, 12).map((t: any) =>
    `- ${t.id}｜${t.title || t.fm?.title || '（无标题）'}（当前状态：${t.status || t.fm?.status || '未填'}）`)
  const text = [
    `请把这批候选需求写进方寸的需求评估池（项目：${name}），用 MCP 工具 rice_pool_upsert。`,
    '',
    '每条的字段：eid / title / origin（type:id）/ R（每周大概用几次）/ I（省多少事，只取 0.25、0.5、1、2、3）/ C（把握，只取 0.95、0.85、0.7、0.6）/ E_days（要做几天，正整数）/ E_cost（花多少钱，元）/ evidence（证据等级：亲口要、实测踩过、agent推断、纯直觉）。',
    '分数只用来排序，不要替我写「采纳 / 砍掉」。拿不准的就按最低证据写，并在 note 里说明缺哪条证据。',
    list.length ? '\n候选项（来自这个项目下还没进池的任务卡）：\n' + list.join('\n') : '',
  ].filter(Boolean).join('\n')
  const r = await copyText(text)
  tip(r.ok ? '已复制，粘给 agent 就能把需求加进池' : `复制失败：${r.error || '未知原因'}`)
}

/** 当前项目范围（项目切换后才算「这一屏」） */
const scopedItems = computed(() => items.value.filter((it) => {
  const pid = projectOf(it)
  if (projectFilter.value === 'all') return true
  if (projectFilter.value === '__none__') return !pid
  return pid === projectFilter.value
}))

const projectByEid = computed(() => {
  const m = new Map<string, string>()
  for (const it of items.value) m.set(it.eid, projectOf(it))
  return m
})

function poolOf(): RicePool {
  return { budget: budget.value, items: scopedItems.value }
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
    tip('已保存，优先级分与等级已重算')
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
  if (cut && !confirm(`把「${it.title}」记为「砍掉」？\n会在 decisions.md 记一张「已撤销」的决策卡，池里留痕不删。`)) return
  const status = cut ? '已撤销' : '有效'
  const r: any = await (window as any).tegula.riceDecide(
    toPlain([{ eid: it.eid, 状态: status }]),
    toPlain({ batch: 'rice-export-' + today().replace(/-/g, '') })
  )
  if (!r) return tip('记录失败：没有返回结果')
  if (r.ok === false && !(r.results && r.results.some((x: any) => x.ok))) {
    return tip(String(r.error || r.results?.[0]?.error || '记录失败'))
  }
  if (r.pool) {
    budget.value = Number(r.pool.budget) || 0
    items.value = Array.isArray(r.pool.items) ? r.pool.items : []
  }
  const one = (r.results || [])[0]
  tip(one && one.ok ? `已记进决策卡 ${one.decisionId}${one.exists ? '（之前记过，没有重复写）' : ''}` : String(one?.error || '记录失败'))
}

const levels = computed(() => levelOfMap(items.value))
/** 当前项目范围内（切项目跟着变）：候选数 / P0 数 / 工期 */
const summary = computed(() => riceSummary(poolOf()))
/**
 * 全池（切项目不变）：月预算是一份、面向整池的，**不能随项目切换变成 0%** ——
 * 那会让「本项目暂无需求」看起来像「这个月一分钱没花」。（2026-10-31 第 2/4 条顺带修的）
 */
const poolSummary = computed(() => riceSummary({ budget: budget.value, items: items.value }))
const subText = computed(() => {
  if (!items.value.length) return '池里还没有需求'
  if (scopedItems.value.length) return summary.value.text
  const who = projectFilter.value === '__none__' ? '未归属' : projectName(projectFilter.value)
  return `「${who}」下还没有需求 · 全池 ${items.value.length} 条`
})
// 「为什么做，为什么砍」：分数只是入口，理由逐条 —— 定了却没写理由的要被点名（原型第 3 条设计判断）
const why = computed(() => riceWhyReview(poolOf()))

/** 当前项目范围内的条目按总分降序；总分算不出的排最后（不拿 0 假装有分） */
const allRows = computed(() => {
  return scopedItems.value
    .map((it) => ({ it, s: scoreOf(it), level: (levels.value[it.eid] || 'P2') as RiceLevel }))
    .sort((a, b) => {
      const av = Number.isFinite(a.s) ? a.s : -Infinity
      const bv = Number.isFinite(b.s) ? b.s : -Infinity
      if (bv !== av) return bv - av
      return a.it.eid < b.it.eid ? -1 : 1
    })
    .map((r, i) => ({ ...r, rank: i + 1 }))
})

const itemByEid = computed(() => {
  const m = new Map<string, RiceItem>()
  for (const it of items.value) m.set(it.eid, it)
  return m
})

/** # 列与气泡里的编号必须是同一套（原型：气泡编号 = 表格排名） */
const rankOf = computed(() => {
  const m: Record<string, number> = {}
  for (const r of allRows.value) m[r.it.eid] = r.rank
  return m
})

const rows = computed(() => {
  const list = allRows.value
  if (filter.value === 'all') return list
  if (filter.value === 'pending') return list.filter((r) => !r.it.verdict)
  return list.filter((r) => r.level === filter.value)
})

const maxScore = computed(() => {
  let m = 0
  for (const r of allRows.value) if (Number.isFinite(r.s) && r.s > m) m = r.s
  return m
})

const barWidth = (s: number) => {
  if (!Number.isFinite(s) || !maxScore.value) return 0
  return Math.max(3, Math.round((s / maxScore.value) * 100))
}

/** 顶部四格：先给结论（有几条 / P0 几条 / 多少成本 / 预算占多少），明细在下面 */
const kpis = computed(() => {
  const p0 = allRows.value.filter((r) => r.level === 'P0').length
  const ratio = poolSummary.value.budgetRatio
  const over = poolSummary.value.guard === 'over'
  const tight = poolSummary.value.guard === 'tight'
  return [
    { key: 'total', label: '候选需求', val: scopedItems.value.length, unit: '项', foot: projectFilter.value === 'all' ? '进入本轮评估池' : '当前项目范围内', accent: false, over: false, tight: false },
    { key: 'p0', label: '入选 P0', val: p0, unit: '项', foot: '等级 = 池内相对位置（前 20%）', accent: true, over: false, tight: false },
    { key: 'days', label: 'P0 合计工期', val: summary.value.p0Days, unit: '天', foot: '把入选 P0 的「要做几天」直接相加', accent: false, over: false, tight: false },
    {
      key: 'budget',
      label: '预算占用',
      val: ratio === null ? '未设' : Math.round((ratio || 0) * 100),
      unit: ratio === null ? '' : '%',
      foot: ratio === null ? '月预算未设置 —— 不等于没超支' : `全池 P0 ¥${poolSummary.value.p0Cost} / ¥${poolSummary.value.budget}`,
      accent: false,
      over,
      tight,
    },
  ]
})

/** 四格结论（原型结尾那排）：本季必做 / 排队 / 有余量 / 砍掉 */
const verdicts = computed(() => {
  const meta: Record<RiceLevel, { label: string; sub: string }> = {
    P0: { label: '立即启动', sub: '本季必做' },
    P1: { label: '排队候补', sub: '容量释放即启动' },
    P2: { label: '有余量再说', sub: '重评后再议' },
    CUT: { label: '砍掉', sub: '不排进待办' },
  }
  return (['P0', 'P1', 'P2', 'CUT'] as RiceLevel[]).map((lv) => {
    const list = allRows.value.filter((r) => r.level === lv)
    const days = list.reduce((s, r) => s + (Number.isFinite(r.it.E_days) ? r.it.E_days : 0), 0)
    return { lv, count: list.length, days, ...meta[lv] }
  })
})

const filterChips = computed(() => {
  const counts: Record<string, number> = {
    all: scopedItems.value.length,
    P0: allRows.value.filter((r) => r.level === 'P0').length,
    P1: allRows.value.filter((r) => r.level === 'P1').length,
    P2: allRows.value.filter((r) => r.level === 'P2').length,
    CUT: allRows.value.filter((r) => r.level === 'CUT').length,
    pending: scopedItems.value.filter((it) => !it.verdict).length,
  }
  const list: Array<{ v: typeof filter.value; label: string }> = [
    { v: 'all', label: '全部' },
    { v: 'P0', label: 'P0 立即启动' },
    { v: 'P1', label: 'P1 排队候补' },
    { v: 'P2', label: 'P2 有余量再说' },
    { v: 'CUT', label: 'CUT 砍掉' },
    { v: 'pending', label: '未决定' },
  ]
  return list.map((x) => ({ ...x, count: counts[x.v] || 0 }))
})

const W = 880
const H = 460
const PAD = 46
const innerW = W - PAD * 2
const innerH = H - PAD * 2
const geoAll = computed(() => riceGeometry(items.value, W, H, PAD))
/** 散点只画当前项目范围内的条目；坐标轴仍按全池算，换项目不会把图缩成一条线 */
const geo = computed(() => {
  const g = geoAll.value
  if (projectFilter.value === 'all') return g
  const points = g.points.filter((p) => {
    const pid = projectByEid.value.get(p.eid) || ''
    return projectFilter.value === '__none__' ? !pid : pid === projectFilter.value
  })
  return { ...g, points }
})
const splitPx = computed(() => {
  const g = geo.value
  return g.maxX > 0 ? PAD + (g.splitX / g.maxX) * innerW : W / 2
})
const splitPy = computed(() => {
  const g = geo.value
  return g.maxY > 0 ? H - PAD - (g.splitY / g.maxY) * innerH : H / 2
})

function axisTicks(max: number, n: number): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0]
  const step = max / n
  return Array.from({ length: n + 1 }, (_, i) => Math.round(step * i * 10) / 10)
}
const xTicks = computed(() => axisTicks(geo.value.maxX, 4))
const yTicks = computed(() => axisTicks(geo.value.maxY, 4))
const xPos = (v: number) => (geo.value.maxX > 0 ? PAD + (v / geo.value.maxX) * innerW : PAD)
const yPos = (v: number) => (geo.value.maxY > 0 ? H - PAD - (v / geo.value.maxY) * innerH : H - PAD)

/** P0 阈值线：等级是池内相对位置，所以阈值就是「最低的那个 P0 分」，不是写死的分数线 */
const p0Line = computed(() => {
  const scores = allRows.value.filter((r) => r.level === 'P0' && Number.isFinite(r.s)).map((r) => r.s)
  if (!scores.length || !geo.value.maxY) return null
  return { score: Math.min(...scores), y: yPos(Math.min(...scores)) }
})

/** 低等级先画、P0 压最上层（和原型一致：重要的气泡不许被盖住） */
const drawPoints = computed(() => {
  const weight: Record<string, number> = { CUT: 0, P2: 1, P1: 2, P0: 3 }
  return geo.value.points.slice().sort((a, b) => {
    const aw = weight[a.level] ?? 0
    const bw = weight[b.level] ?? 0
    if (aw !== bw) return aw - bw
    return a.score - b.score
  })
})

/**
 * 气泡坐标要**夹在绘图区内**：池里最高分那条本来就落在纵轴顶边（y = PAD），
 * 不夹的话半个气泡跑到框外、编号也看不见（2026-10-30 截图目检当场抓到）。
 * 原型也是这么做的（`Math.min(sy, y1 - 15)`）。
 */
/** 筛选 chip 必须同时作用于**散点和表格**（2026-10-30 暮雨第 5 条：点 P1/P2 没反应） */
function pointMatchesFilter(p: { eid: string; level: RiceLevel }): boolean {
  if (filter.value === 'all') return true
  if (filter.value === 'pending') return !itemByEid.value.get(p.eid)?.verdict
  return p.level === filter.value
}

const bubbles = computed(() =>
  drawPoints.value.filter(pointMatchesFilter).map((p) => ({
    ...p,
    cx: Math.min(Math.max(p.x, PAD + p.r), W - PAD - p.r),
    cy: Math.min(Math.max(p.y, PAD + p.r), H - PAD - p.r),
  }))
)

const activeEid = computed(() => highlight.value || hover.value)
const detail = computed(() => allRows.value.find((r) => r.it.eid === activeEid.value) || null)

/**
 * 下拉与明细里别直接印原始倍数（2026-10-31 第 3 条：「人天」这类看不懂的文案）：
 * 0.25 / 0.5 / 1 / 2 / 3 对用户没有意义，说的是「省多少事」；0.95 说的是「把握」。
 * 值仍然是原始数字（落盘口径不变），只换显示。
 */
const IMPACT_TEXT: Record<string, string> = {
  '0.25': '极小（0.25）', '0.5': '低（0.5）', '1': '中（1）', '2': '高（2）', '3': '极大（3）',
}
const impactText = (v: number) => IMPACT_TEXT[String(v)] || String(v)
const confidenceText = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) + '%' : '—')

const levelCls: Record<string, string> = { P0: 'lv0', P1: 'lv1', P2: 'lv2', CUT: 'lvx' }
const ORIGIN_LABEL: Record<string, string> = { task: '任务', idea: '想法', todo: '待办', external: '外部' }
const coord = (n: number) => Math.round(n * 10) / 10
const scoreText = (n: number) => (Number.isFinite(n) ? String(n) : '—')
const daysText = (n: number) => (Number.isFinite(n) ? String(n) : '—')
/** 来源显示成「任务 · id」而不是一串 `task:xxx`（用户原话：根本看不懂每一条是做什么的） */
function originText(it: RiceItem): string {
  const o = splitOrigin(it.origin || '')
  if (!o) return it.origin || '—'
  return `${ORIGIN_LABEL[o.type] || o.type} · ${o.id}`
}
/** 结论是用户点出来的；界面只说「采纳 / 砍掉 / 未决定」，不把内部枚举直接印出来 */
function verdictText(v: string): string {
  if (v === '有效') return '采纳'
  if (v === 'CUT') return '砍掉'
  return '未决定'
}

/**
 * 开工交接单（2026-10-30 暮雨第 7 条）。
 *
 * 矩阵现在只回答「先做哪个」，不回答「怎么把它做对」。这张单子把
 * grill-me → to-spec → to-tickets → TDD/双路 review 的顺序写成一段可直接粘给 agent 的要求：
 * 先问清楚，再写规格，再拆成「能验收的一件事」，最后用测试和两路 review 把合格线提前钉死。
 * 不自动跑、不改状态 —— 仍然是用户点一下复制。
 */
function kickoffText(it: RiceItem): string {
  const s = scoreOf(it)
  const level = levels.value[it.eid] || 'P2'
  return [
    `# 需求开工交接单：${it.title}`,
    '',
    `- 项目：${projectName(projectOf(it))}`,
    `- 来源：${originText(it)}`,
    `- 当前判断：得分 ${scoreText(s)}（${level}）· 结论 ${verdictText(it.verdict)}`,
    `- 已知证据：${it.evidence || '（没写）'}`,
    `- 已知成本：${daysText(it.E_days)} 天 · ¥${it.E_cost}`,
    `- 已知备注：${it.note || '（没写）'}`,
    '',
    '## 0. 先问清楚（不要直接开做）',
    '请先只做澄清，逐条回答或追问我；答不清就不要进入实现：',
    '1. 这件事的“完成”是什么样？谁验收？',
    '2. 明确不做什么（非目标）？',
    '3. 现在的证据够吗？缺哪一条会推翻整个判断？',
    '4. 最坏情况 / 失败样例是什么？',
    '5. 硬约束有哪些（时间、预算、兼容、数据、不可逆操作）？',
    '',
    '## 1. 写成规格（to-spec）',
    '把澄清结果整理成一页：目标 / 非目标 / 用户场景 / 输入输出 / 边界条件 / 验收线。',
    '',
    '## 2. 拆成“能验收的一件事”（to-tickets）',
    '每个工单必须包含：能独立验收的行为 + 验收命令或检查 + 失败样例。',
    '拆不出验收线，就继续拆；不要把几件事糊成一张大工单。',
    '',
    '## 3. 施工与验收（TDD + 双路 review）',
    '先写失败测试 / 验收脚本，再实现；完成后走两路 review：',
    '一路看行为与测试是否真覆盖，一路看回归、安全与边界。没有验收证据不算完成。',
    '',
    '## 4. 交回方寸',
    '把规格、工单、验收结果写进任务卡或执行日志；不要改这里的分数（除非有新证据）。',
  ].join('\n')
}

async function copyKickoff(it: RiceItem): Promise<void> {
  const r = await copyText(kickoffText(it))
  tip(r.ok ? '已复制开工交接单（先问清楚 → 写规格 → 拆成能验收的工单 → 先写测试再实现 + 两路复查）' : `复制失败：${r.error || '未知原因'}`)
}
</script>

<template>
  <div class="rice">
    <div class="rice-head">
      <div class="rice-head-main">
        <div class="rice-eyebrow">价值判断 · 路线图优先级</div>
        <div class="rice-ttl">需求优先级矩阵</div>
        <div class="rice-sub">{{ subText }}</div>
      </div>
      <div class="rice-head-tools">
        <label class="rice-projsel" title="按项目查看这张矩阵（项目从需求的来源推导；括号里是这个项目下已有几条）">
          <span>项目</span>
          <select v-model="projectFilter">
            <option v-for="p in projectOptions" :key="'rp-' + p.id" :value="p.id">{{ p.name }}（{{ p.count }} 条）</option>
          </select>
        </label>
        <button class="ghost rice-refresh" :disabled="loading || saving" @click="load">
          {{ loading ? '⟳ 读取中…' : '↻ 刷新' }}</button>
      </div>
    </div>

    <!-- 原型里那句写在最显眼处的立场：分数不替你做决定（不许只塞进底部局限列表） -->
    <div class="rice-stance">{{ RICE_STANCE }}</div>

    <div class="rice-where" v-if="poolPath">
      池文件：<code>{{ poolPath }}</code>
      <span class="rice-where-hint">（池里只存四个原始分：每周用几次、省多少事、把握多大、要做几天；优先级分和等级由本页现算，不写回文件）</span>
    </div>

    <!-- KPI：先给结论，再给明细 -->
    <div class="rice-kpis">
      <div v-for="k in kpis" :key="k.key" class="rice-kpi" :class="{ accent: k.accent, over: k.over, tight: k.tight }">
        <div class="rice-kpi-label">{{ k.label }}</div>
        <div class="rice-kpi-val">{{ k.val }}<span class="rice-kpi-u">{{ k.unit }}</span></div>
        <div class="rice-kpi-foot">{{ k.foot }}</div>
      </div>
    </div>

    <!-- 预算护栏：数字 + 判定 + 余量必须一起出现 -->
    <div class="rice-budget">
      <label>月预算（元，全池共用）</label>
      <input class="rice-num" type="number" min="0" step="1" v-model.number="budget" @change="setBudget" />
      <span class="rice-budget-hint" v-if="poolSummary.budget > 0">
        全池 P0 花费 ¥{{ poolSummary.p0Cost }} / ¥{{ poolSummary.budget }}
        <b :class="{ over: poolSummary.guard === 'over' || poolSummary.guard === 'tight' }">{{ Math.round((poolSummary.budgetRatio || 0) * 100) }}%</b>
        · 余量 ¥{{ poolSummary.headroom }}
      </span>
      <span class="rice-budget-hint" v-else>预算未设置 —— 页面不会把「没设预算」说成「没超支」</span>
      <span class="rice-guard" :class="poolSummary.guard">{{ poolSummary.guardText }}</span>
    </div>

    <div v-if="err" class="rice-err">{{ err }}</div>
    <div v-else-if="!items.length" class="rice-empty">
      <div>{{ RICE_EMPTY_TEXT }}</div>
      <div class="rice-empty-sub">
        池文件不存在时这里是空的，<b>不是</b>读取失败；灌入后会出现在下方散点与表格里。
      </div>
    </div>
    <div v-else-if="!scopedItems.length" class="rice-empty">
      <div class="rice-empty-t">
        <template v-if="projectFilter === '__none__'">没有「未归属」的需求。</template>
        <template v-else>「{{ projectName(projectFilter) }}」这个项目下还没有需求。</template>
      </div>
      <div class="rice-empty-sub" v-if="projectFilter === '__none__'">
        外部清单条目、想法（想法本身不挂项目）、以及没填项目的任务卡，都会落在「未归属」——
        这些不是丢了，只是没有项目可归。
      </div>
      <div class="rice-empty-sub" v-else>
        需求挂在哪个项目，看它来自哪张任务卡 / 哪条待办；想法没有项目归属，会落在「未归属」。
        <template v-if="projectTasks.length">
          这个项目下现有 <b>{{ projectTasks.length }}</b> 张任务卡，其中 <b>{{ projectMissingTasks.length }}</b> 张还没进评估池。
        </template>
        <template v-else>
          这个项目下还没有任何任务卡 —— 先在任务卡里把「项目」填成「{{ projectName(projectFilter) }}」，需求才挂得上来。
        </template>
      </div>
      <div class="rice-empty-act">
        <button class="ghost" @click="projectFilter = 'all'">← 看全部项目（{{ items.length }} 条）</button>
        <button class="ghost" v-if="projectFilter !== '__none__'" @click="copyAddPrompt()">
          ⧉ 复制「往池里加需求」的指令</button>
      </div>
      <div class="rice-empty-foot">
        这一页只负责排序和取舍，不负责录入 —— 需求由 agent 写进 rice-pool.md，刷新后就出现在这里。
      </div>
    </div>

    <template v-else>
      <!-- ① 散点矩阵：横轴成本（天），纵轴优先级得分，气泡大小 = 使用频次 -->
      <section class="rice-sec">
        <div class="rice-sec-h">
          <span class="rice-no">1</span>
          <h3>散点图：要做几天 × 优先级分</h3>
          <span class="rice-hint">横轴 = 要做几天　纵轴 = 优先级分　气泡越大 = 每周用得越多</span>
        </div>
        <div class="rice-panel">
          <div class="rice-chips">
            <span class="rice-chips-label">筛选</span>
            <button v-for="f in filterChips" :key="f.v" class="rice-chip" :class="{ on: filter === f.v }"
              :aria-pressed="filter === f.v ? 'true' : 'false'" @click="filter = f.v">
              <i class="rice-chip-dot" :class="f.v === 'all' || f.v === 'pending' ? '' : levelCls[f.v]"></i>
              {{ f.label }}<span class="rice-chip-n">{{ f.count }}</span>
            </button>
            <span class="rice-grow"></span>
            <span class="rice-size-legend">
              气泡越大 = 每周用得越多
              <i class="rice-size" style="width:7px;height:7px"></i>
              <i class="rice-size" style="width:11px;height:11px"></i>
              <i class="rice-size" style="width:15px;height:15px"></i>
            </span>
          </div>

          <div class="rice-plotwrap">
            <svg :viewBox="`0 0 ${W} ${H}`" class="rice-svg" role="img" aria-label="需求优先级矩阵散点图">
              <!-- 象限底色：相对位置负责解释原因，P 级负责决定顺序 -->
              <rect :x="PAD" :y="PAD" :width="splitPx - PAD" :height="splitPy - PAD" class="rice-quad-fill q-do" />
              <rect :x="splitPx" :y="PAD" :width="W - PAD - splitPx" :height="splitPy - PAD" class="rice-quad-fill q-plan" />
              <rect :x="PAD" :y="splitPy" :width="splitPx - PAD" :height="H - PAD - splitPy" class="rice-quad-fill q-fill" />
              <rect :x="splitPx" :y="splitPy" :width="W - PAD - splitPx" :height="H - PAD - splitPy" class="rice-quad-fill q-cut" />

              <!-- 网格 -->
              <line v-for="t in yTicks" :key="'gy' + t" :x1="PAD" :y1="yPos(t)" :x2="W - PAD" :y2="yPos(t)" class="rice-grid" />
              <line v-for="t in xTicks" :key="'gx' + t" :x1="xPos(t)" :y1="PAD" :x2="xPos(t)" :y2="H - PAD" class="rice-grid" />

              <!-- 象限分割线 -->
              <line :x1="splitPx" :y1="PAD" :x2="splitPx" :y2="H - PAD" class="rice-split" />
              <line :x1="PAD" :y1="splitPy" :x2="W - PAD" :y2="splitPy" class="rice-split" />

              <!-- P0 阈值线（最低的那个 P0 分；不是写死的分数线） -->
              <g v-if="p0Line">
                <line :x1="PAD" :y1="p0Line.y" :x2="W - PAD" :y2="p0Line.y" class="rice-threshold" />
                <text :x="W - PAD - 4" :y="p0Line.y - 6" class="rice-threshold-t" text-anchor="end">P0 分界线 {{ scoreText(p0Line.score) }}</text>
              </g>

              <!-- 坐标轴 -->
              <line :x1="PAD" :y1="PAD" :x2="PAD" :y2="H - PAD" class="rice-axis-line" />
              <line :x1="PAD" :y1="H - PAD" :x2="W - PAD" :y2="H - PAD" class="rice-axis-line" />

              <!-- 象限标签 -->
              <text :x="PAD + 12" :y="PAD + 22" class="rice-quad-label q-do">优先做 · 高价值低成本</text>
              <text :x="W - PAD - 12" :y="PAD + 22" class="rice-quad-label q-plan" text-anchor="end">要想清楚 · 高价值高成本</text>
              <text :x="PAD + 12" :y="H - PAD - 12" class="rice-quad-label q-fill">顺手 · 低价值低成本</text>
              <text :x="W - PAD - 12" :y="H - PAD - 12" class="rice-quad-label q-cut" text-anchor="end">别做 · 低价值高成本</text>

              <!-- 刻度 -->
              <text v-for="t in yTicks" :key="'ty' + t" :x="PAD - 10" :y="yPos(t) + 3" class="rice-axis" text-anchor="end">{{ t }}</text>
              <text v-for="t in xTicks" :key="'tx' + t" :x="xPos(t)" :y="H - PAD + 18" class="rice-axis" text-anchor="middle">{{ t }}</text>

              <!-- 轴标题 -->
              <text :x="PAD + innerW / 2" :y="H - 10" class="rice-axis-title" text-anchor="middle">要做几天（越右越花时间）</text>
              <text :x="-(PAD + innerH / 2)" :y="16" transform="rotate(-90)" class="rice-axis-title" text-anchor="middle">优先级分（越高越该先做）</text>

              <!-- 气泡：编号 = 表格 # 列；点击高亮同行，悬停看明细 -->
              <g v-for="p in bubbles" :key="p.eid" class="rice-pt" :class="[levelCls[p.level], { on: activeEid === p.eid }]"
                @click="highlight = p.eid" @mouseenter="hover = p.eid" @mouseleave="hover = ''">
                <circle :cx="p.cx" :cy="p.cy" :r="p.r" class="rice-bubble" :class="levelCls[p.level]" />
                <text v-if="p.r >= 8" :x="p.cx" :y="coord(p.cy + 3.5)" class="rice-bubble-n" :class="levelCls[p.level]"
                  text-anchor="middle">{{ rankOf[p.eid] }}</text>
                <title>{{ p.title }}｜得分 {{ scoreText(p.score) }}｜{{ p.level }}｜{{ p.quadrant }}</title>
              </g>
            </svg>

            <!-- 筛选后没有气泡时明说，不让整块图看起来"坏掉了" -->
            <div v-if="!bubbles.length" class="rice-plot-empty">
              当前筛选下没有可画的需求 —— 换「全部」或切回全部项目。
            </div>

            <!-- 悬停/点击明细。
                 ⚠ 这块**必须固定高度**（2026-10-31 第 1 条：鼠标放在表格行上画面剧烈抖动）：
                 它挂在表格上方，若随内容伸缩，hover 一行 → 面板变高 → 整张表被推下去 →
                 鼠标离开那一行 → 面板缩回 → 表又回来 → 反复触发，视觉上就是抽搐。
                 固定高度 + 内部滚动，让 hover 只换内容、不动布局。 -->
            <div class="rice-detail" :class="{ 'rice-detail-empty': !detail }">
              <template v-if="detail">
                <div class="rice-detail-top">
                  <span class="rice-detail-rank" :class="levelCls[detail.level]">#{{ detail.rank }}</span>
                  <span class="rice-detail-title">{{ detail.it.title }}</span>
                  <span class="rice-badge" :class="levelCls[detail.level]">{{ detail.level }}</span>
                </div>
                <div class="rice-detail-score">
                  <span>优先级分</span><b>{{ scoreText(detail.s) }}</b>
                  <span class="rice-detail-formula">每周用 {{ detail.it.R }} 次 × 省多少事 {{ impactText(detail.it.I) }} × 把握 {{ confidenceText(detail.it.C) }} ÷ 要做 {{ detail.it.E_days }} 天</span>
                </div>
                <div class="rice-detail-grid">
                  <span>项目 <b>{{ projectName(projectOf(detail.it)) }}</b></span>
                  <span>来源 <b>{{ originText(detail.it) }}</b></span>
                  <span>证据 <b>{{ detail.it.evidence || '—' }}</b></span>
                  <span>成本 <b>{{ daysText(detail.it.E_days) }} 天 · ¥{{ detail.it.E_cost }}</b></span>
                  <span>你的决定 <b>{{ verdictText(detail.it.verdict) }}</b></span>
                </div>
                <div class="rice-detail-note" v-if="detail.it.note">{{ detail.it.note }}</div>
                <div class="rice-detail-hint">
                  数字只说明相对位置，不替你做决定
                  <button class="ghost rice-kick" title="复制一段开工交接单：先问清楚 → 写规格 → 拆成能验收的工单 → 先写测试再实现 + 两路复查"
                    @click="copyKickoff(detail.it)">⧉ 复制开工交接单</button>
                </div>
              </template>
              <div class="rice-detail-idle" v-else>
                <div class="rice-detail-idle-h">
                  把鼠标放在气泡或表格行上，这里显示这一条为什么排在这儿；气泡里的编号就是表格的 # 排名。
                </div>
                <div class="rice-detail-idle-grid">
                  <span><b>每周用几次</b>　估出来的使用次数，不是统计</span>
                  <span><b>省多少事</b>　3 极大 → 0.25 极小</span>
                  <span><b>把握多大</b>　只由证据决定，最高 95%</span>
                  <span><b>要做几天</b>　进公式；花多少钱只作参考</span>
                </div>
              </div>
            </div>
          </div>

          <p class="rice-mx-note">
            四个象限按池子中间值切分，只看<b>相对位置</b>；P0 / P1 / P2 按<b>池内排名</b>划分（P0 = 最靠前的 20%）。
            两者不一致时以 P 级为准 —— 象限解释为什么，分数决定先后。
          </p>
        </div>
      </section>

      <!-- ② 打分与排序 -->
      <section class="rice-sec">
        <div class="rice-sec-h">
          <span class="rice-no">2</span>
          <h3>打分与排序</h3>
          <span class="rice-hint">按优先级分从高到低 · 改任何一格立即重算并保存 · 「采纳 / 砍掉」由你点</span>
        </div>
        <div class="rice-panel">
          <div class="rice-tablewrap">
            <table class="rice-table">
              <thead>
                <tr>
                  <th class="rice-th-rank">#</th>
                  <th>需求</th><th>项目</th><th>来源</th>
                  <th title="这条需求每周大概会被用几次">每周用几次</th>
                  <th title="做成之后能省多少手工：3 极大 / 2 高 / 1 中 / 0.5 低 / 0.25 极小">省多少事</th>
                  <th title="对「它真的有用」有多大把握">把握多大</th>
                  <th title="预计要做几天（正整数，进公式）">要做几天</th>
                  <th title="预计花多少钱（元，只作参考）">花多少钱</th>
                  <th>证据来源</th><th class="rice-th-score">优先级分</th><th>你的决定</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in rows" :key="r.it.eid" :class="[levelCls[r.level], { on: activeEid === r.it.eid }]"
                  @click="highlight = r.it.eid" @mouseenter="hover = r.it.eid" @mouseleave="hover = ''">
                  <td class="rice-rank">{{ r.rank }}</td>
                  <td class="rice-name">
                    <div class="rice-title" :title="(r.it.note ? r.it.note + '\n' : '') + '打分：' + (r.it.by || '—')">{{ r.it.title }}</div>
                    <div class="rice-title-note" v-if="r.it.note">{{ r.it.note }}</div>
                    <div class="rice-eid">{{ r.it.eid }}</div>
                  </td>
                  <td class="rice-proj">{{ projectName(projectOf(r.it)) }}</td>
                  <td class="rice-origin">{{ originText(r.it) }}</td>
                  <td><input class="rice-num" type="number" min="0" step="1" :value="r.it.R"
                    @change="onNum(r.it, 'R', $event)" /></td>
                  <td>
                    <select class="rice-sel" :value="r.it.I" @change="onNum(r.it, 'I', $event)">
                      <option v-for="v in RICE_IMPACT_VALUES" :key="v" :value="v">{{ impactText(v) }}</option>
                    </select>
                  </td>
                  <td>
                    <select class="rice-sel" :value="r.it.C" @change="onNum(r.it, 'C', $event)">
                      <option v-for="v in RICE_CONFIDENCE_VALUES" :key="v" :value="v">{{ confidenceText(v) }}</option>
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
                  <td class="rice-score-cell">
                    <div class="rice-score">
                      <span class="rice-bar"><i :style="{ width: barWidth(r.s) + '%' }"></i></span>
                      <span class="rice-score-v">{{ scoreText(r.s) }}</span>
                    </div>
                    <span class="rice-badge" :class="levelCls[r.level]">{{ r.level }}</span>
                  </td>
                  <td class="rice-verdict">
                    <template v-if="r.it.verdict">
                      <span class="rice-vd" :class="{ cut: r.it.verdict === 'CUT' }">{{ verdictText(r.it.verdict) }}</span>
                      <span class="rice-did">{{ r.it.decisionId }}</span>
                    </template>
                    <template v-else>
                      <button class="ghost rice-vbtn" :disabled="saving" @click.stop="decide(r.it, false)">采纳</button>
                      <button class="ghost rice-vbtn cut" :disabled="saving" @click.stop="decide(r.it, true)">砍掉</button>
                    </template>
                  </td>
                </tr>
                <tr v-if="!rows.length">
                  <td colspan="12" class="rice-none">这个筛选下没有条目（换「全部」看看）</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="rice-tbl-foot">
            <span>省多少事：3 极大 / 2 高 / 1 中 / 0.5 低 / 0.25 极小</span>
            <span>把握多大：95% 见过实测 · 85% 强信号 · 70% 类比 · 60% 直觉</span>
            <span>「要做几天」进公式；「花多少钱」只作参考，不影响排序</span>
          </div>
        </div>
      </section>

      <!-- ③ 为什么做，为什么砍（原型第 3 条设计判断）：
           分数只是入口，理由逐条写；定了却没写理由的条目必须被点名 —— 那就是没决定。 -->
      <section class="rice-sec" v-if="scopedItems.length">
        <div class="rice-sec-h">
          <span class="rice-no">3</span>
          <h3>为什么做，为什么砍</h3>
          <span class="rice-hint">分数负责排序，人负责解释</span>
        </div>
        <div class="rice-why">
          <div class="rice-why-sig">
            <div class="rice-why-role">决策记录</div>
            <div class="rice-why-nm">本轮评估</div>
            <div class="rice-why-mt">分数只把判断显性化，<br />不替你做决定。<br />真正的取舍在分数之外。</div>
            <div class="rice-why-stats">
              <div class="rice-why-stat"><span>评估池</span><b>{{ scopedItems.length }} 项</b></div>
              <div class="rice-why-stat"><span>P0 合计工期</span><b>{{ summary.p0Days }} 天</b></div>
              <div class="rice-why-stat"><span>已决定</span><b>{{ summary.decided }} 项</b></div>
              <div class="rice-why-stat"><span>没写理由</span><b :class="{ over: why.missingWhy > 0 }">{{ why.missingWhy }} 项</b></div>
            </div>
            <div class="rice-why-sig-note">没写理由的决定不算决定 —— 下次它还会以「听起来很酷」的样子回来。</div>
          </div>
          <div class="rice-why-body">
            <div class="rice-why-h">为什么做，为什么砍<span class="rice-why-sub">{{ why.text }}</span></div>
            <div class="rice-why-cols" v-if="why.keep.length || why.cut.length">
              <div class="rice-why-col">
                <div class="rice-why-t">✓ 做（{{ why.keep.length }}）</div>
                <div class="rice-why-row" v-for="r in why.keep" :key="'k' + r.eid">
                  <b>{{ r.title }}</b>
                  <span class="rice-why-reason" :class="{ missing: !r.hasWhy }">
                    {{ r.hasWhy ? r.why : '⚠ 决定时没写理由 —— 说不清为什么，就不算决定' }}
                  </span>
                  <span class="rice-why-ev" v-if="r.evidence">证据：{{ r.evidence }}</span>
                  <!-- 缺理由的当场就能补：点名之后必须给出口，否则那句「不算决定」只是骂人 -->
                  <div class="rice-why-act" v-if="!r.hasWhy">
                    <button v-if="reasonFor !== r.eid" class="ghost rice-why-btn" @click="openReason(r.eid)">✎ 补一句理由</button>
                    <div class="rice-why-edit" v-else>
                      <textarea v-model="reasonDraft" rows="2" placeholder="为什么做？一句话就够"></textarea>
                      <div class="rice-why-edit-act">
                        <button class="ghost rice-why-btn" :disabled="reasonSaving" @click="saveReason(r.eid)">保存</button>
                        <button class="ghost rice-why-btn" :disabled="reasonSaving" @click="closeReason()">取消</button>
                      </div>
                    </div>
                  </div>
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
                  <div class="rice-why-act" v-if="!r.hasWhy">
                    <button v-if="reasonFor !== r.eid" class="ghost rice-why-btn" @click="openReason(r.eid)">✎ 补一句理由</button>
                    <div class="rice-why-edit" v-else>
                      <textarea v-model="reasonDraft" rows="2" placeholder="为什么砍？一句话就够（下次它还会以「听起来很酷」回来）"></textarea>
                      <div class="rice-why-edit-act">
                        <button class="ghost rice-why-btn" :disabled="reasonSaving" @click="saveReason(r.eid)">保存</button>
                        <button class="ghost rice-why-btn" :disabled="reasonSaving" @click="closeReason()">取消</button>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="rice-why-none" v-if="!why.cut.length">还没有砍掉的</div>
              </div>
            </div>
            <div class="rice-why-empty" v-else>
              还没有决定记录 —— 在表格里点「采纳 / 砍掉」，把理由写进备注，这里就是这季度取舍的底稿。
            </div>
            <div class="rice-verdicts">
              <div v-for="v in verdicts" :key="v.lv" class="rice-vd-block" :class="levelCls[v.lv]">
                <div class="rice-vd-label">{{ v.label }}</div>
                <div class="rice-vd-v">{{ v.count }} 项</div>
                <div class="rice-vd-d">{{ v.days }} 天 · {{ v.sub }}</div>
              </div>
            </div>
            <div class="rice-why-foot">{{ RICE_RECHECK }}</div>
          </div>
        </div>
      </section>
    </template>

    <div class="rice-limits">
      <div class="rice-limits-h">这页证明不了什么</div>
      <div class="rice-limit" v-for="(l, i) in RICE_LIMITS" :key="i">· {{ l }}</div>
    </div>

    <div class="rice-foot">
      <span class="rice-formula">优先级分 = 每周用几次 × 省多少事 × 把握 ÷ 要做几天</span>
      <span>分数只用于同一轮评估内横向比较</span>
    </div>
  </div>
</template>

<style scoped>
/* 新块用自己的 .rice-* 类：不复用旧块的 class（旧断言按 class 数块会凭空变红，见 AGENTS 踩坑 2） */
/* ⚠ width:100% 不能省（2026-10-31 第 2 条）：#board.pv 是 flex 列，
   而 `margin: 0 auto` 会让 auto 横向边距**取消 stretch**，于是这块按内容宽度收缩 ——
   换到条目少的项目时整页突然变窄。固定占满、再用 max-width 封顶，切项目宽度不变。 */
.rice { width: 100%; box-sizing: border-box; padding: 14px 18px 28px; color: var(--ink); max-width: 1180px; margin: 0 auto; }

/* ── 页头 ─────────────────────────────────────────────── */
.rice-head { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
.rice-head-main { display: flex; flex-direction: column; gap: 4px; }
.rice-eyebrow { font-size: 11px; letter-spacing: .16em; font-weight: 700; color: var(--accent); text-transform: uppercase; }
.rice-ttl { font-size: 22px; font-weight: 700; letter-spacing: -.01em; }
.rice-ttl-dim { color: var(--muted); font-weight: 600; }
.rice-sub { font-size: 12.5px; color: var(--muted); max-width: 720px; line-height: 1.7; }
.rice-head-tools { margin-left: auto; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; align-self: flex-start; }
.rice-projsel { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); white-space: nowrap; }
.rice-projsel select { padding: 5px 9px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }
.rice-refresh { margin-left: 0; align-self: flex-start; }

.rice-stance {
  margin-top: 14px; display: inline-block;
  font-size: 12.5px; font-weight: 600; color: var(--ink);
  background: var(--tint); border: 1px solid var(--line-2); border-radius: 999px; padding: 7px 14px;
}
.rice-where { margin-top: 8px; font-size: 12px; color: var(--muted); }
.rice-where code { background: var(--tint-3); border: 1px solid var(--border); border-radius: 6px; padding: 1px 5px; color: var(--ink); }
.rice-where-hint { margin-left: 6px; }

/* ── KPI ──────────────────────────────────────────────── */
.rice-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 16px; }
.rice-kpi { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px 12px; }
.rice-kpi.accent { border-color: var(--accent); background: linear-gradient(178deg, var(--tint) 0%, var(--card) 72%); }
.rice-kpi.over { border-color: var(--danger); }
.rice-kpi.tight { border-color: var(--warning); }
.rice-kpi-label { font-size: 11.5px; color: var(--muted); }
.rice-kpi-val { font-size: 28px; font-weight: 700; letter-spacing: -.02em; margin-top: 4px; line-height: 1.15; }
.rice-kpi.accent .rice-kpi-val { color: var(--accent); }
.rice-kpi.over .rice-kpi-val { color: var(--danger); }
.rice-kpi.tight .rice-kpi-val { color: var(--warning); }
.rice-kpi-u { font-size: 12.5px; font-weight: 600; color: var(--muted); margin-left: 3px; letter-spacing: 0; }
.rice-kpi-foot { font-size: 11px; color: var(--muted); margin-top: 4px; }

/* ── 预算护栏 ─────────────────────────────────────────── */
.rice-budget {
  margin-top: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 12px; color: var(--muted);
  background: var(--tint-3); border: 1px solid var(--border); border-radius: 12px; padding: 10px 14px;
}
.rice-budget label { font-weight: 600; color: var(--ink); }
.rice-budget-hint b { color: var(--success); }
.rice-budget-hint b.over { color: var(--danger); }
.rice-guard { flex-basis: 100%; font-size: 11.5px; color: var(--muted); }
.rice-guard.tight { color: var(--warning); }
.rice-guard.over { color: var(--danger); }

/* ── 节 ───────────────────────────────────────────────── */
.rice-sec { margin-top: 26px; }
.rice-sec-h { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.rice-sec-h h3 { font-size: 16px; font-weight: 700; }
.rice-no {
  font-size: 11px; font-weight: 700; color: var(--card); background: var(--ink);
  width: 20px; height: 20px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center;
  flex: 0 0 auto; transform: translateY(1px);
}
.rice-hint { margin-left: auto; font-size: 11.5px; color: var(--muted); text-align: right; }
.rice-panel { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px 12px; }

/* ── 筛选 chips ───────────────────────────────────────── */
.rice-chips { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding-bottom: 12px; border-bottom: 1px solid var(--line-2); }
.rice-chips-label { font-size: 11.5px; color: var(--muted); margin-right: 2px; }
.rice-chip {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  font-family: inherit; font-size: 12px; font-weight: 600; color: var(--ink);
  background: var(--card); border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px 4px 8px;
  transition: .16s;
}
.rice-chip:hover { border-color: var(--line-2); }
.rice-chip[aria-pressed="false"] { opacity: .45; border-style: dashed; background: transparent; }
.rice-chip.on { border-color: var(--accent); color: var(--accent); background: var(--tint); }
.rice-chip-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line-2); display: block; flex: 0 0 auto; }
.rice-chip-dot.lv0 { background: var(--accent); }
.rice-chip-dot.lv1 { background: var(--warning); }
.rice-chip-dot.lv2 { background: var(--muted); }
.rice-chip-dot.lvx { background: transparent; border: 1.3px dashed var(--danger); }
.rice-chip-n { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.rice-grow { flex: 1; }
.rice-size-legend { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); }
.rice-size { border: 1.3px solid var(--line-2); border-radius: 50%; display: block; }

/* ── 散点 ─────────────────────────────────────────────── */
.rice-plotwrap { position: relative; padding-top: 6px; min-height: 460px; }
/* 筛选后没有气泡：图不能塌成一条线，明说原因 */
.rice-plot-empty { position: absolute; inset: 36px 12px 12px; display: flex; align-items: center; justify-content: center;
  font-size: 12.5px; color: var(--muted); text-align: center; background: var(--card); pointer-events: none; }
.rice-svg { width: 100%; height: auto; display: block; }
.rice-quad-fill { fill: var(--tint-3); }
.rice-quad-fill.q-do { fill: var(--tint); }
.rice-grid { stroke: var(--line-2); stroke-width: 1; opacity: .55; }
.rice-split { stroke: var(--accent); stroke-width: 1.1; stroke-dasharray: 5 4; opacity: .45; }
.rice-threshold { stroke: var(--accent); stroke-width: 1.2; stroke-dasharray: 2 4; opacity: .8; }
.rice-threshold-t { font-size: 10px; fill: var(--accent); }
.rice-axis-line { stroke: var(--border); stroke-width: 1.2; }
.rice-axis { font-size: 10px; fill: var(--muted); }
.rice-axis-title { font-size: 11.5px; fill: var(--muted); font-weight: 600; }
.rice-quad-label { font-size: 11.5px; font-weight: 700; letter-spacing: .04em; }
.rice-quad-label.q-do { fill: var(--accent); }
.rice-quad-label.q-plan { fill: var(--muted); }
.rice-quad-label.q-fill { fill: var(--muted); opacity: .8; }
.rice-quad-label.q-cut { fill: var(--muted); opacity: .8; }
.rice-pt { cursor: pointer; }
.rice-bubble { stroke-width: 1.4; fill-opacity: .14; transition: fill-opacity .16s, stroke-width .16s; }
.rice-bubble.lv0 { fill: var(--accent); stroke: var(--accent); }
.rice-bubble.lv1 { fill: var(--warning); stroke: var(--warning); }
.rice-bubble.lv2 { fill: var(--muted); stroke: var(--muted); }
.rice-bubble.lvx { fill: var(--card); stroke: var(--danger); stroke-dasharray: 4 3; fill-opacity: .5; }
.rice-pt:hover .rice-bubble, .rice-pt.on .rice-bubble { fill-opacity: .32; stroke-width: 2.2; }
.rice-bubble-n { font-size: 11px; font-weight: 700; pointer-events: none; }
.rice-bubble-n.lv0 { fill: var(--accent); }
.rice-bubble-n.lv1 { fill: var(--warning); }
.rice-bubble-n.lv2 { fill: var(--muted); }
.rice-bubble-n.lvx { fill: var(--danger); }

/* 悬停/点击明细。
   ⚠ 固定高度是**功能需求**，不是审美：这块在表格上方，内容一变高就会把整张表往下推，
   hover 行 → 面板变高 → 指针离开行 → 面板缩回 → 行又回来，形成持续抖动
   （2026-10-31 第 1 条，第一条最明显）。所以内容换、高度不动，溢出在框内滚动。 */
.rice-detail {
  margin-top: 8px; border: 1px solid var(--border); border-radius: 12px;
  background: var(--tint-3); padding: 10px 12px; font-size: 12px;
  height: 158px; box-sizing: border-box; overflow-y: auto;
}
.rice-detail-empty { color: var(--muted); font-size: 11.5px; }
.rice-detail-idle { height: 100%; display: flex; flex-direction: column; justify-content: center; gap: 10px; color: var(--muted); line-height: 1.7; }
.rice-detail-idle-h { font-size: 11.5px; }
.rice-detail-idle-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 18px; font-size: 11px; }
.rice-detail-idle-grid b { color: var(--ink); font-weight: 600; }
.rice-detail-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rice-detail-rank { font-size: 10.5px; font-weight: 700; color: var(--card); background: var(--ink); padding: 1px 6px; border-radius: 5px; }
.rice-detail-rank.lv0 { background: var(--accent); }
.rice-detail-title { font-weight: 700; }
.rice-detail-score { display: flex; align-items: baseline; gap: 8px; margin-top: 6px; }
.rice-detail-score span:first-child { font-size: 10.5px; color: var(--muted); letter-spacing: .04em; }
.rice-detail-score b { font-size: 19px; font-weight: 700; }
.rice-detail-formula { margin-left: auto; font-size: 11px; color: var(--muted); }
.rice-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 12px; margin-top: 6px; color: var(--muted); font-size: 11.5px; }
.rice-detail-grid b { color: var(--ink); font-weight: 600; }
.rice-detail-note { margin-top: 6px; color: var(--ink); font-size: 12px; line-height: 1.6; }
.rice-detail-hint { margin-top: 6px; font-size: 11px; color: var(--muted);
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.rice-kick { font-size: 11px; padding: 2px 8px; line-height: 1.6; }
.rice-mx-note { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line-2); font-size: 11.5px; color: var(--muted); line-height: 1.8; }
.rice-mx-note b { color: var(--ink); font-weight: 600; }

/* ── 表格 ─────────────────────────────────────────────── */
.rice-tablewrap { overflow: auto; min-height: 220px; }
.rice-table { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 1040px; table-layout: auto; }
.rice-table th { text-align: left; font-size: 10.5px; letter-spacing: .04em; color: var(--muted); font-weight: 600; padding: 0 6px 9px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.rice-table td { padding: 7px 6px; border-bottom: 1px solid var(--line-2); text-align: left; vertical-align: middle; }
.rice-table tbody tr { transition: background .14s; }
.rice-table tbody tr:hover { background: var(--tint-2); }
.rice-table tbody tr.on { background: var(--tint); }
.rice-table tbody tr.lv0 { background: var(--tint-2); }
.rice-table tbody tr.lv0:hover { background: var(--tint); }
.rice-th-rank { width: 34px; }
.rice-th-score { text-align: right; }
.rice-rank { font-weight: 700; color: var(--muted); font-variant-numeric: tabular-nums; width: 34px; }
.rice-table tbody tr.lv0 .rice-rank { color: var(--accent); }
.rice-name { min-width: 170px; max-width: 280px; }
.rice-title { font-weight: 600; font-size: 12.5px; line-height: 1.4; }
.rice-title-note { font-size: 11px; color: var(--muted); margin-top: 1px; line-height: 1.45; }
.rice-eid, .rice-origin { font-size: 10.5px; color: var(--muted); }
.rice-proj { font-size: 10.5px; color: var(--muted); white-space: nowrap; }
.rice-num { width: 48px; padding: 3px 4px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--ink); }
.rice-sel { padding: 3px 3px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--ink); max-width: 86px; }
.rice-score-cell { text-align: right; white-space: nowrap; }
.rice-score { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
.rice-bar { flex: 0 0 52px; height: 6px; border-radius: 3px; background: var(--line-2); overflow: hidden; }
.rice-bar i { display: block; height: 100%; border-radius: 3px; background: var(--muted); }
.rice-table tbody tr.lv0 .rice-bar i { background: var(--accent); }
.rice-table tbody tr.lv1 .rice-bar i { background: var(--warning); }
.rice-table tbody tr.lvx .rice-bar i { background: var(--danger); }
.rice-score-v { font-weight: 700; font-variant-numeric: tabular-nums; min-width: 44px; text-align: right; }
.rice-badge { display: inline-flex; align-items: center; font-size: 10.5px; font-weight: 700; padding: 2px 7px; border-radius: 5px; letter-spacing: .03em; white-space: nowrap; }
.rice-badge.lv0 { background: var(--accent); color: var(--card); }
.rice-badge.lv1 { background: var(--tint); color: var(--ink); }
.rice-badge.lv2 { background: var(--tint-3); color: var(--muted); border: 1px solid var(--border); }
.rice-badge.lvx { background: var(--card); color: var(--danger); border: 1px dashed var(--danger); }
.rice-verdict { white-space: nowrap; }
.rice-vd { font-weight: 600; margin-right: 6px; }
.rice-vd.cut { color: var(--danger); }
.rice-did { font-size: 10.5px; color: var(--muted); }
.rice-vbtn { padding: 2px 8px; font-size: 11px; margin-right: 4px; }
.rice-vbtn.cut { color: var(--danger); }
.rice-none { color: var(--muted); text-align: center !important; padding: 16px !important; }
.rice-tbl-foot { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line-2); display: flex; gap: 16px; flex-wrap: wrap; font-size: 11px; color: var(--muted); }

/* ── 为什么做，为什么砍 ───────────────────────────────── */
.rice-why { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); display: grid; grid-template-columns: 210px 1fr; gap: 24px; padding: 20px 22px; }
.rice-why-sig { border-right: 1px solid var(--line-2); padding-right: 20px; display: flex; flex-direction: column; }
.rice-why-role { font-size: 11px; font-weight: 700; letter-spacing: .08em; color: var(--accent); }
.rice-why-nm { font-size: 16px; font-weight: 700; margin-top: 4px; }
.rice-why-mt { font-size: 11.5px; color: var(--muted); margin-top: 8px; line-height: 1.75; }
.rice-why-stats { margin-top: 14px; display: flex; flex-direction: column; gap: 7px; }
.rice-why-stat { display: flex; justify-content: space-between; align-items: baseline; font-size: 11.5px; color: var(--muted); }
.rice-why-stat b { font-size: 13px; color: var(--ink); font-variant-numeric: tabular-nums; }
.rice-why-stat b.over { color: var(--warning); }
.rice-why-sig-note { margin-top: auto; padding-top: 14px; font-size: 10.5px; color: var(--muted); line-height: 1.75; }
.rice-why-body { min-width: 0; }
.rice-why-h { font-size: 14px; font-weight: 700; }
.rice-why-sub { margin-left: 8px; font-weight: 400; font-size: 11.5px; color: var(--muted); }
.rice-why-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 10px; }
.rice-why-t { font-size: 12px; font-weight: 600; color: var(--success); margin-bottom: 6px; }
.rice-why-t.cut { color: var(--danger); }
.rice-why-row { padding: 7px 0; border-top: 1px dashed var(--border); font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
.rice-why-row b { font-weight: 600; }
.rice-why-reason { color: var(--muted); line-height: 1.6; }
.rice-why-reason.missing { color: var(--warning); }
.rice-why-ev { color: var(--muted); font-size: 11px; }
.rice-why-act { margin-top: 4px; }
.rice-why-btn { font-size: 10.5px; padding: 1px 7px; line-height: 1.7; }
.rice-why-edit { display: flex; flex-direction: column; gap: 4px; }
.rice-why-edit textarea {
  width: 100%; box-sizing: border-box; min-height: 48px; resize: vertical;
  padding: 5px 8px; border: 1px solid var(--border); border-radius: 7px;
  font-family: inherit; font-size: 12px; line-height: 1.6; color: var(--ink); background: var(--card); outline: none;
}
.rice-why-edit-act { display: flex; gap: 6px; }
.rice-why-none, .rice-why-empty { font-size: 11.5px; color: var(--muted); }
.rice-why-empty { margin-top: 10px; }
.rice-why-foot { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line-2); font-size: 11.5px; color: var(--muted); }
.rice-verdicts { margin-top: 14px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.rice-vd-block { border-left: 3px solid var(--line-2); padding-left: 9px; }
.rice-vd-block.lv0 { border-color: var(--accent); }
.rice-vd-block.lv1 { border-color: var(--warning); }
.rice-vd-block.lvx { border-color: var(--danger); }
.rice-vd-label { font-size: 11px; color: var(--muted); }
.rice-vd-v { font-size: 12.5px; font-weight: 700; margin-top: 1px; }
.rice-vd-d { font-size: 10.5px; color: var(--muted); margin-top: 1px; }

/* ── 局限 / 页脚 ──────────────────────────────────────── */
.rice-limits { margin-top: 22px; padding: 12px 14px; border: 1px dashed var(--line-2); border-radius: 12px; background: var(--tint-3); }
.rice-limits-h { font-size: 12px; font-weight: 700; margin-bottom: 5px; }
.rice-limit { font-size: 11px; color: var(--muted); line-height: 1.65; }
.rice-foot { margin-top: 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 11px; color: var(--muted); }
.rice-formula { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--card); border: 1px solid var(--border); border-radius: 7px; padding: 3px 9px; }

.rice-err { margin-top: 14px; padding: 10px 12px; border: 1px solid var(--danger); border-radius: 10px; color: var(--danger); background: var(--card); }
.rice-empty { margin-top: 18px; padding: 18px 20px; border: 1px dashed var(--line-2); border-radius: var(--radius); background: var(--tint-3); }
.rice-empty-t { font-size: 14px; font-weight: 700; }
.rice-empty-sub { margin-top: 8px; font-size: 12px; color: var(--muted); line-height: 1.8; }
.rice-empty-sub b { color: var(--ink); font-weight: 600; }
.rice-empty-act { margin-top: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rice-empty-foot { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line-2); font-size: 11.5px; color: var(--muted); line-height: 1.7; }

@media (max-width: 900px) {
  .rice-kpis { grid-template-columns: repeat(2, 1fr); }
  .rice-why { grid-template-columns: 1fr; }
  .rice-why-sig { border-right: none; border-bottom: 1px solid var(--line-2); padding-right: 0; padding-bottom: 14px; }
  .rice-verdicts { grid-template-columns: repeat(2, 1fr); }
}
</style>
