import request from '@/http/request'

// ===========================================================================
// PRD-002 书架与书实体 —— FE API 客户端（对齐 BE ShelfController /teacher/shelf/**）。
//
// 走 /api → book-server（misikt envelope，code===1 判成功，http/request 拦截器统一解包返 response）。
// 全部端点 @SaCheckLogin，owner 由服务端登录态取，不传 body。
//
// 🔴 id 一律 string（雪花 19 位，防 number 截尾）——BE 所有 VO 已把 id/questionId/kpId 序列化为 string。
// 契约正本 = codeplace-A/prd/PRD-002/PRD.md §10 + BE ShelfController/ShelfService。
// ===========================================================================

// ---------------------------------------------------------------------------
// 一、类型
// ---------------------------------------------------------------------------

/**
 * 书类型：lecture 讲义 / workbook 练习册 / textbook 电子课本 / special 专项
 *        / daily_punch 每日打卡（PRD-013 D1：打卡内容 = 一本有结构的书，天=节点）
 */
export type BookType = 'lecture' | 'workbook' | 'textbook' | 'special' | 'daily_punch'
export const BOOK_TYPE_LABEL: Record<BookType, string> = {
  lecture: '讲义',
  workbook: '练习册',
  textbook: '电子课本',
  special: '专项',
  daily_punch: '每日打卡',
}

/** 内容项类型：explain 讲解块 / question 题引用 */
export type ItemKind = 'explain' | 'question'

/**
 * override_json 书内副本（D3）。改后题面只影响本书，题库原题不动。
 * 与 QuestionContent 渲染兼容：stem 走富文本 text；options 为选择题选项文本数组。
 */
export interface ItemOverride {
  /** 改后题干（富文本 Markdown + LaTeX；非空即渲染，覆盖原题 stem） */
  stem?: string
  /** 改后选项文本（选择题；不含 A/B/C 前缀，渲染层加） */
  options?: string[]
  [k: string]: unknown
}

/** explain_json 讲解块（书自持，D2）。 */
export interface ItemExplain {
  /** 讲解标题（如「知识点讲解」） */
  title?: string
  /** 讲解正文（富文本 Markdown + LaTeX） */
  text?: string
  [k: string]: unknown
}

/** 书卡片 / 详情（bookBrief）。withStats=true 时带 nodeCount/itemCount/questionCount。 */
export interface ShelfBookVO {
  id: string
  bookType: BookType | string
  title: string
  subjectId?: string | null
  grade?: string | null
  edition?: string | null
  ownerId?: string | null
  /** 状态：'0' 草稿 / '1' 启用（BE 默认建书 '0'） */
  status?: string | null
  /** 公开可读：true=全员可见（读/导出/绑定），写仍限 owner */
  isPublic?: boolean
  styleMeta?: Record<string, unknown> | null
  sourceJobId?: string | null
  remark?: string | null
  createTime?: string
  updateTime?: string
  // withStats
  nodeCount?: number
  itemCount?: number
  questionCount?: number
  // 结构化维度码（列表页由 BE 从 biz_subject 结构列回填，对齐卷库筛选；未分类书为 null）
  /** 学科 biz_edu_subject（1数学 2科学） */
  subjectCode?: number | null
  /** 学段 biz_edu_stage（1小学 2初中 3高中） */
  stageCode?: number | null
  /** 年级 biz_edu_grade（1一年级…9九年级 10高一…） */
  gradeCode?: number | null
  /** 册 biz_edu_volume（1上册 2下册） */
  volumeCode?: number | null
  /** 版本 biz_edu_edition（1浙教 2人教…） */
  editionCode?: number | null
}

/** 内容项 VO */
export interface ShelfItemVO {
  id: string
  bookId: string
  nodeId: string
  seq: number
  kind: ItemKind | string
  questionId?: string | null
  override?: ItemOverride | null
  explain?: ItemExplain | null
  usedCount?: number
}

