<!--
  技能（2026-11-20 重排 · 暮雨：“技能页签该大改了，过时内容一堆……又丑又乱，需要美化”）

  ## 这一页现在只回答三件事
    ① 方寸自带哪几个技能、各自什么状态（装没装 / 是不是旧版）；
    ② 想装到哪去（本机检测到的 agent 可直装，其余给文件由它自己装）；
    ③ 上次自动同步到底跑没跑、是不是已经过期。
  「DSH 插件」与「接入 MCP」**已搬到独立的「插件」页**（views/PluginsView.vue）——
  它们是常驻通道，不是提示词，混在这里会让两件事都读不清（也是这一页“又丑又乱”的主因）。

  ⚠ 四个注入项都不是数据，而是“本页没有的能力”：
    toast        —— 提示条是全站状态，不归这一页；
    copy         —— 复制要走主进程剪贴板 + 统一 toast（copyWithToast），19 处共用；
    pulse        —— 拖拽心跳（全局拖拽遮罩靠它兜底，见 App.vue“心跳兜底”那段）；
    dragAlive    —— 同上：拖拽是不是真的还在进行，遮罩必须跟它一起消失。
  最后两项必须由父组件给：心跳状态是 todo/log/skills 三个投放区**共用**的。
-->
<template>
    <main id="board" class="skills-view"
          @dragover.prevent="onSkillsDragOver" @dragleave="onSkillsDragLeave" @drop.prevent="onSkillsDrop">
      <div v-if="skillsDropMaskVisible" class="skills-dropmask">
        <div class="skills-dropmask-inner">
          <div class="skills-dropmask-icon">📥</div>
          <div>松手即导入 —— 支持文件夹、.zip（内含 SKILL.md）或 .md（带 YAML 的 name + description）</div>
        </div>
      </div>

      <!-- ── 页头：一句话说清“这是什么”，动作分主次两行 ─────────────────── -->
      <header class="sk-head">
        <div class="sk-head-main">
          <h3>技能</h3>
          <p class="sk-head-sub">
            技能本质只是<strong>模块化提示词</strong>，不是插件 —— 复制提示词贴给 agent，它自己装，省得手抄出错。
            要装的是<strong>常驻通道</strong>（DSH 插件 / MCP），请前往「插件」页。
          </p>
        </div>
        <div class="sk-head-acts">
          <Button variant="primary" size="tool" @click="importSkillViaPicker('file')" title="选一个 .zip 或 .md 技能包导入">📥 导入技能…</Button>
          <Button variant="outline" size="tool" @click="importSkillViaPicker('folder')" title="选一个技能文件夹（内有 SKILL.md）导入">📁 导入文件夹…</Button>
          <Button variant="outline" size="tool" @click="installAllDetected()"
            title="把随包分发的技能复制到本机检测到的 agent（DSH / Hermes）并逐个复核">⚡ 装到本机 agent</Button>
          <Button variant="outline" size="tool" @click="openSkillsDir('resources')" title="打开随包分发的技能目录">📂 技能目录</Button>
          <Button variant="outline" size="tool" @click="loadSkills()">刷新</Button>
        </div>
      </header>

      <!-- ── 概览条：三个数先说结论，再往下看细节 ───────────────────────── -->
      <div class="sk-sum">
        <div class="sk-sum-cell">
          <span class="sk-sum-k">自带技能</span>
          <span class="sk-sum-v">{{ skillsList.length }} 个</span>
        </div>
        <div class="sk-sum-cell">
          <span class="sk-sum-k">清单版本</span>
          <span class="sk-sum-v">{{ skillsManifestVersion || '—' }}</span>
        </div>
        <div v-for="t in targetSummary" :key="t.id" class="sk-sum-cell"
             :class="{ 'is-warn': t.present && t.ok < t.total, 'is-off': !t.present }">
          <span class="sk-sum-k">{{ t.name }}</span>
          <span class="sk-sum-v">{{ t.present ? `${t.ok} / ${t.total} 最新` : '不在场' }}</span>
        </div>
      </div>

      <!-- ── 自动同步的实况（2026-11-05 暮雨：“更新后无法自动更新技能吗？”）──
           此前这一页只有一句静态承诺“升级后启动会自动同步”，但**没有任何地方能看到它到底跑没跑**。
           方寸常驻托盘，升级后旧进程不退，新实例被顶掉 → 那句承诺实际上没执行，
           而界面上与成功时长得一模一样。现在把上次同步的时间/版本/结果摊在这儿，
           版本对不上就直接标红并给“现在同步”。 -->
      <div class="skills-sync" :class="{ stale: syncWarn }" data-skills-sync>
        <span class="ss-ico">{{ syncWarn ? '⚠' : (skillsSync && skillsSync.ok ? '✓' : '·') }}</span>
        <span class="ss-text">
          <template v-if="syncWarn">
            <b>技能可能不是最新</b> —— {{ syncWarnReason }}
          </template>
          <template v-else-if="skillsSync">
            自动同步 ✓ {{ syncTimeText(skillsSync.at) }} · v{{ skillsSync.appVersion }} ·
            清单 {{ skillsSync.skills.length }} 个（{{ skillsSync.skills.join(' / ') }}）·
            {{ skillsSync.targets.map(syncTargetText).join(' · ') }}
          </template>
          <template v-else>还没有同步记录 —— 点右边同步一次</template>
        </span>
        <Button variant="outline" size="tool" :disabled="skillsSyncBusy" @click="verifySkillsNow()"
          title="重新读盘、重算真源与副本的 md5，把两边指纹摆出来 —— 不是只看“上次同步成功”那句话">
          🧪 核验
        </Button>
        <Button variant="outline" size="tool" :disabled="skillsSyncBusy" @click="syncSkillsNow()"
          title="不用重启、不用退托盘：现在就比对一遍并装掉差异（装完会再读盘复核）">
          {{ skillsSyncBusy ? '同步中…' : '现在同步' }}
        </Button>
      </div>

      <!-- 逐文件凭据（2026-11-21 暮雨：“怎么确定是真同步了还是方寸假绿骗人？”）——
           光说“已是最新”是结论；这里摆的是**源与目标两份 md5**，以及副本的最后修改时间。 -->
      <details v-if="syncEvidence.length" class="sk-verify" data-skills-evidence>
        <summary>逐文件凭据（{{ syncEvidenceText }}）</summary>
        <div class="sk-verify-body">
          <div v-for="t in syncEvidence" :key="t.id" class="sk-ev-target">
            <div class="sk-ev-head"><b>{{ t.name }}</b><span class="sk-ev-dir" :title="t.dir">{{ t.dir }}</span></div>
            <div v-if="!t.checks.length" class="sk-ev-row bad">这个目标没有可复核的技能</div>
            <div v-for="c in t.checks" :key="c.id" class="sk-ev-row" :class="c.match ? 'ok' : 'bad'">
              <span class="sk-ev-id">{{ c.id }}</span>
              <span class="sk-ev-hash">真源 {{ shortHash(c.srcHash) }} · 副本 {{ shortHash(c.destHash) }}</span>
              <span class="sk-ev-verdict">{{ c.match ? '✓ 与真源逐字节相同' : '✗ 与真源不同' }}</span>
              <span v-if="c.destAt" class="sk-ev-at">副本 {{ syncTimeText(c.destAt) }}</span>
            </div>
          </div>
        </div>
      </details>

      <!-- 维护机制说清楚（2026-10-03 用户问“方寸自带 skill 后续如何保持更新和维护？”）
           答案就在这段里 —— 但它是“读一次就够”的背景知识，默认收起，不占第一屏。 -->
      <details class="sk-note">
        <summary>技能是怎么随方寸一起更新的？</summary>
        <div class="sk-note-body">
          技能随方寸版本分发：<strong>升级方寸后启动会自动把新版同步到本机已检测到的 agent（DSH / Hermes 等）</strong>
          （装着的版本和方寸自带的不一样就重装）；只能手动导入的 agent，用卡片上的“真源指纹”
          对照你拖进去的那份是不是同一版。
        </div>
      </details>

      <div v-if="skillsError" class="skills-error">{{ skillsError }}</div>
      <div v-else-if="skillsLoading" class="plg-empty">读取中…</div>
      <div v-else-if="!skillsList.length" class="empty-state">
        <div class="empty-icon">🧩</div>
        <div class="empty-text">没找到技能清单 — 检查 skills/manifest.json 是否随包分发</div>
      </div>
      <template v-else>
        <!-- ── ① 方寸自带（随包分发，靠 manifest 登记）────────────────── -->
        <section class="sk-sec">
          <div class="sk-sec-h">
            <h4>方寸自带</h4>
            <span class="sk-sec-sub">
              真源：<span class="skills-dir" :title="skillsDir">{{ skillsDir }}</span>
            </span>
            <span class="sk-sec-meta">更新于 {{ skillsUpdated || '—' }}</span>
          </div>
          <div v-if="skillsUnlisted.length" class="skills-warn">
            有 {{ skillsUnlisted.length }} 个技能目录没登记进 manifest（会漏装）：{{ skillsUnlisted.join('、') }}
          </div>
          <div class="skills-list">
            <article v-for="sk in skillsList" :key="sk.id" class="skill-card">
              <div class="skill-main">
                <span class="skill-id">{{ sk.id }}</span>
                <span class="skill-state" :class="'skill-' + skillStateClass(sk)">{{ skillStateText(sk) }}</span>
                <span class="skill-ver">v{{ sk.version || '—' }}</span>
                <span v-if="sk.target && sk.target !== 'All'" class="skill-ver">仅 {{ sk.target }}</span>
              </div>
              <p class="skill-desc">{{ sk.desc || '(SKILL.md 里没写 description)' }}</p>
              <div class="skill-targets" v-if="targetsForSkill(sk).length">
                <span class="skill-targets-label">装到：</span>
                <span v-for="t in targetsForSkill(sk)" :key="t.id" class="skill-tgt"
                      :class="'skill-tgt-' + targetSkillState(t, sk)" :title="skillTargetTitle(t, sk)">
                  {{ t.name }}{{ targetStateText(t, sk) }}
                </span>
                <span class="skill-hash" :title="'真源 md5（只能手动导入的 agent，拿它对照装进去的那份是不是这一版）：' + (sk.hash || '')">真源指纹 {{ (sk.hash || '').slice(0, 8) || '—' }}</span>
              </div>
              <div class="skill-path" :title="sk.absPath">{{ sk.absPath }}</div>
              <div class="skill-actions">
                <Button variant="primary" size="tool" @click="copySkillPrompt(sk)">📋 复制安装提示词</Button>
                <Button variant="outline" size="tool" @click="copySkillBody(sk)">📄 复制 SKILL.md 全文</Button>
                <Button variant="outline" size="tool" @click="revealSkillPath(sk.absPath)"
                  title="在资源管理器里亮出这个技能的 SKILL.md —— 装到只能手动导入的 agent 时用它">📂 显示 SKILL.md</Button>
              </div>
            </article>
          </div>
        </section>

        <!-- ── ② 外部导入（跟自发布技能分开列，账本互不污染）────────── -->
        <section v-if="skillsImported.length" class="sk-sec">
          <div class="sk-sec-h">
            <h4>已导入的技能（外部）</h4>
            <span class="sk-sec-sub">直接丢进来的技能包，落在 {{ skillsImportDir || '（未检测到可装 agent）' }}{{ skillsImportTargetName ? '（' + skillsImportTargetName + '）' : '' }}；不进方寸的 manifest，可单独移除</span>
          </div>
          <div class="skills-imported">
            <article v-for="im in skillsImported" :key="im.name" class="skill-card imported">
              <div class="skill-main">
                <span class="skill-id">{{ im.name }}</span>
                <span class="skill-badge">外部导入</span>
                <span class="skill-ver" v-if="im.version">v{{ im.version }}</span>
                <span class="skill-files">{{ im.files }} 个文件 · {{ Math.max(1, Math.round(im.bytes / 1024)) }} KB</span>
              </div>
              <div class="skill-desc">{{ im.description || '(SKILL.md 里没写 description)' }}</div>
              <div class="skill-path" :title="im.dir">{{ im.dir }}</div>
              <div class="skill-actions">
                <Button variant="outline" size="tool" @click="revealSkillPath(im.dir)" title="在资源管理器里亮出 SKILL.md（装到别的 agent 用）">📂 显示 SKILL.md</Button>
                <Button variant="danger" size="tool" @click="removeImportedSkill(im)" title="只删这一个目录（带导入标记才允许删）">🗑 移除</Button>
              </div>
            </article>
          </div>
        </section>

        <!-- ── ③ 装到本机 agent（2026-11-21：不再围绕 Hermes 组织）────── -->
        <section class="sk-sec">
          <div class="sk-sec-h">
            <h4>装到本机 agent</h4>
            <span class="sk-sec-sub">只列本机实际检测到的；DSH / Hermes 可直装，其余只给文件 —— 别人的目录不猜、不写</span>
          </div>
          <!-- 三态而不是两态（2026-10-23）：原来只有“有数据 / 检测中…”两种，于是**通道不存在**时
               会永远停在“检测中…”—— 那不是检测中，是根本读不到（界面说假话）。
               现在：读失败 → 明说；还在读 → 检测中；读到了但为空 → 本机没检测到。 -->
          <div class="skills-agents">
            <div v-if="agentsError" class="skills-error">{{ agentsError }}</div>
            <div v-else-if="agentsLoading && !agentTargets.length" class="plg-empty">检测中…</div>
            <div v-else-if="!detectedAgents.length" class="plg-empty">本机没检测到可装的 agent —— 不是“还在检测”</div>
            <div v-for="a in detectedAgents" :key="a.id" class="agent-row">
              <div class="agent-line1">
                <span class="agent-name">{{ a.name }}</span>
                <span class="agent-mode" :class="a.mode === 'installable' ? 'can' : 'manual'">
                  {{ a.mode === 'installable' ? '可直装' : '给文件手动导入' }}
                </span>
                <Button v-if="a.mode === 'installable'"
                        variant="primary" size="tool" @click="installToTarget(a)">⚡ 装到 {{ a.name }}</Button>
                <Button v-if="a.mode !== 'installable'" variant="outline" size="tool"
                        @click="openAgentTarget(a)">▶ 打开 {{ a.name }}</Button>
                <!-- 清单为空时**不渲染**这个按钮：传空串过去只会拿到一句“没有可显示的技能路径”，
                     是“点了就报错”的那类死按钮（主进程侧也已单独兜底）。 -->
                <Button v-if="a.mode !== 'installable' && skillsList.length"
                  variant="outline" size="tool" @click="revealSkillPath(skillsList[0].absPath)">
                  📂 显示一份 SKILL.md
                </Button>
                <span v-if="a.linkText" class="agent-link" :class="'agent-link-' + a.linkClass"
                      :title="a.linkDetail">{{ a.linkText }}</span>
              </div>
              <div class="agent-evidence" :title="a.evidence">{{ a.evidence }}</div>
              <div class="agent-howto">{{ a.howTo }}</div>
            </div>
            <div v-if="undetectedAgents.length" class="sk-agents-off" title="这些 agent 本机没装；方寸不会给它们造目录">
              本机未检测到：{{ undetectedAgents.map(a => a.name).join('、') }}
            </div>
          </div>
        </section>
      </template>
    </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Button from '../components/ui/Button.vue'

