<template>
  <main id="board" class="memory-view">
    <div class="mem-wrap">
      <div class="mem-head">
        <div class="mem-lead">记忆：发生过什么、哪条纪律是拿损失换来的</div>
        <div class="mem-lead-sub">
          这里存长期教训与纪律。原文逐字保存，不做摘要 —— 细节就是价值本体。
          它不回答「这次该干什么」，那是任务卡的事。
        </div>
      </div>

      <!-- 检索行 -->
      <div class="mem-search">
        <input class="mem-q" v-model="q" placeholder="搜一句话或一个词（事故 / 契约 / kill …）"
          @keydown.enter="load()" @input="onType()" />
        <select class="mem-sel" v-model="typeFilter" @change="load()">
          <option value="">全部类型</option>
          <option v-for="t in types" :key="t" :value="t">{{ t }}</option>
        </select>
        <label class="mem-chk" title="撤销不等于删除；勾上才看得到">
          <input type="checkbox" v-model="includeRevoked" @change="load()" /> 含已撤销
        </label>
        <Button size="tool" variant="ghost" :disabled="busy" @click="load()">{{ busy ? '查…' : '查询' }}</Button>
        <Button size="tool" variant="ghost" :disabled="busy" @click="rebuild()" title="索引是派生数据；源文件改了之后重算">重建索引</Button>
        <!-- 2026-11-18 暮雨：“记忆页必须开放写，不然出问题用户想改都改不了。”
             原来这一页只读、写只能靠 agent 落盘 —— 于是记错一条就没人能改。
             按钮放进检索行右端（与"查询/重建"同一组），不另起一行。 -->
        <Button size="tool" variant="primary" @click="openNew()">＋ 记一条</Button>
      </div>

      <!-- 概览 -->
      <div class="mem-stat" v-if="overview">
        <span>共 <b>{{ overview.total }}</b> 条</span>
        <span class="mem-sep">·</span>
        <span>有效 <b>{{ overview.effective }}</b></span>
        <span v-if="overview.revoked"> <span class="mem-sep">·</span> 已撤销 <b>{{ overview.revoked }}</b></span>
        <span class="mem-sep">·</span>
        <span class="mem-types">
          <span v-for="(n, t) in overview.byType" :key="t" class="mem-tag">{{ t }} {{ n }}</span>
        </span>
      </div>

      <!-- 空态：必须分清"还没录"与"筛出来没有" -->
      <div class="mem-empty" v-if="!rows.length && !busy">
        <template v-if="overview && overview.total === 0">
          记忆库还没有任何条目 —— 这不是“筛出来没有”，是还没录过。
          原文逐字录入，不做摘要。
          <div class="mem-empty-act">
            <Button size="tool" variant="primary" @click="openNew()">＋ 记下第一条</Button>
          </div>
        </template>
        <template v-else>
          筛出来 0 条（库中共 {{ overview ? overview.total : '?' }} 条）。放宽条件试试清空关键词或勾上「含已撤销」。
        </template>
      </div>

      <!-- 结果 -->
      <div class="mem-item" v-for="r in rows" :key="r.file">
        <div class="mem-i-h">
          <span class="mem-badge" :class="'is-' + badgeKey(r.type)">{{ r.type || '—' }}</span>
          <span class="mem-title">{{ r.title || r.file }}</span>
          <span class="mem-impact" v-if="r.impact" :class="'imp-' + impactKey(r.impact)">{{ r.impact }}</span>
        </div>
        <div class="mem-i-sub">
          <span v-if="r.time" class="mem-when">{{ fmtTime(r.time) }}</span>
          <span v-if="r.project" class="mem-proj" :title="'项目'">{{ r.project }}</span>
          <span v-for="tg in r.tags" :key="tg" class="mem-chip">{{ tg }}</span>
          <span v-if="r.status === '已撤销'" class="mem-revoked">已撤销</span>
        </div>
        <div class="mem-sum" v-if="r.summary">{{ r.summary }}</div>
        <div class="mem-i-acts">
          <Button size="sm" variant="ghost" @click="open(r.file)" title="看逐字原文">{{ opened === r.file ? '收起' : '看原文' }}</Button>
          <!-- 2026-11-18：改与撤销都在这儿 ——「撤销≠删除」（文件不动，只改状态），
               所以文案用"撤销/恢复"而不是"删除"。 -->
          <Button size="sm" variant="ghost" @click="openEdit(r)" title="改这一条的原文 / 类型 / 来源">✏ 编辑</Button>
          <Button v-if="r.status !== '已撤销'" size="sm" variant="ghost" @click="setStatus(r, '已撤销')"
            title="标记为已撤销：文件不删，只是不再算数（撤销后可恢复）">∅ 撤销这条</Button>
          <Button v-else size="sm" variant="ghost" @click="setStatus(r, '有效')"
            title="恢复成有效（撤销≠删除，所以能恢复）">↺ 恢复有效</Button>
          <span class="mem-file">{{ r.file }}</span>
        </div>
        <pre class="mem-body" v-if="opened === r.file">{{ body }}</pre>
      </div>
    </div>

    <!-- 新建 / 编辑（2026-11-18）——
         ⚠ 必填四项：类型 / 标题 / 原文 / 来源。少一项就当场拒绝并说清缺哪个。
         「原文逐字保存、不摘要」是本功能的立身之本，所以正文框是**大头**、且不给"摘要"这种捷径。 -->
    <div v-if="editing" class="mem-edit-mask" @mousedown.self="cancelEdit">
      <div class="mem-edit">
        <h3>{{ formFile ? '改这一条记忆' : '记一条记忆' }}</h3>
        <div class="mem-edit-hint">
          原文逐字保存，不做摘要 —— 细节就是价值本体。这里不是待办也不是日志：
          它回答「发生过什么、哪条纪律是拿损失换来的」。
        </div>
        <div class="mem-edit-row">
          <label><span class="mem-lb">类型<b>*</b></span>
            <select v-model="form.type" class="mem-sel">
              <option v-for="t in types" :key="'mt-' + t" :value="t">{{ t }}</option>
            </select>
          </label>
          <label><span class="mem-lb">影响</span>
            <select v-model="form.impact" class="mem-sel">
              <option value="">（不填）</option>
              <option v-for="v in ['严重', '高', '中', '低']" :key="'mi-' + v" :value="v">{{ v }}</option>
            </select>
          </label>
          <label><span class="mem-lb">项目</span>
            <input v-model="form.project" class="mem-inp" placeholder="例：fangcun-base（不填＝通用）" />
          </label>
        </div>
        <label class="mem-edit-wide"><span class="mem-lb">标题<b>*</b></span>
          <input v-model="form.title" class="mem-inp" placeholder="一句话：这条记忆讲的是什么" />
        </label>
        <label class="mem-edit-wide"><span class="mem-lb">来源<b>*</b></span>
          <input v-model="form.source" class="mem-inp" placeholder="谁说的 / 哪次事故 / 哪个文件 —— 说不清来源的记忆没人敢信" />
        </label>
        <label class="mem-edit-wide"><span class="mem-lb">原文<b>*</b></span>
          <textarea v-model="form.body" class="mem-ta" rows="10"
            placeholder="逐字写下来。不要总结、不要压缩 —— 以后要靠这段细节判断它还算不算数。"></textarea>
        </label>
        <div v-if="editErr" class="mem-edit-err">{{ editErr }}</div>
        <div class="mem-edit-acts">
          <Button variant="ghost" size="tool" @click="cancelEdit">取消</Button>
          <Button variant="primary" size="tool" :disabled="editBusy" @click="saveEdit">
            {{ editBusy ? '存…' : (formFile ? '保存修改' : '存下这一条') }}
          </Button>
        </div>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import Button from '../components/ui/Button.vue'

