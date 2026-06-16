import request from '@/http/request'

// ---------------------------------------------------------------------------
// PRD-C-100 B6 — AI 记忆维护（个人资料「AI 记忆」分区的数据源）。
//
// 走 /api → book-server :8090（misikt envelope，code===1 判成功，由 http/request 拦截器
// 统一解包返回 response）。owner 由服务端 LoginHelper 从登录态取，不传 body（防越权）。
//
// 三类记忆（memType）：偏好 / 纠正 / 习惯。来源（source）：自动（AI 沉淀）/ 手填（老师维护）。
// enabled 启停：停用的记忆不参与 AI 上下文（视觉置灰），toggle 端点切换。
// ---------------------------------------------------------------------------

/** AI 记忆类型（三类分组） */
export type AiMemType = '偏好' | '纠正' | '习惯'

/** AI 记忆来源（来源徽章用） */
export type AiMemSource = '自动' | '手填'

/** AI 记忆 VO（BE 返回字段；id 雪花全工程 string，禁 number 截尾） */
export interface AiMemoryVO {
  id: string
  /** 记忆类型：偏好 / 纠正 / 习惯 */
  memType: string
  /** 记忆键（短标题，如「难度偏好」） */
  memKey: string
  /** 记忆值（具体内容） */
  memValue: string
  /** 来源：自动（AI 沉淀）/ 手填（老师维护）；缺省按手填 */
  source: string | null
  /** 是否启用（停用的不参与 AI 上下文） */
  enabled: boolean
  /** 置信度 0~1（自动沉淀带，展示用，可空） */
  confidence: number | null
  /** 备注 */
  remark: string | null
  /** 更新时间 */
  updateTime: string | null
}

/** 列表查询参数（memType 过滤 + 只看启用） */
export interface ListAiMemoryParams {
  /** 按类型过滤（偏好/纠正/习惯）；省略 = 全部 */
  memType?: string
  /** 只看启用的（true 时 BE 过滤 enabled=true） */
  enabledOnly?: boolean
}

/** 新增 / 更新入参（id/owner/source 自动维度由 BE 处理，手填默认 source=手填） */
export interface AiMemoryBo {
  /** 记忆类型：偏好 / 纠正 / 习惯（必填） */
  memType: string
  /** 记忆键（必填） */
  memKey: string
  /** 记忆值（必填） */
  memValue: string
  /** 来源（手填默认手填；通常 FE 不传，BE 兜底） */
  source?: string
  /** 置信度（手填可不传） */
  confidence?: number
  /** 备注 */
  remark?: string
}

/** 列表：GET /teacher/ai-memory/list?memType=&enabledOnly= */
export const listAiMemory = (params: ListAiMemoryParams = {}) =>
  request.get<AiMemoryVO[], AiMemoryVO[]>('/teacher/ai-memory/list', { params })

/** 新增：POST /teacher/ai-memory */
export const addAiMemory = (bo: AiMemoryBo) =>
  request.post<AiMemoryVO, AiMemoryVO>('/teacher/ai-memory', bo)

/** 更新：PUT /teacher/ai-memory/{id} */
export const updateAiMemory = (id: string, bo: AiMemoryBo) =>
  request.put<AiMemoryVO, AiMemoryVO>(`/teacher/ai-memory/${id}`, bo)

/** 删除：DELETE /teacher/ai-memory/{id} */
export const deleteAiMemory = (id: string) =>
  request.delete<void, void>(`/teacher/ai-memory/${id}`)

/** 启停切换：POST /teacher/ai-memory/{id}/toggle（返回切换后的 VO） */
export const toggleAiMemory = (id: string) =>
  request.post<AiMemoryVO, AiMemoryVO>(`/teacher/ai-memory/${id}/toggle`)
