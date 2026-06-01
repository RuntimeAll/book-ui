import request from '@/http/request'

// ── 类型定义（misikt 真响应字节级对齐，证据：smoke/02-lazyTree-resp.json + 03-page-3001-resp.json）
// ────────────────────────────────────────────────────────────────────────

// lazyTree 节点（misikt 返整棵 97 节点树，children 嵌套；叶节点不返 children 字段）
export interface PaperTreeNode {
  id: string                  // 4-15 位数字编码（VARCHAR）
  parentId: string            // '0' 或 '1'（3001 特殊）或父 id
  title: string               // 节点名（misikt 真实字段 — 不是 name）
  sort: number
  hasChildren: boolean
  key: string                 // = id（element-plus tree 用）
  value: string               // = id
  level: number | null        // misikt 没填，固定 null
  nodeDataSum: number | null  // misikt 没填，固定 null
  isShare: '0' | '1'          // 字符串！不是 number
  children?: PaperTreeNode[]  // 叶节点不返该字段
}

// page list 元素（15 字段 misikt 字节级对齐 — 见 02-be-summary §4.2）
export interface PaperListItem {
  id: number
  name: string
  questionCount: number
  score: number               // Integer，BE CAST 自 DECIMAL 已去 .00
  suggestTime: number | null
  createTime: string          // 'YYYY-MM-DD' 字符串（不是 ms timestamp）
  finishTime: string | null
  hgScore: number | null
  createUser: number
  directoryName: string | null
  subjectId: string
  paperType: 1 | 2 | 6        // 1=日常 / 2=月考 / 6=专题
  frameTextContentId: number | null
  status: 1                   // 已发布
  sort: number                // 通常 = id
}

// misikt PageHelper 18 字段标准响应（顺序对齐 02-be-summary §4.3）
export interface MisiktPageVo<T> {
  total: number
  list: T[]
  pageNum: number
  pageSize: number
  size: number
  startRow: number
  endRow: number
  pages: number
  prePage: number
  nextPage: number
  isFirstPage: boolean
  isLastPage: boolean
  hasPreviousPage: boolean
  hasNextPage: boolean
  navigatePages: number
  navigatepageNums: number[]
  navigateFirstPage: number
  navigateLastPage: number
}

// page 入参
export interface PaperPageParams {
  name?: string
  subjectId?: string
  pageIndex: number           // 1-based
  pageSize: number
  /**
   * scope 新契约（后端按此分流）：
   *   'public' — 取 is_share=1 的共享卷
   *   'mine'   — 按当前登录用户 userId 过滤（服务端识别，前端无需传 createBy）
   * 未传 = 后端默认行为（兼容旧调用方）
   */
  scope?: 'public' | 'mine'
  /**
   * @deprecated 旧字段，已被 scope='mine' 取代。
   * 保留以兼容 workspace 聚合页的历史调用，新代码不再使用。
   */
  createBy?: string
}

// lazyTree 入参（BE 忽略，发哪个值都一样；保持 misikt 真站行为）
export interface PaperLazyTreeParams {
  type: number                // 固定 2
  version: number             // 固定 1010
}

// ── API 函数 ─────────────────────────────────────────────────────────────

/**
 * 卷库分类树 — 97 节点 / 3 根（资料库 / 公共试卷 / 专题卷库）
 * POST /teacher/exam/paper/lazyTree
 * envelope 由拦截器自动拆，业务拿到的就是 PaperTreeNode[]
 */
export const getPaperLazyTree = (params: PaperLazyTreeParams = { type: 2, version: 1010 }) =>
  request.post<PaperTreeNode[], PaperTreeNode[]>('/teacher/exam/paper/lazyTree', params)

/**
 * 试卷分页列表 — name LIKE / subjectId prefix-match / sort DESC
 * POST /teacher/exam/paper/page
 */
export const getPaperPage = (params: PaperPageParams) =>
  request.post<MisiktPageVo<PaperListItem>, MisiktPageVo<PaperListItem>>(
    '/teacher/exam/paper/page',
    params,
  )

// ── Q 卡段① 创建试卷 ────────────────────────────────────────────────────

export interface CreateExamPaperParams {
  name: string
  questionIds: number[]
  paperCategoryId?: string | null
}

export interface CreateExamPaperResult {
  paperId: number
  questionCount: number
}

/**
 * 创建试卷 — 工作台 → 输入名称 + 选定题目列表 → 落库（status='1' 即发布）。
 * BE 自动建默认 section（"题目"），所有题挂下面。
 * POST /teacher/exam/paper/create
 */
export const createExamPaper = (params: CreateExamPaperParams) =>
  request.post<CreateExamPaperResult, CreateExamPaperResult>(
    '/teacher/exam/paper/create',
    params,
  )
