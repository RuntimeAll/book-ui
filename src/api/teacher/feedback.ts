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
  // 🔴 传 sessionId 未传 planId → BE 从场次回填 planId
  sessionId?: string | null
  planId?: string | null
  /**
   * 计划内序号。
   * 🔄 **PRD-018 G9③（2026-08-05）**：序号已改**读取时**按 `(lesson_date, id)` 实时排出（1..N），
   *    列值不再决定展示。FE 一律不传、只读展示 —— 补录一单，其后所有单的序号自动顺移。
   */
  lessonSeq?: number | null
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
  /**
   * 计划内展示序号。
   * 🔄 **PRD-018 G9③**：BE 读取时按 `(lesson_date, id)` 实时排出 1..N —— 乱序补录后序号自洽。
   *    未绑计划（散单）为空。
   */
  lessonSeq?: number
  /** 🆕 原始 lesson_seq 列值（写入时定格的旧值，仅排查用，页面不展示） */
  lessonSeqRaw?: number | null
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

/** 按计划导出返回（file/url + 回显本次模式与单数）。 */
export interface PlanExportVO extends FileUrlVO {
  mode: 'single' | 'long'
  sheetCount: number
}

// PRD-015 按课程计划导出反馈图 → {file,url,mode,sheetCount}
// mode='single'（缺省）= 该计划**业务日期最晚**的一单单张 / 'long' = 全部反馈单拼长图
// 🔄 PRD-018 G9③：排序与黄条序号都按 (lesson_date, id) 读取时实时排，与页面列表严格一致
// 🔴 黄条标题 = 「序号 · 上课日期（· 备注）」，无「第几次」字样（D7）
export const exportPlanPng = (planId: string, mode: 'single' | 'long' = 'single') =>
  request.post<PlanExportVO, PlanExportVO>(`${BASE}/export-plan-png`, { planId, mode })

/**
 * 下载 PNG 产物（带鉴权头 axios，responseType=blob；request 拦截器对 blob 短路跳过 envelope）。
 * 复用 /teacher/schedule/artifact 下载端点（同 artifact-dir，防穿越）。
 */
export const downloadArtifact = (path: string): Promise<Blob> =>
  request.get<Blob, Blob>(`/teacher/schedule/artifact`, { params: { path }, responseType: 'blob' })
