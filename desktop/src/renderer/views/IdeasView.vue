<template>
    <main id="board" class="ideas-view">
      <div class="ideas-wrap">
        <div class="ideas-head">
          <div class="ideas-lead">念头先扔这儿，做不做以后再说</div>
          <div class="ideas-lead-sub">
            这里的东西不算任务、不进逾期、不进待办。决定做了才转成待办，转出去也留着记录。
          </div>
          <!-- 2026-10-31（暮雨第 6 条）：这条链一直存在，但只有一个“做”字、没有任何说明 ——
               用户的原话是“不像待办那样方便，也不像日志那样直接，中转问题一堆”。
               把三步写出来，并指出每一步在哪儿点，比再造一个入口有用。 -->
          <div class="ideas-chain">
            <span class="ic-step"><b>① 想法</b>这一页：随手记，不用想清</span>
            <span class="ic-arrow">→</span>
            <span class="ic-step"><b>② 待办 / 任务卡</b>“变成待办”= 轻条目；“做成任务卡”= 真进 task-data，能派活/进阻塞链</span>
            <span class="ic-arrow">→</span>
            <span class="ic-step"><b>③ 日志</b>做完在待办那条上点“→ 日志”：留痕，可回看</span>
          </div>
        </div>

        <div class="ideas-box">
          <textarea class="ideas-in" v-model="ctl.ideaDraft" :disabled="ctl.ideaBusy" rows="2"
            placeholder="想到什么就写一句 —— Ctrl+Enter 存下"
            @keydown.ctrl.enter.prevent="ctl.saveIdea()"
            @keydown.meta.enter.prevent="ctl.saveIdea()"></textarea>
          <div class="ideas-sub">
            <span class="ideas-hint">
              <template v-if="ctl.ideaDraft.trim()">{{ ctl.ideaDraft.trim().length }} / 4000 字</template>
              <template v-else>存下来不改任何待办和任务，也不会让任何东西逾期</template>
            </span>
            <!-- 2026-11-12：`size="md"`（34=弹窗主按钮档）→ `tool`（28=工具行档）。
                 它站在**工具行**里（旁边“N/4000 字”是 11.5 号小字、下面是 26 高的想法动作行），
                 34 会让输入框那一行比整页的节奏高出一截。34 档留给弹窗主按钮。 -->
            <Button class="ideas-save" variant="primary" size="tool" :disabled="ctl.ideaBusy || !ctl.ideaDraft.trim()" @click="ctl.saveIdea()">
              {{ ctl.ideaBusy ? '记…' : '记下来' }}
            </Button>
          </div>
        </div>

        <div class="ideas-sec">
          <div class="ideas-sec-h">
            还没决定 <em>{{ ctl.ideasOpen.length }}</em>
          </div>
          <div class="ideas-empty" v-if="!ctl.ideasOpen.length">
            还没有念头。上面写一句就存下了 —— 不用想它要不要做。
          </div>
          <div class="idea" v-for="i in ctl.ideasOpen" :key="i.id">
            <div class="idea-t">{{ i.text }}</div>
            <div class="idea-sub">
              <span class="idea-when">记于{{ ctl.relativeTime(i.createdAt) || '刚刚' }}</span>
              <div class="idea-acts">
                <!-- 2026-11-12：`.ok` 手搓 → 基座 `success` 变体（同一个绿色成功态，几何零像素差） -->
                <Button variant="success" size="tool" class="idea-do" :disabled="ctl.ideaBusy" @click="ctl.doIdea(i)"
                  title="决定做 —— 真的在待办里生出一条（全文带过去），之后能退回来">变成待办 →</Button>
                <Button variant="ghost" size="sm" class="idea-task" :disabled="ctl.ideaBusy" @click="ctl.ideaToTask(i)"
                  title="做成任务卡 —— 真写进 task-data：能进看板/阻塞链/next，能派给 agent；归属先留空，去卡上选">做成任务卡</Button>
                <Button class="idea-hold" variant="ghost" size="sm" :disabled="ctl.ideaBusy" @click="ctl.holdIdea(i)"
                  title="先放着，不是否决 —— 将来还能捡回来">搁置</Button>
                <Button class="idea-drop" variant="ghost" size="sm" :disabled="ctl.ideaBusy" @click="ctl.dropIdea(i)"
                  title="想过了，不做 —— 这条会留着；想过本身也有价值">不做</Button>
                <Button class="idea-del" variant="ghost" size="sm" :disabled="ctl.ideaBusy" @click="ctl.removeIdea(i)"
                  title="记错了就删掉（能撤销）">×</Button>
              </div>
            </div>
          </div>
        </div>

        <div class="ideas-sec" v-if="ctl.ideasDecided.length">
          <div class="ideas-sec-h ideas-toggle" @click="ctl.ideasShowDecided = !ctl.ideasShowDecided">
            <span>已经有结论 <em>{{ ctl.ideasDecided.length }}</em></span>
            <span class="ideas-caret">{{ ctl.ideasShowDecided ? '收起' : '展开' }}</span>
          </div>
          <template v-if="ctl.ideasShowDecided">
            <div class="idea idea-decided" v-for="i in ctl.ideasDecided" :key="i.id">
              <div class="idea-t">{{ i.text }}</div>
              <div class="idea-sub">
                <span class="idea-badge" :class="'is-' + ctl.ideaStatusKey(i.status)">{{ i.status }}</span>
                <!-- 产出落到哪：只写"已立项"等于看不见它变成什么了。
                     这条让"念头 → 卡"整条链在页面上可查（卡 id 能直接贴给 agent）。 -->
                <span class="idea-promoted" v-if="i.promoted">
                  {{ i.promoted.kind === 'task' ? '→ 卡 ' + i.promoted.id : '→ 待办' }}
                </span>
                <span class="idea-note" v-if="i.note">{{ i.note }}</span>
                <span class="idea-when">{{ ctl.relativeTime(i.decidedAt || i.createdAt) }}</span>
                <div class="idea-acts">
                  <button class="ghost" v-if="i.status === '已立项'" :disabled="ctl.ideaBusy" @click="ctl.undoDoIdea(i)">
                    撤销立项
                  </button>
                  <button class="ghost" v-else :disabled="ctl.ideaBusy" @click="ctl.reviveIdea(i)"
                    title="捡回来，重新当还没决定的">捡回来</button>
                  <Button class="idea-del" variant="ghost" size="sm" :disabled="ctl.ideaBusy" @click="ctl.removeIdea(i)" title="删掉（能撤销）">×</Button>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </main>
</template>

<script setup lang="ts">
// UI 基座 · 第一刀迁移（2026-11-07）：新按钮一律走 components/ui/Button.vue
import Button from '../components/ui/Button.vue'
/**
 * 念头页（2026-11-03 · App.vue 拆分「视图刀」）
 *
 * 只搬模板：想法状态与四个动作仍在 App.vue（下一刀可收进 useIdeas）。
 * 这一页的边界早已写死：不算任务、不进逾期、不进待办。
 */
const props = defineProps<{ ctl: any }>()
const ctl = props.ctl
/** 拆分守卫反查锚点 */
const ideasCtl = ctl
</script>
