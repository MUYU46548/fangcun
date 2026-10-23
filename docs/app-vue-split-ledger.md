# App.vue 拆分账本

> 方案在 `docs/plan-app-vue-split.md`（2026-10-21 · 只出方案不拆）。
> 本文件按方案「第 0 步」要求建：**每步一行**，每步一个提交、可单独回滚。
>
> **红线**：任何一次拆分都不许顺带改功能。要改功能另开一笔提交 ——
> 否则红了分不清是"搬坏了"还是"改坏了"。

## 基线

| 项 | 值 |
|---|---|
| 快照 tag | `split-baseline-20261022`（指向 `0e0ec30`） |
| App.vue 行数 | **15877** |
| 说明 | 方案里写的是 10-21 的 15293 行；本轮（10-22）加了问答页、四栏、纠偏、出单，基线已涨。**以本表为准。** |

## 已拆

| # | 块 | 提交 | 移出模板 | 移出脚本 | App.vue 剩余 | 验证 |
|---|---|---|---|---|---|---|
| 1 | help（帮助手册 → `renderer/views/HelpView.vue`） | `86152d7` | **123** | 0 | **15754** | renderer-web 659/0 · e2e-renderer 312/0 · 模板绑定/IPC 对账全绿 |
| 2 | blockers（阻塞源 → `renderer/views/BlockersView.vue`） | 见提交 | **47**（+ `statusClass` 抽到 `shared/status.ts`） | 0 | **15733** | renderer-web 661/0 · e2e-renderer 312/0 |
| 3 | calendar **第一步：只抽状态与算法** → `renderer/composables/useCalendar.ts`（184 行） | `e7cddd8` | 0（模板这步不动） | **129**（净 −103） | **15943** | renderer-web 686/0 · e2e-renderer 312/0 |
| 4 | calendar **第二步：模板搬成组件** → `renderer/views/CalendarView.vue`（75 行模板 + props/emit） | `e097dac` | **75** | 27（`onCalDrop`→`doCalReschedule`、`openLogById`；`localPriority`/`priorityLabel` 抽到 `shared/priority.ts`） | **15850**（净 −93） | renderer-web 688/0 · e2e-renderer 312/0 |
| 5 | services（服务/端口 → `renderer/views/ServicesView.vue`，85 行模板 + 118 行脚本） | `31106cf` | **85** | **118**（整块搬：状态 + loadServices + 三个动作 + 快照文案） | **15655**（净 −195） | renderer-web 688/0 · e2e-renderer 312/0 |
| 6 | skills（技能安装专区 → `renderer/views/SkillsView.vue`，157 行模板 + 434 行脚本） | `0030cae` | **157** | **434**（整块搬：清单 / 装到 Hermes / 导入外部技能 / 装到别的 agent / MCP 接入材料） | **15132**（净 −523） | renderer-web 695/0（+7）· e2e-renderer 312/0 |

| 7 | roadmap（路线图 → `renderer/views/RoadmapView.vue`，52 行模板 + 46 行脚本） | `871c9de` | **52** | **33**（4 个状态/函数整块搬；顺手清掉阻塞视图留下的 4 个死 computed + 2 个 import） | **15047**（净 −85） | renderer-web 700/0（+5）· e2e-renderer 312/0 |

| 8 | trash（回收站 → `renderer/views/TrashView.vue`，视图 64 行 + 两个弹窗 51 行 + 脚本 240 行） | `f035f70` | **115** | **240**（列表/搜索/还原/彻底删除/多选批量/按日期清理/正文预览）+ `renderBody` 抽到 `renderer/markdown.ts` | **14655**（净 −392） | renderer-web 710/0（+7）· e2e-renderer 312/0 |

| 9 | todos **第一步：只抽状态与逻辑** → `renderer/composables/useTodos.ts`（398 行） | 见提交 | 0（模板这步不动） | **327**（净 −327，另抽出 prefs / dirtyGuard / isOverdue 三个共享件） | **14281** | renderer-web 719/0 · e2e-renderer 312/0 |

