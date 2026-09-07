import request from '@/http/request'
import { isAxiosError, type AxiosRequestConfig } from 'axios'
import { getPaperDetail, type PaperDetailVo } from '@/api/question/index'
import type { SelectionReference } from '@/api/questionBasket'
import { normalizeQuestionScore, scoreValue } from '@/api/questionBasket/numeric'

export function normalizePaperDetail(detail: PaperDetailVo): PaperDetailVo {
  return {
    ...detail,
    score: scoreValue(detail.score),
    sections: detail.sections.map((section) => ({
      ...section,
      questions: section.questions.map((question) => ({
        ...normalizeQuestionScore(question),
        pqScore: question.pqScore == null ? question.pqScore : scoreValue(question.pqScore),
      })),
    })),
  }
}

export const getExamPaperDetail = async (paperId: string, config?: AxiosRequestConfig) =>
  normalizePaperDetail(await getPaperDetail(paperId, config))

// ── 类型定义（misikt 真响应字节级对齐，证据：smoke/02-lazyTree-resp.json + 03-page-3001-resp.json）
// ────────────────────────────────────────────────────────────────────────

// lazyTree 节点（misikt 返整棵 97 节点树，children 嵌套；叶节点不返 children 字段）
export interface PaperTreeNode {
  id: string // 4-15 位数字编码（VARCHAR）
  parentId: string // '0' 或 '1'（3001 特殊）或父 id
  title: string // 节点名（misikt 真实字段 — 不是 name）
  sort: number
  hasChildren: boolean
  key: string // = id（element-plus tree 用）
  value: string // = id
  level: number | null // misikt 没填，固定 null
  nodeDataSum: number | null // misikt 没填，固定 null
  // ── 结构化维度（2026-07-01 字典化，语义下沉每节点；字典码，配 useDictStore 渲染，不再解析 title）──
  subject?: number | null // biz_edu_subject
  stage?: number | null // biz_edu_stage
  grade?: number | null // biz_edu_grade（中考/资料库=null）
  volume?: number | null // biz_edu_volume（九年级/中考=null）
  paperType?: number | null // biz_paper_type
  nodeKind?: string | null // root/grade/ptype/exam/chapter/year/misc
  children?: PaperTreeNode[] // 叶节点不返该字段
}

// page list 元素（misikt 字节级对齐 — 见 02-be-summary §4.2；PRD-B-013 已删 hgScore/directoryName/frameTextContentId）
// PRD-A-013 T2 — id / createUser 雪花 string；业务字段（questionCount/score/suggestTime/paperType/status/sort）保留 number。
export interface PaperListItem {
  id: string
  name: string
  questionCount: number
  score: number // 卷内总分，保留小数。
  suggestTime: number | null
  createTime: string // 'YYYY-MM-DD' 字符串（不是 ms timestamp）
  finishTime: string | null
  createUser: string
  canManage?: boolean
  published?: boolean
  canChangeVisibility?: boolean
  subjectId: string
  paperType: 1 | 2 | 6 // 1=日常 / 2=月考 / 6=专题
  status: 0 | 1 // 未发布 / 已发布，不等于私人卷的公开权限。
  sort: number // 通常 = id
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
  pageIndex: number // 1-based
  pageSize: number
  /**
   * scope 新契约（后端按此分流）：
   *   'public' — 按后端内容归属规则读取官方普通卷
   *   'mine'   — 按当前登录用户 userId 过滤（服务端识别，前端无需传 createBy）
   * 未传 = 后端默认行为（兼容旧调用方）
   */
  scope?: 'public' | 'mine'
  /**
   * PRD-B-101 卷型筛（仅 scope='mine' 生效）：'2'=备课卷 tab / '1'=普通卷；空=不过滤（全量含备课卷）。
   * 🔴 scope≠mine 时 BE 恒排除 paper_kind='2'（公共库查不到备课卷，G6 反性）。
   */
  paperKind?: '1' | '2'
  /**
   * @deprecated 旧字段，已被 scope='mine' 取代。
   * 保留以兼容 workspace 聚合页的历史调用，新代码不再使用。
   */
  createBy?: string
}

// ── API 函数 ─────────────────────────────────────────────────────────────

/**
 * 卷库分类树 — 97 节点 / 3 根（资料库 / 公共试卷 / 专题卷库）
 * POST /teacher/exam/paper/lazyTree
 * envelope 由拦截器自动拆，业务拿到的就是 PaperTreeNode[]
 */
