import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from 'tailwindcss'
import path from 'path'

export default defineConfig({
  plugins: [vue()],
  base: './',
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
  // Tailwind 接线（2026-10-13 卡 20261011-004 第 ① 步）——**PostCSS 内联 + 配置绝对路径**，
  // 照抄司天：不依赖 postcss-load-config 的"就近发现"，免得换了 cwd 就悄悄不生效。
  //
  // ⚠ **刻意不装 autoprefixer**（与司天不同，理由有据）：
  //   实测加了它，产物 CSS 会多出 **22 条** `-webkit-/-moz-/-o-` 前缀（大小 126485 → 126835 字节），
  //   而方寸只跑在 Electron 自带的那一个 Chromium 上（「终态桌面为主」），这些前缀**全是空转**。
  //   代价却是直接的：第 ① 步的验收线就是「产物 CSS 逐字节不变」，装了它就永远过不去。
  //   司天是 Web 应用、要面对多浏览器，方寸不是 —— 抄配置要抄适用的那部分。
  css: {
    postcss: {
      plugins: [
        tailwindcss({ config: path.resolve(__dirname, 'tailwind.config.js') }),
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
    },
  },
  server: {
    // 固定 IPv4：默认 'localhost' 在部分环境只绑 [::1]，而 Electron 解析 localhost
    // 可能落到 127.0.0.1 → 页面 ERR_CONNECTION_REFUSED（2026-09-25 实测）。
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
