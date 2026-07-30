<script setup lang="ts">
/**
 * PRD-015 批2 · 学生详情「课时账户」区块（V7/V8/AC4）。
 *
 * 一科一行：学科 chip / 单价 / 剩余课时 / 剩余金额（负数=欠费红显，不拦截）
 *   + 「记录」（课时台账抽屉：手抄本五列语义，充值绿 / 冲正红）+「充值」「调整」
 *   + bug 批 BUG-3/A 补齐的 CRUD：「改单价」「停用/启用」「删除」。
 * 台账抽屉内可「导出流水单」→ Excel 风格 PNG（对账/发家长；零内部词、无合计行）。
 *
 * 🔴 账户 = 学生 × 学科绑定（开户即绑定学科）——建计划的学科下拉吃的就是这里的开户结果。
 * 🔴 停用 vs 删除：停用只是让该科退出建计划/结算，余额流水留档随时可启用；
 *    删除是硬删，BE 只放行零流水账户（有记录一律劝停用），前端不预判、直接吃 BE 的 400 文案。
 * 🔴 班级对象无账户（班课收费模型未拍），父级不渲染本组件。
 */
import { ref, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  listAccounts,
  getAccountLedger,
  exportLedgerPng,
  setAccountStatus,
  deleteAccount,
  TUITION_FLOW_TYPE_LABEL,
  type TuitionAccountVO,
  type TuitionFlowType,
  type LedgerRowVO,
} from '@/api/teacher/account'
import { downloadArtifact } from '@/api/teacher/schedule'
import AccountEntryDialog from './AccountEntryDialog.vue'

const props = defineProps<{
  studentId: string
  studentName?: string
}>()

const emit = defineEmits<{
  /** 账户/余额有变 → 父级刷新卡片（角标、学科 chips） */
  (e: 'changed'): void
}>()

const accounts = ref<TuitionAccountVO[]>([])
const loading = ref(false)

let seq = 0
async function load() {
  const my = ++seq
  loading.value = true
  try {
    const rows = await listAccounts(props.studentId)
    if (my !== seq) return
    accounts.value = rows || []
  } catch {
    if (my === seq) accounts.value = []
  } finally {
    if (my === seq) loading.value = false
  }
}
watch(() => props.studentId, load, { immediate: true })

const openedSubjects = computed(() => accounts.value.map((a) => a.subject))

// —— 录入弹窗（开通 / 改单价 / 充值 / 调整）——
type EntryMode = 'open' | 'price' | 'recharge' | 'adjust'
const entryVisible = ref(false)
const entryMode = ref<EntryMode>('open')
const entryAccount = ref<TuitionAccountVO | null>(null)

function openEntry(mode: EntryMode, acc?: TuitionAccountVO) {
  entryMode.value = mode
  entryAccount.value = acc ?? null
  entryVisible.value = true
}

// —— 停用 / 启用 / 删除（BUG-3/A）——
const acting = ref('')

/** 停用 = 退出建计划下拉与结算取价；启用 = 放回来。余额流水一概不动。 */
async function toggleStatus(a: TuitionAccountVO) {
  const disable = a.status !== '1'
  const subj = a.subjectLabel || a.subject
  if (disable) {
    const ok = await ElMessageBox.confirm(
      `停用后「${subj}」不再出现在建计划的学科里，这科的课也无法结算。余额和记录都保留，随时可以再启用。`,
      `停用 ${subj} 账户`,
      { type: 'warning', confirmButtonText: '停用', cancelButtonText: '取消' },
    ).catch(() => false)
    if (!ok) return
  }
  acting.value = a.id
  try {
    await setAccountStatus(a.id, disable ? '1' : '0')
    ElMessage.success(disable ? '已停用' : '已启用')
    await load()
    emit('changed')
  } catch {
    // request 拦截器已弹错误 toast
  } finally {
    acting.value = ''
  }
}

/** 删户：只有零流水的才删得掉（开错学科当场删），有记录 BE 返 400 劝停用。 */
async function removeAccount(a: TuitionAccountVO) {
  const subj = a.subjectLabel || a.subject
  const ok = await ElMessageBox.confirm(
    `删除「${subj}」账户。只有从没有过充值/扣课记录的账户才能删；有记录的请改用「停用」。`,
    `删除 ${subj} 账户`,
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  ).catch(() => false)
  if (!ok) return
  acting.value = a.id
  try {
    await deleteAccount(a.id)
    ElMessage.success('账户已删除')
    await load()
    emit('changed')
  } catch {
    // 有流水 → BE 400「请改为停用」，拦截器已把原文弹出来
  } finally {
    acting.value = ''
  }
}

