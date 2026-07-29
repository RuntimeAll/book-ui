import request from '@/http/request'

// ===========================================================================
// PRD-013 每日打卡书 —— FE API 客户端（对齐 BE PunchController /teacher/punch/**）。
//
// 走 /api → book-server（misikt envelope，code===1 判成功，http/request 拦截器统一解包返 response）。
// 全部端点 @SaCheckLogin；写端点门禁 = owner 本人 / 超管。
//
// 🔴 id（bookId / nodeId / itemId / qid）一律 string —— 雪花 19 位，JSON number 会截尾。
//    day 是小整数（1..N），用 number 安全。
// 契约正本 = codeplace-A/prd/PRD-013/PRD.md §10 + BE PunchController/PunchService。
// ===========================================================================

const BASE = '/teacher/punch'

// ---------------------------------------------------------------------------
// 一、类型
// ---------------------------------------------------------------------------

/** 天级审核状态：pending 未审 / passed 已通过 / issue 有问题。 */
export type PunchReviewStatus = 'pending' | 'passed' | 'issue'

/** 目录角标用审核摘要（issueCount 只数未销账的）。 */
export interface PunchReviewBrief {
  status: PunchReviewStatus | string
  /** 未 resolved 的问题数 */
  issueCount: number
}

/** 目录一行 = 一天。 */
export interface PunchDayBrief {
  day: number
  nodeId: string
  name?: string
  /** 该天 item 数（计算模块 + 轮换位逐题引用） */
  itemCount: number
  review: PunchReviewBrief
}

export interface PunchDaysResult {
  bookId: string
  days: PunchDayBrief[]
}

/**
 * 模块类型（PRD-013 §10.2）：
 *   oral 口算 / vertical 竖式 / stepwise 脱式 —— 出题器现产，落 content_json（本书私有，可就地改）
 *   rotating 轮换位 —— 题库题逐题引用，只带 qids（🔴 题面绝不复制成文本，打卡页只读）
 */
export type PunchModuleType = 'oral' | 'vertical' | 'stepwise' | 'rotating'

export const PUNCH_MODULE_LABEL: Record<string, string> = {
  oral: '口算',
  vertical: '竖式',
  stepwise: '脱式',
  rotating: '解决问题',
}

/** 计算题一题：题面 + 答案成对（FP11a 就地改字的最小单元）。 */
export interface PunchCalcItem {
  q: string
  a: string
  [k: string]: unknown
}

/** 一个模块（getDay 回读 / upsertDay 入参同构，round-trip 零丢失）。 */
export interface PunchModule {
  type: PunchModuleType | string
  title?: string
  /** 计算三模块题目数组 */
  items?: PunchCalcItem[]
  /** 轮换位题库题 id 列表（🔴 字符串） */
  qids?: string[]
  /** BE 组数据时挂的定位键（不落库；回传 upsert 前剔除） */
  itemId?: string
  [k: string]: unknown
}

/** 一条问题登记。 */
export interface PunchIssue {
  /** 模块 type（oral/vertical/stepwise/rotating） */
  module?: string
  /** 模块内题号（1 起） */
  seq?: number | string | null
  /** 问题类型：难度不符 / 题面有误 / 排版 / 其他 */
  kind?: string
  note?: string
  /** 销账标记 */
  resolved?: boolean
  [k: string]: unknown
}

/** 天级审核全量（含问题清单）。 */
export interface PunchReview {
  status: PunchReviewStatus | string
  issues: PunchIssue[]
  at?: string
}

/** 一天原文（展示页 / 生成器共用）。 */
export interface PunchDayDetail {
  bookId: string
  day: number
  nodeId: string
  goals: string[]
  modules: PunchModule[]
  review: PunchReview
}

/** 纸面卷种：题目卷 / 解析卷（同一模板 data.paper 分流，与导出双卷 1:1）。 */
export type PunchPaper = 'question' | 'answer'

export const PUNCH_ISSUE_KINDS = ['难度不符', '题面有误', '排版', '其他'] as const

/** 审核动作：pass 通过 / issue 记问题（追加）/ reopen 重审（销账回写用）。 */
export type PunchReviewAction = 'pass' | 'issue' | 'reopen'

