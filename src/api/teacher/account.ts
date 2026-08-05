import request from '@/http/request'

// ===========================================================================
// PRD-015 教务域 · 课时账本 —— FE API 客户端
// 🔄 PRD-018 v3 批3 改版（2026-08-05）：账户 → **账本**（biz_tuition_account 已删 student_id/
//    subject/amount_remain），学生经 biz_student_account_link 绑账本（n:1 不强制独占）。
//
// 走 /api → book-server（misikt envelope，code===1 判成功，http/request 拦截器统一解包返 response）。
// 全部端点 @SaCheckLogin，owner/create_by 由服务端登录态取，不传 body。
//
// 🔴 id / studentId / accountId 一律 string（雪花 19 位，JSON number 会截尾）。
//    小时 / 金额 / 计价参数是小数值，用 number 安全。
// 🔴 **底账只记小时**：金额 = 小时 × pricePerHour 现场派生不落库；「节」= 小时 ÷ hoursPerLesson
//    （每节时长在绑定层）。共享账本（bindingCount>1）多人基准不同 → 只按小时，不折节（D4 规则②）。
// ===========================================================================

const BASE = '/teacher/schedule/account'

// ---------------------------------------------------------------------------
// 一、枚举（char(1) 存码 + 中文映射，页面直接吃 *_LABEL 渲染）
// ---------------------------------------------------------------------------

/** 账本状态：'0' 正常 / '1' 停用 */
export type AccountStatus = '0' | '1'
export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = { '0': '正常', '1': '停用' }

/**
 * 流水类型：'1' 充值 / '2' 扣课（场次结算自动写） / '3' 冲正（结算撤销） / '4' 调整（人工改数）。
 * 🔴 手工可写的只有 '1' 充值 与 '4' 调整；'2'/'3' 由结算链服务端产生，只读不写。
 *    账本转移（transfer）也落 '4'，一对互指行。
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

/**
 * 学生视角的一条账本绑定（GET account/list?studentId=，一行 = 一个学科绑定）。
 * 🔴 `id` = **账本 id**（不是绑定 id）——台账/充值/导出全部以账本为粒度，与 accountId 同值。
 */
export interface TuitionAccountVO {
  /** 账本 id（= accountId，历史字段名保留，调用方照旧传它） */
  id: string
  /** 账本 id（显式名） */
  accountId: string
  /** 账本标签（可选，如「俊羽家」；无标签时页面自行回落学生名） */
  name?: string | null
  /** 学生对象 id（biz_teach_target，targetType='0'） */
  studentId: string
  /** 学科字典码（biz_edu_subject：1数学/2科学/3语文/4英语） */
  subject: string
  /** 学科中文标签（BE 推导；缺省时页面回退显示 subject 码） */
  subjectLabel?: string | null
  /**
   * 🆕 内部计价参数（每小时多少元）—— 一本账一个价，共享账本「同价才能并本」的数学根基。
   * 🔴 **D11：不上屏**。对外口径 = 每节价 = pricePerHour × hoursPerLesson（见 composables/useTuitionUnit）。
   */
  pricePerHour: number
  /** 🆕 每节时长（小时，来自绑定 link.hours_per_lesson：俊羽 1.5 / 好好 1） */
  hoursPerLesson: number
  /** 剩余小时（底账唯一单位） */
  hoursRemain: number
  /** 🆕 剩余节数（= hoursRemain ÷ hoursPerLesson，BE 派生） */
  lessonsRemain: number
  /** 🆕 该账本绑定数 >1（共享账本：余额只按小时不折节，行内显学生名） */
  shared?: boolean
  /** @deprecated M5 过渡兼容：元/节 = pricePerHour × hoursPerLesson，BE 派生。新码用 pricePerHour */
  lessonPrice: number
  /** @deprecated M5 过渡兼容：剩余金额 = hoursRemain × pricePerHour，BE 派生不落库 */
  amountRemain: number
  status: AccountStatus
  note?: string
}

/** 账本上的一条绑定（GET account/all 的 bindings 元素）。 */
export interface AccountBindingVO {
  studentId: string | null
  studentName: string | null
  subject: string
  subjectLabel?: string | null
  hoursPerLesson: number
}

/**
 * 账本视角（GET account/all，M6「我的全部账本」）。
 * 🔴 **含零绑定账本** —— 改绑后旧本的冲正退款永远查得到，不会变成谁都看不到又删不掉的孤儿。
 */
