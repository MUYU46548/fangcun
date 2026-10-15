# `components/` —— UI 基座落点

- `ui/` = shadcn-vue 口径的基础件（Button / Badge / Card / Input + `cn.ts`）
- 上一级 = 承载视图的组合组件（如 `DecisionBoard.vue`）

2026-10-13 起，方寸接 UI 基座（卡 `task-20261011-004`，跨项目已拍板：**shadcn-vue + Tailwind CSS**）。

## 纪律（照抄司天，别再重新设计）

- **轮子区禁手搓**：面板 / 对话框 / 下拉 / 菜单 / Tooltip / Tabs / 开关 —— 一律先找 shadcn（底层 `reka-ui`）；
  找不到才手搓，且必须在提交信息里写明理由（本卡第 ⑤ 步的退出条件）。
- **造轮子区必须自研**：产品本身的 Canvas 编辑器之类，不套组件库。
- **老 CSS 一律不动**：`App.vue` 是 13000+ 行单文件，全量重写 = 自找回归。
- **App.vue 里一行 utilities 都不写**：`tailwind.config.js` 的 `content` **不许扫 App.vue** ——
  它里面有 `.fixed`/`.hidden`/`.block` 这类与工具类**同名**的老类名，一扫就凭空生成规则。
  新界面一律切成组件，放进 `components/` 里用 utilities。

## 为什么 `tailwind.config.js` 的 `content` 只扫 `components/`

`App.vue` 里有 `.fixed` / `.hidden` / `.block` / `.table` 这类**与 Tailwind 工具类同名**的老类名 ——
一旦扫它，就会凭空多出 `.fixed{position:fixed}` 之类的规则，第 ① 步「产物 CSS 逐字节不变」当场破功。
第 ④ 步逐个换控件时，新界面写在 `components/` 下的组件里，**App.vue 本身仍然不扫**。
（判据：`check-ui-base.cjs` —— 每个 glob 必须落在 `src/renderer/components/` 内、且不匹配 App.vue，
并且 `components/` 下**每个**源码文件都被覆盖到。）

## 当前进度

| 步 | 内容 | 状态 |
|---|---|---|
| ① | 装 + 接线（**零观感回归**） | ✅ 完成（产物 CSS 逐字节不变） |
| ② | token 映射（`:root` → `--ui-*`，六套主题逐套过 `check-themes`） | ✅ 完成（`var()` 链，见 App.vue 的「UI 基座 ②」块） |
| ③ | 只让新组件用 utilities | ✅ 完成（`components/**` 只出工具类，App.vue 仍是老 CSS） |
| ④ | 逐个换手搓控件 | **进行中**：① 决策视图（`DecisionBoard.vue`，2026-10-14 含「按项目筛选 / 项目字段 / 贴一句话自动拆字段」）；② 任务卡右键菜单（`TaskCardMenu.vue`）。下一单候选：`.overlay` 模态 → Dialog；`ctx-other`（日志 / 待办菜单）→ 同一个 ContextMenu |
| ⑤ | 退出条件：新交互先找 shadcn | 进行中（已成文，见上「纪律」） |

## 已落地的基础件

| 文件 | 说明 |
|---|---|
| `ui/cn.ts` | `clsx` + `tailwind-merge`。**必须过它** —— 否则"组件默认类 vs 使用方覆盖类"谁赢取决于产物里的规则顺序，属静默错版 |
| `ui/Button.vue` | cva 变体：`primary / outline / ghost / danger` × `sm / md / icon`；颜色走 `--ui-*` |
| `ui/Badge.vue` | 三态徽章：`ok / revoked / merged / neutral`，色取 App.vue 的 `--badge-*` 令牌（**由 check-themes 量对比度**） |
| `ui/Card.vue` | 边框 + 14px 圆角 + 卡面 + `shadow-sm` 档投影（**不用**弹窗那档 `--shadow`） |
| `ui/Input.vue` | 手写 `modelValue`/`update:modelValue`（不用 `defineModel` —— 渲染层由 vite 打包不过 tsc） |
| `../DecisionBoard.vue` | 决策视图（reka-ui Tabs + 上面四个基础件）。测试钩子走 `data-dec="…"` |
| `../TaskCardMenu.vue` | 任务卡右键菜单（reka-ui `ContextMenu`）—— **不产生包裹元素**，卡片 DOM 与布局不动 |

## 第 ② 步的口径（别再重新设计）

`App.vue` 里有一块 `:root { --ui-*: var(--方寸令牌) }`，**只有一份、只写 `var()` 链、不复制色值** ——
切 `data-theme` 时 `--ui-*` 自动重解析。最容易接错的是 `accent` 两个字两个意思：

- 方寸 `--accent`（品牌主色） → `--ui-primary`
- shadcn `--ui-accent`（悬停/次级面） → 方寸 `--tint`

接错不是"不好看"，是**白字压浅染底直接消失**。另外 shadcn 没有 success / warning，
本仓扩了 `--ui-success` / `--ui-warning`。这些都已被 `check-ui-base.cjs` 钉死（含方向断言）。

## 踩过的坑（新写组件前先读）

1. **`reka-ui` 的 TabsTrigger 只认 `mousedown`**（源码里只有 `onMousedown`，没有 click 处理）。
   合成 `.click()` 点了等于没点 —— 真用户点鼠标天然先有 mousedown，所以**只在测试里翻车**。
   e2e 里要 `dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`。
2. **`ContextMenuRoot` 不产生包裹 DOM**（`PopperRoot` 只渲染 slot + Teleport）—— 包一张卡不会改变
   flex/grid 的父子关系。代价：`v-for` / `:key` 要挪到包裹组件上，`v-show` 留在卡片自己身上。
3. **`preflight` 关着 ⇒ 原生控件（`button` / `input` / `select`）必须自己写 `font-[inherit]`**
   （外加 `border-0 bg-transparent` 之类外观兜底）。不写就是**系统 UI 字体 + UA 默认边框**：
   屏幕上"这块字跟旁边不是一个字体"，而**所有断言全绿**。2026-10-14 连踩两次、都靠截图目检才发现；
   现由 `check-ui-base.cjs` 拦一道（**文件级**判据，一个文件里只兜底一部分它抓不住）。
4. **`--shadow`（0 8px 32px）是弹窗那档**，别用在列表卡上；列表卡用 `shadow-sm` 档。
5. 组件里的**文字色不要写死在组件里**：提成 App.vue 的令牌，否则 `check-themes` 量不到，
   掉到 AA 以下也没人拦（2026-10-13「色板名写了却不存在 → SVG 整体变黑、断言全绿」同款死法）。
6. ⚠ **菜单项样式别跟 App.vue 的老规则重名**：`.ctx-menu button`（特异性 0,1,1）会压过工具类（0,1,0）。
   新菜单的内容根只保留 `class="ctx-menu"` 作**测试钩子**（真 Electron 那套 e2e 按它选元素），
   老规则已收窄到 `.ctx-other`。
