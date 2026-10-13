/**
 * Tailwind 配置（2026-10-13，卡 task-20261011-004 第 ① 步）
 *
 * 抄司天（`SiTian/tailwind.config.js` + `docs/PROPOSAL_DISCLAIMER_AND_UI.md §2.3`），不重新调研。
 *
 * ⚠ **`preflight` 必须关**（硬伤，不是口味）：它会给全仓引入
 *   ① `html { line-height: 1.5 }` —— 本仓从来没有全局 line-height，一引就整体漂移；
 *   ② `ol, ul { list-style: none }` —— Markdown 正文的列表符号会直接消失。
 *
 * ⚠ **`content` 现在只扫 `components/ui/`**（第 ③ 步口径：只让*新*组件用 utilities，老 CSS 一律不动）。
 *    这一条同时是第 ① 步的验收线：**产物 CSS 必须逐字节不变**。
 *    为什么不能直接扫 App.vue —— 它里面有 `.fixed` / `.hidden` / `.block` / `.table` 这类**与 Tailwind
 *    工具类同名**的既有类名，一扫就会凭空多出 `.fixed{position:fixed}` 之类的规则 → 零 diff 直接破功。
 *    等第 ④ 步真的往老控件上换 utilities 时，再逐个把文件加进 content（那时是有意改动，diff 属预期）。
 */
module.exports = {
  content: ['./src/renderer/components/ui/**/*.{vue,ts,js}'],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {},
  },
  plugins: [],
}
