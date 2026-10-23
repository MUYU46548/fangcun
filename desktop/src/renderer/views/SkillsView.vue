<!--
  技能安装专区（2026-10-23 拆成组件 · 拆分计划第 1 批第 6 块）

  为什么这块能整块搬：模板 157 行 + 脚本 366 行全部只服务这一页
  （技能清单 / 装到 Hermes / 导入外部技能 / 装到别的 agent / MCP 接入材料），
  **零弹窗、零跨视图状态**。和 services 那块的处置一样：整块搬，不切两半。

  ⚠ 四个注入项，都不是数据而是「本页没有的能力」：
    toast        —— 提示条是全站状态，不归这一页；
    copy         —— 复制要走主进程剪贴板 + 统一 toast（copyWithToast），19 处共用；
    pulse        —— 拖拽心跳（全局拖拽遮罩靠它兜底，见 App.vue「心跳兜底」那段）；
    dragAlive    —— 同上：拖拽是不是真的还在进行，遮罩必须跟它一起消失。

  最后两项必须由父组件给：心跳状态是 todo/log/skills 三个投放区**共用**的，
  在这一页自己造一份，就会出现"那边拖完这边遮罩还留着"。
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
      <div class="skills-header">
        <h3>技能安装专区</h3>
        <span class="skills-hint">技能本质只是模块化提示词，不是插件 —— 复制提示词贴给 agent，它自己装，省得手抄出错。</span>
        <!-- 维护机制说清楚（2026-10-03 用户问「方寸自带 skill 后续如何保持更新和维护？」）：
             答案就在这一行 —— 随版本分发 + 启动自动同步 + 手动目标用指纹对账。 -->
        <span class="skills-hint skills-maint">
          技能随方寸版本分发：<b>升级方寸后启动会自动把新版同步到 Hermes / DSH</b>（哈希不一致就重装）；
          WorkBuddy 这类只能手动导入的，用卡片上的「真源指纹」对照你拖进去的那份是不是同一版。
        </span>
        <button class="skills-btn primary" @click="installSkillsToHermes()" title="把随包分发的技能复制到 ~/.hermes/skills/ 并记 hash">⚡ 装到 Hermes</button>
        <button class="skills-btn primary" @click="importSkillViaPicker('file')" title="选一个 .zip 或 .md 技能包导入">📥 导入技能…</button>
        <button class="skills-btn" @click="importSkillViaPicker('folder')" title="选一个技能文件夹（内有 SKILL.md）导入">📁 导入文件夹…</button>
        <button class="skills-btn" @click="openSkillsDir('resources')" title="打开随包分发的技能目录">📂 技能目录</button>
        <button class="skills-btn" @click="openSkillsDir('hermes')" title="打开 Hermes 侧的技能目录">📂 Hermes 目录</button>
        <button class="skills-btn" @click="loadSkills()">刷新</button>
      </div>

      <!-- 外部导入的技能（2026-09-26 卡 005）：跟自发布技能分开列，账本互不污染 -->
      <div v-if="skillsImported.length" class="skills-imported">
        <div class="skills-imported-title">
          已导入的技能（外部）
          <span class="skills-imported-hint">直接丢进来的技能包，落在 {{ skillsHermesDir }}；不进方寸的 manifest，可单独移除</span>
        </div>
        <div v-for="im in skillsImported" :key="im.name" class="skill-card imported">
          <div class="skill-main">
            <span class="skill-id">{{ im.name }}</span>
            <span class="skill-badge">外部导入</span>
            <span class="skill-ver" v-if="im.version">v{{ im.version }}</span>
            <span class="skill-files">{{ im.files }} 个文件 · {{ Math.max(1, Math.round(im.bytes / 1024)) }} KB</span>
          </div>
          <div class="skill-desc">{{ im.description || '(SKILL.md 里没写 description)' }}</div>
          <div class="skill-path" :title="im.dir">{{ im.dir }}</div>
          <div class="skill-actions">
            <button class="skills-btn" @click="revealSkillPath(im.dir)" title="在资源管理器里亮出 SKILL.md（装到别的 agent 用）">📂 显示 SKILL.md</button>
            <button class="skills-btn danger" @click="removeImportedSkill(im)" title="只删这一个目录（带导入标记才允许删）">🗑 移除</button>
          </div>
        </div>
      </div>

      <div v-if="skillsError" class="skills-error">{{ skillsError }}</div>
      <div v-else-if="skillsLoading" class="empty-state"><div class="empty-text">读取中…</div></div>
      <div v-else-if="!skillsList.length" class="empty-state">
        <div class="empty-icon">🧩</div>
        <div class="empty-text">没找到技能清单 — 检查 skills/manifest.json 是否随包分发</div>
      </div>
      <template v-else>
        <div class="skills-meta">
          清单版本 {{ skillsManifestVersion || '—' }} · 更新于 {{ skillsUpdated || '—' }}
          <span class="skills-dir" :title="skillsDir">真源：{{ skillsDir }}</span>
        </div>
        <div v-if="skillsUnlisted.length" class="skills-warn">
          有 {{ skillsUnlisted.length }} 个技能目录没登记进 manifest（会漏装）：{{ skillsUnlisted.join('、') }}
        </div>
        <div class="skills-list">
          <div v-for="sk in skillsList" :key="sk.id" class="skill-card">
            <div class="skill-main">
              <span class="skill-id">{{ sk.id }}</span>
              <span class="skill-target">{{ sk.target }}</span>
              <span class="skill-ver">v{{ sk.version || '—' }}</span>
              <span class="skill-state" :class="'skill-' + skillStateClass(sk)">{{ skillStateText(sk) }}</span>
            </div>
            <div class="skill-targets" v-if="skillsTargets.length">
              <span class="skill-targets-label">装到：</span>
              <span v-for="t in skillsTargets" :key="t.id" class="skill-tgt"
                    :class="'skill-tgt-' + targetSkillState(t, sk)" :title="skillTargetTitle(t, sk)">
                {{ t.name }}{{ targetStateText(t, sk) }}
              </span>
              <span class="skill-hash" :title="'真源 md5（WorkBuddy 这类只能手动导入的 agent，拿它对照装进去的那份是不是这一版）：' + (sk.hash || '')">真源指纹 {{ (sk.hash || '').slice(0, 8) || '—' }}</span>
            </div>
            <div class="skill-path" :title="sk.absPath">{{ sk.absPath }}</div>
            <div class="skill-actions">
              <button class="skills-btn primary" @click="copySkillPrompt(sk)">📋 复制安装提示词</button>
              <button class="skills-btn" @click="copySkillBody(sk)">📄 复制 SKILL.md 全文</button>
              <button class="skills-btn" @click="revealSkillPath(sk.absPath)" title="在资源管理器里亮出这个技能的 SKILL.md —— 装到 WorkBuddy 这类只能手动导入的 agent 时用它">📂 显示 SKILL.md</button>
            </div>
          </div>
        </div>
        <div class="skills-agents">
          <div class="skills-agents-title">
            装到别的 agent（不只有 Hermes）
            <span class="skills-agents-sub">本机实际检测到的才列出来；方寸只往 Hermes 直装 —— 别人的目录不猜、不写</span>
          </div>
          <!-- 三态而不是两态（2026-10-23）：原来只有「有数据 / 检测中…」两种，于是**通道不存在**时
               会永远停在「检测中…」—— 那不是检测中，是根本读不到（界面说假话）。
               现在：读失败 → 明说；还在读 → 检测中；读到了但为空 → 本机没检测到。 -->
          <div v-if="agentsError" class="skills-error">{{ agentsError }}</div>
          <div v-else-if="agentsLoading && !agentTargets.length" class="skills-agent">检测中…</div>
          <div v-else-if="!agentTargets.length" class="skills-agent">本机没检测到可装的 agent —— 不是「还在检测」</div>
          <div v-for="a in agentTargets" :key="a.id" class="agent-row" :class="{ 'agent-off': !a.detected }">
            <div class="agent-line1">
              <span class="agent-name">{{ a.name }}</span>
              <span class="agent-mode" :class="a.mode === 'installable' ? 'can' : 'manual'">
                {{ a.mode === 'installable' ? '可直装' : '给文件手动导入' }}
              </span>
              <span class="agent-state">{{ a.detected ? '已检测到' : '没检测到' }}</span>
              <!-- Hermes 的安装入口在顶部（同一个动作不摆两遍）；其余可直装目标在本行给自己装 -->
              <span v-if="a.detected && a.mode === 'installable' && a.id === 'hermes'" class="agent-note">
                装入口在顶部「⚡ 装到 Hermes」
              </span>
              <button v-if="a.detected && a.mode === 'installable' && a.id !== 'hermes'"
                      class="skills-btn primary" @click="installToTarget(a)">⚡ 装到 {{ a.name }}</button>
              <button v-if="a.detected && a.mode !== 'installable'" class="skills-btn" @click="openAgentTarget(a)">▶ 打开 {{ a.name }}</button>
              <!-- 清单为空时**不渲染**这个按钮：传空串过去只会拿到一句"没有可显示的技能路径"，
                   是"点了就报错"的那类死按钮（主进程侧也已单独兜底）。 -->
              <button v-if="a.detected && a.mode !== 'installable' && skillsList.length"
                class="skills-btn" @click="revealSkillPath(skillsList[0].absPath)">
                📂 显示一份 SKILL.md
              </button>
              <span v-if="a.detected && a.linkText" class="agent-link" :class="'agent-link-' + a.linkClass"
                    :title="a.linkDetail">{{ a.linkText }}</span>
            </div>
            <div class="agent-evidence" :title="a.evidence">{{ a.evidence }}</div>
            <div class="agent-howto">{{ a.howTo }}</div>
          </div>
        </div>

        <!-- MCP 接入材料（2026-10-02 卡 002 · A 路线）
             口径：方寸只出材料（按本机路径生成的配置段 + 复制 + 打开目标文件），
             **不写任何外部应用的文件** —— 粘贴与保存由用户完成。 -->
        <div class="skills-agents mcp-connect">
          <div class="skills-agents-title">
            接入 MCP（读写方寸任务数据）
            <span class="skills-agents-sub">按本机安装路径生成配置段；方寸只给材料 —— 粘贴保存由你完成</span>
          </div>
          <div class="mcp-entry-pick">
            <span class="mcp-entry-label">入口：</span>
            <template v-for="e in mcpEntries" :key="e.id">
              <button class="skills-btn" :class="{ primary: e.id === mcpEntry }"
                :disabled="!e.available" @click="mcpEntry = e.id"
                :title="e.available ? e.usage : e.detail">
                {{ e.label }}{{ e.available ? '' : '（不可用）' }}
              </button>
            </template>
            <span v-if="mcpEntryDetail" class="mcp-entry-note">{{ mcpEntryDetail }}</span>
          </div>
          <div v-if="mcpInfoError" class="skills-error">{{ mcpInfoError }}</div>
          <div v-else-if="mcpLoading && !mcpTargets.length" class="skills-agent">检测中…</div>
          <div v-else-if="!mcpTargets.length" class="skills-agent">本机没检测到可接入的目标 —— 不是「还在检测」</div>
          <div v-for="m in mcpTargets" :key="m.id" class="agent-row" :class="{ 'agent-off': !m.detected }">
            <div class="agent-line1">
              <span class="agent-name">{{ m.name }}</span>
              <span class="agent-state">{{ m.detected ? '已检测到' : '没检测到' }}</span>
              <button class="skills-btn primary" @click="copyMcpSnippet(m)"
                title="生成按本机安装路径的配置段并复制">📋 复制配置段</button>
              <button class="skills-btn" @click="copyMcpSelfInstall(m)"
                title="生成一段贴给它的自装指令（技能卡路径 + 配置段 + 自检步骤），由它自己动手 —— 耗它自己的 token，方寸零写入">🤖 让它自装</button>
              <button v-if="m.configPath" class="skills-btn" @click="openMcpConfig(m)"
                title="打开对方的配置文件，粘贴后保存">📂 打开配置文件</button>
            </div>
            <div class="agent-evidence" :title="m.evidence">{{ m.evidence }}</div>
            <div class="agent-howto">{{ m.howTo }}</div>
          </div>
        </div>
      </template>
    </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

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
// 用户原话：「方寸技能毫无存在感」+「技能本质只是模块化提示词，不是硬性限制」。
// 所以这里**不做插件市场**，就是一块看得见、能复制的安装说明面板：
//   · 真源是随包分发的 skills/manifest.json（面板只读它，不自己编清单）；
//   · 主按钮是「复制安装提示词」—— 贴给任何 agent，它自己知道技能目录在哪，
//     提示词里带**绝对路径**，从根上杜绝手抄出错；
//   · 顺带给 Hermes 一键装（这正是主进程里早就有、但渲染层一直没入口的能力）。
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
const skillsHermesDir = ref('')
const skillsManifestVersion = ref('')
const skillsUpdated = ref('')
const skillsUnlisted = ref<string[]>([])
/** 外部导入的技能（2026-09-26 卡 005）—— 与自发布技能分账 */
const skillsImported = ref<{
  name: string; description: string; version: string; dir: string
  files: number; bytes: number; importedAt: string; source: string
}[]>([])
const skillsDragging = ref(false)

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
      skillsHermesDir.value = r.hermesDir || ''
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
    case 'idle': return `${base}\n技能副本不在（用上面的「⚡ 装到 ${t.name}」）`
    case 'warn': return `${base}\n磁盘上那份与真源不一致 —— 重装即更新（不是"已存在就永远跳过"）`
    default: return `${base}\n副本与真源逐字节一致`
  }
}

