<template>
  <!-- 竞品档案（2026-11-17）
       暮雨：「这玩意在客户端里有自己的界面吗？如果根本没有前端界面用户根本不知道有这个功能」

       他说得对：竞品能力 10-17 拍板、11-07 做完数据层 + CLI，
       但桌面端**一个界面都没有**（实测 desktop/src 下 0 个文件提到 competitor）——
       于是没人知道 → 没人登记 → 永远没数据。这一页把入口接上。

       骨架**照抄** `LayerProfileView`（同一个 lp- 家族、同一套令牌），不自己发明版式 ——
       暮雨反复说过「做出来又是丑的要死」，所以能复用的一律复用。

       ⚠ 口径全在 `main/services/competitors.ts`；这一页只负责摆，不重算。 -->
  <div class="cp">
    <div class="cp-head">
      <span class="cp-title">竞品</span>
      <span class="cp-sub">按项目登记 · 方寸只出采集单，采集由 agent 做</span>
      <Button class="cp-refresh" variant="ghost" size="tool" :disabled="busy" @click="reload">
        {{ busy ? '读…' : '⟳ 重新读' }}
      </Button>
    </div>

    <div class="cp-note">
      方寸<b>不联网、不自建爬虫</b>：这里只登记「看谁、看它的什么」，
      点「生成采集任务单」交给 agent 去采，采完把 md 放回目录，这里就会出现。
    </div>

    <div class="cp-err" v-if="error">{{ error }}</div>
    <!-- 成功也要出声（2026-11-17 暮雨：「点生成采集任务单一点反应都没有」）——
         只报失败不报成功时，「做成了」与「点了没生效」在屏幕上完全一样。 -->
    <div class="cp-ok" v-if="msg">{{ msg }}</div>

    <!-- 汇总一行：登记了几个 / 有几个已有采集结果 -->
    <div class="cp-stat" v-if="ok">
      登记了 <b>{{ rows.length }}</b> 个项目共
      <b>{{ competitorCount }}</b> 个竞品；
      其中 <b>{{ withReports }}</b> 个已有采集结果。
      <span v-if="!rows.length" class="cp-zero">
        还没有登记任何竞品 —— 用 <code>tegula competitor add</code> 登记一条，
        或者告诉我竞品名，我来登记。
      </span>
    </div>

    <!-- 空态：说清下一步点哪，不只写"暂无数据" -->
    <div class="cp-empty" v-if="ok && !rows.length && !busy">
      <div class="cp-empty-h">这个功能现在还是空的</div>
      <div class="cp-empty-p">
        竞品要按项目登记进 <code>registry.yaml</code>。登记之后这一页才会长出内容：
        竞品列表 → 生成采集任务单 → 等 agent 回填 → 结果显示在下面。
      </div>
    </div>

    <!-- 逐项目一条 -->
    <div class="cp-row" v-for="r in rows" :key="r.projectId">
      <div class="cp-row-h">
        <span class="cp-proj">{{ r.projectName }}</span>
        <span class="cp-badge" :class="{ on: r.reports.length }">
          {{ r.reports.length ? `已采 ${r.reports.length} 份` : '还没采过' }}
        </span>
        <span class="cp-badge task" v-if="r.taskFile">任务单已生成</span>
        <Button class="cp-act" variant="ghost" size="tool"
          :disabled="writing === r.projectId"
          :title="'生成一份采集任务单，交给 agent 去采'"
          @click="writeTask(r)">
          {{ writing === r.projectId ? '生成中…' : '📋 生成采集任务单' }}
        </Button>
      </div>

      <!-- 竞品清单：一行一个，不折成卡片（卡片会把 5 个竞品撑成三屏） -->
      <table class="cp-table">
        <thead>
          <tr><th>竞品</th><th>地址</th><th>关注什么</th></tr>
        </thead>
        <tbody>
          <tr v-for="(c, i) in r.competitors" :key="i">
            <td class="cp-nm">{{ c.name }}</td>
            <td class="cp-url">
              <a v-if="c.url" :href="c.url" :title="c.url" @click.prevent="openUrl(c.url)">{{ c.url }}</a>
              <span v-else class="cp-miss">没填地址</span>
            </td>
            <td class="cp-focus">{{ c.focus || '—' }}</td>
          </tr>
        </tbody>
      </table>

      <!-- 采集结果：有就列出来，点开看原文 -->
      <div class="cp-reports" v-if="r.reports.length">
        <span class="cp-reports-h">采集结果：</span>
        <button v-for="f in r.reports" :key="f" class="cp-rep" @click="openReport(r, f)">{{ f }}</button>
      </div>
      <div class="cp-reports-none" v-else>
        还没有采集结果 —— 点上面「生成采集任务单」，交给 agent 采完放回
        <code>task-data/competitors/{{ r.projectId }}/</code>。
      </div>
    </div>

    <!-- 采集结果预览（浮层）：只显示原文，不解读 -->
    <div class="cp-modal-mask" v-if="preview" @mousedown.self="preview = null">
      <div class="cp-modal">
        <div class="cp-modal-h">
          <span>{{ preview.name }}</span>
          <Button variant="ghost" size="tool" @click="preview = null">关闭</Button>
        </div>
        <pre class="cp-modal-body">{{ preview.text }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 纯展示组件：数据全从主进程来（`competitorOverview` / `competitorReadReport`）。
 * 这一页**不重算任何口径** —— 与 `LayerProfileView` 同一条规矩。
 */
import { ref, computed, onMounted } from 'vue'
import Button from '../components/ui/Button.vue'

const busy = ref(false)
const ok = ref(false)
const error = ref('')
const msg = ref('')
const rows = ref<any[]>([])
const dir = ref('')
const writing = ref('')
const preview = ref<{ name: string; text: string } | null>(null)

const competitorCount = computed(() =>
  rows.value.reduce((s: number, r: any) => s + (r.competitors?.length || 0), 0))
const withReports = computed(() => rows.value.filter((r: any) => (r.reports?.length || 0) > 0).length)

async function reload(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const api: any = (window as any).tegula
    if (!api?.competitorOverview) {
      error.value = '这台机器上的方寸没有这条通道（需要完全退出再打开，让后台一起更新）'
      ok.value = false
      return
    }
    const r = await api.competitorOverview()
    if (!r || r.ok === false) {
      error.value = '读竞品档案失败：' + ((r && r.error) || '未知原因')
      ok.value = false
      return
    }
    ok.value = true
    rows.value = r.rows || []
    dir.value = r.dir || ''
  } catch (e: any) {
    error.value = '读取异常：' + (e?.message || e)
    ok.value = false
  } finally {
    busy.value = false
  }
}

