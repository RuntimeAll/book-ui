<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Search, Edit, Star, ShoppingCart, Document, Key } from '@element-plus/icons-vue'
import {
  lazyTree,
  questionPage,
  getFavorite,
  removeFavorite,
  type SubjectNode,
  type QuestionItem,
  type QuestionPageParams,
} from '@/api/question/index'
import { useRouter } from 'vue-router'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import FavoriteFolderDrawer from '@/components/FavoriteFolderDrawer/index.vue'
import ContentWrap from '@/components/ContentWrap/index.vue'
import SearchWrap from '@/components/SearchWrap/index.vue'
import Icon from '@/components/Icon/index.vue'
import FreeTagList from '@/components/business/FreeTagList/index.vue'

// ── 路由 ────────────────────────────────────────────────────
const router = useRouter()

// ── 试题栏（全局 singleton composable，FAB+dialog 由 AppLayout 挂的 <QuestionBasket /> 渲染） ──
const basket = useQuestionBasket()

// ── 教材选择（子任务 A）──────────────────────────────────────
// TODO: 待接 misikt 真接口端点 /teacher/textbook/list 或类似
// playwright 抓取结果：未登录状态无法抓到，hardcode 单选项
const TEXTBOOK_OPTIONS = [
  { label: '浙教新版', value: 'zhejiao-new' },
]
const selectedTextbook = ref('zhejiao-new')

// ── 章节树 filter（子任务 A）────────────────────────────────
const treeFilterKeyword = ref('')
const treeRef = ref()

function filterTreeNode(value: string, data: SubjectNode) {
  if (!value) return true
  return (data.title ?? '').includes(value)
}

watch(treeFilterKeyword, (val) => {
  treeRef.value?.filter(val)
})

// ── 章节树 ──────────────────────────────────────────────────
const treeData = ref<SubjectNode[]>([])
const treeLoading = ref(false)

async function loadTree() {
  treeLoading.value = true
  try {
    const result = await lazyTree(0)
    if (Array.isArray(result)) {
      treeData.value = result
    } else if (result && typeof result === 'object') {
      treeData.value = [result as unknown as SubjectNode]
    }
  } catch (e) {
    console.warn('[tree] lazyTree failed', e)
  } finally {
    treeLoading.value = false
  }
}

function handleNodeClick(data: SubjectNode) {
  pageParams.subjectId = data.id
  pageParams.pageIndex = 1
  fetchQuestions()
}

// ── 筛选条 ──────────────────────────────────────────────────
const QUESTION_TYPES = [
  { label: '全部题型', value: '' },
  { label: '选择题', value: 1 },
  { label: '填空题', value: 4 },
  { label: '简答题', value: 5 },
]

const DIFFICULTY_OPTIONS = [
  { label: '全部难度', value: '' },
  { label: '1星', value: 1 },
  { label: '2星', value: 2 },
  { label: '3星', value: 3 },
  { label: '4星', value: 4 },
]

const filter = reactive({
  questionType: '' as number | '',
  difficulty: '' as number | '',
  keyWord: '',
})

const searchLoading = ref(false)
const resetLoading = ref(false)

function onSearch() {
  pageParams.questionType = filter.questionType !== '' ? Number(filter.questionType) : undefined
  pageParams.difficult = filter.difficulty !== '' ? Number(filter.difficulty) : undefined
  pageParams.keyWord = filter.keyWord || undefined
  pageParams.pageIndex = 1
  fetchQuestions()
}

function onReset() {
  filter.questionType = ''
  filter.difficulty = ''
  filter.keyWord = ''
  pageParams.questionType = undefined
  pageParams.difficult = undefined
  pageParams.keyWord = undefined
  pageParams.subjectId = undefined
  pageParams.pageIndex = 1
  fetchQuestions()
}

function getQuestionTypeLabel(type: number): string {
  const map: Record<number, string> = { 1: '选择题', 4: '填空题', 5: '简答题' }
  return map[type] ?? `题型${type}`
}

function getQuestionTypeTag(type: number): 'success' | 'warning' | 'info' | 'primary' | 'danger' {
  const map: Record<number, 'primary' | 'success' | 'warning'> = { 1: 'primary', 4: 'success', 5: 'warning' }
  return map[type] ?? 'info'
}

// ── 题目列表 ─────────────────────────────────────────────────
const questions = ref<QuestionItem[]>([])
const listLoading = ref(false)
const total = ref(0)

const pageParams = reactive<QuestionPageParams>({
  pageIndex: 1,
  pageSize: 10,
  notTaskQuestion: 0,
  notUsedQuestion: 0,
})

