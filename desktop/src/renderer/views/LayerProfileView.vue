<template>
  <!-- 层厚度（2026-11-16 · 骨架继承试点第一批）
       暮雨原话：「横比表和单项目报告都要，因为用户根本没空去数目录半小时」。

       所以这一页的自证不是"表画出来了"，而是**三件原来做不到的事**：
         ① 一眼看出哪个项目在写业务、哪个在堆测试（横比）
         ② 每个项目点开就有「层 → 文件数 → 行数 → 占比」，不用自己去数
         ③ 分母被谁改过**摊开写**（排除了什么、哪些不是文本）——

       ⚠ 口径全部来自 `shared/layerProfile.ts`（纯函数，node 可直跑断言）；
         这一页只负责摆，不重算 —— 本仓规矩：算法不埋在组件里。 -->
  <div class="lp">
    <div class="lp-head">
      <span class="lp-title">层厚度</span>
      <span class="lp-sub">只读扫盘 · 只数文本行 · 不猜架构</span>
      <Button class="lp-refresh" variant="ghost" size="tool" :disabled="busy" @click="reload(true)">
        {{ busy ? '扫描中…' : '⟳ 重新扫' }}
      </Button>
      <span class="lp-at" v-if="readAt">{{ cached ? '今天读过' : '刚读' }}</span>
    </div>

    <div class="lp-note">
      行数是<b>体量</b>，不是质量、不是成熟度。这份表能指方向，不能判好坏。
    </div>

    <div class="lp-split">
      <!-- ── 左：横比（默认）── -->
      <div class="lp-tabs">
        <button class="lp-tab" :class="{ on: tab === 'board' }" @click="switchTab('board')">跨项目横比</button>
        <button class="lp-tab" :class="{ on: tab === 'one' }" @click="switchTab('one')">单项目报告</button>
      </div>

      <!-- ══ 横比 ══ -->
      <div v-if="tab === 'board'" class="lp-board">
        <div class="lp-anom" v-if="anomalies.length">
          <div class="lp-anom-h">能直接看的异常</div>
          <div class="lp-anom-row" v-for="(a, i) in anomalies" :key="i">
            <span class="lp-anom-k">{{ a.kind }}</span>
            <span class="lp-anom-t">{{ a.text }}</span>
          </div>
        </div>

        <table class="lp-table">
          <thead>
            <tr>
              <th>项目</th>
              <th class="num">产品</th>
              <th class="num">测试</th>
              <th class="num">工具</th>
              <th class="num">测试/产品</th>
              <th>最厚的层</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in boardRows" :key="r.id"
              :class="{ on: curId === r.id, miss: !!r.missing }"
              :title="r.missing || '点一下看这个项目的完整报告'"
              @click="pick(r.id)">
              <td class="nm">{{ r.name }}</td>
              <td class="num">{{ fmt(r.product) }}</td>
              <td class="num">{{ fmt(r.test) }}</td>
              <td class="num">{{ fmt(r.tool) }}</td>
              <td class="num" :class="{ warn: r.testRatio !== null && r.testRatio >= 1 }">
                {{ r.testRatio === null ? '—' : r.testRatio.toFixed(2) }}
              </td>
              <td class="layer"><code v-if="!r.missing">{{ r.topLayer }}</code><span v-else>读不到</span></td>
            </tr>
          </tbody>
        </table>
        <div class="lp-empty" v-if="!busy && !boardRows.length">还没有项目登记工作目录 —— 先到项目页里给项目填 repo。</div>
      </div>

      <!-- ══ 单项目 ══ -->
      <div v-else class="lp-one">
        <div class="lp-one-h">
          <select class="lp-sel" v-model="curId">
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
          </select>
          <span class="lp-spec" :class="{ bad: !!specError }">
            {{ specError ? 'spec 坏了：' + specError
               : profile && profile.specSource ? '分层口径来自：' + profile.specSource
               : '这个项目没写「声称的分层」—— 只能看目录占比' }}
          </span>
        </div>

        <div class="lp-miss" v-if="profile && profile.missing">{{ profile.missing }}</div>
        <template v-else-if="profile && profile.ok">
          <div class="lp-verdict">{{ profile.verdict }}</div>

          <!-- 大账（按项目自己声明的分法）-->
          <div class="lp-sec" v-if="profile.groups && profile.groups.length">
            <div class="lp-sec-h">大账<span class="lp-sec-s">按项目自己声明的分法</span></div>
            <table class="lp-table">
              <thead><tr><th>大块</th><th class="num">行数</th><th class="num">{{ denom.label === '全仓' ? '占全仓' : '占产品代码' }}</th><th>由哪几层合成</th></tr></thead>
              <tbody>
                <tr v-for="g in profile.groups" :key="g.name">
                  <td class="nm">{{ g.name }}</td>
                  <td class="num">{{ fmt(g.lines) }}</td>
                  <td class="num">{{ pctOf(g.lines, denom.base) }}</td>
                  <td class="layer">{{ g.members.join('、') }}</td>
                </tr>
              </tbody>
            </table>
            <!-- 换了分母必须大声说。静默换分母和静默改排除规则是同一种病：
                 2026-11-16 明鉴那份 spec 让"占比"算出 444.6%，根因就是
                 它的代码全在 scripts/ 而被判成"工具"，"产品代码"这个母只剩 1,346 行。 -->
            <div class="lp-hint warn" v-if="denom.note">{{ denom.note }}</div>
            <div class="lp-hint" v-else>
              分母是<b>产品代码 {{ fmt(denom.base) }} 行</b>，不是全仓 {{ fmt(profile.totalLines) }} 行 ——
              拿全仓当分母会把测试的行数算成「这层很厚」。<br>
              <template v-if="innerList.length">
                只算这几块内部的占比：<span v-for="(x, i) in innerList" :key="i">{{ i ? ' · ' : '' }}{{ x.name }} <b>{{ x.share.toFixed(1) }}%</b></span>
              </template>
            </div>
          </div>

          <!-- 对账：声称 vs 实测 -->
          <div class="lp-sec" v-if="profile.claimRows && profile.claimRows.length">
            <div class="lp-sec-h">与声称的数字逐条对账<span class="lp-sec-s">手工算的数没人能复算，当场对出来才叫数</span></div>
            <table class="lp-table">
              <thead><tr><th>层</th><th class="num">声称</th><th class="num">实测</th><th>差</th></tr></thead>
              <tbody>
                <tr v-for="c in profile.claimRows" :key="c.name">
                  <td class="nm">{{ c.name }}</td>
                  <td class="num">{{ fmt(c.claim) }}</td>
                  <td class="num">{{ c.got === null ? '不在 spec 里' : fmt(c.got) }}</td>
                  <td :class="{ warn: c.got !== null && c.got !== c.claim }">
                    {{ c.got === null ? '—' : c.got === c.claim ? '一致' : (c.got > c.claim ? '实测多 ' : '实测少 ') + fmt(Math.abs(c.got - c.claim)) }}
                  </td>
                </tr>
              </tbody>
            </table>
            <div class="lp-hint" v-if="profile.claimsNote">{{ profile.claimsNote }}</div>
          </div>

          <!-- 目录层 -->
          <div class="lp-sec">
            <div class="lp-sec-h">全部目录层<span class="lp-sec-s">按行数降序</span></div>
            <table class="lp-table">
              <thead><tr><th>层</th><th>角色</th><th class="num">文件数</th><th class="num">行数</th><th class="num">占比</th></tr></thead>
              <tbody>
                <tr v-for="r in (profile.rows || []).slice(0, 30)" :key="r.layer">
                  <td class="layer"><code>{{ r.layer }}</code></td>
                  <td>{{ r.role }}</td>
                  <td class="num">{{ fmt(r.files) }}</td>
                  <td class="num">{{ fmt(r.lines) }}</td>
                  <td class="num">{{ pctOf(r.lines, profile.totalLines) }}</td>
                </tr>
              </tbody>
            </table>
            <div class="lp-hint" v-if="(profile.rows || []).length > 30">
              另有 {{ profile.rows.length - 30 }} 层未列出 —— 折叠不等于没有。
            </div>
          </div>

          <!-- 分母被谁改过：这一节存在的理由见 shared/layerProfile.ts 顶部五个坑 -->
          <div class="lp-sec" v-if="(profile.skipped || []).length || (profile.nonText || []).length">
            <div class="lp-sec-h">被规则挡在外面的东西
              <span class="lp-sec-s">排除规则会改变分母，所以必须点名</span>
            </div>
            <div class="lp-skip" v-for="(s, i) in (profile.skipped || []).slice(0, 20)" :key="'s' + i">
              <code>{{ s.dir }}</code><span class="lp-why">{{ s.why }}</span>
            </div>
            <div class="lp-skip" v-for="(n, i) in (profile.nonText || []).slice(0, 10)" :key="'n' + i">
              <code>{{ n.file }}</code><span class="lp-why">{{ n.why }}（未计入）</span>
            </div>
            <div class="lp-hint">
              `.ts` 既是 TypeScript 也是视频分片；GBK 脚本是文本不是二进制 ——
              这两条都踩过，所以判据只用「NUL 字节 + 控制字符比例」，不看扩展名、不只认 UTF-8。
            </div>
          </div>
        </template>
        <div class="lp-empty" v-else-if="!busy">选一个项目看它的层厚度。</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 层厚度页（2026-11-16）
 *
 * 边界（写死防膨胀）：
 *  ① **只读**：只调 `layer:*` 三条 IPC，一条都不写项目仓库。
 *  ② **不重算**：占比、结论、对账全部来自主进程（`shared/layerProfile.ts` 是唯一真源）。
 *     这里再算一遍就等于出现第二个口径 —— 本仓栽过（同一份数据两处口径，一份说 71 一份说 130）。
 *  ③ **缺值不编**：读不到仓库就显示 `missing` 那句话，**不显示 0**（0 会被读成"真没代码"）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import Button from '../components/ui/Button.vue'
