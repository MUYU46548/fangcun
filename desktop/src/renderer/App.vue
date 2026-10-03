<template>
  <div id="app"
    @dragenter.prevent="dragEnter('global')"
    @dragover.prevent="dragPulse()"
    @dragleave="dragLeave('global')"
    @drop="onAppDrop"
  >
    <!-- Decorative blobs -->
    <div class="blob b1"></div>
    <div class="blob b2"></div>

    <!-- 卡片悬停轻提示（2026-09-28 密度方案 B 的配套）。
         为什么不是"鼠标悬停滚动"：字在动的东西没法读，鼠标一进就动、扫一遍看板时全在动，
         而且卡片本身可拖拽，两者会打架。
         这里的做法是**只在标题真的被截断时**才出现（scrollWidth > clientWidth），
         延迟 **150ms**（不是 1–2 秒：那会让"想确认一下"变成"等一下"，扫视时等于什么都没有），
         内容是「完整标题 + 正文摘要 + 项目/截止/优先级/标签」= 半张详情卡，
         所以悬停不只是补文字，是**免点击预览**。
         铁律：position:fixed + pointer-events:none（不参与布局、不吃命中），拖拽中一律不显示。 -->
    <div v-if="cardTip" class="card-tip" :style="cardTipStyle">
      <div class="card-tip-title">{{ cardTip.title }}</div>
      <div v-if="cardTip.body" class="card-tip-body">{{ cardTip.body }}</div>
      <div class="card-tip-meta">
        <span class="st" :class="'st-' + cardTip.statusClass">{{ cardTip.status }}</span>
        <span v-if="cardTip.project" class="card-proj">{{ cardTip.project }}</span>
        <span v-if="cardTip.due" class="card-date" :class="{ over: cardTip.overdue }">📅 {{ cardTip.due }}</span>
        <span v-if="cardTip.priority" class="card-tip-pri">{{ cardTip.priority }}</span>
      </div>
      <div class="ptags" v-if="cardTip.tags.length">
        <span class="ptag" v-for="tag in cardTip.tags" :key="tag">{{ tag }}</span>
      </div>
    </div>

    <!-- 全局拖放兜底提示：拖到不支持导入的页签时不再是"毫无反应"（用户第 4 条）
         固定定位 + pointer-events:none —— 绝不参与布局，否则会与拖拽事件自激闪烁。
         2026-09-28：文案与 onAppDrop 的 toast 对齐 —— 此前这里只写了「待办」「日志」，
         漏了明明支持导入的「技能」页（两个提示互相矛盾）。 -->
    <div v-if="globalDropHint" class="drop-hint global">
      当前页签不支持导入文件 —— 请到「待办」「日志」或「技能」页签再拖入
    </div>

    <!-- Top bar -->
    <header id="bar">
      <!-- 2026-09-25（用户第 12 条）：
           ① 左侧方形 LOGO（绒花墨坊有、方寸没有）→ 点开「关于」；
           ② 那个「神秘数字」加了说明与准确性修复，见 countText / countTitle。 -->
      <span class="title">
        <button class="brand" title="关于方寸" @click="openAbout">寸</button>
        方寸 tegula<small id="count" :title="countTitle">{{ countText }}</small>
      </span>
      <button v-if="canGoBack" class="ghost nav-back" title="返回上一个视图" @click="goBack">← 返回</button>
      <span v-if="parseErrors.length" class="parse-warn" :title="parseErrors.join('\n')" @click="showParseErrors">
        ⚠ {{ parseErrors.length }} 个文件无法解析
      </span>
      <span class="ctrls">
        <!-- 看板专属控件（2026-09-26 用户第 1 条）：它们只对看板/归档有意义。
             原来无条件渲染 → 在回收站/技能/日志/待办等页签上全是"点了没反应"的按钮。 -->
        <template v-if="isBoardView">
        <select v-model="curProj" class="proj-select">
          <option value="__all__">全部项目</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
        </select>
        <select v-model="groupMode">
          <option value="status">按状态</option>
          <option value="project">按项目</option>
          <option value="priority">按优先级</option>
        </select>
        <!-- 折叠/展开是**同一个开关的两种状态**（2026-09-28 用户第 3 条）。
             「折叠全部 / 展开」并排放两个按钮，永远有一个是无效的 —— 用户原话「臃肿无比」。
             现在一个按钮把事情做完，且标签跟着当前状态走。 -->
        <button class="ghost" id="btn-fold-all"
          :title="allGroupsCollapsed ? '展开所有分组，看全部卡片' : '折叠所有分组，只看分组名和数量（长单子立刻变短）'"
          @click="toggleAllCollapsed()">{{ allGroupsCollapsed ? '⊞ 展开全部' : '⊟ 折叠全部' }}</button>
        <input v-model="searchQuery" placeholder="搜索...（支持 #tag @proj due:MM-DD 关键词 Enter=自然查询）" class="search" @keydown.enter="executeNaturalQuery" />
        <select v-model="dueFilter" class="due-filter">
          <option value="">全部时间</option>
          <option value="overdue">已逾期</option>
          <option value="today">今天到期</option>
          <option value="week">本周到期</option>
        </select>
        <!-- 「含归档」只在活跃视图有意义（把归档任务也列进看板/搜索）。
             归档视图里它只会造成"同一批任务是否重复出现"的困惑，所以直接隐藏（2026-09-25）。 -->
        <label v-if="curView !== 'archive'" class="chk"><input type="checkbox" v-model="searchIncludeArchive" /> 含归档</label>
        <select v-model="sortMode">
          <option value="active">活跃优先</option>
          <option value="updated">最近更新</option>
          <option value="created">创建时间</option>
          <!-- 2026-10-01 用户第 2 条：看板也要能按优先级排（高 → 中 → 低，已完成仍沉底看列而定） -->
          <option value="prio">优先级</option>
        </select>
        </template>
        <button v-if="isTaskView" @click="openNew">+ 新建</button>
        <button class="ghost backup-btn" :class="bkDotClass" :title="bkTooltip" @click="showBackup">
          <span v-if="bkBusy" class="bk-spin">⟳</span>
          <span v-else>💾</span>
          <span v-if="bkAlert" class="bk-alert-dot"></span>
        </button>
        <button v-if="ncReady" class="ghost nc-bell" title="通知中心" @click.stop="ncToggle">
          <span>🔔</span>
          <span v-if="ncUnread > 0" class="nc-badge">{{ ncUnread > 99 ? '99+' : ncUnread }}</span>
        </button>
        <button class="ghost" title="诊断日志（应用日志文件尾部 + 打开目录）" @click="toggleAppLogPanel">📋</button>
        <!-- 任务多选同样只在看板/归档有意义（批量改状态/归档作用于看板列） -->
        <button v-if="isBoardView" class="ghost batch-mode-btn" :class="{ active: batchMode }" @click="toggleBatchMode">
          <span v-if="!batchMode">☑ 任务多选</span>
          <span v-else>☑ <i style="color:#fff">{{ selectedBatch.length || 0 }}</i></span>
        </button>
        <button class="ghost" @click="showSettings">⚙</button>
      </span>
    </header>

    <!-- View tabs -->
    <nav id="views" :class="{ 'batch-on': batchMode }">
      <button
        v-for="v in views"
        :key="v.id"
        class="vbtn"
        :class="{ on: curView === v.id }"
        @click="switchView(v.id)"
      >
        {{ v.label }}
      </button>
    </nav>

    <!-- 错误条（2026-09-22，用户第 8 条）：任何失败都在这里有痕迹。
         main.ts 的 window.onerror / unhandledrejection 上报广播过来，
         由主进程落盘到 userData/logs，这里给一个用户可见的出口。 -->
    <div v-if="appErrors.length" class="errbar">
      <span class="errbar-ico">⚠</span>
      <span class="errbar-msg" :title="appErrors.map(e => '[' + e.scope + '] ' + e.message).join('\n')">
        {{ appErrors[appErrors.length - 1].message }}
        <b v-if="appErrors.length > 1">（共 {{ appErrors.length }} 条）</b>
      </span>
      <button class="ghost" @click="toggleAppLogPanel">{{ appErrOpen ? '收起' : '查看日志' }}</button>
      <button class="ghost" @click="openAppLogDir">打开日志目录</button>
      <button class="ghost" title="清空错误条（日志文件不受影响）" @click="appErrors = []">忽略</button>
    </div>
    <div v-if="appErrOpen" class="errpanel">
      <div class="errpanel-head">
        <span>日志文件：<code>{{ appLogFile || '（未取到）' }}</code></span>
        <button class="ghost" @click="copyAppLogPath">复制路径</button>
        <button class="ghost" @click="openAppLogDir">打开目录</button>
        <!-- 收起按钮必须长在这里：上一条「忽略」会清空 appErrors，而「收起」原先只存在于
             errbar 里（v-if="appErrors.length"）—— 一按忽略，errbar 整条消失，
             日志抽屉就再也关不掉了（用户 2026-09-25 第 4 条）。 -->
        <button class="ghost" title="关闭日志抽屉" @click="appErrOpen = false">收起</button>
      </div>
      <pre class="errpanel-body">{{ appLogTail.join('\n') || '（日志为空）' }}</pre>
    </div>

    <!-- Batch action bar：固定悬浮在内容区顶部居中，紧邻右上角批量按钮的视线范围 -->
    <div v-if="batchMode" class="batch-bar">
      <span class="batch-count">已选 {{ selectedBatch.length }}</span>
      <button class="ghost" title="全选 / 取消全选当前视图内的任务" @click="toggleSelectAll">{{ selectedBatch.length === filteredTasks.length ? '取消全选' : '全选' }}</button>
      <div class="batch-actions">
        <button class="ghost" title="批量置为「待办」" @click="batchSetStatus('待办')">待办</button>
        <button class="ghost" title="批量置为「进行中」" @click="batchSetStatus('进行中')">进行中</button>
        <button class="ghost" title="批量置为「待验收」" @click="batchSetStatus('待验收')">待验收</button>
        <button class="ghost" title="批量置为「完成」" @click="batchSetStatus('完成')">完成</button>
        <button class="ghost" title="批量置为「驳回」" @click="batchSetStatus('驳回')">驳回</button>
        <button class="ghost" title="批量归档（会二次确认）" @click="executeBatchArchive">归档</button>
        <button class="danger" title="批量删除（会二次确认，进入 trash 可人工找回）" @click="executeBatchDelete">删除</button>
      </div>
      <button class="ghost" title="退出多选模式并清空选择" @click="selectedBatch = []; batchMode = false">取消</button>
    </div>

    <!-- Archive hint -->
    <div v-if="curView === 'archive' && showArchiveHint" class="archive-hint">
      <span>📋 归档视图：此处只显示 <strong>文件已移入 task-data/archive/ 的任务</strong>（归档的唯一判定标准是文件路径，不是状态）。归档操作只能由你亲自判定，不会自动执行。</span>
      <button @click="closeArchiveHint">知道了</button>
    </div>


    <!-- 视图切换器（页头，2026-09-28 用户第 ① 条 + 卡 033）。
         刻意**不塞进顶栏**：顶栏已经有 9 个控件，再加一个横排按钮组只会更挤。
         页头只有一行，左边是"换一种摆法"，右边用一句话说明这个摆法擅长什么 ——
         用户不必先点一遍才知道两个视图差在哪。 -->
    <div v-if="viewOptions.length" class="pagehead">
      <div class="viewsw">
        <button
          v-for="o in viewOptions"
          :key="o.v"
          class="vsb"
          :class="{ on: currentViewMode === o.v }"
          @click="setViewMode(o.v)"
        >{{ o.label }}</button>
      </div>
      <span class="pagehead-hint">{{ viewHint }}</span>
    </div>

    <!-- 已完成任务自动归档提示条（2026-10-03 卡 012）：只在**真有超期任务**时出现，
         且不自动动手 —— 点按钮才移文件（与日志页「清理超期」同一种交互）。
         归档可逆（进 archive/，可在「归档」标签还原），所以按钮文案直说后果。 -->
    <div v-if="curView === 'active' && archiveDays > 0 && archiveOverdue.count > 0" class="archive-overdue-bar">
      <span>📦 有 <b>{{ archiveOverdue.count }}</b> 个已完成任务超过 {{ archiveDays }} 天没更新（如：{{ (archiveOverdue.items[0] || {}).title || (archiveOverdue.items[0] || {}).id || '—' }}）</span>
      <button class="ghost" @click="runArchiveOverdue()">移进归档区</button>
      <button class="ghost" title="这次先不动，下次启动/刷新还会提示" @click="archiveOverdue = { count: 0, items: [] }">先不管</button>
    </div>

    <main id="board" :class="boardClass" v-if="curView === 'active' || curView === 'archive'">
      <!-- 列表视图（多视图第 1 项）。与列视图**共用** columns / collapsedGroups / 拖拽处理：
           拖一行到某个分区里 = 改成该状态，和拖到列里是同一件事。 -->
      <div v-if="boardView === 'list'" class="board-list">
        <div
          v-for="col in columns"
          :key="'bl-' + col.key"
          class="blgrp"
          :class="{ 'drop-here': dragoverCol === col.key, 'is-empty': !col.tasks.length }"
          @dragover.prevent="onDragOver($event, col.key)"
          @dragleave="dragoverCol = null"
          @drop="onDrop($event, col.key)"
        >
          <div class="blgrp-head">
            <button class="lpill" :title="groupCollapsed(col.key) ? '点击展开' : '点击折叠'"
              @click="toggleGroup(col.key)">
              <span class="chev" :class="{ open: !groupCollapsed(col.key) }"></span>
              <span class="gdot" :class="'gdot-' + statusClass(col.key)"></span>
              <span class="glabel">{{ col.label }}</span>
              <span class="gn">{{ col.tasks.length }}</span>
            </button>
            <span class="f1"></span>
          </div>
          <div
            v-for="t in col.tasks"
            v-show="!groupCollapsed(col.key)"
            :key="'blr-' + t.id"
            class="brow"
            :class="{
              stale: isStale(t),
              overdue: isOverdue(t),
              selected: selectedBatch.includes(t.id),
              dragging: draggingId === t.id
            }"
            :data-id="t.id"
            draggable="true"
            @dragstart="onDragStart($event, t.id)"
            @click="batchMode ? toggleBatchSelect(t.id) : openCard(t)"
            @contextmenu.prevent="openCardMenu($event, t)"
            @mouseenter="onCardEnter($event, t)"
            @mouseleave="onCardLeave()"
          >
            <input
              v-show="batchMode"
              type="checkbox"
              class="batch-chk"
              :checked="selectedBatch.includes(t.id)"
              @click.stop="toggleBatchSelect(t.id)"
            />
            <span class="card-liv" :class="'liv-' + statusClass(t.status)"></span>
            <b class="ttl">
              <span v-if="t.batch" class="batch">批{{ t.batch }}</span>
              {{ t.title || t.id }}
            </b>
            <!-- 状态徽章同列视图的规矩：分区已经说明了状态就不重复占宽 -->
            <span v-if="groupMode !== 'status'" class="st" :class="'st-' + statusClass(t.status)">{{ t.status }}</span>
            <span v-if="t.archived" class="src-badge" title="归档任务">📦</span>
            <span class="card-meta">
              <span v-if="cardDate(t).text" class="card-date"
                :class="{ over: cardDate(t).over, dim: cardDate(t).kind === 'updated' }"
                :title="cardDate(t).kind === 'due' ? '截止日' : '最后更新'">{{ cardDate(t).text }}</span>
              <span class="card-proj" :title="normProject(t.project) || '未归属任何项目'">{{ projShort(t.project) }}</span>
            </span>
          </div>
          <div v-if="!col.tasks.length" v-show="!groupCollapsed(col.key)" class="emptyhint">拖拽卡片到此处</div>
        </div>
      </div>

      <!-- 列视图（默认摆法，保持不变）。用 template v-if 包住是为了让两种摆法**互斥**：
           同时挂在 DOM 里会造出"同一批卡片存在两份"（批量全选、键盘焦点、e2e 计数全会翻倍）。
           ⚠ 注释里不要写尖括号形式的 template 标签 —— 守卫 check-button-styles 靠正则数标签配对，
             注释里的开标签会被算进深度，直接导致"无法切分 template / style 块"。 -->
      <template v-if="boardView === 'cols'">
      <div
        v-for="col in columns"
        :key="col.key"
        class="col"
        :class="{ empty: !col.tasks.length, dragover: dragoverCol === col.key, 'collapsed-col': groupCollapsed(col.key) }"
        :data-status="col.key"
        @dragover.prevent="onDragOver($event, col.key)"
        @dragleave="dragoverCol = null"
        @drop="onDrop($event, col.key)"
      >
        <h3 @click="toggleGroup(col.key)" :title="groupCollapsed(col.key) ? '点击展开' : '点击折叠'">
          <span class="chev" :class="{ open: !groupCollapsed(col.key) }"></span>
          <span class="status-label">
            <span class="status-dot"></span>
            {{ col.label }}
          </span>
          <span class="n">{{ col.tasks.length }}</span>
        </h3>
        <div
          v-for="t in col.tasks"
          v-show="!groupCollapsed(col.key)"
          :key="t.id"
          class="card"
          :class="{
            stale: isStale(t),
            overdue: isOverdue(t),
            selected: selectedBatch.includes(t.id),
            dragging: draggingId === t.id
          }"
          :data-id="t.id"
          draggable="true"
          @dragstart="onDragStart($event, t.id)"
          @dragend=""
          @click="batchMode ? toggleBatchSelect(t.id) : openCard(t)"
          @contextmenu.prevent="openCardMenu($event, t)"
          @mouseenter="onCardEnter($event, t)"
          @mouseleave="onCardLeave()"
        >
          <!-- 紧凑单行卡（2026-09-28 密度方案 B）。
               原来卡是两行（标题+状态徽章 / 正文两行截断 / 标签行），14 张的完成列能顶满一屏。
               现在压成一行：状态点 + 标题（超长省略） + 右侧 meta。
               正文摘要与标签没丢，移进上面的悬停轻提示 —— 那本来也是"点开才有用"的东西。
               ⚠ `active-t`（整卡淡紫底 + 3px 左条）已删：状态由**列位置**承担，
                 卡级再染一遍是冗余编码，而且卡片一多整列都在发光（用户第 4 条"越看越头痛"）。 -->
          <div class="card-head">
            <input
              v-show="batchMode"
              type="checkbox"
              class="batch-chk"
              :checked="selectedBatch.includes(t.id)"
              @click.stop="toggleBatchSelect(t.id)"
            />
            <span class="card-liv" :class="'liv-' + statusClass(t.status)" :title="t.status"></span>
            <b class="ttl">
              <span v-if="t.batch" class="batch">批{{ t.batch }}</span>
              {{ t.title || t.id }}
            </b>
            <!-- 状态徽章只在「不按状态分组」时才出现：按状态分组时列位置已经说明了状态，
                 多一个文字徽章只是重复占宽（紧凑卡上宽度很贵）。 -->
            <span v-if="groupMode !== 'status'" class="st" :class="'st-' + statusClass(t.status)">{{ t.status }}</span>
            <span v-if="t.archived" class="src-badge" title="归档任务">📦</span>
            <!-- 右侧 meta：**所属项目 + 日期常驻可见**（2026-09-28 用户反馈「希望看见所属项目和日期」）。
                 日期优先截止日（可行动），没有截止日就退到「更新」——保证卡上永远有一个日期。
                 cardDate() 是纯函数且很便宜，表里多调两次无所谓（每次重渲染才跑，不是每帧）。 -->
            <span class="card-meta">
              <span v-if="cardDate(t).text" class="card-date"
                :class="{ over: cardDate(t).over, dim: cardDate(t).kind === 'updated' }"
                :title="cardDate(t).kind === 'due' ? '截止日' : '最后更新'">{{ cardDate(t).text }}</span>
              <span class="card-proj" :title="normProject(t.project) || '未归属任何项目'">{{ projShort(t.project) }}</span>
            </span>
          </div>
        </div>
        <div v-if="!col.tasks.length" v-show="!groupCollapsed(col.key)" class="emptyhint">拖拽卡片到此处</div>
      </div>
      </template>
    </main>

    <!-- Project view -->
    <main id="board" class="pv" v-else-if="curView === 'projects'">
      <div class="alertbar" v-if="blockers.length">
        <span class="ico">⚠</span>
        <b>{{ blockers.length }}</b> 个任务存在阻塞依赖
      </div>
      <!-- 第 7 条：项目章程缺口一眼可见 + 一键补骨架（原先只能逐个点开卡看） -->
      <div class="charter-bar">
        <span class="cb-label">项目章程</span>
        <span class="cb-stat">已填 <b>{{ charterStats.filled }}</b> / {{ charterStats.total }}</span>
        <span class="cb-stat" v-if="charterStats.skeleton">骨架待填 <b>{{ charterStats.skeleton }}</b></span>
        <span class="cb-stat warn" v-if="charterStats.missing">缺失 <b>{{ charterStats.missing }}</b></span>
        <!-- 029 验收驳回原话：「找不到在哪里」。
             真因：结构地图**只存在于方针卡文件里**，界面上唯一相关的东西是这个
             `<span>` 计数 —— 它不可点、且没有缺口时干脆不渲染，于是"结构地图到底在哪"无从得知。
             现在换成**常驻可点按钮**：没缺口时也在，点开就是一览（哪几张有、最后核实的日期、直接去改）。 -->
        <button class="ghost cb-map-btn" :class="{ warn: charterStats.mapMissing > 0 }"
          :title="charterStats.mapMissing
            ? `还有 ${charterStats.mapMissing} 个项目没有结构地图 —— 点开看是哪些`
            : '结构地图：模块清单 + 每模块一句话职责 + 主数据流（点开查看/编辑）'"
          @click="openStructMap()">
          🗺 结构地图
          <b v-if="charterStats.mapMissing" class="cb-map-n">待填 {{ charterStats.mapMissing }}</b>
          <b v-else class="cb-map-n ok">{{ charterStats.mapReady }}/{{ charterStats.filled }}</b>
        </button>
        <button class="ghost" v-if="charterStats.missing" @click="fillMissingCharters()">
          ＋ 补齐 {{ charterStats.missing }} 个章程骨架
        </button>
      </div>
      <!-- ══ ① 项目墙（默认，旧摆法原样保留 —— 加视图不改旧的）══════════════ -->
      <div class="pvgrid" v-if="pvView === 'tiles'">
        <div
          v-for="p in projectStats"
          :key="p.id"
          class="tile"
          :class="'t-' + p.health"
          @click="openProject(p)"
        >
          <div class="trow">
            <span class="tname">{{ p.name }}</span>
            <span class="thealth">{{ healthLabel(p.health) }}</span>
          </div>
          <div class="tstats">
            <div class="ts">
              <div class="n">{{ p.activeTasks }}</div>
              <div class="l">进行中</div>
            </div>
            <div class="ts">
              <div class="n">{{ p.taskCount }}</div>
              <div class="l">总任务</div>
            </div>
            <div class="ts">
              <div class="progress-bar"><div class="progress-fill" :style="{width: projectProgress[p.id] ? projectProgress[p.id].percent + '%' : '0%'}"></div></div>
              <div class="l">{{ projectProgress[p.id] ? projectProgress[p.id].percent + '%' : '—' }} 完成</div>
            </div>
            <div class="ts">
              <div class="n warn" v-if="p.health === 'stuck'">⚠</div>
              <div class="l">{{ p.lastActivity ? relativeTime(p.lastActivity) : '无记录' }}</div>
            </div>
          </div>
          <!-- 方针入口挪到项目页签（用户 2026-09-25 第 3 条）：原先只藏在「设置」最底部，
               找不着；这里放在项目卡上，一眼可见，且不必先关设置。 -->
          <button class="ghost pv-policy" @click.stop="openPolicyEdit(p.id)">
            {{ policyMap[p.id] ? '📋 方针已立 · 查看/编辑'
               : policyExistsMap[p.id] ? '📝 方针待填 · 打开填写'
               : '＋ 立项目方针' }}
          </button>
        </div>
        <div class="tile tile-add" @click="openNewProject">
          <div class="add-icon">+</div>
          <div class="add-text">添加项目</div>
        </div>
      </div>

      <!-- ══ ② 概览卡（2026-09-29 用户选的改法 A）══════════════════════════
           003 卡原话「只是个大号看板入口，不是项目管理」。把「四个数字」换成
           「状态分布条 + 最近动态 + 阻塞/方针/结构地图缺口」——
           一眼能看出这个项目卡在哪、缺什么、下一步该点哪个按钮。 -->
      <div class="ovgrid" v-else-if="pvView === 'overview'">
        <div v-for="p in projectStats" :key="p.id" class="ocard" @click="openProject(p)">
          <div class="ohead">
            <span class="nm">{{ p.name }}</span>
            <span class="rp">{{ p.repo || '未登记工作目录' }}</span>
            <span class="hl" :class="'hl-' + p.health">{{ healthLabel(p.health) }}</span>
          </div>
          <div class="stack" :title="pvBreakdown[p.id] && pvBreakdown[p.id].length ? '状态分布：' + pvBreakdown[p.id].map(s => s.status + ' ' + s.n).join(' · ') : '这个项目还没有任务'">
            <i v-for="s in (pvBreakdown[p.id] || [])" :key="s.status"
               :style="{ width: segWidth(s.n, p.taskCount), background: statusSegColor(s.cls) }"></i>
          </div>
          <div class="legend">
            <span v-for="s in (pvBreakdown[p.id] || [])" :key="s.status">
              <s :style="{ background: statusSegColor(s.cls) }"></s>{{ s.status }} {{ s.n }}
            </span>
            <span v-if="!(pvBreakdown[p.id] || []).length">3 条任务都没有状态标记</span>
          </div>
          <div class="odyn">
            最近：<b>{{ p.lastActivity ? relativeTime(p.lastActivity) : '无记录' }}</b>
            <template v-if="pvLatest[p.id]"> · {{ pvLatest[p.id]!.title || pvLatest[p.id]!.id }}</template>
            <br>
            <span v-if="pvBlocked[p.id]" class="odyn-warn">⚠ {{ pvBlocked[p.id] }} 个阻塞源</span>
            <span :class="{ 'odyn-warn': !policyMap[p.id] }">方针：{{ policyMap[p.id] ? '已立' : policyExistsMap[p.id] ? '待填' : '未立' }}</span>
            ·
            <span :class="{ 'odyn-warn': !policyMapHasStructure[p.id] }">结构地图：{{ policyMapHasStructure[p.id] ? '有' : '没有' }}</span>
            <span v-if="p.health === 'stuck' || p.health === 'dormant'"> · 这个项目已经冷下来了</span>
          </div>
          <div class="oacts">
            <button class="ghost oact" @click.stop="openPolicyEdit(p.id)">📋 {{ policyMap[p.id] ? '方针' : '立方针' }}</button>
            <button class="ghost oact" @click.stop="openStructMap()">🗺 结构地图</button>
            <button class="ghost oact" @click.stop="openProject(p)">📦 任务 {{ p.taskCount }}</button>
          </div>
        </div>
        <div class="ocard ocard-add" @click="openNewProject">
          <div class="add-icon">+</div>
          <div class="add-text">添加项目</div>
        </div>
      </div>

      <!-- ══ ③ 主从（2026-09-29 用户选的改法 B）════════════════════════════
           左列常驻项目 + 迷你进度，右侧摊开所选项目的详情。
           项目 10+ 时比项目墙好使；现在项目少，用哪个都行 —— 所以做成可切。 -->
      <div class="pv-ms" v-else>
        <div class="ms-list">
          <div v-for="p in projectStats" :key="p.id" class="ms-li"
               :class="{ on: !!pvCurrent && pvCurrent.id === p.id }"
               @click="pvSelected = p.id">
            <span class="ms-dot" :class="'t-' + p.health"></span>
            <span class="ms-name">{{ p.name }}</span>
            <span class="ms-mini"><i :style="{ width: projectPercent(p.id) + '%' }"></i></span>
            <span class="ms-n">{{ p.activeTasks }}</span>
          </div>
          <div class="ms-add" @click="openNewProject">＋ 添加项目</div>
        </div>
        <div class="ms-detail" v-if="pvCurrent">
          <div class="ocard bare">
            <div class="ohead">
              <span class="nm">{{ pvCurrent.name }}</span>
              <span class="rp">{{ pvCurrent.repo || '未登记工作目录' }}</span>
              <span class="hl" :class="'hl-' + pvCurrent.health">{{ healthLabel(pvCurrent.health) }}</span>
            </div>
            <div class="stack">
              <i v-for="s in (pvBreakdown[pvCurrent.id] || [])" :key="s.status"
                 :style="{ width: segWidth(s.n, pvCurrent.taskCount), background: statusSegColor(s.cls) }"></i>
            </div>
            <div class="legend">
              <span v-for="s in (pvBreakdown[pvCurrent.id] || [])" :key="s.status">
                <s :style="{ background: statusSegColor(s.cls) }"></s>{{ s.status }} {{ s.n }}
              </span>
            </div>
            <div class="odyn">
              最近：<b>{{ pvCurrent.lastActivity ? relativeTime(pvCurrent.lastActivity) : '无记录' }}</b>
              <template v-if="pvLatest[pvCurrent.id]"> · {{ pvLatest[pvCurrent.id]!.title || pvLatest[pvCurrent.id]!.id }}</template>
              <br>
              <span v-if="pvBlocked[pvCurrent.id]" class="odyn-warn">⚠ {{ pvBlocked[pvCurrent.id] }} 个阻塞源</span>
              进行中 {{ pvCurrent.activeTasks }} · 已完成 {{ pvCurrent.completedTasks }} ·
              完成进度 {{ projectPercent(pvCurrent.id) }}%
            </div>
            <div class="oacts">
              <button class="ghost oact" @click.stop="openPolicyEdit(pvCurrent.id)">📋 {{ policyMap[pvCurrent.id] ? '方针' : '立方针' }}</button>
              <button class="ghost oact" @click.stop="openStructMap()">🗺 结构地图</button>
              <button class="ghost oact" @click.stop="openProject(pvCurrent)">📦 看任务</button>
              <!-- 不做「打开工作目录」——主进程没有"打开任意路径"的通道，也刻意不暴露。
                   能做的只是把路径复制走，那就只给这个，不摆一个点了没反应的按钮。 -->
              <button v-if="pvCurrent.repo" class="ghost oact"
                      @click.stop="copyWithToast(pvCurrent.repo, '已复制工作目录')">⧉ 复制路径</button>
            </div>
          </div>
        </div>
        <div class="ms-detail empty" v-else>还没有项目 —— 点左下角「＋ 添加项目」登记第一个。</div>
      </div>
    </main>

    <!-- 技能安装专区（2026-09-26 卡 038）：不做插件市场，就是一块「看得见 + 能复制」的说明面板 -->
    <main id="board" class="skills-view" v-else-if="curView === 'skills'"
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
          <div v-if="!agentTargets.length" class="skills-agent">检测中…</div>
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
          <div v-else-if="!mcpTargets.length" class="skills-agent">检测中…</div>
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

    <!-- 服务 / 端口（2026-09-26 卡 006）：用户选的是 A 档 —— 只读监控 + 冲突预警，绝不杀进程 -->
    <main id="board" class="services-view" v-else-if="curView === 'services'">
      <div class="services-header">
        <h3>服务 / 端口</h3>
        <span v-if="!servicesLoading" class="services-stats">
          登记 {{ servicesRows.length }} · 监听中 {{ servicesListening }} · 空闲 {{ servicesIdle }}
        </span>
        <input v-model="svcName" class="svc-input" placeholder="服务名（如 方寸看板）" @keyup.enter="addService()" />
        <input v-model="svcPort" class="svc-input svc-port-input" placeholder="端口" @keyup.enter="addService()" />
        <button class="skills-btn primary" @click="addService()">＋ 登记端口</button>
        <button class="skills-btn" @click="copyServicesSnapshot()" title="把当前服务/端口清单复制成纯文本 —— 方便直接贴给 Hermes 分析">📋 复制快照</button>
        <button class="skills-btn" @click="loadServices()">刷新</button>
      </div>
      <div class="services-notebar">
        只读监控：这里只告诉你在不在、谁占着，<b>不会结束任何进程</b>
        （要停服务请自己看清 PID 再动手）。登记源＝启动台 apps.json 的 port 字段 + 手填的 services.json。
      </div>

      <div v-if="servicesError" class="skills-error">{{ servicesError }}</div>
      <div v-else-if="servicesLoading" class="empty-state"><div class="empty-text">探测中…</div></div>
      <template v-else>
        <div v-if="servicesDuplicates.length" class="services-warn">
          ⚠ 这几个端口被登记了多次（真冲突，先合并）：{{ servicesDuplicates.join('、') }}
        </div>
        <div v-if="!servicesRows.length" class="empty-state">
          <div class="empty-icon">🔌</div>
          <div class="empty-text">还没登记任何端口 —— 用上面的输入框登记，或给启动台应用填 port</div>
        </div>
        <div v-else class="services-list">
          <div v-for="s in servicesRows" :key="s.id" class="svc-item">
            <div class="svc-main">
              <div class="svc-line1">
                <span class="svc-name">{{ s.name }}</span>
                <span class="svc-port">:{{ s.port }}</span>
                <span class="svc-state" :class="s.listening ? 'on' : 'off'">{{ s.listening ? '监听中' : '空闲' }}</span>
                <span v-if="s.duplicated" class="svc-dup">重复登记</span>
                <span class="svc-src">{{ s.source === 'launchpad' ? '启动台' : '手填' }}</span>
              </div>
              <div class="svc-line2">
                <span v-if="s.listening">占用者 PID {{ s.pid }} · {{ s.processName }}</span>
                <span v-else>没有进程在监听</span>
                <span v-if="s.note">· {{ s.note }}</span>
              </div>
            </div>
            <div class="svc-actions">
              <button v-if="!s.listening && s.source === 'launchpad'" class="skills-btn primary"
                      @click="startServiceRow(s)" title="按启动台里登记的命令把它拉起来（方寸只启动启动台登记过的应用，绝不杀进程）">▶ 启动</button>
              <button class="skills-btn" @click="openService(s)" :disabled="!s.listening"
                      :title="s.listening ? '在浏览器打开 http://127.0.0.1:' + s.port : '现在没人监听，打开会报错'">🌐 打开地址</button>
              <button v-if="s.source === 'manual'" class="skills-btn danger" @click="removeService(s)">🗑 取消登记</button>
            </div>
          </div>
        </div>

        <div v-if="servicesUnregistered.length || servicesHidden" class="services-unreg">
          <div class="services-unreg-title">
            未登记但正在监听（{{ servicesUnregistered.length }}）
            <span class="services-unreg-hint">
              只列像服务/开发进程的（node·python·java…）；另有 {{ servicesHidden }} 个端口在监听但不像是服务
              （系统组件、聊天软件等），已略过 —— 不做全盘扫描
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

    <!-- 回收站（2026-09-26 卡 034）：数据一直在 task-data/.trash，此前缺的只是界面入口 -->
    <main id="board" class="trash-view" v-else-if="curView === 'trash'">
      <div class="trash-header">
        <h3>回收站</h3>
        <span class="trash-stats">{{ trashItems.length }} 项 · {{ trashTotalKb }} KB · 新的在最前</span>
        <input v-model="trashQuery" class="trash-search" placeholder="搜 id / 标题 / 文件名…" />
        <button class="trash-refresh" @click="loadTrash()" title="重新读取 task-data/.trash">刷新</button>
        <button class="ghost batch-mode-btn" :class="{ active: trashBatchMode }" @click="toggleTrashBatchMode"
          title="开启批量选择，点击条目即勾选/取消">
          <span v-if="!trashBatchMode">☑ 多选</span>
          <span v-else>☑ <i style="color:#fff">{{ selectedTrashBatch.length || 0 }}</i></span>
        </button>
      </div>
      <div v-if="trashBatchMode" class="batch-bar">
        <span class="batch-count">已选 {{ selectedTrashBatch.length }}</span>
        <button class="ghost" @click="toggleSelectAllTrash">{{ selectedTrashBatch.length === filteredTrash.length ? '取消全选' : '全选' }}</button>
        <button class="ghost" title="批量还原：终态回归档区，其余回活跃区；同名冲突不覆盖" @click="executeBatchTrashRestore">批量还原</button>
        <button class="danger" title="批量从磁盘彻底删除（会二次确认，不可撤销）" @click="executeBatchTrashPurge">彻底删除</button>
        <button class="ghost" title="退出多选模式并清空选择" @click="exitTrashBatch">取消</button>
      </div>
      <div class="trash-notebar">
        删掉的任务先来这儿 —— 数据没丢，可以还原；「彻底删除」才真的从磁盘删掉，不可撤销。
        <b>点卡片任意位置能看正文</b>，看完再决定删还是留。
      </div>

      <div v-if="trashLoading" class="empty-state"><div class="empty-text">读取中…</div></div>
      <div v-else-if="!trashItems.length" class="empty-state">
        <div class="empty-icon">🗑</div>
        <div class="empty-text">回收站是空的 — 没有已删除的任务</div>
      </div>
      <div v-else-if="!filteredTrash.length" class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-text">没有匹配「{{ trashQuery }}」的条目</div>
        <button class="trash-btn" @click="trashQuery = ''">清空搜索</button>
      </div>
      <div v-else class="trash-list" :class="{ batching: trashBatchMode }">
        <div v-for="it in filteredTrash" :key="it.name" class="trash-item"
          :class="{ selected: trashBatchMode && selectedTrashBatch.includes(it.name) }"
          @click="onTrashItemClick(it, $event)">
          <!-- 2026-09-30 用户第 5 条（卡 task-20260930-005）：显式勾选框 —— 此前选中只有
               边框/底色变化，且 hover 会盖掉它，用户「看不清到底是否选中」。 -->
          <span v-if="trashBatchMode" class="trash-batch-chk"
            :class="{ on: selectedTrashBatch.includes(it.name) }">✓</span>
          <div class="trash-main"
            :title="trashBatchMode ? '点击勾选/取消勾选' : '点击看正文（只读预览）'">
            <div class="trash-line1">
              <span class="trash-id">{{ it.id }}</span>
              <span class="trash-title">{{ it.title || '(无标题)' }}</span>
              <span v-if="it.status" class="st small" :class="'st-' + statusClass(it.status)">{{ it.status }}</span>
              <span v-if="it.project" class="trash-proj">{{ it.project }}</span>
            </div>
            <div class="trash-line2">
              <span class="trash-name" :title="it.name">{{ it.name }}</span>
              <span class="trash-meta">· {{ it.bytes || 0 }} B · 删于 {{ it.mtime ? relativeTime(it.mtime) : '—' }}</span>
            </div>
          </div>
          <div class="trash-actions" v-show="!trashBatchMode">
            <button class="trash-btn" @click="restoreTrashItem(it)" title="还原：终态回「归档」，其余回活跃区；同名冲突不覆盖，旧版改名保留">↩ 还原</button>
            <button class="trash-btn danger" @click="purgeTrashItem(it)" title="从磁盘彻底删除这一份，不可撤销">🗑 彻底删除</button>
          </div>
        </div>
      </div>
    </main>

    <!-- Blockers view: 2026-09-23 改为按阻塞源分组（用户第 4 条） -->
    <main id="board" class="blockers-view" v-else-if="curView === 'blockers'">
      <div class="blockers-header">
        <h3>阻塞源</h3>
        <span class="blockers-count">{{ blockerChains.length }} 个阻塞源，影响 {{ totalBlockedTasks }} 个任务</span>
      </div>
      <div class="blocker-chains">
        <div v-if="!blockerChains.length" class="empty-state">
          <div class="empty-icon">✓</div>
          <div class="empty-text">没有阻塞源 — 所有任务畅通</div>
        </div>
        <div v-for="src in blockerChains" :key="src.id" class="chain-card">
          <div class="chain-main">
            <span class="chain-id">{{ src.id }}</span>
            <span class="chain-title">{{ src.title }}</span>
            <span class="st" :class="'st-' + statusClass(src.status)">{{ src.status }}</span>
          </div>
          <div class="chain-arrow">↓ 阻塞了 {{ src.blockedTasks.length }} 个任务</div>
          <div class="chain-blockers">
            <div v-for="t in src.blockedTasks" :key="t.id" class="chain-blocker">
              <span class="cb-status">◌</span>
              <span class="cb-id">{{ t.id }}</span>
              <span class="cb-title">{{ t.title }}</span>
              <span class="st small" :class="'st-' + statusClass(t.status)">{{ t.status }}</span>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- Todos view -->
    <main id="board" class="todos-view" v-else-if="curView === 'todos'"
      @dragenter.prevent="dragEnter('todo')"
      @dragover.prevent="dragPulse()"
      @dragleave="dragLeave('todo')"
      @drop="onTodoDrop"
      :class="{ 'drop-target': todoDragOver }"
    >
      <div class="todos-header">
        <h3>待办</h3>
        <div class="todos-ctrls">
          <!-- 2026-09-29 用户第 1 条：小框（+ 添加）与「大框新建」并排 = 两个入口，
               小框长得像搜索框，纯误导；新建待办是慎重举动，只留一个入口 → 标准编辑大框。 -->
          <button class="ghost todo-new" title="新建待办（可一次填项目 / 优先级 / 到期日）；也可直接拖入 txt/md" @click="openTodoCreator()">＋ 新建待办</button>
          <select v-model="todoProjectFilter" class="todo-filter" title="按项目筛选（只影响显示）">
            <option value="__all__">全部项目</option>
            <option value="__none__">（不归属任何项目）</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
          </select>
          <select v-model="todoSort" class="todo-filter" title="排序方式">
            <option value="default">默认：未完成 → 优先级 → 新的在前</option>
            <option value="due">到期日近的在前</option>
            <option value="created">最新创建在前</option>
            <!-- 2026-10-01 用户第 2 条：优先级/更新时间这两种最常被要的排法补上 -->
            <option value="priority">优先级从高到低</option>
            <option value="updated">最近更新在前</option>
          </select>
          <select v-model="todoFilter" class="todo-filter">
            <option value="all">全部</option>
            <option value="active">未完成</option>
            <option value="done">已完成</option>
          </select>
          <button class="ghost batch-mode-btn" :class="{ active: todoBatchMode }" @click="toggleTodoBatchMode"
            title="开启批量选择，点击卡片即勾选/取消">
            <span v-if="!todoBatchMode">☑ 多选</span>
            <span v-else>☑ <i style="color:#fff">{{ selectedTodoBatch.length || 0 }}</i></span>
          </button>
        </div>
      </div>
      <div v-if="todoBatchMode" class="batch-bar">
        <span class="batch-count">已选 {{ selectedTodoBatch.length }}</span>
        <button class="ghost" @click="toggleSelectAllTodos">{{ selectedTodoBatch.length === filteredTodos.length ? '取消全选' : '全选' }}</button>
        <button class="ghost" title="批量标为已完成" @click="executeBatchTodoDone(true)">批量完成</button>
        <button class="ghost" title="批量标为未完成（勾错了批量改回来）" @click="executeBatchTodoDone(false)">取消完成</button>
        <button class="danger" title="批量删除（会二次确认，不可恢复）" @click="executeBatchTodoDelete">批量删除</button>
        <button class="ghost" title="退出多选模式并清空选择" @click="exitTodoBatch">取消</button>
      </div>
      <div class="todos-stats">
        共 {{ todos.length }} 条 · 未完成 {{ todoStats.active }} · 已完成 {{ todos.length - todoStats.active }}
        <span v-if="todoStats.overdue" class="todos-overdue-count">· 逾期 {{ todoStats.overdue }}</span>
        <span v-if="todoStats.hidden" class="todos-hidden">· 当前筛选遮住 {{ todoStats.hidden }} 条</span>
        <button v-if="todoStats.hidden" class="todos-clear" @click="clearTodoFilters()">清除筛选</button>
      </div>
      <div v-if="todoHealthIssue" class="todos-health">
        ⚠ 上次读取待办数据失败，坏文件已隔离保留（{{ todoHealthIssue.quarantined || todoHealthIssue.file }}）——
        原文件没有被覆盖，可以人工救回。错误：{{ todoHealthIssue.error }}
      </div>
      <div class="todos-note">您可以在此添加临时便签，仅供个人备忘使用。需要暂存或传递提示词的，请走「日志」页签。</div>
      <div v-if="todoDragOver" class="todo-drop-hint">松手导入：txt/md 每行一条待办</div>
      <div class="todos-list" :class="{ 'as-grid': todoView === 'grid', batching: todoBatchMode }">
        <div v-if="!filteredTodos.length" class="empty-state">
          <div class="empty-icon">{{ todos.length ? '🔍' : '✓' }}</div>
          <div class="empty-text">{{ todos.length ? '没有符合当前筛选的待办' : '暂无待办' }}</div>
          <button v-if="todos.length" class="todos-clear" @click="clearTodoFilters()">清除筛选</button>
        </div>
        <!-- 待办行＝**两行卡**（2026-09-29 用户拍板：「待办行改成两行卡」）——
             上行：置顶徽标 + 标题（标题占满整行，不再和一堆按钮抢宽度）
             下行：优先级 / 项目 / 到期 · 右侧动作按钮
             勾选框跨两行。卡片网格视图**共用这一份 DOM**，只换 grid 模板（不重写第二遍卡片）。 -->
        <div
          v-for="todo in filteredTodos"
          :key="todo.id"
          class="todo-item"
          :class="{ done: todo.done, prio: localPriority(todo.priority) === '高', pinned: todo.pinned, selected: todoBatchMode && selectedTodoBatch.includes(todo.id) }"
          @click="onTodoItemClick(todo)"
          @contextmenu.prevent="openTodoMenu($event, todo)"
        >
          <input
            type="checkbox"
            class="todo-chk"
            :checked="todoBatchMode ? selectedTodoBatch.includes(todo.id) : todo.done"
            @click.stop
            @change="todoBatchMode ? toggleTodoBatchSelect(todo.id) : toggleTodo(todo.id)"
          />
          <div class="todo-body">
            <div class="todo-line">
              <span v-if="todo.pinned" class="todo-pin" title="已置顶">📌</span>
              <span class="todo-title" @click.stop="todoBatchMode ? toggleTodoBatchSelect(todo.id) : openTodoEditor(todo)" title="点击编辑：内容 / 项目 / 优先级 / 到期日（多选模式下 = 勾选）">{{ todo.title }}</span>
            </div>
            <div class="todo-line metas">
              <span class="todo-prio" :class="'prio-' + prioClass(todo.priority)">{{ localPriority(todo.priority) }}</span>
              <span v-if="todo.project" class="todo-project">{{ (projects.find(p => p.id === todo.project)?.name) || todo.project }}</span>
              <span v-if="todo.due" class="todo-due" :class="{ overdue: isOverdue(todo) }"
                    :title="'到期日：' + todo.due + (isOverdue(todo) ? `（已逾期 ${overdueDays(todo)} 天）` : '')">
                📅 {{ todo.due }}<template v-if="isOverdue(todo)"> · 逾期 {{ overdueDays(todo) }} 天</template>
              </span>
            </div>
          </div>
          <div class="todo-acts" v-show="!todoBatchMode">
            <button class="todo-assign" title="指派到期日（会显示在日历上）" @click.stop="openCalAssignTodo(todo.id)">📅</button>
            <button class="todo-edit" title="编辑（已完成也能改）" @click.stop="openTodoEditor(todo)">改</button>
            <button class="todo-del" title="删除这条待办" @click.stop="deleteTodo(todo.id)">×</button>
          </div>
        </div>
      </div>
    </main>

    <!-- 待办编辑弹窗（2026-09-25 第 12、14 条）：大框，写长内容不憋屈；已完成也能改 -->
    <div id="todo-edit-overlay" class="overlay" v-if="todoEdit_" @click.self="closeTodoEditor()">
      <div id="todo-edit-modal">
        <h3>{{ todoEdit_.id ? '编辑待办' : '新建待办' }}</h3>
        <label>内容</label>
        <textarea v-model="todoEdit_.title" class="tall" placeholder="待办内容（可以写长一点）"></textarea>
        <div class="te-row">
          <div>
            <label>项目</label>
            <select v-model="todoEdit_.project" class="logsel">
              <option value="">（不归属）</option>
              <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
            </select>
          </div>
          <div>
            <label>优先级</label>
            <select v-model="todoEdit_.priority" class="logsel">
              <option v-for="s in ['高', '中', '低']" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <div>
            <label>到期日</label>
            <input type="date" v-model="todoEdit_.due" />
          </div>
        </div>
        <div class="hint todo-edit-donehint" v-if="todoEdit_.done">这条已勾选完成 —— 仍然可以修改内容和到期日。</div>
        <div class="acts">
          <button class="ghost" @click="closeTodoEditor()">取消</button>
          <button class="pri" :disabled="todoEditSaving" @click="saveTodoEdit">{{ todoEditSaving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- Logs view -->
    <main id="board" class="logs-view" v-else-if="curView === 'logs'"
      @dragenter.prevent="dragEnter('log')"
      @dragover.prevent="dragPulse()"
      @dragleave="dragLeave('log')"
      @drop="onLogDrop"
      :class="{ 'drop-target': logDragOver }"
    >
      <div class="logs-header">
        <h3>执行日志</h3>
        <div class="logs-ctrls">
          <input
            v-model="logSearchInput"
            placeholder="搜索日志..."
            class="log-search"
            @keydown.enter="executeLogSearch"
          />
          <!-- 状态筛选下拉已被**分区**取代（2026-09-28 用户第 5 条）：
               状态是一个"要同时看三样"的东西，用单选下拉只会把画面切碎。
               现在只在下面按 进行中/待处理/已完成/已归档 分区。 -->
          <select v-model="logProjectFilter" class="log-filter" @change="loadLogs">
            <option value="">全部项目</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
          </select>
          <!-- 排序（2026-10-01 用户第 2 条：日志/待办/看板的排序筛选要灵活）。
               日志此前**只能**按创建倒序，连正序都翻不过来 —— 与待办/看板对齐成一个下拉。 -->
          <select v-model="logSort" class="log-filter" title="排序方式">
            <option value="created_desc">最新创建在前</option>
            <option value="created_asc">最早创建在前</option>
            <option value="date_desc">按归属日期（新→旧）</option>
            <option value="title_asc">按标题排序</option>
          </select>
          <!-- 低频筛选收进抽屉（2026-09-28 用户第 5 条）：Agent / 日期范围此前与搜索框
               并排摊开，6 个控件挤一条线。抽屉里有值时按钮上带角标，避免"筛了却忘了"。 -->
          <button class="ghost log-more-btn" :class="{ on: logMoreFilterOpen }"
            title="更多筛选：按 Agent、按日期范围" @click="toggleLogMoreFilter">
            ⚙ 更多筛选<span v-if="logMoreFilterCount" class="more-badge">{{ logMoreFilterCount }}</span>
          </button>
          <template v-if="logMoreFilterOpen">
            <select v-model="logAgentFilter" class="log-filter" @change="loadLogs">
              <option value="">全部 Agent</option>
              <option v-for="a in agentPresets" :key="a" :value="a">{{ a }}</option>
            </select>
            <input v-model="logDateFrom" type="date" class="log-filter" title="起始日期（含）" @change="loadLogs" />
            <span class="log-filter-sep">→</span>
            <input v-model="logDateTo" type="date" class="log-filter" title="截止日期（含）" @change="loadLogs" />
            <button class="ghost" title="清空 Agent 与日期筛选" @click="clearLogMoreFilters">清空</button>
          </template>
          <!-- 2026-09-23：日志批量操作入口（用户第1条） -->
          <button class="ghost batch-mode-btn" :class="{ active: logBatchMode }" @click="toggleLogBatchMode" title="开启批量选择，点击卡片即勾选/取消">
            <span v-if="!logBatchMode">☑ 多选</span>
            <span v-else>☑ <i style="color:#fff">{{ selectedLogBatch.length || 0 }}</i></span>
          </button>
          <button @click="openNewLog">+ 新建日志</button>
          <!-- 分区｜按链 分段开关（2026-09-29 第 3 条方案二）：
               默认仍是「分区」—— 加视图不改旧的；「按链」把接力链串成一条竖轨。 -->
          <div class="log-view-seg" title="分区：按状态分块（默认）；按链：把接力链（续自）串成一条竖轨">
            <button class="lvs" :class="{ on: logsViewMode === 'groups' }" @click="setLogsViewMode('groups')">分区</button>
            <button class="lvs" :class="{ on: logsViewMode === 'chain' }" @click="setLogsViewMode('chain')">按链</button>
          </div>
          <button class="ghost" title="把外部 txt / md / log 导入成日志（也可直接把文件拖进来）" @click="importLogFile">↑ 导入文件</button>
          <!-- 「清理超期」到底做什么：把 status=completed 且 retain_until 已过的日志
               批量改成 archived（**只改状态，不删文件**，logs.ts:cleanupLogs）。
               此前只有这四个字，用户不知道它有什么用（第 3 条）。 -->
          <button class="ghost"
            title="把「已完成」且保留期已过的日志批量标为「已归档」（只改状态，不删除文件）。保留期在点「完成」时填写"
            @click="executeLogCleanup">清理超期</button>
        </div>
      </div>
      <div v-if="logBatchMode" class="batch-bar">
        <span class="batch-count">已选 {{ selectedLogBatch.length }}</span>
        <button class="ghost" @click="toggleSelectAllLogs">{{ selectedLogBatch.length === filteredLogs.length ? '取消全选' : '全选' }}</button>
        <button class="ghost" title="批量完成" @click="executeBatchLogComplete">批量完成</button>
        <button class="ghost" title="批量归档" @click="executeBatchLogArchive">批量归档</button>
        <button class="danger" title="批量销毁" @click="executeBatchLogDestroy">批量销毁</button>
        <button class="ghost" title="退出多选模式并清空选择" @click="selectedLogBatch = []; logBatchMode = false">取消</button>
      </div>
      <div v-if="logDragOver" class="log-drop-hint">松手导入：每个文件生成一条日志（支持 txt / md / log）</div>
      <div class="logs-list">
        <div v-if="!filteredLogs.length" class="empty-state">
          <div class="empty-icon">📋</div>
          <div class="empty-text">暂无执行日志</div>
        </div>
        <!-- 按状态分区（2026-09-28 用户第 2/5 条）：
             用户原话「分不清哪些没跑、哪些 Agent 正在跑、哪些跑完了」——
             那就让这三种东西在屏幕上**各占一块**，而不是靠一个状态下拉去筛。
             分区顺序 = 关心的顺序：置顶 → 进行中 → 待处理 → 已完成 → 已归档。
             空分区直接不渲染（不留一个"0 条"的空壳）。 -->
        <template v-for="g in renderSections" :key="g.key">
          <!-- 链头（按链视图，2026-09-29 方案二）：链名 + 段数 + 起于/最近 + 两个动作 -->
          <div v-if="g.chain" class="chain-header">
            <span class="chain-ic">⛓</span>
            <span class="chain-name">{{ g.chain.name }}</span>
            <span class="chain-meta">{{ g.chain.count }} 段 · 起于 {{ g.chain.since }} · 最近活跃 {{ g.chain.recent }}</span>
            <span class="chain-grow"></span>
            <button class="ghost" title="从这条链的最新一格接力：出清旧的 + 建新日志（一个对话框做完四件事）" @click="openRelay(g.chain.tail)">＋ 从链尾继续</button>
            <button class="ghost" title="复制链尾日志 ID —— 贴给 AI，get_log 会带回整条链的上下游" @click="copyId(g.chain.tail.id)">⧉ 复制链 ID</button>
          </div>
          <!-- 分区头（分区视图，原样） -->
          <div v-else-if="g.label" class="log-group-sep" :class="'g-' + g.key">
            <button class="log-group-toggle" @click="toggleLogGroup(g.key)">
              <span class="chev" :class="{ open: !isLogGroupCollapsed(g.key) }"></span>
              <span class="gdot"></span>
              <span class="glabel">{{ g.label }}</span>
              <span class="gn">{{ g.logs.length }}</span>
            </button>
            <span v-if="g.hint" class="log-group-hint">{{ g.hint }}</span>
          </div>
          <!-- 分区/单条 = display:contents（对布局完全透明，卡片仍是 .logs-list 的弹性子项）；
               链 = 竖轨包裹（轨道线 + 节点圆点画在 .chain-rail 上）。 -->
          <div class="log-section" :class="{ 'chain-rail': !!g.chain }" v-show="g.chain || !isLogGroupCollapsed(g.key)">
          <div
            v-for="log in g.logs"
            :key="log.id"
            class="log-card"
            :class="{ active: log.status === 'active', running: log.running, completed: log.status === 'completed', archived: log.status === 'archived', pinned: log.pinned, selected: logBatchMode && selectedLogBatch.includes(log.id) }"
            @click="onLogCardClick(log)"
            @contextmenu.prevent="openLogMenu($event, log)"
          >
          <div class="log-card-head">
            <span v-if="log.pinned" class="log-pin" title="已置顶：钉在列表最上面">📌</span>
            <span class="log-status-badge" :class="logStatusClass(log)">{{ logStatusLabel(log) }}</span>
            <span class="log-card-title">{{ log.title || '(无标题)' }}</span>
            <span v-if="log.attachments && log.attachments.length" class="log-attach-badge"
              :title="log.attachments.length + ' 个附件（截图 / 报告）'">📎{{ log.attachments.length }}</span>
            <span class="log-card-date">{{ formatDate(log.created) }}</span>
          </div>
          <div class="log-card-body">{{ truncate(log.content, 120) }}</div>
          <div class="log-card-meta">
            <span v-if="log.project" class="log-project">{{ (projects.find(p => p.id === log.project)?.name) || log.project }}</span>
            <span v-if="log.taskId" class="log-task">📍 {{ log.taskId }}</span>
            <span v-if="log.agentName" class="log-agent" title="本次执行 Agent">🤖 {{ log.agentName }}</span>
            <!-- 2026-10-03 用户反馈1（卡 task-20261003-001）：上次的执行 Agent 单独标出 ——
                 找上一段的会话就去这个 Agent 里找，不再和「本次」混在一个字段里 -->
            <span v-if="log.prevAgentName" class="log-prev-agent"
              title="上次的执行 Agent（接力来源那段是谁跑的）—— 找上次的会话就去这个 Agent 里找">⤴ 上次 {{ log.prevAgentName }}</span>
            <span v-if="log.sessionId" class="log-session" :title="log.sessionId">🔗 {{ log.sessionId.slice(0, 16) }}{{ log.sessionId.length > 16 ? '…' : '' }}</span>
            <span v-if="log.completed" class="log-completed">✓ {{ formatDate(log.completed) }}</span>
            <!-- 接力链（2026-09-29 方案二）：继承来的日志挂一个可复制的链标签 -->
            <span v-if="log.continueFrom" class="chain-tag"
              :title="'接力自 ' + log.continueFrom + ' —— 点一下复制它的 ID'"
              @click.stop="copyId(log.continueFrom)">⛓ 续自 {{ shortLogId(log.continueFrom) }}</span>
            <!-- 2026-09-29 用户第 2 条：日志没有可复制给 AI 的 ID，只能整篇注入 —— 卡面上直接给 ID，点一下只复制 ID -->
            <span class="log-id" title="日志 ID —— 点一下复制，贴给 AI 就能精确定位这一条（不必整篇注入）"
              @click.stop="copyId(log.id)">⧉ {{ log.id }}</span>
          </div>
          <!-- 操作行（2026-09-28 用户第 2 条重排）：
               「进行中」是一个**手动开关**，可开可关；完成/归档**不要求**先打开它，
               所以「完成」按钮在任何未完成/未归档的日志上都直接可用。 -->
          <div class="log-card-actions" @click.stop>
            <button class="ghost" title="编辑这条日志（点击卡片是只读预览）" @click="openLog(log)">✏️ 编辑</button>
            <button class="ghost" title="复制成可直接粘给 agent 的提示词块" @click="copyLogAsPrompt(log.id)">📋 复制</button>
            <!-- 接力（2026-09-29 方案二）：完成态才有「下一段」——出清 + 新建 + 可开跑在一个对话框里做完 -->
            <button v-if="log.status === 'completed'" class="ghost relay-btn"
              title="接力：出清这条 + 建新日志继承「下一步」/项目/任务/Agent —— 一个对话框做完四件事"
              @click="openRelay(log)">⏭ 从这里继续</button>
            <button class="ghost log-run-btn" :class="{ on: log.running }"
              :title="log.running
                ? '撤销「进行中」标记，回到「待处理」'
                : '手动标为「进行中」——只有点了它，这条才算正在跑（不会自动打上）'"
              @click="toggleLogRunning(log)">{{ log.running ? '⏸ 撤销进行中' : '▶ 标为进行中' }}</button>
            <button v-if="log.status !== 'completed' && log.status !== 'archived'" class="ghost"
              title="标记完成（不需要先标「进行中」）" @click="completeLogItem(log.id)">完成</button>
            <button v-if="log.status === 'completed' || log.status === 'archived'" class="ghost"
              title="撤销完成 / 撤销归档，退回「待处理」（只改状态，不删文件）"
              @click="reopenLogItem(log.id)">↩ 撤销</button>
            <button v-if="log.status !== 'archived'" class="ghost" title="收进「已归档」分区" @click="archiveLogItem(log.id)">归档</button>
            <button class="danger" @click="destroyLogItem(log.id)">销毁</button>
          </div>
        </div>
          </div>
        </template>
      </div>
    </main>

    <!-- Launchpad view -->
    <main id="board" class="launchpad" v-else-if="curView === 'launchpad'">
      <div class="lp-header">
        <h3>启动台</h3>
        <div class="lp-ctrls">
          <button @click="openAddApp">+ 添加应用</button>
          <button class="ghost" @click="openConfigPath">打开配置</button>
          <button class="ghost" @click="refreshApps">⟳ 刷新</button>
        </div>
      </div>
      <div class="lp-grid">
        <div
          v-for="app in launchpadApps"
          :key="app.id"
          class="lp-card"
          @click="openEditApp(app)"
        >
          <div class="lp-icon">{{ app.name.charAt(0) }}</div>
          <div class="lp-info">
            <div class="lp-name">{{ app.name }}</div>
            <div class="lp-desc">{{ app.description || app.path }}</div>
          </div>
          <button class="lp-launch" :title="'将启动：' + (app.cmd || app.path)" @click.stop="launchAppClick(app)">启动</button>
        </div>
      </div>
    </main>

    <!-- 任务卡右键菜单：卡上的高频操作不必再绕进详情面板 -->
    <div v-if="ctxMenu" class="ctx-backdrop" @click="closeCardMenu" @contextmenu.prevent="closeCardMenu"></div>
    <div v-if="ctxMenu" class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }">
      <div class="ctx-title">{{ ctxMenu.task.title || ctxMenu.task.id }}</div>
      <button @click="ctxRun(openCard)">🔍 查看详情</button>
      <button @click="ctxRun(openEdit)">✏️ 编辑</button>
      <button v-if="ctxMenu.task.status === '待验收'" @click="ctxRun(openReview)">✅ 验收裁决</button>
      <button @click="ctxRun(openCalAssignTask)">📅 指派时间</button>
      <button @click="ctxRun(copyTaskId)">📋 复制 ID</button>
      <button @click="ctxRun(copyTaskTitle)">🔤 复制标题</button>
      <!-- 弹药库（卡 031）：卡内容 + 六字段派工单 + 约束卡七条 + 验收四条 + 驳回纪律。
           纯文本拼接、零智能；**只复制，不派发** —— 派发永远留人手（9/20 判死 agent 派活）。 -->
      <button @click="ctxRun(copyTaskAsDispatch)" title="拼一份可直接粘给 agent 的派工单（六字段 + 约束卡七条 + 验收四条 + 驳回纪律）">📐 复制为派工单</button>
      <div class="ctx-sep"></div>
      <button @click="ctxRun(archiveTask)">📦 归档</button>
      <button class="danger" @click="ctxRun(deleteTaskById)">🗑 删除</button>
    </div>

    <!--
      日志 / 待办右键菜单（2026-09-26 卡 037 第一批 · 用户口径）
      规格铁律（用户原话）：菜单是「出口加速器」，不是「入口加字段」；一层封顶、单项 ≤7；
      破坏性动作（删除）放最末且二次确认；任何「发给 AI / 智能总结」永不进菜单。
    -->
    <div v-if="ctxOther" class="ctx-backdrop" @click="closeOtherMenu" @contextmenu.prevent="closeOtherMenu"></div>
    <div v-if="ctxOther" class="ctx-menu ctx-other" :style="{ left: ctxOther.x + 'px', top: ctxOther.y + 'px' }">
      <template v-if="ctxOther.kind === 'log'">
        <div class="ctx-title">{{ ctxOther.item.title || ctxOther.item.id }}</div>
        <button @click="ctxOtherRun(copyLogFull)">📄 复制全文</button>
        <button @click="ctxOtherRun(copyLogMeta)">🏷 复制带元信息（日期 + 项目）</button>
        <button @click="ctxOtherRun(copyAndDispatchLog)">📤 复制并标记已派</button>
        <div class="ctx-sep"></div>
        <!-- 「进行中」是手动开关（2026-09-28）：右键里也放一份，不进编辑页就能打/撤 -->
        <button @click="ctxOtherRun(toggleLogRunning)">{{ ctxOther.item.running ? '⏸ 撤销「进行中」' : '▶ 标为「进行中」' }}</button>
        <button @click="ctxOtherRun(toggleLogPin)">{{ ctxOther.item.pinned ? '📌 取消置顶' : '📌 置顶' }}</button>
        <button @click="ctxOtherRun(changeLogProject)">🏷 改项目归属…</button>
        <button @click="ctxOtherRun(runArchiveLog)">📦 归档</button>
        <div class="ctx-sep"></div>
        <button class="danger" @click="ctxOtherRun(runDestroyLog)">🗑 删除（二次确认）</button>
      </template>
      <template v-else>
        <div class="ctx-title">{{ ctxOther.item.title || '(无标题)' }}</div>
        <button @click="ctxOtherRun(toggleTodoPin)">{{ ctxOther.item.pinned ? '📌 取消置顶' : '📌 置顶' }}</button>
        <button @click="ctxOtherRun(copyTodoText)">📄 复制内容</button>
        <button @click="ctxOtherRun(editTodoFromMenu)">✏️ 编辑</button>
        <div class="ctx-sep"></div>
        <button class="danger" @click="ctxOtherRun(deleteTodoFromMenu)">🗑 删除（二次确认）</button>
      </template>
    </div>

    <!-- 改项目归属（卡 037 右键菜单）—— 应用内轻浮层，不用 Electron 不实现的 prompt -->
    <div v-if="logProjectPicker" class="overlay" @click.self="logProjectPicker = null">
      <div id="log-project-modal">
        <h3>改项目归属</h3>
        <div class="hint">{{ logProjectPicker.title || logProjectPicker.id }}（当前：{{ logProjectPicker.project || '未归属' }}）</div>
        <div class="proj-pick-list">
          <button class="skills-btn" @click="applyLogProject('')">（不归属）</button>
          <button v-for="p in projects" :key="p.id" class="skills-btn" @click="applyLogProject(p.id)">
            {{ p.name }} · {{ p.id }}
          </button>
        </div>
        <div class="trash-preview-actions">
          <button class="trash-btn" @click="logProjectPicker = null">取消</button>
        </div>
      </div>
    </div>

    <!-- Review modal -->
    <div id="review-overlay" class="overlay" v-if="reviewModal" @click.self="reviewModal = null">
      <div id="review-modal">
        <h3>✅ 验收裁决</h3>
        <div class="review-info">
          <div class="review-task-title">{{ reviewModal.title }}</div>
          <div class="review-task-id">{{ reviewModal.id }}</div>
        </div>
        <!-- 2026-09-25（用户第 7 条）：原来这里只有「驳回理由」一个输入框 ——
             通过按钮虽然在，但通过时**无处写结论**，等于「通过」这件事不留痕。
             改成双用的验收结论：驳回必填、通过选填，两者都写进「结果记录」。 -->
        <label>验收结论（驳回必填 · 通过选填，均写入结果记录）</label>
        <textarea v-model="reviewReason" class="review-reason" placeholder="驳回：哪里不行、要改什么；通过：验收依据 / 遗留事项"></textarea>
        <div class="acts">
          <button class="ghost" @click="reviewModal = null">取消</button>
          <button class="danger" @click="rejectTask">↩ 驳回</button>
          <button class="ok" @click="acceptTask">✅ 通过</button>
        </div>
      </div>
    </div>

    <!-- 关于（左上角方形 LOGO 入口）2026-09-25 用户第 12 条：绒花墨坊有、方寸没有 -->
    <div v-if="aboutOpen" class="overlay" @click.self="aboutOpen = false">
      <div id="about-modal">
        <h3>关于方寸</h3>
        <div class="about-brand">
          <span class="about-logo">方</span>
          <div>
            <b>方寸 tegula</b>
            <div class="about-sub">本地优先的 agent 任务调度台</div>
          </div>
        </div>
        <div class="about-rows">
          <div><span class="k">版本</span><span class="v">{{ appVersion || '读取中…' }}</span></div>
          <div><span class="k">数据目录</span><span class="v about-path" :title="dataDir">{{ dataDir || '—' }}</span></div>
          <div><span class="k">当前视图</span><span class="v">{{ curView }} · {{ countText }}</span></div>
          <div><span class="k">任务数据</span><span class="v about-path">task-data/ · 纯 Markdown + YAML</span></div>
        </div>
        <div class="acts">
          <button class="ghost" @click="openAppLogDir">打开日志目录</button>
          <button class="ghost" @click="bkOpenDir">打开备份目录</button>
          <button class="ghost" @click="aboutOpen = false">关闭</button>
        </div>
        <p class="about-note">
          数据是你的：任务就是 <code>task-data/</code> 里的 Markdown 文件，不进 git；
          删除只移入 <code>.trash/</code>；本地备份在 <code>backups/</code>。
        </p>
      </div>
    </div>

    <!-- 日志只读预览（2026-09-25 用户第 13 条）：用户明说日志用得比看板多，
         而日志正文此前是纯文本 —— 全项目只有任务预览一处 v-html。
         现在单击日志卡 = 打开只读预览（复用 renderBody：marked + DOMPurify，
         表格/任务列表/代码/图片都支持），编辑移进预览与卡片操作行。 -->
    <div v-if="logPreview" class="overlay" @click.self="logPreview = null">
      <div id="log-preview-modal">
        <h3>
          <span class="log-status-badge" :class="logStatusClass(logPreview)">{{ logStatusLabel(logPreview) }}</span>
          {{ logPreview.title || '(无标题)' }}
        </h3>
        <div class="lp-meta">
          <span class="log-id" title="日志 ID —— 点一下复制，贴给 AI 就能精确定位这一条"
            @click="copyId(logPreview.id)">⧉ {{ logPreview.id }}</span>
          <span v-if="logPreview.project">{{ (projects.find(p => p.id === logPreview.project)?.name) || logPreview.project }}</span>
          <span v-if="logPreview.taskId">📍 {{ logPreview.taskId }}</span>
          <span v-if="logPreview.agentName">🤖 {{ logPreview.agentName }}</span>
          <span>{{ formatDate(logPreview.created) }}</span>
          <span v-if="logPreview.completed">✓ {{ formatDate(logPreview.completed) }}</span>
        </div>
        <label>执行内容</label>
        <div class="body-text markdown" v-html="renderBody(logPreview.content)"></div>
        <template v-if="logPreview.nextSteps">
          <label>下一步</label>
          <div class="body-text markdown" v-html="renderBody(logPreview.nextSteps)"></div>
        </template>

        <!-- 附件（2026-10-01 用户第 1 条 → 卡 036）：日志 ↔ 文件的唯一入口。
             图片就地内联（走 logs:attachmentData 的 data URL，不碰 file:// 权限），
             其它类型给「用系统程序打开」；移除只解除关联，文件仍留在数据目录。 -->
        <div class="attach-block" data-attach-block>
          <div class="attach-head">
            <label class="attach-lbl">附件</label>
            <button class="ghost attach-add" @click="attachAdd(logPreview.id)">＋ 添加文件…</button>
          </div>
          <div v-if="!logPreview.attachments || !logPreview.attachments.length" class="attach-empty">
            还没有附件 —— 截图、分析报告、日志文件都可以挂上来（文件会复制进数据目录，随日志一起备份）
          </div>
          <div v-else class="attach-grid">
            <div class="attach-item" v-for="a in logPreview.attachments" :key="a">
              <img v-if="isImageRel(a) && attachSrc(a)" :src="attachSrc(a)" :alt="attachName(a)"
                :title="attachName(a) + '（点一下用系统程序打开）'" @click.stop="attachOpen(a)" />
              <div v-else class="attach-file" :title="a" @click.stop="attachOpen(a)">📄 {{ attachName(a) }}</div>
              <div class="attach-cap">
                <span class="attach-fn" :title="a">{{ attachName(a) }}</span>
                <button class="attach-x" title="解除关联（文件保留，不删）"
                  @click.stop="attachRemove(logPreview.id, a)">✕</button>
              </div>
            </div>
          </div>
        </div>

        <div class="acts">
          <button class="ghost" @click="openLogFromPreview">✏️ 编辑</button>
          <button class="ghost" @click="copyLogAsPrompt(logPreview.id)">📋 复制</button>
          <button class="ghost" @click="logPreview = null">关闭</button>
        </div>
      </div>
    </div>

    <!-- 回收站正文预览（2026-09-26 用户：「每个卡片都是不能点的死卡」）-->
    <div id="trash-preview-overlay" class="overlay" v-if="trashPreview" @click.self="trashPreview = null">
      <div id="trash-preview-modal">
        <h3>
          {{ trashPreview.item.title || trashPreview.item.id }}
          <span class="st" :class="'st-' + statusClass(trashPreview.item.status)">{{ trashPreview.item.status || '—' }}</span>
        </h3>
        <div class="meta">
          <div><span class="k">文件名</span><span class="v">{{ trashPreview.item.name }}</span></div>
          <div><span class="k">ID</span><span class="v">{{ trashPreview.item.id }}</span></div>
          <div><span class="k">项目</span><span class="v">{{ trashPreview.item.project || '—' }}</span></div>
          <div><span class="k">大小</span><span class="v">{{ trashPreview.item.bytes || 0 }} B</span></div>
          <div><span class="k">删于</span><span class="v">{{ trashPreview.item.mtime ? relativeTime(trashPreview.item.mtime) : '—' }}</span></div>
        </div>
        <div v-if="trashPreview.loading" class="hint">读取中…</div>
        <div v-else-if="trashPreview.error" class="skills-error">{{ trashPreview.error }}</div>
        <div v-else class="trash-preview-body">
          <div v-if="trashPreview.truncated" class="hint">文件很大，只显示前 512 KB</div>
          <div class="trash-preview-text markdown" v-html="renderBody(trashPreview.text)"></div>
        </div>
        <div class="trash-preview-actions">
          <button class="trash-btn" @click="restoreFromPreview()">↩ 还原这一份</button>
          <button class="trash-btn danger" @click="purgeFromPreview()">🗑 彻底删除（不可撤销）</button>
          <button class="trash-btn" @click="trashPreview = null">关闭</button>
        </div>
      </div>
    </div>

    <!-- Task preview modal -->
    <div id="roverlay" class="overlay" v-if="previewTask" @click.self="previewTask = null">
      <div id="rmodal">
        <h3>
          {{ previewTask.title || previewTask.id }}
          <span class="st" :class="'st-' + statusClass(previewTask.status)">{{ previewTask.status }}</span>
        </h3>
        <div class="meta">
          <div><span class="k">ID</span><span class="v">{{ previewTask.id }}</span></div>
          <div><span class="k">项目</span><span class="v">{{ previewTask.project || '—' }}</span></div>
          <div><span class="k">优先级</span><span class="v">{{ priorityLabel(previewTask.priority) }}</span></div>
          <div v-if="previewTask.assignee"><span class="k">指派</span><span class="v">{{ previewTask.assignee }}</span></div>
          <div><span class="k">时间</span><span class="v">{{ previewTimeLabel(previewTask) }}</span></div>
          <div v-if="previewTask.batch"><span class="k">批次</span><span class="v">{{ previewTask.batch }}</span></div>
          <div v-if="previewTask.archived"><span class="k">来源</span><span class="v">📦 已归档</span></div>
          <div><span class="k">创建</span><span class="v">{{ formatDate(previewTask.created) }}</span></div>
          <div><span class="k">更新</span><span class="v">{{ formatDate(previewTask.updated) }}</span></div>
        </div>
        <div class="body" v-if="previewTask.body">
          <label>正文</label>
          <div class="body-text markdown" v-html="renderBody(previewTask.body)" @change="onBodyChange"></div>
        </div>
        <div class="logs-section" v-if="previewTask">
          <label>关联日志 ({{ taskLogs.length }})</label>
          <div class="task-logs-list">
            <!-- 2026-09-28 用户：这条列表项此前**没有任何点击处理器** —— 单击、双击都没反应，
                 人只能反复点、以为是双击才行。现在单击 = 打开只读预览（与日志页一致）。 -->
            <div v-for="log in taskLogs" :key="log.id" class="task-log-item"
              title="点击查看这条日志"
              @click="openLogPreview(log)">
              <span class="log-status-badge" :class="logStatusClass(log)">{{ logStatusLabel(log) }}</span>
              <div class="task-log-main">
                <div class="task-log-title">{{ log.title || '(无标题)' }}</div>
                <div class="task-log-meta">{{ formatDate(log.created) }}</div>
              </div>
              <button
                v-if="log.status !== 'completed' && log.status !== 'archived'"
                class="ghost task-log-done"
                title="一键标记完成（默认保留 7 天）"
                @click.stop="quickCompleteLog(log)"
              >✓ 完成</button>
            </div>
            <div v-if="!taskLogs.length" class="hint">该任务暂无关联日志</div>
          </div>
          <button class="add-note-btn" @click="openLogForTask(previewTask.id)">+ 写一条执行日志</button>
        </div>
        <div class="acts task-acts">
          <div class="acts-group">
            <span class="acts-label">流转</span>
            <button
              v-if="previewTask.status === '完成' || previewTask.status === '驳回'"
              class="ok"
              title="从归档/终态还原回「待办」"
              @click="restoreTask(previewTask)"
            >↩ 还原</button>
            <!-- 终态的「删除」不放这里：它与「操作」组里那个删除按钮重复（用户 2026-09-25 第 5 条）。
                 底部「操作」组的删除对任何状态都在，单一入口，不重复。 -->
            <template v-else>
              <!-- 验收裁决弹窗（accept / reject + 驳回理由）此前**没有任何入口** ——
                   后端 review:accept / review:reject 通道齐全，openReview 也写好了，
                   但没人调用它。这里补上正式入口：待验收任务可走完整裁决流程，
                   不想走流程的仍可用下面的「完成/驳回」直达。 -->
              <button
                v-if="previewTask.status === '待验收'"
                class="pri"
                title="正式验收裁决：通过 / 驳回（驳回必须填理由，会写进结果记录）"
                @click="openReview(previewTask)"
              >✅ 验收裁决</button>
              <button
                class="ok"
                title="直接标记完成（跳过验收，适用于挂死/废弃任务）"
                @click="forceCloseTask(previewTask, '完成')"
              >✓ 完成</button>
              <button
                class="danger"
                title="直接驳回（跳过验收，适用于挂死/废弃任务）"
                @click="forceCloseTask(previewTask, '驳回')"
              >✕ 驳回</button>
            </template>
            <button
              class="warning"
              title="移入归档视图（文件移到 task-data/archive/）。任何状态都可以归档"
              @click="archiveTask(previewTask)"
            >📦 归档</button>
          </div>
          <div class="acts-group">
            <span class="acts-label">操作</span>
            <button class="ok" title="编辑任务的全部字段" @click="openEdit(previewTask)">✏️ 编辑</button>
            <button class="ghost" title="指派开始/截止时间（时间段会显示在日历上）" @click="openCalAssignTask(previewTask)">📅 指派时间</button>
            <button class="ghost" title="复制任务 ID" @click="copyId(previewTask.id)">📋 ID</button>
            <button class="ghost" title="在文件管理器中定位这个任务的 markdown 文件" @click="openTaskFile(previewTask)">📄 文件</button>
            <button class="ghost" title="复制一份任务" @click="copyTaskClick(previewTask.id)">📑 副本</button>
            <button class="danger" title="删除任务（会进入 trash，可人工找回）" @click="deleteTask(previewTask.id)">🗑 删除</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Roadmap view -->
    <!-- Calendar view -->
    <main id="board" class="calendar-view" v-else-if="curView === 'calendar'">
      <div class="calhead">
        <button class="ghost" @click="calMove(-1)">&#9664; 上月</button>
        <span class="m">{{ calYear }} 年 {{ calMonth + 1 }} 月</span>
        <button class="ghost" @click="calMove(1)">下月 &#9654;</button>
        <button class="ghost" @click="calToday">回到本月</button>
        <label class="chk cal-chk"><input type="checkbox" :checked="calShowTodos" @change="calToggleTodos" /> 显示待办</label>
        <!-- 2026-09-23（用户第 3 条）：日志上日历 -->
        <label class="chk cal-chk"><input type="checkbox" :checked="calShowLogs" @change="calToggleLogs" /> 显示日志</label>
        <span class="cal-hint">拖动条目可改期；点条目可指派时间；时间段任务会横跨多天</span>
      </div>
      <div class="calgrid">
        <div v-for="d in CAL_DOW" :key="d" class="caldow">{{ d }}</div>
        <div v-for="(cell, i) in calCells" :key="i" class="calcell"
          :class="{ blank: !cell, today: cell && cell.isToday, past: cell && cell.isPast, dragover: cell && cell.day === calDragOverDay }"
          @dragover.prevent="cell && (calDragOverDay = cell.day)"
          @dragleave="calDragOverDay = null"
          @drop="onCalDrop($event, cell)"
        >
          <template v-if="cell">
            <div class="dnum">{{ cell.day }}</div>
            <!-- 2026-09-29 用户选「改法 A」（035 卡）：格子里最多 2 条 + 「+N 条」。
                 时间段任务不折（见 calCellShown），所以连续色带不会断头。 -->
            <div v-for="ev in calCellShown(cell)" :key="ev.kind + ev.id + '-' + cell.day"
              class="cev" :class="['span-' + ev.span, ev.kind === 'todo' ? 'cev-todo' : ev.kind === 'log' ? 'cev-log' : 'cev-task']"
              draggable="true"
              :title="(ev.kind === 'todo' ? '待办：' : ev.kind === 'log' ? '日志：' : '任务：') + ev.title + (ev.rangeDays > 1 ? `（共 ${ev.rangeDays} 天）` : '')"
              @dragstart="onCalDragStart($event, ev.id, ev.kind)"
              @click="onCalEventClick(ev)"
            >
              <span class="pd" :style="{ background: ev.kind === 'todo' ? '#5b8dd6' : ev.kind === 'log' ? '#8b7fb8' : prioColor(ev.priority) }"></span>
              <span class="t">{{ ev.title }}</span>
            </div>
            <button v-if="calCellMore(cell)" class="cal-cell-more" :title="`还有 ${calCellMore(cell)} 条，点开就地铺满这一天`"
              @click.stop="toggleCalCell(cell)">+{{ calCellMore(cell) }} 条</button>
            <button v-else-if="calCellExpanded(cell)" class="cal-cell-more less" title="收回前面几条，只留 2 条"
              @click.stop="toggleCalCell(cell)">收起</button>
          </template>
        </div>
      </div>
      <div class="calunsched">
        <!-- 2026-09-25（用户第 10 条）：底部这两排 chip 一旦多起来就是一片「横条墙」，
             视觉压迫感极强。改成默认收起的一行摘要，点开才铺开。 -->
        <button class="cal-more" :aria-expanded="calBottomOpen" @click="calBottomOpen = !calBottomOpen">
          <span class="caret" :class="{ open: calBottomOpen }">▸</span>
          未排期 <b>{{ calUnscheduled.length }}</b> 项
          <template v-if="calOtherMonths.length">· 其它月份 <b>{{ calOtherMonths.length }}</b> 个</template>
          <span class="cal-more-hint">{{ calBottomOpen ? '收起' : '展开' }}</span>
        </button>
        <div v-show="calBottomOpen" class="cal-more-body">
          <h4>
            未安排 · 无时间（{{ calUnscheduled.length }} 个）
            <span class="cal-hint-inline" v-if="calUnscheduled.length">拖动到日期格即改期，点击可直接指派时间</span>
          </h4>
          <div class="items">
          <span v-for="t in calUnscheduled" :key="t.id" class="cev chip" draggable="true"
            :title="'拖动或点击指派时间：' + (t.title || t.id)"
            @dragstart="onCalDragStart($event, t.id, 'task')"
            @click="openCalAssignTask(t)">
            <span class="pd" :style="{ background: prioColor(t.priority) }"></span>
            <span class="t">{{ t.title || t.id }}</span>
          </span>
          <span v-if="!calUnscheduled.length" class="cal-empty">本月任务都已安排时间</span>
        </div>
        <template v-if="calOtherMonths.length">
          <h4 class="cal-other-head">其它月份（{{ calOtherTotal }} 个）—— 点一下跳过去</h4>
          <div class="items">
            <span v-for="g in calOtherMonths" :key="g.key" class="cev chip other" @click="calGoto(g.year, g.month)">
              {{ g.label }} · {{ g.count }} 个 →
            </span>
          </div>
        </template>
        </div>
      </div>
    </main>

    <main id="board" class="roadmap-view" v-else-if="curView === 'roadmap'">
      <div class="roadmap-header">
        <h3>路线图</h3>
        <div class="roadmap-ctrls">
          <button class="ghost" @click="loadRoadmap">⟳ 刷新</button>
        </div>
      </div>
      <div class="roadmap-content">
        <div v-if="!roadmapData.projects || !roadmapData.projects.length" class="empty-state">
          <div class="empty-icon">🗺️</div>
          <div class="empty-text">暂无路线图数据</div>
        </div>
        <div v-for="proj in (roadmapData.projects || [])" :key="proj.id" class="roadmap-project">
          <div class="rp-header">
            <span class="rp-name">{{ proj.name }}</span>
            <span class="rp-health st" :class="'st-' + proj.health">{{ roadmapHealthLabel(proj.health) }}</span>
          </div>
          <div class="rp-batches">
            <div v-for="batch in proj.batches" :key="batch.name" class="rp-batch" :class="'rb-' + batch.status">
              <div class="rb-header">
                <span class="rb-name">{{ batch.name }}</span>
                <span class="rb-count">{{ batch.done }}/{{ batch.total }}</span>
              </div>
              <div class="rb-tasks">
                <div v-for="t in batch.tasks" :key="t.id" class="rb-task">
                  <span class="st small" :class="'st-' + statusClass(t.status)">{{ t.status }}</span>
                  <span class="rb-title">{{ t.title }}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="rp-next" v-if="proj.nextActions && proj.nextActions.length">
            <label>下一步</label>
            <div class="rp-actions">
              <div v-for="a in proj.nextActions" :key="a.taskId" class="rp-action">
                <span class="st small" :class="a.priority === '高' ? 'st-review' : 'st-todo'">{{ a.priority }}</span>
                {{ a.title }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- Edit modal -->
    <div id="modal-overlay" class="overlay" v-if="editTask_" @click.self="closeTaskEditor()">
      <div id="modal" class="task-modal">
        <h3>{{ editTask_.id ? '编辑任务' : '新建任务' }}</h3>
        <div class="tf-grid">
          <div
            v-for="spec in taskFieldSpecs"
            :key="spec.key"
            class="tf-field"
            :class="spec.span === 'full' ? 'tf-full' : 'tf-half'"
          >
            <label>{{ spec.label }}</label>

            <!-- 阻塞：不让用户手填任务 ID（现实里没人会去看 ID，更不会记得），
                 改成跟随所选项目、点选即可的挑选器。 -->
            <template v-if="spec.key === 'blockers'">
              <div class="blk-picked">
                <span v-for="id in blockerList" :key="id" class="blk-chip">
                  {{ taskTitleById(id) }}
                  <button class="blk-x" title="移除" @click="removeBlocker(id)">×</button>
                </span>
                <span v-if="!blockerList.length" class="blk-empty">未设置依赖</span>
              </div>
              <select class="blk-pick" :value="''" @change="onBlockerPick">
                <option value="">+ 从当前项目的任务里挑选…</option>
                <option v-for="t in blockerCandidates" :key="t.id" :value="t.id">
                  {{ t.title || '(无标题)' }} —— {{ t.id }}
                </option>
              </select>
            </template>

            <select v-else-if="spec.type === 'select'" v-model="editTask_[spec.key]">
              <option v-for="o in specOptions(spec)" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>

            <textarea
              v-else-if="spec.type === 'textarea'"
              v-model="editTask_[spec.key]"
              :class="{ tall: spec.key === 'body' }"
              :placeholder="spec.placeholder || ''"
            ></textarea>

            <input v-else v-model="editTask_[spec.key]" :placeholder="spec.placeholder || ''" />

            <div v-if="spec.hint" class="tf-hint">{{ spec.hint }}</div>
          </div>
        </div>
        <div class="acts">
          <button class="ghost" @click="closeTaskEditor()">取消</button>
          <button class="pri" @click="saveEdit">保存</button>
        </div>
      </div>
    </div>

    <!-- Log edit modal -->
    <!-- Policy edit modal -->
    <div id="policy-overlay" class="overlay" v-if="policyEdit_" @click.self="closePolicyEditor()">
      <div id="policy-modal">
        <h3>项目方针：{{ policyEdit_.name }}</h3>
        <label>使命（一句话：这项目是干嘛的）</label>
        <textarea v-model="policyEdit_.mission" placeholder="例：本地优先的多 agent 任务调度台"></textarea>
        <label>当前目标（本阶段要达成什么 + 完成判据）</label>
        <textarea v-model="policyEdit_.goal" placeholder="例：稳定可用、承接真实业务数据"></textarea>
        <label>应用场景（给谁用、在哪用）</label>
        <textarea v-model="policyEdit_.scenario" placeholder="例：暮雨个人，桌面日常使用"></textarea>
        <label>方针边界（怎么干、不干什么）</label>
        <textarea v-model="policyEdit_.boundary" placeholder="例：元层铁律——永不内置模型能力；Agent 层归外部专家团"></textarea>
        <!-- 029：结构地图此前**只存在于文件里**，界面上完全看不到 —— 用户验收驳回原话
             「找不到在哪里」。这里把它变成一个能看能改的普通小节（不再需要手工翻文件）。 -->
        <label>
          结构地图（模块清单 + 每模块一句话职责 + 主数据流）
          <span class="pf-label-hint">第一行必须是「&gt; 最后核实：YYYY-MM-DD」——烂地图比没地图危险，因为读者不知道它烂</span>
        </label>
        <textarea class="tall" v-model="policyEdit_.structureMap"
          placeholder="&gt; 最后核实：2026-09-28&#10;- 模块清单：…&#10;- 主数据流：数据从哪来 → 经过谁 → 落到哪 → 谁读它"></textarea>
        <div class="pf-map-tools">
          <button class="ghost" type="button" @click="stampStructureMap()" title="把「最后核实」那行改成今天 —— 你刚确认过内容仍然成立">✓ 标记今天已核实</button>
          <span class="pf-map-tip">改动只写方针卡；派活时它会随任务书下发（不内联全文，只指路）</span>
        </div>
        <div class="acts">
          <button class="ghost" @click="closePolicyEditor()">取消</button>
          <button class="pri" @click="savePolicyEdit">保存方针卡</button>
        </div>
      </div>
    </div>

    <!-- 结构地图一览（029）：**这是「结构地图在哪」的答案**。
         列出每个登记项目的状态 + 最后核实日期，点一行直接进方针卡改。 -->
    <div id="smap-overlay" class="overlay" v-if="smapOpen" @click.self="smapOpen = false">
      <div id="smap-modal">
        <h3>🗺 结构地图 <span class="smap-sub">模块清单 + 每模块一句话职责 + 主数据流</span></h3>
        <p class="smap-hint">
          每张方针卡里有一个「结构地图」小节。第一行必须是<b>最后核实日期</b>——
          烂地图比没地图危险，因为读者不知道它烂。内容由 agent 起草、你过目。
        </p>
        <div class="smap-list">
          <div v-for="row in smapRows" :key="row.id" class="smap-item"
            :class="{ done: row.has, missing: !row.has, nopolicy: !row.hasPolicy }">
            <span class="smap-dot"></span>
            <div class="smap-main">
              <div class="smap-name">{{ row.name }}</div>
              <div class="smap-meta">
                <template v-if="!row.hasPolicy">连方针卡都还没立</template>
                <template v-else-if="!row.has">方针卡在，但没有结构地图</template>
                <template v-else-if="row.verified">最后核实 · {{ row.verified }}</template>
                <template v-else>有结构地图，但没写最后核实日期</template>
              </div>
            </div>
            <button class="ghost smap-open" @click="openPolicyFromSmap(row.id)">
              {{ row.has && row.verified ? '查看 / 编辑' : row.hasPolicy ? '去填' : '先立方针卡' }}
            </button>
          </div>
          <div v-if="!smapRows.length" class="hint">还没有登记项目</div>
        </div>
        <div class="acts">
          <button class="ghost" @click="smapOpen = false">关闭</button>
        </div>
      </div>
    </div>


    <div id="log-edit-overlay" class="overlay" v-if="logEdit_" @click.self="closeLogEditor()">
      <div id="log-edit-modal">
        <h3>{{ logCompleting ? '完成日志' : logArchiveMode ? '归档日志' : logEdit_.id ? '编辑日志' : '新建日志' }}</h3>
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
        <label>执行内容</label>
        <textarea v-model="logEdit_.content" class="tall" placeholder="执行内容..."></textarea>
        <label>下一步</label>
        <textarea v-model="logEdit_.nextSteps" placeholder="下一步..."></textarea>
        <!-- 关联任务：2026-09-22 改为「按项目过滤的选择」；2026-09-25（用户第 2 条）
             此前只能关联**一个** ID，需要多个。数据层本来就写 tasks 数组
             （renderLog: tasks: [id]），只是只读了第一个 —— 现在改成多选。 -->
        <label>关联任务（可多选）</label>
        <div v-if="logTaskOptions.length" class="log-task-multi">
          <label v-for="t in logTaskOptions" :key="t.id" class="log-task-opt">
            <input type="checkbox" :value="t.id" v-model="logEdit_.taskIds" />
            <span class="lto-id">{{ t.id }}</span>
            <span class="lto-title">{{ t.title || '(无标题)' }}</span>
            <span class="lto-st">{{ t.status }}</span>
          </label>
        </div>
        <div v-else class="hint">当前项目下没有可选任务 —— 用下面的输入框直接贴 ID</div>
        <input v-model="logTaskExtra" placeholder="额外关联 ID（多个用逗号分隔，回车加入）" @change="addLogTaskExtra" />
        <div class="hint log-task-picked" v-if="logTaskPicked">已选：{{ logTaskPicked }}</div>
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
             新建态没有 id 可挂，先创建再添加（按钮置灰并说明，而不是点完报错）。 -->
        <div class="attach-block" data-attach-block>
          <div class="attach-head">
            <label class="attach-lbl">附件</label>
            <button class="ghost attach-add" :disabled="!logEdit_.id"
              :title="logEdit_.id ? '从本机选文件；文件会复制进数据目录（随日志一起备份），源文件不动'
                : '先创建这条日志，再回来挂附件'"
              @click="attachAdd(logEdit_.id)">＋ 添加文件…</button>
          </div>
          <div v-if="!logEdit_.attachments || !logEdit_.attachments.length" class="attach-empty">
            {{ logEdit_.id ? '还没有附件 —— 截图、分析报告、日志文件都可以挂上来' : '创建后可挂附件（截图 / 报告 / 日志文件）' }}
          </div>
          <div v-else class="attach-grid">
            <div class="attach-item" v-for="a in logEdit_.attachments" :key="a">
              <img v-if="isImageRel(a) && attachSrc(a)" :src="attachSrc(a)" :alt="attachName(a)"
                :title="attachName(a) + '（点一下用系统程序打开）'" @click.stop="attachOpen(a)" />
              <div v-else class="attach-file" :title="a" @click.stop="attachOpen(a)">📄 {{ attachName(a) }}</div>
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
        <div v-if="logDiscard_" ref="logDiscardBar" class="relay-discard" role="alertdialog" aria-live="polite">
          <span class="rd-text">⚠ 这次的改动还没保存，关掉就没了：<b>{{ logDirtyNames().join('、') || '表单改动' }}</b></span>
          <span class="rd-acts">
            <button class="ghost" @click="logDiscard_ = false">继续填写</button>
            <button class="danger" @click="discardLogEdit">丢弃并关闭</button>
          </span>
        </div>
        <div class="acts">
          <button class="ghost" @click="closeLogEditor">取消</button>
          <button v-if="logEdit_.id" class="ghost" title="只复制日志 ID —— 贴给 AI 用来定位这一条" @click="copyId(logEdit_.id)">⧉ ID</button>
          <button v-if="logEdit_.id" class="ghost" title="复制成可直接粘给 agent 的提示词块" @click="copyLogAsPrompt(logEdit_.id)">📋 复制为提示词</button>
          <button v-if="logEdit_.id && !logCompleting && !logArchiveMode" class="danger" @click="destroyLogItem(logEdit_.id); closeLogNow()">销毁</button>
          <button class="pri" @click="saveLogEdit">{{ logCompleting ? '确认完成' : logArchiveMode ? '确认归档' : logEdit_.id ? '保存' : '创建' }}</button>
        </div>
      </div>
    </div>

    <!-- 接力对话框（2026-09-29 第 3 条方案二）：
         一个动作做完四件事 —— 出清旧的、继承上下文、建立新日志、可以立刻开跑。
         「为什么是一个对话框而不是一个字段」：真实动作分两步做必然漏一件（源日志忘归档 →
         待处理区越堆越长），字段 续自 只是这次动作留下的副产品。 -->
    <div id="relay-overlay" class="overlay" v-if="relay_" @click.self="closeRelay">
      <div id="relay-modal">
        <h3>⏭ 接力 · 从这里继续</h3>
        <div class="hint">一次动作做完四件事：出清旧的、继承上下文、建立新日志、可以立刻开跑。</div>
        <div class="relay-src">
          <span class="rs-label">源</span>
          <span class="rs-id">{{ relay_.src.id }}</span>
          <span>「{{ relay_.src.title || '(无标题)' }}」· <b>{{ relay_.src.status === 'completed' ? '已完成' : relay_.src.status === 'archived' ? '已归档' : '待处理' }}</b></span>
          <span class="rs-grow"></span>
          <span>执行内容与下一步都留空待写 · 要旧内容点行尾「带入」</span>
        </div>
        <label>新日志标题</label>
        <input v-model="relay_.title" placeholder="给接下来这段工作起个标题" />
        <label>项目</label>
        <select v-model="relay_.project" class="logsel">
          <option value="">（不归属）</option>
          <option v-if="relay_.project && !projects.some(p => p.id === relay_.project)"
            :value="relay_.project">{{ relay_.project }}（未在登记表中）</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
        </select>
        <div class="hint">继承自源：<b>{{ (projects.find(p => p.id === relay_.project)?.name) || relay_.project || '（不归属）' }}</b></div>
        <!-- 2026-09-30 用户第 3 条（卡 004）补的「执行内容」框；同日用户第 1 条（卡 006）指出
             两框上下颠倒：人类认知与日志卡的读法都是「先做了什么 → 接下来做什么」，
             所以执行内容在上、下一步在下（与「新建/编辑日志」对话框同序）。 -->
        <label>执行内容（本次做了什么；可粘贴上次会话的完成情况汇总）</label>
        <textarea v-model="relay_.content" placeholder="执行内容...（留空则新日志正文为空，之后可再编辑补写）"></textarea>
        <!-- 2026-10-02 用户「下一步依旧每次都直接挪用上次的输入结果」：不再预填源的下一步，
             改为**默认留空**（与执行内容同一口径：源的「下一步」属于上一段的计划，新日志该写本次的），
             需要旧内容时点行尾「带入」按钮**主动取** —— 挪用变申请，主动权在用户手里。
             保留 label 紧邻 textarea 的兄弟结构：renderer-web 的 relayTaOf() 与顺序断言都靠它定位。 -->
        <label class="ns-label">下一步
          <button type="button" class="ghost relay-bring" title="把源日志的「下一步」原文放进本框（框里已有内容时不会覆盖）"
            @click.stop="bringSourceNextSteps">⧉ 带入源的下一步</button>
        </label>
        <textarea v-model="relay_.nextSteps" placeholder="下一步...（默认留空，本次自己写；要用源里的内容点上方「带入源的下一步」）"></textarea>
        <label>关联任务</label>
        <div v-if="relay_.taskCandidates.length" class="log-task-multi">
          <label v-for="t in relay_.taskCandidates" :key="t.id" class="log-task-opt">
            <input type="checkbox" :value="t.id" v-model="relay_.taskIds" />
            <span class="lto-id">{{ t.id }}</span>
            <span class="lto-title">{{ t.title || '(无标题)' }}</span>
            <span class="lto-st">{{ t.status }}</span>
          </label>
        </div>
        <div v-else class="hint">源日志没有关联任务 —— 新日志先不挂任务</div>
        <!-- 2026-10-03 用户反馈1（卡 task-20261003-001，用户拍板拆两字段）：
             此前一个「执行 Agent」字段承担两种含义（编辑框还把它标成「上次执行 Agent」），
             用户原话「接力只能填执行 Agent，不能填上次的执行 Agent，明明上次更重要」。
             现在：上次 = 接力来源那段是谁跑的（找上次会话用，继承源、可改、可手补）；
             本次 = 新日志这段由谁跑（默认沿用源）。 -->
        <label>上次的执行 Agent（接力来源这段是谁跑的 —— 找上次的会话看这里）</label>
        <select v-model="relay_.prevAgentName" class="logsel">
          <option value="">（不指定）</option>
          <option v-if="relay_.prevAgentName && !agentPresets.includes(relay_.prevAgentName)"
            :value="relay_.prevAgentName">{{ relay_.prevAgentName }}（继承自源）</option>
          <option v-for="a in agentPresets" :key="a" :value="a">{{ a }}</option>
        </select>
        <input v-model="relay_.prevAgentName" placeholder="或手动输入上次的执行 Agent（源没记录时在这里补）" />
        <label>本次执行 Agent（新日志这段由谁跑）</label>
        <select v-model="relay_.agentName" class="logsel">
          <option value="">（不指定）</option>
          <option v-if="relay_.agentName && !agentPresets.includes(relay_.agentName)"
            :value="relay_.agentName">{{ relay_.agentName }}（继承自源）</option>
          <option v-for="a in agentPresets" :key="a" :value="a">{{ a }}</option>
        </select>
        <div class="hint">上次继承自源：<b>{{ relay_.prevAgentName || '（源未记录）' }}</b> · 本次默认沿用源：<b>{{ relay_.agentName || '（不指定）' }}</b>；会话 ID 与日期按新日志重置</div>
        <div class="relay-opts">
          <label class="relay-opt"><input type="checkbox" v-model="relay_.archiveSource" />
            <span>接力后把源日志归档（出清）
              <i>旧的移进「已归档」，不占「待处理」，也不进「已完成」的清理队列 —— 调度台干净。</i></span></label>
          <label class="relay-opt"><input type="checkbox" v-model="relay_.completeSourceTasks" />
            <span>顺手把源日志的关联任务置「完成」
              <i>旧任务一次性出清；不勾则任务状态保持不动。</i></span></label>
        </div>
        <!-- 关闭防丢确认条（2026-09-30 用户第 2 条，卡 006）：
             此前走原生 window.confirm，用户实测两次「点到旁边数据全丢、防护未生效」——
             ① 脏检查只比对三个文本框，只动过勾选/下拉时判定为「没改」，直接静默关；
             ② 原生框在窗口外/被回车一击带过，起不到「必须看一眼」的作用。
             现在：任何字段与打开时的快照不同 → 对话框内出确认条，必须点「丢弃」才真关。 -->
        <div v-if="relayDiscard_" ref="relayDiscardBar" class="relay-discard" role="alertdialog" aria-live="polite">
          <span class="rd-text">⚠ 这次的改动还没创建，关掉就没了：<b>{{ relayDirtyHint }}</b></span>
          <span class="rd-acts">
            <button class="ghost" @click="relayDiscard_ = false">继续填写</button>
            <button class="danger" @click="discardRelay">丢弃并关闭</button>
          </span>
        </div>
        <div class="acts">
          <button class="ghost" @click="closeRelay">取消</button>
          <button class="ghost" title="只建新日志（待处理），不改源日志" @click="executeRelay(false)">创建</button>
          <button class="pri" title="建新日志并标「进行中」，随时可跑" @click="executeRelay(true)">创建并开跑</button>
        </div>
      </div>
    </div>

    <!-- 指派时间（2026-09-22，用户第 6 条）：任务可设开始+截止时间段，待办只有到期日 -->
    <div v-if="calAssign_" class="overlay" @click.self="calAssign_ = null">
      <div id="cal-assign-modal">
        <h3>📅 指派时间</h3>
        <div class="ca-title">{{ calAssign_.title }}</div>
        <div class="hint" v-if="calAssign_.isTodo">待办只有「到期日」一个时间点。</div>
        <template v-if="!calAssign_.isTodo">
          <label>开始（可选；与截止组成时间段，日历上会横跨多天）</label>
          <input v-model="calAssign_.start" type="date" />
        </template>
        <label>{{ calAssign_.isTodo ? '到期日' : '截止' }}</label>
        <input v-model="calAssign_.end" type="date" />
        <div class="ca-quick">
          <button class="ghost" @click="calQuickSet(0)">今天</button>
          <button class="ghost" @click="calQuickSet(1)">明天</button>
          <button class="ghost" @click="calQuickSet(7)">一周后</button>
          <button class="ghost" @click="calClearDates">清除时间</button>
        </div>
        <div class="acts">
          <button class="ghost" @click="calAssign_ = null">取消</button>
          <button class="pri" @click="saveCalAssign">保存</button>
        </div>
      </div>
    </div>

    <!-- App edit modal (Launchpad) -->
    <!-- Data directory migrate modal -->
    <div v-if="migrateTarget" class="overlay" @click.self="migrateTarget = null">
      <div id="migrate-modal">
        <h3>切换数据目录</h3>
        <div class="mg-row"><span class="k">当前</span><span class="v">{{ dataDir }}</span></div>
        <div class="mg-row"><span class="k">目标</span><span class="v">{{ migrateTarget.dir }}</span></div>
        <div class="mg-row">
          <span class="k">目标现状</span>
          <span class="v" :class="{ warn: !migrateTarget.empty }">
            <template v-if="migrateTarget.empty">空目录，可安全迁入</template>
            <template v-else>
              已有 {{ migrateTarget.taskCount }} 个任务文件<template v-if="migrateTarget.archivedCount">（含 {{ migrateTarget.archivedCount }} 个归档）</template>
            </template>
          </span>
        </div>

        <div class="mg-notice">
          <b>将按顺序执行</b>
          <ul>
            <li>先把当前数据<b>完整备份</b>一份；备份失败则中止，不会动手</li>
            <li>把 <code>task-data/</code> · <code>registry.yaml</code> · <code>docs/</code> <b>复制</b>到目标目录</li>
            <li>切换方寸的数据指向并重新加载</li>
            <li>原目录<b>保留不删</b>，确认无误后你可自行清理</li>
          </ul>
          <div class="mg-hint">回收站（<code>.trash</code>）与本地备份（<code>backups/</code>）不随迁。</div>
          <div class="mg-hint" v-if="!migrateTarget.empty">
            目标目录已有数据，迁入后同名文件将被覆盖（源目录仍完整保留）。
          </div>
        </div>

        <div class="acts">
          <button class="ghost" @click="migrateTarget = null">取消</button>
          <button class="pri" :disabled="migrateBusy" @click="confirmMigrate">
            {{ migrateBusy ? '迁移中…' : (migrateTarget.empty ? '开始迁移' : '覆盖式迁入') }}
          </button>
        </div>
      </div>
    </div>

    <!-- New project modal -->
    <div v-if="projForm" class="overlay" @click.self="closeProjForm()">
      <div id="proj-new-modal">
        <h3>新建项目</h3>
        <label>项目 ID <span class="req">*</span></label>
        <input v-model="projForm.id" placeholder="英文标识，如 novel-forge" />
        <label>显示名称</label>
        <input v-model="projForm.name" placeholder="留空则与 ID 相同" />
        <label>仓库路径</label>
        <input v-model="projForm.repo" placeholder="E:/CODE/CangKu/xxx（供 Hermes 派活定位）" />
        <label>说明</label>
        <input v-model="projForm.description" placeholder="一句话说明（可选）" />
        <div class="hint">
          项目登记进 <code>registry.yaml</code>。写入前会自校验（内容可解析 · 项目数 +1 · 新 ID 可见），
          任一不满足即放弃写入；文件原有注释与字段原样保留。
        </div>
        <div class="acts">
          <button class="ghost" @click="closeProjForm()">取消</button>
          <button class="pri" :disabled="projCreating" @click="confirmNewProject">{{ projCreating ? '写入中…' : '登记项目' }}</button>
        </div>
      </div>
    </div>

    <div id="app-edit-overlay" class="overlay" v-if="editApp_" @click.self="closeAppEditor()">
      <div id="app-edit-modal">
        <h3>{{ editApp_.isNew ? '添加应用' : '编辑应用' }}</h3>
        <label>名称</label>
        <input v-model="editApp_.name" placeholder="应用名称" />
        <label>路径（exe / bat / cmd / ps1 / lnk / 文件夹都行）</label>
        <div style="display:flex;gap:6px;align-items:center;">
          <input v-model="editApp_.path" placeholder="E:/path/to/app.exe" style="flex:1" />
          <button type="button" class="ghost" @click="browseAppPath">浏览…</button>
        </div>
        <label>启动参数（可选，空格分隔）</label>
        <input v-model="editApp_.argsText" placeholder="例：--port 8080" />
        <label>描述（可选）</label>
        <input v-model="editApp_.description" placeholder="应用描述" />
        <div class="hint app-path-hint">选中文件夹或 .lnk 时直接用系统「打开」；.bat/.cmd 经 cmd.exe 执行，.ps1 用 powershell 执行。</div>
        <div class="acts">
          <button class="ghost" @click="closeAppEditor()">取消</button>
          <button v-if="!editApp_.isNew" class="danger" @click="removeApp(editApp_.id)">删除</button>
          <button class="pri" @click="saveEditApp">{{ editApp_.isNew ? '添加' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- ═══════════ Notification Center（通知中心，原型规格移植） ═══════════ -->
    <div v-if="ncOpen" class="nc-wrap" @mousedown.self="closePanel">
      <div class="nc-panel">
        <header class="nc-head">
          <div class="nc-head-title">
            <h1>通知中心 <span v-if="ncUnread > 0" class="nc-count">{{ ncUnread }}</span></h1>
            <p>{{ ncHeadSub }}</p>
          </div>
          <div class="nc-head-act">
            <button class="nc-icon-btn" :class="{ spin: ncLoading }" title="刷新" @click="ncRefresh">
              <span class="nc-ico">⟳</span>
            </button>
            <button class="nc-btn-primary" :disabled="ncUnread === 0" @click="ncMarkAllRead">✓ 全部标为已读</button>
            <button class="nc-icon-btn" title="关闭" @click="closePanel">✕</button>
          </div>
        </header>

        <div class="nc-filters">
          <div class="nc-seg">
            <button :class="{ on: ncFilter === 'all' }" @click="ncSetFilter('all')">全部<span class="n">{{ ncCounts.all }}</span></button>
            <button :class="{ on: ncFilter === 'unread' }" @click="ncSetFilter('unread')">未读<span class="n">{{ ncCounts.unread }}</span></button>
            <button :class="{ on: ncFilter === 'read' }" @click="ncSetFilter('read')">已读<span class="n">{{ ncCounts.read }}</span></button>
          </div>
        </div>

        <div class="nc-list">
          <div v-for="n in ncVisible" :key="n.id" class="nc-item"
            :class="[n.read ? 'read' : 'unread', { go: !!ncTargetOf(n) }]"
            :title="ncTargetOf(n) || '标为已读'"
            @click="ncClickItem(n)">
            <div class="nc-av" :class="'nc-av-' + (NC_TYPE_META[n.type]?.icon || 'system')">
              {{ NC_TYPE_META[n.type]?.glyph || '•' }}
            </div>
            <div class="nc-body">
              <div class="nc-meta">
                <span class="nc-tag" :class="'nc-t-' + (NC_TYPE_META[n.type]?.icon || 'system')">{{ NC_TYPE_META[n.type]?.label || n.type }}</span>
                <span v-if="n.level === 'error'" class="nc-prio">紧急</span>
              </div>
              <div class="nc-row1">
                <div class="nc-title">{{ n.title }}</div>
                <div class="nc-time">{{ ncRelTime(n.updatedAt) }}</div>
              </div>
              <div v-if="n.body" class="nc-content">{{ n.body }}</div>
            </div>
            <!-- 2026-10-01 用户第 1 条：能跳的行给个明确信号，别让人点了以为是死按钮 -->
            <span v-if="ncTargetOf(n)" class="nc-go" aria-hidden="true">→</span>
            <div class="nc-acts">
              <button class="nc-act keep" :title="n.read ? '标为已读' : '标为已读'" @click.stop="ncToggleRead(n)">✓</button>
              <button class="nc-act danger" title="删除通知" @click.stop="ncDelete(n)">🗑</button>
            </div>
          </div>
          <div v-if="ncVisible.length === 0" class="nc-empty">
            <div class="nc-empty-ic">🔔</div>
            <h3>{{ ncFilter === 'unread' ? '没有未读通知' : '暂无通知' }}</h3>
            <p>这里会显示任务没动静、阻塞链断裂、待办到期、任务逾期、解析失败与备份失败等事件</p>
          </div>
        </div>

        <!-- P0-5：删过通知 = 静音 7 天，必须看得见、能恢复（此前 listMuted 全无入口） -->
        <div v-if="ncMuted.length" class="nc-muted">
          <span>被忽略 {{ ncMuted.length }} 条（7 天后自动恢复）</span>
          <button class="nc-link" @click="ncUnmuteAll">全部恢复 →</button>
        </div>
        <footer class="nc-foot">
          <div class="stat">共 <b>{{ ncCounts.all }}</b> 条 · 未读 <b>{{ ncCounts.unread }}</b> 条</div>
          <!-- P0-4：扫描器状态 —— "停摆"与"扫不到"此前在界面上长得一模一样 -->
          <div class="nc-scan" :title="String(ncStatus?.lastScanAt || '')">{{ ncStatusText }}</div>
          <button class="nc-link" @click="ncClearAll">清空历史 →</button>
        </footer>
      </div>
    </div>

    <!-- Settings modal -->
    <div id="soverlay" class="overlay" v-if="showSettings_" @click.self="showSettings_ = false">
      <div id="smodal">
        <!-- 侧边栏分类（2026-10-03 用户：「设置项不该挤在一条长名单里，要像各大软件那样用侧边栏页签分类」）。
             上一版做的「点标题折叠」被这个取代 —— 折叠解决的是"太长"，侧边栏解决的是"找不到"，
             后者才是真正的诉求。当前分类记进真身（fc_settings_tab），下次打开还在那一页。 -->
        <nav class="settings-nav">
          <div class="settings-nav-title">设置</div>
          <button v-for="t in settingsTabs" :key="t.id" class="settings-nav-btn"
                  :class="{ on: settingsTab === t.id }" @click="selectSettingsTab(t.id)">
            <span class="sn-ico">{{ t.icon }}</span><span class="sn-name">{{ t.name }}</span>
          </button>
        </nav>
        <div class="settings-body">
        <div class="sect" v-show="settingsTab === 'general'">
          <h4>版本与更新</h4>
          <div class="ver-row">
            <span class="ver-num">v{{ appVersion }}</span>
            <span v-if="updateState.checked" class="hint">{{ updateState.msg }}</span>
          </div>
          <div class="sect-btns">
            <button class="ghost" :disabled="updateState.busy" @click="checkUpdate">
              {{ updateState.busy ? '检查中…' : '检查更新' }}
            </button>
            <button v-if="updateState.available" class="pri" :disabled="updateState.busy" @click="downloadUpdate">
              下载 v{{ updateState.version }}
            </button>
            <button v-if="updateState.downloaded" class="pri" @click="installUpdate">
              退出并安装
            </button>
          </div>
          <div class="hint">更新包托管在 GitHub Releases，检查与下载需联网。</div>
          <!-- 2026-09-25（用户第 1/3/9 条）：界面卡顿/点不动的人工验证杠杆。
               去完全部实时模糊层后若仍复发，那就是合成器/核显驱动层的问题
               —— 关掉硬件加速重启即可验证（必须重启才生效）。 -->
          <label class="chk gpu-chk" title="关掉 Chromium 的 GPU 合成。若「点输入框要切窗口才恢复」仍复发，勾上它重启再试。">
            <input type="checkbox" v-model="disableGpu" @change="onDisableGpuChange" />
            禁用硬件加速（界面若出现卡顿/点不动的兜底，需重启生效）
          </label>
        </div>
        <!-- 2026-09-29 用户第 4 条：多主题外观（参考绒花墨坊的色板与摆法） -->
        <div class="sect" v-show="settingsTab === 'general'">
          <h4>外观主题</h4>
          <div class="hint">只换配色，不改布局；六套全部过可读性检查（正文 / 次要文字 / 按钮白字对比度 ≥ WCAG AA）。</div>
          <div class="theme-swatches">
            <button v-for="t in THEME_LIST" :key="t.id" class="theme-swatch"
              :class="{ on: theme === t.id }" :title="'切换到主题：' + t.name" @click="setTheme(t.id)">
              <span class="sw-dot" :style="{ background: t.dot }"></span>
              <span class="sw-name">{{ t.name }}</span>
              <span v-if="theme === t.id" class="sw-check">✓</span>
            </button>
          </div>
        </div>
        <div class="sect" v-show="settingsTab === 'data'">
          <h4>数据目录</h4>
          <div class="hint">{{ dataDir }}</div>
          <div class="sect-btns">
            <button class="ghost" @click="changeDataDir">修改目录…</button>
            <button class="ghost" @click="openDataDir">打开目录</button>
          </div>
        </div>
        <div class="sect" v-show="settingsTab === 'diag'">
          <h4>诊断日志</h4>
          <div class="hint logpath">{{ appLogFile || '（未取到日志路径）' }}</div>
          <div class="sect-btns">
            <button class="ghost" @click="openAppLogDir">打开日志目录</button>
            <button class="ghost" @click="copyAppLogPath">复制路径</button>
            <button class="ghost" @click="showAppLogFromSettings">查看最近 200 行</button>
          </div>
          <div class="hint">崩溃、IPC 失败、渲染层异常、启动失败都会写进这个文件。报问题时把最后几十行发我即可。</div>
        </div>
        <!-- 2026-09-29 用户第 6 条：设置里要能自定义「已完成日志的自动清理」 -->
        <div class="sect" v-show="settingsTab === 'data'">
          <h4>日志清理</h4>
          <div class="hint">已完成日志默认保留这么多天，到期后点日志页的「清理超期」标为「已归档」（只改状态，不删文件）。逐条完成时填的天数仍然优先。</div>
          <div class="sect-btns retain-row">
            <input type="number" min="0" step="1" class="retain-input"
              v-model.number="logRetainDefault" @change="onLogRetainDefaultChange" />
            <span class="hint">天（0 = 永不清理）</span>
          </div>
        </div>
        <!-- 2026-10-03 卡 012：看板已完成任务自动归档（仿日志清理；**默认关闭**） -->
        <div class="sect" v-show="settingsTab === 'data'">
          <h4>看板归档</h4>
          <div class="hint">「已完成」且超过这么多天没更新过的任务，会被移进归档区（「归档」标签里能看到、可随时还原，**不删文件**）。0 = 关闭。</div>
          <div class="sect-btns retain-row">
            <input type="number" min="0" step="1" class="retain-input"
              v-model.number="archiveDays" @change="onArchiveDaysChange" />
            <span class="hint">天（0 = 关闭）</span>
          </div>
          <label class="chk">
            <input type="checkbox" v-model="archiveAuto" @change="onArchiveAutoChange" />
            启动方寸时自动执行（默认关；开了它才会在启动时动文件）
          </label>
          <div class="sect-btns" v-if="archiveDays > 0">
            <button class="ghost" @click="refreshArchiveOverdue()">刷新超期清单</button>
            <button class="ghost" :disabled="archiveOverdue.count === 0" @click="runArchiveOverdue()">
              立即归档超期的 {{ archiveOverdue.count }} 个
            </button>
          </div>
        </div>
        <!-- 2026-09-23：Agent 预设列表可编辑（用户要求：自定义功能多一点） -->
        <div class="sect" v-show="settingsTab === 'agent'">
          <h4>🤖 Agent 预设列表</h4>
          <div class="hint">日志视图的「执行 Agent」筛选下拉会读这里的预设。增删后自动保存到浏览器本地。</div>
          <div class="agent-presets-list">
            <span v-for="(a, i) in agentPresets" :key="a" class="agent-preset-chip">
              {{ a }}
              <button class="agent-preset-del" title="删除此预设" @click="removeAgentPreset(i)">×</button>
            </span>
            <span v-if="!agentPresets.length" class="hint">暂无预设，添加一个吧</span>
          </div>
          <div class="agent-presets-add">
            <input v-model="newAgentName" placeholder="新 Agent 名称（如 opencode）" @keydown.enter="addAgentPreset" />
            <button class="ghost" @click="addAgentPreset">添加</button>
          </div>
        </div>
        <div class="sect" v-show="settingsTab === 'projects'">
          <h4>项目列表</h4>
          <div class="projlist">
            <div class="proj-row" v-for="p in projects" :key="p.id" :title="p.repo || ''" @click="openProjectInSettings(p)">
              <span class="proj-row-name">{{ p.name || p.id }}</span>
              <small class="proj-row-id">{{ p.id }}</small>
              <span class="proj-row-desc">{{ p['状态'] || '' }}<template v-if="p['路线图']"> · {{ p['路线图'] }}</template></span>
            </div>
          </div>
        </div>
        <!-- 项目方针从「备份与恢复」里挪出来：它本来就属于「项目」这一类
             （原来塞在备份区块内层，做分类时父容器一隐藏它就跟不出来） -->
        <div class="sect" v-show="settingsTab === 'projects'">
          <h4>项目方针</h4>
          <div class="hint" style="margin-bottom:8px">每项目一张方针卡（使命/目标/场景/边界）。派活或开新会话时复制给 agent，替代口头交代。</div>
          <div class="policy-list">
            <div v-for="p in projects" :key="'pol-' + p.id" class="policy-row" @click="openPolicyEdit(p.id)">
              <span class="policy-name">{{ p.name || p.id }}</span>
              <span class="policy-state" :class="{ has: policyMap[p.id] }">{{ policyMap[p.id] ? '已立' : '未立' }}</span>
              <button v-if="policyMap[p.id]" class="ghost" title="复制方针文本（粘给 agent）" @click.stop="copyPolicyText(p.id)">复制</button>
            </div>
          </div>
        </div>
        <div class="sect backup-sect" v-show="settingsTab === 'backup'">
          <h4>🛡️ 备份与恢复</h4>

          <div class="bk-status" :class="bkDotClass">
            <span class="bk-dot"></span>
            <span class="bk-status-text">{{ bkStatusText }}</span>
            <span v-if="bkStatus.nextRunAt" class="bk-next">下次 {{ bkFmt(bkStatus.nextRunAt) }}</span>
          </div>
          <div v-if="bkState.lastError" class="bk-err-line">上次失败（{{ bkState.failStreak }} 次连续）：{{ bkState.lastError }}</div>

          <div class="bk-grid">
            <label>WebDAV 地址</label>
            <input v-model="bkForm.url" placeholder="https://dav.jianguoyun.com/dav/fangcun" />
            <label>账号</label>
            <input v-model="bkForm.username" placeholder="邮箱 / 用户名" />
            <label>密码</label>
            <input
              v-model="bkForm.password"
              type="password"
              :placeholder="bkForm.hasPassword ? '已加密保存（留空=不修改）' : '应用密码（坚果云需用应用密码）'"
            />
            <label>自动备份</label>
            <div class="bk-inline">
              <input id="bk-enabled" type="checkbox" v-model="bkForm.enabled" />
              <label for="bk-enabled" class="bk-cb">启用 · 每</label>
              <input type="number" v-model.number="bkForm.intervalHours" min="0" max="168" class="bk-num" />
              <span>小时 · 启动后</span>
              <input type="number" v-model.number="bkForm.firstDelayMinutes" min="0" max="1440" class="bk-num" />
              <span>分钟首次</span>
            </div>
            <label>保留份数</label>
            <div class="bk-inline">
              <span>本地</span>
              <input type="number" v-model.number="bkForm.localKeep" min="1" max="200" class="bk-num" />
              <span>远端</span>
              <input type="number" v-model.number="bkForm.remoteKeep" min="0" max="200" class="bk-num" />
              <label class="bk-cb"><input type="checkbox" v-model="bkForm.allowSelfSigned" /> 允许自签证书（NAS）</label>
            </div>
            <label>存放目录</label>
            <div class="bk-inline">
              <input v-model="bkForm.localDir" class="bk-path" placeholder="留空 = 数据目录下的 backups/" />
              <button class="ghost bk-mini" @click="bkPickDir">浏览…</button>
              <button class="ghost bk-mini" @click="bkOpenDir">打开</button>
            </div>
          </div>

          <div class="sect-btns">
            <button class="pri" :disabled="bkBusy" @click="bkSaveAndRun">{{ bkBusy ? '备份中…' : '立即备份' }}</button>
            <button class="ghost" :disabled="bkBusy" @click="bkRunLocalOnly">仅本地</button>
            <button class="ghost" :disabled="bkTesting" @click="bkTestRemote">{{ bkTesting ? '测试中…' : '测试远端' }}</button>
            <button class="ghost" @click="bkSaveConfig">保存配置</button>
            <button class="ghost" @click="bkOpenDir">打开备份文件夹</button>
            <!-- 刚做完一次备份后，直接定位到那个文件所在目录（原 openBackupFolder 一直没入口） -->
            <button v-if="backupInfo" class="ghost" :title="'最近一次备份：' + backupInfo.path + '（' + backupInfo.sizeKB + ' KB）'"
              @click="openBackupFolder">最近备份所在目录</button>
          </div>

          <div class="sect-btns bk-manual">
            <span class="bk-manual-label">手动流转（不依赖网盘账号）</span>
            <!-- 2026-09-26 用户第 1、2 条：不再要人选下拉（「必须逐字核对，很难受」），
                 点一下就导出**最新一份备份**；落盘**只有一个 zip**。 -->
            <button class="ghost" :disabled="bkBusy" @click="bkExportTo"
              title="把最新一份备份复制到所选目录 —— 落盘只有一个 zip 文件；一份备份都没有时才现打一份">📤 导出备份（一个 zip）</button>
            <button class="ghost" :disabled="bkBusy" @click="bkVerifyPackage">🔍 校验备份包…</button>
            <button class="ghost" :disabled="bkBusy" @click="bkRestoreFromFile">📥 从文件恢复…</button>
          </div>
          <div v-if="bkMsg" :class="'llm-config-msg ' + bkMsgType">{{ bkMsg }}</div>
          <div v-if="bkForm.url && !bkForm.hasPassword" class="hint">
            提示：密码只有保存后才会加密留存，重启应用后仍可自动备份。
          </div>

          <div class="bk-history">
            <div class="bk-tabs">
              <span :class="{ on: bkTab === 'local' }" @click="bkSwitchTab('local')">本地 ({{ bkLocal.length }})</span>
              <span :class="{ on: bkTab === 'remote' }" @click="bkSwitchTab('remote')">远端 ({{ bkRemote.length }})</span>
            </div>
            <div class="bk-list">
              <!-- 2026-09-25 第 5 条：列表按「最后更新」倒序（主进程排好），首行是「最新」。
                   2026-09-28（卡 026-001 验收驳回原话：「依然不能手动点来选中备份，
                   回收站都能点了，备份不能点，无语」）：**整行可点** = 看这一份里到底有什么
                   （校验 + manifest 摘要）。原来这一行是没有 @click 的死 div，
                   想确认内容只能另点「🔍 校验备份包…」再走文件选择器挑一遍 —— 而这一份就在眼前。 -->
              <div v-for="(b, bi) in bkCurrentList" :key="b.name"
                class="bk-item" :class="{ on: bkInspected === b.name }"
                :title="bkTab === 'local' ? '点击查看这一份里有什么（校验 + 文件清单）' : '远端备份需先下载到本地才能查看内容'"
                @click="bkInspectRow(b)">
                <div class="bk-item-main">
                  <span class="bk-item-name">{{ b.name }}</span>
                  <span v-if="bi === 0" class="bk-newest" title="按最后更新倒序 —— 这就是最新的一份">最新</span>
                  <span class="bk-item-meta">
                    {{ b.bytes != null ? (b.bytes / 1024).toFixed(0) + ' KB' : '—' }} · {{ bkFmt(b.mtime) }}
                  </span>
                </div>
                <span v-if="bkInspected === b.name" class="bk-inspecting">已展开 ↓</span>
                <button class="ghost bk-restore" :disabled="bkBusy" @click.stop="bkRestore(b)">恢复</button>
              </div>
              <div v-if="!bkCurrentList.length" class="hint">暂无备份{{ bkTab === 'remote' ? '（需先配置并测试 WebDAV）' : '' }}</div>
            </div>
          </div>

          <div v-if="bkVerifyResult" class="bk-verify" :class="bkVerifyResult.ok ? 'ok' : 'bad'">
            <div class="bk-verify-head">
              {{ bkVerifyResult.ok ? '✅ 备份包完整可用' : '❌ 备份包校验未通过' }}
              <span class="bk-verify-path">{{ bkVerifyResult.name }}</span>
            </div>
            <div v-if="bkVerifyResult.manifest" class="bk-verify-meta">
              备份时间 {{ bkFmt(bkVerifyResult.manifest.createdAt) }} ·
              {{ bkVerifyResult.manifest.totalFiles }} 个文件 ·
              {{ (bkVerifyResult.manifest.totalBytes / 1024).toFixed(1) }} KB
            </div>
            <ul v-if="bkVerifyResult.errors && bkVerifyResult.errors.length" class="bk-verify-errs">
              <li v-for="(e, i) in bkVerifyResult.errors.slice(0, 8)" :key="i">{{ e }}</li>
            </ul>
            <button class="ghost bk-mini" @click="bkVerifyResult = null">关闭</button>
          </div>

          <div class="hint">
            备份范围：task-data/ + registry.yaml + docs/。密钥文件（llm-config.json、backup-config.json 等）永不入包，
            每次备份的 manifest 里会记录被排除项。恢复前必做 sha256 + 结构双重校验，校验不过不动现有数据。
          </div>

          <div class="bk-notice">
            <b>数据安全须知</b>
            <ul>
              <li>备份包内含任务数据<strong>完整明文内容</strong>，未加密。请勿放入公开可访问的目录或公开分享链接。</li>
              <li>API Key 等密钥<strong>永不进入备份包</strong>；从备份恢复后，LLM 与 WebDAV 配置需要重新填写。</li>
              <li>恢复会覆盖当前数据。应用会自动为现有数据打快照并在失败时回滚，但请勿在恢复过程中断电或强制退出。</li>
              <li>云端副本由你所用的网盘客户端负责同步，方寸无法校验远端是否完整。建议定期用「校验备份包」抽查下载回来的副本。</li>
              <li>备份只覆盖数据，<strong>不含代码与 git 历史</strong>。手写的备份包请自行保留校验文件（<code>.sha256</code>），
                  它是判断文件是否损坏的唯一依据。</li>
              <li>备份目录若指向网盘同步文件夹，轮换会同步删除云端旧包，这是预期行为。</li>
            </ul>
          </div>

          <button class="ghost bk-log-toggle" @click="bkToggleLog">📋 {{ bkShowLog ? '收起日志' : '查看备份日志' }}</button>
          <pre v-if="bkShowLog" class="bk-log">{{ bkLogLines.length ? bkLogLines.join('\n') : '(暂无日志)' }}</pre>
        </div>

        <!-- 底部动作条：与"当前在哪个分类"无关（导出/导入/关闭随时可用），所以挂在 body 末尾 -->
        <div class="settings-foot">
          <button class="ghost" @click="exportTasksToFile">导出任务 JSON</button>
          <button class="ghost" @click="importTasksFromFile">导入任务 JSON</button>
          <button class="pri" @click="showSettings_ = false">关闭</button>
        </div>
        </div>
      </div>
    </div>



    <div id="toast" :class="[toast.type, { show: toast.show }]">{{ toast.msg }}</div>

    <!-- Drag status picker -->
    <div class="drag-status-picker" v-if="draggingId" :style="pickerStyle">
      <div class="sp-title">拖到目标状态</div>
      <div
        v-for="s in STATUSES"
        :key="s"
        class="sp-bucket"
        :class="{ dragover: dragoverCol === s }"
        @dragover.prevent="dragoverCol = s"
        @drop="onDrop($event, s)"
      >
        <span class="sp-dot" :style="{ background: statusColor(s) }"></span>
        {{ s }}
      </div>
    </div>

    <!-- First-run wizard -->
    <div v-if="showWizard" class="overlay wizard-overlay">
      <div class="wizard">
        <div class="wizard-header">
          <h2>{{ wizardSteps[wizardStep].title }}</h2>
          <p class="wizard-step-indicator">步骤 {{ wizardStep + 1 }} / {{ wizardSteps.length }}</p>
        </div>
        <div class="wizard-body">
          <div v-if="wizardStep === 0">
            <p class="wizard-desc">欢迎使用方寸！请先选择数据目录。</p>
            <div class="wizard-field">
              <label>数据目录</label>
              <div class="wizard-input-row">
                <input v-model="wizardDataDir" placeholder="选择数据目录路径" />
                <button class="ghost" @click="browseWizardDir">浏览…</button>
              </div>
              <small class="wizard-hint">方寸将在此目录下创建 task-data/ 和 registry.yaml</small>
            </div>
          </div>
          <div v-if="wizardStep === 1">
            <p class="wizard-desc">选择初始化方式：</p>
            <div class="wizard-options">
              <label class="wizard-option" :class="{ selected: wizardInitMode === 'fresh' }">
                <input type="radio" v-model="wizardInitMode" value="fresh" />
                <div>
                  <strong>新建空白看板</strong>
                  <small>从零开始，创建全新的任务看板</small>
                </div>
              </label>
              <label class="wizard-option" :class="{ selected: wizardInitMode === 'import' }">
                <input type="radio" v-model="wizardInitMode" value="import" />
                <div>
                  <strong>从 Python tegula 导入</strong>
                  <small>复制现有任务数据和项目注册表</small>
                </div>
              </label>
            </div>
            <div v-if="wizardInitMode === 'import'" class="wizard-field">
              <label>Python tegula 目录</label>
              <div class="wizard-input-row">
                <input v-model="wizardPythonDir" placeholder="E:\CODE\CangKu\fangcun" />
                <button class="ghost" @click="browsePythonDir">浏览…</button>
              </div>
            </div>
          </div>
          <div v-if="wizardStep === 2">
            <p class="wizard-desc">确认配置：</p>
            <div class="wizard-summary">
              <div class="wizard-summary-row"><span>数据目录</span><code>{{ wizardDataDir }}</code></div>
              <div class="wizard-summary-row"><span>初始化方式</span><span>{{ wizardInitMode === 'fresh' ? '新建空白看板' : '从 Python tegula 导入' }}</span></div>
              <div v-if="wizardInitMode === 'import'" class="wizard-summary-row"><span>Python tegula 目录</span><code>{{ wizardPythonDir }}</code></div>
            </div>
          </div>
        </div>
        <div class="wizard-footer">
          <button v-if="wizardStep > 0" class="ghost" @click="wizardStep--">上一步</button>
          <div class="wizard-footer-right">
            <button v-if="wizardStep < wizardSteps.length - 1" class="pri" @click="wizardNext" :disabled="!wizardCanNext">下一步</button>
            <button v-else class="pri" @click="wizardFinish" :disabled="wizardFinishing">{{ wizardFinishing ? '初始化中…' : '完成' }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, reactive, watch, nextTick } from 'vue'
import { marked } from 'marked'
import {
  parseCalDate, calISO, dayStart, addDays, buildMonth, rangeLabel, shiftRange,
  type CalEvent as CalEventT,
} from './calendar'
import {
  classifyLogImport, classifySummary,
  type ImportItem,
} from './logdedupe'
import DOMPurify from 'dompurify'
import { toPlain } from '../shared/plain'
import { copyText } from '../shared/clipboard'
import { buildProjectGroups, toggleCollapsed, isCollapsed } from '../shared/grouping'
import { buildDispatchText, arsenalStatus } from '../shared/arsenal'
import { formatDate, formatDateTime, relativeTime, relTimeShort, parseTime, daysSince } from '../shared/time'

const STATUSES = ['草稿', '待审批', '待办', '进行中', '待验收', '完成', '驳回'] as const
type Status = typeof STATUSES[number]

// ── 任务表单元数据 ───────────────────────────────────────────────────
// 字段清单与枚举的唯一来源在主进程（data/index.ts 的 TASK_FIELD_SPECS）。
// 这里保留一份内置兜底，仅用于 IPC 未就绪的极端情况，正常启动会被覆盖。
const PRIORITIES = ['高', '中', '低'] as const
const taskFieldSpecs = ref<any[]>([])
const taskStatuses = ref<string[]>([...STATUSES])
const taskPriorities = ref<string[]>([...PRIORITIES])

async function loadTaskMeta() {
  try {
    const specs: any = await window.tegula.taskFieldSpecs()
    if (Array.isArray(specs) && specs.length) taskFieldSpecs.value = specs
    const enums: any = await window.tegula.taskEnums()
    if (Array.isArray(enums?.statuses) && enums.statuses.length) taskStatuses.value = enums.statuses
    if (Array.isArray(enums?.priorities) && enums.priorities.length) taskPriorities.value = enums.priorities
  } catch {
    // 拉取失败：走下面的最小兜底
  }
  if (!taskFieldSpecs.value.length) {
    taskFieldSpecs.value = [
      { key: 'title', label: '标题', type: 'text', span: 'full' },
      { key: 'project', label: '项目', type: 'select', span: 'half', optionsFrom: 'projects' },
      { key: 'status', label: '状态', type: 'select', span: 'half', options: taskStatuses.value },
      { key: 'priority', label: '优先级', type: 'select', span: 'half', options: taskPriorities.value },
      { key: 'tags', label: '标签', type: 'tags', span: 'full' },
      { key: 'body', label: '正文', type: 'textarea', span: 'full' },
    ]
  }
}

interface Task {
  id: string
  title?: string
  status?: string
  project?: string
  priority?: string
  tags?: string[]
  body?: string
  created?: string
  updated?: string
  blockers?: string[]
  batch?: string
  _archived?: boolean
}

interface Project {
  id: string
  name?: string
  repo?: string
  ['状态']?: string
  ['路线图']?: string
}

// ── State ───────────────────────────────────────────────────────────────

const tasks = ref<Task[]>([])
const projects = ref<Project[]>([])
const blockers = ref<any[]>([])
const curView = ref('active')
const curProj = ref('__all__')
const groupMode = ref('status')

// ── 顶栏计数 + 关于（2026-09-25 用户第 12 条）────────────────────────────
// 「左上角神秘数字，有时 38，有时 39，有时 1」的真因：
//   它是 `{{ tasks.length }}`，而 tasks 由 loadAll() 按**当前视图**拉一份；
//   切到日志 / 待办 / 启动台 / 阻塞 / 路线图这些**不调 loadAll** 的页签时它不会更新
//   → 数字停在上一个视图的旧值（且从不说明是什么）。这里记下计数属于哪个视图，
//   不属于当前视图就不再冒充「本页的条数」。
const countView = ref('')
const countText = computed(() =>
  countView.value === curView.value ? `${tasks.value.length} 条` : '—')
const countTitle = computed(() =>
  countView.value === curView.value
    ? `当前视图（${curView.value}）内 ${tasks.value.length} 条任务。归档任务不计入，除非勾选顶栏「含归档」。`
    : '本页签不加载任务列表，所以不显示条数（此前会残留上一个视图的旧数字）')

// 顶栏控件的作用域（2026-09-26 用户第 1 条回执）
// 顶栏原来是**无条件渲染**的：切到回收站/技能/日志/待办后，「全部项目 / 按状态 /
// 折叠全部 / 展开 / 搜索 / 全部时间 / 活跃优先 / 任务多选」全是看板专属 —— 点了没有任何
// 作用。用户的原话是「右边一堆看起来能点的 UI，但实际什么都不能点」。
// 这里按视图收口：看板专属只在看板/归档出现；「+ 新建」只在有"任务"这个对象的视图出现。
const isBoardView = computed(() => curView.value === 'active' || curView.value === 'archive')
const isTaskView = computed(() =>
  ['active', 'archive', 'projects', 'blockers', 'roadmap', 'calendar'].includes(curView.value))

const aboutOpen = ref(false)
function openAbout(): void {
  aboutOpen.value = true
  if (!appVersion.value) void loadAppVersion()
}

// 硬件加速开关（2026-09-25 用户第 1/3/9 条的人工验证杠杆）。真身 prefs.json，
// 主进程在 app ready 之前同步读它决定是否 disableHardwareAcceleration() → 必须重启生效。
const disableGpu = ref(readUiPref<boolean>('fc_disable_gpu', false))
function onDisableGpuChange(): void {
  saveUiPref('fc_disable_gpu', disableGpu.value)
  showToast(disableGpu.value ? '已关闭硬件加速 —— 请重启方寸后生效' : '已恢复硬件加速 —— 请重启方寸后生效', 'info')
}

// 已完成日志的默认保留天数（2026-09-29 用户第 6 条：「设置里可以提供更多选项，
// 比如已完成日志的自动清理日期可自定义」）。0 = 永不清理；真身 prefs.json，与其它偏好同一套。
const logRetainDefault = ref(readUiPref<number>('fc_log_retain_days', 7))
function onLogRetainDefaultChange(): void {
  const n = Math.floor(Number(logRetainDefault.value))
  logRetainDefault.value = Number.isFinite(n) && n >= 0 ? n : 7
  saveUiPref('fc_log_retain_days', logRetainDefault.value)
}

// ── 已完成任务自动归档（2026-10-03 卡 task-20261003-012）────────────────
// 仿日志清理：一个保留天数 + 一批「已超期」的清单 + 用户点按钮执行。
// ⚠ 默认天数取 **0**（关闭），不是 7 —— 归档会**移动任务文件**，
//   绝不能对从没表过态的机器悄悄生效（日志清理改的是状态字段，量级不同）。
const archiveDays = ref(readUiPref<number>('fc_archive_days', 0))
const archiveAuto = ref(readUiPref<boolean>('fc_archive_auto', false))
const archiveOverdue = ref<{ count: number; items: { id: string; title: string; updated: string }[] }>({ count: 0, items: [] })

function onArchiveDaysChange(): void {
  const n = Math.floor(Number(archiveDays.value))
  archiveDays.value = Number.isFinite(n) && n >= 0 ? n : 0
  saveUiPref('fc_archive_days', archiveDays.value)
  void refreshArchiveOverdue()
}
function onArchiveAutoChange(): void {
  saveUiPref('fc_archive_auto', archiveAuto.value)
}

/** 查「超期的已完成任务」有几条（功能关闭时恒 0，不打扰） */
async function refreshArchiveOverdue(): Promise<void> {
  if (!(Number(archiveDays.value) > 0)) { archiveOverdue.value = { count: 0, items: [] }; return }
  try {
    const r: any = await (window as any).tegula?.tasksOverdue?.(archiveDays.value)
    archiveOverdue.value = { count: Number(r?.count || 0), items: Array.isArray(r?.items) ? r.items : [] }
  } catch { archiveOverdue.value = { count: 0, items: [] } }
}

/** 执行归档。auto=true（启动时自动执行）**不弹确认**——那是用户自己开的开关 */
async function runArchiveOverdue(auto = false): Promise<void> {
  const d = Number(archiveDays.value)
  if (!(d > 0)) { if (!auto) showToast('保留天数填 0 = 功能关闭，不执行', 'info'); return }
  if (!auto && archiveOverdue.value.count > 0) {
    const yes = confirm(
      `把 ${archiveOverdue.value.count} 个「已完成超过 ${d} 天没动过」的任务移进归档区？\n\n` +
      `· 文件移动到 task-data/archive/，可在「归档」视图看到、可随时还原\n` +
      `· 不删除任何东西`,
    )
    if (!yes) return
  }
  const r: any = await (window as any).tegula?.tasksArchiveOverdue?.(d)
  if (!r || r.ok === false) { showToast(`归档失败：${(r && r.message) || '未知原因'}`, 'error'); return }
  const ok = (r.archived || []).length
  const bad = (r.failed || []).length
  if (ok || bad) showToast(`已归档 ${ok} 个已完成任务${bad ? `（${bad} 个失败）` : ''}`, bad ? 'error' : 'success')
  else if (!auto) showToast('没有超期的已完成任务', 'info')
  await loadAll()
  await refreshArchiveOverdue()
}

// ── 主题（2026-09-29 用户第 4 条：「多主题颜色外观并不存在…参考绒花墨坊做一下」）──
// 做法照抄绒花墨坊：一套浅色主题只换令牌，挂 <html data-theme>；只做浅色（墨坊同款硬规矩）。
// 真身 prefs.json（fc_theme）；这里在挂载前先贴一次，避免开屏闪一下默认色。
const THEME_LIST = [
  { id: 'default', name: '雾灰紫', dot: '#705fab' },
  { id: 'pink',    name: '黛粉',   dot: '#ac4657' },
  { id: 'blue',    name: '湖蓝',   dot: '#3668ab' },
  { id: 'green',   name: '青竹',   dot: '#377457' },
  { id: 'orange',  name: '暖橙',   dot: '#975c21' },
  { id: 'gray',    name: '素灰',   dot: '#65687b' },
]
const theme = ref(readUiPref<string>('fc_theme', 'default'))
function applyTheme(id: string): void {
  theme.value = THEME_LIST.some(t => t.id === id) ? id : 'default'
  if (theme.value === 'default') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme.value
}
function setTheme(id: string): void {
  applyTheme(id)
  saveUiPref('fc_theme', theme.value)
  const name = THEME_LIST.find(t => t.id === theme.value)?.name || '雾灰紫'
  showToast(`已切换主题：${name}`, 'success')
}
applyTheme(theme.value)

// ── 板面偏好：分组方式 + 分组折叠状态 ────────────────────────────────────
// 2026-09-25 用户反馈「像没有尽头的单子」→ 分组要有**人名**（不是 fangcun-base 这种 id）+ 可折叠。
// 真身存主进程 prefs.json（与 014 同一套），localStorage 只当读缓存。
function readUiPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const v = JSON.parse(raw)
    return (v ?? fallback) as T
  } catch { return fallback }
}
function saveUiPref(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* 缓存失败无所谓 */ }
  try { (window as any).tegula?.prefsSet?.(key, value)?.catch?.(() => {}) } catch { /* 真身失败已在主进程记日志 */ }
}
/**
 * 终态分组默认折叠（2026-09-28 密度方案 B）。
 *
 * 依据：方寸自己的哲学是「颜色只留给要注意的事」「已归档默认收起」——
 * **完成/驳回是终态，平时不需要看**，它们却常常是最长的一列（14 张能顶满一屏，
 * 把真正在动的活卡挤到看不见）。所以首次运行就把这两列收起来，需要时点列头展开。
 * 用户手动展开过就记进真身（`fc_collapsed_groups`），不会被默认值盖回去。
 * ⚠ 这只在「按状态」分组下有意义：按项目/优先级分组时列 key 是项目 id，
 *   默认值匹配不上，等于不折叠（那是正确行为 —— 那些列里混着终态和非终态）。
 */
const DEFAULT_COLLAPSED_GROUPS: string[] = ['完成', '驳回']
const collapsedGroups = ref<string[]>(readUiPref<string[]>('fc_collapsed_groups', DEFAULT_COLLAPSED_GROUPS))
const groupModeApplied = ref(false)

/**
 * 设置页分类导航（2026-10-03 用户：设置项不该挤在一条长名单里，要"像各大软件那样用侧边栏页签分类"）。
 *
 * 上一版做的「点标题折叠」（`fc_settings_collapsed`）被这个取代：折叠解决的是"太长"，
 * 侧边栏解决的是"找不到"—— 后者才是真正的诉求，两套并存只会更乱。
 *
 * 当前分类记进真身（`fc_settings_tab`），下次打开还停在那一页。
 * ⚠ 只认这里列出的 id（prefs.json 可以手改，写进一个不存在的分类名会让右侧空白）。
 */
const SETTINGS_TABS = [
  { id: 'general', name: '通用', icon: '⚙' },
  { id: 'data', name: '数据与归档', icon: '🗂' },
  { id: 'agent', name: 'Agent', icon: '🤖' },
  { id: 'projects', name: '项目', icon: '📦' },
  { id: 'backup', name: '备份与恢复', icon: '🛡️' },
  { id: 'diag', name: '诊断', icon: '🩺' },
] as const
const settingsTabs = SETTINGS_TABS
const settingsTab = ref<string>(readUiPref<string>('fc_settings_tab', 'general'))
function selectSettingsTab(id: string): void {
  if (!SETTINGS_TABS.some(t => t.id === id)) return
  settingsTab.value = id
  saveUiPref('fc_settings_tab', id)
}

/** 与主进程 prefs.json 对齐（真身优先；真身空而缓存有值 → 迁移一次） */
async function syncBoardPrefs(): Promise<void> {
  try {
    const p: any = await window.tegula.prefsGet()
    if (typeof p?.fc_board_group_mode === 'string' && p.fc_board_group_mode) {
      groupMode.value = p.fc_board_group_mode
    } else {
      saveUiPref('fc_board_group_mode', groupMode.value)
    }
    if (Array.isArray(p?.fc_collapsed_groups)) {
      collapsedGroups.value = p.fc_collapsed_groups
    } else {
      saveUiPref('fc_collapsed_groups', collapsedGroups.value)
    }
    // 设置页当前分类（卡 013 改为侧边栏分类）：白名单字面量校验，坏值回退 'general'
    if (typeof p?.fc_settings_tab === 'string' && SETTINGS_TABS.some(t => t.id === p.fc_settings_tab)) {
      settingsTab.value = p.fc_settings_tab
    } else {
      saveUiPref('fc_settings_tab', settingsTab.value)
    }
    // 日志分区折叠状态（2026-09-28：取代旧的 fc_log_archive_open 单分区开关）。
    // ⚠ 这里在 syncBoardPrefs 里读，而 collapsedLogGroups 在文件下方才声明 ——
    //    所以只能在这里做**赋值**，不能在声明前调用它的读写函数（TDZ）。
    if (Array.isArray(p?.fc_log_group_collapsed)) {
      collapsedLogGroups.value = p.fc_log_group_collapsed
    } else {
      saveUiPref('fc_log_group_collapsed', collapsedLogGroups.value)
    }
    // 「含归档」开关同样入真身（2026-09-25 用户第 9 条）
    if (typeof p?.fc_include_archive === 'boolean') {
      searchIncludeArchive.value = p.fc_include_archive
    } else {
      saveUiPref('fc_include_archive', searchIncludeArchive.value)
    }
    // 硬件加速开关（用户第 1/3/9 条的人工验证杠杆）
    if (typeof p?.fc_disable_gpu === 'boolean') {
      disableGpu.value = p.fc_disable_gpu
    } else {
      saveUiPref('fc_disable_gpu', disableGpu.value)
    }
    // 多视图选择（2026-09-28）：与分组方式同一套，真身优先、缓存兜底。
    // ⚠ 这里只认**白名单里的字面量**：prefs.json 是可以手改的，写进一个不存在的视图名
    //   会让界面渲染成"两个按钮都不高亮、内容还是默认那个"的诡异状态。
    if (p?.fc_board_view === 'cols' || p?.fc_board_view === 'list') {
      boardView.value = p.fc_board_view
    } else {
      saveUiPref(BOARD_VIEW_KEY, boardView.value)
    }
    if (p?.fc_todo_view === 'list' || p?.fc_todo_view === 'grid') {
      todoView.value = p.fc_todo_view
    } else {
      saveUiPref(TODO_VIEW_KEY, todoView.value)
    }
    // 看板排序方式（2026-09-29：它此前是个**死控件**，顺手接上后同样要进真身）
    if (p?.fc_board_sort === 'active' || p?.fc_board_sort === 'updated' || p?.fc_board_sort === 'created') {
      sortMode.value = p.fc_board_sort
    } else {
      saveUiPref('fc_board_sort', sortMode.value)
    }
    // 主题（2026-09-29 用户第 4 条）
    if (typeof p?.fc_theme === 'string' && THEME_LIST.some(t => t.id === p.fc_theme)) {
      if (p.fc_theme !== theme.value) applyTheme(p.fc_theme)
    } else {
      saveUiPref('fc_theme', theme.value)
    }
    // 已完成日志默认保留天数（2026-09-29 用户第 6 条）
    if (typeof p?.fc_log_retain_days === 'number' && Number.isFinite(p.fc_log_retain_days) && p.fc_log_retain_days >= 0) {
      logRetainDefault.value = Math.floor(p.fc_log_retain_days)
    } else {
      saveUiPref('fc_log_retain_days', logRetainDefault.value)
    }
    // 看板已完成任务自动归档（卡 012）：天数 + 启动自动执行开关
    if (typeof p?.fc_archive_days === 'number' && Number.isFinite(p.fc_archive_days) && p.fc_archive_days >= 0) {
      archiveDays.value = Math.floor(p.fc_archive_days)
    } else {
      saveUiPref('fc_archive_days', archiveDays.value)
    }
    if (typeof p?.fc_archive_auto === 'boolean') {
      archiveAuto.value = p.fc_archive_auto
    } else {
      saveUiPref('fc_archive_auto', archiveAuto.value)
    }
    // 项目页签摆法（2026-09-29 用户：「两种视图都要，做成用户可自选切换选项」）
    if (p?.fc_pv_view === 'tiles' || p?.fc_pv_view === 'overview' || p?.fc_pv_view === 'master') {
      pvView.value = p.fc_pv_view
    } else {
      saveUiPref(PV_VIEW_KEY, pvView.value)
    }
    groupModeApplied.value = true
  } catch { /* 读不到就用缓存/默认值 */ }
}

/** 点分组标题 = 折叠/展开（状态写回真身，重启后保留） */
function toggleGroup(key: string): void {
  collapsedGroups.value = toggleCollapsed(collapsedGroups.value, key)
  saveUiPref('fc_collapsed_groups', collapsedGroups.value)
}
function groupCollapsed(key: string): boolean {
  return isCollapsed(collapsedGroups.value, key)
}
/**
 * 一键全折叠 / 全展开（2026-09-28 用户第 3 条改成**单按钮开关**）。
 *
 * 原来界面上并排放着「折叠全部」和「展开」两个按钮，**其中必定有一个是无效按钮**
 * （已经全折叠时点「折叠全部」什么都不发生，反之亦然）—— 用户原话「臃肿无比」。
 * 现在按钮的文案与动作都由 `allGroupsCollapsed` 决定，界面上永远只有一个。
 */
function toggleAllCollapsed(): void {
  const next = !allGroupsCollapsed.value
  collapsedGroups.value = next ? columns.value.map(c => c.key) : []
  saveUiPref('fc_collapsed_groups', collapsedGroups.value)
}
const allGroupsCollapsed = computed(() =>
  columns.value.length > 0 && columns.value.every(c => groupCollapsed(c.key)))

// ── 多视图切换（2026-09-28 用户第 ① 条后半句 + 卡 033）────────────────────
// 用户原话：「尝试多种视图可选（用户自己切换，旧的视图可以保留）」；
// 033 验收驳回原话：「我要的方块卡片式视图和其他视图也没出现，多视图根本没做。」
//
// 三条口径（小样 references/multi-view-sample-20260928.html，用户已点头按小样做）：
//   ① **旧视图永远是默认**（看板=列视图 / 待办=清单）—— 新视图是"换一种摆法看同一批数据"，
//      不是替换。谁都不必因为多了个选项而重新学一遍界面。
//   ② 选择写进**真身 prefs.json**（与 `fc_board_group_mode` 同一套机制），换 origin 不丢。
//   ③ 切换器放**页头**，不塞进已经够挤的顶栏（顶栏现有 9 个控件）。
//
// ⚠ 这里是"同一批 columns / 同一份折叠状态"换个摆法，**不重算数据**：
//   列表视图读的就是 columns.value，折叠读的就是 collapsedGroups —— 两个视图之间
//   来回切不会出现"条数不一样 / 折叠状态丢失"。
const BOARD_VIEW_KEY = 'fc_board_view'
const TODO_VIEW_KEY = 'fc_todo_view'
const PV_VIEW_KEY = 'fc_pv_view'
const boardView = ref<'cols' | 'list'>(readUiPref<'cols' | 'list'>(BOARD_VIEW_KEY, 'cols'))
const todoView = ref<'list' | 'grid'>(readUiPref<'list' | 'grid'>(TODO_VIEW_KEY, 'list'))
// 项目页签的三种摆法（2026-09-29 用户口径：「项目页签两种视图都要，做成用户可自选切换选项」）。
// ⚠ 默认仍是**旧的项目墙** —— 方寸铁律「加视图一律新增可选、旧的保留、旧视图永远是默认」。
//   `tiles` 是 003 卡里那句「只是个大号看板入口」的现状；overview/master 是那两句抱怨的两个解。
const pvView = ref<'tiles' | 'overview' | 'master'>(
  readUiPref<'tiles' | 'overview' | 'master'>(PV_VIEW_KEY, 'tiles'))

/** 当前页签可选的视图（空数组 = 这个页签没有多视图，页头整条不渲染） */
const viewOptions = computed<Array<{ v: string; label: string; hint: string }>>(() => {
  if (isBoardView.value) return [
    { v: 'cols', label: '▦ 列视图', hint: '按列摊开，可拖拽改状态；列多时要横向滚' },
    { v: 'list', label: '☰ 列表视图', hint: '单列纵排 + 状态分区，不横滚，一屏看得多半；分区头仍可折叠、可拖入改状态' },
  ]
  if (curView.value === 'todos') return [
    { v: 'list', label: '☰ 清单', hint: '两行卡：上行标题、下行优先级/项目/到期，右侧动作；批量勾选最快' },
    { v: 'grid', label: '▦ 卡片网格', hint: '方块卡片，长标题最多 3 行不截断；点标题进编辑，右键出菜单' },
  ]
  if (curView.value === 'projects') return [
    { v: 'tiles', label: '▦ 项目墙', hint: '现状：一格一个项目，四个数字（进行中/总数/完成率/最近活动）' },
    { v: 'overview', label: '▤ 概览卡', hint: '状态分布条 + 最近动态 + 阻塞/方针/结构地图缺口，一眼看出项目卡在哪' },
    { v: 'master', label: '◧ 主从', hint: '左侧常驻项目列表（带迷你进度），右侧摊开所选项目的详情；项目多了更顺手' },
  ]
  return []
})
const currentViewMode = computed(() =>
  curView.value === 'todos' ? todoView.value
    : curView.value === 'projects' ? pvView.value
      : boardView.value)
const viewHint = computed(() =>
  viewOptions.value.find(o => o.v === currentViewMode.value)?.hint || '')

/** 切视图：只改"摆法"，数据与筛选一律不动 */
function setViewMode(v: string): void {
  if (curView.value === 'todos') {
    todoView.value = v === 'grid' ? 'grid' : 'list'
    saveUiPref(TODO_VIEW_KEY, todoView.value)
  } else if (curView.value === 'projects') {
    pvView.value = v === 'overview' ? 'overview' : v === 'master' ? 'master' : 'tiles'
    saveUiPref(PV_VIEW_KEY, pvView.value)
  } else if (isBoardView.value) {
    boardView.value = v === 'list' ? 'list' : 'cols'
    saveUiPref(BOARD_VIEW_KEY, boardView.value)
  }
}

// ── 卡片悬停轻提示（2026-09-28 密度方案 B 的配套）─────────────────────
// 紧凑单行卡的代价是长标题被省略号吃掉。补救方案见模板里的注释：
// 不做悬停滚动、不做 1–2 秒延迟浮层，只做「真的被截断 + 150ms + 半张详情卡」。
const CARD_TIP_DELAY_MS = 150
type CardTip = {
  x: number; y: number; up: boolean
  title: string; body: string; status: string; statusClass: string
  project: string; due: string; overdue: boolean; priority: string; tags: string[]
}
const cardTip = ref<CardTip | null>(null)
let cardTipTimer: ReturnType<typeof setTimeout> | null = null

/** 贴住卡片下沿；右侧/下侧空间不够就翻到左边/上方（不越界） */
const cardTipStyle = computed(() => {
  const t = cardTip.value
  if (!t) return {}
  const x = Math.max(8, Math.min(t.x, window.innerWidth - 352))
  return t.up
    ? { left: x + 'px', bottom: (window.innerHeight - t.y + 8) + 'px' }
    : { left: x + 'px', top: (t.y + 6) + 'px' }
})

function onCardEnter(e: MouseEvent, t: any): void {
  // 拖拽中绝不弹：拖着卡片划过一整列时，浮层会一路跟着闪
  // ⚠ **必须是 `draggingId.value`**：`draggingId` 是 `ref<string|null>`，
  //   裸写 `if (draggingId)` 判断的是那个 ref 对象 —— 恒为真，于是这条守卫
  //   把**每一次悬停**都挡掉了，浮层永远不出现（2026-09-28 用户实测「②看不见」的真因）。
  //   这类「ref 裸用当布尔」tsc 抓不到，已加静态守卫 ⑧（check-template-bindings.cjs）。
  if (draggingId.value) return
  const el = e.currentTarget as HTMLElement | null
  const head = el ? (el.querySelector('.ttl') as HTMLElement | null) : null
  // **只在真的被截断时才提示** —— 没被截断的卡永远不会弹出任何东西，界面更安静
  if (!head || head.scrollWidth <= head.clientWidth + 1) return
  const r = el!.getBoundingClientRect()
  const due = String(t.deadline || t.due || '').trim()
  if (cardTipTimer) clearTimeout(cardTipTimer)
  cardTipTimer = setTimeout(() => {
    cardTipTimer = null
    cardTip.value = {
      x: r.left,
      y: r.bottom,
      up: r.bottom + 170 > window.innerHeight,
      title: String(t.title || t.id || ''),
      body: truncate(String(t.body || '').replace(/\s+/g, ' '), 220),
      status: String(t.status || ''),
      statusClass: statusClass(t.status),
      project: t.project ? projShort(t.project) : '',
      due: shortDue(due),
      overdue: isOverdue(t),
      priority: String(t.priority || ''),
      tags: Array.isArray(t.tags) ? t.tags.slice(0, 6) : [],
    }
  }, CARD_TIP_DELAY_MS)
}
function onCardLeave(): void {
  if (cardTipTimer) { clearTimeout(cardTipTimer); cardTipTimer = null }
  cardTip.value = null
}

/** 截止日压成 MM-DD（卡上只有一行的宽度预算） */
function shortDue(v: any): string {
  const s = String(v == null ? '' : v).trim()
  if (!s) return ''
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (ymd) return `${ymd[2]}-${ymd[3]}`
  if (/^\d{2}-\d{2}$/.test(s)) return s
  const t = Date.parse(s)
  if (Number.isFinite(t)) {
    const d = new Date(t)
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return s.slice(0, 10)
}

/** 项目名压短（卡右侧只有 ~68px）。
 *  ⚠ 必须过 `normProject`：任务 frontmatter 的「项目」是**数组**（`[fangcun-base]`），
 *  直接拿 `t.project` 去比项目 id 永远匹配不上 —— 那样卡上就"看不见所属项目"（用户 2026-09-28 反馈）。 */
function projShort(id: any): string {
  const key = normProject(id)
  if (!key) return '未归属'
  const name = projects.value.find((p: any) => p.id === key)?.name || key
  return name.length > 7 ? name.slice(0, 7) + '…' : name
}

/** 卡上的日期：优先截止日（可行动的信息），没有就退到「更新」—— 保证卡上永远看得见一个日期 */
function cardDate(t: any): { text: string; over: boolean; kind: 'due' | 'updated' } {
  const due = String(t?.deadline || t?.due || '').trim()
  if (due) return { text: '📅' + shortDue(due), over: isOverdue(t), kind: 'due' }
  const up = String(t?.updated || '').trim()
  if (up) return { text: '更新 ' + shortDue(up), over: false, kind: 'updated' }
  return { text: '', over: false, kind: 'updated' }
}

// 切换分组方式也记进真身：下次打开还是你上次用的那种分组
watch(groupMode, v => saveUiPref('fc_board_group_mode', v))
// 排序方式进真身（与分组方式同一套机制）：换 origin / 重启后仍是你上次选的那个
const sortMode = ref<string>(readUiPref<string>('fc_board_sort', 'active'))
watch(sortMode, v => saveUiPref('fc_board_sort', v))
const showArchiveHint = ref(!localStorage.getItem('fc_archive_hint_seen'))
function closeArchiveHint() {
  showArchiveHint.value = false
  localStorage.setItem('fc_archive_hint_seen', '1')
}
const searchQuery = ref('')
// 解析失败的任务文件（主进程收集）。以前 parseTask 失败是静默跳过 ——
// 2026-09-18 真实发生过 6 个任务因标题含 ": " 而在看板上隐身数月。
const parseErrors = ref<string[]>([])
// 2026-09-25（用户第 9 条）：默认**不勾**「含归档」。
// 归档任务混进主视图只增加视觉压迫感；要看归档本来就有独立视图与可折叠分区。
// 用户的选择写进真身 prefs.json（localStorage 只是读缓存）。
const searchIncludeArchive = ref(readUiPref<boolean>('fc_include_archive', false))
const dueFilter = ref('')
const isNaturalQuery = ref(false)
const naturalResults = ref<Task[]>([])
const backupInfo = ref<{ path: string; sizeKB: number } | null>(null)

// First-run wizard state
const showWizard = ref(false)
const wizardStep = ref(0)
const wizardInitMode = ref<'fresh' | 'import'>('fresh')
const wizardDataDir = ref('')
const wizardPythonDir = ref('')
const wizardFinishing = ref(false)
const wizardSteps = [
  { title: '选择数据目录' },
  { title: '初始化方式' },
  { title: '确认配置' },
]
const wizardCanNext = computed(() => {
  if (wizardStep.value === 0) return wizardDataDir.value.trim().length > 0
  if (wizardStep.value === 1 && wizardInitMode.value === 'import') return wizardPythonDir.value.trim().length > 0
  return true
})

watch(searchIncludeArchive, v => { saveUiPref('fc_include_archive', v); loadAll() })
const draggingId = ref<string | null>(null)
const dragoverCol = ref<string | null>(null)
const previewTask = ref<Task | null>(null)
const editTask_ = ref<any>(null)
// 启动台「添加/编辑应用」模态的开关 + 表单载体。
// ⚠ 此前 template（v-if / v-model / 取消按钮）与 openAddApp / saveEditApp 全都在用它，
// 唯独这里没声明 → 点「+ 添加应用」立刻 ReferenceError，界面毫无反应；
// v-if 恒为 undefined 也让模态永不出现。同一个按钮因此被反复报修（"第六次了"），
// 而历次修复都在改 CSS / dialog / 原子写 —— 没碰到真因。
const editApp_ = ref<any>(null)
const showSettings_ = ref(false)

// ── 备份 v2（WebDAV + 静默调度 + 可验证恢复） ────────────────────────

interface BkForm {
  url: string
  username: string
  password: string
  hasPassword: boolean
  enabled: boolean
  intervalHours: number
  firstDelayMinutes: number
  localKeep: number
  remoteKeep: number
  allowSelfSigned: boolean
  localDir: string
}

const bkForm = ref<BkForm>({
  url: '', username: '', password: '', hasPassword: false,
  enabled: true, intervalHours: 6, firstDelayMinutes: 5,
  localKeep: 10, remoteKeep: 10, allowSelfSigned: false, localDir: '',
})
const bkMsg = ref('')
const bkMsgType = ref('info')
const bkBusy = ref(false)
const bkTesting = ref(false)
const bkTab = ref<'local' | 'remote'>('local')
const bkLocal = ref<any[]>([])
const bkRemote = ref<any[]>([])
const bkStatus = ref<any>({ enabled: false, running: false, nextRunAt: null, state: {} })
const bkState = computed<any>(() => bkStatus.value.state || {})
const bkShowLog = ref(false)
const bkLogLines = ref<string[]>([])
const bkVerifyResult = ref<any>(null)
let bkUnsub: (() => void) | null = null

const bkCurrentList = computed(() => (bkTab.value === 'local' ? bkLocal.value : bkRemote.value))
const bkAlert = computed(() => !bkStatus.value.running && (bkState.value.failStreak || 0) > 0)

const bkDotClass = computed(() => {
  if (bkStatus.value.running) return 'bk-running'
  if ((bkState.value.failStreak || 0) > 0) return 'bk-bad'
  if (bkState.value.lastSuccessAt) return 'bk-ok'
  return 'bk-idle'
})

const bkStatusText = computed(() => {
  const st = bkState.value
  if (bkStatus.value.running) return '正在备份…'
  if ((st.failStreak || 0) > 0) return `连续失败 ${st.failStreak} 次`
  if (st.lastSuccessAt) return `上次成功 ${bkFmt(st.lastSuccessAt)} · ${st.lastFiles || 0} 个文件`
  return bkStatus.value.enabled || bkStatus.value.intervalHours ? '尚未执行过备份' : '自动备份已关闭'
})

const bkTooltip = computed(() => {
  const parts = ['备份：' + bkStatusText.value]
  if (bkState.value.lastRemotePath) parts.push('云端：已同步')
  else if (bkForm.value.url) parts.push('云端：未同步')
  return parts.join(' · ')
})

function bkFmt(ts: string | null | undefined): string {
  if (!ts) return '—'
  return formatDateTime(ts)
}

async function bkInitBackup() {
  await bkRefreshStatus()
  try {
    bkUnsub = window.tegula.onBackupStatus((s: any) => { bkStatus.value = s })
  } catch { /* 订阅失败不影响手动操作 */ }
}

async function bkRefreshStatus() {
  const r = await window.tegula.backupStatus()
  if (r.ok) bkStatus.value = r.status
}

async function bkLoadConfig() {
  const r = await window.tegula.backupGetConfig()
  if (!r.ok) return
  const c = r.config
  bkForm.value = {
    url: c.remote.url || '',
    username: c.remote.username || '',
    password: '',
    hasPassword: !!c.remote.hasPassword,
    enabled: !!c.enabled,
    intervalHours: c.intervalHours,
    firstDelayMinutes: c.firstDelayMinutes,
    localKeep: c.localKeep,
    remoteKeep: c.remoteKeep,
    allowSelfSigned: !!c.remote.allowSelfSigned,
    localDir: c.localDir || '',
  }
}

async function bkLoadList() {
  const l = await window.tegula.backupListLocal()
  if (l.ok) bkLocal.value = l.items
  if (bkTab.value === 'remote') {
    const rr = await window.tegula.backupListRemote()
    bkRemote.value = rr.ok ? rr.items : []
  }
}

// ── 导出备份（2026-09-26 用户第 1、2 条：一次点击、只落一个 zip）────────
// 用户原话：「导出又是导出四个文件，我只认识压缩包…只应该存在一样东西」＋
//          「导出的备份文件要手动选下拉列表…必须逐字核对，很难受」。
// 因此这里没有下拉了：直接取**最新一份已有备份**，点一下就导出（主进程只落一个 zip）；
// 一份备份都没有时才让主进程现打一份全量包。
/** 已有备份按**最后更新**倒序（2026-09-25 第 5 条：用户要的是"最后更新的排前面"） */
const bkExportCandidates = computed(() =>
  [...(bkLocal.value || [])].sort((a: any, b: any) =>
    (Date.parse(b.mtime || '') || 0) - (Date.parse(a.mtime || '') || 0)
    || String(b.name || '').localeCompare(String(a.name || '')))
)

/** 最新一份已有备份的路径；没有备份时返回空串（= 让主进程现打一份） */
function bkLatestPackagePath(): string {
  return bkExportCandidates.value.length ? String(bkExportCandidates.value[0].path || '') : ''
}


function bkSwitchTab(t: 'local' | 'remote') {
  bkTab.value = t
  bkLoadList()
}

async function bkSaveConfig(silent = false): Promise<boolean> {
  const f = bkForm.value
  const patch: any = {
    enabled: f.enabled,
    intervalHours: f.intervalHours,
    firstDelayMinutes: f.firstDelayMinutes,
    localKeep: f.localKeep,
    remoteKeep: f.remoteKeep,
    localDir: f.localDir.trim(),
    remote: {
      url: f.url.trim(),
      username: f.username.trim(),
      allowSelfSigned: f.allowSelfSigned,
    },
  }
  // 留空 = 沿用已保存密文；只有真输入了新密码才提交
  if (f.password.trim()) patch.remote.password = f.password.trim()

  const r = await window.tegula.backupSetConfig(patch)
  if (!r.ok) {
    bkMsg.value = '保存失败：' + (r.error || '未知错误')
    bkMsgType.value = 'error'
    return false
  }
  bkForm.value.password = ''
  bkForm.value.hasPassword = !!r.config.remote.hasPassword
  if (!silent) {
    bkMsg.value = '配置已保存'
    bkMsgType.value = 'success'
  }
  await bkRefreshStatus()
  return true
}

function bkReportResult(r: any, label: string) {
  const res = r.result
  if (r.ok && res) {
    bkMsg.value = `${label}成功 · ${res.files} 个文件 · ${(res.rawBytes / 1024).toFixed(0)} KB` +
      (res.remotePath ? ' · 已上云' : ' · 仅本地')
    bkMsgType.value = res.remotePath ? 'success' : 'info'
  } else {
    const first = (res && res.errors && res.errors[0]) || r.error || '未知错误'
    const extra = res && res.warnings && res.warnings.length ? `（${res.warnings[0]}）` : ''
    bkMsg.value = `${label}失败：${first}${extra}`
    bkMsgType.value = 'error'
  }
}

async function bkSaveAndRun() {
  if (bkBusy.value) return
  if (!(await bkSaveConfig(true))) return
  bkBusy.value = true
  bkMsg.value = ''
  try {
    bkReportResult(await window.tegula.backupRun(), '备份')
  } finally {
    bkBusy.value = false
    await bkLoadList()
    await bkRefreshStatus()
  }
}

async function bkRunLocalOnly() {
  if (bkBusy.value) return
  bkBusy.value = true
  bkMsg.value = ''
  try {
    bkReportResult(await window.tegula.backupRunLocalOnly(), '本地备份')
  } finally {
    bkBusy.value = false
    await bkLoadList()
    await bkRefreshStatus()
  }
}

async function bkTestRemote() {
  if (bkTesting.value) return
  bkTesting.value = true
  bkMsg.value = ''
  try {
    const r = await window.tegula.backupTestRemote({
      url: bkForm.value.url.trim(),
      username: bkForm.value.username.trim(),
      password: bkForm.value.password.trim(),
      allowSelfSigned: bkForm.value.allowSelfSigned,
    })
    bkMsg.value = (r.ok ? '✅ ' : '❌ ') + (r.detail || r.error || '测试失败')
    bkMsgType.value = r.ok ? 'success' : 'error'
  } finally {
    bkTesting.value = false
  }
}

async function bkRestore(b: any) {
  if (bkBusy.value) return
  const where = bkTab.value === 'local' ? '本地' : '远端'
  if (!confirm(`确认从${where}备份恢复？\n\n${b.name}\n\n当前数据会先做快照，恢复失败将自动回滚。`)) return
  bkBusy.value = true
  try {
    const source = bkTab.value === 'local'
      ? { kind: 'local', path: b.path }
      : { kind: 'remote', name: b.name }
    const r = await window.tegula.backupRestore(source)
    if (r.ok) {
      bkMsg.value = `已恢复 ${r.restoredFiles} 个文件；恢复前快照：${r.snapshotDir || '(无)'}`
      bkMsgType.value = 'success'
      await loadAll()
    } else {
      bkMsg.value = '恢复失败：' + ((r.errors && r.errors[0]) || r.error || '未知错误')
      bkMsgType.value = 'error'
    }
  } finally {
    bkBusy.value = false
    await bkLoadList()
  }
}

async function bkOpenDir() {
  const r = await window.tegula.backupOpenDir()
  if (!r.ok) bkMsg.value = '打开目录失败：' + (r.error || '')
}

async function bkToggleLog() {
  bkShowLog.value = !bkShowLog.value
  if (bkShowLog.value) {
    const r = await window.tegula.backupLog(150)
    if (r.ok) bkLogLines.value = r.lines
  }
}

async function bkPickDir() {
  const r = await window.tegula.backupPickDir()
  if (r.ok && r.dir) bkForm.value.localDir = r.dir
}

/** 导出到任意目录（典型用途：网盘同步文件夹，由客户端负责上传） */
async function bkExportTo() {
  if (bkBusy.value) return
  bkBusy.value = true
  bkMsg.value = ''
  try {
    // 2026-09-26 用户第 1、2 条：不再让用户挑包，直接导最新那份（没有才现打）；
    // 主进程只落一个 zip，所以这里报的就是「那一个文件」。
    const latest = bkLatestPackagePath()
    const r = await window.tegula.backupExportTo(latest ? { package: latest } : {})
    if (r.canceled) return
    if (r.ok) {
      const res = r.result
      const name = String(res.zipPath || '').split(/[\\/]/).pop() || 'zip'
      bkMsg.value = `已导出 ${name}（1 个文件 · ${(res.bytes / 1024).toFixed(0)} KB）→ ${res.dir}`
      bkMsgType.value = 'success'
      if (res.errors && res.errors.length) {
        bkMsg.value += ' ｜ 提醒：' + res.errors[0]
        bkMsgType.value = 'info'
      }
    } else {
      bkMsg.value = '导出失败：' + ((r.result && r.result.errors && r.result.errors[0]) || r.error || '未知错误')
      bkMsgType.value = 'error'
    }
  } finally {
    bkBusy.value = false
  }
}

/** 被点开查看的那一行（只做视觉标记，避免"点了好像没反应"） */
const bkInspected = ref('')

/**
 * 点某一行备份 = **看这一份里到底有什么**（2026-09-28 卡 026-001 的验收驳回）。
 *
 * 用户原话：「依然不能手动点来选中备份，回收站都能点了，备份不能点，无语。」
 * 真因：`.bk-item` 是一个**没有 @click 的死 div**，行上只有「恢复」按钮；
 * 想确认内容只能另点「🔍 校验备份包…」——那会弹文件选择器，让人从零开始找那个 zip，
 * 而这一份明明就在眼前。
 *
 * 复用现成的 `backup:verifyPackage`（它本来就支持直接传路径）。
 * 远端行不下载就不校验 —— 说实话告诉用户，不假装能看。
 */
async function bkInspectRow(b: any) {
  if (bkBusy.value) return
  if (bkTab.value === 'remote') {
    showToast('远端备份要先下载到本地才能看内容；点「恢复」会自动下载并校验', 'info')
    return
  }
  const p = String(b?.path || '')
  if (!p) { showToast('这一行没有可用路径', 'error'); return }
  bkBusy.value = true
  try {
    const r = await window.tegula.backupVerifyPackage(p)
    if (r && r.canceled) return
    bkInspected.value = String(b.name || '')
    bkVerifyResult.value = {
      ok: !!(r && r.ok),
      name: String((r && r.path) || p).split(/[\\/]/).pop() || '',
      errors: (r && r.errors) || [],
      manifest: (r && r.manifest) || null,
      entries: (r && r.entries) || 0,
    }
  } catch (e: any) {
    showToast('查看失败：' + (e?.message || e), 'error')
  } finally {
    bkBusy.value = false
  }
}

/** 校验任意位置的备份包（含从网盘下载回来的副本） */
async function bkVerifyPackage() {
  if (bkBusy.value) return
  bkBusy.value = true
  bkVerifyResult.value = null
  try {
    const r = await window.tegula.backupVerifyPackage()
    if (r.canceled) return
    bkVerifyResult.value = {
      ok: !!r.ok,
      name: String(r.path || '').split(/[\\/]/).pop() || '',
      errors: r.errors || [],
      manifest: r.manifest || null,
      entries: r.entries || 0,
    }
  } finally {
    bkBusy.value = false
  }
}

/** 从任意 zip 文件恢复（先校验，校验不过不动数据） */
async function bkRestoreFromFile() {  if (bkBusy.value) return
  const pick = await window.tegula.backupPickRestoreFile()
  if (!pick.ok || !pick.path) return
  const name = String(pick.path).split(/[\\/]/).pop()
  if (!confirm(
    `确认从该文件恢复？\n\n${name}\n\n` +
    `恢复前会先做完整性校验；校验不通过则不会改动任何数据。\n` +
    `现有数据会自动打快照，替换失败会回滚。`
  )) return
  bkBusy.value = true
  try {
    const r = await window.tegula.backupRestore({ kind: 'local', path: pick.path })
    if (r.ok) {
      bkMsg.value = `已恢复 ${r.restoredFiles} 个文件；恢复前快照：${r.snapshotDir || '(无)'}`
      bkMsgType.value = 'success'
      await loadAll()
    } else {
      bkMsg.value = '恢复失败：' + ((r.errors && r.errors[0]) || r.error || '未知错误')
      bkMsgType.value = 'error'
    }
  } finally {
    bkBusy.value = false
    await bkLoadList()
  }
}

const batchMode = ref(false)
const selectedBatch = ref<string[]>([])
const logBatchMode = ref(false)
const selectedLogBatch = ref<string[]>([])
// 多选（2026-09-30 用户补充：「待办和回收站也加入多选，这些也是常用场景」）
// —— 复用看板/日志同一套交互：工具条开关 + 卡片点选 + 悬浮批量栏。
const todoBatchMode = ref(false)
const selectedTodoBatch = ref<string[]>([])
const trashBatchMode = ref(false)
const selectedTrashBatch = ref<string[]>([])
const dataDir = ref('')

// ── Todos ─────────────────────────────────────────────────────────
interface Todo {
  id: string
  title: string
  done: boolean
  // ⚠ 实际存的是中文「高/中/低」（主进程 normalizePriority 归一）。
  // 这里此前写成 'high' | 'normal' | 'low' —— 类型与数据不符，是历史残留。
  priority: string
  due?: string
  project?: string
  createdAt: string
  updatedAt: string
}
const todos = ref<Todo[]>([])
const todoFilter = ref('all')

// ── Review ─────────────────────────────────────────────────────────
const reviewModal = ref<{ id: string; title: string } | null>(null)
const launchpadApps = ref<any[]>([])
const launchpadConfigPath = ref('')
const blockerChains = ref<any[]>([])
const totalBlockedTasks = computed(() => blockerChains.value.reduce((sum, s) => sum + (s.blockedTasks?.length || 0), 0))
const roadmapData = ref<any>({ projects: [] })
const projectProgress = ref<Record<string, any>>({})

// ── 通知中心（Notification Center）─────────────────────────────────
// UI 按用户原型 notification-center.html 移植；数据走 notifications:* IPC
const NC_TYPE_META: Record<string, { icon: string; label: string; glyph: string }> = {
  'todo-due':      { icon: 'calendar', label: '待办到期', glyph: '📅' },
  'task-deadline': { icon: 'task',     label: '任务逾期', glyph: '📋' },
  'task-timeout':  { icon: 'approve',  label: '超时未回写', glyph: '⏱' },
  'parse-error':   { icon: 'security', label: '解析失败', glyph: '⚠' },
  'backup-failed': { icon: 'storage', label: '备份失败', glyph: '💾' },
  'update-downloaded': { icon: 'storage', label: '更新已就绪', glyph: '⬆' },
  // 2026-10-01 用户定稿新增的两类（只在面板里看，不弹系统通知）。
  // icon 复用现有 security/approve —— 新 icon 得配 nc-t-*/nc-av-* 两套主题色，没必要为两个标签开新面。
  'blocker-broken': { icon: 'security', label: '阻塞链断裂', glyph: '⛓' },
  'task-stalled':   { icon: 'approve',  label: '任务没动静', glyph: '💤' },
}
const ncOpen = ref(false)
const ncReady = ref(false)
const ncLoading = ref(false)
const ncUnread = ref(0)
const ncItems = ref<any[]>([])
const ncFilter = ref<'all' | 'unread' | 'read'>('all')
let ncTimer: number | null = null

const ncCounts = computed(() => {
  const unread = ncItems.value.filter(n => !n.read).length
  return { all: ncItems.value.length, unread, read: ncItems.value.length - unread }
})
const ncVisible = computed(() => {
  return ncItems.value.filter(n => {
    if (ncFilter.value === 'unread' && n.read) return false
    if (ncFilter.value === 'read' && !n.read) return false
    return true
  })
})
const ncHeadSub = computed(() => ncUnread.value
  ? `你有 ${ncUnread.value} 条未读通知`
  : '全部通知均已读')

function ncRelTime(iso: string): string {
  return relTimeShort(iso)
}

/** P0-4：扫描器状态（running/lastScanAt）。拿不到 = 老版本 preload，显示"未知"即可。 */
const ncStatus = ref<{ running: boolean; lastScanAt: string | null } | null>(null)
/** P0-5：被静音（删过）的提醒 key —— 必须看得见、能恢复，否则点过 🗑 就是 7 天哑巴。 */
const ncMuted = ref<string[]>([])

const ncStatusText = computed(() => {
  const s = ncStatus.value
  if (!s) return '扫描器状态：未知'
  const when = s.lastScanAt ? `上次扫描 ${ncRelTime(s.lastScanAt)}` : '尚未扫描'
  return `${s.running ? '扫描器运行中' : '扫描器已停止'} · ${when}`
})

async function ncLoad(): Promise<void> {
  try {
    const [list, unread] = await Promise.all([
      (window as any).tegula.notificationsList(),
      (window as any).tegula.notificationsUnreadCount(),
    ])
    ncItems.value = list || []
    ncUnread.value = unread || 0
  } catch { /* IPC 失败静默，ncReady 已做入口探测 */ }
  // 状态与静音是**增强项**：通道缺失时保持"未知"，不能让整块面板挂掉
  try {
    const t = (window as any).tegula
    if (typeof t.notificationsScannerStatus === 'function') {
      ncStatus.value = await t.notificationsScannerStatus()
    }
    if (typeof t.notificationsListMuted === 'function') {
      ncMuted.value = (await t.notificationsListMuted()) || []
    }
  } catch { /* 老 preload 没有这两条通道 */ }
}

/** P0-5：一次性把被忽略的提醒全部放出来（静音是 7 天 TTL，这里给手动恢复口） */
async function ncUnmuteAll(): Promise<void> {
  try {
    const t = (window as any).tegula
    const n = typeof t.notificationsUnmuteAll === 'function' ? await t.notificationsUnmuteAll() : 0
    showToast(`已恢复 ${n || 0} 条被忽略的提醒`, 'success')
    await ncLoad()
  } catch {
    showToast('恢复被忽略提醒失败', 'error')
  }
}

async function ncRefresh(): Promise<void> {
  if (ncLoading.value) return
  ncLoading.value = true
  try {
    await (window as any).tegula.notificationsScan()
    await ncLoad()
  } catch { /* ignore */ }
  setTimeout(() => { ncLoading.value = false }, 400)
}

function ncToggle(): void {
  if (ncOpen.value) { closePanel(); return }
  ncOpen.value = true
  ncLoad()
}

function closePanel(): void {
  ncOpen.value = false
}

function ncSetFilter(f: 'all' | 'unread' | 'read'): void {
  ncFilter.value = f
}

/**
 * 通知 → 可跳目标的标签。**返回 null = 这条没有可跳对象（只标已读）**。
 * 同一个函数同时驱动三件事：行尾箭头显不显示、title 提示、点击后跳哪 —— 三处必须一致，
 * 否则会出现「箭头亮着点了没反应」这种新的"无效按钮"（2026-10-01 用户第 1 条原话）。
 */
function ncTargetOf(n: any): string | null {
  const t = String(n.type || '')
  if (['task-deadline', 'task-timeout', 'task-stalled', 'blocker-broken'].includes(t)) {
    return n.sourceId ? '跳到这个任务' : null
  }
  if (t === 'todo-due') return '跳到待办'
  if (t === 'parse-error') return '查看解析错误'
  if (t === 'backup-failed' || t === 'update-downloaded') return '打开设置'
  return null
}

/**
 * 通知点击跳转（2026-10-01 用户第 1 条：「目前点下去是无效按钮」）。
 *
 * 口径：先按原行为标已读，再跳。跳不成（任务已被删除/已归档）只 toast 说明，不影响已读 ——
 * 不能因为目标没了就让面板卡在原地。
 */
async function ncJump(n: any): Promise<void> {
  if (!ncTargetOf(n)) return
  const t = String(n.type || '')
  closePanel()
  if (['task-deadline', 'task-timeout', 'task-stalled', 'blocker-broken'].includes(t)) {
    let task: any = null
    try { task = await (window as any).tegula.getTask(n.sourceId) } catch { /* 旧版本没有该通道时静默 */ }
    if (task) {
      navigateTo('active')   // 任务只在看板列里，先切过去再开预览
      openCard(task)         // 复用看板卡片的打开路径（含关联日志加载）
    } else {
      showToast(`任务 ${n.sourceId} 已不在活跃区（可能被删除或已归档）`, 'error')
    }
    return
  }
  if (t === 'todo-due') { navigateTo('todos'); return }
  if (t === 'parse-error') { showParseErrors(); return }
  if (t === 'backup-failed' || t === 'update-downloaded') { showSettings_.value = true; return }
}

async function ncClickItem(n: any): Promise<void> {
  if (!n.read) {
    try {
      await (window as any).tegula.notificationsMarkRead(n.id)
      n.read = true
      ncUnread.value = Math.max(0, ncUnread.value - 1)
    } catch { /* ignore */ }
  }
  await ncJump(n)
}

async function ncToggleRead(n: any): Promise<void> {
  try {
    await (window as any).tegula.notificationsMarkRead(n.id)
    if (!n.read) { n.read = true; ncUnread.value = Math.max(0, ncUnread.value - 1) }
  } catch { /* ignore */ }
}

async function ncMarkAllRead(): Promise<void> {
  try {
    await (window as any).tegula.notificationsMarkAllRead()
    await ncLoad()
  } catch { /* ignore */ }
}

async function ncDelete(n: any): Promise<void> {
  try {
    await (window as any).tegula.notificationsDelete(n.id)
    await ncLoad()
  } catch { /* ignore */ }
}

async function ncClearAll(): Promise<void> {
  try {
    await (window as any).tegula.notificationsClear()
    await ncLoad()
  } catch { /* ignore */ }
}

function onDocumentClick(e: MouseEvent): void {
  if (!ncOpen.value) return
  const wrap = (e.target as HTMLElement).closest('.nc-wrap, .nc-panel, .nc-bell')
  if (!wrap) closePanel()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (ncOpen.value) { closePanel(); return }
  // 2026-09-26 卡 033：Esc 关掉**最上层弹窗**。同样不逐个维护弹窗清单：
  // 取 DOM 里最后一个 .overlay，点它的「取消」（.acts .ghost）。找不到就什么都不做。
  const overlays = Array.from(document.querySelectorAll('.overlay')) as HTMLElement[]
  const top = overlays[overlays.length - 1]
  const cancel = top ? (top.querySelector('.acts .ghost') as HTMLElement | null) : null
  if (cancel) cancel.click()
}

/** 全局快捷键（2026-09-25 用户第 6 条：「希望有一些简单的快捷键，比如保存和撤销」）
 *
 *  Ctrl/Cmd+S = 保存当前打开的弹窗。
 *  · 不逐个维护「哪个弹窗开着」：`v-if` 的弹窗关着时根本不在 DOM 里，所以直接取
 *    当前 DOM 里可见的最后一个 `.overlay`，点它的**主操作按钮 `.acts .pri`**。
 *    以后新增弹窗自动被覆盖，不会漏接线（上一轮「通道早通、UI 无入口」就是漏接线）。
 *  · **只认 `.pri`**：验收弹窗的「通过」是 `.ok`、驳回是 `.danger` —— 裁决类按钮
 *    **刻意不接管**，Ctrl+S 误触一下就把任务验收了，代价太大，必须用手点。
 *  · Ctrl+Z 不接管：输入框里的原生撤销本来就是对的，接管反而会破坏它。
 */
function onShortcutKeydown(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
  if (e.key !== 's' && e.key !== 'S') return
  // 无论有没有弹窗都拦掉默认行为：Chromium 的 Ctrl+S 是「保存网页」，在 Electron 里
  // 可能弹出保存对话框，比什么都不做更烦人。
  e.preventDefault()
  const overlays = Array.from(document.querySelectorAll<HTMLElement>('.overlay'))
    .filter(el => window.getComputedStyle(el).display !== 'none')
  const top = overlays[overlays.length - 1]
  if (!top) return
  const btn = top.querySelector<HTMLButtonElement>('.acts button.pri')
  if (btn && !btn.disabled) btn.click()
}

function ncInit(): void {
  const t = (window as any).tegula
  ncReady.value = !!(t && typeof t.notificationsList === 'function')
  if (!ncReady.value) return  // preload 未暴露通知 IPC → 隐藏铃铛（防僵尸按钮）
  document.addEventListener('mousedown', onDocumentClick)
  document.addEventListener('keydown', onKeydown)
  ncLoad()
  // 30s 轮询未读数（轻量，只拉计数）
  ncTimer = window.setInterval(() => {
    (window as any).tegula.notificationsUnreadCount().then((c: number) => { ncUnread.value = c || 0 }).catch(() => {})
  }, 30_000)
}

const toast = reactive({ show: false, msg: '', type: 'info' })



// Logs polling: refresh logs list every 5s when viewing logs
watch(curView, (val) => {
  if (val === 'logs') {
    loadLogs()
    logPollingTimer = setInterval(loadLogs, 5000)
  } else {
    if (logPollingTimer) {
      clearInterval(logPollingTimer)
      logPollingTimer = null
    }
  }
})

const views = [
  { id: 'active', label: '看板' },
  { id: 'todos', label: '待办' },
  { id: 'logs', label: '日志' },
  { id: 'projects', label: '项目' },
  { id: 'blockers', label: '阻塞' },
  { id: 'roadmap', label: '路线图' },
  { id: 'calendar', label: '日历' },
  { id: 'archive', label: '归档' },
  { id: 'trash', label: '回收站' },
  { id: 'launchpad', label: '启动台' },
  { id: 'skills', label: '技能' },
  { id: 'services', label: '服务' },
]

const pickerStyle = {
  right: '20px',
  top: '50%',
  transform: 'translateY(-50%)',
}

// ── Computed ────────────────────────────────────────────────────────────

const boardClass = computed(() => ({
  pv: curView.value === 'projects',
  'batch-mode': batchMode.value,
  // 列表视图（2026-09-28）：把 #board 从"横向排的列"换成"纵向滚动的分区"。
  // ⚠ 必须是**类**而不是 v-if 换 main —— main#board 是 flex 容器，
  //   两种摆法共用同一个容器才能保住 flex:1 + overflow 的滚动行为。
  'list-mode': isBoardView.value && boardView.value === 'list',
}))

// Normalize project field: array → first element, or empty string
function normProject(p: any): string {
  if (!p) return ''
  if (Array.isArray(p)) return p[0] || ''
  return p
}

// filteredTasks defined after archiveTask below

const columns = computed(() => {
  const filtered = filteredTasks.value
  const cols: Record<string, Task[]> = {}

  if (groupMode.value === 'status') {
    STATUSES.forEach(s => (cols[s] = []))
    filtered.forEach(t => {
      const k = t.status || '草稿'
      if (!cols[k]) cols[k] = []
      cols[k].push(t)
    })
    return STATUSES.map(s => ({ key: s, label: s, tasks: cols[s] || [] }))
  }

  if (groupMode.value === 'priority') {
    const groups: Record<string, Task[]> = {}
    filtered.forEach(t => {
      const k = localPriority(t.priority)
      if (!groups[k]) groups[k] = []
      groups[k].push(t)
    })
    // 已识别优先级固定三列；无法识别的值兜底成「其他」一列。
    // 早期这里用 high/normal/low 作 key，而数据里是中文，导致所有有优先级的任务在
    // 「按优先级」视图下集体消失。
    const cols = taskPriorities.value.map(p => ({ key: p, label: p + '优先级', tasks: groups[p] || [] }))
    const others = Object.keys(groups).filter(k => !taskPriorities.value.includes(k))
    if (others.length) {
      cols.push({ key: '其他', label: '其他优先级', tasks: others.flatMap(k => groups[k]) })
    }
    return cols
  }

  // 按项目：规则抽到 shared/grouping.ts（纯逻辑，可脚本断言）；标签解析成**项目名**，
  // 不再把 fangcun-base 这种内部 id 直接当标题（用户 2026-09-25：「看了等于没看」）。
  return buildProjectGroups(filtered as any, projectNameOf)
})

/** 项目 id → 显示名（找不到就回退 id，绝不留空标题） */
function projectNameOf(id: string): string {
  if (!id) return ''
  const p: any = (projects.value as any[]).find(x => x && x.id === id)
  return (p && (p.name || p.id)) || id
}

// ── 项目页签两种新摆法的数据（2026-09-29）────────────────────────────────
// 003 卡的驳回原话是「只是个大号看板入口，不是项目管理」。缺的不是数字，
// 是**关系**：任务卡在哪个状态、最近谁动过、有没有阻塞、方针与结构地图缺不缺。
// 这三份派生数据只服务于概览卡/主从，不进 projectStats（那是项目墙在用的，口径不能动）。

/** 每个项目的状态分布（概览卡的状态条 + 图例），与「总任务」同口径：只算活跃任务 */
const pvBreakdown = computed<Record<string, Array<{ status: string; n: number; cls: string }>>>(() => {
  const out: Record<string, Array<{ status: string; n: number; cls: string }>> = {}
  for (const p of projects.value) {
    const m = new Map<string, number>()
    for (const t of tasks.value) {
      if (normProject(t.project) !== p.id) continue
      const s = t.status || '未标记'
      m.set(s, (m.get(s) || 0) + 1)
    }
    out[p.id] = [...m.entries()]
      .map(([status, n]) => ({ status, n, cls: statusClass(status) }))
      .sort((a, b) => b.n - a.n)
  }
  return out
})

/** 每个项目最近动过的那条任务（「最近：<相对时间> · <标题>」） */
const pvLatest = computed<Record<string, Task | null>>(() => {
  const out: Record<string, Task | null> = {}
  for (const p of projects.value) {
    let best: Task | null = null
    for (const t of tasks.value) {
      if (normProject(t.project) !== p.id) continue
      if (!t.updated) continue
      if (!best || Number(parseTime(t.updated)) > Number(parseTime(best.updated))) best = t
    }
    out[p.id] = best
  }
  return out
})

/** 每个项目头上压着几条阻塞（阻塞源按它自己所属的项目计） */
const pvBlocked = computed<Record<string, number>>(() => {
  const byId = new Map(tasks.value.map(t => [t.id, t]))
  const out: Record<string, number> = {}
  for (const c of blockerChains.value) {
    const t = byId.get(c.id)
    const pid = t ? normProject(t.project) : ''
    if (pid) out[pid] = (out[pid] || 0) + 1
  }
  return out
})

/** 状态条/图例的底色 —— 与 statusClass 同一套语汇，颜色按"冷→暖→收口"排 */
const STATUS_SEG_COLOR: Record<string, string> = {
  draft: '#c3bce0', review: '#b8a6d9', todo: '#9ca3af', doing: '#6366f1',
  verify: '#d9a44a', done: '#54814b', reject: '#b44141',
}
function statusSegColor(cls: string): string {
  return STATUS_SEG_COLOR[cls] || '#c3bce0'
}

/** 状态条一格的宽度（按任务数占比）；没有任务时给 0，条子自然空着 */
function segWidth(n: number, total: number): string {
  return total > 0 ? (n / total * 100).toFixed(2) + '%' : '0%'
}

/** 项目完成进度（0~100）—— 主从/概览共用；progress 还没读回来时是 0 而不是 NaN */
function projectPercent(id: string): number {
  const pp = (projectProgress.value || {})[id]
  return pp && Number.isFinite(pp.percent) ? pp.percent : 0
}

/** 主从视图左侧选中的项目（默认第一个；不写 prefs —— 记一个可能消失的项目 id 没意义） */
const pvSelected = ref<string>('')
const pvCurrent = computed(() =>
  projectStats.value.find(p => p.id === pvSelected.value) || projectStats.value[0] || null)

const projectStats = computed(() => {
  return projects.value.map(p => {
    const projTasks = tasks.value.filter(t => normProject(t.project) === p.id)
    const active = projTasks.filter(t => t.status !== '完成' && t.status !== '驳回')
    const completed = projTasks.filter(t => t.status === '完成')
    let lastActivity: string | null = null
    for (const t of projTasks) {
      if (t.updated && (!lastActivity || t.updated > lastActivity)) {
        lastActivity = t.updated
      }
    }
    return {
      id: p.id,
      name: p.name || p.id,
      // 概览卡要显示工作目录（registry 里登记的那个）——项目墙不用它，但同一份数据顺手带上
      repo: p.repo || '',
      taskCount: projTasks.length,
      activeTasks: active.length,
      completedTasks: completed.length,
      lastActivity,
      health: computeHealth(projTasks, lastActivity),
    }
  })
})

// ── Functions ───────────────────────────────────────────────────────────

function computeHealth(tasks: Task[], lastActivity: string | null): string {
  if (tasks.length === 0) return 'idle'
  if (!lastActivity) return 'dormant'
  const days = daysSince(lastActivity)
  if (!Number.isFinite(days)) return 'dormant'
  if (days > 30) return 'dormant'
  if (days > 7) return 'stuck'
  return 'active'
}

function healthLabel(h: string): string {
  return { active: '活跃', stuck: '停滞', dormant: '休眠', idle: '空闲' }[h] || h
}

function isActiveStatus(s: string): boolean {
  return ['进行中', '待验收', '待审批', '待办'].includes(s)
}

function isStale(t: Task): boolean {
  if (!t.updated) return false
  const days = daysSince(t.updated)
  return Number.isFinite(days) && days > 14 && isActiveStatus(t.status || '')
}

/**
 * 逾期判定（任务 + 待办共用）。
 *
 * 2026-09-26 卡 033：这里原本是 `return false` 的**空桩** —— 任务逾期从来没实现过。
 * 待办专项整修要用同一个概念，就地补齐（而不是再写一个同名函数）：
 *   · 待办看 `done`；任务看 `status`（完成/驳回不算逾期）；
 *   · 日期字段任务叫 deadline/截止，待办叫 due，都认；
 *   · 只有**严格过期**才算（今天到期不算逾期）—— 用 daysSince >= 1 判断。
 */
function isOverdue(t: any): boolean {
  if (!t) return false
  if (t.done === true) return false
  const status = String(t.status || '')
  if (status === '完成' || status === '驳回') return false
  const due = t.due || t.deadline || (t.fm && (t.fm.deadline || t.fm['截止']))
  if (!due) return false
  const d = daysSince(due)
  return Number.isFinite(d) && d >= 1
}

function statusClass(s: string): string {
  return {
    草稿: 'draft', 待审批: 'review', 待办: 'todo',
    进行中: 'doing', 待验收: 'verify', 完成: 'done', 驳回: 'reject',
  }[s] || 'draft'
}

function statusColor(s: string): string {
  return {
    草稿: '#9ca3af', 待审批: '#f59e0b', 待办: '#6366f1',
    进行中: '#d9a44a', 待验收: '#e8a34a', 完成: '#5e9154', 驳回: '#c96a6a',
  }[s] || '#9ca3af'
}

function truncate(s: string, n: number): string {
  return s?.length > n ? s.slice(0, n) + '...' : s || ''
}

// formatDate / relativeTime 已抽到 shared/time.ts（统一兼容 ISO / 秒级数字 / MM-DD，坏输入给 '—'）

// ── Data loading ────────────────────────────────────────────────────────

async function loadLaunchpad() {
  try {
    launchpadApps.value = await window.tegula.launchpadLoadApps()
    launchpadConfigPath.value = await window.tegula.launchpadGetConfigPath()
  } catch {
    launchpadApps.value = []
  }
}

/**
 * 阻塞链数据。
 *
 * 2026-09-22 补：`loadViewData('blockers')` 一直在调用它，但**这个函数从未被定义** ——
 * 点「阻塞」页签直接 `Uncaught ReferenceError: loadBlockerChains is not defined`，
 * 页面停在上一个视图，且不弹任何错。tsc / vite / stub e2e / IPC 对账全都抓不到
 * （函数体里的未定义名要等运行到那一行才抛），已由 `check-template-bindings.cjs`
 * 新增的「② 调用了但未定义」检查兜住。
 */
async function loadBlockerChains() {
  try {
    blockerChains.value = await window.tegula.getBlockerChains()
  } catch {
    blockerChains.value = []
  }
}

// ── 数据目录迁移 ─────────────────────────────────────────────────────
const migrateTarget = ref<any>(null)
const migrateBusy = ref(false)

// ── 新建规划 / 新建项目（替代 Electron 未实现的 window.prompt） ────────
const projForm = ref<{ id: string; name: string; repo: string; description: string } | null>(null)
const projCreating = ref(false)

/**
 * 切换数据目录。
 *
 * 旧实现是 `prompt('输入新数据目录路径')` —— Electron 未实现 window.prompt()，
 * 调用即抛错且无 try/catch，点这个按钮什么都不会发生。而且它只切指针不搬数据。
 * 现在：目录选择对话框 → 只读体检 → 自建模态确认 → 备份+复制+切指针。
 */
async function changeDataDir() {
  const picked = await window.tegula.browseDirectory()
  if (!picked) return

  const r = await window.tegula.dataInspect(picked)
  if (!r.ok) {
    showToast('检查目录失败：' + (r.error || '未知错误'), 'error')
    return
  }
  const info = r.info
  if (info.isCurrent) {
    showToast('这就是当前数据目录', 'info')
    return
  }
  if (info.insideCurrent) {
    showToast('目标不能位于当前数据目录内部', 'error')
    return
  }
  // 目标已有方寸数据：让用户选「仅切换指向」还是「复制式迁移」。
  // 2026-09-22 数据分裂事故：仓库根与 %APPDATA% 各有一份数据时，
  // 覆盖式迁移会拿旧数据盖掉新数据 —— 必须给「仅切换」出路。
  if (!info.empty) {
    if (confirm(`目标目录已有方寸数据（${info.taskCount} 个任务文件）。\n\n【确定】= 仅切换指向（推荐，两边数据都已各自保留，不复制不覆盖）\n【取消】= 返回，改用下方「覆盖式迁入」流程`)) {
      try {
        const sr = await window.tegula.setDataDir(info.dir)
        if (!sr.ok) { showToast('切换失败：' + sr.error, 'error'); return }
        dataDir.value = info.dir
        showToast('已切换数据目录（仅指向，未复制）：' + info.dir, 'success')
        await loadAll()
      } catch (e: any) {
        showToast('切换异常：' + (e?.message || e), 'error')
      }
      return
    }
    // 用户选了取消 → 走原有覆盖式迁移确认弹窗
  }
  migrateTarget.value = info
}

async function confirmMigrate() {
  const info = migrateTarget.value
  if (!info || migrateBusy.value) return
  migrateBusy.value = true
  try {
    const r = await window.tegula.dataMigrate(info.dir, { allowExisting: !info.empty })
    if (!r.ok) {
      showToast('迁移失败：' + (r.error || '未知错误'), 'error')
      return
    }
    dataDir.value = r.to
    migrateTarget.value = null
    await loadAll()
    showToast(`已迁移 ${r.migrated.copiedFiles} 个文件到新目录（原目录已保留）`, 'success')
  } finally {
    migrateBusy.value = false
  }
}

async function openDataDir() {
  await window.tegula.launchpadOpenFolder(dataDir.value)
}

/** 视图历史栈 + 返回（左上角「← 返回」走这里）。
 *  此前所有视图切换都是裸赋值 `curView.value = v`，从项目页点进某个项目后
 *  没有任何后退入口 —— 只能再点一次左侧页签绕回去。 */
const viewHistory = ref<string[]>([])
const canGoBack = computed(() => viewHistory.value.length > 0)

/** 视图数据加载（切换与返回共用，避免两处逻辑漂移） */
function loadViewData(v: string) {
  if (v === 'launchpad') {
    loadLaunchpad()
  } else if (v === 'blockers') {
    loadBlockerChains()
  } else if (v === 'roadmap') {
    loadRoadmap()
  } else if (v === 'todos') {
    loadTodos()
  } else if (v === 'logs') {
    loadLogs()
  } else if (v === 'trash') {
    // 回收站不加载任务列表（顶栏计数显示「—」是刻意的，见 countText 注释）
    loadTrash()
  } else if (v === 'skills') {
    loadSkills()
    loadAgents()
    loadMcpInfo()
  } else if (v === 'services') {
    loadServices()
  } else if (v === 'calendar') {
    // 日历要看任务 + 待办两条数据源（2026-09-22，用户第 6 条：此前完全不拉待办）
    loadAll()
    loadTodos()
  } else if (v === 'projects') {
    // 2026-09-29 补：**项目页签此前从不加载方针状态** —— `loadPolicyMap()` 只在打开设置页
    // 和结构地图一览时调过。于是项目卡上那句三态文案（已立 / 待填 / ＋立方针）在没开过设置的
    // 会话里**永远显示"＋ 立项目方针"**，概览卡上的「方针：未立」同源。
    // 这不是显示瑕疵，是**界面在说假话**（明明立了方针却报未立），所以进门就刷一次。
    loadAll()
    loadPolicyMap()
  } else {
    loadAll()
  }
}

/** 唯一跳转入口：入栈 + 加载。所有视图跳转都必须走它，否则「返回」会丢来源 */
function navigateTo(v: string) {
  if (v !== curView.value) {
    viewHistory.value.push(curView.value)
    if (viewHistory.value.length > 20) viewHistory.value.shift()
  }
  // 收起所有右键菜单（2026-09-26 实测）：菜单只认自己那层遮罩的点击，
  // 键盘/程序化跳转时会把上一个页签的菜单留在屏幕上，像"卡住的浮层"。
  closeCardMenu()
  closeOtherMenu()
  curView.value = v
  loadViewData(v)
}

function switchView(v: string) {
  navigateTo(v)
}

/** 返回上一个视图（出栈，不再入栈） */
function goBack() {
  const prev = viewHistory.value.pop()
  if (!prev) return
  curView.value = prev
  loadViewData(prev)
}

async function loadRoadmap() {
  try {
    const result = await window.tegula.aggregateRoadmap()
    roadmapData.value = result
  } catch {
    roadmapData.value = { projects: [] }
  }
}


function roadmapHealthLabel(h: string): string {
  return { active: '活跃', stuck: '卡住', idle: '空闲' }[h] || h
}

async function loadProjectProgressMap() {
  try {
    // 一次 IPC 拿全部项目进度。原先逐项目 await = 项目数 × 全量扫描，
    // 12 个项目在 5000 任务档要 13.9s（压测数据），现在是 1 次扫描。
    projectProgress.value = await window.tegula.allProjectProgress()
  } catch {
    projectProgress.value = {}
  }
}

// ── 回收站（2026-09-26 卡 034）──────────────────────────────────────────
// 现象：`.trash/` 里有几十个文件、数据完好，但界面没有任何入口，用户以为"东西没了"。
// 语义：一律按**文件名**操作（回收站里同一 id 可能有多份历史副本：`x.md` 与 `x.2.md`），
//       还原时的同名冲突交给主进程的 moveIntoDir（内容相同去重、不同则新的占规范名、
//       旧的改名保留）→ 绝不覆盖、绝不删除。
interface TrashItem {
  name: string
  id: string
  title?: string
  status?: string
  project?: string
  bytes?: number
  mtime?: string
}

const trashItems = ref<TrashItem[]>([])
const trashLoading = ref(false)
const trashQuery = ref('')

/** 回收站条目总占用（KB）—— 几十项时一眼知道"这些垃圾有多大" */
const trashTotalKb = computed(() =>
  Math.round(trashItems.value.reduce((s, x) => s + (x.bytes || 0), 0) / 1024))

/** 回收站内搜索：id / 标题 / 文件名 三个字段都认 */
const filteredTrash = computed(() => {
  const q = trashQuery.value.trim().toLowerCase()
  if (!q) return trashItems.value
  return trashItems.value.filter(x =>
    String(x.id || '').toLowerCase().includes(q) ||
    String(x.title || '').toLowerCase().includes(q) ||
    String(x.name || '').toLowerCase().includes(q))
})

async function loadTrash(): Promise<void> {
  trashLoading.value = true
  try {
    const r = await window.tegula.trashList()
    trashItems.value = (r && r.items) || []
  } catch {
    trashItems.value = []
  } finally {
    trashLoading.value = false
  }
}

async function restoreTrashItem(it: TrashItem): Promise<void> {
  const r = await window.tegula.trashRestore(it.name)
  if (r && r.ok) {
    showToast(`已还原 ${it.id}${r.archived ? '（回归档区）' : ''}`, 'success')
    await loadTrash()
    // 只有在任务视图上才顺带刷新（回收站视图不加载任务列表；切过去时 loadViewData 会拉，
    // 在这里调 loadAll 会把顶栏计数从「—」变成任务条数，属于自相矛盾）
    if (curView.value !== 'trash') loadAll()
  } else {
    showToast(`还原失败：${(r && r.error) || '未知原因'}`, 'error')
  }
}

async function purgeTrashItem(it: TrashItem): Promise<void> {
  if (!confirm(`彻底删除「${it.title || it.id}」？\n\n文件：${it.name}\n这是从磁盘删除，不可撤销。`)) return
  const r = await window.tegula.trashPurge(it.name)
  if (r && r.ok) {
    showToast(`已彻底删除 ${it.name}`, 'success')
    await loadTrash()
  } else {
    showToast(`删除失败：${(r && r.error) || '未知原因'}`, 'error')
  }
}

// ── 回收站多选（2026-09-30 用户补充：「待办和回收站也加入多选，这些也是常用场景」）──
// 交互与看板/日志/待办同一套：工具条开关 → 点条目勾选 → 悬浮批量栏执行。
// 选中键用 it.name（同 id 可能有同名副本，name = trash 里的文件名，唯一）。
function toggleTrashBatchMode() {
  trashBatchMode.value = !trashBatchMode.value
  if (!trashBatchMode.value) selectedTrashBatch.value = []
  else showToast('批量模式：点击条目勾选，再从下方批量栏执行', 'success')
}
function toggleTrashBatchSelect(name: string) {
  const idx = selectedTrashBatch.value.indexOf(name)
  if (idx >= 0) selectedTrashBatch.value.splice(idx, 1)
  else selectedTrashBatch.value.push(name)
}
/**
 * 回收站条目点击（2026-09-30 用户第 5 条，卡 task-20260930-005）。
 * 热区从 .trash-main 扩到**整行** —— 行内 padding / 两行之间的空隙原来都是死区，
 * 点了没反应，用户只能「点好几次」碰运气。动作按钮（还原/删除）的点击不参与选择。
 */
function onTrashItemClick(it: TrashItem, e: MouseEvent): void {
  const t = e.target as HTMLElement | null
  if (t && t.closest && t.closest('.trash-actions')) return
  if (trashBatchMode.value) toggleTrashBatchSelect(it.name)
  else openTrashPreview(it)
}
function toggleSelectAllTrash() {
  if (selectedTrashBatch.value.length === filteredTrash.value.length) selectedTrashBatch.value = []
  else selectedTrashBatch.value = filteredTrash.value.map((t: any) => t.name)
}
function exitTrashBatch() {
  selectedTrashBatch.value = []
  trashBatchMode.value = false
}
async function executeBatchTrashRestore() {
  const names = [...selectedTrashBatch.value]
  if (!names.length) return
  let ok = 0
  for (const name of names) {
    try {
      const r: any = await window.tegula.trashRestore(name)
      if (r?.ok) ok++
    } catch { /* skip */ }
  }
  showToast(`已还原 ${ok}/${names.length} 项`, ok ? 'success' : 'error')
  exitTrashBatch()
  await loadTrash()
  // 回收站还原会改任务列表；与单条还原一致，只在非回收站视图才刷（此刻就在回收站，不用）
}
async function executeBatchTrashPurge() {
  const names = [...selectedTrashBatch.value]
  if (!names.length) return
  if (!confirm(`彻底删除选中的 ${names.length} 项？\n\n将从磁盘删除这些文件，不可撤销：\n` +
    names.slice(0, 10).map(n => `· ${n}`).join('\n') + (names.length > 10 ? `\n…等 ${names.length} 个` : ''))) return
  let ok = 0
  for (const name of names) {
    try {
      const r: any = await window.tegula.trashPurge(name)
      if (r?.ok) ok++
    } catch { /* skip */ }
  }
  showToast(`已彻底删除 ${ok}/${names.length} 项`, ok ? 'success' : 'error')
  exitTrashBatch()
  await loadTrash()
}

/**
 * 回收站卡片预览（2026-09-26 用户回执：「每个卡片都是不能点的死卡，确认这是设计意图？我可没想要这个」）
 *
 * 之前只有「还原 / 彻底删除」两个按钮 —— 卡片本体点了没反应，想删又怕删错，只能凭标题猜。
 * 现在点卡片任意位置读该文件的**源码正文**（只读），看完再决定；浮层里也给同一对动作。
 * 关闭时机有讲究：动作成功且这一份**真的从列表里消失了**才关，没删掉就把浮层留着（别骗用户）。
 */
interface TrashPreviewState {
  item: TrashItem
  text: string
  truncated: boolean
  loading: boolean
  error: string
}
const trashPreview = ref<TrashPreviewState | null>(null)

async function openTrashPreview(it: TrashItem): Promise<void> {
  trashPreview.value = { item: it, text: '', truncated: false, loading: true, error: '' }
  const t: any = window.tegula
  if (typeof t.trashRead !== 'function') {
    trashPreview.value = { item: it, text: '', truncated: false, loading: false, error: '当前主进程/预加载是旧版本，没有预览通道 —— 托盘右键「退出」后重开' }
    return
  }
  try {
    const r: any = await t.trashRead(it.name)
    if (!trashPreview.value || trashPreview.value.item.name !== it.name) return
    trashPreview.value = r && r.ok
      ? { item: it, text: String(r.text || ''), truncated: !!r.truncated, loading: false, error: '' }
      : { item: it, text: '', truncated: false, loading: false, error: `读不出来：${(r && r.error) || '未知原因'}` }
  } catch (e: any) {
    trashPreview.value = { item: it, text: '', truncated: false, loading: false, error: `读不出来：${e?.message || e}` }
  }
}

async function restoreFromPreview(): Promise<void> {
  const st = trashPreview.value
  if (!st) return
  await restoreTrashItem(st.item)
  if (!trashItems.value.some(x => x.name === st.item.name)) trashPreview.value = null
}

async function purgeFromPreview(): Promise<void> {
  const st = trashPreview.value
  if (!st) return
  await purgeTrashItem(st.item)
  if (!trashItems.value.some(x => x.name === st.item.name)) trashPreview.value = null
}

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
  await copyWithToast(sk.prompt, `已复制「${sk.id}」安装提示词 —— 粘给 agent 就能自己装`)
}

async function copySkillBody(sk: SkillUiRow): Promise<void> {
  if (!sk.body) { showToast('这份 SKILL.md 读不出来（文件缺失或为空）', 'error'); return }
  await copyWithToast(sk.body, `已复制「${sk.id}」SKILL.md 全文（${sk.body.length} 字）`)
}

async function installSkillsToHermes(): Promise<void> {
  const r: any = await window.tegula.skillsInstall()
  if (!r) { showToast('安装失败：主进程没有返回', 'error'); return }
  const parts: string[] = []
  if (r.installed && r.installed.length) parts.push(`已装 ${r.installed.length}`)
  if (r.skipped && r.skipped.length) parts.push(`跳过 ${r.skipped.length}`)
  if (r.errors && r.errors.length) parts.push(`失败 ${r.errors.length}`)
  showToast(`技能安装：${parts.join(' / ') || '无变化'}${r.errors && r.errors.length ? '（' + r.errors[0].error + '）' : ''}`,
    r.errors && r.errors.length ? 'error' : 'success')
  await loadSkills()
}

// ── 技能直接导入（2026-09-26 卡 005）──────────────────────────────────────
// 说明：重名时主进程返回 code='exists'，这里**问一句**再带 overwrite 重试；
// 校验类失败（invalid/too-large/reserved）直接报错，绝不静默覆盖。
async function importSkillPath(srcPath: string, overwrite = false): Promise<boolean> {
  const r: any = await window.tegula.skillsImport(srcPath, { overwrite })
  if (!r) { showToast('导入失败：主进程没有返回', 'error'); return false }
  if (r.ok) {
    showToast(`已导入「${r.name}」→ ${r.target}（${r.files} 个文件）`, 'success')
    await loadSkills()
    return true
  }
  if (r.code === 'exists') {
    const yes = confirm(`「${r.name}」已经存在。\n\n覆盖 = 用这个包替换掉现在那份；同名旧目录会先备份再替换，失败会还原。\n\n要覆盖吗？`)
    if (!yes) { showToast(`已取消导入「${r.name}」`, 'info'); return false }
    return await importSkillPath(srcPath, true)
  }
  showToast(`导入失败：${r.error || '未知原因'}`, 'error')
  return false
}

async function importSkillViaPicker(kind: 'file' | 'folder'): Promise<void> {
  const picked: any = await window.tegula.skillsImportPick(kind)
  if (!picked) { showToast('选择失败：主进程没有返回', 'error'); return }
  if (picked.canceled) return
  if (!picked.ok || !picked.path) { showToast(`选择失败：${picked.error || '未知原因'}`, 'error'); return }
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
  dragPulse() // 吃全局心跳，拖拽收场拿不到事件时遮罩也会自己消失
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
  if (!paths.length) { showToast('没读到拖入的路径 —— 请改用「📥 导入技能…」按钮', 'error'); return }
  let ok = 0
  for (const p of paths) {
    if (await importSkillPath(p)) ok++
  }
  if (paths.length > 1) showToast(`拖入 ${paths.length} 个，成功 ${ok} 个`, ok ? 'success' : 'error')
}

async function removeImportedSkill(im: { name: string; dir: string }): Promise<void> {
  if (!confirm(`移除「${im.name}」？\n\n只删这一个目录（${im.dir}），方寸自发布技能不受影响。`)) return
  const r: any = await window.tegula.skillsRemove(im.name)
  if (r && r.ok) {
    showToast(`已移除「${im.name}」`, 'success')
    await loadSkills()
  } else {
    showToast(`移除失败：${(r && r.error) || '未知原因'}`, 'error')
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
  try {
    const t: any = window.tegula
    if (typeof t.agentsList !== 'function') { agentTargets.value = []; return }
    const r: any = await t.agentsList()
    const raw: AgentTargetUi[] = Array.isArray(r) ? r : (r && r.agents) || []
    agentTargets.value = raw.map(a => {
      const b = agentLinkBadge(a)
      return { ...a, linkText: b.text, linkClass: b.cls }
    })
  } catch { agentTargets.value = [] }
}

/** 「⚡ 装到 X」：只对可直装且检测到的目标开（其余走「显示 SKILL.md + 打开对方」） */
async function installToTarget(a: AgentTargetUi): Promise<void> {
  const t: any = window.tegula
  if (typeof t.skillsInstallTo !== 'function') { showToast('当前主进程是旧版本，没有这个通道', 'error'); return }
  const r: any = await t.skillsInstallTo(a.id)
  if (!r) { showToast('安装失败：主进程没有返回', 'error'); return }
  const errs = r.errors || []
  if (errs.length && !r.installed.length) {
    showToast(`装到 ${a.name} 失败：${errs[0].error}`, 'error')
  } else {
    const parts: string[] = []
    if (r.installed && r.installed.length) parts.push(`已装 ${r.installed.length}`)
    if (r.skipped && r.skipped.length) parts.push(`跳过 ${r.skipped.length}`)
    if (errs.length) parts.push(`失败 ${errs.length}`)
    showToast(`装到 ${a.name}：${parts.join(' / ') || '无变化'}`, errs.length ? 'error' : 'success')
  }
  await loadSkills()
  await loadAgents()
}

async function openAgentTarget(a: AgentTargetUi): Promise<void> {
  const t: any = window.tegula
  if (typeof t.agentsOpen !== 'function') { showToast('当前主进程是旧版本，没有这个通道', 'error'); return }
  const r: any = await t.agentsOpen(a.id)
  if (r && r.ok) showToast(r.message || `已打开 ${a.name}`, 'success')
  else showToast(`打开失败：${(r && r.message) || '未知原因'}`, 'error')
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

const mcpEntryDetail = computed(() => {
  const e = mcpEntries.value.find(x => x.id === mcpEntry.value)
  if (!e) return ''
  return e.available ? e.usage : e.detail
})

async function loadMcpInfo(): Promise<void> {
  try {
    const t: any = window.tegula
    if (typeof t.mcpInfo !== 'function') { mcpInfoError.value = ''; mcpEntries.value = []; mcpTargets.value = []; return }
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
    mcpInfoError.value = e?.message || '读取 MCP 接入信息失败'
  }
}

async function copyMcpSnippet(m: McpTargetUi): Promise<void> {
  const t: any = window.tegula
  if (typeof t.mcpSnippet !== 'function') { showToast('当前主进程是旧版本，没有这个通道', 'error'); return }
  const r: any = await t.mcpSnippet(m.id, mcpEntry.value)
  if (!r || !r.ok) { showToast(`生成失败：${(r && r.message) || '未知原因'}`, 'error'); return }
  // 走主进程剪贴板（file:// 起源下 navigator.clipboard 会静默 reject）
  const c: any = await t.clipboardWriteText(r.snippet)
  if (c && c.ok !== false) showToast(`已复制 ${m.name} 的配置段 —— 打开对方配置文件粘贴保存即可`, 'success')
  else showToast(`复制失败：${(c && (c.error || c.message)) || '剪贴板不可用'}`, 'error')
}

/** 卡006（2026-10-03）：自装指令 —— A 路线第三渠道。复制一段贴给目标 agent 的完整指令，
 *  技能卡复制与配置写入全部由对方现地完成（耗它自己的 token，方寸仍零写入）。 */
async function copyMcpSelfInstall(m: McpTargetUi): Promise<void> {
  const t: any = window.tegula
  if (typeof t.mcpSelfInstall !== 'function') { showToast('当前主进程是旧版本，没有这个通道', 'error'); return }
  const r: any = await t.mcpSelfInstall(m.id, mcpEntry.value)
  if (!r || !r.ok) { showToast(`生成失败：${(r && r.message) || '未知原因'}`, 'error'); return }
  const c: any = await t.clipboardWriteText(r.prompt)
  if (c && c.ok !== false) showToast(`已复制给 ${m.name} 的自装指令 —— 打开对方粘贴，让它自己装`, 'success')
  else showToast(`复制失败：${(c && (c.error || c.message)) || '剪贴板不可用'}`, 'error')
}

async function openMcpConfig(m: McpTargetUi): Promise<void> {
  const t: any = window.tegula
  if (typeof t.mcpOpenConfig !== 'function') { showToast('当前主进程是旧版本，没有这个通道', 'error'); return }
  const r: any = await t.mcpOpenConfig(m.id)
  if (r && r.ok) showToast(r.message || `已打开 ${m.name} 的配置文件`, 'success')
  else showToast(`打开失败：${(r && r.message) || '未知原因'}`, 'error')
}

/** 在资源管理器里亮出某个技能目录/文件的 SKILL.md（主进程只允许技能目录内的路径） */
async function revealSkillPath(dirOrFile: string): Promise<void> {
  const t: any = window.tegula
  if (!dirOrFile) { showToast('这条技能没有可用的路径', 'error'); return }
  if (typeof t.skillsReveal !== 'function') { showToast('当前主进程是旧版本，没有这个通道', 'error'); return }
  const r: any = await t.skillsReveal(dirOrFile)
  if (r && r.ok) showToast(r.message || '已在资源管理器里亮出 SKILL.md', 'success')
  else showToast(`显示失败：${(r && r.message) || '未知原因'}`, 'error')
}

// ── 服务 / 端口（2026-09-26 卡 006）────────────────────────────────────
// 用户选的口径是 A 档：**只读监控 + 冲突预警**。这里没有任何"结束进程"入口 ——
// 别顺手加，那是用户明确排除的（且本仓有铁律：不许按镜像名批量杀进程）。
interface ServiceRowUi {
  id: string; name: string; port: number; note: string; project: string
  source: 'launchpad' | 'manual'
  listening: boolean; pid: number | null; processName: string; duplicated: boolean
}
const servicesRows = ref<ServiceRowUi[]>([])
const servicesUnregistered = ref<{ port: number; pid: number | null; processName: string }[]>([])
const servicesLoading = ref(false)
const servicesError = ref('')
const servicesDuplicates = ref<number[]>([])
const servicesListening = ref(0)
const servicesIdle = ref(0)
const servicesHidden = ref(0)
const svcName = ref('')
const svcPort = ref('')

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

async function addService(): Promise<void> {
  const name = svcName.value.trim()
  const port = Number(svcPort.value.trim())
  if (!name) { showToast('先填服务名（比如「方寸看板」）', 'error'); return }
  if (!Number.isInteger(port) || port < 1 || port > 65535) { showToast('端口要填 1-65535 的整数', 'error'); return }
  const r: any = await window.tegula.servicesAdd({ name, port })
  if (r && r.ok) {
    showToast(`已登记 ${name} :${port}`, 'success')
    svcName.value = ''
    svcPort.value = ''
    await loadServices()
  } else {
    showToast(`登记失败：${(r && r.error) || '未知原因'}`, 'error')
  }
}

async function removeService(s: ServiceRowUi): Promise<void> {
  if (!confirm(`取消登记「${s.name}」:${s.port}？\n\n只从手填清单里删掉这一条，不会动任何进程，也不会关掉正在跑的服务。`)) return
  const r: any = await window.tegula.servicesRemove(s.port)
  if (r && r.ok) { showToast(`已取消登记 :${s.port}`, 'success'); await loadServices() }
  else showToast(`取消失败：${(r && r.error) || '未知原因'}`, 'error')
}

async function openService(s: ServiceRowUi): Promise<void> {
  const r: any = await window.tegula.servicesOpen(s.port)
  if (r && r.ok) showToast(`已在浏览器打开 ${r.url}`, 'success')
  else showToast(`打开失败：${(r && r.error) || '未知原因'}`, 'error')
}

/** 把"未登记但正在监听"的端口登记进手填清单（默认名字取占用它的进程名） */
async function adoptService(u: { port: number; processName: string }): Promise<void> {
  const r: any = await window.tegula.servicesAdopt(u.port, u.processName)
  if (r && r.ok) { showToast(`已登记 :${u.port}（${u.processName}）`, 'success'); await loadServices() }
  else showToast(`登记失败：${(r && r.error) || '未知原因'}`, 'error')
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
  lines.push('【已登记】')
  for (const s of servicesRows.value) {
    const src = s.source === 'launchpad' ? '启动台' : '手填'
    const state = s.listening ? `监听中 pid=${s.pid} ${s.processName}` : '空闲'
    lines.push(`:${s.port}\t${s.name}\t[${src}]\t${state}${s.duplicated ? '\t重复登记' : ''}${s.note ? '\t' + s.note : ''}`)
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
  if (typeof t.clipboardWriteText !== 'function') { showToast('当前主进程是旧版本，没有剪贴板通道', 'error'); return }
  try {
    await t.clipboardWriteText(servicesSnapshotText())
    showToast('服务快照已复制到剪贴板', 'success')
  } catch (e: any) {
    showToast(`复制失败：${e?.message || e}`, 'error')
  }
}

/** 把「空闲」的启动台应用现场拉起来（主进程只认启动台里带 port 的应用，绝不杀进程） */
async function startServiceRow(s: ServiceRowUi): Promise<void> {
  const t: any = window.tegula
  if (typeof t.servicesStart !== 'function') { showToast('当前主进程是旧版本，没有启动通道', 'error'); return }
  const r: any = await t.servicesStart(s.port)
  showToast((r && r.message) || '已发出启动请求', r && r.ok ? 'success' : 'error')
  if (r && r.ok) setTimeout(() => loadServices(), 2000)
}

async function openSkillsDir(which: string): Promise<void> {
  const r: any = await window.tegula.skillsOpenDir(which)
  if (r && r.ok) showToast(`已打开 ${r.dir || ''}`, 'success')
  else showToast(`打开失败：${(r && r.error) || '未知原因'}`, 'error')
}

async function loadAll() {
  const [t, p, b, dd] = await Promise.all([
    window.tegula.loadTasks(curView.value),
    window.tegula.loadProjects(),
    window.tegula.findBlockers(),
    window.tegula.getDataDir(),
  ])
  tasks.value = t
  countView.value = curView.value   // 顶栏计数只对「本次加载的视图」负责（用户第 12 条）
  projects.value = p
  blockers.value = b
  dataDir.value = dd
  // also load progress for task preview
  await loadProjectProgressMap()
  if (searchIncludeArchive.value) {
    try {
      const arch = await window.tegula.loadTasks('archive')
      archivedTasks.value = arch.map((a: Task) => ({ ...a, _archived: true }))
    } catch { archivedTasks.value = [] }
  } else {
    archivedTasks.value = []
  }
  // 解析失败的文件必须显性可见 —— 静默跳过才是任务"人间蒸发"的根因
  try {
    parseErrors.value = await window.tegula.parseErrors()
  } catch {
    parseErrors.value = []
  }
}

function showParseErrors() {
  alert(
    `以下任务文件无法解析，已从看板中跳过：\n\n${parseErrors.value.join('\n')}\n\n` +
    `常见原因：标题含 ": "（如 "fix: xxx"）、字段值以 [ 或 # 开头、字段值含换行。\n` +
    `修复：python scripts/fix-bad-frontmatter.py（先跑预演，确认后加 --apply）`
  )
}


function batchSetStatus(status: string) {
  if (selectedBatch.value.length === 0) return
  executeBatchStatus(status)
}

async function executeBatchStatus(status: string) {
  const ids = [...selectedBatch.value]
  const result = await window.tegula.batchEdit(ids, { status })
  if (result.fails.length === 0) {
    showToast(`已将 ${result.ok} 个任务设为「${status}」`, 'success')
  } else {
    showToast(`${result.ok} 成功，${result.fails.length} 失败`, 'error')
  }
  selectedBatch.value = []
  batchMode.value = false
  naturalResults.value = []
  isNaturalQuery.value = false
  loadAll()
}

async function executeBatchArchive() {
  const ids = [...selectedBatch.value]
  if (ids.length === 0) return
  if (!confirm(`批量归档 ${ids.length} 个任务？`)) return
  const result = await window.tegula.batchArchive(ids)
  if (result.fails.length === 0) {
    showToast(`已归档 ${result.ok} 个任务`, 'success')
  } else {
    showToast(`${result.ok} 成功，${result.fails.length} 失败`, 'error')
  }
  selectedBatch.value = []
  batchMode.value = false
  loadAll()
}

async function executeBatchDelete() {
  const ids = [...selectedBatch.value]
  if (ids.length === 0) return
  if (!confirm(`批量删除 ${ids.length} 个任务？此操作不可恢复。`)) return
  const result = await window.tegula.batchDelete(ids)
  if (result.fails.length === 0) {
    showToast(`已删除 ${result.ok} 个任务`, 'success')
  } else {
    showToast(`${result.ok} 成功，${result.fails.length} 失败`, 'error')
  }
  selectedBatch.value = []
  batchMode.value = false
  loadAll()
}

// ── Natural Query ─────────────────────────────────────────────────────

async function executeNaturalQuery() {
  const q = searchQuery.value.trim()
  if (!q) {
    isNaturalQuery.value = false
    naturalResults.value = []
    return
  }
  // 把「含归档」开关传下去 —— 此前自然查询在主进程硬跳过 archive，勾了也搜不到
  const result = await window.tegula.naturalQuery(q, { includeArchive: searchIncludeArchive.value })
  if (result.error) {
    showToast(result.error, 'error')
    return
  }
  naturalResults.value = result.tasks
  isNaturalQuery.value = true
}

// ── Task operations ─────────────────────────────────────────────────────

function emptyTaskForm(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const spec of taskFieldSpecs.value) {
    out[spec.key] = spec.key === 'status' ? '待办' : spec.key === 'priority' ? '中' : ''
  }
  return out
}

/** spec 的选项：静态 options，或运行时从 projects 生成 */
function specOptions(spec: any): Array<{ value: string; label: string }> {
  if (spec.optionsFrom === 'projects') {
    return [
      { value: '', label: '未归属' },
      ...projects.value.map((p: any) => ({ value: p.id, label: p.name || p.id })),
    ]
  }
  return (spec.options || []).map((o: string) => ({ value: o, label: o }))
}

function openNew() {
  editTask_.value = emptyTaskForm()
  taskEditSnap = snapOf(editTask_.value)   // P0-1：关窗按「改没改」判
}

async function openEdit(t: Task) {
  // 表单值统一从主进程取：字段清单在主进程，前端不重复维护字段映射
  let values: Record<string, string>
  try {
    values = await window.tegula.taskFormValues(t.id)
  } catch {
    values = emptyTaskForm()
  }
  editTask_.value = { ...values, id: t.id }
  taskEditSnap = snapOf(editTask_.value)   // P0-1：打开即存快照，否则一动不动也会被追问
  previewTask.value = null
}

/**
 * 表单里是否有内容需要挽留 —— **只作兜底**（没有快照时的老逻辑）。
 * 2026-10-01 P0-1：它判的是「字段里有没有字」，两头都错，正式口径已改成快照比对。
 */
function isDirtyFields(o: any, keys: string[]): boolean {
  return !!o && keys.some(k => String(o[k] ?? '').trim())
}

/**
 * 编辑器表单快照（2026-10-01 P0-1）。
 *
 * 旧的 `isDirtyFields` 判「字段里有没有字」，导致两头都错：
 *   ① 编辑已有日志 → title/content 天然非空 → 一动不动也弹「尚未保存」
 *      （确认疲劳 → 用户学会无脑回车，真丢数据时同样一笔带过）；
 *   ② 新建日志只改项目 / 执行 Agent 下拉 → 三键全空 → **静默关闭**，改动直接丢。
 * 正确口径 = 打开时存快照、关闭时逐字节比对 —— 与接力对话框的 `_init` 快照
 * （relayChanges，开发日志 2026-09-30 卡 006）是同一范式，不另发明。
 */
let taskEditSnap: string | null = null
let logEditSnap: string | null = null
const snapOf = (o: any): string => JSON.stringify(o ?? null)

/** 日志编辑器快照：表单本体 + 完成/归档对话框里的「保留天数/备注/批量」
 *  （只填备注不改表单，老逻辑同样会丢 —— 一并纳入比对）。 */
const logSnapNow = (): string => JSON.stringify({
  form: snapOf(logEdit_.value),
  note: String(logNote.value ?? ''),
  retain: String(logRetainDays.value ?? ''),
  batch: !!logBatchMode.value,
})

function taskEditDirty(): boolean {
  if (taskEditSnap !== null) return snapOf(editTask_.value) !== taskEditSnap
  return isDirtyFields(editTask_.value, ['title', 'blockers', 'memo', 'body', 'tags'])
}

function logEditDirty(): boolean {
  if (logEditSnap !== null) return logSnapNow() !== logEditSnap
  return isDirtyFields(logEdit_.value, ['title', 'content', 'nextSteps'])
}

/** 关闭任务编辑器：**改过**才问（遮罩点击 @click.self 也走这里）。 */
function closeTaskEditor() {
  if (taskEditDirty() && !confirm('编辑内容尚未保存，确定关闭并丢弃吗？')) return
  editTask_.value = null
  taskEditSnap = null
}

/** 关闭日志编辑器（2026-10-03 卡 task-20261003-005）：与接力**同一套**防丢 ——
 *  对话框内警告条，不再原生 window.confirm（用户点名「创建日志和日志接力两种实现」，统一）。
 *  交互与 closeRelay 同构：第一次点取消/遮罩出条不关（滚进视野+焦点落「继续填写」+warn 留痕）；
 *  条子出着时再点仍不关；唯一丢弃入口 = 条上的「丢弃并关闭」。 */
const logDiscard_ = ref(false)
const logDiscardBar = ref<HTMLElement | null>(null)
function closeLogEditor(): void {
  if (logEditDirty()) {
    if (!logDiscard_.value) {
      logDiscard_.value = true
      nextTick(() => {
        const bar = logDiscardBar.value
        if (!bar) return
        try { bar.scrollIntoView({ block: 'nearest' }) } catch { /* 老 Chromium：不支持 options */ }
        const keep = bar.querySelector('button') as HTMLButtonElement | null
        keep?.focus()
      })
      console.warn(`[logEdit] 关闭被拦下：未保存的改动（${logDirtyNames().join('、') || '表单改动'}），等用户选择丢弃或继续填写`)
    }
    return
  }
  closeLogNow()
}

/** 真正关窗：保存成功 / 销毁 / 丢弃确认共用这一条出清路径（防条子与快照残留到下次打开） */
function closeLogNow(): void {
  logEdit_.value = null
  logCompleting.value = false
  logArchiveMode.value = false
  logEditSnap = null
  logSnapFields = null
  logDiscard_.value = false
}

/** 条上的「丢弃并关闭」——唯一丢弃入口 */
function discardLogEdit(): void {
  console.warn(`[logEdit] 用户确认丢弃未保存的日志改动（${logDirtyNames().join('、') || '无'}）`)
  closeLogNow()
}

/** 结构化快照：字符串快照（logSnapNow）负责判脏，结构化快照负责在条子里点名改了什么 */
let logSnapFields: Record<string, string> | null = null
function markLogSnap(): void {
  logEditSnap = logSnapNow()
  const f = logEdit_.value
  logSnapFields = f ? {
    title: String(f.title ?? ''),
    content: String(f.content ?? ''),
    nextSteps: String(f.nextSteps ?? ''),
    project: String(f.project ?? ''),
    taskIds: normalizeLogTaskIds(f).join(','),
    sessionId: String(f.sessionId ?? ''),
    agentName: String(f.agentName ?? ''),
    prevAgentName: String(f.prevAgentName ?? ''),
    logDate: String(f.logDate ?? ''),
    note: String(logNote.value ?? ''),
    retain: String(logRetainDays.value ?? ''),
  } : null
}

const LOG_FIELD_LABELS: Record<string, string> = {
  title: '标题', content: '执行内容', nextSteps: '下一步', project: '项目', taskIds: '关联任务',
  sessionId: '会话 ID', agentName: '执行 Agent', prevAgentName: '上次执行 Agent',
  logDate: '日志日期', note: '备注', retain: '保留天数',
}

/** 相对打开时的快照逐字段点名（与接力 relayChanges 同构，不另发明） */
function logDirtyNames(): string[] {
  const f = logEdit_.value
  const s = logSnapFields
  if (!f || !s) return []
  const now: Record<string, string> = {
    title: String(f.title ?? ''),
    content: String(f.content ?? ''),
    nextSteps: String(f.nextSteps ?? ''),
    project: String(f.project ?? ''),
    taskIds: normalizeLogTaskIds(f).join(','),
    sessionId: String(f.sessionId ?? ''),
    agentName: String(f.agentName ?? ''),
    prevAgentName: String(f.prevAgentName ?? ''),
    logDate: String(f.logDate ?? ''),
    note: String(logNote.value ?? ''),
    retain: String(logRetainDays.value ?? ''),
  }
  return Object.keys(s).filter(k => now[k] !== s[k]).map(k => LOG_FIELD_LABELS[k] || k)
}

/**
 * 关闭防丢统一口径（2026-10-03 卡 task-20261003-004·族1收敛）：
 * 打开存快照、关闭逐字节比对、**改过才问**。
 * 收编的旧实现：方针卡/项目/应用曾走 hasAnyText（「有字就弹」= 确认疲劳，只改下拉/勾选
 * 则静默丢——P0-1 判错一直没迁移）；待办此前零防护（closeTodoEditor 裸置 null）。
 * 任务/日志编辑器已是同口径（taskEditSnap/logSnapNow，注释明写「不另发明」）——
 * 本函数是该口径的可复用形态：新增编辑类弹窗一律 makeDirtyGuard，禁止再长第二种。
 */
function makeDirtyGuard() {
  let snap: string | null = null
  // 用 const 箭头而非对象方法简写：check-template-bindings 把 `open(v){…}` 这种
  // 简写定义当「调用了未定义的 open()」（collectCalled 只认 function/const 声明）。
  const open = (v: any): void => { snap = snapOf(v) }
  const dirty = (v: any): boolean => snap !== null && snapOf(v) !== snap
  const clear = (): void => { snap = null }
  return { open, dirty, clear }
}
const policyGuard = makeDirtyGuard()
const projGuard = makeDirtyGuard()
const appGuard = makeDirtyGuard()
const todoGuard = makeDirtyGuard()

function closePolicyEditor() {
  if (policyGuard.dirty(policyEdit_.value) && !confirm('方针卡尚未保存，确定关闭并丢弃吗？')) return
  policyEdit_.value = null
  policyGuard.clear()
}

function closeProjForm() {
  if (projGuard.dirty(projForm.value) && !confirm('项目信息尚未保存，确定关闭并丢弃吗？')) return
  projForm.value = null
  projGuard.clear()
}

function closeAppEditor() {
  if (appGuard.dirty(editApp_.value) && !confirm('应用信息尚未保存，确定关闭并丢弃吗？')) return
  editApp_.value = null
  appGuard.clear()
}

// ── 阻塞字段的选择器 ────────────────────────────────────────────────────
// 表单里 blockers 存的是逗号分隔字符串（见 data/index.ts 的 taskToFormValues），
// 这里给出「id 数组」视图与候选列表 —— 用户不该被要求手打任务 ID。

/** 已选依赖（id 数组视图） */
const blockerList = computed<string[]>(() => {
  const raw = String(editTask_.value?.blockers ?? '')
  return raw.split(',').map(s => s.trim()).filter(Boolean)
})

/** 候选任务：跟随表单里所选的项目，排除自己与已选中的 */
const blockerCandidates = computed<any[]>(() => {
  const e = editTask_.value
  if (!e) return []
  const proj = String(e.project ?? '').trim()
  const chosen = new Set(blockerList.value)
  return tasks.value
    .filter((t: any) => t.id !== e.id && !chosen.has(t.id))
    .filter((t: any) => {
      if (!proj) return true
      const p = t.project
      return Array.isArray(p) ? p.includes(proj) : p === proj
    })
    .slice(0, 300)
})

function taskTitleById(id: string): string {
  const t = tasks.value.find((x: any) => x.id === id) as any
  return t ? (t.title || id) : `${id}（不在当前视图）`
}

function setBlockers(ids: string[]) {
  if (editTask_.value) editTask_.value.blockers = ids.join(', ')
}

function onBlockerPick(e: Event) {
  const el = e.target as HTMLSelectElement
  if (!el.value) return
  setBlockers([...blockerList.value, el.value])
  el.value = ''
}

function removeBlocker(id: string) {
  setBlockers(blockerList.value.filter(x => x !== id))
}

async function saveEdit() {
  const e = editTask_.value
  if (!e) return
  if (!String(e.title || '').trim()) {
    showToast('标题不能为空', 'error')
    return
  }

  const patch: any = {}
  for (const spec of taskFieldSpecs.value) {
    if (spec.key === 'body') continue
    const raw = String(e[spec.key] ?? '').trim()
    if (spec.type === 'tags' || spec.type === 'list') {
      patch[spec.key] = raw ? raw.split(',').map((s: string) => s.trim()).filter(Boolean) : []
    } else {
      patch[spec.key] = raw
    }
  }
  const payload = { ...patch, body: e.body ?? '' }

  try {
    if (e.id) {
      await window.tegula.editTask(e.id, payload)
    } else {
      await window.tegula.newTask(payload)
    }
  } catch (err: any) {
    showToast('保存失败：' + (err?.message || '未知错误'), 'error')
    return
  }
  editTask_.value = null
  showToast(e.id ? '已更新' : '已创建', 'success')
  loadAll()
}

async function deleteTask(id: string) {
  if (!confirm('确定删除此任务？\n会移入 task-data/.trash，可人工找回。')) return
  // 主进程这次可能抛异常（历史上：目标同名文件已存在于 .trash → renameSync 抛 →
  // 这里没有 try/catch → 按钮点了完全没反应，用户 2026-09-25 第 5 条）。
  // 任何失败都必须变成看得见的一句话 + 日志留痕。
  try {
    const result = await window.tegula.deleteTask(id)
    if (result) {
      previewTask.value = null
      showToast('已删除', 'success')
      loadAll()
    } else {
      const msg = `删除失败：任务不存在（${id}）`
      showToast(msg, 'error')
      appErrors.value.push({ scope: 'deleteTask', message: msg, at: Date.now() })
    }
  } catch (e: any) {
    const msg = `删除「${id}」失败：${e?.message || e}`
    showToast(msg, 'error')
    appErrors.value.push({ scope: 'deleteTask', message: msg, at: Date.now() })
  }
}

async function archiveTask(t: Task) {
  if (!confirm(`确认归档「${t.title}」？\n归档后任务将进入归档视图，此操作不可自动逆转。`)) return
  const result = await window.tegula.archiveTask(t.id)
  if (result.ok) {
    previewTask.value = null
    showToast('已归档', 'success')
    loadAll()
  } else {
    showToast(`归档失败: ${result.error || '未知错误'}`, 'error')
  }
}

/** 非终态直达完成/驳回：挂死任务（如超时未回写）没有验收方可走，必须给终结入口 */
async function forceCloseTask(t: Task, status: '完成' | '驳回') {
  const word = status === '完成' ? '标记完成' : '驳回'
  if (!confirm(`确认将「${t.title}」直接${word}？\n此操作跳过验收流程（适用于挂死/废弃任务），留痕于结果记录。`)) return
  const result = await window.tegula.moveStatus(t.id, status)
  if (result.ok) {
    previewTask.value = null
    showToast(`已${word}`, 'success')
    loadAll()
  } else {
    showToast(`${word}失败: ${result.error || '未知错误'}`, 'error')
  }
}

async function restoreTask(t: Task) {
  if (!confirm(`确认还原「${t.title}」？\n任务将回到「待办」状态；若已归档，会一并移回活跃区。`)) return
  const result = await window.tegula.unarchiveTask(t.id)
  if (result.ok) {
    previewTask.value = null
    showToast('已还原', 'success')
    loadAll()
  } else {
    showToast(`还原失败: ${result.error || '未知错误'}`, 'error')
  }
}

function onBodyChange(e: Event) {
  const target = e.target as HTMLInputElement
  if (target.tagName === 'INPUT' && target.type === 'checkbox') {
    toggleCheck(target)
  }
}

function toggleCheck(el: HTMLInputElement) {
  const li = el.closest('li')
  if (!li || !previewTask.value) return
  const body = previewTask.value.body || ''
  // CRLF defense: strip trailing CR from each line before matching
  const lines = body.split('\n').map(l => l.replace(/\r$/, ''))
  const liText = (li.textContent || '').replace(/^\s+|\s+$/g, '').replace(/^-\s*\[[ x]\]\s*/, '')
  const lineIdx = lines.findIndex(l => {
    const m = l.match(/^- \[[ x]\]s*(.*)$/)
    return m && m[1].trim() === liText.trim()
  })
  if (lineIdx === -1) return
  const checked = el.checked
  lines[lineIdx] = `- [${checked ? 'x' : ' '}] ${liText}`
  const newBody = lines.join('\n')
  previewTask.value = { ...previewTask.value, body: newBody }
  // 勾选即时反馈：同步看板列表里的同一任务，不等 500ms debounce 落盘
  const idx = tasks.value.findIndex(t => t.id === previewTask.value!.id)
  if (idx !== -1) tasks.value[idx] = { ...tasks.value[idx], body: newBody }
  saveCheckChange(previewTask.value.id, newBody)
}

const _checkSaveTimers: Record<string, number> = {}
/** 待落盘的勾选内容：即使定时器被清掉，这里仍保有最新 body */
const _pendingCheckSaves: Record<string, string> = {}
const taskLogs = ref<any[]>([])

/** 反向索引：该任务的关联日志（含已完成 / 已归档） */
async function loadLogsForTask(taskId: string) {
  if (!taskId) {
    taskLogs.value = []
    return
  }
  try {
    taskLogs.value = await window.tegula.logsForTask(taskId)
  } catch {
    taskLogs.value = []
  }
}

/** 一键完成日志：不走「填保留天数」模态，按设置里的默认保留天数完成（2026-09-29 用户第 6 条） */
async function quickCompleteLog(log: any) {
  const days = logRetainDefault.value
  try {
    const r = await window.tegula.logsComplete(log.id, days, '')
    if (r && !r.ok) {
      showToast(`完成失败：${r.error || '未知原因'}`, 'error')
      return
    }
    showToast(days > 0 ? `日志已完成（保留 ${days} 天，可在设置里改）` : '日志已完成（永不清理）', 'success')
    await loadLogs()
  } catch (e: any) {
    const msg = e?.message || e
    showToast('完成失败：' + msg, 'error')
  }
}






async function persistCheckBody(id: string, body: string): Promise<boolean> {
  try {
    await window.tegula.editTask(id, { body })
  } catch (e: any) {
    showToast('勾选保存失败：' + (e?.message || '未知错误'), 'error')
    return false
  }
  // 所有勾选框都已勾选 → 自动标记完成
  const hasCheckbox = /^- \[[ x]\]/gm.test(body)
  const hasUnchecked = /^- \[ \]/gm.test(body)
  if (hasCheckbox && !hasUnchecked) {
    try {
      await window.tegula.moveStatus(id, '完成')
    } catch {
      // 状态推进失败不应吞掉正文已保存的事实
    }
  }
  return true
}

function saveCheckChange(id: string, body: string) {
  const prev = _checkSaveTimers[id]
  if (prev) clearTimeout(prev)
  _pendingCheckSaves[id] = body
  _checkSaveTimers[id] = window.setTimeout(() => { void flushCheckSaves(id) }, 500)
}

/**
 * 立即落盘待保存的勾选（省略 id 则全部）。
 * 关闭详情面板、切换任务、应用退出前都会调用 —— 旧实现只在 500ms 定时器里保存，
 * 用户勾完立刻关面板就会丢。
 */
async function flushCheckSaves(id?: string): Promise<boolean> {
  const ids = id ? [id] : Object.keys(_pendingCheckSaves)
  let wrote = false
  for (const tid of ids) {
    const body = _pendingCheckSaves[tid]
    if (body === undefined) continue
    const timer = _checkSaveTimers[tid]
    if (timer) { clearTimeout(timer); delete _checkSaveTimers[tid] }
    delete _pendingCheckSaves[tid]
    if (await persistCheckBody(tid, body)) wrote = true
  }
  return wrote
}

// 面板关闭或切换任务时自动 flush 上一个任务 —— 比逐个改调用点可靠
watch(
  () => previewTask.value?.id ?? null,
  async (nextId: string | null, prevId: string | null) => {
    if (prevId && prevId !== nextId && _pendingCheckSaves[prevId] !== undefined) {
      const wrote = await flushCheckSaves(prevId)
      if (wrote) loadAll()
    }
  }
)

// 关窗前尽力落盘（此时无法 await，但已发出的 IPC 通常能写完）
window.addEventListener('beforeunload', () => { void flushCheckSaves() })

function renderBody(body: string): string {
  if (!body) return ''
  let html = marked.parse(body, { breaks: true, gfm: true }) as string
  // Sanitize HTML to prevent XSS — allow <input> for checkboxes, data-check attr
  html = DOMPurify.sanitize(html, {
    ADD_TAGS: ['input'],
    ADD_ATTR: ['data-check'],
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr',
      'ul', 'ol', 'li',
      'strong', 'em', 'b', 'i',
      'code', 'pre',
      'blockquote',
      'a', 'img',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'input', 'del'
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'type', 'checked', 'disabled', 'data-check']
  })
  // Make checkboxes interactive (replace marked's disabled inputs with clickable ones)
  html = html.replace(
    /<input[^>]*disabled[^>]*type="checkbox"[^>]*>/g,
    (match) => {
      const isChecked = /checked/.test(match)
      return `<input type="checkbox" data-check="${isChecked ? 'checked' : 'unchecked'}" ${isChecked ? 'checked' : ''}>`
    }
  )
  // Add check-item class to li elements containing checkboxes
  html = html.replace(/<li>(<input type="checkbox")/g, '<li class="check-item">$1')
  return html
}

const archivedTasks = ref<Task[]>([])


/**
 * 展示层优先级兜底归一。主进程 parseTask 已做过归一，这里只防历史数据里的英文残留。
 * 不要在别处再写一套映射 —— 优先级别名表在主进程 data/index.ts。
 */
function localPriority(p: any): string {
  const s = String(p ?? '').trim()
  if (!s) return '中'
  const map: Record<string, string> = {
    '高': '高', '中': '中', '低': '低',
    high: '高', urgent: '高', critical: '高',
    medium: '中', normal: '中',
    low: '低',
  }
  return map[s.toLowerCase()] || s
}

function priorityLabel(p: string): string {
  return p ? localPriority(p) : '—'
}

/** 详情面板里的时间展示：有开始+截止就是一个时间段（2026-09-22，用户第 6 条） */
function previewTimeLabel(t: any): string {
  return rangeLabel(t?.start ?? t?.fm?.start, t?.deadline ?? t?.fm?.deadline)
}
const filteredTasks = computed(() => {
  if (isNaturalQuery.value && naturalResults.value.length > 0) {
    return naturalResults.value
  }
  let result = [...tasks.value]
  // 「含归档」只服务于活跃视图与搜索：归档视图的 tasks.value 本身就是 loadTasks('archive') 的结果，
  // 再把 archivedTasks 拼进来 = 同一批任务各出现两次（用户 2026-09-25：「归档页签内是否勾选含归档
  // 会出现不同显示效果，不是应该只显示归档内容吗」）。
  if (curView.value !== 'archive' && searchIncludeArchive.value && archivedTasks.value.length > 0) {
    // 同 id 的归档副本不能再拼一次 —— archive/ 里出现与活跃区同 id 的副本时（历史遗留、手工拷贝），
    // 勾「含归档」会让同一张卡在板子上显示两遍。以活跃区为准（活跃那份才是可操作的真身）。
    const activeIds = new Set(result.map(t => t.id))
    result = [...result, ...archivedTasks.value.filter(a => !activeIds.has(a.id))]
  }
  if (curProj.value !== '__all__') {
    result = result.filter(t => normProject(t.project) === curProj.value)
  }
  if (searchQuery.value) {
    const q = searchQuery.value
    // Auto-detect natural query syntax (#tag @project)
    if (q.includes('#') || q.includes('@')) {
      const nq = naturalResults.value
      if (isNaturalQuery.value && nq.length > 0) {
        const nqIds = new Set(nq.map(t => t.id))
        result = result.filter(t => nqIds.has(t.id))
        return result
      }
    }
    const lq = q.toLowerCase()
    result = result.filter(t =>
      t.title?.toLowerCase().includes(lq) ||
      t.id?.toLowerCase().includes(lq) ||
      normProject(t.project).toLowerCase().includes(lq) ||
      t.tags?.join(' ').toLowerCase().includes(lq)
    )
  }
  if (dueFilter.value) {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    // 日期算术统一走 calendar.ts（addDays 用本地日历日构造，天然免疫 DST/时区偏移）
    const weekLater = addDays(today, 7)
    result = result.filter(t => {
      const due = (t as any).deadline || t.fm.deadline
      if (!due) return false
      const dueDate = new Date(due)
      if (isNaN(dueDate.getTime())) return false
      if (dueFilter.value === 'overdue') return dueDate < today && t.status !== '完成' && t.status !== '驳回'
      if (dueFilter.value === 'today') return dueDate >= today && dueDate < addDays(today, 1)
      if (dueFilter.value === 'week') return dueDate >= today && dueDate <= weekLater
      return true
    })
  }
  return applySortMode(result)
})

/**
 * 顶栏「活跃优先 / 最近更新 / 创建时间」排序 —— 2026-09-29 修。
 *
 * 真因：`sortMode` 此前**只在模板里绑了 v-model，全代码零引用** ——
 * 下拉换了没有任何反应，是典型的"看起来能点、实际什么都不会发生"的死控件
 * （和 check-template-bindings 专抓的那类僵尸是同一族，只不过死的是 ref 不是函数）。
 *
 * ⚠ 时间必须过 `parseTime()`：数据里同时存在 ISO（桌面版写）与**秒级 Unix 数字**
 * （Python 版写），直接字符串比较会让"1790578721"整段排在"2026-09-28T…"前面。
 * 解析不出来的排最后（NaN 不参与比较，避免顺序随机跳）。
 */
function applySortMode(list: Task[]): Task[] {
  const mode = sortMode.value
  if (mode === 'prio') {
    // 2026-10-01 用户第 2 条：优先级排法。localPriority 把 high/critical/高 归一成同一个刻度；
    // 同优先级**保持原序**（V8 sort 稳定），不擅自二次排序 —— 排完仍是"活跃优先"那套底序。
    const rank = (t: any) => {
      const p = localPriority(t?.priority ?? (t as any)?.fm?.priority)
      return p === '高' ? 0 : p === '低' ? 2 : 1
    }
    return [...list].sort((a, b) => rank(a) - rank(b))
  }
  if (mode !== 'updated' && mode !== 'created') return list // 'active' = 后端给的活跃优先序，不动
  const key = (t: any) => parseTime(t?.[mode] ?? t?.fm?.[mode])
  return [...list].sort((a, b) => {
    const ta = key(a)
    const kb = key(b)
    const na = Number.isFinite(ta)
    const nb = Number.isFinite(kb)
    if (!na && !nb) return 0
    if (!na) return 1
    if (!nb) return -1
    return kb - ta
  })
}

function openCard(t: Task) {
  previewTask.value = t
  loadLogsForTask(t.id)
}

/** 复制文本并给出**真实**结果提示（三层兜底见 shared/clipboard.ts）。
 *  为什么要有它：以前只挂 try/catch + 成功 toast，navigator.clipboard 静默 reject 时
 *  用户看到「已复制」但粘出来是旧内容（2026-09-25 报修）。 */
async function copyWithToast(text: unknown, okMsg: string): Promise<boolean> {
  const r = await copyText(text)
  // 用 warn 而非 log：主进程只转发 level>=2 的渲染层 console（见 src/index.ts console-message）
  console.warn('[renderer:copy] via=' + r.via + ' ok=' + r.ok + (r.error ? ' err=' + r.error : ''))
  if (r.ok) showToast(okMsg, 'success')
  else showToast('复制失败：' + (r.error || '未知原因'), 'error')
  return r.ok
}

async function copyId(id: string) {
  await copyWithToast(id, '已复制 ID')
}

/**
 * 打开任务的 markdown 文件（资源管理器定位）。
 * 后端 `openFile` 通道一直都在（主进程还带路径白名单校验），只是没有入口 —— 同 openReview 那一类。
 */
async function openTaskFile(t: any): Promise<void> {
  const p = t?.path
  if (!p) {
    showToast('拿不到这个任务的文件路径', 'error')
    return
  }
  try {
    const r: any = await window.tegula.openFile(p)
    if (r && r.ok === false) showToast('打开失败：' + (r.error || ''), 'error')
  } catch (e: any) {
    showToast('打开失败：' + (e?.message || e), 'error')
  }
}

// ── 任务卡右键菜单 ─────────────────────────────────────────────────────
// 用户反馈「方寸内右键没什么用」。这里放卡片上的高频操作，
// 省得每次都先点开详情面板再翻按钮。
const ctxMenu = ref<{ x: number; y: number; task: Task } | null>(null)

function openCardMenu(e: MouseEvent, t: Task) {
  ctxMenu.value = { x: e.clientX, y: e.clientY, task: t }
}

function closeCardMenu() {
  ctxMenu.value = null
}

/** 执行菜单动作并收起菜单（先收菜单，免得挡住随后的确认框） */
function ctxRun(fn: (t: Task) => void) {
  const t = ctxMenu.value?.task
  closeCardMenu()
  if (t) fn(t)
}

async function copyTaskId(t: Task) {
  await copyWithToast(t.id, '已复制 ID：' + t.id)
}

async function copyTaskTitle(t: Task) {
  await copyWithToast(t.title || t.id, '已复制标题')
}

/**
 * 弹药库（卡 031）：把这张卡拼成一份「派工单」文本并复制。
 *
 * 三段拼接，**零智能**：卡内容原文照贴 + 六字段骨架（已知的填上、判据留空）+ 纪律段。
 * 只复制，不派发 —— 派发永远留人手。模板在 `shared/arsenal.ts`（卡片模板文本，不进 JSON）。
 */
async function copyTaskAsDispatch(t: Task): Promise<void> {
  try {
    const key = normProject((t as any).project)
    const proj: any = (projects.value as any[]).find((p) => p && p.id === key)
    const acceptance = String((t as any).fm?.验收判据 || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    const text = buildDispatchText({
      id: t.id,
      title: t.title,
      body: (t as any).body || '',
      status: t.status,
      path: (t as any).path || '',
      priority: (t as any).priority || '',
      tags: Array.isArray((t as any).tags) ? (t as any).tags : [],
      projectRoot: proj?.repo || '',
      projectName: proj?.name || key || '',
      acceptance,
    })
    // 留痕：日志里能查到「点了哪条、复制了多长」（渲染层 console 会转发进应用日志）
    const st = arsenalStatus({ status: t.status, path: (t as any).path || '' })
    console.warn('[renderer:copy] arsenal dispatch id=' + t.id + ' state=' + st + ' len=' + text.length)
    await copyWithToast(text, `已复制为派工单（弹药库状态：${st}）—— 判据那几栏留给你亲手写`)
  } catch (e: any) {
    showToast('拼派工单失败：' + (e?.message || e), 'error')
  }
}

function deleteTaskById(t: Task) {
  deleteTask(t.id)
}

async function copyTaskClick(id: string) {
  if (!confirm('复制此任务？')) return
  const result = await window.tegula.copyTask(id)
  if (result.ok) {
    showToast('已复制', 'success')
    loadAll()
  } else {
    showToast('复制失败', 'error')
  }
}

// ── Todos ─────────────────────────────────────────────────────────

// ── Policies（项目方针 / 项目章程）────────────────────────────────────
// 2026-09-25 第 7 条：登记 13 个项目里只有 1 个有方针卡 —— 用户看不到"谁缺"，也没法批量补。
// 这里区分三态：**已填**（有内容）/ **骨架**（文件在但内容空）/ **缺失**（连文件都没有）。
const policyMap = ref<Record<string, boolean>>({})
/** 文件是否存在（可能只是空骨架） */
const policyExistsMap = ref<Record<string, boolean>>({})
const policyEdit_ = ref<any>(null)

// 029：结构地图缺口（方针卡已填但没「结构地图」节）—— 与章程缺口同一机制。
const policyMapHasStructure = ref<Record<string, boolean>>({})
/** 每张卡结构地图里的「最后核实」日期（YYYY-MM-DD），没写就是空串 */
const policyVerifiedMap = ref<Record<string, string>>({})

const charterStats = computed(() => {
  const total = projects.value.length
  let filled = 0, skeleton = 0, missing = 0, mapMissing = 0, mapReady = 0
  for (const p of projects.value) {
    if (policyMap.value[p.id]) filled++
    else if (policyExistsMap.value[p.id]) skeleton++
    else missing++
    // 空骨架必然也没有结构地图（同一个缺口），所以只对「已填」的项目算地图缺口
    if (policyMap.value[p.id] && !policyMapHasStructure.value[p.id]) mapMissing++
    if (policyMap.value[p.id] && policyMapHasStructure.value[p.id]) mapReady++
  }
  return { total, filled, skeleton, missing, mapMissing, mapReady }
})

/** 从结构地图正文里抠出「最后核实：YYYY-MM-DD」 */
function extractVerified(text: string): string {
  const m = /最后核实[：:]\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(String(text || ''))
  return m ? m[1] : ''
}

async function loadPolicyMap() {
  const filled: Record<string, boolean> = {}
  const exists: Record<string, boolean> = {}
  const hasMap: Record<string, boolean> = {}
  const verified: Record<string, string> = {}
  for (const p of projects.value) {
    try {
      const r: any = await window.tegula.policyGet(p.id)
      const pol = r && r.policy ? r.policy : null
      exists[p.id] = !!pol
      filled[p.id] = !!(pol && (pol.mission || pol.goal || pol.scenario || pol.boundary))
      const mapText = String((pol && pol.structureMap) || '')
      // 只有**真填过**才算有：骨架里那行「（待填 —— …）」不算内容
      hasMap[p.id] = !!mapText.trim() && !/最后核实[：:]\s*（待填/.test(mapText)
      verified[p.id] = extractVerified(mapText)
    } catch { exists[p.id] = false; filled[p.id] = false; hasMap[p.id] = false; verified[p.id] = '' }
  }
  policyMap.value = filled
  policyExistsMap.value = exists
  policyMapHasStructure.value = hasMap
  policyVerifiedMap.value = verified
}

// ── 结构地图一览（029 的入口）──────────────────────────────────────────
const smapOpen = ref(false)

/** 一览行：**缺的排前面**（那才是要动的），同组按项目登记顺序 */
const smapRows = computed(() => {
  const rows = projects.value.map(p => ({
    id: p.id,
    name: p.name || p.id,
    hasPolicy: !!policyExistsMap.value[p.id],
    has: !!policyMapHasStructure.value[p.id],
    verified: policyVerifiedMap.value[p.id] || '',
  }))
  return [...rows.filter(r => !r.has), ...rows.filter(r => r.has)]
})

async function openStructMap() {
  smapOpen.value = true
  await loadPolicyMap()   // 打开前刷一次，日期不会过期
}

async function openPolicyFromSmap(projectId: string) {
  smapOpen.value = false
  await openPolicyEdit(projectId)
}

/**
 * 把「最后核实」那行改成今天（029 的核心纪律：地图必须有人签日期）。
 * 没有这一行就补在最前面 —— 手改日期最容易忘，给一个按钮。
 */
function stampStructureMap() {
  const e = policyEdit_.value
  if (!e) return
  const today = new Date()
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const line = `> 最后核实：${iso}`
  const cur = String(e.structureMap || '')
  e.structureMap = /最后核实[：:]/.test(cur)
    ? cur.replace(/^([ \t]*>[ \t]*最后核实[：:])[^\n]*/m, line)
    : (cur.trim() ? `${line}\n${cur}` : `${line}\n- 模块清单：\n- 主数据流：`)
  showToast(`已标记最后核实 ${iso}（记得点保存）`, 'success')
}

/** 一键为「连文件都没有」的项目建立章程骨架（四个小节留空，等用户填；空骨架对 agent 等同未立） */
async function fillMissingCharters() {
  const targets = projects.value.filter(p => !policyMap.value[p.id] && !policyExistsMap.value[p.id])
  if (!targets.length) { showToast('所有项目都已有章程文件了', 'info'); return }
  let done = 0
  for (const p of targets) {
    try {
      const r: any = await window.tegula.policySave({
        projectId: p.id, mission: '', goal: '', scenario: '', boundary: '',
      })
      if (r && r.ok) done++
    } catch { /* 单个失败不中断其它项目 */ }
  }
  showToast(`已为 ${done} 个项目建立章程骨架（内容待填）`, done ? 'success' : 'error')
  await loadPolicyMap()
}

async function openPolicyEdit(projectId: string) {
  const proj = projects.value.find(p => p.id === projectId)
  let mission = '', goal = '', scenario = '', boundary = '', structureMap = ''
  try {
    const r = await window.tegula.policyGet(projectId)
    // 029：结构地图一并读进来 —— 此前只读四字段，界面上**根本看不到**结构地图（用户「找不到在哪里」）
    if (r.ok && r.policy) ({ mission, goal, scenario, boundary, structureMap } = r.policy)
  } catch { /* 未立则空表单 */ }
  policyEdit_.value = { id: projectId, name: proj?.name || projectId, mission, goal, scenario, boundary, structureMap: structureMap || '' }
  policyGuard.open(policyEdit_.value)
}

async function savePolicyEdit() {
  const e = policyEdit_.value
  if (!e) return
  try {
    // 029：结构地图必须一起发 —— 不传 = 主进程沿用文件里已有的（安全），
    // 但用户在这张表单里改的内容也就丢了。所以要显式带上。
    const r = await window.tegula.policySave({ projectId: e.id, mission: e.mission, goal: e.goal, scenario: e.scenario, boundary: e.boundary, structureMap: e.structureMap })
    if (r.ok) {
      showToast('方针卡已保存', 'success')
      policyEdit_.value = null
      loadPolicyMap()
    } else {
      showToast('保存失败：' + (r.error || '未知错误'), 'error')
    }
  } catch (err: any) {
    showToast('保存失败：' + (err.message || err), 'error')
  }
}

async function copyPolicyText(projectId: string) {
  try {
    const r = await window.tegula.policyText(projectId)
    if (r.ok) {
      await copyWithToast(r.text, '方针已复制，可直接粘给 agent')
    } else {
      showToast(r.error || '复制失败', 'error')
    }
  } catch (err: any) {
    showToast('复制失败：' + (err.message || err), 'error')
  }
}

// ── Calendar view ──────────────────────────────────────────────────────
// 2026-09-21 从老版 board.html 移植；2026-09-22 重做（用户第 6 条）。原文四条抱怨：
//   ① 「连一个指派时间或时间段的按钮都没有」 —— 只能拖已排期任务改截止，没有任何指派入口
//   ② 「未能和看板上的任务或待办真正联动」   —— 旧实现只读 filteredTasks，完全不看待办
//   ③ 「貌似根本不支持跨月」                —— 非本月的任务全被丢进「未安排（…本月之外）」
//   ④ 「时间或时间段」                      —— 只有单日 deadline，没有区间概念
// 现在：start + deadline 组成时间段（跨天画成连续色带）；待办按 due 上日历；
//       任务卡右键 / 任务详情 / 待办项 / 未安排条目四处都有「指派时间」；
//       未安排拆成「无日期」与「其它月份（可一键跳转）」，跨月不再是一锅粥。
const CAL_DOW = ['一', '二', '三', '四', '五', '六', '日']
const calYear = ref(new Date().getFullYear())
const calMonth = ref(new Date().getMonth())
const calDragOverDay = ref<number | null>(null)
const calShowTodos = ref(localStorage.getItem('fc_cal_show_todos') !== '0')
const calShowLogs = ref(localStorage.getItem('fc_cal_show_logs') !== '0')
let calDragId: string | null = null
let calDragKind: 'task' | 'todo' = 'task'

// ── 格子内事件折叠（2026-09-29 用户选「改法 A」）──────────────────────────
// 035 卡的原话是「看起来很密集很让人畏惧」。底部那排横条墙上一轮已收成一行摘要，
// 剩下的密在**格子内部**：某天挂 5 条，格子里就是 5 根横条在抢同一份注意力。
// 口径：最多 2 条 + 「+N 条」，点它**就地展开**（不跳页、不弹窗），再点收起。
// ⚠ 跨天的时间段任务（span !== 'only'）不参与折叠 —— 折了会把连续色带切成断头。
const CAL_CELL_LIMIT = 2
const calExpandedDays = ref<string[]>([])
const calCellKey = (cell: any): string => `${calYear.value}-${calMonth.value}-${cell.day}`
function calCellExpanded(cell: any): boolean {
  return !!cell && calExpandedDays.value.includes(calCellKey(cell))
}
function calCellShown(cell: any): any[] {
  if (!cell) return []
  if (calCellExpanded(cell)) return cell.events
  const out: any[] = []
  let n = 0
  for (const ev of cell.events) {
    if (ev.span !== 'only') { out.push(ev); continue }
    if (n < CAL_CELL_LIMIT) { out.push(ev); n++ }
  }
  return out
}
function calCellMore(cell: any): number {
  return cell ? cell.events.length - calCellShown(cell).length : 0
}
function toggleCalCell(cell: any): void {
  const k = calCellKey(cell)
  calExpandedDays.value = calCellExpanded(cell)
    ? calExpandedDays.value.filter(x => x !== k)
    : calExpandedDays.value.concat(k)
}
/** 换月时清掉展开痕迹，否则下个月的同一天号会"莫名是展开的" */
function clearCalExpanded(): void { calExpandedDays.value = [] }

const pad2 = (n: number): string => String(n).padStart(2, '0')

function calMove(delta: number) {
  let m = calMonth.value + delta
  let y = calYear.value
  if (m < 0) { m = 11; y-- } else if (m > 11) { m = 0; y++ }
  calMonth.value = m; calYear.value = y
  clearCalExpanded()
}
function calToday() {
  calYear.value = new Date().getFullYear()
  calMonth.value = new Date().getMonth()
  clearCalExpanded()
}
function calGoto(y: number, m: number) {
  calYear.value = y
  calMonth.value = m
  clearCalExpanded()
}
function calToggleTodos() {
  calShowTodos.value = !calShowTodos.value
  localStorage.setItem('fc_cal_show_todos', calShowTodos.value ? '1' : '0')
}
function calToggleLogs() {
  calShowLogs.value = !calShowLogs.value
  localStorage.setItem('fc_cal_show_logs', calShowLogs.value ? '1' : '0')
}

// 日期算术全部在 calendar.ts 里（纯函数，可被 scripts/test/e2e-calendar.cjs 直接断言）——
// 跨月边界这类错误在界面上只表现为"少一天/多一天"，肉眼抓不住，必须靠脚本。
const taskStart = (t: any): Date | null => parseCalDate(t?.start ?? t?.fm?.start)
const taskDue = (t: any): Date | null => parseCalDate(t?.deadline ?? t?.fm?.deadline)

/** 日历只关心非终态任务 */
const calActiveTasks = computed(() =>
  filteredTasks.value.filter(t => t.status !== '完成' && t.status !== '驳回'))

/** 未完成的待办（done 的不占日历） */
const calActiveTodos = computed(() => todos.value.filter(t => !t.done))

type CalEvent = CalEventT<Task, Todo>

/** 一次算清：格子 / 未安排 / 其它月份（纯函数，见 calendar.ts） */
const calMonthData = computed(() => buildMonth<Task, Todo, any>({
  year: calYear.value,
  month: calMonth.value,
  today: new Date(),
  tasks: calActiveTasks.value.map(t => ({
    ...t,
    priority: localPriority(t.priority),
    start: (t as any).start ?? t.fm?.start,
    deadline: (t as any).deadline ?? t.fm?.deadline,
  })),
  todos: calActiveTodos.value.map(td => ({ ...td, priority: localPriority(td.priority) })),
  showTodos: calShowTodos.value,
  // 2026-09-23（用户第 3 条）：日志上日历
  logs: logs.value,
  showLogs: calShowLogs.value,
}))

const calCells = computed(() => calMonthData.value.cells)
const calUnscheduled = computed(() => calMonthData.value.unscheduled as unknown as Task[])
const calOtherMonths = computed(() => calMonthData.value.otherMonths)
const calOtherTotal = computed(() => calMonthData.value.otherTotal)
// 2026-09-25（用户第 10 条）：「日历下方的横条很密集很让人畏惧」——底部两排 chip 一多
// 就是一片横条墙。默认收起，只留一行摘要，点开才铺开。
const calBottomOpen = ref(false)

function prioColor(p: any): string {
  const s = localPriority(p)
  return s === '高' ? '#c96a6a' : s === '中' ? '#d9a44a' : s === '低' ? '#7a9e6b' : '#d5d3e0'
}

// ── 指派时间（模态：开始 + 截止 / 待办只有到期日）──────────────────────
const calAssign_ = ref<{
  id: string; title: string; isTodo: boolean; start: string; end: string
} | null>(null)

function openCalAssignTask(t: any) {
  const s = taskStart(t), e = taskDue(t)
  calAssign_.value = {
    id: t.id, title: t.title || t.id, isTodo: false,
    start: s ? calISO(s) : '',
    end: e ? calISO(e) : '',
  }
}

function openCalAssignTodo(id: string) {
  const td = todos.value.find(x => x.id === id)
  if (!td) return
  const d = parseCalDate(td.due)
  calAssign_.value = {
    id: td.id, title: td.title, isTodo: true, start: '',
    end: d ? calISO(d) : '',
  }
}

function calQuickSet(days: number) {
  const a = calAssign_.value
  if (!a) return
  const target = calISO(addDays(new Date(), days))
  if (a.isTodo) { a.end = target; return }
  if (!a.start) { a.end = target } else { a.end = target; if (a.start > a.end) a.start = a.end }
}

function calClearDates() {
  const a = calAssign_.value
  if (!a) return
  a.start = ''
  a.end = ''
}

async function saveCalAssign() {
  const a = calAssign_.value
  if (!a) return
  if (a.start && a.end && a.end < a.start) {
    showToast('截止不能早于开始', 'error')
    return
  }
  try {
    if (a.isTodo) {
      const r: any = await window.tegula.todosUpdate(a.id, { due: a.end || '' })
      if (!r || r.ok === false) { showToast('指派失败：' + (r?.error || '未知原因'), 'error'); return }
      showToast(a.end ? `待办到期日已设为 ${a.end}` : '已清除待办到期日', 'success')
      await loadTodos()
    } else {
      const r: any = await window.tegula.editTask(a.id, { start: a.start, deadline: a.end })
      if (!r || r.ok === false) { showToast('指派失败：' + (r?.error || '未知原因'), 'error'); return }
      const label = a.start && a.end ? `${a.start} → ${a.end}` : (a.end || a.start || '已清除')
      showToast(`时间已设为 ${label}`, 'success')
      loadAll()
    }
    calAssign_.value = null
  } catch (e: any) {
    showToast('指派失败：' + (e?.message || e), 'error')
  }
}

// ── 拖拽改期 ───────────────────────────────────────────────────────────
function onCalDragStart(e: DragEvent, id: string, kind: 'task' | 'todo' | 'log' = 'task') {
  calDragId = id
  calDragKind = kind
  e.dataTransfer?.setData('text/plain', id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onCalEventClick(ev: CalEvent) {
  if (ev.kind === 'todo') { openCalAssignTodo(ev.id); return }
  // 2026-09-23（用户第 3 条）：日志事件点击 → 打开日志编辑框
  if (ev.kind === 'log') {
    const log = logs.value.find((l: any) => l.id === ev.id)
    if (log) openLog(log)
    return
  }
  const t = calActiveTasks.value.find(x => x.id === ev.id)
  if (t) openCard(t)
}

async function onCalDrop(e: DragEvent, cell: { day: number } | null) {
  e.preventDefault()
  calDragOverDay.value = null
  if (!cell) return
  const id = calDragId || e.dataTransfer?.getData('text/plain')
  const kind = calDragKind
  calDragId = null
  if (!id) return
  const target = calISO(new Date(calYear.value, calMonth.value, cell.day))
  try {
    if (kind === 'todo') {
      const r: any = await window.tegula.todosUpdate(id, { due: target })
      if (!r || r.ok === false) { showToast('改期失败：' + (r?.error || '未知原因'), 'error'); return }
      showToast(`待办到期日已改为 ${target}`, 'success')
      await loadTodos()
      return
    }
    // 2026-09-23（用户第 3 条）：日志拖拽改期
    if (kind === 'log') {
      const r: any = await window.tegula.logsUpdate(id, { logDate: target })
      if (r && r.ok === false) { showToast('改期失败：' + (r?.error || '未知原因'), 'error'); return }
      showToast(`日志日期已改为 ${target}`, 'success')
      await loadLogs()
      return
    }
    const t = calActiveTasks.value.find(x => x.id === id)
    const s = t ? taskStart(t) : null
    const ed = t ? taskDue(t) : null
    let patch: Record<string, string>
    let msg: string
    if (s && ed) {
      // 时间段整体平移：保持长度，把「开始」落到目标日（算术在 calendar.ts，可单测）
      const shifted = shiftRange(calISO(s), calISO(ed), target)
      patch = { start: shifted.start, deadline: shifted.end }
      msg = `时间段已移到 ${shifted.start} → ${shifted.end}`
    } else {
      patch = { deadline: target }
      msg = `截止已改为 ${target}`
    }
    const r: any = await window.tegula.editTask(id, patch)
    if (r && r.ok) {
      showToast(msg, 'success')
      loadAll()
    } else {
      showToast('改期失败：' + (r?.error || '未知原因'), 'error')
    }
  } catch (err: any) {
    showToast('改期失败：' + (err?.message || err), 'error')
  }
}

// ── 待办列表：筛选 / 排序 / 逾期 / 统计（2026-09-26 卡 033 专项整修）──────
// 本次修的四件事（都是"用起来别扭"的真因，不是零敲碎打）：
//   ① 项目筛选原来是**漏筛**（`!t.project || t.project === X`）：选了项目 X 还会显示不归属的，
//      看着就像"筛选坏了"。现在精确匹配，并单列「（不归属任何项目）」这一项。
//   ② 同一个下拉既当筛选又当"新建默认归属"，两件事挤在一个控件里 → 现在只当筛选；
//      新建归属走「＋ 新建待办」（弹窗里本来就有项目字段，且默认跟随当前筛选）。
//   ③ 排序规则不可见、也不可选 → 加排序下拉（默认 / 到期日 / 最新创建），选择持久化。
//   ④ 有到期日却不标逾期、优先级只有"高"有徽章 → 现在三档都显示，逾期单独标红并算天数。
const todoProjectFilter = ref('__all__')
const todoSort = ref<string>(readUiPref<string>('fc_todo_sort', 'default'))
watch(todoSort, v => saveUiPref('fc_todo_sort', v))

function overdueDays(t: any): number {
  const d = daysSince(t.due)
  return Number.isFinite(d) ? Math.floor(d) : 0
}
function prioClass(p: string): string {
  const v = localPriority(p)
  return v === '高' ? 'high' : v === '低' ? 'low' : 'mid'
}

const filteredTodos = computed(() => {
  let list = todos.value
  if (todoFilter.value === 'active') list = list.filter(t => !t.done)
  if (todoFilter.value === 'done') list = list.filter(t => t.done)
  if (todoProjectFilter.value === '__none__') list = list.filter(t => !t.project)
  else if (todoProjectFilter.value !== '__all__') list = list.filter(t => t.project === todoProjectFilter.value)

  const arr = list.slice()
  if (todoSort.value === 'due') {
    arr.sort((a: any, b: any) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      // 没有到期日的排最后 —— 不假装它们是"最近的"
      const ta = a.due ? Number(parseTime(a.due)) : Number.POSITIVE_INFINITY
      const tb = b.due ? Number(parseTime(b.due)) : Number.POSITIVE_INFINITY
      const va = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY
      const vb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY
      if (va !== vb) return va - vb
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    })
  } else if (todoSort.value === 'created') {
    arr.sort((a: any, b: any) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    })
  } else if (todoSort.value === 'priority') {
    // 2026-10-01 用户第 2 条：优先级单独成一种排法。localPriority 归一（high/critical → 高）
    const rank = (t: any) => {
      const p = localPriority(t?.priority)
      return p === '高' ? 0 : p === '低' ? 2 : 1
    }
    arr.sort((a: any, b: any) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      const d = rank(a) - rank(b)
      if (d) return d
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    })
  } else if (todoSort.value === 'updated') {
    arr.sort((a: any, b: any) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      const ta = new Date(a.updatedAt || a.createdAt || 0).getTime()
      const tb = new Date(b.updatedAt || b.createdAt || 0).getTime()
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0)
    })
  }
  return arr
})

const todoStats = computed(() => {
  const total = todos.value.length
  return {
    active: todos.value.filter(t => !t.done).length,
    overdue: todos.value.filter(t => isOverdue(t)).length,
    hidden: total - filteredTodos.value.length,
  }
})

/**
 * 当前筛选选中的项目 id —— 哨兵值（__all__ / __none__）一律当"没有选中项目"。
 *
 * 2026-09-26 卡 033：项目下拉原来是"筛选 + 新建默认归属"两用，而 `__none__` 这类
 * 哨兵值只要漏一处判断，就会把 '__none__' 当成项目 id 写进 todo.project（脏数据）。
 * 统一从这一个函数取，杜绝漏判。
 */
function todoProjectFilterProject(): string | undefined {
  const v = todoProjectFilter.value
  return v === '__all__' || v === '__none__' ? undefined : v
}

function clearTodoFilters(): void {
  todoFilter.value = 'all'
  todoProjectFilter.value = '__all__'
}

const todoHealthIssue = ref<any>(null)

async function loadTodos() {
  try {
    todos.value = await window.tegula.todosList()
  } catch {
    todos.value = []
  }
  // 坏文件被隔离过就要显性化 —— 否则用户只看到"待办空了"，不知道发生过什么
  try {
    const h: any = await window.tegula.todosHealth()
    todoHealthIssue.value = h && h.lastError ? h.lastError : null
  } catch {
    todoHealthIssue.value = null
  }
}

// 「+ 添加」小框已于 2026-09-29 移除（用户第 1 条）：新建只留一个入口 = openTodoCreator() 大框。

// ── 拖拽提示的稳定显示（2026-09-22，用户第 4/5 条）──────────────────────
// 症状：拖动文件时「松手导入…」提示高频闪烁、按不住。
// 两个真因，都得治：
//   ① 提示是 v-if 的**流内元素** —— 它一出现就把下方内容顶下去，
//      光标位置相对内容变了 → 触发 dragleave → 提示消失 → dragover 又出现… 自激振荡；
//   ② 把 dragover/dragleave 直接映射成 boolean，而 dragleave 在容器内
//      子元素之间切换时也会来一发。
// 处置：提示改成 position:fixed 悬浮层 + pointer-events:none（不参与布局与命中），
//       进出用 dragenter/dragleave **深度计数**，drop/dragend 统一归零。
const dragDepth = reactive<Record<'todo' | 'log' | 'global', number>>({ todo: 0, log: 0, global: 0 })

// ── 心跳兜底（2026-09-27 用户：「那个怪异遮罩挡字的问题好像一直没修」）────────
// 症状：提示偶尔**永久留在屏幕上盖住正文**。.drop-hint.global / .todo-drop-hint 是 97% 不透明
//       的整条色块（顶部居中，正压着内容第一行），一旦留下，不重新拖一次文件就再也不消失。
// 真因：可见性只看 dragenter/dragleave 的**深度计数**，而拖拽的三种收场里两种拿不到配平事件：
//   ① 按 Esc 取消；② 松手在窗口外 / 拖出窗口 —— 这两种**都不会有 drop**；
//   而 OS 级文件拖拽的 dragend 只发给拖动**源**（资源管理器），页面永远收不到 ——
//   所以下面 onMounted 里那两个 window 'dragend'/'drop' 监听对文件拖拽形同虚设。
//   且计数泄漏后没有任何东西会把它拉回去 ⇒ 遮罩常驻。
// 处置：计数继续负责「精确进出」，另加一条**心跳**：任何拖拽事件都刷新时间戳，
//   静默超过 DRAG_IDLE_MS 就整体归零（真拖拽时 dragover 每 ~350ms 必来一次，不会误杀）。
const DRAG_IDLE_MS = 700
/** 拖拽是不是**真的还在进行**：待办/日志/全局/技能四类提示一律以它为准 */
const dragAlive = ref(false)
let dragLastAt = 0
let dragTimer: ReturnType<typeof setTimeout> | null = null

function dragPulse(): void {
  dragLastAt = Date.now()
  dragAlive.value = true
  if (!dragTimer) dragTimer = setTimeout(dragIdleCheck, 250)
}
function dragIdleCheck(): void {
  dragTimer = null
  if (Date.now() - dragLastAt > DRAG_IDLE_MS) { dragResetAll(); return }
  dragTimer = setTimeout(dragIdleCheck, 250)
}

function dragEnter(zone: 'todo' | 'log' | 'global'): void {
  dragPulse()
  dragDepth[zone] = (dragDepth[zone] || 0) + 1
}
function dragLeave(zone: 'todo' | 'log' | 'global'): void {
  dragPulse()
  dragDepth[zone] = Math.max(0, (dragDepth[zone] || 0) - 1)
}
function dragResetAll(): void {
  dragDepth.todo = 0
  dragDepth.log = 0
  dragDepth.global = 0
  dragAlive.value = false
  dragLastAt = 0
  if (dragTimer) { clearTimeout(dragTimer); dragTimer = null }
}

/** 自己有投放区、能收文件的页签 —— 全局兜底提示要避开它们。
 *  漏了技能页会把「本页不支持导入」的假提示盖在一个**明明支持导入**的页面上（2026-09-27 实测）。 */
const DROP_IMPORT_VIEWS: string[] = ['todos', 'logs', 'skills']

const todoDragOver = computed(() => dragAlive.value && dragDepth.todo > 0)
const logDragOver = computed(() => dragAlive.value && dragDepth.log > 0)
/** 当前页签不支持导入时，全局兜底提示（明确告诉用户去哪，而不是毫无反应） */
const globalDropHint = computed(() =>
  dragAlive.value && dragDepth.global > 0 && !DROP_IMPORT_VIEWS.includes(curView.value))
/** 技能页投放遮罩：同样吃心跳，避免拖拽收场拿不到事件时遮罩留在屏幕上 */
const skillsDropMaskVisible = computed(() => skillsDragging.value && dragAlive.value)

/** 拖到不支持导入的页签：给一句明确指引，并重置计数 */
function onAppDrop(e: DragEvent): void {
  dragResetAll()
  if (DROP_IMPORT_VIEWS.includes(curView.value)) return
  e.preventDefault()
  showToast('当前页签不支持导入文件 —— 请到「待办」「日志」或「技能」页签再拖入', 'info')
}

function onTodoDrop(e: DragEvent) {
  e.preventDefault()
  dragResetAll()
  const files = Array.from(e.dataTransfer?.files || [])
  if (!files.length) return
  void importTextLinesAsTodos(files)
}

/**
 * 拖入 txt/md 逐行建待办（2026-09-22 加重名/重复处置）。
 * 用户第 4 条：同名/重复内容**没有任何提示**，且会重复生成。
 * 现在：批内去重 + 与现存待办比对，重复的集中问一次，再报"写入 N 条 / 跳过 M 条重复"。
 */
async function importTextLinesAsTodos(files: File[]): Promise<void> {
  const usable = files.filter(f => /\.(txt|md)$/i.test(f.name))
  if (!usable.length) {
    showToast('仅支持 .txt / .md 文件', 'error')
    return
  }
  const project = todoProjectFilterProject()
  const existing = new Set(todos.value.map(t => t.title.trim()))
  const unique: string[] = []
  const dupInBatch: string[] = []
  for (const f of usable) {
    const text = await f.text()
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      if (existing.has(t) || unique.includes(t)) { dupInBatch.push(t); continue }
      unique.push(t)
    }
  }
  const dupTotal = dupInBatch.length
  if (!unique.length) {
    showToast(dupTotal ? `全部 ${dupTotal} 条都是已存在的同名待办，未新增` : '没有可导入的行', 'info')
    return
  }
  if (dupTotal) {
    const sample = dupInBatch.slice(0, 3).join('、')
    if (!confirm(`有 ${dupTotal} 条与现有待办重复，将被跳过：\n${sample}${dupTotal > 3 ? ' …' : ''}\n\n继续导入剩余 ${unique.length} 条？`)) {
      showToast('已取消导入', 'info')
      return
    }
  }
  let added = 0
  for (const title of unique) {
    const r = await window.tegula.todosCreate(title, '中', undefined, project)
    if (r.ok) added++
  }
  showToast(`已导入 ${added} 条待办${dupTotal ? `，跳过 ${dupTotal} 条重复` : ''}`, added ? 'success' : 'error')
  loadTodos()
}

async function toggleTodo(id: string) {
  const result = await window.tegula.todosToggle(id)
  if (result.ok) {
    loadTodos()
  }
}

async function deleteTodo(id: string) {
  if (!confirm('确定删除此待办？')) return
  await window.tegula.todosDelete(id)
  showToast('已删除', 'success')
  loadTodos()
}

// ── 待办多选（2026-09-30 用户补充：「待办和回收站也加入多选，这些也是常用场景」）──
// 交互与看板/日志同一套：工具条开关 → 点卡片勾选 → 悬浮批量栏执行。
// 批量完成走 todosUpdate({done}) 显式置值（todosToggle 是翻转，混合状态下批量翻会错乱）。
function toggleTodoBatchMode() {
  todoBatchMode.value = !todoBatchMode.value
  if (!todoBatchMode.value) selectedTodoBatch.value = []
  else showToast('批量模式：点击卡片勾选，再从下方批量栏执行', 'success')
}
function toggleTodoBatchSelect(id: string) {
  const idx = selectedTodoBatch.value.indexOf(id)
  if (idx >= 0) selectedTodoBatch.value.splice(idx, 1)
  else selectedTodoBatch.value.push(id)
}
function onTodoItemClick(todo: any) {
  // 多选模式下整卡点选；平时卡片空白处点击不做事（勾选/编辑/动作各有入口）
  if (todoBatchMode.value) toggleTodoBatchSelect(todo.id)
}
function toggleSelectAllTodos() {
  if (selectedTodoBatch.value.length === filteredTodos.value.length) selectedTodoBatch.value = []
  else selectedTodoBatch.value = filteredTodos.value.map((t: any) => t.id)
}
function exitTodoBatch() {
  selectedTodoBatch.value = []
  todoBatchMode.value = false
}
async function executeBatchTodoDone(done: boolean) {
  const ids = [...selectedTodoBatch.value]
  if (!ids.length) return
  let ok = 0
  for (const id of ids) {
    try {
      const r: any = await window.tegula.todosUpdate(id, { done } as any)
      // 真后端返回 Todo|null（null = 没这条）；假后端返回 {ok:...} —— 两边都按「真成功」计数
      if (r && r.ok !== false) ok++
    } catch { /* skip */ }
  }
  showToast(`已${done ? '标为完成' : '取消完成'} ${ok}/${ids.length} 条待办`, ok ? 'success' : 'error')
  exitTodoBatch()
  loadTodos()
}
async function executeBatchTodoDelete() {
  const ids = [...selectedTodoBatch.value]
  if (!ids.length) return
  if (!confirm(`批量删除 ${ids.length} 条待办？\n\n不可恢复（待办不进回收站）。`)) return
  let ok = 0
  for (const id of ids) {
    try {
      await window.tegula.todosDelete(id)
      ok++
    } catch { /* skip */ }
  }
  showToast(`已删除 ${ok}/${ids.length} 条待办`, ok ? 'success' : 'error')
  exitTodoBatch()
  loadTodos()
}

// ── 待办编辑弹窗（2026-09-25 用户第 12、14 条）───────────────────────
// 真因：`todosUpdate` 在 preload / IPC / service **三层早就通了**（service 也不拦已完成的任务），
// 但渲染层**从来没有入口** —— 用户感知就是「待办不能编辑」「签下（勾选）之后更不能改」。
// 所以第 12 条（要模态大框）和第 14 条（签下后不能编辑）是同一件事：补一个编辑弹窗。
const todoEdit_ = ref<any>(null)
const todoEditSaving = ref(false)

function openTodoEditor(todo: any) {
  todoEdit_.value = {
    id: todo.id,
    title: todo.title || '',
    priority: localPriority(todo.priority),
    due: todo.due || '',
    project: todo.project || '',
    done: !!todo.done,
  }
  todoGuard.open(todoEdit_.value)
}

function closeTodoEditor() {
  // 族1（卡004）：此前裸置 null = 改了点取消/遮罩就静默丢
  if (todoGuard.dirty(todoEdit_.value) && !confirm('待办内容尚未保存，确定关闭并丢弃吗？')) return
  todoEdit_.value = null
  todoGuard.clear()
}

// 同一弹窗复用成「新建」（第 12 条要的是**创建**也用大框，不只是编辑）
function openTodoCreator() {
  todoEdit_.value = {
    id: '',
    title: '',
    priority: '中',
    due: '',
    // 默认归属跟随当前筛选（哨兵值 '__all__'/'__none__' 一律当"不归属"）
    project: todoProjectFilterProject() || '',
    done: false,
  }
  todoGuard.open(todoEdit_.value)
}

async function saveTodoEdit() {
  const t = todoEdit_.value
  if (!t) return
  if (!String(t.title).trim()) { showToast('待办内容不能为空', 'info'); return }
  todoEditSaving.value = true
  try {
    const title = String(t.title).trim()
    const r = t.id
      ? await window.tegula.todosUpdate(t.id, {
          title,
          priority: t.priority,
          due: t.due || '',
          project: t.project || '',
        })
      : await window.tegula.todosCreate(title, t.priority, t.due || '', t.project || '')
    if (r && (r.ok || r.id || r.todo)) {
      showToast(t.id ? '已保存' : '已添加', 'success')
      todoEdit_.value = null
      await loadTodos()
    } else {
      showToast('保存失败：' + ((r && r.error) || '未知错误'), 'error')
    }
  } catch (e: any) {
    showToast('保存失败：' + (e?.message || e), 'error')
  } finally {
    todoEditSaving.value = false
  }
}

// ── Logs ───────────────────────────────────────────────────────────

const logs = ref<any[]>([])
const logSearchInput = ref('')
// 2026-09-28 用户第 5 条：`logStatusFilter` 已删除 —— 状态由分区表达，不再用下拉筛。
const logProjectFilter = ref('')
const logAgentFilter = ref('')
const logDateFrom = ref('')
const logDateTo = ref('')
const logEdit_ = ref<any>(null)
/** 接力对话框（2026-09-29 方案二）：源日志 + 预填字段 + 两个出清开关 */
const relay_ = ref<any>(null)
/** 关闭防丢确认条（2026-09-30 卡 006）：有未创建改动时点遮罩/「取消」→ 先出条，点「丢弃」才真关。
 *  不再用原生 window.confirm —— 用户实测两次「防护未生效」，对话框内的条子躲不掉也误点不了。 */
const relayDiscard_ = ref(false)
/** 确认条上列出到底改了什么，让用户判断值不值得丢 */
const relayDirtyHint = computed(() => relayChanges(relay_.value).join('、') || '（改动未识别）')
/** 确认条本身 —— 接力对话框内容长（88vh 内可滚动），条子可能在折叠线下方，
 *  出现时必须把它滚进视野并把焦点放在「继续填写」上（默认动作 = 留下，回车不会误丢）。 */
const relayDiscardBar = ref<HTMLElement | null>(null)
// Agent 预设列表（设置页可增删）。
// 014（2026-09-25）：真身放**主进程 prefs.json**，localStorage 只当读缓存 ——
// localStorage 绑定 origin，dev 换 host（localhost→127.0.0.1）或打包版 file:// 都会把预设清空。
const DEFAULT_AGENT_PRESETS = ['hermes', 'opencode', 'codex', 'deepseek', 'claude']
function readAgentPresetsCache(): string[] | null {
  try {
    const v = localStorage.getItem('fc_agent_presets')
    const arr = v ? JSON.parse(v) : null
    return Array.isArray(arr) ? arr : null
  } catch { return null }
}
const agentPresets = ref<string[]>(readAgentPresetsCache() || DEFAULT_AGENT_PRESETS)
const newAgentName = ref('')

/** 启动时与主进程对齐：真身有值就用它；真身空但缓存有值 → 把老数据迁上去（不丢用户资产）。 */
async function syncAgentPresets(): Promise<void> {
  try {
    const p: any = await window.tegula.prefsGet()
    const stored = p?.fc_agent_presets
    if (Array.isArray(stored) && stored.length) {
      agentPresets.value = stored
      return
    }
    const cached = readAgentPresetsCache()
    if (cached && cached.length) {
      agentPresets.value = cached
      await window.tegula.prefsSet('fc_agent_presets', cached) // 一次性迁移
    }
  } catch { /* 读不到就继续用缓存/默认值，不打断启动 */ }
}

function saveAgentPresets(): void {
  try { localStorage.setItem('fc_agent_presets', JSON.stringify(agentPresets.value)) } catch { /* 缓存写失败无所谓 */ }
  try { window.tegula.prefsSet('fc_agent_presets', agentPresets.value)?.catch?.(() => {}) } catch { /* 真身写失败已在主进程记日志 */ }
}

function addAgentPreset() {
  const name = newAgentName.value.trim()
  if (!name) return
  if (agentPresets.value.includes(name)) { showToast('已存在', 'info'); return }
  agentPresets.value.push(name)
  saveAgentPresets()
  newAgentName.value = ''
  showToast('已添加', 'success')
}

function removeAgentPreset(index: number) {
  const removed = agentPresets.value[index]
  agentPresets.value.splice(index, 1)
  saveAgentPresets()
  // 如果当前筛选用的是被删的预设，清掉
  if (logAgentFilter.value === removed) logAgentFilter.value = ''
  showToast('已删除', 'info')
}
let logPollingTimer: ReturnType<typeof setInterval> | null = null

/**
 * 过滤后的日志（2026-09-28 用户第 5 条）。
 *
 * **状态筛选下拉被删掉了** —— 用户原话「那些筛选实际上除了把信息搞得支离破碎以外
 * 没什么作用」。原因很清楚：状态下拉是一个"单值"控件，而人需要同时看到
 * 「谁在跑 / 谁没跑 / 谁跑完了」这三件事，单选必然把画面切碎。
 * 现在状态由**分区**表达（`groupedLogs`），筛选只负责**缩小数据集**
 * （搜索词 / 项目 / Agent / 日期），两者不再打架。
 */
/**
 * 日志排序（2026-10-01 用户第 2 条）：此前只有后端给的「文件名倒序」= 创建倒序，
 * 连"最早的排前面"都做不到。这里在渲染层排 —— 数据一次取回（≤ 50 条/页），
 * 不再往数据层加第二个排序入口（同一条取数路径的原则，见 loadLogs 注释）。
 * 置顶分组不受影响：pinned 是在分组阶段单独拎出来的（logGroups 里）。
 */
const logSort = ref<string>(readUiPref<string>('fc_log_sort', 'created_desc'))
watch(logSort, v => saveUiPref('fc_log_sort', v))

const filteredLogs = computed(() => {
  const arr = [...logs.value]
  const byStr = (f: (l: any) => string, locale?: string) =>
    (a: any, b: any) => String(f(a)).localeCompare(String(f(b)), locale)
  switch (logSort.value) {
    case 'created_asc': return arr.sort(byStr(l => l.created))
    case 'date_desc': return arr.sort((a, b) => String(b.logDate || b.created).localeCompare(String(a.logDate || a.created)))
    case 'title_asc': return arr.sort(byStr(l => l.title || '', 'zh-Hans-CN'))
    default: return arr.sort((a, b) => String(b.created).localeCompare(String(a.created)))
  }
})

// ── 按状态分区（2026-09-28）────────────────────────────────────────────
const LOG_GROUP_DEFS = [
  { key: 'running', label: '进行中', hint: '手动标了「进行中」的' },
  { key: 'active', label: '待处理', hint: '' },
  { key: 'completed', label: '已完成', hint: '' },
  { key: 'archived', label: '已归档', hint: '' },
] as const

/**
 * 分区结果。**置顶单独成区放最前**（2026-09-26 卡 037 的承诺：钉住的一直看得见）——
 * 原来置顶是靠"把卡片插到列表最前"，有了分区以后那样做会把一条归档日志混进待处理区，
 * 反而看不懂。独立成区既保住承诺，又不骗人。
 */
const groupedLogs = computed(() => {
  const all = filteredLogs.value
  const groups: Array<{ key: string; label: string; hint: string; logs: any[] }> = []
  const pinned = all.filter(l => l.pinned)
  if (pinned.length) groups.push({ key: 'pinned', label: '置顶', hint: '', logs: pinned })
  const rest = all.filter(l => !l.pinned)
  for (const d of LOG_GROUP_DEFS) {
    const list = rest.filter(l => logGroupKey(l) === d.key)
    if (list.length) groups.push({ key: d.key, label: d.label, hint: d.hint, logs: list })
  }
  return groups
})

/** 一条日志属于哪个分区： running 优先于 status（进行中必然是未完成的） */
function logGroupKey(l: any): string {
  if (l.status === 'active') return l.running ? 'running' : 'active'
  return String(l.status || 'active')
}

/** 分区折叠状态（写回真身，重启保留）。默认收起「已归档」——归档的语义就是「先别看了」。 */
const collapsedLogGroups = ref<string[]>(readUiPref<string[]>('fc_log_group_collapsed', ['archived']))
function isLogGroupCollapsed(key: string): boolean {
  return collapsedLogGroups.value.includes(key)
}
function toggleLogGroup(key: string): void {
  const idx = collapsedLogGroups.value.indexOf(key)
  if (idx >= 0) collapsedLogGroups.value.splice(idx, 1)
  else collapsedLogGroups.value.push(key)
  saveUiPref('fc_log_group_collapsed', collapsedLogGroups.value)
}

// ── 按链视图（2026-09-29 第 3 条方案二）──────────────────────────────
// 分段开关「分区｜按链」。默认仍是分区 —— 加视图不改旧的。
// 按链 = 连通分量：沿 continueFrom（续自）把前后相承的日志串成一条竖轨，
// 不引入新实体、不建数据库，链只活在渲染层的一次计算里。
const logsViewMode = ref<'groups' | 'chain'>(readUiPref<'groups' | 'chain'>('fc_logs_view_mode', 'groups'))
function setLogsViewMode(m: 'groups' | 'chain'): void {
  logsViewMode.value = m
  saveUiPref('fc_logs_view_mode', m)
}

/** 当前渲染单元：分区视图 = 原 groupedLogs；按链视图 = 链/单条 sections */
const renderSections = computed(() => {
  if (logsViewMode.value !== 'chain') return groupedLogs.value as any[]
  return buildChainSections(filteredLogs.value)
})

function buildChainSections(all: any[]): any[] {
  const byId = new Map(all.map(l => [l.id, l] as const))
  // 链头：沿 continueFrom 走到走不动为止（环/断链/筛选掉的父级都算尽头，guard 防自指环）
  const rootOf = (l: any): string => {
    let cur = l
    const seen = new Set<string>()
    let guard = 0
    while (cur?.continueFrom && byId.has(cur.continueFrom) && !seen.has(cur.id) && guard++ < 50) {
      seen.add(cur.id)
      cur = byId.get(cur.continueFrom)
    }
    return cur.id
  }
  const comps = new Map<string, any[]>()
  for (const l of all) {
    const r = rootOf(l)
    const arr = comps.get(r) || []
    arr.push(l)
    comps.set(r, arr)
  }
  const sections: any[] = []
  for (const [root, members] of comps) {
    members.sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')))
    if (members.length >= 2) {
      const head = members[0]
      const tail = members[members.length - 1]
      sections.push({
        key: 'chain:' + root,
        label: '', hint: '', logs: members,
        chain: {
          name: members.length === 2 ? `${head.title} → ${tail.title}` : `${head.title} → … → ${tail.title}`,
          count: members.length,
          since: formatDate(head.created),
          recent: formatDate(tail.created),
          tail,
        },
      })
    } else {
      sections.push({ key: 'single:' + root, label: '', hint: '', logs: members, chain: null })
    }
  }
  // 排序：谁最近活跃谁在前（链头字符串 = 最后一个成员的 created）
  sections.sort((a, b) => String(a.logs[a.logs.length - 1]?.created || '').localeCompare(String(b.logs[b.logs.length - 1]?.created || '')))
  return sections.reverse()
}

// ── 「更多筛选」抽屉（2026-09-28 用户第 5 条）──────────────────────────
// Agent / 日期范围此前和搜索框并排摊开，6 个控件挤在一条线上 —— 用户「看起来还是晕」。
// 低频的那两个收进抽屉，默认收起；抽屉里有值时给按钮打个角标，避免"筛了却忘"。
const logMoreFilterOpen = ref(false)
const logMoreFilterCount = computed(() =>
  (logAgentFilter.value ? 1 : 0) + (logDateFrom.value ? 1 : 0) + (logDateTo.value ? 1 : 0))
function toggleLogMoreFilter(): void { logMoreFilterOpen.value = !logMoreFilterOpen.value }
async function clearLogMoreFilters(): Promise<void> {
  logAgentFilter.value = ''
  logDateFrom.value = ''
  logDateTo.value = ''
  await loadLogs()
}

async function loadLogs() {
  try {
    const filter: any = {}
    if (logProjectFilter.value) filter.project = logProjectFilter.value
    if (logAgentFilter.value) filter.agent = logAgentFilter.value
    if (logDateFrom.value) filter.dateFrom = logDateFrom.value
    if (logDateTo.value) filter.dateTo = logDateTo.value
    // 搜索词 = 筛选的一个维度（2026-10-01 用户第 3 条）。此前搜索另走 logs:search，
    // 与这里的筛选互不相干，而且完成/归档/改筛选任何一次 loadLogs 都会把搜索结果冲掉、
    // 框里的词却还留着 —— 「搜了又没了」。现在只有一条取数路径，刷新也不会丢。
    const q = logSearchInput.value.trim()
    if (q) filter.query = q
    logs.value = await window.tegula.logsList(filter)
  } catch {
    logs.value = []
  }
}

function logStatusLabel(log: any): string {
  if (!log) return ''
  // 2026-09-28 用户第 2 条：`active` 的中文从「进行中」改成「**待处理**」——
  // 「进行中」现在是 running 这个手动标记的专属名字，不再由 status 自动带来。
  if (log.status === 'active' && log.running) return '进行中'
  return { active: '待处理', completed: '已完成', archived: '已归档' }[log.status] || String(log.status || '')
}

/** 徽章 class：running 优先（进行中的视觉最醒目） */
function logStatusClass(log: any): string {
  if (!log) return ''
  return log.status === 'active' && log.running ? 'running' : String(log.status || '')
}

/**
 * 手动开 / 关「进行中」（2026-09-28 用户第 2 条）。
 * 这是「进行中」的唯一入口：创建不会再自动打上，完成/归档也只会把它关掉。
 * 可撤销 —— 关掉即回到「待处理」，不会误伤任何东西。
 */
async function toggleLogRunning(log: any): Promise<void> {
  const next = !log.running
  const r: any = await window.tegula.logsSetRunning(log.id, next)
  if (r && r.ok) {
    showToast(next ? '已标为「进行中」' : '已撤销「进行中」，回到待处理', 'success')
    await loadLogs()
  } else {
    showToast(`操作失败：${(r && r.error) || '未知原因'}`, 'error')
  }
}

function toggleLogBatchMode() {
  logBatchMode.value = !logBatchMode.value
  if (!logBatchMode.value) selectedLogBatch.value = []
}

function toggleSelectAllLogs() {
  if (selectedLogBatch.value.length === filteredLogs.value.length) {
    selectedLogBatch.value = []
  } else {
    selectedLogBatch.value = filteredLogs.value.map((l: any) => l.id)
  }
}

async function executeBatchLogComplete() {
  const ids = [...selectedLogBatch.value]
  if (ids.length === 0) return
  if (!confirm(`批量完成 ${ids.length} 条日志？`)) return
  let ok = 0
  for (const id of ids) {
    try {
      const r = await window.tegula.logsComplete(id, 7, '')
      if (r?.ok) ok++
    } catch { /* skip */ }
  }
  showToast(`已批量完成 ${ok}/${ids.length} 条日志`, ok ? 'success' : 'error')
  selectedLogBatch.value = []
  logBatchMode.value = false
  loadLogs()
}

async function executeBatchLogArchive() {
  const ids = [...selectedLogBatch.value]
  if (ids.length === 0) return
  if (!confirm(`批量归档 ${ids.length} 条日志？`)) return
  let ok = 0
  for (const id of ids) {
    try {
      const r = await window.tegula.logsArchive(id)
      if (r?.ok) ok++
    } catch { /* skip */ }
  }
  showToast(`已批量归档 ${ok}/${ids.length} 条日志`, ok ? 'success' : 'error')
  selectedLogBatch.value = []
  logBatchMode.value = false
  loadLogs()
}

async function executeBatchLogDestroy() {
  const ids = [...selectedLogBatch.value]
  if (ids.length === 0) return
  if (!confirm(`批量销毁 ${ids.length} 条日志？文件将被永久删除。`)) return
  let ok = 0
  for (const id of ids) {
    try {
      const r = await window.tegula.logsDestroy(id)
      if (r?.ok) ok++
    } catch { /* skip */ }
  }
  showToast(`已批量销毁 ${ok}/${ids.length} 条日志`, ok ? 'success' : 'error')
  selectedLogBatch.value = []
  logBatchMode.value = false
  loadLogs()
}

function onLogCardClick(log: any) {
  if (logBatchMode.value) {
    const idx = selectedLogBatch.value.indexOf(log.id)
    if (idx >= 0) selectedLogBatch.value.splice(idx, 1)
    else selectedLogBatch.value.push(log.id)
  } else {
    // 2026-09-25（用户第 13 条）：单击 = 只读预览（Markdown 渲染），与任务卡一致；
    // 编辑走卡片操作行的「✏️ 编辑」或预览里的按钮。
    openLogPreview(log)
  }
}

// ── 日志只读预览（2026-09-25 用户第 13 条）──────────────────────────────
const logPreview = ref<any>(null)
function openLogPreview(log: any): void { logPreview.value = { ...log } }
function openLogFromPreview(): void {
  const l = logPreview.value
  logPreview.value = null
  if (l) openLog(l)
}

// ── 附件：日志 ↔ 文件的唯一关联入口（2026-10-01 用户第 1 条 → 卡 036）──────
// 语义刻意收窄：只做「这条日志引用了哪些文件」，不做素材库/标签/相册。
// 文件本体在数据目录 `docs/执行日志/_attachments/<logId>/`，列表里是相对路径。
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i
/** rel → dataURL 缓存。空串 = 取过但取不到（超 8MB / 已不在数据目录），UI 回落成「用系统打开」 */
const attachCache_ = reactive<Record<string, string>>({})
const attachPending_ = reactive<Record<string, boolean>>({})

function isImageRel(rel: string): boolean { return IMG_EXT.test(String(rel || '')) }
function attachName(rel: string): string {
  const s = String(rel || '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) : s
}
/** 取预览用 data URL（渲染期调用，幂等：每条 rel 只发一次 IPC） */
function attachSrc(rel: string): string {
  const key = String(rel || '')
  if (!key) return ''
  if (attachCache_[key] !== undefined) return attachCache_[key]
  if (attachPending_[key]) return ''
  attachPending_[key] = true
  const api = (window as any).tegula
  Promise.resolve(api?.logsAttachmentData?.(key))
    .then((r: any) => {
      attachPending_[key] = false
      attachCache_[key] = r?.ok && r.data?.dataUrl ? r.data.dataUrl : ''
    })
    .catch(() => { attachPending_[key] = false; attachCache_[key] = '' })
  return ''
}

/** 附件落到哪几处视图：列表里的卡、只读预览、编辑对话框（谁开着就更谁） */
function applyAttachments(logId: string, entry: any): void {
  const list = Array.isArray(entry?.attachments) ? entry.attachments : []
  const row = logs.value.find(l => l.id === logId)
  if (row) row.attachments = list
  if (logPreview.value && logPreview.value.id === logId) logPreview.value.attachments = list
  if (logEdit_.value && logEdit_.value.id === logId) logEdit_.value.attachments = list
}

/** 弹系统选文件框 → 主进程复制进数据目录 → 三处视图同步 */
async function attachAdd(logId: string): Promise<void> {
  if (!logId) { showToast('先保存日志再挂附件', 'info'); return }
  try {
    const r = await (window as any).tegula.logsAttachFiles(logId)
    if (r?.error === 'canceled') return
    if (!r?.ok) { showToast('添加附件失败：' + (r?.error || '未知原因'), 'error'); return }
    applyAttachments(logId, r.data)
    const n = r.data?.attachments?.length || 0
    showToast(`附件已关联（这条日志共 ${n} 个）`, 'success')
  } catch (e: any) {
    showToast('添加附件失败：' + (e?.message || e), 'error')
  }
}

/** 解除关联 —— 文件**不删**（见 logs.ts detachAttachment 的注释） */
async function attachRemove(logId: string, rel: string): Promise<void> {
  try {
    const r = await (window as any).tegula.logsDetachAttachment(logId, rel)
    if (!r?.ok) { showToast('移除失败：' + (r?.error || '未知原因'), 'error'); return }
    applyAttachments(logId, r.data)
    showToast('已解除关联（文件仍保留在数据目录）', 'info')
  } catch (e: any) {
    showToast('移除失败：' + (e?.message || e), 'error')
  }
}

/** 用系统程序打开（图片看大图、报告开 PDF） */
async function attachOpen(rel: string): Promise<void> {
  try {
    const r = await (window as any).tegula.logsOpenAttachment(rel)
    if (!r?.ok) showToast('打开失败：' + (r?.error || '未知原因'), 'error')
  } catch (e: any) {
    showToast('打开失败：' + (e?.message || e), 'error')
  }
}

function openLog(log: any) {
  // 2026-09-25（用户第 2 条）：把关联任务归一成数组，供多选 UI 绑定
  logEdit_.value = { ...log, taskIds: normalizeLogTaskIds(log) }
  logCompleting.value = false
  logArchiveMode.value = false
  markLogSnap()   // P0-1：打开即存快照（改没改才算数）
  // 2026-09-23（用户第2条）：修复日志模态框输入聚焦问题
  // 自动聚焦到标题输入框，确保用户可以立即输入
  setTimeout(() => {
    const titleInput = document.querySelector('#log-edit-modal input[placeholder="日志标题"]') as HTMLInputElement
    if (titleInput) titleInput.focus()
  }, 50)
}

const logCompleting = ref(false)
const logArchiveMode = ref(false)
const logRetainDays = ref(String(logRetainDefault.value))
const logNote = ref('')

function openNewLog() {
  // 项目默认跟随顶栏的项目筛选（没筛选就用第一个登记项目），而不是硬编码一个 id
  const project = curProj.value !== '__all__'
    ? curProj.value
    : (projects.value[0]?.id || '')
  logEdit_.value = { id: '', title: '', project, content: '', nextSteps: '', taskIds: [], sessionId: '', agentName: '', prevAgentName: '', logDate: '' }
  logCompleting.value = false
  logArchiveMode.value = false
  logRetainDays.value = String(logRetainDefault.value)
  logNote.value = ''
  markLogSnap()   // P0-1：新建只改下拉也不许静默丢（老逻辑三键全空 → 不提示）
}

/** 日志 ID 缩写：`log_20260927…c73e`（卡面链标签用，完整 ID 挂 title） */
function shortLogId(id: string): string {
  const s = String(id || '')
  return s.length > 22 ? `${s.slice(0, 14)}…${s.slice(-4)}` : s
}

/**
 * 接力对话框（2026-09-29 方案二）。
 * 预填规则（2026-10-03 再收窄）：**标题不再预填** —— 用户原话「日志接力自动沿用上次日志
 * 的标题，容易产生歧义，我希望每个日志可以创建新标题」（源标题在顶部「源」条里看得到）；
 * 项目/任务继承源；Agent 拆两字段：上次的执行 Agent 继承源（可改可补）、本次默认沿用源。
 * （2026-10-02 曾定「标题 = 源标题让人一眼看出要改」，被 10-03 口径覆盖。）
 * **下一步不再预填**（用户：「下一步依旧每次都直接挪用上次的输入结果」）——
 * 与执行内容同口径留空，要源里的原文点「带入源的下一步」按钮主动取。
 * 勾选默认 = 未完成的关联任务进新日志、源日志归档出清、源任务不动。
 */
function openRelay(src: any): void {
  if (!src) return
  const all = [...tasks.value, ...archivedTasks.value]
  const srcIds: string[] = Array.isArray(src.taskIds) && src.taskIds.length
    ? src.taskIds.filter(Boolean)
    : (src.taskId ? [String(src.taskId)] : [])
  const candidates = srcIds.map(id => {
    const t = all.find(x => x.id === id)
    return { id, title: t?.title || '(不在任务列表中)', status: t?.status || '未知' }
  })
  relay_.value = {
    src,
    // 2026-10-03 反馈2（卡 task-20261003-002）：标题**不再沿用源** —— 留空强制给新日志起新标题
    title: '',
    project: src.project || '',
    // 2026-10-02 用户「下一步依旧每次都直接挪用上次的输入结果」：**默认留空**，
    // 源的下一步要点「带入源的下一步」才进来（见 bringSourceNextSteps）。
    nextSteps: '',
    // 2026-09-30 卡 004：执行内容**不继承源**（源的正文属于上一段），留空给用户贴本次汇总
    content: '',
    taskCandidates: candidates,
    taskIds: candidates.filter(c => c.status !== '完成' && c.status !== '驳回').map(c => c.id),
    // 上次的执行 Agent（反馈1）：源自己记录的执行者 = 上一段的执行者；源没记就留空给用户补
    prevAgentName: src.agentName || src.prevAgentName || '',
    // 本次执行 Agent：默认沿用源（同一 agent 继续跑），可改
    agentName: src.agentName || '',
    archiveSource: true,
    completeSourceTasks: false,
    // 打开瞬间的快照：关闭前逐字段比对（卡 006）。此前只比对三个文本框，
    // 只改过下拉/勾选就判「没改」→ 点遮罩直接静默关，用户报「数据全丢」。
    _init: null as any,
  }
  const r = relay_.value
  r._init = {
    title: String(r.title || '').trim(),
    project: String(r.project || '').trim(),
    nextSteps: String(r.nextSteps || '').trim(),
    content: String(r.content || '').trim(),
    agentName: String(r.agentName || '').trim(),
    prevAgentName: String(r.prevAgentName || '').trim(),
    taskIds: [...(r.taskIds || [])].sort().join(','),
    archiveSource: !!r.archiveSource,
    completeSourceTasks: !!r.completeSourceTasks,
  }
  relayDiscard_.value = false
  logBatchMode.value = false
}

/**
 * 「带入源的下一步」（2026-10-02）：源日志的「下一步」不再自动挪用，改成**点了才带**。
 * 三条边界：① 源本来就是空的 → 明说，不装作带入了；② 框里已有内容且与源不同 → **绝不覆盖**
 * （会静默吃掉用户刚写的东西，正是本卡要治的病）；③ 带入后与打开快照不同 → 关闭时会走防丢确认条。
 */
function bringSourceNextSteps(): void {
  const r = relay_.value
  if (!r) return
  const srcNext = String(r.src?.nextSteps || '').trim()
  if (!srcNext) {
    showToast('源日志的「下一步」本来就是空的', 'info')
    return
  }
  const cur = String(r.nextSteps || '').trim()
  if (cur && cur !== srcNext) {
    showToast('本框已有内容，未覆盖 —— 想带入请先清空', 'info')
    return
  }
  r.nextSteps = r.src.nextSteps
}

/**
 * 改了哪些字段（相对打开时的快照 `_init`）：空数组 = 什么都没动，可以随手关。
 * 覆盖**全部**可编辑字段（文本 + 下拉 + 勾选 + 出清开关），不只看有没有字。
 */
function relayChanges(r: any): string[] {
  const ini = r?._init
  if (!ini || typeof ini !== 'object') return []
  const t = (v: any) => String(v ?? '').trim()
  const ch: string[] = []
  if (t(r.title) !== ini.title) ch.push('标题')
  if (t(r.project) !== ini.project) ch.push('项目')
  if (t(r.content) !== ini.content) ch.push('执行内容')
  if (t(r.nextSteps) !== ini.nextSteps) ch.push('下一步')
  if (t(r.prevAgentName) !== ini.prevAgentName) ch.push('上次执行 Agent')
  if (t(r.agentName) !== ini.agentName) ch.push('本次执行 Agent')
  if ([...(r.taskIds || [])].sort().join(',') !== ini.taskIds) ch.push('关联任务')
  if (!!r.archiveSource !== ini.archiveSource) ch.push('源归档开关')
  if (!!r.completeSourceTasks !== ini.completeSourceTasks) ch.push('源任务置完成开关')
  return ch
}

/**
 * 关闭接力对话框：有未创建的改动先出**对话框内的确认条**（2026-09-30 卡 006）。
 * 遮罩点击（@click.self）、「取消」、全局 Esc（会替我们点「取消」）都走这里。
 * 第一次点 = 出条不关；条子出着时再点 = 仍不关（要关必须点条上的「丢弃并关闭」）。
 * 诊断痕迹：渲染层只有 console.warn 会进应用日志，这里必须留痕，
 * 否则下次再有人说「防护没生效」时无从判断是没点到还是没拦住。
 */
function closeRelay(): void {
  const r = relay_.value
  if (!r) return
  const ch = relayChanges(r)
  if (ch.length) {
    if (!relayDiscard_.value) {
      // 卡 006 补（2026-10-01）：接力框 88vh 内可滚动，确认条可能在折叠线下方 ——
      // 出现时必须滚进视野 + 焦点落到「继续填写」，否则用户点外面只会看到"没反应"，
      // 又要报一次「防护未生效」。
      relayDiscard_.value = true
      nextTick(() => {
        const bar = relayDiscardBar.value
        if (!bar) return
        try { bar.scrollIntoView({ block: 'nearest' }) } catch { /* 老 Chromium：不支持 options */ }
        const keep = bar.querySelector('button') as HTMLButtonElement | null
        keep?.focus()
      })
      console.warn(`[relay] 关闭被拦下：未创建的改动（${ch.join('、')}），等用户选择丢弃或继续填写`)
    }
    return
  }
  relay_.value = null
  relayDiscard_.value = false
}

/** 用户在确认条上明确点了「丢弃并关闭」——这才是唯一丢弃入口 */
function discardRelay(): void {
  console.warn(`[relay] 用户确认丢弃未创建的接力内容（${relayChanges(relay_.value).join('、') || '无'}）`)
  relay_.value = null
  relayDiscard_.value = false
}

/**
 * 执行接力：**先建新日志，再动源**（顺序是安全约束 —— 先归档源、新建失败 = 源没了后继也没了）。
 * 四件事：① 建新日志（继承下一步/项目/任务/Agent + 写 续自）
 *        ② 源日志归档出清（不带 note：不覆盖源的「完成确认」，链关系已由 续自 记录）
 *        ③ 源关联任务置完成（可选，跳过已是终态的）
 *        ④ 立即标「进行中」（可选，走唯一写入路径 logsSetRunning）
 */
async function executeRelay(startRunning: boolean): Promise<void> {
  const r = relay_.value
  if (!r) return
  const title = String(r.title || '').trim()
  if (!title) {
    showToast('标题不能为空', 'error')
    return
  }
  const src = r.src
  try {
    const created: any = await window.tegula.logsCreate(title, r.project, r.content || '', (r.taskIds || [])[0] || undefined, {
      // 2026-09-30 用户第 2 条（卡 task-20260930-003）：r = relay_.value 是 Vue 响应式代理，
      // r.taskIds 是**裸代理数组** —— 直接塞进 IPC 载荷在 contextBridge 那跳必抛
      // 「An object could not be cloned」，两个创建按钮全炸。展开成普通数组再传。
      taskIds: [...(r.taskIds || [])],
      agentName: r.agentName || '',
      prevAgentName: r.prevAgentName || '',
      nextSteps: r.nextSteps || '',
      continueFrom: src.id,
      logDate: '',
    })
    if (!created?.ok) {
      showToast(`创建失败：${created?.error || '未知原因'}`, 'error')
      return
    }
    const newId = created.data?.id || ''
    const problems: string[] = []
    if (r.archiveSource) {
      const a: any = await window.tegula.logsArchive(src.id)
      if (!a?.ok) problems.push(`源日志归档失败：${a?.error || '未知原因'}`)
    }
    if (r.completeSourceTasks) {
      const all = [...tasks.value, ...archivedTasks.value]
      const srcIds: string[] = Array.isArray(src.taskIds) && src.taskIds.length ? src.taskIds.filter(Boolean) : (src.taskId ? [String(src.taskId)] : [])
      for (const id of srcIds) {
        const t = all.find(x => x.id === id)
        if (!t || t.status === '完成' || t.status === '驳回') continue
        try {
          const mv: any = await window.tegula.moveStatus(id, '完成')
          if (mv && mv.ok === false) problems.push(`任务 ${id} 置完成失败：${mv.error || ''}`)
        } catch (e: any) {
          problems.push(`任务 ${id} 置完成失败：${e?.message || e}`)
        }
      }
    }
    if (startRunning && newId) {
      const run: any = await window.tegula.logsSetRunning(newId, true)
      if (!run?.ok) problems.push(`标「进行中」失败：${run?.error || '未知原因'}`)
    }
    relay_.value = null
    relayDiscard_.value = false
    await loadLogs()
    if (problems.length) {
      showToast(`已创建 ${newId}，但：${problems.join('；')}`, 'error')
    } else {
      showToast(startRunning ? `已接力开跑：${newId}` : `已创建：${newId}`, 'success')
    }
  } catch (err: any) {
    showToast(`接力失败：${err.message || err}`, 'error')
  }
}

/** 日志可关联的任务候选：按所选项目过滤（用户第 2 条：便于选择，而非手填 ID） */
const logTaskOptions = computed(() => {
  const proj = logEdit_.value?.project
  const all = [...tasks.value, ...archivedTasks.value]
  const seen = new Set<string>()
  const out: Array<{ id: string; title: string; status: string }> = []
  for (const t of all) {
    if (seen.has(t.id)) continue
    if (proj && normProject(t.project) !== proj) continue
    seen.add(t.id)
    out.push({ id: t.id, title: t.title || '', status: t.status })
    if (out.length >= 500) break
  }
  return out
})

/** 当前已关联任务的回显（id 不在任务列表里时提示"列表外"） */
const logTaskPicked = computed(() => {
  const ids = normalizeLogTaskIds(logEdit_.value || {})
  if (!ids.length) return ''
  const all = [...tasks.value, ...archivedTasks.value]
  return ids.map(id => {
    const t = all.find(x => x.id === id)
    return t ? `${t.id} · ${t.title || '(无标题)'}` : `${id}（列表外）`
  }).join('；')
})

/** 把日志的关联任务归一成字符串数组（2026-09-25 用户第 2 条：支持多个） */
function normalizeLogTaskIds(log: any): string[] {
  if (Array.isArray(log?.taskIds) && log.taskIds.length) return log.taskIds.filter(Boolean)
  if (Array.isArray(log?.tasks) && log.tasks.length) return log.tasks.map((x: any) => String(x)).filter(Boolean)
  return log?.taskId ? [String(log.taskId)] : []
}

/** 手填的「列表外 ID」：逗号/空格分隔，回车或失焦时并入已选 */
const logTaskExtra = ref('')
function addLogTaskExtra(): void {
  const raw = logTaskExtra.value || ''
  const ids = raw.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
  if (!ids.length) return
  const e = logEdit_.value
  if (!e) return
  const cur = normalizeLogTaskIds(e)
  for (const id of ids) if (!cur.includes(id)) cur.push(id)
  e.taskIds = cur
  logTaskExtra.value = ''
}

// ── 日志：导入外部文本（老版本有，桌面化时丢了）────────────────────────
// 按钮选择与直接拖入两条路都通；每个文件生成一条日志，标题取文件名。
// 2026-09-22（用户第 4 条）：同名/重复此前**静默生成**，现在先判重、集中问一次。
// 2026-09-22（补）：判重口径从"仅文件名"扩到「文件名 + 正文内容指纹」——
//   改名重导同一份内容同样会被拦住（用户："防呆不防傻"→ 这一版把"傻"也补上）。
const LOG_IMPORT_RE = /\.(txt|md|markdown|log)$/i

async function importTextFilesAsLogs(files: File[]): Promise<number> {
  const usable = files.filter(f => LOG_IMPORT_RE.test(f.name))
  if (!usable.length) {
    if (files.length) showToast('仅支持 .txt / .md / .log 文件', 'error')
    return 0
  }
  // 取**全量**日志参与判重（logs.value 可能正被状态/搜索条件过滤，
  // 用过滤后的列表判重会漏过"已归档的同名/同内容"，那就等于没有判重）
  let existing: any[] = []
  try {
    existing = await window.tegula.logsList()
  } catch { /* 取不到就退化为"不判重"，不阻断导入 */ }

  const items: ImportItem[] = []
  for (const f of usable) {
    try {
      items.push({ title: f.name.replace(/\.[^.]+$/, ''), text: await f.text() })
    } catch { /* 单个文件读失败不阻断其余 */ }
  }
  if (!items.length) {
    showToast('文件读取失败，没有可导入的内容', 'error')
    return 0
  }

  const cls = classifyLogImport(items, existing)
  const skipped = cls.dupTitle.length + cls.dupContent.length + cls.dupInBatch.length
  if (!cls.fresh.length) {
    showToast(`全部被拦截，未新增 —— ${classifySummary(cls)}`, 'info')
    return 0
  }
  if (skipped) {
    const lines: string[] = []
    const sample = (arr: string[]) => arr.slice(0, 3).join('、') + (arr.length > 3 ? ' …' : '')
    if (cls.dupTitle.length) lines.push(`同名：${sample(cls.dupTitle)}`)
    if (cls.dupContent.length) lines.push(`内容相同（只是改了名）：${sample(cls.dupContent)}`)
    if (cls.dupInBatch.length) lines.push(`同一批里重复：${sample(cls.dupInBatch)}`)
    if (!confirm(`检测到 ${skipped} 个重复文件（按「文件名 + 正文内容指纹」判定）：\n${lines.join('\n')}\n\n重复的跳过，继续导入其余 ${cls.fresh.length} 个？`)) {
      showToast('已取消导入', 'info')
      return 0
    }
  }

  const project = curProj.value !== '__all__' ? curProj.value : (projects.value[0]?.id || '')
  let ok = 0
  for (const it of cls.fresh) {
    try {
      const r = await window.tegula.logsCreate(it.title, project, it.text)
      if (r?.ok) ok++
    } catch { /* 单个文件失败不阻断其余 */ }
  }
  showToast(`已导入 ${ok} 条日志${skipped ? `，跳过 ${skipped} 个重复` : ''}`, ok ? 'success' : 'error')
  loadLogs()
  return ok
}

function importLogFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.txt,.md,.markdown,.log'
  input.multiple = true
  input.onchange = async (e: any) => {
    await importTextFilesAsLogs(Array.from(e.target.files || []))
  }
  input.click()
}

async function onLogDrop(e: DragEvent) {
  e.preventDefault()
  dragResetAll()
  await importTextFilesAsLogs(Array.from(e.dataTransfer?.files || []))
}

/** 从任务详情写一条执行日志：预填 taskId 与项目，省得再手填一遍 */
function openLogForTask(taskId: string) {
  openNewLog()
  logEdit_.value.taskId = taskId
  const t = previewTask.value
  if (t?.project) logEdit_.value.project = normProject(t.project)
  if (t?.title) logEdit_.value.title = `${t.title} — 执行记录`
}

async function saveLogEdit() {
  const e = logEdit_.value
  if (!e.title?.trim()) {
    showToast('标题不能为空', 'error')
    return
  }
  try {
    if (logCompleting.value) {
      // ⚠ 原来是 `parseInt(...) || 7` —— 用户填 0（永不清理）会被 `||` 吃成 7，
      //    「0=永不」这个标注过的选项根本落不了地（2026-09-29 用户第 6 条顺手修）。
      const parsed = parseInt(logRetainDays.value, 10)
      const rd = Number.isNaN(parsed) || parsed < 0 ? logRetainDefault.value : parsed
      const result = await window.tegula.logsComplete(e.id, rd, logNote.value || undefined)
      if (result.ok) {
        showToast(rd > 0 ? `已标记完成（保留 ${rd} 天）` : '已标记完成（永不清理）', 'success')
      } else {
        showToast(`完成失败：${result.error || '未知原因'}`, 'error')
        return
      }
    } else if (logArchiveMode.value) {
      const result = await window.tegula.logsArchive(e.id, logNote.value || undefined)
      if (result.ok) {
        showToast('已归档', 'success')
      } else {
        showToast(`归档失败：${result.error || '未知原因'}`, 'error')
        return
      }
    } else if (e.id) {
      // 2026-09-22：此前只回写 title/content/nextSteps —— 在界面上改了「项目」或
      // 「关联任务」点保存会提示"已更新"，但字段被静默丢弃（用户报障「改不了项目」）。
      // 2026-09-23：补上 sessionId/agentName/logDate 三个新字段。
      const r: any = await window.tegula.logsUpdate(e.id, {
        title: e.title,
        content: e.content,
        nextSteps: e.nextSteps,
        project: e.project,
        taskIds: normalizeLogTaskIds(e),
        sessionId: e.sessionId || '',
        agentName: e.agentName || '',
        prevAgentName: e.prevAgentName || '',
        logDate: e.logDate || '',
      })
      if (r && !r.ok) {
        showToast(`更新失败：${r.error || '未知原因'}`, 'error')
        return
      }
      showToast('已更新', 'success')
    } else {
      // 2026-09-30 用户第 1 条（卡 task-20260930-002）：创建分支此前**漏传 nextSteps** ——
      // 对话框里填的「下一步」保存后静默丢失（更新分支一直有传，只有新建没有）。
      const r: any = await window.tegula.logsCreate(
        e.title, e.project, e.content, (e.taskIds || [])[0] || undefined,
        { sessionId: e.sessionId || '', agentName: e.agentName || '', prevAgentName: e.prevAgentName || '', logDate: e.logDate || '', taskIds: normalizeLogTaskIds(e), nextSteps: e.nextSteps || '' },
      )
      if (r && !r.ok) {
        showToast(`创建失败：${r.error || '未知原因'}`, 'error')
        return
      }
      showToast('已创建', 'success')
    }
    logEdit_.value = null
    logCompleting.value = false
    logArchiveMode.value = false
    logSnapFields = null
    logDiscard_.value = false
    await loadLogs()
  } catch (err: any) {
    showToast(`保存失败: ${err.message || err}`, 'error')
  }
}

function completeLogItem(id: string) {
  const log = logs.value.find(l => l.id === id)
  if (!log) return
  logEdit_.value = { ...log }
  logCompleting.value = true
  logArchiveMode.value = false
  logRetainDays.value = String(logRetainDefault.value)
  logNote.value = ''
  logBatchMode.value = false
  markLogSnap()   // P0-1：只填「备注」也要算改动，别静默丢
}

function archiveLogItem(id: string) {
  const log = logs.value.find(l => l.id === id)
  if (!log) return
  logEdit_.value = { ...log }
  logCompleting.value = false
  logArchiveMode.value = true
  logRetainDays.value = String(logRetainDefault.value)
  logNote.value = ''
  logBatchMode.value = false
  markLogSnap()
}

/**
 * 撤销「完成 / 归档」，退回**待处理**（2026-09-28 用户第 2 条重新定位）。
 *
 * 用户要的是"误操作能撤"：以前这个按钮叫「▶ 进行中」，撤销的同时顺手把你标成进行中，
 * 于是撤销一个误点的「完成」反而多出一个「进行中」—— 撤销本身变成了新的意外。
 * 现在撤销只回到待处理；要不再要「进行中」由 `toggleLogRunning` 那只开关决定。
 */
async function reopenLogItem(id: string) {
  const r: any = await window.tegula.logsReopen(id)
  if (r && r.ok) {
    showToast('已撤销，回到「待处理」', 'success')
    await loadLogs()
  } else {
    showToast(`撤销失败：${(r && r.error) || '未知原因'}`, 'error')
  }
}

async function destroyLogItem(id: string) {
  if (!confirm('确定销毁此日志？文件将被永久删除。')) return
  const result = await window.tegula.logsDestroy(id)
  if (result.ok) {
    showToast('已销毁', 'success')
    await loadLogs()
  } else {
    showToast(`销毁失败：${result.error || '未知原因'}`, 'error')
  }
}

/**
 * 回车 = 立即搜（平时边打边搜，见下面的 watcher）。2026-10-01 用户第 3 条：
 * 原来这里**只有**这一条路 —— 打完字没反应必须按回车，像是卡住；
 * 而且它另调 logs:search，绕开了 loadLogs 的筛选，一刷新搜索结果就没了。
 * 现在两件事合流：搜索词进 loadLogs 的 filter，只有一条取数路径。
 */
let logSearchTimer: ReturnType<typeof setTimeout> | null = null
async function executeLogSearch() {
  if (logSearchTimer) { clearTimeout(logSearchTimer); logSearchTimer = null }
  await loadLogs()
}

// 边打边搜（300ms 防抖）：日志是高频场景，关键词通常几秒钟就敲完，
// 让它像所有搜索框一样即时生效；回车仍可强制立即执行。
watch(logSearchInput, () => {
  if (logSearchTimer) clearTimeout(logSearchTimer)
  logSearchTimer = setTimeout(() => {
    logSearchTimer = null
    loadLogs()
  }, 300)
})

/**
 * 把一条日志复制成可直接粘给 agent 的提示词块。
 * 后端 `logs:inject`（返回"上次执行日志"格式的文本）早就写好并注册了通道，
 * 但界面从来没有入口 —— 而"日志 → 提示词"正是方寸定位里的核心动作。
 */
// ── 日志 / 待办右键菜单（2026-09-26 卡 037）──────────────────────────────
// 用户给的规格铁律：菜单是「出口加速器」，只放**已实际发生**的流的快捷方式；
// 一层封顶、单项 ≤7；删除放最末且二次确认；「发给 AI / 智能总结」永不进菜单（元层铁律）。
const ctxOther = ref<{ x: number; y: number; kind: 'log' | 'todo'; item: any } | null>(null)

function openLogMenu(e: MouseEvent, log: any): void {
  ctxOther.value = { x: e.clientX, y: e.clientY, kind: 'log', item: log }
}
function openTodoMenu(e: MouseEvent, todo: any): void {
  ctxOther.value = { x: e.clientX, y: e.clientY, kind: 'todo', item: todo }
}
function closeOtherMenu(): void { ctxOther.value = null }
function ctxOtherRun(fn: (item: any) => void): void {
  const c = ctxOther.value
  closeOtherMenu()
  if (c) fn(c.item)
}

/** 日志正文（标题 + 执行内容 + 下一步）——「复制全文」用 */
function logFullText(log: any): string {
  const parts = [String(log.title || '')]
  if (log.content) parts.push(String(log.content))
  if (log.nextSteps) parts.push('## 下一步\n' + String(log.nextSteps))
  return parts.filter(Boolean).join('\n\n')
}

/** 带元信息：`[日期] [项目] 标题` + 正文 —— 粘进开发日志/派工卡不用手动补头（用户原话） */
function logMetaText(log: any): string {
  const date = (log.logDate || log.created || '').slice(0, 10) || '—'
  const proj = log.project ? `[${log.project}]` : '[无项目]'
  return `[${date}] ${proj} ${String(log.title || '')}\n\n${logFullText(log)}`
}

async function copyLogFull(log: any): Promise<void> {
  await copyWithToast(logFullText(log), '已复制全文')
}

async function copyLogMeta(log: any): Promise<void> {
  await copyWithToast(logMetaText(log), '已复制（带日期 + 项目标签）')
}

/**
 * 复制并标记已派（用户原话：「复制→粘给 agent→这条其实已派出去了」两步并一步）。
 *
 * 2026-09-28 调整：「已派」= 这条**正在跑**，所以走的是手动开「进行中」那条路
 * （`logs:setRunning`）。以前走 `logs:reopen`（把状态改成 active）—— 那时 active 就等于
 * 进行中；现在 active 是「待处理」，再走老通道会变成"复制一下，反而标记成没在跑"。
 */
async function copyAndDispatchLog(log: any): Promise<void> {
  const ok = await copyWithToast(logMetaText(log), '已复制并标记已派（这条已置为「进行中」）')
  if (!ok) return
  if (log.running) return
  const r: any = await window.tegula.logsSetRunning(log.id, true)
  if (r && r.ok) await loadLogs()
  else showToast(`已复制，但标记「进行中」失败：${(r && r.error) || '未知原因'}`, 'error')
}

async function toggleLogPin(log: any): Promise<void> {
  const t: any = window.tegula
  if (typeof t.logsSetPinned !== 'function') { showToast('当前主进程是旧版本，没有置顶通道 —— 托盘右键「退出」后重开', 'error'); return }
  const r: any = await t.logsSetPinned(log.id, !log.pinned)
  if (r && r.ok) {
    showToast(log.pinned ? '已取消置顶' : '已置顶', 'success')
    await loadLogs()
  } else {
    showToast(`置顶失败：${(r && r.error) || '未知原因'}`, 'error')
  }
}

/** 改项目归属：不进编辑页，顺手改（用户原话）。
 *  ⚠ 刻意**不用 window.prompt** —— Electron 不实现它（仓里有静态守卫钉着这条），
 *  改成应用内轻浮层选项目，一层点完，比 prompt 还顺手。 */
const logProjectPicker = ref<any>(null)

function changeLogProject(log: any): void {
  const t: any = window.tegula
  if (typeof t.logsSetProject !== 'function') { showToast('当前主进程是旧版本，没有改归属通道', 'error'); return }
  logProjectPicker.value = log
}

async function applyLogProject(projectId: string): Promise<void> {
  const log = logProjectPicker.value
  if (!log) return
  logProjectPicker.value = null
  const r: any = await window.tegula.logsSetProject(log.id, String(projectId || '').trim())
  if (r && r.ok) {
    showToast(projectId ? `已改归属：${projectId}` : '已清空归属', 'success')
    await loadLogs()
  } else {
    showToast(`改归属失败：${(r && r.error) || '未知原因'}`, 'error')
  }
}

/** 菜单里的归档/删除复用既有入口（归档要填保留天数，删除自带二次确认） */
function runArchiveLog(log: any): void { archiveLogItem(log.id) }
function runDestroyLog(log: any): void { destroyLogItem(log.id) }

async function toggleTodoPin(todo: any): Promise<void> {
  const t: any = window.tegula
  if (typeof t.todosSetPinned !== 'function') { showToast('当前主进程是旧版本，没有置顶通道', 'error'); return }
  const r: any = await t.todosSetPinned(todo.id, !todo.pinned)
  if (r && r.ok) {
    showToast(todo.pinned ? '已取消置顶' : '已置顶', 'success')
    await loadTodos()
  } else {
    showToast(`置顶失败：${(r && r.error) || '未知原因'}`, 'error')
  }
}

async function copyTodoText(todo: any): Promise<void> {
  await copyWithToast(String(todo.title || ''), '已复制待办内容')
}

function editTodoFromMenu(todo: any): void { openTodoEditor(todo) }

async function deleteTodoFromMenu(todo: any): Promise<void> {
  if (!confirm(`删除待办「${todo.title}」？\n\n待办是随手记的清单，删掉不进回收站。`)) return
  await deleteTodo(todo.id)
}

async function copyLogAsPrompt(id: string): Promise<void> {
  try {
    const text: any = await window.tegula.logsInject(id)
    if (!text) {
      showToast('这条日志注入不了（可能已被销毁或归档）', 'error')
      return
    }
    // 留痕：日志里能查到「点了哪条、走了哪条复制通道」（渲染层 console 会转发进应用日志）
    console.warn('[renderer:copy] logs:inject id=' + id + ' len=' + String(text).length)
    const copied = await copyWithToast(String(text), '已复制为提示词，可直接粘给 agent')
    if (!copied) return
  } catch (e: any) {
    showToast('复制失败：' + (e?.message || e), 'error')
  }
}

async function executeLogCleanup() {
  try {
    const result = await window.tegula.logsCleanup()
    const n = Array.isArray(result) ? result.length : 0
    if (n) {
      showToast(`已将 ${n} 条超期日志标为「已归档」（仅改状态，文件未删）`, 'success')
    } else {
      showToast('没有超期日志：需先点「完成」并填保留天数，到期后才会被清理', 'info')
    }
    await loadLogs()
  } catch (e: any) {
    showToast('清理失败：' + (e?.message || e), 'error')
  }
}

// ── Review ─────────────────────────────────────────────────────────

const reviewReason = ref('')

function openReview(t: Task) {
  reviewModal.value = { id: t.id, title: t.title || t.id }
  reviewReason.value = ''
  previewTask.value = null
}

async function acceptTask() {
  if (!reviewModal.value) return
  // 2026-09-25（用户第 7 条）：通过也带上结论 → 主进程写入结果记录留痕
  const result = await window.tegula.reviewAccept(reviewModal.value.id, reviewReason.value)
  if (result.ok) {
    showToast('已通过', 'success')
    reviewModal.value = null
    loadAll()
  } else {
    showToast(result.error || '操作失败', 'error')
  }
}

async function rejectTask() {
  if (!reviewModal.value) return
  if (!reviewReason.value.trim()) {
    showToast('驳回理由必填', 'error')
    return
  }
  const result = await window.tegula.reviewReject(reviewModal.value.id, reviewReason.value)
  if (result.ok) {
    showToast('已驳回', 'success')
    reviewModal.value = null
    loadAll()
  } else {
    showToast(result.error || '操作失败', 'error')
  }
}

// ── Drag and drop ───────────────────────────────────────────────────────

function onDragStart(e: DragEvent, id: string) {
  draggingId.value = id
  // 拖拽一开始就把悬停浮层收掉：否则它会挂在屏幕上跟着拖（浮层只在 hover 里生成，
  // 但拖拽期间鼠标会离开卡、也可能不触发 mouseleave，干脆在这里主动清一次）
  onCardLeave()
  e.dataTransfer?.setData('text/plain', id)
  // 1x1 透明像素作为拖拽图像，消除系统默认的半透明"分身"幻影
  const img = new Image()
  img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setDragImage(img, 0, 0)
  }
}

function onDragOver(e: DragEvent, status: string) {
  dragoverCol.value = status
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move'
  }
}

async function onDrop(e: DragEvent, status: string) {
  e.preventDefault()
  const id = draggingId.value || e.dataTransfer?.getData('text/plain')
  if (id) {
    try {
      const result = await window.tegula.moveStatus(id, status)
      if (result.ok) {
        showToast(`已移动到「${status}」`, 'success')
      } else {
        showToast(`移动失败: ${result.error || '未知错误'}`, 'error')
      }
    } catch (err) {
      showToast(`移动失败: ${err}`, 'error')
    }
  }
  draggingId.value = null
  dragoverCol.value = null
  loadAll()
}

// ── Batch mode ──────────────────────────────────────────────────────────

function toggleBatchMode() {
  batchMode.value = !batchMode.value
  if (!batchMode.value) selectedBatch.value = []
}

function toggleBatchSelect(id: string) {
  const idx = selectedBatch.value.indexOf(id)
  if (idx >= 0) selectedBatch.value.splice(idx, 1)
  else selectedBatch.value.push(id)
}

function toggleSelectAll() {
  if (selectedBatch.value.length === filteredTasks.value.length) {
    selectedBatch.value = []
  } else {
    selectedBatch.value = filteredTasks.value.map(t => t.id)
  }
}

// ── Project view ────────────────────────────────────────────────────────

function openProject(p: any) {
  curProj.value = p.id
  navigateTo('active')
}

function openProjectInSettings(p: Project) {
  curProj.value = p.id
  navigateTo('active')
  showToast(`已切换项目：${p.name || p.id}`, 'info')
}

/**
 * 新建项目：真正写入 registry.yaml。
 * 此前是 `prompt('项目名称：')` + "项目添加功能开发中" —— 双重不可用：
 * prompt 在 Electron 里直接抛错（连提示都弹不出来），而且功能本来就没实现。
 */
function openNewProject() {
  projForm.value = { id: '', name: '', repo: '', description: '' }
  projGuard.open(projForm.value)
}

async function confirmNewProject() {
  const f = projForm.value
  if (!f || projCreating.value) return
  if (!f.id.trim()) {
    showToast('项目 ID 不能为空', 'error')
    return
  }
  projCreating.value = true
  try {
    const r: any = await window.tegula.registryAddProject({
      id: f.id.trim(),
      name: f.name.trim() || f.id.trim(),
      repo: f.repo.trim(),
      description: f.description.trim(),
    })
    if (r && r.ok) {
      showToast('项目已登记到 registry.yaml', 'success')
      projForm.value = null
      await loadAll()
    } else {
      showToast('登记失败：' + ((r && r.error) || '未知错误'), 'error')
    }
  } catch (e: any) {
    showToast('登记失败：' + (e?.message || '未知错误'), 'error')
  } finally {
    projCreating.value = false
  }
}

// ── Launchpad ─────────────────────────────────────────────────────────

function openAddApp() {
  editApp_.value = { name: '', path: '', description: '', argsText: '', isNew: true }
  appGuard.open(editApp_.value)
}

function openEditApp(app: any) {
  editApp_.value = { ...app, argsText: Array.isArray(app.args) ? app.args.join(' ') : '', isNew: false }
  appGuard.open(editApp_.value)
}

async function saveEditApp() {
  const e = editApp_.value
  if (!e.name || !e.path) {
    showToast('名称和路径必填', 'error')
    return
  }
  // 路径直接进 cmd（执行器按扩展名分派）；参数可选
  const args = String(e.argsText || '').trim()
    ? String(e.argsText).trim().split(/\s+/).filter(Boolean)
    : undefined
  const app = { name: e.name, path: e.path, cmd: e.path, args, description: e.description }
  if (e.isNew) {
    await window.tegula.launchpadAddApp(app)
  } else {
    await window.tegula.launchpadUpdateApp(e.id, app)
  }
  editApp_.value = null
  showToast(e.isNew ? '已添加' : '已更新', 'success')
  loadLaunchpad()
}

async function removeApp(id: string) {
  if (!confirm('确定删除？')) return
  await window.tegula.launchpadRemoveApp(id)
  editApp_.value = null
  showToast('已删除', 'success')
  loadLaunchpad()
}

async function browseAppPath() {
  const result = await window.tegula.browseFile()
  if (result) {
    editApp_.value.path = result
  }
}

function openConfigPath() {
  window.tegula.launchpadOpenFolder(launchpadConfigPath.value)
}

function refreshApps() {
  loadLaunchpad()
  showToast('已刷新', 'info')
}

async function launchAppClick(app: any) {
  const t: any = (window as any).tegula || {}
  // 先落一条「渲染层点了启动」的痕迹再调主进程。
  // 理由：2026-09-25 用户报「启动台依旧报错」，但日志里**一条 launchpad 记录都没有** ——
  // 分不清是"没点"还是"点了但主进程没收到/主进程是旧代码"。这条线一写，两种情况立刻可分。
  try {
    await t.applogWrite?.('INFO', 'launchpad-ui', `点击启动：${app?.name || app?.id || '(未知)'}`,
      JSON.stringify({ cmd: app?.cmd, path: app?.path, hasLaunchApi: typeof t.launchpadLaunchApp === 'function' }))
  } catch { /* 日志写不进去也不能挡住启动 */ }

  if (typeof t.launchpadLaunchApp !== 'function') {
    const msg = '当前运行的主进程/预加载是旧版本，没有启动台接口 —— 请托盘右键「退出」后重新启动'
    showToast(msg, 'error')
    appErrors.value.push({ scope: 'launchpad', message: msg, at: Date.now() })
    return
  }
  try {
    // app 是 v-for 出来的 Vue 响应式代理 —— 必须去代理后才能过 contextBridge，
      // 否则在渲染层就抛 "An object could not be cloned."，主进程完全收不到（见 shared/plain.ts）
      const result = await window.tegula.launchpadLaunchApp(toPlain(app))
    showToast(result.message, result.ok ? 'success' : 'error')
    if (!result.ok) {
      // 失败把「启动了什么」也带上，并留一条错误条 + 日志可查
      appErrors.value.push({
        scope: 'launchpad',
        message: `启动「${app.name}」失败：${result.message}（命令：${app.cmd || app.path}）`,
        at: Date.now(),
      })
    }
  } catch (e: any) {
    const msg = `启动「${app.name}」失败：${e?.message || e}（命令：${app.cmd || app.path}）`
    showToast(msg, 'error')
    appErrors.value.push({ scope: 'launchpad', message: msg, at: Date.now() })
  }
}

// ── Settings / Backup ──────────────────────────────────────────────────

// ── 版本与更新（2026-09-22 用户第 2 条：设置里看不到版本，也没有检查更新）──
// updater IPC（update:check / download / quitAndInstall）一直都在（updater.ts），
// 只是渲染层从未消费。这里补上 UI 消费：当前版本 + 检查更新 + 下载 + 安装。
const appVersion = ref('')
const updateState = ref<{ checked: boolean; busy: boolean; available: boolean; downloaded: boolean; version: string; msg: string }>({
  checked: false, busy: false, available: false, downloaded: false, version: '', msg: '',
})

async function loadAppVersion(): Promise<void> {
  try {
    const v = await (window as any).tegula.getAppVersion()
    appVersion.value = String(v || '')
  } catch { appVersion.value = '' }
}

async function checkUpdate(): Promise<void> {
  const t: any = (window as any).tegula || {}
  updateState.value.busy = true
  updateState.value.checked = false
  updateState.value.msg = '检查中…'
  try {
    await t.updateCheck()
    // 结果经 onUpdateAvailable / onUpdateNotAvailable 事件回调（见 onMounted 订阅）
    // 2026-09-23（用户第 5 条）：检查完成后给明确反馈，不再静默
  } catch (e: any) {
    updateState.value.msg = '检查失败：' + (e?.message || e)
    updateState.value.checked = true
    updateState.value.busy = false
    showToast('检查失败：' + (e?.message || e), 'error')
  }
}

async function downloadUpdate(): Promise<void> {
  const t: any = (window as any).tegula || {}
  updateState.value.busy = true
  try {
    await t.updateDownload()
    updateState.value.msg = '下载中…（进度见通知）'
  } catch (e: any) {
    updateState.value.msg = '下载失败：' + (e?.message || e)
  } finally {
    updateState.value.busy = false
  }
}

function installUpdate(): void {
  const t: any = (window as any).tegula || {}
  try { t.updateQuitAndInstall() } catch { /* ignore */ }
}

function showSettings() {
  loadPolicyMap()
  showSettings_.value = true
  // 打开设置时同步备份配置与历史
  bkMsg.value = ''
  bkLoadConfig()
  bkLoadList()
  bkRefreshStatus()
}

async function triggerBackup() {
  if (bkBusy.value) return
  bkBusy.value = true
  try {
    // 走新的备份链路：零依赖 zip 打包 → 自校验 → 本地 → WebDAV → 核对
    const r = await window.tegula.backupRun()
    const res = r.result
    if (r.ok && res) {
      backupInfo.value = { path: res.localPath, sizeKB: Math.round(res.localBytes / 1024) }
      const cloud = res.remotePath ? ' · 已上云' : (res.warnings && res.warnings.length ? ' · 仅本地' : '')
      showToast(`备份成功 · ${res.files} 个文件 · ${(res.rawBytes / 1024).toFixed(0)} KB${cloud}`, 'success')
    } else {
      const first = (res && res.errors && res.errors[0]) || r.error || '未知错误'
      showToast('备份失败：' + first, 'error')
    }
    await bkLoadList()
    await bkRefreshStatus()
  } finally {
    bkBusy.value = false
  }
}

/**
 * 打开「最近一次备份」所在目录。
 * 2026-09-22：这个函数此前**定义了但没有任何入口**（死代码）—— 已接到备份区按钮上。
 * 顺带把原来只认 `\` 的切分改成跨平台（用正则去掉最后一段路径）。
 */
async function openBackupFolder(): Promise<void> {
  const p = backupInfo.value?.path
  if (!p) { await bkOpenDir(); return }
  const dir = p.replace(/[\\/][^\\/]*$/, '')
  const r: any = await window.tegula.launchpadOpenFolder(dir)
  if (r && r.ok === false) bkMsg.value = '打开目录失败：' + (r.error || '')
}

function showBackup() {
  triggerBackup()
}

function exportTasksToFile() {
  window.tegula.exportTasks().then((result: any) => {
    if (result.ok && result.data) {
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `fangcun-tasks-${Date.now()}.json`
      a.click()
      URL.revokeObjectURL(url)
      showToast(`已导出 ${result.count} 个任务`, 'success')
    } else {
      showToast('导出失败', 'error')
    }
  })
}

function importTasksFromFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = (e: any) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev: any) => {
      try {
        const data = JSON.parse(ev.target.result)
        if (!Array.isArray(data)) { showToast('格式错误：需要 JSON 数组', 'error'); return }
        window.tegula.importTasks(data).then((res: any) => {
          if (res.ok) { showToast(`已导入 ${res.imported} 个任务`, 'success'); loadAll() }
          else showToast('导入失败', 'error')
        })
      } catch { showToast('JSON 解析失败', 'error') }
    }
    reader.readAsText(file)
  }
  input.click()
}


// ── Toast ───────────────────────────────────────────────────────────────

function showToast(msg: string, type: 'success' | 'error' | 'info' = 'info') {
  toast.msg = msg
  toast.type = type
  toast.show = true
  setTimeout(() => { toast.show = false }, 2000)
}

// ── 应用日志 / 错误出口（2026-09-22，用户第 8 条）────────────────────────
// 此前任何失败（启动台启动失败、导入失败、脚本异常）界面上只有一句干巴巴的
// 提示，终端里什么都没有。现在：全局异常 → main.ts 上报 → 主进程落盘
// （userData/logs/fangcun-YYYYMMDD.log）→ 这里给可见的错误条与日志抽屉。
const appErrors = ref<Array<{ scope: string; message: string; at: number }>>([])
const appErrOpen = ref(false)
const appLogFile = ref('')
const appLogTail = ref<string[]>([])

/** 接收 main.ts 广播；3 秒内完全相同的错误只留一条，避免刷屏 */
function onAppError(e: Event): void {
  const d = (e as CustomEvent).detail || {}
  const message = String(d.message || '')
  if (!message) return
  const last = appErrors.value[appErrors.value.length - 1]
  if (last && last.message === message && Date.now() - last.at < 3000) return
  appErrors.value.push({ scope: String(d.scope || 'error'), message, at: Date.now() })
  if (appErrors.value.length > 30) appErrors.value.shift()
}

async function loadAppLogPath(): Promise<void> {
  try { appLogFile.value = await window.tegula.applogPath() } catch { appLogFile.value = '' }
}

async function toggleAppLogPanel(): Promise<void> {
  appErrOpen.value = !appErrOpen.value
  if (!appErrOpen.value) return
  await loadAppLogPath()
  try { appLogTail.value = await window.tegula.applogTail(200) } catch { appLogTail.value = [] }
}

async function openAppLogDir(): Promise<void> {
  const t: any = (window as any).tegula || {}
  // 主进程/preload 是启动时读进内存的：开发态改了主进程但没重启 Electron 时，
  // 这个接口根本不存在 —— 原来只会抛 TypeError 被吞成一句无信息量的「打开日志目录失败」。
  if (typeof t.applogOpenDir !== 'function') {
    showToast('当前运行的主进程/预加载还是旧版本，没有日志接口 —— 请托盘右键「退出」后重新启动', 'error')
    return
  }
  try {
    const r: any = await t.applogOpenDir()
    if (r && r.ok === false) {
      showToast(`打开日志目录失败：${r.error || '未知原因'}（路径 ${r.dir || appLogFile.value || '未知'}）`, 'error')
    } else if (r && r.dir) {
      appLogFile.value = r.dir
    }
  } catch (e: any) {
    showToast('打开日志目录失败：' + (e?.message || e), 'error')
  }
}

/**
 * 运行期新鲜度自检（2026-09-22）。
 *
 * 开发态只有**渲染层**走 vite 热更；主进程与 preload 是启动时读进内存的。
 * 于是会出现最坑的一种状态：界面是新代码、通道是旧代码 ——
 * 新按钮看得见，一点就报莫名其妙的错（本例：`applogOpenDir` 未定义 → "打开日志目录失败"）。
 * 这里主动探测并把它翻成一句人话，省得再花一轮排查"改了没用"。
 */
async function checkRuntimeFreshness(): Promise<void> {
  const t: any = (window as any).tegula || {}
  const need = ['applogWrite', 'applogPath', 'applogOpenDir', 'applogTail', 'todosCreate', 'todosHealth', 'logsUpdate', 'logsReopen', 'logsSetRunning', 'launchpadLaunchApp', 'trashList', 'trashRestore', 'trashPurge', 'skillsList', 'skillsOpenDir', 'skillsImported', 'skillsImportPick', 'skillsImport', 'skillsRemove',
    'servicesList', 'servicesAdd', 'servicesRemove', 'servicesOpen', 'servicesAdopt']
  const missing = need.filter(k => typeof t[k] !== 'function')
  if (missing.length) {
    pushRuntimeStale(`preload 未暴露新接口：${missing.join('、')}`)
    return
  }
  try {
    const p = await t.applogPath()
    if (!p) pushRuntimeStale('主进程未返回日志路径')
  } catch (e: any) {
    pushRuntimeStale('主进程未注册 applog 通道（' + (e?.message || e) + '）')
  }
}

function pushRuntimeStale(why: string): void {
  if (appErrors.value.some(e => e.scope === 'runtime-stale')) return
  appErrors.value.push({
    scope: 'runtime-stale',
    message: `运行中的 Electron 主进程/预加载是旧代码（${why}）—— 请用**托盘右键「退出」**彻底关掉再重启 npm run dev。关窗只是隐藏窗口，不会重启进程；开发态的渲染层会热更，主进程不会`,
    at: Date.now(),
  })
}

async function copyAppLogPath(): Promise<void> {
  await copyWithToast(appLogFile.value || '', '日志路径已复制')
}

/** 从设置里看日志：先关设置，再展开抽屉（抽屉在模态之下，否则被遮住） */
async function showAppLogFromSettings(): Promise<void> {
  showSettings_.value = false
  if (!appErrOpen.value) await toggleAppLogPanel()
}

// ── Mount ───────────────────────────────────────────────────────────────

async function checkFirstRun() {
  try {
    const first = await window.tegula.isFirstRun()
    if (first) {
      showWizard.value = true
      wizardDataDir.value = await window.tegula.getDataDir()
    }
  } catch { /* ignore */ }
}

async function browseWizardDir() {
  const result = await window.tegula.browseDirectory()
  if (result) wizardDataDir.value = result
}

async function browsePythonDir() {
  const result = await window.tegula.browseDirectory()
  if (result) wizardPythonDir.value = result
}

function wizardNext() {
  if (wizardStep.value < wizardSteps.length - 1) wizardStep.value++
}

async function wizardFinish() {
  wizardFinishing.value = true
  try {
    if (wizardInitMode.value === 'fresh') {
      await window.tegula.createFreshSetup(wizardDataDir.value)
    } else {
      await window.tegula.createFreshSetup(wizardDataDir.value)
      await window.tegula.importFromPythonTegula(wizardDataDir.value, wizardPythonDir.value)
    }
    showWizard.value = false
    loadAll()
  } catch (e: any) {
    showToast('初始化失败: ' + (e.message || e), 'error')
  } finally {
    wizardFinishing.value = false
  }
}

onMounted(() => {
  checkFirstRun()
  loadTaskMeta()
  loadAll()
  // 014：与主进程 prefs.json 对齐 Agent 预设（localStorage 只当缓存，换 origin 不该丢资产）
  syncAgentPresets()
  // 板面偏好：分组方式 + 折叠状态（同样以主进程 prefs.json 为真身）
  // 卡 012：归档设置也在真身里 —— 要等它回来才知道该不该查超期/自动执行，所以走 then。
  void syncBoardPrefs().then(async () => {
    await refreshArchiveOverdue()
    if (archiveAuto.value && Number(archiveDays.value) > 0 && archiveOverdue.value.count > 0) {
      await runArchiveOverdue(true)   // 用户自己开的开关，不弹确认
    }
  })
  // 版本号（设置页首区块显示）
  loadAppVersion()
  // 更新事件订阅：updater 主进程回调 → 设置页状态更新
  const t: any = (window as any).tegula || {}
  if (typeof t.onUpdateAvailable === 'function') {
    t.onUpdateAvailable((d: any) => {
      updateState.value.checked = true
      updateState.value.available = true
      updateState.value.version = d?.version || ''
      updateState.value.msg = '发现新版本 v' + (d?.version || '?')
      updateState.value.busy = false
      showToast('发现新版本 v' + (d?.version || '?'), 'success')
    })
    t.onUpdateNotAvailable(() => {
      updateState.value.checked = true
      updateState.value.available = false
      updateState.value.msg = '已是最新版本'
      updateState.value.busy = false
      showToast('已是最新版本', 'info')
    })
    t.onUpdateProgress((d: any) => {
      updateState.value.msg = '下载中… ' + (d?.percent != null ? Math.round(d.percent) + '%' : '')
    })
    t.onUpdateDownloaded((d: any) => {
      updateState.value.downloaded = true
      updateState.value.msg = 'v' + (d?.version || '?') + ' 已就绪，退出时自动安装'
      // 012：窗口可见时也给个即时反馈（隐藏到托盘时由主进程的系统通知兜住）
      showToast('新版本 v' + (d?.version || '?') + ' 已下载完成，点「立即重启安装」升级', 'success')
    })
    t.onUpdateError((d: any) => {
      updateState.value.checked = true
      updateState.value.busy = false
      updateState.value.msg = '更新出错：' + (d?.message || '未知')
      showToast('更新出错：' + (d?.message || '未知'), 'error')
    })
  }
  // 备份状态全局订阅：顶栏指示灯随调度结果实时变化（失败会显红）
  bkInitBackup()
  ncInit()
  // 全局快捷键与通知无关，独立挂载 —— 挂进 ncInit() 会让「通知 IPC 缺失时快捷键也失效」
  document.addEventListener('keydown', onShortcutKeydown)
  // 渲染层错误出口（2026-09-22）：main.ts 的全局上报会广播到这里，
  // 界面上给一条可见的错误条 + 「打开日志」，不再让失败无声无息。
  window.addEventListener('fc-app-error', onAppError as EventListener)
  loadAppLogPath()
  checkRuntimeFreshness()
  // 拖拽计数兜底归零：**只对页面内自己拖的元素有效**（那时 dragend/drop 会落在 window 上）。
  // OS 文件拖拽（资源管理器拖进来）收场时这两个监听都收不到 —— 真正兜底的是 dragPulse 心跳。
  window.addEventListener('dragend', dragResetAll)
  window.addEventListener('drop', dragResetAll)
})

onUnmounted(() => {
  if (ncTimer) { clearInterval(ncTimer); ncTimer = null }
  if (dragTimer) { clearTimeout(dragTimer); dragTimer = null }
  if (cardTipTimer) { clearTimeout(cardTipTimer); cardTipTimer = null }
  document.removeEventListener('mousedown', onDocumentClick)
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('keydown', onShortcutKeydown)
  window.removeEventListener('fc-app-error', onAppError as EventListener)
  window.removeEventListener('dragend', dragResetAll)
  window.removeEventListener('drop', dragResetAll)
})
</script>

<style>
:root {
  /* 2026-09-27（用户：「不同颜色主题外观下文本可读性可能很差」）：全量对比度实测后按实测值调整。
     原来：白字压 --accent(#9b8fc4) = 2.95、强调色文字压浅底 = 2.59~2.95、--danger 白字 3.65、
     --muted 压浅底 4.28、--warning 白字 2.24 —— 全都在 WCAG AA（4.5）以下，观感就是「发灰、发虚」。
     调法：同色相压深一档（不换色相、不动 --accent-soft 这条雾感装饰色），
     让「做文字」和「当底色配白字」这两种用法同时过 4.5。实测见 e2e-a11y。 */
  color-scheme: light;   /* Windows 暗色外观下，原生控件/滚动条不再翻成深色与浅色界面打架 */
  --bg: #eef0f4;
  --ink: #3c4150;
  --muted: #626775;      /* 4.28 → 4.95（压 --bg） */
  --accent: #705fab;     /* 白字 2.95 → 5.37；做文字压 --bg 2.59 → 4.70 */
  --accent-soft: #c3bce0;
  --card: #ffffff;
  --border: #e4e2ee;
  --shadow: 0 8px 32px rgba(90,90,130,0.12);
  --radius: 18px;
  --success: #54814b;    /* 白字 3.71 → 4.55 */
  --warning: #986b20;    /* 白字 2.24 → 4.71 */
  --danger:  #b44141;    /* 白字 3.65 → 5.57 */
  /* 主题令牌（2026-09-29 用户第 4 条）：下面五个此前**散落在各处的写死十六进制**
     （hover 染色、面板底、次级描边、装饰光斑），主题只是把它们换成随主题变的令牌。
     默认值 = 原值，所以「雾灰紫（默认）」一个像素都不动。 */
  --tint: #f1eefb;      /* 选中 / 激活的浅染 */
  --tint-2: #fbfaff;    /* 悬停的更浅染 */
  --tint-3: #fafafd;    /* 中性面板底 */
  --line-2: #dcd8ee;    /* 次级描边 */
  --blob-a: #cfc6ec;    /* 装饰光斑上 */
  --blob-b: #cdd9ee;    /* 装饰光斑下 */
}

/* ── 主题（2026-09-29 用户第 4 条：「似乎多主题颜色外观并不存在…参考绒花墨坊做一下」）──
   做法照抄绒花墨坊 console/src/style.css：一套浅色主题只换令牌，挂在 <html data-theme="x">。
   墨坊那条硬规矩一并沿用：**只做浅色主题**（它注释里写着「仅浅色模式」）——
   方寸界面里有大量写死的白底（#fff 卡面/弹窗），做半吊子暗色 = 文字直接看不见。
   每套配色全部过 WCAG AA（正文 / 次要文字 / 白字压品牌色 ≥4.5，实测最低 5.0），
   守卫：scripts/test/check-themes.cjs（改配色不跑它 = 白改）。 */
:root[data-theme='pink'] {
  --bg: #fdf2f5;
  --ink: #411621;
  --muted: #8c5c64;
  --accent: #ac4657;
  --accent-soft: #eacad0;
  --border: #edd7dd;
  --tint: #f9f3f4;
  --tint-2: #fcf9fa;
  --tint-3: #fcfbfb;
  --line-2: #eacdd5;
  --blob-a: #eacad0;
  --blob-b: #eed3da;
}
:root[data-theme='blue'] {
  --bg: #eef4fb;
  --ink: #192a3e;
  --muted: #556984;
  --accent: #3668ab;
  --accent-soft: #c9d8eb;
  --border: #d7e1ed;
  --tint: #f3f6f9;
  --tint-2: #f9fafc;
  --tint-3: #fbfbfc;
  --line-2: #cddaea;
  --blob-a: #c9d8eb;
  --blob-b: #d3dfee;
}
:root[data-theme='green'] {
  --bg: #eff5f1;
  --ink: #233428;
  --muted: #4d6f5f;
  --accent: #377457;
  --accent-soft: #cde7db;
  --border: #dbe8df;
  --tint: #f3f9f6;
  --tint-2: #f9fcfa;
  --tint-3: #fbfcfb;
  --line-2: #d3e4d9;
  --blob-a: #cde7db;
  --blob-b: #d9e7de;
}
:root[data-theme='orange'] {
  --bg: #fdf6ec;
  --ink: #433014;
  --muted: #7c6650;
  --accent: #975c21;
  --accent-soft: #ebdac9;
  --border: #ede4d7;
  --tint: #f9f6f3;
  --tint-2: #fcfaf9;
  --tint-3: #fcfbfb;
  --line-2: #eadecd;
  --blob-a: #ebdac9;
  --blob-b: #eee3d3;
}
:root[data-theme='gray'] {
  --bg: #f4f4f6;
  --ink: #262631;
  --muted: #676872;
  --accent: #65687b;
  --accent-soft: #d6d7de;
  --border: #dfdfe5;
  --tint: #f5f5f7;
  --tint-2: #fafafb;
  --tint-3: #fbfbfc;
  --line-2: #d8d8df;
  --blob-a: #d6d7de;
  --blob-b: #dddde3;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  background: var(--bg);
  color: var(--ink);
  min-height: 100vh;
}

#app { display: flex; flex-direction: column; height: 100vh; }

/* ── 按钮基座（2026-09-22）──────────────────────────────────────────────
   .ghost / .pri / .ok / .danger / .warning 此前**只在特定祖先下**定义
   （`#bar button.ghost`、`.acts .pri`、`.lp-ctrls button.ghost` …）。
   于是待办 `.todos-ctrls`、日志 `.logs-ctrls`、日历 `.calhead` 里的按钮
   匹配不到任何规则 → 直接退化成 Chromium 默认按钮长相。用户反馈过两轮。
   这里补一组**与祖先无关**的兜底。用 `:where()` 把选择器特异性压到 (0,1,0)，
   且放在样式表最前面：任何已有的更具体/同特异性的规则都仍然覆盖它。
   配套守卫：scripts/test/check-button-styles.cjs（自动扫同类漏样式）。 */

/* ── 按钮尺寸规范（2026-09-29 卡 027，用户按小样拍板）──────────────────
   问题不是"某个按钮没样式"（那已被守卫兜住），而是**不成体系**：
   全站 9+ 种写法各写各的高宽圆角，同一条行里能出现三种高度、三种圆角。
   这里把「高度 / 圆角 / 字号 / 内距」收成一组变量，四类按钮共用：
     主(pri) 一屏 1 个 · 次(ghost) 绝大多数 · 危险(danger) 只给破坏性动作 · 图标(icon) 纯符号
   两档尺寸：工具行 28（默认）· 弹窗主按钮 32（.lg）· 密集列表 24（.sm）
   ⚠ **不改任何现有 class 名** —— 模板一行不动，只把这些 class 的长相统一。 */
:root {
  --btn-h: 28px;      /* 工具行 */
  --btn-h-lg: 32px;   /* 弹窗主按钮 */
  --btn-h-sm: 24px;   /* 密集列表（待办行尾那一串） */
  --btn-r: 8px;
  --btn-fs: 12px;
  --btn-px: 14px;
}
button { font-family: inherit; cursor: pointer; }
button[disabled] { opacity: .55; cursor: not-allowed; }
button:not([class]) {
  display: inline-flex; align-items: center; justify-content: center;
  height: var(--btn-h); padding: 0 var(--btn-px); border: 0; border-radius: var(--btn-r);
  font-size: var(--btn-fs); font-weight: 600; line-height: 1;
  background: var(--accent); color: #fff;
}
:where(button.ghost)   { display: inline-flex; align-items: center; justify-content: center;
                         height: var(--btn-h); padding: 0 var(--btn-px); border: 1px solid var(--border); border-radius: var(--btn-r);
                         font-size: var(--btn-fs); font-weight: 600; line-height: 1; background: #fff; color: var(--ink); }
:where(button.pri)     { display: inline-flex; align-items: center; justify-content: center;
                         height: var(--btn-h); padding: 0 var(--btn-px); border: 0; border-radius: var(--btn-r);
                         font-size: var(--btn-fs); font-weight: 600; line-height: 1;
                         background: var(--accent); color: #fff; }
:where(button.ok)      { display: inline-flex; align-items: center; justify-content: center;
                         height: var(--btn-h); padding: 0 var(--btn-px); border: 0; border-radius: var(--btn-r);
                         font-size: var(--btn-fs); font-weight: 600; line-height: 1;
                         background: var(--success); color: #fff; }
:where(button.warning) { display: inline-flex; align-items: center; justify-content: center;
                         height: var(--btn-h); padding: 0 var(--btn-px); border: 0; border-radius: var(--btn-r);
                         font-size: var(--btn-fs); font-weight: 600; line-height: 1;
                         background: var(--warning); color: #fff; }
:where(button.danger)  { display: inline-flex; align-items: center; justify-content: center;
                         height: var(--btn-h); padding: 0 var(--btn-px); border: 0; border-radius: var(--btn-r);
                         font-size: var(--btn-fs); font-weight: 600; line-height: 1;
                         background: var(--danger); color: #fff; }
:where(button.ghost):hover { background: var(--tint); border-color: var(--accent-soft); }
:where(button.pri):hover, :where(button.ok):hover,
:where(button.warning):hover, :where(button.danger):hover { filter: brightness(1.06); }
/* 第二档：弹窗里的主/次按钮大一号（32）—— 弹窗里动作更重，按钮更好点 */
.overlay .acts button.ghost, .overlay .acts button.pri, .overlay .acts button.ok,
.overlay .acts button.danger, .overlay .acts button.warning {
  height: var(--btn-h-lg); padding: 0 16px; font-size: 12.5px;
}

/* ── 控件交互反馈（2026-09-29 用户第 5 条：「控件交互可以强化，提高反馈体验」）────
   悬停反馈全站早就有了（.todo-item:hover / .log-card:hover / button:hover …），
   缺的是另外两种：**按下去没有物理反馈**（点了像没点，于是会再点一次 —— 
   2026-09-25 「点了没反应要多点几次」除了合成器问题，另一半是这个）
   和**键盘用户看不见焦点在哪**。三条一起补，且不改任何外观配色：
   ① 按压：下沉 1px + 轻微缩放（只在 :active 瞬间，不改变布局）
   ② 焦点：只在 :focus-visible 画圈 —— 鼠标点击不画，Tab 走查才画
   ③ 过渡：悬停/按压统一 80~120ms，不再有的快有的顿 */
button, select, textarea,
input[type='text'], input[type='date'], input[type='number'], input[type='search'], input[type='password'] {
  transition: background-color .12s ease, border-color .12s ease, box-shadow .12s ease,
              transform .08s ease, filter .12s ease, opacity .12s ease;
}
button { user-select: none; -webkit-user-select: none; }
button:active:not(:disabled) { transform: translateY(1px) scale(.98); }
:where(select, input[type='checkbox'], input[type='radio']):active { transform: translateY(1px); }
:where(button, select, input, textarea, .vbtn):focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--btn-r);
}
:where(input:not([type='checkbox']):not([type='radio']), textarea):focus {
  border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft);
}

/* 装饰光斑：**保留视觉，只改合成策略**（2026-09-25 用户第 4 条 + 第 1/3/9 条）。
   两个 460/420px 的元素挂着 blur(70px) —— 高斯模糊是最贵的栅格化操作之一，
   而它们是 position:fixed 常驻元素。加 will-change: transform 让 Chromium 把它
   提为独立合成层、把模糊结果**缓存成纹理**（只栅格化一次），
   不再随每次合成重新算。视觉像素级不变（改的是合成策略不是外观）。

   ⚠⚠ z-index: 0 → -1（2026-09-28 用户第 1 条）——**这是「怪异遮罩挡字」的真因**。
   `.blob` 是 position:fixed（已定位）且 z-index:0，而看板的 .col / 卡片全是**非定位的流内元素**。
   按 CSS 绘制顺序，同一个层叠上下文里：负 z-index 子层 → 流内块级背景 → 行内内容 → z-index:0/auto 的已定位元素。
   也就是说 z-index:0 的它**画在所有正文之上**（只被 z-index:2 的 #bar / #views 挡住）。
   而 .b1 是 460×460、top:-140 left:-100、紫色 #cfc6ec、opacity .38 ——
   正好糊在第一列卡片的文字上，还因为 pointer-events:none **点不掉、也不报错**。
   它在设计意图上就是"背景雾斑"，只是从来没被放进背景层。改成负 z-index 后它落在
   #app（透明背景）之下、body 画布背景之上 —— 雾感保留，一个字都不挡。
   守卫：e2e-renderer 里那条「光斑不得压住正文」的绘制顺序断言。 */
.blob { position: fixed; border-radius: 50%; filter: blur(70px); will-change: transform; opacity: 0.38; z-index: -1; pointer-events: none; }
.blob.b1 { width: 460px; height: 460px; background: var(--blob-a); top: -140px; left: -100px; }
.blob.b2 { width: 420px; height: 420px; background: var(--blob-b); bottom: -130px; right: -90px; }

#bar {
  position: relative; z-index: 2; padding: 10px 16px;
  /* 2026-09-25（用户第 1/3/9 条复发 + 第 4 条）：这里原来挂着 backdrop-filter: blur(14px)。
     上一轮只清了 .overlay / .nc-wrap，**漏了这条常驻顶栏** —— 它 100% 时间在屏，
     是当时遗留的最后一个实时模糊合成层（backdrop 采样必须每次合成重算）。
     两处一起改：
       ① 去掉 backdrop-filter（不再有模糊采样 → 不参与「失焦即停绘」）；
       ② 底色 0.72 → 0.92 —— 左上角 .blob.b1（#cfc6ec 紫，top:-140/left:-100）
          不再透过 28% 的半透明顶栏把标题与计数洗淡（第 4 条「有时候看不清文字」）。 */
  background: rgba(255,255,255,0.92);
  border-bottom: 1px solid var(--border); display: flex;
  justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;
}
#bar .title { font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 8px; }
/* 方形 LOGO（2026-09-25 第 12 条）：绒花墨坊有的可点标志，方寸此前没有 */
#bar .title .brand {
  flex: none; width: 22px; height: 22px; padding: 0; border-radius: 6px;
  background: var(--accent); color: #fff; font-size: 13px; font-weight: 700;
  line-height: 22px; text-align: center; cursor: pointer; border: 0; font-family: inherit;
}
#bar .title .brand:hover { filter: brightness(1.08); }
#bar .title small { color: var(--accent); font-weight: 600; margin-left: 6px; font-size: 13px; }
#bar .ctrls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
#bar select, #bar input {
  padding: 4px 8px; border: 1px solid var(--border); border-radius: 8px;
  font-size: 12px; background: #fff; color: var(--ink); outline: none; font-family: inherit;
}
#bar input.search { width: 140px; }
#bar button {
  cursor: pointer; padding: 4px 12px; border: 0; border-radius: 8px;
  font-size: 12px; font-weight: 600; background: var(--accent); color: #fff;
}
#bar button.ghost { background: #fff; color: var(--ink); border: 1px solid var(--border); }
#bar .chk { display: flex; align-items: center; gap: 3px; font-size: 11px; color: var(--muted); }

#views {
  position: relative; z-index: 2; padding: 6px 16px; display: flex; gap: 6px;
  background: rgba(255,255,255,0.5); border-bottom: 1px solid var(--border);
}
/* 错误条 / 日志抽屉（全局，任何页签都在） */
.errbar {
  position: relative; z-index: 3; display: flex; align-items: center; gap: 8px;
  padding: 6px 16px; background: #fdf3f3; border-bottom: 1px solid #e8c9c9;
  font-size: 12px; color: #8a4545;
}
.errbar-ico { flex: none; }
.errbar-msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.errbar-msg b { font-weight: 700; }
.errpanel {
  position: relative; z-index: 3; background: #fff; border-bottom: 1px solid var(--border);
  padding: 8px 16px 12px;
}
.errpanel-head { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--muted); margin-bottom: 6px; }
.errpanel-head code { background: var(--tint); padding: 1px 6px; border-radius: 4px; color: var(--ink); }
.errpanel-body {
  max-height: 240px; overflow: auto; background: #f7f7fa; border: 1px solid var(--border);
  border-radius: 8px; padding: 8px 10px; font-size: 11px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-all; color: #4a4f5c;
}
#views.batch-on { background: #fffdf5; border-bottom-color: #f0e8d0; }
.vbtn {
  font-size: 12px; cursor: pointer; padding: 4px 14px; border: 1px solid var(--border);
  border-radius: 999px; background: #fff; color: var(--muted); font-weight: 600;
}
.vbtn.on { background: var(--accent); color: #fff; border-color: var(--accent); }

/* ── 页头视图切换器（2026-09-28 多视图，用户第 ① 条 + 卡 033）───────────
   刻意**不塞进 #bar**：顶栏已经有 9 个控件，再排一组按钮只会更挤（用户原话「臃肿无比」）。
   分段控件的观感与看板"白卡浮在灰底上"一致：选中态 = 白底 + 1px 投影。
   右边那行 hint 说明"这个摆法擅长什么" —— 用户不必先点一遍才知道两个视图差在哪。 */
.pagehead {
  position: relative; z-index: 2;
  display: flex; align-items: center; gap: 12px;
  padding: 7px 16px; background: rgba(255,255,255,0.35);
  border-bottom: 1px solid var(--border);
}
.viewsw {
  display: inline-flex; gap: 2px; flex: none;
  background: #ecedf3; border: 1px solid var(--border); border-radius: 10px; padding: 2px;
}
button.vsb {
  border: 0; background: transparent; font-family: inherit; cursor: pointer;
  font-size: 12px; font-weight: 600; color: var(--muted);
  padding: 4px 12px; border-radius: 8px;
  transition: background 0.14s, color 0.14s;
}
button.vsb:hover { color: var(--ink); }
button.vsb.on { background: #fff; color: var(--ink); box-shadow: 0 1px 3px rgba(90,90,130,0.14); }
.pagehead-hint {
  font-size: 11.5px; color: var(--muted); min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ── 看板 · 列表视图（多视图第 1 项）────────────────────────────────────
   同一批 columns 换个摆法：列视图"横着摊开"（有流程感、可拖拽，但列多要横滚，
   一屏约 12 条），列表视图"竖着分区"（不横滚，一行 28px，一屏约 18 条）。
   ⚠ 折叠状态 / 拖拽改状态 / 批量选择 / 右键菜单 / 悬停轻提示 与列视图**完全共用** ——
     不存在"列表视图里少一个功能"，否则用户切一次就得重新学一遍。
   `#board` 是 flex 容器：两种摆法共用它才能保住 flex:1 + overflow 的滚动行为。 */
#board.list-mode {
  flex-direction: column; overflow-x: hidden; overflow-y: auto;
  align-items: stretch; gap: 0;
}
.board-list { display: flex; flex-direction: column; min-width: 0; }
.blgrp { border-radius: 10px; padding: 2px 6px 6px; border: 1px solid transparent; }
.blgrp.drop-here { border-color: var(--accent); background: var(--tint); }
.blgrp-head { display: flex; align-items: center; gap: 10px; margin: 8px 0 6px; }
.blgrp:first-child .blgrp-head { margin-top: 0; }
.blgrp-head .f1 { flex: 1; height: 1px; background: var(--border); }
button.lpill {
  display: inline-flex; align-items: center; gap: 6px; flex: none; cursor: pointer;
  font-family: inherit; font-size: 11.5px; font-weight: 700; color: var(--ink);
  background: #fff; border: 1px solid var(--border); border-radius: 999px;
  padding: 3px 11px 3px 9px;
}
button.lpill:hover { border-color: var(--accent-soft); background: var(--tint-2); }
.lpill .chev {
  flex: 0 0 auto; width: 0; height: 0;
  border-left: 5px solid #8b8b9e; border-top: 4px solid transparent; border-bottom: 4px solid transparent;
  transition: transform 0.15s ease;
}
.lpill .chev.open { transform: rotate(90deg); }
.lpill .gdot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: #9ca3af; }
.lpill .glabel { font-weight: 700; }
.lpill .gn { background: var(--accent-soft); color: #4a4368; border-radius: 999px; padding: 0 7px; font-size: 10.5px; font-weight: 600; }
.gdot-draft { background: #9ca3af; }
.gdot-review { background: #d9a44a; }
.gdot-todo { background: #9ca3af; }
.gdot-doing { background: #6366f1; }
.gdot-verify { background: #d9a44a; }
.gdot-done { background: #54814b; }
.gdot-reject { background: #b44141; }
.brow {
  display: flex; align-items: center; gap: 8px;
  background: #fff; border: 1px solid #e7e7ef; border-radius: 9px;
  padding: 4px 10px; margin-bottom: 4px;
  box-shadow: 0 1px 2px rgba(90,90,130,0.05); cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.brow:hover { background: var(--tint-2); border-color: var(--line-2); }
.brow.overdue { border-left: 3px solid var(--danger); }
.brow.stale { opacity: 0.55; }
.brow.stale:hover { opacity: 0.85; }
.brow.selected { outline: 2px solid var(--accent); outline-offset: 1px; background: var(--tint); }
.brow.dragging { opacity: 0.35; }
.brow .ttl { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 空分区在列表视图里**不画那个虚线空框**（列视图里它是有用的落点提示，纵向排时却会
   把一屏吃掉一大半 —— 「7 个状态里 4 个是空的」在这种数据下很常见）。
   列表视图的落点是**整个分区块**（hover 时 .blgrp 高亮），分区头右侧的 0 已经说明它是空的。 */
.board-list .emptyhint { display: none; }

#board {
  flex: 1; display: flex; gap: 12px; padding: 14px;
  align-items: flex-start; overflow-x: auto; min-height: 60vh;
}
#board.pv { flex-direction: column; overflow-x: hidden; align-items: stretch; }

/* 列 = 淡灰底，卡片 = 纯白（2026-09-28 密度方案 B / 对比稿①②④）。
   原来是反的（列白底 + 卡近白底），层次只能靠"每列一条 4px 左边色条 + 卡片边框 + 重阴影"堆出来，
   四列就是 4 条竖线起底，卡一多像栅栏 —— 用户原话「竖条好几条，越看越头痛」。
   现在层次靠"白卡浮在灰底上"：色条全删，列几乎无阴影，卡片 1px 贴地投影。
   ⚠ 那 7 条 .col[data-status=…] 的 border-left + 4 种底色已整块删除（状态由列头圆点承担）。 */
.col {
  background: #f3f4f8; border: 1px solid #e4e5ec; border-radius: 12px;
  min-width: 260px; padding: 8px; flex: 1;
}
.col.empty { border-style: dashed; opacity: 0.62; background: #f7f7fb; }
.col.dragover { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(112,95,171,0.18); background: var(--tint); }
/* 分组折叠（2026-09-25）：点标题折叠/展开；折叠后这列只占一行，长单子立刻变短 */
.col h3 { cursor: pointer; user-select: none; display: flex; align-items: center; gap: 6px; }
/* 三角用 CSS 边框画，不用 ▸/▾ 字形 —— 应用字体里这两个字符可能缺字，渲染成看不见的空白 */
.col h3 .chev {
  flex: 0 0 auto; width: 0; height: 0; margin-right: 2px;
  border-left: 5px solid #8b8b9e;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  transition: transform 0.15s ease;
}
.col h3 .chev.open { transform: rotate(90deg); }
.col.collapsed-col { flex: 0 0 auto; min-width: 190px; max-width: 280px; opacity: 0.9; }
.col.collapsed-col h3 { margin-bottom: 0; }

.status-label { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; }
.status-dot { width: 10px; height: 10px; border-radius: 50%; }
.col[data-status="进行中"] .status-dot { background: #6366f1; }
.col[data-status="待验收"] .status-dot { background: #f59e0b; }
.col[data-status="完成"] .status-dot { background: #10b981; }
.col[data-status="驳回"] .status-dot { background: #ef4444; }
.col[data-status="待办"] .status-dot { background: #9ca3af; }

.emptyhint { color: var(--muted); font-size: 11px; text-align: center; padding: 16px 0; border: 1px dashed var(--border); border-radius: 10px; margin-top: 2px; }

.col h3 {
  margin: 2px 0 8px; font-size: 12.5px; color: #565d6e; font-weight: 700;
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
}
.col h3 .n { background: #e6e7ee; color: #4b5162; border-radius: 999px; padding: 0 8px; font-size: 11px; font-weight: 600; }

/* 紧凑单行卡（2026-09-28 密度方案 B）：一行放完 —— 状态点 + 标题（超长省略）+ 右侧 meta。
   高度从约 48px 压到约 28px，正文摘要/标签移进悬停轻提示（见 .card-tip）。
   卡级染色（.active-t 的淡紫底 + 3px 左条）已删：状态由列位置承担，再染一遍是冗余编码。 */
.card {
  background: #fff; border: 1px solid #e7e7ef; border-radius: 9px;
  padding: 4px 9px; margin-bottom: 5px;
  box-shadow: 0 1px 2px rgba(90,90,130,0.05);
  cursor: pointer; transition: background 0.12s, border-color 0.12s, box-shadow 0.12s;
}
.card:hover { background: var(--tint-2); border-color: var(--line-2); box-shadow: 0 2px 8px rgba(90,90,130,0.10); }
/* 左边色条只留给"要注意的事"（逾期 / 阻塞）—— 其余状态不再染色 */
.card.overdue { border-left: 3px solid var(--danger); }
.card.stale { opacity: 0.55; }
.card.stale:hover { opacity: 0.85; }
.card.selected {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
  background: var(--tint);
  box-shadow: 0 2px 12px rgba(112,95,171,0.20);
}
.card.dragging { opacity: 0.35; transform: scale(0.97); }

.card-head { display: flex; align-items: center; gap: 6px; }
.card .ttl {
  flex: 1; min-width: 0;
  font-size: 12.5px; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 状态点：6px，替掉原来那 4px 竖条与整卡染色 */
.card-liv { flex: none; width: 6px; height: 6px; border-radius: 50%; background: #9ca3af; }
.card-liv.liv-draft { background: #9ca3af; }
.card-liv.liv-review { background: #d9a44a; }
.card-liv.liv-todo { background: #9ca3af; }
.card-liv.liv-doing { background: #6366f1; }
.card-liv.liv-verify { background: #d9a44a; }
.card-liv.liv-done { background: #54814b; }
.card-liv.liv-reject { background: #b44141; }
/* 卡右侧 meta：只占必要宽度，标题优先。日期与项目常驻（用户 2026-09-28：「希望看见所属项目和日期」） */
.card-meta { flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--muted); }
.card-date { font-variant-numeric: tabular-nums; white-space: nowrap; }
.card-date.over { color: var(--danger); font-weight: 700; }
.card-date.dim { color: #8b90a0; }
.card-proj { max-width: 74px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #6d6f86; }

.card .src-badge {
  flex: none; font-size: 10px; line-height: 1.4;
  color: #6f6396; background: #f0edf9; border: 1px solid #ded8f0;
  border-radius: 4px; padding: 0 4px;
}

/* 卡片悬停轻提示（密度方案 B 的配套）：
   **只在标题真被截断时**出现，150ms 后弹出，内容 = 完整标题 + 正文摘要 + 状态/项目/截止/优先级/标签。
   `position:fixed` + `pointer-events:none` —— 不参与布局、不吃命中（方寸的铁律，踩过坑）。
   z-index 70：高于 .overlay(60) 以外的常规层，但仍低于通知/菜单类浮层。 */
.card-tip {
  position: fixed; z-index: 70; pointer-events: none;
  max-width: 340px; padding: 8px 10px;
  background: #fff; border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 6px 20px rgba(90,90,130,0.16);
}
.card-tip-title { font-size: 12.5px; font-weight: 600; line-height: 1.45; word-break: break-word; }
.card-tip-body { margin-top: 4px; font-size: 11.5px; color: var(--muted); line-height: 1.5; word-break: break-word; }
.card-tip-meta { margin-top: 6px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 10.5px; color: var(--muted); }
.card-tip-pri { background: var(--tint); color: #4a4368; border-radius: 6px; padding: 0 5px; font-weight: 600; }
.card-tip .ptags { margin-top: 5px; }

/* 详情面板按钮分组：流转（改状态）与操作（不改状态）分开，避免一排按钮堆砌 */
.task-acts { display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
.acts-group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.acts-group .acts-label { font-size: 11px; color: var(--muted); width: 28px; flex: none; letter-spacing: 0.5px; }

/* 任务详情：关联日志反向索引 */
.logs-section { margin-top: 12px; }
.logs-section > label { font-size: 12px; color: var(--muted); display: block; margin-bottom: 5px; }
.task-logs-list { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.task-log-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--border); cursor: pointer; }
.task-log-item:hover { background: var(--tint-2); }
.task-log-item:last-child { border-bottom: none; }
.task-log-main { flex: 1; min-width: 0; }
.task-log-title { font-size: 12.5px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-log-meta { font-size: 11px; color: var(--muted); }
.task-log-done { padding: 3px 9px; font-size: 11.5px; flex: none; }

/* 批量操作条 */
.batch-bar .batch-actions { display: flex; gap: 4px; flex-wrap: wrap; }
.batch-count { font-weight: 600; color: var(--accent); }

/* 任务表单：字段清单驱动，CSS Grid 自动分列 */
.task-modal .tf-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; margin-bottom: 12px; }
.task-modal .tf-field { display: flex; flex-direction: column; min-width: 0; }
.task-modal .tf-field.tf-full { grid-column: 1 / -1; }
.task-modal .tf-field label { font-size: 12px; color: var(--muted); margin-bottom: 3px; }
.task-modal .tf-field input,
.task-modal .tf-field select,
.task-modal .tf-field textarea {
  width: 100%; padding: 6px 9px; border: 1px solid var(--border);
  border-radius: 7px; font-size: 13px; background: #fff; color: var(--ink);
  font-family: inherit;
}
.task-modal .tf-field textarea { resize: vertical; min-height: 52px; }
.task-modal .tf-field textarea.tall { min-height: 130px; }
/* 2026-09-25 第 13 条：任务编辑弹窗也放宽、正文框加高（编辑正文是高频操作） */
#modal.task-modal { width: 680px; max-width: calc(100vw - 48px); }
#modal textarea.tall { height: 240px; }
.task-modal .tf-hint { font-size: 11px; color: var(--muted); margin-top: 2px; }

.card-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.ttl { font-size: 13px; font-weight: 600; line-height: 1.4; }
.batch { display: inline-block; background: var(--accent-soft); color: #4a4368; border-radius: 6px; font-size: 10px; padding: 1px 6px; margin-right: 5px; font-weight: 600; }
.st { font-size: 10px; padding: 1px 6px; border-radius: 6px; font-weight: 600; white-space: nowrap; }
.st-draft { background: #eceded; color: #5f6672; }
.st-review { background: #fef3c7; color: #92400e; }
.st-todo { background: #e0e7ff; color: #3730a3; }
.st-doing { background: #c7d2fe; color: #3730a3; }
.st-verify { background: #fef3c7; color: #92400e; animation: pulse 2s infinite; }
.st-done { background: #d1fae5; color: #065f46; }
.st-reject { background: #fee2e2; color: #991b1b; }

@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

.result-preview { display: block; margin-top: 4px; font-size: 11px; color: var(--muted); }
.ptags { margin-top: 5px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.ptag { background: var(--tint); color: #5b5478; border-radius: 6px; font-size: 10px; padding: 1px 6px; }

/* 16px 太小、用户要「小心翼翼点避免点错」（2026-09-25 第 2 条）：
   放大到 20px，并让**整张卡**在批量模式下都能点（模板里 @click 已分流）。 */
.batch-chk { width: 20px; height: 20px; cursor: pointer; accent-color: var(--accent); margin-right: 8px; flex-shrink: 0; }
.batch-chk:checked { outline: 2px solid var(--accent); outline-offset: 1px; }
/* 批量模式：卡片本身是开关，给手一个明确的落点（不用去瞄那个小方框） */
#app:has(.batch-bar) #board .card { cursor: pointer; }
#app:has(.batch-bar) #board .card:hover { box-shadow: 0 0 0 2px rgba(155,143,196,0.28); }

/* Overlay */
/* 全屏遮罩：**禁止 backdrop-filter**（2026-09-25 第 3 条）。
   1920×1032 的实时模糊（blur(4px)）在窗口失焦/被遮挡时，Chromium 合成器会停止重绘 ——
   表现就是「点开新建日志先卡一下，必须切到别的窗口再回方寸才莫名恢复」。
   日志多选「点了没反应、要多点几次才能选中」也是同一原因：状态变了但**没重绘**，
   用户看不到勾 → 再点一下其实取消了。去掉模糊 + translateZ(0) 强制独立合成层。 */
.overlay { position: fixed; inset: 0; background: rgba(60,65,80,0.38); display: flex; align-items: center; justify-content: center; z-index: 60; transform: translateZ(0); }
#modal, #rmodal, #smodal {
  background: #fff; border-radius: 16px; padding: 18px 20px; width: 460px; max-height: 88vh;
  overflow: auto; box-shadow: var(--shadow); border: 1px solid var(--border);
}
#modal h3, #rmodal h3, #smodal h3 { margin: 0 0 12px; font-size: 16px; color: var(--ink); }

/* 关于（左上角 LOGO 入口，2026-09-25 第 12 条） */
#about-modal {
  background: #fff; border-radius: 16px; padding: 18px 20px; width: 440px; max-height: 88vh;
  overflow: auto; box-shadow: var(--shadow); border: 1px solid var(--border);
}
#about-modal h3 { margin: 0 0 14px; font-size: 16px; color: var(--ink); }
#about-modal .about-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
#about-modal .about-logo {
  flex: none; width: 44px; height: 44px; border-radius: 12px; background: var(--accent); color: #fff;
  display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 700; font-family: inherit;
}
#about-modal .about-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
#about-modal .about-rows { border-top: 1px solid var(--border); padding-top: 10px; }
#about-modal .about-rows > div { display: flex; gap: 10px; font-size: 12.5px; padding: 4px 0; align-items: baseline; }
#about-modal .about-rows .k { flex: none; width: 62px; color: var(--muted); }
#about-modal .about-rows .v { color: var(--ink); word-break: break-all; }
#about-modal .about-path { font-size: 11.5px; color: var(--muted); }
#about-modal .about-note { margin: 12px 0 0; font-size: 11.5px; line-height: 1.7; color: var(--muted); }
#about-modal .acts { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; flex-wrap: wrap; }

/* 日志只读预览（2026-09-25 第 13 条）：正文走 .body-text.markdown 渲染 */
#log-preview-modal {
  background: #fff; border-radius: 16px; padding: 18px 20px; width: 720px; max-height: 88vh;
  overflow: auto; box-shadow: var(--shadow); border: 1px solid var(--border);
}
#log-preview-modal h3 { margin: 0 0 10px; font-size: 16px; color: var(--ink); display: flex; align-items: center; gap: 8px; }
#log-preview-modal .lp-meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11.5px; color: var(--muted); margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
#log-preview-modal label { display: block; font-size: 12px; font-weight: 600; color: var(--muted); margin: 12px 0 4px; }
#log-preview-modal .acts { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

/* ── 附件块（2026-10-01 用户第 1 条 → 卡 036）：只读预览 + 编辑对话框共用 ──
   有意做窄：一张网格 + 一个「＋添加」，不做标签/相册/筛选 —— 卡 036 验收写明
   「不做同质化资产库」，真实需求只是「截图和报告有地方放、随手能挂上」。 */
.attach-block { margin-top: 14px; padding-top: 10px; border-top: 1px dashed var(--border); }
.attach-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.attach-head .attach-lbl { margin: 0; font-size: 11px; font-weight: 600; color: var(--muted); }
.attach-add { height: 26px; padding: 0 10px; font-size: 12px; }
.attach-add:disabled { opacity: .55; cursor: not-allowed; }
.attach-empty { font-size: 12px; color: var(--muted); line-height: 1.7; }
.attach-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.attach-item { width: 150px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: #fff; }
.attach-item img { display: block; width: 100%; height: 96px; object-fit: cover; cursor: zoom-in; background: var(--tint); }
.attach-file {
  display: flex; align-items: center; justify-content: center; height: 96px; padding: 0 8px;
  font-size: 11.5px; color: var(--ink); background: var(--tint); cursor: pointer;
  text-align: center; word-break: break-all; line-height: 1.5;
}
.attach-cap { display: flex; align-items: center; gap: 4px; padding: 4px 6px; font-size: 10.5px; color: var(--muted); }
.attach-fn { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attach-x { border: 0; background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; padding: 0 3px; line-height: 1; border-radius: 4px; }
.attach-x:hover { background: var(--tint); color: var(--danger); }
/* 日志卡上的附件数量角标：一眼看出这条有没有附东西（报修场景最需要的一眼信息） */
.log-attach-badge { font-size: 10.5px; color: var(--muted); background: var(--tint); border-radius: 6px; padding: 1px 6px; font-weight: 600; white-space: nowrap; }

/* 日志「关联任务」多选列表（2026-09-25 第 2 条） */
.log-task-multi {
  max-height: 168px; overflow: auto; border: 1px solid var(--border); border-radius: 8px;
  background: #fff; padding: 4px 6px; margin-bottom: 6px;
}
.log-task-opt {
  display: flex; align-items: center; gap: 6px; padding: 3px 4px; border-radius: 6px;
  font-size: 12px; cursor: pointer; margin: 0;
}
.log-task-opt:hover { background: var(--tint-2); }
.log-task-opt input[type='checkbox'] { flex: none; margin: 0; }
.log-task-opt .lto-id { flex: none; color: var(--accent); font-weight: 600; font-size: 11.5px; }
.log-task-opt .lto-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
.log-task-opt .lto-st { flex: none; font-size: 11px; color: var(--muted); }
#modal label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 3px; font-weight: 600; }
#modal input, #modal select, #modal textarea {
  width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--border);
  border-radius: 8px; font-size: 13px; color: var(--ink); outline: none; font-family: inherit;
}
#modal textarea { height: 64px; resize: vertical; }
#modal textarea.tall { height: 120px; }
#modal .row2 { display: flex; gap: 10px; }
#modal .row2 > div { flex: 1; }
.acts { margin-top: 16px; display: flex; gap: 6px; justify-content: flex-end; }
.acts button { padding: 6px 14px; border: 0; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; }
.acts .pri { background: var(--accent); color: #fff; }
.acts .ok { background: #5e9154; color: #fff; }
.acts .no { background: #c2706f; color: #fff; }
.acts .danger { background: #d98a8a; color: #fff; }
.acts .ghost { background: #eee; color: #333; }

/* Preview modal */
.meta { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.meta .k { font-size: 11px; color: var(--muted); font-weight: 600; }
.meta .v { font-size: 13px; }
.body label { font-size: 11px; color: var(--muted); font-weight: 600; display: block; margin-bottom: 4px; }
.body-text { font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }

/* Project view */
.alertbar { display: flex; align-items: center; gap: 10px; background: #fdf6f6; border: 1px solid #eedcdc; border-radius: 12px; padding: 8px 14px; margin-bottom: 12px; font-size: 12.5px; }
.alertbar .ico { flex: none; }
.alertbar b { color: #8a4343; }
.pvgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; width: 100%; }
.tile { position: relative; background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px 8px 15px; cursor: pointer; transition: box-shadow 0.15s, transform 0.15s; overflow: hidden; box-shadow: var(--shadow); }
.tile:hover { box-shadow: 0 4px 16px rgba(120,110,170,0.16); transform: translateY(-1px); }
.tile::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; border-radius: 4px 0 0 4px; }
.t-active::before { background: #5e9154; }
.t-stuck::before { background: #c2706f; }
.t-dormant::before { background: #b6b2c4; }
.t-idle::before { background: #d9b87a; }
.t-unknown::before { background: #9a95ad; }
.trow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tname { font-size: 13.5px; font-weight: 700; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.thealth { margin-left: auto; flex: none; font-size: 10px; color: var(--muted); }
.tstats { display: flex; gap: 14px; margin-top: 7px; }
.ts { text-align: left; min-width: 0; }
.ts .n { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; color: var(--ink); }
.ts .n.warn { color: #c99a4e; }
.ts .l { font-size: 9.5px; color: var(--muted); }
.tile-add { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; border: 2px dashed var(--border); background: var(--tint-3); cursor: pointer; transition: all 0.15s; min-height: 140px; }
.tile-add:hover { border-color: var(--accent); background: var(--tint); }
.tile-add .add-icon { font-size: 32px; color: var(--muted); font-weight: 300; }
.tile-add .add-text { font-size: 12px; color: var(--muted); font-weight: 600; }

/* ── 项目页签：概览卡 + 主从（2026-09-29 用户：「两种视图都要，做成可自选切换」）──
   003 卡的原话是「只是个大号看板入口，不是项目管理」。两种摆法的共同点是把
   「四个孤立数字」换成「状态分布 + 最近动态 + 缺口」，差别只在"一屏看完所有项目"
   还是"一屏专注一个项目"。三个摆法（含旧的项目墙）互斥渲染，共用同一份 projectStats。 */
/* 每种摆法一个**独立**的根容器类（pvgrid / ovgrid / pv-ms）——
   不是为了好看，是让"三种摆法互斥"这条能被机械断言：
   共用同一个类名的话，`.pvgrid` 在两种视图里都在，断言就无从判"到底挂了几个"。 */
.ovgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; width: 100%; }
.ocard {
  background: #fff; border: 1px solid var(--border); border-radius: 12px;
  padding: 12px 14px; cursor: pointer; box-shadow: var(--shadow);
  transition: box-shadow 0.15s, transform 0.15s;
}
.ocard:hover { box-shadow: 0 4px 16px rgba(120,110,170,0.16); transform: translateY(-1px); }
/* 主从右侧那张不点整块（详情本身没有"点进去"的语义），去掉悬停浮起 */
.ocard.bare { box-shadow: none; border: 0; padding: 0; cursor: default; }
.ocard.bare:hover { box-shadow: none; transform: none; }
.ohead { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.ohead .nm { font-size: 13.5px; font-weight: 700; flex: none; }
.ohead .rp { font-size: 10.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 48%; }
.ohead .hl { margin-left: auto; flex: none; font-size: 10.5px; font-weight: 600; color: var(--muted); }
.ohead .hl-active { color: var(--success); }
.ohead .hl-stuck { color: var(--warning); }
.stack { display: flex; height: 8px; border-radius: 99px; overflow: hidden; margin: 10px 0 5px; background: var(--bg); }
.stack i { display: block; height: 100%; }
.legend { display: flex; gap: 10px; font-size: 10.5px; color: var(--muted); flex-wrap: wrap; }
.legend s { display: inline-block; width: 7px; height: 7px; border-radius: 2px; margin-right: 4px; text-decoration: none; }
.odyn { font-size: 11.5px; color: var(--muted); margin-top: 8px; line-height: 1.8; }
.odyn b { color: var(--ink); }
.odyn-warn { color: var(--warning); font-weight: 600; }
.oacts { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
.oact { height: 26px; padding: 0 10px; font-size: 11.5px; }
.ocard-add {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  border: 2px dashed var(--border); background: var(--tint-3); min-height: 140px; transition: all 0.15s;
}
.ocard-add:hover { border-color: var(--accent); background: var(--tint); transform: none; box-shadow: var(--shadow); }
.ocard-add .add-icon { font-size: 32px; color: var(--muted); font-weight: 300; }
.ocard-add .add-text { font-size: 12px; color: var(--muted); font-weight: 600; }

/* 主从布局：左列常驻项目（带迷你进度），右侧摊开所选项目 */
.pv-ms { display: grid; grid-template-columns: 212px minmax(0, 1fr); gap: 10px; align-items: start; width: 100%; }
.ms-list { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 6px; box-shadow: var(--shadow); }
.ms-li { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 8px; font-size: 12.5px; cursor: pointer; }
.ms-li:hover { background: var(--tint-2); }
.ms-li.on { background: var(--tint); font-weight: 600; }
.ms-dot { width: 7px; height: 7px; border-radius: 50%; background: #b6b2c4; flex: none; }
.ms-dot.t-active { background: #5e9154; }
.ms-dot.t-stuck { background: #c2706f; }
.ms-dot.t-dormant { background: #b6b2c4; }
.ms-dot.t-idle { background: #d9b87a; }
.ms-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-mini { width: 34px; height: 4px; border-radius: 99px; background: var(--bg); overflow: hidden; margin-left: auto; flex: none; }
.ms-mini i { display: block; height: 100%; background: var(--accent-soft); }
.ms-n { font-size: 10.5px; color: var(--muted); flex: none; min-width: 12px; text-align: right; }
.ms-add { padding: 7px 9px; font-size: 11.5px; color: var(--muted); cursor: pointer; border-radius: 8px; }
.ms-add:hover { background: var(--tint-2); color: var(--accent); }
.ms-detail { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; box-shadow: var(--shadow); }
.ms-detail.empty { color: var(--muted); font-size: 12.5px; }

/* Settings */
/* ── 设置：左侧分类导航 + 右侧内容（2026-10-03 用户：「不要一条长名单，像各大软件那样侧边栏分类」）
     上一版的「点标题折叠」被取代 —— 折叠解决"太长"，侧边栏解决"找不到"。 */
#smodal {
  width: min(860px, 94vw); height: min(620px, 86vh);
  display: flex; flex-direction: row; padding: 0; overflow: hidden;
}
#smodal .settings-nav {
  width: 178px; flex: none; display: flex; flex-direction: column; gap: 2px;
  padding: 16px 10px; border-right: 1px solid var(--border); background: var(--bg);
  overflow-y: auto;
}
#smodal .settings-nav-title { font-size: 15px; font-weight: 700; color: var(--ink); padding: 0 10px 10px; }
/* ⚠ 导航按钮用与祖先无关的全局类（`.settings-nav-btn`）：按钮样式守卫要求"用了 class 就得有规则"，
   而 #smodal 前缀的选择器在守卫眼里同样成立 —— 这里保持带前缀，规则更收敛。 */
#smodal .settings-nav-btn {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  font-family: inherit; font-size: 13px; padding: 8px 10px; border-radius: 8px;
  border: 1px solid transparent; background: transparent; color: var(--ink); cursor: pointer;
}
#smodal .settings-nav-btn:hover { background: var(--tint); }
#smodal .settings-nav-btn.on { background: var(--tint); border-color: var(--accent); color: var(--accent); font-weight: 600; }
#smodal .settings-nav-btn .sn-ico { width: 16px; text-align: center; flex: none; }
#smodal .settings-body {
  flex: 1; min-width: 0; display: flex; flex-direction: column;
  padding: 16px 20px; overflow-y: auto;
}
#smodal .settings-foot {
  margin-top: auto; padding-top: 14px; display: flex; gap: 8px; justify-content: flex-end; flex: none;
}
.ver-row { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.ver-num { font-size: 15px; font-weight: 700; color: var(--ink); font-family: var(--mono, monospace); }
/* 同一分类下可能有好几个小节 → 不再用 border-top 分隔（v-show 隐藏的兄弟会让"视觉第一块"
   被 CSS 相邻选择器算错），改成每节留白间隔。 */
#smodal .sect { border-top: 0; padding: 0 0 20px; margin-top: 0; flex: 0 0 auto; }
#smodal .sect h4 { margin: 0 0 10px; font-size: 14px; color: var(--accent); }
#smodal .theme-swatches { display: flex; flex-wrap: wrap; gap: 8px; }
#smodal .theme-swatch { display: inline-flex; align-items: center; gap: 7px; padding: 6px 12px;
  border: 1px solid var(--border); border-radius: 999px; background: #fff; color: var(--ink);
  font-size: 12px; font-weight: 600; font-family: inherit; cursor: pointer; }
#smodal .theme-swatch:hover { border-color: var(--accent); background: var(--tint); }
#smodal .theme-swatch.on { border-color: var(--accent); background: var(--tint); box-shadow: 0 0 0 2px var(--accent-soft); }
#smodal .theme-swatch .sw-dot { width: 14px; height: 14px; border-radius: 50%; border: 1px solid rgba(0,0,0,.14); flex: none; }
#smodal .theme-swatch .sw-check { color: var(--accent); }
#smodal .retain-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
#smodal .retain-input { width: 92px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }
#smodal .retain-input:focus { border-color: var(--accent); }
#smodal .hint { font-size: 11px; color: var(--muted); margin-top: 4px; }
#smodal .hint.logpath { word-break: break-all; color: var(--ink); }
#smodal .sect .pri { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; margin-top: 8px; }
#smodal .sect .ghost { background: #fff; color: var(--ink); border: 1px solid var(--border); border-radius: 8px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; }
.projlist { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.proj-row { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; font-size: 13px; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
.proj-row:hover { background: var(--tint); border-color: var(--accent); }
.proj-row-name { font-weight: 600; color: var(--ink); }
.proj-row-id { margin-left: auto; font-size: 11px; color: var(--muted); flex: none; }
.proj-row-desc { width: 100%; font-size: 11px; color: var(--muted); margin-top: 2px; line-height: 1.4; }

/* Toast */
#toast { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 9999; padding: 8px 16px; border-radius: 10px; font-size: 13px; font-weight: 600; box-shadow: 0 8px 24px rgba(0,0,0,0.18); pointer-events: none; opacity: 0; transition: opacity 0.3s, transform 0.3s; max-width: 90vw; text-align: center; }
#toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
#toast.success { background: #e3f1de; color: #3f6b3a; border: 1px solid #bcd4b4; }
#toast.error { background: #f6e2e2; color: #8a4343; border: 1px solid #e2c4c4; }
#toast.info { background: var(--tint); color: #5b5478; border: 1px solid var(--accent-soft); }

/* Drag status picker */
.drag-status-picker {
  position: fixed; z-index: 999; background: #fff; border: 2px solid var(--accent);
  border-radius: 16px; padding: 16px 14px; box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  display: flex; flex-direction: column; gap: 6px;
}
.drag-status-picker .sp-title { font-size: 13px; font-weight: 700; color: var(--accent); margin-bottom: 8px; text-align: center; }
.sp-bucket {
  display: flex; align-items: center; gap: 8px; padding: 8px 14px; border: 1px solid var(--border);
  border-radius: 10px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s;
}
.sp-bucket:hover, .sp-bucket.dragover { background: var(--tint); border-color: var(--accent); box-shadow: 0 0 0 2px rgba(155,143,196,0.22); }
.sp-dot { width: 12px; height: 12px; border-radius: 50%; flex: none; }

/* Launchpad */
.launchpad { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
.lp-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; flex-wrap: wrap; gap: 8px; }
.lp-header h3 { font-size: 16px; font-weight: 700; }
.lp-ctrls { display: flex; gap: 6px; }
.lp-ctrls button { padding: 5px 12px; border: 0; border-radius: 8px; font-size: 12px; font-weight: 600; background: var(--accent); color: #fff; cursor: pointer; }
.lp-ctrls button.ghost { background: #fff; color: var(--ink); border: 1px solid var(--border); }
.lp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.lp-card { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 12px; display: flex; align-items: center; gap: 10px; cursor: pointer; transition: box-shadow 0.15s, transform 0.15s; box-shadow: var(--shadow); }
.lp-card:hover { box-shadow: 0 4px 16px rgba(120,110,170,0.16); transform: translateY(-1px); }
.lp-icon { width: 36px; height: 36px; border-radius: 8px; background: var(--tint); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; flex: none; }
.lp-info { flex: 1; min-width: 0; }
.lp-name { font-size: 13px; font-weight: 600; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-desc { font-size: 10.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-launch { padding: 4px 10px; background: var(--accent); color: #fff; border: 0; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; flex: none; }
.app-path-hint { margin-top: 6px; font-size: 11px; color: var(--muted); line-height: 1.5; }
#app-edit-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 400px; box-shadow: var(--shadow); border: 1px solid var(--border); }
#app-edit-modal h3 { margin: 0 0 12px; font-size: 16px; }
#app-edit-modal label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 3px; font-weight: 600; }
#app-edit-modal input { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; color: var(--ink); outline: none; font-family: inherit; }

/* Markdown body */
.body-text.markdown { font-size: 12.5px; line-height: 1.65; }
.body-text.markdown h3 { font-size: 13px; margin: 8px 0 4px; color: var(--ink); }
.body-text.markdown ul { padding-left: 18px; margin: 4px 0; }
.body-text.markdown li { margin-bottom: 2px; list-style: disc; }
.body-text.markdown li.check-item { list-style: none; margin-left: -18px; display: flex; align-items: center; gap: 5px; }
.body-text.markdown li.check-item input[type="checkbox"] { width: 14px; height: 14px; accent-color: var(--accent); }
.body-text.markdown code { background: #eee; padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }
.body-text.markdown strong { color: var(--ink); }
.body-text.markdown br { display: block; content: ""; margin: 3px 0; }

/* Search checkbox */
#bar .chk { display: flex; align-items: center; gap: 3px; font-size: 11px; color: var(--muted); white-space: nowrap; }
#bar .chk input { width: 14px; height: 14px; accent-color: var(--accent); }



/* 解析失败提示：任务文件坏掉时必须在界面上可见，不能静默跳过 */
.parse-warn { font-size: 11px; color: var(--danger); background: #fff; border: 1px solid #eedcdc; border-radius: 6px; padding: 3px 8px; margin-left: 10px; cursor: pointer; white-space: nowrap; flex: none; }
.parse-warn:hover { background: #fce4e4; }

/* Batch bar：悬浮在内容区顶部居中（点击右上角☑按钮后出现在视线附近），带阴影 */
/* 批量操作栏：贴视口底部居中悬浮。
   此前固定 top:96px 压在列表头几行上，且离刚点的 ☑ 很远 —— 用户反馈"位置总是很奇怪"。
   改到底部后不遮内容，且始终在视线下方。 */
.batch-bar {
  position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); z-index: 40;
  display: flex; align-items: center; gap: 8px; padding: 8px 16px;
  background: #fffdf5; border: 1px solid #f0e8d0; border-radius: 12px;
  box-shadow: 0 8px 24px rgba(90,90,130,0.18); font-size: 12px; flex-wrap: wrap;
  max-width: calc(100vw - 32px);
}
/* 批量栏出现时给内容区留底部空间，避免遮住最后一条 */
#app:has(.batch-bar) #board { padding-bottom: 84px; }
/* 左上角返回按钮：紧贴标题右侧（后续高频按钮也放这一带） */
.nav-back { margin-left: 4px; padding: 2px 10px; font-size: 12px; }
.batch-count { font-weight: 600; color: var(--ink); flex: none; }
.batch-actions { display: flex; gap: 4px; flex-wrap: wrap; }
.batch-actions button { padding: 4px 12px; font-size: 11px; background: #fff; color: var(--ink); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-weight: 600; white-space: nowrap; flex-shrink: 0; }
.batch-actions button:hover { background: var(--tint); border-color: var(--accent); }
.batch-actions button.danger { background: #fce4e4; color: var(--danger); border-color: #eedcdc; }
.batch-actions button.danger:hover { background: #f8d7d7; }

.batch-mode-btn.active { background: var(--accent) !important; color: #fff !important; box-shadow: inset 0 0 0 2px rgba(255,255,255,0.3); }
/* ── 多选：待办/回收站选中态（2026-09-30 用户补充）——与看板卡/日志卡同一套视觉 ── */
.todo-item.selected, .trash-item.selected {
  border-color: var(--accent); background: var(--tint);
  box-shadow: 0 0 0 2px rgba(100, 80, 200, 0.2);
}
/* 2026-09-30 卡 task-20260930-005：选中态必须压过 hover ——
   `.trash-item:hover` 在文件更下方且同特异性，悬停会把选中的边框/底色盖掉，
   用户「看不清到底是否选中」。selected:hover 显式钉住。 */
.trash-item.selected:hover {
  border-color: var(--accent); background: var(--tint);
  box-shadow: 0 0 0 2px rgba(100, 80, 200, 0.28);
}
/* 显式勾选框：批量模式下每行行首一个，选中填实 + 白勾 —— 反馈不再只靠底色 */
.trash-batch-chk {
  width: 20px; height: 20px; flex-shrink: 0;
  border: 2px solid var(--border); border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 700; color: transparent;
  background: #fff; transition: background .12s, border-color .12s;
}
.trash-batch-chk.on {
  background: var(--accent); border-color: var(--accent); color: #fff;
}
/* 多选模式下整行可点：给出可点 affordance（平时待办行空白处点了没反应） */
.todos-list.batching .todo-item, .trash-list.batching .trash-item { cursor: pointer; }

.batch-bar .ghost { padding: 4px 12px; font-size: 11px; background: #fff; color: var(--ink); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; flex: none; }


.nq-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; background: var(--tint); color: var(--accent); border-radius: 6px; font-size: 10px; font-weight: 700; margin-left: 8px; }

/* Blockers view */
.blockers-view { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
.blockers-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.blockers-header h3 { font-size: 16px; font-weight: 700; }
.blockers-count { font-size: 12px; color: var(--muted); }
.blocker-chains { display: flex; flex-direction: column; gap: 12px; }
.chain-card { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; box-shadow: var(--shadow); }
.chain-main { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.chain-id { font-size: 11px; color: var(--muted); background: var(--bg); padding: 2px 6px; border-radius: 4px; }
.chain-title { font-weight: 600; flex: 1; }
.chain-arrow { font-size: 11px; color: var(--muted); padding: 4px 0; text-align: center; }
.chain-blockers { display: flex; flex-wrap: wrap; gap: 8px; }
.chain-blocker { display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: #faf3f3; border: 1px solid #eedcdc; border-radius: 8px; font-size: 12px; }
.chain-blocker.done { background: #f0f7ee; border-color: #d4e8d0; opacity: 0.7; }
.cb-status { font-weight: 700; }
.chain-blocker .cb-status { color: var(--danger); }
.chain-blocker.done .cb-status { color: var(--success); }
.cb-id { font-size: 10px; color: var(--muted); }
.cb-title { font-weight: 500; }

.add-note-btn { background: none; border: 1px dashed var(--border); border-radius: 6px; padding: 4px 8px; font-size: 11px; color: var(--muted); cursor: pointer; width: 100%; }
.add-note-btn:hover { border-color: var(--accent); color: var(--accent); }



.plan-title { font-size: 13px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-status { font-size: 10px; padding: 1px 6px; border-radius: 6px; font-weight: 600; white-space: nowrap; }

/* Edit modal */
.deadline { color: var(--muted); font-size: 11px; }
.dp-item { background: var(--bg); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; border: 1px solid var(--border); }
.dp-item.dp-decided { background: #f0f7ee; border-color: #d4e8d0; }
.dp-item.dp-skipped { opacity: 0.6; }
.dp-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.dp-id { font-size: 11px; color: var(--muted); }
.dp-status-badge { font-size: 9px; padding: 1px 5px; border-radius: 4px; font-weight: 700; }
.dp-status-badge.dp-pending { background: #fef3c7; color: #92400e; }
.dp-status-badge.dp-decided { background: #d1fae5; color: #065f46; }
.dp-status-badge.dp-skipped { background: #eceded; color: #7a7f8c; }
.dp-question { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
.dp-options { display: flex; gap: 6px; flex-wrap: wrap; }
.dp-options button { padding: 4px 10px; font-size: 11px; background: #fff; color: var(--ink); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
.dp-options button:hover { background: var(--tint); border-color: var(--accent); }
.dp-chosen { font-size: 11px; color: var(--success); font-weight: 500; }

/* Notification system */


/* Empty state */
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; gap: 12px; }
.empty-icon { font-size: 36px; opacity: 0.5; }
.empty-text { font-size: 13px; color: var(--muted); }

/* Archive hint */
.archive-hint { margin: 8px 16px; padding: 8px 12px; background: #fffdf5; border: 1px solid #f0e8d0; border-radius: 10px; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #7a6f4a; position: relative; z-index: 2; }
.archive-hint button { padding: 4px 10px; background: var(--accent); color: #fff; border: 0; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 600; flex: none; }
/* 已完成任务自动归档提示条（2026-10-03 卡 012）：改成蓝色系以区别"只读提示"的归档说明条 */
.archive-overdue-bar {
  margin: 8px 16px 0; padding: 8px 12px; background: #f4f8ff; border: 1px solid #d6e4f7;
  border-radius: 10px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: 12px; color: var(--ink); position: relative; z-index: 2;
}
.archive-overdue-bar b { color: var(--accent); }
.archive-overdue-bar .ghost { font-size: 11.5px; padding: 4px 10px; }
.archive-overdue-bar span { flex: 1 1 320px; }

/* Roadmap view */
.roadmap-view { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
.roadmap-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.roadmap-header h3 { font-size: 16px; font-weight: 700; }
.roadmap-ctrls { display: flex; gap: 6px; }
.roadmap-ctrls button { padding: 5px 12px; border: 0; border-radius: 8px; font-size: 12px; font-weight: 600; background: var(--accent); color: #fff; cursor: pointer; }
.roadmap-ctrls button.ghost { background: #fff; color: var(--ink); border: 1px solid var(--border); }
.roadmap-content { display: flex; flex-direction: column; gap: 14px; }
.roadmap-project { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; box-shadow: var(--shadow); }
.rp-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.rp-name { font-size: 14px; font-weight: 700; flex: 1; }
.rp-batches { display: flex; flex-direction: column; gap: 8px; }
.rp-batch { background: var(--bg); border-radius: 8px; padding: 8px 10px; border-left: 4px solid #9ca3af; }
.rp-batch.rb-active { border-left-color: #6366f1; background: #fafaff; }
.rp-batch.rb-completed { border-left-color: #10b981; background: #f5fdf8; }
.rp-batch.rb-blocked { border-left-color: #ef4444; background: #fdf5f5; }
.rb-header { display: flex; justify-content: space-between; font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.rb-count { color: var(--muted); }
.rb-tasks { display: flex; flex-wrap: wrap; gap: 6px; }
.rb-task { display: flex; align-items: center; gap: 4px; font-size: 11px; }
.rb-title { color: var(--ink); }
.rp-next { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px; }
.rp-next label { font-size: 11px; color: var(--muted); font-weight: 600; }
.rp-actions { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
.rp-action { font-size: 12px; display: flex; align-items: center; gap: 6px; }

/* Progress bar */
.progress-bar { height: 4px; background: var(--bg); border-radius: 2px; overflow: hidden; margin: 4px 0; }
.progress-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.3s; }

/* Due filter */
#bar select.due-filter { width: 90px; }

/* Archived card */
.card._archived { opacity: 0.55; filter: saturate(0.5); }
.card._archived:hover { opacity: 0.85; filter: none; }

/* Warning button (archive) */
.acts .warning { background: #f0a83a; color: #fff; }

/* Wizard */
.wizard-overlay { z-index: 100; }
.wizard { background: #fff; border-radius: 18px; padding: 28px 32px; width: 560px; max-width: 90vw; box-shadow: 0 12px 48px rgba(90,90,130,0.2); border: 1px solid var(--border); }
.wizard-header { margin-bottom: 20px; }
.wizard-header h2 { font-size: 20px; color: var(--ink); margin: 0; }
.wizard-step-indicator { font-size: 12px; color: var(--muted); margin-top: 4px; }
.wizard-desc { font-size: 14px; color: var(--ink); margin: 0 0 16px; }
.wizard-field { margin-bottom: 16px; }
.wizard-field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; font-weight: 600; }
.wizard-input-row { display: flex; gap: 8px; }
.wizard-input-row input { flex: 1; padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; color: var(--ink); outline: none; font-family: inherit; background: #fff; }
.wizard-input-row button { flex: none; }
.wizard-hint { display: block; margin-top: 4px; font-size: 11px; color: var(--muted); }
.wizard-options { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
.wizard-option { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; transition: all 0.15s; }
.wizard-option:hover { border-color: var(--accent-soft); }
.wizard-option.selected { border-color: var(--accent); background: var(--tint); }
.wizard-option input { margin-top: 2px; }
.wizard-option strong { display: block; font-size: 13px; color: var(--ink); }
.wizard-option small { display: block; font-size: 11px; color: var(--muted); margin-top: 2px; }
.wizard-summary { background: var(--bg); border-radius: 10px; padding: 14px 16px; }
.wizard-summary-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.wizard-summary-row:last-child { border-bottom: 0; }
.wizard-summary-row span:first-child { color: var(--muted); }
.wizard-summary-row code { background: #eee; padding: 2px 6px; border-radius: 4px; font-size: 11px; }
.wizard-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 24px; }
.wizard-footer-right { margin-left: auto; }

/* ── 备份 v2 ─────────────────────────────────────────────────────── */
.backup-btn { position: relative; }
.backup-btn.bk-bad { border-color: #e2c4c4; background: #fdf5f5; }
.backup-btn.bk-ok { border-color: #bcd4b4; }
.bk-alert-dot { position: absolute; top: 1px; right: 1px; width: 7px; height: 7px; border-radius: 50%; background: #c96a6a; box-shadow: 0 0 0 2px #fff; }
.bk-spin { display: inline-block; animation: bk-rot 1s linear infinite; }
@keyframes bk-rot { to { transform: rotate(360deg); } }

.backup-sect .bk-status { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12.5px; margin-bottom: 10px; background: var(--tint-3); }
.bk-status .bk-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.bk-status.bk-ok .bk-dot { background: #5e9154; }
.bk-status.bk-bad .bk-dot { background: #c96a6a; }
.bk-status.bk-running .bk-dot { background: #d9a44a; animation: bk-pulse 1.2s ease-in-out infinite; }
@keyframes bk-pulse { 50% { opacity: 0.35; } }
.bk-status .bk-next { margin-left: auto; color: var(--muted); font-size: 11.5px; }
.bk-err-line { font-size: 12px; color: #8a4343; background: #fdf5f5; border: 1px solid #eedcdc; border-radius: 6px; padding: 6px 10px; margin-bottom: 10px; word-break: break-all; }

.bk-grid { display: grid; grid-template-columns: 92px 1fr; gap: 8px 10px; align-items: center; margin-bottom: 12px; }
.bk-grid > label { font-size: 12.5px; color: var(--muted); }
.bk-grid input:not([type=checkbox]) { width: 100%; padding: 6px 9px; border: 1px solid var(--border); border-radius: 7px; font-size: 12.5px; background: #fff; color: var(--ink); }
.bk-inline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); }
.bk-inline .bk-num { width: 58px; padding: 4px 6px; border: 1px solid var(--border); border-radius: 6px; font-size: 12.5px; }
.bk-cb { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }

.bk-history { margin-top: 12px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.bk-tabs { display: flex; background: var(--tint-3); border-bottom: 1px solid var(--border); }
.bk-tabs span { flex: 1; text-align: center; padding: 7px; font-size: 12.5px; color: var(--muted); cursor: pointer; }
.bk-tabs span.on { color: var(--ink); background: #fff; font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
.bk-list { max-height: 190px; overflow-y: auto; }
/* 整行可点（2026-09-28 卡 026-001）：此前是死 div，点行毫无反应 */
.bk-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.12s; }
.bk-item:hover { background: var(--tint-2); }
.bk-item.on { background: var(--tint); box-shadow: inset 3px 0 0 var(--accent); }
.bk-inspecting { flex: none; font-size: 10.5px; color: var(--accent); font-weight: 600; }
.bk-item:last-child { border-bottom: none; }
.bk-item-main { flex: 1; min-width: 0; }
.bk-item-name { display: block; font-size: 12.5px; color: var(--ink); font-family: ui-monospace, Consolas, monospace; }
.bk-item-meta { font-size: 11px; color: var(--muted); }
.bk-restore { padding: 3px 9px; font-size: 11.5px; }
.bk-log-toggle { margin-top: 8px; font-size: 12px; }
.bk-log { margin-top: 6px; max-height: 180px; overflow: auto; background: #2f3240; color: #d7dae6; padding: 10px; border-radius: 8px; font-size: 11px; line-height: 1.55; font-family: ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-all; }
.bk-path { flex: 1; min-width: 0; padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; background: #fff; color: var(--ink); }
.bk-mini { padding: 3px 9px; font-size: 11.5px; }
.bk-manual { margin-top: 8px; padding: 8px 10px; border: 1px dashed var(--border); border-radius: 8px; background: var(--tint-3); }
.bk-manual-label { display: block; width: 100%; font-size: 11.5px; color: var(--muted); margin-bottom: 6px; }
.bk-verify { margin-top: 10px; padding: 9px 11px; border-radius: 8px; font-size: 12.5px; border: 1px solid var(--border); background: var(--tint-3); }
.bk-verify.ok { background: #e3f1de; border-color: #bcd4b4; color: #3f6b3a; }
.bk-verify.bad { background: #f6e2e2; border-color: #e2c4c4; color: #8a4343; }
.bk-verify-head { font-weight: 600; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.bk-verify-path { font-weight: 400; font-size: 11.5px; color: var(--muted); word-break: break-all; }
.bk-verify-meta { margin-top: 3px; font-size: 11.5px; color: var(--muted); }
.bk-verify-errs { margin: 6px 0 0 16px; font-size: 11.5px; line-height: 1.6; }
.bk-notice { margin-top: 10px; padding: 9px 11px; border: 1px solid #e5dcc4; background: #fdfbf4; border-radius: 8px; font-size: 11.5px; line-height: 1.65; color: #6a6350; }
.bk-notice b { display: block; margin-bottom: 4px; color: #8a7a46; }
.bk-notice ul { margin-left: 16px; }
.bk-notice li { margin-bottom: 2px; }
.bk-notice code { background: #efe9d8; padding: 0 4px; border-radius: 3px; }

/* ── 数据目录迁移模态 ─────────────────────────────────────────────── */
#migrate-modal {
  background: var(--card);
  border-radius: var(--radius);
  padding: 18px 20px;
  width: 560px;
  max-width: 92vw;
  max-height: 86vh;
  overflow-y: auto;
  box-shadow: var(--shadow);
}
#migrate-modal h3 { margin: 0 0 12px; font-size: 16px; color: var(--ink); }
.mg-row { display: flex; gap: 10px; font-size: 12.5px; margin-bottom: 6px; align-items: baseline; }
.mg-row .k { color: var(--muted); flex: none; width: 62px; }
.mg-row .v { color: var(--ink); word-break: break-all; }
.mg-row .v.warn { color: #a8813a; }
.mg-notice {
  margin-top: 12px; padding: 10px 12px;
  border: 1px solid #e5dcc4; background: #fdfbf4; border-radius: 8px;
  font-size: 11.5px; line-height: 1.7; color: #6a6350;
}
.mg-notice b { display: block; margin-bottom: 4px; color: #8a7a46; }
.mg-notice ul { margin-left: 16px; }
.mg-notice code { background: #efe9d8; padding: 0 4px; border-radius: 3px; }
.mg-hint { margin-top: 5px; color: #8a8270; }

/* ── 新建规划 / 新建项目模态 ──────────────────────────────────────── */
#plan-new-modal,
#proj-new-modal {
  background: var(--card);
  border-radius: var(--radius);
  padding: 18px 20px;
  width: 470px;
  max-width: 92vw;
  max-height: 86vh;
  overflow-y: auto;
  box-shadow: var(--shadow);
}
#plan-new-modal h3,
#proj-new-modal h3 { margin: 0 0 10px; font-size: 16px; color: var(--ink); }
#plan-new-modal label,
#proj-new-modal label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
#plan-new-modal input,
#plan-new-modal textarea,
#plan-new-modal select,
#proj-new-modal input {
  width: 100%; padding: 7px 10px;
  border: 1px solid var(--border); border-radius: 7px;
  font-size: 13px; background: #fff; color: var(--ink);
  font-family: inherit;
}
#plan-new-modal textarea { resize: vertical; min-height: 66px; }
#plan-new-modal .hint,
#proj-new-modal .hint { margin-top: 10px; font-size: 11px; color: var(--muted); line-height: 1.6; }
#proj-new-modal code { background: #eee; padding: 0 4px; border-radius: 3px; }
.req { color: var(--danger); }

/* Policy（方针区） */
.policy-list { display: flex; flex-direction: column; gap: 4px; }
.policy-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; }
.policy-row:hover { border-color: var(--accent); }
.policy-name { flex: 1; font-size: 12px; font-weight: 600; }
.policy-state { font-size: 10px; color: var(--muted); border: 1px solid var(--border); padding: 1px 6px; border-radius: 8px; }
.policy-state.has { color: #5e9154; border-color: #5e9154; }
/* 项目卡上的方针入口：卡内全宽小按钮，颜色弱化，不抢主统计的视线 */
.pv-policy { margin-top: 8px; width: 100%; font-size: 11px; padding: 4px 8px; border-radius: 8px; }
#policy-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 700px; max-width: calc(100vw - 48px); max-height: 88vh; overflow-y: auto; box-shadow: var(--shadow); border: 1px solid var(--border); }
/* 方针弹窗必须盖在设置面板之上：两者都用 .overlay（z-index:60），而设置面板在 DOM 里更靠后，
   同层级下后出现的赢 —— 于是从设置里点方针，弹窗被设置整个盖住（用户 2026-09-25 第 3 条）。
   给方针overlay 一个更高的层级，任何入口点进来都看得见。 */
#policy-overlay { z-index: 90; }
#policy-modal h3 { margin: 0 0 12px; font-size: 16px; }
#policy-modal label { font-size: 11px; color: var(--muted); margin: 8px 0 4px; display: block; }
#policy-modal textarea { width: 100%; box-sizing: border-box; min-height: 56px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; resize: vertical; }

/* 任务卡右键菜单 */
.ctx-backdrop { position: fixed; inset: 0; z-index: 60; }
.ctx-menu { position: fixed; z-index: 61; min-width: 172px; background: #fff; border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 10px 30px rgba(30,30,60,.18); padding: 4px; }
.ctx-title { padding: 6px 10px 4px; color: var(--muted); font-size: 11px; border-bottom: 1px solid var(--border); margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
.ctx-menu button { display: block; width: 100%; text-align: left; padding: 6px 10px; background: none; border: 0; border-radius: 6px; cursor: pointer; font-size: 12.5px; color: var(--ink); font-family: inherit; }
.ctx-menu button:hover { background: var(--tint); }
.ctx-menu button.danger { color: var(--danger); }
.ctx-menu button.danger:hover { background: #fce4e4; }
.ctx-sep { height: 1px; background: var(--border); margin: 4px 0; }

/* 阻塞选择器（任务表单） */
.blk-picked { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 5px; min-height: 22px; align-items: center; }
.blk-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 2px 4px 2px 8px; background: var(--accent-soft); color: var(--accent); border-radius: 999px; }
.blk-x { background: none; border: 0; cursor: pointer; color: inherit; font-size: 13px; line-height: 1; padding: 0 3px; border-radius: 50%; }
.blk-x:hover { background: rgba(0,0,0,.08); }
.blk-empty { font-size: 11px; color: var(--muted); }
.blk-pick { width: 100%; }
/* 日志视图的拖入提示 */
.logs-view.drop-target { outline: 2px dashed var(--accent); outline-offset: -6px; }


/* Calendar view（视觉对齐老版 board.html） */
/* ⚠ #board 是「横排看板」布局：display:flex + align-items:flex-start。
   column 方向的视图会继承 flex-start，子元素于是按**内容宽度**收缩 ——
   日历格子因此变成一排细长竖条、右边大片空白（用户反复反馈"丑得要死"）。
   非看板视图必须显式改回 stretch。 */
#board.calendar-view,
#board.todos-view,
#board.logs-view,
#board.blockers-view,
#board.launchpad,
#board.roadmap-view,
#board.trash-view,
#board.skills-view,
#board.services-view { align-items: stretch; }
.calendar-view { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
.calhead { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.calhead .m { font-size: 15px; font-weight: 700; min-width: 120px; }
.cal-hint { font-size: 11px; color: var(--muted); margin-left: auto; }
.calgrid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; width: 100%; }
.caldow { font-size: 11px; color: var(--muted); text-align: center; font-weight: 700; padding: 3px 0; }
.calcell { background: #fff; border: 1px solid var(--border); border-radius: 10px; min-height: 92px; padding: 5px 6px; overflow: hidden; display: flex; flex-direction: column; gap: 3px; transition: border-color .15s, background .15s; }
.calcell.blank { background: transparent; border: 0; }
.calcell.today { border-color: var(--accent); background: var(--tint-2); box-shadow: 0 0 0 2px rgba(155,143,196,.22); }
.calcell.past { background: #fbf7f7; }
.calcell.past .dnum { color: #767b8b; }
.calcell.dragover { outline: 2px dashed var(--accent); outline-offset: -2px; background: var(--tint); }
.dnum { font-size: 11px; color: var(--muted); font-weight: 700; margin-bottom: 1px; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; }
.calcell.today .dnum { color: #fff; background: var(--accent); border-radius: 999px; }
.cev { font-size: 10.5px; background: #f5f4fa; border: 1px solid var(--border); border-radius: 6px; padding: 2px 5px; margin-bottom: 3px; cursor: pointer; display: flex; gap: 4px; align-items: center; overflow: hidden; white-space: nowrap; }
.cev:hover { background: var(--tint); border-color: var(--accent-soft); }
.cev .pd { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.cev .t { overflow: hidden; text-overflow: ellipsis; }
/* 格子内折叠（2026-09-29 卡 035 用户选的「改法 A」）：最多 2 条 + 「+N 条」，
   点它就地把这一天铺满（不跳页、不弹窗），再点收起。时间段任务不参与折叠。 */
.cal-cell-more {
  align-self: flex-start; flex: none; margin-top: 1px; padding: 1px 6px;
  background: transparent; border: 0; border-radius: 6px; cursor: pointer;
  font-family: inherit; font-size: 10.5px; font-weight: 600; color: var(--accent); line-height: 1.5;
}
.cal-cell-more:hover { background: var(--tint); }
.cal-cell-more.less { color: var(--muted); font-weight: 500; }
.calunsched { margin-top: 12px; }
/* 底部「横条墙」收成一行摘要（2026-09-25 用户第 10 条） */
.cal-more { display: inline-flex; align-items: center; gap: 6px; background: #fff; border: 1px solid var(--border); border-radius: 999px; padding: 5px 13px; font-size: 11.5px; color: var(--muted); cursor: pointer; font-family: inherit; transition: border-color .15s, color .15s; }
.cal-more:hover { border-color: var(--accent-soft); color: var(--ink); }
.cal-more b { color: var(--accent); font-weight: 700; }
.cal-more .caret { display: inline-block; font-size: 10px; transition: transform .15s; }
.cal-more .caret.open { transform: rotate(90deg); }
.cal-more-hint { font-size: 10.5px; color: var(--accent); }
.cal-more-body { margin-top: 10px; }
.calunsched h4 { font-size: 12px; color: var(--muted); margin: 0 0 6px; }
.calunsched .items { display: flex; flex-wrap: wrap; gap: 8px; }
.calunsched .cev { background: #fff; border: 1px solid var(--border); min-width: 140px; padding: 4px 9px; }

/* ── 日历：时间段色带 + 待办标识（2026-09-22）──────────────────────────
   跨天任务在每一天的格子里各画一段，靠 span-start/mid/end 去掉内侧圆角与外边距，
   横向看起来连续（格子本身有间距，做不到真·一根条形，但语义连续已足够）。 */
.cev.span-start { border-top-right-radius: 0; border-bottom-right-radius: 0; border-right-width: 0; }
.cev.span-mid   { border-radius: 0; border-left-width: 0; border-right-width: 0; }
.cev.span-end   { border-top-left-radius: 0; border-bottom-left-radius: 0; border-left-width: 0; }
.cev.span-start { background: var(--tint); }
.cev.span-mid   { background: var(--tint); }
.cev.span-end   { background: var(--tint); }
.cev.cev-todo { background: #eef4fd; border-color: #d5e3f7; }
.cev.cev-todo:hover { background: #e3eefc; border-color: #a9c8ee; }
.cev.cev-log { background: #f3f0fa; border-color: #e0daf5; }
.cev.cev-log:hover { background: #ece8f8; border-color: #c4b8e8; }
.calunsched .cev.chip { cursor: grab; }
.calunsched .cev.chip.other { background: #fbf7f1; border-color: #efdfc8; color: #8a7040; }
.cal-hint-inline { font-size: 10.5px; color: var(--accent); margin-left: 6px; font-weight: 500; }
.cal-other-head { margin-top: 12px !important; }
.cal-empty { font-size: 11px; color: var(--muted); }
.cal-chk { margin-left: 8px; }

#cal-assign-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 420px; box-shadow: var(--shadow); border: 1px solid var(--border); }
#cal-assign-modal h3 { margin: 0 0 8px; font-size: 16px; }
#cal-assign-modal .ca-title { font-size: 13px; font-weight: 600; color: var(--ink); background: var(--tint); border-radius: 8px; padding: 6px 10px; margin-bottom: 6px; }
#cal-assign-modal label { display: block; font-size: 11px; font-weight: 600; color: var(--muted); margin: 10px 0 4px; }
#cal-assign-modal input[type="date"] { width: 100%; box-sizing: border-box; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }
#cal-assign-modal .ca-quick { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
#cal-assign-modal .acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.todo-due { font-size: 10px; color: #3f6fa8; background: #eef4fd; border: 1px solid #d5e3f7; padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
/* 待办行尾的两枚图标按钮（2026-09-29 卡 027）：按规范收成 24×24，
   不再是一个 padding:0 4px、一个是裸文字。 */
.todo-assign { display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: var(--btn-h-sm); height: var(--btn-h-sm); padding: 0; cursor: pointer;
  background: transparent; border: 1px solid transparent; border-radius: var(--btn-r);
  color: var(--muted); font-size: 12px; line-height: 1; }
.todo-assign:hover { color: var(--accent); background: var(--tint); border-color: var(--accent-soft); }

/* Todos view */
.todos-view { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
.todos-view.drop-target { outline: 2px dashed var(--accent); outline-offset: -6px; }
/* 拖放提示统一为「固定悬浮层」：text-align/padding 那套会参与文档流，
   一出现就把下方内容顶下去 → 光标相对内容位移 → dragleave/dragover 自激闪烁
   （用户第 5 条「抖动、不能稳定显示」的真因）。固定定位 + pointer-events:none 根治。 */
.todo-drop-hint, .log-drop-hint, .drop-hint {
  position: fixed; left: 50%; top: 92px; transform: translateX(-50%);
  z-index: 60; pointer-events: none;
  background: rgba(112,95,171,.96); color: #fff;
  border-radius: 999px; padding: 8px 18px;
  font-size: 12px; font-weight: 700; white-space: nowrap;
  box-shadow: 0 8px 24px rgba(90,90,130,.28);
}
.drop-hint.global { background: rgba(107,113,128,.97); }
.todo-project { font-size: 10px; color: var(--muted); background: var(--bg); border: 1px solid var(--border); padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
.todos-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.todos-header h3 { font-size: 16px; font-weight: 700; }
.todos-ctrls { display: flex; gap: 8px; align-items: center; }
.todo-filter { padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }
.todos-list { display: flex; flex-direction: column; gap: 6px; }
/* ── 待办行 = 两行卡（2026-09-29 用户拍板：「待办行改成两行卡」）──────────
   上行：置顶徽标 + 标题（标题占满整行，不再和一堆按钮抢宽度）
   下行：优先级 / 项目 / 到期 · 右侧动作
   勾选框跨两行居中偏上。用的还是同一份 DOM —— 卡片网格只换 grid 模板。 */
.todo-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-rows: auto auto;
  column-gap: 10px; row-gap: 1px;
  align-items: center;
  padding: 7px 12px;
  background: #fff; border: 1px solid var(--border); border-radius: 10px;
  box-shadow: var(--shadow); transition: background 0.15s;
}
.todo-item:hover { background: var(--tint); }
.todo-item.prio { border-left: 3px solid var(--danger); }
.todo-item.done { opacity: 0.5; }
.todo-item.done .todo-title { text-decoration: line-through; }
.todo-chk { grid-column: 1; grid-row: 1 / span 2; width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent); margin-top: 3px; }
.todo-body { grid-column: 2; grid-row: 1 / span 2; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.todo-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
/* ⚠ 第二行**不能叫 `.meta`**：样式表里另有一条全局 `.meta`（任务详情弹窗的字段组，
   `display:flex; flex-direction:column; margin-bottom:12px`）。同特异性下按出现顺序取胜，
   于是「优先级」会在 column 布局里被 `align-items:center` 顶到**行的正中** ——
   肉眼看着像"两行卡没做出来"。这类**class 名撞车**只有真跑起来量几何才发现得了，
   所以下面那条断言里专门钉住了 flex-direction 与 y 位置。 */
.todo-line.metas { gap: 8px; flex-wrap: wrap; }
.todo-acts { grid-column: 3; grid-row: 1 / span 2; display: inline-flex; align-items: center; gap: 2px; }
.todo-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; cursor: pointer; }
.todo-prio { font-size: 10px; padding: 1px 6px; border-radius: 6px; background: #fee2e2; color: #991b1b; font-weight: 600; }
/* ── 待办专项整修（2026-09-26 卡 033）────────────────────────────────── */
.todos-stats {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  font-size: 12px; color: var(--muted); margin: -6px 0 8px;
}
.todos-overdue-count { color: #b3261e; font-weight: 600; }
.todos-hidden { color: #8a5a00; }
.todos-clear {
  font-family: inherit; font-size: 11.5px; cursor: pointer;
  padding: 2px 9px; border-radius: 8px; border: 1px solid var(--border);
  background: #fff; color: var(--ink);
}
.todos-clear:hover { border-color: var(--accent); color: var(--accent); }
.todos-health {
  font-size: 12.5px; color: #b3261e; background: #fdf2f1; border: 1px solid #e6c3c0;
  border-radius: 10px; padding: 9px 12px; margin-bottom: 10px; line-height: 1.6;
}
.todo-due.overdue { color: #b3261e; background: #fdf2f1; border-color: #e6c3c0; font-weight: 600; }
.todo-prio.prio-high { background: #fee2e2; color: #991b1b; border: 1px solid #f5c2c2; }
.todo-prio.prio-mid { background: #fef3c7; color: #92400e; border: 1px solid #f5e0a3; }
.todo-prio.prio-low { background: #eceff3; color: #5b6470; border: 1px solid #d8dde4; }
.todo-del { display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: var(--btn-h-sm); height: var(--btn-h-sm); padding: 0; cursor: pointer;
  background: transparent; border: 1px solid transparent; border-radius: var(--btn-r);
  color: var(--muted); font-size: 14px; line-height: 1; }
.todo-del:hover { color: var(--danger); background: #fce4e4; border-color: #f0cfcf; }

/* ── 待办 · 卡片网格（多视图第 2 项，卡 033 用户点名的「方块卡片式」）──────
   用户原话：「我要的方块卡片式视图和其他视图也没出现，多视图根本没做。」
   做法：**同一份 DOM 换摆法**（`order` 重排 + flex-wrap），不是把卡片再写一遍 ——
   再写一遍意味着"改一个字段要改两处"，那正是这类视图最容易烂掉的方式。
   卡片里**放优先级、不放操作按钮**（点标题进编辑、右键出菜单，卡面保持干净）；
   操作按钮平时压暗、悬停才亮，沿用清单视图已有的 `.todo-edit` 规矩。 */
.todos-list.as-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 8px; align-items: start;
}
.todos-list.as-grid .empty-state { grid-column: 1 / -1; }
.todos-list.as-grid .todo-item {
  /* 同一份 DOM 换 grid 模板：勾选在左上，正文跨满两列，动作按钮贴底右对齐 */
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto 1fr auto;
  align-content: space-between;
  column-gap: 8px; row-gap: 3px;
  min-height: 92px; padding: 9px 11px; border-radius: 11px;
  box-shadow: 0 1px 2px rgba(90,90,130,0.05);
}
.todos-list.as-grid .todo-item:hover { background: var(--tint-2); box-shadow: 0 3px 12px rgba(90,90,130,0.12); }
.todos-list.as-grid .todo-chk { grid-column: 1; grid-row: 1; margin-top: 1px; }
.todos-list.as-grid .todo-body { grid-column: 1 / -1; grid-row: 2; }
.todos-list.as-grid .todo-line { align-items: flex-start; }
.todos-list.as-grid .todo-title {
  font-size: 12.5px; font-weight: 600; line-height: 1.45;
  white-space: normal;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
  overflow: hidden; word-break: break-word;
}
.todos-list.as-grid .todo-acts { grid-column: 1 / -1; grid-row: 3; justify-content: flex-end; }

/* Logs view */
.logs-view { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
.logs-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.logs-header h3 { font-size: 16px; font-weight: 700; }
.logs-ctrls { display: flex; gap: 8px; align-items: center; }
.log-search { width: 240px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }
.log-search::placeholder { color: #9ca3af; font-size: 10.5px; }
.log-filter { padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }
.logs-list { display: flex; flex-direction: column; gap: 8px; }
/* 日志卡（2026-09-28 用户第 4/5 条）：
   状态**不再靠"左边一条竖线"区分** —— 用户原话「竖条好几条，越看越头痛」。
   待处理/已完成/已归档三种状态改用徽章颜色 + 极淡的卡底差异表达；
   只有「进行中」保留一条醒目色条，因为它是唯一需要一眼扫到的状态。
   阴影也从 var(--shadow)（0 8px 32px，几乎是浮起来的）压到 1px 的贴地投影。 */
.log-card { padding: 10px 14px; background: #fff; border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 1px 3px rgba(90,90,130,0.06); transition: background 0.15s, box-shadow 0.15s; cursor: pointer; }
.log-card:hover { background: var(--tint-2); box-shadow: 0 3px 12px rgba(90,90,130,0.12); }
.log-card.completed { background: #fcfdfb; }
.log-card.archived { background: #fafafb; opacity: .82; }
.log-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.log-status-badge { font-size: 10px; padding: 1px 6px; border-radius: 6px; font-weight: 600; }
/* 待处理 = 中性灰，刻意不抢眼：它是「默认态」，不是一种"进展" */
.log-status-badge.active { background: #eceef2; color: #4b5162; }
/* 进行中 = 唯一的醒目徽章（只能手动打上） */
.log-status-badge.running { background: #dbeafe; color: #1d4ed8; }
.log-status-badge.completed { background: #dcfce7; color: #166534; }
.log-status-badge.archived { background: #f3f4f6; color: #5f6672; }
.log-card-title { flex: 1; font-size: 13px; font-weight: 600; }
.log-card-date { font-size: 10.5px; color: var(--muted); }
.log-card-body { font-size: 12px; color: var(--muted); margin-bottom: 6px; line-height: 1.4; }
.log-card-meta { display: flex; gap: 10px; font-size: 10.5px; color: var(--muted); }
.log-project { font-size: 10px; color: var(--muted); background: var(--bg); border: 1px solid var(--border); padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
.log-task { color: var(--accent); }
.log-completed { color: #5e9154; }
.log-agent { color: #8b7fb8; }
.log-prev-agent { color: #8b7fb8; }
.log-session { color: #6b7a99; font-family: monospace; font-size: 9.5px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 日志 ID：卡面可见 + 点一下只复制 ID（2026-09-29 用户第 2 条）。
   --muted 压底色 = 4.95，过 WCAG AA；虚线下划线是「可点复制」的通用暗示。 */
.log-id { color: var(--muted); font-family: ui-monospace, Consolas, monospace; font-size: 10px; max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: copy; border-bottom: 1px dotted var(--border); user-select: none; }
.log-id:hover { color: var(--accent); border-bottom-color: var(--accent); }
.log-card.selected { border-color: var(--accent); background: var(--tint); box-shadow: 0 0 0 2px rgba(100, 80, 200, 0.2); }
.log-card-actions { display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; }

/* Agent 预设列表（2026-09-23） */
.agent-presets-list { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.agent-preset-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; background: #f3f0fa; border: 1px solid #e0daf5; border-radius: 12px; font-size: 11px; color: #6b5b9e; }
.agent-preset-del { background: none; border: 0; cursor: pointer; color: #b0a0d0; font-size: 13px; padding: 0 2px; border-radius: 50%; line-height: 1; }
.agent-preset-del:hover { color: #c96a6a; background: #f0e8e8; }
.agent-presets-add { display: flex; gap: 6px; }
.agent-presets-add input { flex: 1; padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }

/* Log edit modal */
/* 2026-09-25 第 13 条「编辑框不够大」：原宽 560px，且 `textarea.tall` 的高度规则只写在
   `#modal textarea.tall` 下 —— 日志编辑器是 #log-edit-modal，**`.tall` 从未生效**，
   所以「执行内容」一直是个 2 行的小框。这里把宽度与两个框的高度都补上。 */
#log-edit-modal, #relay-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 720px; max-width: calc(100vw - 48px); max-height: 88vh; overflow-y: auto; box-shadow: var(--shadow); border: 1px solid var(--border); }
#log-edit-modal h3, #relay-modal h3 { margin: 0 0 12px; font-size: 16px; }
#log-edit-modal label, #relay-modal label { display: block; font-size: 11px; font-weight: 600; color: var(--muted); margin: 10px 0 4px; }
#log-edit-modal input, #relay-modal input { width: 100%; box-sizing: border-box; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }
#log-edit-modal textarea, #relay-modal textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; font-family: inherit; resize: vertical; line-height: 1.6; min-height: 90px; }
#log-edit-modal textarea.tall { min-height: 300px; }
#log-edit-modal .acts, #relay-modal .acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
#log-edit-modal select.logsel, #relay-modal select.logsel {
  width: 100%; box-sizing: border-box; padding: 7px 10px;
  border: 1px solid var(--border); border-radius: 8px;
  font-size: 13px; background: #fff; color: var(--ink); outline: none; font-family: inherit;
}
#log-edit-modal select.logsel:disabled, #relay-modal select.logsel:disabled { background: #f6f6f9; color: var(--muted); }
#log-edit-modal .log-task-picked { font-size: 11px; color: var(--accent); margin-top: 4px; }

/* 待办编辑弹窗（2026-09-25 第 12、14 条）：**大框**，写长内容不憋屈 */
#todo-edit-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 640px; max-width: calc(100vw - 48px); max-height: 88vh; overflow-y: auto; box-shadow: var(--shadow); border: 1px solid var(--border); }
#todo-edit-modal h3 { margin: 0 0 12px; font-size: 16px; }
#todo-edit-modal label { display: block; font-size: 11px; font-weight: 600; color: var(--muted); margin: 10px 0 4px; }
#todo-edit-modal input, #todo-edit-modal select { width: 100%; box-sizing: border-box; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; background: #fff; color: var(--ink); outline: none; font-family: inherit; }
#todo-edit-modal textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; font-family: inherit; resize: vertical; line-height: 1.6; }
/* 内容框必须够大 —— 这条就是用户「改模态大框」的核心诉求 */
#todo-edit-modal textarea.tall { min-height: 180px; }
.te-row { display: grid; grid-template-columns: 1fr 110px 150px; gap: 10px; }
#todo-edit-modal .acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
#todo-edit-modal .todo-edit-donehint { color: var(--muted); font-size: 11px; margin-top: 8px; }
/* 「改」字按钮 —— 2026-09-29 卡 027 的**真凶**：这里此前只有 opacity + font-size，
   border / background / padding 一条都没写 → 它吃的是**浏览器默认按钮长相**
   （灰底方框 + 黑字），和旁边两个裸文字按钮凑成"三种字号三种圆角"。
   现在收进规范：24px 安静按钮。处理「平时压暗、悬停才亮」的规矩保留 —— 那是降噪不是风格。 */
.todo-edit { display: inline-flex; align-items: center; justify-content: center; flex: none;
  height: var(--btn-h-sm); padding: 0 9px; cursor: pointer;
  background: transparent; border: 1px solid transparent; border-radius: var(--btn-r);
  color: var(--muted); font-size: 11.5px; font-weight: 600; line-height: 1;
  opacity: .55; transition: opacity .15s, background .15s, color .15s, border-color .15s; }
.todo-item:hover .todo-edit { opacity: 1; }
.todo-edit:hover { background: var(--tint); color: var(--ink); border-color: var(--accent-soft); opacity: 1; }
.todo-new { flex-shrink: 0; white-space: nowrap; font-size: 12px; }

/* 日志页「按状态分区」的分区头（2026-09-28 用户第 2/5 条）——
   取代旧的单个「已归档」分隔条：状态从此由分区表达，而不是由一个下拉去筛。 */
.log-group-sep { margin: 10px 0 2px; display: flex; align-items: center; gap: 10px; }
.log-group-sep:first-child { margin-top: 0; }
.log-group-sep::after { content: ''; flex: 1; height: 1px; background: var(--border); }
.log-group-toggle {
  display: inline-flex; align-items: center; gap: 7px; flex: none;
  background: #fff; border: 1px solid var(--border); border-radius: 99px;
  padding: 4px 12px 4px 10px; font-size: 12px; color: var(--ink);
  cursor: pointer; font-family: inherit; user-select: none;
}
.log-group-toggle:hover { border-color: var(--accent-soft); background: var(--tint-2); }
/* 三角同样用 CSS 边框画（▸/▾ 字形在应用字体里可能缺字，渲染成看不见的空白） */
.log-group-toggle .chev {
  flex: 0 0 auto; width: 0; height: 0;
  border-left: 5px solid #8b8b9e; border-top: 4px solid transparent; border-bottom: 4px solid transparent;
  transition: transform 0.15s ease;
}
.log-group-toggle .chev.open { transform: rotate(90deg); }
.log-group-toggle .gdot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
.log-group-toggle .glabel { font-weight: 700; }
.log-group-toggle .gn { background: var(--accent-soft); color: #4a4368; border-radius: 999px; padding: 0 7px; font-size: 11px; font-weight: 600; }
.log-group-sep.g-pinned .gdot { background: var(--warning); }
.log-group-sep.g-running .gdot { background: #5a5ce0; }
.log-group-sep.g-active .gdot { background: #9ca3af; }
.log-group-sep.g-completed .gdot { background: var(--success); }
.log-group-sep.g-archived .gdot { background: #b6b2c4; }
.log-group-hint { font-size: 11px; color: var(--muted); white-space: nowrap; }

/* ── 日志接力（2026-09-29 第 3 条方案二）：分段开关 / 链头 / 竖轨 / 链标签 / 接力对话框 ── */
/* 分区｜按链 分段开关（默认分区；颜色全部走主题令牌，六套主题同源） */
.log-view-seg { display: inline-flex; align-items: center; gap: 2px; padding: 2px; background: var(--tint-3); border: 1px solid var(--border); border-radius: 999px; }
.log-view-seg .lvs {
  font: inherit; font-size: 11.5px; font-weight: 600; color: var(--muted);
  background: transparent; border: none; border-radius: 999px; padding: 3px 11px; cursor: pointer;
  transition: background 0.12s, color 0.12s, transform 0.08s;
}
.log-view-seg .lvs:hover { background: var(--tint-2); color: var(--ink); }
.log-view-seg .lvs:active { transform: translateY(1px) scale(0.98); }
.log-view-seg .lvs.on { background: var(--accent); color: #fff; }
.log-view-seg .lvs.on:hover { background: var(--accent); color: #fff; }

/* section 包裹层：分区/单条 = display:contents（对布局透明）；链 = 竖轨 */
.log-section { display: contents; }
.log-section.chain-rail {
  display: flex; flex-direction: column; gap: 8px;
  position: relative; padding-left: 22px; margin-bottom: 10px;
}
.chain-rail::before {
  content: ""; position: absolute; left: 6px; top: 6px; bottom: 26px;
  width: 2px; background: var(--accent-soft); border-radius: 2px;
}
.chain-rail .log-card { position: relative; }
.chain-rail .log-card::before {
  content: ""; position: absolute; left: -21px; top: 16px; width: 9px; height: 9px;
  border-radius: 50%; background: #fff; border: 2px solid var(--accent);
}
.chain-rail .log-card:last-child::before { background: var(--accent); }

/* 链头 */
.chain-header {
  display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
  background: linear-gradient(180deg, var(--tint) 0%, var(--tint-2) 60%);
  border: 1px solid var(--accent-soft); border-radius: 12px;
  padding: 9px 12px; margin-top: 6px;
}
.chain-header .chain-ic { font-size: 13px; }
.chain-header .chain-name { font-size: 12.5px; font-weight: 700; color: var(--ink); }
.chain-header .chain-meta { font-size: 11px; color: var(--muted); }
.chain-header .chain-grow { flex: 1; }

/* 卡面链标签：可点击复制源 ID */
.chain-tag {
  display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px;
  color: var(--accent); background: var(--tint);
  border: 1px solid var(--accent-soft); border-radius: 999px; padding: 0 7px;
  cursor: copy; white-space: nowrap;
}
.chain-tag:hover { border-color: var(--accent); }

/* 「⏭ 从这里继续」：完成态卡上唯一的接力入口，视觉上和普通 ghost 区分开 */
.log-card-actions .relay-btn { background: var(--tint); border-color: var(--accent-soft); color: var(--accent); font-weight: 600; }
.log-card-actions .relay-btn:hover { border-color: var(--accent); }

/* 接力对话框：源摘要条 + 两个出清开关 */
.relay-src {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  background: var(--tint); border: 1px solid var(--accent-soft);
  border-radius: 9px; padding: 7px 9px; font-size: 11.5px; color: var(--ink);
  margin: 8px 0 12px;
}
.relay-src .rs-label { font-weight: 700; color: var(--accent); }
.relay-src .rs-id { font-family: ui-monospace, Consolas, monospace; color: var(--muted); }
.relay-src .rs-grow { flex: 1; }
#relay-modal .hint { font-size: 11.5px; color: var(--muted); line-height: 1.6; }
/* 2026-10-02「带入源的下一步」：下一步标签行改 flex —— 左边是标签、右端挂取用按钮。
   预填已取消（默认留空），这个按钮是唯一取回源内容的入口，所以必须常显、不藏 hover。 */
#relay-modal label.ns-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
#relay-modal label.ns-label .relay-bring { height: 24px; padding: 0 9px; font-size: 11px; margin: 0; flex: none; }
#relay-modal .hint b { color: var(--accent); font-weight: 600; }
.relay-opts { border-top: 1px dashed var(--line-2); margin-top: 12px; padding-top: 10px; display: grid; gap: 7px; }
/* id 作用域：#relay-modal label / #relay-modal input 两条通用规则（1,0,x）会压过纯类选择器，
   这里必须带上 id（1,1,x）才能拿回 flex 布局与 14px 复选框 —— 与日志编辑器同一坑位。 */
#relay-modal .relay-opt { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; font-weight: 400; color: var(--ink); margin: 0; cursor: pointer; }
#relay-modal .relay-opt input[type="checkbox"] { width: 14px; height: 14px; margin-top: 2px; flex: none; accent-color: var(--accent); }
#relay-modal .relay-opt span i { display: block; font-style: normal; font-size: 11px; color: var(--muted); }

/* 关闭防丢确认条（2026-09-30 卡 006）：必须比正文抢眼、按钮大到不会点错。
   底色用主题 --tint（六套主题都有浅底），边框与「丢弃」按钮用 --danger（白字压它 ≥4.5）。 */
/* 防丢警告条：接力与日志编辑**共用同一套**（卡005 统一实现，:is 一次圈两个宿主） */
:is(#relay-modal, #log-edit-modal) .relay-discard { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 14px; padding: 9px 11px; border-radius: 10px; background: var(--tint); border: 1px solid var(--danger); font-size: 12.5px; line-height: 1.6; color: var(--ink); }
:is(#relay-modal, #log-edit-modal) .relay-discard .rd-text { flex: 1 1 260px; }
:is(#relay-modal, #log-edit-modal) .relay-discard .rd-text b { color: var(--danger); font-weight: 700; }
:is(#relay-modal, #log-edit-modal) .relay-discard .rd-acts { display: flex; gap: 8px; flex: none; }
:is(#relay-modal, #log-edit-modal) .relay-discard .rd-acts button { height: 30px; padding: 0 14px; border-radius: 8px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
:is(#relay-modal, #log-edit-modal) .relay-discard .rd-acts .ghost { background: #fff; color: var(--ink); border: 1px solid var(--border); }
:is(#relay-modal, #log-edit-modal) .relay-discard .rd-acts .danger { background: var(--danger); color: #fff; border: 0; }

/* 「更多筛选」抽屉（2026-09-28 用户第 5 条）：Agent / 日期范围不再和搜索框挤一条线 */
.log-more-btn { position: relative; }
.log-more-btn.on { background: var(--tint); border-color: var(--accent-soft); }
.log-more-btn .more-badge {
  display: inline-block; margin-left: 5px; min-width: 15px; text-align: center;
  background: var(--accent); color: #fff; border-radius: 999px;
  font-size: 10px; font-weight: 700; padding: 0 4px;
}
.log-filter-sep { color: var(--muted); font-size: 11px; }

/* 导出下拉的样式（2026-09-25 第 10 条）已在 2026-09-26 移除：导出改成一次点击、只落一个 zip，
   不再要用户从下拉里逐字核对文件名。 */

/* 「进行中」的卡面（2026-09-26 用户补充第 3 条 → 2026-09-28 归位到 running）：
   原来它挂在 `.log-card.active` 上，而 active 是**每一条新建日志的默认状态** →
   等于"所有日志都是醒目的进行中"，这正是用户第 2 条说「一创建就是进行中、看着混乱」的观感来源。
   现在只有手动开了进行中的卡片才有这套外观。 */
.log-card.running {
  border-left: 4px solid var(--accent);
  background: linear-gradient(90deg, #f1eefe 0%, #fff 55%);
  box-shadow: 0 0 0 1px rgba(112, 95, 171, 0.22), 0 2px 10px rgba(90, 90, 130, 0.08);
}
.log-card.running .log-status-badge.running { background: #5a5ce0; color: #fff; }
.log-card.running .log-card-title { color: #4a3f7d; }
/* 手动开关按钮：打开时点亮，一眼看出"这条正在跑" */
.log-run-btn.on { background: #eef4ff; border-color: #9dbdf0; color: #1d4ed8; }
/* 列表首行 = 最新一份（按最后更新倒序）—— 面对一堆 .zip 时不用自己找 */
.bk-newest { flex: none; font-size: 10px; font-weight: 700; color: #3f6b3a; background: #e3f1de; border: 1px solid #bcd4b4; border-radius: 99px; padding: 1px 7px; }
/* 设置页「禁用硬件加速」（2026-09-25 第 1/3/9 条的人工验证杠杆） */
.gpu-chk { display: flex; align-items: flex-start; gap: 6px; font-size: 12px; color: var(--muted); margin-top: 8px; cursor: pointer; line-height: 1.5; }
.gpu-chk input { flex: none; margin-top: 2px; }

/* 项目章程缺口条（第 7 条） */
.charter-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 12px; margin-bottom: 10px; background: #fff; border: 1px solid var(--border); border-radius: 10px; font-size: 12px; }
.charter-bar .cb-label { font-weight: 700; color: var(--ink); }
.charter-bar .cb-stat { color: var(--muted); }
.charter-bar .cb-stat b { color: var(--ink); }
.charter-bar .cb-stat.warn b { color: #c0392b; }
/* 结构地图入口（029）：常驻可点，缺口>0 时变警示色 —— 用户驳回原话「找不到在哪里」 */
.cb-map-btn { margin-left: auto; flex: none; display: inline-flex; align-items: center; gap: 5px; }
.cb-map-btn.warn { border-color: #e6b8ae; background: #fdf6f4; color: #8a4038; }
.cb-map-n { background: #eceef2; color: #4b5162; border-radius: 99px; padding: 0 7px; font-size: 11px; }
.cb-map-btn.warn .cb-map-n { background: #f6d9d2; color: #8a4038; }
.cb-map-n.ok { background: #e6f4e2; color: #3c6b35; }

/* 结构地图弹窗（029） */
#smap-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 640px; max-width: calc(100vw - 48px); max-height: 84vh; overflow-y: auto; box-shadow: var(--shadow); border: 1px solid var(--border); }
#smap-modal h3 { margin: 0 0 8px; font-size: 15px; display: flex; align-items: baseline; gap: 8px; }
.smap-sub { font-size: 11px; font-weight: 400; color: var(--muted); }
.smap-hint { font-size: 12px; color: var(--muted); line-height: 1.6; margin-bottom: 12px; }
.smap-list { display: flex; flex-direction: column; gap: 6px; }
.smap-item { display: flex; align-items: center; gap: 9px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: #fff; }
.smap-item.missing { background: #fdfaf9; border-color: #ecd8d3; }
.smap-item.nopolicy { background: #fbfbfc; border-style: dashed; }
.smap-dot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--success); }
.smap-item.missing .smap-dot { background: var(--warning); }
.smap-item.nopolicy .smap-dot { background: #b6b2c4; }
.smap-main { flex: 1; min-width: 0; }
.smap-name { font-size: 12.5px; font-weight: 600; }
.smap-meta { font-size: 11px; color: var(--muted); }
.smap-open { flex: none; }
/* 方针弹窗里的结构地图小节（029）：要够高，第一行是「最后核实」日期 */
#policy-modal textarea.tall { min-height: 190px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.6; }
.pf-label-hint { display: block; font-weight: 400; color: var(--muted); font-size: 10.5px; margin-top: 2px; line-height: 1.5; }
.pf-map-tools { display: flex; align-items: center; gap: 10px; margin-top: 6px; flex-wrap: wrap; }
.pf-map-tip { font-size: 10.5px; color: var(--muted); }
.todo-title { cursor: pointer; }
.todo-title:hover { text-decoration: underline dotted; }

/* Dispatch modal */

/* Review modal */
#review-modal { background: #fff; border-radius: 16px; padding: 18px 20px; width: 460px; box-shadow: var(--shadow); border: 1px solid var(--border); }
#review-modal h3 { margin: 0 0 12px; font-size: 16px; }
.review-info { margin-bottom: 12px; }
.review-task-title { font-size: 14px; font-weight: 700; }
.review-task-id { font-size: 11px; color: var(--muted); }
.review-reason { width: 100%; box-sizing: border-box; min-height: 80px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; font-family: inherit; resize: vertical; line-height: 1.5; }

/* ============ Notification Center（原型 notification-center.html 移植） ============ */
.nc-bell { position: relative; }
.nc-badge {
  position: absolute; top: -4px; right: -4px;
  background: #FF3B30; color: #fff; font-size: 10px; font-weight: 700;
  padding: 1px 5px; border-radius: 99px; min-width: 16px; text-align: center;
  box-shadow: 0 2px 7px rgba(255,59,48,.36);
  animation: nc-pop .5s cubic-bezier(.34,1.4,.64,1) both;
}
@keyframes nc-pop { from { transform: scale(.4); opacity: 0 } to { transform: scale(1); opacity: 1 } }

.nc-wrap {
  position: fixed; inset: 0; z-index: 70;
  background: rgba(30,30,40,.38);
  transform: translateZ(0); /* 同上：全屏面不做实时模糊，否则失焦时合成器不重绘 */
  display: flex; align-items: flex-start; justify-content: flex-end;
  padding: 60px 24px 24px;
}
.nc-panel {
  width: 460px; max-width: calc(100vw - 48px); max-height: calc(100vh - 120px);
  background: #fff; border: 1px solid var(--border); border-radius: 16px;
  box-shadow: 0 24px 64px rgba(0,0,0,.18);
  display: flex; flex-direction: column; overflow: hidden;
  animation: nc-in .34s cubic-bezier(.16,1,.3,1) both;
}
@keyframes nc-in { from { opacity: 0; transform: translateY(-10px) scale(.98) } to { opacity: 1; transform: none } }

.nc-head { padding: 16px 18px 0; border-bottom: 1px solid var(--border); }
.nc-head-title h1 { font-size: 17px; font-weight: 700; letter-spacing: -.02em; display: flex; align-items: center; gap: 8px; }
.nc-count {
  background: #FF3B30; color: #fff; font-size: 11px; font-weight: 700;
  padding: 2px 7px; border-radius: 99px; min-width: 20px; text-align: center;
  box-shadow: 0 2px 7px rgba(255,59,48,.36);
}
.nc-head-title p { font-size: 12px; color: var(--muted); margin-top: 4px; }
.nc-head-act { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.nc-icon-btn {
  width: 30px; height: 30px; padding: 0; border-radius: 8px;
  border: 1px solid var(--border); background: rgba(255,255,255,.6); color: var(--muted);
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  font-size: 14px; transition: background .16s, color .16s;
}
.nc-icon-btn:hover { background: #fff; color: var(--ink); }
.nc-icon-btn.spin .nc-ico { display: inline-block; animation: nc-spin .7s cubic-bezier(.16,1,.3,1); }
@keyframes nc-spin { to { transform: rotate(360deg) } }
.nc-btn-primary {
  height: 30px; padding: 0 12px; border-radius: 8px; border: 0;
  background: var(--ink); color: #fff; font-size: 12px; font-weight: 600;
  cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
  font-family: inherit; transition: opacity .16s;
}
.nc-btn-primary:disabled { opacity: .35; cursor: default; }

.nc-filters { display: flex; align-items: center; gap: 12px; padding: 10px 18px; border-bottom: 1px solid var(--border); }
.nc-seg { display: flex; gap: 2px; padding: 3px; border-radius: 9px; background: rgba(0,0,0,.05); }
.nc-seg button {
  border: 0; background: transparent; font-family: inherit; font-size: 12.5px; font-weight: 500;
  color: var(--muted); cursor: pointer; padding: 4px 12px; border-radius: 7px;
  display: inline-flex; align-items: center; gap: 6px; transition: color .2s; white-space: nowrap;
}
.nc-seg button:hover { color: var(--ink); }
.nc-seg button.on { color: var(--ink); background: #fff; font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
.nc-seg .n { font-size: 11px; font-weight: 600; color: var(--muted); }
.nc-seg button.on .n { color: var(--accent); }

.nc-list { flex: 1; overflow-y: auto; padding: 4px 0 8px; }
.nc-item {
  position: relative; display: grid; grid-template-columns: auto 1fr auto;
  gap: 12px; padding: 12px 18px 12px 22px;
  border-bottom: 1px solid rgba(0,0,0,.04); cursor: pointer; overflow: hidden;
  transition: background .18s;
  animation: nc-item-in .4s cubic-bezier(.16,1,.3,1) both;
}
@keyframes nc-item-in { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
.nc-item:hover { background: rgba(0,0,0,.028); }
.nc-item.unread { background: rgba(155,143,196,.06); }
.nc-item.unread:hover { background: rgba(155,143,196,.11); }
.nc-item.unread::before {
  content: ''; position: absolute; left: 10px; top: 20px;
  width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
  box-shadow: 0 0 0 3.5px rgba(155,143,196,.15);
}
.nc-av {
  width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0; color: #fff;
  display: flex; align-items: center; justify-content: center; font-size: 16px;
  box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 3px 9px rgba(0,0,0,.08);
  transition: transform .3s cubic-bezier(.34,1.4,.64,1);
}
.nc-item:hover .nc-av { transform: scale(1.06); }
.nc-av-system { background: linear-gradient(140deg,#9b8fc4,#6d5fa8); }
.nc-av-calendar { background: linear-gradient(140deg,#FF2D55,#C41E3A); }
.nc-av-task { background: linear-gradient(140deg,#34C759,#2AA148); }
.nc-av-approve { background: linear-gradient(140deg,#FF9500,#D97706); }
.nc-av-security { background: linear-gradient(140deg,#FF3B30,#C41E3A); }
.nc-av-storage { background: linear-gradient(140deg,#FFCC00,#FF9500); }

.nc-body { min-width: 0; display: flex; flex-direction: column; gap: 3px; padding-top: 1px; }
.nc-meta { display: flex; align-items: center; gap: 7px; }
.nc-tag { font-size: 10.5px; font-weight: 600; padding: 1.5px 6.5px; border-radius: 5px; white-space: nowrap; }
.nc-t-system { color: #6d5fa8; background: rgba(155,143,196,.15); }
.nc-t-calendar { color: #C41E3A; background: rgba(255,45,85,.12); }
.nc-t-task { color: #1E8E3E; background: rgba(52,199,89,.15); }
.nc-t-approve { color: #B26700; background: rgba(255,149,0,.15); }
.nc-t-security { color: #C41E3A; background: rgba(255,59,48,.12); }
.nc-t-storage { color: #9A6B00; background: rgba(255,204,0,.2); }
.nc-prio {
  font-size: 9.5px; font-weight: 700; letter-spacing: .05em;
  color: #fff; background: #FF3B30; padding: 1.5px 5.5px; border-radius: 5px;
}
.nc-row1 { display: flex; align-items: baseline; gap: 9px; }
.nc-title {
  font-size: 13px; font-weight: 600; line-height: 1.4; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.nc-item.read .nc-title { color: var(--muted); font-weight: 500; }
.nc-time { font-size: 11px; color: var(--muted); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.nc-content {
  font-size: 12.5px; color: var(--ink); line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  word-break: break-all;
}
.nc-item.read .nc-content { color: var(--muted); }

/* 2026-10-01 用户第 1 条：能跳的行给个明确信号 —— 没有它时点整行只标已读，用户感知就是"无效按钮" */
.nc-item.go { cursor: pointer; }
.nc-go {
  flex: none; align-self: center; margin: 0 2px;
  font-size: 14px; color: var(--muted); opacity: .5;
  transition: opacity .15s, transform .15s;
}
.nc-item.go:hover .nc-go { opacity: 1; color: var(--accent); transform: translateX(2px); }

.nc-acts {
  display: flex; align-items: center; gap: 4px; flex-shrink: 0; align-self: center; padding-left: 6px;
  opacity: 0; transform: translateX(7px); pointer-events: none;
  transition: opacity .2s, transform .24s;
}
.nc-item:hover .nc-acts, .nc-item:focus-within .nc-acts { opacity: 1; transform: none; pointer-events: auto; }
.nc-act {
  width: 27px; height: 27px; border-radius: 7px; border: 0; background: transparent;
  color: var(--muted); cursor: pointer; display: flex; align-items: center; justify-content: center;
  font-size: 13px; transition: background .16s, color .16s;
}
.nc-act:hover { background: rgba(0,0,0,.07); color: var(--ink); }
.nc-act.danger:hover { background: rgba(255,59,48,.12); color: #FF3B30; }
.nc-act.keep { color: var(--success); }

.nc-empty { padding: 56px 24px; text-align: center; }
.nc-empty-ic {
  width: 52px; height: 52px; border-radius: 14px; margin: 0 auto 12px;
  background: rgba(0,0,0,.04); color: var(--muted);
  display: flex; align-items: center; justify-content: center; font-size: 24px;
}
.nc-empty h3 { font-size: 14px; font-weight: 600; margin-bottom: 5px; }
.nc-empty p { font-size: 12px; color: var(--muted); line-height: 1.6; }

.nc-foot {
  padding: 10px 18px; border-top: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  background: rgba(255,255,255,.4);
}
.nc-foot .stat { font-size: 12px; color: var(--muted); }
.nc-foot .stat b { color: var(--ink); font-weight: 600; }
/* P0-4：扫描器状态 —— 11px 次要色，停摆时靠「上次扫描」的相对时间一眼看出 */
.nc-foot .nc-scan { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
/* P0-5：被静音提醒的恢复口（常驻时才显示） */
.nc-muted {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 18px; font-size: 12px; color: var(--muted);
  background: var(--tint); border-top: 1px solid var(--border);
}
.nc-link {
  color: var(--accent); border: 0; background: transparent; cursor: pointer;
  font-size: 12.5px; font-weight: 500; font-family: inherit;
  display: inline-flex; align-items: center; gap: 4px;
}
.nc-link:hover { text-decoration: underline; }

/* ── 回收站（2026-09-26 卡 034）───────────────────────────────────────── */
/* ⚠ 必须自己声明 flex-direction: column（2026-09-26 修）：`#board` 是**横向 flex 行** ——
   它是看板列容器。views 里凡是"单一大列表"的页面（todos/logs/blockers/calendar…）都各自
   覆盖了 flex-direction，我这两页当时只写了 padding-bottom，于是「标题栏」和「列表」
   被当成两个行内项目**并排**：左边只剩标题、右边挤着列表 —— 用户看到的就是"左边很空"。 */
.trash-view { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
.trash-header { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; flex-wrap: wrap; }
.trash-stats { font-size: 12px; color: var(--muted); }
.trash-search {
  width: 240px; margin-left: auto; padding: 5px 10px; font-size: 12px; font-family: inherit;
  border: 1px solid var(--border); border-radius: 8px; background: #fff; color: var(--ink); outline: none;
}
.trash-search:focus { border-color: var(--accent); }
.trash-notebar { font-size: 12px; color: var(--muted); margin-bottom: 12px; line-height: 1.6; }
.trash-header h3 { font-size: 16px; font-weight: 700; }
.trash-hint { font-size: 12.5px; color: var(--muted); }
.trash-refresh {
  margin-left: auto; font-family: inherit; font-size: 12.5px; cursor: pointer;
  padding: 5px 12px; border-radius: 8px; border: 1px solid var(--border);
  background: #fff; color: var(--ink);
}
.trash-refresh:hover { border-color: var(--accent); color: var(--accent); }
.trash-list { display: flex; flex-direction: column; gap: 8px; }
.trash-item {
  background: #fff; border: 1px solid var(--border); border-radius: 12px;
  padding: 11px 14px; box-shadow: var(--shadow);
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
}
.trash-item:hover { border-color: #d9d2ea; background: #fcfbfe; }
/* 两行式：上行"这是什么任务"、下行"哪个文件 · 多大 · 什么时候删的"。
   原来 4 个信息点挤一行，宽屏下中间空一大片（用户回执"左边很空"的直接观感来源之一）。 */
.trash-main { flex: 1 1 360px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.trash-line1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.trash-line2 { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.trash-id { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--muted); }
.trash-title { font-weight: 600; }
.trash-proj { font-size: 11.5px; color: var(--muted); background: var(--bg); border: 1px solid var(--border); padding: 1px 6px; border-radius: 8px; }
.trash-name { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; color: var(--muted); word-break: break-all; }
.trash-meta { font-size: 11.5px; color: var(--muted); }
.trash-actions { display: flex; gap: 8px; flex: none; margin-left: auto; }
.trash-btn {
  font-family: inherit; font-size: 12.5px; cursor: pointer;
  padding: 5px 12px; border-radius: 8px; border: 1px solid var(--border);
  background: #fff; color: var(--ink);
}
.trash-btn:hover { border-color: var(--accent); color: var(--accent); }
.trash-btn.danger { color: #b3261e; border-color: #e6c3c0; }
.trash-btn.danger:hover { background: #fdf2f1; border-color: #b3261e; color: #b3261e; }

/* 回收站卡片：可点（2026-09-26 用户：「每个卡片都是不能点的死卡」）—— 有了 hover 就说明它真能点。
   2026-09-30（卡 005）：热区扩到整行，选择器从 .trash-main.clickable 改为 .trash-item。 */
.trash-item { cursor: pointer; }
.trash-item:hover .trash-title { color: var(--accent); }
.trash-preview-body { margin: 10px 0; max-height: 52vh; overflow: auto; border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; }
.trash-preview-text { font-size: 13px; line-height: 1.65; word-break: break-word; }
.trash-preview-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
#trash-preview-modal {
  width: min(780px, 92vw); max-height: 88vh; overflow: auto;
  background: var(--card); border: 1px solid var(--border); border-radius: 10px;
  padding: 18px 20px; box-shadow: 0 12px 40px rgba(30,35,50,0.22);
}

/* 「装到别的 agent」目标行 */
.skills-agents-sub { font-size: 11px; font-weight: 400; color: var(--muted); margin-left: 8px; }
.agent-row { border-top: 1px solid var(--border); padding: 9px 0; }
.agent-row:first-of-type { border-top: none; }
.agent-off { opacity: 0.5; }
.agent-line1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.agent-name { font-weight: 600; font-size: 13px; }
.agent-mode { font-size: 11px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border); }
.agent-mode.can { color: #1b5e20; border-color: #bfd8c0; background: #f2f8f2; }
.agent-mode.manual { color: var(--muted); }
.agent-state { font-size: 11px; color: var(--muted); }
.agent-evidence { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--muted); margin-top: 3px; word-break: break-all; }
.agent-howto { font-size: 12px; color: var(--muted); margin-top: 4px; line-height: 1.5; }
.agent-note { font-size: 11.5px; color: var(--muted); }

/* 已接入徽章（卡 011）：技能副本 + MCP 配置两个**文件事实**的合体，不用 LLM、不猜 */
.agent-link { font-size: 11px; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--border); }
.agent-link-linked { color: #1b5e20; border-color: #bfd8c0; background: #f2f8f2; }
.agent-link-partial { color: #8a5a00; border-color: #e8d9a8; background: #fdf7e8; }
.agent-link-none { color: var(--muted); }
.agent-link-unknown { color: var(--muted); border-style: dashed; }

/* 技能卡「装到：」逐目标状态（卡 010/011）：一眼看出装到谁了、谁那份旧了 */
.skill-targets { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 5px; }
.skill-targets-label { font-size: 11.5px; color: var(--muted); }
.skill-tgt { font-size: 11px; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--border); }
.skill-tgt-ok { color: #1b5e20; border-color: #bfd8c0; background: #f2f8f2; }
.skill-tgt-warn { color: #8a5a00; border-color: #e8d9a8; background: #fdf7e8; }
.skill-tgt-idle { color: var(--muted); }
.skill-tgt-absent { color: var(--muted); border-style: dashed; }
.skill-hash { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--muted); margin-left: auto; }

#log-project-modal {
  width: min(460px, 92vw); max-height: 80vh; overflow: auto;
  background: var(--card); border: 1px solid var(--border); border-radius: 10px;
  padding: 16px 18px; box-shadow: 0 12px 40px rgba(30,35,50,0.22);
}
.proj-pick-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.proj-pick-list .skills-btn { justify-content: flex-start; text-align: left; }

/* 置顶标记（2026-09-26 卡 037）：钉住的卡片在列表最上面，视觉上也要一眼看得出 */
.log-pin { font-size: 12px; margin-right: 2px; }
.todo-pin { font-size: 12px; margin-right: 4px; flex: none; }
.log-card.pinned { border-left: 3px solid var(--accent); }
.todo-item.pinned { border-left: 3px solid var(--accent); }

/* ── 技能安装专区（2026-09-26 卡 038）─────────────────────────────────── */
.skills-view { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }

/* ── 服务 / 端口（2026-09-26 卡 006）────────────────────────────────── */
/* ⚠ 同 skills-view：`#board` 是横向 flex 行，单列页面必须自己声明 column（否则页头与列表并排） */
.services-view { flex: 1; display: flex; flex-direction: column; padding: 14px; overflow-y: auto; }
.services-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
.services-header h3 { font-size: 16px; font-weight: 700; }
.services-stats { font-size: 12px; color: var(--muted); }
.svc-input {
  padding: 5px 10px; font-size: 12px; font-family: inherit;
  border: 1px solid var(--border); border-radius: 8px; background: #fff; color: var(--ink); outline: none;
}
.svc-input:focus { border-color: var(--accent); }
.svc-port-input { width: 86px; }
.services-notebar { font-size: 12px; color: var(--muted); margin-bottom: 12px; line-height: 1.6; }
.services-warn {
  font-size: 12.5px; color: #8a5a00; background: #fdf7e8; border: 1px solid #e8d9a8;
  border-radius: 10px; padding: 9px 12px; margin-bottom: 12px;
}
.services-list { display: flex; flex-direction: column; gap: 8px; }
.svc-item {
  background: #fff; border: 1px solid var(--border); border-radius: 12px;
  padding: 11px 14px; box-shadow: var(--shadow);
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
}
.svc-item.small { padding: 8px 12px; opacity: .92; }
.svc-main { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.svc-line1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.svc-line2 { font-size: 11.5px; color: var(--muted); display: flex; gap: 6px; flex-wrap: wrap; }
.svc-name { font-weight: 600; }
.svc-port { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; color: var(--accent); }
.svc-state { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid transparent; }
.svc-state.on { background: #eaf7ee; color: #1c7a3e; border-color: #bfe3cb; }
.svc-state.off { background: var(--bg); color: var(--muted); border-color: var(--border); }
.svc-dup { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #fdeceb; color: #b3261e; border: 1px solid #e6c3c0; }
.svc-src { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--bg); color: var(--muted); border: 1px solid var(--border); }
.svc-actions { display: flex; gap: 8px; flex: none; margin-left: auto; }
.services-unreg { margin-top: 16px; }
.services-unreg-title { font-size: 12.5px; font-weight: 600; margin-bottom: 8px; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.services-unreg-hint { font-size: 11px; font-weight: 400; color: var(--muted); }
.skills-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.skills-header h3 { font-size: 16px; font-weight: 700; }
.skills-hint { font-size: 12.5px; color: var(--muted); flex: 1 1 260px; }
/* 维护机制说明（2026-10-03）：单独占一行、比普通 hint 稍亮，因为它是"我该怎么维护"的答案 */
.skills-hint.skills-maint { flex-basis: 100%; font-size: 12px; line-height: 1.6; }
.skills-hint.skills-maint b { color: var(--ink); }
.skills-btn {
  font-family: inherit; font-size: 12.5px; cursor: pointer;
  padding: 5px 12px; border-radius: 8px; border: 1px solid var(--border);
  background: #fff; color: var(--ink);
}
.skills-btn:hover { border-color: var(--accent); color: var(--accent); }
.skills-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.skills-btn.primary:hover { opacity: .9; color: #fff; }
.skills-btn.danger { border-color: #e6c3c0; background: #fff; color: #b3261e; }
.skills-btn.danger:hover { background: #fdf2f1; border-color: #b3261e; color: #b3261e; }

/* ── 技能直接导入（2026-09-26 卡 005）──────────────────────────────────── */
/* 拖拽遮罩：pointer-events:none 才不会自己吃掉 drop 事件（否则松手时事件落在遮罩上，
   而遮罩不是 drop 目标 → 导入没触发，看着像"拖进去没反应"）。 */
.skills-dropmask {
  position: fixed; inset: 0; z-index: 60; pointer-events: none;
  background: rgba(120, 96, 190, .10);
  border: 3px dashed var(--accent); border-radius: 14px;
  display: flex; align-items: center; justify-content: center;
}
.skills-dropmask-inner {
  background: #fff; border: 1px solid var(--border); border-radius: 14px;
  padding: 18px 26px; box-shadow: var(--shadow); text-align: center;
  font-size: 13px; color: var(--ink); max-width: 520px; line-height: 1.7;
}
.skills-dropmask-icon { font-size: 28px; margin-bottom: 6px; }
.skills-imported { margin: 6px 0 16px; }
.skills-imported-title {
  font-size: 13px; font-weight: 600; margin-bottom: 8px;
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
}
.skills-imported-hint { font-size: 11.5px; font-weight: 400; color: var(--muted); }
.skill-card.imported { border-left: 3px solid var(--accent); }
.skill-badge {
  font-size: 11px; padding: 1px 7px; border-radius: 999px;
  background: rgba(120, 96, 190, .12); color: var(--accent);
  border: 1px solid rgba(120, 96, 190, .3);
}
.skill-desc { font-size: 12.5px; color: var(--ink); opacity: .85; line-height: 1.6; margin: 4px 0 2px; }
.skill-files { font-size: 11.5px; color: var(--muted); margin-left: auto; }
.skills-error {
  font-size: 13px; color: #b3261e; background: #fdf2f1;
  border: 1px solid #e6c3c0; border-radius: 10px; padding: 10px 12px; margin-bottom: 12px;
}
.skills-meta {
  font-size: 12px; color: var(--muted); margin-bottom: 6px;
  display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
}
.skills-dir { max-width: 46vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skills-warn {
  font-size: 12.5px; color: #8a5a00; background: #fff8e6;
  border: 1px solid #f0dfb8; border-radius: 10px; padding: 8px 12px; margin-bottom: 12px;
}
.skills-list { display: flex; flex-direction: column; gap: 10px; }
.skill-card {
  background: #fff; border: 1px solid var(--border); border-radius: 12px;
  padding: 12px 14px; box-shadow: var(--shadow);
  display: flex; flex-direction: column; gap: 8px;
}
.skill-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.skill-id { font-weight: 600; }
.skill-target, .skill-ver { font-size: 12px; color: var(--muted); }
.skill-state { font-size: 12px; border-radius: 999px; padding: 2px 9px; border: 1px solid transparent; }
.skill-good { color: #1a7f37; background: #eaf7ee; border-color: #c5e7d0; }
.skill-warn { color: #8a5a00; background: #fff8e6; border-color: #f0dfb8; }
.skill-idle { color: var(--muted); background: #f3f1f6; border-color: var(--border); }
.skill-bad { color: #b3261e; background: #fdf2f1; border-color: #e6c3c0; }
.skill-path {
  font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.skill-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.skills-agents {
  margin-top: 16px; background: rgba(255,255,255,.55); border: 1px solid var(--border);
  border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
}
.skills-agents-title { font-size: 13px; font-weight: 700; }
.skills-agent { font-size: 12.5px; color: var(--muted); line-height: 1.6; }
.skills-agent code {
  font-family: ui-monospace, Consolas, monospace;
  background: #f3f1f6; border-radius: 4px; padding: 1px 5px;
}
/* MCP 接入材料区（卡 002 · A 路线） */
.mcp-connect { margin-top: 16px; }
.mcp-entry-pick { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mcp-entry-label { font-size: 12px; color: var(--muted); }
.mcp-entry-note { font-size: 11.5px; color: var(--muted); }
</style>
