<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, Plus, Check } from '@element-plus/icons-vue'
import {
  getPaperSource,
  type PaperSourceQuestion,
} from '@/api/question/index'
import FreeTagList from '@/components/business/FreeTagList/index.vue'

// ── 路由 ────────────────────────────────────────────────────
const route = useRoute()
const router = useRouter()
const paperId = computed(() => route.params.id as string)

// ── 错题栏 localStorage（子任务 B3）──────────────────────────
const LS_ERROR_BOOK_IDS = 'book-ui:error-book-ids'

function readErrorBookIds(): Set<number> {
  try {
    const raw = localStorage.getItem(LS_ERROR_BOOK_IDS)
    if (!raw) return new Set()
    const arr: number[] = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function writeErrorBookIds(ids: Set<number>) {
  try {
    localStorage.setItem(LS_ERROR_BOOK_IDS, JSON.stringify([...ids]))
  } catch (e) {
    console.warn('[errorBook] localStorage write failed', e)
  }
}

const errorBookIds = ref<Set<number>>(readErrorBookIds())
const errorBookToggleLoading = ref<Set<number>>(new Set())

async function handleErrorBookToggle(question: PaperSourceQuestion) {
  const id = question.id
  if (errorBookToggleLoading.value.has(id)) return

  // 防连点
  const newLoading = new Set(errorBookToggleLoading.value)
  newLoading.add(id)
  errorBookToggleLoading.value = newLoading

  const wasIn = errorBookIds.value.has(id)
  const newSet = new Set(errorBookIds.value)

  // V1: 错题栏功能本卡范围未实装 BE 端点，仅 localStorage 持久化（view-only）。
  // PRD F-5 删除 addErrorBasket / removeErrorBasket API 函数；体验保留前端态。
  if (wasIn) {
    newSet.delete(id)
    errorBookIds.value = newSet
    writeErrorBookIds(newSet)
    ElMessage.success('已从错题栏移除')
  } else {
    newSet.add(id)
    errorBookIds.value = newSet
    writeErrorBookIds(newSet)
    ElMessage.success('已加入错题栏')
  }

  const doneLoading = new Set(errorBookToggleLoading.value)
  doneLoading.delete(id)
  errorBookToggleLoading.value = doneLoading
}

// ── 原卷数据 ─────────────────────────────────────────────────
const paperName = ref('')
const examYear = ref<string | null>(null)
const questions = ref<PaperSourceQuestion[]>([])
const loading = ref(false)

async function loadPaperSource() {
  loading.value = true
  try {
    const res = await getPaperSource(paperId.value)
    if (res && (res as { paperId?: unknown }).paperId) {
      const detail = res as { paperId: number; paperName: string; examYear?: string | null; questions: PaperSourceQuestion[] }
      paperName.value = detail.paperName || `试卷 ${paperId.value}`
      examYear.value = detail.examYear ?? null
      questions.value = Array.isArray(detail.questions) ? detail.questions : []
    } else if (Array.isArray(res)) {
      // 接口直接返回题目数组的情况
      questions.value = res as PaperSourceQuestion[]
      paperName.value = `试卷 ${paperId.value}`
    } else {
      fallbackFromQuery()
    }
  } catch (e) {
    console.warn('[source] GET /teacher/paper/source/:id failed', e)
    fallbackFromQuery()
  } finally {
    loading.value = false
  }
}

function fallbackFromQuery() {
  // 接口失败时：显示空态 + 提示
  paperName.value = `试卷 ${paperId.value}`
  questions.value = []
  ElMessage.warning('原卷数据加载失败（接口需登录态）')
}

function getQuestionTypeLabel(type: number): string {
  const map: Record<number, string> = { 1: '选择题', 4: '填空题', 5: '简答题' }
  return map[type] ?? `题型${type}`
}

function getQuestionTypeTag(type: number): 'success' | 'warning' | 'info' | 'primary' | 'danger' {
  const map: Record<number, 'primary' | 'success' | 'warning'> = { 1: 'primary', 4: 'success', 5: 'warning' }
  return map[type] ?? 'info'
}

function goBack() {
  router.back()
}

onMounted(() => {
  loadPaperSource()
})
</script>

<template>
  <div class="source-page">
    <!-- 顶部导航栏 -->
    <div class="source-topbar">
      <el-button link @click="goBack" class="back-btn">
        <el-icon><ArrowLeft /></el-icon>
        <span>返回</span>
      </el-button>
      <div class="topbar-info">
        <span class="topbar-title">{{ paperName || '原卷预览' }}</span>
        <el-tag v-if="examYear" type="info" size="small">{{ examYear }}</el-tag>
      </div>
    </div>

    <!-- 内容区 -->
    <div class="source-body">
      <div v-if="loading" class="source-loading">
        <el-skeleton :rows="12" animated style="max-width: 900px; margin: 0 auto;" />
      </div>

      <div v-else-if="questions.length === 0" class="source-empty">
        <el-empty description="暂无题目数据（原卷接口需登录态）">
          <el-button type="primary" @click="goBack">返回</el-button>
        </el-empty>
      </div>

      <div v-else class="question-list">
        <!-- 试卷 header -->
        <div class="paper-header">
          <h2 class="paper-title">{{ paperName }}</h2>
          <div class="paper-meta">
            <span v-if="examYear">{{ examYear }}年</span>
            <span>共 {{ questions.length }} 题</span>
          </div>
        </div>

        <!-- 题目列表 -->
        <div
          v-for="(q, index) in questions"
          :key="q.id"
          class="source-question-card"
          :class="{ 'in-error-book': errorBookIds.has(q.id) }"
        >
          <!-- 题号行 -->
          <div class="q-header-row">
            <div class="q-header-left">
              <span class="q-num">{{ index + 1 }}.</span>
              <span class="q-type-tag" :class="`q-type--${getQuestionTypeTag(q.questionType)}`">
                {{ getQuestionTypeLabel(q.questionType) }}
              </span>
            </div>
            <!-- 加入错题栏按钮（子任务 B3）-->
            <el-button
              size="small"
              class="error-book-btn"
              :class="{ 'error-book-btn--added': errorBookIds.has(q.id) }"
              :type="errorBookIds.has(q.id) ? 'success' : 'primary'"
              :plain="!errorBookIds.has(q.id)"
              :loading="errorBookToggleLoading.has(q.id)"
              @click="handleErrorBookToggle(q)"
            >
              <el-icon v-if="errorBookIds.has(q.id)"><Check /></el-icon>
              <el-icon v-else><Plus /></el-icon>
              {{ errorBookIds.has(q.id) ? '已加错题栏' : '加入错题栏' }}
            </el-button>
          </div>

          <!-- 题干图 -->
          <div class="q-stem-area">
            <img
              v-if="q.stemImg"
              :src="q.stemImg"
              class="q-stem-img"
              alt="题干"
              referrerpolicy="no-referrer"
              loading="lazy"
              @error="(e: Event) => ((e.target as HTMLImageElement).style.display='none')"
            />
            <p v-else-if="q.stemText" class="q-stem-text">{{ q.stemText }}</p>
            <p v-else class="q-stem-placeholder">（题目 ID: {{ q.id }}）</p>
          </div>

          <!-- 知识点 tags -->
          <div
            v-if="q.questionKnowledges && q.questionKnowledges.length > 0"
            class="q-knowledge-tags"
          >
            <el-tag
              v-for="(k, idx) in q.questionKnowledges"
              :key="k.knowledgeId || idx"
              :type="(['success', 'primary', 'warning', 'danger', 'info'] as const)[idx % 5]"
              size="small"
            >
              {{ k.knowledgeName || k.knowledgeId }}
            </el-tag>
          </div>

          <!-- 自由标签 freeTags（X 卡 段③）— detail 模式 -->
          <FreeTagList
            v-if="q.freeTags && q.freeTags.length > 0"
            :tags="q.freeTags"
            mode="detail"
            class="q-free-tags"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.source-page {
  min-height: 100vh;
  background: #f0f2f5;
  display: flex;
  flex-direction: column;
}

/* ── 顶部导航栏 ── */
.source-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  background: #fff;
  border-bottom: 1px solid #f2f3f5;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  position: sticky;
  top: 0;
  z-index: 100;
}

.back-btn {
  color: #4e5969;
  font-size: 14px;
  gap: 4px;
}

.back-btn:hover {
  color: #4080ff;
}

.topbar-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.topbar-title {
  font-size: 16px;
  font-weight: 600;
  color: #1d2129;
}

/* ── 内容区 ── */
.source-body {
  padding: 16px 24px;
  max-width: 1000px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}

.source-loading,
.source-empty {
  display: flex;
  justify-content: center;
  padding: 40px 0;
}

/* ── 试卷 header ── */
.paper-header {
  background: #fff;
  border-radius: 10px;
  padding: 20px 24px;
  margin-bottom: 12px;
  border: 1px solid #f2f3f5;
  text-align: center;
}

.paper-title {
  font-size: 20px;
  font-weight: 700;
  color: #1d2129;
  margin: 0 0 8px;
}

.paper-meta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  font-size: 13px;
  color: #86909c;
}

