import request from '@/http/request'
import { fetchEventSource } from '@microsoft/fetch-event-source'

// ---------------------------------------------------------------------------
// PRD-A-002 路A「框选录题」三接口封装。
//
// ① recognize —— toolkit（:8095，走 vite proxy /agent，原生裸 JSON、无 misikt 包装、免鉴权）。
//    用原生 fetch，不经 request 拦截器（拦截器只解 /api 的 misikt envelope）。
// ② uploadIngestImage —— BE /api（已鉴权），把框出的原图块无损上 OSS，返 assetId/ossUrl/dedup。
// ③ ingestQuestion —— BE /api（已鉴权），落 biz_question 草稿（status='0'）。
//
// ②③ 经 request（baseURL='/api' + 自动注入 Authorization+clientid + misikt envelope 解包）。
// ---------------------------------------------------------------------------

// ── ① 识别（toolkit 裸 JSON 契约） ─────────────────────────────────────────

/** DNA 主考点 / 知识点节点（id+name） */
export interface RecognizeKp {
  id: string | null
  name: string | null
}

/** 识别出的题目 DNA（solve=true 才有，否则 null） */
export interface RecognizeDna {
  main_kp: RecognizeKp | null
  secondary_kps: RecognizeKp[]
  qtype: string | null
  exam_type: string | null
  skeleton: string[]
  hard_points: string[]
  hard_point_count: number | null
  tags: string[]
  scene: string | null
  /** 难度 1-4 */
  difficulty: number | null
  model_candidates: unknown[]
}

/** 验算结果（solve=true 才有，否则 null） */
export interface RecognizeVerify {
  verdict: 'pass' | 'fail' | 'degrade' | string | null
  detail: string | null
  computed: string | null
}

/** /agent/recognize 请求体 */
export interface RecognizeRequest {
  /** 裸 base64，不带 data: 前缀 */
  image_base64: string
  /** 是否同时解题（出 answer/analysis/dna/verify），耗时更久 */
  solve: boolean
  /** 学段锚点提示（如「七年级」），可选 */
  grade_hint?: string
}

/**
 * /agent/recognize 响应（🔴 直接是这个对象，不取 .response）。
 * solve=false 时 answer/analysis/dna/verify 为空/null。
 */
export interface RecognizeResult {
  ok: boolean
  has_figure: boolean
  /** B4：框区内含学生手写作答/批改痕迹 → true，前端据此条件出现「批改」按钮 */
  need_grading: boolean
  stem: string
  qtype: '选择' | '填空' | '解答' | string
  options: string[]
  answer: string
  analysis: string
  solved_answer: string
  dna: RecognizeDna | null
  verify: RecognizeVerify | null
  richtext_issues: string[]
  error: string | null
}

/**
 * 调 toolkit 识别（裸 fetch，不经 request 拦截器；返回是裸 JSON 不是 misikt 包装）。
 * 超时 120s（解题轮 ~33s）。网络/HTTP 错抛 Error，业务失败由调用方判 result.ok / result.error。
 */
export async function recognize(req: RecognizeRequest): Promise<RecognizeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const res = await fetch('/agent/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: controller.signal,
    })
    if (!res.ok) {
      let detail = ''
      try {
        const d = (await res.json()) as { detail?: string; error?: string }
        detail = d.detail || d.error || ''
      } catch {
        detail = ''
      }
      throw new Error(detail || `识别服务异常 (${res.status})`)
    }
    return (await res.json()) as RecognizeResult
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('识别超时（请重试或缩小框选区域）')
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// ── ①b 批改（toolkit 裸 JSON 契约，B4） ─────────────────────────────────────

/** /agent/grade 请求体（批改：裁剪题区图 → 先解题 → 判学生作答对错） */
export interface GradeRequest {
  /** 裸 base64，不带 data: 前缀（原图坐标裁剪出的题区图，含印刷体+学生手写） */
  image_base64: string
  /** 注入的相关知识点（帮助判定，可选） */
  knowledge?: string
  /** 注入的所属章节（帮助判定，可选） */
  chapter?: string
}

