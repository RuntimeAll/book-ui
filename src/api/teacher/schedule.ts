import request from '@/http/request'
// PRD-015：卡片墙内联返回每科课时账户（additive），类型复用账户契约正本，不另立一套
import type { TuitionAccountVO } from './account'

// ===========================================================================
// PRD-C-213 教学安排与备课闭环 —— API 客户端（批0 契约冻结正本，脚手架冻结件）。
//
// 走 /api → book-server :8090（misikt envelope，code===1 判成功，http/request 拦截器
// 统一解包返回 response）。全部端点 @SaCheckLogin，owner/create_by 由服务端登录态取，不传 body。
//
// 🔴 id 一律 string（雪花 19 位，json-bigint 保精度，禁 number 截尾）。
// 🔴 本文件 commit 后即冻结，页面 agent 只读不改；枚举码 + 中文映射直接吃这里的导出。
// 契约正本 = workplace/.prd_ccw/PRD-C/PRD-C-213/artifacts/契约/批0-契约冻结.md（§一枚举 / §三接口）。
// ===========================================================================

// ---------------------------------------------------------------------------
// 一、枚举冻结（char(1) 存码 + 中文映射，页面 agent 直接吃 *_LABEL 渲染）
// ---------------------------------------------------------------------------

/** 对象类型：'0' 学生 / '1' 班级 */
export type TargetType = '0' | '1'
export const TARGET_TYPE_LABEL: Record<TargetType, string> = { '0': '学生', '1': '班级' }

/** 场次类型：'1' 正课 / '2' 测试 / '3' 外部占位（外部占位无备课点） */
export type SessionType = '1' | '2' | '3'
export const SESSION_TYPE_LABEL: Record<SessionType, string> = { '1': '正课', '2': '测试', '3': '外部占位' }

/** 场次状态：'0' 已排 / '1' 已上 / '2' 请假 / '3' 取消（改期=改时间不改状态） */
export type SessionStatus = '0' | '1' | '2' | '3'
export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = { '0': '已排', '1': '已上', '2': '请假', '3': '取消' }

/** session 级·场次备课态：'0' 未备 / '1' 备课中 / '2' 已备好 */
export type PrepStatus = '0' | '1' | '2'
export const PREP_STATUS_LABEL: Record<PrepStatus, string> = { '0': '未备', '1': '备课中', '2': '已备好' }

/** lesson 级·内容态：'0' 大纲态 / '1' 细备中 / '2' 已备好 */
export type PrepState = '0' | '1' | '2'
export const PREP_STATE_LABEL: Record<PrepState, string> = { '0': '大纲态', '1': '细备中', '2': '已备好' }

/** 计划状态：'0' 草稿 / '1' 启用 / '2' 归档 */
export type PlanStatus = '0' | '1' | '2'
export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = { '0': '草稿', '1': '启用', '2': '归档' }

/** 备课包状态：'0' 装配中 / '1' 已生成 / '2' 已备好 */
export type PackStatus = '0' | '1' | '2'
export const PACK_STATUS_LABEL: Record<PackStatus, string> = { '0': '装配中', '1': '已生成', '2': '已备好' }

/** 课次类型：'0' 教学 / '1' 测试 */
export type LessonType = '0' | '1'
export const LESSON_TYPE_LABEL: Record<LessonType, string> = { '0': '教学', '1': '测试' }

/** 星级（挂题）：'1'/'2'/'3' ↔ ★/★★/★★★ */
export type StarLevel = '1' | '2' | '3'
export const STAR_LEVEL_LABEL: Record<StarLevel, string> = { '1': '★', '2': '★★', '3': '★★★' }

/** 回收判定结果（字面存中文） */
export type ReviewResult = '对' | '错' | '卡'
/** 错因归类（字面存中文） */
export type ReviewCause = '计算' | '概念辨析' | '策略' | '其他'
/** 错题信号确认态 */
export type ErrorSignalStatus = 'pending' | 'confirmed'
export const ERROR_SIGNAL_STATUS_LABEL: Record<ErrorSignalStatus, string> = { pending: '待确认', confirmed: '已确认' }
/** 错题信号来源 */
export type ErrorSignalBy = 'system' | 'teacher'

// ---------------------------------------------------------------------------
// 二、JSON schema 冻结（存进 json 列 / 传输 DTO，键沿用契约 snake_case）
// ---------------------------------------------------------------------------

/** 肖像·历史条目 */
export interface ProfileHistoryItem {
  topic: string
  /** 吃透 | 讲过未吃透 */
  status: string
  src: string
}

