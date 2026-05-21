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

// Response interceptor — handle misikt envelope
// misikt always returns HTTP 200; errors are in envelope.code
instance.interceptors.response.use(
  (response) => {
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
