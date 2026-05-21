<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'

// ── 路由 ──────────────────────────────────────────────────────
const router = useRouter()

// ── 类型定义 ─────────────────────────────────────────────────
interface QuestionKnowledge {
  id: number | null
  questionId: number
  knowledgeId: string
  knowledgeName: string
}

interface PaperQuestion {
  id: number
  questionType: number        // 1=选择 / 4=填空 / 5=简答
  difficult: number | null   // 4星制难度
  stemImg: string | null
  stemText?: string | null
  answerImg?: string | null
  explainImg?: string | null
  questionKnowledges?: QuestionKnowledge[]
  score: number               // 每题分值（可编辑）
  [key: string]: unknown
}

interface PaperDraft {
  questions: PaperQuestion[]
  examData?: unknown
  createdAt?: string
}

// ── 状态 ─────────────────────────────────────────────────────
const paperTitle = ref<string>('')
const answerTime = ref<number>(120)
const includeAnswer = ref<boolean>(false)
const includeExplain = ref<boolean>(false)

// 题列表（本地可编辑 state）
const paperQuestions = ref<PaperQuestion[]>([])
const loading = ref(true)

// 右侧面板：所有题统一分值
const unifiedScore = ref<number>(2)

// 排序模式（当前只实现"按题型"）
const sortMode = ref<'type' | 'knowledge' | 'free'>('type')

// ── 初始化：从 localStorage 读数据 ────────────────────────────
onMounted(() => {
  const raw = localStorage.getItem('paperDraft')
  if (!raw) {
    ElMessage.warning('未找到组卷数据，即将跳回题库')
    setTimeout(() => router.push('/question/index'), 1500)
    loading.value = false
    return
  }
  try {
    const draft: PaperDraft = JSON.parse(raw)
    paperQuestions.value = (draft.questions ?? []).map((q) => ({
      ...q,
      score: q.score ?? 0,
    }))
    // 默认标题：自动组卷-yyyy-MM-dd
    const today = new Date().toISOString().slice(0, 10)
    paperTitle.value = `自动组卷-${today}`
  } catch (e) {
    console.warn('[papers/edit] parse localStorage failed', e)
    ElMessage.error('组卷数据解析失败，请重新组卷')
    router.push('/question/index')
  } finally {
    loading.value = false
  }
})

// ── helper ───────────────────────────────────────────────────
function getQuestionTypeLabel(type: number): string {
  const map: Record<number, string> = { 1: '选择题', 4: '填空题', 5: '简答题' }
  return map[type] ?? `题型${type}`
}

function getQuestionTypeTagClass(type: number): string {
  const map: Record<number, string> = { 1: 'type-tag--primary', 4: 'type-tag--success', 5: 'type-tag--warning' }
  return map[type] ?? 'type-tag--info'
}

// ── 按题型分组（computed）─────────────────────────────────────
const questionsByType = computed<Record<string, PaperQuestion[]>>(() => {
  if (sortMode.value !== 'type') {
    return { '全部题目': paperQuestions.value }
  }
  const groups: Record<string, PaperQuestion[]> = {}
  paperQuestions.value.forEach((q) => {
    const label = getQuestionTypeLabel(q.questionType)
    if (!groups[label]) groups[label] = []
    groups[label].push(q)
  })
  return groups
})

// 总分（computed）
const totalScore = computed<number>(() =>
  paperQuestions.value.reduce((sum, q) => sum + (q.score || 0), 0)
)

// ── 每题编辑操作 ──────────────────────────────────────────────

// 上移（全局列表里移位）
function moveUp(question: PaperQuestion) {
  const idx = paperQuestions.value.findIndex((q) => q.id === question.id)
  if (idx <= 0) return
  const arr = [...paperQuestions.value]
  ;[arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]
  paperQuestions.value = arr
}

// 下移
function moveDown(question: PaperQuestion) {
  const idx = paperQuestions.value.findIndex((q) => q.id === question.id)
  if (idx < 0 || idx >= paperQuestions.value.length - 1) return
  const arr = [...paperQuestions.value]
  ;[arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]]
  paperQuestions.value = arr
}

// 删除
function deleteQuestion(question: PaperQuestion) {
  const idx = paperQuestions.value.findIndex((q) => q.id === question.id)
  if (idx < 0) return
  paperQuestions.value.splice(idx, 1)
  ElMessage.success('已删除该题')
}

