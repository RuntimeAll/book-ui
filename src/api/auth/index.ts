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
}

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
