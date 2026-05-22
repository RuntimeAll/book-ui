<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, Plus, Check, View, ShoppingCart } from '@element-plus/icons-vue'
import {
  getPaperDetail,
  type PaperDetailVo,
  type PaperSectionVo,
  type PaperSourceQuestion,
} from '@/api/question/index'
import FreeTagList from '@/components/business/FreeTagList/index.vue'
import QuestionDetailDrawer from '@/components/business/QuestionDetailDrawer/index.vue'
import { useQuestionBasket } from '@/composables/useQuestionBasket'

// ── 路由 ────────────────────────────────────────────────────
const route = useRoute()
const router = useRouter()
const paperId = computed(() => route.params.id as string)

// ── 试题栏 composable（E 段③ — 全局 singleton，跟题库 / 全局 FAB 联动）──
const basket = useQuestionBasket()

// ── 错题栏 localStorage（保留 — PRD OOS-7，本卡不在共享范围）──
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

// ── 卷详情数据（E 段② BE 真接口 POST /teacher/exam/paper/detail） ──
const detail = ref<PaperDetailVo | null>(null)
const loading = ref(false)

// 所有题（flatten — 错题栏 / basket 操作遍历用）
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

// ── 详情抽屉 ──
const detailDrawerVisible = ref(false)
const detailDrawerQuestionId = ref<number | null>(null)
const detailDrawerQuestionData = ref<PaperSourceQuestion | null>(null)

function openDetailDrawer(q: PaperSourceQuestion) {
  detailDrawerQuestionId.value = q.id
  detailDrawerQuestionData.value = q
  detailDrawerVisible.value = true
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

          <!-- 题目卡片 -->
          <div
            v-for="q in section.questions"
            :key="q.id"
            class="source-question-card"
            :class="{
              'in-error-book': errorBookIds.has(q.id),
              'in-basket': basket.basketIds.value.has(q.id),
            }"
          >
            <!-- 题号行 + 操作按钮组 -->
            <div class="q-header-row">
              <div class="q-header-left">
                <span class="q-num">{{ q.sortNum ?? q.sort ?? '' }}.</span>
                <span class="q-type-tag" :class="`q-type--${getQuestionTypeTag(q.questionType)}`">
                  {{ getQuestionTypeLabel(q.questionType) }}
                </span>
                <span v-if="getQuestionScore(q) != null" class="q-score">
                  {{ getQuestionScore(q) }} 分
                </span>
              </div>

              <div class="q-header-actions">
                <!-- 详情按钮 -->
                <el-button
                  size="small"
                  type="primary"
                  plain
                  class="action-btn"
                  @click="openDetailDrawer(q)"
                >
                  <el-icon><View /></el-icon>
                  详情
                </el-button>

                <!-- 试题栏 toggle 按钮 -->
                <el-button
                  size="small"
                  class="action-btn"
                  :class="{ 'action-btn--basket-added': basket.basketIds.value.has(q.id) }"
                  :type="basket.basketIds.value.has(q.id) ? undefined : 'primary'"
                  :plain="!basket.basketIds.value.has(q.id)"
                  :loading="basket.isLoading(q.id)"
                  @click="handleBasketToggle(q)"
                >
                  <el-icon v-if="basket.basketIds.value.has(q.id)"><Check /></el-icon>
                  <el-icon v-else><ShoppingCart /></el-icon>
                  {{ basket.basketIds.value.has(q.id) ? '已在试题栏' : '+ 试题栏' }}
                </el-button>

                <!-- 错题栏（保留 — 不在 E 卡共享范围）-->
                <el-button
                  size="small"
                  class="action-btn error-book-btn"
                  :class="{ 'error-book-btn--added': errorBookIds.has(q.id) }"
                  :type="errorBookIds.has(q.id) ? 'warning' : undefined"
                  :plain="!errorBookIds.has(q.id)"
                  :loading="errorBookToggleLoading.has(q.id)"
                  @click="handleErrorBookToggle(q)"
                >
                  <el-icon v-if="errorBookIds.has(q.id)"><Check /></el-icon>
                  <el-icon v-else><Plus /></el-icon>
                  {{ errorBookIds.has(q.id) ? '已加错题栏' : '加入错题栏' }}
                </el-button>
              </div>
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
        </section>
      </div>
    </div>

    <!-- 题目详情抽屉（E 段③ 新加）-->
    <QuestionDetailDrawer
      :visible="detailDrawerVisible"
      :question-id="detailDrawerQuestionId"
      :question-data="detailDrawerQuestionData"
      @update:visible="(val: boolean) => (detailDrawerVisible = val)"
    />
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

.source-question-card.in-error-book {
  border-left: 3px solid #f7ba1e;
  background: #fffdf0;
}

.source-question-card.in-basket {
  border-left: 3px solid #34c38f;
  background: #f8fffe;
}

/* in-error-book 和 in-basket 同时存在时，basket 优先 */
.source-question-card.in-basket.in-error-book {
  border-left-color: #34c38f;
  background: #f8fffe;
}

/* ── 题号行 ── */
.q-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  gap: 8px;
  flex-wrap: wrap;
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

.q-score {
  font-size: 12px;
  color: #b45309;
  background: #fff7e6;
  padding: 2px 7px;
  border-radius: 4px;
  font-weight: 600;
}

/* ── 操作按钮组 ── */
.q-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.action-btn {
  border-radius: 5px;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  transition: all 0.2s ease;
}

/* 已加入试题栏 → 灰色态 + hover danger（跟 question/index.vue 一致风格） */
.action-btn--basket-added {
  color: #86909c !important;
  border-color: #c9cdd4 !important;
  background: #f7f8fa !important;
}

.action-btn--basket-added:hover {
  color: #f56c6c !important;
  border-color: #f56c6c !important;
  background: #fff5f5 !important;
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

/* ── 自由标签 freeTags ── */
.q-free-tags {
  margin-top: 8px;
}
</style>
