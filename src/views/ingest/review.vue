<script setup lang="ts">
/**
 * IngestReview — PRD-A-002 路B「批量上传录题」审核页（/ingest/review/:jobId）
 *
 * 左栏原卷图 + 右栏拆出的题项列表（逐题审核）。流程：
 *   onMounted 取 jobId → getIngestJob；若状态进行中（PENDING/EXTRACT_ING/SPLIT_ING）
 *   每 3s 轮询直到 DONE/FAILED。逐题勾选（默认勾，已入库项禁用）→ 「入库勾选项(N)」
 *   调 commitIngestJob → 刷新（入库项变禁用）。删题走 dropIngestJobItem 软弃。
 *
 * 🔴 optionsJson / dnaJson 是 JSON 字符串，渲染前 JSON.parse（try/catch 容错）。
 */
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft, Refresh, Delete, Picture, EditPen } from '@element-plus/icons-vue'
import { useDictStore, DICT_QUESTION_TYPE } from '@/store/dict'
import MarkdownMath from '@/components/MarkdownMath.vue'
import {
  getIngestJob,
  commitIngestJob,
  dropIngestJobItem,
  updateIngestJobItem,
  type IngestJobDetail,
  type IngestJobItem,
  type IngestJobStatus,
} from '@/api/ingest/index'

const route = useRoute()
const router = useRouter()

const jobId = computed(() => String(route.params.jobId ?? ''))

const ACTIVE_STATUS = new Set<IngestJobStatus>(['PENDING', 'EXTRACT_ING', 'SPLIT_ING', 'SOLVING'])

// ── 字典（题型标签） ────────────────────────────────────────
const dict = useDictStore()
dict.load(DICT_QUESTION_TYPE)
function questionTypeLabel(t: number): string {
  return dict.label(DICT_QUESTION_TYPE, t) || `题型${t}`
}

// ── 数据 ────────────────────────────────────────────────────
const job = ref<IngestJobDetail | null>(null)
const items = ref<IngestJobItem[]>([])
const loading = ref(true)
const refreshing = ref(false)
const committing = ref(false)

// 勾选态：itemId → 勾选与否（默认勾，已入库项不参与）
const checked = reactive<Record<string, boolean>>({})

// 折叠态：itemId → 是否展开答案/解析
const expanded = reactive<Record<string, boolean>>({})

function isCommitted(it: IngestJobItem): boolean {
  return it.itemStatus === 'committed' || it.committedQuestionId != null
}

function applyItems(list: IngestJobItem[]) {
  items.value = list
  for (const it of list) {
    const k = String(it.id)
    // 已入库项不可再勾；其余默认勾（首次设默认，已存在的勾选态保留）
    if (isCommitted(it)) {
      checked[k] = false
    } else if (checked[k] === undefined) {
      checked[k] = true
    }
  }
}

// 勾选且 pending 的题数（入库按钮显示用）
const checkedPendingIds = computed<(string | number)[]>(() =>
  items.value
    .filter((it) => !isCommitted(it) && checked[String(it.id)])
    .map((it) => it.id),
)

// ── 解析 JSON 字符串（容错） ────────────────────────────────
function parseOptions(raw: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) return arr.map((x) => String(x))
    return []
  } catch {
    return []
  }
}

// ── 轮询 ────────────────────────────────────────────────────
let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

async function fetchJob(silent = false) {
  if (!jobId.value) return
  if (!silent) loading.value = true
  try {
    const res = await getIngestJob(jobId.value)
    job.value = res.job
    applyItems(Array.isArray(res.items) ? res.items : [])
  } catch (e) {
    console.warn('[ingest-review] getIngestJob failed', e)
  } finally {
    loading.value = false
  }
}

function maybeScheduleNext() {
  if (stopped) return
  const st = job.value?.status
  if (st && ACTIVE_STATUS.has(st)) {
    timer = setTimeout(async () => {
      await fetchJob(true)
      maybeScheduleNext()
    }, 3_000)
  }
}

async function handleRefresh() {
  refreshing.value = true
  try {
    await fetchJob(true)
    // 刷新后若仍进行中，重启轮询
    if (timer) clearTimeout(timer)
    timer = null
    maybeScheduleNext()
  } finally {
    refreshing.value = false
  }
}