/** 批改判定结果 */
export type GradeVerdict = 'correct' | 'wrong' | 'partial' | 'blank' | 'uncertain' | string

/** /agent/grade 响应（直接是这个对象，不取 .response） */
export interface GradeResult {
  ok: boolean
  /** 去手写的印刷体原题 */
  stem: string
  qtype: string
  /** AI 解出的标准答案 */
  standard_answer: string
  /** 标准解题过程 */
  standard_analysis: string
  /** 学生手写的最终答案 */
  student_answer: string
  /** 是否检测到手写作答 */
  has_handwriting: boolean
  /** 批改判定：对/错/部分对/未作答/存疑 */
  verdict: GradeVerdict
  /** 老师视角点评 */
  feedback: string
  verify: RecognizeVerify | null
  error: string | null
}

/**
 * 调 toolkit 批改（裸 fetch，与 recognize 同范式）。超时 120s（先解题再批改，~40s）。
 * 内部逻辑：先自己严谨解题拿标准答案 → 再据此判学生作答对错；多异常态（无笔迹→blank/存疑→uncertain）。
 */
export async function grade(req: GradeRequest): Promise<GradeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const res = await fetch('/agent/grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: controller.signal,
    })
    if (!res.ok) {
      let detail = ''
      try {
        const d = (await res.json()) as { detail?: string; error?: string }
        detail = d.detail || d.error || ''
      } catch {
        detail = ''
      }
      throw new Error(detail || `批改服务异常 (${res.status})`)
    }
    return (await res.json()) as GradeResult
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('批改超时（请重试）')
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// ── ①c 解题流 / 批改流（toolkit SSE，B4 实时流式不黑盒） ────────────────────
//
// 维护者拍板：录题解题/批改像举一反三第一阶段一样**实时流式**——按钮直调预设 prompt，
// LLM 逐字流式（老师实时看怎么解/怎么改），打标(DNA)异步跟在解题后。
// 协议（对齐 variant）：data: {"type":"token","content":"<片段>"} / {"type":"result","content":<结构>}
//   / {"type":"error",...} ；data: [DONE] 裸串结束。走 /agent 代理（toolkit 原生，不经 request 拦截器）。

/** 解题流结构化结果（result 帧） */
export interface SolveStreamResult {
  stem: string
  qtype: string
  options: string[]
  answer: string
  analysis: string
  need_grading: boolean
}

/** 解题流回调 */
export interface SolveStreamHandlers {
  /** 逐字增量（人类可读解题过程，追加进卡内流式区） */
  onToken: (delta: string) => void
  /** 流末尾结构化结果（入库用 stem/answer/options 等） */
  onResult: (r: SolveStreamResult) => void
  /** 服务端错误帧 */
  onError?: (msg: string) => void
  /** 流自然结束（[DONE] 或连接关闭） */
  onClose?: () => void
}

/** 解题流（识别+解题一起做，SSE）。返回 { abort } 可中止。 */
export function solveStream(imageBase64: string, handlers: SolveStreamHandlers): { abort: () => void } {
  const ctrl = new AbortController()
  fetchEventSource('/agent/solve_stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_base64: imageBase64 }),
    signal: ctrl.signal,
    openWhenHidden: true,
    async onopen(res) {
      const ct = res.headers.get('content-type') || ''
      if (res.ok && ct.includes('text/event-stream')) return
      throw new Error(`解题流异常 (${res.status})`)
    },
    onmessage(ev) {
      if (!ev.data) return
      if (ev.data === '[DONE]') {
        handlers.onClose?.()
        ctrl.abort()
        return
      }
      try {
        const p = JSON.parse(ev.data) as { type: string; content: unknown }
        if (p.type === 'token') handlers.onToken(String(p.content || ''))
        else if (p.type === 'result') handlers.onResult(p.content as SolveStreamResult)
        else if (p.type === 'error') handlers.onError?.(String(p.content || '解题出错'))
      } catch {
        // 跳过坏帧
      }
    },
    onerror(err) {
      handlers.onError?.(err instanceof Error ? err.message : '解题流中断')
      throw err
    },
    onclose() {
      handlers.onClose?.()
    },
  }).catch((err) => {
    if (ctrl.signal.aborted) return
    handlers.onError?.(err instanceof Error ? err.message : '解题流失败')
  })
  return { abort: () => ctrl.abort() }
}