/** 节点 VO（整树 structure 返回时含 items + children 递归） */
export interface ShelfNodeVO {
  id: string
  bookId: string
  parentId?: string | null
  seq: number
  nodeType?: string | null
  name: string
  kpId?: string | null
  meta?: Record<string, unknown> | null
  items?: ShelfItemVO[]
  children?: ShelfNodeVO[]
}

/** 书结构整树（bookBrief + tree 根节点数组） */
export interface ShelfStructureVO extends ShelfBookVO {
  tree: ShelfNodeVO[]
}

/** 建/改书入参 */
export interface ShelfBookBo {
  title: string
  bookType?: BookType | string
  subjectId?: string
  grade?: string
  edition?: string
  status?: string
  styleMeta?: Record<string, unknown>
  sourceJobId?: string
  remark?: string
}

/** 建/改节点入参 */
export interface ShelfNodeBo {
  bookId?: string
  parentId?: string | null
  seq?: number
  nodeType?: string
  name?: string
  kpId?: string
  meta?: Record<string, unknown>
}

/** 建/改内容项入参（questionId 用 string 收防雪花截尾） */
export interface ShelfItemBo {
  nodeId?: string
  seq?: number
  kind?: ItemKind | string
  questionId?: string
  override?: ItemOverride
  explain?: ItemExplain
}

/** 列表返回 */
export interface ShelfPageResult {
  rows: ShelfBookVO[]
  total: number
}

/** 书列表筛选入参 */
export interface ShelfPageParams {
  bookType?: BookType | string
  subjectId?: string
  status?: string
}

// ---------------------------------------------------------------------------
// 二、API（全挂 /teacher/shelf）
// ---------------------------------------------------------------------------

const BASE = '/teacher/shelf'

/** 建书：POST book → {id} */
export const createBook = (bo: ShelfBookBo) =>
  request.post<{ id: string }, { id: string }>(`${BASE}/book`, bo)

/** 改书：PUT book/{id} */
export const updateBook = (id: string, bo: ShelfBookBo) =>
  request.put<void, void>(`${BASE}/book/${id}`, bo)

/** 我的书列表（owner 过滤 + type/subject/status 筛选） */
export const pageBooks = (params: ShelfPageParams = {}) =>
  request.get<ShelfPageResult, ShelfPageResult>(`${BASE}/book/page`, { params })

/** 书详情（含统计） */
export const getBook = (id: string) =>
  request.get<ShelfBookVO, ShelfBookVO>(`${BASE}/book/${id}`)

/** 书结构整树（目录树 + 节点内容项，一次可渲染） */
export const getBookStructure = (id: string) =>
  request.get<ShelfStructureVO, ShelfStructureVO>(`${BASE}/book/${id}/structure`)

/** 删书（级联节点 + 内容项） */
export const deleteBook = (id: string) =>
  request.delete<void, void>(`${BASE}/book/${id}`)

/** 增节点：POST node → {id} */
export const addNode = (bo: ShelfNodeBo) =>
  request.post<{ id: string }, { id: string }>(`${BASE}/node`, bo)

/** 改节点：PUT node/{id} */
export const updateNode = (id: string, bo: ShelfNodeBo) =>
  request.put<void, void>(`${BASE}/node/${id}`, bo)

/** 删节点（级联子树 + 项） */
export const deleteNode = (id: string) =>
  request.delete<void, void>(`${BASE}/node/${id}`)

/** 同层节点重排 */
export const reorderNodes = (ids: string[]) =>
  request.post<void, void>(`${BASE}/node/reorder`, { ids })

/** 增内容项：POST item → {id} */
export const addItem = (bo: ShelfItemBo) =>
  request.post<{ id: string }, { id: string }>(`${BASE}/item`, bo)

/** 改内容项（含 override_json 写入，D3） */
export const updateItem = (id: string, bo: ShelfItemBo) =>
  request.put<void, void>(`${BASE}/item/${id}`, bo)

/** 删内容项 */
export const deleteItem = (id: string) =>
  request.delete<void, void>(`${BASE}/item/${id}`)

/** 同节点内容项重排 */
export const reorderItems = (ids: string[]) =>
  request.post<void, void>(`${BASE}/item/reorder`, { ids })

