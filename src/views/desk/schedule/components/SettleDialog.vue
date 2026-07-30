<script setup lang="ts">
/**
 * PRD-015 批3 · 一键结算弹窗（V11/V12，AC5）。
 *
 * 多选待结算场次 → 每场可改「实扣课时」（默认 1，两位小数；金额随之实时重算 = 实扣 × 单价）
 * + **直接改上课起止时间** → 勾「同时生成反馈壳」（默认勾，D12）→ 确认扣费三连。
 *
 * 🔴 只提醒不自动扣（D4）：本弹窗的「确认结算」是全系统唯一扣费触发点。
 * 🔴 未开户的场次（price=null）不可选，提示先去学生卡开户——BE 也会 skipped 兜底。
 * 🔴 上课时间（BUG-5/D 拍板）：默认 = 该场排课起止，用的是排课/改期同款 el-time-picker。
 *    改了 → 结算前先走既有 updateSession 改期链（同日改起止，不触发顺延）把场次时间更新掉；
 *    没改 → 完全不动，也不写「实际上课时间」这种冗余备注（原来是个空输入框要老师手抄一遍）。
 * 单场版 = 父级只传一行（详情抽屉「标记已上」走这条路）。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { settleSessions, updateSession, type PendingSettlementVO } from '@/api/teacher/schedule'

/**
 * 弹窗行 = 待结算行 + priceUnknown（单场版从抽屉进来、该场还没进待结算清单时单价取不到，
 * 金额列显示「按账户单价」而不是假的 ¥0；真实扣费由 BE 按账户单价算）。
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

const innerVisible = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v),
})

/** 每场的编辑态：sessionId → {checked, hours, start, end}；start0/end0 = 排课起止快照用于判改动 */
interface EditRow {
  checked: boolean
  hours: number
  start: string
  end: string
  start0: string
  end0: string
}
const edits = ref<Record<string, EditRow>>({})
const genFeedback = ref(true)
const saving = ref(false)

/** 打开时重置：可结算的默认全选、实扣 1 课时、上课时间预填该场排课起止 */
watch(
  () => [props.visible, props.rows] as const,
  ([v]) => {
    if (!v) return
    const next: Record<string, EditRow> = {}
    for (const r of props.rows) {
      const s = (r.start || '').slice(0, 5)
      const e = (r.end || '').slice(0, 5)
      next[r.sessionId] = { checked: settleable(r), hours: 1, start: s, end: e, start0: s, end0: e }
    }
    edits.value = next
  },
  { immediate: true, deep: true },
)

/** 未开户（price 为 null）不能结算 */
function settleable(r: SettleRow): boolean {
  return r.price !== null && r.price !== undefined
}

/**
 * 不可结算的原因（bug 批 BUG-3/A）：price=null 有两种成因，得说准——
 * accountStatus='1' 是「开了但停用了」（去学生卡启用），null 才是真没开户。
 */
function blockReason(r: SettleRow): string {
  return r.accountStatus === '1'
    ? '该科账户已停用，先去学生卡启用'
    : '未开通该科账户，先去学生卡开户'
}

function editOf(id: string): EditRow {
  // 兜底返新对象（不共享单例）：万一 edits 还没填好，往兜底上写不会串到别的行
  return edits.value[id] || { checked: false, hours: 1, start: '', end: '', start0: '', end0: '' }
}

/** 上课时间被改过？改了才走改期，没改一个字节都不动（BUG-5/D） */
function timeChanged(r: SettleRow): boolean {
  const e = editOf(r.sessionId)
  return !!e.start && !!e.end && (e.start !== e.start0 || e.end !== e.end0)
}

/** 该行金额 = 实扣课时 × 单价（两位小数） */
function rowAmount(r: SettleRow): number {
  const h = Number(editOf(r.sessionId).hours) || 0
  return Math.round(h * Number(r.price || 0) * 100) / 100
}

/** 金额列文案：未开户 '—' / 单价未知「按账户单价」/ 正常 ¥N */
function amountLabel(r: SettleRow): string {
  if (!settleable(r)) return '—'
  if (r.priceUnknown) return '按账户单价'
  return '¥' + rowAmount(r)
}

const selected = computed(() => props.rows.filter((r) => editOf(r.sessionId).checked))
const totalHours = computed(
  () => Math.round(selected.value.reduce((s, r) => s + (Number(editOf(r.sessionId).hours) || 0), 0) * 100) / 100,
)
const totalAmount = computed(
  () => Math.round(selected.value.reduce((s, r) => s + rowAmount(r), 0) * 100) / 100,
)

