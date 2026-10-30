<!--
  数据整理面板（2026-10-30）—— App.vue 拆分的第一刀（卡 task-20261018-002）

  为什么先切这一块：它是本轮新加的「整理体检 + 大附件」两块设置，**边界干净**
  （只读主进程两条通道 + 两个跳转事件），不依赖 App 内部状态，切出去风险最低。
  先把"怎么切"跑通一遍（props/emit/样式迁移/回归全绿），后面几刀照这个模式走。

  判据（与卡一致）：
    · 组件自己不持有"视图状态"（看板筛选、返工台展开由 App 收事件后决定）；
    · 删/改这类破坏性动作只有主进程一条通道，组件只负责确认与刷新；
    · 数字旁边永远带着口径（清理候选 ≠ 优先级；大附件只列不删）。
-->
<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{ toast?: (m: string) => void }>()
const emit = defineEmits<{
  (e: 'goto-never-read'): void
  (e: 'goto-rework'): void
}>()

/** toast 由 App 传入（同一套提示条），组件不自己造一套 UI 反馈 */
const toast = (m: string) => { if (props.toast) props.toast(m) }

// ── 整理体检 ────────────────────────────────────────────────────────────
const cleanupBusy = ref(false)
const cleanup = ref<any>(null)

async function runCleanup(): Promise<void> {
  cleanupBusy.value = true
  try {
    const r: any = await (window as any).tegula?.cleanupScan?.(30)
    if (!r || r.ok === false) { toast(String(r?.error || '体检失败')); return }
    cleanup.value = r
  } catch (e: any) {
    toast('体检失败：' + (e?.message || e))
  } finally {
    cleanupBusy.value = false
  }
}

// ── 大附件（卡 task-20261018-004）──────────────────────────────────────
// 只列不删；删一个要二次确认，主进程还会再校验路径是否真在附件目录内。
const BIG_ATT_MIN_MB = 10
const bigAttBusy = ref(false)
const bigAtt = ref<any>(null)

async function scanBigAttachments(): Promise<void> {
  bigAttBusy.value = true
  try {
    const r: any = await (window as any).tegula?.backupBigAttachments?.(BIG_ATT_MIN_MB)
    if (!r || r.ok === false) { toast(String(r?.error || '扫描失败')); return }
    bigAtt.value = r.report
  } catch (e: any) {
    toast('扫描失败：' + (e?.message || e))
  } finally {
    bigAttBusy.value = false
  }
}

async function deleteBigAttachment(row: any): Promise<void> {
  const mb = Number(row?.mb || 0)
  if (!confirm(`删除这个附件？\n\n${row?.rel}\n${mb} MB\n\n· 只删这一个文件，不进回收站\n· 引用它的执行日志会变成"附件缺失"`)) return
  try {
    const r: any = await (window as any).tegula?.backupDeleteAttachment?.(String(row?.rel || ''))
    if (!r || r.ok === false) { toast(String(r?.error || '删除失败')); return }
    toast(`已删除，释放 ${r.freedMb || mb} MB`)
    await scanBigAttachments()
  } catch (e: any) {
    toast('删除失败：' + (e?.message || e))
  }
}

async function openAttachmentsDir(): Promise<void> {
  const r: any = await (window as any).tegula?.backupOpenAttachments?.()
  if (!r || r.ok === false) toast(String(r?.error || '打不开附件目录'))
}
</script>

