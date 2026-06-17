import request from '@/http/request'
import type { AxiosRequestConfig } from 'axios'

// ── 类型定义 ────────────────────────────────────────────────
// lazyTree 节点（misikt 返整棵树，children 嵌套）
// ⚠️ 真实字段名是 title 不是 name（A2-question-lazyTree.json 抓包证据）
export interface SubjectNode {
  id: string
  title: string                  // 节点名称（misikt 真实字段）
  parentId: string | null
  hasChildren?: boolean
  key?: string
  value?: string
  level?: number
  sort?: number
  nodeDataSum?: number | null
  children?: SubjectNode[]
}

// 知识点 tag（misikt 真实字段：questionKnowledges）
// PRD-A-013 T2 — id / questionId 都是雪花，必 string；knowledgeId 本身就 string。
export interface QuestionKnowledge {
  id: string | null
  questionId: string
  knowledgeId: string
  knowledgeName: string
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
// PRD-A-013 T2 — id / createUser / examPaperId 都是雪花 ID，必 string；
// 业务字段（questionType / difficult / score / status / examYear）保留 number。
export interface QuestionItem {
  id: string
  questionType: number // 1=选择 / 4=填空 / 5=简答
  difficult: number | null   // ⚠️ 真实字段名是 difficult 不是 difficulty（4星制）
  stemImg: string | null      // 题干图 URL（完整 CDN URL）
  stemText?: string | null    // 题干文本（旧字段，兼容保留）
  stemTextContent?: string | null   // 富文本题干（Markdown + $...$ LaTeX）
  answerImg?: string | null
  explainImg?: string | null
  fileBin?: string | null
  questionKnowledges?: QuestionKnowledge[]    // ⚠️ 真实字段名
  questionStdKnowledges?: QuestionKnowledge[] | null
  subjectId?: string
  createTime?: string
  createUser?: string
  score?: number
  status?: number
  /** 打标状态：0=未标 / 1=AI已标 / 2=已审核 */
  labelStatus?: number | null
  isSelected?: boolean | null
  isWrongBook?: boolean | null
  examYear?: string | null
  examPaperId?: string | null
  examPaperName?: string | null
  freeTag?: string | null              // 老字段（字符串），段③字典化后保留兼容
  freeTags?: FreeTagVo[]               // X 卡 段② BE 新字段，position asc 已排序
  isFavorite?: boolean                 // J 卡 段② BE LEFT JOIN biz_question_favorite 返回，FE 列表心形态判断
  /**
   * PRD-A-015 — 结构化网格块 JSON（biz_question_block.block_json）。
   * null/缺省 = 该题未结构化，渲染回落旧富文本/图（QuestionContent 链）。
   * 回填端点：分页 page（我的题库/题库列表卡片走 QuestionBlockRender）、
   * 单题 select/{id}、批量 list?ids=（卷库预览/PDF）——四端一致结构化渲染。
   */
  blockJson?: string | null
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
  /** PRD-C-009「我的题库」：true=只看当前登录老师自己的题（owner 由后端 LoginHelper 定）。空/false=全量。 */
  mine?: boolean
  /** 按试卷 id 筛选（雪花 string）。空/不传=不限。 */
  examPaperId?: string
  /** 打标状态筛选：0=未标 / 1=AI已标 / 2=已审核。空/不传=全部。 */
  labelStatus?: number
}

// 题目详情（GET /teacher/question/{id} 返）
export interface QuestionDetail extends QuestionItem {
  // ── Q' 卡 段③ 扩展 — BE QuestionDetailVo 详情字段（list / select 端点返回） ──
  answer?: string | null              // 答案文本（旧字段，兼容保留）
  explain?: string | null             // 解析文本（旧字段，兼容保留）
  answerTextContent?: string | null   // 富文本答案（Markdown + $...$ LaTeX）
  analyzeTextContent?: string | null  // 富文本解析（Markdown + $...$ LaTeX）
  // blockJson 已上移至基类 QuestionItem（page/list/select 三端均回填），此处不重复声明。

