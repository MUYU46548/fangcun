<!--
  帮助手册视图（2026-11-16 · 第二版：抄隔壁同类产品 `components/GuidePanel.vue`）

  ## 为什么整份重写

  暮雨 2026-11-16：「**使用手册本身也难用得要死**」「**方寸、另一款产品款自有产品款产品、隔壁同类产品三个项目的
  内置用户手册全都不一样，神了，全是看都没看从头瞎造，而且每个都不好用，很丑。
  分类和检索也是必做，方寸手册没有。**」

  上一版是整页平铺 10 节：没有目录、没有检索，正文 max-width 880 且左对齐，
  此外**查不到任何一条签字路径**（页签表 16 行连「作战计划」都没有）。

  ## 抄了隔壁同类产品什么（结构，不是配色）

  · 左目录 + 中内容两栏，点目录项切章（`guide-toc` / `guide-content`）
  · 顶部搜索框，命中标题 / keywords / 正文三处
  · 每节带 `cite`（维护者注：这节的事实出自哪个文件）
  · **文案零副本**：全部在 `utils/userGuide.ts`，这个文件只管渲染

  ## 与上一版/隔壁同类产品的不同（刻意的）

  · **三栏**：左目录 / 中内容 / **右留空** —— 暮雨原话「左侧目录，中间放内容，
    右侧留空（预留给后续使用）」。右侧不给 `flex:1` 的内容，就是留给之后放
    比如「本页相关操作」之类的位置，现在**保持空**（不塞占位文案，空就是空）。
  · 保留整页形态（不是隔壁同类产品那种弹窗遮罩）：`?` 一直是切视图，改弹窗会改他的使用习惯。
  · 沿用本仓主题令牌（`--card` / `--ink` / `--border`…）；隔壁同类产品那套硬编码色值搬不过来，
    `check-themes` 会逐套实测对比度。
-->
<template>
  <main id="board" class="help-view">
    <div class="help-head">
      <h3>使用手册</h3>
      <span v-if="version" class="help-ver">v{{ version }}</span>
      <span class="help-sub">方寸怎么用 —— 每个页签干什么、怎么筛、怎么备份恢复、在哪签字</span>
      <span class="views-grow"></span>
      <button class="ghost" @click="$emit('about')">关于方寸</button>
      <button class="ghost" @click="$emit('home')">⌂ 回看板</button>
    </div>

    <div class="help-shell">
      <!-- 左：目录 + 搜索 -->
      <nav class="help-toc" data-testid="help-toc">
        <input
          v-model="q"
          class="help-search"
          data-testid="help-search"
          type="search"
          placeholder="搜一搜：签字 / 结构地图 / 备份 / 快捷键…"
          aria-label="搜索手册"
        />
        <button
          v-for="s in filtered"
          :key="s.id"
          class="help-toc-item"
          :class="{ active: s.id === curId }"
          :data-testid="'help-toc-' + s.id"
          @click="curId = s.id"
        >{{ s.title }}</button>
        <p v-if="!filtered.length" class="help-none" data-testid="help-none">
          没有匹配「{{ q }}」的章节 —— 换个词试试（例如「签字」「结构地图」「备份」「快捷键」）
        </p>
      </nav>

      <!-- 中：正文 -->
      <article class="help-content" data-testid="help-content" v-if="cur">
        <h4 data-testid="help-title">{{ cur.title }}</h4>
        <template v-for="(b, i) in cur.blocks" :key="i">
          <p v-if="b.t === 'p'" class="h-p">{{ b.v }}</p>
          <ol v-else-if="b.t === 'steps'" class="h-steps">
            <li v-for="(x, j) in b.v" :key="j">{{ x }}</li>
          </ol>
          <ul v-else-if="b.t === 'list'" class="h-list">
            <li v-for="(x, j) in b.v" :key="j">{{ x }}</li>
          </ul>
          <div v-else-if="b.t === 'key'" class="h-keys">
            <div v-for="(pair, j) in b.v" :key="j" class="h-key-row">
              <kbd>{{ pair[0] }}</kbd><span>{{ pair[1] }}</span>
            </div>
          </div>
          <p v-else-if="b.t === 'warn'" class="h-warn">⚠ {{ b.v }}</p>
          <p v-else-if="b.t === 'tip'" class="h-tip">💡 {{ b.v }}</p>
        </template>
        <p v-if="cur.cite" class="h-cite">维护者注：{{ cur.cite }}</p>
      </article>

      <!-- 右：留空（暮雨 2026-11-16：「右侧留空，预留给后续使用」）。
           这里**不塞占位文案** —— 空就是空，塞一句"此处暂无内容"是最典型的凑数。 -->
      <aside class="help-rail" aria-hidden="true"></aside>
    </div>

    <footer class="help-foot">
      <span>共 {{ GUIDE_SECTIONS.length }} 节 · 点顶栏「?」随时打开</span>
      <span v-if="q">筛出 {{ filtered.length }} 节</span>
    </footer>
  </main>
</template>

<script setup lang="ts">
/**
 * 纯渲染组件：**零文案**。改手册请改 `utils/userGuide.ts`，不要改这里。
 * 交互只有两件：「回看板」与「关于方寸」，都交给父组件（goHome 要清搜索与筛选，
 * 那是 App.vue 的事，不该搬到这里）。
 */