/** 状态文案的取值只有三种事实：文件在不在 / 装没装 / 是不是旧的 */
function skillStateText(sk: SkillUiRow): string {
  if (!sk.exists) return '文件缺失'
  const present = skillsTargets.value.filter(t => t.present)
  if (!present.length) return '无可直装目标'
  const states = present.map(t => targetSkillState(t, sk))
  if (states.every(s => s === 'idle')) return '未装'
  if (states.some(s => s === 'warn')) return '有更新'
  return '已装（最新）'
}
function skillStateClass(sk: SkillUiRow): string {
  if (!sk.exists) return 'bad'
  const present = skillsTargets.value.filter(t => t.present)
  if (!present.length) return 'idle'
  const states = present.map(t => targetSkillState(t, sk))
  if (states.every(s => s === 'idle')) return 'idle'
  return states.some(s => s === 'warn') ? 'warn' : 'good'
}

async function copySkillPrompt(sk: SkillUiRow): Promise<void> {
  await props.copy(sk.prompt, `已复制「${sk.id}」安装提示词 —— 粘给 agent 就能自己装`)
}

async function copySkillBody(sk: SkillUiRow): Promise<void> {
  if (!sk.body) { props.toast('这份 SKILL.md 读不出来（文件缺失或为空）', 'error'); return }
  await props.copy(sk.body, `已复制「${sk.id}」SKILL.md 全文（${sk.body.length} 字）`)
}

