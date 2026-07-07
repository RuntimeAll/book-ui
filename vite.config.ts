import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { resolve } from 'path'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
// PRD-C-211 系统管理移植：plus-ui 页面用 <svg-icon>/<icon-select>（本地 svg 雪碧图）
import { createSvgIconsPlugin } from 'vite-plugin-svg-icons'

// ---------------------------------------------------------------------------
// V1 卡（题库去原网站化）：proxy 全本地，删 misikt fallback + cookie 注入。
// 所有 /api/* → BOOK_SERVER_TARGET（book-server，端口见下方端口归属注释），axios baseURL='/api'
//   → 客户端 path 形如 '/teacher/qd/note/123'
//   → vite proxy 收到 '/api/teacher/qd/note/123'
//   → rewrite 掉 /api → 转发 '<BOOK_SERVER_TARGET>/teacher/qd/note/123'
//
// 18+ 端点（详见 PRD §3.1）全走本地 — 无白名单/fallback 分支。
// ---------------------------------------------------------------------------

// 🔴 端口归属（2026-07-07 ai-bkb 迁移定版）：新区 = 909x 段（BE :9090 / dev :9091 / toolkit :9093），
//    与旧区 book-ai 809x 并行共存。唯一事实源 = ai-bkb/workspaces.json，改端口先改 registry 再同步此处。
//    历史：旧区 master=A线 BE:8080/dev:5173；master-ai=C线 BE:8090/dev:8091。跨分支合并后必查本段常量（污染坑）。
const BOOK_SERVER_TARGET = 'http://localhost:9090'

// 🗂️ 2026-07-03 归档：AI 编排服务 ai-orchestrator（:8092 组卷）已退役 → _归档代码/ai-orchestrator-C线组卷-2026-07/；
//    组卷职责转 L3 MCP compose_paper（走 :8090 落库）。前端 /ai→:8092 消费者（AI 助手页）2026-06-30 已删。
//    原 AI_ORCHESTRATOR_TARGET 常量 + 下方 `^/ai/` proxy 块一并移除。完整同源副本见 codeplace-A/ai-orchestrator(:8094)。

// 🔴 PRD-C-009：举一反三 agent 跑在 agent-service-toolkit（LangGraph/FastAPI）—— 与
//    ai-orchestrator(:8092) 是两个独立 Python 服务。前端调 /agent/variant/stream → vite proxy
//    rewrite 掉 /agent → 转 <AI_TOOLKIT_TARGET>/variant/stream（toolkit 原生 SSE 协议：
//    data:{type:token|message|...} + data:[DONE]）。同源绕 CORS；toolkit 未设 AUTH_SECRET 故免鉴权。
//    与 /ai(:8092)、/api 三条调用链互不复用拦截器（src/api/variant 独立封装）。
//    🔴 端口归属：ai-bkb 新区 toolkit = :9093（旧区 C线:8093 / A线副本:8095），跨分支合并以目标分支线为准。
const AI_TOOLKIT_TARGET = 'http://localhost:9093'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    UnoCSS(),
    vue(),
    AutoImport({
      resolvers: [ElementPlusResolver()],
      // PRD-C-211：移植的 plus-ui 系统管理页无 import 直接用 ref/useRouter 等（plus-ui 工程约定），
      // 补 vue/vue-router/pinia 预设；book-ui 自有代码显式 import 不受影响。dts 供 vue-tsc。
      imports: ['vue', 'vue-router', 'pinia'],
      dts: 'src/types/auto-imports.d.ts',
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dts: 'src/types/components.d.ts',
    }),
    // PRD-C-211：svg 雪碧图（src/assets/icons/svg，来自 book-admin），menu 页图标选择器用
    createSvgIconsPlugin({
      iconDirs: [resolve(process.cwd(), 'src/assets/icons/svg')],
      symbolId: 'icon-[dir]-[name]',
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 9091,
    proxy: {
      '/api': {
        target: BOOK_SERVER_TARGET,
        changeOrigin: true,
        secure: false,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      // 🗂️ 2026-07-03 归档移除：原 `^/ai/` → AI_ORCHESTRATOR_TARGET(:8092 ai-orchestrator) proxy
      //    随组卷服务归档删除（组卷转 L3 MCP compose_paper）。SPA 路由 /ai-assistant、/ai-variant 不受影响。
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