import { ref, computed, watch } from 'vue'
import { GUIDE_SECTIONS, searchGuide } from '../utils/userGuide'

defineProps<{ version?: string }>()
defineEmits<{ (e: 'home'): void; (e: 'about'): void }>()

const q = ref('')
const curId = ref(GUIDE_SECTIONS[0]?.id || '')

const filtered = computed(() => searchGuide(q.value))
const cur = computed(() => {
  const list = filtered.value
  if (!list.length) return null
  return list.find((s) => s.id === curId.value) || list[0]
})

// 搜索把当前章节筛掉了 → 自动落到第一条，避免"左边有内容、右边空着"
watch(filtered, (list) => {
  if (list.length && !list.some((s) => s.id === curId.value)) curId.value = list[0].id
})
</script>

<style scoped>
/* 三栏：左目录 240 / 中正文自适应 / 右留空 220。
   ⚠ 窄屏（<1080）收起右栏 —— 留空不该在小屏上挤掉正文。 */
.help-view { display: flex; flex-direction: column; height: 100%; min-height: 0; }

.help-head {
  display: flex; align-items: baseline; gap: 10px;
  padding: 12px 18px 10px; border-bottom: 1px solid var(--border);
}
.help-head h3 { margin: 0; font-size: 15px; color: var(--ink); }
.help-ver { font-size: 11px; color: var(--muted); }
.help-sub { font-size: 12px; color: var(--muted); }
.views-grow { flex: 1; }

.help-shell {
  flex: 1; display: flex; min-height: 0;
}

/* ── 左目录 ── */
.help-toc {
  width: 240px; flex-shrink: 0; overflow-y: auto;
  padding: 10px; border-right: 1px solid var(--border);
  background: var(--tint);
}
.help-search {
  width: 100%; box-sizing: border-box;
  padding: 6px 9px; margin-bottom: 8px;
  font-size: 12.5px; color: var(--ink);
  background: var(--card);
  border: 1px solid var(--border); border-radius: 7px;
}
.help-search:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.help-search::placeholder { color: var(--muted); }

.help-toc-item {
  display: block; width: 100%; text-align: left;
  padding: 7px 9px; margin-bottom: 3px;
  font-size: 12.5px; color: var(--ink);
  background: transparent; border: 1px solid transparent;
  border-radius: 7px; cursor: pointer;
}
.help-toc-item:hover { background: var(--card); border-color: var(--border); }
.help-toc-item.active {
  background: var(--card); border-color: var(--accent);
  color: var(--accent); font-weight: 600;
}
.help-none { font-size: 12px; color: var(--muted); line-height: 1.6; padding: 6px; }

/* ── 中正文 ── */
.help-content {
  flex: 1; min-width: 0; overflow-y: auto;
  padding: 18px 26px 26px;
  /* 正文自己再收一道宽度：三栏下 880 会撞到右栏，实测 760 更舒服 */
  max-width: 760px;
}
.help-content h4 {
  margin: 0 0 12px; font-size: 15px; font-weight: 700; color: var(--accent);
  padding-bottom: 0; border-bottom: none;
}
.h-p { margin: 0 0 10px; font-size: 12.5px; line-height: 1.8; color: var(--ink); }
.h-steps, .h-list {
  margin: 0 0 12px; padding-left: 22px;
  font-size: 12.5px; line-height: 1.8; color: var(--ink);
}
.h-steps { list-style: decimal; }
.h-list { list-style: disc; }
.h-steps li, .h-list li { margin-bottom: 5px; }
.h-keys { margin: 4px 0 12px; display: flex; flex-direction: column; gap: 5px; }
.h-key-row { display: flex; align-items: baseline; gap: 10px; font-size: 12.5px; color: var(--ink); }
.h-key-row kbd {
  min-width: 96px; text-align: center; padding: 2px 7px;
  font-family: inherit; font-size: 11.5px; color: var(--ink);
  background: var(--tint); border: 1px solid var(--border);
  border-bottom-width: 2px; border-radius: 5px;
}
.h-warn, .h-tip {
  margin: 0 0 12px; padding: 8px 11px;
  font-size: 12px; line-height: 1.75; border-radius: 7px;
}
.h-warn {
  color: var(--danger, #c96a6a); background: var(--tint);
  border-left: 3px solid var(--danger, #c96a6a);
}
.h-tip {
  color: var(--ink); background: var(--tint);
  border-left: 3px solid var(--accent);
}
.h-cite { margin: 20px 0 0; font-size: 11px; color: var(--muted); }

/* ── 右留空 ──
   ⚠ 2026-11-16 第二版：第一版给了 `border-left`，截图一看是**一大块带边框的空白**，
   像界面画崩了。暮雨说的是「右侧留空」= 留白，**不是加一条分割线**。
   所以这里不画边框、不画底色：内容区自己 max-width 收住，右边自然就是空。
   保留这个元素是给以后真往里放东西时有个锚点（现在它是 0 宽度的占位容器）。 */
.help-rail { flex: 0 0 0; width: 0; }

.help-foot {
  display: flex; justify-content: space-between;
  padding: 8px 18px; font-size: 11px; color: var(--muted);
  border-top: 1px solid var(--border); background: var(--tint);
}
</style>