export interface PunchReviewResult {
  bookId: string
  day: number
  review: PunchReview
  /** 全书各天皆 passed */
  bookPassed: boolean
}

export interface PunchUpsertResult {
  nodeId: string
  day: number
  itemIds: string[]
}

export interface PunchExportResult {
  bookId: string
  day: number
  questionUrl?: string
  answerUrl?: string
}

// ---------------------------------------------------------------------------
// 二、API
// ---------------------------------------------------------------------------

/** 目录：GET days?bookId= → {days:[{day,nodeId,itemCount,review}]} */
export const getPunchDays = (bookId: string) =>
  request.get<PunchDaysResult, PunchDaysResult>(`${BASE}/days`, { params: { bookId } })

/** 一天原文：GET day?bookId=&day= → {goals,modules,review}（modules 与 upsert 同构） */
export const getPunchDay = (bookId: string, day: number) =>
  request.get<PunchDayDetail, PunchDayDetail>(`${BASE}/day`, { params: { bookId, day } })

/**
 * 纸面预览 HTML：GET preview?bookId=&day=&paper= → {html:"完整HTML文档"}。
 * 🔴 与导出 PDF 同 theme（punch-v1）同 data —— 所见即所得（D3/G9），FE 零渲染器开发，iframe srcdoc 直吃。
 */
export const previewPunchDay = (bookId: string, day: number, paper: PunchPaper = 'question') =>
  request.get<{ html: string }, { html: string }>(`${BASE}/preview`, {
    params: { bookId, day, paper },
    // 整页 HTML 串（含内联 CSS + 注入数据）比普通 JSON 大，且 BE 现取题库 blockJson，放宽超时
    timeout: 60_000,
  })

/** 导出本天双卷 PDF → OSS：POST exportDay {bookId,day,papers?} → {questionUrl,answerUrl} */
export const exportPunchDay = (bookId: string, day: number, papers?: PunchPaper[]) =>
  request.post<PunchExportResult, PunchExportResult>(
    `${BASE}/exportDay`,
    { bookId, day, ...(papers && papers.length ? { papers } : {}) },
    // 🔴 Chrome 渲 PDF 同步长任务（BE 单卷 60s 守卫），默认 15s 必超时
    { timeout: 300_000 },
  )

/**
 * 幂等建/覆盖一天：POST upsertDay {bookId,day,goals,modules} → {nodeId,itemIds}。
 * FP11a 就地改字复用此端点（改完整天重灌，与 agent 侧批量修正同一条路，不分叉）。
 * 🔴 BE 会把该天 review.status 重置为 pending（内容变了要重审），调用方需提示用户。
 */
export const upsertPunchDay = (bookId: string, day: number, goals: string[], modules: PunchModule[]) =>
  request.post<PunchUpsertResult, PunchUpsertResult>(`${BASE}/upsertDay`, {
    bookId,
    day,
    goals,
    modules,
  })

/**
 * 提交审核：POST review {bookId,day,action,issues?} → {review,bookPassed}。
 *   issue  —— status=issue，issues 追加进清单
 *   pass   —— status=passed；传 issues 则整体覆盖（销账后回写干净清单）
 *   reopen —— status=pending（重审）；issues 处理同 pass
 */
export const submitPunchReview = (
  bookId: string,
  day: number,
  action: PunchReviewAction,
  issues?: PunchIssue[],
) =>
  request.post<PunchReviewResult, PunchReviewResult>(`${BASE}/review`, {
    bookId,
    day,
    action,
    ...(issues ? { issues } : {}),
  })

// ---------------------------------------------------------------------------
// 三、小工具
// ---------------------------------------------------------------------------

/** upsert 回传前剔除 BE 组数据时挂的 itemId 定位键（BE 也会剔，FE 先净一遍防污染）。 */
export function stripModuleItemIds(modules: PunchModule[]): PunchModule[] {
  return modules.map((m) => {
    const { itemId: _itemId, ...rest } = m
    return rest as PunchModule
  })
}

/** 模块中文名（问题登记/编辑面板用；未知 type 原样回显）。 */
export function punchModuleLabel(type: string | undefined): string {
  if (!type) return '未知模块'
  return PUNCH_MODULE_LABEL[type] ?? type
}
