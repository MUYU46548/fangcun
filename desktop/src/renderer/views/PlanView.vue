<!--
  作战计划（0.6.0 P1）—— 项目页第 8 种摆法

  **这一页只服务一个决策**：这张阶段卡**能不能冻结**（冻结了才允许往下推）。
  所以三块必须同时在场：技术方案 / 照抄点表 / 判据；缺一块就报红，且**不给"通过"**。

  三个动作（P1 判据写死，恰好三个、没有第四态）：
    通过   → 写 `状态: 已冻结` + `裁决: 通过 · 日期`
    打回   → 写 `打回理由:`（空理由不许提交 —— 空着等于没打回）
    改一句 → 修订记录多一行 + 状态退回“未冻结”

  数据真身在 `main/data/plans.ts`（行级就地改，不重写整篇）；组件只管显示与收集意图。
-->
<template>
  <div class="plan-view">
    <div class="plan-head">
      <h3>作战计划 · 裁决</h3>
      <span class="plan-sub">三块齐全才给"通过"；打回必须写理由；改一句会留痕并把状态退回未冻结</span>
      <span v-if="totalStages" class="plan-count" data-plan-count>
        未完成 {{ totalStages - doneStages.length }} · 已完成 {{ doneStages.length }}
      </span>
      <!-- 2026-11-08 暮雨第 8 条：“已完成的一直挂在里面，几百条占满页面”。
           默认折叠 —— 这一页要回答的是“还有哪张卡在等我”，做完的不该占屏。
           ⚠ 走基座 Button（W6 冻结守卫：新增按钮不许手搓），所以这里没有自定义类。 -->
      <Button v-if="doneStages.length" variant="ghost" size="sm" @click="showDone = !showDone">
        {{ showDone ? '收起已完成' : '展开已完成 ' + doneStages.length }}
      </Button>
      <Button class="plan-reload" variant="ghost" size="sm" @click="load()">⟳ 重读</Button>
    </div>
    <!-- 2026-11-03：这一页只回答“这张卡能不能冻结”，但用户还得知道**冻了之后去哪推**。
         把整条回路写在这里（不新增页面、不改动作）：裁决 → 冻结 → 日志页看今天推哪格 →
         回来跑判据 → 推进这一格。
         ⚠ 2026-11-12 暮雨：「项目页一坨文字还是没修」——这段大字说明每次进门都占三行，
            而它是**读一次就够**的东西。默认收成一行，点开才看全文。 -->
    <div class="plan-how" :class="{ folded: !howOpen }">
      <button v-if="!howOpen" class="plan-how-toggle" @click="howOpen = true">
        怎么用 · 网页怎么推一格 + agent 怎么起草<span class="plan-how-more">展开</span>
      </button>
      <template v-else>
        <div class="plan-how-body">
          <b>推定一格：</b>没冻结的格子推不动 —— 通过 = 冻结，打回必须写理由（三块不齐不给通过）。
          冻结后到日志页顶部看“今天推哪一格”，回这里点“⚙ 跑判据”，全过后点“▶ 推进这一格”。
          <br>
          <b>让 agent 起草：</b>它调 <code>stage_plan_propose</code> 写进来的卡一定是「待裁决」，
          仍要你点「通过（冻结）」才算数；缺块会被直接拒收。
        </div>
        <button class="plan-how-toggle" @click="howOpen = false">收起</button>
      </template>
    </div>

    <!-- 2026-11-03：裁决后的即时回执。原先只有页面底部一行 msg（滚远了看不见），
         用户点完“通过”完全不知道成没成。现在顶部常驻一条，并顺手给“记成决策卡”。 -->
    <div v-if="recent" class="plan-recent" :class="'pr-' + recent.action">
      <span class="pr-text">已{{ recent.action === 'pass' ? '冻结' : recent.action === 'reject' ? '打回' : '记录修改' }}
        <b>{{ recent.stageId }}</b> {{ recent.title }}</span>
      <span v-if="recent.recorded" class="pr-done">✓ 已记决策卡 {{ recent.decisionId }}</span>
      <template v-else>
        <Button variant="ghost" size="tool" :disabled="decisionBusy" @click="recordDecision">
          {{ decisionBusy ? '记…' : '＋ 记成决策卡' }}</Button>
        <Button variant="ghost" size="tool" @click="recent = null">不用</Button>
      </template>
    </div>

    <!-- 规划草案入口（2026-11-11 · 0.7.0 规划根基）：
         在此之前 agent 起草的草案只在 `task-data/plans/_drafts/*.md`，界面上看不见 ——
         “agent 起草 → 人裁决”这条链只通了半截。这里列出来、说清每格缺什么、
         点一下就**走同一条闸**提成「待裁决」阶段卡（缺块的那格不给按钮）。

         2026-11-12 第二轮：**提成时就地改三块**。判据写歪一个字不必再回去让 agent 重写整份草案 ——
         展开编辑框改，改完仍然过同一条闸。草案文件本身**依旧只读**（改的是这次要落地的内容）。 -->
    <div v-if="drafts.length || draftBroken.length" class="plan-drafts" data-plan-drafts>
      <div class="plan-pending-head">
        <b>{{ drafts.length }} 份草案等你提成阶段卡</b>
        <span class="plan-pending-hint">草案由 agent 起草（本页只读）；提成时可以就地改三块，改完仍走同一条闸</span>
      </div>
      <div v-if="draftDecks.length" class="pd-row">
        <span class="pd-label">澄清卷</span>
        <select v-model="draftDeck" class="pd-sel">
          <option value="">（选一卷 —— 没卷不给提，D-060 硬锁）</option>
          <option v-for="d in draftDecks" :key="d.deck" :value="d.deck">{{ d.deck }}</option>
        </select>
        <span class="pd-hint">{{ draftDeck ? '这一卷是提成时必须附的依据' : '没选卷 → 提成会被闸直接拒（这是设计，不是 bug）' }}</span>
      </div>
      <div v-else class="pd-hint">本机没有已批准的卷 —— 先去问卷页答完并批准一卷，才能提成阶段卡</div>
      <!-- ⚠ 2026-11-12 暮雨：「一坨文字」——此前 8 份草案**全部平铺**，每份再摊开 5 格，
           进门就是几十行。现在按项目分组、**每组默认收起**，只留一行摘要；
           展开哪组看哪组。判据不是"少显示"，而是"一眼能数清有几组、每组几格等着"。 -->
      <div v-for="d in draftRows" :key="d.file" class="pd-card" :data-pd-row="d.file">
            <div class="pd-head">
              <b>{{ d.file }}</b>
              <span class="pd-meta">{{ d.stages.length }} 格 · 齐 {{ pdReadyCount(d) }} 格 · 宪法 {{ d.constitution.length }} 行 · 待问 {{ d.asks.length }} 条</span>
              <span class="pd-proj">{{ d.project }}</span>
              <span v-if="pdReadyCount(d) > 0" class="pd-ok">可提成 {{ pdReadyCount(d) }} 格</span>
              <span v-else class="pd-miss">暂不可提（缺判据）</span>
              <Button variant="ghost" size="tool" @click="toggleDraftFile(d.file)">
                {{ draftFileOpen[d.file] ? '收起' : '展开阶段' }}</Button>
              <Button v-if="pdReadyCount(d) > 0" variant="ghost" size="tool" :disabled="draftBusy"
                :title="'把这份草案里三块齐全的 ' + pdReadyCount(d) + ' 格一次提成「待裁决」阶段卡（逐格仍走同一条闸）'"
                @click="proposeReadyStages(d)">提成齐的 {{ pdReadyCount(d) }} 格 →</Button>
            </div>
            <template v-if="draftFileOpen[d.file]">
            <div v-for="s in d.stages" :key="s.id" class="pd-stage" :data-pd-stage="s.id">
              <span class="pd-sid">{{ s.id }}</span>
              <span class="pd-title">{{ s.title }}</span>
              <span v-if="editingKey === pdKey(d, s)" class="pd-editing">正在改</span>
              <!-- ⚠ 缺什么**编辑时也要看得见**（第一版被“正在改”顶掉了，改到一半就不知道还差哪块） -->
              <span v-if="pdMissing(d, s).length" class="pd-miss">缺 {{ pdMissing(d, s).join(' / ') }} —— 不能提</span>
              <span v-else class="pd-ok">三块齐全</span>
              <Button variant="ghost" size="tool" :disabled="draftBusy"
                :title="editingKey === pdKey(d, s) ? '收起编辑框（改过的内容留着，提成时才生效）' : '展开编辑框：提成前就地改技术方案 / 照抄点 / 判据'"
                @click="toggleDraftEdit(d, s)">{{ editingKey === pdKey(d, s) ? '收起' : '✎ 改一下' }}</Button>
              <Button v-if="!pdMissing(d, s).length" variant="ghost" size="tool" :disabled="draftBusy"
                :title="'把这一格提成「待裁决」阶段卡（走 proposeStage 同一条闸）'" @click="proposeDraft(d, s)">提成阶段卡 →</Button>
              <span v-if="pdChangedNote(d, s)" class="pd-changed">{{ pdChangedNote(d, s) }}</span>
            </div>
            <!-- 编辑框（2026-11-12）：三块各一个文本框；照抄点用文件里同样的 `| a | b |` 写法 -->
            <div v-for="s in d.stages" :key="'ed-' + s.id" v-show="editingKey === pdKey(d, s)"
              class="pd-edit" :data-pd-edit="s.id">
          <label class="pd-edit-l">技术方案<span class="pd-edit-hint">一行一条</span>
            <textarea class="pd-ta font-[inherit]" rows="4" :value="pdBuffer(d, s, 'approach')"
              @input="onDraftInput(d, s, 'approach', $event)"></textarea>
          </label>
          <label class="pd-edit-l">照抄点<span class="pd-edit-hint">表格：| 项 | 来源 | 原文 |，第一行是表头</span>
            <textarea class="pd-ta font-[inherit]" rows="5" :value="pdBuffer(d, s, 'copyRows')"
              @input="onDraftInput(d, s, 'copyRows', $event)"></textarea>
          </label>
          <label class="pd-edit-l">判据<span class="pd-edit-hint">一行一条，每条必须以 cmd: / str: / num: / file: 开头</span>
            <textarea class="pd-ta font-[inherit]" rows="4" :value="pdBuffer(d, s, 'criteria')"
              @input="onDraftInput(d, s, 'criteria', $event)"></textarea>
          </label>
          <div class="pd-edit-foot">
            <span v-if="pdMissing(d, s).length" class="pd-miss">还缺 {{ pdMissing(d, s).join(' / ') }}</span>
            <span v-else class="pd-ok">三块齐全，可以提</span>
            <span class="pd-hint">草案文件不会被改 —— 这里改的只是这次提成要落地的内容</span>
            <Button variant="ghost" size="sm" @click="resetDraftEdit(d, s)">恢复原文</Button>
            <Button variant="ghost" size="sm" @click="toggleDraftEdit(d, s)">收起</Button>
          </div>
          </div>
            </template>
      </div>
      <div v-if="draftMsg" class="pd-msg">{{ draftMsg }}</div>
      <div v-if="draftBroken.length" class="pd-broken">
        读不出来的草案：{{ draftBroken.map((b) => b.file + '（' + b.why + '）').join('；') }}
      </div>
    </div>

    <!-- 待裁决清单（2026-11-02）—— 此前“待裁决”只藏在每张卡的状态胶囊里，
         而日志页的每日推进面只认“已冻结”，于是 7 张等裁决的卡在界面上等于不存在
         （暮雨原话：“待裁决的东西在哪里？没看见”）。这里给一个显式出口：
         几张、哪几张、缺什么，点一下滚过去。 -->
    <div v-if="pendingStages.length" class="plan-pending" data-plan-pending>
      <div class="plan-pending-head">
        <b>{{ pendingStages.length }} 张阶段卡等你裁决</b>
        <span class="plan-pending-hint">没冻结的格子推不动 —— 点“通过（冻结）”或“打回”；“改一句”会退回重写</span>
      </div>
      <div class="plan-pending-list">
        <button v-for="p in pendingStages" :key="p.key" class="plan-pending-item" @click="scrollToStage(p.key)">
          <span class="plan-pending-id">{{ p.stageId }}</span>
          <span class="plan-pending-title">{{ p.title }}</span>
          <span v-if="p.missing" class="plan-pending-miss">缺 {{ p.missing }}</span>
        </button>
      </div>
    </div>

    <!-- 投入产出账（0.6.0 P5）—— 只显示取得到的格子；每个数字旁边都有“它证明不了什么”。
         口径声明**永远在**：ai-trace 只记方寸自己发起的调用，外部 agent 的花销不在这一格。

         2026-11-15（暮雨第三次说"界面依然很不美观"）：这一块**默认收起成一行**。
         理由不是"它不重要"，是**它不是这一页的动作**：进来是来裁决/推格的，
         而这块是"回头看一眼账"的参考数据 —— 它占着接近一屏，把真正的阶段卡顶到折线以下。
         收起后仍显示三个关键读数（数字不吃亏），点一下看全部四格与口径。
         ⚠ 口径声明不藏：收起态那一行就写着"ai-trace 只记方寸自己发起的调用"。 -->
    <div v-if="wasteLedger" class="waste-block" :class="{ folded: !wasteOpen }" data-waste-block>
      <div class="waste-head">
        <b>投入产出账</b>
        <span class="waste-span">近 {{ wasteLedger.days || '全部' }} 天</span>
        <template v-if="!wasteOpen">
          <template v-if="wasteBrief.length">
            <span v-for="(b, i) in wasteBrief" :key="'wb' + i" class="waste-brief-i">{{ b }}</span>
            <span class="waste-brief-bound">只算 ai-trace 里方寸自己发起的调用；外部 agent 的花销不在这里</span>
          </template>
          <span v-else class="waste-brief-i">{{ wasteLedger.emptyText }}</span>
          <!-- 用基座 ghost/sm 而不是手搓文字链接：它是一枚**动作**（展开），
               与同一页的「⟳ 重读」「展开已完成」是同一类，长相也该一样。 -->
          <Button class="waste-toggle" variant="ghost" size="sm" @click="wasteOpen = true">展开看四格与口径</Button>
        </template>
        <template v-else>
          <Button class="waste-toggle" variant="ghost" size="sm" @click="wasteOpen = false">收起</Button>
        </template>
      </div>
      <template v-if="wasteOpen">
        <div class="waste-note">{{ wasteLedger.note }}</div>
        <div v-if="wasteLedger.cells.length" class="waste-grid">
          <div v-for="c in wasteLedger.cells" :key="c.key" class="waste-cell" :data-waste="c.key">
            <div class="waste-label">{{ c.label }}</div>
            <div class="waste-value">{{ c.value }}</div>
            <div v-if="c.detail" class="waste-detail">{{ c.detail }}</div>
            <div class="waste-caveat">{{ c.caveat }}</div>
          </div>
        </div>
        <div v-else class="waste-empty">{{ wasteLedger.emptyText }}</div>
      </template>
    </div>
    <div v-else-if="wasteError" class="waste-block waste-error">
      投入产出账读取失败：{{ wasteError }}
    </div>

    <!-- 按项目筛（2026-11-05 第 1 条）：默认"全部"（不改旧默认），项目之间是天然隔离单元。
         只列**真有计划卡**的项目 —— 空项目摆一个按钮上去等于点一下什么都看不见。 -->
    <div v-if="planProjects.length > 1" class="plan-projbar" data-plan-projbar>
      <span class="plan-projbar-label">项目</span>
      <button class="plan-proj-chip" :class="{ on: !projFilter }" @click="projFilter = ''">
        全部<span class="plan-proj-n">{{ docs.length }}</span>
      </button>
      <button v-for="p in planProjects" :key="'pp-' + p" class="plan-proj-chip"
        :class="{ on: projFilter === p }" @click="projFilter = p">
        {{ p }}<span class="plan-proj-n">{{ docs.filter(d => projectOf(d) === p).length }}</span>
      </button>
    </div>
    <div v-if="loading" class="plan-empty">读取中…</div>
    <div v-else-if="!docs.length" class="plan-empty">
      还没有计划卡 —— 真源是 <code class="plan-code">task-data/plans/&lt;项目id&gt;.md</code>
    </div>
    <!-- 筛掉了全部（理论上不会：按钮只列真有卡的项目；但筛选与重读并发时会短暂成立） -->
    <div v-else-if="!visibleDocs.length" class="plan-empty">
      这个项目下暂时没有计划卡 —— 点上面的“全部”看别的项目
    </div>

    <div v-for="doc in visibleDocs" :key="doc.file" class="plan-doc">
      <div class="plan-doc-head">
        <b>{{ doc.title || doc.file }}</b>
        <span class="plan-file">{{ doc.file }}</span>
        <span class="plan-stat">{{ doc.stages.length }} 个阶段 · 缺块 {{ missCount(doc) }} 张</span>
      </div>

      <div v-for="s in doc.stages" :key="doc.file + s.id" class="plan-stage"
        :class="{ bad: s.missing.length, 'just-verdict': flashKey === runKey(doc, s), done: isDone(s) }"
        :data-stage="doc.file + '::' + s.id">
        <div class="plan-stage-head">
          <span class="plan-id">{{ s.id }}</span>
          <span class="plan-title">{{ s.title }}</span>
          <span class="plan-status" :class="'ps-' + statusKey(s.status)">{{ s.status || '未填状态' }}</span>
          <span v-if="s.evidence" class="plan-evidence" :title="'完成证据：' + s.evidence">✔ {{ evidenceText(s.evidence) }}</span>
          <!-- 2026-11-15（暮雨第三次说"界面依然很不美观"）：
               真数据 12 张卡里 10 张是「完成 + 三块齐全」，于是**同一个词在屏幕上重复十遍**。
               重复的"正常"会把"不正常"淹掉 —— 现在只在**缺块时**说话，齐全的沉默。 -->
          <span v-if="s.missing.length" class="plan-miss">缺 {{ s.missing.join(' / ') }} —— 不能通过</span>
        </div>

        <!-- 已完成 = 默认只留这一行（2026-11-08 第 8 条）。
             点“展开已完成”才渲染下面整块 —— 几百个做完的阶段不该占满屏。 -->
        <div v-if="isDone(s) && !showDone" class="plan-fold-hint" @click="showDone = true">
          已完成 · 证据在卡里 · 点开看三块与裁决记录
        </div>

        <!-- 2026-11-14（长 Loop P2-2）：**未完成的也默认收起**。
             实测真数据：fangcun-base 12 个阶段、每阶段 15–22 行正文，全部铺开 = 466 行，
             滚一屏都看不完一张卡 —— 这就是"一坨文字"的量化来源。
             折叠规则与「已完成」一致：默认只留标题行（id + 标题 + 状态 + 缺块提示），
             点一下看三块；**待裁决的卡默认展开**（那正是要人做決定的地方，不该再点一次）。
             ⚠ 用 `foldKey` 记展开状态（`file::id`），与 `showDone` 那套分开 ——
               它们是两个维度（"完成了没" vs "这一张我展开看没看"）。 -->
        <div v-else-if="!isExpanded(doc, s)" class="plan-fold-hint" @click="toggleStage(doc, s)">
          {{ s.what ? String(s.what).slice(0, 60) + (String(s.what).length > 60 ? '…' : '') : '点开看技术方案 / 照抄点 / 判据' }}
        </div>

        <template v-else>
          <!-- 展开态给一个收起按钮 —— 展开之后得能收回去，否则"点了就永远长" -->
          <div class="plan-fold-hint on" @click="toggleStage(doc, s)">收起</div>
          <div class="plan-what" v-if="s.what">{{ s.what }}</div>

        <div class="plan-block">
          <div class="plan-block-h">技术方案<span v-if="!s.approach.length" class="plan-block-miss">缺</span></div>
          <ul v-if="s.approach.length" class="plan-ul"><li v-for="(a, i) in s.approach" :key="'a' + i">{{ a }}</li></ul>
        </div>

        <div class="plan-block">
          <div class="plan-block-h">照抄点<span v-if="s.copyRows.length < 3" class="plan-block-miss">缺</span></div>
          <table v-if="s.copyRows.length >= 3" class="plan-table">
            <thead>
              <tr><th v-for="(c, i) in s.copyRows[0]" :key="'h' + i">{{ c }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="(row, ri) in s.copyRows.slice(2)" :key="'r' + ri">
                <td v-for="(c, ci) in row" :key="'c' + ci">{{ c }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="plan-block">
          <div class="plan-block-h">判据<span v-if="!s.criteria.length" class="plan-block-miss">缺</span></div>
          <!-- 2026-11-15（暮雨第 1 条：看不懂的“判据”依然存在，界面一坨）：
               此前这里直接把卡上的机器语法 `str: docs/x 含 'y'` 原样铺出来。
               对写卡的人那是判据，对用户那是一串看不懂的符号 —— 于是他不看，
               而"这条到底过了没"就变成了没人判的事。
               现在每一条给两层：**上面一句人话（这次要验什么）**，
               下面灰色小字才是原文（要核对时看得到，不核对时不占注意力）。
               ⚠ 原文不许删：判据是验收凭据，只留译文等于把凭据藏了。 -->
          <ul v-if="s.criteria.length" class="plan-ul plan-crit">
            <li v-for="(c, i) in critHead(doc, s)" :key="'c' + i" class="plan-crit-li">
              <div class="plan-crit-line">
                <span class="plan-crit-kind">{{ explained(c).kindLabel }}</span>
                <span class="plan-crit-plain">{{ explained(c).plain }}</span>
              </div>
              <span class="plan-crit-raw" :title="explained(c).basis">{{ c }}</span>
            </li>
          </ul>
          <div v-if="critMore(doc, s)" class="plan-crit-more" @click="toggleCrit(doc, s)">
            {{ critMore(doc, s) }}
          </div>
        </div>

        <div class="plan-acts">
          <!-- 2026-11-03：冻结/完成后按钮改成“已冻结 / 已完成”并禁用 ——
               以前点完仍写着“通过（冻结）”，用户看不出到底成没成，只能狂点。 -->
          <!-- 2026-11-12：`.ok` 手搓 → 基座 `success` 变体。它原来只有 `font-weight:600` 一条局部规则，
               几何全部来自 `.ok`（height: --btn-h = 28），正好等于 `tool` 档 —— 只换颜色，尺寸不动。 -->
          <Button variant="success" size="tool" class="plan-act-pass" :disabled="busy || s.missing.length > 0 || !canFreeze(s)"
            :title="s.missing.length ? '缺块不能通过' : !canFreeze(s) ? '这张卡已经' + (s.status || '处理过') : '冻结这张阶段卡'"
            @click="verdict(doc, s, 'pass')">
            {{ s.status === '已冻结' ? '✓ 已冻结' : s.status === '完成' ? '✓ 已完成' : '✓ 通过（冻结）' }}
          </Button>
          <Button class="plan-act-reject" variant="danger" size="sm" :disabled="busy || s.status === '完成'" @click="openText(doc, s, 'reject')">↩ 打回</Button>
          <Button class="plan-act-amend" variant="ghost" size="sm" :disabled="busy || s.status === '完成'" @click="openText(doc, s, 'amend')">✎ 改一句</Button>
          <!-- P4 界面入口（2026-11-02）：只有点这里才起进程；打开这一页永远不会跑判据 -->
          <Button class="plan-run-checks" variant="ghost" size="sm" :disabled="runBusy" title="真跑这一格的判据（不写任何文件）"
            @click="runChecks(doc, s)">⚙ 跑判据</Button>
          <Button class="plan-run-advance" variant="primary" size="sm" :disabled="runBusy" :class="{ 'needs-freeze': s.status !== '已冻结' }"
            :title="s.status !== '已冻结' ? '这张卡还没冻结 —— 推进会被闸门拒绝（先点“通过（冻结）”）' : '跑判据 → 闸门 → 判据全过才写得进完成'"
            @click="advance(doc, s)">▶ 推进这一格</Button>
          <span v-if="s.rejectReason" class="plan-reason">上次打回：{{ s.rejectReason }}</span>
          <span v-if="s.verdict" class="plan-verdict">{{ s.verdict }}</span>
        </div>

        <!-- 判据结果（P4）：逐条三态 + 闸门结论。缺省不渲染，不写“未跑”占位 -->
        <div v-if="runOf(doc, s)" class="plan-run" :class="{ bad: runOf(doc, s).blocked }">
          <div class="plan-run-head">{{ runHead(doc, s) }}</div>
          <!-- 2026-11-15：三列改成「人话 / 结论 / 实际值」。
               原来第一列是机器语法（`str: …`），用户扫一眼第一列全是符号就放弃了；
               现在第一列是"这条在验什么"，原文退到第三列小字（要核对时看得到）。 -->
          <ul v-if="runOf(doc, s).results.length" class="plan-run-list">
            <li v-for="(r, ri) in runOf(doc, s).results" :key="'run' + ri" class="plan-run-item" :class="r.state">
              <span class="plan-run-tag">{{ stateText(r.state) }}</span>
              <span class="plan-run-plain">{{ runPlain(r) }}</span>
              <span class="plan-run-detail">{{ r.detail }}</span>
              <span class="plan-run-raw">{{ r.raw }}</span>
            </li>
          </ul>
          <div v-if="runOf(doc, s).advanced" class="plan-run-advanced">已写成“完成”，证据：{{ s.evidence }}</div>
        </div>

        <div class="plan-text" v-if="textTarget && textTarget.file === doc.file && textTarget.stageId === s.id">
          <textarea class="plan-ta font-[inherit]" v-model="text" rows="2"
            :placeholder="textTarget.action === 'reject' ? '打回理由（必填）：哪里不成立、要改成什么样' : '改哪一句、改成什么'"></textarea>
          <div class="plan-text-acts">
            <Button variant="ghost" size="tool" @click="closeText()">取消</Button>
            <button class="pri" :disabled="busy || !text.trim()" @click="submitText()">
              {{ textTarget.action === 'reject' ? '确认打回' : '确认修改' }}
            </button>
          </div>
        </div>
        </template>
      </div>
    </div>

    <div v-if="msg" class="plan-msg" :class="msgType">{{ msg }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Button from '../components/ui/Button.vue'
import { useWasteLedger } from '../composables/useWasteLedger'
import { linesToList, listToLines, missingOf, normalizeCopyRows, parseCopyTable, tableToText } from '../../shared/draftEdit'
import { explainCriteria, foldPlan } from '../../shared/criteriaExplain'
import { formatEvidence, planSummary } from '../../shared/evidenceText'
import { toPlain } from '../../shared/plain'

interface Stage {
  id: string; title: string; status: string; what: string
  approach: string[]; copyRows: string[][]; criteria: string[]
  verdict: string; rejectReason: string; evidence: string; missing: string[]
}
interface Doc { file: string; title: string; stages: Stage[] }

const docs = ref<Doc[]>([])
const loading = ref(false)
const busy = ref(false)
const msg = ref('')
const msgType = ref<'ok' | 'bad'>('ok')
const text = ref('')
const textTarget = ref<{ file: string; stageId: string; action: 'reject' | 'amend' } | null>(null)

/** 裁决后的即时回执（2026-11-03）：顶部一条，可顺手记成决策卡 */
const recent = ref<null | {
  action: 'pass' | 'reject' | 'amend'
  stageId: string; title: string; file: string; project: string; text: string
  recorded: boolean; decisionId: string
}>(null)
const decisionBusy = ref(false)
/** 刚操作过的那张卡闪一下（只做视觉，不参与任何判定） */
const flashKey = ref('')
let flashTimer: ReturnType<typeof setTimeout> | null = null

function statusKey(s: string): string {
  const st = String(s || '').trim()
  if (st === '已冻结') return 'frozen'
  if (st === '完成') return 'done'
  if (st === '未完成') return 'rework'
  if (st === '待裁决' || st === '待裁决（未冻结）' || st === '未冻结') return 'pending'
  return 'unknown'
}
/** 只有“还没裁决 / 被打回 / 未完成”的卡可以冻结；已冻结、完成的不再给“通过” */
function canFreeze(s: Stage): boolean {
  const st = String(s.status || '').trim()
  if (!st) return true
  return st === '待裁决' || st === '待裁决（未冻结）' || st === '未冻结' || st === '未完成'
}
function projectOf(doc: Doc): string {
  const fromTitle = String(doc.title || '').split('·')[0].trim()
  if (fromTitle) return fromTitle
  return String(doc.file || '').replace(/\.md$/i, '')
}

/**
 * 按项目筛选（2026-11-05 暮雨第 1 条）。
 *
 * 他的问题有两半：**"是否默认显示所有项目的内容？是否支持按项目筛选？"**
 *   · 前半：是。数据层 `plans:get` 不带 file 时就把 `task-data/plans/` 下所有计划卡
 *     一次读全（这里从来不筛项目）—— 所以"默认只看一个项目"从来不是现状。
 *   · 后半：**原来没有**。8 个项目的阶段卡平铺成一条长页，翻到自己那一张全靠滚，
 *     而"项目是天然的隔离单元"（他原话）—— 阶段卡尤其如此，不同项目的 P0 压根不该并排看。
 * 默认仍是"全部"：加筛选不改默认视图，这是老规矩（旧视图永远是默认）。
 */
const projFilter = ref('')
const planProjects = computed(() => {
  const s = new Set<string>()
  for (const d of docs.value) { const p = projectOf(d); if (p) s.add(p) }
  return [...s]
})
const visibleDocs = computed(() =>
  projFilter.value ? docs.value.filter((d) => projectOf(d) === projFilter.value) : docs.value)

/**
 * 已完成阶段默认折叠（2026-11-08 暮雨第 8 条）。
 *
 * 原话：“作战计划已完成的一直挂在里面，没有任何折叠和归档机制，可想而知东西多了以后
 * 几百条信息占满页面有多恐怖。”
 *
 * 这一页要回答的只有一个问题：**还有哪张卡在等我裁决**。做完的卡留着是为了能回看证据，
 * 但默认摊开就把“待办”淹了。所以：done 的阶段只留头部一行，`showDone` 才展开整块；
 * 页头给“未完成 / 已完成”两个数，不用滚到底才知道还剩多少。
 */
const showDone = ref(false)
const isDone = (s: Stage): boolean => String(s.status || '').trim() === '完成'

/**
 * 单张阶段卡的展开状态（2026-11-14 · 长 Loop P2-2）。
 *
 * 为什么需要它：真数据 fangcun-base 有 12 个阶段、每阶段 15–22 行，全部铺开 466 行。
 * 「已完成」早就有折叠（showDone），但**未完成的那些是全展开的** —— 那才是"一坨"的主体。
 *
 * 默认规则：
 *   · 待裁决 → **默认展开**（那正是要人做决定的地方，不该再点一次）
 *   · 其余（待办 / 进行中 / 未填状态）→ 默认收起，只露一行摘要
 * 用户点过之后以用户的为准（`foldKey` 里记的是"用户显式改成了什么"）。
 */
const foldKey = ref<Record<string, boolean>>({})
function stageKey(doc: Doc, s: any): string { return doc.file + '::' + s.id }
function isExpanded(doc: Doc, s: any): boolean {
  const k = stageKey(doc, s)
  if (k in foldKey.value) return foldKey.value[k]
  // 没点过：**待裁决**与**已冻结**都默认展开。
  //  · 待裁决 —— 那正是要人做决定的地方，不该再点一次；
  //  · 已冻结 —— 它是"已经定下来的施工依据"，折叠起来等于把依据藏了；
  //    而且冻结卡通常只有一两行（三块已在冻结时被审过），不占地方。
  // 只折叠那些既没裁决、也不是待裁决的（草稿 / 未冻结 / 未填状态）——
  // 那些才是"一坨"的主体。
  const st = String(s?.status || '').trim()
  if (st === '待裁决' || st === '待裁决（未冻结）' || st === '未冻结') return true
  if (st === '已冻结') return true
  return false
}
function toggleStage(doc: Doc, s: any): void {
  const k = stageKey(doc, s)
  foldKey.value = { ...foldKey.value, [k]: !isExpanded(doc, s) }
}

/**
 * 判据区的“减负”（2026-11-15 暮雨第 1 条）。
 *
 * 真数据里一张阶段卡的判据常常 8–20 条（`fangcun-base.md` 有单卡 19 条的），
 * 全部铺开就是他自己说的“信息堆一堆，用户直接不看”。所以：
 *   · 默认只铺前 3 条；其余折起来，但**写明还有几条**（折叠 ≠ 隐藏）；
 *   · 每条给一句人话 + 原文小字（译文在纯逻辑 `shared/criteriaExplain.ts` 里，界面不重算）。
 *
 * ⚠ 折叠状态**不落盘**：这是"这一次看这一张要不要展开"，跟 `foldKey`（整张卡展不展开）
 *   是两个维度，也跟 `showDone`（完成了没）无关。三重状态混用会让"点了没反应"。
 */
const critOpen = ref<Record<string, boolean>>({})
function critKey(doc: Doc, s: any): string { return doc.file + '::' + s.id + '::crit' }
function critHead(doc: Doc, s: Stage): string[] {
  const all = (s.criteria || []).map(String)
  if (critOpen.value[critKey(doc, s)]) return all
  return foldPlan(all).head
}
function critMore(doc: Doc, s: Stage): string {
  const all = (s.criteria || []).map(String)
  if (critOpen.value[critKey(doc, s)]) return all.length > 3 ? '收起判据（只看前 3 条）' : ''
  return foldPlan(all).moreLine
}
function toggleCrit(doc: Doc, s: Stage): void {
  const k = critKey(doc, s)
  critOpen.value = { ...critOpen.value, [k]: !critOpen.value[k] }
}
/** 一条判据 → 人话（同一条重复渲染时不必重算，Vue 会缓存模板里的结果；这里只做纯函数调用） */
function explained(raw: string): { plain: string; kindLabel: string; basis: string } {
  const e = explainCriteria(String(raw))
  return { plain: e.plain, kindLabel: e.kindLabel, basis: e.basis }
}
/** 证据行 → 去掉毫秒与 Z 的本地时间（`自检 2026-11-03T04:00:54.502Z …` → `自检 11-03 12:00 …`） */
function evidenceText(raw: string): string {
  return formatEvidence(String(raw || ''))
}
const totalStages = computed(() => visibleDocs.value.reduce((n, d) => n + d.stages.length, 0))
const doneStages = computed(() => {
  const out: Array<{ file: string; stageId: string }> = []
  for (const d of visibleDocs.value) for (const s of d.stages) if (isDone(s)) out.push({ file: d.file, stageId: s.id })
  return out
})
function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function flash(key: string): void {
  flashKey.value = key
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => { flashKey.value = ''; flashTimer = null }, 2500)
}

// 投入产出账（P5）：只读；三格取不到就不渲染那一格
const { wasteLedger, wasteError, loadWasteLedger } = useWasteLedger()

/**
 * 投入产出账默认收起（2026-11-15 暮雨第三次：「界面依然很不美观」）。
 *
 * 为什么不是"再调调样式"：这一块在首屏占掉近一屏，而**它不是这一页的动作** ——
 * 进来是来裁决/推格的，账是"回头看"的参考。它把真正的阶段卡顶到了折线以下。
 * 收起态仍显示三条关键读数（数字不吃亏），点一下看全部四格与"它证明不了什么"。
 *
 * ⚠ 口径不能藏：收起态那行也写着 ai-trace 的边界（`wasteBrief`）——
 *   "少占地方"不等于"少说实话"。
 */
const wasteOpen = ref(false)
/**
 * 收起态的读数组：**每条一个元素**，界面自己排（拼成一句话那种会把三条挤成一串）。
 * 只取「标签 值」，并把标签里重复的「（近 30 天）」剥掉 —— 页头已经写了时间窗。
 */
const wasteBrief = computed<string[]>(() => {
  const cells = wasteLedger.value?.cells || []
  return cells.map((c: any) => `${String(c.label).replace(/（[^）]*天）$/, '')} ${c.value}`)
})

// ── 规划草案入口（2026-11-11）────────────────────────────────────────────
// 只读草案 + 一键提成。提成必须带澄清卷（D-060 硬锁），所以先给一个「已批准的卷」下拉。
const drafts = ref<any[]>([])
const draftBroken = ref<{ file: string; why: string }[]>([])
const draftDecks = ref<{ deck: string; project: string }[]>([])
const draftDeck = ref('')
const draftBusy = ref(false)
const draftMsg = ref('')
/** 「怎么用」那段说明默认收起（读一次就够的东西不该每次占三行） */
const howOpen = ref(false)

/**
 * 草案行：**一份草案一行、全部平铺**（2026-11-25 改，卡 `a399b8e2`）。
 *
 * ## 为什么要改掉「按项目分组」
 *
 * 暮雨 2026-11-19：「fangcun-base 那一组**太难找了，三分钟才打开**（而且样式很丑）」。
 * 分组版的实际路径是：项目页 → 作战计划 → 顶部草案区 → **猜是哪一组** → 展开组 → 才看见文件。
 * 一次找一份草案要 3 层，而**组名本身还要先猜对** —— 那份草案叫
 * `fangcun-base-2026-11-15.md`，但它在「fangcun-base」组里这件事并不直观。
 *
 * ## 为什么不是简单"退回平铺"（2026-11-12 那次挨过骂）
 *
 * 那次是**每份草案连 5 格一起摊开**，进门几十行 → 「一坨文字」。
 * 这次平铺的是**行**：一份草案只占一行（文件名 / 格数 / 项目 / 可不可提 / 两个按钮），
 * 阶段仍然要点「展开阶段」才展开。所以"不再分组"不等于"又变一坨"。
 *
 * 判据（卡里写的）：找指定草案所需展开层级 > 1 的用例数 == 0；
 * 草案行缺「文件名 / 阶段数 / 可提成按钮」的条数 == 0。
 */
const draftFileOpen = ref<Record<string, boolean>>({})
const draftRows = computed(() => {
  // 排序：可提成的在前（那是要动手的），再按格数多的在前，最后按文件名稳定排序。
  // 不用"按项目分组"是因为**分组没有让任何一份草案更容易被找到** —— 见上面的注释。
  return drafts.value.slice().sort((a: any, b: any) => {
    const ra = pdReadyCount(a)
    const rb = pdReadyCount(b)
    if (ra !== rb) return rb - ra
    const sa = Array.isArray(a.stages) ? a.stages.length : 0
    const sb = Array.isArray(b.stages) ? b.stages.length : 0
    if (sa !== sb) return sb - sa
    return String(a.file || '').localeCompare(String(b.file || ''))
  })
})
function toggleDraftFile(file: string): void {
  draftFileOpen.value = { ...draftFileOpen.value, [file]: !draftFileOpen.value[file] }
}

/**
 * 提成时就地改三块（2026-11-12）。
 *
 * 三件必须成立，否则这条入口就是“改了个寂寞”：
 *   ① 缺什么要**跟着改**实时变 —— 草案里缺判据、我在框里补了，按钮必须当场出现；
 *   ② 提交出去的只能是**改过的块**（`patch`），没回到草案整份重写；
 *   ③ 草案文件一个字节不动 —— 改的是“这次要落地的内容”。
 * 「缺什么」的口径与主进程共用 `shared/draftEdit.ts`，这里不自己发明一套。
 */
type DraftBlock = 'approach' | 'copyRows' | 'criteria'
interface EditBuf { approach: string; copyRows: string; criteria: string }
const editingKey = ref('')
/** key = `文件::格号`；值是三个文本框的**原文**（提交时才转成三块） */
const editBuffers = ref<Record<string, EditBuf>>({})

const pdKey = (d: any, s: any): string => String(d?.file || '') + '::' + String(s?.id || '')

/** 逐项比对（与主进程 `diffStage` 同一判据：条数 + 每一条都要一致才算没改） */
const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => String(x) === String(b[i]))
const sameRows = (a: string[][], b: string[][]): boolean =>
  a.length === b.length && a.every((r, i) => sameList(r.map(String), (b[i] || []).map(String)))

function bufOf(d: any, s: any): EditBuf {
  const k = pdKey(d, s)
  const cur = editBuffers.value[k]
  if (cur) return cur
  return { approach: listToLines(s?.approach), copyRows: tableToText(s?.copyRows), criteria: listToLines(s?.criteria) }
}
function pdBuffer(d: any, s: any, block: DraftBlock): string { return bufOf(d, s)[block] }

/** 文本框原文 → 这一格**合并后**的三块（判缺块用这个，不用草案原文） */
function pdMerged(s: any, buf: EditBuf): { approach: string[]; copyRows: string[][]; criteria: string[] } {
  const approach = buf.approach === '' ? [] : linesToList(buf.approach)
  const criteria = buf.criteria === '' ? [] : linesToList(buf.criteria)
  const copyRows = normalizeCopyRows(parseCopyTable(buf.copyRows))
  return { approach, criteria, copyRows }
}
function pdMissing(d: any, s: any): string[] {
  return missingOf(pdMerged(s, bufOf(d, s)))
}

/**
 * 这份草案里有几格是**三块齐全、现在就能提成**的。
 *
 * 为什么行要显示它：卡 `a399b8e2` 的判据之一是
 * 「草案行缺『文件名 / 阶段数 / 可提成按钮』三项的条数 == 0」。
 * 只在展开之后才看到"哪格能提"，等于把"要不要处理这份"的判断推后了一次点击。
 * 显示在行上 = 一眼能决定先动哪份（`draftRows` 也按它排序）。
 *
 * ⚠ 用 `pdMissing`（合并编辑框后的结果）而不是草案原文 —— 就地改过的内容要当场算数，
 *   否则会出现「框里补齐了、行上还写着不可提」这种自相矛盾。
 */
function pdReadyCount(d: any): number {
  const stages: any[] = Array.isArray(d?.stages) ? d.stages : []
  return stages.filter((s: any) => pdMissing(d, s).length === 0).length
}

/**
 * 一次提成这份草案里**所有**三块齐全的格。
 *
 * 为什么要有它：暮雨抱怨的是"找一份草案要 3 分钟"，而真正花时间的是
 * **一份草案 5 格要一格一格点 5 次**。逐格仍走同一条闸（`proposeDraft`），
 * 这里只负责按顺序跑完并把成败如实报出来 —— **不许把失败静默吞掉**。
 */
async function proposeReadyStages(d: any): Promise<void> {
  if (draftBusy.value) return
  const stages: any[] = Array.isArray(d?.stages) ? d.stages : []
  const ready = stages.filter((s: any) => pdMissing(d, s).length === 0)
  if (!ready.length) return
  draftBusy.value = true
  draftMsg.value = ''
  const okIds: string[] = []
  const failed: string[] = []
  try {
    for (const s of ready) {
      try {
        // 逐格走同一个通道（同一套签名/闸门），不另造一条批量捷径
        const patch = toPlain(pdPatch(d, s))
        const r: any = await (window as any).tegula.plansProposeFromDraft({
          draft: String(d?.file || ''), stageId: String(s?.id || ''), deck: draftDeck.value, patch,
        })
        if (r?.ok) okIds.push(String(s.id))
        else failed.push(`${s.id}（${r?.error || '未知原因'}）`)
      } catch (e: any) {
        failed.push(`${s.id}（${e?.message || e}）`)
      }
    }
  } finally {
    draftBusy.value = false
  }
  const parts = [`已提成 ${okIds.length} 格`]
  if (okIds.length) parts[0] += `：${okIds.join(' / ')}`
  if (failed.length) parts.push(`没提成 ${failed.length} 格 —— ${failed.join('；')}`)
  draftMsg.value = parts.join('；')
  msg.value = draftMsg.value
  msgType.value = failed.length ? 'bad' : 'ok'
  editingKey.value = ''
  await load()
  await loadDrafts()
}

/** 改了哪几块（与主进程 `diffStage` 同一口径：逐项比对，改了才叫改） */
function pdChangedBlocks(d: any, s: any): string[] {
  const buf = bufOf(d, s)
  const now = pdMerged(s, buf)
  const out: string[] = []
  if (!sameList(now.approach, (s?.approach || []).map((x: string) => String(x)))) out.push('技术方案')
  if (!sameRows(now.copyRows, s?.copyRows || [])) out.push('照抄点')
  if (!sameList(now.criteria, (s?.criteria || []).map((x: string) => String(x)))) out.push('判据')
  return out
}
function pdChangedNote(d: any, s: any): string {
  const n = pdChangedBlocks(d, s)
  return n.length ? '已改：' + n.join(' / ') : ''
}

function toggleDraftEdit(d: any, s: any): void {
  const k = pdKey(d, s)
  if (editingKey.value === k) { editingKey.value = ''; return }
  // 展开时用**草案原文**铺一遍（不保留上一次的临时改动 —— 收起不等于提交，这是可预期的）
  editBuffers.value = { ...editBuffers.value, [k]: bufOf(d, s) }
  editingKey.value = k
}
function onDraftInput(d: any, s: any, block: DraftBlock, ev: Event): void {
  const el = ev.target as HTMLTextAreaElement | null
  const k = pdKey(d, s)
  const base = bufOf(d, s)
  editBuffers.value = { ...editBuffers.value, [k]: { ...base, [block]: el ? el.value : '' } }
}
function resetDraftEdit(d: any, s: any): void {
  const k = pdKey(d, s)
  editBuffers.value = {
    ...editBuffers.value,
    [k]: { approach: listToLines(s?.approach), copyRows: tableToText(s?.copyRows), criteria: listToLines(s?.criteria) },
  }
}
/** 提交给主进程的 `patch`：只放**真改过**的块（没改就不传，主进程按草案原文落） */
function pdPatch(d: any, s: any): { approach?: string[]; copyRows?: string[][]; criteria?: string[] } | undefined {
  const changed = pdChangedBlocks(d, s)
  if (!changed.length) return undefined
  const now = pdMerged(s, bufOf(d, s))
  const out: { approach?: string[]; copyRows?: string[][]; criteria?: string[] } = {}
  if (changed.includes('技术方案')) out.approach = now.approach
  if (changed.includes('照抄点')) out.copyRows = now.copyRows
  if (changed.includes('判据')) out.criteria = now.criteria
  return out
}

async function loadDrafts(): Promise<void> {
  try {
    const r: any = await (window as any).tegula.plansDrafts()
    drafts.value = Array.isArray(r?.drafts) ? r.drafts : []
    draftBroken.value = Array.isArray(r?.broken) ? r.broken : []
    draftDecks.value = Array.isArray(r?.decks) ? r.decks : []
    if (!draftDeck.value && draftDecks.value.length) draftDeck.value = draftDecks.value[0].deck
  } catch {
    drafts.value = []
  }
}

async function proposeDraft(d: any, s: any): Promise<void> {
  if (draftBusy.value) return
  draftBusy.value = true
  draftMsg.value = ''
  try {
    // ⚠ 过桥只传普通对象（裸 Vue 代理必抛 could not be cloned —— 见 AGENTS 踩坑 1）
    const patch = toPlain(pdPatch(d, s))
    const r: any = await (window as any).tegula.plansProposeFromDraft({
      draft: String(d?.file || ''), stageId: String(s?.id || ''), deck: draftDeck.value, patch,
    })
    if (r?.ok) {
      const note = r?.edit && r.edit.count ? `（提成时改过 ${r.edit.note}）` : ''
      draftMsg.value = `已提成 ${s.id} → ${r.planFile}${note}（状态：待裁决，等你在这里点「通过（冻结）」）`
      msg.value = draftMsg.value
      msgType.value = 'ok'
      editingKey.value = ''
      await load()
      await loadDrafts()
    } else {
      draftMsg.value = '没提成：' + (r?.error || '未知原因')
      msg.value = draftMsg.value
      msgType.value = 'bad'
    }
  } catch (e: any) {
    draftMsg.value = '提成失败：' + (e?.message || e)
  } finally {
    draftBusy.value = false
  }
}

const missCount = (doc: Doc) => doc.stages.filter((s) => s.missing.length).length

/** 等你裁决的阶段卡（2026-11-02）—— 与 `shared/dailyBand` 的 PENDING 同一套词。
 *  为什么要在页面顶部数一遍：计划卡的状态词是它自己的一套，任务 7 态 / 决策 3 态里都没有“待裁决”，
 *  除了这张卡上的小胶囊，没有任何地方会告诉你"有 N 张在等你"。 */
const pendingStages = computed(() => {
  const out: Array<{ key: string; stageId: string; title: string; missing: string }> = []
  for (const d of docs.value) {
    for (const s of d.stages) {
      const st = String(s.status || '').trim()
      if (st === '待裁决' || st === '待裁决（未冻结）' || st === '未冻结') {
        out.push({
          key: d.file + '::' + s.id,
          stageId: s.id,
          title: s.title || '(无标题)',
          missing: (s.missing || []).join(' / '),
        })
      }
    }
  }
  return out
})

function scrollToStage(key: string): void {
  const el = document.querySelector('[data-stage="' + key + '"]') as HTMLElement | null
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

// ── P4：跑判据 / 推进一格（2026-11-02 接上界面）────────────────────────
// 结果按“文件::阶段”各存一份，不互相覆盖；**没点过就整块不渲染**（不写"未跑"占位）。
// 这两条路径是唯一会起进程的地方 —— 打开这一页（plansGet）永远不会跑判据。
interface RunState {
  loading: boolean
  results: any[]
  gate: any
  advanced: boolean
  blocked: boolean
  error: string
}

const runBusy = ref(false)
const runStates = ref<Record<string, RunState>>({})
const runKey = (doc: Doc, s: Stage): string => doc.file + '::' + s.id
function runOf(doc: Doc, s: Stage): RunState | null { return runStates.value[runKey(doc, s)] || null }

const STATE_TEXT: Record<string, string> = { pass: '通过', fail: '未过', unknown: '未判定' }
function stateText(x: string): string { return STATE_TEXT[x] || x }

function emptyRun(error = '', loading = false): RunState {
  return { loading, results: [], gate: null, advanced: false, blocked: false, error }
}

function runHead(doc: Doc, s: Stage): string {
  const r = runOf(doc, s)
  if (!r) return ''
  if (r.loading) return '正在跑 ' + s.id + ' 的判据…'
  if (r.error) return '没跑成：' + r.error
  const reason = String((r.gate && r.gate.reason) || '')
  if (r.advanced) return '判据全过 → 已推进成“完成”（' + reason + '）'
  if (r.blocked) return reason || '判据未过'
  return reason || '判据全过'
}

/** 判据结果的“人话”一列（2026-11-15）：同一套翻译逻辑，界面不重算口径 */
function runPlain(r: any): string {
  return explainCriteria(String(r?.raw || '')).plain
}

async function runChecks(doc: Doc, s: Stage): Promise<void> {
  if (runBusy.value) return
  const key = runKey(doc, s)
  runBusy.value = true
  runStates.value = { ...runStates.value, [key]: emptyRun('', true) }
  msg.value = ''
  try {
    const r: any = await (window as any).tegula.plansChecks({ file: doc.file, stageId: s.id })
    if (!r?.ok) {
      runStates.value = { ...runStates.value, [key]: emptyRun('读取失败：' + (r?.error || '未知错误')) }
      return
    }
    const gate = r.gate || null
    runStates.value = {
      ...runStates.value,
      [key]: {
        loading: false, results: r.results || [], gate,
        advanced: false, blocked: !(gate && gate.canAdvance), error: '',
      },
    }
    msg.value = gate && gate.canAdvance
      ? s.id + ' 判据全过 —— 可以点“推进这一格”'
      : s.id + ' 判据没过 —— 看下面逐条实际值'
    msgType.value = gate && gate.canAdvance ? 'ok' : 'bad'
  } catch (e: any) {
    runStates.value = { ...runStates.value, [key]: emptyRun('读取异常：' + (e?.message || e)) }
  } finally {
    runBusy.value = false
  }
}

async function advance(doc: Doc, s: Stage): Promise<void> {
  if (runBusy.value) return
  // 2026-11-03：拦“闭眼点推进”。判据不过时推进不是只读 —— 它会写“未完成 + 打回理由”，
  // 这也是用户“狂点一遍、有些通过有些没过”的现场来源。先跑判据看过结果再推进。
  if (!runOf(doc, s) && !confirm(
    '还没跑判据。若判据不过，推进会把这格写成“未完成 + 打回理由”。\n\n' +
    '确定 = 现在就跑并推进；取消 = 先点“⚙ 跑判据”看一眼'
  )) return
  const key = runKey(doc, s)
  runBusy.value = true
  runStates.value = { ...runStates.value, [key]: emptyRun('', true) }
  msg.value = ''
  try {
    const r: any = await (window as any).tegula.plansAdvance({ file: doc.file, stageId: s.id })
    if (!r?.ok) {
      runStates.value = { ...runStates.value, [key]: emptyRun('推进失败：' + (r?.error || '未知错误')) }
      msg.value = '没推进 ' + s.id + '：' + (r?.error || '未知错误')
      msgType.value = 'bad'
      return
    }
    runStates.value = {
      ...runStates.value,
      [key]: {
        loading: false, results: r.results || [], gate: r.gate || null,
        advanced: !!r.advanced, blocked: !!r.blocked, error: r.error || '',
      },
    }
    if (r.advanced) {
      msg.value = '已推进 ' + s.id + ' —— 判据全过，写进了“完成”'
      msgType.value = 'ok'
    } else if (r.blocked) {
      msg.value = '没推进 ' + s.id + '：判据没过，打回理由已写进卡里'
      msgType.value = 'bad'
    } else {
      msg.value = '没推进 ' + s.id + '：' + (r.error || '闸门拒绝')
      msgType.value = 'bad'
    }
    // 结果块里的“证据”要靠重读后的对象，所以推进后一律重读（不自己拼状态）
    await load()
  } finally {
    runBusy.value = false
  }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const r: any = await (window as any).tegula.plansGet()
    docs.value = r?.ok ? (r.docs || []) : []
    if (!r?.ok) msg.value = '读取失败：' + (r?.error || '未知错误')
  } catch (e: any) {
    docs.value = []
    msg.value = '读取异常：' + (e?.message || e)
    msgType.value = 'bad'
  } finally {
    loading.value = false
  }
}

function openText(doc: Doc, s: Stage, action: 'reject' | 'amend'): void {
  textTarget.value = { file: doc.file, stageId: s.id, action }
  text.value = ''
  msg.value = ''
}
function closeText(): void { textTarget.value = null; text.value = '' }

async function verdict(doc: Doc, s: Stage, action: 'pass' | 'reject' | 'amend', why = ''): Promise<void> {
  if (busy.value) return
  busy.value = true
  msg.value = ''
  try {
    const r: any = await (window as any).tegula.plansVerdict({
      file: doc.file, stageId: s.id, action, text: why,
    })
    if (!r?.ok) {
      msg.value = '没写成：' + (r?.error || '未知错误')
      msgType.value = 'bad'
      return
    }
    // 三种动作各自一句话（也让"三个分支"在源码里看得见，不是靠三元表达式糊过去）
    if (action === 'pass') msg.value = `已冻结 ${s.id}`
    else if (action === 'reject') msg.value = `已打回 ${s.id}——理由已写进卡里`
    else if (action === 'amend') msg.value = `已记录修改 ${s.id}——状态退回未冻结`
    msgType.value = 'ok'
    // 顶部回执 + 卡片闪一下：点完必须“看得见”，不能只靠页面底部那行字
    recent.value = {
      action, stageId: s.id, title: s.title || '', file: doc.file,
      project: projectOf(doc), text: why, recorded: false, decisionId: '',
    }
    flash(runKey(doc, s))
    textTarget.value = null
    text.value = ''
    await load()
  } finally {
    busy.value = false
  }
}

/**
 * 把刚发生的一次裁决记成决策卡（2026-11-03，暮雨第 4 条“没人提醒我记”）。
 * 只走既有 `decisionAdd`，不新开写口；内容/项目/出处全预填，一键落盘。
 * 计划卡裁决本身就是“定下来的事”，这是最该顺手记决策的地方。
 */
async function recordDecision(): Promise<void> {
  const r0 = recent.value
  if (!r0 || decisionBusy.value || r0.recorded) return
  decisionBusy.value = true
  try {
    const actionText = r0.action === 'pass' ? '通过（冻结）' : r0.action === 'reject' ? '打回' : '记录修改'
    const detail = r0.text ? `（${r0.text}）` : ''
    const r: any = await window.tegula.decisionAdd({
      内容: `${r0.stageId} ${r0.title}：${actionText}${detail}`,
      日期: todayLocal(),
      项目: r0.project,
      出处: '作战计划裁决 · ' + r0.file,
      备注: '由作战计划页在裁决后一键记录',
    })
    if (r?.ok) {
      r0.recorded = true
      r0.decisionId = String(r.id || '')
      msg.value = `已记决策卡 ${r0.decisionId}（在“决策”页可查）`
      msgType.value = 'ok'
    } else {
      msg.value = '记决策卡失败：' + (r?.error || '未知原因')
      msgType.value = 'bad'
    }
  } catch (e: any) {
    msg.value = '记决策卡异常：' + (e?.message || e)
    msgType.value = 'bad'
  } finally {
    decisionBusy.value = false
  }
}

function submitText(): void {
  const t = textTarget.value
  if (!t) return
  const doc = docs.value.find((d) => d.file === t.file)
  const s = doc?.stages.find((x) => x.id === t.stageId)
  if (doc && s) void verdict(doc, s, t.action, text.value.trim())
}

onMounted(() => { void load(); void loadWasteLedger(); void loadDrafts() })
</script>
