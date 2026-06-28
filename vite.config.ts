import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { resolve } from 'path'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

// ---------------------------------------------------------------------------
// V1 卡（题库去原网站化）：proxy 全本地，删 misikt fallback + cookie 注入。
// 所有 /api/* → BOOK_SERVER_TARGET（book-server，端口见下方端口归属注释），axios baseURL='/api'
//   → 客户端 path 形如 '/teacher/qd/note/123'
//   → vite proxy 收到 '/api/teacher/qd/note/123'
//   → rewrite 掉 /api → 转发 '<BOOK_SERVER_TARGET>/teacher/qd/note/123'
//
// 18+ 端点（详见 PRD §3.1）全走本地 — 无白名单/fallback 分支。
// ---------------------------------------------------------------------------

// 🔴 端口归属（跨分支合并时以目标分支线为准）：master = A 线 → BE :8080 / dev :5173；
//    master-ai = C 线 → BE :8090 / dev :8091。目录+端口双隔离。
const BOOK_SERVER_TARGET = 'http://localhost:8090'

// 🔴 PRD-C-004：AI 编排服务 ai-orchestrator（Python/FastAPI）。端口归属：A 线(master-A)=:8094 / C 线=:8092。
//    前端调 /ai/chat → vite proxy rewrite 掉 /ai → 转 <AI_ORCHESTRATOR_TARGET>/chat。
//    走同源避免浏览器直连跨端口 CORS。ai-orchestrator 返回裸 JSON（非 misikt envelope），
//    所以聊天调用独立封装（src/api/chat），不复用 /api 那套 misikt 拦截器。
const AI_ORCHESTRATOR_TARGET = 'http://localhost:8092'

// 🔴 PRD-C-009：举一反三 agent 跑在 agent-service-toolkit（LangGraph/FastAPI）—— 与
//    ai-orchestrator(:8092) 是两个独立 Python 服务。前端调 /agent/variant/stream → vite proxy
//    rewrite 掉 /agent → 转 <AI_TOOLKIT_TARGET>/variant/stream（toolkit 原生 SSE 协议：
//    data:{type:token|message|...} + data:[DONE]）。同源绕 CORS；toolkit 未设 AUTH_SECRET 故免鉴权。
//    与 /ai(:8092)、/api 三条调用链互不复用拦截器（src/api/variant 独立封装）。
//    🔴 端口归属：A 线副本(codeplace-A/agent-service-toolkit)=:8095 / C 线=:8093，跨分支合并以目标分支线为准。
const AI_TOOLKIT_TARGET = 'http://localhost:8093'

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
      // 🔴 用正则 `^/ai/`（带尾斜杠）而非裸 `/ai` 前缀 —— 否则 vite 前缀匹配会把 SPA 路由
      //    /ai-assistant、/ai-variant 也吞进 proxy（/ai-variant → 转 :8092 → 404 detail:Not Found）。
      //    `^/ai/` 只命中 /ai/chat 这类真接口，不误伤 /ai-* 页面路由（直连/刷新也不再 404）。
      '^/ai/': {
        target: AI_ORCHESTRATOR_TARGET,
        changeOrigin: true,
        secure: false,
        rewrite: (p) => p.replace(/^\/ai/, ''),
      },
      // 🔴 PRD-C-009 举一反三 agent（toolkit :8093）。同样用 `^/agent/` 防误吞未来 /agent-* 路由。
      '^/agent/': {
        target: AI_TOOLKIT_TARGET,
        changeOrigin: true,
        secure: false,
        rewrite: (p) => p.replace(/^\/agent/, ''),
      },
    },
  },
  // 🔴 PRD-A-013 T4 (H-4)：jspdf + html2canvas 切独立 chunk 'pdf-vendor'（≈530KB），
  // 配合 utils/pdf-export.ts 的 dynamic import，首屏 index chunk -500KB。
  // element-vendor 暂不切：element-plus 已由 unplugin-vue-components AutoImport 按需 tree-shake，
  // 强切 vendor chunk 可能反而引入重复或破坏按需导入链，实测后再细调（见 manual.md design 决策）。
  build: {
    // 🔴 2026-06-21：vite 默认压缩器(esbuild/oxc)会破坏 KaTeX lexer → `\circ` 被错切成 `\c`
    //   → 所有 `^\circ`(度数)在 prod 崩(dev 不压缩故正常=「本地正常线上挂」)。换 terser(公认最稳)修。
    //   验证：terser 构建后 prod 母题题面 ∠/⊥/° 全渲染、katex_err=0。
    minify: 'terser',
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