/** 错题信号（profile_json.error_signals 元素；review.portrait_delta 同构） */
export interface ErrorSignal {
  tag: string
  evidence: string
  /** 溯源场次 id（雪花，传输为 string；历史数据可能为 number） */
  session_id: string | number
  /** YYYY-MM-DD */
  ts: string
  by: ErrorSignalBy
  status: ErrorSignalStatus
}

/** 肖像·水平 */
export interface ProfileLevel {
  desc: string
  target_layer: string
}

/** profile_json（student/class 同构；UI 四格 = traits/level.desc/level.target_layer/error_signals） */
export interface ProfileJson {
  traits: string[]
  level: ProfileLevel
  /** 进度环境：外部班课等 */
  env: string
  history: ProfileHistoryItem[]
  error_signals: ErrorSignal[]
}

/** 分段模板项（plan.default_seg_template 与 lesson.seg_template 同构，2-4 段可变形） */
export interface SegTemplateItem {
  name: string
  style: string
  /** 该段主题（课内同步主题落第三段 topic） */
  topic: string
}

/**
 * PRD-B-101 专项卷位（lesson.paper_slots / plan.default_paper_slots 同构）。
 * 🔴 键名 snake_case（存 JSON 列 + BE 原样透传 Map，非 camelCase）。
 * 每位可绑一张卷（paper_id）；rules/note 是老师侧元数据，不进卷面（家长/学生不可见）。
 */
export interface PaperSlot {
  /** 卷位序号（课次内唯一，绑定/解绑端点按此定位） */
  slot_seq: number
  /** 卷位名（必填非空，如 概念辨析 / 课内同步；= 备课卷卷名的一部分） */
  name: string
  /** 出卷风格提示（如 选择为主…） */
  style?: string
  /** 组卷规则元数据（老师侧，不进卷面） */
  rules?: string
  /** 备注（口诀等，老师侧，不进卷面） */
  note?: string
  /** 绑定的卷 id（雪花 string；null/空 = 未绑空位） */
  paper_id?: string | null
  /** 手动「标记已备好」覆盖（课次级，任一卷位解绑自动清 false） */
  manual_ready?: boolean
}

/** 备课包·段（question_id 一律 string 防雪花截尾） */
export interface PackSeg {
  name: string
  style: string
  question_ids: string[]
  rules?: string
  note?: string
}

/** 备课产物记录（落库 JSON / 家长图产物元信息）；file=服务端相对路径，走 downloadArtifact blob 通道 */
export interface PackArtifact {
  seg: string
  file: string
  pages: number
  url?: string
}

/** 回收·单题结果 */
export interface ReviewItemResult {
  question_id?: string
  seg: string
  seq: number
  result: ReviewResult
  cause: ReviewCause
}

// ---------------------------------------------------------------------------
// 三、实体 / 聚合 VO（字段基于 §二 DDL 列 camelCase + §三接口聚合描述）
// ---------------------------------------------------------------------------

/** 通用 {id} 返回 */
export interface IdVO {
  id: string
}

/** 文件产物返回（parent-export / render 用） */
export interface FileUrlVO {
  file: string
  url: string
}

/** RuoYi 分页返回（/page 端点，misikt envelope 内层 TableDataInfo） */
export interface PageResult<T> {
  rows: T[]
  total: number
}

/** 分页公共入参 */
export interface PageQuery {
  pageNum?: number
  pageSize?: number
}

// —— 对象档案 ——

/** 建档入参（POST target；class 无 parentPhone 可省）。
 *  🔴 R1a 建模：年级/教材不传文本，传 gradeNo+gradeYear+字典码（暑期录「升四」= gradeNo 4 + gradeYear 2026）。 */
export interface TargetCreateBo {
  targetType: TargetType
  name: string
  /** 年级 1-12（字典 biz_edu_grade） */
  gradeNo?: number
  /** gradeNo 生效学年起始年（如 2026 = 2026-09-01 起学年；缺省=当年） */
  gradeYear?: number
  /** 教材版本字典码（biz_edu_edition：1浙教/2人教/3北师大/4苏教） */
  textbookEdition?: string
  /** 学科字典码（biz_edu_subject：1数学/2科学/3语文/4英语） */
  subject?: string
  parentPhone?: string
  /** 空则服务端从色板轮转分配 */
  color?: string
  profileJson?: ProfileJson
}

