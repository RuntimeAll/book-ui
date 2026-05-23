<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  ArrowLeft,
  Star,
  Edit,
  ShoppingCart,
  Warning,
  ChatDotRound,
  Plus,
} from '@element-plus/icons-vue'
import {
  getQuestionDetail,
  getQuestionNote,
  saveQuestionNote,
  getQuestionSources,
  getSimilarQuestions,
  addFavorite,
  removeFavorite,
  type QuestionItem,
  type QuestionNote,
  type QuestionSource,
  type SimilarQuestion,
} from '@/api/question/index'
import FreeTagList from '@/components/business/FreeTagList/index.vue'
import { useQuestionBasket } from '@/composables/useQuestionBasket'

// ── 路由 ────────────────────────────────────────────────────
const route = useRoute()
const router = useRouter()
// H1 卡补丁：admin V-1 新建的题 id 是 19 位 Snowflake（如 2058063361421082625），
// 超 JS Number.MAX_SAFE_INTEGER (2^53)。Number(route.params.id) 会让末尾 25 变 00
// 精度丢失 → BE 查 DB 没这个 id → "题目详情加载失败"。改全程 string，BE @PathVariable
// Long 收 numeric string 自动 parse 不丢精度。
const questionId = computed(() => String(route.params.id))

// ── 试题栏（全局 singleton composable） ──────────────────────
const basket = useQuestionBasket()

// ── 题目数据 ─────────────────────────────────────────────────
const question = ref<QuestionItem | null>(null)
const loading = ref(false)

async function loadQuestion() {
  loading.value = true
  try {
    // 优先调真接口（questionId.value 是 string 防 19 位 Snowflake 精度丢，cast 绕 API 旧签名 number）
    const res = await getQuestionDetail(questionId.value as unknown as number)
    if (res && (res as QuestionItem).id) {
      question.value = res as QuestionItem
    } else {
      fallbackFromCache()
    }
  } catch (e) {
    console.warn('[detail] GET /teacher/question/:id failed, falling back to cache', e)
    fallbackFromCache()
  } finally {
    loading.value = false
  }
}

function fallbackFromCache() {
  // 兜底从 index.vue 写入的 cache 读
  try {
    const cacheKey = 'book-ui:question-cache-by-id'
    const cache: Record<string, QuestionItem> = JSON.parse(localStorage.getItem(cacheKey) || '{}')
    const cached = cache[String(questionId.value)]
    if (cached) {
      question.value = cached
    } else {
      question.value = null
      ElMessage.warning('题目详情加载失败，请返回重试')
    }
  } catch {
    question.value = null
  }
}

// ── 收藏状态 ─────────────────────────────────────────────────
const isFavorite = ref(false)
const favoriteLoading = ref(false)

async function handleFavorite() {
  if (favoriteLoading.value) return
  favoriteLoading.value = true
  const prev = isFavorite.value
  isFavorite.value = !prev
  try {
    if (prev) {
      await removeFavorite(questionId.value as unknown as number)
      ElMessage.success('已取消收藏')
    } else {
      await addFavorite(questionId.value as unknown as number)
      ElMessage.success('已收藏')
    }
  } catch (e) {
    console.warn('[detail] favorite API failed', e)
  } finally {
    favoriteLoading.value = false
  }
}

// ── 试题栏 toggle（走全局 composable） ───────────────────────
// H1 卡补丁：questionId 改 string 防 Snowflake 精度丢，basket api 还是 number 签名 —
// 这里 cast 绕 TS。注意 Set<number>.has(string) JS 永远 false（strict ===），
// 试题栏状态在 admin 新建题（19 位 id）上可能误判 "未加入"，但不影响详情数据加载。
// 完整修复需要 useQuestionBasket 一并支持 string id — 留待教师端 thread 处理。
const isInBasket = computed(() => basket.basketIds.value.has(questionId.value as unknown as number))
const basketLoading = computed(() => basket.isLoading(questionId.value as unknown as number))

