<!--
  服务 / 端口页（2026-10-23 · 拆分第 1 批第 5 块）

  **为什么这块好拆**（量过依赖才定的）：引用全在本页 —— 模板 85 行 + 脚本 118 行，
  零弹窗、零跨视图状态、唯一的外部能力是 `showToast`。对比一下 trash：视图看起来只有
  64 行，但它还挂着「按日期清理」和「正文预览」两个弹窗、批量选择状态还散在别处 ——
  那是完整功能块，不是一块视图。

  **它自己加载数据**：`onMounted` 里调 `loadServices()`（原来父组件 `loadViewData('services')`
  负责，改完那处调用要删掉，否则切页会拉两遍）。

  ⚠ 只读监控：本页只告诉你在不在、谁占着，**不结束任何进程**。启动应用去「启动台」页 ——
    这条边界是用户 2026-10-16 第 2 条定死的，别顺手加"启动"按钮。
-->
<template>
  <main id="board" class="services-view">
    <div class="services-header">
      <h3>服务 / 端口</h3>
      <span v-if="!servicesLoading" class="services-stats">
        登记 {{ servicesRows.length }} · 监听中 {{ servicesListening }}
      </span>
      <button class="skills-btn" @click="copyServicesSnapshot()" title="把当前清单复制成纯文本 —— 方便直接贴给 Hermes 分析">📋 复制快照</button>
      <button class="skills-btn" @click="loadServices()">刷新</button>
    </div>
    <div class="services-notebar">
      只读监控：这里只告诉你在不在、谁占着，<b>不会结束任何进程</b>。
      这里是<b>端口</b>的地盘（谁在监听、谁占着）；<b>启动应用请去「启动台」页</b> ——
      那是快捷入口，跟端口没有关系。方寸自己扫监听表，把没人认领的列在下面，你点「＋ 登记」只是给它起个名字。
    </div>

    <!-- ⚠ 2026-10-16 用户第 2 条：原来这里有一块「启动台应用（▶ 启动）」分区 —— 已整块删掉。
         用户原话：「启动台还是被端口这种东西束缚住了。万一用户使用的某个应用根本没有端口呢？
         这玩意本质是类似 steam 启动非 steam 游戏的快捷启动入口，方寸本身不提供服务，
         只提供集成快捷入口。」
         → 应用列表搬回「启动台」页（那才是它的家），启动也不再挂着"观测端口"的使命；
           本页回归纯粹的端口监控：只在监听、只读、不杀进程。 -->

    <div v-if="servicesError" class="skills-error">{{ servicesError }}</div>
    <div v-else-if="servicesLoading" class="empty-state"><div class="empty-text">探测中…</div></div>
    <template v-else>
      <div v-if="servicesDuplicates.length" class="services-warn">
        ⚠ 这几个端口被登记了多次（真冲突，先合并）：{{ servicesDuplicates.join('、') }}
      </div>
      <div v-if="!servicesRows.length" class="empty-state">
        <div class="empty-icon">🔌</div>
        <div class="empty-text">还没有"已登记"的端口 —— 下面「方寸扫到的」里点「＋ 登记」就能认领一个，
          不用手敲端口号</div>
      </div>
      <div v-else class="svc-group svc-group-manual">
        <div class="svc-group-title">已登记（{{ servicesRows.length }}）<span class="svc-group-hint">这些是你从「方寸扫到的」里认领过的 —— 端口号由方寸填，你只给它起了个名字</span></div>
        <div class="services-list">
          <div v-for="s in servicesRows" :key="s.id" class="svc-item">
            <div class="svc-main">
              <div class="svc-line1">
                <span class="svc-name">{{ s.name }}</span>
                <span class="svc-port">:{{ s.port }}</span>
                <span class="svc-state" :class="s.listening ? 'on' : 'off'">{{ s.listening ? '监听中' : '空闲' }}</span>
                <span v-if="s.duplicated" class="svc-dup">重复登记</span>
                <span class="svc-src">你认领的</span>
              </div>
              <div class="svc-line2">
                <span v-if="s.listening">占用者 PID {{ s.pid }} · {{ s.processName }}</span>
                <span v-else>没有进程在监听</span>
                <span v-if="s.note">· {{ s.note }}</span>
              </div>
            </div>
            <div class="svc-actions">
              <button class="skills-btn" @click="openService(s)" :disabled="!s.listening"
                      :title="s.listening ? '在浏览器打开 http://127.0.0.1:' + s.port : '现在没人监听，打开会报错'">🌐 打开地址</button>
              <button class="skills-btn danger" @click="removeService(s)">🗑 取消登记</button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="servicesUnregistered.length || servicesHidden" class="services-unreg">
        <div class="services-unreg-title">
          方寸扫到的：没人认领、但正在监听（{{ servicesUnregistered.length }}）
          <span class="services-unreg-hint">
            你<span>不需要知道端口号</span> —— 这是方寸自己扫出来的。点「＋ 登记」只是给它起个名字，
            端口号由方寸带着填。只列像服务/开发进程的（node·python·java…）；另有 {{ servicesHidden }} 个
            端口在监听但不像是服务（系统组件、聊天软件等），已略过 —— 不做全盘扫描
          </span>
        </div>
        <div v-for="u in servicesUnregistered" :key="u.port" class="svc-item small">
          <div class="svc-main">
            <div class="svc-line1">
              <span class="svc-port">:{{ u.port }}</span>
              <span class="svc-name">{{ u.processName }}</span>
              <span class="svc-state on">监听中</span>
              <span class="svc-src">PID {{ u.pid }}</span>
            </div>
          </div>
          <div class="svc-actions">
            <button class="skills-btn" @click="adoptService(u)">＋ 登记</button>
          </div>
        </div>
      </div>
    </template>
  </main>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface ServiceRowUi {
  id: string; name: string; port: number; note: string; project: string
  source: 'launchpad' | 'manual'
  /** 启动命令（手填登记为空）—— 与 port 是两回事，见 shared/launchpadDiag.ts */
  cmd: string
  listening: boolean; pid: number | null; processName: string; duplicated: boolean
}