import {
  boardAnomalies, denominatorOf, fmt, innerShares, pct, toBoardRow,
  type BoardRow, type LayerProfile,
} from '../../shared/layerProfile'

const props = defineProps<{ ctl: any }>()
const ctl = props.ctl

const tab = ref<'board' | 'one'>('board')
const busy = ref(false)
const cached = ref(false)
const readAt = ref('')
const profiles = ref<LayerProfile[]>([])
const curId = ref('')
const profile = ref<LayerProfile | null>(null)
const specError = ref('')

const projects = computed<any[]>(() => (ctl.projects || []).filter((p: any) => p && p.id))
const boardRows = computed<BoardRow[]>(() => profiles.value.map(toBoardRow))
const anomalies = computed(() => boardAnomalies(boardRows.value))
// 分母由 shared/layerProfile.ts 统一选（占比不许超 100%）。这里只摆不重算。
const denom = computed(() =>
  profile.value
    ? denominatorOf(profile.value.rows || [], profile.value.named || [], profile.value.groups || [])
    : { base: 0, label: '产品代码', note: '' })
const innerList = computed(() => innerShares(profile.value?.groups || []))

function pctOf(part: number, whole: number): string {
  return whole ? pct(part, whole) : '—'
}

async function reload(force = false): Promise<void> {
  const api = (window as any).tegula
  if (!api || typeof api.layerBoard !== 'function') return
  busy.value = true
  try {
    // force 走"重新扫"按钮：绕过主进程的按天缓存
    const list = await api.layerBoard({ force })
    profiles.value = Array.isArray(list) ? list : []
    cached.value = !force
    readAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    if (curId.value) await loadOne(curId.value)
    else if (profiles.value.length) curId.value = profiles.value[0].id
  } catch {
    profiles.value = []
  } finally {
    busy.value = false
  }
}

