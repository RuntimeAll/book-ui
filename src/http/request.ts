import axios from 'axios'
import { ElMessage } from 'element-plus'
import router from '@/router'
import { useUserStore } from '@/store/user'
import { DEFAULT_CLIENT_ID } from '@/api/auth'

// ---------------------------------------------------------------------------
// V1 卡（题库去原网站化）：所有请求统一走本地 book-server（无 misikt fallback）。
//
// 请求拦截器：所有非空 token 的请求统一注入 Authorization Bearer + clientid。
// 响应拦截器双分支按 URL：
//   - /auth/*   → RuoYi 原 envelope { code:200, msg, data } → 返 data
//   - 其他       → misikt envelope { code:1|401|500, message, response }
//                 code===1 → 返 response；code===401 / HTTP 401 → clear store + 跳 /login；
//                 其他 → ElMessage error
//
// 删除：isLocalApi 判断、LOCAL_API_PREFIXES 白名单、misikt fallback、cookie 失效分支。
// ---------------------------------------------------------------------------

// misikt envelope structure: { code: 1=success | 401=unauthorized | 500=error, message: string, response: any }
export interface MisiktEnvelope<T = unknown> {
  code: number
  message: string
  response: T
}

// RuoYi 原生 envelope（仅 /auth/* 用）
interface RuoYiEnvelope<T = unknown> {
  code: number
  msg: string
  data: T
}

const instance = axios.create({
  baseURL: '/api',
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// ---------------------------------------------------------------------------
// Request interceptor — 所有请求统一注入 Authorization Bearer + clientid。
//
// userStore.accessToken 为空时（如登录请求自身）→ 不注入，&& 短路自然跳过。
// ---------------------------------------------------------------------------
instance.interceptors.request.use(
  (config) => {
    const userStore = useUserStore()
    if (userStore.accessToken) {
      config.headers.set('Authorization', `Bearer ${userStore.accessToken}`)
      config.headers.set('clientid', DEFAULT_CLIENT_ID)
    }
    return config
  },
  (error) => Promise.reject(error),
)

// ---------------------------------------------------------------------------
// Response interceptor — 双源 envelope 分支
// ---------------------------------------------------------------------------
function redirectToLogin() {
  const userStore = useUserStore()
  userStore.clear()
  if (router.currentRoute.value.path !== '/login') {
    ElMessage.warning('登录已失效，请重新登录')
    router.push({ path: '/login', query: { redirect: router.currentRoute.value.fullPath } })
  }
}

instance.interceptors.response.use(
  (response) => {
    const url = response.config.url ?? ''

    // 分支 1：RuoYi 原 envelope（/auth/* 直出，未经 MisiktEnvelopeAdvice）
    if (url.startsWith('/auth/')) {
      const data = response.data as RuoYiEnvelope
      if (data.code === 200) {
        return data.data as any
      }
      ElMessage.error(data.msg || `登录接口异常 (code=${data.code})`)
      return Promise.reject(new Error(data.msg || `登录接口异常 (code=${data.code})`))
    }

    // 分支 2：misikt envelope（book-server /teacher/* 被 advice 包装）
    const data = response.data as MisiktEnvelope
    if (data.code === 1) {
      return data.response as any
    }
    if (data.code === 401) {
      redirectToLogin()
      return Promise.reject(new Error('未登录 (401)'))
    }
    // 500 / 其他业务错误
    ElMessage.error(data.message || '系统内部错误')
    return Promise.reject(new Error(data.message || '系统内部错误'))
  },
  (error) => {
    const status: number | undefined = error?.response?.status

    // HTTP 401（Sa-Token 拦下未经 advice 包装）
    if (status === 401) {
      redirectToLogin()
      return Promise.reject(error)
    }

    console.error('[http]', status, error?.response?.data ?? error.message)
    ElMessage.error('网络请求失败，请检查网络连接')
    return Promise.reject(error)
  },
)

export default instance