| 10 | todos **第二步：模板搬成组件** → `renderer/views/TodosView.vue`（170 行：模板 + 一个 `ctl` prop） | `324a041` | **123** | 34（`todoViewCtl` —— 把 useTodos 的返回值与四个父组件能力打包成一个 reactive 对象） | **14192**（净 −89） | renderer-web 727/0 · e2e-renderer 312/0 · 六守卫全绿 |
> **第 9 块为什么只能先抽 composable**：`todos` 这一个 ref 被 App.vue **60 处**共用
> （日历、在途一屏、日志转待办、快速记、项目统计都读它）。直接搬模板就得把这些全变成 props/emit。
> 先按日历那套分两步：状态与动作收进 composable（零行为变化、整层可回归），
> 下一步才是把模板搬成 `views/TodosView.vue`（那时只需要「传一个 todos 进去」）。
>
> **顺手修的守卫假阳性**：模板里 `tripHiddenNotPicked.map(h => h.name)` 的 `h`，
> 一直因为脚本某处恰好有 `const h = await …todosHealth()` 被当成"已声明"。
> 那段脚本搬走后，守卫才报「模板引用了未声明：h」—— 报的不是真问题，是"巧合被移走了"。
> 已让 `check-template-bindings` 把**模板表达式里的箭头形参**和 v-for 的 locals 同等对待。
>
> **覆盖率缺口 → 已补**：抽完先做反例，发现把 `filteredTodos` 的「只看未完成」整段注释掉，
> 719 条里**一条都没红** —— 待办的**筛选 / 排序 / 统计**三条路径此前零断言
> （勾选、撤销、多选、编辑弹窗、指派时间都有）。
> 已补 8 条（统计口径 共3/未完成2/已完成1、逾期单独算、筛选未完成/已完成、切回全部、
> 排序「优先级从高到低」、遮住条数 + 清除筛选），renderer-web **719 → 727**。
> 反例复验：再注释掉那句过滤 → **精确 2 条红**。
> ⚠ 补的时候踩了一次：断言块插在待办段中间，收尾 `setTodos([])` 把后面「网格/编辑弹窗/勾选写回」
> 一整套的前提清空了（706/16）。改成**备份 + 还原**，并把整块挪到待办段**末尾**才稳。

> **第 8 块纠正了第 5 块那次估错**：当时按"视图 64 行"判断 trash 低耦合，实则它是
> **一个完整功能**（两个弹窗 + 240 行脚本 + 散在别处的多选状态）。这次按真实总量整块搬。
>
> **顺手抽出的共享件**：`renderBody`（markdown→安全 HTML）搬到 `renderer/markdown.ts`。
> 回收站正文预览要用它，任务详情/日志正文也在用 —— 各写一套就会出现"同一段正文
> 两个地方渲染不一样"，而 XSS 白名单是最容易漂的那部分。
>
> **测试洞（第四次，同一型）**：`trashRead` 桩从 09-26 就有、`rec` 也一直在记，
> 但**没有任何断言点过卡片** —— "点了没反应 / 读不出正文 / markdown 没渲染" 三种坏法都不会被发现。
> 已补 7 条（真调 trashRead 且传**文件名**不是 id、弹窗元信息、markdown 真渲染成 h1、遮罩关闭）。
> 其中遮罩那条踩了一次**真空通过**：弹窗没开时 `!$('#trash-preview-modal')` 恒真 → 已加 `pvOpened` 前置。
>
> ⚠ **顺带发现的一个系统性缺口**：`npm run build` 只 tsc 了 main / cli，**渲染层（.vue）完全没有类型检查**
> （仓里没装 vue-tsc）。这就是为什么 `parseCalDate` 那种「只在某条点击路径才炸」的错误只能靠真点击发现。
> 要不要加 vue-tsc 是独立决定（新依赖 + 首跑会吐一堆历史错），先记在这里不擅自加。

