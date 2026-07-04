import axios, { type AxiosResponse } from 'axios'
import JSONbig from 'json-bigint'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/store/user'
import { DEFAULT_CLIENT_ID } from '@/api/auth'
import { useLoginDialog } from '@/composables/useLoginDialog'

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

// PRD-A-013 T2 — json-bigint 解析器（storeAsString: true 模式只把超 MAX_SAFE_INTEGER
// 的数值字段转 string，小整数 / 浮点 / BigDecimal 保留 number 语义不动），用在
// axios transformResponse 上拦截 19 位雪花 ID 的 JSON 精度截断。
const jsonBigParser = JSONbig({ storeAsString: true })

const instance = axios.create({
  baseURL: '/api',
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
  // PRD-A-013 T2 — 用 json-bigint 替代默认 JSON.parse，避免 BE 切真雪花后
  // 19 位 ID（>2^53）末位精度被截。非 string 响应（blob/arraybuffer）原样返。
  // 解析失败 catch 兜底返原数据（防极端 BE 非 JSON 响应把整个拦截器炸掉）。
  transformResponse: [
    (data) => {
      if (typeof data !== 'string') return data
      try {
        return jsonBigParser.parse(data)
      } catch {
        return data
      }
    },
  ],
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
  // PRD-C-212 增量：独立 /login 页已下线，登录态失效改为原地弹登录框
  // （登录成功整页 reload 当前页，会话内数据自然重拉；弹窗自身幂等，重复调用不叠加）
  const userStore = useUserStore()
  userStore.clear()
  ElMessage.warning('登录已失效，请重新登录')
  useLoginDialog().open()
}

instance.interceptors.response.use(
  (response) => {
    const url = response.config.url ?? ''

    // 分支 1：RuoYi 原 envelope（/auth/* 与 /system/*：未经 MisiktEnvelopeAdvice，code===200）
    // PRD-C-204：/system/dict/** 走字典(题型/难度/来源 SSOT)，是 RuoYi 原生 envelope，并入本分支。
    if (url.startsWith('/auth/') || url.startsWith('/system/')) {
      const data = response.data as RuoYiEnvelope
      if (data.code === 200) {
        // PRD-A-013 T3 — 拦截器自身没泛型上下文（axios v1 fulfill 类型签名要求返
        // AxiosResponse），业务约定让拦截器返"解包后的 T"而不是 response 全体 —
        // 这是 axios v1 类型的已知 hack：`as unknown as AxiosResponse` 强转配
        // request.post<T, R> 调用方泛型推断，把 R 当真返回类型用。
        return data.data as unknown as AxiosResponse
      }
      // PRD-C-212 D5 — 游客态 401 静默（未白名单的 /system 读，如个别字典）
      if (data.code === 401 && !useUserStore().accessToken) {
        return Promise.reject(new Error('未登录 (401)'))
      }
      ElMessage.error(data.msg || `登录接口异常 (code=${data.code})`)
      return Promise.reject(new Error(data.msg || `登录接口异常 (code=${data.code})`))
    }

    // 分支 2：misikt envelope（book-server /teacher/* 被 advice 包装）
    const data = response.data as MisiktEnvelope
    if (data.code === 1) {
      // PRD-A-013 T3 — 同上，axios v1 fulfill 类型 hack
      return data.response as unknown as AxiosResponse
    }
    if (data.code === 401) {
      // PRD-C-212 D5 — 游客态（本就没 token）：漫游页挂着的个人化子请求（收藏态/篮子/笔记）
      // 401 是预期，静默 reject 不弹 toast 不跳登录，由页面自行忽略；登录态失效才走引导
      if (!useUserStore().accessToken) {
        return Promise.reject(new Error('未登录 (401)'))
      }
      redirectToLogin()
      return Promise.reject(new Error('未登录 (401)'))
    }
    // 500 / 其他业务错误
    // 🔴 PRD-A-014 G7 踩出：misikt envelope 错误用 message 字段，但 RuoYi 原生异常体（如
    // ServiceException 并发拒绝）是 {code:500, msg:...} —— 只认 message 会把"已有导出任务正在进行"
    // 这类可操作文案吞成泛化"系统内部错误"。两种 envelope 都兜。
    const errMsg = data.message || (data as unknown as { msg?: string }).msg || '系统内部错误'
    ElMessage.error(errMsg)
    return Promise.reject(new Error(errMsg))
  },
  (error) => {
    // PRD-A-013 T5 M-10 — 列表竞态防护：上一个请求被 AbortController 主动 cancel，
    // 不弹 toast、不打 error 日志（用户切章节是正常行为不该报错）。
    // useAbortableRequest.run() 已在业务侧把该错吞掉返 null，此处只做拦截器级静默兜底。
    if (axios.isCancel(error) || error?.code === 'ERR_CANCELED') {
      return Promise.reject(error)
    }

    const status: number | undefined = error?.response?.status

    // HTTP 401（Sa-Token 拦下未经 advice 包装）
    if (status === 401) {
      // PRD-C-212 D5 — 游客态静默（同上 envelope 401 分支）
      if (!useUserStore().accessToken) {
        return Promise.reject(error)
      }
      redirectToLogin()
      return Promise.reject(error)
    }

    console.error('[http]', status, error?.response?.data ?? error.message)
    ElMessage.error('网络请求失败，请检查网络连接')
    return Promise.reject(error)
  },
)

export default instance
