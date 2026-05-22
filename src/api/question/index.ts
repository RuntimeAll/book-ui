import request from '@/http/request'

// ── 类型定义 ────────────────────────────────────────────────
// lazyTree 节点（misikt 返整棵树，children 嵌套）
// ⚠️ 真实字段名是 title 不是 name（A2-question-lazyTree.json 抓包证据）
export interface SubjectNode {
  id: string
  title: string                  // 节点名称（misikt 真实字段）
  parentId: string | null
  hasChildren?: boolean
  isShare?: string | null
  key?: string
  value?: string
  level?: number
  sort?: number
  nodeDataSum?: number | null
  children?: SubjectNode[]
}

// 知识点 tag（misikt 真实字段：questionKnowledges）
export interface QuestionKnowledge {
  id: number | null
  questionId: number
  knowledgeId: string
  knowledgeName: string
  knowledgeImg?: string
  knowledgeVideo?: string | null
  createTime?: string | null
}

// 自由标签（X 卡 段② BE 契约 — biz_free_tag 字典化）
// 一个题最多 N 个，按 position asc 排序（0 = 第一个，BE 已排好）
export interface FreeTagVo {
  id: number
  name: string
  position: number
}

// 题目分页列表项（基于实际 /question/page 响应反推）
export interface QuestionItem {
  id: number
  questionType: number // 1=选择 / 4=填空 / 5=简答
  difficult: number | null   // ⚠️ 真实字段名是 difficult 不是 difficulty（4星制）
  stemImg: string | null      // 题干图 URL（完整 CDN URL）
  stemText?: string | null    // 题干文本
  answerImg?: string | null
  explainImg?: string | null
  fileBin?: string | null
  videoUrl?: string | null
  questionKnowledges?: QuestionKnowledge[]    // ⚠️ 真实字段名
  questionStdKnowledges?: QuestionKnowledge[] | null
  subjectId?: string
  createTime?: string
  createUser?: number
  score?: number
  status?: number
  shortTitle?: string | null
  isShare?: number | string
  isSelected?: boolean | null
  isWrongBook?: boolean | null
  isRepeat?: number
  repeatQuestionId?: number | null
  examYear?: string | null
  examPaperId?: number | null
  examPaperName?: string | null
  scoreStd?: string | null
  freeTag?: string | null              // 老字段（字符串），段③字典化后保留兼容
  freeTags?: FreeTagVo[]               // X 卡 段② BE 新字段，position asc 已排序
}

// page 接口响应（PageHelper 结构）
export interface QuestionPageResult {
  total: number
  list: QuestionItem[]
  pageNum: number
  pageSize: number
  pages: number
  isFirstPage: boolean
  isLastPage: boolean
}

// page 入参（⚠️ misikt 用 pageIndex 不是 pageNum；difficult 无 y — BE BO 字段对齐）
export interface QuestionPageParams {
  pageIndex: number
  pageSize: number
  subjectId?: string
  questionType?: number
  difficult?: number  // ⚠️ BE QuestionPageBo.difficult 无 y，FE 必须对齐字段名才能让难度筛选生效
  keyWord?: string
  notTaskQuestion?: number
  notUsedQuestion?: number
}

// 题目详情（GET /teacher/question/{id} 返）
export interface QuestionDetail extends QuestionItem {}

// 收藏夹文件夹（GET /teacher/center/q-folder/tree 返回树结构）
// misikt 真站端点：/api/teacher/center/q-folder/tree（playwright 已抓取确认）
export interface FavoriteFolder {
  id: number | string
  name: string
  pid?: number | string | null
  count?: number           // 已收藏题数
  children?: FavoriteFolder[]
  sort?: number
  createTime?: string
}

// 收藏状态响应
export interface FavoriteResult {
  favorite?: boolean
  isFavorite?: boolean
}

// basketNum 响应
export type BasketNumResult = number | { count: number } | { basketNum: number }

// queryBasket 单条题
export type BasketItem = QuestionItem

// ── API 函数 ────────────────────────────────────────────────

/**
 * 懒加载章节树（实际 misikt 一次返整棵树）
 */
export const lazyTree = (parentId: string | number = 0) =>
  request.post<SubjectNode[], SubjectNode[]>('/teacher/question/lazyTree', { parentId })

/**
 * 分页拉题列表（⚠️ 入参 pageIndex 不是 pageNum）
 */
export const questionPage = (params: QuestionPageParams) =>
  request.post<QuestionPageResult, QuestionPageResult>('/teacher/question/page', params)

/**
 * 拉试题栏角标数量
 */
export const basketNum = () =>
  request.post<BasketNumResult, BasketNumResult>('/teacher/question/basketNum')

/**
 * 加入试题栏
 */
export const addBasket = (questionId: number) =>
  request.post<unknown, unknown>(`/teacher/question/addBasket/${questionId}`)

/**
 * 判断是否已收藏（GET，每题独立调）
 */
export const getFavorite = (questionId: number) =>
  request.get<FavoriteResult, FavoriteResult>(`/teacher/qd/favorite/${questionId}`)