/** 改基本维入参（PUT target/{id}；不含 targetType，类型不可改）。字段口径同 TargetCreateBo（R1a） */
export interface TargetUpdateBo {
  name?: string
  gradeNo?: number
  gradeYear?: number
  textbookEdition?: string
  /** 学科字典码 */
  subject?: string
  parentPhone?: string
  color?: string
}

/** 对象详情（GET target/{id}，含 profile；班级含成员 studentIds）。
 *  R1a：原始码（gradeNo/gradeYear/textbookEdition/subject）与推导串（grade/textbook/subjectLabel）双输出。 */
export interface TargetDetailVO {
  id: string
  targetType: TargetType
  name: string
  /** 原始码：年级 1-12 */
  gradeNo?: number | null
  /** 原始码：学年起始年 */
  gradeYear?: number | null
  /** 原始码：教材版本字典码 */
  textbookEdition?: string | null
  /** 🔴 学科字典码（显示用 subjectLabel） */
  subject: string
  /** 学科中文标签（BE 推导） */
  subjectLabel?: string
  /** 推导串（如「三年级·暑假」，显示用；写走 gradeNo/gradeYear） */
  grade: string
  /** 推导串（如「人教版四年级上册」，显示用；写走 textbookEdition） */
  textbook: string
  parentPhone: string
  color: string
  profileJson: ProfileJson
  archived: string
  /** 班级成员 id（targetType='1' 时） */
  studentIds?: string[]
  createTime?: string
  updateTime?: string
}

/**
 * PRD-015 学科线 · 卡片上的「一科一条计划绑定」（additive）。
 * 一个学生可同时上数学 + 科学 → 两条计划各自进度，读侧不再串科。
 */
export interface PlanBindingVO {
  /** 学科字典码（计划 subject → 场次 subject → 对象主科 逐级兜底） */
  subject?: string | null
  /** 学科中文标签（BE 推导） */
  subjectLabel?: string | null
  planId: string
  planName?: string | null
  /** 该计划已上课次数 */
  progressDone: number
  /** 该计划课次总数 */
  progressTotal: number
}

/** 对象卡片（GET target/page，含实时聚合） */
export interface TargetCardVO {
  id: string
  targetType: TargetType
  name: string
  /** 推导串（如「三年级·暑假」） */
  grade: string
  /** 学科字典码（显示用 subjectLabel） */
  subject: string
  /** 学科中文标签（BE 推导） */
  subjectLabel?: string
  color: string
  archived: string
  /** 已排场次数 */
  scheduledCount: number
  /** 已上场次数 */
  doneCount: number
  /** 请假场次数 */
  leaveCount: number
  /** 绑定计划 id */
  planId?: string
  /** 绑定计划名 */
  planName?: string
  /** 进度 n（已上课次） */
  progressDone?: number
  /** 进度 total（计划课次总数） */
  progressTotal?: number
  /**
   * PRD-015 additive：按学科分组的全部计划绑定（一生多科多计划）。
   * 🔴 上面 planId/planName/progressDone/progressTotal 四个旧字段保留 = 主科（或第一条）绑定，
   *    老渲染不动；新渲染优先吃 planBindings，为空时回退旧字段。
   */
  planBindings?: PlanBindingVO[]
  /**
   * PRD-015 additive：该生每科课时账户快照（学生卡专有；班级恒空）。
   * 结构 = account.ts 的 TuitionAccountVO，卡片只用 subject/subjectLabel/hoursRemain；
   * 卡片墙直接吃这里，免逐卡再打一次 /teacher/schedule/account/list。
   */
  accounts?: TuitionAccountVO[]
  /** 下一课 */
  nextSession?: {
    sessionId: string
    sessionDate: string
    startTime: string
    title?: string
  } | null
  /** 班课学员数（targetType='1' 时） */
  studentCount?: number
}

/** 对象卡片墙查询入参 */
export interface TargetPageParams extends PageQuery {
  targetType?: TargetType
  keyword?: string
  /** 是否含已归档（归档不进排课选择器） */
  includeArchived?: boolean
}

// —— 课程计划 ——

/** 计划课次（biz_course_plan_lesson） */
export interface PlanLessonVO {
  id: string
  planId: string
  lessonSeq: number
  title: string
  lessonType: LessonType
  /** 自由标签（吃透课①走这） */
  tag?: string
  sourceRef?: string
  thinkingAction?: string
  layerTarget?: string
  parentCopy?: string
  /** biz_subject id 数组 */
  kgNodeIds?: string[]
  /** @deprecated PRD-B-101：段模型退役，页面不再消费；BE 仍回传兼容旧数据 */
  segTemplate?: SegTemplateItem[]
  /** PRD-B-101 有效卷位（课次自有；未配则回退计划默认模板，读时回退不物理复制） */
  paperSlots?: PaperSlot[]
  /** PRD-B-101 true=当前 paperSlots 继承自计划默认模板（课次未单独配置） */
  paperSlotsInherited?: boolean
  /** 备课态（服务端唯一权威，PRD-B-101 换权威 = lesson.paper_slots 实时推导） */
  prepState: PrepState
}

