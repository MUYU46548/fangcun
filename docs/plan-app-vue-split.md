# App.vue 拆分方案（15074 → 目标 ~7500 行）

> 2026-10-21 · 只出方案不拆（W1-批次 3B）
> ⚠ 施工单写的是 15074 行，那是 10-18 的数；**今天实测 15293 行**（本轮加了撤销条与路线文档块）。
> 本文所有行数都是 2026-10-21 在 `desktop/src/renderer/App.vue` 上量出来的，命令附在附录。

---

## 一、它现在到底多大、大在哪

| 段 | 行数 | 占比 | 说明 |
|---|---|---|---|
| `<template>` | **4036** | 26% | 12 个主视图块 + **24 个浮层**（弹窗/抽屉）全平铺在一个文件里 |
| `<script setup>` | **8298** | 54% | 492 个函数、336 个 `ref/computed/reactive` 声明、81 个 `// ──` 分区 |
| `<style>` | **2954** | 19% | 全局样式（非 scoped），六套主题令牌也在里面 |

模板侧的主视图块实测（行数为块区间，含全部嵌套）：

| 视图 | 行数 | 视图 | 行数 |
|---|---|---|---|
| roadmap（路线图） | **1398** | logs（日志） | 214 |
| projects（项目/监控台） | 524 | todos（待办） | 204 |
| launchpad（启动台） | 507 | skills（技能） | 159 |
| active（看板） | 230 | help（帮助） | 121 |
| services（服务） | 87 | calendar（日历） | 76 |
| blockers（阻塞） | 68 | trash（回收站） | 66 |

脚本侧最大的几段（按 `// ──` 分区量）：

```
505 行  阻塞字段的选择器          497 行  在途一屏
395 行  附件（日志↔文件）          325 行  日志：导入外部文本
315 行  服务 / 端口               301 行  日志 ⇄ 待办互转
244 行  Git 通道                  237 行  通知中心
234 行  快速记                    191 行  导出备份
189 行  诊断页三块                183 行  筛选栏
178 行  日志/待办右键菜单          166 行  新建规划 / 新建项目
154 行  监控台建议动作             149 行  Launchpad
```

**真正的病不是"行数多"**，是三件事：
1. 改任何一个视图都要在 1.5 万行里滚动定位（81 个分区标记就是在给这件事打补丁）
2. 一个视图的改动会让整份文件重新编译、整页重渲染（Vite HMR 全量失效，改 CSS 等于改全部）
3. **越难拆越不敢拆** —— 每次想拆都先要读完 8000 行脚本，于是又搁置一次

---

## 二、拆分策略：先搬"视图"，不动"状态"

### 为什么不是"先抽 store"
336 个 `ref` 里，绝大多数是"某视图的局部状态 + 几个 handler"。
真按 Pinia 重排一遍等于**同时改状态归属 + 改渲染路径**，两个大变动叠一起，红了分不清是谁。
本轮刚验证过一条更省事的路：**composable 单例**（`renderer/undo.ts`）——
模块级 `ref` 谁 import 谁共享，不需要 prop drilling，也不需要给 336 个声明搬家。

### 所以顺序是
1. **纯模板抽离**：视图块变成 `<XxxView />`，状态仍在 App.vue（用 `v-bind` 传给组件、`@` 收事件）
   —— 但只对"输入输出少"的视图这么做（help / calendar / trash / blockers / services）
2. **状态跟着走**：一个视图的状态与 handler 超过 ~150 行时，抽成 `composables/useXxx.ts` 单例，组件与 App.vue 同时 import
3. **浮层批量**：24 个 overlay 各自有独立的开关 ref，最适合"整块搬"（每个 20–60 行模板 + 一段 handler）
4. **最后动大块**：roadmap（1398）/ projects（524）/ launchpad（507）

---

## 三、分步计划（每步一个提交，可单独回滚）

> 「预算行数」= 该步预期从 App.vue 移出多少行；「累后」= 该步做完 App.vue 大致剩多少。

### 第 0 步：准备（不改代码）
- `git tag split-baseline-20261021`（快照点，回滚锚）
- 建 `docs/app-vue-split-ledger.md`：每步一行（块名 / 提交号 / 移出行数 / 断言数）
- **红线**：这一步之后，任何一次拆分都不许顺带改功能。要改功能另开一笔。

