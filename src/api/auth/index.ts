import request from '@/http/request'

/**
 * RuoYi-Vue-Plus /auth/login 默认 clientId。
 *
 * 后续如需多客户端区分，应改为从 import.meta.env.VITE_CLIENT_ID 读取。
 * 当前 FE 端硬编码作为 2a 波兜底（PRD §3.2 + §6 低风险 — 后续可改 env）。
 */
export const DEFAULT_CLIENT_ID = 'e5cd7e4891bf95d1d19206ce24a7b32e'

/** 默认租户 ID — RuoYi-Vue-Plus 单租户模式约定为 000000。 */
export const DEFAULT_TENANT_ID = '000000'

/** 密码模式登录的 grantType。 */
export const GRANT_TYPE_PASSWORD = 'password'

export interface LoginPayload {
  username: string
  password: string
  clientId: string
  tenantId: string
  grantType: string
  /** PRD-A-005 T1 — 图形验证码值（captchaEnabled=true 时必传，false 时可省） */
  code?: string
  /** PRD-A-005 T1 — 验证码 uuid（与 code 配对，BE 拿它定位 Redis 里的答案） */
  uuid?: string
}

/**
 * PRD-A-005 T1 — GET /auth/code 返回（若依内置，RuoYi 原 envelope，已被拦截器拆出 data 段）。
 * captchaEnabled=false 时 BE 不下发 img/uuid，FE 据此隐藏验证码控件、提交不带 code/uuid。
 */
export interface CaptchaResult {
  /** 验证码开关；false 时无需展示/传验证码 */
  captchaEnabled: boolean
  /** base64 图片（不含 data: 前缀，需自行拼 `data:image/gif;base64,`）；关时可能缺省 */
  img?: string
  /** 本次验证码 uuid，提交时回传 */
  uuid?: string
}

/**
 * GET /auth/code — 拉图形验证码（若依内置）。走 RuoYi 原 envelope，
 * request.ts 拦截器 `/auth/` 分支已剥 envelope，直接返回 data 段（CaptchaResult）。
 */
export const getCaptcha = () =>
  request.get<CaptchaResult, CaptchaResult>('/auth/code')

/**
 * RuoYi /auth/login 成功响应的 data 段（外层 envelope 已被 request.ts 拦截器拆掉）。
 * 字段对齐 PRD §3.2。
 */
export interface LoginResult {
  access_token: string
  expire_in: number
  refresh_token?: string
  client_id?: string
  scope?: string
}

/**
 * POST /auth/login — 走 book-server :8080（vite proxy 白名单），RuoYi 原生 envelope。
 *
 * request.ts 拦截器 `/auth/` 分支已剥 envelope，直接返回 data 段（LoginResult）。
 */
export const login = (payload: LoginPayload) =>
  request.post<LoginResult, LoginResult>('/auth/login', payload)