/* ── 题目卡片 ── */
.source-question-card {
  background: #fff;
  border-radius: 10px;
  border: 1px solid #f2f3f5;
  padding: 16px 20px;
  margin-bottom: 10px;
  transition: all 0.2s;
}

.source-question-card:hover {
  box-shadow: 0 4px 16px rgba(64, 128, 255, 0.1);
  border-color: #d0e2ff;
}

.source-question-card.in-error-book {
  border-left: 3px solid #f7ba1e;
  background: #fffdf0;
}

/* ── 题号行 ── */
.q-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  gap: 8px;
}

.q-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.q-num {
  font-size: 15px;
  font-weight: 700;
  color: #1d2129;
}

.q-type-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}

.q-type--primary {
  background: #e8f0ff;
  color: #3564d0;
}

.q-type--success {
  background: #e8fff0;
  color: #0d7a4a;
}

.q-type--warning {
  background: #fff7e6;
  color: #b45309;
}

.q-type--info {
  background: #f0f0f0;
  color: #6b7280;
}

.q-type--danger {
  background: #fff0f0;
  color: #d32f2f;
}

/* ── 错题栏按钮 ── */
.error-book-btn {
  flex-shrink: 0;
}

.error-book-btn--added {
  opacity: 0.85;
}

/* ── 题干区 ── */
.q-stem-area {
  min-height: 80px;
}

.q-stem-img {
  max-width: 100%;
  height: auto;
  display: block;
}

.q-stem-text {
  font-size: 14px;
  line-height: 1.7;
  color: #1d2129;
  margin: 0;
  white-space: pre-wrap;
}

.q-stem-placeholder {
  font-size: 13px;
  color: #c9cdd4;
  margin: 0;
}

/* ── 知识点 tags ── */
.q-knowledge-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

/* ── 自由标签 freeTags（X 卡 段③）── */
.q-free-tags {
  margin-top: 8px;
}
</style>
