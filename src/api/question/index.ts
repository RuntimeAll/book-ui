import request from '@/http/request'

// ── 类型定义 ────────────────────────────────────────────────
// lazyTree 节点（misikt 返整棵树，children 嵌套）
export interface SubjectNode {
  id: string
  name: string
  parentId: string | null
  isShare: string // lazyTree 接口返 STRING '0'/'1'
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
  freeTag?: string | null
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

// page 入参（⚠️ misikt 用 pageIndex 不是 pageNum）
export interface QuestionPageParams {
  pageIndex: number
  pageSize: number
  subjectId?: string
  questionType?: number
  difficulty?: number  // 入参仍用 difficulty（接口入参名）
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
 * 端点推测：POST /teacher/question/removeBasket/{id}（命名对称 addBasket）
 * TODO: playwright 抓取真实端点 — 无登录态时 misikt 不触发 API，待有 session 后验证
 */
export const removeBasket = (questionId: number) =>
  request.post<unknown, unknown>(`/teacher/question/removeBasket/${questionId}`)