// 统一分值批量填入
function applyUnifiedScore() {
  paperQuestions.value.forEach((q) => {
    q.score = unifiedScore.value
  })
  ElMessage.success(`已将所有题分值设为 ${unifiedScore.value} 分`)
}

// ── 导出 PDF ──────────────────────────────────────────────────
const exportingPdf = ref(false)
const exportProgress = ref('')
const previewRef = ref<HTMLElement | null>(null)

async function handleExportPdf() {
  if (paperQuestions.value.length === 0) {
    ElMessage.warning('试卷无题目，无法导出')
    return
  }
  exportingPdf.value = true
  exportProgress.value = '正在导出 PDF，约 5-10 秒...'
  ElMessage.info('正在生成 PDF，请稍候（约 5-10 秒）...')

  try {
    const el = previewRef.value
    if (!el) {
      throw new Error('预览区 DOM 未就绪')
    }

    exportProgress.value = '正在截图页面内容...'

    // html2canvas 截图
    const canvas = await html2canvas(el, {
      scale: 2,            // 2x 清晰度
      useCORS: true,       // 允许跨域图片
      logging: false,
      backgroundColor: '#ffffff',
    })

    exportProgress.value = '正在生成 PDF 文件...'

    const imgData = canvas.toDataURL('image/jpeg', 0.92)
    const imgWidth = canvas.width
    const imgHeight = canvas.height

    // A4 尺寸（mm）：210 × 297
    const pdfWidth = 210
    const pdfHeight = (imgHeight / imgWidth) * pdfWidth

    const pdf = new jsPDF({
      orientation: pdfHeight > pdfWidth ? 'portrait' : 'landscape',
      unit: 'mm',
      format: pdfHeight > 297 ? [pdfWidth, pdfHeight] : 'a4',
    })

    // 如果内容超过 A4 高度，则多页处理
    if (pdfHeight <= 297) {
      pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, pdfHeight)
    } else {
      // 多页切割
      const pageHeight = 297
      let offset = 0
      while (offset < pdfHeight) {
        const sliceHeight = Math.min(pageHeight, pdfHeight - offset)
        const sliceCanvas = document.createElement('canvas')
        sliceCanvas.width = canvas.width
        sliceCanvas.height = (sliceHeight / pdfHeight) * canvas.height
        const ctx = sliceCanvas.getContext('2d')!
        ctx.drawImage(
          canvas,
          0,
          (offset / pdfHeight) * canvas.height,
          canvas.width,
          sliceCanvas.height,
          0,
          0,
          canvas.width,
          sliceCanvas.height,
        )
        const sliceImgData = sliceCanvas.toDataURL('image/jpeg', 0.92)
        if (offset > 0) pdf.addPage()
        pdf.addImage(sliceImgData, 'JPEG', 0, 0, pdfWidth, sliceHeight)
        offset += pageHeight
      }
    }

    const suffix = [
      includeAnswer.value ? 'with-answer' : '',
      includeExplain.value ? 'with-explain' : '',
    ]
      .filter(Boolean)
      .join('-')
    const filename = suffix
      ? `${paperTitle.value || '试卷'}-${suffix}.pdf`
      : `${paperTitle.value || '试卷'}.pdf`
    pdf.save(filename)
    exportProgress.value = ''
    ElMessage.success(`PDF 已下载：${filename}`)
  } catch (err) {
    console.error('[export-pdf] failed', err)
    exportProgress.value = ''
    ElMessage.error('PDF 导出失败，请重试')
  } finally {
    exportingPdf.value = false
  }
}

// ── 空壳出口按钮 ──────────────────────────────────────────────
function handleCopyLink() {
  ElMessage.info('复制链接功能开发中')
}

function handleExportEE() {
  ElMessage.info('导出 EE 功能开发中')
}

function handleCreatePaper() {
  ElMessage.info('创建试卷功能开发中')
}

function handleSwitchQuestion(q: PaperQuestion) {
  ElMessage.info(`换一题功能开发中 (id: ${q.id})`)
}

function handleShowAnalysis(q: PaperQuestion) {
  ElMessage.info(`解析功能开发中 (id: ${q.id})`)
}

function handleShowDetail(q: PaperQuestion) {
  ElMessage.info(`详情功能开发中 (id: ${q.id})`)
}

