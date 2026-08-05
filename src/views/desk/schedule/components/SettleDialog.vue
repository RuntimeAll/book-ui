<script setup lang="ts">
/**
 * 一键结算弹窗（PRD-015 批3 起家 → PRD-018 批3 改造：D-a / D10 / ③）。
 *
 * 多选待结算场次 → 每场可改「实扣小时」+ 记「这节讲了什么」→ 确认扣课。
 *
 * 🔴 **默认实扣只认 BE**（拍板 D-a）：默认小时 = `plannedHours`（= 该绑定的每节时长，BE 用与
 *    settleOne 同一个函数算出），默认金额 = `plannedAmount`。**前端不再自算默认值**——排课时段
 *    只是日程，改期/拖拽/缓冲格子永不影响钱。只有老师手动改了小时数，金额才前端按
 *    `pricePerHour` 重算（hours 参数 = 人工覆盖位）。
 * 🔴 **D10 域间解耦**：结算只做「扣课 + 标已上」两件事，**不再副作用式建反馈壳**；
 *    「同时生成反馈壳」开关整段撤除，课后反馈到反馈页单独建单。
 * 🔴 **D10 拆收费硬闸**：未开本 / 账本停用（price=null）**不再阻止勾选**——教学事实不被收费
 *    状态锁死。这类场次照常标已上、扣课跳过进「待补扣」，金额列画「—」（绝不画假的 ¥0）。
 * 🔴 上课时间：默认 = 该场排课起止，改了 → 结算前先走 updateSession 改期链把场次时间更新掉；
 *    D-a 起它**不参与计价**，只是把日程改准。
 *
 * 单场版 = 父级只传一行（详情抽屉 / 场次表 / 工作台「结算这节课」走这条路）。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  settleSessions,
  updateSession,
  type PendingSettlementVO,
  type SettleItemBo,
} from '@/api/teacher/schedule'
import { useTuitionUnit } from '@/composables/useTuitionUnit'

/**
 * 弹窗行 = 待结算行 + priceUnknown（单场版从抽屉/场次表/工作台进来、该场还没进待结算清单时
 * 单价与 plannedHours 都取不到；金额列显示「按账本时薪」而不是假的 ¥0，真实扣数由 BE 算）。
 */
export type SettleRow = PendingSettlementVO & { priceUnknown?: boolean }

const props = defineProps<{
  visible: boolean
  /** 待结算行（父级从 pending 清单取，或单场版自造一行） */
  rows: SettleRow[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'settled'): void
}>()

// D1 v2.1/D8 双单位底座：本弹窗主单位固定「小时」（底账单位），副显「节」按该绑定的每节时长折算
const { fmtNum, fmtMoney, toLessons, dText } = useTuitionUnit()

const innerVisible = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v),
})

/** 每场的编辑态；start0/end0 = 排课起止快照用于判改动，hours0 = BE 默认值快照用于判「老师改没改」 */
interface EditRow {
  checked: boolean
  /** 实扣小时；**null = 不覆盖**，交 BE 按该绑定的每节时长算（单场版拿不到 plannedHours 时就是它） */
  hours: number | null
  /** 打开时的 BE 默认值快照；与 hours 相等 = 老师没动过 → 金额直接用 BE 的 plannedAmount */
  hours0: number | null
  /** PRD-018 ③：这节课实际讲了什么（≤200 字，台账「内容」列显示它） */
  content: string
  start: string
  end: string
  start0: string
  end0: string
}
const edits = ref<Record<string, EditRow>>({})
const saving = ref(false)

/** 打开时重置：全部默认勾上（D10 起未开本也可勾）、实扣取 BE 默认、上课时间预填该场排课起止 */
watch(
  () => [props.visible, props.rows] as const,
  ([v]) => {
    if (!v) return
    const next: Record<string, EditRow> = {}
    for (const r of props.rows) {
      const s = (r.start || '').slice(0, 5)
      const e = (r.end || '').slice(0, 5)
      // 🔴 只认 BE 的 plannedHours，取不到就留 null（提交时不传 hours，由 BE 定）
      const h = r.plannedHours ?? null
      next[r.sessionId] = {
        checked: true,
        hours: h,
        hours0: h,
        // 契约缺口：PendingSettlementVO 不带已有 content，只能空起（留空 = 台账退课次标题）
        content: '',
        start: s,
        end: e,
        start0: s,
        end0: e,
      }
    }
    edits.value = next
  },
  { immediate: true, deep: true },
)

