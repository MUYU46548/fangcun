# 派工单：给「记忆圣所」写分层 spec

- 卡类型：数据整理（产出一份 JSON 文件，不改任何代码）
- 项目：记忆圣所（`memory-sanctuary`）
- 仓库根：`E:/CODE/CangKu/memory-sanctuary`
- 产物落点：`task-data/layer-specs/memory-sanctuary.json`（**方寸数据目录**，不是项目仓库）

## 1 任务目标

把「记忆圣所」**自己声称的分层**写成一份 spec JSON，供方寸回答一个问题：

> 这个项目号称是 A，但 88% 的行数在 B。

⚠ 这句话**只能靠你判断**，因为「哪几层是一伙的」是项目的自我认知，不是目录结构。
方寸已经把**事实**算好了（下面第 3 节），你只需要做**归类与命名**。

## 2 工作目录 / 范围

- 只读项目仓库（**一个字都不许写进去**）：`E:/CODE/CangKu/memory-sanctuary`
- 唯一允许写入的地方：方寸数据根的 `task-data/layer-specs/memory-sanctuary.json`
- **不许改代码、不许改文档、不许 git 操作**

## 3 已经算好的事实（别自己重新数）

方寸扫盘结果：**产品 33,949 行**（全仓合计 36,270 行，含测试与脚本）。

> 口径：只数能解码成文本的文件（二进制不算）；排除依赖 / 构建产物 / 打包目录 /
> 内嵌运行时 / 隐藏目录。`.ts` 可能是 MPEG 视频分片，GBK 脚本是文本不是二进制 ——
> 这两条方寸已经处理过，**你不用再踩**。

| 层（左列可直接当候选） | 角色 | 文件数 | 行数 |
|---|---|---:|---:|
| `js` | 产品 | 28 | 23,344 |
| `css` | 产品 | 5 | 9,753 |
| `scripts` | 工具 | 20 | 2,321 |
| `(根)` | 产品 | 1 | 846 |
| `vendor` | 产品 | 1 | 6 |

### 被规则挡在分母外面的（方寸已排除，列出来让你知道）

- `.git` —— 版本库
- `.hermes` —— agent 私有目录
- `.opensquilla` —— 隐藏目录（VCS / 浏览器 profile / 缓存）
- `desktop-build` —— 打包产物（记忆圣所这个目录名）

## 4 项目自己怎么说自己（骨架原文）

### `AGENTS.md`（7763 字，下面只带前 6000 字）

```markdown
# Memory Sanctuary — AI Agent Guide

You are a senior HTML5 game developer working on **记忆圣所（Memory Sanctuary）**, a post-apocalyptic narrative-driven resource management game.

本文件中的路径描述仅为逻辑指引。若实际目录结构与描述不符，请以当前项目实际文件结构为准，无需报错，按最新结构执行。

---

## Project Identity

- **Genre:** 末日叙事驱动资源管理（考古、记忆留存、文明抉择）
- **Experience:** 沉浸、静谧、叙事厚重感，碎片化考古拼凑真相
- **Tech Stack:** HTML5 + CSS3 + Vanilla JS (ES6+), Canvas 2D
- **Zero Build:** No NPM, Webpack, TypeScript. Browser runs directly.
- **Font:** 霞鹜文楷 (WenKai) — cached via Cache API, no re-download

---

## Architecture

```
/js/main.js          → Bootstrap, theme switch, data load scheduling, global error handling
/js/game.js          → Core state machine (resources, time, decay, NG+, achievements)
/js/game-*.js        → Subsystems split from game.js:
                         game-archive.js     (archive entry / conflict / quick-archive)
                         game-emergency.js   (emergency protocol activation)
                         game-ending.js      (ending condition / gallery / VN bridge)
                         game-exploration.js (surface exploration dispatch)
                         game-projects.js    (maintenance projects)
                         game-tech.js        (tech tree: doctrines / unlockTech / getTech*Bonus)
                         game-events.js      (random/scheduled events)
                         game-log.js         (log system)
                         game-save.js        (save/load/export/import)
                         game-tutorial.js    (new-player tutorial)