/** 计划课次 upsert 入参（id 空=新增） */
export interface PlanLessonBo {
  id?: string
  lessonSeq?: number
  title: string
  lessonType?: LessonType
  tag?: string
  sourceRef?: string
  thinkingAction?: string
  layerTarget?: string
  parentCopy?: string
  kgNodeIds?: string[]
  /** @deprecated PRD-B-101：段模型退役，页面不再写；保留类型防旧调用编译报错 */
  segTemplate?: SegTemplateItem[]
  /** PRD-B-101 专项卷位（写课次即覆盖继承的计划默认模板） */
  paperSlots?: PaperSlot[]
}

/** 课程计划（biz_course_plan；GET plan/{id} 含 lessons 全量） */
export interface PlanVO {
  id: string
  name: string
  targetType: TargetType
  /** S1 计划归属对象 id（R1a 起必有） */
  targetId?: string | null
  /** 字典：暑假·上学期·寒假·下学期 */
  termTag: string
  /** PRD-015：计划学科（字典码 biz_edu_subject；BE 一直回传，本批补进类型） */
  subject?: string | null
  /** 学科中文标签（BE 推导） */
  subjectLabel?: string | null
  year: number
  materialNote?: string
  /** @deprecated PRD-B-101：段模型退役，页面不再消费 */
  defaultSegTemplate?: SegTemplateItem[]
  /** PRD-B-101 计划级默认卷位模板（课次未单独配置时继承） */
  defaultPaperSlots?: PaperSlot[]
  status: PlanStatus
  /** GET plan/{id} 全量返回 */
  lessons?: PlanLessonVO[]
  /** page 实时聚合课次数（无 total_lessons 列） */
  lessonCount?: number
  createTime?: string
  updateTime?: string
}

/** 计划建/改入参（POST plan / PUT plan/{id}）。🔴 R1a·S1：新建必传 targetType+targetId 归属 */
export interface PlanBo {
  id?: string
  name: string
  targetType: TargetType
  /** S1 计划归属对象 id（新建必传，BE 强校验对象存在且归我） */
  targetId?: string
  termTag: string
  /**
   * PRD-015 学科线：计划学科（字典码）。
   * 🔴 学生对象建/改计划时 BE 校验该生已开通该学科账户（D3 开户即绑定），未开户返 400
   *    「先为学生开通X账户」；班级跳过校验。
   */
  subject?: string
  year: number
  materialNote?: string
  /** @deprecated PRD-B-101：段模型退役，页面不再写 */
  defaultSegTemplate?: SegTemplateItem[]
  /** PRD-B-101 计划级默认卷位模板 */
  defaultPaperSlots?: PaperSlot[]
  status?: PlanStatus
}

/** 计划列表查询入参 */
export interface PlanPageParams extends PageQuery {
  targetType?: TargetType
  keyword?: string
  status?: PlanStatus
  /** PRD-015：按归属对象过滤（BE plan/page 一直支持，本批补进类型；反馈单「学生→计划」联动用） */
  targetId?: string
}

// —— 排课 ——

/** 排课批量·单项 */
export interface SessionBatchItem {
  date: string
  start: string
  end: string
  /** 学科码（字典 biz_edu_subject，可空=沿计划/对象兜底） */
  subject?: string
  planLessonId?: string
  sessionType?: SessionType
  externalTitle?: string
  note?: string
}

/** 排课批量入参（autoBind=按 lesson_seq 顺序自动绑未排课次；force=命中冲突强存） */
export interface SessionBatchBo {
  targetType: TargetType
  targetId: string
  planId?: string
  autoBind?: boolean
  force?: boolean
  items: SessionBatchItem[]
}

/** 场次（biz_schedule_session） */
export interface SessionVO {
  id: string
  targetType: TargetType
  targetId: string
  planId?: string
  planLessonId?: string
  sessionDate: string
  startTime: string
  endTime: string
  sessionType: SessionType
  sessionStatus: SessionStatus
  prepStatus: PrepStatus
  /** 内容锁定（'1' 顺延时保持原课次） */
  lessonLocked: string
  externalTitle?: string
  note?: string
  createTime?: string
  updateTime?: string
  // PRD-015 教务域：场次结算态（'0' 未结 / '1' 已结 / '2' 已冲正；旧数据/未开账户可空）
  settleStatus?: string
  /** PRD-015：已结场次的实扣快照（未结为 null），冲正确认文案用 */
  settled?: SettledSnapshotVO | null
}

