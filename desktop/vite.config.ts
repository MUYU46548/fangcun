import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
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
