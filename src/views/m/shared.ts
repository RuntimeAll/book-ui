/**
 * PRD-015 批5 · /m/ 移动端四页共享工具与状态。
 *
 * 只放「跨页复用」的纯函数 + 待结算清单的模块级缓存（tabbar 角标与 settle 页同一份数据源，
 * 避免两处各拉一次导致角标与列表打架）。业务请求一律走 api/teacher/** 契约层，本文件不发明端点。
 * 🔴 雪花 id 全链路 string；课时/金额是小数，用 number。
 *
 * 🔴 **双单位（小时 ⇄ 节）不在本文件实现**（PRD-018 D1 v2.1 / D8）：
 *    唯一底座 = `@/composables/useTuitionUnit`（`dual`/`dText`/`toLessons` + 模块级单位开关，
 *    桌面与 H5 共用同一个 ref，切一处全站生效）。本文件的 `money()`/`fmtHours()` 只是**纯数字**
 *    格式化，很多老页面在用，保留原样；**别在这里再长一套换算或单位文案**——
 *    同一笔钱两处算法不同就是事故的开始。
 */
import { ref } from 'vue'
import { getPendingSettlements, type PendingSettlementVO } from '@/api/teacher/schedule'

// ── Vant 主题（PRD-015 移动端 Vant 化，2026-07-31）──────────────────────
/**
 * 只染**主色**成品牌青绿，圆角 / 字号 / 间距一律吃 Vant 默认——
 * 换框架的目的就是拿它调好的手感，乱改 token 等于把手搓 CSS 换个地方重犯。
 * 🔴 用 ConfigProvider 的 theme-vars-scope="global" 写到 :root，Toast/Dialog 才跟着变色。
 */
export const M_THEME_VARS = {
  primaryColor: '#0E8F72',
  navBarBackground: '#0E8F72',
  navBarTitleTextColor: '#ffffff',
  navBarIconColor: '#ffffff',
  navBarTextColor: '#ffffff',
} as const

// ── 日期 / 数字格式化（纯字符串拼装，绕开 toISOString 的时区差一天坑）──────

/** Date → 'YYYY-MM-DD'（本地时区，不经 UTC） */
export function fmtDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 今天（本地）'YYYY-MM-DD' —— 页面每次进入重算，长挂机跨天也不错位 */
export function todayStr(): string {
  return fmtDate(new Date())
}

/** 'HH:mm:ss' → 'HH:mm'（BE 时间列带秒） */
export function hhmm(t?: string | null): string {
  return (t || '').slice(0, 5)
}

/** 'YYYY-MM-DD' → '今天 / 昨天 / MM-DD' */
export function dayLabel(date: string): string {
  const today = todayStr()
  if (date === today) return '今天'
  const y = new Date()
  y.setDate(y.getDate() - 1)
  if (date === fmtDate(y)) return '昨天'
  return date.slice(5)
}

/** 'YYYY-MM-DD' → 'M 月 D 日' */
export function cnDay(date: string): string {
  if (!date) return ''
  return `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`
}

/** 金额：¥1,800 / -¥200（负号在前，两位小数只在有小数时保留） */
export function money(n: number | null | undefined): string {
  const v = Math.round((n || 0) * 100) / 100
  const abs = Math.abs(v)
  const s = Number.isInteger(abs) ? String(abs) : abs.toFixed(2)
  return (v < 0 ? '-' : '') + '¥' + s
}

/** 课时：两位小数内去尾零（1 / 0.67 / 1.5） */
export function fmtHours(n: number | null | undefined): string {
  const v = Math.round((n || 0) * 100) / 100
  return String(v)
}

// ── 场次状态徽标（日历 / 待结算共用一套口径）──────────────────────────

export interface StatusChip {
  text: string
  cls: 'ok' | 'warn' | 'rev' | 'plain'
}

/**
 * 场次状态徽标（含 settleStatus，V20 要求）。
 * 口径：请假/取消 → 请假态；settleStatus '2' → 已冲正；'1' → 已上·已结；
 *       其余「结束时间已过（或已标已上）且未结」→ 待结算；否则 已排/已上。
 */
export function sessionChip(
  sessionStatus: string,
  settleStatus?: string | null,
  passed = false,
): StatusChip {
  if (sessionStatus === '2') return { text: '请假', cls: 'rev' }
  if (sessionStatus === '3') return { text: '取消', cls: 'plain' }
  if (settleStatus === '2') return { text: '已冲正', cls: 'rev' }
  if (settleStatus === '1') return { text: '已上·已结', cls: 'ok' }
  if (sessionStatus === '1' || passed) return { text: '待结算', cls: 'warn' }
  return { text: '已排', cls: 'plain' }
}

/**
 * 徽标语义 → van-tag 的 type（纯展示映射，口径本身不动）。
 * 'plain' 走 default + plain，其余对上 Vant 的成功/警告/危险三色。
 */
export function chipTagType(cls: StatusChip['cls']): 'success' | 'warning' | 'danger' | 'default' {
  if (cls === 'ok') return 'success'
  if (cls === 'warn') return 'warning'
  if (cls === 'rev') return 'danger'
  return 'default'
}

/** 该场次是否算「过点未结」（日历上点它跳待结算页） */
export function isPending(
  sessionStatus: string,
  settleStatus: string | null | undefined,
  date: string,
  endTime: string,
): boolean {
  if (sessionStatus === '2' || sessionStatus === '3') return false
  if (settleStatus === '1' || settleStatus === '2') return false
  if (sessionStatus === '1') return true
  const end = new Date(`${date}T${hhmm(endTime) || '23:59'}:00`)
  return end.getTime() < Date.now()
}

// ── 待结算清单（模块级缓存：tabbar 角标 + settle 页同源）────────────────

const pendingList = ref<PendingSettlementVO[]>([])
const pendingLoading = ref(false)
/** BE 端点未就绪（404）等失败态：页面走空态兜底，不白屏也不反复重试刷屏 */
const pendingFailed = ref(false)

async function refreshPending(): Promise<void> {
  pendingLoading.value = true
  try {
    const data = await getPendingSettlements()
    pendingList.value = Array.isArray(data) ? data : []
    pendingFailed.value = false
  } catch (e) {
    console.warn('[m] getPendingSettlements 失败（BE 未就绪时按空清单渲染）', e)
    pendingList.value = []
    pendingFailed.value = true
  } finally {
    pendingLoading.value = false
  }
}

/** 待结算清单共享态：tabbar 角标读 list.length，settle 页读同一份并负责刷新 */
export function usePending() {
  return { pendingList, pendingLoading, pendingFailed, refreshPending }
}
