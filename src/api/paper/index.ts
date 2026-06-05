import request from '@/http/request'
import type { PaperDetailVo } from '@/api/question/index'

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
  children?: PaperTreeNode[]  // 叶节点不返该字段
}

// page list 元素（misikt 字节级对齐 — 见 02-be-summary §4.2；PRD-B-013 已删 hgScore/directoryName/frameTextContentId）
export interface PaperListItem {
  id: number
  name: string
  questionCount: number
  score: number               // Integer，BE CAST 自 DECIMAL 已去 .00
  suggestTime: number | null
  createTime: string          // 'YYYY-MM-DD' 字符串（不是 ms timestamp）
  finishTime: string | null
  createUser: number
  subjectId: string
  paperType: 1 | 2 | 6        // 1=日常 / 2=月考 / 6=专题
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

// ── PRD-A-005 T4 试卷编辑（重排/删/增题保存）────────────────────────────

/** 编辑保存时单题条目（契约 manual：questionId / sectionId / sort / score）*/
export interface UpdatePaperQuestion {
  questionId: number
  sectionId: number
  sort: number
  score: number
}

/**
 * 大题分区（重命名）— design.md §0.2 SectionBo 契约
 * sectionId 非空 = 更新已有 section name/sort（v1 只支持重命名已有）
 * sectionId 空 = 新建（BE v1 未实现，FE 不发此项）
 */
export interface UpdatePaperSection {
  sectionId: number | null
  name: string
  sort: number
}

/** 试卷编辑保存入参（契约 manual：POST /teacher/exam/paper/update）*/
export interface UpdateExamPaperParams {
  paperId: number
  name?: string
  paperCategoryId?: string | null
  questions: UpdatePaperQuestion[]
  /** 可选：大题重命名（design.md §0.2；BE v1 只处理 sectionId 非空条目）*/
  sections?: UpdatePaperSection[]
  /** 答题时间（分钟）— BE PRD-A-007 Wave1 已支持写 biz_paper.suggest_time */
  suggestTime?: number
}

/**
 * 编辑保存试卷（PRD-A-005 T4 / 契约 manual）。
 * BE 事务内删旧 biz_paper_question 全量重插（按 sort）+ 重算 question_count / 总 score
 * + 更新 paper 元信息，返回更新后的 PaperDetailVo（前端拿来刷新详情）。
 * POST /teacher/exam/paper/update
 * envelope 由拦截器自动拆，业务拿到的就是 PaperDetailVo。
 */
export const updateExamPaper = (params: UpdateExamPaperParams) =>
  request.post<PaperDetailVo, PaperDetailVo>('/teacher/exam/paper/update', params)

// ── PRD-A-005 收尾（A-试卷删除）─────────────────────────────────────────
/**
 * 删除试卷（PRD-A-005 收尾 A 段）。
 * BE owner 校验：非本人卷返非成功码（拦截器 code!==1 抛错），事务内删 paper + section + paper_question。
 * POST /teacher/exam/paper/delete body={paperId}
 * envelope 由拦截器自动拆，成功无业务数据（BE 返 null）。
 */
export const deletePaper = (paperId: number) =>
  request.post<unknown, unknown>('/teacher/exam/paper/delete', { paperId })