async function writeTask(r: any): Promise<void> {
  writing.value = r.projectId
  error.value = ''
  msg.value = ''
  try {
    const api: any = (window as any).tegula
    const res = await api.competitorWriteTask(r.projectId)
    if (!res || res.ok === false) {
      error.value = '生成任务单失败：' + ((res && res.error) || '未知原因')
      return
    }
    // 成败以"重新读一遍看到 taskFile"为准，不做乐观更新
    await reload()
    // ⚠ 2026-11-17 暮雨：「点生成采集任务单一 **一点反应都没有**，我也不知道到底有没有点到。
    //   我除了狂点几十下还能怎么办？」
    //   原实现成功后**一声不响**：按钮从"生成中…"变回来，页面上什么都没变（任务单在磁盘上、
    //   不在这一页的视觉里），于是"点成功了"和"点了没生效"长得一模一样。
    //   所以成功必须说清三件事：生成了、落在哪、下一步交给谁。
    const p = String(res.path || '')
    msg.value = p
      ? `任务单已生成：${p} —— 把它发给 agent 去采，采完放回同目录这里就会列出来`
      : '任务单已生成（主进程没返回路径）'
  } catch (e: any) {
    error.value = '生成异常：' + (e?.message || e)
  } finally {
    writing.value = ''
  }
}

async function openReport(r: any, fileName: string): Promise<void> {
  try {
    const api: any = (window as any).tegula
    const res = await api.competitorReadReport(r.projectId, fileName)
    if (!res || res.ok === false) {
      error.value = '读采集结果失败：' + ((res && res.error) || '未知原因')
      return
    }
    preview.value = { name: `${r.projectName} · ${fileName}`, text: String(res.text || '') }
  } catch (e: any) {
    error.value = '读取异常：' + (e?.message || e)
  }
}

/**
 * 点竞品地址：交给系统默认浏览器打开。
 *
 * ⚠ 2026-11-17：这里原本写的是 `tegula.openExternal(url)` —— **那条通道 preload 根本没暴露**，
 *   于是这个链接点了完全没反应（`check-ipc-parity` 的僵尸按钮断言当场抓出来）。
 *   正确的通道是 `openFile`（主进程 `validateAndOpenFile`）：它自己解析相对路径、
 *   拒绝直接运行可执行文件（10-30 白屏那条教训），失败还会把原因回给界面。
 *   所以这里必须走 `openFile`，并且**把失败说出来** —— 不许静默吞掉。
 */
async function openUrl(u: string): Promise<void> {
  const url = String(u || '').trim()
  if (!url) return
  try {
    const r: any = await (window as any).tegula?.openFile?.(url)
    if (r && r.ok === false) {
      error.value = `打不开这个地址：${r.error || '系统拒绝了'}${r.hint ? '（' + r.hint + '）' : ''}`
    }
  } catch (e: any) {
    error.value = '打不开这个地址：' + (e?.message || e)
  }
}