export interface AccountBookVO {
  id: string
  name?: string | null
  pricePerHour: number
  hoursRemain: number
  amountRemain: number
  status: AccountStatus
  note?: string | null
  /** 绑定数（0 = 零绑定孤本；>1 = 共享账本） */
  bindingCount: number
  shared: boolean
  /** 绑定的学生名（共享本多个；D4 规则①：>1 时台账行显学生名） */
  studentNames: string[]
  bindings: AccountBindingVO[]
  /** 仅**单绑**账本才有（折节基准唯一时才敢折） */
  hoursPerLesson?: number
  lessonsRemain?: number
  lessonPrice?: number
}

/**
 * 开户 / 改绑 / 改计价入参。
 * 🔄 v3：一步无感知 —— 服务端同一事务「建账本 + 建绑定」；
 *    uk(studentId, subject) 命中 = 改该绑定的每节时长 + 该账本计价（不报错、不动余额）。
 *    传 `accountId` = 记入已有账本（换本 / 共享账本入口），此时计价跟账本走。
 */
export interface AccountUpsertBo {
  studentId: string
  /** 学科字典码 */
  subject: string
  /**
   * 内部计价参数（每小时多少元）—— v3 首选入参。
   * 🔴 **D11：FE 表单收的是「每节价」**，提交前用 `toPricePerHour(每节价, 每节时长)` 折成本字段
   *    （保 4 位：350 ÷ 1.5 = 233.3333，砍成两位每笔差几分）。
   */
  pricePerHour?: number
  /** 每节时长（小时），缺省 1 */
  hoursPerLesson?: number
  /** 账本标签（可选） */
  name?: string
  /** 记入已有账本：给了就只建/改绑定，不新建账本 */
  accountId?: string
  /** @deprecated M5 兼容：元/节；pricePerHour 为空时 BE 按 hoursPerLesson 折算成内部计价参数 */
  lessonPrice?: number
  note?: string
}

/**
 * 手工流水入参（充值 '1' / 调整 '4'）。
 * 🔴 **三档任给其一**（D9）：hours（小时）/ lessons（节）/ amount（金额），服务端换算成小时落库；
 *    前端三档实时互算只为好填，落库永远只有小时。
 * 🔴 `occurDate` = 业务日期（默认今天，补录可回填历史）——台账按它排序，不按写入时间。
 * 🔴 `amountPaid` = 实收金额原样落库（AC9：收 3500 就显示 3500，不用派生值倒推尾差）。
 */
export interface TuitionFlowBo {
  /** 🔴 只允许 '1' 充值 | '4' 调整；'2' 扣课 / '3' 冲正由结算链产生 */
  flowType: '1' | '4'
  /** ① 小时档 */
  hours?: number
  /** ② 节档（× 该绑定的每节时长；共享本多绑时 BE 不接受本档） */
  lessons?: number
  /** ③ 金额档（÷ 账本计价参数） */
  amount?: number
  /** 实收金额（元，原样落库；不给则金额档取 amount） */
  amountPaid?: number
  /** 业务日期 yyyy-MM-dd（默认今天） */
  occurDate?: string
  note?: string
  /** @deprecated M5 兼容：等价 hours */
  hoursDelta?: number
}

/** 账本转移入参（换本 / 拆本，一个事务产一对互指 '4' 行）。 */
export interface AccountTransferBo {
  fromAccountId: string
  toAccountId: string
  /** 转移小时数（>0） */
  hours: number
  occurDate?: string
  note?: string
}

export interface AccountTransferResultVO {
  fromFlowId: string
  toFlowId: string
  hours: number
}

/**
 * 台账一行（充值 + 场次扣课统一时间线）。
 * 🔴 **正序**（业务日期升序），剩余为服务端逐行实时推导——不再是写入时快照。
 */
export interface LedgerRowVO {
  /** 流水 id（雪花 string） */
  id: string
  /** YYYY-MM-DD（带场次的行以场次日期为准，改期自动跟随） */
  date: string
  /** 场次起止（如 09:00-10:30）；手工行为 null */
  timeRange: string | null
  /** 这节实际讲了什么 → 退课次标题 → 退「正课」；手工行 = 备注 */
  content: string
  flowType: TuitionFlowType
  /** 本行小时增量（扣课为负） */
  hoursDelta: number
  /** 本行金额（实收优先，否则按账本计价派生） */
  amount: number
  /** 实收金额（充值/调整行原样，AC9）；无则 null */
  amountPaid: number | null
  /** 本行之后的剩余小时（🔄 推导值，旧字段名保留） */
  hoursAfter: number
  /** 本行之后的剩余金额（逐行派生后求和） */
  amountAfter: number
  sessionId: string | null
  /** 换本/拆本的对手方流水 id */
  relFlowId: string | null
  /** 共享账本（绑定数>1）才有值：这行是谁的课（D4 规则①） */
  studentName: string | null
  /** @deprecated M5 兼容：等于本行 amount */
  amountDelta?: number
}