export const getPaperLazyTree = () =>
  request.post<PaperTreeNode[], PaperTreeNode[]>('/teacher/exam/paper/lazyTree')

export const setPaperVisibility = (paperId: string, published: boolean) =>
  request.post<void, void>('/teacher/exam/paper/visibility', { paperId, published })

/**
 * 试卷分页列表 — name LIKE / subjectId prefix-match / create_time DESC, id DESC
 * POST /teacher/exam/paper/page
 *
 * PRD-A-013 T5 M-10：可选 config 透传 axios 选项（主要为 signal —— 列表竞态防护）。
 */
export const getPaperPage = async (params: PaperPageParams, config?: AxiosRequestConfig) => {
  const result = await request.post<MisiktPageVo<PaperListItem>, MisiktPageVo<PaperListItem>>(
    '/teacher/exam/paper/page',
    params,
    config,
  )
  return {
    ...result,
    list: result.list.map((paper) => ({ ...paper, score: scoreValue(paper.score) })),
  }
}

// ── Q 卡段① 创建试卷 ────────────────────────────────────────────────────

// PRD-A-013 T2 — questionIds 雪花 string[]；paperCategoryId 是分类 code 本身就 string。
export interface CreateExamPaperParams {
  name: string
  questionIds?: string[]
  requestId?: string
  questions?: CreatePaperQuestion[]
  suggestTime?: number
  paperCategoryId?: string | null
}

export interface CreatePaperQuestion extends SelectionReference {
  basketNamespace?: string
  basketEntryId?: string
  sort: number
  score: number
}

// PRD-A-013 T2 — paperId 雪花 string
export interface CreateExamPaperResult {
  paperId: string
  questionCount: number
}

export class PaperCreateRejectedError extends Error {}

/**
 * 创建试卷 — 工作台 → 输入名称 + 选定题目列表 → 落库（status='1' 即发布）。
 * BE 自动建默认 section（"题目"），所有题挂下面。
 * POST /teacher/exam/paper/create
 */
export const createExamPaper = async (params: CreateExamPaperParams) => {
  try {
    return await request.post<CreateExamPaperResult, CreateExamPaperResult>(
      '/teacher/exam/paper/create',
      params,
    )
  } catch (error) {
    // Only explicit input/auth rejections prove no commit. Unknown/5xx/409 outcomes retain requestId.
    const code = isAxiosError(error)
      ? error.response?.status
      : (error as { businessCode?: number } | null)?.businessCode
    if (error instanceof Error && code !== undefined && [400, 401, 403, 404, 422].includes(code)) {
      throw new PaperCreateRejectedError(error.message)
    }
    throw error
  }
}

// ── PRD-A-005 T4 试卷编辑（重排/删/增题保存）────────────────────────────

/** 编辑保存时单题条目（契约 manual：questionId / sectionId / sort / score）*/
// PRD-A-013 T2 — questionId / sectionId 雪花 string；sort / score 业务字段 number。
export interface UpdatePaperQuestion extends CreatePaperQuestion {
  paperQuestionId?: string
  sectionId: string
}

/**
 * 大题分区（重命名）— design.md §0.2 SectionBo 契约
 * sectionId 非空 = 更新已有 section name/sort（v1 只支持重命名已有）
 * sectionId 空 = 新建（BE v1 未实现，FE 不发此项）
 * PRD-A-013 T2 — sectionId 雪花 string | null
 */
export interface UpdatePaperSection {
  sectionId: string | null
  name: string
  sort: number
}

/** 试卷编辑保存入参（契约 manual：POST /teacher/exam/paper/update）
 * PRD-A-013 T2 — paperId 雪花 string
 */
export interface UpdateExamPaperParams {
  paperId: string
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
export const updateExamPaper = async (params: UpdateExamPaperParams) =>
  normalizePaperDetail(
    await request.post<PaperDetailVo, PaperDetailVo>('/teacher/exam/paper/update', params),
  )

// ── PRD-A-005 收尾（A-试卷删除）─────────────────────────────────────────
/**
 * 删除试卷（PRD-A-005 收尾 A 段）。
 * BE owner 校验：非本人卷返非成功码（拦截器 code!==1 抛错），事务内删 paper + section + paper_question。
 * POST /teacher/exam/paper/delete body={paperId}
 * envelope 由拦截器自动拆，成功无业务数据（BE 返 null）。
 */
// PRD-A-013 T2 — paperId 雪花 string
export const deletePaper = (paperId: string) =>
  request.post<unknown, unknown>('/teacher/exam/paper/delete', { paperId })
