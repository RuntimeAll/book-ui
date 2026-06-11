<script setup lang="ts">
// PRD-C-009「我的题库」：克隆 views/question/index.vue，功能/样式一致，
// 唯一差异 = pageParams 恒带 mine:true（owner 由后端 LoginHelper 定）+ 进入默认无 subject 过滤
// （老师自己的题跨多章节，默认选首节点会几乎空 → 改为先全量展示自己的题，点树仍可过滤）。
// 血缘展示（母题关系等）暂不做（QuestionCard 列表本就不展示血缘，无需额外隐藏）。
import { ref, reactive, onMounted, computed, watch, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { Search, Document } from '@element-plus/icons-vue'
import {
  lazyTree,
  questionPage,
  removeFavorite,
  type SubjectNode,
  type QuestionItem,
  type QuestionPageParams,
  type QuestionPageResult,
} from '@/api/question/index'
import { useRouter } from 'vue-router'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import { useAbortableRequest } from '@/composables/useAbortableRequest'
import FavoriteFolderDrawer from '@/components/FavoriteFolderDrawer/index.vue'
import ContentWrap from '@/components/ContentWrap/index.vue'
import SearchWrap from '@/components/SearchWrap/index.vue'
import QuestionCard from '@/components/business/QuestionCard/index.vue'
import SketchPad from '@/components/business/SketchPad/index.vue'
import FontSizeSwitch from '@/components/business/FontSizeSwitch/index.vue'
import { useFontScale } from '@/composables/useFontScale'

// ── 路由 ────────────────────────────────────────────────────
const router = useRouter()

// 题面展示字号（小/中/大）—— 与变式编辑器/详情页共用同一状态，注入 --md-font-size 级联给列表卡
const { cssVars: fontVars } = useFontScale()

// ── 试题栏（全局 singleton composable，FAB+dialog 由 AppLayout 挂的 <QuestionBasket /> 渲染） ──
const basket = useQuestionBasket()

// ── 教材选择 ──────────────────────────────────────────────────
const TEXTBOOK_OPTIONS = [
  { label: '浙教新版', value: 'zhejiao-new' },
]
const selectedTextbook = ref('zhejiao-new')

// ── 章节树 filter ───────────────────────────────────────────
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
    // 🔴 我的题库与题库页不同：不默认选首节点（老师的题跨章节，默认选首节点会几乎空）。
    // 树仅作可选过滤器；首屏由 onMounted 直接 fetchQuestions（mine:true 全量自己的题）。
  } catch (e) {
    console.warn('[my-question][tree] lazyTree failed', e)
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
  // 树高亮一并清掉，回到「全部自己的题」语义
  treeRef.value?.setCurrentKey(null)
  fetchQuestions()
}

// ── 题目列表 ─────────────────────────────────────────────────
const questions = ref<QuestionItem[]>([])
const listLoading = ref(false)
const total = ref(0)

// 🔴 mine:true 恒带 —— owner 由后端 LoginHelper 定，前端只传开关。
const pageParams = reactive<QuestionPageParams>({
  pageIndex: 1,
  pageSize: 10,
  notTaskQuestion: 0,
  notUsedQuestion: 0,
  mine: true,
})

const { run: runAbortable } = useAbortableRequest<QuestionPageResult>()

const emptyDescription = computed(() => {
  if (pageParams.subjectId) return '该章节下你还没有题目'
  return '你还没有自己的题目，去「举一反三」生成一组试试'
})

