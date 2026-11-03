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
            <span class="ic-step"><b>② 待办</b>点“变成待办”：真的在待办里生出一条，能派活/排期</span>
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
            <button class="pri ideas-save" :disabled="ctl.ideaBusy || !ctl.ideaDraft.trim()" @click="ctl.saveIdea()">
              {{ ctl.ideaBusy ? '记…' : '记下来' }}
            </button>
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
                <button class="ok idea-do" :disabled="ctl.ideaBusy" @click="ctl.doIdea(i)"
                  title="决定做 —— 真的在待办里生出一条（全文带过去），之后能退回来">变成待办 →</button>
                <button class="ghost idea-hold" :disabled="ctl.ideaBusy" @click="ctl.holdIdea(i)"
                  title="先放着，不是否决 —— 将来还能捡回来">搁置</button>
                <button class="ghost idea-drop" :disabled="ctl.ideaBusy" @click="ctl.dropIdea(i)"
                  title="想过了，不做 —— 这条会留着；想过本身也有价值">不做</button>
                <button class="ghost idea-del" :disabled="ctl.ideaBusy" @click="ctl.removeIdea(i)"
                  title="记错了就删掉（能撤销）">×</button>
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
                <span class="idea-note" v-if="i.note">{{ i.note }}</span>
                <span class="idea-when">{{ ctl.relativeTime(i.decidedAt || i.createdAt) }}</span>
                <div class="idea-acts">
                  <button class="ghost" v-if="i.status === '已立项'" :disabled="ctl.ideaBusy" @click="ctl.undoDoIdea(i)">
                    撤销立项
                  </button>
                  <button class="ghost" v-else :disabled="ctl.ideaBusy" @click="ctl.reviveIdea(i)"
                    title="捡回来，重新当还没决定的">捡回来</button>
                  <button class="ghost idea-del" :disabled="ctl.ideaBusy" @click="ctl.removeIdea(i)" title="删掉（能撤销）">×</button>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </main>
</template>

<script setup lang="ts">
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
