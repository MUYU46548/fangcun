# UI 基座 · token 映射小样（卡 task-20261011-004 第 ② 步）

**未接线**。按门禁「成品布局先看再动手」，先把映射口径与观感给暮雨过目。

| 文件 | 说明 |
|---|---|
| `mapping.html` | 主小样：映射表 + 只吃 `--ui-*` 的组件长相 + 六主题切换 + 错映射反例 |
| `mapping-default.png` | 默认主题（雾灰紫）截图 |
| `mapping-pink.png` | 粉色主题截图 —— 证明切 `data-theme` 时 `--ui-*` 会**自动**跟着变 |

## 口径（小样里在跑的三条）

1. **映射写成 `var()` 链，不复制色值**：`--ui-primary: var(--accent)`。
   切主题只需改 `html[data-theme]`，`--ui-*` 自动重解析 —— 不用 JS，也不会出现
   "主题改了、shadcn 变量忘了改"的分叉。
2. ⚠ **`accent` 两个字、两个意思**（最容易接错的一处）：
   - 方寸 `--accent` = **品牌主色** → `--ui-primary`；
   - shadcn `--ui-accent` = **悬停/次级面** → 对应方寸 `--tint`。
   接错的表现不是"配色不好看"，是**白字压浅染底直接消失**（小样 §② 有并排反例）。
3. **shadcn 没有 success / warning** → 本仓扩展 `--ui-success` / `--ui-warning`
   （方寸的 `.ok/.warning/.danger` 按钮类本来就在用这两个语义色）。

## 色值来源

逐字抄自 `desktop/src/renderer/App.vue` 的 `:root` 与六套 `:root[data-theme='x']`
（**不是编的**）—— 小样若用假色值，看到的观感就是假的。

## 落地时的验收线（待拍板后执行）

- 六套主题**逐套**过 `scripts/test/check-themes.cjs`（它已经在量 13 对 WCAG 对比度）；
- 第 ② 步仍然**不许有观感变化** —— 只是把变量名接上，老样式一个像素不动。
