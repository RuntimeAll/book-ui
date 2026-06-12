<script setup lang="ts">
/**
 * PRD-A-014 T3 — 导出记录列表组件
 *
 * 职责：
 *   - 分页拉取当前用户的导出记录（GET /teacher/export/record/page）
 *   - 四态：排队中(灰) / 生成中(转圈+进度%) / 已完成([下载]青色) / 失败(红,hover见原因,[重试])
 *   - 删除：已完成/失败记录可删（确认弹窗），删除连 OSS 文件一起删（BE 处理）
 *     （2026-06-11 用户拍板去掉 7 天过期：文件留存到用户自己删，不再有"已过期/重新导出"态）
 *   - 轮询：页签激活 && document.visibilityState==='visible' && 列表存在 status∈{'0','1'} → 3s 轮询
 *   - 完成通知：轮询发现某条 '1'→'2' 翻转 → ElNotification "《文件名》已生成 [立即下载]"
 *   - 重试成功后列表头部出现新记录（刷新第一页）
 */
import {
  ref,
  computed,
  watch,
  onMounted,
  onUnmounted,
  onActivated,
  onDeactivated,
} from 'vue'
import { ElNotification, ElMessage, ElMessageBox } from 'element-plus'
import { Loading, Download, RefreshRight, Delete } from '@element-plus/icons-vue'
import {
  getExportRecordPage,
  retryExport,
  deleteExportRecord,
  type ExportRecordPageItem,
  type ExportRecordStatus,
} from '@/api/export'

// ── 状态 ────────────────────────────────────────────────────────────────────

const records = ref<ExportRecordPageItem[]>([])
const loading = ref(false)
const pageNum = ref(1)
const pageSize = ref(20)
const total = ref(0)

/** 上一轮轮询结果快照，用于检测 '1'→'2' 翻转通知 */
const prevStatusMap = ref<Record<string, ExportRecordStatus>>({})

/** 是否处于活跃状态（页签激活 + 窗口可见） */
const tabActive = ref(true)

let pollTimer: ReturnType<typeof setTimeout> | null = null

// ── 计算属性 ──────────────────────────────────────────────────────────────────

/** 列表中是否存在"进行中"任务（排队或生成中） */
const hasPendingRecords = computed(() =>
  records.value.some((r) => r.status === '0' || r.status === '1'),
)

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function statusLabel(record: ExportRecordPageItem): string {
  switch (record.status) {
    case '0': return '排队中'
    case '1': return `生成中 ${record.progress ?? 0}%`
    case '2': return '已完成'
    case '3': return '失败'
    default:  return '未知'
  }
}

function statusType(record: ExportRecordPageItem): '' | 'success' | 'warning' | 'danger' | 'info' {
  switch (record.status) {
    case '0': return 'info'
    case '1': return 'warning'
    case '2': return 'success'
    case '3': return 'danger'
    default:  return 'info'
  }
}

// ── 数据加载 ──────────────────────────────────────────────────────────────────

async function fetchRecords(silent = false) {
  if (!silent) loading.value = true
  try {
    const result = await getExportRecordPage({ pageNum: pageNum.value, pageSize: pageSize.value })
    const newList = result?.list ?? []

    // 检测 '1'→'2' 翻转，发站内通知
    for (const rec of newList) {
      const prev = prevStatusMap.value[rec.recordId]
      if (prev === '1' && rec.status === '2' && rec.fileUrl) {
        // 任务完成通知
        ElNotification({
          title: '导出完成',
          message: `《${rec.fileName}》已生成`,
          type: 'success',
          duration: 0,
          onClick: () => {
            triggerDownload(rec.fileUrl!, rec.fileName)
          },
          dangerouslyUseHTMLString: false,
        })
      }
    }

    // 更新状态快照
    const newMap: Record<string, ExportRecordStatus> = {}
    for (const rec of newList) {
      newMap[rec.recordId] = rec.status
    }
    prevStatusMap.value = newMap

    records.value = newList
    total.value = result?.total ?? 0
  } catch {
    // 静默兜底：不崩、不弹 toast（网络断开时不影响其他页签）
  } finally {
    if (!silent) loading.value = false
  }
}

