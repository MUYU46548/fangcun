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
      <!-- 左侧按钮组（2026-10-12 暮雨圈选：「放顶栏左侧，参考 Edge」）——
           Edge 左上角就是「← 前进/后退 · ⟳ 刷新 · ⌂ 首页」这一束。
           ⚠ 三个新按钮**必须是图标**，这不是审美选择而是几何必需：
             带文字版本在 1080 窄窗下横向溢出（小样实测需 1023px / 只有 999px）。
           ⚠ 「← 返回」**不许再挂 v-if**：它此前是 v-if="canGoBack" ——
             没有历史时整个不在 DOM 里，用户报「返回按钮没了」就是这个（不是被挤走）。
             现在常驻 + 无历史时 disabled 置灰：位置稳定、还能看出"现在退不了"。 -->
      <span class="navgroup">
        <button class="ghost nav-back" :class="{ disabled: !canGoBack }"
          :disabled="!canGoBack"
          :title="canGoBack ? '返回上一个视图' : '返回：还没有可回退的视图'"
          @click="goBack">← 返回</button>
        <span class="navgroup-sep"></span>
        <button class="ghost nav ico" title="首页：回到看板，并清掉搜索与筛选"
          @click="goHome">⌂</button>
        <button class="ghost nav ico" :title="'帮助手册：每个页签干什么、筛选语法、快捷键、备份恢复'"
          @click="goHelp">?</button>
        <!-- 2026-10-16 用户第 9 条：「同步的时候整个方块都在旋转」——
             真因是动画加在 button 本身（.ico.syncing），边框与底色跟着一起转。
             现在 ⟳ 单独包一层 span，只有**字符**转，按钮本体不动。 -->
        <!-- 2026-10-25 卡 004：不再只是一个转圈的图标 —— 长成**状态胶囊**：
             `⟳ 推送 3s` → `✓ 已同步`（3 秒后回图标）。阶段由主进程真报到哪一步算哪一步，
             秒数是本地真实计时；**不编百分比**（git 不给字节进度，编一个就是假成功）。 -->
        <button class="ghost nav ico sync-btn" :class="syncBtnClass"
          :disabled="syncBusy"
          :title="syncTooltip"
          @click="runSync">
          <span class="ico-glyph">{{ syncGlyph }}</span>
          <span v-if="syncCapsule" class="sync-cap-txt">{{ syncCapsule }}</span>
        </button>
      </span>
      <span v-if="parseErrors.length" class="parse-warn" :title="parseErrors.join('\n')" @click="showParseErrors">
        ⚠ {{ parseErrors.length }} 个文件无法解析
      </span>
      <span class="ctrls">
        <!-- 看板专属控件（2026-09-26 用户第 1 条）：它们只对看板/归档有意义。
             原来无条件渲染 → 在回收站/技能/日志/待办等页签上全是"点了没反应"的按钮。 -->
        <template v-if="isBoardView">
        <!-- 筛选栏（2026-10-11 用户圈选「方案 B · 条件标签化」）
             原话：「看板依旧是筛选噩梦，虽然我已经知道在哪里调了，但是点起来很难受，不自然。」
             两处病根：① 一行八个控件平铺、主次不分；② **全是原生 select** —— 要「点开 → 再点一项」，
             选完看不到现在生效的是什么，撤销还得重新点开选回「全部」。
             现在：主行只留「搜索 + ＋筛选」；生效条件变成可点 ✕ 的小标签；
             分组/排序各是一个只显示当前值的小按钮，点开的是**同一个内联面板**（不做嵌套下拉）；
             面板里的选项**本身就是按钮** —— 一次点击就生效，这就是"不难受"的全部来源。
             ⚠ curProj / curStatus / dueFilter / searchIncludeArchive **仍不写 prefs**（筛选是临时的）。 -->
        <div class="fbar">
          <!-- ⚠ 2026-10-12 二次修正：搜索框**固定 260px**，不再 `flex: 1`。
               上一轮为了填满 space-between 留下的空白，把搜索框写成 `flex: 1 1 220px`
               —— 它把**全部余量吸走**，暮雨原话「搜索框未免太长太恐怖了，人家浏览器顶上写链接
               才需要那么长」（实测 877px）。
               现在余量交给下面这个 `.fbar-grow` 撑杆：搜索框保持 260，**筛选/分组/排序继续贴右端**。 -->
          <input v-model="searchQuery" class="search fbar-search"
            placeholder="搜索…（#标签 @项目 due:01-15）"
            @keydown.enter="executeNaturalQuery" />
          <span class="fbar-grow"></span>

          <!-- ⚠ 下面五个入口各自包一个 `PopoverRoot`：reka-ui 负责**打开/关闭/定位/无障碍**，
               我们只负责"里面长什么样"。上一版手搓的遮罩 + getBoundingClientRect 定位已删。 -->
          <PopoverRoot :open="fbarPanel === 'filter'" @update:open="onPanelOpen('filter', $event)">
            <PopoverTrigger as-child>
              <button class="fbar-btn fbar-filter-btn" :class="{ on: fbarPanel === 'filter' }"
                :title="'筛掉不看的：' + (activeFilterChips.length ? activeFilterChips.map(c => c.label).join(' · ') : '当前没有任何筛选')">
                ＋ 筛选<span v-if="activeFilterChips.length" class="fbar-n">{{ activeFilterChips.length }}</span>
              </button>
            </PopoverTrigger>
            <PopoverPortal>
              <PopoverContent class="fpop" align="end" :side-offset="6" :collision-padding="8"
                update-position-strategy="always">
                <div class="fpop-h">
                  <b>筛选</b><span class="fpop-grow"></span>
                  <button class="fpop-close" title="收起（Esc / 点外面也行）" @click="closeFbar()">✕</button>
                </div>
                <div class="fpop-row">
                  <span class="fpop-row-label">项目</span>
                  <button class="fpop-opt" :class="{ on: curProj === '__all__' }" @click="curProj = '__all__'">全部</button>
                  <button v-for="p in projects" :key="'fp-' + p.id" class="fpop-opt"
                    :class="{ on: curProj === p.id }" @click="curProj = p.id">{{ p.name || p.id }}</button>
                </div>
                <div class="fpop-row">
                  <span class="fpop-row-label">状态</span>
                  <button class="fpop-opt" :class="{ on: !curStatus }" @click="curStatus = ''">全部</button>
                  <button v-for="s in taskStatuses" :key="'fs-' + s" class="fpop-opt"
                    :class="{ on: curStatus === s }" @click="curStatus = s">{{ s }}</button>
                </div>
                <div class="fpop-row">
                  <span class="fpop-row-label">到期</span>
                  <button class="fpop-opt" :class="{ on: !dueFilter }" @click="dueFilter = ''">不限</button>
                  <button v-for="d in DUE_OPTIONS" :key="'fd-' + d.v" class="fpop-opt"
                    :class="{ on: dueFilter === d.v }" @click="dueFilter = d.v">{{ d.label }}</button>
                </div>
                <!-- 「读取情况」（卡 20261025-006 第三件）——「哪些待办其实没人碰过」的出口。
                     为什么放在筛选里而不是另开一页：筛完的看板**本身就是清单**（能点开、能批量归档），
                     再弹一个只读清单等于同一批数据两套装法。
                     ⚠ 口径必须跟数字在一起（同卡 005 第①条）：这里只统计 **agent 经 MCP 读卡**，
                       你自己在界面里点开一张卡**不算**被读过 —— 不说清就会被当成假话。 -->
                <div class="fpop-row">
                  <span class="fpop-row-label">读取</span>
                  <button class="fpop-opt" :class="{ on: !readFilter }" @click="readFilter = ''">不限</button>
                  <button class="fpop-opt" :class="{ on: readFilter === 'never' }"
                    :title="neverReadHint" @click="readFilter = 'never'">{{ neverReadLabel }}</button>
                </div>
                <div class="fpop-note">{{ neverReadHint }}</div>
                <!-- 「含归档」只在活跃视图有意义（归档视图里它只会造成"同一批是不是重复出现"的困惑）——
                     2026-09-25 决定：归档视图下直接不给这个选项。 -->
                <div class="fpop-row" v-if="curView !== 'archive'">
                  <span class="fpop-row-label">范围</span>
                  <button class="fpop-opt" :class="{ on: !searchIncludeArchive }" @click="searchIncludeArchive = false">只看活跃</button>
                  <button class="fpop-opt" :class="{ on: searchIncludeArchive }" @click="searchIncludeArchive = true">含归档</button>
                </div>
                <div class="fpop-foot">
                  <button class="fpop-clear" :disabled="!activeFilterChips.length" @click="clearAllFilters()">清除全部筛选</button>
                </div>
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>

          <!-- 折叠/展开是**同一个开关的两种状态**（2026-09-28 用户第 3 条）——
               「折叠全部 / 展开」并排放两个按钮，永远有一个无效，用户原话「臃肿无比」。
               ⚠ 2026-10-12 二次修正：上一轮把它收成**纯符号 ⊟**，暮雨原话
               「折叠全部按钮的文本都没了，根本认不出来」—— 收过头了。
               现在**文字回来**（「⊟ 折叠」/「⊞ 展开」，图标只当引子），仍是一个开关。 -->
          <button class="ghost" id="btn-fold-all"
            :title="allGroupsCollapsed ? '展开全部：还原所有分组的卡片' : '折叠全部：只看分组名和数量，长单子立刻变短'"
            @click="toggleAllCollapsed()">{{ allGroupsCollapsed ? '⊞ 展开' : '⊟ 折叠' }}</button>

          <!-- ⚠ 2026-10-12「看」与「做」分两层（暮雨圈选 丙）：
               「项目」「状态」两个**独立入口撤掉了** —— 它们的功能本来就在上面的筛选浮层里，
               当前值由「生效中」标签承担，所以**点击次数不变、信息不丢**，只是少两个按钮。
               它们原先的类名锚点 .proj-select / .st-filter 随之退休（断言改走筛选浮层）。 -->
          <PopoverRoot :open="fbarPanel === 'group'" @update:open="onPanelOpen('group', $event)">
            <PopoverTrigger as-child>
              <button class="fbar-btn fbar-group-btn" :class="{ on: fbarPanel === 'group' }"
                :title="'怎么分组：' + optLabel(GROUP_OPTIONS, groupMode)">
                ⌗ {{ optLabel(GROUP_OPTIONS, groupMode) }} <span class="fbar-caret">▾</span></button>
            </PopoverTrigger>
            <PopoverPortal>
              <PopoverContent class="fpop fpop-narrow" align="end" :side-offset="6" :collision-padding="8"
                update-position-strategy="always">
                <div class="fpop-row">
                  <button v-for="o in GROUP_OPTIONS" :key="'pg-' + o.v" class="fpop-opt"
                    :class="{ on: groupMode === o.v }" @click="groupMode = o.v">{{ o.label }}</button>
                </div>
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>

          <PopoverRoot :open="fbarPanel === 'sort'" @update:open="onPanelOpen('sort', $event)">
            <PopoverTrigger as-child>
              <button class="fbar-btn fbar-sort-btn" :class="{ on: fbarPanel === 'sort' }"
                :title="'怎么排：' + optLabel(SORT_OPTIONS, sortMode)">
                ⇅ {{ optLabel(SORT_OPTIONS, sortMode) }} <span class="fbar-caret">▾</span></button>
            </PopoverTrigger>
            <PopoverPortal>
              <PopoverContent class="fpop fpop-narrow" align="end" :side-offset="6" :collision-padding="8"
                update-position-strategy="always">
                <div class="fpop-row">
                  <button v-for="o in SORT_OPTIONS" :key="'po-' + o.v" class="fpop-opt"
                    :class="{ on: sortMode === o.v }" @click="sortMode = o.v">{{ o.label }}</button>
                </div>
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>
        </div>

        <!-- 生效条件（方案 B 的全部价值）：现在筛了什么一眼可见，点 ✕ 就撤，不用回头翻下拉。 -->
        <div class="fbar-chips" v-if="activeFilterChips.length">
          <span class="fbar-chips-label">生效中</span>
          <span v-for="c in activeFilterChips" :key="'fc-' + c.key" class="fbar-chip">
            {{ c.label }}
            <button class="fbar-x" :title="'撤掉这个筛选：' + c.label" @click="clearFilterChip(c.key)">✕</button>
          </span>
          <button class="ghost fbar-clear" @click="clearAllFilters()">清除全部</button>
        </div>

        </template>
      </span>
    </header>

    <!-- View tabs -->
    <!-- ⚠ 2026-10-12「看」与「做」分两层（暮雨圈选 丙）：
         顶栏只留**看与筛**（搜索/筛选/分组/排序/折叠）；**写操作与全局图标搬到这一行右端** ——
         这一行本来就空着大半，搬过来既不增行数、也不改任何功能的点击次数。
         搬过来的按钮 `v-if` 条件原样保留（新建/快速记/任务多选仍只在任务视图出现）。 -->
    <nav id="views" :class="{ 'batch-on': batchMode }">
      <button
        v-for="v in visibleViews"
        :key="v.id"
        class="vbtn"
        :class="{ on: curView === v.id }"
        @click="switchView(v.id)"
      >
        {{ v.label }}
      </button>
      <!-- 更多（2026-10-25 暮雨：「帮我搞个更多菜单，该折叠的就折叠」）——
           默认收起「启动台 / 技能 / 服务」三个低频页签；它们在设置里可自己勾（至少留 7 个在外面）。
           ⚠ 停在被收起的页签里时，这个按钮显示**那一页的名字**并高亮 ——
             否则会出现"人在技能页、顶栏却没有任何高亮"的鬼状态。 -->
      <PopoverRoot v-if="moreViews.length" v-model:open="moreOpen">
        <PopoverTrigger as-child>
          <button class="vbtn more-btn" :class="{ on: curViewInMore }"
            :title="curViewInMore
              ? '你现在在「' + curViewLabel + '」—— 它是被收起的页签；点这里换别的'
              : '还有 ' + moreViews.length + ' 个页签收在这里：' + moreViews.map(v => v.label).join(' / ')">
            {{ curViewInMore ? curViewLabel : '更多' }}<span class="more-caret">▾</span>
          </button>
        </PopoverTrigger>
        <PopoverPortal>
          <!-- 2026-10-25 第二轮：暮雨拿系统菜单截图对比后否掉了第一版 ——
               「底下那坨文本把框挤长而且完全没必要」。所以：
               ① 去掉标题栏（「收起的页签」+ ✕）② 去掉底部说明段落
               ③ 说明改成一条**真能点**的菜单项「顶栏页签设置…」——
                  菜单里每一行都该能点，纯文本不该出现在下拉里。 -->
          <PopoverContent class="more-pop" align="start" :side-offset="6" :collision-padding="8"
            update-position-strategy="always">
            <button v-for="v in moreViews" :key="'mv-' + v.id" class="more-opt"
              :class="{ on: curView === v.id }" @click="pickMoreView(v.id)">
              <span class="more-tick">{{ curView === v.id ? '✓' : '' }}</span>
              <span class="more-txt">{{ v.label }}</span>
            </button>
            <div class="more-sep"></div>
            <button class="more-opt more-set" @click="openViewsSetting">
              <span class="more-tick">⚙</span>
              <span class="more-txt">顶栏页签设置…</span>
            </button>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>
      <span class="views-grow"></span>
        <button v-if="isTaskView" class="pri" title="新建任务（走完整表单）" @click="openNew">+ 新建</button>
        <!-- 快速记（2026-10-11，卡 20261006-002 E 组死通道接回）：
             `quickAdd` 通道在主进程里一直存在，界面却从没有入口。它支持一句话简写
             （p0/p1/p2 优先级 · #标签 · @指派 · to:状态 · due:MM-DD），随手记比开弹窗填六个字段顺手。 -->
        <button v-if="isTaskView" class="ghost" title="一句话快速建卡：可写 p0 / #标签 / @指派 / to:状态 / due:12-31" @click="openQuickAdd()">⚡ 快速记</button>
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
        <!-- 2026-10-25：页签行已经满了（15 个页签），这三个低频操作打包成一组 ——
             换行时**整组一起下去**，不会出现「刷新」孤零零掉到第三行开头那种样子。 -->
        <span class="views-ops">
        <!-- 任务多选同样只在看板/归档有意义（批量改状态/归档作用于看板列） -->
        <button v-if="isBoardView" class="ghost batch-mode-btn" :class="{ active: batchMode }" @click="toggleBatchMode">
          <span v-if="!batchMode">☑ 任务多选</span>
          <span v-else>☑ <i style="color:#fff">{{ selectedBatch.length || 0 }}</i></span>
        </button>
        <button class="ghost" @click="showSettings">⚙</button>
        <!-- 重读全部数据（2026-10-25 暮雨：「顶栏加一个真的『重读全部数据』，而且要明确写"刷新"，
             不然用户会以为是第二个同步按钮」）。
             ⚠ 三条硬要求：
               ① **文字必须写「刷新」**，不能只有 ⟳ —— 左上那个 ⟳ 是「自仓 git 同步」，纯图标一定被认成一样的东西；
               ② 转的是**字符**不是按钮本体（check-button-styles ④ 守着）；
               ③ 外部改动（agent 经 MCP 写卡、手改 md）只有点这里才会反映到界面 —— 这是它存在的唯一理由。
             位置刻意放最右：页签行本来就在临界点，放中间会把「☑ 任务多选」和 ⚙ 拆成孤儿。 -->
        <button class="ghost refresh-all" :class="{ busy: refreshBusy }" :disabled="refreshBusy"
          :title="'重读全部数据：任务 / 项目 / 日志 / 待办 / 想法 / 方针 / 阻塞链 / 通知\n（这不是同步 —— 同步是左上那个 ⟳，它只拉方寸自己的 git 仓库）'"
          @click="refreshAllData">
          <span class="ico-glyph" :class="{ spinning: refreshBusy }">⟳</span>
          <span class="refresh-all-txt">{{ refreshBusy ? '刷新中' : '刷新' }}</span>
        </button>
        </span>
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
        <button class="ghost" title="批量改期：把选中任务的截止日推到新日期" @click="openBatchPostpone">📅 改期</button>
        <button class="danger" title="批量删除（会二次确认，进入 trash 可人工找回）" @click="executeBatchDelete">删除</button>
      </div>

      <!-- 批量改期面板（2026-10-18 Bundle A「超期任务批量改期」）。典型路径：
           顶栏日期筛选选「超期」→ 批量模式 → 全选 → 📅 改期 —— 堆了一堆过期的卡一次推走。
           写入沿用既有 batchEdit → updateTask（fm.deadline 直改 + 乐观锁 + logActivity 逐条留痕），
           不加新 IPC；改完 isOverdue 按 deadline 重算，卡面「逾期 N 天」标识自动消失。
           改期不是破坏性动作（随时可再改回），不做二次确认；超期筛选本身不含终态卡。 -->
      <div v-if="batchPostponing" class="bp-panel">
        <span class="bp-label">把选中的 {{ selectedBatch.length }} 个任务改期到</span>
        <input type="date" v-model="batchPostponeDate" class="log-filter bp-date" title="目标截止日" />
        <button class="ghost" title="截止日推迟一周" @click="batchPostpone(batchPostponeShift(7))">+7 天</button>
        <button class="ghost" title="截止日推迟一个月" @click="batchPostpone(batchPostponeShift(30))">+30 天</button>
        <button class="ok" title="把选中任务的截止日改成上面选的日期" @click="batchPostpone(batchPostponeDate)">确定改期</button>
        <button class="ghost" title="收起改期面板（不清空已选）" @click="batchPostponing = false">收起</button>
      </div>

      <button class="ghost" title="退出多选模式并清空选择" @click="selectedBatch = []; batchMode = false">取消</button>
    </div>

    <!-- 归档区按状态快选（2026-10-17 暮雨第 1 条；第 2 条重做交互）：
         「我想一键全选已完成的归档任务，然后删掉它们」—— 原来要先开多选、再逐个点，
         上百张卡根本点不完。这里把"选"这一步按状态批量做掉；"删"仍然留给批量栏，
         破坏性动作不做成一键（多一步是刻意的）。
         2026-10-17 暮雨第 2 条：首版点一个状态会**冲掉**上一组的选择（selectedBatch = ids 整桶替换），
         用户原话「每次至多只能批量选一组，其他的都被自动取消勾选」。改成了全世界通用（邮箱 / 网盘 / Wiki）
         的那套语言：① 开头一个方框，点一下全选当前看到的、再点一下全不选，部分选中时框呈横线（indeterminate）；
         ② 状态按钮改成**叠加勾选**：点「完成」再点「待办」= 两组都在选，再点一下「完成」= 只取消完成组；
         ③ 该组全在选时按钮点亮，一眼能看出选了哪几组。 -->
    <div v-if="curView === 'archive' && filteredTasks.length" class="aq-bar">
      <label class="aq-master" title="点一下 = 全选当前看到的任务；再点一下全部取消。部分选中时框里呈横线（和邮箱一样）">
        <input type="checkbox"
          :checked="archiveAllSelected"
          :indeterminate="archiveSomeSelected"
          @change="toggleArchiveSelectAll" />
        <span>全选</span>
      </label>
      <span class="aq-label">按状态快选</span>
      <button
        v-for="s in STATUSES"
        :key="'aq-' + s"
        class="ghost aq-btn"
        :class="{ on: archiveStatusAllSelected(s) }"
        :disabled="archiveStatusCount(s) === 0"
        :title="archiveStatusCount(s)
          ? (archiveStatusAllSelected(s) ? `再点一下 = 取消这 ${archiveStatusCount(s)} 个「${s}」（其他选择保留）` : `把这 ${archiveStatusCount(s)} 个「${s}」加进选择（不影响已选的）`)
          : `归档区里没有「${s}」任务`"
        @click="selectArchiveByStatus(s)"
      >{{ s }}<i class="aq-n">{{ archiveStatusCount(s) }}</i></button>
      <span class="aq-hint">选择可叠加：点完一个状态再点下一个，已选的不丢；选完用上方批量栏的「删除」清掉</span>
    </div>

    <!-- Archive hint -->
    <div v-if="curView === 'archive' && showArchiveHint" class="archive-hint">
      <span>📋 归档视图：这里只显示已经移进归档文件夹（<code>task-data/archive/</code>）的任务 —— 算不算归档，只看文件在不在这儿，不看任务状态。归档只能由你亲自决定，方寸不会自动执行。</span>
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
      <!-- 卡片墙专用开关（2026-10-10 用户要求）：一张卡的信息再多，一百多张平铺也是压迫。
           默认关（不动旧行为）；只作用于卡片墙，列 / 列表两种摆法不受影响。
           开关状态与分区折叠都记进 prefs，下次打开还是你上次那样。 -->
      <label v-if="isBoardView && boardView === 'cards'" class="pvw-switch"
        title="只显示状态不是「完成 / 驳回」的任务；被过滤空的整个分区会一起收起。这个开关只影响信息卡墙。">
        <input type="checkbox" class="pvw-switch-chk" :checked="cardWallOpenOnly"
          @change="toggleCardWallOpenOnly($event)" />
        <span>只看未完成</span>
      </label>
      <span class="pagehead-hint">{{ viewHint }}</span>
    </div>

    <!-- 看板横幅（超期归档 + 驳回返工台）：已切到 components/BoardBanners.vue
         （App.vue 拆分第二刀，2026-10-30）。状态仍在 App，组件只接 props / 发事件。 -->
    <BoardBanners v-if="curView === 'active'"
      :archive-days="archiveDays" :archive-overdue="archiveOverdue"
      :rework="rework" :rework-open="reworkOpen" :rework-hidden="reworkHidden"
      @archive-now="runArchiveOverdue()"
      @archive-skip="archiveOverdue = { count: 0, items: [] }"
      @toggle-rework="reworkOpen = !reworkOpen"
      @hide-rework="reworkHidden = true"
      @rework-back="reworkRestore" @rework-archive="reworkArchive" />

    <!-- 随问（2026-10-22 · 施工单包 03 任务一）——「控制台」的查询面。
         这一页**不调模型**：答案全从 registry / 任务卡 / 执行日志 / ai-trace 直接算出来。
         结构化确实算不出来的，右下才给一个「交给 AI 答」的口子 —— 点它才花 token，
         而且花销当场印在回答头上（03 单成本红线：AI 只进模糊问答与批次出单两处）。
         ⚠ 独立 v-if、不接在别人家的 v-else-if 链上：插在链中间会让后面整片视图不渲染。 -->
    <main id="board" class="ask-view" v-if="curView === 'ask'">
      <div class="ask-head">
        <div class="ask-lead">问一句，方寸手里的事实直接答</div>
        <div class="ask-lead-sub">
          项目台账、任务卡、执行日志、AI 花销都在这儿，不用一页页翻。
          答不了会明说「不知道」，不编。
        </div>
      </div>
      <div class="ask-box">
        <div class="ask-row">
          <input class="ask-in" v-model="askQ" :disabled="askBusy"
                 placeholder="比如：方寸到哪了 / 欠着什么 / 哪个项目停着"
                 @keyup.enter="runAsk()" />
          <button class="pri ask-go" :disabled="askBusy || !askQ.trim()" @click="runAsk()">{{ askBusy ? '查…' : '查一下' }}</button>
        </div>
        <div class="ask-groups">
          <div class="ask-group" v-for="g in askGroups" :key="g.name">
            <span class="ask-group-k" v-if="askGroups.length > 1">{{ g.name }}</span>
            <button class="ghost ask-chip" v-for="p in g.items" :key="p.label"
                    :title="p.hint" :disabled="askBusy" @click="askQuick(p.q)">{{ p.label }}</button>
          </div>
        </div>
        <div class="ask-hint">这一页不花钱：答案都从台账现算。点上面任一个，或者自己写一句。</div>
      </div>

      <div class="ask-ans" v-if="askAns">
        <div class="ask-title">{{ askAns.title }}</div>
        <div class="ask-line" v-for="(l, i) in askAns.lines" :key="'al' + i">{{ l }}</div>
        <div class="ask-rows" v-if="askAns.rows && askAns.rows.length">
          <div class="ask-item" v-for="(r, i) in askAns.rows" :key="'ar' + i">
            <span class="ask-k">{{ r.k }}</span>
            <span class="ask-v">{{ r.v }}<em class="ask-sub" v-if="r.sub">{{ r.sub }}</em></span>
          </div>
        </div>
        <div class="ask-foot">
          <span class="ask-src" v-if="askAns.source">来源：{{ askAns.source }}</span>
          <button class="ghost ask-llm-btn" v-if="askAns.needsLlm" :disabled="askLlmBusy" @click="askToLlm()">
            {{ askLlmBusy ? 'AI 正在答…' : '让 AI 答（会计费）' }}
          </button>
          <!-- 出单（2026-10-22 · 03 任务三）：从台账 + 决策卡派生下一批任务卡。
               一次调用 = 一批；产出只落「待审批」（点头才转正）。这是全应用**第二处**会
               为规划花 token 的入口（另一处是上面的模糊问答）。 -->
          <button class="ghost ask-llm-btn ask-batch-btn" v-if="askAns.projectId" :disabled="batchBusy" @click="runBatch()">
            {{ batchBusy ? '正在出…' : '📋 出下一批任务卡（会计费）' }}
          </button>
        </div>
        <!-- 随纠（2026-10-22 · 03 任务二）：从这条答案直接改这个项目的方向 ——
             一句话 + 一次点击，不填表单。改完挂撤销条（Ctrl+Z 同效），决策卡自动留痕。
             只认固定句式（改 <字段> 为 <值>）：不猜，参数清。 -->
        <div class="ask-correct" v-if="askAns.projectId">
          <button class="ghost ask-correct-open" v-if="!correctOpen" @click="openCorrect()">
            ✎ 一句话改这个项目（状态 / 路线图 / 说明）
          </button>
          <template v-else>
            <div class="ask-correct-row">
              <input class="ask-in" v-model="correctText" :disabled="correctBusy"
                     placeholder="改 路线图 为 跑通第一单（项目名可省）" @keyup.enter="runCorrect()" />
              <button class="pri ask-go" :disabled="correctBusy || !correctText.trim()" @click="runCorrect()">
                {{ correctBusy ? '改…' : '就这么改' }}
              </button>
              <button class="ghost ask-chip" :disabled="correctBusy" @click="closeCorrect()">算了</button>
            </div>
            <div class="ask-correct-hint">
              能改的就三个字段：状态 / 路线图 / 说明（说明就是「欠着」那一栏）。
              改完自动记一张决策卡（出处「方寸随纠」），顶部撤销条能一步退回去。
            </div>
            <div class="ask-correct-err" v-if="correctErr">{{ correctErr }}</div>
          </template>
        </div>

        <div class="ask-llm-ans" v-if="askLlmAns">
          <div class="ala-h">AI 的回答<em class="ala-meta" v-if="askLlmMeta">{{ askLlmMeta }}</em></div>
          <div class="ala-t">{{ askLlmAns }}</div>
        </div>
        <div class="ask-llm-err" v-if="askLlmErr">{{ askLlmErr }}</div>
      </div>


      <!-- 月度花销报表（2026-10-22 · 03 任务三）：**常驻**在这一页底部，不用翻设置页。
           为什么要按自然月而不是"近 30 天"：1 号那天滚动窗口会把上个月的账算进"本月"，
           用户一核对就发现数字对不上 —— 报表错一次就没人再信它。
           ⚠ 只算供应商真报了 usage 的调用，没报的只计数、不折算（10-17 口径）。 -->
      <div class="ask-report" v-if="usageMonths.length">
        <div class="ask-report-h">
          AI 花销 · 按自然月
          <em class="ask-report-src">数据源：本机 AI 调用留痕（外部客户端经 MCP 上报的另计，不混算）</em>
        </div>
        <div class="ask-report-row" v-for="m in usageMonths" :key="m.month">
          <span class="arr-m">{{ m.month }}</span>
          <span class="arr-c">{{ m.calls }} 次<em v-if="m.fail">（失败 {{ m.fail }}）</em></span>
          <span class="arr-t">{{ Number(m.total_tokens || 0).toLocaleString() }} tokens<em v-if="m.token_calls < m.calls">· {{ m.calls - m.token_calls }} 次没给数字，只计数</em><em v-if="m.external_calls" class="arr-ext">· 其中 {{ m.external_calls }} 笔是外部上报</em></span>
          <!-- 金额（2026-10-25 卡 005）：**没有就是「未折算」**，不写 0 元。
               「未折算」后面带上笔数 —— 否则那一行看起来像"全月只花这么点"。 -->
          <span class="arr-cost" :class="{ none: !m.cost_calls }">
            <template v-if="m.cost_calls">≈ ¥{{ fmtCost(m.cost) }}<em v-if="m.unpriced_calls">· {{ m.unpriced_calls }} 次未折算</em></template>
            <template v-else>未折算</template>
          </span>
        </div>
      </div>
      <div class="ask-report ask-report-empty" v-else>
        AI 花销 · 按自然月：还没有任何调用记录（一次都没走过 AI 通道）。
      </div>

      <!-- 账户口径（2026-10-25 卡 005）：这一行**不是估算**，是官方余额接口的差值。
           暮雨给的参考实现点破了关键 —— 准的办法是不经过价格表：价格怎么变，
           余额下降额都是真花掉的钱。代价（粒度粗、要充值不混进消费）也写在这里。 -->
      <div class="ask-acc" v-if="balanceStatus">
        <div class="ask-report-h">
          账户口径 · 余额差值
          <em class="ask-report-src">
            {{ balanceStatus.supported ? '来自供应商余额接口，不是按 token 估算' : '这一口径不可用' }}
          </em>
        </div>
        <template v-if="balanceStatus.supported">
          <div class="ask-acc-row">
            <span class="arr-m">{{ providerLabel(balanceStatus.provider) }}</span>
            <span class="arr-c">观测 {{ balanceStatus.observations }} 次</span>
            <span class="arr-t">
              已观测消费 <b>{{ balanceStatus.spent }} {{ balanceStatus.currency }}</b>
              <em v-if="Number(balanceStatus.recharged) > 0">· 另有充值 {{ balanceStatus.recharged }}</em>
            </span>
          </div>
          <div class="ask-acc-note">
            <span v-if="balanceStatus.note">{{ balanceStatus.note }}</span>
            <span v-else>这是账户真实扣款（两次观测之间的差额），<b>归不到具体某一次调用</b>；逐笔要看上面的 token。</span>
            <button class="ghost ask-acc-btn" :disabled="balanceObserving" @click="refreshBalance">
              {{ balanceObserving ? '查…' : '⟳ 立刻查一次' }}
            </button>
          </div>
        </template>
        <div class="ask-acc-note" v-else>{{ balanceStatus.reason }}</div>
      </div>
    </main>

    <BoardView v-if="curView === 'active' || curView === 'archive'" :ctl="boardViewCtl" />

    <!-- Project view -->
    <main id="board" class="pv" v-else-if="curView === 'projects'">
      <div class="alertbar" v-if="blockers.length">
        <span class="ico">⚠</span>
        <b>{{ blockers.length }}</b> 个任务存在阻塞依赖
      </div>
      <!-- 项目页工具条（2026-10-17 暮雨第 6 条：「项目里面不能新建项目，点进去是新建任务」）。
           真因：新建项目弹窗与 confirmNewProject 早就写好了（`#proj-new-modal`），
           **但项目页从来没有一个按钮去打开它** —— 功能做完没接线，属于"看着有、其实没有"。
           删除入口原来只在每张项目卡右上角那个小 🗑 上，这里明写出来省得再找。 -->
      <div class="pv-tools">
        <button class="pri" title="在 registry.yaml 里登记一个新项目" @click="openNewProject">＋ 新建项目</button>
        <span class="pv-tools-hint">删除项目登记：每张项目卡右上角的 🗑（只删登记，不动任务卡与文件）</span>
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
      <!-- 跨项目建议（2026-10-11，C 组死通道接回）：主进程早就算好了（卡住/空闲项目一句话），
           界面从来没有入口。放在项目页顶部 —— 它是"看全局"的话，不属于某一个项目。 -->
      <div class="cross-suggest" v-if="crossSuggest.length">
        <span class="cs-label">建议</span>
        <span v-for="(s, i) in crossSuggest" :key="i" class="cs-item">{{ s }}</span>
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
            <button class="proj-del" title="移除项目登记（只删登记，不动任务卡与文件）"
                    @click.stop="removeProject(p)">🗑</button>
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
          <!-- 架构图（2026-10-29 暮雨第 2 条；2026-10-30 第 3 条再改）：
               以前是相邻两个几乎同名的按钮（「架构图」「自绘架构图」）—— 暮雨原话
               「和架构图按钮放在一起你自己不觉得尴尬吗」。现在收成**一个分段控件**：
               左半「架构图」= 打开仓库里已有的 archify 产物；右半「绘制架构图」= 方寸只读扫源码画一张。
               一个控件、两种来源，不再是两个抢位置的按钮。 -->
          <div class="pv-arch-group" role="group" aria-label="架构图">
            <button class="ghost pv-diagram" @click.stop="openProjectDiagram(p)"
              title="打开这个项目的架构图（仓库 docs/ 里 archify 生成的 HTML）；没有就先让 archify 生成一份放进去">架构图</button>
            <button class="ghost pv-archself" @click.stop="openSelfArch(p)"
              title="绘制架构图：方寸只读扫源码，节点 = 真实目录、连线 = 真实 import / IPC 计数；先过校验、你点头才允许导出">✎ 绘制架构图</button>
          </div>
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
            <span v-if="!(pvBreakdown[p.id] || []).length">这个项目还没有任务</span>
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
            <button class="ghost oact" @click.stop="openProjectTasks(p)">📦 任务 {{ p.taskCount }}</button>
            <button class="ghost oact" @click.stop="removeProject(p)"
                    title="只从 registry.yaml 移除登记；任务卡与项目文件都不动">🗑 移除登记</button>
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
      <div class="pv-ms" v-else-if="pvView === 'master'">
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
        <!-- 项目监控台（卡 task-20261009-001）：环形进度 + KPI 大数字 + 阻塞入口 + git 活动。
             健康度=左缘 4px 色条（契约「异常才显示」：stuck/dormant 才有，active/idle 干净白卡）。 -->
        <div class="ms-detail" v-if="pvCurrent" :class="'hs-' + pvCurrent.health">
          <div class="ocard bare">
            <div class="ohead">
              <span class="nm">{{ pvCurrent.name }}</span>
              <span class="rp">{{ pvCurrent.repo || '未登记工作目录' }}</span>
              <span class="hl" :class="'hl-' + pvCurrent.health">{{ healthLabel(pvCurrent.health) }}</span>
            </div>
            <!-- 自仓同步状态（2026-10-21 · W1-1C）：只在**没跟上**时出现一句话。
                 正常态不渲染（不写「已是最新」凑数），也不给手动按钮 —— 启动自动拉，
                 拉不动就照实说"待同步"，本地数据一个字不动。 -->
            <!-- 常驻一行：正常是灰字"已是最新"，异常才变色（2026-10-21：看不见就等于不存在） -->
            <div class="ms-sync" :class="'ms-sync-' + selfSyncLine.tone" v-if="selfSyncLine">
              <template v-if="selfSyncLine.tone === 'warn'">⚠ </template>{{ selfSyncLine.text }}
            </div>
            <div class="ms-metrics">
              <!-- 0 卡时不画假环：环换成空态占位（0/0 没有「完成度」可言），旁边图例给「还没有任务卡」 -->
              <div class="ms-ring" v-if="pvCurrent.taskCount">
                <svg viewBox="0 0 36 36" aria-hidden="true">
                  <circle class="ring-track" cx="18" cy="18" r="15.915" pathLength="100" />
                  <circle class="ring-arc" cx="18" cy="18" r="15.915" pathLength="100"
                          :style="{ strokeDasharray: pvPct + ' ' + (100 - pvPct) }" />
                </svg>
                <span class="ms-ringnum">{{ pvPct }}<i>%</i></span>
              </div>
              <div class="ms-ring empty" v-else><span class="ms-ringnum">—</span></div>
              <div class="ms-nums">
                <div class="ms-num"><b>{{ pvCurrent.activeTasks }}</b><span>进行中</span></div>
                <div class="ms-num"><b>{{ pvCurrent.completedTasks }}</b><span>已完成</span></div>
                <div class="ms-num"><b>{{ pvCurrent.taskCount }}</b><span>总任务</span></div>
                <div class="ms-num warn" v-if="pvBlocked[pvCurrent.id]"><b>{{ pvBlocked[pvCurrent.id] }}</b><span>阻塞源</span></div>
              </div>
            </div>
            <div class="stack">
              <i v-for="s in (pvBreakdown[pvCurrent.id] || [])" :key="s.status"
                 :style="{ width: segWidth(s.n, pvCurrent.taskCount), background: statusSegColor(s.cls) }"></i>
            </div>
            <div class="legend">
              <span v-for="s in (pvBreakdown[pvCurrent.id] || [])" :key="s.status">
                <s :style="{ background: statusSegColor(s.cls) }"></s>{{ s.status }} {{ s.n }}
              </span>
              <span v-if="!pvCurrent.taskCount" class="ms-nothing">还没有任务卡</span>
            </div>
            <!-- 阻塞源入口（异常才显示）：点进阻塞页签看「卡在谁」 -->
            <button class="ghost ms-blockers" v-if="pvBlocked[pvCurrent.id]"
                    @click.stop="switchView('blockers')">⚠ {{ pvBlocked[pvCurrent.id] }} 个阻塞源 · 看卡在谁 →</button>
            <div class="ody n">
              最近：<b>{{ pvCurrent.lastActivity ? relativeTime(pvCurrent.lastActivity) : '无记录' }}</b>
              <template v-if="pvLatest[pvCurrent.id]"> · {{ pvLatest[pvCurrent.id]!.title || pvLatest[pvCurrent.id]!.id }}</template>
            </div>
            <!-- 项目三字段（2026-10-16 批次第 2 项起的「说明」；2026-10-22 · 06 单扩成三件）：
                 状态 / 路线图 / 说明（欠着什么）都是 registry 里的**手写值**，
                 与下面「自动 · 只读」那块并列摆着 —— 谁旧了由人看，代码不裁。
                 可就地改：改完走全站同一个撤销条，Ctrl+Z 一步退回去（1B 撤销栈的同一套语义）。 -->
            <div class="ms-fields" v-if="noteEdit && noteEdit.id === pvCurrent.id">
              <div class="msf-h">改「{{ pvCurrent.name }}」的三个手写字段</div>
              <label class="msf">
                <span class="msf-k">状态</span>
                <input class="msf-i" v-model="noteEdit.状态" placeholder="一句话说到哪了，带时点，比如（0.3.9，10-21）" />
              </label>
              <label class="msf">
                <span class="msf-k">路线图</span>
                <input class="msf-i" v-model="noteEdit.路线图" placeholder="目标是什么；「不做」的事关键就带半句" />
              </label>
              <label class="msf">
                <span class="msf-k">说明</span>
                <textarea class="msf-t" v-model="noteEdit.说明" rows="3"
                          placeholder="欠着什么——逐条列，不压不删"></textarea>
              </label>
              <div class="msf-acts">
                <button class="ok" :disabled="noteSaving" @click.stop="saveNoteEdit()">{{ noteSaving ? '保存中…' : '保存' }}</button>
                <button class="ghost" :disabled="noteSaving" @click.stop="cancelNoteEdit()">取消</button>
                <span class="msf-tip">保存后顶部出撤销条（Ctrl+Z 也能退）</span>
              </div>
            </div>
            <template v-else>
              <div class="ms-note" v-if="pvCurrent.statusNow || pvCurrent.roadmap || pvCurrent.note">
                <div class="msn-row" v-if="pvCurrent.statusNow"><span class="msn-k">状态</span><span class="msn-v">{{ pvCurrent.statusNow }}</span></div>
                <div class="msn-row" v-if="pvCurrent.roadmap"><span class="msn-k">路线图</span><span class="msn-v">{{ pvCurrent.roadmap }}</span></div>
                <div class="msn-row" v-if="pvCurrent.note"><span class="msn-k">说明</span><span class="msn-v">{{ pvCurrent.note }}</span></div>
              </div>
              <button class="ghost ms-editbtn" @click.stop="openNoteEdit(pvCurrent)">✎ 改状态 / 路线图 / 说明</button>
            </template>
            <!-- 路线文档实况（2026-10-21 · W1-批次 2）：把仓库里的 README/ROADMAP **自动**读回来，
                 与上面那句**手写**说明并列摆着 —— 两边不一致本身就是信息（谁旧了），
                 代码不裁也不覆盖。README 只给一句话摘要（用户向的展示公告，不该占版面），
                 ROADMAP 才是"接下来做什么"的正主。读不到就给原因，不糊一句"没有进展"。 -->
            <div class="ms-docs" v-if="msDocs">
              <div class="ms-docs-h">
                <span class="ms-docs-src" title="自动读自仓库：README / ROADMAP + 最近动过 docs/ 的提交（只读，且只读一天一次）">自动 · 只读</span>
                <span class="ms-docs-at">{{ msDocs.cached ? '今天读过' : '刚读' }}</span>
              </div>
              <template v-if="msDocs.readme || msDocs.roadmap">
                <!-- ROADMAP 在前（"接下来做什么"才是监控台要回答的问题）；README 在后，
                     它是项目**对外**说明，常有一句没信息量的标语 —— 所以默认两行、点开看全文。 -->
                <div class="ms-doc" v-if="msDocs.roadmap" :class="{ open: docOpen.roadmap }"
                  :title="msDocs.roadmap.rel + '（点一下展开 / 收起）'" @click="toggleDoc('roadmap')">
                  <span class="ms-doc-k">ROADMAP</span>
                  <span class="ms-doc-t">{{ docOpen.roadmap ? (msDocs.roadmap.more || msDocs.roadmap.excerpt) : (msDocs.roadmap.excerpt || msDocs.roadmap.title) }}</span>
                  <span class="ms-doc-m">{{ relativeTime(msDocs.roadmap.mtime) }}</span>
                </div>
                <div class="ms-doc" v-if="msDocs.readme" :class="{ open: docOpen.readme }"
                  :title="msDocs.readme.rel + '（对外说明，点一下展开 / 收起）'" @click="toggleDoc('readme')">
                  <span class="ms-doc-k">README</span>
                  <span class="ms-doc-t">{{ docOpen.readme ? (msDocs.readme.more || msDocs.readme.excerpt) : (msDocs.readme.excerpt || msDocs.readme.title) }}</span>
                  <span class="ms-doc-m">{{ relativeTime(msDocs.readme.mtime) }}</span>
                </div>
              </template>
              <div class="ms-doc-none" v-else>{{ msDocs.note || '仓库里没有 README / ROADMAP' }}</div>
              <!-- 只有 README 没有 ROADMAP：把这句话说出来，别让人把"对外说明"当成路线 -->
              <div class="ms-doc-none" v-if="(msDocs.readme || msDocs.roadmap) && msDocs.note">{{ msDocs.note }}</div>
              <div class="ms-docs-log" v-if="msDocs.docsCommits && msDocs.docsCommits.length">
                最近 docs 变更 <b>{{ msDocs.docsCommits.length }}</b> 条 · 最后 <b>{{ msDocs.docsCommits[0].subject }}</b>（{{ msDocs.docsCommits[0].date }}）
              </div>
            </div>
            <!-- git 活动：在途一屏的数据已在内存才显示；没拉过给手动入口（不默认付 git 扫描的钱，
                 与 loadViewData「只在切到那一摆法时才拉」的既有纪律一致） -->
            <div class="ms-git" v-if="msGitRow">
              <span>📂 最近提交 <b>{{ msGitRow.lastCommit || '读不到' }}</b></span>
              <span>未提交 <b>{{ msGitRow.dirty === null || msGitRow.dirty === undefined ? '—' : msGitRow.dirty }}</b></span>
            </div>
            <button class="ghost ms-gitbtn" v-else @click.stop="loadTripBoard()">⟳ 拉取提交信息</button>
            <!-- 最近执行日志流（2026-10-11 监控台 P0 之一）：只说"最近在干什么"，
                 不做筛选/分页 —— 要看全的点「看全部 →」，那边才是日志页的主场。 -->
            <div class="ms-feed">
              <div class="ms-feed-h">
                <span>最近执行日志</span>
                <button class="ghost ms-feed-go" @click.stop="openProjectLogs()">看全部 →</button>
              </div>
              <div class="ms-log" v-for="l in msLogs" :key="l.id">
                <span class="ms-log-dot" :class="{ run: l.running }"></span>
                <span class="ms-log-t">{{ l.title || l.id }}</span>
                <span class="ms-log-tm">{{ relativeTime(l.logDate || l.created) }}</span>
              </div>
              <div class="ms-log-none" v-if="!msLogs.length">这个项目还没有执行日志</div>
            </div>
            <!-- 僵尸卡（P0 之二）：判据与通知中心同源（`findStalledTasks`），这里只是把它**放到监控台上**。
                 只报数 + 可点进去看，不在这里做处置 —— 处置入口在任务卡上。 -->
            <button class="ghost ms-stalled" v-if="msStalled.length"
              @click.stop="openProjectTasks(pvCurrent)"
              :title="msStalled.map(s => s.title + '（' + s.hours + ' 小时没动静）').join('\n')">
              ⚠ {{ msStalled.length }} 个任务「进行中」但超过 {{ STALLED_HOURS }} 小时没动静 · 看看 →
            </button>
            <!-- 建议动作 + 可并行机会（2026-10-11，死通道 A 组收口）：
                 这两条通道早就在主进程算好了，界面此前从不调用（= 死通道）。接上它，
                 用户在这一屏就能看到"这个项目下一步该干嘛、哪几件事可以并着做"。 -->
            <div class="ms-suggest">
              <div class="ms-suggest-h">建议动作</div>
              <div class="ms-suggest-item" v-for="(s, i) in pvSuggest" :key="'sg' + i">· {{ s }}</div>
              <div class="ms-log-none" v-if="!pvSuggest.length">（还没有可给的建议）</div>
            </div>
            <div class="ms-suggest" v-if="pvParallelMine.length">
              <div class="ms-suggest-h">可并行机会</div>
              <div class="ms-suggest-item" v-for="(o, i) in pvParallelMine" :key="'pp' + i">· {{ o.reason }}</div>
            </div>
            <div class="oacts">
              <!-- AI 规划（写回层 UI 入口，2026-10-12）：只产「待审批」草稿，点头才转正。
                   12 条 LLM 通道后端 10-06 起就绪，界面入口今天才装——「电路铺好了开关没装」的补开关。 -->
              <button class="ghost oact" @click.stop="openAiPlan(pvCurrent)">✨ AI 规划</button>
              <button class="ghost oact" @click.stop="openAiDoc(pvCurrent)">📄 文档拆卡</button>
              <!-- 规划管理（2026-10-16 第 1 项）：四条规划通道后端 10-11 起就绪、界面今天接——
                   「电路铺好了开关没装」的第二排开关。非 AI：手工建规划+决策点选卡留痕。 -->
              <button class="ghost oact" @click.stop="openPlans(pvCurrent)">🗂 规划</button>
              <button class="ghost oact" @click.stop="openPolicyEdit(pvCurrent.id)">📋 {{ policyMap[pvCurrent.id] ? '方针' : '立方针' }}</button>
              <button class="ghost oact" @click.stop="openStructMap()">🗺 结构地图</button>
              <button class="ghost oact" @click.stop="openProjectTasks(pvCurrent)">📦 看任务</button>
              <!-- agent 上下文包（2026-10-22 · b 版落地物）：把契约/方针/决策/未完成卡/最近日志
                   拼成一段可直接粘给 agent 的 Markdown。只读，不改任何东西。 -->
              <button class="ghost oact" @click.stop="copyContextPack(pvCurrent)"
                      title="复制一段现成的项目上下文，直接粘给本地 agent —— 它不用再从零翻你的仓库">📋 复制上下文包</button>
              <!-- 不做「打开工作目录」——主进程没有"打开任意路径"的通道，也刻意不暴露。
                   能做的只是把路径复制走，那就只给这个，不摆一个点了没反应的按钮。 -->
              <button v-if="pvCurrent.repo" class="ghost oact"
                      @click.stop="copyWithToast(pvCurrent.repo, '已复制工作目录')">⧉ 复制路径</button>
              <button class="ghost oact" @click.stop="removeProject(pvCurrent)"
                      title="只从 registry.yaml 移除登记；任务卡与项目文件都不动">🗑 移除登记</button>
            </div>
          </div>
        </div>
        <div class="ms-detail empty" v-else>还没有项目 —— 点左下角「＋ 添加项目」登记第一个。</div>
      </div>

      <!-- ══ ⑤ 梯度榜（2026-10-25 暮雨）：项目页的第 5 种摆法 —— 手动拖档的 Tier List。
           边界写死在 views/ProjectTierBoard.vue 与 services/projectTiers.ts：
           只服务这一页，不改看板分组、不改一屏行序、不动 registry。 -->
      <ProjectTierBoard
        v-else-if="pvView === 'tier'"
        :projects="projects"
        :toast="showToast"
      />
      <!-- ══ ⑥ 对不上（2026-10-27 · REV-008 一期 R4「让对不上可见」）════════
           状态过期 / 引用断裂 / 完成但没判据 —— 三类全是**只读报告**，不阻挡任何操作。
           判定在 shared/mismatch.ts（e2e-mismatch 32 条纯 Node 断言），这里只管摆。
           ⚠ 必须紧接在上一分支之后：v-if 链中间插元素会让其后视图整页不渲染。 -->
      <MismatchView
        v-else-if="pvView === 'mismatch'"
        :toast="showToast"
      />
      <!-- ══ ⑦ 需求矩阵（2026-10-28 · RICE 决策矩阵）══════════════════════
           散点 + 表格 + 手改即时重算 + 拍板导出。口径全在 shared/rice.ts
           （e2e-rice 用纯 Node 验），数据在 task-data/rice-pool.md。
           ⚠ 页签**零网络**；分数只存四个原始分，总分现算、不落盘。 -->
      <RiceMatrixView
        v-else-if="pvView === 'rice'"
        :toast="showToast"
        :tasks="tasks"
        :projects="projects"
      />

      <!-- ══ ④ 在途一屏（2026-10-05 Q2 · 立项契约 ② 验收线之①）══════════════
           一行一个在途项目：终态 / 当前步骤 / 下一步 / 卡在谁 / 健康度 / 卡·日志。
           数据来自主进程**只读**聚合（契约 + 任务卡 + 执行日志 + git）；缺值一律「未填」。
           旧三摆法一个字没动，「在途一屏」是新增的第 4 项。 -->
      <div class="tripboard" v-else-if="pvView === 'trip'">
        <div class="trip-head">
          <span class="trip-ttl">在途一屏</span>
          <span class="trip-sub">{{ tripSubtitle }}</span>
          <span class="trip-grow"></span>
          <button class="ghost trip-headbtn" @click="tripSettingsOpen = true">⚙ 显示设置</button>
          <!-- 读取中要在**按钮上**也看得出来（2026-10-11 用户：「每次进都要卡一下，哪怕有个加载小提示」）：
               第二次进这一屏时旧数据还在屏上，光靠"空表才显示读取中"是不够的 —— 用户看到的是
               一张不会动的旧表，除了"卡了"什么也读不出来。 -->
          <button class="ghost trip-headbtn" :disabled="tripLoading" @click="loadTripBoard()">
            {{ tripLoading ? '⟳ 读取中…' : '↻ 刷新' }}</button>
        </div>

        <!-- 还没数据 → 整屏「读取中」；已经有旧数据 → 保留旧表 + 顶上一条细刷新提示
             （直接把旧表换成"读取中"会更差：用户刚看到的东西突然消失，像是被清了）。 -->
        <div v-if="tripLoading && !tripRows.length" class="trip-empty">读取中…<span class="trip-loading-sub">（正在读各项目的立项契约与 git 信息）</span></div>
        <div v-else-if="!tripRows.length" class="trip-empty">
          <template v-if="tripError">
            <div class="trip-err">读取失败：{{ tripError }}</div>
            <div class="trip-err-hint">
              如果上面那句里有「no handler registered」这类话，说明方寸的后台还是旧代码 ——
              界面会自动更新，后台只在启动时读一次。<b>请完全退出方寸再打开</b>
              （关掉窗口不算退出，它常驻托盘：右键托盘图标 → 退出）。
            </div>
          </template>
          <template v-else>
            <div>{{ tripEmptyHint }}</div>
            <!-- 空屏 + 手动模式 = 死局（用户只会以为界面坏了）。给条一步就能走出去的路。 -->
            <button v-if="tripMode === 'manual'" class="ghost trip-headbtn trip-empty-act"
                    @click="tripBackToAuto()">改回自动</button>
          </template>
        </div>

        <div v-if="tripLoading && tripRows.length" class="trip-refreshing">
          ⟳ 正在刷新（读取各项目立项契约与 git 信息）…
        </div>
        <div v-if="tripRows.length" class="trip-scroll">
          <table class="trip-table">
            <thead>
              <tr>
                <th class="trip-th-pj">项目</th>
                <th v-if="tripColVisible('end')">终态（一句话）</th>
                <th v-if="tripColVisible('current')">当前步骤</th>
                <th v-if="tripColVisible('next')">下一步</th>
                <th v-if="tripColVisible('who')">卡在谁</th>
                <th v-if="tripColVisible('owe')">欠着什么</th>
                <th v-if="tripColVisible('health')">健康度</th>
                <th v-if="tripColVisible('counts')">任务 / 日志</th>
                <th v-if="tripColVisible('commit')">最近提交</th>
                <th v-if="tripColVisible('dirty')">未提交</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in tripRows" :key="r.id" :class="{ 'trip-anomaly': r.flags && r.flags.noCards }"
                  @click="tripOpenRow(r, $event)">
                <td class="trip-pj">
                  <b>{{ r.name }}</b>
                  <span class="trip-pid">{{ r.id }}</span>
                  <button class="proj-del" title="移除项目登记（只删登记，不动任务卡与文件）"
                          @click.stop="removeProject(r)">🗑</button>
                </td>

                <!-- 终态：读各 repo 的 立项契约.md；没有就显式「未填」+ 两个按钮（不给假默认值）
                     ⚠ 分支先看 exists 再看内容（卡 002）：旧版把「文件在但还没填内容」并进了
                     「未填」分支 —— 于是文件建完之后界面上只剩「建契约文件」（会被主进程拒绝），
                     用户原话「创完就改不了、懒得去文件夹自己找」。 -->
                <td v-if="tripColVisible('end')" class="trip-end">
                  <template v-if="r.contract && r.contract.exists">
                    <span v-if="tripFirstLine(r.contract.endState)" class="trip-end-txt" :title="r.contract.path">{{ tripFirstLine(r.contract.endState) }}</span>
                    <!-- 空的原因要**分类**（2026-10-11 真机修正）。旧版一律写「内容未填」——
                         绒花墨坊的契约明明写得很完整，只因小节名是「① 终态三段」而不是「终态形态」，
                         就被报成"内容未填"（用户原话「已经有内容了啊？」）。**这是界面说假话。** -->
                    <span v-else class="trip-unset" :title="tripContractMissing(r).title || r.contract.path">
                      文件已建 · {{ tripContractMissing(r).text }}
                    </span>
                    <button class="ghost trip-mini" :disabled="!r.contract.path" @click.stop="tripOpenContract(r)"
                            title="用系统默认程序打开这个契约文件，直接改内容">📄 打开契约</button>
                    <!-- 「让 AI 填」的可复制提示词（2026-10-10 用户要求：原话「之前说让 AI 填，
                         但是不知道怎么弄」）。上一版只在旁边写了句「也可以让 AI 填」——
                         没给**能粘贴的东西**，等于没说。这里给的是一段可直接贴进
                         「该项目仓库里开的 AI 会话」的话（含逐节念回签收的规矩）。 -->
                    <button class="ghost trip-mini" @click.stop="tripCopyContractPrompt(r)"
                            title="复制一段话 —— 贴到这个项目仓库里开的 AI 会话，它就会按契约骨架逐节填，并逐节念回给你确认">⧉ 复制 AI 提示词</button>
                  </template>
                  <template v-else>
                    <span class="trip-unset">未填</span>
                    <button class="ghost trip-mini" :disabled="!r.repo" @click.stop="tripInitContract(r)"
                            title="方寸直接在这个项目文件夹里建好「立项契约.md」（文件已存在就不动它）">📝 建契约文件</button>
                    <button class="ghost trip-mini" @click.stop="tripCopyContract(r)"
                            title="只复制文字，你自己挑地方落盘">复制模板</button>
                    <button class="ghost trip-mini" :disabled="!r.repo" @click.stop="tripOpenRepo(r)"
                            title="打开该项目的文件夹">📁 打开项目文件夹</button>
                    <span class="trip-dim-sm">建好后打开它填内容（也可以让 AI 填）</span>
                  </template>
                </td>

                <!-- 当前步骤：进行中的卡 → 没有就回落到最近一条执行日志（司天这类 0 卡项目靠它） -->
                <td v-if="tripColVisible('current')" class="trip-step">
                  <template v-if="r.current && r.current.text">
                    <span class="trip-step-k">{{ r.current.text }}<span v-if="r.current.from === 'log'" class="trip-from">日志</span></span>
                    <span v-if="r.current.sub" class="trip-dim-sm">{{ r.current.sub }}</span>
                  </template>
                  <span v-else-if="r.flags && r.flags.noCards" class="trip-dim">还没有任务卡</span>
                  <span v-else class="trip-dim">没有正在进行的任务</span>
                </td>

                <td v-if="tripColVisible('next')" class="trip-step">
                  <template v-if="r.next && r.next.text">
                    <span class="trip-step-k">{{ r.next.text }}</span>
                    <span v-if="r.next.sub" class="trip-dim-sm">{{ r.next.sub }}</span>
                  </template>
                  <span v-else class="trip-dim">没有待办任务</span>
                </td>

                <td v-if="tripColVisible('who')" class="trip-who">
                  <span v-if="r.who && r.who.kind === 'review'" class="trip-chip warn">{{ r.who.text }}</span>
                  <span v-else-if="r.who && r.who.kind === 'exec'" class="trip-chip">{{ r.who.text }}</span>
                  <span v-else-if="r.who && r.who.text" class="trip-chip warn">{{ r.who.text }}</span>
                  <span v-else class="trip-dim">—</span>
                </td>

                <!-- 欠着什么（2026-10-22 · 03 任务三）：registry 手写的「说明」字段 ——
                     它才是用户自己的欠账清单（卡是"要做的事"，欠账是"欠着谁的"）。
                     长了就截第一行、全文挂 title：这一列是"扫一眼知道欠着"，不是阅读区。 -->
                <td v-if="tripColVisible('owe')" class="trip-owe">
                  <span v-if="r.owe" class="trip-owe-t" :title="r.owe">{{ tripFirstLine(r.owe) }}</span>
                  <span v-else class="trip-dim">未写</span>
                </td>

                <!-- 健康度：机器只给默认值，点一下人工覆盖并锁定（右键恢复自动） -->
                <td v-if="tripColVisible('health')" class="trip-health">
                  <span class="trip-hdot" :class="'h-' + tripHealthClass(r.health.value)"></span>
                  <button class="trip-hbtn" :class="{ locked: r.health.locked }"
                          :title="r.health.locked
                            ? '你标过（已锁定）—— 点一下换下一档；右键恢复自动'
                            : '方寸按这个项目最近有没有提交算出来的默认值 —— 点一下可人工改成你的判断'"
                          @click.stop="tripCycleHealth(r)" @contextmenu.prevent="tripUnlockHealth(r)">
                    {{ tripHealthLabel(r.health.value) }}<span v-if="r.health.locked" class="trip-lock">🔒</span>
                  </button>
                </td>

                <td v-if="tripColVisible('counts')" class="trip-cnt">
                  <span :class="{ 'trip-dim': !(r.counts.doing || r.counts.todo || r.counts.review) }">
                    <template v-if="r.counts.doing">{{ r.counts.doing }} 进行</template>
                    <template v-if="r.counts.todo">{{ r.counts.todo }} 待办</template>
                    <template v-if="r.counts.review">{{ r.counts.review }} 待验</template>
                    <template v-if="!(r.counts.doing || r.counts.todo || r.counts.review)">0 卡</template>
                  </span>
                  <span class="trip-dim-sm">{{ r.counts.logs }} 条日志</span>
                </td>

                <td v-if="tripColVisible('commit')" class="trip-dim">{{ r.lastCommit || '读不到' }}</td>
                <td v-if="tripColVisible('dirty')" class="trip-dim">{{ r.dirty === null || r.dirty === undefined ? '—' : r.dirty }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 管理入口：添加入口在四种摆法里必须都在（2026-10-05 用户：「项目页签里似乎没有添加和删除项目的入口」） -->
        <div class="trip-actions">
          <button class="ghost trip-headbtn" @click="openNewProject">＋ 添加项目</button>
          <span class="trip-dim-sm">新登记的项目按规则自动进这一屏；想固定，用右上「⚙ 显示设置」改成手动指定</span>
        </div>

        <p class="trip-hidden" v-if="tripHidden.length">
          <template v-if="tripHiddenNotPicked.length">
            另有 {{ tripHiddenNotPicked.length }} 个已登记项目没进这一屏
            （{{ tripHiddenNotPicked.map(h => h.name).join('、') }}）——
            你选的是「手动指定」，但没有勾它们，所以它们不显示。
            点「⚙ 显示设置」把它们勾上就行（勾选会自动切成手动）。
          </template>
          <template v-if="tripHiddenNoActivity.length">
            <template v-if="tripHiddenNotPicked.length"><br></template>
            另有 {{ tripHiddenNoActivity.length }} 个已登记项目没进这一屏
            （{{ tripHiddenNoActivity.map(h => h.name).join('、') }}）——
            它们没有未完结任务，30 天内也没有提交。
            想看到它们：点「⚙ 显示设置」把「哪些项目算在途」放宽，或改成「手动指定」自己勾。
          </template>
        </p>

        <p class="trip-foot">
          这一屏读的是：各项目里的 <code>立项契约.md</code>、任务卡、执行日志、文件夹最近提交时间。
          读不到的地方一律写「未填」，不替你猜。
        </p>

        <!-- 裁断入口：机器口径只是默认值，用户改过就以用户的为准 -->
        <div v-if="tripSettingsOpen" class="trip-modal-mask" @mousedown.self="tripSettingsOpen = false">
          <div class="trip-modal">
            <div class="trip-modal-h">
              <b>显示设置</b>
              <button class="ghost trip-headbtn" @click="tripSettingsOpen = false">关闭</button>
            </div>
            <div class="trip-modal-b">
              <div class="trip-col">
                <h4>收哪些项目</h4>
                <p class="trip-hint">「自动」按下面的规则筛；「手动指定」按你勾的来 —— 默认不写死任何一个项目名。</p>
                <div class="trip-modes">
                  <label :class="{ on: tripMode === 'auto' }">
                    <input type="radio" name="tripmode" :checked="tripMode === 'auto'" @change="tripSetMode('auto')"> 自动
                  </label>
                  <label :class="{ on: tripMode === 'manual' }">
                    <input type="radio" name="tripmode" :checked="tripMode === 'manual'" @change="tripSetMode('manual')"> 手动指定
                  </label>
                </div>
                <div class="trip-chips">
                  <label v-for="p in projectStats" :key="p.id" class="trip-chk" :class="{ on: tripManualIds.includes(p.id) }">
                    <input type="checkbox" :checked="tripManualIds.includes(p.id)" @change="tripToggleManual(p.id)">
                    {{ p.name }}
                  </label>
                </div>
              </div>
              <div class="trip-col">
                <h4>哪些项目算「在途」</h4>
                <p class="trip-hint">自动模式下按这条规则筛。</p>
                <div class="trip-chips">
                  <label v-for="c in TRIP_CRITERIA_OPTIONS" :key="c.v" class="trip-chk" :class="{ on: tripCriteria === c.v }">
                    <input type="radio" name="tripcrit" :checked="tripCriteria === c.v" @change="tripSetCriteria(c.v)">
                    {{ c.label }}
                  </label>
                </div>
                <h4 style="margin-top:12px">显示哪些列</h4>
                <div class="trip-chips">
                  <label v-for="c in TRIP_COL_OPTIONS" :key="c.v" class="trip-chk" :class="{ on: tripCols.includes(c.v) }">
                    <input type="checkbox" :checked="tripCols.includes(c.v)" @change="tripToggleCol(c.v)">
                    {{ c.label }}
                  </label>
                </div>
              </div>
            </div>
            <div class="trip-modal-f">
              <button class="ghost" @click="tripResetSettings()">恢复默认</button>
              <span class="trip-grow"></span>
              <button class="pri" @click="tripCloseAfterSave()">保存</button>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- 技能安装专区（2026-09-26 卡 038）：不做插件市场，就是一块「看得见 + 能复制」的说明面板 -->
    <!-- 技能安装专区（2026-10-23 拆成组件 · 拆分计划第 1 批第 6 块）。
         四个注入项都不是数据，而是这一页没有的能力：提示条 / 复制 / 拖拽心跳 / 心跳状态。 -->
    <SkillsView v-else-if="curView === 'skills'"
      :toast="showToast" :copy="copyWithToast" :pulse="dragPulse" :drag-alive="dragAlive" />

    <!-- 服务 / 端口（2026-09-26 卡 006）：用户选的是 A 档 —— 只读监控 + 冲突预警，绝不杀进程 -->
    <!-- 服务/端口（2026-10-23 拆成组件 · 拆分计划第 1 批第 5 块）。
         它自己 onMounted 加载；toast 由本文件注入（提示条是全站状态，不归这一页）。 -->
    <ServicesView v-else-if="curView === 'services'" :toast="showToast" />

    <!-- 回收站（2026-09-26 卡 034）：数据一直在 task-data/.trash，此前缺的只是界面入口 -->
    <!-- 回收站（2026-10-23 拆成组件 · 拆分计划第 1 批第 8 块）。
         视图 + 两个弹窗 + 240 行脚本整块搬；它自己 onMounted 加载，toast 由本文件注入。 -->
    <TrashView v-else-if="curView === 'trash'" :toast="showToast" />


    <!-- Blockers view: 2026-09-23 改为按阻塞源分组（用户第 4 条） -->
    <!-- 阻塞源（2026-10-22 拆成组件 · 拆分计划第 1 批第 2 块：只吃一个数据源、零交互）。
         为什么不是方案原定的 calendar —— 见 BlockersView.vue 头部的实测。 -->
    <BlockersView v-else-if="curView === 'blockers'" :chains="blockerChains" />

    <!-- 决策卡（2026-10-12 AI 规划包第 3 件；2026-10-14 术语白话化 + UI 基座第 ④ 步第一单）：
         定下来的事都在这——事情 / 哪天定的 / 还算不算数 / 出处。数据 = task-data/decisions.md
         （与 Python CLI 双腿同文件）；三态不挂任务状态机：决策不流转。
         整块视图已切到组件 `components/DecisionBoard.vue`（shadcn-vue 口径）——
         ⚠ 不写在 App.vue 里的原因是硬的：`tailwind.config.js` 的 `content` **不能扫 App.vue**
           （`.fixed`/`.hidden` 这类同名老类名会凭空生成规则、全仓观感漂移）。 -->
    <DecisionBoard
      v-else-if="curView === 'decisions'"
      id="board"
      class="decisions-view"
      @notify="showToast"
    />

    <!-- 帮助手册（2026-10-12 暮雨第 4 条：「想加其他主按钮，比如首页、帮助手册、同步」）——
         做**视图内**的离线手册页，不引外部 HTML 文件：
         ① 与其它视图同一套渲染与主题，暗色/亮色自动跟随，不用再维护第二份样式；
         ② 打包不用管额外静态资源路径（file:// 下引外部 HTML 最容易踩路径坑）；
         ③ 内容全部是静态事实，**不假装**能调什么 —— 数据是你自己的，手册只说"在哪里、怎么用"。
         ⚠ 界面文案不得带 Markdown 标记（`.、`**`、反引号）—— `check-ui-copy` 会判红，
           要展示键名/路径就用 `<code>`。 -->
    <!-- 帮助手册（2026-10-22 拆成组件 · 拆分计划第 1 批第 1 块：纯静态、零状态、真好验）。
         样式仍在下面全局 <style> 里，组件不带样式 —— 所以拆完像素不变。 -->
    <HelpView v-else-if="curView === 'help'" @home="goHome" />

    <!-- Todos view -->
    <!-- 想法（2026-10-22 · 念头没有家）：随手记一句，之后决定 做 / 搁置 / 不做。
         刻意做得很轻 —— 没有优先级、没有截止日、不归属项目、不进逾期、不进待办。
         一旦给它加上这些，它就又变成待办了（那正是"放不下"的原因）。 -->
    <main id="board" class="ideas-view" v-else-if="curView === 'ideas'">
      <div class="ideas-wrap">
        <div class="ideas-head">
          <div class="ideas-lead">念头先扔这儿，做不做以后再说</div>
          <div class="ideas-lead-sub">
            这里的东西不算任务、不进逾期、不进待办。决定做了才转成待办，转出去也留着记录。
          </div>
        </div>

        <div class="ideas-box">
          <textarea class="ideas-in" v-model="ideaDraft" :disabled="ideaBusy" rows="2"
            placeholder="想到什么就写一句 —— Ctrl+Enter 存下"
            @keydown.ctrl.enter.prevent="saveIdea()"
            @keydown.meta.enter.prevent="saveIdea()"></textarea>
          <div class="ideas-sub">
            <span class="ideas-hint">
              <template v-if="ideaDraft.trim()">{{ ideaDraft.trim().length }} / 4000 字</template>
              <template v-else>存下来不改任何待办和任务，也不会让任何东西逾期</template>
            </span>
            <button class="pri ideas-save" :disabled="ideaBusy || !ideaDraft.trim()" @click="saveIdea()">
              {{ ideaBusy ? '记…' : '记下来' }}
            </button>
          </div>
        </div>

        <div class="ideas-sec">
          <div class="ideas-sec-h">
            还没决定 <em>{{ ideasOpen.length }}</em>
          </div>
          <div class="ideas-empty" v-if="!ideasOpen.length">
            还没有念头。上面写一句就存下了 —— 不用想它要不要做。
          </div>
          <div class="idea" v-for="i in ideasOpen" :key="i.id">
            <div class="idea-t">{{ i.text }}</div>
            <div class="idea-sub">
              <span class="idea-when">记于{{ relativeTime(i.createdAt) || '刚刚' }}</span>
              <div class="idea-acts">
                <button class="ok idea-do" :disabled="ideaBusy" @click="doIdea(i)"
                  title="决定做 —— 真的在待办里生出一条，之后能退回来">做</button>
                <button class="ghost idea-hold" :disabled="ideaBusy" @click="holdIdea(i)"
                  title="先放着，不是否决 —— 将来还能捡回来">搁置</button>
                <button class="ghost idea-drop" :disabled="ideaBusy" @click="dropIdea(i)"
                  title="想过了，不做 —— 这条会留着；想过本身也有价值">不做</button>
                <button class="ghost idea-del" :disabled="ideaBusy" @click="removeIdea(i)"
                  title="记错了就删掉（能撤销）">×</button>
              </div>
            </div>
          </div>
        </div>

        <div class="ideas-sec" v-if="ideasDecided.length">
          <div class="ideas-sec-h ideas-toggle" @click="ideasShowDecided = !ideasShowDecided">
            <span>已经有结论 <em>{{ ideasDecided.length }}</em></span>
            <span class="ideas-caret">{{ ideasShowDecided ? '收起' : '展开' }}</span>
          </div>
          <template v-if="ideasShowDecided">
            <div class="idea idea-decided" v-for="i in ideasDecided" :key="i.id">
              <div class="idea-t">{{ i.text }}</div>
              <div class="idea-sub">
                <span class="idea-badge" :class="'is-' + ideaStatusKey(i.status)">{{ i.status }}</span>
                <span class="idea-note" v-if="i.note">{{ i.note }}</span>
                <span class="idea-when">{{ relativeTime(i.decidedAt || i.createdAt) }}</span>
                <div class="idea-acts">
                  <button class="ghost" v-if="i.status === '已立项'" :disabled="ideaBusy" @click="undoDoIdea(i)">
                    撤销立项
                  </button>
                  <button class="ghost" v-else :disabled="ideaBusy" @click="reviveIdea(i)"
                    title="捡回来，重新当还没决定的">捡回来</button>
                  <button class="ghost idea-del" :disabled="ideaBusy" @click="removeIdea(i)" title="删掉（能撤销）">×</button>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </main>

    <!-- 待办（2026-10-23 拆成组件 · 拆分计划第 1 批第 10 块）。
         数据与动作在 composables/useTodos.ts，模板在 views/TodosView.vue；
         `#board.todos-view` 这层壳由组件根元素带着（视图互斥与几何断言都按它选）。 -->
    <TodosView v-else-if="curView === 'todos'" :ctl="todoViewCtl" />

    <!-- 转换确认（2026-10-09 用户第 1 条）：把「源怎么办」从隐含约定变成看得见的勾选项。
         默认不勾 = 源原样保留（卡 004 铁律）；勾了才顺手收掉重复源 ——
         日志侧 = 现成「已归档」分区（可找回），待办侧 = 折叠「已转出」（可撤销）。 -->
    <div v-if="convAsk_" class="overlay" @mousedown.self="convAsk_ = null">
      <div id="conv-modal">
        <h3>{{ convAsk_.kind === 'log2todo' ? '日志 → 待办' : '待办 → 日志' }}</h3>
        <div class="conv-src">源：{{ convAsk_.kind === 'log2todo' ? '日志' : '待办' }}「{{ convAsk_.src.title || convAsk_.src.id }}」</div>
        <div class="hint">会新建一条{{ convAsk_.kind === 'log2todo'
          ? '待办（首行取「下一步」首条 —— 是（待填写）这类占位就改用日志标题；日志正文与下一步会一起带过去，项目/优先级跟着走）'
          : '日志（标题/项目/优先级带过去，到期压进正文首行）' }}；同一条只转一次。</div>
        <label class="conv-opt">
          <input type="checkbox" v-model="convAsk_.archive" />
          <span>顺手把源{{ convAsk_.kind === 'log2todo' ? '归档' : '标「已转出」' }}
            <i>{{ convAsk_.kind === 'log2todo'
              ? '源日志移入「已归档」分区（列表不再重复，随时可找回）'
              : '源待办折叠进「已转出」（不是删除，展开可看可撤销）' }}</i></span>
        </label>
        <div class="hint conv-default">不勾 = 源原样保留，两边都看得见。</div>
        <div class="acts">
          <button class="ghost" @click="convAsk_ = null">取消</button>
          <button class="pri" @click="runConvert">转换</button>
        </div>
      </div>
    </div>

    <!-- 待办编辑弹窗（2026-09-25 第 12、14 条）：大框，写长内容不憋屈；已完成也能改 -->
    <div id="todo-edit-overlay" class="overlay" v-if="todoEdit_" @mousedown.self="closeTodoEditor()">
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
          <!-- 到期时间（2026-10-12 暮雨：「待办只有到期日，建议再加一个可选的时间字段。
               如 WorkBuddy 额度 21:33:59 重置，让用户选个 21:39」）。
               ⚠ 是**可选**：留空 = 老行为（只按天）。所以标签写「时间（可选）」，
                 并给一个「清空」小按钮 —— 填错了要能去掉（清空 = 字段整个消失，不是存个空串）。
               ⚠ `type="time"` 在 Electron/Chromium 里是原生时间选择器，比自己搓输入框稳。 -->
          <div>
            <label>时间（可选）</label>
            <span class="te-time-wrap">
              <input type="time" v-model="todoEdit_.dueTime" step="60" />
              <button v-if="todoEdit_.dueTime" type="button" class="te-time-clear"
                title="清空时间（回到只按天判定）" @click="todoEdit_.dueTime = ''">✕</button>
            </span>
          </div>
        </div>
        <div class="hint todo-edit-donehint" v-if="todoEdit_.done">这条已勾选完成 —— 仍然可以修改内容和到期日。</div>
        <div class="acts">
          <button class="ghost" @click="closeTodoEditor()">取消</button>
          <button class="pri" :disabled="todoEditSaving" @click="saveTodoEdit">{{ todoEditSaving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- Logs view
         ⚠ `v-if` 而**不是** `v-else-if` —— 这是硬约束，别改回去。
         下面 convAsk_ / todoEdit_ 两个 `.overlay` 带 v-if，**插在本行之前**：
         写成 v-else-if 时 Vue 会把它们当成链的上一环，于是
         「待办编辑弹窗开着」就等价于「日志页不渲染」—— 用户点页签看到的是**空白**。
         2026-10-14 真点击 e2e 解锁后实测到的（此前这一层恒 SKIP，从没验过）。 -->
    <!-- 执行日志（2026-10-23 拆成组件 · 拆分计划第 1 批第 11 块）。
         模板在 views/LogsView.vue；状态与动作、以及**所有日志弹窗**都还在本文件 ——
         弹窗必须能在任何视图下打开（从日历点一条日志就会调 openLog，那时 curView 不是 logs，
         弹窗若跟着组件走就会被 v-if 挡掉，点了什么也不会发生）。
         `#board.logs-view` 这层壳由组件根元素带着（视图互斥与几何断言都按它选）。 -->
    <LogsView v-if="curView === 'logs'" :ctl="logsViewCtl" />

    <!-- Launchpad view -->
    <main id="board" class="launchpad" v-if="curView === 'launchpad'">
      <div class="lp-header">
        <h3>启动台</h3>
        <div class="lp-ctrls">
          <button @click="openAddApp">+ 添加应用</button>
          <button class="ghost" @click="openConfigPath">打开配置</button>
          <button class="ghost" @click="refreshApps">⟳ 刷新</button>
        </div>
      </div>
      <!-- 2026-10-16 用户第 2 条：这里是**快捷入口**，不是服务管理。
           用户原话给的类比就是「steam 启动非 steam 游戏」——你登记一个你常用的东西，
           点一下就开；方寸不提供它、不监控它、更不关心它内部开了什么端口。
           ⚠ 所以卡片上**没有端口那一行**：那是「服务/端口」页的事，见那边。 -->
      <div class="lp-note">
        这就是快捷入口：登记一个你常用的应用或命令，<b>点一下就开</b>。
        方寸只管把它拉起来，不管它内部怎么跑。
      </div>
      <div class="lp-grid" v-if="launchpadApps.length">
        <!-- 右键菜单（2026-10-17 暮雨：「不能右键卡片进行编辑和删除」）：编辑原先只能从卡片上的
             ✏️ 进、删除更藏在编辑弹窗里，两条路都要先点开一层。右键是直达。
             ⚠ 菜单组件不产生包裹元素（ContextMenuRoot），`.lp-grid` 的网格布局一个像素不动。 -->
        <AppCardMenu
          v-for="app in launchpadApps"
          :key="app.id"
          :app="app"
          @pick="onAppMenuPick"
        >
          <div
            class="lp-card"
            :title="'点卡片启动：' + (app.cmd || app.path)"
            @click="launchAppClick(app)"
          >
            <div class="lp-icon">{{ app.name.charAt(0) }}</div>
            <div class="lp-info">
              <div class="lp-name">{{ app.name }}</div>
              <div class="lp-desc">{{ app.description || app.path }}</div>
            </div>
            <div class="lp-actions">
              <button class="ghost lp-edit" title="编辑这条登记（名称 / 路径 / 参数 / 备注）" @click.stop="openEditApp(app)">✏️ 编辑</button>
              <button class="ghost lp-open" title="在资源管理器里打开它所在的文件夹" @click.stop="openAppFolder(app)">📁</button>
              <button class="ghost lp-del" title="只删掉这条登记，磁盘上的应用文件不受影响" @click.stop="askRemoveApp(app)">🗑</button>
            </div>
          </div>
        </AppCardMenu>
      </div>
      <div class="empty-state" v-else>
        <div class="empty-icon">🚀</div>
        <div class="empty-text">还没有登记任何应用 —— 点右上角「+ 添加应用」，
          填上名字和一个程序/脚本的路径就行（想做启动台里的那个"快捷方式"）。</div>
      </div>
    </main>

    <!-- 任务卡右键菜单（2026-10-14 第 ④ 步第二单）：
         已经变成**每张卡自己带的 reka-ui ContextMenu** —— 见 `components/TaskCardMenu.vue`。
         这里原先那份手搓浮层（`.ctx-backdrop` + `.ctx-menu` + `left: clientX/top: clientY`）整块删掉：
         它不翻转（贴边右键出屏）、没 Esc、并且菜单开着时全屏盖一层透明遮罩挡住 hover 与滚动。
         ⚠ ContextMenuRoot 不产生包裹元素，所以卡片 DOM 与布局一个像素没动。 -->

    <!--
      日志 / 待办右键菜单（2026-09-26 卡 037 第一批 · 用户口径）
      规格铁律（用户原话）：菜单是「出口加速器」，不是「入口加字段」；一层封顶、单项 ≤7；
      破坏性动作（删除）放最末且二次确认；任何「发给 AI / 智能总结」永不进菜单。
    -->
    <div v-if="ctxOther" class="ctx-backdrop" @click="closeOtherMenu" @contextmenu.prevent="closeOtherMenu"></div>
    <div v-if="ctxOther" class="ctx-menu ctx-other" :style="{ left: ctxOther.x + 'px', top: ctxOther.y + 'px' }">
      <template v-if="ctxOther.kind === 'log'">
        <div class="ctx-title">{{ ctxOther.item.title || ctxOther.item.id }}</div>
        <!-- 编辑（2026-10-11 用户：「直接右键日志居然不能编辑」）——
             任务卡菜单与待办菜单都有编辑，**只有日志漏了**，而它恰恰是最高频的动作。
             放最前面（原本第一项是「复制全文」）。 -->
        <button @click="ctxOtherRun(editLogFromMenu)">✏️ 编辑</button>
        <button @click="ctxOtherRun(copyLogFull)">📄 复制全文</button>
        <button @click="ctxOtherRun(copyLogMeta)">🏷 复制带元信息（日期 + 项目）</button>
        <button @click="ctxOtherRun(copyAndDispatchLog)">📤 复制并标记已派</button>
        <div class="ctx-sep"></div>
        <!-- 「进行中」是手动开关（2026-09-28）：右键里也放一份，不进编辑页就能打/撤 -->
        <button @click="ctxOtherRun(toggleLogRunning)">{{ ctxOther.item.running ? '⏸ 撤销「进行中」' : '▶ 标为「进行中」' }}</button>
        <button @click="ctxOtherRun(toggleLogPin)">{{ ctxOther.item.pinned ? '📌 取消置顶' : '📌 置顶' }}</button>
        <button @click="ctxOtherRun(changeLogProject)">🏷 改项目归属…</button>
        <!-- 归档从右键里撤掉（2026-10-11）：加「编辑」后菜单到了 9 项，**超了当初定的「单项 ≤7」**。
             归档只是一个状态变更，日志卡本身就有入口，右键这份是重复的；
             复制类那两项各有各的场景，不该动。 —— 保持 7 项 + 破坏性动作单列。 -->
        <div class="ctx-sep"></div>
        <button class="danger" @click="ctxOtherRun(runDestroyLog)">🗑 彻底删除（二次确认）</button>
      </template>
      <!-- 看板分区空白右键（2026-10-17 暮雨第 3 条）：只有「新建」一项 ——
           列级要不出别的动作（改状态/删除都是卡片级的事），一层的菜单不凑数。 -->
      <template v-else-if="ctxOther.kind === 'column'">
        <div class="ctx-title">{{ ctxOther.item.status }}</div>
        <button @click="ctxOtherRun(newTaskInColumn)">➕ 在此列新建任务</button>
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
    <div v-if="logProjectPicker" class="overlay" @mousedown.self="logProjectPicker = null">
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

    <!-- 按日期清理回收站（2026-10-17 暮雨第 2 条：「我可以选择特定日期，删除此之前的所有内容」）。
         与「清理已归档日志」同一套交互：先预览命中条数，再确认；差别是这里的删除**不可撤销**
         （删的是回收站里的文件本身），所以文案必须把这件事说满，不能含糊。 -->
    <!-- 回收站「按日期清理」弹窗已搬进 views/TrashView.vue -->


    <LogPurgeModal v-if="logPurgeOpen" :ctl="logPurgeCtl" />

    <!-- Review modal（2026-10-25：待审批 / 待验收共用，文案按 kind 切换） -->
    <div id="review-overlay" class="overlay" v-if="reviewModal" @mousedown.self="reviewModal = null">
      <div id="review-modal">
        <h3>{{ reviewModal.kind === 'approval'
          ? '⚖ 审批裁决（批准 → 待办 / 驳回）'
          : reviewModal.kind === 'direct' ? '↩ 驳回任务' : '✅ 验收裁决' }}</h3>
        <div class="review-info">
          <div class="review-task-title">{{ reviewModal.title }}</div>
          <div class="review-task-id">{{ reviewModal.id }}</div>
        </div>
        <!-- 2026-09-25（用户第 7 条）：原来这里只有「驳回理由」一个输入框 ——
             通过按钮虽然在，但通过时**无处写结论**，等于「通过」这件事不留痕。
             改成双用的验收结论：驳回必填、通过选填，两者都写进「结果记录」。
             2026-10-25：审批裁决同样走这里（批准 = 转正待办，理由同样留痕）。 -->
        <label>{{ reviewModal.kind === 'direct'
          ? '驳回理由（可选 —— 写不清就点下面一个常用理由，或直接留空）'
          : '裁决意见（可选；驳回后仍会常驻在卡上，随时能改）' }}</label>
        <!-- 2026-10-30（暮雨第 2 条）：常用理由一键填，不必每次写作文。再点一次取消选择。 -->
        <div class="review-presets">
          <button v-for="p in reviewPresets" :key="p" type="button" class="ghost rp"
            :class="{ on: reviewReason === p }" @click="reviewReason = reviewReason === p ? '' : p">{{ p }}</button>
        </div>
        <textarea v-model="reviewReason" class="review-reason"
          :placeholder="reviewModal.kind === 'approval'
            ? '批准：为什么可以转正；驳回：缺什么、要改成什么样'
            : '驳回：哪里不行、要改什么；通过：验收依据 / 遗留事项'"></textarea>
        <div class="acts">
          <button class="ghost" @click="reviewModal = null">取消</button>
          <button class="danger" @click="rejectTask">↩ 驳回</button>
          <button v-if="reviewModal.kind !== 'direct'" class="ok" @click="acceptTask">{{ reviewModal.kind === 'approval' ? '✅ 批准转正（→待办）' : '✅ 通过' }}</button>
        </div>
      </div>
    </div>

    <!-- 关于（左上角方形 LOGO 入口）2026-09-25 用户第 12 条：绒花墨坊有、方寸没有 -->
    <div v-if="aboutOpen" class="overlay" @mousedown.self="aboutOpen = false">
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
          <div><span class="k">当前视图</span><span class="v">{{ curViewLabel }} · {{ countText }}</span></div>
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

    <!-- 快速记（2026-10-11，E 组死通道接回）：一句话建卡。 -->
    <div v-if="quickAddOpen" class="overlay" @mousedown.self="closeQuickAdd()">
      <div id="quickadd-modal">
        <h3>快速记一条</h3>
        <input v-model="quickAddText" class="quickadd-in" spellcheck="false"
          placeholder="一句话，可带简写：p0 修登录 · #bug @hermes to:待办 due:12-31"
          @keydown.enter="submitQuickAdd()" />
        <div class="quickadd-hint">
          简写：<code>p0/p1/p2</code> 优先级 · <code>#标签</code> · <code>@指派给谁</code> ·
          <code>to:状态</code> · <code>due:MM-DD</code> 截止。其余词就是标题。
        </div>
        <div v-if="quickAddErr" class="quickadd-err">{{ quickAddErr }}</div>
        <div class="acts">
          <button class="ghost" @click="closeQuickAdd()">取消</button>
          <button class="pri" :disabled="quickAddBusy || !quickAddText.trim()" @click="submitQuickAdd()">
            {{ quickAddBusy ? '创建中…' : '创建' }}</button>
        </div>
      </div>
    </div>

    <!-- 绑定附属日志（2026-10-30 暮雨第 4 条；第 2 条二次返工）：
         一篇主日志带若干附属，关系落盘。候选来自**全量日志**，弹窗自己有
         关键词 / 项目 / 状态 / Agent / 优先级 / 日期六个可叠加条件 ——
         不再受主界面筛选影响，也不再是一张没有查询能力的裸名单。 -->
    <div v-if="logAttachTarget" class="overlay" @mousedown.self="logAttachTarget = null">
      <div id="log-attach-modal">
        <h3>🔗 绑定附属日志</h3>
        <div class="la-main">
          <span class="la-lbl">主日志</span>
          <b>{{ logAttachTarget.title || logAttachTarget.id }}</b>
          <span v-if="logAttachLoading" class="la-loading">正在读取全部日志…</span>
        </div>
        <div class="la-hint">
          勾选同一轮一起跑的那几条（进度通知 / 并行通道）。绑定后它们会收进主日志下面的框，
          每条仍可单独打开、单独改、单独完成；绑定关系落盘，下次还在。
          一个附属只能归一个主日志；最多 20 条。勾选顺序 = 开工单里的顺序。
        </div>
        <div class="la-filters">
          <input v-model="logAttachQuery" class="la-search" spellcheck="false"
            placeholder="搜索标题 / 正文 / ID / 任务 / 会话…" />
          <select v-model="logAttachProject" class="la-sel" title="按项目筛选">
            <option value="">全部项目</option>
            <option v-for="p in logAttachProjects" :key="'lap-' + p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <select v-model="logAttachStatus" class="la-sel" title="按状态筛选">
            <option value="">全部状态</option>
            <option value="running">进行中</option>
            <option value="active">待处理</option>
            <option value="completed">已完成</option>
            <option value="archived">已归档</option>
          </select>
          <select v-model="logAttachAgent" class="la-sel" title="按执行 Agent 筛选">
            <option value="">全部 Agent</option>
            <option v-for="a in logAttachAgents" :key="'laa-' + a" :value="a">{{ a }}</option>
          </select>
          <select v-model="logAttachPrio" class="la-sel" title="按优先级筛选">
            <option value="">全部优先级</option>
            <option value="高">高</option>
            <option value="中">中</option>
            <option value="低">低</option>
            <option value="__none__">未标</option>
          </select>
          <input v-model="logAttachDateFrom" type="date" class="la-sel la-date" title="起始日期（含）" />
          <span class="la-sep">→</span>
          <input v-model="logAttachDateTo" type="date" class="la-sel la-date" title="截止日期（含）" />
          <button class="ghost" title="清空全部筛选条件" @click="clearLogAttachFilters">清空筛选</button>
          <label class="la-toggle" title="已被别的组占用的日志不能重复绑定；打开这里可以看清它们为什么不出现">
            <input type="checkbox" v-model="logAttachShowBlocked" /> 显示已占用
          </label>
        </div>
        <div class="la-countline">
          <span>筛出 <b>{{ logAttachRows.length }}</b> 条</span>
          <span v-if="logAttachBlockedCount && !logAttachShowBlocked" class="la-blocked-note">
            · 另有 {{ logAttachBlockedCount }} 条已被别的组占用或自己就是主日志
          </span>
          <span v-else-if="logAttachBlockedCount" class="la-blocked-note">
            · 其中 {{ logAttachBlockedCount }} 条已被占用（灰显，不可选）
          </span>
          <span class="la-grow"></span>
          <button class="ghost" title="把当前筛选出来的可绑定日志全部勾上（最多 20 条）"
            @click="selectAllLogAttachFiltered">全选筛选结果</button>
          <button class="ghost" @click="clearLogAttachPick">清空已选</button>
        </div>
        <div class="la-list">
          <label v-for="row in logAttachRows" :key="'la-' + row.log.id" class="la-row"
            :class="{ picked: row.picked, blocked: row.blocked }">
            <input type="checkbox" :checked="row.picked" :disabled="row.blocked"
              @change="toggleLogAttachPick(row.log.id)" />
            <span class="log-status-badge" :class="logStatusClass(row.log)">{{ logStatusLabel(row.log) }}</span>
            <span v-if="row.log.priority" class="log-prio-badge" :class="'lp-' + logPrioKey(row.log.priority)"
              :title="'优先级：' + localPriority(row.log.priority)">{{ localPriority(row.log.priority) }}</span>
            <span class="la-text">
              <span class="la-title">{{ row.log.title || row.log.id }}</span>
              <span class="la-sub">
                <span>{{ row.log.project || '未归属' }}</span>
                <span v-if="row.log.agentName">🤖 {{ row.log.agentName }}</span>
                <span>{{ formatDate(row.log.created) }}</span>
                <span class="la-id">{{ row.log.id }}</span>
              </span>
            </span>
            <span v-if="row.blocked" class="la-blocked">{{ row.reason }}</span>
            <span v-else-if="row.picked" class="la-picked">已选</span>
          </label>
          <div v-if="!logAttachRows.length" class="la-empty">
            没有符合条件的日志。换个关键词 / 放宽日期，或点「清空筛选」看全部。
            <template v-if="logAttachBlockedCount">（另有 {{ logAttachBlockedCount }} 条被占用，勾「显示已占用」可查看原因）</template>
          </div>
        </div>
        <div class="acts">
          <span class="la-count">
            已选 {{ logAttachPick.length }} / 20 条<template v-if="logAttachPickedOutside">（{{ logAttachPickedOutside }} 条不在当前筛选内）</template>
          </span>
          <button class="ghost" @click="logAttachTarget = null">取消</button>
          <button class="ok" :disabled="logAttachBusy || logAttachPick.length > 20" @click="saveLogAttach">{{ logAttachBusy ? '保存中…' : '保存绑定' }}</button>
        </div>
      </div>
    </div>

    <LogPreviewModal v-if="logPreview" :ctl="logPreviewCtl" />

    <!-- 回收站正文预览（2026-09-26 用户：「每个卡片都是不能点的死卡」）-->
    <!-- 回收站正文预览弹窗已搬进 views/TrashView.vue（与它的视图同一处） -->


    <!-- Task preview modal -->
    <TaskPreview v-if="previewTask" :ctl="taskPreviewCtl" />

    <!-- Roadmap view -->
    <!-- Calendar view -->
    <!-- 日历（2026-10-23 拆成组件 · 拆分计划第 1 批第 4 块）。
         状态与算法在第 3 块已进 composables/useCalendar.ts，组件自己调它 ——
         这里只需给三份数据 + 接五个动作（组件只收集意图，落盘/开弹窗都留在本文件）。 -->
    <CalendarView v-if="curView === 'calendar'"
      :tasks="filteredTasks" :todos="todos" :logs="logs"
      @assign-task="openCalAssignTask"
      @assign-todo="openCalAssignTodo"
      @reschedule="doCalReschedule"
      @open-card="openCard"
      @open-log="openLogById" />

    <!-- 路线图（2026-10-23 拆成组件 · 拆分计划第 1 批第 7 块）。
         它自己 onMounted 拉 roadmap + 里程碑；零交互（唯一按钮是页内「⟳ 刷新」）。 -->
    <RoadmapView v-if="curView === 'roadmap'" />

    <!-- Edit modal -->
    <div id="modal-overlay" class="overlay" v-if="editTask_" @mousedown.self="closeTaskEditor()">
      <div id="modal" class="task-modal">
        <h3>{{ editTask_.id ? '编辑任务' : '新建任务' }}</h3>
        <div class="tf-grid">
          <div
            v-for="spec in visibleFieldSpecs"
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
        <!-- 历史版本（2026-10-18 卡 001；2026-10-31 收口）：把 atomicWrite 本来就在写的
             .backup 接出来 —— 看见列表、逐版预览、恢复任意一版。恢复前会自动备份当前版。 -->
        <div v-if="editTask_.id" class="ver-sect">
          <button class="ghost ver-toggle" @click="toggleTaskHistory">
            🕘 历史版本<span v-if="taskVersions.length"> · {{ taskVersions.length }}</span>
          </button>
          <div v-if="taskHistoryOpen" class="ver-panel">
            <div class="ver-head">
              <b>这张卡的历史版本</b>
              <span class="ver-sub">本机最近 10 版；恢复前会把当前版再备份一次</span>
              <button class="ver-x" title="收起" @click="taskHistoryOpen = false">×</button>
            </div>
            <div v-if="taskVersionBusy" class="ver-empty">读取中…</div>
            <div v-else-if="!taskVersions.length" class="ver-empty">没有历史版本（本机只留最近 10 版，更早的要靠整包备份）</div>
            <div v-else class="ver-list">
              <div v-for="v in taskVersions" :key="v.file" class="ver-row" :class="{ on: taskVersionPreview?.file === v.file }">
                <button class="ver-main" @click="previewTaskVersion(v)">
                  <span class="ver-title">{{ v.title || '(无标题)' }}</span>
                  <span class="ver-meta">{{ v.at ? formatDateTime(v.at) : '时间不详' }} · {{ versionSizeText(v.size) }} · {{ v.status || '状态未知' }}</span>
                </button>
                <button class="ver-restore" @click="restoreTaskVersionItem(v)">恢复</button>
              </div>
            </div>
            <pre v-if="taskVersionPreview" class="ver-preview">{{ taskVersionPreview.content }}</pre>
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
    <div id="policy-overlay" class="overlay" v-if="policyEdit_" @mousedown.self="closePolicyEditor()">
      <div id="policy-modal">
        <h3>项目方针：{{ policyEdit_.name }}</h3>
        <label>使命（一句话：这项目是干嘛的）</label>
        <textarea v-model="policyEdit_.mission" placeholder="例：本地优先的多 agent 任务调度台"></textarea>
        <label>当前目标（本阶段要达成什么 + 怎么算完成）</label>
        <textarea v-model="policyEdit_.goal" placeholder="例：稳定可用、承接真实业务数据"></textarea>
        <label>应用场景（给谁用、在哪用）</label>
        <textarea v-model="policyEdit_.scenario" placeholder="例：个人，桌面日常使用"></textarea>
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
    <!-- 方寸自绘架构图（2026-10-30，卡 task-20261030-002）：只读扫源码出的图。
         与「架构图」按钮（打开 archify 产物）并存：一个是看别人画的，一个是自己扫的。 -->
    <div id="arch-overlay" class="overlay" v-if="archOpen && archGraph" @mousedown.self="archOpen = false">
      <ArchDiagram :graph="archGraph" :review="archReview" :repairs="archRepairs" :rejects="archRejects"
        :busy="archBusy" :version="archVersion" :approved="archApproved"
        :excluded="archExcluded.map(x => x.id)" :excluded-info="archExcluded"
        @close="archOpen = false" @export="exportSelfArch"
        @exclude="excludeArchNode" @restore="restoreArchNode"
        @approve="approveArch" @reject="rejectArch" />
    </div>

    <div id="smap-overlay" class="overlay" v-if="smapOpen" @mousedown.self="smapOpen = false">
      <div id="smap-modal">        <h3>🗺 结构地图 <span class="smap-sub">模块清单 + 每模块一句话职责 + 主数据流</span></h3>
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


    <LogEditModal v-if="logEdit_" :ctl="logEditCtl" />

    <!-- 接力对话框（已搬进 components/RelayModal.vue） -->
    <RelayModal v-if="relay_" :ctl="relayCtl" />

    <!-- 指派时间（2026-09-22，用户第 6 条）：任务可设开始+截止时间段，待办只有到期日 -->
    <div v-if="calAssign_" class="overlay" @mousedown.self="calAssign_ = null">
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
    <div v-if="migrateTarget" class="overlay" @mousedown.self="migrateTarget = null">
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
    <div v-if="projForm" class="overlay" @mousedown.self="closeProjForm()">
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

    <!-- ══ AI 规划弹窗（写回层 UI，2026-10-12）：项目详情「✨ AI 规划」的入口。
         两个动作走 12 条 LLM 通道的后两条（llm:planToDraft / llm:draftProjectBrief）：
         拆目标 →「待审批」任务卡；起草说明 → 四栏草稿卡。转正必须人工，AI 不直接进待办。
         ⚠ 合入时改了一处：遮罩关闭手势原为 `@click.self` → 改 `@mousedown.self`。
           这里有个文本输入框（goal），`@click.self` 会在"拖选文字、光标滑出弹窗"时
           被当成点了遮罩，**把还没提交的草稿一起关掉**（2026-10-11 真机踩过，守卫第 ⑨ 类也拦它）。 -->
    <div v-if="aiPlanForm" class="overlay" @mousedown.self="closeAiPlan()">
      <div id="ai-plan-modal">
        <h3>AI 规划 · {{ aiPlanForm.name }}</h3>
        <label>想干什么（一句话目标，给「拆成任务卡」用）</label>
        <input v-model="aiPlanForm.goal" placeholder="例：把 0.2.8 发版前的阻塞清空"
               @keyup.enter="runPlanToDraft()" :disabled="aiPlanBusy" />
        <!-- 2026-10-16（暮雨第 1 条）：他说「根本找不到入口、也没找到配置模型的地方」——
             入口其实一直在项目详情里，配置在设置页，只是**没有一条线把它们串起来**。
             这里补的就是这条线：没配端点时当场指路，一键送到设置页那一格。 -->
        <div class="hint hint-warn" v-if="!llmCfg.baseUrl">
          ⚠ 还没配模型通道 —— 这个动作要用你自己的一份模型 API（BYOK，方寸不预置任何端点、不代收费用）。
          <button class="ghost llm-goto" :disabled="aiPlanBusy" @click="gotoLlmSettings()">去设置 → Agent → ✨ 模型通道</button>
        </div>
        <div class="hint">
          结果落成<b>「待审批」卡</b>（琥珀色状态）——你过目改卡、点头后才进待办，AI 不能背着你塞东西。
          卡带 <code>ai-planning</code> 来源标记可审计。
        </div>
        <div class="acts">
          <button class="ghost" :disabled="aiPlanBusy" @click="closeAiPlan()">取消</button>
          <button class="ghost" :disabled="aiPlanBusy || !aiPlanForm.goal.trim()" @click="runPlanToDraft()">
            {{ aiPlanBusy ? 'AI 拆解中…' : '✨ 拆成任务卡草稿' }}</button>
          <button class="pri" :disabled="aiPlanBusy" @click="runDraftBrief()">
            {{ aiPlanBusy ? 'AI 起草中…' : '📄 起草项目说明' }}</button>
        </div>
      </div>
    </div>

    <!-- ══ 文档拆卡弹窗（2026-10-17 四件补立项之二）：粘贴文档全文 → AI 拆成待审批卡。
         同 mousedown.self 守卫（textarea 拖选滑出遮罩不误关）；同「待审批+ai-doc 审计」红线。 -->
    <div v-if="aiDocForm" class="overlay" @mousedown.self="closeAiDoc()">
      <div id="ai-doc-modal">
        <h3>文档拆卡 · {{ aiDocForm.name }}</h3>
        <label>粘贴文档全文（需求说明/会议记录/笔记，最长 6 万字）</label>
        <textarea v-model="aiDocForm.doc" rows="9"
                  placeholder="把文档内容整段粘进来，AI 从里头提取可执行的任务（背景/感想/已完成事项会自动跳过）"
                  :disabled="aiDocBusy"></textarea>
        <div class="hint hint-warn" v-if="!llmCfg.baseUrl">
          ⚠ 还没配模型通道 —— 这个动作要用你自己的一份模型 API（BYOK，方寸不预置任何端点、不代收费用）。
          <button class="ghost llm-goto" :disabled="aiDocBusy" @click="gotoLlmSettings()">去设置 → Agent → ✨ 模型通道</button>
        </div>
        <div class="hint">
          每篇最多拆 <b>20 张</b>「待审批」卡（琥珀色状态）——你过目改卡、点头后才进待办；
          卡带 <code>ai-doc</code> 来源标记，和目标拆解的卡分开可查。拆完原文不留存。
        </div>
        <div class="acts">
          <button class="ghost" :disabled="aiDocBusy" @click="closeAiDoc()">取消</button>
          <button class="pri" :disabled="aiDocBusy || !aiDocForm.doc.trim()" @click="runDocToDrafts()">
            {{ aiDocBusy ? 'AI 拆卡中…' : '📄 拆成任务卡' }}</button>
        </div>
      </div>
    </div>

    <!-- ══ 规划管理弹窗（2026-10-16 第 1 项）：项目详情「🗂 规划」的入口。
         接 createPlan/listPlans/getPlan/decidePlanPoint 四条通道。
         决策点选定即留痕（选项+时间落任务文件）；再点其他选项=改选，留痕覆盖（decidedAt 刷新）。 -->
    <div v-if="plansModal" class="overlay" @mousedown.self="closePlans()">
      <div id="plans-modal">
        <h3>规划 · {{ plansModal.name }}</h3>

        <!-- 列表态 -->
        <div v-if="!planDetail && !planCreating">
          <div class="hint" v-if="planListBusy">读取中…</div>
          <div class="hint" v-else-if="!planList.length">
            这个项目还没有规划——点下面「＋ 新建规划」：目标、里程碑、要决定的决策点一次写清，
            决策点逐个选定后规划自动转「进行中」。
          </div>
          <div class="plan-row" v-for="t in planList" :key="t.fm.id" :data-plan-id="t.fm.id">
            <div class="plan-row-main">
              <b>{{ t.fm.title }}</b>
              <span class="plan-badge" :data-plan-status="t.fm.plan_status || 'draft'">{{ planStatusLabel(t.fm.plan_status) }}</span>
            </div>
            <button class="ghost" @click="openPlanDetail(t.fm.id)">看决策点 →</button>
          </div>
        </div>

        <!-- 详情态：决策点选择+留痕+回看 -->
        <div v-else-if="planDetail">
          <div class="hint" v-if="planDetail.plan.objective">目标：{{ planDetail.plan.objective }}</div>
          <div v-if="planDetail.plan.milestones.length">
            <div class="ms-suggest-h">里程碑</div>
            <div v-for="(m, i) in planDetail.plan.milestones" :key="'pm' + i">· {{ m.name }}<template v-if="m.deadline">（{{ m.deadline }}）</template></div>
          </div>
          <div class="plan-dp" v-for="dp in planDetail.plan.decisions" :key="dp.id" :data-dp-id="dp.id">
            <div class="plan-dp-q">{{ dp.question }}</div>
            <div class="hint" v-if="dp.status !== 'pending'">
              ✓ 已选：<b>{{ dp.chosen }}</b>（{{ planWhen(dp.decidedAt) }}）——再点其他选项=改选，留痕覆盖
            </div>
            <div class="plan-dp-opts">
              <button v-for="op in dp.options" :key="op" class="ghost"
                      :class="{ pri: dp.chosen === op }" @click="decideDp(dp, op)">{{ op }}</button>
            </div>
          </div>
          <div class="hint hint-warn" v-if="!planDetail.plan.decisions.length">这条规划没有决策点。</div>
          <div class="hint" v-else-if="planDetail.plan.decisions.every(d => d.status !== 'pending')">
            决策点全定完——规划已自动转「进行中」，选择留痕都记在任务卡里。
          </div>
        </div>

        <!-- 表单态：新建规划 -->
        <div v-else>
          <label>规划标题 *</label>
          <input v-model="planForm.title" placeholder="例：0.3.7 发版计划" />
          <label>目标（可空）</label>
          <input v-model="planForm.objective" placeholder="例：把启动台三件事收口并发 0.3.7" />
          <label>里程碑（每行一条，可空；格式 名称|截止，截止可省）</label>
          <textarea v-model="planForm.milestones" rows="2" placeholder="设计稿定稿|2026-10-20&#10;发版"></textarea>
          <template v-for="(dp, i) in planForm.dps" :key="'dpf' + i">
            <label>决策点 {{ i + 1 }} · 要决定的问题 *</label>
            <input v-model="dp.question" placeholder="例：端口模型走哪版？" />
            <label>选项（每行一个）*</label>
            <textarea v-model="dp.options" rows="2" placeholder="端口=配置项&#10;端口=观测结果"></textarea>
            <button class="ghost" v-if="planForm.dps.length > 1" @click="planForm.dps.splice(i, 1)">删这条决策点</button>
          </template>
          <button class="ghost" @click="planForm.dps.push({ question: '', options: '' })">＋ 加决策点</button>
        </div>

        <div class="acts">
          <button class="ghost" @click="closePlans()">关闭</button>
          <button class="ghost" v-if="planDetail" @click="backPlanList()">← 回列表</button>
          <button class="pri" v-if="!planDetail && !planCreating" @click="startPlanCreate()">＋ 新建规划</button>
          <button class="pri" v-else-if="planCreating" :disabled="!planForm.title.trim()" @click="submitPlan()">建规划</button>
        </div>
      </div>
    </div>

    <div id="app-edit-overlay" class="overlay" v-if="editApp_" @mousedown.self="closeAppEditor()">
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

    <!-- 免责与知情声明（2026-10-16 暮雨第 1 条）。
         ⚠ 放在视图 `v-if/v-else-if` 链**之外**（链中间插一个带 v-if 的弹窗，会让它后面的
           视图整页不渲染 —— 这条踩过）。强制模式由组件自己锁死：不给遮罩关闭、拦 ESC、
           focus trap；这里只负责 open / mode / ack 三件事。 -->
    <DisclaimerDialog :open="disclaimerOpen" :mode="disclaimerMode" :acked-at="disclaimerAckedAt"
                      @close="disclaimerOpen = false" @ack="onDisclaimerAck" />

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
    <div id="soverlay" class="overlay" v-if="showSettings_" @mousedown.self="showSettings_ = false">
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
        <GeneralSettings :active="settingsTab === 'general'" />
        <div class="sect" v-show="settingsTab === 'data'">
          <h4>数据目录</h4>
          <div class="hint">{{ dataDir }}</div>
          <div class="sect-btns">
            <button class="ghost" @click="changeDataDir">修改目录…</button>
            <button class="ghost" @click="openDataDir">打开目录</button>
          </div>
        </div>
        <!-- 整理体检 + 大附件：已切到 components/DataHygienePanel.vue
             （App.vue 拆分第一刀，2026-10-30）。两块都是只读通道 + 两个跳转事件，
             边界干净；破坏性动作（删附件）仍只在主进程一条通道里，组件只负责确认与刷新。 -->
        <DataHygienePanel v-show="settingsTab === 'data'" :toast="showToast"
          @goto-never-read="gotoNeverRead" @goto-rework="gotoRework" />
        <DiagSettings :active="settingsTab === 'diag'" />
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
          <div class="hint">「已完成」且超过这么多天没更新过的任务，会被移进归档区（「归档」标签里能看到、可随时还原，文件不会被删）。0 = 关闭。</div>
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
        <!-- 模型通道（AI 规划用，2026-10-12）：BYOK——端点/密钥/模型全在用户手里。
             后端 12 条 LLM 通道 10-06 起就绪，这是配置界面第一次装。
             密钥只存本机（llm-config.json，0600），回显永远只有掩码；不预填任何默认端点（含国外）。 -->
        <AgentSettings :active="settingsTab === 'agent'" />
        <ProjectSettings :active="settingsTab === 'projects'" />
        <!-- 备份与恢复：已切到 components/settings/BackupSettings.vue（拆分第六刀）
             状态在 useBackup 单例里，App 与这里共用同一份。 -->
        <BackupSettings v-show="settingsTab === 'backup'" />

        <!-- 底部动作条：与"当前在哪个分类"无关（导出/导入/关闭随时可用），所以挂在 body 末尾 -->
        <div class="settings-foot">
          <button class="ghost" @click="exportTasksToFile">导出任务 JSON</button>
          <button class="ghost" @click="importTasksFromFile">导入任务 JSON</button>
          <button class="pri" @click="showSettings_ = false">关闭</button>
        </div>
        </div>
      </div>
    </div>



    <!-- ⚠ `has-undo`：撤销条与 toast 都在顶部居中，同时出现时 toast 下移一格（2026-10-21） -->
    <div id="toast" :class="[toast.type, { show: toast.show, 'has-undo': !!undoBar }]">{{ toast.msg }}</div>

    <!-- 撤销条（2026-10-21 暮雨报障：「点错了日志，把另一个日志点了完成，虽然撤销按钮在，
         但快捷键无用。左上角只有返回，没有撤销按钮」）。
         根因不是"没有撤销能力"，而是**撤销入口跟着卡片走**：一旦状态改成完成/归档，
         那条日志就滑到别的分区、甚至不在当前屏，人只能回头翻。误操作的回路必须
         **留在原地、留在眼前** —— 所以状态类动作成功后在这里挂一条，点一下就回去；
         Ctrl+Z 等价于点它（只在焦点不在输入框里时接管，见 onShortcutKeydown）。
         ⚠ 不做全站撤销栈：这里只记「上一笔状态动作」，而且只认能真撤回的那几种。 -->
    <div id="undo-bar" v-if="undoBar" role="status" aria-live="polite">
      <span class="ub-text">{{ undoBar.label }}</span>
      <button v-if="undoCount > 1" class="ub-count" title="查看全部可撤动作（可以一次退回好几步）"
        @click="undoHistOpen = !undoHistOpen">共 {{ undoCount }} 步</button>
      <span class="ub-key" title="键盘快捷键：Ctrl+Z（焦点在输入框里也照样撤这一步数据动作）">Ctrl+Z</span>
      <button class="ub-btn" title="撤回上一步（同 Ctrl+Z）" @click="runUndo">↩ 撤销</button>
      <button class="ub-x" title="不再提示这些可撤动作（不会替你撤回）" @click="dismissUndo">✕</button>
    </div>
    <!-- 撤销历史（2026-10-30 暮雨第 5 条）：不只是"上一笔" —— 点哪一条就退到那一步之前。 -->
    <div id="undo-hist" v-if="undoHistOpen && undoCount" role="dialog" aria-label="可撤动作">
      <div class="uh-head">可撤动作（{{ undoCount }}）<span>点一条 = 把它及之后一起撤掉</span></div>
      <button v-for="h in undoHistory" :key="'uh-' + h.index" class="uh-row" @click="undoTo(h.index)">
        <span class="uh-i">{{ h.index + 1 }}</span>
        <span class="uh-l">{{ h.label }}</span>
        <span class="uh-t">{{ h.at ? new Date(h.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '' }}</span>
      </button>
      <div class="uh-foot">
        <button class="ghost" @click="undoHistOpen = false">收起</button>
        <button class="danger" @click="dismissUndo(); undoHistOpen = false">全部忘掉（不撤回）</button>
      </div>
    </div>

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
import { ref, computed, onMounted, onUnmounted, reactive, watch, nextTick, provide } from 'vue'
// parseCalDate 必须留着：openCalAssignTodo（在 App.vue，它开的是本文件的弹窗）用它把待办 due 转成日期。
// ⚠ 2026-10-23 抽 composable 时把它一起删了 → 只在「点待办上的 📅」这条路径炸 ReferenceError，
//   无头断言（当时没点过那个按钮）全绿、真 Electron 真点击当场红 2 条。两层都要跑的原因就是这个。
// ⚠ import 必须是**单行**：模板绑定守卫的正则是 /import[ \t]+([^'"]+?)[ \t]+from/
//   （`[ \t]` 不跨行），多行花括号写法它抓不到名字 → 把 parseCalDate 判成「调用了但未定义」。
import { parseCalDate, calISO, dayStart, addDays, rangeLabel, shiftRange } from './calendar'
import {
  classifyLogImport, classifySummary,
  type ImportItem,
} from './logdedupe'
import { toPlain } from '../shared/plain'
// 撤销条中枢（全站一个）：日志/待办/决策都在改数据，谁改谁 offer，条子只此一条
import { undoBar, undoCount, undoHistory, offerUndo, dismissUndo, runUndo as runUndoCore, runUndoTo as runUndoToCore } from './undo'
// 「整段被一对括号包住 = 模板占位」的单一来源（与契约读取、Python 侧同一规则）
import { isPlaceholderText, firstBulletLine } from '../shared/placeholder'
import { statusClass } from '../shared/status'
import { renderBody } from './markdown'
import { readUiPref, saveUiPref } from './prefs'
import { makeDirtyGuard, snapOf } from './dirtyGuard'
import { useTodos } from './composables/useTodos'
import { useNotifications } from './composables/useNotifications'
import { useBoardColumns } from './composables/useBoardColumns'
import { useLogsView } from './composables/useLogsView'
import { useLogAttachments } from './composables/useLogAttachments'
import { useLogMaintenance } from './composables/useLogMaintenance'
import { useLogEditGuard } from './composables/useLogEditGuard'
import { useLogEditorSave } from './composables/useLogEditorSave'
import { useLogStatusActions } from './composables/useLogStatusActions'
import BackupSettings from './components/settings/BackupSettings.vue'
import GeneralSettings from './components/settings/GeneralSettings.vue'
import DiagSettings from './components/settings/DiagSettings.vue'
import AgentSettings from './components/settings/AgentSettings.vue'
import ProjectSettings from './components/settings/ProjectSettings.vue'
import { useBackup } from './composables/useBackup'
import ArchDiagram from './components/ArchDiagram.vue'
import DataHygienePanel from './components/DataHygienePanel.vue'
import BoardBanners from './components/BoardBanners.vue'
import TaskPreview from './components/TaskPreview.vue'
import LogEditModal from './components/LogEditModal.vue'
import RelayModal from './components/RelayModal.vue'
import LogPurgeModal from './components/LogPurgeModal.vue'
import LogPreviewModal from './components/LogPreviewModal.vue'
import type { ArchGraph } from '../shared/archGraph'
import { filterArchGraph } from '../shared/archGraph'
import { evaluateArchGraph, type ArchReview } from '../shared/archValidate'
import TodosView from './views/TodosView.vue'
import LogsView from './views/LogsView.vue'
import CalendarView from './views/CalendarView.vue'
import BoardView from './views/BoardView.vue'
import ServicesView from './views/ServicesView.vue'
import SkillsView from './views/SkillsView.vue'
import RoadmapView from './views/RoadmapView.vue'
import TrashView from './views/TrashView.vue'
import ProjectTierBoard from './views/ProjectTierBoard.vue'
import MismatchView from './views/MismatchView.vue'
import RiceMatrixView from './views/RiceMatrixView.vue'
import { localPriority, priorityLabel } from '../shared/priority'
import { buildBlockerIndex, boardCardMeta, openOnly } from '../shared/boardCards'
import type { BoardCardMeta } from '../shared/boardCards'
import { copyText } from '../shared/clipboard'
import { toggleCollapsed, isCollapsed } from '../shared/grouping'
// 同步按钮的阶段/秒数文案是纯函数（shared/syncPhase.ts）—— 放在 shared 里才能喂假秒数断言，
// 不用在测试里真等 15 秒去验"网络慢"那一档。
import { syncCapsuleText, syncDoneText, syncPhaseLabel, isSyncPhase } from '../shared/syncPhase'
import { buildDispatchText, arsenalStatus } from '../shared/arsenal'
// 分层架构图纯函数（2026-10-13 方案 A）：值来自任务 frontmatter 的 `架构`（JSON 字符串）。
// 与 blockers/boardCards 同款 —— 算法在 shared/，组件只接线。
import { buildLayerDiagram } from '../shared/layerDiagram'
// ⚠ 2026-10-16：`describeLaunchCommand` / `explainStartObserved` 的导入已随
//   「服务页应用分区 + 启动台端口行」一起删掉（那两处是唯一调用方）。
//   纯函数本体仍在 `shared/launchpadDiag.ts`（`e2e-launchpad-diag` 仍在测）。
import { formatDate, formatDateTime, relativeTime, relTimeShort, parseTime, daysSince, parseDueAt, formatDueTime, daysSinceDue, isOverdue } from '../shared/time'
// 读卡口径的文案与结构（卡 20261025-006 第三件）—— 文案跟判定同源，避免界面自己写一套口径。
import { neverReadSummary } from '../shared/neverRead'
import type { NeverReadResult } from '../shared/neverRead'
import { pickRework, lastRejectReason } from '../shared/rework'
// 成熟原语（2026-10-11 用户第 2 条：「市面上一堆现成UI…不要每次都从头造轮子」）：
// 筛选浮层改用 reka-ui（Radix Vue 的继任者）的 Popover —— 它自带 **floating-ui 定位**
// （flip/shift 防越界）、**点外面关闭**、**Esc 关闭**、**焦点归还**、aria 关联。
// 我上一版手搓的 backdrop + getBoundingClientRect 定位全部删掉。
// ⚠ Popover 这里**只借行为**，样式仍走本仓既有的 class。
//
// ⚠ 当初这里写着「不引 Tailwind —— 那是一次全仓 CSS 重构，另立卡」。现在那张卡来了：
//   UI 基座（卡 task-20261011-004，shadcn-vue + Tailwind，第 ② 步的 `--ui-*` 映射已落地）。
//   口径没变的是**做法**：App.vue 自己**仍然一行 utilities 都不用**（`.fixed`/`.hidden` 这类
//   同名老类名会让 Tailwind 凭空生成规则），新界面一律切到 `components/` 下的组件里去用。
import { PopoverRoot, PopoverTrigger, PopoverPortal, PopoverContent } from 'reka-ui'
import DecisionBoard from './components/DecisionBoard.vue'
import HelpView from './views/HelpView.vue'
import BlockersView from './views/BlockersView.vue'
// 任务卡右键菜单（2026-10-14 第 ④ 步第二单）：换掉手搓的 `.ctx-backdrop` + `.ctx-menu` + 指针坐标定位，
// 改用 reka-ui 的 ContextMenu 原语（自带 flip/shift 防越界、Esc、方向键、role=menu、焦点归还）。
import TaskCardMenu from './components/TaskCardMenu.vue'
// 启动台卡片右键菜单（2026-10-17 暮雨：「不能右键卡片进行编辑和删除」）
import AppCardMenu from './components/AppCardMenu.vue'
// 免责与知情声明（2026-10-16 暮雨第 1 条：「希望你还记得要学绒花墨坊写那些需要用户
// 首次强制同意确认的免责声明，主要是涉及到钱是非多」）—— 文案在 ./disclaimer.ts（单一事实源），
// 弹窗本体在 components/ 下（那儿才准用 utilities）。
import DisclaimerDialog from './components/DisclaimerDialog.vue'
import { hasAckedDisclaimer, ackedDisclaimerAt } from './disclaimer'

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
  /** 返工归因（2026-10-06 卡 003）：三档 + 空，见主进程 TASK_FIELD_SPECS */
  attribution?: string
  /** 架构图（2026-10-13 方案 A）：LayerDiagramSpec 的 JSON 字符串，见 shared/layerDiagram.ts */
  architecture?: string
  _archived?: boolean
}

interface Project {
  id: string
  name?: string
  repo?: string
  ['状态']?: string
  ['路线图']?: string
  /** 13 份项目说明转正（2026-10-16 批次第 2 项）：registry 透传，详情页一句话定位 */
  ['说明']?: string
}

// ── State ───────────────────────────────────────────────────────────────

const tasks = ref<Task[]>([])
const projects = ref<Project[]>([])
const blockers = ref<any[]>([])
const curView = ref('active')
const curProj = ref('__all__')
/** 状态筛选（2026-10-10 用户要求）。与 curProj **正交叠加**、可同时生效；
 *  与 curProj / dueFilter 一致**不持久化** —— 筛选是临时的。 */
const curStatus = ref('')
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
const countTitle = computed(() => {
  const label = views.find(v => v.id === curView.value)?.label || curView.value
  return countView.value === curView.value
    ? `${label}页签内 ${tasks.value.length} 条任务。归档任务不计入，除非勾选顶栏「含归档」。`
    : '这个页签不加载任务列表，所以不显示条数（此前会残留上一个页签的旧数字）'
})

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

// ── 驳回返工台（2026-10-30 暮雨第 3 条：「驳回的东西好像也永远不看，是方寸的缺陷吗？」）──
// 是缺陷，而且有两层：
//   ① **结构性**：看板把「完成 / 驳回」两列默认折叠（DEFAULT_COLLAPSED_GROUPS），
//      驳回卡在现实中等于「这活没通过，还欠返工或一个"算了"的决定」，却和做完的一样被收起来；
//   ② **口径性**：`never_read` / 体检都把「驳回」当终态排除，于是连"没人管"都统计不到。
// 这条提示条只解决最要紧的一半：**让它重新出现在眼前**，并给两个出口（退回返工 / 归档）。
// ⚠ 不做成自动动作：驳回卡的下一站是用户决定，方寸只负责不让它沉底。
const reworkOpen = ref(false)
const reworkHidden = ref(false)
const reworkNow = ref(Date.now())
const rework = computed(() => pickRework(tasks.value as any[], reworkNow.value))

/** 从 id 找回任务对象；找不到（刚被别处改了）就静默不给按钮乱动 */
function reworkTask(id: string): Task | null {
  return tasks.value.find(t => t.id === id) || null
}
function reworkRestore(id: string): void {
  const t = reworkTask(id)
  if (t) void restoreTask(t)
}
function reworkArchive(id: string): void {
  const t = reworkTask(id)
  if (t) void archiveTask(t)
}

// ── 整理体检的跳转（2026-10-30）：面板本身已切到 components/DataHygienePanel.vue，
// 这里只留"回到看板"的两个动作 —— 打开哪个视图、筛选谁，是 App 的状态。
/** 体检 → 回看板把「没人碰过」筛出来（筛完的板子本身就是清单，不另开只读页） */
async function gotoNeverRead(): Promise<void> {
  showSettings_.value = false
  readFilter.value = 'never'
  switchView('active')
  await loadNeverRead()
}

/** 体检 → 回看板展开返工台，逐张处置 */
function gotoRework(): void {
  showSettings_.value = false
  switchView('active')
  reworkOpen.value = true
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

// ── 全局外观：扁平 / 阴影（2026-10-30，卡 task-20261030-004）────────────
// 与主题正交：主题换色，外观换"有没有影子"。默认 flat（用户：「我更喜欢扁平化圆角」）。
// 落 prefs.json（fc_appearance），换 origin 也不会丢 —— 与主题同一套真身。
const APPEARANCE_LIST = [
  { id: 'flat', name: '扁平', hint: '零阴影 · 默认，也是用户明确喜欢的那套' },
  { id: 'shadow', name: '阴影', hint: '三档高度（贴地 / 浮起 / 弹层），卡片和弹层浮起来' },
]
const appearance = ref(readUiPref<string>('fc_appearance', 'flat'))
function applyAppearance(id: string): void {
  appearance.value = APPEARANCE_LIST.some(a => a.id === id) ? id : 'flat'
  document.documentElement.dataset.appearance = appearance.value
}
function setAppearance(id: string): void {
  applyAppearance(id)
  saveUiPref('fc_appearance', appearance.value)
  const name = APPEARANCE_LIST.find(a => a.id === appearance.value)?.name || '扁平'
  showToast(`已切换外观：${name}`, 'success')
}
applyAppearance(appearance.value)

// ── 板面偏好：分组方式 + 分组折叠状态 ────────────────────────────────────
// 2026-09-25 用户反馈「像没有尽头的单子」→ 分组要有**人名**（不是 fangcun-base 这种 id）+ 可折叠。
// 真身存主进程 prefs.json（与 014 同一套），localStorage 只当读缓存。
// readUiPref / saveUiPref 已抽到 renderer/prefs.ts（2026-10-23）—— 组合式函数也要用。
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
  // 诊断页里的三块（自检 / 技能副本 / 活动日志）进门就拉 —— 同「凡界面要显示的派生状态，
  // 进门就得加载」那条纪律（否则用户不点按钮就是一片空白，看着像坏了）。
  if (id === 'diag') void loadDiag()
}

// ── 念头长度上限（2026-10-25 暮雨）─────────────────────────────────────
// ⚠ 三个常量与主进程 `services/ideas.ts` 的 IDEA_TEXT_MIN / DEFAULT / HARD_MAX
//   **必须逐字一致**（`e2e-ideas-flow` 有一条源码守卫专门比对两边，改一边忘了另一边会红）。
//   主进程才是真守门人：prefs.json 可以手改，它会再夹一次，这里只是给人看的量程。
const IDEA_TEXT_MIN = 1000
const IDEA_TEXT_DEFAULT = 10000
const IDEA_TEXT_HARD_MAX = 20000
const ideaMaxChars = ref<number>(readUiPref<number>('fc_idea_max_chars', IDEA_TEXT_DEFAULT))
function onIdeaMaxChange(): void {
  // 滑块本身量程已经在 min~max 内，但手改的 localStorage / prefs 可能越界 → 存之前夹一次
  const n = Number(ideaMaxChars.value)
  const fixed = Number.isFinite(n)
    ? Math.min(IDEA_TEXT_HARD_MAX, Math.max(IDEA_TEXT_MIN, Math.floor(n)))
    : IDEA_TEXT_DEFAULT
  ideaMaxChars.value = fixed
  saveUiPref('fc_idea_max_chars', fixed)
}

// ── 诊断页三块（2026-10-11，卡 20261006-002 E 组死通道接回）────────────────
// `selfCheck` / `skillsCheck` / `loadActivity` 三条通道一直躺在主进程里，界面从来没有入口。
const diagSelf = ref<any>(null)
const diagSkills = ref<any>(null)
const diagActivity = ref<any[]>([])
const diagBusy = ref(false)

async function runSelfCheck(): Promise<void> {
  diagBusy.value = true
  try {
    diagSelf.value = await (window as any).tegula.selfCheck()
  } catch (e: any) {
    diagSelf.value = { ok: false, message: '自检调用失败：' + (e?.message || e) }
  } finally { diagBusy.value = false }
}

async function checkSkillsCopies(): Promise<void> {
  diagBusy.value = true
  try {
    diagSkills.value = await (window as any).tegula.skillsCheck()
  } catch (e: any) {
    diagSkills.value = { targetId: '', targetName: '', needsInstall: false, skills: [] }
    showToast('技能检查失败：' + (e?.message || e), 'error')
  } finally { diagBusy.value = false }
}

async function loadDiagActivity(): Promise<void> {
  try {
    const r: any = await (window as any).tegula.loadActivity(50)
    diagActivity.value = (Array.isArray(r) ? r : []).slice().reverse()   // 最新在上
  } catch { diagActivity.value = [] }
}

/** 诊断页整体进门加载：自检 + 技能副本 + 活动日志 */
async function loadDiag(): Promise<void> {
  await Promise.all([runSelfCheck(), checkSkillsCopies(), loadDiagActivity()])
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
    if (p?.fc_board_view === 'cols' || p?.fc_board_view === 'list' || p?.fc_board_view === 'cards') {
      boardView.value = p.fc_board_view
    } else {
      saveUiPref(BOARD_VIEW_KEY, boardView.value)
    }
    if (p?.fc_todo_view === 'list' || p?.fc_todo_view === 'grid') {
      todoView.value = p.fc_todo_view
    } else {
      saveUiPref(TODO_VIEW_KEY, todoView.value)
    }
    // 卡片墙「只看未完成」（2026-10-10）：同上面几条，只认布尔真身，坏值回落并补写。
    // ⚠ 位置**刻意放在 fc_todo_view 之后** —— e2e-prefs 的 E5 用「`'cols'` 到 `'list'` 之间
    //   不超过 400 字」这条宽松距离检查，来确认这两个键确实都在 syncBoardPrefs 里被读；
    //   把新键插在它们中间会把那个窗口撑爆（本轮实测就红过一次，不是测试太严，是它挡对了）。
    if (typeof p?.fc_card_wall_open_only === 'boolean') {
      cardWallOpenOnly.value = p.fc_card_wall_open_only
    } else {
      saveUiPref(CARD_WALL_OPEN_ONLY_KEY, cardWallOpenOnly.value)
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
    // 全局外观（2026-10-30 卡 004）：只认两档；坏值回落 flat 并补写
    if (typeof p?.fc_appearance === 'string' && APPEARANCE_LIST.some(a => a.id === p.fc_appearance)) {
      if (p.fc_appearance !== appearance.value) applyAppearance(p.fc_appearance)
    } else {
      saveUiPref('fc_appearance', appearance.value)
    }
    // 顶栏折叠的页签（2026-10-25）：只认真实存在的页签 id；真身里若写成"几乎全收起来"，
    // 同样撞「至少留 7 个」这道护栏 → 回落默认（不然一次手改就能把工具全藏了）。
    if (Array.isArray(p?.fc_views_collapsed)) {
      const known = new Set(views.map(v => v.id))
      const clean = Array.from(new Set(p.fc_views_collapsed.map((x: unknown) => String(x)).filter((id: string) => known.has(id))))
      collapsedViews.value = (views.length - clean.length) >= VIEWS_MIN_VISIBLE ? clean : [...DEFAULT_COLLAPSED_VIEWS]
    } else {
      saveUiPref(VIEWS_COLLAPSED_KEY, collapsedViews.value)
    }
    // 念头长度上限（2026-10-25）：真身优先；手改出来的越界值当场夹回量程，再补写回去
    // —— 不夹的话设置页滑块会显示一个拉不到的数，用户以为坏了。
    if (typeof p?.fc_idea_max_chars === 'number' && Number.isFinite(p.fc_idea_max_chars)) {
      ideaMaxChars.value = Math.min(IDEA_TEXT_HARD_MAX,
        Math.max(IDEA_TEXT_MIN, Math.floor(p.fc_idea_max_chars)))
    } else {
      saveUiPref('fc_idea_max_chars', ideaMaxChars.value)
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
    // 在途一屏设置（2026-10-05 Q2）：模式 / 判据 / 手动清单 / 列 / 健康度覆盖。
    // ⚠ 与既有多视图同一纪律：**白名单字面量校验**——prefs.json 可手改，写进一个不认识的值
    //   会让界面进入"按钮都不高亮、内容却是默认那个"的诡异状态。
    if (p?.fc_trip_mode === 'auto' || p?.fc_trip_mode === 'manual') {
      tripMode.value = p.fc_trip_mode
    } else {
      saveUiPref('fc_trip_mode', tripMode.value)
    }
    if ((TRIP_CRITERIA_OPTIONS as readonly { v: string }[]).some(o => o.v === p?.fc_trip_criteria)) {
      tripCriteria.value = p.fc_trip_criteria
    } else {
      saveUiPref('fc_trip_criteria', tripCriteria.value)
    }
    if (Array.isArray(p?.fc_trip_projects) && p.fc_trip_projects.every((x: unknown) => typeof x === 'string')) {
      tripManualIds.value = p.fc_trip_projects
    } else {
      saveUiPref('fc_trip_projects', tripManualIds.value)
    }
    if (Array.isArray(p?.fc_trip_cols) && p.fc_trip_cols.length > 0
        && p.fc_trip_cols.every((x: unknown) => (TRIP_COL_OPTIONS as readonly { v: string }[]).some(o => o.v === x))) {
      tripCols.value = p.fc_trip_cols
      // 2026-10-22 · 03 任务三：新增「欠着什么」列（四栏台账的第四栏）。
      // 老 prefs 里当然没有它 —— 那是"用户从没见过这一列"，不是"用户关掉了它"。
      // 所以补一次，并打版本标记：之后用户再关掉，就不会被重新打开（不覆盖用户的选择）。
      const COLS_MIGRATION = 'owe-v1'
      if (p?.fc_trip_cols_migrated !== COLS_MIGRATION) {
        if (!tripCols.value.includes('owe')) tripCols.value = [...tripCols.value, 'owe']
        saveUiPref('fc_trip_cols', tripCols.value)
        saveUiPref('fc_trip_cols_migrated', COLS_MIGRATION)
      }
    } else {
      saveUiPref('fc_trip_cols', tripCols.value)
    }
    if (p?.fc_health_overrides && typeof p.fc_health_overrides === 'object' && !Array.isArray(p.fc_health_overrides)) {
      tripHealthOverrides.value = p.fc_health_overrides
    }
    // 项目页签摆法（2026-09-29 用户：「两种视图都要，做成用户可自选切换选项」）
    // ⚠ 白名单是**持久化的闸门**：新增摆法忘了加进来，重启后会静默退回项目墙
    //   （trip 之外，tier / mismatch / rice 都曾踩在这种"加了视图没加白名单"的坑上）。
    if (p?.fc_pv_view === 'tiles' || p?.fc_pv_view === 'overview' || p?.fc_pv_view === 'master' || p?.fc_pv_view === 'trip'
      || p?.fc_pv_view === 'tier' || p?.fc_pv_view === 'mismatch' || p?.fc_pv_view === 'rice') {
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
// 2026-10-10 加第三摆法「信息卡墙」（cards，卡 20261010-003）：
// 用户原话「现有两个视图都走了窄化横条路线，少了点掌控感」+「需要能显示看板任务ID」。
// 形态是用户从小样里点的候选 A（信息卡墙），不是我们替他定的。
type BoardView = 'cols' | 'list' | 'cards'
const boardView = ref<BoardView>(readUiPref<BoardView>(BOARD_VIEW_KEY, 'cols'))

// 信息卡墙的两个派生值（2026-10-10，卡 20261010-003）。
// ⚠ 派生逻辑本体在 `shared/boardCards.ts`（纯函数，`dist/shared/boardCards.js` 可被 node 直接
//   断言，见 scripts/test/e2e-board-cards.cjs）—— 这里只负责接线，不在这里写算法。
// ⚠ computed 是惰性的：filteredTasks / blockers 定义在本文件更靠后的位置也不会 TDZ 报错
//   （第一次求值发生在渲染时，届时所有顶层 const 都已就绪）。
// ── 卡片墙「只看未完成」开关（2026-10-10 用户要求）──────────────────────────
// 默认**关** —— 项目铁律「加视图 / 加选项一律新增可选、旧行为保留」。
// 只作用于卡片墙，不动列 / 列表两种摆法；选择进 prefs 真身（换 origin 不丢）。
const CARD_WALL_OPEN_ONLY_KEY = 'fc_card_wall_open_only'
const cardWallOpenOnly = ref<boolean>(readUiPref<boolean>(CARD_WALL_OPEN_ONLY_KEY, false))
watch(cardWallOpenOnly, (v) => saveUiPref(CARD_WALL_OPEN_ONLY_KEY, v))

/**
 * 卡片墙用的分组 —— 在 `columns` 之上做一层**只读**过滤。
 * ⚠ 绝不能改 `columns` 本身：列 / 列表两种摆法共用它，动了会连带改掉它们的显示。
 * ⚠ 开关打开时被过滤空的组**整组收掉**（留一个空组头比直接隐藏更让人困惑）。
 * ⚠ 判据本体仍在 shared/boardCards.ts（openOnly / isOpenTask），这里只接线。
 */
const cardWallGroups = computed(() =>
  columns.value
    .map((c) => ({ ...c, tasks: cardWallOpenOnly.value ? openOnly(c.tasks) : c.tasks }))
    .filter((c) => !cardWallOpenOnly.value || c.tasks.length > 0))

/** 卡片墙要算元数据的任务：三种摆法共用同一份 columns（摊平只为一次算好元数据） */
const cardWallTasks = computed(() => cardWallGroups.value.flatMap((c) => c.tasks))
/** 按 id 索引的卡片元数据：一次算好给模板取，避免模板里每帧重复调纯函数 */
const cardWallMeta = computed<Record<string, BoardCardMeta>>(() => {
  const idx = buildBlockerIndex(blockers.value as any)
  const m: Record<string, BoardCardMeta> = {}
  for (const t of cardWallTasks.value) m[(t as any).id] = boardCardMeta(t, idx)
  return m
})
/** 模板取卡片元数据的小助手：查不到给一份空 meta（界面据此整格不渲染），
    模板里就不用写一长串 `|| {}` —— 也免得守卫把这种表达式当成可疑标识符。 */
const EMPTY_CARD_META: BoardCardMeta = {
  id: '', tone: '', priority: '', blockedBy: 0, blocks: 0, blocked: false,
}
function cw(t: any): BoardCardMeta {
  return cardWallMeta.value[(t && t.id) || ''] || EMPTY_CARD_META
}
/** 模板里的 `@change` 拿不到 TS 断言（Vue 模板表达式不吃 `as`），所以这里做窄化。
    落盘交给 `watch(cardWallOpenOnly)` —— 与项目里其他偏好同一条路径。 */
function toggleCardWallOpenOnly(e: Event): void {
  const el = e.target as HTMLInputElement
  cardWallOpenOnly.value = !!(el && el.checked)
}

const todoView = ref<'list' | 'grid'>(readUiPref<'list' | 'grid'>(TODO_VIEW_KEY, 'list'))
// 项目页签的摆法（2026-09-29 用户口径：「项目页签两种视图都要，做成用户可自选切换选项」；
//   2026-10-05 Q2 新增第四种「在途一屏」—— 立项契约 ② 验收线之①）。
// ⚠ 默认仍是**旧的项目墙** —— 方寸铁律「加视图一律新增可选、旧的保留、旧视图永远是默认」。
const pvView = ref<'tiles' | 'overview' | 'master' | 'trip' | 'tier' | 'mismatch' | 'rice'>(
  readUiPref<'tiles' | 'overview' | 'master' | 'trip' | 'tier' | 'mismatch' | 'rice'>(PV_VIEW_KEY, 'tiles'))
/** 项目页签全部摆法的合法取值（切视图时校验用；顺带让 setViewMode 保持紧凑） */
const PV_VIEWS: string[] = ['tiles', 'overview', 'master', 'trip', 'tier', 'mismatch', 'rice']

// ── 在途一屏（2026-10-05 Q2 · 立项契约 ② 验收线之①）────────────────────
// 一行一个在途项目，回答「在哪一步 / 下一步 / 卡在谁」。数据全部来自主进程只读聚合
// （`trip:board`：各 repo 的 立项契约.md + 任务卡 + 执行日志 + git 提交时间）。
//
// 三条红线（暮雨 2026-10-05 拍板）：
//   ① **零硬编码项目清单** —— 由判据推导，用户可手动指定并落 prefs；
//   ② **缺值显示「未填」**，绝不回退默认值；
//   ③ 方寸**不写任何项目仓库**（"打开 repo" 只传 projectId，路径由主进程从 registry 取）。
const TRIP_CRITERIA_OPTIONS = [
  { v: 'cards', label: '有未完结卡' },
  { v: 'cards_or_commit', label: '有未完结卡 或 30 天内有提交' },
  { v: 'cards_or_log', label: '有未完结卡 或 有执行日志' },
  { v: 'manual', label: '手填清单（手动指定）' },
] as const
const TRIP_COL_OPTIONS = [
  { v: 'end', label: '终态一句话' },
  { v: 'current', label: '当前步骤' },
  { v: 'next', label: '下一步' },
  { v: 'who', label: '卡在谁' },
  // 2026-10-22 · 03 任务三：四栏台账的第四栏「欠着什么」（registry 手写欠账清单）
  { v: 'owe', label: '欠着什么' },
  { v: 'health', label: '健康度' },
  { v: 'counts', label: '卡 / 日志' },
  { v: 'commit', label: '最近提交' },
  { v: 'dirty', label: '未提交文件数' },
] as const
// 健康度点一下换一档（机器给默认，人可覆盖 —— 司天那种「在动但冻结」机器算不出来）
const TRIP_HEALTH_CYCLE = ['active', 'stuck', 'dormant', 'paused', 'idle'] as const
const TRIP_HEALTH_LABEL: Record<string, string> = {
  active: '活跃', stuck: '停滞', dormant: '休眠', paused: '搁置', idle: '空闲',
}

const tripRows = ref<any[]>([])
/** 登记了但没进这一屏的项目（判据没命中）—— 必须说出来，否则用户以为"我加的项目没了" */
const tripHidden = ref<{ id: string; name: string; reason: string }[]>([])
/** 上一次读取失败的原因。**空屏时要说真话**：是"确实没有"还是"根本没读到"（2026-10-05 用户连报三次看不见） */
const tripError = ref('')
const tripLoading = ref(false)
/** 详情页 git 行：在途一屏数据已在内存时按项目取行；没拉过 = null（界面给「拉取」按钮，不编数据） */
const msGitRow = computed(() => {
  const id = pvCurrent.value?.id
  if (!id || !tripRows.value.length) return null
  return tripRows.value.find((r: any) => r.id === id) || null
})
const tripSettingsOpen = ref(false)
const tripMeta = ref<{ generatedAt: string; mode: string; criteria: string }>(
  { generatedAt: '', mode: 'auto', criteria: 'cards_or_commit' })
// ⚠ 四个键都从 readUiPref 起手（而不是空值等 syncBoardPrefs 回填）：
//   否则 syncBoardPrefs 因任何原因没跑到时，界面会拿着空值去覆盖用户已存的选择。
const tripMode = ref<'auto' | 'manual'>(readUiPref<'auto' | 'manual'>('fc_trip_mode', 'auto'))
const tripCriteria = ref<string>(readUiPref<string>('fc_trip_criteria', 'cards_or_commit'))
const tripManualIds = ref<string[]>(readUiPref<string[]>('fc_trip_projects', []))
const tripCols = ref<string[]>(readUiPref<string[]>('fc_trip_cols', TRIP_COL_OPTIONS.map(o => o.v)))

const tripSubtitle = computed(() => {
  const c = TRIP_CRITERIA_OPTIONS.find(o => o.v === tripMeta.value.criteria)?.label || tripMeta.value.criteria
  const mode = tripMeta.value.mode === 'manual' ? '手动指定' : '自动'
  const when = tripMeta.value.generatedAt ? ` · 更新于 ${tripMeta.value.generatedAt}` : ''
  return `${tripRows.value.length} 个项目 · ${mode}（${c}）${when}`
})

// 空屏时说什么：要分清「门槛太严」和「你选了手动却还没勾」——后者说成前者就是骗人
const tripEmptyHint = computed(() => {
  if (tripMode.value === 'manual' && !tripManualIds.value.length) {
    return '你选的是「手动指定」，但还没勾任何项目 —— 点「⚙ 显示设置」勾几个，它们就会出现在这里。'
  }
  return '按现在的规则，没有项目算在途。点「⚙ 显示设置」把规则放宽，或改成「手动指定」自己勾。'
})

// 没进这一屏的项目要**按原因分开说**：把"你没勾它"说成"它没有未完结任务"就是假话
// （2026-10-05：方寸自己有几十张未完结卡，却被那句统一文案说成"没有未完结任务"）。
const tripHiddenNotPicked = computed(() => tripHidden.value.filter(h => h?.kind === 'not-picked'))
const tripHiddenNoActivity = computed(() => tripHidden.value.filter(h => h?.kind !== 'not-picked'))

async function loadTripBoard(): Promise<void> {
  tripLoading.value = true
  try {
    const res: any = await (window as any).tegula.tripBoard()
    if (res?.ok) {
      tripError.value = ''
      tripRows.value = Array.isArray(res.rows) ? res.rows : []
      tripHidden.value = Array.isArray(res.hidden) ? res.hidden : []
      tripMeta.value = {
        generatedAt: res.generatedAt || '',
        mode: res.mode || 'auto',
        criteria: res.criteria || 'cards_or_commit',
      }
      // ⚠ 这里**绝对不能**去"同步" tripManualIds（曾经写过一版：把 rows 的 id 回填给勾选清单）。
      //   后果：用户勾的项目正因为"没进屏"才需要留在清单里，回填等于**当场把他的勾选抹掉** ——
      //   表现为「提示保存了，但重新打开勾选全没了」（2026-10-05 用户实测）。
      //
      // 数据层的**兜底回自动**：prefs 里写着「手动指定」却从没勾过任何项目（旧写法只落了字符串键，
      // 数组键丢了）—— 照字面执行会让这一屏空得像界面坏了。数据层此时按自动走并回传 modeFallback，
      // 界面必须把这件事说出来，并且把面板上的模式同步成"自动"，否则会出现
      // 「面板高亮手动、屏上是自动结果」的自相矛盾。
      if (res.modeFallback) {
        tripMode.value = 'auto'
        tripManualIds.value = []
        showToast('之前选过「手动指定」但从没勾过项目，这次按规则自动显示 —— 要固定就打开「显示设置」勾几个', 'info')
      }
    } else {
      tripRows.value = []
      tripHidden.value = []
      tripError.value = String(res?.error || '未知错误')
      showToast('读取在途一屏失败：' + (res?.error || '未知错误'), 'error')
    }
  } catch (e: any) {
    tripRows.value = []
    tripHidden.value = []
    tripError.value = String(e?.message || e)
    showToast('读取在途一屏异常：' + (e?.message || e), 'error')
  } finally {
    tripLoading.value = false
  }
}

function tripColVisible(c: string): boolean {
  return tripCols.value.includes(c)
}

function tripHealthLabel(v: string): string {
  return TRIP_HEALTH_LABEL[v] || v || '空闲'
}

function tripHealthClass(v: string): string {
  return v === 'active' ? 'g' : v === 'stuck' ? 'y' : v === 'paused' ? 'p' : 'gray'
}

/** 点健康度：在档位之间循环一次，并**锁定**（机器不再覆盖）。回到「活跃」以外都可撤销。 */
function tripCycleHealth(row: any): void {
  const cur = String(row?.health?.value || 'active')
  const i = TRIP_HEALTH_CYCLE.indexOf(cur)
  const next = TRIP_HEALTH_CYCLE[(i + 1) % TRIP_HEALTH_CYCLE.length]
  const overrides = { ...(tripHealthOverrides.value || {}) }
  overrides[row.id] = next
  tripHealthOverrides.value = overrides
  saveUiPref('fc_health_overrides', overrides)
  showToast(`「${row.name}」健康度标为「${tripHealthLabel(next)}」（已锁定，点它可继续切换）`, 'info')
}

/** 解除人工锁定：回到机器默认 */
function tripUnlockHealth(row: any): void {
  const overrides = { ...(tripHealthOverrides.value || {}) }
  delete overrides[row.id]
  tripHealthOverrides.value = overrides
  saveUiPref('fc_health_overrides', overrides)
  void loadTripBoard()
  showToast(`「${row.name}」健康度已恢复自动`, 'info')
}

const tripHealthOverrides = ref<Record<string, string>>(readUiPref<Record<string, string>>('fc_health_overrides', {}))

/**
 * 落盘 + 立即刷新这一屏。
 *
 * 2026-10-05 改：原来有个「保存」按钮，用户实测「提示保存了，但每次重新勾选都被取消」——
 * 真身里 `fc_trip_mode` 存进去了、`fc_trip_projects` 却没有：说明"点保存"这条路径本身
 * 就是**假成功的温床**（中间任何一步出错，用户看到的仍是一句"已保存"）。
 * 现在改成**任何改动即时落盘**，界面不提供"保存"这个动作，也就没有"存没存"的疑问。
 */
/**
 * 落盘这一屏的四个偏好键 + 立刻重取数据。
 *
 * ⚠ 2026-10-05 用户实测「提示保存了但实际并未保存，每次重新勾选都被取消」：
 *   · 旧写法是**连续四次** saveUiPref（四次 IPC、四次整文件改写），且**不看返回值** ——
 *     prefs.json 里最终只落了两个字符串键，两个数组键丢了，界面却照样说"已保存"。
 *   · 现在改为**一次 IPC 写完四个键**（主进程合并读-改-写 + 回读校验），
 *     并且**校验结果必须传回界面**：写失败就说失败，绝不假成功。
 */
async function tripApplySettings(): Promise<boolean> {
  const patch = toPlain({
    fc_trip_mode: tripMode.value,
    fc_trip_criteria: tripCriteria.value,
    fc_trip_projects: [...tripManualIds.value],  // 展开成裸数组，别把响应式数组塞进载荷
    fc_trip_cols: [...tripCols.value],
  })
  // localStorage 只当读缓存（真身永远在主进程 prefs.json）
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* 缓存失败无所谓 */ }
  }
  let ok = true
  try {
    const res: any = await (window as any).tegula?.prefsSetMany?.(patch)
    // ⚠ 返回值必须**明确成功**才算成功：`undefined` = 通道根本没通（旧主进程 / preload 缺这个 API），
    //   那也是"没存住"，不能当成成功（2026-10-05 用户「提示保存了但没保存」的老路）。
    if (!res || res.ok !== true) {
      ok = false
      showToast('设置没存住：' + ((res && res.error) || '主进程没回应（可能还是旧代码）') + ' —— 请把这句话告诉开发者', 'error')
    }
  } catch (e: any) {
    ok = false
    showToast('设置写入异常：' + (e?.message || e), 'error')
  }
  await loadTripBoard()
  return ok
}

function tripSetMode(m: 'auto' | 'manual'): void {
  tripMode.value = m
  void tripApplySettings()
}

function tripSetCriteria(c: string): void {
  tripCriteria.value = c
  void tripApplySettings()
}

/**
 * 「保存」= 落盘 + 关面板 + 明确告知存了什么。
 *
 * 2026-10-05 用户口径：「用户不需要理解运行机制，只要看到最终保存了就行」——
 * 所以按钮就叫「保存」，点下去要有一句带**可核对事实**的确认（而不是"已保存"三个字）。
 * 而"存住了没有"以**写盘回读校验**的返回值为准 —— 校验不过就报错，不假成功。
 */
async function tripCloseAfterSave(): Promise<void> {
  const ok = await tripApplySettings()
  tripSettingsOpen.value = false
  if (!ok) return  // 失败时 tripApplySettings 已经报过错了
  const n = tripRows.value.length
  showToast(tripMode.value === 'manual'
    ? `已保存：这一屏按你勾的项目显示，共 ${n} 个`
    : `已保存：按门槛自动筛，这一屏 ${n} 个项目`, 'success')
}

/** 空屏时的出口：从「手动指定」一步走回自动（并落盘） */
function tripBackToAuto(): void {
  tripMode.value = 'auto'
  tripCriteria.value = 'cards_or_commit'
  tripManualIds.value = []
  void tripApplySettings().then(() => {
    showToast('已改回自动：按规则筛项目，这一屏现在 ' + tripRows.value.length + ' 个', 'success')
  })
}

function tripResetSettings(): void {
  tripMode.value = 'auto'
  tripCriteria.value = 'cards_or_commit'
  tripManualIds.value = []
  tripCols.value = TRIP_COL_OPTIONS.map(o => o.v)
  void tripApplySettings()
}

/** 复制契约模板 / 查看已有契约原文（方寸只给文本，落盘由用户自己做） */
async function tripCopyContract(row: any): Promise<void> {
  try {
    const res: any = await (window as any).tegula.contractText(row.id)
    if (!res?.ok) { showToast('读取契约失败：' + (res?.error || '未知错误'), 'error'); return }
    const ok = await copyWithToast(res.text, res.exists ? '契约原文已复制' : '契约模板已复制 —— 去仓库根存成 立项契约.md')
    if (ok && !res.exists) {
      showToast(`建议落点：${row.repo}/立项契约.md`, 'info')
    }
  } catch (e: any) {
    showToast('复制契约异常：' + (e?.message || e), 'error')
  }
}

/**
 * 「让 AI 填契约」的可复制提示词（2026-10-10 用户要求）。
 *
 * 用户原话：「契约文件如何完善？之前说让 AI 填，但是不知道怎么弄。」
 * 上一版界面上只有一句「建好后打开它填内容（也可以让 AI 填）」——
 * **没给能粘贴的东西，等于没说**。这里给的是一段可直接贴进「该项目仓库里开的 AI 会话」的话：
 *   · 说清读哪几个文件当依据（不然它凭空编）；
 *   · 六节逐条填 + **找不到证据就写「未填」不许编**（契约自己写着「缺值不得填默认」）；
 *   · **逐节念回签收** —— 那是契约模板五条机制条款之一，不写进去它会一口气填完，你来不及看；
 *   · 圈定改动范围（只碰 立项契约.md）。
 */
function contractFillPrompt(row: any): string {
  const name = String(row?.name || row?.id || '这个项目').trim()
  const repo = String(row?.repo || '').trim()
  const lines = [
    `请帮我填写「${name}」的立项契约。`,
    ``,
    `1. 先读本仓库根目录的 立项契约.md（目前是骨架，还没填内容）。`,
    `2. 再读 AGENTS.md、README.md 和主要代码目录，作为事实依据。`,
    `3. 按六个小节逐条填：① 终态形态 ② 验收线 ③ 不要什么 ④ 选型定死 ⑤ 现状底数 ⑥ 下一队列。`,
    ``,
    `规矩（这几条必须守）：`,
    `- 只写仓库里找得到证据的内容；找不到就写「未填」并说明缺什么 —— 不要编。`,
    `- 每填完一节，用「原话 + 翻译」念回给我确认，我点头你再填下一节。`,
    `- 除了 立项契约.md，不要修改任何其它文件。`,
  ]
  if (repo) lines.push(`- 这个仓库的路径是：${repo}`)
  return lines.join('\n')
}

async function tripCopyContractPrompt(row: any): Promise<void> {
  const ok = await copyWithToast(contractFillPrompt(row),
    '提示词已复制 —— 贴到这个项目仓库里开的 AI 会话即可')
  if (ok) showToast('它会按契约骨架逐节填，并逐节念回给你确认', 'info')
}

/** 打开该项目的文件夹（只传 id，路径由主进程从 registry 取 —— 不接任意路径） */
async function tripOpenRepo(row: any): Promise<void> {
  try {
    const res: any = await (window as any).tegula.tripOpenRepo(row.id)
    if (!res?.ok) { showToast('打开项目文件夹失败：' + (res?.error || '未知错误'), 'error'); return }
    // 打开之后必须有抓手（用户原话：打开之后只能对着资源管理器发呆）——
    // 契约还缺着就把下一步说清；已有契约就不多嘴。
    if (!(row?.contract && row.contract.exists)) {
      showToast('已打开项目文件夹 —— 下一步：在里面新建「立项契约.md」，点「① 复制模板」粘进去就好', 'info')
    }
  } catch (e: any) {
    showToast('打开项目文件夹异常：' + (e?.message || e), 'error')
  }
}

/**
 * 「📄 打开契约」（卡 002）：文件建了就总得有地方改它。
 * 走既有 openFile 通道（主进程 validateAndOpenFile：存在性检查 + 系统默认程序打开），
 * 路径来自主进程聚合出来的 contract.path —— 渲染层不自己拼路径。
 */
async function tripOpenContract(row: any): Promise<void> {
  const p = String(row?.contract?.path || '')
  if (!p) { showToast('这个项目还没登记文件夹路径 —— 先在项目设置里补上', 'error'); return }
  try {
    const res: any = await (window as any).tegula.openFile(p)
    if (res && res.ok === false) showToast('打开契约失败：' + (res.error || '未知错误'), 'error')
  } catch (e: any) {
    showToast('打开契约异常：' + (e?.message || e), 'error')
  }
}

/**
 * 点整行 = 进这个项目的详情（卡 002：行此前不可点，只有健康度与🗑两个热点）。
 * 复用主从摆法的 ms-detail，不新造详情页 —— 所以是「切到 master + 选中该项目」。
 * ⚠ 行内按钮一律 .stop，点击不会漏到这里；这里再兜一层（按钮在 span 里时 target 是内层元素）。
 * ⚠ 只切内存状态、不写 prefs：这是一次性浏览动作，用户选好的摆法（在途一屏）不该被顺手改掉。
 */
function tripOpenRow(row: any, e?: MouseEvent): void {
  const t = (e && (e.target as HTMLElement | null)) || null
  if (t && typeof t.closest === 'function' && t.closest('button')) return
  pvSelected.value = row?.id || ''
  pvView.value = 'master'
}

/**
 * 「📝 建契约文件」：让方寸在该项目文件夹里**创建**「立项契约.md」。
 *
 * 2026-10-05 用户口径：「让方寸直接写仓库文件更方便，用户打字输错一个字可能就无法识别。
 * 弹窗让用户确认权限即可，方寸不静默做。」→ 先弹确认框把「写到哪 / 写什么 / 什么情况拒绝」
 * 念清楚，再动手；主进程侧只建不覆盖。
 */
async function tripInitContract(row: any): Promise<void> {
  const repo = String(row?.repo || '')
  if (!repo) {
    showToast('这个项目还没登记文件夹路径 —— 先在项目设置里补上', 'error')
    return
  }
  const msg = `让方寸在项目文件夹里创建「立项契约.md」？\n\n`
    + `写到哪里：${repo}\\立项契约.md\n`
    + `写什么：一份空白契约（六个小节 + 五条通用条款）—— 里面的内容由你或 AI 之后填\n`
    + `安全：这个文件已经存在的话，方寸会直接拒绝，不会覆盖\n\n`
    + `确认创建吗？`
  if (!confirm(msg)) return
  try {
    const res: any = await (window as any).tegula.tripInitContract(row.id)
    if (!res?.ok) { showToast('创建失败：' + (res?.error || '未知错误'), 'error'); return }
    showToast(`已创建：${res.path} —— 打开它填内容，或者交给 AI 填`, 'success')
    await loadTripBoard()
  } catch (e: any) {
    showToast('创建异常：' + (e?.message || e), 'error')
  }
}

/** 契约某一节的正文 → 一行摘要（表格里放不下整节；完整版在仓库文件里，agent 自己去读） */
function tripFirstLine(text: unknown): string {
  const s = String(text || '').trim()
  if (!s) return ''
  for (const raw of s.split('\n')) {
    const t = raw.trim().replace(/^[#>\-*\s]+/, '').replace(/\*\*/g, '').trim()
    if (t) return t.length > 84 ? t.slice(0, 84) + '…' : t
  }
  return ''
}

/**
 * 契约「终态」为空时，**把原因说清楚**（2026-10-11 真机修正）。
 *
 * 触发的真事：绒花墨坊的契约用「① 终态三段 / ② 原料边界 / ⑥ 验收锚点」这套自定义小节名，
 * 方寸只认标准六节名 → 六个字段全空 → 界面写「内容未填」。用户当场反问「已经有内容了啊？」。
 * **把"小节名对不上"说成"未填"，就是界面说假话** —— 比空白更糟，因为它让人以为文件是空的。
 * 三种原因分开说：模板占位 / 小节名对不上（并把文件里实际的小节列出来）/ 真没写。
 */
function tripContractMissing(r: any): { text: string; title: string } {
  const c = r && r.contract
  if (!c || !c.exists) return { text: '未填', title: '' }
  if ((c.placeholderFields || []).includes('终态形态')) {
    return { text: '还是模板占位（没填）', title: '这一节在文件里只是"该写什么"的说明，不是内容' }
  }
  const unmatched: string[] = c.unmatched || []
  const sections: { name: string; field: string | null }[] = c.sections || []
  if (unmatched.length) {
    return {
      text: '小节名不在标准六节里',
      title: '文件里的小节是：' + sections.map(s => s.name).join(' / ')
        + '\n\n方寸只认名字里含标准字段名（或别名）的小节：\n'
        + '终态形态 · 验收线 · 不要什么 · 选型定死 · 现状底数 · 下一队列\n\n'
        + '（文件不是空的 —— 把小节标题改成上面这类名字，就能被读到了）',
    }
  }
  return { text: '这一节空着', title: c.path || '' }
}

/**
 * 移除项目登记（2026-10-05 用户：「项目页签里似乎没有添加和删除项目的入口」）。
 *
 * 边界说死：**只从 registry.yaml 删掉那一条登记** —— 任务卡、方针卡、项目仓库文件一个都不动；
 * 删完该项目下的卡变成「未归属项目」。破坏性 + 影响面不可猜 → 二次确认里逐条写明。
 * （随时可在「＋ 添加项目」重新登记回来，所以这不是不可逆操作。）
 */
async function removeProject(p: any): Promise<void> {
  const nm = p?.name || p?.id || ''
  const n = p?.taskCount != null
    ? p.taskCount
    : (Number(p?.counts?.todo || 0) + Number(p?.counts?.doing || 0) + Number(p?.counts?.review || 0))
  const msg = `移除项目登记「${nm}」？\n\n`
    + `· 只从 registry.yaml 删掉这一条登记\n`
    + `· 任务卡（${n} 张）全部保留 —— 只是变成「未归属项目」\n`
    + `· 方针卡与项目文件夹里的文件，一个字节都不动\n\n`
    + `（随时可以在项目页签「＋ 添加项目」重新登记回来）`
  if (!confirm(msg)) return
  try {
    const res: any = await (window as any).tegula.registryRemoveProject(p.id)
    if (!res?.ok) { showToast('移除失败：' + (res?.error || '未知错误'), 'error'); return }
    showToast(`已移除项目登记「${nm}」—— 还能在「＋ 添加项目」里重新登记`, 'success')
    await loadAll()
    if (pvView.value === 'trip') await loadTripBoard()
  } catch (e: any) {
    showToast('移除异常：' + (e?.message || e), 'error')
  }
}

// ── 项目三字段就地编辑（2026-10-22 · 施工单包 06）────────────────────────
/**
 * 打开编辑：值从主进程读（`registry:readFields`），不从界面缓存抄 ——
 * 详情页的 `pvCurrent` 是**任务统计派生**的，字段可能已经过时（别让"打开就看到旧值"再犯一次）。
 */
async function openNoteEdit(p: any): Promise<void> {
  if (!p?.id) return
  try {
    const r: any = await (window as any).tegula.registryReadFields(p.id)
    if (!r?.ok) {
      showToast(`读不到「${p.name || p.id}」这三个字段：${r?.error || '未知原因'}`, 'error')
      return
    }
    const f = r.fields || {}
    noteEditBase.value = {
      状态: String(f['状态'] || ''),
      路线图: String(f['路线图'] || ''),
      说明: String(f['说明'] || ''),
    }
    noteEdit.value = {
      id: p.id,
      name: p.name || p.id,
      状态: noteEditBase.value['状态'],
      路线图: noteEditBase.value['路线图'],
      说明: noteEditBase.value['说明'],
    }
  } catch (e: any) {
    showToast('读取异常：' + (e?.message || e), 'error')
  }
}

function cancelNoteEdit(): void {
  noteEdit.value = null
  noteEditBase.value = {}
}

/**
 * 保存：**只提交真改过的字段**（06 单要求 —— 没改就不提交，避免把没展示过的空值顺手写回去）。
 * 成功后挂撤销条：撤销 = 拿主进程回传的 `before` 再写一次，一步退回去。
 */
async function saveNoteEdit(): Promise<void> {
  const f = noteEdit.value
  if (!f || noteSaving.value) return
  const changed = NOTE_FIELDS.filter(k => String((f as any)[k] || '') !== String(noteEditBase.value[k] || ''))
  if (!changed.length) {
    showToast('三个字段都没改，没什么可保存的')
    cancelNoteEdit()
    return
  }
  noteSaving.value = true
  try {
    const patch: Record<string, string> = {}
    for (const k of changed) patch[k] = String((f as any)[k] || '')
    const r: any = await (window as any).tegula.registryUpdateFields(f.id, toPlain(patch))
    if (!r?.ok) {
      showToast(`没保存成：${r?.error || '未知原因'}`, 'error')
      return
    }
    const before = r.before || {}
    const nm = f.name
    const id = f.id
    cancelNoteEdit()
    projects.value = await (window as any).tegula.loadProjects()
    offerUndo(`已改「${nm}」的${changed.join(' / ')}`, async () => {
      const back: any = await (window as any).tegula.registryUpdateFields(id, toPlain(before))
      if (!back?.ok) throw new Error(back?.error || '这三个字段已被改动，改不回去了')
      projects.value = await (window as any).tegula.loadProjects()
    })
  } catch (e: any) {
    showToast('保存异常：' + (e?.message || e), 'error')
  } finally {
    noteSaving.value = false
  }
}

/** 手动模式下勾选/取消一个项目（零硬编码：清单只存在于用户的选择里） */
function tripToggleManual(id: string): void {
  const set = new Set(tripManualIds.value)
  if (set.has(id)) set.delete(id)
  else set.add(id)
  tripManualIds.value = Array.from(set)
  // 勾选就说明"我要自己定" → 自动切到手动模式。
  // （2026-10-05 用户：「收哪些项目里勾选「测试」也看不到」—— 因为他勾完了模式还在「自动」，
  //   勾选根本没生效。两个互相耦合的控件不该指望用户自己悟出先后关系。）
  if (tripManualIds.value.length) tripMode.value = 'manual'
  void tripApplySettings()
}

function tripToggleCol(c: string): void {
  const set = new Set(tripCols.value)
  if (set.has(c)) set.delete(c)
  else set.add(c)
  // 至少留一列，否则表格只剩项目名（用户会以为坏了）
  tripCols.value = set.size ? Array.from(set) : ['end']
  void tripApplySettings()
}

// 切到「在途一屏」时按需拉一次数据（放在 watch 里而不是 setViewMode 内 —— 后者被 e2e-prefs 的
// 源码断言盯着「两个 saveUiPref 之间的距离」，塞逻辑进去会把那条断言挤红）。
watch(pvView, (v) => { if (v === 'trip') void loadTripBoard() })

/** 当前页签可选的视图（空数组 = 这个页签没有多视图，页头整条不渲染） */
const viewOptions = computed<Array<{ v: string; label: string; hint: string }>>(() => {
  if (isBoardView.value) return [
    { v: 'cols', label: '▦ 列视图', hint: '按列摊开，可拖拽改状态；列多时要横向滚' },
    { v: 'list', label: '☰ 列表视图', hint: '单列纵排 + 状态分区，不横滚，一屏看得多半；分区头仍可折叠、可拖入改状态' },
    { v: 'cards', label: '▩ 信息卡墙', hint: '一张卡把信息一次给全：任务 ID / 优先级 / 阻塞；一屏约 9~12 张，不横滚，点 ID 可复制' },
  ]
  if (curView.value === 'todos') return [
    { v: 'list', label: '☰ 清单', hint: '两行卡：上行标题、下行优先级/项目/到期，右侧动作；批量勾选最快' },
    { v: 'grid', label: '▦ 卡片网格', hint: '方块卡片，长标题最多 3 行不截断；点标题进编辑，右键出菜单' },
  ]
  if (curView.value === 'projects') return [
    { v: 'tiles', label: '▦ 项目墙', hint: '现状：一格一个项目，四个数字（进行中/总数/完成率/最近活动）' },
    { v: 'overview', label: '▤ 概览卡', hint: '状态分布条 + 最近动态 + 阻塞/方针/结构地图缺口，一眼看出项目卡在哪' },
    { v: 'master', label: '◧ 主从', hint: '左侧常驻项目列表（带迷你进度），右侧摊开所选项目的详情；项目多了更顺手' },
    { v: 'trip', label: '◉ 在途一屏', hint: '一行一个在途项目：终态 / 当前步骤 / 下一步 / 卡在谁 / 健康度；缺值写「未填」，不编内容' },
    // 2026-10-25 暮雨：「放进项目页签里面就好。这玩意纯属小玩具」+「我丢的参考图里的梯度榜」
    { v: 'tier', label: '▥ 梯度榜', hint: '手动把项目拖进不同档位（核心/次优先/排队/搁置…）；只给自己看，不改看板与一屏' },
    // 2026-10-27 REV-008 一期 R4：让状态不一致的地方可见（2026-10-30 暮雨第 1 条改名：
    // 「对不上」不是人话，统一叫「状态提醒」）
    { v: 'mismatch', label: '⚠ 状态提醒', hint: '项目状态和仓库实际进度不一致、卡里写的文件已不存在、完成却没写怎么验收；只提醒，不阻挡' },
    // 2026-10-28：需求矩阵（RICE）—— 散点 + 表格；分数只存四个原始分，总分现算
    { v: 'rice', label: '▦ 需求优先级矩阵', hint: '只排先后，不替你做决定：横轴「要做几天」、纵轴「优先级分」，气泡越大用得越多；改一格立即重排，「采纳 / 砍掉」你点。' },
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
    pvView.value = PV_VIEWS.includes(v) ? (v as any) : 'tiles'
    saveUiPref(PV_VIEW_KEY, pvView.value)
  } else if (isBoardView.value) {
    boardView.value = v === 'list' ? 'list' : v === 'cards' ? 'cards' : 'cols'
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

// ── 筛选栏（2026-10-11 用户圈选「方案 B · 条件标签化」）────────────────────
// 三件事取代了原先那一排原生 select：
//   ① 主行只留「搜索 + ＋筛选」；② 生效条件变成可点 ✕ 的标签；③ 分组/排序点开同一个内联面板。
// ⚠ 这些入口用的仍是**原来那几个 ref**（curProj/curStatus/dueFilter/searchIncludeArchive/
//   groupMode/sortMode）—— 换的是操作手感，不是数据流；筛选仍然不写 prefs。
const FBAR_PANEL_TITLE: Record<string, string> = {
  filter: '筛选', proj: '按项目', status: '按状态', group: '分组方式', sort: '排序方式',
}
// ⚠ 用「数组 + 查找」而不是 `Record<...>` 映射：模板里 `v-for="(label, v) in MAP"` 需要写
//   `groupMode = v as any` 这种 TS 断言，而 `check-template-bindings` 会把 `as` / `any`
//   当成"模板引用了未声明的标识符"直接判红（实测）。数组写法没有断言，也就没这个问题。
const GROUP_OPTIONS: { v: string; label: string }[] = [
  { v: 'status', label: '按状态' },
  { v: 'project', label: '按项目' },
  { v: 'priority', label: '按优先级' },
]
const SORT_OPTIONS: { v: string; label: string }[] = [
  { v: 'active', label: '活跃优先' },
  { v: 'updated', label: '最近更新' },
  { v: 'created', label: '创建时间' },
  { v: 'prio', label: '优先级' },
]
const DUE_OPTIONS: { v: string; label: string }[] = [
  { v: 'overdue', label: '已逾期' },
  { v: 'today', label: '今天到期' },
  { v: 'week', label: '本周到期' },
]
/** 取选项的显示名（找不到就给原值 —— 宁可显示怪值，也不显示空白） */
function optLabel(opts: { v: string; label: string }[], v: string): string {
  return (opts.find(o => o.v === v) || { label: v }).label
}
type FbarPanel = 'filter' | 'proj' | 'status' | 'group' | 'sort'
/**
 * 当前打开的是哪一块（'' = 收着）。同一时间只开一块。
 *
 * ⚠ 这里**只管状态**，打开/关闭/定位/焦点全交给 reka-ui 的 Popover（2026-10-11 改）：
 *   第一版手搓内联面板 → 一点就把顶栏撑成三大行（用户：「太雷霆了，一点美感都没有」）；
 *   第二版手搓 backdrop + getBoundingClientRect 定位 → 能用了，但**还是在造轮子**；
 *   现在这版把这两块都删了，只留一个字符串状态。
 */
const fbarPanel = ref<'' | FbarPanel>('')

/** reka-ui 的 `update:open` 回传（点外面 / Esc / 再点触发按钮都会走到这里） */
function onPanelOpen(p: FbarPanel, v: boolean): void {
  if (v) {
    fbarPanel.value = p
    // 打发开筛选的那一刻重拉一次读卡记录（卡 20261025-006 第三件）：
    // 这个数字会因 agent 读卡随时变，进门时那份已经旧了 —— 而且面板里就要显示它，
    // 所以"打开时刷新"比"进视图时刷新"更贴合它被看的时机。
    if (p === 'filter') void loadNeverRead()
  }
  else if (fbarPanel.value === p) fbarPanel.value = ''
}

// ── 读取情况：「哪些待办其实没人碰过」（卡 20261025-006 第三件）────────────
// 数据来自 `mcp-usage.jsonl`（**agent 经 MCP 读卡**），不是"你在界面点开过"的记录 —— 口径见 shared/neverRead.ts。
// 三条不许踩：① 读不到就说读不到，绝不把"没数据"画成"全部没人碰过"；
//            ② 完成/驳回不进清单（那是主进程的判定，界面不重算）；
//            ③ 数字旁边必须有口径文案（`neverReadHint`），否则这个数会被当成别的东西。
const readFilter = ref<'' | 'never'>('')
const neverRead = ref<NeverReadResult | null>(null)
/** 是否已尝试过加载 —— 用来区分「还没拉」与「拉到了 0 张」 */
const neverReadLoaded = ref(false)
const neverReadIds = computed(() => new Set((neverRead.value?.rows || []).map(r => r.id)))
const neverReadLabel = computed(() => {
  const r = neverRead.value
  return r ? `没人碰过 ${r.count}` : '没人碰过'
})
const neverReadHint = computed(() => {
  const r = neverRead.value
  if (!r) {
    return neverReadLoaded.value
      ? '读卡记录读不出来 —— 这不等于「都有人读过」'
      : '正在读读卡记录…'
  }
  return neverReadSummary(r)
})

async function loadNeverRead(days = 30): Promise<void> {
  try {
    const api = (window as any).tegula
    if (!api?.usageNeverRead) throw new Error('preload 里没有 usageNeverRead')
    const r: any = await api.usageNeverRead(days)
    if (!r?.ok) throw new Error(r?.message || '主进程没返回结果')
    neverRead.value = r as NeverReadResult
  } catch {
    neverRead.value = null
  } finally {
    neverReadLoaded.value = true
  }
}
/** 换视图一定收起来（否则它会跟着跑到别的页签上，像一块甩不掉的浮层） */
function closeFbar(): void { fbarPanel.value = '' }

const curProjLabel = computed(() => {
  if (curProj.value === '__all__') return '全部项目'
  const p = projects.value.find(x => x.id === curProj.value)
  return p ? (p.name || p.id) : curProj.value
})

/**
 * 生效中的筛选条件（按顺序：项目 → 状态 → 到期 → 含归档）。
 * 这是方案 B 的核心：**"现在筛了什么"必须一眼可见** —— 老版的答案藏在四个下拉各自的
 * 显示值里，用户得挨个看过去，那就是"点起来很难受、不自然"的一半来源。
 */
const activeFilterChips = computed(() => {
  const out: { key: string; label: string }[] = []
  if (curProj.value !== '__all__') out.push({ key: 'proj', label: curProjLabel.value })
  if (curStatus.value) out.push({ key: 'status', label: curStatus.value })
  const due = DUE_OPTIONS.find(d => d.v === dueFilter.value)
  if (due) out.push({ key: 'due', label: due.label })
  if (readFilter.value === 'never') out.push({ key: 'read', label: '没人碰过' })
  if (searchIncludeArchive.value) out.push({ key: 'archive', label: '含归档' })
  return out
})

/** 点标签上的 ✕ = 撤掉这一条（就地生效，不需要再打开任何面板） */
function clearFilterChip(key: string): void {
  if (key === 'proj') curProj.value = '__all__'
  else if (key === 'status') curStatus.value = ''
  else if (key === 'due') dueFilter.value = ''
  else if (key === 'read') readFilter.value = ''
  else if (key === 'archive') searchIncludeArchive.value = false
}

/** 一次撤掉全部（只清"筛什么"，不动分组/排序 —— 那是"怎么排"，不是筛选） */
function clearAllFilters(): void {
  curProj.value = '__all__'
  curStatus.value = ''
  dueFilter.value = ''
  readFilter.value = ''
  searchIncludeArchive.value = false
}
const naturalResults = ref<Task[]>([])

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

/** 架构图（2026-10-13 暮雨第 2 条 · 方案 A）：把预览任务 frontmatter 里的 `架构`
 *  （LayerDiagramSpec 的 JSON 字符串）交给纯函数画成 SVG。
 *  四态：none = 没填（整块不渲染、旧卡零影响）｜ok｜archify｜bad = JSON 坏了 → 界面说人话，不静默留白。 */
const previewArch = computed<{
  state: 'none' | 'ok' | 'archify' | 'bad'; svg: string; error?: string;
  archify?: { type: string; views: number; counts: string }
}>(() => {
  const raw = String((previewTask.value as any)?.architecture || '').trim()
  if (!raw) return { state: 'none', svg: '' }
  let spec: any
  try {
    spec = JSON.parse(raw)
  } catch (e: any) {
    return { state: 'bad', svg: '', error: e?.message || String(e) }
  }
  // archify 技能卡（2026-10-14 清单第 9 条导入进来的）：**它和方寸的分层图不是一回事**。
  // 刻意**不硬转** —— 硬转会丢信息、语义也会错（archify 有 5 种图型，方寸只有分层图）。
  // 更不许报「JSON 读不出来」：那是**误导**，JSON 明明是好的，只是格式不同。
  if (spec && typeof spec === 'object' && spec.diagram_type && spec.schema_version !== undefined) {
    const ks = ['components', 'nodes', 'steps', 'stages', 'states', 'participants']
      .filter(k => Array.isArray(spec[k]) && spec[k].length)
    return {
      state: 'archify', svg: '',
      archify: {
        type: String(spec.diagram_type),
        views: Array.isArray(spec.meta?.views) ? spec.meta.views.length : 0,
        counts: ks.map(k => `${k} ${spec[k].length}`).join(' · '),
      },
    }
  }
  try {
    return { state: 'ok', svg: buildLayerDiagram(spec) }
  } catch (e: any) {
    return { state: 'bad', svg: '', error: e?.message || String(e) }
  }
})

/**
 * 表单里**实际显示**的字段（2026-10-13 暮雨第 3 条）。
 *
 * 主进程的 spec 可以带 `visibleWhen`（可序列化声明，过得了 IPC）。语义是**任一命中即显示**：
 * ① 该字段当前值非空  ② 任务标签里有 `tag`  ③ 标题以 `titlePrefix` 开头。
 * 给「架构图」这类**只对一类卡有意义**的字段用 —— 别的卡不必看一个空文本框。
 *
 * ⚠ 隐藏 ≠ 丢值：`saveEdit` 仍按**全量** taskFieldSpecs 收集 patch，这里只管"显示不显示"。
 */
const visibleFieldSpecs = computed(() => {
  const e: any = editTask_.value || {}
  // ⚠ tags 在表单里是**逗号串**（taskToFormValues 把数组 join 了），不是数组 —— 两种都认。
  const rawTags = e.tags
  const tagList = (Array.isArray(rawTags) ? rawTags.join(',') : String(rawTags || ''))
    .split(/[,，]/).map((s: string) => s.trim()).filter(Boolean)
  const title = String(e.title || '')
  return (taskFieldSpecs.value as any[]).filter((spec: any) => {
    const w = spec.visibleWhen
    if (!w) return true
    if (w.hasValue && String(e[spec.key] ?? '').trim()) return true
    if (w.tag && tagList.includes(w.tag)) return true
    if (w.titlePrefix && title.startsWith(w.titlePrefix)) return true
    return false
  })
})
const editTask_ = ref<any>(null)
// 任务卡历史版本（2026-10-18 卡 001；2026-10-31 收口）：列表 / 单版预览 / 恢复
const taskHistoryOpen = ref(false)
const taskVersions = ref<any[]>([])
const taskVersionPreview = ref<any>(null)
const taskVersionBusy = ref(false)
// 启动台「添加/编辑应用」模态的开关 + 表单载体。
// ⚠ 此前 template（v-if / v-model / 取消按钮）与 openAddApp / saveEditApp 全都在用它，
// 唯独这里没声明 → 点「+ 添加应用」立刻 ReferenceError，界面毫无反应；
// v-if 恒为 undefined 也让模态永不出现。同一个按钮因此被反复报修（"第六次了"），
// 而历次修复都在改 CSS / dialog / 原子写 —— 没碰到真因。
const editApp_ = ref<any>(null)
const showSettings_ = ref(false)

// ── 备份 / Git / 导出：已切到 composables/useBackup.ts（拆分第四刀，2026-10-30）──
// 状态仍由 composable 持有，这里只解构使用；调用方注入 showToast。
const backup = useBackup({ toast: showToast })
const {
  backupInfo, bkForm, bkSize, bkMsg, bkMsgType, bkBusy, bkTesting, bkTab, bkLocal, bkRemote, bkStatus, bkState, bkShowLog, bkLogLines, bkVerifyResult, bkCurrentList, bkAlert, bkDotClass, bkStatusText, bkTooltip, bkFmt, bkInitBackup, bkRefreshStatus, bkLoadConfig, bkLoadSizeReport, bkMB, bkLoadList, bkSwitchTab, bkRefreshList, bkSaveConfig, bkSaveSlim, bkSaveAndRun, bkRunLocalOnly, bkTestRemote, bkRestore, bkOpenDir, bkToggleLog, bkPickDir, gitRemote, gitBranch, gitToken, gitHasToken, gitBusy, gitMsg, gitMsgType, loadGitStatus, gitSaveConfig, gitForgetToken, gitTest, gitPushNow, bkCopyResticScript, bkExportTo, bkInspected, bkInspectRow, bkVerifyPackage, bkRestoreFromFile
} = backup


const batchMode = ref(false)
const selectedBatch = ref<string[]>([])

/** 项目结构图模态（2026-10-29 暮雨第 2 条）：null = 没开 */
// trashBatchMode / selectedTrashBatch 已随回收站组件搬走（2026-10-23）
const dataDir = ref('')

// ── 分区头整组选择（2026-10-25 暮雨第 11 条）──────────────────────────────
// 「一堆空草稿想全部归档，发现不能一键选所有草稿，只能一个个点」。
// 归档视图早有「按状态快选」，但看板没有 —— 整理时反而要绕四步。
// 现在列 / 列表 / 卡片三种视图的分区头各有一个框，语义与邮箱一致：
// 全选态打勾、部分选中打横线（indeterminate）、点一下选中整组、再点只取消这组。
function groupAllSelected(col: { tasks: Array<{ id: string }> }): boolean {
  return col.tasks.length > 0 && col.tasks.every((t) => selectedBatch.value.includes(t.id))
}
function groupSomeSelected(col: { tasks: Array<{ id: string }> }): boolean {
  const n = col.tasks.filter((t) => selectedBatch.value.includes(t.id)).length
  return n > 0 && n < col.tasks.length
}
function toggleGroupSelect(col: { tasks: Array<{ id: string }> }): void {
  const ids = col.tasks.map((t) => t.id)
  if (ids.every((id) => selectedBatch.value.includes(id))) {
    // 整组取消：只摘掉这组，别的组的选择保留（与归档区「可叠加」同口径）
    selectedBatch.value = selectedBatch.value.filter((id) => !ids.includes(id))
  } else {
    selectedBatch.value = Array.from(new Set([...selectedBatch.value, ...ids]))
  }
}


// ── Review ─────────────────────────────────────────────────────────
const reviewModal = ref<{ id: string; title: string; kind: 'approval' | 'acceptance' | 'direct'; intent?: 'accept' | 'reject' } | null>(null)
const launchpadApps = ref<any[]>([])
// 待办：数据 / 筛选 / 排序 / 多选 / 编辑弹窗在 composables/useTodos.ts（2026-10-23 · 拆分第 9 块）。
// 模板在 views/TodosView.vue（第 10 块）。
// `todos` 这个 ref 全文件 60 处共用（日历 / 在途一屏 / 日志转待办 / 快速记 / 项目统计），
// 所以**不能**把状态交给组件自持：先抽组合式函数（第 9 块，零行为变化），再搬模板（第 10 块）。
// ⚠ 这里保留 `todosApi` 这个整体引用 —— 视图组件要拿它的全部返回值当控制器（见文件末尾 todoViewCtl）。
const todosApi = useTodos({ toast: showToast, offerUndo })
const {
  todos, todoFilter, todoProjectFilter, todoSort, showConvertedTodos,
  convertedTodosCount, filteredTodos, todoStats, todoHealthIssue,
  todoProjectFilterProject, clearTodoFilters, overdueDays, prioClass, loadTodos,
  importTextLinesAsTodos, toggleTodo, deleteTodo,
  todoBatchMode, selectedTodoBatch, toggleTodoBatchMode, toggleTodoBatchSelect,
  onTodoItemClick, toggleSelectAllTodos, exitTodoBatch,
  executeBatchTodoDone, executeBatchTodoDelete,
  todoEdit_, todoEditSaving, openTodoEditor, closeTodoEditor, openTodoCreator, saveTodoEdit,
} = todosApi
const launchpadConfigPath = ref('')
const blockerChains = ref<any[]>([])
// 阻塞链的派生量（totalBlockedTasks / blockerImpact / blockerAdvice / blockerImpactById）
// 已于 2026-10-23 随「阻塞源」搬进 views/BlockersView.vue —— 这四个在这里**零引用**，
// 是第 2 块搬完留下的死代码（守卫只查模板引用，查不到这种脚本内自循环的死簇）。
const projectProgress = ref<Record<string, any>>({})

// ── 通知中心：已切到 composables/useNotifications.ts（拆分第五刀，2026-10-30）──
const notifications = useNotifications({
  toast: showToast,
  navigateTo,
  openCard,
  showParseErrors,
  openSettings: () => { showSettings_.value = true },
})
const {
  NC_TYPE_META, ncOpen, ncReady, ncLoading, ncUnread, ncFilter, ncCounts, ncVisible, ncHeadSub, ncRelTime, ncStatus, ncMuted, ncStatusText, ncLoad, ncUnmuteAll, ncRefresh, ncToggle, closePanel, ncSetFilter, ncTargetOf, ncClickItem, ncToggleRead, ncMarkAllRead, ncDelete, ncClearAll, ncInit
} = notifications

// 全局快捷键（Ctrl+Z 撤上一笔状态动作 / Ctrl+S 点弹窗主按钮）。
// ⚠ 它**不属于通知**：撤的是 App 的 undoBar + runUndo，搬进 useNotifications 会引用不到。
function onShortcutKeydown(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
  // ── Ctrl+Z：撤回上一笔状态动作（撤销条同源）─────────────────────────
  if (e.key === 'z' || e.key === 'Z') {
    // ⚠ 2026-10-21 暮雨实测：原来"焦点在输入框就一律放行"—— 他点完完成、焦点落在某处，
    //   按 Ctrl+Z 完全没反应，于是判定"快捷键无用"。现在的规则简单可预期：
    //   **只要撤销条在，Ctrl+Z 就撤这一步数据动作**（不管焦点在哪）；
    //   没有待撤动作时才放行输入框的原生撤销。
    if (!undoBar.value) return
    e.preventDefault()
    void runUndo()
    return
  }
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
  // 决策视图（2026-10-14）：不再在这里拉数据 —— 视图是 v-if 挂载的组件，
  // 它自己的 onMounted 就是"每次进门拉一次"，两处都写等于两份真相。
})

// ── 随问（2026-10-22 · 施工单包 03 任务一）────────────────────────────────
/**
 * 结构化查询面。三条纪律，都在这一小块里守住：
 *   ① **默认零 token** —— 答案由主进程从现有数据算，`needsLlm` 只有结构化真算不出来才是 true；
 *   ② **不装懂** —— 算不出来就把"交给 AI 答（会花 token）"这个按钮摆出来，让用户自己决定；
 *   ③ **花销可见** —— AI 那条回答的头上印事实字数与 token（03 单红线），不悄悄花钱。
 */
const askQ = ref('')
const askBusy = ref(false)
const askAns = ref<any>(null)
const askPresets = ref<Array<{ label: string; q: string }>>([])
const askLlmBusy = ref(false)
const askLlmAns = ref('')
const askLlmErr = ref('')
const askLlmMeta = ref('')

/** 常用问题由**主进程**给（界面不许自己写一份文案 —— 两边一漂移就成了两套问题集） */
async function loadAskPresets(): Promise<void> {
  try {
    const r: any = await window.tegula.askPresets()
    askPresets.value = Array.isArray(r?.presets) ? r.presets : []
  } catch {
    askPresets.value = []
  }
}

/** 常用问题按 group 归并 —— 九个按钮排一行会挤成两行、还孤零零剩一个（2026-10-22 截图目检） */
const askGroups = computed(() => {
  const out: Array<{ name: string; items: Array<{ label: string; q: string; hint?: string }> }> = []
  for (const p of askPresets.value) {
    const name = String((p as any).group || '常用')
    let g = out.find((x) => x.name === name)
    if (!g) { g = { name, items: [] }; out.push(g) }
    g.items.push(p)
  }
  return out
})

/** 月度报表（03 任务三）：按自然月，最近 3 个月。读不到就空 —— 界面会直说"一次都没走过 AI"。 */
const usageMonths = ref<any[]>([])
/** 账户口径（2026-10-25 卡 005）：只读状态，真正的余额请求在 refreshBalance 里按需发 */
const balanceStatus = ref<any>(null)
const balanceObserving = ref(false)

async function loadBalanceStatus(): Promise<void> {
  try {
    const r: any = await (window as any).tegula.llmBalanceStatus()
    balanceStatus.value = r || null
  } catch {
    // 旧主进程没有这条通道 → 不显示这块（不报假）
    balanceStatus.value = null
  }
}

/** 端点 id → 人话品牌名（界面上别直接摆 `deepseek` 这种内部 id） */
function providerLabel(p: string): string {
  if (p === 'deepseek') return 'DeepSeek'
  if (p === 'openrouter') return 'OpenRouter'
  return p || '未知端点'
}

/** 模型单价表（2026-10-25 卡 005 B 档）：**空表 = 一律未折算**，方寸不预置任何默认价 */
const priceRows = ref<Array<{ model: string; in: string; out: string }>>([])
const priceSaving = ref(false)
const priceMsg = ref('')

/**
 * 金额显示：定点字符串（"0.00320000"）→ 人话。
 * ⚠ 只做**截断**不做四舍五入：宁可显示少一点，也不把 0.00349 说成 0.0035 让人以为花了更多。
 */
function fmtCost(v: unknown): string {
  const raw = String(v ?? '0')
  const dot = raw.indexOf('.')
  if (dot < 0) return raw
  const frac = (raw.slice(dot + 1) + '0000').slice(0, 4).replace(/0+$/, '')
  return frac ? `${raw.slice(0, dot)}.${frac}` : raw.slice(0, dot)
}

/** 定点字符串 → 输入框里好看的形式：`2.00000000` → `2`、`0.50000000` → `0.5` */
function trimFixed(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!s || s.indexOf('.') < 0) return s
  return s.replace(/0+$/, '').replace(/\.$/, '')
}

async function loadPrices(): Promise<void> {
  try {
    const r: any = await (window as any).tegula.llmGetPrices()
    priceRows.value = (Array.isArray(r?.rows) ? r.rows : []).map((x: any) => ({
      model: String(x?.model || ''), in: trimFixed(x?.in), out: trimFixed(x?.out),
    }))
    priceMsg.value = r?.warn || ''
  } catch {
    priceRows.value = []
  }
}

function addPriceRow(): void {
  priceRows.value.push({ model: '', in: '', out: '' })
}

async function savePrices(): Promise<void> {
  if (priceSaving.value) return
  priceSaving.value = true
  priceMsg.value = ''
  try {
    // ⚠ 过桥必须给裸对象：`priceRows.value` 是 Vue 响应式代理，contextBridge 走结构化克隆会抛
    //   「An object could not be cloned」。这是本项目第四次踩（前三次：tiers / 偏好 / IPC 载荷）——
    //   假 preload 的 cloneGuard 当场把它抓成红，否则界面上只会看到"保存失败"。
    const r: any = await (window as any).tegula.llmSetPrices(toPlain(priceRows.value))
    if (!r?.ok) { priceMsg.value = r?.error || '保存失败'; showToast('单价保存失败：' + (r?.error || '未知原因'), 'error'); return }
    // 界面显示的必须是**真存下来的那份**（清洗会丢空名行、非法价行）
    priceRows.value = (r.rows || []).map((x: any) => ({ model: String(x.model), in: String(x.in), out: String(x.out) }))
    priceMsg.value = `已保存 ${priceRows.value.length} 个模型的单价`
    showToast('单价已保存', 'success')
  } catch (e: any) {
    priceMsg.value = e?.message || String(e)
    showToast('单价保存失败：' + priceMsg.value, 'error')
  } finally {
    priceSaving.value = false
  }
}

async function refreshBalance(): Promise<void> {
  if (balanceObserving.value) return
  balanceObserving.value = true
  try {
    const r: any = await (window as any).tegula.llmBalanceObserve()
    if (r?.status) balanceStatus.value = r.status
    showToast(r?.message || (r?.ok ? '已查一次余额' : '查余额失败'), r?.ok ? 'success' : 'error')
  } catch (e: any) {
    showToast('查余额失败：' + (e?.message || e), 'error')
  } finally {
    balanceObserving.value = false
  }
}

async function loadUsageMonths(): Promise<void> {
  try {
    const r: any = await window.tegula.llmUsageMonthly(3)
    usageMonths.value = Array.isArray(r?.months) ? r.months : []
  } catch {
    usageMonths.value = []
  }
}

async function runAsk(): Promise<void> {
  const q = askQ.value.trim()
  if (!q || askBusy.value) return
  askBusy.value = true
  askLlmAns.value = ''
  askLlmErr.value = ''
  askLlmMeta.value = ''
  try {
    const r: any = await window.tegula.askQuery(q)
    if (!r || r.ok === false) {
      // 失败要说出来，不能留上一题的答案在那儿冒充"这题的答案"
      showToast(`查询失败：${r?.error || '未知原因'}`, 'error')
      askAns.value = null
    } else {
      askAns.value = r
    }
  } catch (e: any) {
    showToast('查询异常：' + (e?.message || e), 'error')
  } finally {
    askBusy.value = false
  }
}

function askQuick(q: string): void {
  askQ.value = q
  void runAsk()
}

/** 只有用户点了这个按钮才会花 token —— 主进程那边把事实包一起发过去，模型没机会自由发挥 */
async function askToLlm(): Promise<void> {
  if (!askAns.value || askLlmBusy.value) return
  const q = askQ.value.trim()
  if (!q) return
  askLlmBusy.value = true
  askLlmErr.value = ''
  askLlmAns.value = ''
  askLlmMeta.value = ''
  try {
    const r: any = await window.tegula.llmAsk(q)
    if (!r || r.ok === false) {
      askLlmErr.value = 'AI 没答上来：' + (r?.error || '未知原因')
      return
    }
    askLlmAns.value = String(r.text || '')
    askLlmMeta.value = `事实 ${r.facts_chars || 0} 字${aiUsageTail(r.usage)}`
  } catch (e: any) {
    askLlmErr.value = 'AI 调用异常：' + (e?.message || e)
  } finally {
    askLlmBusy.value = false
  }
}

// 随纠（2026-10-22 · 03 任务二）：一句话改方向。不填表单、不猜参数。
const correctOpen = ref(false)
const correctText = ref('')
const correctBusy = ref(false)
const correctErr = ref('')

function openCorrect(): void {
  correctOpen.value = true
  correctText.value = ''
  correctErr.value = ''
}
function closeCorrect(): void {
  correctOpen.value = false
  correctErr.value = ''
}

/**
 * 执行一句话纠偏。三件事必须一起成立，缺一件都不算"纠得动"：
 *   ① 字段真改了（主进程写前自校验）；② 决策卡留痕（没记上要**说出来**，
 *   否则台账上看着"改过"，实际只有字段变了）；③ 撤销条挂上（一步退回去）。
 */
async function runCorrect(): Promise<void> {
  const txt = correctText.value.trim()
  const pid = askAns.value && askAns.value.projectId
  if (!txt || !pid || correctBusy.value) return
  correctBusy.value = true
  correctErr.value = ''
  try {
    const r: any = await window.tegula.correctApply(txt, pid)
    if (!r || r.ok === false) {
      correctErr.value = String(r?.error || '没改成：未知原因')
      return
    }
    if (r.decisionError) {
      // 字段改了、台账没记上 —— 这种事必须让人看见，不能只报"成功"
      correctErr.value = `字段已经改了，但决策卡没记上：${r.decisionError}`
    }
    closeCorrect()
    // 相关视图即时刷新：项目详情页读的是 loadProjects，答案重查一遍（同一句问题）
    projects.value = await window.tegula.loadProjects()
    await runAsk()
    const before = String(r.before ?? '')
    const args = { projectId: r.projectId, field: r.field, before, decisionId: r.decisionId || '' }
    offerUndo('已改' + String(r.echo || ''), async () => {
      const back: any = await window.tegula.correctUndo(toPlain(args))
      if (!back || back.ok === false) throw new Error(back?.error || '改不回去了')
      projects.value = await window.tegula.loadProjects()
      await runAsk()
      if (back.decisionError) showToast(`字段改回去了，但决策卡没标撤销：${back.decisionError}`, 'error')
    })
  } catch (e: any) {
    correctErr.value = '纠偏异常：' + (e?.message || e)
  } finally {
    correctBusy.value = false
  }
}

// 出单（2026-10-22 · 03 任务三）：从台账派生下一批卡。一次调用 = 一批，绝不循环。
const batchBusy = ref(false)
async function runBatch(): Promise<void> {
  const pid = askAns.value && askAns.value.projectId
  if (!pid || batchBusy.value) return
  batchBusy.value = true
  try {
    const r: any = await window.tegula.llmPlanBatch(pid)
    if (!r || r.ok === false) {
      showToast(`没出成：${(r && r.error) || '未知原因'}`, 'error')
      return
    }
    const n = (r.created || []).length
    showToast(`已出 ${n} 张「待审批」卡 —— 看板筛待审批过目后转正${aiUsageTail(r.usage)}`, 'success')
    // 让看板立刻能看到琥珀色草稿卡（否则用户以为没成）
    await loadAll()
  } catch (e: any) {
    showToast('出单异常：' + (e?.message || e), 'error')
  } finally {
    batchBusy.value = false
  }
}

const views = [
  { id: 'active', label: '看板' },
  // 「问」一个字没人看得懂（2026-10-22 暮雨原话）—— 两个字的「问答」才一眼明白这页是干什么的
  { id: 'ask', label: '问答' },
  { id: 'todos', label: '待办' },
  // 想法（2026-10-22 · 暮雨：「随手记一个念头，之后决定做/不做/搁置，现有待办/日志/任务都放不下」）
  // 页面紧挨「待办」：两者是同一件事的两个阶段（念头 → 要做的事）
  { id: 'ideas', label: '想法' },
  { id: 'logs', label: '日志' },
  { id: 'projects', label: '项目' },
  { id: 'blockers', label: '阻塞' },
  { id: 'roadmap', label: '路线图' },
  { id: 'calendar', label: '日历' },
  { id: 'archive', label: '归档' },
  { id: 'trash', label: '回收站' },
  { id: 'launchpad', label: '启动台' },
  { id: 'decisions', label: '决策' },
  { id: 'skills', label: '技能' },
  { id: 'services', label: '服务' },
]
/** 视图表（含**非页签**视图）—— 2026-10-12：`help` 只走顶栏「?」入口，
    不在页签行里再放一个重复的（页签行已经 13 个）。
    但 `curViewLabel` 与视图分支都按 id 查表，所以它必须在这里。 */
const ALL_VIEWS = [...views, { id: 'help', label: '帮助手册' }]

// ── 顶栏「更多」：低频页签折叠（2026-10-25 暮雨）──────────────────────────
// 原话：「帮我搞个更多菜单，该折叠的就折叠。我认为"技能""服务""启动台"都可以收起来，
//        至少对我而言是低频功能。或者后续改成用户可以自己设置哪些功能折叠，最少维持 7 个功能按钮在场。」
//
// 所以两件都做了：① 默认收三个低频页签；② 设置里可自己勾（含「至少 7 个在场」这道护栏）。
// ⚠ 当前视图若在被折叠里，「更多」按钮显示它的名字并高亮 —— 不能让人"不知道自己现在在哪一页"。
const VIEWS_COLLAPSED_KEY = 'fc_views_collapsed'
/** 顶栏至少留几个页签在外面（暮雨定的下限，也是护栏） */
const VIEWS_MIN_VISIBLE = 7
/** 默认收起：他点名的三个低频功能 */
const DEFAULT_COLLAPSED_VIEWS = ['launchpad', 'skills', 'services']

const collapsedViews = ref<string[]>(readUiPref<string[]>(VIEWS_COLLAPSED_KEY, DEFAULT_COLLAPSED_VIEWS))
const moreOpen = ref(false)
/** 顶栏上直接显示的页签 */
const visibleViews = computed(() => views.filter(v => !collapsedViews.value.includes(v.id)))
/** 收在「更多」里的页签 */
const moreViews = computed(() => views.filter(v => collapsedViews.value.includes(v.id)))
/** 当前停在被折叠的页签里？（决定「更多」按钮显不显示它的名字） */
const curViewInMore = computed(() => moreViews.value.some(v => v.id === curView.value))

function pickMoreView(id: string): void {
  moreOpen.value = false
  switchView(id)
}

/**
 * 勾/取消勾一个页签在顶栏的可见性。
 * 护栏：收起来之后顶栏至少还得有 `VIEWS_MIN_VISIBLE` 个 —— 否则"折叠"会把工具藏没。
 */
function onViewVisibleChange(id: string, ev: Event): void {
  const wantVisible = (ev.target as HTMLInputElement).checked
  const next = wantVisible
    ? collapsedViews.value.filter(x => x !== id)
    : Array.from(new Set([...collapsedViews.value, id]))
  const visibleCount = views.length - next.length
  if (visibleCount < VIEWS_MIN_VISIBLE) {
    // 说清为什么不行 + 现在几个 —— 直接拒绝，不改状态（复选框由 :checked 回弹）
    showToast(`顶栏至少留 ${VIEWS_MIN_VISIBLE} 个页签（收起后就只剩 ${visibleCount} 个）—— 先放回几个再收`, 'error')
    return
  }
  collapsedViews.value = next
  saveUiPref(VIEWS_COLLAPSED_KEY, next)
}

/**
 * 从「更多」菜单直达 设置 → 通用 → 顶栏页签。
 * 2026-10-25：原来那段说明是**纯文本**摆在菜单底部（把浮层撑长，暮雨否掉）；
 * 改成菜单项后它至少真能点 —— 顺带把「勾哪些收起」这件事带到用户眼前。
 */
function openViewsSetting(): void {
  moreOpen.value = false
  settingsTab.value = 'general'
  saveUiPref('fc_settings_tab', 'general')
  showSettings()
}

function resetCollapsedViews(): void {
  collapsedViews.value = [...DEFAULT_COLLAPSED_VIEWS]
  saveUiPref(VIEWS_COLLAPSED_KEY, collapsedViews.value)
  showToast('已恢复默认：收起「启动台 / 技能 / 服务」', 'success')
}
/** 关于页等地方显示中文页签名 —— 直接把 curView（active/projects…）印给用户是术语 */
const curViewLabel = computed(() => ALL_VIEWS.find(v => v.id === curView.value)?.label || curView.value)

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
  // 信息卡墙（2026-10-10，卡 20261010-003）：与列表视图同理，共用 #board 容器，
  // 只换排列方向与滚动轴（横排 → 纵滚的网格）。
  'cards-mode': isBoardView.value && boardView.value === 'cards',
}))

// Normalize project field: array → first element, or empty string
function normProject(p: any): string {
  if (!p) return ''
  if (Array.isArray(p)) return p[0] || ''
  return p
}

// filteredTasks defined after archiveTask below

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

/**
 * 每个项目头上压着几条阻塞（阻塞源按它自己所属的项目计）。
 *
 * ⚠ 数据源从 `blockerChains` 换成 `blockers`（findBlockers）：前者只在
 * loadViewData('blockers') 时才加载 —— 用户没进过「阻塞」页签时它恒为空，
 * 项目页的「⚠ N 个阻塞源」于是永远不显示（假 0）。findBlockers 走 loadAll
 * 每次都拉，且返回形状同源（ipc.ts 把 getBlockerChains().map 成 {id,title,blockers}）。
 */
const pvBlocked = computed<Record<string, number>>(() => {
  const byId = new Map(tasks.value.map(t => [t.id, t]))
  const out: Record<string, number> = {}
  for (const c of blockers.value) {
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

/** 详情页完成度百分比：与状态分布条同源（projectStats 的任务计数），0 卡时为 0（界面显示空态环） */
const pvPct = computed(() => {
  const p = pvCurrent.value
  if (!p || !p.taskCount) return 0
  return Math.round((p.completedTasks / p.taskCount) * 100)
})

/** 主从视图左侧选中的项目（默认第一个；不写 prefs —— 记一个可能消失的项目 id 没意义） */
const pvSelected = ref<string>('')
const pvCurrent = computed(() =>
  projectStats.value.find(p => p.id === pvSelected.value) || projectStats.value[0] || null)

/**
 * 项目三字段（状态 / 路线图 / 说明）的就地编辑态（2026-10-22 · 施工单包 06）。
 *
 * 为什么不做成弹窗 / 设置页：06 单红线「一个入口一个动作，不加设置页不加确认弹窗链」。
 * 打开时把**打开那一刻**的值另存一份（`noteEditBase`）—— 保存只提交真改过的字段；
 * 撤销靠主进程回传的 `before` 再写回一次，全程不需要前端猜原值。
 */
const noteEdit = ref<{ id: string; name: string; 状态: string; 路线图: string; 说明: string } | null>(null)
const noteEditBase = ref<Record<string, string>>({})
const noteSaving = ref(false)
const NOTE_FIELDS: readonly string[] = ['状态', '路线图', '说明']

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
      // 说明（2026-10-16 批次第 2 项）：13 份项目说明转正，详情页一句话定位
      note: p['说明'] || '',
      // 2026-10-22 · 06 单：状态 / 路线图 与说明一起在详情页显示并可就地改
      statusNow: p['状态'] || '',
      roadmap: p['路线图'] || '',
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

// isOverdue 已移到 shared/time.ts（2026-10-23）—— 待办与看板共用同一个逾期判据。

/** 待办到期提示（title）：把"日期 + 可选时间 + 逾期情况"一次说清，别让用户猜。 */
function todoDueTitle(t: any): string {
  const when = [
    t.due ? '到期日：' + t.due : (t.dueTime ? '到期日：未填（时间挂今天）' : ''),
    t.dueTime ? '时间：' + t.dueTime : '',
  ].filter(Boolean).join(' · ')
  if (!when) return '没有设到期'
  if (!isOverdue(t)) return when
  // 有时分时按小时/分钟说，比"逾期 0 天"诚实
  if (t.dueTime) {
    const at = parseDueAt(t.due, t.dueTime)
    const mins = Math.floor((Date.now() - at) / 60000)
    return when + (mins < 60 ? `（已过 ${mins} 分钟）` : `（已过 ${Math.floor(mins / 60)} 小时）`)
  }
  return when + `（已逾期 ${overdueDays(t)} 天）`
}

// statusClass 已移到 shared/status.ts（阻塞视图组件要共用同一份映射，不许两份）

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
    // 数据由组件自己 onMounted 拉（views/RoadmapView.vue）—— 这里显式空着，别掉到 else 白跑 loadAll
  } else if (v === 'todos') {
    loadTodos()
  } else if (v === 'ideas') {
    // 进页面就取：想法是这一页的全部内容，不加载等于开出一张白纸
    loadIdeas()
  } else if (v === 'logs') {
    loadLogs()
  } else if (v === 'ask') {
    // 常用问题从主进程拿（懒加载一次就够，presets 是静态表）
    if (!askPresets.value.length) void loadAskPresets()
    // 月报表每次都重读：花销是会变的数，界面上的旧数比没有数更误导
    void loadUsageMonths()
    void loadBalanceStatus()
  } else if (v === 'trash') {
    // 回收站不加载任务列表（顶栏计数显示「—」是刻意的，见 countText 注释）；
    // 列表本身由组件 onMounted 拉（views/TrashView.vue）
  } else if (v === 'skills') {
    // 数据由组件自己 onMounted 拉（views/SkillsView.vue）—— 这里显式空着，别掉到 else 白跑 loadAll
  } else if (v === 'services') {
    // 数据由组件自己 onMounted 拉（views/ServicesView.vue）—— 这里显式空着，别掉到 else 白跑 loadAll
  } else if (v === 'help') {
    // 帮助手册是纯静态页：不拉任何数据（走了 else 分支会白跑一次 loadAll）。
  } else if (v === 'decisions') {
    // 决策视图的数据由组件自己 onMounted 拉（`components/DecisionBoard.vue`）。
    // 这里必须**显式**列出来：掉到 else 会白跑一次 loadAll（同 help 那条教训）。
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
    // 监控台要显示的「最近执行日志 / 僵尸卡」（2026-10-11，P0 两件）—— 同一条纪律：
    // **凡界面要显示的派生状态，进门就得加载**。否则用户不先进一次日志页，监控台那两格就是空的
    // （「状态字段懒加载 = 界面说假话」这条教训 2026-09-29 已经吃过一次）。
    void loadLogs()
    void loadStalled()
    // 建议动作 / 可并行机会（死通道 A 组收口）＋ 跨项目建议：进门就拉 —— 同一条纪律，别等用户点
    void loadPvInsights()
    void loadCrossSuggest()
    // 在途一屏（Q2）：进门就按需拉一次 —— 同 2026-09-29 那条教训（状态字段懒加载 = 界面说假话），
    // 只在用户已经切到这一摆法时才拉，省得每次进项目页都付一次 git 的钱。
    if (pvView.value === 'trip') void loadTripBoard()
    // 自仓同步状态（2026-10-21 · W1-1C）：同一条纪律 —— 进门就拉，别让「待同步」等到用户点刷新
    void loadSelfSync()
    // 路线文档实况（W1-批次 2）：进门重拉一次（主进程按 仓库+日期 缓存，命中不跑 git，很便宜）。
    // ⚠ 光靠 pvCurrent.id 的 watcher 不够：同一个项目重进页面时 id 没变，watcher 不触发 ——
    //   那就会一直显示进页面那一刻的旧值（"状态字段懒加载"的变体）。
    void loadProjectDocs()
  } else if (v === 'active' || v === 'archive') {
    loadAll()
    // 读卡记录进门就拉（卡 20261025-006 第三件）—— 同"派生状态懒加载 = 界面说假话"那条纪律：
    // 筛选浮层里那个「没人碰过 N」不能等到用户点开面板才有数字。
    void loadNeverRead()
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
  // 收起所有浮层（2026-09-26 实测）：手搓菜单只认自己那层遮罩的点击，
  // 键盘/程序化跳转时会把上一个页签的菜单留在屏幕上，像"卡住的浮层"。
  // ⚠ 任务卡菜单（2026-10-14 起）已换成 reka-ui ContextMenu：它挂在**每张卡**上，
  //   卡片随视图切换卸载 → 菜单自己就没了，不需要在这里手动收。
  closeOtherMenu()
  closeFbar()          // 筛选面板同理：它是挂在这块地方的内联面板，换页签必须收起来
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

// ── 顶栏左侧按钮组（2026-10-12 暮雨第 4 条：首页 / 帮助手册 / 同步）───────────
/** ⌂ 首页：回看板 + 清掉搜索与筛选 —— 一记干净的复位。
 *  ⚠ 「复位」必须**真的复位**：只切视图而留着筛选，用户会以为"点了没反应"
 *    （上一个视图筛了什么，回看板还筛着什么）。 */
function goHome(): void {
  searchQuery.value = ''
  curProj.value = '__all__'
  curStatus.value = ''
  dueFilter.value = ''
  navigateTo('active')
}

/** ? 帮助：切到帮助手册视图（视图内渲染，不引外部 HTML） */
function goHelp(): void {
  navigateTo('help')
}

/** ⟳ 同步：一键 Git 推送（复用既有 backup:gitPush 通道）。
 *  暮雨 2026-10-12：「只做按钮，状态由它自己报」—— 所以不做配置向导，
 *  但**也不许静默失败**：未配置 / 失败都要在按钮的 title 与提示条上说清。
 *
 *  2026-10-25 卡 004（暮雨第 8 条）：「Git 同步转圈依然很抽象…全世界那么多软件
 *  没见过这样整个按钮拿去旋转的」。这一轮把按钮改成**状态胶囊**：
 *    idle `⟳` → busy `⟳ 推送 3s`（阶段来自主进程真实上报）→ `✓ 已同步`（3 秒后回图标）
 *  两条不肯让步的：① 不编百分比；② 阶段不许渲染层按时间猜。 */
const syncBusy = ref(false)
const syncResult = ref<{ ok: boolean; msg: string; at: number } | null>(null)
/** 主进程上报的当前阶段（认不出就留空 → 界面显示「同步中」而不是瞎编一个阶段） */
const syncPhase = ref<string>('')
/** 本地真实计时（毫秒） */
const syncElapsedMs = ref(0)
/** 结束态：true/false 停留 3 秒后回图标 */
const syncFinal = ref<boolean | null>(null)
let syncT0 = 0
let syncSecTimer: number | null = null
let syncRevertTimer: number | null = null
let syncOffProgress: null | (() => void) = null

const syncCapsule = computed(() => {
  if (syncBusy.value) return syncCapsuleText(syncPhase.value, syncElapsedMs.value)
  if (syncFinal.value !== null) return syncDoneText(syncFinal.value)
  return ''
})
const syncGlyph = computed(() => {
  if (syncBusy.value) return '⟳'
  if (syncFinal.value === true) return '✓'
  if (syncFinal.value === false) return '⚠'
  return '⟳'
})
const syncBtnClass = computed(() => ({
  syncing: syncBusy.value,
  cap: syncCapsule.value !== '',
  'sync-ok': syncFinal.value === true,
  'sync-bad': syncFinal.value === false,
}))
const syncTooltip = computed(() => {
  if (syncBusy.value) {
    const secs = Math.floor(syncElapsedMs.value / 1000)
    return `正在${syncPhaseLabel(syncPhase.value)}… 已 ${secs} 秒（推到 Git 仓库）`
  }
  const r = syncResult.value
  if (!r) return '同步：把数据一键推送到你配好的 Git 仓库'
  return '同步' + (r.ok ? '成功' : '失败') + '：' + r.msg + '（' + formatDateTime(new Date(r.at).toISOString()) + '）'
})

/** 收计时器与阶段订阅 —— 三条出清路径（成功/失败/组件走了）都得过这里，别越挂越多 */
function stopSyncTimers(): void {
  if (syncSecTimer !== null) { window.clearInterval(syncSecTimer); syncSecTimer = null }
  if (syncOffProgress) { try { syncOffProgress() } catch { /* 桥已断 */ } syncOffProgress = null }
}

async function runSync(): Promise<void> {
  if (syncBusy.value) return
  // 上一轮的结束态可能还挂着（3 秒窗口内又点了一次）—— 先清掉，别顶着「已同步」开始新一轮
  if (syncRevertTimer !== null) { window.clearTimeout(syncRevertTimer); syncRevertTimer = null }
  syncFinal.value = null
  syncPhase.value = ''
  syncElapsedMs.value = 0
  syncT0 = Date.now()
  syncBusy.value = true
  // 500ms 一跳：秒数要"看得出在动"，但不必每帧重渲染
  syncSecTimer = window.setInterval(() => { syncElapsedMs.value = Date.now() - syncT0 }, 500)
  // 订阅阶段流。旧主进程没有这条通道 → 不报错、也不编阶段，界面老老实实是「同步中 + 秒数」
  try {
    const api: any = window as any
    if (typeof api?.tegula?.onSyncProgress === 'function') {
      syncOffProgress = api.tegula.onSyncProgress((p: any) => {
        if (isSyncPhase(p?.phase)) syncPhase.value = String(p.phase)
      })
    }
  } catch { syncOffProgress = null }
  try {
    const r: any = await (window as any).tegula.backupGitPush()
    // 主进程返回形状不统一（有 ok/message，也有 {error}）：两种都认，别把失败说成成功。
    const ok = r?.ok === true
    const msg = r?.message || r?.error || (ok ? '已推送' : '未推送（可能还没配好仓库）')
    syncResult.value = { ok, msg, at: Date.now() }
    showToast((ok ? '同步成功：' : '同步未完成：') + msg, ok ? 'success' : 'error')
    syncFinal.value = ok
  } catch (e: any) {
    const msg = e?.message || String(e)
    syncResult.value = { ok: false, msg, at: Date.now() }
    showToast('同步失败：' + msg, 'error')
    syncFinal.value = false
  } finally {
    syncBusy.value = false
    stopSyncTimers()
    // 结束态留 3 秒给人看见，再回图标（不回的话按钮永远停在「已同步」，看不出是新的一次）
    syncRevertTimer = window.setTimeout(() => {
      syncFinal.value = null
      syncPhase.value = ''
      syncRevertTimer = null
    }, 3000)
  }
}

/** 跨项目建议（卡住 / 空闲项目），项目页顶部那条 */
const crossSuggest = ref<string[]>([])

async function loadCrossSuggest(): Promise<void> {
  try {
    const r: any = await (window as any).tegula.suggestCrossProject()
    crossSuggest.value = Array.isArray(r) ? r : []
  } catch { crossSuggest.value = [] }
}

// 路线图的三个东西（roadmapData / roadmapMilestones / loadRoadmap / roadmapHealthLabel）
// 已于 2026-10-23 整块搬进 views/RoadmapView.vue（拆分第 1 批第 7 块）。

async function loadProjectProgressMap() {
  try {
    // 一次 IPC 拿全部项目进度。原先逐项目 await = 项目数 × 全量扫描，
    // 12 个项目在 5000 任务档要 13.9s（压测数据），现在是 1 次扫描。
    projectProgress.value = await window.tegula.allProjectProgress()
  } catch {
    projectProgress.value = {}
  }
}

// 回收站整块（视图 + 两个弹窗 + 240 行脚本）已于 2026-10-23 搬进 views/TrashView.vue。

// 技能安装专区（技能清单 / 装到 Hermes / 导入外部技能 / 装到别的 agent / MCP 接入材料）
// 已于 2026-10-23 整块搬进 views/SkillsView.vue（拆分第 1 批第 6 块）。
// 它要四个注入项：toast / copy（copyWithToast）/ pulse（拖拽心跳）/ dragAlive（遮罩跟心跳一起消失）——
// 后两个必须由本文件给：心跳是 todo/log/skills 三个投放区共用的，各造一份会"那边拖完这边遮罩留着"。

// ── 服务 / 端口（2026-09-26 卡 006）────────────────────────────────────
// 用户选的口径是 A 档：**只读监控 + 冲突预警**。这里没有任何"结束进程"入口 ——
// 别顺手加，那是用户明确排除的（且本仓有铁律：不许按镜像名批量杀进程）。
// 服务/端口页的状态与逻辑已整块搬进 views/ServicesView.vue（2026-10-23 · 第 5 块）。
// 这块引用全在本页、零弹窗、唯一外部能力是 showToast（用 prop 传进去）。
// ⚠ 它自己 onMounted 里加载 —— 下面 loadViewData 的 'services' 分支必须显式空掉，
//   否则切页会拉两遍（同 help / decisions 那两条教训）。


// ── 顶栏「刷新」：重读全部数据（2026-10-25 暮雨）──────────────────────────
// 为什么要它：方寸的数据是**白盒文件**（task-data/*.md、日志、待办 json）——
// agent 经 MCP 写卡、你手改 md、git pull 下来别人的提交，这些改动界面根本不会自己知道。
// 以前只能靠"切个视图"或"做一次操作"碰运气触发重读；碰不到就一直看着旧数据（= 界面说假话）。
const refreshBusy = ref(false)
async function refreshAllData(): Promise<void> {
  if (refreshBusy.value) return
  refreshBusy.value = true
  const t0 = Date.now()
  const failed: string[] = []
  // ⚠ 一步一记账：某一份数据坏了不该让整套刷新失败，但也**不许静默跳过**（最后点名）。
  const step = async (name: string, fn: () => any): Promise<void> => {
    try { await fn() } catch (e: any) { failed.push(`${name}（${e?.message || e}）`) }
  }
  try {
    await step('任务与项目', () => loadAll())
    await step('日志', () => loadLogs())
    await step('待办', () => loadTodos())
    await step('想法', () => loadIdeas())
    await step('方针与结构地图', () => loadPolicyMap())
    await step('阻塞链', () => loadBlockerChains())
    await step('通知中心', () => ncLoad())
    const ms = Date.now() - t0
    if (failed.length) showToast(`刷新完成，但 ${failed.length} 项失败：${failed.join('；')}`, 'error')
    else showToast(`已重读全部数据（${ms}ms）`, 'success')
  } finally {
    refreshBusy.value = false
  }
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
  // 返工台的天数按"现在"算（不要用挂载那一刻的 now，否则开一天窗口会显示旧天数）
  reworkNow.value = Date.now()
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
  // 批量改状态最容易"手滑一整屏"：先记下每张卡的原来那一格（2026-10-30 第 5 条）
  const before = new Map<string, string>()
  for (const id of ids) {
    const s = String((tasks.value.find((x: any) => x.id === id) || {}).status || '')
    if (s) before.set(id, s)
  }
  const result = await window.tegula.batchEdit(ids, { status })
  if (result.fails.length === 0) {
    showToast(`已将 ${result.ok} 个任务设为「${status}」`, 'success')
  } else {
    showToast(`${result.ok} 成功，${result.fails.length} 失败`, 'error')
  }
  if (before.size) {
    offerUndo(`批量设为「${status}」（${before.size} 个）`, async () => {
      let ok = 0
      for (const [id, prev] of before) {
        try {
          const r: any = await window.tegula.moveStatus(id, prev)
          if (r?.ok) ok++
        } catch { /* 单条失败不中断 */ }
      }
      await loadAll()
      if (ok !== before.size) showToast(`只撤回了 ${ok}/${before.size} 个（其余可能已被改动）`, 'error')
      else showToast(`已撤回：${ok} 个回到原状态`, 'success')
    })
  }
  selectedBatch.value = []
  batchMode.value = false
  naturalResults.value = []
  isNaturalQuery.value = false
  loadAll()
}

/* ── 批量改期（2026-10-18 Bundle A「超期任务批量改期」）────────────────────
 * 典型路径：顶栏日期筛选「超期」→ 批量模式 → 全选 → 📅 改期 → 一次推走。
 * 通道沿用 batchEdit → updateTask：fm.deadline 直改、乐观锁防并发、logActivity 逐条留痕。
 * 改期可随时再改回，非破坏性，不做二次确认；超期筛选（dueFilter='overdue'）本身
 * 就不含完成/驳回卡，这里不再重复拦终态。日期只认本地日历日 YYYY-MM-DD
 * （calISO，不走 toISOString 免时区把日期挪一天）。 */
const batchPostponing = ref(false)
const batchPostponeDate = ref('')

function openBatchPostpone() {
  batchPostponing.value = true
  // 预填「今天 + 7」：最高频动作是把一堆过期卡整体推一周，别让用户每次从空日期选起
  batchPostponeDate.value = calISO(addDays(new Date(), 7))
}

/** 本地日历日 +N 天 → 'YYYY-MM-DD' */
function batchPostponeShift(n: number): string {
  return calISO(addDays(new Date(), n))
}

async function batchPostpone(dateStr: string) {
  const s = String(dateStr || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    showToast('先选一个日期再确定', 'error')
    return
  }
  if (selectedBatch.value.length === 0) return
  const ids = [...selectedBatch.value]
  const result = await window.tegula.batchEdit(ids, { deadline: s })
  if (result.fails.length === 0) {
    showToast(`已把 ${result.ok} 个任务的截止日改到 ${s}`, 'success')
  } else {
    showToast(`${result.ok} 个成功，${result.fails.length} 个失败（如：${result.fails[0]?.error || '未知'}）`, 'error')
  }
  batchPostponing.value = false
  selectedBatch.value = []
  batchMode.value = false
  naturalResults.value = []
  isNaturalQuery.value = false
  loadAll()
}

/** 归档区里某个状态有几条（只数**当前列表里看得见的** —— 用户看到的和选中必须同一批） */
function archiveStatusCount(status: string): number {
  return filteredTasks.value.filter(t => String(t.status || '') === status).length
}

/** 该状态的卡是否**全部**都在选择集里 —— 快选按钮点亮就靠它（点亮 = 再点一下是取消这一组） */
function archiveStatusAllSelected(status: string): boolean {
  const ids = filteredTasks.value
    .filter(t => String(t.status || '') === status)
    .map(t => t.id)
  return ids.length > 0 && ids.every(id => selectedBatch.value.includes(id))
}

/**
 * 一键选中归档区里某个状态的全部任务（2026-10-17 暮雨第 1 条；第 2 条改**叠加**语义）。
 * 首版是 `selectedBatch.value = ids` 整桶替换 —— 点「完成」再点「待办」，完成那组就被冲掉了，
 * 用户原话「每次至多只能批量选一组，其他的都被自动取消勾选」。邮箱/网盘的通用语言是：
 * 勾选是叠加的，点同一个组两下 = 取消该组，其他组原样保留。照这个改。
 * ⚠ 只动**当前筛选后可见**的那批：搜索框或项目筛选还在生效时，选中范围必须与眼前一致，
 *   否则用户会删掉自己没看见的东西。
 */
function selectArchiveByStatus(status: string): void {
  const ids = filteredTasks.value
    .filter(t => String(t.status || '') === status)
    .map(t => t.id)
  if (!ids.length) return
  if (archiveStatusAllSelected(status)) {
    // 再点一下 = 只取消这一组；上一批选的其他状态原样保留
    selectedBatch.value = selectedBatch.value.filter(id => !ids.includes(id))
    showToast(`已取消选中全部「${status}」任务（其他选择保留）`, 'info')
    return
  }
  batchMode.value = true
  const add = ids.filter(id => !selectedBatch.value.includes(id))
  selectedBatch.value = [...selectedBatch.value, ...add]
  showToast(`已选中 ${selectedBatch.value.length} 个任务 —— 用上方批量栏删除或改状态（再点「${status}」可取消这组）`, 'success')
}

/** 邮箱式全选方框（2026-10-17 暮雨第 2 条）：三态 —— 全选（勾）/ 部分选中（横线 indeterminate）/ 空。
 *  范围 = 当前筛选后可见的归档任务，与快选按钮同一口径（看到的和选中的必须是同一批）。 */
const archiveAllSelected = computed(() =>
  filteredTasks.value.length > 0 &&
  filteredTasks.value.every(t => selectedBatch.value.includes(t.id)))
const archiveSomeSelected = computed(() =>
  !archiveAllSelected.value &&
  filteredTasks.value.some(t => selectedBatch.value.includes(t.id)))
function toggleArchiveSelectAll(): void {
  const ids = filteredTasks.value.map(t => t.id)
  if (archiveAllSelected.value) {
    // 全不选：只摘掉可见的这批，不动用户在别的视图攒下的选择（口径与快选一致）
    selectedBatch.value = selectedBatch.value.filter(id => !ids.includes(id))
  } else {
    batchMode.value = true
    selectedBatch.value = Array.from(new Set([...selectedBatch.value, ...ids]))
  }
}

async function executeBatchArchive() {  const ids = [...selectedBatch.value]
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
  if (!confirm(`批量删除 ${ids.length} 个任务？\n\n会移进回收站（task-data/.trash），需要时能还原。`)) return
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

/**
 * 清空搜索框 = 退出自然查询（2026-10-23 修，被断言抓出来的真 bug）。
 *
 * 原行为：只有「光标在框里再按一次回车」才会走到上面那个 `if (!q)` 分支重置。
 * 用户按 Esc 或直接删掉关键字后，`isNaturalQuery` 还挂着 true、`naturalResults` 还非空，
 * 于是 `filteredTasks` 第一行直接把板子锁死在"自然查询那几张卡"上 ——
 * 界面上**没有任何提示**，看起来就像"别的卡被删了"。这类静默收窄最难排查。
 */
watch(searchQuery, (v) => {
  if (!String(v || '').trim() && isNaturalQuery.value) {
    isNaturalQuery.value = false
    naturalResults.value = []
  }
})

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
  // 空字符串选项给一个可读标签：像「返工归因」这种"留空 = 不是返工"的字段，
  // 直接渲染会得到一个空白选项，人不知道那是"不填"还是"没加载出来"。
  return (spec.options || []).map((o: string) => ({ value: o, label: o || '（留空）' }))
}

function openNew() {
  editTask_.value = emptyTaskForm()
  taskEditSnap = snapOf(editTask_.value)   // P0-1：关窗按「改没改」判
}

// ── 快速记（2026-10-11，卡 20261006-002 E 组死通道接回）─────────────────────
// `quickAdd(text)` 在主进程里躺了很久，界面从来没有入口。它支持一句话简写，
// 随手记一条比开弹窗填六个字段顺手得多。
const quickAddOpen = ref(false)
const quickAddText = ref('')
const quickAddErr = ref('')
const quickAddBusy = ref(false)

function openQuickAdd(): void {
  quickAddText.value = ''
  quickAddErr.value = ''
  quickAddOpen.value = true
}

function closeQuickAdd(): void {
  // 有内容就先问一声（与任务/日志编辑器、接力同一套防丢纪律）
  if (quickAddText.value.trim() && !confirm('快速记的内容还没创建，确定丢弃吗？')) return
  quickAddOpen.value = false
  quickAddText.value = ''
  quickAddErr.value = ''
}

async function submitQuickAdd(): Promise<void> {
  if (quickAddBusy.value) return
  const text = quickAddText.value.trim()
  if (!text) return
  quickAddBusy.value = true
  quickAddErr.value = ''
  try {
    const r: any = await (window as any).tegula.quickAdd(text)
    if (!r?.ok) {
      // ⚠ 保持对话框开着并把原因摆在眼前（简写写错时要能改），不静默关掉
      quickAddErr.value = r?.error || '创建失败（主进程没有返回原因）'
      return
    }
    showToast(`已创建 ${r.id || '新任务'}`, 'success')
    quickAddOpen.value = false
    quickAddText.value = ''
    await loadAll()
  } catch (e: any) {
    quickAddErr.value = '创建异常：' + (e?.message || e)
  } finally {
    quickAddBusy.value = false
  }
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
  resetTaskHistory()
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
function taskEditDirty(): boolean {
  if (taskEditSnap !== null) return snapOf(editTask_.value) !== taskEditSnap
  return isDirtyFields(editTask_.value, ['title', 'blockers', 'memo', 'body', 'tags'])
}

/** 关闭任务编辑器：**改过**才问（遮罩按下 @mousedown.self 也走这里）。 */
function closeTaskEditor() {
  if (taskEditDirty() && !confirm('编辑内容尚未保存，确定关闭并丢弃吗？')) return
  editTask_.value = null
  taskEditSnap = null
}

// makeDirtyGuard / snapOf 已抽到 renderer/dirtyGuard.ts（2026-10-23）—— 组合式函数也要用。
const policyGuard = makeDirtyGuard()
const projGuard = makeDirtyGuard()
const appGuard = makeDirtyGuard()
// todoGuard 已随待办编辑弹窗搬进 composables/useTodos.ts（2026-10-23）

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
      // 2026-10-30 暮雨第 5 条：编辑保存也要能撤（不是所有改动都叫"改状态"）。
      const cur: any = tasks.value.find((x: any) => x.id === e.id)
      const prev: any = {}
      if (cur) {
        for (const spec of taskFieldSpecs.value) {
          if (spec.key === 'body') { prev.body = cur.body ?? ''; continue }
          const v = cur[spec.key] ?? cur.fm?.[spec.key]
          if (spec.type === 'tags' || spec.type === 'list') {
            prev[spec.key] = Array.isArray(v) ? v.slice() : (v ? String(v).split(',').map((s: string) => s.trim()).filter(Boolean) : [])
          } else {
            prev[spec.key] = v === undefined || v === null ? '' : String(v)
          }
        }
      }
      await window.tegula.editTask(e.id, payload)
      if (cur) {
        offerUndo(`已编辑任务「${e.title || e.id}」`, async () => {
          const r: any = await window.tegula.editTask(e.id, prev)
          if (!r?.ok) throw new Error(r?.error || '写回失败')
          await loadAll()
          showToast('已撤回这次编辑', 'success')
        })
      }
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

function resetTaskHistory(): void {
  taskHistoryOpen.value = false
  taskVersions.value = []
  taskVersionPreview.value = null
  taskVersionBusy.value = false
}

async function toggleTaskHistory(): Promise<void> {
  if (taskHistoryOpen.value) { taskHistoryOpen.value = false; return }
  const e = editTask_.value
  if (!e?.id) return
  taskHistoryOpen.value = true
  taskVersionPreview.value = null
  taskVersionBusy.value = true
  try {
    const vs: any = await window.tegula.tasksVersions(e.id)
    taskVersions.value = Array.isArray(vs) ? vs : []
  } catch (err: any) {
    taskVersions.value = []
    showToast(`读取历史版本失败：${err?.message || err}`, 'error')
  } finally {
    taskVersionBusy.value = false
  }
}

async function previewTaskVersion(v: any): Promise<void> {
  const e = editTask_.value
  if (!e?.id || !v?.file) return
  taskVersionBusy.value = true
  try {
    const r: any = await window.tegula.tasksVersionGet(e.id, v.file)
    if (!r?.ok) { showToast(`预览失败：${r?.error || '未知原因'}`, 'error'); return }
    taskVersionPreview.value = r.data
  } catch (err: any) {
    showToast(`预览异常：${err?.message || err}`, 'error')
  } finally {
    taskVersionBusy.value = false
  }
}

async function restoreTaskVersionItem(v: any): Promise<void> {
  const e = editTask_.value
  if (!e?.id || !v?.file) return
  const when = v.at ? formatDateTime(v.at) : '这个版本'
  const dirtyTip = taskEditDirty() ? '\n\n⚠ 表单里还没保存的改动会被这一版覆盖。' : ''
  if (!confirm(`恢复到「${v.title || '(无标题)'}」（${when}）？\n\n卡片字段与正文都会回到那一版。\n当前版本会先自动备份，撤错了可以再恢复回来。${dirtyTip}`)) return
  try {
    const r: any = await window.tegula.tasksRestoreVersion(e.id, v.file)
    if (!r?.ok) { showToast(`恢复失败：${r?.error || '未知原因'}`, 'error'); return }
    const fresh: any = await window.tegula.taskFormValues(e.id)
    editTask_.value = { ...fresh, id: e.id }
    taskEditSnap = snapOf(editTask_.value)
    taskHistoryOpen.value = false
    taskVersionPreview.value = null
    showToast(`已恢复（回到 ${when} 那一版）`, 'success')
    await loadAll()
  } catch (err: any) {
    showToast(`恢复异常：${err?.message || err}`, 'error')
  }
}

async function deleteTask(id: string) {
  if (!confirm('确定删除此任务？\n会移入 task-data/.trash，可人工找回。')) return
  // 主进程这次可能抛异常（历史上：目标同名文件已存在于 .trash → renameSync 抛 →
  // 这里没有 try/catch → 按钮点了完全没反应，用户 2026-09-25 第 5 条）。
  // 任何失败都必须变成看得见的一句话 + 日志留痕。
  const snap = snapOfTask(id)
  const title = String(tasks.value.find((x: any) => x.id === id)?.title || id)
  try {
    const result = await window.tegula.deleteTask(id)
    if (result) {
      previewTask.value = null
      showToast('已删除', 'success')
      loadAll()
      // 任务删除是**软删**（进 .trash），所以可撤；真正不可撤的是二次确认过的「彻底删除」。
      if (snap) {
        offerUndo(`已删除「${title}」`, async () => {
          const r: any = await window.tegula.trashRestore(`${id}.md`)
          if (!r?.ok) throw new Error(r?.error || '回收站里找不到这个文件')
          await loadAll()
          await restoreTaskSnap(id, snap)
          showToast('已从回收站还原', 'success')
        })
      }
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
  const snap = snapOfTask(t.id)
  const result = await window.tegula.archiveTask(t.id)
  if (result.ok) {
    previewTask.value = null
    showToast('已归档', 'success')
    loadAll()
    if (snap && !snap.archived) {
      offerUndo(`已归档「${t.title}」`, async () => {
        await restoreTaskSnap(t.id, snap)
        showToast('已撤回：回到归档之前', 'success')
      })
    }
  } else {
    showToast(`归档失败: ${result.error || '未知错误'}`, 'error')
  }
}

/** 非终态直达完成/驳回：挂死任务（如超时未回写）没有验收方可走，必须给终结入口 */
async function forceCloseTask(t: Task, status: '完成' | '驳回') {
  // 2026-10-30（暮雨第 2 条）：直达「驳回」也必须有地方写理由（可选），否则又回到
  // "点完再也看不见为什么"。所以驳回统一走裁决框；完成仍是一步直达。
  if (status === '驳回') { openDirectReject(t); return }
  const word = '标记完成'
  // ⚠ 2026-10-25：原文案写「留痕于结果记录」——**这是假话**。本函数只调 moveStatus，
  // 结果记录一个字都不写（只有活动日志会记一条状态变更）。用户看不到结论栏有任何东西。
  // 现在如实说清：直达 = 不写结论；要留结论请走上面的「审批裁决 / 验收裁决」。
  if (!confirm(`确认将「${t.title}」直接${word}？\n\n这是跳过裁决的直接改状态：不写结论、不填理由。\n要留下理由与依据，请用「审批裁决 / 验收裁决」。`)) return
  const snap = snapOfTask(t.id)
  const result = await window.tegula.moveStatus(t.id, status)
  if (result.ok) {
    previewTask.value = null
    showToast(`已${word}`, 'success')
    loadAll()
    if (snap) {
      offerUndo(`已${word}「${t.title}」`, async () => {
        await restoreTaskSnap(t.id, snap)
        showToast('已撤回', 'success')
      })
    }
  } else {
    showToast(`${word}失败: ${result.error || '未知错误'}`, 'error')
  }
}

async function restoreTask(t: Task) {
  const wasRejected = t.status === '驳回' || !!String((t as any).reject_reason || (t as any).reject_at || '').trim()
  if (!confirm(`确认还原「${t.title}」？\n任务将回到「待办」状态；若已归档，会一并移回活跃区。`)) return
  const snap = snapOfTask(t.id)
  const result = await window.tegula.unarchiveTask(t.id)
  if (result.ok) {
    previewTask.value = null
    showToast(wasRejected
      ? '已退回待办：agent 下次取活会先读到驳回理由并优先返工'
      : '已还原', 'success')
    loadAll()
    if (snap) {
      offerUndo(`已退回「${t.title}」`, async () => {
        await restoreTaskSnap(t.id, snap)
        showToast('已撤回：回到「' + snap.status + '」', 'success')
      })
    }
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

/** 一键完成日志：不走「填保留天数」模态，按设置里的默认保留天数完成（2026-09-29 用户第 6 条）
 *
 *  ⚠ 这是**无二次确认**的路径（任务详情里的「关联日志」列表行尾那个 ✓）：误点一下就完成。
 *  2026-10-21 暮雨第 1 条报的正是这个 —— 所以完成后必须当场给撤销条，
 *  不能只指望人回头去日志页的分区里翻那条卡（那时它已经不在眼前了）。
 */
async function quickCompleteLog(log: any) {
  const days = logRetainDefault.value
  try {
    const r = await window.tegula.logsComplete(log.id, days, '')
    if (r && !r.ok) {
      showToast(`完成失败：${r.error || '未知原因'}`, 'error')
      return
    }
    offerLogReopenUndo(days > 0 ? `已完成（保留 ${days} 天）：${log.title || log.id}` : `已完成（永不清理）：${log.title || log.id}`, [log.id], [log])
    await loadLogs()
    await loadLogsForTask(previewTask.value?.id || '')
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

// renderBody 已抽到 renderer/markdown.ts（2026-10-23）—— 回收站组件也要用它，一份就够。

const archivedTasks = ref<Task[]>([])


/**
 * 展示层优先级兜底归一。主进程 parseTask 已做过归一，这里只防历史数据里的英文残留。
 * 不要在别处再写一套映射 —— 优先级别名表在主进程 data/index.ts。
 */
// localPriority / priorityLabel 已抽到 shared/priority.ts（2026-10-23）——
// 日历组件里的 prioColor 也要用同一份映射，各写一套迟早出现"看板是红、日历是灰"。

/** 日志优先级徽章的 class key（卡 001）。ASCII 而不是直接拼中文：CSS 选择器里中文虽合法，
 *  但转义/编码链上多一个可出错的环节，值域也只需三档映射。空/未知一律给 'low'（灰、不抢眼）。 */
function logPrioKey(p: any): string {
  const v = localPriority(p)
  return v === '高' ? 'high' : v === '中' ? 'mid' : 'low'
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
  // 状态筛选（2026-10-10）：与项目筛选**叠加**，不是二选一 —— 改在这里一处收口，
  // 列 / 列表 / 信息卡墙三种摆法一起生效（它们都读 filteredTasks）。
  if (curStatus.value) {
    result = result.filter(t => String(t.status || '') === curStatus.value)
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
  // 0 引用筛选（卡 20261025-006 第三件）：口径由主进程按 shared/neverRead.ts 裁好，
  // 这里只做集合命中 —— 界面**不重算**"算不算未完成"，免得两边各有一套规矩。
  // ⚠ 读不到读卡记录时 neverReadIds 是空的：筛出来是**空板 + 生效标签**，
  //   而不是"全部合格"。空板会被 `neverReadHint` 那句"读不出来"解释掉。
  if (readFilter.value === 'never') {
    const ids = neverReadIds.value
    result = result.filter(t => ids.has(t.id))
  }
  return applySortMode(result)
})

// 看板列（2026-10-30 · 渲染层拆分第二批第一刀）：
// 分组规则已抽到 shared/grouping.ts::buildBoardColumns（纯函数，e2e-grouping 断言），
// 这里只把 ref 接进去。⚠ 必须放在 filteredTasks 之后 —— 传的是 ref 本体，
// 在它初始化前调用会撞 TDZ（整块看板直接渲染不出来）。模板搬迁（views/BoardView.vue）是下一刀。
const columns = useBoardColumns({
  tasks: filteredTasks,
  mode: groupMode,
  statuses: STATUSES,
  priorities: taskPriorities,
  nameOf: projectNameOf,
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
  void loadTaskCommits(t.id)
}

/**
 * Git 联动（卡 20260925-017，2026-10-06）—— 任务详情里的「相关提交」。
 *
 * 只读：主进程跑 `git log`（时间窗 + 提到本卡 ID 的），**不写任何仓库、不改这张卡**。
 * 读不到时**照实说**（没归属项目 / 没登记工作目录 / 不是 git 仓库），不给一句空话糊过去。
 */
const taskCommits = ref<any>(null)
const taskCommitsLoading = ref(false)
async function loadTaskCommits(taskId: string): Promise<void> {
  taskCommits.value = null
  taskCommitsLoading.value = true
  try {
    const api: any = (window as any).tegula
    const r = api?.gitTaskCommits ? await api.gitTaskCommits(taskId) : null
    taskCommits.value = r && r.ok !== false
      ? r
      : { repo: '', commits: [], mentioned: [], note: r?.error || '这台机器上的方寸没有这条通道（需要完全退出再打开，让后台一起更新）' }
  } catch (e: any) {
    taskCommits.value = { repo: '', commits: [], mentioned: [], note: '读取失败：' + (e?.message || e) }
  } finally {
    taskCommitsLoading.value = false
  }
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
 * 复制 agent 上下文包（2026-10-22）。
 *
 * 缺什么要**当场说出来**：包里少了契约/方针/决策，agent 就会以为"这项目没这些规矩"，
 * 那比不给它包还危险。所以缺项单独一条 toast（error 色），不混在"已复制"里。
 */
async function copyContextPack(p: any): Promise<void> {
  if (!p?.id) return
  try {
    const r: any = await (window as any).tegula.contextPack(p.id)
    if (!r || r.ok === false) {
      showToast(`生不成上下文包：${(r && r.error) || '未知原因'}`, 'error')
      return
    }
    const ok = await copyWithToast(String(r.text || ''), `已复制「${p.name || p.id}」的上下文包（${r.chars || 0} 字）`)
    if (ok && Array.isArray(r.missing) && r.missing.length) {
      showToast(`这包缺：${r.missing.join('、')} —— 别拿空白当结论`, 'error')
    }
  } catch (e: any) {
    showToast('生成异常：' + (e?.message || e), 'error')
  }
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

// ── 任务卡右键菜单（2026-10-14 第 ④ 步第二单：改成组件）─────────────────
// 用户反馈「方寸内右键没什么用」→ 卡上放高频操作，省得先点开详情面板再翻按钮。
// 菜单本体（含渲染与浮层行为）已搬进 `components/TaskCardMenu.vue`（reka-ui ContextMenu）；
// 这里只留"点了哪一项 → 调哪个动作"的映射 —— 动作都在本文件里，组件不该知道怎么改数据。
// ⚠ 组件通过 `@pick` 回一个 `{ task, action }`（**不是** `@pick="(a) => f(t, a)"`：
//   模板里写箭头函数会让 `check-template-bindings` 把参数当成"未声明的标识符"。
//   回一个对象 = 组件知道"哪张卡"，App 只需要知道"哪件事"。
function onCardMenuPick(p: { task: Task; action: string }): void {
  const t = p.task
  switch (p.action) {
    case 'view': void openCard(t); break
    case 'edit': void openEdit(t); break
    case 'review': void openReview(t); break
    case 'assignTime': void openCalAssignTask(t); break
    case 'copyId': void copyTaskId(t); break
    case 'copyTitle': void copyTaskTitle(t); break
    case 'copyDispatch': void copyTaskAsDispatch(t); break
    case 'archive': void archiveTask(t); break
    case 'delete': void deleteTaskById(t); break
    default:
      // 菜单里没有的项：不静默 —— 打出来，免得将来加了菜单项忘了接动作
      showToast(`右键菜单动作未接线：${p.action}`, 'error')
  }
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
// 日历：状态与算法在 composables/useCalendar.ts（第 3 块），模板在 views/CalendarView.vue（第 4 块）。
// 这个文件里只剩两件父组件的活儿：**「指派时间」弹窗**（模板在本文件）与**拖拽落盘**
// （要 IPC + toast + 重新加载）。CAL_DOW 跟着进组件了（只有日历用）。
// ⚠ taskStart/taskDue 在这里再定义一份小的：弹窗要按同一套字段回退（t.start ?? t.fm.start）
//   读时间。各写一套的话，日历画出来的时间和弹窗里显示的时间迟早对不上。
const taskStart = (t: any): Date | null => parseCalDate(t?.start ?? t?.fm?.start)
const taskDue = (t: any): Date | null => parseCalDate(t?.deadline ?? t?.fm?.deadline)

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

// ── 日历的两个副作用入口（组件 emit 过来，落盘/开窗留在本文件）─────────────
// 组件只负责"显示 + 收集意图"：点条目 / 拖拽都只 emit 一个 id 加一个目标日期，
// 真正要 window.tegula + toast + loadTodos/loadLogs 的部分全在这里。

/** 点日历上的日志条目 → 打开日志编辑框（组件只 emit id，openLog 要整个 log 对象） */
function openLogById(id: string): void {
  const log = logs.value.find((l: any) => l.id === id)
  if (log) openLog(log)
}

/**
 * 拖拽落盘（2026-10-23 从 onCalDrop 改过来：日期在组件里算完了，这里只负责写盘）。
 * ⚠ 找任务用 `filteredTasks` 而不是日历那份 `calActiveTasks` —— 后者已经进 composable，
 *   而这里只需要读 start/deadline，筛选后的集合足够（日历本来也只显示这些）。
 */
async function doCalReschedule(p: { id: string; kind: 'task' | 'todo' | 'log'; date: string }): Promise<void> {
  const { id, kind, date: target } = p
  if (!id || !target) return
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
    const t = filteredTasks.value.find((x: any) => x.id === id)
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

// ── 想法（2026-10-22 · 「随手记一个念头，之后决定做/不做/搁置」）────────────
// 界面这一层只做一件事：把「想法」和「待办/任务」的边界守住 —— 它**不参与**任何
// 筛选、排序、逾期、阻塞的口径。四态与排序的真相都在主进程 services/ideas.ts。
const ideas = ref<any[]>([])
const ideaDraft = ref('')
const ideaBusy = ref(false)
/** 「已经有结论」默认收起：这一页的主角是"还没决定的那堆"，不是历史账 */
const ideasShowDecided = ref(false)

const ideasOpen = computed(() => ideas.value.filter((i) => i.status === '新记'))
const ideasDecided = computed(() => ideas.value.filter((i) => i.status !== '新记'))

/** 状态 → CSS 后缀（四态各一个色，不许在模板里现编映射） */
function ideaStatusKey(s: string): string {
  return ({ 已立项: 'done', 已搁置: 'hold', 已否决: 'no' } as Record<string, string>)[s] || 'new'
}

async function loadIdeas(): Promise<void> {
  try {
    ideas.value = await window.tegula.ideasList()
  } catch {
    ideas.value = []
  }
}

/** 记一条。空内容按钮本来就是禁用的，这里再挡一次是因为回车也能提交 */
async function saveIdea(): Promise<void> {
  const t = ideaDraft.value.trim()
  if (!t || ideaBusy.value) return
  ideaBusy.value = true
  try {
    const r: any = await window.tegula.ideasAdd(t)
    if (!r || r.ok === false) {
      showToast(`没记上：${(r && r.error) || '未知原因'}`, 'error')
      return
    }
    // 只有真存下了才清空输入 —— 失败还清空，用户写的那句就没了（还得重打一遍）
    ideaDraft.value = ''
    await loadIdeas()
    // 重复不再另发 toast（本来就该悄无声息地不重复），只在真新增时给一句
    if (!r.duplicate) showToast('记下了', 'success')
  } catch (e: any) {
    showToast('记录异常：' + (e?.message || e), 'error')
  } finally {
    ideaBusy.value = false
  }
}

/** 改状态 + 挂撤销（一条动作一步退得回，与全站的撤销条同一套） */
async function setIdeaState(i: any, status: string, note: string, label: string): Promise<void> {
  if (ideaBusy.value) return
  ideaBusy.value = true
  try {
    const r: any = await window.tegula.ideasSetStatus(toPlain(i.id), status, note)
    if (!r || r.ok === false) {
      showToast(`没改成：${(r && r.error) || '未知原因'}`, 'error')
      return
    }
    await loadIdeas()
    const before = r.before || {}
    offerUndo(`「${firstLineOf(i.text)}」→ ${label}`, async () => {
      const back: any = await window.tegula.ideasSetStatus(toPlain(i.id), before.status, before.note || '')
      if (!back || back.ok === false) throw new Error(back?.error || '改不回去了')
      await loadIdeas()
    })
  } catch (e: any) {
    showToast('改动异常：' + (e?.message || e), 'error')
  } finally {
    ideaBusy.value = false
  }
}

function holdIdea(i: any): void {
  return void setIdeaState(i, '已搁置', i.note || '', '搁置')
}
function dropIdea(i: any): void {
  return void setIdeaState(i, '已否决', i.note || '', '不做')
}
/** 从"已决"退回"还没决定"—— 搁置的念头本来就可能被捡回来 */
function reviveIdea(i: any): void {
  return void setIdeaState(i, '新记', '', '捡回来')
}

/**
 * 「做」= 立项 = **真在待办里生出一条**。
 *
 * 界面上这里必须把"去了哪"说出来（toast 里点明待办），否则用户点完只看到这条挪到
 * 了「已经有结论」里，会怀疑到底有没有真建出来 —— 而"看起来成功了"正是最该避免的状态。
 */
async function doIdea(i: any): Promise<void> {
  if (ideaBusy.value) return
  ideaBusy.value = true
  try {
    const r: any = await window.tegula.ideasPromote(toPlain(i.id))
    if (!r || r.ok === false) {
      showToast(`没法立项：${(r && r.error) || '未知原因'}`, 'error')
      return
    }
    await loadIdeas()
    // 待办数变了 → 让待办页与看板旁边的计数跟着刷新（否则切过去看是旧的）
    void loadTodos()
    showToast(`已立项 → 待办里多了一条「${firstLineOf(i.text)}」`, 'success')
    offerUndo(`「${firstLineOf(i.text)}」→ 已立项`, async () => {
      const back: any = await window.tegula.ideasUnpromote(toPlain(i.id))
      if (!back || back.ok === false) throw new Error(back?.error || '撤不回来了')
      await loadIdeas()
      void loadTodos()
    })
  } catch (e: any) {
    showToast('立项异常：' + (e?.message || e), 'error')
  } finally {
    ideaBusy.value = false
  }
}

/** 撤销立项：待办那条一起撤（主进程负责判断"已被做完就不许撤"） */
async function undoDoIdea(i: any): Promise<void> {
  if (ideaBusy.value) return
  ideaBusy.value = true
  try {
    const r: any = await window.tegula.ideasUnpromote(toPlain(i.id))
    if (!r || r.ok === false) {
      showToast(`没撤成：${(r && r.error) || '未知原因'}`, 'error')
      return
    }
    await loadIdeas()
    void loadTodos()
    showToast('已撤回，想法回到「还没决定」', 'success')
  } catch (e: any) {
    showToast('撤销异常：' + (e?.message || e), 'error')
  } finally {
    ideaBusy.value = false
  }
}

/**
 * 删除 + 撤销。
 * 主进程把被删的那条**原样**回传，撤销就是把它插回去（原 id、原 createdAt）——
 * 撤销的语义是"当没删过"，不是"重新记一条"。
 */
async function removeIdea(i: any): Promise<void> {
  if (ideaBusy.value) return
  ideaBusy.value = true
  try {
    const r: any = await window.tegula.ideasDelete(toPlain(i.id))
    if (!r || r.ok === false) {
      showToast(`没删成：${(r && r.error) || '未知原因'}`, 'error')
      return
    }
    await loadIdeas()
    offerUndo(`删掉「${firstLineOf(i.text)}」`, async () => {
      const back: any = await window.tegula.ideasRestore(toPlain(r.removed))
      if (!back || back.ok === false) throw new Error(back?.error || '恢复不了')
      await loadIdeas()
    })
  } catch (e: any) {
    showToast('删除异常：' + (e?.message || e), 'error')
  } finally {
    ideaBusy.value = false
  }
}

/** 取第一行（toast / 撤销条上只放一行，多行会把条子撑高） */
function firstLineOf(t: string): string {
  const s = String(t || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''
  return s.length > 24 ? s.slice(0, 24) + '…' : s
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
// ── Logs ───────────────────────────────────────────────────────────
// 日志页状态 / 纯派生 / 取数已搬进 composables/useLogsView.ts（2026-10-31）。
// 这里解构出同名绑定：模板与既有函数一个字都不用改，状态仍只有一份。
const {
  logs, logSearchInput, logProjectFilter, logAgentFilter, logDateFrom, logDateTo,
  logSort, logBatchMode, selectedLogBatch, logsViewMode, collapsedLogGroups,
  logMoreFilterOpen, logMoreFilterCount,
  filteredLogs, visibleLogs, groupedLogs, renderSections,
  logGroupChildren, logGroupParent, logNestedChildIds,
  loadLogs, executeLogSearch, toggleLogMoreFilter, clearLogMoreFilters,
  setLogsViewMode, toggleLogGroup, isLogGroupCollapsed, logGroupKey,
  logStatusLabel, logStatusClass,
  logHasGroup, logGroupHiddenCount, logGroupStat, logGroupAllRunning, logRunningLabel,
  toggleLogBatchMode,
} = useLogsView()

const logEdit_ = ref<any>(null)
// 日志历史版本（2026-10-18 卡 001；2026-10-31 收口）：列表 / 单版预览 / 恢复
const logHistoryOpen = ref(false)
const logVersions = ref<any[]>([])
const logVersionPreview = ref<any>(null)
const logVersionBusy = ref(false)

// ── 监控台的两块派生数据（2026-10-11，监控台 P0 两件）──────────────────────
/**
 * 僵尸卡：`状态=进行中` **且**任务文件自上次写入起 ≥N 小时没变。
 * 判据本体在主进程 `findStalledTasks`（与通知中心 `task-stalled` **同源**），这里只接线。
 * ⚠ 别拿 `findTimeoutTasks` 当它用 —— 那个只算「派活 → 现在」，与文件有没有变毫无关系。
 */
const STALLED_HOURS = 24
const stalledTasks = ref<{ id: string; title: string; hours: number }[]>([])
async function loadStalled(): Promise<void> {
  try {
    const r = await (window as any).tegula.stalledTasks(STALLED_HOURS)
    stalledTasks.value = Array.isArray(r) ? r : []
  } catch { stalledTasks.value = [] }
}

/** 监控台的「最近执行日志」：当前项目的最近 5 条（日志由 loadLogs 拉，见 loadViewData('projects')） */
const msLogs = computed(() => {
  const p = pvCurrent.value
  if (!p) return []
  return logs.value
    .filter(l => String(l.project || '') === p.id)
    .sort((a, b) => String(b.logDate || b.created || '').localeCompare(String(a.logDate || a.created || '')))
    .slice(0, 5)
})

/** 监控台的「僵尸卡」：停滞清单里属于当前项目的。
 *  ⚠ `findStalledTasks` 不返回 project —— 这里用任务表 join，不去改主进程语义。 */
const msStalled = computed(() => {
  const p = pvCurrent.value
  if (!p) return []
  const ids = new Set(tasks.value.filter(t => normProject((t as any).project) === p.id).map(t => t.id))
  return stalledTasks.value.filter(s => ids.has(s.id))
})

// ── 自仓启动同步状态（2026-10-21 · W1-1C）────────────────────────────────
/**
 * 主进程启动时对**方寸自仓**跑一次 `git pull --ff-only`，这里只读它报的状态。
 * 为什么不是"加个同步按钮"：用户零动作原则 —— 自动就够，按钮只会多一处要维护的失败面。
 * 为什么只在"没跟上"时显示：正常态显示「已是最新」纯属噪音（用户不关心 git 的事）。
 * ⚠ 非 git 仓库（安装版）/ 从未跑过 → **不显示任何东西**，不拿「未知」冒充状态。
 */
const selfSync_ = ref<any>(null)
async function loadSelfSync(): Promise<void> {
  const api: any = (window as any).tegula
  if (!api || typeof api.selfSyncStatus !== 'function') return  // 旧主进程：不显示，不报假
  try {
    selfSync_.value = await api.selfSyncStatus()
  } catch {
    selfSync_.value = null
  }
}

/**
 * 自仓同步那一行字。**正常态也显示**（2026-10-21 暮雨实测后改）。
 *
 * 原来只在"没跟上"时渲染 —— 结果他安装后想确认"到底同步没同步"，界面上什么都没，
 * 只能来问我"待同步在哪看"。状态这种东西**看不见就等于不存在**：
 * 常驻一行 11px 灰字（"同步：已是最新（今天 19:53）"），异常才变色。
 * 只有 skipped（安装版数据根不是 git 仓库）不显示 —— 那是常态，报出来就是噪音。
 */
const selfSyncLine = computed<null | { tone: 'ok' | 'warn'; text: string }>(() => {
  const s = selfSync_.value
  if (!s || !s.state || s.state === 'skipped') return null
  if (s.state === 'running') return { tone: 'ok', text: '同步：正在拉…' }
  const d = s.at ? new Date(s.at) : null
  const hhmm = d && !Number.isNaN(d.getTime())
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : ''
  if (s.state === 'ok') return { tone: 'ok', text: `同步：已是最新${hhmm ? `（今天 ${hhmm}）` : ''}` }
  if (s.state === 'behind') return { tone: 'warn', text: `待同步：${s.message || '本地有改动或与远端分叉'}` }
  return { tone: 'warn', text: `同步没跑成：${s.message || '未知原因'}` }
})

// ── 路线文档实况（2026-10-21 · W1-批次 2）────────────────────────────────
/**
 * 把仓库里的 README / ROADMAP 自动读回来，与**手写**的「说明 / 路线图」并列摆着。
 *
 * 口径（暮雨 2026-10-21 定的）：README 与 ROADMAP 都算路线文档，但 README 偏"给用户看的
 * 展示公告"，所以这里 README 只取**一句话摘要**；ROADMAP 才是"接下来做什么"的正主。
 *
 * 为什么不覆盖手写值：手写那一栏是人的判断，自动那一栏是仓库的现状 —— 两者不一致本身
 * 就是信息（要么手写忘了更新，要么文档没跟上）。代码只负责把两边都摆出来，不替人裁决。
 * ⚠ 一天一批由**主进程缓存**，所以这里每次切项目都调也不贵（命中缓存不跑 git）。
 */
const msDocs = ref<any>(null)
/** 哪一份文档被点开了（roadmap / readme）—— 默认都收起：两行摘要，点开看前 1200 字 */
const docOpen = ref<Record<string, boolean>>({ roadmap: false, readme: false })
function toggleDoc(k: string): void {
  docOpen.value = { ...docOpen.value, [k]: !docOpen.value[k] }
}
async function loadProjectDocs(): Promise<void> {
  const p = pvCurrent.value
  const api: any = (window as any).tegula
  if (!p || !api || typeof api.projectDocs !== 'function') { msDocs.value = null; return }
  try {
    msDocs.value = await api.projectDocs(p.id)
  } catch {
    msDocs.value = null   // 读不到就整块不渲染，不糊一个"没有进展"的假结论
  }
}

// ── 监控台「建议动作 / 可并行机会」（2026-10-11，死通道 A 组收口）──────────────
// 这两条 IPC（`suggestActions` / `detectParallelOpportunities`）在主进程 `ipc.ts` 与
// preload 里存在已久，但**渲染层从来没调用过** —— 典型的"死通道"
// （`check-ipc-parity` 第 ⑤ 类"死通道"扫出来的；C 组先接体量最小的这两个）。
const pvSuggest = ref<string[]>([])
const pvParallel = ref<any[]>([])
/** 只显示与当前项目有关的（跨项目并行 + 本项目批次并行），别把别项目的建议塞进来 */
const pvParallelMine = computed(() => {
  const p = pvCurrent.value
  return pvParallel.value.filter(o => o && (o.type === 'parallel' || o.project === p?.id))
})

async function loadPvInsights(): Promise<void> {
  const p = pvCurrent.value
  if (p) {
    try {
      const r = await (window as any).tegula.suggestActions(p.id)
      pvSuggest.value = Array.isArray(r) ? r : []
    } catch { pvSuggest.value = [] }
  } else {
    pvSuggest.value = []
  }
  try {
    const r = await (window as any).tegula.detectParallelOpportunities()
    pvParallel.value = Array.isArray(r) ? r : []
  } catch { pvParallel.value = [] }
}

// 换项目就重算建议（不然切了项目还显示上一个项目的建议 = 界面说假话）。
// ⚠ 盯 `pvCurrent.id` 而不是 `pvSelected`：项目列表是异步 loadAll() 拉回来的，
//   进门那一刻 pvCurrent 还是 null（选中项回落 projectStats[0]）—— 只盯 pvSelected
//   会漏掉"列表到货"这一跳，于是刚进项目页时建议那格永远是空的（懒加载 = 说假话的变体）。
watch(() => pvCurrent.value?.id, () => {
  void loadPvInsights()
  // 换项目就要换文档实况（同一个 watch 里接：只盯 id 的那一套口径别再抄第二份）
  void loadProjectDocs()
}, { immediate: true })

/** 从监控台跳日志页签，并**预置该项目筛选**（不是干跳） */
function openProjectLogs(): void {
  const p = pvCurrent.value
  if (!p) return
  logProjectFilter.value = p.id
  switchView('logs')
}
/** 接力对话框（2026-09-29 方案二）：源日志 + 预填字段 + 两个出清开关 */
const relay_ = ref<any>(null)
/** 关闭防丢确认条（2026-09-30 卡 006）：有未创建改动时点遮罩/「取消」→ 先出条，点「丢弃」才真关。
 *  不再用原生 window.confirm —— 用户实测两次「防护未生效」，对话框内的条子躲不掉也误点不了。 */
const relayDiscard_ = ref(false)
/** 确认条上列出到底改了什么，让用户判断值不值得丢 */
const relayDirtyHint = computed(() => relayChanges(relay_.value).join('、') || '（改动未识别）')
/** 确认条本身 —— 接力对话框内容长（88vh 内可滚动），条子可能在折叠线下方，
 *  出现时必须把它滚进视野并把焦点放在「继续填写」上（默认动作 = 留下，回车不会误丢）。
 *  ⚠ 模板已搬进 RelayModal：不再用 ref，按弹窗内唯一钩子查。 */
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
  try { window.tegula.prefsSet('fc_agent_presets', toPlain(agentPresets.value))?.catch?.(() => {}) } catch { /* 真身写失败已在主进程记日志 */ }
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
// 绑定弹窗（不再藏在多选里：卡上直接「🔗 绑定附属」）
const logAttachTarget = ref<any>(null)
const logAttachPick = ref<string[]>([])
const logAttachBusy = ref(false)

/**
 * 打开绑定弹窗时**重新取全量日志**（2026-10-30 暮雨第 2 条）。
 *
 * 旧实现从 `logs.value` 取候选 —— 那是**当前视图已经筛过**的一份数据：
 * 用户在主界面按项目 / 搜索词筛过之后，绑定弹窗里的候选也跟着只剩那几条，
 * 看起来就是「完全没有筛选能力」。候选必须来自全量，再由弹窗自己的条件去筛。
 */
async function openLogAttach(main: any): Promise<void> {
  if (!main || main.status === 'archived') return
  logAttachTarget.value = main
  logAttachPick.value = (Array.isArray(main.attached) ? main.attached : []).slice()
  logAttachQuery.value = ''
  logAttachProject.value = ''
  logAttachStatus.value = ''
  logAttachAgent.value = ''
  logAttachPrio.value = ''
  logAttachDateFrom.value = ''
  logAttachDateTo.value = ''
  logAttachShowBlocked.value = false
  logAttachLoading.value = true
  try {
    const all: any[] = await window.tegula.logsList({})
    // 主日志自己也得在全集里（正常情况下一定在；不在时退回当前列表，避免弹窗空白）
    logAttachAll.value = Array.isArray(all) && all.length
      ? all
      : (logs.value || []).slice()
  } catch {
    logAttachAll.value = (logs.value || []).slice()
    showToast('读取全部日志失败，只能从当前列表里选', 'error')
  } finally {
    logAttachLoading.value = false
  }
}
// ── 绑定弹窗的查询条件（2026-10-30 暮雨第 2 条）──────────────────────────
// 用户原话：「绑定附属日志功能完全无筛选能力，那我搞那么多字段干嘛？懂不懂数据库？」
// 这里把日志已有的字段都变成**可叠加的查询维度**：关键词 / 项目 / 状态 / Agent /
// 优先级 / 日期范围。候选来自全量（openLogAttach 里取），不再受主界面筛选影响。
const logAttachAll = ref<any[]>([])
const logAttachLoading = ref(false)
const logAttachQuery = ref('')
const logAttachProject = ref('')
const logAttachStatus = ref('')
const logAttachAgent = ref('')
const logAttachPrio = ref('')
const logAttachDateFrom = ref('')
const logAttachDateTo = ref('')
const logAttachShowBlocked = ref(false)

/** 一行日志的「人话状态」键：running 优先于 status（与分区同一口径） */
function logAttachStatusOf(l: any): string {
  if (!l) return ''
  if (l.status === 'active') return l.running ? 'running' : 'active'
  return String(l.status || 'active')
}

/** 反向索引：附属 id → 主日志。一次算好，候选行按 O(1) 查（不逐行扫全表）。 */
const logAttachOwnerMap = computed(() => {
  const m = new Map<string, any>()
  for (const x of logAttachAll.value || []) {
    for (const id of Array.isArray(x.attached) ? x.attached : []) {
      if (!m.has(id)) m.set(id, x)
    }
  }
  return m
})

/** 谁把这条日记绑成了自己的附属（只看全量候选，不看当前视图） */
function logAttachOwnerOf(id: string): any {
  return logAttachOwnerMap.value.get(id) || null
}

/** 一条候选是否命中当前的全部筛选条件（关键词是多字段 OR，其余是 AND） */
function logAttachMatches(l: any, q: string): boolean {
  if (logAttachProject.value && l.project !== logAttachProject.value) return false
  if (logAttachStatus.value && logAttachStatusOf(l) !== logAttachStatus.value) return false
  if (logAttachAgent.value && l.agentName !== logAttachAgent.value) return false
  if (logAttachPrio.value) {
    if (logAttachPrio.value === '__none__') { if (l.priority) return false }
    else if (l.priority !== logAttachPrio.value) return false
  }
  const d = String(l.logDate || l.created || '').slice(0, 10)
  if (logAttachDateFrom.value && d < logAttachDateFrom.value) return false
  if (logAttachDateTo.value && d > logAttachDateTo.value) return false
  if (q) {
    const hit = (s: any) => String(s || '').toLowerCase().includes(q)
    const taskIds = Array.isArray(l.taskIds) ? l.taskIds.join(' ') : String(l.taskId || '')
    if (!(hit(l.id) || hit(l.title) || hit(l.content) || hit(l.nextSteps)
      || hit(l.project) || hit(l.agentName) || hit(taskIds) || hit(l.sessionId))) return false
  }
  return true
}

/** 项目下拉：登记项目 + 全量日志里出现过但未登记的项目（不把任何日志藏起来） */
const logAttachProjects = computed(() => {
  const m = new Map<string, string>()
  for (const p of projects.value || []) {
    if (p && p.id) m.set(p.id, p.name || p.id)
  }
  for (const l of logAttachAll.value || []) {
    if (l.project && !m.has(l.project)) m.set(l.project, l.project)
  }
  return Array.from(m, ([id, name]) => ({ id, name }))
})

/** Agent 下拉：常用预设 + 全量日志里出现过的 Agent */
const logAttachAgents = computed(() => {
  const s = new Set<string>()
  for (const a of agentPresets.value || []) if (a) s.add(String(a))
  for (const l of logAttachAll.value || []) if (l.agentName) s.add(String(l.agentName))
  return Array.from(s).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
})

/**
 * 候选行。三条纪律：
 *  ① 已勾选的即使不命中筛选也**必须留下**（否则勾了又被筛没了，人会以为丢了）；
 *  ② 已被别的组占走 / 自己是一组主日志的，默认不列（勾了也存不进去），
 *     打开「显示已占用」才列出来并写明原因；
 *  ③ 排序跟着使用频率走：已选 → 进行中 → 待处理 → 已完成/归档，同级按创建倒序。
 */
const logAttachRows = computed(() => {
  const main = logAttachTarget.value
  if (!main) return []
  const q = logAttachQuery.value.trim().toLowerCase()
  const rank = (r: any) => {
    if (r.picked) return 0
    if (r.blocked) return 5
    const st = logAttachStatusOf(r.log)
    return st === 'running' ? 1 : st === 'active' ? 2 : st === 'completed' ? 3 : 4
  }
  const rows: any[] = []
  for (const l of logAttachAll.value || []) {
    if (l.id === main.id) continue
    const picked = logAttachPick.value.includes(l.id)
    const ownGroup = Array.isArray(l.attached) && l.attached.length > 0
    const owner = logAttachOwnerOf(l.id)
    const blocked = !picked && (ownGroup || (owner && owner.id !== main.id))
    if (blocked && !logAttachShowBlocked.value) continue
    if (!picked && !logAttachMatches(l, q)) continue
    rows.push({
      log: l,
      picked,
      blocked: !!blocked,
      reason: ownGroup
        ? '它自己是一组的主日志'
        : (owner && owner.id !== main.id ? `已被「${owner.title || owner.id}」绑定` : ''),
    })
  }
  return rows.sort((a, b) => (rank(a) - rank(b))
    || String(b.log.created || '').localeCompare(String(a.log.created || '')))
})

/** 默认视图下有多少条「存在但不可选」的日志（用于如实说明） */
const logAttachBlockedCount = computed(() => {
  const main = logAttachTarget.value
  if (!main) return 0
  let n = 0
  for (const l of logAttachAll.value || []) {
    if (l.id === main.id || logAttachPick.value.includes(l.id)) continue
    const ownGroup = Array.isArray(l.attached) && l.attached.length > 0
    const owner = logAttachOwnerOf(l.id)
    if (ownGroup || (owner && owner.id !== main.id)) n++
  }
  return n
})

/** 已勾选、但不在当前筛选结果里的条数（弹窗底部如实显示） */
const logAttachPickedOutside = computed(() => {
  const visible = new Set(logAttachRows.value.map((r: any) => r.log.id))
  return logAttachPick.value.filter((id) => !visible.has(id)).length
})

function toggleLogAttachPick(id: string): void {
  const i = logAttachPick.value.indexOf(id)
  if (i >= 0) logAttachPick.value.splice(i, 1)
  else {
    if (logAttachPick.value.length >= 20) {
      showToast('一个主日志最多带 20 条附属日志', 'error')
      return
    }
    logAttachPick.value.push(id)
  }
}

/** 全选当前筛选结果（最多 20 条）；已选但被筛掉的不动 */
function selectAllLogAttachFiltered(): void {
  const ids = logAttachRows.value.filter((r: any) => !r.blocked).map((r: any) => r.log.id)
  const keep = logAttachPick.value.filter((id) => !ids.includes(id))
  const next = Array.from(new Set([...keep, ...ids]))
  if (next.length > 20) {
    logAttachPick.value = next.slice(0, 20)
    showToast('一个主日志最多带 20 条附属日志，已选前 20 条', 'info')
  } else {
    logAttachPick.value = next
  }
}

function clearLogAttachPick(): void { logAttachPick.value = [] }

function clearLogAttachFilters(): void {
  logAttachQuery.value = ''
  logAttachProject.value = ''
  logAttachStatus.value = ''
  logAttachAgent.value = ''
  logAttachPrio.value = ''
  logAttachDateFrom.value = ''
  logAttachDateTo.value = ''
}

async function saveLogAttach(): Promise<void> {
  const main = logAttachTarget.value
  if (!main) return
  if (logAttachPick.value.length > 20) {
    showToast('一个主日志最多带 20 条附属日志', 'error')
    return
  }
  logAttachBusy.value = true
  try {
    const r: any = await window.tegula.logsSetAttached(main.id, toPlain(logAttachPick.value))
    if (!r?.ok) { showToast(`绑定失败：${r?.error || '未知原因'}`, 'error'); return }
    showToast(logAttachPick.value.length ? `已绑定 ${logAttachPick.value.length} 条附属日志` : '已解除全部附属', 'success')
    logAttachTarget.value = null
    await loadLogs()
  } catch (e: any) {
    showToast(`绑定异常：${e?.message || e}`, 'error')
  } finally {
    logAttachBusy.value = false
  }
}

/** 组内全部成员 id（主日志在第一位；含当前筛选没显示的附属 —— 动作不能只作用于看见的） */
function logGroupMemberIds(main: any): string[] {
  const ids = [main?.id, ...(Array.isArray(main?.attached) ? main.attached : [])].filter(Boolean)
  return Array.from(new Set(ids))
}

/** 快照一组日志的当前状态（撤销用）。筛选把某条藏起来时，仍然去全量里把它读回来。 */
async function snapLogsById(ids: string[]): Promise<Array<{ id: string; snap: any }>> {
  const byId = new Map<string, any>((logs.value || []).map((x: any) => [x.id, x]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) {
    try {
      const all: any[] = await window.tegula.logsList({})
      for (const l of all || []) byId.set(l.id, l)
    } catch { /* 读不到就少撤几条，toast 会如实报 */ }
  }
  return ids.map((id) => {
    const l: any = byId.get(id)
    if (!l) return null
    return {
      id,
      snap: {
        status: l.status, running: !!l.running, agentDone: !!l.agentDone,
        completed: l.completed || null, retainDays: l.retainDays ?? null,
        retainUntil: l.retainUntil || null, note: l.note || '', archiveNote: l.archiveNote || '',
      },
    }
  }).filter(Boolean) as Array<{ id: string; snap: any }>
}

async function restoreLogSnaps(snaps: Array<{ id: string; snap: any }>): Promise<number> {
  let ok = 0
  for (const s of snaps) {
    try {
      const r: any = await window.tegula.logsRestoreState(s.id, s.snap)
      if (r?.ok) ok++
    } catch { /* 单条失败不中断 */ }
  }
  await loadLogs()
  return ok
}

/** 一键全进行中 / 全部撤销（只动待处理/进行中的成员） */
async function toggleLogGroupRunning(main: any, running: boolean): Promise<void> {
  const ids = logGroupMemberIds(main)
  const snaps = await snapLogsById(ids)
  const r: any = await window.tegula.logsGroupRunning(main.id, !!running)
  if (!r?.ok) { showToast(`操作失败：${r?.error || '未知原因'}`, 'error'); return }
  const n = (r.changed || []).length
  if (!n) showToast(running ? '全组都已在「进行中」或已完成' : '全组都没有挂「进行中」', 'info')
  else showToast(running ? `全组 ${n} 条已标为「进行中」` : `全组 ${n} 条已撤销「进行中」`, 'success')
  await loadLogs()
  if (snaps.length) {
    offerUndo(`${running ? '全组进行中' : '全组撤销进行中'}：${main.title || main.id}`, async () => {
      await restoreLogSnaps(snaps)
      showToast('已撤回全组状态', 'success')
    })
  }
}

/** 一键全完成（不再要求先勾选；跳过已完成/已归档） */
async function completeLogGroupItem(main: any): Promise<void> {
  const ids = logGroupMemberIds(main)
  const snaps = await snapLogsById(ids)
  const days = logRetainDefault.value
  const r: any = await window.tegula.logsGroupComplete(main.id, days, '')
  if (!r?.ok) { showToast(`完成失败：${r?.error || '未知原因'}`, 'error'); return }
  const n = (r.changed || []).length
  const skipped = (r.skipped || []).length
  showToast(n ? `全组已完成 ${n} 条${skipped ? `（${skipped} 条已是完成/归档，跳过）` : ''}` : '全组都已经完成或归档', n ? 'success' : 'info')
  await loadLogs()
  if (n && snaps.length) {
    offerUndo(`全组完成：${main.title || main.id}`, async () => {
      const ok = await restoreLogSnaps(snaps)
      if (ok !== snaps.length) showToast(`只撤回了 ${ok}/${snaps.length} 条`, 'error')
      else showToast('已撤回全组完成', 'success')
    })
  }
}

/** 开工单：主日志 + 全部附属，一次复制（不再依赖多选顺序） */
async function copyLogGroupAsPrompt(main: any): Promise<void> {
  // 顺序 = 主日志 + 绑定时勾选的顺序（即使当前筛选把某条藏起来，也要带给 agent）
  await copyLogsAsPrompt(logGroupMemberIds(main))
}

// ── 日志 ⇄ 待办互转（2026-10-08 卡 task-20261008-004，拍板=双向）──────────────
// 纪律（卡 004 正文）：**源保留不删**；目标记「由 X 转来」（prev 范式，与接力链同款）；
// 靠来源字段**防重** —— 同一条只转一次，手滑点两下不产出两条。
// 字段映射（拍板：待办简单字段全压一起、日志只填执行内容）：
//   待办 → 日志：title/project/priority 全走 frontmatter（priority 用卡 001 的字段），
//                due 没有日志字段 → 压进正文首行；执行内容留空给用户填。
//   日志 → 待办：下一步首条最像"要做的事" → 作为标题（没有就退回日志标题）；
//                project/priority 跟着走，due 待办侧本来就支持（日志无 due 可传）。

/** 撤销「已转出」：清掉 converted 字段（空串 = 字段从 JSON 消失），源回到常规列表 */
async function undoConverted(todo: any): Promise<void> {
  try {
    const r: any = await window.tegula.todosUpdate(todo.id, { converted: '' })
    if (r?.ok) { showToast('已撤销「已转出」标记', 'success'); await loadTodos() }
    else showToast(`撤销失败：${r?.error || '未知原因'}`, 'error')
  } catch (e: any) {
    showToast(`撤销异常：${e?.message || e}`, 'error')
  }
}

/** 转换确认（2026-10-09 用户第 1 条「能不能自动把源移入回收站？」拍板：
 *  不自动动源 —— 把「源怎么办」做成转换对话框里的勾选项（relay completeSourceTasks 同款范式），
 *  **默认不勾**（卡 004「源保留」铁律不破）。日志侧归档走现成 archived（可 reopen 找回）；
 *  待办侧标 converted = 折叠进「已转出」（不是删除，展开可撤销）。 */
const convAsk_ = ref<{ kind: 'log2todo' | 'todo2log'; src: any; archive: boolean } | null>(null)
function askConvertLog(log: any): void {
  convAsk_.value = { kind: 'log2todo', src: log, archive: false }
}
function askConvertTodo(todo: any): void {
  convAsk_.value = { kind: 'todo2log', src: todo, archive: false }
}
function runConvert(): void {
  const ask = convAsk_.value
  convAsk_.value = null          // 先关框再跑（转换本身有 toast 反馈）
  if (!ask) return
  if (ask.kind === 'log2todo') void convertLogToTodo(ask.src, ask.archive)
  else void convertTodoToLog(ask.src, ask.archive)
}

/** 待办 → 日志：源默认保留；勾了「标已转出」才折叠源（不删） */
async function convertTodoToLog(todo: any, archiveSource = false): Promise<void> {
  try {
    // 防重：读全量日志找来源（与 loadLogs 同一条取数路径，不新造查询）
    const all: any[] = (await window.tegula.logsList({})) || []
    const dup = all.find(l => l && l.fromTodo === todo.id)
    if (dup) {
      showToast(`这条待办已经转过了：${dup.id} —— 源待办保留，不再重复建日志`, 'info')
      return
    }
    const full = String(todo?.title || '').trim()
    if (!full) { showToast('这条待办没有内容，转不了', 'error'); return }
    // ⚠ 2026-10-25（暮雨第 3 条）：原来把 `title` **整条**当日志标题传下去，正文留空
    //   —— 多行待办转过去只剩第一行可见，用户原话「转进来只剩日志里的标题，甚至不是正文」。
    //   现在：标题 = 首行；正文 = 到期行 + **全文**（多行时才重复一次全文，单行不重复，
    //   否则标题与正文是同一句话，复制成派工单时会显脏）。
    const titleLines = full.split('\n')
    const title = titleLines.map(x => x.trim()).filter(Boolean)[0] || full
    const bodyParts: string[] = []
    if (todo.due) bodyParts.push(`到期：${todo.due}`)
    if (titleLines.length > 1) bodyParts.push(full)
    const r: any = await window.tegula.logsCreate(
      title,
      todo.project || '',
      bodyParts.join('\n\n'),
      undefined,
      { priority: todo.priority || '', fromTodo: todo.id, logDate: '' },
    )
    if (!r?.ok) { showToast(`转日志失败：${r?.error || '未知原因'}`, 'error'); return }
    let convNote = '源待办保留未删'
    if (archiveSource) {
      const logId = r.data?.id || ''
      const ur: any = logId ? await window.tegula.todosUpdate(todo.id, { converted: logId }) : null
      if (ur?.ok) convNote = '源待办已标「已转出」（默认折叠，展开可撤销）'
    }
    showToast(`已转成日志 ${r.data?.id || ''} —— ${convNote}`, 'success')
    await loadLogs()
    if (archiveSource) await loadTodos()   // 折叠要立刻反映出来
  } catch (e: any) {
    showToast(`转日志异常：${e?.message || e}`, 'error')
  }
}

/**
 * 日志 → 待办要搬过去的**全部内容**（2026-10-11 修的真 bug）。
 *
 * 旧实现只取「下一步」的第一条当待办标题，**正文一个字都不带**。而日志的「下一步」默认是
 * `（待填写）` 这种模板占位 —— 于是整条待办只剩「（待填写）」四个字。用户原话：
 * **「内容全丢，变成空待办，本以为文本会留住的。」** 两处都错：
 *   ① **占位当内容** —— `（待填写）` 不是"下一步"。与契约读取那条规则同类，
 *      现在归一到一个共享 helper（`shared/placeholder.ts`），不再各写一遍；
 *   ② **只挑一行搬** —— 日志的正文与下一步都是内容，不该由"哪一行最像要做的事"来决定去留。
 * 现在：摘要行 + 来源行 + **正文全文** + 下一步全文（占位则跳过），一条不丢。
 * ⚠ 待办的「内容」字段本来就是那个可以写长的 textarea（卡片上只显示首行），
 *   所以这里**不需要新增字段**就能把全文留住。
 */
function logToTodoText(log: any): string {
  const srcTitle = String(log?.title || '').trim()
  const nextSteps = String(log?.nextSteps || '').trim()
  const summary = (!isPlaceholderText(nextSteps) ? firstBulletLine(nextSteps) : '') || srcTitle
  const out: string[] = [summary || '（这条日志没有标题，也没有下一步）']
  out.push(`—— 由日志「${srcTitle || srcTitle || log?.id || ''}」转来${log?.id ? '（' + log.id + '）' : ''}`)
  const body = String(log?.content || '').trim()
  if (body) out.push('', body)
  if (nextSteps && !isPlaceholderText(nextSteps)) out.push('', '下一步：', nextSteps)
  return out.join('\n')
}

/** 日志 → 待办：源默认保留；勾了「归档源」才把日志移进已归档分区（可 reopen 找回） */
async function convertLogToTodo(log: any, archiveSource = false): Promise<void> {
  try {
    const all: any[] = (await window.tegula.todosList()) || []
    const dup = all.find(t => t && t.fromLog === log.id)
    if (dup) {
      showToast(`这条日志已经转过了待办：「${dup.title}」—— 源日志保留，不再重复建`, 'info')
      return
    }
    // ⚠ 判据是"标题与下一步**都**没有"才算转不了 —— 不能因为下一步是占位
    //   （`（待填写）`）就把整条日志判成"没有内容"。旧实现正是用占位当了标题。
    if (!String(log?.title || '').trim() && !String(log?.nextSteps || '').trim()) {
      showToast('这条日志没有标题也没有下一步，转不了', 'error'); return
    }
    const title = logToTodoText(log)
    const r: any = await window.tegula.todosCreate(title, log.priority || '中', undefined, log.project || '', log.id)
    if (!r?.ok) { showToast(`转待办失败：${r?.error || '未知原因'}`, 'error'); return }
    let convNote = '源日志保留未删'
    if (archiveSource) {
      const ar: any = await window.tegula.logsArchive(log.id)
      if (ar?.ok) convNote = '源日志已归档（日志页「已归档」分区可找回）'
    }
    showToast(`已转成待办 —— ${convNote}`, 'success')
    await loadTodos()
    if (archiveSource) await loadLogs()    // 源日志状态变了，列表要刷新
  } catch (e: any) {
    showToast(`转待办异常：${e?.message || e}`, 'error')
  }
}

const {
  toggleSelectAllLogs, executeBatchLogComplete, executeBatchLogArchive, executeBatchLogDestroy, executeBatchLogPriority,
  logPurgeOpen, logPurgeDate, logPurgePreview, logPurgeBusy,
  openLogPurge, closeLogPurge, resetLogPurgePreview, runLogPurgePreview, executeLogPurge,
} = useLogMaintenance({
  selectedLogBatch, visibleLogs, logBatchMode, toast: showToast,
  reload: loadLogs, offerLogReopenUndo,
})
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

const {
  logPendingPaths, logPendingData, logPendingCount, logAttachDragOver,
  isImageRel, attachName, attachSrc, attachPickOrAdd, pendingBaseName, resetPendingAttach,
  onLogAttachDragEnter, onLogAttachDragLeave, onLogAttachDrop, onLogPaste,
  flushPendingAttach, attachAdd, attachRemove, attachOpen, attachOpenHint,
} = useLogAttachments({ logs, logPreview, logEdit_, toast: showToast })
function openLog(log: any) {
  // 2026-09-25（用户第 2 条）：把关联任务归一成数组，供多选 UI 绑定
  logEdit_.value = { ...log, taskIds: normalizeLogTaskIds(log) }
  resetLogHistory()
  logCompleting.value = false
  logArchiveMode.value = false
  logTaskOpen.value = false    // 关联任务候选默认折叠（chips 改造）
  logTaskQuery.value = ''
  logTaskExtra.value = ''
  resetPendingAttach()   // 编辑现有日志：不带上一轮新建态的待挂附件
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

/** 日志编辑器防丢守卫（快照 / 判脏 / 警告条 / 关窗出清）—— 详见 composables/useLogEditGuard.ts */
const {
  logDiscard_, logEditDirty, closeLogEditor, closeLogNow, discardLogEdit, markLogSnap, logDirtyNames,
} = useLogEditGuard({
  logEdit_, logCompleting, logArchiveMode, logRetainDays, logNote,
  logBatchMode, logPendingCount, resetPendingAttach, normalizeLogTaskIds,
})

/** 日志保存 / 保存修改（字段集单源 + 完成归档先回写 + 附件 flush） */
const { saveLogEdit, saveLogFieldsOnly } = useLogEditorSave({
  logEdit_, logCompleting, logArchiveMode, logRetainDays, logRetainDefault, logNote,
  logPendingCount, normalizeLogTaskIds, flushPendingAttach, resetPendingAttach,
  closeLogNow, offerLogReopenUndo, toast: showToast, reload: loadLogs,
})

/** 日志状态动作：进行中 / 完成入口 / 归档入口 / 撤销 / 销毁 */
const { toggleLogRunning, completeLogItem, archiveLogItem, reopenLogItem, destroyLogItem } = useLogStatusActions({
  logs, logEdit_, logBatchMode, logCompleting, logArchiveMode, logRetainDays, logRetainDefault, logNote,
  previewTask, resetLogHistory, markLogSnap, normalizeLogTaskIds,
  showToast, loadLogs, loadLogsForTask, offerUndo, offerLogReopenUndo,
  toggleLogGroupRunning, logHasGroup, logGroupAllRunning,
})

function openNewLog() {
  // 项目默认跟随顶栏的项目筛选（没筛选就用第一个登记项目），而不是硬编码一个 id
  const project = curProj.value !== '__all__'
    ? curProj.value
    : (projects.value[0]?.id || '')
  logEdit_.value = { id: '', title: '', project, content: '', nextSteps: '', taskIds: [], sessionId: '', agentName: '', prevAgentName: '', logDate: '', priority: '' }
  resetLogHistory()
  logCompleting.value = false
  logArchiveMode.value = false
  logTaskOpen.value = false    // 关联任务候选默认折叠（chips 改造）
  logTaskQuery.value = ''
  logTaskExtra.value = ''
  logRetainDays.value = String(logRetainDefault.value)
  logNote.value = ''
  resetPendingAttach()   // 新建：上一轮没保存的待挂附件不带进来（它们属于弹出那张日志）
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
    // 2026-10-30（暮雨第 6 条）：会话 ID 创建时就能填，不再"建完再点编辑"。
    // **不继承源** —— 源里那个 ID 属于上一段会话，继承过来就是假账。
    sessionId: '',
    // 卡 001：优先级随接力继承（下一段跟上一段一样要紧；不想要就在新日志里改）
    priority: src.priority || '',
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
    sessionId: String(r.sessionId || '').trim(),
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
  if (t(r.sessionId) !== ini.sessionId) ch.push('会话 ID')
  if ([...(r.taskIds || [])].sort().join(',') !== ini.taskIds) ch.push('关联任务')
  if (!!r.archiveSource !== ini.archiveSource) ch.push('源归档开关')
  if (!!r.completeSourceTasks !== ini.completeSourceTasks) ch.push('源任务置完成开关')
  return ch
}

/**
 * 关闭接力对话框：有未创建的改动先出**对话框内的确认条**（2026-09-30 卡 006）。
 * 遮罩按下（@mousedown.self）、「取消」、全局 Esc（会替我们点「取消」）都走这里。
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
        const bar = document.querySelector('#relay-modal .relay-discard') as HTMLElement | null
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
      sessionId: r.sessionId || '',
      nextSteps: r.nextSteps || '',
      continueFrom: src.id,
      logDate: '',
      priority: r.priority || '',
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

/** 关联任务候选（2026-10-09 用户第 3 条再收）：同项目 + 关键词过滤 + 最近更新排序，
 *  首屏 12 条。索引字段不是**任务浏览器** —— 全量 checkbox 铺一屏的选择成本 > 收益，
 *  用户原话「每次都加载一堆任务，让我头疼，于是干脆什么都不选」。 */
const LOG_TASK_CAP = 12
const logTaskOpen = ref(false)
const logTaskQuery = ref('')
const logTaskMatched = computed(() => {
  const proj = logEdit_.value?.project
  const q = (logTaskQuery.value || '').trim().toLowerCase()
  const all = [...tasks.value, ...archivedTasks.value]
  const byId = new Map(all.map(t => [t.id, t]))
  const seen = new Set<string>()
  const out: Array<{ id: string; title: string; status: string }> = []
  for (const t of all) {
    if (seen.has(t.id)) continue
    if (proj && normProject(t.project) !== proj) continue
    if (q && !(String(t.id).toLowerCase().includes(q) || String(t.title || '').toLowerCase().includes(q))) continue
    seen.add(t.id)
    out.push({ id: t.id, title: t.title || '', status: t.status })
    if (out.length >= 500) break
  }
  // 最近更新优先：首屏要的是「最可能要挂的那几张」，不是文件序
  out.sort((a, b) =>
    Number(parseTime(byId.get(b.id)?.updated || 0)) - Number(parseTime(byId.get(a.id)?.updated || 0)))
  return out
})
const logTaskOptions = computed(() => logTaskMatched.value.slice(0, LOG_TASK_CAP))
const logTaskMoreHidden = computed(() => logTaskMatched.value.length > LOG_TASK_CAP)

/** chips 回显：id → 标题（列表外给空，界面回退显示 id 本身） */
function taskTitleOf(id: string): string {
  const all = [...tasks.value, ...archivedTasks.value]
  return all.find(x => x.id === id)?.title || ''
}

/** chip 上的 × ：摘掉一条关联（与取消勾选同一条数据路径） */
function unlinkLogTask(id: string): void {
  const e = logEdit_.value
  if (!e) return
  e.taskIds = normalizeLogTaskIds(e).filter(x => x !== id)
}

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

/**
 * 历史版本面板的公共小工具（2026-10-18 卡 001；2026-10-31 收口）。
 *
 * 这里补的不是"全站撤销栈"（那要动每条写路径），而是把 `atomicWrite` 本来就在写的
 * `.backup` 接出来：日志与任务卡都能**看见列表、逐版预览、恢复任意一版**。
 */
function versionSizeText(n: any): string {
  const v = Number(n) || 0
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${v} B`
}

function resetLogHistory(): void {
  logHistoryOpen.value = false
  logVersions.value = []
  logVersionPreview.value = null
  logVersionBusy.value = false
}

async function toggleLogHistory(): Promise<void> {
  if (logHistoryOpen.value) { logHistoryOpen.value = false; return }
  const e = logEdit_.value
  if (!e?.id) return
  logHistoryOpen.value = true
  logVersionPreview.value = null
  logVersionBusy.value = true
  try {
    const vs: any = await window.tegula.logsVersions(e.id)
    logVersions.value = Array.isArray(vs) ? vs : []
  } catch (err: any) {
    logVersions.value = []
    showToast(`读取历史版本失败：${err?.message || err}`, 'error')
  } finally {
    logVersionBusy.value = false
  }
}

async function previewLogVersion(v: any): Promise<void> {
  const e = logEdit_.value
  if (!e?.id || !v?.file) return
  logVersionBusy.value = true
  try {
    const r: any = await window.tegula.logsVersionGet(e.id, v.file)
    if (!r?.ok) { showToast(`预览失败：${r?.error || '未知原因'}`, 'error'); return }
    logVersionPreview.value = r.data
  } catch (err: any) {
    showToast(`预览异常：${err?.message || err}`, 'error')
  } finally {
    logVersionBusy.value = false
  }
}

async function restoreLogVersionItem(v: any): Promise<void> {
  const e = logEdit_.value
  if (!e?.id || !v?.file) return
  const when = v.at ? formatDateTime(v.at) : '这个版本'
  const dirtyTip = logEditDirty() ? '\n\n⚠ 表单里还没保存的改动会被这一版覆盖。' : ''
  if (!confirm(`恢复到「${v.title || '(无标题)'}」（${when}）？\n\n标题 / 正文 / 下一步 / 状态都会回到那一版。\n当前版本会先自动备份，撤错了可以再恢复回来。${dirtyTip}`)) return
  try {
    const r: any = await window.tegula.logsRestoreVersion(e.id, v.file)
    if (!r?.ok) { showToast(`恢复失败：${r?.error || '未知原因'}`, 'error'); return }
    const fresh: any = await window.tegula.logsGet(e.id)
    if (fresh?.id) {
      logEdit_.value = { ...fresh, taskIds: normalizeLogTaskIds(fresh) }
      markLogSnap()
    }
    logHistoryOpen.value = false
    logVersionPreview.value = null
    showToast(`已恢复（回到 ${when} 那一版）`, 'success')
    await loadLogs()
  } catch (err: any) {
    showToast(`恢复异常：${err?.message || err}`, 'error')
  }
}

/**
 * 把一条日志复制成可直接粘给 agent 的提示词块。
 * 后端 `logs:inject`（返回"上次执行日志"格式的文本）早就写好并注册了通道，
 * 但界面从来没有入口 —— 而"日志 → 提示词"正是方寸定位里的核心动作。
 */
// ── 日志 / 待办右键菜单（2026-09-26 卡 037）──────────────────────────────
// 用户给的规格铁律：菜单是「出口加速器」，只放**已实际发生**的流的快捷方式；
// 一层封顶、单项 ≤7；删除放最末且二次确认；「发给 AI / 智能总结」永不进菜单（元层铁律）。
const ctxOther = ref<{ x: number; y: number; kind: 'log' | 'todo' | 'column'; item: any } | null>(null)

/**
 * 看板分区空白处右键 → 「在此列新建任务」（2026-10-17 暮雨第 3 条：看板右键新建）。
 * 挂在三种摆法的分区容器上（列视图 .col / 列表视图 .blgrp / 卡片墙 .pwg）。
 * 两条边界：
 *  ① 指针落在任务卡上就**放行给卡片的右键菜单**（TaskCardMenu 挂在卡上）——
 *     contextmenu 会冒泡，这里用「目标在 [data-id] 内」识别卡内区域，不抢；
 *  ② 归档区不弹「新建」：新建出来的是活动任务，在归档页弹这个语义不通。
 */
function openColumnMenu(e: MouseEvent, status: string): void {
  if (curView.value !== 'active') return
  const t = e.target as HTMLElement | null
  // ⚠ 卡片区域内一律放行：不放行的话卡片的 reka 右键菜单会被"列菜单"顶掉
  //   （2026-10-17 实测：模板层 `.prevent` 会让同一次 contextmenu 在到达卡片之前就被拦，
  //    卡片菜单再也打不开 —— 17 条断言连锁红。所以 preventDefault 只在本函数**真正要弹列菜单时**调）。
  if (t && (t.closest('[data-id]') || t.closest('.ctx-menu'))) return
  e.preventDefault()
  ctxOther.value = { x: e.clientX, y: e.clientY, kind: 'column', item: { status } }
}
/** 右键列 → 新建任务，状态预选成点的那一列（emptyTaskForm 默认给「待办」，这里覆盖）。 */
function newTaskInColumn(item: { status: string }): void {
  openNew()
  if (editTask_.value) editTask_.value.status = item.status
}

function openLogMenu(e: MouseEvent, log: any): void {
  ctxOther.value = { x: e.clientX, y: e.clientY, kind: 'log', item: log }
}
/** 右键「编辑」→ 复用日志卡点击的 openLog。
 *  ⚠ 必须走它，不能自己 `logEdit_.value = {...log}`：完成日志 / 归档日志 / 编辑日志**共用同一个模态**，
 *  只赋值不清 mode 标志，会打开「完成日志」的框（`completeLogItem` 就是这么写的，但它是另一个动作）。 */
function editLogFromMenu(log: any): void { openLog(log) }
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

/**
 * 打开项目架构图（2026-10-29 暮雨第 2 条；2026-10-30 改名）。
 *
 * 数据真身在主进程（services/projectDiagram → 找仓库 docs/ 里的 archify 产物），这里只负责打开。
 * 失败必须说出来：没登记仓库 / 目录里没有产物 —— 不许给一张空图糊弄过去。
 * ⚠ 这不是"用任务数据画一张图"（那是大号看板，已被否）；也不是方寸自绘 —— 自绘是目标，还没做。
 */
async function openProjectDiagram(p: any): Promise<void> {
  const id = String(p?.id || p?.name || '')
  try {
    const r: any = await (window as any).tegula.projectDiagram(id)
    if (!r || r.ok === false) {
      showToast(String(r?.error || '没找到这个项目的架构图'), 'error')
      return
    }
    showToast('已用浏览器打开架构图：' + String(r.rel || r.path || ''), 'success')
  } catch (e: any) {
    showToast('打开架构图失败：' + (e?.message || e), 'error')
  }
}

// ── 方寸绘制架构图（2026-10-30，卡 task-20261030-002；同日按第 3 条重做）────
// 与上面那个「架构图」的分工写在按钮 title 里：这里扫源码自己画，不碰 archify 产物。
// 图模型来自主进程只读扫描（services/projectArch.ts）；这里负责开面板、校验展示、
// 逐块剔除、驳回重画与导出。**没点「通过」不许导出**（导出通道也会再核一遍校验）。
const archOpen = ref(false)
const archBusy = ref(false)
const archGraph = ref<ArchGraph | null>(null)
const archBaseGraph = ref<ArchGraph | null>(null)
const archReview = ref<ArchReview | null>(null)
const archRepairs = ref<string[]>([])
const archProjectId = ref('')
const archVersion = ref(1)
const archApproved = ref(false)
const archStrict = ref(false)
const archExcluded = ref<Array<{ id: string; label: string }>>([])
const archRejects = ref<string[]>([])

/** 把人工剔除应用到底图，并重跑校验（纯函数，不重新扫盘） */
function applyArchFilter(): void {
  const base = archBaseGraph.value
  if (!base) return
  const g = filterArchGraph(base, archExcluded.value.map((x) => x.id))
  archGraph.value = g
  archReview.value = evaluateArchGraph(g)
  archApproved.value = false
}

async function openSelfArch(p: any, opts: { keepExcluded?: boolean } = {}): Promise<void> {
  const id = String(p?.id || p?.name || '').trim()
  if (!id) return
  if (archProjectId.value !== id || !opts.keepExcluded) {
    archExcluded.value = []
    archVersion.value = 1
    archRejects.value = []
    archStrict.value = false
  }
  archProjectId.value = id
  archBusy.value = true
  try {
    const r: any = await (window as any).tegula.archGet(id, { strict: archStrict.value })
    if (r?.graph) {
      archBaseGraph.value = r.graph
      archRepairs.value = Array.isArray(r.repairs) ? r.repairs : []
      archReview.value = r.review || evaluateArchGraph(r.graph)
      archGraph.value = r.graph
      applyArchFilter()
      archOpen.value = true
      if (r.ok === false) showToast(String(r.error || '图没生成完整，缺什么已在面板里列出'), 'error')
      return
    }
    showToast(String(r?.error || '扫不出这个项目的代码结构'), 'error')
  } catch (e: any) {
    showToast('生成架构图失败：' + (e?.message || e), 'error')
  } finally {
    archBusy.value = false
  }
}

/** 这一笔画得不认可：从图里剔掉（只影响这张图，不改仓库、不改数据） */
function excludeArchNode(id: string): void {
  const n = archBaseGraph.value?.nodes.find((x) => x.id === id)
  if (!n) return
  if (!archExcluded.value.some((x) => x.id === id)) archExcluded.value.push({ id, label: n.label })
  applyArchFilter()
  showToast(`已剔除「${n.label}」—— 校验已按新图重跑`, 'success')
}
function restoreArchNode(id: string): void {
  archExcluded.value = archExcluded.value.filter((x) => x.id !== id)
  applyArchFilter()
}

function approveArch(): void {
  if (!archReview.value?.ok) { showToast('校验没过，先重画或剔除问题块', 'error'); return }
  archApproved.value = true
  showToast('已通过这张图 —— 现在可以导出', 'success')
}

/** 驳回：记下理由 → 按诊断做减法重画一版（不重新编节点） */
async function rejectArch(reason: string): Promise<void> {
  archRejects.value.push(String(reason || '').trim() || '（没写理由）')
  archStrict.value = true
  archVersion.value += 1
  archApproved.value = false
  showToast(`已驳回第 ${archVersion.value - 1} 版，按诊断重画第 ${archVersion.value} 版…`, 'info')
  await openSelfArch({ id: archProjectId.value }, { keepExcluded: true })
}

async function exportSelfArch(): Promise<void> {
  if (!archProjectId.value) return
  if (!archApproved.value) { showToast('先点「✅ 通过这张图」再导出', 'info'); return }
  archBusy.value = true
  try {
    const r: any = await (window as any).tegula.archExport(archProjectId.value, {
      strict: archStrict.value,
      excluded: archExcluded.value.map((x) => x.id),
    })
    if (r?.canceled) return
    if (!r || r.ok === false) {
      showToast(String(r?.error || '导出失败'), 'error')
      return
    }
    showToast('已导出：' + String(r.path || ''), 'success')
  } catch (e: any) {
    showToast('导出失败：' + (e?.message || e), 'error')
  } finally {
    archBusy.value = false
  }
}

/**
 * 多条日志 → 一份开工单（2026-10-29 暮雨第 6 条）。
 *
 * 真实用法：一条主日志讲这一轮干了什么，另几条是并行通道的进度通知；
 * 只灌主日志，agent 就漏掉并行的另一半 —— 这不是"想要的新功能"，是使用中长出来的需求。
 * 顺序即语义：**先勾选的那条是主日志**，其余会被标成「并行日志」（拼接在 services/logs.injectLogs）。
 */
async function copyLogsAsPrompt(idsIn: string[]): Promise<void> {
  const ids = (Array.isArray(idsIn) ? idsIn : []).map((x) => String(x || '')).filter(Boolean)
  if (!ids.length) { showToast('先勾选要灌的日志（第一条当主日志）', 'info'); return }
  try {
    const r: any = await window.tegula.logsInjectMany(toPlain(ids))
    if (!r || !r.text) {
      showToast('这些日志都读不出来（可能已被销毁）', 'error')
      return
    }
    console.warn('[renderer:copy] logs:injectMany n=' + ids.length + ' len=' + String(r.text).length)
    const n = Array.isArray(r.found) ? r.found.length : ids.length
    const miss = Array.isArray(r.missing) ? r.missing.length : 0
    const copied = await copyWithToast(
      String(r.text),
      n > 1 ? `已复制 ${n} 条日志为一份开工单（第一条主日志，其余标「并行日志」）` : '已复制为提示词，可直接粘给 agent',
    )
    if (!copied) return
    if (miss) showToast(`另有 ${miss} 条没找到，已跳过`, 'info')
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
/** 常用驳回理由（2026-10-30 暮雨第 2 条）：不是替他下判断，只是省掉"写作文"这一步 */
const reviewPresets = [
  '看不懂这张卡在说什么',
  '方向就是错的',
  '不需要了 / 先放下',
  '和已有任务重复',
  '验收线不成立',
]

function openReview(t: Task, intent: 'accept' | 'reject' = 'accept') {
  // 待审批 = 审批裁决（批准转正待办 / 驳回）；其余（待验收）= 验收裁决（通过 / 驳回）
  // 2026-10-30（暮雨第 3 条）：卡上直接给「通过 / 驳回」两个入口，靠 intent 决定打开后焦点在哪。
  reviewModal.value = {
    id: t.id,
    title: t.title || t.id,
    kind: t.status === '待审批' ? 'approval' : 'acceptance',
    intent,
  }
  reviewReason.value = ''
  previewTask.value = null
  nextTick(() => {
    const box = document.getElementById('review-modal')
    if (!box) return
    if (intent === 'reject') {
      const ta = box.querySelector('textarea') as HTMLTextAreaElement | null
      ta?.focus()
    } else {
      const ok = box.querySelector('.acts .ok') as HTMLButtonElement | null
      ok?.focus()
    }
  })
}

/**
 * 直接驳回（2026-10-30 暮雨第 2 条）—— 任何非终态卡都能退，不要求它先到「待验收」。
 * 与 openReview 的区别只在 kind：这里没有「通过」按钮，也不会写审批/验收措辞。
 */
function openDirectReject(t: Task): void {
  reviewModal.value = { id: t.id, title: t.title || t.id, kind: 'direct', intent: 'reject' }
  reviewReason.value = ''
  previewTask.value = null
  nextTick(() => {
    const ta = document.querySelector('#review-modal textarea') as HTMLTextAreaElement | null
    ta?.focus()
  })
}

// ── 驳回理由就地编辑（2026-10-30 暮雨第 2 条：不可编辑 / 点完看不见）──
const rejectEdit = ref(false)
const rejectEditText = ref('')
const rejectSaving = ref(false)
/** 驳回理由：新卡读独立字段；老卡没有这个字段，回退到结果记录里最后一条驳回（不然会误报"没写理由"） */
function rejectReasonOf(t: any): string {
  if (!t) return ''
  const direct = String(t.reject_reason ?? t.fm?.reject_reason ?? '').trim()
  if (direct) return direct
  return lastRejectReason(t.result_log ?? t.fm?.result_log ?? '')
}
// 换一张卡时收起上一条的就地编辑态（否则会把 A 的理由框带到 B 上）
watch(() => previewTask.value?.id, () => { rejectEdit.value = false; rejectEditText.value = '' })

function startRejectEdit(): void {
  rejectEditText.value = rejectReasonOf(previewTask.value)
  rejectEdit.value = true
}

async function saveRejectEdit(): Promise<void> {
  const t = previewTask.value
  if (!t) return
  rejectSaving.value = true
  try {
    const r: any = await window.tegula.editTask(t.id, { reject_reason: rejectEditText.value })
    if (!r?.ok) { showToast(`保存失败：${r?.error || '未知原因'}`, 'error'); return }
    // 主进程只回 ok；预览这里的值与列表都刷新一次（不拿本地串假装保存成功）
    ;(previewTask.value as any).reject_reason = rejectEditText.value
    rejectEdit.value = false
    showToast('驳回理由已更新（状态没动）', 'success')
    loadAll()
  } catch (e: any) {
    showToast(`保存异常：${e?.message || e}`, 'error')
  } finally {
    rejectSaving.value = false
  }
}

async function acceptTask() {
  if (!reviewModal.value) return
  // 2026-09-25（用户第 7 条）：通过也带上结论 → 主进程写入结果记录留痕
  const isApproval = reviewModal.value.kind === 'approval'
  const id = reviewModal.value.id
  const title = reviewModal.value.title
  const snap = snapOfTask(id)
  const result = await window.tegula.reviewAccept(id, reviewReason.value)
  if (result.ok) {
    showToast(isApproval ? '已批准 —— 已转正为「待办」' : '已通过', 'success')
    reviewModal.value = null
    loadAll()
    // 2026-10-30 暮雨第 5 条：误点「通过」必须能一键撤回（含结果记录，不只是改状态）
    if (snap) {
      offerUndo(`已通过「${title}」`, async () => {
        await restoreTaskSnap(id, snap)
        showToast('已撤回：回到点「通过」之前的状态', 'success')
      })
    }
  } else {
    showToast(result.error || '操作失败', 'error')
  }
}

async function rejectTask() {
  if (!reviewModal.value) return
  // 2026-10-30 暮雨第 2 条：理由**可选**。留空也是一次有效驳回，卡上会标「没写理由」。
  const kind = reviewModal.value.kind
  const id = reviewModal.value.id
  const title = reviewModal.value.title
  const snap = snapOfTask(id)
  const result: any = kind === 'direct'
    ? await window.tegula.rejectTaskDirect(id, reviewReason.value)
    : await window.tegula.reviewReject(id, reviewReason.value)
  if (result.ok) {
    showToast(kind === 'direct' ? '已驳回（可随时在卡上改理由）' : '已驳回', 'success')
    reviewModal.value = null
    loadAll()
    if (snap) {
      offerUndo(`已驳回「${title}」`, async () => {
        await restoreTaskSnap(id, snap)
        showToast('已撤回：这张卡回到驳回之前', 'success')
      })
    }
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
    const snap = snapOfTask(id)
    const title = String(tasks.value.find((x: any) => x.id === id)?.title || id)
    try {
      const result = await window.tegula.moveStatus(id, status)
      if (result.ok) {
        showToast(`已移动到「${status}」`, 'success')
        // 拖拽最容易手滑跨列：可撤（2026-10-30 暮雨第 5 条）
        if (snap && snap.status !== status) {
          offerUndo(`「${title}」拖到「${status}」`, async () => {
            await restoreTaskSnap(id, snap)
            showToast(`已撤回：回到「${snap.status}」`, 'success')
          })
        }
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

/**
 * 点项目卡/项目名 = 进这个项目的详情（卡 006 拍板 A）。
 * 之前是 `curProj + navigateTo('active')` —— Quartz 这类 0 卡项目点进去必然是空看板，
 * 用户原话「点『调整某项目』应到项目详情/配置，不是空看板」。
 * ⚠ 只切内存不写 prefs：摆法是用户偏好，点卡是浏览动作（同 tripOpenRow 的裁决）。
 */
function openProject(p: any) {
  pvSelected.value = p.id
  pvView.value = 'master'
  if (curView.value !== 'projects') navigateTo('projects')
}

/**
 * 「📦 任务 / 看任务」按钮的去向 —— 语义就是去看任务列表，
 * 保留原「跳看板」的行为。点卡进详情、点按钮进看板，两条路分开。
 */
function openProjectTasks(p: any) {
  curProj.value = p.id
  navigateTo('active')
}

function openProjectInSettings(p: Project) {
  // 详情渲染在项目页签里，不关设置会被遮罩整个挡住
  showSettings_.value = false
  pvSelected.value = p.id
  pvView.value = 'master'
  if (curView.value !== 'projects') navigateTo('projects')
  showToast(`已打开项目详情：${p.name || p.id}`, 'info')
}

// ── AI 规划写回层 UI（2026-10-12）───────────────────────────────────────
// 红线全在主进程（llm/writeback.ts）：草稿一律「待审批」、source=ai-planning、
// 解析失败兜底卡。UI 侧只补两件事：入口按钮（.oacts「✨ AI 规划」）+ 调用中不许关弹窗。
const aiPlanForm = ref<{ id: string; name: string; goal: string } | null>(null)
const aiPlanBusy = ref(false)

function openAiPlan(p: any) {
  aiPlanForm.value = { id: p.id, name: p.name || p.id, goal: '' }
  // 顺手刷新模型通道配置：弹窗里要靠它判断「配了没」（没配就当场指路）——
  // 只在设置页 load 的话，用户从没进过设置页时这里会一直说"还没配"（界面说假话）。
  void llmLoad()
}

/** 「AI 规划」里那条指路：把人直接送到设置页的 Agent 分类（模型通道就在那一格） */
function gotoLlmSettings(): void {
  aiPlanForm.value = null          // 先关掉自己，别叠两层遮罩
  selectSettingsTab('agent')
  showSettings()
}

function closeAiPlan() {
  if (aiPlanBusy.value) return // AI 跑着不许关——误触丢结果比多等几秒更伤
  aiPlanForm.value = null
}

/** 花销可见（方案红线）：把主进程回传的 usage 拼成人话，null 全缺返回空串不凑数 */
function aiUsageTail(u: any): string {
  if (!u) return ''
  const parts: string[] = []
  if (typeof u.promptTokens === 'number') parts.push(`入 ${u.promptTokens}`)
  if (typeof u.completionTokens === 'number') parts.push(`出 ${u.completionTokens}`)
  if (typeof u.totalTokens === 'number') parts.push(`共 ${u.totalTokens}`)
  return parts.length ? ` · tokens ${parts.join('/')}` : ''
}

/** 拆目标 → 待审批任务卡。成功即关窗，看板筛「待审批」就能看到琥珀色草稿卡。 */
async function runPlanToDraft() {
  const f = aiPlanForm.value
  if (!f || aiPlanBusy.value || !f.goal.trim()) return
  aiPlanBusy.value = true
  try {
    const r: any = await window.tegula.llmPlanToDraft(f.goal.trim(), f.id)
    if (r?.ok) {
      showToast(`草稿已落「待审批」（看板筛琥珀色可见）——过目后转正${aiUsageTail(r.usage)}`, 'success')
      aiPlanForm.value = null
    } else {
      showToast(r?.error || 'AI 规划失败——先到设置页确认模型通道', 'error')
    }
  } catch (e: any) {
    showToast(`AI 规划失败：${e?.message || e}`, 'error')
  } finally {
    aiPlanBusy.value = false
  }
}

/** 起草项目说明 → 四栏草稿卡（现状/目标/不做/欠着什么），素材取项目现有任务卡聚合。 */
async function runDraftBrief() {
  const f = aiPlanForm.value
  if (!f || aiPlanBusy.value) return
  aiPlanBusy.value = true
  try {
    const r: any = await window.tegula.llmDraftProjectBrief(f.id)
    if (r?.ok) {
      showToast(`项目说明草稿已落「待审批」——过目后转正${aiUsageTail(r.usage)}`, 'success')
      aiPlanForm.value = null
    } else {
      showToast(r?.error || '起草失败——先到设置页确认模型通道', 'error')
    }
  } catch (e: any) {
    showToast(`起草失败：${e?.message || e}`, 'error')
  } finally {
    aiPlanBusy.value = false
  }
}

// ── 文档拆卡 UI（2026-10-17 四件补立项之二）──────────────────────────────
// 红线全在主进程（llm/writeback.ts docToDrafts）：待审批+ai-doc 来源+超长硬拒+上限 20 张。
const aiDocForm = ref<{ id: string; name: string; doc: string } | null>(null)
const aiDocBusy = ref(false)

function openAiDoc(p: any) {
  aiDocForm.value = { id: p.id, name: p.name || p.id, doc: '' }
  void llmLoad()  // 同 AI 规划：没配模型通道时当场指路，别让用户白粘一段长文
}

function closeAiDoc() {
  if (aiDocBusy.value) return
  aiDocForm.value = null
}

/** 粘贴文档 → AI 拆成待审批卡。成功即关窗，看板筛「待审批」看到琥珀色卡。 */
async function runDocToDrafts() {
  const f = aiDocForm.value
  if (!f || aiDocBusy.value || !f.doc.trim()) return
  aiDocBusy.value = true
  try {
    const r: any = await window.tegula.llmDocToDrafts(f.doc.trim(), f.id)
    if (r?.ok) {
      showToast(`已拆 ${r.created?.length ?? 0} 张「待审批」卡——过目后转正${aiUsageTail(r.usage)}`, 'success')
      aiDocForm.value = null
    } else {
      showToast(r?.error || '拆卡失败——先到设置页确认模型通道', 'error')
    }
  } catch (e: any) {
    showToast(`拆卡失败：${e?.message || e}`, 'error')
  } finally {
    aiDocBusy.value = false
  }
}

// ── 挂机提醒设置（2026-10-17 四件补立项④）──────────────────────────────
// 判定与弹窗全在主进程（main/services/idleReminder.ts，powerMonitor 空闲检测）；
// 这里只是 prefs 读写壳。保存即时生效（主进程每轮轮询现读 prefs.json，无需重启）。
const idleCfg = ref<{ enabled: boolean; thresholdMin: number }>({ enabled: true, thresholdMin: 30 })
const idleSaving = ref(false)

/** AI 用量（2026-10-17 第 10 条）：null = 还没查过（界面要说"还没查过"，不是显示 0 装成"花销为 0"） */
const usageStats_ = ref<any>(null)

async function loadUsageStats(days = 30): Promise<void> {
  try {
    const r: any = await window.tegula.llmUsageStats?.(days)
    if (r) {
      usageStats_.value = r
    } else {
      showToast('主进程没有返回用量数据（主进程可能是旧版本，请托盘退出后重启）', 'error')
    }
  } catch (e: any) {
    showToast(`读取用量失败：${e?.message || e}`, 'error')
  }
}

async function idleLoad() {
  try {
    const p: any = await window.tegula.prefsGet()
    const v = p?.idleReminder || {}
    idleCfg.value = {
      enabled: v?.enabled !== false,
      thresholdMin: Math.max(5, Number(v?.thresholdMin) || 30),
    }
  } catch { /* 缺省兜底：开+30 分钟 */ }
}

async function idleSave() {
  if (idleSaving.value) return
  idleSaving.value = true
  try {
    const thresholdMin = Math.max(5, Math.round(Number(idleCfg.value.thresholdMin) || 30))
    idleCfg.value.thresholdMin = thresholdMin
    await window.tegula.prefsSet('idleReminder', { enabled: idleCfg.value.enabled, thresholdMin })
    showToast(`挂机提醒已${idleCfg.value.enabled ? '保存' : '关闭'}（${idleCfg.value.enabled ? `离开 ${thresholdMin} 分钟后提醒` : '不再轮询'}，即时生效）`, 'success')
  } catch (e: any) {
    showToast(`保存失败：${e?.message || e}`, 'error')
  } finally {
    idleSaving.value = false
  }
}

// ── 规划管理（2026-10-16 第 1 项）：接 createPlan/listPlans/getPlan/decidePlanPoint 四条通道。
//    后端 10-11 起全就绪（main+preload），渲染层此前零调用=死通道；本窗补上开关。
const plansModal = ref<{ id: string; name: string } | null>(null)
const planList = ref<any[]>([])
const planListBusy = ref(false)
const planDetail = ref<{ id: string; plan: any } | null>(null)
const planCreating = ref(false)
const planForm = ref<{ title: string; objective: string; milestones: string; dps: { question: string; options: string }[] }>(
  { title: '', objective: '', milestones: '', dps: [{ question: '', options: '' }] })

/** plan_status → 人话（后端存英文四态；界面只说中文） */
function planStatusLabel(s: any): string {
  return ({ draft: '草稿', active: '进行中', achieved: '已达成', abandoned: '已放弃' } as any)[s] || (s || '草稿')
}
function planWhen(iso: string): string {
  const t = Date.parse(iso)
  return isNaN(t) ? '' : new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

async function openPlans(p: any) {
  plansModal.value = { id: p.id, name: p.name || p.id }
  planDetail.value = null
  planCreating.value = false
  await refreshPlans()
}
function closePlans() {
  plansModal.value = null
}
/** 列表 = 全部规划里筛本项目的（listPlans 返回全库 plan 型任务，按 fm.project 归位） */
async function refreshPlans() {
  if (!plansModal.value) return
  planListBusy.value = true
  try {
    const all: any[] = await window.tegula.listPlans()
    planList.value = all.filter((t: any) => (t.fm?.project || '') === plansModal.value!.id)
  } finally {
    planListBusy.value = false
  }
}
function startPlanCreate() {
  planCreating.value = true
  planForm.value = { title: '', objective: '', milestones: '', dps: [{ question: '', options: '' }] }
}
/** 里程碑「名称|截止」逐行拆；决策点问题+选项逐行拆；空段过滤（标题必填，其余可空） */
async function submitPlan() {
  if (!plansModal.value) return
  const f = planForm.value
  if (!f.title.trim()) return
  const milestones = f.milestones.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { const [name, deadline] = l.split('|'); return { name: (name || '').trim(), deadline: (deadline || '').trim() } })
    .filter((m: any) => m.name)
  const decisions = f.dps
    .map((d: any) => ({ question: d.question.trim(), options: d.options.split('\n').map((s: string) => s.trim()).filter(Boolean) }))
    .filter((d: any) => d.question && d.options.length)
  try {
    const r: any = await window.tegula.createPlan({ title: f.title.trim(), project: plansModal.value.id, objective: f.objective.trim(), milestones, decisions })
    showToast(`规划已建（${r.id}）——决策点逐个选定后自动转「进行中」`, 'success')
    planCreating.value = false
    await refreshPlans()
  } catch (e: any) {
    showToast(`建规划失败：${e?.message || e}`, 'error')
  }
}
async function openPlanDetail(id: string) {
  try {
    const r: any = await window.tegula.getPlan(id)
    if (!r) { showToast('规划不存在（可能已删）', 'error'); return }
    planDetail.value = { id, plan: r.plan }
  } catch (e: any) {
    showToast(`读规划失败：${e?.message || e}`, 'error')
  }
}
function backPlanList() {
  planDetail.value = null
}
/** 决策点选定：调完重读详情——留痕（chosen/decidedAt）与「全定完自动转进行中」当场可见 */
async function decideDp(dp: any, choice: string) {
  const d = planDetail.value
  if (!d) return
  try {
    const r: any = await window.tegula.decidePlanPoint(d.id, dp.id, choice)
    if (r?.ok === false) { showToast(r.error || '留痕失败', 'error'); return }
    await openPlanDetail(d.id)
  } catch (e: any) {
    showToast(`留痕失败：${e?.message || e}`, 'error')
  }
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
      showToast('项目已登记。它现在还没有任务卡、文件夹 30 天内也没有提交，所以默认不会出现在「在途一屏」—— 想在屏上看到它，去「⚙ 显示设置」放宽门槛，或改成「手动指定」勾上它', 'success')
      projForm.value = null
      await loadAll()
      // 2026-10-05 用户「添加完项目刷新几遍根本看不到」：项目列表刷新了，但这一屏的数据
      // 是**独立一次聚合**，不跟着 loadAll 走 —— 所以这里必须显式再拉一次。
      if (pvView.value === 'trip') await loadTripBoard()
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

/* ⚠ 2026-10-16（用户第 2 条）：`appObservedText`（卡片上"上次启动观测到 :xxxx"）
   与 `describeCmd`（服务页应用行的"启动命令"标签）一并删掉 ——
   启动台不再显示端口，服务页不再列应用。两者都是"端口中心"模型的残留。 */

/** 打开某个启动台应用所在的文件夹（复用既有 launchpadOpenFolder 通道） */
async function openAppFolder(app: any): Promise<void> {
  const p = folderOfPath(app?.path || app?.cmd || '')
  if (!p) { showToast('这条登记没有可打开的路径', 'error'); return }
  const r: any = await window.tegula.launchpadOpenFolder(p)
  if (r && r.ok === false) showToast(`打开失败：${r.message || r.error || '未知原因'}`, 'error')
}

/** 从「文件路径」推出「所在文件夹」（渲染层没有 node:path，自己切；路径本身是目录就原样返回） */
function folderOfPath(raw: string): string {
  const s = String(raw || '').trim().replace(/[\\/]+$/, '')
  if (!s) return ''
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  if (i < 0) return s
  return s.slice(0, i)
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

/** 启动台卡片右键菜单的动作分发（AppCardMenu 只报"点了哪一项"，动作留在这里） */
function onAppMenuPick(payload: { app: any; action: string }): void {
  const { app, action } = payload || ({} as any)
  if (!app) return
  if (action === 'launch') { void launchAppClick(app); return }
  if (action === 'edit') { openEditApp(app); return }
  if (action === 'folder') { void openAppFolder(app); return }
  if (action === 'delete') { void askRemoveApp(app) }
}

/** 卡片上的 🗑 / 右键「删除」都走这里 —— 只为把"删的是什么"说清楚 */
function askRemoveApp(app: any): void {
  void removeApp(app?.id, app?.name)
}

async function removeApp(id: string, name?: string) {
  if (!confirm(`删掉「${name || id}」这条登记？\n\n只删登记，磁盘上的应用文件不受影响。`)) return
  await window.tegula.launchpadRemoveApp(id)
  editApp_.value = null
  showToast(`已删除登记：${name || id}`, 'success')
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

/** 正在启动的应用 id（防连点起两份；纯内存，6 秒自动放开） */
const launchingApps = new Set<string>()

async function launchAppClick(app: any) {
  const t: any = (window as any).tegula || {}
  // 防重入（2026-10-17）：主进程现在会等 1.5 秒复查进程再返回，这期间连点会**起两份**。
  // 用 id 记在内存里，超时自动放开（不落盘：这是瞬时状态）。
  const key = String(app?.id || app?.name || '')
  if (key && launchingApps.has(key)) {
    showToast(`「${app.name || key}」正在启动，稍等`, 'info')
    return
  }
  if (key) {
    launchingApps.add(key)
    setTimeout(() => launchingApps.delete(key), 6000)
  }
  // 先给一句"正在启动"：复查要等 1.5 秒，没有这句话用户会以为没点上
  showToast(`正在启动：${app?.name || app?.id || ''}…`, 'info')
  // 先落一条「渲染层点了启动」的痕迹再调主进程。
  // 理由：2026-09-25 用户报「启动台依旧报错」，但日志里**一条 launchpad 记录都没有** ——
  // 分不清是"没点"还是"点了但主进程没收到/主进程是旧代码"。这条线一写，两种情况立刻可分。
  try {
    await t.applogWrite?.('INFO', 'launchpad-ui', `点击启动：${app?.name || app?.id || '(未知)'}`,
      JSON.stringify({ cmd: app?.cmd, path: app?.path, hasLaunchApi: typeof t.launchpadLaunchApp === 'function' }))
  } catch { /* 日志写不进去也不能挡住启动 */ }

  if (typeof t.launchpadLaunchApp !== 'function') {
    if (key) launchingApps.delete(key)
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
      // 失败就别占着"正在启动"的名额 —— 用户要能立刻再试一次
      if (key) launchingApps.delete(key)
      // 失败把「启动了什么」也带上，并留一条错误条 + 日志可查
      appErrors.value.push({
        scope: 'launchpad',
        message: `启动「${app.name}」失败：${result.message}（命令：${app.cmd || app.path}）`,
        at: Date.now(),
      })
    }
  } catch (e: any) {
    if (key) launchingApps.delete(key)
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
  // Git 通道的状态也一样：进门就刷（否则「令牌已保存」会被显示成没保存 —— 界面说假话）
  void loadGitStatus()
  // 体积报告：进门就拉（"包为什么大"得能当场看到，而不是等打完包才发现）
  void bkLoadSizeReport()
  // 模型单价：进门就拉（空表也是信息 —— 说明现在是"一律未折算"）
  void loadPrices()
  // 诊断页（上次停在诊断时直接进它 —— 那三块要当场有数）
  if (settingsTab.value === 'diag') void loadDiag()
  // ⚠ 合入（2026-10-12）：这一行是外部整包加的，与上面三条**并列不冲突** ——
  //   两边都是"打开设置页时进门就刷"的条目，合并时保留全部四条（缺谁谁就"界面说假话"）。
  //   这条纪律本身就是从"懒加载导致界面说假话"那几次事故里来的（见 MEMORY 第 5.8 条）。
  llmLoad()
  idleLoad()  // 挂机提醒（2026-10-17）：同纪律，进门就刷，别显示上一次的旧值
}

// ── 模型通道（AI 规划用，2026-10-12）：BYOK 配置界面 ────────────────────
// 后端 llm:getConfig/setConfig/resetConfig/testConnection 四通道就绪，UI 第一次装。
// 密钥防线在主进程（掩码/空白视为未修改不写盘），UI 侧掩码同样不回传，双保险。
const llmCfg = ref<{ baseUrl: string; model: string; apiKey: string; timeout: number }>({
  baseUrl: '', model: '', apiKey: '', timeout: 60,
})
const llmKeyHint = ref('')
const llmTesting = ref(false)
const llmSaving = ref(false)
const llmResetting = ref(false)
/** 最近一次调用（状态条用）。数据来自 ai-trace 的 llm:usageStats.last —— 不额外读文件。
 *  一次都没跑过时是 null，状态条显示「还没跑过调用」，不拿 0 糊一个数字。 */
const llmLastCall = ref<{
  ts: string; model: string; trigger: string
  total_tokens: number | null; duration_ms: number; ok: boolean
} | null>(null)
/** 待确认的预设（2026-10-27）：点了会**覆盖已有端点/模型**，必须先确认再应用。 */
const llmPresetPending = ref<{ kind: LlmPresetKind; baseUrl: string; model: string } | null>(null)

type LlmPresetKind = 'deepseek' | 'mimo-api' | 'mimo-plan'
/** 预设数据集中在这里 —— 以前三个分支各写一遍 baseUrl/model/toast，改一处容易漏两处。 */
const LLM_PRESETS: Record<LlmPresetKind, { baseUrl: string; model: string; toast: string; level: 'info' | 'error' }> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat',
    toast: '已填 DeepSeek 官方端点与模型名——Key 在你手里，填好测试连接', level: 'info',
  },
  'mimo-api': {
    baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash',
    toast: '已填小米「按量付费」端点——Key 用 sk- 开头那串（控制台 API Keys 里复制）', level: 'info',
  },
  'mimo-plan': {
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', model: 'mimo-v2.6-flash',
    toast: '已填 Token Plan 端点——⚠ 小米条款限编程工具内使用，方寸属应用后端，建议改用按量付费', level: 'error',
  },
}

/** 从 URL 取主机名（状态条/确认条显示用）；解析失败就原样返回，不抛错 */
function llmHostOf(url: string): string {
  const s = String(url || '').trim()
  if (!s) return '（空）'
  try { return new URL(s).host || s } catch { return s }
}

/** ai-trace 的 ts 有两种历史格式（带 Z / 不带 Z，见主进程 parseTs 注释）。
 *  无标记的按 UTC 解释，与主进程口径一致 —— 否则这里又会差 8 小时。 */
function fmtShort(ts: string): string {
  const s = String(ts || '').trim()
  if (!s) return '—'
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s)
  const t = Date.parse(hasTz ? s : s + 'Z')
  if (!Number.isFinite(t)) return s
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function loadLlmLastCall() {
  try {
    const r: any = await window.tegula.llmUsageStats?.(30)
    llmLastCall.value = r?.last || null
  } catch {
    llmLastCall.value = null
  }
}

async function llmLoad() {
  try {
    const r: any = await window.tegula.llmGetConfig()
    if (r?.ok !== false && r) {
      llmCfg.value = {
        baseUrl: r.baseUrl || '',
        model: r.model || '',
        apiKey: r.hasApiKey ? '***' : '',
        timeout: r.timeout || 60,
      }
      llmKeyHint.value = r.apiKeyHint || ''
    }
  } catch (e: any) {
    showToast(`读取模型配置失败：${e?.message || e}`, 'error')
  }
  // 状态条要的「最近一次调用」与配置解耦：配置读失败也照样显示用量
  void loadLlmLastCall()
}

/** 预设：只填**有据可查**的端点与模型名（官方文档写明的那几个），密钥一律不预填。
 *
 *  小米的两套凭证（2026-10-18 暮雨第 3 条）：
 *   · 按量付费：https://api.xiaomimimo.com/v1，Key 形如 sk-xxxxx；
 *   · Token Plan：https://token-plan-cn.xiaomimimo.com/v1（另有 sgp / ams 集群），Key 形如 tp-/ttp-。
 *  两者**端点与密钥都不能互换**（拿 Plan 的 key 打按量付费端点 = 401）。
 *  ⚠ 按小米条款，Token Plan 额度仅限编程工具内使用，禁止用于应用后端 —— 方寸属后者，
 *    所以按钮虽然给了，提示里明确劝退；默认推荐按量付费。
 *  ⚠ 模型名用官方文档的**小写连字符**写法（mimo-v2.6-flash）：以前这里填的是
 *    `MiMo-V2.6-Flash`，与接口返回的 model id 对不上，用户"一键填完还是失败"。
 */
function applyLlmPreset(kind: LlmPresetKind) {
  const preset = LLM_PRESETS[kind]
  if (!preset) return
  const cur = llmCfg.value
  // 2026-10-27（暮雨：「真正缺的是二次确认」）：预设会**直接盖掉已填的端点与模型名**，
  // 此前一点就没、也没法撤销。现在：已经有配置且与预设不同 → 先弹确认条，不直接写。
  // 配置是空的时候不问 —— 那不叫覆盖，那叫填空。
  const hasCfg = !!(cur.baseUrl.trim() || cur.model.trim())
  const differs = cur.baseUrl.trim() !== preset.baseUrl || cur.model.trim() !== preset.model
  if (hasCfg && differs) {
    llmPresetPending.value = { kind, baseUrl: preset.baseUrl, model: preset.model }
    return
  }
  commitLlmPreset(kind)
}

/** 确认条上的「覆盖」：真正写入（预设只动端点与模型名，API Key 一律不碰） */
function confirmLlmPreset() {
  const p = llmPresetPending.value
  if (!p) return
  llmPresetPending.value = null
  commitLlmPreset(p.kind)
}

function commitLlmPreset(kind: LlmPresetKind) {
  const preset = LLM_PRESETS[kind]
  llmCfg.value.baseUrl = preset.baseUrl
  llmCfg.value.model = preset.model
  showToast(preset.toast, preset.level)
}

async function llmTest() {
  if (llmTesting.value) return
  llmTesting.value = true
  try {
    const cfg = { ...llmCfg.value }
    if (cfg.apiKey === '***') delete (cfg as any).apiKey
    const r: any = await window.tegula.llmTestConnection(cfg)
    if (r?.ok) {
      showToast(`连接成功：${r.model || llmCfg.value.model || '(默认模型)'}${r.latencyMs != null ? ` · ${r.latencyMs}ms` : ''}`, 'success')
    } else {
      showToast(`连接失败：${r?.error || '未知错误（看主进程日志）'}`, 'error')
    }
  } catch (e: any) {
    showToast(`测试异常：${e?.message || e}`, 'error')
  } finally {
    llmTesting.value = false
  }
}

async function llmSave() {
  if (llmSaving.value) return
  llmSaving.value = true
  try {
    const cfg: Record<string, unknown> = {
      baseUrl: llmCfg.value.baseUrl.trim(),
      model: llmCfg.value.model.trim(),
      timeout: llmCfg.value.timeout,
    }
    // 掩码/空 = 没改密钥，不回传（主进程还有 isMaskedKey 防线）
    const key = llmCfg.value.apiKey.trim()
    if (key && key !== '***') cfg.apiKey = key
    const r: any = await window.tegula.llmSetConfig(cfg)
    if (r?.ok !== false) {
      showToast('模型通道已保存（本机 llm-config.json）', 'success')
      await llmLoad()
    } else {
      showToast(r?.error || '保存失败', 'error')
    }
  } catch (e: any) {
    showToast(`保存异常：${e?.message || e}`, 'error')
  } finally {
    llmSaving.value = false
  }
}

async function llmReset() {
  if (llmResetting.value) return
  llmResetting.value = true
  try {
    await window.tegula.llmResetConfig()
    showToast('已重置（密钥保留——想换钥匙直接改填新值保存）', 'info')
    await llmLoad()
  } catch (e: any) {
    showToast(`重置异常：${e?.message || e}`, 'error')
  } finally {
    llmResetting.value = false
  }
}

// ── 决策卡（2026-10-12 AI 规划包第 3 件；2026-10-14 整块切到组件）──────────
// 数据真身在主进程（data/decisions.ts，与 Python CLI 双腿同文件）；
// 视图本体（状态、IPC 读写、渲染）已搬到 `components/DecisionBoard.vue` ——
// 搬走的理由见模板里那段注释（Tailwind `content` 不能扫 App.vue）。
// ⚠ 这里**不再留**任何 dec* 状态或函数：留着就是"定义零引用"的死代码，
//   `check-template-bindings` 会判红。数据加载改由组件 onMounted 承担（进门即拉）。

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
      const zipMB = res.localBytes ? ' · 包 ' + (res.localBytes / 1024 / 1024).toFixed(1) + ' MB' : ''
      showToast(`备份成功 · ${res.files} 个文件${zipMB}${cloud}`, 'success')
    } else {
      const first = (res && res.errors && res.errors[0]) || r.error || '未知错误'
      showToast('备份失败：' + first, 'error')
    }
    await bkLoadList()
    await bkRefreshStatus()
    void bkLoadSizeReport()
  } finally {
    bkBusy.value = false
  }
}

/**
 * 打开「最近一次备份」所在目录。
 * 2026-09-22：这个函数此前**定义了但没有任何入口**（死代码）—— 已接到备份区按钮上。
 * 顺带把原来只认 `\` 的切分改成跨平台（用正则去掉最后一段路径）。
 */

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
          // ⚠ 必须把主进程那句话**原样带出来**：它点名了「第几条 / 哪个字段名 / 可用字段」。
          //   此前这里写死 `showToast('导入失败')` —— 等于把刚做好的防呆提示又吞回去，
          //   用户只知道"失败了"，还是不知道该改哪个字（2026-10-14 开发清单第 6 条）。
          else showToast(res.error || '导入失败', 'error')
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
  // 驻留时长（2026-10-05 用户：「绿色横幅驻留时间太短，根本看不清写了什么就没了」）：
  // 固定 2s 改掉 —— 错误/引导类文案本来就更长，2s 只够看前半句。
  // 按长度给：短句 4s 起，长句最多 9s。
  const ms = Math.min(9000, Math.max(4000, String(msg || '').length * 90))
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.show = false }, ms)
}
let toastTimer: ReturnType<typeof setTimeout> | null = null

// ── 撤销条（2026-10-21 暮雨报障）─────────────────────────────────────────
// 状态与动作搬进 `renderer/undo.ts`：决策卡（子组件）也要能 offer，条子必须全站只有一条。
// 这里只留"日志类撤销"的连接逻辑 —— 它依赖本文件的 loadLogs / loadLogsForTask。

/** 撤销条按钮 / Ctrl+Z 的共用入口：异常统一转 toast（`undo.ts` 只管状态，不依赖 UI 提示） */
function runUndo(): Promise<boolean> {
  return runUndoCore((msg) => showToast(msg, 'error'))
}
/** 历史面板里点某一条：把它及之后一起撤掉（2026-10-30 多级栈） */
const undoHistOpen = ref(false)
async function undoTo(index: number): Promise<void> {
  const n = await runUndoToCore(index, (msg) => showToast(msg, 'error'))
  if (!undoCount.value) undoHistOpen.value = false
  if (n > 0) showToast(`已撤回 ${n} 步`, 'success')
}

// ── 任务状态的撤销快照（2026-10-30 暮雨第 5 条）────────────────────────
// 误点「通过」是最容易发生、也最气人的一次误操作。以前 acceptTask 成功后就只剩
// 「再手动改回来」；现在任何改状态的动作都先拍一张快照（状态 + 结果记录 + 驳回理由），
// 撤销时原样写回去 —— 不是"改成待办"，是真的回到点之前那一格。
interface TaskSnap {
  status: string
  result_log: string
  reject_reason: string
  reject_at: string
  archived: boolean
}
function snapOfTask(id: string): TaskSnap | null {
  const t: any = tasks.value.find((x: any) => x.id === id)
  if (!t) return null
  return {
    status: String(t.status || ''),
    result_log: String(t.result_log ?? t.fm?.result_log ?? ''),
    reject_reason: String(t.reject_reason ?? t.fm?.reject_reason ?? ''),
    reject_at: String(t.reject_at ?? t.fm?.reject_at ?? ''),
    archived: !!t.archived,
  }
}
/** 把任务写回快照。文件已在归档区就先搬回活跃区（只影响位置，不改状态）。 */
async function restoreTaskSnap(id: string, snap: TaskSnap): Promise<void> {
  const cur: any = tasks.value.find((x: any) => x.id === id)
  if (cur?.archived && !snap.archived) {
    await window.tegula.unarchiveTask(id)
  }
  const r: any = await window.tegula.editTask(id, {
    status: snap.status,
    result_log: snap.result_log,
    reject_reason: snap.reject_reason,
    reject_at: snap.reject_at,
  })
  if (!r?.ok) throw new Error(r?.error || '写回失败')
  if (snap.archived && !cur?.archived) {
    const a: any = await window.tegula.archiveTask(id)
    if (!a?.ok) throw new Error(a?.error || '搬回归档区失败')
  }
  await loadAll()
}
/** 日志「完成 / 归档」撤销：按**动作前的快照**原样写回（2026-10-30 第 5 条）。
 *  以前这里统一 reopen 到「待处理」—— 那会吃掉用户手动标的「进行中」和保留天数，
 *  不是撤销，是另一种改动。快照由调用点在动作前拍好（那时 logs.value 还是旧值）。 */
function offerLogReopenUndo(label: string, ids: string[], sources?: any[]): void {
  const from = Array.isArray(sources) && sources.length ? sources : logs.value
  const snaps = ids.map((id) => {
    const l: any = from.find((x: any) => x && x.id === id)
    if (!l) return null
    return {
      id,
      snap: {
        status: l.status,
        running: !!l.running,
        agentDone: !!l.agentDone,
        completed: l.completed || null,
        retainDays: l.retainDays ?? null,
        retainUntil: l.retainUntil || null,
        note: l.note || '',
        archiveNote: l.archiveNote || '',
      },
    }
  }).filter(Boolean) as Array<{ id: string; snap: any }>
  offerUndo(label, async () => {
    let ok = 0
    for (const s of snaps) {
      try {
        const r: any = await window.tegula.logsRestoreState(s.id, s.snap)
        if (r && r.ok) ok++
      } catch { /* 单条失败不中断：下面按 ok 数说实话 */ }
    }
    await loadLogs()
    // 任务详情的「关联日志」列表是另一份数据（logsForTask），不跟着 loadLogs 刷 ——
    // 不补这一句，在任务详情里点完「撤销」列表还显示「已完成」，等于没撤。
    await loadLogsForTask(previewTask.value?.id || '')
    if (ok === snaps.length) showToast(snaps.length > 1 ? `已撤回：${ok} 条回到动作前` : '已撤回，回到动作前', 'success')
    else showToast(`只撤回了 ${ok}/${snaps.length} 条（其余可能已被改动），刷新后见列表`, 'error')
  })
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
    message: `方寸的后台代码是旧的（${why}）—— 请用「托盘图标右键 → 退出」彻底关掉再重启 npm run dev。关窗只是隐藏窗口，不会重启进程；界面会热更新，后台不会`,
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

/**
 * 清理旧日志（2026-10-17 暮雨第 5 条：「日志越堆越多，但没有任何清理机制」）。
 * days > 0 = 删更早的；days <= 0 = 全清（当天那份只截断，马上还能接着写）。
 * 只动方寸自己的运行日志，不碰任何任务数据。
 */
async function purgeLogs(days: number): Promise<void> {
  const what = days > 0 ? `${days} 天前的日志文件` : '全部日志（当天那份会被清空）'
  if (!confirm(`清理${what}？\n\n只删方寸自己的运行日志，不动任务、备份和任何数据文件。`)) return
  try {
    const r: any = await window.tegula.applogPurge?.(days)
    if (r && r.ok) {
      showToast(`已清理 ${r.removed} 个日志文件${r.kept ? `，还有 ${r.kept} 个保留` : ''}`, 'success')
    } else {
      showToast(`清理失败：${(r && r.error) || '主进程没有返回结果'}`, 'error')
    }
  } catch (e: any) {
    showToast(`清理失败：${e?.message || e}`, 'error')
  }
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

// ── 免责与知情声明（2026-10-16 暮雨第 1 条）─────────────────────────────
// 首启强制：没确认过（或声明版本抬格了）就先弹它，**确认之前不跑首次运行向导**
// （"先同意再用"，与绒花墨坊同口径）。随时可查：设置页「诊断」里有入口。
const disclaimerOpen = ref(false)
const disclaimerMode = ref('view')      // 'first-run' = 强制；'view' = 随时查看
const disclaimerAckedAt = ref('')
/** 首启强制确认之后才跑的引导（同意前一律推迟） */
let pendingAfterDisclaimer: (() => void) | null = null

function openDisclaimer(mode = 'view'): void {
  disclaimerMode.value = mode
  disclaimerAckedAt.value = ackedDisclaimerAt()
  disclaimerOpen.value = true
}

function onDisclaimerAck(): void {
  disclaimerOpen.value = false
  const fn = pendingAfterDisclaimer
  pendingAfterDisclaimer = null
  if (fn) fn()
}

/** 免责确认之后才跑的引导（目前只有首次运行向导） */
function bootAfterDisclaimer(): void {
  checkFirstRun()
}

/**
 * 待办视图的控制器（2026-10-23 · 拆分第 10 块）：把 `useTodos()` 的全部返回值 +
 * 四个不归待办模块的父组件能力打包成**一个** reactive 对象，作为唯一 prop 传给
 * `views/TodosView.vue`。
 *
 * ⚠ 为什么必须 `reactive()` 包一层：`useTodos()` 返回的是一堆 ref，直接当 prop 传下去，
 *   子组件模板**不会**自动解包（解包只作用于 `<script setup>` 顶层绑定），
 *   于是 `ctl.todoFilter` 拿到的是 Ref 对象 —— 下拉框显示成 "[object Object]"、
 *   `ctl.todoBatchMode` 恒为真。reactive 的属性访问会解包，子组件的写法才和原来逐字一致。
 *
 * ⚠ 为什么放在文件末尾、而不是 `useTodos()` 那一行：`todoDragOver` 是 `const computed`，
 *   在上面构建对象会撞 TDZ（ReferenceError: Cannot access 'todoDragOver' before initialization）。
 *   函数声明会提升，`const` 不会 —— 这个顺序是硬约束，别为了"看着整齐"往上挪。
 */
const todoViewCtl = reactive({
  ...todosApi,
  projects,
  todoView,
  todoDragOver,
  // 「拖入导入」的接收口 + 右键菜单 + 撤销已转出 + 转日志确认 + 指派日期：
  // 都在本文件里（各自的弹窗 / 拖拽态也在这里），所以只把函数本身递过去。
  onTodoDrop, openTodoMenu, undoConverted, askConvertTodo, openCalAssignTodo,
  // 到期日的悬停说明（「逾期 N 天」/「还剩 N 天」的整句话），读的字段散在 deadline/due/dueTime 上，
  // 所以留在本文件而不是搬进 useTodos（搬过去会牵动日历那一套时间口径）。
  todoDueTitle,
  // 拖拽高亮三件套是全站的拖拽态，不是待办私有 —— 组件只调，不改它的归属。
  dragEnter, dragPulse, dragLeave,
})

/**
 * 日志清理归档弹窗 / 日志只读预览的控制器（2026-10-31 · 浮层刀第四、五块）。
 * 与其余弹窗同一套：reactive 包一层，子组件 toRef 接状态、解构接动作。
 */
const logPurgeCtl = reactive({
  logPurgeOpen, logPurgeDate, logPurgeBusy, logPurgePreview,
  resetLogPurgePreview, runLogPurgePreview, executeLogPurge, closeLogPurge,
})
const logPreviewCtl = reactive({
  logPreview, projects, logStatusClass, logStatusLabel, copyId, attachAdd, isImageRel,
  attachSrc, attachName, attachOpenHint, attachOpen, attachRemove, openLogFromPreview, copyLogAsPrompt,
})

/**
 * 接力对话框的控制器（2026-10-31 · 渲染层拆分「浮层刀」第三块）：
 * 与日志编辑同一套 —— `reactive()` 包一层，子组件 `toRef` 接状态、解构接动作。
 * ⚠ 必须放在文件末尾（`relayDirtyHint` 是 computed，前面构建会撞 TDZ）。
 */
const relayCtl = reactive({
  relay_, relayDiscard_, relayDirtyHint, projects, agentPresets,
  closeRelay, bringSourceNextSteps, discardRelay, executeRelay,
})

/**
 * 日志编辑弹窗的控制器（2026-10-31 · 渲染层拆分「浮层刀」第二块）：与任务预览同一套 ——
 * `reactive()` 包一层再当 prop 传，子组件 `toRef` 接状态、解构接动作。
 *
 * ⚠ 必须放在文件末尾：`logTaskOptions` / `logPendingCount` 等是 `const`，前面构建会撞 TDZ。
 * ⚠ 这个弹窗要能在任何视图下打开（从日历点日志），所以不能放进 LogsView。
 */
const logEditCtl = reactive({
  logEdit_, logCompleting, logArchiveMode, logRetainDays, logRetainDefault, logNote,
  logTaskOpen, logTaskQuery, logTaskOptions, logTaskMoreHidden, logTaskExtra,
  projects, agentPresets, logAttachDragOver, logPendingCount, logPendingPaths, logPendingData,
  logDiscard_, logVersions, logHistoryOpen, logVersionBusy, logVersionPreview,
  closeLogEditor, closeLogNow, discardLogEdit, logDirtyNames, logEditDirty,
  onLogPaste, onLogAttachDragEnter, onLogAttachDragLeave, onLogAttachDrop,
  taskTitleOf, unlinkLogTask, addLogTaskExtra,
  attachPickOrAdd, pendingBaseName, isImageRel, attachSrc, attachName, attachOpenHint, attachOpen, attachRemove,
  toggleLogHistory, previewLogVersion, restoreLogVersionItem, versionSizeText,
  copyId, copyLogAsPrompt, destroyLogItem, saveLogFieldsOnly, saveLogEdit,
})

/**
 * 任务预览弹窗的控制器（2026-10-31 · 渲染层拆分「浮层刀」第一块）：与看板 / 日志同一套 ——
 * `reactive()` 包一层再当 prop 传，子组件 `toRef` 接状态、解构接动作。
 *
 * ⚠ 必须放在文件末尾：`previewArch` / `taskLogs` / `taskCommits` 都是 `const`，
 *   在前面构建会撞 TDZ。弹窗本身由父组件的 `v-if="previewTask"` 决定挂不挂。
 */
const taskPreviewCtl = reactive({
  previewTask, previewArch, rejectEdit, rejectEditText, rejectSaving,
  taskLogs, taskCommits, taskCommitsLoading,
  previewTimeLabel, rejectReasonOf, startRejectEdit, saveRejectEdit, onBodyChange,
  openLogPreview, quickCompleteLog, reopenLogItem, openLogForTask,
  logStatusClass, logStatusLabel,
  restoreTask, openReview, forceCloseTask, openDirectReject, archiveTask,
  openEdit, openCalAssignTask, copyId, openTaskFile, copyTaskClick, deleteTask,
})

/**
 * 看板视图的控制器（2026-10-31 · 渲染层拆分第二批）：与 `logsViewCtl` 同一套做法 ——
 * `reactive()` 包一层再当 prop 传，子组件用 `toRef` 接成顶层绑定，**模板一字不改**。
 *
 * ⚠ 必须放在文件末尾：`columns` / `cardWallGroups` / `boardClass` 都是 `const`，
 *   在前面构建会撞 TDZ。三种摆法共用这一份状态，拆开后没有第二份。
 */
const boardViewCtl = reactive({
  boardClass, boardView, columns, cardWallGroups, cardWallOpenOnly,
  groupMode, batchMode, selectedBatch, collapsedGroups, dragoverCol, draggingId,
  onDragStart, onDragOver, onDrop, onCardEnter, onCardLeave, onCardMenuPick,
  openCard, openColumnMenu, openReview, copyId, cw,
  toggleGroup, groupCollapsed, groupAllSelected, groupSomeSelected, toggleGroupSelect,
  toggleBatchSelect, isStale, isOverdue, cardDate, projShort, normProject, rejectReasonOf,
})

/**
 * 日志视图的控制器（2026-10-23 · 拆分第 11 块）：与 `todoViewCtl` 同一套做法 ——
 * `reactive()` 包一层再当 prop 传，子组件用 `toRef` 接成顶层绑定，**模板一字不改**。
 *
 * ⚠ 与待办那条一样：必须放在文件末尾（`logDragOver` / `renderSections` / `logsViewMode`
 *   都是 `const`，在前面构建会撞 TDZ）。
 *
 * ⚠ 日志的**弹窗不在这里**：编辑框 / 接力框 / 清理归档框都留在本文件 —— 它们要能在
 *   任何视图下打开（从日历点一条日志就会调 `openLog`，那时 `curView` 不是 logs）。
 */
const logsViewCtl = reactive({
  // 状态（含 4 个 computed：logMoreFilterCount / filteredLogs / renderSections / logDragOver）
  logSearchInput, logProjectFilter, logSort, logMoreFilterOpen, logMoreFilterCount,
  logAgentFilter, logDateFrom, logDateTo, logBatchMode, selectedLogBatch,
  logsViewMode, filteredLogs, visibleLogs, renderSections, logDragOver,
  projects, agentPresets,
  logGroupChildren, logGroupParent, logHasGroup, logGroupStat, logGroupHiddenCount, logRunningLabel,
  // 读 / 筛 / 排序
  loadLogs, executeLogSearch, toggleLogMoreFilter, clearLogMoreFilters,
  setLogsViewMode, toggleLogGroup, isLogGroupCollapsed,
  // 单条
  openNewLog, openLog, openLogMenu, onLogCardClick, openRelay, openLogPurge,
  copyId, copyLogAsPrompt, copyLogsAsPrompt, askConvertLog, openLogPreview,
  toggleLogRunning, completeLogItem, reopenLogItem, archiveLogItem, destroyLogItem,
  executeLogCleanup, importLogFile,
  // 主日志 + 附属日志（2026-10-30 第 4 条）
  openLogAttach, toggleLogGroupRunning, completeLogGroupItem, copyLogGroupAsPrompt, logGroupAllRunning,
  // 批量
  toggleLogBatchMode, toggleSelectAllLogs,
  executeBatchLogPriority, executeBatchLogComplete, executeBatchLogArchive, executeBatchLogDestroy,
  // 卡面派生（读 log 对象，纯显示）
  logStatusClass, logStatusLabel, logPrioKey, truncate, shortLogId,
  // 拖入导入 + 拖拽高亮
  onLogDrop, dragEnter, dragPulse, dragLeave,
})

/**
 * 点系统通知 → **回到具体对象**（2026-10-29 · dsh-notify-tray 借鉴 #2）。
 *
 * 光把窗口拉到前台不够：通知说的是「任务逾期：X」，用户点了却只看到一屏卡片，还得自己找。
 * 这里按 type 切视图，再把那张卡打开；对象已经不在了就**说出来**（不许静默什么都不做）。
 */
async function onNotifyFocus(p: any): Promise<void> {
  const type = String(p?.type || '')
  const id = String(p?.sourceId || '')
  if (type === 'todo-due') { switchView('todos'); return }
  if (type === 'parse-error') { showToast('任务文件解析失败：' + id, 'error'); return }
  if (type === 'backup-failed') { switchView('settings'); return }
  if (!id) return
  switchView('board')
  let t = (tasks.value || []).find((x: any) => x.id === id)
  if (!t) {
    try { await loadAll() } catch { /* 读不到就走下面的"不在了" */ }
    t = (tasks.value || []).find((x: any) => x.id === id)
  }
  if (t) openCard(t)
  else showToast('这条通知指向的对象已经不在了：' + id, 'info')
}

// 设置页各页签通过 provide 共享同一组 ref（拆分第七刀）——不传几十个 props，也不会出现第二份状态。
provide('fc-settings', {
  appVersion, updateState, checkUpdate, downloadUpdate, installUpdate,
  disableGpu, onDisableGpuChange, THEME_LIST, theme, setTheme,
  APPEARANCE_LIST, appearance, setAppearance,
  IDEA_TEXT_DEFAULT, IDEA_TEXT_HARD_MAX, IDEA_TEXT_MIN, ideaMaxChars, onIdeaMaxChange,
  views, collapsedViews, VIEWS_MIN_VISIBLE, onViewVisibleChange, resetCollapsedViews,
  appLogFile, openAppLogDir, copyAppLogPath, showAppLogFromSettings, purgeLogs, openDisclaimer,
  diagSelf, diagSkills, diagActivity, diagBusy, runSelfCheck, checkSkillsCopies, loadDiagActivity, relativeTime,
  addAgentPreset, addPriceRow, agentPresets, applyLlmPreset, confirmLlmPreset, fmtShort, idleCfg, idleSave, idleSaving, llmCfg, llmHostOf, llmKeyHint, llmLastCall, llmPresetPending, llmReset, llmResetting, llmSave, llmSaving, llmTest, llmTesting, loadUsageStats, newAgentName, priceMsg, priceRows, priceSaving, removeAgentPreset, savePrices, usageStats_,
  copyPolicyText, openPolicyEdit, openProjectInSettings, policyMap, projects,
})

onMounted(() => {
  // 测试专用（假 preload 才有 __fcTest）：清空撤销栈。多级栈之后，
  // 「撤一步 → 条子消失」不再天然成立，e2e 需要一个"从零开始"的按钮。
  const fcTest = (window as any).__fcTest
  if (fcTest && typeof fcTest === 'object') fcTest.clearUndo = () => dismissUndo()
  // 点通知回到具体对象（2026-10-29 dsh-notify 借鉴 #2）；preload 没这个通道时静默跳过，不留僵尸监听
  try { offNotifyFocus = (window as any).tegula?.onNotifyFocus?.((pp: any) => { void onNotifyFocus(pp) }) || null } catch { offNotifyFocus = null }
  // ⚠ 免责声明优先于一切引导：没同意之前不弹数据目录向导（先同意再用）。
  //   同意后由 onDisclaimerAck 接着跑 bootAfterDisclaimer()。
  if (!hasAckedDisclaimer()) {
    disclaimerMode.value = 'first-run'
    disclaimerOpen.value = true
    pendingAfterDisclaimer = bootAfterDisclaimer
  } else {
    bootAfterDisclaimer()
  }
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
  // 模型通道配置（2026-10-16）：启动就读一次 —— 「AI 规划」弹窗要靠它判断配没配，
  // 只在打开设置页时才读的话，没进过设置页的用户会一直看到"还没配"（界面说假话）。
  void llmLoad()
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

// 点系统通知回到对象（2026-10-29）：主进程 `notify:focus` → 这里切视图并开卡。
let offNotifyFocus: null | (() => void) = null

onUnmounted(() => {
  if (offNotifyFocus) { try { offNotifyFocus() } catch { /* ignore */ } ; offNotifyFocus = null }  if (dragTimer) { clearTimeout(dragTimer); dragTimer = null }
  if (cardTipTimer) { clearTimeout(cardTipTimer); cardTipTimer = null }  document.removeEventListener('keydown', onShortcutKeydown)
  window.removeEventListener('fc-app-error', onAppError as EventListener)
  window.removeEventListener('dragend', dragResetAll)
  window.removeEventListener('drop', dragResetAll)
})
</script>

<style src="./styles/app.css"></style>

