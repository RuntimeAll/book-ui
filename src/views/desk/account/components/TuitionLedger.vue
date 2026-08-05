<script setup lang="ts">
/**
 * PRD-018 批5 · 课时台账（**唯一实现**）——「课时账单」页与学生详情 AccountPanel 共吃这一份。
 *
 * 批3 时台账逻辑长在 AccountPanel 的抽屉里；批5 开出独立「课时账单」页（D12）后，
 * 两处要显示同一张台账 —— 复制一份等于两套口径各漂各的（正序/期初/翻页方向任一处改漏就对不上账）。
 * 所以整块抽到这里：**加载、排序、期初行、加载更早、双单位、导出** 全在本文件收口。
 *
 * 🔴 **不传 pageNum = 吃 BE 默认的最后一页**（最近的行）。台账是正序（业务日期升序）口径，
 *    硬传 `pageNum:1` 拿到的是**最旧**一页 —— 老师点开永远看不到今天的课（批1→批3 必改点）。
 *    往前翻走「加载更早」，把更旧的一页**前置**拼进去，累积成连续的一条链。
 * 🔴 剩余是 BE 逐行**实时推导**的，不是写入时快照 —— 补记一笔过去的充值，它后面每行都会跟着变。
 * 🔴 **D4 规则②**：共享账本（绑定数>1）每人每节时长不同 → 折节基准不唯一，**只按小时不折节**
 *    （`ledgerPerLesson` 返 null，`dual()` 副显自动消失）。
 * 🔴 **D11**：本组件不出现按小时计价的说法；价格口径由父级用 `priceSpecText` 报「每节 X 小时 · Y 元/节」。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  getAccountLedger,
  exportLedgerPng,
  TUITION_FLOW_TYPE_LABEL,
  type AccountBookVO,
  type LedgerRowVO,
  type TuitionFlowType,
} from '@/api/teacher/account'
import { downloadArtifact } from '@/api/teacher/schedule'
import { useTuitionUnit } from '@/composables/useTuitionUnit'

const props = withDefaults(
  defineProps<{
    /** 账本 id；换值自动重载（空串 = 空态） */
    accountId: string
    pageSize?: number
    /** 表格高度（页面版给固定高好滚，抽屉版不给） */
    height?: string | number
    /** 顶部余额条（抽屉里已有抬头时可关） */
    showBar?: boolean
  }>(),
  { pageSize: 50, showBar: true },
)

const emit = defineEmits<{
  /** 台账加载完 → 把账本视角回抛给父级（标题、余额、绑定描述都吃这份权威数据） */
  (e: 'loaded', book: AccountBookVO | null, shared: boolean): void
}>()

const { d, fmtMoney } = useTuitionUnit()

/** 期初行是渲染层造的合成行，用 __opening 与真流水区分（真流水的 id 是雪花号） */
type LedgerDisplayRow = LedgerRowVO & { __opening?: boolean }

const rows = ref<LedgerRowVO[]>([])
const book = ref<AccountBookVO | null>(null)
const shared = ref(false)
const pageNum = ref(1)
const pages = ref(1)
const opening = ref(0)
const loading = ref(false)
const earlierLoading = ref(false)

/** 并发守卫：快速切换账本时，旧请求回来不许覆盖新账本的台账 */
let seq = 0

/**
 * 首屏：**不传 pageNum**，吃 BE 默认的最后一页（= 最近的行）。
 */
async function load() {
  if (!props.accountId) {
    rows.value = []
    book.value = null
    shared.value = false
    emit('loaded', null, false)
    return
  }
  const my = ++seq
  loading.value = true
  rows.value = []
  pageNum.value = 1
  pages.value = 1
  opening.value = 0
  try {
    const res = await getAccountLedger(props.accountId, { pageSize: props.pageSize })
    if (my !== seq) return
    rows.value = res?.rows ?? []
    pageNum.value = res?.pageNum ?? 1
    pages.value = res?.pages ?? 1
    opening.value = res?.openingBalance ?? 0
    book.value = res?.account ?? null
    shared.value = !!res?.shared
    emit('loaded', book.value, shared.value)
  } catch {
    if (my !== seq) return
    rows.value = []
    book.value = null
    shared.value = false
    emit('loaded', null, false)
  } finally {
    if (my === seq) loading.value = false
  }
}

watch(() => props.accountId, load, { immediate: true })

/** 向前翻页：把更旧的一页**前置**拼上去，累积展示（不是替换 —— 老师要的是连续的一条链） */
async function loadEarlier() {
  if (pageNum.value <= 1 || earlierLoading.value) return
  const my = seq
  earlierLoading.value = true
  try {
    const res = await getAccountLedger(props.accountId, {
      pageNum: pageNum.value - 1,
      pageSize: props.pageSize,
    })
    if (my !== seq) return
    rows.value = [...(res?.rows ?? []), ...rows.value]
    pageNum.value = res?.pageNum ?? 1
    // 期初跟着往前挪：现在的首行变成更旧那页的首行了
    opening.value = res?.openingBalance ?? 0
  } catch {
    // 拦截器已弹错误
  } finally {
    earlierLoading.value = false
  }
}

const hasEarlier = computed(() => pageNum.value > 1)

/** 期初行只在「前面还有没显示出来的行」或期初非零时才出——期初 0 且已到第一页时它是纯噪音 */
const showOpening = computed(() => hasEarlier.value || Math.abs(opening.value) > 0.001)

