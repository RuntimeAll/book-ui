<script setup lang="ts">
/**
 * PRD-018 批3 · 学生详情「课时账户」区块（对照设计稿 ①②，FP1~FP10）。
 *
 * 一科一行：学科 chip / 余额双单位 / 约当金额 / 时薪 + 行内 meta（账本 · 每节时长 · 共享学生）
 *   + 「记录」（台账抽屉）/「充值」/「调整」/「改时薪」/「停用」/「删除」。
 * 区头另有「我的全部账本」（M6 可达性）与全局单位开关（D8，小时 ⇄ 节）。
 *
 * 🔴 D1 v2.1 / D8：底账只记小时，「节」是展示单位，换算基准 = 绑定层的 hoursPerLesson。
 *    共享账本（`shared`）多人基准不同 → 传 perLesson=null 只报小时（D4 规则②）。
 * 🔴 金额是派生量（小时 × 时薪），所以文案一律写「约 N 元」——它不是底账，别让人当收支凭据读。
 * 🔴 台账<b>正序 + 不传 pageNum</b>：正序口径下 pageNum=1 是最旧的一页，硬传 1 老师首屏永远看不到最新
 *    的一行。默认吃 BE 的「最后一页」，往前翻走「加载更早」把更旧的页<b>前置</b>拼上去。
 * 🔴 学生详情只看得到这个学生挂着的账本 → 改绑后的旧本从这里消失但记录还在，
 *    所以「我的全部账本」是必需入口而不是锦上添花（M6）。
 * 🔴 停用 vs 删除：停用只是让该科退出建计划/结算，余额流水留档随时可启用；
 *    删除是硬删，BE 只放行零流水账本（有记录一律劝停用），前端不预判、直接吃 BE 的 400 文案。
 * 🔴 班级对象无账户（班课收费模型未拍），父级不渲染本组件。
 */
import { ref, reactive, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  listAccounts,
  listMyAccountBooks,
  getAccountLedger,
  exportLedgerPng,
  setAccountStatus,
  deleteAccount,
  transferAccount,
  TUITION_FLOW_TYPE_LABEL,
  type TuitionAccountVO,
  type TuitionFlowType,
  type LedgerRowVO,
  type AccountBookVO,
} from '@/api/teacher/account'
import { downloadArtifact } from '@/api/teacher/schedule'
import { useTuitionUnit, todayStr } from '@/composables/useTuitionUnit'
import AccountEntryDialog from './AccountEntryDialog.vue'
import AccountBooksDialog from './AccountBooksDialog.vue'

const props = defineProps<{
  studentId: string
  studentName?: string
}>()

const emit = defineEmits<{
  /** 账本/余额有变 → 父级刷新卡片（角标、学科 chips） */
  (e: 'changed'): void
}>()

const { unit, setUnit, d, fmtNum, fmtMoney } = useTuitionUnit()

const accounts = ref<TuitionAccountVO[]>([])
/**
 * 我的全部账本 —— 账户行要显示「这本账还绑了谁」，但 TuitionAccountVO 只到绑定层没有 studentNames，
 * 所以在读取层做一次 accountId 关联（D10 ②：跨域/跨视角聚合只在读取层做，不进写入事务）。
 * 顺带供转移弹窗的「转入账本」下拉用，省一次请求。
 */
const myBooks = ref<AccountBookVO[]>([])
const loading = ref(false)

let seq = 0
async function load() {
  const my = ++seq
  loading.value = true
  try {
    const [rows, books] = await Promise.all([
      listAccounts(props.studentId),
      listMyAccountBooks().catch(() => [] as AccountBookVO[]),
    ])
    if (my !== seq) return
    accounts.value = rows || []
    myBooks.value = books || []
  } catch {
    if (my === seq) accounts.value = []
  } finally {
    if (my === seq) loading.value = false
  }
}
watch(() => props.studentId, load, { immediate: true })

const openedSubjects = computed(() => accounts.value.map((a) => a.subject))

/** 折节基准；共享账本基准不唯一 → null（D4 规则②，dual 自动只出小时） */
function perLessonOf(a: TuitionAccountVO): number | null {
  if (a.shared) return null
  return a.hoursPerLesson && a.hoursPerLesson > 0 ? a.hoursPerLesson : null
}

function bookOf(a: TuitionAccountVO): AccountBookVO | null {
  return myBooks.value.find((b) => b.id === a.accountId) ?? null
}