// ── 入库 ────────────────────────────────────────────────────
async function handleCommit() {
  const ids = checkedPendingIds.value
  if (ids.length === 0) {
    ElMessage.warning('请至少勾选一道待入库的题')
    return
  }
  committing.value = true
  try {
    const res = await commitIngestJob(jobId.value, ids)
    ElMessage.success(`入库 ${res.committed ?? ids.length} 题`)
    await fetchJob(true)
  } catch (e) {
    console.warn('[ingest-review] commit failed', e)
  } finally {
    committing.value = false
  }
}

// ── 软弃题 ──────────────────────────────────────────────────
async function handleDrop(it: IngestJobItem) {
  try {
    await ElMessageBox.confirm('确定丢弃这道题？丢弃后不再展示。', '丢弃确认', {
      confirmButtonText: '丢弃',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  try {
    await dropIngestJobItem(jobId.value, it.id)
    ElMessage.success('已丢弃')
    await fetchJob(true)
  } catch (e) {
    console.warn('[ingest-review] drop failed', e)
  }
}

// ── 就地改题（PRD-A-002 B5） ────────────────────────────────
interface EditDraft {
  stemText: string
  answerText: string
  analyzeText: string
  questionType: number
}
const editing = reactive<Record<string, boolean>>({})
const drafts = reactive<Record<string, EditDraft>>({})
const savingEdit = reactive<Record<string, boolean>>({})

const QTYPE_OPTIONS = [
  { label: '选择', value: 1 },
  { label: '填空', value: 2 },
  { label: '解答', value: 5 },
]

function startEdit(it: IngestJobItem) {
  const k = String(it.id)
  drafts[k] = {
    stemText: it.stemText || '',
    answerText: it.answerText || '',
    analyzeText: it.analyzeText || '',
    questionType: it.questionType ?? 5,
  }
  editing[k] = true
}

function cancelEdit(it: IngestJobItem) {
  editing[String(it.id)] = false
}

async function saveEdit(it: IngestJobItem) {
  const k = String(it.id)
  const d = drafts[k]
  if (!d) return
  if (!d.stemText.trim()) {
    ElMessage.warning('题干不能为空')
    return
  }
  savingEdit[k] = true
  try {
    await updateIngestJobItem(jobId.value, it.id, {
      stemText: d.stemText,
      answerText: d.answerText,
      analyzeText: d.analyzeText,
      questionType: d.questionType,
    })
    // 本地即时回写（避免整页轮询闪烁）
    it.stemText = d.stemText
    it.answerText = d.answerText
    it.analyzeText = d.analyzeText
    it.questionType = d.questionType
    editing[k] = false
    ElMessage.success('已保存')
  } catch (e) {
    console.warn('[ingest-review] saveEdit failed', e)
  } finally {
    savingEdit[k] = false
  }
}

function goBack() {
  router.back()
}

// ── 状态徽章 ────────────────────────────────────────────────
function statusLabel(s: IngestJobStatus | undefined): string {
  switch (s) {
    case 'PENDING':
      return '排队中'
    case 'EXTRACT_ING':
      return '识别中'
    case 'SPLIT_ING':
      return '拆题中'
    case 'SOLVING':
      return '解题打标中'
    case 'DONE':
      return '已完成'
    case 'FAILED':
      return '失败'
    default:
      return s ? String(s) : '—'
  }
}

function statusTagType(s: IngestJobStatus | undefined): 'success' | 'danger' | 'warning' | 'info' {
  if (s === 'DONE') return 'success'
  if (s === 'FAILED') return 'danger'
  if (s && ACTIVE_STATUS.has(s)) return 'warning'
  return 'info'
}

const isActive = computed(() => {
  const st = job.value?.status
  return !!st && ACTIVE_STATUS.has(st)
})

onMounted(async () => {
  await fetchJob()
  maybeScheduleNext()
})

onBeforeUnmount(() => {
  stopped = true
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <div class="review-page">
    <!-- 顶栏 -->
    <div class="review-topbar">
      <div class="topbar-left">
        <el-button text :icon="ArrowLeft" @click="goBack">返回</el-button>
        <span class="topbar-title">{{ job?.sourceFileName || '批量拆题审核' }}</span>
        <el-tag :type="statusTagType(job?.status)" size="small" round>
          {{ statusLabel(job?.status) }}
        </el-tag>
      </div>
      <div class="topbar-right">
        <el-button :icon="Refresh" :loading="refreshing" @click="handleRefresh">
          刷新
        </el-button>
        <el-button
          type="primary"
          :loading="committing"
          :disabled="checkedPendingIds.length === 0"
          @click="handleCommit"
        >
          入库勾选项（{{ checkedPendingIds.length }}）
        </el-button>
      </div>
    </div>

    <!-- 主体 -->
    <div v-loading="loading" class="review-body">
      <!-- 左栏：原卷图 -->
      <div class="review-source">
        <div class="source-inner">
          <img
            v-if="job?.sourceOssUrl"
            :src="job.sourceOssUrl"
            alt="原卷"
            class="source-img"
          />
          <div v-else class="source-placeholder">
            <el-icon :size="40"><Picture /></el-icon>
            <span>暂无原卷图</span>
          </div>
        </div>
      </div>

      <!-- 右栏：题项列表 -->
      <div class="review-items">
        <!-- 进行中提示 -->
        <el-alert
          v-if="isActive"
          type="info"
          :closable="false"
          show-icon
          class="state-alert"
          title="正在识别拆题，页面将自动刷新（每 3 秒）…"
        />

        <!-- 失败提示（已拆出的 items 仍可审） -->
        <el-alert
          v-if="job?.status === 'FAILED'"
          type="error"
          :closable="false"
          show-icon
          class="state-alert"
          :title="job?.errorMsg || '拆题失败'"
          description="以下为已拆出的题目（如有），仍可审核入库。"
        />

        <!-- DONE 且空 -->
        <el-empty
          v-if="!loading && !isActive && items.length === 0"
          description="未识别到题目，请确认文件内容"
        />

        <!-- 题卡列表 -->
        <div
          v-for="it in items"
          :key="it.id"
          class="item-card"
          :class="{ 'item-card--committed': isCommitted(it) }"
        >
          <div class="item-head">
            <el-checkbox
              v-model="checked[String(it.id)]"
              :disabled="isCommitted(it)"
            />
            <span class="item-seq">第 {{ it.seq }} 题</span>
            <span class="type-badge">{{ questionTypeLabel(it.questionType) }}</span>
            <el-rate
              v-if="it.difficulty"
              :model-value="it.difficulty"
              :max="4"
              disabled
              size="small"
              style="display:inline-flex"
            />
            <el-tag v-if="it.needReview === 1" type="warning" size="small" effect="light" round>
              待审
            </el-tag>
            <el-tag v-if="isCommitted(it)" type="success" size="small" round>
              已入库
            </el-tag>
            <div class="item-head-ops">
              <el-button
                v-if="!editing[String(it.id)]"
                size="small"
                link
                type="primary"
                :icon="EditPen"
                :disabled="isCommitted(it)"
                @click="startEdit(it)"
              >
                编辑
              </el-button>
              <el-button
                size="small"
                link
                type="danger"
                :icon="Delete"
                :disabled="isCommitted(it)"
                @click="handleDrop(it)"
              >
                丢弃
              </el-button>
            </div>
          </div>

          <!-- 就地改题编辑态 -->
          <div v-if="editing[String(it.id)]" class="item-edit">
            <div class="edit-row">
              <span class="edit-label">题型</span>
              <el-select v-model="drafts[String(it.id)].questionType" size="small" style="width:120px">
                <el-option v-for="o in QTYPE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
              </el-select>
            </div>
            <div class="edit-row">
              <span class="edit-label">题干</span>
              <el-input v-model="drafts[String(it.id)].stemText" type="textarea" :autosize="{ minRows: 3, maxRows: 10 }" placeholder="题干 Markdown + $LaTeX$" />
            </div>
            <div class="edit-row">
              <span class="edit-label">答案</span>
              <el-input v-model="drafts[String(it.id)].answerText" type="textarea" :autosize="{ minRows: 1, maxRows: 6 }" placeholder="答案（可空）" />
            </div>
            <div class="edit-row">
              <span class="edit-label">解析</span>
              <el-input v-model="drafts[String(it.id)].analyzeText" type="textarea" :autosize="{ minRows: 1, maxRows: 6 }" placeholder="解析（可空）" />
            </div>
            <div class="edit-actions">
              <el-button size="small" @click="cancelEdit(it)">取消</el-button>
              <el-button size="small" type="primary" :loading="savingEdit[String(it.id)]" @click="saveEdit(it)">保存</el-button>
            </div>
          </div>

          <!-- 题干（只读态） -->
          <template v-else>
          <div class="item-stem">
            <MarkdownMath :content="it.stemText || ''" />
          </div>

          <!-- 选项 -->
          <ul v-if="parseOptions(it.optionsJson).length > 0" class="item-options">
            <li v-for="(opt, idx) in parseOptions(it.optionsJson)" :key="idx">
              <MarkdownMath :content="opt" />
            </li>
          </ul>

          <!-- 答案 / 解析折叠 -->
          <div
            v-if="it.answerText || it.analyzeText"
            class="item-answer-toggle"
          >
            <el-button
              size="small"
              link
              type="primary"
              @click="expanded[String(it.id)] = !expanded[String(it.id)]"
            >
              {{ expanded[String(it.id)] ? '收起答案/解析' : '查看答案/解析' }}
            </el-button>
          </div>
          <div v-if="expanded[String(it.id)]" class="item-answer-body">
            <div v-if="it.answerText" class="answer-block">
              <span class="answer-label">【答案】</span>
              <MarkdownMath :content="it.answerText" />
            </div>
            <div v-if="it.analyzeText" class="answer-block">
              <span class="answer-label">【解析】</span>
              <MarkdownMath :content="it.analyzeText" />
            </div>
          </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.review-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 60px);
  background: #f0f2f5;
}

/* ── 顶栏 ── */
.review-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 20px;
  background: #fff;
  border-bottom: 1px solid #e3e9e9;
  flex-shrink: 0;
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.topbar-title {
  font-size: 15px;
  font-weight: 600;
  color: #1d2129;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 360px;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* ── 主体 ── */
.review-body {
  flex: 1;
  display: flex;
  gap: 12px;
  padding: 12px 20px;
  overflow: hidden;
  min-height: 0;
}

.review-source {
  width: 40%;
  max-width: 480px;
  flex-shrink: 0;
  background: #fff;
  border-radius: 8px;
  border: 1px solid #e9ecf2;
  overflow: hidden;
  display: flex;
}

.source-inner {
  flex: 1;
  overflow: auto;
  padding: 12px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
}

.source-img {
  max-width: 100%;
  height: auto;
  display: block;
  border-radius: 4px;
}

.source-placeholder {
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: #c9cdd4;
  font-size: 13px;
}

.review-items {
  flex: 1;
  overflow-y: auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.state-alert {
  margin-bottom: 0;
}

/* ── 题卡 ── */
.item-card {
  background: #fff;
  border: 1px solid #e9ecf2;
  border-radius: 8px;
  padding: 14px 16px;
  transition: box-shadow 0.2s;
}

.item-card:hover {
  box-shadow: 0 2px 12px rgba(29, 42, 46, 0.05);
}

.item-card--committed {
  background: #f7faf8;
  border-color: #cfe9dd;
}

.item-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.item-seq {
  font-size: 13px;
  font-weight: 600;
  color: #4e5969;
}

.type-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  background: #e6f2f2;
  color: #176e6e;
}

.item-head-ops {
  margin-left: auto;
}

.item-stem {
  font-size: 14px;
  color: #1d2129;
}

.item-options {
  margin: 8px 0 0;
  padding-left: 4px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.item-options li {
  padding-left: 4px;
}

.item-answer-toggle {
  margin-top: 8px;
}

.item-answer-body {
  margin-top: 6px;
  padding: 10px 12px;
  background: #f5f8f8;
  border-left: 3px solid #1e8a8a;
  border-radius: 6px;
}

.answer-block {
  margin-bottom: 8px;
}

.answer-block:last-child {
  margin-bottom: 0;
}

.answer-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: #1d2a2e;
  margin-bottom: 4px;
}

/* ── 就地改题 ── */
.item-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  background: #f7faf9;
  border: 1px dashed #b7d8cf;
  border-radius: 6px;
}

.edit-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.edit-label {
  font-size: 12px;
  font-weight: 600;
  color: #4e5969;
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