/** 冲突明细项（老师撞场=create_by 同人时间重叠；学生撞场=同 target 重叠） */
export interface ConflictItem {
  date: string
  start: string
  end: string
  kind: '老师撞场' | '学生撞场'
  withSessionId: string
  withTitle: string
}

/** 排课批量返回 */
export interface SessionBatchResult {
  created: SessionVO[]
  conflicts: ConflictItem[]
}

/** 冲突预检返回 */
export interface ConflictCheckResult {
  conflicts: ConflictItem[]
}

/** 月历场次（GET session/calendar） */
export interface CalendarSessionVO {
  id: string
  targetId: string
  targetName: string
  color: string
  sessionDate: string
  startTime: string
  endTime: string
  sessionType: SessionType
  sessionStatus: SessionStatus
  prepStatus: PrepStatus
  /** 内容锁定（'1' 顺延时保持原课次）——BE 每场次 VO 都返，BUG-003 修复前 FE 曾漏映射 */
  lessonLocked?: string
  planLessonId?: string
  /** planLesson 标题 */
  lessonTitle?: string
  externalTitle?: string
  /** 学科码（兜底链 场次→计划→对象，BE 已解好） */
  subject?: string
  subjectLabel?: string
  // PRD-015 教务域：场次结算态（'0' 未结 / '1' 已结 / '2' 已冲正；日历角标用）
  settleStatus?: string
  /** PRD-015：已结场次的实扣快照（未结为 null），抽屉冲正确认文案用 */
  settled?: SettledSnapshotVO | null
}

/** 月历查询入参 */
export interface CalendarParams {
  start: string
  end: string
  targetId?: string
}

/** 场次表查询入参 */
export interface SessionPageParams extends PageQuery {
  targetId?: string
  status?: SessionStatus
}

/** 通用改场次入参（date/start/end=改期不触发顺延；rebind planLessonId=改绑只改本场） */
export interface SessionUpdateBo {
  date?: string
  start?: string
  end?: string
  note?: string
  /** 改绑课次（只改本场） */
  planLessonId?: string
}

/** 顺延返回（leave/cancel 触发；overflow=末位悬空需补排提示） */
export interface DeferResult {
  deferred: { sessionId: string; newLessonId: string }[]
  overflow: string[]
  /**
   * PRD-015 AC6：该场已结算时的自动冲正明细（未结算为 null）。
   * hours/amount = 按该场<b>实扣数</b>返还；deletedShells=删掉的空反馈壳数，keptShells=有内容保留数。
   */
  reversal?: {
    hours: number
    amount: number
    deletedShells: number
    keptShells: number
  } | null
}

// —— PRD-015 场次结算（教务域：已上未结场次 → 批量扣课时/扣款）——

// PRD-015 待结算场次一行（GET settle/pending；已上课但 settleStatus 未结）
export interface PendingSettlementVO {
  sessionId: string
  /** YYYY-MM-DD */
  date: string
  /** 排课起 HH:mm */
  start: string
  /** 排课止 HH:mm */
  end: string
  /** 学生/班级名 */
  targetName: string
  /** 学科字典码（biz_edu_subject） */
  subject: string
  /** 学科中文标签（BE 推导，additive） */
  subjectLabel?: string | null
  /** 绑定计划课次标题（未绑课次为 null） */
  planLessonTitle: string | null
  /**
   * 结算时点账户单价（元/课时）。
   * 🔴 null = 该生该科<b>未开户或账户已停用</b>——照常列出但不能结算，FE 按 accountStatus 提示（BE 会 skipped）。
   */
  price: number | null
  /**
   * 账户状态（additive，bug 批 BUG-3/A）：`null` 没开户 / `'0'` 在用 / `'1'` 已停用。
   * price=null 的两种成因靠它区分——别对已停用的账户劝人「去开户」。
   */
  accountStatus?: '0' | '1' | null
}

// PRD-015 结算单项（hours 缺省 = 1 课时；timeNote = 实际上课时间备注，覆盖排课起止）
export interface SettleItemBo {
  sessionId: string
  /** 实扣课时，缺省 1 */
  hours?: number
  /** 实际上课时间备注（如 09:05-10:40） */
  timeNote?: string
}

