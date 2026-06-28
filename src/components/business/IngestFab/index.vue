<script setup lang="ts">
/**
 * IngestFab — PRD-A-002 路B「批量上传录题」进度球（全局浮动入口 + 作业列表抽屉）
 *
 * 职责：轮询「我的拆题作业」，角标显进行中作业数；点开抽屉列各作业（文件名 + 状态 +
 *   题数/已入库数），每项「去审核」跳 /ingest/review/:id。FAILED 红色显 errorMsg。
 *
 * 轮询策略（省请求）：
 *   - 有进行中作业（PENDING/EXTRACT_ING/SPLIT_ING）→ 每 5s 快轮询；
 *   - 全部终态（DONE/FAILED）→ 每 30s 慢轮询（兜「别的页/别的 tab 新提交了作业」）。
 *   - 抽屉打开时立即刷新一次。
 * 仿 PaperBasketFab：fixed 右下，错落在试题栏(40)/试卷篮(152)之上 → bottom:264px。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { Upload, Loading, CircleCheck, CircleClose, Right } from '@element-plus/icons-vue'
import {
  listIngestJobs,
  type IngestJobRow,
  type IngestJobStatus,
} from '@/api/ingest/index'

const router = useRouter()

const jobs = ref<IngestJobRow[]>([])
const drawerVisible = ref(false)

const ACTIVE_STATUS = new Set<IngestJobStatus>(['PENDING', 'EXTRACT_ING', 'SPLIT_ING'])

const activeCount = computed(
  () => jobs.value.filter((j) => ACTIVE_STATUS.has(j.status)).length,
)

// ── 轮询 ────────────────────────────────────────────────────
let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

async function refresh() {
  try {
    const rows = await listIngestJobs()
    jobs.value = Array.isArray(rows) ? rows : []
  } catch (e) {
    console.warn('[ingest-fab] listIngestJobs failed', e)
  }
}

function scheduleNext() {
  if (stopped) return
  const delay = activeCount.value > 0 ? 5_000 : 30_000
  timer = setTimeout(async () => {
    await refresh()
    scheduleNext()
  }, delay)
}

function restartPolling() {
  if (timer) clearTimeout(timer)
  timer = null
  scheduleNext()
}

/** 供父组件（BatchUploadDialog 提交后）即时触发刷新 + 重排轮询节奏。 */
async function triggerRefresh() {
  await refresh()
  restartPolling()
}
defineExpose({ triggerRefresh })

// BatchUploadDialog 不与 FAB 同父 → 提交后派发全局 window 事件让 FAB 即时刷新
// （FAB 本身也轮询，30s 内必轮到，此事件仅为即时性优化）。
function onIngestJobSubmitted() {
  void triggerRefresh()
}

onMounted(async () => {
  window.addEventListener('ingest:job-submitted', onIngestJobSubmitted)
  await refresh()
  scheduleNext()
})

onBeforeUnmount(() => {
  stopped = true
  if (timer) clearTimeout(timer)
  window.removeEventListener('ingest:job-submitted', onIngestJobSubmitted)
})

// ── 交互 ────────────────────────────────────────────────────
async function openDrawer() {
  drawerVisible.value = true
  await refresh()
}

function goReview(job: IngestJobRow) {
  drawerVisible.value = false
  router.push('/ingest/review/' + job.id)
}

// ── 状态展示 ────────────────────────────────────────────────
function statusLabel(s: IngestJobStatus): string {
  switch (s) {
    case 'PENDING':
      return '排队中'
    case 'EXTRACT_ING':
      return '识别中'
    case 'SPLIT_ING':
      return '拆题中'
    case 'DONE':
      return '已完成'
    case 'FAILED':
      return '失败'
    default:
      return String(s)
  }
}

function statusTagType(s: IngestJobStatus): 'success' | 'danger' | 'warning' | 'info' {
  if (s === 'DONE') return 'success'
  if (s === 'FAILED') return 'danger'
  if (ACTIVE_STATUS.has(s)) return 'warning'
  return 'info'
}
</script>