/** used_count +1（上课认证；PRD-003 导出回写通路）→ {usedCount} */
export const incrItemUsed = (id: string) =>
  request.post<{ usedCount: number }, { usedCount: number }>(`${BASE}/item/${id}/used`)

// ---------------------------------------------------------------------------
// 课时 ↔ 书章节绑定（备课材料位，biz_course_plan_lesson.book_node_ids）
// ---------------------------------------------------------------------------

/** 课时已绑书章节材料（BE 按 nodeId 反查书名/节名 + 子树题数） */
export interface LessonBookMaterialVO {
  nodeId: string
  nodeTitle: string
  bookId: string
  bookTitle: string
  /** 该节点子树题数 */
  questionCount?: number
}

/** bind/unbind 共用返回（最新 bookNodeIds 全量） */
export interface LessonBindNodeResult {
  lessonId: string
  bookNodeIds: string[]
}

/** 课时书章节材料返回（materials 为可渲染卡片，含书名/节名/子树题数） */
export interface LessonBookMaterialsResult extends LessonBindNodeResult {
  materials: LessonBookMaterialVO[]
}

/** 绑书章节到课时：POST lesson/{lessonId}/bind-node {nodeId} */
export const bindBookNodeToLesson = (lessonId: string, nodeId: string) =>
  request.post<LessonBindNodeResult, LessonBindNodeResult>(`${BASE}/lesson/${lessonId}/bind-node`, { nodeId })

/** 解绑书章节：POST lesson/{lessonId}/unbind-node {nodeId} */
export const unbindBookNodeFromLesson = (lessonId: string, nodeId: string) =>
  request.post<LessonBindNodeResult, LessonBindNodeResult>(`${BASE}/lesson/${lessonId}/unbind-node`, { nodeId })

/** 课时已绑书章节材料列表：GET lesson/{lessonId}/book-materials */
export const getLessonBookMaterials = (lessonId: string) =>
  request.get<LessonBookMaterialsResult, LessonBookMaterialsResult>(`${BASE}/lesson/${lessonId}/book-materials`)

// ---------------------------------------------------------------------------
// 整书导出 PDF（BE BookExportService）
// ---------------------------------------------------------------------------

/** 整书导出入参。textbook 图片书无答案概念，不传 withAnswers。 */
export interface BookExportBo {
  /** 题后附【答案】区（answer_text_content；无答案的题自动跳过） */
  withAnswers?: boolean
}

/** 整书导出结果（BE 返 {url, pages, bookId, bookType}） */
export interface BookExportResult {
  /** PDF 下载地址（OSS） */
  url: string
  /** 总页数 */
  pages?: number
  bookId?: string
  bookType?: string
}

/**
 * 整书导出 PDF：POST book/{bookId}/export → {url, pages}。
 * 讲义/练习册=分讲 HTML→Chrome→PDF 合并；电子课本=整页图逐页拼 A4。
 * 🔴 同步长任务（每讲 Chrome 渲染 60s 守卫，大书 1-3 分钟）——超时放宽 5 分钟覆盖默认 15s。
 */
export const exportBook = (bookId: string, bo: BookExportBo = {}) =>
  request.post<BookExportResult, BookExportResult>(`${BASE}/book/${bookId}/export`, bo, {
    timeout: 300_000,
  })

// ---------------------------------------------------------------------------
// 三、A→C 挑题交接面（契约§3；C 实现，A 书浏览页调用，未上线时容错）
// ---------------------------------------------------------------------------

/** 入专项入参（body {questionId?|nodeId?, overrideJson?, secHint?}，契约§3 冻结） */
export interface SpecialPickBo {
  questionId?: string
  nodeId?: string
  overrideJson?: ItemOverride
  secHint?: string
}

/**
 * 挑题入专项：POST /teacher/special/{specialId}/pick（C 线端点）。
 * 🔴 C 线可能未上线：调用方需 catch 404/网络错给友好提示，不崩页。
 */
export const pickToSpecial = (specialId: string, bo: SpecialPickBo) =>
  request.post<unknown, unknown>(`/teacher/special/${specialId}/pick`, bo)