/**
 * 台账返回体。
 * 🔴 `pageNum` 不传 = **最后一页**（最近的行）——正序 + 第 1 页会让老师首屏永远是最旧记录。
 *    「加载更早」= 用返回的 pageNum-1 向前翻。
 */
export interface LedgerResultVO {
  rows: LedgerRowVO[]
  total: number
  pageNum: number
  pageSize: number
  pages: number
  /** 期初余额（本页第一行之前的累计小时），页内首行前渲染一条期初行 */
  openingBalance: number
  openingAmount: number
  account: AccountBookVO
  shared: boolean
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
// 🔴 路径体检（逐行核对 TuitionAccountController，改这里必须同步核对 Controller）：
//    /list · /all · (根 POST) · /transfer · /{id}/flow · /{id}/ledger ·
//    /{id}/export-ledger-png · /{id}/status · /{id}（DELETE）
// ---------------------------------------------------------------------------

/** 某学生的全部学科账本（走绑定表反查）：GET account/list?studentId= */
export const listAccounts = (studentId: string) =>
  request.get<TuitionAccountVO[], TuitionAccountVO[]>(`${BASE}/list`, { params: { studentId } })

/**
 * 我的全部账本（M6）：GET account/all —— **含零绑定账本**。
 * 改绑后旧本的余额/冲正退款仍要查得到，所以零绑定的孤本也必须列出来。
 */
export const listMyAccountBooks = () =>
  request.get<AccountBookVO[], AccountBookVO[]>(`${BASE}/all`)

/** 开户 / 改绑 / 改计价：POST account → {id}（账本 id） */
export const upsertAccount = (bo: AccountUpsertBo) =>
  request.post<IdVO, IdVO>(BASE, bo)

/** 手工流水（充值 / 调整）：POST account/{id}/flow → {id}（流水 id） */
export const addAccountFlow = (accountId: string, bo: TuitionFlowBo) =>
  request.post<IdVO, IdVO>(`${BASE}/${accountId}/flow`, bo)

/**
 * 账本转移（换本 / 拆本）：POST account/transfer → {fromFlowId,toFlowId,hours}。
 * 一个事务产一对互指 '4' 调整行，台账上是一笔可解释的动作（不是老师手搓两笔无关调整）。
 */
export const transferAccount = (bo: AccountTransferBo) =>
  request.post<AccountTransferResultVO, AccountTransferResultVO>(`${BASE}/transfer`, bo)

/**
 * 台账：GET account/{id}/ledger（充值 + 扣课统一时间线，正序 + 实时推导剩余）。
 * 🔴 **不传 pageNum = 默认最后一页**（最近的行）。别硬传 1，那在正序口径下是最旧的一页。
 */
export const getAccountLedger = (accountId: string, query: LedgerQueryParams = {}) =>
  request.get<LedgerResultVO, LedgerResultVO>(`${BASE}/${accountId}/ledger`, { params: query })

/**
 * 台账长图导出：POST account/{id}/export-ledger-png → {file,url}（发家长）。
 * 取流复用 /teacher/schedule/artifact 的 blob 通道（见 api/teacher/schedule.ts#downloadArtifact）。
 */
export const exportLedgerPng = (accountId: string) =>
  request.post<FileUrlVO, FileUrlVO>(`${BASE}/${accountId}/export-ledger-png`)

/**
 * 停用 / 启用账本：POST account/{id}/status。
 * 停用后该学科不再出现在建计划下拉、结算取不到账本；余额与流水原样保留，随时可启用回来。
 */
export const setAccountStatus = (accountId: string, status: AccountStatus) =>
  request.post<void, void>(`${BASE}/${accountId}/status`, { status })

/**
 * 删本：DELETE account/{id}。
 * 🔴 只有<b>零流水</b>账本能删（开错学科当场删）；有任何一条记录 BE 返 400 让改用停用——
 *    删了账本台账就与已结场次对不上账，审计线不能断。
 */
export const deleteAccount = (accountId: string) =>
  request.delete<void, void>(`${BASE}/${accountId}`)
