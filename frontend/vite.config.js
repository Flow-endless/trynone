import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    /* 构建产物在 frontend/dist，请按需复制到 src/main/resources/static，避免覆盖 CDN 版入口 */
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
  server: {
    port: 5173,
    proxy: {
      '^/(chat|generateCode|processText|clearHistory|study|write|analyze|plan)': {
        target: 'http://localhost:8081',
        changeOrigin: true,
      },
    },
  },
})