<template>
  <div class="hygiene">
    <div class="sect">
      <h4>整理体检</h4>
      <div class="hint">两批卡一起看：近 30 天没有 agent 读过的，和被驳回后没人再管的。只提示该核一下"还要不要"，不自动删、不自动改。</div>
      <div class="sect-btns">
        <button class="ghost font-[inherit]" :disabled="cleanupBusy" @click="runCleanup">
          {{ cleanupBusy ? '⟳ 正在扫…' : '跑一次整理体检' }}</button>
      </div>
      <div v-if="cleanup" class="cleanup">
        <div class="cleanup-row">
          <b>{{ cleanup.neverRead.count }}</b> 张没人碰过
          <span class="cleanup-sub">（近 {{ cleanup.days }} 天 0 引用）</span>
          <span v-if="!cleanup.neverRead.windowEvents" class="cleanup-warn">计量还没开始，这个数不算数</span>
          <span class="cleanup-grow"></span>
          <button class="ghost font-[inherit]" :disabled="!cleanup.neverRead.count" @click="emit('goto-never-read')">回看板筛出来</button>
        </div>
        <div class="cleanup-list" v-if="cleanup.neverRead.rows && cleanup.neverRead.rows.length">
          <div class="cleanup-item" v-for="r in cleanup.neverRead.rows.slice(0, 5)" :key="'nr-' + r.id">{{ r.title || r.id }}</div>
        </div>
        <div class="cleanup-row">
          <b>{{ cleanup.rework.count }}</b> 张被驳回后没人管
          <span class="cleanup-sub">（{{ cleanup.rework.text }}）</span>
          <span class="cleanup-grow"></span>
          <button class="ghost font-[inherit]" :disabled="!cleanup.rework.count" @click="emit('goto-rework')">看返工台</button>
        </div>
        <div class="cleanup-list" v-if="cleanup.rework.rows && cleanup.rework.rows.length">
          <div class="cleanup-item" v-for="r in cleanup.rework.rows" :key="'rw-' + r.id">
            {{ r.title }}<span class="cleanup-reason">{{ r.hasReason ? r.reason : '驳回时没写理由' }}</span>
          </div>
        </div>
        <div class="cleanup-rule">{{ cleanup.rule }}</div>
      </div>
    </div>

    <div class="sect">
      <h4>大附件（{{ BIG_ATT_MIN_MB }}MB 以上）</h4>
      <div class="hint">执行日志的附件都存在数据目录里并进备份。这里只列不删 —— 删之前会二次确认，且只允许删附件目录内的单个文件。</div>
      <div class="sect-btns">
        <button class="ghost font-[inherit]" :disabled="bigAttBusy" @click="scanBigAttachments">
          {{ bigAttBusy ? '⟳ 正在扫…' : '扫描大附件' }}</button>
        <button class="ghost font-[inherit]" @click="openAttachmentsDir">打开附件目录</button>
      </div>
      <div v-if="bigAtt" class="bigatt">
        <div class="bigatt-head" v-if="bigAtt.rows && bigAtt.rows.length">
          共 <b>{{ bigAtt.rows.length }}</b> 个文件 · {{ bigAtt.totalMb }} MB
          <span class="bigatt-sub">（扫了 {{ bigAtt.scannedFiles }} 个附件文件，合计 {{ bigAtt.scannedMb }} MB）</span>
        </div>
        <div class="bigatt-head" v-else>
          没有超过 {{ bigAtt.minMb }}MB 的附件
          <span class="bigatt-sub">（已扫 {{ bigAtt.scannedFiles }} 个文件 / {{ bigAtt.scannedMb }} MB）</span>
        </div>
        <div class="bigatt-row" v-for="r in (bigAtt.rows || [])" :key="r.rel">
          <span class="bigatt-mb">{{ r.mb }} MB</span>
          <span class="bigatt-rel" :title="r.rel">{{ r.rel }}</span>
          <button class="ghost font-[inherit]" @click="deleteBigAttachment(r)">删除</button>
        </div>
        <div class="bigatt-foot">删除是不可撤销的（不进回收站）；只删这一个文件，日志卡上的引用会显示为缺失。</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 整理体检：两个数字各一行 + 前几条样例 + 口径一行 */
.cleanup { margin-top: 10px; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--tint-3); }
.cleanup-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
.cleanup-row + .cleanup-row { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line-2); }
.cleanup-row b { color: var(--accent); font-size: 15px; }
.cleanup-sub { font-size: 11.5px; color: var(--muted); }
.cleanup-warn { font-size: 11px; color: var(--warning); }
.cleanup-grow { flex: 1; }
.cleanup-list { margin-top: 4px; display: flex; flex-direction: column; gap: 2px; }
.cleanup-item { font-size: 11.5px; color: var(--ink); line-height: 1.6; }
.cleanup-reason { margin-left: 8px; color: var(--muted); }
.cleanup-rule { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line-2); font-size: 11px; color: var(--muted); line-height: 1.7; }

/* 大附件清单 */
.bigatt { margin-top: 10px; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--tint-3); }
.bigatt-head { font-size: 12.5px; }
.bigatt-head b { color: var(--accent); }
.bigatt-sub { font-size: 11px; color: var(--muted); margin-left: 6px; }
.bigatt-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-top: 1px dashed var(--line-2); }
.bigatt-mb { font-size: 12px; font-weight: 700; color: var(--danger); flex: 0 0 72px; }
.bigatt-rel { flex: 1; min-width: 0; font-size: 11px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bigatt-row .ghost { font-size: 11.5px; padding: 2px 9px; }
.bigatt-foot { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line-2); font-size: 11px; color: var(--muted); }
</style>
