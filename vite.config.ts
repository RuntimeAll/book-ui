import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { resolve } from 'path'
import { readFileSync, existsSync } from 'fs'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

// Build cookie header string from cookie.json (only used in dev proxy, never exposed to browser)
function buildCookieHeader(): string {
  const cookiePath = resolve(__dirname, '../../workplace/PRD/2026-05-20-B-question-crud-scaffold/cookie.json')
  if (!existsSync(cookiePath)) {
    console.warn('[proxy] cookie.json not found, proxy will run without auth cookies')
    return ''
  }
  try {
    const cookies: Array<{ name: string; value: string }> = JSON.parse(readFileSync(cookiePath, 'utf-8'))
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch {
    console.warn('[proxy] Failed to parse cookie.json')
    return ''
  }
}

const COOKIE_HEADER = buildCookieHeader()


// ---------------------------------------------------------------------------
// 双源路由配置（Y2 卡 PRD §3.1 路由表）
// 白名单 → http://localhost:8080 (book-server, 无 cookie / Bearer 鉴权)
// 其余 /api/* → https://www.misikt.com (保留 cookie + Referer + Origin 注入)
// ---------------------------------------------------------------------------

// 走 book-server :8080 的 /api 子路径白名单（带 trailing slash 的代表"路径前缀锁定"）
const BOOK_SERVER_PATHS = [
  '/api/auth/login',
  '/api/teacher/user/current',
  '/api/teacher/question/lazyTree',
  '/api/teacher/question/page',
  '/api/teacher/question/select/',
  '/api/teacher/question/addBasket/',
  '/api/teacher/question/cancel/',
  '/api/teacher/question/queryBasket',
  '/api/teacher/question/empty',
  '/api/teacher/question/basketNum',
  '/api/teacher/question/genExamData/',
] as const

const BOOK_SERVER_TARGET = 'http://localhost:8080'
const MISIKT_TARGET = 'https://www.misikt.com'

interface ProxyEntry {
  target: string
  changeOrigin: boolean
  secure: boolean
  rewrite?: (path: string) => string
  configure?: (proxy: any) => void
}

function buildProxyConfig(): Record<string, ProxyEntry> {
  const proxy: Record<string, ProxyEntry> = {}

  // 1. 白名单优先：每个 path 占一个 key，命中后 rewrite 去掉 /api 前缀 → 走 book-server
  //    （book-server 端点是 /auth/login / /teacher/xxx 形式，不带 /api 前缀）
  for (const path of BOOK_SERVER_PATHS) {
    proxy[path] = {
      target: BOOK_SERVER_TARGET,
      changeOrigin: true,
      secure: false,
      rewrite: (p) => p.replace(/^\/api/, ''),
      // 走 book-server 不注入 cookie / Referer / Origin（这是 misikt 专属）
    }
  }

  // 2. 兜底：其余 /api/* 走 misikt，保留旧的 cookie + Referer + Origin 注入
  //    vite/http-proxy-middleware 按 key 插入顺序匹配，/api 放最后命中 fallback
  proxy['/api'] = {
    target: MISIKT_TARGET,
    changeOrigin: true,
    secure: false,
    configure: (proxy: any) => {
      proxy.on('proxyReq', (proxyReq: any) => {
        if (COOKIE_HEADER) {
          proxyReq.setHeader('Cookie', COOKIE_HEADER)
        }
        proxyReq.setHeader('Referer', 'https://www.misikt.com/')
        proxyReq.setHeader('Origin', 'https://www.misikt.com')
      })
    },
  }

  return proxy
}

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
    proxy: buildProxyConfig(),
  },
})
