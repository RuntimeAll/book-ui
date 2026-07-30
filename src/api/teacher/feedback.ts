import request from '@/http/request'

// ===========================================================================
// PRD-004 课后反馈单 —— API 客户端。
// 走 /api → book-server（misikt envelope，code===1 判成功，request 拦截器解包 response）。
// 全部 @SaCheckLogin，owner/create_by 服务端登录态取，不传 body。
// 🔴 id / targetId 一律 string（雪花 19 位，json-bigint 保精度，禁 number 截尾）。
// ===========================================================================

const BASE = '/teacher/feedback'

/** 一行五列（全自由文本；kp_id 可选留画像通路，本卡零功能）。 */
export interface FeedbackRow {
  seq?: string | number
  module?: string
  content?: string
  mastery?: string
  weakness?: string
  kp_id?: string | null
}

/** 反馈单入参（建/改共用）。 */
export interface FeedbackSheetBo {
  targetId?: string | null
  title?: string
  lessonDate?: string | null
  rows: FeedbackRow[]
  // PRD-015 教务域：反馈单绑场次 / 绑课程计划（结算链自动建单时由 BE 回填）
  sessionId?: string
  planId?: string
}

/** 列表行（不含 rows）。 */
export interface FeedbackSheetBrief {
  id: string
  targetId: string | null
  targetName: string | null
  title: string | null
  lessonDate: string | null
  createTime?: string
  updateTime?: string
  // PRD-015 教务域：绑定的场次 / 课程计划（旧单为空）
  sessionId?: string
  planId?: string
  // PRD-015 计划内课次序号（按 planId 聚合出计划长图时排序用；未绑计划为空）
  lessonSeq?: number
}

/** 详情（含 rows）。 */
export interface FeedbackSheetDetail extends FeedbackSheetBrief {
  rows: FeedbackRow[]
}

export interface PageResult<T> {
  rows: T[]
  total: number
}

export interface IdVO {
  id: string
}

export interface FileUrlVO {
  file: string
  url: string
}

/** 建反馈单 → {id}。 */
export const createSheet = (bo: FeedbackSheetBo) =>
  request.post<IdVO, IdVO>(`${BASE}/sheet`, bo)

/** 改反馈单。 */
export const updateSheet = (id: string, bo: FeedbackSheetBo) =>
  request.put<void, void>(`${BASE}/sheet/${id}`, bo)

/** 列表（owner，可选 targetId / keyword）。 */
export const pageSheets = (params: { targetId?: string; keyword?: string; planId?: string } = {}) =>
  request.get<PageResult<FeedbackSheetBrief>, PageResult<FeedbackSheetBrief>>(`${BASE}/sheet/page`, { params })

/** 详情（含 rows）。 */
export const getSheet = (id: string) =>
  request.get<FeedbackSheetDetail, FeedbackSheetDetail>(`${BASE}/sheet/${id}`)

/** 删除。 */
export const deleteSheet = (id: string) =>
  request.delete<void, void>(`${BASE}/sheet/${id}`)

/** 导出家长版 PNG → {file,url}。 */
export const exportPng = (id: string) =>
  request.post<FileUrlVO, FileUrlVO>(`${BASE}/sheet/${id}/export-png`)

// PRD-015 按课程计划导出反馈长图 → {file,url}
// mode='single' 每单一张 / 'long' 计划下全部反馈单拼一张长图（按 lessonSeq 排序）
export const exportPlanPng = (planId: string, mode: 'single' | 'long') =>
  request.post<FileUrlVO, FileUrlVO>(`${BASE}/export-plan-png`, { planId, mode })

/**
 * 下载 PNG 产物（带鉴权头 axios，responseType=blob；request 拦截器对 blob 短路跳过 envelope）。
 * 复用 /teacher/schedule/artifact 下载端点（同 artifact-dir，防穿越）。
 */
export const downloadArtifact = (path: string): Promise<Blob> =>
  request.get<Blob, Blob>(`/teacher/schedule/artifact`, { params: { path }, responseType: 'blob' })