async function fetchQuestions() {
  listLoading.value = true
  try {
    const result = await runAbortable((signal) => questionPage(pageParams, { signal }))
    if (result === null) {
      return
    }
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
  } catch (e) {
    console.warn('[my-question] page failed', e)
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
function setQuestionFavorite(qid: string, fav: boolean) {
  const q = questions.value.find((it) => it.id === qid)
  if (q) q.isFavorite = fav
}

// ── 试题栏 toggle ────────────────────────────────────────────
async function handleBasketToggle(question: QuestionItem) {
  if (basket.isLoading(question.id)) return
  if (basket.basketIds.value.has(question.id)) {
    await basket.remove(question.id)
  } else {
    await basket.add(question)
  }
}

// ── 草稿纸 ──────────────────────────────────────────────────
const sketchVisible = ref(false)

function handleDraft(_q: QuestionItem) {
  sketchVisible.value = true
}

const favoriteLoading = reactive<Set<string>>(new Set())

// ── 收藏抽屉 ──────────────────────────────────────────────────
const favDrawerVisible = ref(false)
const favDrawerQuestionId = ref<string>('')

function handleFavorite(q: QuestionItem) {
  if (favoriteLoading.has(q.id)) return
  if (q.isFavorite) {
    handleRemoveFavorite(q)
  } else {
    favDrawerQuestionId.value = q.id
    favDrawerVisible.value = true
  }
}

function handleRemoveFavorite(q: QuestionItem) {
  if (favoriteLoading.has(q.id)) return
  setQuestionFavorite(q.id, false)
  ElMessage.success('已取消收藏')
  removeFavorite(q.id).catch((e) => {
    console.warn('[favorite] removeFavorite API failed (local state already updated):', e)
  })
}

function handleFavDrawerSuccess(_folderId: string | undefined) {
  if (favDrawerQuestionId.value) {
    setQuestionFavorite(favDrawerQuestionId.value, true)
  }
}

function handleDetail(q: QuestionItem) {
  // 复用题库详情页（血缘展示在详情页，列表页不展示）
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
// 🔴 与题库页不同：并行加载树 + 首屏直接拉「全部自己的题」（mine:true，无 subject 过滤）。
onMounted(async () => {
  loadTree()
  await nextTick()
  fetchQuestions()
})
</script>

<template>
  <div class="question-page" :style="fontVars">
    <el-container style="height: 100%; min-height: calc(100vh - 60px);">

      <!-- ══ 左侧目录树（可选过滤器，默认不选） ══ -->
      <el-aside width="280px" class="tree-aside">
        <ContentWrap title="题库目录" class="tree-content-wrap">
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

        <div class="list-header">
          <div class="list-header-left">
            <span class="list-title">我的题目</span>
            <el-tag v-if="total > 0" type="info" size="small" round style="margin-left: 8px;">
              共 {{ total }} 题
            </el-tag>
          </div>
          <FontSizeSwitch />
        </div>

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

          <QuestionCard
            v-for="q in questions"
            :key="q.id"
            :question="q"
            :in-basket="basket.basketIds.value.has(q.id)"
            :basket-loading="basket.isLoading(q.id)"
            :is-favorite="!!q.isFavorite"
            :favorite-loading="favoriteLoading.has(q.id)"
            @draft="handleDraft"
            @favorite="handleFavorite"
            @basket-toggle="handleBasketToggle"
            @detail="handleDetail"
          />
        </div>

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

    <FavoriteFolderDrawer
      v-model="favDrawerVisible"
      :question-id="favDrawerQuestionId"
      @success="handleFavDrawerSuccess"
    />

    <SketchPad v-model:visible="sketchVisible" />
  </div>
</template>

<style scoped>
.question-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
}

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
  background: rgba(30, 138, 138, 0.06);
}

:deep(.el-tree-node.is-current > .el-tree-node__content) {
  background: rgba(30, 138, 138, 0.1);
  color: #1E8A8A;
  font-weight: 600;
}

:deep(.el-tree-node__expand-icon) {
  transition: transform 0.2s ease;
}

.content-main {
  padding: 12px 20px 16px 8px;
  overflow-y: auto;
  background: #f0f2f5;
}

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

.question-list {
  min-height: 200px;
}

.empty-state {
  margin: 40px 0;
}

.pagination-wrap {
  margin-top: 20px;
  display: flex;
  justify-content: center;
  padding-bottom: 16px;
}
</style>
