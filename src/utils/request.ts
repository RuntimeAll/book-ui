/**
 * PRD-C-211 系统管理移植 —— plus-ui 风格 request（独立 axios 实例）。
 *
 * 🔴 与 book-ui 自己的 `@/http/request` 并行、互不干扰：
 *   - 那条链会把 /system envelope 拆成 data.data 返回（book-ui 业务页约定）；
 *   - 本条链保留 RuoYi 整个 envelope（{code,msg,rows,total,data}），移植来的
 *     系统管理页面写死 res.rows / res.total / res.data，必须吃整包。
 * 改自 codeplace-B/book-admin/src/utils/request.ts，最小删改：
 *   - token/clientid 改从 book-ui 的 user store（localStorage 持久化）取；
 *   - 删 i18n Content-Language、删 AES/RSA 加密链（C 线未开 VITE_APP_ENCRYPT）；
 *   - 401 处理改走 book-ui 登录页跳转。
 */
import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { ElLoading, ElMessage, ElNotification } from 'element-plus'
import type { LoadingInstance } from 'element-plus/es/components/loading/src/loading'
import FileSaver from 'file-saver'
import { useUserStore as useBookUserStore } from '@/store/user'
import { DEFAULT_CLIENT_ID } from '@/api/auth'
import { tansParams, blobValidate } from '@/utils/ruoyi'
import cache from '@/plugins/cache'
import { HttpStatus } from '@/enums/RespEnum'
import { errorCode } from '@/utils/errorCode'
import { useLoginDialog } from '@/composables/useLoginDialog'

let downloadLoadingInstance: LoadingInstance
// 是否已在跳登录（防多请求并发重复弹）
export const isRelogin = { show: false }

function getToken(): string {
  return useBookUserStore().accessToken
}

export const globalHeaders = () => {
  return {
    Authorization: 'Bearer ' + getToken(),
    clientid: DEFAULT_CLIENT_ID,
  }
}

const service = axios.create({
  baseURL: import.meta.env.VITE_APP_BASE_API ?? '/api',
  timeout: 50000,
  headers: { 'Content-Type': 'application/json;charset=utf-8' },
  transitional: { clarifyTimeoutError: true },
})

// 请求拦截器（保留 plus-ui 的 isToken/repeatSubmit 头协议）
service.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const isToken = config.headers?.isToken === false
    const isRepeatSubmit = config.headers?.repeatSubmit === false
    if (getToken() && !isToken) {
      config.headers['Authorization'] = 'Bearer ' + getToken()
      config.headers['clientid'] = DEFAULT_CLIENT_ID
    }
    // get 请求映射 params 参数
    if (config.method === 'get' && config.params) {
      let url = config.url + '?' + tansParams(config.params)
      url = url.slice(0, -1)
      config.params = {}
      config.url = url
    }
    if (!isRepeatSubmit && (config.method === 'post' || config.method === 'put')) {
      const requestObj = {
        url: config.url,
        data: typeof config.data === 'object' ? JSON.stringify(config.data) : config.data,
        time: new Date().getTime(),
      }
      const sessionObj = cache.session.getJSON('sessionObj')
      if (sessionObj === undefined || sessionObj === null || sessionObj === '') {
        cache.session.setJSON('sessionObj', requestObj)
      } else {
        const s_url = sessionObj.url
        const s_data = sessionObj.data
        const s_time = sessionObj.time
        const interval = 500 // 小于此间隔视为重复提交
        if (s_data === requestObj.data && requestObj.time - s_time < interval && s_url === requestObj.url) {
          const message = '数据正在处理，请勿重复提交'
          console.warn(`[${s_url}]: ` + message)
          return Promise.reject(new Error(message))
        } else {
          cache.session.setJSON('sessionObj', requestObj)
        }
      }
    }
    // FormData 数据去请求头 Content-Type
    if (config.data instanceof FormData) {
      delete config.headers['Content-Type']
    }
    return config
  },
  (error: unknown) => Promise.reject(error),
)

function redirectToLogin() {
  if (isRelogin.show) return
  isRelogin.show = true
  const store = useBookUserStore()
  store.clear()
  ElMessage.warning('登录已失效，请重新登录')
  // PRD-C-212 增量：独立 /login 页已下线，原地弹登录框（登录成功整页刷新当前页）
  useLoginDialog().open()
  isRelogin.show = false
}

// 响应拦截器 —— 返回整个 RuoYi envelope（res.rows/res.total/res.data 语义保留）
service.interceptors.response.use(
  (res: AxiosResponse) => {
    const code = res.data.code || HttpStatus.SUCCESS
    const msg = errorCode[code] || res.data.msg || errorCode['default']
    if (res.request.responseType === 'blob' || res.request.responseType === 'arraybuffer') {
      return res.data
    }
    if (code === 401) {
      redirectToLogin()
      return Promise.reject('无效的会话，或者会话已过期，请重新登录。')
    } else if (code === HttpStatus.SERVER_ERROR) {
      ElMessage({ message: msg, type: 'error' })
      return Promise.reject(new Error(msg))
    } else if (code === HttpStatus.WARN) {
      ElMessage({ message: msg, type: 'warning' })
      return Promise.reject(new Error(msg))
    } else if (code !== HttpStatus.SUCCESS) {
      ElNotification.error({ title: msg })
      return Promise.reject('error')
    } else {
      return Promise.resolve(res.data)
    }
  },
  (error: { message?: string }) => {
    let { message } = error
    if (message == 'Network Error') {
      message = '后端接口连接异常'
    } else if (message?.includes('timeout')) {
      message = '系统接口请求超时'
    } else if (message?.includes('Request failed with status code')) {
      message = '系统接口' + message.substr(message.length - 3) + '异常'
    }
    ElMessage({ message: message, type: 'error', duration: 5 * 1000 })
    return Promise.reject(error)
  },
)

// 通用下载方法（proxy.download('system/user/export', {...}, 'user.xlsx')）
export function download(url: string, params: unknown, fileName: string) {
  downloadLoadingInstance = ElLoading.service({ text: '正在下载数据，请稍候', background: 'rgba(0, 0, 0, 0.7)' })
  return service
    .post(url, params, {
      transformRequest: [(p: unknown) => tansParams(p)],
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      responseType: 'blob',
    })
    .then(async (resp: unknown) => {
      const isBlobOk = blobValidate(resp)
      if (isBlobOk) {
        const blob = new Blob([resp as BlobPart])
        FileSaver.saveAs(blob, fileName)
      } else {
        const blob = new Blob([resp as BlobPart])
        const resText = await blob.text()
        const rspObj = JSON.parse(resText)
        const errMsg = errorCode[rspObj.code] || rspObj.msg || errorCode['default']
        ElMessage.error(errMsg)
      }
      downloadLoadingInstance.close()
    })
    .catch((r: unknown) => {
      console.error(r)
      ElMessage.error('下载文件出现错误，请联系管理员！')
      downloadLoadingInstance.close()
    })
}

export default service
