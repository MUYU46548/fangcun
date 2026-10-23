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
| 5 | services（服务/端口 → `renderer/views/ServicesView.vue`，85 行模板 + 118 行脚本） | 见提交 | **85** | **118**（整块搬：状态 + loadServices + 三个动作 + 快照文案） | **15655**（净 −195） | renderer-web 688/0 · e2e-renderer 312/0 |




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
