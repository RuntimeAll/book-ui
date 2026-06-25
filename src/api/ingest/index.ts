import request from '@/http/request'

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