/** `toast(msg, type?)` 由父组件注入：它是全站的提示条状态，不属于本页 */
const props = defineProps<{ toast: (msg: string, type?: 'success' | 'error' | 'info') => void }>()

const servicesRows = ref<ServiceRowUi[]>([])
const servicesUnregistered = ref<{ port: number; pid: number | null; processName: string }[]>([])
const servicesLoading = ref(false)
const servicesError = ref('')
const servicesDuplicates = ref<number[]>([])
const servicesListening = ref(0)
const servicesIdle = ref(0)
const servicesHidden = ref(0)
/* ⚠ 2026-10-16（用户第 2 条）删掉了这一组：
     `serviceStartingApp` / `AppPortRowUi` / `servicesApps` / `startAppRow` ——
   它们服务于服务页那块「启动台应用（▶ 启动 + 观测端口）」分区。那块已整块移走：
   启动应用回「启动台」页，本页只管端口。留着就是死代码（守卫会报"定义但零引用"）。 */

async function loadServices(): Promise<void> {
  servicesLoading.value = true
  servicesError.value = ''
  try {
    const r: any = await window.tegula.servicesList()
    if (!r) {
      servicesError.value = '读取服务状态失败：主进程没有返回'
      servicesRows.value = []
    } else {
      servicesRows.value = r.rows || []
      servicesUnregistered.value = r.unregistered || []
      servicesDuplicates.value = r.duplicatePorts || []
      servicesListening.value = r.listeningCount || 0
      servicesIdle.value = r.idleCount || 0
      servicesHidden.value = r.hiddenCount || 0
      // ok=false 时（比如 services.json 坏了）照样显示已解析的部分，但把原因摆在上面
      if (r.ok === false && r.error) servicesError.value = r.error
    }
  } catch (e: any) {
    servicesError.value = '读取服务状态失败：' + (e?.message || e)
    servicesRows.value = []
  } finally {
    servicesLoading.value = false
  }
}

/**
 * ⚠ 2026-10-15 **删掉了「手敲名字 + 手敲端口」的登记框**。
 *
 * 为什么删：暮雨原话「端口永远是记不住的，不要指望根据端口去配置。你永远不知道用户有什么端口。」
 * 一个要求用户"先知道端口号再登记"的输入框，正是把端口当配置项的老毛病。
 * 现在唯一的登记路径是下面那段「方寸扫到的」里点「＋ 登记」——**端口号由方寸带着填**，
 * 用户最多给它起个名字。
 */

