# `components/ui/` —— UI 基座（shadcn-vue 组件落点）

2026-10-13 起，方寸接 UI 基座（卡 `task-20261011-004`，跨项目已拍板：**shadcn-vue + Tailwind CSS**）。

## 纪律（照抄司天，别再重新设计）

- **轮子区禁手搓**：面板 / 对话框 / 下拉 / 菜单 / Tooltip / Tabs / 开关 —— 一律先找 shadcn 组件；
  找不到才手搓，且必须在提交信息里写明理由（本卡第 ⑤ 步的退出条件）。
- **造轮子区必须自研**：产品本身的 Canvas 编辑器之类，不套组件库。
- **老 CSS 一律不动**：`App.vue` 是 12000+ 行单文件，全量重写 = 自找回归。

## 为什么 `tailwind.config.js` 的 `content` 只扫这个目录

`App.vue` 里有 `.fixed` / `.hidden` / `.block` / `.table` 这类**与 Tailwind 工具类同名**的老类名 ——
一旦扫它，就会凭空多出 `.fixed{position:fixed}` 之类的规则，第 ① 步「产物 CSS 逐字节不变」当场破功。
第 ④ 步逐个换控件时，再把对应文件加进 `content`（那时是有意改动，diff 属预期）。

## 当前进度

| 步 | 内容 | 状态 |
|---|---|---|
| ① | 装 + 接线（**零观感回归**） | 进行中 |
| ② | token 映射（`:root` → `--ui-*`，六套主题逐套过 `check-themes`） | 未开始 |
| ③ | 只让新组件用 utilities | 未开始 |
| ④ | 逐个换手搓控件（`ctx-menu` → DropdownMenu；`.overlay` 模态 → Dialog；…） | 未开始 |
| ⑤ | 退出条件：新交互先找 shadcn | 未开始 |