/**
 * 合计金额文案。🔴 priceUnknown 的行（单场版从抽屉/场次表/工作台进来、该场不在待结算清单里）
 * 单价此刻取不到，若照常求和会在钱屏上打出假的「¥0」——与行内「按账户单价」自相矛盾。
 * 全未知 → 只说按账户单价；部分未知 → 已知部分求和 + 剩余场次注明。
 */
const unknownCount = computed(() => selected.value.filter((r) => r.priceUnknown).length)
const totalAmountLabel = computed(() => {
  if (!unknownCount.value) return `¥${totalAmount.value}`
  if (unknownCount.value === selected.value.length) return '金额按账户单价'
  return `¥${totalAmount.value} + ${unknownCount.value} 场按账户单价`
})
const allChecked = computed({
  get: () => {
    const ok = props.rows.filter(settleable)
    return ok.length > 0 && ok.every((r) => editOf(r.sessionId).checked)
  },
  set: (v: boolean) => {
    for (const r of props.rows) {
      if (settleable(r)) editOf(r.sessionId).checked = v
    }
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
  const bad = picked.find((r) => !(Number(editOf(r.sessionId).hours) > 0))
  if (bad) {
    ElMessage.warning('实扣课时需大于 0')
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
    const res = await settleSessions({
      items: picked.map((r) => ({
        sessionId: r.sessionId,
        hours: Number(editOf(r.sessionId).hours),
      })),
      genFeedback: genFeedback.value,
    })
    const ok = res?.settled ?? 0
    const skipped = res?.skipped || []
    const shells = res?.feedbackSheetIds?.length || 0
    if (ok > 0) {
      const parts = [`已结算 ${ok} 场`]
      if (shells) parts.push(`生成 ${shells} 份反馈`)
      if (skipped.length) parts.push(`${skipped.length} 场跳过`)
      ElMessage({ type: skipped.length ? 'warning' : 'success', message: parts.join('，') })
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
  <el-dialog v-model="innerVisible" title="结算确认" width="860px" append-to-body>
    <div class="st-hint">
      确认后自动完成：扣课时课费 · 场次标记已上 · 生成本次反馈（可关）。金额 = 实扣课时 × 该科单价。<br />
      上课时间默认 = 排课时间，<b>改了即更新场次时间</b>（结算前自动改期，不触发后续课次顺延）。
    </div>

    <table class="st-tb">
      <thead>
        <tr>
          <th style="width: 40px">
            <el-checkbox v-model="allChecked" />
          </th>
          <th style="width: 78px">日期</th>
          <th style="width: 106px">排课时段</th>
          <th>学生 · 内容</th>
          <th style="width: 104px">实扣课时</th>
          <th style="width: 92px">金额</th>
          <th style="width: 236px">上课时间（改了即改期）</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.sessionId" :class="{ off: !settleable(r) }">
          <td>
            <el-checkbox v-model="editOf(r.sessionId).checked" :disabled="!settleable(r)" />
          </td>
          <td class="num">{{ dayLabel(r.date) }}</td>
          <td class="num">{{ r.start }}–{{ r.end }}</td>
          <td>
            <b>{{ r.targetName || '—' }}</b>
            <span class="st-sub">
              {{ r.subjectLabel || '' }}{{ r.planLessonTitle ? ' · ' + r.planLessonTitle : '' }}
            </span>
            <span v-if="!settleable(r)" class="st-warn">{{ blockReason(r) }}</span>
          </td>
          <td>
            <el-input-number
              v-model="editOf(r.sessionId).hours"
              :min="0.01"
              :max="99"
              :step="0.5"
              :precision="2"
              size="small"
              controls-position="right"
              style="width: 96px"
              :disabled="!settleable(r)"
            />
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
                :disabled="!settleable(r)"
              />
              <span class="st-dash">–</span>
              <el-time-picker
                v-model="editOf(r.sessionId).end"
                format="HH:mm"
                value-format="HH:mm"
                placeholder="结束"
                size="small"
                style="width: 92px"
                :disabled="!settleable(r)"
              />
              <el-tag v-if="timeChanged(r)" size="small" type="warning" effect="plain">改期</el-tag>
            </div>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="7" class="st-empty">暂无待结算的课</td>
        </tr>
      </tbody>
    </table>

    <template #footer>
      <div class="st-foot">
        <el-checkbox v-model="genFeedback">同时生成本次反馈</el-checkbox>
        <span class="st-total">
          已选 <b>{{ selected.length }}</b> 场 · 共扣 <b>{{ totalHours }}</b> 课时 ·
          <b>{{ totalAmountLabel }}</b>
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
  margin-bottom: 12px;
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
  border-bottom: 1px solid #eef3f1;
  vertical-align: middle;
}
.st-tb tr.off td {
  background: #fafcfb;
  color: #9aa19d;
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
.st-spacer {
  flex: 1;
}
</style>
