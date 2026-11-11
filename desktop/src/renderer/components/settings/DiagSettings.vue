<!--
  设置 · 诊断（2026-10-30 App.vue 拆分第七刀）：免责声明 / 诊断日志 / 数据自检 / 技能副本 / 最近活动。
-->
<script setup lang="ts">
import { inject, onMounted, ref } from 'vue'

defineProps<{ active: boolean }>()

// ── 运行态（2026-11-11 卡 task-20261017-002）─────────────────────────────
// 为什么放在诊断页：它是“我现在到底是成品还是源码”的答案，出问题时第一个要看的东西。
const mode = ref<any>(null)
async function loadMode(): Promise<void> {
  try {
    mode.value = await (window as any).tegula.appMode()
  } catch {
    // 诊断页自己不该因为取不到态就报错（那会让人以为整个设置坏了）
    mode.value = null
  }
}
onMounted(loadMode)
const ctx: any = inject('fc-settings')
const {
  appLogFile, openAppLogDir, copyAppLogPath, showAppLogFromSettings, purgeLogs, openDisclaimer, diagSelf, diagSkills, diagActivity, diagBusy, runSelfCheck, checkSkillsCopies, loadDiagActivity, relativeTime,
} = ctx
</script>

<template>
          <!-- 运行态（2026-11-11 卡 20261017-002）：绒花墨坊 13 次试跑都炸在“AI 分不清客户端/开发态”。
               这里把判断依据逐条摊开，不让任何人猜。 -->
          <div class="sect" v-show="active">
            <h4>🧭 运行态（客户端 / 开发）</h4>
            <div class="hint">
              这条不是技术参数，它决定 AI 能不能动源码：客户端态下 AI 只能读数据 / 写数据（受 MCP 写入档位约束），
              改源码必须由你把方寸切到开发态 —— 那一步是人的动作，不是 AI 的。
            </div>
            <div v-if="mode" class="diag-result" :class="mode.mode === 'client' ? 'ok' : 'bad'">
              {{ mode.mode === 'client' ? '客户端态（成品）' : '开发态（源码仓库）' }}
            </div>
            <div v-if="mode" class="hint">{{ mode.summary }}</div>
            <table v-if="mode" class="mode-sig">
              <tr v-for="(s, i) in mode.signals" :key="i">
                <td class="k">{{ s.key }}</td>
                <td class="v">{{ s.value }}</td>
                <td class="n">{{ s.note }}</td>
              </tr>
            </table>
            <div class="sect-btns">
              <button class="ghost font-[inherit]" @click="loadMode">重新检测</button>
            </div>
          </div>
          <div class="sect" v-show="active">
            <h4>⚖ 免责与知情声明</h4>
            <div class="hint">方寸怎么用、你的数据在哪、AI 功能会不会花钱、备份能不能指望 —— 都在这份里说清楚。首次使用前的强制确认也是它；改过条款后下次启动会再弹一次。</div>
            <div class="sect-btns">
              <button class="ghost font-[inherit]" @click="openDisclaimer('view')">查看完整声明</button>
            </div>
          </div>
          <div class="sect" v-show="active">
            <h4>诊断日志</h4>
            <div class="hint logpath">{{ appLogFile || '（未取到日志路径）' }}</div>
            <div class="sect-btns">
              <button class="ghost font-[inherit]" @click="openAppLogDir">打开日志目录</button>
              <button class="ghost font-[inherit]" @click="copyAppLogPath">复制路径</button>
              <button class="ghost font-[inherit]" @click="showAppLogFromSettings">查看最近 200 行</button>
              <button class="ghost font-[inherit]" title="删掉 7 天前的日志文件（不动今天的）" @click="purgeLogs(7)">清理 7 天前</button>
              <button class="ghost font-[inherit]" title="清空全部日志（当天那份也会被清空，之后照常记录）" @click="purgeLogs(0)">清空全部</button>
            </div>
            <!-- 2026-10-17 暮雨第 5 条：原文案写着“报问题时把最后几十行发我即可”——
                 “发我”是谁？用户看不懂代码、也不该被要求发日志。改成人话：你不用读、也不用发。 -->
            <div class="hint">
              这里记录方寸自己的运行痕迹（崩溃、IPC 失败、渲染层异常、启动失败）。
              <b>你不用读它，也不用发给任何人</b> —— 它只在真的出问题时用来倒查。
              按天分文件，只会越来越大，所以给了上面两个清理按钮。
            </div>
          </div>
  
          <!-- 数据自检 + 技能副本检查（2026-10-11，卡 20261006-002 E 组死通道接回）：
               `selfCheck` / `skillsCheck` 两条通道在主进程里一直存在，界面从没有入口。
               它们是最该有入口的一类 —— 数据目录写不了、registry 坏了、技能副本被改坏，
               都只有主动查一次才知道。 -->
          <div class="sect" v-show="active">
            <h4>数据自检</h4>
            <div class="hint">查 task-data 在不在、registry.yaml 能不能解析、任务能不能读出来。动手前先跑一次，比出事后猜省事。</div>
            <div class="sect-btns">
              <button class="ghost font-[inherit]" :disabled="diagBusy" @click="runSelfCheck">运行自检</button>
            </div>
            <div v-if="diagSelf" class="diag-result" :class="diagSelf.ok ? 'ok' : 'bad'">
              {{ diagSelf.ok ? '✅ 一切正常' : '❌ ' + diagSelf.message }}
            </div>
          </div>
  
          <div class="sect" v-show="active">
            <h4>技能副本检查</h4>
            <div class="hint">逐个比对“方寸自带的技能”与“已经装到各 agent 目录里的副本”—— 副本被改坏或落后时会在这里报出来。</div>
            <div class="sect-btns">
              <button class="ghost font-[inherit]" :disabled="diagBusy" @click="checkSkillsCopies">检查技能副本</button>
            </div>
            <div v-if="diagSkills" class="diag-skills">
              <div class="diag-skills-head">
                <b>{{ diagSkills.targetName || diagSkills.targetId || '（未检测到目标）' }}</b>
                <span :class="'diag-tag ' + (diagSkills.needsInstall ? 'bad' : 'ok')">
                  {{ diagSkills.needsInstall ? '有副本需要更新' : '全部一致' }}</span>
              </div>
              <div v-for="s in diagSkills.skills" :key="s.name" class="diag-skill-row">
                <span class="diag-skill-name">{{ s.name }}</span>
                <span class="diag-tag" :class="!s.installed ? 'bad' : (s.outdated ? 'warn' : 'ok')">
                  {{ !s.installed ? '未安装' : (s.outdated ? '副本已过时/被改' : '一致') }}</span>
              </div>
              <div v-if="!diagSkills.skills || !diagSkills.skills.length" class="hint">没有查到可检查的技能（可能本机没有 Hermes/DSH 目录）。</div>
            </div>
          </div>
  
          <div class="sect" v-show="active">
            <h4>最近活动</h4>
            <div class="hint">谁在什么时候改了什么（<code>task-data/.activity.log</code>）。排查“这张卡怎么突然变了”时先看这里。</div>
            <div class="sect-btns">
              <button class="ghost font-[inherit]" @click="loadDiagActivity">刷新活动日志</button>
            </div>
            <div class="diag-act">
              <div v-for="(a, i) in diagActivity" :key="i" class="diag-act-row">
                <span class="diag-act-ts">{{ a.ts ? relativeTime(a.ts) : '—' }}</span>
                <span class="diag-act-action">{{ a.action }}</span>
                <span class="diag-act-tid">{{ a.tid || '—' }}</span>
                <span class="diag-act-detail" :title="String(a.detail || '')">{{ a.detail || '' }}</span>
              </div>
              <div v-if="!diagActivity.length" class="hint">（暂时没有活动记录）</div>
            </div>
          </div>
          <!-- 2026-09-29 用户第 6 条：设置里要能自定义“已完成日志的自动清理” -->
</template>

<style scoped>
.mode-sig { width: 100%; border-collapse: collapse; font-size: 11.5px; margin-top: 6px; }
.mode-sig td { padding: 3px 6px; border-bottom: 1px solid rgba(127,127,127,.14); vertical-align: top; }
.mode-sig .k { white-space: nowrap; opacity: .7; }
.mode-sig .v { word-break: break-all; }
.mode-sig .n { opacity: .7; }
</style>