function editOf(id: string): EditRow {
  // 兜底返新对象（不共享单例）：万一 edits 还没填好，往兜底上写不会串到别的行
  return (
    edits.value[id] || {
      checked: false,
      hours: null,
      hours0: null,
      content: '',
      start: '',
      end: '',
      start0: '',
      end0: '',
    }
  )
}

/**
 * 该场没有可用账本？（未开本 or 账本停用 —— BE 用 price=null 表达这两种成因）
 * 🔴 单场版（priceUnknown）只是「此刻清单里查不到这行」，不等于没开本，别乱扣帽子。
 */
function noAccount(r: SettleRow): boolean {
  if (r.priceUnknown) return false
  return r.price === null || r.price === undefined
}

/**
 * 无账本时的提示（D10 拆硬闸后是**提示**不是阻断）：说准成因 + 说清后果。
 * accountStatus='1' 是「开了但停用了」（去学生卡启用），null 才是真没开本。
 */
function noAccountNote(r: SettleRow): string {
  const why = r.accountStatus === '1' ? '该科账本已停用' : '未开通该科账本'
  return `${why}：本场会标为已上、暂不扣课，开本后可再结一次补扣`
}

/**
 * 场次状态标（D10）：待结算清单现在会同时收两种态，得让老师一眼分得清——
 * '1' = 已上待补扣（教学事实已落、钱没扣），'0' = 已排但还没标已上（过点了）。
 */
function statusTag(r: SettleRow): { label: string; type: 'warning' | 'info' } | null {
  if (r.sessionStatus === '1') return { label: '已上待补扣', type: 'warning' }
  if (r.sessionStatus === '0') return { label: '未标已上', type: 'info' }
  return null
}

/** 列表里有「已上待补扣」的行时，顶部多给一句解释（老师不该猜这四个字什么意思） */
const hasCatchUp = computed(() => props.rows.some((r) => r.sessionStatus === '1'))

/** 老师动过实扣小时？动过才由前端算金额，没动一律用 BE 的 plannedAmount */
function hoursTouched(r: SettleRow): boolean {
  const e = editOf(r.sessionId)
  return e.hours !== e.hours0
}

/** 上课时间被改过？改了才走改期，没改一个字节都不动（BUG-5/D） */
function timeChanged(r: SettleRow): boolean {
  const e = editOf(r.sessionId)
  return !!e.start && !!e.end && (e.start !== e.start0 || e.end !== e.end0)
}

/** 该行生效的实扣小时（null = 交 BE 按每节时长定） */
function effHours(r: SettleRow): number | null {
  return editOf(r.sessionId).hours
}

/** 该行副显「≈ N 节」（基准 = 该绑定的每节时长；没基准就不折节，D4 规则②） */
function lessonSub(r: SettleRow): string {
  const h = effHours(r)
  const p = r.hoursPerLesson
  if (h === null || !p || p <= 0) return ''
  return `≈ ${fmtNum(toLessons(h, p))} 节`
}

/**
 * 该行金额。🔴 没改小时 → 直接用 BE 的 plannedAmount（唯一权威，前端不自算）；
 * 改了小时 → 才按 hours × pricePerHour 重算。拿不到时薪就返 null（画「按账本时薪」而不是 ¥0）。
 */
function rowAmount(r: SettleRow): number | null {
  if (!hoursTouched(r)) return r.plannedAmount ?? null
  const pph = r.pricePerHour
  const h = effHours(r)
  if (pph === null || pph === undefined || h === null) return null
  return Math.round(h * pph * 100) / 100
}

/** 金额列文案：无账本 '—'（绝不画 ¥0）/ 算不出来「按账本时薪」/ 正常 ¥N */
function amountLabel(r: SettleRow): string {
  if (noAccount(r)) return '—'
  const a = rowAmount(r)
  return a === null ? '按账本时薪' : fmtMoney(a)
}