### 第 1 批：低耦合视图（5 块，预算 ~700 行，累后 ~14600）
| 顺序 | 块 | 模板行 | 为什么先它 |
|---|---|---|---|
| 1 | help（帮助手册） | 121 | 纯静态，零请求零状态 —— 拆错了也能一眼看出来 |
| 2 | calendar | 76 | 逻辑早在 `calendar.ts`（纯函数、`e2e-calendar` 50 条断言兜着） |
| 3 | trash | 66 | 数据全走 `trash*` 通道，与主视图无共享状态 |
| 4 | blockers | 68 | 只有 `blockerChains` 一个数据源 |
| 5 | services | 87 | 端口登记是独立子系统（`e2e-ports` 65 条兜着） |

验收：每拆一块跑下面「四」的全套；`e2e-renderer-web` 断言数**不许掉**（拆完仍 607）。

### 第 2 批：中耦合视图 + 状态抽离（3 块，预算 ~1500 行，累后 ~13100）
| 顺序 | 块 | 模板行 | 要一起搬走的脚本 |
|---|---|---|---|
| 6 | skills | 159 | 技能安装/导入两段（144+144） |
| 7 | todos | 204 | 待办勾选/多选/转换/右键菜单（约 300 行）→ `composables/useTodos.ts` |
| 8 | logs | 214 | 日志列表/分区/批量/接力（约 500 行）→ `composables/useLogs.ts` |

⚠ todos 与 logs 都与「日志⇄待办互转」共用逻辑，**两个 composable 要同时建**，别拆一半：
互转一旦分居两侧，就是下一轮"改了 A 忘了 B"。

### 第 3 批：24 个浮层（预算 ~2000 行，累后 ~11100）
按"开关是独立 ref"成对搬。建议顺序（都由模板里 `v-if` 的 ref 命名）：

```
低风险（纯展示/表单）：about / quickadd / proj-new / app-edit / plans / cal-assign / migrate
中风险（改数据）：todo-edit / log-edit / log-preview / log-project / log-purge / trash-purge
高风险（多步流程）：relay（接力）/ ai-plan / ai-doc / policy / smap / soverlay（设置）
```

**每批不超过 6 个**：一次搬 24 个，红了要二分。

### 第 4 批：三块大的（预算 ~3600 行，累后 ~7500）
| 顺序 | 块 | 模板行 | 备注 |
|---|---|---|---|
| 9 | launchpad | 507 | 与端口子系统分家（2026-10-16 已定「启动台不出现端口」） |
| 10 | projects（监控台） | 524 | `pv*` 那批 computed 与监控台数据（在途一屏 497 + 建议动作 154 + 文档实况）一起进 `useProjectBoard.ts` |
| 11 | roadmap | 1398 | 最大、最耦合；放最后是因为它同时吃任务/待办/日志三份数据 |

### 第 5 批：样式外置（可选，预算 ~2900 行，累后 ~4600）
`<style>` 里 2954 行是**全局**样式（非 scoped）。搬到 `src/renderer/styles/` 按域拆文件，
在 `main.ts` 里按固定顺序 import 一次。⚠ 唯一的坑是**顺序与特异性**：必须保证 import 顺序
与当前单文件里的出现顺序一致，否则覆盖关系会变（这也是为什么它单独一步、且放在最后）。

---

## 四、每一步怎么验（照抄即可，全套约 2 分钟）

```bash
cd desktop && npm run build                    # 零 TS 错

cd .. && node scripts/test/check-template-bindings.cjs   # 拆组件最容易断的是模板绑定
node scripts/test/check-ipc-parity.cjs                   # 通道/入口有没有变成死线
node scripts/test/check-button-styles.cjs                # 搬走的按钮样式有没有丢规则
node scripts/test/check-ui-base.cjs
node scripts/test/e2e-renderer-web.cjs                   # 必须 607/0（断言只增不减）
node scripts/test/e2e-renderer.cjs                       # 必须 312/0（真点击）
```

**另外两条硬要求**：
1. 拆哪块，就先确认**那块自己的既有断言还在跑**（例如 trash 有回收站多选断言、services 有端口断言）。
   断言数掉了 = 拆的时候把测点一起搬丢了。
2. 每步单独提交，提交信息写 `refactor(方寸): 拆分N/M-块名 —— 移出 X 行，断言 607/0 不变`。

---

## 五、回滚路径（施工单要求的字段，写死在这）