/**
 * toast 的 type 只开放三种 —— 组件里出现的都是这三种。typo 会在编译期报错，
 * 而不是运行时掉进某个默认分支。
 */
const props = defineProps<{
  toast: (msg: string, type?: 'success' | 'error' | 'info') => void
  copy: (text: unknown, okMsg: string) => Promise<boolean>
  pulse: () => void
  dragAlive: boolean
}>()

// ── 技能安装专区（2026-09-26 卡 038）────────────────────────────────────
// 用户原话：“方寸技能毫无存在感”+“技能本质只是模块化提示词，不是硬性限制”。
// 所以这里**不做插件市场**，就是一块看得见、能复制的安装说明面板：
//   · 真源是随包分发的 skills/manifest.json（面板只读它，不自己编清单）；
//   · 主按钮是“复制安装提示词”—— 贴给任何 agent，它自己知道技能目录在哪，
//     提示词里带**绝对路径**，从根上杜绝手抄出错；
//   · 主进程早就有多目标安装能力；2026-11-21 起入口按“本机检测到的 agent”走，不再单列 Hermes。
interface SkillUiRow {
  id: string
  target: string
  version: string
  file: string
  absPath: string
  exists: boolean
  bytes: number
  installed: boolean
  outdated: boolean
  hash: string
  /** SKILL.md frontmatter 的 description（主进程从真源取；空串 = 真没写） */
  desc?: string
  body?: string
  prompt: string
}

