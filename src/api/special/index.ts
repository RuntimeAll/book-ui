/**
 * PRD-003 专项（book_type='special'）API 层 —— C 位独占面。
 *
 * 所有端点走 /teacher/special/** misikt envelope（{code:1,message,response}），
 * 拦截器已解包，方法直接拿 response。雪花 id 全程 string（json-bigint 保精度）。
 *
 * 端点面见 codeplace-C/prd/PRD-003 批1 SpecialController：
 *   专项 CRUD + 区块(sec)/难度档(tier)增删改序 + 题目增删改/拖排 + 冻结面 pick
 *   + 材料位(special_ids) bind/unbind/materials + 导出(双卷 PDF, used_count+1)。
 */
import request from '@/http/request'

// ── 类型 ─────────────────────────────────────────────────────────────────

/** 专项书概要（列表 / 材料位）。 */
export interface SpecialSummary {
  id: string
  bookType: string
  title: string
  subjectId?: string | null
  grade?: string | null
  status?: string | null
  styleMetaJson?: string | null
  /** 题目总数（listMine / materials 附带） */
  itemCount?: number
}

/** 专项内一题（override 副本 + 留空高度）。 */
export interface SpecialItemVO {
  id: string
  kind: string
  questionId: string | null
  seq: number | null
  usedCount: number | null
  /** 答题留空高度 mm（题目卷版式）；null=用默认 */
  gap: number | null
  /** 本专项链路的 override 副本（不影响源题库）；null=无覆盖 */
  override: Record<string, unknown> | null
}

/** 难度档节点（tier），meta 存 star/label/gap 等版式元数据。 */
export interface SpecialTierVO {
  id: string
  parentId: string | null
  nodeType: string
  name: string
  seq: number | null
  kpId?: string | null
  meta?: Record<string, unknown> | null
  items: SpecialItemVO[]
}

/** 区块节点（sec）。 */
export interface SpecialSecVO {
  id: string
  parentId: string | null
  nodeType: string
  name: string
  seq: number | null
  kpId?: string | null
  meta?: Record<string, unknown> | null
  tiers: SpecialTierVO[]
  /** 直挂 sec（无 tier 分组）的题 */
  items: SpecialItemVO[]
}

/** 专项全树详情。 */
export interface SpecialDetail extends SpecialSummary {
  secs: SpecialSecVO[]
}

/** 建专项入参。 */
export interface CreateSpecialBo {
  title: string
  subjectId?: string
  grade?: string
  edition?: string
  remark?: string
  styleMetaJson?: Record<string, unknown> | string
}

/** 建节点入参（parentId 空=sec / 非空=挂该 sec 下的 tier）。 */
export interface CreateNodeBo {
  name: string
  parentId?: string | null
  nodeType?: string
  kpId?: string | null
  meta?: Record<string, unknown>
  seq?: number
}

/** 加题入参。 */
export interface AddItemBo {
  questionId: string
  overrideJson?: Record<string, unknown>
  gap?: number | null
}

/** 改题入参（override/gap/移动节点/seq）。 */
export interface UpdateItemBo {
  overrideJson?: Record<string, unknown> | null
  gap?: number | null
  nodeId?: string
  seq?: number
}

/** 导出请求（契约 §10）。 */
export interface SpecialExportBo {
  /** 要出哪些卷；缺省 = 题目卷 + 答案卷 */
  papers?: Array<'question' | 'answer'>
  /** 答案卷附【详解】 */
  withAnalysis?: boolean
  /** 显示难度星标（★）；默认 false（学生卷面纪律） */
  withStars?: boolean
}

/** 导出产物（同步返回双卷 URL）。 */
export interface SpecialExportResult {
  specialId: string
  /** 题目卷 PDF（OSS URL）；未勾选题目卷则缺省 */
  questionUrl?: string | null
  /** 答案卷 PDF（OSS URL）；未勾选答案卷则缺省 */
  answerUrl?: string | null
  /** 本次导出对多少道题 used_count+1 */
  markedCount?: number
}

