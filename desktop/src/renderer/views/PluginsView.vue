<!--
  插件（2026-11-20 · 暮雨：“插件的分量已经很重了，我觉得完全可以从技能分立出去单干”）

  为什么单开一页：原来这两块都塞在“技能”页底部 —— 「DSH 插件」与「接入 MCP」。
  它们和技能（模块化提示词）根本不是一件事：
    · 技能 = 一段给 agent 的提示词，复制过去它就自己装；
    · 插件 / MCP = **一条常驻通道**（命名管道 / 配置文件条目），装错了是“连不上”，不是“回答不好”。
  混在一页的后果是：查“技能版本对不对”的人要穿过 7 行 agent 接入说明，
  查“方寸到底接没接上 DSH”的人也不知道该往哪看（暮雨的两次反馈都落在这儿）。

  ⚠ 边界（沿用原口径，一个字没松）：
    · **只读**：方寸不写 DSH 任何配置，也不猜别人的配置路径；
    · **只给材料**：MCP 配置段按本机路径生成后复制，粘贴保存是用户的手；
    · 唯一会写别人文件的是「接入到 Hermes」（hermesLink.ts，先备份 / 只加不删 / 写后自证）。
-->
<template>
  <main id="board" class="plugins-view">
    <!-- ── 页头 ───────────────────────────────────────────────────────── -->
    <header class="plg-head">
      <div class="plg-head-main">
        <h3>插件</h3>
        <p class="plg-head-sub">
          方寸自己的 DSH 插件，以及给别的 agent 用的 MCP 接入材料 —— 都是<strong>通道</strong>，不是技能。
          这一页只读、只给材料；方寸不写别人的配置文件（MCP 那一段里有唯一的例外，只在检测到对方时出现，且会先问你）。
        </p>
      </div>
      <div class="plg-head-acts">
        <Button variant="outline" size="tool" :disabled="busy" @click="reloadAll()">刷新</Button>
      </div>
    </header>

    <!-- ── 一眼看懂：三格事实（不猜、不凑） ────────────────────────────── -->
    <div class="plg-sum">
      <div class="plg-sum-cell">
        <span class="plg-sum-k">方寸本体</span>
        <span class="plg-sum-v">v{{ appVersion || '—' }}</span>
      </div>
      <div class="plg-sum-cell" :class="{ 'is-warn': !dshStatus || !dshStatus.dshVersion }">
        <span class="plg-sum-k">DSH 基座</span>
        <span class="plg-sum-v">{{ dshStatus ? (dshStatus.dshVersion ? 'v' + dshStatus.dshVersion : '读不到') : '—' }}</span>
      </div>
      <div class="plg-sum-cell" :class="{ 'is-warn': !dshPlugged }">
        <span class="plg-sum-k">DSH 插件</span>
        <span class="plg-sum-v">{{ dshPluginVersion || (dshStatus && dshStatus.installed ? '未装插件' : 'DSH 不在场') }}</span>
      </div>
      <div class="plg-sum-cell" :class="{ 'is-warn': dshStatus && !dshStatus.pipe.alive }">
        <span class="plg-sum-k">自带通道</span>
        <span class="plg-sum-v">{{ dshStatus ? (dshStatus.pipe.alive ? '通' : '不通') : '—' }}</span>
      </div>
      <div class="plg-sum-cell" :class="{ 'is-warn': dshDispatchBad }">
        <span class="plg-sum-k">派单最近一次</span>
        <span class="plg-sum-v">{{ dshDispatchText }}</span>
      </div>
      <div class="plg-sum-cell">
        <span class="plg-sum-k">MCP 已接入</span>
        <span class="plg-sum-v">{{ mcpLinkedCount }} / {{ mcpDetectedCount }}</span>
      </div>
    </div>

    <!-- ── ① 方寸插件（DSH）────────────────────────────────────────── -->
    <section class="plg-sec">
      <div class="plg-sec-h">
        <h4>方寸插件 · DSH</h4>
        <span class="plg-sec-sub">装没装 / 版本 / 自带通道通不通 / patch 里那条旧手工桥指向哪。只读，不改 DSH 任何配置。</span>
      </div>

      <div class="dsh-plugin plg-card">
        <div v-if="dshErr" class="skills-error">{{ dshErr }}</div>
        <div v-else-if="dshLoading && !dshStatus" class="plg-empty">读取中…</div>
        <div v-else-if="!dshStatus" class="plg-empty">读不到 DSH 状态 —— 不是“没装 DSH”</div>
        <template v-else>
          <div class="agent-row">
            <div class="agent-line1">
              <span class="agent-name">DSH 插件</span>
              <span class="agent-state">{{ dshStatus.installed ? '已装 DSH' : '没装 DSH' }}</span>
              <span v-for="p in dshStatus.plugins" :key="p.name" class="agent-link"
                    :class="'agent-link-' + (p.bundled ? 'linked' : 'none')"
                    :title="'装法：' + p.spec + (p.linkedDir ? '（' + p.linkedDir + '）' : '') + ' · profile：' + dshStatus.profile">
                {{ p.name }} {{ p.version || '(版本未知)' }}{{ p.bundled ? '' : '（未进 bundles）' }}
              </span>
            </div>
            <div class="agent-evidence">{{ dshStatus.summary }}</div>
            <div class="agent-howto">
              自带通道：{{ dshStatus.pipe.path }} ——
              <b>{{ dshStatus.pipe.alive ? '通' : '不通' }}</b>
              （插件自己直连，不用在 cordis.patch.yml 里写 command / args / env）
            </div>
            <div v-if="dshStatus.legacy" class="agent-howto">
              ⚠ patch 第 {{ dshStatus.legacy.line }} 行还有一条旧的手工桥：{{ dshStatus.legacy.plugin }}，
              command 指向 {{ dshStatus.legacy.command }} ——
              {{ dshStatus.legacy.commandExists ? '文件存在' : '文件不存在（这条其实连不上）' }}{{ dshStatus.legacy.isDevPath ? '，且是开发目录' : '' }}。
              插件已自带接入，这条可以删掉（方寸不代改 DSH 配置）。
            </div>
          </div>

          <!-- ── 三方版本 / 派单链路诊断（2026-11-21）──────────────────
               暮雨原话：“插件页就算写‘不通’，世界上也不会有任何人知道有什么问题。”
               所以这里不是再写一个“通/不通”，而是**逐环给结论 + 该升级哪一边**：
               方寸本体 / DSH 基座 / 插件 / 兼容声明 / 通道 / 签名密钥 / 派单审计。 -->
          <div class="plg-verdict" v-if="dshStatus.checks && dshStatus.checks.length" :class="'plg-v-' + dshWorst" data-dsh-verdict>
            <b>{{ dshWorstText }}</b>
            <span>{{ dshStatus.verdict }}</span>
          </div>
          <div class="plg-checks" v-if="dshStatus.checks && dshStatus.checks.length" data-dsh-checks>
            <div v-for="c in dshStatus.checks" :key="c.key" class="plg-check" :class="'plg-check-' + c.status">
              <span class="plg-check-badge">{{ checkBadge(c.status) }}</span>
              <span class="plg-check-label">{{ c.label }}</span>
              <span class="plg-check-detail">{{ c.detail }}</span>
              <span v-if="c.action" class="plg-check-action">→ {{ c.action }}</span>
            </div>
          </div>
          <div class="agent-howto" v-if="dshStatus.dispatch">
            派单审计：待消费 {{ dshStatus.dispatch.pending || 0 }} · 被拒 {{ dshStatus.dispatch.rejected || 0 }} ·
            {{ dshStatus.dispatch.dir }}
          </div>
        </template>
      </div>
    </section>

    <!-- ── ② 接入 MCP（给别的 agent）────────────────────────────────── -->
    <section class="plg-sec">
      <div class="plg-sec-h">
        <h4>接入 MCP（读写方寸任务数据）</h4>
        <span class="plg-sec-sub">
          按本机安装路径生成配置段；方寸只给材料 —— 粘贴保存由你完成。
          两枚徽章是两个问题：<b>已检测到</b> = 本机装了这个软件，<b>方寸已接入</b> = 它的配置文件里真有 fangcun 条目（只读探测，注释里写着的 fangcun 不算）。
        </span>
      </div>

      <div class="mcp-connect plg-card">
        <div class="mcp-entry-pick">
          <span class="mcp-entry-label">入口：</span>
          <Button v-for="e in mcpEntries" :key="e.id"
                  :variant="e.id === mcpEntry ? 'primary' : 'outline'" size="tool"
                  :disabled="!e.available" @click="mcpEntry = e.id"
                  :title="e.available ? e.usage : e.detail">
            {{ e.label }}{{ e.available ? '' : '（不可用）' }}
          </Button>
          <span v-if="mcpEntryDetail" class="mcp-entry-note">{{ mcpEntryDetail }}</span>
        </div>
        <div v-if="mcpInfoError" class="skills-error">{{ mcpInfoError }}</div>
        <div v-else-if="mcpLoading && !mcpTargets.length" class="plg-empty">检测中…</div>
        <div v-else-if="!mcpTargets.length" class="plg-empty">本机没检测到可接入的目标 —— 不是“还在检测”</div>
        <div v-for="m in mcpTargets" :key="m.id" class="agent-row" :class="{ 'agent-off': !m.detected }">
          <div class="agent-line1">
            <span class="agent-name">{{ m.name }}</span>
            <span class="agent-state">{{ m.detected ? '已检测到' : '没检测到' }}</span>
            <!-- “已检测到”= 这台机器装了这个软件；“方寸已接入”= 它的配置文件里真有 fangcun 条目。
                 落点不可知（WorkBuddy）时整枚徽章不渲染 —— 不猜、不写。 -->
            <span v-if="m.detected && m.linked !== undefined" class="agent-link"
                  :class="'agent-link-' + (m.linked ? 'linked' : 'none')" :title="m.linkedDetail || ''">
              {{ m.linked ? '方寸已接入' : '方寸未接入' }}
            </span>
            <!-- 2026-11-06 暮雨：“Hermes 要接，而且应该通过方寸去接。”
                 方寸**唯一**会写别人配置文件的按钮，目标写死为 Hermes；已接入时不渲染（幂等）。 -->
            <Button v-if="m.id === 'hermes' && m.detected && m.configPath && m.linked !== true"
                    variant="primary" size="tool" @click="linkHermesInto(m)"
                    title="把 fangcun 那条写进 Hermes 的 mcp_servers（先备份，只加不删，写后自证）">⚡ 接入到 Hermes</Button>
            <Button variant="primary" size="tool" @click="copyMcpSnippet(m)"
                    title="生成按本机安装路径的配置段并复制">📋 复制配置段</Button>
            <Button variant="outline" size="tool" @click="copyMcpSelfInstall(m)"
                    title="生成一段贴给它的自装指令（技能卡路径 + 配置段 + 自检步骤），由它自己动手 —— 耗它自己的 token，方寸零写入">🤖 让它自装</Button>
            <Button v-if="m.configPath" variant="outline" size="tool" @click="openMcpConfig(m)"
                    title="打开对方的配置文件，粘贴后保存">📂 打开配置文件</Button>
          </div>
          <div class="agent-evidence" :title="m.evidence">{{ m.evidence }}</div>
          <div class="agent-howto">{{ m.howTo }}</div>
        </div>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Button from '../components/ui/Button.vue'