/** 批改流结构化结果 */
export interface GradeStreamResult {
  stem: string
  standard_answer: string
  student_answer: string
  has_handwriting: boolean
  verdict: GradeVerdict
  feedback: string
}

/** 批改流回调 */
export interface GradeStreamHandlers {
  onToken: (delta: string) => void
  onResult: (r: GradeStreamResult) => void
  onError?: (msg: string) => void
  onClose?: () => void
}

/** 批改流（识别+先解题+判对错，SSE）。返回 { abort }。 */
export function gradeStream(
  req: { imageBase64: string; knowledge?: string; chapter?: string },
  handlers: GradeStreamHandlers,
): { abort: () => void } {
  const ctrl = new AbortController()
  fetchEventSource('/agent/grade_stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_base64: req.imageBase64,
      ...(req.knowledge ? { knowledge: req.knowledge } : {}),
      ...(req.chapter ? { chapter: req.chapter } : {}),
    }),
    signal: ctrl.signal,
    openWhenHidden: true,
    async onopen(res) {
      const ct = res.headers.get('content-type') || ''
      if (res.ok && ct.includes('text/event-stream')) return
      throw new Error(`批改流异常 (${res.status})`)
    },
    onmessage(ev) {
      if (!ev.data) return
      if (ev.data === '[DONE]') {
        handlers.onClose?.()
        ctrl.abort()
        return
      }
      try {
        const p = JSON.parse(ev.data) as { type: string; content: unknown }
        if (p.type === 'token') handlers.onToken(String(p.content || ''))
        else if (p.type === 'result') handlers.onResult(p.content as GradeStreamResult)
        else if (p.type === 'error') handlers.onError?.(String(p.content || '批改出错'))
      } catch {
        // 跳过坏帧
      }
    },
    onerror(err) {
      handlers.onError?.(err instanceof Error ? err.message : '批改流中断')
      throw err
    },
    onclose() {
      handlers.onClose?.()
    },
  }).catch((err) => {
    if (ctrl.signal.aborted) return
    handlers.onError?.(err instanceof Error ? err.message : '批改流失败')
  })
  return { abort: () => ctrl.abort() }
}

// ── ①d 打标（toolkit /label，解题后异步跟跑，不阻塞老师其他操作） ─────────────

/** 打标结果（dna 整段，渲染前可 JSON.parse 已是对象） */
export interface LabelResult {
  ok: boolean
  dna: RecognizeDna | Record<string, unknown> | null
  error: string | null
}

/** 单题打标（解题完成后异步调，产 10 维 DNA）。失败静默（打标是额外的事，不影响录题）。 */
export async function labelQuestion(payload: {
  stem: string
  qtype?: string
  options?: string[]
  answer?: string
  analysis?: string
}): Promise<LabelResult> {
  const res = await fetch('/agent/label', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) return { ok: false, dna: null, error: `打标服务异常 (${res.status})` }
  return (await res.json()) as LabelResult
}

// ── ② 配图上传（BE /api，已鉴权） ──────────────────────────────────────────

/** 上传配图响应（已解包） */
export interface IngestImageResult {
  assetId: number
  ossUrl: string
  dedup: boolean
}

/**
 * 把框出的原图块（无损 PNG Blob）上传 OSS，返 assetId/ossUrl。
 * 录入时把它写进 IngestQuestionBo.images。
 */
export function uploadIngestImage(blob: Blob): Promise<IngestImageResult> {
  const form = new FormData()
  form.append('file', blob, 'region.png')
  return request.post<IngestImageResult, IngestImageResult>(
    '/teacher/ingest/image',
    form,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60_000,
    },
  )
}