async function onEntrySaved() {
  await load()
  if (ledgerAccount.value) await loadLedger(ledgerAccount.value)
  emit('changed')
}

// —— 台账抽屉 ——
const ledgerVisible = ref(false)
const ledgerAccount = ref<TuitionAccountVO | null>(null)
const ledgerRows = ref<LedgerRowVO[]>([])
const ledgerLoading = ref(false)

async function openLedger(acc: TuitionAccountVO) {
  ledgerAccount.value = acc
  ledgerVisible.value = true
  await loadLedger(acc)
}

async function loadLedger(acc: TuitionAccountVO) {
  ledgerLoading.value = true
  try {
    const res = await getAccountLedger(acc.id, { pageNum: 1, pageSize: 200 })
    ledgerRows.value = res?.rows ?? []
  } catch {
    ledgerRows.value = []
  } finally {
    ledgerLoading.value = false
  }
}

/** 行分色：充值绿 / 冲正红（扣课、调整走默认色） */
function rowClass({ row }: { row: LedgerRowVO }) {
  if (row.flowType === '1') return 'lg-in'
  if (row.flowType === '3') return 'lg-rev'
  return ''
}

function flowLabel(t: TuitionFlowType) {
  return TUITION_FLOW_TYPE_LABEL[t] ?? ''
}

function fmtNum(v: number | null | undefined) {
  if (v === null || v === undefined) return '—'
  return String(Number(v))
}
function fmtDelta(v: number | null | undefined) {
  if (v === null || v === undefined) return '—'
  const n = Number(v)
  return n > 0 ? `+${n}` : String(n)
}

// —— 流水单导出 ——
const exporting = ref(false)
const pngUrl = ref('')
const pngVisible = ref(false)

async function onExportLedger() {
  if (!ledgerAccount.value) return
  exporting.value = true
  try {
    const res = await exportLedgerPng(ledgerAccount.value.id)
    const blob = await downloadArtifact(res.file)
    if (pngUrl.value) URL.revokeObjectURL(pngUrl.value)
    pngUrl.value = URL.createObjectURL(blob)
    pngVisible.value = true
  } catch {
    ElMessage.error('导出失败')
  } finally {
    exporting.value = false
  }
}

function downloadPng() {
  const a = document.createElement('a')
  a.href = pngUrl.value
  a.download = `${props.studentName || '学生'}-课时流水单.png`
  a.click()
}

defineExpose({ reload: load })
</script>

<template>
  <div class="acc-wrap" v-loading="loading">
    <div class="acc-head">
      <span class="acc-eyebrow">课时账户</span>
      <el-button size="small" text bg @click="openEntry('open')">开通学科账户</el-button>
    </div>

    <div v-if="accounts.length" class="acc-list">
      <div v-for="a in accounts" :key="a.id" class="acc-row" :class="{ off: a.status === '1' }">
        <span class="subj">{{ a.subjectLabel || a.subject }}</span>
        <span v-if="a.status === '1'" class="offtag">已停用</span>
        <span class="cell">
          <i>单价</i>
          <b>{{ fmtNum(a.lessonPrice) }}</b>
          <em>元/课时</em>
        </span>
        <span class="cell">
          <i>剩余课时</i>
          <b :class="{ neg: (a.hoursRemain ?? 0) < 0 }">{{ fmtNum(a.hoursRemain) }}</b>
        </span>
        <span class="cell">
          <i>剩余金额</i>
          <b :class="{ neg: (a.amountRemain ?? 0) < 0 }">{{ fmtNum(a.amountRemain) }}</b>
          <em>元</em>
        </span>
        <span class="acc-acts">
          <el-button size="small" text bg @click="openLedger(a)">记录</el-button>
          <el-button size="small" text bg type="primary" @click="openEntry('recharge', a)">充值</el-button>
          <el-button size="small" text bg @click="openEntry('adjust', a)">调整</el-button>
          <el-button size="small" text bg @click="openEntry('price', a)">改单价</el-button>
          <el-button size="small" text bg :loading="acting === a.id" @click="toggleStatus(a)">
            {{ a.status === '1' ? '启用' : '停用' }}
          </el-button>
          <el-button size="small" text bg type="danger" :loading="acting === a.id" @click="removeAccount(a)">
            删除
          </el-button>
        </span>
      </div>
    </div>
    <p v-else class="acc-empty">还没有账户 —— 开通一个学科账户后，就能给这科建计划、记课时和课费。</p>

    <!-- 台账抽屉 -->
    <el-drawer
      v-model="ledgerVisible"
      :title="`课时记录 · ${studentName || ''}${ledgerAccount ? '（' + (ledgerAccount.subjectLabel || ledgerAccount.subject) + '）' : ''}`"
      size="720px"
      append-to-body
    >
      <div class="lg-bar" v-if="ledgerAccount">
        <span
          >剩余 <b :class="{ neg: (ledgerAccount.hoursRemain ?? 0) < 0 }">{{ fmtNum(ledgerAccount.hoursRemain) }}</b> 课时 ·
          <b :class="{ neg: (ledgerAccount.amountRemain ?? 0) < 0 }">{{ fmtNum(ledgerAccount.amountRemain) }}</b> 元</span
        >
        <el-button size="small" text bg :loading="exporting" @click="onExportLedger">导出流水单</el-button>
      </div>
      <el-table :data="ledgerRows" v-loading="ledgerLoading" size="small" :row-class-name="rowClass" empty-text="暂无记录">
        <el-table-column prop="date" label="日期" width="106" />
        <el-table-column label="上课时间" width="104">
          <template #default="{ row }">{{ row.timeRange || '—' }}</template>
        </el-table-column>
        <el-table-column label="内容" min-width="180">
          <template #default="{ row }">
            <span class="lg-type">{{ flowLabel(row.flowType) }}</span>
            {{ row.content || '—' }}
          </template>
        </el-table-column>
        <el-table-column label="课时变动" width="92" align="right">
          <template #default="{ row }">{{ fmtDelta(row.hoursDelta) }}</template>
        </el-table-column>
        <el-table-column label="剩余课时" width="92" align="right">
          <template #default="{ row }">{{ fmtNum(row.hoursAfter) }}</template>
        </el-table-column>
      </el-table>
    </el-drawer>

    <!-- 流水单预览 -->
    <el-dialog v-model="pngVisible" title="课时流水单" width="780px" append-to-body top="5vh">
      <img v-if="pngUrl" :src="pngUrl" class="lg-png" alt="课时流水单" />
      <template #footer>
        <el-button @click="pngVisible = false">关闭</el-button>
        <el-button type="primary" @click="downloadPng">下载图片</el-button>
      </template>
    </el-dialog>

    <AccountEntryDialog
      v-model="entryVisible"
      :mode="entryMode"
      :student-id="studentId"
      :account="entryAccount"
      :opened-subjects="openedSubjects"
      @saved="onEntrySaved"
    />
  </div>