// 空态文案动态切换（BUG-2 真修后，章节走 biz_question_knowledge JOIN 大多数节点有题；
// 仅极少叶子节点确实 0 题时显示这条）
const emptyDescription = computed(() => {
  if (pageParams.subjectId) return '该章节暂无题目'
  return '暂无题目，请尝试调整筛选条件'
})

async function fetchQuestions() {
  listLoading.value = true
  try {
    const result = await questionPage(pageParams)
    const res = result as unknown as Record<string, unknown>
    if (res && Array.isArray(res['list'])) {
      questions.value = res['list'] as QuestionItem[]
      total.value = (res['total'] as number) ?? 0
    } else if (Array.isArray(result)) {
      questions.value = result as unknown as QuestionItem[]
      total.value = (result as unknown as unknown[]).length
    } else {
      questions.value = []
      total.value = 0
    }
    loadFavoriteStatus()
  } catch (e) {
    console.warn('[questions] page failed', e)
    questions.value = []
  } finally {
    listLoading.value = false
  }
}

function handlePageChange(page: number) {
  pageParams.pageIndex = page
  fetchQuestions()
}

// ── 收藏状态 ─────────────────────────────────────────────────
const favoriteMap = reactive<Record<number, boolean>>({})

async function loadFavoriteStatus() {
  const ids = questions.value.map((q) => q.id)
  await Promise.allSettled(
    ids.map(async (id) => {
      try {
        const res = await getFavorite(id)
        if (typeof res === 'boolean') {
          favoriteMap[id] = res
        } else if (res && typeof res === 'object') {
          const r = res as Record<string, unknown>
          favoriteMap[id] = Boolean(r['favorite'] ?? r['isFavorite'] ?? false)
        }
      } catch {
        favoriteMap[id] = false
      }
    }),
  )
}

// ── 试题栏 toggle ────────────────────────────────────────────
// 通过 composable 完成 — 内部 togglingIds 防连点 + 乐观更新 + 持久化
async function handleBasketToggle(question: QuestionItem) {
  if (basket.isLoading(question.id)) return
  if (basket.basketIds.value.has(question.id)) {
    await basket.remove(question.id)
  } else {
    await basket.add(question)
  }
}

// ── 空壳按钮 ─────────────────────────────────────────────────
function handleDraft(q: QuestionItem) {
  ElMessage.info(`草稿功能开发中 (id: ${q.id})`)
}

const favoriteLoading = reactive<Set<number>>(new Set())

// ── 收藏抽屉（子任务 D）──────────────────────────────────────
// 未收藏 → 打开 FavoriteFolderDrawer 选择收藏目录
// 已收藏 → 直接调 removeFavorite（不弹抽屉）
const favDrawerVisible = ref(false)
const favDrawerQuestionId = ref<number>(0)

function handleFavorite(q: QuestionItem) {
  if (favoriteLoading.has(q.id)) return
  const isFav = favoriteMap[q.id]
  if (isFav) {
    // 已收藏 → 直接取消，不弹抽屉
    handleRemoveFavorite(q)
  } else {
    // 未收藏 → 打开抽屉选择收藏目录
    favDrawerQuestionId.value = q.id
    favDrawerVisible.value = true
  }
}

function handleRemoveFavorite(q: QuestionItem) {
  if (favoriteLoading.has(q.id)) return

  // 乐观更新：先更新本地状态 + toast，再异步调 API
  favoriteMap[q.id] = false
  ElMessage.success('已取消收藏')

  removeFavorite(q.id)
    .catch((e) => {
      console.warn('[favorite] removeFavorite API failed (local state already updated):', e)
    })
}

function handleFavDrawerSuccess(_folderId: number | string | undefined) {
  // 收藏抽屉内成功收藏 → 更新本地 favoriteMap
  if (favDrawerQuestionId.value) {
    favoriteMap[favDrawerQuestionId.value] = true
  }
}

function handleDetail(q: QuestionItem) {
  // 第十二波：改为独立页面路由，不再用 Drawer
  // 存 cache 供详情页兜底使用（接口 500 时从 localStorage 读）
  try {
    const cacheKey = 'book-ui:question-cache-by-id'
    const existing: Record<string, QuestionItem> = JSON.parse(localStorage.getItem(cacheKey) || '{}')
    existing[String(q.id)] = q
    localStorage.setItem(cacheKey, JSON.stringify(existing))
  } catch (e) {
    console.warn('[detail] cache write failed', e)
  }
  router.push(`/question/detail/${q.id}`)
}

// ── 初始化 ───────────────────────────────────────────────────
onMounted(async () => {
  await Promise.allSettled([loadTree(), fetchQuestions()])
})
</script>