/** 账本显示名：自定义标签 → 共享本拼学生名 → 独立账本 */
function bookName(a: TuitionAccountVO): string {
  const tag = (a.name || bookOf(a)?.name || '').trim()
  if (tag) return tag
  if (!a.shared) return '独立账本'
  const names = (bookOf(a)?.studentNames || []).filter(Boolean)
  return names.length ? names.join('+') : '共享账本'
}

/** 共享账本上另外挂着的学生名（本人除外，本人自己那行不用重复报） */
function otherNames(a: TuitionAccountVO): string[] {
  if (!a.shared) return []
  return (bookOf(a)?.studentNames || []).filter((n) => n && n !== props.studentName)
}

// —— 录入弹窗（开通 / 改时薪 / 充值 / 调整）——
type EntryMode = 'open' | 'price' | 'recharge' | 'adjust'
const entryVisible = ref(false)
const entryMode = ref<EntryMode>('open')
const entryAccount = ref<TuitionAccountVO | null>(null)

function openEntry(mode: EntryMode, acc?: TuitionAccountVO) {
  entryMode.value = mode
  entryAccount.value = acc ?? null
  entryVisible.value = true
}

// —— 我的全部账本（M6）——
const booksVisible = ref(false)
const booksRef = ref<InstanceType<typeof AccountBooksDialog> | null>(null)

// —— 停用 / 启用 / 删除 ——
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

