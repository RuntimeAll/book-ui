<script setup lang="ts">
/**
 * 每日打卡书阅读页（2026-07-30 用户拍板：展示与审核独立两个页面）。
 *
 * 本页 = **干净阅读态**：左天目录（第 N 天，无审核痕迹）/ 中 punch-v1 纸面 iframe /
 * 题目卷⇄解析卷 / 导出本天 / 导出本书（异步整册，punchExport 持久化）。
 * 审核是功能不是展示——审核态在独立页 /bookshelf/punch/:bookId（punch.vue），
 * 入口=书架卡片「审核」按钮 + 本页顶栏「审核」小按钮。
 *
 * 🔴 纸面渲染与审核页同源：iframe srcdoc 吃 BE /teacher/punch/preview（punch-v1，
 * 与导出 PDF 同 theme 同 data），FE 零渲染器，没有第二套纸面。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getBook } from '@/api/shelf'
import {
  getPunchDays,
  previewPunchDay,
  exportPunchDay,
  exportPunchBook,
  getPunchBookExportStatus,
  type PunchBookExportState,
  type PunchDayBrief,
  type PunchPaper,
} from '@/api/teacher/punch'

const route = useRoute()
const router = useRouter()
const bookId = String(route.params.bookId ?? '')

const PAPER_W = 794
const PAPER_H_DEFAULT = 1123

// ── 书 + 天目录 ──
const bookTitle = ref('')
const days = ref<PunchDayBrief[]>([])
const curDay = ref<number>(Number(route.query.day) || 0)
const paper = ref<PunchPaper>(route.query.paper === 'answer' ? 'answer' : 'question')

async function loadBook() {
  try {
    const b = await getBook(bookId)
    bookTitle.value = b?.title ?? ''
  } catch {
    /* 标题非关键（http 拦截器已弹错） */
  }
}

async function loadDays() {
  try {
    const res = await getPunchDays(bookId)
    days.value = (res?.days ?? []).map((d) => ({ ...d, day: Number(d.day) }))
    if (!days.value.some((d) => d.day === curDay.value)) {
      curDay.value = days.value[0]?.day ?? 0
    }
  } catch {
    /* http 拦截器已弹错 */
  }
}

// ── 纸面（iframe srcdoc，与审核页同一套预览端点/缩放逻辑）──
const previewHtml = ref('')
const previewLoading = ref(false)
const previewError = ref('')
let previewToken = 0

async function loadPreview() {
  if (!curDay.value) {
    previewHtml.value = ''
    return
  }
  const token = ++previewToken
  previewLoading.value = true
  previewError.value = ''
  try {
    const res = await previewPunchDay(bookId, curDay.value, paper.value)
    if (token !== previewToken) return
    previewHtml.value = res?.html ?? ''
    if (!previewHtml.value) previewError.value = '纸面 HTML 为空'
    paperH.value = PAPER_H_DEFAULT
  } catch (e: unknown) {
    if (token !== previewToken) return
    previewHtml.value = ''
    previewError.value = (e as { message?: string })?.message || '纸面渲染失败'
  } finally {
    if (token === previewToken) previewLoading.value = false
  }
}

const canvasRef = ref<HTMLElement | null>(null)
const frameRef = ref<HTMLIFrameElement | null>(null)
const canvasW = ref(0)
const paperH = ref(PAPER_H_DEFAULT)
const scale = computed(() => (canvasW.value ? Math.min(1, canvasW.value / PAPER_W) : 1))
const boxW = computed(() => Math.round(PAPER_W * scale.value))
const boxH = computed(() => Math.round(paperH.value * scale.value))