### 5.1 快照点
| 层级 | 手段 | 回滚动作 | 代价 |
|---|---|---|---|
| 整轮 | `git tag split-baseline-20261021` | `git reset --hard split-baseline-20261021` | 一次重编译 |
| 单步 | 每步一个独立提交 | `git revert <那笔>` | 一次重编译 |
| 运行时 | **灰度开关**（见 5.2） | 改 `prefs.json` 里一个数组 | 重启方寸，无需重装 |
| 数据 | 不涉及 | —— | 全程只改渲染层，`task-data/` 一个字节不动 |

### 5.2 灰度开关设计（关键：能"不重装"就退回旧渲染路径）
- 真身：`userData/prefs.json` 的 `fc_split_legacy`（**字符串数组**，默认 `[]`）
- 语义：列在里面的块**走旧的内联实现**；不在里面的走新组件
- App.vue 侧：
  ```vue
  <LogsView v-if="!legacy.includes('logs')" ... />
  <template v-else>  <!-- 旧块，灰度期内保留 --> </template>
  ```
- 生命周期：每块拆完 → 灰度期 **一个发版周期（约 1–2 周）** → 期间只用旧代码没动过 → **删掉旧块**并把该块名从开关里清掉
- 为什么不做成"设置页里的开关"：用户零动作原则 + 这是**给开发/排障用的逃逸阀**，不该出现在界面上
  （与 `fc_disable_gpu` 同款：能改文件就行，不给按钮）

⚠ **不许省掉"删旧块"这一步**。留着双份实现意味着以后每次改日志都要改两处，
那才是真正的技术债 —— 这个开关是救生圈，不是长期结构。

### 5.3 什么时候该按下回滚
- 新组件渲染出**行为差异**（不是样式微差），且 10 分钟内定位不到 → 立刻把块名加进 `fc_split_legacy`，别硬调
- 断言红了但原因不明 → 先 `git revert` 那一笔，回到绿基线再查

---

## 六、预期收益与不做什么

**收益（可量）**
- App.vue 15293 → 约 7500（样式外置后约 4600），单文件函数从 492 降到 150 上下
- 改一个视图只编译该组件 + 相关 composable（Vite HMR 生效）
- 新加视图有明确落点，不用再往 1.5 万行里塞第 13 个 `<main>`

**明确不做**
- 不引入 Pinia 重排状态（336 个 ref 搬家 = 一次全站回归，收益不抵风险）
- 不趁机改视觉（拆分提交里出现 CSS 改动 = 无法判断是谁引起的）
- 不拆 `shared/` 与主进程（那里已经分好了，本轮只管渲染层这个巨型单文件）

---

## 附录：本文行数怎么量的（可复现，2026-10-21 实跑输出）

```bash
cd desktop
wc -l src/renderer/App.vue                                  # 15293
grep -n '^</template>' src/renderer/App.vue                 # 4037 → 模板块 4036 行
grep -n '^</script>'   src/renderer/App.vue                 # 12337 → 脚本段 8298 行
grep -n '^</style>'    src/renderer/App.vue                 # 15293（末行）→ 样式段 2954 行
grep -c '^\s*<main '  src/renderer/App.vue                  # 12 个主视图块
grep -c 'class="overlay"' src/renderer/App.vue              # 24 个浮层
grep -cE '^(async )?function ' src/renderer/App.vue         # 492 个函数
grep -cE '^const \w+ = (ref|computed|reactive)[<(]' src/renderer/App.vue  # 336 个状态声明
grep -c '^\s*// ── ' src/renderer/App.vue                   # 81 个分区标记
```

实跑输出（`wc -l` 与三个 `</...>` 行号）：

```
15293 src/renderer/App.vue
4037: </template>      → 模板块 4036 行（含 24 个浮层）
12337: </script>       → 脚本段 8298 行
15293: </style>       → 样式段 2954 行（末行）
12 个 <main> / 24 个 overlay / 492 个 function / 336 个状态声明 / 81 个分区
```

各视图块的起止行（`grep -n '^\s*<main '` 的行号，块长度 = 下一个起点 - 本起点）：

```
383 active      613 projects    1137 skills    1296 services
1383 trash      1449 blockers    1517 help      1638 todos
1842 logs       2056 launchpad   2563 calendar  2639 roadmap(到 4037，共 1398 行)
```

口径（免得下次有人拿着数字打架）：
- 「模板块 4036 行」= 文件顶（第 1 行）到 `</template>`（第 4037 行），**不是**"模板有多长"—— 24 个浮层都在这段里
- 「脚本段 8298 行」= `<script setup>`(4038) 到 `</script>`(12336)
- 本文第三节的"预算行数"全部按上面实测值估，不按感觉估；真拆的时候以每步提交后的 `wc -l` 为准
