/**
 * PRD-C-205 课件文档 API
 *
 * 接口契约（BE，PRD-C-205 B3）：
 *   GET  /teacher/kg/doc/{courseId}?bookId=CC7S
 *        → { course: { id, name }, bookId, docJson: object | null }
 *   POST /teacher/kg/doc/{courseId}
 *        body { bookId, title, docJson }
 *        → { id, ...（保存结果） }
 *   GET  /teacher/kg/questions?qids=a,b
 *        → [ { qid, stem, answer, explainText, type, source } ]
 *
 * 所有接口走 misikt envelope（/teacher/** 被 MisiktEnvelopeAdvice 包装），
 * axios 拦截器 code===1 解包后此处拿到 response 内层对象。
 */
import request from '@/http/request'

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface KgDocResponse {
  course: {
    id: string
    name: string
  }
  bookId: string
  /** docJson 为 null 时表示该课时尚未创建文档 */
  docJson: object | null
}

export interface KgDocSavePayload {
  bookId: string
  title: string
  docJson: object
}

/** 题目 VO（kgExample NodeView 用） */
export interface KgQuestion {
  /** 雪花 ID（string，json-bigint 已处理精度） */
  qid: string
  /** 题干（富文本，走 v-safe-html） */
  stem: string
  /** 答案文本（富文本） */
  answer: string
  /** 详解文本（富文本） */
  explainText: string
  /** 题型（选择题 / 填空题 / 解答题 …） */
  type: string
  /** 来源（如"2023 杭州中考"） */
  source: string
}

// ── 接口方法 ─────────────────────────────────────────────────────────────────

/**
 * 获取课时课件文档
 * @param courseId  课时节点 ID（如 901001002001）
 * @param bookId    教材编号（默认 CC7S）
 */
export function getKgDoc(courseId: string, bookId = 'CC7S'): Promise<KgDocResponse> {
  return request.get<KgDocResponse, KgDocResponse>(`/teacher/kg/doc/${courseId}`, {
    params: { bookId },
  })
}

/**
 * 保存课时课件文档（超管/备课权限）
 * @param courseId  课时节点 ID
 * @param payload   { bookId, title, docJson }
 */
export function saveKgDoc(courseId: string, payload: KgDocSavePayload): Promise<unknown> {
  return request.post<unknown, unknown>(`/teacher/kg/doc/${courseId}`, payload)
}

/**
 * 批量获取题目（kgExample NodeView 调用）
 * @param qids  题目 ID 数组（雪花 string）
 */
export function getKgQuestions(qids: string[]): Promise<KgQuestion[]> {
  return request.get<KgQuestion[], KgQuestion[]>('/teacher/kg/questions', {
    params: { qids: qids.join(',') },
  })
}
