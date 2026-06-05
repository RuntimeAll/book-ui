import axios from 'axios'

// ---------------------------------------------------------------------------
// PRD-C-004 — AI 编排聊天入口（ai-orchestrator :8092 /chat）
//
// 🔴 独立 axios 实例，不复用 @/http/request：
//   - 那套 baseURL='/api' 且响应拦截器按 misikt envelope { code:1, response } 拆包；
//   - ai-orchestrator 返回的是裸 JSON { ok, route, intentEcho, ... }，没有 misikt 信封，
//     若走 misikt 拦截器会被当作业务错误（code!==1）误判。
//
// 走 vite proxy：baseURL='/ai' → rewrite 掉 /ai → http://localhost:8092/chat（同源，绕 CORS）。
// 单轮即走，不带鉴权头（ai-orchestrator 组卷调用已配免登录）；teacherId 走 body 透传。
// ---------------------------------------------------------------------------

const aiInstance = axios.create({
  baseURL: '/ai',
  // LLM 路由 + 组卷链路较慢，给足超时（思考模型 + 真库出卷）。
  timeout: 120000,
  headers: {
    'Content-Type': 'application/json',
  },
})

/** /chat 请求体 */
export interface ChatRequest {
  message: string
  teacherId?: number
}

/** 组卷结果里的单题（outline / paper.questions 结构按后端契约宽松接收） */
export interface ChatPaperQuestion {
  id?: number | string
  stem?: string
  content?: string
  questionType?: string
  type?: string
  [k: string]: unknown
}

/** 组卷结果里的卷子对象 */
export interface ChatPaper {
  id?: number | string
  paperId?: number | string
  title?: string
  name?: string
  questions?: ChatPaperQuestion[]
  [k: string]: unknown
}

/**
 * /chat 响应（三态合一，按 T1 契约）：
 *   组卷命中: { ok:true, route:'compose', intentEcho, paperId, outline, paper, paperUrl, notes }
 *   兜底澄清: { ok:true, needAsk:true, ask, route:null }
 *   异常    : { ok:false, error }
 */
export interface ChatResponse {
  ok: boolean
  route?: string | null
  intentEcho?: string
  needAsk?: boolean
  ask?: string
  paperId?: number | string
  outline?: unknown
  paper?: ChatPaper
  paperUrl?: string
  notes?: string
  error?: string
  [k: string]: unknown
}

/**
 * 调 ai-orchestrator /chat。
 * 返回裸响应体（成功/needAsk/异常三态都在 body 里，由调用方按 ok / needAsk 分流）。
 */
export async function postChat(payload: ChatRequest): Promise<ChatResponse> {
  const { data } = await aiInstance.post<ChatResponse>('/chat', payload)
  return data
}
