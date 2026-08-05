<script setup lang="ts">
/**
 * PRD-015 · /m/settle 待结算（V21）→ **PRD-018 批3 改版**（小时单位 + D10 域间解耦）。
 *
 * 🔄 本批改了什么：
 *   ① 🔴 **默认实扣只认 BE**（拍板 D-a / L4）：默认小时 = `pendingRow.plannedHours`（= 绑定的每节时长，
 *      BE 用与 settleOne 同一函数算出），金额 = `plannedAmount`。**前端「默认 1 课时」的自算已删** ——
 *      场次起止时长只是日程，不参与计价（改期/拖拽/缓冲格子永不影响钱）。
 *      老师改了小时才前端重算 = 实扣小时 × 账本计价参数。
 *   ② 每场可填「这节讲了什么」→ `SettleItemBo.content` → 写进 session.content，台账内容列直接显示它。
 *   ③ 🔴 **D10 拆收费硬闸**：没开本/账本停用**不再阻止勾选** —— 场次照常标「已上」，扣课跳过进
 *      「待补扣」，教学事实不被收费状态锁死。但金额列仍画「—」**绝不 ¥0**（BUG-2 铁律不动）。
 *      `sessionStatus==='1'` = 已上待补扣，与 '0' 未标已上分开打 tag。
 *   ④ 🔴 **结算不再建反馈壳**（D10）：撤掉「同时生成本课反馈壳」开关与全部反馈壳文案，
 *      `settleSessions({items})` 不传 genFeedback；反馈单去「反馈」页单独建。
 *   ⑤ 销假（AC5/G5）：请假**或取消**的场次一键改回「已上 · 未结」+ 删掉该场扣课/冲正流水对
 *      （净额为零，余额不变）→ 可重新结算。
 *   ⑥ 请假返回 `freedLessonId` → 提示「课次已释放，可重新排课」（D6 顺延已删的补位，M8）。
 *
 * 🔴 双单位展示（D1 v2.1 / D8）走 composables/useTuitionUnit 唯一底座，本页不自造第二套换算。
 * 🔴 已处理清单没有独立端点：按 D1「场次=一条线的交点」，直接从 getCalendar 近 14 天里挑
 *    已结/已冲正/请假/取消的场次渲染，与桌面端同一数据源。
 * 🔴 BE 未就绪 → 空态兜底不白屏；结算/请假失败由 http 拦截器提示，页面不吞错。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { showConfirmDialog, showSuccessToast, showToast } from 'vant'
import 'vant/es/toast/style'
import 'vant/es/dialog/style'
import {
  getCalendar,
  sessionLeave,
  sessionRevokeLeave,
  settleSessions,
  updateSession,
  type CalendarSessionVO,
  type PendingSettlementVO,
  type SettleItemBo,
} from '@/api/teacher/schedule'
import { DICT_EDU_SUBJECT, useDictStore } from '@/store/dict'
import { useTuitionUnit } from '@/composables/useTuitionUnit'
import MSheet from './components/MSheet.vue'
import { dayLabel, fmtDate, hhmm, money, todayStr, usePending } from './shared'

const dict = useDictStore()
const { d, dText, priceSpecText } = useTuitionUnit()
const { pendingList, pendingLoading, refreshPending } = usePending()

// ── 收费态口径（D10 拆硬闸后只影响**钱怎么显示**，不再决定能不能勾）──────────
// 🔴 plannedAmount == null = 该生该科**没开本或账本已停用**（BE 明写「无账本 = null 不是 0」）。
//    单价未知 ≠ 免费：金额列画「—」，绝不打成 ¥0（那等于告诉老师这节课免费，BUG-2 铁律不动）。
//    但**照常可勾选**：结算时 BE 跳过扣课、场次照标已上，钱留着开本后补（D10 / AC11）。
function priced(p: PendingSettlementVO): boolean {
  return p.plannedAmount !== null && p.plannedAmount !== undefined
}

/** 没账本可扣的场次数（提示用，不再是「拦住不让结」的计数） */
const unbookedCount = computed(() => pendingList.value.filter((p) => !priced(p)).length)

