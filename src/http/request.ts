import axios from 'axios'
import { ElMessage } from 'element-plus'
import router from '@/router'
import { useUserStore } from '@/store/user'
import { DEFAULT_CLIENT_ID } from '@/api/auth'

// 防重复跳转标志
let _cookieExpiredRedirecting = false

// ---------------------------------------------------------------------------
// 本地 book-server 路由白名单（Y2 卡 2b 波）
//
// 用于：
//   1) 请求拦截器 — 命中本地路径 → 注入 Authorization + clientid header
//      （misikt 路径继续靠 vite proxy 注入的 cookie，不需要 Bearer）
//   2) 响应拦截器 — 401 分支拆开：本地 401 → /login；misikt 401 → /cookie-expired
//
// ⚠️ 维护说明：本数组与 vite.config.ts 的 BOOK_SERVER_PATHS 是同一组路径的两种形态。
//    - vite.config.ts：带 `/api` 前缀（http-proxy-middleware key 需要原始 path）
//    - 本数组：不带 `/api` 前缀（axios baseURL 已为 `/api`，业务侧 config.url 不含 /api）
//    新增 / 变更本地端点时，两处务必同步。
//    (TODO Y3 起若同步频度高，可考虑提到 src/http/route-config.ts 让 vite.config.ts 也 import)
// ---------------------------------------------------------------------------
const LOCAL_API_PREFIXES = [
  '/auth/login',
  '/teacher/user/current',
  '/teacher/question/lazyTree',
  '/teacher/question/page',
  '/teacher/question/select/',
  '/teacher/question/addBasket/',
  '/teacher/question/cancel/',
  '/teacher/question/queryBasket',
  '/teacher/question/empty',
  '/teacher/question/basketNum',
  '/teacher/question/genExamData/',
] as const

function isLocalApi(url: string): boolean {
  return LOCAL_API_PREFIXES.some((p) => url.startsWith(p))
}

// misikt envelope structure: { code: 1=success | 401=unauthorized | 500=error, message: string, response: any }
export interface MisiktEnvelope<T = unknown> {
  code: number
  message: string
  response: T
}

const instance = axios.create({
  baseURL: '/api',
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// ---------------------------------------------------------------------------
// Request interceptor — 本地后端注入 Authorization + clientid（Y2 卡 2b 波）
//
// 只对走 book-server 的 path 注入 Bearer token，misikt path 不动（保留 cookie 鉴权）。
// /auth/login 自身命中本数组，但登录时 userStore.accessToken 为空，&& 短路自然跳过，
// 不会污染登录请求的 header。
// ---------------------------------------------------------------------------
instance.interceptors.request.use(
  (config) => {
    const url = config.url ?? ''
    if (isLocalApi(url)) {
      const userStore = useUserStore()
      if (userStore.accessToken) {
        config.headers.set('Authorization', `Bearer ${userStore.accessToken}`)
        config.headers.set('clientid', DEFAULT_CLIENT_ID)
      }
    }
    return config
  },
  (error) => Promise.reject(error),
)

// ---------------------------------------------------------------------------
// Response interceptor — 双源 envelope 分支（Y2 卡 PRD §3.2 / §3.3）
//
// 分支判断走 response.config.url 的前缀：
//   - /auth/*   → book-server RuoYi 原生 envelope { code: 200, msg, data }
//                 code===200 → 返 data；否则 ElMessage 报错 + reject
//   - 其余       → misikt envelope { code: 1|401|500, message, response }
//                 （book-server 的 /teacher/* 端点已被 MisiktEnvelopeAdvice 包装成这种形态）
//                 code===1 → 返 response；code===401 → 跳 cookie-expired；其他报错
//
// 注意：axios 的 response.config.url 是业务侧调用时传的原始 path（未拼 baseURL），
//       例如调 request.post({ url: '/auth/login' }) 时 config.url === '/auth/login'。
// ---------------------------------------------------------------------------

// RuoYi 原生 envelope（仅 /auth/* 用）
interface RuoYiEnvelope<T = unknown> {
  code: number
  msg: string
  data: T
}

instance.interceptors.response.use(
  (response) => {
    const url = response.config.url ?? ''

    // 分支 1：RuoYi 原生 envelope（book-server /auth/* 直出，未经 MisiktEnvelopeAdvice）
    if (url.startsWith('/auth/')) {
      const data = response.data as RuoYiEnvelope
      if (data.code === 200) {
        return data.data as any
      }
      ElMessage.error(data.msg || `登录接口异常 (code=${data.code})`)
      return Promise.reject(new Error(data.msg || `登录接口异常 (code=${data.code})`))
    }

    // 分支 2：misikt envelope（misikt 原生 + book-server /teacher/* 被 advice 包装）
    const data = response.data as MisiktEnvelope
    if (data.code === 1) {
      // success — return inner response payload
      return data.response as any
    }
    if (data.code === 401) {
      // Y2 卡 2b 波：401 按来源拆开
      //   - 本地 book-server（被 MisiktEnvelopeAdvice 包装）→ 跳 /login + 清登录态
      //   - misikt 原生 → 跳 /cookie-expired 提示用户更新 cookie
      if (isLocalApi(url)) {
        const userStore = useUserStore()
        userStore.clear()
        if (router.currentRoute.value.path !== '/login') {
          ElMessage.warning('登录已失效，请重新登录')
          router.push({ path: '/login', query: { redirect: router.currentRoute.value.fullPath } })
        }
        return Promise.reject(new Error('本地后端未登录 (401)'))
      }
      if (!_cookieExpiredRedirecting) {
        _cookieExpiredRedirecting = true
        ElMessage.warning('misikt cookie 已失效，正在跳转到更新指引...')
        setTimeout(() => {
          router.push('/cookie-expired').finally(() => {
            _cookieExpiredRedirecting = false
          })
        }, 800)
      }
      return Promise.reject(new Error('未登录 (401)'))
    }
    // 500 or other error codes
    ElMessage.error(data.message || '系统内部错误')
    return Promise.reject(new Error(data.message || '系统内部错误'))
  },
  (error) => {
    const url: string = error?.config?.url ?? ''
    const status: number | undefined = error?.response?.status

    // Y2 卡 2b 波：本地后端 HTTP 401（Sa-Token 直接拦下，未经 advice 包装）
    if (status === 401 && isLocalApi(url)) {
      const userStore = useUserStore()
      userStore.clear()
      if (router.currentRoute.value.path !== '/login') {
        ElMessage.warning('登录已失效，请重新登录')
        router.push({ path: '/login', query: { redirect: router.currentRoute.value.fullPath } })
      }
      return Promise.reject(error)
    }

    console.error('[http]', status, error?.response?.data ?? error.message)
    ElMessage.error('网络请求失败，请检查网络连接')
    return Promise.reject(error)
  },
)

export default instance