let ro: ResizeObserver | null = null
function observeCanvas() {
  if (!canvasRef.value || typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver((entries) => {
    for (const e of entries) canvasW.value = Math.max(0, e.contentRect.width - 60)
  })
  ro.observe(canvasRef.value)
}

function onFrameLoad() {
  try {
    const doc = frameRef.value?.contentDocument
    if (!doc) return
    paperH.value = Math.max(
      doc.documentElement?.scrollHeight ?? 0,
      doc.body?.scrollHeight ?? 0,
      PAPER_H_DEFAULT,
    )
  } catch {
    /* srcdoc 同源，理论不达 */
  }
}

// ── 导出本天 ──
const exportingDay = ref(false)
async function onExportDay() {
  if (!curDay.value) return
  exportingDay.value = true
  try {
    const res = await exportPunchDay(bookId, curDay.value)
    const urls = [res?.questionUrl, res?.answerUrl].filter(Boolean) as string[]
    if (!urls.length) {
      ElMessage.warning('导出未返回文件地址')
      return
    }
    for (const u of urls) window.open(u, '_blank')
    ElMessage.success(`第 ${curDay.value} 天已导出（${urls.length} 份 PDF）`)
  } catch {
    /* http 拦截器已弹错 */
  } finally {
    exportingDay.value = false
  }
}

// ── 导出本书（异步整册 + punchExport 持久态，与审核页同一套后端）──
const exportDialogVisible = ref(false)
const exportPapers = ref<PunchPaper[]>(['question', 'answer'])
const exportState = ref<PunchBookExportState | null>(null)
const exportErr = ref('')
let exportPollTimer: ReturnType<typeof setInterval> | null = null
const exportRunning = computed(() => exportState.value?.status === 'running')
const exportDone = computed(() => exportState.value?.status === 'done')

async function openExportBook() {
  if (!days.value.length) {
    ElMessage.warning('本书还没有内容')
    return
  }
  exportPapers.value = ['question', 'answer']
  exportErr.value = ''
  exportDialogVisible.value = true
  try {
    const res = await getPunchBookExportStatus(bookId)
    exportState.value = res?.export ?? null
    if (exportRunning.value) startExportPoll()
  } catch {
    /* http 拦截器已弹错 */
  }
}

async function runExportBook() {
  if (!exportPapers.value.length) {
    ElMessage.warning('请至少选一种卷')
    return
  }
  exportErr.value = ''
  try {
    const res = await exportPunchBook(bookId, exportPapers.value)
    exportState.value = res?.export ?? { status: 'running' }
    ElMessage.success('整册导出已开始（后台渲染约 2-5 分钟，可关闭弹窗继续翻阅）')
    startExportPoll()
  } catch (e: unknown) {
    exportErr.value = (e as { message?: string })?.message || '整册导出提交失败'
  }
}

function startExportPoll() {
  stopExportPoll()
  exportPollTimer = setInterval(async () => {
    try {
      const res = await getPunchBookExportStatus(bookId)
      const st = res?.export ?? null
      exportState.value = st
      if (!st || st.status === 'done' || st.status === 'failed') {
        stopExportPoll()
        if (st?.status === 'done') ElMessage.success(`整册已合并（${st.days ?? days.value.length} 天）——弹窗内可下载`)
        else if (st?.status === 'failed') exportErr.value = st.error || '整册导出失败'
      }
    } catch {
      /* 单拍失败不停轮询 */
    }
  }, 5_000)
}

function stopExportPoll() {
  if (exportPollTimer != null) {
    clearInterval(exportPollTimer)
    exportPollTimer = null
  }
}

function openExportFile(url: string | undefined) {
  if (url) window.open(url, '_blank')
}

// ── 导航 ──
function pickDay(d: number) {
  if (d !== curDay.value) curDay.value = d
}
function goBack() {
  router.push('/bookshelf')
}
function goReview() {
  router.push(`/bookshelf/punch/${bookId}?day=${curDay.value || 1}&paper=${paper.value}`)
}

watch([curDay, paper], () => {
  router.replace({
    query: { ...route.query, day: curDay.value ? String(curDay.value) : undefined, paper: paper.value },
  })
  void loadPreview()
})

onMounted(async () => {
  await Promise.all([loadBook(), loadDays()])
  observeCanvas()
  void loadPreview()
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  stopExportPoll()   // 只清本页定时器；后台导出照跑
})
</script>

<template>
  <div class="pr-page">
    <!-- ══ 顶栏：返回 / 书名 / 卷种 / 导出 / 审核入口 ══ -->
    <div class="pr-head">
      <el-button text @click="goBack">← 返回书架</el-button>
      <div class="pr-title">{{ bookTitle || '每日打卡' }}</div>
      <el-radio-group v-model="paper" size="small">
        <el-radio-button value="question">题目卷</el-radio-button>
        <el-radio-button value="answer">解析卷</el-radio-button>
      </el-radio-group>
      <el-button :loading="exportingDay" :disabled="!curDay" @click="onExportDay">导出本天</el-button>
      <el-button type="primary" @click="openExportBook">导出本书</el-button>
      <el-button text class="pr-review-link" @click="goReview">审核</el-button>
    </div>

    <div class="pr-body">
      <!-- ══ 左：天目录（干净，无审核角标）══ -->
      <aside class="pr-toc">
        <div class="toc-cap">目录</div>
        <button
          v-for="d in days"
          :key="d.day"
          class="toc-item"
          :class="{ on: d.day === curDay }"
          @click="pickDay(d.day)"
        >第 {{ d.day }} 天</button>
      </aside>

      <!-- ══ 中：punch-v1 纸面（与导出 PDF 同 theme 同 data）══ -->
      <main ref="canvasRef" class="pr-canvas" v-loading="previewLoading">
        <div v-if="previewError" class="pr-err">{{ previewError }}</div>
        <div v-else class="pr-paper" :style="{ width: boxW + 'px', height: boxH + 'px' }">
          <iframe
            ref="frameRef"
            class="pr-frame"
            :srcdoc="previewHtml"
            :style="{
              width: PAPER_W + 'px',
              height: paperH + 'px',
              transform: `scale(${scale})`,
            }"
            @load="onFrameLoad"
          />
        </div>
      </main>
    </div>

    <!-- ══ 导出本书（异步整册：后台渲染，punchExport 持久化可续看）══ -->
    <el-dialog v-model="exportDialogVisible" title="导出本书" width="520px" :close-on-click-modal="false">
      <div class="exp-head">
        <span>卷种</span>
        <el-checkbox-group v-model="exportPapers" :disabled="exportRunning">
          <el-checkbox value="question">题目卷</el-checkbox>
          <el-checkbox value="answer">解析卷</el-checkbox>
        </el-checkbox-group>
      </div>
      <div class="exp-body">
        <div v-if="exportRunning" class="exp-wait">
          全册 {{ exportState?.days ?? days.length }} 天正在后台合并渲染（约 2-5 分钟）…<br />
          可关闭本窗口继续翻阅，完成后重开「导出本书」即可下载。
        </div>
        <template v-else-if="exportDone">
          <div class="exp-done">
            ✓ 全册已合并（{{ exportState?.days ?? days.length }} 天）
            <span v-if="exportState?.exportedAt" class="exp-time">{{ String(exportState.exportedAt).slice(0, 16).replace('T', ' ') }}</span>
          </div>
          <div class="exp-files">
            <el-button
              v-if="exportState?.questionUrl"
              type="primary"
              plain
              @click="openExportFile(exportState?.questionUrl)"
            >题目全册 PDF ↗</el-button>
            <el-button
              v-if="exportState?.answerUrl"
              plain
              @click="openExportFile(exportState?.answerUrl)"
            >解析全册 PDF ↗</el-button>
          </div>
        </template>
        <div v-else-if="exportErr" class="exp-err">{{ exportErr }}</div>
        <div v-else class="exp-tip">
          选好卷种后点「开始导出」：后台把全书各天合并成一份 PDF（每种卷一份，约 2-5 分钟），
          期间可关窗继续翻阅；导好的全册长期可下，重新导出会覆盖上一次。
        </div>
      </div>
      <template #footer>
        <el-button @click="exportDialogVisible = false">关闭</el-button>
        <el-button type="primary" :loading="exportRunning" :disabled="exportRunning" @click="runExportBook">
          {{ exportRunning ? '后台导出中…' : exportDone ? '重新导出（覆盖）' : '开始导出' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.pr-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--header-h, 64px));
  background: #f5f6f7;
}
.pr-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 18px;
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
}
.pr-title {
  font-size: 16px;
  font-weight: 700;
  color: #1f2937;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pr-review-link {
  color: #9ca3af;
}
.pr-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.pr-toc {
  width: 150px;
  flex-shrink: 0;
  overflow-y: auto;
  background: #fff;
  border-right: 1px solid #e5e7eb;
  padding: 10px 8px 20px;
}
.toc-cap {
  font-size: 12px;
  color: #9ca3af;
  padding: 4px 10px 8px;
}
.toc-item {
  display: block;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: none;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  color: #374151;
}
.toc-item:hover {
  background: #f3f4f6;
}
.toc-item.on {
  background: #ecfdf5;
  color: #047857;
  font-weight: 700;
}
.pr-canvas {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  display: flex;
  justify-content: center;
  padding: 20px 30px 40px;
}
.pr-paper {
  position: relative;
  flex-shrink: 0;
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.12);
  border-radius: 3px;
  overflow: hidden;
  background: #fff;
}
.pr-frame {
  border: none;
  transform-origin: top left;
  display: block;
}
.pr-err {
  color: #dc2626;
  font-size: 13px;
  padding: 40px 0;
}
/* ── 导出弹窗（与审核页同款）── */
.exp-head {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 13px;
  color: #374151;
}
.exp-body {
  min-height: 90px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.exp-wait {
  font-size: 13px;
  color: #6b7280;
  text-align: center;
  padding: 24px 10px 18px;
  line-height: 1.7;
}
.exp-done {
  font-size: 13px;
  font-weight: 700;
  color: #059669;
  margin-bottom: 12px;
}
.exp-time {
  margin-left: 8px;
  font-weight: 400;
  font-size: 12px;
  color: #9ca3af;
}
.exp-files {
  display: flex;
  gap: 10px;
}
.exp-err {
  color: #dc2626;
  font-size: 13px;
}
.exp-tip {
  font-size: 12px;
  color: #9ca3af;
  line-height: 1.7;
}
</style>