<template>
  <div class="question-page">
    <el-container style="height: 100%; min-height: calc(100vh - 60px);">

      <!-- ══ 左侧目录树（子任务 A）- ContentWrap 包裹，sticky 280px ══ -->
      <el-aside width="280px" class="tree-aside">
        <ContentWrap title="题库目录" class="tree-content-wrap">
          <!-- 教材选择 dropdown -->
          <!-- TODO: 待接 /teacher/textbook/list 教材列表接口（playwright 未登录无法抓取，hardcode 占位） -->
          <el-select
            v-model="selectedTextbook"
            placeholder="选择教材"
            class="textbook-select"
            size="default"
          >
            <el-option
              v-for="opt in TEXTBOOK_OPTIONS"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>

          <!-- 关键字筛选 input -->
          <el-input
            v-model="treeFilterKeyword"
            placeholder="输入关键字筛选"
            clearable
            class="tree-filter-input"
            size="default"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>

          <!-- 章节树 -->
          <div v-if="treeLoading" class="tree-loading">
            <el-skeleton :rows="8" animated />
          </div>
          <el-tree
            v-else
            ref="treeRef"
            :data="treeData"
            :props="{ label: 'title', children: 'children' }"
            node-key="id"
            highlight-current
            :expand-on-click-node="false"
            :filter-node-method="filterTreeNode"
            @node-click="(data: SubjectNode) => handleNodeClick(data)"
            class="subject-tree"
          />
        </ContentWrap>
      </el-aside>

      <!-- ══ 右侧内容区 ══ -->
      <el-main class="content-main">

        <!-- 筛选条 — SearchWrap 真接入（替换原 filter-bar-inline）-->
        <SearchWrap
          :search-loading="searchLoading"
          :reset-loading="resetLoading"
          @search="onSearch"
          @reset="onReset"
        >
          <div class="filter-item">
            <span class="filter-label">题型</span>
            <el-select
              v-model="filter.questionType"
              placeholder="全部题型"
              clearable
              style="width: 120px;"
            >
              <el-option
                v-for="opt in QUESTION_TYPES"
                :key="String(opt.value)"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
          </div>

          <div class="filter-item">
            <span class="filter-label">难度</span>
            <el-select
              v-model="filter.difficulty"
              placeholder="全部难度"
              clearable
              style="width: 120px;"
            >
              <el-option
                v-for="opt in DIFFICULTY_OPTIONS"
                :key="String(opt.value)"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
          </div>

          <div class="filter-item">
            <span class="filter-label">关键词</span>
            <el-input
              v-model="filter.keyWord"
              placeholder="输入关键词"
              clearable
              style="width: 200px;"
              @keyup.enter="onSearch"
            >
              <template #prefix>
                <el-icon><Search /></el-icon>
              </template>
            </el-input>
          </div>
        </SearchWrap>

        <!-- 列表区标题栏 -->
        <div class="list-header">
          <div class="list-header-left">
            <span class="list-title">题目列表</span>
            <el-tag v-if="total > 0" type="info" size="small" round style="margin-left: 8px;">
              共 {{ total }} 题
            </el-tag>
          </div>
        </div>

        <!-- 题目列表 -->
        <div v-loading="listLoading" class="question-list">
          <el-empty
            v-if="!listLoading && questions.length === 0"
            :description="emptyDescription"
            class="empty-state"
          >
            <template #image>
              <el-icon style="font-size: 56px; color: #c9cdd4;"><Document /></el-icon>
            </template>
          </el-empty>

          <div
            v-for="q in questions"
            :key="q.id"
            class="question-card"
            :class="{ 'in-basket': basket.basketIds.value.has(q.id) }"
          >
            <!-- ══ 题卡片顶部 meta 行（子任务 F）══ -->
            <div class="card-meta-row">
              <!-- 左侧：题型 tag + 难度 4 星 + 知识点 label + 主知识点 tag -->
              <div class="card-meta-left">
                <span class="type-tag" :class="`type-tag--${getQuestionTypeTag(q.questionType)}`">
                  {{ getQuestionTypeLabel(q.questionType) }}
                </span>
                <span class="meta-sep">难度:</span>
                <el-rate
                  :model-value="q.difficult ?? 0"
                  :max="4"
                  disabled
                  class="meta-rate"
                />
                <span class="meta-sep">知识点:</span>
                <el-tag
                  v-if="q.questionKnowledges && q.questionKnowledges.length > 0"
                  type="primary"
                  size="small"
                  class="knowledge-primary-tag"
                >
                  {{ q.questionKnowledges[0].knowledgeName || q.questionKnowledges[0].knowledgeId }}
                </el-tag>
                <span v-else class="knowledge-empty">暂无</span>
              </div>

              <!-- 右侧：3 个 action button group -->
              <div class="card-meta-right">
                <el-button
                  size="small"
                  class="action-btn"
                  @click="handleDraft(q)"
                >
                  <el-icon><Edit /></el-icon>草稿
                </el-button>
                <el-button
                  size="small"
                  class="action-btn"
                  :type="favoriteMap[q.id] ? 'warning' : undefined"
                  :loading="favoriteLoading.has(q.id)"
                  @click="handleFavorite(q)"
                >
                  <el-icon><Star /></el-icon>
                  {{ favoriteMap[q.id] ? '已收藏' : '收藏' }}
                </el-button>
                <!-- 试题栏 toggle 按钮（子任务 C）：未加入=蓝色描边 / 已加入=灰色+hover danger -->
                <el-button
                  size="small"
                  class="action-btn action-btn--basket"
                  :class="{ 'action-btn--basket-added': basket.basketIds.value.has(q.id) }"
                  :type="basket.basketIds.value.has(q.id) ? undefined : 'primary'"
                  :plain="!basket.basketIds.value.has(q.id)"
                  :loading="basket.isLoading(q.id)"
                  @click="handleBasketToggle(q)"
                >
                  <el-icon v-if="!basket.basketIds.value.has(q.id)"><ShoppingCart /></el-icon>
                  {{ basket.basketIds.value.has(q.id) ? '取消' : '+ 试题栏' }}
                </el-button>
              </div>
            </div>

            <!-- 题号行（ID 小字）-->
            <div class="card-id-row">
              <el-icon :size="11" style="vertical-align: middle; color: #c9cdd4;"><Key /></el-icon>
              <span class="q-id-text">{{ q.id }}</span>
            </div>

            <!-- 题干图 / 文字 -->
            <div class="card-stem">
              <img
                v-if="q.stemImg"
                :src="q.stemImg"
                class="stem-img"
                loading="lazy"
                alt="题干"
                referrerpolicy="no-referrer"
                @error="(e: Event) => ((e.target as HTMLImageElement).style.display='none')"
              />
              <span v-else-if="q.stemText" class="stem-text">{{ q.stemText }}</span>
              <span v-else class="stem-placeholder">（题干加载中）</span>
            </div>

            <!-- ══ 底部 meta 行（misikt 风格：来源 + 底部知识点 + freeTags 同一行 / 右 详情 link）══ -->
            <div class="card-meta-bottom">
              <div class="card-meta-bottom-left">
                <span v-if="q.examPaperName" class="source-text">
                  来源: {{ q.examPaperName }}{{ q.examYear ? ` · ${q.examYear}年` : '' }}
                </span>
                <FreeTagList
                  v-if="q.freeTags && q.freeTags.length > 0"
                  :tags="q.freeTags"
                  mode="list"
                  class="bottom-freetag-list"
                />
              </div>
              <div class="card-meta-bottom-right">
                <el-button
                  size="small"
                  link
                  type="primary"
                  class="detail-link-btn"
                  @click="handleDetail(q)"
                >
                  <Icon icon="ep:view" :size="13" />
                  <span style="margin-left: 3px;">详情</span>
                </el-button>
              </div>
            </div>
          </div>
        </div>

        <!-- 分页器 -->
        <div class="pagination-wrap">
          <el-pagination
            v-model:current-page="pageParams.pageIndex"
            :page-size="pageParams.pageSize"
            :total="total"
            layout="total, prev, pager, next, jumper"
            background
            @current-change="handlePageChange"
          />
        </div>
      </el-main>
    </el-container>

    <!-- 收藏抽屉（子任务 D）— 未收藏时点⭐打开，选择收藏目录后调 addFavorite -->
    <FavoriteFolderDrawer
      v-model="favDrawerVisible"
      :question-id="favDrawerQuestionId"
      @success="handleFavDrawerSuccess"
    />
  </div>