// PRD-015 结算返回（字段全可选，随 BE 同批落地对齐；调用方按需取）
export interface SettleResultVO {
  /** 实际结算成功的场次数 */
  settled?: number
  /** genFeedback=true 时联动生成的反馈单 id（雪花 string） */
  feedbackSheetIds?: string[]
  /**
   * 逐场独立事务下被跳过的场次（批3 BE 落地补）：未开户 / 已结算（uk 幂等）/ 已冲正 / 班课 / 外部占位。
   * 🔴 跳过 ≠ 报错：其余场次照常落账，FE 把 reason 原样提示给老师。
   */
  skipped?: { sessionId: string; reason: string }[]
}

/** PRD-015 结算快照（已结场次的实扣数，冲正确认文案「将返还 X 课时 / ¥Y」用） */
export interface SettledSnapshotVO {
  hours: number
  amount: number
}

// —— 备课包 ——

/** 备课包（biz_prep_pack；planLessonId 与 sessionId 二选一） */
export interface PrepPackVO {
  id: string
  planLessonId?: string
  sessionId?: string
  segs: PackSeg[]
  artifacts?: PackArtifact[]
  status: PackStatus
  createTime?: string
  updateTime?: string
}

/** 备课包查询入参（lessonId | sessionId | packId 三选一） */
export interface PrepPackQueryParams {
  lessonId?: string
  sessionId?: string
  packId?: string
}

// —— 回收与统计 ——

/** 回收提交入参 */
export interface ReviewSubmitBo {
  itemResults: ReviewItemResult[]
  teacherNote?: string
  /** LLM 润色位，传入则覆盖模板拼装 */
  parentMsgOverride?: string
}

/** 回收提交返回 */
export interface ReviewSubmitResult {
  parentMsg: string
  /** 错/卡 items 按 cause 聚合的 error_signals（by=system,status=pending） */
  portraitDelta: ErrorSignal[]
}

/** 回收记录（GET session/{id}/review） */
export interface ReviewVO {
  id: string
  sessionId: string
  itemResults: ReviewItemResult[]
  teacherNote?: string
  parentMsg?: string
  portraitDelta?: ErrorSignal[]
  /** 重复提交=覆盖并把上一版整体快照进 prevJson，version+1 */
  version: number
  createTime?: string
  updateTime?: string
}

/** 概览统计（GET stat/overview） */
export interface StatOverviewVO {
  studentCount: number
  /** 本周（周一起）场次数 */
  weekSessionCount: number
  todoPrepCount: number
  myQuestionCount: number
}

/** 待备清单项（GET prep/todo） */
export interface PrepTodoVO {
  id: string
  targetId: string
  targetName?: string
  sessionDate: string
  startTime: string
  endTime: string
  sessionType: SessionType
  prepStatus: PrepStatus
  planLessonId?: string
  lessonTitle?: string
  subject?: string
  subjectLabel?: string
}

/** 私有题池检索入参（GET /teacher/question/pool，create_by=我 且 is_public=0） */
export interface QuestionPoolParams extends PageQuery {
  topicTag?: string
  starLevel?: StarLevel
  keyword?: string
}

/** 私有题池·题项 */
export interface QuestionPoolItem {
  id: string
  stem?: string
  topicTag?: string
  starLevel?: StarLevel
  sourceRef?: string
  questionType?: string
  difficulty?: string
}

// ---------------------------------------------------------------------------
// 四、API 客户端（全挂 /teacher/schedule/**，除 question/pool；id 全 string）
// ---------------------------------------------------------------------------

const BASE = '/teacher/schedule'

// —— 对象档案 ——

/** 建档：POST target → {id}（color 空则服务端色板轮转） */
export const createTarget = (bo: TargetCreateBo) =>
  request.post<IdVO, IdVO>(`${BASE}/target`, bo)

/** 改基本维：PUT target/{id} */
export const updateTarget = (id: string, bo: TargetUpdateBo) =>
  request.put<void, void>(`${BASE}/target/${id}`, bo)

/** 卡片墙：GET target/page（含实时聚合） */
export const pageTargets = (params: TargetPageParams = {}) =>
  request.get<PageResult<TargetCardVO>, PageResult<TargetCardVO>>(`${BASE}/target/page`, { params })

/** 详情：GET target/{id}（含 profile） */
export const getTarget = (id: string) =>
  request.get<TargetDetailVO, TargetDetailVO>(`${BASE}/target/${id}`)

/** 归档联动返回（BUG-015）：cancelled=一并取消的未来未上场次数 */
export interface ArchiveResult {
  cancelled: number
}

