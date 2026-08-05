/**
 * PRD-018 D1 v2.1 / D8 / D11 · 课时双单位展示（小时 ⇄ 节）+ 每节价口径
 * —— 桌面与 H5 共用的唯一格式化底座。
 *
 * 🔴 **底账只记小时**（D1）：流水单轨不漂移。「节」是第一等**展示**单位，
 *    换算基准 = 绑定层的 `hoursPerLesson`（俊羽 1.5 / 好好 1）。
 * 🔴 **D4 规则②**：共享账本（绑定数>1）多人每节时长不同 → 基准不唯一，
 *    **只按小时不折节**。`dual()` 传 `perLesson=null` 即走这条，副显自动消失。
 * 🔴 金额是派生量：`小时 × pricePerHour`，不落库（充值行例外，见 amountPaid/AC9）。
 *
 * 🔴 **D11（2026-08-05 用户拍板：按小时计价的概念没有，只有课时的概念；原话见 PRD 决策表 D11）**：
 *    用户可见面**一律不出现按小时计价的说法**，对外口径统一 =「每节 X 小时 · Y 元/节」。
 *    `pricePerHour` 降级为**内部计价参数**（共享账本「同价才能并本」的数学根基），
 *    只在存储与推导里活着，不上屏。两个方向的换算都收口在本文件：
 *      展示：`toLessonPrice(pricePerHour, hoursPerLesson)`  = 每节价（2 位）
 *      收值：`toPricePerHour(lessonPrice, hoursPerLesson)`  = 内部参数（**4 位**）
 *    🔴 收值必须留 4 位：350 元/节 ÷ 1.5 小时 = 233.3333，砍成两位（233.33）每笔差几分，
 *       攒一学期就是对不上的账（PRD §4 M9/L5 把列精度提到 DECIMAL(10,4) 就是为这个）。
 *
 * 单位偏好全局共享 + 落 localStorage：切一次全站生效，刷新不丢。
 */
import { computed, ref } from 'vue'

export type TuitionUnit = 'h' | 'j'

const LS_KEY = 'bk.tuition.unit'

function readUnit(): TuitionUnit {
  try {
    return localStorage.getItem(LS_KEY) === 'j' ? 'j' : 'h'
  } catch {
    return 'h'
  }
}

/** 模块级单例：所有页面共享同一个 ref，一处切换全站联动（D8） */
const unit = ref<TuitionUnit>(readUnit())

export function setTuitionUnit(u: TuitionUnit) {
  unit.value = u
  try {
    localStorage.setItem(LS_KEY, u)
  } catch {
    /* 隐私模式写不进就算了，本次会话内仍生效 */
  }
}

// ── 纯数字格式化 ──────────────────────────────────────────────────────────

/** 两位小数内去尾零：1 / 0.67 / 1.5 / -5 */
export function fmtNum(n: number | null | undefined): string {
  const v = Math.round((n || 0) * 100) / 100
  return String(v)
}

/** 带符号：+15 / -1.5（0 不带号） */
export function fmtSigned(n: number | null | undefined): string {
  const v = Math.round((n || 0) * 100) / 100
  return v > 0 ? `+${v}` : String(v)
}

/** 金额：¥1800 / -¥200（负号在前，两位小数只在有小数时保留） */
export function fmtMoney(n: number | null | undefined): string {
  const v = Math.round((n || 0) * 100) / 100
  const abs = Math.abs(v)
  const s = Number.isInteger(abs) ? String(abs) : abs.toFixed(2)
  return (v < 0 ? '-' : '') + '¥' + s
}

/** 小时 → 节（perLesson 非法时按 1 兜底，绝不除 0） */
export function toLessons(hours: number | null | undefined, perLesson: number | null | undefined): number {
  const p = perLesson && perLesson > 0 ? perLesson : 1
  return Math.round(((hours || 0) / p) * 100) / 100
}

// ── 每节价（D11 对外唯一价格口径）──────────────────────────────────────────

/**
 * 内部计价参数 → **每节价**（元/节，2 位小数）= `pricePerHour × hoursPerLesson`。
 * 233.3333 × 1.5 = 349.99995 → 350，四位精度正好把「每节 350」原样还回来。
 * 🔴 基准缺失（共享账本 / 零绑定本，每节时长不唯一）返 `null` —— 调用方据此改口说
 *    「多人共用，每人每节时长不同」，而不是拿 1 兜底编一个假的每节价出来。
 */
export function toLessonPrice(
  pricePerHour: number | null | undefined,
  hoursPerLesson: number | null | undefined,
): number | null {
  if (!hoursPerLesson || hoursPerLesson <= 0) return null
  return Math.round((pricePerHour || 0) * hoursPerLesson * 100) / 100
}

