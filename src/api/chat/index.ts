import { fetchEventSource } from '@microsoft/fetch-event-source'

// ---------------------------------------------------------------------------
// PRD-C-005 — AI 编排聊天入口（ai-orchestrator :8092 /chat），SSE 全流式 V2
//
// C-004 V1 用 axios 一次性 await 拿 JSON 结果；本卡（C-005）把 /chat 升级为
// SSE 全流式：WF3 七步阶段事件 + LLM 逐 token 流，前端逐字/逐条实时渲染。
//
// 🔴 用现成轮子 @microsoft/fetch-event-source（禁手写 ReadableStream+TextDecoder 拆 \n\n 帧）：
//   - 支持 POST + body + headers（原生 EventSource 只支持 GET，故不能用它）；
//   - 自带 SSE 帧解析（onmessage 拿到的已是单条 {data} 事件）；
//   - onopen 可校验响应头（content-type 必须 text/event-stream）；
//   - openWhenHidden:true → 页面切到后台标签也不断流（默认会断，组卷较慢需保活）。
//
// 走 vite proxy：fetch('/ai/chat') → rewrite 掉 /ai → http://localhost:8092/chat（同源绕 CORS）。
// 单轮即走，不带鉴权头（ai-orchestrator 组卷调用已配免登录）；teacherId 走 body 透传。
// ai-orchestrator 返回裸 SSE（非 misikt envelope），所以独立封装，不复用 /api 那套拦截器。
// ---------------------------------------------------------------------------

/** /chat 请求体 */
export interface ChatRequest {
  message: string
  teacherId?: number
}

/** 组卷结果里的单题（结构按后端契约宽松接收） */
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

// ---------------------------------------------------------------------------
// SSE 事件协议（与 T1 后端 wf3_compose / main.py 一一对齐）
//   stage   {type,key,label,status:'running'|'done',detail?}  WF3 七步阶段灯
//   intent  {type,delta}                                       LLM① 抽参期 content token 流
//   outline {type,delta} | {type,items:[...]}                  LLM② 大纲 token 流 / 结构化定型
//   notes   {type,notes:string[]}                              人话句子 list（不含裸 JSON）
//   paper   {type,paperId,paper,paperUrl,outline}              最终落库结果
//   needAsk {type,ask,intentEcho?}                             非组卷/范围说不清兜底
//   error   {type,error}                                       任一步失败
//   done    {type}                                             流正常结束（成功/兜底/错误后都补）
// ---------------------------------------------------------------------------

export type ChatStageStatus = 'running' | 'done'

export interface StageEvent {
  type: 'stage'
  key: string
  label: string
  status: ChatStageStatus
  detail?: string
}
export interface IntentEvent {
  type: 'intent'
  delta: string
}
export interface OutlineEvent {
  type: 'outline'
  delta?: string
  items?: Array<Record<string, unknown>>
}
export interface NotesEvent {
  type: 'notes'
  notes: string[]
}
export interface PaperEvent {
  type: 'paper'
  paperId?: number | string
  paper?: ChatPaper
  paperUrl?: string
  outline?: Array<Record<string, unknown>>
}
export interface NeedAskEvent {
  type: 'needAsk'
  ask: string
  intentEcho?: string
}
export interface ErrorEvent {
  type: 'error'
  error: string
}
export interface DoneEvent {
  type: 'done'
}

export type ChatEvent =
  | StageEvent
  | IntentEvent
  | OutlineEvent
  | NotesEvent
  | PaperEvent
  | NeedAskEvent
  | ErrorEvent
  | DoneEvent

/** streamChat 回调集 */
export interface ChatStreamHandlers {
  /** 每收到一个已解析的业务事件回调一次（按 ev.type 分流渲染） */
  onEvent: (ev: ChatEvent) => void
  /** 连接异常 / 服务不可达 / 响应非 SSE。fatal 后流已终止，不会再回 onEvent */
  onError?: (err: unknown) => void
  /** 流自然结束（连接关闭）。无论成功/兜底/错误后最终都会走到 */
  onClose?: () => void
}

/** streamChat 控制句柄（调用方可主动中止流） */
export interface ChatStreamHandle {
  abort: () => void
}

/** onopen 校验失败时抛它 → 触发 fetchEventSource 的 onerror 兜底（非 SSE 响应不当成功） */
class NonSseResponseError extends Error {
  constructor(status: number, contentType: string) {
    super(`/chat 返回非 SSE 响应: status=${status}, content-type=${contentType}`)
    this.name = 'NonSseResponseError'
  }
}

/**
 * 调 ai-orchestrator /chat（SSE 流式）。
 *
 * @returns 控制句柄，调用方可 abort() 主动中止（如组件卸载 / 用户切走）。
 *
 * 设计要点：
 *   - onopen 校验 res.ok 且 content-type 含 text/event-stream，否则抛错走兜底（不当成功流）；
 *   - onmessage 拿到的 ev.data 是单条 SSE data 字符串，JSON.parse 成业务事件回调 onEvent；
 *   - onerror 抛出（throw err）→ 阻止 fetch-event-source 的自动无限重连（默认会指数退避重连），
 *     本场景单轮即走，不需要重连，连不上就兜底提示一次即止；
 *   - openWhenHidden:true → 页面隐藏不断流（组卷慢，老师切标签回来还要看结果）。
 */
export function streamChat(
  payload: ChatRequest,
  handlers: ChatStreamHandlers
): ChatStreamHandle {
  const ctrl = new AbortController()

  fetchEventSource('/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: ctrl.signal,
    // 页面切后台标签也保活（组卷较慢；默认隐藏会断流）
    openWhenHidden: true,

    async onopen(res) {
      const ct = res.headers.get('content-type') || ''
      if (res.ok && ct.includes('text/event-stream')) {
        return // 正常 SSE 流，放行
      }
      // 非 SSE（4xx/5xx 或返回了 JSON/HTML）→ 抛错，交 onerror 兜底，别当流处理
      throw new NonSseResponseError(res.status, ct)
    },

    onmessage(ev) {
      // sse-starlette 的 keep-alive ping 可能是空 data，跳过
      if (!ev.data) return
      let parsed: ChatEvent
      try {
        parsed = JSON.parse(ev.data) as ChatEvent
      } catch (e) {
        // 单帧解析失败不致命（跳过这帧，继续收后续）
        console.warn('[vibe-chat] SSE 帧解析失败，跳过:', ev.data, e)
        return
      }
      handlers.onEvent(parsed)
    },

    onerror(err) {
      // 🔴 throw 出去 = 阻止默认的自动无限重连（单轮即走，不重试）。
      handlers.onError?.(err)
      throw err
    },

    onclose() {
      handlers.onClose?.()
    },
  }).catch((err) => {
    // fetchEventSource 的 promise 在 onerror throw / abort 后 reject —— 已在 onerror 通知过，
    // 这里只兜 AbortError（主动中止）不再重复报错；其余非主动中止的也吞掉（onError 已回过）。
    if (ctrl.signal.aborted) return
    // 极端兜底：onopen 之前就失败且没进 onerror（少见），补一次通知
    if (err instanceof NonSseResponseError) handlers.onError?.(err)
  })

  return { abort: () => ctrl.abort() }
}