// ── 回题库 ────────────────────────────────────────────────────
function backToQuestion() {
  ElMessageBox.confirm('确认返回题库？未保存的分值修改将丢失。', '提示', {
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    type: 'warning',
  })
    .then(() => router.push('/question/index'))
    .catch(() => {})
}
</script>

<template>
  <div v-loading="loading" class="papers-edit-page">

    <!-- ── 顶部操作栏（sticky）── -->
    <div class="top-bar">
      <el-button size="small" class="back-btn" @click="backToQuestion">
        <el-icon><ArrowLeft /></el-icon>返回题库
      </el-button>

      <div class="top-bar-center">
        <el-icon color="#4080ff" :size="16"><Document /></el-icon>
        <span class="top-bar-title">组卷工作台</span>
      </div>

      <!-- 总分统计 — 突出展示 -->
      <div class="stat-area">
        <div class="stat-item">
          <span class="stat-value">{{ paperQuestions.length }}</span>
          <span class="stat-label">道题</span>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-item">
          <span class="stat-value total-score-highlight">{{ totalScore }}</span>
          <span class="stat-label">分</span>
        </div>
      </div>
    </div>

    <!-- ── 主工作区 ── -->
    <div class="work-layout">

      <!-- =================== 左侧预览区 75% =================== -->
      <div class="left-panel-wrapper">
        <el-scrollbar max-height="calc(100vh - 108px)">
          <div class="left-panel" ref="previewRef">
            <!-- 试卷标题区 -->
            <div class="paper-title-area">
              <el-input
                v-model="paperTitle"
                placeholder="请输入试卷标题"
                size="large"
                class="paper-title-input"
              />
              <div class="paper-meta-row">
                <el-icon :size="13" color="#86909c"><Calendar /></el-icon>
                <span>{{ new Date().getFullYear() }} 年</span>
                <span class="meta-sep">·</span>
                <el-icon :size="13" color="#86909c"><User /></el-icon>
                <span>教师</span>
                <span class="meta-sep">·</span>
                <el-icon :size="13" color="#86909c"><Timer /></el-icon>
                <span>{{ answerTime }} 分钟</span>
              </div>
            </div>

            <!-- 无题目提示 -->
            <el-empty
              v-if="paperQuestions.length === 0 && !loading"
              description="试卷暂无题目，请返回题库加题后再组卷"
              class="empty-paper"
            >
              <template #image>
                <el-icon style="font-size: 56px; color: #c9cdd4;"><Document /></el-icon>
              </template>
              <el-button type="primary" @click="backToQuestion">返回题库</el-button>
            </el-empty>

            <!-- 按题型分组渲染 -->
            <div
              v-for="(groupQuestions, typeName) in questionsByType"
              :key="typeName"
              class="question-group"
            >
              <!-- sticky 分组 header -->
              <div class="group-header">
                <div class="group-line"></div>
                <div class="group-label-wrap">
                  <span class="group-label">{{ typeName }}</span>
                  <span class="group-count">（{{ groupQuestions.length }} 题）</span>
                </div>
                <div class="group-line"></div>
              </div>

              <div
                v-for="(q, idx) in groupQuestions"
                :key="q.id"
                class="paper-question-card"
              >
                <!-- 题卡头部 -->
                <div class="pq-header">
                  <span class="pq-index">{{ idx + 1 }}</span>
                  <span class="type-tag" :class="getQuestionTypeTagClass(q.questionType)">
                    {{ getQuestionTypeLabel(q.questionType) }}
                  </span>
                  <el-rate
                    :model-value="q.difficult ?? 0"
                    :max="4"
                    disabled
                    style="display:inline-flex; margin-left:8px; vertical-align:middle;"
                  />
                  <span class="pq-score-badge">{{ q.score }} 分</span>
                </div>

                <!-- 题干 -->
                <div class="pq-stem">
                  <img
                    v-if="q.stemImg"
                    :src="q.stemImg"
                    class="pq-stem-img"
                    loading="lazy"
                    alt="题干"
                    referrerpolicy="no-referrer"
                    @error="(e: Event) => ((e.target as HTMLImageElement).style.display='none')"
                  />
                  <span v-else-if="q.stemText" class="pq-stem-text">{{ q.stemText }}</span>
                  <span v-else class="pq-stem-placeholder">题 ID: {{ q.id }}</span>
                </div>

                <!-- 知识点 -->
                <div class="pq-knowledge" v-if="(q.questionKnowledges?.length ?? 0) > 0">
                  <el-tag
                    v-for="(k, ki) in q.questionKnowledges"
                    :key="ki"
                    type="info"
                    size="small"
                    style="margin-right: 4px; margin-bottom: 4px; border-radius: 3px;"
                  >
                    {{ k.knowledgeName || k.knowledgeId }}
                  </el-tag>
                </div>

                <!-- 答案区 -->
                <div v-if="includeAnswer && (q.answerImg || q.stemText)" class="pq-answer-area">
                  <div class="pq-area-label">
                    <el-icon :size="12"><Check /></el-icon>答案
                  </div>
                  <img
                    v-if="q.answerImg"
                    :src="q.answerImg"
                    class="pq-area-img"
                    alt="答案"
                    referrerpolicy="no-referrer"
                    @error="(e: Event) => ((e.target as HTMLImageElement).style.display='none')"
                  />
                  <span v-else class="pq-area-text">（暂无图片答案）</span>
                </div>

                <!-- 解析区 -->
                <div v-if="includeExplain && (q.explainImg || q.stemText)" class="pq-explain-area">
                  <div class="pq-area-label">
                    <el-icon :size="12"><InfoFilled /></el-icon>解析
                  </div>
                  <img
                    v-if="q.explainImg"
                    :src="q.explainImg"
                    class="pq-area-img"
                    alt="解析"
                    referrerpolicy="no-referrer"
                    @error="(e: Event) => ((e.target as HTMLImageElement).style.display='none')"
                  />
                  <span v-else class="pq-area-text">（暂无图片解析）</span>
                </div>

                <!-- 底部操作行 -->
                <div class="pq-footer">
                  <!-- 分值输入 -->
                  <div class="pq-score-area">
                    <span class="pq-score-label">分值：</span>
                    <el-input-number
                      v-model="q.score"
                      :min="0"
                      :max="100"
                      :step="1"
                      size="small"
                      controls-position="right"
                      style="width: 90px;"
                    />
                    <span class="pq-score-unit">分</span>
                  </div>

                  <!-- 操作按钮组 -->
                  <div class="pq-ops">
                    <el-button size="small" class="pq-op-btn" @click="handleShowAnalysis(q)">解析</el-button>
                    <el-button
                      size="small"
                      class="pq-op-btn"
                      @click="moveUp(q)"
                      :disabled="paperQuestions.indexOf(q) === 0"
                    >
                      <el-icon><Top /></el-icon>上移
                    </el-button>
                    <el-button
                      size="small"
                      class="pq-op-btn"
                      @click="moveDown(q)"
                      :disabled="paperQuestions.indexOf(q) === paperQuestions.length - 1"
                    >
                      <el-icon><Bottom /></el-icon>下移
                    </el-button>
                    <el-button size="small" class="pq-op-btn" @click="handleSwitchQuestion(q)">换一题</el-button>
                    <el-button size="small" class="pq-op-btn" @click="handleShowDetail(q)">详情</el-button>
                    <el-button size="small" type="danger" plain class="pq-op-btn" @click="deleteQuestion(q)">
                      <el-icon><Delete /></el-icon>删除
                    </el-button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </el-scrollbar>
      </div>

      <!-- =================== 右侧操作面板 25% =================== -->
      <div class="right-panel">

        <!-- 总分统计卡 -->
        <div class="stat-card">
          <div class="stat-card-row">
            <div class="stat-card-item">
              <div class="stat-card-value primary-color">{{ paperQuestions.length }}</div>
              <div class="stat-card-label">题目数</div>
            </div>
            <div class="stat-card-divider"></div>
            <div class="stat-card-item">
              <div class="stat-card-value primary-color">{{ totalScore }}</div>
              <div class="stat-card-label">总分</div>
            </div>
            <div class="stat-card-divider"></div>
            <div class="stat-card-item">
              <div class="stat-card-value">{{ answerTime }}</div>
              <div class="stat-card-label">分钟</div>
            </div>
          </div>
        </div>

        <!-- 基本信息 -->
        <div class="panel-section">
          <div class="panel-section-title">
            <el-icon color="#4080ff" :size="14"><Setting /></el-icon>
            基本设置
          </div>
          <div class="panel-section-body">
            <div class="sort-mode-row">
              <span class="field-label">排列方式</span>
              <el-button-group class="sort-btn-group">
                <el-button
                  :type="sortMode === 'type' ? 'primary' : undefined"
                  size="small"
                  @click="sortMode = 'type'"
                >按题型</el-button>
                <el-button
                  :type="sortMode === 'knowledge' ? 'primary' : undefined"
                  size="small"
                  @click="sortMode = 'knowledge'"
                >知识点</el-button>
                <el-button
                  :type="sortMode === 'free' ? 'primary' : undefined"
                  size="small"
                  @click="sortMode = 'free'"
                >自由</el-button>
              </el-button-group>
            </div>
          </div>
        </div>

        <!-- 分值设置 -->
        <div class="panel-section">
          <div class="panel-section-title">
            <el-icon color="#f6a623" :size="14"><Trophy /></el-icon>
            分值设置
          </div>
          <div class="panel-section-body">
            <div class="field-row">
              <span class="field-label">统一分值</span>
              <div class="field-value">
                <el-input-number
                  v-model="unifiedScore"
                  :min="0"
                  :max="100"
                  :step="1"
                  size="small"
                  controls-position="right"
                  style="width: 90px;"
                />
                <span class="field-unit">分</span>
              </div>
            </div>
            <el-button size="small" type="primary" plain style="width: 100%; margin-top: 8px;" @click="applyUnifiedScore">
              批量填入到所有题
            </el-button>
          </div>
        </div>

        <!-- 答题时间 -->
        <div class="panel-section">
          <div class="panel-section-title">
            <el-icon color="#34c38f" :size="14"><Timer /></el-icon>
            答题时间
          </div>
          <div class="panel-section-body">
            <div class="field-row">
              <span class="field-label">时长</span>
              <div class="field-value">
                <el-input-number
                  v-model="answerTime"
                  :min="10"
                  :max="300"
                  :step="5"
                  size="small"
                  controls-position="right"
                  style="width: 90px;"
                />
                <span class="field-unit">分钟</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 导出选项 -->
        <div class="panel-section">
          <div class="panel-section-title">
            <el-icon color="#86909c" :size="14"><Files /></el-icon>
            导出选项
          </div>
          <div class="panel-section-body">
            <div class="checkbox-row">
              <el-checkbox v-model="includeAnswer">包含答案</el-checkbox>
            </div>
            <div class="checkbox-row" style="margin-top: 8px;">
              <el-checkbox v-model="includeExplain">包含解析</el-checkbox>
            </div>
          </div>
        </div>

        <!-- 4 个出口按钮（纵向堆叠）-->
        <div class="panel-section export-section">
          <div class="panel-section-title">
            <el-icon color="#4080ff" :size="14"><Upload /></el-icon>
            导出 / 发布
          </div>
          <div class="panel-section-body export-btns">
            <el-button
              class="export-btn"
              @click="handleCopyLink"
            >
              <el-icon><Link /></el-icon>复制链接
            </el-button>
            <el-button
              class="export-btn"
              @click="handleExportEE"
            >
              <el-icon><Share /></el-icon>导出 EE
            </el-button>
            <el-button
              class="export-btn export-btn--pdf"
              :loading="exportingPdf"
              @click="handleExportPdf"
            >
              <el-icon v-if="!exportingPdf"><Download /></el-icon>
              {{ exportingPdf ? (exportProgress || '正在导出...') : '导出 PDF' }}
            </el-button>
            <el-button
              class="export-btn export-btn--create"
              type="success"
              @click="handleCreatePaper"
            >
              <el-icon><DocumentAdd /></el-icon>创建试卷
            </el-button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.papers-edit-page {
  min-height: 100vh;
  background: #f0f2f5;
  display: flex;
  flex-direction: column;
}

