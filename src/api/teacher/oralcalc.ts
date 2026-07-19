import request from '@/http/request'

// ===========================================================================
// 计算题出题器 —— API 客户端（自选出题页用）。
// 走 /api → book-server /teacher/oralcalc（misikt envelope，拦截器解包 response）。
// 生成是确定性程序（非 LLM）：同参数同 seed 复现同一份卷。
// ===========================================================================

const BASE = '/teacher/oralcalc'

/** 一个计算类型（46+ 类，覆盖人教版 1-6 年级计算谱系）。 */
export interface CalcTypeInfo {
  code: string
  name: string
  grade: number
  term: number
}

/** 呈现形态：口算一行式 / 竖式留白 / 脱式留白（卷面去＝）。 */
export type CalcMode = 'oral' | 'vertical' | 'tuoshi'

/** 一组题（卷面一个区块）。label 只作分组开关，卷面组标只印「一、二」序号。 */
export interface CalcGroupBo {
  type: string
  count: number
  mode?: CalcMode
  label?: string
}

/** 版式配置（主题侧有缺省，全部可选）。 */
export interface CalcLayoutBo {
  cols?: number
  numbered?: boolean
  rowHeightMm?: number
  fontSizePt?: number
  footer?: string
  frame?: boolean
  hideTitle?: boolean
  hideMeta?: boolean
  metaFields?: string[]
  fontFamily?: 'songti' | 'heiti' | 'kaiti' | 'yahei'
  inkColor?: string
  verticalRowMm?: number
  tuoshiRowMm?: number
}

export interface CalcExportBo {
  title?: string
  seed?: string
  withGroupLabel?: boolean
  papers?: Array<'question' | 'answer'>
  groups: CalcGroupBo[]
  layout?: CalcLayoutBo
}

export interface CalcExportVo {
  total: number
  seed: string
  questionUrl: string
  answerUrl?: string
}

/** 类型全表（按年级排序返回）。 */
export const listCalcTypes = () =>
  request.get<CalcTypeInfo[], CalcTypeInfo[]>(`${BASE}/types`)

/** 一键出卷 → OSS PDF 链接。 */
export const exportCalcPaper = (bo: CalcExportBo) =>
  request.post<CalcExportVo, CalcExportVo>(`${BASE}/export`, bo)
