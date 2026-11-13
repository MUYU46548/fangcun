<!--
  日志编辑弹窗（2026-10-31 · 渲染层拆分“浮层刀”第二块）

  **边界**：与 `TaskPreview.vue` / `BoardView.vue` 同一套 —— 组件只“显示 + 收集意图”，
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
        改动会在卡面留一个“✎ 改过”戳，不是静默篡改。点错保存就按左下“🕘 历史版本”挑一版恢复。
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
           空 = 不标（默认），历史日志全是这个状态，界面显式写“不标”而不是留白。 -->
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
      <!-- 关联任务：2026-09-22 改为“按项目过滤的选择”；2026-09-25（用户第 2 条）
           此前只能关联**一个** ID，需要多个。数据层本来就写 tasks 数组
           （renderLog: tasks: [id]），只是只读了第一个 —— 现在改成多选。
           2026-10-09（用户第 3 条“每次都加载一堆任务让我头疼，于是干脆什么都不选”）：
           索引字段不是**任务浏览器** —— 默认只显示已关联 chips + 按需展开，
           候选带过滤框、按最近更新排序、首屏 12 条。 -->
      <label>关联任务</label>
      <!-- 2026-11-13 暮雨拍板："应该把日志窗口做宽，或者旁边单独挂一个展开的面板，
           里面可以按项目按状态等筛选（都不用抄别人，抄方寸自己就有）"。
           于是这里**只留摘要**（选了哪几张 + 摘除），挑选动作搬到右侧独立面板：
           关联任务需要"一次看几十行 + 多维度收窄"，塞在表单流里只能拿到 420px 高（实测只看得见 7 行）。 -->
      <div class="log-task-head">
        <span class="log-task-chips" v-if="logEdit_.taskIds && logEdit_.taskIds.length">
          <span class="lt-picked-n">{{ logEdit_.taskIds.length }} 张</span>
          <span v-for="id in logEdit_.taskIds" :key="id" class="lt-chip" :title="id">
            {{ taskTitleOf(id) || id }}
            <button type="button" class="lt-x" @click.stop="unlinkLogTask(id)" :title="'移除关联：' + id">×</button>
          </span>
        </span>
        <span class="hint" v-else>还没有关联任务（可选，便于日志↔任务互跳）</span>
        <Button type="button" class="log-task-toggle" variant="ghost" size="sm"
          :title="logTaskPanelOpen ? '收起右侧面板' : '在右侧展开挑选面板（可按项目 / 状态 / 优先级 / 标签筛）'"
          @click.stop="logTaskPanelOpen = !logTaskPanelOpen">
          {{ logTaskPanelOpen ? '收起面板' : '＋ 关联任务' }}
        </Button>
      </div>
      <input v-model="logTaskExtra" placeholder="额外关联 ID（多个用英文逗号 , 分隔，回车加入）" @change="addLogTaskExtra" />
      <!-- 2026-09-23（用户第 1 条）：会话 ID + Agent + 日期 -->
      <label>会话 ID（可选，便于反向查证）</label>
      <input v-model="logEdit_.sessionId" placeholder="如 20260922_183047_334e4a" />
      <!-- 2026-10-03 用户反馈1（卡 task-20261003-001）：这里原来标“上次执行 Agent”、
           接力对话框同一个字段却标“执行 Agent”——一字段两义，用户被绕晕。
           拆两字段：agentName = 本次执行 Agent；prevAgentName = 上次的执行 Agent（接力来源）。
           上次字段只在接力来的日志上出现（没有来源的日志谈不上“上次”）。 -->
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
        <div class="hint" v-if="logCompleting">默认 {{ logRetainDefault }} 天（可在设置 → 日志清理里改；0=永不）。到期后，点日志页的“清理超期”会把它标为“已归档”（只改状态，不删文件）。</div>
        <label>备注（可选）</label>
        <textarea v-model="logNote" placeholder="备注..."></textarea>
      </template>
      <!-- 附件（2026-10-01 用户第 1 条 → 卡 036）：与只读预览同一套入口。
           2026-10-25（暮雨第 4 / 7 条）两处改：
             ① 新建态**不再禁用** —— 可以先选文件/粘贴截图，存好日志时一起挂上
                （之前是“先创建这条日志，再回来挂附件”，为了加张图要建两次）；
             ② 支持直接粘贴截图（Ctrl+V），详见 onLogPaste。 -->
      <div class="attach-block" data-attach-block>
        <div class="attach-head">
          <label class="attach-lbl">附件</label>
          <span class="attach-head-r">
            <span class="attach-paste-hint" title="在弹窗任意位置按 Ctrl+V 粘贴截图，直接变成这条日志的附件">Ctrl+V 粘图</span>
            <Button class="attach-add" variant="ghost" size="sm"
              :title="logEdit_.id
                ? '从本机选文件；文件会复制进数据目录（随日志一起备份），源文件不动'
                : '还没保存也能先选：文件会在保存这条日志时一起挂上（源文件不动）'"
              @click="attachPickOrAdd()">＋ 添加文件…</Button>
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
           （同 .relay-discard 样式、同交互：点取消/遮罩先出条不关，必须点“丢弃并关闭”）。
           此前这里是原生 window.confirm —— 用户点名“创建日志和日志接力用了两种实现”，统一到条子。 -->
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
        <Button class="ver-toggle" variant="ghost" size="sm" @click="toggleLogHistory">
          🕘 历史版本<span v-if="logVersions.length"> · {{ logVersions.length }}</span>
        </Button>
        <div v-if="logHistoryOpen" class="ver-panel">
          <div class="ver-head">
            <b>这条日志的历史版本</b>
            <span class="ver-sub">本机最近 10 版；恢复前会把当前版再备份一次</span>
            <Button class="ver-x" variant="ghost" size="sm" title="收起" @click="logHistoryOpen = false">×</Button>
          </div>
          <div v-if="logVersionBusy" class="ver-empty">读取中…</div>
          <div v-else-if="!logVersions.length" class="ver-empty">没有历史版本（本机只留最近 10 版，更早的要靠整包备份）</div>
          <div v-else class="ver-list">
            <div v-for="v in logVersions" :key="v.file" class="ver-row" :class="{ on: logVersionPreview?.file === v.file }">
              <button class="ver-main" @click="previewLogVersion(v)">
                <span class="ver-title">{{ v.title || '(无标题)' }}</span>
                <span class="ver-meta">{{ v.at ? formatDateTime(v.at) : '时间不详' }} · {{ versionSizeText(v.size) }} · {{ v.status === 'completed' ? '已完成' : v.status === 'archived' ? '已归档' : '待处理' }}</span>
              </button>
              <Button class="ver-restore" variant="ghost" size="sm" @click="restoreLogVersionItem(v)">恢复</Button>
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
        <!-- 2026-10-17 用户报障：完成/归档弹窗此前唯一的确认按钮不保存表单字段——补“保存修改”：
             只存内容、不碰状态。改完其实不想完成/归档的人有路可走，不用在“确认完成”和“丢弃”里二选一。 -->
        <button v-if="logCompleting || logArchiveMode" class="ghost" title="只保存表单里改的内容，不改变完成/归档状态" @click="saveLogFieldsOnly">保存修改</button>
        <!-- 主按钮 dirty 感知（2026-10-17）：表单改过了就别叫“确认完成”，叫“保存并完成”——
             字面即承诺：点了它内容会先落盘（回写在 saveLogEdit 完成分支）。 -->
        <button class="pri" @click="saveLogEdit">{{ logCompleting ? (logEditDirty() ? '保存并完成' : '确认完成') : logArchiveMode ? (logEditDirty() ? '保存并归档' : '确认归档') : logEdit_.id ? '保存' : '创建' }}</button>
      </div>
    </div>
    <!-- ══ 右侧独立挑选面板（2026-11-13 暮雨拍板）═══════════════════════════
         与左侧表单**并排**，不塞在表单流里。筛选维度抄的是方寸自己的 LogAttachModal
         （搜索 / 项目 / 状态 / 优先级 / 日期那一套），暮雨原话："都不用抄别人，抄方寸自己就有"。
         面板是 flex 兄弟节点 → 弹窗整体变宽，左侧表单宽度不变。
         ⚠ 遮罩关闭只用 @mousedown.self（拖选滑出面板不许当"点了遮罩"，见 check-ui-freeze）。 -->
    <div id="log-task-panel" v-if="logTaskPanelOpen">
      <div class="ltp-head">
        <b>挑选关联任务</b>
        <span class="ltp-count">{{ logTaskTotal }} 张候选</span>
        <span v-if="logTaskFilterCount" class="ltp-fcount">{{ logTaskFilterCount }} 层筛选</span>
        <span class="ltp-grow"></span>
        <Button variant="ghost" size="sm" @click="clearLogTaskFilters">清空筛选</Button>
        <Button variant="ghost" size="sm" @click="logTaskPanelOpen = false">收起</Button>
      </div>
      <div class="ltp-searchrow">
        <input v-model="logTaskQuery" class="log-task-search ltp-search"
          placeholder="搜 id / 标题 / 项目名 / 标签 / 状态 —— 空格分词，都要命中"
          @keydown.enter.prevent="pickFirstLogTask" />
      </div>
      <!-- 第一层：范围（本项目 / 全部项目）-->
      <div class="ltp-frow">
        <span class="ltp-flbl">范围</span>
        <div class="log-task-seg" :title="logTaskQuery.trim()
          ? '搜索时自动在全部项目里找（删掉搜索词就回到你原来选的范围）'
          : '候选范围：本项目 / 全部项目'">
          <button type="button" class="lts" :class="{ on: logTaskScope === 'proj' && !logTaskQuery.trim() }"
            @click="logTaskScope = 'proj'">本项目</button>
          <button type="button" class="lts" :class="{ on: logTaskScope === 'all' || !!logTaskQuery.trim() }"
            @click="logTaskScope = 'all'">全部项目</button>
          <span v-if="logTaskQuery.trim() && logTaskScope === 'proj'" class="log-task-scope-note">按词全项目找</span>
        </div>
      </div>
      <!-- 第二层：三档（扫一眼的口径）-->
      <div class="ltp-frow">
        <span class="ltp-flbl">档位</span>
        <div class="log-task-statusbar">
          <button type="button" class="lts" :class="{ on: logTaskStatus === 'open' }" @click="logTaskStatus = 'open'">未完成</button>
          <button type="button" class="lts" :class="{ on: logTaskStatus === 'all' }" @click="logTaskStatus = 'all'">全部</button>
          <button type="button" class="lts" :class="{ on: logTaskStatus === 'done' }" @click="logTaskStatus = 'done'">已完成 / 驳回</button>
        </div>
      </div>
      <!-- 第三层：精确状态多选（"盯着待验收那几张"的口径）-->
      <div class="ltp-frow ltp-frow-wrap" v-if="logTaskFacets.statuses.length">
        <span class="ltp-flbl">状态</span>
        <div class="ltp-chips">
          <button v-for="s in logTaskFacets.statuses" :key="'lts-' + s" type="button" class="ltp-chip"
            :class="{ on: logTaskStatuses.includes(s) }" @click="toggleStatus(s)">{{ s }}</button>
        </div>
      </div>
      <!-- 第四层：优先级 -->
      <div class="ltp-frow ltp-frow-wrap" v-if="logTaskFacets.priorities.length || logTaskFacets.anyNoPrio">
        <span class="ltp-flbl">优先级</span>
        <div class="ltp-chips">
          <button v-for="p in logTaskFacets.priorities" :key="'ltp-' + p" type="button" class="ltp-chip"
            :class="{ on: logTaskPrios.includes(p) }" @click="togglePrio(p)">{{ p }}</button>
          <button v-if="logTaskFacets.anyNoPrio" type="button" class="ltp-chip"
            :class="{ on: logTaskPrios.includes('__none__') }" @click="togglePrio('__none__')">未标</button>
        </div>
      </div>
      <!-- 第五层：标签（多选 = AND）-->
      <div class="ltp-frow ltp-frow-wrap" v-if="logTaskFacets.tags.length">
        <span class="ltp-flbl">标签</span>
        <div class="ltp-chips ltp-tags">
          <button v-for="g in logTaskFacets.tags.slice(0, 40)" :key="'ltg2-' + g" type="button" class="ltp-chip"
            :class="{ on: logTaskTags.includes(g) }" @click="toggleTag(g)">{{ g }}</button>
          <span v-if="logTaskFacets.tags.length > 40" class="ltp-more">还有 {{ logTaskFacets.tags.length - 40 }} 个标签（用搜索词）</span>
        </div>
      </div>
      <!-- 候选：面板里一律平铺（不分组）—— 面板够高，分组反而多一层要点的东西 -->
      <div class="ltp-list">
        <template v-if="logTaskFlat.length">
          <label v-for="(t, i) in logTaskFlat" :key="'ltpf-' + t.id" class="log-task-opt"
            :class="{ picked: (logEdit_.taskIds || []).includes(t.id), first: i === 0 && logTaskQuery.trim() }">
            <input type="checkbox" :value="t.id" v-model="logEdit_.taskIds" />
            <span v-if="logTaskQuery.trim()" class="lto-hit" :title="'命中字段：' + hitFieldName(t)">{{ hitFieldName(t) }}</span>
            <span class="lto-title">{{ t.title || '(无标题)' }}</span>
            <span v-if="t.priority" class="lto-prio" :class="'lp-' + prioKey(t.priority)">{{ t.priority }}</span>
            <span class="lto-st">{{ t.status }}</span>
            <span class="lto-proj">{{ projectNameOf(t.project) }}</span>
            <span class="lto-id">#{{ t.id }}</span>
          </label>
        </template>
        <div v-else class="ltp-empty">
          <b>没有匹配的卡。</b>
          <div v-if="logTaskFilterCount">现在是 {{ logTaskFilterCount }} 层筛选叠加的结果 ——
            点右上「清空筛选」看全部，或逐层放开刚才点的那一个。</div>
          <div v-else>池子里本来就没有卡？先确认「本项目 / 全部项目」这一档。</div>
        </div>
      </div>
      <div class="ltp-foot">
        <span class="ltp-picked">已选 {{ (logEdit_.taskIds || []).length }} 张</span>
        <span v-if="logTaskMoreHidden" class="ltp-more">
          还有 {{ logTaskTotal - logTaskFlat.length }} 张没显示（用上面的筛选收窄）
        </span>
        <span class="ltp-grow"></span>
        <Button variant="ghost" size="sm" @click="logTaskPanelOpen = false">选好，收起</Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { formatDateTime } from '../../shared/time'
