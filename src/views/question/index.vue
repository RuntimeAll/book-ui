<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Search, Edit, Star, ShoppingCart, Refresh, Delete, DocumentAdd, Close, Menu, Key, Document, View } from '@element-plus/icons-vue'
import {
  lazyTree,
  questionPage,
  basketNum,
  addBasket,
  removeBasket,
  getFavorite,
  addFavorite,
  removeFavorite,
  genExamData,
  type SubjectNode,
  type QuestionItem,
  type QuestionPageParams,
} from '@/api/question/index'
import { useRouter } from 'vue-router'
import QuestionDetailDrawer from './QuestionDetailDrawer.vue'
import FavoriteFolderDrawer from '@/components/FavoriteFolderDrawer/index.vue'
import ContentWrap from '@/components/ContentWrap/index.vue'
import SearchWrap from '@/components/SearchWrap/index.vue'
import Icon from '@/components/Icon/index.vue'

// ── 路由 ────────────────────────────────────────────────────
const router = useRouter()

// ── localStorage 持久化 keys ─────────────────────────────────
const LS_BASKET_IDS = 'book-ui:basket-ids'
const LS_BASKET_CACHE = 'book-ui:basket-cache'

function readBasketIdsFromStorage(): Set<number> {
  try {
    const raw = localStorage.getItem(LS_BASKET_IDS)
    if (!raw) return new Set()
    const arr: number[] = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function writeBasketIdsToStorage(ids: Set<number>) {
  try {
    localStorage.setItem(LS_BASKET_IDS, JSON.stringify([...ids]))
  } catch (e) {
    console.warn('[basket] localStorage write ids failed', e)
  }
}

function readBasketCacheFromStorage(): Map<number, QuestionItem> {
  try {
    const raw = localStorage.getItem(LS_BASKET_CACHE)
    if (!raw) return new Map()
    const arr: [number, QuestionItem][] = JSON.parse(raw)
    return new Map(Array.isArray(arr) ? arr : [])
  } catch {
    return new Map()
  }
}

function writeBasketCacheToStorage(cache: Map<number, QuestionItem>) {
  try {
    localStorage.setItem(LS_BASKET_CACHE, JSON.stringify([...cache.entries()]))
  } catch (e) {
    console.warn('[basket] localStorage write cache failed', e)
  }
}

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
  pageParams.difficulty = filter.difficulty !== '' ? Number(filter.difficulty) : undefined
  pageParams.keyWord = filter.keyWord || undefined
  pageParams.pageIndex = 1
  fetchQuestions()
}

function onReset() {
  filter.questionType = ''
  filter.difficulty = ''
  filter.keyWord = ''
  pageParams.questionType = undefined
  pageParams.difficulty = undefined
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

// 全局题目缓存 map（id → QuestionItem）
const questionCache = reactive<Map<number, QuestionItem>>(readBasketCacheFromStorage())

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
    questions.value.forEach((q) => {
      questionCache.set(q.id, q)
    })
    syncCacheToStorage()
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

// ── 试题栏角标 ───────────────────────────────────────────────
const basketCount = ref(0)

async function loadBasketNum() {
  try {
    const res = await basketNum()
    if (typeof res === 'number') {
      basketCount.value = res
    } else if (res && typeof res === 'object') {
      const r = res as Record<string, unknown>
      basketCount.value = Number(r['count'] ?? r['basketNum'] ?? 0)
    }
  } catch (e) {
    console.warn('[basket] basketNum failed', e)
  }
}

const inBasketIds = ref<Set<number>>(readBasketIdsFromStorage())

function syncIdsToStorage() {
  writeBasketIdsToStorage(inBasketIds.value)
}

function syncCacheToStorage() {
  const basketCache = new Map<number, QuestionItem>()
  inBasketIds.value.forEach((id) => {
    const q = questionCache.get(id)
    if (q) basketCache.set(id, q)
  })
  writeBasketCacheToStorage(basketCache)
}

watch(
  inBasketIds,
  () => {
    syncIdsToStorage()
    syncCacheToStorage()
    basketCount.value = inBasketIds.value.size
  },
  { deep: true },
)

basketCount.value = inBasketIds.value.size

const basketItems = computed<QuestionItem[]>(() => {
  const items: QuestionItem[] = []
  inBasketIds.value.forEach((id) => {
    const q = questionCache.get(id)
    if (q) {
      items.push(q)
    } else {
      items.push({
        id,
        questionType: 1,
        difficult: null,
        stemImg: null,
        stemText: `题目 ID: ${id}（题干数据加载中）`,
      } as QuestionItem)
    }
  })
  return items
})

// ── 试题栏 toggle loading set（防连点）──────────────────────
const basketToggleLoading = reactive<Set<number>>(new Set())

async function handleBasketToggle(question: QuestionItem) {
  if (basketToggleLoading.has(question.id)) return
  basketToggleLoading.add(question.id)

  const isInBasket = inBasketIds.value.has(question.id)

  if (isInBasket) {
    // 已加入 → 移除
    const newSet = new Set(inBasketIds.value)
    newSet.delete(question.id)
    inBasketIds.value = newSet
    ElMessage.success('已从试题栏移除')

    // 调 removeBasket 接口（乐观更新，本地状态已先更新）
    // TODO: 端点 POST /teacher/question/removeBasket/{id} 待真实验证
    removeBasket(question.id)
      .then(() => loadBasketNum())
      .catch((e) => console.warn('[basket] removeBasket notify failed (local state OK):', e))
  } else {
    // 未加入 → 加入
    inBasketIds.value = new Set([...inBasketIds.value, question.id])
    if (!questionCache.has(question.id)) {
      questionCache.set(question.id, question)
    }
    ElMessage.success('已加入试题栏')

    addBasket(question.id)
      .then(() => loadBasketNum())
      .catch((e) => console.warn('[basket] addBasket notify failed (local state OK):', e))
  }

  basketToggleLoading.delete(question.id)
}

// 保留 handleRemoveBasket 供 dialog 内移除按钮使用
function handleRemoveBasket(id: number) {
  const newSet = new Set(inBasketIds.value)
  newSet.delete(id)
  inBasketIds.value = newSet
  ElMessage.success('已从试题栏移除')

  // 同步调 removeBasket 接口
  removeBasket(id)
    .then(() => loadBasketNum())
    .catch((e) => console.warn('[basket] removeBasket (dialog) notify failed:', e))
}

function handleClearBasket() {
  inBasketIds.value = new Set()
  writeBasketIdsToStorage(new Set())
  writeBasketCacheToStorage(new Map())
  ElMessage.success('已清空试题栏')
}

// ── 试题栏 dialog ────────────────────────────────────────────
const basketDialogVisible = ref(false)

function openBasketDialog() {
  basketDialogVisible.value = true
}

// 组卷
const composing = ref(false)

async function handleGoCompose() {
  if (basketItems.value.length === 0) {
    ElMessage.warning('试题栏为空，请先加题')
    return
  }
  composing.value = true
  try {
    let examData: unknown = null
    try {
      examData = await genExamData()
    } catch (e) {
      console.warn('[compose] genExamData failed, using local basket data', e)
    }

    const paperDraft = {
      questions: basketItems.value.map((q) => ({ ...q, score: 0 })),
      examData,
      createdAt: new Date().toISOString(),
    }
    localStorage.setItem('paperDraft', JSON.stringify(paperDraft))

    basketDialogVisible.value = false
    router.push('/papers/edit')
  } finally {
    composing.value = false
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
  currentQuestionId.value = q.id
  currentQuestionData.value = q
  detailDrawerVisible.value = true
}

// ── 题详情 drawer ─────────────────────────────────────────────
const detailDrawerVisible = ref(false)
const currentQuestionId = ref<number | null>(null)
const currentQuestionData = ref<QuestionItem | null>(null)

// ── 初始化 ───────────────────────────────────────────────────
onMounted(async () => {
  await Promise.allSettled([loadTree(), loadBasketNum(), fetchQuestions()])
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
            description="暂无题目，请尝试调整筛选条件"
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
            :class="{ 'in-basket': inBasketIds.has(q.id) }"
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
                  :class="{ 'action-btn--basket-added': inBasketIds.has(q.id) }"
                  :type="inBasketIds.has(q.id) ? undefined : 'primary'"
                  :plain="!inBasketIds.has(q.id)"
                  :loading="basketToggleLoading.has(q.id)"
                  @click="handleBasketToggle(q)"
                >
                  <el-icon v-if="!inBasketIds.has(q.id)"><ShoppingCart /></el-icon>
                  {{ inBasketIds.has(q.id) ? '取消' : '+ 试题栏' }}
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

            <!-- 来源行（灰色小字）-->
            <div v-if="q.examPaperName || q.examYear" class="card-source-row">
              <span v-if="q.examPaperName" class="source-text">来源: {{ q.examPaperName }}</span>
              <span v-if="q.examYear" class="source-text">年份: {{ q.examYear }}</span>
            </div>

            <!-- 底部知识点彩色 tag 行（子任务 E）：展示全部 questionKnowledges，多色轮换 -->
            <div
              v-if="q.questionKnowledges && q.questionKnowledges.length > 0"
              class="card-knowledge-tags-row"
            >
              <el-tag
                v-for="(k, idx) in q.questionKnowledges"
                :key="k.knowledgeId || idx"
                :type="(['success', 'primary', 'warning', 'danger', 'info'] as const)[idx % 5]"
                size="small"
                class="knowledge-bottom-tag"
              >
                {{ k.knowledgeName || k.knowledgeId }}
              </el-tag>
            </div>

            <!-- 卡片底部操作行（详情按钮）-->
            <div class="card-footer-row">
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

    <!-- ── FAB 试题栏浮动按钮 ── -->
    <div class="basket-fab" :class="{ 'has-items': basketCount > 0 }" @click="openBasketDialog">
      <el-badge :value="basketCount > 99 ? '99+' : basketCount" :hidden="basketCount === 0" type="danger">
        <div class="fab-inner">
          <el-icon :size="20" color="#fff"><ShoppingCart /></el-icon>
          <span class="fab-label">试题栏</span>
        </div>
      </el-badge>
    </div>

    <!-- ======= 试题栏 dialog ======= -->
    <el-dialog
      v-model="basketDialogVisible"
      width="75%"
      :close-on-click-modal="false"
      class="basket-dialog"
    >
      <template #header>
        <div class="basket-dialog-header">
          <div class="basket-dialog-title-area">
            <el-icon color="#4080ff" :size="18"><ShoppingCart /></el-icon>
            <span class="basket-dialog-title">试题栏</span>
            <el-tag type="primary" size="small" round>{{ basketItems.length }} 题</el-tag>
          </div>
          <div class="basket-dialog-actions">
            <el-button size="small" @click="handleClearBasket">
              <el-icon><Delete /></el-icon>清空
            </el-button>
            <el-button
              type="primary"
              size="small"
              :loading="composing"
              :disabled="basketItems.length === 0"
              class="compose-btn"
              @click="handleGoCompose"
            >
              <el-icon><DocumentAdd /></el-icon>
              组卷
            </el-button>
          </div>
        </div>
      </template>

      <div class="basket-dialog-body">
        <el-empty
          v-if="basketItems.length === 0"
          description="试题栏为空，请先在题库中加题"
        >
          <template #image>
            <el-icon style="font-size: 48px; color: #c9cdd4;"><ShoppingCart /></el-icon>
          </template>
        </el-empty>
        <el-scrollbar max-height="460px">
          <div
            v-for="item in basketItems"
            :key="item.id"
            class="basket-item"
          >
            <div class="basket-item-header">
              <span class="type-tag" :class="`type-tag--${getQuestionTypeTag(item.questionType)}`">
                {{ getQuestionTypeLabel(item.questionType) }}
              </span>
              <el-rate
                :model-value="item.difficult ?? 0"
                :max="4"
                disabled
                style="display:inline-flex; margin-left:8px;"
              />
              <div class="basket-knowledge-tags" v-if="(item.questionKnowledges?.length ?? 0) > 0">
                <el-tag
                  v-for="(k, i) in item.questionKnowledges"
                  :key="i"
                  type="info"
                  size="small"
                  style="margin-left: 4px;"
                >
                  {{ k.knowledgeName || k.knowledgeId }}
                </el-tag>
              </div>
              <div class="basket-item-ops">
                <el-button
                  size="small"
                  @click="ElMessage.info('展开解析功能开发中')"
                >
                  展开解析
                </el-button>
                <el-button
                  size="small"
                  type="danger"
                  plain
                  @click="handleRemoveBasket(item.id)"
                >
                  <el-icon><Close /></el-icon>取消
                </el-button>
              </div>
            </div>
            <div class="basket-item-stem">
              <img
                v-if="item.stemImg"
                :src="item.stemImg"
                class="stem-img-small"
                loading="lazy"
                alt="题干"
                @error="(e: Event) => ((e.target as HTMLImageElement).style.display='none')"
              />
              <span v-else-if="item.stemText" class="basket-stem-text">{{ item.stemText }}</span>
              <span v-else class="stem-placeholder">题 ID: {{ item.id }}</span>
            </div>
          </div>
        </el-scrollbar>
      </div>

      <template #footer>
        <div class="basket-footer">
          <el-button @click="basketDialogVisible = false">关闭</el-button>
          <el-button
            type="primary"
            :loading="composing"
            :disabled="basketItems.length === 0"
            class="compose-btn-footer"
            @click="handleGoCompose"
          >
            <el-icon><DocumentAdd /></el-icon>
            组卷（{{ basketItems.length }} 题）
          </el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 题详情 drawer -->
    <QuestionDetailDrawer
      v-model:visible="detailDrawerVisible"
      :question-id="currentQuestionId"
      :question-data="currentQuestionData"
    />

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

/* ── 来源行 ── */
.card-source-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.source-text {
  font-size: 12px;
  color: #86909c;
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

/* ── 底部知识点彩色 tag 行（子任务 E）── */
.card-knowledge-tags-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
  margin-top: 2px;
}

.knowledge-bottom-tag {
  cursor: default;
  transition: background 0.18s ease, box-shadow 0.18s ease;
  border-radius: 4px;
}

.knowledge-bottom-tag:hover {
  filter: brightness(0.94);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
}

/* ── 卡片底部行（详情按钮）── */
.card-footer-row {
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid #f7f8fa;
  padding-top: 8px;
  margin-top: 4px;
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

/* ── FAB 浮动按钮 ── */
.basket-fab {
  position: fixed;
  bottom: 40px;
  right: 40px;
  z-index: 200;
  cursor: pointer;
}

.fab-inner {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: linear-gradient(135deg, #4080ff, #3370e8);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  box-shadow: 0 8px 24px rgba(64, 128, 255, 0.4);
  transition: all 0.25s ease;
}

.basket-fab:hover .fab-inner {
  transform: translateY(-3px);
  box-shadow: 0 12px 32px rgba(64, 128, 255, 0.5);
}

.fab-label {
  font-size: 11px;
  color: #fff;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.basket-fab.has-items .fab-inner {
  animation: fab-pulse 2s infinite;
}

@keyframes fab-pulse {
  0%, 100% { box-shadow: 0 8px 24px rgba(64, 128, 255, 0.4); }
  50% { box-shadow: 0 8px 30px rgba(64, 128, 255, 0.6); }
}

/* ── 试题栏 dialog ── */
.basket-dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-right: 32px;
}

.basket-dialog-title-area {
  display: flex;
  align-items: center;
  gap: 8px;
}

.basket-dialog-title {
  font-size: 16px;
  font-weight: 700;
  color: #1d2129;
}

.basket-dialog-actions {
  display: flex;
  gap: 8px;
}

.compose-btn {
  background: linear-gradient(135deg, #4080ff, #3370e8);
  border: none;
  box-shadow: 0 2px 6px rgba(64, 128, 255, 0.3);
}

.basket-dialog-body {
  min-height: 100px;
  padding: 0 4px;
}

.basket-item {
  padding: 14px 0;
  border-bottom: 1px solid #f2f3f5;
}

.basket-item:last-child {
  border-bottom: none;
}

.basket-item-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.basket-knowledge-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.basket-item-ops {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.basket-item-stem {
  font-size: 13px;
  color: #303133;
  padding-left: 2px;
}

.stem-img-small {
  max-width: 100%;
  max-height: 120px;
  display: block;
  border-radius: 4px;
}

.basket-stem-text {
  font-size: 13px;
  color: #1d2129;
  line-height: 1.5;
}

.basket-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.compose-btn-footer {
  background: linear-gradient(135deg, #4080ff, #3370e8);
  border: none;
  box-shadow: 0 2px 6px rgba(64, 128, 255, 0.3);
  transition: all 0.2s;
}

.compose-btn-footer:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(64, 128, 255, 0.45);
}
</style>