> **第 7 块：真·最干净的一块，但同样挖出测试洞**。52 行模板、零弹窗、零跨视图状态、
> 唯一交互是页内「⟳ 刷新」。搬它只花了一次替换。
>
> ⚠ 顺手清掉第 2 块留下的**死代码**：`totalBlockedTasks` / `blockerImpact` / `blockerAdvice` /
> `blockerImpactById` 四个 computed 在 App.vue 里已经零引用（模板早就不在了），
> 连同 `computeBlockerImpact` / `BlockerImpact` 两个 import 一起删。
> **为什么守卫没抓到**：`check-template-bindings` 查的是「模板引用了没定义的东西」和
> 「定义了但零引用」—— 这四个互相引用（A 用 B），所以每一个都有"引用"，凑成一个自循环死簇。
> 拆组件时该顺手核一遍父文件里还有没有 `xxxById` / `xxxAdvice` 这类派生量。
>
> **测试洞（和 blockers / MCP 同型，第三次了）**：假 preload 的 `aggregateRoadmap`
> 恒返回 `{ projects: [] }` → 路线图页在测试里永远停在「暂无路线图数据」→
> 项目/批次/任务/下一步**四种渲染逻辑一条都没被验过**。已补真夹具 + 5 条断言。
> （规律已经很清楚了：**凡是桩返回空数组的地方，那一整块渲染就等于没测**。）

> **第 6 块为什么不切两半**：技能页看着有五个分区（清单 / Hermes / 外部导入 / 别的 agent / MCP），
> 但它们共用同一份状态（`skillsList` / `skillsTargets` / `agentTargets` / `mcpTargets`），
> 切开就得把这些状态提到父组件再传下去 —— 那不是解耦，是把耦合搬到 props 上。
> 整块搬之后，父组件只给四个**能力**（toast / copy / pulse / dragAlive），一个业务数据都不传。
>
> ⚠ `pulse` 与 `dragAlive` 必须由父组件给：拖拽心跳是 todo / log / skills 三个投放区**共用**的。
> 在这一页自己造一份，会出现"那边拖完、这边遮罩还留着"。
>
> **顺手补了一个真洞（和 blockers 那次同型）**：假 preload 里**连 `mcpInfo` 都没有** →
> `typeof t.mcpInfo !== 'function'` 恒真 → MCP 接入区在任何测试里都是空的，拆坏了也没人知道。
> 已补 4 个桩（mcpInfo / mcpSnippet / mcpSelfInstall / mcpOpenConfig）+ 7 条断言。
>
> **同时修掉一处"界面说假话"**：`loadMcpInfo` 在通道缺失时把错误置成空串，于是界面永远停在
> 「检测中…」—— 那不是检测中，是根本读不到。现在两处（别的 agent / MCP）都改成三态：
> 读失败 → 明说原因；还在读 → 检测中；读到但为空 → 「本机没检测到…，不是还在检测」。





> **第 3 块为什么只抽 composable、没搬模板（这是方案原话，不是偷懒）**：
> 方案对 calendar 的处置就是「先抽 `composables/useCalendar.ts`，再搬组件」。
> 实测为什么必须分两步 —— 日历有三个**副作用出口**（`onCalEventClick` 要 openCard / openLog，
> `onCalDrop` 要 window.tegula + toast + loadTodos/loadLogs），还挂着一个「指派时间」弹窗
> （`calAssign_` 的状态在 App.vue、弹窗模板也在 App.vue）。一步搬完＝把副作用一起卷进去，
> 那就是"边拆边改行为"。
>
> 这一步的边界划得很硬：
> · **进 composable**：所有 `cal*` 状态 + 日期算法 + 折叠/翻月/拖拽"记住拖的是谁"（纯逻辑）；
> · **留在 App.vue**：`calAssign_` 与三个弹窗函数、`onCalEventClick` / `onCalDrop`（副作用）；
> · `onCalDragStart` 只记本地变量 → 进 composable；落盘那半留父组件，靠 `takeDrag()` 交接
>   （"取一次就清空"，一次 drop 只该改一张卡）。
>
> ⚠ 行数对比别直接和上面的 15733 比：这一轮中间还加了「想法」页（+309），
> 拆前实际是 **16046**，拆完 **15943**。
>
> **第 5 块为什么是 services 而不是 trash（估错过一次，记下来）**：
> 上一轮我按"模板行数"估 trash 最低耦合（视图只有 64 行），**量完才发现估错了** ——
> trash 还挂着「按日期清理」和「正文预览」两个弹窗、批量选择状态散在 6088 行，
> 总量约 340 行模板 + 270 行脚本，是**一个完整功能块**，不是一块视图。
> services 反过来：引用全在 1451-1535（模板）+ 7836-7953（脚本），零弹窗、零跨视图状态，
> 唯一外部能力是 `showToast`（用 prop 注入）。**教训：估耦合要看"这一页挂着几个弹窗、状态散在几处"，
> 不能只看视图模板多少行。**