  // ── PRD-A-015 批1「题目属性编辑页」— select/{id} 已返全部属性维度字段（皆可选，BE 端可能为 null） ──
  // 🔴 C-100 B-converge 方案B：dim3Skill / auxTags 随 BE V905 DROP 列剥除（属性编辑页 C 线预期降级）。
  dim1KpId?: string | null            // AI 维度1：知识点 id
  dim2Qtype?: number | null           // AI 维度2：题型
  dim4Difficulty?: number | null      // AI 维度4：难度
  dim5Structure?: string | null       // AI 维度5：结构指纹
  labelConfidence?: number | null     // 打标置信度
  labeledBy?: string | null           // 打标者
  labeledAt?: number | string | null  // 打标时间（时间戳/字符串）
  baseScore?: number | null           // 标准分值
  importSource?: string | null        // 导入来源
  regionCode?: string | null          // 地域编码
  sourceType?: number | null          // 来源类型（1中考真题/2模拟/3期末/4月考/5单元/6自编/9其他）
  motherQuestionId?: string | null    // 母题 id（雪花 string）
  variantRelation?: string | null     // 变式关系
  annotateVersion?: number | null     // 标注版本
  annotateStatus?: number | null      // 标注完整度（0未标/1已标全/2部分）
}

// ── PRD-A-015 录题/编辑 入参 ──────────────────────────────────────
// 雪花 id 一律 string（防 JS Number 精度丢失，本仓约定）。
// blockJson = §10.1 锁定的结构化网格块文档序列化串（{ v, rows:[...] }）。

/** POST /teacher/question/create 入参（CreateQuestionBo） */
export interface CreateQuestionPayload {
  questionType: number          // 1=选择 / 4=填空 / 5=简答
  stem: string
  subjectId: string
  difficult?: number
  blockJson?: string            // 结构化网格块 JSON（可选）
  answer?: string
  analyze?: string
  freeTag?: string
  examYear?: string
  examPaperId?: string
  examPaperName?: string
}

/**
 * POST /teacher/question/update-block 入参（UpdateBlockBo，权威源 = blockJson）。
 * 🔴 C-100 B-converge：A-015 原端点 /teacher/question/update 与 C-015 覆盖原行撞名，
 * 维护者拍板 A 改名 → /teacher/question/update-block。
 */
export interface UpdateBlockPayload {
  questionId: string            // 雪花 string
  blockJson: string             // 必填：结构化内容权威源
  questionType?: number
  difficult?: number
  subjectId?: string
  stem?: string
  answer?: string
  analyze?: string
}

// 收藏夹文件夹（GET /teacher/center/q-folder/tree 返回树结构）
// misikt 真站端点：/api/teacher/center/q-folder/tree（playwright 已抓取确认）
// PRD-A-013 T2 — id / pid 统一 string（雪花，原来 number|string 不一致）
export interface FavoriteFolder {
  id: string
  name: string
  pid?: string | null
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
 *
 * mine=true（个人题库场景）：BE 过滤 mine_visible='0' 的目录（连同子树）；
 * 公共题库页不传 → 整树照常。排序两页共用 biz_subject.sort（V21 起顶层按年级回填）。
 */
export const lazyTree = (parentId: string | number = 0, mine?: boolean) =>
  request.post<SubjectNode[], SubjectNode[]>('/teacher/question/lazyTree', {
    parentId,
    ...(mine ? { mine: true } : {}),
  })

/**
 * 分页拉题列表（⚠️ 入参 pageIndex 不是 pageNum）
 *
 * PRD-A-013 T5 M-10：可选 config 透传 axios 选项（主要为 signal —— 列表竞态防护）。
 */
export const questionPage = (
  params: QuestionPageParams,
  config?: AxiosRequestConfig,
) =>
  request.post<QuestionPageResult, QuestionPageResult>(
    '/teacher/question/page',
    params,
    config,
  )

// ---------------------------------------------------------------------------
// 🔴 PRD-C-017 B3 — 创建带完整 DNA 的题（母题入库）。
// 端点 POST /teacher/question/create（misikt envelope，走 /api → :8090，code===1 判成功）。
// 字段事实源 = book-server CreateQuestionBo.java（camelCase）。
//   - 必填：questionType（1选择/4填空/5解答）+ stem（题面富文本）。
//   - 服务端强制 createBy/createUser/status/id（别传）；hardPointCount BE 算 size（别传）。
//   - 雪花 id 字段全 string（dim1KpId / secondaryKpIds / anchorId）——禁 number 截尾。
//     secondaryKpIds BE 是 List<Long>，传字符串数组，Jackson 数字字符串自动转 Long。
// ---------------------------------------------------------------------------

/** 创建带 DNA 的题入参（CreateQuestionBo 子集，按 B3 母题入库用到的字段） */
export interface CreateQuestionWithDnaBo {
  /** 题型 1选择/4填空/5解答（必填） */
  questionType: number
  /** 题面富文本（必填） */
  stem: string
  /** 答案富文本 */
  answer?: string
  /** 解析富文本 */
  analyze?: string
  /** 难度 1-4 星（biz_question.difficult） */
  difficult?: number
  /** 章节/知识点编码（biz_question.subject_id；母题入库填确认章 id 或主考点 id） */
  subjectId?: string
  /** 题干整图 URL（母题原图，cropped 归 C-016） */
  stemImg?: string
  // ----- 5 维度打标（复用 V16 列） -----
  /** ①主考点 id → dim1_kp_id（雪花 string） */
  dim1KpId?: string
  /** ②题型 → dim2_qtype */
  dim2Qtype?: number
  /** ④难度 → dim4_difficulty */
  dim4Difficulty?: number
  /** ⑤结构指纹 → dim5_structure */
  dim5Structure?: string
  /** 打标状态机：1=AI已标 */
  labelStatus?: number
  /** AI 自评置信度 0-1 */
  labelConfidence?: number
  /** 打标者（=opus 模型名） */
  labeledBy?: string
  // ----- DNA 全维 / 挂接表 -----
  /** 副考点 id 列表（≤3，雪花 string）→ biz_question_knowledge(is_primary=0) */
  secondaryKpIds?: string[]
  /** 标签列表（3~6）→ biz_free_tag + biz_question_free_tag */
  tags?: string[]
  /** 解法骨架（【】标最难步）→ biz_question_ai.solution_skeleton */
  skeleton?: string
  /** 场景 → biz_question_ai.scenario */
  scene?: string
  /** 考察类型（闭集 10）→ biz_question_ai.assessment_type */
  examType?: string
  /** 难点/突破点列表 → biz_question_ai.breakthrough_points（hardPointCount BE 算 size，别传） */
  hardPoints?: string[]
  /** 锚定 subject 节点 → biz_question_ai.anchor_id */
  anchorId?: string
  /** 锚定待人审 → biz_question_ai.need_anchor_review */
  needAnchorReview?: boolean
  /** 抽取/生成依据 → biz_question_ai.reasoning */
  reasoning?: string
}

/** 创建返回（QuestionDetailVo；至少含落库 id，雪花 string） */
export interface CreateQuestionResult extends QuestionDetail {
  id: string
}

/**
 * 创建带完整 DNA 的题（母题入库，PRD-C-017 §1⑧ / G12）。
 * 成功（misikt code===1）→ resolve 解包后的 QuestionDetailVo（含落库 id）；
 * 失败 → reject（toast 由 http 拦截器已弹），调用方兜底。
 */
export const createQuestionWithDna = (bo: CreateQuestionWithDnaBo) =>
  request.post<CreateQuestionResult, CreateQuestionResult>('/teacher/question/create', bo)

/**
 * 拉试题栏角标数量
 */
export const basketNum = () =>
  request.post<BasketNumResult, BasketNumResult>('/teacher/question/basketNum')

/**
 * 加入试题栏
 * PRD-A-013 T2 — questionId 雪花 string
 */
export const addBasket = (questionId: string) =>
  request.post<unknown, unknown>(`/teacher/question/addBasket/${questionId}`)

/**
 * 判断是否已收藏（GET，每题独立调）
 * PRD-A-013 T2 — questionId 雪花 string
 */
export const getFavorite = (questionId: string) =>
  request.get<FavoriteResult, FavoriteResult>(`/teacher/qd/favorite/${questionId}`)

/**
 * 收藏题目（POST /teacher/qd/favorite/{id}）
 * folderId 可选 — misikt 真站接口是否支持 folderId 参数待验证（需登录态 playwright 才能抓 payload）
 * 当前：不带 folderId 调用（兼容现状），folderId 本地记录
 * PRD-A-013 T2 — questionId / folderId 统一 string（雪花）
 */
export const addFavorite = (questionId: string, folderId?: string) =>
  request.post<unknown, unknown>(`/teacher/qd/favorite/${questionId}`, folderId ? { folderId } : undefined)

/**
 * 拉收藏夹目录树（GET /teacher/center/q-folder/tree）
 * misikt 真站端点：playwright 已确认（无登录态返 401，有登录态时 response 待验证字段结构）
 * 推测响应：{ code: 200, response: FavoriteFolder[] }（树形结构，一级为收藏夹，children 为子夹）
 */
export const getFavoriteFolderTree = () =>
  request.get<FavoriteFolder[], FavoriteFolder[]>('/teacher/center/q-folder/tree')

// ── PRD-A-005 收尾（B-收藏夹 CRUD，范围限本人）──────────────────────────
// BE QuestionFolderController：user_id 一律取登录态，rename/delete 先校验本人夹防越权。
// 默认夹 {id:0,name:"我的试题"} 是虚拟夹，前端不给改名/删除入口（不调这三个端点）。

/**
 * 新建收藏夹（POST /teacher/center/q-folder/create）。
 * body {name, pid?}（pid 缺省 0=根）；返回新夹 id（Long）。
 */
// PRD-A-013 T2 — pid / id 雪花，统一 string；createFolder pid 默认根 '0'。
// BE 返回的新夹 id 也是 numeric string（雪花），保持 string 类型。
export const createFolder = (name: string, pid: string = '0') =>
  request.post<string, string>('/teacher/center/q-folder/create', { name, pid })

/**
 * 收藏夹改名（POST /teacher/center/q-folder/rename）。
 * body {id, name}；仅名称可改（时间只展示）。BE 校验本人夹。
 * PRD-A-013 T2 — id 雪花 string
 */
export const renameFolder = (id: string, name: string) =>
  request.post<unknown, unknown>('/teacher/center/q-folder/rename', { id, name })

/**
 * 删除收藏夹（POST /teacher/center/q-folder/delete）。
 * body {id}；BE 把该夹下收藏 folder_id 重置 0（归默认夹，不丢收藏）。
 * PRD-A-013 T2 — id 雪花 string
 */
export const deleteFolder = (id: string) =>
  request.post<unknown, unknown>('/teacher/center/q-folder/delete', { id })

/**
 * 取消收藏（DELETE /teacher/qd/favorite/{id}）
 * PRD-A-013 T2 — questionId 雪花 string
 */
export const removeFavorite = (questionId: string) =>
  request.delete<unknown, unknown>(`/teacher/qd/favorite/${questionId}`)

// 收藏分页入参（PRD-A-005 T6 契约：GET /teacher/qd/favorite/page?pageNum&pageSize&folderId?）
// PRD-A-013 T2 — folderId 雪花 string
export interface FavoritePageParams {
  pageNum: number
  pageSize: number
  folderId?: string
}

/**
 * 分页拉收藏题列表（PRD-A-005 T6）
 * GET /teacher/qd/favorite/page —— 返 MisiktPageVo<题VO>（复用题库题 VO QuestionItem），限当前登录 userId。
 * envelope `/teacher/**` 走 misikt `{code:1}`，request 拦截器已解包，拿到的是 response 内层。
 */
export const favoritePage = (params: FavoritePageParams) =>
  request.get<QuestionPageResult, QuestionPageResult>('/teacher/qd/favorite/page', { params })

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
 * PRD-A-013 T2 — questionId 雪花 string
 */
export const removeBasket = (questionId: string) =>
  request.post<unknown, unknown>(`/teacher/question/cancel/${questionId}`)

// ── 题目详情 / 原卷 / 错题栏接口（第十二波新增）──────────────────

// 收录情况单条（试卷条目）
// GET /teacher/question/{id}/sources 真实字段待 playwright 验证
// 当前基于 A3-question-page.json 字段推断：examPaperId / examPaperName 已在 QuestionItem 里
// PRD-A-013 T2 — examPaperId 雪花 string
export interface QuestionSource {
  examPaperId: string
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
// E 卡 段② BE 真接口 /teacher/exam/paper/detail 也返这个结构（含 sortNum / pqScore）
export interface PaperSourceQuestion extends QuestionItem {
  sort?: number | null            // biz_paper_question.sort（跨 section 全局题号；BE 也返这个字段）
  sortNum?: number | null         // E 卡 段② BE 真返：跨 section 全局题号（别名）
  pqScore?: number | null         // E 卡 段② BE 真返：单题分（biz_paper_question.score）
}

// 原卷详情响应
// PRD-A-013 T2 — paperId 雪花 string
export interface PaperSourceDetail {
  paperId: string
  paperName: string
  examYear?: string | null
  questions: PaperSourceQuestion[]
}

// ── E 卡 段② BE 真接口 /teacher/exam/paper/detail ──
// 大题分组 VO
// PRD-A-013 T2 — sectionId 雪花 string
export interface PaperSectionVo {
  sectionId: string
  title: string
  sort: number
  questions: PaperSourceQuestion[]
}

// 试卷详情 VO（卷头 + sections 分组）
// PRD-A-013 T2 — paperId 雪花 string；createBy 本来就 string；
// 业务字段 score / suggestTime / questionCount / paperType 保留 number。
export interface PaperDetailVo {
  paperId: string
  paperName: string
  subjectId?: string
  score: number
  suggestTime: number
  questionCount: number
  examYear?: string
  paperType?: number
  /**
   * 创建人 user_id（PRD-A-005 收尾新增，BE PaperDetailVo.createBy = String）。
   * owner 判定：String(createBy) === String(userStore.userInfo.id) → 本人卷可编辑；否则公共卷锁死。
   */
  createBy?: string | null
  sections: PaperSectionVo[]
}

/**
 * 获取题目详情
 * POST /teacher/question/select/{id}（A4 抓包证据 — misikt 真端点）
 * PRD-A-013 T2 — questionId 雪花 string
 */
export const getQuestionDetail = (questionId: string) =>
  request.post<QuestionDetail, QuestionDetail>(`/teacher/question/select/${questionId}`)

/**
 * PRD-A-015 — 新建题目（结构化录题）。
 * POST /teacher/question/create（CreateQuestionBo）。
 * envelope `/teacher/**` 由拦截器解包，拿到的是 QuestionDetail 内层。
 */
export const createQuestion = (payload: CreateQuestionPayload) =>
  request.post<QuestionDetail, QuestionDetail>('/teacher/question/create', payload)

/**
 * PRD-A-015 — 结构化编辑题目（权威源 = blockJson）。
 * 🔴 C-100 B-converge 改名：POST /teacher/question/update-block（UpdateBlockBo）。
 * 返回更新后的 QuestionDetail（含回读的 blockJson + 外置文本 + knowledges + freeTags）。
 */
export const updateBlock = (payload: UpdateBlockPayload) =>
  request.post<QuestionDetail, QuestionDetail>('/teacher/question/update-block', payload)

// ── PRD-A-015 批1「题目属性编辑页」— 属性回写端点 ────────────────────────────
// POST /teacher/question/update-attrs（全字段可选，BE 只回写传了的非 null 列，不碰 blockJson/题干）。
// 返回更新后的 QuestionDetail。雪花 id（questionId / motherQuestionId）一律 string。
export interface UpdateAttrsPayload {
  questionId: string
  subjectId?: string
  questionType?: number
  difficult?: number
  dim1KpId?: string
  dim2Qtype?: number
  // 🔴 C-100 B-converge 方案B：dim3Skill / auxTags 随 BE V905 DROP 列剥除（属性编辑页 C 线预期降级）。
  dim4Difficulty?: number
  dim5Structure?: string
  labelStatus?: number
  labelConfidence?: number
  labeledBy?: string
  baseScore?: number
  sourceType?: number
  regionCode?: string
  variantRelation?: string
  motherQuestionId?: string
  annotateStatus?: number
}

/**
 * PRD-A-015 批1 — 回写题目属性（基础设置 + 各维度，本批仅基础设置生效）。
 * POST /teacher/question/update-attrs（UpdateAttrsBo），envelope `/teacher/**` 由拦截器解包。
 * 返回更新后的 QuestionDetail（含刷新后的全部属性维度字段）。
 */
export const updateQuestionAttrs = (payload: UpdateAttrsPayload) =>
  request.post<QuestionDetail, QuestionDetail>('/teacher/question/update-attrs', payload)


// Q' 卡 段① BE 新端点 — 按 ids 批查完整字段（含 answer / explain / freeTags / questionStdKnowledges）。
// query string = ?ids=1,2,3 逗号分隔（axios params 对 string 不会重复 key）；上限 100（BE 端约束）；
// 软删自动过滤（BE WHERE status<>'2'）；顺序按 FIND_IN_SET 保入参顺序（FE 仍需 reorder 兜底）。
// PRD-A-013 T2 — ids 雪花 string[]
// PRD-A-015：BE listByIds 已批量回填 blockJson（与单题 selectById 对称），故卷库预览/PDF 走本接口
//    也能拿到结构化内容、命中 QuestionBlockRender 网格渲染（PaperPreview blockDocOf 分支）。
export const questionListByIds = (ids: string[]) =>
  request.get<QuestionDetail[], QuestionDetail[]>('/teacher/question/list', {
    params: { ids: ids.join(',') },
  })

/**
 * PRD-C-014 T3 — 按主知识点取候选自由标签池（DNA 标签维多选弹层的候选来源）。
 * GET /teacher/question/tagsByKp?kpId={当前主考点}&limit=50
 *   - 走 /api → :8090 misikt envelope（request 拦截器已解包，拿到 response 内层）。
 *   - kpId = 当前题主考点知识点 id；limit 默认 50。
 *   - 端点开发中（B4 批次按此契约写）：BE 返候选标签名数组（按复用度/相关度排序）。
 *     宽松解包：返 string[] 或 {name}[] 都吃；解析不出回空数组（前端仅作候选提示，可手输补充）。
 */
export const tagsByKp = (kpId: string, limit = 50) =>
  request.get<unknown, unknown>('/teacher/question/tagsByKp', {
    params: { kpId, limit },
  })

/**
 * 获取我的备注（V1：BE 返单对象或 null）
 * GET /teacher/qd/note/{questionId}
 * PRD-A-013 T2 — questionId 雪花 string
 */
export const getQuestionNote = (questionId: string) =>
  request.get<QuestionNote | null, QuestionNote | null>(`/teacher/qd/note/${questionId}`)

/**
 * 添加/更新备注（V1：upsert，路径带 id + body 仅 content）
 * POST /teacher/qd/note/{id}
 * PRD-A-013 T2 — questionId 雪花 string
 */
export const saveQuestionNote = (questionId: string, content: string) =>
  request.post<unknown, unknown>(`/teacher/qd/note/${questionId}`, { content })

/**
 * 获取收录情况（这道题被收录进了哪些试卷）
 * GET /teacher/qd/papers/{id}（A 端点清单 / 抓包确认）
 * PRD-A-013 T2 — questionId 雪花 string
 */
export const getQuestionSources = (questionId: string) =>
  request.get<QuestionSource[], QuestionSource[]>(`/teacher/qd/papers/${questionId}`)

/**
 * 获取相似题
 * GET /teacher/question/similar/{id}
 * 无登录态无法验证
 * PRD-A-013 T2 — questionId 雪花 string
 */
export const getSimilarQuestions = (questionId: string) =>
  request.get<SimilarQuestion[], SimilarQuestion[]>(`/teacher/question/similar/${questionId}`)

/**
 * 获取原卷详情（试卷所有题）
 * GET /teacher/paper/source/{id}
 * 无登录态无法验证
 * PRD-A-013 T2 — paperId 雪花 string
 */
export const getPaperSource = (paperId: string) =>
  request.get<PaperSourceDetail, PaperSourceDetail>(`/teacher/paper/source/${paperId}`)

/**
 * E 卡 段② — 获取试卷详情（卷头 + 大题分组 + 题）
 * POST /teacher/exam/paper/detail body={paperId}
 * BE envelope `{code, message, response}` 已被 advice 解包，拿到的是 response 内层
 *
 * PRD-A-013 T5 M-10：可选 config 透传 axios 选项（主要为 signal —— 快速切卷竞态防护）。
 * PRD-A-013 T2 — paperId 雪花 string
 */
export const getPaperDetail = (
  paperId: string,
  config?: AxiosRequestConfig,
) =>
  request.post<PaperDetailVo, PaperDetailVo>(
    '/teacher/exam/paper/detail',
    { paperId },
    config,
  )

// V1 删除：addErrorBasket / removeErrorBasket / reportQuestion 三个 API 函数
// 原因：错题栏 + 题目报错本卡范围不实现，view 改为 noop + ElMessage warning "功能开发中"。
// 错题栏体验：localStorage-only（视图层 view-only），不调 BE 端点。

// ── PRD-A-007 T1 换一题（BE 新端点） ────────────────────────────────────────

// PRD-A-013 T2 — currentQuestionId / excludeIds 都是雪花 string
export interface ReplaceQuestionParams {
  currentQuestionId: string
  excludeIds: string[]
}

/**
 * 换一题 — 推荐同考点（兜底同题型）、未在本卷的一道题原位替换。
 * 逻辑：同 subject + 同首考点 + id NOT IN excludeIds → 兜底同 question_type；仍无则返 null。
 * POST /teacher/question/replace
 * envelope 由拦截器自动拆，业务拿到的是 QuestionDetail | null。
 */
export const replaceQuestion = (params: ReplaceQuestionParams) =>
  request.post<QuestionDetail | null, QuestionDetail | null>(
    '/teacher/question/replace',
    params,
  )