/**
 * 收藏题目（POST /teacher/qd/favorite/{id}）
 * folderId 可选 — misikt 真站接口是否支持 folderId 参数待验证（需登录态 playwright 才能抓 payload）
 * 当前：不带 folderId 调用（兼容现状），folderId 本地记录
 */
export const addFavorite = (questionId: number, folderId?: number | string) =>
  request.post<unknown, unknown>(`/teacher/qd/favorite/${questionId}`, folderId ? { folderId } : undefined)

/**
 * 拉收藏夹目录树（GET /teacher/center/q-folder/tree）
 * misikt 真站端点：playwright 已确认（无登录态返 401，有登录态时 response 待验证字段结构）
 * 推测响应：{ code: 200, response: FavoriteFolder[] }（树形结构，一级为收藏夹，children 为子夹）
 */
export const getFavoriteFolderTree = () =>
  request.get<FavoriteFolder[], FavoriteFolder[]>('/teacher/center/q-folder/tree')

/**
 * 取消收藏（DELETE /teacher/qd/favorite/{id}）
 */
export const removeFavorite = (questionId: number) =>
  request.delete<unknown, unknown>(`/teacher/qd/favorite/${questionId}`)

/**
 * 拉试题栏内所有题
 */
export const queryBasket = () =>
  request.post<BasketItem[], BasketItem[]>('/teacher/question/queryBasket')

/**
 * 生成组卷草稿（trailing slash 是 misikt 特征）
 */
export const genExamData = () =>
  request.post<unknown, unknown>('/teacher/question/genExamData/')

/**
 * 从试题栏移除题目
 * 端点：POST /teacher/question/cancel/{id}（misikt 真站命名，BE QuestionBasketController 已实现）
 * 函数名保留 removeBasket — FE 内部语义更清晰，调用方无感
 */
export const removeBasket = (questionId: number) =>
  request.post<unknown, unknown>(`/teacher/question/cancel/${questionId}`)

// ── 题目详情 / 原卷 / 错题栏接口（第十二波新增）──────────────────

// 收录情况单条（试卷条目）
// GET /teacher/question/{id}/sources 真实字段待 playwright 验证
// 当前基于 A3-question-page.json 字段推断：examPaperId / examPaperName 已在 QuestionItem 里
export interface QuestionSource {
  examPaperId: number
  examPaperName: string
  examYear?: string | null
  sort?: number | null
}

// 我的备注（V1 BE 返单对象 / null — uk_user_question 每用户每题最多 1 条）
// GET /teacher/qd/note/{questionId}
export interface QuestionNote {
  content: string
  updateTime?: string | null
}

// 相似题 — 结构同 QuestionItem
export type SimilarQuestion = QuestionItem

// 原卷题目单条（GET /teacher/paper/source/{id} 下的题列表项）
// 字段基于 QuestionItem 推断，是否一致待 playwright 验证
export interface PaperSourceQuestion extends QuestionItem {
  sort?: number | null
}

// 原卷详情响应
export interface PaperSourceDetail {
  paperId: number
  paperName: string
  examYear?: string | null
  questions: PaperSourceQuestion[]
}

/**
 * 获取题目详情
 * POST /teacher/question/select/{id}（A4 抓包证据 — misikt 真端点）
 */
export const getQuestionDetail = (questionId: number) =>
  request.post<QuestionDetail, QuestionDetail>(`/teacher/question/select/${questionId}`)

/**
 * 获取我的备注（V1：BE 返单对象或 null）
 * GET /teacher/qd/note/{questionId}
 */
export const getQuestionNote = (questionId: number) =>
  request.get<QuestionNote | null, QuestionNote | null>(`/teacher/qd/note/${questionId}`)

/**
 * 添加/更新备注（V1：upsert，路径带 id + body 仅 content）
 * POST /teacher/qd/note/{id}
 */
export const saveQuestionNote = (questionId: number, content: string) =>
  request.post<unknown, unknown>(`/teacher/qd/note/${questionId}`, { content })

/**
 * 获取收录情况（这道题被收录进了哪些试卷）
 * GET /teacher/qd/papers/{id}（A 端点清单 / 抓包确认）
 */
export const getQuestionSources = (questionId: number) =>
  request.get<QuestionSource[], QuestionSource[]>(`/teacher/qd/papers/${questionId}`)

/**
 * 获取相似题
 * GET /teacher/question/similar/{id}
 * 无登录态无法验证
 */
export const getSimilarQuestions = (questionId: number) =>
  request.get<SimilarQuestion[], SimilarQuestion[]>(`/teacher/question/similar/${questionId}`)

/**
 * 获取原卷详情（试卷所有题）
 * GET /teacher/paper/source/{id}
 * 无登录态无法验证
 */
export const getPaperSource = (paperId: number | string) =>
  request.get<PaperSourceDetail, PaperSourceDetail>(`/teacher/paper/source/${paperId}`)

// V1 删除：addErrorBasket / removeErrorBasket / reportQuestion 三个 API 函数
// 原因：错题栏 + 题目报错本卡范围不实现，view 改为 noop + ElMessage warning "功能开发中"。
// 错题栏体验：localStorage-only（视图层 view-only），不调 BE 端点。