/**
 * 归档：POST target/{id}/archive（归档≠删，不进排课选择器）。
 * BUG-015：归档联动取消该对象未来未上场次，返回 {cancelled}。
 */
export const archiveTarget = (id: string) =>
  request.post<ArchiveResult, ArchiveResult>(`${BASE}/target/${id}/archive`)

/** 取消归档：POST target/{id}/unarchive */
export const unarchiveTarget = (id: string) =>
  request.post<void, void>(`${BASE}/target/${id}/unarchive`)

/** 覆写肖像：PUT target/{id}/profile（整体覆写 profile_json，含转正/删 pending 信号） */
export const updateTargetProfile = (id: string, profileJson: ProfileJson) =>
  request.put<void, void>(`${BASE}/target/${id}/profile`, { profileJson })

/** 设班级成员：POST class/{id}/students */
export const setClassStudents = (classId: string, studentIds: string[]) =>
  request.post<void, void>(`${BASE}/class/${classId}/students`, { studentIds })

// —— 课程计划 ——

/** 建计划：POST plan → {id} */
export const createPlan = (bo: PlanBo) =>
  request.post<IdVO, IdVO>(`${BASE}/plan`, bo)

/** 改计划：PUT plan/{id} */
export const updatePlan = (id: string, bo: PlanBo) =>
  request.put<void, void>(`${BASE}/plan/${id}`, bo)

/** 计划列表：GET plan/page */
export const pagePlans = (params: PlanPageParams = {}) =>
  request.get<PageResult<PlanVO>, PageResult<PlanVO>>(`${BASE}/plan/page`, { params })

/** 计划详情：GET plan/{id}（含 lessons 全量） */
export const getPlan = (id: string) =>
  request.get<PlanVO, PlanVO>(`${BASE}/plan/${id}`)

/** 深拷贝计划：POST plan/{id}/copy（含课次） → 新计划 */
export const copyPlan = (id: string) =>
  request.post<PlanVO, PlanVO>(`${BASE}/plan/${id}/copy`)

/** 批量 upsert 课次：POST plan/{id}/lessons（id 空=新增；body=课次数组） */
export const upsertLessons = (planId: string, lessons: PlanLessonBo[]) =>
  request.post<PlanLessonVO[], PlanLessonVO[]>(`${BASE}/plan/${planId}/lessons`, lessons)

/** 删课次：DELETE plan/lesson/{id} */
export const deleteLesson = (lessonId: string) =>
  request.delete<void, void>(`${BASE}/plan/lesson/${lessonId}`)

/** 课次重排：PUT plan/{id}/lessons/reorder（按序重排 lesson_seq） */
export const reorderLessons = (planId: string, lessonIds: string[]) =>
  request.put<void, void>(`${BASE}/plan/${planId}/lessons/reorder`, { lessonIds })

/** 家长版长图导出：POST plan/{id}/parent-export?targetId= → {file,url}（900px 两列长图） */
export const parentExport = (planId: string, targetId: string) =>
  request.post<FileUrlVO, FileUrlVO>(`${BASE}/plan/${planId}/parent-export`, null, { params: { targetId } })

// —— PRD-003 D7：卷位绑定/解绑/标记已备好 API 已退役 ——
// B-101 卷位链下线，课次备课统一走专项材料位（api/special：getLessonMaterials/bindLessonSpecial/
// unbindLessonSpecial）。备课态由 special_ids 推导。原 bindPaperSlot/unbindPaperSlot/markLessonReady
// 三函数（无调用者）已删。

// —— 排课 ——

/** 批量排课：POST session/batch → {created,conflicts}（命中冲突且 !force 一条不落） */
export const batchSchedule = (bo: SessionBatchBo) =>
  request.post<SessionBatchResult, SessionBatchResult>(`${BASE}/session/batch`, bo)

/** 冲突预检：POST session/conflict-check → {conflicts} */
export const conflictCheck = (bo: SessionBatchBo) =>
  request.post<ConflictCheckResult, ConflictCheckResult>(`${BASE}/session/conflict-check`, bo)

/** 月历：GET session/calendar?start&end&targetId? */
export const getCalendar = (params: CalendarParams) =>
  request.get<CalendarSessionVO[], CalendarSessionVO[]>(`${BASE}/session/calendar`, { params })

/** 场次表：GET session/page?targetId&status? */
export const pageSessions = (params: SessionPageParams = {}) =>
  request.get<PageResult<SessionVO>, PageResult<SessionVO>>(`${BASE}/session/page`, { params })

