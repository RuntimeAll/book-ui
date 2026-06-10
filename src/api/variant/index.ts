import { fetchEventSource } from '@microsoft/fetch-event-source'

// ---------------------------------------------------------------------------
// PRD-C-009 — 图片举一反三 agent（agent-service-toolkit :8080，LangGraph）SSE 封装。
//
// 与 src/api/chat（ai-orchestrator :8092）是两套独立协议，不复用：
//   - 走 vite proxy /agent/variant/stream → rewrite 掉 /agent → :8080/variant/stream。
//   - toolkit 原生 SSE 协议（见 service.py message_generator）：
//       data: {"type":"token",  "content":"<片段>"}            ← LLM 逐字（打字机）
//       data: {"type":"message","content":<ChatMessage 全量>}  ← 节点产出的整块 AI 消息
//       data: {"type":"error",  "content":"<错误>"}
//       data: [DONE]                                            ← 流结束（🔴 非 JSON，单独判）
//   - variant agent 全部用 AIMessage 文本沟通（DNA 外显 / 题组带 ✓⚠ / 反问 / 入库回执都在
//     message.content 文本里），无 custom_data，所以前端做成「聊天式」逐块渲染即可。
//
// 多轮记忆 = thread_id（toolkit checkpointer）。同一会话内所有 send 复用同一 thread_id，
// agent 才记得住「当前题组」，老师的每句话才是对题组的一条编辑指令。刷新换新 thread。
//
// 图片入口：母题图先传 OSS 拿公网 URL，把 URL 写进消息文本发出去（agent 端 _extract_image_url
// 从最近一条 human 文本里抠 URL）。toolkit 未设 AUTH_SECRET，故本调用不带鉴权头。
// ---------------------------------------------------------------------------

/** /variant/stream 请求体（toolkit StreamInput 子集） */
export interface VariantRequest {
  message: string
  /** 多轮会话标识；同会话复用 = agent 记住当前题组。省略则 toolkit 新开一轮。 */
  thread_id?: string
  /** 🔴 登录老师 RuoYi access_token：经 agent_config 透传给 toolkit，入库 owner=该老师本人。 */
  ruoyiToken?: string
}

/** toolkit ChatMessage（只取前端用得到的字段，其余宽松忽略） */
export interface ToolkitChatMessage {
  type: 'human' | 'ai' | 'tool' | 'custom'
  content: string
  custom_data?: Record<string, unknown>
  [k: string]: unknown
}

/** 逐字 token */
export interface VariantTokenEvent {
  type: 'token'
  content: string
}
/** 整块消息（节点产出，content 即要渲染的文本块） */
export interface VariantMessageEvent {
  type: 'message'
  content: ToolkitChatMessage
}
/** 服务端错误 */
export interface VariantErrorEvent {
  type: 'error'
  content: string
}

export type VariantEvent = VariantTokenEvent | VariantMessageEvent | VariantErrorEvent

/** streamVariant 回调集 */
export interface VariantStreamHandlers {
  /** 逐字 token（打字机追加） */
  onToken: (delta: string) => void
  /** 整块 AI 消息（一个新气泡） */
  onMessage: (msg: ToolkitChatMessage) => void
  /** 服务端 error 帧 */
  onServerError?: (msg: string) => void
  /** 连接异常 / 非 SSE 响应 / 不可达。fatal 后流终止 */
  onError?: (err: unknown) => void
  /** 流自然结束（收到 [DONE] 或连接关闭） */
  onClose?: () => void
}

/** 控制句柄：调用方可主动中止 */
export interface VariantStreamHandle {
  abort: () => void
}

class NonSseResponseError extends Error {
  constructor(status: number, contentType: string) {
    super(`/variant/stream 返回非 SSE 响应: status=${status}, content-type=${contentType}`)
    this.name = 'NonSseResponseError'
  }
}

/**
 * 调 toolkit variant agent（SSE 流式）。
 *
 * @returns 控制句柄，调用方可 abort()（组件卸载 / 重新发送中止上一条）。
 *
 * 要点：
 *   - onopen 校验 res.ok + content-type 含 text/event-stream，否则抛错走兜底；
 *   - onmessage：ev.data === '[DONE]' → 收尾（toolkit 用裸 [DONE] 不是 JSON）；
 *     其余 JSON.parse 成 VariantEvent，按 type 分流（token/message/error）；
 *   - onerror throw → 阻止 fetch-event-source 默认无限重连（单轮编辑即走，不重试）；
 *   - openWhenHidden:true → 出题慢（出 3 道各自 solve 可能重生，十几次 LLM），切后台不断流。
 */
export function streamVariant(
  payload: VariantRequest,
  handlers: VariantStreamHandlers
): VariantStreamHandle {
  const ctrl = new AbortController()

  // toolkit StreamInput：message/thread_id/stream_tokens + agent_config（透传登录老师 token）。
  // ruoyi_token 走 agent_config（toolkit _handle_input 会并进 graph config.configurable），
  // 不放顶层（避免 StreamInput 未知字段）；persist 节点据此用老师身份入库。
  const body: Record<string, unknown> = {
    message: payload.message,
    stream_tokens: true,
  }
  if (payload.thread_id) body.thread_id = payload.thread_id
  if (payload.ruoyiToken) body.agent_config = { ruoyi_token: payload.ruoyiToken }

  fetchEventSource('/agent/variant/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
    openWhenHidden: true,

    async onopen(res) {
      const ct = res.headers.get('content-type') || ''
      if (res.ok && ct.includes('text/event-stream')) return
      throw new NonSseResponseError(res.status, ct)
    },

    onmessage(ev) {
      if (!ev.data) return
      // 🔴 toolkit 流结束标志是裸字符串 [DONE]（非 JSON），单独处理
      if (ev.data === '[DONE]') {
        handlers.onClose?.()
        ctrl.abort() // 主动收尾，避免 fetch-event-source 继续等
        return
      }
      let parsed: VariantEvent
      try {
        parsed = JSON.parse(ev.data) as VariantEvent
      } catch (e) {
        console.warn('[variant] SSE 帧解析失败，跳过:', ev.data, e)
        return
      }
      switch (parsed.type) {
        case 'token':
          handlers.onToken(parsed.content)
          break
        case 'message':
          // 只渲染 AI 产出的块；human（agent 回放输入）/ 空内容忽略
          if (
            parsed.content &&
            parsed.content.type !== 'human' &&
            String(parsed.content.content || '').trim()
          ) {
            handlers.onMessage(parsed.content)
          }
          break
        case 'error':
          handlers.onServerError?.(parsed.content || '服务处理出错')
          break
      }
    },

    onerror(err) {
      handlers.onError?.(err)
      throw err // 阻止自动重连
    },

    onclose() {
      handlers.onClose?.()
    },
  }).catch((err) => {
    if (ctrl.signal.aborted) return
    if (err instanceof NonSseResponseError) handlers.onError?.(err)
  })

  return { abort: () => ctrl.abort() }
}
