import request from '@/http/request'

export interface PingResponse {
  code: number
  msg: string
  data: {
    captchaEnabled?: boolean
    uuid?: string
    img?: string
    [key: string]: unknown
  }
}

/** Ping book-server 公开端点（/auth/code 验证码，无需鉴权）验证联通 */
export function pingBackend() {
  return request.get<PingResponse>('/auth/code', {
    baseURL: (import.meta.env.VITE_API_BASE_URL as string).replace(/\/api$/, ''),
  })
}
