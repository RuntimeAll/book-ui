<script setup lang="ts">
/**
 * PRD-015 批3 · 一键结算弹窗（V11/V12，AC5）。
 *
 * 多选待结算场次 → 每场可改「实扣课时」（默认 1，两位小数；金额随之实时重算 = 实扣 × 单价）
 * + 「实际上课时间」备注 → 勾「同时生成反馈壳」（默认勾，D12）→ 确认扣费三连。
 *
 * 🔴 只提醒不自动扣（D4）：本弹窗的「确认结算」是全系统唯一扣费触发点。
 * 🔴 未开户的场次（price=null）不可选，提示先去学生卡开户——BE 也会 skipped 兜底。
 * 单场版 = 父级只传一行（详情抽屉「标记已上」走这条路）。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { settleSessions, type PendingSettlementVO } from '@/api/teacher/schedule'

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

/** 每场的编辑态：sessionId → {checked, hours, timeNote} */
interface EditRow {
  checked: boolean
  hours: number
  timeNote: string
}
const edits = ref<Record<string, EditRow>>({})
const genFeedback = ref(true)
const saving = ref(false)

/** 打开时重置：可结算的默认全选、实扣 1 课时 */
watch(
  () => [props.visible, props.rows] as const,
  ([v]) => {
    if (!v) return
    const next: Record<string, EditRow> = {}
    for (const r of props.rows) {
      next[r.sessionId] = { checked: settleable(r), hours: 1, timeNote: '' }
    }
    edits.value = next
  },
  { immediate: true, deep: true },
)

/** 未开户（price 为 null）不能结算 */
function settleable(r: SettleRow): boolean {
  return r.price !== null && r.price !== undefined
}

function editOf(id: string): EditRow {
  return edits.value[id] || { checked: false, hours: 1, timeNote: '' }
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
  saving.value = true
  try {
    const res = await settleSessions({
      items: picked.map((r) => {
        const e = editOf(r.sessionId)
        return {
          sessionId: r.sessionId,
          hours: Number(e.hours),
          timeNote: e.timeNote?.trim() || undefined,
        }
      }),
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
  <el-dialog v-model="innerVisible" title="结算确认" width="760px" append-to-body>
    <div class="st-hint">
      确认后自动完成：扣课时课费 · 场次标记已上 · 生成本次反馈（可关）。金额 = 实扣课时 × 该科单价。
    </div>

    <table class="st-tb">
      <thead>
        <tr>
          <th style="width: 40px">
            <el-checkbox v-model="allChecked" />
          </th>
          <th style="width: 78px">日期</th>
          <th style="width: 106px">时段</th>
          <th>学生 · 内容</th>
          <th style="width: 104px">实扣课时</th>
          <th style="width: 92px">金额</th>
          <th style="width: 150px">实际上课时间</th>
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
            <span v-if="!settleable(r)" class="st-warn">未开通该科账户，先去学生卡开户</span>
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
            <el-input
              v-model="editOf(r.sessionId).timeNote"
              size="small"
              placeholder="如 09:05-10:40"
              maxlength="30"
              :disabled="!settleable(r)"
            />
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