/**
 * ⚠ 三个注入项都不是数据，而是“本页没有的能力”：
 *   toast  —— 提示条是全站状态；
 *   copy   —— 预留：以后要复制路径时走主进程剪贴板 + 统一 toast；
 *   appVersion —— 版本号真身在主进程（渲染层只显示，不自己编）。
 */
const props = defineProps<{
  toast: (msg: string, type?: 'success' | 'error' | 'info') => void
  appVersion?: string
}>()

// ── ① DSH 插件（2026-11-06 暮雨：“依然未体现 DSH 插件相关”）──────────────
// 事实：`dsh-fangcun` 是个真 npm 包，装进 DSH profile 的 bundles 就会加载，
// 它自己直连方寸的命名管道 —— 根本不需要在 cordis.patch.yml 里抄 command/args/env。
interface DshPluginRowUi {
  name: string; bundled: boolean; version: string; spec: string; linkedDir?: string; selfConnect: string
  compatDsh?: string; compatReleases?: Record<string, string>
}
interface DshCheckUi {
  key: string
  label: string
  status: 'ok' | 'warn' | 'bad' | 'unknown'
  detail: string
  action: string
}
interface DshDispatchUi {
  dir: string
  pending: number
  rejected: number
  secret: { present: boolean; path: string }
  last?: { at: string; ok: boolean; reason?: string; project?: string; kind?: string; sessionId?: string; error?: string }
  recent: { at: string; ok: boolean; reason?: string; project?: string; kind?: string; sessionId?: string; error?: string }[]
}
interface DshPluginUi {
  dshHome: string; installed: boolean; profile: string; profileDir: string
  dshVersion: string; dshVersionFrom: string
  plugins: DshPluginRowUi[]
  pipe: { path: string; alive: boolean }
  dispatch: DshDispatchUi
  checks: DshCheckUi[]
  verdict: string
  legacy?: { line: number; plugin: string; command: string; commandExists: boolean; isDevPath: boolean }
  summary: string
}
const dshStatus = ref<DshPluginUi | null>(null)
const dshLoading = ref(true)
const dshErr = ref('')

