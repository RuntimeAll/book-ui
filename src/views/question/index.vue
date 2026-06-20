<script setup lang="ts">
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

// 题面展示字号（小/中/大）—— 全局共用同一状态，注入 --md-font-size 级联给列表卡 MarkdownMath
const { cssVars: fontVars } = useFontScale()

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
    // 树数据就绪后，默认选中第一个节点并触发筛选查询
    if (treeData.value.length > 0) {
      const firstNode = treeData.value[0]
      handleNodeClick(firstNode)
      // 等 DOM 渲染完成后设置树高亮（highlight-current 需要 setCurrentKey）
      await nextTick()
      treeRef.value?.setCurrentKey(firstNode.id)
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

const LABEL_STATUS_OPTIONS = [
  { label: '全部', value: '' },
  { label: '未标', value: 0 },
  { label: 'AI已标', value: 1 },
  { label: '已审核', value: 2 },
]

const filter = reactive({
  questionType: '' as number | '',
  difficulty: '' as number | '',
  keyWord: '',
  labelStatus: '' as number | '',
  examPaperId: '',
})

const searchLoading = ref(false)
const resetLoading = ref(false)

function onSearch() {
  pageParams.questionType = filter.questionType !== '' ? Number(filter.questionType) : undefined
  pageParams.difficult = filter.difficulty !== '' ? Number(filter.difficulty) : undefined
  pageParams.keyWord = filter.keyWord || undefined
  pageParams.labelStatus = filter.labelStatus !== '' ? Number(filter.labelStatus) : undefined
  pageParams.examPaperId = filter.examPaperId.trim() || undefined
  pageParams.pageIndex = 1
  fetchQuestions()
}

function onReset() {
  filter.questionType = ''
  filter.difficulty = ''
  filter.keyWord = ''
  filter.labelStatus = ''
  filter.examPaperId = ''
  pageParams.questionType = undefined
  pageParams.difficult = undefined
  pageParams.keyWord = undefined
  pageParams.labelStatus = undefined
  pageParams.examPaperId = undefined
  pageParams.subjectId = undefined
  pageParams.pageIndex = 1
  fetchQuestions()
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

// PRD-A-013 T5 M-10 — 列表请求竞态防护
// 快速切章节 / 改筛选时, 旧请求被自动 abort, 防止旧 response 覆盖新数据。
const { run: runAbortable } = useAbortableRequest<QuestionPageResult>()

// 空态文案动态切换（BUG-2 真修后，章节走 biz_question_knowledge JOIN 大多数节点有题；
// 仅极少叶子节点确实 0 题时显示这条）
const emptyDescription = computed(() => {
  if (pageParams.subjectId) return '该章节暂无题目'
  return '暂无题目，请尝试调整筛选条件'
})

async function fetchQuestions() {
  listLoading.value = true
  try {
    // PRD-A-013 T5 M-10 — 走 useAbortableRequest 包装, signal 透传到 axios。
    // 切章节 / 改筛选时上一个请求自动 abort, 返回 null 表示被取消（不更新 UI）。
    const result = await runAbortable((signal) => questionPage(pageParams, { signal }))
    if (result === null) {
      // 被新一次请求取消, 保持当前 UI（loading 由更新的请求结束时关闭）
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
    // J 卡段③：原 loadFavoriteStatus() N+1 删除，收藏态由 BE /page 响应里 q.isFavorite 直接带（段② BE 新加字段）
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
// J 卡段③：原 favoriteMap + loadFavoriteStatus N+1 删除。
// 收藏态由 BE /page 响应里 q.isFavorite 字段直接带（段② BE 加字段）。
// 收藏 / 取消时直接 patch q.isFavorite（reactive array 元素 property 改动 Vue 3 响应）。
// PRD-A-013 T2 — qid 雪花 string
function setQuestionFavorite(qid: string, fav: boolean) {
  const q = questions.value.find((it) => it.id === qid)
  if (q) q.isFavorite = fav
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

// ── 草稿纸 ──────────────────────────────────────────────────
const sketchVisible = ref(false)

// ── 空壳按钮 ─────────────────────────────────────────────────
function handleDraft(_q: QuestionItem) {
  sketchVisible.value = true
}

// PRD-A-013 T2 — Set 雪花 string
const favoriteLoading = reactive<Set<string>>(new Set())

// ── 收藏抽屉（子任务 D）──────────────────────────────────────
// 未收藏 → 打开 FavoriteFolderDrawer 选择收藏目录
// 已收藏 → 直接调 removeFavorite（不弹抽屉）
const favDrawerVisible = ref(false)
// PRD-A-013 T2 — 雪花 ID 空态 ''
const favDrawerQuestionId = ref<string>('')

function handleFavorite(q: QuestionItem) {
  if (favoriteLoading.has(q.id)) return
  if (q.isFavorite) {
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

  // 乐观更新：直接 patch q.isFavorite + toast，异步调 API
  setQuestionFavorite(q.id, false)
  ElMessage.success('已取消收藏')

  removeFavorite(q.id)
    .catch((e) => {
      console.warn('[favorite] removeFavorite API failed (local state already updated):', e)
    })
}

function handleFavDrawerSuccess(_folderId: string | undefined) {
  // 收藏抽屉内成功收藏 → patch q.isFavorite
  if (favDrawerQuestionId.value) {
    setQuestionFavorite(favDrawerQuestionId.value, true)
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
// loadTree() 内部在数据就绪后会自动选中第一个节点并触发 fetchQuestions，
// 此处不再单独并行调 fetchQuestions（避免首屏发出一次全量无筛选查询）。
// 空树兜底：loadTree 内部判断 treeData.length > 0 才选中，空树时不触发查询。
onMounted(async () => {
  await loadTree()
})
</script>

<template>
  <div class="question-page" :style="fontVars">
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

          <div class="filter-item">
            <span class="filter-label">打标态</span>
            <el-select
              v-model="filter.labelStatus"
              placeholder="全部"
              clearable
              style="width: 110px;"
            >
              <el-option
                v-for="opt in LABEL_STATUS_OPTIONS"
                :key="String(opt.value)"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
          </div>

          <div class="filter-item">
            <span class="filter-label">试卷ID</span>
            <el-input
              v-model="filter.examPaperId"
              placeholder="输入试卷ID"
              clearable
              style="width: 180px;"
              @keyup.enter="onSearch"
            />
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
          <FontSizeSwitch />
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

    <!-- 草稿纸 -->
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

/* 题卡样式已迁移至共享组件 components/business/QuestionCard（PRD-001 抽离） */

/* ── 分页 ── */
.pagination-wrap {
  margin-top: 20px;
  display: flex;
  justify-content: center;
  padding-bottom: 16px;
}
</style>