async function handleBasketToggle() {
  const id = questionId.value as unknown as number
  if (basket.isLoading(id)) return
  if (basket.basketIds.value.has(id)) {
    await basket.remove(id)
  } else if (question.value) {
    await basket.add(question.value)
  }
}

// ── 答案/解析折叠 ─────────────────────────────────────────────
const answerExpanded = ref(false)
const explainExpanded = ref(false)
const similarExpanded = ref(false)

// ── 我的备注 ─────────────────────────────────────────────────
// V1 BE: GET /qd/note/{id} 返单对象 / null（uk_user_question 每用户每题最多 1 条）
const note = ref<QuestionNote | null>(null)
const notesLoading = ref(false)
const noteInput = ref('')
const noteSaving = ref(false)

async function loadNotes() {
  notesLoading.value = true
  try {
    const res = await getQuestionNote(questionId.value as unknown as number)
    note.value = res && typeof res === 'object' && 'content' in res ? (res as QuestionNote) : null
  } catch (e) {
    console.warn('[detail] notes GET failed', e)
    note.value = null
  } finally {
    notesLoading.value = false
  }
}

async function saveNote() {
  if (!noteInput.value.trim()) return
  noteSaving.value = true
  try {
    await saveQuestionNote(questionId.value as unknown as number, noteInput.value.trim())
    ElMessage.success('备注已保存')
    noteInput.value = ''
    loadNotes()
  } catch (e) {
    console.warn('[detail] saveNote failed', e)
    ElMessage.warning('保存备注失败（需登录态）')
  } finally {
    noteSaving.value = false
  }
}

// ── 收录情况 ─────────────────────────────────────────────────
const sources = ref<QuestionSource[]>([])
const sourcesLoading = ref(false)

async function loadSources() {
  sourcesLoading.value = true
  try {
    const res = await getQuestionSources(questionId.value as unknown as number)
    sources.value = Array.isArray(res) ? res : []
  } catch (e) {
    console.warn('[detail] sources GET failed', e)
    // 兜底：从题目数据提取 examPaperId / examPaperName
    if (question.value?.examPaperId) {
      sources.value = [{
        examPaperId: question.value.examPaperId,
        examPaperName: question.value.examPaperName ?? `试卷 ${question.value.examPaperId}`,
        examYear: question.value.examYear ?? null,
      }]
    } else {
      sources.value = []
    }
  } finally {
    sourcesLoading.value = false
  }
}

// ── 相似题 ───────────────────────────────────────────────────
const similarQuestions = ref<SimilarQuestion[]>([])
const similarLoading = ref(false)

async function loadSimilar() {
  if (!similarExpanded.value) return
  if (similarLoading.value || similarQuestions.value.length > 0) return
  similarLoading.value = true
  try {
    const res = await getSimilarQuestions(questionId.value as unknown as number)
    similarQuestions.value = Array.isArray(res) ? res : []
  } catch (e) {
    console.warn('[detail] similar GET failed', e)
    similarQuestions.value = []
  } finally {
    similarLoading.value = false
  }
}

// ── 题目报错（V1：功能开发中，本卡 PRD F-5 删 API 函数 + view 改 noop） ─────
function handleReport() {
  ElMessage.info('题目报错功能开发中，敬请期待')
}

// ── 工具 ─────────────────────────────────────────────────────
function getDifficultyStars(difficult: number | null) {
  const val = difficult ?? 0
  return Array.from({ length: 4 }, (_, i) => i < val)
}

function getQuestionTypeLabel(type: number): string {
  const map: Record<number, string> = { 1: '选择题', 4: '填空题', 5: '简答题' }
  return map[type] ?? `题型${type}`
}

function getKnowledgeTagType(idx: number): 'success' | 'primary' | 'warning' | 'danger' | 'info' {
  const types: Array<'success' | 'primary' | 'warning' | 'danger' | 'info'> = [
    'success', 'primary', 'warning', 'danger', 'info'
  ]
  return types[idx % 5]
}

