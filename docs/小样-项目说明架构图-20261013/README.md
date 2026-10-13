# 项目说明卡 · 架构图小样（2026-10-13）

方案 A 落地后的**可看产物**。目的只有一个：**在施工期把成品布局先给暮雨看**（门禁：圈选方案 ≠ 认可布局）。

## 文件

| 文件 | 说明 |
|---|---|
| `in-card.html` / `in-card.png` | **详情弹窗内嵌形态**：真实弹窗骨架（标题 / 状态 / meta / 正文）+ `buildLayerDiagram` 真输出 |
| `preview.html` / `preview.png` | 六层 SaaS 架构图（纯图，看信息密度与配色） |

⚠ `in-card.html` 是**形态小样**：弹窗骨架按 App.vue 的值近似还原，图是纯函数的真输出，
卡的数据是示例（不是真实卡）。真实接线由 `e2e-renderer-web` 断言（`.arch-svg svg` 真出现）。

## 字段口径（方案 A）

- frontmatter 中文键 **`架构`** ↔ TS 内部 `architecture`，与 `plan` 同款：**值是 JSON 字符串**。
- ⚠ **不许写成 YAML 嵌套映射** —— Python 侧的 YAML 读法读不了嵌套映射（全仓只许 1 处）。
  两侧都做了归一：TS `parseTask` 遇对象 → `JSON.stringify`；Python `render_task` 遇 dict/list →
  `json.dumps` 回标量。`check-render-roundtrip.py` 有两条用例盯死（`arch_json` / `arch_nested`）。
- 值 = `LayerDiagramSpec`：`{lanes:[{name,sub?,color?,cards:[{label,sub?}]}], between?:[], width?, caption?}`

## 颜色

色板只认 App.vue 里**真实存在**的语义令牌：`accent / success / warning / danger / muted`。
⚠ 第一版写了 `--ok` / `--warn` / `--info` —— 方寸主题里没有这三个，SVG 会**静默变黑**。
`e2e-layer-diagram.cjs` 现在会逐个对着 App.vue 复核（改名不同步当场红）。

## 复跑

```bash
node scripts/test/e2e-layer-diagram.cjs     # 纯函数 21 条（含色板 vs App.vue）
node scripts/test/e2e-renderer-web.cjs      # 渲染层：详情里真出现 .arch-svg svg + 坏 JSON 说人话
python scripts/test/check-render-roundtrip.py   # 两侧往返（含 arch 两条）
```