/** 可直装目标的逐技能安装状态（卡 010/011；主进程 listSkillsForUi 下发） */
interface SkillTargetRow {
  id: string
  name: string
  dir: string
  present: boolean
  skills: { id: string; installed: boolean; outdated: boolean }[]
}

const skillsList = ref<SkillUiRow[]>([])
const skillsTargets = ref<SkillTargetRow[]>([])
const skillsLoading = ref(false)
const skillsError = ref('')
const skillsDir = ref('')
/** 外部导入落点（2026-11-21：DSH 在场优先；不再写死 Hermes） */
const skillsImportDir = ref('')
const skillsImportTargetName = ref('')
const skillsManifestVersion = ref('')
const skillsUpdated = ref('')
const skillsUnlisted = ref<string[]>([])
/** 外部导入的技能（2026-09-26 卡 005）—— 与自发布技能分账 */
const skillsImported = ref<{
  name: string; description: string; version: string; dir: string
  files: number; bytes: number; importedAt: string; source: string
}[]>([])
const skillsDragging = ref(false)

/**
 * 自动同步的留痕（2026-11-05 暮雨：“更新后无法自动更新技能吗？是完全断链吗？”）。
 *
 * 结论不是断链，但**看不出来**：同步只在建窗时跑一次，升级后旧进程还在托盘，
 * 新实例被单实例锁顶掉 —— 于是“没同步”和“同步了”在界面上长得一模一样。
 * 所以这里把它摆出来：上次什么时候、哪个版本、结果如何；版本对不上就直接报陈旧，
 * 并给一个“现在同步”按钮（不用重启、不用退托盘）。
 */
