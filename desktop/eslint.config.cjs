/**
 * ESLint 配置 · A1a 阶段（2026-11-17）
 *
 * ## 本阶段只做一件事
 *
 * **出一份真实的违规清单**，不改任何界面代码、不挂进 `build`、不拦提交。
 * 所以规则一律是 `warn` 而不是 `error` —— 这个文件现在的产出是「事实」，不是「门槛」。
 *
 * ## 为什么先 warn 再决定（暮雨的 A1a / A1b 拆分）
 *
 * 上一笔体检量出：方寸有 471 个裸 `<button>`、16 个项目 0 个有 eslint。
 * 但**误报率未知**，没量就上 `error` = 让构建长期变红，那正是本仓反复踩的「没量就上」。
 *
 * ## 两条实测踩到的坑（都写进注释，防下次重踩）
 *
 * ① **vue 插件必须显式注册**（`plugins: { vue }`）：flat config 里
 *    `vue/no-restricted-syntax` 不会因为装了 `eslint-plugin-vue` 就自动带上插件对象。
 * ② **`.vue` 与 `.ts` 要各自给 parser**：本仓 `.vue` 全是 `<script setup lang="ts">`，
 *    默认 espree 会在 `defineProps<{ ctl: any }>()` 上直接 parse error。
 *    实测后果：58/59 个文件全军覆没，违规只剩 23 条（而真值是 675 条）——**假绿的典型形状**。
 *
 * ## ⚠ 本仓用 TypeScript 7，而 typescript-eslint 只支持 <6.1
 *
 * typescript-eslint 会**主动拒绝**加载 TS 7（不是警告，是抛错）：
 *   `typescript-eslint does not support TS 7.0.`
 * 官方建议的并行方案是把 `typescript` 降到 6.x。实测 TS 6.0.3 下
 * `tsc -p tsconfig.main.json --noEmit` 零错误，可以走 —— 但这是**降级项目工具链**，
 * 属于要人拍板的事，不该由我顺手做掉。
 *
 * ## 用法
 *
 *   cd desktop && npx eslint src/renderer --format json -o ../.fe-lint.json
 *   node ../scripts/fe-lint-report.cjs .fe-lint.json     # 汇总成事实清单
 */
const js = require('@eslint/js')
const vue = require('eslint-plugin-vue')
const tseslint = require('typescript-eslint')

/** 这些不是"要治理的界面"，不该被"不许手搓"约束 */
const IGNORE = [
  'src/renderer/components/ui/**',   // 基座组件本来就是原生控件的封装
  'dist/**',
  'node_modules/**',
]

/** 浏览器全局（不穷举 = 噪声；这里只列渲染层真用到的） */
const BROWSER_GLOBALS = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  localStorage: 'readonly', console: 'readonly', setTimeout: 'readonly',
  clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  fetch: 'readonly', URL: 'readonly', Event: 'readonly', MouseEvent: 'readonly',
  KeyboardEvent: 'readonly', HTMLElement: 'readonly', Element: 'readonly',
  Node: 'readonly', getComputedStyle: 'readonly', requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly', ResizeObserver: 'readonly',
  MutationObserver: 'readonly', IntersectionObserver: 'readonly',
  CustomEvent: 'readonly', Blob: 'readonly', File: 'readonly', FileReader: 'readonly',
  FormData: 'readonly', location: 'readonly', history: 'readonly',
  performance: 'readonly', structuredClone: 'readonly', queueMicrotask: 'readonly',
  HTMLInputElement: 'readonly', HTMLTextAreaElement: 'readonly', HTMLSelectElement: 'readonly',
  CSS: 'readonly', Image: 'readonly', AbortController: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly', crypto: 'readonly',
}

module.exports = [
  { ignores: IGNORE },
  js.configs.recommended,

  // ── .vue：模板用 vue-eslint-parser，<script> 再交给 TS parser ──────────
  ...vue.configs['flat/base'],
  {
    files: ['**/*.vue'],
    plugins: { vue },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: BROWSER_GLOBALS,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module', parser: tseslint.parser },
    },
  },

  // ── 独立 .ts：必须单独给 parser（否则 31 个 .ts 全部 parse error）─────
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: BROWSER_GLOBALS,
    },
  },

  // ── 规则（对 .vue 与 .ts 都生效）────────────────────────────────────
  {
    files: ['**/*.{js,mjs,cjs,vue,ts}'],
    rules: {
      // 核心目标：不许手搓原生控件（A1 要治的病）
      //
      // ⚠⚠ 2026-11-17 实测到的**重大误报**（这条不写清，下一个人一定会重踩）：
      //   `VElement[name="button"]` 匹配的是 vue-eslint-parser 的**规范化标签名**，
      //   而它会把 `<Button>` 也规范成 `button` —— 于是**已经用了基座的组件被报"裸 button"**。
      //   现场：`DecisionBoard.vue` 源码里 `<button` **0 个**、`<Button` 18 个，
      //   却被报 20 条（18 个 Button + 2 个真 select）。642 条里有一大批是这种假阳性。
      //   修法：加 `[rawName="button"]` —— rawName 保留源码原样大小写，只命中真正的小写原生标签。
      'vue/no-restricted-syntax': ['warn', {
        selector: 'VElement[name="button"][rawName="button"]',
        message: '裸 <button>：请用 components/ui/Button.vue（若确实不是操作按钮，加理由豁免）',
      }, {
        selector: 'VElement[name="select"][rawName="select"]',
        message: '裸 <select>：请用基座；无对应变体则先补基座',
      }],
      // 硬编码颜色（"换主题就崩"的根源）
      'no-restricted-syntax': ['warn', {
        selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
        message: '硬编码颜色：请走 CSS 令牌（var(--xxx)）',
      }],
      // 与本次治理无关的噪声源一律关掉（格式类规则会把真问题淹没）
      'vue/multi-word-component-names': 'off',
      'no-unused-vars': 'off',   // TS 在管，eslint 版更吵且重复
      'no-undef': 'off',         // 全局表不可能穷举，开它就是噪声
      'no-empty': 'off',
      'no-irregular-whitespace': 'off',
    },
  },
]