function goBack() {
  router.back()
}

function goToPaperSource(paperId: number) {
  router.push(`/papers/source/${paperId}`)
}

// ── 初始化 ───────────────────────────────────────────────────
onMounted(async () => {
  await loadQuestion()
  // 并行加载侧边栏数据
  Promise.allSettled([loadNotes(), loadSources()])
})
</script>

<template>
  <div class="detail-page">
    <!-- 顶部导航栏 -->
    <div class="detail-topbar">
      <el-button link @click="goBack" class="back-btn">
        <el-icon><ArrowLeft /></el-icon>
        <span>返回题库</span>
      </el-button>
      <span class="topbar-title">题目详情</span>
    </div>

    <div v-if="loading" class="detail-loading">
      <el-skeleton :rows="10" animated style="max-width: 900px; margin: 0 auto;" />
    </div>

    <div v-else-if="!question" class="detail-empty">
      <el-empty description="题目数据加载失败">
        <el-button type="primary" @click="goBack">返回题库</el-button>
      </el-empty>
    </div>

    <div v-else class="detail-body">
      <!-- ══ 左主体区（70%）══ -->
      <div class="detail-main">
        <!-- 顶部 meta 行 -->
        <div class="meta-row">
          <div class="meta-left">
            <!-- 难度星 -->
            <span class="meta-label">难度:</span>
            <span class="stars-row">
              <span
                v-for="(active, i) in getDifficultyStars(question.difficult)"
                :key="i"
                class="star-icon"
                :class="{ 'star-active': active }"
              >★</span>
            </span>
            <!-- 知识点 — misikt 风格：label + 主知识点单 tag -->
            <span class="meta-label">知识点:</span>
            <el-tag
              v-if="question.questionKnowledges && question.questionKnowledges.length > 0"
              type="primary"
              size="small"
              class="knowledge-tag"
            >
              {{ question.questionKnowledges[0].knowledgeName || question.questionKnowledges[0].knowledgeId }}
            </el-tag>
            <span v-else class="knowledge-empty">暂无</span>
          </div>
          <div class="meta-right">
            <!-- 草稿 -->
            <el-button size="small" class="action-btn" @click="ElMessage.info('草稿功能开发中')">
              <el-icon><Edit /></el-icon>草稿
            </el-button>
            <!-- 收藏 -->
            <el-button
              size="small"
              class="action-btn"
              :type="isFavorite ? 'warning' : undefined"
              :loading="favoriteLoading"
              @click="handleFavorite"
            >
              <el-icon><Star /></el-icon>
              {{ isFavorite ? '已收藏' : '收藏' }}
            </el-button>
            <!-- 试题栏 toggle -->
            <el-button
              size="small"
              class="action-btn action-btn--basket"
              :class="{ 'action-btn--basket-added': isInBasket }"
              :type="isInBasket ? undefined : 'primary'"
              :plain="!isInBasket"
              :loading="basketLoading"
              @click="handleBasketToggle"
            >
              <el-icon v-if="!isInBasket"><ShoppingCart /></el-icon>
              {{ isInBasket ? '取消' : '+ 试题栏' }}
            </el-button>
          </div>
        </div>

        <!-- 题干图 -->
        <div class="stem-area">
          <img
            v-if="question.stemImg"
            :src="question.stemImg"
            class="stem-img"
            alt="题干"
            referrerpolicy="no-referrer"
            @error="(e: Event) => ((e.target as HTMLImageElement).style.display='none')"
          />
          <p v-else-if="question.stemText" class="stem-text">{{ question.stemText }}</p>
          <p v-else class="stem-placeholder">（题干数据暂无）</p>
        </div>

        <!-- 来源行 + freeTags + 问AI（misikt 风格：来源 + 多个 freeTag 同一行）-->
        <div
          v-if="question.examPaperName || question.examYear || (question.freeTags && question.freeTags.length > 0)"
          class="source-row"
        >
          <span v-if="question.examPaperName" class="source-item">
            来源: {{ question.examPaperName }}{{ question.examYear ? ` · ${question.examYear}年` : '' }}
          </span>
          <span v-else-if="question.examYear" class="source-item">
            年份: {{ question.examYear }}
          </span>
          <!-- 自由标签 freeTags（X 卡 段③ + 用户验收轮 2 调整位置 → misikt 底部布局）-->
          <FreeTagList
            v-if="question.freeTags && question.freeTags.length > 0"
            :tags="question.freeTags"
            mode="detail"
            class="source-row-freetag"
          />
          <el-button
            size="small"
            link
            type="primary"
            class="ai-btn"
            @click="ElMessage.info('问AI功能开发中')"
          >
            <el-icon><ChatDotRound /></el-icon>问AI
          </el-button>
        </div>

        <!-- 收起/展开答案折叠区 -->
        <div class="collapse-section">
          <div class="collapse-header" @click="answerExpanded = !answerExpanded">
            <span class="collapse-label">{{ answerExpanded ? '收起答案' : '展开答案' }}</span>
            <span class="collapse-arrow" :class="{ 'expanded': answerExpanded }">▼</span>
          </div>
          <div v-if="answerExpanded" class="collapse-body">
            <div class="answer-label">【答案】</div>
            <img
              v-if="question.answerImg"
              :src="question.answerImg"
              class="answer-img"
              alt="答案"
              referrerpolicy="no-referrer"
              @error="(e: Event) => ((e.target as HTMLImageElement).style.display='none')"
            />
            <span v-else class="no-content">暂无答案图片</span>
          </div>
        </div>

        <!-- 展开解析折叠区 -->
        <div class="collapse-section">
          <div class="collapse-header" @click="explainExpanded = !explainExpanded">
            <span class="collapse-label">{{ explainExpanded ? '收起解析' : '展开解析' }}</span>
            <span class="collapse-arrow" :class="{ 'expanded': explainExpanded }">▼</span>
          </div>
          <div v-if="explainExpanded" class="collapse-body">
            <img
              v-if="question.explainImg"
              :src="question.explainImg"
              class="explain-img"
              alt="解析"
              referrerpolicy="no-referrer"
              @error="(e: Event) => ((e.target as HTMLImageElement).style.display='none')"
            />
            <span v-else class="no-content">暂无解析图片</span>
          </div>
        </div>

        <!-- 相似题推荐折叠区 -->
        <div class="collapse-section">
          <div
            class="collapse-header"
            @click="similarExpanded = !similarExpanded; loadSimilar()"
          >
            <span class="collapse-label">{{ similarExpanded ? '收起相似题' : '展开相似题推荐' }}</span>
            <span class="collapse-arrow" :class="{ 'expanded': similarExpanded }">▼</span>
          </div>
          <div v-if="similarExpanded" class="collapse-body">
            <div v-if="similarLoading" class="similar-loading">
              <el-skeleton :rows="3" animated />
            </div>
            <div v-else-if="similarQuestions.length === 0" class="no-content">
              暂无相似题（接口需登录态）
            </div>
            <div
              v-else
              v-for="sq in similarQuestions"
              :key="sq.id"
              class="similar-item"
            >
              <img
                v-if="sq.stemImg"
                :src="sq.stemImg"
                class="similar-img"
                alt="相似题"
                referrerpolicy="no-referrer"
              />
              <span v-else class="similar-text">{{ sq.stemText }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ══ 右侧 sidebar（30%）══ -->
      <div class="detail-sidebar">
        <!-- 我的备注 card -->
        <div class="sidebar-card">
          <div class="sidebar-card-header">
            <span class="sidebar-card-title">我的备注</span>
          </div>
          <div class="sidebar-card-body" v-loading="notesLoading">
            <div v-if="!note && !notesLoading" class="no-notes">
              还没有备注
            </div>
            <div
              v-else-if="note"
              class="note-item"
            >
              <span class="note-content">{{ note.content }}</span>
              <span class="note-time">{{ note.updateTime }}</span>
            </div>
            <!-- 添加备注 -->
            <div class="note-add">
              <el-input
                v-model="noteInput"
                type="textarea"
                :rows="2"
                placeholder="输入备注内容..."
                size="small"
              />
              <el-button
                type="primary"
                size="small"
                :loading="noteSaving"
                :disabled="!noteInput.trim()"
                class="note-save-btn"
                @click="saveNote"
              >
                <el-icon><Plus /></el-icon>添加
              </el-button>
            </div>
          </div>
        </div>

        <!-- 收录情况 card -->
        <div class="sidebar-card">
          <div class="sidebar-card-header">
            <span class="sidebar-card-title">收录情况</span>
            <el-tag type="info" size="small" round>{{ sources.length }}</el-tag>
          </div>
          <div class="sidebar-card-body" v-loading="sourcesLoading">
            <div v-if="sources.length === 0 && !sourcesLoading" class="no-content">
              暂无收录信息
            </div>
            <div
              v-else
              v-for="src in sources"
              :key="src.examPaperId"
              class="source-item-card"
              @click="goToPaperSource(src.examPaperId)"
            >
              <span class="source-paper-name">{{ src.examPaperName }}</span>
              <el-tag type="warning" size="small" class="source-tag">来源</el-tag>
              <span v-if="src.examYear" class="source-year">{{ src.examYear }}</span>
            </div>
          </div>
        </div>

        <!-- 题目报错 按钮 -->
        <div class="sidebar-card sidebar-card--report">
          <el-button
            type="warning"
            plain
            size="default"
            class="report-btn"
            @click="handleReport"
          >
            <el-icon><Warning /></el-icon>
            题目报错
          </el-button>
        </div>

        <!-- 题型信息 -->
        <div class="sidebar-card sidebar-card--info">
          <div class="info-item">
            <span class="info-label">题型</span>
            <span class="info-value">{{ getQuestionTypeLabel(question.questionType) }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">题目ID</span>
            <span class="info-value">{{ question.id }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">创建时间</span>
            <span class="info-value">{{ question.createTime || '—' }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail-page {
  min-height: 100vh;
  background: #f0f2f5;
  display: flex;
  flex-direction: column;
}

/* ── 顶部导航栏 ── */
.detail-topbar {
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

.topbar-title {
  font-size: 16px;
  font-weight: 600;
  color: #1d2129;
}

.detail-loading,
.detail-empty {
  padding: 40px 24px;
  display: flex;
  justify-content: center;
}

/* ── 主体布局（左70% + 右30%）── */
.detail-body {
  display: flex;
  gap: 16px;
  padding: 16px 24px;
  max-width: 1400px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  align-items: flex-start;
}

/* ── 左主体区 ── */
.detail-main {
  flex: 7;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ── 顶部 meta 行 ── */
.meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  background: #fff;
  border-radius: 10px;
  padding: 12px 16px;
  border: 1px solid #f2f3f5;
}

.meta-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  flex: 1;
}

.meta-label {
  font-size: 12px;
  color: #86909c;
  font-weight: 500;
}

.stars-row {
  display: flex;
  align-items: center;
  gap: 1px;
}

.star-icon {
  font-size: 15px;
  color: #e5e6eb;
}

.star-icon.star-active {
  color: #f7ba1e;
}

.knowledge-tag {
  flex-shrink: 0;
}

.knowledge-empty {
  font-size: 12px;
  color: #c9cdd4;
}

.source-row-freetag {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}

.meta-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.action-btn {
  font-size: 12px;
}

.action-btn--basket-added {
  color: #86909c !important;
  border-color: #86909c !important;
}

.action-btn--basket-added:hover {
  color: #f53f3f !important;
  border-color: #f53f3f !important;
}

/* ── 题干区 ── */
.stem-area {
  background: #fff;
  border-radius: 10px;
  padding: 20px;
  border: 1px solid #f2f3f5;
  min-height: 160px;
}

.stem-img {
  max-width: 100%;
  height: auto;
  display: block;
}

.stem-text {
  font-size: 15px;
  line-height: 1.7;
  color: #1d2129;
  white-space: pre-wrap;
}

.stem-placeholder {
  color: #c9cdd4;
  font-size: 14px;
}

/* ── 来源行 ── */
.source-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  background: #fff;
  border-radius: 10px;
  padding: 10px 16px;
  border: 1px solid #f2f3f5;
}

.source-item {
  font-size: 13px;
  color: #86909c;
}

.ai-btn {
  margin-left: auto;
  font-size: 13px;
}

/* ── 折叠区 ── */
.collapse-section {
  background: #fff;
  border-radius: 10px;
  border: 1px solid #f2f3f5;
  overflow: hidden;
}

.collapse-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}

.collapse-header:hover {
  background: #fafbfc;
}

.collapse-label {
  font-size: 14px;
  font-weight: 500;
  color: #4e5969;
}

.collapse-arrow {
  font-size: 12px;
  color: #c9cdd4;
  transition: transform 0.2s;
}

.collapse-arrow.expanded {
  transform: rotate(180deg);
}

.collapse-body {
  padding: 12px 16px 16px;
  border-top: 1px solid #f2f3f5;
}

.answer-label {
  font-size: 14px;
  font-weight: 600;
  color: #1d2129;
  margin-bottom: 8px;
}

.answer-img,
.explain-img {
  max-width: 100%;
  height: auto;
  display: block;
}

.no-content {
  font-size: 13px;
  color: #c9cdd4;
}

.similar-loading {
  padding: 8px 0;
}

.similar-item {
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px dashed #f2f3f5;
}

.similar-item:last-child {
  border-bottom: none;
  margin-bottom: 0;
}

.similar-img {
  max-width: 100%;
  height: auto;
}

.similar-text {
  font-size: 13px;
  color: #4e5969;
}

/* ── 右侧 sidebar ── */
.detail-sidebar {
  flex: 3;
  min-width: 240px;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sidebar-card {
  background: #fff;
  border-radius: 10px;
  border: 1px solid #f2f3f5;
  overflow: hidden;
}

.sidebar-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 10px;
  border-bottom: 1px solid #f2f3f5;
}

.sidebar-card-title {
  font-size: 14px;
  font-weight: 600;
  color: #1d2129;
}

.sidebar-card-body {
  padding: 12px 14px;
}

.no-notes {
  font-size: 13px;
  color: #c9cdd4;
  text-align: center;
  padding: 8px 0;
}

.note-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px dashed #f2f3f5;
}

.note-content {
  font-size: 13px;
  color: #1d2129;
  line-height: 1.5;
}

.note-time {
  font-size: 11px;
  color: #c9cdd4;
}

.note-add {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.note-save-btn {
  align-self: flex-end;
}

/* 收录情况 card */
.source-item-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid #f7f8fa;
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s;
  flex-wrap: wrap;
}

.source-item-card:hover {
  background: #f0f6ff;
  padding-left: 4px;
}

.source-item-card:last-child {
  border-bottom: none;
}

.source-paper-name {
  font-size: 13px;
  color: #1d2129;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-tag {
  flex-shrink: 0;
}

.source-year {
  font-size: 12px;
  color: #86909c;
  flex-shrink: 0;
}

/* 报错 card */
.sidebar-card--report {
  padding: 12px 14px;
  background: transparent;
  border: none;
}

.report-btn {
  width: 100%;
}

/* 题型信息 card */
.sidebar-card--info .sidebar-card-body {
  padding: 10px 14px;
}

.info-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 0;
  border-bottom: 1px solid #f7f8fa;
}

.info-item:last-child {
  border-bottom: none;
}

.info-label {
  font-size: 12px;
  color: #86909c;
}

.info-value {
  font-size: 12px;
  color: #4e5969;
  font-weight: 500;
}
</style>
