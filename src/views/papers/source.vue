<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, Check, View, ShoppingCart, Edit, Star, InfoFilled } from '@element-plus/icons-vue'
import {
  getPaperDetail,
  type PaperDetailVo,
  type PaperSectionVo,
  type PaperSourceQuestion,
} from '@/api/question/index'
import FreeTagList from '@/components/business/FreeTagList/index.vue'
import { useQuestionBasket } from '@/composables/useQuestionBasket'

// ── 路由 ────────────────────────────────────────────────────
const route = useRoute()
const router = useRouter()
const paperId = computed(() => route.params.id as string)

// ── 试题栏 composable（E 段③ — 全局 singleton，跟题库 / 全局 FAB 联动）──
const basket = useQuestionBasket()

// ── 卷详情数据（E 段② BE 真接口 POST /teacher/exam/paper/detail） ──
const detail = ref<PaperDetailVo | null>(null)
const loading = ref(false)

// 所有题（flatten — 空状态判断 + basket 操作遍历用）
const allQuestions = computed<PaperSourceQuestion[]>(() => {
  if (!detail.value || !Array.isArray(detail.value.sections)) return []
  return detail.value.sections.flatMap((s) => s.questions || [])
})

async function loadPaperDetail() {
  loading.value = true
  detail.value = null
  try {
    const res = await getPaperDetail(paperId.value)
    // BE 真响应：response 内层 = PaperDetailVo（advice 解包后 request.post 拿到的）
    if (res && (res as { paperId?: unknown }).paperId) {
      detail.value = res as PaperDetailVo
    } else {
      detail.value = null
      ElMessage.warning('试卷数据加载失败：响应为空')
    }
  } catch (e) {
    console.warn('[paper-detail] POST /teacher/exam/paper/detail failed', e)
    detail.value = null
    ElMessage.warning('试卷数据加载失败（接口需登录态）')
  } finally {
    loading.value = false
  }
}

// ── 中文大题序号（一/二/三/四…）──
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
function sectionLabel(index: number): string {
  return CN_NUM[index] ?? String(index + 1)
}

// 单 section 总分
function sectionTotalScore(section: PaperSectionVo): number {
  if (!section.questions) return 0
  const sum = section.questions.reduce(
    (acc, q) => acc + (Number(q.pqScore ?? q.score ?? 0) || 0),
    0,
  )
  // 去掉小数尾巴（30.0 → 30）
  return Math.round(sum * 100) / 100
}

// 题分（优先 pqScore，没有用 score）
function getQuestionScore(q: PaperSourceQuestion): number | null {
  const s = q.pqScore ?? q.score
  return s == null ? null : Number(s)
}

// ── 题型 ──
function getQuestionTypeLabel(type: number): string {
  const map: Record<number, string> = { 1: '选择题', 4: '填空题', 5: '简答题' }
  return map[type] ?? `题型${type}`
}

function getQuestionTypeTag(type: number): 'success' | 'warning' | 'info' | 'primary' | 'danger' {
  const map: Record<number, 'primary' | 'success' | 'warning'> = { 1: 'primary', 4: 'success', 5: 'warning' }
  return map[type] ?? 'info'
}

// ── 详情按钮 — 路由跳详情独立页（跟题库 question/index.vue:257-269 一致）──
function handleDetail(q: PaperSourceQuestion) {
  // 存 cache 供详情页兜底（接口 500 时从 localStorage 读）
  try {
    const cacheKey = 'book-ui:question-cache-by-id'
    const existing = JSON.parse(localStorage.getItem(cacheKey) || '{}')
    existing[String(q.id)] = q
    localStorage.setItem(cacheKey, JSON.stringify(existing))
  } catch (e) {
    console.warn('[paper-source] detail cache write failed', e)
  }
  router.push(`/question/detail/${q.id}`)
}

// ── 试题栏 toggle ──
async function handleBasketToggle(q: PaperSourceQuestion) {
  if (basket.isLoading(q.id)) return
  if (basket.basketIds.value.has(q.id)) {
    await basket.remove(q.id)
  } else {
    await basket.add(q)
  }
}

// ── 草稿 / 收藏 placeholder（misikt 风格题块顶部右侧）──
function handleDraft() {
  ElMessage.info('草稿功能开发中')
}
function handleFavorite() {
  ElMessage.info('收藏功能开发中')
}

function goBack() {
  router.back()
}

onMounted(() => {
  loadPaperDetail()
})
</script>