> **第 4 块（模板搬成组件）的边界**：组件只做「显示 + 收集意图」，五个动作全部 emit 上抛：
> `assign-task` / `assign-todo`（开「指派时间」弹窗，弹窗模板还在 App.vue）、
> `reschedule`（组件算"改到哪天"，IPC + toast + 重新加载留父组件）、
> `open-card` / `open-log`（点条目）。
>
> 组件**自己调 `useCalendar`**（接收 `tasks`/`todos`/`logs` 三个 prop），App.vue 不再 import 它 ——
> 否则得把 20 多个返回值当 props 传下去。`<main id="board" class="calendar-view">` 这层壳留在
> 组件根上：视图互斥与几何断言都按 `#board.calendar-view` 选，换成 div 要改一堆断言。
>
> ⚠ `taskStart` / `taskDue` 在 App.vue 里**又定义了一份小的**（弹窗要用）。这不算重复实现：
> 两处都是同一句 `parseCalDate(t.start ?? t.fm.start)`，而且必须同口径 —— 各写一套的话，
> 日历画出来的时间和弹窗里显示的时间迟早对不上。

> **第 2 块换了顺序（有依据，不是随手改）**：方案原定第 2 块是 calendar。
> 实测它的依赖面比方案预估的大 —— 20+ 个 `cal*` 状态，还要 tasks / todos / logs
> 与四个弹窗（指派时间 / 编辑日志 / 打开卡片），硬拆必然"边拆边改行为"，撞方案红线。
> 而 blockers 只吃一个数据源、派生全是 `shared/blockers.ts` 的纯函数、**零交互**，
> 是真正意义上的低耦合。方案自己的原则是"从耦合最低的开始"，顺序表只是初判。
>
> **顺手发现的一个洞**：假 preload 的 `getBlockerChains` 一直返回 `[]`，
> 于是"阻塞页里有没有东西"从来没被断言覆盖过 —— 拆组件时页是空的也照样全绿。
> 已补真夹具 + 两条内容断言（链卡片 / 计数 / 关键路径建议 / unlock 数字）。


| 11 | logs（执行日志 → `renderer/views/LogsView.vue`，287 行 = 212 行模板 + 16 个 `toRef` + 39 个动作） | `3fe5231` | **212** | 41（`logsViewCtl`） | **14020**（净 −172） | renderer-web 749/0（+7）· e2e-renderer 312/0 · 七守卫全绿 |
> **第 10 块：为什么是「一个 reactive prop」而不是 40 个 props**。
> 这一块要 14 个状态 + 17 个动作 + 6 个能力（右键菜单 / 撤销已转出 / 转日志确认 / 指派日期 / 拖入导入 / 拖拽高亮）。
> 逐个绑会在 App.vue 挤成一大片，而漏一个的后果是**点了没反应**（与 2026-09-22「启动台 + 添加应用」
> 那个 ReferenceError 同型，界面毫无提示）。所以父组件把 `useTodos()` 的返回值 + 那几个能力
> 用 `reactive()` 包成一个对象，作为唯一 prop `ctl` 传下去。
>
> **`reactive()` 不是修饰，是必需**：`useTodos()` 返回的是一堆 ref，直接当 prop 传进子组件时，
> 模板**不会**自动解包（解包只作用于 `<script setup>` 顶层绑定）。不包一层的话下拉框会显示成
> `[object Object]`、`ctl.todoBatchMode` 恒为真。reactive 的属性访问才解包，子组件的写法才能与原来逐字一致。
>
> **`todoViewCtl` 必须放在 App.vue 文件末尾**：`todoDragOver` 是 `const computed`，在前面构建对象会撞
> TDZ（`Cannot access before initialization`）。函数声明会提升，`const` 不会 —— 你把它往上挪"看着整齐"，
> 启动就是白屏。
>
> **`todoDueTitle` 忘传，当场被 `check-template-bindings` 的「死函数」抓到**：模板里 `main.todos-view`
> 搬走之后，App.vue 里这个函数就零引用了；而组件里 `ctl.todoDueTitle` 是 undefined，
> **任何带到期日的待办一渲染就抛**。守卫抓到的正是"模板搬走了、能力没跟着走"这一类漏。
> 这条纪律记下：搬模板时，凡组件里写了 `ctl.X`，X 就必须真的出现在那个对象里 —— 搬完照着组件里
> 的 `ctl.*` 逐个对一遍，比等运行时白屏快得多。

