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

const BOOK_SERVER_TARGET = 'http://localhost:8080'

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
    port: 5173,
    proxy: {
      '/api': {
        target: BOOK_SERVER_TARGET,
        changeOrigin: true,
        secure: false,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  // 🔴 PRD-A-013 T4 (H-4)：jspdf + html2canvas 切独立 chunk 'pdf-vendor'（≈530KB），
  // 配合 utils/pdf-export.ts 的 dynamic import，首屏 index chunk -500KB。
  // element-vendor 暂不切：element-plus 已由 unplugin-vue-components AutoImport 按需 tree-shake，
  // 强切 vendor chunk 可能反而引入重复或破坏按需导入链，实测后再细调（见 manual.md design 决策）。
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // 🔴 jspdf + html2canvas 合到 pdf-vendor chunk（≈530KB），dynamic import 触发后才下载
          if (id.includes('node_modules/jspdf') || id.includes('node_modules/html2canvas')) {
            return 'pdf-vendor'
          }
          return undefined
        },
      },
    },
  },
})