async function loadOne(id: string): Promise<void> {
  const api = (window as any).tegula
  if (!id || !api) return
  try {
    // 横比已经扫过一遍（且主进程按天缓存），这里取同一份，不会重复付扫盘的钱
    const hit = profiles.value.find((p) => p.id === id)
    profile.value = hit || (typeof api.layerProfile === 'function' ? await api.layerProfile(id) : null)
    specError.value = ''
    if (typeof api.layerSpec === 'function') {
      const s = await api.layerSpec(id)
      if (s && s.error) specError.value = s.error
    }
  } catch {
    profile.value = null
  }
}

/**
 * 点横比表的一行 → 看这个项目的详细报告。
 *
 * ⚠ 顺序要紧（2026-11-16 渲染层 e2e 当场抓到"点了行没反应"）：
 * 先切页签、再设 curId。反过来的话同一个 tick 里 `watch(curId)` 会先发一次加载，
 * 而那时 `tab` 还不是 'one' —— 单项目那块 `v-else` 分支根本没渲染，
 * 界面上看就是点了没用。
 */
function pick(id: string): void {
  tab.value = 'one'
  if (id === curId.value) void loadOne(id)
  else curId.value = id          // 交给 watch 加载，只发一次
}

/** 子页签手动切换时，也要保证当前项目有数据（横比加载完之前点"单项目"会是空的）。 */
function switchTab(t: 'board' | 'one'): void {
  tab.value = t
  if (t === 'one' && curId.value && !profile.value) void loadOne(curId.value)
}