/** 通用改场次：PUT session/{id}（改期/改绑/备注） */
export const updateSession = (id: string, bo: SessionUpdateBo) =>
  request.put<void, void>(`${BASE}/session/${id}`, bo)

/** 请假：POST session/{id}/leave → 触发顺延 {deferred,overflow} */
export const sessionLeave = (id: string) =>
  request.post<DeferResult, DeferResult>(`${BASE}/session/${id}/leave`)

/** 取消：POST session/{id}/cancel → 触发顺延 {deferred,overflow} */
export const sessionCancel = (id: string) =>
  request.post<DeferResult, DeferResult>(`${BASE}/session/${id}/cancel`)

/** 标已上：POST session/{id}/mark-done */
export const sessionMarkDone = (id: string) =>
  request.post<void, void>(`${BASE}/session/${id}/mark-done`)

/** 锁定内容：POST session/{id}/lock */
export const sessionLock = (id: string) =>
  request.post<void, void>(`${BASE}/session/${id}/lock`)

/** 解锁内容：POST session/{id}/unlock */
export const sessionUnlock = (id: string) =>
  request.post<void, void>(`${BASE}/session/${id}/unlock`)

// —— PRD-015 场次结算 ——

// PRD-015 待结算清单：GET settle/pending（已上未结场次，按日期升序）
export const getPendingSettlements = () =>
  request.get<PendingSettlementVO[], PendingSettlementVO[]>(`${BASE}/settle/pending`)

// PRD-015 批量结算：POST settle（扣课时/扣款 + 写场次结算态；genFeedback=true 顺带建反馈单）
export const settleSessions = (bo: { items: SettleItemBo[]; genFeedback: boolean }) =>
  request.post<SettleResultVO, SettleResultVO>(`${BASE}/settle`, bo)

// —— 备课包 ——

/** 查备课包：GET prep-pack?lessonId|sessionId|packId（回收链 ReviewDialog 在用） */
export const getPrepPack = (params: PrepPackQueryParams) =>
  request.get<PrepPackVO, PrepPackVO>(`${BASE}/prep-pack`, { params })

// —— 回收与统计 ——

/** 提交回收：POST session/{id}/review → {parentMsg,portraitDelta}（同时置 session 已上） */
export const submitReview = (sessionId: string, bo: ReviewSubmitBo) =>
  request.post<ReviewSubmitResult, ReviewSubmitResult>(`${BASE}/session/${sessionId}/review`, bo)

/** 查回收：GET session/{id}/review */
export const getReview = (sessionId: string) =>
  request.get<ReviewVO, ReviewVO>(`${BASE}/session/${sessionId}/review`)

/** 概览统计：GET stat/overview */
export const getStatOverview = () =>
  request.get<StatOverviewVO, StatOverviewVO>(`${BASE}/stat/overview`)

/** 待备清单：GET prep/todo?days=（默认 14=细备窗口；概览提醒条/统计卡传 7） */
export const getPrepTodo = (days = 14) =>
  request.get<PrepTodoVO[], PrepTodoVO[]>(`${BASE}/prep/todo`, { params: { days } })

/** 私有题池检索：GET /teacher/question/pool（create_by=我 且 is_public=0；注意非 schedule 前缀） */
export const pageQuestionPool = (params: QuestionPoolParams = {}) =>
  request.get<PageResult<QuestionPoolItem>, PageResult<QuestionPoolItem>>('/teacher/question/pool', { params })

// —— artifact 下载助手 ——

/**
 * 拼 artifact 下载 URL（二进制流不走 envelope，用于 <a href> / window.open 直接下载）。
 * GET /teacher/schedule/artifact?path=，走 /api 前缀（vite proxy rewrite → :8090）。
 * 限 artifact-dir 内防穿越，path=服务端相对路径（来自 PackArtifact.file）。
 */
export const artifactUrl = (path: string): string =>
  `/api${BASE}/artifact?path=${encodeURIComponent(path)}`

/**
 * BUG-005 修复：产物预览/下载改走带鉴权头的 axios 实例（原裸 `<a :href>` 走浏览器原生导航，
 * 不带 Authorization/clientid，BE @SaCheckLogin 必 401）。responseType='blob'，
 * http/request.ts 响应拦截器对 blob 响应短路跳过 envelope 解包，直接透传原始 blob。
 */
export const downloadArtifact = (path: string): Promise<Blob> =>
  request.get<Blob, Blob>(`${BASE}/artifact`, { params: { path }, responseType: 'blob' })