</template>

<style scoped>
.acc-wrap {
  padding: 14px 20px 16px;
  border-bottom: 1px solid var(--bk-line);
}
.acc-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.acc-eyebrow {
  font-size: 12px;
  font-weight: 700;
  color: #8ba09a;
  letter-spacing: 0.5px;
}
.acc-head .el-button {
  margin-left: auto;
}
.acc-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.acc-row {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  border: 1px solid var(--bk-line);
  border-radius: 10px;
  padding: 9px 14px;
  background: #fff;
}
/* 停用行：整行降饱和，但数字仍可读（余额还在，只是这科不参与建计划/结算） */
.acc-row.off {
  background: #fafcfb;
  border-style: dashed;
}
.acc-row.off .subj {
  color: #7d8f8b;
  background: #eef1f0;
}
.offtag {
  font-size: 11px;
  color: #a96f14;
  background: #f9f1dd;
  border-radius: 99px;
  padding: 1px 8px;
  flex: none;
}
.subj {
  font-size: 12px;
  font-weight: 700;
  color: var(--bk-teal-deep);
  background: #e8f2f0;
  border-radius: 99px;
  padding: 1px 10px;
  flex: none;
}
.cell {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 12px;
  color: #8ba09a;
}
.cell b {
  font-size: 14px;
  color: var(--bk-ink);
  font-variant-numeric: tabular-nums;
}
.cell b.neg {
  color: #be123c;
}
.cell em {
  font-style: normal;
}
.acc-acts {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.acc-empty {
  font-size: 12.5px;
  color: #8ba09a;
}
.lg-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  font-size: 13px;
  color: #5f716d;
}
.lg-bar b {
  color: var(--bk-teal-deep);
  font-variant-numeric: tabular-nums;
}
.lg-bar b.neg {
  color: #be123c;
}
.lg-bar .el-button {
  margin-left: auto;
}
.lg-type {
  font-size: 10.5px;
  color: #7d8f8b;
  background: #eef1f0;
  border-radius: 99px;
  padding: 0 6px;
  margin-right: 4px;
}
.lg-png {
  width: 100%;
  display: block;
}
:deep(.lg-in) {
  --el-table-tr-bg-color: #f2fbf5;
}
:deep(.lg-in) td {
  color: #15803d;
}
:deep(.lg-rev) {
  --el-table-tr-bg-color: #fdf2f2;
}
:deep(.lg-rev) td {
  color: #b91c1c;
}
</style>