// U1=A（2026-11-11）：手搓按钮逐步换到 ui 基座；本文件迁历史版本三件 + 关联任务两件
import Button from './ui/Button.vue'

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
// 候选的范围 / 状态 / 展开 / 总数（2026-11-05 第 11 条）
const logTaskScope = toRef(ctl, 'logTaskScope')
const logTaskOpenOnly = toRef(ctl, 'logTaskOpenOnly')
const logTaskShowAll = toRef(ctl, 'logTaskShowAll')
const logTaskTotal = toRef(ctl, 'logTaskTotal')
const logTaskDoneHidden = toRef(ctl, 'logTaskDoneHidden')
// 分组与状态三档（2026-11-08 第 6 条）
const logTaskStatus = toRef(ctl, 'logTaskStatus')
const logTaskGroups = toRef(ctl, 'logTaskGroups')
const logTaskExpanded = toRef(ctl, 'logTaskExpanded')
// 平铺态（面板开着 或 有搜索词）：不分组、按相关度平铺（2026-11-13 卡 2b1e3d59）
const logTaskSearching = toRef(ctl, 'logTaskSearching')
const logTaskFlat = toRef(ctl, 'logTaskFlat')
// 右侧独立面板（2026-11-13 暮雨拍板）：开关 + 三层筛选 + 选项来源 + 计数
const logTaskPanelOpen = toRef(ctl, 'logTaskPanelOpen')
const logTaskStatuses = toRef(ctl, 'logTaskStatuses')
const logTaskPrios = toRef(ctl, 'logTaskPrios')
const logTaskTags = toRef(ctl, 'logTaskTags')
const logTaskFacets = toRef(ctl, 'logTaskFacets')
const logTaskFilterCount = toRef(ctl, 'logTaskFilterCount')
const clearLogTaskFilters = ctl.clearLogTaskFilters
const toggleInRaw = ctl.toggleIn
/**
 * 筛选片的开关 —— **必须在脚本里调，不能直接在模板里 `toggleIn(logTaskStatuses, s)`**。
 *
 * 原因（2026-11-14 首跑就被断言抓到，筛选片点了完全没反应）：
 * Vue 模板会把 setup 里返回的 ref **自动解包**，于是传进去的是数组本身而不是 ref，
 * `toggleIn` 里 `arr.value = …` 变成给数组加一个 `.value` 属性 —— 静默无效，
 * 界面看着"点了、高亮了"，实际筛选条件一个字没变。
 */