// ── ③ 录入（BE /api，已鉴权） ──────────────────────────────────────────────

/** 录入题目配图（来自②上传结果） */
export interface IngestQuestionImage {
  assetId: number
  ossUrl: string
  role: 'figure' | string
  seq: number
  isDecorative: number
}

/** 录入请求体（IngestQuestionBo） */
export interface IngestQuestionBo {
  /** 草稿态（必传 '0'） */
  status: '0'
  /** 绑定章节节点 id（NOT NULL 必填） */
  subjectId: string
  /** 题型：选择→1 填空→2 解答→5 */
  questionType: number
  /** 难度 1-3 */
  difficult: number
  /** 改题后的题干 markdown */
  stemText: string
  /** 答案（solve 了才有） */
  answerText?: string
  /** 解析（solve 了才有） */
  analyzeText?: string
  /** 配图（②上传得到） */
  images: IngestQuestionImage[]
  /** 录入来源标识 */
  importSource: string
}

/** 录入响应（已解包） */
export interface IngestQuestionResult {
  questionId: string
  created: boolean
}

/** 落 biz_question 草稿 */
export function ingestQuestion(body: IngestQuestionBo): Promise<IngestQuestionResult> {
  return request.post<IngestQuestionResult, IngestQuestionResult>(
    '/teacher/ingest/question',
    body,
  )
}

// ── 字段映射工具 ───────────────────────────────────────────────────────────

/** qtype 文本 → 库题型值（选择→1 填空→2 解答→5，默认 5） */
export function mapQtypeToCode(qtype: string | null | undefined): number {
  switch (qtype) {
    case '选择':
      return 1
    case '填空':
      return 2
    case '解答':
      return 5
    default:
      return 5
  }
}

/** dna.difficulty(1-4) → 库难度(1-3)：1→1,2→2,3/4→3；无 dna 默认 2 */
export function mapDifficultyToCode(difficulty: number | null | undefined): number {
  if (difficulty == null) return 2
  if (difficulty <= 1) return 1
  if (difficulty === 2) return 2
  return 3
}

// ===========================================================================
// PRD-A-002 路B「批量上传录题」接口封装（全经 request /api，misikt 已解包返 response）。
//
//   作业（job）= 一次「上传一张试卷图 → 后端拆题流水线」的批处理实例。
//   流程：① createIngestJob 提交文件 → 拿 jobId（拆题异步）
//         ② listIngestJobs / getIngestJob 轮询状态 + 拉拆出的题项
//         ③ commitIngestJob 勾选入库 / dropIngestJobItem 软弃题
//
//   🔴 雪花 id 在 http 层 jsonBigParser 已转 string，但 BE 也可能返 number →
//      interface 统一 string | number 兼容，渲染前不强转。
//   🔴 optionsJson / dnaJson 是 JSON 字符串，渲染前 JSON.parse（容错见 review.vue）。
// ===========================================================================

/** 答案解析模式：原卷自带 / AI 解题 / 只录题 */
export type IngestAnswerMode = 'from_source' | 'ai_solve' | 'stem_only'

/** 入库方式：审核后入库 / 直接入库 */
export type IngestCommitMode = 'review' | 'direct'

/** 作业状态机 */
export type IngestJobStatus =
  | 'PENDING'
  | 'EXTRACT_ING'
  | 'SPLIT_ING'
  | 'SOLVING'
  | 'DONE'
  | 'FAILED'
  | string

/** 作业列表行（GET /teacher/ingest/jobs?mine=1 单项） */
export interface IngestJobRow {
  id: string | number
  status: IngestJobStatus
  questionCount: number
  committedCount: number
  sourceFileName: string | null
  errorMsg: string | null
  createTime: string | null
}

/** 作业详情头（GET /teacher/ingest/job/{jobId} 的 job 字段） */
export interface IngestJobDetail {
  id: string | number
  teacherId: string | number | null
  subjectId: string | number | null
  sourceFileName: string | null
  sourceOssUrl: string | null
  sourceType: string | null
  status: IngestJobStatus
  errorMsg: string | null
  questionCount: number
  committedCount: number
  createTime?: string | null
  [k: string]: unknown
}

