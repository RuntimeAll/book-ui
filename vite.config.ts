import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { resolve } from 'path'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

// ---------------------------------------------------------------------------
// V1 卡（题库去原网站化）：proxy 全本地，删 misikt fallback + cookie 注入。
// 所有 /api/* → http://localhost:8080（book-server），axios baseURL='/api'
//   → 客户端 path 形如 '/teacher/qd/note/123'
//   → vite proxy 收到 '/api/teacher/qd/note/123'
//   → rewrite 掉 /api → 转发 'http://localhost:8080/teacher/qd/note/123'
//
// 18+ 端点（详见 PRD §3.1）全走本地 — 无白名单/fallback 分支。
// ---------------------------------------------------------------------------

// 🔴 C 线（AI 编排）独立 FE：proxy 指向 C 线后端 :8090（master-ai，含 AI 组卷/落库接口），
//    dev 端口 8091（贴着 C BE 8090）。与 A 线 book-ui(:5173→:8080) 目录+端口双隔离。
const BOOK_SERVER_TARGET = 'http://localhost:8090'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    UnoCSS(),
    vue(),
    AutoImport({
      resolvers: [ElementPlusResolver()],
    }),
    Components({
      resolvers: [ElementPlusResolver()],
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 8091,
    proxy: {
      '/api': {
        target: BOOK_SERVER_TARGET,
        changeOrigin: true,
        secure: false,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})