/** 课次材料（已绑专项概要）。 */
export interface LessonMaterials {
  lessonId: string
  specialIds: string[]
  specials: SpecialSummary[]
}

// ── 专项 CRUD ─────────────────────────────────────────────────────────────

export const createSpecial = (bo: CreateSpecialBo) =>
  request.post<{ id: string }, { id: string }>('/teacher/special', bo)

export const listMySpecials = () =>
  request.get<SpecialSummary[], SpecialSummary[]>('/teacher/special/list')

export const getSpecialDetail = (specialId: string) =>
  request.get<SpecialDetail, SpecialDetail>(`/teacher/special/${specialId}`)

export const updateSpecial = (specialId: string, body: Partial<CreateSpecialBo> & { status?: string }) =>
  request.put<void, void>(`/teacher/special/${specialId}`, body)

export const deleteSpecial = (specialId: string) =>
  request.delete<void, void>(`/teacher/special/${specialId}`)

// ── 节点（区块 sec / 难度档 tier）增删改序 ─────────────────────────────────

export const createSpecialNode = (specialId: string, bo: CreateNodeBo) =>
  request.post<{ id: string }, { id: string }>(`/teacher/special/${specialId}/node`, bo)

export const updateSpecialNode = (
  nodeId: string,
  body: { name?: string; nodeType?: string; kpId?: string | null; meta?: Record<string, unknown> | null; seq?: number },
) => request.put<void, void>(`/teacher/special/node/${nodeId}`, body)

export const deleteSpecialNode = (nodeId: string) =>
  request.delete<void, void>(`/teacher/special/node/${nodeId}`)

export const reorderSpecialNodes = (specialId: string, nodeIds: string[]) =>
  request.put<void, void>(`/teacher/special/${specialId}/nodes/reorder`, { nodeIds })

// ── 题目 item 增删改 / 拖排 ─────────────────────────────────────────────────

export const addSpecialItem = (nodeId: string, bo: AddItemBo) =>
  request.post<{ id: string }, { id: string }>(`/teacher/special/node/${nodeId}/item`, bo)

export const updateSpecialItem = (itemId: string, bo: UpdateItemBo) =>
  request.put<void, void>(`/teacher/special/item/${itemId}`, bo)

export const deleteSpecialItem = (itemId: string) =>
  request.delete<void, void>(`/teacher/special/item/${itemId}`)

export const reorderSpecialItems = (nodeId: string, itemIds: string[]) =>
  request.put<void, void>(`/teacher/special/node/${nodeId}/items/reorder`, { itemIds })

// ── 冻结面 pick（全站「＋入专项」去向）─────────────────────────────────────

export const pickIntoSpecial = (
  specialId: string,
  body: { questionId?: string; nodeId?: string; overrideJson?: Record<string, unknown>; secHint?: string },
) => request.post<{ secId: string; addedItemIds: string[]; addedCount: number }, { secId: string; addedItemIds: string[]; addedCount: number }>(
  `/teacher/special/${specialId}/pick`,
  body,
)

// ── 材料位（special_ids 单列）─────────────────────────────────────────────

export const bindSpecialToLesson = (lessonId: string, specialId: string) =>
  request.post<{ specialIds: string[] }, { specialIds: string[] }>(`/teacher/special/lesson/${lessonId}/bind`, { specialId })

export const unbindSpecialFromLesson = (lessonId: string, specialId: string) =>
  request.post<{ specialIds: string[] }, { specialIds: string[] }>(`/teacher/special/lesson/${lessonId}/unbind`, { specialId })

export const getLessonMaterials = (lessonId: string) =>
  request.get<LessonMaterials, LessonMaterials>(`/teacher/special/lesson/${lessonId}/materials`)

// ── 导出（双卷 PDF；导出即 used_count+1）─────────────────────────────────────

export const exportSpecial = (specialId: string, bo: SpecialExportBo) =>
  request.post<SpecialExportResult, SpecialExportResult>(`/teacher/special/${specialId}/export`, bo)
