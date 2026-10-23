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
| 3 | calendar **第一步：只抽状态与算法** → `renderer/composables/useCalendar.ts`（184 行） | 见提交 | 0（模板这步不动） | **129**（净 −103） | **15943** | renderer-web 686/0 · e2e-renderer 312/0 |


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
> 下一步（第 4 块）才是把日历模板搬进 `views/CalendarView.vue`，用 emit 把三个副作用上抛。

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
