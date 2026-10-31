<!--
  在途一屏（2026-10-31 · 渲染层拆分「项目页刀」第一块）

  **边界**：与 `BoardView.vue` 同一套做法 —— 组件只「显示 + 收集意图」，状态与动作在
  `composables/useTripBoard.ts`。父组件把这一屏的状态/动作 + 它还要用的项目页数据
  （`projectStats` / `removeProject` / `openNewProject`）包成 `tripBoardCtl` 传进来。

  ⚠ 根节点仍是 `.tripboard`、仍是 `<main class="pv">` 的**直接子元素**（组件不产生额外 wrapper）：
    `#board.pv` 的 flex 布局与 `.tripboard` 的宽度规则都按这层关系写。
  ⚠ `v-else-if="pvView === 'trip'"` 在父组件那侧，不在本组件里 —— 分支互斥的裁决权留在 App。
-->
<template>
  <div class="tripboard">
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
</template>

<script setup lang="ts">
import { toRef } from 'vue'

/**
 * 唯一 prop：在途一屏控制器（父组件用 `reactive()` 包过的那一坨）。
 *
 * 两类绑定分两种接法（与 BoardView 相同）：
 *   · **状态**（含 computed / 常量清单）→ `toRef(ctl, 'x')`；
 *   · **动作**（函数）→ 直接解构。
 */
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl

// ── 状态 / 派生 ─────────────────────────────────────────────────────────
const tripRows = toRef(ctl, 'tripRows')
const tripHidden = toRef(ctl, 'tripHidden')
const tripHiddenNotPicked = toRef(ctl, 'tripHiddenNotPicked')
const tripHiddenNoActivity = toRef(ctl, 'tripHiddenNoActivity')
const tripError = toRef(ctl, 'tripError')
const tripLoading = toRef(ctl, 'tripLoading')
const tripSettingsOpen = toRef(ctl, 'tripSettingsOpen')
const tripMode = toRef(ctl, 'tripMode')
const tripCriteria = toRef(ctl, 'tripCriteria')
const tripManualIds = toRef(ctl, 'tripManualIds')
const tripCols = toRef(ctl, 'tripCols')
const tripSubtitle = toRef(ctl, 'tripSubtitle')
const tripEmptyHint = toRef(ctl, 'tripEmptyHint')
const projectStats = toRef(ctl, 'projectStats')
const TRIP_CRITERIA_OPTIONS = toRef(ctl, 'TRIP_CRITERIA_OPTIONS')
const TRIP_COL_OPTIONS = toRef(ctl, 'TRIP_COL_OPTIONS')

// ── 动作（在 useTripBoard / App 里，组件只调）───────────────────────────
const {
  loadTripBoard, tripColVisible, tripHealthLabel, tripHealthClass,
  tripCycleHealth, tripUnlockHealth, tripSetMode, tripSetCriteria,
  tripCloseAfterSave, tripBackToAuto, tripResetSettings,
  tripCopyContract, tripCopyContractPrompt, tripOpenRepo, tripOpenContract,
  tripOpenRow, tripInitContract, tripFirstLine, tripContractMissing,
  tripToggleManual, tripToggleCol, removeProject, openNewProject,
} = ctl
</script>
