import request from '@/http/request'

// ── Block payload 类型（结构化积木，payload 已是对象，不要再 JSON.parse）──────

/** Span：段落/表格中的最小文字单元，mark:1 = 标红 */
export interface KgSpan {
  t: string
  mark?: 1
}

/** para 块 payload */
export interface KgParaPayload {
  spans: KgSpan[]
}

/** note 块 payload（名师解读红框） */
export interface KgNotePayload {
  title: string
  text: string
}

/** callout 块 payload（蓝字记忆框） */
export interface KgCalloutPayload {
  lines: string[]
  color: string
}

/** image 块 payload */
export interface KgImagePayload {
  url: string
  w: number
  role?: string
}

/** 表格单元格 */
export interface KgTableCell {
  spans: KgSpan[]
  header?: boolean
  colspan?: number
  rowspan?: number
  imgs?: string[]
}

/** table 块 payload */
export interface KgTablePayload {
  rows: KgTableCell[][]
}

/** example 块 item — 题干行：文字、图片或内嵌表格 */
export type KgExampleItem =
  | { spans: KgSpan[] }
  | { img: string; w: number; role?: string }
  | { table: KgTableCell[][] }

/** example 块 payload（例题卡） */
export interface KgExamplePayload {
  items: KgExampleItem[]
  answer: string
  explain: string
  year?: string | null
  region?: string | null
}

/** Block 联合类型 */
export type KgBlock =
  | { seq: number; type: 'para';    payload: KgParaPayload }
  | { seq: number; type: 'note';    payload: KgNotePayload }
  | { seq: number; type: 'callout'; payload: KgCalloutPayload }
  | { seq: number; type: 'image';   payload: KgImagePayload }
  | { seq: number; type: 'table';   payload: KgTablePayload }
  | { seq: number; type: 'example'; payload: KgExamplePayload }

// ── 知识点、考点 ──────────────────────────────────────────────────────────────

export interface KgKp {
  id: string
  name: string
  blocks: KgBlock[]
  keyConcepts: string[]
}

export interface KgKaodian {
  id: string
  name: string
  kps: KgKp[]
}

// ── 思维导图节点 ──────────────────────────────────────────────────────────────

export interface KgMindmapNode {
  nodeKey: string
  parentKey: string | null
  text: string
  detail: string | null
  hasMark: 0 | 1
  color: string | null
  sort: number
}

// ── 顶层响应 ─────────────────────────────────────────────────────────────────

export interface KgCourseResponse {
  course: {
    id: string
    name: string
  }
  mindmap: KgMindmapNode[]
  kaodians: KgKaodian[]
  exercises: unknown[]
  boost: unknown[]
}

// ── 开关：true = 用本地 mock，false = 走真接口 /teacher/kg/course/{id} ───────
// 🔴 联调确认渲染无误后置 false
export const USE_MOCK = false

// ── Mock 数据（直接来自 kg_contract_sample.json 的 response 字段） ─────────────
import mockJson from './mock_data.json'
const MOCK_DATA: KgCourseResponse = (mockJson as { response: KgCourseResponse }).response

/**
 * 获取课时讲义（GET /teacher/kg/course/:courseId）。
 * envelope { code:1, message, response } 由 axios 拦截器解包，此处拿到 response 内层。
 */
export const getCourseDetail = (courseId: string): Promise<KgCourseResponse> => {
  if (USE_MOCK) {
    return Promise.resolve(MOCK_DATA)
  }
  return request.get<KgCourseResponse, KgCourseResponse>(`/teacher/kg/course/${courseId}`)
}
