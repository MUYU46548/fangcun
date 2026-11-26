<!--
  问卷弹窗（2026-11-05）

  为什么做成弹窗、而不是独立页签：暮雨原话“我设想的就是问卷弹窗”。
  他 11-04 那 4 份问卷（`references/问卷样本/`）是这套东西的原型，本组件是它的产品化。

  边界（每条都对应一次真实讨论）：
   · **不做 GUI 出题器** —— 问卷是 agent 写的（“我现在的问卷全都是 agent 写的”），
     方寸只负责：呈现 → 收答案 → 存草稿 → 批准落库。
   · **草稿 → 批准**（他要求的）—— 点选只改草稿；必须点「批准并落库」才建决策卡。
     没批准就关掉 = 什么都没发生，且要明确告诉他。
   · **反问**（他最重要的一条）——“有时候用户想选一个根本不存在的选项，或者发出灵魂反问。
     而那种反问往往才是戳破迷雾、一锤定音的。” 反问不进决策，回给 agent 重写这一题。
   · **不写别人仓库** —— 批准只写方寸 `task-data/`；decision-log 段落导出成 md 给你自己贴。

  草稿是**每动一下就存**的（`questionnaireSaveAnswers`）：关窗、切页都不丢。
-->
<template>
  <div id="qn-modal" class="qn" @mousedown.self="$emit('close')">
    <div class="qn-dlg">
      <!-- ── 选卷 ─────────────────────────────────────────── -->
      <template v-if="!deck">
        <div class="qn-hd">
          <span class="qn-ttl">问卷</span>
          <span class="qn-sub">{{ pendingDecks.length }} 卷待答 · {{ doneDecks.length }} 卷已处理 · 说清“你想要什么”，不触发任何开发<template v-if="bank && bank.total"> · 题库 {{ bank.total }} 题（已答 {{ bank.answered }}<template v-if="bank.open">，待答 {{ bank.open }}</template>）</template></span>
          <span class="qn-grow"></span>
          <Button variant="ghost" size="tool" title="把出卷提示词复制给 agent —— 它按 qn_propose 出卷，出完就出现在这个列表里"
            @click="copyAuthorPrompt">🧾 让 agent 出问卷</Button>
          <Button variant="ghost" size="tool" @click="openDir">📂 问卷目录</Button>
          <Button variant="ghost" size="tool" @click="$emit('close')">关闭</Button>
        </div>
        <div class="qn-body">
          <div v-if="!decks.length" class="qn-empty">
            还没有问卷。<br>
            把 agent 写的问卷 md 放进 <code>{{ dir || 'task-data/questionnaires/' }}</code>，
            格式照 <code>## S1 题名</code> + <code>- **A. 选项**——说明</code>，刷新即可。
          </div>
          <!-- 2026-11-08：这里原来是 `v-if="auditDue.length"` / `v-else` —— 只要有一条
               “该看一眼了”，**卷列表就整块消失**，想开某一卷只能先点那行 due 进别的卷。
               真机截图（.shots-tmp/02）一眼看得到：弹窗里只剩一条 due，两卷都不见了。 -->
          <div v-if="auditDue.length" class="qn-due">
            <div class="qd-hd">
              <b>🔍 {{ auditDue.length }} 条答案该看一眼了</b>
              <span class="qd-sub">决策库的价值不在“记下来”，在事后能拿它验 —— 点进去逐条判“仍成立 / 已被推翻”</span>
            </div>
            <button v-for="(a, i) in auditDue.slice(0, 6)" :key="i" class="qd-row" @click="openDeck(a.deck)">
              <span class="qd-tag" :class="{ bad: a.refuted }">{{ a.refuted ? '已被推翻' : a.days + ' 天没看' }}</span>
              <span class="qd-q">{{ a.id }} · {{ a.ask }}</span>
              <span class="qd-d">{{ a.deck }}</span>
            </button>
            <div v-if="auditDue.length > 6" class="qd-more">还有 {{ auditDue.length - 6 }} 条，进各卷看</div>
          </div>
          <!-- 搜索（2026-11-11）：卷多了只能扫。题面命中由主进程给（卷名/标题/项目/题面一起搜）。 -->
          <div class="qn-search-row" v-if="decks.length">
            <input class="qn-search" v-model="q" placeholder="搜卷名 / 标题 / 项目 / 题面…（输入即搜）" />
            <span class="qn-search-tip" v-if="searchBusy">搜索中…</span>
            <span class="qn-search-tip" v-else-if="q">命中 {{ searchRows.length }} 卷</span>
            <Button variant="ghost" size="tool" v-if="q" @click="q = ''">清空</Button>
          </div>
          <!-- 搜索态：平铺结果 + 说清「哪一段命中了」，不用再猜为什么这卷在列表里 -->
          <div v-if="q" class="qn-decks">
            <button v-for="d in searchRows" :key="'s-' + d.deck" class="qn-deck" @click="openDeck(d.deck)">
              <span class="qd-main">
                <b>{{ d.title || d.deck }}</b>
                <span class="qd-badge" v-if="d.project">{{ d.project }}</span>
                <span class="qd-badge" v-for="(w, wi) in (searchHits[d.deck] || [])" :key="wi" :class="{ bad: w === '卷名' }">{{ w }}</span>
                <span class="qd-badge ok" v-if="d.approved">已批准</span>
                <span class="qd-badge bad" v-if="d.voided">已作废</span>
                <span class="qd-badge" v-if="d.archived">历史卷</span>
              </span>
              <span class="qd-meta">{{ d.answered }} / {{ d.total }} 题</span>
            </button>
            <div v-if="!searchRows.length && !searchBusy" class="qn-empty">没有命中「{{ q }}」的问卷。</div>
          </div>
          <template v-else>
            <!-- 题库 ↔ 卷（0.7.0 P11）：卷多了以后，用户真正要问的两句话 ——
                 “这条结论是从哪卷来的”“哪条答了却还没落地”—— 得有个地方能一眼查。 -->
            <div class="qn-hint">
              <Button variant="ghost" size="tool" :disabled="bankBusy" @click="toggleBank">
                📚 {{ showBank ? '收起题库' : '题库（哪条结论来自哪卷）' }}
              </Button>
              <Button variant="ghost" size="tool" @click="toggleBatch">{{ batchMode ? '退出多选' : '☑ 多选卷' }}</Button>
              <span class="qn-search-tip" v-if="bankMsg">{{ bankMsg }}</span>
            </div>
            <div v-if="batchMode" class="qn-hint">
              <span class="qn-search-tip">已选 {{ batchSel.length }} 卷</span>
              <Button variant="ghost" size="tool" :disabled="batchBusy || !batchSel.length" @click="runBatch('archive')">📦 归档所选卷</Button>
              <Button variant="ghost" size="tool" :disabled="batchBusy || !batchSel.length" @click="runBatch('void')">⌫ 作废所选卷…</Button>
              <span class="qn-search-tip" v-if="batchMsg">{{ batchMsg }}</span>
            </div>
            <div v-if="showBank" class="qn-bank">
              <div v-if="!bankRows.length" class="qn-empty">{{ bankBusy ? '读取题库关系中…' : '题库是空的（还没有任何题被记进 question-bank.md）' }}</div>
              <table v-else class="qb-tb">
                <thead>
                  <tr><th>题</th><th>状态</th><th>来自哪卷</th><th>引用它的卡</th><th>缺什么</th></tr>
                </thead>
                <tbody>
                  <tr v-for="r in bankRows" :key="r.id">
                    <td class="qb-q"><b>{{ r.id }}</b> {{ r.ask }}</td>
                    <td>{{ r.status }}</td>
                    <td>
                      <template v-if="r.sources && r.sources.length">
                        <span v-for="s in r.sources" :key="s.deck + '#' + s.qid" class="qb-src">
                          {{ s.deck }} #{{ s.qid }} · {{ s.answered ? '已答' : '未答' }}<template v-if="s.delivered && s.delivered.length"> · 交付 {{ s.delivered.length }} 张</template>
                        </span>
                      </template>
                      <span v-else class="qb-none">没有卷问过它</span>
                    </td>
                    <td>
                      <template v-if="r.cards && r.cards.length">
                        <span v-for="c in r.cards" :key="c" class="qb-src">{{ c }}</span>
                      </template>
                      <span v-else class="qb-none">—</span>
                    </td>
                    <td class="qb-note">{{ (r.notes || []).join('；') || '齐全' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <!-- 归档候选（2026-11-11）：已批准 ≥30 天 + 没有任何卡引用，才够格收起。
                 两个条件都在数据层判；这里只说清“为什么不能” —— 藏起来不等于删掉。 -->
            <div v-if="archivable.length" class="qn-hint">
              <Button variant="ghost" size="tool" :disabled="archiveBusy" @click="archiveAllCandidates">
                📦 把 {{ archivable.length }} 卷已批准 ≥30 天、无卡引用的卷移入历史卷
              </Button>
              <span class="qn-search-tip" v-if="archiveMsg">{{ archiveMsg }}</span>
            </div>
            <div v-if="archivableBlocked.length" class="qn-search-tip">
              {{ archivableBlocked.length }} 卷够天数但先不动：{{ archivableBlocked.slice(0, 3).map((b) => b.deck + '（' + b.why + '）').join('；') }}
            </div>
            <div v-if="doneDecks.length" class="qn-hint">
              <Button variant="ghost" size="tool" @click="showDone = !showDone">
                {{ showDone ? '▴ 收起已处理' : '▾ 展开已处理' }}（{{ doneDecks.length }} 卷 · 已批准 / 已作废 / 已被取代）
              </Button>
            </div>
            <div v-if="archivedDecks.length" class="qn-hint">
              <Button variant="ghost" size="tool" @click="showArchived = !showArchived">
                {{ showArchived ? '▴ 收起历史卷' : '▾ 历史卷' }}（{{ archivedDecks.length }} 卷 · 不进列表，但仍参与裁决）
              </Button>
            </div>
            <div v-if="visibleDecks.length || (showArchived && archivedDecks.length)" class="qn-decks">
              <button v-for="d in (showArchived ? [...visibleDecks, ...archivedDecks] : visibleDecks)" :key="d.deck" class="qn-deck"
                :class="{ picked: batchMode && batchSel.includes(d.deck) }"
                @click="batchMode ? toggleBatchSel(d.deck) : openDeck(d.deck)">
                <span v-if="batchMode" class="qd-check">{{ batchSel.includes(d.deck) ? '☑' : '☐' }}</span>
                <span class="qd-main">
                  <b>{{ d.title || d.deck }}</b>
                  <span class="qd-badge" v-if="d.project">{{ d.project }}</span>
                  <span class="qd-badge" v-if="d.layer">{{ d.layer }}</span>
                  <span class="qd-badge ok" v-if="d.approved">已批准</span>
                  <span class="qd-badge bad" v-if="d.voided">已作废</span>
                  <span class="qd-badge" v-if="d.replacedBy" :title="'已被《' + d.replacedBy + '》取代'">已被取代</span>
                  <span class="qd-badge" v-if="d.archived">历史卷</span>
                  <span class="qd-badge bad" v-if="d.error">解析有问题</span>
                </span>
                <span class="qd-meta">
                  {{ d.answered }} / {{ d.total }} 题<template v-if="d.delivered"> · {{ d.delivered }} 题已交付</template><template v-if="d.refCount"> · {{ d.refCount }} 张卡引用</template>{{ d.error ? ' · ' + d.error : '' }}
                </span>
              </button>
            </div>
          </template>
        </div>
      </template>

      <!-- ── 答题 ─────────────────────────────────────────── -->
      <template v-else>
        <div class="qn-hd">
          <Button class="qn-back" variant="ghost" size="tool" @click="backToList">← 全部问卷</Button>
          <span class="qn-ttl">{{ deck.parsed.title || deck.deck }}</span>
          <span class="qn-sub">已答 {{ answeredCount }} / {{ total }}<template v-if="bank && bank.total"> · 本项目题库 已答 {{ bank.answered }} / 待答 {{ bank.open }}</template><template v-if="conv"> · {{ conv.summary }}</template></span>
          <span class="qn-grow"></span>
          <div class="qn-seg">
            <button :class="{ on: view === 'one' }" @click="view = 'one'">一次一题</button>
            <button :class="{ on: view === 'all' }" @click="view = 'all'">整卷</button>
          </div>
          <Button variant="ghost" size="tool" @click="$emit('close')">关闭</Button>
        </div>
        <div class="qn-bar"><i :style="{ width: (total ? answeredCount / total * 100 : 0) + '%' }"></i></div>

        <!-- 卷面质量闸（2026-11-07）：没写代价的选项 = 让人在黑暗里选。
             只点名、不删选项（删了他想选就选不到），出口是「打包成重出题」让出卷人补。 -->
        <div v-if="issues.length && !voidedAt" class="qn-warn">
          <b>⚠ 卷面 {{ issues.length }} 处要补</b>
          <span class="qw-names">{{ issueSummary }}</span>
          <span class="qw-hint">补代价 / 补验收线 / 拆批都是出卷人的活 —— 你只答，不替 agent 改题</span>
          <Button variant="ghost" size="tool" @click="openPrompt('rewrite')">打包成补代价</Button>
        </div>
        <div v-if="voidedAt" class="qn-void">
          <b>⚠ 这卷已作废（{{ voidedAt.slice(0, 10) }}）</b>
          <span class="qw-names">{{ voidReason || '未写原因' }}</span>
          <span class="qw-hint">作废的答案不再作数、也不会再落决策卡</span>
          <Button variant="ghost" size="tool" @click="doReopen">恢复这卷</Button>
        </div>

        <div class="qn-cols">
          <div class="qn-rail">
            <button v-for="q in deck.parsed.questions" :key="q.id" class="qn-rail-i"
              :class="{ on: view === 'one' && q.id === curId }" @click="goto(q.id)">
              <span class="ri-k">{{ q.id }}</span>
              <span class="ri-t">{{ q.nav || q.ask || q.id }}</span>
              <span class="ri-s" :class="stateClass(q.id)">{{ stateGlyph(q.id) }}</span>
            </button>
            <button v-if="parked.length" class="qn-rail-x" :class="{ on: extra === 'parked' }"
              @click="toggleExtra('parked')">
              📌 预埋 {{ parked.length }} 项<span class="rx-n">现在答不了</span>
            </button>
            <button v-if="lookRows.length" class="qn-rail-x" :class="{ on: extra === 'look' }"
              @click="toggleExtra('look')">
              🔗 入口总表 {{ lookRows.length }} 条<span class="rx-n">照着眼就行</span>
            </button>
            <button v-if="auditable.length" class="qn-rail-x" :class="{ on: extra === 'audit' }"
              @click="toggleExtra('audit')">
              🔍 待校验 {{ auditable.length }} 条<span class="rx-n">已校验 {{ auditDone }}</span>
            </button>
            <div class="qn-rail-foot">
              · 没答　○ 跳过　✕ 否决<br>❗ 反问（回给 agent）　✓ 已答
            </div>
          </div>

          <div class="qn-main">
            <!-- 额外页：预埋表 / 入口总表 / 提示词。⚠ 一定是链头，插到中间会让后面整段不渲染 -->
            <div v-if="extra === 'parked'" class="qn-extra">
              <div class="xe-hd">
                <b>预埋 {{ parked.length }} 项</b>
                <span class="xe-sub">现在答不了 —— 不是遗漏，是等条件。条件到了 agent 会把它变成正式题。</span>
                <span class="qn-grow"></span>
                <Button variant="ghost" size="tool" @click="extra = ''">收起</Button>
              </div>
              <table class="xe-tb">
                <thead>
                  <tr><th v-for="(h, hi) in parkedHead" :key="hi">{{ h }}</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(p, i) in parked" :key="i">
                    <td class="xe-q">{{ p.q }}</td>
                    <td>{{ p.need }}</td>
                    <td>{{ p.when }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-else-if="extra === 'look'" class="qn-extra">
              <div class="xe-hd">
                <b>看一眼 · 入口总表</b>
                <span class="xe-sub">全卷共用 —— 答题时不用懂名词，照着看就行。</span>
                <span class="qn-grow"></span>
                <Button variant="ghost" size="tool" @click="extra = ''">收起</Button>
              </div>
              <table class="xe-tb">
                <thead><tr><th>名字</th><th>一句话</th><th>入口</th></tr></thead>
                <tbody>
                  <tr v-for="(r, i) in lookRows" :key="i">
                    <td class="xe-q">{{ r.nm }}</td>
                    <td>{{ r.ds }}</td>
                    <td class="xe-url">{{ r.url }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-else-if="extra === 'prompt'" class="qn-extra">
              <div class="xe-hd">
                <b>{{ promptKind === 'rewrite' ? '重出题提示词' : '出施工单提示词' }}</b>
                <span class="xe-sub">{{ promptKind === 'rewrite'
                  ? '粘给 agent：它只重写被反问的那几题，不重发整卷'
                  : '粘给 agent：把已定的翻成可验收的小步，没定的标成待定' }}</span>
                <span class="qn-grow"></span>
                <Button variant="ghost" size="tool" @click="copyPrompt">⧉ 复制</Button>
                <Button variant="ghost" size="tool" @click="extra = ''">收起</Button>
              </div>
              <pre class="xe-pre">{{ promptText }}</pre>
            </div>

            <div v-else-if="extra === 'audit'" class="qn-extra">
              <div class="xe-hd">
                <b>事后校验 · {{ auditable.length }} 条</b>
                <span class="xe-sub">只列“有答案 + 有验收线”的题 —— 没有验收线就没有判据，硬列出来只能自欺</span>
                <span class="qn-grow"></span>
                <Button variant="ghost" size="tool" @click="extra = ''">收起</Button>
              </div>
              <div v-if="!auditable.length" class="qn-empty">
                这卷还没有可校验的答案（跳过 / 否决 / 反问 / 作废都不算答案）。
              </div>
              <div v-for="q in auditable" :key="q.id" class="au-row">
                <div class="au-hd">
                  <span class="au-id">{{ q.id }}</span>
                  <span class="au-ask">{{ q.ask || q.nav }}</span>
                  <span class="au-v" :class="audits[q.id] ? (audits[q.id].verdict === 'ok' ? 'ok' : 'bad') : ''">
                    {{ !audits[q.id] ? '没校验' : (audits[q.id].verdict === 'ok' ? '仍成立' : '已被推翻') }}
                  </span>
                </div>
                <div class="au-line">验收线：{{ q.line }}</div>
                <div v-if="audits[q.id] && audits[q.id].evidence" class="au-ev">证据：{{ audits[q.id].evidence }}</div>
                <div class="au-acts">
                  <input v-model="auditDraft[q.id]" class="au-in" placeholder="一句证据（判“被推翻”必须写）" />
                  <Button variant="outline" size="sm" @click="doAudit(q.id, 'ok')">✓ 仍成立</Button>
                  <Button variant="danger" size="sm" @click="doAudit(q.id, 'refuted')">✗ 已被推翻</Button>
                </div>
              </div>
            </div>

            <!-- 整卷 -->
            <div v-else-if="view === 'all'" class="qn-all">
              <div v-for="q in deck.parsed.questions" :key="q.id" class="qn-card"
                :class="{ ans: isAnswered(q.id), askc: answers[q.id] && answers[q.id].kind === 'askback' }">
                <div class="qc-hd"><span class="qc-id">{{ q.id }}</span><span class="qc-ask">{{ q.ask || q.nav }}</span></div>
                <div v-if="q.look" class="qn-look">
                  <button class="look-hd" @click="toggleLook(q.id)">
                    <span class="arw" :class="{ open: lookOpen[q.id] }">▶</span>
                    看一眼 · 不用懂名词，点开照着眼就行
                  </button>
                  <div v-if="lookOpen[q.id]" class="look-bd">{{ q.look }}</div>
                </div>
                <div v-if="q.prefilled" class="qn-note">这题答过 —— 沿用就打勾，变则改一句</div>
                <div class="qn-opts">
                  <button v-for="o in q.options" :key="o.k" class="qn-opt"
                    :class="{ on: answers[q.id] && answers[q.id].kind === 'pick' && answers[q.id].k === o.k }"
                    @click="pick(q.id, o.k)">
                    <span class="kk">{{ o.k }}</span>
                    <span class="txt"><b>{{ o.t }}</b><small v-if="o.d">{{ o.d }}</small></span>
                  </button>
                </div>
                <div v-if="answers[q.id]" class="qn-state">
                  {{ stateText(q.id) }}
                  <!-- 回程（卡 20261107-004）：这条答案有没有对应的卡、卡现在什么状态 -->
                  <span v-if="deliveryText(q.id)" class="qn-deliver" :class="{ bad: deliveryOf(q.id).status === 'rejected' }">
                    · {{ deliveryText(q.id) }}
                  </span>
                  <button class="undo" @click="reset(q.id)">撤销这次操作</button>
                </div>
                <div class="qn-acts">
                  <Button variant="ghost" size="tool" @click="mark(q.id, 'skip')">跳过</Button>
                  <button class="danger" @click="mark(q.id, 'reject')">否决</button>
                  <button class="ask" @click="startEdit(q.id, 'askback')">❗ 反问…</button>
                  <Button variant="ghost" size="tool" @click="startEdit(q.id, 'amend')">改一句…</Button>
                  <Button variant="ghost" size="tool" @click="mark(q.id, 'self')"
                    title="这题以后不用再问方寸 —— 进题库黑名单，永不复问">你自判</Button>
                  <Button variant="ghost" size="tool" v-if="answers[q.id] && answers[q.id].kind !== 'void'" @click="startVoid(q.id)">⌫ 作废…</Button>
                </div>
                <div v-if="editing && editing.id === q.id" class="qn-edit" :class="{ ask: editing.kind === 'askback' }">
                  <div class="qe-hint">{{ editing.kind === 'askback'
                    ? '这题问错了 —— 说一句真正该问的（会回给 agent 重写这一题；留空 = 否决）'
                    : editing.kind === 'void'
                      ? '作废这一项：当时答得对、现在不作数了。必须写原因（三个月后只有这句话能解释）'
                      : '选项都不对？补一句（会原样落进 decision-log）' }}</div>
                  <textarea :value="editText" rows="2" @input="onEditInput"></textarea>
                  <div class="qe-row">
                    <Button variant="ghost" size="tool" @click="cancelEdit">取消</Button>
                    <button class="pri" @click="commitEdit">确定</button>
                  </div>
                </div>
                <div class="qn-meta">
                  <Button class="meta-t" variant="ghost" size="sm" @click="toggleMeta(q.id + '-src')">▸ 出处{{ metaOpen[q.id + '-src'] ? '：' + q.src : '' }}</Button>
                  <Button class="meta-t" variant="ghost" size="sm" @click="toggleMeta(q.id + '-line')">▸ 验收线{{ metaOpen[q.id + '-line'] ? '：' + q.line : '' }}</Button>
                </div>
              </div>
            </div>

            <!-- 一次一题 -->
            <div v-else-if="currentQ" class="qn-one">
              <div class="q-id">{{ currentQ.id }}</div>
              <div class="q-ask">{{ currentQ.ask || currentQ.nav }}</div>
              <div v-if="currentQ.prefilled" class="qn-note">这题答过 —— {{ currentQ.prefilledNote || '沿用就打勾，变则改一句' }}</div>
              <div v-if="currentQ.look" class="qn-look">
                <button class="look-hd" @click="toggleLook(currentQ.id)">
                  <span class="arw" :class="{ open: lookOpen[currentQ.id] }">▶</span>
                  看一眼 · 不用懂名词，点开照着眼就行
                </button>
                <div v-if="lookOpen[currentQ.id]" class="look-bd">{{ currentQ.look }}</div>
              </div>
              <!-- 我的意见（2026-11-15 暮雨：「不要只是给我看不懂的问题，这是方寸本身也存在的问题」）。
                   卷子只给选项 = 把决策成本原样转嫁回用户。这一块把"我怎么想"摆出来：
                   推荐哪一档、为什么、以及**我有没有把握**。
                   ⚠ 三态必须分开，否则这道题等于没答：
                     · 有推荐 → 「我倾向 B」+ 理由
                     · 写了意见但没点名 → 「我有想法但没定档」+ 理由
                     · 一个字没写 → 「这一题我没有把握」**明说**，不许静默留白
                       （静默留白会被读成"方寸觉得随便都行"，那是替人下了结论）。 -->
              <div class="qn-opinion" :class="{ weak: !currentQ.recommend, none: !currentQ.opinion }">
                <span class="qo-hd">
                  {{ currentQ.recommend ? '我倾向 ' + currentQ.recommend
                    : currentQ.opinion ? '我有想法，但没定档'
                    : '这一题我没有把握' }}
                </span>
                <span v-if="currentQ.opinion" class="qo-bd">{{ currentQ.opinion }}</span>
                <span v-else class="qo-bd">（写卷的 agent 没给意见 —— 这一题只能你自己判）</span>
              </div>
              <div class="qn-opts">
                <button v-for="o in currentQ.options" :key="o.k" class="qn-opt"
                  :class="{ on: answers[currentQ.id] && answers[currentQ.id].kind === 'pick' && answers[currentQ.id].k === o.k,
                            rec: currentQ.recommend === o.k }"
                  @click="pick(currentQ.id, o.k)">
                  <span class="kk">{{ o.k }}</span>
                  <span class="txt"><b>{{ o.t }}</b><small v-if="o.d">{{ o.d }}</small></span>
                  <span v-if="currentQ.recommend === o.k" class="qo-rec">我的意见</span>
                </button>
              </div>
              <div v-if="answers[currentQ.id]" class="qn-state">
                {{ stateText(currentQ.id) }}
                <span v-if="deliveryText(currentQ.id)" class="qn-deliver" :class="{ bad: deliveryOf(currentQ.id).status === 'rejected' }">
                  · {{ deliveryText(currentQ.id) }}
                </span>
                <button class="undo" @click="reset(currentQ.id)">撤销这次操作</button>
              </div>
              <div v-if="editing && editing.id === currentQ.id" class="qn-edit" :class="{ ask: editing.kind === 'askback' }">
                <div class="qe-hint">{{ editing.kind === 'askback'
                  ? '这题问错了 —— 说一句真正该问的（会回给 agent 重写这一题；留空 = 否决）'
                  : editing.kind === 'void'
                    ? '作废这一项：当时答得对、现在不作数了。必须写原因（三个月后只有这句话能解释）'
                    : '选项都不对？补一句（会原样落进 decision-log）' }}</div>
                <textarea :value="editText" rows="3" @input="onEditInput"></textarea>
                <div class="qe-row">
                  <Button variant="ghost" size="tool" @click="cancelEdit">取消</Button>
                  <button class="pri" @click="commitEdit">确定</button>
                </div>
              </div>
              <div class="qn-meta">
                <Button class="meta-t" variant="ghost" size="sm" @click="toggleMeta(currentQ.id + '-src')">▸ 出处{{ metaOpen[currentQ.id + '-src'] ? '：' + currentQ.src : '' }}</Button>
                <Button class="meta-t" variant="ghost" size="sm" @click="toggleMeta(currentQ.id + '-line')">▸ 验收线{{ metaOpen[currentQ.id + '-line'] ? '：' + currentQ.line : '' }}</Button>
              </div>
            </div>
          </div>
        </div>

        <!-- 整卷作废（需求变了，旧答案不作数）—— 折在底栏上方，不占常驻位置 -->
        <div v-if="voidOpen && !voidedAt" class="qn-voidbox">
          <b>作废这卷？</b>
          <span class="qw-hint">答案不作数、决策卡一并撤下；原因必填 —— 三个月后只有这句话能解释</span>
          <input v-model="voidDraft" class="au-in" placeholder="作废原因（必填）" />
          <Button variant="ghost" size="tool" @click="voidOpen = false">取消</Button>
          <button class="danger" :disabled="voidBusy" @click="doVoidDeck">确认作废</button>
        </div>

        <!-- 底栏 -->
        <div class="qn-ft">
          <template v-if="extra">
            <Button variant="ghost" size="tool" @click="extra = ''">← 返回题目</Button>
            <span class="qn-grow"></span>
            <span class="qn-ft-note">{{ extra === 'prompt' ? '复制后粘给 agent 就行' : '这不是题目 —— 不用答，看看就好' }}</span>
          </template>
          <template v-else-if="!summary">
            <Button variant="ghost" size="tool" @click="mark(curId, 'skip')">跳过</Button>
            <button class="danger" @click="mark(curId, 'reject')">否决</button>
            <button class="ask" @click="startEdit(curId, 'askback')">❗ 反问…</button>
            <Button variant="ghost" size="tool" @click="startEdit(curId, 'amend')">改一句…</Button>
            <Button variant="ghost" size="tool" @click="mark(curId, 'self')"
              title="这题以后不用再问方寸 —— 进题库黑名单，永不复问">你自判</Button>
            <Button variant="ghost" size="tool" v-if="answers[curId] && answers[curId].kind !== 'void'" @click="startVoid(curId)">⌫ 作废…</Button>
            <span class="qn-grow"></span>
            <Button variant="ghost" size="tool" @click="prev" :disabled="idx === 0">← 上一题</Button>
            <button class="pri" @click="next">{{ idx === total - 1 ? '答完了 · 看结果' : '下一题 →' }}</button>
          </template>
          <template v-else>
            <Button variant="ghost" size="tool" @click="summary = false">← 回去改</Button>
            <Button variant="ghost" size="tool" @click="copyMd">⧉ 复制 md</Button>
            <Button variant="ghost" size="tool" v-if="approved" @click="downloadMd">⬇ 导出</Button>
            <!-- 出口（2026-11-05）：有反问只能「重出题」；反问清零了才给「出施工单」。
                 为什么不给两个都显示：问题还没定时出的单必然是错的（问卷不是施工单）。 -->
            <button v-if="askCount" class="ask" :disabled="promptBusy" @click="openPrompt('rewrite')">
              ❗ 打包成重出题（{{ askCount }}）
            </button>
            <Button variant="ghost" size="tool" v-else :disabled="promptBusy" @click="openPrompt('build')">
              📋 生成施工单提示词
            </Button>
            <select v-if="cardOptions.length && approved && !voidedAt && !cardDone" v-model="cardProject" class="qn-sel"
              title="落卡落到哪个项目；默认按卷名自动认">
              <option value="">自动（按卷名）</option>
              <option v-for="p in cardOptions" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <Button v-if="approved && !voidedAt" variant="primary" size="sm" :disabled="cardBusy" @click="makeCards"
              title="把这些答案落成 task-data 里的任务卡 —— 没卡就没人施工">
              {{ cardDone ? `✓ 已落 ${cardDone.created} 张` : '🗂 落成任务卡' }}
            </Button>
            <Button variant="ghost" size="tool" v-if="voidedAt" @click="doReopen">恢复这卷</Button>
            <button v-else class="danger" @click="voidOpen = !voidOpen">⌫ 作废这卷</button>
            <!-- 历史卷（2026-11-11）：已批准、没人再引用了才能收起。收起不影响裁决 ——
                 决策卡、验收线照旧生效，只是列表里不再占位。 -->
            <Button variant="ghost" size="tool" v-if="approved && !voidedAt && !archivedAt" @click="archiveOne(deck.deck)"
              title="已批准 ≥30 天且没有任何卡引用时才可以收起">📦 移入历史卷</Button>
            <Button variant="ghost" size="tool" v-if="archivedAt" @click="unarchiveOne(deck.deck)">↩ 放回列表</Button>
            <span class="qn-grow"></span>
            <span v-if="approved" class="qn-ok" :title="'存下来的是 UTC（' + approved + '），这里按你所在时区显示'">已落库 · {{ localStamp(approved) }}</span>
            <button v-if="!approved" class="pri" :disabled="busy" @click="approve">✓ 批准并落库</button>
            <button v-else class="pri" @click="$emit('close')">关闭</button>
          </template>
        </div>

        <div class="qn-hint">
          <template v-if="!summary">草稿每改一下就存 · 点「批准并落库」才真正写入决策卡</template>
          <template v-else-if="!approved">上面是草稿 —— 没批准就关掉 = 什么都没发生（也不能落成任务卡）</template>
          <template v-else>已批准：决策卡已建、decision-log 段落已导出；要点「落成任务卡」才会进 task-data 被派活</template>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
// UI 基座 · 第一刀迁移（2026-11-07）：本轮新增的三个按钮走 components/ui/Button.vue
import Button from './ui/Button.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
// 列表分组口径（2026-11-11）：待答 / 已处理 / 历史卷三条的判定在纯函数里，e2e 能直接断言
import { groupDecks } from '../../shared/deckGroups'
import { copyText as copyToClipboard } from '../../shared/clipboard'
import { toPlain } from '../../shared/plain'
import { buildDeckAuthoringPrompt } from '../../shared/qnPrompts'
import { formatLocalStamp, localDay } from '../../shared/time'

const emit = defineEmits<{ (e: 'close'): void; (e: 'toast', msg: string, kind?: string): void }>()
/**
 * 从通知点进来时直接开那一卷（2026-11-11 暮雨：「新问卷完全无提示」）。
 * 只在初 mount 生效：之后再传值不抢用户当前正在看的题。
 */
const props = defineProps<{ initialDeck?: string }>()

interface QOpt { k: string; t: string; d: string }
interface QItem { id: string; nav: string; ask: string; options: QOpt[]; src: string; line: string; look: string; prefilled: boolean; prefilledNote: string }
interface QParked { q: string; need: string; when: string }
interface QParsed {
  title: string; layer: string; questions: QItem[]
  lookTable: { nm: string; ds: string; url: string }[]
  /** 「预埋」——现在答不了的那些题（样本里叫“裁决层预埋”或“摊不开的”） */
  parked: QParked[]
  /** 预埋表的表头（原样；两份样本说法不同，硬编一种就会写成错标题） */
  parkedHead: string[]
}
interface QAns { kind: 'pick' | 'skip' | 'reject' | 'askback' | 'amend' | 'void' | 'self'; k?: string; text?: string }
interface QDeckBrief {
  deck: string; title: string; layer: string; total: number; answered: number
  approved: boolean; voided?: boolean; project?: string; costGaps?: number; error?: string
  /** 2026-11-11 问卷管理：取代关系 / 归档 / 引用数 / 批准天数（主进程算好，界面不算） */
  supersedes?: string; replacedBy?: string; archived?: boolean
  ageDays?: number; refCount?: number; approvedAt?: string
  /** 已交付题数（卡完成的回程） */
  delivered?: number
}

const api = () => (window as any).tegula

const decks = ref<QDeckBrief[]>([])
/**
 * 列表分组（2026-11-10 用户报障：「问卷越堆越多，后续管理问卷本身将成为一大难题」）。
 * 已知的账：一次首战就留下 4 卷（含 1 卷被反问后重写）。照这个速度，一个月就是几十卷 ——
 * 所以列表必须先回答「哪几卷还要我处理」：待答在前，已批准/已作废/被取代/历史卷都收起。
 *
 * ⚠ 2026-11-11 补的**第一条硬判据**：被取代的卷**不许再出现在待答里** ——
 *   哪怕它还有未答题。它的问题已经被 v2 重问过了，把它摆在“待答”就是让人去答一份废卷。
 */
const showDone = ref(false)
/**
 * 列表分组（2026-11-10 用户报障：「问卷越堆越多，后续管理问卷本身将成为一大难题」）。
 * 口径在 `shared/deckGroups.ts`（纯函数，可被 e2e 拿 40 个假卷直接断言）——
 * 组件只负责渲染，不在模板里再写一遍过滤条件。
 */
const groups = computed(() => groupDecks(decks.value as any))
const pendingDecks = computed(() => groups.value.pending as QDeckBrief[])
const doneDecks = computed(() => groups.value.done as QDeckBrief[])
const visibleDecks = computed(() => (showDone.value ? [...pendingDecks.value, ...doneDecks.value] : pendingDecks.value))
/** 历史卷（已归档）：不占列表，但**仍然参与裁决** —— 只是“翻旧账时再来找” */
const showArchived = ref(false)
const archivedDecks = computed(() => groups.value.archived as QDeckBrief[])

// ── 搜索（2026-11-11）────────────────────────────────────────────────────
// 卷名 / 标题 / 项目 / **题面** 都搜（判据原文：输「备份」要能同时命中卷名与题面）。
// 题面只有主进程读得到卷文件，所以走 IPC；输入防抖 250ms，避免每敲一个字都扫一遍。
const q = ref('')
const searchRows = ref<QDeckBrief[]>([])
const searchHits = ref<Record<string, string[]>>({})
const searchBusy = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(q, () => {
  if (searchTimer) clearTimeout(searchTimer)
  if (!String(q.value || '').trim()) {
    searchRows.value = []
    searchHits.value = {}
    return
  }
  searchTimer = setTimeout(runSearch, 250)
})
async function runSearch(): Promise<void> {
  const term = String(q.value || '').trim()
  if (!term) return
  searchBusy.value = true
  try {
    const r: any = await api().questionnaireSearch(term)
    searchRows.value = Array.isArray(r?.decks) ? r.decks : []
    searchHits.value = (r && r.hits) || {}
  } catch (e: any) {
    toast('搜索失败：' + (e?.message || e), 'error')
  } finally {
    searchBusy.value = false
  }
}

// ── 归档（2026-11-11）────────────────────────────────────────────────────
// 判据：已批准 ≥30 天**且没有任何卡引用**。两个条件都在主进程判（数据层），
// 界面只负责把“能归档的”摆出来、把“为什么不能”说清。
const archivable = ref<QDeckBrief[]>([])
const archivableBlocked = ref<{ deck: string; why: string }[]>([])
const archiveBusy = ref(false)
const archiveMsg = ref('')
const archivedNow = ref(false)
/**
 * 题库进度（2026-11-10）：一个项目几十上百道题时，“还剩多少没问”必须一眼看得见，
 * 否则每开一卷都像从头开始。数据来自主进程（listDecks / getDeck 带回来的 bank）。
 */
const bank = ref<{ total: number; answered: number; open: number; blacklist: number } | null>(null)

// ── 题库 ↔ 卷 关系视图（0.7.0 P11）────────────────────────────────────────
// 卷多到几十份以后，用户真正问的是两句：“这条结论是从哪卷来的？”“哪条还没落地？”
// 关系全在主进程算（`questionBank.bankRelations` 是纯函数，能 node 直跑断言），界面只摆。
const showBank = ref(false)
const bankBusy = ref(false)
const bankRows = ref<any[]>([])
const bankStat = ref<{ questions: number; withDeck: number; withCard: number; orphan: number; answeredNoCard: number } | null>(null)
const bankMsg = ref('')

async function toggleBank(): Promise<void> {
  showBank.value = !showBank.value
  if (!showBank.value) return
  if (bankBusy.value) return
  bankBusy.value = true
  bankMsg.value = ''
  try {
    const r: any = await api().questionnaireBankRelations('')
    bankRows.value = Array.isArray(r?.rows) ? r.rows : []
    bankStat.value = r?.stats || null
    const s = bankStat.value
    bankMsg.value = s
      ? `${s.questions} 题 · 有卷问过 ${s.withDeck} · 已落成卡 ${s.withCard} · 没卷问过 ${s.orphan} · 答了还没落卡 ${s.answeredNoCard}`
      : ''
  } catch (e: any) {
    bankRows.value = []
    bankMsg.value = '读题库关系失败：' + (e?.message || e)
  } finally {
    bankBusy.value = false
  }
}

// ── 多卷批量处置（P11）───────────────────────────────────────────────────
// 判据不是“批量按钮能点”，是**失败逐条点名**：某一卷卷面坏掉时它什么都不改、并被报出来，
// 其余照做。这条口径在数据层（`batchDeckAction`），界面只显示 done / failed 两栏。
const batchMode = ref(false)
const batchSel = ref<string[]>([])
const batchBusy = ref(false)
const batchMsg = ref('')

function toggleBatch(): void {
  batchMode.value = !batchMode.value
  batchSel.value = []
  batchMsg.value = ''
}

function toggleBatchSel(name: string): void {
  batchSel.value = batchSel.value.includes(name)
    ? batchSel.value.filter((x) => x !== name)
    : [...batchSel.value, name]
}

async function runBatch(action: 'archive' | 'void'): Promise<void> {
  if (batchBusy.value || !batchSel.value.length) return
  const decks = [...batchSel.value]
  let reason = ''
  if (action === 'void') {
    reason = window.prompt('作废理由（会写进卷的答案文件）', '批量处置：不再需要') || ''
    if (!reason.trim()) return
  }
  batchBusy.value = true
  batchMsg.value = ''
  try {
    const r: any = await api().questionnaireBatchAction({ decks, action, reason })
    const done = Array.isArray(r?.done) ? r.done : []
    const failed = Array.isArray(r?.failed) ? r.failed : []
    batchMsg.value = String(r?.note || '')
    if (failed.length) {
      toast(`批量${action === 'void' ? '作废' : '归档'}：成功 ${done.length} 卷、失败 ${failed.length} 卷 —— `
        + failed.map((f: any) => `${f.deck}（${f.error}）`).join('；'), 'error')
    } else {
      toast(batchMsg.value, 'success')
    }
    batchMode.value = false
    batchSel.value = []
    await loadList()
    if (showBank.value) await toggleBankProxy()
  } catch (e: any) {
    batchMsg.value = '批量处置失败：' + (e?.message || e)
  } finally {
    batchBusy.value = false
  }
}

/** 批量之后重算关系视图（不切换开关，只刷新数据） */
async function toggleBankProxy(): Promise<void> {
  showBank.value = false
  await toggleBank()
}
/**
 * 结论集收敛进度（P8 · D-064）：`连续不变 x/3`。
 * 判据原话“问够没问够必须是代码判定的”——这句就是那个判定的人话出口。
 */
const conv = ref<{ summary: string; need: number } | null>(null)
const dir = ref('')
const deck = ref<{ deck: string; parsed: QParsed } | null>(null)
const answers = ref<Record<string, QAns>>({})
const approved = ref('')
/** 整卷作废（空 = 没作废）与原因 —— 作废是"当时答得对、现在不作数"，与「否决」不是一回事 */
const voidedAt = ref('')
const voidReason = ref('')
/** 历史卷（已归档）：空 = 在列表里；有值 = 收起（答案仍参与裁决，不是作废） */
const archivedAt = ref('')
/** 逐题事后校验结论 */
const audits = ref<Record<string, { verdict: 'ok' | 'refuted'; evidence: string; at: string }>>({})
/**
 * 逐题交付状态（2026-11-11 卡 20261107-004）：答案对应的卡完成/驳回后回写到这里。
 * 只影响**展示**；答案本身与这一层无关（答案不许被卡的状态改写）。
 */
const deliveries = ref<Record<string, { cardId: string; status: 'delivered' | 'rejected'; at: string; reason?: string }[]>>({})
function deliveryOf(qid: string): { cardId: string; status: 'delivered' | 'rejected'; at: string; reason?: string } | null {
  const list = deliveries.value[qid]
  if (!Array.isArray(list) || !list.length) return null
  return list[list.length - 1]
}
/** 交付状态一句话（没人交付就空串 —— 界面上的 v-if 靠它决定显不显） */
function deliveryText(qid: string): string {
  const d = deliveryOf(qid)
  if (!d) return ''
  const when = String(d.at || '').slice(0, 10)
  return (d.status === 'delivered' ? '已交付' : '未通过')
    + ' ' + d.cardId
    + (d.reason ? '（' + d.reason + '）' : '')
    + (when ? ' · ' + when : '')
}
/** 卷面里没写代价的选项（黄条点名用） */
const costGaps = ref<{ id: string; k: string; t: string }[]>([])
/** 卷面体检：缺代价 / 缺验收线 / 超一批（只报告，不改卷） */
const issues = ref<{ kind: string; id?: string; text: string }[]>([])
/** 三类问题各几处，黄条上一行说清 */
const issueSummary = computed(() => {
  const n = (k: string) => issues.value.filter((x) => x.kind === k).length
  const parts: string[] = []
  if (n('noCost')) parts.push(`${n('noCost')} 个选项没写代价`)
  if (n('noLine')) parts.push(`${n('noLine')} 题没写验收线`)
  if (n('tooMany')) parts.push(`${n('tooMany')} 批超量（> 6 题/批）`)
  return parts.join(' · ')
})
/** 跨卷「该看一眼了」清单（选卷页顶部） */
const auditDue = ref<{ deck: string; id: string; ask: string; days: number; refuted: boolean }[]>([])
/** 作废原因输入 */
const voidDraft = ref('')
const voidBusy = ref(false)
/** 整卷作废的输入行是否展开 */
const voidOpen = ref(false)
/** 落卡：项目选择与本轮进度（答案 → 真任务卡 是"反馈给施工方"的最后一步） */
const cardProject = ref('')
const cardOptions = ref<{ id: string; name: string }[]>([])
const cardBusy = ref(false)
const cardDone = ref<{ created: number; skipped: number; project: string } | null>(null)
/** 校验里的证据输入（按 qid 存，避免一个错字串到别题） */
const auditDraft = ref<Record<string, string>>({})
const view = ref<'one' | 'all'>('one')
const curId = ref('')
const summary = ref(false)
const editing = ref<null | { id: string; kind: 'askback' | 'amend' }>(null)
const editText = ref('')
/**
 * 正在编辑的**原文**（非响应式）。
 *
 * 2026-11-26：暮雨两次报「方寸填问卷打字很卡，原因不明」。
 * 原来 textarea 用 `v-model="editText"` —— 每敲一个字都改一次 ref，
 * 于是**整个 1500 行弹窗**（题号导航 + 当前题 + 各种 computed）每字重渲染一次。
 * 现在输入先落到这个普通变量（不触发渲染），只做防抖落盘；
 * `editText` 只在打开编辑框时用来给 textarea 初值。
 */
let editDraftText = ''
/**
 * 输入保护（2026-11-10 用户报障）：
 * 「顺便问卷功能没做输入保护，刚才我打的字全没了」—— 她说得对。
 * 此前 `editText` 只活在内存里，**只有点「确定」才写进 answers**；
 * 写长段自述（L1 那条）时窗口一关/一切题，全丢。
 * 现在：输入就防抖落盘（写进 answers 当草稿），取消则回滚到打开前的状态。
 */
const editBefore = ref<QAns | null>(null)
let editTimer: ReturnType<typeof setTimeout> | null = null

/** 把正在编辑的文本立刻落成草稿（空文本 = 撤掉草稿，别留一个空答案占位） */
function flushEditDraft(): void {
  const e = editing.value
  if (!e) return
  const v = editDraftText
  if (v.trim()) answers.value[e.id] = { kind: e.kind as any, text: v }
  else if (answers.value[e.id] && answers.value[e.id].kind === e.kind) delete answers.value[e.id]
  void save()
}

/**
 * 输入防抖落盘（350ms）—— 打字不丢，也不至于每个字符一次 IPC。
 * ⚠ 只把原文写进**普通变量**：不碰 ref，输入过程中不触发整页重渲染。
 */
function onEditInput(ev: Event): void {
  const el = ev.target as HTMLTextAreaElement | null
  editDraftText = el ? el.value : ''
  if (editTimer) clearTimeout(editTimer)
  editTimer = setTimeout(() => { editTimer = null; flushEditDraft() }, 350)
}

/** 取消：回滚到打开编辑框之前的那一格（临时草稿不留下） */
function cancelEdit(): void {
  const e = editing.value
  if (editTimer) { clearTimeout(editTimer); editTimer = null }
  if (e) {
    if (editBefore.value) answers.value[e.id] = editBefore.value
    else delete answers.value[e.id]
  }
  editBefore.value = null
  editing.value = null
  editDraftText = ''
  void save()
}
const lookOpen = ref<Record<string, boolean>>({})
const metaOpen = ref<Record<string, boolean>>({})
const busy = ref(false)
/**
 * main 区的“额外页”：预埋表 / 入口总表 / 提示词。
 * 空串 = 正常答题。它必须排在最前面判断 —— 否则会掉进题流里（本项目有过先例）。
 */
const extra = ref<'' | 'parked' | 'look' | 'prompt' | 'audit'>('')
const promptKind = ref<'rewrite' | 'build'>('rewrite')
const promptText = ref('')
const promptBusy = ref(false)

const toast = (m: string, k = 'info') => emit('toast', m, k)
const total = computed(() => deck.value ? deck.value.parsed.questions.length : 0)
const idx = computed(() => deck.value ? deck.value.parsed.questions.findIndex((q) => q.id === curId.value) : 0)
const currentQ = computed<QItem | null>(() => deck.value ? (deck.value.parsed.questions[idx.value] || null) : null)
const answeredCount = computed(() => (deck.value ? deck.value.parsed.questions.filter((q) => isAnswered(q.id)).length : 0))
/** 预埋项（现在答不了的题）—— 不放题流里，它们不是“待答” */
const parked = computed<QParked[]>(() => (deck.value ? deck.value.parsed.parked || [] : []))
/** 表头原样用；解析不出来才退回一套中性的 */
const parkedHead = computed<string[]>(() => {
  const h = (deck.value ? deck.value.parsed.parkedHead : []) || []
  return h.length >= 2 ? h : ['题', '缺什么', '什么时候能答']
})
/** 「看一眼·入口总表」—— 全卷共用的一张参照表（裁决层 A 的链接全在这一张里） */
const lookRows = computed(() => (deck.value ? deck.value.parsed.lookTable || [] : []))
/** 有几句反问 —— 决定汇总页给哪个出口（重出题 / 出施工单） */
const askCount = computed(() => {
  if (!deck.value) return 0
  return deck.value.parsed.questions.filter((q) => {
    const a = answers.value[q.id]
    return !!(a && a.kind === 'askback' && String(a.text || '').trim())
  }).length
})

function isAnswered(id: string): boolean {
  const a = answers.value[id]
  if (!a) return false
  if (a.kind === 'amend' || a.kind === 'askback') return !!(a.text || '').trim()
  return true
}
function stateGlyph(id: string): string {
  const a = answers.value[id]
  if (!a) return '·'
  if (a.kind === 'skip') return '○'
  if (a.kind === 'reject') return '✕'
  if (a.kind === 'askback') return '❗'
  if (a.kind === 'void') return '⌫'
  if (a.kind === 'self') return '自'
  return '✓'
}
function stateClass(id: string): string {
  const a = answers.value[id]
  if (!a) return ''
  if (a.kind === 'skip') return 'skip'
  if (a.kind === 'reject') return 'rej'
  if (a.kind === 'askback') return 'ask'
  if (a.kind === 'void') return 'void'
  if (a.kind === 'self') return 'self'
  return 'ans'
}
function stateText(id: string): string {
  const a = answers.value[id]
  if (!a) return ''
  if (a.kind === 'skip') return '已跳过 —— 下次进项目还会问'
  if (a.kind === 'reject') return '已否决 —— 这题不该问，不再出现'
  if (a.kind === 'askback') return '❗ 已反问：' + (a.text || '')
  if (a.kind === 'void') return '⌫ 已作废：' + (a.text || '') + '（当时答过，现在不作数）'
  if (a.kind === 'self') return '你自判 —— 这题以后不再问方寸'
  if (a.kind === 'amend') return '已记录你的说法：' + (a.text || '')
  return '已选：' + a.k
}

async function loadList(): Promise<void> {
  try {
    const r: any = await api().questionnaireList()
    decks.value = (r && r.decks) || []
    dir.value = (r && r.dir) || ''
    bank.value = (r && r.bank) || null
  } catch (e: any) {
    toast('读问卷列表失败：' + (e?.message || e), 'error')
  }
  // 跨卷「该看一眼了」—— 决策库的真价值在事后校验，不在这里就没人会回头
  try {
    const q: any = await api().questionnaireAuditQueue()
    const rows: any[] = (q && q.rows) || []
    auditDue.value = rows
      .filter((x) => x.refuted || x.due)
      .slice(0, 30)
      .map((x) => ({ deck: x.deck, id: x.id, ask: x.ask || x.id, days: x.days, refuted: !!x.refuted }))
  } catch { /* 校验清单拉不到不该挡住问卷列表 */ }
  await loadArchivable()
}

/** 归档候选（2026-11-11）：已批准 ≥30 天且无卡引用 —— 判定在主进程，界面不重算 */
async function loadArchivable(): Promise<void> {
  try {
    const r: any = await api().questionnaireArchivable(30)
    archivable.value = Array.isArray(r?.decks) ? r.decks : []
    archivableBlocked.value = Array.isArray(r?.blocked) ? r.blocked : []
  } catch { /* 归档候选拉不到不该挡住列表 */ }
}

/** 收起一卷：先问数据层（它才判得了“有没有卡引用”）—— 拒了就照实说原因 */
async function archiveOne(deckName: string): Promise<void> {
  if (archiveBusy.value) return
  archiveBusy.value = true
  archiveMsg.value = ''
  try {
    const r: any = await api().questionnaireArchive(deckName)
    if (r && r.ok) {
      toast(`《${deckName}》已移入历史卷（答案仍参与裁决，不是作废）`, 'success')
      archivedAt.value = new Date().toISOString()
      await loadList()
    } else {
      toast('没归档：' + (r?.error || '未知原因'), 'error')
    }
  } catch (e: any) {
    toast('归档失败：' + (e?.message || e), 'error')
  } finally {
    archiveBusy.value = false
  }
}

async function unarchiveOne(deckName: string): Promise<void> {
  if (archiveBusy.value) return
  archiveBusy.value = true
  try {
    const r: any = await api().questionnaireUnarchive(deckName)
    if (r && r.ok) {
      toast(`《${deckName}》已放回列表`, 'success')
      archivedAt.value = ''
      await loadList()
    } else {
      toast('没放回去：' + (r?.error || '未知原因'), 'error')
    }
  } catch (e: any) {
    toast('取消归档失败：' + (e?.message || e), 'error')
  } finally {
    archiveBusy.value = false
  }
}

/** 批量收起候选：逐卷走同一条通道，**成功几卷说几卷**，失败的原样点名（不打包成“已完成”） */
async function archiveAllCandidates(): Promise<void> {
  if (archiveBusy.value || !archivable.value.length) return
  archiveBusy.value = true
  let ok = 0
  const bad: string[] = []
  for (const d of [...archivable.value]) {
    try {
      const r: any = await api().questionnaireArchive(d.deck)
      if (r && r.ok) ok++
      else bad.push(d.deck + '（' + (r?.error || '未知原因') + '）')
    } catch (e: any) {
      bad.push(d.deck + '（' + (e?.message || e) + '）')
    }
  }
  archiveBusy.value = false
  archivable.value = []
  archiveMsg.value = `已收起 ${ok} 卷` + (bad.length ? `；${bad.length} 卷没动：${bad.join('；')}` : '')
  archivedNow.value = true
  await loadList()
}

async function openDeck(name: string): Promise<void> {
  try {
    const r: any = await api().questionnaireGet(name)
    if (!r || r.ok === false) { toast(String(r?.error || '打不开这一卷'), 'error'); return }
    deck.value = { deck: r.deck, parsed: r.parsed }
    bank.value = (r && r.bank) || null
    answers.value = r.answers || {}
    approved.value = r.approvedAt || ''
    voidedAt.value = r.voidedAt || ''
    voidReason.value = r.voidReason || ''
    archivedAt.value = r.archivedAt || ''
    deliveries.value = (r && r.deliveries) || {}
    audits.value = r.audits || {}
    costGaps.value = r.costGaps || []
    issues.value = Array.isArray(r.issues) ? r.issues : []
    // 项目候选先摆出来（默认空 = 按卷名自动认），不让用户点一次失败才知道要选
    cardOptions.value = Array.isArray(r.projects) ? r.projects.map((p: any) => ({ id: String(p.id || ''), name: String(p.name || p.id || '') })) : []
    cardProject.value = ''
    cardDone.value = null
    summary.value = false
    // 打开落在“第一道还没答的题”上，省得从 S1 一路翻
    const first = (r.parsed.questions as QItem[]).find((q) => !isAnswered(q.id))
    curId.value = (first || r.parsed.questions[0]).id
    // 结论集收敛进度（P8 · D-064）：开卷就带上，让人一眼看到“问够没问够”
    try {
      const c: any = await api().questionnaireConvergence(name)
      conv.value = c && c.summary ? { summary: String(c.summary), need: Number(c.need) || 3 } : null
    } catch { conv.value = null }
    if (r.parsed.error) toast(String(r.parsed.error), 'error')
  } catch (e: any) {
    toast('打不开这一卷：' + (e?.message || e), 'error')
  }
}

function backToList(): void {
  deck.value = null
  summary.value = false
  archivedAt.value = ''
  deliveries.value = {}
  void loadList()
}

/** 每动一下就存草稿 —— 关窗/切页都不丢 */
async function save(): Promise<void> {
  if (!deck.value) return
  try {
    // 2026-11-09 真事：`answers.value` 是 Vue 响应式代理，直接过 contextBridge 会抛
    // "An object could not be cloned."；这里原来 catch 后一个字都不说，于是
    // “五道题全答完了”在磁盘上是空卷，批准还写成了「已落库」。
    // 草稿存失败不许静默：宁可当场红，也不要让人以为答完了。
    const r: any = await api().questionnaireSaveAnswers(deck.value.deck, toPlain(answers.value))
    if (r && r.ok === false) throw new Error(r.error || '主进程拒绝了这次保存')
  } catch (e: any) {
    toast('草稿没存上：' + (e?.message || e), 'error')
  }
}

function pick(id: string, k: string): void {
  answers.value[id] = { kind: 'pick', k }
  editing.value = null
  void save()
}
function mark(id: string, kind: 'skip' | 'reject' | 'self'): void {
  answers.value[id] = { kind }
  editing.value = null
  void save()
}
function reset(id: string): void {
  delete answers.value[id]
  editing.value = null
  void save()
}
function startEdit(id: string, kind: 'askback' | 'amend'): void {
  editing.value = { id, kind }
  const cur = answers.value[id]
  // 打开就把上次写的内容接上 —— 否则“关掉再开”等于逼人重打一遍
  editText.value = cur && cur.kind === kind ? String(cur.text || '') : ''
  editDraftText = editText.value
  editBefore.value = cur ? { ...cur } : null
}
function commitEdit(): void {
  const e = editing.value
  if (!e) return
  if (editTimer) { clearTimeout(editTimer); editTimer = null }
  const v = editDraftText.trim()
  if (e.kind === 'askback' && !v) { answers.value[e.id] = { kind: 'reject' }; editing.value = null; editBefore.value = null; void save(); return }
  // 作废必须写原因：三个月后唯一能救命的线索就是这句（与后端同一条判据，不靠后端兜）
  if (e.kind === 'void' && !v) { toast('作废要写原因 —— 为什么它不作数了'); return }
  if (!v) { toast('说一句再确定'); return }
  answers.value[e.id] = { kind: e.kind, text: v }
  editing.value = null
  editBefore.value = null
  editDraftText = ''
  void save()
}
function goto(id: string): void {
  if (editing.value) flushEditDraft()   // 切题前先把正在写的落盘，别让草稿跟着一起走
  curId.value = id
  view.value = 'one'
  editing.value = null
  editBefore.value = null
  editDraftText = ''
}
function prev(): void {
  const qs = deck.value?.parsed.questions || []
  if (idx.value > 0) curId.value = qs[idx.value - 1].id
}
function next(): void {
  const qs = deck.value?.parsed.questions || []
  if (!isAnswered(curId.value)) { toast('这题还没答 —— 选一个，或者点「跳过」'); return }
  if (idx.value >= qs.length - 1) { summary.value = true; return }
  curId.value = qs[idx.value + 1].id
}
function toggleLook(id: string): void { lookOpen.value[id] = !lookOpen.value[id] }
function toggleMeta(k: string): void { metaOpen.value[k] = !metaOpen.value[k] }

/**
 * 批准时间显示：磁盘里是 UTC ISO，必须按本地时区印。
 * 2026-11-09 的现场：他 22:07 答完，界面写「已落库 · 14:07」——
 * 直接 `approved.slice(0,16)` 就是 UTC，等于把时间说错了 8 小时。
 */
function localStamp(v: string): string { return formatLocalStamp(v) }

/** 生成 md（与数据层导出同一形状：逐题 + 反问段） */
function mdText(): string {
  const d = deck.value
  if (!d) return ''
  const lines: string[] = [`# ${d.parsed.title || d.deck} 答卷（${localDay()}）`, '']
  const asks: { id: string; text: string }[] = []
  d.parsed.questions.forEach((q) => {
    const a = answers.value[q.id]
    if (!a) { lines.push(`- **${q.id}** —— 未答`); return }
    if (a.kind === 'skip') { lines.push(`- **${q.id}** —— 跳过（下次再问）`); return }
    if (a.kind === 'reject') { lines.push(`- **${q.id}** —— 否决：这题不该问`); return }
    if (a.kind === 'askback') { lines.push(`- **${q.id}** —— 反问（见下）`); asks.push({ id: q.id, text: a.text || '' }); return }
    if (a.kind === 'void') { lines.push(`- **${q.id}** —— ~~作废~~：${a.text || '未写原因'}（当时答过，现已失效）`); return }
    if (a.kind === 'self') { lines.push(`- **${q.id}** —— 你自判：${a.text || '（以后不再问这题）'}`); return }
    if (a.kind === 'amend') { lines.push(`- **${q.id}** —— ${a.text}（自述）`); return }
    const o = q.options.find((x) => x.k === a.k)
    lines.push(`- **${q.id}** —— ${a.k}. ${o ? o.t : ''}`)
    if (q.line) lines.push(`  - 验收线：${q.line.replace(/\s*\n\s*/g, ' ')}`)
    const au = audits.value[q.id]
    if (au && au.verdict === 'refuted') lines.push(`  - ⚠ 事后校验：**已被推翻**（${au.at.slice(0, 10)}）${au.evidence ? '：' + au.evidence : ''}`)
    else if (au && au.verdict === 'ok') lines.push(`  - 事后校验：仍成立（${au.at.slice(0, 10)}）${au.evidence ? '：' + au.evidence : ''}`)
  })
  if (asks.length) {
    lines.push('', '## 反问（回给 agent 重写题目）', '')
    asks.forEach((x) => lines.push(`- **${x.id}**：${x.text}`))
  }
  return lines.join('\n') + '\n'
}

/**
 * 复制（带三层兜底，2026-11-08 改）。
 *
 * 原来这里直接用 `navigator.clipboard` —— 打包版是 `file://` 起源，它会静默 reject，
 * 剪贴板里仍留着上一次的内容（用户以为复制了，粘出来是旧东西）。现在统一走
 * `shared/clipboard.ts`：IPC → navigator → execCommand，失败必须报出来。
 */
async function copyText(t: string, okMsg: string): Promise<void> {
  const r = await copyToClipboard(t)
  if (r.ok) toast(okMsg, 'success')
  else toast('复制失败：' + (r.error || '三条通道都没过，请手动选中复制'), 'error')
}

/** 「让 agent 出问卷」：把出卷提示词复制出去（agent 侧走 qn_propose 落盘） */
async function copyAuthorPrompt(): Promise<void> {
  await copyText(buildDeckAuthoringPrompt(), '已复制出卷提示词 —— 粘给 agent，它出完这卷会出现在这里')
}

async function copyMd(): Promise<void> {
  await copyText(mdText(), '已复制答卷，可直接贴进 decision-log')
}

function toggleExtra(k: 'parked' | 'look' | 'audit'): void {
  extra.value = extra.value === k ? '' : k
}

/**
 * 生成出口提示词。两个方向：
 *   rewrite —— 拿反问去让 agent 重出题（只重写那几题）；
 *   build   —— 拿答卷去出施工单（有反问时后端会拒，这里如实把话转给用户）。
 */
async function openPrompt(kind: 'rewrite' | 'build'): Promise<void> {
  if (!deck.value || promptBusy.value) return
  promptBusy.value = true
  try {
    const r: any = await api().questionnairePrompt(deck.value.deck, kind)
    if (!r || r.ok === false) { toast(String(r?.error || '生成失败'), 'error'); return }
    promptKind.value = kind
    promptText.value = String(r.text || '')
    extra.value = 'prompt'
  } catch (e: any) {
    toast('生成失败：' + (e?.message || e), 'error')
  } finally {
    promptBusy.value = false
  }
}

async function copyPrompt(): Promise<void> {
  if (!promptText.value) return
  await copyText(promptText.value, '已复制提示词 —— 粘给 agent 就行')
}
function downloadMd(): void {
  const blob = new Blob([mdText()], { type: 'text/markdown;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = '问卷-' + (deck.value?.deck || 'answer') + '.md'
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

/**
 * 答卷 → 真任务卡（2026-11-07）。
 *
 * 这一步之前缺失，是"问卷是半成品"的实处：答案只落 decision-log 与一段提示词，
 * 而**没有卡就没人施工** —— 链断在最后一步。
 * 项目认不出来时后端会回 needProject + 候选清单，这里渲染成下拉再点一次（不瞎猜归属）。
 */
async function makeCards(): Promise<void> {
  if (!deck.value || cardBusy.value) return
  cardBusy.value = true
  try {
    const r: any = await api().questionnaireMakeCards(deck.value.deck, cardProject.value ? { project: cardProject.value } : undefined)
    if (r && r.needProject) {
      cardOptions.value = (r.projects || []).map((p: any) => ({ id: String(p.id || ''), name: String(p.name || p.id || '') }))
      toast(String(r.error || '选一个项目再落卡'), 'error')
      return
    }
    if (!r || r.ok === false) { toast(String(r?.error || '落卡失败'), 'error'); return }
    cardDone.value = { created: Number(r.created || 0), skipped: Number(r.skipped || 0), project: String(r.project || '') }
    const om = Array.isArray(r.omitted) ? r.omitted.length : 0
    toast(
      `已落 ${r.created} 张卡${r.skipped ? `，${r.skipped} 张已存在（跳过）` : ''}${om ? `，${om} 题没落（跳过/否决/反问/作废）` : ''}`,
      'success',
    )
  } catch (e: any) {
    toast('落卡失败：' + (e?.message || e), 'error')
  } finally {
    cardBusy.value = false
  }
}

/** 单题作废：答案曾经成立，现在失效 */
function startVoid(id: string): void {
  const cur = answers.value[id]
  editing.value = { id, kind: 'void' as any }
  // 作废原因也是长文本 —— 同样要接上上次写的、同样要防抖落盘
  editText.value = cur && cur.kind === 'void' ? String(cur.text || '') : ''
  editDraftText = editText.value
  editBefore.value = cur ? { ...cur } : null
}

/** 整卷作废（要求写原因 —— 三个月后唯一能救命的线索就是那句原因） */
async function doVoidDeck(): Promise<void> {
  if (!deck.value || voidBusy.value) return
  const why = voidDraft.value.trim()
  if (!why) { toast('作废要写原因 —— 不然三个月后没人知道为什么推翻'); return }
  voidBusy.value = true
  try {
    const r: any = await api().questionnaireVoidDeck(deck.value.deck, why)
    if (!r || r.ok === false) { toast(String(r?.error || '作废失败'), 'error'); return }
    voidedAt.value = String(r.voidedAt || new Date().toISOString())
    voidReason.value = why
    voidDraft.value = ''
    toast(`这卷已作废${r.revoked ? `，连带撤下 ${r.revoked} 张决策卡` : ''}`, 'success')
  } catch (e: any) {
    toast('作废失败：' + (e?.message || e), 'error')
  } finally {
    voidBusy.value = false
  }
}

async function doReopen(): Promise<void> {
  if (!deck.value) return
  try {
    const r: any = await api().questionnaireReopenDeck(deck.value.deck)
    if (!r || r.ok === false) { toast(String(r?.error || '恢复失败'), 'error'); return }
    voidedAt.value = ''
    voidReason.value = ''
    toast('已恢复这卷 —— 决策卡要重新批准才会复活（不会自己悄悄复活）', 'success')
  } catch (e: any) {
    toast('恢复失败：' + (e?.message || e), 'error')
  }
}

/** 事后校验：成立 / 被推翻 */
async function doAudit(id: string, verdict: 'ok' | 'refuted'): Promise<void> {
  if (!deck.value) return
  const ev = String(auditDraft.value[id] || '').trim()
  if (verdict === 'refuted' && !ev) { toast('判「被推翻」要说清凭什么 —— 一句证据就行'); return }
  try {
    const r: any = await api().questionnaireAudit(deck.value.deck, id, verdict, ev)
    if (!r || r.ok === false) { toast(String(r?.error || '校验没存上'), 'error'); return }
    audits.value = {
      ...audits.value,
      [id]: { verdict, evidence: ev, at: new Date().toISOString() },
    }
    auditDraft.value[id] = ''
    toast(verdict === 'ok' ? `${id} 记为仍成立` : `${id} 记为被推翻${r.revoked ? '，决策卡已撤销' : ''}`, verdict === 'ok' ? 'success' : 'error')
  } catch (e: any) {
    toast('校验失败：' + (e?.message || e), 'error')
  }
}

/** 这卷里"有答案 + 有验收线"的题 —— 只有这些能校验（没验收线就没有判据） */
const auditable = computed(() => {
  const d = deck.value
  if (!d) return [] as QItem[]
  return d.parsed.questions.filter((q) => {
    const a = answers.value[q.id]
    if (!a) return false
    if (a.kind === 'skip' || a.kind === 'reject' || a.kind === 'askback' || a.kind === 'void' || a.kind === 'self') return false
    return !!String(q.line || '').trim()
  })
})
const auditDone = computed(() => auditable.value.filter((q) => !!audits.value[q.id]).length)

async function approve(): Promise<void> {
  if (!deck.value || busy.value) return
  busy.value = true
  try {
    const r: any = await api().questionnaireApprove(deck.value.deck)
    if (!r || r.ok === false) { toast(String(r?.error || '批准失败'), 'error'); return }
    approved.value = new Date().toISOString()
    const n = Number(r.cards || 0)
    const ex = Number(r.existed || 0)
    toast(n ? `已批准：新建 ${n} 张决策卡${ex ? `，${ex} 张已存在` : ''}` : `已批准：${ex} 张决策卡都已存在`, 'success')
    // 批准后主进程已经重算过结论集 —— 把它那句话原样贴上来（不在这里另算一份）
    if (r.convergence && r.convergence.summary) {
      conv.value = { summary: String(r.convergence.summary), need: 3 }
    }
  } catch (e: any) {
    toast('批准失败：' + (e?.message || e), 'error')
  } finally {
    busy.value = false
  }
}

async function openDir(): Promise<void> {
  const r: any = await api().questionnaireOpenDir()
  if (r && r.ok === false) toast(String(r.error || '打不开目录'), 'error')
}

watch(summary, (v) => { if (v && !approved.value) toast('以上都是草稿 —— 点「批准并落库」才写到决策卡') })

onMounted(async () => {
  await loadList()
  // 从通知点进来：列表加载完再开那一卷（否则 openDeck 读不到数据）
  const want = String(props.initialDeck || '').trim()
  if (want) { try { await openDeck(want) } catch { /* 卷没了就停在列表，不闹 */ } }
})
// 关窗/被父组件卸载时补一次落盘：防抖计时器 350ms 还没到就关掉的情况，字不能丢。
onBeforeUnmount(() => {
  if (editTimer) { clearTimeout(editTimer); editTimer = null }
  if (editing.value) flushEditDraft()
})
</script>

<style scoped>
.qn { position: fixed; inset: 0; background: rgba(60, 65, 80, .42); display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 60; }
.qn-dlg { width: min(920px, 100%); max-height: min(90vh, 800px); background: var(--card); border: 1px solid var(--border); border-radius: 16px; display: flex; flex-direction: column; overflow: hidden; }
.qn-hd { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.qn-ttl { font-size: 14.5px; font-weight: 700; }
.qn-sub { font-size: 11.5px; color: var(--muted); }
.qn-grow { flex: 1; }
.qn-back { font-size: 11.5px; }
.qn-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.qn-seg button { border: 0; background: #fff; color: var(--muted); font-size: 11.5px; padding: 4px 10px; }
.qn-seg button.on { background: var(--accent); color: #fff; font-weight: 600; }
.qn-bar { height: 3px; background: var(--tint-2); }
.qn-bar i { display: block; height: 100%; background: var(--accent); transition: width .25s; }
.qn-body { padding: 16px; overflow: auto; flex: 1; }
.qn-empty { font-size: 12px; color: var(--muted); line-height: 2; }
/* 搜索行（2026-11-11 问卷管理）：卷多到只能搜时，输入框要一直在、不要藏进弹层 */
.qn-search-row { display: flex; align-items: center; gap: 8px; padding: 0 16px 10px; }
.qn-search { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font: inherit; font-size: 12px; }
.qn-search-tip { font-size: 10.5px; color: var(--muted); }
.qn-empty code { background: var(--tint-3); padding: 1px 5px; border-radius: 4px; }
.qn-decks { display: flex; flex-direction: column; gap: 8px; }
/* 多选态的卷行（0.7.0 P11）：勾选靠左侧方块 + 行体加一道强调环，不改按钮本身的几何 */
.qn-deck.picked { border-color: var(--accent); background: var(--tint); }
.qd-check { flex: none; font-size: 14px; color: var(--accent); }
/* 题库 ↔ 卷 关系表（P11）：一行一题，右三栏回答“哪卷问过 / 哪张卡引用 / 缺什么” */
.qn-bank { margin: 8px 0 4px; border: 1px solid var(--border); border-radius: 10px; overflow: auto; max-height: 46vh; }
.qb-tb { width: 100%; border-collapse: collapse; font-size: 12px; }
.qb-tb th { text-align: left; font-weight: 600; color: var(--muted); font-size: 11px;
  padding: 7px 9px; background: var(--tint-2); position: sticky; top: 0; }
.qb-tb td { padding: 7px 9px; border-top: 1px solid var(--border); vertical-align: top; line-height: 1.6; }
.qb-q { min-width: 220px; max-width: 420px; }
.qb-src { display: inline-block; margin: 0 6px 2px 0; padding: 0 6px; border-radius: 6px;
  background: var(--tint-2); color: var(--ink); font-size: 11px; white-space: nowrap; }
.qb-none { color: var(--muted); font-size: 11.5px; }
.qb-note { color: var(--muted); font-size: 11.5px; min-width: 160px; }
.qn-deck { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; border: 1px solid var(--border); background: #fff; border-radius: 10px; padding: 10px 13px; }
.qn-deck:hover { border-color: var(--accent-soft); background: #fcfbff; }
.qd-main { flex: 1; min-width: 0; font-size: 13px; display: flex; align-items: center; gap: 7px; }
.qd-badge { font-size: 10.5px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0 7px; }
.qd-badge.ok { color: var(--success); border-color: #cfe6d5; }
.qd-badge.bad { color: var(--danger); border-color: var(--danger); }
.qd-meta { font-size: 11.5px; color: var(--muted); flex: none; }

.qn-cols { display: flex; flex: 1; min-height: 0; }
.qn-rail { width: 172px; flex: none; border-right: 1px solid var(--border); background: var(--tint-2); padding: 8px; overflow: auto; }
.qn-rail-i { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; border: 1px solid transparent; background: transparent; border-radius: 8px; padding: 6px 8px; font-size: 11.5px; color: var(--muted); }
.qn-rail-i:hover { background: #fff; }
.qn-rail-i.on { background: #fff; border-color: var(--accent-soft); color: var(--ink); font-weight: 600; }
.ri-k { font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; color: var(--accent); flex: none; width: 22px; }
.ri-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ri-s { flex: none; font-size: 10px; }
.ri-s.ans { color: var(--success); }
.ri-s.rej { color: var(--danger); }
.ri-s.ask { color: var(--warning); }
.ri-s.self { color: var(--muted); }
.qn-rail-x {
  display: flex; align-items: center; gap: 5px; width: 100%; margin-top: 6px;
  border: 1px dashed var(--border); background: transparent; border-radius: 8px;
  padding: 6px 8px; font-size: 11px; color: var(--muted); text-align: left;
}
.qn-rail-x:hover { background: #fff; color: var(--ink); }
.qn-rail-x.on { background: #fff; border-style: solid; border-color: var(--accent-soft); color: var(--ink); font-weight: 600; }
.qn-rail-x .rx-n { margin-left: auto; font-size: 9.5px; font-weight: 400; color: var(--muted); }
.qn-rail-foot { margin-top: 8px; padding: 8px; font-size: 10.5px; color: var(--muted); line-height: 1.8; border-top: 1px dashed var(--border); }

.qn-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.qn-main > div { flex: 1; min-height: 0; overflow: auto; }
.qn-one, .qn-all { padding: 16px 20px; }
.qn-all { display: flex; flex-direction: column; gap: 12px; }
.q-id { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--accent); font-weight: 700; }
.q-ask { font-size: 16.5px; font-weight: 700; line-height: 1.45; margin: 3px 0 11px; }
.qn-card { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
.qn-card.ans { border-color: var(--accent-soft); background: #fcfbff; }
.qn-card.askc { border-color: var(--warning); background: #fdf9f2; }
.qc-hd { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.qc-id { font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; color: var(--accent); font-weight: 700; }
.qc-ask { font-size: 13.5px; font-weight: 700; line-height: 1.5; }
.qn-note { font-size: 11.5px; color: var(--warning); background: #fdf6ec; border: 1px solid #f0e0c8; border-radius: 8px; padding: 6px 9px; margin: 8px 0; line-height: 1.65; }

.qn-look { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin: 8px 0; }
.look-hd { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; border: 0; background: var(--tint-2); padding: 7px 10px; font-size: 11.5px; color: var(--ink); }
.look-hd:hover { background: var(--tint); }
.look-hd .arw { font-size: 9px; color: var(--muted); transition: transform .15s; }
.look-hd .arw.open { transform: rotate(90deg); }
.look-bd { padding: 7px 10px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--muted); line-height: 1.8; white-space: pre-wrap; }

/* 我的意见（2026-11-15）：把"我怎么想"摆在选项**上方** ——
   先看判断再看选项，而不是让人先被四个选项淹没再想起问"那你怎么想"。
   三态各有各的长相：有推荐 = 品牌色左边条；有想法没定档 = 中性；没把握 = 虚线弱化。
   ⚠ 第三态**必须**出现（不是不渲染）—— 静默留白会被读成"随便都行"，那是替人下结论。 */
.qn-opinion { display: flex; flex-direction: column; gap: 3px; margin-top: 8px;
  padding: 7px 11px; border-radius: 10px; border: 1px solid var(--accent-soft);
  border-left: 3px solid var(--accent); background: var(--tint-2); }
.qn-opinion.weak { border-left-color: var(--muted); border-color: var(--border); }
.qn-opinion.none { border-style: dashed; border-left-style: dashed; background: transparent; }
.qn-opinion .qo-hd { font-size: 12px; font-weight: 700; color: var(--accent); }
.qn-opinion.weak .qo-hd, .qn-opinion.none .qo-hd { color: var(--muted); }
.qn-opinion .qo-bd { font-size: 12px; color: var(--ink); line-height: 1.65; white-space: pre-wrap; }
.qn-opt .qo-rec { flex: none; align-self: center; font-size: 10.5px; padding: 1px 7px;
  border-radius: 999px; background: var(--tint); color: var(--accent); font-weight: 600; }
.qn-opt.rec { border-color: var(--accent-soft); }
.qn-opts { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.qn-opt { display: flex; gap: 9px; align-items: flex-start; width: 100%; text-align: left; border: 1px solid var(--border); background: #fff; border-radius: 10px; padding: 9px 11px; }
.qn-opt:hover { border-color: var(--accent-soft); background: #fcfbff; }
.qn-opt.on { border-color: var(--accent); background: var(--tint); }
.qn-opt .kk { flex: none; width: 20px; height: 20px; line-height: 18px; text-align: center; border: 1px solid var(--border); border-radius: 6px; font-size: 10.5px; font-weight: 700; color: var(--muted); font-family: ui-monospace, Consolas, monospace; }
.qn-opt.on .kk { background: var(--accent); border-color: var(--accent); color: #fff; }
.qn-opt .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.qn-opt .txt b { font-size: 13px; font-weight: 600; }
.qn-opt .txt small { font-size: 11.5px; color: var(--muted); line-height: 1.6; }

.qn-state { margin-top: 9px; font-size: 11.5px; color: var(--muted); background: var(--tint-2); border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; line-height: 1.7; }
.qn-state .undo { border: 0; background: transparent; color: var(--accent); font-size: 11px; text-decoration: underline; text-underline-offset: 2px; margin-left: 8px; padding: 0; }
/* 交付状态（2026-11-11 回程）：绿=已交付，红=被驳回；只展示，不改答案 */
.qn-deliver { margin-left: 6px; color: var(--success); }
.qn-deliver.bad { color: var(--danger); }
.qn-deliver code { font-size: 10.5px; }
.qn-acts { display: flex; gap: 6px; margin-top: 9px; flex-wrap: wrap; }
.qn-acts button { font-size: 11.5px; padding: 3px 10px; }
.qn-acts .ask { color: var(--warning); border-color: #f0e0c8; }

.qn-edit { margin-top: 9px; border: 1px solid var(--accent-soft); background: var(--tint); border-radius: 10px; padding: 9px 10px; }
.qn-edit.ask { border-color: #f0e0c8; background: #fdf6ec; }
.qe-hint { font-size: 11.5px; color: var(--muted); margin-bottom: 6px; line-height: 1.7; }
.qn-edit.ask .qe-hint { color: var(--warning); }
.qn-edit textarea { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px; font: inherit; font-size: 12.5px; color: var(--ink); background: #fff; outline: none; resize: vertical; }
.qe-row { display: flex; gap: 7px; justify-content: flex-end; margin-top: 7px; }
.qe-row button { font-size: 11.5px; }

/* 额外页（预埋表 / 入口总表 / 提示词）—— 它们不是题，所以不带选项和动作 */
.qn-extra { padding: 16px 20px; }
.xe-hd { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.xe-hd b { font-size: 14px; }
.xe-sub { font-size: 11.5px; color: var(--muted); line-height: 1.7; }
.xe-tb { width: 100%; border-collapse: collapse; font-size: 12px; }
.xe-tb th {
  text-align: left; font-weight: 600; font-size: 11px; color: var(--muted);
  border-bottom: 1px solid var(--border); padding: 5px 8px; background: var(--tint-2);
}
.xe-tb td { border-bottom: 1px solid var(--tint-2); padding: 6px 8px; vertical-align: top; line-height: 1.7; }
.xe-tb .xe-q { font-weight: 600; color: var(--ink); }
.xe-tb .xe-url { color: var(--accent); word-break: break-all; font-size: 11.5px; }
.xe-pre {
  margin: 0; padding: 11px 13px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--tint-2); font-size: 11.5px; line-height: 1.8; white-space: pre-wrap;
  word-break: break-word; font-family: ui-monospace, Consolas, monospace; color: var(--ink);
}
.qn-ft-note { font-size: 11px; color: var(--muted); }

.qn-meta { margin-top: 10px; border-top: 1px dashed var(--border); padding-top: 7px; display: flex; flex-direction: column; gap: 2px; }
.meta-t { border: 0; background: transparent; text-align: left; color: var(--muted); font-size: 11px; padding: 2px 0; line-height: 1.7; }
.meta-t:hover { color: var(--accent); }

.qn-ft { border-top: 1px solid var(--border); padding: 10px 16px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.qn-ft button { font-size: 12px; }
.qn-ft .ask { color: var(--warning); border-color: #f0e0c8; }
.qn-ok { font-size: 11.5px; color: var(--success); }
.qn-hint { padding: 6px 16px 10px; font-size: 10.5px; color: var(--muted); }
@media (max-width: 860px) { .qn-rail { display: none; } }
/* ── 作废 / 事后校验 / 缺代价（2026-11-07）─────────────────────────
   三块都是一个目的：让"这卷答过什么、现在还作不作数"在界面上说得清。
   颜色只用主题里真有的变量（--warning / --danger / --success），不新造。 */
.qn-warn, .qn-void, .qn-voidbox {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 8px 16px 0; padding: 8px 11px; border-radius: 9px; font-size: 11.5px;
}
.qn-warn { border: 1px solid #f0e0c8; background: var(--tint-2); color: var(--ink); }
.qn-warn b { color: var(--warning); }
.qn-void { border: 1px solid #f0d6d6; background: var(--tint-2); color: var(--ink); }
.qn-void b { color: var(--danger); }
.qw-names { font-family: ui-monospace, Consolas, monospace; color: var(--muted); }
.qw-hint { color: var(--muted); }
.qn-voidbox { margin: 8px 16px; border: 1px solid var(--border); background: var(--tint); }
.qn-voidbox b { color: var(--danger); }

/* 选卷页：跨卷“该看一眼了” */
.qn-due { margin-bottom: 14px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--tint-2); }
.qd-hd { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
.qd-hd b { font-size: 13px; color: var(--ink); }
.qd-sub { font-size: 11px; color: var(--muted); line-height: 1.6; }
.qd-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: 0; background: transparent; padding: 4px 0; color: var(--ink); font-size: 11.5px; }
.qd-row:hover { color: var(--accent); }
.qd-tag { flex: 0 0 auto; font-size: 10.5px; padding: 1px 6px; border-radius: 6px; background: var(--tint-3); color: var(--muted); }
.qd-tag.bad { background: #f7e4e4; color: var(--danger); }
.qd-q { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qd-d { margin-left: auto; color: var(--muted); font-size: 10.5px; white-space: nowrap; }
.qd-more { font-size: 10.5px; color: var(--muted); padding-top: 4px; }

/* 左栏状态点：作废 */
.ri-s.void { color: var(--danger); }

/* 事后校验页 */
.au-row { border: 1px solid var(--border); border-radius: 10px; padding: 9px 11px; margin-bottom: 9px; background: var(--card); }
.au-hd { display: flex; align-items: center; gap: 8px; }
.au-id { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--muted); }
.au-ask { font-size: 12.5px; color: var(--ink); flex: 1 1 auto; }
.au-v { font-size: 10.5px; padding: 1px 6px; border-radius: 6px; background: var(--tint-3); color: var(--muted); white-space: nowrap; }
.au-v.ok { background: var(--tint-2); color: var(--success); }
.au-v.bad { background: #f7e4e4; color: var(--danger); }
.au-line { margin-top: 5px; font-size: 11px; color: var(--muted); line-height: 1.7; }
.au-ev { margin-top: 3px; font-size: 11px; color: var(--danger); line-height: 1.7; }
.au-acts { margin-top: 7px; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.au-in { flex: 1 1 220px; min-width: 160px; font: inherit; font-size: 11.5px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--card); color: var(--ink); }
.au-in:focus { outline: none; border-color: var(--accent); }
.qn-sel {
  font: inherit; font-size: 11.5px; padding: 3px 6px; border: 1px solid var(--border);
  border-radius: 7px; background: var(--card); color: var(--ink); max-width: 160px;
}
</style>