<template>
  <div class="source-page">
    <!-- 顶部导航栏 -->
    <div class="source-topbar">
      <el-button link class="back-btn" @click="goBack">
        <el-icon><ArrowLeft /></el-icon>
        <span>返回</span>
      </el-button>
      <div class="topbar-info">
        <span class="topbar-title">{{ detail?.paperName || '原卷预览' }}</span>
        <el-tag v-if="detail?.examYear" type="info" size="small">{{ detail.examYear }}</el-tag>
      </div>
    </div>

    <!-- 内容区 -->
    <div class="source-body">
      <div v-if="loading" class="source-loading">
        <el-skeleton :rows="12" animated style="max-width: 900px; margin: 0 auto;" />
      </div>

      <div v-else-if="!detail || allQuestions.length === 0" class="source-empty">
        <el-empty description="暂无题目数据（接口需登录态 / 试卷不存在）">
          <el-button type="primary" @click="goBack">返回</el-button>
        </el-empty>
      </div>

      <div v-else class="question-list">
        <!-- ══ 卷头区 ══ -->
        <div class="paper-header">
          <h2 class="paper-title">{{ detail.paperName }}</h2>
          <div class="paper-meta">
            <span v-if="detail.examYear" class="meta-chip meta-chip--year">{{ detail.examYear }}年</span>
            <span class="meta-chip">总分 <strong>{{ detail.score }}</strong></span>
            <span class="meta-chip">时长 <strong>{{ detail.suggestTime }}</strong> 分钟</span>
            <span class="meta-chip">共 <strong>{{ detail.questionCount }}</strong> 题</span>
          </div>
        </div>

        <!-- ══ 大题分组区 ══ -->
        <section
          v-for="(section, sIdx) in detail.sections"
          :key="section.sectionId"
          class="paper-section"
        >
          <!-- 大题标题 -->
          <h3 class="section-title">
            {{ sectionLabel(sIdx) }}、{{ section.title }}
            <span class="section-sub">（共 {{ section.questions?.length ?? 0 }} 题，共 {{ sectionTotalScore(section) }} 分）</span>
          </h3>

          <!-- 题目卡片 — misikt 风格：顶 meta + 题干 + 底 meta -->
          <div
            v-for="q in section.questions"
            :key="q.id"
            class="source-question-card"
            :class="{ 'in-basket': basket.basketIds.value.has(q.id) }"
          >
            <!-- ══ 顶部 meta 行：难度 + 知识点 + (右) 草稿/收藏/+试题栏 ══ -->
            <div class="q-meta-top">
              <div class="q-meta-top-left">
                <span class="meta-label">难度:</span>
                <el-rate
                  :model-value="q.difficult ?? 0"
                  :max="4"
                  disabled
                  class="meta-rate"
                />
                <span class="meta-label">知识点:</span>
                <el-tag
                  v-if="q.questionKnowledges && q.questionKnowledges.length > 0"
                  type="primary"
                  size="small"
                  class="primary-knowledge-tag"
                >
                  {{ q.questionKnowledges[0].knowledgeName || q.questionKnowledges[0].knowledgeId }}
                </el-tag>
                <span v-else class="knowledge-empty">暂无</span>
              </div>
              <div class="q-meta-top-right">
                <el-button size="small" link class="action-icon-btn" @click="handleDraft">
                  <el-icon><Edit /></el-icon>草稿
                </el-button>
                <el-button size="small" link class="action-icon-btn" @click="handleFavorite">
                  <el-icon><Star /></el-icon>
                </el-button>
                <el-button
                  size="small"
                  class="action-basket-btn"
                  :class="{ 'action-basket-btn--added': basket.basketIds.value.has(q.id) }"
                  :type="basket.basketIds.value.has(q.id) ? undefined : 'primary'"
                  :plain="!basket.basketIds.value.has(q.id)"
                  :loading="basket.isLoading(q.id)"
                  @click="handleBasketToggle(q)"
                >
                  <el-icon v-if="basket.basketIds.value.has(q.id)"><Check /></el-icon>
                  <el-icon v-else><ShoppingCart /></el-icon>
                  {{ basket.basketIds.value.has(q.id) ? '已在试题栏' : '+ 试题栏' }}
                </el-button>
              </div>
            </div>

            <!-- ══ 题干区（题号 + 类型 + 分 + 题干图/文）══ -->
            <div class="q-stem-area">
              <div class="q-stem-header">
                <span class="q-num">{{ q.sortNum ?? q.sort ?? '' }}.</span>
                <span class="q-type-tag" :class="`q-type--${getQuestionTypeTag(q.questionType)}`">
                  {{ getQuestionTypeLabel(q.questionType) }}
                </span>
                <span v-if="getQuestionScore(q) != null" class="q-score">
                  {{ getQuestionScore(q) }} 分
                </span>
              </div>
              <div class="q-stem-body">
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
            </div>

            <!-- ══ 底部 meta 行：来源 + freeTags + (右) 详情 link ══ -->
            <div class="q-meta-bottom">
              <div class="q-meta-bottom-left">
                <span v-if="q.examPaperName" class="source-text">
                  来源: {{ q.examPaperName }}{{ q.examYear ? ` · ${q.examYear}年` : '' }}
                </span>
                <FreeTagList
                  v-if="q.freeTags && q.freeTags.length > 0"
                  :tags="q.freeTags"
                  mode="detail"
                  class="bottom-freetag-list"
                />
              </div>
              <div class="q-meta-bottom-right">
                <el-button
                  size="small"
                  link
                  type="primary"
                  class="detail-link-btn"
                  @click="handleDetail(q)"
                >
                  <el-icon><InfoFilled /></el-icon>
                  详情
                </el-button>
              </div>
            </div>
          </div>
        </section>
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