const selected = computed(() => props.rows.filter((r) => editOf(r.sessionId).checked))

/** 合计小时：只累加算得出来的行；折不折节看基准是否唯一 → 混选一律只按小时（D4 规则②） */
const totalHours = computed(() =>
  Math.round(selected.value.reduce((s, r) => s + (effHours(r) ?? 0), 0) * 100) / 100,
)
const totalHoursLabel = computed(() => dText(totalHours.value, null))
/** 实扣小时交给 BE 定的行数（合计里算不进来，得单独说一句） */
const beDecidedCount = computed(() => selected.value.filter((r) => effHours(r) === null).length)
/** 无账本 → 本次不扣课的行数 */
const noAccountCount = computed(() => selected.value.filter(noAccount).length)

const totalAmount = computed(
  () => Math.round(selected.value.reduce((s, r) => s + (noAccount(r) ? 0 : rowAmount(r) ?? 0), 0) * 100) / 100,
)
/** 金额算不出来的行（单场版/无时薪）——照常求和会在钱屏上打出假 ¥0，必须注明 */
const unknownAmountCount = computed(
  () => selected.value.filter((r) => !noAccount(r) && rowAmount(r) === null).length,
)
const totalAmountLabel = computed(() => {
  const known = selected.value.length - unknownAmountCount.value - noAccountCount.value
  if (!known) return unknownAmountCount.value ? '金额按账本时薪' : '—'
  const base = fmtMoney(totalAmount.value)
  return unknownAmountCount.value ? `${base} + ${unknownAmountCount.value} 场按账本时薪` : base
})

const allChecked = computed({
  get: () => props.rows.length > 0 && props.rows.every((r) => editOf(r.sessionId).checked),
  set: (v: boolean) => {
    for (const r of props.rows) editOf(r.sessionId).checked = v
  },
})

function dayLabel(d: string): string {
  return d ? `${Number(d.slice(5, 7))}-${d.slice(8, 10)}` : ''
}

