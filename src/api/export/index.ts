/**
 * PRD-A-014 T2 — 导出任务 API
 *
 * 所有端点走 /teacher/** envelope (misikt 风格: {code:1, message, response})
 * 雪花 ID 全程 string (json-bigint + BigNumberSerializer 保精度)
 */
import request from '@/http/request'

// ── 类型定义 ─────────────────────────────────────────────────────────────────

/** POST /teacher/export/paper 请求体 */
export interface SubmitExportPayload {
  /** 卷 ID（可选，整卷导出时传；自选题时不传） */
  paperId?: string
  /** 导出题目顺序（来自预览） */
  ids: string[]
  /** 导出文件名（不含扩展名，= 预览页可编辑标题） */
  fileName: string
  /** 随题附答案图（同预览「显示答案」勾选；2026-06-11 去卷型改版，导出=所见即所得） */
  showAnswer: boolean
  /** 随题附解析图（同预览「显示解析」勾选） */
  showExplain: boolean
  /** 是否加水印 */
  watermark: boolean
}

/** POST /teacher/export/paper 响应 */
export interface SubmitExportResp {
  /** 雪花 ID 必 string */
  recordId: string
  /** 预计生成秒数 */
  estimatedSeconds: number
}

/** 导出记录状态 */
export type ExportRecordStatus = '0' | '1' | '2' | '3'
/** '0'=排队 '1'=生成中 '2'=完成 '3'=失败 */

/** GET /teacher/export/record/{id} 响应 */
export interface ExportRecordVO {
  /** 雪花 ID 必 string */
  recordId: string
  status: ExportRecordStatus
  /** 进度 0-100 */
  progress: number
  fileName: string
  fileUrl?: string
  /** 字节数 */
  fileSize?: number
  errorMsg?: string
  expireAt?: string
  createTime?: string
}

/** GET /teacher/export/record/page 单条 */
export interface ExportRecordPageItem extends ExportRecordVO {
  // 分页列表与 detail 字段保持一致
}

/** GET /teacher/export/record/page 分页响应 */
export interface ExportRecordPage {
  list: ExportRecordPageItem[]
  total: number
  pageNum: number
  pageSize: number
}

// ── API 封装 ──────────────────────────────────────────────────────────────────

/**
 * 提交导出任务
 * POST /teacher/export/paper
 * 单用户并发 1：已有排队/生成中任务时 BE 返回排队语义或业务错误
 */
export const submitExport = (payload: SubmitExportPayload) =>
  request.post<SubmitExportResp, SubmitExportResp>('/teacher/export/paper', payload)

/**
 * 查询单条导出记录
 * GET /teacher/export/record/{id}
 */
export const getExportRecord = (recordId: string) =>
  request.get<ExportRecordVO, ExportRecordVO>(`/teacher/export/record/${recordId}`)

/**
 * 分页查询当前登录用户的导出记录
 * GET /teacher/export/record/page
 * BE 用 LoginHelper 取 userId，不信前端参数
 */
export const getExportRecordPage = (params: { pageNum?: number; pageSize?: number } = {}) =>
  request.get<ExportRecordPage, ExportRecordPage>('/teacher/export/record/page', { params })

/**
 * 重试失败记录（发起新任务）
 * POST /teacher/export/record/{id}/retry
 * 仅本人记录可 retry，越权 404/403
 */
export const retryExport = (recordId: string) =>
  request.post<SubmitExportResp, SubmitExportResp>(`/teacher/export/record/${recordId}/retry`)

/**
 * 删除导出记录（2026-06-11 去过期改版：不再 7 天过期，用户自管；删除连 OSS 文件一起删）
 * DELETE /teacher/export/record/{id}
 * 仅本人记录可删；进行中（排队/生成中）任务 BE 拒绝
 */
export const deleteExportRecord = (recordId: string) =>
  request.delete<void, void>(`/teacher/export/record/${recordId}`)