/** 题项当前状态 */
export type IngestItemStatus = 'pending' | 'committed' | 'dropped' | string

/** 作业拆出的题项（GET /teacher/ingest/job/{jobId} 的 items 单项）。
 *  🔴 optionsJson / dnaJson 是 JSON 字符串，调用方 JSON.parse（容错）。 */
export interface IngestJobItem {
  id: string | number
  seq: number
  stemText: string | null
  /** 题型：1 选择 / 2 填空 / 5 解答 */
  questionType: number
  /** 选项 JSON 字符串，需 JSON.parse */
  optionsJson: string | null
  answerText: string | null
  analyzeText: string | null
  /** 0/1 是否含图 */
  hasFigure: number
  difficulty: number | null
  /** DNA JSON 字符串，需 JSON.parse */
  dnaJson: string | null
  verifyVerdict: string | null
  /** 0/1 是否需人工审核 */
  needReview: number
  itemStatus: IngestItemStatus
  committedQuestionId: string | number | null
  /** 裁出题图 JSON 字符串（PRD-A-024 批1），需 JSON.parse */
  figuresJson?: string | null
  /** KG 锚定 JSON 字符串（PRD-A-024 批2）：{kpId,kpName,matchedName,stage,confidence,fallback}，需 JSON.parse */
  kpAnchorJson?: string | null
}

/**
 * ① 创建作业（multipart 上传试卷图 → 启动拆题流水线）。超时 60s。
 * @param form FormData：file, subjectId, answerMode, commitMode, gradeHint?
 */
export function createIngestJob(form: FormData): Promise<{ jobId: string }> {
  return request.post<{ jobId: string }, { jobId: string }>(
    '/teacher/ingest/job',
    form,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60_000,
    },
  )
}

/** ② 我的作业列表（时间倒序）。 */
export function listIngestJobs(): Promise<IngestJobRow[]> {
  return request.get<IngestJobRow[], IngestJobRow[]>(
    '/teacher/ingest/jobs',
    { params: { mine: 1 } },
  )
}

/** ③ 作业详情（含拆出的题项列表）。 */
export function getIngestJob(
  jobId: string | number,
): Promise<{ job: IngestJobDetail; items: IngestJobItem[] }> {
  return request.get<
    { job: IngestJobDetail; items: IngestJobItem[] },
    { job: IngestJobDetail; items: IngestJobItem[] }
  >(`/teacher/ingest/job/${jobId}`)
}

/**
 * ④ 勾选入库（itemIds 空数组 / 不传 = 全部 pending）。
 * @returns { committed: 实际入库题数 }
 */
export function commitIngestJob(
  jobId: string | number,
  itemIds: (string | number)[],
): Promise<{ committed: number }> {
  return request.post<{ committed: number }, { committed: number }>(
    `/teacher/ingest/job/${jobId}/commit`,
    { itemIds },
  )
}

/** ⑤ 软弃题（itemStatus → dropped）。 */
export function dropIngestJobItem(
  jobId: string | number,
  itemId: string | number,
): Promise<{ dropped: boolean }> {
  return request.delete<{ dropped: boolean }, { dropped: boolean }>(
    `/teacher/ingest/job/${jobId}/item/${itemId}`,
  )
}

/** 就地改题入参（仅传非空字段，局部更新） */
export interface IngestJobItemEdit {
  stemText?: string
  answerText?: string
  analyzeText?: string
  questionType?: number
}

/** ⑥ 审核页就地改题（PRD-A-002 B5）：改拆错的题面/答案/解析/题型，入库前暂存编辑。仅 pending 项可改。 */
export function updateIngestJobItem(
  jobId: string | number,
  itemId: string | number,
  payload: IngestJobItemEdit,
): Promise<{ updated: boolean }> {
  return request.put<{ updated: boolean }, { updated: boolean }>(
    `/teacher/ingest/job/${jobId}/item/${itemId}`,
    payload,
  )
}