function toggleStatus(s: string): void { toggleInRaw(logTaskStatuses, s) }
function togglePrio(p: string): void { toggleInRaw(logTaskPrios, p) }
function toggleTag(g: string): void { toggleInRaw(logTaskTags, g) }
const toggleLogTaskGroup = ctl.toggleLogTaskGroup
const pickFirstLogTask = ctl.pickFirstLogTask

/** 项目 id → 名字；未登记的原样显示（不把卡藏起来） */
function projectNameOf(id: string): string {
  if (!id) return '未归属'
  const p = (projects.value || []).find((x: any) => x.id === id)
  return String(p?.name || id)
}
/** 优先级 → 色档 class（复用既有 lp-* 样式，不新造一套） */
function prioKey(p: string): string {
  const x = String(p || '').trim()
  if (x === '高' || /^(high|critical|p0)$/i.test(x)) return 'high'
  if (x === '低' || /^(low|p3)$/i.test(x)) return 'low'
  return 'mid'
}

/**
 * 命中字段的中文名 —— 行内那个小标签。
 *
 * 为什么要它：搜索态按相关度排，但"为什么它在第一行"如果只能靠人去猜，
 * 就还是"随便乱点"。把命中点摊开，人一眼能判断"这不是我要的那张"。
 * rank 由 shared/taskPick 给（-1 = 无搜索词），这里只翻成人话。
 */
const HIT_FIELD_LABEL: Record<number, string> = { 0: '标题', 1: '标签', 2: '项目', 3: 'ID', 4: '状态' }
function hitFieldName(t: any): string {
  const r = Number(t && t.hitRank)
  return HIT_FIELD_LABEL[r] || '命中'
}
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
