import request from '@/http/request'

// ===========================================================================
// PRD-006 录题比对审核 —— FE API 客户端（对齐 BE ReviewController /teacher/review/**）。
//
// 走 /api → book-server（misikt envelope，code===1 判成功，http/request 拦截器统一解包返 response）。
// 全部端点 @SaCheckLogin，登录态由服务端取。
//
// 🔴 id 一律 string（雪花 19 位，防 number 截尾）——BE 已把 id/bookId/questionId 序列化为 string。
//    bookId 作为 @RequestParam Long / body 里由 BE idOf 解析，前端一律传字符串。
// 契约正本 = codeplace-A/prd/PRD-006/PRD.md + BE ReviewController/ReviewService。
// ===========================================================================

const BASE = '/teacher/review'

// ---------------------------------------------------------------------------
// 一、类型
// ---------------------------------------------------------------------------

/** 审核进度：GET /progress */
export interface ReviewProgress {
  bookId?: string
  /** 源 PDF 总页数（优先源 PDF 页数，缺则回退 source_page 最大值；0 = 未知） */
  totalPages: number
  /** 已确认页数 */
  reviewedPages: number
}

/** 源页渲染：GET /source-page（DPI 144 PNG base64） */
export interface ReviewSourcePage {
  bookId?: string
  page: number
  totalPages: number
  mime?: string
  /** 纯 base64（不含前缀） */
  base64?: string
  /** data:image/png;base64,... 完整可直接塞 <img>/<el-image> */
  image?: string
}

/**
 * 页内题项（question / explain 混排，按 seq）。
 * 🔴 blockJson / explainJson 后端已 JSON 解析成对象（非字符串）；解析失败回退原始串。
 */
export interface ReviewPageItem {
  itemId: string
  seq: number | null
  kind: 'question' | 'explain' | string
  // question 专属
  questionId?: string | null
  stem?: string | null
  /** 结构化网格块（已解析对象；渲染前 JSON.stringify 交给 QuestionCard/parseBlockDoc） */
  blockJson?: unknown
  /** 审核置信度 0-100：>=90 可速过 / 60-89 常规 / <60 重点审；null=未评（评审效率字段） */
  confidence?: number | null
  // explain 专属
  explainJson?: { title?: string; text?: string; [k: string]: unknown } | string | null
}

/** 页内题项返回 */
export interface ReviewPageItems {
  bookId?: string
  page: number
  items: ReviewPageItem[]
}

/** 页级确认返回 */
export interface ConfirmPageResult {
  id?: string
  bookId?: string
  page?: number
  reviewed: number
}

/** 问题类型闭集（设计稿 FP5） */
export const ISSUE_TYPES = ['切分错位', '图缺失', '选项脱节', '公式丢失', '措辞错', '书写空间', '其它'] as const
export type IssueType = (typeof ISSUE_TYPES)[number]

/**
 * 问题状态闭集 = 协同闭环流转（PRD-006 增强 2026-07-21）：
 *   待处理（老师登记，待本地 Claude 处理）
 *     → 待确认（本地 Claude 已改，待老师在系统里点确认）
 *       → 已确认（老师确认修改完成 = 这条真正闭环）
 *   搁置（本轮不处理）
 * 🔴 老师侧核心动作 = 把「待确认」逐条点成「已确认」，全部已确认 = 本书问题闭环。
 */
export const ISSUE_STATUSES = ['待处理', '待确认', '已确认', '搁置'] as const
export type IssueStatus = (typeof ISSUE_STATUSES)[number]

/**
 * 快捷问题标签目录（PRD-006 增强：审核记问题「零打字为主」）。
 * 交互 = 点一个标签即记一条问题：issueType 存【大类 category】、description 存【标签文字 tag】。
 * 覆盖用户实测高频问题（图/排版/内容三大类），可连点多个一次记多条。
 */
export interface QuickIssueGroup {
  /** 大类（存入 issueType，也是问题清单可筛选口径） */
  category: string
  /** 该类下的快捷标签（存入 description） */
  tags: string[]
}
export const QUICK_ISSUE_GROUPS: QuickIssueGroup[] = [
  { category: '图类', tags: ['图太大', '图太小', '比例失调', '图缺失', '图错位'] },
  { category: '排版类', tags: ['排版错位', '居中异常', '空格异常', '选项错位', '换行错'] },
  { category: '内容类', tags: ['知识点绑错', '题型错', '难度错', '内容缺失', '公式丢失', '切分错位', '答案错'] },
]

/** 登记问题入参（questionId 可空 = 整页问题） */
export interface CreateIssueBo {
  bookId: string
  questionId?: string | null
  sourcePage: number
  issueType: string
  description?: string
}

/** 问题登记行（GET /issues） */
export interface ReviewIssue {
  id: string
  bookId: string
  questionId?: string | null
  sourcePage?: number | null
  issueType: string
  description?: string | null
  status: string
  createBy?: string | null
  createTime?: string | null
}

// ---------------------------------------------------------------------------
// 二、API
// ---------------------------------------------------------------------------

/** 审核进度：GET /progress?bookId */
export const getProgress = (bookId: string) =>
  request.get<ReviewProgress, ReviewProgress>(`${BASE}/progress`, { params: { bookId } })

/** 源页渲染：GET /source-page?bookId&page（同步渲染，放宽超时到 30s） */
export const getSourcePage = (bookId: string, page: number) =>
  request.get<ReviewSourcePage, ReviewSourcePage>(`${BASE}/source-page`, {
    params: { bookId, page },
    timeout: 30_000,
  })

/** 页内题项：GET /page-items?bookId&page */
export const getPageItems = (bookId: string, page: number) =>
  request.get<ReviewPageItems, ReviewPageItems>(`${BASE}/page-items`, { params: { bookId, page } })

/** 页级确认：PUT /confirm-page body{bookId,page} */
export const confirmPage = (bookId: string, page: number) =>
  request.put<ConfirmPageResult, ConfirmPageResult>(`${BASE}/confirm-page`, { bookId, page })

/** 登记问题：POST /issue → {id} */
export const createIssue = (bo: CreateIssueBo) =>
  request.post<{ id: string }, { id: string }>(`${BASE}/issue`, bo)

/** 问题列表：GET /issues?bookId&type?&status? */
export const listIssues = (bookId: string, type?: string, status?: string) =>
  request.get<ReviewIssue[], ReviewIssue[]>(`${BASE}/issues`, {
    params: { bookId, ...(type ? { type } : {}), ...(status ? { status } : {}) },
  })

/** 更新问题状态：PUT /issue/{id}/status body{status} */
export const updateIssueStatus = (id: string, status: string) =>
  request.put<{ id: string; status: string }, { id: string; status: string }>(
    `${BASE}/issue/${id}/status`,
    { status },
  )