> **第 11 块（logs）：模板一字未改，靠 `toRef` 把父组件的状态接成顶层绑定**。
> 待办那一步是父侧 `reactive()` + 子侧 `const ctl = props.ctl`，模板里全写 `ctl.xxx`（改了几百处）；
> 日志 212 行模板里绑定名出现上百次，手改必错。改用两段式接法：
>   · **状态**（含 computed）→ `toRef(ctl, 'x')`：读写都落在父组件的 reactive 代理上，`v-model` 能写回、
>     派生值跟着源头变。**直接解构不行** —— 解构拿到的是当时的快照。
>   · **动作**（函数）→ 直接解构：函数不是 ref，不需要响应式。
> 结果：模板逐字保留，diff 只有「缩进 −2」和「`v-if` 移到组件标签上」两条。
>
> **日志弹窗一个都没搬**，这是硬边界：日志编辑框 / 接力框 / 清理归档框必须能在**任何视图**下打开 ——
> 从日历点一条日志就会调 `openLog`，那时 `curView` 不是 `logs`；弹窗若跟着组件走，就被组件的 `v-if`
> 挡在外面，用户点了**什么也不会发生**（最阴的一类 bug：没有报错、没有红、只是没反应）。
> 只搬 `<main class="logs-view">` 这一层，App.vue 里留一行 `<LogsView v-if="curView === 'logs'" :ctl="…" />`，
> 且**保持 `v-if`**（改成 `v-else-if` 会被上面两个 `.overlay` 截断链，2026-10-14 实测：「弹窗开着 = 日志页空白」）。
>
> **这一步顺手补了两个守卫的覆盖率**（否则拆分等于把防线剪短一截）：
>   · `check-button-styles` 新增 ⑤：`views/*.vue` 里的按钮 class 也必须有规则。9 个组件约 900 行模板搬出去后，
>     组件里把 `.todo-del` 敲成 `.todo-delete` **没有任何东西会红** —— 表现正是本守卫最初要抓的
>     「按钮退回 Chromium 默认样式」。反例：注入 `class="ghost bogus-xyz"` → 精确报出 `.bogus-xyz`。
>   · `check-template-bindings`：多行解构里的 `//` 分组注释会跟**紧跟其后的那个名字**粘成一坨 → 判它「未声明」。
>     LogsView 的 5 组注释正好误报 5 个名字（全是每组第一个）。先剥行注释再 split。
>
> **桩 `logsList` 原来是 `() => store.logs.slice()`** —— 不看 filter、不记账。于是「搜索词有没有进 IPC」
> 「筛选有没有生效」全验不到：界面能打字、能选下拉，但传了什么完全看不见。已照抄主进程 `listLogs` 的
> 过滤语义 + `rec`，并补 7 条断言（搜索进 query、真过滤、清空复原、排序写回）。
> 反例：把 `toRef` 改成 `let` 快照 → 恰好 6 条红（新增 3 条 + 3 条原有排序断言，同一通道）。

## 拆分纪律（从方案抄来，贴在账本里免得每次翻文档）

1. **先搬视图，不动状态** —— 336 个 `ref` 里绝大多数是"某视图的局部状态 + 几个 handler"，
   按 Pinia 重排等于同时改状态归属与渲染路径，红了分不清是谁。
2. **纯模板抽离**只对"输入输出少"的视图（help / calendar / trash / blockers / services）。
3. 一步一个提交；`git revert <sha>` 必须能单独撤销。
4. **样式不跟着走**：全局 `<style>` 目前留在 App.vue，组件不带 scoped 样式 ——
   所以拆分**像素不变**。等视图搬得差不多再整体评估样式怎么切。
5. 每步跑 **renderer-web（无头 DOM）+ e2e-renderer（真 Electron 真点击）** 两层，
   拆视图最容易坏的是"视图互斥链"和"entry 点不到"。

## 回滚

```
git revert <该步提交 sha>     # 只撤这一步
git reset --hard split-baseline-20261022   # 整批退回基线（会丢后续所有拆分）
```