/* ⚠ 2026-10-16（用户第 2 条）：原先这里的 `startAppRow`（启动应用 + 观测端口）
   已随服务页那块「启动台应用」分区一起删掉 —— **启动应用去「启动台」页**
   （那边走 `launchpadLaunchApp`，见 `launchAppClick`），本页只做端口监控。
   ⚠ 主进程的 `startAppAndObserve`（`services/portRegistry.ts`）**保留**：
   它是"启动一个启动台应用"的实现本体，e2e-ports 仍在测；只是不再有界面/IPC 入口。 */

async function removeService(s: ServiceRowUi): Promise<void> {
  if (!confirm(`取消登记「${s.name}」:${s.port}？\n\n只从手填清单里删掉这一条，不会动任何进程，也不会关掉正在跑的服务。`)) return
  const r: any = await window.tegula.servicesRemove(s.port)
  if (r && r.ok) { props.toast(`已取消登记 :${s.port}`, 'success'); await loadServices() }
  else props.toast(`取消失败：${(r && r.error) || '未知原因'}`, 'error')
}

async function openService(s: ServiceRowUi): Promise<void> {
  const r: any = await window.tegula.servicesOpen(s.port)
  if (r && r.ok) props.toast(`已在浏览器打开 ${r.url}`, 'success')
  else props.toast(`打开失败：${(r && r.error) || '未知原因'}`, 'error')
}

/** 把"未登记但正在监听"的端口登记进手填清单（默认名字取占用它的进程名） */
async function adoptService(u: { port: number; processName: string }): Promise<void> {
  const r: any = await window.tegula.servicesAdopt(u.port, u.processName)
  if (r && r.ok) { props.toast(`已登记 :${u.port}（${u.processName}）`, 'success'); await loadServices() }
  else props.toast(`登记失败：${(r && r.error) || '未知原因'}`, 'error')
}

/**
 * 服务/端口快照（2026-09-26 用户回执：「也没任何导出分析功能，直接复制给你了，懒得搞」）
 * —— 用户只能手抄给我，那就给他一个「📋 复制快照」：纯文本，直接贴给 Hermes 就能分析。
 */
function servicesSnapshotText(): string {
  const lines: string[] = []
  lines.push(`方寸服务/端口快照  ${new Date().toLocaleString()}`)
  lines.push(`登记 ${servicesRows.value.length} · 监听中 ${servicesListening.value} · 空闲 ${servicesIdle.value}`)
  if (servicesError.value) lines.push(`错误：${servicesError.value}`)
  lines.push('')
  lines.push('【已登记（你认领的）】')
  for (const s of servicesRows.value) {
    const state = s.listening ? `监听中 pid=${s.pid} ${s.processName}` : '空闲'
    lines.push(`:${s.port}\t${s.name}\t${state}${s.duplicated ? '\t重复登记' : ''}${s.note ? '\t' + s.note : ''}`)
  }
  if (servicesUnregistered.value.length) {
    lines.push('')
    lines.push(`【未登记但在监听（${servicesUnregistered.value.length}）】`)
    for (const u of servicesUnregistered.value) lines.push(`:${u.port}\t${u.processName}\tpid=${u.pid}`)
  }
  if (servicesHidden.value) {
    lines.push('')
    lines.push(`另有 ${servicesHidden.value} 个监听端口不像服务（系统组件/聊天软件等），已按白名单略过`)
  }
  return lines.join('\n')
}

async function copyServicesSnapshot(): Promise<void> {
  const t: any = window.tegula
  if (typeof t.clipboardWriteText !== 'function') { props.toast('当前主进程是旧版本，没有剪贴板通道', 'error'); return }
  try {
    await t.clipboardWriteText(servicesSnapshotText())
    props.toast('服务快照已复制到剪贴板', 'success')
  } catch (e: any) {
    props.toast(`复制失败：${e?.message || e}`, 'error')
  }
}

// 进页面就探测一次（原来由父组件的 loadViewData 负责，改完那处调用已删）
onMounted(() => { void loadServices() })
</script>