/* ── 顶部 bar ── */
.top-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 24px;
  height: 52px;
  background: #ffffff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
  position: sticky;
  top: 0;
  z-index: 100;
}

.back-btn {
  border-radius: 6px;
  color: #4e5969;
  border-color: #e5e6eb;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 3px;
}

.back-btn:hover {
  color: #4080ff;
  border-color: #4080ff;
  background: rgba(64, 128, 255, 0.04);
}

.top-bar-center {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  justify-content: center;
}

.top-bar-title {
  font-size: 15px;
  font-weight: 700;
  color: #1d2129;
}

/* ── 总分统计区（顶栏右侧）── */
.stat-area {
  display: flex;
  align-items: center;
  gap: 0;
  background: #f8f9ff;
  border: 1px solid #e8f0ff;
  border-radius: 8px;
  padding: 6px 16px;
}

.stat-item {
  display: flex;
  align-items: baseline;
  gap: 4px;
  padding: 0 12px;
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
  color: #1d2129;
  line-height: 1;
}

.total-score-highlight {
  color: #4080ff;
}

.stat-label {
  font-size: 12px;
  color: #86909c;
}

.stat-divider {
  width: 1px;
  height: 20px;
  background: #e5e6eb;
}

/* ── 主工作区布局 ── */
.work-layout {
  display: flex;
  gap: 0;
  padding: 16px;
  flex: 1;
  align-items: flex-start;
  min-height: 0;
  gap: 12px;
}