interface SkillSyncRow {
  at: string
  appVersion: string
  trigger: string
  ok: boolean
  skills: string[]
  targets: {
    id: string; name: string; present: boolean; needsInstall: boolean
    installed: string[]; skipped: string[]; errors: { skill: string; error: string }[]; error?: string
    /** 装完/跳过后重新读盘的逐文件指纹（2026-11-21） */
    checks: { id: string; srcHash: string; destHash: string; match: boolean; destAt: string }[]
    verified: boolean
  }[]
}
interface SkillLiveRow {
  id: string; name: string; dir: string; present: boolean
  checks: { id: string; srcHash: string; destHash: string; match: boolean; destAt: string }[]
  verified: boolean
  mismatched: string[]
}
const skillsSync = ref<SkillSyncRow | null>(null)
const skillsSyncStale = ref(false)
const skillsSyncStaleReason = ref('')
const skillsSyncVersion = ref('')
const skillsSyncBusy = ref(false)
/** 现在这一刻的磁盘实况（与“上次同步记录”分开；记录绿不代表现在绿） */
const skillsLive = ref<SkillLiveRow[]>([])
const skillsLiveStale = ref(false)
const skillsLiveReason = ref('')

/** 同步记录 + 磁盘实况，任何一个说不绿就不许显示绿 */
const syncWarn = computed(() => skillsSyncStale.value || skillsLiveStale.value)
const syncWarnReason = computed(() => skillsSyncStaleReason.value || skillsLiveReason.value || '同步记录或磁盘实况有一处对不上')

/** 只列**在场**的目标：没装的 agent 不占卡片位置（用户不一定有 Hermes） */
const presentTargets = computed(() => skillsTargets.value.filter(t => t.present))
/** 本机检测到的 agent（DSH 排前面 —— 方寸现在主用 DSH） */
const detectedAgents = computed(() => {
  const rows = (agentTargets.value || []).filter(a => a.detected)
  return rows.slice().sort((a, b) => rankAgent(a) - rankAgent(b))
})
const undetectedAgents = computed(() => (agentTargets.value || []).filter(a => !a.detected))
function rankAgent(a: AgentTargetUi): number {
  if (a.id === 'dsh') return 0
  if (a.id === 'hermes') return 1
  return a.mode === 'installable' ? 2 : 3
}