/**
 * **每节价 → 内部计价参数**（🔴 **4 位小数**）= `lessonPrice ÷ hoursPerLesson`。
 * 350 ÷ 1.5 = 233.33333… → **233.3333**（不是 233.33）。这是提交前的唯一换算入口。
 */
export function toPricePerHour(
  lessonPrice: number | null | undefined,
  hoursPerLesson: number | null | undefined,
): number {
  if (!hoursPerLesson || hoursPerLesson <= 0) return 0
  return Math.round(((lessonPrice || 0) / hoursPerLesson) * 10000) / 10000
}

/** 「350 元/节」；基准缺失返 ''（不编假数） */
export function fmtLessonPrice(
  pricePerHour: number | null | undefined,
  hoursPerLesson: number | null | undefined,
): string {
  const p = toLessonPrice(pricePerHour, hoursPerLesson)
  return p === null ? '' : `${fmtNum(p)} 元/节`
}

/**
 * 对外计价全文：「每节 1.5 小时 · 350 元/节」（D11 统一口径，卡片/列表/弹窗都用它）。
 * 基准缺失时只报得出的那半句（共享本连每节时长都不唯一 → 返 ''）。
 */
export function priceSpecText(
  pricePerHour: number | null | undefined,
  hoursPerLesson: number | null | undefined,
): string {
  if (!hoursPerLesson || hoursPerLesson <= 0) return ''
  const p = toLessonPrice(pricePerHour, hoursPerLesson)
  const head = `每节 ${fmtNum(hoursPerLesson)} 小时`
  return p === null ? head : `${head} · ${fmtNum(p)} 元/节`
}

// ── 双单位串 ──────────────────────────────────────────────────────────────

export interface DualText {
  /** 主显（跟随全局单位）：如「1.5 小时」 */
  main: string
  /** 副显（另一单位，括号里）：如「1 节」；共享账本折不了节 → '' */
  sub: string
  /** 「1.5 小时（1 节）」；无副显时 = main */
  full: string
}

/**
 * 双单位并排文本（D1 v2.1 / D8 的唯一实现处）。
 *
 * @param hours     小时数（底账单位）
 * @param perLesson 每节时长；**null/0 = 共享账本或基准未知 → 只出小时，不折节**（D4 规则②）
 * @param u         显示单位；不传 = 跟随全局
 * @param signed    是否带 +/- 号（流水变动列用）
 */
export function dual(
  hours: number | null | undefined,
  perLesson: number | null | undefined,
  u: TuitionUnit = unit.value,
  signed = false,
): DualText {
  const f = signed ? fmtSigned : fmtNum
  const hTxt = `${f(hours)} 小时`
  if (!perLesson || perLesson <= 0) {
    // 共享账本：只按小时，不折节
    return { main: hTxt, sub: '', full: hTxt }
  }
  const jTxt = `${f(toLessons(hours, perLesson))} 节`
  const main = u === 'j' ? jTxt : hTxt
  const sub = u === 'j' ? hTxt : jTxt
  return { main, sub, full: `${main}（${sub}）` }
}

/** 「1.5 小时（1 节）」一把梭（模板里最常用） */
export function dualText(
  hours: number | null | undefined,
  perLesson: number | null | undefined,
  u?: TuitionUnit,
  signed = false,
): string {
  return dual(hours, perLesson, u ?? unit.value, signed).full
}

/**
 * 全局单位开关（D8）。
 * ```ts
 * const { unit, unitLabel, setUnit, d } = useTuitionUnit()
 * d(1.5, 1.5).full  // 「1.5 小时（1 节）」，跟随开关
 * ```
 */
export function useTuitionUnit() {
  const unitLabel = computed(() => (unit.value === 'j' ? '节' : '小时'))
  return {
    unit,
    unitLabel,
    setUnit: setTuitionUnit,
    /** 跟随全局单位的 dual（模板里直接用，切换时自动重算） */
    d: (h: number | null | undefined, perLesson: number | null | undefined, signed = false) =>
      dual(h, perLesson, unit.value, signed),
    dText: (h: number | null | undefined, perLesson: number | null | undefined, signed = false) =>
      dual(h, perLesson, unit.value, signed).full,
    fmtNum,
    fmtSigned,
    fmtMoney,
    toLessons,
    // D11 每节价口径（对外唯一价格说法）
    toLessonPrice,
    toPricePerHour,
    fmtLessonPrice,
    priceSpecText,
  }
}

/** 今天 'YYYY-MM-DD'（本地时区，绕开 toISOString 的差一天坑）—— 充值业务日期默认值 */
export function todayStr(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