onMounted(reload)
</script>

<style scoped>
/* 全部沿用 LayerProfileView 的令牌与尺度（fonts 12/13、radius 6、--border/--card/--muted），
   不引入新的颜色或尺寸 —— 这是"别再做出一个丑的"最省力的办法。 */
.cp { padding: 12px 16px 24px; max-width: 1080px; }
.cp-head { display: flex; align-items: center; gap: 10px; }
.cp-title { font-weight: 700; font-size: 15px; }
.cp-sub { color: var(--muted); font-size: 12px; }
.cp-refresh { margin-left: auto; }

.cp-note {
  margin: 8px 0 12px; padding: 6px 10px; border-radius: 6px;
  background: var(--card); border: 1px solid var(--border);
  color: var(--muted); font-size: 12px;
}
.cp-err {
  margin: 8px 0 12px; padding: 8px 10px; border-radius: 6px;
  border: 1px solid var(--danger); color: var(--danger);
  background: var(--card); font-size: 12px;
}
/* 成功提示与失败提示同一套尺寸，只有颜色令牌不同 —— 不新造版式（暮雨反复说过“做出来又是丑的”）。
   ⚠ 令牌是 `--success` 不是 `--ok`：写成 `var(--ok, var(--border))` 时它**不报错**，
     只会静静退成边框色 —— 屏幕上"成功"和"普通说明"长得一样，等于没做（本仓栽过的同类）。 */
.cp-ok {
  margin: 8px 0 12px; padding: 8px 10px; border-radius: 6px;
  border: 1px solid var(--success); color: var(--success);
  background: var(--card); font-size: 12px;
}
.cp-stat { font-size: 13px; margin-bottom: 10px; }
.cp-stat b { font-variant-numeric: tabular-nums; }
.cp-zero { color: var(--muted); font-size: 12px; margin-left: 6px; }

.cp-empty {
  padding: 14px 16px; border-radius: 8px;
  border: 1px dashed var(--border); background: var(--card);
}
.cp-empty-h { font-weight: 700; font-size: 13px; margin-bottom: 6px; }
.cp-empty-p { color: var(--muted); font-size: 12px; line-height: 1.7; }

.cp-row {
  margin-bottom: 14px; padding: 10px 12px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--card);
}
.cp-row-h { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cp-proj { font-weight: 700; font-size: 13.5px; }
.cp-badge {
  font-size: 11px; padding: 1px 7px; border-radius: 5px;
  background: var(--tint); color: var(--muted);
}
.cp-badge.on { color: var(--accent); font-weight: 600; }
.cp-badge.task { color: var(--muted); }
.cp-act { margin-left: auto; }

.cp-table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
.cp-table th, .cp-table td {
  padding: 5px 10px; border-bottom: 1px solid var(--border);
  text-align: left; vertical-align: top;
}
.cp-table th { color: var(--muted); font-weight: 600; font-size: 12px; }
/* 三列定宽：竞品名窄、地址中、关注什么吃掉剩余 —— 避免"关注什么"那列空一大片 */
.cp-table th:nth-child(1), .cp-table td:nth-child(1) { width: 22%; }
.cp-table th:nth-child(2), .cp-table td:nth-child(2) { width: 33%; }
.cp-table th:nth-child(3), .cp-table td:nth-child(3) { width: 45%; }
.cp-nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-url { min-width: 0; }
.cp-url a {
  color: var(--accent); text-decoration: none;
  display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cp-url a:hover { text-decoration: underline; }
.cp-miss { color: var(--warning); }
.cp-focus { color: var(--muted); font-size: 12.5px; line-height: 1.6; }

.cp-reports { margin-top: 8px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cp-reports-h { font-size: 12px; color: var(--muted); }
.cp-rep {
  font-size: 12px; padding: 2px 8px; border-radius: 5px; cursor: pointer;
  border: 1px solid var(--border); background: transparent; color: var(--ink);
  max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cp-rep:hover { background: var(--tint); }
.cp-reports-none { margin-top: 8px; font-size: 12px; color: var(--muted); }

.cp-modal-mask {
  position: fixed; inset: 0; z-index: 80;
  background: rgba(0, 0, 0, 0.32);
  display: flex; align-items: center; justify-content: center;
}
.cp-modal {
  width: min(820px, 90vw); max-height: 78vh; display: flex; flex-direction: column;
  background: var(--card); border: 1px solid var(--border); border-radius: 10px;
}
.cp-modal-h {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-bottom: 1px solid var(--border);
  font-weight: 700; font-size: 13.5px;
}
.cp-modal-h span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-modal-body {
  margin: 0; padding: 14px 16px; overflow: auto;
  font-size: 12.5px; line-height: 1.75; white-space: pre-wrap; word-break: break-word;
  color: var(--ink);
}
</style>