/* ── 左侧预览区 ── */
.left-panel-wrapper {
  flex: 75;
  min-height: 0;
}

.left-panel {
  background: #ffffff;
  border-radius: 10px;
  border: 1px solid #f2f3f5;
  padding: 32px;
  min-height: 600px;
  box-shadow: 0 2px 8px rgba(64, 128, 255, 0.05);
}

/* ── 试卷标题区 ── */
.paper-title-area {
  margin-bottom: 28px;
  padding-bottom: 20px;
  border-bottom: 2px solid #f2f3f5;
}

.paper-title-input {
  margin-bottom: 12px;
}

:deep(.paper-title-input .el-input__inner) {
  font-size: 20px;
  font-weight: 700;
  color: #1d2129;
  border: none;
  padding: 0;
  background: transparent;
  box-shadow: none;
}

:deep(.paper-title-input .el-input__wrapper) {
  box-shadow: none;
  border-bottom: 2px dashed #e5e6eb;
  border-radius: 0;
  padding: 0;
  padding-bottom: 8px;
  background: transparent;
}

:deep(.paper-title-input .el-input__wrapper:hover),
:deep(.paper-title-input .el-input__wrapper.is-focus) {
  border-bottom-color: #4080ff;
  box-shadow: none;
}

.paper-meta-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #86909c;
  margin-top: 8px;
}