/**
 * 记忆页（2026-11-17 建；2026-11-18 开放写）
 *
 * 暮雨：「界面和 MCP 工具必做」「**记忆页必须开放写**，不然出问题用户想改都改不了」。
 *
 * ## 写什么、不写什么
 * 开放写 ≠ 允许"随手记一句摘要"。写入**必填四项**（类型/标题/原文/来源），
 * 少一项当场拒绝并说清缺哪个 —— 因为这条功能存在的理由就是"细节即价值"，
 * 一条只有标题的记忆等于没有，而一条没说来源的记忆下次没人敢信。
 *
 * ## 撤销 ≠ 删除
 * 改状态只动 frontmatter 的 `状态`，**文件不动**。记忆的价值在于"它曾经发生过"，
 * 删掉就是篡改历史 —— 所以界面上给的是「撤销这条 / 恢复有效」，没有"删除"。
 *
 * ## 两条口径（都栽过）
 * ① 「筛出来 0 条」≠「库里一条都没有」—— 两种空态分开说；
 * ② class 名一处新起（`.mem-*`），不套 `.idea-*` —— 套旧类会让既有断言凭空变红。
 */
const rows = ref<any[]>([])
const overview = ref<any>(null)
const q = ref('')
const typeFilter = ref('')
const includeRevoked = ref(false)
const busy = ref(false)
const opened = ref('')
const body = ref('')
const types = ref<string[]>(['事故', '教训', '纪律', '决定', '偏好'])

// ── 写入态（2026-11-18）────────────────────────────────────────────────
const editing = ref(false)
const editBusy = ref(false)
const editErr = ref('')
/** 正在改的那条；空 = 新建 */
const formFile = ref('')
const form = ref({ type: '教训', title: '', body: '', source: '', project: '', impact: '' })

function openNew(): void {
  formFile.value = ''
  form.value = { type: types.value[0] || '教训', title: '', body: '', source: '', project: '', impact: '' }
  editErr.value = ''
  editing.value = true
}