</template>

<style scoped>
.question-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
}

/* ══ 左侧章节树 ══ */
.tree-aside {
  background: transparent;
  overflow-y: auto;
  padding: 12px 8px 12px 12px;
  position: sticky;
  top: 0;
  height: calc(100vh - 60px);
  flex-shrink: 0;
}

.tree-content-wrap {
  height: 100%;
}

.tree-content-wrap :deep(.el-card__body) {
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: calc(100% - 56px);
  overflow-y: auto;
}

.textbook-select {
  width: 100%;
}

.tree-filter-input {
  width: 100%;
}

.tree-loading {
  padding: 8px 0;
}

.subject-tree {
  flex: 1;
  overflow-y: auto;
}

:deep(.el-tree-node__content) {
  height: 36px;
  border-radius: 6px;
  transition: all 0.15s;
  margin: 1px 2px;
  padding-right: 8px;
}

:deep(.el-tree-node__content:hover) {
  background: rgba(64, 128, 255, 0.06);
}

:deep(.el-tree-node.is-current > .el-tree-node__content) {
  background: rgba(64, 128, 255, 0.1);
  color: #4080ff;
  font-weight: 600;
}

:deep(.el-tree-node__expand-icon) {
  transition: transform 0.2s ease;
}

/* ══ 右侧内容区 ══ */
.content-main {
  padding: 12px 20px 16px 8px;
  overflow-y: auto;
  background: #f0f2f5;
}