/** 插件真装进 bundles 的那个包（不是“本机能找到 dsh-fangcun 这个目录”就算装上） */
const dshPlugged = computed(() => !!(dshStatus.value && dshStatus.value.plugins.some((p) => p.bundled)))
const dshPluginVersion = computed(() => {
  const p = (dshStatus.value?.plugins || []).find((x) => x.bundled) || (dshStatus.value?.plugins || [])[0]
  if (!p) return ''
  return p.version ? 'v' + p.version : '版本未知'
})

/** 诊断清单里最严重的一档（页面顶部的结论色就用它，不另算一套口径） */
const dshWorst = computed<DshCheckUi['status']>(() => {
  const rank: Record<DshCheckUi['status'], number> = { ok: 0, unknown: 1, warn: 2, bad: 3 }
  const rows = dshStatus.value?.checks || []
  if (!rows.length) return 'unknown'
  return rows.reduce((acc, c) => (rank[c.status] > rank[acc] ? c.status : acc), 'ok' as DshCheckUi['status'])
})
const dshWorstText = computed(() => ({
  ok: '三方一致', warn: '能通，但有需要注意的', bad: '有明确不通的环节', unknown: '有一项读不到证据',
} as Record<DshCheckUi['status'], string>)[dshWorst.value])

/** 派单最近一次：失败就标警（这是“到底有没有开成会话”的唯一客观记录） */
const dshDispatchBad = computed(() => {
  const d = dshStatus.value?.dispatch
  if (!d) return false
  return (!!d.last && d.last.ok === false) || d.pending > 0
})
const dshDispatchText = computed(() => {
  const d = dshStatus.value?.dispatch
  if (!d) return '—'
  if (d.last && d.last.ok === false) return '被拒 · ' + String(d.last.reason || '未知')
  if (d.pending > 0) return `待消费 ${d.pending}`
  if (d.last) return '成功 · ' + String(d.last.at || '').slice(5, 16).replace('T', ' ')
  return '还没有'
})
function checkBadge(s: DshCheckUi['status']): string {
  return ({ ok: '✓', warn: '!', bad: '✗', unknown: '?' } as Record<DshCheckUi['status'], string>)[s]
}