/js/ui.js            → DOM rendering & event binding (no business logic)
/js/canvas.js        → Canvas drawing & animation loop (no UI interaction)
/js/audio.js         → BGM / SFX management (Web Audio API)
/js/vn.js            → Visual novel engine (chapter transitions, endings)
/js/dlc.js           → DLC module registry (ascension / greenOrb)
/js/ascension-world.js  → DLC 升天之仪 3D 世界层（three.js 场景、走动、交互、房间壳；颜色全读 --aw-*）
/js/ascension-rooms.js  → DLC 升天之仪 房间系统（看见 → 话头 → 问 + 「你记住的话」抽屉）
/data/*.json         → All entries, guardian dialogues, events, projects, explorations, endings
/data/dlc/ascension/rooms/ → 房间数据：一间一份 JSON（shell / props / threads / npcs）
/vendor/three.min.js   → three.js（唯一第三方库，离线随包；打包脚本 GAME_DIRS 已含 vendor）
/css/main.css         → Theme-driven styles (CSS variables)
/css/ascension-world.css → 3D 世界层样式（--aw-* 双主题变量）
/index.html          → Single-page app shell
```

**Data-driven principle:** All game content (entries, dialogues, events, projects, achievements) lives in `/data/*.json`. Never hardcode business data in JS.

---

## Commands

```bash
# Start dev server (port 8099, fallback if occupied)
python -m http.server 8099

# Syntax check all JS files
node -c js/*.js

# 升天之仪房间数据校验（每间房写完必跑；只查结构与可达性，不评文案）
node scripts/check_ascension_room.js data/dlc/ascension/rooms/ration.json

# Or individually (order-independent):
node -c js/game.js && node -c js/ui.js && node -c js/main.js && node -c js/canvas.js && node -c js/audio.js && node -c js/vn.js && node -c js/game-archive.js && node -c js/game-emergency.js && node -c js/game-ending.js && node -c js/game-exploration.js && node -c js/game-tutorial.js
```

---

## Theme System

All UI must support both `[data-theme="dark"]` and `[data-theme="light"]`.

```css
/* ✅ Correct: use CSS variables */
color: var(--text-primary);
background: var(--bg-panel);
border: 1px solid var(--border-subtle);

/* ❌ Wrong: hardcolor values */
color: #e0e0e0;
background: #12121a;
```

Canvas colors must also read from CSS variables:
```js
const style = getComputedStyle(document.body);
const amber = style.getPropertyValue('--amber-primary').trim();
```

---

## Code Style

### JavaScript (ES6+)

```js
// ✅ Use const/let, arrow functions, template literals
const MAX_WEEK = 48;
const getMoraleLevel = (mood) => {
    if (mood >= 6) return { level: 'excellent', label: '高昂', bonus: 1.15 };
    if (mood >= 3) return { level: 'good', label: '良好', bonus: 1.05 };
    return { level: 'normal', label: '平稳', bonus: 1.0 };
};

// ✅ Null-guard in init functions (state may be null before new game)
function initTitleScreen() {
    if (!MemorySanctuary.state) return;
    // ...
}

// ✅ Data-driven lookup
const guardian = MemorySanctuary.data.guardians.find(g => g.id === id);

// ❌ No business data in JS — move to /data/*.json
const DIALOGUES = ['hello', 'world']; // WRONG
```

### CSS

```css
/* ✅ Use variables, BEM-like naming */
.project-item.can-start { border-color: var(--success); }
.project-btn[disabled] { opacity: 0.6; cursor: not-allowed; }

/* ✅ Focus-visible for keyboard nav, not focus ring on click */
button:focus-visible { outline: 2px solid var(--amber-primary); outline-offset: 2px; }
button:focus:not(:focus-visible) { outline: none; }