/* ── 筛选项样式 ── */
.filter-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.filter-label {
  font-size: 13px;
  color: #4e5969;
  white-space: nowrap;
  font-weight: 500;
}

/* ── 列表头部 ── */
.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  padding: 0 2px;
}

.list-header-left {
  display: flex;
  align-items: center;
}

.list-title {
  font-size: 14px;
  font-weight: 600;
  color: #1d2129;
}

/* ── 题目列表区 ── */
.question-list {
  min-height: 200px;
}

.empty-state {
  margin: 40px 0;
}

/* ══ 题卡片 ══ */
.question-card {
  background: #ffffff;
  border-radius: 10px;
  border: 1px solid #f2f3f5;
  padding: 14px 16px;
  margin-bottom: 10px;
  box-shadow: 0 2px 8px 0 rgba(64, 128, 255, 0.05);
  transition: all 0.2s ease;
  position: relative;
}

.question-card:hover {
  box-shadow: 0 6px 20px 0 rgba(64, 128, 255, 0.12);
  transform: translateY(-1px);
  border-color: #d0e2ff;
}

.question-card.in-basket {
  border-left: 3px solid #34c38f;
  background: #f8fffe;
}

/* ══ 题卡片顶部 meta 行（子任务 F）══ */
.card-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  flex-wrap: nowrap;
  gap: 8px;
}

.card-meta-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.meta-sep {
  font-size: 12px;
  color: #86909c;
  white-space: nowrap;
  flex-shrink: 0;
}

.meta-rate {
  display: inline-flex !important;
  vertical-align: middle;
  flex-shrink: 0;
}

:deep(.meta-rate .el-rate__icon) {
  font-size: 14px !important;
  margin-right: 1px;
}

.knowledge-primary-tag {
  flex-shrink: 0;
}

.knowledge-empty {
  font-size: 12px;
  color: #c9cdd4;
}

.card-meta-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

/* ── 题型 tag ── */
.type-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
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

/* ── 题号小字行 ── */
.card-id-row {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-bottom: 6px;
}

.q-id-text {
  font-size: 11px;
  color: #c9cdd4;
}

/* ── 题干 ── */
.card-stem {
  margin-bottom: 8px;
  min-height: 40px;
}

.stem-img {
  max-width: 100%;
  max-height: 220px;
  display: block;
  border-radius: 6px;
  background: #f8f9fa;
}

.stem-text {
  font-size: 14px;
  color: #1d2129;
  line-height: 1.7;
}

.stem-placeholder {
  font-size: 12px;
  color: #c9cdd4;
}

/* ── 底部 meta 行（misikt 风格：来源 + freeTags / 右 详情 link） ── */
.card-meta-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #f7f8fa;
  flex-wrap: wrap;
}

.card-meta-bottom-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}

.card-meta-bottom-right {
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

/* ── 操作按钮 ── */
.action-btn {
  border-radius: 5px;
  transition: all 0.2s ease;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.action-btn--basket {
  min-width: 80px;
}

/* 已加入试题栏 → 灰色态 + hover danger 描边（子任务 C）*/
.action-btn--basket-added {
  color: #86909c !important;
  border-color: #c9cdd4 !important;
  background: #f7f8fa !important;
  min-width: 60px;
  transition: all 0.2s ease;
}

.action-btn--basket-added:hover {
  color: #f56c6c !important;
  border-color: #f56c6c !important;
  background: #fff5f5 !important;
}

.detail-link-btn {
  font-size: 12px;
  display: inline-flex;
  align-items: center;
}

/* ── 分页 ── */
.pagination-wrap {
  margin-top: 20px;
  display: flex;
  justify-content: center;
  padding-bottom: 16px;
}
</style>