/** 没开本 与 账本停用是两回事，别一律劝人去开户 */
function bookNote(p: PendingSettlementVO): string {
  return p.accountStatus === '1'
    ? '该科账本已停用：会标为已上、暂不扣课，启用后可以再结一次补扣'
    : '未开通该科账本：会标为已上、暂不扣课，开本后可以再结一次补扣'
}

/** 该场的折节基准（没绑定就不折节，只出小时） */
function perLessonOf(p: PendingSettlementVO): number | null {
  return p.hoursPerLesson && p.hoursPerLesson > 0 ? p.hoursPerLesson : null
}

/** 🔴 默认实扣小时**只认 BE 的 plannedHours**；BE 给不出（没绑定）就留空让老师自己填 */
function plannedHoursOf(p: PendingSettlementVO): number | null {
  return p.plannedHours !== null && p.plannedHours !== undefined ? p.plannedHours : null
}

/** 内部计价参数（D11 不上屏，只用来算钱）：优先新字段；只有 price（元/节，M5 兼容位）时按每节时长折回，不另造算法 */
function pricePerHourOf(p: PendingSettlementVO): number {
  if (p.pricePerHour !== null && p.pricePerHour !== undefined) return p.pricePerHour
  const per = perLessonOf(p)
  return p.price !== null && p.price !== undefined && per ? p.price / per : 0
}

// ── 勾选态（默认全不选：钱线动作必须显式点选，防误触批量结算——补回归挂账②）──
const checked = ref<Set<string>>(new Set())

function syncChecked() {
  checked.value = new Set()
}