/** 逐文件凭据：优先用本次同步的 checks；没有同步记录时用当前磁盘实况 */
const syncEvidence = computed<{ id: string; name: string; dir: string; checks: SkillLiveRow['checks'] }[]>(() => {
  const fromSync = (skillsSync.value?.targets || []).filter(t => t.present && Array.isArray(t.checks) && t.checks.length)
  if (fromSync.length) return fromSync.map(t => ({ id: t.id, name: t.name, dir: skillsTargets.value.find(x => x.id === t.id)?.dir || '', checks: t.checks }))
  return skillsLive.value.filter(t => t.present && t.checks.length).map(t => ({ id: t.id, name: t.name, dir: t.dir, checks: t.checks }))
})
const syncEvidenceText = computed(() => {
  const rows = syncEvidence.value
  const total = rows.reduce((n, t) => n + t.checks.length, 0)
  const ok = rows.reduce((n, t) => n + t.checks.filter(c => c.match).length, 0)
  return `${ok} / ${total} 个文件逐字节一致`
})
function shortHash(h: string): string {
  return h ? h.slice(0, 8) : '—'
}

/** 概览条：每个可直装目标「N / 该目标该装的数 最新」（不在场的明说不在场，不写 0/0） */
const targetSummary = computed(() => skillsTargets.value.map((t) => {
  const total = (t.skills || []).length
  const ok = (t.skills || []).filter((s) => !s.outdated && s.installed).length
  return { id: t.id, name: t.name, present: t.present, total, ok }
}))

