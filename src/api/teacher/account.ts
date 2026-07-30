import request from '@/http/request'

// ===========================================================================
// PRD-015 教务域 · 学生×学科课时账户 —— FE API 客户端（批0 契约面，与 BE 同批定稿）。
//
// 走 /api → book-server（misikt envelope，code===1 判成功，http/request 拦截器统一解包返 response）。
// 全部端点 @SaCheckLogin，owner/create_by 由服务端登录态取，不传 body。
//
// 🔴 id / studentId / accountId 一律 string（雪花 19 位，JSON number 会截尾）。
//    课时 / 金额 / 单价是小数值，用 number 安全。
// 🔴 一个学生 × 一个学科 = 一个账户（uk_student_subject）；桌面端与移动端 H5 共吃本契约。
// ===========================================================================

const BASE = '/teacher/schedule/account'

// ---------------------------------------------------------------------------
// 一、枚举（char(1) 存码 + 中文映射，页面直接吃 *_LABEL 渲染）
// ---------------------------------------------------------------------------

/** 账户状态：'0' 正常 / '1' 停用 */
export type AccountStatus = '0' | '1'
export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = { '0': '正常', '1': '停用' }

/**
 * 流水类型：'1' 充值 / '2' 扣课（场次结算自动写） / '3' 冲正（结算撤销） / '4' 调整（人工改数）。
 * 🔴 手工可写的只有 '1' 充值 与 '4' 调整；'2'/'3' 由结算链服务端产生，只读不写。
 */
export type TuitionFlowType = '1' | '2' | '3' | '4'
export const TUITION_FLOW_TYPE_LABEL: Record<TuitionFlowType, string> = {
  '1': '充值',
  '2': '扣课',
  '3': '冲正',
  '4': '调整'
}

// ---------------------------------------------------------------------------
// 二、类型
// ---------------------------------------------------------------------------

/** 课时账户（biz_tuition_account：学生 × 学科唯一一条）。 */
export interface TuitionAccountVO {
  id: string
  /** 学生对象 id（biz_teach_target，targetType='0'） */
  studentId: string
  /** 学科字典码（biz_edu_subject：1数学/2科学/3语文/4英语） */
  subject: string
  /** 学科中文标签（BE 推导，additive；缺省时页面回退显示 subject 码） */
  subjectLabel?: string | null
  /** 课时单价（元/课时） */
  lessonPrice: number
  /** 剩余课时 */
  hoursRemain: number
  /** 剩余金额（元） */
  amountRemain: number
  status: AccountStatus
  note?: string
}

/** 开户 / 改单价入参（uk_student_subject 冲突 = 改单价语义，不报错）。 */
export interface AccountUpsertBo {
  studentId: string
  /** 学科字典码 */
  subject: string
  lessonPrice: number
}

/** 手工流水入参（充值 / 调整）。课时与金额两笔增量独立传，服务端不代算。 */
export interface TuitionFlowBo {
  /** 🔴 只允许 '1' 充值 | '4' 调整；'2' 扣课 / '3' 冲正 由结算链产生 */
  flowType: '1' | '4'
  /** 课时增量（正=加课时，负=扣） */
  hoursDelta: number
  /** 金额增量（元，正=进账，负=出账） */
  amountDelta: number
  note?: string
}

/** 台账一行（充值流水 + 场次扣课统一时间线，服务端已排好序）。 */
export interface LedgerRowVO {
  /** YYYY-MM-DD */
  date: string
  /** 场次起止（如 09:00-10:30）；充值/调整行为 null 或备注 */
  timeRange: string | null
  /** 课次标题 / 充值备注 */
  content: string
  flowType: TuitionFlowType
  /** 本行课时增量（扣课为负） */
  hoursDelta: number
  /** 本行之后的剩余课时（历史行可能为 null） */
  hoursAfter: number | null
  /** 本行之后的剩余金额（历史行可能为 null） */
  amountAfter: number | null
}

/** RuoYi 分页返回（misikt envelope 内层 TableDataInfo）。 */
export interface PageResult<T> {
  rows: T[]
  total: number
}

/** 分页公共入参。 */
export interface PageQuery {
  pageNum?: number
  pageSize?: number
}

/** 台账查询入参。 */
export interface LedgerQueryParams extends PageQuery {
  /** 起始日期 YYYY-MM-DD（含） */
  startDate?: string
  /** 结束日期 YYYY-MM-DD（含） */
  endDate?: string
}

/** 通用 {id} 返回。 */
export interface IdVO {
  id: string
}

/** 文件产物返回（PNG 导出用；file=服务端相对路径，走 downloadArtifact blob 通道取流）。 */
export interface FileUrlVO {
  file: string
  url: string
}

// ---------------------------------------------------------------------------
// 三、API 客户端
//
// 🔴 路径体检（PRD-015 bug 批 BUG-1，2026-07-31 逐行核对 TuitionAccountController）：
//    以下 5 条路径与 BE @RequestMapping("/teacher/schedule/account") 下的
//    /list · (根 POST) · /{id}/flow · /{id}/ledger · /{id}/export-ledger-png 一一对上，
//    分隔符全部是正斜杠 `/`，无反斜杠、无拼接漏斜杠。改这里必须同步核对 Controller。
// ---------------------------------------------------------------------------

/** 某学生的全部学科账户：GET account/list?studentId= */
export const listAccounts = (studentId: string) =>
  request.get<TuitionAccountVO[], TuitionAccountVO[]>(`${BASE}/list`, { params: { studentId } })

/** 开户 / 改单价：POST account → {id}（uk_student_subject 冲突 = 改单价语义） */
export const upsertAccount = (bo: AccountUpsertBo) =>
  request.post<IdVO, IdVO>(BASE, bo)

/** 手工流水（充值 / 调整）：POST account/{id}/flow → {id}（流水 id） */
export const addAccountFlow = (accountId: string, bo: TuitionFlowBo) =>
  request.post<IdVO, IdVO>(`${BASE}/${accountId}/flow`, bo)

/** 台账：GET account/{id}/ledger（充值 + 扣课统一时间线，分页） */
export const getAccountLedger = (accountId: string, query: LedgerQueryParams = {}) =>
  request.get<PageResult<LedgerRowVO>, PageResult<LedgerRowVO>>(`${BASE}/${accountId}/ledger`, { params: query })

/**
 * 台账长图导出：POST account/{id}/export-ledger-png → {file,url}（发家长）。
 * 取流复用 /teacher/schedule/artifact 的 blob 通道（见 api/teacher/schedule.ts#downloadArtifact）。
 */
export const exportLedgerPng = (accountId: string) =>
  request.post<FileUrlVO, FileUrlVO>(`${BASE}/${accountId}/export-ledger-png`)