async function loadDshPlugin(): Promise<void> {
  dshLoading.value = true
  dshErr.value = ''
  try {
    const t: any = window.tegula
    if (typeof t.mcpDshPlugin !== 'function') {
      dshStatus.value = null
      dshErr.value = '当前主进程没有“DSH 插件状态”这个通道（旧版本）—— 这一块读不到'
      return
    }
    const r: any = await t.mcpDshPlugin()
    if (r && r.ok) dshStatus.value = r as DshPluginUi
    else { dshStatus.value = null; dshErr.value = (r && r.message) || '读取 DSH 插件状态失败' }
  } catch (e: any) {
    dshStatus.value = null
    dshErr.value = '读取 DSH 插件状态失败：' + (e?.message || e)
  } finally {
    dshLoading.value = false
  }
}

// ── ② MCP 接入材料（2026-10-02 卡 002 · A 路线）─────────────────────────
// 方寸只出材料：配置段按本机安装路径动态生成 + 复制 + 打开目标文件。
// 不写任何外部应用的文件 —— 粘贴保存是用户的手。
interface McpEntryUi { id: string; label: string; available: boolean; detail: string; usage: string }
interface McpTargetUi {
  id: string; name: string; detected: boolean; evidence: string; configPath?: string; howTo: string
  /** 配置文件里有没有 fangcun 条目（undefined = 落点不可知，不渲染徽章） */
  linked?: boolean; linkedDetail?: string
}
const mcpEntries = ref<McpEntryUi[]>([])
const mcpTargets = ref<McpTargetUi[]>([])
const mcpEntry = ref<string>('A')
const mcpInfoError = ref('')
const mcpLoading = ref(true)