/* ✅ Respect reduced-motion preference */
@media (prefers-reduced-motion: reduce) {
    * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
```

---

## Boundaries

### ✅ Always do
- Save all game content in `/data/*.json`, not in JS
- Use CSS variables for all colors (no hardcoded `#hex`)
- Add `null` guards in any function that accesses `MemorySanctuary.state`
- Test both dark and light themes when adding UI components
- Use `:focus-visible` for keyboard navigation support
- Increment NG+ counters and save state on every meaningful action
- Update `data/achievements.json` for new achievements (type, value, icon)
- Run `node -c js/*.js` syntax check after edits

### ⚠️ Ask first before
- Adding new game mechanics (beyond bug fixes / UX polish)
- Modifying save data structure (breaks compatibility)
- Changing existing achievement thresholds
- Adding new audio cues or BGM transitions
- Altering the time-axis / week progression balance
- Refactoring the state machine architecture

### 🚫 Never do
- Hardcode game content (entries, dialogues, events) inside JS files
- Write colors directly in CSS (always use `var(--...)`)
- Skip `null` guards in init functions (causes
```


> ⚠ 上表只是**一级目录**。项目的「分层」往往不等同于目录：像司天那样「生成器 vs 编辑器」是**两套读法**，两者共用同一个 `utils/`。所以你要做的是：把上面的目录**归成几块**，每块回答'这是什么'。

## 5 方寸已经推出来的（供你参考，可能错）

自动推导**推出 3 层**（仅供你参考，可能有错）：

- `js/（Architecture）` —— 从 AGENTS.md「Architecture」推出；文档里点到 9 个具体文件，例如 `js/ascension-rooms.js`、`js/ascension-world.js`、`js/audio.js`
- `css/（Architecture）` —— 从 AGENTS.md「Architecture」推出；文档里点到 2 个具体文件，例如 `css/ascension-world.css`、`css/main.css`
- `vendor/（Architecture）` —— 从 AGENTS.md「Architecture」推出；文档里点到 1 个具体文件，例如 `vendor/three.min.js`

## 6 现有 spec（**这个项目还没有 spec** —— 你要新建一份）

_没有现成 spec。直接按第 7 节的格式产出一份新的。_

## 7 产出格式（照抄这个形状）

```json
{
  "_comment": "写清这份 spec 的来路：谁写的、依据哪份文档",
  "source": "依据哪份文档 / 谁的口径（例：AGENTS.md 第 3 节 + 项目负责人确认）",
  "layers": {
    "层名（人话，别用目录名当层名）": {
      "paths": [
        "相对仓库的路径前缀",
        "支持 * 通配，如 src/utils/terrain*"
      ],
      "note": "这层是干什么的（一句话）"
    }
  },
  "groups": {
    "大块名（例：生成器 / 编辑器）": [
      "上面某一层",
      "上面另一层"
    ]
  },
  "claims": {
    "层名": 0
  },
  "claimsNote": "claims 是**项目负责人手算过的数字**。没有就整段删掉，别编。"
}
```

字段说明：

- `layers`：**至少 2 层**，否则不叫分层。层名用人话（「生成器」「账本引擎」），不要用目录名。
- `groups`：可选。当项目有「两套读法」（如司天的生成器 / 编辑器）时用它把层归成大块 ——
  这是回答「号称是 A 但 88% 在 B」的关键。没有就别写。
- `claims`：可选。**只有当项目负责人手算过数字时才填**，用于让方寸当场对账。没手算就删掉。
- `paths`：写相对仓库的路径。目录写 `src/foo/`，文件写 `src/foo.js`，通配写 `src/terrain*`。

## 8 硬约束（越界即打回）

1. **不许编路径**。`paths` 里每一条都必须**真的匹配到文件**。写完自己验：
   逐条 `paths` 去仓库里找，找不到就删掉那条，不要留着。
2. **推不出来就说推不出来**。如果这个项目根本就没有可辨识的分层
   （比如它是一堆平铺的脚本），**直接回报「推不出来 + 为什么」**，不要硬凑两层。
   硬凑出来的 spec 比没有更糟 —— 方寸会拿它去算一个假结论。
3. **层名必须是人话**。`src/` 不是层名；「渲染层」「数据层」「生成器」才是。
4. **不许声称你理解了这个项目**。你是在做一次**目录归类**，不是代码审查。
   报告里写清「依据是哪个文档的哪一节」。
5. **结论区分「实测」与「推测」**：路径存在性是实测；「这三层是一伙的」是判断。
   判断要写理由。

## 9 交付

1. 把 JSON 写进 `task-data/layer-specs/memory-sanctuary.json`
2. 回报一段话，说清四件事：
   - 分了哪几层，每层一句话
   - 依据是哪个文档的哪一节（**必须能指回原文**）
   - 哪些路径你验过存在（实测）、哪些是推测
   - 有没有「两套读法」这种需要 `groups` 的情况；没有就明说没有
3. **不要打包、不要提交 git、不要改任何项目文件**
