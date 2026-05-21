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
        target: 'https://www.misikt.com',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            if (COOKIE_HEADER) {
              proxyReq.setHeader('Cookie', COOKIE_HEADER)
            }
            proxyReq.setHeader('Referer', 'https://www.misikt.com/')
            proxyReq.setHeader('Origin', 'https://www.misikt.com')
          })
        },
      },
    },
  },
})