const displayRows = computed<LedgerDisplayRow[]>(() => {
  if (!showOpening.value) return rows.value
  const head: LedgerDisplayRow = {
    __opening: true,
    id: '__opening__',
    date: '',
    timeRange: null,
    content: '期初结余',
    flowType: '4',
    hoursDelta: 0,
    amount: 0,
    amountPaid: null,
    hoursAfter: opening.value,
    amountAfter: 0,
    sessionId: null,
    relFlowId: null,
    studentName: null,
  }
  return [head, ...rows.value]
})

/** 折节基准：共享账本只按小时（D4 规则②）；单绑本 BE 才吐 hoursPerLesson */
const perLesson = computed<number | null>(() => {
  if (shared.value) return null
  const h = book.value?.hoursPerLesson
  return h && h > 0 ? h : null
})

/** 区间 = 已加载出来的行的首尾（往前翻会自动扩） */
const range = computed(() => {
  const rs = rows.value
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

// —— 流水单导出（发家长）——
const exporting = ref(false)
const pngUrl = ref('')
const pngVisible = ref(false)

async function onExport() {
  if (!props.accountId) return
  exporting.value = true
  try {
    const res = await exportLedgerPng(props.accountId)
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
  const tag = (book.value?.name || '').trim() || (book.value?.studentNames || []).join('+') || '账本'
  a.download = `${tag}-课时流水单.png`
  a.click()
}

defineExpose({ reload: load })
</script>

<template>
  <div class="tl-wrap">
    <div v-if="showBar && book" class="tl-bar">
      <span>
        剩余
        <b :class="{ neg: (book.hoursRemain ?? 0) < 0 }">{{ d(book.hoursRemain, perLesson).main }}</b>
        <em v-if="d(book.hoursRemain, perLesson).sub">（{{ d(book.hoursRemain, perLesson).sub }}）</em>
        · 约 <b :class="{ neg: (book.amountRemain ?? 0) < 0 }">{{ fmtMoney(book.amountRemain) }}</b>
      </span>
      <span v-if="range" class="tl-range">{{ range }}</span>
      <!-- 父级自己的动作（充值/调整/转账…）挂这里，台账本体不关心 -->
      <slot name="actions" />
      <el-button size="small" text bg type="primary" :loading="exporting" @click="onExport">
        导出流水单
      </el-button>
    </div>

    <div class="tl-hint">
      按上课先后排列，剩余随每行连续变化；补记一笔过去的充值，后面每行会自动跟着变
    </div>

    <!-- 向前翻页：正序 + 默认末页，更旧的记录靠它往前接 -->
    <div v-if="hasEarlier" class="tl-more">
      <el-button size="small" text bg :loading="earlierLoading" @click="loadEarlier">
        加载更早（还有 {{ pageNum - 1 }} 页）
      </el-button>
    </div>

    <el-table
      :data="displayRows"
      v-loading="loading"
      size="small"
      :height="height"
      :row-class-name="rowClass"
      empty-text="暂无记录"
    >
      <el-table-column label="日期" width="106">
        <template #default="{ row }">{{ row.date || '—' }}</template>
      </el-table-column>
      <el-table-column label="上课时间" width="104">
        <template #default="{ row }">{{ row.timeRange || '—' }}</template>
      </el-table-column>
      <el-table-column label="内容" min-width="200">
        <template #default="{ row }">
          <span v-if="!row.__opening" class="tl-type">{{ flowLabel(row.flowType) }}</span>
          {{ row.content || '—' }}
        </template>
      </el-table-column>
      <!-- 规则①：绑定数>1 才有学生列（单绑本每行都是同一个人，列出来是噪音） -->
      <el-table-column v-if="shared" label="学生" width="86">
        <template #default="{ row }">{{ row.studentName || '—' }}</template>
      </el-table-column>
      <el-table-column label="时长变动" width="132" align="right">
        <template #default="{ row }">
          <template v-if="row.__opening">—</template>
          <template v-else>
            <span class="dl-main">{{ d(row.hoursDelta, perLesson, true).main }}</span>
            <em v-if="d(row.hoursDelta, perLesson, true).sub" class="dl-sub">
              （{{ d(row.hoursDelta, perLesson, true).sub }}）
            </em>
          </template>
        </template>
      </el-table-column>
      <el-table-column label="剩余" width="142" align="right">
        <template #default="{ row }">
          <span class="dl-main rest">{{ d(row.hoursAfter, perLesson).main }}</span>
          <em v-if="d(row.hoursAfter, perLesson).sub" class="dl-sub">
            （{{ d(row.hoursAfter, perLesson).sub }}）
          </em>
        </template>
      </el-table-column>
    </el-table>

    <!-- 流水单预览 -->
    <el-dialog v-model="pngVisible" title="课时流水单" width="780px" append-to-body top="5vh">
      <img v-if="pngUrl" :src="pngUrl" class="tl-png" alt="课时流水单" />
      <template #footer>
        <el-button @click="pngVisible = false">关闭</el-button>
        <el-button type="primary" @click="downloadPng">下载图片</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.tl-wrap {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.tl-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 13px;
  color: #5f716d;
  font-variant-numeric: tabular-nums;
  flex-wrap: wrap;
}
.tl-bar b {
  font-size: 16px;
  color: var(--bk-teal-deep);
}
.tl-bar b.neg {
  color: #be123c;
}
.tl-bar em {
  font-style: normal;
  font-size: 12px;
  color: #8ba09a;
}
.tl-range {
  margin-left: auto;
  font-size: 12px;
  color: #8ba09a;
}
.tl-hint {
  font-size: 12px;
  color: #8ba09a;
  margin-bottom: 8px;
  line-height: 1.6;
}
.tl-more {
  margin-bottom: 8px;
}
.tl-type {
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
.tl-png {
  width: 100%;
  display: block;
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