async function openEdit(r: any): Promise<void> {
  // 改之前先把原文取回来 —— 界面上看到的是摘要，改的必须是**原文整段**
  try {
    const res: any = await (window as any).tegula.memoryRead(r.file)
    if (!res?.ok) { editErr.value = '读不到原文：' + (res?.error || '未知原因'); return }
    const text = String(res.text || '')
    // 剥掉 frontmatter 与一级标题，剩下的就是原文正文（不猜、不重排）
    const m = [...text.matchAll(/^---\s*$/gm)]
    const afterFm = m.length >= 2 ? text.slice(m[1].index! + m[1][0].length) : text
    const lines = afterFm.split(/\r?\n/)
    const hAt = lines.findIndex((l) => l.trim().startsWith('#'))
    const bodyOnly = (hAt >= 0 ? lines.slice(hAt + 1) : lines).join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '')
    formFile.value = r.file
    form.value = {
      type: r.type || types.value[0] || '教训',
      title: r.title || '',
      body: bodyOnly,
      source: r.source || '',
      // ⚠ 用摘要行里的值会丢东西，所以项目/影响取列表行给的那两个（检索结果里就带着）
      project: r.project || '',
      impact: r.impact || '',
    }
    editErr.value = ''
    editing.value = true
  } catch (e: any) {
    editErr.value = '读不到原文：' + (e?.message || e)
  }
}

function cancelEdit(): void {
  editing.value = false
  editErr.value = ''
  formFile.value = ''
}

async function saveEdit(): Promise<void> {
  const f = form.value
  // 前端先自查一遍：这四条是硬门槛，让用户少等一个来回（主进程仍会再查一次）
  const missing: string[] = []
  if (!String(f.type).trim()) missing.push('类型')
  if (!String(f.title).trim()) missing.push('标题')
  if (!String(f.body).trim()) missing.push('原文')
  if (!String(f.source).trim()) missing.push('来源')
  if (missing.length) {
    editErr.value = `还差：${missing.join(' / ')} —— 这四项缺一个都不算记下`
    return
  }
  editBusy.value = true
  editErr.value = ''
  try {
    const api: any = (window as any).tegula
    const r: any = formFile.value
      ? await api.memoryUpdate(formFile.value, { ...f })
      : await api.memoryCreate({ ...f })
    if (!r?.ok) { editErr.value = '没存进去：' + (r?.error || '未知原因'); return }
    editing.value = false
    formFile.value = ''
    await load()
  } catch (e: any) {
    editErr.value = '保存失败：' + (e?.message || e)
  } finally {
    editBusy.value = false
  }
}

/** 撤销 / 恢复：只改状态，文件不动（撤销≠删除，所以能恢复） */
async function setStatus(r: any, status: string): Promise<void> {
  try {
    const res: any = await (window as any).tegula.memorySetStatus(r.file, status)
    if (!res?.ok) { alert('没改成：' + (res?.error || '未知原因')); return }
    await load()
  } catch (e: any) {
    alert('改状态失败：' + (e?.message || e))
  }
}

let timer: any = null
function onType() {
  // 输入防抖：每敲一个字就查一次会把主进程刷成串行 IO
  clearTimeout(timer)
  timer = setTimeout(() => { load() }, 250)
}

async function load() {
  busy.value = true
  try {
    const r: any = await (window as any).tegula.memorySearch({
      q: q.value.trim() || undefined,
      type: typeFilter.value || undefined,
      includeRevoked: includeRevoked.value,
    })
    rows.value = r?.rows || []
    overview.value = r?.overview || null
    if (!types.value.length && overview.value?.byType) types.value = Object.keys(overview.value.byType)
  } catch (e: any) {
    // 查不到要说人话，不许静默留白
    rows.value = []
    overview.value = null
    alert('查询失败：' + (e?.message || e))
  } finally {
    busy.value = false
  }
}

async function open(file: string) {
  if (opened.value === file) { opened.value = ''; return }
  try {
    const r: any = await (window as any).tegula.memoryRead(file)
    if (!r?.ok) { alert('读不到：' + (r?.error || '未知原因')); return }
    opened.value = file
    body.value = String(r.text || '')
  } catch (e: any) {
    alert('读取失败：' + (e?.message || e))
  }
}

async function rebuild() {
  busy.value = true
  try {
    const r: any = await (window as any).tegula.memoryRebuild()
    if (r && r.count >= 0) await load()
  } catch (e: any) {
    alert('重建失败：' + (e?.message || e))
  } finally { busy.value = false }
}

function fmtTime(t: string) {
  // 只显示到分钟；认不出就原样给，**不糊「刚刚」**
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return String(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function badgeKey(t: string) {
  return t === '事故' ? 'incident' : t === '纪律' ? 'rule' : t === '教训' ? 'lesson' : 'other'
}
function impactKey(v: string) {
  return v === '严重' ? 'critical' : v === '高' ? 'high' : v === '中' ? 'mid' : 'low'
}

onMounted(load)
</script>