/** 概述条用：接入数 / 在场数（都不编，只数已经拿到的两个事实） */
const mcpDetectedCount = computed(() => mcpTargets.value.filter((x) => x.detected).length)
const mcpLinkedCount = computed(() => mcpTargets.value.filter((x) => x.detected && x.linked === true).length)

const mcpEntryDetail = computed(() => {
  const e = mcpEntries.value.find((x) => x.id === mcpEntry.value)
  if (!e) return ''
  return e.available ? e.usage : e.detail
})

async function loadMcpInfo(): Promise<void> {
  mcpLoading.value = true
  try {
    const t: any = window.tegula
    if (typeof t.mcpInfo !== 'function') {
      mcpEntries.value = []
      mcpTargets.value = []
      mcpInfoError.value = '当前主进程没有“MCP 接入信息”这个通道（旧版本）—— 这一块读不到'
      return
    }
    const r: any = await t.mcpInfo()
    if (r && r.ok) {
      mcpEntries.value = r.entries || []
      mcpTargets.value = r.targets || []
      // 默认选第一个可用入口（A 不可用时落到 B，别让用户对着死按钮点）
      const firstOk = (r.entries || []).find((e: any) => e.available)
      if (firstOk && !(r.entries || []).some((e: any) => e.id === mcpEntry.value && e.available)) {
        mcpEntry.value = firstOk.id
      }
      mcpInfoError.value = ''
    } else {
      mcpInfoError.value = (r && r.message) || '读取 MCP 接入信息失败'
    }
  } catch (e: any) {
    mcpInfoError.value = '读取 MCP 接入信息失败：' + (e?.message || e)
  } finally {
    mcpLoading.value = false
  }
}