.meta-sep {
  color: #c9cdd4;
  margin: 0 2px;
}

/* ── 空试卷提示 ── */
.empty-paper {
  margin: 40px 0;
}

/* ── 题型分组 ── */
.question-group {
  margin-bottom: 24px;
}

.group-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.group-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, #dcdfe6 30%, #dcdfe6 70%, transparent);
}

.group-label-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  background: #f8f9ff;
  border: 1px solid #e8f0ff;
  border-radius: 20px;
  padding: 4px 14px;
}

.group-label {
  font-size: 13px;
  font-weight: 700;
  color: #4080ff;
}

.group-count {
  font-size: 12px;
  color: #86909c;
}

/* ── 每题卡片 ── */
.paper-question-card {
  border: 1px solid #f2f3f5;
  border-radius: 8px;
  padding: 16px 18px;
  margin-bottom: 10px;
  background: #ffffff;
  transition: all 0.2s ease;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
}

.paper-question-card:hover {
  border-color: #d0e2ff;
  box-shadow: 0 4px 14px rgba(64, 128, 255, 0.1);
}

.pq-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.pq-index {
  width: 24px;
  height: 24px;
  background: linear-gradient(135deg, #4080ff, #3370e8);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* 题型 tag（与题库页保持一致）*/
.type-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.type-tag--primary {
  background: #e8f0ff;
  color: #3564d0;
}

.type-tag--success {
  background: #e6f9f2;
  color: #1e9e6e;
}

.type-tag--warning {
  background: #fff6e5;
  color: #c47d0e;
}

.type-tag--info {
  background: #f2f3f5;
  color: #86909c;
}

.pq-score-badge {
  margin-left: auto;
  font-size: 13px;
  font-weight: 600;
  color: #4080ff;
  background: #e8f0ff;
  padding: 2px 8px;
  border-radius: 4px;
}

/* ── 题干 ── */
.pq-stem {
  margin-bottom: 10px;
  min-height: 36px;
}

.pq-stem-img {
  max-width: 100%;
  max-height: 220px;
  display: block;
  border-radius: 6px;
  background: #f8f9fa;
}

.pq-stem-text {
  font-size: 14px;
  color: #1d2129;
  line-height: 1.7;
}

.pq-stem-placeholder {
  font-size: 12px;
  color: #c9cdd4;
}

.pq-knowledge {
  margin-bottom: 8px;
}

/* ── 答案/解析 ── */
.pq-answer-area,
.pq-explain-area {
  margin: 8px 0;
  padding: 10px 12px;
  border-left: 3px solid #4080ff;
  border-radius: 0 6px 6px 0;
  background: #f0f5ff;
}

.pq-explain-area {
  background: #f0faf6;
  border-left-color: #34c38f;
}

.pq-area-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 700;
  color: #4080ff;
  margin-bottom: 6px;
}

.pq-explain-area .pq-area-label {
  color: #34c38f;
}

.pq-area-img {
  max-width: 100%;
  max-height: 180px;
  display: block;
  border-radius: 4px;
}

.pq-area-text {
  font-size: 13px;
  color: #86909c;
}

/* ── 卡底操作行 ── */
.pq-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  border-top: 1px solid #f2f3f5;
  padding-top: 10px;
  margin-top: 8px;
}

