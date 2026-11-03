<template>
    <main id="board" class="pv">
      <div class="alertbar" v-if="ctl.blockers.length">
        <span class="ico">⚠</span>
        <b>{{ ctl.blockers.length }}</b> 个任务存在阻塞依赖
      </div>
      <!-- 项目页工具条（2026-10-17 暮雨第 6 条：“项目里面不能新建项目，点进去是新建任务”）。
           真因：新建项目弹窗与 confirmNewProject 早就写好了（`#proj-new-modal`），
           **但项目页从来没有一个按钮去打开它** —— 功能做完没接线，属于"看着有、其实没有"。
           删除入口原来只在每张项目卡右上角那个小 🗑 上，这里明写出来省得再找。 -->
      <div class="pv-tools">
        <button class="pri" title="在 registry.yaml 里登记一个新项目" @click="ctl.openNewProject">＋ 新建项目</button>
        <span class="pv-tools-hint">删除项目登记：每张项目卡右上角的 🗑（只删登记，不动任务卡与文件）</span>
      </div>
      <!-- 第 7 条：项目章程缺口一眼可见 + 一键补骨架（原先只能逐个点开卡看） -->
      <div class="charter-bar">
        <span class="cb-label">项目章程</span>
        <span class="cb-stat">已填 <b>{{ ctl.charterStats.filled }}</b> / {{ ctl.charterStats.total }}</span>
        <span class="cb-stat" v-if="ctl.charterStats.skeleton">骨架待填 <b>{{ ctl.charterStats.skeleton }}</b></span>
        <span class="cb-stat warn" v-if="ctl.charterStats.missing">缺失 <b>{{ ctl.charterStats.missing }}</b></span>
        <!-- 029 验收驳回原话：“找不到在哪里”。
             真因：结构地图**只存在于方针卡文件里**，界面上唯一相关的东西是这个
             `<span>` 计数 —— 它不可点、且没有缺口时干脆不渲染，于是"结构地图到底在哪"无从得知。
             现在换成**常驻可点按钮**：没缺口时也在，点开就是一览（哪几张有、最后核实的日期、直接去改）。 -->
        <button class="ghost cb-map-btn" :class="{ warn: ctl.charterStats.mapMissing > 0 }"
          :title="ctl.charterStats.mapMissing
            ? `还有 ${ctl.charterStats.mapMissing} 个项目没有结构地图 —— 点开看是哪些`
            : '结构地图：模块清单 + 每模块一句话职责 + 主数据流（点开查看/编辑）'"
          @click="ctl.openStructMap()">
          🗺 结构地图
          <b v-if="ctl.charterStats.mapMissing" class="cb-map-n">待填 {{ ctl.charterStats.mapMissing }}</b>
          <b v-else class="cb-map-n ok">{{ ctl.charterStats.mapReady }}/{{ ctl.charterStats.filled }}</b>
        </button>
        <button class="ghost" v-if="ctl.charterStats.missing" @click="ctl.fillMissingCharters()">
          ＋ 补齐 {{ ctl.charterStats.missing }} 个章程骨架
        </button>
      </div>
      <!-- 跨项目建议（2026-10-11，C 组死通道接回）：主进程早就算好了（卡住/空闲项目一句话），
           界面从来没有入口。放在项目页顶部 —— 它是"看全局"的话，不属于某一个项目。 -->
      <div class="cross-suggest" v-if="ctl.crossSuggest.length">
        <span class="cs-label">建议</span>
        <span v-for="(s, i) in ctl.crossSuggest" :key="i" class="cs-item">{{ s }}</span>
      </div>
      <!-- ══ ① 项目墙（默认，旧摆法原样保留 —— 加视图不改旧的）══════════════ -->
      <div class="pvgrid" v-if="ctl.pvView === 'tiles'">
        <div
          v-for="p in ctl.projectStats"
          :key="p.id"
          class="tile"
          :class="'t-' + p.health"
          @click="ctl.openProject(p)"
        >
          <div class="trow">
            <span class="tname">{{ p.name }}</span>
            <button class="proj-del" title="移除项目登记（只删登记，不动任务卡与文件）"
                    @click.stop="ctl.removeProject(p)">🗑</button>
            <span class="thealth">{{ ctl.healthLabel(p.health) }}</span>
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
              <div class="progress-bar"><div class="progress-fill" :style="{width: ctl.projectProgress[p.id] ? ctl.projectProgress[p.id].percent + '%' : '0%'}"></div></div>
              <div class="l">{{ ctl.projectProgress[p.id] ? ctl.projectProgress[p.id].percent + '%' : '—' }} 完成</div>
            </div>
            <div class="ts">
              <div class="n warn" v-if="p.health === 'stuck'">⚠</div>
              <div class="l">{{ p.lastActivity ? ctl.relativeTime(p.lastActivity) : '无记录' }}</div>
            </div>
          </div>
          <!-- 方针入口挪到项目页签（用户 2026-09-25 第 3 条）：原先只藏在“设置”最底部，
               找不着；这里放在项目卡上，一眼可见，且不必先关设置。 -->
          <button class="ghost pv-policy" @click.stop="ctl.openPolicyEdit(p.id)">
            {{ ctl.policyMap[p.id] ? '📋 方针已立 · 查看/编辑'
               : ctl.policyExistsMap[p.id] ? '📝 方针待填 · 打开填写'
               : '＋ 立项目方针' }}
          </button>
          <!-- 架构图（2026-10-29 暮雨第 2 条；2026-10-30 第 3 条再改）：
               以前是相邻两个几乎同名的按钮（“架构图”“自绘架构图”）—— 暮雨原话
               “和架构图按钮放在一起你自己不觉得尴尬吗”。现在收成**一个分段控件**：
               左半“架构图”= 打开仓库里已有的 archify 产物；右半“绘制架构图”= 方寸只读扫源码画一张。
               一个控件、两种来源，不再是两个抢位置的按钮。 -->
          <div class="pv-arch-group" role="group" aria-label="架构图">
            <button class="ghost pv-diagram" @click.stop="ctl.openProjectDiagram(p)"
              title="打开这个项目的架构图（仓库 docs/ 里 archify 生成的 HTML）；没有就先让 archify 生成一份放进去">架构图</button>
            <button class="ghost pv-archself" @click.stop="ctl.openSelfArch(p)"
              title="绘制架构图：方寸只读扫源码，节点 = 真实目录、连线 = 真实 import / IPC 计数；先过校验、你点头才允许导出">✎ 绘制架构图</button>
          </div>
        </div>
        <div class="tile tile-add" @click="ctl.openNewProject">
          <div class="add-icon">+</div>
          <div class="add-text">添加项目</div>
        </div>
      </div>

      <!-- ══ ② 概览卡（2026-09-29 用户选的改法 A）══════════════════════════
           003 卡原话“只是个大号看板入口，不是项目管理”。把“四个数字”换成
           “状态分布条 + 最近动态 + 阻塞/方针/结构地图缺口”——
           一眼能看出这个项目卡在哪、缺什么、下一步该点哪个按钮。 -->
      <div class="ovgrid" v-else-if="ctl.pvView === 'overview'">
        <div v-for="p in ctl.projectStats" :key="p.id" class="ocard" @click="ctl.openProject(p)">
          <div class="ohead">
            <span class="nm">{{ p.name }}</span>
            <span class="rp">{{ p.repo || '未登记工作目录' }}</span>
            <span class="hl" :class="'hl-' + p.health">{{ ctl.healthLabel(p.health) }}</span>
          </div>
          <div class="stack" :title="ctl.pvBreakdown[p.id] && ctl.pvBreakdown[p.id].length ? '状态分布：' + ctl.pvBreakdown[p.id].map(s => s.status + ' ' + s.n).join(' · ') : '这个项目还没有任务'">
            <i v-for="s in (ctl.pvBreakdown[p.id] || [])" :key="s.status"
               :style="{ width: ctl.segWidth(s.n, p.taskCount), background: ctl.statusSegColor(s.cls) }"></i>
          </div>
          <div class="legend">
            <span v-for="s in (ctl.pvBreakdown[p.id] || [])" :key="s.status">
              <s :style="{ background: ctl.statusSegColor(s.cls) }"></s>{{ s.status }} {{ s.n }}
            </span>
            <span v-if="!(ctl.pvBreakdown[p.id] || []).length">这个项目还没有任务</span>
          </div>
          <div class="odyn">
            最近：<b>{{ p.lastActivity ? ctl.relativeTime(p.lastActivity) : '无记录' }}</b>
            <template v-if="ctl.pvLatest[p.id]"> · {{ ctl.pvLatest[p.id]!.title || ctl.pvLatest[p.id]!.id }}</template>
            <br>
            <span v-if="ctl.pvBlocked[p.id]" class="odyn-warn">⚠ {{ ctl.pvBlocked[p.id] }} 个阻塞源</span>
            <span :class="{ 'odyn-warn': !ctl.policyMap[p.id] }">方针：{{ ctl.policyMap[p.id] ? '已立' : ctl.policyExistsMap[p.id] ? '待填' : '未立' }}</span>
            ·
            <span :class="{ 'odyn-warn': !ctl.policyMapHasStructure[p.id] }">结构地图：{{ ctl.policyMapHasStructure[p.id] ? '有' : '没有' }}</span>
            <span v-if="p.health === 'stuck' || p.health === 'dormant'"> · 这个项目已经冷下来了</span>
          </div>
          <div class="oacts">
            <button class="ghost oact" @click.stop="ctl.openPolicyEdit(p.id)">📋 {{ ctl.policyMap[p.id] ? '方针' : '立方针' }}</button>
            <button class="ghost oact" @click.stop="ctl.openStructMap()">🗺 结构地图</button>
            <button class="ghost oact" @click.stop="ctl.openProjectTasks(p)">📦 任务 {{ p.taskCount }}</button>
            <button class="ghost oact" @click.stop="ctl.removeProject(p)"
                    title="只从 registry.yaml 移除登记；任务卡与项目文件都不动">🗑 移除登记</button>
          </div>
        </div>
        <div class="ocard ocard-add" @click="ctl.openNewProject">
          <div class="add-icon">+</div>
          <div class="add-text">添加项目</div>
        </div>
      </div>

      <!-- ══ ③ 主从（2026-09-29 用户选的改法 B）════════════════════════════
           左列常驻项目 + 迷你进度，右侧摊开所选项目的详情。
           项目 10+ 时比项目墙好使；现在项目少，用哪个都行 —— 所以做成可切。 -->
      <div class="pv-ms" v-else-if="ctl.pvView === 'master'">
        <div class="ms-list">
          <div v-for="p in ctl.projectStats" :key="p.id" class="ms-li"
               :class="{ on: !!ctl.pvCurrent && ctl.pvCurrent.id === p.id }"
               @click="ctl.pvSelected = p.id">
            <span class="ms-dot" :class="'t-' + p.health"></span>
            <span class="ms-name">{{ p.name }}</span>
            <span class="ms-mini"><i :style="{ width: ctl.projectPercent(p.id) + '%' }"></i></span>
            <span class="ms-n">{{ p.activeTasks }}</span>
          </div>
          <div class="ms-add" @click="ctl.openNewProject">＋ 添加项目</div>
        </div>
        <!-- 项目监控台（卡 task-20261009-001）：环形进度 + KPI 大数字 + 阻塞入口 + git 活动。
             健康度=左缘 4px 色条（契约“异常才显示”：stuck/dormant 才有，active/idle 干净白卡）。 -->
        <div class="ms-detail" v-if="ctl.pvCurrent" :class="'hs-' + ctl.pvCurrent.health">
          <div class="ocard bare">
            <div class="ohead">
              <span class="nm">{{ ctl.pvCurrent.name }}</span>
              <span class="rp">{{ ctl.pvCurrent.repo || '未登记工作目录' }}</span>
              <span class="hl" :class="'hl-' + ctl.pvCurrent.health">{{ ctl.healthLabel(ctl.pvCurrent.health) }}</span>
            </div>
            <!-- 自仓同步状态（2026-10-21 · W1-1C）：只在**没跟上**时出现一句话。
                 正常态不渲染（不写“已是最新”凑数），也不给手动按钮 —— 启动自动拉，
                 拉不动就照实说"待同步"，本地数据一个字不动。 -->
            <!-- 常驻一行：正常是灰字"已是最新"，异常才变色（2026-10-21：看不见就等于不存在） -->
            <div class="ms-sync" :class="'ms-sync-' + ctl.selfSyncLine.tone" v-if="ctl.selfSyncLine">
              <template v-if="ctl.selfSyncLine.tone === 'warn'">⚠ </template>{{ ctl.selfSyncLine.text }}
            </div>
            <div class="ms-metrics">
              <!-- 0 卡时不画假环：环换成空态占位（0/0 没有“完成度”可言），旁边图例给“还没有任务卡” -->
              <div class="ms-ring" v-if="ctl.pvCurrent.taskCount">
                <svg viewBox="0 0 36 36" aria-hidden="true">
                  <circle class="ring-track" cx="18" cy="18" r="15.915" pathLength="100" />
                  <circle class="ring-arc" cx="18" cy="18" r="15.915" pathLength="100"
                          :style="{ strokeDasharray: ctl.pvPct + ' ' + (100 - ctl.pvPct) }" />
                </svg>
                <span class="ms-ringnum">{{ ctl.pvPct }}<i>%</i></span>
              </div>
              <div class="ms-ring empty" v-else><span class="ms-ringnum">—</span></div>
              <div class="ms-nums">
                <div class="ms-num"><b>{{ ctl.pvCurrent.activeTasks }}</b><span>进行中</span></div>
                <div class="ms-num"><b>{{ ctl.pvCurrent.completedTasks }}</b><span>已完成</span></div>
                <div class="ms-num"><b>{{ ctl.pvCurrent.taskCount }}</b><span>总任务</span></div>
                <div class="ms-num warn" v-if="ctl.pvBlocked[ctl.pvCurrent.id]"><b>{{ ctl.pvBlocked[ctl.pvCurrent.id] }}</b><span>阻塞源</span></div>
              </div>
            </div>
            <div class="stack">
              <i v-for="s in (ctl.pvBreakdown[ctl.pvCurrent.id] || [])" :key="s.status"
                 :style="{ width: ctl.segWidth(s.n, ctl.pvCurrent.taskCount), background: ctl.statusSegColor(s.cls) }"></i>
            </div>
            <div class="legend">
              <span v-for="s in (ctl.pvBreakdown[ctl.pvCurrent.id] || [])" :key="s.status">
                <s :style="{ background: ctl.statusSegColor(s.cls) }"></s>{{ s.status }} {{ s.n }}
              </span>
              <span v-if="!ctl.pvCurrent.taskCount" class="ms-nothing">还没有任务卡</span>
            </div>
            <!-- 阻塞源入口（异常才显示）：点进阻塞页签看“卡在谁” -->
            <button class="ghost ms-blockers" v-if="ctl.pvBlocked[ctl.pvCurrent.id]"
                    @click.stop="ctl.switchView('blockers')">⚠ {{ ctl.pvBlocked[ctl.pvCurrent.id] }} 个阻塞源 · 看卡在谁 →</button>
            <div class="ody n">
              最近：<b>{{ ctl.pvCurrent.lastActivity ? ctl.relativeTime(ctl.pvCurrent.lastActivity) : '无记录' }}</b>
              <template v-if="ctl.pvLatest[ctl.pvCurrent.id]"> · {{ ctl.pvLatest[ctl.pvCurrent.id]!.title || ctl.pvLatest[ctl.pvCurrent.id]!.id }}</template>
            </div>
            <!-- 项目三字段（2026-10-16 批次第 2 项起的“说明”；2026-10-22 · 06 单扩成三件）：
                 状态 / 路线图 / 说明（欠着什么）都是 registry 里的**手写值**，
                 与下面“自动 · 只读”那块并列摆着 —— 谁旧了由人看，代码不裁。
                 可就地改：改完走全站同一个撤销条，Ctrl+Z 一步退回去（1B 撤销栈的同一套语义）。 -->
            <div class="ms-fields" v-if="ctl.noteEdit && ctl.noteEdit.id === ctl.pvCurrent.id">
              <div class="msf-h">改“{{ ctl.pvCurrent.name }}”的三个手写字段</div>
              <label class="msf">
                <span class="msf-k">状态</span>
                <input class="msf-i" v-model="ctl.noteEdit.状态" placeholder="一句话说到哪了，带时点，比如（0.3.9，10-21）" />
              </label>
              <label class="msf">
                <span class="msf-k">路线图</span>
                <input class="msf-i" v-model="ctl.noteEdit.路线图" placeholder="目标是什么；“不做”的事关键就带半句" />
              </label>
              <label class="msf">
                <span class="msf-k">说明</span>
                <textarea class="msf-t" v-model="ctl.noteEdit.说明" rows="3"
                          placeholder="欠着什么——逐条列，不压不删"></textarea>
              </label>
              <div class="msf-acts">
                <button class="ok" :disabled="ctl.noteSaving" @click.stop="ctl.saveNoteEdit()">{{ ctl.noteSaving ? '保存中…' : '保存' }}</button>
                <button class="ghost" :disabled="ctl.noteSaving" @click.stop="ctl.cancelNoteEdit()">取消</button>
                <span class="msf-tip">保存后顶部出撤销条（Ctrl+Z 也能退）</span>
              </div>
            </div>
            <template v-else>
              <div class="ms-note" v-if="ctl.pvCurrent.statusNow || ctl.pvCurrent.roadmap || ctl.pvCurrent.note">
                <div class="msn-row" v-if="ctl.pvCurrent.statusNow"><span class="msn-k">状态</span><span class="msn-v">{{ ctl.pvCurrent.statusNow }}</span></div>
                <div class="msn-row" v-if="ctl.pvCurrent.roadmap"><span class="msn-k">路线图</span><span class="msn-v">{{ ctl.pvCurrent.roadmap }}</span></div>
                <div class="msn-row" v-if="ctl.pvCurrent.note"><span class="msn-k">说明</span><span class="msn-v">{{ ctl.pvCurrent.note }}</span></div>
              </div>
              <button class="ghost ms-editbtn" @click.stop="ctl.openNoteEdit(ctl.pvCurrent)">✎ 改状态 / 路线图 / 说明</button>
            </template>
            <!-- 路线文档实况（2026-10-21 · W1-批次 2）：把仓库里的 README/ROADMAP **自动**读回来，
                 与上面那句**手写**说明并列摆着 —— 两边不一致本身就是信息（谁旧了），
                 代码不裁也不覆盖。README 只给一句话摘要（用户向的展示公告，不该占版面），
                 ROADMAP 才是"接下来做什么"的正主。读不到就给原因，不糊一句"没有进展"。 -->
            <div class="ms-docs" v-if="ctl.msDocs">
              <div class="ms-docs-h">
                <span class="ms-docs-src" title="自动读自仓库：README / ROADMAP + 最近动过 docs/ 的提交（只读，且只读一天一次）">自动 · 只读</span>
                <span class="ms-docs-at">{{ ctl.msDocs.cached ? '今天读过' : '刚读' }}</span>
              </div>
              <template v-if="ctl.msDocs.readme || ctl.msDocs.roadmap">
                <!-- ROADMAP 在前（"接下来做什么"才是监控台要回答的问题）；README 在后，
                     它是项目**对外**说明，常有一句没信息量的标语 —— 所以默认两行、点开看全文。 -->
                <div class="ms-doc" v-if="ctl.msDocs.roadmap" :class="{ open: ctl.docOpen.roadmap }"
                  :title="ctl.msDocs.roadmap.rel + '（点一下展开 / 收起）'" @click="ctl.toggleDoc('roadmap')">
                  <span class="ms-doc-k">ROADMAP</span>
                  <span class="ms-doc-t">{{ ctl.docOpen.roadmap ? (ctl.msDocs.roadmap.more || ctl.msDocs.roadmap.excerpt) : (ctl.msDocs.roadmap.excerpt || ctl.msDocs.roadmap.title) }}</span>
                  <span class="ms-doc-m">{{ ctl.relativeTime(ctl.msDocs.roadmap.mtime) }}</span>
                </div>
                <div class="ms-doc" v-if="ctl.msDocs.readme" :class="{ open: ctl.docOpen.readme }"
                  :title="ctl.msDocs.readme.rel + '（对外说明，点一下展开 / 收起）'" @click="ctl.toggleDoc('readme')">
                  <span class="ms-doc-k">README</span>
                  <span class="ms-doc-t">{{ ctl.docOpen.readme ? (ctl.msDocs.readme.more || ctl.msDocs.readme.excerpt) : (ctl.msDocs.readme.excerpt || ctl.msDocs.readme.title) }}</span>
                  <span class="ms-doc-m">{{ ctl.relativeTime(ctl.msDocs.readme.mtime) }}</span>
                </div>
              </template>
              <div class="ms-doc-none" v-else>{{ ctl.msDocs.note || '仓库里没有 README / ROADMAP' }}</div>
              <!-- 只有 README 没有 ROADMAP：把这句话说出来，别让人把"对外说明"当成路线 -->
              <div class="ms-doc-none" v-if="(ctl.msDocs.readme || ctl.msDocs.roadmap) && ctl.msDocs.note">{{ ctl.msDocs.note }}</div>
              <div class="ms-docs-log" v-if="ctl.msDocs.docsCommits && ctl.msDocs.docsCommits.length">
                最近 docs 变更 <b>{{ ctl.msDocs.docsCommits.length }}</b> 条 · 最后 <b>{{ ctl.msDocs.docsCommits[0].subject }}</b>（{{ ctl.msDocs.docsCommits[0].date }}）
              </div>
            </div>
            <!-- git 活动：在途一屏的数据已在内存才显示；没拉过给手动入口（不默认付 git 扫描的钱，
                 与 loadViewData“只在切到那一摆法时才拉”的既有纪律一致） -->
            <div class="ms-git" v-if="ctl.msGitRow">
              <span>📂 最近提交 <b>{{ ctl.msGitRow.lastCommit || '读不到' }}</b></span>
              <span>未提交 <b>{{ ctl.msGitRow.dirty === null || ctl.msGitRow.dirty === undefined ? '—' : ctl.msGitRow.dirty }}</b></span>
            </div>
            <button class="ghost ms-gitbtn" v-else @click.stop="ctl.loadTripBoard()">⟳ 拉取提交信息</button>
            <!-- 最近执行日志流（2026-10-11 监控台 P0 之一）：只说"最近在干什么"，
                 不做筛选/分页 —— 要看全的点“看全部 →”，那边才是日志页的主场。 -->
            <div class="ms-feed">
              <div class="ms-feed-h">
                <span>最近执行日志</span>
                <button class="ghost ms-feed-go" @click.stop="ctl.openProjectLogs()">看全部 →</button>
              </div>
              <div class="ms-log" v-for="l in ctl.msLogs" :key="l.id">
                <span class="ms-log-dot" :class="{ run: l.running }"></span>
                <span class="ms-log-t">{{ l.title || l.id }}</span>
                <span class="ms-log-tm">{{ ctl.relativeTime(l.logDate || l.created) }}</span>
              </div>
              <div class="ms-log-none" v-if="!ctl.msLogs.length">这个项目还没有执行日志</div>
            </div>
            <!-- 僵尸卡（P0 之二）：判据与通知中心同源（`findStalledTasks`），这里只是把它**放到监控台上**。
                 只报数 + 可点进去看，不在这里做处置 —— 处置入口在任务卡上。 -->
            <button class="ghost ms-stalled" v-if="ctl.msStalled.length"
              @click.stop="ctl.openProjectTasks(ctl.pvCurrent)"
              :title="ctl.msStalled.map(s => s.title + '（' + s.hours + ' 小时没动静）').join('\n')">
              ⚠ {{ ctl.msStalled.length }} 个任务“进行中”但超过 {{ ctl.STALLED_HOURS }} 小时没动静 · 看看 →
            </button>
            <!-- 建议动作 + 可并行机会（2026-10-11，死通道 A 组收口）：
                 这两条通道早就在主进程算好了，界面此前从不调用（= 死通道）。接上它，
                 用户在这一屏就能看到"这个项目下一步该干嘛、哪几件事可以并着做"。 -->
            <div class="ms-suggest">
              <div class="ms-suggest-h">建议动作</div>
              <div class="ms-suggest-item" v-for="(s, i) in ctl.pvSuggest" :key="'sg' + i">· {{ s }}</div>
              <div class="ms-log-none" v-if="!ctl.pvSuggest.length">（还没有可给的建议）</div>
            </div>
            <div class="ms-suggest" v-if="ctl.pvParallelMine.length">
              <div class="ms-suggest-h">可并行机会</div>
              <div class="ms-suggest-item" v-for="(o, i) in ctl.pvParallelMine" :key="'pp' + i">· {{ o.reason }}</div>
            </div>
            <div class="oacts">
              <!-- AI 规划（写回层 UI 入口，2026-10-12）：只产“待审批”草稿，点头才转正。
                   12 条 LLM 通道后端 10-06 起就绪，界面入口今天才装——“电路铺好了开关没装”的补开关。 -->
              <button class="ghost oact" @click.stop="ctl.openAiPlan(ctl.pvCurrent)">✨ AI 规划</button>
              <button class="ghost oact" @click.stop="ctl.openAiDoc(ctl.pvCurrent)">📄 文档拆卡</button>
              <!-- 规划管理（2026-10-16 第 1 项）：四条规划通道后端 10-11 起就绪、界面今天接——
                   “电路铺好了开关没装”的第二排开关。非 AI：手工建规划+决策点选卡留痕。 -->
              <button class="ghost oact" @click.stop="ctl.openPlans(ctl.pvCurrent)">🗂 规划</button>
              <button class="ghost oact" @click.stop="ctl.openPolicyEdit(ctl.pvCurrent.id)">📋 {{ ctl.policyMap[ctl.pvCurrent.id] ? '方针' : '立方针' }}</button>
              <button class="ghost oact" @click.stop="ctl.openStructMap()">🗺 结构地图</button>
              <button class="ghost oact" @click.stop="ctl.openProjectTasks(ctl.pvCurrent)">📦 看任务</button>
              <!-- agent 上下文包（2026-10-22 · b 版落地物）：把契约/方针/决策/未完成卡/最近日志
                   拼成一段可直接粘给 agent 的 Markdown。只读，不改任何东西。 -->
              <button class="ghost oact" @click.stop="ctl.copyContextPack(ctl.pvCurrent)"
                      title="复制一段现成的项目上下文，直接粘给本地 agent —— 它不用再从零翻你的仓库">📋 复制上下文包</button>
              <!-- 不做“打开工作目录”——主进程没有"打开任意路径"的通道，也刻意不暴露。
                   能做的只是把路径复制走，那就只给这个，不摆一个点了没反应的按钮。 -->
              <button v-if="ctl.pvCurrent.repo" class="ghost oact"
                      @click.stop="ctl.copyWithToast(ctl.pvCurrent.repo, '已复制工作目录')">⧉ 复制路径</button>
              <button class="ghost oact" @click.stop="ctl.removeProject(ctl.pvCurrent)"
                      title="只从 registry.yaml 移除登记；任务卡与项目文件都不动">🗑 移除登记</button>
            </div>
          </div>
        </div>
        <div class="ms-detail empty" v-else>还没有项目 —— 点左下角“＋ 添加项目”登记第一个。</div>
      </div>

      <!-- ══ ⑤ 梯度榜（2026-10-25 暮雨）：项目页的第 5 种摆法 —— 手动拖档的 Tier List。
           边界写死在 views/ProjectTierBoard.vue 与 services/projectTiers.ts：
           只服务这一页，不改看板分组、不改一屏行序、不动 registry。 -->
      <ProjectTierBoard
        v-else-if="ctl.pvView === 'tier'"
        :projects="ctl.projects"
        :toast="ctl.showToast"
      />
      <!-- ══ ⑥ 对不上（2026-10-27 · REV-008 一期 R4“让对不上可见”）════════
           状态过期 / 引用断裂 / 完成但没判据 —— 三类全是**只读报告**，不阻挡任何操作。
           判定在 shared/mismatch.ts（e2e-mismatch 32 条纯 Node 断言），这里只管摆。
           ⚠ 必须紧接在上一分支之后：v-if 链中间插元素会让其后视图整页不渲染。 -->
      <MismatchView
        v-else-if="ctl.pvView === 'mismatch'"
        :toast="ctl.showToast"
      />
      <!-- ══ ⑦ 需求矩阵（2026-10-28 · RICE 决策矩阵）══════════════════════
           散点 + 表格 + 手改即时重算 + 拍板导出。口径全在 shared/rice.ts
           （e2e-rice 用纯 Node 验），数据在 task-data/rice-pool.md。
           ⚠ 页签**零网络**；分数只存四个原始分，总分现算、不落盘。 -->
      <RiceMatrixView
        v-else-if="ctl.pvView === 'rice'"
        :toast="ctl.showToast"
        :tasks="ctl.tasks"
        :projects="ctl.projects"
      />

      <!-- ══ ④ 在途一屏（2026-10-05 Q2 · 立项契约 ② 验收线之①）—— 已搬进 views/TripBoardView.vue
           一行一个在途项目：终态 / 当前步骤 / 下一步 / 卡在谁 / 健康度 / 卡·日志。
           数据来自主进程只读聚合（契约 + 任务卡 + 执行日志 + git）；缺值一律“未填”。
           旧三摆法一个字没动，“在途一屏”是新增的第 4 项。 -->
      <TripBoardView v-else-if="ctl.pvView === 'trip'" :ctl="ctl.tripBoardCtl" />
      <!-- 2026-10-31（0.6.0 P1）：第 8 种摆法 —— 作战计划裁决。 -->
      <PlanView v-else-if="ctl.pvView === 'plan'" />
    </main>
</template>

<script setup lang="ts">
import ProjectTierBoard from './ProjectTierBoard.vue'
import MismatchView from './MismatchView.vue'
import RiceMatrixView from './RiceMatrixView.vue'
import TripBoardView from './TripBoardView.vue'
import PlanView from './PlanView.vue'

/**
 * 项目页（2026-11-03 · App.vue 拆分「视图刀」）
 *
 * 只搬模板：八种摆法全部保留（项目墙 / 概览 / 主从 / 在途 / 梯度榜 / 对不上 / 需求矩阵 / 作战计划）。
 * `pv*` 状态、项目统计、监控台数据与所有动作仍在 App.vue —— 子视图组件照旧接自己的 ctl。
 * ⚠ 内部 `v-if / v-else-if` 链一个字没改；根元素仍是 `#board.pv`（视图互斥与几何断言按它选）。
 */
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点 */
const projectsCtl = ctl
</script>