/** 删本：只有零流水的才删得掉（开错学科当场删），有记录 BE 返 400 劝停用。 */
async function removeAccount(a: TuitionAccountVO) {
  const subj = a.subjectLabel || a.subject
  const ok = await ElMessageBox.confirm(
    `删除「${subj}」账本。只有从没有过充值/扣课记录的账本才能删；有记录的请改用「停用」。`,
    `删除 ${subj} 账本`,
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  ).catch(() => false)
  if (!ok) return
  acting.value = a.id
  try {
    await deleteAccount(a.id)
    ElMessage.success('账本已删除')
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
  if (ledgerVisible.value && ledgerId.value) await loadLedger()
  booksRef.value?.reload()
  emit('changed')
}

// ─────────────────────────── 台账抽屉 ───────────────────────────
/** 期初行是渲染层造的合成行，用 __opening 与真流水区分（真流水的 id 是雪花号） */
type LedgerDisplayRow = LedgerRowVO & { __opening?: boolean }

const LEDGER_PAGE_SIZE = 50

const ledgerVisible = ref(false)
const ledgerId = ref('')
/** 抽屉标题/余额一律吃返回体的 account（账本视角权威），不吃点进来那一行的快照 */
const ledgerBook = ref<AccountBookVO | null>(null)
const ledgerShared = ref(false)
const ledgerRows = ref<LedgerRowVO[]>([])
const ledgerPageNum = ref(1)
const ledgerPages = ref(1)
const ledgerOpening = ref(0)
const ledgerLoading = ref(false)
const earlierLoading = ref(false)

async function openLedger(accountId: string) {
  ledgerId.value = accountId
  ledgerVisible.value = true
  ledgerRows.value = []
  ledgerPageNum.value = 1
  ledgerPages.value = 1
  ledgerOpening.value = 0
  ledgerBook.value = null
  ledgerShared.value = false
  await loadLedger()
}

/**
 * 首屏：**不传 pageNum**，吃 BE 默认的最后一页（= 最近的行）。
 * 正序口径下 pageNum=1 是最旧的一页，硬传 1 等于让老师首屏永远看不到今天的课。
 */
async function loadLedger() {
  ledgerLoading.value = true
  try {
    const res = await getAccountLedger(ledgerId.value, { pageSize: LEDGER_PAGE_SIZE })
    ledgerRows.value = res?.rows ?? []
    ledgerPageNum.value = res?.pageNum ?? 1
    ledgerPages.value = res?.pages ?? 1
    ledgerOpening.value = res?.openingBalance ?? 0
    ledgerBook.value = res?.account ?? null
    ledgerShared.value = !!res?.shared
  } catch {
    ledgerRows.value = []
  } finally {
    ledgerLoading.value = false
  }
}

/** 向前翻页：把更旧的一页**前置**拼上去，累积展示（不是替换，老师要的是连续的一条链） */
async function loadEarlier() {
  if (ledgerPageNum.value <= 1 || earlierLoading.value) return
  earlierLoading.value = true
  try {
    const res = await getAccountLedger(ledgerId.value, {
      pageNum: ledgerPageNum.value - 1,
      pageSize: LEDGER_PAGE_SIZE,
    })
    ledgerRows.value = [...(res?.rows ?? []), ...ledgerRows.value]
    ledgerPageNum.value = res?.pageNum ?? 1
    // 期初跟着往前挪：现在的首行变成更旧那页的首行了
    ledgerOpening.value = res?.openingBalance ?? 0
  } catch {
    // 拦截器已弹错误
  } finally {
    earlierLoading.value = false
  }
}

const hasEarlier = computed(() => ledgerPageNum.value > 1)

/** 期初行只在「前面还有没显示出来的行」或期初非零时才出——期初 0 且已到第一页时它是纯噪音 */
const showOpening = computed(() => hasEarlier.value || Math.abs(ledgerOpening.value) > 0.001)

const displayRows = computed<LedgerDisplayRow[]>(() => {
  if (!showOpening.value) return ledgerRows.value
  const opening: LedgerDisplayRow = {
    __opening: true,
    id: '__opening__',
    date: '',
    timeRange: null,
    content: '期初结余',
    flowType: '4',
    hoursDelta: 0,
    amount: 0,
    amountPaid: null,
    hoursAfter: ledgerOpening.value,
    amountAfter: 0,
    sessionId: null,
    relFlowId: null,
    studentName: null,
  }
  return [opening, ...ledgerRows.value]
})

/** 折节基准：共享账本只按小时（D4 规则②）；单绑本 BE 才吐 hoursPerLesson */
const ledgerPerLesson = computed<number | null>(() => {
  if (ledgerShared.value) return null
  const h = ledgerBook.value?.hoursPerLesson
  return h && h > 0 ? h : null
})

const ledgerTitle = computed(() => {
  const b = ledgerBook.value
  if (!b) return '课时记录'
  const tag = (b.name || '').trim() || (b.studentNames || []).filter(Boolean).join('+')
  return `课时记录 · ${tag || '账本 #' + b.id}`
})

/** 副标题 = 这本账绑了谁（共享本一眼看出是几个人的合账） */
const ledgerSubtitle = computed(() => {
  const b = ledgerBook.value
  if (!b) return ''
  if (!b.bindings?.length) return '这本账当前没有学生绑定，只作历史记录留档'
  const who = b.bindings
    .map((x) => [x.studentName || '—', x.subjectLabel || x.subject].filter(Boolean).join('（') + '）')
    .join(' · ')
  return b.bindingCount > 1 ? `共 ${b.bindingCount} 人记在这本账上：${who}` : `只有 ${who} 记在这本账上`
})

/** 区间 = 已加载出来的行的首尾（往前翻会自动扩） */
const ledgerRange = computed(() => {
  const rs = ledgerRows.value
  if (!rs.length) return ''
  return `${rs[0].date} ~ ${rs[rs.length - 1].date}`
})

/** 行分色：期初灰 · 充值/调整绿 · 冲正红（扣课走默认色） */
function rowClass({ row }: { row: LedgerDisplayRow }) {
  if (row.__opening) return 'lg-opening'
  if (row.flowType === '1' || row.flowType === '4') return 'lg-in'
  if (row.flowType === '3') return 'lg-rev'
  return ''
}

function flowLabel(t: TuitionFlowType) {
  return TUITION_FLOW_TYPE_LABEL[t] ?? ''
}

// —— 流水单导出 ——
const exporting = ref(false)
const pngUrl = ref('')
const pngVisible = ref(false)

async function onExportLedger() {
  if (!ledgerId.value) return
  exporting.value = true
  try {
    const res = await exportLedgerPng(ledgerId.value)
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

// ─────────────────────── 换本 / 拆本（M6-2 transfer）───────────────────────
// 一个事务产一对互指 '4' 调整行 —— 老师手搓两笔无关调整对不出因果，transfer 才能在台账上解释清楚。
const transferVisible = ref(false)
const transferFrom = ref<AccountBookVO | null>(null)
const transferring = ref(false)
const transferForm = reactive({
  toAccountId: '',
  hours: 0,
  occurDate: todayStr(),
  note: '',
})

/** 转入候选 = 我的其他账本（排除转出本身） */
const transferTargets = computed(() =>
  myBooks.value.filter((b) => b.id !== transferFrom.value?.id),
)

function bookTag(b: AccountBookVO) {
  const tag = (b.name || '').trim() || (b.studentNames || []).filter(Boolean).join('+')
  return tag || `账本 #${b.id}`
}

async function openTransfer(from: AccountBookVO) {
  transferFrom.value = from
  transferForm.toAccountId = ''
  transferForm.hours = 0
  transferForm.occurDate = todayStr()
  transferForm.note = ''
  transferVisible.value = true
  // 下拉要最新的账本表（刚开的本、刚改的名都得在）
  try {
    myBooks.value = (await listMyAccountBooks()) ?? []
  } catch {
    /* 拉不到就用已有的，下拉少几项总比开不出弹窗强 */
  }
}

/** 从台账抽屉发起转移：转出方 = 当前这本账 */
function openTransferFromLedger() {
  if (ledgerBook.value) void openTransfer(ledgerBook.value)
}

async function submitTransfer() {
  if (!transferFrom.value) return
  if (!transferForm.toAccountId) {
    ElMessage.warning('请选择转入账本')
    return
  }
  const h = Number(transferForm.hours) || 0
  if (h <= 0) {
    ElMessage.warning('请填写要转的小时数（大于 0）')
    return
  }
  transferring.value = true
  try {
    await transferAccount({
      fromAccountId: transferFrom.value.id,
      toAccountId: transferForm.toAccountId,
      hours: h,
      occurDate: transferForm.occurDate || undefined,
      note: transferForm.note.trim() || undefined,
    })
    ElMessage.success('已转出：两本账各产生一条互指的调整行，来去都查得到')
    transferVisible.value = false
    await load()
    if (ledgerVisible.value && ledgerId.value) await loadLedger()
    booksRef.value?.reload()
    emit('changed')
  } catch {
    // 拦截器已弹错误（余额守卫/归属校验都在 BE）
  } finally {
    transferring.value = false
  }
}

defineExpose({ reload: load })
</script>

<template>
  <div class="acc-wrap" v-loading="loading">
    <div class="acc-head">
      <span class="acc-eyebrow">课时账户</span>
      <span class="acc-head-acts">
        <el-button size="small" text bg @click="booksVisible = true">我的全部账本</el-button>
        <el-button size="small" text bg @click="openEntry('open')">开通学科账户</el-button>
        <!-- D8 全局单位开关：切一次全站联动（落 localStorage，刷新不丢） -->
        <el-radio-group :model-value="unit" size="small" class="unit-seg" @update:model-value="setUnit($event as 'h' | 'j')">
          <el-radio-button value="h">小时</el-radio-button>
          <el-radio-button value="j">节</el-radio-button>
        </el-radio-group>
      </span>
    </div>

    <div v-if="accounts.length" class="acc-list">
      <div v-for="a in accounts" :key="a.id" class="acc-row" :class="{ off: a.status === '1' }">
        <span class="subj">{{ a.subjectLabel || a.subject }}</span>
        <span v-if="a.status === '1'" class="offtag">已停用</span>

        <!-- 余额：双单位并排；共享账本只报小时（perLessonOf 返 null） -->
        <span class="cell bal">
          <i>剩余</i>
          <b :class="{ neg: (a.hoursRemain ?? 0) < 0 }">{{ d(a.hoursRemain, perLessonOf(a)).main }}</b>
          <em v-if="d(a.hoursRemain, perLessonOf(a)).sub">（{{ d(a.hoursRemain, perLessonOf(a)).sub }}）</em>
        </span>
        <!-- 「约」= 这是小时 × 时薪派生出来的参考值，不是底账 -->
        <span class="cell">
          <i>约</i>
          <b :class="{ neg: (a.amountRemain ?? 0) < 0 }">{{ fmtMoney(a.amountRemain) }}</b>
        </span>
        <span class="cell">
          <i>时薪</i>
          <b>{{ fmtNum(a.pricePerHour) }}</b>
          <em>元/小时</em>
        </span>

        <span class="acc-acts">
          <el-button size="small" text bg @click="openLedger(a.accountId)">记录</el-button>
          <el-button size="small" text bg type="primary" @click="openEntry('recharge', a)">充值</el-button>
          <el-button size="small" text bg @click="openEntry('adjust', a)">调整</el-button>
          <el-button size="small" text bg @click="openEntry('price', a)">改时薪</el-button>
          <el-button size="small" text bg :loading="acting === a.id" @click="toggleStatus(a)">
            {{ a.status === '1' ? '启用' : '停用' }}
          </el-button>
          <el-button size="small" text bg type="danger" :loading="acting === a.id" @click="removeAccount(a)">
            删除
          </el-button>
        </span>

        <!-- 行内 meta：账本归属 / 每节时长（点开就是改时薪那张壳）/ 共享学生 -->
        <span class="acc-meta">
          <span>账本：<a class="lk" @click="openLedger(a.accountId)">{{ bookName(a) }} ↗</a></span>
          <span class="dot">·</span>
          <span>
            每节
            <a class="lk dash" title="点击修改每节时长" @click="openEntry('price', a)">
              {{ fmtNum(a.hoursPerLesson) }} 小时 ✎
            </a>
          </span>
          <template v-if="otherNames(a).length">
            <span class="dot">·</span>
            <span>与 <b class="who">{{ otherNames(a).join('、') }}</b> 共用这本账</span>
          </template>
        </span>
      </div>
    </div>
    <p v-else class="acc-empty">还没有账户 —— 开通一个学科账户后，就能给这科建计划、记课时和课费。</p>

    <!-- 台账抽屉（账本粒度：一本账一张流水） -->
    <el-drawer v-model="ledgerVisible" :title="ledgerTitle" size="880px" append-to-body>
      <div v-if="ledgerBook" class="lg-sub">{{ ledgerSubtitle }}</div>
      <div class="lg-bar" v-if="ledgerBook">
        <span>
          剩余
          <b :class="{ neg: (ledgerBook.hoursRemain ?? 0) < 0 }">{{ d(ledgerBook.hoursRemain, ledgerPerLesson).main }}</b>
          <em v-if="d(ledgerBook.hoursRemain, ledgerPerLesson).sub">
            （{{ d(ledgerBook.hoursRemain, ledgerPerLesson).sub }}）
          </em>
          · 约 <b :class="{ neg: (ledgerBook.amountRemain ?? 0) < 0 }">{{ fmtMoney(ledgerBook.amountRemain) }}</b>
        </span>
        <span v-if="ledgerRange" class="lg-range">{{ ledgerRange }}</span>
        <el-button size="small" text bg @click="openTransferFromLedger">转到其他账本</el-button>
        <el-button size="small" text bg type="primary" :loading="exporting" @click="onExportLedger">
          导出流水单
        </el-button>
      </div>

      <div class="lg-hint">
        按上课先后排列，剩余随每行连续变化；补记一笔过去的充值，后面每行会自动跟着变
      </div>

      <!-- 向前翻页：正序 + 默认末页，更旧的记录靠它往前接 -->
      <div v-if="hasEarlier" class="lg-more">
        <el-button size="small" text bg :loading="earlierLoading" @click="loadEarlier">
          加载更早（还有 {{ ledgerPageNum - 1 }} 页）
        </el-button>
      </div>

      <el-table :data="displayRows" v-loading="ledgerLoading" size="small" :row-class-name="rowClass" empty-text="暂无记录">
        <el-table-column label="日期" width="106">
          <template #default="{ row }">{{ row.date || '—' }}</template>
        </el-table-column>
        <el-table-column label="上课时间" width="104">
          <template #default="{ row }">{{ row.timeRange || '—' }}</template>
        </el-table-column>
        <el-table-column label="内容" min-width="200">
          <template #default="{ row }">
            <span v-if="!row.__opening" class="lg-type">{{ flowLabel(row.flowType) }}</span>
            {{ row.content || '—' }}
          </template>
        </el-table-column>
        <!-- 规则①：绑定数>1 才有学生列（单绑本每行都是同一个人，列出来是噪音） -->
        <el-table-column v-if="ledgerShared" label="学生" width="86">
          <template #default="{ row }">{{ row.studentName || '—' }}</template>
        </el-table-column>
        <el-table-column label="时长变动" width="132" align="right">
          <template #default="{ row }">
            <template v-if="row.__opening">—</template>
            <template v-else>
              <span class="dl-main">{{ d(row.hoursDelta, ledgerPerLesson, true).main }}</span>
              <em v-if="d(row.hoursDelta, ledgerPerLesson, true).sub" class="dl-sub">
                （{{ d(row.hoursDelta, ledgerPerLesson, true).sub }}）
              </em>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="剩余" width="142" align="right">
          <template #default="{ row }">
            <span class="dl-main rest">{{ d(row.hoursAfter, ledgerPerLesson).main }}</span>
            <em v-if="d(row.hoursAfter, ledgerPerLesson).sub" class="dl-sub">
              （{{ d(row.hoursAfter, ledgerPerLesson).sub }}）
            </em>
          </template>
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

    <!-- 换本 / 拆本 -->
    <el-dialog v-model="transferVisible" title="转到其他账本" width="460px" append-to-body>
      <el-form label-width="86px">
        <el-form-item label="转出账本">
          <span class="ro">{{ transferFrom ? bookTag(transferFrom) : '—' }}</span>
          <span v-if="transferFrom" class="fh">当前 {{ fmtNum(transferFrom.hoursRemain) }} 小时</span>
        </el-form-item>
        <el-form-item label="转入账本">
          <el-select v-model="transferForm.toAccountId" placeholder="选择我的其他账本" style="width: 100%">
            <el-option
              v-for="b in transferTargets"
              :key="b.id"
              :value="b.id"
              :label="`${bookTag(b)}（${fmtNum(b.pricePerHour)} 元/小时 · 余 ${fmtNum(b.hoursRemain)} 小时）`"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="转多少">
          <el-input-number v-model="transferForm.hours" :min="0" :precision="2" :step="1" style="width: 180px" />
          <span class="fh">小时</span>
        </el-form-item>
        <el-form-item label="业务日期">
          <el-date-picker
            v-model="transferForm.occurDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择日期"
            style="width: 180px"
          />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="transferForm.note" maxlength="200" placeholder="例如：改绑到新账本 / 拆出好好的部分" />
        </el-form-item>
        <el-form-item label=" ">
          <span class="fh">
            两本账各记一条互指的调整行；跨不同时薪的账本转，金额天然不守恒（同样的小时在新账本按新时薪算钱）
          </span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="transferVisible = false">取消</el-button>
        <el-button type="primary" :loading="transferring" @click="submitTransfer">确认转移</el-button>
      </template>
    </el-dialog>

    <AccountBooksDialog
      ref="booksRef"
      v-model="booksVisible"
      @open-ledger="openLedger($event.id)"
      @transfer="openTransfer"
    />

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
.acc-head-acts {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.unit-seg {
  margin-left: 4px;
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
.cell.bal b {
  font-size: 19px;
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
/* meta 独占一行（flex-basis:100% 换行），与主行用虚线分开 */
.acc-meta {
  flex-basis: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 2px;
  padding-top: 8px;
  border-top: 1px dashed var(--bk-line);
  font-size: 11.5px;
  color: #8ba09a;
}
.acc-meta .dot {
  color: #c4d2cc;
}
.acc-meta .who {
  color: var(--bk-teal-deep);
}
.lk {
  color: var(--bk-teal-deep);
  cursor: pointer;
}
.lk:hover {
  text-decoration: underline;
}
.lk.dash {
  border-bottom: 1px dashed var(--bk-teal);
  padding-bottom: 1px;
}
.acc-empty {
  font-size: 12.5px;
  color: #8ba09a;
}
.lg-sub {
  font-size: 12px;
  color: #8ba09a;
  margin-bottom: 8px;
  line-height: 1.6;
}
.lg-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 13px;
  color: #5f716d;
  font-variant-numeric: tabular-nums;
}
.lg-bar b {
  font-size: 16px;
  color: var(--bk-teal-deep);
}
.lg-bar b.neg {
  color: #be123c;
}
.lg-bar em {
  font-style: normal;
  font-size: 12px;
  color: #8ba09a;
}
.lg-range {
  margin-left: auto;
  font-size: 12px;
  color: #8ba09a;
}
.lg-hint {
  font-size: 12px;
  color: #8ba09a;
  margin-bottom: 8px;
  line-height: 1.6;
}
.lg-more {
  margin-bottom: 8px;
}
.lg-type {
  font-size: 10.5px;
  color: #7d8f8b;
  background: #eef1f0;
  border-radius: 99px;
  padding: 0 6px;
  margin-right: 4px;
}
.dl-main {
  font-variant-numeric: tabular-nums;
}
.dl-main.rest {
  font-weight: 700;
}
.dl-sub {
  font-style: normal;
  font-size: 11px;
  color: #8ba09a;
  font-variant-numeric: tabular-nums;
}
.lg-png {
  width: 100%;
  display: block;
}
.ro {
  font-size: 13px;
  font-weight: 600;
  color: var(--bk-teal-deep);
}
.fh {
  margin-left: 10px;
  font-size: 12px;
  color: #8ba09a;
  line-height: 1.6;
}
:deep(.lg-opening) {
  --el-table-tr-bg-color: #f4f7f6;
}
:deep(.lg-opening) td {
  color: #8ba09a;
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