async function installSkillsToHermes(): Promise<void> {
  const r: any = await window.tegula.skillsInstall()
  if (!r) { props.toast('安装失败：主进程没有返回', 'error'); return }
  const parts: string[] = []
  if (r.installed && r.installed.length) parts.push(`已装 ${r.installed.length}`)
  if (r.skipped && r.skipped.length) parts.push(`跳过 ${r.skipped.length}`)
  if (r.errors && r.errors.length) parts.push(`失败 ${r.errors.length}`)
  props.toast(`技能安装：${parts.join(' / ') || '无变化'}${r.errors && r.errors.length ? '（' + r.errors[0].error + '）' : ''}`,
    r.errors && r.errors.length ? 'error' : 'success')
  await loadSkills()
}

// ── 技能直接导入（2026-09-26 卡 005）──────────────────────────────────────
// 说明：重名时主进程返回 code='exists'，这里**问一句**再带 overwrite 重试；
// 校验类失败（invalid/too-large/reserved）直接报错，绝不静默覆盖。
async function importSkillPath(srcPath: string, overwrite = false): Promise<boolean> {
  const r: any = await window.tegula.skillsImport(srcPath, { overwrite })
  if (!r) { props.toast('导入失败：主进程没有返回', 'error'); return false }
  if (r.ok) {
    props.toast(`已导入「${r.name}」→ ${r.target}（${r.files} 个文件）`, 'success')
    await loadSkills()
    return true
  }
  if (r.code === 'exists') {
    const yes = confirm(`「${r.name}」已经存在。\n\n覆盖 = 用这个包替换掉现在那份；同名旧目录会先备份再替换，失败会还原。\n\n要覆盖吗？`)
    if (!yes) { props.toast(`已取消导入「${r.name}」`, 'info'); return false }
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
  if (!paths.length) { props.toast('没读到拖入的路径 —— 请改用「📥 导入技能…」按钮', 'error'); return }
  let ok = 0
  for (const p of paths) {
    if (await importSkillPath(p)) ok++
  }
  if (paths.length > 1) props.toast(`拖入 ${paths.length} 个，成功 ${ok} 个`, ok ? 'success' : 'error')
}

async function removeImportedSkill(im: { name: string; dir: string }): Promise<void> {
  if (!confirm(`移除「${im.name}」？\n\n只删这一个目录（${im.dir}），方寸自发布技能不受影响。`)) return
  const r: any = await window.tegula.skillsRemove(im.name)
  if (r && r.ok) {
    props.toast(`已移除「${im.name}」`, 'success')
    await loadSkills()
  } else {
    props.toast(`移除失败：${(r && r.error) || '未知原因'}`, 'error')
  }
}

/**
 * 「装到别的 agent」目标（2026-09-26 用户回执：「技能没找到任何可以安装给 WorkBuddy 的地方，依然只有安装到 Hermes」）
 *
 * 事实（本机查过）：本机只有 ~/.hermes/skills 与 ~/.config/opencode，没有 .claude/.codex/.cursor；
 * WorkBuddy 是打包过的 Electron 应用，技能目录不在 %APPDATA%\WorkBuddy（空的）——**我们不能猜、不能瞎写**。
 * 所以：能直装的只有 Hermes；其余的给「显示 SKILL.md + 打开对方」，用户拖一下即可。
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
/** 还在读（模板靠它区分「检测中」与「真没有」——两个态文案完全不同） */
const agentsLoading = ref(true)
/** 读失败/没通道时的一句人话；空 = 正常 */
const agentsError = ref('')

/** 「已接入」徽章：两个事实都说 true→已接入；都说 false→未接入；一半→部分；有不可知→不可知 */
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
      agentsError.value = '当前主进程没有「检测 agent」这个通道（旧版本）—— 这一块读不到'
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

/** 「⚡ 装到 X」：只对可直装且检测到的目标开（其余走「显示 SKILL.md + 打开对方」） */
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

// ── MCP 接入材料（2026-10-02 卡 002 · A 路线）─────────────────────────
// 方寸只出材料：配置段按本机安装路径动态生成 + 复制 + 打开目标文件。
// 不写任何外部应用的文件 —— 粘贴保存是用户的手。
interface McpEntryUi { id: string; label: string; available: boolean; detail: string; usage: string }
interface McpTargetUi { id: string; name: string; detected: boolean; evidence: string; configPath?: string; howTo: string }
const mcpEntries = ref<McpEntryUi[]>([])
const mcpTargets = ref<McpTargetUi[]>([])
const mcpEntry = ref<string>('A')
const mcpInfoError = ref('')
/** 同 agentsLoading：区分「还在读」与「读到了但为空」 */
const mcpLoading = ref(true)

const mcpEntryDetail = computed(() => {
  const e = mcpEntries.value.find(x => x.id === mcpEntry.value)
  if (!e) return ''
  return e.available ? e.usage : e.detail
})

async function loadMcpInfo(): Promise<void> {
  mcpLoading.value = true
  try {
    const t: any = window.tegula
    if (typeof t.mcpInfo !== 'function') {
      // ⚠ 这里原来是 `mcpInfoError.value = ''` —— 于是通道不存在时界面永远停在「检测中…」。
      //   那不是检测中，是根本读不到。必须说出来。
      mcpEntries.value = []
      mcpTargets.value = []
      mcpInfoError.value = '当前主进程没有「MCP 接入信息」这个通道（旧版本）—— 这一块读不到'
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

async function openMcpConfig(m: McpTargetUi): Promise<void> {
  const t: any = window.tegula
  if (typeof t.mcpOpenConfig !== 'function') { props.toast('当前主进程是旧版本，没有这个通道', 'error'); return }
  const r: any = await t.mcpOpenConfig(m.id)
  if (r && r.ok) props.toast(r.message || `已打开 ${m.name} 的配置文件`, 'success')
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

// 进页面就加载三份：技能清单 / 别的 agent 的检测结果 / MCP 接入材料。
// ⚠ 三份都是这一页的全部内容，缺哪个界面上就有一块是空的（"装到别的 agent" 会永远停在「检测中…」）。
onMounted(() => {
  void loadSkills()
  void loadAgents()
  void loadMcpInfo()
})
</script>