async function copyMcpSnippet(m: McpTargetUi): Promise<void> {
  const t: any = window.tegula
  if (typeof t.mcpSnippet !== 'function') { props.toast('当前主进程是旧版本，没有这个通道', 'error'); return }
  const r: any = await t.mcpSnippet(m.id, mcpEntry.value)
  if (!r || !r.ok) { props.toast(`生成失败：${(r && r.message) || '未知原因'}`, 'error'); return }
  // 走主进程剪贴板（file:// 起源下 navigator.clipboard 会静默 reject）
  const c: any = await t.clipboardWriteText(r.snippet)
  if (c && c.ok !== false) props.toast(`已复制 ${m.name} 的配置段 —— 打开对方配置文件粘贴保存即可`, 'success')
  else props.toast(`复制失败：${(c && (c.error || c.message)) || '剪贴板不可用'}`, 'error')
}

/** 卡006（2026-10-03）：自装指令 —— A 路线第三渠道。复制一段贴给目标 agent 的完整指令，
 *  技能卡复制与配置写入全部由对方现地完成（耗它自己的 token，方寸仍零写入）。 */
async function copyMcpSelfInstall(m: McpTargetUi): Promise<void> {
  const t: any = window.tegula
  if (typeof t.mcpSelfInstall !== 'function') { props.toast('当前主进程是旧版本，没有这个通道', 'error'); return }
  const r: any = await t.mcpSelfInstall(m.id, mcpEntry.value)
  if (!r || !r.ok) { props.toast(`生成失败：${(r && r.message) || '未知原因'}`, 'error'); return }
  const c: any = await t.clipboardWriteText(r.prompt)
  if (c && c.ok !== false) props.toast(`已复制给 ${m.name} 的自装指令 —— 打开对方粘贴，让它自己装`, 'success')
  else props.toast(`复制失败：${(c && (c.error || c.message)) || '剪贴板不可用'}`, 'error')
}

/**
 * 接入 Hermes（2026-11-06 暮雨：“Hermes 要接，而且应该通过方寸去接”）。
 *
 * 与“复制配置段 / 让它自装”的区别：这一步**真的会改** Hermes 的 config.yaml。
 * 所以先确认（把路径、只加不删、先备份三件事说清），再调主进程；
 * 主进程侧另有四条纪律（备份 / 文本插入 / 原子写 / 写后自证），见 hermesLink.ts。
 */
async function linkHermesInto(m: McpTargetUi): Promise<void> {
  const t: any = window.tegula
  if (typeof t.mcpLinkHermes !== 'function') { props.toast('当前主进程是旧版本，没有这个通道', 'error'); return }
  const where = m.configPath || '（未检测到配置文件）'
  const yes = confirm(
    '这一步会修改 Hermes 的配置文件：\n' + where + '\n\n'
    + '只往 mcp_servers 下加一条 fangcun（缩进 2），其它内容一个字不动；\n'
    + '写之前先备份成同目录 config.yaml.bak-fangcun-<时间戳>，写完会把新增块抠掉与原文逐字节比对。\n\n'
    + '继续吗？'
  )
  if (!yes) { props.toast('已取消，Hermes 的配置文件没有改动', 'info'); return }
  const r: any = await t.mcpLinkHermes(mcpEntry.value)
  if (r && r.ok) props.toast(r.message || '已接入 Hermes', r.changed ? 'success' : 'info')
  else props.toast('接入失败：' + ((r && (r.message || r.error)) || '未知原因'), 'error')
  await loadMcpInfo()
}

async function openMcpConfig(m: McpTargetUi): Promise<void> {
  const t: any = window.tegula
  if (typeof t.mcpOpenConfig !== 'function') { props.toast('当前主进程是旧版本，没有这个通道', 'error'); return }
  const r: any = await t.mcpOpenConfig(m.id)
  if (r && r.ok) props.toast(r.message || `已打开 ${m.name} 的配置文件`, 'success')
  else props.toast(`打开失败：${(r && r.message) || '未知原因'}`, 'error')
}

const busy = computed(() => dshLoading.value || mcpLoading.value)

async function reloadAll(): Promise<void> {
  await Promise.all([loadDshPlugin(), loadMcpInfo()])
}

onMounted(() => {
  void loadDshPlugin()
  void loadMcpInfo()
})
</script>