<template>
  <!-- FAB -->
  <el-badge
    class="ingest-fab-badge"
    :value="activeCount > 99 ? '99+' : activeCount"
    :hidden="activeCount === 0"
    :offset="[-10, 8]"
    type="danger"
  >
    <div
      class="ingest-fab"
      :class="{ 'has-active': activeCount > 0 }"
      @click="openDrawer"
    >
      <div class="fab-inner">
        <el-icon :size="20" color="#fff"><Upload /></el-icon>
        <span class="fab-label">拆题</span>
      </div>
    </div>
  </el-badge>

  <!-- 作业列表抽屉 -->
  <el-drawer
    v-model="drawerVisible"
    title="批量拆题作业"
    direction="rtl"
    size="420px"
  >
    <div class="job-list">
      <el-empty
        v-if="jobs.length === 0"
        description="暂无拆题作业，去「批量上传」试试"
      />
      <div
        v-for="job in jobs"
        :key="job.id"
        class="job-card"
        :class="{ 'job-card--failed': job.status === 'FAILED' }"
      >
        <div class="job-card-head">
          <el-icon
            class="job-status-icon"
            :class="`job-status-icon--${statusTagType(job.status)}`"
          >
            <Loading v-if="ACTIVE_STATUS.has(job.status)" class="spin" />
            <CircleCheck v-else-if="job.status === 'DONE'" />
            <CircleClose v-else-if="job.status === 'FAILED'" />
            <Upload v-else />
          </el-icon>
          <span class="job-name" :title="job.sourceFileName || ''">
            {{ job.sourceFileName || '未命名文件' }}
          </span>
          <el-tag :type="statusTagType(job.status)" size="small" round>
            {{ statusLabel(job.status) }}
          </el-tag>
        </div>

        <div class="job-card-meta">
          <span>识别 {{ job.questionCount ?? 0 }} 题</span>
          <span class="meta-sep">·</span>
          <span>已入库 {{ job.committedCount ?? 0 }} 题</span>
          <span v-if="job.createTime" class="meta-sep">·</span>
          <span v-if="job.createTime" class="job-time">{{ job.createTime }}</span>
        </div>

        <div v-if="job.status === 'FAILED' && job.errorMsg" class="job-error">
          {{ job.errorMsg }}
        </div>

        <div class="job-card-foot">
          <el-button
            size="small"
            type="primary"
            link
            @click="goReview(job)"
          >
            去审核<el-icon class="go-icon"><Right /></el-icon>
          </el-button>
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
/* 错落在试题栏 FAB(bottom:40) 与试卷篮(bottom:152) 之上 → bottom:264 */
.ingest-fab-badge {
  position: fixed;
  bottom: 264px;
  right: 40px;
  z-index: 200;
  line-height: 0;
}

.ingest-fab {
  cursor: pointer;
}

.fab-inner {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: linear-gradient(135deg, #7b6cf0, #5d4fd6);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  box-shadow: 0 8px 24px rgba(123, 108, 240, 0.4);
  transition: all 0.25s ease;
}

.ingest-fab:hover .fab-inner {
  transform: translateY(-3px);
  box-shadow: 0 12px 32px rgba(123, 108, 240, 0.5);
}

.fab-label {
  font-size: 11px;
  color: #fff;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.ingest-fab.has-active .fab-inner {
  animation: ingest-fab-pulse 2s infinite;
}

@keyframes ingest-fab-pulse {
  0%, 100% { box-shadow: 0 8px 24px rgba(123, 108, 240, 0.4); }
  50% { box-shadow: 0 8px 30px rgba(123, 108, 240, 0.6); }
}

/* ── 抽屉作业卡 ── */
.job-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.job-card {
  border: 1px solid #e9ecf2;
  border-radius: 8px;
  padding: 12px 14px;
  background: #fff;
  transition: box-shadow 0.2s;
}

.job-card:hover {
  box-shadow: 0 2px 12px rgba(29, 42, 46, 0.06);
}

.job-card--failed {
  border-color: #fbcccc;
  background: #fff8f8;
}

.job-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.job-status-icon {
  flex-shrink: 0;
  font-size: 16px;
}

.job-status-icon--success { color: #1e9e6e; }
.job-status-icon--danger { color: #f56c6c; }
.job-status-icon--warning { color: #c47d0e; }
.job-status-icon--info { color: #909399; }

.spin {
  animation: ingest-spin 1.1s linear infinite;
}

@keyframes ingest-spin {
  to { transform: rotate(360deg); }
}

.job-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: #1d2129;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.job-card-meta {
  margin-top: 8px;
  font-size: 12px;
  color: #86909c;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.meta-sep {
  color: #c9cdd4;
}

.job-time {
  color: #a6b2b6;
}

.job-error {
  margin-top: 8px;
  font-size: 12px;
  color: #f56c6c;
  background: #fff0f0;
  border-radius: 4px;
  padding: 6px 8px;
  word-break: break-word;
}

.job-card-foot {
  margin-top: 8px;
  display: flex;
  justify-content: flex-end;
}

.go-icon {
  margin-left: 2px;
}
</style>