watch(curId, (id) => { if (id) void loadOne(id) })

onMounted(() => { void reload(false) })
</script>

<style scoped>
.lp { padding: 12px 16px 24px; }
.lp-head { display: flex; align-items: center; gap: 10px; }
.lp-title { font-weight: 700; font-size: 15px; }
.lp-sub { color: var(--muted); font-size: 12px; }
.lp-at { color: var(--muted); font-size: 12px; margin-left: auto; }
.lp-refresh { margin-left: 8px; }
.lp-note {
  margin: 8px 0 12px; padding: 6px 10px; border-radius: 6px;
  background: var(--card); border: 1px solid var(--border);
  color: var(--muted); font-size: 12px;
}
.lp-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
.lp-tab {
  padding: 4px 12px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--border); background: transparent; color: var(--ink); font-size: 13px;
}
.lp-tab.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.lp-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.lp-table th, .lp-table td { padding: 4px 8px; border-bottom: 1px solid var(--border); text-align: left; }
.lp-table th { color: var(--muted); font-weight: 600; font-size: 12px; }
.lp-table td.num, .lp-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
.lp-table tr.on { background: var(--card); }
.lp-table tr.miss td { color: var(--muted); }
.lp-table td.warn { color: var(--warning); font-weight: 700; }
.lp-table td.layer code { font-size: 12px; color: var(--muted); }
.lp-board tbody tr { cursor: pointer; }
.lp-board tbody tr:hover { background: var(--card); }
.lp-anom {
  margin-bottom: 12px; padding: 8px 12px; border-radius: 6px;
  border: 1px solid var(--warning); background: var(--card);
}
.lp-anom-h { font-weight: 700; font-size: 13px; margin-bottom: 6px; color: var(--warning); }
.lp-anom-row { font-size: 12px; margin: 3px 0; }
.lp-anom-k {
  display: inline-block; min-width: 90px; color: var(--warning); font-weight: 700;
}
.lp-one-h { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.lp-sel {
  padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--card); color: var(--ink); font-size: 13px;
}
.lp-spec { color: var(--muted); font-size: 12px; }
.lp-spec.bad { color: var(--danger); }
.lp-miss {
  padding: 10px 12px; border-radius: 6px; border: 1px solid var(--danger);
  color: var(--danger); font-size: 13px;
}
.lp-verdict {
  padding: 10px 12px; border-radius: 6px; border: 1px solid var(--accent);
  background: var(--card); font-size: 13px; line-height: 1.6; margin-bottom: 12px;
}
.lp-sec { margin-bottom: 16px; }
.lp-sec-h { font-weight: 700; font-size: 13px; margin-bottom: 6px; }
.lp-sec-s { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 8px; }
.lp-hint { color: var(--muted); font-size: 12px; margin-top: 6px; line-height: 1.6; }
.lp-skip { font-size: 12px; margin: 2px 0; }
.lp-skip code { color: var(--muted); }
.lp-why { color: var(--muted); margin-left: 8px; }
.lp-empty { color: var(--muted); font-size: 13px; padding: 16px 0; }
</style>