.pq-score-area {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pq-score-label,
.pq-score-unit {
  font-size: 13px;
  color: #4e5969;
}

.pq-ops {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.pq-op-btn {
  border-radius: 5px;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  gap: 3px;
}

.pq-op-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
}

/* ── 右侧面板 ── */
.right-panel {
  flex: 25;
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: sticky;
  top: 64px;
  max-height: calc(100vh - 80px);
  overflow-y: auto;
}

/* ── 统计卡 ── */
.stat-card {
  background: #ffffff;
  border-radius: 10px;
  border: 1px solid #e8f0ff;
  padding: 16px;
  box-shadow: 0 2px 8px rgba(64, 128, 255, 0.08);
}

.stat-card-row {
  display: flex;
  align-items: center;
}

.stat-card-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.stat-card-value {
  font-size: 24px;
  font-weight: 800;
  color: #1d2129;
  line-height: 1;
}

.stat-card-value.primary-color {
  color: #4080ff;
}

.stat-card-label {
  font-size: 11px;
  color: #86909c;
}

.stat-card-divider {
  width: 1px;
  height: 32px;
  background: #f2f3f5;
}

/* ── panel section ── */
.panel-section {
  background: #ffffff;
  border-radius: 10px;
  border: 1px solid #f2f3f5;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
  overflow: hidden;
}

.panel-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: #1d2129;
  padding: 12px 14px 10px;
  border-bottom: 1px solid #f2f3f5;
  background: #fafbff;
}

.panel-section-body {
  padding: 12px 14px;
}

.field-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.field-label {
  font-size: 13px;
  color: #4e5969;
  flex-shrink: 0;
}

.field-value {
  display: flex;
  align-items: center;
  gap: 6px;
}

.field-unit {
  font-size: 13px;
  color: #86909c;
}

.sort-mode-row {
  display: flex;
  align-items: center;
  flex-direction: column;
  gap: 8px;
}

.sort-btn-group {
  width: 100%;
}

.sort-btn-group :deep(.el-button) {
  flex: 1;
  font-size: 12px;
}

.checkbox-row {
  display: flex;
  align-items: center;
}

/* ── 导出按钮区 ── */
.export-section {
  border-color: #e8f0ff;
}

.export-btns {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.export-btn {
  width: 100%;
  height: 36px;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all 0.2s;
  color: #4e5969;
  border-color: #e5e6eb;
}

.export-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.1);
}

.export-btn--pdf {
  background: linear-gradient(135deg, #4080ff, #3370e8) !important;
  border-color: transparent !important;
  color: #ffffff !important;
  font-size: 14px;
  height: 42px;
  font-weight: 700;
  box-shadow: 0 3px 10px rgba(64, 128, 255, 0.35);
}

.export-btn--pdf:hover {
  box-shadow: 0 6px 18px rgba(64, 128, 255, 0.5) !important;
  transform: translateY(-2px);
}

.export-btn--create {
  border-color: #34c38f !important;
  color: #1e9e6e !important;
}

.export-btn--create:hover {
  background: #e6f9f2 !important;
  box-shadow: 0 3px 10px rgba(52, 195, 143, 0.2) !important;
}
</style>