// ── 下载 ──────────────────────────────────────────────────────────────────────

function triggerDownload(url: string, fileName: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

function handleDownload(record: ExportRecordPageItem) {
  if (!record.fileUrl) return
  triggerDownload(record.fileUrl, record.fileName)
}

// ── 重试 / 重新导出 ───────────────────────────────────────────────────────────

async function handleRetry(record: ExportRecordPageItem) {
  try {
    await retryExport(record.recordId)
    ElMessage.success('已重新提交导出任务')
    // 刷新第一页，新任务出现在头部
    pageNum.value = 1
    prevStatusMap.value = {}  // 重置快照，避免错误翻转判断
    await fetchRecords()
  } catch {
    // 错误已由 http/request.ts 拦截器弹 toast
  }
}

// ── 删除（2026-06-11 去过期改版：用户自管，删除连 OSS 文件一起删）──────────────

async function handleDelete(record: ExportRecordPageItem) {
  try {
    await ElMessageBox.confirm(
      `删除后《${record.fileName}》的 PDF 文件将一并从云端移除，无法恢复。确定删除？`,
      '删除导出记录',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return // 用户取消
  }
  try {
    await deleteExportRecord(record.recordId)
    ElMessage.success('已删除')
    // 当前页删空且不是第一页 → 回退一页
    if (records.value.length === 1 && pageNum.value > 1) {
      pageNum.value--
    }
    await fetchRecords()
  } catch {
    // 错误已由拦截器弹 toast（如"任务进行中不能删除"）
  }
}

// ── 轮询 ──────────────────────────────────────────────────────────────────────

function startPoll() {
  if (pollTimer) return // 已在跑
  scheduleNextPoll()
}

function stopPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

function scheduleNextPoll() {
  pollTimer = setTimeout(async () => {
    pollTimer = null
    if (tabActive.value && document.visibilityState === 'visible' && hasPendingRecords.value) {
      await fetchRecords(true) // silent=true，不触发 loading 遮罩
      if (hasPendingRecords.value) {
        scheduleNextPoll() // 还有进行中 → 继续轮询
      }
      // 没有进行中任务 → 轮询自停
    }
    // tabActive=false 或 visibilityHidden → 轮询自停
  }, 3000)
}

/** 响应 visibilityState 变化 */
function handleVisibilityChange() {
  if (document.visibilityState === 'visible' && tabActive.value && hasPendingRecords.value) {
    startPoll()
  } else {
    stopPoll()
  }
}

// ── watch 轮询驱动（hasPendingRecords 变为 true 时自动启动）────────────────

watch(hasPendingRecords, (has) => {
  if (has && tabActive.value && document.visibilityState === 'visible') {
    startPoll()
  } else {
    stopPoll()
  }
})

// ── 分页 ──────────────────────────────────────────────────────────────────────

async function handlePageChange(page: number) {
  pageNum.value = page
  await fetchRecords()
}

// ── 生命周期 ──────────────────────────────────────────────────────────────────

onMounted(async () => {
  document.addEventListener('visibilitychange', handleVisibilityChange)
  await fetchRecords()
})

onUnmounted(() => {
  stopPoll()
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})

// keep-alive 场景：页签切换激活/停用
onActivated(async () => {
  tabActive.value = true
  await fetchRecords()
})

onDeactivated(() => {
  tabActive.value = false
  stopPoll()
})
</script>

<template>
  <div class="export-records">
    <!-- 工具栏 -->
    <div class="export-records__toolbar">
      <span class="export-records__total">共 {{ total }} 条记录</span>
      <el-button link type="primary" :icon="RefreshRight" @click="fetchRecords()">
        刷新
      </el-button>
    </div>

    <!-- 记录列表 -->
    <div v-loading="loading" class="export-records__body">
      <!-- 空态 -->
      <el-empty
        v-if="!loading && records.length === 0"
        :image-size="72"
        description="还没有导出记录，去卷库/组卷工作台导出一份试卷吧"
      />

      <!-- 列表 -->
      <ul v-else class="export-list">
        <li
          v-for="record in records"
          :key="record.recordId"
          class="export-item"
        >
          <!-- 文件名 + 状态 -->
          <div class="export-item__info">
            <div class="export-item__name" :title="record.fileName">
              {{ record.fileName }}
            </div>
            <div class="export-item__meta">
              <!-- 状态 tag -->
              <el-tag
                :type="statusType(record)"
                size="small"
                :icon="record.status === '1' ? Loading : undefined"
              >
                {{ statusLabel(record) }}
              </el-tag>

              <!-- 失败原因提示 -->
              <el-tooltip
                v-if="record.status === '3' && record.errorMsg"
                :content="record.errorMsg"
                placement="top"
                effect="dark"
              >
                <el-tag type="danger" size="small" class="export-item__errtip">
                  查看原因
                </el-tag>
              </el-tooltip>

              <!-- 文件大小 -->
              <span v-if="record.status === '2'" class="export-item__size">
                {{ formatFileSize(record.fileSize) }}
              </span>
            </div>
          </div>

          <!-- 时间 -->
          <span class="export-item__time">{{ record.createTime }}</span>

          <!-- 操作按钮 -->
          <div class="export-item__actions">
            <!-- 已完成 → 下载 -->
            <el-button
              v-if="record.status === '2' && record.fileUrl"
              type="primary"
              size="small"
              link
              :icon="Download"
              @click="handleDownload(record)"
            >
              下载
            </el-button>

            <!-- 失败 → 重试 -->
            <el-button
              v-if="record.status === '3'"
              type="warning"
              size="small"
              link
              :icon="RefreshRight"
              @click="handleRetry(record)"
            >
              重试
            </el-button>

            <!-- 已完成/失败 → 删除（连 OSS 文件；进行中 BE 拒绝故不展示） -->
            <el-button
              v-if="record.status === '2' || record.status === '3'"
              type="danger"
              size="small"
              link
              :icon="Delete"
              @click="handleDelete(record)"
            >
              删除
            </el-button>
          </div>
        </li>
      </ul>
    </div>

    <!-- 分页 -->
    <div v-if="total > pageSize" class="export-records__pagination">
      <el-pagination
        v-model:current-page="pageNum"
        :page-size="pageSize"
        :total="total"
        layout="prev, pager, next"
        small
        @current-change="handlePageChange"
      />
    </div>
  </div>
</template>

<style scoped>
.export-records {
  padding: 4px 0;
}

.export-records__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.export-records__total {
  font-size: 13px;
  color: #86909c;
}

.export-records__body {
  min-height: 200px;
}

.export-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.export-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 8px;
  background: #fafafa;
  border: 1px solid #f0f2f5;
  transition: background 0.15s ease;
}

.export-item:hover {
  background: #f0f9f9;
  border-color: #d4e8e8;
}

.export-item__info {
  flex: 1;
  min-width: 0;
}

.export-item__name {
  font-size: 14px;
  font-weight: 500;
  color: #1d2129;
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.export-item__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.export-item__size {
  font-size: 12px;
  color: #86909c;
}

.export-item__errtip {
  cursor: help;
}

.export-item__time {
  font-size: 12px;
  color: #a8abb2;
  white-space: nowrap;
  flex-shrink: 0;
}

.export-item__actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  min-width: 64px;
  justify-content: flex-end;
}

.export-records__pagination {
  display: flex;
  justify-content: center;
  margin-top: 16px;
}
</style>