/* ── 卷头 ── */
.paper-header {
  background: #fff;
  border-radius: 10px;
  padding: 22px 24px;
  margin-bottom: 14px;
  border: 1px solid #f2f3f5;
  text-align: center;
}

.paper-title {
  font-size: 22px;
  font-weight: 700;
  color: #1d2129;
  margin: 0 0 12px;
  line-height: 1.4;
}

.paper-meta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #4e5969;
}

.meta-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: #f2f3f5;
  border-radius: 14px;
  color: #4e5969;
}

.meta-chip strong {
  color: #1d2129;
  font-weight: 600;
}

.meta-chip--year {
  background: #e8f0ff;
  color: #3564d0;
  font-weight: 500;
}

/* ── 大题分组 ── */
.paper-section {
  margin-bottom: 18px;
}

.section-title {
  font-size: 16px;
  font-weight: 700;
  color: #1d2129;
  margin: 0 0 10px;
  padding: 10px 14px;
  background: #fff;
  border-left: 4px solid #4080ff;
  border-radius: 4px;
  border: 1px solid #f2f3f5;
  border-left-width: 4px;
}

.section-sub {
  font-size: 13px;
  font-weight: 400;
  color: #86909c;
  margin-left: 4px;
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

.source-question-card.in-basket {
  border-left: 3px solid #34c38f;
  background: #f8fffe;
}

/* ── 顶部 meta 行（misikt 风格：左 难度+知识点 / 右 草稿+收藏+试题栏） ── */
.q-meta-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 10px;
  border-bottom: 1px solid #f7f8fa;
}

.q-meta-top-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.q-meta-top-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.meta-label {
  font-size: 12px;
  color: #86909c;
  font-weight: 500;
}

.meta-rate {
  height: 18px;
}

:deep(.meta-rate .el-rate__item) {
  font-size: 15px;
}

.primary-knowledge-tag {
  font-size: 12px;
}

.knowledge-empty {
  font-size: 12px;
  color: #c9cdd4;
}

.action-icon-btn {
  font-size: 13px;
  color: #4e5969;
  padding: 0 4px;
  gap: 2px;
}

.action-icon-btn:hover {
  color: #4080ff;
}

.action-basket-btn {
  border-radius: 5px;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  transition: all 0.2s ease;
}

.action-basket-btn--added {
  color: #86909c !important;
  border-color: #c9cdd4 !important;
  background: #f7f8fa !important;
}

.action-basket-btn--added:hover {
  color: #f56c6c !important;
  border-color: #f56c6c !important;
  background: #fff5f5 !important;
}

/* ── 题干区（题号融入 stem-header）── */
.q-stem-area {
  min-height: 80px;
}

.q-stem-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
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

.q-score {
  font-size: 12px;
  color: #b45309;
  background: #fff7e6;
  padding: 2px 7px;
  border-radius: 4px;
  font-weight: 600;
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

/* ── 底部 meta 行（misikt 风格：左 来源+freeTags / 右 详情 link） ── */
.q-meta-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #f7f8fa;
  flex-wrap: wrap;
}

.q-meta-bottom-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}

.q-meta-bottom-right {
  flex-shrink: 0;
}

.source-text {
  font-size: 12px;
  color: #86909c;
}

.bottom-freetag-list {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}

.detail-link-btn {
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
</style>