function toggle(id: string) {
  // 🔄 D10：没开本不再是「不可勾」——教学事实（已上）与收费状态解耦
  const s = new Set(checked.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  checked.value = s
}

const selectedCount = computed(() => checked.value.size)

// ── 近几日已处理（getCalendar 近 14 天 → 已结 / 已冲正 / 请假 / 取消）────────
// 🔴 请假/取消也要进这张清单：销假入口挂在它们身上（AC5），
//    否则手机上改错了的请假无处可回，只能跑去电脑端。
const doneList = ref<CalendarSessionVO[]>([])
const doneLoading = ref(false)

function isLeaveOrCancel(s: CalendarSessionVO): boolean {
  return s.sessionStatus === '2' || s.sessionStatus === '3'
}

async function loadDone() {
  doneLoading.value = true
  const from = new Date()
  from.setDate(from.getDate() - 13)
  try {
    const data = await getCalendar({ start: fmtDate(from), end: todayStr() })
    doneList.value = (Array.isArray(data) ? data : [])
      .filter((s) => s.settleStatus === '1' || s.settleStatus === '2' || isLeaveOrCancel(s))
      .sort((a, b) => (b.sessionDate + b.startTime).localeCompare(a.sessionDate + a.startTime))
  } catch (e) {
    console.warn('[m/settle] 已处理清单拉取失败', e)
    doneList.value = []
  } finally {
    doneLoading.value = false
  }
}

async function reloadAll() {
  await Promise.all([refreshPending(), loadDone()])
  syncChecked()
}

// ── 结算确认弹层 ──────────────────────────────────────────────
interface SettleRow {
  sessionId: string
  name: string
  subjectLabel: string
  /** 内部计价参数（每小时多少元，D11 不上屏）；没账本为 0 → 金额列画「—」 */
  pricePerHour: number
  /** 每节时长（折节基准）；没绑定为 null → 只出小时 */
  perLesson: number | null
  /** BE 给的默认实扣小时（老师没动就原样提交） */
  plannedHours: number | null
  /** BE 给的默认金额（老师没动小时就直接显示它，不用派生值二次计算） */
  plannedAmount: number | null
  /** 实扣小时（input 绑字符串，提交时转 number） */
  hours: string
  /** 🆕 这节实际讲了什么（≤200 字）→ session.content */
  content: string
  /** 该场排课日期（改期需整条 date+start+end 一起传） */
  date: string
  /** 排课起止（BUG-5/D：默认值，用户直接在这改；改了 = 改场次时间） */
  start: string
  end: string
  /** 打开弹层那一刻的排课起止快照，用来判「改没改」 */
  start0: string
  end0: string
  /** 打开弹层那一刻的默认小时，用来判老师有没有动过 */
  hours0: string
}

const sheetOpen = ref(false)
const submitting = ref(false)
const rows = reactive<SettleRow[]>([])

/** 老师改过实扣小时？（没改就用 BE 的 plannedAmount，改了才 小时 × 计价参数 重算） */
function hoursChanged(r: SettleRow): boolean {
  return r.hours !== r.hours0
}

function rowHours(r: SettleRow): number {
  return Math.max(0, parseFloat(r.hours) || 0)
}

/** 本行金额：没改就吃 BE 的 plannedAmount；改了小时才 小时 × 计价参数；没账本恒 null（画「—」） */
function rowFee(r: SettleRow): number | null {
  if (!r.pricePerHour) return null
  if (!hoursChanged(r) && r.plannedAmount !== null) return r.plannedAmount
  return rowHours(r) * r.pricePerHour
}

/** 该行的上课时间被改过？（BUG-5/D：改了才走改期，没改一个字节都不动） */
function timeChanged(r: SettleRow): boolean {
  return !!r.start && !!r.end && (r.start !== r.start0 || r.end !== r.end0)
}

function openSettleSheet() {
  // 🔄 D10：没开本的也进来（BE 跳过扣课、场次照标已上），不再在前端剔掉
  const picked = pendingList.value.filter((p) => checked.value.has(p.sessionId))
  if (!picked.length) {
    showToast('先勾选要结算的场次')
    return
  }
  rows.splice(
    0,
    rows.length,
    ...picked.map((p) => {
      // 🔴 默认小时只认 BE：给不出就留空（宁可让老师填，也不假装「1 课时」）
      const ph = plannedHoursOf(p)
      const h = ph === null ? '' : String(ph)
      return {
        sessionId: p.sessionId,
        name: p.targetName,
        subjectLabel: dict.label(DICT_EDU_SUBJECT, p.subject) || '',
        pricePerHour: pricePerHourOf(p),
        perLesson: perLessonOf(p),
        plannedHours: ph,
        plannedAmount: p.plannedAmount ?? null,
        hours: h,
        content: '',
        date: p.date,
        start: hhmm(p.start),
        end: hhmm(p.end),
        start0: hhmm(p.start),
        end0: hhmm(p.end),
        hours0: h,
      }
    }),
  )
  sheetOpen.value = true
}

// ── 上课时间选择器（van-picker-group：起 / 止 两步滚轮）────────────────
// 🔴 复用「排课/改期同款语义」= 同日改起止的 HH:mm 两个值，不引入日期维度（改日期仍在电脑端）。
// 🔴 D-a 之后改时段**不影响钱**（时段=日程），这里改只为让场次时间与实况一致。
const tpOpen = ref(false)
const tpIdx = ref(-1)
const tpStart = ref<string[]>(['09', '00'])
const tpEnd = ref<string[]>(['10', '30'])

function splitHm(v: string, fallback: string[]): string[] {
  const m = /^(\d{2}):(\d{2})$/.exec(v || '')
  return m ? [m[1], m[2]] : fallback
}

function openTimePicker(i: number) {
  const r = rows[i]
  if (!r) return
  tpIdx.value = i
  tpStart.value = splitHm(r.start, ['09', '00'])
  tpEnd.value = splitHm(r.end, ['10', '30'])
  tpOpen.value = true
}

function tpConfirm() {
  const r = rows[tpIdx.value]
  if (r) {
    r.start = tpStart.value.join(':')
    r.end = tpEnd.value.join(':')
  }
  tpOpen.value = false
}

async function confirmSettle() {
  // BUG-5/D：先把改过时间的场次走既有改期链（PUT session/{id}，同日改起止），
  // 再结算——顺序不能反：先扣费后改期会让流水与场次时间对不上。
  const retimed = rows.filter(timeChanged)
  const bad = retimed.find((r) => r.start >= r.end)
  if (bad) {
    showToast(`「${bad.name}」的结束时间要晚于开始时间`)
    return
  }
  const noHours = rows.find((r) => !rowHours(r))
  if (noHours) {
    showToast(`「${noHours.name}」还没填实扣时长`)
    return
  }
  submitting.value = true
  try {
    for (const r of retimed) {
      await updateSession(r.sessionId, { date: r.date, start: r.start, end: r.end })
    }
    if (retimed.length) {
      for (const r of retimed) {
        r.start0 = r.start
        r.end0 = r.end
      }
      showSuccessToast(`已更新 ${retimed.length} 场的上课时间`)
    }
    const items: SettleItemBo[] = rows.map((r) => ({
      sessionId: r.sessionId,
      hours: Math.round(rowHours(r) * 100) / 100,
      ...(r.content.trim() ? { content: r.content.trim() } : {}),
    }))
    // 🔄 D10：结算只做「扣课 + 标已上」两件事，不再副作用式建反馈壳（genFeedback 不传）
    const res = await settleSessions({ items })
    sheetOpen.value = false
    const n = res?.settled ?? items.length
    const skipped = res?.skipped || []
    if (n > 0) showSuccessToast(`已结算 ${n} 场：扣课完成，场次已标已上`)
    // 全部被跳过（没账本/已结算幂等/班课…）时不能报"成功"，把 BE 的 reason 原样给老师
    if (skipped.length) {
      showToast({
        message: `${skipped.length} 场跳过：${skipped.map((s) => s.reason).join('；')}`,
        duration: 6000,
      })
    }
    await reloadAll()
  } catch {
    // 拦截器已提示（含重复结算的幂等业务码文案）
  } finally {
    submitting.value = false
  }
}

// ── 改请假（冲正返还）/ 销假（收回请假·取消）────────────────────────────
const acting = ref('')

async function onLeave(s: CalendarSessionVO) {
  try {
    await showConfirmDialog({
      title: '改请假',
      // 🔄 D10：结算不再建反馈壳 → 原文案「未填内容的反馈壳会被删除」已过时，删掉
      message: `将「${s.targetName} ${s.sessionDate} ${hhmm(s.startTime)}」改为请假：已扣的课时与课费会自动冲正返还。确认？`,
      confirmButtonText: '确认改请假',
      cancelButtonText: '再想想',
    })
  } catch {
    return
  }
  acting.value = s.id
  try {
    const res = await sessionLeave(s.id)
    showSuccessToast('已改请假：课时课费已冲正返还')
    // M8：顺延已删，改由「课次释放回池」接住——不提示的话老师不知道那节课还要补排
    if (res?.freedLessonId) showToast('课次已释放，可重新排课')
    await reloadAll()
  } catch {
    // 拦截器已提示
  } finally {
    acting.value = ''
  }
}

/** 销假（AC5/G5）：请假**或取消**的课实际上了 → 收回，重新可结算 */
async function onRevokeLeave(s: CalendarSessionVO) {
  const what = s.sessionStatus === '3' ? '取消' : '请假'
  try {
    await showConfirmDialog({
      title: `销假 · 收回${what}`,
      message: `将「${s.targetName} ${s.sessionDate} ${hhmm(s.startTime)}」改回「已上 · 未结」，并删除该场的冲正/扣课流水对（净额为零，余额不变），之后可以重新结算。确认？`,
      confirmButtonText: '确认销假',
      cancelButtonText: '再想想',
    })
  } catch {
    return
  }
  acting.value = s.id
  try {
    const res = await sessionRevokeLeave(s.id)
    showSuccessToast('已销假：场次改回已上 · 未结，可以重新结算')
    // 请假时课次已释放回池，可能已被排给别的场次 → BE 不自动还原，得老师手工改绑
    if (res?.planLessonId) {
      showToast({ message: '原来绑的课次已释放，需要的话去电脑端手工改绑', duration: 5000 })
    }
    await reloadAll()
  } catch {
    // 拦截器已提示（已结未冲的场次 BE 返 400，防凭空还钱）
  } finally {
    acting.value = ''
  }
}

onMounted(reloadAll)
</script>

<template>
  <section>
    <van-notice-bar wrapable :scrollable="false" :left-icon="pendingList.length ? 'warning-o' : 'passed'">
      <template v-if="pendingList.length">
        有 <b>{{ pendingList.length }} 场</b>已过点未结算——勾选后一键结算：扣课时课费 + 标已上。
        <template v-if="unbookedCount">
          其中 <b>{{ unbookedCount }} 场</b>没有可扣的账本（没开本或已停用）：照样能结，
          会标为已上、暂不扣课，开本后再结一次补扣。
        </template>
      </template>
      <template v-else-if="pendingLoading">正在查过点未结算的场次…</template>
      <template v-else>当前没有待结算场次</template>
    </van-notice-bar>

    <van-cell-group inset title="过点未结算">
      <van-loading v-if="pendingLoading" class="m-note" size="18">加载中…</van-loading>
      <van-empty v-else-if="!pendingList.length" image="search" image-size="70" description="干净！没有待结算场次" />
      <template v-else>
        <van-cell
          v-for="p in pendingList"
          :key="p.sessionId"
          clickable
          value-class="m-vnarrow"
          @click="toggle(p.sessionId)"
        >
          <template #icon>
            <van-checkbox
              :model-value="checked.has(p.sessionId)"
              style="margin-right: 10px"
              @click.stop="toggle(p.sessionId)"
            />
          </template>
          <template #title>
            <span class="m-rowtitle">
              <b>{{ p.targetName }}</b>
              <van-tag v-if="p.subject" type="primary" plain>
                {{ dict.label(DICT_EDU_SUBJECT, p.subject) }}
              </van-tag>
              <!-- D10：已上待补扣 vs 还没标已上，两种态分开打 -->
              <van-tag v-if="p.sessionStatus === '1'" type="warning" plain>已上待补扣</van-tag>
              <van-tag v-else plain>未标已上</van-tag>
              <van-tag v-if="!priced(p)" type="warning">
                {{ p.accountStatus === '1' ? '账本停用' : '未开本' }}
              </van-tag>
            </span>
          </template>
          <template #label>
            {{ dayLabel(p.date) }} {{ hhmm(p.start) }}–{{ hhmm(p.end) }}
            <template v-if="p.planLessonTitle"> · {{ p.planLessonTitle }}</template>
            <span v-if="p.sessionStatus === '1'" style="display: block">
              已标已上、钱还没扣——这次结算就是补扣。
            </span>
            <span v-if="!priced(p)" style="display: block; color: var(--m-warn)">
              {{ bookNote(p) }}
            </span>
          </template>
          <template #value>
            <!-- 🔴 BUG-2：金额未知画成「—」，绝不打成 ¥0（那等于告诉老师这节课免费） -->
            <template v-if="priced(p)">
              <div class="m-num">
                <b>{{ money(p.plannedAmount) }}</b>
              </div>
              <div class="m-note" style="margin: 0">
                默认扣 {{ d(p.plannedHours, perLessonOf(p)).main }}
              </div>
            </template>
            <template v-else>
              <div class="m-muted"><b>—</b></div>
              <div class="m-note" style="margin: 0">暂不扣课</div>
            </template>
          </template>
        </van-cell>
      </template>
    </van-cell-group>

    <van-cell-group inset title="近几日已处理">
      <van-loading v-if="doneLoading" class="m-note" size="18">加载中…</van-loading>
      <van-empty v-else-if="!doneList.length" image="search" image-size="70" description="近 14 天没有已处理场次" />
      <template v-else>
        <van-cell v-for="s in doneList" :key="s.id" value-class="m-vnarrow">
          <template #title>
            <span class="m-rowtitle">
              <b>{{ s.targetName }}</b>
              <van-tag v-if="s.subjectLabel" type="primary" plain>{{ s.subjectLabel }}</van-tag>
              <van-tag v-if="s.sessionStatus === '2'" type="danger" plain>请假</van-tag>
              <van-tag v-else-if="s.sessionStatus === '3'" plain>取消</van-tag>
              <van-tag v-else-if="s.settleStatus === '2'" type="danger">已冲正</van-tag>
              <van-tag v-else type="success">已上 · 已结</van-tag>
            </span>
          </template>
          <template #label>
            {{ dayLabel(s.sessionDate) }} {{ hhmm(s.startTime) }}–{{ hhmm(s.endTime) }}
            <template v-if="s.lessonTitle"> · {{ s.lessonTitle }}</template>
          </template>
          <template #value>
            <!-- 请假/取消 → 销假（收回，可重新结算）；已结未冲 → 改请假（冲正返还） -->
            <van-button
              v-if="isLeaveOrCancel(s)"
              size="mini"
              type="primary"
              plain
              :loading="acting === s.id"
              @click="onRevokeLeave(s)"
            >
              销假（收回）
            </van-button>
            <van-button
              v-else-if="s.settleStatus === '1'"
              size="mini"
              type="danger"
              plain
              :loading="acting === s.id"
              @click="onLeave(s)"
            >
              改请假（冲正返还）
            </van-button>
          </template>
        </van-cell>
      </template>
    </van-cell-group>

    <van-submit-bar
      v-if="pendingList.length"
      button-text="一键结算"
      button-type="primary"
      :disabled="!selectedCount"
      @submit="openSettleSheet"
    >
      <span class="m-note" style="margin: 0">
        已选 <b>{{ selectedCount }}</b> 场
      </span>
    </van-submit-bar>

    <MSheet
      v-model="sheetOpen"
      title="确认结算"
      sub="默认实扣时长 = 与家长约定的每节时长（系统给的，不看排课时段）；改了才按账本计价重算。顺手记下这节讲了什么，台账里就能看到"
    >
      <van-cell-group v-for="(r, i) in rows" :key="r.sessionId" inset>
        <van-cell>
          <template #title>
            <span class="m-rowtitle">
              <b>{{ r.name }}</b>
              <van-tag v-if="r.subjectLabel" type="primary" plain>{{ r.subjectLabel }}</van-tag>
              <!-- D11：价格口径 =「每节 X 小时 · Y 元/节」，折不出每节时长时只报每节价算不出来 -->
              <span v-if="r.pricePerHour" class="m-note" style="margin: 0">
                {{ priceSpecText(r.pricePerHour, r.perLesson) }}
              </span>
              <span v-else class="m-note" style="margin: 0">无账本 · 只标已上，暂不扣课</span>
            </span>
          </template>
          <template #value>
            <b v-if="rowFee(r) !== null" class="m-num">-{{ money(rowFee(r)) }}</b>
            <b v-else class="m-muted">—</b>
          </template>
        </van-cell>
        <van-field
          v-model="r.hours"
          label="实扣小时"
          type="number"
          inputmode="decimal"
          :placeholder="r.plannedHours !== null ? String(r.plannedHours) : '按约定的每节时长填'"
        >
          <template #extra>
            <span class="m-note" style="margin: 0">{{ dText(rowHours(r), r.perLesson) }}</span>
          </template>
        </van-field>
        <!-- 🆕 PRD-018 ③：这节实际讲了什么 → session.content，台账「内容」列直接显示它 -->
        <van-field
          v-model="r.content"
          label="讲了什么"
          type="textarea"
          rows="1"
          autosize
          maxlength="200"
          show-word-limit
          placeholder="如：思维题：等差数列的应用｜等差数列求和（可留空）"
        />
        <!-- BUG-5/D：上课时间直接改；改了即在结算前走既有改期链更新场次（D-a 之后不影响钱） -->
        <van-field
          :model-value="`${r.start} – ${r.end}`"
          label="上课时间"
          readonly
          is-link
          @click="openTimePicker(i)"
        >
          <template v-if="timeChanged(r)" #button>
            <van-tag type="warning">将改期</van-tag>
          </template>
        </van-field>
      </van-cell-group>

      <p class="m-fnote">结算只做「扣课 + 标已上」两件事；课后反馈单去「反馈」页单独建，两边互不牵制。</p>

      <template #acts>
        <van-button block @click="sheetOpen = false">取消</van-button>
        <van-button block type="primary" :loading="submitting" loading-text="结算中…" @click="confirmSettle">
          确认扣费
        </van-button>
      </template>
    </MSheet>

    <!-- 起 / 止 两步时间选择（Vant 官方的时间区间范式，比两个并排下拉在 390px 上好点得多） -->
    <van-popup v-model:show="tpOpen" position="bottom" round>
      <van-picker-group
        title="上课时间"
        :tabs="['开始时间', '结束时间']"
        next-step-text="下一步"
        @confirm="tpConfirm"
        @cancel="tpOpen = false"
      >
        <van-time-picker v-model="tpStart" :columns-type="['hour', 'minute']" />
        <van-time-picker v-model="tpEnd" :columns-type="['hour', 'minute']" />
      </van-picker-group>
    </van-popup>
  </section>
</template>