async function submit() {
  const picked = selected.value
  if (!picked.length) {
    ElMessage.warning('请至少选择一场课')
    return
  }
  // 留空 = 交 BE 按每节时长定，合法；填了就必须是正数
  const bad = picked.find((r) => {
    const h = editOf(r.sessionId).hours
    return h !== null && !(Number(h) > 0)
  })
  if (bad) {
    ElMessage.warning('实扣小时需大于 0（留空 = 按账本每节时长扣）')
    return
  }
  // BUG-5/D：改过时间的场次，结算前先走既有改期链更新场次时间。
  // 顺序不能反——先扣费后改期会让流水与场次时间对不上；改期失败则整单不结算。
  const retimed = picked.filter(timeChanged)
  const badTime = retimed.find((r) => editOf(r.sessionId).start >= editOf(r.sessionId).end)
  if (badTime) {
    ElMessage.warning(`「${badTime.targetName || '该场'}」的结束时间要晚于开始时间`)
    return
  }
  saving.value = true
  try {
    for (const r of retimed) {
      const e = editOf(r.sessionId)
      await updateSession(r.sessionId, { date: r.date, start: e.start, end: e.end })
      e.start0 = e.start
      e.end0 = e.end
    }
    if (retimed.length) {
      ElMessage.success(`已更新 ${retimed.length} 场的上课时间`)
    }
    // 🔴 D10：不传 genFeedback（结算不建反馈壳）
    const res = await settleSessions({
      items: picked.map((r) => {
        const e = editOf(r.sessionId)
        const item: SettleItemBo = { sessionId: r.sessionId }
        // hours 只在老师人工覆盖时传；没动就不传，扣多少由 BE 的 plannedHours 定（D-a）
        if (e.hours !== null && e.hours !== e.hours0) item.hours = e.hours
        const c = e.content.trim()
        if (c) item.content = c
        return item
      }),
    })
    const ok = res?.settled ?? 0
    const skipped = res?.skipped || []
    if (ok > 0) {
      // 🔴 D10：原「生成 N 份反馈」整段删除，改成引导去反馈页单独建单
      const parts = [`已结算 ${ok} 场`]
      if (skipped.length) parts.push(`${skipped.length} 场跳过`)
      ElMessage({
        type: skipped.length ? 'warning' : 'success',
        message: `${parts.join('，')}；课后反馈请到「反馈」页单独建单`,
      })
    }
    if (skipped.length) {
      ElMessage({
        type: 'warning',
        message: `跳过：${skipped.map((s) => s.reason).join('；')}`,
        duration: 6000,
      })
    }
    if (ok > 0 || !skipped.length) {
      innerVisible.value = false
    }
    emit('settled')
  } catch (e) {
    console.warn('[settle] 结算失败', e)
    ElMessage.error('结算失败，请重试')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog v-model="innerVisible" title="结算确认" width="920px" append-to-body>
    <div class="st-hint">
      确认后完成两件事：<b>按账本扣课时</b> · <b>场次标记已上</b>。实扣默认 =
      该学生该科<b>每节约定时长</b>（排课时段只是日程，不参与算钱），改了小时数金额才跟着重算。<br />
      课后反馈<b>不再自动生成</b>——请到「反馈」页单独建单（建单时会自动带上课程计划的课次主题）。<br />
      上课时间默认 = 排课时间，<b>改了即更新场次时间</b>（只改日程，不影响扣多少）。
    </div>
    <div v-if="hasCatchUp" class="st-hint st-hint-warn">
      <b>「已上待补扣」</b>= 这节课教学事实已经落了（标过已上），但当时没账本 / 账本停用，钱没扣成。
      现在结算 = 把这笔课时补扣上，场次状态不变。
    </div>

    <table class="st-tb">
      <thead>
        <tr>
          <th style="width: 40px">
            <el-checkbox v-model="allChecked" />
          </th>
          <th style="width: 76px">日期</th>
          <th style="width: 104px">排课时段</th>
          <th>学生 · 内容</th>
          <th style="width: 128px">实扣小时</th>
          <th style="width: 104px">金额</th>
          <th style="width: 226px">上课时间（改了即改期）</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="r in rows" :key="r.sessionId">
          <tr :class="{ off: noAccount(r) }">
            <td>
              <!-- 🔴 D10：未开本/停用不再 disabled——教学事实不被收费状态锁死 -->
              <el-checkbox v-model="editOf(r.sessionId).checked" />
            </td>
            <td class="num">{{ dayLabel(r.date) }}</td>
            <td class="num">{{ r.start }}–{{ r.end }}</td>
            <td>
              <b>{{ r.targetName || '—' }}</b>
              <el-tag
                v-if="statusTag(r)"
                size="small"
                effect="plain"
                class="st-stat"
                :type="statusTag(r)!.type"
              >
                {{ statusTag(r)!.label }}
              </el-tag>
              <span class="st-sub">
                {{ r.subjectLabel || '' }}{{ r.planLessonTitle ? ' · ' + r.planLessonTitle : '' }}
              </span>
              <span v-if="noAccount(r)" class="st-warn">{{ noAccountNote(r) }}</span>
            </td>
            <td>
              <el-input-number
                v-model="editOf(r.sessionId).hours"
                :min="0.01"
                :max="99"
                :step="0.5"
                :precision="2"
                :value-on-clear="null"
                size="small"
                controls-position="right"
                style="width: 100px"
                placeholder="按账本"
              />
              <span v-if="lessonSub(r)" class="st-lesson">{{ lessonSub(r) }}</span>
              <span v-else-if="effHours(r) === null" class="st-lesson">按每节时长</span>
            </td>
            <td class="num money">{{ amountLabel(r) }}</td>
            <td>
              <div class="st-time">
                <el-time-picker
                  v-model="editOf(r.sessionId).start"
                  format="HH:mm"
                  value-format="HH:mm"
                  placeholder="开始"
                  size="small"
                  style="width: 92px"
                />
                <span class="st-dash">–</span>
                <el-time-picker
                  v-model="editOf(r.sessionId).end"
                  format="HH:mm"
                  value-format="HH:mm"
                  placeholder="结束"
                  size="small"
                  style="width: 92px"
                />
                <el-tag v-if="timeChanged(r)" size="small" type="warning" effect="plain">改期</el-tag>
              </div>
            </td>
          </tr>
          <!-- PRD-018 ③：每场记一句「这节讲了什么」→ session.content，台账「内容」列显示它 -->
          <tr class="st-ct">
            <td></td>
            <td colspan="6">
              <div class="st-ct-box">
                <span class="st-ct-lab">这节讲了什么</span>
                <el-input
                  v-model="editOf(r.sessionId).content"
                  type="textarea"
                  :autosize="{ minRows: 1, maxRows: 3 }"
                  maxlength="200"
                  show-word-limit
                  placeholder="写实际讲的内容，如：思维题·等差数列应用｜同步·平行与垂直（留空则台账显示课次标题）"
                />
              </div>
            </td>
          </tr>
        </template>
        <tr v-if="!rows.length">
          <td colspan="7" class="st-empty">暂无待结算的课</td>
        </tr>
      </tbody>
    </table>

    <template #footer>
      <div class="st-foot">
        <span class="st-total">
          已选 <b>{{ selected.length }}</b> 场 · 共扣 <b>{{ totalHoursLabel }}</b> ·
          <b>{{ totalAmountLabel }}</b>
          <span v-if="beDecidedCount" class="st-foot-note">
            （另 {{ beDecidedCount }} 场按账本每节时长扣）
          </span>
          <span v-if="noAccountCount" class="st-foot-note">
            （{{ noAccountCount }} 场无账本，只标已上不扣课）
          </span>
        </span>
        <span class="st-spacer" />
        <el-button @click="innerVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!selected.length" @click="submit">
          确认结算
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.st-hint {
  font-size: 12.5px;
  color: #5f716d;
  background: var(--bk-teal-soft);
  border-radius: 8px;
  padding: 9px 12px;
  margin-bottom: 10px;
  line-height: 1.7;
}
.st-hint-warn {
  background: #fdf3e7;
  color: #8a5a12;
}
.st-tb {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.8px;
}
.st-tb th {
  text-align: left;
  font-size: 11.5px;
  color: #8ba09a;
  font-weight: 700;
  letter-spacing: 0.06em;
  padding: 8px 10px;
  border-bottom: 1px solid var(--bk-line);
  white-space: nowrap;
}
.st-tb td {
  padding: 8px 10px;
  vertical-align: middle;
}
/* 主行不画底线，由内容行收底——一场课的两行视觉上是一整块 */
.st-tb tr.st-ct td {
  padding-top: 0;
  padding-bottom: 10px;
  border-bottom: 1px solid #eef3f1;
}
.st-tb tr.off td {
  background: #fafcfb;
}
.st-tb .num {
  font-variant-numeric: tabular-nums;
  color: #5f716d;
  white-space: nowrap;
}
.st-tb .money {
  font-weight: 700;
  color: var(--bk-ink);
}
.st-stat {
  margin-left: 6px;
  vertical-align: 1px;
}
.st-sub {
  display: block;
  font-size: 11.5px;
  color: #8ba09a;
  overflow: hidden;
  text-overflow: ellipsis;
}
.st-warn {
  display: block;
  font-size: 11.5px;
  color: #b45309;
  line-height: 1.5;
}
/* 实扣小时副显（节）：基准 = 该绑定的每节时长，共享账本无基准则不折节 */
.st-lesson {
  display: block;
  font-size: 11px;
  color: #8ba09a;
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
}
/* 上课时间列（BUG-5/D）：两枚 el-time-picker 并排 + 「改期」标记 */
.st-time {
  display: flex;
  align-items: center;
  gap: 4px;
}
.st-time .st-dash {
  color: #8ba09a;
}
/* 内容行（PRD-018 ③） */
.st-ct-box {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.st-ct-lab {
  flex: none;
  font-size: 11.5px;
  color: #8ba09a;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding-top: 6px;
}
.st-empty {
  text-align: center;
  color: #8ba09a;
  padding: 26px 12px;
}
.st-foot {
  display: flex;
  align-items: center;
  gap: 14px;
}
.st-total {
  font-size: 12.5px;
  color: #5f716d;
  font-variant-numeric: tabular-nums;
}
.st-total b {
  color: var(--bk-ink);
}
.st-foot-note {
  color: #8ba09a;
}
.st-spacer {
  flex: 1;
}
</style>
