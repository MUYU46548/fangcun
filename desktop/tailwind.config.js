/**
 * Tailwind 配置（2026-10-13 卡 task-20261011-004 第 ① 步；2026-10-14 第 ④ 步扩了一次范围）
 *
 * 抄司天（`SiTian/tailwind.config.js` + `docs/PROPOSAL_DISCLAIMER_AND_UI.md §2.3`），不重新调研。
 *
 * ⚠ **`preflight` 必须关**（硬伤，不是口味）：它会给全仓引入
 *   ① `html { line-height: 1.5 }` —— 本仓从来没有全局 line-height，一引就整体漂移；
 *   ② `ol, ul { list-style: none }` —— Markdown 正文的列表符号会直接消失。
 *
 * ⚠ **`content` 仍不许扫 `App.vue`**（这条是**永久底线**，不是临时限制）。
 *    App.vue 里有 `.fixed` / `.hidden` / `.block` / `.table` 这类**与 Tailwind 工具类同名**的
 *    既有类名，一扫就会凭空生成 `.fixed{position:fixed}` 之类的规则 → 全仓观感漂移
 *    （第 ① 步「产物 CSS 逐字节不变」就是被这个坑破的）。
 *
 * 范围沿革：
 *   第 ①②③ 步 = `./src/renderer/components/ui/**`（只让*新*组件用 utilities，产物只有几行）。
 *   第 ④ 步（2026-10-14，决策视图改版）= 扩到 `./src/renderer/components/**`
 *     —— 承载视图的组合组件 `components/DecisionBoard.vue` 也在里面，它同样只写 utilities。
 *     判据见 `scripts/test/check-ui-base.cjs`（含"每个组件文件都被 content 覆盖"那条）。
 */
module.exports = {
  content: ['./src/renderer/components/**/*.{vue,ts,js}'],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {},
  },
  plugins: [],
}
