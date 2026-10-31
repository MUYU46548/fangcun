<!--
  日志编辑弹窗（2026-10-31 · 渲染层拆分「浮层刀」第二块）

  **边界**：与 `TaskPreview.vue` / `BoardView.vue` 同一套 —— 组件只「显示 + 收集意图」，
  状态与动作留在 App。父组件用 `reactive()` 包一个 `logEditCtl` 传进来，
  组件用 `toRef` 接状态、直接解构接函数。

  ⚠ 弹窗由父组件 `v-if="logEdit_"` 决定挂不挂；组件内部保留同一守卫。
  ⚠ 这个弹窗要能在**任何视图**下打开（从日历点日志也会调 openLog），所以不能放进 LogsView。
  ⚠ 这里**不许**用 Tailwind 工具类（views/ 的同款纪律；样式仍全在 app.css）。
-->
<template>
  <div id="log-edit-overlay" class="overlay" v-if="logEdit_" @mousedown.self="closeLogEditor()">
    <!-- 粘贴图片 / 拖文件成附件（2026-10-25 暮雨第 4 / 7 条）：监听挂在整个弹窗上，
         所以标题 / 内容 / 下一步哪一格粘（或往哪一格拖）都算；只有剪贴板里真有图片时才拦，
         粘文字照常走浏览器默认行为。拖动进入时整块高亮，松手才落。 -->
    <div id="log-edit-modal" :class="{ 'drop-on': logAttachDragOver }"
      @paste="onLogPaste($event)"
      @dragenter.prevent="onLogAttachDragEnter()"
      @dragover.prevent="onLogAttachDragEnter()"
      @dragleave.prevent="onLogAttachDragLeave()"
      @drop.prevent="onLogAttachDrop($event)">
      <h3>{{ logCompleting ? '完成日志' : logArchiveMode ? '归档日志' : logEdit_.id ? '编辑日志' : '新建日志' }}</h3>
      <!-- 已完成的日志也能改（2026-10-18）：此前后端直接拒改，界面却一直给编辑入口。
           现在直说"能改 + 会留痕"，用户不必再复制出来新建一条。 -->
      <div class="hint log-closed-hint" v-if="logEdit_.id && logEdit_.status && logEdit_.status !== 'active'">
        这条已{{ logEdit_.status === 'completed' ? '完成' : '归档' }}。<b>内容仍然可以改</b>（改完点保存即可）；
        改动会在卡面留一个「✎ 改过」戳，不是静默篡改。点错保存就按左下「🕘 历史版本」挑一版恢复。
      </div>
      <label>标题</label>
      <input v-model="logEdit_.title" placeholder="日志标题" />
      <label>项目</label>
      <select v-model="logEdit_.project" class="logsel">
        <option value="">（不归属）</option>
        <!-- 存量日志里可能有没登记在 registry 的项目 id（旧默认值 fangcun-base 等）。
             没有这一项时，select 会显示成第一个选项，用户以为项目是"方寸"却改不动。 -->
        <option v-if="logEdit_.project && !projects.some(p => p.id === logEdit_.project)"
          :value="logEdit_.project">{{ logEdit_.project }}（未在登记表中）</option>
        <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
      </select>
      <!-- 优先级（2026-10-08 卡 001，拍板=新增字段）：值域与任务卡同款中文。
           空 = 不标（默认），历史日志全是这个状态，界面显式写「不标」而不是留白。 -->
      <label>优先级（可选 —— 用来给日志排序）</label>
      <select v-model="logEdit_.priority" class="logsel">
        <option value="">不标</option>
        <option value="高">高</option>
        <option value="中">中</option>
        <option value="低">低</option>
      </select>
      <label>执行内容</label>
      <textarea v-model="logEdit_.content" class="tall font-[inherit]" placeholder="执行内容..."></textarea>
      <label>下一步</label>
      <textarea v-model="logEdit_.nextSteps" placeholder="下一步..."></textarea>
      <!-- 关联任务：2026-09-22 改为「按项目过滤的选择」；2026-09-25（用户第 2 条）
           此前只能关联**一个** ID，需要多个。数据层本来就写 tasks 数组
           （renderLog: tasks: [id]），只是只读了第一个 —— 现在改成多选。
           2026-10-09（用户第 3 条「每次都加载一堆任务让我头疼，于是干脆什么都不选」）：
           索引字段不是**任务浏览器** —— 默认只显示已关联 chips + 按需展开，
           候选带过滤框、按最近更新排序、首屏 12 条。 -->
      <label>关联任务</label>
      <div class="log-task-head">
        <span class="log-task-chips" v-if="logEdit_.taskIds && logEdit_.taskIds.length">
          <span v-for="id in logEdit_.taskIds" :key="id" class="lt-chip" :title="id">
            {{ taskTitleOf(id) || id }}
            <button type="button" class="lt-x" @click.stop="unlinkLogTask(id)" :title="'移除关联：' + id">×</button>
          </span>
        </span>
        <span class="hint" v-else>还没有关联任务（可选，便于日志↔任务互跳）</span>
        <button type="button" class="ghost log-task-toggle" @click.stop="logTaskOpen = !logTaskOpen">
          {{ logTaskOpen ? '收起' : '＋ 关联任务' }}
        </button>
      </div>
      <template v-if="logTaskOpen">
        <input v-model="logTaskQuery" class="log-task-search" placeholder="过滤：任务 id 或标题" />
        <div v-if="logTaskOptions.length" class="log-task-multi">
          <label v-for="t in logTaskOptions" :key="t.id" class="log-task-opt">
            <input type="checkbox" :value="t.id" v-model="logEdit_.taskIds" />
            <span class="lto-id">{{ t.id }}</span>
            <span class="lto-title">{{ t.title || '(无标题)' }}</span>
            <span class="lto-st">{{ t.status }}</span>
          </label>
          <div class="hint" v-if="logTaskMoreHidden">只显示最近更新的 {{ logTaskOptions.length }} 条，输入过滤查看其余</div>
        </div>
        <div v-else class="hint">当前项目下没有匹配的任务 —— 用下面的输入框直接贴 ID</div>
      </template>
      <input v-model="logTaskExtra" placeholder="额外关联 ID（多个用英文逗号 , 分隔，回车加入）" @change="addLogTaskExtra" />
      <!-- 2026-09-23（用户第 1 条）：会话 ID + Agent + 日期 -->
      <label>会话 ID（可选，便于反向查证）</label>
      <input v-model="logEdit_.sessionId" placeholder="如 20260922_183047_334e4a" />
      <!-- 2026-10-03 用户反馈1（卡 task-20261003-001）：这里原来标「上次执行 Agent」、
           接力对话框同一个字段却标「执行 Agent」——一字段两义，用户被绕晕。
           拆两字段：agentName = 本次执行 Agent；prevAgentName = 上次的执行 Agent（接力来源）。
           上次字段只在接力来的日志上出现（没有来源的日志谈不上「上次」）。 -->
      <label>本次执行 Agent（本段由谁执行；可选）</label>
      <select v-model="logEdit_.agentName" class="logsel">
        <option value="">（不指定）</option>
        <option v-for="a in agentPresets" :key="a" :value="a">{{ a }}</option>
      </select>
      <input v-model="logEdit_.agentName" placeholder="或手动输入 Agent 名称" />
      <template v-if="logEdit_.continueFrom">
        <label>上次的执行 Agent（接力来源那段是谁跑的 —— 倒查 / 找回上次会话用）</label>
        <select v-model="logEdit_.prevAgentName" class="logsel">
          <option value="">（不指定）</option>
          <option v-for="a in agentPresets" :key="a" :value="a">{{ a }}</option>
        </select>
        <input v-model="logEdit_.prevAgentName" placeholder="或手动输入上次的执行 Agent" />
      </template>
      <label>日志日期（默认创建日期）</label>
      <input v-model="logEdit_.logDate" type="date" />
      <template v-if="logCompleting || logArchiveMode">
        <label v-if="logCompleting">保留天数（0=永不）</label>
        <input v-if="logCompleting" v-model="logRetainDays" :placeholder="String(logRetainDefault)" />
        <div class="hint" v-if="logCompleting">默认 {{ logRetainDefault }} 天（可在设置 → 日志清理里改；0=永不）。到期后，点日志页的「清理超期」会把它标为「已归档」（只改状态，不删文件）。</div>
        <label>备注（可选）</label>
        <textarea v-model="logNote" placeholder="备注..."></textarea>
      </template>
      <!-- 附件（2026-10-01 用户第 1 条 → 卡 036）：与只读预览同一套入口。
           2026-10-25（暮雨第 4 / 7 条）两处改：
             ① 新建态**不再禁用** —— 可以先选文件/粘贴截图，存好日志时一起挂上
                （之前是「先创建这条日志，再回来挂附件」，为了加张图要建两次）；
             ② 支持直接粘贴截图（Ctrl+V），详见 onLogPaste。 -->
      <div class="attach-block" data-attach-block>
        <div class="attach-head">
          <label class="attach-lbl">附件</label>
          <span class="attach-head-r">
            <span class="attach-paste-hint" title="在弹窗任意位置按 Ctrl+V 粘贴截图，直接变成这条日志的附件">Ctrl+V 粘图</span>
            <button class="ghost attach-add"
              :title="logEdit_.id
                ? '从本机选文件；文件会复制进数据目录（随日志一起备份），源文件不动'
                : '还没保存也能先选：文件会在保存这条日志时一起挂上（源文件不动）'"
              @click="attachPickOrAdd()">＋ 添加文件…</button>
          </span>
        </div>
        <!-- 新建态的待挂清单（还没落盘，所以真的"待"） -->
        <div v-if="!logEdit_.id && logPendingCount" class="attach-pending">
          <span class="attach-pending-lbl">待挂 {{ logPendingCount }} 个</span>
          <span class="attach-pending-item" v-for="(p, i) in logPendingPaths" :key="'pp' + i">
            📄 {{ pendingBaseName(p) }}
            <button class="attach-x" title="不挂了" @click="logPendingPaths.splice(i, 1)">✕</button>
          </span>
          <span class="attach-pending-item" v-for="(p, i) in logPendingData" :key="'pd' + i">
            🖼 {{ p.name }}
            <button class="attach-x" title="不挂了" @click="logPendingData.splice(i, 1)">✕</button>
          </span>
          <span class="attach-pending-tip">保存这条日志时会一起挂上</span>
        </div>
        <div v-if="!logEdit_.attachments || !logEdit_.attachments.length" class="attach-empty">
          {{ logEdit_.id ? '还没有附件 —— 截图、报告、日志文件都可以选 / 拖 / 直接 Ctrl+V 粘上来' : '还没保存也能先选文件、拖进来或粘图，保存时一起挂上' }}
        </div>
        <div v-else class="attach-grid">
          <div class="attach-item" v-for="a in logEdit_.attachments" :key="a">
            <img v-if="isImageRel(a) && attachSrc(a)" :src="attachSrc(a)" :alt="attachName(a)"
              :title="attachName(a) + ' · ' + attachOpenHint(a)" @click.stop="attachOpen(a)" />
            <div v-else class="attach-file" :title="a + ' · ' + attachOpenHint(a)" @click.stop="attachOpen(a)">📄 {{ attachName(a) }}</div>
            <div class="attach-cap">
              <span class="attach-fn" :title="a">{{ attachName(a) }}</span>
              <button class="attach-x" title="解除关联（文件保留，不删）"
                @click.stop="attachRemove(logEdit_.id, a)">✕</button>
            </div>
          </div>
        </div>
      </div>
      <!-- 关闭防丢警告条（2026-10-03 卡 task-20261003-005）：与接力对话框**同一套实现**
           （同 .relay-discard 样式、同交互：点取消/遮罩先出条不关，必须点「丢弃并关闭」）。
           此前这里是原生 window.confirm —— 用户点名「创建日志和日志接力用了两种实现」，统一到条子。 -->
      <div v-if="logDiscard_" class="relay-discard" role="alertdialog" aria-live="polite">
        <span class="rd-text">⚠ 这次的改动还没保存，关掉就没了：<b>{{ logDirtyNames().join('、') || '表单改动' }}</b></span>
        <span class="rd-acts">
          <button class="ghost" @click="logDiscard_ = false">继续填写</button>
          <button class="danger" @click="discardLogEdit">丢弃并关闭</button>
        </span>
      </div>
      <!-- 历史版本（2026-10-18 卡 001；2026-10-31 收口）：从"只能退一步"扩到
           "看见列表 + 逐版预览 + 恢复任意一版"。接的仍是 atomicWrite 既有的 .backup，
           不是新造一套撤销机制；恢复前会把当前版再备份一次，撤错了还能再恢复回来。 -->
      <div v-if="logEdit_.id" class="ver-sect">
        <button class="ghost ver-toggle" @click="toggleLogHistory">
          🕘 历史版本<span v-if="logVersions.length"> · {{ logVersions.length }}</span>
        </button>
        <div v-if="logHistoryOpen" class="ver-panel">
          <div class="ver-head">
            <b>这条日志的历史版本</b>
            <span class="ver-sub">本机最近 10 版；恢复前会把当前版再备份一次</span>
            <button class="ver-x" title="收起" @click="logHistoryOpen = false">×</button>
          </div>
          <div v-if="logVersionBusy" class="ver-empty">读取中…</div>
          <div v-else-if="!logVersions.length" class="ver-empty">没有历史版本（本机只留最近 10 版，更早的要靠整包备份）</div>
          <div v-else class="ver-list">
            <div v-for="v in logVersions" :key="v.file" class="ver-row" :class="{ on: logVersionPreview?.file === v.file }">
              <button class="ver-main" @click="previewLogVersion(v)">
                <span class="ver-title">{{ v.title || '(无标题)' }}</span>
                <span class="ver-meta">{{ v.at ? formatDateTime(v.at) : '时间不详' }} · {{ versionSizeText(v.size) }} · {{ v.status === 'completed' ? '已完成' : v.status === 'archived' ? '已归档' : '待处理' }}</span>
              </button>
              <button class="ver-restore" @click="restoreLogVersionItem(v)">恢复</button>
            </div>
          </div>
          <pre v-if="logVersionPreview" class="ver-preview">{{ logVersionPreview.content }}</pre>
          <div v-if="logVersionPreview && logVersionPreview.nextSteps" class="ver-next">
            <b>下一步</b>
            <pre class="ver-preview">{{ logVersionPreview.nextSteps }}</pre>
          </div>
        </div>
      </div>
      <div class="acts">
        <button class="ghost" @click="closeLogEditor">取消</button>
        <button v-if="logEdit_.id" class="ghost" title="只复制日志 ID —— 贴给 AI 用来定位这一条" @click="copyId(logEdit_.id)">⧉ ID</button>
        <button v-if="logEdit_.id" class="ghost" title="复制成可直接粘给 agent 的提示词块" @click="copyLogAsPrompt(logEdit_.id)">📋 复制为提示词</button>
        <button v-if="logEdit_.id && !logCompleting && !logArchiveMode" class="danger" title="彻底删除这条日志（不可撤销）" @click="destroyLogItem(logEdit_.id); closeLogNow()">彻底删除</button>
        <!-- 2026-10-17 用户报障：完成/归档弹窗此前唯一的确认按钮不保存表单字段——补「保存修改」：
             只存内容、不碰状态。改完其实不想完成/归档的人有路可走，不用在「确认完成」和「丢弃」里二选一。 -->
        <button v-if="logCompleting || logArchiveMode" class="ghost" title="只保存表单里改的内容，不改变完成/归档状态" @click="saveLogFieldsOnly">保存修改</button>
        <!-- 主按钮 dirty 感知（2026-10-17）：表单改过了就别叫「确认完成」，叫「保存并完成」——
             字面即承诺：点了它内容会先落盘（回写在 saveLogEdit 完成分支）。 -->
        <button class="pri" @click="saveLogEdit">{{ logCompleting ? (logEditDirty() ? '保存并完成' : '确认完成') : logArchiveMode ? (logEditDirty() ? '保存并归档' : '确认归档') : logEdit_.id ? '保存' : '创建' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { formatDateTime } from '../../shared/time'

/**
 * 唯一 prop：日志编辑控制器（父组件用 `reactive()` 包过的那一坨）。
 * 状态 → toRef；动作 → 直接解构。与 BoardView / TaskPreview 同一套。
 */
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl

// ── 状态 ──────────────────────────────────────────────────────────────
const logEdit_ = toRef(ctl, 'logEdit_')
const logCompleting = toRef(ctl, 'logCompleting')
const logArchiveMode = toRef(ctl, 'logArchiveMode')
const logRetainDays = toRef(ctl, 'logRetainDays')
const logRetainDefault = toRef(ctl, 'logRetainDefault')
const logNote = toRef(ctl, 'logNote')
const logTaskOpen = toRef(ctl, 'logTaskOpen')
const logTaskQuery = toRef(ctl, 'logTaskQuery')
const logTaskOptions = toRef(ctl, 'logTaskOptions')
const logTaskMoreHidden = toRef(ctl, 'logTaskMoreHidden')
const logTaskExtra = toRef(ctl, 'logTaskExtra')
const projects = toRef(ctl, 'projects')
const agentPresets = toRef(ctl, 'agentPresets')
const logAttachDragOver = toRef(ctl, 'logAttachDragOver')
const logPendingCount = toRef(ctl, 'logPendingCount')
const logPendingPaths = toRef(ctl, 'logPendingPaths')
const logPendingData = toRef(ctl, 'logPendingData')
const logDiscard_ = toRef(ctl, 'logDiscard_')
const logVersions = toRef(ctl, 'logVersions')
const logHistoryOpen = toRef(ctl, 'logHistoryOpen')
const logVersionBusy = toRef(ctl, 'logVersionBusy')
const logVersionPreview = toRef(ctl, 'logVersionPreview')

// ── 动作 ──────────────────────────────────────────────────────────────
const {
  closeLogEditor, closeLogNow, discardLogEdit, logDirtyNames, logEditDirty,
  onLogPaste, onLogAttachDragEnter, onLogAttachDragLeave, onLogAttachDrop,
  taskTitleOf, unlinkLogTask, addLogTaskExtra,
  attachPickOrAdd, pendingBaseName, isImageRel, attachSrc, attachName, attachOpenHint, attachOpen, attachRemove,
  toggleLogHistory, previewLogVersion, restoreLogVersionItem, versionSizeText,
  copyId, copyLogAsPrompt, destroyLogItem, saveLogFieldsOnly, saveLogEdit,
} = ctl
</script>
