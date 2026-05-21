import axios from 'axios'
import { ElMessage } from 'element-plus'
import router from '@/router'

// 防重复跳转标志
let _cookieExpiredRedirecting = false

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

// Request interceptor
instance.interceptors.request.use(
  (config) => config,
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
    console.error('[http]', error?.response?.status, error?.response?.data ?? error.message)
    ElMessage.error('网络请求失败，请检查网络连接')
    return Promise.reject(error)
  },
)

export default instance