function syncTimeText(at: string): string {
  if (!at) return '—'
  const t = new Date(at)
  if (Number.isNaN(t.getTime())) return at
  const mm = String(t.getMonth() + 1).padStart(2, '0')
  const dd = String(t.getDate()).padStart(2, '0')
  const hh = String(t.getHours()).padStart(2, '0')
  const mi = String(t.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}
function syncTargetText(t: SkillSyncRow['targets'][number]): string {
  if (!t.present) return `${t.name} 不在场`
  if (t.error) return `${t.name} 失败`
  if (t.errors.length) return `${t.name} 失败 ${t.errors.length}`
  const checks = Array.isArray(t.checks) ? t.checks : []
  // 旧版主进程没有 checks：退回原口径，**不许**把“没有证据”说成“复核失败”
  if (!checks.length) {
    if (t.installed.length) return `${t.name} 更新 ${t.installed.length}`
    return `${t.name} ✓`
  }
  const ok = checks.filter(c => c.match).length
  if (!t.verified) return `${t.name} 复核 ✗ ${ok}/${checks.length}`
  if (t.installed.length) return `${t.name} 更新 ${t.installed.length}（复核 ${ok}/${checks.length} 一致）`
  return `${t.name} ✓（复核 ${ok}/${checks.length} 一致）`
}

async function loadSkillSync(): Promise<void> {
  try {
    const r: any = await window.tegula.skillsSyncStatus()
    if (r && r.ok !== false) {
      skillsSync.value = r.status || null
      skillsSyncStale.value = !!r.stale
      skillsSyncStaleReason.value = r.staleReason || ''
      skillsSyncVersion.value = r.currentVersion || ''
      skillsLive.value = Array.isArray(r.live) ? r.live : []
      skillsLiveStale.value = !!r.liveStale
      skillsLiveReason.value = r.liveReason || ''
    }
  } catch {
    // 读不到状态不该让整页报错 —— 技能清单本身还能看
    skillsSync.value = null
    skillsLive.value = []
    skillsLiveStale.value = false
    skillsLiveReason.value = ''
  }
}

/** 🧪 核验：重新读盘算两边指纹（不安装、不改任何文件），把结论如实报出来 */
async function verifySkillsNow(): Promise<void> {
  if (skillsSyncBusy.value) return
  skillsSyncBusy.value = true
  try {
    await Promise.all([loadSkillSync(), loadSkills()])
    const rows = skillsLive.value.filter(t => t.present)
    if (!rows.length) { props.toast('没有检测到可核验的 agent（DSH / Hermes 都不在本机）', 'info'); return }
    const total = rows.reduce((n, t) => n + t.checks.length, 0)
    const ok = rows.reduce((n, t) => n + t.checks.filter(c => c.match).length, 0)
    if (ok === total && total > 0) props.toast(`核验完成：${ok}/${total} 个技能副本与真源逐字节一致（两边 md5 已列在下方凭据里）`, 'success')
    else props.toast(`核验发现不一致：${ok}/${total} 一致 —— 点「现在同步」重装，或看下方逐文件凭据`, 'error')
  } catch (e: any) {
    props.toast('核验失败：' + (e?.message || e), 'error')
  } finally {
    skillsSyncBusy.value = false
  }
}

/** 现在补同步一次（不等重启、不等托盘退出） */
async function syncSkillsNow(): Promise<void> {
  if (skillsSyncBusy.value) return
  skillsSyncBusy.value = true
  try {
    const r: any = await window.tegula.skillsSyncNow()
    if (r && r.ok === false) {
      props.toast('同步失败：' + (r.error || '未知原因'), 'error')
    } else {
      const t = (r.lastRun && r.lastRun.targets) || []
      const n = t.reduce((a: number, x: any) => a + (x.installed ? x.installed.length : 0), 0)
      const bad = t.filter((x: any) => x.error || (x.errors && x.errors.length) || (x.present && x.verified === false)).length
      const checks = t.reduce((a: number, x: any) => a + ((x.checks || []).length), 0)
      const okChecks = t.reduce((a: number, x: any) => a + ((x.checks || []).filter((c: any) => c.match).length), 0)
      const proof = checks ? `，复核 ${okChecks}/${checks} 个文件一致` : ''
      if (bad) props.toast(`同步跑完了，但有 ${bad} 个目标没通过复核${proof}（技能页上方有逐文件凭据）`, 'error')
      else props.toast(n ? `已同步 ${n} 个技能副本${proof}` : `已是最新，没有需要更新的${proof}`, 'success')
      await loadSkillSync()
      await loadSkills()
    }
  } catch (e: any) {
    props.toast('同步失败：' + (e?.message || e), 'error')
  } finally {
    skillsSyncBusy.value = false
  }
}

async function loadSkills(): Promise<void> {
  skillsLoading.value = true
  skillsError.value = ''
  try {
    const r: any = await window.tegula.skillsList()
    if (!r || r.ok === false) {
      skillsError.value = (r && r.error) || '读取技能清单失败'
      skillsList.value = []
    } else {
      skillsList.value = r.skills || []
      skillsTargets.value = r.targets || []
      skillsDir.value = r.skillsDir || ''
      skillsImportDir.value = r.importDir || r.hermesDir || ''
      skillsImportTargetName.value = r.importTargetName || ''
      skillsManifestVersion.value = r.version || ''
      skillsUpdated.value = r.lastUpdated || ''
      skillsUnlisted.value = r.unlisted || []
    }
    // 外部导入的另有一份（独立通道，失败不影响自发布技能列表）
    try {
      const im: any = await window.tegula.skillsImported()
      skillsImported.value = (im && im.items) || []
    } catch {
      skillsImported.value = []
    }
  } catch (e: any) {
    skillsError.value = '读取技能清单失败：' + (e?.message || e)
    skillsList.value = []
  } finally {
    skillsLoading.value = false
  }
}

/** 单个技能对某个可直装目标的状态（卡 010/011）：ok=一致 / warn=有更新 / idle=没装 / absent=目标不在场 */
function targetSkillState(t: SkillTargetRow, sk: SkillUiRow): 'ok' | 'warn' | 'idle' | 'absent' {
  if (!t.present) return 'absent'
  const s = (t.skills || []).find(x => x.id === sk.id)
  if (!s || !s.installed) return 'idle'
  return s.outdated ? 'warn' : 'ok'
}
function targetStateText(t: SkillTargetRow, sk: SkillUiRow): string {
  switch (targetSkillState(t, sk)) {
    case 'absent': return '（不在场）'
    case 'idle': return ' 未装'
    case 'warn': return ' ⬆有更新'
    default: return ' ✓最新'
  }
}
function skillTargetTitle(t: SkillTargetRow, sk: SkillUiRow): string {
  const base = `${t.name} · ${t.dir}`
  switch (targetSkillState(t, sk)) {
    case 'absent': return `${base}\n本机没有 ${t.name} —— 不给它造目录，也不往里写`
    case 'idle': return `${base}\n技能副本不在（用上面的“⚡ 装到 ${t.name}”）`
    case 'warn': return `${base}\n磁盘上那份与真源不一致 —— 重装即更新（不是“已存在就永远跳过”）`
    default: return `${base}\n副本与真源逐字节一致`
  }
}

/** 这张技能卡该显示哪些目标：`All` 通吃；写了具体 agent 的就只显示那一家（本机没装则不显示） */
function targetsForSkill(sk: SkillUiRow): SkillTargetRow[] {
  const want = String(sk.target || 'All').toLowerCase()
  if (want === 'all' || want === 'any') return presentTargets.value
  return presentTargets.value.filter((t) => t.id.toLowerCase() === want || t.name.toLowerCase() === want)
}

/** 状态文案的取值只有三种事实：文件在不在 / 装没装 / 是不是旧的 */
function skillStateText(sk: SkillUiRow): string {
  if (!sk.exists) return '文件缺失'
  if (!targetsForSkill(sk).length) {
    return sk.target && sk.target !== 'All' ? `仅 ${sk.target} · 本机没装` : '无可直装目标'
  }
  const states = targetsForSkill(sk).map(t => targetSkillState(t, sk))
  if (states.every(s => s === 'idle')) return '未装'
  if (states.some(s => s === 'warn')) return '有更新'
  return '已装（最新）'
}
function skillStateClass(sk: SkillUiRow): string {
  if (!sk.exists) return 'bad'
  if (!targetsForSkill(sk).length) return 'idle'
  const states = targetsForSkill(sk).map(t => targetSkillState(t, sk))
  if (states.every(s => s === 'idle')) return 'idle'
  return states.some(s => s === 'warn') ? 'warn' : 'good'
}

async function copySkillPrompt(sk: SkillUiRow): Promise<void> {
  await props.copy(sk.prompt, `已复制“${sk.id}”安装提示词 —— 粘给 agent 就能自己装`)
}

async function copySkillBody(sk: SkillUiRow): Promise<void> {
  if (!sk.body) { props.toast('这份 SKILL.md 读不出来（文件缺失或为空）', 'error'); return }
  await props.copy(sk.body, `已复制“${sk.id}”SKILL.md 全文（${sk.body.length} 字）`)
}

/**
 * ⚡ 装到本机 agent（2026-11-21）：一次遍历**本机检测到的可直装目标**。
 * 不再有“装到 Hermes”这种把某一家的名字写进按钮的入口 —— DSH 在场就先装 DSH。
 */
async function installAllDetected(): Promise<void> {
  const t: any = window.tegula
  if (typeof t.skillsInstallTo !== 'function') { props.toast('当前主进程是旧版本，没有这个通道', 'error'); return }
  const rows = detectedAgents.value.filter(a => a.mode === 'installable')
  if (!rows.length) { props.toast('本机没有可直装的 agent（DSH / Hermes 都没检测到）', 'info'); return }
  let installed = 0
  const failed: string[] = []
  for (const a of rows) {
    const r: any = await t.skillsInstallTo(a.id)
    if (!r || (r.errors && r.errors.length)) failed.push(a.name)
    else installed += (r.installed || []).length
  }
  props.toast(failed.length
    ? `装到本机 agent：失败 ${failed.join('、')}（技能页上方有明细）`
    : `装到本机 agent：${installed ? `更新 ${installed} 个副本` : '已是最新'} —— 已重新读盘复核`,
    failed.length ? 'error' : 'success')
  await Promise.all([loadSkills(), loadAgents(), loadSkillSync()])
}

// ── 技能直接导入（2026-09-26 卡 005）──────────────────────────────────────
// 说明：重名时主进程返回 code='exists'，这里**问一句**再带 overwrite 重试；
// 校验类失败（invalid/too-large/reserved）直接报错，绝不静默覆盖。
async function importSkillPath(srcPath: string, overwrite = false): Promise<boolean> {
  const r: any = await window.tegula.skillsImport(srcPath, { overwrite })
  if (!r) { props.toast('导入失败：主进程没有返回', 'error'); return false }
  if (r.ok) {
    props.toast(`已导入“${r.name}”→ ${r.target}（${r.files} 个文件）`, 'success')
    await loadSkills()
    return true
  }
  if (r.code === 'exists') {
    const yes = confirm(`“${r.name}”已经存在。\n\n覆盖 = 用这个包替换掉现在那份；同名旧目录会先备份再替换，失败会还原。\n\n要覆盖吗？`)
    if (!yes) { props.toast(`已取消导入“${r.name}”`, 'info'); return false }
    return await importSkillPath(srcPath, true)
  }
  props.toast(`导入失败：${r.error || '未知原因'}`, 'error')
  return false
}

async function importSkillViaPicker(kind: 'file' | 'folder'): Promise<void> {
  const picked: any = await window.tegula.skillsImportPick(kind)
  if (!picked) { props.toast('选择失败：主进程没有返回', 'error'); return }
  if (picked.canceled) return
  if (!picked.ok || !picked.path) { props.toast(`选择失败：${picked.error || '未知原因'}`, 'error'); return }
  await importSkillPath(picked.path)
}

/** 拖进窗口的文件/文件夹：Electron 的 File 对象带 path（28 是最后一个还带 path 的大版本） */
function dropPaths(dt: DataTransfer | null): string[] {
  if (!dt) return []
  const out: string[] = []
  const files = dt.files ? Array.from(dt.files) as any[] : []
  for (const f of files) {
    const p = f?.path || ''
    if (p) out.push(p)
  }
  return out
}

function onSkillsDragOver(ev: DragEvent): void {
  props.pulse() // 吃全局心跳，拖拽收场拿不到事件时遮罩也会自己消失
  skillsDragging.value = true
  // 拖拽进入子元素会触发 dragleave，靠这一行把状态稳住（否则遮罩闪）
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
}

function onSkillsDragLeave(ev: DragEvent): void {
  const rt = ev.relatedTarget as Node | null
  const cur = ev.currentTarget as Node | null
  if (rt && cur && cur.contains(rt)) return
  skillsDragging.value = false
}

async function onSkillsDrop(ev: DragEvent): Promise<void> {
  skillsDragging.value = false
  const paths = dropPaths(ev.dataTransfer)
  if (!paths.length) { props.toast('没读到拖入的路径 —— 请改用“📥 导入技能…”按钮', 'error'); return }
  let ok = 0
  for (const p of paths) {
    if (await importSkillPath(p)) ok++
  }
  if (paths.length > 1) props.toast(`拖入 ${paths.length} 个，成功 ${ok} 个`, ok ? 'success' : 'error')
}

async function removeImportedSkill(im: { name: string; dir: string }): Promise<void> {
  if (!confirm(`移除“${im.name}”？\n\n只删这一个目录（${im.dir}），方寸自发布技能不受影响。`)) return
  const r: any = await window.tegula.skillsRemove(im.name)
  if (r && r.ok) {
    props.toast(`已移除“${im.name}”`, 'success')
    await loadSkills()
  } else {
    props.toast(`移除失败：${(r && r.error) || '未知原因'}`, 'error')
  }
}

/**
 * “装到别的 agent”目标（2026-09-26 用户回执：“技能没找到任何可以安装给 WorkBuddy 的地方，依然只有安装到 Hermes”）
 *
 * 事实（本机查过）：本机只有 ~/.hermes/skills 与 ~/.config/opencode，没有 .claude/.codex/.cursor；
 * WorkBuddy 是打包过的 Electron 应用，技能目录不在 %APPDATA%\WorkBuddy（空的）——**我们不能猜、不能瞎写**。
 * 所以：能直装的只有 Hermes / DSH；其余的给“显示 SKILL.md + 打开对方”，用户拖一下即可。
 */
interface AgentTargetUi {
  id: string; name: string; mode: 'installable' | 'manual'
  detected: boolean; evidence: string; skillsDir?: string; openPath?: string; howTo: string
  /** 卡 011：技能副本 / MCP 配置两个事实（undefined = 该目标落点不可知，不猜） */
  skillLinked?: boolean; mcpLinked?: boolean; linkDetail?: string
  /** 由上面两个事实算出的徽章（在 loadAgents 里算好，模板直接读） */
  linkText?: string; linkClass?: string
}
const agentTargets = ref<AgentTargetUi[]>([])
/** 还在读（模板靠它区分“检测中”与“真没有”——两个态文案完全不同） */
const agentsLoading = ref(true)
/** 读失败/没通道时的一句人话；空 = 正常 */
const agentsError = ref('')

/** “已接入”徽章：两个事实都说 true→已接入；都说 false→未接入；一半→部分；有不可知→不可知 */
function agentLinkBadge(a: AgentTargetUi): { text: string; cls: string } {
  const known = [a.skillLinked, a.mcpLinked].filter(v => v !== undefined) as boolean[]
  const yes = known.filter(Boolean).length
  if (!known.length) return { text: '接入状态不可知', cls: 'unknown' }
  if (yes === known.length && known.length === 2) return { text: '已接入', cls: 'linked' }
  if (yes === 0) return { text: '未接入', cls: 'none' }
  return { text: '部分接入', cls: 'partial' }
}

async function loadAgents(): Promise<void> {
  agentsLoading.value = true
  agentsError.value = ''
  try {
    const t: any = window.tegula
    if (typeof t.agentsList !== 'function') {
      agentTargets.value = []
      agentsError.value = '当前主进程没有“检测 agent”这个通道（旧版本）—— 这一块读不到'
      return
    }
    const r: any = await t.agentsList()
    const raw: AgentTargetUi[] = Array.isArray(r) ? r : (r && r.agents) || []
    agentTargets.value = raw.map(a => {
      const b = agentLinkBadge(a)
      return { ...a, linkText: b.text, linkClass: b.cls }
    })
  } catch (e: any) {
    agentTargets.value = []
    agentsError.value = '读取 agent 列表失败：' + (e?.message || e)
  } finally {
    agentsLoading.value = false
  }
}

/** “⚡ 装到 X”：只对可直装且检测到的目标开（其余走“显示 SKILL.md + 打开对方”） */
async function installToTarget(a: AgentTargetUi): Promise<void> {
  const t: any = window.tegula
  if (typeof t.skillsInstallTo !== 'function') { props.toast('当前主进程是旧版本，没有这个通道', 'error'); return }
  const r: any = await t.skillsInstallTo(a.id)
  if (!r) { props.toast('安装失败：主进程没有返回', 'error'); return }
  const errs = r.errors || []
  if (errs.length && !r.installed.length) {
    props.toast(`装到 ${a.name} 失败：${errs[0].error}`, 'error')
  } else {
    const parts: string[] = []
    if (r.installed && r.installed.length) parts.push(`已装 ${r.installed.length}`)
    if (r.skipped && r.skipped.length) parts.push(`跳过 ${r.skipped.length}`)
    if (errs.length) parts.push(`失败 ${errs.length}`)
    props.toast(`装到 ${a.name}：${parts.join(' / ') || '无变化'}`, errs.length ? 'error' : 'success')
  }
  await loadSkills()
  await loadAgents()
}

async function openAgentTarget(a: AgentTargetUi): Promise<void> {
  const t: any = window.tegula
  if (typeof t.agentsOpen !== 'function') { props.toast('当前主进程是旧版本，没有这个通道', 'error'); return }
  const r: any = await t.agentsOpen(a.id)
  if (r && r.ok) props.toast(r.message || `已打开 ${a.name}`, 'success')
  else props.toast(`打开失败：${(r && r.message) || '未知原因'}`, 'error')
}

/** 在资源管理器里亮出某个技能目录/文件的 SKILL.md（主进程只允许技能目录内的路径） */
async function revealSkillPath(dirOrFile: string): Promise<void> {
  const t: any = window.tegula
  if (!dirOrFile) { props.toast('这条技能没有可用的路径', 'error'); return }
  if (typeof t.skillsReveal !== 'function') { props.toast('当前主进程是旧版本，没有这个通道', 'error'); return }
  const r: any = await t.skillsReveal(dirOrFile)
  if (r && r.ok) props.toast(r.message || '已在资源管理器里亮出 SKILL.md', 'success')
  else props.toast(`显示失败：${(r && r.message) || '未知原因'}`, 'error')
}

async function openSkillsDir(which: string): Promise<void> {
  const r: any = await window.tegula.skillsOpenDir(which)
  if (r && r.ok) props.toast(`已打开 ${r.dir || ''}`, 'success')
  else props.toast(`打开失败：${(r && r.error) || '未知原因'}`, 'error')
}

/** 投放遮罩：吃全局心跳 —— 拖拽收场（按 Esc / 松手在窗口外）拿不到事件时也要自己消失 */
const skillsDropMaskVisible = computed(() => skillsDragging.value && props.dragAlive)

// 进页面就加载：技能清单 / 别的 agent 的检测结果 / 自动同步留痕。
// ⚠ 三份都是这一页的全部内容，缺哪个界面上就有一块是空的。
onMounted(() => {
  void loadSkills()
  void loadAgents()
  void loadSkillSync()
})
</script>
