<!--
  「对不上」—— 项目页第 6 种摆法（2026-10-27，REV-008 一期 R4）

  为什么单独一个组件：口径全在 shared/mismatch.ts（e2e-mismatch 32 条跑纯 Node 验过），
  这里只负责把三类清单摆出来，不参与判断。

  三条口径必须出现在界面上（少一条就会被误读）：
   ① 它只是**对不上**，不是"做错了"；② **不阻挡任何操作**，不改任何卡；
   ③ 取不到 git 的项目要单独列出 —— 那些是"没法判"，不是"没问题"。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

defineProps<{ toast?: (m: string) => void }>()

const loading = ref(false)
const err = ref('')
const data = ref<any>(null)

async function load() {
  loading.value = true
  err.value = ''
  try {
    const r: any = await (window as any).tegula.checkMismatch(3)
    if (r && r.ok === false) {
      err.value = String(r.error || '检测失败')
      data.value = null
    } else {
      data.value = r
    }
  } catch (e: any) {
    err.value = String(e?.message || e || '检测失败')
    data.value = null
  } finally {
    loading.value = false
  }
}
onMounted(load)

const groups = computed(() => {
  const d = data.value
  if (!d) return []
  return [
    { key: 'stale', ttl: '状态过期', hint: 'registry 写的日期之后，仓库还在动', rows: d.stale || [] },
    { key: 'noDate', ttl: '状态没写日期', hint: '不算过期，但也不是"已核对"', rows: d.noDate || [] },
    { key: 'broken', ttl: '引用断裂', hint: '卡里写的路径，磁盘上已经没有了', rows: d.moved ? d.broken || [] : [] },
    { key: 'moved', ttl: '指向已归档的卡', hint: '东西搬了，引用没回改', rows: d.moved || [] },
    { key: 'nocriteria', ttl: '完成但没判据', hint: '状态是完成，正文找不到验收标准', rows: d.nocriteria || [] },
    // 2026-10-29 暮雨第 4 条 A 项：③ 问"写没写判据"，这一组问"东西在不在"。
    // RICE 那张卡 ③ 放过它（写了「验收通过」），产品里却根本没有入口 —— 判据是自述，产出才是事实。
    // ⚠ 门槛 7 天：刚关的卡不质疑；文案必须带「只是提示」（很多卡本来就没有文件产出）。
    {
      key: 'nooutput', ttl: '完成但找不到产出',
      hint: '已完成 7 天以上，卡里没有任何可核实的东西（存在的路径 / 提交号 / 链接）—— 只是提示，不是判决',
      rows: d.nooutput || [],
    },
  ]
})

const sub = computed(() => {
  const d = data.value
  if (!d) return ''
  return `${d.total || 0} 条 · 扫了 ${d.scanned?.projects ?? 0} 个项目 / ${d.scanned?.tasks ?? 0} 张卡`
})

function rowText(kind: string, r: any): { left: string; right: string } {
  if (kind === 'stale') return { left: r.project, right: `${r.why}｜最后提交 ${r.lastCommit}（差 ${r.deltaDays} 天）` }
  if (kind === 'noDate') return { left: r.project, right: `${r.why}｜最后提交 ${r.lastCommit}` }
  if (kind === 'broken') return { left: r.task, right: `${r.ref}  [找过: ${(r.searched || []).join('/')}]` }
  if (kind === 'moved') return { left: r.task, right: `${r.ref}  ${r.why}` }
  if (kind === 'nooutput') {
    const age = r.ageDays === null || r.ageDays === undefined ? '完成时间未知' : `完成 ${r.ageDays} 天`
    return { left: r.title || r.task, right: `${age}｜${r.why}` }
  }
  return { left: r.task, right: r.title }
}
</script>

<template>
  <div class="mm">
    <div class="mm-head">
      <span class="mm-ttl">对不上</span>
      <span class="mm-sub">{{ sub }}</span>
      <span class="mm-grow"></span>
      <button class="ghost" :disabled="loading" @click="load">
        {{ loading ? '⟳ 读取中…' : '↻ 刷新' }}</button>
    </div>

    <div class="mm-note">
      这三类是<b>对不上</b>，不是"做错了"；<b>不阻挡任何操作</b>，也不改任何卡。
    </div>

    <div v-if="err" class="mm-err">{{ err }}</div>
    <div v-else-if="loading && !data" class="mm-empty">读取中…</div>

    <template v-else>
      <div class="mm-group" v-for="g in groups" :key="g.key">
        <div class="mm-ghead">
          <span class="mm-gttl">{{ g.ttl }}</span>
          <span class="mm-gcnt">{{ g.rows.length }}</span>
          <span class="mm-ghint">{{ g.hint }}</span>
        </div>
        <div v-if="!g.rows.length" class="mm-none">（没有）</div>
        <div v-else class="mm-row" v-for="(r, i) in g.rows" :key="g.key + i">
          <span class="mm-l">{{ rowText(g.key, r).left }}</span>
          <span class="mm-r">{{ rowText(g.key, r).right }}</span>
        </div>
      </div>

      <div class="mm-group" v-if="data && data.noGit && data.noGit.length">
        <div class="mm-ghead">
          <span class="mm-gttl">没法判</span>
          <span class="mm-gcnt">{{ data.noGit.length }}</span>
          <span class="mm-ghint">取不到 git 提交，不算"没问题"</span>
        </div>
        <div class="mm-row" v-for="(n, i) in data.noGit" :key="'ng' + i">
          <span class="mm-l">{{ n }}</span>
          <span class="mm-r">不是 git 仓库，或读取失败</span>
        </div>
      </div>

      <div class="mm-foot">
        局限：引用断裂只认反引号里的<b>相对路径</b>（带行号/通配/省略号的写法直接跳过，不可判）；
        「完成」判定只看状态字段，不看正文说没说做完了。
      </div>
    </template>
  </div>
</template>
