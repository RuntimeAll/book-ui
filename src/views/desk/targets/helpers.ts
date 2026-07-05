// PRD-C-213 学生与班级页 · 页内共享纯函数（只服务 targets/ 目录，不外泄）。
// 红线：只动 targets/ 目录，故 date / pill / mask 等小工具就近落这里，不新建全局 util。

import {
  SESSION_STATUS_LABEL,
  PREP_STATUS_LABEL,
  type SessionStatus,
  type PrepStatus,
} from '@/api/teacher/schedule'

/** 兜底对象色（服务端 color 空时用教育青） */
export const FALLBACK_COLOR = '#0f766e'

/** 头像取名字首字（中文取第 1 个字，英文取首字母大写） */
export function avatarChar(name?: string): string {
  if (!name) return '?'
  return name.trim().charAt(0).toUpperCase()
}

/** 家长电话掩码：138****2211（保留前 3 后 4） */
export function maskPhone(phone?: string): string {
  if (!phone) return '—'
  const p = phone.replace(/\s/g, '')
  if (p.length < 7) return p
  return `${p.slice(0, 3)}****${p.slice(-4)}`
}

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 解析 YYYY-MM-DD → Date（避免时区偏移，按本地零点） */
export function parseDate(dateStr?: string): Date | null {
  if (!dateStr) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr)
  if (!m) {
    const d = new Date(dateStr)
    return isNaN(d.getTime()) ? null : d
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** M/D 短日期（7/5） */
export function shortDate(dateStr?: string): string {
  const d = parseDate(dateStr)
  if (!d) return '—'
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 中文星期（周五） */
export function weekdayCn(dateStr?: string): string {
  const d = parseDate(dateStr)
  if (!d) return ''
  return WEEK_CN[d.getDay()]
}

/** 今天零点 */
function today0(): Date {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate())
}

/** 相对日：今天 / 明天 / 周X（跨周仍给周X） */
export function relativeDay(dateStr?: string): string {
  const d = parseDate(dateStr)
  if (!d) return ''
  const diff = Math.round((d.getTime() - today0().getTime()) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === -1) return '昨天'
  return WEEK_CN[d.getDay()]
}

/** HH:mm（截掉秒） */
export function shortTime(t?: string): string {
  if (!t) return ''
  return t.slice(0, 5)
}

/** 时间段 HH:mm – HH:mm */
export function timeRange(start?: string, end?: string): string {
  const s = shortTime(start)
  const e = shortTime(end)
  if (s && e) return `${s} – ${e}`
  return s || e || '—'
}

export type PillTone = 'ok' | 'mid' | 'todo' | 'mute'

/** 场次状态 → { 文案, 色调 }：已排=mute / 已上=ok / 请假=mid / 取消=todo */
export function sessionStatusPill(status?: SessionStatus): { label: string; tone: PillTone } {
  const label = status ? SESSION_STATUS_LABEL[status] : '—'
  const tone: PillTone =
    status === '1' ? 'ok' : status === '2' ? 'mid' : status === '3' ? 'todo' : 'mute'
  return { label, tone }
}

/** 场次备课态 → { 文案, 色调 }：已备好=ok / 备课中=mid / 未备=mute */
export function prepStatusPill(status?: PrepStatus): { label: string; tone: PillTone } {
  const label = status ? PREP_STATUS_LABEL[status] : '—'
  const tone: PillTone = status === '2' ? 'ok' : status === '1' ? 'mid' : 'mute'
  return { label, tone }
}

/** 进度百分比（0-100，防除零/越界） */
export function progressPct(done?: number, total?: number): number {
  if (!total || total <= 0) return 0
  const pct = Math.round(((done ?? 0) / total) * 100)
  return Math.max(0, Math.min(100, pct))
}
